require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const rateLimit = require('express-rate-limit');
const sanitize = require('sanitize-filename');

const { isValidYouTubeInput, searchYouTubeTracks, getVideoMetadata, isValidPlaylistInput, getPlaylistMetadata } = require('./utils/youtube');
const { prepareDownloadJob, preparePlaylistDownloadJob, getJobStatus, cleanupJob, activeJobs } = require('./utils/downloader');

const app = express();
const PORT = process.env.PORT || 5000;

// Security & Cross-Origin Middleware
app.use(cors());
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true }));

// Serve static frontend files from /public
app.use(express.static(path.join(__dirname, 'public')));

// Rate Limiter Configurations (Ultra-High Allowance)
const globalLimiter = rateLimit({
  windowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MS || '900000', 10), // 15 mins
  max: parseInt(process.env.RATE_LIMIT_MAX_REQUESTS || '50000', 10), // 50,000 requests
  message: { success: false, error: 'Too many requests from this IP. Please try again later.' },
  standardHeaders: true,
  legacyHeaders: false
});

const searchLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 5000, // 5,000 search queries per minute
  message: { success: false, error: 'Search rate limit exceeded. Please wait a moment before searching again.' }
});

const downloadLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: parseInt(process.env.DOWNLOAD_RATE_LIMIT_MAX || '1000', 10), // 1,000 downloads per 15 min
  message: { success: false, error: 'Download limit reached for this session. Please wait before requesting another download.' }
});

app.use('/api/', globalLimiter);

/**
 * Health Check Endpoint
 */
app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    service: 'SoundPulse Download Tool API'
  });
});

/**
 * POST /api/search - Search songs by name
 */
app.post('/api/search', searchLimiter, async (req, res) => {
  try {
    const { query } = req.body;
    if (!query || typeof query !== 'string' || !query.trim()) {
      return res.status(400).json({
        success: false,
        error: 'Please enter a valid song name or artist query.'
      });
    }

    const results = await searchYouTubeTracks(query.trim(), 6);
    return res.json({
      success: true,
      query: query.trim(),
      count: results.length,
      results
    });
  } catch (err) {
    console.error('[API /api/search Error]:', err.message);
    return res.status(500).json({
      success: false,
      error: err.message || 'An error occurred while searching for songs.'
    });
  }
});

/**
 * POST /api/metadata - Extract detailed metadata for a given YouTube URL or ID
 */
app.post('/api/metadata', async (req, res) => {
  try {
    const { url, input } = req.body;
    const targetInput = url || input;

    if (!targetInput || !isValidYouTubeInput(targetInput)) {
      return res.status(400).json({
        success: false,
        error: 'Invalid YouTube URL provided. Please enter a valid YouTube video link (e.g., https://www.youtube.com/watch?v=...)'
      });
    }

    const metadata = await getVideoMetadata(targetInput);
    return res.json({
      success: true,
      metadata
    });
  } catch (err) {
    console.error('[API /api/metadata Error]:', err.message);
    return res.status(500).json({
      success: false,
      error: err.message || 'Failed to fetch YouTube metadata.'
    });
  }
});

/**
 * POST /api/playlist/metadata - Inspect playlist URL & return track items
 */
app.post('/api/playlist/metadata', async (req, res) => {
  try {
    const { url, playlistUrl } = req.body;
    const targetInput = url || playlistUrl;

    if (!targetInput || !isValidPlaylistInput(targetInput)) {
      return res.status(400).json({
        success: false,
        error: 'Invalid YouTube Playlist URL provided. Example format: https://www.youtube.com/playlist?list=...'
      });
    }

    const metadata = await getPlaylistMetadata(targetInput);
    return res.json({
      success: true,
      metadata
    });
  } catch (err) {
    console.error('[API /api/playlist/metadata Error]:', err.message);
    return res.status(500).json({
      success: false,
      error: err.message || 'Failed to inspect YouTube playlist.'
    });
  }
});

/**
 * POST /api/playlist/download - Request batch zip download for selected playlist tracks
 */
