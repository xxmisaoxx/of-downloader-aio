// content.js - UI injection, API pagination, media extraction, download orchestration

(() => {
  'use strict';

  // ── State ───────────────────────────────────────────────────────────────────

  let isRunning = false;
  let isCancelled = false;
  let currentCreator = null;
  let stats = { total: 0, downloaded: 0, skipped: 0, failed: 0 };
  let uiInjected = false;

  // ── Utility ─────────────────────────────────────────────────────────────────

  function getCreatorFromURL() {
    const path = window.location.pathname;
    // Match /username but not /settings, /my/..., /chats, etc.
    const systemPaths = [
      'my', 'settings', 'chats', 'notifications', 'bookmarks',
      'subscriptions', 'explore', 'home', 'new', 'search',
    ];
    const match = path.match(/^\/([a-zA-Z0-9._-]+)\/?$/);
    if (match && !systemPaths.includes(match[1])) {
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

  // ── Auth Headers ────────────────────────────────────────────────────────────

  async function getAuthHeaders() {
    const response = await sendMessage({ type: 'GET_AUTH_HEADERS' });
    if (!response?.headers || !response.headers['user-id']) {
      throw new Error(
        'Auth headers not captured yet. Browse around OnlyFans a bit so the extension can capture your session headers, then try again.'
      );
    }
    return response.headers;
  }

  // ── OF API Calls ────────────────────────────────────────────────────────────

  async function apiFetch(endpoint, headers) {
    const url = `https://onlyfans.com/api2/v2${endpoint}`;
    const resp = await fetch(url, {
      method: 'GET',
      headers: {
        accept: 'application/json, text/plain, */*',
        'app-token': headers['app-token'] || '',
        sign: headers['sign'] || '',
        time: headers['time'] || '',
        'user-id': headers['user-id'] || '',
        'x-bc': headers['x-bc'] || '',
        'user-agent': headers['user-agent'] || navigator.userAgent,
      },
      credentials: 'include',
    });

    if (!resp.ok) {
      throw new Error(`API error ${resp.status}: ${resp.statusText}`);
    }

    return resp.json();
  }

  async function resolveUserId(username, headers) {
    const data = await apiFetch(`/users/${username}`, headers);
    if (!data?.id) {
      throw new Error(`Could not resolve user ID for "${username}"`);
    }
    return data.id;
  }

  async function fetchAllPosts(userId, headers) {
    const allPosts = [];
    let beforePublishTime = '';
    let hasMore = true;

    while (hasMore && !isCancelled) {
      let endpoint = `/users/${userId}/posts?limit=50&order=publish_date_desc&skip_users=all&format=infinite`;
      if (beforePublishTime) {
        endpoint += `&beforePublishTime=${beforePublishTime}`;
      }

      const data = await apiFetch(endpoint, headers);

      if (!data || !Array.isArray(data.list) || data.list.length === 0) {
        hasMore = false;
        break;
      }

      allPosts.push(...data.list);
      updateStatus(`Scanning posts... found ${allPosts.length} so far`);

      // Use the last post's publishedAt as cursor
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

    for (const post of posts) {
      if (!post.media || !Array.isArray(post.media)) continue;

      for (const media of post.media) {
        if (media.type === 'photo' && media.full) {
          const url = media.full;
          const ext = getExtension(url, 'jpg');
          mediaItems.push({
            id: String(media.id),
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
              id: String(media.id),
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
    updateStatus('Fetching auth headers...');

    try {
      const headers = await getAuthHeaders();

      updateStatus(`Resolving user ID for ${creator}...`);
      const userId = await resolveUserId(creator, headers);

      updateStatus('Scanning posts...');
      const posts = await fetchAllPosts(userId, headers);

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
          await sendMessage({
            type: 'DOWNLOAD_MEDIA',
            url: media.url,
            filename: filename,
            mediaId: media.id,
            creator: creator,
          });
          stats.downloaded++;
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

  // Initial check
  checkPage();
})();
