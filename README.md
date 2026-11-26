# Elephant Agent

Agent AI di terminal. Bisa **menjalankan perintah, membaca/menulis/mengedit file, mencari kode, mengambil halaman web, dan bekerja di GitHub (token)** lewat tool-use, dengan izin dari kamu. Bisa juga jalan terus sebagai **daemon** yang mengerjakan perintah dari antrean. Tampilan TUI lengkap, API key multi-provider, pencarian provider & model. **Tanpa dependency** (cuma butuh Node.js 18+), jalan di Windows, Linux, Termux, dan ElephantPanel.

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

## GitHub (Personal Access Token)

Kasih Agent akses ke GitHub-mu lewat token, dan dia bisa baca repo, buka issue/PR, commit file, cek Actions, atau `git clone`/`push`.

```bash
elephant github login      # tempel token (tidak ditampilkan). Atau: echo $TOKEN | elephant github login
elephant github status     # akun, jenis token, scope, sisa rate limit
elephant github logout
```

Di chat: `/github` (form token), `/github status`, `/github logout`. Token juga dibaca dari env `ELEPHANT_GITHUB_TOKEN`, `GITHUB_TOKEN`, atau `GH_TOKEN`.

Buat token di <https://github.com/settings/tokens>: *classic* dengan scope `repo` (+ `workflow` kalau mau menyentuh Actions), atau *fine-grained* dengan izin Contents, Pull requests, Issues pada repo yang dipilih.

| Tool | Fungsi | Izin (mode `ask`) |
| --- | --- | --- |
| `gh_whoami`, `gh_repo_info`, `gh_list_repos` | cek token, izin di repo, daftar repo | otomatis |
| `gh_read`, `gh_list_issues`, `gh_get_issue`, `gh_actions`, `gh_search_code` | baca file/folder, issue, PR, workflow run, cari kode | otomatis |
| `gh_write_file`, `gh_delete_file`, `gh_create_branch`, `gh_create_pr`, `gh_create_issue`, `gh_comment` | commit file, branch, PR, issue, komentar | tanya |
| `gh_merge_pr` | merge PR | **selalu** tanya |
| `gh_api` | panggilan REST bebas (GET otomatis, lainnya tanya) | tanya |

- Tool GitHub hanya ditawarkan ke model kalau token sudah diset (hemat konteks, penting untuk model lokal kecil). Tanpa token, Agent diberi tahu untuk menyuruhmu menjalankan `/github`.
- **Kalau akses kurang, Agent bilang.** Jawaban GitHub 401/403/404 diterjemahkan jadi pesan yang menyebut izin apa yang dibutuhkan (dari header `X-Accepted-GitHub-Permissions`), scope token sekarang, dan repo mana yang belum di-grant. Agent berhenti di aksi itu dan melaporkannya, tidak mencoba menembus.
- **Rate limit & jaringan putus ditunggu otomatis** (hormati `Retry-After` / `X-RateLimit-Reset`), lalu lanjut sendiri. Di chat batas tunggunya 2 menit; di daemon sampai 1 jam.
- `git` lewat `run_command` otomatis terautentikasi ke github.com (header dipasang lewat env, token tidak masuk URL atau file `.git`). Matikan dengan menaruh `"gitAuth": false` di `github.json`.
- Token disimpan di `~/.elephant-agent/github.json` (chmod 600), terpisah dari `config.json`. Dikirim **hanya** ke `api.github.com` (path `gh_api` harus diawali `/`, URL penuh ditolak), tidak pernah ke provider AI, dan disaring dari semua output tool & log (termasuk header git versi base64).
- Aksi berdampak besar (merge PR, `DELETE`, ubah visibilitas/collaborator/secret/webhook/branch protection) **selalu** ditanya, juga di mode `auto`.

## Daemon: aktif terus, bertindak sesuai perintah

Mode tanpa layar: Agent jalan di background dan mengerjakan perintah dari antrean satu per satu, selama belum kamu matikan.

```bash
elephant daemon --detach                     # jalan di background (tanpa --detach: foreground)
elephant send "cek issue baru di AdityaDevID/chessy dan ringkas"
elephant send --every 30m "pantau Actions repo X, kalau gagal buat issue"   # berulang
elephant tasks                               # antrean & tugas berulang
elephant status                              # status daemon, tugas yang sedang jalan, hasil terakhir
elephant logs -f                             # ikuti log
elephant cancel t3                           # batalkan / hentikan tugas
elephant stop                                # matikan daemon
```

