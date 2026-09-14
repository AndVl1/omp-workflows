/**
 * Readable multi-workspace CTO specification review packet (T104).
 *
 * Read-only projection: no field in this packet grants approval or execution
 * authority. State discovery is confined to canonical regular files below the
 * real project root and rejects symlinks before parsing.
 */
import {
  existsSync,
  lstatSync,
  readdirSync,
  realpathSync,
} from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import type {
  FeatureWorkspace,
  WorkspacePhase,
  WorkspacePhaseRecord,
} from "../specification/types.js";
import { mapSpecificationPhaseDecision } from "../specification/phase.js";
import {
  isRecord,
  isSafeFeatureId,
  validateFeatureWorkspaceRecord,
} from "../specification/validation.js";
import { MAX_PERSISTED_STATE_BYTES, parseBoundedPersistedState } from "../engine/state.js";
import { readCanonicalBoundedJson, readCanonicalBoundedJsonAtRoot } from "../specification/canonical-reader.js";
import { SPECIFICATION_STATE_ROOT } from "../specification/workspace.js";
import {
  readCtoSpecificationDecisions,
  type CtoSpecificationDecision,
  type CtoSpecificationDecisionValue,
} from "./decisions.js";
import { isSafeCtoRunId } from "./state.js";
import type { PinnedProjectRoot } from "../specification/pinned-root.js";

export type CtoSpecificationReviewCode =
  | "CTO_REVIEW_RUN_INVALID"
  | "CTO_REVIEW_STATE_INVALID"
  | "CTO_REVIEW_DECISIONS_INVALID";

export type CtoSpecificationReviewResult<T> =
  | { ok: true; value: T }
  | { ok: false; code: CtoSpecificationReviewCode; error: string };

export const CTO_REVIEW_AUTHORITY_STATEMENT =
  "This packet grants no approval. It is a read-only review surface over the durable specification workspaces and the trusted decisions already recorded for this CTO run; it authorizes nothing, starts no execution, and never substitutes for a trusted checkpoint answer or the engine's own capability checks.";

const MAX_REVIEW_FEATURE_ENTRIES = 4096;
const MAX_REVIEW_FEATURE_NAME_BYTES = 4 * 1024 * 1024;

const PHASE_ORDER: Readonly<Record<WorkspacePhase, number>> = {
  specify: 0,
  plan: 1,
  tasks: 2,
};

function assertSafeCtoRunId(ctoRunId: unknown): string {
  if (!isSafeCtoRunId(ctoRunId)) {
    throw new Error(`CTO_REVIEW_RUN_INVALID: unsafe CTO run id ${JSON.stringify(ctoRunId ?? null)}`);
  }
  return ctoRunId;
}

export function ctoSpecificationReviewPacketRef(ctoRunId: string): string {
  return `cto.specification-review-packet.${assertSafeCtoRunId(ctoRunId)}`;
}

export interface CtoSpecificationReviewPhaseRow {
  phase: WorkspacePhase;
  status: WorkspacePhaseRecord["status"];
  version: number | null;
  approved_version: number | null;
  validation_ref: string | null;
  checkpoint_ref: string | null;
  decision: CtoSpecificationDecisionValue | null;
  decision_checkpoint_ref: string | null;
  trusted_answer_ref: string | null;
  next_action: string;
}

export interface CtoSpecificationReviewFeatureRow {
  feature_id: string;
  run_key: string;
  display_name: string;
  workspace_status: FeatureWorkspace["status"];
  workspace_next_action: string;
  handoff_ref: string | null;
  phases: CtoSpecificationReviewPhaseRow[];
}

export interface CtoSpecificationReviewDecisionRow {
  feature_id: string;
  run_key: string;
  phase: WorkspacePhase;
  decision: CtoSpecificationDecisionValue;
  checkpoint_ref: string;
  trusted_answer_ref: string;
}

export interface CtoSpecificationReviewPacket {
  schema_version: 1;
  packet_ref: string;
  cto_run_id: string;
  grants_approval: false;
  authority_statement: string;
  features: CtoSpecificationReviewFeatureRow[];
  recorded_decisions: CtoSpecificationReviewDecisionRow[];
  decision_count: number;
}

function fail<T>(code: CtoSpecificationReviewCode, error: string): CtoSpecificationReviewResult<T> {
  return { ok: false, code, error };
}

function decisionKey(featureId: string, phase: WorkspacePhase, checkpointRef: string): string {
  return `${featureId}\u0000${phase}\u0000${checkpointRef}`;
}

