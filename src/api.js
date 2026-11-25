'use strict';

const TIMEOUT_MS = 20000;
const NON_CHAT = /embed|whisper|tts|dall-e|moderation|rerank|speech|guard/i;

const baseOf = (provider, conf) => String(conf.baseUrl || provider.baseUrl || '').replace(/\/+$/, '');
const keyOf = (provider, conf) => conf.apiKey || (provider.envKey && process.env[provider.envKey]) || '';

async function httpError(res) {
  let msg = '';
  try {
    const t = await res.text();
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
  return err;
}

async function doFetch(url, opts) {
  try {
    return await fetch(url, opts);
  } catch (e) {
    if (e && (e.name === 'AbortError' || e.name === 'TimeoutError')) {
      if (opts.signal && opts.signal.aborted && e.name === 'AbortError') throw e;
      throw new Error(`Timeout setelah ${TIMEOUT_MS / 1000} detik`);
    }
    let host = url;
    try { host = new URL(url).host; } catch { /* biarkan */ }
    const cause = (e && e.cause && (e.cause.code || e.cause.message)) || (e && e.message) || 'unknown';
    throw new Error(`Tidak bisa terhubung ke ${host} (${cause})`);
  }
}

async function listModels(provider, conf = {}) {
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

async function chat({ provider, conf = {}, model, system, messages, signal, onDelta }) {
  const base = baseOf(provider, conf);
  const key = keyOf(provider, conf);
  const msgs = normalize(messages);
  let url;
  let headers;
  let body;
  if (provider.kind === 'anthropic') {
    url = `${base}/v1/messages`;
    headers = { 'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' };
    body = { model, max_tokens: 8192, stream: true, messages: msgs };
    if (system) body.system = system;
  } else {
    url = `${base}/chat/completions`;
    headers = { 'content-type': 'application/json' };
    if (key) headers.Authorization = `Bearer ${key}`;
    body = { model, stream: true, messages: [...(system ? [{ role: 'system', content: system }] : []), ...msgs] };
  }
  const res = await doFetch(url, { method: 'POST', headers, body: JSON.stringify(body), signal });
  if (!res.ok) throw await httpError(res);

  const ctype = res.headers.get('content-type') || '';
  if (ctype.includes('application/json')) {
    // Server mengabaikan stream: ambil jawaban utuh.
    const j = await res.json();
    const text =
      (j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content) ||
      (Array.isArray(j.content) && j.content.map((c) => c.text || '').join('')) || '';
    if (text) onDelta(text);
    return;
  }

  await readSSE(res, (data, event) => {
    if (data === '[DONE]') return;
    let j;
    try { j = JSON.parse(data); } catch { return; }
    if (provider.kind === 'anthropic') {
      if (event === 'error' || j.type === 'error') throw new Error((j.error && j.error.message) || 'Error dari server');
      if (j.type === 'content_block_delta' && j.delta && j.delta.type === 'text_delta') onDelta(j.delta.text);
    } else {
      if (j.error) throw new Error(typeof j.error === 'string' ? j.error : j.error.message || 'Error dari server');
      const d = j.choices && j.choices[0] && j.choices[0].delta;
      if (d && typeof d.content === 'string' && d.content) onDelta(d.content);
    }
  });
}

module.exports = { listModels, chat, normalize, baseOf, keyOf };
