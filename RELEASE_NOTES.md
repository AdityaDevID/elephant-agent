## Elephant Agent v0.3.0

Percakapan panjang tidak lagi bikin konteks meledak, error rate limit diulang otomatis, dan `fetch_url` tidak bisa dipakai membobol jaringan lokal.

- Auto-compact: kalau konteks lewat 75% jendela model, hasil tool lama dipotong dulu, lalu percakapan lama diringkas model. Pesan terbaru tetap utuh
- `/compact [fokus]` untuk meringkas manual, `/usage` untuk melihat isi konteks dan token terpakai (masuk/keluar), `/window` untuk mengatur ukuran jendela konteks. Bar status menampilkan `ctx N%`
- Kalau server menolak karena konteks kepenuhan, Agent meringkas paksa lalu mencoba lagi sekali
- Retry + backoff untuk 429, 5xx, dan koneksi putus (maks 4 kali), menghormati `retry-after`. Hitung mundur tampil di layar. Kuota/saldo habis dan limit harian tidak diulang, langsung diberi tahu
- `fetch_url` sekarang diblokir ke localhost, 127.x, 10.x, 172.16-31.x, 192.168.x, CGNAT, IPv6 lokal, dan bentuk samaran (angka desimal, hex, `::ffff:127.0.0.1`). Dicek saat koneksi dan setiap redirect, jadi tahan DNS rebinding
- Akses ke alamat private (mis. Ollama / server LAN) tetap bisa, tapi Agent bertanya dulu per host:port, juga di mode `auto`. Alamat metadata cloud (`169.254.x.x`) tidak pernah diizinkan
- Teks dari web, file, dan output perintah diperlakukan sebagai data, bukan perintah (ditambahkan ke instruksi Agent)

Catatan: ukuran jendela konteks ditebak dari nama model. Kalau providermu punya batas lebih kecil (mis. paket gratis), atur dengan `/window 16k`. Pagar SSRF hanya melindungi `fetch_url`; `run_command` tetap bisa memanggil `curl` kalau kamu menyetujuinya.
