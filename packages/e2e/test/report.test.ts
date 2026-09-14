/**
 * Report tests: defect-floor clamping, manual_qa-compatible fields,
 * markdown output, and evidence collection/copying.
 */

import assert from 'node:assert/strict';
import { existsSync, linkSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, symlinkSync, truncateSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { test } from 'node:test';

import {
  generateReport,
  setEvidenceCopyTestHooks,
  type GenerateReportResult,
  type UxE2eReport,
  type ReportInput,
} from '../src/report.js';
import { MAX_PINNED_READ_BYTES } from '../src/fs-safety.js';

function makeSessionDir(options: { readonly completeEvidence?: boolean } = {}): string {
  const dir = mkdtempSync(join(tmpdir(), 'ux-e2e-report-'));
  const stateDir = join(dir, '.work-state', 'ux-e2e');
  mkdirSync(stateDir, { recursive: true });
  const stoppedAt = '2026-08-02T10:05:00.000Z';
  writeFileSync(
    join(stateDir, 'session.json'),
    JSON.stringify({
      schema_version: 2,
      status: 'stopped',
      pty_exit_observed: true,
      shutdown_completed_at: stoppedAt,
      stopped_at: stoppedAt,
      finished_at: stoppedAt,
      shutdown_error: null,
      slug: 'my-feature',
      token: 'fixture-bearer-secret',
      control_nonce: 'fixture-control-secret',
      server_start_nonce: 'fixture-startup-secret',
      omp_version: 'omp 17.2.3',
      profile: 'ux-e2e-test',
      tty: { cols: 100, rows: 30, term: 'xterm-256color' },
      started_at: '2026-08-02T10:00:00.000Z',
      task_prompt: 'implement the feature',
      scenario: {
        id: 'full-feature',
        title: 'Full feature',
        selectors: { feature_id: 'feature-a', run_key: 'run-1' },
        workspace: {
          path: 'specs/feature-a',
          state_path: '.work-state/features/feature-a/state.json',
          documents: ['specs/feature-a/spec.md'],
        },
        transcript: {
          checkpoints: ['.work-state/features/feature-a/checkpoint.json'],
          workers: ['.work-state/features/feature-a/worker.json'],
        },
      },
    }) + '\n',
  );
  writeFileSync(join(stateDir, 'transcript.jsonl'), '{"ts":"2026-08-02T10:00:00.000Z","t":"o","d":"stage: discovery\\n"}\n');
  if (options.completeEvidence !== false) {
    mkdirSync(join(dir, '.work-state', 'features', 'feature-a'), { recursive: true });
    writeFileSync(join(dir, '.work-state', 'features', 'feature-a', 'state.json'), '{}\n');
    writeFileSync(join(dir, '.work-state', 'features', 'feature-a', 'checkpoint.json'), '{}\n');
    writeFileSync(join(dir, '.work-state', 'features', 'feature-a', 'worker.json'), '{}\n');
    mkdirSync(join(dir, 'specs', 'feature-a'), { recursive: true });
    writeFileSync(join(dir, 'specs', 'feature-a', 'spec.md'), '# observed\n');
  }
  return dir;
}

function writeSizedFile(path: string, size: number): void {
  writeFileSync(path, '');
  truncateSync(path, size);
}
function setScenarioDocuments(dir: string, documents: readonly string[]): void {
  const sessionPath = join(dir, '.work-state', 'ux-e2e', 'session.json');
  const session = JSON.parse(readFileSync(sessionPath, 'utf8')) as Record<string, unknown>;
  const scenario = session.scenario as Record<string, unknown>;
  const workspace = scenario.workspace as Record<string, unknown>;
  workspace.documents = [...documents];
  writeFileSync(sessionPath, `${JSON.stringify(session)}\n`);
}

const BASE_INPUT: ReportInput = {
  steps: [],

  defects: [],
  agent_quality: { rating: 4, rationale: 'solid work' },
  verdict: 'PASS',
  overall: { summary: 'good session' },
};

function inputWithScreenshot(path: string): ReportInput {
  return {
    ...BASE_INPUT,
    steps: [{
      name: 'capture',
      order: 1,
      ratings: {},
      defects: [],
      screenshots: [path],
    }],
  };
}

function readSessionRecord(dir: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(dir, '.work-state', 'ux-e2e', 'session.json'), 'utf8')) as Record<string, unknown>;
}

function writeSessionRecord(dir: string, session: Record<string, unknown>): void {
  writeFileSync(join(dir, '.work-state', 'ux-e2e', 'session.json'), `${JSON.stringify(session)}\n`);
}

function assertSelectorFailure(dir: string, reason: string): void {
  assert.throws(
    () => generateReport(dir, { ...BASE_INPUT, verdict: 'FAIL' }),
    (error: unknown) => {
      assert.equal((error as { readonly code?: unknown }).code, 'ux-e2e-report-selector-resolution-failed');
      assert.equal((error as { readonly reason?: unknown }).reason, reason);
      return true;
    },
  );
}

test('report selectors: mixed-source components fail closed instead of being combined', () => {
  const dir = makeSessionDir();
  const session = readSessionRecord(dir);
  const scenario = session.scenario as Record<string, unknown>;
  scenario.selectors = { feature_id: 'feature-a' };
  delete session.selectors;
  session.run_key = 'run-from-top-level';
  writeSessionRecord(dir, session);

  assertSelectorFailure(dir, 'partial');
});

