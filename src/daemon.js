'use strict';

// Mode daemon: Elephant Agent jalan terus di background, mengerjakan perintah dari antrean satu per satu.
// Kontrol lewat CLI (`elephant send/status/stop/tasks/cancel/logs`), folder inbox, atau HTTP lokal (opsional).
// Tugas berulang (--every) dikerjakan terus selama daemon hidup. Limit / koneksi putus ditunggu lalu disambung lagi.

const fs = require('fs');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const { spawn } = require('child_process');
const config = require('./config');
const api = require('./api');
const tools = require('./tools');
const gh = require('./github');
const runner = require('./runner');
const { getProvider } = require('./providers');

const POLL_MS = 1000;
const MIN_EVERY_MS = 10000;
const HISTORY_MAX = 50;
const RESULTS_MAX = 200;
const LOG_MAX_BYTES = 2 * 1024 * 1024;

function paths() {
  const dir = path.join(config.dir(), 'daemon');
  return {
    dir, pid: path.join(dir, 'daemon.pid'), state: path.join(dir, 'state.json'), log: path.join(dir, 'daemon.log'),
    inbox: path.join(dir, 'inbox'), results: path.join(dir, 'results'),
  };
}

function ensureDirs() {
  const P = paths();
  for (const d of [P.dir, P.inbox, P.results]) fs.mkdirSync(d, { recursive: true, mode: 0o700 });
  return P;
}

function writeAtomic(file, text) {
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, text, { mode: 0o600 });
  fs.renameSync(tmp, file);
}

function pidAlive(pid) {
  if (!pid || !Number.isFinite(pid)) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return e && e.code === 'EPERM'; }
}

function readPid() {
  try { return parseInt(fs.readFileSync(paths().pid, 'utf8'), 10) || 0; } catch { return 0; }
}

function loadState() {
  try {
    const s = JSON.parse(fs.readFileSync(paths().state, 'utf8'));
    return { nextId: s.nextId || 1, queue: Array.isArray(s.queue) ? s.queue : [], history: Array.isArray(s.history) ? s.history : [], running: null, pid: s.pid, startedAt: s.startedAt };
  } catch {
    return { nextId: 1, queue: [], history: [], running: null };
  }
}

// "10m", "30s", "2h", "1d"; angka saja = menit. null kalau tidak valid / terlalu pendek.
function parseEvery(v) {
  if (v == null || v === '') return null;
  const m = /^(\d+(?:\.\d+)?)\s*(s|m|h|d)?$/i.exec(String(v).trim());
  if (!m) return null;
  const n = parseFloat(m[1]);
  const ms = Math.round(n * { s: 1000, m: 60000, h: 3600000, d: 86400000 }[(m[2] || 'm').toLowerCase()]);
  return ms >= MIN_EVERY_MS ? ms : null;
}

function fmtDur(ms) {
  const s = Math.round(ms / 1000);
  if (s < 90) return `${s}d`;
  const m = Math.round(s / 60);
  if (m < 90) return `${m}m`;
  const h = Math.round(m / 60);
  return h < 48 ? `${h}j` : `${Math.round(h / 24)}h`;
}

const stamp = (d = new Date()) => d.toISOString().replace('T', ' ').slice(0, 19);

// ---------------------------------------------------------------- sisi pengirim (CLI)

function dropInbox(obj) {
  const P = ensureDirs();
  const name = `${Date.now()}-${crypto.randomBytes(3).toString('hex')}.json`;
  writeAtomic(path.join(P.inbox, name), JSON.stringify(obj));
}

function send(text, { every, cwd } = {}) {
  const t = String(text || '').trim();
  if (!t) throw new Error('Perintah kosong.');
  let ms = null;
  if (every != null && every !== '') {
    ms = parseEvery(every);
    if (!ms) throw new Error('Nilai --every tidak valid (contoh: 10m, 2h, 30s; minimal 10 detik).');
  }
  dropInbox({ cmd: 'task', text: t, every: ms, cwd: cwd ? path.resolve(cwd) : undefined });
  return { running: pidAlive(readPid()) };
}

function cancel(id) {
  dropInbox({ cmd: 'cancel', id: String(id) });
  return { running: pidAlive(readPid()) };
}

