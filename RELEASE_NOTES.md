## Elephant Agent v0.1.0

Rilis pertama: tampilan TUI + setup provider/model + chat streaming.

- TUI dengan logo, jalan di Windows, Linux, Termux, ElephantPanel (Node.js 18+, tanpa dependency)
- Pasang API key untuk Claude, ChatGPT, Gemini, Groq, NVIDIA NIM, OpenRouter, Vikey, DeepSeek, Mistral, xAI, Together, Ollama, dan endpoint Custom OpenAI-compatible
- Pencarian provider (ketik, atau paste key langsung untuk deteksi otomatis) dan pencarian model dari daftar live provider
- Chat streaming dengan markdown ringan, paste multi-baris, riwayat input, scroll
- Perintah: /help /provider /model /key /system /clear /exit
- Lisensi MIT; terbit di npm sebagai `elephant-agent` dan `@adityadevid/elephant-agent`
- Config tersimpan di ~/.elephant-agent/config.json (izin 0600)

Catatan: base URL Vikey diisi manual. Belum ada tool-use (file/shell).
