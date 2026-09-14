/**
 * T081 — real-runtime two-language and project-template contract (US6).
 *
 *
 * FAILING-FIRST RUNTIME CONTRACT (TDD wave, tasks.md T081): these tests drive
 * the REAL omp PTY session (startTestSession + WsDriver, the T025 harness
 * pattern) against a scratch repository and pin the observable language and
 * template behavior that T082–T085 must expose at runtime. No command
 * execution is mocked or stubbed: every assertion reads real session output
 * (transcript/screen) or real workspace files (specs/<id>/, state.json,
 * validation projections, phase artifact envelopes).
 *
 * Until the runtime consumes the landed resolvers
 * (`packages/core/src/specification/language.ts` T082,
 * `packages/core/src/specification/templates.ts` T083) and binds/renders the
 * selection (T084 phase binding, T085 materialize visibility), these tests
 * fail on the recorded initial state
 * (.work-state/artifacts/sdd-evolution/T081.json): workspaces are still
 * created with the en-US project_default fallback and status materialization
 * carries no language/template provenance.
 *
 * Runtime surfaces pinned here (spec.md US6 scenarios 1–3, FR-018–FR-020,
 * contracts/command-contract.md "Template Provider"):
 *
 * - Language selection precedence is observable at runtime: with no project
 *   configuration, the initiating request's language is selected and recorded
 *   as `source: "request_language"`; with a project default configured, the
 *   project default wins over the request language. The recorded
 *   `selection_hash` binds normalized language and provenance exactly as the
 *   shipped resolver defines it: sha256("language=<tag>\nsource=<source>").
 * - Selected language applies to generated prose across phase documents and
 *   the implementation handoff while technical identifiers (feature ids,
 *   command lines, workspace paths) and stable semantic section markers
 *   (`<!-- omp-spec:marker:... -->`) remain unchanged.
 * - Workflow-owner project configuration is read from `.omp/specification.json`
 *   (the canonical `.omp/*.json` project-configuration convention:
 *   team.config.json, teams.json, escalation.json) at every phase start:
 *
 *     {
 *       "language": "ru-RU",
 *       "templates": { "specify": ".omp/specification/templates/specify.md" }
 *     }
 *
 *   `templates` values are project-relative template files keyed by the
 *   shipped template ids. A valid override wins over the shipped baseline
 *   (`template_set.source === "project_default"`), its localized presentation
 *   reaches the materialized document, and the mandatory marker/validation/
 *   checkpoint contract is still enforced (localization never removes
 *   required content).
 * - A project template override that omits the stable semantic markers is
 *   rejected BEFORE any worker dispatch: the command reports an actionable
 *   marker/template diagnostic, presents no phase checkpoint, materializes no
 *   document, and leaves already-approved workspaces untouched.
 */

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  createScratchSpecificationRepository,
  type ScratchRepositoryResult,
} from '../src/specification-fixtures.js';
import {
  answerSelectedAsk,
  matchesCanonicalSelectorOptions,
  type SelectedAskBlock,
  TranscriptLog,
  waitFor,
  waitForOmpTuiReady,
  WsDriver,
} from '../src/driver.js';
import {
  startTestSession,
  type TestSession,
} from '../src/server.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const WAIT_TIMEOUT_MS = 150_000;
// Native phases allow 600s plus 30s receipt grace; retain an extra 30s margin.
const PHASE_CHECKPOINT_WAIT_TIMEOUT_MS = 660_000;
const PRESERVE_ON_FAILURE = /^(?:1|true|yes)$/iu.test(process.env["OMP_UX_E2E_PRESERVE_ON_FAILURE"] ?? "");

const CONSTITUTION_SELECTOR_OPTIONS = ['approve_continue', 'request_changes'] as const;
const PHASE_SELECTOR_OPTIONS = ['approve_continue', 'request_changes', 'approve_stop'] as const;

const FEATURE_EN = 'locale-alpha';
const FEATURE_RU = 'locale-beta';
const FEATURE_PROJECT = 'template-gamma';
const FEATURE_REJECTED = 'template-delta';

const REQUEST_EN = 'Add a deterministic export ledger with explicit ownership';
const REQUEST_RU = 'Добавить детерминированный журнал экспорта с явным владением состоянием';

const PROJECT_LANGUAGE = 'ru-RU';
const PROJECT_TEMPLATE_ID = 'specification-default';
const PROJECT_CONFIG_PATH = '.omp/specification.json';
const PROJECT_TEMPLATE_PATH = '.omp/specification/templates/specify.md';
const PROJECT_TEMPLATE_BROKEN_PATH = '.omp/specification/templates/specify-broken.md';

