# Bot WhatsApp Node.js

Bot WhatsApp sederhana menggunakan `whatsapp-web.js`.

## Fitur

- Login dengan QR code
- Login dengan pairing code
- Session disimpan otomatis
- Command dasar:
  - `.ping`
  - `.menu`
  - `.echo <teks>`
  - `.simi <teks>`
  - `.info`
  - `.antilink on/off`
- Menu download:
  - `.dlmenu`
  - `.tt <url/kata kunci>`
  - `.spotifyplay <judul lagu>`
  - `.play <judul lagu>`
  - `.ytmp3 <url>`
  - `.ytmp4 <url>`
  - `.dlit <platform> <url>`
- Menu owner:
  - `.ownermenu`
  - `.self`
  - `.public`
  - `.status`
  - `.addowner <nomor>`
  - `.addprem <nomor>`
- Tools:
  - `.s`
  - `.sticker`
  - `.brat <teks>`
  - `.animebrat <teks>`
  - `.hdvideo`
  - `.tourl`

## Cara menjalankan

1. Install dependency:

```bash
npm install
```

2. Jalankan bot:

```bash
npm start
```

3. Scan QR yang muncul di terminal menggunakan WhatsApp pada ponsel.

## Login dengan pairing code

1. Set nomor WhatsApp yang ingin dipairing:

```bash
$env:PAIRING_NUMBER="6281234567890"
```

2. Jalankan bot:

```bash
npm start
```

3. Masukkan pairing code yang muncul di terminal pada WhatsApp:
   `Perangkat tertaut > Tautkan dengan nomor telepon`

## Catatan

- Session login akan tersimpan di folder `.wwebjs_auth`.
- Jika `PAIRING_NUMBER` tidak diisi, bot otomatis kembali memakai QR code.
- Opsional: `SHOW_PAIRING_NOTIFICATION=false` untuk mematikan notifikasi pairing.
- Opsional: `PAIRING_INTERVAL_MS=180000` untuk mengatur interval refresh code.
- Opsional: `PAIRING_CODE_TIMEOUT_MS=25000` untuk mengatur kapan bot menampilkan peringatan jika pairing code belum muncul.
- Jika pairing terasa lama, seringnya penyebabnya WhatsApp Web masih loading atau session lama di folder `.wwebjs_auth` sedang dipulihkan.
- Terminal sekarang menampilkan timestamp dan durasi startup untuk tahap `BOOT`, `LOADING`, `STATE`, `PAIRING`, `AUTH`, `READY`, dan `DISCONNECTED`.
- Jika ingin ganti prefix command, ubah konstanta `PREFIX` di `index.js`.
- Ubah `OWNER_NUMBER` di `index.js` ke nomor WhatsApp owner, format internasional tanpa tanda `+`.
- Data owner dan premium disimpan di `database.json`.
- Setting anti-link per grup juga disimpan di `database.json`.
- Pada server tertentu, Chromium/Puppeteer mungkin butuh dependency tambahan.
- Fitur `.dlit` mendukung download dari Instagram, TikTok, dan Facebook memakai endpoint eksternal.
- Fitur `.tt`, `.ttdl`, dan `.tiktok` mendukung link TikTok langsung atau pencarian kata kunci, termasuk audio jika tersedia.
- Fitur `.spotifyplay` dan `.spplay` mencari lagu Spotify lalu mengirim audio langsung ke WhatsApp.
- Fitur `.play` mencari video YouTube dan menampilkan hasil utama beserta opsi `.ytmp3` dan `.ytmp4`.
- Fitur `.simi` memakai endpoint AI eksternal, jadi bot butuh koneksi internet saat command dipakai.
- Fitur `.animebrat` membuat sticker teks anime brat dari API eksternal lalu mengirimkannya sebagai sticker WhatsApp.
- Fitur `.brat` membuat sticker brat biasa dari teks langsung atau dari pesan yang direply.
- Fitur `.hdvideo` memproses video lewat layanan enhancer eksternal dan mengirim hasil video 2K ke WhatsApp.
- Fitur `.tourl` mengupload media ke CDN eksternal dan mengembalikan URL hasil upload.
- Fitur `.antilink on/off` bisa dipakai di grup oleh owner bot atau admin grup untuk menghapus pesan berisi link grup WhatsApp lain.
- Fitur sticker bisa dipakai dengan kirim gambar memakai caption `.s` atau reply gambar lalu kirim `.s`.
