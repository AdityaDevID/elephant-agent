'use strict';

// HTTP GET dengan pagar SSRF, tanpa dependency.
// - Alamat loopback / private / link-local / metadata diblokir, kecuali user menyetujui host itu secara eksplisit
//   (link-local 169.254.x.x, fe80::/10 dan endpoint metadata cloud TIDAK PERNAH bisa diizinkan).
// - Pengecekan dilakukan di level koneksi (opsi `lookup` socket), jadi hasil DNS yang dipakai untuk konek
//   adalah hasil yang diperiksa: tahan terhadap DNS rebinding.
// - Redirect diikuti manual dan setiap hop diperiksa ulang (host baru = harus lolos pagar lagi).
const http = require('http');
const https = require('https');
const dns = require('dns');
const net = require('net');
const zlib = require('zlib');

// ---------------------------------------------------------------- klasifikasi alamat

function parseV4(s) {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(String(s));
  if (!m) return null;
  const a = m.slice(1).map(Number);
  return a.every((n) => n <= 255) ? a : null;
}

// -> array 8 angka 16-bit, atau null
function parseV6(str) {
  let s = String(str).split('%')[0].toLowerCase();
  if (!net.isIPv6(s)) return null;
  if (s.includes('.')) {
    const i = s.lastIndexOf(':');
    const v4 = parseV4(s.slice(i + 1));
    if (!v4) return null;
    s = s.slice(0, i + 1) + ((v4[0] << 8) | v4[1]).toString(16) + ':' + ((v4[2] << 8) | v4[3]).toString(16);
  }
  let parts;
  if (s.includes('::')) {
    const [h, t] = s.split('::');
    const hp = h ? h.split(':') : [];
    const tp = t ? t.split(':') : [];
    parts = [...hp, ...Array(Math.max(0, 8 - hp.length - tp.length)).fill('0'), ...tp];
  } else {
    parts = s.split(':');
  }
  const g = parts.map((x) => parseInt(x, 16));
  return g.length === 8 && g.every((n) => Number.isInteger(n) && n >= 0 && n <= 0xffff) ? g : null;
}

function classifyV4(a) {
  const [p, q] = a;
  if (p === 169 && q === 254) return { kind: 'link-local / metadata cloud', hard: true };
  if (p === 100 && q === 100 && a[2] === 100 && a[3] === 200) return { kind: 'metadata cloud', hard: true };
  if (p === 0) return { kind: 'alamat tidak valid (0.x.x.x)' };
  if (p === 127) return { kind: 'loopback (komputer ini)' };
  if (p === 10 || (p === 172 && q >= 16 && q <= 31) || (p === 192 && q === 168)) return { kind: 'jaringan private' };
  if (p === 100 && q >= 64 && q <= 127) return { kind: 'jaringan bersama (CGNAT/Tailscale)' };
  if (p === 192 && q === 0 && a[2] === 0) return { kind: 'alamat khusus IETF' };
  if ((p === 192 && q === 0 && a[2] === 2) || (p === 198 && q === 51 && a[2] === 100) || (p === 203 && q === 0 && a[2] === 113)) return { kind: 'alamat dokumentasi' };
  if (p === 198 && (q === 18 || q === 19)) return { kind: 'alamat benchmark' };
  if (p >= 224) return { kind: 'multicast / dicadangkan' };
  return null;
}

