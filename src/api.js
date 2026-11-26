'use strict';

const TIMEOUT_MS = 20000;
const NON_CHAT = /embed|whisper|tts|dall-e|moderation|rerank|speech|guard/i;

// Retry untuk error sementara (429, 5xx, jaringan putus). Bisa diubah (mis. oleh tes): api.retry.baseMs = 1.
const retry = { max: 4, baseMs: 1000, capMs: 30000, maxWaitMs: 60000 };
const RETRY_STATUS = new Set([408, 429, 500, 502, 503, 504, 520, 521, 522, 523, 524, 529]);
const RETRY_NET_CODES = new Set(['ECONNRESET', 'ETIMEDOUT', 'EAI_AGAIN', 'EPIPE', 'UND_ERR_SOCKET', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT']);
// Kuota/saldo habis: menunggu tidak akan membantu.
const NO_RETRY_BODY = /insufficient_quota|exceeded your current quota|billing|credit balance|out of credits|payment required|plan and billing/i;

// "1m30s", "250ms", "2.5s", "17" (detik) -> ms. null kalau tidak terbaca.
function parseDuration(v) {
  const t = String(v == null ? '' : v).trim().toLowerCase();
  if (!t) return null;
  if (/^\d+(\.\d+)?$/.test(t)) return Math.round(parseFloat(t) * 1000);
  const re = /(\d+(?:\.\d+)?)\s*(ms|h|m(?!s)|s)/g;
  let ms = 0;
  let found = false;
  let m;
  while ((m = re.exec(t))) {
    found = true;
    const n = parseFloat(m[1]);
    ms += m[2] === 'ms' ? n : m[2] === 's' ? n * 1000 : m[2] === 'm' ? n * 60000 : n * 3600000;
  }
  return found ? Math.round(ms) : null;
}

// Berapa lama server minta kita menunggu (ms), dari header lalu isi error. null kalau tidak ada petunjuk.
function parseRetryAfter(headers, bodyText) {
  const h = (n) => (headers && headers.get ? headers.get(n) : null);
  const ms = parseFloat(h('retry-after-ms'));
  if (Number.isFinite(ms) && ms >= 0) return Math.round(ms);
  const ra = h('retry-after');
  if (ra) {
    if (/^\s*\d+(\.\d+)?\s*$/.test(ra)) return Math.round(parseFloat(ra) * 1000);
    const when = Date.parse(ra);
    if (Number.isFinite(when)) return Math.max(0, when - Date.now());
  }
  const body = String(bodyText || '');
  let m = /"retryDelay"\s*:\s*"([^"]+)"/.exec(body) || /try again in\s+([0-9.]+\s*(?:ms|h|m(?!s)|s)(?:\s*[0-9.]+\s*(?:ms|h|m(?!s)|s))*)/i.exec(body);
  if (m) {
    const d = parseDuration(m[1].replace(/\s+/g, ''));
    if (d != null) return d;
  }
  const resets = ['x-ratelimit-reset-requests', 'x-ratelimit-reset-tokens']
    .map((n) => parseDuration(h(n)))
    .filter((v) => v != null && v >= 0);
  return resets.length ? Math.max(...resets) : null;
}

function fmtWait(ms) {
  const s = Math.ceil(ms / 1000);
  if (s < 90) return `${s} detik`;
  const m = Math.round(s / 60);
  return m < 90 ? `${m} menit` : `${Math.round(m / 60)} jam`;
}

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal && signal.aborted) return reject(abortError());
    const t = setTimeout(() => { if (signal) signal.removeEventListener('abort', onAbort); resolve(); }, ms);
    const onAbort = () => { clearTimeout(t); reject(abortError()); };
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
  });
}

function abortError() {
  const e = new Error('Dibatalkan');
  e.name = 'AbortError';
  return e;
}