app.post('/api/playlist/download', downloadLimiter, async (req, res) => {
  try {
    const { playlistUrlOrId, selectedVideoIds = [], format = 'mp3', hasPermission = false } = req.body;

    if (!playlistUrlOrId || !isValidPlaylistInput(playlistUrlOrId)) {
      return res.status(400).json({
        success: false,
        error: 'A valid YouTube Playlist URL is required.'
      });
    }

    const job = await preparePlaylistDownloadJob({
      playlistUrlOrId,
      selectedVideoIds,
      format,
      hasPermission: Boolean(hasPermission)
    });

    return res.json({
      success: true,
      jobId: job.jobId,
      status: job.status,
      playlistTitle: job.playlistTitle,
      totalTracks: job.totalTracks,
      outputFilename: job.outputFilename,
      format: job.format
    });
  } catch (err) {
    console.error('[API /api/playlist/download Error]:', err.message);

    if (err.isCopyrightBlock || err.statusCode === 403) {
      return res.status(403).json({
        success: false,
        isCopyrightBlock: true,
        error: err.message
      });
    }

    return res.status(500).json({
      success: false,
      error: err.message || 'Could not process playlist download request.'
    });
  }
});

/**
 * POST /api/download/request - Request download process for permitted content
 */
app.post('/api/download/request', downloadLimiter, async (req, res) => {
  try {
    const { urlOrId, format = 'mp3', hasPermission = false } = req.body;

    if (!urlOrId || !isValidYouTubeInput(urlOrId)) {
      return res.status(400).json({
        success: false,
        error: 'A valid YouTube URL or Video ID is required for download.'
      });
    }

    const job = await prepareDownloadJob({
      urlOrId,
      format,
      hasPermission: Boolean(hasPermission)
    });

    return res.json({
      success: true,
      jobId: job.jobId,
      status: job.status,
      outputFilename: job.outputFilename,
      format: job.format,
      metadata: job.metadata
    });
  } catch (err) {
    console.error('[API /api/download/request Error]:', err.message);

    if (err.isCopyrightBlock || err.statusCode === 403) {
      return res.status(403).json({
        success: false,
        isCopyrightBlock: true,
        error: err.message,
        metadata: err.metadata || null
      });
    }

    return res.status(500).json({
      success: false,
      error: err.message || 'Could not process download request.'
    });
  }
});

/**
 * GET /api/download/status/:jobId - Poll real-time progress for active download job
 */
app.get('/api/download/status/:jobId', (req, res) => {
  const { jobId } = req.params;
  const status = getJobStatus(jobId);

  if (!status) {
    return res.status(404).json({
      success: false,
      error: 'Download job not found or session expired.'
    });
  }

  return res.json({
    success: true,
    job: status
  });
});

/**
 * GET /api/download/file/:jobId - Stream completed download file to client
 */
app.get('/api/download/file/:jobId', (req, res) => {
  const { jobId } = req.params;
  const jobState = activeJobs.get(jobId);

  if (!jobState) {
    return res.status(404).json({
      success: false,
      error: 'Download file not found or session expired.'
    });
  }

  if (jobState.status !== 'completed' || !fs.existsSync(jobState.targetFilePath)) {
    return res.status(400).json({
      success: false,
      error: jobState.error || 'File processing is not complete yet.'
    });
  }

  const fileStat = fs.statSync(jobState.targetFilePath);
  const mimeType = jobState.format === 'mp3' ? 'audio/mpeg' : 'video/mp4';
  const sanitizedFilename = sanitize(jobState.outputFilename);

  res.setHeader('Content-Type', mimeType);
  res.setHeader('Content-Length', fileStat.size);
  res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(sanitizedFilename)}"`);

  const fileStream = fs.createReadStream(jobState.targetFilePath);

  fileStream.pipe(res);

  // Auto-cleanup after transmission finishes or breaks
  fileStream.on('end', () => {
    console.log(`[Stream Finished] Successfully sent file for job ${jobId}. Cleaning up...`);
    setTimeout(() => cleanupJob(jobId), 2000);
  });

  fileStream.on('error', (err) => {
    console.error(`[Stream Error ${jobId}]:`, err.message);
    cleanupJob(jobId);
  });

  res.on('close', () => {
    // If request closed prematurely
    setTimeout(() => cleanupJob(jobId), 5000);
  });
});

// Fallback route handler for single-page app
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Global Error Handler
app.use((err, req, res, next) => {
  console.error('[Unhandled Error]:', err.stack);
  res.status(500).json({
    success: false,
    error: 'An unexpected internal server error occurred.'
  });
});

// Start Express Server
app.listen(PORT, '0.0.0.0', () => {
  console.log(`
=====================================================
  🎵 SoundPulse Download & Metadata Tool Server Running!
  ---------------------------------------------------
  - Port: ${PORT}
  - URL:  http://localhost:${PORT}
  - Env:  ${process.env.NODE_ENV || 'development'}
=====================================================
  `);
});

