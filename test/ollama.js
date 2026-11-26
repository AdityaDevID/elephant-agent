'use strict';

// Tes perbaikan Ollama lokal: normalisasi Base URL, fallback localhost -> 127.0.0.1, daftar model lewat /api/tags,
// pesan error yang membantu, dan model tanpa dukungan tool.
const http = require('http');
const assert = require('assert');
const api = require('../src/api');
const { getProvider, ollamaBase } = require('../src/providers');
const context = require('../src/context');

const ollama = getProvider('ollama');

function sse(res, chunks) {
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  for (const c of chunks) res.write(`data: ${JSON.stringify(c)}\n\n`);
  res.write('data: [DONE]\n\n');
  res.end();
}

function mockOllama({ v1Models = true, models = ['llama3.2:latest', 'nomic-embed-text:latest'], noTools = false } = {}) {
  return http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      if (req.url === '/v1/models' && v1Models) {
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ object: 'list', data: models.map((id) => ({ id })) }));
      }
      if (req.url === '/api/tags') {
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ models: models.map((name) => ({ name })) }));
      }
      if (req.url === '/v1/chat/completions') {
        const j = JSON.parse(body);
        if (noTools && j.tools) {
          res.writeHead(400, { 'content-type': 'application/json' });
          return res.end(JSON.stringify({ error: { message: 'registry.ollama.ai/library/gemma:2b does not support tools' } }));
        }
        if (j.model === 'ghost') {
          res.writeHead(404, { 'content-type': 'application/json' });
          return res.end(JSON.stringify({ error: { message: "model 'ghost' not found, try pulling it first" } }));
        }
        return sse(res, [{ choices: [{ delta: { content: 'ha' } }] }, { choices: [{ delta: { content: 'lo' } }] }]);
      }
      res.writeHead(404);
      return res.end('404 page not found');
    });
  });
}

const listen = (srv) => new Promise((r) => srv.listen(0, '127.0.0.1', r));

