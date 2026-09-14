/**
 * T075 — adaptive do-work nested full-profile pause, resume, and duplicate-run
 * runtime contracts (US5).
 *
 *
 * These assertions run against a live OMP session in an authorized scratch
 * repository that ships a usable constitution and NO specification workspace.
 * They define the adaptive contract before implementation lands (T076–T079):
 * without a matching workspace `/do-work` selects the full specification
 * preparation from the request's complexity, confidence, and risk (FR-026,
 * FR-027), nests the exact native profile with the same human checkpoints and
 * durable resume rules as a directly invoked workflow (FR-028, FR-071,
 * FR-075), persists exactly one nested feature/run identity, resumes a paused
 * nested run from durable state without repeating any approved phase
 * (SC-005), and never starts a second run for the same identity (FR-029).
 *
 * No command execution is mocked: every journey drives the real OMP PTY
 * through the sanctioned harness builders and asserts observable transcript
 * output plus durable workspace state. A genuinely unavailable OMP runtime
 * fails closed; an unimplemented contract must fail, not skip.
 */

import assert from 'node:assert/strict';
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { SPECIFICATION_STAGE_WAIT_TIMEOUT_MS } from '../src/specification-runtime.js';
import { answerNativeAsk, answerSelectedAsk, matchesCanonicalSelectorOptions, stripAnsi, type AskBlock, type SelectedAskBlock, TranscriptLog, waitFor, waitForOmpTuiReady, WsDriver } from '../src/driver.js';
import { createScratchSpecificationRepository } from '../src/specification-fixtures.js';
import { startTestSession, type TestSession } from '../src/server.js';
import { finalizeScratchDirectory } from '../src/scratch-lifecycle.js';

/**
 * A complex, security-sensitive, and infrastructure-sensitive request: multi
 * module architecture plus credential rotation plus a database migration. It
 * MUST route to full specification preparation (FR-027) — never to the
 * lightweight path.
 */
const REQUEST = 'Replace the monolithic payment capture with a transactional outbox across multiple modules of the orders and payouts services, rotate the stored payment-processor credentials, and migrate the transactions database to a new schema with zero downtime for customers';
const SCENARIO = {
  id: 'spec-do-work-adaptive',
  title: 'Adaptive do-work nested specification routing',
} as const;
const WAIT_TIMEOUT_MS = SPECIFICATION_STAGE_WAIT_TIMEOUT_MS;
/** Bounded window for the adaptive routing decision to appear in the transcript. */
const ROUTING_TIMEOUT_MS = 240_000;
const PRESERVE_ON_FAILURE = /^(?:1|true|yes)$/iu.test(process.env["OMP_UX_E2E_PRESERVE_ON_FAILURE"] ?? "");

type PhaseRecord = {
  phase: string;
  status: string;
  current_version: number | null;
  approved_version: number | null;
  validation_ref: string | null;
  checkpoint_ref: string | null;
  upstream_versions: unknown[];
  stale_reason: string | null;
  last_feedback: string | null;
};

type TypedDecision = {
  decision?: string;
  authorization?: string;
  actor?: { kind?: string; ref?: string; proof?: { answer_id?: string; binding?: string } };
};

type PersistedState = {
  run_key?: unknown;
  pause?: { kind?: string; reason?: string };
  stage_cursor?: string;
  cursor_epoch?: string;
  typed_checkpoint_decisions?: TypedDecision[];
  checkpoint_decisions?: Array<{ mode?: string; actor?: string; decision?: string }>;
  dispatch_capability?: { issued_for?: { cursor_epoch?: string } };
  specification?: {
    feature_id?: unknown;
    status?: unknown;
    phases?: PhaseRecord[];
    next_action?: { kind?: string; command?: string | null; reason?: string };
    handoff_ref?: unknown;
  };
};

type Scratch = { root: string; parent: string };
type OpenSession = { session: TestSession; driver: WsDriver };

// ---------------------------------------------------------------------------
// Helpers (mirroring the T040/T049 runtime harness).
// ---------------------------------------------------------------------------