// Jalankan fn; kalau gagal dengan error yang bisa diulang, tunggu (hormati retry-after) lalu coba lagi.
async function withRetry(fn, { signal, onRetry } = {}) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (e) {
      if (!e || !e.retryable || attempt >= retry.max || (signal && signal.aborted)) throw e;
      let wait;
      if (e.retryAfterMs != null) {
        wait = e.retryAfterMs + Math.floor(Math.random() * 400);
      } else {
        const exp = Math.min(retry.capMs, retry.baseMs * 2 ** attempt);
        wait = Math.round(exp * (0.75 + Math.random() * 0.5));
      }
      if (wait > retry.maxWaitMs) {
        e.message += ` (server minta menunggu ${fmtWait(wait)}, terlalu lama; coba lagi nanti atau ganti model/provider)`;
        throw e;
      }
      if (onRetry) onRetry({ attempt: attempt + 1, max: retry.max, waitMs: wait, status: e.status || null, message: e.message });
      await sleep(wait, signal);
    }
  }
}

// Rapikan Base URL: tambah http:// kalau lupa, 0.0.0.0 -> 127.0.0.1, dan untuk Ollama pastikan berakhiran /v1
// (orang sering menempel http://localhost:11434 atau .../api saja).
function normalizeBase(provider, raw) {
  let b = String(raw || '').trim().replace(/\/+$/, '');
  if (!b) return '';
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(b)) b = 'http://' + b;
  if (provider && provider.id === 'ollama') {
    try {
      const u = new URL(b);
      if (u.hostname === '0.0.0.0') u.hostname = '127.0.0.1';
      let p = u.pathname.replace(/\/+$/, '').replace(/\/api(\/.*)?$/, '');
      if (!/\/v1$/.test(p)) p += '/v1';
      u.pathname = p;
      u.search = '';
      u.hash = '';
      b = u.toString().replace(/\/+$/, '');
    } catch { /* biarkan apa adanya */ }
  }
  return b.replace(/\/+$/, '');
}

const baseOf = (provider, conf) => normalizeBase(provider, conf.baseUrl || provider.baseUrl);
const keyOf = (provider, conf) => conf.apiKey || (provider.envKey && process.env[provider.envKey]) || '';

async function httpError(res) {
  let msg = '';
  let raw = '';
  try {
    const t = await res.text();
    raw = t;
    try {
      const j = JSON.parse(t);
      msg = (j.error && (j.error.message || j.error)) || j.message || t;
      if (typeof msg !== 'string') msg = JSON.stringify(msg);
    } catch {
      msg = t;
    }
  } catch { /* abaikan */ }
  msg = String(msg).replace(/\s+/g, ' ').slice(0, 300);
  const hint =
    res.status === 401 || res.status === 403 ? ' (API key ditolak)'
    : res.status === 404 ? ' (endpoint/model tidak ditemukan)'
    : res.status === 429 ? ' (rate limit / kuota habis)'
    : '';
  const err = new Error(`HTTP ${res.status}${hint}${msg ? ': ' + msg : ''}`);
  err.status = res.status;
  err.retryAfterMs = parseRetryAfter(res.headers, raw);
  err.retryable = RETRY_STATUS.has(res.status) && !NO_RETRY_BODY.test(raw);
  err.bodyText = raw.slice(0, 2000);
  err.noTools = res.status === 400 && /does not support tools|doesn't support tools|tools? (is|are) not supported/i.test(raw);
  return err;
}

const CONNECT_CODES = new Set(['ECONNREFUSED', 'EADDRNOTAVAIL', 'ENOTFOUND', 'EAI_AGAIN', 'ENETUNREACH', 'EHOSTUNREACH']);

function causeCode(e) {
  const c = e && e.cause;
  if (!c) return '';
  if (c.code) return c.code;
  if (Array.isArray(c.errors) && c.errors[0] && c.errors[0].code) return c.errors[0].code;
  return '';
}

