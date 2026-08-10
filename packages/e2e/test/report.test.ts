/**
 * Report tests: defect-floor clamping, manual_qa-compatible fields,
 * markdown output, and evidence collection/copying.
 */

import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { generateReport, type UxE2eReport, type ReportInput } from '../src/report.js';

function makeSessionDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'ux-e2e-report-'));
  const stateDir = join(dir, '.work-state', 'ux-e2e');
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(
    join(stateDir, 'session.json'),
    JSON.stringify({
      slug: 'my-feature',
      omp_version: 'omp 17.2.3',
      profile: 'ux-e2e-test',
      url: 'http://127.0.0.1:1234/?token=super-secret-token',
      token: 'super-secret-token',
      wsPath: '/ws',
      user_config: { path: '/tmp/private/config.json', default_path: '/tmp/private/default.json' },
      tty: { cols: 100, rows: 30, term: 'xterm-256color' },
      started_at: '2026-08-02T10:00:00.000Z',
      task_prompt: 'implement the feature',
      scenario: { id: 'full-feature', title: 'Full feature' },
    }) + '\n',
  );
  writeFileSync(join(stateDir, 'transcript.jsonl'), '{"ts":"2026-08-02T10:00:00.000Z","t":"o","d":"Authorization: Bearer long-lived-secret-value token=super-secret-token \\"token\\":\\"quoted-secret\\"\\n"}\n');
  return dir;
}

const BASE_INPUT: ReportInput = {
  steps: [],
  defects: [],
  agent_quality: { rating: 4, rationale: 'solid work' },
  verdict: 'PASS',
  overall: { summary: 'good session' },
};

test('report: manual_qa-compatible JSON + markdown written', () => {
  const dir = makeSessionDir();
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
  assert.deepEqual(report.session.tty, { cols: 100, rows: 30, term: 'xterm-256color' });
  assert.equal(report.session.task_prompt, 'implement the feature');
  assert.deepEqual(report.session.scenario, { id: 'full-feature', title: 'Full feature' });
  assert.ok(typeof report.generated_at === 'string' && report.generated_at.length > 0);
  assert.ok(Array.isArray(report.evidence) && report.evidence.some(e => e.endsWith('transcript.jsonl')));
  assert.equal(report.overall.recommendation, 'ship');

  const md = readFileSync(result.mdPath, 'utf8');
  assert.ok(md.includes('# UX E2E Report'), 'markdown has the report title');
  assert.ok(md.includes('my-feature'), 'markdown references the slug');
  assert.ok(md.includes('**Verdict:** PASS'), 'markdown carries the verdict');
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

test('report: copyEvidence mirrors evidence files under <mdDir>/evidence/<slug>/', () => {
  const dir = makeSessionDir();
  const mdDir = mkdtempSync(join(tmpdir(), 'ux-e2e-md-'));
  const result = generateReport(dir, BASE_INPUT, { mdDir, copyEvidence: true });

  const mirroredSession = readFileSync(join(mdDir, 'evidence', 'my-feature', 'session.json'), 'utf8');
  assert.equal(mirroredSession.includes('super-secret-token'), false, 'mirrored session does not contain the bearer');
  assert.equal(mirroredSession.includes('/tmp/private'), false, 'mirrored session does not contain private paths');
  const report = JSON.parse(readFileSync(result.jsonPath, 'utf8')) as UxE2eReport;
  assert.ok(report.evidence.some(e => e.includes(join('evidence', 'my-feature'))), 'evidence points at mirrored copies');
  assert.ok(existsSync(join(mdDir, 'evidence', 'my-feature', 'transcript.jsonl')), 'transcript mirrored');
  assert.ok(existsSync(join(mdDir, 'evidence', 'my-feature', 'session.json')), 'session.json mirrored');
  const mirroredTranscript = readFileSync(join(mdDir, 'evidence', 'my-feature', 'transcript.jsonl'), 'utf8');
  assert.equal(mirroredTranscript.includes('long-lived-secret-value'), false, 'mirrored transcript does not contain a bearer');
  assert.equal(mirroredTranscript.includes('super-secret-token'), false, 'mirrored transcript does not contain the session token');
  assert.equal(mirroredTranscript.includes('quoted-secret'), false, 'mirrored transcript redacts quoted JSON credentials');
});
