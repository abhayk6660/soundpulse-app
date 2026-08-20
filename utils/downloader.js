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
    execSync('yt-dlp --version', { stdio: 'ignore' });
    return { cmd: 'yt-dlp', argsPrefix: [] };
  } catch (e) {
    // Try python -m yt_dlp
    try {
      execSync('python -m yt_dlp --version', { stdio: 'ignore' });
      return { cmd: 'python', argsPrefix: ['-m', 'yt_dlp'] };
    } catch (e2) {
      // Try installing python module automatically
      try {
        console.log('[Downloader] Installing yt-dlp via python pip...');
        execSync('python -m pip install yt-dlp', { stdio: 'inherit' });
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
 * Execute yt-dlp child process safely
 * @param {Object} jobState 
 */
function executeDownload(jobState) {
  jobState.status = 'downloading';

  const { cmd, argsPrefix } = getYtDlpCommand();
  const targetUrl = `https://www.youtube.com/watch?v=${jobState.videoId}`;

  let ffmpegPath = null;
  try {
    ffmpegPath = require('ffmpeg-static');
  } catch (e) {
    console.warn('[Downloader] ffmpeg-static module not loaded:', e.message);
  }

  let ytDlpArgs = [...argsPrefix];

  if (ffmpegPath && fs.existsSync(ffmpegPath)) {
    ytDlpArgs.push('--ffmpeg-location', ffmpegPath);
  }

  if (jobState.format === 'mp3') {
    // Audio extraction parameters
    ytDlpArgs.push(
      '-x',
      '--audio-format', 'mp3',
      '--audio-quality', '0',
      '--no-playlist',
      '-o', jobState.targetFilePath,
      targetUrl
    );
  } else {
    // Video parameters (MP4 combined audio/video or best mp4 format)
    ytDlpArgs.push(
      '-f', 'bestvideo[ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/best',
      '--no-playlist',
      '-o', jobState.targetFilePath,
      targetUrl
    );
  }

  console.log(`[Downloader] Spawning ${cmd} for Job ${jobState.jobId}...`);

  const child = spawn(cmd, ytDlpArgs, { windowsHide: true });

  child.stdout.on('data', (data) => {
    const text = data.toString();
    // Parse progress percentage e.g. [download]  45.2% of ~ 5.12MiB at 1.23MiB/s ETA 00:03
    const match = text.match(/\[download\]\s+([\d\.]+)%/);
    if (match && match[1]) {
      const pct = parseFloat(match[1]);
      if (!isNaN(pct)) {
        jobState.progress = Math.min(99, Math.max(1, pct));
      }
    }
  });

  child.stderr.on('data', (data) => {
    console.warn(`[Downloader yt-dlp stderr ${jobState.jobId}]:`, data.toString().trim());
  });

  child.on('error', (err) => {
    console.error(`[Downloader Error ${jobState.jobId}]:`, err);
    jobState.status = 'failed';
    jobState.error = `Download process failed to launch: ${err.message}`;
  });

  child.on('close', (code) => {
    if (code === 0 && fs.existsSync(jobState.targetFilePath)) {
      console.log(`[Downloader Complete ${jobState.jobId}]: ${jobState.outputFilename}`);
      jobState.status = 'completed';
      jobState.progress = 100;
    } else {
      console.error(`[Downloader Failed ${jobState.jobId}]: Exited with code ${code}`);
      jobState.status = 'failed';
      jobState.error = jobState.error || `Media processing failed (exit code ${code}). Check network or content availability.`;
    }
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
  
  if (!hasPermission) {
    const error = new Error('Permission Required: Please confirm legal rights or permission to download this playlist content.');
    error.statusCode = 403;
    error.isCopyrightBlock = true;
    throw error;
  }

  const playlistMetadata = await getPlaylistMetadata(playlistUrlOrId);
  const targetTracks = (selectedVideoIds && selectedVideoIds.length > 0)
    ? playlistMetadata.tracks.filter(t => selectedVideoIds.includes(t.id))
    : playlistMetadata.tracks;

  if (targetTracks.length === 0) {
    throw new Error('No valid tracks selected for playlist download.');
  }

  const selectedFormat = format.toLowerCase() === 'mp4' ? 'mp4' : 'mp3';
  const jobId = uuidv4();
  const jobFolder = path.join(TEMP_DIR, jobId);
  const mediaSubfolder = path.join(jobFolder, 'media');

  fs.mkdirSync(mediaSubfolder, { recursive: true });

  const cleanPlaylistTitle = sanitize(playlistMetadata.title).substring(0, 80) || `Playlist_${jobId.substring(0,6)}`;
  const zipFilename = `${cleanPlaylistTitle}_[${selectedFormat.toUpperCase()}].zip`;
  const zipFilePath = path.join(jobFolder, zipFilename);

  const jobState = {
    jobId,
    isPlaylist: true,
    playlistTitle: playlistMetadata.title,
    totalTracks: targetTracks.length,
    completedTracks: 0,
    format: selectedFormat,
    outputFilename: zipFilename,
    targetFilePath: zipFilePath,
    jobFolder,
    mediaSubfolder,
    status: 'pending',
    progress: 0,
    currentTrackTitle: '',
    error: null,
    createdAt: Date.now()
  };

  activeJobs.set(jobId, jobState);

  // Execute async batch download process
  executePlaylistDownload(jobState, targetTracks);

  return {
    jobId,
    playlistTitle: playlistMetadata.title,
    totalTracks: targetTracks.length,
    outputFilename: zipFilename,
    format: selectedFormat,
    status: jobState.status
  };
}

/**
 * Execute sequential batch download of playlist tracks & create zip archive
 */
async function executePlaylistDownload(jobState, tracks) {
  jobState.status = 'downloading';
  const { cmd, argsPrefix } = getYtDlpCommand();

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

    let ytDlpArgs = [...argsPrefix];
    if (ffmpegPath && fs.existsSync(ffmpegPath)) {
      ytDlpArgs.push('--ffmpeg-location', ffmpegPath);
    }

    if (jobState.format === 'mp3') {
      ytDlpArgs.push('-x', '--audio-format', 'mp3', '--audio-quality', '0', '--no-playlist', '-o', trackFilePath, targetUrl);
    } else {
      ytDlpArgs.push('-f', 'bestvideo[ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/best', '--no-playlist', '-o', trackFilePath, targetUrl);
    }

    try {
      await new Promise((resolve, reject) => {
        const child = spawn(cmd, ytDlpArgs, { windowsHide: true });
        child.on('close', (code) => {
          if (code === 0 && fs.existsSync(trackFilePath)) resolve();
          else reject(new Error(`Failed to download track ${track.title} (code ${code})`));
        });
        child.on('error', reject);
      });
      jobState.completedTracks++;
    } catch (err) {
      console.warn(`[Playlist Download Warning ${jobState.jobId}]: Skipping track ${track.title}:`, err.message);
    }
  }

  // Compress downloaded files into Zip Archive
  jobState.status = 'archiving';
  jobState.progress = 90;
  console.log(`[Playlist Downloader] Creating Zip Archive for Job ${jobState.jobId}...`);

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
