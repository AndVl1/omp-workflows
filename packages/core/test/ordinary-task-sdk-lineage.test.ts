import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

type FixtureRun = {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
};

const repositoryRoot = fileURLToPath(new URL('../../..', import.meta.url));
const fixturePath = fileURLToPath(new URL('./fixtures/ordinary-task-sdk-lineage.mjs', import.meta.url));
const resultMarker = '@@ORDINARY_TASK_SDK_LINEAGE@@';
const fixtureTimeoutMs = 90_000;

function requireBun(): string {
  let version: string;
  try {
    version = execFileSync('bun', ['--version'], { encoding: 'utf8', timeout: 5_000 }).trim();
  } catch (error) {
    assert.fail(`Bun is required to execute the real OMP SDK fixture: ${error instanceof Error ? error.message : String(error)}`);
  }
  return version;
}

async function runFixture(bunVersion: string): Promise<FixtureRun> {
  const scratch = mkdtempSync(join(tmpdir(), 'omp-ordinary-task-sdk-lineage-'));
  try {
    for (const directory of ['home', 'config', 'cache', 'tmp', 'agent']) {
      mkdirSync(join(scratch, directory));
    }
    return await new Promise((resolve, reject) => {
      const child = spawn('bun', [fixturePath, repositoryRoot, scratch], {
        cwd: repositoryRoot,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: {
          PATH: process.env.PATH,
          HOME: join(scratch, 'home'),
          XDG_CONFIG_HOME: join(scratch, 'config'),
          XDG_CACHE_HOME: join(scratch, 'cache'),
          TMPDIR: join(scratch, 'tmp'),
          PI_CODING_AGENT_DIR: join(scratch, 'agent'),
          PI_CONFIG_DIR: '.omp',
          GIT_CONFIG_NOSYSTEM: '1',
          GIT_CONFIG_GLOBAL: join(scratch, 'home', '.gitconfig'),
        },
      });
      let stdout = '';
      let stderr = '';
      let timedOut = false;
      let killTimer: NodeJS.Timeout | undefined;
      // This bounds a separate real SDK process; fake timers cannot stop or
      // drain its host loop. Completion still awaits the actual close event.
      const timeout = setTimeout(() => {
        timedOut = true;
        child.kill('SIGTERM');
        killTimer = setTimeout(() => child.kill('SIGKILL'), 12_000);
        killTimer.unref();
      }, fixtureTimeoutMs);
      child.stdout.setEncoding('utf8').on('data', (chunk: string) => { stdout += chunk; });
      child.stderr.setEncoding('utf8').on('data', (chunk: string) => { stderr += chunk; });
      child.once('error', (error) => {
        clearTimeout(timeout);
        clearTimeout(killTimer);
        reject(new Error(`unable to launch the required Bun ${bunVersion} SDK fixture`, { cause: error }));
      });
      child.once('close', (code, signal) => {
        clearTimeout(timeout);
        clearTimeout(killTimer);
        resolve({ code, signal, stdout, stderr, timedOut });
      });
    });
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

test('ordinary no-do-work SDK task lineage preserves real child tools and nested delegation', { timeout: 120_000 }, async () => {
  const bunVersion = requireBun();
  const run = await runFixture(bunVersion);
  assert.equal(run.timedOut, false, `real SDK fixture exceeded ${fixtureTimeoutMs}ms\n${run.stdout}\n${run.stderr}`);
  assert.equal(run.code, 0, `real SDK fixture failed (signal=${run.signal})\n${run.stdout}\n${run.stderr}`);

  const resultLines = run.stdout
    .split('\n')
    .map((line) => line.endsWith('\r') ? line.slice(0, -1) : line)
    .filter((line) => line.startsWith(resultMarker));
  assert.equal(resultLines.length, 1, `expected one structured SDK fixture result\n${run.stdout}\n${run.stderr}`);
  const report = JSON.parse(resultLines[0]!.slice(resultMarker.length)) as Record<string, any>;
  assert.equal(report.verdict, 'PASS', JSON.stringify(report));
  assert.deepEqual(report.sessions, { root: true, child: true, grandchild: true, distinctManagers: true });
  assert.deepEqual(report.operations, {
    childWrite: true,
    childRead: true,
    childHashlineEdit: true,
    childBashValueAssertion: true,
    canonicalWriteDenied: true,
    nestedTaskCompleted: true,
    grandchildWrite: true,
    grandchildBashValueAssertion: true,
  });
  assert.deepEqual(report.finalBytes, { child: 'after', grandchild: 'grandchild' });
  assert.deepEqual(report.workflowState, {
    selectedRunAbsent: true,
    executionClaimAbsent: true,
    runControlAbsent: true,
    runsDirectoryAbsent: true,
    workflowToolCalls: 0,
  });
  assert.deepEqual(report.asyncJobs, { managerPresent: true, running: 0 });
});
