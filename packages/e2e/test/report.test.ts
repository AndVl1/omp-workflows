/**
 * Report tests: defect floors plus manifest-scoped evidence and redaction.
 */

import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, test } from 'node:test';

import { acquireRunLease } from '../src/environment.js';
import { generateReport, type ReportInput, type UxE2eReport } from '../src/report.js';
import type { RunManifest } from '../src/manifest.js';

const DIGEST = 'a'.repeat(64);
const fixtureRootRestores: Array<() => void> = [];

afterEach(() => {
  while (fixtureRootRestores.length > 0) fixtureRootRestores.pop()?.();
});

interface Fixture {
  readonly root: string;
  readonly manifestPath: string;
  readonly manifest: RunManifest;
  readonly sessionJsonPath: string;
  readonly transcriptPath: string;
  readonly logPath: string;
}

function makeFixture(options: {
  readonly authFailure?: boolean;
} = {}): Fixture {
  const previousRoot = process.env.OMP_E2E_ROOT;
  const stateRoot = mkdtempSync(join(tmpdir(), 'ux-e2e-report-state-'));
  const root = join(stateRoot, 'runs', 'my-feature');
  mkdirSync(root, { recursive: true });
  const roots = {
    run: root,
    home: join(root, 'home'),
    agent: join(root, 'home', '.omp', 'agent'),
    workspace: join(root, 'workspace'),
    tmp: join(root, 'tmp'),
    private: join(root, 'private'),
    sessions: join(root, 'sessions'),
    logs: join(root, 'logs'),
    evidence: join(root, 'evidence'),
  } as const;
  for (const path of Object.values(roots)) mkdirSync(path, { recursive: true });

  const scenarioPath = join(roots.workspace, 'scenario.json');
  const coreRoot = join(root, 'artifacts', 'core');
  const fullstackRoot = join(root, 'artifacts', 'fullstack');
  const runtimeBinary = join(root, 'runtime', 'omp');
  mkdirSync(coreRoot, { recursive: true });
  mkdirSync(fullstackRoot, { recursive: true });
  mkdirSync(join(root, 'runtime'), { recursive: true });
  writeFileSync(scenarioPath, '{"id":"full-feature"}\n');
  writeFileSync(runtimeBinary, 'snapshot runtime\n');

  const sessionId = 'session-1';
  const sessionDir = join(roots.sessions, sessionId);
  const privateSessionDir = join(roots.private, 'sessions', sessionId);
  mkdirSync(sessionDir, { recursive: true });
  mkdirSync(privateSessionDir, { recursive: true });
  const transcriptPath = join(sessionDir, 'transcript.jsonl');
  const logPath = join(roots.logs, `${sessionId}.log`);
  const privateConnectionPath = join(privateSessionDir, 'connection.json');
  const terminalBearer = 'TERMINAL_BEARER_CANARY';
  const apiKey = 'API_KEY_CANARY';
  const brokerToken = 'BROKER_TOKEN_CANARY';
  const oauthRefresh = 'OAUTH_REFRESH_CANARY';
  const output = options.authFailure
    ? `Authorization: Bearer ${terminalBearer}\nOPENAI_API_KEY=${apiKey}\nOMP_AUTH_BROKER_TOKEN=${brokerToken}\nOAUTH_REFRESH_TOKEN=${oauthRefresh}\n`
    : `${JSON.stringify({ ts: '2026-08-02T10:00:00.000Z', t: 'o', d: 'stage: discovery\n' })}\n${JSON.stringify({ ts: '2026-08-02T10:00:01.000Z', t: 'exit', code: 0 })}\n`;
  writeFileSync(transcriptPath, output);
  writeFileSync(logPath, output);
  writeFileSync(privateConnectionPath, JSON.stringify({ token: brokerToken }) + '\n');
  const sessionJsonPath = join(sessionDir, 'session.json');
  writeFileSync(
    sessionJsonPath,
    JSON.stringify({
      id: sessionId,
      status: options.authFailure ? 'failed' : 'stopped',
      ...(options.authFailure ? {} : { exit_code: 0 }),
      slug: 'my-feature',
      omp_version: 'omp 18.3.4',
      profile: 'isolated-run',
      tty: { cols: 100, rows: 30, term: 'xterm-256color' },
      started_at: '2026-08-02T10:00:00.000Z',
      finished_at: '2026-08-02T10:05:00.000Z',
      ready: true,
      readiness: { typed_rpc_ready: true },
      termination: { requested: 'none', forced: false, observed: true },
      task_prompt: options.authFailure ? `failed with ${apiKey}` : 'implement the feature',
      scenario: { id: 'full-feature', title: 'Full feature' },
      token: terminalBearer,
      url: `http://127.0.0.1:43123/?token=${terminalBearer}`,
      api_key: apiKey,
      oauth_refresh_token: oauthRefresh,
    }) + '\n',
  );

  const manifest: RunManifest = {
    schema_version: 1,
    run_id: 'my-feature',
    input_digest: DIGEST,
    status: options.authFailure ? 'failed' : 'stopped',
    runtime: {
      binary: runtimeBinary,
      version: 'omp 18.3.4',
      digest: DIGEST,
      platform: process.platform,
      capabilities: {
        supported: true,
        command_signals: ['fixture-origin'],
        native_inventory: 'observed-only',
      },
    },
    artifacts: {
      core: { root: coreRoot, digest: DIGEST, version: '0.1.0' },
      fullstack: { root: fullstackRoot, digest: DIGEST, version: '0.1.0' },
    },
    roots,
    auth: options.authFailure
      ? { mode: 'broker', broker_url: 'http://127.0.0.1:43124', token_env: 'OMP_AUTH_BROKER_TOKEN' }
      : { mode: 'none' },
    model: null,
    scenario: { id: 'full-feature', path: scenarioPath, digest: DIGEST },
    sessions: [{
      id: sessionId,
      status: options.authFailure ? 'failed' : 'stopped',
      pid: null,
      start_marker: 'start-marker-1',
      transcript_path: transcriptPath,
      log_path: logPath,
      private_connection_path: privateConnectionPath,
    }],
    ...(options.authFailure ? { errors: [{ code: 'auth_unavailable', message: `broker rejected ${brokerToken}` }] } : {}),
  };
  const manifestPath = join(root, 'manifest.json');
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
  process.env.OMP_E2E_ROOT = stateRoot;
  fixtureRootRestores.push(() => {
    if (previousRoot === undefined) delete process.env.OMP_E2E_ROOT;
    else process.env.OMP_E2E_ROOT = previousRoot;
  });
  return { root, manifestPath, manifest, sessionJsonPath, transcriptPath, logPath };
}

