/**
 * Report tests: defect-floor clamping, manual_qa-compatible fields,
 * markdown output, and evidence collection/copying.
 */

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, linkSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, symlinkSync, truncateSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, sep } from 'node:path';
import { test } from 'node:test';

import {
  generateReport,
  setEvidenceCopyTestHooks,
  type GenerateReportResult,
  type UxE2eReport,
  type ReportInput,
} from '../src/report.js';
import { closePinnedDirectory, MAX_PINNED_READ_BYTES, pinDirectory, setFsSafetyTestHooks, unlinkPinnedFileIfExact, withPinnedExclusiveLock, writePinnedFile } from '../src/fs-safety.js';

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
test('report: PASS rejects mandatory evidence that disappears after collection', () => {
  const dir = makeSessionDir();
  const transcript = join(dir, '.work-state', 'ux-e2e', 'transcript.jsonl');
  const mdDir = mkdtempSync(join(tmpdir(), 'ux-e2e-mandatory-evidence-md-'));
  let deleted = false;
  setEvidenceCopyTestHooks({
    beforeMandatoryEvidenceCheck(path, phase) {
      if (!deleted && phase === 'after evidence collection' && path === transcript) {
        deleted = true;
        unlinkSync(transcript);
      }
    },
  });
  try {
    assert.throws(
      () => generateReport(dir, BASE_INPUT, { mdDir }),
      /PASS mandatory evidence is missing or unsafe/u,
    );
    assert.equal(existsSync(join(dir, '.work-state', 'ux-e2e', 'report.json')), false);
    assert.equal(deleted, true);
  } finally {
    setFsSafetyTestHooks(null);
    rmSync(dir, { recursive: true, force: true });
    rmSync(mdDir, { recursive: true, force: true });
  }
});

test('report suite: PASS rejects mandatory child evidence that disappears after collection', () => {
  const suite = mkdtempSync(join(tmpdir(), 'omp-ux-e2e-mandatory-evidence-suite-'));
  const child = makeSessionDir();
  renameSync(child, join(suite, 'session-a'));
  const transcript = join(suite, 'session-a', '.work-state', 'ux-e2e', 'transcript.jsonl');
  const mdDir = mkdtempSync(join(tmpdir(), 'ux-e2e-mandatory-evidence-suite-md-'));
  let deleted = false;
  setEvidenceCopyTestHooks({
    beforeMandatoryEvidenceCheck(path, phase) {
      if (!deleted && phase === 'after evidence collection' && path === transcript) {
        deleted = true;
        unlinkSync(transcript);
      }
    },
  });
  try {
    assert.throws(
      () => generateReport(suite, BASE_INPUT, { mdDir }),
      /PASS mandatory evidence is missing or unsafe/u,
    );
    assert.equal(existsSync(join(suite, '.work-state', 'ux-e2e', 'report.json')), false);
    assert.equal(deleted, true);
  } finally {
    setFsSafetyTestHooks(null);
    rmSync(suite, { recursive: true, force: true });
    rmSync(mdDir, { recursive: true, force: true });
  }
});


test('report suite: PASS rolls back when mandatory child evidence disappears after aggregation', () => {
  const suite = mkdtempSync(join(tmpdir(), 'omp-ux-e2e-mandatory-evidence-fence-suite-'));
  const child = makeSessionDir();
  renameSync(child, join(suite, 'session-a'));
  const transcript = join(suite, 'session-a', '.work-state', 'ux-e2e', 'transcript.jsonl');
  const reportPath = join(suite, '.work-state', 'ux-e2e', 'report.json');
  const mdDir = mkdtempSync(join(tmpdir(), 'ux-e2e-mandatory-evidence-fence-md-'));
  let deleted = false;
  setFsSafetyTestHooks({
    beforeTargetOpen(path) {
      if (!deleted && path === reportPath) {
        deleted = true;
        unlinkSync(transcript);
      }
    },
  });
  try {
    assert.throws(
      () => generateReport(suite, BASE_INPUT, { mdDir }),
      /PASS mandatory evidence is missing or unsafe/u,
    );
    assert.equal(deleted, true);
    assert.equal(existsSync(reportPath), false, 'suite JSON is rolled back');
    assert.deepEqual(readdirSync(mdDir), [], 'suite markdown is not published');
  } finally {
    setFsSafetyTestHooks(null);
    rmSync(suite, { recursive: true, force: true });
    rmSync(mdDir, { recursive: true, force: true });
  }
});


test('report: PASS accepts screenshot paths relative to the retained session root', () => {
  const dir = makeSessionDir();
  const screenshot = join(dir, 'screenshots', 'capture.png');
  mkdirSync(dirname(screenshot), { recursive: true });
  writeFileSync(screenshot, 'png fixture');
  const mdDir = mkdtempSync(join(tmpdir(), 'ux-e2e-relative-screenshot-md-'));
  try {
    const result = generateReport(dir, inputWithScreenshot('screenshots/capture.png'), { mdDir });
    const report = JSON.parse(readFileSync(result.jsonPath, 'utf8')) as UxE2eReport;
    assert.ok(report.evidence.includes(screenshot));
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(mdDir, { recursive: true, force: true });
  }
});