function projectedDecision(decision: CtoSpecificationDecision): CtoSpecificationReviewDecisionRow {
  return {
    feature_id: decision.feature_id,
    run_key: decision.run_key,
    phase: decision.phase,
    decision: decision.decision,
    checkpoint_ref: decision.checkpoint_ref,
    trusted_answer_ref: decision.trusted_answer_ref,
  };
}

function decidedNextAction(phase: WorkspacePhase, decision: CtoSpecificationDecisionValue): string {
  const mapped = mapSpecificationPhaseDecision({ phase, decision });
  if (decision === "approve_continue") {
    return mapped.resume_next_phase
      ? `approved by trusted decision; resume and dispatch ${mapped.resume_next_phase}`
      : `approved by trusted decision; ${phase} is terminal`;
  }
  if (decision === "approve_stop") {
    return mapped.resume_next_phase
      ? `stop approved by trusted decision; the run ends at the ${phase} boundary (${mapped.resume_next_phase} is not dispatched)`
      : `stop approved by trusted decision; the run ends at the terminal ${phase} boundary`;
  }
  return `revision required by trusted decision; re-enter ${phase} with the recorded feedback`;
}

function undecidedNextAction(record: WorkspacePhaseRecord): string {
  switch (record.status) {
    case "awaiting_approval": return "open checkpoint awaits a trusted human decision";
    case "approved": return "phase approval is durable; nothing pending";
    case "revision_required": return "revision required before the checkpoint can reopen";
    case "stale": return `stale: ${record.stale_reason ?? "upstream revision"}`;
    case "not_started": return "phase not started";
    case "blocked": return "phase blocked";
    default: return `phase ${record.status}; not yet open for review`;
  }
}

interface WorkspaceEnvelope {
  run_key: string;
  workspace: FeatureWorkspace;
}

function canonicalProjectRoot(projectRoot: string): string {
  if (typeof projectRoot !== "string" || projectRoot.trim().length === 0) {
    throw new Error("projectRoot must be a non-blank string");
  }
  const root = realpathSync(resolve(projectRoot));
  if (!lstatSync(root).isDirectory()) throw new Error("projectRoot is not a directory");
  return root;
}

function assertContainedNode(
  root: string,
  candidate: string,
  kind: "directory" | "file",
  allowMissing = false,
): string {
  const target = resolve(candidate);
  const rel = relative(root, target);
  if (rel.startsWith("..") || isAbsolute(rel)) throw new Error(`path '${target}' escapes project root '${root}'`);
  let current = root;
  const segments = rel === "" ? [] : rel.split(/[\\/]/);
  for (let index = 0; index < segments.length; index += 1) {
    current = join(current, segments[index]!);
    let stats;
    try {
      stats = lstatSync(current);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT" && allowMissing) return target;
      throw error;
    }
    if (stats.isSymbolicLink()) throw new Error(`symlinked state path component '${current}' is forbidden`);
    const leaf = index === segments.length - 1;
    if (!leaf && !stats.isDirectory()) throw new Error(`state path ancestor '${current}' is not a directory`);
    if (leaf && kind === "directory" && !stats.isDirectory()) throw new Error(`state path '${current}' is not a directory`);
    if (leaf && kind === "file" && !stats.isFile()) throw new Error(`state path '${current}' is not a regular file`);
  }
  if (existsSync(target) && realpathSync(target) !== target) throw new Error(`state path '${target}' is not canonical`);
  return target;
}
function readWorkspaceEnvelope(
  root: string,
  statePath: string,
  featureId: string,
  pinnedRoot?: PinnedProjectRoot,
): { ok: true; value: WorkspaceEnvelope } | { ok: false; error: string } {


  const relativeStatePath = pinnedRoot
    ? (statePath.startsWith(".work-state/") ? statePath : relative(root, statePath))
    : relative(root, statePath);
  const loaded = pinnedRoot
    ? readCanonicalBoundedJson(pinnedRoot, relativeStatePath, MAX_PERSISTED_STATE_BYTES, `state for feature '${featureId}'`)
    : readCanonicalBoundedJsonAtRoot(root, relativeStatePath, MAX_PERSISTED_STATE_BYTES, `state for feature '${featureId}'`);
  if (!loaded.ok) return { ok: false, error: loaded.error };
  const bounded = parseBoundedPersistedState(loaded.value);
  if (!bounded) return { ok: false, error: `state for feature '${featureId}' exceeds bounded structural limits or has an unsafe object shape` };
  const specification = bounded.specification;
  if (!isRecord(specification)) return { ok: false, error: `state for feature '${featureId}' carries no specification aggregate` };
  const runKey = bounded.run_key;
  if (typeof runKey !== "string" || runKey.trim().length === 0) {
    return { ok: false, error: `state for feature '${featureId}' carries no explicit run_key` };
  }
  const validation = validateFeatureWorkspaceRecord(specification);
  if (!validation.ok) {
    return { ok: false, error: `invalid specification aggregate for feature '${featureId}': ${validation.issues.join("; ")}` };
  }
  if (specification.feature_id !== featureId) {
    return { ok: false, error: `feature state at '${featureId}' carries foreign identity '${String(specification.feature_id)}'` };
  }
  if (realpathSync(resolve(String(specification.project_root))) !== root) {
    return { ok: false, error: `feature state at '${featureId}' carries a foreign project root` };
  }
  return {
    ok: true,
    value: { run_key: runKey, workspace: specification as unknown as FeatureWorkspace },
  };
}

