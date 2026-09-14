/**
 * T087 — real-harness runtime contract for legacy specification migration
 * (US7). These assertions run against a live OMP session in an authorized
 * scratch repository and define the migration and interrupted-resume runtime
 * behavior through the explicit feature boundary:
 *
 *   1. Opening a compatible legacy JSON-only run through the explicit
 *      `/specify --feature <id>` boundary materializes the new readable
 *      Markdown with provenance and no inferred approval (US7 scenario 1,
 *      FR-030, SC-009).
 *   2. The migration receipt is a durable record bound to the exact legacy
 *      source bytes, referenced from canonical state, and an identical
 *      replay never duplicates the receipt or the migrated phase versions.
 *   3. An interrupted migrated run resumes in a fresh session from the
 *      first unapproved phase: fresh validation plus a hard-human
 *      three-decision checkpoint are required before any approval exists,
 *      and legacy completion never implies readiness (US7 scenario 3 and
 *      the Phase 9 checkpoint).
 *
 * No mocked execution: every journey drives the real OMP process through
 * startTestSession + WsDriver and asserts on the durable aggregate state,
 * the materialized workspace files, and the trusted checkpoint ledger. The
 * only wall-clock windows are the documented settle polls for a detached
 * real process, which cannot be driven by fake timers (same exception as
 * the T049/T040 detached-mutation windows).
 */

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import type { AskBlock, SelectedAskBlock } from '../src/driver.js';
import { answerSelectedAsk, stripAnsi, TranscriptLog, waitFor, waitForOmpTuiReady, WsDriver } from '../src/driver.js';
import {
  createScratchSpecificationRepository,
  legacySpecificationRunDocument,
  type LegacySpecificationRunDocument,
} from '../src/specification-fixtures.js';
import { startTestSession, type TestSession } from '../src/server.js';
import { finalizeScratchDirectory } from '../src/scratch-lifecycle.js';
import { captureWorkspaceRoot } from '../../core/src/specification/workspace.js';
import { readCanonicalPhaseArtifact } from '../../core/src/specification/phase.js';

const LEGACY_FEATURE_ID = 'legacy-payment-retry';
const LEGACY_BRANCH = 'feat/legacy-payment-retry';
const SCENARIO = {
  id: 'spec-migration',
  title: 'Legacy specification migration and interrupted resume',
} as const;
/** Bounded real-time window for the harness to settle one open response. */
const OPEN_TIMEOUT_MS = 180_000;
/** Output is considered settled after this much frame silence. */
const STABILITY_WINDOW_MS = 10_000;
const WAIT_TIMEOUT_MS = 120_000;
const PRESERVE_ON_FAILURE = /^(?:1|true|yes)$/iu.test(process.env["OMP_UX_E2E_PRESERVE_ON_FAILURE"] ?? "");

type PhaseRecord = {
  phase: string;
  status: string;
  current_version: number | null;
  approved_version: number | null;
  validation_ref: string | null;
  checkpoint_ref: string | null;
};

type TypedDecision = {
  decision?: string;
  authorization?: string;
  actor?: { kind?: string; ref?: string; proof?: { answer_id?: string; binding?: string } };
};

type PersistedState = {
  run_key?: unknown;
  specification?: {
    feature_id?: unknown;
    source_kind?: unknown;
    status?: unknown;
    next_action?: { kind?: string; command?: string | null; reason?: string };
    migration_receipt_ref?: unknown;
    import_ref?: unknown;
    handoff_ref?: unknown;
    execution_claim_ref?: unknown;
    constitution_binding?: { provider_id?: unknown; path?: unknown; version?: unknown; content_sha256?: unknown; semantic_hash?: unknown; validation_ref?: unknown; bound_at?: unknown } | null;
    phases?: PhaseRecord[];
  };
  typed_checkpoint_decisions?: TypedDecision[];
  checkpoint_decisions?: Array<{ mode?: string; actor?: string; decision?: string }>;
};