test('report: PASS rejects relative mandatory evidence that escapes the session root', () => {
  const dir = makeSessionDir();
  const outside = mkdtempSync(join(tmpdir(), 'ux-e2e-relative-escape-'));
  const screenshot = join(outside, 'capture.png');
  writeFileSync(screenshot, 'png fixture');
  const mdDir = mkdtempSync(join(tmpdir(), 'ux-e2e-relative-escape-md-'));
  try {
    assert.throws(
      () => generateReport(dir, inputWithScreenshot(`../${basename(outside)}/capture.png`), { mdDir }),
      /all declared screenshots/u,
    );
    assert.equal(existsSync(join(dir, '.work-state', 'ux-e2e', 'report.json')), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
    rmSync(mdDir, { recursive: true, force: true });
  }
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

test('report: declared session metadata is excluded and nested scenario keys are projected safely', () => {
  const dir = makeSessionDir();
  const session = readSessionRecord(dir);
  const scenario = session.scenario as Record<string, unknown>;
  const workspace = scenario.workspace as Record<string, unknown>;
  workspace.evidence = ['.work-state/ux-e2e/session.json'];
  workspace.token = 'fixture-bearer-secret';
  writeSessionRecord(dir, session);
  const mdDir = mkdtempSync(join(tmpdir(), 'ux-e2e-md-'));
  try {
    const result = generateReport(dir, { ...BASE_INPUT, verdict: 'FAIL' }, { mdDir, copyEvidence: true });
    const report = JSON.parse(readFileSync(result.jsonPath, 'utf8')) as UxE2eReport;
    assert.equal(report.evidence.some(path => path.endsWith('/session.json')), false);
    assert.equal(JSON.stringify(report.session.scenario).includes('fixture-bearer-secret'), false);
    assert.equal(JSON.stringify(report.session.scenario).includes('token'), false);
    const copied = readdirSync(join(mdDir, 'evidence', 'my-feature', 'ux-e2e'));
    assert.equal(copied.some(name => name.startsWith('session.json.')), false);
    assert.equal(JSON.stringify(report).includes('fixture-bearer-secret'), false);
  } finally {
    rmSync(mdDir, { recursive: true, force: true });
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
  );
  assert.equal(readFileSync(outsideReport, 'utf8'), 'sentinel');

  const mdDir = mkdtempSync(join(tmpdir(), 'ux-e2e-md-evidence-link-'));
  mkdirSync(join(mdDir, 'evidence'));
  symlinkSync(outside, join(mdDir, 'evidence', 'my-feature'));
  assert.throws(() => generateReport(dir, BASE_INPUT, { mdDir, copyEvidence: true }));
  assert.equal(existsSync(join(outside, 'transcript.jsonl')), false);
  assert.equal(existsSync(join(dir, '.work-state', 'ux-e2e', 'report.json')), false);
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
  try {
    assert.throws(() => generateReport(dir, BASE_INPUT, { mdDir, copyEvidence: true }));
  } finally {
    setEvidenceCopyTestHooks(null);
  }

  assert.equal(swapped, true, 'the test swaps the pinned target immediately before open');
  assert.equal(readFileSync(outsideTranscript, 'utf8'), 'sentinel');
  assert.equal(existsSync(join(dir, '.work-state', 'ux-e2e', 'report.json')), false);
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

  assert.throws(() => generateReport(dir, BASE_INPUT, { mdDir }));

  assert.equal(readFileSync(outsideTarget, 'utf8'), 'sentinel');
  assert.equal(existsSync(join(dir, '.work-state', 'ux-e2e', 'report.json')), false);
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

  assert.throws(() => generateReport(dir, BASE_INPUT, { mdDir }));

  assert.equal(readFileSync(outsideMarkdown, 'utf8'), 'markdown sentinel');
  assert.equal(readFileSync(outsideJson, 'utf8'), 'json sentinel');
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
  // Remove the root marker so discovery reaches the unsupported destination API
  // instead of classifying the fixture as malformed root metadata.
  unlinkSync(join(dir, '.work-state', 'ux-e2e', 'session.json'));
  const mdDir = mkdtempSync(join(tmpdir(), 'ux-e2e-md-unsupported-'));
  const originalPlatform = process.platform;
  Object.defineProperty(process, 'platform', { configurable: true, value: 'freebsd' });
  try {
    assert.throws(
      () => generateReport(dir, { ...BASE_INPUT, verdict: 'CONDITIONAL' }, { mdDir }),
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
    assert.throws(() => generateReport(dir, BASE_INPUT, { mdDir, copyEvidence: true }));
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
  // Keep the final component present so the test can perform the same replacement
  // on every platform before the retained descriptor identity check.
  mkdirSync(targetDir, { recursive: true });
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
    assert.throws(() => generateReport(dir, BASE_INPUT, { mdDir, copyEvidence: true }));
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

test('report suite: all suite locks release after success and throw paths', () => {
  const suite = mkdtempSync(join(tmpdir(), 'omp-ux-e2e-lock-release-'));
  const first = makeSessionDir();
  const second = makeSessionDir();
  renameSync(first, join(suite, 'session-a'));
  renameSync(second, join(suite, 'session-b'));
  const mdDir = mkdtempSync(join(tmpdir(), 'ux-e2e-lock-release-md-'));
  let failOnce = true;
  setEvidenceCopyTestHooks({
    beforeSourceOpen() {
      if (failOnce) {
        failOnce = false;
        throw new Error('injected suite failure');
      }
    },
  });
  try {
    assert.throws(() => generateReport(suite, { ...BASE_INPUT, verdict: 'PASS' }, { mdDir }), /injected suite failure/u);
  } finally {
    setEvidenceCopyTestHooks(null);
  }
  try {
    const firstResult = generateReport(suite, { ...BASE_INPUT, verdict: 'PASS' }, { mdDir });
    const secondResult = generateReport(suite, { ...BASE_INPUT, verdict: 'PASS' }, { mdDir });
    assert.ok(existsSync(firstResult.jsonPath));
    assert.ok(existsSync(secondResult.jsonPath));
  } finally {
    rmSync(suite, { recursive: true, force: true });
    rmSync(mdDir, { recursive: true, force: true });
  }
});


test('report suite: child reporter contention is serialized by retained child root lock', () => {
  const suite = mkdtempSync(join(tmpdir(), 'omp-ux-e2e-child-lock-contention-'));
  const child = makeSessionDir();
  const childPath = join(suite, 'session-a');
  renameSync(child, childPath);
  const mdDir = mkdtempSync(join(tmpdir(), 'ux-e2e-child-lock-contention-md-'));
  let nested = false;
  let nestedError: unknown = null;
  setEvidenceCopyTestHooks({
    beforeSourceOpen(path) {
      if (nested || !path.startsWith(childPath + sep)) return;
      nested = true;
      try {
        generateReport(childPath, BASE_INPUT, { mdDir, copyEvidence: true });
      } catch (error) {
        nestedError = error;
      }
    },
  });
  try {
    const result = generateReport(suite, BASE_INPUT, { mdDir, copyEvidence: true });
    const report = JSON.parse(readFileSync(result.jsonPath, 'utf8')) as UxE2eReport;
    assert.match(String(nestedError), /pinned lock is busy/u);
    assert.equal(report.session.child_sessions?.length, 1);
    assert.ok(report.session.child_sessions?.[0]?.evidence.length);
    assert.equal(existsSync(result.mdPath), true);
  } finally {
    setEvidenceCopyTestHooks(null);
    rmSync(suite, { recursive: true, force: true });
    rmSync(mdDir, { recursive: true, force: true });
  }
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
    const repeated = generateReport(suite, BASE_INPUT, { mdDir, copyEvidence: true });
    const repeatedReport = JSON.parse(readFileSync(repeated.jsonPath, 'utf8')) as UxE2eReport;
    assert.equal(repeatedReport.session.child_sessions?.length, 2);
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

test('report suite: unreadable child state probe fails closed instead of omitting child', () => {
  const suite = mkdtempSync(join(tmpdir(), 'omp-ux-e2e-unreadable-child-state-'));
  const child = makeSessionDir();
  const childPath = join(suite, 'session-a');
  renameSync(child, childPath);
  const stateDir = join(childPath, '.work-state', 'ux-e2e');
  let injected = false;
  setEvidenceCopyTestHooks({
    beforeSuitePathStat(path) {
      if (!injected && path === stateDir) {
        injected = true;
        const error = new Error('permission denied while probing child state') as Error & { code?: string };
        error.code = 'EACCES';
        throw error;
      }
    },
  });
  try {
    assert.throws(
      () => generateReport(suite, { ...BASE_INPUT, verdict: 'FAIL' }),
      /permission denied while probing child state/u,
    );
    assert.equal(injected, true);
  } finally {
    setEvidenceCopyTestHooks(null);
    rmSync(suite, { recursive: true, force: true });
  }
});


test('report suite: hardlinked root session metadata is rejected instead of treated as suite', () => {
  const suite = mkdtempSync(join(tmpdir(), 'omp-ux-e2e-hardlinked-root-session-'));
  const child = makeSessionDir();
  const outside = mkdtempSync(join(tmpdir(), 'ux-e2e-hardlinked-root-session-outside-'));
  renameSync(child, join(suite, 'session-a'));
  mkdirSync(join(suite, '.work-state', 'ux-e2e'), { recursive: true });
  const outsideSession = join(outside, 'session.json');
  writeFileSync(outsideSession, readFileSync(join(suite, 'session-a', '.work-state', 'ux-e2e', 'session.json')));
  linkSync(outsideSession, join(suite, '.work-state', 'ux-e2e', 'session.json'));
  try {
    assert.throws(
      () => generateReport(suite, { ...BASE_INPUT, verdict: 'FAIL' }),
      /malformed suite root session metadata/u,
    );
  } finally {
    rmSync(suite, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});


test('report suite: dangling child state ancestor is rejected instead of omitted', () => {
  const suite = mkdtempSync(join(tmpdir(), 'omp-ux-e2e-dangling-child-state-'));
  const valid = makeSessionDir();
  const malformed = makeSessionDir();
  renameSync(valid, join(suite, 'valid'));
  renameSync(malformed, join(suite, 'malformed'));
  const workState = join(suite, 'malformed', '.work-state');
  rmSync(workState, { recursive: true, force: true });
  symlinkSync(join(suite, 'missing-work-state'), workState, 'dir');
  try {
    assert.throws(
      () => generateReport(suite, { ...BASE_INPUT, verdict: 'FAIL' }),
      /\.work-state must be a real directory/u,
    );
  } finally {
    rmSync(suite, { recursive: true, force: true });
  }
});

test('report suite: dangling root state ancestor is rejected instead of treated as absent', () => {
  const suite = mkdtempSync(join(tmpdir(), 'omp-ux-e2e-dangling-root-state-'));
  const child = makeSessionDir();
  renameSync(child, join(suite, 'session-a'));
  symlinkSync(join(suite, 'missing-root-state'), join(suite, '.work-state'), 'dir');
  try {
    assert.throws(
      () => generateReport(suite, { ...BASE_INPUT, verdict: 'FAIL' }),
      /\.work-state must be a real directory/u,
    );
  } finally {
    rmSync(suite, { recursive: true, force: true });
  }
});


test('report suite: non-directory intermediate state is rejected instead of omitted', () => {
  const suite = mkdtempSync(join(tmpdir(), 'omp-ux-e2e-enotdir-child-state-'));
  const valid = makeSessionDir();
  const malformed = makeSessionDir();
  renameSync(valid, join(suite, 'valid'));
  renameSync(malformed, join(suite, 'malformed'));
  const malformedState = join(suite, 'malformed', '.work-state');
  rmSync(malformedState, { recursive: true, force: true });
  writeFileSync(malformedState, 'not a directory\n');
  try {
    assert.throws(() => generateReport(suite, { ...BASE_INPUT, verdict: 'FAIL' }));
    assert.equal(existsSync(join(suite, '.work-state', 'ux-e2e', 'report.json')), false);
  } finally {
    rmSync(suite, { recursive: true, force: true });
  }
});


test('report suite: reserved lock name cannot hide a valid child directory', () => {
  const suite = mkdtempSync(join(tmpdir(), 'omp-ux-e2e-reserved-lock-child-'));
  const child = makeSessionDir();
  renameSync(child, join(suite, '.omp-ux-e2e-report.lock'));
  try {
    assert.throws(
      () => generateReport(suite, { ...BASE_INPUT, verdict: 'FAIL' }),
      /reserved report lock entry/u,
    );
  } finally {
    rmSync(suite, { recursive: true, force: true });
  }
});

test('report suite: malformed dead-owner lock file is reclaimed by acquisition', () => {
  const suite = mkdtempSync(join(tmpdir(), 'omp-ux-e2e-malformed-lock-'));
  const child = makeSessionDir();
  renameSync(child, join(suite, 'session-a'));
  const lockPath = join(suite, '.omp-ux-e2e-report.lock');
  writeFileSync(lockPath, '999999999:malformed-lock-marker\n');
  try {
    const result = generateReport(suite, { ...BASE_INPUT, verdict: 'FAIL' });
    assert.ok(existsSync(result.jsonPath));
    assert.equal(existsSync(lockPath), false, 'reclaimed stale lock is released after reporting');
  } finally {
    rmSync(suite, { recursive: true, force: true });
  }
});


test('report suite: reserved lock name symlink is rejected instead of omitted', () => {
  const suite = mkdtempSync(join(tmpdir(), 'omp-ux-e2e-reserved-lock-link-'));
  const child = makeSessionDir();
  const target = join(suite, 'real-child');
  renameSync(child, target);
  symlinkSync(target, join(suite, '.omp-ux-e2e-report.lock'), 'dir');
  try {
    assert.throws(
      () => generateReport(suite, { ...BASE_INPUT, verdict: 'FAIL' }),
      /reserved report lock entry/u,
    );
  } finally {
    rmSync(suite, { recursive: true, force: true });
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

test('report suite: caps all immediate entries, including non-directories', () => {
  const suite = mkdtempSync(join(tmpdir(), 'omp-ux-e2e-readable-spec-workflow-entry-cap-'));
  try {
    for (let index = 0; index <= 1024; index += 1) writeFileSync(join(suite, `entry-${String(index)}.txt`), '');
    assert.throws(() => generateReport(suite, BASE_INPUT), /too many immediate directory entries/u);
  } finally {
    rmSync(suite, { recursive: true, force: true });
  }
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

test('report suite: root and child session ownership is rejected as ambiguous', () => {
  const suite = mkdtempSync(join(tmpdir(), 'omp-ux-e2e-readable-spec-workflow-'));
  const child = makeSessionDir();
  renameSync(child, join(suite, 'child'));
  mkdirSync(join(suite, '.work-state', 'ux-e2e'), { recursive: true });
  writeFileSync(join(suite, '.work-state', 'ux-e2e', 'session.json'), readFileSync(join(suite, 'child', '.work-state', 'ux-e2e', 'session.json')));
  try {
    assert.throws(() => generateReport(suite, BASE_INPUT), /ambiguous suite root/u);
  } finally {
    rmSync(suite, { recursive: true, force: true });
  }
});

test('report suite: late child insertion fails membership revalidation', () => {
  const suite = mkdtempSync(join(tmpdir(), 'omp-ux-e2e-readable-spec-workflow-'));
  const first = makeSessionDir();
  const late = makeSessionDir();
  renameSync(first, join(suite, 'session-a'));
  const mdDir = mkdtempSync(join(tmpdir(), 'ux-e2e-suite-membership-md-'));
  let inserted = false;
  setEvidenceCopyTestHooks({
    beforeSourceOpen(path) {
      if (!inserted && path.includes(`${join(suite, 'session-a')}${sep}`)) {
        inserted = true;
        renameSync(late, join(suite, 'session-late'));
      }
    },
  });
  try {
    assert.throws(() => generateReport(suite, BASE_INPUT, { mdDir, copyEvidence: true }));
  } finally {
    setEvidenceCopyTestHooks(null);
    rmSync(suite, { recursive: true, force: true });
    rmSync(mdDir, { recursive: true, force: true });
    if (!inserted) rmSync(late, { recursive: true, force: true });
  }
});

test('report suite: child replacement fails membership identity revalidation', () => {
  const suite = mkdtempSync(join(tmpdir(), 'omp-ux-e2e-readable-spec-workflow-'));
  const first = makeSessionDir();
  const second = makeSessionDir();
  const replacement = makeSessionDir();
  renameSync(first, join(suite, 'session-a'));
  renameSync(second, join(suite, 'session-b'));
  const moved = `${join(suite, 'session-b')}.moved`;
  const mdDir = mkdtempSync(join(tmpdir(), 'ux-e2e-suite-membership-md-'));
  let replaced = false;
  setEvidenceCopyTestHooks({
    beforeSourceOpen(path) {
      if (!replaced && path.includes(`${join(suite, 'session-a')}${sep}`)) {
        replaced = true;
        renameSync(join(suite, 'session-b'), moved);
        renameSync(replacement, join(suite, 'session-b'));
      }
    },
  });
  try {
    assert.throws(() => generateReport(suite, BASE_INPUT, { mdDir, copyEvidence: true }));
  } finally {
    setEvidenceCopyTestHooks(null);
    rmSync(suite, { recursive: true, force: true });
    rmSync(mdDir, { recursive: true, force: true });
    rmSync(moved, { recursive: true, force: true });
    if (!replaced) rmSync(replacement, { recursive: true, force: true });
  }
});

test('report suite: real root replacement fails pinned identity revalidation', () => {
  const suite = mkdtempSync(join(tmpdir(), 'omp-ux-e2e-readable-spec-workflow-'));
  const first = makeSessionDir();
  const replacement = mkdtempSync(join(tmpdir(), 'omp-ux-e2e-suite-replacement-'));
  renameSync(first, join(suite, 'session-a'));
  const moved = `${suite}.moved`;
  const mdDir = mkdtempSync(join(tmpdir(), 'ux-e2e-suite-root-md-'));
  let replaced = false;
  setEvidenceCopyTestHooks({
    beforeSourceOpen(path) {
      if (!replaced && path.endsWith(`${sep}session-a${sep}.work-state${sep}ux-e2e${sep}transcript.jsonl`)) {
        replaced = true;
        renameSync(suite, moved);
        renameSync(replacement, suite);
      }
    },
  });
  try {
    assert.throws(() => generateReport(suite, { ...BASE_INPUT, verdict: 'FAIL' }, { mdDir, copyEvidence: true }));
  } finally {
    setEvidenceCopyTestHooks(null);
    rmSync(suite, { recursive: true, force: true });
    rmSync(moved, { recursive: true, force: true });
    rmSync(mdDir, { recursive: true, force: true });
    if (!replaced) rmSync(replacement, { recursive: true, force: true });
  }
});

test('report suite: aggregate evidence budget rejects oversized children before root write', () => {
  const suite = mkdtempSync(join(tmpdir(), 'omp-ux-e2e-readable-spec-workflow-'));
  const first = makeSessionDir();
  const second = makeSessionDir();
  renameSync(first, join(suite, 'session-a'));
  renameSync(second, join(suite, 'session-b'));
  for (const name of ['session-a', 'session-b']) {
    const child = join(suite, name);
    const session = readSessionRecord(child);
    const scenario = session.scenario as Record<string, unknown>;
    const workspace = scenario.workspace as Record<string, unknown>;
    const documents = Array.from({ length: 9 }, (_, index) => `large-evidence-${String(index)}.bin`);
    const perFileBytes = 7.5 * 1024 * 1024;
    assert.ok(perFileBytes < MAX_PINNED_READ_BYTES);
    assert.ok(documents.length * perFileBytes > 64 * 1024 * 1024);
    workspace.documents = documents;
    writeSessionRecord(child, session);
    for (const document of documents) writeFileSync(join(child, document), Buffer.alloc(perFileBytes, 0x61));
  }
  try {
    assert.throws(() => generateReport(suite, { ...BASE_INPUT, verdict: 'FAIL' }), /aggregate byte limit/u);
    assert.equal(existsSync(join(suite, '.work-state', 'ux-e2e', 'report.json')), false);
  } finally {
    rmSync(suite, { recursive: true, force: true });
  }
});

test('report: no-replace evidence publication preserves a concurrent destination', () => {
  const dir = makeSessionDir();
  const mdDir = mkdtempSync(join(tmpdir(), 'ux-e2e-md-collision-'));
  let collided = false;
  let destination = '';
  setEvidenceCopyTestHooks({
    beforeTargetRename(path) {
      if (collided || !path.includes('/evidence/my-feature/ux-e2e/transcript.jsonl.')) return;
      collided = true;
      destination = path;
      writeFileSync(path, 'concurrent destination');
    },
  });
  try {
    const result = generateReport(dir, BASE_INPUT, { mdDir, copyEvidence: true });
    const report = JSON.parse(readFileSync(result.jsonPath, 'utf8')) as UxE2eReport;
    assert.equal(collided, true);
    assert.equal(readFileSync(destination, 'utf8'), 'concurrent destination');
    assert.equal(report.evidence.some(path => path === destination), false);
  } finally {
    setEvidenceCopyTestHooks(null);
    rmSync(mdDir, { recursive: true, force: true });
  }
});

test('report: no-replace publication stays on the pinned directory across a lexical root swap', () => {
  const dir = makeSessionDir();
  const mdDir = mkdtempSync(join(tmpdir(), 'ux-e2e-md-noreplace-root-race-'));
  const outside = mkdtempSync(join(tmpdir(), 'ux-e2e-report-noreplace-outside-'));
  const moved = `${mdDir}.moved`;
  const outsideEvidenceDir = join(outside, 'evidence', 'my-feature');
  mkdirSync(outsideEvidenceDir, { recursive: true });
  let swapped = false;
  setEvidenceCopyTestHooks({
    beforeTargetRename(destination) {
      if (swapped || !destination.includes(`${sep}evidence${sep}my-feature${sep}`)) return;
      const destinationDir = dirname(destination);
      const temporaryName = readdirSync(destinationDir).find(name => name.startsWith('.') && name.endsWith('.tmp'));
      if (temporaryName === undefined) return;
      renameSync(join(destinationDir, temporaryName), join(outsideEvidenceDir, temporaryName));
      renameSync(mdDir, moved);
      symlinkSync(outside, mdDir);
      swapped = true;
    },
  });
  try {
    assert.throws(() => generateReport(dir, BASE_INPUT, { mdDir, copyEvidence: true }));
  } finally {
    setEvidenceCopyTestHooks(null);
    if (swapped) {
      unlinkSync(mdDir);
      renameSync(moved, mdDir);
    }
  }
  assert.equal(swapped, true);
  assert.equal(readdirSync(outsideEvidenceDir).some(name => !name.endsWith('.tmp')), false, 'lexical root swap must not publish the temporary outside the pinned directory');
  rmSync(dir, { recursive: true, force: true });
  rmSync(mdDir, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
});


test('report selectors: bounded feature and run selectors accept limits and reject over-limit values', () => {
  const accepted = makeSessionDir();
  const acceptedSession = readSessionRecord(accepted);
  const acceptedScenario = acceptedSession.scenario as Record<string, unknown>;
  acceptedScenario.selectors = { feature_id: 'f'.repeat(128), run_key: 'r'.repeat(4096) };
  delete acceptedSession.selectors;
  writeSessionRecord(accepted, acceptedSession);
  const acceptedResult = generateReport(accepted, { ...BASE_INPUT, verdict: 'FAIL' });
  assert.ok(existsSync(acceptedResult.jsonPath));

  const featureTooLong = makeSessionDir();
  const featureSession = readSessionRecord(featureTooLong);
  (featureSession.scenario as Record<string, unknown>).selectors = { feature_id: 'f'.repeat(129), run_key: 'run-1' };
  writeSessionRecord(featureTooLong, featureSession);
  assertSelectorFailure(featureTooLong, 'partial');

  const runTooLong = makeSessionDir();
  const runSession = readSessionRecord(runTooLong);
  (runSession.scenario as Record<string, unknown>).selectors = { feature_id: 'feature-a', run_key: 'r'.repeat(4097) };
  writeSessionRecord(runTooLong, runSession);
  assertSelectorFailure(runTooLong, 'partial');
});

test('report scenario declarations: malformed known evidence lists fail PASS and sanitize non-PASS output', () => {
  const dir = makeSessionDir();
  const session = readSessionRecord(dir);
  const scenario = session.scenario as Record<string, unknown>;
  const workspace = scenario.workspace as Record<string, unknown>;
  workspace.evidence = [123];
  writeSessionRecord(dir, session);
  assert.throws(() => generateReport(dir, BASE_INPUT), /all declared scenario evidence/u);

  const mdDir = mkdtempSync(join(tmpdir(), 'ux-e2e-md-malformed-declaration-'));
  try {
    const result = generateReport(dir, { ...BASE_INPUT, verdict: 'FAIL' }, { mdDir });
    const report = JSON.parse(readFileSync(result.jsonPath, 'utf8')) as UxE2eReport;
    assert.ok(result.warnings.some(warning => warning.includes('workspace.evidence')));
    assert.equal(JSON.stringify(report).includes('123'), false, 'malformed raw declaration is not reflected in report output');
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(mdDir, { recursive: true, force: true });
  }
});

test('report suite: child identity change between JSON and markdown publish rolls back exact outputs', () => {
  const suite = mkdtempSync(join(tmpdir(), 'omp-ux-e2e-readable-spec-workflow-publish-race-'));
  const first = makeSessionDir();
  const second = makeSessionDir();
  renameSync(first, join(suite, 'session-a'));
  renameSync(second, join(suite, 'session-b'));
  const mdDir = mkdtempSync(join(tmpdir(), 'ux-e2e-suite-publish-race-md-'));
  const sessionPath = join(suite, 'session-a', '.work-state', 'ux-e2e', 'session.json');
  const movedSession = `${sessionPath}.moved`;
  let mutated = false;
  setEvidenceCopyTestHooks({
    beforeTargetOpen(destination) {
      if (mutated || !destination.startsWith(mdDir + sep) || !destination.endsWith('.md')) return;
      mutated = true;
      const mutatedSession = { ...readSessionRecord(join(suite, 'session-a')), profile: 'mutated' };
      renameSync(sessionPath, movedSession);
      writeFileSync(sessionPath, JSON.stringify(mutatedSession) + '\n');
    },
  });
  try {
    assert.throws(() => generateReport(suite, { ...BASE_INPUT, verdict: 'FAIL' }, { mdDir }));
    assert.equal(existsSync(join(suite, '.work-state', 'ux-e2e', 'report.json')), false);
    assert.deepEqual(readdirSync(mdDir), []);
  } finally {
    setEvidenceCopyTestHooks(null);
    if (existsSync(sessionPath)) unlinkSync(sessionPath);
    if (existsSync(movedSession)) renameSync(movedSession, sessionPath);
    rmSync(suite, { recursive: true, force: true });
    rmSync(mdDir, { recursive: true, force: true });
  }
});

test('report: single-session root replacement is rejected before publishing outside the retained root', () => {
  const dir = makeSessionDir();
  const replacement = mkdtempSync(join(tmpdir(), 'ux-e2e-single-root-replacement-'));
  const moved = `${dir}.moved`;
  const mdDir = mkdtempSync(join(tmpdir(), 'ux-e2e-single-root-race-md-'));
  let replaced = false;
  setEvidenceCopyTestHooks({
    beforeTargetOpen(destination) {
      if (replaced || !destination.endsWith(`${sep}report.json`)) return;
      replaced = true;
      renameSync(dir, moved);
      renameSync(replacement, dir);
    },
  });
  try {
    assert.throws(() => generateReport(dir, { ...BASE_INPUT, verdict: 'FAIL' }, { mdDir }));
  } finally {
    setEvidenceCopyTestHooks(null);
    if (replaced) {
      rmSync(dir, { recursive: true, force: true });
      renameSync(moved, dir);
    } else {
      rmSync(replacement, { recursive: true, force: true });
    }
    rmSync(dir, { recursive: true, force: true });
    rmSync(mdDir, { recursive: true, force: true });
  }
});

test('report: nested evidence pin refuses a target root swapped between parent and child pin', () => {
  const dir = makeSessionDir();
  const mdDir = mkdtempSync(join(tmpdir(), 'ux-e2e-inter-pin-md-'));
  const outside = mkdtempSync(join(tmpdir(), 'ux-e2e-inter-pin-outside-'));
  const targetRoot = join(mdDir, 'evidence', 'my-feature', 'ux-e2e');
  mkdirSync(targetRoot, { recursive: true });
  const movedTarget = `${targetRoot}.moved`;
  let swapped = false;
  setEvidenceCopyTestHooks({
    beforeDirectoryOpen(path) {
      if (swapped || !existsSync(targetRoot) || (path !== targetRoot && !path.startsWith(targetRoot + sep))) return;
      swapped = true;
      renameSync(targetRoot, movedTarget);
      symlinkSync(outside, targetRoot, 'dir');
    },
  });
  try {
    const result = generateReport(dir, { ...BASE_INPUT, verdict: 'FAIL' }, { mdDir, copyEvidence: true });
    const report = JSON.parse(readFileSync(result.jsonPath, 'utf8')) as UxE2eReport;
    assert.equal(swapped, true);
    assert.equal(readdirSync(outside).length, 0, 'intermediate swap must not publish outside the retained destination');
  } finally {
    setEvidenceCopyTestHooks(null);
    rmSync(targetRoot, { recursive: true, force: true });
    if (existsSync(movedTarget)) renameSync(movedTarget, targetRoot);
    rmSync(dir, { recursive: true, force: true });
    rmSync(mdDir, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test('report suite: total evidence file cap rejects many short files before root publication', () => {
  const suite = mkdtempSync(join(tmpdir(), 'omp-ux-e2e-readable-spec-workflow-file-cap-'));
  const first = makeSessionDir();
  const second = makeSessionDir();
  renameSync(first, join(suite, 'session-a'));
  renameSync(second, join(suite, 'session-b'));
  const documents = Array.from({ length: 2050 }, (_, index) => `short-evidence-${String(index)}.txt`);
  for (const childName of ['session-a', 'session-b']) {
    const child = join(suite, childName);
    const session = readSessionRecord(child);
    ((session.scenario as Record<string, unknown>).workspace as Record<string, unknown>).documents = documents;
    writeSessionRecord(child, session);
    for (const document of documents) writeFileSync(join(child, document), 'x');
  }
  try {
    assert.throws(() => generateReport(suite, { ...BASE_INPUT, verdict: 'FAIL' }), /too many evidence files/u);
    assert.equal(existsSync(join(suite, '.work-state', 'ux-e2e', 'report.json')), false);
  } finally {
    rmSync(suite, { recursive: true, force: true });
  }
});


test('report: exact rollback quarantine preserves a replacement created after verification', () => {
  const dir = makeSessionDir();
  const mdDir = mkdtempSync(join(tmpdir(), 'ux-e2e-rollback-quarantine-md-'));
  const outside = mkdtempSync(join(tmpdir(), 'ux-e2e-rollback-quarantine-outside-'));
  const moved = `${mdDir}.moved`;
  const reportPath = join(dir, '.work-state', 'ux-e2e', 'report.json');
  let swapped = false;
  let replacementWritten = false;
  setEvidenceCopyTestHooks({
    beforeTargetOpen(destination) {
      if (swapped || !destination.startsWith(mdDir + sep) || !destination.endsWith('.md')) return;
      swapped = true;
      renameSync(mdDir, moved);
      symlinkSync(outside, mdDir, 'dir');
    },
    beforeTargetRename(destination) {
      if (swapped && !replacementWritten && destination === reportPath) {
        replacementWritten = true;
        writeFileSync(destination, 'concurrent replacement');
      }
    },
  });
  try {
    assert.throws(() => generateReport(dir, { ...BASE_INPUT, verdict: 'FAIL' }, { mdDir }));
  } finally {
    setEvidenceCopyTestHooks(null);
    if (swapped) {
      unlinkSync(mdDir);
      renameSync(moved, mdDir);
    }
  }
  assert.equal(replacementWritten, true);
  assert.equal(readFileSync(reportPath, 'utf8'), 'concurrent replacement');
  rmSync(dir, { recursive: true, force: true });
  rmSync(mdDir, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
});

test('report: nested evidence pin rejects an intermediate ancestor symlink swap', () => {
  const dir = makeSessionDir();
  const mdDir = mkdtempSync(join(tmpdir(), 'ux-e2e-intermediate-swap-md-'));
  const outside = mkdtempSync(join(tmpdir(), 'ux-e2e-intermediate-swap-outside-'));
  const targetRoot = join(mdDir, 'evidence', 'my-feature');
  const intermediate = join(targetRoot, 'specs');
  const moved = `${intermediate}.moved`;
  let swapped = false;
  setEvidenceCopyTestHooks({
    beforeDirectoryComponent(path) {
      if (swapped || path !== intermediate) return;
      swapped = true;
      renameSync(intermediate, moved);
      symlinkSync(outside, intermediate, 'dir');
    },
  });
  try {
    const result = generateReport(dir, { ...BASE_INPUT, verdict: 'FAIL' }, { mdDir, copyEvidence: true });
    const report = JSON.parse(readFileSync(result.jsonPath, 'utf8')) as UxE2eReport;
    assert.equal(swapped, true);
    assert.equal(readdirSync(outside).length, 0, 'intermediate swap must not publish outside the retained destination');
  } finally {
    setEvidenceCopyTestHooks(null);
    rmSync(intermediate, { recursive: true, force: true });
    if (existsSync(moved)) renameSync(moved, intermediate);
    rmSync(dir, { recursive: true, force: true });
    rmSync(mdDir, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test('report: single discovery binds root session content across publish fences', () => {
  const dir = makeSessionDir();
  const mdDir = mkdtempSync(join(tmpdir(), 'ux-e2e-single-session-marker-md-'));
  const sessionPath = join(dir, '.work-state', 'ux-e2e', 'session.json');
  const moved = `${sessionPath}.moved`;
  let mutated = false;
  setEvidenceCopyTestHooks({
    beforeTargetOpen(destination) {
      if (mutated || !destination.endsWith(`${sep}report.json`)) return;
      mutated = true;
      const session = readSessionRecord(dir);
      session.status = 'running';
      renameSync(sessionPath, moved);
      writeSessionRecord(dir, session);
    },
  });
  try {
    assert.throws(() => generateReport(dir, { ...BASE_INPUT, verdict: 'FAIL' }, { mdDir }), /membership changed|session root changed|failed to write report/u);
    assert.equal(existsSync(join(dir, '.work-state', 'ux-e2e', 'report.json')), false);
  } finally {
    setEvidenceCopyTestHooks(null);
    if (existsSync(sessionPath)) unlinkSync(sessionPath);
    if (existsSync(moved)) renameSync(moved, sessionPath);
    rmSync(dir, { recursive: true, force: true });
    rmSync(mdDir, { recursive: true, force: true });
  }
});


test('report: exact rollback preserves a nonmatching replacement at its original name', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ux-e2e-exact-mismatch-'));
  const root = pinDirectory(dir);
  if (root === null) throw new Error('test root could not be pinned');
  const expected = Buffer.from('expected bytes');
  const target = join(dir, 'target.txt');
  try {
    assert.equal(writePinnedFile(root, 'target.txt', expected), true);
    let replaced = false;
    setFsSafetyTestHooks({
      beforeExactQuarantine(path) {
        if (path !== target || replaced) return;
        replaced = true;
        writeFileSync(path, 'foreign replacement');
      },
    });
    try {
      assert.equal(unlinkPinnedFileIfExact(root, 'target.txt', expected), false);
    } finally {
      setFsSafetyTestHooks(null);
    }
    assert.equal(replaced, true);
    assert.equal(readFileSync(target, 'utf8'), 'foreign replacement');
    assert.equal(readdirSync(dir).some(name => name.startsWith('.omp-unlink-')), false);
  } finally {
    closePinnedDirectory(root);
    rmSync(dir, { recursive: true, force: true });
  }
});


test('report: retained state descriptor restores a preexisting JSON after root replacement', () => {
  const dir = makeSessionDir();
  const replacement = mkdtempSync(join(tmpdir(), 'ux-e2e-single-rollback-replacement-'));
  const moved = `${dir}.moved`;
  const mdDir = mkdtempSync(join(tmpdir(), 'ux-e2e-single-rollback-md-'));
  const reportPath = join(dir, '.work-state', 'ux-e2e', 'report.json');
  writeFileSync(reportPath, 'previous report bytes');
  let swapped = false;
  setEvidenceCopyTestHooks({
    beforeTargetOpen(destination) {
      if (swapped || !destination.startsWith(mdDir + sep) || !destination.endsWith('.md')) return;
      swapped = true;
      renameSync(dir, moved);
      renameSync(replacement, dir);
    },
  });
  try {
    assert.throws(() => generateReport(dir, { ...BASE_INPUT, verdict: 'FAIL' }, { mdDir }), /membership changed|session root changed|failed to write markdown/u);
  } finally {
    setEvidenceCopyTestHooks(null);
    if (swapped) {
      rmSync(dir, { recursive: true, force: true });
      renameSync(moved, dir);
    }
  }
  assert.equal(readFileSync(reportPath, 'utf8'), 'previous report bytes');
  assert.equal(existsSync(join(dir, '.work-state', 'ux-e2e', 'report.json')), true);
  assert.equal(existsSync(join(mdDir, 'evidence', 'my-feature')) ? readdirSync(join(mdDir, 'evidence', 'my-feature')).length : 0, 0);
  rmSync(dir, { recursive: true, force: true });
  rmSync(mdDir, { recursive: true, force: true });
  rmSync(replacement, { recursive: true, force: true });
});

test('report: post-open ancestor replacement is rejected before evidence publish', () => {
  const dir = makeSessionDir();
  const mdDir = mkdtempSync(join(tmpdir(), 'ux-e2e-post-open-race-md-'));
  const outside = mkdtempSync(join(tmpdir(), 'ux-e2e-post-open-race-outside-'));
  const targetRoot = join(mdDir, 'evidence', 'my-feature');
  const moved = `${targetRoot}.moved`;
  mkdirSync(targetRoot, { recursive: true });
  let swapped = false;
  setEvidenceCopyTestHooks({
    afterDirectoryOpen(path) {
      if (swapped || path !== join(targetRoot, 'ux-e2e')) return;
      swapped = true;
      renameSync(targetRoot, moved);
      symlinkSync(outside, targetRoot, 'dir');
    },
  });
  try {
    assert.throws(() => generateReport(dir, { ...BASE_INPUT, verdict: 'FAIL' }, { mdDir, copyEvidence: true }));
    assert.equal(swapped, true);
    assert.equal(readdirSync(outside).length, 0, 'post-open replacement must not publish outside retained root');
  } finally {
    setEvidenceCopyTestHooks(null);
    rmSync(targetRoot, { recursive: true, force: true });
    if (existsSync(moved)) renameSync(moved, targetRoot);
    rmSync(dir, { recursive: true, force: true });
    rmSync(mdDir, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});


test('report: retained state child pin rejects root replacement before JSON publication', () => {
  const dir = makeSessionDir();
  const replacement = mkdtempSync(join(tmpdir(), 'ux-e2e-state-pin-replacement-'));
  const moved = `${dir}.moved`;
  const mdDir = mkdtempSync(join(tmpdir(), 'ux-e2e-state-pin-md-'));
  let swapped = false;
  setEvidenceCopyTestHooks({
    beforeDirectoryOpen(path) {
      if (swapped || !path.endsWith(`${sep}.work-state${sep}ux-e2e`)) return;
      swapped = true;
      renameSync(dir, moved);
      renameSync(replacement, dir);
    },
  });
  try {
    assert.throws(() => generateReport(dir, { ...BASE_INPUT, verdict: 'FAIL' }, { mdDir }));
  } finally {
    setEvidenceCopyTestHooks(null);
    if (swapped) {
      rmSync(dir, { recursive: true, force: true });
      renameSync(moved, dir);
    }
    rmSync(dir, { recursive: true, force: true });
    rmSync(mdDir, { recursive: true, force: true });
    if (!swapped) rmSync(replacement, { recursive: true, force: true });
  }
});

test('report: retained source pin rejects root replacement before evidence copy', () => {
  const dir = makeSessionDir();
  const replacement = mkdtempSync(join(tmpdir(), 'ux-e2e-source-pin-replacement-'));
  const moved = `${dir}.moved`;
  const mdDir = mkdtempSync(join(tmpdir(), 'ux-e2e-source-pin-md-'));
  let swapped = false;
  setEvidenceCopyTestHooks({
    beforeSourcePin(path) {
      if (swapped || path !== dir) return;
      swapped = true;
      renameSync(dir, moved);
      renameSync(replacement, dir);
    },
  });
  try {
    assert.throws(() => generateReport(dir, { ...BASE_INPUT, verdict: 'FAIL' }, { mdDir, copyEvidence: true }));
    assert.equal(readdirSync(join(mdDir, 'evidence', 'my-feature')).length, 0);
  } finally {
    setEvidenceCopyTestHooks(null);
    if (swapped) {
      rmSync(dir, { recursive: true, force: true });
      renameSync(moved, dir);
    }
    rmSync(dir, { recursive: true, force: true });
    rmSync(mdDir, { recursive: true, force: true });
    if (!swapped) rmSync(replacement, { recursive: true, force: true });
  }
});

test('report suite: retained child source pin rejects replacement before aggregate copy', () => {
  const suite = mkdtempSync(join(tmpdir(), 'omp-ux-e2e-retained-child-root-'));
  const child = makeSessionDir();
  renameSync(child, join(suite, 'session-a'));
  const replacement = mkdtempSync(join(tmpdir(), 'ux-e2e-child-root-replacement-'));
  const moved = `${join(suite, 'session-a')}.moved`;
  const mdDir = mkdtempSync(join(tmpdir(), 'ux-e2e-child-root-md-'));
  let swapped = false;
  setEvidenceCopyTestHooks({
    beforeSourcePin(path) {
      const childPath = join(suite, 'session-a');
      if (swapped || path !== childPath) return;
      swapped = true;
      renameSync(childPath, moved);
      renameSync(replacement, childPath);
    },
  });
  try {
    assert.throws(() => generateReport(suite, { ...BASE_INPUT, verdict: 'FAIL' }, { mdDir, copyEvidence: true }));
    assert.equal(readdirSync(join(mdDir, 'evidence', 'session-a')).length, 0);
  } finally {
    setEvidenceCopyTestHooks(null);
    if (swapped) {
      rmSync(join(suite, 'session-a'), { recursive: true, force: true });
      renameSync(moved, join(suite, 'session-a'));
    }
    rmSync(suite, { recursive: true, force: true });
    rmSync(mdDir, { recursive: true, force: true });
    if (!swapped) rmSync(replacement, { recursive: true, force: true });
  }
});


test('report: oversized destination with matching prefix is a real evidence collision', () => {
  const dir = makeSessionDir();
  const mdDir = mkdtempSync(join(tmpdir(), 'ux-e2e-md-oversized-collision-'));
  const source = Buffer.alloc(MAX_PINNED_READ_BYTES, 0x61);
  const sourcePath = 'specs/feature-a/max.bin';
  writeFileSync(join(dir, sourcePath), source);
  setScenarioDocuments(dir, [sourcePath]);
  const digest = createHash('sha256').update(source).digest('hex').slice(0, 16);
  const destinationDir = join(mdDir, 'evidence', 'my-feature', 'specs', 'feature-a');
  mkdirSync(destinationDir, { recursive: true });
  const destination = join(destinationDir, `max.bin.${digest}`);
  const foreign = Buffer.concat([source, Buffer.from([0x62])]);
  writeFileSync(destination, foreign);
  try {
    assert.throws(
      () => generateReport(dir, { ...BASE_INPUT, verdict: 'FAIL' }, { mdDir, copyEvidence: true }),
      /evidence destination collision/u,
    );
    assert.deepEqual(readFileSync(destination), foreign, 'foreign oversized destination is preserved');
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(mdDir, { recursive: true, force: true });
  }
});


test('report: source root swap after first evidence copy rolls back every published byte', () => {
  const dir = makeSessionDir();
  const replacement = mkdtempSync(join(tmpdir(), 'ux-e2e-source-after-copy-replacement-'));
  const moved = `${dir}.moved`;
  const mdDir = mkdtempSync(join(tmpdir(), 'ux-e2e-md-source-after-copy-'));
  let writes = 0;
  let swapped = false;
  setEvidenceCopyTestHooks({
    beforeTargetRename(path) {
      if (swapped || !path.includes(`${sep}evidence${sep}my-feature${sep}`)) return;
      writes += 1;
      if (writes !== 2) return;
      swapped = true;
      renameSync(dir, moved);
      renameSync(replacement, dir);
    },
  });
  try {
    assert.throws(
      () => generateReport(dir, { ...BASE_INPUT, verdict: 'FAIL' }, { mdDir, copyEvidence: true }),
    );
    assert.equal(swapped, true);
    assert.equal(readdirSync(join(mdDir, 'evidence', 'my-feature')).length, 0, 'published evidence is rolled back');
  } finally {
    setEvidenceCopyTestHooks(null);
    if (swapped) {
      rmSync(dir, { recursive: true, force: true });
      renameSync(moved, dir);
    }
    rmSync(dir, { recursive: true, force: true });
    rmSync(mdDir, { recursive: true, force: true });
    if (!swapped) rmSync(replacement, { recursive: true, force: true });
  }
});


test('report: oversized preexisting markdown fails before publication and preserves exact bytes', () => {
  const dir = makeSessionDir();
  const mdDir = mkdtempSync(join(tmpdir(), 'ux-e2e-md-oversized-existing-'));
  const expectedDate = new Date().toISOString().slice(0, 10);
  const destination = join(mdDir, `my-feature-ux-e2e-${expectedDate}.md`);
  const previous = Buffer.alloc(MAX_PINNED_READ_BYTES + 1, 0x5a);
  writeFileSync(destination, previous);
  try {
    assert.throws(
      () => generateReport(dir, { ...BASE_INPUT, verdict: 'FAIL' }, { mdDir }),
    );
    assert.deepEqual(readFileSync(destination), previous, 'oversized markdown remains byte-exact');
    assert.equal(existsSync(join(dir, '.work-state', 'ux-e2e', 'report.json')), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(mdDir, { recursive: true, force: true });
  }
});


test('report: oversized prior JSON fails before publication and preserves exact bytes', () => {
  const dir = makeSessionDir();
  const mdDir = mkdtempSync(join(tmpdir(), 'ux-e2e-md-oversized-json-'));
  const reportPath = join(dir, '.work-state', 'ux-e2e', 'report.json');
  const previous = Buffer.alloc(MAX_PINNED_READ_BYTES + 1, 0x4a);
  writeFileSync(reportPath, previous);
  try {
    assert.throws(
      () => generateReport(dir, { ...BASE_INPUT, verdict: 'FAIL' }, { mdDir }),
    );
    assert.deepEqual(readFileSync(reportPath), previous, 'oversized prior JSON remains byte-exact');
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(mdDir, { recursive: true, force: true });
  }
});

test('report suite: oversized prior JSON fails before publication and preserves exact bytes', () => {
  const suite = mkdtempSync(join(tmpdir(), 'omp-ux-e2e-oversized-json-suite-'));
  const child = makeSessionDir();
  renameSync(child, join(suite, 'session-a'));
  const reportPath = join(suite, '.work-state', 'ux-e2e', 'report.json');
  mkdirSync(join(suite, '.work-state', 'ux-e2e'), { recursive: true });
  const previous = Buffer.alloc(MAX_PINNED_READ_BYTES + 1, 0x4b);
  writeFileSync(reportPath, previous);
  try {
    assert.throws(
      () => generateReport(suite, { ...BASE_INPUT, verdict: 'FAIL' }),
    );
    assert.deepEqual(readFileSync(reportPath), previous, 'oversized suite JSON remains byte-exact');
  } finally {
    rmSync(suite, { recursive: true, force: true });
  }
});

test('report: destination root swap after final evidence copy rolls back evidence and outputs', () => {
  const dir = makeSessionDir();
  const mdDir = mkdtempSync(join(tmpdir(), 'ux-e2e-md-target-after-copy-'));
  const evidenceRoot = join(mdDir, 'evidence', 'my-feature');
  const moved = `${evidenceRoot}.moved`;
  const replacement = `${evidenceRoot}.replacement`;
  let swapped = false;
  const reportPath = join(dir, '.work-state', 'ux-e2e', 'report.json');
  setEvidenceCopyTestHooks({
    beforeTargetOpen(path) {
      if (swapped || path !== reportPath) return;
      swapped = true;
      renameSync(evidenceRoot, moved);
      mkdirSync(replacement, { recursive: true });
      renameSync(replacement, evidenceRoot);
    },
  });
  try {
    assert.throws(
      () => generateReport(dir, { ...BASE_INPUT, verdict: 'FAIL' }, { mdDir, copyEvidence: true }),
    );
    assert.equal(swapped, true);
    assert.equal(readdirSync(evidenceRoot).length, 0, 'replacement evidence root remains empty');
    assert.equal(readdirSync(moved).length, 0, 'published evidence is rolled back from retained root');
    assert.equal(existsSync(reportPath), false, 'report JSON is rolled back');
  } finally {
    setEvidenceCopyTestHooks(null);
    rmSync(dir, { recursive: true, force: true });
    rmSync(mdDir, { recursive: true, force: true });
    rmSync(moved, { recursive: true, force: true });
  }
});

test('fs safety: final quarantine replacement is preserved after identity recheck', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ux-e2e-final-quarantine-race-'));
  const target = join(dir, 'target.txt');
  const replacement = Buffer.from('foreign replacement');
  const original = Buffer.from('original bytes');
  writeFileSync(target, original);
  const root = pinDirectory(dir);
  assert.ok(root);
  let swapped = false;
  setFsSafetyTestHooks({
    beforeTargetRename(path) {
      if (swapped || path !== target) return;
      const quarantine = readdirSync(dir).find(name => name.startsWith('.omp-unlink-'));
      if (quarantine === undefined) return;
      swapped = true;
      renameSync(join(dir, quarantine), `${join(dir, quarantine)}.moved`);
      writeFileSync(join(dir, quarantine), replacement);
    },
  });
  try {
    assert.equal(unlinkPinnedFileIfExact(root, 'target.txt', original), false);
    assert.equal(swapped, true);
    const foreign = readdirSync(dir).find(name => name.startsWith('.omp-unlink-') && !name.endsWith('.moved'));
    assert.ok(foreign, 'replacement quarantine remains visible');
    assert.deepEqual(readFileSync(join(dir, foreign)), replacement);
  } finally {
    setFsSafetyTestHooks(null);
    closePinnedDirectory(root);
    rmSync(dir, { recursive: true, force: true });
  }
});


test('report suite: destination swap during markdown output rolls back outputs and evidence', () => {
  const suite = mkdtempSync(join(tmpdir(), 'omp-ux-e2e-suite-output-target-race-'));
  const first = makeSessionDir();
  const second = makeSessionDir();
  renameSync(first, join(suite, 'session-a'));
  renameSync(second, join(suite, 'session-b'));
  const mdDir = mkdtempSync(join(tmpdir(), 'ux-e2e-suite-output-target-md-'));
  const evidenceRoot = join(mdDir, 'evidence', 'session-a');
  const moved = `${evidenceRoot}.moved`;
  let swapped = false;
  setEvidenceCopyTestHooks({
    beforeTargetOpen(path) {
      if (swapped || !path.startsWith(mdDir + sep) || !path.endsWith('.md')) return;
      swapped = true;
      renameSync(evidenceRoot, moved);
      mkdirSync(evidenceRoot, { recursive: true });
    },
  });
  try {
    assert.throws(
      () => generateReport(suite, { ...BASE_INPUT, verdict: 'FAIL' }, { mdDir, copyEvidence: true }),
    );
    assert.equal(swapped, true);
    assert.equal(readdirSync(evidenceRoot).length, 0, 'replacement evidence root remains empty');
    assert.equal(readdirSync(moved).length, 0, 'retained evidence is rolled back');
    assert.equal(existsSync(join(suite, '.work-state', 'ux-e2e', 'report.json')), false, 'suite JSON is rolled back');
  } finally {
    setEvidenceCopyTestHooks(null);
    rmSync(suite, { recursive: true, force: true });
    rmSync(mdDir, { recursive: true, force: true });
    rmSync(moved, { recursive: true, force: true });
  }
});


test('report: identical preexisting evidence survives later transaction rollback', () => {
  const dir = makeSessionDir();
  const mdDir = mkdtempSync(join(tmpdir(), 'ux-e2e-md-identical-collision-'));
  const source = readFileSync(join(dir, '.work-state', 'ux-e2e', 'transcript.jsonl'));
  const digest = createHash('sha256').update(source).digest('hex').slice(0, 16);
  const destinationDir = join(mdDir, 'evidence', 'my-feature', 'ux-e2e');
  const destination = join(destinationDir, `transcript.jsonl.${digest}`);
  mkdirSync(destinationDir, { recursive: true });
  writeFileSync(destination, source);
  const moved = `${dir}.moved`;
  let swapped = false;
  setEvidenceCopyTestHooks({
    beforeTargetOpen(path) {
      if (swapped || path !== join(dir, '.work-state', 'ux-e2e', 'report.json')) return;
      swapped = true;
      renameSync(dir, moved);
      renameSync(mkdtempSync(join(tmpdir(), 'ux-e2e-identical-collision-replacement-')), dir);
    },
  });
  try {
    assert.throws(
      () => generateReport(dir, { ...BASE_INPUT, verdict: 'FAIL' }, { mdDir, copyEvidence: true }),
    );
    assert.deepEqual(readFileSync(destination), source, 'identical preexisting destination remains owned by prior transaction');
  } finally {
    setEvidenceCopyTestHooks(null);
    if (swapped) {
      rmSync(dir, { recursive: true, force: true });
      renameSync(moved, dir);
    }
    rmSync(dir, { recursive: true, force: true });
    rmSync(mdDir, { recursive: true, force: true });
  }
});


test('fs safety: final quarantine in-place mutation restores the moved inode', { skip: process.platform === 'darwin' }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'ux-e2e-final-quarantine-mutation-'));
  const target = join(dir, 'target.txt');
  const original = Buffer.from('original bytes');
  const mutated = Buffer.from('mutated bytes');
  writeFileSync(target, original);
  const root = pinDirectory(dir);
  assert.ok(root);
  let mutatedInPlace = false;
  setFsSafetyTestHooks({
    beforeTargetRename(path) {
      if (mutatedInPlace || path !== target) return;
      const quarantine = readdirSync(dir).find(name => name.startsWith('.omp-unlink-'));
      if (quarantine === undefined) return;
      mutatedInPlace = true;
      writeFileSync(join(dir, quarantine), mutated);
    },
  });
  try {
    assert.equal(unlinkPinnedFileIfExact(root, 'target.txt', original), false);
    assert.equal(mutatedInPlace, true);
    assert.deepEqual(readFileSync(target), mutated, 'same moved inode is restored without deleting changed bytes');
  } finally {
    setFsSafetyTestHooks(null);
    closePinnedDirectory(root);
    rmSync(dir, { recursive: true, force: true });
  }
});


test('report: hardlinked prior markdown is unsafe and remains byte-exact', () => {
  const dir = makeSessionDir();
  const mdDir = mkdtempSync(join(tmpdir(), 'ux-e2e-md-hardlink-prior-'));
  const outside = mkdtempSync(join(tmpdir(), 'ux-e2e-md-hardlink-prior-outside-'));
  const expectedDate = new Date().toISOString().slice(0, 10);
  const destination = join(mdDir, `my-feature-ux-e2e-${expectedDate}.md`);
  const outsideFile = join(outside, 'prior.md');
  const previous = Buffer.from('prior hardlinked markdown');
  writeFileSync(outsideFile, previous);
  linkSync(outsideFile, destination);
  try {
    assert.throws(
      () => generateReport(dir, { ...BASE_INPUT, verdict: 'FAIL' }, { mdDir }),
    );
    assert.deepEqual(readFileSync(destination), previous);
    assert.deepEqual(readFileSync(outsideFile), previous);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(mdDir, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test('fs safety: lock contention reports bounded busy error on every platform', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ux-e2e-lock-contention-'));
  const root = pinDirectory(dir);
  assert.notEqual(root, null);
  try {
    assert.throws(
      () => withPinnedExclusiveLock(root, '.lock', () => withPinnedExclusiveLock(root, '.lock', () => undefined, 0), 0),
      /pinned lock is busy/u,
    );
  } finally {
    closePinnedDirectory(root);
    rmSync(dir, { recursive: true, force: true });
  }
});


test('report: concurrent reporter cannot restore stale output over committed output', () => {
  const dir = makeSessionDir();
  const mdDir = mkdtempSync(join(tmpdir(), 'ux-e2e-md-lock-'));
  const reportPath = join(dir, '.work-state', 'ux-e2e', 'report.json');
  let nested = false;
  let nestedError: unknown = null;
  setEvidenceCopyTestHooks({
    beforeTargetOpen(path) {
      if (nested || path !== reportPath) return;
      nested = true;
      try {
        generateReport(dir, { ...BASE_INPUT, verdict: 'FAIL' }, { mdDir });
      } catch (error) {
        nestedError = error;
      }
    },
  });
  try {
    const result = generateReport(dir, { ...BASE_INPUT, verdict: 'FAIL' }, { mdDir });
    assert.ok(result.jsonPath);
    assert.match(String(nestedError), /pinned lock is busy/u);
  } finally {
    setEvidenceCopyTestHooks(null);
    rmSync(dir, { recursive: true, force: true });
    rmSync(mdDir, { recursive: true, force: true });
  }
});


test('report: locked destination descriptor rejects pre-inner-pin lexical swap', () => {
  const dir = makeSessionDir();
  const mdDir = mkdtempSync(join(tmpdir(), 'ux-e2e-md-preinner-swap-'));
  const moved = `${mdDir}.moved`;
  const outside = mkdtempSync(join(tmpdir(), 'ux-e2e-md-preinner-outside-'));
  const reportPath = join(dir, '.work-state', 'ux-e2e', 'report.json');
  let swapped = false;
  setEvidenceCopyTestHooks({
    beforeTargetOpen(path) {
      if (swapped || path !== reportPath) return;
      swapped = true;
      renameSync(mdDir, moved);
      symlinkSync(outside, mdDir, 'dir');
    },
  });
  try {
    assert.throws(() => generateReport(dir, { ...BASE_INPUT, verdict: 'FAIL' }, { mdDir }));
    assert.equal(swapped, true);
    assert.equal(readdirSync(outside).length, 0, 'replacement destination receives no report');
  } finally {
    setEvidenceCopyTestHooks(null);
    unlinkSync(mdDir);
    renameSync(moved, mdDir);
    rmSync(dir, { recursive: true, force: true });
    rmSync(mdDir, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});
