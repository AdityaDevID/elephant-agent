'use strict';

// Akses GitHub lewat Personal Access Token (PAT): klien REST + tool untuk agent. Tanpa dependency.
// - Token disimpan di config (chmod 600) atau dibaca dari env; tidak pernah dikirim ke provider AI.
// - Token hanya dikirim ke api.github.com (path harus diawali "/", URL penuh ditolak).
// - Rate limit (primary & secondary) dan jaringan putus ditunggu lalu dilanjutkan otomatis.
// - Kalau token tidak punya izin untuk suatu aksi, error menjelaskan izin apa yang kurang supaya agent bisa bilang.

const fs = require('fs');
const path = require('path');
const config = require('./config');

const UA = 'elephant-agent';
const TOKEN_RE = /\b(gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/g;
const MASK = '[token-disembunyikan]';

const apiBase = () => String(process.env.ELEPHANT_GITHUB_API || 'https://api.github.com').replace(/\/+$/, '');

// ---------------------------------------------------------------- token

// Disimpan di ~/.elephant-agent/github.json (chmod 600), terpisah dari config.json.
function readStore() {
  try { return JSON.parse(fs.readFileSync(config.githubFile(), 'utf8')) || {}; } catch { return {}; }
}

function writeStore(o) {
  fs.mkdirSync(config.dir(), { recursive: true, mode: 0o700 });
  const f = config.githubFile();
  const tmp = f + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(o, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, f);
}

let tokenCache = { v: '', at: 0 };

function getToken() {
  const now = Date.now();
  if (now - tokenCache.at < 1000) return tokenCache.v;
  let v = readStore().token || '';
  if (!v) v = process.env.ELEPHANT_GITHUB_TOKEN || process.env.GITHUB_TOKEN || process.env.GH_TOKEN || '';
  tokenCache = { v: String(v).trim(), at: now };
  return tokenCache.v;
}

function setToken(token) {
  const o = readStore();
  const t = String(token || '').trim();
  if (t) o.token = t; else delete o.token;
  writeStore(o);
  tokenCache = { v: '', at: 0 };
}

function clearToken() {
  setToken('');
}

const hasToken = () => !!getToken();

function tokenKind(t) {
  if (/^github_pat_/.test(t)) return 'fine-grained';
  if (/^ghp_/.test(t)) return 'classic';
  if (/^gh[ousr]_/.test(t)) return 'oauth/app';
  return 'tidak dikenal';
}

// Sembunyikan token (dan bentuk base64 untuk header git) dari teks apa pun yang akan dilihat model / ditulis ke log.
function redact(text) {
  let s = String(text == null ? '' : text);
  s = s.replace(TOKEN_RE, MASK);
  const t = getToken();
  if (t && t.length >= 8) {
    s = s.split(t).join(MASK);
    s = s.split(Buffer.from('x-access-token:' + t).toString('base64')).join(MASK);
  }
  return s;
}

// Env tambahan agar `git` (clone/push ke github.com) dan `gh` memakai token tanpa menulisnya ke file/URL.
function gitEnv(command) {
  const t = getToken();
  const out = {};
  if (!t) return out;
  const cmd = String(command || '');
  const cfgOff = readStore().gitAuth === false;
  if (/\bgit\b/.test(cmd) && !cfgOff) {
    const n = parseInt(process.env.GIT_CONFIG_COUNT || '0', 10) || 0;
    out.GIT_CONFIG_COUNT = String(n + 1);
    out[`GIT_CONFIG_KEY_${n}`] = 'http.https://github.com/.extraheader';
    out[`GIT_CONFIG_VALUE_${n}`] = 'AUTHORIZATION: basic ' + Buffer.from('x-access-token:' + t).toString('base64');
  }
  if (/\bgh\b/.test(cmd)) out.GH_TOKEN = t;
  return out;
}

// ---------------------------------------------------------------- HTTP

class GhError extends Error {
  constructor(message, extra = {}) {
    super(message);
    this.name = 'GhError';
    Object.assign(this, extra);
  }
}

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    const abort = () => { const e = new Error('Dibatalkan'); e.name = 'AbortError'; return e; };
    if (signal && signal.aborted) return reject(abort());
    const t = setTimeout(() => { if (signal) signal.removeEventListener('abort', onAbort); resolve(); }, ms);
    const onAbort = () => { clearTimeout(t); reject(abort()); };
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
  });
}

function fmtWait(ms) {
  const s = Math.ceil(ms / 1000);
  if (s < 90) return `${s} detik`;
  const m = Math.round(s / 60);
  return m < 90 ? `${m} menit` : `${Math.round(m / 60)} jam`;
}

function validPath(p) {
  return typeof p === 'string' && p.startsWith('/') && !p.startsWith('//') && !/^\/+[a-z][a-z0-9+.-]*:/i.test(p) && !/[\r\n]/.test(p) && !p.includes('..');
}

