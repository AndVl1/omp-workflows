/**
 * T094 — real-runtime CTO selector-only preparation, mapping confirmation, and isolation.
 *
 * Drives one real OMP session through the landed T100 journey
 * (`packages/e2e/scenarios/spec-cto-execution.json`): four explicitly selected
 * feature workspaces — a native handoff that must complete through its own
 * conformance matrix, an imported handoff that must close blocked with its CTO
 * claim retained, a stale workspace, and a workspace already claimed by a live
 * `/do-work` run — coordinated through one resident-CTO wave.
 *
 * Pinned runtime behavior (US8 contract, command-contract.md):
 * - selector-only `cto_prepare` receives the immutable full selector array;
 *   the engine derives canonical task/DoD/TeamDef candidates, obtains mapping
 *   confirmation, then emits the eligible-only preflight descriptor;
 *   stale and claimed selections remain readiness exclusions and are never claimed;
 * - the specification-to-team mapping is presented for explicit user
 *   confirmation and starts no worker, lead dispatch, or evidence write
 *   before the confirmation answer is recorded;
 * - after confirmation exactly one active execution claim exists per admitted
 *   handoff digest with `owner_kind cto`;
 * - every claim, conformance matrix, and evidence artifact stays partitioned
 *   per frozen handoff digest; cross-feature evidence is never accepted;
 * - the passing feature completes only through its own passing matrix while
 *   the imported feature closes blocked without borrowing anything;
 * - no human approval is rewritten and no nested CTO is ever created.
 *
 * This test exercises the landed CTO preflight, mapping-confirmation,
 * per-handoff evidence partitioning, and mixed terminal-wave close gates.
 *
 * No execution is mocked: the OMP binary, PTY, transcript, and workspace
 * state are the system under test.
 *
 */

