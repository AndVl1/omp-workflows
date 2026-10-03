import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import * as pty from 'node-pty';
import { test } from 'node:test';

import { sessionPaths } from '../src/environment.js';
import { waitFor } from '../src/driver.js';
import { prepareRun } from '../src/prepare.js';
import { readSessionRecord } from '../src/server.js';
import { verifyRun, type VerifyResult } from '../src/verify.js';
import type { UxE2eReport } from '../src/report.js';
import { createPrepareRunFixture } from './fixtures/prepare-run.js';

const RUN_ID = 'prompt-readiness';
const SESSION_ID = 'prompt-readiness-smoke';
const API_KEY_ENV = 'E2E_READINESS_FIXTURE_KEY';
const TASK = 'Wait for the interactive prompt before submitting';
const RESPONSE = 'READINESS_GATE_RESPONSE';
const PROMPT_RELEASE_FILE = '.release-interactive-prompt';
const HOLD_PROMPT_FILE = '.hold-interactive-prompt';
const NATIVE_START_RELEASE_PREFIX = '.release-native-start-';
const NATIVE_START_WAITING = 'FIXTURE_WAITING_FOR_NATIVE_START';
const FIXTURE_ORDINARY_RUN_ID = '11111111-1111-4111-8111-111111111111';

interface TranscriptFrame {
  readonly t?: string;
  readonly d?: string;
}

