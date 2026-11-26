## Elephant Agent v0.4.0

Agent sekarang bisa bekerja di GitHub lewat token, jalan terus di background sebagai daemon, dan Ollama lokal akhirnya tersambung.

**GitHub (token)**
- `elephant github login` / `/github`: simpan Personal Access Token (disamarkan, file chmod 600, terpisah dari config). Tool `gh_*` muncul setelah token ada: baca repo/issue/PR/Actions, cari kode, commit file, buat branch/PR/issue/komentar, `gh_api` untuk sisanya
- Kalau token kurang izin atau tidak punya akses ke repo, Agent berhenti dan bilang izin apa yang kurang (dari header GitHub), tidak mencoba menembus
- Rate limit GitHub dan jaringan putus ditunggu otomatis lalu dilanjutkan
- `git` lewat `run_command` otomatis terautentikasi ke github.com tanpa menaruh token di URL/file. Token disaring dari semua output tool dan log, dan hanya dikirim ke `api.github.com`
- Merge PR, `DELETE`, dan perubahan sensitif (visibilitas, collaborator, secret, webhook, branch protection) selalu butuh persetujuan

**Daemon**
- `elephant daemon [--detach]` + `send`, `tasks`, `status`, `logs`, `cancel`, `stop`; tugas berulang dengan `--every`; kontrol HTTP lokal opsional (`--http`, wajib token)
- Kena limit, kuota habis, atau internet putus: menunggu lalu menyambung lagi sendiri sampai berhasil
- Tanpa manusia untuk ditanya: mode `auto` (default), `ask` + `--allow`, atau `readonly`. Aksi berbahaya ditolak kecuali `--allow-dangerous`

**Ollama lokal**
- Base URL dirapikan (tanpa `/v1`, `/api`, `0.0.0.0`), `localhost` yang gagal dicoba ulang ke `127.0.0.1`/`[::1]`, daftar model cadangan lewat `/api/tags`, pesan error menyebut `ollama serve` / `ollama pull`, model tanpa dukungan tool lanjut sebagai chat biasa, jendela konteks default 8k

Catatan: mode `auto` di daemon menjalankan perintah dan mengubah file tanpa konfirmasi. Pakai token dengan izin seminimal mungkin dan folder kerja yang aman.
