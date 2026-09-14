/** Engine-owned native CTO specification-preparation bootstrap. */

import { join } from "node:path";
import type { CtoSpecificationPreparationTransaction, CtoState } from "./types.js";
import {
  MAX_CTO_SPECIFICATION_AGGREGATE_BYTES,
  MAX_CTO_SPECIFICATION_DECISIONS,
  MAX_CTO_SPECIFICATION_FACETS,
  MAX_CTO_SPECIFICATION_REQUESTS,
  MAX_PREPARATION_QUEUE_ITEMS,
  MAX_CTO_SPECIFICATION_TEXT_BYTES,
} from "./types.js";
import type { WorkspacePhase, ConstitutionBinding, ConstitutionGateRecord } from "../specification/types.js";
import type { AdvanceCtoSpecificationPreparationResult } from "./run.js";
import type { ModelClassification } from "../engine/run.js";
import type { DoD } from "../engine/types.js";
import type { CtoSpecificationDecision } from "./decisions.js";
import type { CtoSpecificationReviewPacket } from "./specification-review-packet.js";
import type { CtoSpecificationPreparationQueueReasonCode, CtoSpecificationPreparationQueuedRequest, CtoSpecificationPreparationRequest, CtoSpecificationPreparationScheduledRequest } from "./scheduler.js";
import { createCapability } from "../engine/durable.js";
import { isSafeStateSegment } from "../engine/state.js";
import { loadProfile, profileHash } from "../engine/profile.js";
import { digestOf, isSafeFeatureId, isSha256Hex, sha256Hex } from "../specification/validation.js";
import { createFeatureWorkspace, resolveFeatureWorkspace, type WorkspaceRootSnapshot } from "../specification/workspace.js";
import { currentConstitutionPersistenceIssue, ensureCtoPreparationPrerequisite, ensureProjectConstitution } from "../specification/prerequisite.js";
import { PinnedProjectRoot, PinnedRootError, rollbackPinnedRootWriteReceipt, type PinnedRootWriteDescriptor, type PinnedRootWritePreimage, type PinnedRootWriteReceipt } from "../specification/pinned-root.js";
import { canonicalCtoDoDDigest, writeCtoDoDExclusive } from "./dod.js";
import { readCtoWorkspaceConstitution } from "./gates.js";
import { TextDecoder } from "node:util";
import { MAX_DOD_BYTES, readDoDFilePinned } from "../engine/dod.js";
import { scheduleCtoSpecificationPreparation } from "./scheduler.js";
import { activeWave, ctoPreparationTeamId, ctoRuntimeRunInitialIdentityDigest, deriveSafeCtoId, isSafeCtoRunId, newCtoState, readCtoRunDeliveryIndexAuthorityPinned, readCtoRunDeliveryReconciledActiveCandidatesPinned, readCtoStatePinned } from "./state.js";
import { buildCtoSliceMarker } from "./slice-marker.js";
import { appendWave } from "./waves.js";
import { assertCtoRuntimeAccessFacadeLive, type CtoRuntimeAccessFacade } from "./runtime-access.js";
import { withCtoRunLock } from "./transaction-lock.js";
import { buildCtoSpecificationReviewPacketFromDecisionSnapshotPinned } from "./specification-review-packet.js";
import { readCtoSpecificationDecisionsWhileLocked, recordCtoSpecificationDecisionsWhileLocked } from "./decisions.js";
import { advanceCtoSpecificationPreparation, injectPreparationFailure } from "./run.js";

const MAX_REQUESTS = MAX_CTO_SPECIFICATION_REQUESTS;
const MAX_FACETS = MAX_CTO_SPECIFICATION_FACETS;
const MAX_TEXT = MAX_CTO_SPECIFICATION_TEXT_BYTES;
const WORKFLOW = "spec-preparation" as const;
/** Canonical PHASE-0 routing policy for engine-created native preparation writers. */
export const CTO_SPECIFICATION_PREPARATION_CLASSIFICATION: Readonly<ModelClassification> = Object.freeze({
  type: "SPEC",
  complexity: "MEDIUM",
  confidence: "HIGH",
  autonomous: false,
  workflow: WORKFLOW,
});
function preparationClassification(): ModelClassification {
  return { ...CTO_SPECIFICATION_PREPARATION_CLASSIFICATION };
}
/**
 * The bootstrap journal repeats the bounded preparation request as persisted
 * feature intent and adds generated identities, workspace paths, digests, and
 * pretty-print/recovery metadata. Reserve one full aggregate allowance for
 * that projection and its UTF-8 JSON overhead. The same derived cap is used
 * by the writer and reader below, so every accepted maximum-sized request
 * remains recoverable.
 */
const MAX_BOOTSTRAP_JOURNAL_BYTES = MAX_CTO_SPECIFICATION_AGGREGATE_BYTES * 2;
const MAX_BOOTSTRAP_JOURNAL_JSON_DEPTH = 32;
const MAX_BOOTSTRAP_JOURNAL_JSON_NODES = 12_000;
const MAX_BOOTSTRAP_JOURNAL_JSON_KEYS = 128;
const MAX_BOOTSTRAP_JOURNAL_JSON_ARRAY = 256;
const WAVE_SOURCE = "specification-preparation";
const PHASE: WorkspacePhase = "specify";
const PREPARATION_PHASES: readonly WorkspacePhase[] = ["specify", "plan", "tasks"];
const PREPARATION_DOD_ROOT = ".work-state/artifacts";
const PREPARATION_DOD_SOURCE = "engine";

const preparationTeamId = ctoPreparationTeamId;

function preparationDodPath(teamId: string): string {
  return PREPARATION_DOD_ROOT + "/" + teamId;
}

function preparationDodBinding(runId: string, teamId: string, feature: PersistedFeature): string {
  return [
    "run=" + runId,
    "team=" + teamId,
    "slice=" + feature.phase_writer_id,
    "feature=" + feature.feature_id,
    "phase=" + PHASE,
    "facets=" + feature.facets.join(","),
  ].join(";");
}

function preparationWriterDoD(runId: string, teamId: string, feature: PersistedFeature): DoD {
  const binding = preparationDodBinding(runId, teamId, feature);
  const obligation = (id: string, criterion: string, verifyMethod: string) => ({
    id,
    source: PREPARATION_DOD_SOURCE,
    criterion: criterion + " [" + binding + "]",
    verify_method: verifyMethod + " [" + binding + "]",
    status: "pending" as const,
    evidence: "",
  });
  return {
    items: [
      obligation("phase-artifact", "Produce one typed immutable phase artifact, readable document, and semantic model", "canonical phase artifact reader"),
      obligation("phase-validation", "Complete validation of the canonical phase artifact and its semantic model", "phase validation gate"),
      obligation("no-implementation-claim", "Do not implement code or acquire an implementation claim during specification preparation", "execution claim absence check"),
      obligation("constitution-binding", "Preserve the exact constitution binding selected for this preparation run", "constitution binding comparison"),
      obligation("upstream-binding", "Preserve every frozen upstream phase version and digest required by this phase", "upstream version comparison"),
      obligation("presentation-bindings", "Preserve the bound language and template presentation bindings", "language and template binding comparison"),
    ],
    type_requirements_met: true,
    updated_at: new Date().toISOString(),
  };
}

interface PreparationWriterDescriptor {
  teamId: string;
  dodPath: string;
  dod: DoD;
  dodDigest: string;
}

function preparationWriterDescriptor(runId: string, feature: PersistedFeature): PreparationWriterDescriptor {
  const teamId = preparationTeamId(feature.request_id);
  const dod = preparationWriterDoD(runId, teamId, feature);
  return { teamId, dodPath: preparationDodPath(teamId), dod, dodDigest: canonicalCtoDoDDigest(dod) };
}

function preparedWriterDoDMatches(
  root: string,
  pinnedRoot: PinnedProjectRoot,
  runId: string,
  feature: PersistedFeature,
  team: CtoState["teams"][number],
): boolean {
  const expected = preparationWriterDescriptor(runId, feature);
  if (team.id !== expected.teamId || team.dod_path !== expected.dodPath || team.dod_digest !== expected.dodDigest) return false;
  const file = join(root, expected.dodPath, "dod.json");
  const relativeFile = pinnedRoot.relativePath(file);
  if (!relativeFile) return false;
  const loaded = readDoDFilePinned(pinnedRoot, relativeFile);
  if (!loaded.ok) return false;
  try { return canonicalCtoDoDDigest(loaded.dod) === expected.dodDigest; } catch { return false; }
}
function decodeUtf8(bytes: Uint8Array): string {
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}

export interface CtoSpecificationPreparationRequestInput { request_id: string; feature_id: string; request: string; facet_ids?: readonly string[]; owner_id?: string; }
export interface CtoSpecificationPreparationOptions { runtimeAccess: CtoRuntimeAccessFacade; sessionId: string; }
export interface CtoSpecificationPreparationInput { cto_run_id: string; task: string; branch: string; requests: readonly CtoSpecificationPreparationRequestInput[]; capacity: number; depth: number; max_depth: number; resident_cto_run_id: string; wave_id?: string; source_id?: string; }
export interface CtoSpecificationPreparationFeature { request_id: string; feature_id: string; run_key: string; workspace_path: string; state_path: string; profile_name: string; profile_hash: string; phase_writer_id: string; facets: string[]; }
export interface CtoSpecificationPreparationConstitution { status: ConstitutionGateRecord["status"]; gate_id: string; checkpoint_ref: string | null; binding?: ConstitutionBinding; }
export interface CtoSpecificationPreparationReady { status: "ready"; prepared: true; dispatched: false; cto_run_id: string; wave_id: string; source_id: string; features: CtoSpecificationPreparationFeature[]; scheduled: CtoSpecificationPreparationScheduledRequest[]; queued: CtoSpecificationPreparationQueuedRequest[]; constitution: CtoSpecificationPreparationConstitution; review_packet_ref: null; }
export interface CtoSpecificationPreparationBlocked { status: "blocked"; prepared: false; dispatched: false; findings: string[]; }
export type CtoSpecificationPreparationResult = CtoSpecificationPreparationReady | CtoSpecificationPreparationBlocked;
export type CtoSpecificationReviewResult = CtoSpecificationReviewPacket | { status: "blocked"; dispatched: false; findings: string[] };
export type CtoSpecificationAdvanceResult = AdvanceCtoSpecificationPreparationResult;
export type CtoSpecificationDecisionsResult = { status: "recorded"; dispatched: false; decisions: CtoSpecificationDecision[] } | { status: "blocked"; dispatched: false; findings: string[] };

interface PersistedFeature extends CtoSpecificationPreparationFeature { request: string; owner_id?: string; }
interface PreparationState extends CtoState { preparation_features?: PersistedFeature[]; preparation_queued?: CtoSpecificationPreparationQueuedRequest[]; preparation_capability?: { capability_id?: unknown; kind?: unknown; expected_roles?: unknown; expected_count?: unknown; status?: unknown; issued_for?: { run_key?: unknown; branch?: unknown; workflow?: unknown; profile_hash?: unknown; stage_cursor?: unknown; cursor_epoch?: unknown } }; }
interface NormalizedInput { ctoRunId: string; task: string; branch: string; residentRunId: string; requests: CtoSpecificationPreparationRequestInput[]; capacity: number; depth: number; maxDepth: number; waveId: string; sourceId: string; digest: string; }
interface ActivePreparationContext { state: PreparationState; wave: NonNullable<ReturnType<typeof activeWave>>; features: PersistedFeature[]; pinnedRoot: PinnedProjectRoot; }

