'use strict';

// Tes manajemen konteks (estimasi, pangkas, ringkas), retry/backoff, pembacaan usage, dan integrasi di loop agent.
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'elephant-ctx-'));
process.env.ELEPHANT_HOME = path.join(tmp, 'home');

const ctx = require('../src/context');
const api = require('../src/api');
const { App } = require('../src/ui');

api.retry.baseMs = 5;
api.retry.capMs = 20;
api.retry.maxWaitMs = 2000;

// ---------------------------------------------------------------- bahan

// Percakapan: tiap putaran = user, assistant(+tool call), tool (besar), assistant.
function convo(n, toolSize = 3000) {
  const out = [];
  for (let i = 0; i < n; i++) {
    out.push({ role: 'user', content: `pertanyaan ${i}` });
    out.push({ role: 'assistant', content: `cek ${i}`, toolCalls: [{ id: `t${i}`, name: 'read_file', args: { path: `f${i}.txt` } }] });
    out.push({ role: 'tool', toolCallId: `t${i}`, name: 'read_file', content: `isi-${i}-` + 'x'.repeat(toolSize), status: 'ok' });
    out.push({ role: 'assistant', content: `jawaban ${i}` });
  }
  return out;
}

// Riwayat valid untuk API: tiap hasil tool ada pemanggilnya tepat sebelum (di antara tool lain), dan tidak dimulai dengan tool.
function assertValid(msgs, rawTail = false) {
  assert.ok(msgs.length && msgs[0].role !== 'tool', 'riwayat dimulai dengan hasil tool yatim');
  let calls = new Set();
  for (const m of msgs) {
    if (m.role === 'assistant') calls = new Set((m.toolCalls || []).map((c) => c.id));
    else if (m.role === 'tool') assert.ok(calls.has(m.toolCallId), 'hasil tool yatim: ' + m.toolCallId);
    else calls = new Set();
  }
  if (rawTail) return; // ekor mentah: ringkasan (user) akan disisipkan di depannya
  const an = api.toAnthropic(msgs);
  assert.strictEqual(an[0].role, 'user');
  for (let i = 1; i < an.length; i++) assert.notStrictEqual(an[i].role, an[i - 1].role, 'role Anthropic harus selang-seling');
  const oa = api.toOpenAI(msgs);
  assert.notStrictEqual(oa[0].role, 'tool');
}

// ---------------------------------------------------------------- unit: konteks

function testEstimate() {
  assert.strictEqual(ctx.windowFor('claude-sonnet-5-5'), 200000);
  assert.strictEqual(ctx.windowFor('gemini-2.5-flash'), 1000000);
  assert.strictEqual(ctx.windowFor('llama-3.3-70b-versatile'), 128000);
  assert.strictEqual(ctx.windowFor('model-asing'), ctx.DEFAULT_WINDOW);
  assert.strictEqual(ctx.windowFor('claude-x', 50000), 50000, 'override manual menang');
  assert.strictEqual(ctx.windowFor('claude-x', 10), 200000, 'override terlalu kecil diabaikan');
  assert.strictEqual(ctx.estimateText('x'.repeat(350)), 100);
  assert.ok(ctx.estimateMessage({ role: 'assistant', content: '', toolCalls: [{ id: 'a', name: 'run_command', args: { command: 'ls -la' } }] }) > 8);
  assert.strictEqual(ctx.fmt(950), '950');
  assert.strictEqual(ctx.fmt(1500), '1.5k');
  assert.strictEqual(ctx.fmt(12000), '12k');
  assert.strictEqual(ctx.fmt(128000), '128k');
  assert.strictEqual(ctx.fmt(1000000), '1M');
  // pesan UI-only dan arsip tidak dihitung sebagai live
  const live = ctx.liveMessages([{ role: 'system', content: 'x' }, { role: 'error', content: 'x' }, { role: 'user', content: 'a' }, { role: 'user', content: 'b', archived: true }, { role: 'assistant', content: '' }, { role: 'assistant', content: 'c' }]);
  assert.deepStrictEqual(live.map((m) => m.content), ['a', 'c']);
}

