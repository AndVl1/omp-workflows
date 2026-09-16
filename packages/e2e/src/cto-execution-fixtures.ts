/**
 * Internal, deterministic fixture setup for the selector-only CTO scenario.
 *
 * This module deliberately uses the core production APIs through a runtime
 * adapter. The e2e package is shipped independently from core, while the
 * scratch project created by `bootstrap` is already wired to the exact core
 * package that OMP will load. No hand-authored state envelopes or public
 * fixture command are introduced here.
 */

import { createHash } from 'node:crypto';
import {
  existsSync,
  lstatSync,
  readFileSync,
  realpathSync,
} from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import type { CtoExecutionScenarioSetup } from './scenario.js';
import { UX_E2E_BOOTSTRAP_PROVENANCE_PATH } from './runtime.js';
import { closePinnedDirectory, closePinnedDirectoryCreationReceipts, pinChildDirectory, pinDirectory, pinnedDirectoryIsStable, readPinnedFileFull, withPinnedExclusiveLockAsync, writePinnedFile, type PinnedDirectory, type PinnedDirectoryCreationReceipt } from './fs-safety.js';
import { parseFullstackActivationMarker } from '@andvl1/omp-workflows-fullstack/activation-marker';

const SETUP_SCHEMA_VERSION = 1;
const SAFE_FEATURE_ID_RE = /^[a-z0-9][a-z0-9._-]{0,127}$/u;
const SAFE_RUN_KEY_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const CTO_FIXTURE_LOCK = '.cto-execution-fixture.lock';
const MANIFEST_RELATIVE_PATH = '.work-state/ux-e2e/cto-execution-fixture.json';
const ARTIFACTS_RELATIVE_PREFIX = '.work-state/features';
const FIXTURE_CONSTITUTION = [
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
  '- Expected outcome: the verified shared-defaults replace the baseline only after T-SHARED-DEFAULTS-A.',
  '',
].join('\n');
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

export interface CtoExecutionTask {
  readonly task_id: string;
  readonly title: string;
  readonly requirement_ids: readonly string[];
  readonly depends_on: readonly string[];
  readonly expected_outcome: string;
  readonly affected_scope: readonly string[];
  readonly completion_evidence: readonly string[];
  readonly parallel_safe: boolean;
}

export const PASSING_TASK_GRAPH: readonly CtoExecutionTask[] = [
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
    expected_outcome: 'The verified shared-defaults replace the baseline only after T-SHARED-DEFAULTS-A.',
    affected_scope: ['src/passing/shared-defaults.json'],
    completion_evidence: ['Record verified shared-defaults evidence bound to FR-1 and the shared path.'],
    parallel_safe: true,
  },
];

export interface SeededCtoFeature {
  readonly feature_id: string;
  readonly run_key: string;
  readonly handoff: Record<string, unknown>;
  readonly workspace: Record<string, unknown>;
}

export interface CtoExecutionFixtureResult {
  readonly manifest: Record<string, unknown>;
  readonly features: readonly SeededCtoFeature[];
}

type CoreCall = (...args: readonly unknown[]) => unknown;
type FixtureApi = {
  readonly createFeatureWorkspace: CoreCall;
  readonly persistFeatureWorkspace: CoreCall;
  readonly resolveFeatureWorkspace: CoreCall;
  readonly materializeImplementationHandoff: CoreCall;
  readonly writeArtifactPinned: CoreCall;
  readonly acquireExecutionClaim: CoreCall;
  readonly readExecutionClaimStore: CoreCall;
  readonly applyManualEdits: CoreCall;
  readonly ensureProjectConstitution: CoreCall;
  readonly readProjectConstitutionGate: CoreCall;
  readonly resolveCurrentConstitutionBinding: CoreCall;
  readonly readPinnedCurrentConstitution: CoreCall;
  readonly canonicalHandoffDigest: CoreCall;
  readonly digestOf: CoreCall;
  readonly loadProfile: CoreCall;
  readonly profileHash: CoreCall;
  readonly PinnedProjectRoot: new (root: string) => {
    readonly canonical_root: string;
    readonly dev: number;
    readonly ino: number;
    readonly isStable: () => boolean;
    readonly ensureDirectory: (relativePath: string) => void;
    readonly writeAtomic: (relativePath: string, content: string) => void;
    readonly readFile: (relativePath: string, options: { maxBytes: number }) => { readonly bytes: Uint8Array };
    readonly close: () => void;
  };
};

function call(value: unknown, label: string): CoreCall {
  if (typeof value !== 'function') throw new Error(`CTO fixture core API is missing ${label}`);
  return value as CoreCall;
}

function guardFixtureApi(api: FixtureApi, pinned: PinnedDirectory): FixtureApi {
  return new Proxy(api, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver);
      if (property === 'PinnedProjectRoot' || typeof value !== 'function') return value;
      return (...args: readonly unknown[]) => {
        if (!pinnedDirectoryIsStable(pinned)) throw new Error(`CTO fixture scratch root changed before ${String(property)}`);
        const returned = value(...args);
        if (!pinnedDirectoryIsStable(pinned)) throw new Error(`CTO fixture scratch root changed after ${String(property)}`);
        return returned;
      };
    },
  });
}

async function importCoreModule(packageRoot: string, relativePath: string): Promise<Record<string, unknown>> {
  const path = join(packageRoot, 'dist', relativePath);
  if (!existsSync(path)) throw new Error(`CTO fixture core module is not built: ${path}`);
  // The path is intentionally resolved from the scratch project's linked core; a static import could load a different global installation.
  return (await import(pathToFileURL(path).href)) as Record<string, unknown>;
}

