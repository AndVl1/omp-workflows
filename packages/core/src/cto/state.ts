/**
 * CtoState persistence + transitions.
 *
 * State lives in files (`.work-state/cto/<id>/state.json`) so parked teams
 * and pending escalations survive restarts, machine sleep, and compaction
 * (R7). The engine is the only writer; agents read through it.
 */

import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { isAbsolute, join, relative, resolve } from "node:path";
import { recordStageTransition } from "../observability/hooks.js";
import type { ModelClassification } from "../engine/run.js";
import {
  type CtoState,
  type BudgetState,
  type CtoControlPlaneFields,
  type EscalationRecord,
  type EscalationStatus,
  type TeamRunStatus,
  type TeamPlan,
  type WaveRecord,
} from "./types.js";
import { validateTypedControlPlane } from "../engine/workflow-contract.js";
import type { ControlPlaneProvenance, WorkIdentity } from "../engine/types.js";
import { createDiagnostic, failureResult, successResult } from "../workflow-v2/diagnostics.js";
import { validateWorkflowRunIdentity, isProviderId, isSafeCtoId, isWorkflowV2Digest } from "../workflow-v2/identity.js";
import type { DiagnosticResult, ProjectIdentity, WorkflowRunIdentity, AgentRef, ProfileIdentity } from "../workflow-v2/types.js";

export function ctoStateDir(runId: string, root: string): string {
  if (!isSafeCtoId(runId)) throw new Error("unsafe CTO run id");
  const workState = resolve(root, ".work-state");
  const ctoRoot = join(workState, "cto");
  const runDir = join(ctoRoot, runId);
  try {
    const realWorkState = existsSync(workState) ? realpathSync(workState) : workState;
    const realCtoRoot = existsSync(ctoRoot) ? realpathSync(ctoRoot) : join(realWorkState, "cto");
    const rootRel = relative(realWorkState, realCtoRoot);
    if (rootRel.startsWith("..") || isAbsolute(rootRel)) throw new Error("CTO path escapes .work-state");
    if (existsSync(runDir)) {
      const runRel = relative(realCtoRoot, realpathSync(runDir));
      if (runRel.startsWith("..") || isAbsolute(runRel)) throw new Error("CTO run path escapes .work-state/cto");
    }
  } catch (error) {
    if (error instanceof Error && /escapes/.test(error.message)) throw error;
    throw new Error("unsafe CTO state path");
  }
  return runDir;
}

function projectIdentityBindingKey(identity: ProjectIdentity): string {
  return JSON.stringify([
    identity.root_instance_id,
    identity.provider_id,
    identity.descriptor_fingerprint,
    identity.executable_provenance.build_fingerprint,
    identity.executable_provenance.runtime_fingerprint,
    identity.catalog_content_digest,
    identity.config_byte_sha256,
    identity.config_semantic_sha256,
    identity.session.session_id,
    identity.session.lifecycle_id,
  ]);
}

function runIdentityBindingKey(identity: WorkflowRunIdentity): string {
  return JSON.stringify([
    projectIdentityBindingKey(identity),
    identity.run_id,
    identity.profile_identity.id,
    identity.profile_identity.fingerprint,
  ]);
}

/** Compare complete project/provider pins, excluding run and profile selection. */
export function sameCtoProjectIdentity(left: ProjectIdentity, right: ProjectIdentity): boolean {
  return projectIdentityBindingKey(left) === projectIdentityBindingKey(right);
}

/** Compare complete durable run identity, including exact catalog profile. */
export function sameCtoRunIdentity(left: WorkflowRunIdentity, right: WorkflowRunIdentity): boolean {
  return runIdentityBindingKey(left) === runIdentityBindingKey(right);
}

