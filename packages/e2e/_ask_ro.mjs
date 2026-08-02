#!/usr/bin/env node
// Read-only WS observer: connects, logs frames, does NOT send anything.
// Holds connection for `holdMs`, then exits.
import { WebSocket } from 'ws';
import { readFileSync, openSync, writeSync, closeSync } from 'node:fs';

const SESSION = process.argv[2] ?? '/tmp/omp-ux-e2e-model-roles/.work-state/ux-e2e/session.json';
const holdMs = Number(process.argv[3] ?? '1200000'); // 20 min default
const outFile = process.argv[4] ?? '/tmp/omp-ux-e2e-model-roles/.work-state/ux-e2e/driver.log';

const sessionJson = JSON.parse(readFileSync(SESSION, 'utf8'));
const u = new URL(sessionJson.url);
const token = u.searchParams.get('token');
const wsUrl = `ws://${u.host}/ws?token=${encodeURIComponent(token)}`;

const fd = openSync(outFile, 'a');
const log = (line) => {
  const ts = new Date().toISOString();
  const msg = `[${ts}] ${line}\n`;
  process.stdout.write(msg);
  writeSync(fd, msg);
};

const ws = new WebSocket(wsUrl);

ws.on('open', () => log(`[ask-ro] WS open ${wsUrl}`));
ws.on('message', (raw) => {
  const text = raw.toString();
  log(`[frame] ${text.length}b ${JSON.stringify(text.slice(0, 400))}`);
});
ws.on('close', () => log('[ask-ro] WS closed'));
ws.on('error', (e) => log(`[ask-ro] WS error: ${e.message}`));

setTimeout(() => {
  log(`[ask-ro] hold ${holdMs}ms elapsed, closing`);
  try { ws.close(); } catch {}
  try { closeSync(fd); } catch {}
  process.exit(0);
}, holdMs);