/** US5 fixture: usable constitution, no specification workspace, no prior run state. */
function makeScratch(slug: string): Scratch {
  const parent = mkdtempSync(join(tmpdir(), `omp-spec-adaptive-${slug}-`));
  const repository = createScratchSpecificationRepository({
    workdir: parent,
    slug,
    runtime: true,
    constitution: { variant: 'usable' },
    extraFiles: [{ path: 'README.md', contents: '# Adaptive do-work runtime fixture\n' }],
  });
  return { root: repository.root, parent };
}

function featureIds(root: string): string[] {
  const dir = join(root, '.work-state', 'features');
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter(entry => entry.isDirectory())
    .map(entry => entry.name)
    .sort();
}

function phaseOf(state: PersistedState, phase: string): PhaseRecord | undefined {
  return state.specification?.phases?.find(candidate => candidate.phase === phase);
}

function cursorEpoch(state: PersistedState): string | null {
  const direct = state.cursor_epoch;
  if (typeof direct === 'string' && direct.length > 0) return direct;
  const issued = state.dispatch_capability?.issued_for?.cursor_epoch;
  return typeof issued === 'string' && issued.length > 0 ? issued : null;
}

function historyVersions(root: string, featureId: string, phase: string): string[] {
  const dir = join(root, 'specs', featureId, 'history', phase);
  if (!existsSync(dir)) return [];
  return readdirSync(dir).sort();
}

async function waitForState(
  root: string,
  featureId: string,
  predicate: (state: PersistedState) => boolean,
  label: string,
  timeoutMs = WAIT_TIMEOUT_MS,
): Promise<PersistedState> {
  let latest: PersistedState | undefined;
  await waitFor(
    () => {
      try {
        const candidate = readState(root, featureId);
        latest = candidate;
        return predicate(candidate);
      } catch {
        return false;
      }
    },
    { timeoutMs, intervalMs: 100, label },
  );
  assert.ok(latest !== undefined, `durable state exists after ${label}`);
  return latest;
}

async function openSession(root: string): Promise<OpenSession> {
  const session = await startTestSession({
    cwd: root,
    surface: 'text',
    maxTimeSec: 900,
    idleMs: 900_000,
    scenario: SCENARIO,
    taskPrompt: 'Exercise the adaptive do-work specification routing contract.',
  });
  if (session.pty.mode !== 'pty') {
    await session.close();
    throw new Error('node-pty could not start the real OMP process');
  }
  const driver = new WsDriver({ url: session.url, transcriptPath: session.transcriptPath });
  try {
    await driver.open();
    await waitForOmpTuiReady(driver);
  } catch (error) {
    await session.close();
    throw error;
  }
  return { session, driver };
}

async function closeSession(open: OpenSession | null): Promise<void> {
  if (open === null) return;
  await open.driver.close();
  await open.session.close();
}

async function submit(driver: WsDriver, text: string): Promise<void> {
  await driver.type(text);
  await driver.pressEnter();
}

function outputText(log: TranscriptLog, fromFrame: number): string {
  const chunks: string[] = [];
  log.refresh();
  for (const frame of log.frames.slice(fromFrame)) {
    if (frame.t !== 'o') continue;
    chunks.push(stripAnsi(frame.d));
  }
  return chunks.join('\n');
}

async function waitForTranscriptMatch(
  log: TranscriptLog,
  fromFrame: number,
  pattern: RegExp,
  label: string,
  timeoutMs = ROUTING_TIMEOUT_MS,
): Promise<void> {
  await waitFor(
    () => pattern.test(outputText(log, fromFrame)),
    { timeoutMs, intervalMs: 200, label },
  );
}

type CheckpointBlock = AskBlock | SelectedAskBlock;

function checkpointBlocks(log: TranscriptLog): CheckpointBlock[] {
  return [...log.askBlocks(), ...log.selectedAskBlocks()]
    .sort((left, right) => left.frameStart - right.frameStart || left.index - right.index);
}

async function answerCheckpoint(driver: WsDriver, block: CheckpointBlock, answer: string): Promise<void> {
  if (block.surface === 'selector') {
    const option = block.options[Number(answer) - 1];
    assert.ok(option !== undefined, `selector answer ${answer} is in range`);
    await answerSelectedAsk(driver, block, option);
  } else if (block.surface === 'native') {
    await answerNativeAsk(driver, block, answer);
  } else {
    await submit(driver, answer);
  }
}