// null = alamat publik; selain itu { kind, hard? }
function classifyIp(ip) {
  const v4 = parseV4(ip);
  if (v4) return classifyV4(v4);
  const g = parseV6(ip);
  if (!g) return { kind: 'alamat tidak dikenali', hard: true };
  const v4of = (hi, lo) => [hi >> 8, hi & 255, lo >> 8, lo & 255];
  const zero5 = g.slice(0, 5).every((x) => x === 0);
  if (zero5 && g[5] === 0xffff) return classifyV4(v4of(g[6], g[7])); // ::ffff:a.b.c.d
  if (g.slice(0, 6).every((x) => x === 0) && (g[6] || g[7] > 1)) return classifyV4(v4of(g[6], g[7])) || { kind: 'IPv4-compatible' }; // ::a.b.c.d
  if (g[0] === 0x64 && g[1] === 0xff9b && g.slice(2, 6).every((x) => x === 0)) return classifyV4(v4of(g[6], g[7])); // NAT64
  if (g[0] === 0x2002) return classifyV4(v4of(g[1], g[2])) || null; // 6to4: lihat IPv4 yang ditanam
  if (g.every((x, i) => (i === 7 ? x === 1 : x === 0))) return { kind: 'loopback (komputer ini)' };
  if (g.every((x) => x === 0)) return { kind: 'alamat tidak valid (::)' };
  if ((g[0] & 0xffc0) === 0xfe80) return { kind: 'link-local', hard: true };
  if (g[0] === 0xfd00 && g[1] === 0x0ec2) return { kind: 'metadata cloud', hard: true };
  if ((g[0] & 0xfe00) === 0xfc00) return { kind: 'jaringan private (ULA)' };
  if ((g[0] & 0xff00) === 0xff00) return { kind: 'multicast' };
  if (g[0] === 0x2001 && g[1] === 0x0db8) return { kind: 'alamat dokumentasi' };
  if (g[0] === 0x2001 && g[1] === 0) return { kind: 'Teredo' };
  if ((g[0] & 0xe000) !== 0x2000) return { kind: 'bukan alamat publik (non-global)' };
  return null;
}

const HARD_NAMES = new Set(['metadata.google.internal', 'metadata', 'instance-data']);

function classifyName(host) {
  const h = host.toLowerCase().replace(/\.$/, '');
  if (HARD_NAMES.has(h)) return { kind: 'metadata cloud', hard: true };
  if (h === 'localhost' || h.endsWith('.localhost') || h === 'ip6-localhost' || h === 'ip6-loopback') return { kind: 'loopback (komputer ini)' };
  return null;
}

// ---------------------------------------------------------------- pagar

const bare = (hostname) => String(hostname).replace(/^\[|\]$/g, '');

// Kunci izin per host + port, mis. "192.168.1.5:8080". Dipakai untuk persetujuan user.
function hostKey(url) {
  return `${bare(url.hostname).toLowerCase()}:${url.port || (url.protocol === 'https:' ? 443 : 80)}`;
}

function blocked(host, key, ip, c) {
  const e = new Error(`diblokir: ${host} ${ip && ip !== host ? `(${ip}) ` : ''}adalah ${c.kind}`);
  e.code = 'ELEPHANT_BLOCKED';
  e.hostKey = key;
  e.host = host;
  e.ip = ip || host;
  e.kind = c.kind;
  e.hard = !!c.hard;
  return e;
}

// Pemeriksaan tanpa DNS: skema, IP literal, nama terlarang. Melempar error kalau ditolak.
function checkUrl(url, allowHosts) {
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error(`skema ${url.protocol} tidak didukung (hanya http/https)`);
  const host = bare(url.hostname);
  if (!host) throw new Error('URL tanpa host');
  const key = hostKey(url);
  const ok = (c) => !c || (!c.hard && allowHosts && allowHosts.has(key));
  if (net.isIP(host)) {
    const c = classifyIp(host);
    if (!ok(c)) throw blocked(host, key, host, c);
    return;
  }
  const c = classifyName(host);
  if (!ok(c)) throw blocked(host, key, null, c);
}

// Fungsi `lookup` untuk socket: periksa SEMUA alamat hasil DNS sebelum dipakai konek.
function guardedLookup(host, key, allowPrivate, resolver = dns.lookup) {
  return (hostname, options, cb) => {
    if (typeof options === 'function') { cb = options; options = {}; }
    resolver(hostname, { ...options, all: true }, (err, addrs) => {
      if (err) return cb(err);
      const list = Array.isArray(addrs) ? addrs : [{ address: addrs, family: net.isIPv6(addrs) ? 6 : 4 }];
      for (const a of list) {
        const c = classifyIp(a.address);
        if (c && !(allowPrivate && !c.hard)) return cb(blocked(host, key, a.address, c));
      }
      if (options && options.all) return cb(null, list);
      return cb(null, list[0].address, list[0].family);
    });
  };
}