function blocked(...findings: string[]): CtoSpecificationPreparationBlocked { return { status: "blocked", prepared: false, dispatched: false, findings }; }
function hasCanonicalPreparationClassification(team: CtoState["teams"][number]): boolean {
  return JSON.stringify(team.classification) === JSON.stringify(CTO_SPECIFICATION_PREPARATION_CLASSIFICATION);
}
/** Resolve the exact engine-owned CTO slice marker for one prepared feature. */
export function resolveCtoSpecificationPreparationSliceMarker(projectRoot: string, featureId: string, runKey: string): string | null {
  if (!isSafeFeatureId(featureId) || !isSafeStateSegment(runKey)) return null;
  const pinnedRoot = PinnedProjectRoot.open(projectRoot);
  if (!pinnedRoot) return null;
  try {
    const candidates = readCtoRunDeliveryReconciledActiveCandidatesPinned(pinnedRoot);
    if (!candidates.ok) return null;
    const matches: Array<{ runId: string; sliceId: string }> = [];
    for (const entry of candidates.entries) {
      const state = readCtoStatePinned(entry.run_id, pinnedRoot) as PreparationState | null;
      if (!state || state.id !== entry.run_id) continue;
      const wave = activeWave(state);
      if (!wave || wave.source !== WAVE_SOURCE) continue;
      const features = state.preparation_features;
      if (!Array.isArray(features)) continue;
      const featureMatches = features.filter((feature) => feature.feature_id === featureId && feature.run_key === runKey);
      if (featureMatches.length !== 1) continue;
      const sliceId = featureMatches[0]?.phase_writer_id;
      if (typeof sliceId !== "string" || !isSafeStateSegment(sliceId)) continue;
      if (wave.slice_ids.filter((candidate) => candidate === sliceId).length !== 1) continue;
      const teams = state.teams.filter((team) => team.feature_id === featureId && team.run_key === runKey && team.slice_id === sliceId);
      if (teams.length !== 1 || !hasCanonicalPreparationClassification(teams[0]!)) continue;
      matches.push({ runId: state.id, sliceId });
    }
    return matches.length === 1 ? buildCtoSliceMarker(matches[0]!.runId, matches[0]!.sliceId) : null;
  } catch {
    return null;
  } finally {
    pinnedRoot.close();
  }
}
function safeId(value: unknown, field: string): string | null { return typeof value === "string" && isSafeCtoRunId(value) && Buffer.byteLength(value, "utf8") <= 128 ? null : `${field} must be a canonical safe non-empty state segment`; }
function nonBlank(value: unknown, field: string, max = MAX_TEXT): string | null { if (typeof value !== "string" || value.trim().length === 0) return `${field} must be non-blank`; return Buffer.byteLength(value, "utf8") > max ? `${field} exceeds the safe input limit` : null; }
function writerId(featureId: string): string { return `cto-writer-${sha256Hex(`${featureId}\u0000${PHASE}`).slice(0, 16)}`; }
function constitutionProjection(gate: ConstitutionGateRecord): CtoSpecificationPreparationConstitution { return { status: gate.status, gate_id: gate.gate_id, checkpoint_ref: gate.checkpoint_ref, ...(gate.binding ? { binding: { ...gate.binding } } : {}) }; }
function borrowedRoot(pinnedRoot: PinnedProjectRoot): WorkspaceRootSnapshot { return { lexical_root: pinnedRoot.lexical_root, canonical_root: pinnedRoot.canonical_root, dev: pinnedRoot.dev, ino: pinnedRoot.ino, pinned_root: pinnedRoot }; }
function queuedRunKey(request: CtoSpecificationPreparationRequestInput): string { return `queued-${sha256Hex(`${request.request_id}\u0000${request.feature_id}`).slice(0, 32)}`; }

function normalizeInput(input: CtoSpecificationPreparationInput): { ok: true; value: NormalizedInput } | { ok: false; findings: string[] } {
  if (!input || typeof input !== "object") return { ok: false, findings: ["preparation input is required"] };
  try {
    const serialized = JSON.stringify(input);
    if (typeof serialized !== "string" || Buffer.byteLength(serialized, "utf8") > MAX_CTO_SPECIFICATION_AGGREGATE_BYTES) {
      return { ok: false, findings: [`preparation input exceeds ${MAX_CTO_SPECIFICATION_AGGREGATE_BYTES} bytes`] };
    }
  } catch {
    return { ok: false, findings: ["preparation input must be JSON-serializable"] };
  }
  const findings: string[] = [];
  for (const [value, field] of [[input.cto_run_id, "cto_run_id"], [input.resident_cto_run_id, "resident_cto_run_id"]] as const) { const error = safeId(value, field); if (error) findings.push(error); }
  const taskError = nonBlank(input.task, "task"); if (taskError) findings.push(taskError);
  const branchError = nonBlank(input.branch, "branch", 1024); if (branchError) findings.push(branchError);
  if (input.cto_run_id !== input.resident_cto_run_id) findings.push(`active resident CTO mismatch: cto_run_id '${String(input.cto_run_id)}' is not resident_cto_run_id '${String(input.resident_cto_run_id)}'; nested CTO preparation is not admitted`);
  if (!Number.isSafeInteger(input.capacity) || input.capacity < 0) findings.push("capacity must be a non-negative safe integer");
  if (!Number.isSafeInteger(input.depth) || input.depth < 0) findings.push("depth must be a non-negative safe integer");
  if (!Number.isSafeInteger(input.max_depth) || input.max_depth < 0) findings.push("max_depth must be a non-negative safe integer");
  if (!Array.isArray(input.requests)) return { ok: false, findings: ["requests must be a non-empty array"] };
  if (input.requests.length === 0) return { ok: false, findings: ["requests must be a non-empty array"] };
  if (input.capacity === 0) findings.push("capacity must be at least 1 when requests are present");
  if (input.requests.length > MAX_REQUESTS) return { ok: false, findings: [`requests may contain at most ${MAX_REQUESTS} entries`] };
  const requests: CtoSpecificationPreparationRequestInput[] = []; const seenRequestIds = new Set<string>(); const seenFeatures = new Set<string>();
  input.requests.forEach((candidate, index) => {
    const label = `requests[${index}]`;
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) { findings.push(`${label} must be an object`); return; }
    const requestIdError = safeId(candidate.request_id, `${label}.request_id`); if (requestIdError) findings.push(requestIdError); else if (seenRequestIds.has(candidate.request_id)) findings.push(`duplicate request_id '${candidate.request_id}'`); else seenRequestIds.add(candidate.request_id);
    if (!isSafeFeatureId(candidate.feature_id)) findings.push(`${label}.feature_id must be a canonical safe feature id`); else if (seenFeatures.has(candidate.feature_id)) findings.push(`duplicate feature_id '${candidate.feature_id}'; facets must be grouped in one request`); else seenFeatures.add(candidate.feature_id);
    const requestError = nonBlank(candidate.request, `${label}.request`); if (requestError) findings.push(requestError);
    let facets: string[] | undefined;
    if (candidate.facet_ids !== undefined) {
      if (!Array.isArray(candidate.facet_ids) || candidate.facet_ids.length === 0 || candidate.facet_ids.length > MAX_FACETS) findings.push(`${label}.facet_ids must contain 1..${MAX_FACETS} entries when present`);
      else { const seen = new Set<string>(); facets = []; for (const facet of candidate.facet_ids) { const error = safeId(facet, `${label}.facet_ids[]`); if (error) findings.push(error); else if (seen.has(facet)) findings.push(`duplicate facet_id '${facet}' in ${label}`); else { seen.add(facet); facets.push(facet); } } }
    }
    if (candidate.owner_id !== undefined) { const ownerError = safeId(candidate.owner_id, `${label}.owner_id`); if (ownerError) findings.push(ownerError); }
    if (requestIdError || !isSafeFeatureId(candidate.feature_id) || requestError) return;
    requests.push({ request_id: candidate.request_id, feature_id: candidate.feature_id, request: candidate.request, ...(facets ? { facet_ids: facets } : {}), ...(candidate.owner_id !== undefined ? { owner_id: candidate.owner_id } : {}) });
  });
  const expandedQueueItems = requests.reduce((total, request) => total + (request.facet_ids?.length ?? 1), 0);
  if (expandedQueueItems > MAX_PREPARATION_QUEUE_ITEMS) {
    findings.push(`expanded preparation queue may contain at most ${MAX_PREPARATION_QUEUE_ITEMS} entries`);
  }
  const identity = { cto_run_id: input.cto_run_id, task: input.task, branch: input.branch, resident_cto_run_id: input.resident_cto_run_id, capacity: input.capacity, depth: input.depth, max_depth: input.max_depth, requests };
  const waveId = input.wave_id ?? `wave-${sha256Hex(JSON.stringify(identity)).slice(0, 32)}`;
  const sourceId = input.source_id ?? `cto-specification-preparation-${sha256Hex(JSON.stringify(identity)).slice(0, 32)}`;
  for (const [value, field] of [[waveId, "wave_id"], [sourceId, "source_id"]] as const) { const error = safeId(value, field); if (error) findings.push(error); }
  if (findings.length > 0) return { ok: false, findings };
  return { ok: true, value: { ctoRunId: input.cto_run_id, task: input.task, branch: input.branch, residentRunId: input.resident_cto_run_id, requests, capacity: input.capacity, depth: input.depth, maxDepth: input.max_depth, waveId, sourceId, digest: digestOf({ ...identity, wave_id: waveId, source_id: sourceId }) } };
}
function schedulerRequests(input: NormalizedInput, features: readonly PersistedFeature[], profileName: string, profileHashValue: string): CtoSpecificationPreparationRequest[] { const byFeature = new Map(features.map((feature) => [feature.feature_id, feature])); return input.requests.flatMap((request) => (request.facet_ids ?? ["primary"]).map((facetId) => ({ request_id: deriveSafeCtoId(["prepq", sha256Hex(`${request.request_id}\u0000${facetId}\u0000${PHASE}`)]), feature_id: request.feature_id, run_key: byFeature.get(request.feature_id)?.run_key ?? queuedRunKey(request), phase: PHASE, facet_id: facetId, profile_name: profileName, profile_hash: profileHashValue, ...(request.owner_id !== undefined ? { owner_id: request.owner_id } : {}) }))); }
function scheduleFor(input: NormalizedInput, features: readonly PersistedFeature[], profileName: string, profileHashValue: string) { return scheduleCtoSpecificationPreparation({ cto_run_id: input.ctoRunId, resident_cto_run_id: input.residentRunId, depth: input.depth, max_depth: input.maxDepth, capacity: input.capacity, requests: schedulerRequests(input, features, profileName, profileHashValue) }); }
function draftFeaturesFor(input: NormalizedInput, profileHashValue: string): PersistedFeature[] {
  return input.requests.map((candidate) => ({
    request_id: candidate.request_id,
    feature_id: candidate.feature_id,
    run_key: `spec-${sha256Hex(`${candidate.request_id}\u0000${candidate.feature_id}`).slice(0, 32)}`,
    workspace_path: `specs/${candidate.feature_id}`,
    state_path: `.work-state/features/${candidate.feature_id}/state.json`,
    profile_name: WORKFLOW,
    profile_hash: profileHashValue,
    phase_writer_id: writerId(candidate.feature_id),
    facets: [...(candidate.facet_ids ?? ["primary"])],
    request: candidate.request,
    ...(candidate.owner_id !== undefined ? { owner_id: candidate.owner_id } : {}),
  }));
}
function visible(feature: PersistedFeature): CtoSpecificationPreparationFeature { return { request_id: feature.request_id, feature_id: feature.feature_id, run_key: feature.run_key, workspace_path: feature.workspace_path, state_path: feature.state_path, profile_name: feature.profile_name, profile_hash: feature.profile_hash, phase_writer_id: feature.phase_writer_id, facets: [...feature.facets] }; }
function ready(input: NormalizedInput, features: readonly PersistedFeature[], schedule: ReturnType<typeof scheduleCtoSpecificationPreparation>, constitution: ConstitutionGateRecord): CtoSpecificationPreparationReady { return { status: "ready", prepared: true, dispatched: false, cto_run_id: input.ctoRunId, wave_id: input.waveId, source_id: input.sourceId, features: features.map(visible), scheduled: schedule.scheduled, queued: schedule.queued, constitution: constitutionProjection(constitution), review_packet_ref: null }; }
function persistedCopy(feature: PersistedFeature): PersistedFeature { return { ...feature, facets: [...feature.facets] }; }

