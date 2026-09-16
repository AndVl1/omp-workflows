import type { StageDef, TeamState, DispatchRecord } from "../engine/types.js";
import { resolveStatePinned, MAX_PERSISTED_STATE_BYTES } from "../engine/state.js";
import { TextDecoder } from "node:util";
import { loadProfile, profileHash } from "../engine/profile.js";
import { validateArtifactStructure } from "../engine/artifacts.js";
import { canonicalJson, sha256Hex } from "../specification/validation.js";
import { specificationPhaseSchemaForConstitution } from "../engine/artifact-contract.js";
import { PinnedProjectRoot, PinnedRootError } from "../specification/pinned-root.js";
import { isSafeFeatureId, isSafeRelativePath } from "../specification/validation.js";
import { extractTaskMarkers } from "../cto/slice-gate.js";
import { readPinnedConstitutionPrincipleIdentities } from "../specification/constitution-identities.js";
import { buildDispatchMarker, nativeGenerationBinding, parseDispatchMarker, nativeWorkerName, type DispatchMarker } from "./dispatch.js";

interface ToolCallEvent {
  toolName?: string;
  input?: unknown;
}
interface GateContext {
  cwd: string;
  sessionFile?: string;
  sessionBasename?: string;
}
interface NativeSpecificationContext {
  feature_id: string;
  state: TeamState;
  stage: StageDef;
  record: DispatchRecord | null;
  expectedSchema: Record<string, unknown> | null;
  expectedWorkerName: string | null;
  expectedAssignmentDigest: string | null;
}

type NativeMarkerDiagnosticCode =
  | "root_pin"
  | "state_read"
  | "state_parse"
  | "run_mismatch"
  | "state_invalid"
  | "phase_context"
  | "stage"
  | "kind"
  | "cursor"
  | "feature"
  | "marker_feature"
  | "capability"
  | "role"
  | "slot"
  | "roles"
  | "task"
  | "marker";

type NativeContextResolution =
  | { context: NativeSpecificationContext; diagnostic?: undefined }
  | { context: null; diagnostic: NativeMarkerDiagnosticCode };

type NativeSpecificationContextScan =
  | { kind: "contexts"; contexts: NativeSpecificationContext[] }
  | { kind: "scan_failure" }
  | { kind: "overflow" };

/** Native task invocation envelope fields emitted by the engine dispatch result. */
export const NATIVE_SPECIFICATION_TASK_INTENT = "Dispatching specification phase worker";
export const NATIVE_SPECIFICATION_TASK_CONTEXT = "Engine-authorized native specification phase assignment.";
const NATIVE_WORKER_REF_INSTRUCTION = "The engine will inject the authoritative NATIVE_WORKER_INPUT in the child system prompt. Treat it as complete context. Author all prose and document body content in the selected language from NATIVE_WORKER_INPUT.language; preserve the selected template literal headings, markers, and placeholders exactly, even when they are in another language. Do not call any tool, read any source, delegate, or emit commentary; return exactly one strict structured worker_result object via yield. Copy engine_binding.input_ref and engine_binding.input_digest exactly into worker_result.input_ref and worker_result.input_digest. Yield once.";
const NATIVE_WORKER_REFERENCE_PREFIX = "spec-native:";
const NATIVE_WORKER_REF_RE = /^NATIVE_WORKER_INPUT_REF schema=1 ref=([A-Za-z0-9._:-]{1,512}) digest=([a-f0-9]{64})$/;

/**
 * Native specification generation is a closed control-plane transition. While
 * the phase is generating, the coordinator may only dispatch the one
 * engine-authorized worker, consume that worker's exact structured result, and
 * call workflow devices. Generic eval/bash/write paths are not an alternate
 * spawn or fan-in protocol.
 */
export interface NativeSpecificationTaskGateEvaluation {
  /** True only when this exact event was evaluated against an active native phase. */
  active: boolean;
  decision?: { block: true; reason: string };
}

/**
 * Evaluate the native gate once for a tool event. Callers that chain the
 * generic dispatch gate must reuse this result: re-reading only the active
 * boolean can race a phase transition and accidentally skip ordinary gates.
 */