async function waitForPhaseCheckpoint(
  open: OpenSession,
  phase: string,
  label: string,
  minBlockIndex = 1,
): Promise<CheckpointBlock> {
  const log = new TranscriptLog(open.session.transcriptPath);
  let block: CheckpointBlock | undefined;
  await waitFor(
    () => {
      block = checkpointBlocks(log).find(candidate => {
        if (candidate.index < minBlockIndex) return false;
        if (!new RegExp(phase, 'iu').test(candidate.title)) return false;
        return candidate.surface === 'selector'
          ? matchesCanonicalSelectorOptions(candidate.options, ['approve_continue', 'request_changes', 'approve_stop'])
          : candidate.options.length === 3;
      });
      return block !== undefined;
    },
    { timeoutMs: WAIT_TIMEOUT_MS, intervalMs: 100, label },
  );
  assert.ok(block !== undefined, `${phase} checkpoint is presented`);
  if (block.surface === 'selector') {
    assert.ok(matchesCanonicalSelectorOptions(block.options, ['approve_continue', 'request_changes', 'approve_stop']), `${phase} selector has canonical decisions`);
  } else {
    assert.equal(block.options.length, 3, `${phase} exposes exactly three decisions`);
    assert.match(block.options[0] ?? '', /approve[_ -]?continue/iu, `${phase} offers approve and continue`);
    assert.match(block.options[1] ?? '', /request[_ -]?changes/iu, `${phase} offers request changes`);
    assert.match(block.options[2] ?? '', /approve[_ -]?stop/iu, `${phase} offers approve and stop`);
  }
  return block;
}

function assertNoUnknownCommand(text: string, label: string): void {
  assert.doesNotMatch(
    text,
    /unknown command|unrecognized command|not a valid command|no such command|isn['']t a recognized/iu,
    `${label}: /do-work must be a registered harness command; T075 defines the adaptive behavior it must satisfy`,
  );
}

/**
 * The adaptive routing decision is observable output: `/do-work` must report
 * that it selected full specification preparation for this request and record
 * why (FR-026, FR-027, and the US5 checkpoint that every depth choice is
 * recorded with its rationale).
 */
function assertFullSpecificationRouting(text: string, label: string): void {
  assertNoUnknownCommand(text, label);
  assert.match(
    text,
    /routing report|preparation routing|preparation report/iu,
    `${label}: /do-work must report its adaptive preparation routing decision (command contract §/do-work step 5)`,
  );
  const depthLines = text
    .split('\n')
    .filter(line => /depth|preparation|routing/iu.test(line))
    .filter(line => /quick|lightweight|bounded|full/iu.test(line));
  assert.ok(
    depthLines.some(line => /full[\s_-]*spec/iu.test(line)),
    `${label}: the complex, security-, and infrastructure-sensitive request must select full specification preparation (FR-027); depth lines seen: ${JSON.stringify(depthLines)}`,
  );
  assert.doesNotMatch(
    text,
    /depth[^.\n]{0,60}\b(quick|lightweight|bounded)[\s_-]*(specify|preparation)?[^.\n]{0,40}\b(selected|chosen)\b/iu,
    `${label}: a quick or bounded depth must not be selected for this request`,
  );
  assert.match(
    text,
    /rationale|because|evidence|reason|why/iu,
    `${label}: the routing report must record why it selected the preparation depth (US5 checkpoint)`,
  );
}

function assertHumanDecisions(state: PersistedState, label: string): void {
  for (const decision of state.typed_checkpoint_decisions ?? []) {
    assert.equal(decision.authorization, 'human', `${label} decision authorization is human`);
    assert.equal(decision.actor?.kind, 'user', `${label} decision actor is the user`);
    assert.ok(decision.actor?.proof?.answer_id, `${label} decision has trusted answer proof`);
    assert.ok(decision.actor?.proof?.binding, `${label} decision has bound answer proof`);
  }
  for (const decision of state.checkpoint_decisions ?? []) {
    assert.notEqual(decision.mode, 'autonomous', `${label} has no autonomous approval`);
    assert.doesNotMatch(decision.actor ?? '', /agent|reviewer|orchestrator|lead/iu, `${label} has no detached reviewer approval`);
  }
}

