/**
 * T102 — real-runtime multi-feature CTO preparation and hard stop.
 *
 * Drives one real OMP session in a scratch repository with no constitution
 * and no external specification framework. The resident CTO prepares three
 * features through the standard specification profiles: `prep-atlas` and
 * `prep-borealis` are independent workspaces, `prep-meridian` arrives as two
 * facets (`facet-a`, `facet-b`) of one feature that must converge behind one
 * phase writer and one workspace.
 *
 * Pinned behavior (US9 / quickstart Scenario 9, journey declared by
 * `packages/e2e/scenarios/spec-cto-preparation.json` from T108):
 * - one resident CTO run, no nested CTO, three distinct standard workspaces;
 * - one run-level plugin-native constitution prerequisite with exactly two
 *   decisions; later feature prerequisites reuse the valid constitution;
 * - one readable batched Specify review packet while every feature/phase
 *   decision stays a separate synchronous hard-human answer with mixed
 *   outcomes (approve_continue, request_changes, approve_stop);
 * - only eligible workspaces advance: the request-changes loop is contained
 *   to borealis and never blocks or restarts atlas or meridian;
 * - the blocked facet-b slice is reported with durable targeted-resume state
 *   while atlas and beta stay reviewable;
 * - an overflow request is queued with visible team cap / decomposition
 *   depth / capacity / ownership / active-phase reasons instead of nesting;
 * - final Tasks approvals (`approve_stop`) return implementation-ready
 *   handoffs and end the preparation wave: no execution claim, no
 *   implementation dispatch, and no `/do-work --spec` input — execution
 *   requires a separate explicit CTO execution wave.
 *
 * No execution is mocked: the OMP binary, PTY, transcript, and workspace
 * state are the system under test.
 *
 */

import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  createScratchSpecificationRepository,
  type ScratchRepositoryResult,
} from '../src/specification-fixtures.js';
import { expandTemplate, loadScenario, type ScenarioDefinition } from '../src/scenario.js';
import {
  answerSelectedAsk,
  answerSelectedAskWithNote,
  matchesCanonicalSelectorOptions,
  type AskBlock,
  type SelectedAskBlock,
  TranscriptLog,
  waitFor,
  waitForOmpTuiReady,
  WsDriver,
} from '../src/driver.js';
import { startTestSession, type TestSession } from '../src/server.js';
import { finalizeScratchDirectory } from '../src/scratch-lifecycle.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const SCENARIO_PATH = join(HERE, '..', 'scenarios', 'spec-cto-preparation.json');
const INDEPENDENT_A = 'prep-atlas';
const INDEPENDENT_B = 'prep-borealis';
const FACETED = 'prep-meridian';
const FACET_A = 'facet-a';
const FACET_B = 'facet-b';
const ALL_FEATURES = [INDEPENDENT_A, INDEPENDENT_B, FACETED] as const;
const REQUEST =
  'prepare specifications for three features: `prep-atlas` and `prep-borealis` are independent, ' +
  'and `prep-meridian` arrives as two facets (`facet-a`, `facet-b`) of one feature. Record a ' +
  'separate checkpoint decision per feature and phase, queue any overflow with a visible reason, ' +
  'and stop after the final Tasks approvals without implementation';
const WAIT_TIMEOUT_MS = 900_000;
const PRESERVE_ON_FAILURE = /^(?:1|true|yes)$/iu.test(process.env["OMP_UX_E2E_PRESERVE_ON_FAILURE"] ?? "");

function escapedRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

async function sendLine(driver: WsDriver, line: string): Promise<void> {
  await driver.type(line);
  await driver.pressEnter();
}

async function waitForOutput(
  driver: WsDriver,
  pattern: RegExp,
  label: string,
  timeoutMs = WAIT_TIMEOUT_MS,
): Promise<string> {
  let screen = '';
  await waitFor(
    async () => {
      screen = await driver.readScreen();
      pattern.lastIndex = 0;
      return pattern.test(screen);
    },
    { timeoutMs, intervalMs: 100, label },
  );
  return screen;
}

