#!/usr/bin/env node
'use strict';

const major = parseInt(process.versions.node.split('.')[0], 10);
if (major < 18) {
  console.error(`Elephant Agent butuh Node.js 18 atau lebih baru (kamu pakai ${process.version}).`);
  process.exit(1);
}

const pkg = require('../package.json');
const args = process.argv.slice(2);

const HELP = `Elephant Agent v${pkg.version}: Agent AI di terminal

Pemakaian:
  elephant            jalankan aplikasi (TUI)
  elephant --ascii    pakai karakter ASCII (terminal jadul)
  elephant --reset    hapus config & API key tersimpan
  elephant --version  tampilkan versi

GitHub (Personal Access Token):
  elephant github login     simpan token (input tersembunyi, atau: echo $TOKEN | elephant github login)
  elephant github status    cek token & akunnya
  elephant github logout    hapus token

Daemon (jalan terus di background, mengerjakan perintah dari antrean):
  elephant daemon [opsi]    mulai daemon (foreground; tambah --detach untuk background)
      --mode auto|ask|readonly   izin tool tanpa manusia (default auto; ask = hanya baca + --allow)
      --allow tool1,tool2        tool yang boleh di mode ask (mis. run_command,gh_write_file)
      --allow-dangerous          izinkan aksi berbahaya (merge PR, DELETE, rm -rf, dll). Default: ditolak
      --cwd <folder>             folder kerja (default: folder sekarang)
      --max-steps <n>            batas langkah tool per tugas (default 40)
      --http [port]              buka kontrol HTTP di 127.0.0.1 (default port 7733, wajib token)
      --detach                   lepas dari terminal
  elephant send "perintah" [--every 10m] [--cwd folder]   kirim tugas (--every = berulang)
  elephant tasks            daftar antrean & tugas berulang
  elephant cancel <id>      batalkan / hentikan tugas
  elephant status           status daemon (--show-token untuk token HTTP)
  elephant logs [n] [-f]    log daemon
  elephant stop             hentikan daemon

Config disimpan di: ${require('../src/config').file()}
Env opsional: ELEPHANT_HOME, NO_COLOR, ELEPHANT_ASCII=1, ELEPHANT_GITHUB_TOKEN / GITHUB_TOKEN / GH_TOKEN, OLLAMA_HOST,
  ANTHROPIC_API_KEY, OPENAI_API_KEY, GEMINI_API_KEY, GROQ_API_KEY,
  NVIDIA_API_KEY, OPENROUTER_API_KEY, DEEPSEEK_API_KEY, MISTRAL_API_KEY, XAI_API_KEY`;

function flag(list, name) {
  const i = list.indexOf(name);
  return i >= 0 ? i : -1;
}

// Ambil nilai opsi (--x nilai atau --x=nilai) dan buang dari list.
function takeOpt(list, name, { optionalValue = false } = {}) {
  for (let i = 0; i < list.length; i++) {
    const a = list[i];
    if (a === name) {
      const next = list[i + 1];
      if (next !== undefined && !next.startsWith('--') && (!optionalValue || /^\d+$/.test(next))) { list.splice(i, 2); return next; }
      list.splice(i, 1);
      return optionalValue ? true : undefined;
    }
    if (a.startsWith(name + '=')) { list.splice(i, 1); return a.slice(name.length + 1); }
  }
  return undefined;
}

function takeFlag(list, name) {
  const i = flag(list, name);
  if (i < 0) return false;
  list.splice(i, 1);
  return true;
}

function readHidden(prompt) {
  return new Promise((resolve) => {
    process.stdout.write(prompt);
    const stdin = process.stdin;
    let buf = '';
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');
    const done = () => { stdin.removeListener('data', onData); stdin.setRawMode(false); stdin.pause(); process.stdout.write('\n'); resolve(buf.trim()); };
    const onData = (chunk) => {
      for (const c of chunk) {
        if (c === '\r' || c === '\n') return done();
        if (c === '\u0003') { process.stdout.write('\n'); process.exit(130); }
        if (c === '\u007f' || c === '\b') buf = buf.slice(0, -1);
        else if (c >= ' ') buf += c;
      }
      return undefined;
    };
    stdin.on('data', onData);
  });
}