function pauseProjection(state: PersistedState): unknown {
  return {
    pause: state.pause,
    stage_cursor: state.stage_cursor,
    specification: state.specification,
    typed_checkpoint_decisions: state.typed_checkpoint_decisions,
  };
}

/**
 * A detached reviewer runs on the platform clock and cannot be fake-timed in a
 * real OMP session: this short quiet window polls the durable projection after
 * the checkpoint is visible and asserts nothing mutated it (FR-072).
 */
async function assertPauseDurable(
  root: string,
  featureId: string,
  snapshot: PersistedState,
  label: string,
): Promise<void> {
  await new Promise<void>(resolve => setTimeout(resolve, 500));
  const after = readState(root, featureId);
  assert.deepEqual(pauseProjection(after), pauseProjection(snapshot), `${label} remains unchanged while idle`);
  assertHumanDecisions(after, label);
}

function scanArtifacts<T>(root: string, featureId: string, predicate: (value: Record<string, unknown>) => boolean): T[] {
  const dir = join(root, '.work-state', 'features', featureId, 'artifacts');
  if (!existsSync(dir)) return [];
  const found: T[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith('.json') || entry.name.startsWith('.')) continue;
    try {
      const value: unknown = JSON.parse(readFileSync(join(dir, entry.name), 'utf8'));
      if (value !== null && typeof value === 'object' && predicate(value as Record<string, unknown>)) {
        found.push(value as T);
      }
    } catch {
      // Unparseable bytes are not contract data.
    }
  }
  return found;
}

function readHandoff(root: string, featureId: string): { handoff_id: string; handoff_digest: string; feature_id: string; status: string } {
  const candidates = scanArtifacts<{ handoff_id: string; handoff_digest: string; feature_id: string; status: string }>(
    root,
    featureId,
    value => typeof value['handoff_id'] === 'string'
      && typeof value['handoff_digest'] === 'string'
      && /^[0-9a-f]{64}$/u.test(String(value['handoff_digest'])),
  );
  assert.equal(candidates.length, 1, `exactly one implementation handoff exists for ${featureId}`);
  return candidates[0] as { handoff_id: string; handoff_digest: string; feature_id: string; status: string };
}

function isExecutionClaim(value: Record<string, unknown>): boolean {
  return typeof value['claim_id'] === 'string' && typeof value['handoff_digest'] === 'string';
}

/**
 * Starts one nested full-profile run from a workspace-less fixture and stops
 * at the durable nested Specify checkpoint: routing decision asserted from
 * real output, exactly one nested identity, same human checkpoint contract.
 */
async function startNestedRun(open: OpenSession, scratch: Scratch): Promise<string> {
  const log = new TranscriptLog(open.session.transcriptPath);
  log.refresh();
  const fromFrame = log.frames.length;

  await submit(open.driver, `/do-work ${REQUEST}`);
  // The command prompt itself contains generic quick/bounded guidance. Wait
  // for the durable nested identity before inspecting the transcript so the
  // assertion cannot mistake that static guidance for the live routing report.
  await waitFor(
    () => featureIds(scratch.root).length === 1,
    { timeoutMs: WAIT_TIMEOUT_MS, intervalMs: 100, label: 'one nested feature workspace appears' },
  );
  const [nestedId] = featureIds(scratch.root);
  assert.ok(nestedId !== undefined, 'the nested run persists exactly one feature identity');
  await waitForTranscriptMatch(log, fromFrame, new RegExp(nestedId, 'u'), 'adaptive preparation routing report');
  assertFullSpecificationRouting(outputText(log, fromFrame), 'nested full-profile routing');
  return nestedId;
}

// ---------------------------------------------------------------------------
// T075.1 — full-profile routing nests the native workflow with one identity.
// ---------------------------------------------------------------------------