test('report selectors: partial top-level declaration fails closed', () => {
  const dir = makeSessionDir();
  const session = readSessionRecord(dir);
  delete session.scenario;
  session.feature_id = 'feature-a';
  delete session.run_key;
  writeSessionRecord(dir, session);

  assertSelectorFailure(dir, 'partial');
});

test('report selectors: conflicting complete sources fail closed', () => {
  const dir = makeSessionDir();
  const session = readSessionRecord(dir);
  session.selectors = { feature_id: 'feature-b', run_key: 'run-2' };
  writeSessionRecord(dir, session);

  assertSelectorFailure(dir, 'conflicting');
});

test('report selectors: declared pair cannot override a conflicting canonical state pair', () => {
  const dir = makeSessionDir();
  writeFileSync(
    join(dir, '.work-state', 'features', 'feature-a', 'state.json'),
    JSON.stringify({ run_key: 'run-from-state', specification: { feature_id: 'feature-a' } }) + '\n',
  );

  assertSelectorFailure(dir, 'conflicting');
});

test('report selectors: unresolved feature state fails closed', () => {
  const dir = makeSessionDir();
  const session = readSessionRecord(dir);
  const scenario = session.scenario as Record<string, unknown>;
  delete scenario.selectors;
  writeSessionRecord(dir, session);
  writeFileSync(join(dir, '.work-state', 'features', 'feature-a', 'state.json'), JSON.stringify({ run_key: 'run-1' }) + '\n');

  assertSelectorFailure(dir, 'unresolved');
});

test('report selectors: one exact declared pair remains attributable without state identity', () => {
  const dir = makeSessionDir();
  const result = generateReport(dir, BASE_INPUT);
  const report = JSON.parse(readFileSync(result.jsonPath, 'utf8')) as UxE2eReport;

  assert.deepEqual(report.session.selectors, { feature_id: 'feature-a', run_key: 'run-1' });
});

test('report selectors: matching canonical state pair is retained exactly', () => {
  const dir = makeSessionDir();
  writeFileSync(
    join(dir, '.work-state', 'features', 'feature-a', 'state.json'),
    JSON.stringify({ run_key: 'run-1', specification: { feature_id: 'feature-a' } }) + '\n',
  );
  const result = generateReport(dir, BASE_INPUT);
  const report = JSON.parse(readFileSync(result.jsonPath, 'utf8')) as UxE2eReport;

  assert.deepEqual(report.session.selectors, { feature_id: 'feature-a', run_key: 'run-1' });
});