const BASE_INPUT: ReportInput = {
  steps: [],
  defects: [],
  agent_quality: { rating: 4, rationale: 'solid work' },
  verdict: 'PASS',
  overall: { summary: 'good session' },
};

function readReport(path: string): UxE2eReport {
  return JSON.parse(readFileSync(path, 'utf8')) as UxE2eReport;
}

test('report: manifest-scoped JSON + markdown carry runtime and observation receipts', () => {
  const fixture = makeFixture();
  const mdDir = join(fixture.manifest.roots.evidence, 'markdown');
  const result = generateReport(fixture.manifestPath, BASE_INPUT, { mdDir });

  assert.ok(existsSync(result.jsonPath), 'report.json written under run evidence');
  assert.ok(existsSync(result.mdPath), 'markdown written');
  assert.equal(statSync(result.jsonPath).mode & 0o777, 0o600, 'JSON report is owner-only');
  assert.equal(statSync(result.mdPath).mode & 0o777, 0o600, 'Markdown report is owner-only');
  const report = readReport(result.jsonPath);
  assert.equal(report.type, 'ux-e2e');
  assert.equal(report.schema_version, 1);
  assert.equal(report.verdict, 'PASS');
  assert.equal(report.run_id, 'my-feature');
  assert.equal(report.auth.mode, 'none');
  assert.equal(report.session.id, 'session-1');
  assert.equal(report.session.slug, 'my-feature');
  assert.equal(report.session.omp_version, 'omp 18.3.4');
  assert.deepEqual(report.session.tty, { cols: 100, rows: 30, term: 'xterm-256color' });
  assert.deepEqual(report.session.scenario, { id: 'full-feature', title: 'Full feature' });
  assert.equal(report.receipts.runtime?.digest, DIGEST);
  assert.equal(report.receipts.inventory_complete, false);
  assert.deepEqual(report.receipts.native_signals, [{ supported: true, command_signals: ['fixture-origin'], native_inventory: 'observed-only' }]);
  assert.ok(report.evidence.some(path => path.endsWith(join('sessions', 'session-1', 'session.json'))));
  assert.ok(report.session.omp_log.endsWith('session-1.log'));
  assert.equal(report.overall.recommendation, 'ship');

  const md = readFileSync(result.mdPath, 'utf8');
  assert.ok(md.includes('# UX E2E Report'), 'markdown has the report title');
  assert.ok(md.includes('**Verdict:** PASS'), 'markdown carries the verdict');
  assert.ok(md.includes('process observations:'), 'markdown carries observation receipt summary');
});
test('report: verified process-level isolation can pass without an interactive session', () => {
  const fixture = makeFixture();
  rmSync(fixture.manifest.roots.sessions, { recursive: true });
  const receiptPath = join(fixture.manifest.roots.evidence, 'isolation-process-receipt.json');
  const receipt = {
    kind: 'process-observation',
    suite: 'isolation',
    provider_free_model: 'e2e-offline/no-request',
    provider_free_selected_model: true,
    rpc_responses_successful: true,
    process_exit_clean: true,
    evidence_path: receiptPath,
  };
  writeFileSync(receiptPath, JSON.stringify(receipt) + '\n');
  writeFileSync(fixture.manifestPath, JSON.stringify({
    ...fixture.manifest,
    status: 'ready',
    sessions: [],
    receipts: [receipt],
  }) + '\n');
  const input: ReportInput = {
    ...BASE_INPUT,
    verification: {
      suite: 'isolation',
      checks: {
        evidence_receipt_written: true,
        owned_processes_reaped: true,
        rpc_responses_successful: true,
        provider_free_selected_model: true,
        no_llm: true,
      },
      session_ids: [],
    },
  };
  const result = generateReport(fixture.manifestPath, input, { copyEvidence: true });
  const report = readReport(result.jsonPath);
  assert.equal(report.verdict, 'PASS');
  const copiedReceipt = report.evidence.find(path => path.endsWith('isolation-process-receipt.json'));
  assert.ok(copiedReceipt !== undefined && existsSync(copiedReceipt), 'the process receipt remains reachable after cleanup');

  writeFileSync(receiptPath, JSON.stringify({ ...receipt, provider_free_selected_model: false }) + '\n');
  const invalid = generateReport(fixture.manifestPath, input, { copyEvidence: true, mdDir: join(fixture.manifest.roots.evidence, 'invalid-isolation') });
  assert.equal(readReport(invalid.jsonPath).verdict, 'FAIL', 'a receipt contradicting provider-free selection cannot justify a PASS');
});

