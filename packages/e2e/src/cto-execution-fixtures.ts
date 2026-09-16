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
  mkdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import type { CtoExecutionScenarioSetup } from './scenario.js';

const SETUP_SCHEMA_VERSION = 1;
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
  readonly bindWorkspaceConstitution: CoreCall;
  readonly materializeImplementationHandoff: CoreCall;
  readonly writeArtifactPinned: CoreCall;
  readonly acquireExecutionClaim: CoreCall;
  readonly readExecutionClaimStore: CoreCall;
  readonly applyManualEdits: CoreCall;
  readonly ensureProjectConstitution: CoreCall;
  readonly readProjectConstitutionGate: CoreCall;
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
    bindWorkspaceConstitution: call(workspace['bindWorkspaceConstitution'], 'bindWorkspaceConstitution'),
    materializeImplementationHandoff: call(handoff['materializeImplementationHandoff'], 'materializeImplementationHandoff'),
    writeArtifactPinned: call(core['writeArtifactPinned'], 'writeArtifactPinned'),
    acquireExecutionClaim: call(claims['acquireExecutionClaim'], 'acquireExecutionClaim'),
    readExecutionClaimStore: call(claims['readExecutionClaimStore'], 'readExecutionClaimStore'),
    applyManualEdits: call(workspace['applyManualEdits'], 'applyManualEdits'),
    ensureProjectConstitution: call(prerequisite['ensureProjectConstitution'], 'ensureProjectConstitution'),
    readProjectConstitutionGate: call(prerequisite['readProjectConstitutionGate'], 'readProjectConstitutionGate'),
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
function sha256(value: string): string {
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
  const dir = join(root, 'specs', featureId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'spec.md'), PASSING_SPECIFICATION);
  writeFileSync(join(dir, 'plan.md'), PASSING_PLAN);
  writeFileSync(join(dir, 'tasks.md'), PASSING_TASKS);
  const source = join(root, 'src', 'passing');
  mkdirSync(source, { recursive: true });
  writeFileSync(join(source, 'index.js'), PASSING_SOURCE);
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

function readManifest(api: FixtureApi, root: string): Record<string, unknown> | null {
  const pinned = new api.PinnedProjectRoot(root);
  try {
    if (!pinned.isStable()) throw new Error('scratch root changed while reading CTO fixture manifest');
    if (!existsSync(join(root, MANIFEST_RELATIVE_PATH))) return null;
    const content = new TextDecoder().decode(pinned.readFile(MANIFEST_RELATIVE_PATH, { maxBytes: 1_048_576 }).bytes);
    return record(JSON.parse(content), 'CTO fixture manifest');
  } finally {
    pinned.close();
  }
}
function writeManifest(api: FixtureApi, root: string, manifest: Record<string, unknown>): void {
  const pinned = new api.PinnedProjectRoot(root);
  try {
    pinned.ensureDirectory('.work-state/ux-e2e');
    pinned.writeAtomic(MANIFEST_RELATIVE_PATH, `${JSON.stringify(manifest, null, 2)}\n`);
  } finally {
    pinned.close();
  }
}