const rateInfo = { limit: null, remaining: null, resetAt: null };

function noteRate(h) {
  const n = (k) => { const v = parseInt(h.get(k), 10); return Number.isFinite(v) ? v : null; };
  const limit = n('x-ratelimit-limit');
  if (limit != null) { rateInfo.limit = limit; rateInfo.remaining = n('x-ratelimit-remaining'); const r = n('x-ratelimit-reset'); rateInfo.resetAt = r ? r * 1000 : null; }
}

function apiMessage(text) {
  try {
    const j = JSON.parse(text);
    let m = j.message || '';
    if (Array.isArray(j.errors) && j.errors.length) {
      m += ' (' + j.errors.map((e) => (typeof e === 'string' ? e : e.message || [e.resource, e.field, e.code].filter(Boolean).join(' '))).join('; ') + ')';
    }
    return String(m || text).slice(0, 400);
  } catch {
    return String(text || '').replace(/\s+/g, ' ').slice(0, 300);
  }
}

// Seberapa lama harus menunggu karena rate limit? null kalau ini bukan rate limit.
function rateLimitWait(status, headers, bodyText) {
  if (status !== 403 && status !== 429) return null;
  const ra = parseFloat(headers.get('retry-after'));
  const remaining = headers.get('x-ratelimit-remaining');
  const reset = parseInt(headers.get('x-ratelimit-reset'), 10);
  const looksLimited = Number.isFinite(ra) || remaining === '0' || /rate limit|abuse|secondary/i.test(bodyText || '');
  if (!looksLimited) return null;
  if (Number.isFinite(ra)) return Math.max(1000, Math.round(ra * 1000) + 500);
  if (remaining === '0' && Number.isFinite(reset)) return Math.max(1000, reset * 1000 - Date.now() + 1500);
  return 60000; // secondary rate limit tanpa petunjuk: tunggu semenit
}

function describeFailure(status, headers, bodyText) {
  const msg = apiMessage(bodyText);
  if (status === 401) {
    return { code: 'AUTH', message: `Token GitHub ditolak (HTTP 401: ${msg}). Token salah, kedaluwarsa, atau dicabut. Beri tahu pengguna untuk membuat token baru lalu jalankan /github (atau "elephant github login").` };
  }
  if (status === 403) {
    const need = headers.get('x-accepted-github-permissions');
    const have = headers.get('x-oauth-scopes');
    let m = `GitHub menolak aksi ini (HTTP 403: ${msg}).`;
    if (need) m += ` Izin yang dibutuhkan endpoint ini: ${need}.`;
    if (have != null) m += ` Scope token sekarang: ${have || '(kosong)'}.`;
    else m += ' Token ini fine-grained: izin per repo diatur di pengaturan token.';
    m += ' Beri tahu pengguna izin/akses apa yang perlu ditambahkan ke token (atau repo/organisasi apa yang perlu di-grant), jangan mencoba cara lain untuk menembusnya.';
    return { code: 'FORBIDDEN', message: m };
  }
  if (status === 404) {
    return { code: 'NOT_FOUND', message: `Tidak ditemukan (HTTP 404: ${msg}). Bisa juga karena token tidak punya akses ke repo/organisasi ini: GitHub menyamarkan akses ditolak sebagai 404. Kalau nama repo sudah benar, beri tahu pengguna untuk menambahkan repo tersebut ke akses token.` };
  }
  if (status === 409) return { code: 'CONFLICT', message: `Konflik (HTTP 409: ${msg}). Biasanya sha file sudah berubah atau repo kosong; baca ulang lalu coba lagi.` };
  if (status === 422) return { code: 'INVALID', message: `GitHub menolak data yang dikirim (HTTP 422: ${msg}).` };
  return { code: 'HTTP', message: `GitHub error HTTP ${status}: ${msg}` };
}

