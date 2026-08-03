/**
 * Manual-QA regression tests — encode the contracts observed live during
 * ux-e2e-reference3 (verdict PASS, 8/10 stages, real LLM calls) so any
 * future drift in the report, scenario, launch, or session shape is
 * caught in CI rather than on the next manual run.
 *
 * Coverage map (matches `qa-tests-contract.md` items 1-4):
 *   1. Report contract — full ux-e2e + manual_qa shape, verdict preservation,
 *      MEDIUM defect floor clamps overall.score to 3 (the observed value).
 *   2. Scenario shape — `scenarios/full-feature.json` expands with zero
 *      literal `{{...}}` and stage ids match `packages/core/workflows/
 *      full-feature.json` in order.
 *   3. Model-config inheritance — `buildOmpArgs` emits host `--config`
 *      before overlay `--config`, no `--profile` by default, emits
 *      `--profile` when `ompProfile` is set.
 *   4. Session artifact — session.json (fixture) carries every field the
 *      report reads, with no literal `{{...}}` in `task_prompt`.
 *
 * Item 5 (rate-limit typing threshold documentation) is a doc-only note
 * in CHANGELOG.md and README.md; no runtime behavior change.
 */

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  DEFECT_FLOORS,
  generateReport,
  type ReportInput,
  type UxDefect,
  type UxE2eReport,
  type UxStep,
  type Verdict,
} from '../src/report.js';
import { buildOmpArgs } from '../src/server.js';
import { loadScenario } from '../src/scenario.js';

/* ------------------------------------------------------------------ */
/* Shared fixtures — mirror the actual manual-QA run's data           */
/* (`.work-state/artifacts/ux-e2e-reference3/steps.json` + manual_qa) */
/* ------------------------------------------------------------------ */

const STEPS_DIR = dirname(fileURLToPath(import.meta.url));
const SCENARIOS_DIR = join(STEPS_DIR, '..', 'scenarios');
const CORE_WORKFLOWS_DIR = join(STEPS_DIR, '..', '..', 'core', 'workflows');
const FULL_FEATURE_SCENARIO = join(SCENARIOS_DIR, 'full-feature.json');
const CORE_FULL_FEATURE = join(CORE_WORKFLOWS_DIR, 'full-feature.json');

const FULL_DIMENSIONS = [
  'message_clarity',
  'feedback_timing',
  'error_handling',
  'layout',
  'interactivity',
  'visual_rendering',
] as const;

function makeStep(id: string, name: string, order: number, defects: string[] = []): UxStep {
  const ratings = Object.fromEntries(FULL_DIMENSIONS.map(d => [d, 5])) as UxStep['ratings'];
  return { id, name, order, ratings, defects, screenshots: [] };
}

/** The actual 11 steps observed live during ux-e2e-reference3. */
const REAL_STEPS: ReadonlyArray<UxStep> = [
  makeStep('build', 'Build e2e package + CLI sanity', 0),
  makeStep('bootstrap', 'Bootstrap fresh scratch project', 1),
  makeStep('start-fg', 'Start foreground with hub (kept parent alive)', 2, ['FD-DETACH-LIFECYCLE']),
  makeStep('ws-connect', 'Browser WS connection + xterm mount', 3),
  makeStep('type-do-work', 'Type /do-work + task prompt', 4, ['FD-RL']),
  makeStep('stage-clarify', 'Clarify stage — 4 interactive questions answered', 5),
  makeStep('stage-discovery', 'Discovery stage', 6),
  makeStep('stage-implementation', 'Implementation + Verification stage', 7),
  makeStep('stage-code-review', 'Code review stage (subagent)', 8, ['FD-REVIEW-REPORT-LOSS']),
  makeStep('stage-review-fixes', 'Review fixes + Commit stage', 9),
  makeStep('stage-summary', 'Summary (recap + idle)', 10),
];

/** The 3 defects from the live run (FD-DETACH-LIFECYCLE + FD-RL are
 *  MEDIUM framework defects; FD-REVIEW-REPORT-LOSS is a LOW workflow
 *  observation, not a framework defect, but is recorded in steps). */
