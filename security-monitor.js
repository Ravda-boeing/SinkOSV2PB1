/* security-monitor.js
 *
 * Load on EVERY SinkOS page, as early as possible (right after the CSP meta tag), then call
 *   SinkOSSecurity.init(sb, { allowedScriptOrigins: ['https://cdnjs.cloudflare.com'] });
 * once SinkOSAuth has created the `sb` client.
 *
 * What it does:
 *   1. Listens for CSP violations and reports them (ignoring browser-extension noise).
 *   2. Detects being framed by a foreign origin (clickjacking) and hides the page.
 *   3. Watches for <script src> elements added at runtime from origins you haven't allowed.
 *   4. Exposes verifyOsPassword() so the OS password is checked on the server, not in the browser.
 *
 * It only REPORTS. It never decides to enter Safe Mode; the server scores the signals.
 * Signals are queued until a session exists, de-duplicated, and capped per page load.
 */
(function () {
  'use strict';

  if (window.SinkOSSecurity) return;

  const MAX_REPORTS_PER_PAGE = 30;
  const DEDUPE_MS = 60000;
  const FLUSH_MS = 2000;
  const BATCH_SIZE = 10;

  const st = {
    sb: null,
    queue: [],
    sent: 0,
    seen: new Map(),
    timer: null,
    allowedScriptOrigins: new Set([location.origin]),
  };

  const EXTENSION_RE = /^(chrome-extension|moz-extension|safari-web-extension|safari-extension|ms-browser-extension):/i;
  const isExtension = (u) => EXTENSION_RE.test(String(u || ''));
  const stripQuery = (u) => String(u || '').split(/[?#]/)[0];

  function deviceId() {
    try {
      let id = localStorage.getItem('sinkos_device_id');
      if (!id) {
        id = crypto.randomUUID();
        localStorage.setItem('sinkos_device_id', id);
      }
      return id;
    } catch (_) {
      return 'unknown';
    }
  }

  // ---- reporting -----------------------------------------------------------

  function report(type, detail) {
    detail = detail || {};
    const key = type + '|' + (detail.directive || '') + '|' + (detail.blocked || detail.src || '');
    const now = Date.now();
    if (st.seen.has(key) && now - st.seen.get(key) < DEDUPE_MS) return;
    st.seen.set(key, now);
    if (st.sent + st.queue.length >= MAX_REPORTS_PER_PAGE) return;
    st.queue.push({ type: type, detail: detail });
    schedule();
  }

  function schedule() {
    if (!st.timer) st.timer = setTimeout(flush, FLUSH_MS);
  }

  async function flush() {
    st.timer = null;
    if (!st.sb || !st.queue.length) return;

    let session = null;
    try {
      const res = await st.sb.auth.getSession();
      session = res && res.data && res.data.session;
    } catch (_) { return; }
    if (!session) return; // keep queued until someone signs in

    const batch = st.queue.splice(0, BATCH_SIZE);
    try {
      const { error } = await st.sb.functions.invoke('security-report', {
        body: { device_id: deviceId(), events: batch },
      });
      if (error) throw error;
      st.sent += batch.length;
    } catch (_) {
      // Drop the batch. Never retry in a loop: a broken reporter must not become a noise source.
    }
    if (st.queue.length) schedule();
  }

  // ---- 1. CSP violations ---------------------------------------------------

  document.addEventListener('securitypolicyviolation', function (e) {
    const blocked = stripQuery(e.blockedURI);
    const source = stripQuery(e.sourceFile);
    if (isExtension(blocked) || isExtension(source)) return; // extensions cause a lot of false positives

    // Visible in the console so you can see what to allow while rolling the CSP out.
    console.warn('[SinkOS CSP]', e.effectiveDirective, 'blocked:', blocked || '(inline)',
      source ? '@ ' + source + ':' + e.lineNumber : '');

    report('csp_violation', {
      directive: String(e.effectiveDirective || '').slice(0, 60),
      blocked: blocked.slice(0, 200) || 'inline',
      source: source.slice(0, 200),
      line: e.lineNumber | 0,
      page: location.pathname.slice(0, 120),
    });
  });

  // ---- 2. Framing by a foreign origin -------------------------------------
  // Same-origin framing (e.g. the SinkOS desktop hosting its own apps) is fine and is not reported.

  (function checkFraming() {
    if (window.top === window.self) return;
    let foreign = false;
    try { void window.top.location.href; } catch (_) { foreign = true; } // cross-origin access throws
    if (!foreign) return;

    document.documentElement.style.display = 'none';
    report('foreign_framing', { page: location.pathname.slice(0, 120) });
    try { window.top.location = window.self.location; } catch (_) { /* sandboxed frame; stay hidden */ }
  })();

  // ---- 3. Runtime script injection ----------------------------------------
  // Only sees scripts added AFTER this file runs, so keep it early. Covers <script src>, not inline.

  function inspect(node) {
    if (!node || node.nodeType !== 1) return;
    const scripts = node.tagName === 'SCRIPT'
      ? [node]
      : (node.querySelectorAll ? node.querySelectorAll('script[src]') : []);
    scripts.forEach(function (s) {
      const src = s.src;
      if (!src || isExtension(src)) return;
      let u;
      try { u = new URL(src, location.href); } catch (_) { return; }
      if (st.allowedScriptOrigins.has(u.origin)) return;
      report('unexpected_script', { src: (u.origin + u.pathname).slice(0, 200) });
    });
  }

  new MutationObserver(function (muts) {
    muts.forEach(function (m) { m.addedNodes.forEach(inspect); });
  }).observe(document.documentElement, { childList: true, subtree: true });

  // ---- 4. Server-side OS password check -----------------------------------
  // IMPORTANT: sha256Hex must produce exactly what your old client-side check compared against
  // profiles.os_password_hash. If the old code trimmed, salted, or lower-cased, mirror that here.

  async function sha256Hex(text) {
    const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
    return Array.from(new Uint8Array(buf)).map(function (b) { return b.toString(16).padStart(2, '0'); }).join('');
  }

  // Resolves to one of:
  //   { ok: true }
  //   { ok: false, attempts_left, locked, retry_after, state }
  //   { ok: false, locked: true, retry_after }
  //   { ok: false, no_password: true }        -> send them to onboarding
  //   { ok: false, error: 'network' }
  async function verifyOsPassword(plain) {
    if (!st.sb) return { ok: false, error: 'not_initialised' };
    try {
      const { data, error } = await st.sb.functions.invoke('verify-os-password', {
        body: { hash: await sha256Hex(plain), device_id: deviceId() },
      });
      if (error || !data) return { ok: false, error: 'network' };
      return data;
    } catch (_) {
      return { ok: false, error: 'network' };
    }
  }

  // ---- public API ----------------------------------------------------------

  function init(sb, opts) {
    st.sb = sb;
    ((opts && opts.allowedScriptOrigins) || []).forEach(function (o) { st.allowedScriptOrigins.add(o); });
    try {
      sb.auth.onAuthStateChange(function (event) { if (event === 'SIGNED_IN') schedule(); });
    } catch (_) { /* ignore */ }
    if (st.queue.length) schedule();
  }

  window.SinkOSSecurity = { init: init, report: report, deviceId: deviceId, verifyOsPassword: verifyOsPassword };
})();
