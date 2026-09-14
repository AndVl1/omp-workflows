/**
 * CTO gates: per-team DoD, integration DoD, backstop, and specification
 * execution preflight.
 *
 * DoD aggregation (R11): each team writes its own dod.json; the integration
 * phase requires every team done AND its DoD complete. The backstop mirrors
 * gates/dod-backstop.ts semantics for CtoState — it only blocks at a
 * done-claim, never during background_wait / needs_human / failed pauses.
 *
 * `teams[].dod_path` is resolved through the canonical resolver
 * (resolveDodPath) — both the directory-containing-dod.json form and the
 * dod.json-file form work identically in every gate; unsafe paths fail closed.
 */

import { isDoDComplete, readDoDFilePinned, resolveDodPath } from "../engine/dod.js";
import { checkBudget } from "./budget.js";
import { isLiveExecutionClaim, readCurrentExecutionClaim } from "../specification/claims.js";
import { PinnedProjectRoot } from "../specification/pinned-root.js";
import { ensureProjectConstitution, readProjectConstitutionGate } from "../specification/prerequisite.js";
import { readPinnedCurrentConstitution } from "../specification/constitution-identities.js";
import { readCanonicalHandoff, setCanonicalHandoffReadTestHooks } from "../specification/canonical-reader.js";
import { evaluateHandoffReadiness } from "../specification/handoff.js";
import { resolveFeatureWorkspace, type WorkspaceRootSnapshot } from "../specification/workspace.js";
import { canonicalJson, isSafeFeatureId, validateConstitutionBinding } from "../specification/validation.js";
import type { ConstitutionBinding, FeatureWorkspace, ImplementationHandoff } from "../specification/types.js";
import { buildCtoSpecificationMapping } from "./plan.js";
import { isSafeCtoExecutionId, isSafeCtoRunId } from "./state.js";
import type { CtoSpecificationMapping, CtoState } from "./types.js";
import { MAX_CTO_SPECIFICATION_AGGREGATE_BYTES, MAX_CTO_SPECIFICATION_REQUESTS } from "./types.js";

export type GateResult = { ok: true } | { ok: false; reason: string };

/**
 * A single team's DoD, resolved from `teams[].dod_path` — accepted as either
 * the directory containing dod.json or the dod.json file itself. Unset
 * dod_path stays "DoD not claimed" (integration requires an explicit claim).
 */
export function teamDoDComplete(state: CtoState, teamId: string, pinnedRoot: PinnedProjectRoot): GateResult {
  if (!pinnedRoot.isStable()) return { ok: false, reason: "pinned project root changed before CTO DoD read" };
  const root = pinnedRoot.canonical_root;
  const team = state.teams.find((t) => t.id === teamId);
  if (!team) return { ok: false, reason: `unknown team: ${teamId}` };
  if (!team.dod_path) return { ok: false, reason: `team ${teamId} has no dod_path — DoD not claimed` };
  const resolved = resolveDodPath(root, team.dod_path, teamId);
  if (!resolved.ok) return { ok: false, reason: `team ${teamId} DoD path invalid: ${resolved.reason}` };
  const relativeFile = pinnedRoot.relativePath(resolved.file);
  if (relativeFile === null) return { ok: false, reason: `team ${teamId} DoD path invalid: resolved DoD is outside the pinned project root` };
  const read = readDoDFilePinned(pinnedRoot, relativeFile);
  if (!read.ok) return { ok: false, reason: `team ${teamId} DoD: ${resolved.file}: ${read.reason}` };
  const check = isDoDComplete(read.dod);
  return check.ok ? { ok: true } : { ok: false, reason: `team ${teamId} DoD: ${check.pending.map((p) => p.id).join(", ")}` };
}

/** Integration gate: every team done + every team DoD complete. */
export function integrationDoD(state: CtoState, pinnedRoot: PinnedProjectRoot): GateResult {
  if (state.integration.status === "failed") {
    return { ok: false, reason: `integration failed: ${state.integration.note ?? "no note"}` };
  }
  const notDone = state.teams.filter((t) => t.status !== "done");
  if (notDone.length > 0) {
    return { ok: false, reason: `teams not done: ${notDone.map((t) => t.id).join(", ")}` };
  }
  for (const team of state.teams) {
    const check = teamDoDComplete(state, team.id, pinnedRoot);
    if (!check.ok) return check;
  }
  return { ok: true };
}