const SPECIFY_MARKERS = ['problem', 'requirements', 'scope', 'success_criteria'] as const;

/** Localized project specify override: shipped template shape, German presentation. */
function projectSpecifyTemplate(): string {
  return [
    '<!-- omp-spec:marker:problem -->',
    '## Ausgangslage',
    '',
    '{{PROBLEM}}',
    '',
    '<!-- omp-spec:marker:requirements -->',
    '## Anforderungen',
    '',
    '{{REQUIREMENTS}}',
    '',
    '<!-- omp-spec:marker:scope -->',
    '## Umfang',
    '',
    '{{SCOPE}}',
    '',
    '<!-- omp-spec:marker:success_criteria -->',
    '## Erfolgskriterien',
    '',
    '{{SUCCESS_CRITERIA}}',
    '',
  ].join('\n');
}

/** Marker-less variant: localized presentation without the stable contract. */
function projectSpecifyTemplateWithoutMarkers(): string {
  return projectSpecifyTemplate()
    .split('\n')
    .filter((line) => !line.startsWith('<!-- omp-spec:marker:'))
    .join('\n');
}

function sha256Hex(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/** Exact provenance digest formula shipped by the T082 language resolver. */
function expectedSelectionHash(language: string, source: string): string {
  return sha256Hex(`language=${language}\nsource=${source}`);
}

function escapedRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

function cyrillicRuns(text: string): number {
  return text.match(/\p{Script=Cyrillic}+/gu)?.length ?? 0;
}

/** Bounded-token presence: 'en' must not match inside 'generated'. */
function includesSelectionValue(text: string, value: string): boolean {
  return new RegExp(`(^|[^0-9A-Za-z-])${escapedRegExp(value)}([^0-9A-Za-z-]|$)`, 'u').test(text);
}

async function sendLine(driver: WsDriver, line: string): Promise<void> {
  await driver.type(line);
  await driver.pressEnter();
}

async function waitForOutput(driver: WsDriver, pattern: RegExp, label: string, timeoutMs = WAIT_TIMEOUT_MS): Promise<string> {
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

async function waitForCheckpoint(
  driver: WsDriver,
  log: TranscriptLog,
  phase: string,
  expectedOptions: readonly string[],
  minimumIndex: number,
  label: string,
  timeoutMs = WAIT_TIMEOUT_MS,
): Promise<SelectedAskBlock> {
  let found: SelectedAskBlock | undefined;
  await waitFor(
    async () => {
      const screen = await driver.readScreen();
      const blocks = log.selectedAskBlocks();
      const pendingIndexes = new Set(log.pendingSelectedAskBlocks().map((block) => block.index));
      const candidates = blocks.filter((block) =>
        pendingIndexes.has(block.index)
        && block.index >= minimumIndex
        && new RegExp(phase, 'iu').test(screen + '\n' + block.title)
        && matchesCanonicalSelectorOptions(block.options, expectedOptions),
      );
      found = candidates.at(-1);
      return found !== undefined;
    },
    { timeoutMs, intervalMs: 100, label },
  );
  assert.ok(found, `${label}: pending selected checkpoint was not observed`);
  assert.ok(
    matchesCanonicalSelectorOptions(found.options, expectedOptions),
    `${label}: selector exposes the canonical decisions (plus the host Other option)`,
  );
  return found;
}

async function answerCheckpoint(
  driver: WsDriver,
  block: SelectedAskBlock,
  answer: string,
): Promise<void> {
  const option = block.options[Number(answer) - 1];
  assert.ok(option !== undefined, `selected checkpoint answer ${answer} is in range`);
  await answerSelectedAsk(driver, block, option);
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

interface PersistedSpecificationState {
  run_key: string;
  pause?: { kind?: unknown };
  specification: {
    feature_id?: unknown;
    language?: { language?: unknown; source?: unknown; selection_hash?: unknown };
    template_set?: { template_set_id?: unknown; source?: unknown; content_hash?: unknown; required_markers?: unknown };
    phases?: Array<{ phase?: unknown; status?: unknown; current_version?: unknown; approved_version?: unknown }>;
    next_action?: unknown;
  };
}

/** Read and sanity-check the persisted feature aggregate for one feature. */
function readState(root: string, featureId: string): PersistedSpecificationState {
  const statePath = join(root, '.work-state', 'features', featureId, 'state.json');
  assert.ok(existsSync(statePath), `canonical feature state is persisted for ${featureId}`);
  const state = JSON.parse(readFileSync(statePath, 'utf8')) as PersistedSpecificationState;
  assert.equal(typeof state.run_key, 'string', `${featureId}: state carries an explicit run_key`);
  assert.equal(state.specification?.feature_id, featureId, `${featureId}: state carries the selected feature_id`);
  return state;
}

function phaseRecord(state: PersistedSpecificationState, phase: string): { status?: unknown; current_version?: unknown; approved_version?: unknown } {
  const record = state.specification.phases?.find((candidate) => candidate.phase === phase);
  assert.ok(record, `${state.specification.feature_id}: ${phase} phase record exists`);
  return record;
}

function assertAwaitingApproval(state: PersistedSpecificationState, phase: string): void { const record = phaseRecord(state, phase); assert.equal(record.status, "awaiting_approval", state.specification.feature_id + ": " + phase + " is awaiting the human checkpoint"); assert.equal(record.current_version, 1, state.specification.feature_id + ": " + phase + " carries generated version 1"); assert.equal(record.approved_version ?? null, null, state.specification.feature_id + ": " + phase + " is not approved before the answer"); assert.equal(state.pause?.kind, "user_checkpoint", state.specification.feature_id + ": durable state records the open user checkpoint"); }
async function waitForApprovedPhase(root: string, featureId: string, phase: string, label: string): Promise<PersistedSpecificationState> { let approved: PersistedSpecificationState | undefined; await waitFor(() => { try { const state = readState(root, featureId); const record = phaseRecord(state, phase); if (typeof record.approved_version !== "number") return false; approved = state; return true; } catch { return false; } }, { timeoutMs: WAIT_TIMEOUT_MS, intervalMs: 100, label }); assert.ok(approved, label + ": durable approved state was not observed"); return approved; }
function assertApprovedPhase(state: PersistedSpecificationState, phase: string): void {
  const record = phaseRecord(state, phase);
  assert.equal(typeof record.approved_version, 'number', `${state.specification.feature_id}: ${phase} carries an explicit human approval`);
  assert.ok((record.approved_version as number) >= 1, `${state.specification.feature_id}: approved ${phase} version is at least v1`);
}

function inputFrames(log: TranscriptLog): string[] {
  log.refresh();
  return log.frames.flatMap((frame) => (frame.t === 'i' ? [frame.d] : []));
}


interface RuntimeFixtureOptions {
  /** When set, `.omp/specification.json` pins this project specify override. */
  readonly projectTemplatePath?: string;
}

function prepareRuntimeFixture(parent: string, options: RuntimeFixtureOptions = {}): ScratchRepositoryResult {
  const extraFiles: Array<{ path: string; contents: string }> = [
    {
      path: '.omp/ux-e2e-overlay.json',
      contents: `${JSON.stringify(
        { ask: { timeout: 0 }, terminal: { showProgress: true }, autolearn: { enabled: false }, startup: { setupWizard: false } },
        null,
        2,
      )}\n`,
    },
  ];
  if (options.projectTemplatePath !== undefined) {
    extraFiles.push(
      { path: PROJECT_TEMPLATE_PATH, contents: projectSpecifyTemplate() },
      { path: PROJECT_TEMPLATE_BROKEN_PATH, contents: projectSpecifyTemplateWithoutMarkers() },
      {
        path: PROJECT_CONFIG_PATH,
        contents: `${JSON.stringify(
          { language: PROJECT_LANGUAGE, templates: { specify: options.projectTemplatePath } },
          null,
          2,
        )}\n`,
      },
    );
  }
  return createScratchSpecificationRepository({
    workdir: parent,
    slug: 'language-template',
    runtime: true,
    // No constitution, bundles, or framework metadata: the first command takes
    // the plugin-native constitution path in a clean git repository.
    extraFiles,
    git: { init: true, branch: 'main', commit: true, message: 'Initial language/template fixture' },
  });
}

interface StartedRuntime {
  readonly session: TestSession;
  readonly driver: WsDriver;
  readonly log: TranscriptLog;
}

async function startRuntime(
  root: string,
  taskPrompt: string,
): Promise<StartedRuntime> {
  const session = await startTestSession({
    cwd: root,
    surface: 'text',
    cols: 120,
    rows: 40,
    maxTimeSec: 1500,
    idleMs: 900_000,
    taskPrompt,
    scenario: { id: 'spec-language-template', title: 'Language and template runtime contract' },
  });
  if (session.pty.mode !== 'pty') {
    await session.close();
    throw new Error('node-pty or the omp binary could not create a PTY');
  }
  const driver = new WsDriver({ url: session.url, transcriptPath: session.transcriptPath });
  const log = new TranscriptLog(session.transcriptPath);
  await driver.open();
  await waitForOmpTuiReady(driver);
  await waitForOutput(driver, /(?:omp|ready|>)/iu, 'OMP startup', WAIT_TIMEOUT_MS);
  return { session, driver, log };
}

test('two-language runtime: request-language provenance localizes prose while the phase contract stays complete', async (t) => {
  const parent = mkdtempSync(join(tmpdir(), 'omp-spec-lang-e2e-'));
  const { root } = prepareRuntimeFixture(parent);
  assert.equal(existsSync(join(root, PROJECT_CONFIG_PATH)), false, 'no project configuration exists in the two-language fixture');

  let runtime: StartedRuntime | undefined;
  let completed = false;
  t.after(async () => {
    if (runtime) await runtime.driver.close();
    if (runtime) await runtime.session.close();
    if (!PRESERVE_ON_FAILURE || completed) rmSync(parent, { recursive: true, force: true });
  });
  runtime = await startRuntime(
    root,
    'Exercise the native specification workflow in two languages. Use explicit --feature selectors for every command and never create or rely on implicit active-feature selection.',
  );
  assert.ok(runtime !== undefined);
  const { driver, log } = runtime;

  // ── English feature: initiating request language is selected and recorded ──
  await sendLine(driver, `/specify --feature ${FEATURE_EN} ${REQUEST_EN}`);
  const constitutionAsk = await waitForCheckpoint(driver, log, 'constitution', CONSTITUTION_SELECTOR_OPTIONS, 1, 'constitution checkpoint');
  assert.match(constitutionAsk.options.join(' '), /continue/iu, 'constitution checkpoint offers approve_continue');
  await answerCheckpoint(driver, constitutionAsk, '1');
  await waitForMarkdown(join(root, 'CONSTITUTION.md'), [/^#\s+Project Constitution/imu, /##\s+/u], 'native constitution draft');

  const alphaAsk = await waitForCheckpoint(driver, log, 'Specify', PHASE_SELECTOR_OPTIONS, constitutionAsk.index + 1, 'English Specify checkpoint', PHASE_CHECKPOINT_WAIT_TIMEOUT_MS);
  const alphaState = readState(root, FEATURE_EN);
  const alphaLanguage = alphaState.specification.language;
  assert.equal(alphaLanguage?.source, 'request_language', 'English request selects the request language layer');
  assert.match(String(alphaLanguage?.language), /^en(?=$|[-_.])/iu, 'English request resolves an English language tag');
  assert.equal(
    alphaLanguage?.selection_hash,
    expectedSelectionHash(String(alphaLanguage?.language), 'request_language'),
    'selection hash binds normalized language and provenance source',
  );
  assert.equal(alphaState.specification.template_set?.source, 'shipped_default', 'no project configuration keeps the shipped template baseline');
  const runKeyAlpha = alphaState.run_key;
  const alphaSpec = await waitForMarkdown(
    join(root, 'specs', FEATURE_EN, 'spec.md'),
    [
      new RegExp(`Feature:\\s*${escapedRegExp(FEATURE_EN)}`, 'u'),
      new RegExp(`Run:\\s*${escapedRegExp(runKeyAlpha)}`, 'u'),
      /^##\s+Problem/imu,
      /^##\s+Requirements/imu,
      /^##\s+Scope/imu,
      /^##\s+Success Criteria/imu,
    ],
    'English Specify document',
  );
  assert.equal(cyrillicRuns(alphaSpec), 0, 'English-selected prose contains no other-language script');
  assert.ok(existsSync(join(root, 'specs', FEATURE_EN, 'validation', 'specify.md')), 'English Specify validation projection is materialized');
  assertAwaitingApproval(alphaState, 'specify');
  await answerCheckpoint(driver, alphaAsk, '3');
  const alphaApprovedState = await waitForApprovedPhase(root, FEATURE_EN, 'specify', 'English Specify approval');
  assertApprovedPhase(alphaApprovedState, 'specify');
  const alphaStatus = await waitForMarkdown(
    join(root, 'specs', FEATURE_EN, 'status.md'),
    [/Phase Status/iu, /Approvals/iu, /Next Action/iu, new RegExp(`/spec-plan\\s+--feature\\s+${escapedRegExp(FEATURE_EN)}`, 'iu')],
    'English Specify exact next action',
  );
  assert.ok(includesSelectionValue(alphaStatus, String(alphaLanguage?.language)), 'status materialization shows the selected language');
  assert.ok(includesSelectionValue(alphaStatus, 'request_language'), 'status materialization shows the language provenance source');

  // ── Russian feature: second workspace, independent language selection ──
  await sendLine(driver, `/specify --feature ${FEATURE_RU} ${REQUEST_RU}`);
  const betaAsk = await waitForCheckpoint(driver, log, 'Specify', PHASE_SELECTOR_OPTIONS, alphaAsk.index + 1, 'Russian Specify checkpoint', PHASE_CHECKPOINT_WAIT_TIMEOUT_MS);
  const betaState = readState(root, FEATURE_RU);
  const betaLanguage = betaState.specification.language;
  assert.equal(betaLanguage?.source, 'request_language', 'Russian request selects the request language layer');
  assert.match(String(betaLanguage?.language), /^ru(?=$|[-_.])/iu, 'Russian request resolves a Russian language tag');
  assert.notEqual(
    betaLanguage?.selection_hash,
    alphaLanguage?.selection_hash,
    'the two features carry independent language selections',
  );
  assert.equal(betaState.specification.template_set?.source, 'shipped_default', 'shipped template baseline applies to the second feature');
  const runKeyBeta = betaState.run_key;
  const betaSpec = await waitForMarkdown(
    join(root, 'specs', FEATURE_RU, 'spec.md'),
    [
      new RegExp(`Feature:\\s*${escapedRegExp(FEATURE_RU)}`, 'u'),
      new RegExp(`Run:\\s*${escapedRegExp(runKeyBeta)}`, 'u'),
      /<!--\s*omp-spec:marker:problem\s*-->/u,
      /<!--\s*omp-spec:marker:requirements\s*-->/u,
      /<!--\s*omp-spec:marker:scope\s*-->/u,
      /<!--\s*omp-spec:marker:success_criteria\s*-->/u,
    ],
    'Russian Specify document with stable semantic markers',
  );
  assert.ok(cyrillicRuns(betaSpec) >= 8, 'Specify prose follows the selected Russian language');
  for (const identifier of [FEATURE_RU, `specs/${FEATURE_RU}`, `/spec-plan --feature ${FEATURE_RU}`]) {
    assert.ok(betaSpec.includes(identifier), `technical identifier stays unchanged: ${identifier}`);
  }
  assert.ok(existsSync(join(root, 'specs', FEATURE_RU, 'validation', 'specify.md')), 'Russian Specify validation projection is materialized');
  assertAwaitingApproval(betaState, 'specify');
  await answerCheckpoint(driver, betaAsk, '3');
  const betaApprovedState = await waitForApprovedPhase(root, FEATURE_RU, 'specify', 'Russian Specify approval');
  assertApprovedPhase(betaApprovedState, 'specify');

  // ── Russian feature completes Plan -> Tasks: contract survives localization ──
  await sendLine(driver, `/spec-plan --feature ${FEATURE_RU}`);
  const betaPlanAsk = await waitForCheckpoint(driver, log, 'Plan', PHASE_SELECTOR_OPTIONS, betaAsk.index + 1, 'Russian Plan checkpoint', PHASE_CHECKPOINT_WAIT_TIMEOUT_MS);
  const betaPlan = await waitForMarkdown(
    join(root, 'specs', FEATURE_RU, 'plan.md'),
    [
      /<!--\s*omp-spec:marker:decisions\s*-->/u,
      /<!--\s*omp-spec:marker:alternatives\s*-->/u,
      /<!--\s*omp-spec:marker:architecture\s*-->/u,
      /<!--\s*omp-spec:marker:verification_strategy\s*-->/u,
    ],
    'Russian Plan document with stable semantic markers',
  );
  assert.ok(cyrillicRuns(betaPlan) >= 5, 'Plan prose follows the selected Russian language');
  await answerCheckpoint(driver, betaPlanAsk, '1');
  await sendLine(driver, `/spec-tasks --feature ${FEATURE_RU}`);
  const betaTasksAsk = await waitForCheckpoint(driver, log, 'Tasks', PHASE_SELECTOR_OPTIONS, betaPlanAsk.index + 1, 'Russian Tasks checkpoint', PHASE_CHECKPOINT_WAIT_TIMEOUT_MS);
  const betaTasks = await waitForMarkdown(
    join(root, 'specs', FEATURE_RU, 'tasks.md'),
    [
      /<!--\s*omp-spec:marker:task_graph\s*-->/u,
      /<!--\s*omp-spec:marker:dependencies\s*-->/u,
      /<!--\s*omp-spec:marker:expected_outcomes\s*-->/u,
    ],
    'Russian Tasks document with stable semantic markers',
  );
  assert.ok(cyrillicRuns(betaTasks) >= 5, 'Tasks prose follows the selected Russian language');
  await answerCheckpoint(driver, betaTasksAsk, '3');

  const betaFinalStatus = await waitForMarkdown(
    join(root, 'specs', FEATURE_RU, 'status.md'),
    [
      /Phase Status/iu,
      /Approvals/iu,
      /Next Action/iu,
      /implementation[_ ]ready/iu,
      new RegExp(`/do-work\\s+--spec\\s+${escapedRegExp(FEATURE_RU)}`, 'iu'),
    ],
    'Russian final status and exact handoff action',
  );
  assert.ok(includesSelectionValue(betaFinalStatus, String(betaLanguage?.language)), 'final status shows the selected language');
  assert.ok(includesSelectionValue(betaFinalStatus, 'request_language'), 'final status shows the language provenance source');
  const betaTemplateSet = betaState.specification.template_set;
  assert.equal(betaTemplateSet?.template_set_id, PROJECT_TEMPLATE_ID, 'template selection carries the stable set id');
  assert.match(String(betaTemplateSet?.content_hash), /^[0-9a-f]{64}$/u, 'template selection carries a content digest');
  assert.ok(includesSelectionValue(betaFinalStatus, String(betaTemplateSet?.template_set_id)), 'final status shows the template id');
  assert.ok(includesSelectionValue(betaFinalStatus, String(betaTemplateSet?.content_hash)), 'final status shows the template hash');
  const handoff = await waitForMarkdown(
    join(root, 'specs', FEATURE_RU, 'handoff.md'),
    [/handoff/iu, /ready/iu, new RegExp(escapedRegExp(FEATURE_RU), 'u'), /do-work/iu],
    'Russian implementation handoff',
  );
  assert.ok(includesSelectionValue(handoff, String(betaLanguage?.language)), 'handoff summary shows the selected language');
  assert.ok(cyrillicRuns(handoff) >= 2, 'handoff summary prose follows the selected Russian language');

  const betaStateFinal = readState(root, FEATURE_RU);
  assert.equal(betaStateFinal.run_key, runKeyBeta, 'run_key remains stable through the localized journey');
  for (const phase of ['specify', 'plan', 'tasks'] as const) {
    assertApprovedPhase(betaStateFinal, phase);
    assert.ok(
      existsSync(join(root, 'specs', FEATURE_RU, 'validation', `${phase}.md`)),
      `${phase} validation projection is materialized for the localized workspace`,
    );
  }
  await waitFor(
    () => filesBelow(join(root, 'specs', FEATURE_RU, 'history')).some((path) => path.endsWith('.md')),
    { timeoutMs: WAIT_TIMEOUT_MS, intervalMs: 100, label: 'localized history revisions' },
  );

  // ── Phase versions bind the selected language and template set ──
  const betaArtifacts = filesBelow(join(root, '.work-state', 'features', FEATURE_RU, 'artifacts'))
    .map((path) => {
      try {
        return readFileSync(path, 'utf8');
      } catch {
        return '';
      }
    })
    .join('\n');
  assert.ok(/"template_hash"\s*:/u.test(betaArtifacts), 'phase versions bind the template hash');
  assert.ok(
    betaArtifacts.includes(String(betaLanguage?.selection_hash)),
    'phase versions bind the selected language provenance digest',
  );

  const frames = inputFrames(log);
  assert.ok(frames.some((frame) => frame.includes(`/specify --feature ${FEATURE_EN}`)), 'English input carries the explicit feature selector');
  assert.ok(frames.some((frame) => frame.includes(`/specify --feature ${FEATURE_RU}`)), 'Russian input carries the explicit feature selector');
  assert.ok(frames.some((frame) => frame.includes(`/spec-plan --feature ${FEATURE_RU}`)), 'Plan input carries the explicit feature selector');
  assert.ok(frames.some((frame) => frame.includes(`/spec-tasks --feature ${FEATURE_RU}`)), 'Tasks input carries the explicit feature selector');
  assert.equal(
    log.selectedAskBlocks().length,
    5,
    'only the constitution and one checkpoint per executed phase were presented',
  );
  completed = true;
});

test('project-template runtime: workflow-owner defaults take precedence and a marker-less template rejects before dispatch', async (t) => {
  const parent = mkdtempSync(join(tmpdir(), 'omp-spec-tmpl-e2e-'));
  const { root } = prepareRuntimeFixture(parent, { projectTemplatePath: PROJECT_TEMPLATE_PATH });

  let runtime: StartedRuntime | undefined;
  let completed = false;
  t.after(async () => {
    if (runtime) await runtime.driver.close();
    if (runtime) await runtime.session.close();
    if (!PRESERVE_ON_FAILURE || completed) rmSync(parent, { recursive: true, force: true });
  });
  runtime = await startRuntime(
    root,
    'Exercise the native specification workflow under project-level language and template defaults. Use explicit --feature selectors for every command and never create or rely on implicit active-feature selection.',
  );
  assert.ok(runtime !== undefined);
  const { driver, log } = runtime;

  // ── Project defaults win: language beats the English request, template beats shipped ──
  await sendLine(driver, `/specify --feature ${FEATURE_PROJECT} ${REQUEST_EN}`);
  const constitutionAsk = await waitForCheckpoint(driver, log, 'constitution', CONSTITUTION_SELECTOR_OPTIONS, 1, 'constitution checkpoint');
  await answerCheckpoint(driver, constitutionAsk, '1');
  await waitForMarkdown(join(root, 'CONSTITUTION.md'), [/^#\s+Project Constitution/imu, /##\s+/u], 'native constitution draft');

  const gammaAsk = await waitForCheckpoint(driver, log, 'Specify', PHASE_SELECTOR_OPTIONS, constitutionAsk.index + 1, 'project-default Specify checkpoint', PHASE_CHECKPOINT_WAIT_TIMEOUT_MS);
  const gammaState = readState(root, FEATURE_PROJECT);
  const gammaLanguage = gammaState.specification.language;
  assert.equal(gammaLanguage?.language, PROJECT_LANGUAGE, 'project default language overrides the initiating request language');
  assert.equal(gammaLanguage?.source, 'project_default', 'project default provenance is recorded');
  assert.equal(
    gammaLanguage?.selection_hash,
    expectedSelectionHash(PROJECT_LANGUAGE, 'project_default'),
    'selection hash binds the project default language and provenance source',
  );
  const gammaTemplateSet = gammaState.specification.template_set;
  assert.equal(gammaTemplateSet?.source, 'project_default', 'project template override wins over the shipped baseline');
  assert.equal(gammaTemplateSet?.template_set_id, PROJECT_TEMPLATE_ID, 'template set id stays stable under a project override');
  assert.match(String(gammaTemplateSet?.content_hash), /^[0-9a-f]{64}$/u, 'project template selection carries a content digest');
  const requiredMarkers = gammaTemplateSet?.required_markers;
  assert.ok(Array.isArray(requiredMarkers), 'template selection enumerates required markers');
  for (const marker of SPECIFY_MARKERS) {
    assert.ok(requiredMarkers.includes(marker), `mandatory marker survives the project override: ${marker}`);
  }

  // The override's localized presentation reaches the document; the mandatory
  // marker and validation contract is still enforced.
  await waitForMarkdown(
    join(root, 'specs', FEATURE_PROJECT, 'spec.md'),
    [
      new RegExp(`Feature:\\s*${escapedRegExp(FEATURE_PROJECT)}`, 'u'),
      /<!--\s*omp-spec:marker:problem\s*-->/u,
      /<!--\s*omp-spec:marker:requirements\s*-->/u,
      /<!--\s*omp-spec:marker:scope\s*-->/u,
      /<!--\s*omp-spec:marker:success_criteria\s*-->/u,
      /^##\s+Ausgangslage/imu,
      /^##\s+Anforderungen/imu,
      /^##\s+Umfang/imu,
      /^##\s+Erfolgskriterien/imu,
    ],
    'project-template Specify document with localized presentation',
  );
  const gammaSpec = readFileSync(join(root, 'specs', FEATURE_PROJECT, 'spec.md'), 'utf8');
  assert.ok(cyrillicRuns(gammaSpec) >= 8, 'generated prose follows the project default language');
  assert.ok(existsSync(join(root, 'specs', FEATURE_PROJECT, 'validation', 'specify.md')), 'validation projection is materialized under the project template');
  assertAwaitingApproval(gammaState, 'specify');
  await answerCheckpoint(driver, gammaAsk, '3');
  const gammaApprovedState = await waitForApprovedPhase(root, FEATURE_PROJECT, 'specify', 'project-default Specify approval');
  assertApprovedPhase(gammaApprovedState, 'specify');
  const gammaStatus = await waitForMarkdown(
    join(root, 'specs', FEATURE_PROJECT, 'status.md'),
    [
      /Phase Status/iu,
      /Approvals/iu,
      /Next Action/iu,
      new RegExp(`/spec-plan\\s+--feature\\s+${escapedRegExp(FEATURE_PROJECT)}`, 'iu'),
    ],
    'project-default Specify exact next action',
  );
  assert.ok(includesSelectionValue(gammaStatus, PROJECT_LANGUAGE), 'status materialization shows the project default language');
  assert.ok(includesSelectionValue(gammaStatus, 'project_default'), 'status materialization shows the provenance source');
  assert.ok(includesSelectionValue(gammaStatus, String(gammaTemplateSet?.content_hash)), 'status materialization shows the resolved template hash');
  const gammaSelectionBefore = JSON.stringify({
    language: gammaState.specification.language,
    template_set: gammaState.specification.template_set,
  });
  const gammaSpecDigestBefore = sha256Hex(readFileSync(join(root, 'specs', FEATURE_PROJECT, 'spec.md'), 'utf8'));

  // ── Invalid override: marker-less project template rejects before dispatch ──
  writeFileSync(
    join(root, PROJECT_CONFIG_PATH),
    `${JSON.stringify({ language: PROJECT_LANGUAGE, templates: { specify: PROJECT_TEMPLATE_BROKEN_PATH } }, null, 2)}\n`,
  );
  const askCountBeforeRejection = log.selectedAskBlocks().length;
  await sendLine(driver, `/specify --feature ${FEATURE_REJECTED} ${REQUEST_EN}`);
  const rejectionScreen = await waitForOutput(driver, /marker/iu, 'marker-less template rejection');
  assert.match(rejectionScreen, /template/iu, 'the rejection names the offending template');
  assert.equal(
    log.selectedAskBlocks().length,
    askCountBeforeRejection,
    'the rejected template never reaches a hard-human checkpoint',
  );
  assert.equal(
    existsSync(join(root, 'specs', FEATURE_REJECTED, 'spec.md')),
    false,
    'the rejected template materializes no Specify document',
  );
  assert.equal(
    existsSync(join(root, '.work-state', 'features', FEATURE_REJECTED, 'artifacts')),
    false,
    'the rejected template dispatches no worker: no phase artifacts exist',
  );
  const rejectedStatePath = join(root, '.work-state', 'features', FEATURE_REJECTED, 'state.json');
  if (existsSync(rejectedStatePath)) {
    const rejected = readState(root, FEATURE_REJECTED);
    const specify = phaseRecord(rejected, 'specify');
    assert.equal(specify.current_version ?? null, null, 'rejected Specify phase has no generated version');
    assert.equal(specify.approved_version ?? null, null, 'rejected Specify phase has no approval');
  }

  // ── Fail-closed isolation: the approved workspace keeps its exact selection ──
  const gammaStateAfter = readState(root, FEATURE_PROJECT);
  assert.equal(
    JSON.stringify({
      language: gammaStateAfter.specification.language,
      template_set: gammaStateAfter.specification.template_set,
    }),
    gammaSelectionBefore,
    'a later invalid configuration never rewrites the approved workspace selection',
  );
  assert.equal(
    sha256Hex(readFileSync(join(root, 'specs', FEATURE_PROJECT, 'spec.md'), 'utf8')),
    gammaSpecDigestBefore,
    'the approved document is untouched by the rejected template',
  );

  const frames = inputFrames(log);
  assert.ok(frames.some((frame) => frame.includes(`/specify --feature ${FEATURE_PROJECT}`)), 'project-default input carries the explicit feature selector');
  assert.ok(frames.some((frame) => frame.includes(`/specify --feature ${FEATURE_REJECTED}`)), 'rejected input carries the explicit feature selector');
  completed = true;
});
