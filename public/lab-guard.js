// Lab pages can read real data, but must never save to Meridian.
(function () {
  'use strict';
  if (!new URLSearchParams(window.location.search).has('lab') || window.MERIDIAN_LAB) return;
  window.MERIDIAN_LAB = true;
  const body = '{"ok":true,"lab":true}';
  const urlOf = (url) => new URL(url, document.baseURI);
  const write = (method, url) => !/^(GET|HEAD)$/i.test(method) && urlOf(url).origin === window.location.origin;
  // Paths are enough to identify a write without logging bodies or access tokens.
  const blocked = (method, url) => console.info('[Meridian lab] blocked ' + method + ' ' + urlOf(url).pathname);

  const fetch = window.fetch;
  window.fetch = function (input, options) {
    const request = input instanceof Request;
    const method = options?.method || (request ? input.method : 'GET');
    const url = request ? input.url : input;
    if (!write(method, url)) return fetch.apply(this, arguments);
    blocked(method, url);
    return Promise.resolve(new Response(body, { status: 200, headers: { 'Content-Type': 'application/json' } }));
  };

  const beacon = navigator.sendBeacon;
  if (beacon) navigator.sendBeacon = function (url) {
    if (!write('POST', url)) return beacon.apply(this, arguments);
    blocked('POST', url);
    return true;
  };

  const xhr = XMLHttpRequest.prototype, requests = new WeakMap();
  const open = xhr.open, send = xhr.send, abort = xhr.abort;
  const fields = ['readyState', 'status', 'statusText', 'responseURL', 'response', 'responseText', 'responseXML', 'getResponseHeader', 'getAllResponseHeaders'];
  xhr.open = function (method, url, async) {
    const previous = requests.get(this);
    if (previous?.fake) fields.forEach((key) => delete this[key]);
    requests.set(this, { method, url: urlOf(url).href, async: async !== false });
    return open.apply(this, arguments);
  };
  xhr.send = function () {
    const request = requests.get(this);
    if (!request || !write(request.method, request.url)) return send.apply(this, arguments);
    blocked(request.method, request.url);
    request.fake = true;
    const set = (key, value) => Object.defineProperty(this, key, { configurable: true, value });
    const event = (name) => this.dispatchEvent(new Event(name));
    const complete = () => {
      if (requests.get(this) !== request || request.cancelled) return;
      set('status', 200); set('statusText', 'OK'); set('responseURL', request.url);
      set('getResponseHeader', (name) => name.toLowerCase() === 'content-type' ? 'application/json' : null);
      set('getAllResponseHeaders', () => 'content-type: application/json\r\n');
      set('responseText', body); set('responseXML', null);
      set('response', this.responseType === 'json' ? JSON.parse(body) : this.responseType === 'blob' ? new Blob([body], { type: 'application/json' }) : this.responseType === 'arraybuffer' ? new TextEncoder().encode(body).buffer : body);
      for (const state of [2, 3, 4]) { set('readyState', state); event('readystatechange'); if (request.cancelled) return; }
      event('load'); event('loadend');
    };
    event('loadstart');
    if (request.async) setTimeout(complete, 0); else complete();
  };
  xhr.abort = function () {
    const request = requests.get(this);
    if (request?.fake) request.cancelled = true;
    return abort.apply(this, arguments);
  };

  document.addEventListener('submit', (event) => {
    const form = event.target, button = event.submitter;
    const method = button?.getAttribute('formmethod') || form.method;
    if (method?.toLowerCase() !== 'post') return;
    event.preventDefault(); event.stopImmediatePropagation();
    blocked('POST', button?.getAttribute('formaction') || form.action);
  }, true);
  // submit() bypasses the submit event.
  const submit = HTMLFormElement.prototype.submit;
  HTMLFormElement.prototype.submit = function () {
    if (this.method.toLowerCase() !== 'post') return submit.apply(this, arguments);
    blocked('POST', this.action);
  };

  const carry = (element) => {
    const attr = element.tagName === 'IFRAME' ? 'src' : 'href';
    const source = element.getAttribute(attr);
    if (!source || source[0] === '#') return;
    const url = urlOf(source);
    if (url.origin !== window.location.origin || url.searchParams.has('lab')) return;
    url.searchParams.set('lab', '1');
    element.setAttribute(attr, url.href);
  };
  const scan = (node) => {
    if (node.nodeType !== 1) return;
    if (node.matches('iframe[src],a[href]')) carry(node);
    node.querySelectorAll('iframe[src],a[href]').forEach(carry);
  };
  new MutationObserver((records) => {
    for (const record of records) {
      if (record.type === 'attributes') scan(record.target);
      else record.addedNodes.forEach(scan);
    }
  }).observe(document.documentElement, { subtree: true, childList: true, attributes: true, attributeFilter: ['src', 'href'] });
  scan(document.documentElement);
  // A new link can be clicked before the observer has run.
  document.addEventListener('click', (event) => {
    const link = event.target.closest?.('a[href]');
    if (link) carry(link);
  }, true);
}());
