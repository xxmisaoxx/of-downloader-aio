// content.js - UI injection and download orchestration.
// All API calls are delegated to background.js which has the captured auth headers.

(() => {
  'use strict';

  // ── State ───────────────────────────────────────────────────────────────────

  let isRunning = false;
  let isCancelled = false;
  let stats = { total: 0, downloaded: 0, skipped: 0, failed: 0 };
  let uiInjected = false;

  // ── Utility ─────────────────────────────────────────────────────────────────

  function getCreatorFromURL() {
    const path = window.location.pathname;
    const systemPaths = new Set([
      'my', 'settings', 'chats', 'notifications', 'bookmarks',
      'subscriptions', 'explore', 'home', 'new', 'search',
      'login', 'signup', 'api', 'api2', 'terms', 'privacy',
      'dmca', 'compliance', 'refund', 'developers', 'about',
    ]);
    // Match /username, /username/media, /username/photos, /username/videos
    const match = path.match(/^\/([a-zA-Z0-9._-]+)(?:\/(media|photos|videos))?\/?$/);
    if (match && !systemPaths.has(match[1].toLowerCase())) {
      return match[1];
    }
    return null;
  }

  function sanitizeFilename(name) {
    return name.replace(/[<>:"/\\|?*]/g, '_').replace(/\s+/g, '_');
  }

  function sendMessage(message) {
    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage(message, (response) => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
        } else {
          resolve(response);
        }
      });
    });
  }

  // ── Download Orchestration ──────────────────────────────────────────────────

  async function startDownload() {
    if (isRunning) return;

    const creator = getCreatorFromURL();
    if (!creator) {
      showError('Could not detect creator from URL.');
      return;
    }

    isRunning = true;
    isCancelled = false;
    stats = { total: 0, downloaded: 0, skipped: 0, failed: 0 };

    setButtonState('running');
    updateProgress(0);
    updateStatus('Checking auth headers...');

    try {
      // Check if background has captured headers
      const headerStatus = await sendMessage({ type: 'GET_HEADERS_STATUS' });
      if (!headerStatus.hasCaptured) {
        throw new Error(
          'No auth headers captured yet. Browse OnlyFans for a moment (scroll the feed, click around) so the extension can capture your session, then try again.'
        );
      }

      // Step 1: Resolve username → user ID
      updateStatus(`Resolving user "${creator}"...`);
      const userResp = await sendMessage({ type: 'RESOLVE_USER', username: creator });
      if (!userResp.success) throw new Error(userResp.error);

      const { id: userId, name: displayName } = userResp.user;
      updateStatus(`Found "${displayName}" (ID: ${userId}). Fetching media list...`);

      if (isCancelled) { finish('Cancelled'); return; }

      // Step 2: Fetch all media via /medias endpoint
      const mediaResp = await sendMessage({ type: 'FETCH_ALL_MEDIAS', userId });
      if (!mediaResp.success) throw new Error(mediaResp.error);

      const mediaList = mediaResp.mediaList;
      stats.total = mediaList.length;

      if (mediaList.length === 0) {
        finish(`No downloadable media found (${mediaResp.rawCount} API items scanned).`);
        return;
      }

      updateStatus(`Found ${mediaList.length} files. Checking duplicates...`);

      if (isCancelled) { finish('Cancelled'); return; }

      // Step 3: Duplicate check
      const mediaIds = mediaList.map((m) => m.id);
      const dupResp = await sendMessage({
        type: 'CHECK_DOWNLOADED_BATCH',
        creator,
        mediaIds,
      });
      const dupStatuses = dupResp?.statuses || {};

      // Step 4: Download
      const safeName = sanitizeFilename(creator);

      for (let i = 0; i < mediaList.length; i++) {
        if (isCancelled) { finish('Cancelled'); return; }

        const media = mediaList[i];

        if (dupStatuses[media.id]) {
          stats.skipped++;
          updateUI();
          continue;
        }

        const filename = `OnlyFans/${safeName}/${media.filename}`;

        try {
          const result = await sendMessage({
            type: 'DOWNLOAD_MEDIA',
            url: media.url,
            filename,
            mediaId: media.id,
            creator,
          });
          if (result?.success) {
            stats.downloaded++;
          } else {
            stats.failed++;
          }
        } catch (err) {
          console.error(`[OF DL] Failed ${media.id}:`, err);
          stats.failed++;
        }

        updateUI();
      }

      finish('Complete');
    } catch (err) {
      console.error('[OF DL] Error:', err);
      showError(err.message);
      isRunning = false;
      setButtonState('idle');
    }
  }

  function cancelDownload() {
    isCancelled = true;
  }

  function finish(reason) {
    isRunning = false;
    setButtonState('idle');
    const msg =
      reason === 'Complete'
        ? `Done! ${stats.downloaded} downloaded, ${stats.skipped} skipped, ${stats.failed} failed.`
        : reason === 'Cancelled'
          ? `Cancelled. ${stats.downloaded} downloaded, ${stats.skipped} skipped so far.`
          : reason;
    updateStatus(msg);
    if (reason === 'Complete' || reason === 'Cancelled') {
      updateProgress(100);
    }
  }

  function updateUI() {
    const processed = stats.downloaded + stats.skipped + stats.failed;
    const pct = stats.total > 0 ? Math.round((processed / stats.total) * 100) : 0;
    updateProgress(pct);
    let s = `${processed}/${stats.total}`;
    if (stats.skipped > 0) s += ` (${stats.skipped} skipped)`;
    if (stats.failed > 0) s += ` (${stats.failed} failed)`;
    updateStatus(`Downloading: ${s}`);
  }

  // ── UI Injection ────────────────────────────────────────────────────────────

  function injectUI() {
    if (uiInjected || document.getElementById('of-dl-container')) return;

    const container = document.createElement('div');
    container.id = 'of-dl-container';
    container.innerHTML = `
      <button id="of-dl-btn" title="Download All Media">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor"
             stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
          <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
          <polyline points="7 10 12 15 17 10"/>
          <line x1="12" y1="15" x2="12" y2="3"/>
        </svg>
        <span id="of-dl-btn-text">Download All Media</span>
      </button>
      <div id="of-dl-progress-container" style="display:none;">
        <div id="of-dl-progress-bar-bg">
          <div id="of-dl-progress-bar"></div>
        </div>
        <div id="of-dl-status">Ready</div>
      </div>
    `;
    document.body.appendChild(container);
    uiInjected = true;

    document.getElementById('of-dl-btn').addEventListener('click', () => {
      if (isRunning) cancelDownload();
      else startDownload();
    });
  }

  function removeUI() {
    const el = document.getElementById('of-dl-container');
    if (el) { el.remove(); uiInjected = false; }
  }

  function setButtonState(state) {
    const btn = document.getElementById('of-dl-btn');
    const txt = document.getElementById('of-dl-btn-text');
    const prog = document.getElementById('of-dl-progress-container');
    if (!btn) return;
    if (state === 'running') {
      btn.classList.add('of-dl-running');
      txt.textContent = 'Cancel';
      prog.style.display = 'block';
    } else {
      btn.classList.remove('of-dl-running');
      txt.textContent = 'Download All Media';
    }
  }

  function updateProgress(pct) {
    const bar = document.getElementById('of-dl-progress-bar');
    if (bar) bar.style.width = `${pct}%`;
  }

  function updateStatus(text) {
    const el = document.getElementById('of-dl-status');
    if (el) el.textContent = text;
  }

  function showError(msg) {
    updateStatus(`Error: ${msg}`);
    const c = document.getElementById('of-dl-progress-container');
    if (c) c.style.display = 'block';
  }

  // ── SPA Navigation Detection ───────────────────────────────────────────────

  function checkPage() {
    if (getCreatorFromURL()) injectUI();
    else removeUI();
  }

  let lastURL = location.href;
  const observer = new MutationObserver(() => {
    if (location.href !== lastURL) {
      lastURL = location.href;
      if (isRunning) cancelDownload();
      checkPage();
    }
  });
  observer.observe(document.body, { childList: true, subtree: true });

  checkPage();
})();