test('T075 runtime: /do-work routes a complex risky request into the full nested specification profile with one durable identity', async () => {

  const scratch = makeScratch('routing');
  let open: OpenSession | null = null;
  let testFailureObserved = false;
  try {
    open = await openSession(scratch.root);

    const nestedId = await startNestedRun(open, scratch);

    // FR-028: the nested run uses the same durable state contract as a
    // directly invoked workflow — phases, human pause, and next action.
    const nested = await waitForState(
      scratch.root,
      nestedId,
      state => {
        const specify = phaseOf(state, 'specify');
        return specify?.status === 'awaiting_approval'
          && specify.current_version !== null
          && typeof specify.validation_ref === 'string'
          && state.pause?.kind === 'user_checkpoint';
      },
      'nested Specify validated and paused at the human checkpoint',
    );
    assert.equal(phaseOf(nested, 'specify')?.status, 'awaiting_approval', 'the nested run pauses at the Specify checkpoint');
    assert.equal(nested.pause?.kind, 'user_checkpoint', 'the nested checkpoint is a durable resumable pause');
    assert.equal(nested.specification?.next_action?.kind, 'checkpoint', 'the nested checkpoint is the exposed next action');
    assert.equal(nested.specification?.feature_id, nestedId, 'the nested workspace binds its own feature identity');
    assert.ok(typeof nested.run_key === 'string' && (nested.run_key as string).length > 0, 'the nested run persists one run identity');
    assert.ok(cursorEpoch(nested) !== null, 'the nested run persists its capability epoch');
    assertHumanDecisions(nested, 'nested Specify checkpoint');

    // FR-028/FR-075: same checkpoints and documents as the direct commands.
    const block = await waitForPhaseCheckpoint(open, 'specify', 'nested Specify checkpoint');
    assert.ok(block.title.length > 0, 'the nested checkpoint carries a readable title');
    assert.ok(existsSync(join(scratch.root, 'specs', nestedId, 'spec.md')), 'the nested run materializes the same readable Specify document');
    assert.deepEqual(featureIds(scratch.root), [nestedId], 'the nested full-profile run creates exactly one workspace');
  } catch (error) {
    testFailureObserved = true;
    throw error;
  } finally {
    let lifecycleFailureObserved = false;
    let lifecycleError: unknown;
    try {
      await closeSession(open);
    } catch (error) {
      lifecycleFailureObserved = true;
      lifecycleError = error;
    }
    finalizeScratchDirectory(scratch.parent, {
      preserveOnFailure: PRESERVE_ON_FAILURE,
      testFailed: testFailureObserved,
      lifecycleFailed: lifecycleFailureObserved,
    });
    if (!testFailureObserved && lifecycleFailureObserved) throw lifecycleError;
  }
});

// ---------------------------------------------------------------------------
// T075.2 — pause after an approved phase; one invocation resumes the exact
// next phase with zero repeated approvals and no premature implementation.
// ---------------------------------------------------------------------------