function testPrune() {
  const msgs = convo(6);
  const r = ctx.pruneToolResults(msgs);
  assert.ok(r.count >= 4 && r.saved > 500, JSON.stringify(r));
  assert.ok(msgs[2].pruned && msgs[2].content.length < 700 && /dipotong/.test(msgs[2].content));
  assert.ok(msgs[2].content.startsWith('isi-0-'));
  assert.ok(!msgs[msgs.length - 2].pruned, 'hasil terbaru tidak dipotong');
  assert.strictEqual(ctx.pruneToolResults(msgs).count, 0, 'idempoten');
  // hasil pendek tidak disentuh
  const short = convo(6, 50);
  assert.strictEqual(ctx.pruneToolResults(short).count, 0);
}

function testCut() {
  const msgs = convo(10);
  for (const keep of [100, 800, 2000, 5000]) {
    const cut = ctx.pickCut(msgs, keep);
    if (cut === -1) continue;
    assert.ok(cut >= 2 && cut < msgs.length);
    assert.notStrictEqual(msgs[cut].role, 'tool', 'ekor tidak boleh dimulai dengan hasil tool');
    assertValid(msgs.slice(cut), true);
  }
  assert.strictEqual(ctx.pickCut(convo(1).slice(0, 2), 10), -1, 'terlalu sedikit');
  // cut jatuh di tengah rombongan tool call paralel: harus mundur ke assistant pemanggilnya
  const par = [
    { role: 'user', content: 'a' }, { role: 'assistant', content: 'b' }, { role: 'user', content: 'c' },
    { role: 'assistant', content: '', toolCalls: [{ id: 'p1', name: 'x', args: {} }, { id: 'p2', name: 'x', args: {} }] },
    { role: 'tool', toolCallId: 'p1', name: 'x', content: 'y'.repeat(70) },
    { role: 'tool', toolCallId: 'p2', name: 'x', content: 'y'.repeat(70) },
  ];
  const c = ctx.pickCut(par, 25);
  assert.ok(c === -1 || par[c].role !== 'tool');
  if (c !== -1) assertValid(par.slice(c), true);
}

async function testCompactMessages() {
  const ui = [{ role: 'system', content: 'catatan UI' }];
  const all = [...ui, ...convo(8)];
  let seen = '';
  const r = await ctx.compactMessages(all, { window: 8000, keepRatio: 0.25, summarize: async (t, f) => { seen = t + '|' + f; return 'RINGKASAN: user tanya hal-hal, file f0..f3 dibaca.'; }, focus: 'file' });
  assert.ok(r.ok && r.covered >= 8 && r.kept >= 1);
  assert.ok(/USER: pertanyaan 0/.test(seen) && /called read_file/.test(seen) && /TOOL RESULT \(read_file\)/.test(seen) && seen.endsWith('|file'));
  const live = ctx.liveMessages(all);
  assert.ok(live[0].summary && /RINGKASAN/.test(live[0].content) && live[0].role === 'user');
  assertValid(live);
  assert.ok(all.includes(ui[0]), 'catatan UI tetap ada');
  assert.ok(all.filter((m) => m.archived).length === r.covered, 'pesan lama diarsipkan, bukan dihapus');
  assert.ok(!live.some((m) => m.archived));

  // ringkasan kedua menumpuk (ringkasan lama ikut diringkas) dan jumlah "covered" kumulatif
  all.push(...convo(6));
  const r2 = await ctx.compactMessages(all, { window: 8000, keepRatio: 0.25, summarize: async (t) => { assert.ok(/PREVIOUS SUMMARY/.test(t)); return 'RINGKASAN-2'; } });
  assert.ok(r2.ok && r2.covered > r.covered);
  const live2 = ctx.liveMessages(all);
  assert.strictEqual(live2.filter((m) => m.summary).length, 1, 'hanya satu ringkasan aktif');
  assertValid(live2);

  // satu permintaan panjang: user lama ikut diringkas -> permintaan aslinya ditempel utuh
  const single = [{ role: 'user', content: 'TUGAS-UTAMA: refactor modul auth' }];
  for (let i = 0; i < 10; i++) single.push(...convo(1).slice(1).map((m) => ({ ...m, toolCalls: m.toolCalls && [{ ...m.toolCalls[0], id: `s${i}` }], toolCallId: m.toolCallId && `s${i}` })));
  const r3 = await ctx.compactMessages(single, { window: 4000, keepRatio: 0.25, summarize: async () => 'ringkas' });
  assert.ok(r3.ok);
  const l3 = ctx.liveMessages(single);
  assert.ok(/TUGAS-UTAMA: refactor modul auth/.test(l3[0].content), 'permintaan terakhir user harus ikut');
  assertValid(l3);

  // peringkas gagal -> pesan tidak berubah; teks kosong -> error
  const keep = JSON.stringify(convo(8));
  const a2 = convo(8);
  await assert.rejects(() => ctx.compactMessages(a2, { window: 8000, summarize: async () => { throw new Error('boom'); } }), /boom/);
  await assert.rejects(() => ctx.compactMessages(a2, { window: 8000, summarize: async () => '  ' }), /kosong/);
  assert.strictEqual(JSON.stringify(a2), keep);

  // cadangan: dropOld
  const a3 = convo(8);
  const d = ctx.dropOld(a3, { window: 8000 });
  assert.ok(d.ok);
  const l = ctx.liveMessages(a3);
  assert.ok(/dropped/.test(l[0].content));
  assertValid(l);
}