const REAL_DEFECTS: ReadonlyArray<UxDefect> = [
  {
    id: 'FD-DETACH-LIFECYCLE',
    severity: 'MEDIUM',
    dimension: 'interactivity',
    title: '--detach child killed when parent shell exits (timeout SIGTERM)',
    step: 'start-fg',
    evidence: [
      'First start: shell timeout SIGTERM parent -> detached child died too (empty transcript, port unbound).',
      'Workaround: foreground via hub.start kept parent alive for the full run.',
    ],
  },
  {
    id: 'FD-RL',
    severity: 'MEDIUM',
    dimension: 'error_handling',
    title: 'Server rate-limit fires on puppeteer default typing speed',
    step: 'type-do-work',
    evidence: [
      'page.keyboard.type with default delay (~30ms) -> server returned 3x rate-limited -> WS closed.',
      'Workaround: use >=150ms delay per char.',
    ],
  },
  {
    id: 'FD-REVIEW-REPORT-LOSS',
    severity: 'LOW',
    dimension: 'error_handling',
    title: 'Code-reviewer subagent detailed report was lost (workflow observation, not framework)',
    step: 'stage-code-review',
    evidence: [
      'Main agent narrative: detailed review report was lost; reconstructed from code evidence.',
    ],
  },
];

const REAL_AGENT_QUALITY = {
  rating: 5,
  rationale:
    'Tested agent (omp 17.2.3 + DeepSeek V4 Flash via opencode-go) drove the full workflow end-to-end.',
  dimensions: {
    task_fidelity: 5,
    communication: 5,
    tool_discipline: 5,
    output_quality: 5,
    recovery: 5,
  },
} as const;

function realInput(verdict: Verdict = 'PASS'): ReportInput {
  return {
    steps: REAL_STEPS,
    defects: REAL_DEFECTS,
    agent_quality: { ...REAL_AGENT_QUALITY },
    verdict,
    overall: {
      summary:
        'Framework end-to-end verified against a real model-capable omp session. 8/10 reference stages observed live.',
      recommendation: 'ship',
      score: 5,
    },
    regressions: [],
  };
}

function writeFixtureSession(dir: string, taskPrompt: string): void {
  const stateDir = join(dir, '.work-state', 'ux-e2e');
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(
    join(stateDir, 'session.json'),
    JSON.stringify({
      slug: 'ux-e2e-reference3',
      url: 'http://127.0.0.1:52464/?token=fake',
      token: 'fake',
      wsPath: '/ws',
      pid: 58326,
      started_at: '2026-08-02T12:00:00.000Z',
      omp_version: 'omp/17.2.3',
      profile: null,
      tty: { cols: 120, rows: 40, term: 'xterm-256color' },
      task_prompt: taskPrompt,
      scenario: { id: 'full-feature', title: 'Full feature' },
    }) + '\n',
  );
  writeFileSync(join(stateDir, 'transcript.jsonl'), '{"ts":"2026-08-02T12:00:00.000Z","t":"o","d":"stage: discovery\\n"}\n');
}

/* ------------------------------------------------------------------ */
/* Item 1 — Report contract                                            */
/* ------------------------------------------------------------------ */

test('qa-regression: report JSON validates manual_qa + ux-e2e shape with real-run data (verdict PASS)', () => {
  const scratch = mkdtempSync(join(tmpdir(), 'ux-e2e-qa-report-'));
  writeFixtureSession(scratch, 'build a theme toggle');
  const mdDir = mkdtempSync(join(tmpdir(), 'ux-e2e-qa-md-'));
  const result = generateReport(scratch, realInput('PASS'), { mdDir });

  const report = JSON.parse(readFileSync(result.jsonPath, 'utf8')) as UxE2eReport;

  // manual_qa.required fields — verdict / evidence / mode / regressions.
  assert.ok('verdict' in report, 'report.verdict present (manual_qa required)');
  assert.equal(report.verdict, 'PASS', 'verdict PASS stays PASS (no projection)');
  assert.ok('mode' in report, 'report.mode present (manual_qa required)');
  assert.equal(report.mode, 'ui', 'mode is "ui"');
  assert.ok(Array.isArray(report.evidence), 'report.evidence[] present (manual_qa required)');
  assert.ok('regressions' in report, 'report.regressions present (manual_qa required)');
  assert.deepEqual(report.regressions, [], 'no regressions in the live run');

  // Full ux-e2e shape.
  assert.equal(report.type, 'ux-e2e');
  assert.equal(report.schema_version, 1);
  assert.ok(report.session && typeof report.session === 'object', 'report.session present');
  assert.equal(report.session.slug, 'ux-e2e-reference3');
  assert.equal(report.session.omp_version, 'omp/17.2.3');
  assert.ok(report.session.task_prompt === 'build a theme toggle');
  assert.ok(Array.isArray(report.steps) && report.steps.length === REAL_STEPS.length, 'all 11 steps present');
  assert.equal(report.steps[0]?.id, 'build');
  assert.equal(report.steps[10]?.id, 'stage-summary');
  assert.ok(Array.isArray(report.defects) && report.defects.length === REAL_DEFECTS.length, 'all 3 defects present');
  assert.ok(report.agent_quality && report.agent_quality.rating === 5, 'agent_quality carries rating 5');
  assert.ok(report.overall && typeof report.overall.score === 'number', 'overall.score present');

  // The live run had MEDIUM defects: clamp overall.score to MEDIUM floor (3).
  assert.equal(report.overall.score, 3, 'MEDIUM defect floor clamps overall.score to 3 (matches observed score)');
  // Per-step floor: start-fg carries FD-DETACH-LIFECYCLE (MEDIUM -> floor 3).
  assert.ok(
    report.steps.find(s => s.id === 'start-fg')?.ratings.error_handling === 3,
    'MEDIUM defect on a step clamps that step rating to floor 3',
  );
  // Per-step floor: stage-code-review carries LOW -> floor 4.
  assert.ok(
    report.steps.find(s => s.id === 'stage-code-review')?.ratings.error_handling === 4,
    'LOW defect on a step clamps that step rating to floor 4',
  );
});

