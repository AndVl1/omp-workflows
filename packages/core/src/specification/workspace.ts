import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync, realpathSync, statSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { MAX_PERSISTED_STATE_BYTES, parseBoundedPersistedState, resolveActiveBranch, rollbackStateMutationReceipts, updateStateAtomically, type StateMutationReceipt } from "../engine/state.js";
import { PinnedProjectRoot, PinnedRootError, rollbackPinnedRootWriteReceipt, type PinnedRootPathEntryInfo, type PinnedRootWriteHooks, type PinnedRootWriteReceipt } from "./pinned-root.js";
import { loadProfile, profileHash } from "../engine/profile.js";
import { resolveConfig } from "../engine/config.js";
import { resolveScope, type ScopeFlags } from "../engine/scope.js";
import { withCtoRunLock } from "../cto/transaction-lock.js";
import type { Profile } from "../engine/types.js";
import type { ConstitutionArtifactImpactResult, ConstitutionBinding, ConstitutionGateRecord, ConstitutionGateStatus, FeatureWorkspace, ImplementationHandoff, LanguageSelection, ProjectRootIdentity, TemplateSelection, WorkspaceNextAction, WorkspacePathBinding, WorkspacePathIdentity, WorkspacePhase, WorkspacePhaseRecord } from "./types.js";
import type { TeamState } from "../engine/types.js";
export type { WorkspacePathBinding } from "./types.js";
import { canonicalJson, digestOf, isRecord, isSafeFeatureId, isSha256Hex, nextActionForWorkspace, sha256Hex, normalizeFeatureWorkspaceV1, normalizeFeatureWorkspaceV2, isSafeCanonicalToken, validateConstitutionBinding, validateFeatureWorkspaceRecord, validateWorkspacePathBinding } from "./validation.js";
import { readPinnedCurrentConstitution } from "./constitution-identities.js";

export const SPECIFICATION_WORKSPACE_ROOT = "specs";
export const SPECIFICATION_STATE_ROOT = ".work-state/features";
export function featureWorkspaceDir(projectRoot: string, featureId: string): string { return join(projectRoot, SPECIFICATION_WORKSPACE_ROOT, featureId); }
export function featureStateDir(projectRoot: string, featureId: string): string { return join(projectRoot, SPECIFICATION_STATE_ROOT, featureId); }
export function featureStatePath(projectRoot: string, featureId: string): string { return join(featureStateDir(projectRoot, featureId), "state.json"); }
export function featureArtifactsDir(projectRoot: string, featureId: string): string { return join(featureStateDir(projectRoot, featureId), "artifacts"); }
export function assertSafeFeatureId(featureId: unknown): string { if (!isSafeFeatureId(featureId)) throw new Error(`unsafe feature id ${JSON.stringify(featureId)}: must match ^[a-z0-9][a-z0-9._-]*$ (1..128 chars)`); return featureId; }

export type WorkspaceResultCode = "SPEC_PATH_UNAUTHORIZED" | "SPEC_SELECTOR_REQUIRED" | "SPEC_FEATURE_UNKNOWN" | "SPEC_FEATURE_CONFLICT" | "SPEC_STATE_UNREADABLE" | "SPEC_STATE_INVALID" | "SPEC_RUN_MISMATCH" | "SPEC_IDENTITY_IMMUTABLE" | "SPEC_MIGRATION_BLOCKED" | "SPEC_MIGRATION_REQUIRED";
export type WorkspaceResult<T> = { ok: true; value: T; receipts?: readonly StateMutationReceipt[] } | { ok: false; code: WorkspaceResultCode; error: string };
interface WorkspaceStateEnvelope { schema: 1; run_key: string; specification: FeatureWorkspace; [key: string]: unknown; }
function envelope(workspace: FeatureWorkspace, runKey: string): WorkspaceStateEnvelope { return { schema: 1, run_key: runKey, specification: workspace }; }
function migrationEnvelope(workspace: FeatureWorkspace, runKey: string, receiptId: string, updatedAt: string, profile: Profile, branch: string, scope: ScopeFlags): TeamState {
  const firstUnapprovedPhase = workspace.phases.find((phase) => phase.status !== "approved")?.phase ?? profile.stages[0]?.id ?? "";
  const firstStageIndex = Math.max(0, profile.stages.findIndex((stage) => stage.id === firstUnapprovedPhase));
  return {
    schema: 1,
    branch,
    classification: { type: "SPEC", complexity: "MEDIUM", confidence: "HIGH", autonomous: false, workflow: "spec-preparation" },
    task: `Resume migrated specification ${workspace.feature_id}`,
    workflow_override: false,
    issue: null,
    stage_cursor: profile.stages[firstStageIndex]?.id ?? "",
    stages: profile.stages.map((stage, index) => ({ id: stage.id, status: index < firstStageIndex ? "done" as const : index === firstStageIndex ? "in_progress" as const : "pending" as const })),
    artifacts: {},
    pause: { kind: "none", reason: "" },
    updated_at: updatedAt,
    policy: { strict_orchestrator: true },
    scope,
    profile_hash: profileHash(profile),
    run_key: runKey,
    specification: workspace,
  };
}
export function stateCarriesSpecification(record: unknown): boolean { return isRecord(record) && record.specification !== undefined && record.specification !== null; }
const UNSAFE_PERSISTED_KEYS = new Set(["__proto__", "prototype", "constructor"]);
export function hasUnsafePersistedShape(value: unknown): boolean {
  const pending: unknown[] = [value];
  const seen = new WeakSet<object>();
  while (pending.length > 0) {
    const current = pending.pop();
    if (current === null || typeof current !== "object") continue;
    if (seen.has(current)) return true;
    seen.add(current);
    const prototype = Object.getPrototypeOf(current);
    if (Array.isArray(current)
      ? prototype !== Array.prototype && prototype !== null
      : prototype !== Object.prototype && prototype !== null) return true;
    for (const key of Object.getOwnPropertyNames(current)) {
      if (UNSAFE_PERSISTED_KEYS.has(key)) return true;
      const descriptor = Object.getOwnPropertyDescriptor(current, key);
      if (!descriptor || !("value" in descriptor)) return true;
      pending.push(descriptor.value);
    }
  }
  return false;
}
function readEnvelopePinned(snapshot: WorkspaceRootSnapshot, path: string): WorkspaceStateEnvelope | null {
  let raw: string;
  try {
    const relativePath = snapshot.pinned_root.relativePath(path);
    if (!relativePath) throw new Error("workspace state path escapes the pinned project root");
    if (!snapshot.pinned_root.pathEntryExists(relativePath)) return null;
    raw = new TextDecoder("utf-8", { fatal: true }).decode(
      snapshot.pinned_root.readFile(relativePath, { maxBytes: MAX_PERSISTED_STATE_BYTES }).bytes,
    );
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && String((error as { code?: unknown }).code) === "not_found") return null;
    throw error;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`workspace state at ${path} is not valid JSON: ${String(error)}`);
  }
  const bounded = parseBoundedPersistedState(parsed);
  if (!bounded || hasUnsafePersistedShape(bounded) || bounded.schema !== 1 || typeof bounded.run_key !== "string" || bounded.run_key.trim().length === 0 || !isRecord(bounded.specification)) {
    throw new Error(`workspace state at ${path} is not a bounded specification state envelope`);
  }
  return bounded as unknown as WorkspaceStateEnvelope;
}

function canonicalProjectRoot(value: unknown, root: string): string | null {
  if (typeof value !== "string" || !value.startsWith("/")) return null;
  try {
    return realpathSync(resolve(value)) === root ? root : null;
  } catch {
    return null;
  }
}

function canonicalWorkspaceForRoot(workspace: FeatureWorkspace, root: string, identity?: Pick<WorkspaceRootSnapshot, "dev" | "ino">): FeatureWorkspace | null {
  const canonical = canonicalProjectRoot(workspace.project_root, root);
  const persisted = workspace.project_root_identity;
  if (!canonical || !isRecord(persisted) || persisted.canonical_path !== root
    || (identity !== undefined && (persisted.dev !== identity.dev || persisted.ino !== identity.ino))) return null;
  return workspace.project_root === canonical ? workspace : { ...workspace, project_root: canonical };
}

function isWithin(root: string, candidate: string): boolean {
  return candidate === root || candidate.startsWith(root + sep);
}

/**
 * Root identity captured before a legacy source is consumed.  The lexical
 * path is retained only in memory so a caller-path replacement can be
 * rejected; durable records carry the canonical path and dev/inode identity.
 * The caller owns the returned pinned descriptor and must close it when done.
 */
export interface WorkspaceRootSnapshot {
  lexical_root: string;
  canonical_root: string;
  dev: number;
  ino: number;
  pinned_root: PinnedProjectRoot;
}

export function captureWorkspaceRoot(projectRoot: unknown, options: { hooks?: PinnedRootWriteHooks } = {}): WorkspaceRootSnapshot | null {
  const pinned = PinnedProjectRoot.open(projectRoot, options.hooks);
  if (!pinned) return null;
  return {
    lexical_root: pinned.lexical_root,
    canonical_root: pinned.canonical_root,
    dev: pinned.dev,
    ino: pinned.ino,
    pinned_root: pinned,
  };
}

export function workspaceRootIsStable(snapshot: WorkspaceRootSnapshot): boolean {
  if (!snapshot.pinned_root.isStable()) return false;
  try {
    const lexical = lstatSync(snapshot.lexical_root);
    if (lexical.isSymbolicLink() || !lexical.isDirectory()) return false;
    const canonicalRoot = realpathSync(snapshot.lexical_root);
    if (canonicalRoot !== snapshot.canonical_root) return false;
    const canonical = lstatSync(canonicalRoot);
    return !canonical.isSymbolicLink()
      && canonical.isDirectory()
      && canonical.dev === snapshot.dev
      && canonical.ino === snapshot.ino;
  } catch {
    return false;
  }
}

function pathIdentity(pinned: PinnedProjectRoot, relativePath: string, observed?: PinnedRootPathEntryInfo | null): WorkspacePathIdentity {
  const info = observed === undefined ? pinned.pathEntryInfo(relativePath) : observed;
  if (!info || info.kind !== "directory") throw new PinnedRootError(info ? "path_unauthorized" : "not_found", `required workspace directory '${relativePath}' is missing or unsafe`);
  return {
    relative_path: relativePath,
    canonical_path: join(pinned.canonical_root, ...relativePath.split("/")),
    dev: info.dev,
    ino: info.ino,
  };
}

/** Capture the exact no-follow descendants that protect claim authority. */
export function captureWorkspacePathBinding(
  pinned: PinnedProjectRoot,
  featureId: string,
  options: { ensure?: boolean; claimStorage?: "required" | "optional" } = {},
): WorkspacePathBinding {
  assertSafeFeatureId(featureId);
  const paths = {
    specs: `specs/${featureId}`,
    feature_state: `.work-state/features/${featureId}`,
    artifacts: `.work-state/features/${featureId}/artifacts`,
    execution_claim: `.work-state/features/${featureId}/artifacts/execution_claim`,
    execution_claim_next: `.work-state/features/${featureId}/artifacts/execution_claim/next`,
  } as const;
  const claimStorage = options.claimStorage !== "optional";
  if (options.ensure) {
    for (const path of [paths.specs, paths.feature_state, paths.artifacts]) pinned.ensureDirectory(path);
    if (claimStorage) {
      pinned.ensureDirectory(paths.execution_claim);
      pinned.ensureDirectory(paths.execution_claim_next);
    }
  }
  const bindingPaths = [
    paths.specs,
    paths.feature_state,
    paths.artifacts,
    ...(claimStorage ? [paths.execution_claim, paths.execution_claim_next] : []),
  ];
  const observed = pinned.pathEntryInfoBatch(bindingPaths);
  const observedByPath = new Map<string, PinnedRootPathEntryInfo | null>(
    bindingPaths.map((path, index) => [path, observed[index] ?? null]),
  );
  const identity = (path: string): WorkspacePathIdentity => pathIdentity(pinned, path, observedByPath.get(path));
  const binding = {
    specs: identity(paths.specs),
    feature_state: identity(paths.feature_state),
    artifacts: identity(paths.artifacts),
    execution_claim: claimStorage ? identity(paths.execution_claim) : null,
    execution_claim_next: claimStorage ? identity(paths.execution_claim_next) : null,
  };
  const valid = validateWorkspacePathBinding(binding, featureId);
  if (!valid.ok) throw new PinnedRootError("invalid", valid.issues.join("; "));
  return binding;
}