type Scratch = { root: string; parent: string; legacyPath: string; legacyBytes: string };
type OpenSession = { session: TestSession; driver: WsDriver };

type Journey = {
  /** Transcript output captured from the submitted command onward. */
  readonly text: string;
  readonly log: TranscriptLog;
};

// ---------------------------------------------------------------------------
// Helpers (mirroring the T040/T061 runtime harness).
// ---------------------------------------------------------------------------


function sha256Text(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}


function makeLegacyScratch(slug: string): Scratch {
  const parent = mkdtempSync(join(tmpdir(), `omp-spec-migration-${slug}-`));
  const repository = createScratchSpecificationRepository({
    workdir: parent,
    slug,
    runtime: true,
    constitution: { variant: 'usable' },
    legacyRun: { featureId: LEGACY_FEATURE_ID, branch: LEGACY_BRANCH },
    extraFiles: [{ path: 'README.md', contents: '# Legacy migration runtime fixture\n' }],
  });
  const legacyPath = join(repository.root, repository.legacyRun?.statePath ?? '');
  assert.ok(repository.legacyRun !== undefined, 'scratch repository materialized the legacy run');
  assert.equal(
    repository.legacyRun.statePath,
    `.work-state/specification/${LEGACY_FEATURE_ID}/legacy-run.json`,
    'the legacy run fixture lives at the documented legacy state path',
  );
  return {
    root: repository.root,
    parent,
    legacyPath,
    legacyBytes: readFileSync(legacyPath, 'utf8'),
  };
}

function assertLegacySourceUnchanged(scratch: Scratch, label: string): void {
  assert.equal(
    readFileSync(scratch.legacyPath, 'utf8'),
    scratch.legacyBytes,
    `${label}: legacy JSON-only source bytes remain byte-for-byte unchanged`,
  );
}

function featureWorkspaceIds(root: string): string[] {
  const dir = join(root, '.work-state', 'features');
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter(entry => entry.isDirectory() && !entry.name.startsWith('.'))
    .map(entry => entry.name)
    .sort();
}

function readState(root: string, featureId: string): PersistedState {
  const path = join(root, '.work-state', 'features', featureId, 'state.json');
  return JSON.parse(readFileSync(path, 'utf8')) as PersistedState;
}

function phaseOf(state: PersistedState, phase: string): PhaseRecord | undefined {
  return state.specification?.phases?.find(candidate => candidate.phase === phase);
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
    maxTimeSec: 300,
    idleMs: 180_000,
    scenario: SCENARIO,
    taskPrompt: 'Exercise the legacy specification migration contract.',
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
  for (const frame of log.frames.slice(fromFrame)) {
    if (frame.t !== 'o') continue;
    chunks.push(stripAnsi(frame.d));
  }
  return chunks.join('\n');
}

/**
 * Submits one command and waits until the harness response settles:
 * frame silence for STABILITY_WINDOW_MS or a session exit. The settle
 * polling is deliberately wall-clock — a detached OMP process renders its
 * transcript on the platform clock and cannot be driven by fake timers
 * (same exception as the T049/T040 detached-mutation windows).
 */
async function submitAndSettle(open: OpenSession, command: string, label: string): Promise<Journey> {
  const log = new TranscriptLog(open.session.transcriptPath);
  log.refresh();
  const fromFrame = log.frames.length;
  await submit(open.driver, command);
  await waitFor(
    () => {
      log.refresh();
      return log.frames.length > fromFrame
        && log.frames.slice(fromFrame).some(frame => frame.t === 'o');
    },
    { timeoutMs: OPEN_TIMEOUT_MS, intervalMs: 200, label },
  );
  let lastCount = log.frames.length;
  let lastChange = Date.now();
  await waitFor(
    () => {
      log.refresh();
      if (log.frames.some(frame => frame.t === 'exit')) return true;
      if (log.frames.length !== lastCount) {
        lastCount = log.frames.length;
        lastChange = Date.now();
        return false;
      }
      return Date.now() - lastChange >= STABILITY_WINDOW_MS;
    },
    { timeoutMs: OPEN_TIMEOUT_MS, intervalMs: 1_000, label: `${label} output settled` },
  );
  log.refresh();
  return { log, text: outputText(log, fromFrame) };
}

