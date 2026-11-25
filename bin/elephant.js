#!/usr/bin/env node
'use strict';

const major = parseInt(process.versions.node.split('.')[0], 10);
if (major < 18) {
  console.error(`Elephant Agent butuh Node.js 18 atau lebih baru (kamu pakai ${process.version}).`);
  process.exit(1);
}

const pkg = require('../package.json');
const args = process.argv.slice(2);

const HELP = `Elephant Agent v${pkg.version}: Agent AI di terminal

Pemakaian:
  elephant            jalankan aplikasi
  elephant --ascii    pakai karakter ASCII (terminal jadul)
  elephant --reset    hapus config & API key tersimpan
  elephant --version  tampilkan versi

Config disimpan di: ${require('../src/config').file()}
Env opsional: ELEPHANT_HOME, NO_COLOR, ELEPHANT_ASCII=1,
  ANTHROPIC_API_KEY, OPENAI_API_KEY, GEMINI_API_KEY, GROQ_API_KEY,
  NVIDIA_API_KEY, OPENROUTER_API_KEY, DEEPSEEK_API_KEY, MISTRAL_API_KEY, XAI_API_KEY`;

if (args.includes('-v') || args.includes('--version')) {
  console.log(pkg.version);
  process.exit(0);
}
if (args.includes('-h') || args.includes('--help')) {
  console.log(HELP);
  process.exit(0);
}
if (args.includes('--reset')) {
  require('../src/config').reset();
  console.log('Config dihapus: ' + require('../src/config').file());
  process.exit(0);
}
if (!process.stdin.isTTY || !process.stdout.isTTY) {
  console.error('Elephant Agent butuh terminal interaktif (TTY).');
  process.exit(1);
}

const { App } = require('../src/ui');
new App().start();
