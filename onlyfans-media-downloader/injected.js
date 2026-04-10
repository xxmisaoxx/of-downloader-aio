// injected.js — Runs in the page's MAIN world (registered via manifest with
// "world": "MAIN" and "run_at": "document_start"). This bypasses CSP and
// ensures our XHR/fetch patches are applied BEFORE OnlyFans' JS runs.
//
// Intercepts OF's own API responses and forwards them to the content script
// via window.postMessage. No custom API calls are made.

(() => {
  'use strict';

  const CHANNEL = 'of-dl';
  const MEDIAS_PATTERN = /\/api2\/v2\/users\/\d+\/medias/;
  const POSTS_PATTERN = /\/api2\/v2\/users\/\d+\/posts/;
  const USER_PATTERN = /\/api2\/v2\/users\/[^/]+$/;

  function notify(type, payload) {
    try {
      window.postMessage({ channel: CHANNEL, direction: 'to-content', type, payload }, '*');
    } catch (e) {
      // postMessage can fail if payload is too large; split if needed
      console.warn('[OF DL] postMessage failed:', e.message);
    }
  }

  function matchUrl(url) {
    if (MEDIAS_PATTERN.test(url)) return 'MEDIAS_DATA';
    if (POSTS_PATTERN.test(url)) return 'POSTS_DATA';
    if (USER_PATTERN.test(url)) return 'USER_DATA';
    return null;
  }

  // ── Patch XMLHttpRequest ──────────────────────────────────────────────────

  const xhrOpen = XMLHttpRequest.prototype.open;
  const xhrSend = XMLHttpRequest.prototype.send;

  XMLHttpRequest.prototype.open = function (method, url) {
    this.__ofUrl = typeof url === 'string' ? url : String(url || '');
    return xhrOpen.apply(this, arguments);
  };

  XMLHttpRequest.prototype.send = function () {
    const url = this.__ofUrl || '';
    const msgType = matchUrl(url);

    if (msgType) {
      this.addEventListener('load', function () {
        if (this.status >= 200 && this.status < 300 && this.responseText) {
          try {
            const data = JSON.parse(this.responseText);
            notify(msgType, { url, data });
          } catch (e) { /* ignore */ }
        }
      });
    }

    return xhrSend.apply(this, arguments);
  };

  // ── Patch fetch ───────────────────────────────────────────────────────────

  const origFetch = window.fetch;

  window.fetch = function (input, init) {
    const url = typeof input === 'string' ? input : (input?.url || '');
    const promise = origFetch.apply(this, arguments);
    const msgType = matchUrl(url);

    if (msgType) {
      promise.then((resp) => {
        if (resp.ok) {
          resp.clone().json().then((data) => {
            notify(msgType, { url, data });
          }).catch(() => {});
        }
      }).catch(() => {});
    }

    return promise;
  };

  console.log('[OF DL] Response interceptor active (MAIN world)');
})();
