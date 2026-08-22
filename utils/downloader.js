const fs = require('fs');
const path = require('path');
const { spawn, execSync } = require('child_process');
const sanitize = require('sanitize-filename');
const { v4: uuidv4 } = require('uuid');
const { extractVideoId, getVideoMetadata } = require('./youtube');

// Active download job status registry
const activeJobs = new Map();

// Root temp downloads folder
const TEMP_DIR = path.resolve(process.env.TEMP_DIR || './temp_downloads');

// Ensure base temp directory exists
if (!fs.existsSync(TEMP_DIR)) {
  fs.mkdirSync(TEMP_DIR, { recursive: true });
}

function normalizeCookieContent(content) {
  if (!content) return '';
  const lines = content.split(/[\r\n]+/);
  const normalizedLines = [];
  
  for (let line of lines) {
    line = line.trim();
    if (!line) continue;
    if (line.startsWith('#')) {
      normalizedLines.push(line);
      continue;
    }
    // Convert space-separated cookie lines into valid tab-separated Netscape format
    const parts = line.split(/\s+/);
    if (parts.length >= 7) {
      const domain = parts[0];
      const flag = parts[1];
      const path = parts[2];
      const secure = parts[3];
      const expiration = parts[4];
      const name = parts[5];
      const value = parts.slice(6).join(' ');
      normalizedLines.push(`${domain}\t${flag}\t${path}\t${secure}\t${expiration}\t${name}\t${value}`);
    } else {
      normalizedLines.push(line);
    }
  }
  return '# Netscape HTTP Cookie File\n' + normalizedLines.join('\n') + '\n';
}

// Cookies support: If YOUTUBE_COOKIES or YOUTUBE_COOKIES_BASE64 is present, save to cookies.txt
const COOKIES_FILE = path.join(__dirname, '../cookies.txt');
if (process.env.YOUTUBE_COOKIES_BASE64) {
  try {
    const decoded = Buffer.from(process.env.YOUTUBE_COOKIES_BASE64, 'base64').toString('utf8');
    fs.writeFileSync(COOKIES_FILE, normalizeCookieContent(decoded), 'utf8');
    console.log('[Cookies] Successfully wrote normalized cookies.txt from YOUTUBE_COOKIES_BASE64.');
  } catch (e) {
    console.warn('[Cookies] Failed to decode YOUTUBE_COOKIES_BASE64:', e.message);
  }
} else if (process.env.YOUTUBE_COOKIES) {
  try {
    const raw = process.env.YOUTUBE_COOKIES.replace(/\\n/g, '\n');
    fs.writeFileSync(COOKIES_FILE, normalizeCookieContent(raw), 'utf8');
    console.log('[Cookies] Successfully wrote normalized cookies.txt from YOUTUBE_COOKIES.');
  } catch (e) {
    console.warn('[Cookies] Failed to write cookies.txt:', e.message);
  }
} else if (fs.existsSync(COOKIES_FILE)) {
  try {
    const existing = fs.readFileSync(COOKIES_FILE, 'utf8');
    fs.writeFileSync(COOKIES_FILE, normalizeCookieContent(existing), 'utf8');
  } catch (e) {}
}

/**
 * Clean up job directory safely
 * @param {string} jobId 
 */
function cleanupJob(jobId) {
  if (!jobId) return;
  const jobFolder = path.join(TEMP_DIR, sanitize(jobId));
  try {
    if (fs.existsSync(jobFolder)) {
      fs.rmSync(jobFolder, { recursive: true, force: true });
      console.log(`[CleanUp] Successfully removed temp job directory: ${jobId}`);
    }
  } catch (err) {
    console.error(`[CleanUp] Error cleaning up job ${jobId}:`, err.message);
  }
  activeJobs.delete(jobId);
}

/**
 * Periodically clean up old temp download folders (>10 minutes old)
 */
