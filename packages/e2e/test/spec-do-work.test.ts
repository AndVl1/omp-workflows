/**
 * T049 — real-runtime ready-handoff consumption and completion-conformance gates.
 *
 * These are deliberately process-boundary checks in the T025/T040 style: they
 * drive the real OMP PTY through the native Specify -> Plan -> Tasks journey,
 * then prove that `/do-work --spec` consumes the frozen handoff without
 * rediscovery, claims it exclusively, and that the run can never complete
 * without a current passing implementation-conformance matrix bound to the
 * exact handoff digest and active execution claim.
 *
 * The tests are expected to fail until the handoff, claim, conformance,
 * `/do-work --spec` routing, and runtime scenario implementations land
 * (T050–T058).
 *
 */

import assert from 'node:assert/strict';
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { SPECIFICATION_STAGE_WAIT_TIMEOUT_MS } from '../src/specification-runtime.js';
import { answerNativeAsk, answerSelectedAsk, matchesCanonicalSelectorOptions, type AskBlock, type SelectedAskBlock, TranscriptLog, waitFor, waitForOmpTuiReady, WsDriver } from '../src/driver.js';
import { createScratchSpecificationRepository } from '../src/specification-fixtures.js';
import { startTestSession, type TestSession } from '../src/server.js';

const FEATURE_ID = 'readable-do-work';
const REQUEST = 'Add a deterministic project-local workflow profile override with explicit ownership';
const DO_WORK_REQUEST = 'implement the approved handoff tasks for the workflow profile override';
const SCENARIO = {
  id: 'spec-do-work',
  title: 'Specification-backed do-work execution',
} as const;
const WAIT_TIMEOUT_MS = SPECIFICATION_STAGE_WAIT_TIMEOUT_MS;
const STABILITY_WINDOW_MS = 10_000;
/** Bounded real-time window for the executor to reach a terminal/completed state. */
const COMPLETION_WINDOW_MS = 300_000;
const DIGEST_RE = /^[0-9a-f]{64}$/u;

type PhaseRecord = {
  phase: string;
  status: string;
  current_version: number | null;
  approved_version: number | null;
  stale_reason: string | null;
};

type PersistedState = {
  run_key?: unknown;
  specification?: {
    feature_id?: unknown;
    status?: unknown;
    phases?: PhaseRecord[];
    next_action?: { kind?: string; command?: string | null; reason?: string };
    handoff_ref?: unknown;
    execution_claim_ref?: unknown;
    implementation_conformance_ref?: unknown;
  };
};

type HandoffArtifact = {
  handoff_id: string;
  handoff_digest: string;
  feature_id: string;
  status: string;
  open_decisions: string[];
  execution_choices: string[];
  requirements: Array<{ requirement_id: string; acceptance_ids: string[] }>;
  verification: Array<{ requirement_ids: string[]; acceptance_ids: string[]; observable_behavior: boolean }>;
};

type ClaimArtifact = {
  claim_id: string;
  handoff_digest: string;
  owner_kind: string;
  owner_run_id: string;
  status: string;
  release_reason: string | null;
};

type ConformanceEntry = {
  entry_id: string;
  subject_kind: string;
  subject_id: string;
  observable_behavior: boolean;
  status: string;
};

type ConformanceArtifact = {
  conformance_id: string;
  matrix_digest: string;
  feature_id: string;
  handoff_id: string;
  handoff_digest: string;
  execution_claim_id: string;
  execution_owner: string;
  execution_run_id: string;
  entries: ConformanceEntry[];
  overall_status: string;
  next_action: string;
  blocking_findings?: Array<{ code?: string }>;
};

type Scratch = { root: string; parent: string };
type OpenSession = { session: TestSession; driver: WsDriver };

type ReadySnapshot = {
  runKey: string;
  specifyVersion: number;
  planVersion: number;
  tasksVersion: number;
  handoff: HandoffArtifact;
  journeyBlockCount: number;
};