function readStatus() {
  const P = paths();
  const pid = readPid();
  const alive = pidAlive(pid);
  let s = null;
  try { s = JSON.parse(fs.readFileSync(P.state, 'utf8')); } catch { /* belum ada */ }
  return { alive, pid: alive ? pid : 0, state: s, files: P };
}

function tailLog(n = 30) {
  try {
    const lines = fs.readFileSync(paths().log, 'utf8').split('\n').filter(Boolean);
    return lines.slice(-n);
  } catch { return []; }
}

// Berhenti pelan-pelan: kirim perintah stop lewat inbox (jalan di semua OS), lalu SIGTERM kalau masih hidup.
async function stop() {
  const pid = readPid();
  if (!pidAlive(pid)) { try { fs.unlinkSync(paths().pid); } catch { /* sudah tidak ada */ } return { stopped: false, reason: 'tidak sedang jalan' }; }
  dropInbox({ cmd: 'stop' });
  for (let i = 0; i < 30; i++) {
    await new Promise((r) => setTimeout(r, 300));
    if (!pidAlive(pid)) return { stopped: true, pid };
  }
  try { process.kill(pid, 'SIGTERM'); } catch { /* sudah mati */ }
  for (let i = 0; i < 20; i++) {
    await new Promise((r) => setTimeout(r, 300));
    if (!pidAlive(pid)) return { stopped: true, pid };
  }
  return { stopped: false, reason: `proses ${pid} belum berhenti`, pid };
}

// Jalankan daemon di latar belakang (lepas dari terminal).
async function startDetached(script, args) {
  const P = ensureDirs();
  const old = readPid();
  if (pidAlive(old)) throw new Error(`Daemon sudah jalan (pid ${old}).`);
  const child = spawn(process.execPath, [script, 'daemon', ...args.filter((a) => a !== '--detach')], {
    detached: true, stdio: 'ignore', windowsHide: true, env: { ...process.env, ELEPHANT_DAEMON_QUIET: '1' },
  });
  child.unref();
  for (let i = 0; i < 20; i++) {
    await new Promise((r) => setTimeout(r, 250));
    const pid = readPid();
    if (pid && pidAlive(pid)) return { pid, log: P.log };
  }
  throw new Error(`Daemon tidak mau start. Cek log: ${P.log}`);
}

// ---------------------------------------------------------------- daemon

function readyError(cfg) {
  const a = cfg.active;
  const p = a && getProvider(a.provider);
  if (!p || !a.model) return 'Belum ada provider/model aktif. Jalankan "elephant" sekali (TUI) untuk memilih provider, API key, dan model.';
  const c = cfg.providers[p.id] || {};
  if (p.needsKey !== false && p.keyRequired !== false && !(c.apiKey || (p.envKey && process.env[p.envKey]))) return `API key untuk ${p.name} belum ada. Jalankan "elephant" lalu /key.`;
  return null;
}

let ACTIVE = null; // satu daemon per proses

class Daemon {
  constructor(opts = {}) {
    this.opts = {
      mode: tools.MODES.includes(opts.mode) ? opts.mode : 'auto',
      allow: new Set(opts.allow || []),
      allowDangerous: !!opts.allowDangerous,
      maxSteps: opts.maxSteps || runner.DEFAULT_MAX_STEPS,
      cwd: path.resolve(opts.cwd || process.cwd()),
      http: opts.http || null, // port atau null
      quiet: !!opts.quiet || process.env.ELEPHANT_DAEMON_QUIET === '1',
    };
    this.P = ensureDirs();
    this.state = loadState();
    this.stopping = false;
    this.current = null; // { task, ctrl }
    this.idle = null;
    this.server = null;
    this.logCount = 0;
  }

  log(msg) {
    const line = `[${stamp()}] ${gh.redact(String(msg))}`;
    try { fs.appendFileSync(this.P.log, line + '\n', { mode: 0o600 }); } catch { /* disk penuh dll: jangan matikan daemon */ }
    if (!this.opts.quiet) process.stdout.write(line + '\n');
    if (++this.logCount % 200 === 0) this.rotateLog();
  }

  rotateLog() {
    try {
      if (fs.statSync(this.P.log).size > LOG_MAX_BYTES) fs.renameSync(this.P.log, this.P.log + '.1');
    } catch { /* abaikan */ }
  }