function scheduleAutoCleanup() {
  const TEN_MINUTES_MS = 10 * 60 * 1000;
  setInterval(() => {
    try {
      if (!fs.existsSync(TEMP_DIR)) return;
      const entries = fs.readdirSync(TEMP_DIR, { withFileTypes: true });
      const now = Date.now();

      for (const entry of entries) {
        if (entry.isDirectory()) {
          const folderPath = path.join(TEMP_DIR, entry.name);
          const stats = fs.statSync(folderPath);
          if (now - stats.mtimeMs > TEN_MINUTES_MS) {
            fs.rmSync(folderPath, { recursive: true, force: true });
            console.log(`[AutoSweep] Cleaned expired temp folder: ${entry.name}`);
          }
        }
      }
    } catch (e) {
      console.error('[AutoSweep] Error sweeping temp directory:', e.message);
    }
  }, 5 * 60 * 1000); // Run every 5 minutes
}

// Start background sweep
scheduleAutoCleanup();

/**
 * Detect available yt-dlp execution strategy (standalone binary or python -m yt_dlp)
 * @returns {{ cmd: string, argsPrefix: string[] }}
 */
function getYtDlpCommand() {
  try {
    const binPath = path.resolve(__dirname, '../node_modules/yt-dlp-exec/bin/yt-dlp') + (process.platform === 'win32' ? '.exe' : '');
    if (fs.existsSync(binPath)) {
      return { cmd: binPath, argsPrefix: [] };
    }
  } catch (e) {}

  try {
    execSync('yt-dlp --version', { stdio: 'ignore' });
    return { cmd: 'yt-dlp', argsPrefix: [] };
  } catch (e) {
    try {
      execSync('python3 -m yt_dlp --version', { stdio: 'ignore' });
      return { cmd: 'python3', argsPrefix: ['-m', 'yt_dlp'] };
    } catch (e2) {
      try {
        execSync('python -m yt_dlp --version', { stdio: 'ignore' });
        return { cmd: 'python', argsPrefix: ['-m', 'yt_dlp'] };
      } catch (e3) {
        console.warn('[Downloader] Warning: yt-dlp is not available on PATH or python pip.');
        return { cmd: 'yt-dlp', argsPrefix: [] };
      }
    }
  }
}

/**
 * Initialize a download job with permission validation
 * @param {Object} options
 * @param {string} options.urlOrId - YouTube URL or video ID
 * @param {string} options.format - 'mp3' or 'mp4'
 * @param {boolean} options.hasPermission - User checkbox/flag confirming permission or copyright rights
 * @returns {Promise<Object>} Job details with jobId
 */
async function prepareDownloadJob({ urlOrId, format = 'mp3', hasPermission = false }) {
  const videoId = extractVideoId(urlOrId);
  if (!videoId) {
    throw new Error('Invalid YouTube URL or Video ID.');
  }

  // Fetch full metadata for license and title check
  const metadata = await getVideoMetadata(videoId);

  // Legal / Copyright check:
  // Downloader proceeds ONLY if content is explicitly marked as Permitted (Creative Commons / Royalty Free / Public Domain)
  // OR if the user explicitly confirms they have permission/license/ownership rights.
  if (!metadata.isPermitted && !hasPermission) {
    const error = new Error('Permission Required: This content has a Standard YouTube License. Downloads are restricted unless you confirm you own the rights or have explicit permission from the copyright holder.');
    error.statusCode = 403;
    error.isCopyrightBlock = true;
    error.metadata = metadata;
    throw error;
  }

  const selectedFormat = format.toLowerCase() === 'mp4' ? 'mp4' : 'mp3';
  const jobId = uuidv4();
  const jobFolder = path.join(TEMP_DIR, jobId);

  fs.mkdirSync(jobFolder, { recursive: true });

  const cleanTitle = sanitize(metadata.title).substring(0, 100) || `video_${videoId}`;
  const outputFilename = `${cleanTitle}.${selectedFormat}`;
  const targetFilePath = path.join(jobFolder, outputFilename);

  // Path Traversal Guard: Ensure final file path stays strictly inside jobFolder
  const resolvedTarget = path.resolve(targetFilePath);
  const resolvedJobFolder = path.resolve(jobFolder);
  if (!resolvedTarget.startsWith(resolvedJobFolder)) {
    throw new Error('Security Violation: Invalid file output path.');
  }

  const jobState = {
    jobId,
    videoId,
    metadata,
    format: selectedFormat,
    outputFilename,
    targetFilePath,
    jobFolder,
    status: 'pending', // pending -> downloading -> completed -> failed
    progress: 0,
    downloadedBytes: 0,
    totalBytes: 0,
    error: null,
    createdAt: Date.now()
  };

  activeJobs.set(jobId, jobState);

  // Start background download process
  executeDownload(jobState);

  return {
    jobId,
    metadata,
    format: selectedFormat,
    status: jobState.status,
    outputFilename
  };
}

