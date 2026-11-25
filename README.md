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
| `fetch_url` | ambil halaman web / API (GET), dengan pagar SSRF (lihat di bawah) | tanya |

**Mode izin** (`/mode`, tersimpan di config):

- `ask` (default): baca otomatis; tulis, jalankan perintah, dan akses web minta izin. Jawab `y` (ya), `a` (ya, selalu untuk tool itu selama sesi), atau `n`/Esc (tidak).
- `auto`: semua jalan tanpa tanya. Pakai hanya di folder yang aman.
- `readonly`: Agent hanya bisa membaca dan mencari.

Perintah yang berbahaya (`rm -rf /`, `mkfs`, `curl ... | sh`, `shutdown`, dst.) **selalu** ditanya, bahkan di mode `auto`. Ini jaring pengaman sederhana, bukan sandbox: Agent berjalan dengan hak akses akun kamu, jadi baca perintahnya sebelum menekan `y`.

**Pagar `fetch_url` (SSRF).** Agent tidak bisa membuka alamat internal lewat `fetch_url`: `localhost`, `127.x`, `10.x`, `172.16-31.x`, `192.168.x`, `100.64.x` (CGNAT/Tailscale), IPv6 loopback/ULA, dan bentuk yang disamarkan (`2130706433`, `0x7f.1`, `::ffff:127.0.0.1`, dst.). Pengecekan dilakukan saat koneksi dibuat (hasil DNS yang diperiksa = yang dipakai, jadi tahan DNS rebinding) dan diulang di setiap redirect. Kalau memang perlu (mis. Ollama lokal atau server di LAN), Agent akan bertanya dulu, per host:port dan hanya untuk satu panggilan; ini tetap ditanya di mode `auto`. Alamat metadata/link-local (`169.254.x.x`, `fe80::`, `metadata.google.internal`) tidak pernah diizinkan. Ini hanya melindungi `fetch_url`: `run_command` tetap bisa menjalankan `curl` ke mana saja kalau kamu menyetujuinya.

Esc / Ctrl+C menghentikan jawaban dan proses yang sedang jalan. Satu pesan dibatasi 30 langkah tool. Perintah jalan tanpa stdin (tidak bisa interaktif) dan di folder kerja (`/cwd` untuk melihat atau mengganti). Tidak semua model mendukung tool; kalau error, coba model lain atau `/tools off`.

## Konteks, token, dan retry

**Auto-compact.** Sebelum tiap request, Agent memperkirakan isi konteks. Kalau sudah lewat 75% jendela model: (1) hasil tool lama dipotong dulu (mis. isi file besar yang sudah dibaca), (2) kalau masih kurang, percakapan lama diringkas oleh model jadi satu pesan ringkasan dan pesan lama disembunyikan; pesan terbaru tetap utuh. Kalau peringkasan gagal dan konteks hampir penuh, pesan lama dibuang dengan penanda supaya request tidak ditolak. Kalau server menjawab "konteks terlalu besar", Agent meringkas paksa lalu mengulang sekali. Ambang bisa diubah lewat `compactAt` (0.3 sampai 0.95) di config.

**Ukuran jendela** ditebak dari nama model (Claude 200k, Gemini 1M, Llama 3.1+ 128k, dst., default 32k). Kalau tebakannya salah atau provider gratismu punya batas lebih kecil, atur sendiri: `/window 16k`, `/window auto` untuk kembali.

- `/compact [fokus]`: ringkas sekarang, mis. `/compact nama file dan error yang sudah diperbaiki`
- `/usage`: isi konteks (persen dari jendela), token masuk/keluar sesi ini, jumlah compact dan retry. Angka asli dari server kalau ada, tanda `~` kalau estimasi
- Bar status menampilkan `ctx N%`

**Retry.** Error sementara (429, 500/502/503/504/520-524/529, koneksi putus) diulang otomatis sampai 4 kali. Header `retry-after`, `retry-after-ms`, petunjuk di isi error ("try again in 7s", `retryDelay` Gemini) dihormati; kalau tidak ada, jeda naik eksponensial dengan jitter. Hitung mundurnya tampil di bawah kotak input. Tidak diulang: key salah (401/403), request salah (400), kuota atau saldo habis, atau server minta menunggu lebih dari 60 detik (limit harian): langsung dikasih tahu. Kalau jawaban sudah mulai tampil lalu putus, tidak diulang (supaya teks tidak dobel).

## Perintah di chat

`/help` `/provider` `/model` `/key` `/system <teks>` `/tools [on|off]` `/mode [ask|auto|readonly]` `/cwd [folder]` `/compact [fokus]` `/usage` `/window [angka|auto]` `/clear` `/exit`

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
src/api.js        list model, streaming + tool call, retry/backoff, usage (Anthropic + OpenAI-compatible)
src/context.js    estimasi token, pangkas hasil tool, ringkas percakapan lama
src/safefetch.js  HTTP GET dengan pagar SSRF (klasifikasi IP, lookup terjaga, redirect dicek ulang)
src/config.js     simpan config
src/logo.js       logo
test/smoke.js     tes API vs server mock
test/tools.js     tes tool, izin, dan loop agent
test/context.js   tes konteks, retry, usage, auto-compact
test/safefetch.js tes pagar SSRF (semua tes: npm test)
```

## Status

v0.3.0: auto-compact + `/compact` `/usage` `/window`, retry/backoff untuk rate limit, pagar SSRF di `fetch_url`. v0.2.0: tool-use (jalankan perintah, baca/tulis/edit file, cari, fetch URL) dengan mode izin. v0.1.0: tampilan + setup provider/model + chat streaming.

## Lisensi

[MIT](LICENSE) © 2026 AdityaDevID. Repo: <https://github.com/AdityaDevID/elephant-agent>
