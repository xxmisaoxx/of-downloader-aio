// content.js — UI injection, auto-scroll orchestration, download management.
// Receives intercepted API data from injected.js (MAIN world) via postMessage.
// Delegates file downloads to background.js.

(() => {
  'use strict';

  // ── State ───────────────────────────────────────────────────────────────────

  let isRunning = false;
  let isCancelled = false;
  let stats = { total: 0, downloaded: 0, skipped: 0, failed: 0 };
  let uiInjected = false;

  // Data collected from intercepted API responses
  let collectedMediaItems = []; // from /medias endpoint
  let collectedMediaIds = new Set();
  let collectedPosts = [];      // from /posts endpoint
  let collectedPostIds = new Set();
  let collecting = false;

  // ── Intercepted Data Listener ──────────────────────────────────────────────

  const CHANNEL = 'of-dl';

  window.addEventListener('message', (event) => {
    if (event.source !== window) return;
    if (event.data?.channel !== CHANNEL || event.data?.direction !== 'to-content') return;
    if (!collecting) return;

    const { type, payload } = event.data;
    const data = payload?.data;
    if (!data) return;

    if (type === 'MEDIAS_DATA') {
      const items = Array.isArray(data) ? data : (data.list || []);
      let added = 0;
      for (const item of items) {
        const id = String(item.id);
        if (id && !collectedMediaIds.has(id)) {
          collectedMediaIds.add(id);
          collectedMediaItems.push(item);
          added++;
        }
      }
      if (added) {
        console.log(`[OF DL] +${added} media items (total: ${collectedMediaItems.length})`);
        updateStatus(`Scrolling... ${collectedMediaItems.length} media items captured`);
      }
    }

    if (type === 'POSTS_DATA') {
      const items = Array.isArray(data) ? data : (data.list || []);
      let added = 0;
      for (const item of items) {
        const id = String(item.id);
        if (id && !collectedPostIds.has(id)) {
          collectedPostIds.add(id);
          collectedPosts.push(item);
          added++;
        }
      }
      if (added) {
        console.log(`[OF DL] +${added} posts (total: ${collectedPosts.length})`);
        updateStatus(`Scrolling... ${collectedPosts.length} posts captured`);
      }
    }
  });

  // ── Utility ─────────────────────────────────────────────────────────────────

  function getCreatorFromURL() {
    const path = window.location.pathname;
    const systemPaths = new Set([
      'my', 'settings', 'chats', 'notifications', 'bookmarks',
      'subscriptions', 'explore', 'home', 'new', 'search',
      'login', 'signup', 'api', 'api2', 'terms', 'privacy',
      'dmca', 'compliance', 'refund', 'developers', 'about',
    ]);
    const match = path.match(/^\/([a-zA-Z0-9._-]+)(?:\/(media|photos|videos))?\/?$/);
    if (match && !systemPaths.has(match[1].toLowerCase())) {
      return match[1];
    }
    return null;
  }

  function isOnMediaTab() {
    return /\/media\/?$/.test(window.location.pathname);
  }

  function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
  }

  function sanitizeFilename(name) {
    return name.replace(/[<>:"/\\|?*]/g, '_').replace(/\s+/g, '_');
  }

  function sendBg(message) {
    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage(message, (response) => {
        if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
        else resolve(response);
      });
    });
  }

  // ── Navigate to Media Tab ──────────────────────────────────────────────────

  async function ensureMediaTab(creator) {
    if (isOnMediaTab()) return;

    const mediaUrl = `/${creator}/media`;
    updateStatus('Navigating to Media tab...');

    // Try clicking the "Media" tab link if it exists on the page
    const mediaLink = document.querySelector(`a[href="${mediaUrl}"], a[href="${mediaUrl}/"]`);
    if (mediaLink) {
      mediaLink.click();
    } else {
      // Fallback: direct navigation
      window.location.href = `https://onlyfans.com${mediaUrl}`;
    }

    // Wait for the URL to change and new content to load
    for (let i = 0; i < 20; i++) {
      await sleep(500);
      if (isOnMediaTab()) return;
    }
    throw new Error('Could not navigate to the Media tab. Please go there manually and try again.');
  }

  // ── Auto-Scroll ────────────────────────────────────────────────────────────

  async function scrollToLoadAll() {
    collectedMediaItems = [];
    collectedMediaIds.clear();
    collectedPosts = [];
    collectedPostIds.clear();
    collecting = true;

    const el = document.scrollingElement || document.documentElement;
    let lastCount = 0;
    let staleRounds = 0;
    const MAX_STALE = 8;

    window.scrollTo(0, 0);
    await sleep(1500);

    while (!isCancelled) {
      const prevH = el.scrollHeight;
      window.scrollTo(0, el.scrollHeight);
      await sleep(1800);

      const curCount = collectedMediaItems.length + collectedPosts.length;
      const newH = el.scrollHeight;

      if (curCount === lastCount) {
        staleRounds++;
        if (staleRounds >= MAX_STALE || (newH === prevH && staleRounds >= 3)) {
          console.log('[OF DL] Scroll complete — no new data');
          break;
        }
      } else {
        staleRounds = 0;
        lastCount = curCount;
      }
    }

    collecting = false;
    window.scrollTo(0, 0);
  }

  // ── Media Extraction ────────────────────────────────────────────────────────

  function getExtension(url, fallback) {
    try {
      const m = new URL(url).pathname.match(/\.(\w{3,4})(?:\?|$)/);
      if (m) return m[1].toLowerCase();
    } catch (e) { /* ignore */ }
    return fallback;
  }

  function extractDownloadable(media, seen, results) {
    const id = String(media.id);
    if (!id || seen.has(id)) return;
    seen.add(id);

    if (media.type === 'photo') {
      const url = media.full || media.src || media.preview || null;
      if (url) {
        results.push({ id, url, type: 'photo', filename: `${id}.${getExtension(url, 'jpg')}` });
      }
    } else if (media.type === 'video' || media.type === 'gif') {
      const url =
        media.source?.source ||
        media.files?.source?.url ||
        (media.videoSources && (media.videoSources['720']?.url || media.videoSources['240']?.url)) ||
        media.full || media.src || null;
      if (url) {
        results.push({ id, url, type: 'video', filename: `${id}.${getExtension(url, 'mp4')}` });
      }
    }
  }

  function extractAll() {
    const results = [];
    const seen = new Set();

    // Direct media items from /medias endpoint
    for (const item of collectedMediaItems) {
      // Could be a media object directly or a post-like wrapper
      if (item.media && Array.isArray(item.media)) {
        for (const m of item.media) extractDownloadable(m, seen, results);
      } else {
        extractDownloadable(item, seen, results);
      }
    }

    // Posts from /posts endpoint (each post has .media array)
    for (const post of collectedPosts) {
      if (post.media && Array.isArray(post.media)) {
        for (const m of post.media) extractDownloadable(m, seen, results);
      }
    }

    return results;
  }

  // ── Download Orchestration ──────────────────────────────────────────────────

  async function startDownload() {
    if (isRunning) return;

    const creator = getCreatorFromURL();
    if (!creator) { showError('Could not detect creator from URL.'); return; }

    isRunning = true;
    isCancelled = false;
    stats = { total: 0, downloaded: 0, skipped: 0, failed: 0 };
    setButtonState('running');
    updateProgress(0);

    try {
      // Step 1: Navigate to media tab if needed
      await ensureMediaTab(creator);
      await sleep(2000); // let initial data load

      if (isCancelled) { finish('Cancelled'); return; }

      // Step 2: Auto-scroll to load all media
      updateStatus('Scrolling to load all media...');
      await scrollToLoadAll();

      if (isCancelled) { finish('Cancelled'); return; }

      const rawCount = collectedMediaItems.length + collectedPosts.length;
      if (rawCount === 0) {
        finish('No data intercepted. Reload the page and try again — the interceptor may not have loaded in time.');
        return;
      }

      // Step 3: Extract downloadable URLs
      updateStatus(`Extracting media from ${rawCount} items...`);
      const mediaList = extractAll();
      stats.total = mediaList.length;

      if (mediaList.length === 0) {
        finish(`Captured ${rawCount} items but found no downloadable URLs.`);
        return;
      }

      updateStatus(`Found ${mediaList.length} files. Checking duplicates...`);

      // Step 4: Duplicate check
      const dupResp = await sendBg({
        type: 'CHECK_DOWNLOADED_BATCH',
        creator,
        mediaIds: mediaList.map((m) => m.id),
      });
      const dupStatuses = dupResp?.statuses || {};

      // Step 5: Download
      const safeName = sanitizeFilename(creator);

      for (let i = 0; i < mediaList.length; i++) {
        if (isCancelled) { finish('Cancelled'); return; }

        const media = mediaList[i];
        if (dupStatuses[media.id]) {
          stats.skipped++;
          updateUI();
          continue;
        }

        try {
          const result = await sendBg({
            type: 'DOWNLOAD_MEDIA',
            url: media.url,
            filename: `OnlyFans/${safeName}/${media.filename}`,
            mediaId: media.id,
            creator,
          });
          stats[result?.success ? 'downloaded' : 'failed']++;
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
      collecting = false;
      setButtonState('idle');
    }
  }

  function cancelDownload() {
    isCancelled = true;
    collecting = false;
  }

  function finish(reason) {
    isRunning = false;
    collecting = false;
    setButtonState('idle');
    const msg =
      reason === 'Complete'
        ? `Done! ${stats.downloaded} downloaded, ${stats.skipped} skipped, ${stats.failed} failed.`
        : reason === 'Cancelled'
          ? `Cancelled. ${stats.downloaded} downloaded, ${stats.skipped} skipped so far.`
          : reason;
    updateStatus(msg);
    if (reason === 'Complete' || reason === 'Cancelled') updateProgress(100);
  }

  function updateUI() {
    const done = stats.downloaded + stats.skipped + stats.failed;
    const pct = stats.total > 0 ? Math.round((done / stats.total) * 100) : 0;
    updateProgress(pct);
    let s = `${done}/${stats.total}`;
    if (stats.skipped) s += ` (${stats.skipped} skipped)`;
    if (stats.failed) s += ` (${stats.failed} failed)`;
    updateStatus(`Downloading: ${s}`);
  }

  // ── UI ──────────────────────────────────────────────────────────────────────

  function injectUI() {
    if (uiInjected || document.getElementById('of-dl-container')) return;
    const c = document.createElement('div');
    c.id = 'of-dl-container';
    c.innerHTML = `
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
        <div id="of-dl-progress-bar-bg"><div id="of-dl-progress-bar"></div></div>
        <div id="of-dl-status">Ready</div>
      </div>`;
    document.body.appendChild(c);
    uiInjected = true;
    document.getElementById('of-dl-btn').addEventListener('click', () => {
      if (isRunning) cancelDownload(); else startDownload();
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

  // ── SPA Navigation ─────────────────────────────────────────────────────────

  function checkPage() {
    if (getCreatorFromURL()) injectUI(); else removeUI();
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