// ---------------------------------------------------------------------------
// Helpers (mirroring the T025/T040 runtime harness).
// ---------------------------------------------------------------------------


function makeScratch(): Scratch {
  const parent = mkdtempSync(join(tmpdir(), 'omp-spec-do-work-'));
  const repository = createScratchSpecificationRepository({
    workdir: parent,
    slug: FEATURE_ID,
    runtime: true,
    constitution: { variant: 'usable' },
    extraFiles: [{ path: 'README.md', contents: '# Specification-backed do-work runtime fixture\n' }],
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

function workspaceStatus(state: PersistedState): string {
  return typeof state.specification?.status === 'string' ? state.specification.status : '';
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
    taskPrompt: 'Exercise the specification-backed do-work execution contract.',
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

/**
 * Drives the native journey to an implementation-ready workspace with the
 * exact approved-version bindings every do-work assertion below depends on:
 * Specify approve_continue -> Plan approve_continue -> Tasks approve_stop.
 */
async function driveToImplementationReady(open: OpenSession, scratch: Scratch): Promise<ReadySnapshot> {
  const log = new TranscriptLog(open.session.transcriptPath);

  const specifyAsk = await waitForPhaseCheckpoint(open, 'specify', 'Specify checkpoint');
  await answerCheckpoint(open.driver, specifyAsk, '1'); // approve_continue dispatches Plan.
  const planAsk = await waitForPhaseCheckpoint(open, 'plan', 'Plan checkpoint', specifyAsk.index + 1);
  await answerCheckpoint(open.driver, planAsk, '1'); // approve_continue dispatches Tasks.
  const tasksAsk = await waitForPhaseCheckpoint(open, 'tasks', 'Tasks checkpoint', planAsk.index + 1);
  await answerCheckpoint(open.driver, tasksAsk, '3'); // approve_stop freezes the handoff without implementation.

  const ready = await waitForState(
    scratch.root,
    FEATURE_ID,
    state => {
      const specify = phaseOf(state, 'specify');
      const plan = phaseOf(state, 'plan');
      const tasks = phaseOf(state, 'tasks');
      return workspaceStatus(state) === 'implementation_ready'
        && specify?.status === 'approved'
        && plan?.status === 'approved'
        && tasks?.status === 'approved'
        && typeof state.specification?.handoff_ref === 'string';
    },
    'implementation-ready workspace after Tasks approval',
  );
  const specify = phaseOf(ready, 'specify');
  const plan = phaseOf(ready, 'plan');
  const tasks = phaseOf(ready, 'tasks');
  const specifyVersion = specify.current_version;
  const planVersion = plan.current_version;
  const tasksVersion = tasks.current_version;
  assert.ok(typeof specifyVersion === 'number', 'Specify carries a current version');
  assert.ok(typeof planVersion === 'number', 'Plan carries a current version');
  assert.ok(typeof tasksVersion === 'number', 'Tasks carries a current version');

  const handoff = readHandoff(scratch.root, FEATURE_ID);
  assert.equal(handoff.feature_id, FEATURE_ID, 'handoff binds the selected feature');
  assert.equal(handoff.status, 'ready', 'the frozen handoff is ready');
  assert.deepEqual(handoff.open_decisions, [], 'a ready handoff has no blocking open decisions');
  assert.ok(handoff.execution_choices.includes('do-work'), 'ready handoff admits the do-work executor');
  assert.match(
    ready.specification?.next_action?.command ?? '',
    new RegExp(`/do-work\\s+--spec\\s+${FEATURE_ID}`, 'iu'),
    'next action after readiness is the explicit do-work spec selection',
  );
  const handoffPath = join(scratch.root, 'specs', FEATURE_ID, 'handoff.md');
  assert.ok(existsSync(handoffPath), 'readable handoff.md is materialized');
  const handoffText = readFileSync(handoffPath, 'utf8');
  assert.ok(handoffText.includes(handoff.handoff_digest), 'readable handoff carries the exact frozen digest');

  return {
    runKey: ready.run_key as string,
    specifyVersion,
    planVersion,
    tasksVersion,
    handoff,
    journeyBlockCount: checkpointBlocks(log).length,
  };
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

function readHandoff(root: string, featureId: string): HandoffArtifact {
  const candidates = scanArtifacts<HandoffArtifact>(root, featureId, value => {
    return typeof value['handoff_id'] === 'string'
      && typeof value['handoff_digest'] === 'string'
      && value['handoff_digest'].length === 64;
  });
  const handoff = candidates.at(-1);
  assert.ok(handoff !== undefined, 'a frozen handoff artifact exists for the feature');
  assert.match(handoff.handoff_digest, DIGEST_RE, 'handoff digest is content-addressed SHA-256');
  return handoff;
}

function readClaims(root: string, featureId: string, handoffDigest: string): ClaimArtifact[] {
  return scanArtifacts<ClaimArtifact>(root, featureId, value => {
    return typeof value['claim_id'] === 'string'
      && value['handoff_digest'] === handoffDigest
      && typeof value['status'] === 'string';
  });
}

function readConformance(root: string, featureId: string): ConformanceArtifact | null {
  return scanArtifacts<ConformanceArtifact>(root, featureId, value => {
    return typeof value['conformance_id'] === 'string'
      && typeof value['matrix_digest'] === 'string'
      && Array.isArray(value['entries']);
  }).at(-1) ?? null;
}

/** The exact subject set the engine derives from the frozen handoff. */
function expectedSubjects(handoff: HandoffArtifact): Set<string> {
  const subjects = new Set<string>();
  for (const requirement of handoff.requirements) {
    subjects.add(`requirement:${requirement.requirement_id}`);
    for (const acceptance of requirement.acceptance_ids) subjects.add(`acceptance_scenario:${acceptance}`);
  }
  return subjects;
}

function assertConformanceBinding(
  conformance: ConformanceArtifact,
  handoff: HandoffArtifact,
  claim: ClaimArtifact,
  label: string,
): void {
  assert.equal(conformance.feature_id, FEATURE_ID, `${label} binds the feature`);
  assert.equal(conformance.handoff_id, handoff.handoff_id, `${label} binds the frozen handoff id`);
  assert.equal(conformance.handoff_digest, handoff.handoff_digest, `${label} binds the frozen handoff digest`);
  assert.equal(conformance.execution_claim_id, claim.claim_id, `${label} binds the active claim`);
  assert.equal(conformance.execution_owner, 'do_work', `${label} records the do-work owner kind`);
  assert.equal(conformance.execution_run_id, claim.owner_run_id, `${label} records the claim owner run`);
  const actual = new Set(conformance.entries.map(entry => `${entry.subject_kind}:${entry.subject_id}`));
  const expected = expectedSubjects(handoff);
  assert.deepEqual([...actual].sort(), [...expected].sort(), `${label} has exactly one row per approved requirement and scenario`);
  const observableSubjects = new Set<string>();
  for (const verification of handoff.verification) {
    if (!verification.observable_behavior) continue;
    for (const requirementId of verification.requirement_ids) observableSubjects.add(`requirement:${requirementId}`);
    for (const acceptanceId of verification.acceptance_ids) observableSubjects.add(`acceptance_scenario:${acceptanceId}`);
  }
  for (const entry of conformance.entries) {
    assert.equal(
      entry.observable_behavior,
      observableSubjects.has(`${entry.subject_kind}:${entry.subject_id}`),
      `${label} copies observable_behavior from the frozen verification obligations for ${entry.entry_id}`,
    );
  }
}

async function waitUntilClaimed(
  open: OpenSession,
  scratch: Scratch,
  snapshot: ReadySnapshot,
): Promise<{ state: PersistedState; claim: ClaimArtifact }> {
  const state = await waitForState(
    scratch.root,
    FEATURE_ID,
    candidate => typeof candidate.specification?.execution_claim_ref === 'string'
      && ['claimed', 'executing', 'completion_validating', 'completion_blocked', 'completed'].includes(workspaceStatus(candidate)),
    'do-work acquires the exclusive execution claim',
  );
  const claims = readClaims(scratch.root, FEATURE_ID, snapshot.handoff.handoff_digest);
  const active = claims.filter(candidate => candidate.status === 'active');
  assert.equal(active.length, 1, 'exactly one active execution claim exists for the handoff digest');
  const claim = active[0];
  assert.ok(claim !== undefined, 'the active claim is readable');
  assert.equal(claim.owner_kind, 'do_work', 'the claim is owned by the do-work run');
  assert.equal(claims.filter(candidate => candidate.status === 'released').length, 0, 'no released claim lingers for the digest');
  assert.equal(snapshot.handoff.handoff_digest, readHandoff(scratch.root, FEATURE_ID).handoff_digest, 'the claimed handoff digest is unchanged');
  assert.equal(state.run_key, snapshot.runKey, 'do-work resumes the same feature run identity');
  return { state, claim };
}

function assertNoRediscovery(
  scratch: Scratch,
  snapshot: ReadySnapshot,
  log: TranscriptLog,
  blocksAtClaim: number,
): void {
  const state = readState(scratch.root, FEATURE_ID);
  assert.equal(phaseOf(state, 'specify')?.current_version, snapshot.specifyVersion, 'Specify is not regenerated');
  assert.equal(phaseOf(state, 'plan')?.current_version, snapshot.planVersion, 'Plan is not regenerated');
  assert.equal(phaseOf(state, 'tasks')?.current_version, snapshot.tasksVersion, 'Tasks is not regenerated');
  assert.equal(
    readHandoff(scratch.root, FEATURE_ID).handoff_digest,
    snapshot.handoff.handoff_digest,
    'the frozen handoff is consumed as-is',
  );
  assert.deepEqual(
    readdirSync(join(scratch.root, '.work-state', 'features')).sort(),
    [FEATURE_ID],
    'do-work creates no second implicit workspace',
  );
  const specificationBlocks = checkpointBlocks(log)
    .filter(block => block.index > blocksAtClaim)
    .filter(block => /specify|plan|tasks/iu.test(block.title));
  assert.equal(specificationBlocks.length, 0, 'specification-backed execution re-presents no discovery checkpoints');
}

// ---------------------------------------------------------------------------
// T049.1 — ready handoff consumed without rediscovery under an exclusive claim.
// ---------------------------------------------------------------------------

test('T049 runtime: /do-work --spec consumes a ready handoff under one exclusive claim without rediscovery', async () => {

  const scratch = makeScratch();
  let open: OpenSession | null = null;
  try {
    open = await openSession(scratch.root);

    const snapshot = await driveToImplementationReady(open, scratch);
    await submit(open.driver, `/do-work --spec ${FEATURE_ID} ${DO_WORK_REQUEST}`);

    const log = new TranscriptLog(open.session.transcriptPath);
    const { state, claim } = await waitUntilClaimed(open, scratch, snapshot);
    assert.notEqual(state.specification?.execution_claim_ref, null, 'the durable state binds the claim ref');
    assert.ok(['claimed', 'executing', 'completion_validating'].includes(workspaceStatus(state)), `claim acquisition moves execution forward, saw ${workspaceStatus(state)}`);
    assert.notEqual(workspaceStatus(state), 'completed', 'claim acquisition never reports completion');

    // A short real-time quiet window gives any contract-forbidden rediscovery
    // time to surface before the invariants are re-checked. Deliberate wall
    // clock: a detached OMP process cannot be driven by fake timers (same
    // exception as the T040 detached-mutation window).
    await new Promise<void>(resolve => setTimeout(resolve, STABILITY_WINDOW_MS));
    assertNoRediscovery(scratch, snapshot, log, snapshot.journeyBlockCount);
    assert.equal(claim.status, 'active', 'the claim remains active for the owning run');
  } finally {
    await closeSession(open);
    rmSync(scratch.parent, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// T049.2 — completion is gated by a current passing conformance matrix.
// ---------------------------------------------------------------------------

test('T049 runtime: completion stays blocked until the conformance matrix passes on the claimed handoff digest', async () => {

  const scratch = makeScratch();
  let open: OpenSession | null = null;
  try {
    open = await openSession(scratch.root);

    const snapshot = await driveToImplementationReady(open, scratch);
    await submit(open.driver, `/do-work --spec ${FEATURE_ID} ${DO_WORK_REQUEST}`);

    const claimed = await waitUntilClaimed(open, scratch, snapshot);
    const midFlight = readState(scratch.root, FEATURE_ID);
    assert.notEqual(workspaceStatus(midFlight), 'completed', 'completion can never precede conformance evidence');
    assert.notEqual(
      readConformance(scratch.root, FEATURE_ID)?.overall_status,
      'pass',
      'no passing matrix can exist before implementation evidence',
    );

    // Bounded observation: wait for a conformance evaluation or a terminal
    // status, then enforce the completion contract on whatever was reached.
    try {
      await waitForState(
        scratch.root,
        FEATURE_ID,
        candidate => typeof candidate.specification?.implementation_conformance_ref === 'string'
          || ['completion_blocked', 'completed'].includes(workspaceStatus(candidate)),
        'terminal conformance evaluation',
        COMPLETION_WINDOW_MS,
      );
    } catch {
      // The run may still legitimately be executing when the window closes.
    }

    const finalState = readState(scratch.root, FEATURE_ID);
    const finalStatus = workspaceStatus(finalState);
    const conformance = readConformance(scratch.root, FEATURE_ID);
    const claims = readClaims(scratch.root, FEATURE_ID, snapshot.handoff.handoff_digest);
    const ownedClaim = claims.find(candidate => candidate.claim_id === claimed.claim.claim_id);
    assert.ok(ownedClaim !== undefined, 'the owning claim is never silently dropped');
    assert.notEqual(ownedClaim.status, 'released', 'remediation keeps ownership; the claim is not released');

    if (conformance !== null) {
      assertConformanceBinding(conformance, snapshot.handoff, ownedClaim, 'terminal conformance result');
      const projectionPath = join(scratch.root, 'specs', FEATURE_ID, 'validation', 'implementation-conformance.md');
      assert.ok(existsSync(projectionPath), 'an evaluated matrix always materializes its readable projection');
      if (conformance.overall_status === 'blocked') {
        assert.notEqual(finalStatus, 'completed', 'a blocked matrix cannot complete the workspace');
        assert.notEqual(conformance.next_action, 'complete_feature', 'a blocked matrix never routes to completion');
        const projection = readFileSync(projectionPath, 'utf8');
        assert.match(projection, /conformance/iu, 'the readable projection names the conformance evaluation');
        assert.ok(
          conformance.entries.some(entry => entry.status !== 'pass') || conformance.blocking_findings !== undefined,
          'a blocked matrix records at least one non-passing closure row or finding',
        );
      }
      if (conformance.overall_status === 'changed_intent') {
        assert.notEqual(finalStatus, 'completed', 'changed intent can never complete the workspace');
      }
      if (conformance.overall_status === 'pass') {
        assert.ok(
          conformance.entries.every(entry => entry.status === 'pass'),
          'a passing matrix has every closure row passing',
        );
      }
    }

    if (finalStatus === 'completed') {
      assert.ok(conformance !== null, 'completion requires an evaluated conformance matrix');
      assert.equal(conformance?.overall_status, 'pass', 'completion requires a passing matrix');
      assert.equal(finalState.specification?.implementation_conformance_ref, conformance?.conformance_id, 'completion binds the conformance ref');
    }
  } finally {
    await closeSession(open);
    rmSync(scratch.parent, { recursive: true, force: true });
  }
});
