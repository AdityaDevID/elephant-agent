'use strict';

// Tes pagar SSRF: klasifikasi IP, bentuk URL yang disamarkan, lookup anti DNS-rebinding, redirect, dan alur izin di UI.
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const assert = require('assert');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'elephant-ssrf-'));
process.env.ELEPHANT_HOME = path.join(tmp, 'home');

const sf = require('../src/safefetch');
const tools = require('../src/tools');
const { App } = require('../src/ui');

function testClassify() {
  const pub = ['8.8.8.8', '1.1.1.1', '93.184.216.34', '172.32.0.1', '172.15.255.255', '100.128.0.1', '192.169.0.1', '2606:4700:4700::1111', '::ffff:8.8.8.8', '2002:0808:0808::1', '64:ff9b::808:808'];
  for (const ip of pub) assert.strictEqual(sf.classifyIp(ip), null, 'harus publik: ' + ip);
  const priv = ['127.0.0.1', '127.1.2.3', '10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.1.1', '100.64.0.1', '0.0.0.0', '224.0.0.1', '255.255.255.255',
    '::1', '::', 'fc00::1', 'fd12:3456::1', '::ffff:127.0.0.1', '::ffff:7f00:1', '::ffff:10.0.0.1', '64:ff9b::7f00:1', '2002:7f00:1::1', 'ff02::1', '::7f00:1', '2001:db8::1'];
  for (const ip of priv) assert.ok(sf.classifyIp(ip), 'harus diblokir: ' + ip);
  const hard = ['169.254.169.254', '169.254.0.1', '100.100.100.200', 'fe80::1', 'fd00:ec2::254', '::ffff:169.254.169.254', '64:ff9b::a9fe:a9fe'];
  for (const ip of hard) assert.ok(sf.classifyIp(ip) && sf.classifyIp(ip).hard, 'harus hard-block: ' + ip);
  assert.ok(!sf.classifyIp('10.0.0.1').hard);
}

function testCheckUrl() {
  const blockedUrls = ['http://127.0.0.1/', 'http://2130706433/', 'http://0x7f.1/', 'http://127.1/', 'http://0177.0.0.1/', 'http://[::1]/', 'http://[::ffff:7f00:1]/',
    'http://[::ffff:127.0.0.1]:8080/', 'http://localhost/', 'http://LOCALHOST./', 'http://api.localhost/', 'http://10.0.0.5:3000/x', 'http://192.168.1.1/', 'http://169.254.169.254/latest/meta-data/',
    'http://metadata.google.internal/computeMetadata/v1/', 'http://user:pw@127.0.0.1/'];
  for (const u of blockedUrls) {
    assert.throws(() => sf.checkUrl(new URL(u), new Set()), (e) => e.code === 'ELEPHANT_BLOCKED', 'harus diblokir: ' + u);
  }
  for (const u of ['http://8.8.8.8/', 'https://example.com/', 'http://[2606:4700:4700::1111]/', 'https://sub.example.org:8443/a?b=c']) {
    sf.checkUrl(new URL(u), new Set()); // tidak melempar (nama biasa lolos tahap ini; DNS diperiksa saat konek)
  }
  assert.throws(() => sf.checkUrl(new URL('ftp://example.com/'), new Set()), /skema/);
  assert.throws(() => sf.checkUrl(new URL('file:///etc/passwd'), new Set()), /skema/);

  // izin eksplisit: per host+port, dan hard-block tidak bisa dibuka
  const allow = new Set(['127.0.0.1:8080', '169.254.169.254:80', 'localhost:11434']);
  sf.checkUrl(new URL('http://127.0.0.1:8080/'), allow);
  sf.checkUrl(new URL('http://localhost:11434/api'), allow);
  assert.throws(() => sf.checkUrl(new URL('http://127.0.0.1:9090/'), allow), (e) => e.code === 'ELEPHANT_BLOCKED' && !e.hard, 'port lain tidak ikut diizinkan');
  assert.throws(() => sf.checkUrl(new URL('http://169.254.169.254/'), allow), (e) => e.hard, 'metadata tidak boleh diizinkan');
}

function lookupOnce(fn, host, opts = {}) {
  return new Promise((resolve) => fn(host, opts, (err, a, b) => resolve({ err, a, b })));
}

