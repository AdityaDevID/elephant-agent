'use strict';

const readline = require('readline');
const A = require('./ansi');
const { PROVIDERS, getProvider, detectProvider } = require('./providers');
const store = require('./config');
const api = require('./api');
const logo = require('./logo');
const pkg = require('../package.json');

const ASCII = process.env.ELEPHANT_ASCII === '1' || process.argv.includes('--ascii');
const G = ASCII
  ? { tl: '+', tr: '+', bl: '+', br: '+', h: '-', v: '|', ptr: '>', bullet: '-', nl: '~', ok: 'v', x: 'x', mask: '*', spin: ['|', '/', '-', '\\'], sep: '|' }
  : { tl: '╭', tr: '╮', bl: '╰', br: '╯', h: '─', v: '│', ptr: '❯', bullet: '•', nl: '↵', ok: '✓', x: '✖', mask: '•', spin: ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'], sep: '·' };

const T = {
  accent: A.fg(208),
  accentBold: (s) => A.bold(A.fg(208)(s)),
  blue: A.fg(111),
  ok: A.fg(114),
  err: A.fg(203),
  warn: A.fg(179),
  mute: A.fg(245),
  faint: A.fg(240),
  code: A.fg(151),
};

const COMMANDS = [
  ['/help', 'bantuan & shortcut'],
  ['/provider', 'ganti provider / API key'],
  ['/model', 'ganti model'],
  ['/key', 'ganti API key provider aktif'],
  ['/system', 'atur system prompt (/system reset)'],
  ['/clear', 'bersihkan percakapan'],
  ['/exit', 'keluar'],
];

// ---------------------------------------------------------------- helpers

class Field {
  constructor(v = '') { this.set(v); }
  set(v) { this.chars = Array.from(v); this.cur = this.chars.length; }
  clear() { this.chars = []; this.cur = 0; }
  get value() { return this.chars.join(''); }
  get empty() { return this.chars.length === 0; }
  insert(s) {
    const a = Array.from(s);
    this.chars.splice(this.cur, 0, ...a);
    this.cur += a.length;
  }
  wordLeft() {
    let i = this.cur;
    while (i > 0 && /\s/.test(this.chars[i - 1])) i--;
    while (i > 0 && !/\s/.test(this.chars[i - 1])) i--;
    return i;
  }
  wordRight() {
    let i = this.cur;
    const n = this.chars.length;
    while (i < n && /\s/.test(this.chars[i])) i++;
    while (i < n && !/\s/.test(this.chars[i])) i++;
    return i;
  }
  key(str, key) {
    const n = this.chars.length;
    if (key.ctrl) {
      switch (key.name) {
        case 'a': this.cur = 0; return true;
        case 'e': this.cur = n; return true;
        case 'u': this.chars.splice(0, this.cur); this.cur = 0; return true;
        case 'k': this.chars.splice(this.cur); return true;
        case 'w': { const i = this.wordLeft(); this.chars.splice(i, this.cur - i); this.cur = i; return true; }
        case 'left': this.cur = this.wordLeft(); return true;
        case 'right': this.cur = this.wordRight(); return true;
        default: return false;
      }
    }
    switch (key.name) {
      case 'left': if (this.cur > 0) this.cur--; return true;
      case 'right': if (this.cur < n) this.cur++; return true;
      case 'home': this.cur = 0; return true;
      case 'end': this.cur = n; return true;
      case 'backspace': if (this.cur > 0) { this.chars.splice(this.cur - 1, 1); this.cur--; } return true;
      case 'delete': if (this.cur < n) this.chars.splice(this.cur, 1); return true;
      default: break;
    }
    if (str && !key.meta && str.charCodeAt(0) >= 32 && str.charCodeAt(0) !== 127) {
      this.insert(str);
      return true;
    }
    return false;
  }
}

function inputView(chars, cur, width) {
  let start = cur;
  let w = 0;
  while (start > 0) {
    const cw = Math.max(1, A.charWidth(chars[start - 1].codePointAt(0)));
    if (w + cw > width - 1) break;
    w += cw;
    start--;
  }
  let out = '';
  let used = 0;
  for (let i = start; i <= chars.length; i++) {
    const atEnd = i === chars.length;
    const ch = atEnd ? ' ' : chars[i];
    const cw = atEnd ? 1 : Math.max(1, A.charWidth(ch.codePointAt(0)));
    if (used + cw > width) break;
    out += i === cur ? A.inv(ch) : ch;
    used += cw;
  }
  return { out, used };
}

function subseq(t, q) {
  let j = 0;
  for (let i = 0; i < t.length && j < q.length; i++) if (t[i] === q[j]) j++;
  return j === q.length;
}

function filterItems(items, q, textOf) {
  const toks = q.toLowerCase().split(/\s+/).filter(Boolean);
  if (!toks.length) return items;
  const scored = [];
  for (const it of items) {
    const t = textOf(it).toLowerCase();
    if (toks.every((k) => t.includes(k))) scored.push([t.indexOf(toks[0]), it]);
  }
  if (scored.length) {
    scored.sort((a, b) => a[0] - b[0]);
    return scored.map((x) => x[1]);
  }
  const compact = toks.join('');
  return items.filter((it) => subseq(textOf(it).toLowerCase(), compact));
}

function listWindow(total, sel, rows) {
  const start = Math.max(0, Math.min(sel - Math.floor(rows / 2), total - rows));
  return [start, Math.min(total, start + rows)];
}

function inline(s) {
  return s
    .replace(/`([^`\n]+)`/g, (_, c) => T.code(c))
    .replace(/\*\*([^*\n]+)\*\*/g, (_, b) => A.bold(b));
}

// Markdown ringan -> baris berwarna (heading, bullet, code fence, `inline`, **bold**).
function md(text, width) {
  const out = [];
  let code = false;
  const cw = Math.max(8, width - 6);
  for (const raw of text.split('\n')) {
    const fence = raw.match(/^\s*```\s*([\w+#.-]*)/);
    if (fence) {
      code = !code;
      out.push('  ' + T.faint(code ? G.tl + G.h + ' ' : G.bl + G.h) + (code ? T.mute(fence[1] || 'code') : ''));
      continue;
    }
    if (code || /^\s*\|.*\|\s*$/.test(raw)) {
      let s = raw.replace(/\t/g, '  ');
      const prefix = '  ' + T.faint(code ? G.v + ' ' : '  ');
      if (!s) { out.push(code ? '  ' + T.faint(G.v) : ''); continue; }
      while (A.strWidth(s) > cw) {
        const [h, t] = A.splitAt(s, cw);
        out.push(prefix + T.code(h));
        s = t;
      }
      out.push(prefix + T.code(s));
      continue;
    }
    let m;
    if ((m = raw.match(/^(#{1,6})\s+(.*)$/))) {
      out.push(...A.wrapText(T.accentBold(m[2].replace(/\*\*|`/g, '')), width - 2, '  '));
    } else if ((m = raw.match(/^(\s*)[-*+]\s+(.*)$/))) {
      const ind = '  ' + ' '.repeat(m[1].length);
      out.push(...A.wrapText(inline(m[2]), width - 2, ind + T.accent(G.bullet) + ' ', ind + '  '));
    } else if ((m = raw.match(/^(\s*)(\d+[.)])\s+(.*)$/))) {
      const ind = '  ' + ' '.repeat(m[1].length);
      out.push(...A.wrapText(inline(m[3]), width - 2, ind + T.accent(m[2]) + ' ', ind + ' '.repeat(m[2].length + 1)));
    } else if (!raw.trim()) {
      out.push('');
    } else {
      out.push(...A.wrapText(inline(raw), width - 2, '  '));
    }
  }
  return out;
}

// ---------------------------------------------------------------- app

class App {
  constructor() {
    this.cfg = store.load();
    this.screen = 'providers';
    this.back = null;
    this.ps = { field: new Field(''), sel: 0 };
    this.ms = null;
    this.form = null;
    this.chat = { field: new Field(''), history: [], hist: -1, draft: '', scroll: 0, showLogo: true };
    this.messages = [];
    this.busy = false;
    this.ctrl = null;
    this.tick = 0;
    this.spinTimer = null;
    this.flash = null;
    this.flashTimer = null;
    this.pasting = false;
    this.quitArm = 0;
    this.opId = 0;
    this.restored = false;
  }

  // ------------------------------------------------------------ lifecycle
  start() {
    const out = process.stdout;
    out.write('\x1b[?1049h\x1b[?25l\x1b[?2004h');
    readline.emitKeypressEvents(process.stdin);
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.on('keypress', (s, k) => {
      try { this.onKey(s, k || {}); } catch (e) { this.setFlash('Error: ' + e.message, 'err', 5000); }
    });
    out.on('resize', () => this.draw());
    process.on('exit', () => this.restore());
    for (const sig of ['SIGTERM', 'SIGHUP']) process.on(sig, () => this.quit(0));
    process.on('uncaughtException', (e) => {
      this.restore();
      console.error(e && e.stack ? e.stack : e);
      process.exit(1);
    });

    const a = this.cfg.active;
    const p = a && getProvider(a.provider);
    if (p && a.model && this.hasCreds(p)) {
      this.enterChat(true);
    } else {
      this.gotoProviders(null);
    }
    this.draw();
  }

  restore() {
    if (this.restored) return;
    this.restored = true;
    try { process.stdin.setRawMode(false); } catch { /* bukan TTY */ }
    process.stdout.write('\x1b[?2004l\x1b[?25h\x1b[?1049l');
  }

  quit(code = 0) {
    this.restore();
    process.exit(code);
  }

  hasCreds(p) {
    const c = this.cfg.providers[p.id] || {};
    if (p.needsKey === false || p.keyRequired === false) return true;
    return !!(c.apiKey || (p.envKey && process.env[p.envKey]));
  }

  setFlash(text, kind = 'warn', ms = 2500) {
    this.flash = { text, kind };
    clearTimeout(this.flashTimer);
    this.flashTimer = setTimeout(() => { this.flash = null; this.draw(); }, ms);
    this.draw();
  }

  spin(on) {
    if (on && !this.spinTimer) {
      this.spinTimer = setInterval(() => { this.tick++; this.draw(); }, 100);
    } else if (!on && this.spinTimer) {
      clearInterval(this.spinTimer);
      this.spinTimer = null;
    }
  }

  draw() {
    if (this.restored) return;
    const W = process.stdout.columns || 80;
    const H = process.stdout.rows || 24;
    let lines;
    switch (this.screen) {
      case 'providers': lines = this.renderProviders(W, H); break;
      case 'form': lines = this.renderForm(W, H); break;
      case 'models': lines = this.renderModels(W, H); break;
      default: lines = this.renderChat(W, H);
    }
    let out = '\x1b[?25l\x1b[H';
    for (let i = 0; i < H; i++) {
      out += A.clip(lines[i] || '', W) + '\x1b[0m\x1b[K' + (i < H - 1 ? '\r\n' : '');
    }
    process.stdout.write(out);
  }

  // ------------------------------------------------------------ shared render
  header(W, H) {
    const b = logo.banner();
    const tag = T.mute(`Agent AI untuk terminal  ${G.sep}  v${pkg.version}`);
    const sub = T.faint('Windows  Linux  Termux  ElephantPanel');
    if (W >= 80 && H >= 26) {
      const e = logo.elephant();
      const ew = 24;
      const right = ['', ...b, tag, sub];
      const rows = [];
      for (let i = 0; i < e.length; i++) rows.push(' ' + A.pad(e[i], ew) + (right[i] || ''));
      return rows;
    }
    if (W >= 52 && H >= 20) return [...b.map((l) => ' ' + l), ' ' + tag, ''];
    return [' ' + T.accentBold('ELEPHANT AGENT') + ' ' + T.mute('v' + pkg.version)];
  }

  footer(hint) {
    if (this.flash) {
      const c = this.flash.kind === 'err' ? T.err : this.flash.kind === 'ok' ? T.ok : T.warn;
      return ' ' + c(this.flash.text);
    }
    return ' ' + T.faint(hint);
  }

  box(W, inner, color = T.accent) {
    const iw = Math.max(4, W - 5);
    return [
      ' ' + color(G.tl + G.h.repeat(iw + 2) + G.tr),
      ' ' + color(G.v) + ' ' + A.pad(inner, iw) + ' ' + color(G.v),
      ' ' + color(G.bl + G.h.repeat(iw + 2) + G.br),
    ];
  }

  listRow(sel, left, right, W) {
    // Nama (kiri) diprioritaskan; kolom kanan (host) dipotong/dibuang kalau layar sempit.
    const avail = Math.max(10, W - 4);
    const l = A.truncate(left, avail);
    const room = avail - A.strWidth(l) - 2;
    const r = room > 3 ? A.truncate(right, room) : '';
    const gap = Math.max(1, avail - A.strWidth(l) - A.strWidth(r));
    if (sel) return ' ' + T.accent(G.ptr) + ' ' + A.bold(l) + ' '.repeat(gap) + T.mute(r);
    return '   ' + l + ' '.repeat(gap) + T.faint(r);
  }

  searchLine(label, field, W) {
    const pre = ' ' + T.accentBold(label) + ' ' + T.accent(G.ptr) + ' ';
    const iw = Math.max(4, W - A.strWidth(pre) - 1);
    return pre + inputView(field.chars, field.cur, iw).out;
  }

  // ------------------------------------------------------------ providers screen
  gotoProviders(back) {
    this.back = back;
    this.ps = { field: new Field(''), sel: 0 };
    const a = this.cfg.active;
    if (a) {
      const i = PROVIDERS.findIndex((p) => p.id === a.provider);
      if (i >= 0) this.ps.sel = i;
    }
    this.screen = 'providers';
    this.draw();
  }

  providerItems() {
    const q = this.ps.field.value.trim();
    if (q.length >= 20 && !/\s/.test(q)) {
      const det = detectProvider(q);
      if (det) return { items: [det], detected: q };
    }
    return { items: filterItems(PROVIDERS, q, (p) => `${p.name} ${p.id} ${p.tags || ''} ${p.host || ''}`) };
  }

  renderProviders(W, H) {
    const lines = this.header(W, H);
    const { items, detected } = this.providerItems();
    this.ps.sel = Math.max(0, Math.min(this.ps.sel, items.length - 1));
    lines.push(' ' + T.accentBold('Pilih provider AI') + T.mute('  ketik untuk mencari, atau paste API key langsung'));
    lines.push(this.searchLine('Cari', this.ps.field, W));
    lines.push('');
    if (detected) lines.push(' ' + T.ok('Key terdeteksi — tekan Enter untuk lanjut dengan provider ini'));
    const rows = Math.max(3, H - lines.length - 2);
    if (!items.length) {
      lines.push('   ' + T.mute('Tidak ada hasil. Coba kata lain, atau pilih "Custom".'));
    } else {
      const [s, e] = listWindow(items.length, this.ps.sel, rows);
      for (let i = s; i < e; i++) {
        const p = items[i];
        const mark = this.hasCreds(p) && p.needsKey !== false && p.keyRequired !== false ? T.ok(' ' + G.ok) : '';
        lines.push(this.listRow(i === this.ps.sel, p.name + mark, p.host || 'isi base URL', W));
      }
    }
    while (lines.length < H - 1) lines.push('');
    lines[H - 1] = this.footer(`${G.ptr === '>' ? 'Atas/Bawah' : '↑↓'} pilih  ${G.sep}  Enter lanjut  ${G.sep}  ${this.back ? 'Esc kembali' : 'Ctrl+C keluar'}`);
    return lines;
  }

  providersKey(str, key) {
    const { items, detected } = this.providerItems();
    if (key.name === 'up') { this.ps.sel = Math.max(0, this.ps.sel - 1); return this.draw(); }
    if (key.name === 'down') { this.ps.sel = Math.min(items.length - 1, this.ps.sel + 1); return this.draw(); }
    if (key.name === 'pageup') { this.ps.sel = Math.max(0, this.ps.sel - 8); return this.draw(); }
    if (key.name === 'pagedown') { this.ps.sel = Math.min(items.length - 1, this.ps.sel + 8); return this.draw(); }
    if (key.name === 'escape') {
      if (this.back === 'chat') { this.screen = 'chat'; return this.draw(); }
      if (!this.ps.field.empty) { this.ps.field.clear(); this.ps.sel = 0; return this.draw(); }
      return undefined;
    }
    if (key.name === 'return') {
      const p = items[this.ps.sel];
      if (p) this.openForm(p, detected, this.back);
      return undefined;
    }
    if (this.ps.field.key(str, key)) { this.ps.sel = 0; this.draw(); }
    return undefined;
  }

  // ------------------------------------------------------------ form (base URL / API key)
  openForm(p, prefillKey, back) {
    const stored = this.cfg.providers[p.id] || {};
    const fields = [];
    if (p.askBaseUrl) {
      fields.push({ id: 'baseUrl', label: 'Base URL', secret: false, def: stored.baseUrl || p.baseUrl || '', required: true, hint: p.baseUrlHint || '' });
    }
    if (p.needsKey !== false) {
      const envHas = !!(p.envKey && process.env[p.envKey]);
      fields.push({
        id: 'apiKey', label: 'API key', secret: true, def: prefillKey || '',
        required: p.keyRequired !== false && !stored.apiKey && !envHas,
        hasStored: !!(stored.apiKey || envHas),
      });
    }
    this.form = { p, fields, idx: 0, values: {}, error: '', loading: false, canSkip: false, back, field: new Field(fields[0] ? fields[0].def : '') };
    this.screen = 'form';
    if (!fields.length) return this.finishForm(false);
    return this.draw();
  }

  renderForm(W, H) {
    const f = this.form;
    const fld = f.fields[f.idx];
    const lines = this.header(W, H);
    lines.push(' ' + T.mute('Provider ') + A.bold(f.p.name) + (f.p.host ? T.faint('  ' + f.p.host) : ''));
    if (fld && fld.id === 'apiKey' && f.p.keyUrl) lines.push(' ' + T.mute('Dapatkan key: ') + T.blue(f.p.keyUrl));
    lines.push('');
    if (fld) {
      lines.push(' ' + T.accentBold(`Langkah ${f.idx + 1}/${f.fields.length}`) + ' ' + A.bold(fld.label) + (fld.hint ? T.faint('  ' + fld.hint) : ''));
      const ch = f.field.chars;
      const view = fld.secret
        ? ch.map((c, i) => (ch.length > 12 && i >= ch.length - 4 ? c : G.mask))
        : ch.map((c) => (c === '\n' ? G.nl : c));
      const iw = Math.max(4, W - 5);
      lines.push(...this.box(W, inputView(view, f.field.cur, iw).out));
      if (fld.hasStored && f.field.empty) lines.push(' ' + T.faint('Kosongkan + Enter untuk memakai key yang sudah tersimpan / dari environment'));
      if (fld.id === 'apiKey' && !f.field.empty) {
        const det = detectProvider(f.field.value);
        if (det && det.id !== f.p.id) lines.push(' ' + T.warn(`Awalan key ini mirip key ${det.name}. Salah provider? Tekan Ctrl+P.`));
      }
    }
    if (f.loading) lines.push('', ' ' + T.accent(G.spin[this.tick % G.spin.length]) + ' ' + 'Memverifikasi & mengambil daftar model…');
    if (f.error) {
      lines.push('');
      lines.push(...A.wrapText(T.err(G.x + ' ' + f.error), W - 2, ' '));
      if (f.canSkip) lines.push(' ' + T.mute('Enter: coba lagi  ' + G.sep + '  Tab: simpan tetap & pakai daftar model bawaan'));
    }
    while (lines.length < H - 1) lines.push('');
    lines[H - 1] = this.footer(`Enter lanjut  ${G.sep}  Esc kembali  ${G.sep}  Ctrl+P cari provider  ${G.sep}  Ctrl+U hapus`);
    return lines;
  }

  formKey(str, key) {
    const f = this.form;
    if (f.loading) {
      if (key.name === 'escape') { this.opId++; f.loading = false; this.spin(false); this.draw(); }
      return;
    }
    if (key.name === 'escape' || (key.ctrl && key.name === 'p')) {
      if (key.ctrl || f.back !== 'chat') return this.gotoProviders(f.back);
      this.screen = 'chat';
      return this.draw();
    }
    if (key.name === 'tab' && f.canSkip) return this.finishForm(true);
    if (key.name === 'return') return this.submitField();
    if (f.field.key(str, key)) { f.error = ''; f.canSkip = false; this.draw(); }
    return undefined;
  }

  submitField() {
    const f = this.form;
    const fld = f.fields[f.idx];
    const v = f.field.value.trim();
    if (!v && fld.required) { f.error = `${fld.label} wajib diisi.`; return this.draw(); }
    if (v) f.values[fld.id] = v;
    if (f.idx < f.fields.length - 1) {
      f.idx++;
      f.field = new Field(f.fields[f.idx].def || '');
      f.error = '';
      return this.draw();
    }
    return this.finishForm(false);
  }

  async finishForm(skipVerify) {
    const f = this.form;
    const p = f.p;
    const stored = this.cfg.providers[p.id] || {};
    const conf = { ...stored, ...f.values };
    const token = ++this.opId;
    f.loading = true;
    f.error = '';
    this.spin(true);
    this.draw();
    let models;
    let note = '';
    try {
      models = await api.listModels(p, conf);
      if (!models.length) throw new Error('Provider mengembalikan daftar model kosong.');
    } catch (e) {
      if (token !== this.opId) return;
      if (!skipVerify) {
        f.loading = false;
        f.error = e.message;
        f.canSkip = true;
        this.spin(false);
        return this.draw();
      }
      models = (p.models || []).map((id) => ({ id, name: id }));
      note = 'Daftar model live gagal diambil — ketik ID model manual jika perlu.';
    }
    if (token !== this.opId) return;
    this.spin(false);
    f.loading = false;
    this.cfg.providers[p.id] = conf;
    store.save(this.cfg);
    return this.openModels(p, models, f.back, note);
  }

  // ------------------------------------------------------------ models screen
  openModels(p, models, back, note = '') {
    const cur = this.cfg.active && this.cfg.active.provider === p.id ? this.cfg.active.model : (this.cfg.providers[p.id] || {}).model;
    const sel = Math.max(0, models.findIndex((m) => m.id === cur));
    this.ms = { p, models, field: new Field(''), sel, back, note };
    this.screen = 'models';
    this.draw();
  }

  modelItems() {
    const q = this.ms.field.value.trim();
    const items = filterItems(this.ms.models, q, (m) => `${m.id} ${m.name || ''}`);
    if (q && !this.ms.models.some((m) => m.id === q)) return [...items, { id: q, name: q, manual: true }];
    return items;
  }

  renderModels(W, H) {
    const ms = this.ms;
    const lines = this.header(W, H);
    const items = this.modelItems();
    ms.sel = Math.max(0, Math.min(ms.sel, items.length - 1));
    lines.push(' ' + T.accentBold('Pilih model') + T.mute(`  ${ms.p.name} ${G.sep} ${ms.models.length} model`));
    lines.push(this.searchLine('Cari', ms.field, W));
    if (ms.note) lines.push(' ' + T.warn(ms.note));
    lines.push('');
    const rows = Math.max(3, H - lines.length - 2);
    if (!items.length) {
      lines.push('   ' + T.mute('Daftar kosong. Ketik ID model lalu Enter.'));
    } else {
      const [s, e] = listWindow(items.length, ms.sel, rows);
      const active = this.cfg.active;
      for (let i = s; i < e; i++) {
        const m = items[i];
        const isCur = active && active.provider === ms.p.id && active.model === m.id;
        const label = m.manual ? `${G.ptr} pakai ID manual: ${m.id}` : m.id + (isCur ? T.ok(` ${G.ok} aktif`) : '');
        lines.push(this.listRow(i === ms.sel, label, '', W));
      }
    }
    while (lines.length < H - 1) lines.push('');
    lines[H - 1] = this.footer(`${items.length} hasil  ${G.sep}  Enter pilih  ${G.sep}  Esc kembali`);
    return lines;
  }

  modelsKey(str, key) {
    const ms = this.ms;
    const items = this.modelItems();
    if (key.name === 'up') { ms.sel = Math.max(0, ms.sel - 1); return this.draw(); }
    if (key.name === 'down') { ms.sel = Math.min(items.length - 1, ms.sel + 1); return this.draw(); }
    if (key.name === 'pageup') { ms.sel = Math.max(0, ms.sel - 8); return this.draw(); }
    if (key.name === 'pagedown') { ms.sel = Math.min(items.length - 1, ms.sel + 8); return this.draw(); }
    if (key.name === 'escape') {
      if (!ms.field.empty) { ms.field.clear(); ms.sel = 0; return this.draw(); }
      if (ms.back === 'chat') { this.screen = 'chat'; return this.draw(); }
      return this.gotoProviders(ms.back);
    }
    if (key.name === 'return') {
      const m = items[ms.sel];
      if (m) this.selectModel(ms.p, m.id);
      return undefined;
    }
    if (ms.field.key(str, key)) { ms.sel = 0; this.draw(); }
    return undefined;
  }

  selectModel(p, model) {
    const switched = !this.cfg.active || this.cfg.active.provider !== p.id || this.cfg.active.model !== model;
    this.cfg.active = { provider: p.id, model };
    this.cfg.providers[p.id] = { ...(this.cfg.providers[p.id] || {}), model };
    store.save(this.cfg);
    const hadChat = this.messages.length > 0;
    this.enterChat(false); // percakapan kosong: enterChat sudah menampilkan sapaan
    if (switched && hadChat) this.sys(`Terhubung ke ${p.name} ${G.sep} model ${model}`);
  }

  // ------------------------------------------------------------ chat
  enterChat(fresh) {
    this.screen = 'chat';
    if (fresh || !this.messages.length) {
      const a = this.cfg.active;
      const p = getProvider(a.provider);
      this.messages = [];
      this.sys(`Terhubung ke ${p.name} ${G.sep} model ${a.model}. Ketik pesan, atau /help.`);
    }
    this.chat.scroll = 0;
    this.draw();
  }

  sys(text) { this.messages.push({ role: 'system', content: text }); this.draw(); }

  transcript(W, H) {
    const out = [];
    if (this.chat.showLogo) out.push(...this.header(W, H), '');
    const model = this.cfg.active ? this.cfg.active.model : '';
    for (const m of this.messages) {
      if (m.role === 'user') {
        out.push(' ' + A.bold(T.blue('Kamu')));
        for (const l of m.content.split('\n')) out.push(...A.wrapText(l, W - 2, '  '));
      } else if (m.role === 'assistant') {
        out.push(' ' + T.accentBold('Agent') + T.faint('  ' + model));
        if (!m.content && m.pending) out.push('  ' + T.accent(G.spin[this.tick % G.spin.length]));
        else out.push(...md(m.content || T.mute('(respons kosong)'), W));
        if (m.stopped) out.push('  ' + T.mute('(dihentikan)'));
      } else if (m.role === 'error') {
        out.push(...A.wrapText(T.err(G.x + ' ' + m.content), W - 2, ' '));
      } else {
        for (const l of m.content.split('\n')) out.push(...A.wrapText(T.mute(l), W - 2, '  '));
      }
      out.push('');
    }
    return out;
  }

  renderChat(W, H) {
    const a = this.cfg.active;
    const p = a && getProvider(a.provider);
    const viewH = Math.max(1, H - 5);
    const all = this.transcript(W, H);
    const maxScroll = Math.max(0, all.length - viewH);
    this.chat.scroll = Math.max(0, Math.min(this.chat.scroll, maxScroll));
    let view;
    if (all.length <= viewH) view = all.slice();
    else view = all.slice(all.length - viewH - this.chat.scroll, all.length - this.chat.scroll);
    while (view.length < viewH) view.push('');

    // input box
    const f = this.chat.field;
    const iw = Math.max(4, W - 5);
    const chars = f.chars.map((c) => (c === '\n' ? G.nl : c));
    const prompt = T.accent(G.ptr) + ' ';
    const inner = prompt + inputView(chars, f.cur, iw - 2).out;
    const boxLines = this.box(W, inner, this.busy ? T.faint : T.accent);

    // hint
    const text = f.value;
    let hint;
    if (this.flash) {
      hint = this.footer('');
    } else if (this.busy) {
      hint = ' ' + T.accent(G.spin[this.tick % G.spin.length]) + ' ' + T.mute('menjawab…  Esc / Ctrl+C untuk menghentikan');
    } else if (text.startsWith('/') && !text.includes('\n')) {
      const m = COMMANDS.filter(([c]) => c.startsWith(text.split(' ')[0]));
      hint = ' ' + (m.length ? m.map(([c, d]) => T.accent(c) + T.faint(' ' + d)).join(T.faint('  ' + G.sep + '  ')) : T.faint('perintah tidak dikenal — /help'));
    } else {
      hint = W >= 66
        ? this.footer(`Enter kirim  ${G.sep}  Ctrl+J baris baru  ${G.sep}  PgUp/PgDn gulir  ${G.sep}  /help`)
        : this.footer(`Enter kirim ${G.sep} Ctrl+J baris baru`);
    }

    // status bar
    const L1 = ' ELEPHANT ';
    const R = this.chat.scroll > 0 ? ` ${G.sep} gulir ${this.chat.scroll} ` : ' /help ';
    const prov = A.truncate(' ' + (p ? p.name : '-') + ' ', Math.max(10, Math.floor(W * 0.35)));
    let model = ' ' + (a ? a.model : '-') + ' ';
    const room = W - A.strWidth(L1) - A.strWidth(prov) - A.strWidth(R);
    model = A.truncate(model, Math.max(0, room));
    const fill = Math.max(0, room - A.strWidth(model));
    const bar =
      A.bg(208)(A.fg(16)(A.bold(L1))) +
      A.bg(238)(A.fg(252)(prov)) +
      A.bg(236)(A.fg(250)(model + ' '.repeat(fill))) +
      A.bg(236)(A.fg(245)(R));
    return [...view, ...boxLines, hint, bar];
  }

  chatKey(str, key) {
    const f = this.chat.field;
    const c = this.chat;
    if (key.name === 'return') {
      if (this.pasting || key.meta) { f.insert('\n'); return this.draw(); }
      return this.submitChat();
    }
    if (key.name === 'enter') { f.insert('\n'); return this.draw(); }
    if (key.name === 'escape') {
      if (this.busy) return this.stopStream();
      if (!f.empty) { f.clear(); return this.draw(); }
      return undefined;
    }
    if (key.name === 'pageup') { c.scroll += Math.max(3, (process.stdout.rows || 24) - 8); return this.draw(); }
    if (key.name === 'pagedown') { c.scroll = Math.max(0, c.scroll - Math.max(3, (process.stdout.rows || 24) - 8)); return this.draw(); }
    if (key.name === 'up' && !f.value.includes('\n')) {
      if (!c.history.length) return undefined;
      if (c.hist === -1) { c.draft = f.value; c.hist = c.history.length; }
      c.hist = Math.max(0, c.hist - 1);
      f.set(c.history[c.hist]);
      return this.draw();
    }
    if (key.name === 'down' && !f.value.includes('\n') && c.hist !== -1) {
      c.hist++;
      if (c.hist >= c.history.length) { c.hist = -1; f.set(c.draft); } else f.set(c.history[c.hist]);
      return this.draw();
    }
    if (key.name === 'tab') {
      const v = f.value;
      if (v.startsWith('/') && !v.includes(' ')) {
        const m = COMMANDS.filter(([cmd]) => cmd.startsWith(v));
        if (m.length === 1) { f.set(m[0][0] + ' '); return this.draw(); }
      }
      return undefined;
    }
    if (f.key(str, key)) { c.scroll = 0; c.hist = -1; this.draw(); }
    return undefined;
  }

  submitChat() {
    const f = this.chat.field;
    const text = f.value.trim();
    if (!text) return undefined;
    if (this.busy) return this.setFlash('Tunggu jawaban selesai (Esc untuk menghentikan).', 'warn');
    this.chat.history.push(text);
    this.chat.hist = -1;
    f.clear();
    if (text.startsWith('/') && !text.includes('\n')) return this.command(text);
    return this.send(text);
  }

  command(line) {
    const [cmd, ...rest] = line.split(/\s+/);
    const arg = rest.join(' ').trim();
    const a = this.cfg.active;
    const p = a && getProvider(a.provider);
    switch (cmd) {
      case '/help': {
        const lines = ['Perintah:', ...COMMANDS.map(([c, d]) => `  ${c.padEnd(10)} ${d}`),
          '', 'Shortcut:',
          '  Enter kirim  |  Ctrl+J baris baru  |  Esc hentikan jawaban',
          '  PgUp/PgDn gulir  |  Atas/Bawah riwayat input  |  Tab lengkapi perintah',
          '  Ctrl+A/E awal/akhir baris  |  Ctrl+U/K/W hapus  |  Ctrl+C keluar (2x)'];
        this.sys(lines.join('\n'));
        break;
      }
      case '/provider': this.gotoProviders('chat'); break;
      case '/key': if (p) this.openForm(p, '', 'chat'); else this.gotoProviders('chat'); break;
      case '/model': this.pickModel(); break;
      case '/clear': this.messages = []; this.chat.showLogo = true; this.sys('Percakapan dibersihkan.'); break;
      case '/system':
        if (!arg) this.sys('System prompt saat ini:\n' + (this.cfg.system || '(kosong)'));
        else {
          this.cfg.system = arg === 'reset' ? store.DEFAULT_SYSTEM : arg;
          store.save(this.cfg);
          this.sys(arg === 'reset' ? 'System prompt dikembalikan ke default.' : 'System prompt diperbarui.');
        }
        break;
      case '/exit': case '/quit': this.quit(0); break;
      default: this.sys(`Perintah tidak dikenal: ${cmd}. Ketik /help.`);
    }
  }

  async pickModel() {
    const a = this.cfg.active;
    const p = a && getProvider(a.provider);
    if (!p) return this.gotoProviders('chat');
    const token = ++this.opId;
    this.setFlash('Mengambil daftar model…', 'warn', 15000);
    let models;
    let note = '';
    try {
      models = await api.listModels(p, this.cfg.providers[p.id] || {});
    } catch (e) {
      models = (p.models || []).map((id) => ({ id, name: id }));
      if (!models.length && a.model) models = [{ id: a.model, name: a.model }];
      note = `Gagal mengambil daftar model (${e.message}). Memakai daftar bawaan.`;
    }
    if (token !== this.opId) return undefined;
    this.flash = null;
    return this.openModels(p, models, 'chat', note);
  }

  async send(text) {
    const a = this.cfg.active;
    const p = getProvider(a.provider);
    const conf = this.cfg.providers[p.id] || {};
    this.chat.showLogo = this.chat.showLogo && this.messages.length < 2;
    this.messages.push({ role: 'user', content: text });
    const reply = { role: 'assistant', content: '', pending: true };
    this.messages.push(reply);
    const history = this.messages.filter((m) => (m.role === 'user' || m.role === 'assistant') && m.content);
    this.busy = true;
    this.ctrl = new AbortController();
    this.chat.scroll = 0;
    this.spin(true);
    this.draw();
    let queued = false;
    try {
      await api.chat({
        provider: p, conf, model: a.model, system: this.cfg.system, messages: history, signal: this.ctrl.signal,
        onDelta: (d) => {
          reply.content += d;
          if (!queued) { queued = true; setTimeout(() => { queued = false; this.draw(); }, 30); }
        },
      });
    } catch (e) {
      if (e && e.name === 'AbortError') reply.stopped = true;
      else this.messages.push({ role: 'error', content: e.message });
    } finally {
      reply.pending = false;
      if (!reply.content && !reply.stopped) this.messages.splice(this.messages.indexOf(reply), 1);
      this.busy = false;
      this.ctrl = null;
      this.spin(false);
      this.draw();
    }
  }

  stopStream() {
    if (this.ctrl) this.ctrl.abort();
  }

  // ------------------------------------------------------------ input
  onKey(str, key) {
    if (key.name === 'paste-start') { this.pasting = true; return; }
    if (key.name === 'paste-end') { this.pasting = false; return; }
    if (key.ctrl && key.name === 'c') return this.onCtrlC();
    if (key.ctrl && key.name === 'd' && this.screen === 'chat' && this.chat.field.empty && !this.busy) return this.quit(0);
    switch (this.screen) {
      case 'providers': return this.providersKey(str, key);
      case 'form': return this.formKey(str, key);
      case 'models': return this.modelsKey(str, key);
      default: return this.chatKey(str, key);
    }
  }

  onCtrlC() {
    if (this.screen === 'chat' && this.busy) return this.stopStream();
    if (this.screen === 'chat' && !this.chat.field.empty) { this.chat.field.clear(); return this.draw(); }
    const now = Date.now();
    if (now - this.quitArm < 1500) return this.quit(0);
    this.quitArm = now;
    return this.setFlash('Tekan Ctrl+C sekali lagi untuk keluar.', 'warn', 1500);
  }
}

module.exports = { App, Field, md, filterItems };