/** Validate a durable CTO run identity and reject old/unattributed state. */
export function validateCtoRunIdentity(
  current: unknown,
  expected?: WorkflowRunIdentity,
): DiagnosticResult<WorkflowRunIdentity> {
  if (current === undefined || current === null) {
    return failureResult(createDiagnostic({
      code: "MIGRATION_REQUIRED",
      operation: "runtime.activate",
      evidence: { field: "cto.run_identity" },
      remediation: "Start a fresh CTO lifecycle with the run identity returned by workflow_prepare.",
    }));
  }
  const validated = validateWorkflowRunIdentity(current);
  if (!validated.ok) return validated;
  if (expected) {
    const expectedResult = validateWorkflowRunIdentity(expected);
    if (!expectedResult.ok) return expectedResult;
    if (!sameCtoRunIdentity(validated.value, expectedResult.value)) {
      return failureResult(createDiagnostic({
        code: "IDENTITY_MISMATCH",
        operation: "runtime.activate",
        evidence: {
          field: "cto.run_identity",
          provider_id: expectedResult.value.provider_id,
          run_id: expectedResult.value.run_id,
        },
        remediation: "Start a fresh CTO lifecycle for the changed project, provider, catalog, config, session, run, or profile identity.",
      }));
    }
  }
  return successResult(validated.value);
}

function assertCtoRunIdentity(current: unknown, expected?: WorkflowRunIdentity): WorkflowRunIdentity {
  const checked = validateCtoRunIdentity(current, expected);
  if (!checked.ok) throw new Error(checked.diagnostics.map((diagnostic) => diagnostic.code).join(","));
  return checked.value;
}