// ---------------------------------------------------------------- unit: retry

function testParse() {
  assert.strictEqual(api.parseDuration('1m30s'), 90000);
  assert.strictEqual(api.parseDuration('250ms'), 250);
  assert.strictEqual(api.parseDuration('2.5s'), 2500);
  assert.strictEqual(api.parseDuration('7m12.5s'), 432500);
  assert.strictEqual(api.parseDuration('1h'), 3600000);
  assert.strictEqual(api.parseDuration('17'), 17000);
  assert.strictEqual(api.parseDuration('abc'), null);
  const H = (o) => ({ get: (k) => (o[k.toLowerCase()] == null ? null : String(o[k.toLowerCase()])) });
  assert.strictEqual(api.parseRetryAfter(H({ 'retry-after': '7' }), ''), 7000);
  assert.strictEqual(api.parseRetryAfter(H({ 'retry-after-ms': '1500', 'retry-after': '7' }), ''), 1500);
  const future = new Date(Date.now() + 5000).toUTCString();
  const d = api.parseRetryAfter(H({ 'retry-after': future }), '');
  assert.ok(d > 2000 && d <= 5000, String(d));
  assert.strictEqual(api.parseRetryAfter(H({}), '{"error":{"message":"Rate limit reached. Please try again in 7m12.5s."}}'), 432500);
  assert.strictEqual(api.parseRetryAfter(H({}), '{"error":{"details":[{"retryDelay":"23s"}]}}'), 23000);
  assert.strictEqual(api.parseRetryAfter(H({ 'x-ratelimit-reset-requests': '1s', 'x-ratelimit-reset-tokens': '6m0s' }), ''), 360000);
  assert.strictEqual(api.parseRetryAfter(H({}), 'oops'), null);
  assert.strictEqual(api.fmtWait(12000), '12 detik');
  assert.strictEqual(api.fmtWait(7 * 60000), '7 menit');
}

// ---------------------------------------------------------------- server mock

function sseOA(res, chunks) {
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  for (const c of chunks) res.write(`data: ${JSON.stringify(c)}\n\n`);
  res.write('data: [DONE]\n\n');
  res.end();
}