test('report: manual_qa-compatible JSON + markdown written', () => {
  const dir = makeSessionDir();
  mkdirSync(join(dir, 'specs', 'feature-a'), { recursive: true });
  writeFileSync(join(dir, 'specs', 'feature-a', 'spec.md'), '# observed\n');
  const mdDir = mkdtempSync(join(tmpdir(), 'ux-e2e-md-'));
  const result = generateReport(dir, BASE_INPUT, { mdDir });

  assert.ok(existsSync(result.jsonPath), 'report.json written');
  assert.ok(existsSync(result.mdPath), 'markdown written');
  // Filename carries today's UTC date: <slug>-ux-e2e-<YYYY-MM-DD>.md.
  const expectedDate = new Date().toISOString().slice(0, 10);
  assert.ok(
    result.mdPath.endsWith(`my-feature-ux-e2e-${expectedDate}.md`),
    `md filename <slug>-ux-e2e-<date>.md (got ${result.mdPath})`,
  );

  const report = JSON.parse(readFileSync(result.jsonPath, 'utf8')) as UxE2eReport;
  assert.equal(report.type, 'ux-e2e');
  assert.equal(report.schema_version, 1);
  assert.equal(report.mode, 'ui');
  assert.equal(report.verdict, 'PASS');
  assert.equal(report.session.slug, 'my-feature');
  assert.equal(report.session.omp_version, 'omp 17.2.3');
  assert.equal(report.session.profile, 'ux-e2e-test');
  assert.equal(report.session.status, 'stopped');
  assert.equal(report.session.stopped_at, '2026-08-02T10:05:00.000Z');
  assert.equal(report.session.finished_at, report.session.stopped_at);
  assert.equal(report.session.shutdown_error, null);
  assert.deepEqual(report.session.tty, { cols: 100, rows: 30, term: 'xterm-256color' });
  assert.equal(report.session.status, 'stopped');
  assert.equal(report.session.task_prompt, 'implement the feature');
  assert.deepEqual(report.session.scenario, {
    id: 'full-feature',
    title: 'Full feature',
    selectors: { feature_id: 'feature-a', run_key: 'run-1' },
    workspace: {
      path: 'specs/feature-a',
      state_path: '.work-state/features/feature-a/state.json',
      documents: ['specs/feature-a/spec.md'],
    },
    transcript: {
      checkpoints: ['.work-state/features/feature-a/checkpoint.json'],
      workers: ['.work-state/features/feature-a/worker.json'],
    },
  });
  assert.deepEqual(report.session.selectors, { feature_id: 'feature-a', run_key: 'run-1' });
  assert.equal(report.session.workspace, undefined, 'declarations are not promoted to observed workspace evidence');
  assert.ok(report.evidence.some(e => e.endsWith('spec.md')), 'existing declared file is included only after an independent bounded read');
  assert.ok(report.evidence.some(e => e.endsWith('checkpoint.json')), 'all declared checkpoint evidence is independently observed');
  assert.ok(typeof report.generated_at === 'string' && report.generated_at.length > 0);
  assert.ok(Array.isArray(report.evidence) && report.evidence.some(e => e.endsWith('transcript.jsonl')));
  assert.equal(report.overall.recommendation, 'ship');

  const md = readFileSync(result.mdPath, 'utf8');
  assert.ok(md.includes('# UX E2E Report'), 'markdown has the report title');
  assert.ok(md.includes('my-feature'), 'markdown references the slug');
  assert.ok(md.includes('**Verdict:** PASS'), 'markdown carries the verdict');
});
test('report: PASS requires stopped lifecycle proof, no shutdown error, and declared evidence', () => {
  const dir = makeSessionDir();
  const sessionPath = join(dir, '.work-state', 'ux-e2e', 'session.json');
  const readSession = (): Record<string, unknown> => JSON.parse(readFileSync(sessionPath, 'utf8')) as Record<string, unknown>;
  const writeSession = (session: Record<string, unknown>): void => writeFileSync(sessionPath, `${JSON.stringify(session)}\n`);
  const running = readSession();
  running.status = 'running';
  running.pty_exit_observed = false;
  running.shutdown_completed_at = null;
  running.stopped_at = null;
  running.finished_at = null;
  writeSession(running);
  assert.throws(() => generateReport(dir, BASE_INPUT), /PASS requires a stopped session/u);

  const missingEvidence = readSession();
  missingEvidence.status = 'stopped';
  missingEvidence.pty_exit_observed = true;
  missingEvidence.shutdown_completed_at = '2026-08-02T10:05:00.000Z';
  missingEvidence.stopped_at = '2026-08-02T10:05:00.000Z';
  missingEvidence.finished_at = '2026-08-02T10:05:00.000Z';
  missingEvidence.shutdown_error = null;
  rmSync(join(dir, '.work-state', 'features', 'feature-a', 'worker.json'));
  writeSession(missingEvidence);
  assert.throws(() => generateReport(dir, BASE_INPUT), /all declared scenario evidence/u);

  const failed = readSession();
  failed.shutdown_error = 'server close failed';
  writeSession(failed);
  assert.throws(() => generateReport(dir, BASE_INPUT), /PASS requires a stopped session/u);
});
test('report: PASS gates declared evidence at the pinned per-file maximum', () => {
  const atLimit = makeSessionDir();
  const atLimitPath = join(atLimit, 'specs', 'feature-a', 'spec.md');
  writeSizedFile(atLimitPath, MAX_PINNED_READ_BYTES);
  const atLimitMd = mkdtempSync(join(tmpdir(), 'ux-e2e-md-evidence-limit-'));
  const atLimitResult = generateReport(atLimit, BASE_INPUT, { mdDir: atLimitMd, copyEvidence: true });
  const atLimitEvidenceDir = join(atLimitMd, 'evidence', 'my-feature', 'specs', 'feature-a');
  const atLimitCopies = readdirSync(atLimitEvidenceDir).filter(name => name.startsWith('spec.md.'));
  assert.equal(atLimitCopies.length, 1, 'an evidence file at the limit is copied');
  assert.equal(
    readFileSync(join(atLimitEvidenceDir, atLimitCopies[0] ?? '')).length,
    MAX_PINNED_READ_BYTES,
    'the copied evidence retains its complete bounded content',
  );
  assert.ok(existsSync(atLimitResult.jsonPath), 'the PASS report is written for max-sized evidence');

  const oversized = makeSessionDir();
  const oversizedPath = join(oversized, 'specs', 'feature-a', 'spec.md');
  writeSizedFile(oversizedPath, MAX_PINNED_READ_BYTES + 1);
  const oversizedMd = mkdtempSync(join(tmpdir(), 'ux-e2e-md-evidence-oversized-'));
  assert.throws(
    () => generateReport(oversized, BASE_INPUT, { mdDir: oversizedMd, copyEvidence: true }),
    /all declared scenario evidence/u,
  );
  assert.equal(existsSync(join(oversized, '.work-state', 'ux-e2e', 'report.json')), false, 'oversized PASS writes no report');
  assert.deepEqual(readdirSync(oversizedMd), [], 'oversized PASS writes no markdown or copied evidence');
});
test('report: PASS accounts for the inclusive aggregate evidence limit', () => {
  const totalBytes = 64 * 1024 * 1024;
  const documents = Array.from({ length: 8 }, (_, index) => `specs/feature-a/doc-${String(index)}.md`);
  const createAggregateCase = (lastDocumentExtraBytes: number): { dir: string; mdDir: string } => {
    const dir = makeSessionDir();
    setScenarioDocuments(dir, documents);
    const fixedEvidence = [
      join(dir, '.work-state', 'ux-e2e', 'transcript.jsonl'),
      join(dir, '.work-state', 'features', 'feature-a', 'state.json'),
      join(dir, '.work-state', 'features', 'feature-a', 'checkpoint.json'),
      join(dir, '.work-state', 'features', 'feature-a', 'worker.json'),
    ];
    const fixedBytes = fixedEvidence.reduce((total, path) => total + readFileSync(path).length, 0);
    const finalDocumentBytes = totalBytes - fixedBytes - (7 * MAX_PINNED_READ_BYTES) + lastDocumentExtraBytes;
    assert.ok(finalDocumentBytes > 0 && finalDocumentBytes <= MAX_PINNED_READ_BYTES);
    for (let index = 0; index < documents.length; index += 1) {
      const size = index === documents.length - 1 ? finalDocumentBytes : MAX_PINNED_READ_BYTES;
      writeSizedFile(join(dir, documents[index] ?? ''), size);
    }
    return { dir, mdDir: mkdtempSync(join(tmpdir(), 'ux-e2e-md-evidence-aggregate-')) };
  };

  const atLimit = createAggregateCase(0);
  const result = generateReport(atLimit.dir, BASE_INPUT, { mdDir: atLimit.mdDir, copyEvidence: true });
  const report = JSON.parse(readFileSync(result.jsonPath, 'utf8')) as UxE2eReport;
  assert.equal(
    report.evidence.filter(path => /\/doc-[0-7]\.md\.[0-9a-f]{16}$/u.test(path)).length,
    documents.length,
    'every declared document at the aggregate limit is copied',
  );

  const oversized = createAggregateCase(1);
  assert.throws(
    () => generateReport(oversized.dir, BASE_INPUT, { mdDir: oversized.mdDir, copyEvidence: true }),
    /aggregate evidence byte limit/u,
  );
  assert.equal(existsSync(join(oversized.dir, '.work-state', 'ux-e2e', 'report.json')), false, 'aggregate overflow writes no report');
  assert.deepEqual(readdirSync(oversized.mdDir), [], 'aggregate overflow writes no markdown or copied evidence');
});