/** Submit one command and return after the first response frame; callers then
 * await the durable state or checkpoint that defines their acceptance. */
async function submitAndWaitForOutput(open: OpenSession, command: string, label: string): Promise<Journey> {
  const log = new TranscriptLog(open.session.transcriptPath);
  log.refresh();
  const fromFrame = log.frames.length;
  await submit(open.driver, command);
  await waitFor(
    () => {
      log.refresh();
      return log.frames.length > fromFrame
        && log.frames.slice(fromFrame).some(frame => frame.t === 'o');
    },
    { timeoutMs: OPEN_TIMEOUT_MS, intervalMs: 200, label },
  );
  log.refresh();
  return { log, text: outputText(log, fromFrame) };
}

/** Turns a missing `/specify` command into an exact contract failure. */
function assertCommandRegistered(journey: Journey): void {
  assert.doesNotMatch(
    journey.text,
    /unknown command|unrecognized command|not a valid command|no such command|isn['']t a recognized/iu,
    '/specify must be a registered harness command; T087 defines the migration behavior '
    + 'behind its explicit --feature boundary',
  );
}

/**
 * Opens the legacy run through the explicit migration boundary and asserts
 * that the established feature workspace, readable projections, and migration
 * receipt are materialized before returning its durable state.
 */
async function openLegacyRun(open: OpenSession, root: string, label: string): Promise<PersistedState> {
  const journey = await submitAndWaitForOutput(open, `/specify --feature ${LEGACY_FEATURE_ID}`, label);
  assertCommandRegistered(journey);
  await waitFor(
    () => {
      try {
        const state = readState(root, LEGACY_FEATURE_ID);
        const receiptRef = state.specification?.migration_receipt_ref;
        const docsDir = join(root, 'specs', LEGACY_FEATURE_ID);
        return featureWorkspaceIds(root).length > 0
          && state.specification?.source_kind === 'legacy'
          && typeof receiptRef === 'string'
          && receiptRef.length > 0
          && ['spec.md', 'plan.md', 'tasks.md', 'status.md'].every(doc => existsSync(join(docsDir, doc)))
          && findReceiptArtifacts(root, LEGACY_FEATURE_ID, receiptRef).length === 1;
      } catch {
        return false;
      }
    },
    { timeoutMs: OPEN_TIMEOUT_MS, intervalMs: 200, label: `${label}: migration state, documents, and receipt materialized` },
  );
  return waitForState(
    root,
    LEGACY_FEATURE_ID,
    state =>
      state.specification?.source_kind === 'legacy'
      && typeof state.specification?.migration_receipt_ref === 'string'
      && (state.specification?.migration_receipt_ref as string).length > 0,
    `${label}: migrated workspace carries legacy provenance and a migration receipt reference`,
  );
}

/** Every migrated phase record is unapproved and carries no checkpoint proof. */
function assertFullConstitutionBinding(state: PersistedState, label: string): void {
  const binding = state.specification?.constitution_binding;
  assert.ok(binding !== null && typeof binding === "object", label + ": migration carries a complete ConstitutionBinding");
  if (binding === null || typeof binding !== "object") return;
  for (const field of ["provider_id", "path", "version", "content_sha256", "semantic_hash", "validation_ref", "bound_at"] as const) {
    assert.equal(typeof binding[field], "string", label + ": ConstitutionBinding." + field + " is gate-produced");
  }
}