export function workspacePathBindingDigest(binding: WorkspacePathBinding): string {
  return digestOf(binding);
}

function migrateWorkspaceToV3(
  root: string,
  selectors: { feature_id: string; run_key: string },
  aggregate: Record<string, unknown>,
  captured: WorkspaceRootSnapshot,
  persist = true,
): FeatureWorkspace | null {
  try {
    if (persist) captured.pinned_root.ensureDirectory(`specs/${selectors.feature_id}`);
    const binding = captureWorkspacePathBinding(captured.pinned_root, selectors.feature_id, {
      ensure: persist,
      claimStorage: "optional",
    });
    const migrated = normalizeFeatureWorkspaceV2(aggregate, binding);
    if (!migrated) return null;
    if (!persist) return migrated;
    const expected = digestOf(aggregate);
    const outcome = updateStateAtomically<FeatureWorkspace>(
      root,
      (snapshot) => {
        const current = snapshot.state?.specification;
        if (!current || digestOf(current) !== expected) return { op: "fail", code: "state_conflict", error: "workspace changed during schema migration" };
        return { op: "commit", state: { ...snapshot.state!, specification: migrated }, value: migrated };
      },
      {
        selector: selectors,
        pinnedRoot: captured.pinned_root,
        rootGuard: captured.pinned_root,
        // v2→v3 is authority-neutral cleanup: it preserves the bound
        // constitution bytes and changes only schema/path metadata; it does
        // not advance readiness, cursors, claims, or the constitution gate.
      },
    );
    return outcome.ok ? outcome.state?.specification ?? null : null;
  } catch {
    return null;
  }
}

/**
 * Normalize a persisted workspace without writing it. Dispatch callers use
 * this only after acquiring the durable state transaction lock, so a schema
 * migration can be committed together with the dispatch transition instead
 * of being published by a read-only preflight.
 */
export function normalizeWorkspaceToV3ForTransaction(
  root: string,
  selectors: { feature_id: string; run_key: string },
  aggregate: unknown,
  pinnedRoot: PinnedProjectRoot,
): FeatureWorkspace | null {
  if (!isRecord(aggregate)) return null;
  const identity = { canonical_path: pinnedRoot.canonical_root, dev: pinnedRoot.dev, ino: pinnedRoot.ino };
  const schema = typeof aggregate.schema_version === "number" ? aggregate.schema_version : null;
  let normalized: FeatureWorkspace | null = schema === 1
    ? normalizeFeatureWorkspaceV1(aggregate, identity)
    : schema === 2 || schema === 3
      ? aggregate as unknown as FeatureWorkspace
      : null;
  if (!normalized) return null;
  if (normalized.schema_version !== 2) return normalized.schema_version === 3 ? normalized : null;
  const captured: WorkspaceRootSnapshot = {
    lexical_root: pinnedRoot.lexical_root,
    canonical_root: pinnedRoot.canonical_root,
    dev: pinnedRoot.dev,
    ino: pinnedRoot.ino,
    pinned_root: pinnedRoot,
  };
  return migrateWorkspaceToV3(root, selectors, normalized as unknown as Record<string, unknown>, captured, false);
}

/** Existing and not-yet-created paths must remain below the canonical root. */
function realpathWithin(root: string, candidate: string): boolean {
  const canonicalRoot = resolve(root);
  const absolute = resolve(candidate);
  if (!isWithin(canonicalRoot, absolute)) return false;
  let probe = absolute;
  for (;;) {
    if (existsSync(probe)) {
      try {
        const entry = lstatSync(probe);
        if (entry.isSymbolicLink()) return false;
        return isWithin(canonicalRoot, realpathSync(probe));
      } catch {
        return false;
      }
    }
    const parent = resolve(probe, "..");
    if (parent === probe) return false;
    probe = parent;
  }
}

const DEFAULT_LANGUAGE_SELECTION: LanguageSelection = Object.freeze({ language: "en-US", source: "project_default", selection_hash: digestOf({ language: "en-US" }) });
const DEFAULT_TEMPLATE_SELECTION: TemplateSelection = Object.freeze({ template_set_id: "specification-default", source: "shipped_default", content_hash: digestOf({ template_set: "specification-default" }), required_markers: [] });
function initialPhase(phase: WorkspacePhaseRecord["phase"]): WorkspacePhaseRecord {
  return {
    phase,
    status: "not_started",
    current_version: null,
    approved_version: null,
    validation_ref: null,
    checkpoint_ref: null,
    upstream_versions: [],
    stale_reason: null,
    last_feedback: null,
  };
}
function buildWorkspace(input: { feature_id: string; display_name: string; project_root: string; project_root_identity: ProjectRootIdentity; path_binding: WorkspacePathBinding; profile_name: string; profile_hash: string; source_kind: FeatureWorkspace["source_kind"]; migration_receipt_ref: string | null; import_ref: string | null; constitution_binding?: ConstitutionBinding; constitution_gate_ref?: string; language?: LanguageSelection; template_set?: TemplateSelection }): FeatureWorkspace { const phases = [initialPhase("specify"), initialPhase("plan"), initialPhase("tasks")]; const constitutionBinding = input.constitution_binding ? { ...input.constitution_binding } : null; const constitutionGateRef = input.constitution_gate_ref ?? null; return { schema_version: 3, feature_id: input.feature_id, display_name: input.display_name, source_kind: input.source_kind, project_root: input.project_root, project_root_identity: { ...input.project_root_identity }, path_binding: input.path_binding, workspace_path: `specs/${input.feature_id}`, state_path: `.work-state/features/${input.feature_id}/state.json`, profile_name: input.profile_name, profile_hash: input.profile_hash, constitution_gate_ref: constitutionGateRef, constitution_binding: constitutionBinding, language: input.language !== undefined ? { ...input.language } : { ...DEFAULT_LANGUAGE_SELECTION }, template_set: input.template_set !== undefined ? { ...input.template_set, required_markers: [...input.template_set.required_markers] } : { ...DEFAULT_TEMPLATE_SELECTION, required_markers: [] }, phases, status: "created", next_action: nextActionForWorkspace(phases, { status: "created", hasConstitutionBinding: constitutionBinding !== null, sourceKind: input.source_kind }), handoff_ref: null, execution_claim_prepare_ref: null, execution_claim_ref: null, implementation_conformance_ref: null, import_ref: input.import_ref, migration_receipt_ref: input.migration_receipt_ref }; }
function requireSelectorStrings(selector: { feature_id?: unknown; run_key?: unknown }): { ok: true; feature_id: string; run_key: string } | { ok: false; code: WorkspaceResultCode; error: string } { if (typeof selector.feature_id !== "string" || selector.feature_id.trim().length === 0) return { ok: false, code: "SPEC_SELECTOR_REQUIRED", error: "an explicit non-blank feature_id selector is required" }; if (typeof selector.run_key !== "string" || selector.run_key.trim().length === 0) return { ok: false, code: "SPEC_SELECTOR_REQUIRED", error: "an explicit non-blank run_key selector is required" }; if (!isSafeFeatureId(selector.feature_id)) return { ok: false, code: "SPEC_PATH_UNAUTHORIZED", error: `unsafe feature id ${JSON.stringify(selector.feature_id)}` }; return { ok: true, feature_id: selector.feature_id, run_key: selector.run_key }; }

export interface WorkspaceSelector { feature_id: string; run_key: string; }
export function resolveFeatureWorkspace(
  projectRoot: string,
  selector: WorkspaceSelector,
  borrowedRoot?: WorkspaceRootSnapshot,
  options: { persistMigration?: boolean; requireMigration?: boolean } = {},
): WorkspaceResult<FeatureWorkspace> {
  const selectors = requireSelectorStrings(selector);
  if (!selectors.ok) return selectors;
  const ownsCapture = borrowedRoot === undefined;
  const rootSnapshot = borrowedRoot ?? captureWorkspaceRoot(projectRoot);
  if (!rootSnapshot) return { ok: false, code: "SPEC_PATH_UNAUTHORIZED", error: "project root must be a canonical, non-symlink directory" };
  try {
    const root = rootSnapshot.canonical_root;
    const statePath = featureStatePath(root, selectors.feature_id);
    if (!realpathWithin(root, statePath)) return { ok: false, code: "SPEC_PATH_UNAUTHORIZED", error: `feature state path for '${selectors.feature_id}' escapes the authorized project root` };
    const relativeStatePath = rootSnapshot.pinned_root.relativePath(statePath);
    if (!relativeStatePath) return { ok: false, code: "SPEC_FEATURE_UNKNOWN", error: `no feature workspace exists for '${selectors.feature_id}'` };
    try {
      const parsed = readEnvelopePinned(rootSnapshot, statePath);
      if (!parsed) return { ok: false, code: "SPEC_FEATURE_UNKNOWN", error: `no feature workspace exists for '${selectors.feature_id}'` };
      const rawAggregate = parsed.specification as unknown as Record<string, unknown>;
      const rawSchema = isRecord(rawAggregate) && typeof rawAggregate.schema_version === "number" ? rawAggregate.schema_version : null;
      if (options.requireMigration && rawSchema !== 3) {
        return { ok: false, code: "SPEC_MIGRATION_REQUIRED", error: `feature workspace for '${selectors.feature_id}' requires explicit migration before CTO preflight` };
      }
      let aggregate: FeatureWorkspace | null = rawAggregate.schema_version === 1
        ? normalizeFeatureWorkspaceV1(rawAggregate, { canonical_path: root, dev: rootSnapshot.dev, ino: rootSnapshot.ino })
        : parsed.specification;
      if (aggregate && aggregate.schema_version === 2) aggregate = migrateWorkspaceToV3(
        root,
        selectors,
        aggregate as unknown as Record<string, unknown>,
        rootSnapshot,
        options.persistMigration !== false,
      );
      if (!aggregate) return { ok: false, code: "SPEC_STATE_INVALID", error: `feature state for '${selectors.feature_id}' is invalid or could not be migrated safely` };
      if (aggregate.feature_id !== selectors.feature_id) return { ok: false, code: "SPEC_STATE_INVALID", error: `feature state at '${selectors.feature_id}' carries foreign identity '${aggregate.feature_id}'` };
      if (parsed.run_key !== selectors.run_key) return { ok: false, code: "SPEC_RUN_MISMATCH", error: `run_key '${selectors.run_key}' does not match the workspace run '${parsed.run_key}' for '${selectors.feature_id}'` };
      const valid = validateFeatureWorkspaceRecord(aggregate);
      if (!valid.ok) return { ok: false, code: "SPEC_STATE_INVALID", error: `feature state for '${selectors.feature_id}' is invalid: ${valid.issues.join("; ")}` };
      const canonicalAggregate = canonicalWorkspaceForRoot(aggregate, root, rootSnapshot);
      if (!canonicalAggregate
        || canonicalAggregate.workspace_path !== `specs/${canonicalAggregate.feature_id}`
        || canonicalAggregate.state_path !== `.work-state/features/${canonicalAggregate.feature_id}/state.json`) {
        return { ok: false, code: "SPEC_STATE_INVALID", error: `feature state for '${selectors.feature_id}' does not match the canonical project/workspace identity` };
      }
      if (!workspaceRootIsStable(rootSnapshot)) return { ok: false, code: "SPEC_PATH_UNAUTHORIZED", error: "project root changed while resolving the feature workspace" };
      return { ok: true, value: canonicalAggregate };
    } catch (error) {
      return { ok: false, code: "SPEC_STATE_UNREADABLE", error: `feature state for '${selectors.feature_id}' is unreadable: ${String(error)}` };
    }
  } finally {
    if (ownsCapture) rootSnapshot.pinned_root.close();
  }
}