async function waitForMarkdown(
  path: string,
  patterns: readonly RegExp[],
  label: string,
  timeoutMs = WAIT_TIMEOUT_MS,
): Promise<string> {
  let content = '';
  await waitFor(
    () => {
      if (!existsSync(path)) return false;
      try {
        content = readFileSync(path, 'utf8');
      } catch {
        return false;
      }
      return patterns.every((pattern) => {
        pattern.lastIndex = 0;
        return pattern.test(content);
      });
    },
    { timeoutMs, intervalMs: 100, label },
  );
  return content;
}

function filesBelow(root: string): string[] {
  if (!existsSync(root)) return [];
  const files: string[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) files.push(...filesBelow(path));
    else if (entry.isFile()) files.push(path);
  }
  return files;
}

function readTextFile(path: string): string {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return '';
  }
}

function workspaceText(root: string, featureId: string): string {
  return filesBelow(join(root, '.work-state', 'features', featureId))
    .map(readTextFile)
    .join('\n');
}

/** Transcript plus wave-level state: where CTO queue, blocked-slice, and review evidence surfaces. */
function coordinationText(root: string, log: TranscriptLog): string {
  log.refresh();
  const transcript = log.frames.map((frame) => frame.d).join('\n');
  const waveState = filesBelow(join(root, '.work-state'))
    .filter((path) => !path.includes(join('.work-state', 'features')))
    .map(readTextFile)
    .join('\n');
  return `${transcript}\n${waveState}`;
}

interface WorkspaceIdentity {
  runKey: string;
  executionClaimRef: unknown;
  handoffRef: unknown;
}

function readWorkspaceIdentity(root: string, featureId: string): WorkspaceIdentity {
  const statePath = join(root, '.work-state', 'features', featureId, 'state.json');
  assert.ok(existsSync(statePath), `${featureId}: canonical feature state is persisted`);
  const state = JSON.parse(readTextFile(statePath)) as {
    run_key?: unknown;
    specification?: {
      feature_id?: unknown;
      workspace_path?: unknown;
      execution_claim_ref?: unknown;
      handoff_ref?: unknown;
    };
  };
  assert.equal(typeof state.run_key, 'string', `${featureId}: state carries an explicit run_key`);
  assert.equal(state.specification?.feature_id, featureId, `${featureId}: state carries the selected feature_id`);
  assert.equal(state.specification?.workspace_path, `specs/${featureId}`, `${featureId}: workspace path is feature-bound`);
  return {
    runKey: state.run_key as string,
    executionClaimRef: state.specification?.execution_claim_ref,
    handoffRef: state.specification?.handoff_ref,
  };
}

function assertWorkerAttribution(root: string, featureId: string): void {
  const text = workspaceText(root, featureId);
  assert.ok(text.length > 0, `${featureId}: feature state/artifact evidence is readable`);
  assert.ok(
    (text.match(/"dispatch_id"\s*:/gu) ?? []).length >= 3,
    `${featureId}: Specify, Plan, and Tasks versions retain dispatch attribution`,
  );
  for (const phase of ['specify', 'plan', 'tasks']) {
    assert.match(text, new RegExp(`"phase"\\s*:\\s*"${phase}"`, 'u'), `${featureId}: ${phase} artifact records its phase`);
  }
  assert.match(text, /"role"\s*:/u, `${featureId}: phase evidence records worker role`);
  assert.match(text, /"agent"\s*:/u, `${featureId}: phase evidence records worker agent`);
  assert.match(text, /handoff_digest/u, `${featureId}: machine handoff digest is bound in state`);
}

function assertNoExternalFramework(root: string): void {
  for (const candidate of ['.specify', '.openspec', '.bmad', '.superpowers', '.xpowers']) {
    assert.equal(existsSync(join(root, candidate)), false, `${candidate} is absent in the native fixture`);
  }
}

/**
 * One planned hard-human decision from the canonical scenario ask table. The
 * CTO schedules the three features inside each stage, so decisions are
 * consumed whenever their title surfaces instead of assuming one fixed
 * interleave; entries with identical matchers are consumed in declared order.
 */
interface PlannedDecision {
  readonly label: string;
  readonly title: RegExp;
  readonly answer: '1' | '2' | '3';
  /** Exact expected option count; omitted means only "at least two options". */
  readonly options?: 2 | 3;
  readonly feedback?: string;
}