function readStdinAll() {
  return new Promise((resolve) => {
    let s = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (c) => { s += c; });
    process.stdin.on('end', () => resolve(s.trim()));
    process.stdin.resume();
  });
}

async function githubCmd(rest) {
  const gh = require('../src/github');
  const sub = rest[0] || 'status';
  if (sub === 'logout') { gh.clearToken(); console.log('Token GitHub dihapus dari config.'); return; }
  if (sub === 'login') {
    let token = process.stdin.isTTY ? await readHidden('Tempel GitHub token (tidak ditampilkan): ') : await readStdinAll();
    token = token.replace(/\s+/g, '');
    if (!token) { console.error('Token kosong.'); process.exit(1); }
    gh.setToken(token);
  } else if (sub !== 'status') {
    console.error('Pakai: elephant github login | status | logout');
    process.exit(1);
  }
  if (!gh.hasToken()) { console.log('Belum ada token. Jalankan: elephant github login'); return; }
  try {
    const r = await gh.execute('gh_whoami', {}, {});
    if (r.isError) throw new Error(r.content.replace(/^Error: /, ''));
    console.log(r.content);
  } catch (e) {
    console.error('Token tersimpan, tapi tidak bisa diverifikasi: ' + e.message);
    process.exit(1);
  }
}

async function daemonCmd(rest) {
  const daemon = require('../src/daemon');
  const detach = takeFlag(rest, '--detach');
  const allowDangerous = takeFlag(rest, '--allow-dangerous');
  const mode = takeOpt(rest, '--mode');
  const allow = takeOpt(rest, '--allow');
  const cwd = takeOpt(rest, '--cwd');
  const maxSteps = takeOpt(rest, '--max-steps');
  const httpOpt = takeOpt(rest, '--http', { optionalValue: true });
  if (mode && !['auto', 'ask', 'readonly'].includes(mode)) { console.error('--mode harus auto, ask, atau readonly'); process.exit(1); }
  const http = httpOpt === undefined ? null : httpOpt === true ? 7733 : parseInt(httpOpt, 10);
  if (httpOpt !== undefined && !(http > 0 && http < 65536)) { console.error('--http butuh nomor port yang valid'); process.exit(1); }
  const err = daemon.readyError(require('../src/config').load());
  if (err) { console.error(err); process.exit(1); }
  if (detach) {
    const argv = process.argv.slice(3).filter((a) => a !== '--detach');
    try {
      const r = await daemon.startDetached(__filename, argv);
      console.log(`Daemon jalan di background (pid ${r.pid}).\nLog: ${r.log}\nKirim tugas: elephant send "perintah"  |  Status: elephant status  |  Stop: elephant stop`);
    } catch (e) { console.error(e.message); process.exit(1); }
    return;
  }
  try {
    await daemon.run({
      mode, allow: allow ? allow.split(',').map((s) => s.trim()).filter(Boolean) : [], allowDangerous,
      cwd, http, maxSteps: maxSteps ? parseInt(maxSteps, 10) : undefined,
    });
  } catch (e) { console.error(e.message); process.exit(1); }
}