import assert from 'node:assert/strict';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { afterEach, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import type { AskBlock, SelectedAskBlock } from '../src/driver.js';
import { answerSelectedAsk, matchesCanonicalSelectorOptions, TranscriptLog, waitFor, waitForOmpTuiReady, WsDriver } from '../src/driver.js';
import {
  createScratchSpecificationRepository,
  type ScratchRepositoryResult,
} from '../src/specification-fixtures.js';
import { finalizeScratchDirectory } from '../src/scratch-lifecycle.js';
import { loadScenario, type ScenarioDefinition } from '../src/scenario.js';
import { closePinnedDirectory, pinDirectory, readPinnedFileFull } from '../src/fs-safety.js';
import { readSessionInfo, startTestSession, type TestSession } from '../src/server.js';
import { acquireExecutionClaim, readExecutionClaimStore } from '../../core/src/specification/claims.js';
import { canonicalHandoffDigest, evaluateHandoffReadiness } from '../../core/src/specification/handoff.js';
import { materializeFeatureDocuments, materializeImplementationHandoff, materializePhaseValidation } from '../../core/src/specification/materialize.js';
import { createFeatureWorkspace, persistFeatureWorkspace, resolveFeatureWorkspace, applyManualEdits, featureArtifactsDir } from '../../core/src/specification/workspace.js';
import { writeTestArtifact } from '../../core/test/fixtures/artifacts.js';
import { ensureProjectConstitution, readProjectConstitutionGate } from '../../core/src/specification/prerequisite.js';
import { readPinnedCurrentConstitution } from '../../core/src/specification/constitution-identities.js';
import { drainDarwinHelperClosePromisesForTesting, PinnedProjectRoot } from '../../core/src/specification/pinned-root.js';
import { deterministicValidationMatchesArtifact, parseConstitutionPrincipleIdentities, readCanonicalPhaseArtifact, renderCanonicalPhaseDocument } from '../../core/src/specification/phase.js';
import { digestOf as canonicalDigestOf, sha256Hex as canonicalSha256Hex, validateNativePhase, type NativePhaseValidationInput } from '../../core/src/specification/validation.js';
import { resolveSpecificationTemplateSet, SHIPPED_SPECIFICATION_TEMPLATE_IDS } from '../../core/src/specification/templates.js';
import type { ConstitutionBinding, FeatureWorkspace, ImplementationHandoff, SpecificationSemanticModel, WorkspacePhase, WorkspaceUpstreamVersion } from '../../core/src/specification/types.js';
import { bindFeatureWorkspaceToRoot, validFeatureWorkspace, validImplementationHandoff, sha256 as fixtureSha256 } from '../../core/test/fixtures/specification-fixtures.js';
import { loadProfile, profileHash } from '../../core/src/engine/profile.js';
import { loadTeamDefs } from '../../core/src/cto/plan.js';
import { FULLSTACK_ACTIVATION_MARKER_BYTES } from '../../fullstack/src/activation-marker.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const SCENARIO_PATH = join(HERE, '..', 'scenarios', 'spec-cto-execution.json');
const WAIT_TIMEOUT_MS = 600_000;
const PRESERVE_ON_FAILURE = /^(?:1|true|yes)$/iu.test(process.env["OMP_UX_E2E_PRESERVE_ON_FAILURE"] ?? "");
const CTO_TEAMS = [
  { id: 'cto-passing', name: 'Readable CTO Passing', scope: ['readable-cto-passing'], profile: 'standard', lead: 'team-lead', roster: ['developer', 'qa'] },
  { id: 'cto-blocked', name: 'Readable CTO Blocked', scope: ['readable-cto-blocked'], profile: 'standard', lead: 'team-lead', roster: ['developer', 'qa'] },
  { id: 'cto-stale', name: 'Readable CTO Stale', scope: ['readable-cto-stale'], profile: 'standard', lead: 'team-lead', roster: ['developer', 'qa'] },
  { id: 'cto-claimed', name: 'Readable CTO Claimed', scope: ['readable-cto-claimed'], profile: 'standard', lead: 'team-lead', roster: ['developer', 'qa'] },
] as const;
const STABILITY_WINDOW_MS = 10_000;
/** Bounded real-time window for the wave to reach terminal conformance states. */

afterEach(async () => {
  await drainDarwinHelperClosePromisesForTesting();
});
const WAVE_WINDOW_MS = 3_600_000;
const MAX_PROTOCOL_LOG_BYTES = 8 * 1024 * 1024;
const MAX_PROTOCOL_LOG_FILES = 32;
const DIGEST_RE = /^[0-9a-f]{64}$/u;
const CONSTITUTION_BOOTSTRAP_FEATURE_ID = "readable-cto-constitution-bootstrap";
const CONSTITUTION_BOOTSTRAP_RUN_KEY = "readable-cto-constitution-bootstrap-run-001";

const DURABLE_PROTOCOL_MILESTONES = [
  'preflight',
  'mapping_ask',
  'confirm',
  'dispatch',
  'conformance',
  'close',
] as const;
type DurableProtocolMilestone = (typeof DURABLE_PROTOCOL_MILESTONES)[number];

type PhaseRecord = {
  phase: string;
  status: string;
  current_version: number | null;
  approved_version: number | null;
  stale_reason: string | null;
};

type PersistedState = {
  run_key?: unknown;
  specification?: {
    feature_id?: unknown;
    status?: unknown;
    phases?: PhaseRecord[];
    next_action?: { kind?: string; command?: string | null; reason?: string };
    handoff_ref?: unknown;
    execution_claim_ref?: unknown;
    implementation_conformance_ref?: unknown;
  };
};

type HandoffArtifact = {
  handoff_id: string;
  handoff_digest: string;
  feature_id: string;
  status: string;
  open_decisions: string[];
  execution_choices: string[];
  requirements: Array<{ requirement_id: string; acceptance_ids: string[] }>;
  verification: Array<{ requirement_ids: string[]; acceptance_ids: string[]; observable_behavior: boolean }>;
};

type ClaimArtifact = {
  claim_id: string;
  handoff_digest: string;
  owner_kind: string;
  owner_run_id: string;
  status: string;
  release_reason: string | null;
  admission_binding?: {
    mapping_id?: string;
    wave_id?: string;
  };
};

/** Persisted shape mirrors the canonical `CtoSpecificationMapping` (cto/types.ts). */
type MappingArtifact = {
  schema_version?: number;
  mapping_id: string;
  mapping_version?: number;
  mapping_hash?: string;
  feature_ids?: string[];
  handoff_bindings?: Array<{ feature_id?: string; handoff_id?: string; handoff_digest?: string }>;
  task_to_slice?: Array<{ feature_id?: string; task_id?: string; team_id?: string; slice_id?: string; requirement_ids?: string[]; verification_ids?: string[]; depends_on?: string[] }>;
  shared_contracts?: Array<{ contract_id?: string; contract?: string; task_ids?: string[]; reason?: string; requires_serialization?: boolean }>;
  parallelization?: Array<{ slice_id?: string; decision?: string; reason?: string; worktree?: string; depends_on_slice_ids?: string[]; shared_contract_ids?: string[] }>;
  checkpoint_ref?: string | null;
  status?: string;
};

type MappingRecord = {
  mapping?: MappingArtifact;
  mapping_id?: string;
  handoff_bindings?: MappingArtifact['handoff_bindings'];
  status?: string;
};

type ConformanceArtifact = {
  conformance_id: string;
  matrix_digest: string;
  feature_id: string;
  handoff_id: string;
  handoff_digest: string;
  execution_claim_id: string;
  execution_owner: string;
  execution_run_id: string;
  entries: Array<{ entry_id: string; subject_kind: string; subject_id: string; status: string }>;
  overall_status: string;
  next_action?: string;
  blocking_findings?: Array<{ code?: string }>;
};

type Scratch = { root: string; parent: string; repository: ScratchRepositoryResult; exact: boolean };
const EXACT_SCRATCH_ENV = 'OMP_UX_E2E_EXACT_SCRATCH_ROOT';
const UUID_V4_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

function normalizedTmpAlias(path: string): string {
  return process.platform === 'darwin' && (path === '/tmp' || path.startsWith('/tmp/')) ? `/private${path}` : path;
}

function assertExactDirectory(root: string, relativePath: string): void {
  const stat = lstatSync(join(root, relativePath));
  assert.equal(stat.isDirectory() && !stat.isSymbolicLink(), true, `exact scratch ${relativePath} must be a real directory`);
}

function assertExactRegularSingleLink(root: string, relativePath: string, description: string): void {
  const stat = lstatSync(join(root, relativePath));
  assert.equal(stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1, true, description);
}

function exactBootstrappedScratch(): Scratch | null {
  const configured = process.env[EXACT_SCRATCH_ENV];
  if (configured === undefined) return null;
  assert.ok(configured.length > 0, `${EXACT_SCRATCH_ENV} must not be empty`);
  const lexical = resolve(configured);
  const canonical = resolve(realpathSync(lexical));
  assert.equal(normalizedTmpAlias(lexical), normalizedTmpAlias(canonical), 'exact scratch path must not use a symlinked ancestor');
  const rootStat = lstatSync(canonical);
  assert.equal(rootStat.isDirectory() && !rootStat.isSymbolicLink(), true, 'exact scratch root is a real directory');
  assertExactDirectory(canonical, '.work-state');
  assertExactDirectory(canonical, '.omp');
  assertExactDirectory(canonical, join('.work-state', 'ux-e2e'));
  const provenanceRelativePath = join('.work-state', 'ux-e2e', 'bootstrap-provenance.json');
  assertExactRegularSingleLink(canonical, provenanceRelativePath, 'exact scratch bootstrap provenance must be a regular single-link file');
  const provenancePath = join(canonical, provenanceRelativePath);
  const provenance = JSON.parse(readFileSync(provenancePath, 'utf8')) as Record<string, unknown>;
  assert.deepEqual(
    Object.keys(provenance).sort(),
    ['branch', 'canonical_root', 'core_target', 'kind', 'monorepo_root', 'nonce', 'root_basename', 'schema_version', 'slug'].sort(),
    'exact scratch bootstrap provenance has the canonical bounded schema',
  );
  assert.equal(provenance.schema_version, 1);
  assert.equal(provenance.kind, 'ux-e2e-bootstrap');
  assert.equal(provenance.canonical_root, canonical);
  assert.equal(provenance.root_basename, basename(canonical));
  assert.equal(typeof provenance.slug, 'string');
  assert.match(String(provenance.slug), /^[a-z0-9][a-z0-9-]{0,63}$/u);
  assert.match(String(provenance.branch), /^[A-Za-z0-9._/-]{1,128}$/u);
  assert.match(String(provenance.nonce), UUID_V4_RE);
  const packageManifest = JSON.parse(readFileSync(join(canonical, 'package.json'), 'utf8')) as Record<string, unknown>;
  assert.equal(packageManifest.private, true);
  assert.equal(packageManifest.name, `omp-ux-e2e-${String(provenance.slug)}`);
  const expectedMonorepo = resolve(HERE, '..', '..', '..');
  assert.equal(provenance.monorepo_root, expectedMonorepo, 'exact scratch is bootstrapped by this checkout');
  assert.equal(provenance.core_target, resolve(expectedMonorepo, 'packages', 'core'));
  const head = readFileSync(join(canonical, '.git', 'HEAD'), 'utf8').trim();
  assert.equal(head, `ref: refs/heads/${String(provenance.branch)}`, 'exact scratch is on the authenticated bootstrap branch');
  assertExactRegularSingleLink(canonical, join('.omp', 'fullstack.activation.json'), 'exact scratch has the authenticated activation marker');
  assert.deepEqual(readFileSync(join(canonical, '.omp', 'fullstack.activation.json')), FULLSTACK_ACTIVATION_MARKER_BYTES, 'exact scratch activation marker bytes are canonical');
  const fullstackLink = join(canonical, 'node_modules', '@andvl1', 'omp-workflows-fullstack');
  const coreLink = join(canonical, 'node_modules', '@andvl1', 'omp-workflows-core');
  assert.equal(lstatSync(fullstackLink).isSymbolicLink(), true, 'exact scratch fullstack package is a bootstrap link');
  assert.equal(lstatSync(coreLink).isSymbolicLink(), true, 'exact scratch core package is a bootstrap link');
  assert.equal(resolve(realpathSync(fullstackLink)), resolve(expectedMonorepo, 'packages', 'fullstack'));
  assert.equal(resolve(realpathSync(coreLink)), resolve(expectedMonorepo, 'packages', 'core'));
  const staleStatePaths: string[] = [];
  for (const relativePath of ['CONSTITUTION.md', 'src', join('.work-state', 'cto'), join('.work-state', 'features'), join('.work-state', 'specification'), 'specs']) {
    const candidate = join(canonical, relativePath);
    try {
      const candidateStat = lstatSync(candidate);
      if (candidateStat.isSymbolicLink()) {
        staleStatePaths.push(relativePath);
      } else if (candidateStat.isDirectory()) {
        if (readdirSync(candidate).length > 0) staleStatePaths.push(relativePath);
      } else {
        staleStatePaths.push(relativePath);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
  if (staleStatePaths.length > 0) {
    throw new Error(`exact scratch has stale state; expected a pristine bootstrap (${staleStatePaths.join(', ')})`);
  }
  const teamsPath = join(canonical, '.omp', 'teams.json');
  let teamsPresent = false;
  try {
    const teamsStat = lstatSync(teamsPath);
    if (teamsStat.isSymbolicLink() || !teamsStat.isFile() || teamsStat.nlink !== 1) throw new Error('exact scratch teams.json is not a regular single-link file');
    teamsPresent = true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  if (!teamsPresent) writeFileSync(teamsPath, JSON.stringify(CTO_TEAMS, null, 2) + '\n', { flag: 'wx' });
  mkdirSync(join(canonical, '.work-state', 'cto'), { recursive: true });
  const repository = {
    root: canonical,
    slug: String(provenance.slug),
    files: [],
    bundles: [],
    git: { initialized: true, branch: String(provenance.branch), committed: false },
  } as unknown as ScratchRepositoryResult;
  return { root: canonical, parent: canonical, repository, exact: true };
}

function assertRuntimePluginRegistry(session: TestSession, root: string): void {
  const raw = JSON.parse(readFileSync(session.sessionJsonPath, 'utf8')) as {
    runtime_plugins?: {
      schema_version?: unknown;
      extension_package?: { name?: unknown; version?: unknown; realpath?: unknown };
      core_package?: { name?: unknown; version?: unknown; realpath?: unknown };
      configured_extensions?: unknown;
      duplicate_tool_names?: unknown;
    } | null;
  };
  const registry = raw.runtime_plugins;
  assert.ok(registry && typeof registry === 'object', 'session runtime_plugins diagnostics are present');
  assert.equal(registry.schema_version, 1);
  assert.deepEqual(registry.configured_extensions, [join(root, 'node_modules', '@andvl1', 'omp-workflows-fullstack')]);
  assert.deepEqual(registry.duplicate_tool_names, []);
  assert.deepEqual(registry.extension_package?.name, '@andvl1/omp-workflows-fullstack');
  assert.deepEqual(registry.core_package?.name, '@andvl1/omp-workflows-core');
  assert.equal(registry.extension_package?.version, '0.27.0');
  assert.equal(registry.core_package?.version, '0.27.0');
  assert.equal(
    registry.extension_package?.realpath,
    realpathSync(join(root, 'node_modules', '@andvl1', 'omp-workflows-fullstack')),
  );
  assert.equal(
    registry.core_package?.realpath,
    realpathSync(join(root, 'node_modules', '@andvl1', 'omp-workflows-core')),
  );
}
type OpenSession = { session: TestSession; driver: WsDriver };
type WorkspaceSnapshot = {
  featureId: string;
  runKey: string;
  approved: Record<string, number | null>;
  handoff: HandoffArtifact;
};

// ---------------------------------------------------------------------------
// Helpers (mirroring the T025/T040/T049/T102 runtime harness).
// ---------------------------------------------------------------------------


function makeScratch(options: { allowExact?: boolean } = {}): Scratch {
  const exact = options.allowExact === true ? exactBootstrappedScratch() : null;
  if (exact !== null) {
    const profile = loadProfile("spec-preparation");
    assert.ok(profile, "the shipped spec-preparation profile is available for exact scratch setup");
    if (!profile) throw new Error("spec-preparation profile is unavailable");
    const bootstrap = createFeatureWorkspace(exact.root, {
      feature_id: CONSTITUTION_BOOTSTRAP_FEATURE_ID,
      display_name: "Native constitution bootstrap",
      run_key: CONSTITUTION_BOOTSTRAP_RUN_KEY,
      profile_name: "spec-preparation",
      profile_hash: profileHash(profile),
    });
    assert.ok(bootstrap.ok, bootstrap.ok ? "" : bootstrap.error);
    if (!bootstrap.ok) throw new Error(bootstrap.error);
    const teams = loadTeamDefs(exact.root);
    assert.equal(teams.length, CTO_TEAMS.length, 'loaded CTO teams match the exact scratch fixture');
    return exact;
  }
  const parent = mkdtempSync(join(tmpdir(), 'omp-spec-cto-exec-'));
  const repository = createScratchSpecificationRepository({
    workdir: parent,
    slug: 'cto-exec-wave',
    runtime: true,
    bundles: [{ id: 'generic/complete', as: 'imported/cto-blocked' }],
    extraFiles: [
      { path: 'README.md', contents: '# Specification-backed CTO execution wave fixture\n' },
      { path: '.omp/teams.json', contents: JSON.stringify(CTO_TEAMS, null, 2) + '\n' },
    ],
  });
  mkdirSync(join(repository.root, '.work-state', 'cto'), { recursive: true });
  const teams = loadTeamDefs(repository.root);
  assert.equal(teams.length, CTO_TEAMS.length, 'canonical CTO team registry loads before OMP starts');
  const profile = loadProfile("spec-preparation");
  assert.ok(profile, "the shipped spec-preparation profile is available for constitution bootstrap");
  if (!profile) throw new Error("spec-preparation profile is unavailable");
  const bootstrap = createFeatureWorkspace(repository.root, {
    feature_id: CONSTITUTION_BOOTSTRAP_FEATURE_ID,
    display_name: "Native constitution bootstrap",
    run_key: CONSTITUTION_BOOTSTRAP_RUN_KEY,
    profile_name: "spec-preparation",
    profile_hash: profileHash(profile),
  });
  assert.ok(bootstrap.ok, bootstrap.ok ? "" : bootstrap.error);
  if (!bootstrap.ok) throw new Error(bootstrap.error);
  assert.deepEqual(teams.map(team => team.id), CTO_TEAMS.map(team => team.id), 'loaded CTO teams match the scenario fixture');
  return { root: repository.root, parent, repository, exact: false };
}

function removeConstitutionBootstrapWorkspace(root: string): void {
  rmSync(join(root, ".work-state", "features", CONSTITUTION_BOOTSTRAP_FEATURE_ID), { recursive: true, force: true });
  rmSync(join(root, "specs", CONSTITUTION_BOOTSTRAP_FEATURE_ID), { recursive: true, force: true });
}

function readState(root: string, featureId: string): PersistedState {
  const path = join(root, '.work-state', 'features', featureId, 'state.json');
  return JSON.parse(readFileSync(path, 'utf8')) as PersistedState;
}

function phaseOf(state: PersistedState, phase: string): PhaseRecord | undefined {
  return state.specification?.phases?.find(candidate => candidate.phase === phase);
}

function workspaceStatus(state: PersistedState): string {
  return typeof state.specification?.status === 'string' ? state.specification.status : '';
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
    { timeoutMs, intervalMs: 250, label },
  );
  assert.ok(latest !== undefined, `durable state exists after ${label}`);
  return latest;
}

async function openSession(
  root: string,
  scenario: ScenarioDefinition,
  taskPrompt = scenario.task,
): Promise<OpenSession> {
  const runtimeBudgetSec = Math.max(5_400, Math.ceil(scenario.timing.stageTimeoutMs / 1000) * 3);
  const session = await startTestSession({
    cwd: root,
    surface: 'text',
    cols: 120,
    rows: 40,
    maxTimeSec: runtimeBudgetSec,
    idleMs: runtimeBudgetSec * 1000,
    taskPrompt,
    scenario: { id: scenario.id, title: scenario.title },
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


const VALID_BOOTSTRAP_CONSTITUTION = [
  '# Project Constitution',
  '',
  'Version: 1.0.0',
  '',
  '## I. Quality',
  '',
  'Every change ships with behavioral tests and deterministic verification.',
  '',
].join('\n');

const PASSING_SPECIFICATION = [
  '# Readable CTO Passing Outcome',
  '',
  '## Problem',
  '',
  'The execution wave must expose one deterministic, independently runnable outcome and a typed task graph.',
  '',
  '## Requirements',
  '',
  '- FR-1: Running `node src/passing/index.js` with no arguments exits with code 0 and emits exactly `{"status":"completed","outcome":"requested outcome completed"}` followed by a newline; every execution slice records evidence for FR-1.',
  '',
  '## Success Criteria',
  '',
  '- AC-1: The command is runnable from the project root and produces the exact JSON output without reading or writing outside `src/passing/`; independent JSON audit-log and metrics slices may run in parallel, loader precedes schema-validator, and shared-defaults writes are serialized.',
  '',
].join('\n');

const PASSING_PLAN = [
  '# Readable CTO Passing Plan',
  '',
  '## Decision',
  '',
  'Use a standalone Node.js ESM entrypoint with a frozen result object so the acceptance output is deterministic.',
  '',
  '## Scope',
  '',
  'Only `src/passing/` may be changed for this outcome; audit-log and metrics are independent JSON slices, loader precedes schema-validator, and both shared-defaults tasks use one shared path.',
  '',
  '## Verification',
  '',
  'Run `node src/passing/index.js`; require exit code 0 and the exact JSON line from the specification, then retain one typed evidence record for every task.',
  '',
].join('\n');

const PASSING_TASKS = [
  '# Readable CTO Passing Tasks',
  '',
  '## T-AUDIT-LOG — Record deterministic JSON audit log',
  '',
  '- Requirement: FR-1',
  '- Acceptance: AC-1',
  '- Verification: V-1',
  '- Affected scope: `src/passing/audit-log.json`',
  '- Expected outcome: the audit-log JSON slice records the deterministic completed outcome.',
  '',
  '## T-METRICS — Record deterministic JSON metrics',
  '',
  '- Requirement: FR-1',
  '- Acceptance: AC-1',
  '- Verification: V-1',
  '- Affected scope: `src/passing/metrics.json`',
  '- Expected outcome: the metrics JSON slice records the deterministic completed count.',
  '',
  '## T-LOADER — Implement the deterministic loader',
  '',
  '- Requirement: FR-1',
  '- Acceptance: AC-1',
  '- Verification: V-1',
  '- Affected scope: `src/passing/loader.js`',
  '- Expected outcome: the loader returns the frozen passing outcome.',
  '',
  '## T-SCHEMA-VALIDATOR — Validate the loaded outcome',
  '',
  '- Requirement: FR-1',
  '- Acceptance: AC-1',
  '- Verification: V-1',
  '- Depends on: T-LOADER',
  '- Affected scope: `src/passing/schema-validator.js`',
  '- Expected outcome: the validator accepts the loader output after T-LOADER completes.',
  '',
  '## T-SHARED-DEFAULTS-A — Write the baseline shared defaults',
  '',
  '- Requirement: FR-1',
  '- Acceptance: AC-1',
  '- Verification: V-1',
  '- Affected scope: `src/passing/shared-defaults.json`',
  '- Expected outcome: the baseline shared defaults are written through the shared contract.',
  '',
  '## T-SHARED-DEFAULTS-B — Write the verified shared defaults',
  '',
  '- Requirement: FR-1',
  '- Acceptance: AC-1',
  '- Verification: V-1',
  '- Affected scope: `src/passing/shared-defaults.json`',
  '- Expected outcome: the verified shared defaults replace the baseline only after T-SHARED-DEFAULTS-A.',
  '',
].join('\n');

type PassingTaskFixture = ImplementationHandoff['tasks'][number];
const PASSING_TASK_GRAPH: PassingTaskFixture[] = [
  {
    task_id: 'T-AUDIT-LOG',
    title: 'Record deterministic JSON audit log',
    requirement_ids: ['FR-1'],
    depends_on: [],
    expected_outcome: 'The audit-log JSON slice records the deterministic completed outcome.',
    affected_scope: ['src/passing/audit-log.json'],
    completion_evidence: ['Record the deterministic completed audit-log JSON envelope.'],
    parallel_safe: true,
  },
  {
    task_id: 'T-METRICS',
    title: 'Record deterministic JSON metrics',
    requirement_ids: ['FR-1'],
    depends_on: [],
    expected_outcome: 'The metrics JSON slice records the deterministic completed count.',
    affected_scope: ['src/passing/metrics.json'],
    completion_evidence: ['Record the deterministic completed metrics JSON envelope.'],
    parallel_safe: true,
  },
  {
    task_id: 'T-LOADER',
    title: 'Implement the deterministic loader',
    requirement_ids: ['FR-1'],
    depends_on: [],
    expected_outcome: 'The loader returns the frozen passing outcome.',
    affected_scope: ['src/passing/loader.js'],
    completion_evidence: ['Record loader evidence bound to FR-1.'],
    parallel_safe: true,
  },
  {
    task_id: 'T-SCHEMA-VALIDATOR',
    title: 'Validate the loaded outcome',
    requirement_ids: ['FR-1'],
    depends_on: ['T-LOADER'],
    expected_outcome: 'The validator accepts the loader output after T-LOADER completes.',
    affected_scope: ['src/passing/schema-validator.js'],
    completion_evidence: ['Record schema-validator evidence bound to FR-1 and T-LOADER.'],
    parallel_safe: true,
  },
  {
    task_id: 'T-SHARED-DEFAULTS-A',
    title: 'Write the baseline shared defaults',
    requirement_ids: ['FR-1'],
    depends_on: [],
    expected_outcome: 'The baseline shared defaults are written through the shared contract.',
    affected_scope: ['src/passing/shared-defaults.json'],
    completion_evidence: ['Record baseline shared-defaults evidence bound to FR-1.'],
    parallel_safe: true,
  },
  {
    task_id: 'T-SHARED-DEFAULTS-B',
    title: 'Write the verified shared defaults',
    requirement_ids: ['FR-1'],
    depends_on: [],
    expected_outcome: 'The verified shared defaults replace the baseline only after T-SHARED-DEFAULTS-A.',
    affected_scope: ['src/passing/shared-defaults.json'],
    completion_evidence: ['Record verified shared-defaults evidence bound to FR-1 and the shared path.'],
    parallel_safe: true,
  },
];
const PASSING_SOURCE = [
  'const OUTCOME = Object.freeze({ status: "completed", outcome: "requested outcome completed" });',
  '',
  'if (process.argv.length !== 2) {',
  '  process.exitCode = 2;',
  '} else {',
  '  process.stdout.write(`${JSON.stringify(OUTCOME)}\\n`);',
  '}',
  '',
].join('\n');

type SeededFeature = { workspace: FeatureWorkspace; handoff: ImplementationHandoff; snapshot: WorkspaceSnapshot };

function strictHandoffProjectionOptions(root: string, handoff: ImplementationHandoff): { beforeWrite: (path: string) => void } {
  return {
    beforeWrite: () => {
      const pinned = PinnedProjectRoot.open(root);
      if (!pinned) throw new Error("project root cannot be pinned for handoff projection");
      try {
        const current = readPinnedCurrentConstitution(root, pinned, handoff.constitution_binding);
        if (!current.ok) throw new Error(current.error);
      } finally {
        pinned.close();
      }
    },
  };
}

const CANONICAL_PHASE_ORDER = ["specify", "plan", "tasks"] as const;

function canonicalUpstreamVersions(
  phase: WorkspacePhase,
  phaseRecords: readonly FeatureWorkspace["phases"][number][],
  handoff: ImplementationHandoff,
): WorkspaceUpstreamVersion[] {
  const phaseIndex = CANONICAL_PHASE_ORDER.indexOf(phase);
  return CANONICAL_PHASE_ORDER.slice(0, phaseIndex).map((upstreamPhase) => {
    const upstreamRecord = phaseRecords.find((candidate) => candidate.phase === upstreamPhase);
    const version = upstreamRecord?.approved_version ?? upstreamRecord?.current_version;
    assert.ok(typeof version === "number" && Number.isSafeInteger(version) && version >= 1, phase + " binds a current upstream version for " + upstreamPhase);
    if (typeof version !== "number" || !Number.isSafeInteger(version) || version < 1) throw new Error(phase + " lacks a current upstream version for " + upstreamPhase);
    const artifactId = upstreamPhase + ".v" + version;
    const artifact = handoff.artifact_versions.find((candidate) => candidate.artifact_id === artifactId);
    assert.ok(artifact !== undefined, phase + " binds a seeded upstream artifact " + artifactId);
    if (artifact === undefined) throw new Error(phase + " lacks seeded upstream artifact " + artifactId);
    assert.equal(artifact.version, version, phase + " upstream artifact version matches " + artifactId);
    return { phase: upstreamPhase, version, hash: artifact.sha256 };
  });
}

function seedReadyFeature(
  scratch: Scratch,
  featureId: string,
  runKey: string,
  binding: ConstitutionBinding,
): SeededFeature {
  const profile = loadProfile("spec-preparation");
  assert.ok(profile, "the shipped spec-preparation profile is available");
  if (!profile) throw new Error("spec-preparation profile is unavailable");
  const created = createFeatureWorkspace(scratch.root, {
    feature_id: featureId,
    display_name: featureId,
    run_key: runKey,
    profile_name: "spec-preparation",
    profile_hash: profileHash(profile),
  });
  assert.ok(created.ok, created.ok ? "" : created.error);
  if (!created.ok) throw new Error(created.error);
  const fixtureHandoff = validImplementationHandoff({ featureId });
  const handoff: ImplementationHandoff = { ...fixtureHandoff, schema_version: 1 };
  handoff.constitution_binding = binding;
  handoff.execution_choices = ["do-work", "cto"];
  const isPassingFeature = featureId.endsWith('-passing');
  const isBlockedFeature = featureId.endsWith('-blocked');
  const scopePath = isPassingFeature ? 'src/passing/**'
    : isBlockedFeature ? 'src/blocked/**'
      : null;
  const taskGraph = isPassingFeature
    ? PASSING_TASK_GRAPH.map(task => ({ ...task, requirement_ids: [...task.requirement_ids], depends_on: [...task.depends_on], affected_scope: [...task.affected_scope], completion_evidence: [...task.completion_evidence] }))
    : handoff.tasks;
  if (scopePath !== null) {
    handoff.scope = { ...handoff.scope, in_scope: [scopePath], constraints: isPassingFeature ? [] : [...handoff.scope.constraints] };
    handoff.tasks = taskGraph.map(task => ({
      ...task,
      ...(isPassingFeature ? {} : {
        title: "Implement the outcome and produce typed conformance evidence",
        expected_outcome: "The requested outcome is observable, and the lead passes the typed evidence contract verbatim to implementation and QA evidence workers.",
      }),
      completion_evidence: [
        "focused test run proving the outcome",
        "Persist the canonical conformance_evidence envelope at .work-state/features/<feature_id>/artifacts/<artifact_id>.json and reference that exact feature-local path; do not use a team-level .work-state/artifacts mirror.",
        "Canonical conformance_evidence envelope has exactly schema_version, artifact_id, and entries; do not add top-level provenance.",
        "The CTO conformance call wraps every submitted evidence entry with an artifact: CompletionArtifactRef, and every executed_test entry has test.evidence_ref: CompletionArtifactRef.",
        "Pass this evidence contract from the lead verbatim to both implementation and QA evidence workers.",
      ],
    }));
    handoff.verification = handoff.verification.map(verification => ({
      ...verification,
      task_ids: isPassingFeature ? taskGraph.map(task => task.task_id) : [...verification.task_ids],
      expected_evidence: "The lead passes the exact conformance_evidence envelope schema guidance to implementation and QA evidence workers; the CTO conformance call wraps every entry with CompletionArtifactRef and every executed_test has test.evidence_ref: CompletionArtifactRef.",
    }));
  }
  if (featureId.endsWith('-passing')) {
    handoff.requirements = handoff.requirements.map(requirement => ({
      ...requirement,
      statement: 'Running node src/passing/index.js with no arguments exits with code 0 and emits exactly {"status":"completed","outcome":"requested outcome completed"} followed by a newline.',
      source_refs: [`specs/${featureId}/spec.md#requirements`],
    }));
    handoff.tasks = handoff.tasks.map(task => ({
      ...task,
      completion_evidence: [
        'Run node src/passing/index.js and record exit code 0 plus the exact JSON output.',
        ...task.completion_evidence,
      ],
    }));
    handoff.verification = handoff.verification.map(verification => ({
      ...verification,
      expected_evidence: 'Run node src/passing/index.js; record exit code 0 and the exact JSON output. The lead passes the exact conformance_evidence envelope schema guidance to implementation and QA evidence workers; the CTO conformance call wraps every entry with CompletionArtifactRef and every executed_test has test.evidence_ref: CompletionArtifactRef.',
    }));
  }
  const canonicalPhaseArtifacts = materializeCanonicalPhaseFixture(scratch.root, featureId, runKey, binding);
  handoff.artifact_versions = handoff.artifact_versions.map(artifact => {
    const phaseArtifact = canonicalPhaseArtifacts.get(artifact.kind);
    return phaseArtifact === undefined ? artifact : { ...artifact, sha256: canonicalDigestOf(phaseArtifact) };
  });
  handoff.handoff_digest = canonicalHandoffDigest(handoff);
  const handoffDir = join(featureArtifactsDir(scratch.root, featureId), "implementation_handoff");
  writeTestArtifact(scratch.root, handoffDir, handoff.handoff_id, handoff);
  const projection = materializeImplementationHandoff(scratch.root, handoff, strictHandoffProjectionOptions(scratch.root, handoff));
  assert.ok(projection.ok, projection.ok ? "" : projection.error);
  if (!projection.ok) throw new Error(projection.error);

  const fixtureWorkspace = bindFeatureWorkspaceToRoot(
    validFeatureWorkspace({
      featureId,
      projectRoot: scratch.root,
      sourceKind: "native",
      status: "implementation_ready",
      constitutionBinding: binding,
      withApprovedSpecify: true,
    }),
    scratch.root,
  );
  const phaseRecords: FeatureWorkspace["phases"] = fixtureWorkspace.phases.map(phase => ({
    ...phase,
    status: "approved",
    current_version: 1,
    approved_version: 1,
    validation_ref: "validation." + phase.phase + ".v1",
    checkpoint_ref: "checkpoint." + phase.phase + ".v1",
    upstream_versions: [],
    stale_reason: null,
    last_feedback: null,
  }));
  const phases: FeatureWorkspace["phases"] = phaseRecords.map(phase => ({
    ...phase,
    upstream_versions: canonicalUpstreamVersions(phase.phase, phaseRecords, handoff),
  }));
  const candidate: FeatureWorkspace = {
    ...created.value,
    display_name: fixtureWorkspace.display_name,
    source_kind: fixtureWorkspace.source_kind,
    project_root: fixtureWorkspace.project_root,
    project_root_identity: fixtureWorkspace.project_root_identity,
    language: fixtureWorkspace.language,
    template_set: fixtureTemplateSelection(),
    phases,
    constitution_gate_ref: null,
    constitution_binding: binding,
    handoff_ref: handoff.handoff_id,
    execution_claim_ref: null,
    implementation_conformance_ref: null,
    import_ref: null,
    migration_receipt_ref: null,
    status: "implementation_ready",
    next_action: {
      kind: "command",
      command: "/do-work --spec " + featureId,
      reason: "all approved artifacts are ready for an executor",
    },
  };
  const persisted = persistFeatureWorkspace(scratch.root, candidate, undefined, {
    expected_workspace_digest: canonicalDigestOf(created.value),
  });
  assert.ok(persisted.ok, persisted.ok ? "" : persisted.error);
  if (!persisted.ok) throw new Error(persisted.error);

  const loaded = resolveFeatureWorkspace(scratch.root, { feature_id: featureId, run_key: runKey });
  assert.ok(loaded.ok, loaded.ok ? "" : loaded.error);
  if (!loaded.ok) throw new Error(loaded.error);
  assertCanonicalPhaseFixture(scratch.root, featureId, runKey, binding);
  if (featureId.endsWith('-passing')) materializePassingFixture(scratch.root, featureId);
  const readiness = evaluateHandoffReadiness(handoff, { current_constitution_binding: loaded.value.constitution_binding });
  assert.equal(readiness.ok, true, featureId + " passes the production handoff readiness API before launch");
  const snapshot = snapshotWorkspace(scratch.root, featureId);
  return { workspace: loaded.value, handoff, snapshot };
}

function materializePassingFixture(root: string, featureId: string): void {
  const sourceDir = join(root, 'src', 'passing');
  mkdirSync(sourceDir, { recursive: true });
  writeFileSync(join(sourceDir, 'index.js'), PASSING_SOURCE);
}

function assertCanonicalPhaseFixture(root: string, featureId: string, runKey: string, binding: ConstitutionBinding): void {
  const pinned = PinnedProjectRoot.open(root);
  assert.ok(pinned, `${featureId} fixture root can be pinned for canonical phase verification`);
  if (!pinned) throw new Error(`${featureId} fixture root cannot be pinned`);
  try {
    for (const phase of CANONICAL_PHASE_ORDER) {
      const artifact = readCanonicalPhaseArtifact(root, { feature_id: featureId, run_key: runKey, phase, version: 1 }, pinned);
      assert.ok(artifact, `${featureId} has a canonical ${phase}.v1 artifact bound to its run`);
      if (!artifact) continue;
      assert.deepEqual(artifact.constitution_binding, binding, `${featureId} ${phase}.v1 preserves the exact constitution binding`);
      assert.equal(artifact.upstream_versions.length, phase === 'specify' ? 0 : phase === 'plan' ? 1 : 2, `${featureId} ${phase}.v1 has complete upstream closure`);
      const validationPath = join(root, '.work-state', 'features', featureId, 'artifacts', `validation.${phase}.v1.json`);
      const validation = JSON.parse(readFileSync(validationPath, 'utf8')) as Record<string, unknown>;
      assert.equal(validation.status, 'pass', `${featureId} ${phase}.v1 has passing validation evidence`);
      assert.equal(validation.validation_id, `validation.${phase}.v1`);
      assert.equal(validation.artifact_version, `${phase}.v1`);
      assert.equal(deterministicValidationMatchesArtifact(artifact, validation, pinned), true, `${featureId} ${phase}.v1 validation is production-deterministic and digest-bound`);
    }
  } finally {
    pinned.close();
  }
}

function fixtureTemplateSelection() {
  const resolved = resolveSpecificationTemplateSet({ template_ids: SHIPPED_SPECIFICATION_TEMPLATE_IDS });
  assert.equal(resolved.ok, true, resolved.ok ? '' : resolved.error);
  if (!resolved.ok) throw new Error(resolved.error);
  return resolved.value.selection;
}

function fixturePhaseModel(
  phase: WorkspacePhase,
  featureId: string,
  runKey: string,
  binding: ConstitutionBinding,
  upstreamVersions: Array<{ artifact_id: string; version: number; hash: string }>,
  dispatchId: string,
  constitutionDocument: string,
): SpecificationSemanticModel {
  const principles = parseConstitutionPrincipleIdentities(constitutionDocument);
  const requirement = {
    requirement_id: 'FR-1',
    statement: 'Running node src/passing/index.js with no arguments exits with code 0 and emits the requested completed outcome.',
    acceptance_ids: ['AC-1'],
    source_refs: [`specs/${featureId}/spec.md#requirements`],
    testable: true,
    untestable_reason: null,
  };
  const decisions = [{ decision_id: 'D-1', decision: 'Use the deterministic standalone runtime entrypoint.', rationale: 'The passing fixture must be independently executable.', requirement_ids: ['FR-1'] }];
  const tasks = PASSING_TASK_GRAPH.map((task) => ({
    id: task.task_id,
    title: task.title,
    requirement_ids: [...task.requirement_ids],
    acceptance_ids: ['AC-1'],
    decision_ids: ['D-1'],
    verification_ids: ['V-1'],
    depends_on: [...task.depends_on],
    expected_outcome: task.expected_outcome,
    affected_scope: [...task.affected_scope],
    completion_evidence: [...task.completion_evidence],
    parallel_safe: task.parallel_safe,
  }));
  const verification = [{
    verification_id: 'V-1',
    requirement_ids: ['FR-1'],
    acceptance_ids: ['AC-1'],
    task_ids: phase === 'tasks' ? tasks.map((task) => task.id) : [],
    observable_behavior: true,
    expected_evidence: 'Run node src/passing/index.js and record the exact completed JSON output.',
  }];
  const sectionSets: Record<WorkspacePhase, Record<string, string>> = {
    specify: {
      problem: PASSING_SPECIFICATION,
      scope: 'Only src/passing/ is in scope for the deterministic executable outcome.',
      non_goals: 'No unrelated refactors or external state changes.',
      actors: 'The fixture runtime, CTO orchestrator, implementation lead, and QA evidence worker.',
      journeys: 'The selected handoff is validated, claimed, executed, and closed with feature-local evidence.',
      requirements: requirement.statement,
      edge_cases: 'Arguments other than the empty argument list must remain outside the passing path.',
      assumptions: 'The scratch project root and constitution binding remain stable during preparation.',
      dependencies: 'Node.js ESM execution and the canonical specification artifact reader.',
      success_criteria: 'The exact JSON completion line is observable and independently verifiable.',
    },
    plan: {
      repository_grounding: PASSING_PLAN,
      decisions: decisions.map((decision) => `${decision.decision_id}: ${decision.decision} — ${decision.rationale}`).join('\n'),
      alternatives: 'Do not introduce a second execution engine or mutable fixture state.',
      contracts: 'Phase artifacts, validation, handoff, and execution evidence remain feature-local and digest-bound.',
      data_flow: 'Specification -> canonical phase artifacts -> validation -> frozen handoff -> execution evidence.',
      control_flow: 'Validate each phase in order, then admit only the exact frozen handoff.',
      migration: 'No migration is required for this scratch fixture.',
      security: 'Pinned root reads and canonical digests reject stale or cross-feature references.',
      operations: 'The focused node command is the only runtime operation in scope.',
      verification_strategy: verification[0]!.expected_evidence,
      constitution_recheck: 'Every phase keeps the exact constitution binding selected for the run.',
    },
    tasks: {
      task_graph: PASSING_TASKS,
      dependencies: 'T-SCHEMA-VALIDATOR depends on T-LOADER; shared-defaults writes use one serialized path.',
      expected_outcomes: tasks.map((task) => `${task.id}: ${task.expected_outcome}`).join('\n'),
    },
  };
  return {
    schema_version: 1, feature_id: featureId, run_key: runKey, phase, version: 1,
    worker: { role: phase === 'specify' ? 'specification-analyst' : 'specification-architect', agent: 'specification-worker', dispatch_id: dispatchId },
    constitution_binding: binding,
    upstream_versions: upstreamVersions,
    sections: sectionSets[phase],
    requirements: [requirement],
    decisions: phase === 'specify' ? [] : decisions,
    tasks: phase === 'tasks' ? tasks : [],
    verification,
    contradictions: [],
    constitution_principles: principles.map((principle) => ({ principle_id: principle.principle_id, title: principle.title, applicability: 'applicable' as const, status: 'pass' as const, evidence: 'Every change ships with behavioral tests and deterministic verification.', binding })),
  } as unknown as SpecificationSemanticModel;
}

function materializeCanonicalPhaseFixture(root: string, featureId: string, runKey: string, binding: ConstitutionBinding): Map<string, Record<string, unknown>> {
  const templateSet = resolveSpecificationTemplateSet({ template_ids: SHIPPED_SPECIFICATION_TEMPLATE_IDS });
  assert.equal(templateSet.ok, true, templateSet.ok ? '' : templateSet.error);
  if (!templateSet.ok) throw new Error(templateSet.error);
  const templates = new Map(templateSet.value.templates.map((template) => [template.template_id, template]));
  const languageHash = canonicalDigestOf({ language: 'en-US' });
  const templateHash = canonicalDigestOf({ template_set: 'specification-default' });
  const artifacts = new Map<string, Record<string, unknown>>();
  let upstreamVersions: Array<{ artifact_id: string; version: number; hash: string }> = [];
  for (const phase of CANONICAL_PHASE_ORDER) {
    const dispatchId = `fixture-${featureId}-${phase}-dispatch`;
    const model = fixturePhaseModel(phase, featureId, runKey, binding, upstreamVersions, dispatchId, readFileSync(join(root, binding.path), 'utf8'));
    const template = templates.get(phase);
    assert.ok(template, `shipped ${phase} template exists`);
    if (!template) throw new Error(`missing shipped ${phase} template`);
    const documentPath = phase === 'specify' ? 'spec.md' : `${phase}.md`;
    const document = renderCanonicalPhaseDocument(phase, model, template);
    const sourceArtifact = {
      schema_version: 1, feature_id: featureId, run_key: runKey, version: 1,
      worker: model.worker, constitution_binding: binding, semantic_model: model,
      document_sha256: canonicalSha256Hex(document), upstream_versions: upstreamVersions,
    };
    const requestDigest = canonicalDigestOf({ feature_id: featureId, run_key: runKey, phase, version: 1, request_id: `fixture-${featureId}-${phase}-request`, dispatch_id: dispatchId, source_artifact: sourceArtifact, documents: [{ path: documentPath, content: document }], semantic_sections: model.sections, constitution_binding: binding, upstream_versions: upstreamVersions, template_hash: templateHash, language_hash: languageHash });
    const workIdentity = {
      run_id: runKey, wave_id: `fixture-${featureId}-wave`, slice_id: featureId, session_id: `fixture-${featureId}-session`, workflow: 'spec-preparation', stage_id: phase, stage_cursor: phase, capability_id: `fixture-${featureId}-capability`, capability_epoch: `fixture-${featureId}-epoch`, slot_id: phase === 'specify' ? 'specification-analyst' : 'specification-architect', task_id: `fixture-${featureId}-${phase}-task`, dispatch_id: dispatchId, attempt: 1, worker_id: 'specification-worker',
    };
    const artifact: Record<string, unknown> = {
      schema_version: 1, feature_id: featureId, run_key: runKey, request_id: `fixture-${featureId}-${phase}-request`, request_digest: requestDigest, source_artifact_id: phase === 'specify' ? 'specify_draft' : phase === 'plan' ? 'plan_draft' : 'task_graph', source_artifact: sourceArtifact, artifact_id: `${phase}.v1`, phase, version: 1, dispatch_id: dispatchId, work_identity: workIdentity, capability_epoch: workIdentity.capability_epoch, source_artifact_hash: canonicalDigestOf(sourceArtifact), semantic_model: model, document_paths: [documentPath], document_hashes: { [documentPath]: canonicalSha256Hex(document) }, semantic_section_hashes: Object.fromEntries(Object.entries(model.sections).sort(([left], [right]) => left.localeCompare(right)).map(([marker, content]) => [marker, canonicalSha256Hex(content)])), template_hash: templateHash, language_hash: languageHash, upstream_versions: upstreamVersions, created_at: '2026-09-01T00:00:00.000Z', constitution_binding: binding,
    };
    const materialized = materializeFeatureDocuments(root, { feature_id: featureId, run_key: runKey, phase, version: 1, documents: [{ path: documentPath, content: document }], binding: { language_hash: languageHash, template_hash: templateHash, artifact_id: `${phase}.v1`, dispatch_id: dispatchId, work_identity: workIdentity as never, constitution_binding: binding, upstream_versions: upstreamVersions } }, { validateBeforeWrite: () => { const pinned = PinnedProjectRoot.open(root); if (!pinned) throw new Error('fixture root cannot be pinned'); try { const current = readPinnedCurrentConstitution(root, pinned, binding); if (!current.ok) throw new Error(current.error); } finally { pinned.close(); } } });
    assert.ok(materialized.ok, materialized.ok ? '' : materialized.error);
    if (!materialized.ok) throw new Error(materialized.error);
    writeTestArtifact(root, featureArtifactsDir(root, featureId), `${phase}.v1`, artifact);
    const validationInput: NativePhaseValidationInput = { validation_id: `validation.${phase}.v1`, feature_id: featureId, run_key: runKey, phase, version: 1, artifact_version: `${phase}.v1`, document_path: documentPath, document_sha256: canonicalSha256Hex(document), sections: model.sections, upstream_versions: model.upstream_versions, expected_upstream_versions: model.upstream_versions, constitution_binding: binding, expected_constitution_binding: binding, constitution_principles: model.constitution_principles.map((principle) => ({ principle_id: principle.principle_id, status: principle.status, evidence: principle.evidence })), requirements: model.requirements, decisions: model.decisions, tasks: model.tasks.map((task) => ({ ...task, task_id: task.id })), verification: model.verification, contradictions: model.contradictions, validated_at: '2026-09-01T00:00:00.000Z' };
    const validation = { ...validateNativePhase(validationInput), artifact_digest: canonicalDigestOf(artifact) };
    assert.equal(validation.status, 'pass', `${featureId} ${phase}.v1 fixture validation passes: ${JSON.stringify(validation.blocking_findings)}`);
    writeTestArtifact(root, featureArtifactsDir(root, featureId), `validation.${phase}.v1`, validation);
    const projected = materializePhaseValidation(root, featureId, validation, { beforeWrite: () => undefined });
    assert.ok(projected.ok, projected.ok ? '' : projected.error);
    if (!projected.ok) throw new Error(projected.error);
    artifacts.set(phase, artifact);
    upstreamVersions = [...upstreamVersions, { artifact_id: `${phase}.v1`, version: 1, hash: canonicalDigestOf(artifact) }];
  }
  return artifacts;
}

function assertPassingFixture(root: string, featureId: string, handoff: ImplementationHandoff): void {
  const specificationDir = join(root, 'specs', featureId);
  assert.equal(existsSync(join(specificationDir, 'spec.md')), true, `${featureId} canonical spec document exists`);
  assert.equal(existsSync(join(specificationDir, 'plan.md')), true, `${featureId} canonical plan document exists`);
  assert.equal(existsSync(join(specificationDir, 'tasks.md')), true, `${featureId} canonical tasks document exists`);
  assert.equal(readFileSync(join(root, 'src', 'passing', 'index.js'), 'utf8'), PASSING_SOURCE, `${featureId} executable fixture is deterministic`);
  const state = readState(root, featureId);
  assert.equal(typeof state.run_key, 'string');
  const workspace = resolveFeatureWorkspace(root, { feature_id: featureId, run_key: String(state.run_key) });
  assert.ok(workspace.ok, workspace.ok ? '' : workspace.error);
  if (!workspace.ok || !workspace.value.constitution_binding) throw new Error(workspace.ok ? 'passing fixture constitution binding missing' : workspace.error);
  assertCanonicalPhaseFixture(root, featureId, String(state.run_key), workspace.value.constitution_binding);
  for (const artifact of handoff.artifact_versions.filter((entry) => entry.kind === 'specify' || entry.kind === 'plan' || entry.kind === 'tasks')) {
    const parsed = JSON.parse(readFileSync(join(root, '.work-state', 'features', featureId, 'artifacts', `${artifact.artifact_id}.json`), 'utf8')) as Record<string, unknown>;
    assert.equal(artifact.sha256, canonicalDigestOf(parsed), `${artifact.artifact_id} handoff digest is bound to canonical artifact bytes`);
  }
}

function readBoundedProtocolFile(path: string): string | null {
  const parent = pinDirectory(dirname(path));
  if (parent === null) return null;
  try {
    const bytes = readPinnedFileFull(parent, basename(path), MAX_PROTOCOL_LOG_BYTES);
    return bytes?.toString('utf8') ?? null;
  } finally {
    closePinnedDirectory(parent);
  }
}

function readJsonlRecords(path: string): Record<string, unknown>[] {
  const content = readBoundedProtocolFile(path);
  if (content === null) return [];
  const records: Record<string, unknown>[] = [];
  for (const line of content.split('\n')) {
    try {
      const parsed: unknown = JSON.parse(line);
      if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
        records.push(parsed as Record<string, unknown>);
      }
    } catch {
      // A partial final line is not protocol evidence.
    }
  }
  return records;
}

function durableProtocolEvidence(root: string): {
  milestones: DurableProtocolMilestone[];
  deliveredLengths: number[];
} {
  const agentRoot = join(root, '.omp', 'agent');
  const agentEntries = existsSync(agentRoot)
    ? readdirSync(agentRoot, { withFileTypes: true })
      .filter(entry => entry.isFile() && entry.name.endsWith('.jsonl'))
      .sort((left, right) => left.name.localeCompare(right.name))
      .slice(0, MAX_PROTOCOL_LOG_FILES)
    : [];
  const records = agentEntries.flatMap(entry => readJsonlRecords(join(agentRoot, entry.name)));
  const milestones: DurableProtocolMilestone[] = [];
  const recordMilestone = (record: Record<string, unknown>): void => {
    if (record['type'] !== 'custom' || record['customType'] !== 'tool_execution_start') return;
    const data = record['data'];
    if (data === null || typeof data !== 'object' || Array.isArray(data)) return;
    const toolData = data as Record<string, unknown>;
    const intent = typeof toolData['intent'] === 'string' ? toolData['intent'] : '';
    const args = toolData['args'];
    const path = args !== null && typeof args === 'object' && !Array.isArray(args)
      && typeof (args as Record<string, unknown>)['path'] === 'string'
      ? (args as Record<string, unknown>)['path'] as string
      : '';
    const candidates: Array<[DurableProtocolMilestone, string, string]> = [
      ['preflight', 'Preflighting eligible CTO selections', 'xd://cto_preflight'],
      ['mapping_ask', 'Requesting mapping confirmation', 'xd://cto_checkpoint_ask_selected'],
      ['confirm', 'Confirming canonical CTO mapping', 'xd://cto_confirm'],
      ['dispatch', 'Dispatching admitted CTO slices', 'xd://cto_dispatch'],
      ['conformance', 'Persisting terminal conformance', 'xd://cto_specification_conformance'],
      ['close', 'Closing CTO execution wave', 'xd://cto_close_specification_execution_wave'],
    ];
    for (const [milestone, expectedIntent, expectedPath] of candidates) {
      if (intent === expectedIntent || path === expectedPath) {
        milestones.push(milestone);
        return;
      }
    }
  };
  for (const record of records) recordMilestone(record);
  const deliveryRecords = readJsonlRecords(join(root, '.work-state', 'ux-e2e', 'delivery.jsonl'));
  const deliveredLengths = deliveryRecords
    .filter(record => record['status'] === 'delivered' && typeof record['content_length'] === 'number')
    .map(record => record['content_length'] as number);
  return { milestones, deliveredLengths };
}

function assertDurableProtocolEvidence(root: string): void {
  const evidence = durableProtocolEvidence(root);
  const firstIndex = DURABLE_PROTOCOL_MILESTONES.map(milestone => evidence.milestones.indexOf(milestone));
  assert.ok(
    firstIndex.every(index => index >= 0),
    `durable agent JSONL records every protocol milestone: ${DURABLE_PROTOCOL_MILESTONES.filter((_, index) => firstIndex[index] === -1).join(', ')}`,
  );
  assert.ok(
    firstIndex.every((index, position) => position === 0 || index >= firstIndex[position - 1]!),
    'durable agent protocol milestones retain their execution order',
  );
  assert.ok(evidence.deliveredLengths.length >= 2, 'durable delivery JSONL records Ask and answer delivery');
  assert.ok(evidence.deliveredLengths.some(length => length > 1), 'durable delivery JSONL records a non-empty Ask payload');
  assert.ok(evidence.deliveredLengths.some(length => length === 1), 'durable delivery JSONL records the selector answer');
}

function assertTypedConformanceEvidenceTask(handoff: ImplementationHandoff, featureId: string): void {
  const expectedTaskIds = featureId.endsWith('-passing')
    ? PASSING_TASK_GRAPH.map(task => task.task_id)
    : ['T-1'];
  for (const taskId of expectedTaskIds) {
    const task = handoff.tasks.find(candidate => candidate.task_id === taskId);
    assert.ok(task !== undefined, `${featureId} has seeded execution task ${taskId}`);
    if (task === undefined) continue;
    const taskText = JSON.stringify(task);
    assert.match(taskText, /\.work-state\/features\/<feature_id>\/artifacts\/<artifact_id>\.json/iu, `${featureId}/${taskId} requires feature-local canonical artifact storage`);
    assert.match(taskText, /conformance_evidence envelope has exactly schema_version, artifact_id, and entries/iu, `${featureId}/${taskId} states the canonical envelope keys`);
    assert.match(taskText, /do not add top-level provenance/iu, `${featureId}/${taskId} forbids provenance in the canonical envelope`);
    assert.match(taskText, /wraps every submitted evidence entry with an artifact: CompletionArtifactRef/iu, `${featureId}/${taskId} requires wrapper artifact references`);
    assert.match(taskText, /every executed_test entry has test\.evidence_ref: CompletionArtifactRef/iu, `${featureId}/${taskId} requires executed-test artifact references`);
    assert.match(taskText, /lead.*verbatim.*implementation and QA evidence workers/iu, `${featureId}/${taskId} requires evidence guidance handoff`);
  }
}

function persistWorkspace(root: string, workspace: FeatureWorkspace, runKey: string): FeatureWorkspace {
  const current = resolveFeatureWorkspace(root, { feature_id: workspace.feature_id, run_key: runKey });
  assert.ok(current.ok, current.ok ? "" : current.error);
  if (!current.ok) throw new Error(current.error);
  const persisted = persistFeatureWorkspace(root, workspace, undefined, { expected_workspace_digest: canonicalDigestOf(current.value) });
  assert.ok(persisted.ok, persisted.ok ? "" : persisted.error);
  if (!persisted.ok) throw new Error(persisted.error);
  return persisted.value;
}

type CheckpointBlock = AskBlock | SelectedAskBlock;

const CONSTITUTION_SELECTOR_OPTIONS = ['approve_continue', 'request_changes'] as const;
const MAPPING_SELECTOR_OPTIONS = ['approve_continue', 'request_changes', 'approve_stop'] as const;

interface CheckpointIdentityExpectation {
  featureId?: string;
  runKey?: string;
  stageId?: string;
  checkpointId?: string;
  /** Canonical semantic identity, normally the checkpoint_id/checkpoint value. */
  semanticIdentity?: string | RegExp;
}

type ParsedCheckpointIdentity = {
  featureId?: string;
  runKey?: string;
  stageId?: string;
  checkpointId?: string;
  semanticIdentity?: string;
};

const CANONICAL_ID = '[A-Za-z0-9][A-Za-z0-9._-]{0,255}';

function canonicalField(title: string, field: string): string | undefined {
  const pattern = new RegExp(`(?:^|[\\s|])${field}\\s*[:=]\\s*(${CANONICAL_ID})(?!\\s*[:=])(?=$|[\\s|,;)])`, 'igu');
  let value: string | undefined;
  for (const match of title.matchAll(pattern)) value = match[1] ?? value;
  return value;
}

/**
 * Parse only engine-authored key/value identity fields. Prose is deliberately
 * ignored: a feature/run prefix in a human-readable title is not identity.
 */
function parseCheckpointIdentity(title: string): ParsedCheckpointIdentity | null {
  const featureId = canonicalField(title, 'feature_id');
  const runKey = canonicalField(title, 'run_key');
  const stageId = canonicalField(title, 'stage_id');
  const stageCursor = canonicalField(title, 'stage_cursor');
  const checkpointId = canonicalField(title, 'checkpoint_id');
  const checkpointTitle = title.replace(/^\s*(?:selected|compatibility) checkpoint:\s*/iu, '');
  const checkpoint = canonicalField(checkpointTitle, 'checkpoint');
  const semanticIdentity = canonicalField(title, 'semantic_identity')
    ?? canonicalField(title, 'semantic_id');

  // Two spellings are accepted for compatibility, but conflicting values are
  // malformed rather than silently choosing one.
  if (stageId !== undefined && stageCursor !== undefined && stageId !== stageCursor) return null;
  if (checkpointId !== undefined && checkpoint !== undefined && checkpointId !== checkpoint) return null;
  const canonicalCheckpoint = checkpointId ?? checkpoint;
  return {
    ...(featureId === undefined ? {} : { featureId }),
    ...(runKey === undefined ? {} : { runKey }),
    ...((stageId ?? stageCursor) === undefined ? {} : { stageId: stageId ?? stageCursor }),
    ...(canonicalCheckpoint === undefined ? {} : { checkpointId: canonicalCheckpoint }),
    ...(semanticIdentity === undefined && canonicalCheckpoint === undefined
      ? {}
      : { semanticIdentity: semanticIdentity ?? canonicalCheckpoint }),
  };
}

function semanticIdentityMatches(actual: string | undefined, expected: string | RegExp | undefined): boolean {
  if (expected === undefined) return true;
  if (typeof expected === 'string') return actual === expected;
  if (actual === undefined || actual.length === 0) return false;
  const stableFlags = expected.flags.replace(/[gy]/gu, '');
  return new RegExp(expected.source, stableFlags).test(actual);
}


function checkpointIdentityMatches(title: string, expected: CheckpointIdentityExpectation): boolean {
  const actual = parseCheckpointIdentity(title);
  if (actual === null) return false;
  return (expected.featureId === undefined || actual.featureId === expected.featureId)
    && (expected.runKey === undefined || actual.runKey === expected.runKey)
    && (expected.stageId === undefined || actual.stageId === expected.stageId)
    && (expected.checkpointId === undefined || actual.checkpointId === expected.checkpointId)
    && semanticIdentityMatches(actual.semanticIdentity, expected.semanticIdentity);
}

function isSelectedCheckpoint(
  block: SelectedAskBlock,
  expected: readonly string[],
  titlePattern: RegExp,
  identity: CheckpointIdentityExpectation,
): boolean {
  return block.surface === 'selector'
    && titlePattern.test(block.title)
    && checkpointIdentityMatches(block.title, identity)
    && matchesCanonicalSelectorOptions(block.options, expected);
}

function isNativeCheckpoint(
  block: AskBlock,
  pattern: RegExp,
): boolean {
  return block.surface === 'native' && pattern.test(block.title);
}

function candidateIdentity(label: string, identity: CheckpointIdentityExpectation): string {
  const parts = [
    label,
    identity.featureId,
    identity.runKey,
    identity.stageId,
    identity.checkpointId,
    identity.semanticIdentity,
  ].filter((value): value is string => value !== undefined);
  return parts.join(' / ');
}

function sameSelectedCheckpoint(left: SelectedAskBlock, right: SelectedAskBlock): boolean {
  const rightIdentity = parseCheckpointIdentity(right.title);
  return rightIdentity !== null
    && left.index === right.index
    && left.frameStart === right.frameStart
    && left.frameEnd === right.frameEnd
    && left.title === right.title
    && left.selectedIndex === right.selectedIndex
    && left.options.length === right.options.length
    && left.options.every((option, index) => option === right.options[index])
    && checkpointIdentityMatches(left.title, rightIdentity);
}

function recordedCheckpoint(
  log: TranscriptLog,
  checkpoint: CheckpointBlock,
): boolean {
  if (checkpoint.surface === 'selector') {
    return log.selectedAskBlocks().some(candidate => sameSelectedCheckpoint(candidate, checkpoint));
  }
  return log.askBlocks().some(candidate => candidate.index === checkpoint.index
    && candidate.frameStart === checkpoint.frameStart
    && candidate.frameEnd === checkpoint.frameEnd
    && candidate.title === checkpoint.title);
}

async function answerCheckpoint(
  open: OpenSession,
  titlePattern: string,
  answer: string,
  label: string,
  minIndex = 0,
  selectorOptions: readonly string[] = MAPPING_SELECTOR_OPTIONS,
  identity: CheckpointIdentityExpectation = {},
): Promise<CheckpointBlock> {
  const log = new TranscriptLog(open.session.transcriptPath);
  const pattern = new RegExp(titlePattern, 'iu');
  let checkpoint: CheckpointBlock | undefined;
  await waitFor(
    () => {
      // Only pending selector cards are eligible. If any pending card exists,
      // exactly one candidate must match and it must be the latest pending card;
      // answered history and an older card can never steal the input.
      const pendingSelected = log.pendingSelectedAskBlocks().filter(candidate => candidate.index > minIndex);
      const selectedMatches = pendingSelected.filter(candidate =>
        isSelectedCheckpoint(candidate, selectorOptions, pattern, identity),
      );
      if (pendingSelected.length > 0) {
        assert.equal(selectedMatches.length, 1, `${label}: expected exactly one pending canonical selector card for ${candidateIdentity(label, identity)}`);
        assert.equal(
          selectedMatches[0]?.index,
          pendingSelected.at(-1)?.index,
          `${label}: latest pending selector card is not the exact requested identity`,
        );
      }
      const selected = selectedMatches[0];
      if (selected !== undefined) {
        checkpoint = selected;
        return true;
      }
      const nativeMatches = log.askBlocks().filter(candidate =>
        candidate.index > minIndex && isNativeCheckpoint(candidate, pattern) && checkpointIdentityMatches(candidate.title, identity),
      );
      assert.ok(nativeMatches.length <= 1, `${label}: ambiguous native checkpoint cards for ${candidateIdentity(label, identity)}`);
      const native = nativeMatches[0];
      if (native !== undefined) {
        checkpoint = native;
        return true;
      }
      return false;
    },
    { timeoutMs: WAIT_TIMEOUT_MS, intervalMs: 250, label },
  );
  assert.ok(checkpoint !== undefined, `${label}: checkpoint is presented`);
  assert.ok(checkpoint.options.length >= 2, `${label}: checkpoint exposes its decision set`);
  if (checkpoint.surface === 'selector') {
    const desired = selectorOptions[0];
    assert.ok(desired !== undefined, `${label}: selector has a canonical decision`);
    await answerSelectedAsk(open.driver, checkpoint, desired);
  } else {
    await submit(open.driver, answer);
  }
  return checkpoint;
}

function selectedCheckpointCard(input: {
  featureId: string;
  runKey: string;
  stageId: string;
  checkpointId: string;
  selectedIndex?: 0 | 1 | 2;
}): string {
  const selectedIndex = input.selectedIndex ?? 0;
  const options = ['approve_continue', 'request_changes', 'approve_stop'];
  return [
    '╭─ Ask ─────────────────────────╮\n',
    '│ CANONICAL CHECKPOINT PACKET (engine-authored; authoritative) │\n',
    `│ feature_id: ${input.featureId} run_key: ${input.runKey} stage_cursor: ${input.stageId} │\n`,
    `│ checkpoint: ${input.checkpointId} semantic_identity: ${input.checkpointId} │\n`,
    '├──────────────────────────────┤\n',
    ...options.map((option, index) => `│ ${index === selectedIndex ? '❯' : ' '} ○ ${option} │\n`),
    '├──────────────────────────────┤\n',
    '│ Enter select · ↑/↓ move · Esc cancel │\n',
    '╰────────────────────────────────────╯\n',
  ].join('');
}

function outputFrame(data: string): string {
  return JSON.stringify({ ts: '2026-09-11T00:00:00.000Z', t: 'o', d: data }) + '\n';
}

function finalInputFrame(): string {
  return JSON.stringify({
    ts: '2026-09-11T00:00:00.000Z',
    t: 'i',
    d: '\r',
    sequence: 1,
    step_index: 1,
    step_count: 1,
    is_final_submit: true,
  }) + '\n';
}

function fakeOpen(transcriptPath: string, events: string[]): OpenSession {
  const driver = {
    pressEnter: async (): Promise<void> => { events.push('Enter'); },
    pressKey: async (key: 'ArrowUp' | 'ArrowDown'): Promise<void> => { events.push(key); },
  };
  return {
    session: { transcriptPath } as TestSession,
    driver: driver as unknown as WsDriver,
  };
}

test('CTO checkpoint identity parser rejects feature prefix collisions and wrong run/stage', () => {
  const expected = {
    featureId: 'feature-alpha',
    runKey: 'run-alpha-1',
    stageId: 'execution',
    checkpointId: 'cto_mapping_confirmation',
    semanticIdentity: 'cto_mapping_confirmation',
  };
  const exact = 'selected checkpoint: feature_id: feature-alpha run_key: run-alpha-1 stage_id: execution checkpoint_id: cto_mapping_confirmation semantic_identity: cto_mapping_confirmation';
  assert.equal(checkpointIdentityMatches(exact, expected), true, 'the exact canonical card identity matches');
  const regexExpected = {
    ...expected,
    semanticIdentity: /mapping_confirmation/giu,
  };
  assert.equal(checkpointIdentityMatches(exact, regexExpected), true, 'a semantic identity regex matches');
  assert.equal(checkpointIdentityMatches(exact, regexExpected), true, 'global regex matching remains stateless');
  assert.equal(
    checkpointIdentityMatches(exact, { ...expected, semanticIdentity: /constitution|specify/iu }),
    false,
    'an unrelated semantic identity regex cannot match',
  );
  const native = 'selected checkpoint: Canonical constitution approval checkpoint: | feature_id=feature-alpha | run_key=run-alpha-1 | stage_id=execution | checkpoint_id=cto_mapping_confirmation';
  assert.equal(
    checkpointIdentityMatches(native, { ...expected, semanticIdentity: /mapping_confirmation/iu }),
    true,
    'presentation prose does not synthesize checkpoint=Canonical',
  );
  const conflicting = 'feature_id: feature-alpha run_key: run-alpha-1 stage_id: execution checkpoint_id: canonical-one checkpoint: canonical-two semantic_identity: canonical-two';
  assert.equal(
    checkpointIdentityMatches(conflicting, expected),
    false,
    'conflicting canonical checkpoint aliases remain rejected',
  );
  assert.equal(
    checkpointIdentityMatches(exact.replace('feature-alpha', 'feature-alpha-extended'), expected),
    false,
    'a feature-id prefix collision cannot match',
  );
  assert.equal(
    checkpointIdentityMatches(exact.replace('run-alpha-1', 'run-alpha-2'), expected),
    false,
    'a card from another run cannot match',
  );
  assert.equal(
    checkpointIdentityMatches(exact.replace('stage_id: execution', 'stage_id: plan'), expected),
    false,
    'a card from another stage cannot match',
  );
});

test('CTO answerCheckpoint ignores answered history and selects the latest exact pending card', async () => {
  const root = mkdtempSync(join(tmpdir(), 'omp-cto-checkpoint-latest-'));
  const transcriptPath = join(root, 'transcript.jsonl');
  const exact = selectedCheckpointCard({
    featureId: 'feature-alpha',
    runKey: 'run-alpha-1',
    stageId: 'execution',
    checkpointId: 'cto_mapping_confirmation',
    selectedIndex: 0,
  });
  const wrongLatest = selectedCheckpointCard({
    featureId: 'feature-alpha',
    runKey: 'run-alpha-2',
    stageId: 'execution',
    checkpointId: 'cto_mapping_confirmation',
    selectedIndex: 1,
  });
  const events: string[] = [];
  writeFileSync(transcriptPath, outputFrame(exact) + finalInputFrame() + outputFrame(wrongLatest));
  try {
    await assert.rejects(
      answerCheckpoint(
        fakeOpen(transcriptPath, events),
        'mapping',
        '1',
        'latest exact checkpoint',
        0,
        MAPPING_SELECTOR_OPTIONS,
        {
          featureId: 'feature-alpha',
          runKey: 'run-alpha-1',
          stageId: 'execution',
          checkpointId: 'cto_mapping_confirmation',
          semanticIdentity: 'cto_mapping_confirmation',
        },
      ),
      /exactly one pending canonical selector card|latest pending selector card/iu,
      'a newer pending card from another run is rejected before input',
    );
    assert.deepEqual(events, [], 'wrong latest card receives no terminal input');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('CTO answerCheckpoint fails closed on ambiguous exact pending cards before input', async () => {
  const root = mkdtempSync(join(tmpdir(), 'omp-cto-checkpoint-ambiguous-'));
  const transcriptPath = join(root, 'transcript.jsonl');
  const first = selectedCheckpointCard({
    featureId: 'feature-alpha',
    runKey: 'run-alpha-1',
    stageId: 'execution',
    checkpointId: 'cto_mapping_confirmation',
    selectedIndex: 0,
  });
  const second = selectedCheckpointCard({
    featureId: 'feature-alpha',
    runKey: 'run-alpha-1',
    stageId: 'execution',
    checkpointId: 'cto_mapping_confirmation',
    selectedIndex: 1,
  });
  const events: string[] = [];
  writeFileSync(transcriptPath, outputFrame(first) + outputFrame(second));
  try {
    await assert.rejects(
      answerCheckpoint(
        fakeOpen(transcriptPath, events),
        'mapping',
        '1',
        'ambiguous exact checkpoint',
        0,
        MAPPING_SELECTOR_OPTIONS,
        {
          featureId: 'feature-alpha',
          runKey: 'run-alpha-1',
          stageId: 'execution',
          checkpointId: 'cto_mapping_confirmation',
          semanticIdentity: 'cto_mapping_confirmation',
        },
      ),
      /expected exactly one pending canonical selector card/iu,
      'ambiguous cards fail before input',
    );
    assert.deepEqual(events, [], 'ambiguity receives no terminal input');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('CTO answerCheckpoint returns and records the exact selected card identity', async () => {
  const root = mkdtempSync(join(tmpdir(), 'omp-cto-checkpoint-exact-'));
  const transcriptPath = join(root, 'transcript.jsonl');
  const card = selectedCheckpointCard({
    featureId: 'feature-alpha',
    runKey: 'run-alpha-1',
    stageId: 'execution',
    checkpointId: 'cto_mapping_confirmation',
    selectedIndex: 1,
  });
  const events: string[] = [];
  writeFileSync(transcriptPath, outputFrame(card));
  const log = new TranscriptLog(transcriptPath);
  try {
    const checkpoint = await answerCheckpoint(
      fakeOpen(transcriptPath, events),
      'mapping',
      '1',
      'exact checkpoint',
      0,
      MAPPING_SELECTOR_OPTIONS,
      {
        featureId: 'feature-alpha',
        runKey: 'run-alpha-1',
        stageId: 'execution',
        checkpointId: 'cto_mapping_confirmation',
        semanticIdentity: 'cto_mapping_confirmation',
      },
    );
    assert.equal(checkpoint.surface, 'selector');
    assert.deepEqual(events, ['ArrowUp', 'Enter'], 'only the exact card is answered');
    assert.equal(recordedCheckpoint(log, checkpoint), true, 'the answer is bound to the same exact card identity');
    const altered = { ...checkpoint, title: checkpoint.title.replace('run-alpha-1', 'run-alpha-2') };
    assert.equal(recordedCheckpoint(log, altered), false, 'a same-shaped card with another run cannot be counted');
  } finally {
    log.close();
    rmSync(root, { recursive: true, force: true });
  }
});

function scanArtifacts<T>(
  root: string,
  featureId: string | null,
  predicate: (value: Record<string, unknown>) => boolean,
): T[] {
  const dirs: string[] = [];
  const ctoRoot = join(root, '.work-state', 'cto');
  if (existsSync(ctoRoot)) {
    for (const entry of readdirSync(ctoRoot, { withFileTypes: true })) {
      if (entry.isDirectory()) dirs.push(join(ctoRoot, entry.name));
    }
  }
  const featuresRoot = join(root, '.work-state', 'features');
  if (existsSync(featuresRoot)) {
    for (const entry of readdirSync(featuresRoot, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      if (featureId !== null && entry.name !== featureId) continue;
      dirs.push(join(featuresRoot, entry.name, 'artifacts'));
    }
  }
  const found: T[] = [];
  const visit = (dir: string): void => {
    if (!existsSync(dir)) return;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        visit(path);
        continue;
      }
      if (!entry.isFile() || !entry.name.endsWith(".json") || entry.name.startsWith(".")) continue;
      try {
        const value: unknown = JSON.parse(readFileSync(path, "utf8"));
        if (value !== null && typeof value === "object" && predicate(value as Record<string, unknown>)) {
          found.push(value as T);
        }
      } catch {
        // Unparseable bytes are not contract data.
      }
    }
  };
  for (const dir of dirs) visit(dir);
  return found;
}

function readHandoff(root: string, featureId: string): HandoffArtifact {
  const candidates = scanArtifacts<HandoffArtifact>(root, featureId, value => {
    return typeof value['handoff_id'] === 'string'
      && typeof value['handoff_digest'] === 'string'
      && value['handoff_digest'].length === 64;
  });
  const handoff = candidates.at(-1);
  assert.ok(handoff !== undefined, `a frozen handoff artifact exists for ${featureId}`);
  assert.match(handoff.handoff_digest, DIGEST_RE, 'handoff digest is content-addressed SHA-256');
  return handoff;
}

function readClaims(root: string, featureId: string, handoffDigest: string): ClaimArtifact[] {
  const candidates = scanArtifacts<Record<string, unknown>>(root, featureId, value => {
    const claim = value["claim"];
    return (typeof value["claim_id"] === "string" && typeof value["status"] === "string")
      || (claim !== null && typeof claim === "object" && typeof (claim as Record<string, unknown>)["claim_id"] === "string");
  });
  return candidates
    .map(value => {
      const nested = value["claim"];
      return nested !== null && typeof nested === "object" ? nested as ClaimArtifact : value as ClaimArtifact;
    })
    .filter(value => value.handoff_digest === handoffDigest);
}

function ctoClaims(root: string, featureId: string): ClaimArtifact[] {
  const loaded = readExecutionClaimStore(root, featureId);
  assert.ok(loaded.ok, loaded.ok ? '' : loaded.error);
  return loaded.ok ? loaded.value as unknown as ClaimArtifact[] : [];
}

function readMappings(root: string): MappingArtifact[] {
  const ctoRoot = join(root, '.work-state', 'cto');
  const records: MappingRecord[] = [];
  if (existsSync(ctoRoot)) {
    for (const runEntry of readdirSync(ctoRoot, { withFileTypes: true })) {
      if (!runEntry.isDirectory() || runEntry.name.startsWith('.')) continue;
      const mappingDir = join(ctoRoot, runEntry.name, 'specification-mappings');
      if (!existsSync(mappingDir)) continue;
      for (const mappingEntry of readdirSync(mappingDir, { withFileTypes: true })) {
        if (!mappingEntry.isFile() || !mappingEntry.name.endsWith('.json') || mappingEntry.name.startsWith('.')) continue;
        try {
          const value: unknown = JSON.parse(readFileSync(join(mappingDir, mappingEntry.name), 'utf8'));
          if (value === null || typeof value !== 'object') continue;
          const record = value as MappingRecord;
          const nested = record['mapping'];
          const candidate = nested !== null && typeof nested === 'object'
            ? nested as Record<string, unknown>
            : record;
          if (typeof candidate['mapping_id'] === 'string' && Array.isArray(candidate['handoff_bindings'])) {
            records.push(record);
          }
        } catch {
          // Unparseable bytes are not canonical mapping artifacts.
        }
      }
    }
  }
  const unique = new Map<string, MappingArtifact>();
  for (const record of records) {
    const nested = record['mapping'];
    const candidate = nested !== null && typeof nested === 'object' ? nested as MappingArtifact : record as MappingArtifact;
    const identity = `${candidate.mapping_id}\u0000${candidate.mapping_hash ?? ''}`;
    const existing = unique.get(identity);
    if (existing === undefined || (existing.status !== 'confirmed' && candidate.status === 'confirmed')) {
      unique.set(identity, candidate);
    }
  }
  return [...unique.values()];
}

function confirmedMappings(root: string): MappingArtifact[] {
  return readMappings(root).filter(candidate => candidate.status === 'confirmed');
}

test('readMappings: normalizes canonical nested mapping records and ignores mirrors', () => {
  const root = mkdtempSync(join(tmpdir(), 'omp-e2e-mapping-fixture-'));
  try {
    const mappingDir = join(root, '.work-state', 'cto', 'run-001', 'specification-mappings');
    mkdirSync(mappingDir, { recursive: true });
    const mappingRecord = {
      schema_version: 1,
      cto_run_id: 'run-001',
      mapping: {
        mapping_id: 'cto-mapping-fixture',
        mapping_hash: 'a'.repeat(64),
        handoff_bindings: [{ feature_id: 'feature-a', handoff_id: 'handoff-a', handoff_digest: 'b'.repeat(64) }],
        status: 'confirmed',
      },
      checkpoint_ref: 'checkpoint-fixture',
    };
    writeFileSync(join(mappingDir, 'mapping.json'), JSON.stringify(mappingRecord));
    writeFileSync(join(mappingDir, 'mapping-replay.json'), JSON.stringify(mappingRecord));
    const mirrorDir = join(root, '.work-state', 'cto', 'run-001', 'artifacts');
    mkdirSync(mirrorDir, { recursive: true });
    writeFileSync(join(mirrorDir, 'mapping-state-mirror.json'), JSON.stringify(mappingRecord));
    const mappings = readMappings(root);
    assert.equal(mappings.length, 1);
    assert.equal(mappings[0]?.mapping_id, 'cto-mapping-fixture');
    assert.equal(mappings[0]?.status, 'confirmed');
    assert.equal(confirmedMappings(root).length, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});


function readReadinessFindings(root: string): Array<Record<string, unknown> & { status: string }> {
  return scanArtifacts<Record<string, unknown> & { status: string }>(root, null, value => {
    return typeof value['status'] === 'string'
      && ['ready', 'incomplete', 'stale', 'ambiguous', 'blocked'].includes(value['status'])
      && (typeof value['feature_id'] === 'string' || typeof value['affected_workspace'] === 'string');
  });
}

function readConformance(root: string, featureId: string): ConformanceArtifact[] {
  return scanArtifacts<ConformanceArtifact>(root, featureId, value => {
    return typeof value['conformance_id'] === 'string'
      && typeof value['matrix_digest'] === 'string'
      && Array.isArray(value['entries']);
  });
}

type CtoExecutionWaveSnapshot = {
  runId: string;
  wave: {
    id?: unknown;
    source?: unknown;
    status?: unknown;
    outcome?: unknown;
    blocked_feature_ids?: unknown;
    finished_at?: unknown;
  };
  teams: Array<{
    feature_id?: unknown;
    task_id?: unknown;
    slice_id?: unknown;
    work_identity?: { dispatch_id?: unknown };
  }>;
};

function readExecutionWave(root: string): CtoExecutionWaveSnapshot | null {
  const ctoRoot = join(root, '.work-state', 'cto');
  if (!existsSync(ctoRoot)) return null;
  for (const runEntry of readdirSync(ctoRoot, { withFileTypes: true })) {
    if (!runEntry.isDirectory() || runEntry.name.startsWith('.')) continue;
    try {
      const parsed = JSON.parse(readFileSync(join(ctoRoot, runEntry.name, 'state.json'), 'utf8')) as Record<string, unknown>;
      const waves = Array.isArray(parsed['wave_history']) ? parsed['wave_history'] : [];
      const wave = [...waves].reverse().find(candidate =>
        candidate !== null
        && typeof candidate === 'object'
        && (candidate as Record<string, unknown>)['source'] === 'specification-execution',
      );
      if (wave === undefined || wave === null || typeof wave !== 'object') continue;
      return {
        runId: runEntry.name,
        activeWaveId: parsed['active_wave_id'],
        wave: wave as CtoExecutionWaveSnapshot['wave'],
        teams: Array.isArray(parsed['teams']) ? parsed['teams'] as CtoExecutionWaveSnapshot['teams'] : [],
      };
    } catch {
      // The state may be mid-commit; retry through the bounded wait.
    }
  }
  return null;
}

function terminalExecutionWave(root: string): boolean {
  const snapshot = readExecutionWave(root);
  return snapshot !== null
    && snapshot.activeWaveId === undefined
    && snapshot.wave.status === 'done'
    && snapshot.wave.outcome === 'blocked'
    && typeof snapshot.wave.id === 'string'
    && typeof snapshot.wave.finished_at === 'string';
}

function hasTerminalWavePostimage(
  root: string,
  featureIds: readonly string[],
  blockedFeatureIds: readonly string[],
): boolean {
  const confirmed = confirmedMappings(root);
  if (confirmed.length !== 1 || !terminalExecutionWave(root)) return false;
  const mappingFeatures = confirmed[0]?.feature_ids?.slice().sort();
  if (mappingFeatures === undefined || JSON.stringify(mappingFeatures) !== JSON.stringify([...featureIds].slice().sort())) return false;
  const wave = readExecutionWave(root);
  if (wave === null || typeof wave.wave.id !== 'string') return false;
  const blocked = wave.wave.blocked_feature_ids;
  if (!Array.isArray(blocked) || JSON.stringify([...blocked].sort()) !== JSON.stringify([...blockedFeatureIds].sort())) return false;
  const waveTeams = new Set(
    wave.teams
      .filter(team =>
        typeof team.feature_id === 'string'
        && featureIds.includes(team.feature_id)
        && typeof team.work_identity?.dispatch_id === 'string'
        && team.work_identity.dispatch_id.length > 0,
      )
      .map(team => team.feature_id as string),
  );
  if (waveTeams.size !== featureIds.length) return false;
  for (const featureId of featureIds) {
    const claims = ctoClaims(root, featureId);
    if (!claims.some(claim =>
      claim.owner_kind === 'cto'
      && claim.owner_run_id === wave.runId
      && ['active', 'blocked', 'completed'].includes(claim.status)
      && claim.admission_binding?.wave_id === wave.wave.id,
    )) return false;
    const conformance = readConformance(root, featureId).at(-1);
    if (conformance === undefined) return false;
    const allowedConformanceStatuses = blockedFeatureIds.includes(featureId) ? ['blocked', 'changed_intent'] : ['pass'];
    if (!allowedConformanceStatuses.includes(conformance.overall_status)) return false;
    const state = readState(root, featureId);
    if (typeof state.specification?.execution_claim_ref !== 'string'
      || typeof state.specification?.implementation_conformance_ref !== 'string'
      || !['completed', 'claimed', 'executing', 'completion_validating', 'completion_blocked'].includes(workspaceStatus(state))) return false;
  }
  return true;
}

test('terminalExecutionWave: active mapping cannot satisfy terminal postimage', () => {
  const root = mkdtempSync(join(tmpdir(), 'omp-e2e-wave-state-fixture-'));
  try {
    const stateDir = join(root, '.work-state', 'cto', 'run-001');
    mkdirSync(stateDir, { recursive: true });
    const state = {
      active_wave_id: 'wave-001',
      wave_history: [{ id: 'wave-001', source: 'specification-execution', status: 'active' }],
      teams: [],
    };
    writeFileSync(join(stateDir, 'state.json'), JSON.stringify(state));
    assert.equal(terminalExecutionWave(root), false);
    writeFileSync(
      join(stateDir, 'state.json'),
      JSON.stringify({
        ...state,
        active_wave_id: undefined,
        wave_history: [{ id: 'wave-001', source: 'specification-execution', status: 'done', outcome: 'blocked', blocked_feature_ids: ['feature-b'], finished_at: '2026-09-04T00:00:00.000Z' }],
      }),
    );
    assert.equal(terminalExecutionWave(root), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('passing fixture: readable specification refs and executable deliverable are materialized', () => {
  const scratch = makeScratch();
  try {
    const featureId = 'readable-cto-passing';
    const constitutionPath = join(scratch.root, 'CONSTITUTION.md');
    writeFileSync(constitutionPath, VALID_BOOTSTRAP_CONSTITUTION);
    const constitution = ensureProjectConstitution(scratch.root, {
      origin_kind: 'cto_preparation',
      origin_run_key: 'fixture-passing-run',
      origin_stage: 'cto',
    });
    assert.ok(constitution.ok && constitution.value.binding, constitution.ok ? 'fixture constitution binding must be available' : constitution.error);
    if (!constitution.ok || constitution.value.binding === null) throw new Error('fixture constitution prerequisite failed');
    const seeded = seedReadyFeature(scratch, featureId, 'fixture-passing-run', constitution.value.binding);
    assertPassingFixture(scratch.root, featureId, seeded.handoff);
  } finally {
    if (!scratch.exact) rmSync(scratch.parent, { recursive: true, force: true });
  }
});

test('durable protocol evidence survives transcript tail compaction', () => {
  const root = mkdtempSync(join(tmpdir(), 'omp-e2e-protocol-fixture-'));
  try {
    const agentRoot = join(root, '.omp', 'agent');
    const deliveryRoot = join(root, '.work-state', 'ux-e2e');
    mkdirSync(agentRoot, { recursive: true });
    mkdirSync(deliveryRoot, { recursive: true });
    const milestones: Array<{ readonly toolName: string; readonly args: Record<string, string>; readonly intent: string }> = [
      { toolName: 'write', args: { path: 'xd://cto_preflight' }, intent: 'Preflighting eligible CTO selections' },
      { toolName: 'write', args: { path: 'xd://cto_checkpoint_ask_selected' }, intent: 'Requesting mapping confirmation' },
      { toolName: 'write', args: { path: 'xd://cto_confirm' }, intent: 'Confirming canonical CTO mapping' },
      { toolName: 'write', args: { path: 'xd://cto_dispatch' }, intent: 'Dispatching admitted CTO slices' },
      { toolName: 'eval', args: {}, intent: 'Persisting terminal conformance' },
      { toolName: 'eval', args: {}, intent: 'Closing CTO execution wave' },
    ];
    writeFileSync(
      join(agentRoot, '2026-01-01T00-00-00.000Z_fixture.jsonl'),
      `${milestones.map(milestone => JSON.stringify({
        type: 'custom',
        customType: 'tool_execution_start',
        data: milestone,
      })).join('\n')}\n`,
    );
    writeFileSync(
      join(deliveryRoot, 'delivery.jsonl'),
      `${[
        { status: 'delivered', content_length: 805 },
        { status: 'delivered', content_length: 1 },
      ].map(record => JSON.stringify(record)).join('\n')}\n`,
    );
    const transcriptPath = join(deliveryRoot, 'transcript.jsonl');
    const filler = 'x'.repeat(1024);
    const retainedTail = Array.from(
      { length: 12_000 },
      (_, index) => JSON.stringify({ ts: '2026-01-01T00:00:00.000Z', t: 'o', d: `terminal-${index}-${filler}` }),
    );
    writeFileSync(
      transcriptPath,
      `${JSON.stringify({ ts: '2026-01-01T00:00:00.000Z', t: 'o', d: 'preflight mapping dispatch' })}\n${retainedTail.join('\n')}\n`,
    );
    const log = new TranscriptLog(transcriptPath);
    log.refresh();
    const screen = log.frames.filter(frame => frame.t === 'o').map(frame => frame.d).join('\n');
    assert.doesNotMatch(screen, /preflight mapping dispatch/iu, 'bounded PTY retention may evict old output');
    assertDurableProtocolEvidence(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

function approvedVersions(root: string, featureId: string): Record<string, number | null> {
  const state = readState(root, featureId);
  const approved: Record<string, number | null> = {};
  for (const phase of ['specify', 'plan', 'tasks'] as const) {
    approved[phase] = phaseOf(state, phase)?.approved_version ?? null;
  }
  return approved;
}

function snapshotWorkspace(root: string, featureId: string): WorkspaceSnapshot {
  const state = readState(root, featureId);
  assert.equal(workspaceStatus(state), 'implementation_ready', `${featureId} is implementation_ready`);
  return {
    featureId,
    runKey: state.run_key as string,
    approved: approvedVersions(root, featureId),
    handoff: readHandoff(root, featureId),
  };
}

function assertApprovalsUnchanged(root: string, snapshot: WorkspaceSnapshot, label: string): void {
  const { featureId } = snapshot;
  assert.deepEqual(
    approvedVersions(root, featureId),
    snapshot.approved,
    `${label}: ${featureId} approved phase versions are unchanged`,
  );
  assert.deepEqual(
    readHandoff(root, featureId),
    snapshot.handoff,
    `${label}: ${featureId} frozen handoff digest is unchanged`,
  );
  assert.equal(
    readState(root, featureId).run_key,
    snapshot.runKey,
    `${label}: ${featureId} keeps its explicit run identity`,
  );
}

// ---------------------------------------------------------------------------
test('T094 runtime: one confirmed CTO wave executes the eligible passing/blocked pair with per-feature isolation and excluded preflight findings', async () => {
  const scenario = loadScenario(SCENARIO_PATH);
  const param = (key: string): string => {
    const value = scenario.params[key];
    assert.ok(typeof value === 'string' && value.length > 0, 'scenario param ' + key + ' is present');
    if (typeof value !== 'string' || value.length === 0) throw new Error('scenario param ' + key + ' is missing');
    return value;
  };
  const passingId = param('feature_passing');
  const blockedId = param('feature_blocked');
  const staleId = param('feature_stale');
  const claimedId = param('feature_claimed');
  const passingRun = param('run_key');
  const blockedRun = param('run_key_blocked');
  const staleRun = param('run_key_stale');
  const claimedRun = param('run_key_claimed');
  assert.equal(param("parallel_tasks"), "T-AUDIT-LOG,T-METRICS", "scenario names the independent JSON slices");
  assert.equal(param("dependent_tasks"), "T-LOADER->T-SCHEMA-VALIDATOR", "scenario names the loader dependency");
  assert.equal(param("shared_serial_tasks"), "T-SHARED-DEFAULTS-A,T-SHARED-DEFAULTS-B", "scenario names the shared-defaults pair");
  assert.equal(param("expected_admitted_task_count"), String(PASSING_TASK_GRAPH.length + 1), "scenario dispatch count covers passing graph plus blocked task");
  const ctoRequest = (ctoRunId: string): string => `/cto --spec ${passingId} --run-key ${passingRun} --spec ${blockedId} --run-key ${blockedRun} --spec ${staleId} --run-key ${staleRun} --spec ${claimedId} --run-key ${claimedRun} Execute the selected handoffs in one resident CTO wave. Immediately execute the mounted cto_prepare tool by writing its JSON payload to xd://cto_prepare (never read that device or its documentation). The JSON object written to xd://cto_prepare MUST have exactly these four top-level keys and no others: cto_run_id, task, branch, selections. MUST NOT include teams, dod, team_defs, classification, workflow, or any other key. Use cto_run_id=${ctoRunId}, branch=main, and selections exactly equal to the four selector pairs above; use this request text as the task verbatim; do not invent DoD, TeamDef, or other derived fields before that selector-only request. Preserve this exact immutable full selector array in the selector-only cto_prepare request; let the engine derive canonical task, DoD, and TeamDef candidates, obtain the mapping confirmation, and emit the eligible-only preflight descriptor. Keep stale and claimed selectors selected for readiness exclusion, report their blocked findings verbatim, and never claim either excluded selector. Execute the engine-issued eligible-only preflight descriptor without reconstructing selectors or repeating excluded rows. Report blocked findings and complete each admitted worker with real evidence before closing. The blocked handoff intentionally has no concrete observable contract and its src/blocked/** prerequisite is absent; do not invent behavior or repair that fixture. Give its implementation/QA workers one bounded attempt, record the unresolved blocker under FR-1/AC-1, and return one terminal blocked summary without rewriting DoD or re-dispatching repair workers. The admitted passing slices T-AUDIT-LOG and T-METRICS are independent and must dispatch in parallel; T-SCHEMA-VALIDATOR depends on T-LOADER; T-SHARED-DEFAULTS-A and T-SHARED-DEFAULTS-B share src/passing/shared-defaults.json and must serialize. Preserve every original FR-1/AC-1/V-1 task mapping, and require each lead to produce implementation and QA evidence before returning.`;
  const scratch = makeScratch({ allowExact: true });
  let passing!: SeededFeature;
  let blocked!: SeededFeature;
  let stale!: SeededFeature;
  let claimed!: SeededFeature;
  let staleSnapshot!: WorkspaceSnapshot;
  let open: OpenSession | null = null;
  let testFailureObserved = false;
  try {
    // Exercise the public resident-CTO command twice across a process
    // boundary. The first request is held at the native constitution Ask;
    // a fresh session then submits the exact same request once and resumes
    // through the public mapping confirmation Ask.
    open = await openSession(
      scratch.root,
      scenario,
      `Bootstrap the project constitution through the native plugin workflow. The current-user approval checkpoint must be shown in the terminal before any feature execution; after approval, stop and wait for the next command. If the native command reports an unresolved constitution prerequisite, call the mounted ensure_project_constitution tool with exactly feature_id=${CONSTITUTION_BOOTSTRAP_FEATURE_ID}, run_key=${CONSTITUTION_BOOTSTRAP_RUN_KEY}, origin_kind=native_direct, origin_run_key=${CONSTITUTION_BOOTSTRAP_RUN_KEY}, and origin_stage=specify; never substitute another origin or infer a run key.`,
    );
    assertRuntimePluginRegistry(open.session, scratch.root);
    const firstLog = new TranscriptLog(open.session.transcriptPath);
    await submit(open.driver, `/specify --feature ${CONSTITUTION_BOOTSTRAP_FEATURE_ID} Bootstrap the canonical project constitution for the execution wave.`);
    const constitution = await answerCheckpoint(
      open,
      'constitution',
      '1',
      'native constitution approval',
      0,
      CONSTITUTION_SELECTOR_OPTIONS,
      { featureId: CONSTITUTION_BOOTSTRAP_FEATURE_ID, runKey: CONSTITUTION_BOOTSTRAP_RUN_KEY, stageId: 'specify', semanticIdentity: /constitution|specify/iu },
    );
    assert.ok(constitution.options.length >= 2, 'constitution approval is a real public Ask checkpoint');
    await waitFor(
      () => existsSync(join(scratch.root, 'CONSTITUTION.md')),
      { timeoutMs: WAIT_TIMEOUT_MS, intervalMs: 250, label: 'constitution approval materialization' },
    );
    assert.ok(recordedCheckpoint(firstLog, constitution), 'the constitution Ask is recorded in the PTY transcript');
    await closeSession(open);
    open = null;

    // Native bootstrap chooses the approved document binding at runtime; update
    // only the still-admissible fixtures to that exact binding before CTO preflight.
    const gate = readProjectConstitutionGate(scratch.root);
    assert.ok(gate.ok, gate.ok ? "" : gate.error);
    if (!gate.ok || gate.value.binding === null) throw new Error(gate.ok ? "constitution gate has no approved binding" : gate.error);
    removeConstitutionBootstrapWorkspace(scratch.root);
    const binding = gate.value.binding;
    passing = seedReadyFeature(scratch, passingId, passingRun, binding);
    blocked = seedReadyFeature(scratch, blockedId, blockedRun, binding);
    assertPassingFixture(scratch.root, passingId, passing.handoff);
    assertTypedConformanceEvidenceTask(passing.handoff, passingId);
    assertTypedConformanceEvidenceTask(blocked.handoff, blockedId);
    stale = seedReadyFeature(scratch, staleId, staleRun, binding);
    claimed = seedReadyFeature(scratch, claimedId, claimedRun, binding);
    const staleRevision = applyManualEdits(stale.workspace, { feature_id: staleId, phase: 'plan', version: 1, documents: { 'plan.md': { expected_sha256: fixtureSha256('plan.v1'), actual_sha256: fixtureSha256('plan.edited'), matches: false } } }, 'approved Plan changed after handoff');
    assert.ok(staleRevision.stale_artifacts.length > 0);
    staleSnapshot = stale.snapshot;
    assert.equal(persistWorkspace(scratch.root, staleRevision.workspace, staleRun).status, 'stale');
    const live = acquireExecutionClaim(scratch.root, claimedId, { handoff: claimed.handoff, run_key: claimedRun, owner_kind: 'do_work', owner_run_id: 'fixture-do-work-claimed' });
    assert.ok(live.ok, live.ok ? '' : live.error);
    if (!live.ok) throw new Error(live.error);

    open = await openSession(scratch.root, scenario);
    assertRuntimePluginRegistry(open.session, scratch.root);
    const log = new TranscriptLog(open.session.transcriptPath);
    await submit(open.driver, ctoRequest("cto-execution-" + open.session.sessionId));
    const mapping = await answerCheckpoint(
      open,
      'mapping|confirm|execution',
      '1',
      'CTO mapping confirmation',
      0,
      MAPPING_SELECTOR_OPTIONS,
      { stageId: 'execution', semanticIdentity: /mapping|confirm|execution/iu },
    );
    assert.ok(mapping.options.length >= 2, 'mapping confirmation is a real public Ask checkpoint');

    const findings = readReadinessFindings(scratch.root);
    const findingsText = JSON.stringify(findings);
    assert.match(findingsText, new RegExp(staleId, 'u'), 'real preflight findings include the stale selector');
    assert.match(findingsText, new RegExp(claimedId, 'u'), 'real preflight findings include the claimed selector');
    await waitFor(
      () => hasTerminalWavePostimage(scratch.root, [passingId, blockedId], [blockedId]),
      { timeoutMs: WAVE_WINDOW_MS, intervalMs: 250, label: 'public CTO wave terminal postimage' },
    );
    const terminalWave = readExecutionWave(scratch.root);
    assert.equal(terminalWave?.wave.outcome, 'blocked', 'mixed terminal wave reports blocked aggregate outcome');
    assert.deepEqual(terminalWave?.wave.blocked_feature_ids, [blockedId], 'terminal wave reports the blocked feature identity');
    assert.ok(terminalWave !== null, 'terminal CTO wave snapshot is readable');
    const admittedTeams = terminalWave?.teams.filter(team => [passingId, blockedId].includes(String(team.feature_id))) ?? [];
    const expectedAdmittedTaskCount = Number(param('expected_admitted_task_count'));
    assert.ok(Number.isSafeInteger(expectedAdmittedTaskCount) && expectedAdmittedTaskCount > 0, 'scenario declares a bounded admitted task count');
    assert.equal(admittedTeams.length, expectedAdmittedTaskCount, 'terminal CTO teams cover every admitted execution task');
    assertDurableProtocolEvidence(scratch.root);
    assert.equal(ctoClaims(scratch.root, staleId).length, 0, 'stale selector remains a readiness exclusion and is never claimed by the public wave');
    const confirmed = confirmedMappings(scratch.root);
    assert.equal(confirmed.length, 1, 'the public wave emits exactly one confirmed mapping');
    const mappingArtifact = confirmed[0];
    assert.ok(mappingArtifact !== undefined && mappingArtifact.mapping_hash, 'confirmed mapping carries a canonical mapping hash');
    assert.deepEqual(
      mappingArtifact?.feature_ids?.slice().sort(),
      [blockedId, passingId].sort(),
      'the confirmed mapping preserves the two admitted passing and blocked features after engine filtering of the immutable selector request',
    );
    const admittedOwners = mappingArtifact?.task_to_slice?.filter(owner => [passingId, blockedId].includes(String(owner.feature_id))) ?? [];
    assert.equal(admittedOwners.length, expectedAdmittedTaskCount, 'mapping owns exactly the admitted task count');
    const passingOwners = admittedOwners.filter(owner => owner.feature_id === passingId);
    const blockedOwners = admittedOwners.filter(owner => owner.feature_id === blockedId);
    assert.deepEqual(
      passingOwners.map(owner => owner.task_id).sort(),
      PASSING_TASK_GRAPH.map(task => task.task_id).sort(),
      'passing mapping preserves every original task identity',
    );
    assert.deepEqual(blockedOwners.map(owner => owner.task_id), ['T-1'], 'blocked feature remains isolated to its single frozen task');
    for (const owner of admittedOwners) {
      assert.deepEqual(owner.requirement_ids, ['FR-1'], `${owner.feature_id}/${owner.task_id} maps the original requirement`);
      assert.deepEqual(owner.verification_ids, ['V-1'], `${owner.feature_id}/${owner.task_id} maps the original verification`);
      const team = admittedTeams.find(candidate => candidate.feature_id === owner.feature_id && candidate.task_id === owner.task_id && candidate.slice_id === owner.slice_id);
      assert.ok(team !== undefined, `${owner.feature_id}/${owner.task_id} has one canonical terminal team`);
      assert.ok(typeof team?.work_identity?.dispatch_id === 'string' && team.work_identity.dispatch_id.length > 0, `${owner.feature_id}/${owner.task_id} has a durable dispatch id`);
    }
    const decisions = mappingArtifact?.parallelization ?? [];
    const ownersByTask = new Map(admittedOwners.map(owner => [`${owner.feature_id}\u0000${owner.task_id}`, owner]));
    const decisionFor = (featureId: string, taskId: string) => {
      const owner = ownersByTask.get(`${featureId}\u0000${taskId}`);
      assert.ok(owner !== undefined, `mapping contains ${featureId}/${taskId}`);
      const decision = decisions.find(candidate => candidate.slice_id === owner?.slice_id);
      assert.ok(decision !== undefined, `mapping contains a parallelization decision for ${featureId}/${taskId}`);
      return { owner, decision };
    };
    const audit = decisionFor(passingId, 'T-AUDIT-LOG').decision;
    const metrics = decisionFor(passingId, 'T-METRICS').decision;
    assert.equal(audit?.decision, 'parallel', 'independent audit-log slice is parallelized');
    assert.equal(metrics?.decision, 'parallel', 'independent metrics slice is parallelized');
    assert.equal(audit?.worktree, 'separate_worktree');
    assert.equal(metrics?.worktree, 'separate_worktree');
    assert.deepEqual(audit?.depends_on_slice_ids, []);
    assert.deepEqual(metrics?.depends_on_slice_ids, []);
    assert.deepEqual(audit?.shared_contract_ids, []);
    assert.deepEqual(metrics?.shared_contract_ids, []);
    const loader = decisionFor(passingId, 'T-LOADER');
    const validator = decisionFor(passingId, 'T-SCHEMA-VALIDATOR');
    assert.equal(validator.decision?.decision, 'serial', 'schema-validator dependency is serialized');
    assert.equal(validator.decision?.worktree, 'same_branch');
    assert.deepEqual(validator.decision?.depends_on_slice_ids, [loader.owner?.slice_id]);
    assert.deepEqual(loader.decision?.depends_on_slice_ids, []);
    const sharedA = decisionFor(passingId, 'T-SHARED-DEFAULTS-A').decision;
    const sharedB = decisionFor(passingId, 'T-SHARED-DEFAULTS-B').decision;
    assert.equal(sharedA?.decision, 'serial', 'first shared-defaults task is serialized by the shared contract');
    assert.equal(sharedB?.decision, 'serial', 'second shared-defaults task is serialized by the shared contract');
    assert.equal(sharedA?.worktree, 'same_branch');
    assert.equal(sharedB?.worktree, 'same_branch');
    const sharedContractTaskIds = [
      JSON.stringify({ feature_id: passingId, task_id: 'T-SHARED-DEFAULTS-A' }),
      JSON.stringify({ feature_id: passingId, task_id: 'T-SHARED-DEFAULTS-B' }),
    ];
    const sharedContracts = (mappingArtifact?.shared_contracts ?? []).filter(contract =>
      contract.requires_serialization === true
      && sharedContractTaskIds.every(taskId => contract.task_ids?.includes(taskId))
      && /shared-defaults\.json/iu.test(contract.contract ?? ''),
    );
    assert.equal(sharedContracts.length, 1, 'shared-defaults pair has exactly one canonical shared path contract');
    const sharedContractId = sharedContracts[0]?.contract_id;
    assert.ok(typeof sharedContractId === 'string' && sharedContractId.length > 0, 'shared-defaults contract is identified');
    assert.ok(sharedA?.shared_contract_ids?.includes(sharedContractId ?? '') === true, 'first shared-defaults slice binds the shared contract');
    assert.ok(sharedB?.shared_contract_ids?.includes(sharedContractId ?? '') === true, 'second shared-defaults slice binds the shared contract');
    const passingState = readState(scratch.root, passingId);
    const blockedState = readState(scratch.root, blockedId);
    assert.ok(['completed', 'completion_validating', 'completion_blocked'].includes(workspaceStatus(passingState)), `passing worker reached an execution state: ${workspaceStatus(passingState)}`);
    assert.ok(['completion_blocked', 'completed', 'completion_validating', 'claimed', 'executing'].includes(workspaceStatus(blockedState)), `blocked worker reached an execution state: ${workspaceStatus(blockedState)}`);
    const passingConformance = readConformance(scratch.root, passingId).at(-1);
    const blockedConformance = readConformance(scratch.root, blockedId).at(-1);
    assert.ok(passingConformance !== undefined, 'passing worker emits a conformance matrix');
    assert.ok(blockedConformance !== undefined, 'blocked worker emits a conformance matrix');
    assert.equal(passingConformance?.overall_status, 'pass', 'passing worker finalizer emits overall_status pass');
    assert.ok(['blocked', 'changed_intent'].includes(blockedConformance?.overall_status ?? ''), `blocked worker finalizer emits a terminal blocked status: ${blockedConformance?.overall_status}`);
    const passingClaims = ctoClaims(scratch.root, passingId);
    const blockedClaims = ctoClaims(scratch.root, blockedId);
    assert.ok(passingClaims.some(claim => claim.owner_kind === 'cto'), 'passing worker claim is emitted by the CTO owner');
    assert.ok(blockedClaims.some(claim => claim.owner_kind === 'cto'), 'blocked worker claim is emitted by the CTO owner');
    assert.equal(ctoClaims(scratch.root, claimedId).filter(claim => claim.owner_kind === 'cto').length, 0, 'claimed selector remains a readiness exclusion and is never claimed by the public wave');
    assert.equal(ctoClaims(scratch.root, claimedId).filter(claim => claim.owner_kind === 'do_work').length, 1, 'pre-existing do-work claim remains retained for the excluded selector');
    for (const snapshot of [passing.snapshot, blocked.snapshot, staleSnapshot, claimed.snapshot]) {
      assertApprovalsUnchanged(scratch.root, snapshot, 'after public CTO dispatch');
    }
    assert.deepEqual(
      readdirSync(join(scratch.root, '.work-state', 'features')).sort(),
      [blockedId, claimedId, passingId, staleId].sort(),
    );
  } catch (error) {
    testFailureObserved = true;
    throw error;
  } finally {
    let lifecycleFailureObserved = false;
    let lifecycleError: unknown;
    try {
      await closeSession(open);
      const closed = readSessionInfo(scratch.root);
      assert.equal(closed?.status, 'stopped', 'public CTO session closes through the authenticated server lifecycle');
      assert.equal(closed?.ptyExitObserved, true, 'public CTO close observes PTY exit');
      assert.ok(closed?.finishedAt !== null && closed?.finishedAt !== undefined, 'public CTO close emits finished_at');
    } catch (error) {
      lifecycleFailureObserved = true;
      lifecycleError = error;
    }
    if (!scratch.exact) {
      finalizeScratchDirectory(scratch.parent, {
        preserveOnFailure: PRESERVE_ON_FAILURE,
        testFailed: testFailureObserved,
        lifecycleFailed: lifecycleFailureObserved,
      });
    }
    if (!testFailureObserved && lifecycleFailureObserved) throw lifecycleError;
  }
});
