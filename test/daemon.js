'use strict';

// Tes daemon end-to-end vs provider AI mock: antrean via inbox, tool-use, kebijakan izin, limit -> tunggu -> lanjut,
// tugas berulang, batal, kontrol HTTP, berhenti bersih.
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'elephant-daemon-'));
process.env.ELEPHANT_HOME = path.join(tmp, 'home');
process.env.ELEPHANT_DAEMON_QUIET = '1';
delete process.env.GITHUB_TOKEN;
delete process.env.GH_TOKEN;
const work = path.join(tmp, 'work');
fs.mkdirSync(work);

const config = require('../src/config');
const runner = require('../src/runner');
const daemon = require('../src/daemon');
runner.timing.baseMs = 150;

let quotaLeft = 0;
let netDownLeft = 0;
const seen = [];

function sseText(res, text) {
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n`);
  res.write('data: [DONE]\n\n');
  res.end();
}

function sseTool(res, name, args) {
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  res.write(`data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'c' + Date.now(), type: 'function', function: { name, arguments: JSON.stringify(args) } }] } }] })}\n\n`);
  res.write('data: [DONE]\n\n');
  res.end();
}

const ai = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    if (req.url !== '/v1/chat/completions') { res.writeHead(404); return res.end(); }
    const j = JSON.parse(body);
    const msgs = j.messages;
    const last = msgs[msgs.length - 1];
    const firstUser = msgs.find((m) => m.role === 'user').content;
    seen.push({ firstUser, tools: (j.tools || []).map((t) => t.function.name) });
    if (/QUOTA/.test(firstUser) && quotaLeft > 0) {
      quotaLeft--;
      res.writeHead(429, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ error: { message: 'You exceeded your current quota, insufficient_quota' } }));
    }
    if (/NETDOWN/.test(firstUser) && netDownLeft > 0) { netDownLeft--; return req.socket.destroy(); }
    if (last.role === 'tool') return sseText(res, 'selesai: ' + String(last.content).slice(0, 80));
    if (/HELLO/.test(firstUser)) return sseTool(res, 'write_file', { path: 'hello.txt', content: 'hi dari daemon' });
    if (/DANGER/.test(firstUser)) return sseTool(res, 'run_command', { command: 'rm -rf *' });
    return sseText(res, 'ok ' + firstUser.slice(0, 20));
  });
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 8000, what = 'kondisi') {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 > ms) throw new Error('timeout menunggu ' + what);
    await sleep(50);
  }
}

function httpCall(port, method, p, token, body) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: p, method, headers: { ...(token ? { authorization: 'Bearer ' + token } : {}), 'content-type': 'application/json' } }, (res) => {
      let d = '';
      res.on('data', (c) => (d += c));
      res.on('end', () => resolve({ status: res.statusCode, body: d ? JSON.parse(d) : null }));
    });
    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

(async () => {
  assert.strictEqual(daemon.parseEvery('10m'), 600000);
  assert.strictEqual(daemon.parseEvery('30s'), 30000);
  assert.strictEqual(daemon.parseEvery('2'), 120000); // angka saja = menit
  assert.strictEqual(daemon.parseEvery('5s'), null); // terlalu cepat
  assert.strictEqual(daemon.parseEvery('abc'), null);
  assert.throws(() => daemon.send('x', { every: '1s' }), /tidak valid/);
  assert.throws(() => daemon.send('   '), /kosong/);

  await new Promise((r) => ai.listen(0, '127.0.0.1', r));
  const aiPort = ai.address().port;

  // belum ada provider -> pesan jelas
  assert.ok(/Belum ada provider/.test(daemon.readyError(config.load())));
  await assert.rejects(() => new daemon.Daemon({ cwd: work }).start(), /Belum ada provider/);

  const cfg = config.load();
  cfg.active = { provider: 'custom', model: 'mock' };
  cfg.providers.custom = { baseUrl: `http://127.0.0.1:${aiPort}/v1`, model: 'mock' };
  config.save(cfg);
  assert.strictEqual(daemon.readyError(config.load()), null);

  const d = new daemon.Daemon({ mode: 'auto', cwd: work, quiet: true, http: 0 + 17733 + Math.floor(Math.random() * 500) });
  const port = d.opts.http;
  const running = d.start();
  await until(() => fs.existsSync(daemon.paths().pid), 3000, 'pid file');
  assert.ok(daemon.readStatus().alive);

  // daemon kedua ditolak
  await assert.rejects(() => new daemon.Daemon({ cwd: work, quiet: true }).start(), /sudah jalan/);

  // 1) tugas lewat CLI/inbox -> agent pakai tool menulis file
  assert.strictEqual(daemon.send('HELLO tulis file').running, true);
  await until(() => d.state.history.some((h) => /HELLO/.test(h.text)), 8000, 'tugas HELLO');
  assert.strictEqual(fs.readFileSync(path.join(work, 'hello.txt'), 'utf8'), 'hi dari daemon');
  const h1 = d.state.history.find((h) => /HELLO/.test(h.text));
  assert.ok(h1.ok && /selesai/.test(h1.summary), JSON.stringify(h1));
  assert.ok(fs.existsSync(path.join(daemon.paths().results, h1.file)));
  assert.ok(d.state.queue.length === 0, 'tugas sekali jalan harus keluar dari antrean');
  assert.ok(seen.some((s) => s.tools.includes('write_file')));

  // 2) berkas .txt yang dijatuhkan manual ke inbox juga jadi tugas
  fs.writeFileSync(path.join(daemon.paths().inbox, 'catatan.txt'), 'tugas dari file txt');
  await until(() => d.state.history.some((h) => /tugas dari file txt/.test(h.text)), 8000, 'tugas txt');

  // 3) aksi berbahaya ditolak tanpa manusia; file tidak terhapus
  daemon.send('DANGER hapus semua');
  await until(() => d.state.history.some((h) => /DANGER/.test(h.text)), 8000, 'tugas DANGER');
  assert.ok(fs.existsSync(path.join(work, 'hello.txt')), 'aksi berbahaya TIDAK boleh jalan');
  assert.ok(/Ditolak/.test(d.state.history.find((h) => /DANGER/.test(h.text)).summary), JSON.stringify(d.state.history));

  // 4) kuota/limit habis di tengah tugas -> daemon menunggu lalu menyambung lagi sendiri
  quotaLeft = 2;
  daemon.send('QUOTA tugas panjang');
  await until(() => d.state.history.some((h) => /QUOTA/.test(h.text)), 10000, 'tugas QUOTA');
  const hq = d.state.history.find((h) => /QUOTA/.test(h.text));
  assert.ok(hq.ok, JSON.stringify(hq));
  assert.strictEqual(quotaLeft, 0);
  const log = fs.readFileSync(daemon.paths().log, 'utf8');
  assert.ok(/Menunggu .* lalu menyambung lagi otomatis/.test(log) && /Menyambung lagi/.test(log), log);

  // 5) koneksi putus di tengah jalan -> juga disambung lagi
  netDownLeft = 2;
  daemon.send('NETDOWN tes jaringan');
  await until(() => d.state.history.some((h) => /NETDOWN/.test(h.text)), 15000, 'tugas NETDOWN');
  assert.ok(d.state.history.find((h) => /NETDOWN/.test(h.text)).ok);

  // 6) tugas berulang tetap di antrean, jadwal berikutnya di masa depan; lalu dibatalkan
  daemon.send('cek berkala', { every: '10m' });
  await until(() => d.state.queue.some((t) => t.every === 600000 && t.runs === 1), 8000, 'run pertama tugas berulang');
  const rec = d.state.queue.find((t) => t.every === 600000);
  assert.ok(rec.nextAt > Date.now() + 500000);
  daemon.cancel(rec.id);
  await until(() => !d.state.queue.some((t) => t.id === rec.id), 5000, 'cancel');

  // 7) kontrol HTTP: token wajib
  const tok = daemon.getHttpToken(false);
  assert.ok(tok && tok.length >= 32);
  await until(() => d.server && d.server.listening, 3000, 'http listen');
  assert.strictEqual((await httpCall(port, 'GET', '/status', null)).status, 401);
  assert.strictEqual((await httpCall(port, 'GET', '/status', 'salah')).status, 401);
  let r = await httpCall(port, 'POST', '/task', tok, { text: 'tugas via http' });
  assert.strictEqual(r.status, 200);
  assert.ok(/^t\d+$/.test(r.body.id));
  await until(() => d.state.history.some((h) => /tugas via http/.test(h.text)), 8000, 'tugas http');
  r = await httpCall(port, 'GET', '/status', tok);
  assert.strictEqual(r.status, 200);
  assert.ok(Array.isArray(r.body.history));
  assert.strictEqual((await httpCall(port, 'POST', '/task', tok, { text: 'x', every: '1s' })).status, 400);

  // status tersimpan di disk
  const st = daemon.readStatus();
  assert.ok(st.alive && st.state.history.length >= 5);

  // 8) perintah stop lewat inbox: berhenti bersih, pid file hilang
  // (daemon.stop() menunggu proses lain mati; di tes ini daemon se-proses dengan tes, jadi dikirim manual)
  daemon.dropInbox({ cmd: 'stop' });
  await running;
  assert.ok(!fs.existsSync(daemon.paths().pid));
  assert.ok(/Daemon berhenti/.test(fs.readFileSync(daemon.paths().log, 'utf8')));
  assert.deepStrictEqual(await daemon.stop(), { stopped: false, reason: 'tidak sedang jalan' });

  // 9) tugas yang belum selesai bertahan di antrean untuk sesi berikutnya
  daemon.send('tugas saat daemon mati');
  const d2 = new daemon.Daemon({ cwd: work, quiet: true });
  const run2 = d2.start();
  await until(() => d2.state.history.some((h) => /tugas saat daemon mati/.test(h.text)), 8000, 'tugas setelah restart');
  d2.stop();
  await run2;
  assert.ok(!fs.existsSync(daemon.paths().pid));

  ai.close();
  console.log('daemon test OK');
  process.exit(0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