const DECISIONS: readonly PlannedDecision[] = [
  { label: 'constitution bootstrap', title: /constitution/iu, answer: '1', options: 2 },
  { label: `${INDEPENDENT_A} Specify review`, title: /atla[st]/iu, answer: '1', options: 3 },
  { label: `${INDEPENDENT_B} Specify review`, title: /borealis/iu, answer: '2', options: 3, feedback: 'scenario' },
  { label: `${FACETED} Specify review`, title: /meridian/iu, answer: '1', options: 3 },
  { label: `${INDEPENDENT_B} revised Specify review`, title: /borealis/iu, answer: '1', options: 3 },
  { label: 'blocked facet slice resume decision', title: /\bresume\b|\bblock/iu, answer: '1' },
  { label: `${INDEPENDENT_A} final Tasks approval`, title: new RegExp(`${INDEPENDENT_A}.*tasks|tasks.*${INDEPENDENT_A}`, 'iu'), answer: '3', options: 3 },
  { label: `${INDEPENDENT_B} final Tasks approval`, title: new RegExp(`${INDEPENDENT_B}.*tasks|tasks.*${INDEPENDENT_B}`, 'iu'), answer: '3', options: 3 },
  { label: `${FACETED} final Tasks approval`, title: new RegExp(`${FACETED}.*tasks|tasks.*${FACETED}`, 'iu'), answer: '3', options: 3 },
];

type CheckpointBlock = AskBlock | SelectedAskBlock;

interface CheckpointCursor {
  readonly legacyFrame: number;
  readonly selectorFrame: number;
}

const CONSTITUTION_SELECTOR_OPTIONS = ['approve_continue', 'request_changes'] as const;
const PHASE_SELECTOR_OPTIONS = ['approve_continue', 'request_changes', 'approve_stop'] as const;

function selectorDecisionCount(block: SelectedAskBlock): 2 | 3 | null {
  if (matchesCanonicalSelectorOptions(block.options, CONSTITUTION_SELECTOR_OPTIONS)) return 2;
  if (matchesCanonicalSelectorOptions(block.options, PHASE_SELECTOR_OPTIONS)) return 3;
  return null;
}

function checkpointIdentityText(block: CheckpointBlock): string {
  if (block.surface === 'selector') return block.title;
  return [block.title, ...block.questions.flatMap((question) => [question.id, question.prompt])].join('\n');
}

function pendingDecisionIndex(block: CheckpointBlock, pending: readonly PlannedDecision[]): number {
  // Bind each observed card to its feature/run/checkpoint identity. Option
  // count/order is only validated after the identity match; it must never pick
  // one of several three-option cards by position.
  const identity = checkpointIdentityText(block);
  return pending.findIndex((decision) => decision.title.test(identity));
}