function assertNoInferredApproval(state: PersistedState, label: string): void {
  const phases = state.specification?.phases ?? [];
  assert.deepEqual(
    phases.map(phase => phase.phase),
    ['specify', 'plan', 'tasks'],
    `${label}: the migrated workspace keeps exactly the Specify, Plan, and Tasks records`,
  );
  for (const phase of phases) {
    assert.notEqual(phase.status, 'approved', `${label}: legacy completion cannot infer ${phase.phase} approval`);
    assert.equal(phase.approved_version, null, `${label}: ${phase.phase} requires fresh human approval`);
    assert.equal(phase.checkpoint_ref, null, `${label}: ${phase.phase} has no inferred checkpoint proof`);
  }
  assert.equal(state.specification?.handoff_ref ?? null, null, `${label}: no handoff exists before approval`);
  assert.notEqual(
    state.specification?.status,
    'implementation_ready',
    `${label}: an unapproved migration cannot become executable`,
  );
  assert.equal(state.specification?.execution_claim_ref ?? null, null, `${label}: no execution claim exists`);
}

/**
 * path → SHA-256 over the materialized readable workspace, recursing into
 * subdirectories. This is the no-duplication baseline replay compares
 * against.
 */
function workspaceDocDigests(root: string, featureId: string, prefix = ''): Record<string, string> {
  const base = join(root, 'specs', featureId);
  const digests: Record<string, string> = {};
  for (const dirent of readdirSync(join(base, prefix), { withFileTypes: true })) {
    const relative = prefix === '' ? dirent.name : `${prefix}/${dirent.name}`;
    const absolute = join(base, relative);
    if (dirent.isDirectory()) {
      Object.assign(digests, workspaceDocDigests(root, featureId, relative));
    } else if (dirent.isFile()) {
      digests[relative] = sha256Text(readFileSync(absolute, 'utf8'));
    } else {
      digests[relative] = `special:${statSync(absolute).mode}`;
    }
  }
  return digests;
}

/** Recursive scan of the feature artifact store for one receipt id. */
function findReceiptArtifacts(
  root: string,
  featureId: string,
  receiptRef: string,
): Array<{ path: string; value: Record<string, unknown> }> {
  const artifactsDir = join(root, '.work-state', 'features', featureId, 'artifacts');
  const matches: Array<{ path: string; value: Record<string, unknown> }> = [];
  const walk = (dir: string): void => {
    if (!existsSync(dir)) return;
    for (const dirent of readdirSync(dir, { withFileTypes: true })) {
      const absolute = join(dir, dirent.name);
      if (dirent.isDirectory()) {
        walk(absolute);
        continue;
      }
      if (!dirent.isFile() || !dirent.name.endsWith('.json')) continue;
      try {
        const value: unknown = JSON.parse(readFileSync(absolute, 'utf8'));
        if (value !== null && typeof value === 'object'
          && ((value as Record<string, unknown>)['id'] === receiptRef
            || (value as Record<string, unknown>)['receipt_id'] === receiptRef)) {
          matches.push({ path: absolute, value: value as Record<string, unknown> });
        }
      } catch {
        // Unreadable side artifacts are not receipt candidates.
      }
    }
  };
  walk(artifactsDir);
  return matches;
}

