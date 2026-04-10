// background.js — Download manager and duplicate tracking only.
// API calls are handled by the injected.js interceptor in the page's MAIN world.

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