// request(method, path, opts) -> { data, status, headers, text }
// opts: body, query, signal, accept, raw, onWait({kind, waitMs, reason}), maxWaitMs (default 2 menit), persistent (ulangi tanpa batas kalau jaringan putus)
async function request(method, path, opts = {}) {
  const token = getToken();
  if (!token) throw new GhError('Token GitHub belum diset. Beri tahu pengguna untuk menjalankan /github (di chat) atau "elephant github login" di terminal.', { code: 'NO_TOKEN' });
  if (!validPath(path)) throw new GhError(`Path GitHub tidak valid: ${String(path).slice(0, 80)} (harus diawali "/", mis. /repos/owner/repo)`, { code: 'BAD_PATH' });
  const maxWaitMs = opts.maxWaitMs != null ? opts.maxWaitMs : 120000;
  let url = apiBase() + path;
  if (opts.query) {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(opts.query)) if (v !== undefined && v !== null && v !== '') qs.set(k, String(v));
    const q = qs.toString();
    if (q) url += (url.includes('?') ? '&' : '?') + q;
  }
  const headers = {
    Authorization: `Bearer ${token}`,
    Accept: opts.accept || 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': UA,
  };
  let body;
  if (opts.body !== undefined) { body = JSON.stringify(opts.body); headers['Content-Type'] = 'application/json'; }

  let netTries = 0;
  let serverTries = 0;
  let limitTries = 0;
  for (;;) {
    let res;
    let timedOut = false;
    const ctl = new AbortController();
    const timer = setTimeout(() => { timedOut = true; ctl.abort(); }, 30000);
    const onAbort = () => ctl.abort();
    if (opts.signal) { if (opts.signal.aborted) ctl.abort(); else opts.signal.addEventListener('abort', onAbort, { once: true }); }
    try {
      res = await fetch(url, { method, headers, body, signal: ctl.signal });
    } catch (e) {
      clearTimeout(timer);
      if (opts.signal) opts.signal.removeEventListener('abort', onAbort);
      if (opts.signal && opts.signal.aborted) { const a = new Error('Dibatalkan'); a.name = 'AbortError'; throw a; }
      netTries++;
      const limit = opts.persistent ? Infinity : 4;
      if (netTries > limit) throw new GhError(`Tidak bisa terhubung ke GitHub (${timedOut ? 'timeout' : (e && e.cause && e.cause.code) || (e && e.message) || 'jaringan'}).`, { code: 'NETWORK' });
      const wait = Math.min(60000, 1000 * 2 ** Math.min(netTries, 6));
      if (opts.onWait) opts.onWait({ kind: 'network', waitMs: wait, reason: 'koneksi ke GitHub putus' });
      await sleep(wait, opts.signal);
      continue;
    }
    clearTimeout(timer);
    if (opts.signal) opts.signal.removeEventListener('abort', onAbort);
    noteRate(res.headers);

    let text = '';
    try { text = await res.text(); } catch { /* body gagal dibaca */ }

    if (res.ok) {
      let data = null;
      if (!opts.raw && text) { try { data = JSON.parse(text); } catch { data = null; } }
      return { data, status: res.status, headers: res.headers, text };
    }

    const wait = rateLimitWait(res.status, res.headers, text);
    if (wait != null) {
      limitTries++;
      if (wait <= maxWaitMs && limitTries <= 8) {
        if (opts.onWait) opts.onWait({ kind: 'rate_limit', waitMs: wait, reason: 'rate limit GitHub' });
        await sleep(wait, opts.signal);
        continue;
      }
      throw new GhError(`Rate limit GitHub kena. Server minta menunggu ${fmtWait(wait)}${rateInfo.resetAt ? ` (reset ${new Date(rateInfo.resetAt).toLocaleTimeString()})` : ''}; terlalu lama untuk ditunggu di sini. Coba lagi nanti.`, { code: 'RATE_LIMIT', waitMs: wait, status: res.status });
    }
    if (res.status >= 500 && res.status !== 501) {
      serverTries++;
      if (serverTries <= (opts.persistent ? 12 : 3)) {
        const w = Math.min(60000, 1000 * 2 ** serverTries);
        if (opts.onWait) opts.onWait({ kind: 'server', waitMs: w, reason: `GitHub error ${res.status}` });
        await sleep(w, opts.signal);
        continue;
      }
    }
    const f = describeFailure(res.status, res.headers, text);
    throw new GhError(f.message, { code: f.code, status: res.status });
  }
}

// ---------------------------------------------------------------- helper tool

const REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

