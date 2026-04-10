// content.js - UI injection, auto-scroll collection, media extraction, download orchestration
// Uses a response-interception approach: injected.js patches XHR/fetch to capture
// OF's own API responses. We auto-scroll the page to trigger OF's infinite scroll,
// collecting post data as it loads. No custom API calls = no auth issues.

(() => {
  'use strict';

  // ── State ───────────────────────────────────────────────────────────────────

  let isRunning = false;
  let isCancelled = false;
  let currentCreator = null;
  let stats = { total: 0, downloaded: 0, skipped: 0, failed: 0 };
  let uiInjected = false;
  let bridgeReady = false;

  // Collected data from intercepted responses
  let collectedPosts = [];
  let collectedPostIds = new Set();
  let collectedMediaItems = []; // Direct media items from /medias endpoint
  let collectedMediaIds = new Set();
  let userData = null;
  let collectingPosts = false;

  // ── Page-Context Bridge ─────────────────────────────────────────────────────

  const CHANNEL = 'of-dl';

  function injectPageScript() {
    const script = document.createElement('script');
    script.src = chrome.runtime.getURL('injected.js');
    script.onload = () => script.remove();
    (document.head || document.documentElement).appendChild(script);
  }

  window.addEventListener('message', (event) => {
    if (event.source !== window) return;
    if (event.data?.channel !== CHANNEL || event.data?.direction !== 'to-content') return;

    const { type, payload } = event.data;

    if (type === 'BRIDGE_READY') {
      bridgeReady = true;
      console.log('[OF Downloader] Response interceptor bridge ready');
      return;
    }

    if (type === 'USER_DATA') {
      // Capture user data when OF loads it
      if (payload?.data?.id) {
        userData = payload.data;
        console.log('[OF Downloader] Captured user data:', userData.id, userData.username || userData.name);
      }
      return;
    }

    if (type === 'POSTS_DATA' && collectingPosts) {
      // Capture post data as OF's infinite scroll loads it
      const data = payload?.data;
      if (data && Array.isArray(data.list)) {
        let newCount = 0;
        for (const post of data.list) {
          const postId = String(post.id);
          if (!collectedPostIds.has(postId)) {
            collectedPostIds.add(postId);
            collectedPosts.push(post);
            newCount++;
          }
        }
        if (newCount > 0) {
          console.log(`[OF Downloader] Captured ${newCount} new posts (total: ${collectedPosts.length})`);
          updateStatus(`Scrolling... captured ${collectedPosts.length} posts, ${collectedMediaItems.length} media items`);
        }
      }
      return;
    }

    if (type === 'MEDIAS_DATA' && collectingPosts) {
      // Capture media items from /medias endpoint (media tab)
      // The response can be { list: [...] } or a direct array
      const data = payload?.data;
      const items = Array.isArray(data) ? data : (data?.list || []);
      let newCount = 0;
      for (const media of items) {
        const mediaId = String(media.id);
        if (!collectedMediaIds.has(mediaId)) {
          collectedMediaIds.add(mediaId);
          collectedMediaItems.push(media);
          newCount++;
        }
      }
      if (newCount > 0) {
        console.log(`[OF Downloader] Captured ${newCount} new media items (total: ${collectedMediaItems.length})`);
        updateStatus(`Scrolling... captured ${collectedPosts.length} posts, ${collectedMediaItems.length} media items`);
      }
      return;
    }
  });

  // ── Utility ─────────────────────────────────────────────────────────────────

  function getCreatorFromURL() {
    const path = window.location.pathname;
    const systemPaths = [
      'my', 'settings', 'chats', 'notifications', 'bookmarks',
      'subscriptions', 'explore', 'home', 'new', 'search',
      'login', 'signup', 'api', 'api2', 'terms', 'privacy',
      'dmca', 'compliance', 'refund', 'developers', 'about',
    ];
    // Match /username, /username/media, /username/photos, /username/videos, etc.
    const match = path.match(/^\/([a-zA-Z0-9._-]+)(?:\/(media|photos|videos))?\/?$/);
    if (match && !systemPaths.includes(match[1].toLowerCase())) {
      return match[1];
    }
    return null;
  }

  function isMediaPage() {
    return /^\/[a-zA-Z0-9._-]+\/(media|photos|videos)\/?$/.test(window.location.pathname);
  }

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function sanitizeFilename(name) {
    return name.replace(/[<>:"/\\|?*]/g, '_').replace(/\s+/g, '_');
  }

  function sendMessage(message) {
    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage(message, (response) => {
        if (chrome.runtime.lastError) {
          reject(chrome.runtime.lastError);
        } else {
          resolve(response);
        }
      });
    });
  }

  // ── Auto-Scroll to Load All Posts ──────────────────────────────────────────

  async function scrollToCollectAll() {
    collectedPosts = [];
    collectedPostIds.clear();
    collectedMediaItems = [];
    collectedMediaIds.clear();
    collectingPosts = true;

    const scrollContainer = document.scrollingElement || document.documentElement;
    let lastItemCount = 0;
    let staleRounds = 0;
    const MAX_STALE_ROUNDS = 8;

    const onMedia = isMediaPage();
    updateStatus(`Scrolling to load all ${onMedia ? 'media' : 'posts'}...`);

    // Scroll to top first
    window.scrollTo(0, 0);
    await sleep(1000);

    while (!isCancelled) {
      const prevHeight = scrollContainer.scrollHeight;

      window.scrollTo(0, scrollContainer.scrollHeight);
      await sleep(1500);

      const newHeight = scrollContainer.scrollHeight;
      // Count both posts and direct media items
      const currentItemCount = collectedPosts.length + collectedMediaItems.length;

      const statusParts = [];
      if (collectedPosts.length > 0) statusParts.push(`${collectedPosts.length} posts`);
      if (collectedMediaItems.length > 0) statusParts.push(`${collectedMediaItems.length} media items`);
      updateStatus(`Scrolling... captured ${statusParts.join(', ') || '0 items'}`);

      if (currentItemCount === lastItemCount) {
        staleRounds++;
        if (staleRounds >= MAX_STALE_ROUNDS) {
          console.log('[OF Downloader] Reached end (no new data after scrolling)');
          break;
        }
        if (newHeight === prevHeight && staleRounds >= 3) {
          console.log('[OF Downloader] Page height stable + no new items — done');
          break;
        }
      } else {
        staleRounds = 0;
        lastItemCount = currentItemCount;
      }
    }

    collectingPosts = false;
    window.scrollTo(0, 0);
  }

  // ── Media Extraction ────────────────────────────────────────────────────────

  function extractMediaFromItem(media, seenIds, results) {
    const mediaId = String(media.id);
    if (seenIds.has(mediaId)) return;
    seenIds.add(mediaId);

    if (media.type === 'photo') {
      const url = media.full || media.src || media.preview || null;
      if (url) {
        const ext = getExtension(url, 'jpg');
        results.push({
          id: mediaId,
          url: url,
          type: 'photo',
          filename: `${media.id}.${ext}`,
        });
      }
    } else if (media.type === 'video' || media.type === 'gif') {
      const url =
        media.source?.source ||
        media.files?.source?.url ||
        media.videoSources?.['720']?.url ||
        media.full ||
        media.src ||
        media.preview ||
        null;

      if (url) {
        const ext = getExtension(url, 'mp4');
        results.push({
          id: mediaId,
          url: url,
          type: 'video',
          filename: `${media.id}.${ext}`,
        });
      }
    }
  }

  function extractAllMedia() {
    const results = [];
    const seenIds = new Set();

    // Extract from posts (each post has a .media array)
    for (const post of collectedPosts) {
      if (!post.media || !Array.isArray(post.media)) continue;
      for (const media of post.media) {
        extractMediaFromItem(media, seenIds, results);
      }
    }

    // Extract from direct media items (/medias endpoint)
    // These are top-level media objects, not nested inside posts
    for (const media of collectedMediaItems) {
      extractMediaFromItem(media, seenIds, results);
    }

    return results;
  }

  function getExtension(url, fallback) {
    try {
      const pathname = new URL(url).pathname;
      const match = pathname.match(/\.(\w{3,4})(?:\?|$)/);
      if (match) return match[1].toLowerCase();
    } catch (e) {
      // ignore
    }
    return fallback;
  }

  // ── Download Orchestration ──────────────────────────────────────────────────

  async function startDownload() {
    if (isRunning) return;

    const creator = getCreatorFromURL();
    if (!creator) {
      showError('Could not detect creator username from URL.');
      return;
    }

    isRunning = true;
    isCancelled = false;
    currentCreator = creator;
    stats = { total: 0, downloaded: 0, skipped: 0, failed: 0 };

    setButtonState('running');
    updateProgress(0);

    try {
      if (!bridgeReady) {
        throw new Error('Response interceptor not ready. Please reload the page and try again.');
      }

      // Phase 1: Auto-scroll to collect all data
      const onMedia = isMediaPage();
      updateStatus(`Phase 1: Scrolling to load all ${onMedia ? 'media' : 'posts'}...`);
      await scrollToCollectAll();

      if (isCancelled) {
        finish('Cancelled');
        return;
      }

      const totalCaptured = collectedPosts.length + collectedMediaItems.length;
      if (totalCaptured === 0) {
        finish('No data captured. Navigate to the creator\'s Media tab and try again.');
        return;
      }

      // Phase 2: Extract media
      const sourceSummary = [];
      if (collectedPosts.length > 0) sourceSummary.push(`${collectedPosts.length} posts`);
      if (collectedMediaItems.length > 0) sourceSummary.push(`${collectedMediaItems.length} media items`);
      updateStatus(`Phase 2: Extracting media from ${sourceSummary.join(' + ')}...`);
      const mediaItems = extractAllMedia();
      stats.total = mediaItems.length;

      if (mediaItems.length === 0) {
        finish(`Captured ${sourceSummary.join(' + ')} but no downloadable media URLs found.`);
        return;
      }

      updateStatus(`Found ${mediaItems.length} media items. Checking for duplicates...`);

      // Batch check duplicates
      const mediaIds = mediaItems.map((m) => m.id);
      const dupResponse = await sendMessage({
        type: 'CHECK_DOWNLOADED_BATCH',
        creator: creator,
        mediaIds: mediaIds,
      });
      const dupStatuses = dupResponse?.statuses || {};

      // Phase 3: Download
      updateStatus(`Phase 3: Downloading ${mediaItems.length} files...`);

      for (let i = 0; i < mediaItems.length; i++) {
        if (isCancelled) {
          finish('Cancelled');
          return;
        }

        const media = mediaItems[i];

        if (dupStatuses[media.id]) {
          stats.skipped++;
          updateUI();
          continue;
        }

        const safeName = sanitizeFilename(creator);
        const filename = `OnlyFans/${safeName}/${media.filename}`;

        try {
          const result = await sendMessage({
            type: 'DOWNLOAD_MEDIA',
            url: media.url,
            filename: filename,
            mediaId: media.id,
            creator: creator,
          });
          if (result?.success) {
            stats.downloaded++;
          } else {
            stats.failed++;
          }
        } catch (err) {
          console.error(`[OF Downloader] Failed to download ${media.id}:`, err);
          stats.failed++;
        }

        updateUI();
      }

      finish('Complete');
    } catch (err) {
      console.error('[OF Downloader] Error:', err);
      showError(err.message);
      isRunning = false;
      setButtonState('idle');
    }
  }

  function cancelDownload() {
    isCancelled = true;
    collectingPosts = false;
  }

  function finish(reason) {
    isRunning = false;
    collectingPosts = false;
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
    const percent = stats.total > 0 ? Math.round((processed / stats.total) * 100) : 0;
    updateProgress(percent);

    let statusText = `${processed}/${stats.total}`;
    if (stats.skipped > 0) statusText += ` (${stats.skipped} skipped)`;
    if (stats.failed > 0) statusText += ` (${stats.failed} failed)`;
    updateStatus(`Downloading: ${statusText}`);
  }

  // ── UI Injection ────────────────────────────────────────────────────────────

  function injectUI() {
    if (uiInjected) return;
    if (document.getElementById('of-dl-container')) return;

    const container = document.createElement('div');
    container.id = 'of-dl-container';

    container.innerHTML = `
      <button id="of-dl-btn" title="Download All Media">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
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
      if (isRunning) {
        cancelDownload();
      } else {
        startDownload();
      }
    });
  }

  function removeUI() {
    const container = document.getElementById('of-dl-container');
    if (container) {
      container.remove();
      uiInjected = false;
    }
  }

  function setButtonState(state) {
    const btn = document.getElementById('of-dl-btn');
    const btnText = document.getElementById('of-dl-btn-text');
    const progressContainer = document.getElementById('of-dl-progress-container');

    if (!btn) return;

    if (state === 'running') {
      btn.classList.add('of-dl-running');
      btnText.textContent = 'Cancel';
      progressContainer.style.display = 'block';
    } else {
      btn.classList.remove('of-dl-running');
      btnText.textContent = 'Download All Media';
    }
  }

  function updateProgress(percent) {
    const bar = document.getElementById('of-dl-progress-bar');
    if (bar) {
      bar.style.width = `${percent}%`;
    }
  }

  function updateStatus(text) {
    const el = document.getElementById('of-dl-status');
    if (el) {
      el.textContent = text;
    }
  }

  function showError(msg) {
    updateStatus(`Error: ${msg}`);
    const container = document.getElementById('of-dl-progress-container');
    if (container) container.style.display = 'block';
  }

  // ── Page Navigation Detection ───────────────────────────────────────────────

  function checkPage() {
    const creator = getCreatorFromURL();
    if (creator) {
      injectUI();
    } else {
      removeUI();
    }
  }

  // OnlyFans is a SPA - watch for URL changes
  let lastURL = location.href;

  const observer = new MutationObserver(() => {
    if (location.href !== lastURL) {
      lastURL = location.href;
      if (isRunning) {
        cancelDownload();
      }
      checkPage();
    }
  });

  observer.observe(document.body, { childList: true, subtree: true });

  // ── Init ────────────────────────────────────────────────────────────────────

  injectPageScript();
  checkPage();
})();