test('report: terminal controls are stripped from human sinks but raw evidence is preserved', () => {
  const dir = makeSessionDir();
  const mdDir = mkdtempSync(join(tmpdir(), 'ux-e2e-md-controls-'));
  const control = '\u001b]0;operator-window\u0007\r';
  const result = generateReport(dir, {
    ...BASE_INPUT,
    overall: { summary: `summary line one\nsummary | [untrusted] ${control}` },
    agent_quality: { rating: 4, rationale: `rationale ${control}` },
    defects: [{
      severity: 'LOW',
      dimension: 'layout',
      title: `title ${control}`,
      step: 'S1',
      evidence: [`raw-evidence${control}`],
    }],
  }, { mdDir });
  const report = JSON.parse(readFileSync(result.jsonPath, 'utf8')) as UxE2eReport;
  assert.ok(!report.overall.summary.includes('\u001b'));
  assert.ok(report.defects[0]?.title.includes('operator-window') === false);
  assert.equal(report.defects[0]?.evidence[0], `raw-evidence${control}`);
  const markdown = readFileSync(result.mdPath, 'utf8');
  assert.equal(markdown.includes('\u001b'), false);
  assert.equal(markdown.includes('operator-window'), false);
  assert.ok(markdown.includes('summary line one\nsummary \\| \\[untrusted\\]'));
});

test('report: CRITICAL defect floors cap the step rating and overall score', () => {
  const dir = makeSessionDir();
  const result = generateReport(dir, {
    ...BASE_INPUT,
    verdict: 'CONDITIONAL',
    steps: [
      { name: 'Clarify', order: 1, ratings: { message_clarity: 5, feedback_timing: 5 }, defects: ['D1'], screenshots: [] },
      { name: 'Implement', order: 2, ratings: { message_clarity: 4 }, defects: [], screenshots: [] },
    ],
    defects: [
      { severity: 'CRITICAL', dimension: 'message_clarity', title: 'crash on ask', step: 'S1', evidence: ['transcript.jsonl'] },
    ],
  }, { mdDir: dir });

  const report = JSON.parse(readFileSync(result.jsonPath, 'utf8')) as UxE2eReport;
  const step1 = report.steps.find(s => s.order === 1);
  const step2 = report.steps.find(s => s.order === 2);
  assert.ok(step1 !== undefined && step1.ratings.message_clarity === 1, 'CRITICAL floor caps at 1');
  assert.ok(step1 !== undefined && step1.ratings.feedback_timing === 1, 'every dimension is floored');
  assert.ok(step2 !== undefined && step2.ratings.message_clarity === 4, 'no defect -> rating untouched');
  assert.equal(report.overall.score, 1, 'worst defect floor caps the overall score');
  assert.equal(report.overall.recommendation, 'rework');
  assert.ok(result.warnings.some(w => w.includes('defect floor')), 'clamps emit warnings');
});

test('report: LOW defect floor caps at 4, agent_quality not floored', () => {
  const dir = makeSessionDir();
  const result = generateReport(dir, {
    ...BASE_INPUT,
    steps: [
      { name: 'Implement', order: 1, ratings: { message_clarity: 5 }, defects: ['D1'], screenshots: [] },
    ],
    defects: [
      { severity: 'LOW', dimension: 'layout', title: 'cosmetic gap', step: 'S1', evidence: [] },
    ],
  }, { mdDir: dir });

  const report = JSON.parse(readFileSync(result.jsonPath, 'utf8')) as UxE2eReport;
  assert.equal(report.steps[0]?.ratings.message_clarity, 4, 'LOW floor caps at 4');
  assert.equal(report.agent_quality.rating, 4, 'agent quality keeps its own rating');
  assert.equal(report.overall.score, 4, 'overall follows the LOW floor');
});

