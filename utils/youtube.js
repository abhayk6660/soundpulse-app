const ytSearch = require('yt-search');
const { execFile } = require('child_process');
const path = require('path');
const fs = require('fs');

/**
 * YouTube URL Regex Patterns
 */
const YOUTUBE_URL_REGEX = /^(https?:\/\/)?(www\.|m\.|music\.)?(youtube\.com\/(watch\?v=|embed\/|v\/|shorts\/)|youtu\.be\/)([a-zA-Z0-9_-]{11})/;
const VIDEO_ID_REGEX = /^[a-zA-Z0-9_-]{11}$/;

/**
 * Extract YouTube Video ID from any supported YouTube URL
 * @param {string} input - URL or video ID string
 * @returns {string|null} - 11-character video ID or null if invalid
 */
function extractVideoId(input) {
  if (!input || typeof input !== 'string') return null;
  
  const trimmed = input.trim();

  // If already an 11-character video ID
  if (VIDEO_ID_REGEX.test(trimmed)) {
    return trimmed;
  }

  const match = trimmed.match(YOUTUBE_URL_REGEX);
  if (match && match[5]) {
    return match[5];
  }

  // Handle parameters like ?v=ID in arbitrary query params
  try {
    const urlObj = new URL(trimmed.startsWith('http') ? trimmed : `https://${trimmed}`);
    const vParam = urlObj.searchParams.get('v');
    if (vParam && VIDEO_ID_REGEX.test(vParam)) {
      return vParam;
    }
  } catch (e) {
    // Parsing error, invalid URL format
  }

  return null;
}

/**
 * Validate YouTube URL or ID
 * @param {string} input 
 * @returns {boolean}
 */
function isValidYouTubeInput(input) {
  return extractVideoId(input) !== null;
}

/**
 * Search YouTube for song name and return matching tracks
 * @param {string} query - Song title or artist keyword
 * @param {number} limit - Maximum number of results to return
 * @returns {Promise<Array<Object>>}
 */
async function searchYouTubeTracks(query, limit = 5) {
  if (!query || typeof query !== 'string' || !query.trim()) {
    throw new Error('Search query must be a non-empty string.');
  }

  const cleanQuery = query.trim();

  // Primary attempt: yt-search
  try {
    const searchResult = await ytSearch(cleanQuery);
    const videos = (searchResult && searchResult.videos) ? searchResult.videos : [];

    if (videos.length > 0) {
      return videos.slice(0, limit).map((video) => {
        const safeTitle = typeof video.title === 'string' ? video.title : String(video.title || 'Untitled Track');
        const safeAuthor = video.author && typeof video.author.name === 'string' ? video.author.name : (typeof video.author === 'string' ? video.author : 'Unknown Artist');
        const safeAuthorUrl = video.author && typeof video.author.url === 'string' ? video.author.url : '';
        
        const titleLower = safeTitle.toLowerCase();
        const isNoCopyright = titleLower.includes('no copyright') || 
                              titleLower.includes('royalty free') || 
                              titleLower.includes('creative commons') ||
                              titleLower.includes('cc0') ||
                              titleLower.includes('public domain') ||
                              titleLower.includes('ncs release');

        return {
          id: video.videoId,
          title: safeTitle,
          artist: safeAuthor,
          authorUrl: safeAuthorUrl,
          url: video.url || `https://www.youtube.com/watch?v=${video.videoId}`,
          thumbnail: video.image || video.thumbnail || `https://img.youtube.com/vi/${video.videoId}/hqdefault.jpg`,
          duration: video.timestamp || formatSecondsToDuration(video.seconds || 0),
          seconds: video.seconds || 0,
          views: video.views || 0,
          ago: video.ago || 'Recently',
          descriptionSnippet: typeof video.description === 'string' ? video.description : '',
          licenseInfo: isNoCopyright ? 'Creative Commons / Royalty Free (Detected)' : 'Standard License / Permission Verification Required',
          isPermitted: isNoCopyright
        };
      });
    }
  } catch (err) {
    console.warn(`[yt-search] Primary search failed for "${cleanQuery}": ${err.message}. Running yt-dlp fallback...`);
  }

  // Fallback attempt: yt-dlp search
  try {
    return await searchYouTubeTracksFallback(cleanQuery, limit);
  } catch (fallbackErr) {
    console.error('Fallback search error:', fallbackErr.message);
    throw new Error(`Failed to search tracks for "${cleanQuery}". Please refine your query or try pasting a direct YouTube URL.`);
  }
}

