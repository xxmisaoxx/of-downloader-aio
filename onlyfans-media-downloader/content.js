// content.js — UI injection, auto-scroll orchestration, download management.
// Receives intercepted API data from injected.js (MAIN world) via postMessage.
// Delegates file downloads to background.js.
//
// KEY DESIGN: Always collect intercepted data (no gating flag). OF loads media
// data when the user navigates — we capture it immediately and use it later.

(() => {
  'use strict';

  // ── State ───────────────────────────────────────────────────────────────────

  let isRunning = false;
  let isCancelled = false;
  let isNavigating = false; // true while we're navigating to media tab
  let stats = { total: 0, downloaded: 0, skipped: 0, failed: 0 };
  let uiInjected = false;

  // Data collected from intercepted API responses — ALWAYS collecting
  let collectedMediaItems = [];
  let collectedMediaIds = new Set();
  let collectedPosts = [];
  let collectedPostIds = new Set();

  // ── Intercepted Data Listener (always active) ─────────────────────────────

  const CHANNEL = 'of-dl';

  window.addEventListener('message', (event) => {
    if (event.source !== window) return;
    if (event.data?.channel !== CHANNEL || event.data?.direction !== 'to-content') return;

    const { type, payload } = event.data;
    const data = payload?.data;
    if (!data) return;

    if (type === 'MEDIAS_DATA') {
      const items = Array.isArray(data) ? data : (data.list || []);
      let added = 0;
      for (const item of items) {
        const id = String(item.id || '');
        if (id && id !== 'undefined' && !collectedMediaIds.has(id)) {
          collectedMediaIds.add(id);
          collectedMediaItems.push(item);
          added++;
        }
      }
      if (added) {
        console.log(`[OF DL] +${added} media items (total: ${collectedMediaItems.length})`);
      }
    }

    if (type === 'POSTS_DATA') {
      const items = Array.isArray(data) ? data : (data.list || []);
      let added = 0;
      for (const item of items) {
        const id = String(item.id || '');
        if (id && id !== 'undefined' && !collectedPostIds.has(id)) {
          collectedPostIds.add(id);
          collectedPosts.push(item);
          added++;
        }
      }
      if (added) {
        console.log(`[OF DL] +${added} posts (total: ${collectedPosts.length})`);
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

    isNavigating = true;
    const mediaUrl = `/${creator}/media`;
    updateStatus('Navigating to Media tab...');

    // Try clicking the "Media" tab link (SPA navigation — no page reload)
    const selectors = [
      `a[href="${mediaUrl}"]`,
      `a[href="${mediaUrl}/"]`,
      `a[href="/${creator}/media"]`,
    ];
    let clicked = false;
    for (const sel of selectors) {
      const link = document.querySelector(sel);
      if (link) {
        link.click();
        clicked = true;
        break;
      }
    }

    if (!clicked) {
      // Fallback: use history API to avoid full reload
      window.history.pushState({}, '', `https://onlyfans.com${mediaUrl}`);
      window.dispatchEvent(new PopStateEvent('popstate'));
    }

    // Wait for URL to change
    for (let i = 0; i < 30; i++) {
      await sleep(500);
      if (isOnMediaTab()) {
        isNavigating = false;
        return;
      }
    }
    isNavigating = false;
    throw new Error('Could not navigate to Media tab. Please go there manually and try again.');
  }

  // ── Auto-Scroll ────────────────────────────────────────────────────────────

  async function scrollToLoadAll() {
    // Don't clear — keep data captured from initial page load and navigation
    const countBefore = collectedMediaItems.length + collectedPosts.length;

    const el = document.scrollingElement || document.documentElement;
    let lastCount = countBefore;
    let staleRounds = 0;
    const MAX_STALE = 6;

    // Start from current position and scroll down
    updateStatus(`Scrolling to load all media (${countBefore} already captured)...`);

    while (!isCancelled) {
      const prevH = el.scrollHeight;

      // Scroll in steps
      const step = Math.floor(window.innerHeight * 0.8);
      for (let pos = el.scrollTop + step; pos <= el.scrollHeight; pos += step) {
        window.scrollTo(0, pos);
        await sleep(300);
        if (isCancelled) break;
      }
      window.scrollTo(0, el.scrollHeight);
      await sleep(2000);

      const curCount = collectedMediaItems.length + collectedPosts.length;
      const newH = el.scrollHeight;

      const parts = [];
      if (collectedMediaItems.length) parts.push(`${collectedMediaItems.length} media`);
      if (collectedPosts.length) parts.push(`${collectedPosts.length} posts`);
      updateStatus(`Scrolling... ${parts.join(' + ') || '0'} captured`);

      if (curCount === lastCount) {
        staleRounds++;
        if (staleRounds >= MAX_STALE || (newH === prevH && staleRounds >= 3)) {
          console.log(`[OF DL] Scroll done (${staleRounds} stale rounds, total: ${curCount})`);
          break;
        }
      } else {
        staleRounds = 0;
        lastCount = curCount;
      }
    }

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

  function findMediaUrl(media) {
    if (media.type === 'photo' || media.type === 'image') {
      return media.full || media.src || media.preview || media.squarePreview || media.thumb || null;
    }
    if (media.type === 'video' || media.type === 'gif') {
      return (
        media.source?.source || media.source?.url ||
        media.files?.source?.url || media.files?.preview?.url ||
        (media.videoSources && (
          media.videoSources['720']?.url || media.videoSources['480']?.url || media.videoSources['240']?.url
        )) ||
        media.full || media.src || media.preview || null
      );
    }
    // Unknown type — try common fields
    return media.full || media.src || media.source?.source || media.source?.url || media.preview || null;
  }

  function extractDownloadable(media, seen, results) {
    const id = String(media.id || '');
    if (!id || id === 'undefined' || id === 'null' || seen.has(id)) return;
    seen.add(id);

    const url = findMediaUrl(media);
    if (!url) {
      console.warn(`[OF DL] No URL for media ${id} (type=${media.type}). Keys:`, Object.keys(media).join(', '));
      return;
    }

    const isVideo = media.type === 'video' || media.type === 'gif';
    results.push({ id, url, type: isVideo ? 'video' : 'photo', filename: `${id}.${getExtension(url, isVideo ? 'mp4' : 'jpg')}` });
  }

  function extractAll() {
    const results = [];
    const seen = new Set();

    // Debug: log sample structure
    if (collectedMediaItems.length > 0) {
      const s = collectedMediaItems[0];
      console.log('[OF DL] Sample media item:', JSON.stringify(s).slice(0, 1000));
    }
    if (collectedPosts.length > 0) {
      const s = collectedPosts[0];
      console.log('[OF DL] Sample post (trimmed):', JSON.stringify(s).slice(0, 1000));
    }

    // Media items from /medias endpoint (post-like wrappers with .media array)
    for (const item of collectedMediaItems) {
      if (item.media && Array.isArray(item.media)) {
        for (const m of item.media) extractDownloadable(m, seen, results);
      } else if (item.type) {
        extractDownloadable(item, seen, results);
      } else {
        // Search all array properties for media-like objects
        for (const val of Object.values(item)) {
          if (Array.isArray(val)) {
            for (const m of val) {
              if (m && typeof m === 'object' && m.id) extractDownloadable(m, seen, results);
            }
          }
        }
      }
    }

    // Posts from /posts endpoint
    for (const post of collectedPosts) {
      if (post.media && Array.isArray(post.media)) {
        for (const m of post.media) extractDownloadable(m, seen, results);
      }
    }

    console.log(`[OF DL] Extracted ${results.length} URLs from ${collectedMediaItems.length} media + ${collectedPosts.length} posts`);
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

    // Clear previously collected data for a fresh run
    collectedMediaItems = [];
    collectedMediaIds.clear();
    collectedPosts = [];
    collectedPostIds.clear();

    try {
      // Step 1: Navigate to media tab (SPA navigation, no reload)
      await ensureMediaTab(creator);
      await sleep(3000); // let OF load initial media content

      if (isCancelled) { finish('Cancelled'); return; }

      // Step 2: Scroll to trigger infinite scroll and load all media
      updateStatus('Scrolling to load all media...');
      await scrollToLoadAll();

      if (isCancelled) { finish('Cancelled'); return; }

      const rawCount = collectedMediaItems.length + collectedPosts.length;
      if (rawCount === 0) {
        finish('No data intercepted. Make sure you\'re on a creator\'s profile, reload the page (Ctrl+R), navigate to their Media tab, then click Download.');
        return;
      }

      // Step 3: Extract downloadable URLs
      updateStatus(`Extracting URLs from ${rawCount} items...`);
      const mediaList = extractAll();
      stats.total = mediaList.length;

      if (mediaList.length === 0) {
        finish(`Captured ${rawCount} items but no downloadable URLs. Check console (F12) for details.`);
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
      // DON'T cancel if we initiated the navigation ourselves
      if (isRunning && !isNavigating) {
        cancelDownload();
      }
      checkPage();
    }
  });
  observer.observe(document.body, { childList: true, subtree: true });

  checkPage();
})();