/** Resolve only the core package already linked into this scratch project. */
export async function loadCtoExecutionFixtureApi(scratchDir: string): Promise<FixtureApi> {
  const link = join(scratchDir, 'node_modules', '@andvl1', 'omp-workflows-core');
  let packageRoot: string;
  try {
    const stat = lstatSync(link);
    if (!stat.isSymbolicLink()) throw new Error('core package link is not a symlink');
    packageRoot = realpathSync(link);
  } catch (error) {
    throw new Error(`CTO fixture requires bootstrap-wired core package: ${error instanceof Error ? error.message : String(error)}`);
  }
  try {
    const packageJson = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8')) as { name?: unknown; version?: unknown };
    if (packageJson.name !== '@andvl1/omp-workflows-core' || packageJson.version !== '0.27.0') throw new Error('linked package identity/version mismatch');
    const expectedCore = realpathSync(resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', 'core'));
    if (packageRoot !== expectedCore) throw new Error('scratch core symlink does not target the current E2E workspace core package');
  } catch (error) {
    throw new Error(`CTO fixture core package identity could not be verified: ${error instanceof Error ? error.message : String(error)}`);
  }
  const [core, claims, handoff, workspace, prerequisite, profile, validation] = await Promise.all([
    importCoreModule(packageRoot, 'index.js'),
    importCoreModule(packageRoot, 'specification/claims.js'),
    importCoreModule(packageRoot, 'specification/handoff.js'),
    importCoreModule(packageRoot, 'specification/workspace.js'),
    importCoreModule(packageRoot, 'specification/prerequisite.js'),
    importCoreModule(packageRoot, 'engine/profile.js'),
    importCoreModule(packageRoot, 'specification/validation.js'),
  ]);
  if (typeof core['PinnedProjectRoot'] !== 'function') throw new Error('CTO fixture core API is missing PinnedProjectRoot');
  return {
    createFeatureWorkspace: call(workspace['createFeatureWorkspace'], 'createFeatureWorkspace'),
    persistFeatureWorkspace: call(workspace['persistFeatureWorkspace'], 'persistFeatureWorkspace'),
    resolveFeatureWorkspace: call(workspace['resolveFeatureWorkspace'], 'resolveFeatureWorkspace'),
    materializeImplementationHandoff: call(handoff['materializeImplementationHandoff'], 'materializeImplementationHandoff'),
    writeArtifactPinned: call(core['writeArtifactPinned'], 'writeArtifactPinned'),
    acquireExecutionClaim: call(claims['acquireExecutionClaim'], 'acquireExecutionClaim'),
    readExecutionClaimStore: call(claims['readExecutionClaimStore'], 'readExecutionClaimStore'),
    applyManualEdits: call(workspace['applyManualEdits'], 'applyManualEdits'),
    ensureProjectConstitution: call(prerequisite['ensureProjectConstitution'], 'ensureProjectConstitution'),
    readProjectConstitutionGate: call(prerequisite['readProjectConstitutionGate'], 'readProjectConstitutionGate'),
    resolveCurrentConstitutionBinding: call(prerequisite['resolveCurrentConstitutionBinding'], 'resolveCurrentConstitutionBinding'),
    readPinnedCurrentConstitution: call((await importCoreModule(packageRoot, 'specification/constitution-identities.js'))['readPinnedCurrentConstitution'], 'readPinnedCurrentConstitution'),
    canonicalHandoffDigest: call(handoff['canonicalHandoffDigest'], 'canonicalHandoffDigest'),
    digestOf: call(validation['digestOf'], 'digestOf'),
    loadProfile: call(profile['loadProfile'], 'loadProfile'),
    profileHash: call(profile['profileHash'], 'profileHash'),
    PinnedProjectRoot: core['PinnedProjectRoot'] as FixtureApi['PinnedProjectRoot'],
  };
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} is not an object`);
  return value as Record<string, unknown>;
}
function result(value: unknown, label: string): Record<string, unknown> {
  const candidate = record(value, label);
  if (candidate['ok'] !== true) throw new Error(`${label} failed: ${String(candidate['error'] ?? 'unknown error')}`);
  return candidate;
}
function resultValue(value: unknown, label: string): Record<string, unknown> {
  const candidate = result(value, label);
  return record(candidate['value'], `${label}.value`);
}
function digest(api: FixtureApi, value: unknown, label: string): string {
  const result = api.digestOf(value);
  if (typeof result !== 'string' || !/^[0-9a-f]{64}$/u.test(result)) throw new Error(`${label} did not produce a SHA-256 digest`);
  return result;
}
function sha256(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}
function canonicalJson(value: unknown): string {
  const encoded = JSON.stringify(value);
  if (encoded === undefined) throw new Error('fixture value cannot be serialized');
  return encoded;
}
function clone<T>(value: T): T {
  return structuredClone(value);
}
function phaseVersionHash(handoff: Record<string, unknown>, phase: string): string {
  const artifacts = handoff['artifact_versions'];
  if (!Array.isArray(artifacts)) throw new Error('handoff artifact_versions is missing');
  const artifact = artifacts.find(item => {
    const candidate = record(item, 'artifact version');
    return candidate['artifact_id'] === `${phase}.v1`;
  });
  const hash = record(artifact, `${phase}.v1`)['sha256'];
  if (typeof hash !== 'string') throw new Error(`${phase}.v1 has no hash`);
  return hash;
}

function baseHandoff(featureId: string, binding: Record<string, unknown>): Record<string, unknown> {
  const handoff: Record<string, unknown> = {
    schema_version: 1,
    handoff_id: `${featureId}.handoff.v1`,
    handoff_digest: '0'.repeat(64),
    feature_id: featureId,
    source_kind: 'native',
    artifact_versions: [
      { artifact_id: 'specify.v1', kind: 'specify', version: 1, sha256: sha256('specify.v1') },
      { artifact_id: 'plan.v1', kind: 'plan', version: 1, sha256: sha256('plan.v1') },
      { artifact_id: 'tasks.v1', kind: 'tasks', version: 1, sha256: sha256('tasks.v1') },
    ],
    scope: { in_scope: ['the requested outcome'], out_of_scope: ['unrelated refactors'], constraints: ['same-branch serialized ownership'] },
    requirements: [{ requirement_id: 'FR-1', statement: 'The tool completes the requested outcome.', acceptance_ids: ['AC-1'], source_refs: [`specs/${featureId}/spec.md#requirements`] }],
    decisions: [{ decision_id: 'D-1', decision: 'Use the existing durable engine for state.', rationale: 'One engine; no second state machine.', requirement_ids: ['FR-1'] }],
    tasks: [{ task_id: 'T-1', title: 'Implement the outcome', requirement_ids: ['FR-1'], depends_on: [], expected_outcome: 'The requested outcome is observable.', affected_scope: ['src/feature.ts'], completion_evidence: ['focused test run proving the outcome'], parallel_safe: false }],
    verification: [{ verification_id: 'V-1', requirement_ids: ['FR-1'], acceptance_ids: ['AC-1'], task_ids: ['T-1'], observable_behavior: true, expected_evidence: 'executed runtime evidence for the observable behavior' }],
    validation_refs: ['validation.specify.v1', 'validation.plan.v1', 'validation.tasks.v1'],
    approval_refs: ['checkpoint.specify.v1', 'checkpoint.plan.v1', 'checkpoint.tasks.v1'],
    language: 'en-US',
    constitution_binding: clone(binding),
    constitution_impact_ref: null,
    risks: [],
    open_decisions: [],
    execution_choices: ['do-work'],
    status: 'ready',
    import_snapshot_ref: null,
    compatibility_supplement_ref: null,
    import_framework: 'generic',
    import_mapping_id: 'generic-requirements-plan-tasks',
    import_mapping_version: '1',
    import_selected_paths: ['requirements.md'],
    import_ignored_candidates: [],
    import_intake_paths: ['external-source'],
    import_document_language: 'und',
    import_document_language_source: 'unknown',
    import_source_revision: null,
  };
  return handoff;
}