test('T075 runtime: paused nested run resumes the next phase exactly once with zero repeated approvals', async () => {

  const scratch = makeScratch('resume');
  let open: OpenSession | null = null;
  let testFailureObserved = false;
  try {
    open = await openSession(scratch.root);

    const nestedId = await startNestedRun(open, scratch);
    const specifyCheckpoint = await waitForPhaseCheckpoint(open, 'specify', 'nested Specify checkpoint before pause');

    // Pause: approve_stop records the human approval and stops the run.
    await answerCheckpoint(open.driver, specifyCheckpoint, '3');
    const paused = await waitForState(
      scratch.root,
      nestedId,
      state => {
        const specify = phaseOf(state, 'specify');
        const plan = phaseOf(state, 'plan');
        return specify?.status === 'approved'
          && specify.approved_version === specify.current_version
          && plan?.status === 'not_started';
      },
      'durable nested Specify approval before interruption',
    );
    const specifyVersion = phaseOf(paused, 'specify')?.current_version;
    const runKey = paused.run_key;
    assert.ok(typeof specifyVersion === 'number', 'the approved Specify version is durably persisted');
    assert.ok(typeof runKey === 'string' && runKey.length > 0, 'the paused nested run retains its run identity');
    assert.equal(paused.specification?.next_action?.kind, 'checkpoint', 'the paused run exposes a recoverable next action (FR-029)');
    assertHumanDecisions(paused, 'paused nested Specify');
    await assertPauseDurable(scratch.root, nestedId, paused, 'paused nested Specify checkpoint');

    // Interrupt the session, then resume through one explicit invocation.
    await closeSession(open);
    open = null;
    open = await openSession(scratch.root);
    const resumeLog = new TranscriptLog(open.session.transcriptPath);
    resumeLog.refresh();
    const resumeFrom = resumeLog.frames.length;

    await submit(open.driver, `/do-work ${REQUEST}`);
    const planCheckpoint = await waitForPhaseCheckpoint(open, 'plan', 'Plan checkpoint after nested resume');
    assertNoUnknownCommand(outputText(resumeLog, resumeFrom), 'nested resume');
    const resumed = await waitForState(
      scratch.root,
      nestedId,
      state => phaseOf(state, 'plan')?.status === 'awaiting_approval',
      'resumed nested Plan awaiting approval',
    );

    // Zero repeated approved phases: Specify stays approved exactly once.
    assert.equal(phaseOf(resumed, 'specify')?.status, 'approved', 'resume never reopens the approved Specify phase');
    assert.equal(phaseOf(resumed, 'specify')?.current_version, specifyVersion, 'resume never creates a second Specify version');
    assert.equal(phaseOf(resumed, 'specify')?.approved_version, specifyVersion, 'resume retains the original human approval');
    assert.equal(resumed.run_key, runKey, 'resume continues the one nested run identity (FR-029)');
    assert.deepEqual(featureIds(scratch.root), [nestedId], 'resume never creates a second workspace');
    assert.deepEqual(historyVersions(scratch.root, nestedId, 'specify'), ['v1.md'], 'resume leaves exactly one Specify version in history');
    const resumedLog = new TranscriptLog(open.session.transcriptPath);
    const resumedBlocks = checkpointBlocks(resumedLog);
    assert.equal(
      resumedBlocks.filter(block => /specify/iu.test(block.title)).length,
      0,
      'the resuming session re-presents no Specify checkpoint',
    );

    // Complete the resumed run through the same checkpoints: approve_continue
    // dispatches Tasks, approve_stop freezes the handoff without execution.
    await answerCheckpoint(open.driver, planCheckpoint, '1');
    const tasksCheckpoint = await waitForPhaseCheckpoint(open, 'tasks', 'Tasks checkpoint after nested resume', 2);
    await answerCheckpoint(open.driver, tasksCheckpoint, '3');
    const ready = await waitForState(
      scratch.root,
      nestedId,
      state => state.specification?.status === 'implementation_ready' && typeof state.specification?.handoff_ref === 'string',
      'resumed nested run reaches implementation-ready',
    );
    const specify = phaseOf(ready, 'specify');
    assert.equal(specify?.current_version, specifyVersion, 'completion preserves the single Specify version');
    assert.equal(phaseOf(ready, 'plan')?.status, 'approved', 'the resumed Plan phase is approved');
    assert.equal(phaseOf(ready, 'tasks')?.status, 'approved', 'the Tasks phase is approved');
    assert.deepEqual(featureIds(scratch.root), [nestedId], 'the full nested journey creates exactly one workspace');

    // Command contract §/do-work: approve_stop returns an implementation-ready
    // handoff without implementation — no claim, no execution.
    const handoff = readHandoff(scratch.root, nestedId);
    assert.equal(handoff.status, 'ready', 'the nested handoff freezes as ready');
    assert.equal(handoff.feature_id, nestedId, 'the nested handoff binds the nested identity');
    assert.deepEqual(
      scanArtifacts(scratch.root, nestedId, isExecutionClaim),
      [],
      'approve_stop starts no implementation claim',
    );
    assert.match(
      ready.specification?.next_action?.command ?? '',
      new RegExp(`/do-work\\s+--spec\\s+${nestedId}`, 'iu'),
      'the nested handoff is consumed through the same explicit do-work selection',
    );
  } catch (error) {
    testFailureObserved = true;
    throw error;
  } finally {
    let lifecycleFailureObserved = false;
    let lifecycleError: unknown;
    try {
      await closeSession(open);
    } catch (error) {
      lifecycleFailureObserved = true;
      lifecycleError = error;
    }
    finalizeScratchDirectory(scratch.parent, {
      preserveOnFailure: PRESERVE_ON_FAILURE,
      testFailed: testFailureObserved,
      lifecycleFailed: lifecycleFailureObserved,
    });
    if (!testFailureObserved && lifecycleFailureObserved) throw lifecycleError;
  }
});