test('report: copied multi-session evidence keeps duplicate basenames attributed', () => {
  const fixture = makeFixture();
  const baseSession = fixture.manifest.sessions[0];
  assert.ok(baseSession !== undefined);
  const sessionIds = ['session-alpha', 'session-beta'] as const;
  const sessions: RunManifest['sessions'] = sessionIds.map((id): RunManifest['sessions'][number] => {
    const sessionDir = join(fixture.manifest.roots.sessions, id);
    const privateSessionDir = join(fixture.manifest.roots.private, 'sessions', id);
    mkdirSync(sessionDir, { recursive: true });
    mkdirSync(privateSessionDir, { recursive: true });
    const transcriptPath = join(sessionDir, 'transcript.jsonl');
    const sessionJsonPath = join(sessionDir, 'session.json');
    const logPath = join(fixture.manifest.roots.logs, `${id}.log`);
    const privateConnectionPath = join(privateSessionDir, 'connection.json');
    const transcript = `${JSON.stringify({ ts: '2026-08-02T10:01:00.000Z', t: 'o', d: `${id} transcript\n` })}\n${JSON.stringify({ ts: '2026-08-02T10:01:01.000Z', t: 'exit', code: 0 })}\n`;
    writeFileSync(transcriptPath, transcript);
    writeFileSync(logPath, `${id} log\n`);
    writeFileSync(privateConnectionPath, JSON.stringify({ token: `${id}-token` }) + '\n');
    writeFileSync(sessionJsonPath, JSON.stringify({
      id,
      slug: 'multi-session',
      omp_version: 'omp 18.3.4',
      profile: 'isolated-run',
      tty: { cols: 100, rows: 30, term: 'xterm-256color' },
      started_at: id === 'session-alpha' ? '2026-08-02T10:01:00.000Z' : '2026-08-02T10:02:00.000Z',
      exit_code: 0,
      ready: true,
      readiness: { typed_rpc_ready: true },
      termination: { requested: 'none', forced: false, observed: true },
    }) + '\n');
    return {
      ...baseSession,
      id,
      status: 'stopped',
      transcript_path: transcriptPath,
      log_path: logPath,
      private_connection_path: privateConnectionPath,
    };
  });
  const manifest: RunManifest = { ...fixture.manifest, sessions };
  writeFileSync(fixture.manifestPath, JSON.stringify(manifest, null, 2) + '\n');
  // A resumed PTY is registered on disk, not synchronously appended to the
  // immutable prepared manifest; both generations must survive cleanup.
  const diskOnlyId = 'session-gamma';
  const diskOnlyDir = join(fixture.manifest.roots.sessions, diskOnlyId);
  mkdirSync(diskOnlyDir, { recursive: true });
  const diskTranscript = join(diskOnlyDir, 'transcript.jsonl');
  const diskLog = join(fixture.manifest.roots.logs, `${diskOnlyId}.log`);
  const diskTranscriptBody = `${JSON.stringify({ ts: '2026-08-02T10:03:00.000Z', t: 'o', d: `${diskOnlyId} transcript\n` })}\n${JSON.stringify({ ts: '2026-08-02T10:03:01.000Z', t: 'exit', code: 0 })}\n`;
  writeFileSync(diskTranscript, diskTranscriptBody);
  writeFileSync(diskLog, `${diskOnlyId} log\n`);
  writeFileSync(join(diskOnlyDir, 'session.json'), JSON.stringify({
    id: diskOnlyId,
    status: 'stopped',
    slug: 'multi-session',
    started_at: '2026-08-02T10:03:00.000Z',
    exit_code: 0,
    ready: true,
    readiness: { typed_rpc_ready: true },
    termination: { requested: 'none', forced: false, observed: true },
    transcript_path: diskTranscript,
    log_path: diskLog,
  }) + '\n');

  const mdDir = join(fixture.manifest.roots.evidence, 'markdown-multi-session');
  const result = generateReport(fixture.manifestPath, BASE_INPUT, { mdDir, copyEvidence: true });
  const evidenceDir = join(mdDir, 'evidence', 'multi-session');
  const report = readReport(result.jsonPath);

  for (const id of [...sessionIds, diskOnlyId]) {
    const copiedTranscript = join(evidenceDir, 'sessions', id, 'transcript.jsonl');
    const copiedSession = join(evidenceDir, 'sessions', id, 'session.json');
    const frameTime = id === diskOnlyId ? '2026-08-02T10:03:00.000Z' : '2026-08-02T10:01:00.000Z';
    const exitTime = id === diskOnlyId ? '2026-08-02T10:03:01.000Z' : '2026-08-02T10:01:01.000Z';
    assert.equal(readFileSync(copiedTranscript, 'utf8'), `${JSON.stringify({ ts: frameTime, t: 'o', d: `${id} transcript\n` })}\n${JSON.stringify({ ts: exitTime, t: 'exit', code: 0 })}\n`);
    const copiedSessionValue: unknown = JSON.parse(readFileSync(copiedSession, 'utf8'));
    assert.ok(
      typeof copiedSessionValue === 'object' &&
        copiedSessionValue !== null &&
        'id' in copiedSessionValue &&
        copiedSessionValue.id === id,
      `${id} metadata keeps its session identity`,
    );
    assert.ok(report.evidence.includes(copiedTranscript), `report attributes ${id} transcript`);
    assert.ok(report.evidence.includes(copiedSession), `report attributes ${id} metadata`);
  }
  assert.ok(report.session.transcript.startsWith(evidenceDir), 'selected transcript points to the retained copy');
  assert.ok(report.evidence.includes(report.session.transcript), 'selected transcript remains reachable after cleanup');
  assert.ok(report.evidence.includes(report.session.omp_log), 'selected log remains reachable after cleanup');
});