/**
 * Fallback YouTube search using yt-dlp --dump-json
 */

function searchYouTubeTracksFallback(query, limit = 5) {
  return new Promise((resolve, reject) => {
    const { execFile } = require('child_process');
    // Try yt-dlp or python -m yt_dlp
    let cmd = 'yt-dlp';
    let args = ['--dump-json', '--flat-playlist', '--no-warnings', `ytsearch${limit}:${query}`];

    execFile(cmd, args, { maxBuffer: 10 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        // Try python -m yt_dlp
        cmd = 'python';
        args = ['-m', 'yt_dlp', '--dump-json', '--flat-playlist', '--no-warnings', `ytsearch${limit}:${query}`];
        execFile(cmd, args, { maxBuffer: 10 * 1024 * 1024 }, (err2, stdout2) => {
          if (err2) return reject(err2);
          parseYtDlpJsonLines(stdout2, limit, resolve, reject);
        });
        return;
      }
      parseYtDlpJsonLines(stdout, limit, resolve, reject);
    });
  });
}

function parseYtDlpJsonLines(stdout, limit, resolve, reject) {
  try {
    const lines = stdout.trim().split('\n').filter(Boolean);
    const results = lines.slice(0, limit).map((line) => {
      const item = JSON.parse(line);
      const safeTitle = item.title || item.fulltitle || 'YouTube Track';
      const safeAuthor = item.uploader || item.channel || item.uploader_id || 'Unknown Artist';
      const videoId = item.id;
      const titleLower = safeTitle.toLowerCase();
      const isNoCopyright = titleLower.includes('no copyright') || 
                            titleLower.includes('royalty free') || 
                            titleLower.includes('creative commons') ||
                            titleLower.includes('cc0') ||
                            titleLower.includes('public domain') ||
                            titleLower.includes('ncs release');

      return {
        id: videoId,
        title: safeTitle,
        artist: safeAuthor,
        authorUrl: item.uploader_url || '',
        url: item.webpage_url || item.url || `https://www.youtube.com/watch?v=${videoId}`,
        thumbnail: (item.thumbnails && item.thumbnails.length > 0) ? item.thumbnails[item.thumbnails.length - 1].url : `https://img.youtube.com/vi/${videoId}/hqdefault.jpg`,
        duration: formatSecondsToDuration(item.duration || 0),
        seconds: item.duration || 0,
        views: item.view_count || 0,
        ago: item.upload_date ? `${item.upload_date.substring(0,4)}` : 'Recently',
        descriptionSnippet: item.description || '',
        licenseInfo: isNoCopyright ? 'Creative Commons / Royalty Free (Detected)' : 'Standard License / Permission Verification Required',
        isPermitted: isNoCopyright
      };
    });
    resolve(results);
  } catch (e) {
    reject(e);
  }
}

const COOKIES_FILE = path.join(__dirname, '../cookies.txt');

/**
 * Fetch full YouTube video metadata & license information
 * @param {string} input - URL or video ID string
 * @returns {Promise<Object>} Formatted track metadata object
 */
