'use strict';

// Loop agent tanpa UI (dipakai daemon): kirim ke model, jalankan tool, ulangi sampai selesai.
// - Tidak ada manusia yang bisa ditanya: izin ditentukan kebijakan (mode + daftar --allow).
// - Kena limit / jaringan putus: menunggu lalu menyambung lagi otomatis (tanpa batas) sampai berhasil atau dibatalkan.

const api = require('./api');
const tools = require('./tools');
const context = require('./context');
const gh = require('./github');
const { getProvider } = require('./providers');

const DEFAULT_MAX_STEPS = 40;
// Jeda saat limit/koneksi bermasalah (bisa diubah, mis. oleh tes).
const timing = { baseMs: 15000, capMs: 10 * 60 * 1000, hardCapMs: 60 * 60 * 1000 };

function abortError() {
  const e = new Error('Dibatalkan');
  e.name = 'AbortError';
  return e;
}

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal && signal.aborted) return reject(abortError());
    const t = setTimeout(() => { if (signal) signal.removeEventListener('abort', onAbort); resolve(); }, ms);
    const onAbort = () => { clearTimeout(t); reject(abortError()); };
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
  });
}

// 'wait' = sementara (limit, kuota, jaringan putus, server sibuk): tunggu lalu ulangi. 'fatal' = ulang tidak akan membantu.
function classify(e) {
  if (!e) return 'fatal';
  if (e.name === 'AbortError') return 'abort';
  if (e.connectFail || /^Timeout setelah/.test(e.message || '')) return 'wait';
  const s = e.status;
  if (s === 429 || s === 408 || s === 402 || (s >= 500 && s < 600)) return 'wait';
  if (e.retryable) return 'wait';
  if (s === 403 && /quota|credit|billing|rate|limit/i.test(e.message || '')) return 'wait';
  return 'fatal';
}

// Kebijakan izin tanpa manusia. Mengembalikan null kalau boleh, atau teks penolakan untuk model.
function policy(def, args, opts) {
  const risk = tools.riskOf(def, args);
  if (opts.mode === 'readonly' && risk !== 'read') return 'Ditolak: mode readonly, hanya boleh membaca. Laporkan perubahan yang diperlukan kepada pengguna.';
  if (tools.isDangerousCall(def.name, args) && !opts.allowDangerous) {
    return 'Ditolak: aksi ini berdampak besar/berbahaya dan butuh persetujuan manusia, sedangkan daemon berjalan tanpa pengawasan (hanya jalan kalau daemon dimulai dengan --allow-dangerous). Jangan coba cara lain; laporkan ke pengguna apa yang ingin kamu lakukan.';
  }
  if (opts.mode === 'auto' || risk === 'read') return null;
  if (opts.allow && (opts.allow.has('*') || opts.allow.has(def.name))) return null;
  return `Ditolak: daemon dalam mode "ask" tidak bisa menanyakan izin untuk ${def.name}. Laporkan ke pengguna; mereka bisa memakai --mode auto atau --allow ${def.name}.`;
}

function buildSystem(cfg, cwd, mode) {
  return (cfg.system || '') + '\n\n' + tools.agentPrompt(cwd, mode, { daemon: true });
}