// ---------------------------------------------------------------------------
// T075.3 — a duplicate invocation against an existing paused run never starts
// a second run; it re-presents the same pending checkpoint and stays
// recoverable (FR-029).
// ---------------------------------------------------------------------------

test('T075 runtime: duplicate invocation on a paused nested run never starts a second run', async () => {

  const scratch = makeScratch('duplicate');
  let open: OpenSession | null = null;
  let testFailureObserved = false;
  try {
    open = await openSession(scratch.root);

    const nestedId = await startNestedRun(open, scratch);
    await waitForPhaseCheckpoint(open, 'specify', 'nested Specify checkpoint before duplicate');
    const started = await waitForState(
      scratch.root,
      nestedId,
      state => state.pause?.kind === 'user_checkpoint' && phaseOf(state, 'specify')?.status === 'awaiting_approval',
      'nested run paused at the unanswered Specify checkpoint',
    );
    const runKey = started.run_key;
    const specifyVersion = phaseOf(started, 'specify')?.current_version;
    assert.ok(typeof runKey === 'string' && runKey.length > 0, 'the active nested run identity is durable');
    assert.ok(typeof specifyVersion === 'number', 'the pending Specify version is durable');

    // Interrupt without answering: the pending checkpoint stays durably paused.
    await closeSession(open);
    open = null;
    const pending = await waitForState(
      scratch.root,
      nestedId,
      state => state.pause?.kind === 'user_checkpoint' && phaseOf(state, 'specify')?.status === 'awaiting_approval',
      'interrupted checkpoint remains durably pending',
    );
    await assertPauseDurable(scratch.root, nestedId, pending, 'interrupted nested checkpoint');

    // Duplicate invocation of the same entry point against the existing run.
    open = await openSession(scratch.root);
    const duplicateLog = new TranscriptLog(open.session.transcriptPath);
    duplicateLog.refresh();
    const duplicateFrom = duplicateLog.frames.length;

    await submit(open.driver, `/do-work ${REQUEST}`);
    await waitForPhaseCheckpoint(open, 'specify', 'duplicate invocation re-presents the pending nested checkpoint');
    assertNoUnknownCommand(outputText(duplicateLog, duplicateFrom), 'duplicate invocation');
    const adopted = await waitForState(
      scratch.root,
      nestedId,
      state => state.pause?.kind === 'user_checkpoint' && phaseOf(state, 'specify')?.status === 'awaiting_approval',
      'duplicate invocation lands on the same pending checkpoint',
    );

    assert.equal(adopted.run_key, runKey, 'the duplicate invocation continues the existing run identity');
    assert.equal(phaseOf(adopted, 'specify')?.current_version, specifyVersion, 'the duplicate invocation creates no second Specify version');
    assert.deepEqual(featureIds(scratch.root), [nestedId], 'the duplicate invocation never starts a second workspace');
    assert.deepEqual(historyVersions(scratch.root, nestedId, 'specify'), ['v1.md'], 'the duplicate invocation never regenerates Specify');

    // The adopted run stays recoverable: the same checkpoint answerable.
    await answerCheckpoint(open.driver, (await waitForPhaseCheckpoint(open, 'specify', 'the adopted run continues to Plan after duplicate adoption', 2)), '1');
    await waitForPhaseCheckpoint(open, 'plan', 'the adopted run continues to Plan after duplicate adoption', 2);
  } catch (error) {
    testFailureObserved = true;
    throw error;
  } finally {
    let lifecycleFailureObserved = false;
    let lifecycleError: unknown;
    try {
      await closeSession(open);
    } catch (error) {
      lifecycleFailureObserved = true;
      lifecycleError = error;
    }
    finalizeScratchDirectory(scratch.parent, {
      preserveOnFailure: PRESERVE_ON_FAILURE,
      testFailed: testFailureObserved,
      lifecycleFailed: lifecycleFailureObserved,
    });
    if (!testFailureObserved && lifecycleFailureObserved) throw lifecycleError;
  }
});