/**
 * Backstop gate (R11): block ONLY at a done-claim. Allow stopping during
 * background_wait (parked team), needs_human (blocker), failed — mirroring
 * gates/dod-backstop.ts.
 */
export function ctoBackstop(state: CtoState, pinnedRoot: PinnedProjectRoot): { continue: true } | { decision: "block"; reason: string } {
  // Missing pause (legacy pre-pause writers) is NOT a done claim — same
  // semantics as isCtoRunTerminal: only integration/team conditions can
  // prove a done-claim, and background_wait/needs_human/failed keep going.
  const kind = state.pause?.kind;
  if (kind === "background_wait" || kind === "needs_human" || kind === "failed") return { continue: true };

  const claimingDone = kind === "done" || state.integration.status === "done";
  if (!claimingDone) return { continue: true };

  const check = integrationDoD(state, pinnedRoot);
  if (!check.ok) {
    return {
      decision: "block",
      reason: `CTO DoD: ${check.reason}. To pause instead, set pause.kind to background_wait | needs_human | failed.`,
    };
  }
  return { continue: true };
}

/**
 * Conditional dissent gate (architecture §4.11 — br-zps.10, cto-quality).
 * Dissent triggers ONLY on high-stakes, irreversible, or budget-exceeding
 * actions — low-stakes reversible work passes with NO dissent check (no gate
 * tax). Semantics, highest precedence first:
 *
 *   1. budget status "exceeded" → block; <teamId> must escalate to cto.
 *   2. stakes === "high" or reversible === false → block; <teamId> must
 *      escalate to cto (trigger names included in the reason).
 *   3. else → { ok: true }.
 *
 * Contradiction checks are NOT performed here: this gate has no
 * contradicts_decision_tag in its signature, so it does not read decision
 * memory. Tag-aware contradiction dissent happens via evaluateDissent()
 * (dissent.ts) where the calling layer can supply a tag.
 *
 * `checkBudget` tolerates a state without the optional schema-2 `budget`
 * field (D3: all limits null → "unlimited"), so no guard is needed here.
 */
export function dissentGate(
  state: CtoState,
  teamId: string,
  action: { stakes: "low" | "medium" | "high"; reversible: boolean },
): GateResult {
  if (checkBudget(state).status === "exceeded") {
    return {
      ok: false,
      reason: `dissent: budget exceeded — ${teamId} must escalate to cto (stakes: ${action.stakes}, reversible: ${action.reversible})`,
    };
  }
  const triggers: string[] = [];
  if (action.stakes === "high") triggers.push("high_stakes");
  if (action.reversible === false) triggers.push("irreversible");
  if (triggers.length > 0) {
    return {
      ok: false,
      reason: `dissent: ${triggers.join(", ")} — ${teamId} must escalate to cto (stakes: ${action.stakes}, reversible: ${action.reversible})`,
    };
  }
  return { ok: true };
}

/** Explicit feature/run selection accepted by CTO specification preflight. */
export interface CtoSpecificationExecutionSelection {
  feature_id: string;
  run_key: string;
}

/** Input to the pure preflight seam; no persistence or dispatch occurs here. */
export interface CtoSpecificationExecutionPreflightInput {
  cto_run_id: string;
  selections: readonly CtoSpecificationExecutionSelection[];
}

export interface CtoSpecificationExecutionPreflightExcludedSelection {
  feature_id: string;
  run_key: string;
  findings: string[];
}

/** Exact retry descriptor emitted when a probe includes ineligible rows. */
export interface CtoSpecificationExecutionPreflightRetry {
  cto_run_id: string;
  selections: CtoSpecificationExecutionSelection[];
}