async function testGuardedLookup() {
  const fake = (addrs) => (host, opts, cb) => cb(null, addrs.map((address) => ({ address, family: address.includes(':') ? 6 : 4 })));
  // nama publik yang ternyata mengarah ke alamat private (DNS rebinding / DNS jahat)
  let r = await lookupOnce(sf.guardedLookup('evil.example', 'evil.example:80', false, fake(['10.0.0.7'])), 'evil.example');
  assert.ok(r.err && r.err.code === 'ELEPHANT_BLOCKED' && r.err.ip === '10.0.0.7');
  // salah satu dari beberapa alamat private: tetap diblokir
  r = await lookupOnce(sf.guardedLookup('evil.example', 'evil.example:80', false, fake(['8.8.8.8', '127.0.0.1'])), 'evil.example', { all: true });
  assert.ok(r.err && r.err.code === 'ELEPHANT_BLOCKED');
  // semua publik: lolos, format all dan non-all
  r = await lookupOnce(sf.guardedLookup('ok.example', 'ok.example:80', false, fake(['8.8.8.8'])), 'ok.example', { all: true });
  assert.ok(!r.err && Array.isArray(r.a) && r.a[0].address === '8.8.8.8');
  r = await lookupOnce(sf.guardedLookup('ok.example', 'ok.example:80', false, fake(['8.8.8.8'])), 'ok.example');
  assert.ok(!r.err && r.a === '8.8.8.8' && r.b === 4);
  // diizinkan user: private lolos, tapi link-local tidak
  r = await lookupOnce(sf.guardedLookup('lan.example', 'lan.example:80', true, fake(['192.168.1.9'])), 'lan.example');
  assert.ok(!r.err);
  r = await lookupOnce(sf.guardedLookup('lan.example', 'lan.example:80', true, fake(['169.254.169.254'])), 'lan.example');
  assert.ok(r.err && r.err.hard);
  // error DNS diteruskan apa adanya
  r = await lookupOnce(sf.guardedLookup('x', 'x:80', false, (h, o, cb) => cb(new Error('ENOTFOUND'))), 'x');
  assert.ok(r.err && /ENOTFOUND/.test(r.err.message));
}

