/**
 * T061 — real-harness runtime contract for read-only external specification
 * import (US4). These assertions run against a live OMP session in an
 * authorized scratch repository and define the `/spec-import` contract before
 * implementation lands (T062–T072): complete bundles reach exactly one
 * compatibility checkpoint and the shared imported handoff, while incomplete,
 * ambiguous, and hostile bundles block before any implementation, and every
 * replay/approval/dispatch attempt leaves the external source bytes
 * byte-for-byte unchanged (FR-055–FR-070, SC-014–SC-018).
 *
 * The import surface itself is untrusted local input: these tests never
 * fetch remote content, never execute source instructions, and only drive the
 * sanctioned harness builders from `../src/specification-fixtures.js`.
 */

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  appendFileSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
  type Stats,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

import { resolveFeatureWorkspace, createFeatureWorkspace } from '../../core/src/specification/workspace.js';
import { canonicalHandoffDigest } from '../../core/src/specification/handoff.js';
import {
  approveImportedHandoff,
  bindImportRecognition,
  buildCompatibilityReport,
  createImportSnapshot,
  createImportedHandoff,
  revalidateImportedHandoffForDispatch,
} from '../../core/src/specification/import.js';
import { isSafeFeatureId, validateImplementationHandoff } from '../../core/src/specification/validation.js';
import type { FeatureWorkspace, ImplementationHandoff } from '../../core/src/specification/types.js';
import { validConstitutionBinding, validImplementationHandoff } from '../../core/test/fixtures/specification-fixtures.js';
import { speckitRecognizer } from '../../fullstack/src/specification/recognizers/speckit.js';
import { openspecRecognizer } from '../../fullstack/src/specification/recognizers/openspec.js';
import { bmadRecognizer } from '../../fullstack/src/specification/recognizers/bmad.js';
import { superpowersRecognizer } from '../../fullstack/src/specification/recognizers/superpowers.js';
import { xpowersRecognizer } from '../../fullstack/src/specification/recognizers/xpowers.js';
import type { AskBlock, SelectedAskBlock } from '../src/driver.js';
import { answerSelectedAsk, matchesCanonicalSelectorOptions, stripAnsi, TranscriptLog, waitFor, waitForOmpTuiReady, WsDriver } from '../src/driver.js';
import { createScratchSpecificationRepository } from '../src/specification-fixtures.js';
import { startTestSession, type TestSession } from '../src/server.js';

const SCENARIO = {
  id: 'spec-import',
  title: 'Read-only external specification import',
} as const;
/** Bounded real-time window for the harness to settle one import response. */
const IMPORT_TIMEOUT_MS = envTimeoutMs("OMP_UX_E2E_SEMANTIC_TIMEOUT_MS", 180_000);
/** Output is considered settled after this much frame silence. */
const STABILITY_WINDOW_MS = 10_000;
const WAIT_TIMEOUT_MS = 120_000;
/** Bounded real-time window for the executor to claim the imported handoff. */
const CLAIM_WINDOW_MS = 180_000;

function envTimeoutMs(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) return fallback;
  return Math.floor(value);
}

const PRESERVE_ON_FAILURE = /^(?:1|true|yes)$/iu.test(process.env["OMP_UX_E2E_PRESERVE_ON_FAILURE"] ?? "");

function cleanupScratchOnCompletion(scratch: Scratch, passed: boolean): void {
  if (PRESERVE_ON_FAILURE && !passed) {
    console.error(`ux-e2e: preserving failed scratch evidence at ${scratch.parent}`);
    return;
  }
  rmSync(scratch.parent, { recursive: true, force: true });
}
const DIGEST_RE = /^[0-9a-f]{64}$/u;

/** Secret-like fixture markers that must never surface in readable output. */
const SECRET_MARKERS = [
  'AKIAIOSFODNN7EXAMPLE',
  'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
  'ghp_0000000000000000000000000000000000',
  'xoxb-000000000000000-000000000000000-0000000000000000000000',
] as const;

type Scratch = { root: string; parent: string; bundleRoot: string };
type OpenSession = { session: TestSession; driver: WsDriver };

type Journey = {
  /** Transcript output captured from the submitted command onward. */
  readonly text: string;
  /** Durable response emitted by the slash-command handler before model work. */
  readonly initialResponse: string | null;
  /** Whether the requested semantic readiness predicate was actually satisfied. */
  readonly semanticReady: boolean;
  readonly log: TranscriptLog;
};

type PersistedState = {
  run_key?: unknown;
  specification?: {
    feature_id?: unknown;
    status?: unknown;
    next_action?: { kind?: string; command?: string | null; reason?: string };
    import_ref?: unknown;
    handoff_ref?: unknown;
    execution_claim_ref?: unknown;
  };
};

type ImportedHandoff = {
  handoff_id: string;
  handoff_digest: string;
  feature_id: string;
  status: string;
  source_kind?: unknown;
  import_snapshot_ref?: unknown;
  compatibility_supplement_ref?: unknown;
  artifact_versions?: Array<{ artifact_id?: unknown; kind?: unknown; version?: unknown; sha256?: unknown }>;
  scope?: { in_scope?: string[]; out_of_scope?: string[]; constraints?: string[] };
  requirements?: Array<{ requirement_id?: unknown; acceptance_ids?: unknown }>;
  decisions?: unknown[];
  tasks?: unknown[];
  verification?: unknown[];
  open_decisions?: unknown;
  execution_choices?: unknown[];
  constitution_binding?: { content_sha256?: unknown } | null;
};

type ClaimArtifact = {
  claim_id: string;
  handoff_digest: string;
  owner_kind: string;
  owner_run_id: string;
  status: string;
};

// ---------------------------------------------------------------------------
// Helpers (mirroring the T049 runtime harness).
// ---------------------------------------------------------------------------


/**
 * path → content digest over a materialized bundle, never following
 * symlinks (a symlink is pinned by its exact target string). This is the
 * source-immutability baseline every journey compares against.
 */
function bundleDigests(bundleRoot: string, prefix = ''): Map<string, string> {
  const digests = new Map<string, string>();
  for (const dirent of readdirSync(join(bundleRoot, prefix), { withFileTypes: true })) {
    const relative = prefix === '' ? dirent.name : `${prefix}/${dirent.name}`;
    const absolute = join(bundleRoot, relative);
    if (dirent.isSymbolicLink()) {
      digests.set(relative, `symlink:${readlinkSync(absolute)}`);
    } else if (dirent.isDirectory()) {
      for (const [nested, digest] of bundleDigests(bundleRoot, relative)) digests.set(nested, digest);
    } else if (dirent.isFile()) {
      digests.set(relative, createHash('sha256').update(readFileSync(absolute)).digest('hex'));
    } else {
      digests.set(relative, `special:${statSync(absolute).mode}`);
    }
  }
  return digests;
}

function makeScratch(slug: string, bundleId: string, as: string): Scratch {
  const parent = mkdtempSync(join(tmpdir(), `omp-spec-import-${slug}-`));
  const repository = createScratchSpecificationRepository({
    workdir: parent,
    slug,
    runtime: true,
    constitution: { variant: 'usable' },
    bundles: [{ id: bundleId, as }],
  });
  return { root: repository.root, parent, bundleRoot: join(repository.root, as) };
}

/**
 * Return true only for a canonical feature workspace.  The observability
 * recorder may create `<feature>/observability/events.jsonl` before a
 * specification state exists, so a directory is not evidence of a workspace.
 * The production resolver remains the authority for the durable envelope and
 * project/feature identity checks.
 */
function isCanonicalFeatureWorkspace(root: string, featureId: string): boolean {
  const statePath = join(root, '.work-state', 'features', featureId, 'state.json');
  let parsed: unknown;
  try {
    if (!lstatSync(statePath).isFile()) return false;
    parsed = JSON.parse(readFileSync(statePath, 'utf8')) as unknown;
  } catch {
    // Missing, partially written, or malformed state is not a workspace.
    return false;
  }
  if (!isRecord(parsed) || typeof parsed.run_key !== 'string' || parsed.run_key.trim().length === 0) return false;
  const specification = parsed.specification;
  if (!isRecord(specification) || typeof specification.feature_id !== 'string') return false;
  if (specification.feature_id !== featureId) {
    throw new Error(
      `feature workspace state identity mismatch: directory '${featureId}' carries '${specification.feature_id}'`,
    );
  }
  const resolved = resolveFeatureWorkspace(root, { feature_id: featureId, run_key: parsed.run_key });
  if (!resolved.ok) {
    throw new Error(`feature workspace '${featureId}' has invalid canonical state: ${resolved.code}: ${resolved.error}`);
  }
  return true;
}

function featureWorkspaceIds(root: string): string[] {
  const dir = join(root, '.work-state', 'features');
  if (!existsSync(dir)) return [];
  const ids: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
    if (isCanonicalFeatureWorkspace(root, entry.name)) ids.push(entry.name);
  }
  return ids.sort();
}

function assertSingleFeatureWorkspace(root: string, ids: readonly string[]): void {
  if (ids.length > 1) {
    throw new Error(`multiple canonical feature workspaces detected under ${root}: ${ids.join(', ')}`);
  }
}

function createCanonicalWorkspace(root: string, featureId: string): void {
  const created = createFeatureWorkspace(root, {
    feature_id: featureId,
    display_name: featureId,
    run_key: `run-${featureId}`,
    profile_name: 'spec-preparation',
    profile_hash: 'a'.repeat(64),
  });
  if (!created.ok) throw new Error(`failed to create fixture workspace '${featureId}': ${created.error}`);
}

