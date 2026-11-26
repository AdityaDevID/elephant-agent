'use strict';

// Tes akses GitHub: token, tool vs server GitHub pals 'mock', izin kurang, rate limit (tunggu lalu lanjut), redaksi token, kebijakan izin.
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'elephant-gh-'));
process.env.ELEPHANT_HOME = path.join(tmp, 'home');
delete process.env.GITHUB_TOKEN;
delete process.env.GH_TOKEN;
delete process.env.ELEPHANT_GITHUB_TOKEN;

const gh = require('../src/github');
const tools = require('../src/tools');
const runner = require('../src/runner');

const TOKEN = 'ghp_' + 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8';
const files = { 'README.md': 'halo dunia\n' };
let hits = [];
let limitOnce = 0; // berapa kali pertama balas rate limit
let rateWaits = [];

const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    const url = new URL(req.url, 'http://x');
    hits.push(`${req.method} ${url.pathname}`);
    const send = (code, obj, headers = {}) => { res.writeHead(code, { 'content-type': 'application/json', 'x-ratelimit-limit': '5000', 'x-ratelimit-remaining': '4999', 'x-ratelimit-reset': String(Math.floor(Date.now() / 1000) + 3600), ...headers }); res.end(obj == null ? '' : JSON.stringify(obj)); };
    if (req.headers.authorization !== `Bearer ${TOKEN}`) return send(401, { message: 'Bad credentials' });
    if (limitOnce > 0 && url.pathname === '/repos/me/app/issues') {
      limitOnce--;
      return send(403, { message: 'You have exceeded a secondary rate limit.' }, { 'retry-after': '1', 'x-ratelimit-remaining': '0' });
    }
    if (url.pathname === '/user') return send(200, { login: 'me', id: 42, type: 'User', name: 'Me' }, { 'x-oauth-scopes': 'repo, workflow' });
    if (url.pathname === '/repos/me/app') return send(200, { full_name: 'me/app', private: true, default_branch: 'main', permissions: { admin: false, push: true, pull: true }, stargazers_count: 1, forks_count: 0, open_issues_count: 2, pushed_at: '2026-11-01T00:00:00Z', clone_url: 'https://github.com/me/app.git' });
    if (url.pathname === '/repos/other/secret') return send(404, { message: 'Not Found' });
    if (url.pathname === '/repos/other/readonly/contents/x.txt' && req.method === 'PUT') return send(403, { message: 'Resource not accessible by personal access token' }, { 'x-accepted-github-permissions': 'contents=write', 'x-oauth-scopes': '' });
    if (url.pathname === '/repos/other/readonly/contents/x.txt') return send(404, { message: 'Not Found' });
    if (url.pathname === '/repos/me/app/contents/README.md' && req.method === 'GET') {
      return send(200, { type: 'file', sha: 'sha-readme', size: 11, encoding: 'base64', content: Buffer.from(files['README.md']).toString('base64') });
    }
    if (url.pathname === '/repos/me/app/contents/' || url.pathname === '/repos/me/app/contents') return send(200, [{ type: 'file', name: 'README.md', size: 11 }, { type: 'dir', name: 'src', size: 0 }]);
    if (url.pathname === '/repos/me/app/contents/new.txt' && req.method === 'GET') return send(404, { message: 'Not Found' });
    if (url.pathname.startsWith('/repos/me/app/contents/') && req.method === 'PUT') {
      const j = JSON.parse(body);
      const p = decodeURIComponent(url.pathname.replace('/repos/me/app/contents/', ''));
      files[p] = Buffer.from(j.content, 'base64').toString('utf8');
      files[p + '.__body'] = j;
      return send(200, { commit: { sha: 'abcdef1234567', html_url: 'https://github.com/me/app/commit/abcdef1' } });
    }
    if (url.pathname === '/repos/me/app/issues' && req.method === 'GET') return send(200, [{ number: 1, title: 'Bug satu', state: 'open', user: { login: 'a' }, labels: [], updated_at: '2026-11-02T00:00:00Z' }, { number: 2, title: 'PR dua', state: 'open', user: { login: 'b' }, labels: [], pull_request: {}, updated_at: '2026-11-03T00:00:00Z' }]);
    if (url.pathname === '/repos/me/app/issues' && req.method === 'POST') { const j = JSON.parse(body); return send(201, { number: 9, html_url: 'https://github.com/me/app/issues/9', title: j.title }); }
    if (url.pathname === '/repos/me/app/git/ref/heads/main') return send(200, { object: { sha: '1111111222222233333' } });
    if (url.pathname === '/repos/me/app/git/refs' && req.method === 'POST') return send(201, { ref: JSON.parse(body).ref });
    if (url.pathname === '/repos/me/app/pulls' && req.method === 'POST') return send(201, { number: 5, html_url: 'https://github.com/me/app/pull/5' });
    if (url.pathname === '/repos/me/app/pulls/5/merge') return send(200, { merged: true, sha: 'ffff0000', message: 'ok' });
    return send(404, { message: 'Not Found: ' + url.pathname });
  });
});