  saveState() {
    const s = this.state;
    const snapshot = {
      pid: process.pid, startedAt: this.startedAt, mode: this.opts.mode, cwd: this.opts.cwd, nextId: s.nextId,
      queue: s.queue, history: s.history.slice(-HISTORY_MAX),
      running: this.current ? { id: this.current.task.id, text: this.current.task.text.slice(0, 200), startedAt: this.current.startedAt } : null,
      http: this.server ? { port: this.opts.http } : null,
    };
    try { writeAtomic(this.P.state, JSON.stringify(snapshot, null, 2)); } catch { /* abaikan */ }
  }

  enqueue({ text, every, cwd }) {
    const t = String(text || '').trim();
    if (!t) return null;
    const task = { id: 't' + this.state.nextId++, text: t, cwd: cwd || null, createdAt: Date.now(), every: every || null, nextAt: Date.now(), runs: 0, lastSummary: null };
    this.state.queue.push(task);
    this.log(`Tugas ${task.id} diterima${task.every ? ` (berulang tiap ${fmtDur(task.every)})` : ''}: ${t.replace(/\s+/g, ' ').slice(0, 120)}`);
    this.saveState();
    this.wake();
    return task;
  }

  cancelTask(id) {
    const i = this.state.queue.findIndex((t) => t.id === id);
    if (i < 0) return false;
    const [t] = this.state.queue.splice(i, 1);
    if (this.current && this.current.task.id === id) this.current.cancelled = true, this.current.ctrl.abort();
    this.log(`Tugas ${t.id} dibatalkan.`);
    this.saveState();
    return true;
  }

  pollInbox() {
    let names;
    try { names = fs.readdirSync(this.P.inbox).filter((n) => !n.endsWith('.tmp')).sort(); } catch { return; }
    for (const n of names) {
      const f = path.join(this.P.inbox, n);
      let raw;
      try { raw = fs.readFileSync(f, 'utf8'); fs.unlinkSync(f); } catch { continue; }
      let cmd;
      if (n.endsWith('.json')) { try { cmd = JSON.parse(raw); } catch { this.log(`Inbox ${n}: JSON rusak, diabaikan.`); continue; } }
      else if (n.endsWith('.txt') || n.endsWith('.md')) cmd = { cmd: 'task', text: raw };
      else continue;
      if (!cmd || typeof cmd !== 'object') continue;
      if (cmd.cmd === 'stop') { this.log('Perintah stop diterima.'); this.stop(); }
      else if (cmd.cmd === 'cancel') { if (!this.cancelTask(String(cmd.id))) this.log(`Cancel: tugas ${cmd.id} tidak ada.`); }
      else if (cmd.cmd === 'task') this.enqueue({ text: cmd.text, every: cmd.every && cmd.every >= MIN_EVERY_MS ? cmd.every : null, cwd: cmd.cwd });
    }
  }

  nextDue() {
    const now = Date.now();
    let best = null;
    for (const t of this.state.queue) if (t.nextAt <= now && (!best || t.nextAt < best.nextAt)) best = t;
    return best;
  }

  wake() { if (this.idle) this.idle.abort(); }

  async pause(ms) {
    this.idle = new AbortController();
    try { await runnerSleep(ms, this.idle.signal); } catch { /* dibangunkan */ }
    this.idle = null;
  }

