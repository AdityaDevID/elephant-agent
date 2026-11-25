'use strict';

const ESC = '\x1b[';
const COLOR = !process.env.NO_COLOR && process.env.TERM !== 'dumb';

const bold = (s) => `${ESC}1m${s}${ESC}22m`;
const inv = (s) => `${ESC}7m${s}${ESC}27m`;
const dim = (s) => (COLOR ? `${ESC}2m${s}${ESC}22m` : String(s));
const fg = (n) => (s) => (COLOR ? `${ESC}38;5;${n}m${s}${ESC}39m` : String(s));
const bg = (n) => (s) => (COLOR ? `${ESC}48;5;${n}m${s}${ESC}49m` : String(s));

const ANSI_RE = /\x1b\[[0-9;?]*[ -\/]*[@-~]/g;
const TOKEN_RE = /\x1b\[[0-9;?]*[ -\/]*[@-~]|[\s\S]/gu;
const strip = (s) => String(s).replace(ANSI_RE, '');

function charWidth(cp) {
  if (cp === 0 || cp === 0x200d || (cp >= 0x300 && cp <= 0x36f) || (cp >= 0xfe00 && cp <= 0xfe0f)) return 0;
  if (cp < 32 || (cp >= 0x7f && cp < 0xa0)) return 0;
  if (
    (cp >= 0x1100 && cp <= 0x115f) ||
    (cp >= 0x2e80 && cp <= 0xa4cf) ||
    (cp >= 0xac00 && cp <= 0xd7a3) ||
    (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0xfe30 && cp <= 0xfe6f) ||
    (cp >= 0xff00 && cp <= 0xff60) ||
    (cp >= 0xffe0 && cp <= 0xffe6) ||
    (cp >= 0x1f300 && cp <= 0x1f64f) ||
    (cp >= 0x1f900 && cp <= 0x1f9ff) ||
    (cp >= 0x20000 && cp <= 0x3fffd)
  ) return 2;
  return 1;
}

function strWidth(s) {
  let w = 0;
  for (const ch of strip(s)) w += charWidth(ch.codePointAt(0));
  return w;
}

// Pecah string (boleh berisi ANSI) berdasarkan lebar tampilan n.
function splitAt(s, n) {
  const toks = String(s).match(TOKEN_RE) || [];
  let w = 0;
  let i = 0;
  for (; i < toks.length; i++) {
    const t = toks[i];
    if (t.charCodeAt(0) === 27 && t.length > 1) continue; // ANSI: lebar 0
    const cw = charWidth(t.codePointAt(0));
    if (w + cw > n && w > 0) break;
    if (w + cw > n && n <= 0) { i++; break; }
    w += cw;
  }
  return [toks.slice(0, i).join(''), toks.slice(i).join('')];
}

const clip = (s, n) => splitAt(s, n)[0];

function truncate(s, n) {
  if (n <= 0) return '';
  if (strWidth(s) <= n) return s;
  return clip(s, n - 1) + '…';
}

function pad(s, w) {
  const v = strWidth(s);
  return v >= w ? s : s + ' '.repeat(w - v);
}

// Word-wrap yang sadar ANSI. Satu paragraf (tanpa \n).
function wrapText(str, width, indent1 = '', indent2 = indent1) {
  width = Math.max(4, width);
  const lines = [];
  const words = String(str).split(/ +/).filter((x) => x !== '');
  let cur = indent1;
  let curW = strWidth(indent1);
  let hasWord = false;
  const newLine = () => {
    lines.push(cur);
    cur = indent2;
    curW = strWidth(indent2);
    hasWord = false;
  };
  for (let w of words) {
    let ww = strWidth(w);
    const need = (hasWord ? 1 : 0) + ww;
    if (curW + need <= width) {
      cur += (hasWord ? ' ' : '') + w;
      curW += need;
      hasWord = true;
      continue;
    }
    if (hasWord) newLine();
    while (strWidth(w) > width - curW) {
      const [head, tail] = splitAt(w, Math.max(1, width - curW));
      lines.push(cur + head);
      cur = indent2;
      curW = strWidth(indent2);
      w = tail;
      if (!w) break;
    }
    if (w) {
      cur += w;
      curW += strWidth(w);
      hasWord = true;
    }
  }
  if (hasWord) lines.push(cur);
  else if (!lines.length) lines.push('');
  return lines;
}

module.exports = { bold, inv, dim, fg, bg, strip, charWidth, strWidth, splitAt, clip, truncate, pad, wrapText, COLOR };
