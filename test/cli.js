'use strict';

// Tes CLI sungguhan (proses terpisah): github login via stdin, daemon --detach, send, status, tasks, cancel, stop.
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const { spawn, spawnSync } = require('child_process');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'elephant-cli-'));
const home = path.join(tmp, 'home');
const work = path.join(tmp, 'work');
fs.mkdirSync(work);
const BIN = path.join(__dirname, '..', 'bin', 'elephant.js');
const env = { ...process.env, ELEPHANT_HOME: home, ELEPHANT_DAEMON_QUIET: '1', NO_COLOR: '1' };
for (const k of ['GITHUB_TOKEN', 'GH_TOKEN', 'ELEPHANT_GITHUB_TOKEN']) delete env[k];

// Asinkron (bukan spawnSync): server mock hidup di proses tes ini, jadi event loop tidak boleh diblok.
const cli = (args, input) => new Promise((resolve) => {
  const c = spawn(process.execPath, [BIN, ...args], { env, cwd: work });
  let stdout = '';
  let stderr = '';
  const t = setTimeout(() => c.kill('SIGKILL'), 30000);
  c.stdout.on('data', (d) => (stdout += d));
  c.stderr.on('data', (d) => (stderr += d));
  c.on('close', (status) => { clearTimeout(t); resolve({ status, stdout, stderr }); });
  c.stdin.on('error', () => {});
  c.stdin.end(input || '');
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const TOKEN = 'ghp_' + 'Q1w2E3r4T5y6U7i8O9p0A1s2D3f4G5h6J7k8';

const gh = http.createServer((req, res) => {
  const ok = req.headers.authorization === `Bearer ${TOKEN}`;
  res.writeHead(ok ? 200 : 401, { 'content-type': 'application/json', 'x-oauth-scopes': 'repo' });
  res.end(JSON.stringify(ok ? { login: 'tester', id: 7, type: 'User' } : { message: 'Bad credentials' }));
});

const ai = http.createServer((req, res) => {
  req.resume();
  req.on('end', () => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'beres' } }] })}\n\ndata: [DONE]\n\n`);
    res.end();
  });
});

(async () => {
  await new Promise((r) => gh.listen(0, '127.0.0.1', r));
  await new Promise((r) => ai.listen(0, '127.0.0.1', r));
  env.ELEPHANT_GITHUB_API = `http://127.0.0.1:${gh.address().port}`;

  // help & tanpa provider
  let r = await cli(['--help']);
  assert.ok(/elephant daemon/.test(r.stdout) && /github login/.test(r.stdout));
  r = await cli(['daemon']);
  assert.ok(r.status !== 0 && /Belum ada provider/.test(r.stderr), r.stderr);

  // github login lewat stdin (non-TTY), diverifikasi ke server mock
  r = await cli(['github', 'status']);
  assert.ok(/Belum ada token/.test(r.stdout), r.stdout);
  r = await cli(['github', 'login'], 'ghp_' + 'x'.repeat(36) + '\n');
  assert.ok(r.status !== 0 && /tidak bisa diverifikasi|ditolak/.test(r.stderr), r.stdout + r.stderr);
  r = await cli(['github', 'login'], TOKEN + '\n');
  assert.strictEqual(r.status, 0, r.stderr);
  assert.ok(/Akun: tester/.test(r.stdout) && !r.stdout.includes(TOKEN), r.stdout);
  assert.ok(fs.existsSync(path.join(home, 'github.json')));
  assert.ok(!fs.existsSync(path.join(home, 'config.json')) || !fs.readFileSync(path.join(home, 'config.json'), 'utf8').includes(TOKEN), 'token tidak boleh ada di config.json');

  // siapkan provider mock
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ version: 1, active: { provider: 'custom', model: 'm' }, providers: { custom: { baseUrl: `http://127.0.0.1:${ai.address().port}/v1`, model: 'm' } }, system: 'x', tools: true, mode: 'ask' }));

  // kirim sebelum daemon jalan: masuk antrean durable
  r = await cli(['send', 'tugas awal sebelum daemon']);
  assert.ok(/belum jalan/.test(r.stdout), r.stdout);
  r = await cli(['send', 'x', '--every', '1s']);
  assert.ok(r.status !== 0 && /tidak valid/.test(r.stderr));

  // daemon di background
  r = await cli(['daemon', '--detach', '--cwd', work]);
  assert.strictEqual(r.status, 0, r.stdout + r.stderr);
  assert.ok(/pid \d+/.test(r.stdout), r.stdout);
  const pid = parseInt(/pid (\d+)/.exec(r.stdout)[1], 10);
  r = await cli(['daemon', '--detach']);
  assert.ok(r.status !== 0 && /sudah jalan/.test(r.stderr + r.stdout), r.stdout + r.stderr);

  // tugas lama diproses, tugas baru juga
  r = await cli(['send', 'tugas kedua']);
  assert.ok(/dikirim ke daemon/.test(r.stdout), r.stdout);
  let st;
  for (let i = 0; i < 60; i++) {
    await sleep(250);
    st = (await cli(['status'])).stdout;
    if (/OK\s+t\d+.*tugas|OK /.test(st) && (st.match(/OK /g) || []).length >= 2) break;
  }
  assert.ok(/Daemon: JALAN/.test(st) && /token ada \(classic\)/.test(st), st);
  assert.ok((st.match(/OK /g) || []).length >= 2, st);

  // tugas berulang + cancel
  await cli(['send', 'berkala', '--every', '10m']);
  let tasks = '';
  for (let i = 0; i < 40; i++) { await sleep(250); tasks = (await cli(['tasks'])).stdout; if (/tiap 10m/.test(tasks)) break; }
  assert.ok(/\[tiap 10m\] berkala/.test(tasks), tasks);
  const id = /(t\d+)\s+\[tiap 10m\]/.exec(tasks)[1];
  await cli(['cancel', id]);
  for (let i = 0; i < 40; i++) { await sleep(250); tasks = (await cli(['tasks'])).stdout; if (!/tiap 10m/.test(tasks)) break; }
  assert.ok(!/\[tiap 10m\]/.test(tasks), tasks);
  assert.ok(/Daemon mulai/.test((await cli(['logs', '50'])).stdout));

  // stop
  r = await cli(['stop']);
  assert.ok(/Daemon berhenti/.test(r.stdout), r.stdout + r.stderr);
  let alive = true;
  for (let i = 0; i < 20 && alive; i++) { try { process.kill(pid, 0); await sleep(200); } catch { alive = false; } }
  assert.ok(!alive, 'proses daemon harus mati');
  assert.ok(/tidak jalan/.test((await cli(['status'])).stdout));
  r = await cli(['stop']);
  assert.ok(/tidak sedang jalan/.test(r.stdout));

  // logout & reset
  r = await cli(['github', 'logout']);
  assert.ok(/dihapus/.test(r.stdout));
  assert.ok(/Belum ada token/.test((await cli(['github', 'status'])).stdout));

  gh.close();
  ai.close();
  console.log('cli test OK');
  process.exit(0);
})().catch((e) => {
  console.error(e);
  try { spawnSync(process.execPath, [BIN, 'stop'], { env, timeout: 15000 }); } catch { /* abaikan */ }
  process.exit(1);
});