async function testRetryApi() {
  const log = [];
  let script = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const j = JSON.parse(body);
      log.push({ url: req.url, body: j });
      const step = script.shift() || { ok: true };
      if (step.status) {
        res.writeHead(step.status, { 'content-type': 'application/json', ...(step.headers || {}) });
        return res.end(step.body || JSON.stringify({ error: { message: 'gagal ' + step.status } }));
      }
      if (step.stream) return step.stream(res);
      return sseOA(res, [{ choices: [{ delta: { content: 'OK' } }] }, { choices: [], usage: { prompt_tokens: 123, completion_tokens: 4 } }]);
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const prov = { kind: 'openai', baseUrl: base };
  const call = (extra = {}) => {
    let text = '';
    const retries = [];
    const p = api.chat({ provider: extra.provider || prov, conf: { apiKey: 'k' }, model: 'm', system: 's', messages: [{ role: 'user', content: 'hi' }], onDelta: (d) => (text += d), onRetry: (i) => retries.push(i), signal: extra.signal });
    return p.then((r) => ({ r, text, retries }));
  };

  // 429 dengan retry-after lalu sukses (+ usage terbaca)
  script = [{ status: 429, headers: { 'retry-after-ms': '30' } }, { ok: true }];
  let t0 = Date.now();
  let o = await call();
  assert.strictEqual(o.text, 'OK');
  assert.strictEqual(o.retries.length, 1);
  assert.strictEqual(o.retries[0].status, 429);
  assert.ok(o.retries[0].waitMs >= 30 && o.retries[0].waitMs < 500, String(o.retries[0].waitMs));
  assert.ok(Date.now() - t0 >= 30);
  assert.deepStrictEqual(o.r.usage, { input: 123, output: 4 });

  // 5xx berkali-kali: backoff eksponensial, lalu sukses
  script = [{ status: 503 }, { status: 502 }, { status: 500 }, { ok: true }];
  o = await call();
  assert.strictEqual(o.text, 'OK');
  assert.deepStrictEqual(o.retries.map((r) => r.attempt), [1, 2, 3]);

  // menyerah setelah batas retry, pesan error tetap jelas
  script = Array(10).fill({ status: 503 });
  log.length = 0;
  await assert.rejects(call, /HTTP 503/);
  assert.strictEqual(log.length, api.retry.max + 1);

  // tidak diulang: 401, 400, kuota habis, saldo habis
  for (const step of [
    { status: 401 }, { status: 400 },
    { status: 429, body: JSON.stringify({ error: { code: 'insufficient_quota', message: 'You exceeded your current quota' } }) },
    { status: 429, body: JSON.stringify({ error: { message: 'Your credit balance is too low' } }) },
  ]) {
    script = [step, { ok: true }];
    log.length = 0;
    await assert.rejects(call, /HTTP 4/);
    assert.strictEqual(log.length, 1, 'tidak boleh retry: ' + step.status);
  }

  // server minta tunggu terlalu lama (limit harian): jangan menunggu, beri pesan jelas
  script = [{ status: 429, headers: { 'retry-after': '3600' } }, { ok: true }];
  log.length = 0;
  await assert.rejects(call, (e) => /rate limit/.test(e.message) && /1 jam|60 menit/.test(e.message));
  assert.strictEqual(log.length, 1);

  // Anthropic overloaded di awal stream: diulang. Error setelah teks tampil: tidak diulang.
  const anthro = { kind: 'anthropic', baseUrl: base };
  script = [{ stream: (res) => { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.write('event: error\ndata: {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}\n\n'); res.end(); } },
    { stream: (res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write('event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":50,"cache_read_input_tokens":10,"output_tokens":1}}}\n\n');
      res.write('event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hai"}}\n\n');
      res.write('event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":9}}\n\n');
      res.end();
    } }];
  log.length = 0;
  o = await call({ provider: anthro });
  assert.strictEqual(o.text, 'Hai');
  assert.strictEqual(o.retries.length, 1);
  assert.deepStrictEqual(o.r.usage, { input: 60, output: 9 }, 'input = input + cache');

  script = [{ stream: (res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write('event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"setengah"}}\n\n');
    res.write('event: error\ndata: {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}\n\n');
    res.end();
  } }, { ok: true }];
  log.length = 0;
  let got = '';
  await assert.rejects(() => api.chat({ provider: anthro, conf: { apiKey: 'k' }, model: 'm', messages: [{ role: 'user', content: 'x' }], onDelta: (d) => (got += d) }), /Overloaded/);
  assert.strictEqual(got, 'setengah');
  assert.strictEqual(log.length, 1, 'teks sudah tampil: jangan diulang (akan menggandakan)');

  // stream_options ditolak server: ulangi tanpa itu
  const withUsage = { kind: 'openai', baseUrl: base, streamUsage: true };
  script = [{ status: 400, body: JSON.stringify({ error: { message: 'Unknown parameter: stream_options' } }) }, { ok: true }];
  log.length = 0;
  o = await call({ provider: withUsage });
  assert.strictEqual(o.text, 'OK');
  assert.ok(log[0].body.stream_options && !log[1].body.stream_options);

  // Esc saat menunggu retry: berhenti cepat sebagai AbortError
  script = [{ status: 429, headers: { 'retry-after': '1' } }, { ok: true }];
  const ac = new AbortController();
  setTimeout(() => ac.abort(), 100);
  t0 = Date.now();
  await assert.rejects(() => call({ signal: ac.signal }), (e) => e.name === 'AbortError');
  assert.ok(Date.now() - t0 < 800);

  // server mati (koneksi ditolak): tidak diulang, pesan ramah
  server.close(); if (server.closeAllConnections) server.closeAllConnections();
  await assert.rejects(call, /Tidak bisa terhubung/);
}