test('report: binary screenshot with embedded credential is omitted from copied evidence', () => {
  const fixture = makeFixture();
  const screenshot = join(fixture.manifest.roots.sessions, 'session-1', 'screen.png');
  const fakeCredential = 'secret-in-pixels-unique-987654321';
  writeFileSync(screenshot, Buffer.from(`PNG ${fakeCredential}`));
  const mdDir = join(fixture.manifest.roots.evidence, 'markdown-binary');
  const result = generateReport(fixture.manifestPath, {
    ...BASE_INPUT,
    steps: [{
      id: 'screenshot',
      name: 'Credentials can appear on screen',
      order: 1,
      ratings: { message_clarity: 3 },
      defects: [],
      screenshots: [screenshot],
    }],
  }, { mdDir, copyEvidence: true });
  const report = readReport(result.jsonPath);
  assert.ok(result.warnings.some(warning => warning.includes('binary evidence omitted')));
  assert.equal(report.receipts.omitted_raw_evidence, true);
  assert.deepEqual(report.steps[0]?.screenshots, []);
  assert.ok(report.evidence.every(path => !path.endsWith('screen.png')));
  assert.equal(existsSync(join(mdDir, 'evidence', 'my-feature', 'screen.png')), false);
  assert.equal(readFileSync(result.jsonPath, 'utf8').includes(fakeCredential), false);
});

test('report: unrelated newer global log is ignored', () => {
  const fixture = makeFixture();
  const unrelated = mkdtempSync(join(tmpdir(), 'ux-e2e-unrelated-'));
  const unrelatedLog = join(unrelated, 'omp.newest.log');
  writeFileSync(unrelatedLog, 'UNRELATED_GLOBAL_LOG\n');
  const result = generateReport(fixture.manifestPath, BASE_INPUT);
  const report = readReport(result.jsonPath);

  assert.ok(report.evidence.every(path => !path.startsWith(unrelated)), 'evidence is limited to registered session paths');
  assert.equal(report.session.omp_log, fixture.logPath);
  assert.ok(!JSON.stringify(report).includes('UNRELATED_GLOBAL_LOG'));
});