async function getVideoMetadata(input) {
  const videoId = extractVideoId(input);
  if (!videoId) {
    throw new Error('Invalid YouTube URL or Video ID provided.');
  }

  try {
    // Attempt yt-search lookup with a 2.5s timeout first
    const videoData = await Promise.race([
      ytSearch({ videoId }),
      new Promise((_, reject) => setTimeout(() => reject(new Error('yt-search timeout')), 2500))
    ]);
    if (videoData) {
      const safeTitle = typeof videoData.title === 'string' ? videoData.title : String(videoData.title || `YouTube Video (${videoId})`);
      const safeAuthor = videoData.author && typeof videoData.author.name === 'string' ? videoData.author.name : (typeof videoData.author === 'string' ? videoData.author : 'YouTube Channel');
      const safeDesc = typeof videoData.description === 'string' ? videoData.description : '';

      const titleLower = safeTitle.toLowerCase();
      const descLower = safeDesc.toLowerCase();
      
      const isNoCopyright = titleLower.includes('no copyright') || 
                            titleLower.includes('royalty free') || 
                            titleLower.includes('creative commons') ||
                            titleLower.includes('cc0') ||
                            titleLower.includes('ncs release') ||
                            descLower.includes('creative commons') ||
                            descLower.includes('reuse allowed');

      return {
        id: videoData.videoId || videoId,
        title: safeTitle,
        artist: safeAuthor,
        authorUrl: videoData.author && typeof videoData.author.url === 'string' ? videoData.author.url : '',
        url: videoData.url || `https://www.youtube.com/watch?v=${videoId}`,
        thumbnail: videoData.image || videoData.thumbnail || `https://img.youtube.com/vi/${videoId}/maxresdefault.jpg`,
        duration: videoData.timestamp || formatSecondsToDuration(videoData.seconds || 0),
        seconds: videoData.seconds || 0,
        views: videoData.views || 0,
        uploadDate: videoData.uploadDate || videoData.ago || 'Unknown',
        description: safeDesc,
        licenseInfo: isNoCopyright ? 'Creative Commons / Public Domain' : 'Standard YouTube License (User Permission Required)',
        isPermitted: isNoCopyright
      };
    }
  } catch (err) {
    console.warn(`yt-search lookup failed for ${videoId}:`, err.message);
  }

  // Fallback to yt-dlp --dump-json with android,tv_embedded client flags for accurate metadata
  try {
    const jsonOutput = await new Promise((resolve, reject) => {
      const cloudFlags = [
        '--extractor-args', 'youtube:player_client=android,tv_embedded',
        '--dump-json',
        '--no-warnings',
        '--no-check-certificates'
      ];

      if (fs.existsSync(COOKIES_FILE)) {
        cloudFlags.push('--cookies', COOKIES_FILE);
      }

      if (process.env.YOUTUBE_PROXY || process.env.HTTP_PROXY) {
        cloudFlags.push('--proxy', process.env.YOUTUBE_PROXY || process.env.HTTP_PROXY);
      }

      cloudFlags.push(`https://www.youtube.com/watch?v=${videoId}`);

      const binPath = path.resolve(__dirname, '../node_modules/yt-dlp-exec/bin/yt-dlp') + (process.platform === 'win32' ? '.exe' : '');
      const primaryCmd = fs.existsSync(binPath) ? binPath : 'yt-dlp';

      execFile(primaryCmd, cloudFlags, (err, stdout) => {
        if (err) {
          execFile('yt-dlp', cloudFlags, (errYt, stdoutYt) => {
            if (errYt) {
              execFile('python3', ['-m', 'yt_dlp', ...cloudFlags], (err2, stdout2) => {
                if (err2) {
                  execFile('python', ['-m', 'yt_dlp', ...cloudFlags], (err3, stdout3) => {
                    if (err3) return reject(err3);
                    resolve(stdout3);
                  });
                  return;
                }
                resolve(stdout2);
              });
              return;
            }
            resolve(stdoutYt);
          });
          return;
        }
        resolve(stdout);
      });
    });

    const data = JSON.parse(jsonOutput);
    const safeTitle = data.title || data.fulltitle || `YouTube Video (${videoId})`;
    const safeAuthor = data.uploader || data.channel || 'YouTube Channel';
    const safeDesc = data.description || '';
    const titleLower = safeTitle.toLowerCase();
    const descLower = safeDesc.toLowerCase();
    const isNoCopyright = titleLower.includes('no copyright') || descLower.includes('creative commons');

    return {
      id: videoId,
      title: safeTitle,
      artist: safeAuthor,
      authorUrl: data.uploader_url || data.channel_url || '',
      url: `https://www.youtube.com/watch?v=${videoId}`,
      thumbnail: data.thumbnail || `https://img.youtube.com/vi/${videoId}/hqdefault.jpg`,
      duration: formatSecondsToDuration(data.duration || 0),
      seconds: data.duration || 0,
      views: data.view_count || 0,
      uploadDate: data.upload_date || 'Unknown',
      description: safeDesc,
      licenseInfo: isNoCopyright ? 'Creative Commons / Public Domain' : 'Standard YouTube License (User Permission Required)',
      isPermitted: isNoCopyright
    };
  } catch (ytDlpErr) {
    console.warn(`[getVideoMetadata] yt-dlp fallback failed for ${videoId}:`, ytDlpErr.message);
  }

  // Default fallback metadata structure
  return {
    id: videoId,
    title: `YouTube Video (${videoId})`,
    artist: 'YouTube Channel',
    url: `https://www.youtube.com/watch?v=${videoId}`,
    thumbnail: `https://img.youtube.com/vi/${videoId}/hqdefault.jpg`,
    duration: 'N/A',
    seconds: 0,
    views: 0,
    uploadDate: 'N/A',
    description: '',
    licenseInfo: 'Standard YouTube License (User Permission Required)',
    isPermitted: false
  };
}