test('qa-regression: CONDITIONAL verdict is preserved by generateReport — projection is a downstream concern', () => {
  // Contract note: generateReport stores the verdict as supplied. Downstream
  // consumers (manual_qa aggregator, CI gate) project CONDITIONAL -> FAIL.
  // We assert the schema carries CONDITIONAL verbatim AND document the
  // projection mapping as a single source of truth test fixture.
  const scratch = mkdtempSync(join(tmpdir(), 'ux-e2e-qa-report-cond-'));
  writeFixtureSession(scratch, 'task');
  const mdDir = mkdtempSync(join(tmpdir(), 'ux-e2e-qa-md-cond-'));
  const result = generateReport(scratch, realInput('CONDITIONAL'), { mdDir });
  const report = JSON.parse(readFileSync(result.jsonPath, 'utf8')) as UxE2eReport;
  assert.equal(report.verdict, 'CONDITIONAL', 'verdict preserved verbatim by generateReport');

  // Document the CONDITIONAL -> FAIL projection rule used by downstream CI.
  const projectToCiVerdict = (v: Verdict): 'PASS' | 'FAIL' =>
    v === 'CONDITIONAL' ? 'FAIL' : (v as 'PASS' | 'FAIL');
  assert.equal(projectToCiVerdict('CONDITIONAL'), 'FAIL', 'CONDITIONAL projects to FAIL for CI');
  assert.equal(projectToCiVerdict('PASS'), 'PASS', 'PASS stays PASS');
  assert.equal(projectToCiVerdict('FAIL'), 'FAIL', 'FAIL stays FAIL');
});

test('qa-regression: MEDIUM defect floor (3) clamps overall score to 3 even when caller says 5', () => {
  const scratch = mkdtempSync(join(tmpdir(), 'ux-e2e-qa-report-floor-'));
  writeFixtureSession(scratch, 'task');
  const mdDir = mkdtempSync(join(tmpdir(), 'ux-e2e-qa-md-floor-'));
  // Two MEDIUM defects worst than any step — clamp overall.score=5 down to MEDIUM floor (3).
  const result = generateReport(
    scratch,
    {
      steps: REAL_STEPS,
      defects: REAL_DEFECTS.filter(d => d.severity === 'MEDIUM'),
      agent_quality: { rating: 5, rationale: 'great' },
      verdict: 'PASS',
      overall: { summary: 'looks good', recommendation: 'ship', score: 5 },
      regressions: [],
    },
    { mdDir },
  );
  const report = JSON.parse(readFileSync(result.jsonPath, 'utf8')) as UxE2eReport;
  assert.equal(DEFECT_FLOORS.MEDIUM, 3, 'DEFECT_FLOORS.MEDIUM === 3 (matches observed clamp)');
  assert.equal(report.overall.score, 3, 'overall.score clamped from 5 down to MEDIUM floor (3)');
});

/* ------------------------------------------------------------------ */
/* Item 2 — Scenario shape                                            */
/* ------------------------------------------------------------------ */

