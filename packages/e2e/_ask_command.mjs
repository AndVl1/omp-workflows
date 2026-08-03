#!/usr/bin/env node
// Smart WS driver for ux-e2e — sends the primary command, then watches
// /tmp/_ask_extra.txt for follow-up lines and sends each one verbatim.
import { WebSocket } from 'ws';
import { readFileSync, watch, existsSync, unlinkSync, statSync } from 'node:fs';
import { openSync, writeSync, closeSync } from 'node:fs';

const SESSION = '/tmp/omp-ux-e2e-model-roles/.work-state/ux-e2e/session.json';
const EXTRA_FILE = '/tmp/_ask_extra.txt';
const DRIVER_LOG = '/tmp/omp-ux-e2e-model-roles/.work-state/ux-e2e/driver.log';

const sessionJson = JSON.parse(readFileSync(SESSION, 'utf8'));
const u = new URL(sessionJson.url);
const token = u.searchParams.get('token');
const wsUrl = `ws://${u.host}/ws?token=${encodeURIComponent(token)}`;
const command = process.argv[2] ?? '/omp-model-roles recommendations';
const holdMs = Number(process.argv[3] ?? '1200000'); // 20 min default

// Reset the extra file at start
try { if (existsSync(EXTRA_FILE)) unlinkSync(EXTRA_FILE); } catch {}
const fd = openSync(EXTRA_FILE, 'a');

const log = (line) => {
  const ts = new Date().toISOString();
  const msg = `[${ts}] ${line}\n`;
  process.stdout.write(msg);
  writeSync(fd, msg);
};

const ws = new WebSocket(wsUrl);
let sent = false;
let lastSize = 0;

ws.on('open', () => {
  log(`[ask-driver] WS open ${wsUrl}`);
  setTimeout(() => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ t: 'i', d: command + '\n' }));
      log(`[ask-driver] sent: ${JSON.stringify(command)}`);
      sent = true;
    }
  }, 1500);
});

ws.on('message', (raw) => {
  const text = raw.toString();
  log(`[frame] ${text.length}b ${JSON.stringify(text.slice(0, 400))}`);
});

ws.on('close', () => log('[ask-driver] WS closed'));
ws.on('error', (e) => log(`[ask-driver] WS error: ${e.message}`));

// Poll the extra file for follow-up content
const poll = setInterval(() => {
  if (!existsSync(EXTRA_FILE)) return;
  const size = statSync(EXTRA_FILE).size;
  if (size <= lastSize) return;
  const buf = Buffer.alloc(size - lastSize);
  const ifd = openSync(EXTRA_FILE, 'r');
  try {
    // Node has no direct pwrite to fd; read whole file
    const data = readFileSync(EXTRA_FILE, 'utf8');
    const newPart = data.slice(lastSize);
    lastSize = size;
    if (newPart.trim().length === 0) return;
    if (ws.readyState !== WebSocket.OPEN) {
      log('[ask-driver] WS not open, dropping follow-up');
      return;
    }
    ws.send(JSON.stringify({ t: 'i', d: newPart }));
    log(`[ask-driver] sent follow-up: ${JSON.stringify(newPart)}`);
  } finally {
    try { closeSync(ifd); } catch {}
  }
}, 500);

setTimeout(() => {
  log(`[ask-driver] hold window ${holdMs}ms elapsed, closing WS`);
  clearInterval(poll);
  try { ws.close(); } catch {}
  try { closeSync(fd); } catch {}
  process.exit(0);
}, holdMs);