/**
 * Extract YouTube Playlist ID from a URL or raw ID string
 * @param {string} input 
 * @returns {string|null}
 */
function extractPlaylistId(input) {
  if (!input || typeof input !== 'string') return null;
  const trimmed = input.trim();
  
  if (/^[a-zA-Z0-9_-]{10,80}$/.test(trimmed) && (trimmed.startsWith('PL') || trimmed.startsWith('RD') || trimmed.startsWith('OLAK') || trimmed.startsWith('FL') || trimmed.startsWith('UU') || trimmed.startsWith('LL') || trimmed.startsWith('TL') || trimmed.startsWith('CL'))) {
    return trimmed;
  }

  try {
    const urlObj = new URL(trimmed.startsWith('http') ? trimmed : `https://${trimmed}`);
    const listParam = urlObj.searchParams.get('list');
    if (listParam && /^[a-zA-Z0-9_-]{10,80}$/.test(listParam)) {
      return listParam;
    }
  } catch (e) {}

  return null;
}

/**
 * Validate Playlist URL or ID
 * @param {string} input 
 * @returns {boolean}
 */
function isValidPlaylistInput(input) {
  return extractPlaylistId(input) !== null;
}

/**
 * Fetch YouTube Playlist Metadata and all track items
 * @param {string} input 
 * @returns {Promise<Object>}
 */