function delayedPromptRuntime(runId: string): string {
  return `#!/bin/sh
if [ "$1" = "--version" ]; then printf 'omp 18.3.4\\n'; exit 0; fi
if [ "$1" = "--help" ]; then printf 'Usage: omp --mode rpc --session-dir --config\\n'; exit 0; fi
if [ "$1" = "--mode" ] && [ "$2" = "rpc" ]; then
  IFS= read -r state || exit 1
  [ "$state" = '{"id":"state","type":"get_state"}' ] || exit 1
  printf '{"id":"state","type":"response","command":"get_state","success":true,"data":{"model":{"id":"no-request","provider":"e2e-offline"}}}\\n'
  IFS= read -r request || exit 0
  printf '{"id":"commands","type":"response","command":"get_available_commands","success":true,"data":{"commands":[{"name":"do-work","source":"extension"},{"name":"cto","source":"extension"}]}}\\n'
  exit 0
fi
native_id="fixture-$(basename "$OMP_SESSION_DIR")"
events="$OMP_SESSION_DIR/live-native-events.jsonl"
canonical_session_dir=$(node -e 'process.stdout.write(require("node:fs").realpathSync(process.env.OMP_SESSION_DIR))')
record() {
  event_time="$3"
  [ -n "$event_time" ] || event_time=$(node -e 'console.log(Date.now())')
  printf '{"schema_version":1,"timestamp":%s,"kind":"%s","native_session_id":"%s","session_directory":"%s","model":{"provider":"e2e-offline","id":"no-request"}%s}\\n' "$event_time" "$1" "$native_id" "$canonical_session_dir" "$2" >> "$events"
}
assistant='{"role":"assistant","provider":"e2e-offline","model":"no-request","api":"fixture-chat","usage":{"input":1,"output":1,"totalTokens":2},"timestamp":1,"stopReason":"stop","content":[{"type":"text","text":"${RESPONSE}"}]}'
variant=provider
if [ -f "$OMP_PROJECT_DIR/.native-message-variant" ]; then IFS= read -r variant < "$OMP_PROJECT_DIR/.native-message-variant"; fi
if [ "$variant" = 'foreign-native-directory' ]; then canonical_session_dir="$OMP_PROJECT_DIR"; fi
if [ "$variant" != 'delayed-native-startup' ]; then record session_start ''; fi
if [ "$variant" = 'startup-provider' ]; then record message_end ",\\"message\\":$assistant"; record agent_end ''; fi
if [ -f "$OMP_PROJECT_DIR/${HOLD_PROMPT_FILE}" ]; then
  printf 'FIXTURE_WAITING_FOR_PROMPT\\n'
  while [ ! -f "$OMP_PROJECT_DIR/${PROMPT_RELEASE_FILE}" ]; do sleep 0.01; done
fi
# Emit the real editor prefix before enough redraw output to evict it from a
# 2 KiB suffix. The readiness gate must inspect it before clipping the frame.
node -e 'process.stdout.write("\\x1b[36m╰─ \\x1b[0m" + "ANIMATED_BANNER".repeat(400))'
if [ "$variant" = 'delayed-native-startup' ]; then
  printf '${NATIVE_START_WAITING}\\n'
  while [ ! -f "$OMP_PROJECT_DIR/${NATIVE_START_RELEASE_PREFIX}$(basename "$OMP_SESSION_DIR")" ]; do sleep 0.01; done
  record session_start ''
fi
IFS= read -r task || exit 0
task_hash=$(node -e 'const text = process.argv[1].replace(/^\\/\\S+\\s*/u, "").replace(/^--new(?:\\s+|$)/u, "").replace(/^\\[AUTONOMOUS\\](?:\\s+|$)/u, ""); console.log(require("node:crypto").createHash("sha256").update(text.trim()).digest("hex"))' "$task")
if [ "$variant" = 'late-startup-provider' ]; then
  record before_agent_start ",\\"task_sha256\\":\\"$task_hash\\"" 0
else
  record before_agent_start ",\\"task_sha256\\":\\"$task_hash\\""
fi
RUN_DIR="$OMP_PROJECT_DIR/.work-state/runs/${FIXTURE_ORDINARY_RUN_ID}"
mkdir -p "$RUN_DIR" || exit 2
printf '{"schema":2,"run_id":"${FIXTURE_ORDINARY_RUN_ID}","run_key":"${FIXTURE_ORDINARY_RUN_ID}","branch":"e2e/${runId}","classification":{"type":"OPS","complexity":"QUICK","confidence":"HIGH","workflow":"lightweight","autonomous":false},"task":"readiness test task","workflow_override":false,"issue":null,"stage_cursor":"discovery","stages":[{"id":"discovery","status":"in_progress"}],"artifacts":{},"pause":{"kind":"none","reason":""},"updated_at":"2026-10-02T00:00:00.000Z"}\\n' > "$RUN_DIR/state.json"
case "$variant" in
  provider|delayed-native-startup|timeout-partial|late-startup-provider) record message_end ",\\"message\\":$assistant" ;;
  extension) record message_end ',"message":{"role":"developer","content":"${RESPONSE}"}' ;;
  user) record message_end ',"message":{"role":"user","content":[{"type":"text","text":"${RESPONSE}"}]}' ;;
  terminal|startup-provider) : ;;
  wrong-model) record message_end ',"message":{"role":"assistant","provider":"other-provider","model":"other-model","api":"fixture-chat","usage":{"input":1,"output":1},"timestamp":1,"stopReason":"stop","content":[{"type":"text","text":"${RESPONSE}"}]}' ;;
  tool-call) record message_end ',"message":{"role":"assistant","provider":"e2e-offline","model":"no-request","api":"fixture-chat","usage":{"input":1,"output":1},"timestamp":1,"stopReason":"toolUse","content":[{"type":"toolCall","name":"write","id":"call-1","resourcePath":"xd://workflow_prepare"}]}' ;;
  tool-missing-path) record message_end ',"message":{"role":"assistant","provider":"e2e-offline","model":"no-request","api":"fixture-chat","usage":{"input":1,"output":1},"timestamp":1,"stopReason":"toolUse","content":[{"type":"toolCall","name":"write","id":"call-1"}]}' ;;
  tool-unknown-path) record message_end ',"message":{"role":"assistant","provider":"e2e-offline","model":"no-request","api":"fixture-chat","usage":{"input":1,"output":1},"timestamp":1,"stopReason":"toolUse","content":[{"type":"toolCall","name":"write","id":"call-1","resourcePath":"xd://workflow_unknown"}]}' ;;
  truncated-provider) record message_end ',"message":{"role":"assistant","provider":"e2e-offline","model":"no-request","api":"fixture-chat","usage":{"input":1,"output":1},"timestamp":1,"stopReason":"length","content":[{"type":"text","text":"${RESPONSE}"}]}' ;;
  error-missing-meta)
    record message_end ",\\"message\\":$assistant"
    record message_end ',"message":{"role":"assistant","stopReason":"error","provider_error":true}'
    ;;
  workflow-error)
    record message_end ",\\"message\\":$assistant"
    record message_end ',"message":{"role":"toolResult","isError":true,"toolName":"write","toolCallId":"failed-1","timestamp":2}'
    ;;
  workflow-declined)
    record message_end ",\\"message\\":$assistant"
    record message_end ',"message":{"role":"toolResult","isError":false,"toolName":"write","toolCallId":"declined-1","timestamp":2,"workflow_operation":"workflow_complete","workflow_error":true}'
    ;;
  provider-error) record message_end ',"message":{"role":"assistant","provider":"e2e-offline","model":"no-request","api":"fixture-chat","usage":{"input":1,"output":0},"timestamp":1,"stopReason":"error","provider_error":true,"content":[]}' ;;
esac
printf '${RESPONSE}\\n'
[ "$variant" = 'timeout-partial' ] || record agent_end ''
while IFS= read -r next; do :; done
`;
}

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

