#!/usr/bin/env node
// Send Enter (raw CR) into a live session via WS, then close.
import { WebSocket } from 'ws';
import { readFileSync } from 'node:fs';

const sessionJson = JSON.parse(readFileSync('/tmp/omp-ux-e2e-model-roles/.work-state/ux-e2e/session.json', 'utf8'));
const u = new URL(sessionJson.url);
const token = u.searchParams.get('token');
const wsUrl = `ws://${u.host}/ws?token=${encodeURIComponent(token)}`;

const ws = new WebSocket(wsUrl);
ws.on('open', () => {
  console.log(`[enter] WS open ${wsUrl}`);
  setTimeout(() => {
    // raw CR
    ws.send(JSON.stringify({ t: 'i', d: '\r' }));
    console.log('[enter] sent CR');
    setTimeout(() => { try { ws.close(); } catch {} ; process.exit(0); }, 500);
  }, 500);
});
ws.on('message', (raw) => {
  const text = raw.toString();
  console.log(`[enter][frame] ${text.length}b ${JSON.stringify(text.slice(0, 200))}`);
});
ws.on('error', (e) => console.error('[enter] error:', e.message));
ws.on('close', () => console.log('[enter] WS closed'));