function repoArg(args) {
  const r = String((args && args.repo) || '').trim().replace(/^https?:\/\/github\.com\//i, '').replace(/\.git$/i, '').replace(/\/+$/, '');
  if (!REPO_RE.test(r)) throw new GhError('argumen "repo" harus berbentuk owner/nama, mis. AdityaDevID/elephant-agent');
  return r;
}

function reqStr(args, key) {
  const v = args && args[key];
  if (typeof v !== 'string' || !v.trim()) throw new GhError(`argumen "${key}" wajib berupa string`);
  return v;
}

const optStr = (args, key) => (typeof args[key] === 'string' && args[key].trim() ? args[key].trim() : undefined);
const lim = (v, def, max) => { const n = Math.floor(Number(v)); return Number.isFinite(n) && n > 0 ? Math.min(n, max) : def; };
const enc = (p) => String(p).split('/').map(encodeURIComponent).join('/');
const clip = (s, n) => { s = String(s == null ? '' : s); return s.length > n ? s.slice(0, n) + `\n[... dipotong, ${s.length - n} karakter lagi]` : s; };
const day = (iso) => (iso ? String(iso).slice(0, 10) : '');
const one = (s) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim();

async function defaultBranch(repo, ro) {
  const { data } = await request('GET', `/repos/${repo}`, ro);
  return data.default_branch;
}

function reqOpts(ctx) {
  return { signal: ctx && ctx.signal, onWait: ctx && ctx.onWait, persistent: !!(ctx && ctx.persistent), maxWaitMs: ctx && ctx.maxWaitMs };
}

// ---------------------------------------------------------------- definisi tool

const repoProp = { type: 'string', description: 'Repository as owner/name, e.g. AdityaDevID/elephant-agent.' };

const DEFS = [
  {
    name: 'gh_whoami', risk: 'read',
    description: 'Check the GitHub token: returns the account it belongs to, token type, scopes and remaining API rate limit. Use it first when unsure what the token can do.',
    parameters: { type: 'object', properties: {} },
  },
  {
    name: 'gh_repo_info', risk: 'read',
    description: 'Show a repository: default branch, visibility, and what the token is allowed to do there (admin/push/pull).',
    parameters: { type: 'object', properties: { repo: repoProp }, required: ['repo'] },
  },
  {
    name: 'gh_list_repos', risk: 'read',
    description: "List repositories. Without owner: the token owner's repos (including private). With owner: that user's/org's repos. Optional query searches by name.",
    parameters: { type: 'object', properties: { owner: { type: 'string', description: 'User or organization.' }, query: { type: 'string', description: 'Search text.' }, limit: { type: 'integer', description: 'Max results (default 30, max 100).' } } },
  },
  {
    name: 'gh_read', risk: 'read',
    description: 'Read a file or list a directory in a repository on GitHub (without cloning). Files include their sha.',
    parameters: { type: 'object', properties: { repo: repoProp, path: { type: 'string', description: 'File or folder path (empty = repo root).' }, ref: { type: 'string', description: 'Branch, tag or commit (default: default branch).' }, max_chars: { type: 'integer', description: 'Max characters of a file to return (default 20000, max 50000).' } }, required: ['repo'] },
  },
  {
    name: 'gh_write_file', risk: 'write',
    description: 'Create or update ONE file in a repository through the GitHub API (makes a commit). Creates/updates automatically; the branch must already exist. For many files or builds, use git via run_command instead.',
    parameters: { type: 'object', properties: { repo: repoProp, path: { type: 'string' }, content: { type: 'string', description: 'Full new file content.' }, message: { type: 'string', description: 'Commit message.' }, branch: { type: 'string', description: 'Target branch (default: default branch).' } }, required: ['repo', 'path', 'content', 'message'] },
  },
  {
    name: 'gh_delete_file', risk: 'write',
    description: 'Delete one file from a repository (makes a commit).',
    parameters: { type: 'object', properties: { repo: repoProp, path: { type: 'string' }, message: { type: 'string' }, branch: { type: 'string' } }, required: ['repo', 'path', 'message'] },
  },
  {
    name: 'gh_create_branch', risk: 'write',
    description: 'Create a new branch from another branch (default: the default branch).',
    parameters: { type: 'object', properties: { repo: repoProp, branch: { type: 'string', description: 'New branch name.' }, from: { type: 'string', description: 'Source branch (default: default branch).' } }, required: ['repo', 'branch'] },
  },
  {
    name: 'gh_create_pr', risk: 'write',
    description: 'Open a pull request.',
    parameters: { type: 'object', properties: { repo: repoProp, title: { type: 'string' }, head: { type: 'string', description: 'Branch with the changes (or user:branch for forks).' }, base: { type: 'string', description: 'Branch to merge into (default: default branch).' }, body: { type: 'string' }, draft: { type: 'boolean' } }, required: ['repo', 'title', 'head'] },
  },
  {
    name: 'gh_merge_pr', risk: 'write',
    description: 'Merge a pull request. Always needs explicit user approval.',
    parameters: { type: 'object', properties: { repo: repoProp, number: { type: 'integer' }, method: { type: 'string', enum: ['merge', 'squash', 'rebase'] } }, required: ['repo', 'number'] },
  },
  {
    name: 'gh_list_issues', risk: 'read',
    description: 'List issues and/or pull requests of a repository.',
    parameters: { type: 'object', properties: { repo: repoProp, kind: { type: 'string', enum: ['issues', 'pulls', 'all'], description: 'Default issues.' }, state: { type: 'string', enum: ['open', 'closed', 'all'] }, labels: { type: 'string', description: 'Comma-separated labels.' }, limit: { type: 'integer', description: 'Default 20, max 100.' } }, required: ['repo'] },
  },
  {
    name: 'gh_get_issue', risk: 'read',
    description: 'Read one issue or pull request (body and recent comments).',
    parameters: { type: 'object', properties: { repo: repoProp, number: { type: 'integer' } }, required: ['repo', 'number'] },
  },
  {
    name: 'gh_create_issue', risk: 'write',
    description: 'Create an issue.',
    parameters: { type: 'object', properties: { repo: repoProp, title: { type: 'string' }, body: { type: 'string' }, labels: { type: 'array', items: { type: 'string' } } }, required: ['repo', 'title'] },
  },
  {
    name: 'gh_comment', risk: 'write',
    description: 'Add a comment to an issue or pull request.',
    parameters: { type: 'object', properties: { repo: repoProp, number: { type: 'integer' }, body: { type: 'string' } }, required: ['repo', 'number', 'body'] },
  },
  {
    name: 'gh_actions', risk: 'read',
    description: 'List recent GitHub Actions workflow runs (status, conclusion, branch).',
    parameters: { type: 'object', properties: { repo: repoProp, workflow: { type: 'string', description: 'Workflow file name or id (optional).' }, branch: { type: 'string' }, limit: { type: 'integer', description: 'Default 10, max 50.' } }, required: ['repo'] },
  },
  {
    name: 'gh_search_code', risk: 'read',
    description: 'Search code on GitHub. Use qualifiers like repo:owner/name, user:, language:, path:.',
    parameters: { type: 'object', properties: { query: { type: 'string' }, limit: { type: 'integer', description: 'Default 15, max 50.' } }, required: ['query'] },
  },
  {
    name: 'gh_api', risk: 'write',
    description: 'Generic GitHub REST API call for anything the other gh_* tools do not cover (e.g. re-run a workflow, labels, releases). GET runs without asking; other methods need approval. path starts with "/", e.g. /repos/owner/repo/releases.',
    parameters: { type: 'object', properties: { method: { type: 'string', enum: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE'] }, path: { type: 'string' }, body: { type: 'object', description: 'JSON body.' }, query: { type: 'object', description: 'Query parameters.' } }, required: ['method', 'path'] },
  },
];

const NAMES = new Set(DEFS.map((d) => d.name));
const isGhTool = (name) => NAMES.has(name);

// Aksi yang dampaknya besar: selalu ditanya (juga di mode auto); di daemon ditolak kecuali --allow-dangerous.
const RISKY_PATH = /\/(transfer|collaborators|keys|hooks|secrets|variables|protection|rulesets|invitations|memberships|merge|merges|visibility|teams)(\/|$)|^\/(orgs|enterprises|admin)\b|^\/user\/(keys|gpg_keys|emails|ssh_signing_keys)/i;

function isDangerousGh(name, args) {
  if (name === 'gh_merge_pr') return true;
  if (name !== 'gh_api') return false;
  const method = String((args && args.method) || 'GET').toUpperCase();
  if (method === 'GET' || method === 'HEAD') return false;
  const p = String((args && args.path) || '').split('?')[0];
  if (method === 'DELETE') return true;
  return RISKY_PATH.test(p) || /^\/repos\/[^/]+\/[^/]+\/?$/.test(p);
}

function ghRisk(name, args, defRisk) {
  if (name === 'gh_api' && /^(GET|HEAD)$/i.test(String((args && args.method) || 'GET'))) return 'read';
  return defRisk;
}

function describe(name, a = {}) {
  const s = (v) => (v == null ? '' : String(v));
  switch (name) {
    case 'gh_whoami': return 'cek token';
    case 'gh_repo_info': return s(a.repo);
    case 'gh_list_repos': return s(a.owner || 'milik token') + (a.query ? ` "${a.query}"` : '');
    case 'gh_read': return `${s(a.repo)}:${s(a.path || '/')}` + (a.ref ? `@${a.ref}` : '');
    case 'gh_write_file': return `${s(a.repo)}:${s(a.path)} @${s(a.branch || 'default')} "${one(a.message).slice(0, 50)}"`;
    case 'gh_delete_file': return `HAPUS ${s(a.repo)}:${s(a.path)} @${s(a.branch || 'default')}`;
    case 'gh_create_branch': return `${s(a.repo)} ${s(a.branch)} dari ${s(a.from || 'default')}`;
    case 'gh_create_pr': return `${s(a.repo)} ${s(a.head)} -> ${s(a.base || 'default')}: ${one(a.title).slice(0, 50)}`;
    case 'gh_merge_pr': return `MERGE ${s(a.repo)}#${s(a.number)} (${s(a.method || 'merge')})`;
    case 'gh_list_issues': return `${s(a.repo)} ${s(a.kind || 'issues')} ${s(a.state || 'open')}`;
    case 'gh_get_issue': return `${s(a.repo)}#${s(a.number)}`;
    case 'gh_create_issue': return `${s(a.repo)}: ${one(a.title).slice(0, 60)}`;
    case 'gh_comment': return `${s(a.repo)}#${s(a.number)}: ${one(a.body).slice(0, 60)}`;
    case 'gh_actions': return s(a.repo) + (a.workflow ? ` ${a.workflow}` : '');
    case 'gh_search_code': return s(a.query);
    case 'gh_api': return `${s(a.method)} ${s(a.path)}`;
    default: return JSON.stringify(a);
  }
}

// ---------------------------------------------------------------- eksekusi tool

async function whoami(args, ctx) {
  const ro = reqOpts(ctx);
  const r = await request('GET', '/user', ro);
  const u = r.data || {};
  const t = getToken();
  const scopes = r.headers.get('x-oauth-scopes');
  const lines = [
    `Akun: ${u.login} (${u.type || 'User'})${u.name ? ' - ' + u.name : ''}`,
    `Jenis token: ${tokenKind(t)}`,
    scopes != null ? `Scope: ${scopes || '(kosong)'}` : 'Scope: fine-grained token (izin diatur per repo; cek dengan gh_repo_info)',
  ];
  if (rateInfo.limit != null) lines.push(`Rate limit: sisa ${rateInfo.remaining}/${rateInfo.limit}${rateInfo.resetAt ? `, reset ${new Date(rateInfo.resetAt).toLocaleTimeString()}` : ''}`);
  lines.push(`Email commit (noreply): ${u.id}+${u.login}@users.noreply.github.com`);
  return lines.join('\n');
}

async function repoInfo(args, ctx) {
  const repo = repoArg(args);
  const { data: d } = await request('GET', `/repos/${repo}`, reqOpts(ctx));
  const p = d.permissions || {};
  const can = ['admin', 'maintain', 'push', 'triage', 'pull'].filter((k) => p[k]).join(', ') || '(tidak diketahui)';
  return [
    `${d.full_name} ${d.private ? '[private]' : '[public]'}${d.archived ? ' [archived]' : ''}${d.fork ? ' [fork]' : ''}`,
    d.description ? `Deskripsi: ${one(d.description)}` : null,
    `Branch default: ${d.default_branch}`,
    `Izin token di repo ini: ${can}${p.push ? '' : ' (TIDAK bisa menulis)'}`,
    `Bintang: ${d.stargazers_count}  Fork: ${d.forks_count}  Issue terbuka: ${d.open_issues_count}`,
    `Diperbarui: ${day(d.pushed_at || d.updated_at)}`,
    `Clone: ${d.clone_url}`,
  ].filter(Boolean).join('\n');
}

async function listRepos(args, ctx) {
  const ro = reqOpts(ctx);
  const limit = lim(args.limit, 30, 100);
  const owner = optStr(args, 'owner');
  const query = optStr(args, 'query');
  let items;
  if (query) {
    const q = query + (owner ? ` user:${owner}` : '');
    items = (await request('GET', '/search/repositories', { ...ro, query: { q, per_page: limit } })).data.items || [];
  } else if (owner) {
    items = (await request('GET', `/users/${encodeURIComponent(owner)}/repos`, { ...ro, query: { per_page: limit, sort: 'updated' } })).data || [];
  } else {
    items = (await request('GET', '/user/repos', { ...ro, query: { per_page: limit, sort: 'updated' } })).data || [];
  }
  if (!items.length) return '(tidak ada repository)';
  return items.map((r) => `${r.full_name}${r.private ? ' [private]' : ''}  ★${r.stargazers_count}  ${day(r.pushed_at || r.updated_at)}${r.description ? '  ' + one(r.description).slice(0, 80) : ''}`).join('\n');
}

async function readRemote(args, ctx) {
  const ro = reqOpts(ctx);
  const repo = repoArg(args);
  const p = String(args.path || '').replace(/^\/+|\/+$/g, '');
  const ref = optStr(args, 'ref');
  const max = lim(args.max_chars, 20000, 50000);
  const url = `/repos/${repo}/contents${p ? '/' + enc(p) : ''}`;
  const { data } = await request('GET', url, { ...ro, query: { ref } });
  if (Array.isArray(data)) {
    return data.map((e) => `${e.type === 'dir' ? e.name + '/' : e.name}${e.type === 'file' ? `  (${e.size} B)` : ''}`).join('\n') || '(folder kosong)';
  }
  if (!data || data.type !== 'file') return `${p}: bukan file biasa (${data && data.type}).`;
  let text;
  if (data.encoding === 'base64' && typeof data.content === 'string' && data.content) {
    text = Buffer.from(data.content, 'base64').toString('utf8');
  } else {
    const raw = await request('GET', url, { ...ro, query: { ref }, accept: 'application/vnd.github.raw+json', raw: true });
    text = raw.text;
  }
  if (text.includes('\u0000')) return `${p}: file biner (${data.size} B), tidak ditampilkan.`;
  return `sha: ${data.sha}\n` + clip(text, max);
}

async function fileSha(repo, p, branch, ro) {
  try {
    const { data } = await request('GET', `/repos/${repo}/contents/${enc(p)}`, { ...ro, query: { ref: branch } });
    return data && !Array.isArray(data) ? data.sha : null;
  } catch (e) {
    if (e.code === 'NOT_FOUND') return null;
    throw e;
  }
}

async function writeRemote(args, ctx) {
  const ro = reqOpts(ctx);
  const repo = repoArg(args);
  const p = reqStr(args, 'path').replace(/^\/+/, '');
  if (typeof args.content !== 'string') throw new GhError('argumen "content" wajib berupa string');
  const message = reqStr(args, 'message');
  const branch = optStr(args, 'branch');
  const sha = await fileSha(repo, p, branch, ro);
  const body = { message, content: Buffer.from(args.content, 'utf8').toString('base64') };
  if (branch) body.branch = branch;
  if (sha) body.sha = sha;
  const { data } = await request('PUT', `/repos/${repo}/contents/${enc(p)}`, { ...ro, body });
  const c = data.commit || {};
  return `${sha ? 'Diperbarui' : 'Dibuat'}: ${repo}:${p}${branch ? ' @' + branch : ''}\nCommit: ${String(c.sha || '').slice(0, 7)} ${c.html_url || ''}`;
}

async function deleteRemote(args, ctx) {
  const ro = reqOpts(ctx);
  const repo = repoArg(args);
  const p = reqStr(args, 'path').replace(/^\/+/, '');
  const branch = optStr(args, 'branch');
  const sha = await fileSha(repo, p, branch, ro);
  if (!sha) throw new GhError(`File tidak ada: ${p}`);
  const body = { message: reqStr(args, 'message'), sha };
  if (branch) body.branch = branch;
  const { data } = await request('DELETE', `/repos/${repo}/contents/${enc(p)}`, { ...ro, body });
  return `Dihapus: ${repo}:${p}\nCommit: ${String((data.commit || {}).sha || '').slice(0, 7)}`;
}

async function createBranch(args, ctx) {
  const ro = reqOpts(ctx);
  const repo = repoArg(args);
  const name = reqStr(args, 'branch').trim();
  const from = optStr(args, 'from') || (await defaultBranch(repo, ro));
  const { data: ref } = await request('GET', `/repos/${repo}/git/ref/heads/${enc(from)}`, ro);
  await request('POST', `/repos/${repo}/git/refs`, { ...ro, body: { ref: `refs/heads/${name}`, sha: ref.object.sha } });
  return `Branch dibuat: ${name} (dari ${from}, ${ref.object.sha.slice(0, 7)})`;
}

async function createPr(args, ctx) {
  const ro = reqOpts(ctx);
  const repo = repoArg(args);
  const base = optStr(args, 'base') || (await defaultBranch(repo, ro));
  const body = { title: reqStr(args, 'title'), head: reqStr(args, 'head'), base };
  if (typeof args.body === 'string') body.body = args.body;
  if (args.draft) body.draft = true;
  const { data } = await request('POST', `/repos/${repo}/pulls`, { ...ro, body });
  return `PR #${data.number} dibuat: ${data.html_url}`;
}

async function mergePr(args, ctx) {
  const ro = reqOpts(ctx);
  const repo = repoArg(args);
  const n = lim(args.number, 0, 1e9);
  if (!n) throw new GhError('argumen "number" wajib');
  const method = ['merge', 'squash', 'rebase'].includes(args.method) ? args.method : 'merge';
  const { data } = await request('PUT', `/repos/${repo}/pulls/${n}/merge`, { ...ro, body: { merge_method: method } });
  return `${data.merged ? 'Ter-merge' : 'Tidak ter-merge'}: ${data.message || ''} (${String(data.sha || '').slice(0, 7)})`;
}

async function listIssues(args, ctx) {
  const ro = reqOpts(ctx);
  const repo = repoArg(args);
  const kind = ['issues', 'pulls', 'all'].includes(args.kind) ? args.kind : 'issues';
  const state = ['open', 'closed', 'all'].includes(args.state) ? args.state : 'open';
  const limit = lim(args.limit, 20, 100);
  const labels = optStr(args, 'labels');
  let items;
  if (kind === 'pulls') {
    items = (await request('GET', `/repos/${repo}/pulls`, { ...ro, query: { state, per_page: limit } })).data || [];
  } else {
    items = (await request('GET', `/repos/${repo}/issues`, { ...ro, query: { state, labels, per_page: limit } })).data || [];
    if (kind === 'issues') items = items.filter((i) => !i.pull_request);
  }
  if (!items.length) return '(tidak ada)';
  return items.map((i) => `#${i.number}${i.pull_request || kind === 'pulls' ? ' [PR]' : ''} ${one(i.title).slice(0, 100)} [${i.state}] @${i.user && i.user.login}${i.labels && i.labels.length ? ' {' + i.labels.map((l) => l.name).join(',') + '}' : ''} ${day(i.updated_at)}`).join('\n');
}

async function getIssue(args, ctx) {
  const ro = reqOpts(ctx);
  const repo = repoArg(args);
  const n = lim(args.number, 0, 1e9);
  if (!n) throw new GhError('argumen "number" wajib');
  const { data: i } = await request('GET', `/repos/${repo}/issues/${n}`, ro);
  const { data: cs } = await request('GET', `/repos/${repo}/issues/${n}/comments`, { ...ro, query: { per_page: 10 } });
  const lines = [`#${i.number}${i.pull_request ? ' [PR]' : ''} ${i.title} [${i.state}] oleh @${i.user && i.user.login}`, `URL: ${i.html_url}`, '', clip(i.body || '(tanpa deskripsi)', 6000)];
  for (const c of cs || []) lines.push('', `--- @${c.user && c.user.login} (${day(c.created_at)})`, clip(c.body, 2000));
  return lines.join('\n');
}

async function createIssue(args, ctx) {
  const ro = reqOpts(ctx);
  const repo = repoArg(args);
  const body = { title: reqStr(args, 'title') };
  if (typeof args.body === 'string') body.body = args.body;
  if (Array.isArray(args.labels) && args.labels.length) body.labels = args.labels.map(String);
  const { data } = await request('POST', `/repos/${repo}/issues`, { ...ro, body });
  return `Issue #${data.number} dibuat: ${data.html_url}`;
}

async function comment(args, ctx) {
  const ro = reqOpts(ctx);
  const repo = repoArg(args);
  const n = lim(args.number, 0, 1e9);
  if (!n) throw new GhError('argumen "number" wajib');
  const { data } = await request('POST', `/repos/${repo}/issues/${n}/comments`, { ...ro, body: { body: reqStr(args, 'body') } });
  return `Komentar dikirim: ${data.html_url}`;
}

async function actions(args, ctx) {
  const ro = reqOpts(ctx);
  const repo = repoArg(args);
  const wf = optStr(args, 'workflow');
  const url = wf ? `/repos/${repo}/actions/workflows/${encodeURIComponent(wf)}/runs` : `/repos/${repo}/actions/runs`;
  const { data } = await request('GET', url, { ...ro, query: { per_page: lim(args.limit, 10, 50), branch: optStr(args, 'branch') } });
  const runs = (data && data.workflow_runs) || [];
  if (!runs.length) return '(belum ada workflow run)';
  return runs.map((r) => `${r.id}  ${one(r.name)}  ${r.status}${r.conclusion ? '/' + r.conclusion : ''}  ${r.head_branch}  ${day(r.created_at)}  ${r.html_url}`).join('\n');
}

async function searchCode(args, ctx) {
  const ro = reqOpts(ctx);
  const { data } = await request('GET', '/search/code', { ...ro, query: { q: reqStr(args, 'query'), per_page: lim(args.limit, 15, 50) } });
  const items = (data && data.items) || [];
  if (!items.length) return '(tidak ada hasil)';
  return items.map((i) => `${i.repository && i.repository.full_name}:${i.path}`).join('\n');
}

async function genericApi(args, ctx) {
  const method = String(args.method || 'GET').toUpperCase();
  if (!['GET', 'POST', 'PATCH', 'PUT', 'DELETE'].includes(method)) throw new GhError('method harus GET, POST, PATCH, PUT, atau DELETE');
  const r = await request(method, reqStr(args, 'path'), { ...reqOpts(ctx), body: args.body && typeof args.body === 'object' ? args.body : undefined, query: args.query && typeof args.query === 'object' ? args.query : undefined });
  if (r.status === 204 || (!r.text && r.data == null)) return `OK (HTTP ${r.status})`;
  return clip(r.data != null ? JSON.stringify(r.data, null, 2) : r.text, 20000);
}

const EXEC = {
  gh_whoami: whoami, gh_repo_info: repoInfo, gh_list_repos: listRepos, gh_read: readRemote, gh_write_file: writeRemote,
  gh_delete_file: deleteRemote, gh_create_branch: createBranch, gh_create_pr: createPr, gh_merge_pr: mergePr,
  gh_list_issues: listIssues, gh_get_issue: getIssue, gh_create_issue: createIssue, gh_comment: comment,
  gh_actions: actions, gh_search_code: searchCode, gh_api: genericApi,
};

// Mengembalikan { content, isError } seperti tool lain. Error izin/limit jadi pesan yang bisa diteruskan agent ke pengguna.
async function execute(name, args, ctx) {
  const fn = EXEC[name];
  if (!fn) return { content: `Error: tool tidak dikenal: ${name}`, isError: true };
  try {
    return { content: await fn(args || {}, ctx || {}) };
  } catch (e) {
    if (e && e.name === 'AbortError') throw e;
    return { content: 'Error: ' + ((e && e.message) || String(e)), isError: true };
  }
}

function status() {
  const t = getToken();
  return { hasToken: !!t, kind: t ? tokenKind(t) : null };
}

module.exports = {
  DEFS, isGhTool, isDangerousGh, ghRisk, describe, execute, request, GhError,
  getToken, setToken, clearToken, hasToken, tokenKind, redact, gitEnv, status, rateInfo, apiBase, fmtWait, validPath,
};
