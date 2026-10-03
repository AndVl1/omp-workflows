import { ensureManagedBroker, stopManagedBroker } from '../../src/broker.js';
import type { RunManifest } from '../../src/manifest.js';

const encodedManifest = process.argv[2];
if (encodedManifest === undefined) throw new Error('broker owner requires a run manifest');
// This helper receives the test's own manifest; the manager validates it again.
const manifest = JSON.parse(encodedManifest) as RunManifest;

let ready = false;
let stopRequested = false;
let stopping = false;

const stopWhenReady = (): void => {
  if (!ready || !stopRequested || stopping) return;
  stopping = true;
  void stopManagedBroker(manifest).then(
    () => process.stdout.write(`${JSON.stringify({ stopped: true })}\n`),
    error => {
      process.stderr.write(`${error instanceof Error ? error.message : 'broker owner cleanup failed'}\n`);
      process.exitCode = 1;
    },
  );
};

process.stdin.on('end', () => {
  stopRequested = true;
  stopWhenReady();
});
process.stdin.resume();

try {
  const result = await ensureManagedBroker(manifest);
  ready = true;
  process.stdout.write(`${JSON.stringify({ ready: true, status: result.status })}\n`);
  stopWhenReady();
} catch (error) {
  process.stdout.write(`${JSON.stringify({ ready: false, message: error instanceof Error ? error.message : 'broker owner failed' })}\n`);
  process.exitCode = 1;
}