test('qa-regression: scenarios/full-feature.json expands with zero literal {{ and stage ids match core workflow', () => {
  const scenario = loadScenario(FULL_FEATURE_SCENARIO, { slug: 'ux-e2e-reference3', branch: 'feat/ux-e2e-ref' });
  const coreWorkflow = JSON.parse(readFileSync(CORE_FULL_FEATURE, 'utf8')) as { stages: Array<{ id: string }> };

  // Zero literal {{...}} left in the rendered task (D3 contract).
  assert.ok(scenario.task.length > 0, 'task file is resolved to a string');
  assert.ok(
    !/\{\{[^}]+\}\}/u.test(scenario.task),
    `rendered task must have zero literal {{...}}, got: ${scenario.task.slice(0, 200)}…`,
  );

  // Stage count matches the core workflow (10 stages).
  assert.equal(scenario.stages.length, 10, 'full-feature scenario has 10 stages');
  assert.equal(
    scenario.stages.length,
    coreWorkflow.stages.length,
    'scenario stage count matches packages/core/workflows/full-feature.json',
  );

  // Stage ids match the core workflow in order:
  // discovery, exploration, clarify, architecture, implementation,
  // code_review, review_fixes, manual_qa, qa_tests, summary.
  const scenarioIds = scenario.stages.map(s => s.id);
  const coreIds = coreWorkflow.stages.map(s => s.id);
  assert.deepEqual(
    scenarioIds,
    coreIds,
    `scenario stage ids must match core workflow in order.\n  scenario: ${JSON.stringify(scenarioIds)}\n  core:     ${JSON.stringify(coreIds)}`,
  );
});

/* ------------------------------------------------------------------ */
/* Item 3 — Model-config inheritance (buildOmpArgs)                   */
/* ------------------------------------------------------------------ */

test('qa-regression: buildOmpArgs emits --config host BEFORE --config overlay and NO --profile by default', () => {
  const args = buildOmpArgs({
    maxTimeSec: 1800,
    approvalMode: 'yolo',
    configPath: '/scratch/.omp/ux-e2e-overlay.json',
    sessionDir: '/scratch/.omp/agent',
    hostConfigPath: '/Users/test/.omp/agent/config.yml',
    userConfigDefaultPath: '/scratch/.omp/ux-e2e-overlay.user.json',
  });

  // No --profile by default.
  assert.ok(!args.includes('--profile'), 'no --profile flag when ompProfile is unset');

  // Find both --config positions.
  const configPositions: number[] = [];
  args.forEach((value, idx) => {
    if (value === '--config') configPositions.push(idx);
  });
  assert.equal(configPositions.length, 2, 'emits exactly two --config flags');
  assert.equal(
    args[configPositions[0]!],
    '--config',
    'first --config slot present',
  );
  assert.equal(
    args[configPositions[0]! + 1],
    '/Users/test/.omp/agent/config.yml',
    'host config is FIRST --config (modelRoles survive)',
  );
  assert.equal(
    args[configPositions[1]! + 1],
    '/scratch/.omp/ux-e2e-overlay.json',
    'overlay config is SECOND --config (later wins on conflict)',
  );
  assert.ok(configPositions[0]! < configPositions[1]!, 'host --config strictly before overlay --config');
  // Third --config (user overlay) is NOT emitted when userConfigPath is unset.
  assert.ok(!args.includes('/scratch/.omp/ux-e2e-overlay.user.json'),
    'user default path is not emitted when userConfigPath is unset');
});

test('qa-regression: buildOmpArgs emits --profile when opts.ompProfile is set', () => {
  const args = buildOmpArgs({
    ompProfile: 'ux-e2e-test',
    maxTimeSec: 1800,
    approvalMode: 'yolo',
    configPath: '/scratch/.omp/ux-e2e-overlay.json',
    sessionDir: '/scratch/.omp/agent',
    hostConfigPath: '/Users/test/.omp/agent/config.yml',
    userConfigDefaultPath: '/scratch/.omp/ux-e2e-overlay.user.json',
  });

  // --profile emitted.
  const profileIdx = args.indexOf('--profile');
  assert.ok(profileIdx !== -1, '--profile emitted when ompProfile set');
  assert.equal(args[profileIdx + 1], 'ux-e2e-test', '--profile value matches ompProfile');

  // --config still in correct order even when --profile is set.
  const configPositions = args
    .map((v, i) => (v === '--config' ? i : -1))
    .filter(i => i !== -1);
  assert.equal(configPositions.length, 2, 'still emits two --config flags');

  assert.equal(args[configPositions[1]! + 1], '/scratch/.omp/ux-e2e-overlay.json', 'overlay config second');

  // --profile must come before the first --config so profile selection is
  // resolved before overlay lookup.
  assert.ok(profileIdx < configPositions[0]!, '--profile emitted before --config flags');
});