test('report: CRITICAL defect floors cap the step rating and overall score', () => {
  const fixture = makeFixture();
  const result = generateReport(fixture.manifestPath, {
    ...BASE_INPUT,
    verdict: 'CONDITIONAL',
    steps: [
      { name: 'Clarify', order: 1, ratings: { message_clarity: 5, feedback_timing: 5 }, defects: ['D1'], screenshots: [] },
      { name: 'Implement', order: 2, ratings: { message_clarity: 4 }, defects: [], screenshots: [] },
    ],
    defects: [
      { severity: 'CRITICAL', dimension: 'message_clarity', title: 'crash on ask', step: 'S1', evidence: ['session-1.json'] },
    ],
  });

  const report = readReport(result.jsonPath);
  const step1 = report.steps.find(step => step.order === 1);
  const step2 = report.steps.find(step => step.order === 2);
  assert.ok(step1 !== undefined && step1.ratings.message_clarity === 1, 'CRITICAL floor caps at 1');
  assert.ok(step1 !== undefined && step1.ratings.feedback_timing === 1, 'every dimension is floored');
  assert.ok(step2 !== undefined && step2.ratings.message_clarity === 4, 'no defect -> rating untouched');
  assert.equal(report.overall.score, 1, 'worst defect floor caps the overall score');
  assert.equal(report.overall.recommendation, 'rework');
  assert.ok(result.warnings.some(warning => warning.includes('defect floor')), 'clamps emit warnings');
});

test('report: LOW defect floor caps at 4, agent_quality not floored', () => {
  const fixture = makeFixture();
  const result = generateReport(fixture.manifestPath, {
    ...BASE_INPUT,
    steps: [{ name: 'Implement', order: 1, ratings: { message_clarity: 5 }, defects: ['D1'], screenshots: [] }],
    defects: [{ severity: 'LOW', dimension: 'layout', title: 'cosmetic gap', step: 'S1', evidence: [] }],
  });

  const report = readReport(result.jsonPath);
  assert.equal(report.steps[0]?.ratings.message_clarity, 4, 'LOW floor caps at 4');
  assert.equal(report.agent_quality.rating, 4, 'agent quality keeps its own rating');
  assert.equal(report.overall.score, 4, 'overall follows the LOW floor');
});

test('report: auto-ids assigned when omitted', () => {
  const fixture = makeFixture();
  const result = generateReport(fixture.manifestPath, {
    ...BASE_INPUT,
    steps: [{ name: 'Solo', order: 1, ratings: { layout: 3 }, defects: ['D1'], screenshots: [] }],
    defects: [{ severity: 'MEDIUM', dimension: 'layout', title: 'overlap', step: 'S1', evidence: [] }],
  });

  const report = readReport(result.jsonPath);
  assert.equal(report.steps[0]?.id, 'S1');
  assert.equal(report.defects[0]?.id, 'D1');
  assert.equal(report.steps[0]?.ratings.layout, 3, 'MEDIUM floor 3 clamps nothing here');
});

test('report: exact selected auth values redact opaque transcript and caller fields', () => {
  const fixture = makeFixture();
  const envName = 'E2E_REPORT_OPAQUE_KEY';
  const opaque = 'opaque-provider-value-7f8e9d';
  const previous = process.env[envName];
  process.env[envName] = opaque;
  try {
    const manifest: RunManifest = {
      ...fixture.manifest,
      auth: { mode: 'api-key-env', keys: [{ provider: 'fixture', env_name: envName }] },
    };
    writeFileSync(fixture.manifestPath, JSON.stringify(manifest, null, 2) + '\n');
    writeFileSync(fixture.transcriptPath, `${JSON.stringify({ ts: '2026-08-02T10:00:00.000Z', t: 'o', d: opaque })}\n${JSON.stringify({ ts: '2026-08-02T10:00:01.000Z', t: 'exit', code: 0 })}\n`);
    writeFileSync(fixture.logPath, `${opaque}\n`);
    const mdDir = join(fixture.manifest.roots.evidence, 'markdown-opaque');
    const result = generateReport(fixture.manifestPath, {
      ...BASE_INPUT,
      steps: [{
        name: opaque,
        order: 1,
        ratings: { message_clarity: 4 },
        defects: [],
        screenshots: [],
        transcript_excerpt: `provider echoed ${opaque}`,
      }],
      agent_quality: { rating: 4, rationale: opaque },
      overall: { summary: opaque },
    }, { mdDir, copyEvidence: true });
    const copiedTranscript = join(mdDir, 'evidence', 'my-feature', 'transcript.jsonl');
    const copiedLog = join(mdDir, 'evidence', 'my-feature', 'session-1.log');
    const exported = [
      readFileSync(result.jsonPath, 'utf8'),
      readFileSync(result.mdPath, 'utf8'),
      readFileSync(copiedTranscript, 'utf8'),
      readFileSync(copiedLog, 'utf8'),
    ].join('\n');
    assert.equal(exported.includes(opaque), false, 'opaque selected auth value is absent from every export');
  } finally {
    if (previous === undefined) delete process.env[envName];
    else process.env[envName] = previous;
  }
});