/**
 * Execute yt-dlp child process safely using yt-dlp-exec
 * @param {Object} jobState 
 */
function executeDownload(jobState) {
  jobState.status = 'downloading';

  const ytDlpExec = require('yt-dlp-exec');
  const targetUrl = `https://www.youtube.com/watch?v=${jobState.videoId}`;

  let ffmpegPath = null;
  try {
    ffmpegPath = require('ffmpeg-static');
  } catch (e) {
    console.warn('[Downloader] ffmpeg-static module not loaded:', e.message);
  }

  const options = {
    remoteComponents: 'ejs:github',
    jsRuntimes: 'node',
    extractorArgs: 'youtube:player_client=ios,android',
    noCheckCertificates: true,
    noWarnings: true,
    noPlaylist: true,
    output: jobState.targetFilePath
  };

  if (fs.existsSync(COOKIES_FILE)) {
    options.cookies = COOKIES_FILE;
  }

  if (process.env.YOUTUBE_PROXY || process.env.HTTP_PROXY) {
    options.proxy = process.env.YOUTUBE_PROXY || process.env.HTTP_PROXY;
  }

  if (ffmpegPath && fs.existsSync(ffmpegPath)) {
    options.ffmpegLocation = ffmpegPath;
  }

  if (jobState.format === 'mp3') {
    options.format = 'bestaudio/best';
    options.extractAudio = true;
    options.audioFormat = 'mp3';
    options.audioQuality = '0';
  } else {
    options.format = 'bestvideo+bestaudio/best';
    options.recodeVideo = 'mp4';
  }

  console.log(`[Downloader] Spawning yt-dlp-exec for Job ${jobState.jobId}...`);

  const proc = ytDlpExec.exec(targetUrl, options);

  if (proc.stdout) {
    proc.stdout.on('data', (data) => {
      const text = data.toString();
      const match = text.match(/\[download\]\s+([\d\.]+)%/);
      if (match && match[1]) {
        const pct = parseFloat(match[1]);
        if (!isNaN(pct)) {
          jobState.progress = Math.min(99, Math.max(1, pct));
        }
      }
    });
  }

  if (proc.stderr) {
    proc.stderr.on('data', (data) => {
      console.warn(`[Downloader yt-dlp stderr ${jobState.jobId}]:`, data.toString().trim());
    });
  }

  proc.then(() => {
    const filesInFolder = fs.existsSync(jobState.jobFolder) ? fs.readdirSync(jobState.jobFolder) : [];
    const createdFile = filesInFolder.find(f => !f.endsWith('.zip') && !fs.statSync(path.join(jobState.jobFolder, f)).isDirectory());

    if (fs.existsSync(jobState.targetFilePath) || createdFile) {
      if (!fs.existsSync(jobState.targetFilePath) && createdFile) {
        jobState.targetFilePath = path.join(jobState.jobFolder, createdFile);
        jobState.outputFilename = createdFile;
      }
      console.log(`[Downloader Complete ${jobState.jobId}]: ${jobState.outputFilename}`);
      jobState.status = 'completed';
      jobState.progress = 100;
    } else {
      console.error(`[Downloader Failed ${jobState.jobId}]: Output file not found`);
      jobState.status = 'failed';
      jobState.error = 'Downloaded file was not found.';
    }
  }).catch((err) => {
    console.error(`[Downloader Error ${jobState.jobId}]:`, err.message);
    jobState.status = 'failed';
    jobState.error = err.message || 'Media processing failed. Check network or content availability.';
  });
}