test('report: auto-ids assigned when omitted', () => {
  const dir = makeSessionDir();
  const result = generateReport(dir, {
    ...BASE_INPUT,
    steps: [{ name: 'Solo', order: 1, ratings: { layout: 3 }, defects: ['D1'], screenshots: [] }],
    defects: [{ severity: 'MEDIUM', dimension: 'layout', title: 'overlap', step: 'S1', evidence: [] }],
  }, { mdDir: dir });

  const report = JSON.parse(readFileSync(result.jsonPath, 'utf8')) as UxE2eReport;
  assert.equal(report.steps[0]?.id, 'S1');
  assert.equal(report.defects[0]?.id, 'D1');
  assert.equal(report.steps[0]?.ratings.layout, 3, 'MEDIUM floor 3 clamps nothing here');
});

test('report: copyEvidence mirrors safe evidence but never session credentials', () => {
  const dir = makeSessionDir();
  const mdDir = mkdtempSync(join(tmpdir(), 'ux-e2e-md-'));
  const options = { mdDir, copyEvidence: true };
  const result = generateReport(dir, BASE_INPUT, options);
  const report = JSON.parse(readFileSync(result.jsonPath, 'utf8')) as UxE2eReport;
  const firstCopied = readdirSync(join(mdDir, 'evidence', 'my-feature', 'ux-e2e')).sort();
  const second = generateReport(dir, BASE_INPUT, options);
  const evidenceDir = join(mdDir, 'evidence', 'my-feature', 'ux-e2e');
  const copied = readdirSync(evidenceDir).sort();
  assert.deepEqual(copied, firstCopied, 'repeating copyEvidence is idempotent');
  assert.equal(second.mdPath, result.mdPath, 'repeating report generation reuses the same markdown path');
  assert.ok(copied.some(name => /^transcript\.jsonl\.[0-9a-f]{16}$/u.test(name)), 'transcript mirrored with content hash');
  assert.equal(copied.some(name => /^session\.json\.[0-9a-f]{16}$/u.test(name)), false, 'raw session metadata is not mirrored');
  assert.equal(report.evidence.some(path => path.endsWith('/session.json')), false, 'raw session metadata is not listed as evidence');
  assert.equal(report.session.status, 'stopped');
  assert.equal(report.session.started_at, '2026-08-02T10:00:00.000Z');
  assert.equal(report.session.stopped_at, '2026-08-02T10:05:00.000Z');
  assert.equal(report.session.finished_at, report.session.stopped_at);
  const rendered = `${readFileSync(result.jsonPath, 'utf8')}\n${readFileSync(result.mdPath, 'utf8')}`;
  for (const secret of ['fixture-bearer-secret', 'fixture-control-secret', 'fixture-startup-secret']) {
    assert.equal(rendered.includes(secret), false, `report sinks omit ${secret}`);
  }
  for (const name of copied) {
    const bytes = readFileSync(join(evidenceDir, name), 'utf8');
    assert.equal(bytes.includes('fixture-bearer-secret'), false, `${name} omits bearer credential`);
    assert.equal(bytes.includes('fixture-control-secret'), false, `${name} omits control credential`);
    assert.equal(bytes.includes('fixture-startup-secret'), false, `${name} omits startup credential`);
  }
});

test('report: PASS blocks outside, leaf-symlink, and ancestor-symlink screenshots', () => {
  const dir = makeSessionDir();
  const outsideDir = mkdtempSync(join(tmpdir(), 'ux-e2e-report-outside-'));
  const outsideLeaf = join(outsideDir, 'leaf-secret.txt');
  const outsideAncestor = join(outsideDir, 'ancestor-secret.txt');
  const outsideDirect = join(outsideDir, 'direct-secret.txt');
  writeFileSync(outsideLeaf, 'leaf secret');
  writeFileSync(outsideAncestor, 'ancestor secret');
  writeFileSync(outsideDirect, 'direct secret');

  const leaf = join(dir, 'leaf-secret.txt');
  symlinkSync(outsideLeaf, leaf);
  const ancestor = join(dir, 'ancestor');
  symlinkSync(outsideDir, ancestor);
  const ancestorPath = join(ancestor, 'ancestor-secret.txt');
  const oversized = join(dir, 'oversized.png');
  writeSizedFile(oversized, MAX_PINNED_READ_BYTES + 1);
  const nonregular = join(dir, 'not-a-file');
  mkdirSync(nonregular);
  const unreadable = join(dir, 'missing.png');
  for (const screenshot of [leaf, ancestorPath, outsideDirect, oversized, nonregular, unreadable]) {
    const mdDir = mkdtempSync(join(tmpdir(), 'ux-e2e-md-unsafe-screenshot-'));
    assert.throws(
      () => generateReport(dir, inputWithScreenshot(screenshot), { mdDir, copyEvidence: true }),
      /all declared screenshots/u,
    );
    assert.deepEqual(readdirSync(mdDir), [], 'unsafe screenshot writes no report or copied evidence');
  }

  assert.equal(readFileSync(outsideLeaf, 'utf8'), 'leaf secret');
  assert.equal(readFileSync(outsideAncestor, 'utf8'), 'ancestor secret');
  assert.equal(readFileSync(outsideDirect, 'utf8'), 'direct secret');
});