test('report: symlinked and external report outputs are rejected without escaping the run', () => {
  const fixture = makeFixture();
  const outside = mkdtempSync(join(tmpdir(), 'ux-e2e-report-outside-'));
  assert.throws(
    () => generateReport(fixture.manifestPath, BASE_INPUT, { mdDir: outside }),
    /report_output_outside_run/u,
  );

  const reportSessionDir = join(fixture.manifest.roots.evidence, 'session-1');
  mkdirSync(reportSessionDir, { recursive: true });
  const outsideReport = join(outside, 'report.json');
  writeFileSync(outsideReport, 'outside sentinel\n');
  symlinkSync(outsideReport, join(reportSessionDir, 'report.json'));
  assert.throws(
    () => generateReport(fixture.manifestPath, BASE_INPUT),
    /report_output_symlink/u,
  );
  assert.equal(readFileSync(outsideReport, 'utf8'), 'outside sentinel\n');
});

test('report: nonzero PTY exit cannot receive PASS', () => {
  const fixture = makeFixture();
  writeFileSync(fixture.transcriptPath, `${JSON.stringify({ ts: '2026-08-02T10:00:01.000Z', t: 'exit', code: 17 })}\n`);
  const result = generateReport(fixture.manifestPath, BASE_INPUT);
  const report = readReport(result.jsonPath);
  assert.equal(report.verdict, 'FAIL');
  assert.ok(result.warnings.some(warning => warning.includes('session_exit_nonzero')), 'nonzero exit emits a refusal warning');
});

test('report: owner-requested graceful SIGTERM needs observed non-forced metadata', () => {
  const fixture = makeFixture();
  const session = JSON.parse(readFileSync(fixture.sessionJsonPath, 'utf8')) as Record<string, unknown>;
  rmSync(fixture.sessionJsonPath);
  const runLease = acquireRunLease(fixture.manifest, 'session-1');
  const sessionPid = Number.MAX_SAFE_INTEGER;
  session.lease_marker = 'fixture-session-lease';
  session.pid = sessionPid;
  session.start_marker = 'start-marker-1';
  session.exit_signal = 15;
  session.termination = { requested: 'owner', requested_signal: 15, forced: false, observed: true };
  session.process = {
    pid: sessionPid,
    pgid: sessionPid,
    start_marker: 'start-marker-1',
    executable_digest: 'a'.repeat(64),
    argv_digest: 'b'.repeat(64),
    cwd_relative: '.',
    owner_nonce: `${fixture.manifest.run_id}:session-1:${runLease.marker}`,
  };
  writeFileSync(fixture.sessionJsonPath, JSON.stringify(session) + '\n');
  runLease.release();
  writeFileSync(fixture.transcriptPath, `${JSON.stringify({ ts: '2026-08-02T10:00:00.000Z', t: 'o', d: 'stage: discovery\n' })}\n${JSON.stringify({ ts: '2026-08-02T10:00:01.000Z', t: 'exit', code: 0, signal: 15 })}\n`);
  const graceful = generateReport(fixture.manifestPath, BASE_INPUT, { mdDir: join(fixture.manifest.roots.evidence, 'graceful') });
  assert.equal(readReport(graceful.jsonPath).verdict, 'PASS');
  session.exit_code = 143;
  session.exit_signal = 0;
  session.termination = { requested: 'owner', requested_signal: 15, forced: false, observed: true };
  writeFileSync(fixture.sessionJsonPath, JSON.stringify(session) + '\n');
  writeFileSync(fixture.transcriptPath, `${JSON.stringify({ ts: '2026-08-02T10:00:00.000Z', t: 'o', d: 'stage: discovery\n' })}\n${JSON.stringify({ ts: '2026-08-02T10:00:01.000Z', t: 'exit', code: 143, signal: 0 })}\n`);
  const conventional = generateReport(fixture.manifestPath, BASE_INPUT, { mdDir: join(fixture.manifest.roots.evidence, 'conventional') });
  assert.equal(readReport(conventional.jsonPath).verdict, 'PASS');

  session.termination = { requested: 'none', forced: false, observed: true };
  writeFileSync(fixture.sessionJsonPath, JSON.stringify(session) + '\n');
  const unrequested = generateReport(fixture.manifestPath, BASE_INPUT, { mdDir: join(fixture.manifest.roots.evidence, 'unrequested') });
  assert.equal(readReport(unrequested.jsonPath).verdict, 'FAIL');

  session.exit_code = 0;
  delete session.exit_signal;
  session.termination = { requested: 'owner', requested_signal: 9, forced: false, observed: true };
  writeFileSync(fixture.sessionJsonPath, JSON.stringify(session) + '\n');
  writeFileSync(fixture.transcriptPath, `${JSON.stringify({ ts: '2026-08-02T10:00:00.000Z', t: 'o', d: 'stage: discovery\n' })}\n${JSON.stringify({ ts: '2026-08-02T10:00:01.000Z', t: 'exit', code: 0 })}\n`);
  const malformedSignal = generateReport(fixture.manifestPath, BASE_INPUT, { mdDir: join(fixture.manifest.roots.evidence, 'malformed-signal') });
  assert.equal(readReport(malformedSignal.jsonPath).verdict, 'FAIL');

  session.exit_signal = null;
  session.termination = { requested: 'recovery', requested_signal: 15, forced: false, observed: true };
  writeFileSync(fixture.sessionJsonPath, JSON.stringify(session) + '\n');
  const nullSignal = generateReport(fixture.manifestPath, BASE_INPUT, { mdDir: join(fixture.manifest.roots.evidence, 'null-signal') });
  assert.equal(readReport(nullSignal.jsonPath).verdict, 'FAIL');


  session.termination = { requested: 'owner', requested_signal: 15, forced: true, observed: true };
  writeFileSync(fixture.sessionJsonPath, JSON.stringify(session) + '\n');
  const forced = generateReport(fixture.manifestPath, BASE_INPUT, { mdDir: join(fixture.manifest.roots.evidence, 'forced') });
  assert.equal(readReport(forced.jsonPath).verdict, 'FAIL');
});

