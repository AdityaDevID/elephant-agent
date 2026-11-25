'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const DEFAULT_SYSTEM =
  'You are Elephant Agent, a concise and helpful AI assistant running in a terminal. ' +
  "Reply in the language the user writes in. Keep answers short unless asked for detail.";

function dir() {
  return process.env.ELEPHANT_HOME || path.join(os.homedir(), '.elephant-agent');
}

function file() {
  return path.join(dir(), 'config.json');
}

function defaults() {
  return { version: 1, active: null, providers: {}, system: DEFAULT_SYSTEM };
}

function load() {
  try {
    const raw = JSON.parse(fs.readFileSync(file(), 'utf8'));
    return { ...defaults(), ...raw, providers: { ...(raw.providers || {}) } };
  } catch {
    return defaults();
  }
}

// Tulis atomik; file hanya bisa dibaca pemilik (API key tersimpan di sini).
function save(cfg) {
  fs.mkdirSync(dir(), { recursive: true, mode: 0o700 });
  const tmp = file() + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, file());
}

function reset() {
  try { fs.unlinkSync(file()); } catch { /* sudah tidak ada */ }
}

module.exports = { load, save, reset, file, dir, DEFAULT_SYSTEM };