async function getPlaylistMetadata(input) {
  const playlistId = extractPlaylistId(input);
  if (!playlistId) {
    throw new Error('Invalid YouTube Playlist URL or Playlist ID.');
  }

  const targetUrl = `https://www.youtube.com/playlist?list=${playlistId}`;

  return new Promise((resolve, reject) => {
    const cloudFlags = [
      '--extractor-args', 'youtube:player_client=android,tv_embedded',
      '--no-warnings',
      '--no-check-certificates'
    ];

    if (fs.existsSync(COOKIES_FILE)) {
      cloudFlags.push('--cookies', COOKIES_FILE);
    }

    if (process.env.YOUTUBE_PROXY || process.env.HTTP_PROXY) {
      cloudFlags.push('--proxy', process.env.YOUTUBE_PROXY || process.env.HTTP_PROXY);
    }
    const binPath = path.resolve(__dirname, '../node_modules/yt-dlp-exec/bin/yt-dlp') + (process.platform === 'win32' ? '.exe' : '');
    let cmd = fs.existsSync(binPath) ? binPath : 'yt-dlp';
    let args = ['--dump-json', '--flat-playlist', ...cloudFlags, targetUrl];

    execFile(cmd, args, { maxBuffer: 20 * 1024 * 1024 }, (err, stdout) => {
      if (err) {
        cmd = 'python3';
        args = ['-m', 'yt_dlp', '--dump-json', '--flat-playlist', ...cloudFlags, targetUrl];
        execFile(cmd, args, { maxBuffer: 20 * 1024 * 1024 }, (err2, stdout2) => {
          if (err2) {
            cmd = 'python';
            args = ['-m', 'yt_dlp', '--dump-json', '--flat-playlist', ...cloudFlags, targetUrl];
            execFile(cmd, args, { maxBuffer: 20 * 1024 * 1024 }, (err3, stdout3) => {
              if (err3) return reject(new Error(`Failed to fetch playlist metadata: ${err3.message}`));
              parsePlaylistOutput(playlistId, stdout3, resolve, reject);
            });
            return;
          }
          parsePlaylistOutput(playlistId, stdout2, resolve, reject);
        });
        return;
      }
      parsePlaylistOutput(playlistId, stdout, resolve, reject);
    });
  });
}

function parsePlaylistOutput(playlistId, stdout, resolve, reject) {
  try {
    const lines = stdout.trim().split('\n').filter(Boolean);
    if (lines.length === 0) {
      return reject(new Error('No playlist items found or playlist is private.'));
    }

    const items = [];
    let playlistTitle = 'YouTube Playlist';
    let playlistChannel = 'YouTube Channel';

    lines.forEach((line, index) => {
      try {
        const data = JSON.parse(line);
        if (data.playlist_title) playlistTitle = data.playlist_title;
        if (data.playlist_uploader || data.uploader) playlistChannel = data.playlist_uploader || data.uploader;

        const videoId = data.id;
        if (videoId) {
          items.push({
            index: index + 1,
            id: videoId,
            title: data.title || data.fulltitle || `Track #${index + 1}`,
            artist: data.uploader || data.channel || playlistChannel,
            duration: formatSecondsToDuration(data.duration || 0),
            seconds: data.duration || 0,
            thumbnail: `https://img.youtube.com/vi/${videoId}/hqdefault.jpg`,
            url: `https://www.youtube.com/watch?v=${videoId}`
          });
        }
      } catch (e) {}
    });

    resolve({
      playlistId,
      title: playlistTitle,
      channel: playlistChannel,
      itemCount: items.length,
      thumbnail: items.length > 0 ? items[0].thumbnail : '',
      tracks: items
    });
  } catch (err) {
    reject(err);
  }
}

/**
 * Format seconds into HH:MM:SS or MM:SS format
 * @param {number} totalSeconds 
 * @returns {string}
 */
function formatSecondsToDuration(totalSeconds) {
  const secs = Math.max(0, Math.floor(totalSeconds));
  const hrs = Math.floor(secs / 3600);
  const mins = Math.floor((secs % 3600) / 60);
  const remainingSecs = secs % 60;

  const paddedSecs = String(remainingSecs).padStart(2, '0');
  if (hrs > 0) {
    const paddedMins = String(mins).padStart(2, '0');
    return `${hrs}:${paddedMins}:${paddedSecs}`;
  }
  return `${mins}:${paddedSecs}`;
}

module.exports = {
  extractVideoId,
  isValidYouTubeInput,
  searchYouTubeTracks,
  getVideoMetadata,
  extractPlaylistId,
  isValidPlaylistInput,
  getPlaylistMetadata,
  formatSecondsToDuration
};