test('live-smoke waits for native startup after transport and prompt readiness', async t => {
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
      fixture.writeRuntime(delayedPromptRuntime(RUN_ID));

      const prepared = await prepareRun(fixture.configPath, RUN_ID);
      assert.ok(prepared.ok, `fixture prepare failed: ${prepared.error?.code ?? 'unknown'}`);
      assert.ok(prepared.manifest !== undefined && prepared.manifestPath !== undefined);
      const manifest = prepared.manifest;
      const transcriptPath = sessionPaths(manifest, SESSION_ID).transcript;
      const promptReleasePath = join(manifest.roots.workspace, PROMPT_RELEASE_FILE);
      writeFileSync(join(manifest.roots.workspace, HOLD_PROMPT_FILE), 'hold until the test releases the prompt\n');
      writeFileSync(join(manifest.roots.workspace, '.native-message-variant'), 'delayed-native-startup\n');
      const resumeId = `${SESSION_ID}-resume`;
      const initialNativeRelease = join(manifest.roots.workspace, `${NATIVE_START_RELEASE_PREFIX}${SESSION_ID}`);
      const resumeNativeRelease = join(manifest.roots.workspace, `${NATIVE_START_RELEASE_PREFIX}${resumeId}`);
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
        const nativeWaitingFrames = await waitForTranscript(
          transcriptPath,
          frames => frames.some(frame => frame.t === 'o' && frame.d?.includes(NATIVE_START_WAITING) === true),
          'rendered prompt while native startup append is withheld',
        );
        assert.equal(readSessionRecord(manifest, SESSION_ID)?.ready, true);
        assert.equal(existsSync(join(manifest.roots.sessions, SESSION_ID, 'live-native-events.jsonl')), false);
        assert.equal(nativeWaitingFrames.some(frame => frame.t === 'i'), false, 'input requires native startup, not transport readiness alone');
        writeFileSync(initialNativeRelease, 'append initial native startup\n');
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

        await waitForTranscript(
          sessionPaths(manifest, resumeId).transcript,
          frames => frames.some(frame => frame.t === 'o' && frame.d?.includes(NATIVE_START_WAITING) === true),
          'new transport while native startup append is withheld',
        );
        assert.equal(readSessionRecord(manifest, resumeId)?.ready, true);
        assert.equal(existsSync(join(manifest.roots.sessions, resumeId, 'live-native-events.jsonl')), false);
        writeFileSync(resumeNativeRelease, 'append distinct restart native startup\n');
        const result = await verification;
        assert.equal(result.status, 'passed', result.errors.map(error => `${error.code}: ${error.message}`).join('\n'));
        assert.equal(result.checks.registered_command, true);
        assert.equal(result.checks.provider_response_semantic, true);
        assert.equal(result.checks.provider_message_provenance, true);
        assert.equal(result.checks.workflow_tool_errors, false);
        assert.equal(result.checks.native_session_identity, true);
        assert.equal(result.checks.workflow_state_saved, true);
        assert.equal(result.checks.resume_ready, true);
        assert.equal(result.checks.resume_native_session, true);
        assert.equal(result.checks.resume_new_session, true);
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
        if (existsSync(manifest.roots.workspace)) {
          writeFileSync(promptReleasePath, 'release during cleanup\n');
          writeFileSync(initialNativeRelease, 'release during cleanup\n');
          writeFileSync(resumeNativeRelease, 'release during cleanup\n');
        }
        await verification.catch(() => undefined);
      }
    });
  } finally {
    if (previousApiKey === undefined) delete process.env[API_KEY_ENV];
    else process.env[API_KEY_ENV] = previousApiKey;
    fixture.cleanup();
  }
});