test('report: disk-only owner stop cannot omit identity or borrow another session transcript', () => {
  const fixture = makeFixture();
  const sessionId = 'session-planted-owner-stop';
  const sessionDir = join(fixture.manifest.roots.sessions, sessionId);
  mkdirSync(sessionDir, { recursive: true });
  mkdirSync(join(fixture.manifest.roots.private, 'sessions', sessionId), { recursive: true });
  const canonicalTranscript = join(sessionDir, 'transcript.jsonl');
  writeFileSync(
    canonicalTranscript,
    `${JSON.stringify({ ts: '2026-08-02T10:01:00.000Z', t: 'o', d: 'planted output\n' })}\n${JSON.stringify({ ts: '2026-08-02T10:01:01.000Z', t: 'exit', code: 143, signal: 0 })}\n`,
  );
  writeFileSync(join(sessionDir, 'session.json'), JSON.stringify({
    id: sessionId,
    status: 'stopped',
    started_at: '2026-08-02T10:01:00.000Z',
    exit_code: 143,
    exit_signal: 0,
    ready: true,
    readiness: { typed_rpc_ready: true },
    termination: { requested: 'owner', requested_signal: 15, forced: false, observed: true },
    lease_marker: 'planted-owner',
    process: {
      pid: 456,
      pgid: 456,
      start_marker: 'planted-start',
      executable_digest: 'a'.repeat(64),
      argv_digest: 'b'.repeat(64),
      cwd_relative: '.',
      owner_nonce: `my-feature:${sessionId}:planted-owner`,
    },
    transcript_path: fixture.transcriptPath,
    log_path: fixture.logPath,
    private_connection_path: fixture.manifest.sessions[0]?.private_connection_path,
  }) + '\n');

  const result = generateReport(fixture.manifestPath, BASE_INPUT, { sessionId });
  const report = readReport(result.jsonPath);
  assert.equal(report.verdict, 'FAIL', 'a disk-only owner 143/0 tuple without record PID/start-marker is refused');
  assert.equal(report.session.transcript, canonicalTranscript, 'the selected transcript is derived from the planted session directory');
  assert.notEqual(report.session.transcript, fixture.transcriptPath, 'another session transcript cannot be selected');
  assert.ok(result.warnings.some(warning => warning.includes('session_failed')), 'the invalid lifecycle envelope produces a refusal warning');
});

test('report: disk-only owner receipt cannot self-assert its run lease identity', () => {
  const fixture = makeFixture();
  const sessionId = 'session-forged-owner-proof';
  const sessionDir = join(fixture.manifest.roots.sessions, sessionId);
  const privateSessionDir = join(fixture.manifest.roots.private, 'sessions', sessionId);
  mkdirSync(sessionDir, { recursive: true });
  mkdirSync(privateSessionDir, { recursive: true });
  writeFileSync(
    join(privateSessionDir, 'connection.json'),
    JSON.stringify({ token: 'FORGED_CONNECTION_TOKEN' }) + '\n',
  );
  const canonicalTranscript = join(sessionDir, 'transcript.jsonl');
  writeFileSync(
    canonicalTranscript,
    `${JSON.stringify({ ts: '2026-08-02T10:01:00.000Z', t: 'o', d: 'forged output\n' })}\n${JSON.stringify({ ts: '2026-08-02T10:01:01.000Z', t: 'exit', code: 143, signal: 0 })}\n`,
  );
  const pid = Number.MAX_SAFE_INTEGER;
  writeFileSync(join(sessionDir, 'session.json'), JSON.stringify({
    id: sessionId,
    status: 'stopped',
    started_at: '2026-08-02T10:01:00.000Z',
    exit_code: 143,
    exit_signal: 0,
    ready: true,
    readiness: { typed_rpc_ready: true },
    termination: { requested: 'owner', requested_signal: 15, forced: false, observed: true },
    lease_marker: 'forged-session-lease',
    pid,
    start_marker: 'forged-start',
    process: {
      pid,
      pgid: pid,
      start_marker: 'forged-start',
      executable_digest: 'a'.repeat(64),
      argv_digest: 'b'.repeat(64),
      cwd_relative: '.',
      owner_nonce: `${fixture.manifest.run_id}:${sessionId}:forged-run-lease`,
    },
    transcript_path: canonicalTranscript,
    log_path: join(fixture.manifest.roots.logs, `${sessionId}.log`),
    private_connection_path: join(privateSessionDir, 'connection.json'),
  }) + '\n');

  const result = generateReport(fixture.manifestPath, BASE_INPUT, { sessionId });
  const report = readReport(result.jsonPath);
  assert.equal(report.verdict, 'FAIL', 'a complete self-declared owner record is not independent run lease evidence');
  assert.equal(report.session.transcript, canonicalTranscript, 'the canonical transcript remains selected');
  assert.ok(result.warnings.some(warning => warning.includes('session_termination_unverified')), 'missing persisted run lease identity refuses owner-stop evidence');
});