function validPreparedFeature(feature: PersistedFeature): boolean {
  return isSafeFeatureId(feature.feature_id)
    && isSafeStateSegment(feature.request_id)
    && isSafeStateSegment(feature.run_key)
    && feature.request.trim().length > 0
    && feature.workspace_path === `specs/${feature.feature_id}`
    && feature.state_path === `.work-state/features/${feature.feature_id}/state.json`
    && feature.phase_writer_id === writerId(feature.feature_id)
    && feature.facets.length > 0
    && feature.facets.every((facet) => isSafeStateSegment(facet));
}

const BOOTSTRAP_JOURNAL_FILE = "specification-preparation.transaction.json";
type BootstrapJournalStatus = "prepared" | "committing" | "committed";

/** JSON-safe projection of a pinned-root write receipt.  Bootstrap creates
 * only absent paths, so the preimage is intentionally represented explicitly
 * and never inferred from a later pathname read during recovery. */
interface BootstrapFileReceipt {
  path: string;
  relative_path: string;
  descriptor: PinnedRootWriteDescriptor;
  preimage: { kind: "absent" };
}
interface BootstrapDirectoryIdentity {
  path: string;
  relative_path: string;
  dev: number;
  ino: number;
}
interface BootstrapJournalRead {
  journal: BootstrapJournal;
  descriptor: PinnedRootWriteDescriptor;
  content: string;
}
interface BootstrapJournal {
  schema_version: 1;
  kind: "bootstrap";
  id: string;
  status: BootstrapJournalStatus;
  request_digest: string;
  root_identity: { canonical_path: string; dev: number; ino: number };
  cto_run_id: string;
  task: string;
  branch: string;
  wave_id: string;
  source_id: string;
  features: PersistedFeature[];
  workspace_digests: Record<string, string>;
  /** Exact descriptors for files created by the bootstrap transaction. */
  file_receipts: Record<string, BootstrapFileReceipt>;
  /** Exact identities for directories created by the bootstrap transaction. */
  directory_identities: Record<string, BootstrapDirectoryIdentity>;
  dod_digests?: Record<string, string>;
  state_digest?: string;
  updated_at: string;
}

function bootstrapJournalPath(runId: string): string {
  return `.work-state/cto/${runId}/${BOOTSTRAP_JOURNAL_FILE}`;
}

function preparationRootIdentity(pinnedRoot: PinnedProjectRoot): { canonical_path: string; dev: number; ino: number } {
  return { canonical_path: pinnedRoot.canonical_root, dev: pinnedRoot.dev, ino: pinnedRoot.ino };
}

function bootstrapFileReceipt(
  pinnedRoot: PinnedProjectRoot,
  relativePath: string,
): BootstrapFileReceipt | null {
  let observed;
  try {
    observed = pinnedRoot.readFile(relativePath, { maxBytes: 8 * 1024 * 1024 });
  } catch (error) {
    if (error instanceof PinnedRootError && error.code === "not_found") return null;
    throw error;
  }
  const size = observed.size ?? observed.bytes.byteLength;
  const descriptor: PinnedRootWriteDescriptor = {
    path: observed.path,
    relative_path: relativePath,
    dev: observed.dev,
    ino: observed.ino,
    size,
    sha256: sha256Hex(decodeUtf8(observed.bytes)),
  };
  return { path: observed.path, relative_path: relativePath, descriptor, preimage: { kind: "absent" } };
}

function bootstrapDirectoryIdentity(
  pinnedRoot: PinnedProjectRoot,
  relativePath: string,
): BootstrapDirectoryIdentity | null {
  const info = pinnedRoot.pathEntryInfo(relativePath);
  if (!info) return null;
  if (info.kind !== "directory") throw new Error(`bootstrap path '${relativePath}' is not a directory`);
  return {
    path: join(pinnedRoot.canonical_root, ...relativePath.split("/")),
    relative_path: relativePath,
    dev: info.dev,
    ino: info.ino,
  };
}

function bootstrapReceiptRuntime(
  pinnedRoot: PinnedProjectRoot,
  receipt: BootstrapFileReceipt,
): PinnedRootWriteReceipt {
  const preimage: PinnedRootWritePreimage = { kind: "absent" };
  const runtime: PinnedRootWriteReceipt = {
    path: receipt.path,
    relative_path: receipt.relative_path,
    descriptor: receipt.descriptor,
    preimage,
    rollback: () => rollbackPinnedRootWriteReceipt(pinnedRoot, runtime),
  };
  return runtime;
}

function recordBootstrapFileReceipt(
  journal: BootstrapJournal,
  pinnedRoot: PinnedProjectRoot,
  relativePath: string,
): BootstrapFileReceipt {
  const receipt = bootstrapFileReceipt(pinnedRoot, relativePath);
  if (!receipt) throw new Error(`bootstrap-created file '${relativePath}' disappeared before its ownership could be journaled`);
  journal.file_receipts[relativePath] = receipt;
  return receipt;
}

function recordBootstrapDirectoryIdentity(
  journal: BootstrapJournal,
  pinnedRoot: PinnedProjectRoot,
  relativePath: string,
): BootstrapDirectoryIdentity {
  const identity = bootstrapDirectoryIdentity(pinnedRoot, relativePath);
  if (!identity) throw new Error(`bootstrap-created directory '${relativePath}' disappeared before its ownership could be journaled`);
  journal.directory_identities[relativePath] = identity;
  return identity;
}

function bootstrapJournalFor(
  request: NormalizedInput,
  pinnedRoot: PinnedProjectRoot,
  features: readonly PersistedFeature[],
): BootstrapJournal {
  return {
    schema_version: 1,
    kind: "bootstrap",
    id: `cto-bootstrap-${request.digest.slice(0, 32)}`,
    status: "prepared",
    request_digest: request.digest,
    root_identity: preparationRootIdentity(pinnedRoot),
    cto_run_id: request.ctoRunId,
    task: request.task,
    branch: request.branch,
    wave_id: request.waveId,
    source_id: request.sourceId,
    features: features.map(persistedCopy),
    workspace_digests: {},
    file_receipts: {},
    directory_identities: {},
    updated_at: new Date().toISOString(),
  };
}

class BootstrapJournalOversizeError extends Error {
  readonly code = "CTO_SPEC_PREPARATION_JOURNAL_TOO_LARGE";

  constructor(bytes: number) {
    super(`${"CTO_SPEC_PREPARATION_JOURNAL_TOO_LARGE"}: bootstrap preparation journal exceeds ${MAX_BOOTSTRAP_JOURNAL_BYTES} bytes (${bytes} UTF-8 bytes)`);
    this.name = "BootstrapJournalOversizeError";
  }
}

function serializeBootstrapJournal(journal: BootstrapJournal): string {
  const serializedValue = JSON.stringify(journal, null, 2);
  if (typeof serializedValue !== "string") {
    throw new Error("CTO_SPEC_PREPARATION_JOURNAL_INVALID: bootstrap preparation journal is not JSON-serializable");
  }
  const serialized = `${serializedValue}\n`;
  const bytes = Buffer.byteLength(serialized, "utf8");
  if (bytes > MAX_BOOTSTRAP_JOURNAL_BYTES) throw new BootstrapJournalOversizeError(bytes);
  return serialized;
}

interface BootstrapJournalWriteOptions {
  beforeWrite?: () => void;
}

function persistBootstrapJournal(
  journal: BootstrapJournal,
  pinnedRoot: PinnedProjectRoot,
  serialized = serializeBootstrapJournal(journal),
  options: BootstrapJournalWriteOptions = {},
): void {
  pinnedRoot.ensureDirectory(`.work-state/cto/${journal.cto_run_id}`);
  injectPreparationFailure("before_preparation_journal");
  options.beforeWrite?.();
  pinnedRoot.writeAtomic(bootstrapJournalPath(journal.cto_run_id), serialized);
  injectPreparationFailure("after_preparation_journal");
}

function bootstrapStateTransaction(journal: BootstrapJournal, dodPaths: readonly string[] = []): CtoSpecificationPreparationTransaction {
  const statePath = `.work-state/cto/${journal.cto_run_id}/state.json`;
  return {
    kind: "bootstrap",
    schema_version: 1,
    id: journal.id,
    status: "committed",
    request_digest: journal.request_digest,
    root_identity: { ...journal.root_identity },
    expected_state_revision: 0,
    feature_state: { path: statePath, before: { path: statePath, exists: false, sha256: "" } },
    dod_files: dodPaths.map((path) => ({ path: path + "/dod.json", before: { path: path + "/dod.json", exists: false, sha256: "" } })),
    updated_at: new Date().toISOString(),
  };
}

const BOOTSTRAP_JOURNAL_REQUIRED_KEYS = new Set([
  "schema_version", "kind", "id", "status", "request_digest", "root_identity", "cto_run_id",
  "task", "branch", "wave_id", "source_id", "features", "workspace_digests", "file_receipts",
  "directory_identities", "updated_at",
]);
const BOOTSTRAP_JOURNAL_OPTIONAL_KEYS = new Set(["state_digest", "dod_digests"]);
const BOOTSTRAP_RECEIPT_KEYS = new Set(["path", "relative_path", "descriptor", "preimage"]);
const BOOTSTRAP_DESCRIPTOR_KEYS = new Set(["path", "relative_path", "dev", "ino", "size", "sha256"]);
const BOOTSTRAP_PREIMAGE_KEYS = new Set(["kind"]);
const BOOTSTRAP_DIRECTORY_KEYS = new Set(["path", "relative_path", "dev", "ino"]);
const BOOTSTRAP_FEATURE_REQUIRED_KEYS = new Set([
  "request_id", "feature_id", "run_key", "workspace_path", "state_path", "profile_name",
  "profile_hash", "phase_writer_id", "facets", "request",
]);
const BOOTSTRAP_FEATURE_OPTIONAL_KEYS = new Set(["owner_id"]);
const BOOTSTRAP_ROOT_IDENTITY_KEYS = new Set(["canonical_path", "dev", "ino"]);
type BootstrapJsonBudget = { nodes: number };

function boundedBootstrapJson(value: unknown, depth: number, budget: BootstrapJsonBudget): boolean {
  if (++budget.nodes > MAX_BOOTSTRAP_JOURNAL_JSON_NODES || depth > MAX_BOOTSTRAP_JOURNAL_JSON_DEPTH) return false;
  if (value === null || typeof value === "boolean" || typeof value === "number") {
    return typeof value !== "number" || Number.isFinite(value);
  }
  if (typeof value === "string") return Buffer.byteLength(value, "utf8") <= MAX_TEXT;
  if (Array.isArray(value)) {
    if (value.length > MAX_BOOTSTRAP_JOURNAL_JSON_ARRAY) return false;
    return value.every((item) => boundedBootstrapJson(item, depth + 1, budget));
  }
  if (!value || typeof value !== "object"
    || (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)) return false;
  const object = value as Record<string, unknown>;
  const keys = Object.keys(object);
  if (keys.length > MAX_BOOTSTRAP_JOURNAL_JSON_KEYS) return false;
  return keys.every((key) => Buffer.byteLength(key, "utf8") <= MAX_TEXT)
    && keys.every((key) => boundedBootstrapJson(object[key], depth + 1, budget));
}