function fixtureWorkflowState(branch: string, runId = FIXTURE_ORDINARY_RUN_ID): Record<string, unknown> {
  return {
    schema: 2,
    run_id: runId,
    run_key: runId,
    title: 'Readiness fixture',
    branch,
    classification: { type: 'OPS', complexity: 'QUICK', confidence: 'HIGH', workflow: 'lightweight', autonomous: false },
    task: 'readiness test task',
    workflow_override: false,
    issue: null,
    stage_cursor: 'discovery',
    stages: [
      { id: 'discovery', status: 'in_progress' },
      { id: 'implementation', status: 'pending' },
      { id: 'code_review', status: 'pending' },
      { id: 'review_fixes', status: 'pending' },
      { id: 'qa_tests', status: 'pending' },
      { id: 'summary', status: 'pending' },
    ],
    artifacts: {},
    pause: { kind: 'none', reason: '' },
    updated_at: '2026-10-02T00:00:00.000Z',
  };
}

function writeFixtureWorkflowState(workspace: string, branch: string, runId = FIXTURE_ORDINARY_RUN_ID): string {
  const directory = join(workspace, '.work-state', 'runs', runId);
  mkdirSync(directory, { recursive: true });
  const path = join(directory, 'state.json');
  writeFileSync(path, `${JSON.stringify(fixtureWorkflowState(branch, runId))}\n`);
  return path;
}