function workspaceNextActionText(workspace: FeatureWorkspace): string {
  const action = workspace.next_action;
  if (!action) return "none";
  const command = action.command ? ` (${action.command})` : "";
  return `${action.kind}${command}: ${action.reason}`;
}

function buildCtoSpecificationReviewPacketFromDecisions(
  projectRoot: string,
  input: { cto_run_id: string },
  decisionSnapshot?: readonly CtoSpecificationDecision[],
  pinnedRoot?: PinnedProjectRoot,
  allowedFeatureIds?: ReadonlySet<string>,
): CtoSpecificationReviewResult<CtoSpecificationReviewPacket> {
  let ctoRunId: string;
  try {
    ctoRunId = assertSafeCtoRunId(input?.cto_run_id);
  } catch (error) {
    return fail("CTO_REVIEW_RUN_INVALID", error instanceof Error ? error.message : String(error));
  }

  let root: string;
  try {
    root = pinnedRoot ? pinnedRoot.canonical_root : canonicalProjectRoot(projectRoot);
    if (pinnedRoot && !pinnedRoot.isStable()) return fail("CTO_REVIEW_STATE_INVALID", "pinned project root changed before packet reads");
  } catch (error) {
    return fail("CTO_REVIEW_STATE_INVALID", `unsafe project root: ${String(error)}`);
  }

  let decisions: CtoSpecificationDecision[];
  if (decisionSnapshot !== undefined) {
    // The CTO preparation critical section supplies the exact ledger snapshot
    // it reread while holding the run lock. Clone it before projecting so a
    // caller cannot mutate the packet's source after this point.
    decisions = decisionSnapshot.map((decision) => ({
      ...decision,
      trusted_proof: { ...decision.trusted_proof },
    }));
  } else {
    try {
      decisions = readCtoSpecificationDecisions(root, ctoRunId);
    } catch (error) {
      return fail("CTO_REVIEW_DECISIONS_INVALID", error instanceof Error ? error.message : String(error));
    }
  }

  const featuresRoot = join(root, SPECIFICATION_STATE_ROOT);
  const features: CtoSpecificationReviewFeatureRow[] = [];
  const workspaceByFeature = new Map<string, WorkspaceEnvelope>();
  if (pinnedRoot) {
    try {
      if (allowedFeatureIds) {
        const selectedFeatureIds: string[] = [];
        let selectedNameBytes = 0;
        for (const featureId of allowedFeatureIds) {
          if (!isSafeFeatureId(featureId)) {
            return fail("CTO_REVIEW_STATE_INVALID", `unsafe allowed feature id ${JSON.stringify(featureId)}`);
          }
          selectedFeatureIds.push(featureId);
          selectedNameBytes += Buffer.byteLength(featureId, "utf8");
        }
        if (selectedFeatureIds.length > MAX_REVIEW_FEATURE_ENTRIES || selectedNameBytes > MAX_REVIEW_FEATURE_NAME_BYTES) {
          return fail("CTO_REVIEW_STATE_INVALID", "allowed feature selection exceeds its bounded limit");
        }
        selectedFeatureIds.sort((left, right) => left.localeCompare(right));
        for (const featureId of selectedFeatureIds) {
          const statePath = join(SPECIFICATION_STATE_ROOT, featureId, "state.json");
          const info = pinnedRoot.pathEntryInfo(statePath);
          if (!info) {
            return fail("CTO_REVIEW_STATE_INVALID", `canonical state for allowed feature '${featureId}' is missing`);
          }
          if (info.kind !== "file") {
            return fail("CTO_REVIEW_STATE_INVALID", `canonical state for allowed feature '${featureId}' is not a regular file`);
          }
          const envelope = readWorkspaceEnvelope(root, statePath, featureId, pinnedRoot);
          if (!envelope.ok) return fail("CTO_REVIEW_STATE_INVALID", envelope.error);
          workspaceByFeature.set(featureId, envelope.value);
        }
      } else if (pinnedRoot.pathEntryExists(SPECIFICATION_STATE_ROOT)) {
        const entries = pinnedRoot.listDirectory(SPECIFICATION_STATE_ROOT, { maxEntries: MAX_REVIEW_FEATURE_ENTRIES, maxNameBytes: MAX_REVIEW_FEATURE_NAME_BYTES }).sort((left, right) => left.localeCompare(right));
        for (const featureId of entries) {
          if (!isSafeFeatureId(featureId)) {
            return fail("CTO_REVIEW_STATE_INVALID", `unsafe feature directory name ${JSON.stringify(featureId)} under ${SPECIFICATION_STATE_ROOT}`);
          }
          const statePath = join(SPECIFICATION_STATE_ROOT, featureId, "state.json");
          if (!pinnedRoot.pathEntryExists(statePath)) continue;
          const envelope = readWorkspaceEnvelope(root, statePath, featureId, pinnedRoot);
          if (!envelope.ok) return fail("CTO_REVIEW_STATE_INVALID", envelope.error);
          workspaceByFeature.set(featureId, envelope.value);
        }
      }
    } catch (error) {
      return fail("CTO_REVIEW_STATE_INVALID", `unsafe feature state root: ${String(error)}`);
    }
  } else if (existsSync(featuresRoot)) {
    try {
      assertContainedNode(root, featuresRoot, "directory");
    } catch (error) {
      return fail("CTO_REVIEW_STATE_INVALID", `unsafe feature state root: ${String(error)}`);
    }
    const entries = readdirSync(featuresRoot, { withFileTypes: true });
    if (entries.length > MAX_REVIEW_FEATURE_ENTRIES || entries.reduce((total, entry) => total + Buffer.byteLength(entry.name, "utf8"), 0) > MAX_REVIEW_FEATURE_NAME_BYTES) {
      return fail("CTO_REVIEW_STATE_INVALID", "feature state enumeration exceeds its bounded limit");
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (entry.isSymbolicLink()) {
        return fail("CTO_REVIEW_STATE_INVALID", `symlinked feature state entry ${JSON.stringify(entry.name)} is forbidden`);
      }
      if (!entry.isDirectory()) continue;
      const featureId = entry.name;
      if (!isSafeFeatureId(featureId)) {
        return fail("CTO_REVIEW_STATE_INVALID", `unsafe feature directory name ${JSON.stringify(featureId)} under ${SPECIFICATION_STATE_ROOT}`);
      }
      const statePath = join(featuresRoot, featureId, "state.json");
      let stateStats;
      try {
        stateStats = lstatSync(statePath);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
        return fail("CTO_REVIEW_STATE_INVALID", `cannot inspect state for feature : ${String(error)}`);
      }
      if (stateStats.isSymbolicLink() || !stateStats.isFile()) {
        return fail("CTO_REVIEW_STATE_INVALID", `state for feature  must be a non-symlink regular file`);
      }
      const envelope = readWorkspaceEnvelope(root, statePath, featureId);
      if (!envelope.ok) return fail("CTO_REVIEW_STATE_INVALID", envelope.error);
      workspaceByFeature.set(featureId, envelope.value);
    }
  }

  const decisionByCheckpoint = new Map<string, CtoSpecificationDecision>();
  for (const decision of decisions) {
    if (allowedFeatureIds && !allowedFeatureIds.has(decision.feature_id)) {
      return fail("CTO_REVIEW_DECISIONS_INVALID", `decision '${decision.trusted_answer_ref}' targets a feature outside the active preparation wave`);
    }
    const envelope = workspaceByFeature.get(decision.feature_id);
    const record = envelope?.workspace.phases.find((phase) => phase.phase === decision.phase);
    const exactVersion = record?.current_version !== null
      && record?.current_version !== undefined
      && decision.checkpoint_ref === `checkpoint.${decision.phase}.v${record.current_version}`;
    if (
      !envelope
      || envelope.run_key !== decision.run_key
      || !record
      || !exactVersion
      || record.checkpoint_ref !== decision.checkpoint_ref
      || (record.status !== "awaiting_approval" && record.status !== "approved")
    ) {
      return fail(
        "CTO_REVIEW_DECISIONS_INVALID",
        `decision '${decision.trusted_answer_ref}' does not match the exact feature/run/phase/checkpoint currently recorded`,
      );
    }
    const key = decisionKey(decision.feature_id, decision.phase, decision.checkpoint_ref);
    if (decisionByCheckpoint.has(key)) {
      return fail("CTO_REVIEW_DECISIONS_INVALID", `multiple decisions target exact checkpoint '${decision.checkpoint_ref}'`);
    }
    decisionByCheckpoint.set(key, decision);
  }

  for (const [featureId, envelope] of workspaceByFeature) {
    if (allowedFeatureIds && !allowedFeatureIds.has(featureId)) continue;
    const workspace = envelope.workspace;
    const phaseRows = [...workspace.phases]
      .sort((a, b) => PHASE_ORDER[a.phase] - PHASE_ORDER[b.phase])
      .map((record): CtoSpecificationReviewPhaseRow => {
        const decision = record.checkpoint_ref
          ? decisionByCheckpoint.get(decisionKey(featureId, record.phase, record.checkpoint_ref)) ?? null
          : null;
        return {
          phase: record.phase,
          status: record.status,
          version: record.current_version,
          approved_version: record.approved_version,
          validation_ref: record.validation_ref,
          checkpoint_ref: record.checkpoint_ref,
          decision: decision?.decision ?? null,
          decision_checkpoint_ref: decision?.checkpoint_ref ?? null,
          trusted_answer_ref: decision?.trusted_answer_ref ?? null,
          next_action: decision
            ? decidedNextAction(record.phase, decision.decision)
            : undecidedNextAction(record),
        };
      });
    features.push({
      feature_id: workspace.feature_id,
      run_key: envelope.run_key,
      display_name: workspace.display_name,
      workspace_status: workspace.status,
      workspace_next_action: workspaceNextActionText(workspace),
      handoff_ref: workspace.handoff_ref,
      phases: phaseRows,
    });
  }

  if (pinnedRoot && !pinnedRoot.isStable()) return fail("CTO_REVIEW_STATE_INVALID", "pinned project root changed after packet reads");
  return {
    ok: true,
    value: {
      schema_version: 1,
      packet_ref: ctoSpecificationReviewPacketRef(ctoRunId),
      cto_run_id: ctoRunId,
      grants_approval: false,
      authority_statement: CTO_REVIEW_AUTHORITY_STATEMENT,
      features,
      recorded_decisions: decisions.map(projectedDecision),
      decision_count: decisions.length,
    },
  };
}