export interface CreateWorkspaceInput { feature_id: string; display_name: string; run_key: string; profile_name: string; profile_hash: string; source_kind?: FeatureWorkspace["source_kind"]; import_ref?: string | null; constitution_binding?: ConstitutionBinding; constitution_gate_ref?: string; language?: LanguageSelection; template_set?: TemplateSelection; }
export function createFeatureWorkspace(projectRoot: string, input: CreateWorkspaceInput, borrowedRoot?: WorkspaceRootSnapshot): WorkspaceResult<FeatureWorkspace> {
  const selectors = requireSelectorStrings(input);
  if (!selectors.ok) return selectors;
  const ownsCapture = borrowedRoot === undefined;
  const rootSnapshot = borrowedRoot ?? captureWorkspaceRoot(projectRoot);
  if (!rootSnapshot) return { ok: false, code: "SPEC_PATH_UNAUTHORIZED", error: "project root must be a canonical, non-symlink directory" };
  try {
    const root = rootSnapshot.canonical_root;
    const sourceKind = input.source_kind ?? "native";
    if (sourceKind === "legacy") return { ok: false, code: "SPEC_STATE_INVALID", error: "legacy workspaces are created only through the migration boundary" };
    if ([input.display_name, input.profile_name, input.profile_hash].some((value) => typeof value !== "string" || value.trim().length === 0)) return { ok: false, code: "SPEC_STATE_INVALID", error: "display_name, profile_name, and profile_hash are required to create a workspace" };
    if (input.constitution_binding !== undefined || input.constitution_gate_ref !== undefined) {
      if (!input.constitution_binding || !isSafeCanonicalToken(input.constitution_gate_ref)) return { ok: false, code: "SPEC_STATE_INVALID", error: "constitution_binding and constitution_gate_ref must be supplied together with a safe gate reference" };
      const bindingIssues = validateConstitutionBinding(input.constitution_binding, "$.constitution_binding");
      if (bindingIssues.length > 0) return { ok: false, code: "SPEC_STATE_INVALID", error: `constitution binding is invalid: ${bindingIssues.join("; ")}` };
    }
    const statePath = featureStatePath(root, selectors.feature_id);
    const workspacePath = featureWorkspaceDir(root, selectors.feature_id);
    const artifactsPath = featureArtifactsDir(root, selectors.feature_id);
    const preparationDirectories = [
      `specs/${selectors.feature_id}`,
      `.work-state/features/${selectors.feature_id}`,
      `.work-state/features/${selectors.feature_id}/artifacts`,
    ] as const;
    let preparationPreimages: readonly (PinnedRootPathEntryInfo | null)[];
    try {
      preparationPreimages = rootSnapshot.pinned_root.pathEntryInfoBatch(preparationDirectories);
    } catch (error) {
      return { ok: false, code: "SPEC_PATH_UNAUTHORIZED", error: `workspace preparation paths could not be inspected safely: ${String(error)}` };
    }
    let stateReceipts: readonly StateMutationReceipt[] = [];
    let preparationPostimages: readonly (PinnedRootPathEntryInfo | null)[] | null = null;
    const rollbackPreparation = (): void => {
      if (stateReceipts.length > 0) rollbackStateMutationReceipts(rootSnapshot.pinned_root, stateReceipts);
      if (!preparationPostimages) return;
      for (let index = preparationDirectories.length - 1; index >= 0; index -= 1) {
        if (preparationPreimages[index] !== null) continue;
        const relativePath = preparationDirectories[index]!;
        const created = preparationPostimages[index];
        if (!created || created.kind !== "directory") continue;
        try {
          const current = rootSnapshot.pinned_root.pathEntryInfo(relativePath);
          if (current?.kind === "directory" && current.dev === created.dev && current.ino === created.ino) {
            rootSnapshot.pinned_root.removeEmptyDirectoryIfMatches(relativePath, { dev: created.dev, ino: created.ino });
          }
        } catch {
          // Root instability or a concurrent replacement makes cleanup unsafe.
        }
      }
    };
    if (existsSync(statePath)) return { ok: false, code: "SPEC_FEATURE_CONFLICT", error: `a feature workspace already exists for '${selectors.feature_id}'` };
    if (![statePath, workspacePath, artifactsPath].every((candidate) => realpathWithin(root, candidate))) return { ok: false, code: "SPEC_PATH_UNAUTHORIZED", error: `feature state path for '${selectors.feature_id}' escapes the authorized project root` };
    if (!workspaceRootIsStable(rootSnapshot)) return { ok: false, code: "SPEC_PATH_UNAUTHORIZED", error: "project root changed before workspace creation" };
    let workspace: FeatureWorkspace;
    try {
      rootSnapshot.pinned_root.ensureDirectory("specs/" + input.feature_id);
      const pathBinding = captureWorkspacePathBinding(rootSnapshot.pinned_root, input.feature_id, { ensure: true, claimStorage: "optional" });
      preparationPostimages = rootSnapshot.pinned_root.pathEntryInfoBatch(preparationDirectories);
      workspace = buildWorkspace({ feature_id: selectors.feature_id, display_name: input.display_name, project_root: root, project_root_identity: { canonical_path: root, dev: rootSnapshot.dev, ino: rootSnapshot.ino }, path_binding: pathBinding, profile_name: input.profile_name, profile_hash: input.profile_hash, source_kind: sourceKind, migration_receipt_ref: null, import_ref: input.import_ref ?? null, constitution_binding: input.constitution_binding, constitution_gate_ref: input.constitution_gate_ref, language: input.language, template_set: input.template_set });
    } catch (error) {
      rollbackPreparation();
      return { ok: false, code: error instanceof PinnedRootError && (error.code === "path_unauthorized" || error.code === "changed") ? "SPEC_PATH_UNAUTHORIZED" : "SPEC_STATE_UNREADABLE", error: `workspace directories could not be prepared safely: ${String(error)}` };
    }
    const validation = validateFeatureWorkspaceRecord(workspace);
    if (!validation.ok) {
      rollbackPreparation();
      return { ok: false, code: "SPEC_STATE_INVALID", error: `created aggregate is invalid: ${validation.issues.join("; ")}` };
    }
    if (!workspaceRootIsStable(rootSnapshot)) {
      rollbackPreparation();
      return { ok: false, code: "SPEC_PATH_UNAUTHORIZED", error: "project root changed before workspace creation" };
    }
    try {
      if (!workspaceRootIsStable(rootSnapshot) || !realpathWithin(root, statePath) || !realpathWithin(root, workspacePath) || !realpathWithin(root, artifactsPath)) {
        rollbackPreparation();
        return { ok: false, code: "SPEC_PATH_UNAUTHORIZED", error: "project root or workspace path changed during creation" };
      }
      const outcome = updateStateAtomically<FeatureWorkspace>(
        root,
        (snapshot) => {
          if (!workspaceRootIsStable(rootSnapshot)) return { op: "fail", code: "root_unstable", error: "project root changed during workspace creation" };
          if (!snapshot.target.statePath || resolve(snapshot.target.statePath) !== resolve(statePath)) return { op: "fail", code: "state_missing", error: `feature state path for '${selectors.feature_id}' changed during creation` };
          if (snapshot.state) return { op: "fail", code: "state_conflict", error: `a feature workspace already exists for '${selectors.feature_id}'` };
          return {
            op: "commit",
            state: envelope(workspace, selectors.run_key) as unknown as TeamState,
            value: workspace,
          };
        },
        {
          selector: { feature_id: selectors.feature_id, run_key: selectors.run_key },
          pinnedRoot: rootSnapshot.pinned_root,
          rootGuard: rootSnapshot.pinned_root,
          preCommit: () => boundWorkspaceConstitutionGuard(root, workspace, rootSnapshot.pinned_root),
          captureReceipts: true,
        },
      );
      stateReceipts = outcome.ok && outcome.committed ? (outcome.receipts ?? []) : [];
      if (!workspaceRootIsStable(rootSnapshot)) {
        rollbackPreparation();
        return { ok: false, code: "SPEC_PATH_UNAUTHORIZED", error: "project root changed during workspace creation" };
      }
      if (!outcome.ok) {
        rollbackPreparation();
        const code: WorkspaceResultCode = outcome.code === "root_unstable"
          ? "SPEC_PATH_UNAUTHORIZED"
          : outcome.code === "state_conflict"
            ? "SPEC_FEATURE_CONFLICT"
            : outcome.code === "state_missing"
              ? "SPEC_FEATURE_UNKNOWN"
              : outcome.code === "state_invalid"
                ? "SPEC_STATE_INVALID"
                : "SPEC_STATE_UNREADABLE";
        return { ok: false, code, error: outcome.error };
      }
      const committed = outcome.state?.specification;
      if (!committed) {
        rollbackPreparation();
        return { ok: false, code: "SPEC_STATE_UNREADABLE", error: `feature workspace '${selectors.feature_id}' was created without a specification aggregate` };
      }
      return { ok: true, value: committed };
    } catch (error) {
      const stable = workspaceRootIsStable(rootSnapshot);
      if (stable) rollbackPreparation();
      return { ok: false, code: stable ? "SPEC_STATE_UNREADABLE" : "SPEC_PATH_UNAUTHORIZED", error: `feature workspace could not be created safely: ${String(error)}` };
    }
  } finally {
    if (ownsCapture) rootSnapshot.pinned_root.close();
  }
}

const IMMUTABLE_IDENTITY_KEYS = ["feature_id", "workspace_path", "state_path", "project_root", "source_kind"] as const;
function boundWorkspaceConstitutionGuard(root: string, workspace: FeatureWorkspace, pinnedRoot: PinnedProjectRoot): void {
  if (!workspace.constitution_binding) return;
  const current = readPinnedCurrentConstitution(root, pinnedRoot, workspace.constitution_binding, { requireGate: false });
  if (!current.ok) throw new Error(`SPEC_STALE: ${current.error}`);
}