test('report: copyEvidence rejects a source swapped for a symlink at open time', () => {
  const dir = makeSessionDir();
  const outsideDir = mkdtempSync(join(tmpdir(), 'ux-e2e-report-swap-outside-'));
  const outside = join(outsideDir, 'swap-secret.txt');
  writeFileSync(outside, 'must not be copied');
  const source = join(dir, 'swap-secret.txt');
  writeFileSync(source, 'safe source');
  const mdDir = mkdtempSync(join(tmpdir(), 'ux-e2e-md-'));
  let swapped = false;
  setEvidenceCopyTestHooks({
    beforeSourceOpen(path) {
      if (path !== source || swapped) return;
      swapped = true;
      const replacement = join(dir, 'swap-link');
      symlinkSync(outside, replacement);
      renameSync(replacement, source);
    },
  });
  let result: GenerateReportResult | undefined;
  try {
    result = generateReport(dir, { ...inputWithScreenshot(source), verdict: 'FAIL' }, { mdDir, copyEvidence: true });
  } finally {
    setEvidenceCopyTestHooks(null);
  }

  assert.equal(swapped, true, 'the test swaps the pathname immediately before open');
  assert.equal(readFileSync(outside, 'utf8'), 'must not be copied');
  assert.equal(existsSync(join(mdDir, 'evidence', 'my-feature', 'swap-secret.txt')), false);
  if (result === undefined) throw new Error('report generation did not return a result');
  const report = JSON.parse(readFileSync(result.jsonPath, 'utf8')) as UxE2eReport;
  assert.equal(report.evidence.some(path => path.endsWith('swap-secret.txt')), false);
});

test('report: tainted session slugs are rejected before any output write', () => {
  const dir = makeSessionDir();
  const sessionPath = join(dir, '.work-state', 'ux-e2e', 'session.json');
  const session = JSON.parse(readFileSync(sessionPath, 'utf8')) as Record<string, unknown>;
  session.slug = '../escape';
  writeFileSync(sessionPath, JSON.stringify(session) + '\n');
  const mdDir = mkdtempSync(join(tmpdir(), 'ux-e2e-md-tainted-'));

  assert.throws(
    () => generateReport(dir, BASE_INPUT, { mdDir, copyEvidence: true }),
    /session slug must be a bounded safe filename segment/u,
  );
  assert.equal(existsSync(join(mdDir, 'escape-ux-e2e.md')), false);
});

test('report: symlinked report/evidence targets cannot redirect writes', () => {
  const dir = makeSessionDir();
  const outside = mkdtempSync(join(tmpdir(), 'ux-e2e-report-target-outside-'));
  const outsideReport = join(outside, 'my-feature-ux-e2e-report.md');
  writeFileSync(outsideReport, 'sentinel');
  const reportLink = join(dir, 'report-target-link');
  symlinkSync(outside, reportLink);

  assert.throws(
    () => generateReport(dir, BASE_INPUT, { mdDir: reportLink, copyEvidence: true }),
    /report destination root must be a stable non-symlink directory/u,
  );
  assert.equal(readFileSync(outsideReport, 'utf8'), 'sentinel');

  const mdDir = mkdtempSync(join(tmpdir(), 'ux-e2e-md-evidence-link-'));
  mkdirSync(join(mdDir, 'evidence'));
  symlinkSync(outside, join(mdDir, 'evidence', 'my-feature'));
  const result = generateReport(dir, BASE_INPUT, { mdDir, copyEvidence: true });
  assert.equal(existsSync(join(outside, 'transcript.jsonl')), false);
  const report = JSON.parse(readFileSync(result.jsonPath, 'utf8')) as UxE2eReport;
  assert.equal(report.evidence.some(path => path.includes('evidence')), false);
});

test('report: evidence target swap is rejected before opening a destination leaf', () => {
  const dir = makeSessionDir();
  const mdDir = mkdtempSync(join(tmpdir(), 'ux-e2e-md-target-swap-'));
  const outside = mkdtempSync(join(tmpdir(), 'ux-e2e-report-target-swap-outside-'));
  const outsideTranscript = join(outside, 'transcript.jsonl');
  writeFileSync(outsideTranscript, 'sentinel');
  const targetDir = join(mdDir, 'evidence', 'my-feature', 'ux-e2e');
  const movedDir = join(mdDir, 'evidence', 'moved-target');
  let swapped = false;
  setEvidenceCopyTestHooks({
    beforeTargetOpen(path) {
      if (swapped || !path.startsWith(join(targetDir, 'transcript.jsonl.'))) return;
      swapped = true;
      renameSync(targetDir, movedDir);
      symlinkSync(outside, targetDir);
    },
  });
  let result: GenerateReportResult | undefined;
  try {
    result = generateReport(dir, BASE_INPUT, { mdDir, copyEvidence: true });
  } finally {
    setEvidenceCopyTestHooks(null);
  }

  assert.equal(swapped, true, 'the test swaps the pinned target immediately before open');
  assert.equal(readFileSync(outsideTranscript, 'utf8'), 'sentinel');
  if (result === undefined) throw new Error('report generation did not return a result');
  const report = JSON.parse(readFileSync(result.jsonPath, 'utf8')) as UxE2eReport;
  assert.equal(report.evidence.some(path => path.endsWith('transcript.jsonl')), false);
});
test('report: leaf symlink destination is replaced without touching its target', () => {
  const dir = makeSessionDir();
  const mdDir = mkdtempSync(join(tmpdir(), 'ux-e2e-md-leaf-link-'));
  const outside = mkdtempSync(join(tmpdir(), 'ux-e2e-report-leaf-outside-'));
  const outsideTarget = join(outside, 'external.md');
  writeFileSync(outsideTarget, 'sentinel');
  const expectedDate = new Date().toISOString().slice(0, 10);
  const destination = join(mdDir, `my-feature-ux-e2e-${expectedDate}.md`);
  symlinkSync(outsideTarget, destination);

  const result = generateReport(dir, BASE_INPUT, { mdDir });

  assert.equal(readFileSync(outsideTarget, 'utf8'), 'sentinel');
  assert.equal(readFileSync(result.mdPath, 'utf8').includes('# UX E2E Report'), true);
});