function exactBootstrapKeys(
  value: unknown,
  required: ReadonlySet<string>,
  optional: ReadonlySet<string>,
): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)) return false;
  const object = value as Record<string, unknown>;
  const keys = Object.keys(object);
  return keys.every((key) => required.has(key) || optional.has(key))
    && [...required].every((key) => Object.hasOwn(object, key));
}

function bootstrapFeatureError(value: unknown): string | null {
  if (!exactBootstrapKeys(value, BOOTSTRAP_FEATURE_REQUIRED_KEYS, BOOTSTRAP_FEATURE_OPTIONAL_KEYS)) return "bootstrap journal feature schema is invalid";
  const feature = value as Partial<PersistedFeature>;
  if (typeof feature.feature_id !== "string"
    || !isSafeFeatureId(feature.feature_id)
    || typeof feature.request_id !== "string"
    || !isSafeStateSegment(feature.request_id)
    || typeof feature.run_key !== "string"
    || !isSafeStateSegment(feature.run_key)
    || typeof feature.request !== "string"
    || feature.request.trim().length === 0
    || Buffer.byteLength(feature.request, "utf8") > MAX_TEXT
    || feature.workspace_path !== `specs/${feature.feature_id}`
    || feature.state_path !== `.work-state/features/${feature.feature_id}/state.json`
    || typeof feature.profile_name !== "string"
    || !isSafeStateSegment(feature.profile_name)
    || !isSha256Hex(feature.profile_hash ?? "")
    || feature.phase_writer_id !== writerId(feature.feature_id)
    || !Array.isArray(feature.facets)
    || feature.facets.length === 0
    || feature.facets.length > MAX_FACETS
    || feature.facets.some((facet) => !isSafeStateSegment(facet))
    || (feature.owner_id !== undefined && (typeof feature.owner_id !== "string" || !isSafeStateSegment(feature.owner_id)))) {
    return "bootstrap journal feature fields are invalid";
  }
  return null;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

function bootstrapOwnedPathSets(features: readonly PersistedFeature[]): {
  files: Set<string>;
  directories: Set<string>;
} {
  const files = new Set<string>();
  const directories = new Set<string>();
  for (const feature of features) {
    files.add(feature.state_path);
    files.add(`.work-state/features/${feature.feature_id}/team-state.md`);
    files.add(preparationDodPath(preparationTeamId(feature.request_id)) + "/dod.json");
    directories.add(`specs/${feature.feature_id}`);
    directories.add(`.work-state/features/${feature.feature_id}`);
    directories.add(`.work-state/features/${feature.feature_id}/artifacts`);
    directories.add(preparationDodPath(preparationTeamId(feature.request_id)));
  }
  // The journal directory itself is intentionally not owned by the feature
  // cleanup proof.
  return { files, directories };
}

function bootstrapFileReceiptError(
  value: unknown,
  pinnedRoot: PinnedProjectRoot,
  relativePath: string,
): string | null {
  if (!exactBootstrapKeys(value, BOOTSTRAP_RECEIPT_KEYS, new Set())
    || typeof (value as Record<string, unknown>).path !== "string"
    || (value as Record<string, unknown>).relative_path !== relativePath
    || !isPlainObject((value as Record<string, unknown>).descriptor)
    || !isPlainObject((value as Record<string, unknown>).preimage)) return "bootstrap journal file receipt is malformed";
  const receipt = value as Record<string, unknown>;
  const expectedPath = join(pinnedRoot.canonical_root, ...relativePath.split("/"));
  if (receipt.path !== expectedPath) return "bootstrap journal file receipt path is not canonical";
  const descriptor = receipt.descriptor as Record<string, unknown>;
  if (!exactBootstrapKeys(descriptor, BOOTSTRAP_DESCRIPTOR_KEYS, new Set())
    || descriptor.path !== expectedPath
    || descriptor.relative_path !== relativePath
    || !Number.isSafeInteger(descriptor.dev) || (descriptor.dev as number) < 0
    || !Number.isSafeInteger(descriptor.ino) || (descriptor.ino as number) < 0
    || !Number.isSafeInteger(descriptor.size) || (descriptor.size as number) < 0
    || typeof descriptor.sha256 !== "string" || !isSha256Hex(descriptor.sha256)) return "bootstrap journal file receipt descriptor is invalid";
  const preimage = receipt.preimage as Record<string, unknown>;
  if (!exactBootstrapKeys(preimage, BOOTSTRAP_PREIMAGE_KEYS, new Set()) || preimage.kind !== "absent") return "bootstrap journal file receipt preimage is invalid";
  return null;
}

function bootstrapDirectoryIdentityError(
  value: unknown,
  pinnedRoot: PinnedProjectRoot,
  relativePath: string,
): string | null {
  if (!exactBootstrapKeys(value, BOOTSTRAP_DIRECTORY_KEYS, new Set())) return "bootstrap journal directory identity is malformed";
  const identity = value as Record<string, unknown>;
  const expectedPath = join(pinnedRoot.canonical_root, ...relativePath.split("/"));
  if (identity.path !== expectedPath || identity.relative_path !== relativePath
    || !Number.isSafeInteger(identity.dev) || (identity.dev as number) < 0
    || !Number.isSafeInteger(identity.ino) || (identity.ino as number) < 0) return "bootstrap journal directory identity is invalid";
  return null;
}

function bootstrapJournalSchemaError(
  parsed: unknown,
  pinnedRoot: PinnedProjectRoot,
  runId: string,
): string | null {
  if (!boundedBootstrapJson(parsed, 0, { nodes: 0 })) return "bootstrap preparation journal exceeds JSON work/depth/text bounds";
  if (!exactBootstrapKeys(parsed, BOOTSTRAP_JOURNAL_REQUIRED_KEYS, BOOTSTRAP_JOURNAL_OPTIONAL_KEYS)) return "bootstrap preparation journal has unknown or missing fields";
  const value = parsed as Partial<BootstrapJournal>;
  if (value.schema_version !== 1
    || value.kind !== "bootstrap"
    || !isSafeCtoRunId(value.cto_run_id)
    || value.cto_run_id !== runId
    || typeof value.id !== "string"
    || !isSafeStateSegment(value.id)
    || value.id !== `cto-bootstrap-${value.request_digest?.slice(0, 32)}`
    || !isSha256Hex(value.request_digest ?? "")
    || !isSafeStateSegment(value.wave_id ?? "")
    || !isSafeStateSegment(value.source_id ?? "")
    || (value.status !== "prepared" && value.status !== "committing" && value.status !== "committed")
    || !exactBootstrapKeys(value.root_identity, BOOTSTRAP_ROOT_IDENTITY_KEYS, new Set())
    || value.root_identity.canonical_path !== pinnedRoot.canonical_root
    || !Number.isSafeInteger(value.root_identity.dev)
    || !Number.isSafeInteger(value.root_identity.ino)
    || value.root_identity.dev !== pinnedRoot.dev
    || value.root_identity.ino !== pinnedRoot.ino
    || typeof value.task !== "string"
    || value.task.trim().length === 0
    || Buffer.byteLength(value.task, "utf8") > MAX_TEXT
    || typeof value.branch !== "string"
    || value.branch.trim().length === 0
    || Buffer.byteLength(value.branch, "utf8") > MAX_TEXT
    || !Array.isArray(value.features)
    || value.features.length === 0
    || value.features.length > MAX_REQUESTS
    || !value.workspace_digests || typeof value.workspace_digests !== "object" || Array.isArray(value.workspace_digests)
    || typeof value.updated_at !== "string"
    || value.updated_at.trim().length === 0
    || Buffer.byteLength(value.updated_at, "utf8") > MAX_TEXT) {
    return "bootstrap preparation journal identity or schema is invalid";
  }
  const features = value.features as PersistedFeature[];
  const featureErrors = features.map(bootstrapFeatureError).find((error) => error !== null);
  if (featureErrors) return featureErrors;
  const featureIds = new Set(features.map((feature) => feature.feature_id));
  const requestIds = new Set(features.map((feature) => feature.request_id));
  if (featureIds.size !== features.length || requestIds.size !== features.length) return "bootstrap journal feature identities are duplicated";
  if (!isPlainObject(value.file_receipts) || !isPlainObject(value.directory_identities)) return "bootstrap journal ownership proofs are malformed";
  const ownedPaths = bootstrapOwnedPathSets(features);
  const fileReceipts = value.file_receipts as Record<string, unknown>;
  const fileReceiptKeys = Object.keys(fileReceipts);
  if (fileReceiptKeys.length > ownedPaths.files.size || fileReceiptKeys.some((path) => !ownedPaths.files.has(path))) return "bootstrap journal file receipts do not match its feature set";
  for (const path of fileReceiptKeys) {
    const error = bootstrapFileReceiptError(fileReceipts[path], pinnedRoot, path);
    if (error) return error;
  }
  const directoryIdentities = value.directory_identities as Record<string, unknown>;
  const directoryKeys = Object.keys(directoryIdentities);
  if (directoryKeys.length > ownedPaths.directories.size || directoryKeys.some((path) => !ownedPaths.directories.has(path))) return "bootstrap journal directory identities do not match its feature set";
  for (const path of directoryKeys) {
    const error = bootstrapDirectoryIdentityError(directoryIdentities[path], pinnedRoot, path);
    if (error) return error;
  }
  const workspaceDigests = value.workspace_digests as Record<string, unknown>;
  const digestKeys = Object.keys(workspaceDigests);
  if ((value.status === "committed" && digestKeys.length !== features.length) || digestKeys.length > features.length
    || digestKeys.some((featureId) => !featureIds.has(featureId)
      || !isSha256Hex(workspaceDigests[featureId]))) {
    return "bootstrap journal workspace digests do not match its feature set";
  }
  if (value.dod_digests !== undefined) {
    if (!value.dod_digests || typeof value.dod_digests !== "object" || Array.isArray(value.dod_digests)) return "bootstrap journal DoD digests are malformed";
    const dodDigests = value.dod_digests as Record<string, unknown>;
    const dodKeys = Object.keys(dodDigests);
    const expectedDodKeys = new Set(features.map((feature) => preparationWriterDescriptor(value.cto_run_id!, feature).dodPath + "/dod.json"));
    if (dodKeys.length > features.length || dodKeys.some((path) => !expectedDodKeys.has(path) || !isSha256Hex(dodDigests[path]))) return "bootstrap journal DoD digests do not match its feature set";
  }
  if (value.status === "committed" && !isSha256Hex(value.state_digest ?? "")) return "bootstrap journal committed state digest is invalid";
  if (value.state_digest !== undefined && !isSha256Hex(value.state_digest)) return "bootstrap preparation journal contains an invalid state digest";
  return null;
}
function clearBootstrapJournal(
  pinnedRoot: PinnedProjectRoot,
  descriptor: PinnedRootWriteDescriptor,
): void {
  // The caller owns the one descriptor-anchored read.  Do not reread the
  // pathname here: a replacement journal must remain available for recovery.
  injectPreparationFailure("before_preparation_journal_clear");
  pinnedRoot.removeFileIfMatches(descriptor.relative_path, {
    dev: descriptor.dev,
    ino: descriptor.ino,
    size: descriptor.size,
    sha256: descriptor.sha256,
  });
  injectPreparationFailure("after_preparation_journal_clear");
}

function readBootstrapJournal(
  pinnedRoot: PinnedProjectRoot,
  runId: string,
): BootstrapJournalRead | { error: string } | null {
  const path = bootstrapJournalPath(runId);
  if (!pinnedRoot.pathEntryExists(path)) return null;
  let parsed: unknown;
  let content: string;
  let descriptor: PinnedRootWriteDescriptor;
  try {
    const observed = pinnedRoot.readFile(path, { maxBytes: MAX_BOOTSTRAP_JOURNAL_BYTES });
    content = decodeUtf8(observed.bytes);
    descriptor = {
      path: observed.path,
      relative_path: path,
      dev: observed.dev,
      ino: observed.ino,
      size: observed.size ?? observed.bytes.byteLength,
      sha256: sha256Hex(content),
    };
    parsed = JSON.parse(content);
  } catch (error) {
    return { error: `bootstrap preparation journal is unreadable: ${String(error)}` };
  }
  const schemaError = bootstrapJournalSchemaError(parsed, pinnedRoot, runId);
  if (schemaError) return { error: schemaError };
  const value = parsed as BootstrapJournal;
  return {
    journal: {
      schema_version: 1,
      kind: "bootstrap",
      id: value.id,
      status: value.status,
      request_digest: value.request_digest,
      root_identity: { ...value.root_identity },
      cto_run_id: value.cto_run_id,
      task: value.task,
      branch: value.branch,
      wave_id: value.wave_id,
      source_id: value.source_id,
      features: value.features.map(persistedCopy),
      workspace_digests: { ...value.workspace_digests },
      file_receipts: Object.fromEntries(Object.entries(value.file_receipts as Record<string, BootstrapFileReceipt>).map(([entryPath, receipt]) => [entryPath, {
        path: receipt.path,
        relative_path: receipt.relative_path,
        descriptor: { ...receipt.descriptor },
        preimage: { kind: "absent" as const },
      }])),
      directory_identities: Object.fromEntries(Object.entries(value.directory_identities as Record<string, BootstrapDirectoryIdentity>).map(([entryPath, identity]) => [entryPath, { ...identity }])),
      ...(value.dod_digests !== undefined ? { dod_digests: { ...value.dod_digests } } : {}),
      ...(value.state_digest ? { state_digest: value.state_digest } : {}),
      updated_at: value.updated_at,
    },
    descriptor,
    content,
  };
}

function exactFeatureImage(feature: PersistedFeature, expected: PersistedFeature): boolean {
  return JSON.stringify(feature) === JSON.stringify(expected);
}

function verifyBootstrapWorkspaces(
  root: string,
  pinnedRoot: PinnedProjectRoot,
  features: readonly PersistedFeature[],
  workspaceDigests: Readonly<Record<string, string>>,
): boolean {
  return features.every((feature) => {
    const resolved = resolveFeatureWorkspace(root, { feature_id: feature.feature_id, run_key: feature.run_key }, borrowedRoot(pinnedRoot));
    if (!resolved.ok || !exactFeatureImage({
      ...feature,
      workspace_path: resolved.value.workspace_path,
      state_path: resolved.value.state_path,
      profile_name: resolved.value.profile_name,
      profile_hash: resolved.value.profile_hash,
    }, feature)) return false;
    const expectedDigest = workspaceDigests[feature.feature_id];
    return expectedDigest === undefined || digestOf(resolved.value) === expectedDigest;
  });
}

function bootstrapStateMatchesJournal(
  root: string,
  pinnedRoot: PinnedProjectRoot,
  state: PreparationState,
  journal: BootstrapJournal,
): boolean {
  const wave = activeWave(state);
  const transaction = state.specification_preparation_transaction;
  if (state.id !== journal.cto_run_id || state.task !== journal.task || state.branch !== journal.branch
    || state.preparation_digest !== journal.request_digest
    || !wave || wave.source !== WAVE_SOURCE || wave.id !== journal.wave_id || wave.source_id !== journal.source_id
    || JSON.stringify(state.preparation_features) !== JSON.stringify(journal.features)
    || !transaction || transaction.kind !== "bootstrap" || transaction.status !== "committed"
    || transaction.id !== journal.id || transaction.request_digest !== journal.request_digest
    || transaction.root_identity.canonical_path !== pinnedRoot.canonical_root
    || transaction.root_identity.dev !== pinnedRoot.dev || transaction.root_identity.ino !== pinnedRoot.ino) return false;
  const expectedDodPaths = journal.features.map((feature) => preparationWriterDescriptor(journal.cto_run_id, feature).dodPath + "/dod.json");
  if (!Array.isArray(transaction.dod_files) || JSON.stringify(transaction.dod_files.map((file) => file.path)) !== JSON.stringify(expectedDodPaths)) return false;
  const statePath = join(".work-state", "cto", journal.cto_run_id, "state.json");
  if (journal.state_digest) {
    try {
      const bytes = pinnedRoot.readFile(statePath, { maxBytes: 8 * 1024 * 1024 }).bytes;
      if (sha256Hex(decodeUtf8(bytes)) !== journal.state_digest) return false;
    } catch {
      return false;
    }
  }
  if (!verifyBootstrapWorkspaces(root, pinnedRoot, journal.features, journal.workspace_digests)) return false;
  return journal.features.every((feature) => {
    const descriptor = preparationWriterDescriptor(journal.cto_run_id, feature);
    const team = state.teams.find((candidate) => candidate.id === descriptor.teamId);
    return team !== undefined && preparedWriterDoDMatches(root, pinnedRoot, journal.cto_run_id, feature, team);
  });
}

const BOOTSTRAP_RECOVERY_FILE = "specification-preparation.transaction.recovery.json";

function bootstrapRecoveryPath(runId: string): string {
  return `.work-state/cto/${runId}/${BOOTSTRAP_RECOVERY_FILE}`;
}

function quarantineBootstrapJournal(
  pinnedRoot: PinnedProjectRoot,
  loaded: BootstrapJournalRead,
  runId: string,
  reason: string,
): { ok: false; error: string } {
  const recoveryPath = bootstrapRecoveryPath(runId);
  const recoveryRelative = pinnedRoot.relativePath(join(pinnedRoot.canonical_root, ...recoveryPath.split("/")));
  if (!recoveryRelative) return { ok: false, error: `CTO_SPEC_PREPARATION_RECOVERY_REQUIRED: ${reason}; journal archive path is outside the pinned root` };
  try {
    try {
      pinnedRoot.writeExclusiveWithReceipt(recoveryRelative, loaded.content);
    } catch (error) {
      if (!(error instanceof PinnedRootError && error.code === "exists")) throw error;
      const existing = pinnedRoot.readFile(recoveryRelative, { maxBytes: MAX_BOOTSTRAP_JOURNAL_BYTES });
      if (sha256Hex(decodeUtf8(existing.bytes)) !== loaded.descriptor.sha256 || decodeUtf8(existing.bytes) !== loaded.content) {
        throw new Error("journal recovery archive collides with different bytes");
      }
    }
  } catch (error) {
    return { ok: false, error: `CTO_SPEC_PREPARATION_RECOVERY_REQUIRED: ${reason}; journal archive failed: ${String(error)}` };
  }
  try {
    clearBootstrapJournal(pinnedRoot, loaded.descriptor);
  } catch (error) {
    return { ok: false, error: `CTO_SPEC_PREPARATION_RECOVERY_REQUIRED: ${reason}; archived journal at '${recoveryPath}' but original or its replacement was preserved: ${String(error)}` };
  }
  return { ok: false, error: `CTO_SPEC_PREPARATION_RECOVERY_REQUIRED: ${reason}; journal archived at '${recoveryPath}', and all bootstrap files were preserved` };
}

function rollbackBootstrapInMemory(
  pinnedRoot: PinnedProjectRoot,
  receipts: readonly BootstrapFileReceipt[],
  directories: readonly BootstrapDirectoryIdentity[],
): string | null {
  try {
    for (const receipt of [...receipts].reverse()) {
      if (!bootstrapReceiptRuntime(pinnedRoot, receipt).rollback()) throw new Error(`ownership descriptor no longer matches for '${receipt.relative_path}'`);
    }
    for (const identity of [...directories].reverse()) {
      const info = pinnedRoot.pathEntryInfo(identity.relative_path);
      if (!info) continue;
      if (info.kind !== "directory" || info.dev !== identity.dev || info.ino !== identity.ino) throw new Error(`directory ownership changed for '${identity.relative_path}'`);
      if (!pinnedRoot.removeEmptyDirectoryIfMatches(identity.relative_path, { dev: identity.dev, ino: identity.ino })) throw new Error(`directory is not empty or its identity changed for '${identity.relative_path}'`);
    }
    return null;
  } catch (error) {
    return String(error);
  }
}

function recoverBootstrapJournal(
  root: string,
  pinnedRoot: PinnedProjectRoot,
  request: NormalizedInput,
  profileHashValue: string,
): { ok: true } | { ok: false; error: string } {
  const loaded = readBootstrapJournal(pinnedRoot, request.ctoRunId);
  if (!loaded) return { ok: true };
  if ("error" in loaded) return { ok: false, error: `CTO_SPEC_PREPARATION_RECOVERY_REQUIRED: ${loaded.error}; the journal and all feature files were preserved` };
  const journal = loaded.journal;
  const expectedJournalId = `cto-bootstrap-${request.digest.slice(0, 32)}`;
  if (journal.id !== expectedJournalId
    || journal.request_digest !== request.digest || journal.wave_id !== request.waveId || journal.source_id !== request.sourceId
    || journal.task !== request.task || journal.branch !== request.branch) {
    return quarantineBootstrapJournal(pinnedRoot, loaded, request.ctoRunId, "bootstrap preparation journal belongs to a different request identity");
  }
  const requestedFeatures: PersistedFeature[] = request.requests.map((candidate) => ({
    request_id: candidate.request_id,
    feature_id: candidate.feature_id,
    run_key: `spec-${sha256Hex(`${candidate.request_id}\u0000${candidate.feature_id}`).slice(0, 32)}`,
    workspace_path: `specs/${candidate.feature_id}`,
    state_path: `.work-state/features/${candidate.feature_id}/state.json`,
    profile_name: WORKFLOW,
    profile_hash: profileHashValue,
    phase_writer_id: writerId(candidate.feature_id),
    facets: [...(candidate.facet_ids ?? ["primary"])],
    request: candidate.request,
    ...(candidate.owner_id !== undefined ? { owner_id: candidate.owner_id } : {}),
  }));
  const initialSchedule = scheduleFor(request, requestedFeatures, WORKFLOW, profileHashValue);
  const expectedFeatureIds = new Set(initialSchedule.scheduled.map((row) => row.feature_id));
  const expectedFeatures = requestedFeatures.filter((feature) => expectedFeatureIds.has(feature.feature_id));
  if (JSON.stringify(journal.features) !== JSON.stringify(expectedFeatures)) {
    return quarantineBootstrapJournal(pinnedRoot, loaded, request.ctoRunId, "bootstrap preparation journal feature intents are not derived from the exact request");
  }
  const current = readCtoStatePinned(request.ctoRunId, pinnedRoot) as PreparationState | null;
  if (current) {
    if (bootstrapStateMatchesJournal(root, pinnedRoot, current, journal)) {
      try {
        clearBootstrapJournal(pinnedRoot, loaded.descriptor);
        return { ok: true };
      } catch (error) {
        return { ok: false, error: `CTO_SPEC_PREPARATION_RECOVERY_REQUIRED: completed CTO state is durable, but the exact journal descriptor could not be cleared: ${String(error)}` };
      }
    }
    return quarantineBootstrapJournal(pinnedRoot, loaded, request.ctoRunId, "canonical CTO state does not prove forward bootstrap completion");
  }
  return quarantineBootstrapJournal(pinnedRoot, loaded, request.ctoRunId, "bootstrap preparation stopped before canonical CTO state completion");
}

function validPreparationCapability(
  state: PreparationState,
  input: NormalizedInput,
  identity: { run_id: string; capability_id: string; capability_epoch: string },
  profileHashValue: string,
): boolean {
  const capability = state.preparation_capability;
  const issued = capability?.issued_for;
  return capability?.capability_id === identity.capability_id
    && capability.kind === "single"
    && capability.status === "ready"
    && JSON.stringify(capability.expected_roles) === JSON.stringify(["cto"])
    && capability.expected_count === 1
    && issued?.run_key === input.ctoRunId
    && issued.branch === input.branch
    && issued.workflow === WORKFLOW
    && issued.profile_hash === profileHashValue
    && issued.stage_cursor === WAVE_SOURCE
    && issued.cursor_epoch === identity.capability_epoch
    && identity.run_id === input.ctoRunId;
}

function replayFeatures(root: string, pinnedRoot: PinnedProjectRoot, state: PreparationState, input: NormalizedInput, profileName: string, profileHashValue: string): PersistedFeature[] | null {
  if (state.preparation_digest !== input.digest || state.id !== input.ctoRunId || state.task !== input.task || state.branch !== input.branch || !Array.isArray(state.preparation_features)) return null;
  const requests = new Map(input.requests.map((request) => [request.feature_id, request])); const features: PersistedFeature[] = []; const seen = new Set<string>();
  for (const candidate of state.preparation_features) {
    const request = requests.get(candidate.feature_id);
    if (!request || seen.has(candidate.feature_id) || candidate.request_id !== request.request_id || candidate.request !== request.request || candidate.owner_id !== request.owner_id || !isSafeStateSegment(candidate.run_key) || candidate.profile_name !== profileName || candidate.profile_hash !== profileHashValue || candidate.phase_writer_id !== writerId(candidate.feature_id) || candidate.workspace_path !== `specs/${candidate.feature_id}` || candidate.state_path !== `.work-state/features/${candidate.feature_id}/state.json` || JSON.stringify(candidate.facets) !== JSON.stringify(request.facet_ids ?? ["primary"])) return null;
    const resolved = resolveFeatureWorkspace(root, { feature_id: candidate.feature_id, run_key: candidate.run_key }, borrowedRoot(pinnedRoot)); if (!resolved.ok || resolved.value.workspace_path !== candidate.workspace_path || resolved.value.state_path !== candidate.state_path || resolved.value.profile_name !== profileName || resolved.value.profile_hash !== profileHashValue) return null;
    seen.add(candidate.feature_id); features.push(persistedCopy(candidate));
  }
  const schedule = scheduleFor(input, features, profileName, profileHashValue);
  if (schedule.scheduled.length !== features.length || schedule.scheduled.some((row) => !seen.has(row.feature_id) || row.run_key !== features.find((feature) => feature.feature_id === row.feature_id)?.run_key)) return null;
  if (!Array.isArray(state.preparation_queued) || JSON.stringify(state.preparation_queued) !== JSON.stringify(schedule.queued)) return null;
  return features;
}
function replay(root: string, pinnedRoot: PinnedProjectRoot, state: PreparationState, input: NormalizedInput, profileName: string, profileHashValue: string, constitution: ConstitutionGateRecord): CtoSpecificationPreparationReady | null {
  const wave = activeWave(state); if (!wave || wave.source !== WAVE_SOURCE || wave.id !== input.waveId || wave.source_id !== input.sourceId) return null;
  if (!wave.work_identity || state.work_identity === undefined || JSON.stringify(wave.work_identity) !== JSON.stringify(state.work_identity) || !validPreparationCapability(state, input, wave.work_identity, profileHashValue)) return null;
  const features = replayFeatures(root, pinnedRoot, state, input, profileName, profileHashValue); if (!features) return null;
  const schedule = scheduleFor(input, features, profileName, profileHashValue); if (JSON.stringify(wave.slice_ids) !== JSON.stringify(schedule.scheduled.map((row) => row.phase_writer_id))) return null;
  const expectedTeams = features.map((feature) => {
    const descriptor = preparationWriterDescriptor(input.ctoRunId, feature);
    return { feature, id: descriptor.teamId, feature_id: feature.feature_id, run_key: feature.run_key, task_id: feature.request_id, slice_id: feature.phase_writer_id, classification: preparationClassification(), dod_path: descriptor.dodPath, dod_digest: descriptor.dodDigest };
  });
  if (state.teams.length !== expectedTeams.length || expectedTeams.some((expected) => { const team = state.teams.find((candidate) => candidate.id === expected.id); return !team || team.status !== "pending" || team.feature_id !== expected.feature_id || team.run_key !== expected.run_key || team.task_id !== expected.task_id || team.slice_id !== expected.slice_id || JSON.stringify(team.classification) !== JSON.stringify(expected.classification) || team.workflow !== WORKFLOW || team.dod_path !== expected.dod_path || team.dod_digest !== expected.dod_digest || !preparedWriterDoDMatches(root, pinnedRoot, input.ctoRunId, expected.feature, team) || JSON.stringify(team.work_identity) !== JSON.stringify(state.work_identity); })) return null;
  return ready(input, features, schedule, constitution);
}

export function prepareCtoSpecificationPreparation(projectRoot: string, input: CtoSpecificationPreparationInput, options: CtoSpecificationPreparationOptions): CtoSpecificationPreparationResult {
  const normalized = normalizeInput(input); if (!normalized.ok) return blocked(...normalized.findings); const request = normalized.value;
  const profile = loadProfile(WORKFLOW); if (!profile) return blocked(`workflow profile '${WORKFLOW}' is unavailable`); const profileHashValue = profileHash(profile);
  const pinnedRoot = PinnedProjectRoot.open(projectRoot); if (!pinnedRoot) return blocked("project root is missing or cannot be canonicalized"); const root = pinnedRoot.canonical_root;
  if (!options?.runtimeAccess) { pinnedRoot.close(); return blocked("recovery_required: live runtime access is required for authoritative CTO preparation"); }
  const runtimeAccess = options.runtimeAccess;
  const sessionId = options.sessionId;
  if (typeof sessionId !== "string" || sessionId.trim().length === 0 || Buffer.byteLength(sessionId, "utf8") > 512 || /[\u0000\r\n]/u.test(sessionId)) {
    pinnedRoot.close();
    return blocked("recovery_required: an authenticated nonblank runtime session id is required for CTO preparation");
  }
  const assertRuntimeLive = (): void => {
    assertCtoRuntimeAccessFacadeLive(runtimeAccess, root, sessionId);
    runtimeAccess.assertProjectRoot(root);
    runtimeAccess.assertLive();
  };
  try {
    assertRuntimeLive();
  } catch (error) {
    pinnedRoot.close();
    return blocked(`recovery_required: authenticated runtime access is unavailable: ${error instanceof Error ? error.message : String(error)}`);
  }
  const inMemoryReceipts: BootstrapFileReceipt[] = [];
  const inMemoryDirectories: BootstrapDirectoryIdentity[] = [];
  let journalClearStarted = false;
  try {
    const draftFeatures = draftFeaturesFor(request, profileHashValue);
    const initialSchedule = scheduleFor(request, draftFeatures, WORKFLOW, profileHashValue);
    const scheduledIds = new Set(initialSchedule.scheduled.map((row) => row.feature_id));
    const features = draftFeatures.filter((feature) => scheduledIds.has(feature.feature_id));
    const schedule = scheduleFor(request, features, WORKFLOW, profileHashValue);
    const bootstrapJournal = bootstrapJournalFor(request, pinnedRoot, features);
    let initialSerializedJournal: string;
    try {
      initialSerializedJournal = serializeBootstrapJournal(bootstrapJournal);
    } catch (error) {
      if (error instanceof BootstrapJournalOversizeError) return blocked(error.message);
      throw error;
    }
    assertRuntimeLive();
    return withCtoRunLock(root, "__resident_cto__", () => {
      assertRuntimeLive();
      const reconciledCandidates = readCtoRunDeliveryReconciledActiveCandidatesPinned(pinnedRoot);
      const indexAuthority = readCtoRunDeliveryIndexAuthorityPinned(pinnedRoot);
      const hasCanonicalResident = reconciledCandidates.ok && reconciledCandidates.entries.some((entry) => entry.status === "active" || entry.status === "standby");
      if (hasCanonicalResident && !indexAuthority.authenticated) {
        return blocked("resident_cto_authority_recovery_required: canonical resident CTO state exists but its process-scoped owner proof is unavailable; reconnect a live RuntimeAccess owner before preparation");
      }
      const activeResident = indexAuthority.authenticated ? indexAuthority.index.active_run_id : null;
      if (activeResident && activeResident !== request.ctoRunId) return blocked(`active resident CTO run '${activeResident}' owns preparation; nested CTO '${request.ctoRunId}' is not admitted`);
      const gateResult = ensureCtoPreparationPrerequisite(root, { origin_run_key: request.ctoRunId, pinnedRoot });
      if (!gateResult.ok) return blocked(`${gateResult.code}: ${gateResult.error}`);
      const constitution = gateResult.value;
      const constitutionBinding = constitution.binding;
      if (constitution.status !== "usable" || !constitutionBinding) return blocked(`constitution prerequisite is ${constitution.status}; complete the canonical constitution workflow before feature bootstrap (checkpoint ${constitution.checkpoint_ref ?? "none"})`);
      if (!pinnedRoot.isStable()) return blocked("project root changed during constitution prerequisite");
      for (const candidate of draftFeatures) {
        assertRuntimeLive();
        const featureGate = ensureProjectConstitution(root, {
          origin_kind: "cto_preparation",
          origin_run_key: request.ctoRunId,
          origin_stage: "cto",
        }, { feature_id: candidate.feature_id, pinnedRoot });
        if (!featureGate.ok) return blocked(`${featureGate.code}: ${featureGate.error}`);
        if (featureGate.value.status !== "usable" || !featureGate.value.binding) {
          return blocked(`constitution prerequisite is ${featureGate.value.status} for feature '${candidate.feature_id}'; feature preparation is not admitted`);
        }
      }
        let authenticatedState: Readonly<Record<string, unknown>> | null;
        try { authenticatedState = runtimeAccess.readState(request.ctoRunId); }
        catch (error) { return blocked(`recovery_required: authenticated CTO state proof is unavailable: ${error instanceof Error ? error.message : String(error)}`); }
        const untrustedCurrent = readCtoStatePinned(request.ctoRunId, pinnedRoot) as PreparationState | null;
        if (untrustedCurrent && !authenticatedState) return blocked("recovery_required: existing CTO state lacks a valid live origin and full-state proof");
        assertRuntimeLive();
        const recovered = authenticatedState
          ? runtimeAccess.withRunTransaction(request.ctoRunId, () => recoverBootstrapJournal(root, pinnedRoot, request, profileHashValue))
          : recoverBootstrapJournal(root, pinnedRoot, request, profileHashValue);
        if (!recovered.ok) return blocked(recovered.error);
        const current = authenticatedState ? readCtoStatePinned(request.ctoRunId, pinnedRoot) as PreparationState | null : null;
        if (current) return replay(root, pinnedRoot, current, request, WORKFLOW, profileHashValue, constitution) ?? blocked("an existing CTO run has a different preparation identity or is not an active specification-preparation wave; takeover is not permitted");
      for (const candidate of features) {
        const paths = [
          `specs/${candidate.feature_id}`,
          `.work-state/features/${candidate.feature_id}`,
          `.work-state/features/${candidate.feature_id}/artifacts`,
          `.work-state/features/${candidate.feature_id}/state.json`,
          ".work-state/features/" + candidate.feature_id + "/team-state.md",
          preparationDodPath(preparationTeamId(candidate.request_id)),
        ];
        if (paths.some((path) => pinnedRoot.pathEntryExists(path))) return blocked(`feature workspace collision for '${candidate.feature_id}'; replay requires the established CTO preparation identity`);
      }
      const assertPreparationConstitutionCurrent = (): void => {
        assertRuntimeLive();
        if (!pinnedRoot.isStable()) throw new Error("project root changed before CTO preparation journal write");
        const issue = currentConstitutionPersistenceIssue(root, constitutionBinding, constitution.gate_id, pinnedRoot);
        if (issue) throw new Error(`preparation constitution is stale: ${issue}`);
      };
      const assertPreparedConstitutionsCurrent = (): void => {
        assertPreparationConstitutionCurrent();
        for (const feature of features) {
          const expectedWorkspaceDigest = bootstrapJournal.workspace_digests[feature.feature_id];
          if (!expectedWorkspaceDigest) continue;
          const current = resolveFeatureWorkspace(root, { feature_id: feature.feature_id, run_key: feature.run_key }, borrowedRoot(pinnedRoot), { persistMigration: false, requireMigration: true });
          if (!current.ok) throw new Error(current.error);
          if (digestOf(current.value) !== expectedWorkspaceDigest) {
            throw new Error(`prepared workspace '${feature.feature_id}' changed before CTO preparation write`);
          }
          if (!current.value.constitution_binding
            || current.value.constitution_gate_ref !== constitution.gate_id
            || digestOf(current.value.constitution_binding) !== digestOf(constitutionBinding)) {
            throw new Error(`prepared workspace '${feature.feature_id}' constitution binding changed before CTO preparation write`);
          }
        }
        if (!pinnedRoot.isStable()) throw new Error("project root changed after CTO preparation journal precondition");
      };
      assertRuntimeLive();
      persistBootstrapJournal(bootstrapJournal, pinnedRoot, initialSerializedJournal, { beforeWrite: assertPreparationConstitutionCurrent });
      for (const feature of features) {
        assertRuntimeLive();
        injectPreparationFailure("before_workspace_mkdir");
        assertRuntimeLive();
        const created = createFeatureWorkspace(root, {
          feature_id: feature.feature_id,
          display_name: feature.request.trim().slice(0, 160) || feature.feature_id,
          run_key: feature.run_key,
          profile_name: WORKFLOW,
          profile_hash: profileHashValue,
          constitution_gate_ref: constitution.gate_id,
          constitution_binding: constitutionBinding,
        }, borrowedRoot(pinnedRoot));
        if (!created.ok) throw new Error(`${created.code}: ${created.error}`);
        const statePath = feature.state_path;
        const teamStatePath = `.work-state/features/${feature.feature_id}/team-state.md`;
        const featureDirectories = [
          `specs/${feature.feature_id}`,
          `.work-state/features/${feature.feature_id}`,
          `.work-state/features/${feature.feature_id}/artifacts`,
        ];
        inMemoryReceipts.push(recordBootstrapFileReceipt(bootstrapJournal, pinnedRoot, statePath));
        if (pinnedRoot.pathEntryExists(teamStatePath)) inMemoryReceipts.push(recordBootstrapFileReceipt(bootstrapJournal, pinnedRoot, teamStatePath));
        for (const directory of featureDirectories) inMemoryDirectories.push(recordBootstrapDirectoryIdentity(bootstrapJournal, pinnedRoot, directory));
        bootstrapJournal.workspace_digests[feature.feature_id] = digestOf(created.value);
        bootstrapJournal.status = "committing";
        bootstrapJournal.updated_at = new Date().toISOString();
        // Persist ownership before exposing any deterministic post-write
        // failure seam.  If a process dies before this point, recovery has no
        // proof and intentionally leaves the orphan for inspection.
        assertRuntimeLive();
        persistBootstrapJournal(bootstrapJournal, pinnedRoot, serializeBootstrapJournal(bootstrapJournal), { beforeWrite: assertPreparedConstitutionsCurrent });
        assertRuntimeLive();
        injectPreparationFailure("after_workspace_mkdir");
        injectPreparationFailure("after_feature_state_write");
      }
      assertRuntimeLive();
      if (!pinnedRoot.isStable()) throw new Error("project root changed during feature workspace creation");
      const capability = createCapability({ run_key: request.ctoRunId, branch: request.branch, workflow: WORKFLOW, profile_hash: profileHashValue, stage_cursor: WAVE_SOURCE, kind: "single", expected_roster: [{ role: "cto", agent: "cto" }] });
      const epoch = capability.state.issued_for?.cursor_epoch;
      if (!epoch || !isSafeStateSegment(capability.capability_id)) throw new Error("engine-issued preparation capability identity is unavailable");
      const identity = { run_id: request.ctoRunId, wave_id: request.waveId, slice_id: WAVE_SOURCE, session_id: sessionId, workflow: WORKFLOW, stage_id: WAVE_SOURCE, stage_cursor: WAVE_SOURCE, capability_id: capability.capability_id, capability_epoch: epoch, slot_id: "cto", task_id: `task-${request.digest.slice(0, 32)}`, dispatch_id: `dispatch-${request.digest.slice(0, 32)}`, attempt: 1, worker_id: "cto" } as const;
      const state = newCtoState({ id: request.ctoRunId, task: request.task, branch: request.branch, autonomous: true, plan: { id: request.ctoRunId, task: request.task, teams: [], created_at: new Date().toISOString() }, standby: true, owner_session: sessionId }) as PreparationState;
      state.preparation_digest = request.digest;
      state.preparation_features = features.map(persistedCopy);
      state.preparation_queued = schedule.queued.map((row) => ({ ...row }));
      state.preparation_capability = capability.state;
      state.work_identity = identity;
      const writerDescriptors = features.map((feature) => preparationWriterDescriptor(request.ctoRunId, feature));
      state.teams = features.map((feature, index) => {
        const descriptor = writerDescriptors[index]!;
        return { id: descriptor.teamId, status: "pending", escalations: {}, feature_id: feature.feature_id, run_key: feature.run_key, task_id: feature.request_id, team_def_id: "specification", slice_id: feature.phase_writer_id, classification: preparationClassification(), workflow: WORKFLOW, dod_path: descriptor.dodPath, dod_digest: descriptor.dodDigest, work_identity: identity };
      });
      state.specification_preparation_transaction = bootstrapStateTransaction(bootstrapJournal, writerDescriptors.map((descriptor) => descriptor.dodPath));
      const assertAllPreparedConstitutionsCurrent = assertPreparedConstitutionsCurrent;
      bootstrapJournal.dod_digests ??= {};
      for (const descriptor of writerDescriptors) {
        assertRuntimeLive();
        writeCtoDoDExclusive(pinnedRoot, descriptor.dodPath, descriptor.dod, {
          beforeWrite: assertPreparedConstitutionsCurrent,
          onCreated: (ownership) => {
            const descriptor: PinnedRootWriteDescriptor = {
              path: ownership.path,
              relative_path: ownership.relative_path,
              dev: ownership.dev,
              ino: ownership.ino,
              size: ownership.size,
              sha256: ownership.sha256,
            };
            const receipt: BootstrapFileReceipt = {
              path: ownership.path,
              relative_path: ownership.relative_path,
              descriptor,
              preimage: { kind: "absent" },
            };
            bootstrapJournal.file_receipts[ownership.relative_path] = receipt;
            inMemoryReceipts.push(receipt);
            bootstrapJournal.dod_digests![ownership.relative_path] = ownership.sha256;
            inMemoryDirectories.push(recordBootstrapDirectoryIdentity(bootstrapJournal, pinnedRoot, descriptor.relative_path.slice(0, -"/dod.json".length)));
          },
        });
        bootstrapJournal.status = "committing";
        bootstrapJournal.updated_at = new Date().toISOString();
        assertRuntimeLive();
        persistBootstrapJournal(bootstrapJournal, pinnedRoot, serializeBootstrapJournal(bootstrapJournal), { beforeWrite: assertPreparedConstitutionsCurrent });
      }
      assertRuntimeLive();
      injectPreparationFailure("before_wave_append");
      const stateWithWave = appendWave(state, { id: request.waveId, source: WAVE_SOURCE, source_id: request.sourceId, task: request.task, slice_ids: schedule.scheduled.map((row) => row.phase_writer_id), work_identity: identity });
      injectPreparationFailure("after_wave_append");
      assertRuntimeLive();
      injectPreparationFailure("before_state_write");
      assertAllPreparedConstitutionsCurrent();
      assertRuntimeLive();
      const created = runtimeAccess.createRun(stateWithWave, {
        source_id: `cto-specification-preparation:${request.sourceId}`,
        initial_state_sha256: ctoRuntimeRunInitialIdentityDigest(stateWithWave),
      });
      if (created.id !== request.ctoRunId) throw new Error("runtime access created a mismatched CTO preparation run");
      injectPreparationFailure("after_cto_state_write");
      assertRuntimeLive();
      bootstrapJournal.status = "committed";
      bootstrapJournal.state_digest = sha256Hex(decodeUtf8(pinnedRoot.readFile(`.work-state/cto/${request.ctoRunId}/state.json`, { maxBytes: 8 * 1024 * 1024 }).bytes));
      bootstrapJournal.updated_at = new Date().toISOString();
      persistBootstrapJournal(bootstrapJournal, pinnedRoot, serializeBootstrapJournal(bootstrapJournal), { beforeWrite: assertPreparedConstitutionsCurrent });
      const finalJournal = readBootstrapJournal(pinnedRoot, request.ctoRunId);
      if (!finalJournal || "error" in finalJournal) throw new Error("bootstrap preparation journal could not be reread for exact final cleanup");
      journalClearStarted = true;
      assertRuntimeLive();
      clearBootstrapJournal(pinnedRoot, finalJournal.descriptor);
      journalClearStarted = false;
      return ready(request, features, schedule, constitution);
    }, { pinnedRoot });
  } catch (error) {
    const message = `CTO specification preparation failed: ${error instanceof Error ? error.message : String(error)}`;
    const findings = [message];
    try {
      if (journalClearStarted) {
        findings.push("CTO_SPEC_PREPARATION_RECOVERY_REQUIRED: journal cleanup lost its exact descriptor; replacement journal was not adopted");
      } else {
        const loaded = readBootstrapJournal(pinnedRoot, request.ctoRunId);
        const current = readCtoStatePinned(request.ctoRunId, pinnedRoot) as PreparationState | null;
        if (current && loaded && !("error" in loaded) && bootstrapStateMatchesJournal(root, pinnedRoot, current, loaded.journal)) {
          try { clearBootstrapJournal(pinnedRoot, loaded.descriptor); }
          catch (clearError) { findings.push(`CTO_SPEC_PREPARATION_RECOVERY_REQUIRED: completed CTO state is durable, but its journal descriptor could not be cleared: ${String(clearError)}`); }
        } else if (!current) {
          const hasDurableOwnershipClaims = loaded && !("error" in loaded)
            && (Object.keys(loaded.journal.file_receipts).length > 0 || Object.keys(loaded.journal.directory_identities).length > 0);
          if (hasDurableOwnershipClaims && inMemoryReceipts.length === 0 && inMemoryDirectories.length === 0) {
            findings.push(quarantineBootstrapJournal(pinnedRoot, loaded, request.ctoRunId, "no in-memory bootstrap ownership is available after a partial crash").error);
          } else {
            let rollbackError: string | null = null;
            try {
              assertRuntimeLive();
              rollbackError = rollbackBootstrapInMemory(pinnedRoot, inMemoryReceipts, inMemoryDirectories);
            } catch (rollbackGuardError) {
              rollbackError = `runtime access revoked before bootstrap rollback: ${rollbackGuardError instanceof Error ? rollbackGuardError.message : String(rollbackGuardError)}`;
            }
            if (rollbackError) {
              findings.push(`CTO_SPEC_PREPARATION_RECOVERY_REQUIRED: same-process bootstrap rollback could not prove ownership: ${rollbackError}`);
              if (loaded && !("error" in loaded)) findings.push(quarantineBootstrapJournal(pinnedRoot, loaded, request.ctoRunId, "same-process bootstrap rollback could not prove ownership").error);
            } else if (loaded && !("error" in loaded)) {
              try { clearBootstrapJournal(pinnedRoot, loaded.descriptor); }
              catch (clearError) { findings.push(`CTO_SPEC_PREPARATION_RECOVERY_REQUIRED: bootstrap journal descriptor could not be cleared: ${String(clearError)}`); }
            } else if (loaded && "error" in loaded) {
              findings.push(`CTO_SPEC_PREPARATION_RECOVERY_REQUIRED: ${loaded.error}; all bootstrap files were preserved`);
            }
          }
        } else if (loaded && !("error" in loaded)) {
          findings.push(quarantineBootstrapJournal(pinnedRoot, loaded, request.ctoRunId, "canonical CTO state does not prove forward bootstrap completion").error);
        } else if (loaded && "error" in loaded) {
          findings.push(`CTO_SPEC_PREPARATION_RECOVERY_REQUIRED: ${loaded.error}; all bootstrap files were preserved`);
        }
      }
    } catch (recoveryError) {
      findings.push(`bootstrap preparation recovery failed: ${recoveryError instanceof Error ? recoveryError.message : String(recoveryError)}`);
    }
    return blocked(...findings);
  } finally { pinnedRoot.close(); }
}

function activePreparationLocked(ctoRunId: string, pinnedRoot: PinnedProjectRoot): ActivePreparationContext | CtoSpecificationPreparationBlocked {
  const state = readCtoStatePinned(ctoRunId, pinnedRoot) as PreparationState | null; const wave = state && activeWave(state);
  if (!state || state.id !== ctoRunId || !wave || wave.source !== WAVE_SOURCE || wave.id !== state.active_wave_id || !isSafeStateSegment(wave.source_id)) return blocked(`CTO run '${ctoRunId}' is missing or has no active specification-preparation wave`);
  const identity = wave.work_identity; if (!identity || identity.run_id !== ctoRunId || identity.wave_id !== wave.id || identity.workflow !== WORKFLOW || !isSafeStateSegment(identity.capability_id) || !isSafeStateSegment(identity.capability_epoch) || !state.work_identity || JSON.stringify(identity) !== JSON.stringify(state.work_identity)) return blocked(`CTO run '${ctoRunId}' active preparation wave has no exact engine-issued identity`);
  if (!Array.isArray(state.preparation_features)) return blocked(`CTO run '${ctoRunId}' active preparation wave has no scheduled preparation_features`);
  const features = state.preparation_features.map(persistedCopy);
  if (features.some((feature) => !validPreparedFeature(feature))) return blocked(`CTO run '${ctoRunId}' active preparation_features are invalid`);
  for (const feature of features) {
    const workspaceResult = resolveFeatureWorkspace(pinnedRoot.canonical_root, { feature_id: feature.feature_id, run_key: feature.run_key }, {
      lexical_root: pinnedRoot.lexical_root,
      canonical_root: pinnedRoot.canonical_root,
      dev: pinnedRoot.dev,
      ino: pinnedRoot.ino,
      pinned_root: pinnedRoot,
    }, { persistMigration: false, requireMigration: true });
    if (!workspaceResult.ok) return blocked(`workspace '${feature.feature_id}' could not be reread: ${workspaceResult.error}`);
    const constitution = readCtoWorkspaceConstitution(pinnedRoot.canonical_root, workspaceResult.value, pinnedRoot);
    if (!constitution.ok) return blocked(`${constitution.finding}; CTO preparation preflight is blocked`);
  }
  const expectedTeams = features.map((feature) => {
    const descriptor = preparationWriterDescriptor(ctoRunId, feature);
    return { feature, id: descriptor.teamId, dod_path: descriptor.dodPath, dod_digest: descriptor.dodDigest };
  });
  if (state.teams.length !== expectedTeams.length || expectedTeams.some((expected) => { const feature = expected.feature; const team = state.teams.find((candidate) => candidate.id === expected.id); return !team || team.status !== "pending" || team.feature_id !== feature.feature_id || team.run_key !== feature.run_key || !hasCanonicalPreparationClassification(team) || team.workflow !== WORKFLOW || team.dod_path !== expected.dod_path || team.dod_digest !== expected.dod_digest || !preparedWriterDoDMatches(pinnedRoot.canonical_root, pinnedRoot, ctoRunId, feature, team) || team.work_identity === undefined || JSON.stringify(team.work_identity) !== JSON.stringify(identity); })) return blocked(`CTO run '${ctoRunId}' active preparation teams do not match scheduled preparation_features`);
  if (JSON.stringify(wave.slice_ids) !== JSON.stringify(features.map((feature) => feature.phase_writer_id))) return blocked(`CTO run '${ctoRunId}' active preparation wave slices do not match scheduled preparation_features`);
  return { state, wave, features, pinnedRoot };
}
function ensureActivePreparationConstitutionsBeforeRunLock(root: string, ctoRunId: string, pinnedRoot: PinnedProjectRoot): CtoSpecificationPreparationBlocked | null {
  const state = readCtoStatePinned(ctoRunId, pinnedRoot) as PreparationState | null;
  if (!state || !Array.isArray(state.preparation_features)) return null;
  for (const feature of state.preparation_features) {
    if (!validPreparedFeature(feature)) continue;
    const workspace = resolveFeatureWorkspace(root, { feature_id: feature.feature_id, run_key: feature.run_key }, {
      lexical_root: pinnedRoot.lexical_root,
      canonical_root: pinnedRoot.canonical_root,
      dev: pinnedRoot.dev,
      ino: pinnedRoot.ino,
      pinned_root: pinnedRoot,
    }, { persistMigration: false, requireMigration: true });
    // Defer malformed/symlink diagnostics to activePreparationLocked.
    if (!workspace.ok) continue;
    const featureGate = ensureProjectConstitution(root, {
      origin_kind: "cto_preparation",
      origin_run_key: ctoRunId,
      origin_stage: "cto",
    }, { feature_id: feature.feature_id, pinnedRoot });
    if (!featureGate.ok) return blocked(`${featureGate.code}: ${featureGate.error}`);
    if (featureGate.value.status !== "usable" || !featureGate.value.binding) {
      return blocked(`constitution prerequisite is ${featureGate.value.status} for feature '${feature.feature_id}'; CTO preparation preflight is blocked`);
    }
  }
  return null;
}

function withActivePreparation<T>(projectRoot: string, ctoRunId: string, options: CtoSpecificationPreparationOptions, callback: (context: ActivePreparationContext, root: string) => T): T | CtoSpecificationPreparationBlocked {
  const pinnedRoot = PinnedProjectRoot.open(projectRoot); if (!pinnedRoot) return blocked("project root is missing or cannot be canonicalized"); const root = pinnedRoot.canonical_root;
  const assertRuntimeLive = (): void => {
    assertCtoRuntimeAccessFacadeLive(options.runtimeAccess, root, options.sessionId);
    options.runtimeAccess.assertProjectRoot(root);
    options.runtimeAccess.assertLive();
  };
  try {
    assertRuntimeLive();
    if (!pinnedRoot.isStable()) return blocked("project root changed before CTO preparation operation");
    const constitution = ensureActivePreparationConstitutionsBeforeRunLock(root, ctoRunId, pinnedRoot);
    if (constitution) return constitution;
    assertRuntimeLive();
    return withCtoRunLock(root, "__resident_cto__", () => { assertRuntimeLive(); const context = activePreparationLocked(ctoRunId, pinnedRoot); return "status" in context ? context : callback(context, root); }, { pinnedRoot });
  } catch (error) {
    return blocked(`CTO specification preparation operation failed: ${error instanceof Error ? error.message : String(error)}`);
  } finally { pinnedRoot.close(); }
}
function validateDecisionSelectors(context: ActivePreparationContext, decisions: unknown): string[] {
  if (!Array.isArray(decisions)) return ["decisions must be an array"];
  if (decisions.length > MAX_CTO_SPECIFICATION_DECISIONS) {
    return [`decisions may contain at most ${MAX_CTO_SPECIFICATION_DECISIONS} entries`];
  }
  const byFeature = new Map(context.features.map((feature) => [feature.feature_id, feature]));
  const findings: string[] = [];
  for (const [index, candidate] of decisions.entries()) {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
      findings.push(`decisions[${index}] must be an object`);
      continue;
    }
    const value = candidate as Record<string, unknown>;
    const featureId = value.feature_id;
    const feature = typeof featureId === "string" ? byFeature.get(featureId) : undefined;
    if (!feature) {
      findings.push(`decisions[${index}] targets a feature outside the active preparation wave`);
      continue;
    }
    if (value.run_key !== feature.run_key) findings.push(`decisions[${index}] run_key is not bound to scheduled feature '${feature.feature_id}'`);
    if (typeof value.phase !== "string" || !PREPARATION_PHASES.includes(value.phase as WorkspacePhase)) findings.push(`decisions[${index}] phase is not a preparation phase`);
  }
  return findings;
}
export function reviewCtoSpecificationPreparation(projectRoot: string, input: { cto_run_id: string }, options: CtoSpecificationPreparationOptions): CtoSpecificationReviewResult {
  const error = safeId(input?.cto_run_id, "cto_run_id"); if (error) return { status: "blocked", dispatched: false, findings: [error] };
  const result = withActivePreparation(projectRoot, input.cto_run_id, options, (context, root) => { const decisions = readCtoSpecificationDecisionsWhileLocked(root, input.cto_run_id, context.pinnedRoot); const findings = validateDecisionSelectors(context, decisions); if (findings.length > 0) return { status: "blocked", dispatched: false, findings } as const; const allowed = new Set(context.features.map((feature) => feature.feature_id)); const packet = buildCtoSpecificationReviewPacketFromDecisionSnapshotPinned(context.pinnedRoot, { cto_run_id: input.cto_run_id }, decisions, allowed); return packet.ok ? packet.value : { status: "blocked", dispatched: false, findings: [`${packet.code}: ${packet.error}`] }; });
  return result as CtoSpecificationReviewResult;
}
export function decideCtoSpecificationPreparation(projectRoot: string, input: { cto_run_id: string; decisions: unknown }, options: CtoSpecificationPreparationOptions): CtoSpecificationDecisionsResult {
  const error = safeId(input?.cto_run_id, "cto_run_id"); if (error) return { status: "blocked", dispatched: false, findings: [error] };
  const result = withActivePreparation(projectRoot, input.cto_run_id, options, (context, root) => { const findings = validateDecisionSelectors(context, input.decisions); if (findings.length > 0) return { status: "blocked", dispatched: false, findings } as const; try { const recorded = recordCtoSpecificationDecisionsWhileLocked(root, input, context.pinnedRoot); return { status: "recorded", dispatched: false, decisions: recorded.decisions } as const; } catch (errorValue) { return { status: "blocked", dispatched: false, findings: [`CTO specification decision failed: ${errorValue instanceof Error ? errorValue.message : String(errorValue)}`] } as const; } });
  return result as CtoSpecificationDecisionsResult;
}
export function advanceCtoSpecificationPreparationTool(
  projectRoot: string,
  input: { cto_run_id: string },
  options: CtoSpecificationPreparationOptions,
): CtoSpecificationAdvanceResult | CtoSpecificationPreparationBlocked {
  const error = safeId(input?.cto_run_id, "cto_run_id");
  if (error) return blocked(error);
  try {
    return advanceCtoSpecificationPreparation(projectRoot, input, options);
  } catch (errorValue) {
    return blocked(`CTO specification advance failed: ${errorValue instanceof Error ? errorValue.message : String(errorValue)}`);
  }
}
export type { CtoSpecificationPreparationQueueReasonCode, CtoSpecificationPreparationQueuedRequest, CtoSpecificationPreparationScheduledRequest, CtoSpecificationPreparationRequest };
