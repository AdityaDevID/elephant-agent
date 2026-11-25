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

// Mengembalikan { toolCalls: [...], stopReason }.
async function chat({ provider, conf = {}, model, system, messages, tools, signal, onDelta }) {
  const base = baseOf(provider, conf);
  const key = keyOf(provider, conf);
  const anthropic = provider.kind === 'anthropic';
  const hasTools = Array.isArray(tools) && tools.length > 0;
  let url;
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
    if (hasTools) body.tools = tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.parameters } }));
  }
  const res = await doFetch(url, { method: 'POST', headers, body: JSON.stringify(body), signal });
  if (!res.ok) throw await httpError(res);

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
    return { toolCalls: finishCalls(slots), stopReason: null };
  }

  const slots = [];
  let stopReason = null;
  await readSSE(res, (data, event) => {
    if (data === '[DONE]') return;
    let j;
    try { j = JSON.parse(data); } catch { return; }
    if (anthropic) {
      if (event === 'error' || j.type === 'error') throw new Error((j.error && j.error.message) || 'Error dari server');
      if (j.type === 'content_block_start' && j.content_block && j.content_block.type === 'tool_use') {
        slots[j.index] = { id: j.content_block.id, name: j.content_block.name, args: '' };
      } else if (j.type === 'content_block_delta' && j.delta) {
        if (j.delta.type === 'text_delta') onDelta(j.delta.text);
        else if (j.delta.type === 'input_json_delta' && slots[j.index]) slots[j.index].args += j.delta.partial_json || '';
      } else if (j.type === 'message_delta' && j.delta && j.delta.stop_reason) {
        stopReason = j.delta.stop_reason;
      }
    } else {
      if (j.error) throw new Error(typeof j.error === 'string' ? j.error : j.error.message || 'Error dari server');
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
  return { toolCalls: calls, stopReason };
}

module.exports = { listModels, chat, normalize, toOpenAI, toAnthropic, baseOf, keyOf };