test('report: pre-existing hard links are replaced, never truncated', () => {
  const dir = makeSessionDir();
  const mdDir = mkdtempSync(join(tmpdir(), 'ux-e2e-md-hard-link-'));
  const outside = mkdtempSync(join(tmpdir(), 'ux-e2e-report-hard-link-outside-'));
  const outsideMarkdown = join(outside, 'external.md');
  const outsideJson = join(outside, 'external.json');
  writeFileSync(outsideMarkdown, 'markdown sentinel');
  writeFileSync(outsideJson, 'json sentinel');
  const expectedDate = new Date().toISOString().slice(0, 10);
  const markdownDestination = join(mdDir, `my-feature-ux-e2e-${expectedDate}.md`);
  const jsonDestination = join(dir, '.work-state', 'ux-e2e', 'report.json');
  linkSync(outsideMarkdown, markdownDestination);
  linkSync(outsideJson, jsonDestination);

  const result = generateReport(dir, BASE_INPUT, { mdDir });

  assert.equal(readFileSync(outsideMarkdown, 'utf8'), 'markdown sentinel');
  assert.equal(readFileSync(outsideJson, 'utf8'), 'json sentinel');
  assert.equal(readFileSync(result.mdPath, 'utf8').includes('# UX E2E Report'), true);
  assert.equal(JSON.parse(readFileSync(result.jsonPath, 'utf8')).type, 'ux-e2e');
});

test('report: rename-window ancestor swap cannot redirect markdown publish', () => {
  const dir = makeSessionDir();
  const mdDir = mkdtempSync(join(tmpdir(), 'ux-e2e-md-rename-race-'));
  const movedDir = `${mdDir}.moved`;
  const outside = mkdtempSync(join(tmpdir(), 'ux-e2e-report-rename-outside-'));
  const outsideTarget = join(outside, 'external.md');
  writeFileSync(outsideTarget, 'rename sentinel');
  const expectedDate = new Date().toISOString().slice(0, 10);
  const destination = join(mdDir, `my-feature-ux-e2e-${expectedDate}.md`);
  let swapped = false;
  setEvidenceCopyTestHooks({
    beforeTargetRename(path) {
      if (swapped || path !== destination) return;
      swapped = true;
      renameSync(mdDir, movedDir);
      symlinkSync(outside, mdDir);
    },
  });
  try {
    assert.throws(
      () => generateReport(dir, BASE_INPUT, { mdDir }),
      /failed to write markdown/u,
    );
  } finally {
    setEvidenceCopyTestHooks(null);
    if (swapped) {
      unlinkSync(mdDir);
      renameSync(movedDir, mdDir);
    }
  }

  assert.equal(swapped, true);
  assert.equal(readFileSync(outsideTarget, 'utf8'), 'rename sentinel');
  assert.equal(existsSync(join(outside, `my-feature-ux-e2e-${expectedDate}.md`)), false);
});

