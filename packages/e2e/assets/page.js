/**
 * ux-e2e terminal page — plain script (no build step).
 *
 * Wire a local xterm instance to the session WebSocket:
 *   - token comes from an HttpOnly cookie for the visual browser path;
 *     the legacy text path may still use ?token=;
 *   - outbound: {t:'i',d} keystrokes, {t:'r',cols,rows} resizes;
 *   - inbound:  {t:'o',d} output, {t:'exit',code} process exit,
 *               {t:'err',code,message} session errors, {t:'s',ok} ack.
 *   - exposes window.__uxTerm for the playwright driver.
 *
 * xterm and the fit addon are served as UMD globals (window.Terminal,
 * window.FitAddon) by the server from node_modules.
 */
(function () {
  'use strict';

  var termEl = document.getElementById('terminal');
  var statusEl = document.getElementById('status');
  var enterBtn = document.getElementById('enter-btn');

  function setStatus(text) {
    if (statusEl) statusEl.textContent = text;
  }

  function fatal(msg) {
    setStatus('error: ' + msg);
    document.body.style.display = 'none';
    var el = document.createElement('pre');
    el.style.cssText = 'color:#f87171;font:13px ui-monospace,monospace;padding:16px;white-space:pre-wrap';
    el.textContent = 'ux-e2e: ' + msg;
    document.body.appendChild(el);
  }

  var params = new URLSearchParams(window.location.search);
  // Browser sessions authenticate with the HttpOnly ux-e2e-token cookie.
  // Keep the query-token fallback for the text/legacy driver only; the
  // visual AI runner never puts a bearer in the browser URL or argv.
  var token = window.__uxE2eToken || params.get('token');

  var term = new Terminal({
    cursorBlink: true,
    fontSize: 13,
    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
    scrollback: 5000,
    theme: { background: '#0b0b0b', foreground: '#e5e7eb', cursor: '#e5e7eb' },
  });
  var fit = new FitAddon.FitAddon();
  term.loadAddon(fit);
  term.open(termEl);
  fit.fit();
  window.__uxTerm = term;

  var proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  var wsUrl = proto + '//' + window.location.host + '/ws';
  if (token) wsUrl += '?token=' + encodeURIComponent(token);
  var ws = new WebSocket(wsUrl);

  // Gate the Enter button until the WS is open so a click before auth-ack
  // never produces a half-press that the PTY rejects.
  if (enterBtn) enterBtn.disabled = true;

  ws.addEventListener('open', function () {
    setStatus('connected');
    if (enterBtn) enterBtn.disabled = false;
    term.focus();
  });

  ws.addEventListener('message', function (ev) {
    var msg;
    try {
      msg = JSON.parse(ev.data);
    } catch (e) {
      return;
    }
    if (msg.t === 'o') {
      term.write(msg.d);
    } else if (msg.t === 'exit') {
      term.write('\r\n\x1b[33m[process exited code=' + msg.code + ']\x1b[0m\r\n');
      setStatus('process exited code=' + msg.code);
      if (enterBtn) enterBtn.disabled = true;
      ws.close();
    } else if (msg.t === 'err') {
      term.write('\r\n\x1b[31m[error ' + msg.code + (msg.message ? ': ' + msg.message : '') + ']\x1b[0m\r\n');
      setStatus('error ' + msg.code);
    } else if (msg.t === 's') {
      // {t:'s', ok:true} — auth ack, nothing to render.
    }
  });

  ws.addEventListener('close', function () {
    term.write('\r\n\x1b[90m[connection closed]\x1b[0m\r\n');
    setStatus('disconnected');
    if (enterBtn) enterBtn.disabled = true;
  });

  ws.addEventListener('error', function () {
    term.write('\r\n\x1b[31m[connection error]\x1b[0m\r\n');
    setStatus('connection error');
  });

  term.onData(function (data) {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ t: 'i', d: data }));
    }
  });

  function sendResize() {
    try {
      fit.fit();
    } catch (e) {
      return;
    }
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ t: 'r', cols: term.cols, rows: term.rows }));
    }
  }

  window.addEventListener('resize', sendResize);
  if (typeof ResizeObserver !== 'undefined') {
    new ResizeObserver(sendResize).observe(termEl);
  }
  sendResize();

  // ----------------------------------------------------------------
  // Press Enter — emulate a REAL keyboard key (Enter) on the xterm
  // textarea. A real Enter in a PTY sends CR (0x0D, '\r'); '\n'
  // (LF) is just a line break in the editor and does NOT submit.
  //
  // Primary path: dispatch a synthetic KeyboardEvent on
  // `term.textarea`. xterm's key handler intercepts the keydown
  // and forwards '\r' via onData → ws.send({t:'i', d:'\r'}).
  //
  // Fallback (≈100 ms): if xterm did NOT emit '\r' (e.g. focus is
  // lost, the textarea is disabled, or a future xterm version
  // strips synthetic events), send '\r' directly over WS — the
  // exact same bytes a real Enter would produce. The fallback is
  // guarded by a one-shot onData listener that flips a flag the
  // instant xterm sees '\r', so the fallback never duplicates the
  // '\r' when the primary path succeeded.
  // ----------------------------------------------------------------

  function pressEnter() {
    if (ws.readyState !== WebSocket.OPEN) return Promise.resolve(false);

    // Primary: dispatch a real-looking Enter on the xterm textarea.
    // xterm's CoreBrowserTerminal listens on its own textarea, which
    // is at `term.textarea` (HTMLTextAreaElement).
    var textarea = term.textarea;
    var sawCarriageReturn = false;
    var stopFlag = false;

    if (textarea) {
      var disposable = term.onData(function (data) {
        if (stopFlag) return;
        if (typeof data === 'string' && data.indexOf('\r') !== -1) {
          sawCarriageReturn = true;
        }
      });

      try {
        var evt = new KeyboardEvent('keydown', {
          key: 'Enter',
          code: 'Enter',
          keyCode: 13,
          which: 13,
          bubbles: true,
          cancelable: true,
        });
        textarea.dispatchEvent(evt);
      } catch (e) {
        // dispatchEvent can throw on a detached element; fall through
        // to the timeout-based fallback below.
        sawCarriageReturn = true; // skip the fallback so we don't double-send
      }

      // Wait briefly for xterm to forward the keypress through onData.
      // If '\r' has arrived, the primary path succeeded — resolve true.
      return new Promise(function (resolve) {
        setTimeout(function () {
          stopFlag = true;
          try { disposable.dispose(); } catch (e) { /* ignore */ }
          if (sawCarriageReturn) {
            resolve(true);
            return;
          }
          // Fallback: send '\r' directly — exactly what a real Enter
          // would have produced downstream. xterm's primary path
          // failed (focus lost, textarea disabled, etc.) so it
          // never emitted '\r' through onData, hence no duplication.
          try {
            ws.send(JSON.stringify({ t: 'i', d: '\r' }));
            resolve(false);
          } catch (e) {
            resolve(false);
          }
        }, 100);
      });
    }

    // No textarea at all (xterm not initialised) — straight fallback.
    try {
      ws.send(JSON.stringify({ t: 'i', d: '\r' }));
    } catch (e) { /* ignore */ }
    return Promise.resolve(false);
  }

  /**
   * Programmatic text input for tests. Bypasses the xterm textarea
   * entirely and sends {t:'i', d:<text>} straight to the server. Does
   * NOT append Enter; use `__pressEnter()` for that.
   */
  function typeText(text) {
    if (ws.readyState !== WebSocket.OPEN) return false;
    try {
      ws.send(JSON.stringify({ t: 'i', d: text }));
      return true;
    } catch (e) {
      return false;
    }
  }

  window.__pressEnter = pressEnter;
  window.__typeText = typeText;

  // Wire the toolbar button to the same handler.
  if (enterBtn) {
    enterBtn.addEventListener('click', function () {
      pressEnter();
    });
  }
})();