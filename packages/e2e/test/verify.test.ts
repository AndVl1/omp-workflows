import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import * as pty from 'node-pty';
import { test } from 'node:test';

import { sessionPaths } from '../src/environment.js';
import { waitFor } from '../src/driver.js';
import { prepareRun } from '../src/prepare.js';
import { verifyRun, type VerifyResult } from '../src/verify.js';
import type { UxE2eReport } from '../src/report.js';
import { createPrepareRunFixture } from './fixtures/prepare-run.js';

const RUN_ID = 'prompt-readiness';
const SESSION_ID = 'prompt-readiness-smoke';
const API_KEY_ENV = 'E2E_READINESS_FIXTURE_KEY';
const TASK = 'Wait for the interactive prompt before submitting';
const RESPONSE = 'READINESS_GATE_RESPONSE';
const PROMPT_RELEASE_FILE = '.release-interactive-prompt';

interface TranscriptFrame {
  readonly t?: string;
  readonly d?: string;
}

const DELAYED_PROMPT_RUNTIME = `#!/bin/sh
if [ "$1" = "--version" ]; then
  printf 'omp 18.3.4\\n'
  exit 0
fi
if [ "$1" = "--help" ]; then
  printf 'Usage: omp --mode rpc --session-dir --config\\n'
  exit 0
fi
if [ "$1" = "--mode" ] && [ "$2" = "rpc" ]; then
  IFS= read -r state
  if [ "$state" = '{"id":"state","type":"get_state"}' ]; then
    printf '{"id":"state","type":"response","command":"get_state","success":true,"data":{"model":{"id":"no-request","provider":"e2e-offline"}}}\\n'
    if IFS= read -r commands && [ "$commands" = '{"id":"commands","type":"get_available_commands"}' ]; then
      printf '{"id":"commands","type":"response","command":"get_available_commands","success":true,"data":{"commands":[{"name":"do-work","source":"extension"},{"name":"cto","source":"extension"}]}}\\n'
    fi
    exit 0
  fi
  exit 1
fi
printf 'FIXTURE_WAITING_FOR_PROMPT\\n'
while [ ! -f "$OMP_PROJECT_DIR/${PROMPT_RELEASE_FILE}" ]; do sleep 0.01; done
printf '╰─ '
IFS= read -r task || exit 0
mkdir -p "$OMP_PROJECT_DIR/.work-state" || exit 2
printf '{"schema":1,"branch":"e2e/${RUN_ID}","task":"readiness test task","stage_cursor":"discovery"}\\n' > "$OMP_PROJECT_DIR/.work-state/team-state.json"
printf '${RESPONSE}\\n'
while IFS= read -r next; do :; done
`;

function readTranscript(path: string): TranscriptFrame[] {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    return [];
  }
  const frames: TranscriptFrame[] = [];
  for (const line of text.split('\n')) {
    if (line.trim().length === 0) continue;
    try {
      frames.push(JSON.parse(line) as TranscriptFrame);
    } catch {
      // Ignore an incomplete append while the PTY server is writing a frame.
    }
  }
  return frames;
}

async function waitForTranscript(
  path: string,
  predicate: (frames: readonly TranscriptFrame[]) => boolean,
  label: string,
): Promise<TranscriptFrame[]> {
  let frames: TranscriptFrame[] = [];
  await waitFor(() => {
    frames = readTranscript(path);
    return predicate(frames);
  }, { timeoutMs: 10_000, intervalMs: 25, label });
  return frames;
}

async function withE2eRoot<T>(root: string, action: () => Promise<T>): Promise<T> {
  const previous = process.env['OMP_E2E_ROOT'];
  process.env['OMP_E2E_ROOT'] = root;
  try {
    return await action();
  } finally {
    if (previous === undefined) delete process.env['OMP_E2E_ROOT'];
    else process.env['OMP_E2E_ROOT'] = previous;
  }
}

function nodePtyAvailable(): boolean {
  try {
    const probe = pty.spawn('/bin/sh', ['-c', 'exit 0'], {
      name: 'xterm-256color',
      cols: 80,
      rows: 24,
      env: process.env,
    });
    probe.onData(() => undefined);
    probe.onExit(() => undefined);
    return true;
  } catch {
    return false;
  }
}