(async () => {
  // normalisasi base URL
  const n = (u) => api.normalizeBase(ollama, u);
  assert.strictEqual(n('http://localhost:11434'), 'http://localhost:11434/v1');
  assert.strictEqual(n('localhost:11434'), 'http://localhost:11434/v1');
  assert.strictEqual(n('http://localhost:11434/'), 'http://localhost:11434/v1');
  assert.strictEqual(n('http://localhost:11434/v1/'), 'http://localhost:11434/v1');
  assert.strictEqual(n('http://localhost:11434/api'), 'http://localhost:11434/v1');
  assert.strictEqual(n('http://0.0.0.0:11434'), 'http://127.0.0.1:11434/v1');
  assert.strictEqual(n('https://ollama.example.com'), 'https://ollama.example.com/v1');
  assert.strictEqual(api.normalizeBase({ id: 'custom' }, '127.0.0.1:8000/v1'), 'http://127.0.0.1:8000/v1'); // custom: tambah scheme saja
  assert.strictEqual(api.normalizeBase({ id: 'custom' }, 'http://x/y'), 'http://x/y'); // jangan paksa /v1
  assert.deepStrictEqual(api.localhostAlternatives('http://localhost:11434/v1'), ['http://127.0.0.1:11434/v1', 'http://[::1]:11434/v1']);
  assert.deepStrictEqual(api.localhostAlternatives('http://127.0.0.1:1/v1'), []);

  // default OLLAMA_HOST
  const saved = process.env.OLLAMA_HOST;
  delete process.env.OLLAMA_HOST;
  assert.strictEqual(ollamaBase(), 'http://127.0.0.1:11434/v1');
  process.env.OLLAMA_HOST = '0.0.0.0:11500';
  assert.strictEqual(ollamaBase(), 'http://127.0.0.1:11500/v1');
  process.env.OLLAMA_HOST = 'http://192.168.1.5';
  assert.strictEqual(ollamaBase(), 'http://192.168.1.5:11434/v1');
  if (saved === undefined) delete process.env.OLLAMA_HOST; else process.env.OLLAMA_HOST = saved;

  // jendela konteks kecil untuk Ollama (kecuali diatur manual)
  assert.strictEqual(context.windowFor('llama3.1:8b', undefined, 'ollama'), 8000);
  assert.strictEqual(context.windowFor('llama3.1:8b', 32000, 'ollama'), 32000);
  assert.strictEqual(context.windowFor('gpt-4o', undefined, 'openai'), 128000);

  // 1) Base URL tanpa /v1 + "localhost" -> tetap tersambung (server hanya di 127.0.0.1)
  const s1 = mockOllama();
  await listen(s1);
  const port = s1.address().port;
  let list = await api.listModels(ollama, { baseUrl: `http://localhost:${port}` });
  assert.deepStrictEqual(list.map((m) => m.id), ['llama3.2:latest']); // embedding disaring
  let got = '';
  await api.chat({ provider: ollama, conf: { baseUrl: `localhost:${port}` }, model: 'llama3.2', system: 's', messages: [{ role: 'user', content: 'hi' }], onDelta: (d) => (got += d) });
  assert.strictEqual(got, 'halo');

  // 2) model tidak ada -> petunjuk ollama pull
  await assert.rejects(
    () => api.chat({ provider: ollama, conf: { baseUrl: `http://127.0.0.1:${port}` }, model: 'ghost', messages: [{ role: 'user', content: 'x' }], onDelta() {} }),
    /ollama pull/
  );

  // 3) model tanpa dukungan tool -> flag noTools
  const s3 = mockOllama({ noTools: true });
  await listen(s3);
  await assert.rejects(
    () => api.chat({ provider: ollama, conf: { baseUrl: `http://127.0.0.1:${s3.address().port}` }, model: 'gemma:2b', messages: [{ role: 'user', content: 'x' }], tools: [{ name: 't', description: 'd', parameters: { type: 'object', properties: {} } }], onDelta() {} }),
    (e) => e.noTools === true && e.status === 400
  );
  s3.close();

  // 4) Ollama lama: /v1/models tidak ada -> pakai /api/tags
  const s4 = mockOllama({ v1Models: false });
  await listen(s4);
  list = await api.listModels(ollama, { baseUrl: `http://127.0.0.1:${s4.address().port}/v1` });
  assert.deepStrictEqual(list.map((m) => m.id), ['llama3.2:latest']);
  s4.close();

  // 5) belum ada model sama sekali -> pesan jelas
  const s5 = mockOllama({ models: [] });
  await listen(s5);
  await assert.rejects(() => api.listModels(ollama, { baseUrl: `http://127.0.0.1:${s5.address().port}` }), /belum ada model.*ollama pull/);
  s5.close();

  // 6) Ollama tidak jalan -> petunjuk "ollama serve"
  const dead = http.createServer();
  await listen(dead);
  const deadPort = dead.address().port;
  await new Promise((r) => dead.close(r));
  await assert.rejects(() => api.listModels(ollama, { baseUrl: `http://localhost:${deadPort}` }), /ollama serve/);
  await assert.rejects(() => api.chat({ provider: ollama, conf: { baseUrl: `http://localhost:${deadPort}` }, model: 'm', messages: [{ role: 'user', content: 'x' }], onDelta() {} }), /ollama serve/);

  // 7) Simulasi masalah klasik: "localhost" -> ::1 ditolak (ECONNREFUSED), 127.0.0.1 hidup
  const realFetch = global.fetch;
  const tried = [];
  global.fetch = async (url, opts) => {
    tried.push(String(url));
    if (/\/\/localhost/.test(String(url)) || /\/\/\[::1\]/.test(String(url))) {
      const e = new TypeError('fetch failed');
      e.cause = Object.assign(new Error('connect ECONNREFUSED ::1:11434'), { code: 'ECONNREFUSED' });
      throw e;
    }
    return realFetch(String(url).replace('11434', String(port)), opts);
  };
  try {
    list = await api.listModels(ollama, { baseUrl: 'http://localhost:11434' });
    assert.deepStrictEqual(list.map((m) => m.id), ['llama3.2:latest']);
    assert.ok(tried[0].includes('//localhost') && tried.some((u) => u.includes('//127.0.0.1')), tried.join(' | '));
  } finally {
    global.fetch = realFetch;
  }

  s1.close();
  console.log('ollama test OK');
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