/** Public preflight result. A blocked result never carries a partial mapping. */
export type CtoSpecificationExecutionPreflightResult =
  | { status: "ready"; mapping: CtoSpecificationMapping; findings: string[]; dispatched: false }
  | {
    status: "blocked";
    findings: string[];
    dispatched: false;
    /** Eligible rows in original request order, for an exact operational retry. */
    eligible_selections?: CtoSpecificationExecutionSelection[];
    /** Excluded rows and their deterministic reasons. */
    excluded?: CtoSpecificationExecutionPreflightExcludedSelection[];
    /** Mounted callers execute this descriptor directly; no human authorization is needed. */
    required_next_tool?: { name: "cto_preflight"; arguments: CtoSpecificationExecutionPreflightRetry };
  };

function constitutionComparable(binding: FeatureWorkspace["constitution_binding"]): string {
  if (!binding) return "null";
  const { bound_at: _audit, ...semantic } = binding;
  return canonicalJson(semantic);
}

export { setCanonicalHandoffReadTestHooks as setCtoGateHandoffReadTestHooks };

export type CtoConstitutionRefreshResult =
  | { ok: true; binding: ConstitutionBinding }
  | { ok: false; finding: string };

/**
 * Refresh the shared constitution prerequisite against the live source while
 * retaining the selected workspace/handoff binding as the authority. This is
 * deliberately performed under the caller's pinned root so drift, missing
 * sources, unresolved impact transactions, and unusable revisions fail before
 * any CTO mapping, confirmation, claim, or dispatch write.
 */
export function refreshCtoWorkspaceConstitution(
  root: string,
  workspace: FeatureWorkspace,
  pinnedRoot: PinnedProjectRoot,
): CtoConstitutionRefreshResult {
  if (!pinnedRoot.isStable()) return { ok: false, finding: "SPEC_PATH_UNAUTHORIZED: project root changed before live constitution refresh" };
  const persisted = readProjectConstitutionGate(root, pinnedRoot);
  if (!persisted.ok) return { ok: false, finding: persisted.code + ": " + persisted.error };
  const persistedProvider = persisted.value.provider;
  const gate = ensureProjectConstitution(root, {
    origin_kind: persisted.value.origin_kind,
    origin_run_key: persisted.value.origin_run_key,
    origin_stage: persisted.value.origin_stage,
  }, {
    feature_id: workspace.feature_id,
    explicit_path: persistedProvider?.source === "explicit_override" ? persistedProvider.path : null,
    pinnedRoot,
  });
  if (!gate.ok) return { ok: false, finding: gate.code + ": " + gate.error };
  if (gate.value.status !== "usable" || !gate.value.binding) {
    return { ok: false, finding: "SPEC_CONSTITUTION_IMPACT_PENDING: live constitution prerequisite is " + gate.value.status };
  }
  const current = readPinnedCurrentConstitution(root, pinnedRoot, gate.value.binding);
  if (!current.ok) return { ok: false, finding: "SPEC_CONSTITUTION_IMPACT_PENDING: " + current.error };
  if (constitutionComparable(current.value.binding) !== constitutionComparable(workspace.constitution_binding)) {
    return { ok: false, finding: "SPEC_CONSTITUTION_IMPACT_PENDING: live constitution binding does not match workspace " + workspace.feature_id };
  }
  if (!pinnedRoot.isStable()) return { ok: false, finding: "SPEC_PATH_UNAUTHORIZED: project root changed during live constitution refresh" };
  return { ok: true, binding: gate.value.binding };
}

/**
 * Refresh the constitution and compare both the selected workspace and its
 * implementation handoff. Checkpoint paths use the workspace-only variant
 * because native phase approvals predate handoff publication.
 */
export function refreshCtoSpecificationConstitution(
  root: string,
  workspace: FeatureWorkspace,
  handoff: ImplementationHandoff,
  pinnedRoot: PinnedProjectRoot,
): CtoConstitutionRefreshResult {
  const workspaceResult = refreshCtoWorkspaceConstitution(root, workspace, pinnedRoot);
  if (!workspaceResult.ok) return workspaceResult;
  if (constitutionComparable(workspaceResult.binding) !== constitutionComparable(handoff.constitution_binding)) {
    return { ok: false, finding: "SPEC_CONSTITUTION_IMPACT_PENDING: live constitution binding does not match handoff " + handoff.handoff_id };
  }
  return workspaceResult;
}