test('report: unsupported descriptor-relative API fails closed', () => {
  const dir = makeSessionDir();
  const mdDir = mkdtempSync(join(tmpdir(), 'ux-e2e-md-unsupported-'));
  const originalPlatform = process.platform;
  Object.defineProperty(process, 'platform', { configurable: true, value: 'freebsd' });
  try {
    assert.throws(
      () => generateReport(dir, { ...BASE_INPUT, verdict: 'CONDITIONAL' }, { mdDir }),
      /report destination root|failed to write report\.json inside the session directory/u,
    );
  } finally {
    Object.defineProperty(process, 'platform', { configurable: true, value: originalPlatform });
  }
  const expectedDate = new Date().toISOString().slice(0, 10);
  assert.equal(existsSync(join(mdDir, `my-feature-ux-e2e-${expectedDate}.md`)), false);
});
test('report: descriptor-relative directory walk rejects an ancestor swap', () => {
  const dir = makeSessionDir();
  const mdDir = mkdtempSync(join(tmpdir(), 'ux-e2e-md-component-race-'));
  const outside = mkdtempSync(join(tmpdir(), 'ux-e2e-report-component-outside-'));
  const outsideTarget = join(outside, 'transcript.jsonl');
  writeFileSync(outsideTarget, 'component sentinel');
  const evidenceDir = join(mdDir, 'evidence');
  mkdirSync(evidenceDir);
  const movedEvidenceDir = `${evidenceDir}.moved`;
  let swapped = false;
  setEvidenceCopyTestHooks({
    beforeDirectoryComponent(path) {
      if (swapped || !path.endsWith('/evidence')) return;
      swapped = true;
      renameSync(evidenceDir, movedEvidenceDir);
      symlinkSync(outside, evidenceDir);
    },
  });
  try {
    const result = generateReport(dir, BASE_INPUT, { mdDir, copyEvidence: true });
    const report = JSON.parse(readFileSync(result.jsonPath, 'utf8')) as UxE2eReport;
    assert.equal(report.evidence.some(path => path.includes('/evidence/')), false);
  } finally {
    setEvidenceCopyTestHooks(null);
    if (swapped) {
      unlinkSync(evidenceDir);
      renameSync(movedEvidenceDir, evidenceDir);
    }
  }

  assert.equal(readFileSync(outsideTarget, 'utf8'), 'component sentinel');
  assert.equal(existsSync(join(outside, 'my-feature')), false);
});
test('report: final directory identity is rechecked after the helper walk', () => {
  const dir = makeSessionDir();
  const mdDir = mkdtempSync(join(tmpdir(), 'ux-e2e-md-helper-race-'));
  const attackerDir = mkdtempSync(join(tmpdir(), 'ux-e2e-report-helper-outside-'));
  writeFileSync(join(attackerDir, 'attacker-sentinel'), 'helper sentinel');
  const targetDir = join(mdDir, 'evidence', 'my-feature');
  // The Linux walk opens the final component in this seam; keep it present
  // there so the test can perform the same replacement on both platforms.
  if (process.platform !== 'darwin') mkdirSync(targetDir, { recursive: true });
  const movedTargetDir = `${targetDir}.moved`;
  let swapped = false;
  setEvidenceCopyTestHooks({
    beforeDirectoryOpen(path) {
      if (swapped || path !== targetDir) return;
      swapped = true;
      renameSync(targetDir, movedTargetDir);
      renameSync(attackerDir, targetDir);
    },
  });
  try {
    const result = generateReport(dir, BASE_INPUT, { mdDir, copyEvidence: true });
    const report = JSON.parse(readFileSync(result.jsonPath, 'utf8')) as UxE2eReport;
    assert.equal(report.evidence.some(path => path.includes('/evidence/')), false);
  } finally {
    setEvidenceCopyTestHooks(null);
    if (swapped) {
      renameSync(targetDir, attackerDir);
      renameSync(movedTargetDir, targetDir);
    }
  }

  assert.equal(swapped, true);
  assert.equal(readFileSync(join(attackerDir, 'attacker-sentinel'), 'utf8'), 'helper sentinel');
  assert.equal(existsSync(join(attackerDir, 'transcript.jsonl')), false);
});

test('report suite: deterministic child sessions aggregate and copy evidence per child', () => {
  const suite = mkdtempSync(join(tmpdir(), 'omp-ux-e2e-readable-spec-workflow-'));
  const first = makeSessionDir();
  const second = makeSessionDir();
  renameSync(first, join(suite, 'session-a'));
  renameSync(second, join(suite, 'session-b'));
  const mdDir = mkdtempSync(join(tmpdir(), 'ux-e2e-suite-md-'));
  try {
    const result = generateReport(suite, BASE_INPUT, { mdDir, copyEvidence: true });
    const report = JSON.parse(readFileSync(result.jsonPath, 'utf8')) as UxE2eReport;
    const children = report.session.child_sessions ?? [];
    assert.deepEqual(children.map(child => basename(child.scratch_dir)), ['session-a', 'session-b']);
    assert.equal(children.length, 2);
    assert.match(children[0]!.evidence[0] ?? '', /evidence\/session-a\//u);
    assert.match(children[1]!.evidence[0] ?? '', /evidence\/session-b\//u);
    assert.equal(new Set(report.evidence).size, report.evidence.length);
    assert.match(readFileSync(result.mdPath, 'utf8'), /## Child sessions/u);
  } finally {
    rmSync(suite, { recursive: true, force: true });
    rmSync(mdDir, { recursive: true, force: true });
  }
});

test('report suite: symlink and malformed children are rejected instead of omitted', () => {
  const suite = mkdtempSync(join(tmpdir(), 'omp-ux-e2e-readable-spec-workflow-'));
  const target = makeSessionDir();
  symlinkSync(target, join(suite, 'session-link'), 'dir');
  assert.throws(() => generateReport(suite, BASE_INPUT), /must not be a symlink/u);
  unlinkSync(join(suite, 'session-link'));
  rmSync(target, { recursive: true, force: true });
  mkdirSync(join(suite, 'malformed', '.work-state', 'ux-e2e'), { recursive: true });
  assert.throws(() => generateReport(suite, BASE_INPUT), /malformed suite child malformed/u);
  rmSync(suite, { recursive: true, force: true });
});

test('report suite: PASS requires readiness for every child before root output', () => {
  const suite = mkdtempSync(join(tmpdir(), 'omp-ux-e2e-readable-spec-workflow-'));
  const ready = makeSessionDir();
  const incomplete = makeSessionDir({ completeEvidence: false });
  renameSync(ready, join(suite, 'ready'));
  renameSync(incomplete, join(suite, 'incomplete'));
  try {
    assert.throws(() => generateReport(suite, BASE_INPUT), /PASS requires/u);
    assert.equal(existsSync(join(suite, '.work-state', 'ux-e2e', 'report.json')), false);
  } finally {
    rmSync(suite, { recursive: true, force: true });
  }
});