function makeWorkspaceProbeRoot(): string {
  return mkdtempSync(join(tmpdir(), 'omp-spec-import-workspaces-'));
}

test('T061 harness: discovery ignores an observability-only sibling regardless of its bucket name', () => {
  const root = makeWorkspaceProbeRoot();
  try {
    createCanonicalWorkspace(root, 'imported-payment-retry');
    const observability = join(root, '.work-state', 'features', 'default', 'observability');
    mkdirSync(observability, { recursive: true });
    writeFileSync(join(observability, 'events.jsonl'), '{"kind":"session_started"}\n');

    assert.deepEqual(featureWorkspaceIds(root), ['imported-payment-retry']);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('T061 harness: two real durable workspaces remain visible and fail single-workspace readiness', async () => {
  const root = makeWorkspaceProbeRoot();
  try {
    createCanonicalWorkspace(root, 'imported-payment-retry-a');
    createCanonicalWorkspace(root, 'imported-payment-retry-b');

    assert.deepEqual(featureWorkspaceIds(root), ['imported-payment-retry-a', 'imported-payment-retry-b']);
    await assert.rejects(
      waitForImportedWorkspace(root),
      /multiple canonical feature workspaces detected/iu,
      'a second real state file must not be mistaken for an observability bucket',
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('T061 harness: malformed state buckets do not count as feature workspaces', () => {
  const root = makeWorkspaceProbeRoot();
  try {
    const malformed = join(root, '.work-state', 'features', 'telemetry');
    mkdirSync(malformed, { recursive: true });
    writeFileSync(join(malformed, 'state.json'), '{not-json');
    assert.deepEqual(featureWorkspaceIds(root), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('T061 harness: a durable state identity mismatch is detected instead of counted', () => {
  const root = makeWorkspaceProbeRoot();
  try {
    const directoryId = 'imported-payment-retry';
    const stateDir = join(root, '.work-state', 'features', directoryId);
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(
      join(stateDir, 'state.json'),
      JSON.stringify({
        schema: 1,
        run_key: 'run-imported-payment-retry',
        specification: { feature_id: 'different-feature' },
      }),
    );
    assert.throws(
      () => featureWorkspaceIds(root),
      /feature workspace state identity mismatch/iu,
      'state identity must stay bound to its feature directory',
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

function readState(root: string, featureId: string): PersistedState {
  const path = join(root, '.work-state', 'features', featureId, 'state.json');
  return JSON.parse(readFileSync(path, 'utf8')) as PersistedState;
}

function workspaceStatus(state: PersistedState): string {
  return typeof state.specification?.status === 'string' ? state.specification.status : '';
}

function importedHandoffFixture(featureId: string, handoffRef = `${featureId}.handoff.v1`): ImportedHandoff {
  const handoff = {
    ...validImplementationHandoff({ featureId }),
    handoff_id: handoffRef,
    source_kind: 'external',
    content_provenance: {
      source_kind: 'external',
      content_role: 'untrusted_inert_data',
      embedded_instruction_policy: 'inert_data_only',
      source_refs: ['requirements.md'],
    },
    import_snapshot_ref: `${featureId}.snapshot.v1`,
    artifact_versions: [
      ...validImplementationHandoff({ featureId }).artifact_versions,
      {
        artifact_id: `${featureId}.snapshot.v1`,
        kind: 'import_snapshot',
        version: 1,
        sha256: 'a'.repeat(64),
      },
    ],
  } as unknown as ImplementationHandoff;
  handoff.handoff_digest = canonicalHandoffDigest(handoff);
  return handoff as unknown as ImportedHandoff;
}

function markWorkspaceImplementationReady(root: string, featureId: string, handoffRef: string): void {
  const statePath = join(root, '.work-state', 'features', featureId, 'state.json');
  const state = JSON.parse(readFileSync(statePath, 'utf8')) as Record<string, unknown>;
  const specification = state.specification;
  if (!isRecord(specification) || !Array.isArray(specification.phases)) {
    throw new Error(`fixture workspace '${featureId}' is missing its canonical specification`);
  }
  specification.source_kind = 'external';
  specification.import_ref = `${featureId}.snapshot.v1`;
  specification.handoff_ref = handoffRef;
  specification.status = 'implementation_ready';
  specification.next_action = {
    kind: 'command',
    command: `/do-work --spec ${featureId}`,
    reason: 'all approved imported artifacts are ready for an executor',
  };
  specification.phases = specification.phases.map((phase, index) => {
    if (!isRecord(phase)) throw new Error(`fixture workspace '${featureId}' has a malformed phase`);
    return {
      ...phase,
      status: 'approved',
      current_version: 1,
      approved_version: 1,
      validation_ref: `validation.${featureId}.${index + 1}`,
      checkpoint_ref: `checkpoint.${featureId}.${index + 1}`,
      upstream_versions: phase.phase === 'specify'
        ? []
        : [
            { phase: 'specify', version: 1, hash: 'a'.repeat(64) },
            ...(phase.phase === 'tasks' ? [{ phase: 'plan', version: 1, hash: 'a'.repeat(64) }] : []),
          ],
      stale_reason: null,
      last_feedback: null,
    };
  });
  writeFileSync(statePath, JSON.stringify(state));
}

function createHandoffProbe(
  featureId = 'imported-payment-retry',
  options: { handoffRef?: string; writeHandoff?: boolean } = {},
): { root: string; featureId: string; handoff: ImportedHandoff; handoffPath: string; flatPath: string } {
  const root = makeWorkspaceProbeRoot();
  const handoffRef = options.handoffRef ?? `${featureId}.handoff.v1`;
  createCanonicalWorkspace(root, featureId);
  markWorkspaceImplementationReady(root, featureId, handoffRef);
  const handoff = importedHandoffFixture(featureId, handoffRef);
  const artifactsRoot = join(root, '.work-state', 'features', featureId, 'artifacts');
  const handoffDir = join(artifactsRoot, 'implementation_handoff');
  mkdirSync(handoffDir, { recursive: true });
  const handoffPath = join(handoffDir, `${handoffRef}.json`);
  if (options.writeHandoff !== false) writeFileSync(handoffPath, JSON.stringify(handoff));
  return {
    root,
    featureId,
    handoff,
    handoffPath,
    flatPath: join(artifactsRoot, 'implementation_handoff.json'),
  };
}

test('T061 harness: canonical nested handoff is workspace-bound and ignores unrelated JSON', () => {
  const probe = createHandoffProbe();
  try {
    const handoffDir = join(probe.handoffPath, '..');
    writeFileSync(join(handoffDir, 'observability.json'), '{"kind":"session_started"}');
    writeFileSync(join(probe.root, '.work-state', 'features', probe.featureId, 'artifacts', 'report.json'), JSON.stringify({
      handoff_id: 'unrelated.handoff.v1',
      handoff_digest: 'b'.repeat(64),
    }));

    assert.deepEqual(readHandoffs(probe.root, probe.featureId), [probe.handoff]);
    assert.equal(existsSync(probe.flatPath), false, 'canonical writer does not create a flat implementation_handoff.json');
  } finally {
    rmSync(probe.root, { recursive: true, force: true });
  }
});

test('T061 harness: implementation-ready workspace fails closed when canonical handoff is missing', () => {
  const probe = createHandoffProbe('imported-payment-retry-missing', { writeHandoff: false });
  try {
    assert.throws(
      () => readHandoffs(probe.root, probe.featureId),
      /canonical handoff .*missing/iu,
      'a flat or absent artifact must not satisfy the workspace handoff reference',
    );
  } finally {
    rmSync(probe.root, { recursive: true, force: true });
  }
});

test('T061 harness: canonical handoff id must match the workspace handoff_ref', () => {
  const probe = createHandoffProbe();
  try {
    const foreign = importedHandoffFixture(probe.featureId, `${probe.featureId}.foreign.v1`);
    writeFileSync(probe.handoffPath, JSON.stringify(foreign));
    assert.throws(
      () => readHandoffs(probe.root, probe.featureId),
      /does not match workspace handoff_ref/iu,
      'a valid handoff at the canonical path is still foreign when its id differs',
    );
  } finally {
    rmSync(probe.root, { recursive: true, force: true });
  }
});

test('T061 harness: canonical handoff digest must match its content', () => {
  const probe = createHandoffProbe('imported-payment-retry-digest');
  try {
    const tampered = {
      ...probe.handoff,
      scope: {
        in_scope: ['tampered scope'],
        out_of_scope: probe.handoff.scope?.out_of_scope ?? [],
        constraints: probe.handoff.scope?.constraints ?? [],
      },
    };
    writeFileSync(probe.handoffPath, JSON.stringify(tampered));
    assert.throws(
      () => readHandoffs(probe.root, probe.featureId),
      /content digest/iu,
      'a payload mutation with the old digest must be rejected',
    );
  } finally {
    rmSync(probe.root, { recursive: true, force: true });
  }
});

test('T061 harness: unsafe workspace handoff_ref cannot escape the canonical artifact directory', () => {
  const probe = createHandoffProbe('imported-payment-retry-traversal', {
    handoffRef: '../escape',
    writeHandoff: false,
  });
  try {
    assert.throws(
      () => readHandoffs(probe.root, probe.featureId),
      /unsafe handoff_ref/iu,
      'path traversal in durable state must fail before path construction',
    );
  } finally {
    rmSync(probe.root, { recursive: true, force: true });
  }
});

test('T061 harness: symlinked canonical handoff is rejected instead of followed', () => {
  const probe = createHandoffProbe('imported-payment-retry-symlink');
  try {
    const target = join(probe.root, 'outside-handoff.json');
    writeFileSync(target, JSON.stringify(probe.handoff));
    rmSync(probe.handoffPath, { force: true });
    symlinkSync(target, probe.handoffPath);
    assert.throws(
      () => readHandoffs(probe.root, probe.featureId),
      /symlink/iu,
      'the reader must inspect the artifact entry with lstat and never follow a symlink',
    );
  } finally {
    rmSync(probe.root, { recursive: true, force: true });
  }
});

test('T061 harness: flat implementation_handoff forgery never satisfies a ready workspace', () => {
  const probe = createHandoffProbe('imported-payment-retry-flat', { writeHandoff: false });
  try {
    writeFileSync(probe.flatPath, JSON.stringify(probe.handoff));
    assert.throws(
      () => readHandoffs(probe.root, probe.featureId),
      /canonical handoff .*missing/iu,
      'the reader must ignore a flat duplicate and require the nested state-bound artifact',
    );
    assert.ok(existsSync(probe.flatPath), 'the forgery remains present so the assertion proves it was ignored');
  } finally {
    rmSync(probe.root, { recursive: true, force: true });
  }
});

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

/** Waits until the import created exactly one imported feature workspace. */
async function waitForImportedWorkspace(root: string): Promise<string> {
  await waitFor(
    () => {
      const ids = featureWorkspaceIds(root);
      assertSingleFeatureWorkspace(root, ids);
      return ids.length === 1;
    },
    { timeoutMs: IMPORT_TIMEOUT_MS, intervalMs: 200, label: 'imported feature workspace created' },
  );
  const ids = featureWorkspaceIds(root);
  assertSingleFeatureWorkspace(root, ids);
  assert.equal(ids.length, 1, 'the import creates exactly one feature workspace');
  const featureId = ids[0];
  assert.ok(featureId !== undefined && featureId.length > 0, 'the imported workspace has a feature id');
  return featureId;
}

async function openSession(root: string): Promise<OpenSession> {
  const session = await startTestSession({
    cwd: root,
    surface: 'text',
    maxTimeSec: 1200,
    idleMs: 900_000,
    scenario: SCENARIO,
    taskPrompt: 'Exercise the read-only external specification import contract.',
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function agentSessionPath(scratchDir: string): string | null {
  const dir = join(scratchDir, '.omp', 'agent');
  if (!existsSync(dir)) return null;
  const candidates = readdirSync(dir, { withFileTypes: true })
    .filter(entry => entry.isFile() && entry.name.endsWith('.jsonl'))
    .map(entry => join(dir, entry.name))
    .sort();
  return candidates.at(-1) ?? null;
}

function textContent(value: unknown): string {
  if (typeof value === 'string') return value;
  if (!Array.isArray(value)) return '';
  return value
    .map(item => isRecord(item) && typeof item.text === 'string' ? item.text : '')
    .filter(text => text.length > 0)
    .join('\n');
}

type DurableFileCursor = {
  path: string;
  offset: number;
};

function durableSessionPaths(scratchDir: string): string[] {
  const dir = join(scratchDir, '.omp', 'agent');
  if (!existsSync(dir)) return [];
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter(entry => entry.isFile() && entry.name.includes('.jsonl'))
      .map(entry => join(dir, entry.name))
      .sort();
  } catch {
    return [];
  }
}

function durableFileKey(path: string): { key: string; size: number } | null {
  try {
    const stats = statSync(path);
    if (!stats.isFile()) return null;
    return { key: `${stats.dev}:${stats.ino}`, size: stats.size };
  } catch {
    return null;
  }
}

function firstDurableUserResponseFromBuffer(bytes: Buffer, cursor: DurableFileCursor): string | null {
  if (cursor.offset > bytes.length) cursor.offset = 0;
  let position = cursor.offset;
  while (position < bytes.length) {
    const newline = bytes.indexOf(0x0a, position);
    if (newline < 0) break;
    const line = bytes.subarray(position, newline);
    position = newline + 1;
    try {
      const value: unknown = JSON.parse(line.toString('utf8'));
      if (!isRecord(value) || value.type !== 'message' || !isRecord(value.message)) continue;
      if (value.message.role !== 'user') continue;
      const text = textContent(value.message.content);
      if (text.length > 0) return text;
    } catch {
      // Invalid or partially flushed records remain inert and are retried
      // only when a complete newline-delimited record is available.
    }
  }
  cursor.offset = position;
  return null;
}

/**
 * Tracks the command's initial durable user response by file identity and
 * byte offset. Existing files begin at their last complete record, late files
 * begin at byte zero, and every inode remains tracked across pathname rotation.
 * This prevents a command response from being skipped when the runtime appends
 * after observer startup, flushes a partial JSONL record, or rotates its file.
 */
function durableUserResponseReader(scratchDir: string): () => string | null {
  const cursors = new Map<string, DurableFileCursor>();
  for (const path of durableSessionPaths(scratchDir)) {
    const identity = durableFileKey(path);
    if (identity === null) continue;
    let offset = identity.size;
    try {
      const bytes = readFileSync(path);
      const newline = bytes.lastIndexOf(0x0a);
      offset = newline < 0 ? 0 : newline + 1;
    } catch {
      offset = 0;
    }
    cursors.set(identity.key, { path, offset });
  }

  return () => {
    const pathsByKey = new Map<string, string>();
    for (const path of durableSessionPaths(scratchDir)) {
      const identity = durableFileKey(path);
      if (identity === null) continue;
      pathsByKey.set(identity.key, path);
      const cursor = cursors.get(identity.key);
      if (cursor === undefined) {
        // A file that appeared after observer startup is part of this command.
        cursors.set(identity.key, { path, offset: 0 });
      } else {
        cursor.path = path;
      }
    }

    for (const [key, cursor] of [...cursors.entries()].sort(([, left], [, right]) => left.path.localeCompare(right.path, 'en'))) {
      const path = pathsByKey.get(key);
      if (path === undefined) continue;
      let bytes: Buffer;
      try {
        bytes = readFileSync(path);
      } catch {
        continue;
      }
      const response = firstDurableUserResponseFromBuffer(bytes, cursor);
      if (response !== null) return response;
    }
    return null;
  };
}

const IMPORT_TERMINAL_STATUS = /\bcompatibility_status:\s*(ready|supplement_required|blocked|unsupported)\b/iu;
const IMPORT_TERMINAL_ERROR = /\bERROR\s+SPEC_IMPORT_[A-Z0-9_]+\s*:/u;

function hasTerminalImportResponse(response: string | null): boolean {
  return response !== null && (IMPORT_TERMINAL_STATUS.test(response) || IMPORT_TERMINAL_ERROR.test(response));
}

/**
 * Submits one import command and waits for its semantic response before
 * applying the short frame-stability window. The polling is deliberately
 * wall-clock because a detached OMP process renders its transcript on the
 * platform clock and cannot be driven by fake timers.
 */
type ImportReadiness = (text: string, log: TranscriptLog, initialResponse: string | null) => boolean;

const IMPORT_COMMAND_FAILURE = /unknown command|unrecognized command|not a valid command|no such command|isn['']t a recognized/iu;

const readiness = (predicate: ImportReadiness): ImportReadiness => (text, log, initialResponse) =>
  predicate([initialResponse, text].filter((chunk): chunk is string => chunk !== null).join('\n'), log, initialResponse);

const compatibilityCheckpointReady = readiness((_text, log) =>
  compatibilityCheckpoints([...log.askBlocks(), ...log.selectedAskBlocks()]).length > 0,
);
const incompleteReportReady = readiness(text => /supplement/iu.test(text) && /task/iu.test(text) && /finding|gap|block|missing/iu.test(text));
const ambiguousReportReady = readiness(text => /docs-a/iu.test(text) && /docs-b/iu.test(text) && /select|choice|selection/iu.test(text));
const hostileReportReady = readiness(text =>
  /block|unsafe|reject|ERROR\s+SPEC_IMPORT_[A-Z0-9_]+\s*:/iu.test(text)
  && /symlink|traversal|escape|path/iu.test(text));
const establishedImportReady = readiness(text => /ready|established|unchanged|snapshot/iu.test(text));

function isNonReadyTerminalResponse(response: string | null): boolean {
  return hasTerminalImportResponse(response) && !/\bcompatibility_status:\s*ready\b/iu.test(response ?? '');
}


type SelectedAskResponder = (driver: WsDriver, block: SelectedAskBlock) => Promise<void>;

async function importAndSettle(
  open: OpenSession,
  command: string,
  label: string,
  isReady: ImportReadiness,
  respondToSelectedAsk?: SelectedAskResponder,
): Promise<Journey> {
  const log = new TranscriptLog(open.session.transcriptPath);
  log.refresh();
  const fromFrame = log.frames.length;
  // The OMP session may create its durable agent JSONL after the PTY is
  // already ready. Keep discovery inside the poller so a just-created file
  // cannot hide the initial user response behind a stale null path.
  const readInitialResponse = durableUserResponseReader(open.session.scratchDir);
  let initialResponse: string | null = null;
  let semanticReady = false;
  const answeredSelectedCards = new Set<string>();
  let selectedAnswer: Promise<void> = Promise.resolve();

  // The slash command's model turn is allowed to remain blocked on the
  // trusted selector. Start the PTY submission and semantic observer before
  // awaiting either one so the observer can answer the card as soon as the
  // host renders it. This is deliberately not a state-file shortcut: the
  // responder sends navigation + Enter through the real terminal surface.
  const commandPromise = submit(open.driver, command);
  const readinessPromise = waitFor(
    async () => {
      log.refresh();
      if (initialResponse === null) {
        initialResponse = readInitialResponse();
      }
      if (respondToSelectedAsk !== undefined) {
        const selected = compatibilityCheckpoints([...log.askBlocks(), ...log.selectedAskBlocks()])
          .find((block): block is SelectedAskBlock =>
            block.surface === 'selector'
            && !answeredSelectedCards.has(
              `${block.frameStart}:${block.title}:${block.options.join('|')}`,
            ));
        if (selected !== undefined) {
          // A rejected identity packet can make the model render a fresh
          // selector card. Answer each distinct rendered card, but never
          // replay navigation for the same frame/card.
          const identity = `${selected.frameStart}:${selected.title}:${selected.options.join('|')}`;
          answeredSelectedCards.add(identity);
          selectedAnswer = selectedAnswer.then(() => respondToSelectedAsk(open.driver, selected));
          await selectedAnswer;
        }
      }
      const text = outputText(log, fromFrame);
      if (initialResponse !== null && isReady(text, log, initialResponse)) {
        semanticReady = true;
        return true;
      }
      // A non-ready durable response is terminal for this command. Return it
      // now so the caller can report the missing checkpoint instead of
      // waiting on unrelated model/tool output.
      return isNonReadyTerminalResponse(initialResponse);
    },
    { timeoutMs: IMPORT_TIMEOUT_MS, intervalMs: 200, label: `${label} semantic readiness` },
  );
  try {
    // Both operations were started above. Awaiting the command only after the
    // observer has been installed prevents a command implementation that
    // awaits the trusted answer from deadlocking the test harness.
    await Promise.all([commandPromise, readinessPromise]);
    await selectedAnswer;
  } catch (error) {
    // Preserve command failures while consuming its promise so no rejected
    // PTY submission is left detached from the test lifecycle.
    await commandPromise.catch(() => undefined);
    throw error;
  }
  let lastCount = log.frames.length;
  let lastChange = Date.now();
  await waitFor(
    () => {
      log.refresh();
      if (log.frames.some(frame => frame.t === "exit")) return true;
      if (log.frames.length !== lastCount) {
        lastCount = log.frames.length;
        lastChange = Date.now();
        return false;
      }
      return Date.now() - lastChange >= STABILITY_WINDOW_MS;
    },
    { timeoutMs: IMPORT_TIMEOUT_MS, intervalMs: 1_000, label: `${label} output settled` },
  );
  log.refresh();
  return {
    log,
    text: outputText(log, fromFrame),
    initialResponse,
    semanticReady,
  };
}

/** Turns a missing/unknown `/spec-import` command into an exact contract failure. */
function assertCommandRegistered(journey: Journey): void {
  const response = journey.initialResponse;
  assert.ok(
    response !== null,
    '/spec-import must emit a durable initial response before model/tool work; '
    + 'T061 defines the runtime behavior it must satisfy',
  );
  assert.doesNotMatch(
    response,
    IMPORT_COMMAND_FAILURE,
    '/spec-import must be a registered harness command (contract prerequisite T071); '
    + 'T061 defines the runtime behavior it must satisfy',
  );
}


test('T061 harness: late-created agent JSONL still yields the initial response', () => {
  const root = mkdtempSync(join(tmpdir(), 'omp-spec-import-late-agent-'));
  try {
    const readInitialResponse = durableUserResponseReader(root);
    assert.equal(readInitialResponse(), null, 'no agent JSONL exists before the command observer starts');

    const agentDir = join(root, '.omp', 'agent');
    mkdirSync(agentDir, { recursive: true });
    const path = join(agentDir, '2026-01-01T00-00-00-000Z_session.jsonl');
    writeFileSync(
      path,
      JSON.stringify({ type: 'session', version: 3 }) + '\n'
        + JSON.stringify({
          type: 'message',
          message: { role: 'user', content: [{ type: 'text', text: 'Read-only external specification intake completed.' }] },
        }) + '\n',
    );

    assert.match(
      readInitialResponse() ?? '',
      /Read-only external specification intake completed/iu,
      'late session-file discovery does not lose the initial durable response',
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('T061 harness: durable response framing survives partial append and inode rotation', () => {
  const root = mkdtempSync(join(tmpdir(), 'omp-spec-import-framing-'));
  try {
    const agentDir = join(root, '.omp', 'agent');
    mkdirSync(agentDir, { recursive: true });
    const path = join(agentDir, '2026-01-01T00-00-00-000Z_session.jsonl');
    writeFileSync(path, JSON.stringify({ type: 'session', version: 3 }) + '\n', 'utf8');

    const readInitialResponse = durableUserResponseReader(root);
    assert.equal(readInitialResponse(), null, 'pre-existing session records are not mistaken for the command response');

    const response = JSON.stringify({
      type: 'message',
      message: {
        role: 'user',
        content: [{ type: 'text', text: 'compatibility_status: supplement_required; task graph is missing' }],
      },
    });
    appendFileSync(path, response.slice(0, -1), 'utf8');
    assert.equal(readInitialResponse(), null, 'a partial JSONL record is held until its delimiter arrives');
    appendFileSync(path, response.slice(-1) + '\n', 'utf8');
    assert.match(readInitialResponse() ?? '', /compatibility_status:\s*supplement_required/iu);

    const rotatedRoot = mkdtempSync(join(tmpdir(), 'omp-spec-import-rotation-'));
    try {
      const rotatedDir = join(rotatedRoot, '.omp', 'agent');
      mkdirSync(rotatedDir, { recursive: true });
      const active = join(rotatedDir, '2026-01-01T00-00-01-000Z_session.jsonl');
      writeFileSync(active, JSON.stringify({ type: 'session', version: 3 }) + '\n', 'utf8');
      const readRotatedResponse = durableUserResponseReader(rotatedRoot);
      assert.equal(readRotatedResponse(), null);
      const archived = `${active}.rotated`;
      renameSync(active, archived);
      writeFileSync(active, JSON.stringify({ type: 'session', version: 3 }) + '\n', 'utf8');
      appendFileSync(archived, response + '\n', 'utf8');
      assert.match(readRotatedResponse() ?? '', /compatibility_status:\s*supplement_required/iu);
    } finally {
      rmSync(rotatedRoot, { recursive: true, force: true });
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('T061 harness: registration assertion ignores later model/tool Unknown command text', () => {
  const parent = mkdtempSync(join(tmpdir(), 'omp-spec-import-assertion-'));
  try {
    const journey: Journey = {
      text: 'model tool output: Unknown command: /spec-import',
      initialResponse: 'Read-only external specification intake completed; compatibility_status: supplement_required',
      semanticReady: false,
      log: new TranscriptLog(join(parent, 'transcript.jsonl')),
    };
    assert.doesNotThrow(() => assertCommandRegistered(journey));
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

type CheckpointBlock = AskBlock | SelectedAskBlock;

function compatibilityCheckpoints(blocks: readonly CheckpointBlock[]): CheckpointBlock[] {
  return blocks.filter(block => /compatibility/iu.test(block.title));
}

function assertNoNativePhaseCheckpoints(blocks: readonly AskBlock[], label: string): void {
  const native = blocks.filter(block => /\bspecify\b|\bplan\b|\btasks\b/iu.test(block.title));
  assert.deepEqual(
    native.map(block => block.title),
    [],
    `${label}: imported work must never re-present native Specify, Plan, or Tasks checkpoints`,
  );
}

/** The numbered transcript choice for the compatibility approval option. */
function approveChoice(block: AskBlock): string {
  const options = block.options;
  const preferred = options.findIndex(option =>
    /approve/iu.test(option) && !/stop|cancel|reject|decline/iu.test(option));
  const chosenIndex = preferred >= 0 ? preferred : options.findIndex(option => /approve/iu.test(option));
  const chosen = chosenIndex >= 0 ? options[chosenIndex] : undefined;
  const numbered = chosen === undefined ? undefined : /^(\d+)[.)\]]/u.exec(chosen);
  if (numbered !== null && numbered !== undefined) return numbered[1] ?? '1';
  return '1';
}

const CANONICAL_ID_PATTERN = '[A-Za-z0-9][A-Za-z0-9._-]{0,255}';

function canonicalIdentityMatches(title: string, field: string, expected: string): boolean {
  const pattern = new RegExp(`(?:^|[\\s|,])${field}\\s*[:=]\\s*["']?(${CANONICAL_ID_PATTERN})["']?(?!\\s*[:=])(?=$|[\\s|,;)])`, 'giu');
  for (const match of title.matchAll(pattern)) {
    if (match[1] !== undefined && match[1] !== expected) return false;
  }
  return true;
}

function isCanonicalConstitutionImpactCard(
  block: SelectedAskBlock,
  featureId: string,
  runKey: string,
): boolean {
  return block.surface === 'selector'
    && /constitution(?:[_\s-]+)impact|impact(?:[_\s-]+)approval/iu.test(block.title)
    && matchesCanonicalSelectorOptions(block.options, ['approve', 'reject'])
    && canonicalIdentityMatches(block.title, 'feature_id', featureId)
    && canonicalIdentityMatches(block.title, 'run_key', runKey);
}

async function approveCheckpoint(driver: WsDriver, block: CheckpointBlock): Promise<void> {
  if (block.surface === 'selector') {
    const option = block.options.find(candidate => /approve/iu.test(candidate) && !/stop|cancel|reject|decline/iu.test(candidate));
    if (option === undefined) throw new Error(`ux-e2e: compatibility selector has no approval option: ${block.options.join(', ')}`);
    await answerSelectedAsk(driver, block, option);
    return;
  }
  await submit(driver, approveChoice(block));
}

const SAFE_HANDOFF_REF_RE = /^[A-Za-z0-9._-]+$/u;

function validatedFeatureWorkspace(root: string, featureId: string): FeatureWorkspace {
  if (!isSafeFeatureId(featureId)) {
    throw new Error(`cannot read imported handoff for unsafe feature id '${featureId}'`);
  }
  let state: PersistedState;
  try {
    state = readState(root, featureId);
  } catch (error) {
    throw new Error(`cannot load canonical workspace state for '${featureId}': ${String(error)}`);
  }
  if (typeof state.run_key !== 'string' || state.run_key.trim().length === 0) {
    throw new Error(`canonical workspace state for '${featureId}' has no safe run_key`);
  }
  const resolved = resolveFeatureWorkspace(root, { feature_id: featureId, run_key: state.run_key });
  if (!resolved.ok) {
    throw new Error(`canonical workspace state for '${featureId}' is invalid: ${resolved.code}: ${resolved.error}`);
  }
  return resolved.value;
}

function assertCanonicalDirectoryChain(root: string, segments: readonly string[], label: string): string {
  let current = root;
  let rootEntry: Stats;
  try {
    rootEntry = lstatSync(current);
  } catch (error) {
    throw new Error(`${label} root is unreadable: ${String(error)}`);
  }
  if (rootEntry.isSymbolicLink() || !rootEntry.isDirectory()) {
    throw new Error(`${label} root is not a canonical directory`);
  }
  for (const segment of segments) {
    current = join(current, segment);
    let entry: Stats;
    try {
      entry = lstatSync(current);
    } catch (error) {
      throw new Error(`${label} directory is missing or unreadable at '${current}': ${String(error)}`);
    }
    if (entry.isSymbolicLink()) throw new Error(`${label} path contains a symlink at '${current}'`);
    if (!entry.isDirectory()) throw new Error(`${label} path is not a directory at '${current}'`);
  }
  return current;
}

function readCanonicalImportedHandoff(root: string, featureId: string): ImportedHandoff[] {
  const workspace = validatedFeatureWorkspace(root, featureId);
  if (workspace.status !== 'implementation_ready' && workspace.status !== 'claimed' && workspace.status !== 'executing') return [];

  const handoffRef = workspace.handoff_ref;
  if (
    typeof handoffRef !== 'string'
    || handoffRef.length === 0
    || handoffRef === '.'
    || handoffRef === '..'
    || !SAFE_HANDOFF_REF_RE.test(handoffRef)
  ) {
    throw new Error(`canonical implementation-ready workspace '${featureId}' has an unsafe handoff_ref`);
  }

  const handoffDir = assertCanonicalDirectoryChain(
    workspace.project_root,
    ['.work-state', 'features', featureId, 'artifacts', 'implementation_handoff'],
    `canonical handoff for '${featureId}'`,
  );
  const handoffPath = join(handoffDir, `${handoffRef}.json`);
  let fileEntry: Stats;
  try {
    fileEntry = lstatSync(handoffPath);
  } catch (error) {
    throw new Error(`canonical handoff for '${featureId}' is missing at '${handoffPath}': ${String(error)}`);
  }
  if (fileEntry.isSymbolicLink()) throw new Error(`canonical handoff for '${featureId}' is a symlink`);
  if (!fileEntry.isFile()) throw new Error(`canonical handoff for '${featureId}' is not a regular file`);

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(handoffPath, 'utf8')) as unknown;
  } catch (error) {
    throw new Error(`canonical handoff for '${featureId}' is unreadable: ${String(error)}`);
  }
  const validation = validateImplementationHandoff(parsed);
  if (!validation.ok) {
    throw new Error(`canonical handoff for '${featureId}' failed strict schema validation: ${validation.issues.join('; ')}`);
  }
  if (!isRecord(parsed)) {
    throw new Error(`canonical handoff for '${featureId}' is not an object`);
  }
  const handoff = parsed as ImportedHandoff;
  if (handoff.status !== 'ready') {
    throw new Error(`canonical handoff for '${featureId}' is not ready`);
  }
  if (handoff.handoff_id !== handoffRef) {
    throw new Error(`canonical handoff for '${featureId}' does not match workspace handoff_ref '${handoffRef}'`);
  }
  if (handoff.feature_id !== featureId) {
    throw new Error(`canonical handoff for '${featureId}' carries foreign feature id '${handoff.feature_id}'`);
  }
  if (!DIGEST_RE.test(handoff.handoff_digest) || canonicalHandoffDigest(handoff as unknown as ImplementationHandoff) !== handoff.handoff_digest) {
    throw new Error(`canonical handoff for '${featureId}' does not match its content digest`);
  }
  return [handoff];
}

function isClaimArtifact(value: Record<string, unknown>): boolean {
  return typeof value['claim_id'] === 'string' && typeof value['handoff_digest'] === 'string'
    && typeof value['status'] === 'string';
}

function scanArtifacts<T>(
  root: string,
  featureId: string,
  predicate: (value: Record<string, unknown>) => boolean,
): T[] {
  const dir = join(root, '.work-state', 'features', featureId, 'artifacts');
  if (!existsSync(dir)) return [];
  const found: T[] = [];
  const visit = (current: string): void => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      if (entry.name.startsWith('.')) continue;
      const path = join(current, entry.name);
      if (entry.isDirectory()) {
        visit(path);
        continue;
      }
      if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
      try {
        const value: unknown = JSON.parse(readFileSync(path, 'utf8'));
        if (value !== null && typeof value === 'object' && predicate(value as Record<string, unknown>)) {
          found.push(value as T);
        }
      } catch {
        // Unparseable bytes are not contract data.
      }
    }
  };
  visit(dir);
  return found;
}

function readHandoffs(root: string, featureId: string): ImportedHandoff[] {
  return readCanonicalImportedHandoff(root, featureId);
}

function readClaims(root: string, featureId: string, handoffDigest?: string): ClaimArtifact[] {
  const latest = new Map<string, ClaimArtifact>();
  for (const envelope of scanArtifacts<Record<string, unknown>>(root, featureId, value => {
    const claim = isClaimArtifact(value)
      ? value
      : isRecord(value['claim']) && isClaimArtifact(value['claim'] as Record<string, unknown>)
        ? value['claim'] as Record<string, unknown>
        : null;
    return claim !== null && (handoffDigest === undefined || claim['handoff_digest'] === handoffDigest);
  })) {
    const claim = isClaimArtifact(envelope)
      ? envelope
      : isRecord(envelope['claim']) && isClaimArtifact(envelope['claim'] as Record<string, unknown>)
        ? envelope['claim'] as Record<string, unknown>
        : null;
    if (claim !== null) latest.set(String(claim['claim_id']), claim as ClaimArtifact);
  }
  return [...latest.values()];
}

/**
 * The shared implementation-handoff identity (FR-058): an imported handoff is
 * the exact schema native workspaces freeze — no second handoff shape.
 */
function assertSharedHandoffIdentity(handoff: ImportedHandoff, featureId: string, label: string): void {
  assert.equal(handoff.feature_id, featureId, `${label} binds the imported feature id`);
  assert.match(handoff.handoff_digest, DIGEST_RE, `${label} digest is content-addressed SHA-256`);
  assert.equal(handoff.source_kind, 'external', `${label} records external provenance`);
  assert.equal(handoff.status, 'ready', `${label} is ready`);
  assert.deepEqual(handoff.open_decisions, [], `${label} has no blocking open decisions`);
  assert.ok(
    Array.isArray(handoff.execution_choices) && handoff.execution_choices.includes('do-work'),
    `${label} admits the do-work executor`,
  );
  assert.ok(
    typeof handoff.import_snapshot_ref === 'string' && handoff.import_snapshot_ref.length > 0,
    `${label} binds the immutable import snapshot`,
  );
  assert.ok(
    Array.isArray(handoff.artifact_versions)
      && handoff.artifact_versions.some(entry => entry.kind === 'import_snapshot'),
    `${label} version-bindings include the import snapshot`,
  );
  assert.ok(Array.isArray(handoff.requirements) && handoff.requirements.length >= 1, `${label} carries requirements`);
  assert.ok(Array.isArray(handoff.decisions) && handoff.decisions.length >= 1, `${label} carries decisions`);
  assert.ok(Array.isArray(handoff.tasks) && handoff.tasks.length >= 1, `${label} carries an executable task graph`);
  assert.ok(Array.isArray(handoff.verification) && handoff.verification.length >= 1, `${label} carries verification obligations`);
  assert.ok(
    handoff.constitution_binding !== null
      && typeof handoff.constitution_binding === 'object'
      && typeof handoff.constitution_binding.content_sha256 === 'string'
      && DIGEST_RE.test(handoff.constitution_binding.content_sha256),
    `${label} binds the exact constitution fingerprint`,
  );
}

function assertSourceUnchanged(scratch: Scratch, before: Map<string, string>, label: string): void {
  assert.deepEqual(
    [...bundleDigests(scratch.bundleRoot).entries()].sort(),
    [...before.entries()].sort(),
    `${label}: external source files remain byte-for-byte unchanged (FR-069)`,
  );
}

function assertNoHandoffAndNoClaim(scratch: Scratch, featureId: string | null, label: string): void {
  if (featureId !== null) {
    assert.equal(readHandoffs(scratch.root, featureId).length, 0, `${label}: no implementation handoff exists before approval`);
    const claims = scanArtifacts<ClaimArtifact>(scratch.root, featureId, isClaimArtifact);
    assert.equal(claims.length, 0, `${label}: no execution claim exists`);
    const state = readState(scratch.root, featureId);
    assert.notEqual(workspaceStatus(state), 'implementation_ready', `${label}: the workspace is not implementation-ready`);
    assert.equal(
      typeof state.specification?.execution_claim_ref === 'string',
      false,
      `${label}: no implementation dispatch was started`,
    );
  }
}

// ---------------------------------------------------------------------------
// T061.1 — complete bundle: one compatibility checkpoint, shared handoff.
// ---------------------------------------------------------------------------

test('T061 runtime: a complete generic bundle reaches exactly one compatibility checkpoint and the shared imported handoff', async () => {

  const scratch = makeScratch('complete', 'generic/complete', 'imported/payment-retry');
  const before = bundleDigests(scratch.bundleRoot);
  let open: OpenSession | null = null;
  let passed = false;
  try {
    open = await openSession(scratch.root);

    const journey = await importAndSettle(
      open,
      '/spec-import imported/payment-retry --framework generic',
      'complete bundle compatibility intake',
      compatibilityCheckpointReady,
      approveCheckpoint,
    );
    assertCommandRegistered(journey);
    assert.equal(
      journey.semanticReady,
      true,
      'a complete import must reach a real compatibility checkpoint; a terminal non-ready response is not success',
    );

    // Readable compatibility report (FR-059, FR-070): ready status, the
    // generic mapping actually used, selected source artifacts, provenance,
    // and the constitution binding it is validated against.
    assert.match(journey.text, /compatibility/iu, 'a readable compatibility report is rendered');
    assert.match(journey.text, /\bready\b/iu, 'the compatibility report classifies the bundle as ready');
    assert.match(journey.text, /generic/iu, 'the report names the framework mapping used (generic intake)');
    assert.match(journey.text, /requirements\.md/iu, 'the report records selected source artifacts');
    assert.match(journey.text, /constitution/iu, 'the report is bound to the constitution prerequisite');

    // Exactly one synchronous compatibility checkpoint; no native phases.
    const blocks: CheckpointBlock[] = [...journey.log.askBlocks(), ...journey.log.selectedAskBlocks()];
    assertNoNativePhaseCheckpoints(blocks, 'complete generic import');
    const checkpoints = compatibilityCheckpoints(blocks);
    assert.equal(checkpoints.length, 1, 'a complete bundle presents exactly one compatibility checkpoint');
    const checkpoint = checkpoints[0];
    assert.ok(checkpoint !== undefined, 'the compatibility checkpoint is readable');
    assert.ok(
      checkpoint.options.some(option => /approve/iu.test(option)),
      'the compatibility checkpoint offers an explicit approval decision',
    );

    const featureId = await waitForImportedWorkspace(scratch.root);
    const ready = await waitForState(
      scratch.root,
      featureId,
      state => workspaceStatus(state) === 'implementation_ready'
        && typeof state.specification?.import_ref === 'string'
        && typeof state.specification?.handoff_ref === 'string',
      'imported workspace becomes implementation-ready after checkpoint approval',
    );
    assert.match(
      ready.specification?.next_action?.command ?? '',
      new RegExp(`/do-work\\s+--spec\\s+${featureId}`, 'iu'),
      'the next action after approval is the explicit do-work spec selection',
    );

    const handoffs = readHandoffs(scratch.root, featureId);
    assert.equal(handoffs.length, 1, 'approval freezes exactly one imported handoff');
    const handoff = handoffs[0];
    assert.ok(handoff !== undefined, 'the frozen imported handoff is readable');
    assertSharedHandoffIdentity(handoff, featureId, 'imported handoff');
    assert.equal(
      existsSync(join(scratch.root, '.work-state', 'features', featureId, 'artifacts', 'implementation_handoff.json')),
      false,
      'the canonical imported handoff is nested and has no flat duplicate',
    );

    const handoffPath = join(scratch.root, 'specs', featureId, 'handoff.md');
    assert.ok(existsSync(handoffPath), 'a readable handoff.md is materialized like native workspaces');
    assert.ok(
      readFileSync(handoffPath, 'utf8').includes(handoff.handoff_digest),
      'the readable handoff carries the exact frozen digest',
    );

    assertSourceUnchanged(scratch, before, 'complete journey through approval');
    passed = true;
  } finally {
    await closeSession(open);
    cleanupScratchOnCompletion(scratch, passed);
  }
});

// ---------------------------------------------------------------------------
// T061.2 — incomplete bundle: supplement-required, no implementation.
// ---------------------------------------------------------------------------

test('T061 runtime: an incomplete bundle classifies supplement-required with an actionable supplement next action', async () => {

  const scratch = makeScratch('incomplete', 'generic/incomplete', 'imported/payment-retry-incomplete');
  const before = bundleDigests(scratch.bundleRoot);
  let open: OpenSession | null = null;
  let passed = false;
  try {
    open = await openSession(scratch.root);

    const journey = await importAndSettle(
      open,
      '/spec-import imported/payment-retry-incomplete --framework generic',
      'incomplete bundle compatibility intake',
      incompleteReportReady,
    );
    assertCommandRegistered(journey);

    assert.match(journey.text, /supplement/iu, 'the report classifies the bundle as supplement-required');
    assert.match(journey.text, /task/iu, 'the findings name the missing executable task graph');
    assert.match(
      journey.text,
      /finding|gap|block|missing/iu,
      'non-ready results separate actionable blocking findings from warnings',
    );

    const blocks = journey.log.askBlocks();
    assert.equal(compatibilityCheckpoints(blocks).length, 0, 'no compatibility checkpoint while gaps remain');
    assertNoNativePhaseCheckpoints(blocks, 'incomplete import');

    const featureId = await waitForImportedWorkspace(scratch.root);
    const state = await waitForState(
      scratch.root,
      featureId,
      candidate => typeof candidate.specification?.import_ref === 'string',
      'import snapshot recorded for the incomplete bundle',
    );
    assert.notEqual(workspaceStatus(state), 'implementation_ready', 'a supplement-required workspace is not implementation-ready');
    assert.equal(
      typeof state.specification?.handoff_ref === 'string',
      false,
      'no handoff exists before the supplement closes the gaps',
    );
    const nextAction = `${state.specification?.next_action?.command ?? ''} ${state.specification?.next_action?.reason ?? ''}`;
    assert.match(nextAction, /supplement/iu, 'the durable next action routes to the local supplement');
    assert.equal(state.pause?.kind, 'needs_human', 'supplement-required import pauses as a non-authoritative human gate');
    assert.match(state.pause?.reason ?? '', /supplement|required|missing|task/iu, 'the pause records the actionable gap');
    const artifactsDir = join(scratch.root, '.work-state', 'features', featureId, 'artifacts');
    assert.deepEqual(
      readdirSync(artifactsDir, { withFileTypes: true })
        .filter(entry => !entry.name.startsWith('.') && entry.isFile())
        .map(entry => entry.name)
        .sort(),
      ['compatibility_report.json', 'import_snapshot.json'],
      'incomplete import persists only the immutable snapshot and compatibility report',
    );
    const snapshot = JSON.parse(readFileSync(join(artifactsDir, 'import_snapshot.json'), 'utf8')) as { snapshot_id?: string };
    const report = JSON.parse(readFileSync(join(artifactsDir, 'compatibility_report.json'), 'utf8')) as { status?: string };
    assert.equal(report.status, 'supplement_required', 'the durable report preserves the supplement-required classification');
    assert.equal(state.specification?.import_ref, snapshot.snapshot_id, 'state binds the persisted snapshot identity');

    assertNoHandoffAndNoClaim(scratch, featureId, 'incomplete import');
    assertSourceUnchanged(scratch, before, 'incomplete journey');
    passed = true;
  } finally {
    await closeSession(open);
    cleanupScratchOnCompletion(scratch, passed);
  }
});

// ---------------------------------------------------------------------------
// T061.3 — ambiguous bundle: explicit user selection, fail closed.
// ---------------------------------------------------------------------------

test('T061 runtime: an ambiguous bundle requires explicit selection and never auto-selects a snapshot', async () => {

  const scratch = makeScratch('ambiguous', 'generic/ambiguous', 'imported/payment-retry-ambiguous');
  const before = bundleDigests(scratch.bundleRoot);
  let open: OpenSession | null = null;
  let passed = false;
  try {
    open = await openSession(scratch.root);

    // Even the explicit generic selection stays ambiguous: two parallel
    // document sets are plausible and only the user may resolve them.
    const journey = await importAndSettle(
      open,
      '/spec-import imported/payment-retry-ambiguous --framework generic',
      'ambiguous bundle compatibility intake',
      ambiguousReportReady,
    );
    assertCommandRegistered(journey);

    assert.match(journey.text, /SPEC_IMPORT_AMBIGUOUS|ambiguous/iu, 'the intake reports the ambiguity');
    assert.match(journey.text, /docs-a/iu, 'the report lists the first candidate set');
    assert.match(journey.text, /docs-b/iu, 'the report lists the competing candidate set');
    assert.match(journey.text, /select|choice|selection/iu, 'the report requires an explicit user selection');

    const blocks = journey.log.askBlocks();
    assert.equal(compatibilityCheckpoints(blocks).length, 0, 'no compatibility checkpoint is presented while selection is pending');
    assertNoNativePhaseCheckpoints(blocks, 'ambiguous import');

    const ids = featureWorkspaceIds(scratch.root);
    const featureId = ids.length === 1 ? ids[0] : null;
    if (featureId !== null) {
      const state = readState(scratch.root, featureId);
      assert.notEqual(workspaceStatus(state), 'implementation_ready', 'an ambiguous import is never implementation-ready');
    }
    assertNoHandoffAndNoClaim(scratch, featureId, 'ambiguous import');
    assertSourceUnchanged(scratch, before, 'ambiguous journey');
    passed = true;
  } finally {
    await closeSession(open);
    cleanupScratchOnCompletion(scratch, passed);
  }
});

// ---------------------------------------------------------------------------
// T061.4 — hostile bundle: blocked before delegation, secrets redacted.
// ---------------------------------------------------------------------------

test('T061 runtime: a hostile bundle blocks before delegation, keeps secrets unread, and survives replay unchanged', async () => {

  const scratch = makeScratch('hostile', 'generic/hostile', 'imported/payment-retry-hostile');
  const before = bundleDigests(scratch.bundleRoot);
  let open: OpenSession | null = null;
  let passed = false;
  try {
    open = await openSession(scratch.root);

    const importCommand = '/spec-import imported/payment-retry-hostile --framework generic';

    const journey = await importAndSettle(open, importCommand, 'hostile bundle compatibility intake', hostileReportReady);
    assertCommandRegistered(journey);

    assert.match(journey.text, /block|unsafe|reject|ERROR\s+SPEC_IMPORT_[A-Z0-9_]+\s*:/iu, 'the first hostile blocker is surfaced as a stable terminal result');
    assert.match(
      journey.text,
      /symlink|traversal|escape|path/iu,
      'the hostile blocker identifies the unsafe path condition',
    );
    for (const marker of SECRET_MARKERS) {
      assert.ok(
        !journey.text.includes(marker),
        `secret-like fixture content must never surface in readable output (${marker.slice(0, 12)}…)`,
      );
    }
    assert.deepEqual(featureWorkspaceIds(scratch.root), [], 'a hostile intake creates no feature workspace');

    const blocks = journey.log.askBlocks();
    assert.equal(compatibilityCheckpoints(blocks).length, 0, 'an unsafe bundle never reaches a compatibility checkpoint');
    assertNoNativePhaseCheckpoints(blocks, 'hostile import');

    const ids = featureWorkspaceIds(scratch.root);
    const featureId = ids.length === 1 ? ids[0] : null;
    assertNoHandoffAndNoClaim(scratch, featureId, 'hostile import');
    assertSourceUnchanged(scratch, before, 'hostile journey (first intake)');

    // Replay: the same hostile intake fails closed again, deterministically.
    const replay = await importAndSettle(open, importCommand, 'hostile bundle replay', hostileReportReady);
    assert.match(`${replay.initialResponse ?? ''}\n${replay.text}`, /block|unsafe|reject|ERROR\s+SPEC_IMPORT_[A-Z0-9_]+\s*:/iu, 'the replayed hostile intake fails closed again');
    assert.equal(compatibilityCheckpoints(replay.log.askBlocks()).length, 0, 'the replay presents no compatibility checkpoint');
    assertSourceUnchanged(scratch, before, 'hostile journey (replay)');
    passed = true;
  } finally {
    await closeSession(open);
    cleanupScratchOnCompletion(scratch, passed);
  }
});

// ---------------------------------------------------------------------------
// T061.5 — unchanged-source journey: idempotent replay, approval, dispatch.
// ---------------------------------------------------------------------------

test('T061 runtime: replay, approval, and dispatch attempts leave the recognized source byte-for-byte unchanged', async () => {

  const scratch = makeScratch('immutability', 'speckit/complete', 'imported/payment-retry-speckit');
  const before = bundleDigests(scratch.bundleRoot);
  let open: OpenSession | null = null;
  let passed = false;
  try {
    open = await openSession(scratch.root);

    const importCommand = '/spec-import imported/payment-retry-speckit';

    // Named-recognition journey (no explicit --framework): Spec Kit layout.
    const journey = await importAndSettle(
      open,
      importCommand,
      'recognized bundle compatibility intake',
      compatibilityCheckpointReady,
      approveCheckpoint,
    );
    assertCommandRegistered(journey);
    assert.match(journey.text, /speckit|spec\s*kit/iu, 'the recognizer names the detected framework mapping');
    const blocks: CheckpointBlock[] = [...journey.log.askBlocks(), ...journey.log.selectedAskBlocks()];
    const checkpoints = compatibilityCheckpoints(blocks);
    assert.equal(checkpoints.length, 1, 'the recognized complete bundle presents exactly one compatibility checkpoint');
    assertNoNativePhaseCheckpoints(blocks, 'recognized import');

    const checkpoint = checkpoints[0];
    assert.ok(checkpoint !== undefined, 'the compatibility checkpoint is readable');
    const featureId = await waitForImportedWorkspace(scratch.root);
    const ready = await waitForState(
      scratch.root,
      featureId,
      state => workspaceStatus(state) === 'implementation_ready'
        && typeof state.specification?.import_ref === 'string'
        && typeof state.specification?.handoff_ref === 'string',
      'recognized import becomes implementation-ready after approval',
    );
    const snapshotRef = ready.specification?.import_ref;
    assert.ok(typeof snapshotRef === 'string' && snapshotRef.length > 0, 'the approved import binds a snapshot ref');
    const handoffBefore = readHandoffs(scratch.root, featureId);
    assert.equal(handoffBefore.length, 1, 'approval freezes exactly one imported handoff');
    const frozen = handoffBefore[0];
    assert.ok(frozen !== undefined, 'the frozen imported handoff is readable');
    assertSharedHandoffIdentity(frozen, featureId, 'recognized imported handoff');
    assertSourceUnchanged(scratch, before, 'after approval');

    // Idempotent replay (FR-066): identical selection returns the established
    // snapshot, compatibility result, and approval state — no new decision.
    const checkpointsBeforeReplay = compatibilityCheckpoints(journey.log.askBlocks()).length;
    const replay = await importAndSettle(open, importCommand, 'idempotent replay of unchanged source', establishedImportReady);
    assert.match(replay.text, /ready|established|unchanged|snapshot/iu, 'the replay returns the established import state');
    assert.equal(featureWorkspaceIds(scratch.root).length, 1, 'the replay creates no duplicate workspace');
    const handoffsAfterReplay = readHandoffs(scratch.root, featureId);
    assert.equal(handoffsAfterReplay.length, 1, 'the replay freezes no duplicate handoff');
    assert.equal(
      handoffsAfterReplay[0]?.handoff_digest,
      frozen.handoff_digest,
      'the replay returns the established handoff identity',
    );
    const stateAfterReplay = readState(scratch.root, featureId);
    assert.equal(stateAfterReplay.specification?.import_ref, snapshotRef, 'the replay returns the established snapshot');
    assert.equal(workspaceStatus(stateAfterReplay), 'implementation_ready', 'the replay preserves the approval state');
    assert.equal(
      compatibilityCheckpoints(replay.log.askBlocks()).length,
      checkpointsBeforeReplay,
      'the idempotent replay presents no fresh compatibility decision',
    );
    assertSourceUnchanged(scratch, before, 'after idempotent replay');

    // Dispatch attempt: /do-work claims the exact frozen digest; the source
    // stays untouched through claim acquisition (FR-068, FR-069).
    const approvedTaskAnchor = frozen.tasks.find(task => task.task_id === "T-101")?.task_id;
    assert.equal(approvedTaskAnchor, "T-101", "the dispatch prompt must use a task anchor present in the pinned imported handoff");
    const transcript = new TranscriptLog(open.session.transcriptPath);
    transcript.refresh();
    const submitCursor = transcript.frames.length;
    const commandPromise = submit(open.driver, `/do-work --spec ${featureId} implement ${approvedTaskAnchor}`);
    const commandOutcome = commandPromise.then(
      () => null,
      error => ({ error }),
    );
    try {
      let impactCard: SelectedAskBlock | undefined;
      await waitFor(
        () => {
          transcript.refresh();
          const pendingKeys = new Set(
            transcript.pendingSelectedAskBlocks().map(block => `${block.frameStart}:${block.frameEnd}:${block.title}:${block.options.join('|')}`),
          );
          const canonicalCards = transcript.selectedAskBlocks().filter(block =>
            block.frameStart >= submitCursor
            && pendingKeys.has(`${block.frameStart}:${block.frameEnd}:${block.title}:${block.options.join('|')}`)
            && isCanonicalConstitutionImpactCard(block, featureId, ready.run_key),
          );
          if (canonicalCards.length !== 1) return false;
          impactCard = canonicalCards[0];
          return true;
        },
        { timeoutMs: CLAIM_WINDOW_MS, intervalMs: 200, label: 'do-work constitution impact approval card' },
      );
      assert.ok(impactCard !== undefined, 'do-work renders exactly one pending canonical constitution-impact approval card');
      await answerSelectedAsk(open.driver, impactCard, 'approve');
      const commandError = await commandOutcome;
      if (commandError !== null) throw commandError.error;
      await waitForState(
        scratch.root,
        featureId,
        candidate => typeof candidate.specification?.execution_claim_ref === 'string',
        'do-work acquires the execution claim for the imported handoff',
        CLAIM_WINDOW_MS,
      );
    } catch (error) {
      await commandOutcome;
      throw error;
    }
    const claimedHandoff = readHandoffs(scratch.root, featureId)[0];
    assert.ok(claimedHandoff !== undefined, 'the canonical imported handoff remains available after do-work');
    const claims = readClaims(scratch.root, featureId, claimedHandoff.handoff_digest);
    assert.equal(claims.length, 1, 'exactly one canonical claim exists for the imported handoff digest');
    const claim = claims[0];
    assert.ok(claim !== undefined, 'the canonical claim is materialized');
    const claimedState = readState(scratch.root, featureId);
    assert.equal(
      claim.claim_id,
      claimedState.specification?.execution_claim_ref,
      'the workspace execution_claim_ref points to the canonical claim',
    );
    assert.equal(claim.owner_kind, 'do_work', 'the claim is owned by the do-work run');
    assert.equal(claim.owner_run_id, ready.run_key, 'the claim is bound to the current do-work run');
    assert.equal(claim.handoff_digest, claimedHandoff.handoff_digest, 'the claim pins the canonical handoff digest');
    assert.ok(
      ['active', 'blocked', 'completed', 'released'].includes(claim.status),
      `the canonical claim has an allowed lifecycle status: ${claim.status}`,
    );
    assert.ok(
      ['claimed', 'executing', 'completion_validating', 'completion_blocked', 'completed'].includes(claimedState.specification?.status ?? ''),
      `the workspace records execution evidence in an allowed status: ${claimedState.specification?.status ?? 'unknown'}`,
    );

    // Bounded real-time quiet window before the final immutability verdict.
    // Deliberate wall clock: a detached OMP executor cannot be driven by fake
    // timers (same exception as the T049 stability window).
    const stabilitySettled = Promise.withResolvers<void>();
    setTimeout(stabilitySettled.resolve, STABILITY_WINDOW_MS);
    await stabilitySettled.promise;
    assertSourceUnchanged(scratch, before, 'after dispatch attempt');
    passed = true;
  } finally {
    await closeSession(open);
    cleanupScratchOnCompletion(scratch, passed);
  }
});

test('T061 runtime: every shipped named framework reaches one canonical checkpoint and preserves provider identity', async () => {
  for (const framework of ['openspec', 'bmad', 'superpowers', 'xpowers']) {
    const scratch = makeScratch(`named-${framework}`, `${framework}/complete`, `imported/payment-retry-${framework}`);
    const before = bundleDigests(scratch.bundleRoot);
    let open: OpenSession | null = null;
    let passed = false;
    try {
      open = await openSession(scratch.root);
      const journey = await importAndSettle(
        open,
        `/spec-import imported/payment-retry-${framework}`,
        `${framework} compatibility intake`,
        compatibilityCheckpointReady,
        approveCheckpoint,
      );
      assertCommandRegistered(journey);
      assert.match(journey.text, new RegExp(framework, 'iu'), `${framework} identity is readable`);
      const checkpoints = compatibilityCheckpoints([...journey.log.askBlocks(), ...journey.log.selectedAskBlocks()]);
      assert.equal(checkpoints.length, 1, `${framework} presents exactly one canonical compatibility checkpoint`);
      const featureId = await waitForImportedWorkspace(scratch.root);
      const state = await waitForState(
        scratch.root,
        featureId,
        candidate => workspaceStatus(candidate) === 'implementation_ready'
          && typeof candidate.specification?.import_ref === 'string'
          && typeof candidate.specification?.handoff_ref === 'string',
        `${framework} workspace becomes implementation-ready`,
      );
      const artifactsDir = join(scratch.root, '.work-state', 'features', featureId, 'artifacts');
      const report = JSON.parse(readFileSync(join(artifactsDir, 'compatibility_report.json'), 'utf8')) as Record<string, unknown>;
      const snapshot = JSON.parse(readFileSync(join(artifactsDir, 'import_snapshot.json'), 'utf8')) as Record<string, unknown>;
      assert.equal(report.framework, framework);
      assert.equal(snapshot.framework, framework);
      assert.equal(state.specification?.import_ref, snapshot.snapshot_id);
      const handoffs = readHandoffs(scratch.root, featureId);
      assert.equal(handoffs.length, 1);
      assert.equal((handoffs[0] as Record<string, unknown>).import_framework, framework);
      assertSourceUnchanged(scratch, before, `${framework} approval`);
      passed = true;
    } finally {
      await closeSession(open);
      cleanupScratchOnCompletion(scratch, passed);
    }
  }
});
function makeDeterministicFixtureRoot(fixtureRoot: string, framework: string): { rootDir: string; cleanup: () => void } {
  const parent = mkdtempSync(join(tmpdir(), `omp-spec-import-deterministic-${framework}-`));
  const rootDir = join(parent, 'source');
  cpSync(join(fixtureRoot, framework, 'complete'), rootDir, { recursive: true });
  if (!existsSync(join(rootDir, 'CONSTITUTION.md'))) {
    writeFileSync(
      join(rootDir, 'CONSTITUTION.md'),
      '# Project Constitution v1.0.0\n\n## I. Quality\n\nShip tested work.\n',
      'utf8',
    );
  }
  return { rootDir, cleanup: () => rmSync(parent, { recursive: true, force: true }) };
}

test('T061 deterministic fixture flow: all shipped frameworks share report, checkpoint, finalizer, handoff, and restart bindings', async () => {
  const fixtureRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../e2e/fixtures/specification');
  const recognizers = {
    speckit: speckitRecognizer,
    openspec: openspecRecognizer,
    bmad: bmadRecognizer,
    superpowers: superpowersRecognizer,
    xpowers: xpowersRecognizer,
  } as const;

  for (const framework of ['speckit', 'openspec', 'bmad', 'superpowers', 'xpowers', 'generic'] as const) {
    const fixture = makeDeterministicFixtureRoot(fixtureRoot, framework);
    const { rootDir } = fixture;
    try {
      const constitutionText = readFileSync(join(rootDir, 'CONSTITUTION.md'), 'utf8');
      const constitution = validConstitutionBinding({
        content_sha256: createHash('sha256').update(constitutionText).digest('hex'),
        semantic_hash: createHash('sha256').update(constitutionText.replace(/\s+/g, ' ').trim()).digest('hex'),
      });
      const before = bundleDigests(rootDir);
    const bundle = await createImportSnapshot({
      rootDir,
      sourcePath: '.',
      feature: 'payment-retry',
      run: 'deterministic-fixture',
    });
    const recognition = framework === 'generic'
      ? bundle.genericRecognition
      : recognizers[framework].recognize({
        source_root: bundle.importSnapshot.source_root,
        source_root_identity: bundle.importSnapshot.source_root_identity,
        documents: bundle.normalized.documents,
        ignored_candidates: bundle.ignoredCandidates,
      });
    assert.ok(recognition, `${framework} fixture must produce a recognition candidate`);

    const bound = bindImportRecognition(bundle, recognition);
    const restarted = bindImportRecognition(bundle, recognition);
    assert.deepEqual(restarted.importSnapshot, bound.importSnapshot, `${framework} restart must retain exact selection identity`);

    // The report is the canonical compatibility checkpoint payload. No
    // framework-specific phase or semantic state machine is introduced here.
    const report = buildCompatibilityReport({
      bundle: bound,
      recognition,
      framework,
      constitution_binding: constitution,
    }).report;
    assert.equal(report.status, 'ready', `${framework} complete fixture must reach the compatibility checkpoint`);
    assert.equal(report.framework, framework);
    assert.equal(report.mapping_id, recognition.mapping_id);
    assert.equal(report.mapping_version, recognition.mapping_version);
    assert.deepEqual(report.selected_paths, bound.importSnapshot.selected_paths);

    const frozen = createImportedHandoff({
      bundle: bound,
      report,
      constitution_binding: constitution,
      handoff_id: `${framework}.deterministic`,
      approval_refs: [`approval-${framework}`],
    }).handoff;
    assert.equal(frozen.import_framework, framework);
    assert.equal(frozen.import_mapping_id, recognition.mapping_id);
    assert.equal(frozen.import_snapshot_ref, bound.importSnapshot.snapshot_id);
    assert.equal(validateImplementationHandoff(frozen).ok, true);

    const finalized = await approveImportedHandoff({
      bundle: bound,
      report,
      constitution_binding: constitution,
      handoff_id: `${framework}.deterministic`,
      approval_refs: [`approval-${framework}`],
    });
    assert.equal(finalized.handoff.handoff_digest, frozen.handoff_digest, `${framework} finalizer must be deterministic`);

    const revalidated = await revalidateImportedHandoffForDispatch({
      bundle: bound,
      report,
      constitution_binding: constitution,
      handoff: finalized.handoff,
    });
    assert.equal(revalidated.ok, true, `${framework} restart/finalizer revalidation must remain valid`);
    assert.equal(revalidated.handoff.handoff_digest, finalized.handoff.handoff_digest);
    assert.deepEqual(bundleDigests(rootDir), before, `${framework} source fixture remains byte-for-byte unchanged`);
    } finally {
      fixture.cleanup();
    }
  }
});