  async runOne(task) {
    const ctrl = new AbortController();
    this.current = { task, ctrl, startedAt: Date.now(), cancelled: false };
    this.saveState();
    this.log(`Mulai ${task.id}${task.runs ? ` (run ke-${task.runs + 1})` : ''}`);
    const cfg = config.load();
    const bad = readyError(cfg);
    let outcome;
    if (bad) {
      outcome = { ok: false, text: bad };
    } else {
      try {
        const prev = task.lastSummary ? `\n\n[Catatan dari run sebelumnya: ${task.lastSummary}]` : '';
        const r = await runner.runTask({
          cfg, text: task.text + prev, cwd: task.cwd || this.opts.cwd, mode: this.opts.mode, allow: this.opts.allow,
          allowDangerous: this.opts.allowDangerous, maxSteps: this.opts.maxSteps, signal: ctrl.signal, log: (m) => this.log(`[${task.id}] ${m}`),
        });
        outcome = { ok: true, text: r.text, steps: r.steps, usage: r.usage };
      } catch (e) {
        if (e && e.name === 'AbortError') {
          const cancelled = this.current && this.current.cancelled;
          this.current = null;
          if (!cancelled) this.log(`${task.id} dihentikan; akan dilanjutkan dari awal saat daemon jalan lagi.`);
          this.saveState();
          return;
        }
        outcome = { ok: false, text: 'Gagal: ' + ((e && e.message) || String(e)) };
      }
    }
    this.current = null;
    task.runs++;
    task.lastSummary = outcome.text.replace(/\s+/g, ' ').slice(0, 500);
    const file = this.saveResult(task, outcome);
    this.state.history.push({ id: task.id, ok: outcome.ok, at: Date.now(), text: task.text.slice(0, 120), summary: task.lastSummary.slice(0, 200), file });
    this.log(`Selesai ${task.id} ${outcome.ok ? 'OK' : 'GAGAL'}: ${task.lastSummary.slice(0, 160)}`);
    if (task.every && this.state.queue.includes(task)) task.nextAt = Date.now() + task.every;
    else this.state.queue = this.state.queue.filter((t) => t !== task);
    this.saveState();
    this.rotateLog();
  }

  saveResult(task, outcome) {
    const name = `${task.id}-${stamp().replace(/[: ]/g, '-')}.md`;
    try {
      writeAtomic(path.join(this.P.results, name), `# ${task.id} ${outcome.ok ? 'OK' : 'GAGAL'}\n\nPerintah: ${task.text}\n\n${gh.redact(outcome.text)}\n`);
      const files = fs.readdirSync(this.P.results).filter((n) => n.endsWith('.md')).sort((a, b) => fs.statSync(path.join(this.P.results, a)).mtimeMs - fs.statSync(path.join(this.P.results, b)).mtimeMs);
      for (const old of files.slice(0, Math.max(0, files.length - RESULTS_MAX))) fs.unlinkSync(path.join(this.P.results, old));
    } catch { /* abaikan */ }
    return name;
  }

  // ---- HTTP kontrol (127.0.0.1 saja, wajib token)
  httpToken() { return getHttpToken(true); }