function passingHandoff(featureId: string, binding: Record<string, unknown>, api: FixtureApi): Record<string, unknown> {
  const handoff = baseHandoff(featureId, binding);
  const graph = PASSING_TASK_GRAPH.map(task => ({
    ...task,
    requirement_ids: [...task.requirement_ids],
    depends_on: [...task.depends_on],
    affected_scope: [...task.affected_scope],
    completion_evidence: [
      'Run node src/passing/index.js and record exit code 0 plus the exact JSON output.',
      ...task.completion_evidence,
      'Persist the canonical conformance_evidence envelope at .work-state/features/<feature_id>/artifacts/<artifact_id>.json and reference that exact feature-local path; do not use a team-level .work-state/artifacts mirror.',
      'Canonical conformance_evidence envelope has exactly schema_version, artifact_id, and entries; do not add top-level provenance.',
      'The CTO conformance call wraps every submitted evidence entry with an artifact: CompletionArtifactRef, and every executed_test entry has test.evidence_ref: CompletionArtifactRef.',
      'Pass this evidence contract verbatim from the lead to both implementation and QA evidence workers.',
    ],
  }));
  handoff['tasks'] = graph;
  handoff['scope'] = { in_scope: ['src/passing/**'], out_of_scope: ['unrelated refactors'], constraints: [] };
  handoff['requirements'] = [{ requirement_id: 'FR-1', statement: 'Running node src/passing/index.js with no arguments exits with code 0 and emits exactly {"status":"completed","outcome":"requested outcome completed"} followed by a newline.', acceptance_ids: ['AC-1'], source_refs: [`specs/${featureId}/spec.md#requirements`] }];
  handoff['artifact_versions'] = (handoff['artifact_versions'] as Array<Record<string, unknown>>).map(artifact => ({
    ...artifact,
    sha256: artifact['kind'] === 'specify' ? sha256(PASSING_SPECIFICATION) : artifact['kind'] === 'plan' ? sha256(PASSING_PLAN) : artifact['kind'] === 'tasks' ? sha256(PASSING_TASKS) : artifact['sha256'],
  }));
  handoff['verification'] = [{ verification_id: 'V-1', requirement_ids: ['FR-1'], acceptance_ids: ['AC-1'], task_ids: graph.map(task => task.task_id), observable_behavior: true, expected_evidence: 'Run node src/passing/index.js; record exit code 0 and the exact JSON output. The lead passes the exact conformance_evidence envelope schema guidance to implementation and QA evidence workers; the CTO conformance call wraps every entry with CompletionArtifactRef and every executed_test has test.evidence_ref: CompletionArtifactRef.' }];
  handoff['execution_choices'] = ['do-work', 'cto'];
  handoff['handoff_digest'] = api.canonicalHandoffDigest(handoff);
  return handoff;
}

function adaptFeatureHandoff(featureId: string, binding: Record<string, unknown>, api: FixtureApi): Record<string, unknown> {
  const handoff = baseHandoff(featureId, binding);
  const isPassing = featureId.endsWith('-passing');
  const isBlocked = featureId.endsWith('-blocked');
  if (isPassing) return passingHandoff(featureId, binding, api);
  if (isBlocked) {
    handoff['scope'] = { in_scope: ['src/blocked/**'], out_of_scope: ['unrelated refactors'], constraints: ['same-branch serialized ownership'] };
    const tasks = handoff['tasks'] as Array<Record<string, unknown>>;
    handoff['tasks'] = tasks.map(task => ({
      ...task,
      title: 'Implement the outcome and produce typed conformance evidence',
      expected_outcome: 'The requested outcome is observable, and the lead passes the typed evidence contract verbatim to implementation and QA evidence workers.',
      completion_evidence: [
        'focused test run proving the outcome',
        'Persist the canonical conformance_evidence envelope at .work-state/features/<feature_id>/artifacts/<artifact_id>.json and reference that exact feature-local path; do not use a team-level .work-state/artifacts mirror.',
        'Canonical conformance_evidence envelope has exactly schema_version, artifact_id, and entries; do not add top-level provenance.',
        'The CTO conformance call wraps every submitted evidence entry with an artifact: CompletionArtifactRef, and every executed_test entry has test.evidence_ref: CompletionArtifactRef.',
        'Pass this evidence contract verbatim from the lead to both implementation and QA evidence workers.',
      ],
    }));
    handoff['verification'] = [{ verification_id: 'V-1', requirement_ids: ['FR-1'], acceptance_ids: ['AC-1'], task_ids: ['T-1'], observable_behavior: true, expected_evidence: 'The lead passes the exact conformance_evidence envelope schema guidance to implementation and QA evidence workers; the CTO conformance call wraps every entry with CompletionArtifactRef and every executed_test has test.evidence_ref: CompletionArtifactRef.' }];
  }
  handoff['handoff_digest'] = api.canonicalHandoffDigest(handoff);
  return handoff;
}