Perlu provider + model yang sudah dipilih lewat TUI (`elephant`) sekali. Opsi `elephant daemon`:

| Opsi | Arti |
| --- | --- |
| `--mode auto\|ask\|readonly` | izin tanpa manusia. `auto` (default): semua jalan kecuali aksi berbahaya. `ask`: hanya baca + tool di `--allow`. `readonly`: baca saja |
| `--allow a,b` | tool yang diizinkan di mode `ask`, mis. `run_command,gh_write_file` |
| `--allow-dangerous` | izinkan aksi berbahaya (merge PR, `DELETE`, `rm -rf`, dst.). Default: **ditolak** dan dilaporkan |
| `--cwd <folder>` | folder kerja (default: folder sekarang) |
| `--max-steps <n>` | batas langkah tool per tugas (default 40) |
| `--http [port]` | kontrol HTTP di `127.0.0.1` (default 7733), wajib `Authorization: Bearer <token>` (`elephant status --show-token`). `POST /task {"text","every"}`, `GET /status`, `DELETE /task/<id>`, `POST /stop` |
| `--detach` | lepas dari terminal |

- **Limit / koneksi putus = tunggu lalu lanjut.** Kena rate limit, kuota habis, server sibuk, atau internet mati di tengah tugas: daemon menunggu (backoff 15 dtk sampai 10 menit, hormati `Retry-After`) lalu menyambung lagi ke langkah yang sama, tanpa batas percobaan. Tugas tidak hilang. Yang tidak ditunggu hanya error permanen (API key ditolak, model tidak ada); tugas itu ditandai GAGAL dan daemon lanjut ke tugas berikutnya.
- Tugas masuk lewat folder `inbox` (juga bisa menjatuhkan file `.txt` ke `~/.elephant-agent/daemon/inbox/`), antrean disimpan di disk, jadi aman walau daemon belum jalan atau di-restart. Tugas yang terputus saat daemon dimatikan diulang dari awal.
- Hasil tiap tugas ada di `~/.elephant-agent/daemon/results/`, log di `daemon.log`. Tugas berulang membawa ringkasan run sebelumnya sebagai catatan.
- Tidak ada yang bisa ditanya saat daemon jalan, jadi izin ditentukan kebijakan di atas. **Mode `auto` berarti Agent menjalankan perintah dan mengubah file tanpa konfirmasi.** Jalankan di folder yang aman, pakai token dengan izin seminimal mungkin (fine-grained, hanya repo yang perlu), dan jangan arahkan ke konten yang tidak kamu percaya.
- Di ElephantPanel / Termux: `elephant daemon --detach` lalu tutup terminalnya; proses tetap hidup.

## Ollama (lokal)

Pilih provider **Ollama (lokal)**; Base URL default `http://127.0.0.1:11434` (ikut `OLLAMA_HOST` kalau diset). Ollama harus sedang jalan (`ollama serve` atau app Ollama) dan minimal satu model sudah diunduh (`ollama pull llama3.2`).

Yang ditangani otomatis: Base URL tanpa `/v1` atau dengan `/api` dirapikan; `localhost` yang ditolak (kasus `::1` di Node baru) dicoba ulang ke `127.0.0.1`; kalau `/v1/models` tidak ada, daftar model diambil dari `/api/tags`; error "belum jalan" dan "model belum diunduh" menyebut perintah perbaikannya; model yang menolak tool (`does not support tools`) otomatis lanjut sebagai chat biasa; jendela konteks default dikecilkan ke 8k karena Ollama diam-diam memotong prompt yang melebihi konteks servernya (naikkan dengan `/window 32k` setelah kamu menaikkan `OLLAMA_CONTEXT_LENGTH` di server).

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

v0.4.0: akses GitHub lewat token, mode daemon (aktif terus, auto-reconnect setelah limit), perbaikan Ollama lokal. v0.3.0: auto-compact + `/compact` `/usage` `/window`, retry/backoff untuk rate limit, pagar SSRF di `fetch_url`. v0.2.0: tool-use (jalankan perintah, baca/tulis/edit file, cari, fetch URL) dengan mode izin. v0.1.0: tampilan + setup provider/model + chat streaming.

## Lisensi

[MIT](LICENSE) © 2026 AdityaDevID. Repo: <https://github.com/AdityaDevID/elephant-agent>
