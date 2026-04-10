// injected.js - Runs in the PAGE's main world.
// Instead of making our own API calls (which bypass OF's auth interceptors),
// we patch XMLHttpRequest and fetch to intercept OF's OWN API responses.
// When OF loads posts via infinite scroll, we capture the response data and
// forward it to the content script via postMessage.

(() => {
  'use strict';

  const CHANNEL = 'of-dl';
  const POST_URL_PATTERN = /\/api2\/v2\/users\/\d+\/posts/;
  const MEDIA_URL_PATTERN = /\/api2\/v2\/users\/\d+\/medias/;
  const USER_URL_PATTERN = /\/api2\/v2\/users\/([a-zA-Z0-9._-]+)$/;

  function notify(type, payload) {
    window.postMessage({
      channel: CHANNEL,
      direction: 'to-content',
      type,
      payload,
    }, '*');
  }

  // ── Patch XMLHttpRequest ──────────────────────────────────────────────────

  const origXHROpen = XMLHttpRequest.prototype.open;
  const origXHRSend = XMLHttpRequest.prototype.send;

  XMLHttpRequest.prototype.open = function (method, url, ...rest) {
    this._ofDlUrl = typeof url === 'string' ? url : url?.toString?.() || '';
    this._ofDlMethod = method;
    return origXHROpen.call(this, method, url, ...rest);
  };

  XMLHttpRequest.prototype.send = function (...args) {
    const url = this._ofDlUrl || '';

    if (POST_URL_PATTERN.test(url)) {
      this.addEventListener('load', function () {
        try {
          if (this.status >= 200 && this.status < 300) {
            const data = JSON.parse(this.responseText);
            notify('POSTS_DATA', { url, data });
          }
        } catch (e) {
          // ignore parse errors
        }
      });
    }

    if (MEDIA_URL_PATTERN.test(url)) {
      this.addEventListener('load', function () {
        try {
          if (this.status >= 200 && this.status < 300) {
            const data = JSON.parse(this.responseText);
            notify('MEDIAS_DATA', { url, data });
          }
        } catch (e) {
          // ignore parse errors
        }
      });
    }

    if (USER_URL_PATTERN.test(url)) {
      this.addEventListener('load', function () {
        try {
          if (this.status >= 200 && this.status < 300) {
            const data = JSON.parse(this.responseText);
            if (data?.id) {
              notify('USER_DATA', { url, data });
            }
          }
        } catch (e) {
          // ignore
        }
      });
    }

    return origXHRSend.call(this, ...args);
  };

  // ── Patch fetch ───────────────────────────────────────────────────────────

  const origFetch = window.fetch;

  window.fetch = function (input, init) {
    const url = typeof input === 'string' ? input : input?.url || '';

    const promise = origFetch.call(this, input, init);

    if (POST_URL_PATTERN.test(url)) {
      promise.then((response) => {
        const clone = response.clone();
        clone.json().then((data) => {
          notify('POSTS_DATA', { url, data });
        }).catch(() => {});
      }).catch(() => {});
    }

    if (MEDIA_URL_PATTERN.test(url)) {
      promise.then((response) => {
        const clone = response.clone();
        clone.json().then((data) => {
          notify('MEDIAS_DATA', { url, data });
        }).catch(() => {});
      }).catch(() => {});
    }

    if (USER_URL_PATTERN.test(url)) {
      promise.then((response) => {
        const clone = response.clone();
        clone.json().then((data) => {
          if (data?.id) {
            notify('USER_DATA', { url, data });
          }
        }).catch(() => {});
      }).catch(() => {});
    }

    return promise;
  };

  // ── Listen for scroll-trigger commands from content script ────────────────

  window.addEventListener('message', (event) => {
    if (event.source !== window) return;
    if (event.data?.channel !== CHANNEL || event.data?.direction !== 'to-page') return;

    const { type } = event.data;

    if (type === 'SCROLL_TO_BOTTOM') {
      window.scrollTo(0, document.body.scrollHeight);
    }
  });

  // Signal ready
  notify('BRIDGE_READY', {});

  console.log('[OF Downloader] Response interceptor active');
})();