test('live-smoke keeps the task unsubmitted until the native prompt is rendered', async t => {
  if (!nodePtyAvailable()) {
    t.skip('node-pty native binding cannot start a disposable PTY process');
    return;
  }
  const fixture = createPrepareRunFixture();
  const previousApiKey = process.env[API_KEY_ENV];
  process.env[API_KEY_ENV] = 'fixture-only-not-a-provider-credential';

  try {
    await withE2eRoot(fixture.stateRoot, async () => {
      const scenario = {
        id: 'fixture',
        title: 'Delayed native prompt readiness regression',
        command: '/do-work',
        task: TASK,
        stages: [{ id: 'submit', name: 'Submit task', expect: [RESPONSE] }],
        timing: { startupTimeoutMs: 10_000, stageTimeoutMs: 10_000, checkpointPollMs: 25 },
        screenshots: { on: [] },
        ratings: { dimensions: ['clarity'], min: 1, max: 5 },
      };
      writeFileSync(join(fixture.root, 'scenario.json'), `${JSON.stringify(scenario)}\n`);
      const config = JSON.parse(readFileSync(fixture.configPath, 'utf8')) as Record<string, unknown>;
      writeFileSync(fixture.configPath, `${JSON.stringify({
        ...config,
        model: 'e2e-offline/no-request',
        auth: { mode: 'api-key-env', keys: [{ provider: 'e2e-offline', env_name: API_KEY_ENV }] },
      }, null, 2)}\n`);
      fixture.writeRuntime(DELAYED_PROMPT_RUNTIME);

      const prepared = await prepareRun(fixture.configPath, RUN_ID);
      assert.ok(prepared.ok, `fixture prepare failed: ${prepared.error?.code ?? 'unknown'}`);
      assert.ok(prepared.manifest !== undefined && prepared.manifestPath !== undefined);
      const manifest = prepared.manifest;
      const transcriptPath = sessionPaths(manifest, SESSION_ID).transcript;
      const promptReleasePath = join(manifest.roots.workspace, PROMPT_RELEASE_FILE);
      const expectedInput = `/do-work ${TASK}`;
      const verification = verifyRun({
        manifestPath: prepared.manifestPath,
        suite: 'live-smoke',
        sessionId: SESSION_ID,
        keepFailed: true,
      });
      let earlyResult: VerifyResult | undefined;
      void verification.then(result => { earlyResult = result; });

      try {
        const startupFrames = await waitForTranscript(
          transcriptPath,
          frames => {
            if (earlyResult !== undefined) {
              throw new Error(`verification exited before interactive prompt: ${earlyResult.errors.map(error => `${error.code}: ${error.message}`).join('; ')}`);
            }
            return frames.some(frame => frame.t === 'o' && frame.d?.includes('FIXTURE_WAITING_FOR_PROMPT') === true);
          },
          'fixture startup before interactive prompt',
        );
        assert.equal(
          startupFrames.some(frame => frame.t === 'o' && frame.d?.includes('╰─ ') === true),
          false,
          'the fixture must still be withholding its interactive prompt',
        );
        assert.deepEqual(
          startupFrames.filter(frame => frame.t === 'i').map(frame => frame.d),
          [],
          'live verification must not type or submit the task while the prompt is withheld',
        );

        const connection = JSON.parse(readFileSync(sessionPaths(manifest, SESSION_ID).connection, 'utf8')) as { token: string };
        writeFileSync(promptReleasePath, 'render prompt now\n');
        const dispatchedFrames = await waitForTranscript(
          transcriptPath,
          frames =>
            frames.some(frame => frame.t === 'o' && frame.d?.includes('╰─ ') === true)
            && frames.some(frame => frame.t === 'i' && frame.d === expectedInput)
            && frames.some(frame => frame.t === 'i' && frame.d === '\r'),
          'prompt followed by task and Enter input',
        );
        const promptIndex = dispatchedFrames.findIndex(frame => frame.t === 'o' && frame.d?.includes('╰─ ') === true);
        const taskIndex = dispatchedFrames.findIndex(frame => frame.t === 'i' && frame.d === expectedInput);
        const enterIndex = dispatchedFrames.findIndex(frame => frame.t === 'i' && frame.d === '\r');
        assert.ok(promptIndex >= 0, 'native prompt output was observed');
        assert.ok(taskIndex > promptIndex, 'task input must follow native prompt output');
        assert.ok(enterIndex > taskIndex, 'Enter must follow the complete task input');

        const result = await verification;
        assert.equal(result.status, 'passed', result.errors.map(error => `${error.code}: ${error.message}`).join('\n'));
        assert.equal(result.checks.registered_command, true);
        assert.equal(result.checks.provider_response_semantic, true);
        assert.equal(result.checks.workflow_state_saved, true);
        assert.equal(result.checks.resume_state_preserved, true);
        assert.equal(result.cleanup?.ok, true);
        assert.ok(result.report !== undefined, 'verification must export a durable report before cleanup');
        const report = JSON.parse(readFileSync(result.report.jsonPath, 'utf8')) as UxE2eReport;
        assert.equal(report.verdict, 'PASS', 'saved passing suite must not export a contradictory FAIL verdict');
        const sessionIds = [SESSION_ID, `${SESSION_ID}-resume`];
        assert.deepEqual(report.receipts.verification?.session_ids, sessionIds);
        assert.equal(report.receipts.verification?.checks.resume_state_preserved, true);
        for (const id of sessionIds) {
          const copiedTranscript = report.evidence.find(path => path.endsWith(join('sessions', id, 'transcript.jsonl')));
          assert.ok(copiedTranscript !== undefined && existsSync(copiedTranscript), `retained transcript for ${id}`);
          assert.ok(readFileSync(copiedTranscript, 'utf8').includes('FIXTURE_WAITING_FOR_PROMPT'), `independent PTY output for ${id}`);
        }
        assert.equal(existsSync(transcriptPath), false, 'raw transcript was removed by cleanup');
        assert.equal(JSON.stringify(report).includes(connection.token), false, 'terminal bearer is absent from export');
      } finally {
        if (existsSync(manifest.roots.workspace)) writeFileSync(promptReleasePath, 'release during cleanup\n');
        await verification.catch(() => undefined);
      }
    });
  } finally {
    if (previousApiKey === undefined) delete process.env[API_KEY_ENV];
    else process.env[API_KEY_ENV] = previousApiKey;
    fixture.cleanup();
  }
});
