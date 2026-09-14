/**
 * T025 — real-runtime native readable specification contract.
 *
 * The scenario intentionally exercises the OMP PTY/WS boundary rather than
 * importing core implementation details. It is expected to fail until the
 * native profile, phase commands, materialization, and handoff work land.
 *
 */

import assert from 'node:assert/strict';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';

import { SPECIFICATION_STAGE_WAIT_TIMEOUT_MS } from '../src/specification-runtime.js';
import {
  createScratchSpecificationRepository,
  type ScratchRepositoryResult,
} from '../src/specification-fixtures.js';
import {
  loadScenario,
} from '../src/scenario.js';
import {
  answerNativeAsk,
  answerSelectedAsk,
  matchesCanonicalSelectorOptions,
  type AskBlock,
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
const SCENARIO_PATH = join(HERE, '..', 'scenarios', 'spec-workflow.json');
const FEATURE_ID = 'readable-native';
const REQUEST = 'Add a deterministic project-local workflow profile override with explicit ownership';
const WAIT_TIMEOUT_MS = SPECIFICATION_STAGE_WAIT_TIMEOUT_MS;

function escapedRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
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

type CheckpointBlock = AskBlock | SelectedAskBlock;

function checkpointBlocks(log: TranscriptLog): CheckpointBlock[] {
  return [
    ...log.askBlocks(),
    ...log.selectedAskBlocks(),
  ].sort((left, right) => left.frameStart - right.frameStart || left.index - right.index);
}

function canonicalCheckpointOptions(expectedOptions: number): readonly string[] {
  return expectedOptions === 2
    ? ['approve_continue', 'request_changes']
    : ['approve_continue', 'request_changes', 'approve_stop'];
}

async function answerCheckpoint(driver: WsDriver, block: CheckpointBlock, answer: string): Promise<void> {
  if (block.surface === 'selector') {
    const option = block.options[Number(answer) - 1];
    assert.ok(option !== undefined, `selector answer ${answer} is in range`);
    await answerSelectedAsk(driver, block, option);
  } else if (block.surface === 'native') {
    await answerNativeAsk(driver, block, answer);
  } else {
    await sendLine(driver, answer);
  }
}

async function waitForCheckpoint(
  driver: WsDriver,
  log: TranscriptLog,
  phase: string,
  expectedOptions: number,
  minimumIndex: number,
  label: string,
  timeoutMs = WAIT_TIMEOUT_MS,
): Promise<CheckpointBlock> {
  let found: CheckpointBlock | undefined;
  await waitFor(
    async () => {
      const screen = await driver.readScreen();
      const candidate = checkpointBlocks(log).find((block) => {
        if (block.index < minimumIndex) return false;
        if (!new RegExp(phase, 'iu').test(`${screen}\n${block.title}`)) return false;
        return block.surface === 'selector'
          ? matchesCanonicalSelectorOptions(block.options, canonicalCheckpointOptions(expectedOptions))
          : block.options.length === expectedOptions;
      });
      if (candidate === undefined) return false;
      found = candidate;
      return true;
    },
    { timeoutMs, intervalMs: 100, label },
  );
  assert.ok(found, `${label}: checkpoint was not observed`);
  if (found.surface === 'selector') {
    assert.ok(
      matchesCanonicalSelectorOptions(found.options, canonicalCheckpointOptions(expectedOptions)),
      `${label}: canonical selector options`,
    );
  } else {
    assert.equal(found.options.length, expectedOptions, `${label}: exact hard-human option count`);
    assert.match(found.options[0] ?? '', /approve[_ -]?continue/iu, `${label}: approve_continue option`);
    assert.match(found.options[1] ?? '', /request[_ -]?changes/iu, `${label}: request_changes option`);
    if (expectedOptions === 3) assert.match(found.options[2] ?? '', /approve[_ -]?stop/iu, `${label}: approve_stop option`);
  }
  return found;
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

function workspaceText(root: string): string {
  return filesBelow(join(root, '.work-state', 'features', FEATURE_ID))
    .map((path) => {
      try {
        return readFileSync(path, 'utf8');
      } catch {
        return '';
      }
    })
    .join('\n');
}

function readExplicitIdentity(root: string): string {
  const statePath = join(root, '.work-state', 'features', FEATURE_ID, 'state.json');
  assert.ok(existsSync(statePath), 'canonical feature state is persisted');
  const state = JSON.parse(readFileSync(statePath, 'utf8')) as {
    run_key?: unknown;
    specification?: Record<string, unknown>;
  };
  assert.equal(typeof state.run_key, 'string', 'state carries an explicit run_key');
  assert.ok((state.run_key as string).length > 0, 'run_key is non-empty');
  assert.equal(state.specification?.feature_id, FEATURE_ID, 'state carries the selected feature_id');
  assert.equal(state.specification?.workspace_path, `specs/${FEATURE_ID}`, 'workspace path is feature-bound');
  assert.equal(state.specification?.state_path, `.work-state/features/${FEATURE_ID}/state.json`, 'state path is feature-bound');
  return state.run_key as string;
}

function assertWorkerAttribution(root: string): void {
  const text = workspaceText(root);
  assert.ok(text.length > 0, 'feature state/artifact evidence is readable');
  assert.ok(
    (text.match(/"dispatch_id"\s*:/gu) ?? []).length >= 3,
    'Specify, Plan, and Tasks versions retain dispatch attribution',
  );
  for (const phase of ['specify', 'plan', 'tasks']) {
    assert.match(text, new RegExp(`"phase"\\s*:\\s*"${phase}"`, 'u'), `${phase} artifact records its phase`);
  }
  assert.match(text, /"role"\s*:/u, 'phase evidence records worker role');
  assert.match(text, /"agent"\s*:/u, 'phase evidence records worker agent');
}

function assertNoExternalFramework(root: string): void {
  for (const candidate of ['.specify', '.openspec', '.bmad', '.superpowers', '.xpowers']) {
    assert.equal(existsSync(join(root, candidate)), false, `${candidate} is absent in the native fixture`);
  }
}

function inputFrames(log: TranscriptLog): string[] {
  log.refresh();
  return log.frames.flatMap((frame) => (frame.t === 'i' ? [frame.d] : []));
}

function prepareRuntimeFixture(parent: string): ScratchRepositoryResult {
  return createScratchSpecificationRepository({
    workdir: parent,
    slug: FEATURE_ID,
    runtime: true,
    // No constitution, bundles, or framework metadata: the first command must
    // take the plugin-native constitution path in a clean git repository.
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
    git: { init: true, branch: 'main', commit: true, message: 'Initial native specification fixture' },
  });
}


test('scenario: spec-workflow declares the native explicit phase journey', () => {
  const scenario = loadScenario(SCENARIO_PATH);
  assert.equal(scenario.id, 'spec-workflow');
  assert.deepEqual(
    scenario.stages.map((stage) => stage.id),
    ['constitution', 'specify', 'plan', 'tasks', 'readable-evidence'],
  );
  assert.equal(scenario.params.feature_id, FEATURE_ID);
  assert.match(scenario.task, new RegExp(`feature_id.*${escapedRegExp(FEATURE_ID)}`, 'iu'));
  assert.match(scenario.task, /explicit run_key/iu);
  assert.match(scenario.task, /no Spec Kit/iu);
  assert.match(scenario.task, /handoff/iu);
  assert.doesNotMatch(scenario.task, /omp-cto-slice run=[0-9a-f-]{36}/u);
  const constitution = scenario.stages[0];
  const specify = scenario.stages[1];
  const plan = scenario.stages[2];
  const tasks = scenario.stages[3];
  assert.ok(constitution !== undefined && specify !== undefined && plan !== undefined && tasks !== undefined);
  assert.equal(constitution.ask_user?.[0]?.answer, '1', 'constitution approval uses approve_continue option');
  assert.equal(specify.ask_user?.[0]?.answer, '3', 'Specify stops after approval for explicit Plan resume');
  assert.equal(plan.ask_user?.[0]?.answer, '1', 'Plan continues directly into Tasks');
  assert.equal(tasks.ask_user?.[0]?.answer, '3', 'Tasks stops after producing the handoff');
});

test('native runtime: no-framework Constitution -> Specify -> Plan -> Tasks produces readable handoff', async (t) => {
  const parent = mkdtempSync(join(tmpdir(), 'omp-spec-workflow-e2e-'));
  const { root } = prepareRuntimeFixture(parent);
  assertNoExternalFramework(root);
  assert.equal(existsSync(join(root, 'CONSTITUTION.md')), false, 'native fixture starts without a constitution');
  assert.equal(existsSync(join(root, '.active-feature')), false, 'native fixture has no legacy implicit selector');

  let session: TestSession | undefined;
  let driver: WsDriver | undefined;
  t.after(async () => {
    await driver?.close();
    await session?.close();
    rmSync(parent, { recursive: true, force: true });
  });

  const scenario = loadScenario(SCENARIO_PATH);
  session = await startTestSession({
    cwd: root,
    surface: 'text',
    cols: 120,
    rows: 40,
    maxTimeSec: 900,
    idleMs: 900_000,
    taskPrompt: scenario.task,
    scenario: { id: scenario.id, title: scenario.title },
  });
  if (session.pty.mode !== 'pty') {
    await session.close();
    throw new Error('node-pty or the omp binary could not create a PTY');
  }

  driver = new WsDriver({ url: session.url, transcriptPath: session.transcriptPath });
  const log = new TranscriptLog(session.transcriptPath);
  await driver.open();
  await waitForOmpTuiReady(driver);
  await waitForOutput(driver, /(?:omp|ready|>)/iu, 'OMP startup', scenario.timing.startupTimeoutMs);

  // Missing CONSTITUTION.md must enter the plugin-native bootstrap and expose
  // exactly the two constitution decisions before Specify starts.
  await sendLine(driver, `/specify --feature ${FEATURE_ID} ${REQUEST}`);
  const constitutionAsk = await waitForCheckpoint(driver, log, 'constitution', 2, 1, 'constitution checkpoint');
  assert.match(constitutionAsk.options.join(' '), /continue/iu, 'constitution checkpoint offers approve_continue');
  assert.match(constitutionAsk.options.join(' '), /change/iu, 'constitution checkpoint offers request_changes');
  assert.ok(
    !/stop/iu.test(constitutionAsk.options.join(' ')),
    'constitution checkpoint does not expose the regular approve_stop decision',
  );
  await waitForMarkdown(
    join(root, 'CONSTITUTION.md'),
    [/^#\s+Project Constitution/imu, /##\s+/u],
    'native constitution draft',
  );
  assertNoExternalFramework(root);
  await answerCheckpoint(driver, constitutionAsk, '1');
  await waitForOutput(driver, /Specify/iu, 'Specify starts after constitution approval');

  const specifyAsk = await waitForCheckpoint(driver, log, 'Specify', 3, constitutionAsk.index + 1, 'Specify checkpoint');
  const runKey = readExplicitIdentity(root);
  await waitForMarkdown(
    join(root, 'specs', FEATURE_ID, 'spec.md'),
    [
      new RegExp(`Feature:\\s*${escapedRegExp(FEATURE_ID)}`, 'u'),
      new RegExp(`Run:\\s*${escapedRegExp(runKey)}`, 'u'),
      /^##\s+Problem/imu,
      /^##\s+Requirements/imu,
      /^##\s+Scope/imu,
      /^##\s+Success Criteria/imu,
    ],
    'readable Specify document',
  );
  await waitForMarkdown(
    join(root, 'specs', FEATURE_ID, 'validation', 'specify.md'),
    [/specify/iu, /pass/iu],
    'Specify validation projection',
  );
  assertWorkerAttribution(root);
  assertNoExternalFramework(root);
  await answerCheckpoint(driver, specifyAsk, '3');
  const specifyStatus = await waitForMarkdown(
    join(root, 'specs', FEATURE_ID, 'status.md'),
    [/Phase Status/iu, /Approvals/iu, /Next Action/iu, new RegExp(`/spec-plan\\s+--feature\\s+${escapedRegExp(FEATURE_ID)}`, 'iu')],
    'Specify exact next action',
  );
  assert.match(specifyStatus, new RegExp(`\/spec-plan\\s+--feature\\s+${escapedRegExp(FEATURE_ID)}`, 'iu'));
  assert.equal(readExplicitIdentity(root), runKey, 'run_key remains stable after Specify stop');

  // Plan is an explicit feature-selected command; approve_continue should
  // dispatch Tasks without a second implicit workspace or run.
  await sendLine(driver, `/spec-plan --feature ${FEATURE_ID}`);
  const planAsk = await waitForCheckpoint(driver, log, 'Plan', 3, specifyAsk.index + 1, 'Plan checkpoint');
  await waitForMarkdown(
    join(root, 'specs', FEATURE_ID, 'plan.md'),
    [
      new RegExp(`Feature:\\s*${escapedRegExp(FEATURE_ID)}`, 'u'),
      new RegExp(`Run:\\s*${escapedRegExp(runKey)}`, 'u'),
      /^##\s+Decisions/imu,
      /^##\s+Alternatives Considered/imu,
      /^##\s+Architecture and Data Flow/imu,
      /^##\s+Verification Strategy/imu,
    ],
    'readable Plan document',
  );
  await waitForMarkdown(
    join(root, 'specs', FEATURE_ID, 'validation', 'plan.md'),
    [/plan/iu, /pass/iu],
    'Plan validation projection',
  );
  assert.equal(readExplicitIdentity(root), runKey, 'run_key remains stable through Plan');
  await answerCheckpoint(driver, planAsk, '1');
  await sendLine(driver, `/spec-tasks --feature ${FEATURE_ID}`);

  const tasksAsk = await waitForCheckpoint(driver, log, 'Tasks', 3, planAsk.index + 1, 'Tasks checkpoint');
  await waitForMarkdown(
    join(root, 'specs', FEATURE_ID, 'tasks.md'),
    [
      new RegExp(`Feature:\\s*${escapedRegExp(FEATURE_ID)}`, 'u'),
      new RegExp(`Run:\\s*${escapedRegExp(runKey)}`, 'u'),
      /^##\s+Task Graph/imu,
      /^##\s+Dependencies and Order/imu,
      /^##\s+Expected Outcomes/imu,
    ],
    'readable Tasks document',
  );
  await waitForMarkdown(
    join(root, 'specs', FEATURE_ID, 'validation', 'tasks.md'),
    [/tasks/iu, /pass/iu],
    'Tasks validation projection',
  );
  assertWorkerAttribution(root);
  await answerCheckpoint(driver, tasksAsk, '3');

  const finalStatus = await waitForMarkdown(
    join(root, 'specs', FEATURE_ID, 'status.md'),
    [
      /Phase Status/iu,
      /Approvals/iu,
      /Next Action/iu,
      /implementation[_ ]ready/iu,
      new RegExp(`/do-work\\s+--spec\\s+${escapedRegExp(FEATURE_ID)}`, 'iu'),
    ],
    'final status and exact handoff action',
  );
  const handoff = await waitForMarkdown(
    join(root, 'specs', FEATURE_ID, 'handoff.md'),
    [/handoff/iu, new RegExp(FEATURE_ID, 'u'), /ready/iu, /do-work/iu],
    'readable implementation handoff',
  );
  assert.match(finalStatus, new RegExp(`/do-work\\s+--spec\\s+${escapedRegExp(FEATURE_ID)}`, 'iu'));
  assert.match(handoff, new RegExp(FEATURE_ID, 'u'));
  assert.equal(readExplicitIdentity(root), runKey, 'run_key remains stable after Tasks approval');

  const historyDir = join(root, 'specs', FEATURE_ID, 'history');
  await waitFor(
    () => filesBelow(historyDir).some((path) => path.endsWith('.md')),
    { timeoutMs: WAIT_TIMEOUT_MS, intervalMs: 100, label: 'readable history revisions' },
  );
  assertNoExternalFramework(root);
  assert.equal(existsSync(join(root, '.active-feature')), false, 'native flow never creates or relies on .active-feature');

  const frames = inputFrames(log);
  assert.ok(frames.some((frame) => frame.includes(`/specify --feature ${FEATURE_ID}`)), 'Specify input carries explicit feature selector');
  assert.ok(frames.some((frame) => frame.includes(`/spec-plan --feature ${FEATURE_ID}`)), 'Plan input carries explicit feature selector');
  assert.ok(frames.some((frame) => frame.includes(`/spec-tasks --feature ${FEATURE_ID}`)), 'Tasks input carries explicit feature selector');
  assert.equal(log.askBlocks().length, 4, 'only constitution, Specify, Plan, and Tasks checkpoints were presented');
});