function setupDigest(setup: CtoExecutionScenarioSetup): string {
  return sha256(canonicalJson(setup));
}
function setupSelectors(setup: CtoExecutionScenarioSetup): Array<{ feature_id: string; run_key: string }> {
  return setup.selectors.map(selector => ({ feature_id: selector.feature_id, run_key: selector.run_key }));
}
function rootIdentity(root: string): { canonical_path: string; dev: number; ino: number } {
  const canonical = realpathSync(root);
  const stat = lstatSync(canonical);
  return { canonical_path: canonical, dev: stat.dev, ino: stat.ino };
}
function assertSameManifest(actual: Record<string, unknown>, expected: Record<string, unknown>): void {
  if (canonicalJson(actual) !== canonicalJson(expected)) throw new Error('CTO fixture manifest does not match the exact scenario selectors/setup; refusing to mutate existing claims');
}
function existingSetup(api: FixtureApi, root: string, manifest: Record<string, unknown>, expected: Record<string, unknown>): CtoExecutionFixtureResult {
  assertSameManifest(manifest, expected);
  const features: SeededCtoFeature[] = [];
  const gate = resultValue(api.readProjectConstitutionGate(root), 'constitution fixture gate');
  if (gate['status'] !== 'usable' && gate['status'] !== 'approved') throw new Error(`constitution fixture gate is no longer usable: ${String(gate['status'])}`);
  const gateBinding = record(gate['binding'], 'constitution fixture binding');
  const selectors = expected['selectors'];
  if (!Array.isArray(selectors)) throw new Error('CTO fixture manifest selectors are malformed');
  for (const selector of selectors) {
    const pair = record(selector, 'fixture selector');
    const featureId = pair['feature_id'];
    const runKey = pair['run_key'];
    if (typeof featureId !== 'string' || typeof runKey !== 'string') throw new Error('CTO fixture selector is malformed');
    const workspaceResult = resultValue(api.resolveFeatureWorkspace(root, { feature_id: featureId, run_key: runKey }), `${featureId} resolve workspace`);
    const handoffId = `${featureId}.handoff.v1`;
    const handoffPath = join(root, artifactDirectory(featureId), `${handoffId}.json`);
    if (!existsSync(handoffPath)) throw new Error(`${featureId} handoff artifact is missing`);
    const handoffRoot = new api.PinnedProjectRoot(root);
    let handoff: Record<string, unknown>;
    try {
      handoff = record(JSON.parse(new TextDecoder().decode(handoffRoot.readFile(join(artifactDirectory(featureId), `${handoffId}.json`), { maxBytes: 8 * 1024 * 1024 }).bytes)) as unknown, `${featureId} handoff`);
    } finally {
      handoffRoot.close();
    }
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
export async function prepareCtoExecutionFixture(
  root: string,
  setup: CtoExecutionScenarioSetup,
  api?: FixtureApi,
): Promise<CtoExecutionFixtureResult> {
  const runtimeApi = api ?? await loadCtoExecutionFixtureApi(root);
  if (setup.kind !== 'cto-execution' || setup.schema_version !== SETUP_SCHEMA_VERSION) throw new Error('unsupported CTO execution fixture setup');
  const identity = rootIdentity(root);
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
  const prior = readManifest(runtimeApi, root);
  if (prior !== null) return existingSetup(runtimeApi, root, prior, expectedManifest);

  const constitutionPath = join(root, 'CONSTITUTION.md');
  const constitutionRoot = new runtimeApi.PinnedProjectRoot(root);
  try {
    if (existsSync(constitutionPath)) {
      const current = new TextDecoder().decode(constitutionRoot.readFile('CONSTITUTION.md', { maxBytes: 1_048_576 }).bytes);
      if (current !== FIXTURE_CONSTITUTION) throw new Error('CTO fixture refuses to replace an existing constitution document');
    } else {
      constitutionRoot.writeAtomic('CONSTITUTION.md', FIXTURE_CONSTITUTION);
    }
  } finally {
    constitutionRoot.close();
  }
  const gate = resultValue(runtimeApi.ensureProjectConstitution(root, {
    origin_kind: 'native_direct',
    origin_run_key: 'spec-cto-execution-fixture-bootstrap',
    origin_stage: 'specify',
  }), 'constitution fixture bootstrap');
  if (gate['status'] !== 'usable' && gate['status'] !== 'approved') throw new Error(`constitution fixture gate is not usable: ${String(gate['status'])}`);
  if (gate['binding'] === null || gate['binding'] === undefined) throw new Error('constitution fixture gate has no binding');

  const seeded = setupSelectors(setup).map(selector => materializeFeature(runtimeApi, root, selector.feature_id, selector.run_key, gate));
  const staleSpec = setup.stale;
  const stale = seeded.find(feature => feature.feature_id === staleSpec.feature_id && feature.run_key === staleSpec.run_key);
  if (!stale) throw new Error('stale fixture selector is not in the exact selector set');
  const staleResult = record(runtimeApi.applyManualEdits(stale.workspace, {
    feature_id: stale.feature_id,
    phase: staleSpec.phase,
    version: staleSpec.version,
    documents: { 'plan.md': { expected_sha256: staleSpec.expected_sha256, actual_sha256: staleSpec.actual_sha256, matches: false } },
  }, staleSpec.reason), 'stale fixture revision');
  result(runtimeApi.persistFeatureWorkspace(root, staleResult['workspace'], undefined, { expected_workspace_digest: digest(runtimeApi, stale.workspace, 'stale workspace') }), 'stale fixture persistence');

  const claimed = seeded.find(feature => feature.feature_id === setup.claimed.feature_id && feature.run_key === setup.claimed.run_key);
  if (!claimed) throw new Error('claimed fixture selector is not in the exact selector set');
  result(runtimeApi.acquireExecutionClaim(root, claimed.feature_id, {
    handoff: claimed.handoff,
    run_key: claimed.run_key,
    owner_kind: setup.claimed.owner_kind,
    owner_run_id: setup.claimed.owner_run_id,
  }), 'do_work fixture claim');

  writeManifest(runtimeApi, root, expectedManifest);
  return { manifest: expectedManifest, features: seeded };
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
