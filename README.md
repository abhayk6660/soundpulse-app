# SoundPulse - Song & YouTube Track Download Tool 🎵

SoundPulse is a full-stack web application for searching, identifying, previewing metadata, and downloading permitted music tracks and videos from YouTube or song name searches.

Built with a focus on modern glassmorphism design, safety, copyright compliance, rate limiting, and temporary file auto-cleanup.

---

## 🌟 Key Features

* **Dual Identification Modes**:
  * **Song Name Search**: Search by track title or artist, preview 5-6 exact matches with title, artist, thumbnail, duration, view count, and license tags.
  * **YouTube URL Inspection**: Validate and preview metadata (title, channel, duration, thumbnail) directly from any YouTube link or Shorts video.
* **Exact Track Selection**: User must select the exact matching track before downloading to avoid incorrect track downloads.
* **Format Options**: Download as **MP3 Audio** or **MP4 Video** for legally permitted content.
* **Copyright & Permission Guard**:
  * Scans metadata for Creative Commons (CC BY) / Public Domain / Royalty Free flags.
  * Requires explicit user rights confirmation before downloading standard YouTube copyrighted content.
  * Clear legal notices and status badges when content is restricted.
* **Real-time Download Progress**: Interactive progress bar tracking media extraction and stream preparation.
* **Security & Clean Architecture**:
  * **Filename Sanitization**: Cleans output names using `sanitize-filename`.
  * **Path Traversal Protection**: Ensures files stay inside UUID job subfolders.
  * **Rate Limiting**: Protects backend APIs against abuse using `express-rate-limit`.
  * **Automatic Cleanup**: Removes temporary files immediately after stream completion, with background sweeps for expired files.

---

## 📁 Project Folder Structure

```
song-download-tool/
├── public/                  # Frontend static files
│   ├── css/
│   │   └── styles.css       # Modern glassmorphic theme styling & animations
│   ├── js/
│   │   └── app.js           # Client-side UI state, API calls & progress polling
│   └── index.html           # Main semantic HTML5 interface
├── utils/                   # Server utility modules
│   ├── downloader.js        # Media download engine, format converter & auto-cleanup
│   └── youtube.js           # YouTube search, URL parser & metadata validator
├── temp_downloads/          # Temp directory for processing files (auto-cleaned)
├── .env                     # Local environment variables
├── .env.example             # Template for configuration settings
├── package.json             # Node.js dependencies and scripts
├── server.js                # Express server entry point & REST API routes
└── README.md                # Comprehensive documentation
```

---

## 🚀 Quick Start & Local Setup

### Prerequisites

* **Node.js**: v18.0.0 or higher
* **npm**: v9.0.0 or higher
* **Python** (Optional/Recommended): Python 3.8+ for `yt-dlp` media extraction engine.

### Installation Steps

1. **Clone or Navigate to Project Directory**:
   ```bash
   cd C:\Users\Abhay\.gemini\antigravity-ide\scratch\song-download-tool
   ```

2. **Install Node.js Dependencies**:
   ```bash
   npm install
   ```

3. **Configure Environment Variables**:
   Copy `.env.example` to `.env`:
   ```bash
   cp .env.example .env
   ```

4. **Launch Development Server**:
   ```bash
   npm run dev
   # or
   npm start
   ```

5. **Access Application**:
   Open your browser and navigate to:
   [http://localhost:5000](http://localhost:5000)

---

## 📡 API Endpoints Reference

| Method | Endpoint | Description |
| :--- | :--- | :--- |
| `GET` | `/api/health` | Service health status |
| `POST` | `/api/search` | Search YouTube tracks by song name query |
| `POST` | `/api/metadata` | Extract detailed metadata from YouTube URL or ID |
| `POST` | `/api/download/request` | Create a download job after permission check |
| `GET` | `/api/download/status/:jobId` | Poll real-time progress of active download job |
| `GET` | `/api/download/file/:jobId` | Stream converted MP3/MP4 file and trigger auto-cleanup |

---

## 🛡️ Security & Legal Compliance Model

1. **Permission Check**: Content with Standard YouTube licenses requires the user to explicitly confirm copyright rights or owner permission via the UI checkbox before download preparation is granted.
2. **Sanitized Child Process Execution**: Arguments passed to `yt-dlp` / system processes are formatted as arrays rather than concatenated command strings, protecting against command injection.
3. **Automatic Cleanup**: Every download job creates a dedicated folder in `temp_downloads/<UUID>`. Files are deleted automatically 2 seconds after stream completion, or by a 10-minute sweep timer.

---

## 🚢 Production Deployment Guide

### Deploying to Render / Railway / Heroku

1. Set Environment Variables in your hosting dashboard:
   * `PORT=5000`
   * `NODE_ENV=production`
   * `TEMP_DIR=./temp_downloads`
2. Ensure python and `yt-dlp` buildpack or binary is available in the deployment container environment.
3. Build & start command: `npm start`.

---

## 📄 License

This project is open-source and intended for educational and permitted media downloading purposes.