// ---------------------------------------------------------------- integrasi loop agent

async function testApp() {
  const reqs = [];
  const SUM = 'RINGKASAN-PALSU: user minta baca banyak file.';
  let mode = 'normal';
  let flaky = 0;
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const j = JSON.parse(body);
      const sys = (j.messages[0] && j.messages[0].role === 'system' && j.messages[0].content) || '';
      const isSummary = /compress an earlier part/.test(sys);
      reqs.push({ body: j, body_len: body.length, isSummary });
      if (isSummary) return sseOA(res, [{ choices: [{ delta: { content: mode === 'sumfail' ? '' : SUM } }] }, { choices: [], usage: { prompt_tokens: 900, completion_tokens: 30 } }]);
      if (mode === 'toobig' && body.length > 20000) {
        res.writeHead(400, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ error: { message: "This model's maximum context length is 8192 tokens" } }));
      }
      if (flaky > 0) { flaky--; res.writeHead(429, { 'retry-after-ms': '20', 'content-type': 'application/json' }); return res.end('{"error":{"message":"slow down"}}'); }
      return sseOA(res, [{ choices: [{ delta: { content: 'siap' } }] }, { choices: [], usage: { prompt_tokens: 2500, completion_tokens: 12 } }]);
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const mk = (windowTokens) => {
    const app = new App();
    app.draw = () => {};
    app.spin = () => {};
    app.cwd = tmp;
    app.cfg.active = { provider: 'custom', model: 'm' };
    app.cfg.providers.custom = { baseUrl: base, apiKey: 'k' };
    if (windowTokens) app.cfg.window = windowTokens;
    return app;
  };

  // 1) auto-compact: riwayat besar + jendela kecil
  let app = mk(5000);
  app.messages.push(...convo(10, 3000));
  const raw0 = app.estimateNow();
  assert.ok(raw0 > 5000 * 0.75, 'bahan tes harus melewati ambang: ' + raw0);
  await app.send('lanjut dong');
  assert.ok(reqs.some((r) => r.isSummary), 'harus ada request peringkas');
  const chatReq = reqs.filter((r) => !r.isSummary).pop();
  const sent = chatReq.body.messages.map((m) => m.content || '').join('\n');
  assert.ok(sent.includes('RINGKASAN-PALSU'), 'ringkasan harus ikut terkirim');
  assert.ok(!sent.includes('isi-0-' + 'x'.repeat(100)), 'isi tool lama tidak boleh terkirim lagi');
  assert.ok(sent.includes('lanjut dong'), 'pesan baru tetap terkirim');
  assert.ok(chatReq.body_len < 20000, 'request jauh lebih kecil: ' + chatReq.body_len);
  assert.strictEqual(app.usage.compactions, 1);
  assert.ok(app.messages.some((m) => m.summary) && app.messages.some((m) => m.archived));
  assert.ok(app.messages.some((m) => m.role === 'system' && /Konteks diringkas/.test(m.content)));
  assert.ok(app.transcript(80, 24).join('\n').includes('pesan lama diringkas'));
  assertValid(app.history());
  // usage asli dari server tercatat (ringkasan 900/30 + chat 2500/12), dan kalibrasi mengikuti
  assert.strictEqual(app.usage.input, 3400);
  assert.strictEqual(app.usage.output, 42);
  assert.strictEqual(app.usage.requests, 2);
  assert.strictEqual(app.usage.estRequests, 0);
  assert.ok(app.calib !== 1);
  const rep = app.usageReport();
  assert.ok(/Konteks: ~/.test(rep) && /3\.4k/.test(rep) && /Compact: 1x/.test(rep), rep);

  // 2) pesan berikutnya (di bawah ambang) tidak meringkas lagi
  const before = reqs.length;
  await app.send('terima kasih');
  assert.strictEqual(reqs.length - before, 1);
  assert.strictEqual(app.usage.compactions, 1);

  // 3) hanya pangkas hasil tool bila itu cukup (tanpa panggil peringkas)
  reqs.length = 0;
  app = mk(6000);
  app.messages.push(...convo(5, 3000));
  app.calib = 1;
  const est = app.estimateNow();
  assert.ok(est > 6000 * 0.75 && est < 6000 * 2, String(est));
  await app.send('lanjut');
  assert.ok(!reqs.some((r) => r.isSummary), 'cukup dipangkas, tak perlu ringkas');
  assert.ok(app.usage.pruned > 0 && app.usage.compactions === 0);
  assert.ok(app.messages.some((m) => m.role === 'system' && /hasil tool lama dipotong/.test(m.content)));

  // 4) /compact manual (dengan fokus), /usage, /window lewat command()
  reqs.length = 0;
  app = mk();
  app.messages.push(...convo(6, 100));
  await app.runCompact('nama file');
  const sreq = reqs.find((r) => r.isSummary);
  assert.ok(sreq && /nama file/.test(sreq.body.messages[0].content));
  assert.strictEqual(app.usage.compactions, 1);
  app.command('/usage');
  assert.ok(/Pesan aktif:/.test(app.messages[app.messages.length - 1].content));
  app.command('/window 32k');
  assert.strictEqual(app.cfg.window, 32000);
  app.command('/window 100');
  assert.strictEqual(app.cfg.window, 32000, 'angka terlalu kecil ditolak');
  app.command('/window auto');
  assert.strictEqual(app.cfg.window, undefined);
  app.messages = [{ role: 'user', content: 'a' }, { role: 'assistant', content: 'b' }];
  app.command('/compact');
  await new Promise((r) => setTimeout(r, 200));
  assert.ok(app.messages.some((m) => m.role === 'system' && /Belum ada yang perlu diringkas/.test(m.content)), 'tidak ada yang layak diringkas lagi');

  // 5) peringkas gagal: tidak fatal. Masih muat -> lanjut apa adanya; hampir penuh -> pesan lama dibuang dengan penanda
  reqs.length = 0;
  mode = 'sumfail';
  app = mk(3000);
  app.messages.push(...convo(10, 3000));
  await app.send('hai');
  assert.ok(app.messages.some((m) => m.role === 'system' && /Gagal meringkas.*Lanjut tanpa meringkas/.test(m.content)));
  assert.ok(!app.messages.some((m) => m.archived), 'masih muat: jangan buang apa pun');
  assert.strictEqual(app.messages[app.messages.length - 1].content, 'siap');
  app = mk(2200);
  app.messages.push(...convo(10, 3000));
  await app.send('hai');
  assert.ok(app.messages.some((m) => m.role === 'system' && /Peringkasan gagal.*dibuang/.test(m.content)));
  assert.ok(app.messages.some((m) => m.archived));
  assert.strictEqual(app.messages[app.messages.length - 1].content, 'siap');
  assertValid(app.history());
  mode = 'normal';

  // 6) server menolak karena konteks kepenuhan padahal estimasi bilang aman: ringkas paksa lalu ulangi sekali
  reqs.length = 0;
  mode = 'toobig';
  app = mk(1000000);
  app.messages.push(...convo(10, 3000));
  await app.send('lanjut');
  const kinds = reqs.map((r) => (r.isSummary ? 'S' : r.body_len > 20000 ? 'big' : 'ok'));
  assert.deepStrictEqual(kinds, ['big', 'S', 'ok'], kinds.join(','));
  assert.strictEqual(app.messages[app.messages.length - 1].content, 'siap');
  assert.ok(!app.messages.some((m) => m.role === 'error'));
  mode = 'normal';

  // 7) retry terlihat di usage dan tidak menggandakan teks
  reqs.length = 0;
  app = mk();
  flaky = 2;
  await app.send('hai');
  assert.strictEqual(app.usage.retries, 2);
  assert.strictEqual(app.messages.filter((m) => m.role === 'assistant').length, 1);
  assert.strictEqual(app.messages[app.messages.length - 1].content, 'siap');
  assert.strictEqual(app.retryInfo, null);
  app.retryInfo = { until: Date.now() + 5000, attempt: 1, max: 4, status: 429 };
  assert.ok(/Rate limit \(429\).*percobaan 1\/4/.test(app.retryHint()));

  // render status bar / chat tidak error dengan semua state baru
  app.compacting = true; app.busy = true;
  assert.ok(app.renderChat(80, 24).length === 24);
  app.busy = false; app.compacting = false;
  assert.ok(app.renderChat(80, 24).join('\n').includes('ctx '));

  server.close(); if (server.closeAllConnections) server.closeAllConnections();
}

(async () => {
  testEstimate();
  testPrune();
  testCut();
  await testCompactMessages();
  testParse();
  await testRetryApi();
  await testApp();
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log('context test OK');
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