// "localhost" di Node 18+ sering di-resolve ke ::1 dulu, padahal Ollama (dan banyak server lokal) hanya
// mendengarkan di 127.0.0.1. Kalau koneksi ke localhost gagal, coba 127.0.0.1 lalu [::1].
function localhostAlternatives(url) {
  if (!/^[a-z][a-z0-9+.-]*:\/\/localhost(?=[:/?#]|$)/i.test(url)) return [];
  return ['127.0.0.1', '[::1]'].map((h) => url.replace(/^([a-z][a-z0-9+.-]*:\/\/)localhost(?=[:/?#]|$)/i, `$1${h}`));
}

async function doFetch(url, opts) {
  const urls = [url, ...localhostAlternatives(url)];
  let lastErr;
  for (let i = 0; i < urls.length; i++) {
    try {
      return await fetch(urls[i], opts);
    } catch (e) {
      if (e && (e.name === 'AbortError' || e.name === 'TimeoutError')) {
        if (opts.signal && opts.signal.aborted && e.name === 'AbortError') throw e;
        throw new Error(`Timeout setelah ${TIMEOUT_MS / 1000} detik`);
      }
      lastErr = e;
      if (i < urls.length - 1 && CONNECT_CODES.has(causeCode(e))) continue;
      break;
    }
  }
  const e = lastErr;
  let host = url;
  try { host = new URL(url).host; } catch { /* biarkan */ }
  const cause = causeCode(e) || (e && e.cause && e.cause.message) || (e && e.message) || 'unknown';
  const err = new Error(`Tidak bisa terhubung ke ${host} (${cause})`);
  err.retryable = RETRY_NET_CODES.has(e && e.cause && e.cause.code);
  err.connectFail = true;
  throw err;
}

// Pesan yang lebih membantu untuk masalah umum Ollama lokal.
function ollamaHint(provider, e) {
  if (!provider || provider.id !== 'ollama' || !e || e.ollamaHinted) return e;
  if (e.connectFail) {
    e.message += '. Ollama belum jalan? Jalankan "ollama serve" (atau buka app Ollama) dan cek Base URL (default http://127.0.0.1:11434)';
    e.ollamaHinted = true;
  } else if (e.status === 404 && /model.*not found|try pulling/i.test(e.message)) {
    e.message += '. Model belum diunduh: jalankan "ollama pull <nama-model>"';
    e.ollamaHinted = true;
  }
  return e;
}

// Daftar model native Ollama (/api/tags): cadangan kalau /v1/models tidak ada (Ollama lama) atau kosong.
async function ollamaTags(provider, conf) {
  const base = baseOf(provider, conf).replace(/\/v1$/, '');
  const res = await doFetch(`${base}/api/tags`, { signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!res.ok) throw await httpError(res);
  const j = await res.json();
  const seen = new Set();
  const list = [];
  for (const m of (j && j.models) || []) {
    const id = String((m && (m.name || m.model)) || '');
    if (!id || seen.has(id) || NON_CHAT.test(id)) continue;
    seen.add(id);
    list.push({ id, name: id });
  }
  return list.sort((a, b) => a.id.localeCompare(b.id));
}

async function listModels(provider, conf = {}) {
  let list = [];
  let firstErr = null;
  try {
    list = await listModelsV1(provider, conf);
  } catch (e) {
    firstErr = e;
  }
  if (provider.id === 'ollama' && (firstErr ? !firstErr.connectFail : !list.length)) {
    try { list = await ollamaTags(provider, conf); if (list.length) firstErr = null; } catch { /* pakai error asli */ }
    if (!list.length && !firstErr) {
      throw new Error('Ollama jalan, tapi belum ada model. Unduh dulu, mis.: ollama pull llama3.2 (lalu coba lagi)');
    }
  }
  if (firstErr) throw ollamaHint(provider, firstErr);
  return list;
}

async function listModelsV1(provider, conf = {}) {
  const base = baseOf(provider, conf);
  const key = keyOf(provider, conf);
  if (!base) throw new Error('Base URL kosong');
  let res;
  if (provider.kind === 'anthropic') {
    res = await doFetch(`${base}/v1/models?limit=1000`, {
      headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01' },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } else {
    res = await doFetch(`${base}/models`, {
      headers: key ? { Authorization: `Bearer ${key}` } : {},
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  }
  if (!res.ok) throw await httpError(res);
  const j = await res.json();
  const raw = Array.isArray(j) ? j : j.data || j.models || [];
  const seen = new Set();
  let list = [];
  for (const m of raw) {
    const id = String(typeof m === 'string' ? m : m.id || m.name || '').replace(/^models\//, '');
    if (!id || seen.has(id)) continue;
    seen.add(id);
    list.push({ id, name: (m && m.display_name) || id });
  }
  const chatOnly = list.filter((m) => !NON_CHAT.test(m.id));
  if (chatOnly.length) list = chatOnly;
  list.sort((a, b) => a.id.localeCompare(b.id));
  return list;
}

// Gabungkan pesan berurutan dengan role sama (beberapa API menolak user->user).
function normalize(messages) {
  const out = [];
  for (const m of messages) {
    if (!m.content) continue;
    const last = out[out.length - 1];
    if (last && last.role === m.role) last.content += '\n\n' + m.content;
    else out.push({ role: m.role, content: m.content });
  }
  return out;
}

async function readSSE(res, onEvent) {
  const dec = new TextDecoder();
  let buf = '';
  const flush = (final) => {
    for (;;) {
      const m = /\r?\n\r?\n/.exec(buf);
      let raw;
      if (m) {
        raw = buf.slice(0, m.index);
        buf = buf.slice(m.index + m[0].length);
      } else if (final && buf.trim()) {
        raw = buf;
        buf = '';
      } else break;
      let event = 'message';
      const data = [];
      for (const line of raw.split(/\r?\n/)) {
        if (line.startsWith('event:')) event = line.slice(6).trim();
        else if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''));
      }
      if (data.length) onEvent(data.join('\n'), event);
    }
  };
  for await (const chunk of res.body) {
    buf += dec.decode(chunk, { stream: true });
    flush(false);
  }
  buf += dec.decode();
  flush(true);
}

// ---- konversi pesan internal -> format API.
// Pesan internal: {role:'user'|'assistant', content, toolCalls?:[{id,name,args}]} dan {role:'tool', toolCallId, content, isError?}.

function toOpenAI(messages) {
  const out = [];
  for (const m of messages) {
    if (m.role === 'tool') {
      out.push({ role: 'tool', tool_call_id: m.toolCallId, content: m.content || '(tidak ada output)' });
      continue;
    }
    if (m.role === 'assistant' && m.toolCalls && m.toolCalls.length) {
      out.push({
        role: 'assistant',
        content: m.content || null,
        tool_calls: m.toolCalls.map((c) => ({ id: c.id, type: 'function', function: { name: c.name, arguments: JSON.stringify(c.args || {}) } })),
      });
      continue;
    }
    if (!m.content) continue;
    const last = out[out.length - 1];
    if (last && last.role === m.role && typeof last.content === 'string' && !last.tool_calls) last.content += '\n\n' + m.content;
    else out.push({ role: m.role, content: m.content });
  }
  return out;
}

function toAnthropic(messages) {
  const out = [];
  const push = (role, block) => {
    const last = out[out.length - 1];
    if (last && last.role === role) last.content.push(block);
    else out.push({ role, content: [block] });
  };
  for (const m of messages) {
    if (m.role === 'tool') {
      const b = { type: 'tool_result', tool_use_id: m.toolCallId, content: m.content || '(tidak ada output)' };
      if (m.isError) b.is_error = true;
      push('user', b);
    } else if (m.role === 'assistant') {
      if (m.content) push('assistant', { type: 'text', text: m.content });
      for (const c of m.toolCalls || []) push('assistant', { type: 'tool_use', id: c.id, name: c.name, input: c.args || {} });
    } else if (m.content) {
      push('user', { type: 'text', text: m.content });
    }
  }
  // Semua blok teks -> string (sama seperti sebelum ada tool).
  for (const m of out) {
    if (m.content.every((b) => b.type === 'text')) m.content = m.content.map((b) => b.text).join('\n\n');
  }
  return out;
}

function parseArgs(raw) {
  if (raw && typeof raw === 'object') return { args: raw };
  if (!raw || !String(raw).trim()) return { args: {} };
  try {
    const v = JSON.parse(raw);
    if (v && typeof v === 'object' && !Array.isArray(v)) return { args: v };
    return { args: {}, argError: 'argumen tool bukan objek JSON' };
  } catch {
    return { args: {}, argError: 'argumen tool berupa JSON yang rusak atau terpotong' };
  }
}

// Daftar slot tool-call hasil streaming -> [{id,name,args,argError?}]
function finishCalls(slots) {
  const out = [];
  slots.forEach((s, i) => {
    if (!s || !s.name) return;
    const { args, argError } = parseArgs(s.args);
    const c = { id: s.id || `call_${Date.now().toString(36)}_${i}`, name: s.name, args };
    if (argError) c.argError = argError;
    out.push(c);
  });
  return out;
}

// Tanda error di tengah stream yang layak diulang (hanya kalau belum ada teks yang tampil).
function streamErrorRetryable(err) {
  if (!err) return false;
  const t = String(err.type || err.code || '');
  if (/overloaded|rate_limit|server_error|api_error|timeout|unavailable/i.test(t)) return true;
  return RETRY_STATUS.has(Number(err.code || err.status));
}

function usageOf(u) {
  if (!u || typeof u !== 'object') return null;
  const input = (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.cache_read_input_tokens || 0) || u.prompt_tokens || 0;
  const output = u.output_tokens || u.completion_tokens || 0;
  return input || output ? { input, output } : null;
}

// Mengembalikan { toolCalls: [...], stopReason, usage: {input, output} | null }.
// onRetry({attempt, max, waitMs, status, message}) dipanggil sebelum menunggu untuk mencoba lagi.
async function chat({ provider, conf = {}, model, system, messages, tools, signal, onDelta, onRetry }) {
  const base = baseOf(provider, conf);
  const key = keyOf(provider, conf);
  const anthropic = provider.kind === 'anthropic';
  const hasTools = Array.isArray(tools) && tools.length > 0;
  let sendUsage = !anthropic && !!provider.streamUsage; // minta usage di akhir stream; dimatikan kalau server menolak
  let url;

  const build = () => {
    let headers;
    let body;
    if (anthropic) {
      url = `${base}/v1/messages`;
      headers = { 'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' };
      body = { model, max_tokens: 8192, stream: true, messages: toAnthropic(messages) };
      if (system) body.system = system;
      if (hasTools) body.tools = tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.parameters }));
    } else {
      url = `${base}/chat/completions`;
      headers = { 'content-type': 'application/json' };
      if (key) headers.Authorization = `Bearer ${key}`;
      body = { model, stream: true, messages: [...(system ? [{ role: 'system', content: system }] : []), ...toOpenAI(messages)] };
      if (sendUsage) body.stream_options = { include_usage: true };
      if (hasTools) body.tools = tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.parameters } }));
    }
    return { headers, body };
  };

  const attempt = async () => {
    const { headers, body } = build();
    let started = false; // sudah ada teks yang tampil: mengulang akan menggandakan teks, jadi jangan
    const emit = (d) => { started = true; onDelta(d); };
    try {
      const res = await doFetch(url, { method: 'POST', headers, body: JSON.stringify(body), signal });
      if (!res.ok) {
        const err = await httpError(res);
        if (res.status === 400 && sendUsage && /stream_options|include_usage/i.test(err.bodyText || '')) {
          sendUsage = false; // server tidak kenal stream_options: ulangi tanpa itu
          err.retryable = true;
          err.retryAfterMs = 0;
        }
        throw err;
      }
      return await readReply(res, anthropic, emit);
    } catch (e) {
      if (started && e) e.retryable = false;
      throw e;
    }
  };
  return withRetry(attempt, { signal, onRetry }).catch((e) => { throw ollamaHint(provider, e); });
}

async function readReply(res, anthropic, onDelta) {
  const ctype = res.headers.get('content-type') || '';
  if (ctype.includes('application/json')) {
    // Server mengabaikan stream: ambil jawaban utuh.
    const j = await res.json();
    let text = '';
    const slots = [];
    if (Array.isArray(j.content)) {
      for (const c of j.content) {
        if (c.type === 'text') text += c.text || '';
        else if (c.type === 'tool_use') slots.push({ id: c.id, name: c.name, args: c.input });
      }
    } else {
      const msg = j.choices && j.choices[0] && j.choices[0].message;
      text = (msg && msg.content) || '';
      for (const c of (msg && msg.tool_calls) || []) slots.push({ id: c.id, name: c.function && c.function.name, args: c.function && c.function.arguments });
    }
    if (text) onDelta(text);
    return { toolCalls: finishCalls(slots), stopReason: null, usage: usageOf(j.usage) };
  }

  const slots = [];
  let stopReason = null;
  let uIn = 0;
  let uOut = 0;
  await readSSE(res, (data, event) => {
    if (data === '[DONE]') return;
    let j;
    try { j = JSON.parse(data); } catch { return; }
    if (anthropic) {
      if (event === 'error' || j.type === 'error') {
        const e = new Error((j.error && j.error.message) || 'Error dari server');
        e.retryable = streamErrorRetryable(j.error);
        throw e;
      }
      if (j.type === 'message_start' && j.message) {
        const u = usageOf(j.message.usage);
        if (u) { uIn = u.input; uOut = u.output; }
      } else if (j.type === 'content_block_start' && j.content_block && j.content_block.type === 'tool_use') {
        slots[j.index] = { id: j.content_block.id, name: j.content_block.name, args: '' };
      } else if (j.type === 'content_block_delta' && j.delta) {
        if (j.delta.type === 'text_delta') onDelta(j.delta.text);
        else if (j.delta.type === 'input_json_delta' && slots[j.index]) slots[j.index].args += j.delta.partial_json || '';
      } else if (j.type === 'message_delta') {
        if (j.delta && j.delta.stop_reason) stopReason = j.delta.stop_reason;
        if (j.usage && j.usage.output_tokens) uOut = j.usage.output_tokens;
      }
    } else {
      if (j.error) {
        const e = new Error(typeof j.error === 'string' ? j.error : j.error.message || 'Error dari server');
        e.retryable = typeof j.error === 'object' && streamErrorRetryable(j.error);
        throw e;
      }
      const u = usageOf(j.usage || (j.x_groq && j.x_groq.usage));
      if (u) { uIn = u.input; uOut = u.output; }
      const ch = j.choices && j.choices[0];
      const d = ch && ch.delta;
      if (ch && ch.finish_reason) stopReason = ch.finish_reason;
      if (!d) return;
      if (typeof d.content === 'string' && d.content) onDelta(d.content);
      for (const tc of d.tool_calls || []) {
        // Sebagian provider (mis. Gemini) tidak mengirim index: id baru = slot baru.
        let idx = typeof tc.index === 'number' ? tc.index : tc.id ? slots.length : Math.max(0, slots.length - 1);
        if (!slots[idx]) slots[idx] = { id: tc.id || '', name: '', args: '' };
        const s = slots[idx];
        if (tc.id && !s.id) s.id = tc.id;
        if (tc.function) {
          if (tc.function.name && !s.name) s.name = tc.function.name;
          if (typeof tc.function.arguments === 'string') s.args += tc.function.arguments;
          else if (tc.function.arguments && typeof tc.function.arguments === 'object') s.args = tc.function.arguments;
        }
      }
    }
  });
  const calls = finishCalls(slots); // JSON terpotong (max_tokens) otomatis jadi argError
  return { toolCalls: calls, stopReason, usage: uIn || uOut ? { input: uIn, output: uOut } : null };
}

module.exports = { listModels, chat, normalize, normalizeBase, localhostAlternatives, toOpenAI, toAnthropic, baseOf, keyOf, retry, parseRetryAfter, parseDuration, withRetry, fmtWait };