function validProfileIdentity(value: unknown): value is ProfileIdentity {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const profile = value as Record<string, unknown>;
  return typeof profile.id === "string"
    && profile.id.length > 0
    && profile.id === profile.id.trim()
    && /^[A-Za-z0-9@._:/#-]+$/u.test(profile.id)
    && isWorkflowV2Digest(profile.fingerprint);
}

function validAgentRef(value: unknown, providerId: string): value is AgentRef {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const agent = value as Record<string, unknown>;
  return typeof agent.registered_name === "string"
    && agent.registered_name.length > 0
    && agent.registered_name === agent.registered_name.trim()
    && /^[A-Za-z0-9@._:/#-]+$/u.test(agent.registered_name)
    && isProviderId(agent.provider_id)
    && agent.provider_id === providerId
    && isWorkflowV2Digest(agent.source_fingerprint);
}

export function ctoStatePath(runId: string, root: string): string {
  return join(ctoStateDir(runId, root), "state.json");
}

export function newCtoState(opts: {
  id: string;
  task: string;
  branch: string;
  autonomous: boolean;
  /**
   * Model-first PHASE-0 classification (authority for `autonomous`). When
   * present, it is persisted and mirrored into the top-level field.
   */
  classification?: ModelClassification;
  plan: TeamPlan;
  /** Exact run identity allocated by workflow_prepare for this CTO run. */
  run_identity: WorkflowRunIdentity;
  /** Standby runs are adoptable cross-session (inbox continuity). */
  standby?: boolean;
  /** Session that owns this interactive task run (foreign sessions do not amend it). */
  owner_session?: string;
}): CtoState {
  const runIdentity = assertCtoRunIdentity(opts.run_identity);
  if (opts.id !== runIdentity.run_id || opts.plan.id !== runIdentity.run_id) {
    throw new Error("IDENTITY_MISMATCH: CTO run id does not match workflow run identity");
  }
  if (!sameCtoRunIdentity(opts.plan.run_identity, runIdentity)) {
    throw new Error("IDENTITY_MISMATCH: CTO plan is not bound to the workflow run identity");
  }
  if (opts.owner_session && opts.owner_session !== runIdentity.session.session_id) {
    throw new Error("IDENTITY_MISMATCH");
  }
  const classification =
    opts.classification &&
    typeof opts.classification.type === "string" &&
    typeof opts.classification.complexity === "string" &&
    typeof opts.classification.confidence === "string" &&
    typeof opts.classification.autonomous === "boolean"
      ? opts.classification
      : undefined;
  return {
    schema: 2,
    id: opts.id,
    task: opts.task,
    branch: opts.branch,
    autonomous: classification ? classification.autonomous : opts.autonomous,
    ...(classification ? { classification } : {}),
    run_identity: runIdentity,
    plan: opts.plan,
    teams: opts.plan.teams.map((t) => {
      if (!t.run_identity || !t.profile_identity || !t.lead_ref || !t.roster_refs) {
        throw new Error(`MIGRATION_REQUIRED: team '${t.team}' lacks run, catalog, or qualified agent bindings`);
      }
      const teamRunIdentity = assertCtoRunIdentity(t.run_identity, runIdentity);
      if (!validProfileIdentity(t.profile_identity)
        || t.profile !== t.profile_identity.id) {
        throw new Error(`IDENTITY_MISMATCH: team '${t.team}' profile binding is not catalog-qualified`);
      }
      if (!validAgentRef(t.lead_ref, teamRunIdentity.provider_id)) {
        throw new Error(`MIGRATION_REQUIRED: team '${t.team}' lead binding is not provider-qualified`);
      }
      if (!Array.isArray(t.roster_refs) || !t.roster_refs.every((agent) => validAgentRef(agent, teamRunIdentity.provider_id))) {
        throw new Error(`MIGRATION_REQUIRED: team '${t.team}' roster binding is not provider-qualified`);
      }
      const rosterKeys = new Set(t.roster_refs.map((agent) => `${agent.registered_name}\u0000${agent.provider_id}\u0000${agent.source_fingerprint}`));
      if (rosterKeys.size !== t.roster_refs.length) {
        throw new Error(`MIGRATION_REQUIRED: team '${t.team}' roster contains duplicate agent bindings`);
      }
      return {
        id: t.team,
        status: "pending" as const,
        escalations: {},
        run_identity: teamRunIdentity,
        profile_identity: t.profile_identity,
        lead_ref: t.lead_ref,
        roster_refs: t.roster_refs,
      };
    }),
    integration: { status: "pending" },
    pause: { kind: "none", reason: "" },
    updated_at: new Date().toISOString(),
    ...(opts.standby === true ? { standby: true } : {}),
    ...(opts.owner_session ? { owner_session: opts.owner_session } : {}),
    budget: defaultBudgetShape(),
    leases: {},
    decisions: [],
    inbox_quarantine: {},
    wave_history: [],
  };
}

/** Default schema-2 budget shape (D3): all limits null, all accounting zero, no per-team spend. */
function defaultBudgetShape(): BudgetState {
  return {
    policy: { token_limit: null, dollar_limit: null, time_limit_ms: null },
    accounting: { tokens_estimated: 0, dollars_estimated: 0, elapsed_ms: 0, per_team: {} },
  };
}

/**
 * Validate the run-bound fields before applying explicit in-memory schema
 * defaults. This function never annotates an unbound record: callers must
 * provide the run identity in the raw bytes first.
 */
function normalizeControlPlaneFields(state: Record<string, unknown>): void {
  const checkedRunIdentity = validateCtoRunIdentity(state.run_identity);
  if (!checkedRunIdentity.ok) {
    throw new Error(checkedRunIdentity.diagnostics.map((diagnostic) => diagnostic.code).join(","));
  }
  state.run_identity = checkedRunIdentity.value;
  if (typeof state.id !== "string" || state.id !== checkedRunIdentity.value.run_id) {
    throw new Error("IDENTITY_MISMATCH: CTO state id does not match workflow run identity");
  }
  if (!state.plan || typeof state.plan !== "object" || Array.isArray(state.plan)) {
    throw new Error("MIGRATION_REQUIRED: CTO state has no run-bound plan");
  }
  const planRecord = state.plan as Record<string, unknown>;
  const checkedPlanIdentity = validateCtoRunIdentity(planRecord.run_identity, checkedRunIdentity.value);
  if (!checkedPlanIdentity.ok) {
    throw new Error(checkedPlanIdentity.diagnostics.map((diagnostic) => diagnostic.code).join(","));
  }
  planRecord.run_identity = checkedPlanIdentity.value;
  if (planRecord.id !== checkedRunIdentity.value.run_id) {
    throw new Error("IDENTITY_MISMATCH: CTO plan id does not match workflow run identity");
  }
  if (!Array.isArray(state.teams)) {
    throw new Error("CONFIG_MALFORMED: CTO teams are malformed");
  }
  for (const team of state.teams) {
    if (!team || typeof team !== "object" || Array.isArray(team)) {
      throw new Error("CONFIG_MALFORMED: CTO team state is malformed");
    }
    const teamRecord = team as Record<string, unknown>;
    const checkedTeamIdentity = validateCtoRunIdentity(teamRecord.run_identity, checkedRunIdentity.value);
    if (!checkedTeamIdentity.ok) {
      throw new Error(checkedTeamIdentity.diagnostics.map((diagnostic) => diagnostic.code).join(","));
    }
    teamRecord.run_identity = checkedTeamIdentity.value;
  }
  const validation = validateTypedControlPlane(state);
  if (!validation.ok) {
    const prior = state.control_plane_provenance;
    state.control_plane_provenance = {
      ...(prior && typeof prior === "object" ? prior as ControlPlaneProvenance : {}),
      warnings: validation.issues.map((issue) => `${issue.path} ${issue.message}`),
      status: "invalid",
    };
  }
}

/**
 * Explicit, in-memory schema migration for an already run-bound state.
 * Missing/changed identity is rejected; this function never adds identity to
 * legacy bytes and readCtoState never calls it without validating the bytes.
 */
export function migrateCtoState(raw: Record<string, unknown>): CtoState {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("CONFIG_MALFORMED");
  const state: Record<string, unknown> = { ...raw };
  const schema = typeof state.schema === "number" ? state.schema : 1;
  if (schema > 2) throw new Error("UNSUPPORTED_SCHEMA");
  if (schema < 2) state.schema = 2;
  if (state.budget === undefined) state.budget = defaultBudgetShape();
  if (state.leases === undefined) state.leases = {};
  if (state.decisions === undefined) state.decisions = [];
  if (state.inbox_quarantine === undefined) state.inbox_quarantine = {};
  if (state.wave_history === undefined) state.wave_history = [];

  normalizeControlPlaneFields(state);
  return state as unknown as CtoState;
}

export function readCtoState(
  runId: string,
  root: string,
  expectedIdentity: WorkflowRunIdentity,
): CtoState | null {
  try {
    const raw = JSON.parse(readFileSync(ctoStatePath(runId, root), "utf8")) as Record<string, unknown>;
    if (raw.id !== runId) return null;
    const checkedIdentity = validateCtoRunIdentity(raw.run_identity, expectedIdentity);
    if (!checkedIdentity.ok) return null;
    if (!raw.plan || typeof raw.plan !== "object" || Array.isArray(raw.plan)) return null;
    const checkedPlanIdentity = validateCtoRunIdentity(
      (raw.plan as Record<string, unknown>).run_identity,
      checkedIdentity.value,
    );
    if (!checkedPlanIdentity.ok) return null;
    const state = migrateCtoState(raw);
    if (state.control_plane_provenance?.status === "invalid") return null;
    return state;
  } catch {
    return null;
  }
}

/** Read a CTO run with a required identity and typed diagnostics. */
export function readBoundCtoState(
  runId: string,
  root: string,
  expectedIdentity: WorkflowRunIdentity,
): DiagnosticResult<CtoState> {
  const path = ctoStatePath(runId, root);
  let raw: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return failureResult(createDiagnostic({
        code: "CONFIG_MALFORMED",
        operation: "runtime.activate",
        evidence: { path },
        remediation: "Repair the persisted CTO state through an explicit v2 lifecycle.",
      }));
    }
    raw = parsed as Record<string, unknown>;
  } catch {
    return failureResult(createDiagnostic({
      code: "CONFIG_MALFORMED",
      operation: "runtime.activate",
      evidence: { path },
      remediation: "Repair the persisted CTO state through an explicit v2 lifecycle.",
    }));
  }
  if (raw.id !== runId) {
    return failureResult(createDiagnostic({
      code: "IDENTITY_MISMATCH",
      operation: "runtime.activate",
      evidence: { path, run_id: runId },
      remediation: "Start a fresh CTO lifecycle for the changed run identity.",
    }));
  }
  const checkedIdentity = validateCtoRunIdentity(raw.run_identity, expectedIdentity);
  if (!checkedIdentity.ok) return checkedIdentity;
  if (!raw.plan || typeof raw.plan !== "object" || Array.isArray(raw.plan)) {
    return failureResult(createDiagnostic({
      code: "CONFIG_MALFORMED",
      operation: "runtime.activate",
      evidence: { path },
      remediation: "Repair the persisted CTO plan through an explicit v2 lifecycle.",
    }));
  }
  const checkedPlanIdentity = validateCtoRunIdentity(
    (raw.plan as Record<string, unknown>).run_identity,
    checkedIdentity.value,
  );
  if (!checkedPlanIdentity.ok) return checkedPlanIdentity;
  let state: CtoState;
  try {
    state = migrateCtoState(raw);
  } catch {
    return failureResult(createDiagnostic({
      code: "MIGRATION_REQUIRED",
      operation: "runtime.activate",
      evidence: { path, run_id: runId },
      remediation: "Migrate the persisted CTO control plane through an explicit run-bound lifecycle.",
    }));
  }
  if (state.control_plane_provenance?.status === "invalid") {
    return failureResult(createDiagnostic({
      code: "MIGRATION_REQUIRED",
      operation: "runtime.activate",
      evidence: { path },
      remediation: "Migrate the persisted CTO control plane before resuming.",
    }));
  }
  return successResult(state);
}