function materializePassing(root: string, featureId: string): void {
  const pinned = pinDirectory(root);
  if (pinned === null) throw new Error('passing fixture root could not be pinned safely');
  const created: PinnedDirectoryCreationReceipt[] = [];
  try {
    const specs = pinChildDirectory(pinned, ['specs', featureId], created);
    const source = pinChildDirectory(pinned, ['src', 'passing'], created);
    if (specs === null || source === null || !pinnedDirectoryIsStable(pinned)) {
      throw new Error('passing fixture descendants are not stable regular directories');
    }
    for (const [directory, name, content] of [
      [specs, 'spec.md', PASSING_SPECIFICATION],
      [specs, 'plan.md', PASSING_PLAN],
      [specs, 'tasks.md', PASSING_TASKS],
      [source, 'index.js', PASSING_SOURCE],
    ] as const) {
      if (!writePinnedFile(directory, name, Buffer.from(content, 'utf8'), { replaceExisting: false })) {
        throw new Error(`failed to publish passing fixture file ${name}`);
      }
    }
    if (!pinnedDirectoryIsStable(pinned)) throw new Error('scratch root changed while publishing passing fixture');
  } finally {
    closePinnedDirectoryCreationReceipts(created);
    closePinnedDirectory(pinned);
  }
}

function approvedWorkspace(created: Record<string, unknown>, handoff: Record<string, unknown>): Record<string, unknown> {
  const phases = created['phases'];
  if (!Array.isArray(phases)) throw new Error('created workspace has no phases');
  const phaseRecords = phases.map(phase => {
    const source = record(phase, 'workspace phase');
    const phaseName = source['phase'];
    if (phaseName !== 'specify' && phaseName !== 'plan' && phaseName !== 'tasks') throw new Error(`unknown workspace phase ${String(phaseName)}`);
    const upstream_versions = phaseName === 'specify'
      ? []
      : phaseName === 'plan'
        ? [{ phase: 'specify', version: 1, hash: phaseVersionHash(handoff, 'specify') }]
        : [
            { phase: 'specify', version: 1, hash: phaseVersionHash(handoff, 'specify') },
            { phase: 'plan', version: 1, hash: phaseVersionHash(handoff, 'plan') },
          ];
    return { ...source, status: 'approved', current_version: 1, approved_version: 1, validation_ref: `validation.${String(phaseName)}.v1`, checkpoint_ref: `checkpoint.${String(phaseName)}.v1`, upstream_versions, stale_reason: null, last_feedback: null };
  });
  return {
    ...created,
    phases: phaseRecords,
    status: 'implementation_ready',
    handoff_ref: handoff['handoff_id'],
    execution_claim_ref: null,
    implementation_conformance_ref: null,
    next_action: { kind: 'command', command: `/do-work --spec ${String(created['feature_id'])}`, reason: 'all approved artifacts are ready for an executor' },
  };
}

function workspaceFor(api: FixtureApi, root: string, featureId: string, runKey: string, gate: Record<string, unknown>, handoff: Record<string, unknown>): Record<string, unknown> {
  const profile = api.loadProfile('spec-preparation');
  if (profile === null || profile === undefined) throw new Error('spec-preparation profile is unavailable');
  const profileHash = api.profileHash(profile);
  const created = resultValue(api.createFeatureWorkspace(root, {
    feature_id: featureId,
    display_name: featureId,
    run_key: runKey,
    profile_name: 'spec-preparation',
    profile_hash: profileHash,
    constitution_binding: gate['binding'],
    constitution_gate_ref: gate['gate_id'],
  }), `${featureId} create workspace`);
  const candidate = approvedWorkspace(created, handoff);
  const persisted = resultValue(api.persistFeatureWorkspace(root, candidate, undefined, { expected_workspace_digest: digest(api, created, `${featureId} created workspace`) }), `${featureId} persist workspace`);
  return persisted;
}

function artifactDirectory(featureId: string): string {
  return join(ARTIFACTS_RELATIVE_PREFIX, featureId, 'artifacts', 'implementation_handoff');
}

function materializeFeature(api: FixtureApi, root: string, featureId: string, runKey: string, gate: Record<string, unknown>): SeededCtoFeature {
  if (featureId.endsWith('-passing')) materializePassing(root, featureId);
  const handoff = adaptFeatureHandoff(featureId, record(gate['binding'], 'constitution binding'), api);
  const pinned = new api.PinnedProjectRoot(root);
  try {
    api.writeArtifactPinned(pinned, artifactDirectory(featureId), String(handoff['handoff_id']), handoff);
    result(api.materializeImplementationHandoff(root, handoff, {
      beforeWrite: () => {
        const guard = new api.PinnedProjectRoot(root);
        try {
          const checked = record(api.readPinnedCurrentConstitution(root, guard, handoff['constitution_binding']), 'constitution binding check');
          if (checked['ok'] !== true) throw new Error(String(checked['error'] ?? 'current constitution binding is not usable'));
        } finally {
          guard.close();
        }
      },
    }), `${featureId} materialize handoff`);
  } finally {
    pinned.close();
  }
  const workspace = workspaceFor(api, root, featureId, runKey, gate, handoff);
  return { feature_id: featureId, run_key: runKey, handoff, workspace };
}