export function buildCtoSpecificationReviewPacket(
  projectRoot: string,
  input: { cto_run_id: string },
): CtoSpecificationReviewResult<CtoSpecificationReviewPacket> {
  return buildCtoSpecificationReviewPacketFromDecisions(projectRoot, input);
}

/**
 * Build a packet from a decision snapshot captured by a lock-owning CTO
 * operation. This avoids reacquiring the non-reentrant run lock while keeping
 * the normal public builder lock-safe for all other callers.
 */
/** Build a packet from an exact decision snapshot through a caller-owned root pin. */
export function buildCtoSpecificationReviewPacketFromDecisionSnapshotPinned(
  pinnedRoot: PinnedProjectRoot,
  input: { cto_run_id: string },
  decisions: readonly CtoSpecificationDecision[],
  allowedFeatureIds?: ReadonlySet<string>,
): CtoSpecificationReviewResult<CtoSpecificationReviewPacket> {
  return buildCtoSpecificationReviewPacketFromDecisions(pinnedRoot.canonical_root, input, decisions, pinnedRoot, allowedFeatureIds);
}

export function buildCtoSpecificationReviewPacketFromDecisionSnapshot(
  projectRoot: string,
  input: { cto_run_id: string },
  decisions: readonly CtoSpecificationDecision[],
): CtoSpecificationReviewResult<CtoSpecificationReviewPacket> {
  return buildCtoSpecificationReviewPacketFromDecisions(projectRoot, input, decisions);
}
