/**
 * Report assembly: read + normalize TeamState (schema 1) / CtoState (schema 2)
 * into the shared SessionReport model (pragmatic architecture).
 *
 * State/artifacts are authoritative; telemetry is bounded and optional.
 * Chronology uses event timestamps first, artifact mtime, state.updated_at,
 * then ordinal placement. Missing/corrupt optional inputs (telemetry, event
 * log, artifacts) produce explicit `warnings` — the only hard error is "no
 * session found", which is a caller error (nothing to report).
 *
 * Raw events/transcripts are never embedded: telemetry carries only the
 * bounded rollup + per-kind counts, and artifact bodies are redacted and
 * byte-capped.
 */
/* <!-- omp-cto-slice run=01a03ee4-7dd6-7580-8ad7-16d26dc886ba slice=workflow-v2-core --> */

import {
  decodeStorageText,
  listStorageEntries,
  readStorageBytes,
  requireReportStorage,
  statStorage,
  storagePath,
  writeStorageAtomic,
  ReportStorageError,
  type ReportStorageAuthority,
} from "./storage.js";

import { createDiagnostic, isDiagnosticEvidenceRecord } from "../workflow-v2/diagnostics.js";
import { isProviderId, isWorkflowV2Digest, validateProjectIdentity, validateWorkflowRunIdentity } from "../workflow-v2/identity.js";
import type {
  AgentRef,
  EffectivePolicy,
  PolicySnapshot,
  ProjectIdentity,
  ProviderCatalog,
  WorkflowRunIdentity,
  WorkflowV2Diagnostic,
} from "../workflow-v2/types.js";
import type { Profile, StageDef, TeamState } from "../engine/types.js";
import { loadProfileByIdentity } from "../engine/profile.js";
import { assessRunHealth } from "../cto/health.js";
import type { CtoState, RunHealth, TeamRunStatus } from "../cto/types.js";
import type { ObservabilityEvent, ObservabilityPointer } from "../observability/events.js";
import { rollupFromEvents } from "../observability/recorder.js";
import { redactReportBody } from "./redact.js";
import {
  projectReportWorkflowRunIdentity,
  resolveCtoSource,
  resolveDoWorkSource,
  TEAM_ARTIFACTS_DIR,
  WORK_STATE_DIR,
} from "./session-source.js";
import type {
  BuildSessionReportOptions,
  ChronologyEvent,
  ReportArtifact,
  ReportHealth,
  ReportIntegration,
  ReportMeta,
  ReportSource,
  ReportTeam,
  ReportTelemetry,
  SessionEdge,
  SessionKind,
  SessionReport,
  SessionSelector,
  StageAgentInfo,
  StageInfo,
} from "./types.js";

