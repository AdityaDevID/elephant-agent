# Elephant Agent

Agent AI di terminal. Bisa **menjalankan perintah, membaca/menulis/mengedit file, mencari kode, dan mengambil halaman web** lewat tool-use, dengan izin dari kamu. Tampilan TUI lengkap, API key multi-provider, pencarian provider & model. **Tanpa dependency** (cuma butuh Node.js 18+), jalan di Windows, Linux, Termux, dan ElephantPanel.

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
4. **Chat.** Jawaban streaming, markdown ringan (heading, bullet, code block). Kalau butuh, Agent memanggil tool (lihat di bawah).

Provider: Claude, ChatGPT, Gemini, Groq, NVIDIA NIM, OpenRouter, Vikey, DeepSeek, Mistral, xAI, Together, Ollama (lokal), dan Custom (endpoint OpenAI-compatible apa pun: vLLM, LM Studio, LiteLLM, dll).

> **Vikey:** base URL-nya tidak saya temukan di sumber publik, jadi kolom Base URL diisi manual dari dashboard Vikey (berakhiran `/v1`).

## Tool-use (agent)

Agent bisa bertindak di komputer/HP kamu. Contoh: *"jalankan npm test lalu perbaiki error-nya"*, *"cari semua TODO di folder ini"*, *"buat file index.html sederhana"*.

| Tool | Fungsi | Izin (mode `ask`) |
| --- | --- | --- |
| `run_command` | jalankan perintah shell (timeout 120 dtk, maks 600) | tanya |
| `read_file` | baca file (bernomor baris, bisa per bagian) | otomatis |
| `write_file` | buat / timpa file | tanya |
| `edit_file` | ganti teks di file (harus unik, atau `replace_all`) | tanya |
| `list_dir` | daftar isi folder | otomatis |
| `search` | cari isi file dengan regex (seperti `grep -rn`) | otomatis |
| `fetch_url` | ambil halaman web / API (GET) | tanya |

**Mode izin** (`/mode`, tersimpan di config):

- `ask` (default): baca otomatis; tulis, jalankan perintah, dan akses web minta izin. Jawab `y` (ya), `a` (ya, selalu untuk tool itu selama sesi), atau `n`/Esc (tidak).
- `auto`: semua jalan tanpa tanya. Pakai hanya di folder yang aman.
- `readonly`: Agent hanya bisa membaca dan mencari.

Perintah yang berbahaya (`rm -rf /`, `mkfs`, `curl ... | sh`, `shutdown`, dst.) **selalu** ditanya, bahkan di mode `auto`. Ini jaring pengaman sederhana, bukan sandbox: Agent berjalan dengan hak akses akun kamu, jadi baca perintahnya sebelum menekan `y`.

Esc / Ctrl+C menghentikan jawaban dan proses yang sedang jalan. Satu pesan dibatasi 30 langkah tool. Perintah jalan tanpa stdin (tidak bisa interaktif) dan di folder kerja (`/cwd` untuk melihat atau mengganti). Tidak semua model mendukung tool; kalau error, coba model lain atau `/tools off`.

## Perintah di chat

`/help` `/provider` `/model` `/key` `/system <teks>` `/tools [on|off]` `/mode [ask|auto|readonly]` `/cwd [folder]` `/clear` `/exit`

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
src/ui.js         TUI: layar provider, form key, pilih model, chat, loop agent
src/tools.js      tool-use: run_command, file, search, fetch_url + aturan izin
src/providers.js  daftar provider + deteksi key
src/api.js        list model & streaming + tool call (Anthropic + OpenAI-compatible)
src/config.js     simpan config
src/logo.js       logo
test/smoke.js     tes API vs server mock
test/tools.js     tes tool, izin, dan loop agent: npm test
```

## Status

v0.2.0: tool-use (jalankan perintah, baca/tulis/edit file, cari, fetch URL) dengan mode izin. v0.1.0: tampilan + setup provider/model + chat streaming.

## Lisensi

[MIT](LICENSE) © 2026 AdityaDevID. Repo: <https://github.com/AdityaDevID/elephant-agent>
