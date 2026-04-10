// background.js - Service worker for OnlyFans API access and download management.
// Intercepts ALL headers from the browser's own OF API requests, then re-uses
// them to make our own API calls (with #ofdl fragment to prevent re-interception).

// ── Header Interception ─────────────────────────────────────────────────────

let capturedHeaders = null;
let capturedAt = 0;
const HEADER_MAX_AGE = 30000; // 30s — OF regenerates sign per-request; use quickly

// Headers we should NOT copy (browser-internal security headers)
const EXCLUDED_HEADERS = new Set([
  'sec-fetch-site', 'sec-fetch-mode', 'sec-fetch-dest', 'sec-fetch-user',
  'sec-ch-ua', 'sec-ch-ua-mobile', 'sec-ch-ua-platform',
]);

chrome.webRequest.onSendHeaders.addListener(
  (details) => {
    // Skip our own re-fetched requests (identified by #ofdl fragment)
    if (details.url.includes('#ofdl')) return;
    // Skip non-tab requests (service worker, prefetch, etc.)
    if (details.tabId < 0) return;

    const headers = {};
    for (const h of details.requestHeaders || []) {
      const name = h.name.toLowerCase();
      if (!EXCLUDED_HEADERS.has(name)) {
        headers[h.name] = h.value;
      }
    }

    // Only store if we got meaningful OF headers (sign + user-id present)
    if (headers['sign'] || headers['Sign']) {
      capturedHeaders = headers;
      capturedAt = Date.now();
      console.log('[OF Downloader] Captured fresh auth headers');
    }
  },
  {
    urls: [
      'https://onlyfans.com/api2/v2/*',
    ],
  },
  ['requestHeaders', 'extraHeaders']
);

// ── OF API Fetching ─────────────────────────────────────────────────────────

function getHeaders() {
  if (!capturedHeaders) {
    return null;
  }
  // Headers are stale but might still work for some endpoints; try anyway
  return capturedHeaders;
}

async function ofApiFetch(endpoint) {
  const headers = getHeaders();
  if (!headers) {
    throw new Error(
      'No auth headers captured yet. Browse OnlyFans (scroll the feed, click a profile) so the extension can capture your session, then try again.'
    );
  }

  // Append #ofdl to prevent our webRequest listener from re-capturing this
  const url = `https://onlyfans.com/api2/v2${endpoint}${endpoint.includes('?') ? '&' : '?'}_=${Date.now()}#ofdl`;

  const resp = await fetch(url, {
    method: 'GET',
    headers: headers,
    credentials: 'omit', // headers already include cookies
  });

  if (!resp.ok) {
    const body = await resp.text().catch(() => '');
    throw new Error(`API ${resp.status}: ${resp.statusText} (${body.slice(0, 200)})`);
  }

  return resp.json();
}

async function resolveUserId(username) {
  const data = await ofApiFetch(`/users/${encodeURIComponent(username)}`);
  if (!data?.id) {
    throw new Error(`Could not resolve user "${username}". Check the username and that you're subscribed.`);
  }
  return { id: data.id, name: data.name || data.username || username };
}

async function fetchAllMedias(userId) {
  const allMedia = [];
  let offset = 0;
  const limit = 50;

  while (true) {
    const data = await ofApiFetch(
      `/users/${userId}/medias?limit=${limit}&offset=${offset}&order=publish_date_desc&counters=0&format=infinite&pinned=0`
    );

    // Response can be { list: [...] } or a direct array
    const items = Array.isArray(data) ? data : (data?.list || []);
    if (items.length === 0) break;

    allMedia.push(...items);

    if (items.length < limit || (data?.hasMore === false)) break;
    offset += limit;

    // Rate-limit: 500ms between pages
    await new Promise((r) => setTimeout(r, 500));
  }

  return allMedia;
}

// ── Media Extraction ────────────────────────────────────────────────────────

function extractMediaUrls(items) {
  const results = [];
  const seenIds = new Set();

  for (const item of items) {
    // Items from /medias endpoint can be:
    // 1. Direct media objects with type/source/src/full
    // 2. Post-like objects with a .media array
    const mediaList = item.media && Array.isArray(item.media) ? item.media : [item];

    for (const media of mediaList) {
      const id = String(media.id);
      if (!id || seenIds.has(id)) continue;
      seenIds.add(id);

      if (media.type === 'photo') {
        const url = media.full || media.src || media.preview || null;
        if (url) {
          const ext = getExtension(url, 'jpg');
          results.push({ id, url, type: 'photo', filename: `${id}.${ext}` });
        }
      } else if (media.type === 'video' || media.type === 'gif') {
        const url =
          media.source?.source ||
          media.files?.source?.url ||
          (media.videoSources && (media.videoSources['720']?.url || media.videoSources['240']?.url)) ||
          media.full ||
          media.src ||
          null;

        if (url) {
          const ext = getExtension(url, 'mp4');
          results.push({ id, url, type: 'video', filename: `${id}.${ext}` });
        }
      }
    }
  }

  return results;
}