/**
 * Initialize a playlist batch download job
 * @param {Object} options
 * @param {string} options.playlistUrlOrId
 * @param {Array<string>} options.selectedVideoIds
 * @param {string} options.format
 * @param {boolean} options.hasPermission
 * @returns {Promise<Object>}
 */
async function preparePlaylistDownloadJob({ playlistUrlOrId, selectedVideoIds = [], format = 'mp3', hasPermission = false }) {
  const { getPlaylistMetadata } = require('./youtube');
  
  const playlistMetadata = await getPlaylistMetadata(playlistUrlOrId);

  if (!hasPermission) {
    const error = new Error('Permission Required: Downloads are restricted unless you confirm you own the rights or have explicit permission.');
    error.statusCode = 403;
    error.isCopyrightBlock = true;
    throw error;
  }

  const selectedFormat = format.toLowerCase() === 'mp4' ? 'mp4' : 'mp3';
  const jobId = uuidv4();
  const jobFolder = path.join(TEMP_DIR, jobId);
  const mediaSubfolder = path.join(jobFolder, 'tracks');

  fs.mkdirSync(mediaSubfolder, { recursive: true });

  const cleanPlaylistTitle = sanitize(playlistMetadata.title).substring(0, 80) || `playlist_${playlistMetadata.id}`;
  const zipOutputFilename = `${cleanPlaylistTitle}.zip`;
  const zipFilePath = path.join(jobFolder, zipOutputFilename);

  let filteredTracks = playlistMetadata.tracks;
  if (selectedVideoIds.length > 0) {
    filteredTracks = playlistMetadata.tracks.filter(t => selectedVideoIds.includes(t.id));
  }

  // Cap max playlist tracks to top 50
  if (filteredTracks.length > 50) {
    filteredTracks = filteredTracks.slice(0, 50);
  }

  const jobState = {
    jobId,
    playlistId: playlistMetadata.id,
    title: playlistMetadata.title,
    format: selectedFormat,
    outputFilename: zipOutputFilename,
    zipFilePath,
    jobFolder,
    mediaSubfolder,
    status: 'pending',
    progress: 0,
    completedTracks: 0,
    totalTracks: filteredTracks.length,
    currentTrackTitle: '',
    error: null,
    createdAt: Date.now(),
    isPlaylist: true
  };

  activeJobs.set(jobId, jobState);

  // Start background playlist batch download process
  executePlaylistDownload(jobState, filteredTracks);

  return {
    jobId,
    title: playlistMetadata.title,
    format: selectedFormat,
    status: jobState.status,
    totalTracks: filteredTracks.length,
    outputFilename: zipOutputFilename
  };
}

/**
 * Execute sequential batch download of playlist tracks & create zip archive
 */