/** Wait for the next checkpoint after `cursor`, classify it, answer it, and return the new cursor. */
async function answerNextCheckpoint(
  driver: WsDriver,
  log: TranscriptLog,
  pending: PlannedDecision[],
  feedback: string,
  cursor: CheckpointCursor,
): Promise<CheckpointCursor> {
  let block: CheckpointBlock | undefined;
  let plannedIndex = -1;
  await waitFor(
    async () => {
      const selected = log.pendingSelectedAsk();
      const candidates: CheckpointBlock[] = [
        ...log.askBlocks().filter((ask) => ask.frameStart > cursor.legacyFrame && ask.options.length > 0),
        ...(selected !== null && selected.frameStart > cursor.selectorFrame && selected.options.length > 0
          ? [selected]
          : []),
      ].sort((left, right) => {
        const frameOrder = left.frameStart - right.frameStart;
        if (frameOrder !== 0) return frameOrder;
        // OMP can render the mounted selector and a compatibility/native copy
        // of one Ask card in the same PTY frame. Prefer the selector: it is the
        // authoritative surface and requires real terminal key events.
        if (left.surface === right.surface) return 0;
        return left.surface === 'selector' ? -1 : 1;
      });
      for (const candidate of candidates) {
        const candidateIndex = pendingDecisionIndex(candidate, pending);
        if (candidateIndex < 0) continue;
        block = candidate;
        plannedIndex = candidateIndex;
        return true;
      }
      return false;
    },
    { timeoutMs: WAIT_TIMEOUT_MS, intervalMs: 100, label: `checkpoint after frame ${Math.max(cursor.legacyFrame, cursor.selectorFrame)}` },
  );
  assert.ok(block !== undefined, 'checkpoint was observed');
  assert.ok(plannedIndex >= 0, 'checkpoint matches a pending decision');
  const planned = pending[plannedIndex];
  assert.ok(planned !== undefined, 'planned checkpoint exists');
  if (planned.options !== undefined) {
    if (block.surface === 'selector') {
      const expected = planned.options === 2 ? CONSTITUTION_SELECTOR_OPTIONS : PHASE_SELECTOR_OPTIONS;
      assert.ok(
        matchesCanonicalSelectorOptions(block.options, expected),
        `${planned.label}: selector exposes the canonical hard-human options`,
      );
    } else {
      assert.equal(block.options.length, planned.options, `${planned.label}: exact hard-human option count`);
    }
  } else {
    assert.ok(block.options.length >= 2, `${planned.label}: decision offers at least two options`);
  }
  if (planned.options === 2) {
    const options = block.options.join(' ');
    assert.match(options, /continue/iu, `${planned.label}: offers approve_continue`);
    assert.match(options, /change/iu, `${planned.label}: offers request_changes`);
  }
  if (planned.options === 3) {
    const options = block.options.join(' ');
    assert.match(options, /continue/iu, `${planned.label}: offers approve_continue`);
    assert.match(options, /change/iu, `${planned.label}: offers request_changes`);
    assert.match(options, /stop/iu, `${planned.label}: offers approve_stop`);
  }
  pending.splice(plannedIndex, 1);

  let nextLegacyFrame = cursor.legacyFrame;
  let nextSelectorFrame = cursor.selectorFrame;
  if (block.surface === 'selector') {
    const target = block.options[Number(planned.answer) - 1];
    assert.ok(target !== undefined, `${planned.label}: selected option index exists`);
    if (planned.feedback !== undefined) {
      await answerSelectedAskWithNote(driver, block, target, planned.feedback);
    } else {
      await answerSelectedAsk(driver, block, target);
    }
    nextSelectorFrame = block.frameStart;
  } else {
    await sendLine(driver, planned.answer);
    nextLegacyFrame = block.frameStart;
    if (planned.feedback !== undefined) await sendLine(driver, feedback);
  }
  return { legacyFrame: nextLegacyFrame, selectorFrame: nextSelectorFrame };
}

function prepareRuntimeFixture(parent: string): ScratchRepositoryResult {
  const repository = createScratchSpecificationRepository({
    workdir: parent,
    slug: 'cto-preparation',
    runtime: true,
    // No constitution, bundles, or framework metadata: the first feature
    // prerequisite takes the plugin-native constitution path, later feature
    // prerequisites reuse the valid constitution, and the three runs keep
    // their own exact origins.
    extraFiles: [
      {
        path: '.omp/ux-e2e-overlay.json',
        contents: `${JSON.stringify(
          { ask: { timeout: 0 }, terminal: { showProgress: true }, autolearn: { enabled: false }, startup: { setupWizard: false } },
          null,
          2,
        )}\n`,
      },
    ],
    git: { init: true, branch: 'main', commit: true, message: 'Initial CTO preparation fixture' },
  });
  return repository;
}

