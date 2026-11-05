# ⚡ MIAS LITE MDX

> High-performance, multi-device WhatsApp automation bot and web pairing dashboard built with Node.js and [Baileys](https://github.com/WhiskeySockets/Baileys).

---

## 🌟 Features

- **Web-Based Pairing Dashboard**: Fast QR code and 8-digit pairing code generation through an intuitive web interface.
- **Multi-Device Support**: Connect and supervise multiple numbers concurrently with automated session recovery.
- **Admin Panel**: Live system metrics, active session controls, memory and CPU stats, and real-time logs.
- **Media & Downloader Suite**:
  - **TikTok**: No-watermark video downloads, audio rips, and HD streams.
  - **YouTube**: Audio (MP3) and Video (MP4) scraping and streaming.
  - **Instagram / Facebook / Spotify**: Unified media fetching pipeline.
- **Anime Edits & AMV Library**: Built-in curated video library featuring dozens of popular anime series.
- **Group Management**: Administrative commands including kick, add, promote, demote, tagall, hidetag, antilink, and welcome cards.
- **Sticker Studio**: Create static and animated WhatsApp stickers on the fly using Sharp and Canvas.
- **Persistent Storage**: Resilient session storage across local volume and PostgreSQL (Neon / Railway).
- **Crash-Resilient Architecture**: Automated process supervision, health checks, and graceful reconnection.

---

## 🚀 Quick Start

### Prerequisites

- **Node.js**: v20.x or v22.x LTS
- **FFmpeg**: Required for media conversion
- **Git**

### Installation

1. **Clone the repository:**
   ```bash
   git clone https://github.com/precious125588/MIAS-LITE-MDX.git
   cd MIAS-LITE-MDX
   ```

2. **Install dependencies:**
   ```bash
   npm install
   npm run setup
   ```

3. **Configure Environment:**
   Create a `.env` file based on `.env.example`:
   ```bash
   cp .env.example .env
   ```

4. **Start the server:**
   ```bash
   npm start
   ```

5. **Open Web Dashboard:**
   Visit `http://localhost:3000` in your browser to pair your WhatsApp account via phone number or QR code.

---

## ⚙️ Environment Configuration

| Variable | Description | Default |
|---|---|---|
| `PORT` | Web server port | `3000` |
| `ADMIN_USERNAME` | Web dashboard admin username | `admin` |
| `ADMIN_PASSWORD` | Web dashboard admin password | (optional) |
| `DATABASE_URL` | PostgreSQL connection string for session persistence | (optional) |
| `SESSION_DIR` | Directory for local session files | `/app/nexstore` |
| `CREATOR_USERNAME` | Primary creator / bot author handle | `precious125588` |

---

## 🚢 Deployment

### Railway / Render / VPS

This repository is pre-configured for automated deployment:
- **Procfile** and **railway.toml** are ready out of the box.
- Set your required environment variables in your hosting dashboard.
- The build command runs `bash scripts/robust-install.sh .` and boots via `node server.js`.

---

## 📜 License & Credits

Built with ❤️ by **Precious** ([@precious125588](https://github.com/precious125588)) and the MAIS community.
Licensed under the [MIT License](LICENSE).