export interface WorkspacePersistencePrecondition {
  expected_workspace_digest?: string;
  expected_state_revision?: number;
  pre_commit?: () => void;
  /** Only stale-binding cleanup may bypass the live provider guard. */
  authority_neutral_cleanup?: boolean;
}
export function persistFeatureWorkspace(
  projectRoot: string,
  workspace: FeatureWorkspace,
  rootSnapshot: WorkspaceRootSnapshot | undefined,
  precondition: WorkspacePersistencePrecondition,
): WorkspaceResult<FeatureWorkspace> {
  const validation = validateFeatureWorkspaceRecord(workspace);
  if (!validation.ok) return { ok: false, code: "SPEC_STATE_INVALID", error: `aggregate is invalid: ${validation.issues.join("; ")}` };
  if (!isSafeFeatureId(workspace.feature_id)) return { ok: false, code: "SPEC_PATH_UNAUTHORIZED", error: `unsafe feature id ${JSON.stringify(workspace.feature_id)}` };
  const hasDigest = typeof precondition?.expected_workspace_digest === "string";
  const hasRevision = Number.isSafeInteger(precondition?.expected_state_revision) && (precondition.expected_state_revision as number) >= 0;
  if ((!hasDigest && !hasRevision)
    || (hasDigest && !isSha256Hex(precondition.expected_workspace_digest))
    || (precondition?.expected_state_revision !== undefined && !hasRevision)) {
    return { ok: false, code: "SPEC_STATE_INVALID", error: "workspace persistence requires an expected semantic digest or state revision" };
  }
  const ownsCapture = rootSnapshot === undefined;
  const captured = rootSnapshot ?? captureWorkspaceRoot(projectRoot);
  if (!captured) return { ok: false, code: "SPEC_PATH_UNAUTHORIZED", error: "project root changed or is not a canonical directory" };
  try {
    if (!workspaceRootIsStable(captured)) return { ok: false, code: "SPEC_PATH_UNAUTHORIZED", error: "project root changed or is not a canonical directory" };
    const root = captured.canonical_root;
    const candidate = canonicalWorkspaceForRoot(workspace, root, captured);
    if (!candidate) return { ok: false, code: "SPEC_FEATURE_CONFLICT", error: "workspace project_root does not identify the canonical project root" };
    const statePath = featureStatePath(root, candidate.feature_id);
    if (!realpathWithin(root, statePath)) return { ok: false, code: "SPEC_PATH_UNAUTHORIZED", error: `feature state path for '${candidate.feature_id}' escapes the authorized project root` };
    let runKey: string;
    try {
      const existing = readEnvelopePinned(captured, statePath);
      if (!existing) return { ok: false, code: "SPEC_FEATURE_UNKNOWN", error: `no feature workspace exists for '${candidate.feature_id}'; create it first` };
      runKey = existing.run_key;
    } catch (error) {
      return { ok: false, code: "SPEC_STATE_UNREADABLE", error: `feature state for '${candidate.feature_id}' is unreadable: ${String(error)}` };
    }
    const outcome = updateStateAtomically<FeatureWorkspace>(
      projectRoot,
      (snapshot) => {
        if (!workspaceRootIsStable(captured)) return { op: "fail", code: "root_unstable", error: "project root changed during workspace persistence" };
        if (!snapshot.state || !snapshot.target.statePath || resolve(snapshot.target.statePath) !== resolve(statePath)) {
          return { op: "fail", code: "state_missing", error: `no feature workspace exists for '${candidate.feature_id}'` };
        }
        const current = snapshot.state.specification;
        if (!current) return { op: "fail", code: "state_invalid", error: `feature state for '${candidate.feature_id}' is not a specification state envelope` };
        const canonicalCurrent = canonicalWorkspaceForRoot(current, root, captured);
        if (!canonicalCurrent) return { op: "fail", code: "state_invalid", error: `feature state for '${candidate.feature_id}' does not match the canonical project root` };
        if (hasDigest && digestOf(canonicalCurrent) !== precondition.expected_workspace_digest) {
          return { op: "fail", code: "state_conflict", error: `feature workspace '${candidate.feature_id}' changed while the candidate was being prepared` };
        }
        if (hasRevision && snapshot.revision !== precondition.expected_state_revision) {
          return { op: "fail", code: "state_conflict", error: `feature state '${candidate.feature_id}' moved from revision ${precondition.expected_state_revision}` };
        }
        for (const key of IMMUTABLE_IDENTITY_KEYS) {
          if (canonicalCurrent[key] !== candidate[key]) return { op: "fail", code: "state_conflict", error: `identity field '${key}' is immutable after creation` };
        }
        if (canonicalCurrent.project_root_identity.canonical_path !== candidate.project_root_identity.canonical_path
          || canonicalCurrent.project_root_identity.dev !== candidate.project_root_identity.dev
          || canonicalCurrent.project_root_identity.ino !== candidate.project_root_identity.ino) {
          return { op: "fail", code: "state_conflict", error: "identity field 'project_root_identity' is immutable after creation" };
        }
        if (precondition.authority_neutral_cleanup) {
          const neutralCurrent = { ...canonicalCurrent, constitution_binding: null, constitution_gate_ref: null };
          const neutralCandidate = { ...candidate, constitution_binding: null, constitution_gate_ref: null };
          if (canonicalJson(neutralCurrent) !== canonicalJson(neutralCandidate)
            || candidate.constitution_binding !== null
            || candidate.constitution_gate_ref !== null) {
            return { op: "fail", code: "state_conflict", error: "authority-neutral constitution cleanup may only clear the exact current binding" };
          }
        }
        return {
          op: "commit",
          state: { ...snapshot.state, specification: candidate },
          value: candidate,
        };
      },
      {
        selector: { feature_id: candidate.feature_id, run_key: runKey },
        pinnedRoot: captured.pinned_root,
        rootGuard: captured.pinned_root,
        preCommit: () => {
          if (!precondition.authority_neutral_cleanup) boundWorkspaceConstitutionGuard(root, candidate, captured.pinned_root);
          precondition.pre_commit?.();
        },
        captureReceipts: true,
      },
    );
    if (!workspaceRootIsStable(captured)) return { ok: false, code: "SPEC_PATH_UNAUTHORIZED", error: "project root changed during workspace persistence" };
    if (!outcome.ok) {
      const code: WorkspaceResultCode = outcome.code === "root_unstable"
        ? "SPEC_PATH_UNAUTHORIZED"
        : outcome.code === "state_conflict"
          ? "SPEC_FEATURE_CONFLICT"
          : outcome.code === "state_missing"
            ? "SPEC_FEATURE_UNKNOWN"
            : outcome.code === "state_invalid"
              ? "SPEC_STATE_INVALID"
              : "SPEC_STATE_UNREADABLE";
      return { ok: false, code, error: outcome.error };
    }
    const committed = outcome.state?.specification;
    if (!committed) return { ok: false, code: "SPEC_STATE_UNREADABLE", error: `feature state for '${candidate.feature_id}' committed without a specification aggregate` };
    return { ok: true, value: committed, receipts: outcome.receipts };
  } finally {
    if (ownsCapture) captured.pinned_root.close();
  }
}

