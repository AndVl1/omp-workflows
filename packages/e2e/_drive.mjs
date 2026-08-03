#!/usr/bin/env node
// Driver: connect WS, send command, observe frames, hold.
import { WebSocket } from 'ws';
import { readFileSync, openSync, writeSync, closeSync } from 'node:fs';

const SESSION = process.argv[2] ?? '/tmp/omp-ux-e2e-model-roles/.work-state/ux-e2e/session.json';
const command = process.argv[3] ?? '/omp-model-roles recommendations';
const holdMs = Number(process.argv[4] ?? '1200000'); // 20 min
const outFile = process.argv[5] ?? '/tmp/omp-ux-e2e-model-roles/.work-state/ux-e2e/driver.log';

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

ws.on('open', () => {
  log(`[drive] WS open ${wsUrl}`);
  setTimeout(() => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ t: 'i', d: command + '\n' }));
      log(`[drive] sent: ${JSON.stringify(command)}`);
    }
  }, 1500);
});

ws.on('message', (raw) => {
  const text = raw.toString();
  log(`[frame] ${text.length}b ${JSON.stringify(text.slice(0, 400))}`);
});

ws.on('close', () => log('[drive] WS closed'));
ws.on('error', (e) => log(`[drive] WS error: ${e.message}`));

setTimeout(() => {
  log(`[drive] hold ${holdMs}ms elapsed, closing`);
  try { ws.close(); } catch {}
  try { closeSync(fd); } catch {}
  process.exit(0);
}, holdMs);