function readManifest(pinned: PinnedDirectory): Record<string, unknown> | null {
  if (!pinnedDirectoryIsStable(pinned)) throw new Error('scratch root changed while reading CTO fixture manifest');
  const bytes = readPinnedDescendant(pinned, MANIFEST_RELATIVE_PATH.split('/'), 1_048_576);
  if (bytes === null) return null;
  return record(JSON.parse(new TextDecoder().decode(bytes)), 'CTO fixture manifest');
}
function writeManifest(pinned: PinnedDirectory, manifest: Record<string, unknown>): void {
  if (!pinnedDirectoryIsStable(pinned)) throw new Error('CTO fixture scratch root changed before manifest commit');
  const created: PinnedDirectoryCreationReceipt[] = [];
  const parent = pinChildDirectory(pinned, ['.work-state', 'ux-e2e'], created);
  if (parent === null) {
    closePinnedDirectoryCreationReceipts(created);
    throw new Error('CTO fixture manifest parent is not a stable regular directory');
  }
  try {
    const content = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
    if (!writePinnedFile(parent, 'cto-execution-fixture.json', content, { replaceExisting: false })) {
      throw new Error('CTO fixture manifest already exists or could not be published atomically');
    }
    if (!pinnedDirectoryIsStable(pinned)) throw new Error('CTO fixture scratch root changed after manifest commit');
  } finally {
    closePinnedDirectory(parent);
    closePinnedDirectoryCreationReceipts(created);
  }
}

function setupDigest(setup: CtoExecutionScenarioSetup): string {
  return sha256(canonicalJson(setup));
}

function assertSafeFixtureSelector(featureId: unknown, runKey: unknown, label: string): asserts featureId is string {
  if (typeof featureId !== 'string' || !SAFE_FEATURE_ID_RE.test(featureId)) {
    throw new Error(`${label} feature_id is unsafe`);
  }
  if (typeof runKey !== 'string' || !SAFE_RUN_KEY_RE.test(runKey)) {
    throw new Error(`${label} run_key is unsafe`);
  }
}

function pinExistingDescendant(root: PinnedDirectory, components: readonly string[]): PinnedDirectory | null {
  if (components.length === 0 || !pinnedDirectoryIsStable(root)) return null;
  let path = root.physicalPath;
  for (const component of components) {
    path = join(path, component);
    let stat;
    try { stat = lstatSync(path); } catch { return null; }
    if (stat.isSymbolicLink() || !stat.isDirectory()) return null;
  }
  return pinDirectory(path);
}

function readPinnedDescendant(root: PinnedDirectory, components: readonly string[], maxBytes: number): Buffer | null {
  if (components.length === 0) return null;
  if (components.length === 1) return readPinnedFileFull(root, components[0]!, maxBytes);
  const parent = pinExistingDescendant(root, components.slice(0, -1));
  if (parent === null) return null;
  try {
    return readPinnedFileFull(parent, components[components.length - 1]!, maxBytes);
  } finally {
    closePinnedDirectory(parent);
  }
}