// ── Internal, closed migration projection ───────────────────────────────────
// This is intentionally not exported from the package index.  It accepts no
// legacy object, status, workflow, stage, or control-plane fields; the public
// migration boundary must reduce those values before calling it.
const LEGACY_PROJECTION_KEYS = ["feature_id", "run_key", "project_root", "project_root_dev", "project_root_ino", "source_digest", "source_path", "source_dev", "source_ino", "legacy_inputs", "constitution_binding"] as const;
const SAFE_RUN_KEY_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const SAFE_PROVENANCE_ENTRY_RE = /^(?:active_feature|branch)=[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/u;
interface LegacyWorkspaceProjection {
  feature_id: string;
  run_key: string;
  project_root: string;
  project_root_dev: number;
  project_root_ino: number;
  source_digest: string;
  source_path?: string;
  source_dev?: number;
  source_ino?: number;
  legacy_inputs: string[];
  constitution_binding: ConstitutionBinding;
}
interface MigrationIdentity extends Omit<LegacyWorkspaceProjection, "legacy_inputs" | "constitution_binding" | "source_path" | "source_dev" | "source_ino"> {
  workspace_path: string;
  state_path: string;
}
interface MigrationReceipt {
  id: string;
  status: "complete" | "blocked";
  feature_id: string;
  run_key: string;
  project_root: string;
  project_root_dev: number;
  project_root_ino: number;
  workspace_path: string;
  state_path: string;
  source_digest: string;
  legacy_inputs: string[];
  migrated_at: string;
  receipt_id?: string;
  outcome?: "migrated" | "unchanged" | "blocked";
  source_sha256?: string;
  source_path?: string;
  source_dev?: number;
  source_ino?: number;
  constitution_binding?: { version: string; fingerprint: string };
  diagnostics?: Array<{ code: string; path: string; message: string }>;
  semantic_bindings?: string[];
}
interface LegacyMigrationResult { workspace: FeatureWorkspace; receipt: MigrationReceipt; }
export const MAX_MIGRATION_RECEIPT_BYTES = 2 * 1024 * 1024;
export const MAX_MIGRATION_RECEIPT_AGGREGATE_BYTES = 512 * 1024;
const MAX_MIGRATION_RECEIPT_DEPTH = 8;
export const MAX_MIGRATION_RECEIPT_NODES = 32 * 1024;
const MAX_MIGRATION_RECEIPT_KEYS = 32;
export const MAX_MIGRATION_RECEIPT_STRING_BYTES = 64 * 1024;
export const MAX_MIGRATION_SEMANTIC_BINDING_BYTES = 128 * 1024;
export const MAX_MIGRATION_RECEIPT_ARRAY_ITEMS = 16;
export const MAX_MIGRATION_SEMANTIC_BINDING_ITEMS = 16 * 1024;
const MIGRATION_RECEIPT_KEYS = [
  "id", "status", "feature_id", "run_key", "project_root", "project_root_dev", "project_root_ino",
  "workspace_path", "state_path", "source_digest", "legacy_inputs", "migrated_at",
] as const;
const MIGRATION_RECEIPT_WITH_SOURCE_KEYS = [...MIGRATION_RECEIPT_KEYS, "source_path", "source_dev", "source_ino"] as const;
const MIGRATION_RECEIPT_PUBLIC_KEYS = [
  ...MIGRATION_RECEIPT_KEYS,
  "receipt_id", "outcome", "source_sha256", "source_path", "source_dev", "source_ino",
  "constitution_binding", "diagnostics", "semantic_bindings",
] as const;
const MIGRATION_RECEIPT_ID_RE = /^migration-[a-f0-9]{24}$/u;
const MIGRATION_RECEIPT_FORBIDDEN_KEYS = new Set(["__proto__", "prototype", "constructor"]);
function receiptPath(root: string, featureId: string, receiptId: string): string { return join(featureArtifactsDir(root, featureId), "migration", `${receiptId}.json`); }
function migrationIdentity(root: WorkspaceRootSnapshot, selectors: { feature_id: string; run_key: string }, sourceDigest: string): MigrationIdentity { return { feature_id: selectors.feature_id, run_key: selectors.run_key, project_root: root.canonical_root, project_root_dev: root.dev, project_root_ino: root.ino, workspace_path: `specs/${selectors.feature_id}`, state_path: `.work-state/features/${selectors.feature_id}/state.json`, source_digest: sourceDigest }; }
function migrationReceiptId(identity: MigrationIdentity): string { return `migration-${digestOf(identity).slice(0, 24)}`; }
function migrationReceiptShapeError(value: unknown): string | null {
  const pending: Array<{ value: unknown; depth: number; path: string }> = [{ value, depth: 0, path: "$" }];
  const seen = new WeakSet<object>();
  let nodes = 0;
  let aggregateBytes = 0;
  while (pending.length > 0) {
    const current = pending.pop()!;
    nodes += 1;
    if (nodes > MAX_MIGRATION_RECEIPT_NODES) return `receipt exceeds the ${MAX_MIGRATION_RECEIPT_NODES}-node structural limit`;
    if (current.depth > MAX_MIGRATION_RECEIPT_DEPTH) return `receipt exceeds the ${MAX_MIGRATION_RECEIPT_DEPTH}-level nesting limit`;
    if (typeof current.value === "string") {
      const bytes = Buffer.byteLength(current.value, "utf8");
      const maxStringBytes = current.path.startsWith("$.semantic_bindings[")
        ? MAX_MIGRATION_SEMANTIC_BINDING_BYTES
        : MAX_MIGRATION_RECEIPT_STRING_BYTES;
      aggregateBytes += bytes;
      if (bytes > maxStringBytes || /[\u0000-\u001f\u007f]/u.test(current.value)) return "receipt contains an unsafe or oversized string";
      if (aggregateBytes > MAX_MIGRATION_RECEIPT_AGGREGATE_BYTES) return `receipt exceeds the ${MAX_MIGRATION_RECEIPT_AGGREGATE_BYTES}-byte aggregate limit`;
      continue;
    }
    if (current.value === null || typeof current.value === "boolean") continue;
    if (typeof current.value === "number") {
      if (!Number.isFinite(current.value)) return "receipt contains a non-finite number";
      continue;
    }
    if (typeof current.value !== "object") return "receipt contains an unsupported JSON value";
    if (seen.has(current.value)) return "receipt contains a repeated object";
    seen.add(current.value);
    const prototype = Object.getPrototypeOf(current.value);
    if (Array.isArray(current.value)) {
      if (prototype !== Array.prototype) return "receipt contains an unsafe array prototype";
      const keys = Object.getOwnPropertyNames(current.value).filter((key) => key !== "length");
      const maxArrayItems = current.path === "$.semantic_bindings" ? MAX_MIGRATION_SEMANTIC_BINDING_ITEMS : MAX_MIGRATION_RECEIPT_ARRAY_ITEMS;
      if (keys.length > maxArrayItems) return `receipt array exceeds the ${maxArrayItems}-item limit`;
      for (const key of keys) {
        const descriptor = Object.getOwnPropertyDescriptor(current.value, key);
        if (!descriptor || !("value" in descriptor)) return "receipt contains an accessor property";
        pending.push({ value: descriptor.value, depth: current.depth + 1, path: `${current.path}[${key}]` });
      }
      continue;
    }
    if (prototype !== Object.prototype) return "receipt contains an unsafe object prototype";
    const keys = Object.getOwnPropertyNames(current.value);
    if (keys.length > MAX_MIGRATION_RECEIPT_KEYS) return `receipt object exceeds the ${MAX_MIGRATION_RECEIPT_KEYS}-field limit`;
    for (const key of keys) {
      if (MIGRATION_RECEIPT_FORBIDDEN_KEYS.has(key) || Buffer.byteLength(key, "utf8") > MAX_MIGRATION_RECEIPT_STRING_BYTES) return "receipt contains an unsafe field name";
      const descriptor = Object.getOwnPropertyDescriptor(current.value, key);
      if (!descriptor || !("value" in descriptor)) return "receipt contains an accessor property";
      pending.push({ value: descriptor.value, depth: current.depth + 1, path: `${current.path}.${key}` });
    }
  }
  return null;
}
function safeMigrationReceiptRelativePath(value: unknown): value is string {
  return typeof value === "string"
    && value.length > 0
    && !value.startsWith("/")
    && !value.includes("//")
    && !value.split("/").some((segment) => segment.length === 0 || segment === "." || segment === "..");
}
function isStrictMigrationReceipt(value: unknown): value is MigrationReceipt {
  if (migrationReceiptShapeError(value) !== null || !isRecord(value)) return false;
  const keys = Object.getOwnPropertyNames(value).sort();
  const internalKeys = [...MIGRATION_RECEIPT_KEYS].sort();
  const internalSourceKeys = [...MIGRATION_RECEIPT_WITH_SOURCE_KEYS].sort();
  const publicKeys = [...MIGRATION_RECEIPT_PUBLIC_KEYS].sort();
  const isInternal = keys.length === internalKeys.length && keys.every((key, index) => key === internalKeys[index]);
  const isInternalWithSource = keys.length === internalSourceKeys.length && keys.every((key, index) => key === internalSourceKeys[index]);
  const isPublic = keys.length === publicKeys.length && keys.every((key, index) => key === publicKeys[index]);
  if (!isInternal && !isInternalWithSource && !isPublic) return false;
  if (typeof value.id !== "string" || !MIGRATION_RECEIPT_ID_RE.test(value.id) || value.status !== "complete" || !isSafeFeatureId(value.feature_id) || typeof value.run_key !== "string" || !SAFE_RUN_KEY_RE.test(value.run_key)) return false;
  if (typeof value.project_root !== "string" || !value.project_root.startsWith("/") || value.project_root.includes("//") || value.project_root.split("/").includes("..")) return false;
  if (!Number.isSafeInteger(value.project_root_dev) || (value.project_root_dev as number) < 0 || !Number.isSafeInteger(value.project_root_ino) || (value.project_root_ino as number) < 0) return false;
  if (!safeMigrationReceiptRelativePath(value.workspace_path) || !safeMigrationReceiptRelativePath(value.state_path)) return false;
  if (!isSha256Hex(value.source_digest) || !Array.isArray(value.legacy_inputs) || value.legacy_inputs.length > MAX_MIGRATION_RECEIPT_ARRAY_ITEMS || value.legacy_inputs.some((entry) => typeof entry !== "string" || !SAFE_PROVENANCE_ENTRY_RE.test(entry))) return false;
  if (typeof value.migrated_at !== "string") return false;
  const migratedAt = Date.parse(value.migrated_at);
  if (!Number.isFinite(migratedAt) || new Date(migratedAt).toISOString() !== value.migrated_at) return false;
  if (isInternalWithSource && (!safeMigrationReceiptRelativePath(value.source_path)
    || !Number.isSafeInteger(value.source_dev) || (value.source_dev as number) < 0
    || !Number.isSafeInteger(value.source_ino) || (value.source_ino as number) < 0)) return false;
  if (!isPublic) return true;
  if (value.receipt_id !== value.id || value.outcome !== "migrated" || !isSha256Hex(value.source_sha256) || value.source_sha256 !== value.source_digest
    || !safeMigrationReceiptRelativePath(value.source_path)
    || !Number.isSafeInteger(value.source_dev) || (value.source_dev as number) < 0
    || !Number.isSafeInteger(value.source_ino) || (value.source_ino as number) < 0) return false;
  if (!isRecord(value.constitution_binding)
    || Object.getOwnPropertyNames(value.constitution_binding).sort().join("\u0000") !== ["fingerprint", "version"].join("\u0000")
    || typeof value.constitution_binding.version !== "string"
    || value.constitution_binding.version.trim().length === 0
    || !isSha256Hex(value.constitution_binding.fingerprint)) return false;
  if (!Array.isArray(value.diagnostics) || value.diagnostics.length > MAX_MIGRATION_RECEIPT_ARRAY_ITEMS || value.diagnostics.some((diagnostic) => {
    if (!isRecord(diagnostic) || Object.getOwnPropertyNames(diagnostic).sort().join("\u0000") !== ["code", "message", "path"].join("\u0000")) return true;
    return typeof diagnostic.code !== "string" || diagnostic.code.trim().length === 0
      || typeof diagnostic.path !== "string" || diagnostic.path.trim().length === 0
      || typeof diagnostic.message !== "string" || diagnostic.message.trim().length === 0;
  })) return false;
  return Array.isArray(value.semantic_bindings) && value.semantic_bindings.length <= MAX_MIGRATION_SEMANTIC_BINDING_ITEMS
    && value.semantic_bindings.every((entry) => typeof entry === "string" && entry.trim().length > 0);
}
export function receiptMatchesMigration(receipt: unknown, id: string, identity: MigrationIdentity, legacyInputs?: readonly string[]): receipt is MigrationReceipt {
  if (!isStrictMigrationReceipt(receipt) || receipt.id !== id) return false;
  if (receipt.feature_id !== identity.feature_id || receipt.run_key !== identity.run_key
    || canonicalProjectRoot(receipt.project_root, identity.project_root) === null
    || receipt.project_root_dev !== identity.project_root_dev || receipt.project_root_ino !== identity.project_root_ino
    || receipt.workspace_path !== identity.workspace_path || receipt.state_path !== identity.state_path
    || receipt.source_digest !== identity.source_digest) return false;
  return legacyInputs === undefined
    || (receipt.legacy_inputs.length === legacyInputs.length && receipt.legacy_inputs.every((value, index) => value === legacyInputs[index]));
}
export function parseMigrationReceiptBytes(bytes: Uint8Array): { ok: true; value: MigrationReceipt } | { ok: false; error: string } {
  if (bytes.byteLength > MAX_MIGRATION_RECEIPT_BYTES) return { ok: false, error: `receipt exceeds the ${MAX_MIGRATION_RECEIPT_BYTES}-byte limit` };
  let raw: string;
  try {
    raw = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch (error) {
    return { ok: false, error: `receipt is not valid UTF-8: ${String(error)}` };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    return { ok: false, error: `receipt is not valid JSON: ${String(error)}` };
  }
  if (!isStrictMigrationReceipt(parsed)) return { ok: false, error: "receipt has an invalid bounded schema or identity field" };
  return { ok: true, value: parsed };
}
export function readMigrationReceiptPinned(
  snapshot: WorkspaceRootSnapshot,
  relativePath: string,
  expected?: { id?: string; identity?: MigrationIdentity; legacyInputs?: readonly string[]; verifyRootStability?: boolean; expectedPath?: string },
): { ok: true; value: MigrationReceipt; metadata: { path: string; dev: number; ino: number; size: number; mtimeMs: number; ctimeMs: number; sha256: string } } | { ok: false; error: string } {
  let read: ReturnType<WorkspaceRootSnapshot["pinned_root"]["readFile"]>;
  try {
    read = snapshot.pinned_root.readFile(relativePath, { maxBytes: MAX_MIGRATION_RECEIPT_BYTES });
  } catch (error) {
    return { ok: false, error: String(error) };
  }
  if (expected?.expectedPath !== undefined && read.path !== expected.expectedPath) return { ok: false, error: "receipt descriptor path does not match the captured path" };
  if (expected?.verifyRootStability === true && !workspaceRootIsStable(snapshot)) return { ok: false, error: "captured project root changed while reading the migration receipt" };
  const parsed = parseMigrationReceiptBytes(read.bytes);
  if (!parsed.ok) return parsed;
  if (expected?.id !== undefined && expected.identity !== undefined && !receiptMatchesMigration(parsed.value, expected.id, expected.identity, expected.legacyInputs)) return { ok: false, error: "receipt does not match the captured migration identity" };
  const metadata = { path: read.path, dev: read.dev, ino: read.ino, size: read.size ?? read.bytes.byteLength, mtimeMs: read.mtimeMs ?? 0, ctimeMs: read.ctimeMs ?? 0, sha256: createHash("sha256").update(read.bytes).digest("hex") };
  if (expected?.verifyRootStability === true && !workspaceRootIsStable(snapshot)) return { ok: false, error: "captured project root changed after reading the migration receipt" };
  return { ok: true, value: parsed.value, metadata };
}
function validateLegacyProjection(value: unknown, root: WorkspaceRootSnapshot): { ok: true; value: LegacyWorkspaceProjection } | { ok: false; error: string } {
  if (!isRecord(value)) return { ok: false, error: "legacy migration requires a closed validated projection" };
  if (Object.keys(value).some((key) => !LEGACY_PROJECTION_KEYS.includes(key as typeof LEGACY_PROJECTION_KEYS[number]))) return { ok: false, error: "legacy migration projection contains unsupported fields" };
  if (!isSafeFeatureId(value.feature_id)) return { ok: false, error: "legacy migration projection feature_id is unsafe" };
  if (typeof value.run_key !== "string" || !SAFE_RUN_KEY_RE.test(value.run_key)) return { ok: false, error: "legacy migration projection run_key is unsafe" };
  if (typeof value.project_root !== "string" || value.project_root !== root.canonical_root || !value.project_root.startsWith("/")) return { ok: false, error: "legacy migration projection project_root is not the captured canonical root" };
  if (!Number.isSafeInteger(value.project_root_dev) || (value.project_root_dev as number) < 0 || value.project_root_dev !== root.dev) return { ok: false, error: "legacy migration projection project-root device identity changed" };
  if (!Number.isSafeInteger(value.project_root_ino) || (value.project_root_ino as number) < 0 || value.project_root_ino !== root.ino) return { ok: false, error: "legacy migration projection project-root inode identity changed" };
  if (!isSha256Hex(value.source_digest)) return { ok: false, error: "legacy migration projection source digest is invalid" };
  const sourcePath = value.source_path;
  const sourceDev = value.source_dev;
  const sourceIno = value.source_ino;
  const hasSourceProvenance = sourcePath !== undefined || sourceDev !== undefined || sourceIno !== undefined;
  if (hasSourceProvenance && (typeof sourcePath !== "string" || !safeMigrationReceiptRelativePath(sourcePath) || !Number.isSafeInteger(sourceDev) || (sourceDev as number) < 0 || !Number.isSafeInteger(sourceIno) || (sourceIno as number) < 0)) return { ok: false, error: "legacy migration projection source provenance is invalid" };
  if (!isRecord(value.constitution_binding) || validateConstitutionBinding(value.constitution_binding, "$.constitution_binding").length > 0) return { ok: false, error: "legacy migration projection constitution binding is invalid" };
  if (!Array.isArray(value.legacy_inputs) || value.legacy_inputs.length > 16 || value.legacy_inputs.some((entry) => typeof entry !== "string" || !SAFE_PROVENANCE_ENTRY_RE.test(entry))) return { ok: false, error: "legacy migration projection provenance is not bounded safe metadata" };
  const featureId = value.feature_id;
  const runKey = value.run_key;
  const projectRoot = value.project_root;
  const projectRootDev = value.project_root_dev as number;
  const projectRootIno = value.project_root_ino as number;
  const sourceDigest = value.source_digest;
  const legacyInputs = value.legacy_inputs as string[];
  return { ok: true, value: { feature_id: featureId, run_key: runKey, project_root: projectRoot, project_root_dev: projectRootDev, project_root_ino: projectRootIno, source_digest: sourceDigest, ...(hasSourceProvenance ? { source_path: sourcePath as string, source_dev: sourceDev as number, source_ino: sourceIno as number } : {}), legacy_inputs: [...legacyInputs], constitution_binding: { ...(value.constitution_binding as unknown as ConstitutionBinding) } } };
}

/** @internal: called only by specification/migration.ts after closed validation. */
function persistLegacyWorkspaceProjectionUnlocked(rootSnapshot: WorkspaceRootSnapshot, projection: unknown, options: { expected_gate?: ConstitutionGateRecord } = {}): WorkspaceResult<LegacyMigrationResult> {
  if (!workspaceRootIsStable(rootSnapshot)) return { ok: false, code: "SPEC_PATH_UNAUTHORIZED", error: "project root changed before legacy migration persistence" };
  const checked = validateLegacyProjection(projection, rootSnapshot);
  if (!checked.ok) return { ok: false, code: "SPEC_MIGRATION_BLOCKED", error: checked.error };
  const input = checked.value;
  const root = rootSnapshot.canonical_root;
  const statePath = featureStatePath(root, input.feature_id);
  const workspacePath = featureWorkspaceDir(root, input.feature_id);
  const artifactsPath = featureArtifactsDir(root, input.feature_id);
  const establishedReceiptPath = receiptPath(root, input.feature_id, migrationReceiptId(migrationIdentity(rootSnapshot, input, input.source_digest)));
  const establishedReceiptRelative = ".work-state/features/" + input.feature_id + "/artifacts/migration/" + migrationReceiptId(migrationIdentity(rootSnapshot, input, input.source_digest)) + ".json";
  if (![statePath, workspacePath, artifactsPath, establishedReceiptPath].every((candidate) => realpathWithin(root, candidate))) return { ok: false, code: "SPEC_PATH_UNAUTHORIZED", error: "feature workspace paths escape the captured canonical project root" };
  let canonicalProfileHash: string;
  let canonicalProfile: Profile;
  let canonicalScope: ScopeFlags;
  let migrationBranch: string;
  try {
    const profile = loadProfile("spec-preparation");
    if (!profile) return { ok: false, code: "SPEC_STATE_INVALID", error: "the canonical spec-preparation profile is unavailable" };
    canonicalProfile = profile;
    canonicalProfileHash = profileHash(profile);
    migrationBranch = resolveActiveBranch(root);
    canonicalScope = resolveScope([], resolveConfig(root));
  } catch (error) {
    return { ok: false, code: "SPEC_STATE_INVALID", error: `the canonical spec-preparation profile is unreadable: ${String(error)}` };
  }
  const identity = migrationIdentity(rootSnapshot, input, input.source_digest);
  const receiptId = migrationReceiptId(identity);
  const receipt: MigrationReceipt = {
    id: receiptId,
    status: "complete",
    ...identity,
    legacy_inputs: [...input.legacy_inputs],
    migrated_at: new Date().toISOString(),
    ...(input.source_path !== undefined ? {
      source_path: input.source_path,
      source_dev: input.source_dev,
      source_ino: input.source_ino,
    } : {}),
  };
  const receiptBytes = Buffer.from(JSON.stringify(receipt, null, 2) + "\n", "utf8");
  let attemptReceipt: PinnedRootWriteReceipt | null = null;
  const rollbackAttemptReceipt = (): void => {
    const owned = attemptReceipt;
    attemptReceipt = null;
    if (!owned) return;
    rollbackPinnedRootWriteReceipt(rootSnapshot.pinned_root, owned);
  };
  // Reject an established malformed receipt before preparing any readable
  // workspace directories.  The transaction below repeats this read under
  // the same pinned root and state CAS to close the check-then-use race.
  try {
    if (rootSnapshot.pinned_root.pathEntryExists(establishedReceiptRelative)) {
      const preexistingReceipt = readMigrationReceiptPinned(rootSnapshot, establishedReceiptRelative);
      if (!preexistingReceipt.ok) return { ok: false, code: "SPEC_STATE_INVALID", error: `migration receipt for '${input.feature_id}' is unreadable: ${preexistingReceipt.error}` };
      if (!receiptMatchesMigration(preexistingReceipt.value, receiptId, identity, input.legacy_inputs)) return { ok: false, code: "SPEC_STATE_INVALID", error: `migration receipt for '${input.feature_id}' does not match the captured root, selector, and source identity` };
    }
  } catch (error) {
    return { ok: false, code: workspaceRootIsStable(rootSnapshot) ? "SPEC_STATE_INVALID" : "SPEC_PATH_UNAUTHORIZED", error: `migration receipt for '${input.feature_id}' could not be inspected safely: ${String(error)}` };
  }
  try {
  let rollbackStateAttempt: () => void = () => {};
  let workspace: FeatureWorkspace;
    rootSnapshot.pinned_root.ensureDirectory("specs/" + input.feature_id);
    const pathBinding = captureWorkspacePathBinding(rootSnapshot.pinned_root, input.feature_id, { ensure: true, claimStorage: "optional" });
    workspace = buildWorkspace({ feature_id: input.feature_id, display_name: `Migrated feature ${input.feature_id}`, project_root: root, project_root_identity: { canonical_path: root, dev: rootSnapshot.dev, ino: rootSnapshot.ino }, path_binding: pathBinding, profile_name: "spec-preparation", profile_hash: canonicalProfileHash, source_kind: "legacy", migration_receipt_ref: receiptId, import_ref: null, constitution_binding: input.constitution_binding });
  workspace.status = "in_progress";
  workspace.next_action = nextActionForWorkspace(workspace.phases, { status: workspace.status, hasConstitutionBinding: true, sourceKind: "legacy" });
  const valid = validateFeatureWorkspaceRecord(workspace);
  if (!valid.ok) return { ok: false, code: "SPEC_MIGRATION_BLOCKED", error: valid.issues.join("; ") };
  try {
    if (!workspaceRootIsStable(rootSnapshot)) return { ok: false, code: "SPEC_PATH_UNAUTHORIZED", error: "project root changed before legacy migration persistence" };
    rootSnapshot.pinned_root.ensureDirectory("specs/" + input.feature_id);
    rootSnapshot.pinned_root.ensureDirectory(".work-state/features/" + input.feature_id + "/artifacts/migration");
    if (!workspaceRootIsStable(rootSnapshot) || !realpathWithin(root, workspacePath) || !realpathWithin(root, artifactsPath) || !realpathWithin(root, statePath)) return { ok: false, code: "SPEC_PATH_UNAUTHORIZED", error: "feature workspace paths changed during legacy migration" };
      const stateRelativePath = `.work-state/features/${input.feature_id}/state.json`;
    let stateReceipts: readonly StateMutationReceipt[] = [];
    const outcome = updateStateAtomically<LegacyMigrationResult>(
      root,
      (snapshot) => {
        if (!workspaceRootIsStable(rootSnapshot)) return { op: "fail", code: "root_unstable", error: "project root changed during legacy migration" };
        if (!snapshot.target.statePath || resolve(snapshot.target.statePath) !== resolve(statePath)) return { op: "fail", code: "state_missing", error: `feature state path for input.feature_id changed during legacy migration` };
        if (snapshot.state) {
          const current = snapshot.state.specification;
          if (!current || current.source_kind !== "legacy" || !current.migration_receipt_ref) return { op: "fail", code: "state_conflict", error: `a non-legacy feature workspace already exists for '${input.feature_id}'` };
          if (snapshot.state.run_key !== undefined && snapshot.state.run_key !== input.run_key) return { op: "fail", code: "state_conflict", error: `run_key '${input.run_key}' does not match the migrated workspace run '${snapshot.state.run_key}' for '${input.feature_id}'` };
          const canonicalCurrent = canonicalWorkspaceForRoot(current, root, rootSnapshot);
          if (!canonicalCurrent || canonicalCurrent.feature_id !== identity.feature_id || canonicalCurrent.workspace_path !== identity.workspace_path || canonicalCurrent.state_path !== identity.state_path || canonicalCurrent.profile_name !== "spec-preparation" || canonicalCurrent.profile_hash !== canonicalProfileHash) return { op: "fail", code: "state_invalid", error: `migrated feature state for '${input.feature_id}' does not match the canonical migration identity` };
          if (canonicalCurrent.migration_receipt_ref !== receiptId) return { op: "fail", code: "state_conflict", error: `legacy source digest does not match the established migration for '${input.feature_id}'` };
          const existingReceiptResult = readMigrationReceiptPinned(rootSnapshot, establishedReceiptRelative);
          if (!existingReceiptResult.ok) return { op: "fail", code: "state_invalid", error: `migration receipt for '${input.feature_id}' is unreadable: ${existingReceiptResult.error}` };
          if (!receiptMatchesMigration(existingReceiptResult.value, receiptId, identity, input.legacy_inputs)) return { op: "fail", code: "state_invalid", error: `migration receipt for '${input.feature_id}' does not match the captured root, selector, and source identity` };
          return { op: "discard", value: { workspace: canonicalCurrent, receipt: existingReceiptResult.value } };
        }
        let persistedReceipt: MigrationReceipt = receipt;
        if (rootSnapshot.pinned_root.pathEntryExists(establishedReceiptRelative)) {
          const existingReceiptResult = readMigrationReceiptPinned(rootSnapshot, establishedReceiptRelative);
          if (!existingReceiptResult.ok) return { op: "fail", code: "state_invalid", error: `migration receipt for '${input.feature_id}' is unreadable: ${existingReceiptResult.error}` };
          if (!receiptMatchesMigration(existingReceiptResult.value, receiptId, identity, input.legacy_inputs)) return { op: "fail", code: "state_conflict", error: `migration receipt for '${input.feature_id}' conflicts with the captured source identity` };
          persistedReceipt = existingReceiptResult.value;
        } else {
          try {
            attemptReceipt = rootSnapshot.pinned_root.writeExclusiveWithReceipt(establishedReceiptRelative, receiptBytes);
          } catch (error) {
            if (!(error instanceof PinnedRootError) || error.code !== "exists") return { op: "fail", code: "state_invalid", error: `migration receipt for '${input.feature_id}' could not be persisted: ${String(error)}` };
            const racedReceiptResult = readMigrationReceiptPinned(rootSnapshot, establishedReceiptRelative);
            if (!racedReceiptResult.ok) return { op: "fail", code: "state_invalid", error: `migration receipt for '${input.feature_id}' is unreadable: ${racedReceiptResult.error}` };
            if (!receiptMatchesMigration(racedReceiptResult.value, receiptId, identity, input.legacy_inputs)) return { op: "fail", code: "state_conflict", error: `migration receipt for '${input.feature_id}' conflicts with the captured source identity` };
            persistedReceipt = racedReceiptResult.value;
          }
        }
        if (!workspaceRootIsStable(rootSnapshot)) return { op: "fail", code: "root_unstable", error: "project root changed during legacy migration" };
        return {
          op: "commit",
          state: migrationEnvelope(workspace, input.run_key, receiptId, persistedReceipt.migrated_at, canonicalProfile, migrationBranch, canonicalScope),
          value: { workspace, receipt: persistedReceipt },
        };
      },
      {
        selector: { feature_id: input.feature_id, run_key: input.run_key },
        pinnedRoot: rootSnapshot.pinned_root,
        rootGuard: rootSnapshot.pinned_root,
        preCommit: () => {
          const expectedGate = options.expected_gate;
          const live = readPinnedCurrentConstitution(root, rootSnapshot.pinned_root, input.constitution_binding, { requireGate: expectedGate !== undefined });
          if (!live.ok) throw new Error(`SPEC_STALE: current constitution authority changed before legacy workspace state commit: ${live.error}`);
          if (expectedGate !== undefined) {
            let currentGate: unknown = null;
            try {
              const gateRaw = new TextDecoder("utf-8", { fatal: true }).decode(rootSnapshot.pinned_root.readFile(".work-state/specification/constitution/gate.json", { maxBytes: 512 * 1024 }).bytes);
              const parsed: unknown = JSON.parse(gateRaw);
              currentGate = isRecord(parsed) && isRecord(parsed.gate) ? parsed.gate : null;
            } catch (error) {
              throw new Error(`SPEC_STALE: current constitution gate could not be read before legacy workspace state commit: ${String(error)}`);
            }
            if (!currentGate || canonicalJson(currentGate) !== canonicalJson(expectedGate)) {
              throw new Error("SPEC_STALE: current constitution gate semantic identity changed before legacy workspace state commit");
            }
          }
        },
        captureReceipts: true,
      },
    );
    stateReceipts = outcome.ok && outcome.committed ? (outcome.receipts ?? []) : [];
    rollbackStateAttempt = (): void => {
      if (stateReceipts.length > 0) rollbackStateMutationReceipts(rootSnapshot.pinned_root, stateReceipts);
    };
    if (outcome.ok && outcome.committed && stateReceipts.length === 0) {
      rollbackAttemptReceipt();
      return { ok: false, code: "SPEC_STATE_UNREADABLE", error: "legacy workspace state commit returned no exact publication receipts" };
    }
    if (!outcome.ok) rollbackAttemptReceipt();
    if (!workspaceRootIsStable(rootSnapshot)) { rollbackStateAttempt(); rollbackAttemptReceipt(); return { ok: false, code: "SPEC_PATH_UNAUTHORIZED", error: "project root changed after legacy migration persistence" }; }
    if (outcome.ok && options.expected_gate) {
      try {
        const gateRaw = new TextDecoder("utf-8", { fatal: true }).decode(rootSnapshot.pinned_root.readFile(".work-state/specification/constitution/gate.json", { maxBytes: 512 * 1024 }).bytes);
        const parsed: unknown = JSON.parse(gateRaw);
        const currentGate = isRecord(parsed) && isRecord(parsed.gate) ? parsed.gate : null;
        if (!currentGate || canonicalJson(currentGate) !== canonicalJson(options.expected_gate)) {
          rollbackStateAttempt();
          rollbackAttemptReceipt();
          return { ok: false, code: "SPEC_STATE_INVALID", error: "SPEC_STALE: current constitution gate semantic identity changed after legacy workspace state commit" };
        }
      } catch (error) {
        rollbackStateAttempt();
        rollbackAttemptReceipt();
        return { ok: false, code: "SPEC_STATE_INVALID", error: `SPEC_STALE: current constitution gate could not be rechecked after legacy workspace state commit: ${String(error)}` };
      }
    }
    attemptReceipt = null;
    if (!outcome.ok) {
      const code: WorkspaceResultCode = outcome.code === "root_unstable"
        ? "SPEC_PATH_UNAUTHORIZED"
        : outcome.code === "state_conflict"
          ? "SPEC_FEATURE_CONFLICT"
          : outcome.code === "state_missing"
            ? "SPEC_FEATURE_UNKNOWN"
            : outcome.code === "state_invalid"
              ? "SPEC_STATE_INVALID"
              : "SPEC_STATE_UNREADABLE";
      return { ok: false, code, error: outcome.error };
    }
    if (!outcome.value) return { ok: false, code: "SPEC_STATE_UNREADABLE", error: `legacy workspace '${input.feature_id}' completed without a migration result` };
    return { ok: true, value: outcome.value };
  } catch (error) {
    rollbackStateAttempt();
    rollbackAttemptReceipt();
    return { ok: false, code: workspaceRootIsStable(rootSnapshot) ? "SPEC_STATE_UNREADABLE" : "SPEC_PATH_UNAUTHORIZED", error: `legacy workspace could not be persisted safely: ${String(error)}` };
  }
  } catch (error) {
    rollbackAttemptReceipt();
    return { ok: false, code: workspaceRootIsStable(rootSnapshot) ? "SPEC_STATE_UNREADABLE" : "SPEC_PATH_UNAUTHORIZED", error: `legacy workspace could not be prepared safely: ${String(error)}` };
}
}

export function persistLegacyWorkspaceProjection(rootSnapshot: WorkspaceRootSnapshot, projection: unknown, options: { expected_gate?: ConstitutionGateRecord } = {}): WorkspaceResult<LegacyMigrationResult> {
  const checked = validateLegacyProjection(projection, rootSnapshot);
  if (!checked.ok) return persistLegacyWorkspaceProjectionUnlocked(rootSnapshot, projection, options);
  try {
    return withCtoRunLock(
      rootSnapshot.canonical_root,
      "__constitution__",
      () => persistLegacyWorkspaceProjectionUnlocked(rootSnapshot, projection, options),
      { pinnedRoot: rootSnapshot.pinned_root },
    );
  } catch (error) {
    return { ok: false, code: workspaceRootIsStable(rootSnapshot) ? "SPEC_STATE_UNREADABLE" : "SPEC_PATH_UNAUTHORIZED", error: `legacy workspace constitution lock could not be acquired safely: ${String(error)}` };
  }
}

const IMPACTED_ARTIFACT_RE = /^(specify|plan|tasks)\.v(\d+)$/;
export function currentConstitutionBinding(workspace: FeatureWorkspace): ConstitutionBinding | null { return workspace.constitution_binding; }
export function bindWorkspaceConstitution(workspace: FeatureWorkspace, binding: ConstitutionBinding, gateRef?: string): FeatureWorkspace { const issues = validateConstitutionBinding(binding); if (issues.length > 0) throw new Error(`invalid constitution binding: ${issues.join("; ")}`); return { ...workspace, constitution_binding: { ...binding }, constitution_gate_ref: gateRef !== undefined ? gateRef : workspace.constitution_gate_ref }; }
function phaseArtifactIds(phase: FeatureWorkspace["phases"][number]): string[] {
  const ids: string[] = [];
  for (const version of [phase.approved_version, phase.current_version]) {
    if (version === null) continue;
    const id = `${phase.phase}.v${version}`;
    if (!ids.includes(id)) ids.push(id);
  }
  return ids;
}
function artifactMatchesPhase(id: string, phase: FeatureWorkspace["phases"][number]): boolean {
  return IMPACTED_ARTIFACT_RE.test(id) && phaseArtifactIds(phase).includes(id);
}
const STALEABLE_PHASE_STATUSES = new Set(["materialized", "validating", "awaiting_approval", "approved"]);
const DERIVED_STALE_WORKSPACE_STATUSES = new Set(["implementation_ready", "claimed", "executing", "completion_validating", "completion_blocked"]);

function explicitReason(reason: unknown): asserts reason is string { if (typeof reason !== "string" || reason.trim().length === 0) throw new Error("staleness requires an explicit reason"); }
function markStale(workspace: FeatureWorkspace, seeds: readonly string[], reason: string, includeSeeds: boolean): { workspace: FeatureWorkspace; stale_artifacts: string[] } {
  const staleIds = new Set(seeds);
  const stale: string[] = [];
  const appendStale = (ids: readonly string[]): void => {
    for (const id of ids) {
      if (stale.includes(id)) continue;
      stale.push(id);
      staleIds.add(id);
    }
  };
  let changed = false;
  const phases = workspace.phases.map((phase) => {
    const ids = phaseArtifactIds(phase);
    const directlyAffected = includeSeeds && ids.some((id) => staleIds.has(id));
    const dependencyAffected = phase.upstream_versions.some((binding) => staleIds.has(`${binding.phase}.v${binding.version}`));
    if ((!directlyAffected && !dependencyAffected) || !STALEABLE_PHASE_STATUSES.has(phase.status)) return phase;
    if (phase.status === "stale") return phase;
    changed = true;
    appendStale(directlyAffected ? ids.filter((id) => staleIds.has(id)) : ids);
    return { ...phase, status: "stale" as const, stale_reason: reason };
  });
  // A single pass is sufficient for the canonical ordered phase graph, but
  // repeat until no newly stale phase can affect a later dependent phase.
  let current = phases;
  while (changed) {
    changed = false;
    current = current.map((phase) => {
      const ids = phaseArtifactIds(phase);
      const dependencyAffected = phase.upstream_versions.some((binding) => staleIds.has(`${binding.phase}.v${binding.version}`));
      if (!dependencyAffected || phase.status === "stale" || !STALEABLE_PHASE_STATUSES.has(phase.status)) return phase;
      changed = true;
      appendStale(ids);
      return { ...phase, status: "stale" as const, stale_reason: reason };
    });
  }
  if (!includeSeeds) {
    for (const seed of seeds) {
      const phase = current.find((candidate) => phaseArtifactIds(candidate).includes(seed));
      if (phase?.status === "stale" && !stale.includes(seed)) stale.unshift(seed);
    }
  }
  if (stale.length === 0) return { workspace, stale_artifacts: [] };
  const next: FeatureWorkspace = { ...workspace, phases: current, status: DERIVED_STALE_WORKSPACE_STATUSES.has(workspace.status) ? "stale" : workspace.status, next_action: { kind: "remediation", command: null, reason } as WorkspaceNextAction };
  return { workspace: next, stale_artifacts: stale };
}

export interface UpstreamRevision { artifact_id: string; version: number; hash: string; }
export function propagateUpstreamRevision(workspace: FeatureWorkspace, revision: UpstreamRevision): { workspace: FeatureWorkspace; stale_artifacts: string[] } {
  explicitReason("upstream revision");
  if (!isRecord(revision) || typeof revision.artifact_id !== "string" || !IMPACTED_ARTIFACT_RE.test(revision.artifact_id) || !Number.isInteger(revision.version) || revision.version < 1 || typeof revision.hash !== "string" || !/^[a-f0-9]{64}$/.test(revision.hash)) throw new Error(`invalid revision ${JSON.stringify(revision)}`);
  const match = IMPACTED_ARTIFACT_RE.exec(revision.artifact_id)!;
  const phase = workspace.phases.find((candidate) => candidate.phase === match[1]);
  if (!phase || phase.current_version === null || revision.version < 2 || revision.version !== phase.current_version + 1) {
    if (phase && revision.version === phase.current_version && phase.status === "generating") return { workspace, stale_artifacts: [] };
    throw new Error(`revision ${revision.artifact_id} is not the next revision of an existing phase`);
  }
  const previousId = `${phase.phase}.v${phase.current_version}`;
  const revised = { ...phase, current_version: revision.version, status: "generating" as const, stale_reason: null };
  const replaced: FeatureWorkspace = { ...workspace, phases: workspace.phases.map((candidate) => candidate.phase === phase.phase ? revised : candidate) };
  return markStale(replaced, [previousId], revision.artifact_id + " upstream revision", false);
}

export interface ManualRevalidation { feature_id: string; phase: "specify" | "plan" | "tasks"; version: number; documents: Record<string, { expected_sha256: string; actual_sha256: string; matches: boolean }>; }
export function applyManualEdits(workspace: FeatureWorkspace, revalidation: ManualRevalidation, reason: string): { workspace: FeatureWorkspace; stale_artifacts: string[] } {
  explicitReason(reason);
  if (!isRecord(revalidation) || revalidation.feature_id !== workspace.feature_id) throw new Error(`revalidation feature_id ${JSON.stringify(revalidation?.feature_id ?? null)} does not match workspace feature '${workspace.feature_id}'`);
  if (!IMPACTED_ARTIFACT_RE.test(`${revalidation.phase}.v${revalidation.version}`) || !Number.isInteger(revalidation.version) || !isRecord(revalidation.documents)) throw new Error(`revalidation evidence does not identify a valid artifact for '${workspace.feature_id}'`);
  const id = `${revalidation.phase}.v${revalidation.version}`;
  const phase = workspace.phases.find((candidate) => candidate.phase === revalidation.phase);
  if (!phase || !artifactMatchesPhase(id, phase)) throw new Error(`revalidation artifact ${id} is not present in the workspace`);
  if (!Object.values(revalidation.documents).some((document) => isRecord(document) && document.matches === false)) return { workspace, stale_artifacts: [] };
  return markStale(workspace, [id], reason, true);
}

function sameLanguage(left: LanguageSelection, right: LanguageSelection): boolean { return left.language === right.language && left.source === right.source && left.selection_hash === right.selection_hash; }
function sameTemplate(left: TemplateSelection, right: TemplateSelection): boolean { return left.template_set_id === right.template_set_id && left.source === right.source && left.content_hash === right.content_hash && left.required_markers.length === right.required_markers.length && left.required_markers.every((marker, index) => marker === right.required_markers[index]); }
function selectionImpact(workspace: FeatureWorkspace, reason: string): { workspace: FeatureWorkspace; stale_artifacts: string[] } { const seeds = workspace.phases.flatMap(phaseArtifactIds); return markStale(workspace, seeds, reason, true); }
export function applyLanguageChange(workspace: FeatureWorkspace, language: LanguageSelection): { workspace: FeatureWorkspace; stale_artifacts: string[] } { if (!isRecord(language) || typeof language.language !== "string" || typeof language.selection_hash !== "string") throw new Error("invalid language selection"); if (sameLanguage(workspace.language, language)) return { workspace, stale_artifacts: [] }; const next = { ...workspace, language: { ...language } }; return selectionImpact(next, `language selection changed to ${language.language}`); }
export function applyTemplateChange(workspace: FeatureWorkspace, templateSet: TemplateSelection): { workspace: FeatureWorkspace; stale_artifacts: string[] } { if (!isRecord(templateSet) || typeof templateSet.template_set_id !== "string" || typeof templateSet.content_hash !== "string" || !Array.isArray(templateSet.required_markers)) throw new Error("invalid template selection"); if (sameTemplate(workspace.template_set, templateSet)) return { workspace, stale_artifacts: [] }; const next = { ...workspace, template_set: { ...templateSet, required_markers: [...templateSet.required_markers] } }; return selectionImpact(next, `template set changed to ${templateSet.template_set_id}`); }


export interface UpdateSpecificationPresentationInput {
  feature_id: string;
  run_key: string;
  language?: LanguageSelection;
  template?: TemplateSelection;
}

export interface SpecificationPresentationUpdate {
  changed: boolean;
  affected_phases: WorkspacePhase[];
  staled_approvals: string[];
  next_action: WorkspaceNextAction;
}

const LANGUAGE_SELECTION_SOURCES = new Set(["feature_override", "project_default", "request_language"]);
const TEMPLATE_SELECTION_SOURCES = new Set(["feature_override", "project_default", "shipped_default"]);

function validateLanguageSelection(value: unknown): LanguageSelection {
  if (!isRecord(value) || typeof value.language !== "string" || value.language.trim().length === 0
    || typeof value.source !== "string" || !LANGUAGE_SELECTION_SOURCES.has(value.source)
    || !isSha256Hex(value.selection_hash)) throw new Error("invalid language selection");
  return { language: value.language, source: value.source as LanguageSelection["source"], selection_hash: value.selection_hash };
}

function validateTemplateSelection(value: unknown): TemplateSelection {
  if (!isRecord(value) || typeof value.template_set_id !== "string" || value.template_set_id.trim().length === 0
    || typeof value.source !== "string" || !TEMPLATE_SELECTION_SOURCES.has(value.source)
    || !isSha256Hex(value.content_hash) || !Array.isArray(value.required_markers)
    || value.required_markers.some((marker) => typeof marker !== "string" || marker.trim().length === 0)) throw new Error("invalid template selection");
  return { template_set_id: value.template_set_id, source: value.source as TemplateSelection["source"], content_hash: value.content_hash, required_markers: [...value.required_markers] };
}

const MAX_PRESENTATION_ARTIFACT_BYTES = 4 * 1024 * 1024;

function readPresentationJson(pinnedRoot: PinnedProjectRoot, relativePath: string): Record<string, unknown> | null {
  try {
    const entry = pinnedRoot.pathEntryInfo(relativePath);
    if (!entry || entry.kind !== "file") return null;
    const read = pinnedRoot.readFile(relativePath, { maxBytes: MAX_PRESENTATION_ARTIFACT_BYTES });
    const raw = new TextDecoder("utf-8", { fatal: true }).decode(read.bytes);
    const parsed: unknown = JSON.parse(raw);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function phasePresentationMatches(pinnedRoot: PinnedProjectRoot, workspace: FeatureWorkspace, phase: WorkspacePhaseRecord, languageChanged: boolean, languageHash: string | undefined, templateChanged: boolean, templateHash: string | undefined): boolean {
  const version = phase.approved_version ?? phase.current_version;
  if (version === null || (!languageChanged && !templateChanged)) return true;
  if (!pinnedRoot.isStable()) return false;
  const artifactId = phase.phase + ".v" + version;
  const artifactPath = `.work-state/features/${workspace.feature_id}/artifacts/${artifactId}.json`;
  const manifestPath = `.work-state/features/${workspace.feature_id}/artifacts/documents/${phase.phase}/v${version}.json`;

  // Native phase envelopes carry presentation hashes at the artifact root;
  // pre-binding materializations carry them in the manifest's presentation
  // binding. Read either representation, but never infer a binding from the
  // workspace selection itself: an artifact without provenance is stale.
  let binding: { language_hash?: unknown; template_hash?: unknown } | null = null;
  const artifact = readPresentationJson(pinnedRoot, artifactPath);
  if (artifact?.artifact_id === artifactId) binding = artifact;
  if (!binding) {
    const manifest = readPresentationJson(pinnedRoot, manifestPath);
    if (manifest?.feature_id === workspace.feature_id
      && manifest.phase === phase.phase && manifest.version === version
      && isRecord(manifest.binding) && manifest.binding.artifact_id === artifactId && isRecord(manifest.binding.presentation)) {
      binding = manifest.binding.presentation;
    }
  }
  return pinnedRoot.isStable()
    && binding !== null
    && (!languageChanged || binding.language_hash === languageHash)
    && (!templateChanged || binding.template_hash === templateHash);
}

function presentationImpact(pinnedRoot: PinnedProjectRoot, workspace: FeatureWorkspace, languageChanged: boolean, languageHash: string | undefined, templateChanged: boolean, templateHash: string | undefined, reason: string): { workspace: FeatureWorkspace; stale_artifacts: string[] } {
  const seeds: string[] = [];
  for (const phase of workspace.phases) {
    if (!STALEABLE_PHASE_STATUSES.has(phase.status)) continue;
    const version = phase.approved_version ?? phase.current_version;
    if (version === null || phasePresentationMatches(pinnedRoot, workspace, phase, languageChanged, languageHash, templateChanged, templateHash)) continue;
    seeds.push(...phaseArtifactIds(phase));
  }
  return markStale(workspace, seeds, reason, true);
}

/** Update the exact presentation selections for one explicit feature/run. */
export function updateSpecificationPresentation(
  projectRoot: string,
  input: UpdateSpecificationPresentationInput,
  borrowedRoot?: WorkspaceRootSnapshot,
): SpecificationPresentationUpdate {
  const selectors = requireSelectorStrings(input);
  if (!selectors.ok) throw new Error(selectors.code + ": " + selectors.error);
  const ownsCapture = borrowedRoot === undefined;
  const rootSnapshot = borrowedRoot ?? captureWorkspaceRoot(projectRoot);
  if (!rootSnapshot) throw new Error("SPEC_PATH_UNAUTHORIZED: project root must be a canonical, non-symlink directory");
  try {
    const resolved = resolveFeatureWorkspace(projectRoot, selectors, rootSnapshot);
    if (!resolved.ok) throw new Error(resolved.code + ": " + resolved.error);
    const current = resolved.value;
    const language = input.language === undefined ? current.language : validateLanguageSelection(input.language);
    const template = input.template === undefined ? current.template_set : validateTemplateSelection(input.template);
    const languageChanged = !sameLanguage(current.language, language);
    const templateChanged = !sameTemplate(current.template_set, template);
    if (!languageChanged && !templateChanged) return { changed: false, affected_phases: [], staled_approvals: [], next_action: current.next_action };
    const reasonParts: string[] = [];
    if (languageChanged) reasonParts.push("language selection changed to " + language.language);
    if (templateChanged) reasonParts.push("template set changed to " + template.template_set_id);
    const reason = reasonParts.join(" and ") + "; regenerate affected specification phases before continuing.";
    const constitutionGuard = () => {
      if (!current.constitution_binding) throw new Error("SPEC_STALE: workspace has no constitution binding");
      const live = readPinnedCurrentConstitution(rootSnapshot.canonical_root, rootSnapshot.pinned_root, current.constitution_binding);
      if (!live.ok) throw new Error("SPEC_STALE: " + live.error);
    };
    constitutionGuard();
    const candidate: FeatureWorkspace = { ...current, language: { ...language }, template_set: { ...template, required_markers: [...template.required_markers] } };
    const impacted = presentationImpact(rootSnapshot.pinned_root, candidate, languageChanged, language.selection_hash, templateChanged, template.content_hash, reason);
    const persisted = persistFeatureWorkspace(projectRoot, impacted.workspace, rootSnapshot, { expected_workspace_digest: digestOf(current), pre_commit: constitutionGuard });
    if (!persisted.ok) throw new Error(persisted.code + ": " + persisted.error);
    const affectedPhases = impacted.stale_artifacts.map((artifact) => artifact.split(".")[0]).filter((phase, index, phases): phase is WorkspacePhase => (phase === "specify" || phase === "plan" || phase === "tasks") && phases.indexOf(phase) === index);
    return { changed: true, affected_phases: affectedPhases, staled_approvals: impacted.stale_artifacts, next_action: persisted.value.next_action };
  } finally {
    if (ownsCapture) rootSnapshot.pinned_root.close();
  }
}

export function applyConstitutionImpact(
  workspace: FeatureWorkspace,
  rows: readonly ConstitutionArtifactImpactResult[],
  reason: string,
): { workspace: FeatureWorkspace; stale_artifacts: string[] } {
  explicitReason(reason);

  // The assessment is authoritative for every version in the workspace image:
  // a phase may simultaneously expose an approved version and a newer current
  // version while its next approval is open. Keep both identities in the
  // expected set so applying an assessment cannot silently drop one of them.
  const expected = new Set<string>();
  for (const phase of workspace.phases) {
    for (const artifactId of phaseArtifactIds(phase)) expected.add(artifactId);
  }

  const seen = new Set<string>();
  for (const row of rows) {
    if (!isRecord(row)
      || typeof row.artifact_id !== "string"
      || !IMPACTED_ARTIFACT_RE.test(row.artifact_id)
      || seen.has(row.artifact_id)
      || !["affected", "no_impact"].includes(row.verdict)
      || !Array.isArray(row.evidence_refs)
      || row.evidence_refs.length === 0
      || row.evidence_refs.some((ref) => typeof ref !== "string" || ref.trim().length === 0)) {
      throw new Error("constitution impact rows must be complete, unique, and evidence-backed");
    }
    if (!expected.has(row.artifact_id)) {
      throw new Error(`constitution impact assessment contains an unapproved artifact '${row.artifact_id}'`);
    }
    seen.add(row.artifact_id);
  }
  for (const artifact of expected) {
    if (!seen.has(artifact)) {
      throw new Error(`constitution impact assessment is missing artifact '${artifact}'`);
    }
  }

  // The receipt is a deterministic projection of the assessment, not of the
  // phase traversal. This preserves one entry per affected artifact version,
  // including both current and approved versions of an awaiting phase.
  const staleArtifacts = rows
    .filter((row) => row.verdict === "affected")
    .map((row) => row.artifact_id);
  const affected = new Set(staleArtifacts);
  const phases = workspace.phases.map((phase) => {
    const versionIds = phaseArtifactIds(phase);
    const phaseAffected = versionIds.some((artifactId) => affected.has(artifactId));
    if (!phaseAffected || !STALEABLE_PHASE_STATUSES.has(phase.status) || phase.status === "stale") return phase;
    return { ...phase, status: "stale" as const, stale_reason: reason };
  });
  let next: FeatureWorkspace = { ...workspace, phases };
  if (staleArtifacts.length > 0) {
    next = {
      ...next,
      status: DERIVED_STALE_WORKSPACE_STATUSES.has(next.status) ? "stale" : next.status,
      next_action: { kind: "remediation", command: null, reason } as WorkspaceNextAction,
    };
  }
  return { workspace: next, stale_artifacts: staleArtifacts };
}

export function applyHandoffStaleness(handoff: ImplementationHandoff, staleArtifactIds: readonly string[]): { handoff: ImplementationHandoff; stale: boolean } { const bound = new Set(handoff.artifact_versions.map((artifact) => artifact.artifact_id)); const affected = staleArtifactIds.some((artifactId) => bound.has(artifactId)); if (!affected) return { handoff, stale: handoff.status === "stale" }; if (handoff.status === "stale") return { handoff, stale: true }; return { handoff: { ...handoff, status: "stale" }, stale: true }; }