test('report: session without typed readiness cannot receive PASS', () => {
  const fixture = makeFixture();
  const session = JSON.parse(readFileSync(fixture.sessionJsonPath, 'utf8')) as Record<string, unknown>;
  session.ready = false;
  session.readiness = { typed_rpc_ready: false };
  writeFileSync(fixture.sessionJsonPath, JSON.stringify(session) + '\n');
  const result = generateReport(fixture.manifestPath, BASE_INPUT);
  const report = readReport(result.jsonPath);
  assert.equal(report.verdict, 'FAIL');
  assert.ok(result.warnings.some(warning => warning.includes('session_not_ready')), 'unready session emits a refusal warning');
});

test('report: omitted session scope refuses PASS when any registered session lacks clean evidence', () => {
  const fixture = makeFixture();
  const base = fixture.manifest.sessions[0];
  assert.ok(base !== undefined);
  const incompleteId = 'session-incomplete';
  const incompleteTranscript = join(fixture.manifest.roots.sessions, incompleteId, 'transcript.jsonl');
  const incomplete: RunManifest['sessions'][number] = {
    ...base,
    id: incompleteId,
    status: 'stopped',
    transcript_path: incompleteTranscript,
    log_path: join(fixture.manifest.roots.logs, `${incompleteId}.log`),
    private_connection_path: join(fixture.manifest.roots.private, 'sessions', incompleteId, 'connection.json'),
  };
  const incompleteSessionRoot = join(fixture.manifest.roots.sessions, incompleteId);
  mkdirSync(incompleteSessionRoot);
  writeFileSync(join(incompleteSessionRoot, 'session.json'), JSON.stringify({
    id: incompleteId,
    status: 'stopped',
    exit_code: 0,
    ready: true,
    readiness: { typed_rpc_ready: true },
    termination: { requested: 'none', forced: false, observed: true },
  }) + '\n');
  writeFileSync(fixture.manifestPath, JSON.stringify({
    ...fixture.manifest,
    sessions: [...fixture.manifest.sessions, incomplete],
  }, null, 2) + '\n');
  const result = generateReport(fixture.manifestPath, BASE_INPUT);
  const report = readReport(result.jsonPath);
  assert.equal(report.verdict, 'FAIL');
  assert.ok(result.warnings.some(warning => warning.includes('session_transcript_unavailable')));
});

test('report: auth failure export omits API, broker, OAuth, and terminal bearer values', () => {
  const fixture = makeFixture({ authFailure: true });
  const mdDir = join(fixture.manifest.roots.evidence, 'markdown-redacted');
  const result = generateReport(fixture.manifestPath, {
    ...BASE_INPUT,
    verdict: 'FAIL',
    overall: { summary: 'provider failed at https://broker.invalid/?access_token=BROKER_TOKEN_CANARY' },
    defects: [{
      severity: 'HIGH',
      dimension: 'error_handling',
      title: 'auth failure',
      step: 'S1',
      evidence: ['session-1.log'],
      notes: 'Authorization: Bearer TERMINAL_BEARER_CANARY',
    }],
  }, { mdDir, copyEvidence: true });

  const report = readReport(result.jsonPath);
  assert.deepEqual(report.errors, [{ code: 'auth_unavailable' }]);
  assert.equal(report.auth.mode, 'broker');
  assert.equal(report.receipts.omitted_raw_evidence, true);
  const copiedSession = join(mdDir, 'evidence', 'my-feature', 'session.json');
  const exported = [
    readFileSync(result.jsonPath, 'utf8'),
    readFileSync(result.mdPath, 'utf8'),
    readFileSync(copiedSession, 'utf8'),
  ].join('\n');
  for (const secret of ['API_KEY_CANARY', 'BROKER_TOKEN_CANARY', 'OAUTH_REFRESH_CANARY', 'TERMINAL_BEARER_CANARY']) {
    assert.ok(!exported.includes(secret), `${secret} is absent from exported report`);
  }
  assert.ok(!report.evidence.some(path => path.endsWith('.log') || path.endsWith('.jsonl')), 'raw logs/transcript omitted when private credentials are unavailable');
});