// Session-source layout constants and resolution live in session-source.ts
// (single source of truth for feature/legacy/CTO discovery — architecture-2).
const DEFAULT_MAX_ARTIFACT_BYTES = 16 * 1024;
const MAX_EVENT_BYTES = 2 * 1024 * 1024;
const MAX_EVENT_LINES = 5000;
const SUMMARY_CAP_FACTOR = 4;
const MAX_REPORT_IDENTITY_CHARS = 512;
const SAFE_REPORT_IDENTITY_PATTERN = /^[A-Za-z0-9@._:/#-]+$/u;


/**
 * Identity text may be copied into a report diagnostic, so keep the same
 * bounded identifier vocabulary as the canonical identity validator.
 */
function isSafeReportIdentityText(value: unknown): value is string {
  return typeof value === "string"
    && value.length > 0
    && value.length <= MAX_REPORT_IDENTITY_CHARS
    && value === value.trim()
    && SAFE_REPORT_IDENTITY_PATTERN.test(value);
}

function redactedReportIdentityText(value: unknown): string {
  return isSafeReportIdentityText(value) ? value : "[redacted]";
}


export interface ReportAssemblyContext {
  readonly policySnapshot: Readonly<PolicySnapshot>;
  readonly effectivePolicy: Readonly<EffectivePolicy>;
  readonly catalog: Readonly<ProviderCatalog>;
  readonly project_identity: Readonly<ProjectIdentity>;
  readonly agentInventory: readonly AgentRef[];
}

function sameProjectIdentity(
  left: ProjectIdentity,
  right: ProjectIdentity,
): boolean {
  return left.root_instance_id === right.root_instance_id
    && left.provider_id === right.provider_id
    && left.descriptor_fingerprint === right.descriptor_fingerprint
    && left.executable_provenance.build_fingerprint === right.executable_provenance.build_fingerprint
    && left.executable_provenance.runtime_fingerprint === right.executable_provenance.runtime_fingerprint
    && left.catalog_content_digest === right.catalog_content_digest
    && left.config_byte_sha256 === right.config_byte_sha256
    && left.config_semantic_sha256 === right.config_semantic_sha256
    && left.session.session_id === right.session.session_id
    && left.session.lifecycle_id === right.session.lifecycle_id;
}
function sameWorkflowRunIdentity(left: WorkflowRunIdentity, right: WorkflowRunIdentity): boolean {
  return left.run_id === right.run_id
    && left.profile_identity.id === right.profile_identity.id
    && left.profile_identity.fingerprint === right.profile_identity.fingerprint
    && sameProjectIdentity(left, right);
}


export class ReportAssemblyError extends Error {
  readonly diagnostic: WorkflowV2Diagnostic;

  constructor(
    code: WorkflowV2Diagnostic["code"],
    message: string,
    field: string,
  ) {
    super(`${code}: ${message}`);
    this.name = "ReportAssemblyError";
    this.diagnostic = createDiagnostic({
      code,
      operation: "management.status",
      evidence: { field },
      remediation: message,
    });
  }
}


/**
 * Report options carry the same immutable admission context as the runtime.
 * The context is required at the type boundary and is revalidated at runtime
 * so JavaScript callers cannot fall back to cwd/config discovery.
 */
export type ReportAssemblyOptions = BuildSessionReportOptions & ReportAssemblyContext;

function requireReportContext(options: ReportAssemblyOptions): ReportAssemblyContext {
  const { policySnapshot, effectivePolicy, catalog, project_identity, agentInventory } = options;
  if (!policySnapshot || !effectivePolicy || !catalog || !project_identity || !Array.isArray(agentInventory)) {
    throw new ReportAssemblyError(
      "MIGRATION_REQUIRED",
      "session reports require the admitted provider policy, catalog, inventory, and project identity",
      "report_context",
    );
  }
  const checked = validateProjectIdentity(project_identity);
  if (!checked.ok) {
    throw new ReportAssemblyError(
      "IDENTITY_MISMATCH",
      "session report project identity is malformed",
      "project_identity",
    );
  }
  const provider = effectivePolicy.provider;
  const documentProvider = policySnapshot.document?.provider;
  if (
    !provider
    || !documentProvider
    || !isProviderId(provider.id)
    || provider.protocol_version !== 2
    || !isWorkflowV2Digest(provider.descriptor_fingerprint)
    || !isWorkflowV2Digest(provider.catalog_content_digest)
    || provider.id !== documentProvider.id
    || provider.protocol_version !== documentProvider.protocol_version
    || provider.descriptor_fingerprint !== documentProvider.descriptor_fingerprint
    || provider.catalog_content_digest !== documentProvider.catalog_content_digest
    || provider.id !== checked.value.provider_id
    || provider.descriptor_fingerprint !== checked.value.descriptor_fingerprint
    || provider.catalog_content_digest !== checked.value.catalog_content_digest
    || !isWorkflowV2Digest(catalog.content_digest)
    || catalog.content_digest !== checked.value.catalog_content_digest
    || policySnapshot.byte_sha256 !== checked.value.config_byte_sha256
    || policySnapshot.semantic_sha256 !== checked.value.config_semantic_sha256
  ) {
    throw new ReportAssemblyError(
      "IDENTITY_MISMATCH",
      "session report admission context is not one immutable provider/config selection",
      "provider",
    );
  }
  const selection = effectivePolicy.workflow;
  if (!selection || (selection.selection !== "fixed" && selection.selection !== "matrix")) {
    throw new ReportAssemblyError(
      "CONFIG_MALFORMED",
      "session report requires a typed matrix/fixed workflow selection",
      "effectivePolicy.workflow",
    );
  }
  if (selection.selection === "fixed") {
    const profile = selection.profile_identity;
    if (
      !isDiagnosticEvidenceRecord(profile)
      || !isSafeReportIdentityText(profile.id)
      || !isWorkflowV2Digest(profile.fingerprint)
      || !catalog.profiles.some((candidate) =>
        candidate.identity.id === profile.id
        && candidate.identity.fingerprint === profile.fingerprint
      )
    ) {
      throw new ReportAssemblyError(
        "PROFILE_UNAVAILABLE",
        "fixed effective policy profile is not present in the admitted catalog",
        "effectivePolicy.workflow.profile_identity",
      );
    }
  } else if (Object.prototype.hasOwnProperty.call(selection, "profile_identity")) {
    throw new ReportAssemblyError(
      "CONFIG_MALFORMED",
      "matrix effective policy cannot carry a profile identity",
      "effectivePolicy.workflow.profile_identity",
    );
  }
  const byName = new Map<string, AgentRef>();
  for (const candidate of agentInventory) {
    if (
      !candidate
      || typeof candidate.registered_name !== "string"
      || candidate.registered_name.trim().length === 0
      || !isProviderId(candidate.provider_id)
      || !isWorkflowV2Digest(candidate.source_fingerprint)
      || candidate.provider_id !== checked.value.provider_id
    ) {
      throw new ReportAssemblyError(
        "AGENT_COLLISION",
        "session report inventory contains an invalid or unselected-provider identity",
        "agentInventory",
      );
    }
    const prior = byName.get(candidate.registered_name);
    if (prior && (
      prior.provider_id !== candidate.provider_id
      || prior.source_fingerprint !== candidate.source_fingerprint
    )) {
      throw new ReportAssemblyError(
        "AGENT_COLLISION",
        "session report inventory maps one registered name to multiple identities",
        "agentInventory",
      );
    }
    byName.set(candidate.registered_name, candidate);
  }
  for (const [role, ref] of Object.entries(effectivePolicy.roles ?? {})) {
    if (
      !ref
      || !isProviderId(ref.provider_id)
      || !isWorkflowV2Digest(ref.source_fingerprint)
      || ref.provider_id !== checked.value.provider_id
      || byName.get(ref.registered_name)?.source_fingerprint !== ref.source_fingerprint
    ) {
      throw new ReportAssemblyError(
        "CONFIG_MALFORMED",
        `session report policy role '${redactedReportIdentityText(role)}' is absent from the admitted provider inventory`,
        `role:${redactedReportIdentityText(role)}`,
      );
    }
  }
  for (const [index, rule] of (effectivePolicy.scope_map ?? []).entries()) {
    const ref = rule?.dev_agent;
    if (
      !ref
      || !isProviderId(ref.provider_id)
      || !isWorkflowV2Digest(ref.source_fingerprint)
      || ref.provider_id !== checked.value.provider_id
      || byName.get(ref.registered_name)?.source_fingerprint !== ref.source_fingerprint
    ) {
      throw new ReportAssemblyError(
        "CONFIG_MALFORMED",
        `session report scope mapping '${index}' is absent from the admitted provider inventory`,
        `scope_map:${index}`,
      );
    }
  }
  return {
    policySnapshot,
    effectivePolicy,
    catalog,
    project_identity: checked.value,
    agentInventory,
  };
}
function profileForContext(
  context: ReportAssemblyContext,
  runIdentity: WorkflowRunIdentity,
  workflow: string,
): Profile {
  const identity = runIdentity.profile_identity;
  if (identity.id !== workflow) {
    throw new ReportAssemblyError(
      "IDENTITY_MISMATCH",
      `session workflow '${redactedReportIdentityText(workflow)}' differs from the selected run profile`,
      "state.run_identity.profile_identity",
    );
  }
  const selection = context.effectivePolicy.workflow;
  if (
    selection.selection === "fixed"
    && (
      selection.profile_identity.id !== identity.id
      || selection.profile_identity.fingerprint !== identity.fingerprint
    )
  ) {
    throw new ReportAssemblyError(
      "IDENTITY_MISMATCH",
      "session run profile differs from the fixed effective-policy profile",
      "state.run_identity.profile_identity",
    );
  }
  const loaded = loadProfileByIdentity(context.catalog, identity);
  if (!loaded.ok) {
    throw new ReportAssemblyError(
      "PROFILE_UNAVAILABLE",
      `session workflow '${redactedReportIdentityText(workflow)}' is unavailable in the selected provider catalog`,
      "state.run_identity.profile_identity",
    );
  }
  if (loaded.value.name !== workflow) {
    throw new ReportAssemblyError(
      "IDENTITY_MISMATCH",
      `catalog profile '${redactedReportIdentityText(identity.id)}' has workflow '${redactedReportIdentityText(loaded.value.name)}'`,
      "state.run_identity.profile_identity",
    );
  }
  return loaded.value;
}
// ── Session selection ───────────────────────────────────────────────────────

interface DoWorkResolved {
  id: string;
  state: TeamState;
  statePath: string;
  stateDir: string;
  artifactsDir: string;
  isLegacy: boolean;
  isStale?: boolean;
}

interface CtoResolved {
  id: string;
  state: CtoState;
  statePath: string | null;
  runDir: string;
  format: "json" | "markdown";
}

/** Resolve a do-work TeamState; null when not found. */
function resolveDoWork(storage: ReportStorageAuthority, id?: string): DoWorkResolved | null {
  return resolveDoWorkSource(storage, id);
}

/** Resolve a CTO run; null when not found. */
function resolveCto(storage: ReportStorageAuthority, id?: string): CtoResolved | null {
  return resolveCtoSource(storage, id);
}

/** Auto-detect the newest of the best do-work state and best CTO run. */
function guessKind(storage: ReportStorageAuthority, id?: string): SessionKind {
  if (id) {
    if (resolveDoWork(storage, id)) return "do-work";
    if (resolveCto(storage, id)) return "cto";
    throw new Error(`no do-work or cto session found for id "${redactedReportIdentityText(id)}" under ${WORK_STATE_DIR}`);
  }
  const dw = resolveDoWork(storage);
  const cto = resolveCto(storage);
  if (dw && cto) return cto.state.updated_at > dw.state.updated_at ? "cto" : "do-work";
  if (dw) return "do-work";
  if (cto) return "cto";
  throw new Error(`no do-work or cto session found under ${WORK_STATE_DIR}`);
}

function storageDiagnosticCode(error: ReportStorageError): WorkflowV2Diagnostic["code"] {
  return error.reason === "CAPABILITY_MISSING"
    || error.reason === "IDENTITY_MISMATCH"
    || error.reason === "UNSAFE_PATH"
    ? error.reason
    : "MIGRATION_REQUIRED";
}

// ── Entry point ─────────────────────────────────────────────────────────────

export function buildSessionReport(
  storage: ReportStorageAuthority,
  selector: SessionSelector = {},
  options: ReportAssemblyOptions,
): SessionReport {
  const authority = requireReportStorage(storage);
  try {
    const context = requireReportContext(options);
    const kind = selector.kind ?? guessKind(authority, selector.id);
    if (kind === "cto") {
      const run = resolveCto(authority, selector.id);
      if (!run) {
        const id = selector.id ?? "latest";
        throw new Error(`cto session "${id}" not found (no state.json and no markdown fallback)`);
      }
      return assembleCto(authority, run, options, context);
    }
    const dw = resolveDoWork(authority, selector.id);
    if (!dw) {
      const id = selector.id ?? "latest";
      throw new Error(`do-work session "${id}" not found (no per-feature or legacy state.json)`);
    }
    return assembleDoWork(authority, dw, options, context);
  } catch (error) {
    if (error instanceof ReportStorageError) {
      throw new ReportAssemblyError(storageDiagnosticCode(error), error.message, "storage");
    }
    throw error;
  }
}
const ORCHESTRATOR_AGENT: StageAgentInfo = { name: "main session", role: "orchestrator", source: "workflow" };

/**
 * True when a role is still an unresolved `${scope.*}` template. The stage
 * runner resolves these from a touched-file scope scan at execution time;
 * the report deliberately performs no such scan, so a template role cannot
 * be resolved to a truthful agent here. Such roles are unavailable — never
 * guessed, and the literal placeholder is never emitted.
 */
function isUnresolvedTemplateRole(role: string): boolean {
  return role.includes("${");
}

/**
 * Optional profile metadata copied verbatim from `StageDef` — the stage
 * detail the renderer shows under a disclosure. Only declared fields with
 * non-empty values are emitted; custom/legacy stages (no def) keep every
 * field absent. Profile/config metadata only — never raw prompts, event
 * data, unbounded artifact content, or rendered document bodies (the
 * `document` entry carries the typed format/renderer/path contract only).
 */
function stageProfileMeta(
  def: StageDef | undefined,
): Partial<Pick<StageInfo, "description" | "checkpoint" | "gate" | "autonomous" | "document">> {
  if (!def) return {};
  return {
    ...(def.description ? { description: def.description } : {}),
    ...(def.checkpoint ? { checkpoint: def.checkpoint } : {}),
    ...(def.gate ? { gate: def.gate } : {}),
    ...(def.autonomous ? { autonomous: def.autonomous } : {}),
    ...(def.document ? { document: def.document } : {}),
  };
}

const STAGE_PROMPT_PREVIEW_MAX_CHARS = 4096;
// Task text is the largest variable in a preview: clip it before the
// stage-specific lines are appended so a multi-KB task cannot crowd the
// agents/inputs/outputs/checkpoint/gate/autonomous metadata past the cap.
const STAGE_PROMPT_TASK_MAX_CHARS = 1024;

/** Clip `text` to at most `max` chars; the `…` marker counts toward `max`. */
function clipTo(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

/**
 * Bounded, deterministic reconstruction of the shape of a stage prompt.
 * This is explicitly NOT the literal runtime prompt — per-stage task text is
 * generated dynamically by the agent run and is never persisted, so the
 * preview is assembled only from persisted metadata: the stage definition
 * (title/id/type, declared input/output ids, checkpoint/gate/autonomous),
 * the session task, and truthful resolved agent/role provenance. Raw
 * artifact JSON, event/transcript data, tool arguments, and secrets are
 * never interpolated. Roles that remain unresolved `${scope.*}` templates
 * are omitted (the caller passes the same roster `stageAgents` resolved, so
 * no resolved agent is ever claimed where no scope evidence exists).
 */
function stagePromptPreview(def: StageDef, task: string, agents: StageAgentInfo[] | undefined): string {
  const lines = [`${def.title} [${def.id}] type: ${def.type}`];
  if (task) lines.push(`task: ${clipTo(task, STAGE_PROMPT_TASK_MAX_CHARS)}`);
  if (agents && agents.length > 0) {
    lines.push(
      `agents: ${agents
        .map((a) => (a.role && a.role !== a.name ? `${a.role} -> ${a.name}` : a.name))
        .join(", ")}`,
    );
  }
  const consumes = asList(def.consumes);
  if (consumes.length > 0) lines.push(`inputs: ${consumes.join(", ")}`);
  const produces = asList(def.produces);
  if (produces.length > 0) lines.push(`outputs: ${produces.join(", ")}`);
  if (def.checkpoint) lines.push(`checkpoint: ${def.checkpoint}`);
  if (def.gate) lines.push(`gate: ${def.gate}`);
  if (def.autonomous) lines.push(`autonomous: ${def.autonomous}`);
  const text = lines.join("\n");
  // Strict final cap: the `…` marker is counted inside the budget, so the
  // preview never exceeds STAGE_PROMPT_PREVIEW_MAX_CHARS characters.
  return clipTo(text, STAGE_PROMPT_PREVIEW_MAX_CHARS);
}

/**
 * Provenance for a profile stage. Every emitted agent comes from the exact
 * role key in the admitted effective policy and an unchanged inventory entry.
 * A missing qualified mapping makes the roster unavailable; no flat or cwd
 * configuration lookup is permitted in report assembly.
 */
function stageAgents(def: StageDef, context: ReportAssemblyContext): StageAgentInfo[] | undefined {
  if (def.type === "orchestrator") return [ORCHESTRATOR_AGENT];
  const roster = effectiveRoster(def);
  if (roster.length === 0) return undefined;
  const agents: StageAgentInfo[] = [];
  for (const role of roster) {
    const ref = context.effectivePolicy.roles[role];
    if (!ref) return undefined;
    const observed = context.agentInventory.find((candidate) =>
      candidate.registered_name === ref.registered_name
      && candidate.provider_id === ref.provider_id
      && candidate.source_fingerprint === ref.source_fingerprint
    );
    if (!observed) return undefined;
    agents.push({ name: ref.registered_name, role, source: "workflow" });
  }
  return agents;
}

/**
 * Return only profile-declared roles. Effective roster patches are already
 * applied by host admission/engine dispatch; this read-only report view never
 * reconstructs them from a legacy map.
 */
function effectiveRoster(def: StageDef): string[] {
  const roster = def.roles && def.roles.length > 0
    ? [...def.roles]
    : def.role
      ? [def.role]
      : [];
  return roster.filter((role) => !isUnresolvedTemplateRole(role));
}

/** CTO team provenance is taken from the persisted qualified plan/state refs. */
function teamLeadAgents(teamId: string, state: CtoState, context: ReportAssemblyContext): StageAgentInfo[] | undefined {
  const team = state.teams.find((candidate) => candidate.id === teamId);
  const plan = state.plan.teams.find((candidate) => candidate.team === teamId);
  const ref = team?.lead_ref ?? plan?.lead_ref;
  if (!ref || ref.provider_id !== context.project_identity.provider_id) return undefined;
  const observed = context.agentInventory.find((candidate) =>
    candidate.registered_name === ref.registered_name
    && candidate.provider_id === ref.provider_id
    && candidate.source_fingerprint === ref.source_fingerprint
  );
  if (!observed) return undefined;
  return [{ name: ref.registered_name, role: "team-lead", source: "workflow" as const }];
}

// ── do-work assembly ────────────────────────────────────────────────────────

function assembleDoWork(
  storage: ReportStorageAuthority,
  r: DoWorkResolved,
  options: ReportAssemblyOptions,
  context: ReportAssemblyContext,
): SessionReport {
  const warnings: string[] = [];
  const state = r.state;
  if (r.isLegacy) {
    throw new ReportAssemblyError(
      "MIGRATION_REQUIRED",
      "legacy do-work state is not a report authority",
      "state",
    );
  }
  const stateProject = validateProjectIdentity(state.project_identity);
  if (!stateProject.ok || !sameProjectIdentity(stateProject.value, context.project_identity)) {
    throw new ReportAssemblyError(
      "IDENTITY_MISMATCH",
      "STATE_STALE: do-work state project identity differs from report admission",
      "state.project_identity",
    );
  }
  const runIdentityValue = state.run_identity;
  if (!runIdentityValue) {
    throw new ReportAssemblyError(
      "MIGRATION_REQUIRED",
      "do-work state has no workflow run identity",
      "state.run_identity",
    );
  }
  const stateIdentity = validateWorkflowRunIdentity(runIdentityValue);
  if (!stateIdentity.ok || !sameProjectIdentity(stateIdentity.value, context.project_identity)) {
    throw new ReportAssemblyError(
      "IDENTITY_MISMATCH",
      "STATE_STALE: do-work state run identity differs from report admission project identity",
      "state.run_identity",
    );
  }
  const profile = profileForContext(context, stateIdentity.value, state.classification.workflow);
  const stageDefs = new Map<string, StageDef>();
  for (const stage of profile.stages) {
    stageDefs.set(stage.id, stage);
  }
  const { telemetry, events } = doWorkTelemetry(storage, r, warnings);
  const stageEventTimes = latestTransitionTimes(events, (e) => e.stageId);
  const artifactEventTimes = latestTransitionTimes(events, (e) => e.artifactId);

  // Artifacts first — stage `at` falls back to the produced artifact's time.
  const declaredProduces = new Map<string, string>(); // artifactId -> owner stage
  for (const stage of profile.stages) {
    for (const id of asList(stage.produces)) declaredProduces.set(id, stage.id);
  }
  const artifacts: ReportArtifact[] = [];
  const artifactMtimes = new Map<string, string>(); // artifactId -> iso
  const builtIds = new Set<string>();

  const pushArtifact = (input: ArtifactInput) => {
    if (builtIds.has(input.id)) return;
    builtIds.add(input.id);
    const art = buildArtifact(storage, input, options, warnings);
    artifacts.push(art);
    if (art.mtime) artifactMtimes.set(input.id, art.mtime);
  };

  for (const [artifactId, ownerStage] of declaredProduces) {
    const stageStatus = state.stages.find((s) => s.id === ownerStage)?.status ?? "pending";
    const relativePath = artifactFilePath(storage, r, artifactId);
    const present = relativePath !== null && statStorage(storage, relativePath).kind === "file";
    pushArtifact({
      id: artifactId,
      owner: ownerStage,
      relativePath,
      status: !present ? (stageStatus === "skipped" ? "skipped" : "missing") : "produced",
    });
  }
  // Undeclared artifacts agents wrote directly (honest extras).
  const artifactsStat = statStorage(storage, r.artifactsDir);
  if (artifactsStat.exists && artifactsStat.kind === "directory") {
    for (const entry of listStorageEntries(storage, r.artifactsDir, 4096)) {
      const file = entry.name;
      if (!file.endsWith(".json")) continue;
      const artifactId = file.replace(/\.json$/u, "");
      if (declaredProduces.has(artifactId)) continue;
      pushArtifact({
        id: artifactId,
        owner: "extra",
        relativePath: entry.relative_path,
        status: "produced",
      });
    }
  }

  const stages: StageInfo[] = (state.stages ?? []).map((s) => {
    const def = stageDefs.get(s.id);
    const produced = declaredProduces.size > 0
      ? [...declaredProduces.entries()].filter(([, owner]) => owner === s.id).map(([id]) => id)
      : [];
    const artifactTime = produced.map((id) => artifactEventTimes.get(id) ?? artifactMtimes.get(id)).find(Boolean);
    const agents = def ? stageAgents(def, context) : undefined;
    return {
      id: s.id,
      title: def?.title,
      status: s.status,
      phase: state.classification.workflow,
      type: def?.type,
      at: stageEventTimes.get(s.id) ?? artifactTime ?? state.updated_at,
      // Declared artifact ids are preserved even when files are missing;
      // custom/legacy stages (no def) keep the fields absent.
      ...stageProfileMeta(def),
      ...(def ? { promptPreview: stagePromptPreview(def, state.task, agents) } : {}),
      ...(def ? { inputs: [...(def.consumes ?? [])] } : {}),
      ...(def ? { outputs: asList(def.produces) } : {}),
      ...(agents ? { agents } : {}),
    };
  });

  const edges = doWorkEdges(state, profile);

  const meta: ReportMeta = {
    title: taskTitle(state.task, state.issue),
    task: state.task,
    branch: state.branch,
    workflow: state.classification.workflow,
    classification: {
      type: state.classification.type,
      complexity: state.classification.complexity,
      confidence: state.classification.confidence,
      workflow: state.classification.workflow,
      autonomous: state.classification.autonomous,
      ...(state.classification.autonomous_reason ? { autonomous_reason: state.classification.autonomous_reason } : {}),
    },
    issue: state.issue ?? null,
    pause: state.pause,
    updated_at: state.updated_at,
    generated_at: new Date().toISOString(),
    autonomous: state.classification.autonomous,
  };

  const chronology = sortedChronology([
    ...events.flatMap((e): ChronologyEvent[] => {
      if (e.kind === "stage_transition") {
        return [{
          kind: "stage", at: e.ts, eventKind: "stage_transition",
          label: `stage ${e.stageId ?? "?"} → ${e.stageStatus ?? "?"}`,
          ref: e.stageId, source: "event" as const,
        }];
      }
      if (e.kind === "artifact_written") {
        return [{
          kind: "artifact", at: e.ts, eventKind: "artifact_written",
          label: `artifact ${e.artifactId ?? "?"} written`,
          ref: e.artifactId, source: "event" as const,
        }];
      }
      return [];
    }),
    ...artifacts
      .filter((a) => a.mtime && !artifactEventTimes.has(a.id) && a.status === "produced")
      .map((a): ChronologyEvent => ({
        kind: "artifact", at: a.mtime!, label: `artifact ${a.id} produced`, ref: a.id, source: "mtime",
      })),
    { kind: "state", at: state.updated_at, label: "state updated", source: "state" },
  ]);

  return {
    schema: 1,
    kind: "do-work",
    meta,
    source: {
      kind: "do-work",
      id: r.id,
      statePath: r.statePath,
      format: "json",
      isLegacy: r.isLegacy,
      isStale: r.isStale,
      stateDir: r.stateDir,
      artifactsDir: r.artifactsDir,
    } satisfies ReportSource,
    stages,
    edges,
    artifacts,
    telemetry,
    chronology,
    warnings,
  };
}

function doWorkEdges(state: TeamState, profile: Profile | null): SessionEdge[] {
  const edges: SessionEdge[] = [];
  if (profile) {
    for (const s of profile.stages) {
      for (const id of asList(s.produces)) edges.push({ from: s.id, to: id, kind: "produces" });
      for (const id of s.consumes ?? []) edges.push({ from: id, to: s.id, kind: "consumes" });
    }
    return edges;
  }
  // No profile for this workflow (custom/legacy) — ordinal transition spine.
  for (let i = 0; i < state.stages.length - 1; i++) {
    edges.push({ from: state.stages[i]!.id, to: state.stages[i + 1]!.id, kind: "transition" });
  }
  return edges;
}

// ── CTO assembly ────────────────────────────────────────────────────────────

function assembleCto(
  storage: ReportStorageAuthority,
  r: CtoResolved,
  options: ReportAssemblyOptions,
  context: ReportAssemblyContext,
): SessionReport {
  const warnings: string[] = [];
  const state = r.state;
  const runIdentityValue = state.run_identity;
  if (!runIdentityValue) {
    throw new ReportAssemblyError(
      "MIGRATION_REQUIRED",
      "CTO state has no workflow run identity",
      "state.run_identity",
    );
  }
  const stateIdentity = projectReportWorkflowRunIdentity(runIdentityValue);
  if (
    !stateIdentity
    || stateIdentity.run_id !== r.id
    || !sameProjectIdentity(stateIdentity, context.project_identity)
  ) {
    throw new ReportAssemblyError(
      "IDENTITY_MISMATCH",
      "STATE_STALE: CTO state run identity differs from report admission project identity",
      "state.run_identity",
    );
  }
  const planIdentity = projectReportWorkflowRunIdentity(state.plan.run_identity);
  if (!planIdentity || !sameWorkflowRunIdentity(planIdentity, stateIdentity)) {
    throw new ReportAssemblyError(
      "IDENTITY_MISMATCH",
      "STATE_STALE: CTO plan run identity differs from CTO state identity",
      "state.plan.run_identity",
    );
  }
  for (const [index, team] of state.teams.entries()) {
    const teamIdentity = projectReportWorkflowRunIdentity(team.run_identity);
    if (!teamIdentity || !sameWorkflowRunIdentity(teamIdentity, stateIdentity)) {
      throw new ReportAssemblyError(
        "IDENTITY_MISMATCH",
        "STATE_STALE: CTO team run identity differs from CTO state identity",
        `state.teams[${index}].run_identity`,
      );
    }
  }
  const profile = profileForContext(context, stateIdentity, "cto");
  const stageDefs = new Map<string, StageDef>();
  for (const s of profile.stages) stageDefs.set(s.id, s);
  const { telemetry, events } = ctoTelemetry(storage, r, warnings);
  const teamIds = new Set(state.teams.map((t) => t.id));
  const relevant = events.filter(
    (e) => e.runId === r.id || (e.runId === undefined && teamIds.has(e.stageId ?? "")),
  );
  const teamEventTimes = latestTransitionTimes(relevant, (e) => e.stageId);
  const artifactEventTimes = latestTransitionTimes(relevant, (e) => e.artifactId);

  // Teams / integration / health first — stages derive from them.
  const planByTeam = new Map(state.plan.teams.map((t) => [t.team, t]));
  const teams: ReportTeam[] = state.teams.map((t) => {
    const plan = planByTeam.get(t.id);
    return {
      id: t.id,
      status: t.status,
      ...(plan?.scope ? { scope: plan.scope } : {}),
      ...(plan?.slice ? { slice: plan.slice } : {}),
      ...(plan?.profile ? { profile: plan.profile } : {}),
      ...(plan?.worktree ? { worktree: plan.worktree } : {}),
      ...(plan?.depends_on ? { depends_on: plan.depends_on } : {}),
      ...(t.dod_path ? { dod_path: t.dod_path } : {}),
      escalations: Object.keys(t.escalations).length,
    };
  });
  const integration: ReportIntegration = { status: state.integration.status, ...(state.integration.note ? { note: state.integration.note } : {}) };
  const health: ReportHealth = mapHealth(state.health ?? assessRunHealth(state));

  const stages: StageInfo[] = [];
  for (const def of profile?.stages ?? []) {
    const agents = stageAgents(def, context);
    stages.push({
      id: def.id,
      title: def.title,
      status: ctoStageStatus(state, def.id),
      phase: "cto",
      type: def.type,
      at: teamEventTimes.get(def.id) ?? state.updated_at,
      ...stageProfileMeta(def),
      promptPreview: stagePromptPreview(def, state.task, agents),
      inputs: [...(def.consumes ?? [])],
      outputs: asList(def.produces),
      ...(agents ? { agents } : {}),
    });
  }
  for (const t of state.teams) {
    const agents = teamLeadAgents(t.id, state, context);
    stages.push({
      id: `team:${t.id}`,
      title: `Team ${t.id}`,
      status: t.status,
      phase: "cto",
      type: "team",
      team: t.id,
      at: teamEventTimes.get(t.id) ?? state.updated_at,
      ...(agents ? { agents } : {}),
    });
  }

  const edges = ctoEdges(state, profile);
  const { artifacts, artifactMtimes } = ctoArtifacts(storage, state, options, warnings);

  const meta: ReportMeta = {
    title: taskTitle(state.task, null),
    task: state.task,
    branch: state.branch,
    ...(state.classification ? { workflow: "cto", classification: state.classification } : {}),
    issue: null,
    pause: state.pause,
    updated_at: state.updated_at,
    generated_at: new Date().toISOString(),
    autonomous: state.autonomous,
    ...(state.standby === true ? { standby: true } : {}),
    ...(state.owner_session ? { owner_session: state.owner_session } : {}),
    ...(state.amended_at ? { amended_at: state.amended_at } : {}),
  };

  const chronology = sortedChronology([
    ...relevant.flatMap((e): ChronologyEvent[] => {
      if (e.kind === "stage_transition") {
        return [{
          kind: "team", at: e.ts, eventKind: "stage_transition",
          label: `team ${e.stageId ?? "?"} → ${e.stageStatus ?? "?"}`,
          ref: e.stageId, source: "event" as const,
        }];
      }
      if (e.kind === "artifact_written") {
        return [{
          kind: "artifact", at: e.ts, eventKind: "artifact_written",
          label: `artifact ${e.artifactId ?? "?"} written`,
          ref: e.artifactId, source: "event" as const,
        }];
      }
      return [];
    }),
    ...state.teams
      .filter((t) => !teamEventTimes.has(t.id))
      .map((t): ChronologyEvent => ({
        kind: "team", at: state.updated_at, label: `team ${t.id} → ${t.status}`, ref: t.id, source: "state",
      })),
    ...artifacts
      .filter((a) => a.mtime && !artifactEventTimes.has(a.id) && a.status === "produced")
      .map((a): ChronologyEvent => ({
        kind: "artifact", at: a.mtime!, label: `artifact ${a.id} produced`, ref: a.id, source: "mtime",
      })),
    { kind: "integration", at: state.updated_at, label: `integration ${state.integration.status}`, source: "state" },
    { kind: "state", at: state.updated_at, label: "state updated", source: "state" },
  ]);

  return {
    schema: 1,
    kind: "cto",
    meta,
    source: {
      kind: "cto",
      id: r.id,
      statePath: r.statePath,
      format: r.format,
      isLegacy: false,
      stateDir: r.runDir,
    } satisfies ReportSource,
    stages,
    edges,
    artifacts,
    teams,
    integration,
    health,
    telemetry,
    chronology,
    warnings,
  };
}

/** Deterministic CTO workflow-stage status derived from CtoState (no stages array). */
function ctoStageStatus(state: CtoState, stageId: string): StageInfo["status"] {
  switch (stageId) {
    case "cto_discovery":
      return state.standby ? "pending" : "done";
    case "decomposition":
      if (state.plan.teams.length > 0) return "done";
      return state.standby ? "pending" : "in_progress";
    case "architecture":
      return state.teams.some((t) => t.status !== "pending") ? "done" : "pending";
    case "teams":
      if (state.teams.length === 0) return "not_started";
      if (state.teams.some((t) => t.status === "in_progress")) return "in_progress";
      if (state.teams.some((t) => t.status === "parked")) return "parked";
      if (state.teams.some((t) => t.status === "failed")) return "failed";
      if (state.teams.every((t) => t.status === "done")) return "done";
      return "pending";
    case "integration_review":
      return state.integration.status;
    case "cto_summary":
      return state.integration.status === "done" ? "done" : "pending";
    default:
      return "not_started";
  }
}

function ctoEdges(state: CtoState, profile: Profile | null): SessionEdge[] {
  const edges: SessionEdge[] = [];
  if (profile) {
    for (const s of profile.stages) {
      for (const id of asList(s.produces)) edges.push({ from: s.id, to: id, kind: "produces" });
      for (const id of s.consumes ?? []) edges.push({ from: id, to: s.id, kind: "consumes" });
    }
  } else {
    const chain = ["cto_discovery", "decomposition", "architecture", "teams", "integration_review", "cto_summary"];
    for (let i = 0; i < chain.length - 1; i++) {
      edges.push({ from: chain[i]!, to: chain[i + 1]!, kind: "transition" });
    }
  }
  for (const entry of state.plan.teams) {
    for (const dep of entry.depends_on ?? []) {
      edges.push({ from: `team:${dep}`, to: `team:${entry.team}`, kind: "depends_on", label: "depends_on" });
    }
    edges.push({ from: `team:${entry.team}`, to: "integration_review", kind: "integration" });
  }
  return edges;
}

/** Team artifacts under `.work-state/artifacts/<teamId>` plus each dod_path. */
function ctoArtifacts(
  storage: ReportStorageAuthority,
  state: CtoState,
  options: BuildSessionReportOptions,
  warnings: string[],
): { artifacts: ReportArtifact[]; artifactMtimes: Map<string, string> } {
  const artifacts: ReportArtifact[] = [];
  const artifactMtimes = new Map<string, string>();
  const seen = new Set<string>();
  for (const team of state.teams) {
    const dir = storagePath(WORK_STATE_DIR, TEAM_ARTIFACTS_DIR, team.id);
    const dirStat = statStorage(storage, dir);
    if (dirStat.exists && dirStat.kind === "directory") {
      for (const entry of listStorageEntries(storage, dir, 4096)) {
        const file = entry.name;
        if (!file.endsWith(".json")) continue;
        const artifactId = file.replace(/\.json$/u, "");
        const key = `${team.id}/${artifactId}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const art = buildArtifact(
          storage,
          { id: artifactId, owner: team.id, relativePath: entry.relative_path, status: "produced" },
          options,
          warnings,
        );
        artifacts.push(art);
        if (art.mtime) artifactMtimes.set(artifactId, art.mtime);
      }
    }
    if (team.dod_path) {
      const key = `${team.id}/dod`;
      if (seen.has(key)) continue;
      seen.add(key);
      const relativePath = resolveArtifactPath(team.dod_path);
      if (!relativePath) continue;
      const stat = statStorage(storage, relativePath);
      if (!stat.exists || stat.kind !== "file") continue;
      const art = buildArtifact(storage, { id: "dod", owner: team.id, relativePath, status: "produced" }, options, warnings);
      artifacts.push(art);
      if (art.mtime) artifactMtimes.set("dod", art.mtime);
    }
  }
  return { artifacts, artifactMtimes };
}

function mapHealth(h: RunHealth): ReportHealth {
  return {
    healthy: h.healthy,
    issues: h.issues,
    budget_status: h.budget_status,
    active_teams: h.active_teams,
    parked_teams: h.parked_teams,
    failed_teams: h.failed_teams,
    pending_escalations: h.pending_escalations,
  };
}

// ── Artifacts ───────────────────────────────────────────────────────────────

interface ArtifactInput {
  id: string;
  owner: string;
  relativePath: string | null;
  status: "produced" | "missing" | "skipped";
}

function buildArtifact(
  storage: ReportStorageAuthority,
  input: ArtifactInput,
  options: BuildSessionReportOptions,
  warnings: string[],
): ReportArtifact {
  const requestedMax = options.maxArtifactBytes ?? DEFAULT_MAX_ARTIFACT_BYTES;
  const maxBytes = Number.isSafeInteger(requestedMax) && requestedMax >= 0
    ? Math.min(requestedMax, MAX_EVENT_BYTES)
    : DEFAULT_MAX_ARTIFACT_BYTES;
  const base: ReportArtifact = {
    id: input.id,
    path: input.relativePath ?? input.id,
    owner: input.owner,
    status: input.status,
  };
  if (!input.relativePath) {
    base.summary = input.status === "skipped" ? "skipped — artifact not produced" : "not produced";
    return base;
  }
  const metadata = statStorage(storage, input.relativePath);
  if (!metadata.exists || metadata.kind !== "file") {
    base.summary = input.status === "skipped" ? "skipped — artifact not produced" : "not produced";
    return base;
  }
  const size = metadata.size_bytes;
  base.bytes = size;
  base.mtime = new Date(metadata.mtime_ms).toISOString();

  const summaryCap = Math.min(Math.max(maxBytes * SUMMARY_CAP_FACTOR, 64 * 1024), MAX_EVENT_BYTES);
  const rawBytes = readStorageBytes(storage, input.relativePath, summaryCap);
  const raw = decodeStorageText(rawBytes);
  if (raw === null) {
    warnings.push(`artifact ${input.id} (${input.owner}) unreadable`);
    base.summary = "unreadable artifact";
    return base;
  }
  let data: unknown = null;
  try {
    data = JSON.parse(raw);
  } catch {
    warnings.push(`artifact ${input.id} (${input.owner}) is not valid JSON (or exceeds the summary cap)`);
    base.summary = "unreadable artifact (not JSON)";
    return base;
  }
  const { summary, type, keys } = summarizeArtifact(data);
  base.summary = redactReportBody(summary, 500);
  if (type) base.type = type;
  if (keys && keys.length > 0) base.keys = keys;
  if (options.includeFullArtifacts) {
    if (size > maxBytes) warnings.push(`artifact ${input.id} truncated to ${maxBytes} bytes (maxArtifactBytes)`);
    base.body = redactReportBody(raw, maxBytes);
  }
  return base;
}

function artifactFilePath(storage: ReportStorageAuthority, r: DoWorkResolved, artifactId: string): string | null {
  const mapped = r.state.artifacts?.[artifactId];
  if (mapped) return resolveArtifactPath(mapped);
  return storagePath(r.artifactsDir, `${artifactId}.json`);
}

/**
 * Resolve persisted artifact references into safe `.work-state` relative
 * paths. Absolute paths and traversal-shaped references are rejected.
 */
function resolveArtifactPath(ref: string): string | null {
  if (typeof ref !== "string" || !ref || ref.includes("\\")) return null;
  const pieces = ref.split("/");
  if (pieces.some((piece) => !piece || piece === "." || piece === "..")) return null;
  if (pieces[0] === WORK_STATE_DIR) return storagePath(...pieces);
  return storagePath(WORK_STATE_DIR, ...pieces);
}

function summarizeArtifact(data: unknown): { summary: string; type?: string; keys?: string[] } {
  if (data === null || data === undefined) return { summary: "empty artifact" };
  if (typeof data === "string") {
    const t = data.trim();
    return { summary: t ? (t.length > 200 ? `${t.slice(0, 200)}…` : t) : "empty artifact" };
  }
  if (Array.isArray(data)) return { summary: `array (${data.length} items)` };
  if (isDiagnosticEvidenceRecord(data)) {
    const type = typeof data.type === "string" && data.type ? data.type : undefined;
    const keys = Object.keys(data).slice(0, 16);
    const title = typeof data.title === "string" ? data.title : undefined;
    const own = typeof data.summary === "string" ? data.summary : undefined;
    return {
      summary: title ?? own ?? (type ? `${type} artifact (${keys.length} fields)` : `artifact (${keys.length} fields)`),
      ...(type ? { type } : {}),
      ...(keys.length > 0 ? { keys } : {}),
    };
  }
  return { summary: String(data) };
}

// ── Telemetry (bounded; never raw events) ───────────────────────────────────

function readSafeObservabilityPointer(
  storage: ReportStorageAuthority,
  featureSlug: string,
): ObservabilityPointer | null {
  const eventsPath = storagePath(WORK_STATE_DIR, "features", featureSlug, "observability", "events.jsonl");
  const metadata = statStorage(storage, eventsPath);
  if (!metadata.exists || metadata.kind !== "file") return null;
  const events = readEventsBounded(storage, eventsPath, []);
  const last = events[events.length - 1];
  return {
    eventsPath: "observability/events.jsonl",
    lastEventId: last?.id ?? "",
    rollupThroughId: last?.id ?? "",
    rollup: rollupFromEvents(events),
  };
}

const OBSERVABILITY_EVENT_KINDS: readonly string[] = [
  "session_start",
  "session_stop",
  "before_agent_start",
  "agent_start",
  "agent_end",
  "tool_call",
  "tool_result",
  "stage_transition",
  "artifact_written",
  "work_pending",
  "work_terminal",
];

function isObservabilityEvent(value: unknown): value is ObservabilityEvent {
  if (!isDiagnosticEvidenceRecord(value)) return false;
  if (
    typeof value.id !== "string"
    || typeof value.ts !== "string"
    || typeof value.branch !== "string"
    || typeof value.kind !== "string"
    || !OBSERVABILITY_EVENT_KINDS.includes(value.kind)
  ) {
    return false;
  }
  for (const field of [
    "sessionId",
    "toolCallId",
    "toolName",
    "gateReason",
    "subagent",
    "stageId",
    "stageStatus",
    "artifactId",
    "artifactPath",
    "artifactSha256",
    "runId",
  ]) {
    if (value[field] !== undefined && typeof value[field] !== "string") return false;
  }
  for (const field of ["stageId", "artifactId", "runId"]) {
    if (value[field] !== undefined && !isSafeReportIdentityText(value[field])) return false;
  }
  if (value.isError !== undefined && typeof value.isError !== "boolean") return false;
  if (
    value.gateDecision !== undefined
    && value.gateDecision !== "allowed"
    && value.gateDecision !== "blocked"
  ) {
    return false;
  }
  for (const field of ["subagentTaskChars", "agentStartMs", "messageCount", "artifactBytes"]) {
    if (
      value[field] !== undefined
      && (typeof value[field] !== "number" || !Number.isFinite(value[field]))
    ) {
      return false;
    }
  }
  if (
    value.skills !== undefined
    && (!Array.isArray(value.skills) || value.skills.some((entry) => typeof entry !== "string"))
  ) {
    return false;
  }
  if (value.artifact_summaries !== undefined && !Array.isArray(value.artifact_summaries)) return false;
  return true;
}

function doWorkTelemetry(
  storage: ReportStorageAuthority,
  r: DoWorkResolved,
  warnings: string[],
): { telemetry: ReportTelemetry; events: ObservabilityEvent[] } {
  const slug = r.isLegacy ? (deriveFeatureSlug(r.state.branch) ?? "default") : r.id;
  const pointer = readSafeObservabilityPointer(storage, slug);
  if (!pointer) {
    warnings.push("no telemetry available for this session");
    return { telemetry: { rollup: null }, events: [] };
  }
  return buildTelemetry(storage, slug, pointer, warnings);
}

function ctoTelemetry(
  storage: ReportStorageAuthority,
  r: CtoResolved,
  warnings: string[],
): { telemetry: ReportTelemetry; events: ObservabilityEvent[] } {
  // CTO runs have no observability pointer of their own; the recorder is
  // feature-scoped and falls back to "default" for CTO sessions. This is
  // coarse session-level telemetry — flagged in the report.
  const pointer = readSafeObservabilityPointer(storage, "default");
  if (!pointer) {
    warnings.push("no telemetry available for this CTO run (session-level events only)");
    return { telemetry: { rollup: null }, events: [] };
  }
  const result = buildTelemetry(storage, "default", pointer, warnings);
  warnings.push("CTO telemetry is session-level (no per-run event stream); chronology falls back to state");
  return result;
}

function buildTelemetry(
  storage: ReportStorageAuthority,
  slug: string,
  pointer: ObservabilityPointer,
  warnings: string[],
): { telemetry: ReportTelemetry; events: ObservabilityEvent[] } {
  const eventsPath = storagePath(WORK_STATE_DIR, "features", slug, pointer.eventsPath);
  const events = readEventsBounded(storage, eventsPath, warnings);
  const eventCounts: Record<string, number> = {};
  for (const e of events) eventCounts[e.kind] = (eventCounts[e.kind] ?? 0) + 1;
  return {
    telemetry: {
      eventsPath: pointer.eventsPath,
      lastEventId: pointer.lastEventId,
      rollup: pointer.rollup,
      eventCounts,
    },
    events,
  };
}

function readEventsBounded(
  storage: ReportStorageAuthority,
  eventsPath: string,
  warnings: string[],
): ObservabilityEvent[] {
  const metadata = statStorage(storage, eventsPath);
  if (!metadata.exists || metadata.kind !== "file") {
    warnings.push("event log missing — chronology falls back to artifact mtime/state timestamps");
    return [];
  }
  const bytes = readStorageBytes(storage, eventsPath, MAX_EVENT_BYTES);
  if (bytes === null) {
    warnings.push("event log unreadable — chronology falls back to artifact mtime/state timestamps");
    return [];
  }
  if (metadata.size_bytes > MAX_EVENT_BYTES) {
    warnings.push(`event log exceeds the telemetry cap — only the first ${MAX_EVENT_BYTES} bytes were read`);
  }
  const out: ObservabilityEvent[] = [];
  let corrupt = 0;
  const text = decodeStorageText(bytes);
  if (text === null) {
    warnings.push("event log unreadable — chronology falls back to artifact mtime/state timestamps");
    return [];
  }
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (isObservabilityEvent(parsed)) {
        out.push(parsed);
      } else {
        corrupt += 1;
      }
    } catch {
      corrupt += 1;
    }
  }
  if (corrupt > 0) warnings.push(`${corrupt} corrupt event line(s) skipped`);
  if (out.length > MAX_EVENT_LINES) {
    warnings.push(`event log truncated to ${MAX_EVENT_LINES} events (bounded telemetry)`);
    return out.slice(out.length - MAX_EVENT_LINES);
  }
  return out;
}

/** Latest event ts per key (stageId/artifactId) — the current transition time. */
function latestTransitionTimes(
  events: ObservabilityEvent[],
  keyOf: (e: ObservabilityEvent) => string | undefined,
): Map<string, string> {
  const times = new Map<string, string>();
  for (const e of events) {
    const key = keyOf(e);
    if (!key) continue;
    const prev = times.get(key);
    if (!prev || e.ts > prev) times.set(key, e.ts);
  }
  return times;
}

// ── Chronology ──────────────────────────────────────────────────────────────

function sortedChronology(entries: ChronologyEvent[]): ChronologyEvent[] {
  const timed = entries.filter((e) => Number.isFinite(Date.parse(e.at)));
  const untimed = entries.filter((e) => !Number.isFinite(Date.parse(e.at)));
  timed.sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  return [...timed, ...untimed.map((e) => ({ ...e, source: "ordinal" as const }))];
}

// ── Report writer ────────────────────────────────────────────────────────────

/**
 * Atomically publish report HTML under the descriptor-relative work-state
 * namespace. The storage authority owns parent creation, symlink checks, file
 * mode and replacement semantics; this function only validates the relative
 * target and encodes the body.
 */
export function writeReport(storage: ReportStorageAuthority, targetPath: string, html: string): string {
  const authority = requireReportStorage(storage);
  if (typeof html !== "string") {
    throw new ReportStorageError("IO", "report output must be text");
  }
  const target = normalizeReportTarget(targetPath);
  const bytes = new TextEncoder().encode(html);
  writeStorageAtomic(authority, target, bytes);
  return target;
}

function normalizeReportTarget(targetPath: string): string {
  const target = storagePath(targetPath);
  if (target !== WORK_STATE_DIR && !target.startsWith(`${WORK_STATE_DIR}/`)) {
    throw new ReportStorageError("UNSAFE_PATH", "report target must remain under .work-state");
  }
  return target;
}

// ── Small helpers ───────────────────────────────────────────────────────────

function asList(produces: string | string[] | undefined): string[] {
  if (!produces) return [];
  return Array.isArray(produces) ? produces : [produces];
}

function taskTitle(task: string, issue: { number: number; url?: string } | null): string {
  const firstLine = task.split("\n").find((l) => l.trim()) ?? task;
  const truncated = firstLine.length > 120 ? `${firstLine.slice(0, 120)}…` : firstLine;
  return issue?.number ? `#${issue.number}: ${truncated}` : truncated;
}

function deriveFeatureSlug(branch: string): string | null {
  if (!branch) return null;
  return branch.replace(/\//g, "-").replace(/[^a-z0-9._-]/gi, "-").toLowerCase();
}

