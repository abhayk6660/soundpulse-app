/**
 * SoundPulse - Frontend Application Logic
 */

document.addEventListener('DOMContentLoaded', () => {
  // DOM Element References
  const searchTabs = document.querySelectorAll('.tab-btn');
  const songModeSection = document.getElementById('songModeSection');
  const urlModeSection = document.getElementById('urlModeSection');

  // Song Mode Elements
  const songSearchForm = document.getElementById('songSearchForm');
  const songSearchInput = document.getElementById('songSearchInput');
  const clearSongInput = document.getElementById('clearSongInput');
  const searchSkeleton = document.getElementById('searchSkeleton');
  const resultsHeader = document.getElementById('resultsHeader');
  const resultsCount = document.getElementById('resultsCount');
  const resultsGrid = document.getElementById('resultsGrid');

  // URL Mode Elements
  const urlInputForm = document.getElementById('urlInputForm');
  const urlInput = document.getElementById('urlInput');
  const clearUrlInput = document.getElementById('clearUrlInput');
  const urlSkeleton = document.getElementById('urlSkeleton');
  const detectedTrackContainer = document.getElementById('detectedTrackContainer');

  // Download Section Elements
  const downloadSection = document.getElementById('downloadSection');
  const closeDownloadSection = document.getElementById('closeDownloadSection');
  const selectedTrackDetail = document.getElementById('selectedTrackDetail');
  const formatMp3Card = document.getElementById('formatMp3Card');
  const formatMp4Card = document.getElementById('formatMp4Card');
  const formatRadios = document.querySelectorAll('input[name="outputFormat"]');
  const permissionCheckbox = document.getElementById('permissionCheckbox');
  const startDownloadBtn = document.getElementById('startDownloadBtn');
  const progressBox = document.getElementById('progressBox');
  const progressStatusText = document.getElementById('progressStatusText');
  const progressPercent = document.getElementById('progressPercent');
  const progressFill = document.getElementById('progressFill');
  const toastContainer = document.getElementById('toastContainer');

  // Playlist Mode Elements
  const playlistModeSection = document.getElementById('playlistModeSection');
  const playlistInputForm = document.getElementById('playlistInputForm');
  const playlistInput = document.getElementById('playlistInput');
  const clearPlaylistInput = document.getElementById('clearPlaylistInput');
  const playlistSkeleton = document.getElementById('playlistSkeleton');
  const playlistContainer = document.getElementById('playlistContainer');

  // State Management
  let currentSelectedTrack = null;
  let currentSelectedPlaylist = null;
  let isPlaylistMode = false;
  let activePollInterval = null;

  // ----------------------------------------------------
  // 1. Tab Switching Handler
  // ----------------------------------------------------
  searchTabs.forEach(tab => {
    tab.addEventListener('click', () => {
      searchTabs.forEach(t => t.classList.remove('active'));
      tab.classList.add('active');

      const targetTab = tab.getAttribute('data-tab');
      songModeSection.classList.toggle('active', targetTab === 'song-mode');
      urlModeSection.classList.toggle('active', targetTab === 'url-mode');
      playlistModeSection.classList.toggle('active', targetTab === 'playlist-mode');
    });
  });

  // ----------------------------------------------------
  // 2. Input Clear Button Handlers
  // ----------------------------------------------------
  songSearchInput.addEventListener('input', () => {
    clearSongInput.classList.toggle('hidden', !songSearchInput.value);
  });
  clearSongInput.addEventListener('click', () => {
    songSearchInput.value = '';
    clearSongInput.classList.add('hidden');
    songSearchInput.focus();
  });

  urlInput.addEventListener('input', () => {
    clearUrlInput.classList.toggle('hidden', !urlInput.value);
  });
  clearUrlInput.addEventListener('click', () => {
    urlInput.value = '';
    clearUrlInput.classList.add('hidden');
    urlInput.focus();
  });

  // ----------------------------------------------------
  // 3. Format Card Toggle
  // ----------------------------------------------------
  formatRadios.forEach(radio => {
    radio.addEventListener('change', () => {
      formatMp3Card.classList.toggle('selected', radio.value === 'mp3');
      formatMp4Card.classList.toggle('selected', radio.value === 'mp4');
    });
  });

  // ----------------------------------------------------
  // 4. Song Name Search Form Submission
  // ----------------------------------------------------
  songSearchForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const query = songSearchInput.value.trim();
    if (!query) return;

    // Reset UI
    resultsGrid.innerHTML = '';
    resultsHeader.classList.add('hidden');
    searchSkeleton.classList.remove('hidden');

    try {
      const response = await fetch('/api/search', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query })
      });

      const data = await response.json();
      searchSkeleton.classList.add('hidden');

      if (!data.success) {
        showToast(data.error || 'Failed to search songs.', 'error');
        return;
      }

      renderSearchResults(data.results);
    } catch (err) {
      searchSkeleton.classList.add('hidden');
      showToast('Network error while searching for songs. Check your connection.', 'error');
    }
  });

  // Render Search Results Grid
  function renderSearchResults(tracks) {
    if (!tracks || tracks.length === 0) {
      showToast('No matching song tracks found.', 'warning');
      return;
    }

    resultsCount.textContent = `Found ${tracks.length} matching tracks`;
    resultsHeader.classList.remove('hidden');

    resultsGrid.innerHTML = tracks.map((track) => `
      <div class="track-card">
        <div class="card-thumb-wrapper">
          <img src="${escapeHtml(track.thumbnail)}" alt="${escapeHtml(track.title)}" loading="lazy">
          <span class="duration-badge">${escapeHtml(track.duration)}</span>
        </div>
        <div class="card-body">
          <h3 class="card-title" title="${escapeHtml(track.title)}">${escapeHtml(track.title)}</h3>
          <p class="card-artist"><i class="fa-solid fa-user-astronaut"></i> ${escapeHtml(track.artist)}</p>
          <div class="card-meta-row">
            <span><i class="fa-solid fa-eye"></i> ${formatViews(track.views)}</span>
            <span><i class="fa-solid fa-clock"></i> ${escapeHtml(track.ago)}</span>
          </div>
          <div>
            <span class="license-tag ${track.isPermitted ? 'cc-free' : 'standard'}">
              <i class="fa-solid ${track.isPermitted ? 'fa-circle-check' : 'fa-triangle-exclamation'}"></i> 
              ${escapeHtml(track.licenseInfo)}
            </span>
          </div>
          <button class="select-track-btn" data-track='${escapeAttr(JSON.stringify(track))}'>
            <i class="fa-solid fa-circle-play"></i> Select Track
          </button>
        </div>
      </div>
    `).join('');

    // Attach click listeners to "Select Track" buttons
    resultsGrid.querySelectorAll('.select-track-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const trackData = JSON.parse(btn.getAttribute('data-track'));
        selectTrackForDownload(trackData);
      });
    });
  }

  // ----------------------------------------------------
  // 5. Direct YouTube URL Form Submission
  // ----------------------------------------------------
  urlInputForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const url = urlInput.value.trim();
    if (!url) return;

    detectedTrackContainer.classList.add('hidden');
    detectedTrackContainer.innerHTML = '';
    urlSkeleton.classList.remove('hidden');

    try {
      const response = await fetch('/api/metadata', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url })
      });

      const data = await response.json();
      urlSkeleton.classList.add('hidden');

      if (!data.success) {
        showToast(data.error || 'Could not fetch metadata for YouTube URL.', 'error');
        return;
      }

      renderDetectedTrack(data.metadata);
    } catch (err) {
      urlSkeleton.classList.add('hidden');
      showToast('Network error while validating YouTube URL.', 'error');
    }
  });

  // Render Detected Track Card for YouTube URL
  function renderDetectedTrack(track) {
    detectedTrackContainer.innerHTML = `
      <div class="glass-card">
        <div class="selected-track-detail">
          <img class="selected-thumb" src="${escapeHtml(track.thumbnail)}" alt="${escapeHtml(track.title)}">
          <div class="selected-info">
            <h3 class="selected-title">${escapeHtml(track.title)}</h3>
            <p class="selected-artist"><i class="fa-solid fa-user-astronaut"></i> ${escapeHtml(track.artist)}</p>
            <p class="selected-meta"><i class="fa-solid fa-stopwatch"></i> Duration: ${escapeHtml(track.duration)} &bull; ${formatViews(track.views)} views</p>
            <div>
              <span class="license-tag ${track.isPermitted ? 'cc-free' : 'standard'}">
                <i class="fa-solid ${track.isPermitted ? 'fa-circle-check' : 'fa-triangle-exclamation'}"></i> 
                ${escapeHtml(track.licenseInfo)}
              </span>
            </div>
          </div>
        </div>
        <button class="btn btn-primary" style="width: 100%; margin-top: 1rem;" id="confirmUrlTrackBtn">
          <i class="fa-solid fa-circle-check"></i> Select Detected Track for Download
        </button>
      </div>
    `;

    detectedTrackContainer.classList.remove('hidden');

    document.getElementById('confirmUrlTrackBtn').addEventListener('click', () => {
      selectTrackForDownload(track);
    });
  }

  playlistInput.addEventListener('input', () => {
    clearPlaylistInput.classList.toggle('hidden', !playlistInput.value);
  });
  clearPlaylistInput.addEventListener('click', () => {
    playlistInput.value = '';
    clearPlaylistInput.classList.add('hidden');
    playlistInput.focus();
  });

  // ----------------------------------------------------
  // Playlist Form Submission
  // ----------------------------------------------------
  playlistInputForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const url = playlistInput.value.trim();
    if (!url) return;

    playlistContainer.classList.add('hidden');
    playlistContainer.innerHTML = '';
    playlistSkeleton.classList.remove('hidden');

    try {
      const response = await fetch('/api/playlist/metadata', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url })
      });

      const data = await response.json();
      playlistSkeleton.classList.add('hidden');

      if (!data.success) {
        showToast(data.error || 'Could not fetch YouTube Playlist metadata.', 'error');
        return;
      }

      renderPlaylistContainer(data.metadata);
    } catch (err) {
      playlistSkeleton.classList.add('hidden');
      showToast('Network error while inspecting YouTube Playlist.', 'error');
    }
  });

  // Render Playlist Inspection Card & Track List Table
  function renderPlaylistContainer(playlist) {
    currentSelectedPlaylist = playlist;

    const tracksHtml = playlist.tracks.map((track, idx) => `
      <div class="playlist-track-row">
        <input type="checkbox" class="playlist-track-cb" data-id="${escapeAttr(track.id)}" checked>
        <span class="track-index">#${idx + 1}</span>
        <img class="track-row-thumb" src="${escapeHtml(track.thumbnail)}" alt="${escapeHtml(track.title)}">
        <div class="track-row-info">
          <span class="track-row-title">${escapeHtml(track.title)}</span>
          <span class="track-row-artist">${escapeHtml(track.artist)}</span>
        </div>
        <span class="track-row-duration">${escapeHtml(track.duration)}</span>
        <button class="quick-dl-btn" data-track='${escapeAttr(JSON.stringify(track))}'>
          <i class="fa-solid fa-download"></i> Download
        </button>
      </div>
    `).join('');

    playlistContainer.innerHTML = `
      <div class="glass-card">
        <div class="playlist-header-card">
          <div class="playlist-header-info">
            <img class="playlist-thumb" src="${escapeHtml(playlist.thumbnail)}" alt="${escapeHtml(playlist.title)}">
            <div>
              <h3 class="playlist-title">${escapeHtml(playlist.title)}</h3>
              <p class="playlist-meta"><i class="fa-solid fa-layer-group"></i> ${playlist.itemCount} Total Tracks &bull; ${escapeHtml(playlist.channel)}</p>
            </div>
          </div>
        </div>

        <div class="playlist-select-all-bar">
          <label>
            <input type="checkbox" id="selectAllTracksCb" checked>
            <strong>Select All (${playlist.itemCount} Tracks)</strong>
          </label>
          <span class="results-count" id="selectedCountBadge">${playlist.itemCount} Selected</span>
        </div>

        <div class="playlist-scroll-list">
          ${tracksHtml}
        </div>

        <button class="btn btn-primary" style="width: 100%; margin-top: 1.25rem;" id="confirmPlaylistBtn">
          <i class="fa-solid fa-circle-check"></i> Select Playlist for Batch Zip Download
        </button>
      </div>
    `;

    playlistContainer.classList.remove('hidden');

    // Attach click listeners to individual "Download" row buttons
    playlistContainer.querySelectorAll('.quick-dl-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const trackData = JSON.parse(btn.getAttribute('data-track'));
        selectTrackForDownload(trackData);
      });
    });

    // Handle Select All / Deselect All
    const selectAllCb = document.getElementById('selectAllTracksCb');
    const trackCbs = playlistContainer.querySelectorAll('.playlist-track-cb');
    const selectedCountBadge = document.getElementById('selectedCountBadge');

    function updateSelectedCount() {
      const checkedCount = playlistContainer.querySelectorAll('.playlist-track-cb:checked').length;
      selectedCountBadge.textContent = `${checkedCount} of ${playlist.itemCount} Selected`;
      selectAllCb.checked = checkedCount === playlist.itemCount;
    }

    selectAllCb.addEventListener('change', () => {
      trackCbs.forEach(cb => cb.checked = selectAllCb.checked);
      updateSelectedCount();
    });

    trackCbs.forEach(cb => {
      cb.addEventListener('change', updateSelectedCount);
    });

    document.getElementById('confirmPlaylistBtn').addEventListener('click', () => {
      const selectedVideoIds = Array.from(playlistContainer.querySelectorAll('.playlist-track-cb:checked')).map(cb => cb.getAttribute('data-id'));
      if (selectedVideoIds.length === 0) {
        showToast('Please select at least 1 track from the playlist to download.', 'warning');
        return;
      }
      selectPlaylistForDownload(playlist, selectedVideoIds);
    });
  }

  // ----------------------------------------------------
  // Select Track/Playlist for Download Panel
  // ----------------------------------------------------
  function selectTrackForDownload(track) {
    isPlaylistMode = false;
    currentSelectedTrack = track;
    permissionCheckbox.checked = Boolean(track.isPermitted);

    selectedTrackDetail.innerHTML = `
      <img class="selected-thumb" src="${escapeHtml(track.thumbnail)}" alt="${escapeHtml(track.title)}">
      <div class="selected-info">
        <h3 class="selected-title">${escapeHtml(track.title)}</h3>
        <p class="selected-artist"><i class="fa-solid fa-user-astronaut"></i> Channel: ${escapeHtml(track.artist)}</p>
        <p class="selected-meta"><i class="fa-solid fa-clock"></i> Duration: ${escapeHtml(track.duration)}</p>
        <div>
          <span class="license-tag ${track.isPermitted ? 'cc-free' : 'standard'}">
            <i class="fa-solid ${track.isPermitted ? 'fa-circle-check' : 'fa-triangle-exclamation'}"></i> 
            ${escapeHtml(track.licenseInfo)}
          </span>
        </div>
      </div>
    `;

    progressBox.classList.add('hidden');
    startDownloadBtn.disabled = false;
    startDownloadBtn.innerHTML = `<i class="fa-solid fa-download"></i> Download Permitted Content`;

    downloadSection.classList.remove('hidden');
    downloadSection.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }

  function selectPlaylistForDownload(playlist, selectedVideoIds) {
    isPlaylistMode = true;
    currentSelectedPlaylist = { ...playlist, selectedVideoIds };
    permissionCheckbox.checked = false;

    selectedTrackDetail.innerHTML = `
      <img class="selected-thumb" src="${escapeHtml(playlist.thumbnail)}" alt="${escapeHtml(playlist.title)}">
      <div class="selected-info">
        <h3 class="selected-title"><i class="fa-solid fa-list-check"></i> ${escapeHtml(playlist.title)}</h3>
        <p class="selected-artist"><i class="fa-solid fa-user-astronaut"></i> Channel: ${escapeHtml(playlist.channel)}</p>
        <p class="selected-meta"><i class="fa-solid fa-file-zipper"></i> Batch Download: ${selectedVideoIds.length} Selected Tracks (Packaged into .ZIP)</p>
        <div>
          <span class="license-tag standard">
            <i class="fa-solid fa-shield-cat"></i> YouTube Playlist Batch Download
          </span>
        </div>
      </div>
    `;

    progressBox.classList.add('hidden');
    startDownloadBtn.disabled = false;
    startDownloadBtn.innerHTML = `<i class="fa-solid fa-file-zipper"></i> Download Playlist (.ZIP Archive)`;

    downloadSection.classList.remove('hidden');
    downloadSection.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }

  closeDownloadSection.addEventListener('click', () => {
    downloadSection.classList.add('hidden');
    if (activePollInterval) clearInterval(activePollInterval);
  });

  // ----------------------------------------------------
  // 7. Start Download Flow (Single Track or Playlist ZIP)
  // ----------------------------------------------------
  startDownloadBtn.addEventListener('click', async () => {
    const selectedFormat = document.querySelector('input[name="outputFormat"]:checked').value;
    const hasPermission = permissionCheckbox.checked;

    startDownloadBtn.disabled = true;
    startDownloadBtn.innerHTML = `<i class="fa-solid fa-spinner fa-spin"></i> Processing Request...`;
    progressBox.classList.remove('hidden');
    updateProgress(5, 'Validating download permissions...');

    try {
      let endpoint = '/api/download/request';
      let payload = {
        urlOrId: currentSelectedTrack ? (currentSelectedTrack.id || currentSelectedTrack.url) : '',
        format: selectedFormat,
        hasPermission
      };

      if (isPlaylistMode && currentSelectedPlaylist) {
        endpoint = '/api/playlist/download';
        payload = {
          playlistUrlOrId: currentSelectedPlaylist.playlistId,
          selectedVideoIds: currentSelectedPlaylist.selectedVideoIds,
          format: selectedFormat,
          hasPermission
        };
      }

      const response = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });

      const data = await response.json();

      if (!data.success) {
        progressBox.classList.add('hidden');
        startDownloadBtn.disabled = false;
        startDownloadBtn.innerHTML = isPlaylistMode ? `<i class="fa-solid fa-file-zipper"></i> Download Playlist (.ZIP Archive)` : `<i class="fa-solid fa-download"></i> Download Permitted Content`;

        if (data.isCopyrightBlock) {
          showToast(`Permission Denied: ${data.error}`, 'warning');
        } else {
          showToast(data.error || 'Failed to initiate download job.', 'error');
        }
        return;
      }

      // Start polling download job status
      pollJobStatus(data.jobId);
    } catch (err) {
      progressBox.classList.add('hidden');
      startDownloadBtn.disabled = false;
      startDownloadBtn.innerHTML = isPlaylistMode ? `<i class="fa-solid fa-file-zipper"></i> Download Playlist (.ZIP Archive)` : `<i class="fa-solid fa-download"></i> Download Permitted Content`;
      showToast('Network error while creating download job.', 'error');
    }
  });

  // Poll Job Status
  function pollJobStatus(jobId) {
    if (activePollInterval) clearInterval(activePollInterval);

    activePollInterval = setInterval(async () => {
      try {
        const response = await fetch(`/api/download/status/${jobId}`);
        const data = await response.json();

        if (!data.success) {
          clearInterval(activePollInterval);
          progressBox.classList.add('hidden');
          startDownloadBtn.disabled = false;
          startDownloadBtn.innerHTML = `<i class="fa-solid fa-download"></i> Download Permitted Content`;
          showToast(data.error || 'Job tracking lost.', 'error');
          return;
        }

        const job = data.job;

        if (job.status === 'downloading') {
          if (job.isPlaylist) {
            updateProgress(job.progress || 10, `Downloading track ${job.completedTracks + 1} of ${job.totalTracks} (${job.progress}%)...`);
          } else {
            updateProgress(job.progress || 30, `Extracting and processing media (${job.progress}%)...`);
          }
        } else if (job.status === 'archiving') {
          updateProgress(job.progress || 90, `Packaging files into .ZIP archive...`);
        } else if (job.status === 'completed') {
          clearInterval(activePollInterval);
          updateProgress(100, job.isPlaylist ? 'ZIP package ready! Download starting...' : 'Download complete! File transfer starting...');
          
          // Trigger file download stream
          triggerFileDownload(jobId);

          setTimeout(() => {
            startDownloadBtn.disabled = false;
            startDownloadBtn.innerHTML = `<i class="fa-solid fa-check"></i> Download Finished`;
            showToast(job.isPlaylist ? 'Playlist ZIP archive downloaded successfully!' : 'File downloaded successfully! Temporary files cleaned up.', 'success');
          }, 1500);
        } else if (job.status === 'failed') {
          clearInterval(activePollInterval);
          progressBox.classList.add('hidden');
          startDownloadBtn.disabled = false;
          startDownloadBtn.innerHTML = `<i class="fa-solid fa-download"></i> Retry Download`;
          showToast(`Processing Error: ${job.error}`, 'error');
        }
      } catch (err) {
        console.error('Polling error:', err);
      }
    }, 1200);
  }

  // Trigger file download iframe/anchor stream
  function triggerFileDownload(jobId) {
    const downloadUrl = `/api/download/file/${jobId}`;
    const a = document.createElement('a');
    a.href = downloadUrl;
    a.download = '';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  }

  // Helper: Update Progress UI
  function updateProgress(percent, text) {
    progressFill.style.width = `${percent}%`;
    progressPercent.textContent = `${percent}%`;
    progressStatusText.innerHTML = `<i class="fa-solid fa-spinner fa-spin"></i> ${text}`;
  }

  // Helper: Toast Notifications
  function showToast(message, type = 'error') {
    const toast = document.createElement('div');
    toast.className = `toast toast-${type}`;
    
    let icon = 'fa-triangle-exclamation';
    if (type === 'success') icon = 'fa-circle-check';
    if (type === 'warning') icon = 'fa-shield-cat';

    toast.innerHTML = `
      <i class="fa-solid ${icon}"></i>
      <span>${escapeHtml(message)}</span>
    `;

    toastContainer.appendChild(toast);

    setTimeout(() => {
      toast.style.opacity = '0';
      toast.style.transform = 'translateX(100%)';
      setTimeout(() => toast.remove(), 300);
    }, 4500);
  }

  // Helper Functions
  function escapeHtml(str) {
    if (!str) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }

  function escapeAttr(str) {
    if (!str) return '';
    return String(str).replace(/'/g, '&apos;').replace(/"/g, '&quot;');
  }

  function formatViews(views) {
    if (!views) return '0 views';
    const num = Number(views);
    if (num >= 1000000) return (num / 1000000).toFixed(1) + 'M views';
    if (num >= 1000) return (num / 1000).toFixed(1) + 'K views';
    return num + ' views';
  }
});