test('scenario: spec-cto-preparation declares the multi-feature preparation journey', () => {
  const scenario = loadScenario(SCENARIO_PATH);
  assert.equal(scenario.id, 'spec-cto-preparation');
  assert.doesNotMatch(scenario.task, /omp-cto-slice run=[0-9a-f-]{36}/u);

  const paramsText = JSON.stringify(scenario.params);
  for (const featureId of ALL_FEATURES) {
    assert.match(scenario.task, new RegExp(escapedRegExp(featureId), 'u'), `task names ${featureId}`);
    assert.ok(
      paramsText.includes(featureId) || scenario.task.includes(featureId),
      `scenario declares ${featureId} as a parameter or task input`,
    );
  }
  assert.ok(typeof scenario.params.beta_revision_feedback === 'string', 'scenario carries the revision feedback');
  assert.ok(typeof scenario.params.overflow_request === 'string', 'scenario carries the overflow request');
  assert.match(scenario.task, /\bcto\b/iu, 'task addresses the resident CTO');
  assert.match(scenario.task, /facet/iu, 'task declares the faceted feature');
  assert.match(scenario.task, new RegExp(escapedRegExp(FACET_A)), 'task names facet-a');
  assert.match(scenario.task, new RegExp(escapedRegExp(FACET_B)), 'task names facet-b');
  assert.match(scenario.task, /independent/iu, 'task declares the independent features');
  assert.match(scenario.task, /separate|per[- ]feature|per[- ]workspace/iu, 'task requires per-workspace decisions');
  assert.match(scenario.task, /queue|serial/iu, 'task requires visible queue or serialization reasons');
  assert.match(
    scenario.task,
    /hard[ -]?stop|without implementation|no implementation|do not (start|run|dispatch) implementation/iu,
    'task requires the hard stop before execution',
  );
  assert.match(scenario.task, /implementation[- ]ready|handoff/iu, 'task requires implementation-ready handoffs');

  assert.ok(scenario.stages.length >= 3, 'the journey declares at least three stages');
  const expanded = (value: string): string => expandTemplate(value, scenario.params);
  const journey = scenario.stages
    .map((stage) => `${stage.id} ${stage.name} ${(stage.expect ?? []).map(expanded).join(' ')}`)
    .join('\n');
  for (const featureId of ALL_FEATURES) {
    assert.match(journey, new RegExp(escapedRegExp(featureId), 'u'), `stages cover ${featureId}`);
  }
  for (const phase of ['constitution', 'specify', 'plan', 'tasks']) {
    assert.match(journey, new RegExp(phase, 'iu'), `stages cover the ${phase} phase`);
  }
  assert.match(journey, /one (resident|phase writer)|no nested cto/iu, 'stages pin the single-resident-CTO invariant');

  const answers = scenario.stages.flatMap((stage) => (stage.ask_user ?? []).map((ask) => ask.answer));
  for (const answer of ['1', '2', '3']) {
    assert.ok(answers.includes(answer), `mixed decisions include answer ${answer}`);
  }
});