  startHttp(port) {
    const token = this.httpToken();
    const okHost = (h) => /^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/i.test(String(h || ''));
    const same = (a, b) => { const x = Buffer.from(String(a)); const y = Buffer.from(String(b)); return x.length === y.length && crypto.timingSafeEqual(x, y); };
    const reply = (res, code, obj) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };
    this.server = http.createServer((req, res) => {
      if (!okHost(req.headers.host)) return reply(res, 403, { error: 'host tidak diizinkan' });
      const auth = String(req.headers.authorization || '');
      if (!auth.startsWith('Bearer ') || !same(auth.slice(7), token)) return reply(res, 401, { error: 'token salah' });
      let body = '';
      req.on('data', (c) => { body += c; if (body.length > 200000) req.destroy(); });
      req.on('end', () => {
        const url = (req.url || '').split('?')[0];
        try {
          if (req.method === 'GET' && url === '/status') return reply(res, 200, { running: this.current ? this.current.task.id : null, queue: this.state.queue, history: this.state.history.slice(-10) });
          if (req.method === 'POST' && url === '/task') {
            const j = JSON.parse(body || '{}');
            const every = j.every != null && j.every !== '' ? parseEvery(j.every) : null;
            if (j.every != null && j.every !== '' && !every) return reply(res, 400, { error: 'every tidak valid (contoh 10m)' });
            const t = this.enqueue({ text: j.text, every, cwd: j.cwd ? path.resolve(String(j.cwd)) : null });
            return t ? reply(res, 200, { id: t.id }) : reply(res, 400, { error: 'text kosong' });
          }
          if (req.method === 'DELETE' && url.startsWith('/task/')) return reply(res, 200, { cancelled: this.cancelTask(decodeURIComponent(url.slice(6))) });
          if (req.method === 'POST' && url === '/stop') { reply(res, 200, { stopping: true }); setTimeout(() => this.stop(), 50); return undefined; }
          return reply(res, 404, { error: 'tidak ada' });
        } catch (e) {
          return reply(res, 400, { error: String((e && e.message) || e) });
        }
      });
    });
    this.server.on('error', (e) => { this.log(`HTTP kontrol gagal (${e.code || e.message}); daemon tetap jalan tanpa HTTP.`); this.server = null; });
    this.server.listen(port, '127.0.0.1', () => this.log(`HTTP kontrol aktif di http://127.0.0.1:${port} (butuh header Authorization: Bearer <token>; lihat "elephant status --show-token")`));
  }

  // ---- siklus hidup
  stop() {
    if (this.stopping) return;
    this.stopping = true;
    if (this.current) this.current.ctrl.abort();
    tools.killAll();
    this.wake();
  }

  async start() {
    const cfg = config.load();
    const bad = readyError(cfg);
    if (bad) throw new Error(bad);
    const old = readPid();
    if (ACTIVE) throw new Error(`Daemon sudah jalan (pid ${process.pid}).`);
    if (old && old !== process.pid && pidAlive(old)) throw new Error(`Daemon sudah jalan (pid ${old}). Pakai "elephant status" atau "elephant stop".`);
    ACTIVE = this;
    fs.writeFileSync(this.P.pid, String(process.pid), { mode: 0o600 });
    this.startedAt = Date.now();
    // Atur ulang retry level API: tunggu lebih sabar (sisanya ditangani runner tanpa batas).
    api.retry.max = 6;
    api.retry.maxWaitMs = 10 * 60 * 1000;
    api.retry.capMs = 60000;

    const p = getProvider(cfg.active.provider);
    this.log(`Daemon mulai (pid ${process.pid}) | ${p.name} ${cfg.active.model} | mode ${this.opts.mode}${this.opts.allowDangerous ? ' +allow-dangerous' : ''} | folder ${this.opts.cwd} | GitHub: ${gh.hasToken() ? 'token ada' : 'tanpa token'}`);
    const interrupted = this.state.queue.length;
    if (interrupted) this.log(`${interrupted} tugas dari sesi sebelumnya dimuat ulang.`);
    for (const t of this.state.queue) if (t.nextAt == null) t.nextAt = Date.now();
    this.saveState();
    if (this.opts.http) this.startHttp(this.opts.http);

    while (!this.stopping) {
      this.pollInbox();
      if (this.stopping) break;
      const task = this.nextDue();
      if (task) { try { await this.runOne(task); } catch (e) { this.log(`Error tak terduga: ${(e && e.stack) || e}`); await this.pause(5000); } continue; }
      await this.pause(POLL_MS);
    }
    this.saveState();
    if (this.server) this.server.close();
    try { if (readPid() === process.pid) fs.unlinkSync(this.P.pid); } catch { /* sudah hilang */ }
    this.log('Daemon berhenti.');
    ACTIVE = null;
  }
}

// Token kontrol HTTP: file terpisah di folder daemon.
function getHttpToken(create) {
  const f = path.join(paths().dir, 'http-token');
  try { const t = fs.readFileSync(f, 'utf8').trim(); if (t) return t; } catch { /* belum ada */ }
  if (!create) return '';
  const t = crypto.randomBytes(24).toString('hex');
  ensureDirs();
  writeAtomic(f, t);
  return t;
}

function runnerSleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(new Error('wake'));
    const t = setTimeout(() => { signal.removeEventListener('abort', onAbort); resolve(); }, ms);
    const onAbort = () => { clearTimeout(t); reject(new Error('wake')); };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

// Entry point foreground (dipanggil bin/elephant.js).
async function run(opts) {
  const d = new Daemon(opts);
  const onSig = () => { d.log('Sinyal berhenti diterima.'); d.stop(); };
  process.on('SIGINT', onSig);
  process.on('SIGTERM', onSig);
  process.on('unhandledRejection', (e) => d.log(`unhandledRejection: ${(e && e.stack) || e}`));
  process.on('uncaughtException', (e) => d.log(`uncaughtException: ${(e && e.stack) || e}`));
  await d.start();
}

module.exports = { Daemon, run, getHttpToken, dropInbox, send, cancel, stop, startDetached, readStatus, tailLog, parseEvery, fmtDur, paths, pidAlive, readyError };