/**
 * Read the already-approved constitution gate and source without acquiring
 * the constitution transaction lock. Callers hold the per-run lock and must
 * use this strict seam for commit-time revalidation.
 */
export function readCtoWorkspaceConstitution(
  root: string,
  workspace: FeatureWorkspace,
  pinnedRoot: PinnedProjectRoot,
): CtoConstitutionRefreshResult {
  if (!pinnedRoot.isStable()) return { ok: false, finding: "SPEC_PATH_UNAUTHORIZED: project root changed before live constitution read" };
  if (!workspace.constitution_binding) return { ok: false, finding: "SPEC_CONSTITUTION_IMPACT_PENDING: workspace has no constitution binding" };
  const persisted = readProjectConstitutionGate(root, pinnedRoot);
  if (!persisted.ok) return { ok: false, finding: persisted.code + ": " + persisted.error };
  if (!persisted.value.binding) return { ok: false, finding: "SPEC_CONSTITUTION_IMPACT_PENDING: persisted constitution gate has no usable binding" };
  if (constitutionComparable(persisted.value.binding) !== constitutionComparable(workspace.constitution_binding)) {
    return { ok: false, finding: "SPEC_CONSTITUTION_IMPACT_PENDING: live constitution binding does not match workspace " + workspace.feature_id };
  }
  const current = readPinnedCurrentConstitution(root, pinnedRoot, workspace.constitution_binding);
  if (!current.ok) return { ok: false, finding: "SPEC_CONSTITUTION_IMPACT_PENDING: " + current.error };
  if (constitutionComparable(current.value.binding) !== constitutionComparable(workspace.constitution_binding)) {
    return { ok: false, finding: "SPEC_CONSTITUTION_IMPACT_PENDING: live constitution source changed for workspace " + workspace.feature_id };
  }
  if (!pinnedRoot.isStable()) return { ok: false, finding: "SPEC_PATH_UNAUTHORIZED: project root changed during live constitution read" };
  return { ok: true, binding: current.value.binding };
}

/** Strict read-only workspace + handoff constitution validation. */
export function readCtoSpecificationConstitution(
  root: string,
  workspace: FeatureWorkspace,
  handoff: ImplementationHandoff,
  pinnedRoot: PinnedProjectRoot,
): CtoConstitutionRefreshResult {
  const workspaceResult = readCtoWorkspaceConstitution(root, workspace, pinnedRoot);
  if (!workspaceResult.ok) return workspaceResult;
  if (constitutionComparable(workspaceResult.binding) !== constitutionComparable(handoff.constitution_binding)) {
    return { ok: false, finding: "SPEC_CONSTITUTION_IMPACT_PENDING: live constitution binding does not match handoff " + handoff.handoff_id };
  }
  return workspaceResult;
}

function readHandoff(
  pinnedRoot: PinnedProjectRoot | null,
  workspace: FeatureWorkspace,
): { handoff: ImplementationHandoff } | { finding: string } {
  if (!pinnedRoot) return { finding: "project root cannot be pinned for canonical handoff inspection" };
  const reference = workspace.handoff_ref;
  const relativePath = typeof reference === "string"
    ? `.work-state/features/${workspace.feature_id}/artifacts/implementation_handoff/${reference}.json`
    : "";
  if (typeof reference !== "string" || !isSafeFeatureId(workspace.feature_id) || reference.includes("/")) {
    return { finding: `handoff artifact for '${workspace.feature_id}' is missing or outside the authorized project boundary` };
  }
  const loaded = readCanonicalHandoff(pinnedRoot, relativePath, `handoff artifact for '${workspace.feature_id}'`);
  return loaded.ok ? { handoff: loaded.handoff } : { finding: loaded.error };
}