function assertHumanDecisions(state: PersistedState, label: string): void {
  const decisions = state.typed_checkpoint_decisions ?? [];
  assert.ok(decisions.length > 0, `${label}: at least one typed checkpoint decision is recorded`);
  for (const decision of decisions) {
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

async function waitForPhaseCheckpoint(
  open: OpenSession,
  phase: string,
  label: string,
): Promise<{ block: AskBlock | SelectedAskBlock; log: TranscriptLog }> {
  const log = new TranscriptLog(open.session.transcriptPath);
  let block: AskBlock | SelectedAskBlock | undefined;
  await waitFor(
    () => {
      log.refresh();
      const blocks = log.askBlocks();
      const isDecisionSet = (candidate: { options: readonly string[] }): boolean => candidate.options.length >= 3
        && /approve[_ -]?continue/iu.test(candidate.options[0] ?? "")
        && /request[_ -]?changes/iu.test(candidate.options[1] ?? "")
        && /approve[_ -]?stop/iu.test(candidate.options[2] ?? "");
      block = blocks.find(candidate => isDecisionSet(candidate) && new RegExp(phase, 'iu').test(candidate.title));
      if (block === undefined) {
        const selected = log.selectedAskBlocks();
        block = selected.find(candidate => isDecisionSet(candidate));
      }
      return block !== undefined;
    },
    { timeoutMs: WAIT_TIMEOUT_MS, intervalMs: 100, label },
  );
  assert.ok(block !== undefined, `${phase} checkpoint is presented`);
  assert.ok(block.options.length >= 3, ` exposes the three policy decisions`);
  assert.match(block.options[0] ?? '', /approve[_ -]?continue/iu, `${phase} offers approve and continue`);
  assert.match(block.options[1] ?? '', /request[_ -]?changes/iu, `${phase} offers request changes`);
  assert.match(block.options[2] ?? '', /approve[_ -]?stop/iu, `${phase} offers approve and stop`);
  return { block, log };
}

// ---------------------------------------------------------------------------
// T087.1 — legacy materialization with provenance and no inferred approval.
// ---------------------------------------------------------------------------

test('T087 runtime: opening a compatible legacy run materializes readable Markdown with provenance and no inferred approval', async () => {

  const scratch = makeLegacyScratch('materialize');
  const legacyDoc: LegacySpecificationRunDocument = legacySpecificationRunDocument(LEGACY_FEATURE_ID, LEGACY_BRANCH);
  let open: OpenSession | null = null;
  let testFailureObserved = false;
  try {
    open = await openSession(scratch.root);

    const migrated = await openLegacyRun(open, scratch.root, 'legacy materialization');

    // Migration maps the legacy run onto the explicit feature identity; it
    // must not invent a derived or branch-based identity.
    assert.deepEqual(
      featureWorkspaceIds(scratch.root),
      [LEGACY_FEATURE_ID],
      'migration creates exactly one workspace bound to the explicit legacy feature id',
    );
    assert.equal(migrated.specification?.source_kind, 'legacy', 'migrated provenance records the legacy source kind');
    assert.equal(migrated.specification?.import_ref ?? null, null, 'a migrated run is not an external import');

    // Provenance binds the current constitution: the migration input is only
    // trusted together with the exact policy fingerprint it will be
    // validated against.
    const constitutionBytes = readFileSync(join(scratch.root, 'CONSTITUTION.md'), 'utf8');
    const binding = migrated.specification?.constitution_binding;
    assertFullConstitutionBinding(migrated, 'migrated workspace');
    assert.ok(binding !== null && typeof binding === 'object', 'migration binds the current constitution');
    assert.equal(
      binding?.content_sha256,
      sha256Text(constitutionBytes),
      'the migrated constitution binding carries the exact current constitution fingerprint',
    );

    // The readable workspace is materialized for every legacy phase plus the
    // readable status projection.
    const docsDir = join(scratch.root, 'specs', LEGACY_FEATURE_ID);
    for (const doc of ['spec.md', 'plan.md', 'tasks.md', 'status.md'] as const) {
      assert.ok(existsSync(join(docsDir, doc)), `migration materializes specs/${LEGACY_FEATURE_ID}/${doc}`);
    }
    const specMd = readFileSync(join(docsDir, 'spec.md'), 'utf8');
    const planMd = readFileSync(join(docsDir, 'plan.md'), 'utf8');
    const tasksMd = readFileSync(join(docsDir, 'tasks.md'), 'utf8');

    // No data loss: every legacy requirement, acceptance scenario, decision,
    // and task survives into the readable documents (SC-009).
    assert.ok(
      specMd.includes(legacyDoc.specification.problem),
      'spec.md preserves the legacy problem statement',
    );
    for (const requirement of legacyDoc.specification.requirements) {
      assert.ok(specMd.includes(requirement.id), `spec.md preserves ${requirement.id}`);
      assert.ok(specMd.includes(requirement.text), `spec.md preserves the ${requirement.id} requirement text`);
    }
    for (const acceptance of legacyDoc.specification.acceptance) {
      assert.ok(specMd.includes(acceptance.id), `spec.md preserves acceptance scenario ${acceptance.id}`);
    }
    for (const decision of legacyDoc.plan.decisions) {
      assert.ok(planMd.includes(decision.id), `plan.md preserves ${decision.id}`);
      assert.ok(planMd.includes(decision.text), `plan.md preserves the ${decision.id} decision text`);
    }
    for (const task of legacyDoc.tasks) {
      assert.ok(tasksMd.includes(task.id), `tasks.md preserves ${task.id}`);
      assert.ok(tasksMd.includes(task.title), `tasks.md preserves the ${task.id} task title`);
    }

    // Legacy completion is provenance, never approval.
    assertNoInferredApproval(migrated, 'migrated workspace');

    // No detached or asynchronous path may approve the migrated content
    // while the terminal is idle (short real-time quiet window; a fake
    // clock cannot drive a detached OMP process).
    await new Promise<void>(resolve => setTimeout(resolve, 500));
    assertNoInferredApproval(readState(scratch.root, LEGACY_FEATURE_ID), 'migrated workspace after idle window');

    assertLegacySourceUnchanged(scratch, 'legacy materialization');
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
// T087.2 — durable migration receipt bound to the exact source bytes, and an
// idempotent replay that never duplicates records.
// ---------------------------------------------------------------------------

test('T087 runtime: the migration receipt binds the exact legacy source bytes and replaying the open duplicates nothing', async () => {

  const scratch = makeLegacyScratch('receipt');
  let open: OpenSession | null = null;
  let testFailureObserved = false;
  try {
    open = await openSession(scratch.root);

    const migrated = await openLegacyRun(open, scratch.root, 'migration receipt');
    const receiptRef = migrated.specification?.migration_receipt_ref;
    assert.ok(typeof receiptRef === 'string' && receiptRef.length > 0, 'canonical state references a migration receipt');

    // The receipt is a durable artifact in the feature artifact store and is
    // bound to the exact legacy source bytes and input paths (FR-030).
    const receipts = findReceiptArtifacts(scratch.root, LEGACY_FEATURE_ID, receiptRef);
    assert.equal(receipts.length, 1, 'exactly one migration receipt artifact matches the state reference');
    const receipt = receipts[0];
    assert.ok(receipt !== undefined, 'the receipt artifact was found');
    const receiptJson = JSON.stringify(receipt.value);
    assert.ok(
      receiptJson.includes(sha256Text(scratch.legacyBytes)),
      'the receipt records the SHA-256 of the exact migrated legacy source bytes',
    );
    assert.ok(receiptJson.includes('legacy-run.json'), 'the receipt records the legacy source path as provenance');
    assert.ok(receiptJson.includes(LEGACY_FEATURE_ID), 'the receipt is bound to the migrated feature id');

    // Baseline for the replay: current state, docs, and receipt.
    const specifyBefore = phaseOf(migrated, 'specify');
    const docsBefore = workspaceDocDigests(scratch.root, LEGACY_FEATURE_ID);
    assert.ok(Object.keys(docsBefore).length > 0, 'the migrated workspace has readable documents to protect');

    // Replaying the identical open must return the established migration:
    // no second receipt, no second phase version, no rewritten documents.
    await closeSession(open);
    open = await openSession(scratch.root);
    const replay = await submitAndWaitForOutput(open, `/specify --feature ${LEGACY_FEATURE_ID}`, 'idempotent replay');
    assertCommandRegistered(replay);

    const afterReplay = await waitForState(
      scratch.root,
      LEGACY_FEATURE_ID,
      state => state.specification?.source_kind === 'legacy',
      'replayed migration keeps the established legacy workspace',
    );
    assert.equal(
      afterReplay.specification?.migration_receipt_ref,
      receiptRef,
      'replay keeps the established migration receipt reference',
    );
    assert.equal(
      findReceiptArtifacts(scratch.root, LEGACY_FEATURE_ID, receiptRef).length,
      1,
      'replay never writes a second migration receipt',
    );
    assert.deepEqual(
      workspaceDocDigests(scratch.root, LEGACY_FEATURE_ID),
      docsBefore,
      'replay never rewrites the materialized readable documents',
    );
    const specifyAfter = phaseOf(afterReplay, 'specify');
    assert.equal(
      specifyAfter?.current_version,
      specifyBefore?.current_version ?? null,
      'replay never creates a second Specify version',
    );
    assert.equal(
      specifyAfter?.approved_version ?? null,
      null,
      'replay never infers approval for the migrated Specify phase',
    );
    assertNoInferredApproval(afterReplay, 'replayed workspace');

    assertLegacySourceUnchanged(scratch, 'migration receipt replay');
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
// T087.3 — interrupted migrated run: fresh validation plus a hard-human
// checkpoint before any approval, resumed exactly once.
// ---------------------------------------------------------------------------

test('T087 runtime: an interrupted migrated run resumes with fresh validation and a human approval requirement exactly once', async () => {

  const scratch = makeLegacyScratch('resume');
  let open: OpenSession | null = null;
  let testFailureObserved = false;
  try {
    // Session 1: open the legacy run and interrupt it before any human
    // decision is recorded.
    open = await openSession(scratch.root);
    const migrated = await openLegacyRun(open, scratch.root, 'interrupted migration');
    assertNoInferredApproval(migrated, 'interrupted migrated workspace');

    // The fresh migration must satisfy the same canonical reader contract used
    // by validator-only resume; Markdown presence alone is not sufficient.
    const pinned = captureWorkspaceRoot(scratch.root);
    assert.ok(pinned !== null, 'fresh migrated workspace can be pinned for canonical reading');
    if (pinned !== null) {
      try {
        const artifact = readCanonicalPhaseArtifact(pinned.canonical_root, {
          feature_id: LEGACY_FEATURE_ID,
          run_key: migrated.run_key ?? '',
          phase: 'specify',
          version: 1,
        }, pinned.pinned_root);
        assert.ok(artifact !== null, 'fresh migrated Specify artifact is accepted by the canonical reader');
      } finally {
        pinned.pinned_root.close();
      }
    }
    await closeSession(open);
    open = null;

    // Session 2: the explicit resume must run fresh validation on the
    // migrated Specify content — a checkpoint is impossible before a current
    // passing validation result — and open the hard-human checkpoint.
    open = await openSession(scratch.root);
    const resumeJourney = await submitAndWaitForOutput(open, `/specify --feature ${LEGACY_FEATURE_ID}`, 'interrupted resume');
    assertCommandRegistered(resumeJourney);

    const resumed = await waitForState(
      scratch.root,
      LEGACY_FEATURE_ID,
      state => {
        const specify = phaseOf(state, 'specify');
        return specify?.status === 'awaiting_approval'
          && typeof specify.validation_ref === 'string'
          && specify.validation_ref.length > 0
          && specify.approved_version === null;
      },
      'resumed Specify reaches awaiting approval through fresh validation',
    );
    const specify = phaseOf(resumed, 'specify');
    assert.ok(specify !== undefined, 'the resumed workspace keeps the Specify record');
    assert.ok(specify.current_version !== null, 'the migrated Specify version survives the interruption');
    assert.equal(specify.approved_version, null, 'no approval exists before the human decision');

    // The fresh transcript presents exactly one Specify checkpoint; a second
    // block or a duplicated version would prove duplicated migration work.
    const { block: resumeCheckpoint, log: resumeLog } = await waitForPhaseCheckpoint(
      open,
      'specify',
      'Specify checkpoint after interrupted resume',
    );
    const specifyBlocks = [...resumeLog.askBlocks(), ...resumeLog.selectedAskBlocks()]
      .filter(candidate => candidate.options.length >= 3
        && /approve[_ -]?continue/iu.test(candidate.options[0] ?? "")
        && /request[_ -]?changes/iu.test(candidate.options[1] ?? "")
        && /approve[_ -]?stop/iu.test(candidate.options[2] ?? ""));
    assert.equal(specifyBlocks.length, 1, 'the resumed transcript presents the Specify checkpoint exactly once');
    assertLegacySourceUnchanged(scratch, 'interrupted resume before approval');

    // Only the human answer may approve the migrated content; approve_stop
    // records the approval and returns before dispatching Plan.
    if (resumeCheckpoint.surface === "selector") {
      await answerSelectedAsk(open.driver, resumeCheckpoint, "approve_stop");
    } else {
      await submit(open.driver, "3");
    }
    const approved = await waitForState(
      scratch.root,
      LEGACY_FEATURE_ID,
      state => {
        const approvedSpecify = phaseOf(state, 'specify');
        const plan = phaseOf(state, 'plan');
        return approvedSpecify?.status === 'approved'
          && approvedSpecify.approved_version === approvedSpecify.current_version
          && plan?.status === 'not_started';
      },
      'human approval recorded exactly once after resume',
    );
    const approvedSpecify = phaseOf(approved, 'specify');
    assert.equal(
      approvedSpecify?.current_version,
      specify?.current_version,
      'approval binds the migrated Specify version without creating a second one',
    );
    assert.ok(
      typeof approvedSpecify?.validation_ref === 'string' && approvedSpecify.validation_ref.length > 0,
      'the approval is bound to the fresh validation result',
    );
    assert.ok(
      typeof approvedSpecify?.checkpoint_ref === 'string' && approvedSpecify.checkpoint_ref.length > 0,
      'the approval is bound to the recorded checkpoint proof',
    );
    assertHumanDecisions(approved, 'approved migrated Specify');

    // The user decision must be the only approval path: the transcript that
    // produced it still contains exactly one Specify checkpoint.
    const finalLog = new TranscriptLog(open.session.transcriptPath);
    finalLog.refresh();
    const finalSpecifyBlocks = [...finalLog.askBlocks(), ...finalLog.selectedAskBlocks()]
      .filter(candidate => candidate.options.length >= 3
        && /approve[_ -]?continue/iu.test(candidate.options[0] ?? "")
        && /request[_ -]?changes/iu.test(candidate.options[1] ?? "")
        && /approve[_ -]?stop/iu.test(candidate.options[2] ?? ""));
    assert.equal(finalSpecifyBlocks.length, 1, 'approval never re-presents or duplicates the Specify checkpoint');

    // Legacy completion still does not make the feature executable: only
    // Specify is approved, and the next action routes to the explicit Plan
    // resume command.
    assert.equal(phaseOf(approved, 'plan')?.status, 'not_started', 'approve_stop does not dispatch Plan');
    assert.notEqual(
      approved.specification?.status,
      'implementation_ready',
      'a single approved migrated phase cannot make the workspace implementation-ready',
    );
    assert.equal(approved.specification?.handoff_ref ?? null, null, 'no handoff exists without full approval');
    const nextAction = approved.specification?.next_action;
    assert.equal(nextAction?.kind, 'command', 'approve_stop routes to the explicit next phase command');
    assert.ok(
      typeof nextAction?.command === 'string' && nextAction.command.startsWith('/spec-plan'),
      'the next action resumes the first unapproved phase through /spec-plan',
    );

    assertLegacySourceUnchanged(scratch, 'interrupted resume after approval');
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