export function writeCtoState(
  state: CtoState,
  root: string,
  expectedIdentity?: WorkflowRunIdentity,
): string {
  const identity = assertCtoRunIdentity(state.run_identity, expectedIdentity);
  if (state.id !== identity.run_id || state.plan.id !== identity.run_id || !sameCtoRunIdentity(state.plan.run_identity, identity)) {
    throw new Error("IDENTITY_MISMATCH: CTO state does not match workflow run identity");
  }
  for (const team of state.teams) assertCtoRunIdentity(team.run_identity, identity);
  if (state.control_plane_provenance?.status === "invalid") throw new Error("MIGRATION_REQUIRED");
  const path = ctoStatePath(state.id, root);
  if (existsSync(path)) {
    let existing: unknown;
    try {
      existing = JSON.parse(readFileSync(path, "utf8"));
    } catch {
      throw new Error("CONFIG_MALFORMED: existing CTO state is unreadable");
    }
    if (!existing || typeof existing !== "object" || Array.isArray(existing)) {
      throw new Error("CONFIG_MALFORMED: existing CTO state is malformed");
    }
    const checkedExisting = validateCtoRunIdentity((existing as Record<string, unknown>).run_identity, identity);
    if (!checkedExisting.ok) throw new Error(checkedExisting.diagnostics.map((diagnostic) => diagnostic.code).join(","));
  }
  const dir = ctoStateDir(state.id, root);
  mkdirSync(dir, { recursive: true });
  state.updated_at = new Date().toISOString();
  const serialized = JSON.stringify(state, null, 2);
  const tempPath = join(dir, `.state.${randomUUID()}.tmp`);
  try {
    writeFileSync(tempPath, serialized);
    renameSync(tempPath, path);
  } catch (error) {
    try {
      unlinkSync(tempPath);
    } catch {
      // Best-effort cleanup must not hide the original I/O error.
    }
    throw error;
  }
  return path;
}