/* ------------------------------------------------------------------ */
/* Item 4 — Session artifact (session.json fields the report needs)   */
/* ------------------------------------------------------------------ */

test('qa-regression: session.json fixture carries every report-required field with no literal {{ in task_prompt', () => {
  // The report reads these fields from session.json (server.ts writeSessionJson):
  // slug, url, token, pid, started_at, omp_version, profile, tty, task_prompt.
  // task_prompt is sanitized and embedded into report.session.task_prompt.
  const scratch = mkdtempSync(join(tmpdir(), 'ux-e2e-qa-session-'));
  // No literal {{...}} — matches the D3 invariant that flows from scenario.task
  // into session.json.task_prompt (both call sanitizeForJson + scenario expand).
  const taskPrompt =
    'Build a Vite plus TypeScript theme toggle. No template expansion markers expected here.';
  writeFixtureSession(scratch, taskPrompt);
  const sessionPath = join(scratch, '.work-state', 'ux-e2e', 'session.json');
  const raw = JSON.parse(readFileSync(sessionPath, 'utf8')) as Record<string, unknown>;

  // Required fields — every one the report reads.
  assert.equal(typeof raw['slug'], 'string', 'session.json.slug is a string');
  assert.equal(raw['slug'], 'ux-e2e-reference3');
  assert.equal(typeof raw['url'], 'string', 'session.json.url is a string');
  assert.ok((raw['url'] as string).startsWith('http://127.0.0.1:'), 'session.json.url is a loopback URL with token');
  assert.equal(typeof raw['token'], 'string', 'session.json.token is a string');
  assert.equal(typeof raw['pid'], 'number', 'session.json.pid is a number');
  assert.equal(raw['pid'], 58326);
  assert.equal(typeof raw['started_at'], 'string', 'session.json.started_at is a string');
  assert.ok(!Number.isNaN(Date.parse(raw['started_at'] as string)), 'started_at parses as a date');
  assert.equal(typeof raw['omp_version'], 'string', 'session.json.omp_version is a string');
  assert.equal(raw['omp_version'], 'omp/17.2.3');
  assert.ok('profile' in raw, 'session.json.profile present (null when no --profile)');
  assert.equal(raw['profile'], null);
  assert.ok(raw['tty'] && typeof raw['tty'] === 'object', 'session.json.tty present');
  const tty = raw['tty'] as { cols: number; rows: number; term: string };
  assert.equal(tty.cols, 120);
  assert.equal(tty.rows, 40);
  assert.equal(tty.term, 'xterm-256color');
  assert.equal(typeof raw['task_prompt'], 'string', 'session.json.task_prompt is a string');

  // task_prompt must NOT contain a literal {{...}} — same D3 invariant the
  // scenario task template has; the report reads it as-is into report.session.
  assert.ok(
    !/\{\{[^}]+\}\}/u.test(raw['task_prompt'] as string),
    'session.json.task_prompt has no literal {{...}}',
  );
});

test('qa-regression: report reads session.json fields through end-to-end (session fixture -> report JSON)', () => {
  // End-to-end: write a fixture session.json, generate a report, verify the
  // report.session.* fields reflect the fixture (not 'unknown' / 'default').
  const scratch = mkdtempSync(join(tmpdir(), 'ux-e2e-qa-e2e-'));
  const taskPrompt = 'task prompt without any literal template markers';
  writeFixtureSession(scratch, taskPrompt);
  const mdDir = mkdtempSync(join(tmpdir(), 'ux-e2e-qa-e2e-md-'));
  const result = generateReport(scratch, realInput('PASS'), { mdDir });
  const report = JSON.parse(readFileSync(result.jsonPath, 'utf8')) as UxE2eReport;

  assert.equal(report.session.slug, 'ux-e2e-reference3', 'session.slug flows from fixture');
  assert.equal(report.session.omp_version, 'omp/17.2.3', 'session.omp_version flows from fixture');
  assert.equal(report.session.task_prompt, taskPrompt, 'session.task_prompt flows from fixture (sanitized)');
  assert.deepEqual(
    report.session.tty,
    { cols: 120, rows: 40, term: 'xterm-256color' },
    'session.tty flows from fixture',
  );
  assert.equal(report.session.started_at, '2026-08-02T12:00:00.000Z', 'session.started_at flows from fixture');
  // profile was null in the fixture — report.ts falls back to 'default'.
  assert.equal(report.session.profile, 'default', 'session.profile falls back to "default" when fixture is null');
});