async function executePlaylistDownload(jobState, tracks) {
  jobState.status = 'downloading';
  const ytDlpExec = require('yt-dlp-exec');

  let ffmpegPath = null;
  try {
    ffmpegPath = require('ffmpeg-static');
  } catch (e) {}

  for (let i = 0; i < tracks.length; i++) {
    const track = tracks[i];
    jobState.currentTrackTitle = track.title;
    jobState.progress = Math.round((i / tracks.length) * 85);

    const cleanTitle = sanitize(track.title).substring(0, 80) || `track_${track.id}`;
    const outputFilename = `${String(i + 1).padStart(2, '0')} - ${cleanTitle}.${jobState.format}`;
    const trackFilePath = path.join(jobState.mediaSubfolder, outputFilename);
    const targetUrl = `https://www.youtube.com/watch?v=${track.id}`;

    const options = {
      remoteComponents: 'ejs:github',
      jsRuntimes: 'node',
      extractorArgs: 'youtube:player_client=ios,android',
      noCheckCertificates: true,
      noWarnings: true,
      noPlaylist: true,
      output: trackFilePath
    };

    if (fs.existsSync(COOKIES_FILE)) {
      options.cookies = COOKIES_FILE;
    }

    if (process.env.YOUTUBE_PROXY || process.env.HTTP_PROXY) {
      options.proxy = process.env.YOUTUBE_PROXY || process.env.HTTP_PROXY;
    }

    if (ffmpegPath && fs.existsSync(ffmpegPath)) {
      options.ffmpegLocation = ffmpegPath;
    }

    if (jobState.format === 'mp3') {
      options.format = 'bestaudio/best';
      options.extractAudio = true;
      options.audioFormat = 'mp3';
      options.audioQuality = '0';
    } else {
      options.format = 'bestvideo+bestaudio/best';
      options.recodeVideo = 'mp4';
    }

    try {
      await ytDlpExec.exec(targetUrl, options);
      jobState.completedTracks++;
    } catch (err) {
      console.warn(`[Playlist Download Warning ${jobState.jobId}]: Skipping track ${track.title}:`, err.message);
    }
  }

  // Check if any tracks were downloaded into the folder
  const downloadedFiles = fs.existsSync(jobState.mediaSubfolder) ? fs.readdirSync(jobState.mediaSubfolder) : [];
  if (downloadedFiles.length === 0) {
    console.error(`[Playlist Downloader Error ${jobState.jobId}]: No tracks were successfully downloaded.`);
    jobState.status = 'failed';
    jobState.error = 'None of the selected tracks could be processed or downloaded. Check network connection or content restrictions.';
    return;
  }

  // Compress downloaded files into Zip Archive
  jobState.status = 'archiving';
  jobState.progress = 90;
  console.log(`[Playlist Downloader] Creating Zip Archive for Job ${jobState.jobId} (${downloadedFiles.length} files)...`);

  try {
    await createZipArchive(jobState.mediaSubfolder, jobState.targetFilePath);
    jobState.status = 'completed';
    jobState.progress = 100;
    console.log(`[Playlist Downloader Complete ${jobState.jobId}]: ${jobState.outputFilename}`);
  } catch (archiveErr) {
    console.error(`[Playlist Archive Error ${jobState.jobId}]:`, archiveErr);
    jobState.status = 'failed';
    jobState.error = `Failed to create ZIP package: ${archiveErr.message}`;
  }
}

/**
 * Create ZIP file from directory using archiver
 */
function createZipArchive(sourceDir, outPath) {
  const archiver = require('archiver');
  return new Promise((resolve, reject) => {
    if (!fs.existsSync(sourceDir)) {
      return reject(new Error('Source media directory does not exist.'));
    }
    const files = fs.readdirSync(sourceDir);
    if (!files || files.length === 0) {
      return reject(new Error('No media files found to package into ZIP archive.'));
    }

    const output = fs.createWriteStream(outPath);
    const archive = (typeof archiver === 'function')
      ? archiver('zip', { zlib: { level: 6 } })
      : new archiver.ZipArchive({ zlib: { level: 6 } });

    output.on('close', resolve);
    archive.on('error', reject);

    archive.pipe(output);
    archive.directory(sourceDir, false);
    archive.finalize();
  });
}

/**
 * Get job status by ID
 * @param {string} jobId 
 * @returns {Object|null}
 */
function getJobStatus(jobId) {
  const job = activeJobs.get(jobId);
  if (!job) return null;

  return {
    jobId: job.jobId,
    status: job.status,
    progress: Math.round(job.progress),
    outputFilename: job.outputFilename,
    error: job.error,
    format: job.format,
    isPlaylist: Boolean(job.isPlaylist),
    completedTracks: job.completedTracks || 0,
    totalTracks: job.totalTracks || 0,
    currentTrackTitle: job.currentTrackTitle || '',
    title: job.isPlaylist ? job.playlistTitle : (job.metadata ? job.metadata.title : 'Track')
  };
}

module.exports = {
  prepareDownloadJob,
  preparePlaylistDownloadJob,
  getJobStatus,
  cleanupJob,
  activeJobs
};