function validateFrozenVersions(workspace: FeatureWorkspace, handoff: ImplementationHandoff): string[] {
  const findings: string[] = [];
  for (const artifact of handoff.artifact_versions) {
    if (artifact.kind !== "specify" && artifact.kind !== "plan" && artifact.kind !== "tasks") continue;
    const phase = workspace.phases.find((candidate) => candidate.phase === artifact.kind);
    const expected = phase?.approved_version ?? phase?.current_version;
    if (!phase || expected === null || expected === undefined || artifact.version !== expected || artifact.artifact_id !== `${artifact.kind}.v${artifact.version}`) {
      findings.push(`artifact version '${artifact.artifact_id}' is not the current approved version for '${workspace.feature_id}'`);
    }
  }
  return findings;
}

/**
 * Validate and freeze explicitly selected ready handoffs for later T097
 * confirmation. Every selector is independent, canonical, and fail-closed;
 * this function only reads state/artifacts and builds a pure mapping.
 */
export function preflightCtoSpecificationExecution(
  projectRoot: string,
  input: CtoSpecificationExecutionPreflightInput,
): CtoSpecificationExecutionPreflightResult {
  const openedRoot = PinnedProjectRoot.open(projectRoot);
  const pinnedRoot = openedRoot && openedRoot.isStable() ? openedRoot : null;
  if (openedRoot && !pinnedRoot) openedRoot.close();
  const root = pinnedRoot?.canonical_root ?? null;
  if (!root || !pinnedRoot) return { status: "blocked", findings: ["project root is missing or cannot be canonicalized"], dispatched: false };
  try {
    return preflightCtoSpecificationExecutionPinnedInternal(root, pinnedRoot, input);
  } finally {
    pinnedRoot.close();
  }
}

export function preflightCtoSpecificationExecutionPinned(
  root: string,
  pinnedRoot: PinnedProjectRoot,
  input: CtoSpecificationExecutionPreflightInput,
): CtoSpecificationExecutionPreflightResult {
  if (root !== pinnedRoot.canonical_root || !pinnedRoot.isStable()) {
    return { status: "blocked", findings: ["project root is missing or changed"], dispatched: false };
  }
  return preflightCtoSpecificationExecutionPinnedInternal(root, pinnedRoot, input);
}