/**
 * Resolve the authoritative autonomous flag for a CTO run, model-first:
 * - `classification.autonomous` (the model's PHASE-0 decision) is the
 *   AUTHORITY whenever a classification is present — the top-level field
 *   can never override it (new state mirrors the classification, so the two
 *   agree by construction; a legacy file with both must honor the model).
 * - The top-level `autonomous` field is the fallback ONLY when the
 *   classification is absent: legacy runs and the engine-created standby
 *   exception (no user task, nothing to classify).
 */
export function resolveCtoAutonomous(state: Pick<CtoState, "classification" | "autonomous">): boolean {
  const model = state.classification?.autonomous;
  if (model !== undefined) return model;
  return state.autonomous;
}

function teamOf(state: CtoState, teamId: string): CtoState["teams"][number] | undefined {
  return state.teams.find((t) => t.id === teamId);
}
/** Transition one team's run status; persists when a root is given. */
export function setTeamStatus(
  state: CtoState,
  teamId: string,
  status: TeamRunStatus,
  root: string | null = null,
  runIdentity?: WorkflowRunIdentity,
): CtoState {
  const identity = assertCtoRunIdentity(state.run_identity, runIdentity);
  const team = teamOf(state, teamId);
  if (team) {
    assertCtoRunIdentity(team.run_identity, identity);
    team.status = status;
  }
  if (root) {
    writeCtoState(state, root, identity);
    try {
      recordStageTransition(root, { stageId: teamId, stageStatus: status, runId: state.id });
    } catch {
      // best-effort telemetry — never blocks the state write
    }
  }
  return state;
}