async function testSafeGet() {
  const gz = zlib.gzipSync('halo terkompresi');
  let hits = 0;
  const other = http.createServer((req, res) => { hits++; res.end('port lain'); });
  await new Promise((r) => other.listen(0, '127.0.0.1', r));
  const otherPort = other.address().port;
  const srv = http.createServer((req, res) => {
    if (req.url === '/ok') { res.setHeader('content-type', 'text/plain'); return res.end('isi ok'); }
    if (req.url === '/gz') { res.writeHead(200, { 'content-type': 'text/plain', 'content-encoding': 'gzip' }); return res.end(gz); }
    if (req.url === '/rel') { res.writeHead(302, { location: '/ok' }); return res.end(); }
    if (req.url === '/to-other') { res.writeHead(302, { location: `http://127.0.0.1:${otherPort}/` }); return res.end(); }
    if (req.url === '/to-meta') { res.writeHead(301, { location: 'http://169.254.169.254/latest/meta-data/' }); return res.end(); }
    if (req.url === '/to-file') { res.writeHead(302, { location: 'file:///etc/passwd' }); return res.end(); }
    if (req.url === '/loop') { res.writeHead(302, { location: '/loop' }); return res.end(); }
    if (req.url === '/big') { res.setHeader('content-type', 'text/plain'); return res.end('a'.repeat(300000)); }
    if (req.url === '/hang') return undefined;
    res.writeHead(404); return res.end('nope');
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const port = srv.address().port;
  const base = `http://127.0.0.1:${port}`;
  const allow = new Set([`127.0.0.1:${port}`]);

  // default: diblokir dan tidak ada koneksi yang terjadi
  await assert.rejects(() => sf.safeGet(base + '/ok'), (e) => e.code === 'ELEPHANT_BLOCKED' && e.hostKey === `127.0.0.1:${port}`);
  await assert.rejects(() => sf.safeGet(`http://localhost:${port}/ok`), (e) => e.code === 'ELEPHANT_BLOCKED');

  // setelah disetujui
  let r = await sf.safeGet(base + '/ok', { allowHosts: allow });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.body.toString(), 'isi ok');
  r = await sf.safeGet(base + '/gz', { allowHosts: allow });
  assert.strictEqual(r.body.toString(), 'halo terkompresi');
  r = await sf.safeGet(base + '/rel', { allowHosts: allow });
  assert.strictEqual(r.body.toString(), 'isi ok');
  assert.strictEqual(r.redirects, 1);

  // redirect dicek ulang: host/port lain, metadata, skema file
  await assert.rejects(() => sf.safeGet(base + '/to-other', { allowHosts: allow }), (e) => e.code === 'ELEPHANT_BLOCKED' && e.hostKey === `127.0.0.1:${otherPort}`);
  assert.strictEqual(hits, 0, 'server tujuan redirect tidak boleh tersentuh');
  await assert.rejects(() => sf.safeGet(base + '/to-meta', { allowHosts: new Set([...allow, '169.254.169.254:80']) }), (e) => e.code === 'ELEPHANT_BLOCKED' && e.hard);
  await assert.rejects(() => sf.safeGet(base + '/to-file', { allowHosts: allow }), /skema/);
  await assert.rejects(() => sf.safeGet(base + '/loop', { allowHosts: allow }), /terlalu banyak redirect/);

  // batas ukuran, timeout, abort
  r = await sf.safeGet(base + '/big', { allowHosts: allow, maxBytes: 1000 });
  assert.ok(r.truncated && r.body.length === 1000);
  await assert.rejects(() => sf.safeGet(base + '/hang', { allowHosts: allow, timeoutMs: 200 }), (e) => e.name === 'TimeoutError');
  const ac = new AbortController();
  setTimeout(() => ac.abort(), 100);
  await assert.rejects(() => sf.safeGet(base + '/hang', { allowHosts: allow, signal: ac.signal }), (e) => e.name === 'AbortError');

  // lewat tool fetch_url
  let t = await tools.execute('fetch_url', { url: base + '/ok' }, { cwd: tmp });
  assert.ok(t.isError && /Diblokir/.test(t.content) && t.blocked && !t.blocked.hard && t.blocked.hostKey === `127.0.0.1:${port}`, t.content);
  t = await tools.execute('fetch_url', { url: base + '/ok' }, { cwd: tmp, allowHosts: allow });
  assert.ok(!t.isError && /^HTTP 200/.test(t.content) && t.content.endsWith('isi ok'), t.content);
  t = await tools.execute('fetch_url', { url: 'http://169.254.169.254/' }, { cwd: tmp });
  assert.ok(t.blocked && t.blocked.hard && /tidak pernah/.test(t.content));
  t = await tools.execute('fetch_url', { url: base + '/nope' }, { cwd: tmp, allowHosts: allow });
  assert.ok(t.isError && /^HTTP 404/.test(t.content));
  t = await tools.execute('fetch_url', { url: 'ftp://x/' }, { cwd: tmp });
  assert.ok(t.isError && /http/.test(t.content));

  return { srv, other, port };
}

// Alur UI: model memanggil fetch_url ke alamat lokal -> pengguna ditanya -> ya/tidak.
async function testApproval(port) {
  const url = `http://127.0.0.1:${port}/ok`;
  const llm = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const j = JSON.parse(body);
      const last = j.messages[j.messages.length - 1];
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      if (last.role === 'user') {
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'f1', function: { name: 'fetch_url', arguments: JSON.stringify({ url }) } }] } }] })}\n\n`);
      } else {
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'selesai' } }] })}\n\n`);
        res.lastTool = last.content;
        llm.lastTool = last.content;
      }
      res.write('data: [DONE]\n\n');
      res.end();
    });
  });
  await new Promise((r) => llm.listen(0, '127.0.0.1', r));
  const mk = () => {
    const app = new App();
    app.draw = () => {};
    app.spin = () => {};
    app.cwd = tmp;
    app.cfg.active = { provider: 'custom', model: 'm' };
    app.cfg.providers.custom = { baseUrl: `http://127.0.0.1:${llm.address().port}`, apiKey: 'k' };
    app.cfg.mode = 'auto'; // mode auto pun tetap harus bertanya untuk alamat private
    return app;
  };

  let app = mk();
  const asked = [];
  app.askPerm = async (tm, danger, extra) => { asked.push({ name: tm.name, danger, warn: extra && extra.warn, label: extra && extra.label }); return 'yes'; };
  await app.send('ambil');
  assert.strictEqual(asked.length, 1);
  assert.ok(asked[0].danger && /private/.test(asked[0].warn) && asked[0].label.includes('127.0.0.1'), JSON.stringify(asked));
  assert.ok(/isi ok/.test(llm.lastTool), llm.lastTool);

  app = mk();
  app.askPerm = async () => 'no';
  await app.send('ambil');
  assert.ok(/Diblokir/.test(llm.lastTool) && /menolak/.test(llm.lastTool), llm.lastTool);
  const tm = app.messages.find((m) => m.role === 'tool');
  assert.strictEqual(tm.status, 'error');

  llm.close(); if (llm.closeAllConnections) llm.closeAllConnections();
}

(async () => {
  testClassify();
  testCheckUrl();
  await testGuardedLookup();
  const { srv, other, port } = await testSafeGet();
  await testApproval(port);
  for (const s of [srv, other]) { s.close(); if (s.closeAllConnections) s.closeAllConnections(); }
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log('safefetch test OK');
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