// ---------------------------------------------------------------- request

function once(url, { allowPrivate, resolver, signal, timeoutMs, headers, maxBytes }) {
  return new Promise((resolve, reject) => {
    const mod = url.protocol === 'https:' ? https : http;
    const host = bare(url.hostname);
    const key = hostKey(url);
    let settled = false;
    const done = (fn, v) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', onAbort);
      fn(v);
    };
    const req = mod.request({
      hostname: host,
      port: url.port || undefined,
      path: url.pathname + url.search,
      method: 'GET',
      headers: { ...headers, host: url.host, connection: 'close' },
      agent: false,
      lookup: guardedLookup(host, key, allowPrivate, resolver),
    }, (res) => {
      const status = res.statusCode;
      const loc = res.headers.location;
      if ([301, 302, 303, 307, 308].includes(status) && loc) {
        res.resume();
        return done(resolve, { status, headers: res.headers, redirect: loc });
      }
      let stream = res;
      const enc = String(res.headers['content-encoding'] || '').toLowerCase();
      if (enc === 'gzip' || enc === 'x-gzip') stream = res.pipe(zlib.createGunzip());
      else if (enc === 'deflate') stream = res.pipe(zlib.createInflate());
      else if (enc === 'br') stream = res.pipe(zlib.createBrotliDecompress());
      const chunks = [];
      let size = 0;
      let truncated = false;
      stream.on('data', (c) => {
        if (truncated) return;
        size += c.length;
        if (size > maxBytes) {
          chunks.push(c.subarray(0, c.length - (size - maxBytes)));
          truncated = true;
          res.destroy();
          return done(resolve, { status, headers: res.headers, body: Buffer.concat(chunks), truncated });
        }
        chunks.push(c);
      });
      stream.on('end', () => done(resolve, { status, headers: res.headers, body: Buffer.concat(chunks), truncated }));
      stream.on('error', (e) => { if (!truncated) done(reject, e); });
      res.on('error', (e) => { if (!truncated) done(reject, e); });
    });
    const timer = setTimeout(() => {
      const e = new Error(`timeout setelah ${timeoutMs / 1000} detik`);
      e.name = 'TimeoutError';
      req.destroy(e);
      done(reject, e);
    }, timeoutMs);
    const onAbort = () => {
      const e = new Error('Dibatalkan');
      e.name = 'AbortError';
      req.destroy(e);
      done(reject, e);
    };
    if (signal) {
      if (signal.aborted) return onAbort();
      signal.addEventListener('abort', onAbort, { once: true });
    }
    req.on('error', (e) => done(reject, e));
    req.end();
  });
}

// GET dengan pagar SSRF. allowHosts = Set kunci "host:port" yang sudah disetujui user (hanya non-hard).
async function safeGet(startUrl, opts = {}) {
  const { allowHosts = new Set(), signal, timeoutMs = 20000, maxBytes = 2 * 1024 * 1024, maxRedirects = 5, resolver, headers = {} } = opts;
  let url = new URL(startUrl);
  for (let hop = 0; ; hop++) {
    checkUrl(url, allowHosts); // host baru setelah redirect juga harus lolos
    const r = await once(url, { allowPrivate: allowHosts.has(hostKey(url)), resolver, signal, timeoutMs, headers, maxBytes });
    if (r.redirect) {
      if (hop >= maxRedirects) throw new Error(`terlalu banyak redirect (lebih dari ${maxRedirects})`);
      url = new URL(r.redirect, url);
      continue;
    }
    return { ...r, url: url.href, redirects: hop };
  }
}

module.exports = { classifyIp, classifyName, checkUrl, guardedLookup, hostKey, safeGet, parseV6 };