/** Record an escalation for a team; persists when a root is given. */
export function setEscalation(
  state: CtoState,
  teamId: string,
  escId: string,
  record: EscalationRecord,
  root: string | null = null,
  runIdentity?: WorkflowRunIdentity,
): CtoState {
  const identity = assertCtoRunIdentity(state.run_identity, runIdentity);
  const team = teamOf(state, teamId);
  if (team) {
    assertCtoRunIdentity(team.run_identity, identity);
    team.escalations[escId] = record;
  }
  if (root) writeCtoState(state, root, identity);
  return state;
}

export function setEscalationStatus(
  state: CtoState,
  teamId: string,
  escId: string,
  status: EscalationStatus,
  root: string | null = null,
  runIdentity?: WorkflowRunIdentity,
): CtoState {
  const identity = assertCtoRunIdentity(state.run_identity, runIdentity);
  const team = teamOf(state, teamId);
  if (team) {
    assertCtoRunIdentity(team.run_identity, identity);
    const record = team.escalations[escId];
    if (record) record.status = status;
  }
  if (root) writeCtoState(state, root, identity);
  return state;
}

/** Mark the integration phase; persists when a root is given. */
export function setIntegration(
  state: CtoState,
  status: CtoState["integration"]["status"],
  note: string | undefined,
  root: string | null = null,
  runIdentity?: WorkflowRunIdentity,
): CtoState {
  const identity = assertCtoRunIdentity(state.run_identity, runIdentity);
  state.integration = { status, note };
  if (root) writeCtoState(state, root, identity);
  return state;
}

export function setCtoPause(
  state: CtoState,
  kind: CtoState["pause"]["kind"],
  reason: string,
  root: string | null = null,
  runIdentity?: WorkflowRunIdentity,
): CtoState {
  const identity = assertCtoRunIdentity(state.run_identity, runIdentity);
  state.pause = { kind, reason };
  if (root) writeCtoState(state, root, identity);
  return state;
}

/** Stamp a mid-run amendment (br-k19); persists when a root is given. */
export function markAmended(
  state: CtoState,
  root: string | null = null,
  runIdentity?: WorkflowRunIdentity,
): CtoState {
  const identity = assertCtoRunIdentity(state.run_identity, runIdentity);
  state.amended_at = new Date().toISOString();
  if (root) writeCtoState(state, root, identity);
  return state;
}

// ── Typed control-plane projection (schema-2 additive; cto-core owns writes) ──

function assertTypedControlPlane(value: unknown): void {
  const validation = validateTypedControlPlane(value);
  if (!validation.ok) {
    throw new Error(`invalid typed control-plane update: ${validation.issues.map((issue) => `${issue.path} ${issue.message}`).join("; ")}`);
  }
}

function assignDefined(target: Record<string, unknown>, patch: Record<string, unknown>): void {
  for (const [key, value] of Object.entries(patch)) {
    if (value !== undefined) target[key] = value;
  }
}