async function main() {
  const cmd = args[0];
  const rest = args.slice(1);
  const daemon = () => require('../src/daemon');

  if (cmd === 'github') return githubCmd(rest);
  if (cmd === 'daemon') return daemonCmd(rest);
  if (cmd === 'send') {
    const every = takeOpt(rest, '--every');
    const cwd = takeOpt(rest, '--cwd');
    try {
      const r = daemon().send(rest.join(' '), { every, cwd });
      console.log(r.running ? 'Tugas dikirim ke daemon.' : 'Tugas masuk antrean, tapi daemon belum jalan. Jalankan: elephant daemon (atau --detach).');
    } catch (e) { console.error(e.message); process.exit(1); }
    return undefined;
  }
  if (cmd === 'cancel') {
    if (!rest[0]) { console.error('Pakai: elephant cancel <id>  (lihat id di: elephant tasks)'); process.exit(1); }
    const r = daemon().cancel(rest[0]);
    console.log(r.running ? `Permintaan batal untuk ${rest[0]} dikirim.` : 'Daemon tidak jalan; permintaan batal akan diproses saat daemon jalan.');
    return undefined;
  }
  if (cmd === 'stop') {
    const r = await daemon().stop();
    console.log(r.stopped ? `Daemon berhenti (pid ${r.pid}).` : `Daemon ${r.reason}.`);
    return undefined;
  }
  if (cmd === 'logs') {
    const follow = takeFlag(rest, '-f') || takeFlag(rest, '--follow');
    const n = parseInt(rest[0], 10) || 30;
    const d = daemon();
    d.tailLog(n).forEach((l) => console.log(l));
    if (follow) {
      const fs = require('fs');
      let pos = 0;
      try { pos = fs.statSync(d.paths().log).size; } catch { /* belum ada */ }
      setInterval(() => {
        try {
          const st = fs.statSync(d.paths().log);
          if (st.size < pos) pos = 0;
          if (st.size > pos) {
            const fd = fs.openSync(d.paths().log, 'r');
            const buf = Buffer.alloc(st.size - pos);
            fs.readSync(fd, buf, 0, buf.length, pos);
            fs.closeSync(fd);
            pos = st.size;
            process.stdout.write(buf.toString('utf8'));
          }
        } catch { /* lanjut */ }
      }, 1000);
      await new Promise(() => {});
    }
    return undefined;
  }
  if (cmd === 'tasks' || cmd === 'status') {
    const showToken = takeFlag(rest, '--show-token');
    const d = daemon();
    const st = d.readStatus();
    const s = st.state;
    if (cmd === 'status') {
      console.log(st.alive ? `Daemon: JALAN (pid ${st.pid})${s && s.startedAt ? ', sejak ' + new Date(s.startedAt).toLocaleString() : ''}` : 'Daemon: tidak jalan');
      if (s && st.alive) console.log(`Mode: ${s.mode}  |  folder: ${s.cwd}${s.http ? `  |  HTTP: 127.0.0.1:${s.http.port}` : ''}`);
      if (showToken) console.log('Token HTTP: ' + (d.getHttpToken(false) || '(belum dibuat; jalankan daemon dengan --http)'));
      if (s && s.running) console.log(`Sedang dikerjakan: ${s.running.id} "${s.running.text}"`);
      const gh = require('../src/github').status();
      console.log(`GitHub: ${gh.hasToken ? 'token ada (' + gh.kind + ')' : 'belum ada token (elephant github login)'}`);
    }
    if (!s) { if (cmd === 'tasks') console.log('(belum ada data; daemon belum pernah jalan)'); return undefined; }
    console.log(`Antrean: ${s.queue.length} tugas`);
    for (const t of s.queue) console.log(`  ${t.id}  ${t.every ? `[tiap ${d.fmtDur(t.every)}] ` : ''}${t.text.replace(/\s+/g, ' ').slice(0, 90)}${t.runs ? `  (sudah ${t.runs}x)` : ''}`);
    const hist = (s.history || []).slice(-(cmd === 'status' ? 5 : 15));
    if (hist.length) {
      console.log('Terakhir selesai:');
      for (const h of hist) console.log(`  ${h.ok ? 'OK   ' : 'GAGAL'} ${h.id}  ${new Date(h.at).toLocaleTimeString()}  ${h.summary.slice(0, 90)}`);
    }
    return undefined;
  }

  if (args.includes('-v') || args.includes('--version')) {
    console.log(pkg.version);
    process.exit(0);
  }
  if (args.includes('-h') || args.includes('--help') || cmd === 'help') {
    console.log(HELP);
    process.exit(0);
  }
  if (args.includes('--reset')) {
    require('../src/config').reset();
    console.log('Config dihapus: ' + require('../src/config').file());
    process.exit(0);
  }
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    console.error('Elephant Agent butuh terminal interaktif (TTY). Untuk mode tanpa terminal, pakai: elephant daemon');
    process.exit(1);
  }

  const { App } = require('../src/ui');
  new App().start();
  return undefined;
}

main().catch((e) => { console.error((e && e.message) || e); process.exit(1); });
