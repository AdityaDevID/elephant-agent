'use strict';

// Smoke test tanpa dependency: lapisan API (list model + streaming) vs server mock, plus helper teks.
const http = require('http');
const assert = require('assert');
for (const k of ['GITHUB_TOKEN', 'GH_TOKEN', 'ELEPHANT_GITHUB_TOKEN']) delete process.env[k]; // runner CI men-set GH_TOKEN
const A = require('../src/ansi');
const api = require('../src/api');
const { filterItems, md } = require('../src/ui');

function sse(res, events) {
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  for (const [event, data] of events) res.write((event ? `event: ${event}\n` : '') + `data: ${data}\n\n`);
  res.end();
}

const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    if (req.url === '/oa/v1/models') {
      if (req.headers.authorization !== 'Bearer good') { res.writeHead(401, { 'content-type': 'application/json' }); return res.end('{"error":{"message":"bad key"}}'); }
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ data: [{ id: 'models/mock-b' }, { id: 'mock-a' }, { id: 'text-embedding-3' }] }));
    }
    if (req.url === '/oa/v1/chat/completions') {
      const j = JSON.parse(body);
      assert.strictEqual(j.messages[0].role, 'system');
      return sse(res, [
        [null, JSON.stringify({ choices: [{ delta: { content: 'Ha' } }] })],
        [null, JSON.stringify({ choices: [{ delta: { content: 'lo' } }] })],
        [null, '[DONE]'],
      ]);
    }
    if (req.url === '/an/v1/models?limit=1000') {
      assert.strictEqual(req.headers['x-api-key'], 'good');
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ data: [{ id: 'claude-x', display_name: 'Claude X' }] }));
    }
    if (req.url === '/an/v1/messages') {
      const j = JSON.parse(body);
      assert.strictEqual(j.system, 'sys');
      assert.deepStrictEqual(j.messages.map((m) => m.role), ['user']); // user->user digabung
      return sse(res, [
        ['content_block_delta', JSON.stringify({ type: 'content_block_delta', delta: { type: 'text_delta', text: 'Hai' } })],
        ['content_block_delta', JSON.stringify({ type: 'content_block_delta', delta: { type: 'text_delta', text: '!' } })],
      ]);
    }
    res.writeHead(404);
    res.end('nope');
  });
});

(async () => {
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  const oa = { kind: 'openai', baseUrl: `http://127.0.0.1:${port}/oa/v1` };
  const an = { kind: 'anthropic', baseUrl: `http://127.0.0.1:${port}/an` };

  // list model: prefix "models/" dibuang, embedding disaring, terurut
  assert.deepStrictEqual((await api.listModels(oa, { apiKey: 'good' })).map((m) => m.id), ['mock-a', 'mock-b']);
  await assert.rejects(() => api.listModels(oa, { apiKey: 'bad' }), /401.*bad key/);
  assert.deepStrictEqual((await api.listModels(an, { apiKey: 'good' })).map((m) => m.id), ['claude-x']);

  // streaming
  let got = '';
  await api.chat({ provider: oa, conf: { apiKey: 'good' }, model: 'm', system: 's', messages: [{ role: 'user', content: 'hi' }], onDelta: (d) => (got += d) });
  assert.strictEqual(got, 'Halo');
  got = '';
  await api.chat({ provider: an, conf: { apiKey: 'good' }, model: 'm', system: 'sys', messages: [{ role: 'user', content: 'a' }, { role: 'user', content: 'b' }], onDelta: (d) => (got += d) });
  assert.strictEqual(got, 'Hai!');

  // server mati -> pesan error yang ramah
  server.close();
  await assert.rejects(() => api.listModels(oa, { apiKey: 'good' }), /Tidak bisa terhubung/);

  // helper teks
  const lines = A.wrapText('satu dua tiga empat lima enam', 12, '  ');
  assert.ok(lines.every((l) => A.strWidth(l) <= 12), 'wrapText melebihi lebar');
  assert.ok(A.wrapText('x'.repeat(40), 10).every((l) => A.strWidth(l) <= 10), 'hard-split gagal');
  assert.strictEqual(A.strWidth('\x1b[1mabc\x1b[22m'), 3);
  assert.deepStrictEqual(filterItems([{ id: 'gpt-4o' }, { id: 'llama-3' }], 'lma', (m) => m.id).map((m) => m.id), ['llama-3']);
  assert.ok(md('# Judul\n- a\n```js\nconst x = 1;\n```', 40).length >= 5);

  console.log('smoke test OK');
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