/**
 * Merge a contract-valid typed control-plane projection into run state;
 * persists when a root is given. Undefined patch entries never erase an
 * existing field. Validation runs BEFORE the merge.
 */
export function setCtoControlPlane(
  state: CtoState,
  fields: Partial<CtoControlPlaneFields>,
  root: string | null = null,
  runIdentity?: WorkflowRunIdentity,
): CtoState {
  const requestedIdentity = fields.run_identity ?? runIdentity;
  const identity = assertCtoRunIdentity(state.run_identity, requestedIdentity);
  if (fields.run_identity) assertCtoRunIdentity(fields.run_identity, identity);
  assertTypedControlPlane({ ...state, ...fields });
  assignDefined(state as unknown as Record<string, unknown>, fields as Record<string, unknown>);
  if (root) writeCtoState(state, root, identity);
  return state;
}

/**
 * Merge a contract-valid typed control-plane projection into ONE team slice
 * entry; persists when a root is given. Same validation contract as
 * setCtoControlPlane.
 */
export function setTeamControlPlane(
  state: CtoState,
  teamId: string,
  fields: Partial<Omit<CtoControlPlaneFields, "child_joins" | "migration" | "control_plane_provenance" | "control_plane_status">>,
  root: string | null = null,
  runIdentity?: WorkflowRunIdentity,
): CtoState {
  const team = teamOf(state, teamId);
  if (!team) return state;
  const requestedIdentity = fields.run_identity ?? runIdentity;
  const identity = assertCtoRunIdentity(state.run_identity, requestedIdentity);
  assertCtoRunIdentity(team.run_identity, identity);
  if (fields.run_identity) assertCtoRunIdentity(fields.run_identity, identity);
  assertTypedControlPlane({ ...team, ...fields });
  assignDefined(team as unknown as Record<string, unknown>, fields as Record<string, unknown>);
  if (root) writeCtoState(state, root, identity);
  return state;
}

// ── Resident control-plane: wave lifecycle (schema-2 additive) ─────────────

/**
 * True when the run is a CTO resident: the standby marker makes a run
 * adoptable cross-session and keeps it ACTIVE after wave completion.
 * Pure check — `state.standby === true` (contract: resident marker).
 */
export function isCtoResident(state: Pick<CtoState, "standby">): boolean {
  return state.standby === true;
}

/**
 * Admit a work wave (state_contract.wave_history). IDEMPOTENT on transport
 * `source_id`: when a record with the same `source_id` already exists the
 * state is returned UNCHANGED (no second record, `active_wave_id` untouched)
 * — a duplicate inbound message must never start a second wave. Otherwise the
 * record is appended with status "active" and `active_wave_id` is set.
 * Persists when a root is given (same pattern as setTeamStatus).
 */
export function appendWave(
  state: CtoState,
  opts: {
    id: string;
    source: string;
    source_id: string;
    task: string;
    slice_ids?: string[];
    work_identity?: WorkIdentity;
    run_identity: WorkflowRunIdentity;
    now?: string;
  },
  root: string | null = null,
): CtoState {
  const identity = assertCtoRunIdentity(state.run_identity, opts.run_identity);
  const history = state.wave_history ?? [];
  if (history.some((w) => w.source_id === opts.source_id)) return state;
  if (opts.work_identity) assertTypedControlPlane({ work_identity: opts.work_identity });
  const record: WaveRecord = {
    id: opts.id,
    source: opts.source,
    source_id: opts.source_id,
    task: opts.task,
    slice_ids: opts.slice_ids ?? [],
    status: "active",
    started_at: opts.now ?? new Date().toISOString(),
    ...(opts.work_identity ? { work_identity: opts.work_identity } : {}),
    run_identity: identity,
  };
  history.push(record);
  state.wave_history = history;
  state.active_wave_id = opts.id;
  if (root) writeCtoState(state, root, identity);
  return state;
}