const ctx = { cwd: tmp };
const run = (name, args, c = ctx) => tools.execute(name, args, c);

(async () => {
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  process.env.ELEPHANT_GITHUB_API = `http://127.0.0.1:${server.address().port}`;

  // --- tanpa token: tool gh_* tidak ditawarkan; prompt menyuruh agent bilang ke pengguna; eksekusi gagal dengan pesan jelas
  assert.ok(!gh.hasToken());
  assert.ok(!tools.defsFor('ask').some((d) => d.name.startsWith('gh_')));
  assert.ok(/no token is configured/.test(tools.agentPrompt(tmp, 'ask')));
  let r = await run('gh_repo_info', { repo: 'me/app' });
  assert.ok(r.isError && /Token GitHub belum diset/.test(r.content), r.content);

  // --- set token: tersimpan di github.json (0600), tool muncul
  gh.setToken(TOKEN);
  assert.ok(gh.hasToken());
  const f = path.join(process.env.ELEPHANT_HOME, 'github.json');
  assert.ok(fs.existsSync(f));
  if (process.platform !== 'win32') assert.strictEqual(fs.statSync(f).mode & 0o777, 0o600);
  assert.ok(tools.defsFor('ask').some((d) => d.name === 'gh_write_file'));
  assert.ok(!tools.defsFor('readonly').some((d) => d.name === 'gh_write_file') && tools.defsFor('readonly').some((d) => d.name === 'gh_read'));
  assert.ok(/a token is configured/.test(tools.agentPrompt(tmp, 'ask')));

  // --- baca
  r = await run('gh_whoami', {});
  assert.ok(!r.isError && /Akun: me/.test(r.content) && /repo, workflow/.test(r.content) && /classic|tidak dikenal|fine-grained/.test(r.content), r.content);
  assert.ok(!r.content.includes(TOKEN));
  r = await run('gh_repo_info', { repo: 'https://github.com/me/app.git' });
  assert.ok(/Branch default: main/.test(r.content) && /push/.test(r.content), r.content);
  r = await run('gh_read', { repo: 'me/app', path: 'README.md' });
  assert.ok(/sha: sha-readme/.test(r.content) && /halo dunia/.test(r.content), r.content);
  r = await run('gh_read', { repo: 'me/app' });
  assert.ok(/README.md/.test(r.content) && /src\//.test(r.content));
  r = await run('gh_list_issues', { repo: 'me/app' });
  assert.ok(/#1 Bug satu/.test(r.content) && !/#2/.test(r.content), r.content); // PR difilter dari issues
  r = await run('gh_list_issues', { repo: 'me/app', kind: 'all' });
  assert.ok(/#2 \[PR\]/.test(r.content));

  // --- tulis: file baru (tanpa sha) dan update (dengan sha)
  r = await run('gh_write_file', { repo: 'me/app', path: 'new.txt', content: 'isi baru', message: 'tambah new.txt', branch: 'dev' });
  assert.ok(!r.isError && /Dibuat/.test(r.content) && /abcdef1/.test(r.content), r.content);
  assert.strictEqual(files['new.txt.__body'].branch, 'dev');
  assert.strictEqual(files['new.txt.__body'].sha, undefined);
  r = await run('gh_write_file', { repo: 'me/app', path: 'README.md', content: 'v2', message: 'update' });
  assert.ok(/Diperbarui/.test(r.content));
  assert.strictEqual(files['README.md.__body'].sha, 'sha-readme');
  assert.strictEqual(files['README.md'], 'v2');
  r = await run('gh_create_issue', { repo: 'me/app', title: 'Judul', labels: ['bug'] });
  assert.ok(/Issue #9/.test(r.content));
  r = await run('gh_create_branch', { repo: 'me/app', branch: 'fitur-x' });
  assert.ok(/Branch dibuat: fitur-x \(dari main, 1111111\)/.test(r.content), r.content);
  r = await run('gh_create_pr', { repo: 'me/app', title: 'PR', head: 'fitur-x' });
  assert.ok(/PR #5/.test(r.content));

  // --- akses kurang: pesan jelas yang bisa diteruskan agent ke pengguna
  r = await run('gh_write_file', { repo: 'other/readonly', path: 'x.txt', content: 'x', message: 'm' });
  assert.ok(r.isError && /HTTP 403|menolak/.test(r.content) && /contents=write/.test(r.content) && /Beri tahu pengguna/.test(r.content), r.content);
  r = await run('gh_repo_info', { repo: 'other/secret' });
  assert.ok(r.isError && /404/.test(r.content) && /tidak punya akses|akses/.test(r.content), r.content);
  r = await run('gh_repo_info', { repo: 'bukan repo' });
  assert.ok(r.isError && /owner\/nama/.test(r.content));

  // --- token salah -> pesan 401 jelas
  gh.setToken('ghp_' + 'Z'.repeat(36));
  r = await run('gh_whoami', {});
  assert.ok(r.isError && /ditolak/.test(r.content) && /\/github/.test(r.content), r.content);
  gh.setToken(TOKEN);

  // --- gh_api: hanya path relatif ke api.github.com (token tidak boleh bocor ke host lain)
  r = await run('gh_api', { method: 'GET', path: 'https://evil.example/steal' });
  assert.ok(r.isError && /tidak valid/.test(r.content), r.content);
  r = await run('gh_api', { method: 'GET', path: '//evil.example/x' });
  assert.ok(r.isError);
  r = await run('gh_api', { method: 'GET', path: '/repos/me/app' });
  assert.ok(!r.isError && /me\/app/.test(r.content));

  // --- rate limit: menunggu (retry-after) lalu lanjut otomatis; onWait dipanggil
  limitOnce = 1;
  rateWaits = [];
  const t0 = Date.now();
  r = await run('gh_list_issues', { repo: 'me/app' }, { cwd: tmp, onWait: (w) => rateWaits.push(w) });
  assert.ok(!r.isError && /#1 Bug satu/.test(r.content), r.content);
  assert.strictEqual(rateWaits.length, 1);
  assert.ok(Date.now() - t0 >= 1000, 'harus benar-benar menunggu');
  // rate limit terlalu lama -> error jelas, bukan menggantung
  limitOnce = 1;
  r = await run('gh_list_issues', { repo: 'me/app' }, { cwd: tmp, maxWaitMs: 100 });
  assert.ok(r.isError && /Rate limit GitHub/.test(r.content), r.content);

  // --- kebijakan izin
  const def = (n) => tools.getDef(n);
  assert.strictEqual(tools.needsApproval(def('gh_read'), { repo: 'a/b' }, 'ask', new Set()), false);
  assert.strictEqual(tools.needsApproval(def('gh_write_file'), {}, 'ask', new Set()), true);
  assert.strictEqual(tools.needsApproval(def('gh_write_file'), {}, 'auto', new Set()), false);
  assert.strictEqual(tools.needsApproval(def('gh_api'), { method: 'GET', path: '/user' }, 'ask', new Set()), false); // GET = baca
  assert.strictEqual(tools.needsApproval(def('gh_api'), { method: 'POST', path: '/repos/a/b/issues' }, 'ask', new Set()), true);
  assert.strictEqual(tools.needsApproval(def('gh_api'), { method: 'POST', path: '/repos/a/b/issues' }, 'auto', new Set()), false);
  // berbahaya: selalu ditanya, juga di auto
  assert.strictEqual(tools.needsApproval(def('gh_merge_pr'), {}, 'auto', new Set()), true);
  assert.strictEqual(tools.needsApproval(def('gh_api'), { method: 'DELETE', path: '/repos/a/b' }, 'auto', new Set()), true);
  assert.strictEqual(tools.needsApproval(def('gh_api'), { method: 'PATCH', path: '/repos/a/b' }, 'auto', new Set()), true); // visibilitas/arsip
  assert.strictEqual(tools.needsApproval(def('gh_api'), { method: 'PUT', path: '/repos/a/b/collaborators/x' }, 'auto', new Set()), true);
  assert.strictEqual(tools.needsApproval(def('gh_api'), { method: 'PUT', path: '/repos/a/b/actions/secrets/X' }, 'auto', new Set()), true);

  // daemon (tanpa manusia): berbahaya ditolak kecuali --allow-dangerous; mode ask hanya baca + allow
  const P = (name, args, o) => runner.policy(def(name), args, o);
  assert.ok(/Ditolak/.test(P('gh_merge_pr', { repo: 'a/b', number: 1 }, { mode: 'auto' })));
  assert.strictEqual(P('gh_merge_pr', { repo: 'a/b', number: 1 }, { mode: 'auto', allowDangerous: true }), null);
  assert.strictEqual(P('gh_write_file', {}, { mode: 'auto' }), null);
  assert.ok(/Ditolak/.test(P('gh_write_file', {}, { mode: 'ask', allow: new Set() })));
  assert.strictEqual(P('gh_write_file', {}, { mode: 'ask', allow: new Set(['gh_write_file']) }), null);
  assert.strictEqual(P('gh_read', {}, { mode: 'ask', allow: new Set() }), null);
  assert.ok(/readonly/.test(P('gh_write_file', {}, { mode: 'readonly' })));
  assert.ok(/Ditolak/.test(P('run_command', { command: 'rm -rf /' }, { mode: 'auto' })));
  assert.strictEqual(P('run_command', { command: 'ls' }, { mode: 'auto' }), null);

  // --- token tidak boleh sampai ke model: output tool apa pun disaring
  r = await run('run_command', { command: process.platform === 'win32' ? `echo ${TOKEN}` : `echo ${TOKEN}` });
  assert.ok(!r.content.includes(TOKEN) && /token-disembunyikan/.test(r.content), r.content);
  if (process.platform !== 'win32') {
    r = await run('run_command', { command: 'git --version >/dev/null; echo "$GIT_CONFIG_VALUE_0"; env | grep -i "^GIT_CONFIG" ' });
    assert.ok(!r.content.includes(Buffer.from('x-access-token:' + TOKEN).toString('base64')), 'header git bocor ke output');
    assert.ok(/token-disembunyikan/.test(r.content), r.content); // env git terpasang tapi tersaring
    // perintah non-git tidak diberi kredensial
    r = await run('run_command', { command: 'env | grep -c GIT_CONFIG_VALUE || true' });
    assert.ok(/^0/.test(r.content.trim()), r.content);
  }
  assert.strictEqual(gh.redact(`x ${TOKEN} y`), 'x [token-disembunyikan] y');
  assert.ok(!JSON.stringify(gh.gitEnv('ls')).includes(TOKEN) && Object.keys(gh.gitEnv('ls')).length === 0);
  assert.ok(gh.gitEnv('git push').GIT_CONFIG_COUNT === '1');

  // --- logout
  gh.clearToken();
  assert.ok(!gh.hasToken());
  assert.ok(!tools.defsFor('ask').some((d) => d.name.startsWith('gh_')));
  r = await run('gh_repo_info', { repo: 'me/app' });
  assert.ok(r.isError && /belum diset/.test(r.content));

  server.close();
  console.log('github test OK');
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
