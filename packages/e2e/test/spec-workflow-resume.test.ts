/**
 * T040 — interrupted-session and revision-loop runtime contracts.
 *
 *
 * These are deliberately process-boundary checks.  They drive the real OMP
 * PTY through the existing WsDriver, then inspect the durable feature state
 * and readable projections written by the native specification workflow.
 * The tests are expected to fail until the native phase/checkpoint runtime is
 * implemented (T041–T045).
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
import { answerNativeAsk, answerSelectedAsk, matchesCanonicalSelectorOptions, type AskBlock, type SelectedAskBlock, TranscriptLog, waitFor, waitForOmpTuiReady, WsDriver } from '../src/driver.js';
import { createScratchSpecificationRepository } from '../src/specification-fixtures.js';
import { startTestSession, type TestSession } from '../src/server.js';
import { finalizeScratchDirectory } from '../src/scratch-lifecycle.js';

const FEATURE_ID = 'readable-resume';
const REVISION_FEATURE_ID = 'readable-revision';
const REVISION_FEEDBACK = 'Clarify the retry boundary and preserve the idempotency requirement.';
const SCENARIO = {
  id: 'spec-workflow-resume',
  title: 'Interrupted specification session and revision loop',
} as const;
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
  pause?: { kind?: string; reason?: string };
  stage_cursor?: string;
  cursor_epoch?: string;
  typed_checkpoint_decisions?: TypedDecision[];
  checkpoint_decisions?: Array<{ mode?: string; actor?: string; decision?: string }>;
  dispatch_capability?: { issued_for?: { cursor_epoch?: string } };
  specification?: {
    phases?: PhaseRecord[];
    next_action?: { kind?: string; command?: string | null; reason?: string };
  };
};

type Scratch = { root: string; parent: string };
type OpenSession = { session: TestSession; driver: WsDriver };


function makeScratch(slug: string): Scratch {
  const parent = mkdtempSync(join(tmpdir(), `omp-spec-resume-${slug}-`));
  const repository = createScratchSpecificationRepository({
    workdir: parent,
    slug,
    runtime: true,
    constitution: { variant: 'usable' },
    extraFiles: [{ path: 'README.md', contents: '# Native readable specification runtime fixture\n' }],
  });
  return { root: repository.root, parent };
}

function readState(root: string, featureId: string): PersistedState {
  const path = join(root, '.work-state', 'features', featureId, 'state.json');
  return JSON.parse(readFileSync(path, 'utf8')) as PersistedState;
}

function phaseOf(state: PersistedState, phase: string): PhaseRecord | undefined {
  return state.specification?.phases?.find(candidate => candidate.phase === phase);
}

function phaseEpoch(state: PersistedState): string | null {
  const direct = state.cursor_epoch;
  if (typeof direct === 'string' && direct.length > 0) return direct;
  const issued = state.dispatch_capability?.issued_for?.cursor_epoch;
  return typeof issued === 'string' && issued.length > 0 ? issued : null;
}

async function waitForState(
  root: string,
  featureId: string,
  predicate: (state: PersistedState) => boolean,
  label: string,
  timeoutMs = 120_000,
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
    taskPrompt: 'Exercise the durable native specification workflow.',
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
): Promise<{ block: CheckpointBlock; log: TranscriptLog }> {
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
    { timeoutMs: SPECIFICATION_STAGE_WAIT_TIMEOUT_MS, intervalMs: 100, label },
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
  return { block, log };
}

function assertHumanDecisions(state: PersistedState, label: string): void {
  for (const decision of state.typed_checkpoint_decisions ?? []) {
    assert.equal(decision.authorization, 'human', `${label} decision authorization is human`);
    assert.equal(decision.actor?.kind, 'user', `${label} decision actor is the user`);
    assert.ok(decision.actor?.proof?.answer_id, `${label} decision has trusted answer proof`);
    assert.ok(decision.actor?.proof?.binding, `${label} decision has bound answer proof`);
    assert.notEqual(decision.actor?.kind, 'orchestrator', `${label} has no orchestrator approval`);
    assert.notEqual(decision.actor?.kind, 'system', `${label} has no system approval`);
  }
  for (const decision of state.checkpoint_decisions ?? []) {
    assert.notEqual(decision.mode, 'autonomous', `${label} has no autonomous approval`);
    assert.doesNotMatch(decision.actor ?? '', /agent|reviewer|orchestrator|lead/iu, `${label} has no detached reviewer approval`);
  }
}

function assertCheckpointIsHuman(state: PersistedState, label: string): void {
  assert.equal(state.pause?.kind, 'user_checkpoint', `${label} pauses at a user checkpoint`);
  const awaiting = state.specification?.phases?.find(candidate => candidate.status === 'awaiting_approval');
  assert.ok(awaiting?.validation_ref, `${label} has completed validation before the checkpoint`);
  assertHumanDecisions(state, label);
}

function checkpointProjection(state: PersistedState): unknown {
  return {
    pause: state.pause,
    stage_cursor: state.stage_cursor,
    specification: state.specification,
    typed_checkpoint_decisions: state.typed_checkpoint_decisions,
    checkpoint_decisions: state.checkpoint_decisions,
  };
}

async function assertNoDetachedMutation(
  root: string,
  featureId: string,
  checkpointState: PersistedState,
  label: string,
): Promise<void> {
  // A detached reviewer must not mutate the phase after the synchronous
  // checkpoint is visible.  Polling the durable projection rather than the
  // PTY output catches approvals that arrive after the terminal is idle.
  // This short real-time quiet window is intentional: a fake clock cannot
  // drive a detached process in a real OMP session.
  await new Promise<void>(resolve => setTimeout(resolve, 500));
  const after = readState(root, featureId);
  assert.deepEqual(checkpointProjection(after), checkpointProjection(checkpointState), `${label} remains unchanged while idle`);
  assertHumanDecisions(after, label);
}

function historyContainsRevision(root: string, featureId: string, phase: string, version: number): boolean {
  const historyPhase = join(root, 'specs', featureId, 'history', phase);
  if (!existsSync(historyPhase)) return false;
  return readdirSync(historyPhase).includes(`v${String(version)}.md`);
}

// ---------------------------------------------------------------------------
// T040.1 — approve-stop, interrupted process, exact phase resume.
// ---------------------------------------------------------------------------

test('T040 runtime: interrupted approve-stop resumes the first unapproved phase exactly once', async () => {
  const scratch = makeScratch(FEATURE_ID);
  let open: OpenSession | null = null;
  let testFailureObserved = false;
  try {
    open = await openSession(scratch.root);
    // Start native Specify and wait for the synchronous, validated checkpoint.
    await submit(open.driver, `/specify --feature ${FEATURE_ID} implement a durable resume contract`);
    const specifyCheckpoint = await waitForPhaseCheckpoint(open, 'specify', 'Specify checkpoint before interruption');
    const beforeApproval = await waitForState(
      scratch.root,
      FEATURE_ID,
      state => phaseOf(state, 'specify')?.status === 'awaiting_approval',
      'Specify awaiting approval',
    );
    assertCheckpointIsHuman(beforeApproval, 'Specify checkpoint');
    const specifyVersion = phaseOf(beforeApproval, 'specify')?.current_version;
    const specifyEpoch = phaseEpoch(beforeApproval);
    assert.ok(specifyVersion !== null && specifyVersion !== undefined, 'Specify version is durably persisted');
    assert.ok(specifyEpoch !== null, 'Specify capability epoch is durably persisted');

    // approve_stop records approval and intentionally does not dispatch Plan.
    await answerCheckpoint(open.driver, specifyCheckpoint.block, '3');
    const approved = await waitForState(
      scratch.root,
      FEATURE_ID,
      state => {
        const specify = phaseOf(state, 'specify');
        const plan = phaseOf(state, 'plan');
        return specify?.status === 'approved' && specify.approved_version === specify.current_version && plan?.status === 'not_started';
      },
      'durable Specify approval before interruption',
    );
    assertHumanDecisions(approved, 'approved Specify');
    assert.equal(phaseOf(approved, 'specify')?.current_version, specifyVersion, 'approval binds the generated Specify version');
    assert.equal(phaseOf(approved, 'specify')?.approved_version, specifyVersion, 'approve-stop persists Specify approval');
    assert.equal(phaseOf(approved, 'plan')?.status, 'not_started', 'approve-stop does not dispatch Plan');
    assert.equal(
      (approved.typed_checkpoint_decisions ?? []).at(-1)?.decision,
      'approve_stop',
      'durable decision records approve_stop rather than inferring continuation',
    );
    await assertNoDetachedMutation(scratch.root, FEATURE_ID, approved, 'approved Specify checkpoint');

    // Simulate an interrupted session by killing this PTY after the approval
    // has committed, then resume through a fresh process and explicit command.
    await closeSession(open);
    open = await openSession(scratch.root);
    await submit(open.driver, `/spec-plan --feature ${FEATURE_ID}`);
    const resumedCheckpoint = await waitForPhaseCheckpoint(open, 'plan', 'Plan checkpoint after interruption');
    const resumed = await waitForState(
      scratch.root,
      FEATURE_ID,
      state => phaseOf(state, 'plan')?.status === 'awaiting_approval',
      'Plan awaiting approval after exact resume',
    );
    assertCheckpointIsHuman(resumed, 'resumed Plan checkpoint');
    assert.equal(phaseOf(resumed, 'specify')?.status, 'approved', 'resume never reopens the approved Specify phase');
    assert.equal(phaseOf(resumed, 'specify')?.current_version, specifyVersion, 'resume never creates a second Specify version');
    assert.equal(phaseOf(resumed, 'specify')?.approved_version, specifyVersion, 'resume retains the original Specify approval');
    assert.notEqual(phaseOf(resumed, 'plan')?.current_version, null, 'resume creates the pending Plan version');
    assert.equal(resumed.specification?.next_action?.kind, 'checkpoint', 'resumed state exposes the Plan checkpoint as next action');

    // The fresh transcript must contain only the resumed Plan checkpoint; a
    // second Specify checkpoint would prove that approved work was repeated.
    const resumedBlocks = checkpointBlocks(resumedCheckpoint.log);
    assert.equal(
      resumedBlocks.filter(block => /specify/iu.test(block.title)).length,
      0,
      'interrupted resume presents no repeated Specify checkpoint',
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
// T040.2 — request-changes revision loop and synchronous human checkpoint.
// ---------------------------------------------------------------------------

test('T040 runtime: request-changes re-dispatches one phase as a new revision without detached approval', async () => {
  const scratch = makeScratch(REVISION_FEATURE_ID);
  let open: OpenSession | null = null;
  let testFailureObserved = false;
  try {
    open = await openSession(scratch.root);
    await submit(open.driver, `/specify --feature ${REVISION_FEATURE_ID} implement a revision-safe checkpoint`);
    const initialCheckpoint = await waitForPhaseCheckpoint(open, 'specify', 'initial Specify checkpoint for revision loop');
    const initial = await waitForState(
      scratch.root,
      REVISION_FEATURE_ID,
      state => phaseOf(state, 'specify')?.status === 'awaiting_approval',
      'initial Specify checkpoint state',
    );
    assertCheckpointIsHuman(initial, 'initial revision checkpoint');
    const initialPhase = phaseOf(initial, 'specify');
    const initialVersion = initialPhase?.current_version;
    const initialEpoch = phaseEpoch(initial);
    assert.ok(initialVersion !== null && initialVersion !== undefined, 'initial Specify version is persisted');
    assert.ok(initialEpoch !== null, 'initial Specify epoch is persisted');

    // Request changes, then answer the explicit feedback prompt.  The same
    // phase must return to validation/checkpoint; Plan must remain untouched.
    await answerCheckpoint(open.driver, initialCheckpoint.block, '2');
    const feedbackLog = new TranscriptLog(open.session.transcriptPath);
    await waitFor(
      () => {
        const blocks = feedbackLog.askBlocks();
        return blocks.some(block => /feedback|revision|change/iu.test(block.title) && block.options.length === 0);
      },
      { timeoutMs: SPECIFICATION_STAGE_WAIT_TIMEOUT_MS, intervalMs: 100, label: 'request-changes feedback prompt' },
    );
    await submit(open.driver, REVISION_FEEDBACK);

    const revisedCheckpoint = await waitForPhaseCheckpoint(
      open,
      'specify',
      'revised Specify checkpoint',
      initialCheckpoint.block.index + 1,
    );
    const revised = await waitForState(
      scratch.root,
      REVISION_FEATURE_ID,
      state => {
        const specify = phaseOf(state, 'specify');
        const plan = phaseOf(state, 'plan');
        return specify?.status === 'awaiting_approval'
          && specify.current_version !== null
          && specify.current_version > (initialVersion ?? 0)
          && plan?.status === 'not_started';
      },
      'revised Specify awaiting approval',
    );
    assertCheckpointIsHuman(revised, 'revised Specify checkpoint');
    const revisedPhase = phaseOf(revised, 'specify');
    assert.ok(revisedPhase !== undefined, 'revised Specify phase exists');
    assert.ok(revisedPhase.current_version !== null && revisedPhase.current_version > (initialVersion ?? 0), 'revision creates a new phase version');
    assert.equal(revisedPhase.approved_version, null, 'revised content is not implicitly approved');
    assert.equal(revisedPhase.last_feedback, REVISION_FEEDBACK, 'revision feedback is durably bound to the phase');
    assert.equal(
      (revised.typed_checkpoint_decisions ?? []).at(-1)?.decision,
      'request_changes',
      'revision checkpoint records request_changes rather than inferred approval',
    );
    assert.notEqual(phaseEpoch(revised), initialEpoch, 'revision receives a fresh capability epoch');
    assert.equal(phaseOf(revised, 'plan')?.status, 'not_started', 'revision does not dispatch downstream Plan');
    assert.ok(
      historyContainsRevision(scratch.root, REVISION_FEATURE_ID, 'specify', initialVersion ?? 1),
      'replaced Specify projection is archived under history',
    );
    assert.equal(revised.specification?.next_action?.kind, 'checkpoint', 'revised state returns to the same human checkpoint');

    // A synchronous checkpoint remains stable while no human answer is sent;
    // an asynchronous reviewer/agent must not be able to approve or advance it.
    await assertNoDetachedMutation(scratch.root, REVISION_FEATURE_ID, revised, 'revised Specify checkpoint');
    assert.equal(
      revisedCheckpoint.block.title,
      feedbackLog.askBlocks().filter(block => /specify/iu.test(block.title)).at(-1)?.title,
      'the returned checkpoint belongs to Specify, not a detached reviewer stage',
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