export function finishWave(
  state: CtoState,
  opts: { id: string; status: "done" | "failed"; run_identity: WorkflowRunIdentity; now?: string },
  root: string | null = null,
): CtoState {
  const identity = assertCtoRunIdentity(state.run_identity, opts.run_identity);
  const record = (state.wave_history ?? []).find((w) => w.id === opts.id);
  if (!record) return state;
  assertCtoRunIdentity(record.run_identity, identity);
  record.status = opts.status;
  record.finished_at = opts.now ?? new Date().toISOString();
  if (state.active_wave_id === opts.id) delete state.active_wave_id;
  if (root) writeCtoState(state, root, identity);
  return state;
}

/**
 * The currently running wave: the wave_history record with status "active"
 * whose id matches `active_wave_id`. No active_wave_id → null.
 */
export function activeWave(state: CtoState): WaveRecord | null {
  if (!state.active_wave_id) return null;
  const record = (state.wave_history ?? []).find((w) => w.id === state.active_wave_id);
  return record && record.status === "active" ? record : null;
}

/** Find a wave record by its transport source_id (dedup / admission lookup). */
export function findWaveBySourceId(state: CtoState, sourceId: string): WaveRecord | null {
  return (state.wave_history ?? []).find((w) => w.source_id === sourceId) ?? null;
}

/**
 * Expire pending escalations whose timeout elapsed. `timeout_ms: 0`/absent
 * (blocker default) never expires — the team stays parked and the rest of
 * the run continues (interview Q4). Returns the expired escalation ids.
 */
export function expireEscalations(state: CtoState, now: number): string[] {
  const expired: string[] = [];
  for (const team of state.teams) {
    for (const [escId, record] of Object.entries(team.escalations)) {
      const timeoutMs = record.timeout_ms ?? 0;
      if (record.status !== "pending" || timeoutMs <= 0 || !record.sent_at) continue;
      if (now - Date.parse(record.sent_at) >= timeoutMs) {
        record.status = "expired";
        expired.push(escId);
      }
    }
  }
  return expired;
}

/** All pending escalations across ACTIVE teams (for adapter re-send on session start, R7). */
export function pendingEscalations(state: CtoState): Array<{ teamId: string; escId: string; record: EscalationRecord }> {
  const out: Array<{ teamId: string; escId: string; record: EscalationRecord }> = [];
  for (const team of state.teams) {
    if (team.status !== "pending" && team.status !== "in_progress" && team.status !== "parked") continue;
    for (const [escId, record] of Object.entries(team.escalations)) {
      if (record.status === "pending") out.push({ teamId: team.id, escId, record });
    }
  }
  return out;
}

/** Teams not yet finished (pending | in_progress | parked). */
export function activeTeams(state: CtoState): string[] {
  return state.teams.filter((t) => t.status === "pending" || t.status === "in_progress" || t.status === "parked").map((t) => t.id);
}

/**
 * True when the run is finished and must not be selected as active (RC5).
 * A run is terminal when its pause is done/failed, or when ALL teams are
 * done/failed AND integration is done — even when the pause was never
 * stamped done/failed (e.g. runs whose wave completed through the engine
 * without a pause transition).
 *
 * Resident carve-out (state_contract.resident): an explicit stop/failure
 * (pause done/failed) is ALWAYS terminal — the first check — but a run with
 * `standby: true` (the CTO resident marker) stays ACTIVE after wave
 * completion: teams done + integration done only closes the wave, the
 * resident run returns to standby and awaits the next inbox task. Non-resident
 * runs keep the legacy terminality verbatim.
 *
 * Legacy/non-canonical state may lack `pause` entirely (pre-pause writers;
 * migrateCtoState does not default it). Missing pause is NOT terminal by
 * itself — only the integration/team conditions below can prove terminality.
 */
export function isCtoRunTerminal(state: CtoState): boolean {
  const pauseKind = state.pause?.kind;
  if (pauseKind === "done" || pauseKind === "failed") return true;
  if (state.standby === true) return false; // resident run stays active after wave completion
  if (state.integration?.status === "done") {
    return state.teams.every((t) => t.status === "done" || t.status === "failed");
  }
  return false;
}