test('cto preparation runtime: two independent features and two facets of one feature reach implementation-ready handoffs with a hard stop', async () => {
  const parent = mkdtempSync(join(tmpdir(), 'omp-spec-cto-preparation-e2e-'));
  const { root } = prepareRuntimeFixture(parent);
  let testFailureObserved = false;
  let session: TestSession | undefined;
  let driver: WsDriver | undefined;
  try {
    assertNoExternalFramework(root);
    assert.equal(existsSync(join(root, 'CONSTITUTION.md')), false, 'fixture starts without a constitution');

    const scenario: ScenarioDefinition = loadScenario(SCENARIO_PATH);
  const revisionFeedback = String(scenario.params.beta_revision_feedback ?? '');
  const overflowRequest = String(scenario.params.overflow_request ?? '');
  session = await startTestSession({
    cwd: root,
    surface: 'text',
    cols: 120,
    rows: 40,
    maxTimeSec: 3600,
    idleMs: 3_600_000,
    taskPrompt: scenario.task,
    scenario: { id: scenario.id, title: scenario.title },
  });
  if (session.pty.mode !== 'pty') {
    await session.close();
    throw new Error('cto preparation runtime unavailable: node-pty or the omp binary could not create a PTY');
  }

  driver = new WsDriver({ url: session.url, transcriptPath: session.transcriptPath });
  const log = new TranscriptLog(session.transcriptPath);
  await driver.open();
  await waitForOmpTuiReady(driver);
  await waitForOutput(driver, /(?:omp|ready|>)/iu, 'OMP startup', scenario.timing.startupTimeoutMs);

  // The preparation request enters through the resident CTO; the wave below
  // answers every checkpoint synchronously as its turn surfaces.
  await sendLine(driver, `/cto ${REQUEST}`);
  const pending = [...DECISIONS];
  let cursor: CheckpointCursor = { legacyFrame: 0, selectorFrame: 0 };
  while (pending.length > 0) {
    cursor = await answerNextCheckpoint(driver, log, pending, revisionFeedback, cursor);
  }

  // The plugin-native constitution materialized once for the whole run.
  await waitForMarkdown(join(root, 'CONSTITUTION.md'), [/^#\s+Project Constitution/imu, /##\s+/u], 'native constitution draft');

  // Independent progress: the request-changes loop on one feature must not
  // block or restart the others; every feature keeps its own run identity.
  const identities: Record<string, WorkspaceIdentity> = {};
  for (const featureId of ALL_FEATURES) {
    identities[featureId] = readWorkspaceIdentity(root, featureId);
    assert.ok(identities[featureId]?.runKey.length > 0, `${featureId}: run_key is non-empty`);
  }
  const runKeys = ALL_FEATURES.map((featureId) => identities[featureId]?.runKey ?? '');
  assert.equal(new Set(runKeys).size, ALL_FEATURES.length, 'the three features carry distinct explicit run identities');

  // Per-feature readable evidence and implementation-ready handoffs.
  for (const featureId of ALL_FEATURES) {
    const identity = identities[featureId];
    assert.ok(identity !== undefined);
    assertWorkerAttribution(root, featureId);
    const status = await waitForMarkdown(
      join(root, 'specs', featureId, 'status.md'),
      [
        /Phase Status/iu,
        /Approvals/iu,
        /Next Action/iu,
        /implementation[-_ ]?ready/iu,
        new RegExp(`/do-work\\s+--spec\\s+${escapedRegExp(featureId)}`, 'iu'),
      ],
      `${featureId} final status and exact handoff action`,
    );
    assert.match(status, new RegExp(`/do-work\\s+--spec\\s+${escapedRegExp(featureId)}`, 'iu'));
    const handoff = await waitForMarkdown(
      join(root, 'specs', featureId, 'handoff.md'),
      [/handoff/iu, new RegExp(escapedRegExp(featureId), 'u'), /ready/iu, /do-work/iu],
      `${featureId} readable implementation handoff`,
    );
    assert.match(handoff, new RegExp(escapedRegExp(featureId), 'u'));
    assert.equal(
      identity.executionClaimRef ?? null,
      null,
      `${featureId}: preparation acquires no execution claim`,
    );
    assert.ok(identity.handoffRef !== null && identity.handoffRef !== undefined, `${featureId}: handoff is bound`);
  }

  // Mixed decisions recorded separately per workspace: the revision loop is
  // contained to borealis, whose Specify v1 stays archived under history/.
  const borealisText = workspaceText(root, INDEPENDENT_B);
  assert.match(borealisText, /request_changes/u, 'borealis records its own request_changes decision');
  assert.match(
    borealisText,
    new RegExp(escapedRegExp(revisionFeedback.slice(0, 24))),
    'borealis binds the revision feedback',
  );
  assert.match(borealisText, /approve_stop/u, 'borealis records its own approve_stop decision');
  const borealisState = JSON.parse(readTextFile(join(root, '.work-state', 'features', INDEPENDENT_B, 'state.json'))) as {
    typed_checkpoint_decisions?: Array<{ decision?: unknown; rationale?: unknown; actor?: { proof?: { feedback?: unknown } } }>;
    trusted_checkpoint_answers?: Array<{ decision?: unknown; feedback?: unknown }>;
  };
  const revisionDecision = borealisState.typed_checkpoint_decisions?.find((decision) => decision.decision === 'request_changes');
  assert.ok(revisionDecision !== undefined, 'borealis persists the request_changes typed decision');
  assert.equal(revisionDecision?.rationale, revisionFeedback, 'borealis preserves exact n-note bytes as rationale');
  assert.equal(revisionDecision?.actor?.proof?.feedback, revisionFeedback, 'borealis proof preserves exact n-note bytes');
  const revisionAnswers = (borealisState.trusted_checkpoint_answers ?? []).filter((answer) => answer.decision === 'request_changes');
  assert.equal(revisionAnswers.length, 1, 'borealis persists exactly one request_changes trusted answer');
  assert.equal(revisionAnswers[0]?.feedback, revisionFeedback, 'borealis trusted-answer ledger preserves exact feedback');
  const borealisHistory = filesBelow(join(root, 'specs', INDEPENDENT_B, 'history'));
  assert.ok(
    borealisHistory.some((path) => path.endsWith('.md')),
    'borealis archives the replaced Specify revision under history/',
  );

  // Facet convergence: one workspace for the faceted feature, both facets
  // represented, and the blocked facet slice reported with durable state.
  const facetedSiblings = filesBelow(join(root, 'specs')).filter((path) =>
    /specs[/\\]prep-meridian[-_]/u.test(path),
  );
  assert.equal(facetedSiblings.length, 0, 'facets never split into sibling workspaces');
  const meridianText = workspaceText(root, FACETED);
  assert.match(meridianText, new RegExp(escapedRegExp(FACET_A)), 'meridian workspace carries facet-a');
  assert.match(meridianText, new RegExp(escapedRegExp(FACET_B)), 'meridian workspace carries facet-b');
  const coordination = coordinationText(root, log);
  const blockedRecord = coordination
    .split('\n')
    .find((line) => /facet-b/iu.test(line) && /block/iu.test(line) && /resume|state|review/iu.test(line));
  assert.ok(blockedRecord !== undefined, 'a visible record names facet-b blocked with targeted-resume state');

  // Overflow work is queued with visible reasons instead of nesting a CTO.
  assert.ok(
    coordination.includes(overflowRequest) || /overflow/iu.test(coordination),
    'the queued overflow request is identifiable in coordination evidence',
  );
  const queueReasonRecord = coordination
    .split('\n')
    .find((line) =>
      /overflow|queued/iu.test(line) &&
      /team[ -_]?cap|decomposition[ -_]?depth|capacity|ownership|active[-_ ]?phase/iu.test(line),
    );
  assert.ok(queueReasonRecord !== undefined, 'the queue record names its capacity/depth/ownership/active-phase reason');

  // One readable review packet fans in all three workspaces without merging
  // their decisions: the packet names every feature and the decision split.
  for (const featureId of ALL_FEATURES) {
    assert.match(coordination, new RegExp(escapedRegExp(featureId), 'u'), `coordination evidence names ${featureId}`);
  }
  assert.match(coordination, /review/iu, 'coordination evidence includes the readable review packet');
  assert.match(coordination, /approve_continue/iu, 'coordination evidence records approve_continue decisions');
  assert.match(coordination, /approve_stop/iu, 'coordination evidence records approve_stop decisions');
  assert.match(coordination, /request_changes/iu, 'coordination evidence records request_changes decisions');

  // Hard stop: final Tasks approvals ended the preparation wave. No
  // implementation dispatch, no /do-work input, no second CTO authority —
  // execution requires a separate explicit wave.
  log.refresh();
  const frames = log.frames.flatMap((frame) => (frame.t === 'i' ? [frame.d] : []));
  assert.equal(
    frames.filter((frame) => frame.trim().startsWith('/cto ')).length,
    1,
    'exactly one resident CTO run was started, by this test',
  );
  assert.equal(
    frames.filter((frame) => /\/do-work\s+--spec/iu.test(frame)).length,
    0,
    'no /do-work --spec command is ever typed: the handoff action stays a displayed next action',
  );
  const hardHumanCheckpoints = new Map<number, CheckpointBlock>();
  for (const checkpoint of [
    ...log.askBlocks().filter((ask) => ask.options.length > 0),
    ...log.selectedAskBlocks().filter((ask) => ask.options.length > 0),
  ]) {
    hardHumanCheckpoints.set(checkpoint.frameStart, checkpoint);
  }
  assert.equal(
    hardHumanCheckpoints.size,
    DECISIONS.length,
    'exactly the planned hard-human checkpoints were presented, with no extra decision authority',
  );
  const feedbackSubmissionFrames = log.frames.filter((frame) =>
    frame.t === 'i' && DECISIONS.some((decision) => decision.feedback !== undefined && frame.d === decision.feedback),
  );
  assert.equal(
    feedbackSubmissionFrames.length,
    1,
    'exactly one trusted n-note submission backs the request_changes decision',
  );
  await waitForOutput(
    driver,
    /(preparation|wave)[^\n]{0,120}(complete|end|ended|ready)|handoff[^\n]{0,80}ready|separate[^\n]{0,80}execution/iu,
    'CTO closes the preparation wave and names the separate execution requirement',
  );
  assertNoExternalFramework(root);
  } catch (error) {
    testFailureObserved = true;
    throw error;
  } finally {
    let lifecycleFailureObserved = false;
    let lifecycleError: unknown;
    try {
      await driver?.close();
      await session?.close();
    } catch (error) {
      lifecycleFailureObserved = true;
      lifecycleError = error;
    }
    finalizeScratchDirectory(parent, {
      preserveOnFailure: PRESERVE_ON_FAILURE,
      testFailed: testFailureObserved,
      lifecycleFailed: lifecycleFailureObserved,
    });
    if (!testFailureObserved && lifecycleFailureObserved) throw lifecycleError;
  }
});