function preflightCtoSpecificationExecutionPinnedInternal(
  root: string,
  pinnedRoot: PinnedProjectRoot,
  input: CtoSpecificationExecutionPreflightInput,
): CtoSpecificationExecutionPreflightResult {
  const findings: string[] = [];
  if (!input || !isSafeCtoRunId(input.cto_run_id)) {
    return { status: "blocked", findings: ["cto_run_id must be a safe non-empty string"], dispatched: false };
  }
  if (!Array.isArray(input.selections) || input.selections.length === 0) {
    return { status: "blocked", findings: ["at least one explicit feature selection is required"], dispatched: false };
  }
  if (input.selections.length > MAX_CTO_SPECIFICATION_REQUESTS) {
    return { status: "blocked", findings: [`selections must contain at most ${MAX_CTO_SPECIFICATION_REQUESTS} entries`], dispatched: false };
  }
  let selectionBytes = 0;
  try {
    selectionBytes = Buffer.byteLength(JSON.stringify(input.selections), "utf8");
  } catch {
    return { status: "blocked", findings: ["selections must be JSON-serializable"], dispatched: false };
  }
  if (selectionBytes > MAX_CTO_SPECIFICATION_AGGREGATE_BYTES) {
    return { status: "blocked", findings: [`selections exceed ${MAX_CTO_SPECIFICATION_AGGREGATE_BYTES} bytes`], dispatched: false };
  }
  for (const [index, selection] of input.selections.entries()) {
    if (!selection || typeof selection !== "object" || Array.isArray(selection)
      || !isSafeFeatureId(selection.feature_id) || !isSafeCtoExecutionId(selection.run_key)) {
      return {
        status: "blocked",
        findings: [`unsafe selector at index ${index}: each selection requires a safe feature_id and run_key`],
        dispatched: false,
      };
    }
  }
  const workspaceRoot: WorkspaceRootSnapshot = {
    lexical_root: pinnedRoot.lexical_root,
    canonical_root: pinnedRoot.canonical_root,
    dev: pinnedRoot.dev,
    ino: pinnedRoot.ino,
    pinned_root: pinnedRoot,
  };

  const seen = new Set<string>();
  const prepared: Array<{ feature_id: string; run_key: string; handoff: ImplementationHandoff }> = [];
  for (const selection of input.selections) {
    if (!selection || typeof selection !== "object" || !isSafeFeatureId(selection.feature_id) || typeof selection.run_key !== "string" || selection.run_key.trim().length === 0) {
      findings.push(`unsafe selector: feature_id=${JSON.stringify(selection?.feature_id ?? null)}, run_key=${JSON.stringify(selection?.run_key ?? null)}; each selection requires a unique safe feature_id and a non-empty run_key`);
      continue;
    }
    const key = `${selection.feature_id}\u0000${selection.run_key}`;
    if (seen.has(key)) {
      findings.push(`duplicate feature/run selection '${selection.feature_id}'`);
      continue;
    }
    seen.add(key);
    const workspaceResult = resolveFeatureWorkspace(root, selection, workspaceRoot, { persistMigration: false, requireMigration: true });
    if (!workspaceResult.ok) {
      findings.push(`${workspaceResult.code}: ${workspaceResult.error}`);
      continue;
    }
    const workspace = workspaceResult.value;
    if (workspace.project_root !== root
      || workspace.project_root_identity.canonical_path !== root
      || workspace.project_root_identity.dev !== pinnedRoot.dev
      || workspace.project_root_identity.ino !== pinnedRoot.ino) {
      findings.push(`project boundary mismatch for '${selection.feature_id}': workspace root is not canonical`);
      continue;
    }
    if (workspace.status !== "implementation_ready") {
      findings.push(`workspace '${selection.feature_id}' is not implementation_ready (status '${workspace.status}')`);
      continue;
    }
    if (!workspace.constitution_binding || validateConstitutionBinding(workspace.constitution_binding).length > 0) {
      findings.push(`constitution binding for '${selection.feature_id}' is missing or invalid`);
      continue;
    }
    const loaded = readHandoff(pinnedRoot, workspace);
    if ("finding" in loaded) {
      findings.push(loaded.finding);
      continue;
    }
    const handoff = loaded.handoff;
    if (handoff.feature_id !== selection.feature_id) {
      findings.push(`handoff feature mismatch for '${selection.feature_id}'`);
      continue;
    }
    if (handoff.status !== "ready") {
      findings.push(`handoff for '${selection.feature_id}' is not ready (status '${handoff.status}')`);
      continue;
    }
    findings.push(...validateFrozenVersions(workspace, handoff));
    if (constitutionComparable(handoff.constitution_binding) !== constitutionComparable(workspace.constitution_binding)) {
      findings.push(`constitution binding mismatch for '${selection.feature_id}'`);
    }
    const constitution = readCtoSpecificationConstitution(root, workspace, handoff, pinnedRoot);
    if (!constitution.ok) {
      findings.push(selection.feature_id + ": " + constitution.finding);
      continue;
    }
    const readiness = evaluateHandoffReadiness(handoff, { current_constitution_binding: constitution.binding });
    if (!readiness.ok) findings.push(`handoff readiness for '${selection.feature_id}': ${readiness.error}`);
    if (findings.length === 0 || !findings.some((finding) => finding.includes(`'${selection.feature_id}'`))) {
      prepared.push({ feature_id: selection.feature_id, run_key: selection.run_key, handoff });
    }
  }

  if (findings.length > 0 || prepared.length !== seen.size) {
    return { status: "blocked", findings, dispatched: false };
  }
  try {
    const mapping = buildCtoSpecificationMapping({ selections: prepared });
    return { status: "ready", mapping, findings: [], dispatched: false };
  } catch (error) {
    return { status: "blocked", findings: [`mapping construction failed: ${error instanceof Error ? error.message : String(error)}`], dispatched: false };
  }
}