export function evaluateNativeSpecificationTaskGate(
  event: ToolCallEvent,
  ctx: GateContext,
): NativeSpecificationTaskGateEvaluation {
  // Task dispatch is selected from the marker's explicit feature binding. Do
  // this before enumerating any feature directory: a stale/cross-feature
  // marker must never fall through to the active-feature generic gate.
  if (event.toolName === "task") {
    const marker = nativeTaskDispatchMarker(event.input);
    if (nativeFeatureMarkerPresent(event.input)) {
      const selected = marker?.feature_id
        ? nativeSpecificationContextForFeature(ctx.cwd, marker.feature_id, marker.run, marker, false)
        : { context: null, diagnostic: "marker" as const };
      if (!selected.context) return { active: true, decision: { block: true, reason: nativeMarkerReason(selected.diagnostic) } };
      const taskCheck = validateNativeTask(event.input, selected.context);
      return taskCheck === null
        ? { active: true }
        : { active: true, decision: { block: true, reason: taskCheck } };
    }

    // A native envelope is closed even when its feature binding is omitted or
    // malformed. Keep it in the native gate so it cannot fall through to the
    // generic active-feature dispatcher.
    if (nativeTaskEnvelopeCandidate(event.input)) {
      return { active: true, decision: { block: true, reason: nativeTaskReason("marker") } };
    }

    // A parseable dispatch marker without feature_id is still a native-target
    // candidate when its run/stage/cursor identify an active native phase. It
    // must not fall through to dispatchGate, whose generic marker contract
    // treats feature_id as optional. Unrelated tasks remain outside this gate
    // when they do not target the active native phase identity.
    const scan = nativeSpecificationContexts(ctx.cwd);
    if (scan.kind !== "contexts") {
      return { active: true, decision: { block: true, reason: nativeContextScanReason(scan.kind) } };
    }
    if (marker && scan.contexts.some((candidate) =>
      candidate.state.run_key === marker.run
      && candidate.stage.id === marker.stage
      && candidate.stage.type === marker.kind
      && candidate.state.cursor_epoch === marker.cursor
    )) {
      return { active: true, decision: { block: true, reason: nativeMarkerReason("marker_feature") } };
    }
    return { active: false };
  }

  // Coordinator reads/waits/yields are the only events that enumerate active
  // native contexts. A failed broad scan remains closed: it must not fall
  // through to the generic dispatch gate or generic tool handling.
  const scan = nativeSpecificationContexts(ctx.cwd);
  if (scan.kind !== "contexts") {
    return { active: true, decision: { block: true, reason: nativeContextScanReason(scan.kind) } };
  }
  const contexts = scan.contexts;
  if (contexts.length === 0) return { active: false };

  const selected = contextForNativeEvent(event, ctx, contexts);
  const active = selected ?? contexts[0]!;
  if (isWorkflowDevice(event)) return { active: true };
  if (isAllowedNativeRead(event, active, ctx.cwd)) return { active: true };
  if (isNativeWorkerYield(event, active, ctx)) return { active: true };
  if (isExactWorkerResultRead(event, active)) return { active: true };
  if (isCoordinatorWait(event, contexts)) return { active: true };
  return {
    active: true,
    decision: {
      block: true,
      reason: "native specification generation permits only the exact authorized task, exact worker yield transcript, bounded hub wait, workflow devices, and read(agent://<worker_name>)",
    },
  };
}

/** Resolve the feature/run selected by the engine-issued native marker. */
export function nativeSpecificationTaskSelector(
  event: ToolCallEvent,
  cwd: string,
): { feature_id: string; run_key: string } | null {
  if (event.toolName !== "task") return null;
  const marker = nativeTaskDispatchMarker(event.input);
  if (!marker?.feature_id) return null;
  const selected = nativeSpecificationContextForFeature(cwd, marker.feature_id, marker.run, marker);
  return selected.context ? { feature_id: selected.context.feature_id, run_key: selected.context.state.run_key! } : null;
}

function nativeTaskText(input: unknown): string | null {
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  const raw = input as Record<string, unknown>;
  if (!Array.isArray(raw.tasks) || raw.tasks.length !== 1) return null;
  const item = raw.tasks[0];
  if (!item || typeof item !== "object" || Array.isArray(item)) return null;
  const text = (item as Record<string, unknown>).task;
  return typeof text === "string" ? text : null;
}

function nativeTaskDispatchMarker(input: unknown): DispatchMarker | null {
  const text = nativeTaskText(input);
  return text === null ? null : parseDispatchMarker(text);
}

function nativeFeatureMarkerPresent(input: unknown): boolean {
  const text = nativeTaskText(input);
  return text !== null && /<!--\s*omp-dispatch(?:\s+[^>]{0,4096})?\s+feature_id=/u.test(text);
}

function nativeTaskEnvelopeCandidate(input: unknown): boolean {
  if (!input || typeof input !== "object" || Array.isArray(input)) return false;
  const raw = input as Record<string, unknown>;
  return raw.i === NATIVE_SPECIFICATION_TASK_INTENT
    || raw.intent === NATIVE_SPECIFICATION_TASK_INTENT
    || raw.context === NATIVE_SPECIFICATION_TASK_CONTEXT;
}

function nativeMarkerReason(code: NativeMarkerDiagnosticCode): string {
  return nativeTaskReason(`marker_${code}`);
}

