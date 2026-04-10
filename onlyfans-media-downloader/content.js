// content.js - UI injection, API pagination, media extraction, download orchestration
// Uses a page-context bridge (injected.js) for API calls so that OnlyFans'
// dynamic request interceptors (which compute per-request `sign` headers) are
// invoked automatically.

(() => {
  'use strict';

  // ── State ───────────────────────────────────────────────────────────────────

  let isRunning = false;
  let isCancelled = false;
  let currentCreator = null;
  let stats = { total: 0, downloaded: 0, skipped: 0, failed: 0 };
  let uiInjected = false;
  let bridgeReady = false;
  let pendingRequests = new Map(); // id -> { resolve, reject }
  let requestIdCounter = 0;

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

    const { id, type, payload } = event.data;

    if (type === 'BRIDGE_READY') {
      bridgeReady = true;
      console.log('[OF Downloader] Page-context bridge ready');
      return;
    }

    // Match pending API request
    const pending = pendingRequests.get(id);
    if (!pending) return;

    if (type === 'API_FETCH_SUCCESS') {
      pendingRequests.delete(id);
      pending.resolve(payload);
    } else if (type === 'API_FETCH_ERROR') {
      pendingRequests.delete(id);
      pending.reject(new Error(`API error ${payload.status}: ${payload.statusText}`));
    }
  });

  function apiFetchViaBridge(url) {
    return new Promise((resolve, reject) => {
      if (!bridgeReady) {
        reject(new Error('Page bridge not ready. Please reload the page and try again.'));
        return;
      }

      const id = String(++requestIdCounter);
      pendingRequests.set(id, { resolve, reject });

      window.postMessage({
        channel: CHANNEL,
        direction: 'to-page',
        id,
        type: 'API_FETCH',
        payload: { url },
      }, '*');

      // Timeout after 30 seconds
      setTimeout(() => {
        if (pendingRequests.has(id)) {
          pendingRequests.delete(id);
          reject(new Error('API request timed out'));
        }
      }, 30000);
    });
  }

  // ── Utility ─────────────────────────────────────────────────────────────────

  function getCreatorFromURL() {
    const path = window.location.pathname;
    const systemPaths = [
      'my', 'settings', 'chats', 'notifications', 'bookmarks',
      'subscriptions', 'explore', 'home', 'new', 'search',
      'login', 'signup', 'api', 'api2', 'terms', 'privacy',
      'dmca', 'compliance', 'refund', 'developers', 'about',
    ];
    const match = path.match(/^\/([a-zA-Z0-9._-]+)\/?$/);
    if (match && !systemPaths.includes(match[1].toLowerCase())) {
      return match[1];
    }
    return null;
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

  // ── OF API Calls (via page bridge) ─────────────────────────────────────────

  async function resolveUserId(username) {
    const url = `https://onlyfans.com/api2/v2/users/${encodeURIComponent(username)}`;
    const data = await apiFetchViaBridge(url);
    if (!data?.id) {
      throw new Error(`Could not resolve user ID for "${username}". Make sure you're subscribed to this creator.`);
    }
    return data.id;
  }

  async function fetchAllPosts(userId) {
    const allPosts = [];
    let beforePublishTime = '';
    let hasMore = true;
    let page = 0;

    while (hasMore && !isCancelled) {
      let endpoint = `https://onlyfans.com/api2/v2/users/${userId}/posts?limit=50&order=publish_date_desc&skip_users=all&format=infinite`;
      if (beforePublishTime) {
        endpoint += `&beforePublishTime=${beforePublishTime}`;
      }

      let data;
      try {
        data = await apiFetchViaBridge(endpoint);
      } catch (err) {
        // If we get an error after already collecting some posts, just stop
        if (allPosts.length > 0) {
          console.warn('[OF Downloader] Pagination error, stopping:', err.message);
          break;
        }
        throw err;
      }

      if (!data || !Array.isArray(data.list) || data.list.length === 0) {
        hasMore = false;
        break;
      }

      allPosts.push(...data.list);
      page++;
      updateStatus(`Scanning posts... found ${allPosts.length} so far (page ${page})`);

      // Use the last post's timestamp as cursor
      const lastPost = data.list[data.list.length - 1];
      if (lastPost?.postedAtPrecise) {
        beforePublishTime = lastPost.postedAtPrecise;
      } else if (lastPost?.publishedAt) {
        beforePublishTime = lastPost.publishedAt;
      } else {
        hasMore = false;
      }

      if (data.hasMore === false || data.list.length < 50) {
        hasMore = false;
      }

      // Rate limit API calls
      await sleep(500);
    }

    return allPosts;
  }

  // ── Media Extraction ────────────────────────────────────────────────────────

  function extractMedia(posts) {
    const mediaItems = [];
    const seenIds = new Set();

    for (const post of posts) {
      if (!post.media || !Array.isArray(post.media)) continue;

      for (const media of post.media) {
        // Deduplicate by media ID
        const mediaId = String(media.id);
        if (seenIds.has(mediaId)) continue;
        seenIds.add(mediaId);

        if (media.type === 'photo' && media.full) {
          const url = media.full;
          const ext = getExtension(url, 'jpg');
          mediaItems.push({
            id: mediaId,
            url: url,
            type: 'photo',
            filename: `${media.id}.${ext}`,
          });
        } else if (media.type === 'video') {
          // Try to get highest quality source
          const url =
            media.source?.source ||
            media.files?.source?.url ||
            media.videoSources?.['720']?.url ||
            media.full ||
            null;

          if (url) {
            const ext = getExtension(url, 'mp4');
            mediaItems.push({
              id: mediaId,
              url: url,
              type: 'video',
              filename: `${media.id}.${ext}`,
            });
          }
        }
      }
    }

    return mediaItems;
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
    updateStatus('Connecting to OnlyFans API...');

    try {
      if (!bridgeReady) {
        throw new Error('Page bridge not ready. Please reload the page and try again.');
      }

      updateStatus(`Resolving user ID for ${creator}...`);
      const userId = await resolveUserId(creator);

      updateStatus('Scanning posts...');
      const posts = await fetchAllPosts(userId);

      if (isCancelled) {
        finish('Cancelled');
        return;
      }

      updateStatus('Extracting media URLs...');
      const mediaItems = extractMedia(posts);
      stats.total = mediaItems.length;

      if (mediaItems.length === 0) {
        finish('No media found.');
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

      // Download each item
      for (let i = 0; i < mediaItems.length; i++) {
        if (isCancelled) {
          finish('Cancelled');
          return;
        }

        const media = mediaItems[i];

        // Skip duplicates
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
    updateProgress(100);
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
      // Reset state on navigation
      if (isRunning) {
        cancelDownload();
      }
      checkPage();
    }
  });

  observer.observe(document.body, { childList: true, subtree: true });

  // ── Init ────────────────────────────────────────────────────────────────────

  // Inject the page-context bridge script
  injectPageScript();

  // Initial page check
  checkPage();
})();
