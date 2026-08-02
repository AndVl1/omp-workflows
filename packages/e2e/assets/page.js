/**
 * ux-e2e terminal page — plain script (no build step).
 *
 * Wire a local xterm instance to the session WebSocket:
 *   - token comes from ?token= (single-use, minted by the server);
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
  var token = params.get('token');
  if (!token) {
    fatal('missing ?token= — open the URL printed by `ux-e2e start`');
    return;
  }

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
  var ws = new WebSocket(
    proto + '//' + window.location.host + '/ws?token=' + encodeURIComponent(token)
  );

  ws.addEventListener('open', function () {
    setStatus('connected');
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
})();