function getExtension(url, fallback) {
  try {
    const pathname = new URL(url).pathname;
    const m = pathname.match(/\.(\w{3,4})(?:\?|$)/);
    if (m) return m[1].toLowerCase();
  } catch (e) { /* ignore */ }
  return fallback;
}

// ── Download Manager ────────────────────────────────────────────────────────

const MAX_CONCURRENT = 3;
let activeDownloads = 0;
const downloadQueue = [];

function processQueue() {
  while (activeDownloads < MAX_CONCURRENT && downloadQueue.length > 0) {
    const task = downloadQueue.shift();
    activeDownloads++;
    executeDownload(task);
  }
}

function executeDownload({ url, filename, mediaId, creator, resolve, reject }) {
  chrome.downloads.download(
    { url, filename, conflictAction: 'uniquify' },
    (downloadId) => {
      if (chrome.runtime.lastError) {
        activeDownloads--;
        reject(chrome.runtime.lastError.message);
        processQueue();
        return;
      }

      const listener = (delta) => {
        if (delta.id !== downloadId) return;
        if (delta.state) {
          if (delta.state.current === 'complete') {
            chrome.downloads.onChanged.removeListener(listener);
            activeDownloads--;
            recordDownload(creator, mediaId);
            resolve({ success: true, mediaId });
            processQueue();
          } else if (delta.state.current === 'interrupted') {
            chrome.downloads.onChanged.removeListener(listener);
            activeDownloads--;
            reject(`Interrupted: ${delta.error?.current || 'unknown'}`);
            processQueue();
          }
        }
      };
      chrome.downloads.onChanged.addListener(listener);
    }
  );
}

function queueDownload(url, filename, mediaId, creator) {
  return new Promise((resolve, reject) => {
    downloadQueue.push({ url, filename, mediaId, creator, resolve, reject });
    processQueue();
  });
}

async function downloadWithRetry(url, filename, mediaId, creator, retries) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await queueDownload(url, filename, mediaId, creator);
    } catch (error) {
      if (attempt < retries) {
        await new Promise((r) => setTimeout(r, Math.pow(2, attempt) * 1000));
      } else {
        throw error;
      }
    }
  }
}

// ── Duplicate Tracking ──────────────────────────────────────────────────────

async function recordDownload(creator, mediaId) {
  const key = `downloaded_${creator}`;
  const result = await chrome.storage.local.get(key);
  const record = result[key] || {};
  record[mediaId] = Date.now();
  await chrome.storage.local.set({ [key]: record });
}

// ── Message Handler ─────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {

  if (message.type === 'GET_HEADERS_STATUS') {
    sendResponse({ hasCaptured: !!capturedHeaders, age: Date.now() - capturedAt });
    return false;
  }

  if (message.type === 'RESOLVE_USER') {
    resolveUserId(message.username)
      .then((user) => sendResponse({ success: true, user }))
      .catch((err) => sendResponse({ success: false, error: err.message }));
    return true;
  }

  if (message.type === 'FETCH_ALL_MEDIAS') {
    fetchAllMedias(message.userId)
      .then((items) => {
        const mediaList = extractMediaUrls(items);
        sendResponse({ success: true, mediaList, rawCount: items.length });
      })
      .catch((err) => sendResponse({ success: false, error: err.message }));
    return true;
  }

  if (message.type === 'CHECK_DOWNLOADED_BATCH') {
    const { creator, mediaIds } = message;
    const key = `downloaded_${creator}`;
    chrome.storage.local.get(key).then((result) => {
      const record = result[key] || {};
      const statuses = {};
      for (const id of mediaIds) {
        statuses[id] = !!record[id];
      }
      sendResponse({ statuses });
    });
    return true;
  }

  if (message.type === 'DOWNLOAD_MEDIA') {
    const { url, filename, mediaId, creator } = message;
    downloadWithRetry(url, filename, mediaId, creator, 3)
      .then((result) => sendResponse(result))
      .catch((err) => sendResponse({ success: false, error: String(err) }));
    return true;
  }

  if (message.type === 'CLEAR_DOWNLOADS') {
    const key = `downloaded_${message.creator}`;
    chrome.storage.local.remove(key).then(() => sendResponse({ success: true }));
    return true;
  }
});
