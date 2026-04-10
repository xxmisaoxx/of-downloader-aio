// background.js - Service worker for auth header capture and download management

// ── Auth Header Capture ─────────────────────────────────────────────────────

const AUTH_HEADER_NAMES = ['sign', 'time', 'app-token', 'user-id', 'x-bc', 'user-agent'];
let capturedHeaders = {};

chrome.webRequest.onBeforeSendHeaders.addListener(
  (details) => {
    if (!details.requestHeaders) return;

    const headers = {};
    for (const header of details.requestHeaders) {
      const name = header.name.toLowerCase();
      if (AUTH_HEADER_NAMES.includes(name)) {
        headers[name] = header.value;
      }
    }

    // Only update if we got meaningful headers (at least user-id)
    if (headers['user-id']) {
      capturedHeaders = { ...capturedHeaders, ...headers };
      console.log('[OF Downloader] Auth headers captured');
    }
  },
  { urls: ['https://onlyfans.com/api2/v2/*'] },
  ['requestHeaders', 'extraHeaders']
);

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
    {
      url: url,
      filename: filename,
      conflictAction: 'uniquify',
    },
    (downloadId) => {
      if (chrome.runtime.lastError) {
        activeDownloads--;
        reject(chrome.runtime.lastError.message);
        processQueue();
        return;
      }

      // Track download completion
      const listener = (delta) => {
        if (delta.id !== downloadId) return;

        if (delta.state) {
          if (delta.state.current === 'complete') {
            chrome.downloads.onChanged.removeListener(listener);
            activeDownloads--;
            // Record as downloaded
            recordDownload(creator, mediaId);
            resolve({ success: true, mediaId });
            processQueue();
          } else if (delta.state.current === 'interrupted') {
            chrome.downloads.onChanged.removeListener(listener);
            activeDownloads--;
            reject(`Download interrupted: ${delta.error?.current || 'unknown error'}`);
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

// ── Duplicate Tracking ──────────────────────────────────────────────────────

async function isDownloaded(creator, mediaId) {
  const key = `downloaded_${creator}`;
  const result = await chrome.storage.local.get(key);
  const record = result[key] || {};
  return !!record[mediaId];
}

async function recordDownload(creator, mediaId) {
  const key = `downloaded_${creator}`;
  const result = await chrome.storage.local.get(key);
  const record = result[key] || {};
  record[mediaId] = Date.now();
  await chrome.storage.local.set({ [key]: record });
}

async function downloadWithRetry(url, filename, mediaId, creator, retries) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const result = await queueDownload(url, filename, mediaId, creator);
      return result;
    } catch (error) {
      if (attempt < retries) {
        const delay = Math.pow(2, attempt) * 1000;
        await new Promise((r) => setTimeout(r, delay));
      } else {
        throw error;
      }
    }
  }
}

// ── Message Handler ─────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'GET_AUTH_HEADERS') {
    sendResponse({ headers: capturedHeaders });
    return false;
  }

  if (message.type === 'CHECK_DOWNLOADED') {
    isDownloaded(message.creator, message.mediaId).then((result) => {
      sendResponse({ downloaded: result });
    });
    return true; // async response
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
    return true; // async response
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
    chrome.storage.local.remove(key).then(() => {
      sendResponse({ success: true });
    });
    return true;
  }
});
