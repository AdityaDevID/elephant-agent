# Elephant Agent

Agent AI di terminal. Tampilan TUI lengkap dengan logo, tempat prompting, pasang API key multi-provider, pencarian provider & model. **Tanpa dependency** (cuma butuh Node.js 18+), jalan di Windows, Linux, Termux, dan ElephantPanel.

## Install & jalankan

```bash
npm i -g elephant-agent
# atau: npm i -g @adityadevid/elephant-agent   (isi sama, nama berbeda)
elephant
```

Tanpa install: `npx elephant-agent`. Dari source: `node bin/elephant.js`.

| Platform | Catatan |
| --- | --- |
| Linux / macOS | `node bin/elephant.js` |
| Windows | PowerShell / Windows Terminal. Kalau garisnya berantakan: `elephant --ascii` |
| Termux | `pkg install nodejs`, lalu jalankan seperti biasa. Tombol PGUP/PGDN di extra keys dipakai untuk scroll |
| ElephantPanel | Buka terminal panel, pastikan `node -v` >= 18, jalankan seperti biasa |

## Alur pakai

1. **Pilih provider.** Ketik untuk mencari (`gro`, `claude`, `gpt`...). Bisa juga langsung paste API key: provider ditebak dari awalan key.
2. **Masukkan API key.** Disamarkan di layar. Key diverifikasi dengan mengambil daftar model.
3. **Pilih model.** Daftar diambil live dari provider, bisa dicari. Kalau model tidak ada di daftar, ketik ID-nya lalu Enter.
4. **Chat.** Jawaban streaming, markdown ringan (heading, bullet, code block).

Provider: Claude, ChatGPT, Gemini, Groq, NVIDIA NIM, OpenRouter, Vikey, DeepSeek, Mistral, xAI, Together, Ollama (lokal), dan Custom (endpoint OpenAI-compatible apa pun: vLLM, LM Studio, LiteLLM, dll).

> **Vikey:** base URL-nya tidak saya temukan di sumber publik, jadi kolom Base URL diisi manual dari dashboard Vikey (berakhiran `/v1`).

## Perintah di chat

`/help` `/provider` `/model` `/key` `/system <teks>` `/clear` `/exit`

| Tombol | Fungsi |
| --- | --- |
| Enter | kirim |
| Ctrl+J, atau paste multi-baris | baris baru |
| Esc / Ctrl+C | hentikan jawaban |
| PgUp / PgDn | scroll |
| Atas / Bawah | riwayat input |
| Tab | lengkapi perintah `/` |
| Ctrl+C (2x) / Ctrl+D | keluar |

## Config & keamanan

Config + API key disimpan **plaintext** di `~/.elephant-agent/config.json` (izin `0600`; di Windows izin file mengikuti folder user). Alternatif tanpa menyimpan key: pakai environment variable `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GEMINI_API_KEY`, `GROQ_API_KEY`, `NVIDIA_API_KEY`, `OPENROUTER_API_KEY`, `DEEPSEEK_API_KEY`, `MISTRAL_API_KEY`, `XAI_API_KEY`.

`elephant --reset` menghapus config.

## Struktur

```
bin/elephant.js   entry point (CLI flags)
src/ui.js         TUI: layar provider, form key, pilih model, chat
src/providers.js  daftar provider + deteksi key
src/api.js        list model & streaming (Anthropic + OpenAI-compatible)
src/config.js     simpan config
src/logo.js       logo
test/smoke.js     tes API vs server mock: npm test
```

## Status

v0.1.0: tampilan + setup provider/model + chat streaming. Belum ada tool-use (baca/tulis file, jalankan perintah): itu langkah berikutnya untuk jadi agent penuh.

## Lisensi

[MIT](LICENSE) © 2026 AdityaDevID. Repo: <https://github.com/adityadevid/elephant-agent>