function assertBootstrapProvenance(root: string, identity: { canonical_path: string; dev: number; ino: number }, retained?: PinnedDirectory): void {
  const pinned = retained ?? pinDirectory(root);
  const ownsPin = retained === undefined;
  if (pinned === null) throw new Error('CTO fixture scratch root could not be pinned for bootstrap provenance');
  try {
    if (pinned.identity.dev !== identity.dev || pinned.identity.ino !== identity.ino) throw new Error('CTO fixture scratch root changed while authenticating bootstrap provenance');
    const provenanceBytes = readPinnedDescendant(pinned, UX_E2E_BOOTSTRAP_PROVENANCE_PATH.split('/'), 64 * 1024);
    if (provenanceBytes === null) throw new Error('CTO fixture requires bootstrap provenance');
    const provenance = record(JSON.parse(new TextDecoder().decode(provenanceBytes)), 'bootstrap provenance');
    const expectedKeys = ['schema_version', 'kind', 'canonical_root', 'root_basename', 'slug', 'branch', 'monorepo_root', 'core_target', 'nonce'];
    const keys = Object.keys(provenance);
    if (keys.length !== expectedKeys.length || keys.some((key, index) => key !== expectedKeys[index])) throw new Error('bootstrap provenance keys are not exact');
    if (provenance['schema_version'] !== 1 || provenance['kind'] !== 'ux-e2e-bootstrap'
      || provenance['canonical_root'] !== identity.canonical_path || provenance['root_basename'] !== basename(identity.canonical_path)
      || typeof provenance['slug'] !== 'string' || !/^[a-z0-9][a-z0-9-]*$/u.test(provenance['slug'])
      || typeof provenance['branch'] !== 'string' || provenance['branch'].length === 0 || /[\u0000\r\n]/u.test(provenance['branch'])
      || typeof provenance['nonce'] !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u.test(provenance['nonce'])) {
      throw new Error('bootstrap provenance identity is invalid');
    }
    const packageBytes = readPinnedFileFull(pinned, 'package.json', 64 * 1024);
    if (packageBytes === null) throw new Error('bootstrap package manifest is missing');
    const packageManifest = record(JSON.parse(new TextDecoder().decode(packageBytes)), 'bootstrap package manifest');
    if (packageManifest['private'] !== true || packageManifest['name'] !== `omp-ux-e2e-${provenance['slug']}`) throw new Error('bootstrap package identity is not private and harness-owned');
    const headBytes = readPinnedDescendant(pinned, ['.git', 'HEAD'], 4096);
    if (headBytes === null) throw new Error('bootstrap git HEAD is missing');
    const head = new TextDecoder().decode(headBytes).trim();
    if (head !== `ref: refs/heads/${provenance['branch']}`) throw new Error('bootstrap git branch does not match provenance');
    const monorepo = resolve(realpathSync(resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')));
    const expectedCore = resolve(realpathSync(resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', 'core')));
    if (provenance['monorepo_root'] !== monorepo || provenance['core_target'] !== expectedCore) throw new Error('bootstrap provenance package target drifted');
  } catch (error) {
    if (error instanceof Error && /CTO fixture|bootstrap/u.test(error.message)) throw error;
    throw new Error(`CTO fixture bootstrap provenance is invalid: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    if (ownsPin) closePinnedDirectory(pinned);
  }
}

function assertSetupPreflight(setup: CtoExecutionScenarioSetup): void {
  if (setup === null || typeof setup !== 'object' || setup.kind !== 'cto-execution' || setup.schema_version !== SETUP_SCHEMA_VERSION) {
    throw new Error('unsupported CTO execution fixture setup');
  }
  if (!Array.isArray(setup.selectors) || setup.selectors.length !== 4) {
    throw new Error('CTO fixture requires exactly four selectors');
  }
  const selectors = setup.selectors as readonly unknown[];
  const features = new Set<string>();
  const pairs = new Set<string>();
  for (const [index, raw] of selectors.entries()) {
    const selector = record(raw, `CTO fixture selector ${index}`);
    const featureId = selector['feature_id'];
    const runKey = selector['run_key'];
    assertSafeFixtureSelector(featureId, runKey, `CTO fixture selector ${index}`);
    if (features.has(featureId)) throw new Error(`CTO fixture feature_id is duplicated: ${featureId}`);
    features.add(featureId);
    const pair = `${featureId}\u0000${runKey}`;
    if (pairs.has(pair)) throw new Error(`CTO fixture selector is duplicated: ${featureId}/${runKey}`);
    pairs.add(pair);
  }
  const stale = record(setup.stale, 'CTO fixture stale selector');
  const claimed = record(setup.claimed, 'CTO fixture claimed selector');
  assertSafeFixtureSelector(stale['feature_id'], stale['run_key'], 'CTO fixture stale selector');
  assertSafeFixtureSelector(claimed['feature_id'], claimed['run_key'], 'CTO fixture claimed selector');
  const stalePair = `${stale['feature_id']}\u0000${stale['run_key']}`;
  const claimedPair = `${claimed['feature_id']}\u0000${claimed['run_key']}`;
  if (!pairs.has(stalePair)) throw new Error('CTO fixture stale selector is not an exact member of selectors');
  if (!pairs.has(claimedPair)) throw new Error('CTO fixture claimed selector is not an exact member of selectors');
  if (stalePair === claimedPair) throw new Error('CTO fixture stale and claimed selectors must be distinct');
  if (stale['phase'] !== 'plan' || stale['version'] !== 1) throw new Error('CTO fixture stale revision must target plan v1');
  if (typeof stale['expected_sha256'] !== 'string' || !/^[a-f0-9]{64}$/u.test(stale['expected_sha256'])) throw new Error('CTO fixture stale expected_sha256 is invalid');
  if (typeof stale['actual_sha256'] !== 'string' || !/^[a-f0-9]{64}$/u.test(stale['actual_sha256'])) throw new Error('CTO fixture stale actual_sha256 is invalid');
  if (typeof stale['reason'] !== 'string' || stale['reason'].length === 0) throw new Error('CTO fixture stale reason is invalid');
  if (claimed['owner_kind'] !== 'do_work' || typeof claimed['owner_run_id'] !== 'string' || claimed['owner_run_id'].length === 0) throw new Error('CTO fixture claimed owner is invalid');
}

function existingDescendant(root: PinnedDirectory, components: readonly string[]): boolean {
  if (!pinnedDirectoryIsStable(root) || components.length === 0) return false;
  let current = root.physicalPath;
  for (const component of components) {
    current = join(current, component);
    let stat;
    try { stat = lstatSync(current); } catch { return false; }
    if (stat.isSymbolicLink()) throw new Error(`CTO fixture refuses a symlinked existing path: ${components.join('/')}`);
    if (component !== components[components.length - 1] && !stat.isDirectory()) return false;
  }
  return true;
}

function assertNoPartialFixtureState(root: string, setup: CtoExecutionScenarioSetup, pinned: PinnedDirectory): void {
  if (existingDescendant(pinned, MANIFEST_RELATIVE_PATH.split('/'))) return;
  if (existingDescendant(pinned, ['.work-state', 'specification', 'constitution', 'gate.json'])) throw new Error('CTO fixture refuses to continue over an existing constitution gate without its manifest');
  for (const selector of setup.selectors) {
    const featureRoot = existingDescendant(pinned, [ARTIFACTS_RELATIVE_PREFIX, selector.feature_id]);
    const specRoot = existingDescendant(pinned, ['specs', selector.feature_id]);
    if (featureRoot || specRoot) throw new Error(`CTO fixture refuses to continue over partial state for ${selector.feature_id}`);
  }
  if (existingDescendant(pinned, ['CONSTITUTION.md'])) {
    const bytes = readPinnedFileFull(pinned, 'CONSTITUTION.md', 1_048_576);
    if (bytes === null || bytes.toString('utf8') !== FIXTURE_CONSTITUTION) throw new Error('CTO fixture refuses to replace an existing constitution document');
  }
}
function setupSelectors(setup: CtoExecutionScenarioSetup): Array<{ feature_id: string; run_key: string }> {
  return setup.selectors.map(selector => ({ feature_id: selector.feature_id, run_key: selector.run_key }));
}
function normalizeDarwinTmpAlias(path: string): string {
  if (process.platform === 'darwin' && (path === '/tmp' || path.startsWith('/tmp/'))) return `/private${path}`;
  return path;
}

function rootIdentity(root: string): { canonical_path: string; dev: number; ino: number } {
  const lexical = resolve(root);
  const canonical = resolve(realpathSync(lexical));
  if (normalizeDarwinTmpAlias(lexical) !== normalizeDarwinTmpAlias(canonical)) {
    throw new Error('CTO fixture scratch root must not have a symlinked ancestor or root');
  }
  const stat = lstatSync(canonical);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('CTO fixture scratch root is not a regular directory');
  const pinned = pinDirectory(canonical);
  if (pinned === null) throw new Error('CTO fixture scratch root could not be pinned safely');
  try {
    const omp = pinExistingDescendant(pinned, ['.omp']);
    if (omp === null) throw new Error('CTO fixture bootstrap marker parent is not a stable regular directory');
    try {
      const marker = readPinnedFileFull(omp, 'fullstack.activation.json', 4096);
      if (marker === null || parseFullstackActivationMarker(marker) === null) throw new Error('CTO fixture requires the authenticated fullstack bootstrap marker');
    } finally {
      closePinnedDirectory(omp);
    }
  } finally {
    closePinnedDirectory(pinned);
  }
  return { canonical_path: canonical, dev: stat.dev, ino: stat.ino };
}
function assertSameManifest(actual: Record<string, unknown>, expected: Record<string, unknown>): void {
  if (canonicalJson(actual) !== canonicalJson(expected)) throw new Error('CTO fixture manifest does not match the exact scenario selectors/setup; refusing to mutate existing claims');
}
function existingSetup(api: FixtureApi, root: string, manifest: Record<string, unknown>, expected: Record<string, unknown>, pinned: PinnedDirectory): CtoExecutionFixtureResult {
  assertSameManifest(manifest, expected);
  const features: SeededCtoFeature[] = [];
  const gate = resultValue(api.readProjectConstitutionGate(root), 'constitution fixture gate');
  if (gate['status'] !== 'usable' && gate['status'] !== 'approved') throw new Error(`constitution fixture gate is no longer usable: ${String(gate['status'])}`);
  const gateBinding = record(gate['binding'], 'constitution fixture binding');
  if (gateBinding['path'] !== 'CONSTITUTION.md' || typeof gateBinding['content_sha256'] !== 'string' || !/^[a-f0-9]{64}$/u.test(gateBinding['content_sha256'])) {
    throw new Error('constitution fixture gate binding path or digest is invalid');
  }
  const source = readPinnedFileFull(pinned, 'CONSTITUTION.md', 1_048_576);
  if (source === null || sha256(source) !== gateBinding['content_sha256']) throw new Error('current constitution source/binding drifted after setup');
  const evidencePath = `.work-state/specification/constitution/validation-${gateBinding['content_sha256']}.json`;
  if (!existingDescendant(pinned, evidencePath.split('/'))) throw new Error('constitution fixture usability evidence is missing; refusing restart writes');
  const currentBinding = resultValue(api.resolveCurrentConstitutionBinding(root, { explicit_path: gateBinding['path'] }), 'current constitution binding');
  if (canonicalJson(currentBinding) !== canonicalJson(gateBinding)) throw new Error('current constitution source/binding drifted after setup');
  const selectors = expected['selectors'];
  if (!Array.isArray(selectors)) throw new Error('CTO fixture manifest selectors are malformed');
  for (const selector of selectors) {
    const pair = record(selector, 'fixture selector');
    const featureId = pair['feature_id'];
    const runKey = pair['run_key'];
    if (typeof featureId !== 'string' || typeof runKey !== 'string') throw new Error('CTO fixture selector is malformed');
    const workspaceResult = resultValue(api.resolveFeatureWorkspace(root, { feature_id: featureId, run_key: runKey }, undefined, { persistMigration: false }), `${featureId} resolve workspace`);
    const handoffId = `${featureId}.handoff.v1`;
    const handoffBytes = readPinnedDescendant(pinned, [...artifactDirectory(featureId).split('/'), `${handoffId}.json`], 8 * 1024 * 1024);
    if (handoffBytes === null) throw new Error(`${featureId} handoff artifact is missing`);
    const handoff = record(JSON.parse(new TextDecoder().decode(handoffBytes)) as unknown, `${featureId} handoff`);
    const handoffDigest = handoff['handoff_digest'];
    if (typeof handoffDigest !== 'string') throw new Error(`${featureId} handoff digest is missing`);
    if (canonicalJson(handoff['constitution_binding']) !== canonicalJson(gateBinding)) throw new Error(`${featureId} handoff constitution binding changed after setup`);
    const canonicalDigest = api.canonicalHandoffDigest(handoff);
    if (canonicalDigest !== handoffDigest) throw new Error(`${featureId} handoff digest changed after setup`);
    const phases = workspaceResult['phases'];
    if (!Array.isArray(phases)) throw new Error(`${featureId} workspace phases are missing after setup`);
    if (featureId === String(expected['stale'] && record(expected['stale'], 'stale manifest')['feature_id'])) {
      const plan = phases.find(item => record(item, 'workspace phase')['phase'] === 'plan');
      const planRecord = record(plan, `${featureId} plan phase`);
      if (planRecord['status'] !== 'stale' || planRecord['stale_reason'] !== record(expected['stale'], 'stale manifest')['reason']) throw new Error(`${featureId} stale revision was not preserved on restart`);
    }
    if (featureId === String(expected['claimed'] && record(expected['claimed'], 'claimed manifest')['feature_id'])) {
      const claimSpec = record(expected['claimed'], 'claimed manifest');
      const claimResult = result(api.readExecutionClaimStore(root, featureId), `${featureId} claim store`);
      const claims = claimResult['value'];
      if (!Array.isArray(claims)) throw new Error(`${featureId} claim store is malformed after setup`);
      const owned = claims.filter(item => {
        const claim = record(item, `${featureId} claim`);
        return claim['handoff_digest'] === handoffDigest && claim['owner_kind'] === claimSpec['owner_kind'] && claim['owner_run_id'] === claimSpec['owner_run_id'] && claim['status'] === 'active';
      });
      if (owned.length !== 1) throw new Error(`${featureId} exact do_work claim was not preserved on restart`);
    }
    features.push({ feature_id: featureId, run_key: runKey, handoff, workspace: workspaceResult });
  }
  return { manifest, features };
}

/**
 * Materialize the exact four-workspace selector fixture before OMP starts.
 * Re-running with the same root/setup is a read-only verification; a changed
 * selector/setup or partial conflicting state fails closed.
 */
async function prepareCtoExecutionFixtureUnlocked(
  root: string,
  setup: CtoExecutionScenarioSetup,
  runtimeApi: FixtureApi,
  pinned: PinnedDirectory,
): Promise<CtoExecutionFixtureResult> {
  assertNoPartialFixtureState(root, setup, pinned);
  if (!pinnedDirectoryIsStable(pinned)) throw new Error('CTO fixture scratch root changed before setup');
  const api = guardFixtureApi(runtimeApi, pinned);
  const identity = { canonical_path: pinned.physicalPath, dev: pinned.identity.dev, ino: pinned.identity.ino };
  const expectedManifest: Record<string, unknown> = {
    schema_version: SETUP_SCHEMA_VERSION,
    kind: setup.kind,
    scenario_id: 'spec-cto-execution',
    project_root_identity: identity,
    setup_sha256: setupDigest(setup),
    selectors: setupSelectors(setup),
    stale: setup.stale,
    claimed: setup.claimed,
  };
  const prior = readManifest(pinned);
  if (prior !== null) return existingSetup(api, root, prior, expectedManifest, pinned);

  const constitutionRoot = new api.PinnedProjectRoot(root);
  try {
    if (!existingDescendant(pinned, ['CONSTITUTION.md'])) {
      constitutionRoot.writeAtomic('CONSTITUTION.md', FIXTURE_CONSTITUTION);
    }
  } finally {
    constitutionRoot.close();
  }
  const gate = resultValue(api.ensureProjectConstitution(root, {
    origin_kind: 'native_direct',
    origin_run_key: 'spec-cto-execution-fixture-bootstrap',
    origin_stage: 'specify',
  }), 'constitution fixture bootstrap');
  if (gate['status'] !== 'usable' && gate['status'] !== 'approved') throw new Error(`constitution fixture gate is not usable: ${String(gate['status'])}`);
  if (gate['binding'] === null || gate['binding'] === undefined) throw new Error('constitution fixture gate has no binding');

  const seeded = setupSelectors(setup).map(selector => materializeFeature(api, root, selector.feature_id, selector.run_key, gate));
  const staleSpec = setup.stale;
  const stale = seeded.find(feature => feature.feature_id === staleSpec.feature_id && feature.run_key === staleSpec.run_key);
  if (!stale) throw new Error('stale fixture selector is not in the exact selector set');
  const staleResult = record(api.applyManualEdits(stale.workspace, {
    feature_id: stale.feature_id,
    phase: staleSpec.phase,
    version: staleSpec.version,
    documents: { 'plan.md': { expected_sha256: staleSpec.expected_sha256, actual_sha256: staleSpec.actual_sha256, matches: false } },
  }, staleSpec.reason), 'stale fixture revision');
  result(api.persistFeatureWorkspace(root, staleResult['workspace'], undefined, { expected_workspace_digest: digest(api, stale.workspace, 'stale workspace') }), 'stale fixture persistence');

  const claimed = seeded.find(feature => feature.feature_id === setup.claimed.feature_id && feature.run_key === setup.claimed.run_key);
  if (!claimed) throw new Error('claimed fixture selector is not in the exact selector set');
  result(api.acquireExecutionClaim(root, claimed.feature_id, {
    handoff: claimed.handoff,
    run_key: claimed.run_key,
    owner_kind: setup.claimed.owner_kind,
    owner_run_id: setup.claimed.owner_run_id,
  }), 'do_work fixture claim');

  writeManifest(pinned, expectedManifest);
  return { manifest: expectedManifest, features: seeded };
}

export async function prepareCtoExecutionFixture(
  root: string,
  setup: CtoExecutionScenarioSetup,
  api?: FixtureApi,
): Promise<CtoExecutionFixtureResult> {
  // Validate all caller-controlled selectors before creating a lock or joining any selector path.
  assertSetupPreflight(setup);
  const identity = rootIdentity(root);
  const pinned = pinDirectory(identity.canonical_path);
  if (pinned === null) throw new Error('CTO fixture scratch root could not be pinned safely');
  try {
    assertBootstrapProvenance(identity.canonical_path, identity, pinned);
    return await withPinnedExclusiveLockAsync(pinned, CTO_FIXTURE_LOCK, async () => {
      const runtimeApi = api ?? await loadCtoExecutionFixtureApi(identity.canonical_path);
      return prepareCtoExecutionFixtureUnlocked(identity.canonical_path, setup, runtimeApi, pinned);
    }, 10_000);
  } finally {
    closePinnedDirectory(pinned);
  }
}

export function fixtureConstitutionContent(): string {
  return FIXTURE_CONSTITUTION;
}
export function fixturePassingSpecification(): string {
  return PASSING_SPECIFICATION;
}
export function fixturePassingPlan(): string {
  return PASSING_PLAN;
}
export function fixturePassingTasks(): string {
  return PASSING_TASKS;
}
export function fixturePassingSource(): string {
  return PASSING_SOURCE;
}
export function fixtureManifestPath(): string {
  return MANIFEST_RELATIVE_PATH;
}