function nativeSpecificationContextForFeature(
  cwd: string,
  feature_id: string,
  expectedRunKey?: string,
  marker?: DispatchMarker,
  requireTaskIdentity = true,
): NativeContextResolution {
  if (!isSafeFeatureId(feature_id)) return { context: null, diagnostic: "state_invalid" };
  let pinnedRoot: PinnedProjectRoot | null;
  try {
    pinnedRoot = PinnedProjectRoot.open(cwd);
  } catch {
    return { context: null, diagnostic: "root_pin" };
  }
  if (!pinnedRoot) return { context: null, diagnostic: "root_pin" };
  try {
    return nativeSpecificationContextForFeaturePinned(cwd, pinnedRoot, feature_id, expectedRunKey, marker, requireTaskIdentity);
  } catch {
    return { context: null, diagnostic: "state_invalid" };
  } finally {
    pinnedRoot.close();
  }
}

function nativeSpecificationContextForFeaturePinned(
  cwd: string,
  pinnedRoot: PinnedProjectRoot,
  feature_id: string,
  expectedRunKey?: string,
  marker?: DispatchMarker,
  requireTaskIdentity = true,
): NativeContextResolution {
  if (!isSafeFeatureId(feature_id) || !pinnedRoot.isStable()) return { context: null, diagnostic: "root_pin" };
  let raw: string;
  try {
    raw = new TextDecoder("utf-8", { fatal: true }).decode(
      pinnedRoot.readFile(`.work-state/features/${feature_id}/state.json`, { maxBytes: MAX_PERSISTED_STATE_BYTES }).bytes,
    );
  } catch {
    return { context: null, diagnostic: "state_read" };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { context: null, diagnostic: "state_parse" };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return { context: null, diagnostic: "state_parse" };
  const run_key = (parsed as Record<string, unknown>).run_key;
  if (typeof run_key !== "string" || run_key.trim().length === 0) return { context: null, diagnostic: "state_parse" };
  if (expectedRunKey !== undefined && run_key !== expectedRunKey) return { context: null, diagnostic: "run_mismatch" };
  const resolved = resolveStatePinned(cwd, pinnedRoot, { feature_id, run_key });
  if (resolved.invalid || !resolved.state) return { context: null, diagnostic: "state_invalid" };
  if (!pinnedRoot.isStable()) return { context: null, diagnostic: "root_pin" };
  const context = nativeSpecificationContextFromState(feature_id, resolved.state, pinnedRoot);
  if (!context) return { context: null, diagnostic: "phase_context" };
  if (marker) return findNativeContextForMarker([context], marker, requireTaskIdentity);
  return { context };
}

function findNativeContextForMarker(
  contexts: readonly NativeSpecificationContext[],
  marker: DispatchMarker,
  requireTaskIdentity = true,
): NativeContextResolution {
  if (contexts.length !== 1) return { context: null, diagnostic: "phase_context" };
  const candidate = contexts[0]!;
  const capability = candidate.state.dispatch_capability;
  const identity = candidate.record?.work_identity;
  const expectedRoles = capability?.expected_roster?.map((entry) => entry.role) ?? [];
  if (candidate.state.run_key !== marker.run) return { context: null, diagnostic: "run_mismatch" };
  if (candidate.stage.id !== marker.stage) return { context: null, diagnostic: "stage" };
  if (marker.kind !== candidate.stage.type) return { context: null, diagnostic: "kind" };
  if (marker.cursor !== candidate.state.cursor_epoch) return { context: null, diagnostic: "cursor" };
  if (marker.feature_id !== undefined && marker.feature_id !== candidate.feature_id) return { context: null, diagnostic: "feature" };
  if (marker.capability_id === undefined || marker.capability_id !== capability?.capability_id) return { context: null, diagnostic: "capability" };
  if (marker.role === undefined || marker.role !== candidate.record?.role) return { context: null, diagnostic: "role" };
  if (marker.slot_id === undefined || marker.slot_id !== candidate.record?.role) return { context: null, diagnostic: "slot" };
  if (JSON.stringify([...marker.roles].sort()) !== JSON.stringify([...expectedRoles].sort())) return { context: null, diagnostic: "roles" };
  if (requireTaskIdentity && marker.task_id !== identity?.task_id) return { context: null, diagnostic: "task" };
  return { context: candidate };
}

function contextForNativeEvent(
  event: ToolCallEvent,
  ctx: GateContext,
  contexts: readonly NativeSpecificationContext[],
): NativeSpecificationContext | null {
  if (event.toolName === "read" && event.input && typeof event.input === "object" && !Array.isArray(event.input)) {
    const path = (event.input as Record<string, unknown>).path;
    if (typeof path === "string" && path.startsWith("agent://")) {
      return contexts.find((candidate) => path === `agent://${candidate.expectedWorkerName}`) ?? null;
    }
    if (typeof path === "string") {
      return contexts.find((candidate) => path.includes(`.work-state/features/${candidate.feature_id}/`)) ?? null;
    }
  }
  if (event.toolName === "hub" && event.input && typeof event.input === "object" && !Array.isArray(event.input)) {
    const input = event.input as Record<string, unknown>;
    const worker = Array.isArray(input.ids) && input.ids.length === 1 && typeof input.ids[0] === "string"
      ? input.ids[0] : typeof input.from === "string" ? input.from : null;
    if (worker) return contexts.find((candidate) => candidate.expectedWorkerName === worker) ?? null;
  }
  if (event.toolName === "yield") {
    const basename = boundedSessionBasename(ctx.sessionFile);
    if (basename) return contexts.find((candidate) => basename === `${candidate.expectedWorkerName}.jsonl`) ?? null;
  }
  return null;
}

function isAllowedNativeRead(event: ToolCallEvent, active: NativeSpecificationContext, cwd: string): boolean {
  if (event.toolName !== "read" || !event.input || typeof event.input !== "object" || Array.isArray(event.input)) return false;
  const path = (event.input as Record<string, unknown>).path;
  if (path === "skill://systematic-planning") return true;
  if (typeof path !== "string" || !isSafeRelativePath(path)) return false;
  const declared = new Set<string>();
  const binding = active.state.specification?.constitution_binding;
  if (binding?.path) declared.add(binding.path);
  const phase = active.state.stage_cursor;
  const workspace = active.state.specification;
  const upstream = phase === "plan" ? ["specify"] : phase === "tasks" ? ["specify", "plan"] : [];
  for (const upstreamPhase of upstream) {
    const record = workspace?.phases.find((candidate) => candidate.phase === upstreamPhase);
    const version = record?.approved_version;
    if (typeof version !== "number" || !Number.isSafeInteger(version) || version < 1 || !workspace) continue;
    declared.add(`.work-state/features/${workspace.feature_id}/artifacts/${upstreamPhase}.v${version}.json`);
    const projection = upstreamPhase === "specify" ? "specify_draft" : upstreamPhase === "plan" ? "plan_draft" : "task_graph";
    declared.add(`.work-state/features/${workspace.feature_id}/artifacts/${projection}.json`);
  }
  if (!declared.has(path)) return false;
  const pinnedRoot = PinnedProjectRoot.open(cwd);
  if (!pinnedRoot) return false;
  try {
    const info = pinnedRoot.pathEntryInfo(path);
    return pinnedRoot.isStable() && info?.kind === "file";
  } catch {
    return false;
  } finally {
    pinnedRoot.close();
  }
}

export function nativeSpecificationTaskGate(
  event: ToolCallEvent,
  ctx: GateContext,
): { block: true; reason: string } | undefined {
  return evaluateNativeSpecificationTaskGate(event, ctx).decision;
}

export function nativeSpecificationGenerationActive(cwd: string): boolean {
  const scan = nativeSpecificationContexts(cwd);
  return scan.kind !== "contexts" || scan.contexts.length > 0;
}

function nativeContextScanReason(kind: "scan_failure" | "overflow"): string {
  return kind === "overflow"
    ? "native specification context scan exceeded its bounded feature-directory limit; generation is closed until the scan is safe"
    : "native specification context scan failed; generation is closed until the scan is safe";
}

function isObservabilityOnlyFeatureBucket(
  pinnedRoot: PinnedProjectRoot,
  featurePath: string,
): boolean {
  try {
    const names = pinnedRoot.listDirectory(featurePath, { maxEntries: 2, maxNameBytes: 4096 });
    if (names.length !== 1 || names[0] !== "observability") return false;
    return pinnedRoot.pathEntryInfo(featurePath + "/observability")?.kind === "directory"
      && pinnedRoot.isStable();
  } catch {
    return false;
  }
}

function nativeSpecificationContexts(cwd: string): NativeSpecificationContextScan {
  let pinnedRoot: PinnedProjectRoot | null;
  try {
    pinnedRoot = PinnedProjectRoot.open(cwd);
  } catch {
    return { kind: "scan_failure" };
  }
  if (!pinnedRoot) return { kind: "scan_failure" };
  try {
    const featuresPath = ".work-state/features";
    const info = pinnedRoot.pathEntryInfo(featuresPath);
    if (!info) return { kind: "contexts", contexts: [] };
    if (info.kind !== "directory") return { kind: "scan_failure" };
    let names: string[];
    try {
      names = pinnedRoot.listDirectory(featuresPath, { maxEntries: 1024, maxNameBytes: 128 * 1024 });
    } catch (error) {
      return { kind: error instanceof PinnedRootError && error.code === "limit" ? "overflow" : "scan_failure" };
    }
    const contexts: NativeSpecificationContext[] = [];
    for (const feature_id of names) {
      if (!/^[a-z0-9][a-z0-9._-]*$/u.test(feature_id)) continue;
      const featurePath = featuresPath + "/" + feature_id;
      const featureInfo = pinnedRoot.pathEntryInfo(featurePath);
      if (!featureInfo || featureInfo.kind !== "directory") return { kind: "scan_failure" };
      const statePath = featurePath + "/state.json";
      const stateInfo = pinnedRoot.pathEntryInfo(statePath);
      if (!stateInfo) {
        // Observability may legitimately start before any feature is selected,
        // producing features/<slug>/observability without a workflow state.
        // Admit only that exact auxiliary shape; every partial or malformed
        // feature workspace remains fail-closed.
        if (isObservabilityOnlyFeatureBucket(pinnedRoot, featurePath)) continue;
        return { kind: "scan_failure" };
      }
      if (stateInfo.kind !== "file") return { kind: "scan_failure" };
      let run_key: unknown;
      try {
        const raw = new TextDecoder("utf-8", { fatal: true }).decode(pinnedRoot.readFile(statePath, { maxBytes: MAX_PERSISTED_STATE_BYTES }).bytes);
        run_key = (JSON.parse(raw) as Record<string, unknown>).run_key;
      } catch {
        return { kind: "scan_failure" };
      }
      if (typeof run_key !== "string" || run_key.trim().length === 0) return { kind: "scan_failure" };
      const resolved = resolveStatePinned(cwd, pinnedRoot, { feature_id, run_key });
      if (resolved.invalid || !resolved.state) return { kind: "scan_failure" };
      const context = nativeSpecificationContextFromState(feature_id, resolved.state, pinnedRoot);
      if (context) contexts.push(context);
    }
    return { kind: "contexts", contexts };
  } catch {
    return { kind: "scan_failure" };
  } finally {
    pinnedRoot.close();
  }
}

function nativeSpecificationContextFromState(
  feature_id: string,
  state: TeamState,
  pinnedRoot: PinnedProjectRoot,
): NativeSpecificationContext | null {
  const workspace = state.specification;
  const phase = state.stage_cursor;
  if (
    state.classification?.workflow !== "spec-preparation"
    || workspace?.source_kind !== "native"
    || (phase !== "specify" && phase !== "plan" && phase !== "tasks")
  ) return null;
  const phaseRecord = workspace.phases.find((candidate) => candidate.phase === phase);
  if (phaseRecord?.status !== "generating") return null;
  const profile = loadProfile("spec-preparation");
  const stage = profile?.stages.find((candidate) => candidate.id === phase) ?? null;
  if (stage === null || state.profile_hash === undefined || !profile || profileHash(profile) !== state.profile_hash) {
    return { feature_id, state, stage: stage ?? { id: phase, title: phase, type: "single", role: "" }, record: null, expectedSchema: null, expectedWorkerName: null, expectedAssignmentDigest: null };
  }
  const capability = state.dispatch_capability;
  const preferredId = state.preparation_start?.dispatch_id;
  const records = capability?.dispatches?.filter((candidate) => (candidate.purpose ?? "generation") === "generation") ?? [];
  const record = (preferredId ? records.find((candidate) => candidate.id === preferredId) : undefined) ?? records.at(-1) ?? null;
  if (!record || !record.work_identity || !record.tool_call_id || !workspace.constitution_binding) return { feature_id, state, stage, record, expectedSchema: null, expectedWorkerName: null, expectedAssignmentDigest: null };
  const identity = record.work_identity;
  if (!capability?.capability_id
    || !capability.issued_for
    || identity.run_id !== state.run_key
    || identity.workflow !== capability.issued_for.workflow
    || identity.stage_id !== phase
    || identity.stage_cursor !== phase
    || identity.dispatch_id !== record.id
    || identity.capability_id !== capability.capability_id) {
    return { feature_id, state, stage, record: null, expectedSchema: null, expectedWorkerName: null, expectedAssignmentDigest: null };
  }
  const expectedAssignmentDigest = identity.task_id;
  const expectedWorkerName = nativeWorkerName(phase, record.id);
  let expectedSchema: Record<string, unknown> | null = null;
  const identities = readPinnedConstitutionPrincipleIdentities(pinnedRoot, workspace.constitution_binding);
  if (identities.ok) {
    const generation = nativeGenerationBinding({
      feature_id,
      run_key: state.run_key!,
      phase,
      version: (phaseRecord.current_version ?? 0) + 1,
      request_id: record.tool_call_id,
      dispatch_id: record.id,
      capability_id: record.work_identity.capability_id,
      capability_epoch: record.work_identity.capability_epoch,
      run_id: record.work_identity.run_id,
      workflow: record.work_identity.workflow,
      task_id: record.work_identity.task_id,
      worker_id: record.work_identity.worker_id,
    });
    const schema = specificationPhaseSchemaForConstitution(identities.value, workspace.constitution_binding, phase, generation);
    if (schema && typeof schema === "object" && !Array.isArray(schema)) expectedSchema = schema as Record<string, unknown>;
  }
  return { feature_id, state, stage, record, expectedSchema, expectedWorkerName, expectedAssignmentDigest };
}

const MAX_NATIVE_SCHEMA_BYTES = 512 * 1024;

/**
 * Compare task schemas by bounded canonical JSON, not object graph identity.
 * Dynamic schemas may intentionally share sub-objects in memory, while the
 * host task transport necessarily round-trips them through JSON. The shared
 * structure validator still rejects cycles, accessors, exotic prototypes,
 * non-JSON values, and hostile size/shape before canonicalization.
 */
function canonicalNativeSchemaIdentity(value: unknown): { digest: string; bytes: number } | null {
  const structure = validateArtifactStructure(value);
  if (!structure.ok) return null;
  let canonical: string;
  try {
    canonical = canonicalJson(value);
  } catch {
    return null;
  }
  const bytes = Buffer.byteLength(canonical, "utf8");
  if (bytes > MAX_NATIVE_SCHEMA_BYTES) return null;
  return { digest: sha256Hex(canonical), bytes };
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return actual.length === wanted.length && actual.every((key, index) => key === wanted[index]);
}

const MAX_NATIVE_DIAGNOSTIC_KEYS = 32;
const MAX_NATIVE_DIAGNOSTIC_KEY_BYTES = 128;

function nativeTaskReason(code: string, detail?: string): string {
  return detail === undefined
    ? `native specification task: ${code}`
    : `native specification task: ${code}; ${detail}`;
}

function diagnosticKeys(value: Record<string, unknown>): string {
  return JSON.stringify(Object.keys(value).sort().slice(0, MAX_NATIVE_DIAGNOSTIC_KEYS).map((key) => {
    const bytes = Buffer.byteLength(key, "utf8");
    if (bytes <= MAX_NATIVE_DIAGNOSTIC_KEY_BYTES) return key;
    return `${Buffer.from(key, "utf8").subarray(0, MAX_NATIVE_DIAGNOSTIC_KEY_BYTES).toString("utf8")}…`;
  }));
}

function validateNativeTask(input: unknown, active: NativeSpecificationContext): string | null {
  if (
    !active.record
    || !active.record.work_identity
    || active.record.work_identity.dispatch_id !== active.record.id
    || active.record.work_identity.capability_id !== active.state.dispatch_capability?.capability_id
    || !active.expectedWorkerName
    || !active.expectedAssignmentDigest
    || !active.expectedSchema
    || active.state.dispatch_capability?.status !== "dispatched"
    || !active.state.dispatch_capability.capability_id
    || !active.state.dispatch_capability.issued_for
  ) {
    return "native specification task requires an engine-authorized phase dispatch and dynamic output schema";
  }
  if (!input || typeof input !== "object" || Array.isArray(input)) return nativeTaskReason("top_object");
  const raw = input as Record<string, unknown>;
  const topKeysValid = [
    ["context", "tasks"],
    ["context", "tasks", "i"],
    ["context", "tasks", "intent"],
    ["context", "tasks", "i", "intent"],
  ].some((keys) => exactKeys(raw, keys));
  if (!topKeysValid) return nativeTaskReason("top_keys", `top_keys=${diagnosticKeys(raw)}`);
  if (Object.prototype.hasOwnProperty.call(raw, "i") && raw.i !== NATIVE_SPECIFICATION_TASK_INTENT) return nativeTaskReason("i");
  if (Object.prototype.hasOwnProperty.call(raw, "intent") && raw.intent !== NATIVE_SPECIFICATION_TASK_INTENT) {
    return nativeTaskReason("optional_intent");
  }
  if (typeof raw.context !== "string" || raw.context.trim().length === 0) return nativeTaskReason("context");
  const rawItems = raw.tasks;
  if (!Array.isArray(rawItems)) return nativeTaskReason("tasks_type");
  if (rawItems.length !== 1) return nativeTaskReason("tasks_count", `tasks_length=${rawItems.length}`);
  const shape = extractTaskMarkers(input);
  // The engine dispatch result exposes one complete batch envelope. A flat task
  // or a batch with any literal pseudo-entry must never reach the host tool.
  if (shape.kind !== "batch") return nativeTaskReason("task");
  const item = rawItems[0];
  if (!item || typeof item !== "object" || Array.isArray(item)) return nativeTaskReason("item_object");
  const task = item as Record<string, unknown>;
  if (!exactKeys(task, ["name", "agent", "task", "outputSchema", "schemaMode"])) {
    return nativeTaskReason("item_keys", `item_keys=${diagnosticKeys(task)}`);
  }
  if (task.name !== active.expectedWorkerName) return nativeTaskReason("name");
  if (task.agent !== active.record.agent) return nativeTaskReason("agent");
  if (typeof task.task !== "string") return nativeTaskReason("task");
  const text = task.task;
  const marker = parseDispatchMarker(text);
  if (!marker) return nativeTaskReason("marker");
  if (
    marker.run !== active.state.run_key
    || marker.stage !== active.stage.id
    || marker.cursor !== active.state.cursor_epoch
    || marker.kind !== "single"
    || marker.role !== active.record.role
    || marker.slot_id !== active.record.role
    || marker.capability_id !== active.state.dispatch_capability?.capability_id
  ) {
    return nativeTaskReason("marker");
  }
  if (marker.task_id !== active.expectedAssignmentDigest) return nativeTaskReason("digest");
  let canonicalMarker: string;
  try {
    canonicalMarker = buildDispatchMarker(
      active.state.run_key!,
      active.stage,
      [active.record.role],
      active.record.role,
      active.state.cursor_epoch!,
      active.state.dispatch_capability.capability_id,
      active.record.role,
      active.expectedAssignmentDigest,
      active.feature_id,
    );
  } catch {
    return nativeTaskReason("marker");
  }
  const markerEnd = text.indexOf("\n\n");
  if (markerEnd <= 0 || text.slice(0, markerEnd) !== canonicalMarker) return nativeTaskReason("marker");
  const bodyParts = text.split("\n\n");
  if (bodyParts.length !== 3 && bodyParts.length !== 4) return nativeTaskReason("marker");
  if (bodyParts[0] !== text.slice(0, text.indexOf("\n\n")) || bodyParts[0].length === 0) return nativeTaskReason("marker");
  const referenceMatch = bodyParts[1]?.match(NATIVE_WORKER_REF_RE);
  if (!referenceMatch || bodyParts[2] !== NATIVE_WORKER_REF_INSTRUCTION) return nativeTaskReason("marker");
  const expectedReference = NATIVE_WORKER_REFERENCE_PREFIX + [active.feature_id, active.state.run_key, active.stage.id, active.record.id].join(":");
  if (referenceMatch[1] !== expectedReference) return nativeTaskReason("marker");
  const expectedCtoMarker = active.state.preparation_start?.cto_slice_marker;
  if ((expectedCtoMarker === undefined && bodyParts.length === 4)
    || (expectedCtoMarker !== undefined && (bodyParts.length !== 4 || bodyParts[3] !== expectedCtoMarker))) return nativeTaskReason("marker");
  const actualSchemaIdentity = canonicalNativeSchemaIdentity(task.outputSchema);
  const expectedSchemaIdentity = canonicalNativeSchemaIdentity(active.expectedSchema);
  if (
    actualSchemaIdentity === null
    || expectedSchemaIdentity === null
    || actualSchemaIdentity.bytes !== expectedSchemaIdentity.bytes
    || actualSchemaIdentity.digest !== expectedSchemaIdentity.digest
  ) {
    return nativeTaskReason("canonical_schema");
  }
  if (task.schemaMode !== "strict") return nativeTaskReason("schema_mode");
  return null;
}
const NATIVE_ENGINE_WORKFLOW_DEVICES = new Set<string>([
  "xd://workflow_prepare",
  "xd://workflow_begin",
  "xd://workflow_status",
  "xd://workflow_instructions",
  "xd://workflow_dispatch_specification_phase",
  "xd://workflow_persist_specification_phase",
  "xd://workflow_complete",
  "xd://workflow_start_native_specification_phase",
  "xd://workflow_finalize_native_specification_phase",
  "xd://workflow_begin_phase_validation",
  "xd://workflow_validate_phase",
  "xd://workflow_checkpoint",
  "xd://workflow_checkpoint_ask_selected",
  "xd://workflow_advance",
]);
const NATIVE_ENGINE_WORKFLOW_TOOL_NAMES = new Set<string>(
  [...NATIVE_ENGINE_WORKFLOW_DEVICES].map((path) => path.slice("xd://".length)),
);

const MAX_NATIVE_SESSION_FILE_BYTES = 4096;
const MAX_NATIVE_SESSION_BASENAME_BYTES = 512;

function boundedSessionBasename(sessionFile: unknown): string | null {
  if (typeof sessionFile !== "string" || sessionFile.length === 0 || Buffer.byteLength(sessionFile, "utf8") > MAX_NATIVE_SESSION_FILE_BYTES) return null;
  if (/[\u0000\r\n]/u.test(sessionFile)) return null;
  const segments = sessionFile.split(/[\\/]/u);
  if (segments.some((segment) => segment === "." || segment === "..")) return null;
  const basename = segments.at(-1);
  if (!basename || Buffer.byteLength(basename, "utf8") > MAX_NATIVE_SESSION_BASENAME_BYTES) return null;
  return basename;
}

function isNativeWorkerYield(event: ToolCallEvent, active: NativeSpecificationContext, ctx: GateContext): boolean {
  if (event.toolName !== "yield" || !active.expectedWorkerName) return false;
  const basename = boundedSessionBasename(ctx.sessionFile);
  return basename !== null
    && basename === ctx.sessionBasename
    && basename === `${active.expectedWorkerName}.jsonl`;
}
function isWorkflowDevice(event: ToolCallEvent): boolean {
  if (!event.input || typeof event.input !== "object" || Array.isArray(event.input)) return false;
  if (typeof event.toolName === "string" && NATIVE_ENGINE_WORKFLOW_TOOL_NAMES.has(event.toolName)) return true;
  if (event.toolName !== "read" && event.toolName !== "write") return false;
  const input = event.input as Record<string, unknown>;
  const path = input.path ?? input.file_path;
  return typeof path === "string" && NATIVE_ENGINE_WORKFLOW_DEVICES.has(path);
}



function isExactWorkerResultRead(event: ToolCallEvent, active: NativeSpecificationContext): boolean {
  if (event.toolName !== "read" || !active.expectedWorkerName) return false;
  if (!event.input || typeof event.input !== "object" || Array.isArray(event.input)) return false;
  const input = event.input as Record<string, unknown>;
  return input.path === `agent://${active.expectedWorkerName}`;
}

const MAX_NATIVE_WAIT_MS = 630_000;
const MAX_NATIVE_WAIT_INTENT_BYTES = 512;

type PendingGenerationCheck =
  | { kind: "none" }
  | { kind: "invalid" }
  | { kind: "pending"; workerName: string };

function currentPendingGeneration(context: NativeSpecificationContext): PendingGenerationCheck {
  const capability = context.state.dispatch_capability;
  const pendingGenerations = (capability?.dispatches ?? []).filter((candidate) =>
    (candidate.purpose ?? "generation") === "generation"
    && ["authorized", "running", "pending"].includes(candidate.status)
  );
  if (pendingGenerations.length === 0) return { kind: "none" };
  if (
    capability?.status !== "dispatched"
    || !capability.capability_id
    || !capability.issued_for
    || capability.issued_for.run_key !== context.state.run_key
    || capability.issued_for.workflow !== context.state.classification?.workflow
    || capability.issued_for.profile_hash !== context.state.profile_hash
    || capability.issued_for.stage_cursor !== context.stage.id
    || !context.record
    || !context.expectedWorkerName
    || !context.expectedAssignmentDigest
    || pendingGenerations.length !== 1
  ) return { kind: "invalid" };
  const pending = pendingGenerations[0]!;
  const identity = context.record.work_identity;
  if (
    pending.id !== context.record.id
    || context.record.status !== pending.status
    || !identity
    || identity.run_id !== context.state.run_key
    || identity.workflow !== capability.issued_for.workflow
    || identity.stage_id !== context.stage.id
    || identity.stage_cursor !== capability.issued_for.stage_cursor
    || identity.capability_id !== capability.capability_id
    || identity.capability_epoch !== capability.issued_for.cursor_epoch
    || identity.slot_id !== context.record.role
    || identity.task_id !== context.expectedAssignmentDigest
    || identity.dispatch_id !== context.record.id
    || identity.attempt !== context.record.attempt
    || identity.worker_id !== context.record.agent
  ) return { kind: "invalid" };
  return { kind: "pending", workerName: context.expectedWorkerName };
}

function isCoordinatorWait(event: ToolCallEvent, contexts: readonly NativeSpecificationContext[]): boolean {
  if (event.toolName !== "hub") return false;
  if (!event.input || typeof event.input !== "object" || Array.isArray(event.input)) return false;
  const input = event.input as Record<string, unknown>;
  const allowed = ["i", "op", "ids", "from", "timeoutMs"];
  if (Object.keys(input).some((key) => !allowed.includes(key)) || input.op !== "wait") return false;
  if (Object.hasOwn(input, "i")) {
    if (typeof input.i !== "string" || Buffer.byteLength(input.i, "utf8") > MAX_NATIVE_WAIT_INTENT_BYTES || /[\r\n]/u.test(input.i)) return false;
  }
  const hasIds = Object.hasOwn(input, "ids");
  const hasFrom = Object.hasOwn(input, "from");
  if (hasIds && hasFrom) return false;
  const timeoutMs = input.timeoutMs;
  if (timeoutMs !== undefined && (typeof timeoutMs !== "number" || !Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > MAX_NATIVE_WAIT_MS)) return false;

  const pending = contexts.map(currentPendingGeneration);
  if (pending.some((candidate) => candidate.kind === "invalid")) return false;
  const pendingWorkers = pending.filter((candidate): candidate is { kind: "pending"; workerName: string } => candidate.kind === "pending");
  if (pendingWorkers.length === 0) return false;

  const pendingWorkerNames = pendingWorkers.map((candidate) => candidate.workerName);
  const pendingWorkerNameSet = new Set(pendingWorkerNames);
  if (pendingWorkerNameSet.size !== pendingWorkerNames.length) return false;
  if (hasIds) {
    const ids = input.ids;
    if (!Array.isArray(ids) || ids.length === 0 || ids.length > pendingWorkerNames.length || ids.some((id) => typeof id !== "string")) return false;
    const idSet = new Set(ids);
    return idSet.size === ids.length
      && [...idSet].every((id) => pendingWorkerNameSet.has(id));
  }
  if (hasFrom) {
    return typeof input.from === "string"
      && pendingWorkerNameSet.has(input.from);
  }
  return contexts.length === 1 && pendingWorkers.length === 1;
}
