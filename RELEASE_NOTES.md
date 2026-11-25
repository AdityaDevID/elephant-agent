## Elephant Agent v0.2.0

Sekarang Elephant bukan cuma chat: dia bisa bertindak. Tool-use sudah ada.

- Tool baru: `run_command` (jalankan perintah shell), `read_file`, `write_file`, `edit_file`, `list_dir`, `search` (regex), `fetch_url`
- Loop agent: model memanggil tool, hasilnya dikirim balik, berulang sampai tugas selesai (maks 30 langkah per pesan)
- Izin: mode `ask` (default, baca otomatis, aksi lain ditanya: y / a = selalu di sesi / n), `auto`, dan `readonly`. Perintah berbahaya selalu ditanya
- Perintah baru: `/tools on|off`, `/mode`, `/cwd`; mode tampil di status bar
- Jalan di Claude, ChatGPT, Gemini, Groq, OpenRouter, dan semua endpoint OpenAI-compatible yang mendukung tool-calling
- Esc / Ctrl+C menghentikan jawaban sekaligus proses yang sedang berjalan
- Tetap tanpa dependency (Node.js 18+), jalan di Windows, Linux, Termux, ElephantPanel

Catatan: ini bukan sandbox. Agent memakai hak akses akun kamu, baca perintahnya sebelum menyetujui. Model yang tidak mendukung tool bisa error: pakai `/tools off` atau ganti model.