async function runOfflineLiveFixture(
  variant: string,
  initialState?: 'corrupt' | 'foreign-branch' | 'ambiguous' | 'path-escape',
  scenarioTask = TASK,
  scenarioInput?: string,
): Promise<VerifyResult> {
  const runId = `offline-${variant}${initialState === undefined ? '' : `-${initialState}`}`;
  const fixture = createPrepareRunFixture();
  const previousApiKey = process.env[API_KEY_ENV];
  process.env[API_KEY_ENV] = 'fixture-only-not-a-provider-credential';
  try {
    return await withE2eRoot(fixture.stateRoot, async () => {
      const scenario = {
        id: 'fixture',
        title: 'Offline native-session provenance regression',
        command: '/do-work',
        task: scenarioTask,
        ...(scenarioInput === undefined ? {} : { input: scenarioInput }),
        stages: [{ id: 'submit', name: 'Submit task', expect: [variant === 'tool-call' ? 'workflow_prepare' : variant.startsWith('tool-') ? 'write' : RESPONSE] }],
        timing: { startupTimeoutMs: 10_000, stageTimeoutMs: 2_000, checkpointPollMs: 25 },
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
      fixture.writeRuntime(delayedPromptRuntime(runId));
      const prepared = await prepareRun(fixture.configPath, runId);
      assert.ok(prepared.ok, `fixture prepare failed: ${prepared.error?.code ?? 'unknown'}`);
      assert.ok(prepared.manifest !== undefined && prepared.manifestPath !== undefined);
      if (variant !== 'provider') writeFileSync(join(prepared.manifest.roots.workspace, '.native-message-variant'), `${variant}\n`);
      if (initialState === 'corrupt') {
        const path = writeFixtureWorkflowState(prepared.manifest.roots.workspace, `e2e/${runId}`);
        writeFileSync(path, '{not valid JSON\n');
      } else if (initialState === 'foreign-branch') {
        writeFixtureWorkflowState(prepared.manifest.roots.workspace, 'e2e/another-run');
      } else if (initialState === 'ambiguous') {
        writeFixtureWorkflowState(prepared.manifest.roots.workspace, `e2e/${runId}`);
        writeFixtureWorkflowState(prepared.manifest.roots.workspace, `e2e/${runId}`, '22222222-2222-4222-8222-222222222222');
      } else if (initialState === 'path-escape') {
        const runsDir = join(prepared.manifest.roots.workspace, '.work-state', 'runs');
        mkdirSync(runsDir, { recursive: true });
        const outside = join(fixture.stateRoot, 'outside-workflow-run');
        mkdirSync(outside, { recursive: true });
        symlinkSync(outside, join(runsDir, FIXTURE_ORDINARY_RUN_ID), 'dir');
      }
      return await verifyRun({
        manifestPath: prepared.manifestPath,
        suite: 'live-smoke',
        sessionId: `offline-${variant}`,
        keepFailed: true,
      });
    });
  } finally {
    if (previousApiKey === undefined) delete process.env[API_KEY_ENV];
    else process.env[API_KEY_ENV] = previousApiKey;
    fixture.cleanup();
  }
}

test('live-smoke rejects user, extension, and terminal echoes and reports provider/workflow failures', async t => {
  if (!nodePtyAvailable()) {
    t.skip('node-pty native binding cannot start a disposable PTY process');
    return;
  }
  for (const variant of ['extension', 'user', 'terminal', 'startup-provider', 'late-startup-provider', 'wrong-model', 'tool-missing-path', 'tool-unknown-path', 'truncated-provider', 'workflow-error', 'workflow-declined', 'provider-error', 'error-missing-meta']) {
    const result = await runOfflineLiveFixture(variant);
    assert.equal(result.status, 'failed', `${variant} evidence must not pass live-smoke`);
    assert.equal(result.checks.registered_command, true, `${variant} fixture submitted the registered command`);
    assert.equal(result.checks.workflow_state_saved, true, `${variant} fixture saved a canonical schema-2 workflow state`);
    assert.equal(result.checks.provider_response_semantic, ['workflow-error', 'workflow-declined', 'error-missing-meta'].includes(variant), `${variant} preserves independently observed provider evidence`);
    if (variant === 'workflow-error' || variant === 'workflow-declined') {
      assert.equal(result.checks.workflow_tool_errors, true);
      assert.ok(result.errors.some(error => error.code === 'live_workflow_tool_error'));
    } else {
      assert.equal(result.checks.workflow_tool_errors, false);
    }
    if (['provider-error', 'error-missing-meta', 'truncated-provider'].includes(variant)) {
      assert.equal(result.checks.provider_error_observed, true);
      assert.ok(result.errors.some(error => error.code === 'live_provider_error'));
    }
  }
});

test('live-smoke rejects a native receipt claiming a different owned directory', async t => {
  if (!nodePtyAvailable()) { t.skip('node-pty native binding unavailable'); return; }
  const result = await runOfflineLiveFixture('foreign-native-directory');
  assert.equal(result.status, 'failed');
  assert.equal(result.checks.registered_command, false);
  assert.ok(result.errors.some(error => error.code === 'live_native_session_identity_mismatch'));
});

test('live-smoke rejects corrupt, foreign, ambiguous, and path-escaped canonical run state', async t => {
  if (!nodePtyAvailable()) {
    t.skip('node-pty native binding cannot start a disposable PTY process');
    return;
  }
  for (const invalidState of ['corrupt', 'foreign-branch', 'ambiguous', 'path-escape'] as const) {
    const result = await runOfflineLiveFixture('provider', invalidState);
    assert.equal(result.status, 'failed', `${invalidState} workflow state must fail live-smoke`);
    assert.ok(result.errors.some(error => error.code === 'workflow_state_invalid'), `${invalidState} workflow state is rejected at the canonical state boundary`);
  }
});

test('live-smoke accepts a genuine provider operation without requiring prose', async t => {
  if (!nodePtyAvailable()) { t.skip('node-pty native binding unavailable'); return; }
  const result = await runOfflineLiveFixture('tool-call');
  assert.equal(result.status, 'passed', result.errors.map(error => error.code).join(', '));
  assert.equal(result.checks.provider_response_semantic, true);
  assert.equal(result.checks.resume_native_session, true);
});

test('live-smoke timeout preserves native provider, command, and canonical state evidence', async t => {
  if (!nodePtyAvailable()) { t.skip('node-pty native binding unavailable'); return; }
  // Real process-level deadline coverage: fake timers cannot drive the child
  // PTY, WebSocket input, and native event file written by another OS process.
  const result = await runOfflineLiveFixture('timeout-partial');
  assert.equal(result.status, 'failed');
  assert.ok(result.errors.some(error => error.code === 'live_command_timeout'));
  assert.equal(result.checks.live_command_timed_out, true);
  assert.equal(result.checks.native_command_complete, false);
  assert.equal(result.checks.registered_command, true);
  assert.equal(result.checks.provider_response_semantic, true);
  assert.equal(result.checks.workflow_state_saved, true);
});

test('live-smoke correlates the actual collapsed or overridden task input', async t => {
  if (!nodePtyAvailable()) { t.skip('node-pty native binding unavailable'); return; }
  for (const { task, input } of [
    { task: 'Wait  for the\ninteractive prompt before submitting', input: undefined },
    { task: 'This declared task is not sent', input: '/do-work Verify the explicitly overridden task' },
    { task: 'This declared task is not sent', input: '/do-work --new [AUTONOMOUS] Verify the explicitly new task' },
  ]) {
    const result = await runOfflineLiveFixture('provider', undefined, task, input);
    assert.equal(result.status, 'passed', result.errors.map(error => error.code).join(', '));
    assert.equal(result.checks.native_command_complete, true);
    assert.equal(result.checks.provider_response_semantic, true);
  }
});
