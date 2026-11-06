<div align="center">

# ⚡ MIAS LITE MDX

### Next-Generation WhatsApp Multi-Device Automation Engine & Live Pairing Dashboard

[![Node.js](https://img.shields.io/badge/Node.js-v20%20%7C%20v22-339933?style=for-the-badge&logo=nodedotjs&logoColor=white)](https://nodejs.org/)
[![Baileys](https://img.shields.io/badge/Engine-Baileys%20v0.4.0-25D366?style=for-the-badge&logo=whatsapp&logoColor=white)](https://github.com/WhiskeySockets/Baileys)
[![Maintenance](https://img.shields.io/badge/Maintained%3F-Yes%20(Active)-brightgreen?style=for-the-badge&logo=githubactions&logoColor=white)](https://github.com/precious125588/MIAS-LITE-MDX)
[![Pairing Dashboard](https://img.shields.io/badge/Pairing_Dashboard-Online-0088cc?style=for-the-badge&logo=googlechrome&logoColor=white)](https://web-production-0a742.up.railway.app/)
[![License](https://img.shields.io/badge/License-MIT-orange?style=for-the-badge)](LICENSE)

<br/>

<a href="https://web-production-0a742.up.railway.app/">
  <img src="https://img.shields.io/badge/CLICK%20TO%20GET%20SESSION%20ID-25D366?style=for-the-badge&logo=whatsapp&logoColor=white" height="42" alt="Click to get Session ID"/>
</a>

<p>
  <strong>Direct Pairing Dashboard:</strong>
  <a href="https://web-production-0a742.up.railway.app/">https://web-production-0a742.up.railway.app/</a>
</p>

</div>

---

## 📑 Quick Navigation

- [🔗 Get Session ID](#-pair-your-whatsapp-account--get-session-id)
- [❓ Bot Maintenance & FAQ](#-frequently-asked-questions--maintenance)
- [🌟 Key Capabilities](#-key-capabilities)
- [🚀 Quick Start](#-quick-start)
- [⚙️ Environment Variables](#️-environment-configuration)
- [🚢 24/7 Deployment Guide](#-247-deployment-guide)

---

## 🔗 Pair Your WhatsApp Account / Get Session ID

You do **not** need to copy complex session tokens manually or inspect terminal logs. Pairing is handled via the live web pairing portal:

<div align="center">

### 👉 [Click Here to Open Pairing Dashboard](https://web-production-0a742.up.railway.app/) 👈

</div>

1. Open the [Pairing Dashboard](https://web-production-0a742.up.railway.app/).
2. Enter your full WhatsApp phone number including your country code (e.g., `2348012345678`).
3. Click **Request Pairing Code**.
4. WhatsApp will send a notification to your device: **Link a Device → Link with Phone Number**.
5. Type the 8-digit code shown on screen.
6. Your bot will automatically connect, display your profile push name on the live dashboard, and begin servicing commands!

---

## ❓ Frequently Asked Questions & Maintenance

### 🔹 Does it maintain?
**Yes!** MIAS LITE MDX is actively maintained and designed for high resilience:
- **Automatic Multi-Device Recovery**: Native Baileys reconnect routines catch WhatsApp socket resets and re-establish sessions automatically.
- **Process Supervision**: Background child workers run with dedicated memory tuning (`cgroup v1/v2` auto-sizing) to prevent container OOM aborts.
- **Persistent Storage**: Credentials, active settings, group permissions, and contact caches persist across container redeploys and restarts via persistent volumes (`/app/nexstore`) and PostgreSQL database sync.
- **Anti-Conflict Shield**: Stale or duplicate sessions are quarantined to avoid WhatsApp 401/440 session conflicts.

### 🔹 Do settings reset after restart?
**No.** All settings (including prefix, anti-link, auto-read, welcome triggers, and customized preferences) are stored atomically in durable JSON storage located on the persistent mount (`AUTH_DIR/database/legacy-settings.json` and PostgreSQL). Settings survive container restarts and deploys.

### 🔹 What about group creation (`.creategc`)?
The `.creategc` command supports format:
```text
.creategc <GroupName> [| phone numbers] [| description]
```
Example: `.creategc Study Squad | 2348012345678, 15551234567 | Welcome to our group!`
LID JIDs are safely mapped to true phone numbers or filtered out, preventing WhatsApp `bad-request` errors.

### 🔹 Can other users rent bots?
**Yes.** Use `.rentbot`, `.listbot`, and `.delbot` to manage up to 2 isolated sub-bots with session management and DM credentials delivery.

---

## 🌟 Key Capabilities

- **Live Web Status Dashboard**:
  - Displays online status, real WhatsApp profile name (`Bot is live for <Username>`), connected WhatsApp ID, and live uptime.
  - Public status reporting without leaking internal session secrets or disk paths.
- **Media & Downloader Pipeline**:
  - **TikTok Studio**: HD and 4K processing with quality preservation and lossless document delivery (files up to 95MB).
  - **Anime AMVs**: Curated collection of high-resolution anime clips with instant WhatsApp delivery.
  - **YouTube & Social Media**: High-speed MP3 audio ripping and MP4 streaming.
  - **Stickers**: WebP animated sticker generation and meme captions via Sharp and Canvas.
- **Group Administration**:
  - Administrative toolset: kick, add, promote, demote, tagall, hidetag, antilink, welcome cards, and group locks.
- **Resilient Multi-Database Engine**:
  - Supports Railway PostgreSQL, Neon serverless, local NVMe volumes, and Redis caching.

---

## 🚀 Quick Start

### Prerequisites

- **Node.js**: v20.x or v22.x LTS
- **FFmpeg**: Installed on PATH (for media re-encoding and audio conversions)
- **Git**

### Installation

```bash
# 1. Clone the repository
git clone https://github.com/precious125588/MIAS-LITE-MDX.git
cd MIAS-LITE-MDX

# 2. Install dependencies
npm install
npm run setup

# 3. Configure environment
cp .env.example .env

# 4. Launch the server and bot
npm start
```

Visit `http://localhost:3000` in your browser to view the local dashboard.

---

## ⚙️ Environment Configuration

| Variable | Description | Default |
|---|---|---|
| `PORT` | Web server listening port | `3000` |
| `SESSION_ID` | Base64 or ID credentials token (if pre-configured) | `""` |
| `ADMIN_USERNAME` | Web dashboard admin login | `admin` |
| `ADMIN_PASSWORD` | Web dashboard admin password | `""` |
| `DATABASE_URL` | PostgreSQL connection string for cloud session storage | `""` |
| `SESSION_DIR` | Base directory for local session files | `/app/nexstore` |
| `CREATOR_USERNAME` | Bot author / primary handle | `precious125588` |
| `BOT_CHILD_HEAP_MB` | V8 heap limit per worker process | `Auto-sized` |

---

## 🚢 24/7 Deployment Guide

This repository includes pre-built hosting configs for **Railway**, **Render**, and **VPS**:

- **Railway**: Connect your GitHub repository. The `Procfile` and `railway.toml` configure automatic dependency installation (`scripts/robust-install.sh`) and start via `node server.js`. Mount a persistent volume at `/app/nexstore` for 100% state durability.
- **Render / VPS**: Set Environment variables, ensure `ffmpeg` is available on the host, and run `npm start` with `pm2` (`pm2 start ecosystem.config.js`).

---

## 📜 License & Acknowledgments

Created with ❤️ by **Precious** ([@precious125588](https://github.com/precious125588)) and the MAIS MDX community.
Licensed under the [MIT License](LICENSE).