// Jalankan satu tugas sampai selesai. Mengembalikan { text, steps, usage, truncated }.
// opts: cfg, text, cwd, mode ('auto'|'ask'|'readonly'), allow:Set, allowDangerous, maxSteps, signal, log(fn)
async function runTask(opts) {
  const { cfg, cwd, signal } = opts;
  const log = opts.log || (() => {});
  const mode = tools.MODES.includes(opts.mode) ? opts.mode : 'auto';
  const a = cfg.active;
  const p = a && getProvider(a.provider);
  if (!p) throw new Error('Belum ada provider/model aktif. Jalankan "elephant" sekali untuk memilih provider dan model.');
  const conf = cfg.providers[p.id] || {};
  const maxSteps = opts.maxSteps || DEFAULT_MAX_STEPS;
  const messages = [{ role: 'user', content: opts.text }];
  const usage = { input: 0, output: 0, requests: 0 };
  let useTools = cfg.tools !== false;
  let ctxRecovered = false;
  let waitTries = 0;
  let lastText = '';

  for (let step = 0; step < maxSteps; step++) {
    if (signal && signal.aborted) throw abortError();
    const system = useTools ? buildSystem(cfg, cwd, mode) : (cfg.system || '');
    const defs = useTools ? tools.defsFor(mode) : undefined;

    // jaga konteks: pangkas hasil tool lama, buang yang tertua kalau masih kepenuhan
    const win = context.windowFor(a.model, cfg.window, p.id);
    let live = context.liveMessages(messages);
    context.pruneToolResults(live);
    if (context.estimateRequest({ system, messages: live, tools: defs }) > win * 0.85) {
      context.pruneToolResults(live, { keepRecent: 2, keepChars: 150 });
      if (context.estimateRequest({ system, messages: live, tools: defs }) > win * 0.9) {
        context.dropOld(messages, { window: win });
        live = context.liveMessages(messages);
      }
    }

    let reply = '';
    let res;
    for (;;) {
      reply = '';
      try {
        res = await api.chat({
          provider: p, conf, model: a.model, system, messages: context.liveMessages(messages), tools: defs, signal,
          onDelta: (d) => { reply += d; },
          onRetry: (i) => log(`API ${p.name}: ${i.message.slice(0, 100)} - mencoba lagi dalam ${api.fmtWait(i.waitMs)} (${i.attempt}/${i.max})`),
        });
        waitTries = 0;
        break;
      } catch (e) {
        const kind = classify(e);
        if (kind === 'abort') throw e;
        if (e.noTools && useTools) {
          log(`Model ${a.model} tidak mendukung tool: lanjut sebagai chat biasa.`);
          return runTaskNoTools(opts, messages, usage);
        }
        const tooBig = (e.status === 400 || e.status === 413) && /context|too many tokens|token limit|maximum.*length|too large|prompt is too long|reduce the length/i.test(e.message || '');
        if (tooBig && !ctxRecovered) {
          ctxRecovered = true;
          log('Konteks kepenuhan: memangkas riwayat lalu mengulang.');
          context.pruneToolResults(context.liveMessages(messages), { keepRecent: 1, keepChars: 100 });
          context.dropOld(messages, { window: win, keepRatio: 0.1 });
          continue;
        }
        if (kind !== 'wait') throw e;
        waitTries++;
        const backoff = Math.min(timing.capMs, timing.baseMs * 2 ** Math.min(waitTries - 1, 6));
        const wait = Math.min(timing.hardCapMs, Math.max(backoff, e.retryAfterMs || 0));
        log(`Limit/koneksi bermasalah (${String(e.message).slice(0, 140)}). Menunggu ${api.fmtWait(wait)} lalu menyambung lagi otomatis.`);
        await sleep(wait, signal);
        log('Menyambung lagi ke provider…');
      }
    }

    usage.requests++;
    if (res.usage) { usage.input += res.usage.input || 0; usage.output += res.usage.output || 0; }
    if (reply) lastText = reply;
    const calls = useTools ? res.toolCalls || [] : [];
    if (!calls.length) return { text: reply || lastText || '(model tidak memberi jawaban)', steps: step + 1, usage, truncated: false };

    messages.push({ role: 'assistant', content: reply, toolCalls: calls });
    for (const c of calls) {
      const tm = { role: 'tool', toolCallId: c.id, name: c.name, content: '', isError: false };
      messages.push(tm);
      const def = tools.getDef(c.name);
      if (!def) { tm.content = `Error: tool tidak dikenal: ${c.name}`; tm.isError = true; continue; }
      if (c.argError) { tm.content = `Error: ${c.argError}. Kirim ulang tool call dengan argumen JSON yang valid.`; tm.isError = true; continue; }
      const denied = policy(def, c.args || {}, { mode, allow: opts.allow, allowDangerous: opts.allowDangerous });
      log(`${denied ? 'DITOLAK ' : ''}${c.name} ${gh.redact(tools.describe(c.name, c.args)).replace(/\s+/g, ' ').slice(0, 160)}`);
      if (denied) { tm.content = denied; tm.isError = true; continue; }
      let r;
      try {
        r = await tools.execute(c.name, c.args || {}, {
          cwd, signal, allowHosts: new Set(), persistent: true, maxWaitMs: timing.hardCapMs,
          onWait: (w) => log(`GitHub: ${w.reason}, menunggu ${gh.fmtWait(w.waitMs)} lalu lanjut otomatis.`),
        });
      } catch (e) {
        if (e && e.name === 'AbortError') throw e;
        r = { content: 'Error: ' + ((e && e.message) || e), isError: true };
      }
      tm.content = r.content;
      tm.isError = !!r.isError;
      if (r.isError) log(`  -> error: ${gh.redact(String(r.content)).replace(/\s+/g, ' ').slice(0, 160)}`);
    }
  }
  return { text: (lastText ? lastText + '\n\n' : '') + `[Batas ${maxSteps} langkah tercapai; tugas mungkin belum selesai.]`, steps: maxSteps, usage, truncated: true };
}

// Model tidak mendukung tool: satu jawaban teks saja.
async function runTaskNoTools(opts, messages, usage) {
  const cfg = opts.cfg;
  const a = cfg.active;
  const p = getProvider(a.provider);
  let reply = '';
  const res = await api.chat({
    provider: p, conf: cfg.providers[p.id] || {}, model: a.model, system: cfg.system || '',
    messages: context.liveMessages(messages), signal: opts.signal, onDelta: (d) => { reply += d; },
  });
  usage.requests++;
  if (res.usage) { usage.input += res.usage.input || 0; usage.output += res.usage.output || 0; }
  return { text: (reply || '(model tidak memberi jawaban)') + '\n\n[Catatan: model ini tidak mendukung tool, jadi hanya menjawab teks.]', steps: 1, usage, truncated: false };
}

module.exports = { runTask, classify, policy, timing, DEFAULT_MAX_STEPS };
