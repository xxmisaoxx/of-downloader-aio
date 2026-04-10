// injected.js - Runs in the PAGE's main world so fetch() goes through
// OnlyFans' own request interceptors (which compute the correct dynamic
// `sign`, `time`, etc. headers per-request). The content script communicates
// with this file via window.postMessage.

(() => {
  'use strict';

  const CHANNEL = 'of-dl';

  window.addEventListener('message', async (event) => {
    if (event.source !== window) return;
    if (event.data?.channel !== CHANNEL || event.data?.direction !== 'to-page') return;

    const { id, type, payload } = event.data;

    if (type === 'API_FETCH') {
      try {
        const resp = await fetch(payload.url, {
          method: 'GET',
          credentials: 'include',
        });

        if (!resp.ok) {
          const body = await resp.text().catch(() => '');
          window.postMessage({
            channel: CHANNEL,
            direction: 'to-content',
            id,
            type: 'API_FETCH_ERROR',
            payload: { status: resp.status, statusText: resp.statusText, body },
          }, '*');
          return;
        }

        const json = await resp.json();
        window.postMessage({
          channel: CHANNEL,
          direction: 'to-content',
          id,
          type: 'API_FETCH_SUCCESS',
          payload: json,
        }, '*');
      } catch (err) {
        window.postMessage({
          channel: CHANNEL,
          direction: 'to-content',
          id,
          type: 'API_FETCH_ERROR',
          payload: { status: 0, statusText: 'Network error', body: err.message },
        }, '*');
      }
    }
  });

  // Signal to content script that the page-context bridge is ready
  window.postMessage({
    channel: CHANNEL,
    direction: 'to-content',
    type: 'BRIDGE_READY',
  }, '*');
})();
