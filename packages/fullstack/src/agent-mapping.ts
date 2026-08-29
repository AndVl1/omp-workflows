/* <!-- omp-cto-slice run=01a03ee4-7dd6-7580-8ad7-16d26dc886ba slice=workflow-v2-fullstack --> */
import { createHash } from "node:crypto";
import {
  createDiagnostic,
  failureResult,
  isCanonicalRoot,
  isProviderId,
  isWorkflowV2Digest,
  isWorkflowV2Diagnostic,
  successResult,
  validateProjectIdentity,
  validateProviderActivationAdmission,
  validateWorkflowRunIdentity,
  type ActualAgentInventory,
  type AgentInventoryAuthority,
  type AgentInventoryAuthorityContext,
  type AgentRef,
  type CanonicalRoot,
  type DiagnosticResult,
  type ProjectIdentity,
  type ProjectRuntimeKey,
  type ProviderActivationAdmission,
  type ProviderActivationAdmissionExpectation,
  type ProviderDescriptor,
  type WorkflowRunIdentity,
  type WorkflowV2Digest,
} from "@andvl1/omp-workflows-core";
import {
  FULLSTACK_PROVIDER_CATALOG_CONTENT_DIGEST,
  FULLSTACK_PROVIDER_CATALOG,
  FULLSTACK_PROVIDER_DESCRIPTOR_FINGERPRINT,
  FULLSTACK_PROVIDER_DESCRIPTOR,
  FULLSTACK_PROVIDER_ID,
} from "./provider.js";

type ProviderAgentSource = ProviderDescriptor["agent_sources"][number];

/** A mapping diagnostic records only qualified identities; names are display data. */
export type QualifiedMappingStatus = "preferred" | "fallback" | "unavailable";

export interface QualifiedMappingDiagnostic {
  readonly requested: AgentRef;
  readonly candidates: readonly AgentRef[];
  readonly resolved?: AgentRef;
  readonly status: QualifiedMappingStatus;
}

/**
 * The host-issued inventory/admission capability used by all fullstack
 * runtime surfaces.  `ActualAgentInventory` is the host's OMP observation;
 * the resolver is retained so every use can obtain and compare a fresh
 * observation.  The unexported symbol and private issuance ledger prevent a
 * descriptor-valid object or a copied record from becoming an admission.
 */
const INVENTORY_ADMISSION_BRAND: unique symbol = Symbol("fullstack.inventory-admission");

/** Direct source seam reserved for focused tests; never a host admission API. */
export interface FullstackInventoryAdmissionTestInput {
  readonly project_identity: ProjectIdentity;
  readonly run_identity: WorkflowRunIdentity;
  /**
   * The manager/host-selected canonical root.  ProjectIdentity intentionally
   * carries only the path-independent root instance identity, so the root
   * must be supplied explicitly at this admission boundary.
   */
  readonly canonical_root: CanonicalRoot;
  readonly agent_inventory: ActualAgentInventory;
  readonly agent_inventory_authority: AgentInventoryAuthority;
  readonly authority_context: AgentInventoryAuthorityContext;
}

/**
 * Pins supplied by a host/runtime caller before it can bind the opaque core
 * activation proof to the fullstack-local WeakMap capability.
 */
export interface FullstackInventoryAdmissionActivationExpectation {
  readonly project_identity: ProjectIdentity;
  readonly runtime_key: ProjectRuntimeKey;
  readonly canonical_root: CanonicalRoot;
  readonly agent_inventory: ActualAgentInventory;
  readonly agent_inventory_authority: AgentInventoryAuthority;
  readonly authority_context: AgentInventoryAuthorityContext;
  readonly run_identity?: WorkflowRunIdentity;
}

export interface FullstackInventoryAdmissionContext extends FullstackInventoryAdmissionTestInput {
  readonly [INVENTORY_ADMISSION_BRAND]: true;
}


type IssuedAdmissionBinding = {
  readonly project_identity: ProjectIdentity;
  readonly run_identity: WorkflowRunIdentity;
  readonly canonical_root: CanonicalRoot;
  readonly authority_context: AgentInventoryAuthorityContext;
  readonly inventory_fingerprint: WorkflowV2Digest;
  readonly reservation_id: string;
  readonly reservation_fingerprint: WorkflowV2Digest;
  readonly resolver: AgentInventoryAuthority["resolve"];
};

const issuedAdmissions = new WeakMap<object, IssuedAdmissionBinding>();

/** Durable mapping state owned by one project runtime and one prepared run. */
export interface FullstackAgentMapping {
  readonly schema: 3;
  readonly generated_at: string;
  readonly preferences_hash: WorkflowV2Digest;
  readonly project_identity: ProjectIdentity;
  readonly run_identity: WorkflowRunIdentity;
  readonly agent_sources: readonly ProviderAgentSource[];
  readonly agent_inventory_authority: ActualAgentInventory["authority"];
  readonly agent_inventory_fingerprint: WorkflowV2Digest;
  readonly agent_inventory_reservation: NonNullable<ActualAgentInventory["reservation"]>;
  readonly available_agents: readonly AgentRef[];
  readonly role_requests: Readonly<Record<string, AgentRef>>;
  readonly fallback_chains: Readonly<Record<string, readonly AgentRef[]>>;
  readonly resolved_roles: Readonly<Record<string, AgentRef>>;
  readonly diagnostics: Readonly<Record<string, QualifiedMappingDiagnostic>>;
  readonly unresolved_roles: readonly string[];
}

export interface AgentMappingExpectation {
  readonly project_identity: ProjectIdentity;
  readonly run_identity: WorkflowRunIdentity;
  readonly agent_sources: readonly ProviderAgentSource[];
  readonly inventory_admission: FullstackInventoryAdmissionContext;
  readonly preferences_hash?: WorkflowV2Digest;
}

/**
 * Storage is deliberately injected. The fullstack bundle never selects a path,
 * creates a fake filesystem authority, or treats a process-global map as the
 * canonical mapping store.
 */
export interface AgentMappingStorage {
  readonly read: (expected: AgentMappingExpectation) => FullstackAgentMapping | undefined;
  readonly write: (mapping: FullstackAgentMapping) => void;
  readonly dispose?: () => void | Promise<void>;
}

export interface AgentMappingContext {
  readonly project_identity: ProjectIdentity;
  readonly run_identity: WorkflowRunIdentity;
  readonly agent_sources: readonly ProviderAgentSource[];
  readonly roles: Readonly<Record<string, AgentRef>>;
  readonly inventory_admission: FullstackInventoryAdmissionContext;
  readonly fallback_chains?: Readonly<Record<string, readonly AgentRef[]>>;
  readonly storage?: AgentMappingStorage;
}

const DEFAULT_FALLBACK_NAMES: Readonly<Record<string, readonly string[]>> = Object.freeze({
  analyst: ["analyst", "discovery", "diagnostics", "tech-researcher"],
  "tech-researcher": ["tech-researcher", "discovery", "analyst"],
  diagnostics: ["diagnostics", "analyst", "tech-researcher"],
  architect: ["architect"],
  architect_minimal: ["architect"],
  architect_clean: ["architect"],
  architect_pragmatic: ["architect"],
  "backend-kotlin": ["developer-kotlin"],
  go: ["developer-go"],
  frontend: ["frontend-developer"],
  mobile: ["developer-mobile", "init-mobile"],
  android: ["developer-mobile", "init-mobile"],
  qa: ["qa", "code-reviewer", "diagnostics"],
  "manual-qa": ["manual-qa", "qa", "diagnostics"],
  "code-reviewer": ["code-reviewer", "qa", "architect"],
  "security-tester": ["security-tester"],
  devops: ["devops", "diagnostics"],
  "regression-planner": ["analyst", "diagnostics", "tech-researcher"],
  "regression-executor": ["manual-qa", "qa", "diagnostics"],
  "regression-oracle": ["qa", "code-reviewer", "analyst"],
});

const SAFE_IDENTIFIER = /^[A-Za-z0-9@._:/#-]+$/u;
const MAX_IDENTIFIER_LENGTH = 512;
const MAX_AGENT_NAME_LENGTH = 256;

function identityKey(identity: ProjectIdentity): string {
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

function runIdentityKey(identity: WorkflowRunIdentity): string {
  return JSON.stringify([identityKey(identity), identity.run_id, identity.profile_identity.id, identity.profile_identity.fingerprint]);
}

function sameProjectIdentity(left: ProjectIdentity, right: ProjectIdentity): boolean {
  return identityKey(left) === identityKey(right);
}

function sameRunIdentity(left: WorkflowRunIdentity, right: WorkflowRunIdentity): boolean {
  return runIdentityKey(left) === runIdentityKey(right);
}

function compareCanonical(left: string, right: string): number {
  const length = Math.min(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    const leftCode = left.charCodeAt(index);
    const rightCode = right.charCodeAt(index);
    if (leftCode !== rightCode) return leftCode - rightCode;
  }
  return left.length - right.length;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function validIdentifier(value: unknown, maxLength = MAX_IDENTIFIER_LENGTH): value is string {
  return typeof value === "string"
    && value.length > 0
    && value.length <= maxLength
    && value === value.trim()
    && SAFE_IDENTIFIER.test(value);
}

function mappingFailure(
  code: "IDENTITY_MISMATCH" | "CONFIG_MALFORMED" | "AGENT_COLLISION" | "MIGRATION_REQUIRED" | "CAPABILITY_MISSING" | "ACTIVATION_FAILED",
  field: string,
  remediation: string,
): DiagnosticResult<never> {
  return failureResult(createDiagnostic({
    code,
    operation: "runtime.activate",
    evidence: { field },
    remediation,
  }));
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const expectedSet = new Set(expected);
  const keys = Object.keys(value);
  return keys.length === expected.length && keys.every((key) => expectedSet.has(key));
}
function isDenseArray(value: readonly unknown[]): boolean {
  for (let index = 0; index < value.length; index += 1) {
    if (!Object.prototype.hasOwnProperty.call(value, index)) return false;
  }
  return true;
}


function validSource(source: unknown, providerId: string): source is ProviderAgentSource {
  if (!isPlainRecord(source) || !exactKeys(source, ["provider_id", "source_fingerprint", "registered_names"])) return false;
  if (!isProviderId(source.provider_id) || source.provider_id !== providerId || !isWorkflowV2Digest(source.source_fingerprint)) return false;
  if (!Array.isArray(source.registered_names) || source.registered_names.length === 0 || !isDenseArray(source.registered_names)) return false;
  return source.registered_names.every((name) => validIdentifier(name, MAX_AGENT_NAME_LENGTH))
    && new Set(source.registered_names).size === source.registered_names.length;
}

function validAgentShape(agent: unknown, providerId: string): agent is AgentRef {
  if (!isPlainRecord(agent) || !exactKeys(agent, ["registered_name", "provider_id", "source_fingerprint"])) return false;
  return validIdentifier(agent.registered_name, MAX_AGENT_NAME_LENGTH)
    && isProviderId(agent.provider_id)
    && agent.provider_id === providerId
    && isWorkflowV2Digest(agent.source_fingerprint);
}

function validAgent(agent: unknown, providerId: string, sources: readonly ProviderAgentSource[]): agent is AgentRef {
  return validAgentShape(agent, providerId)
    && sources.some((source) => source.provider_id === agent.provider_id
      && source.source_fingerprint === agent.source_fingerprint
      && source.registered_names.includes(agent.registered_name));
}

function validAgentRecord(
  value: unknown,
  providerId: string,
  sources: readonly ProviderAgentSource[],
): value is Readonly<Record<string, AgentRef>> {
  if (!isPlainRecord(value)) return false;
  return Object.entries(value).every(([role, agent]) => validIdentifier(role) && validAgent(agent, providerId, sources));
}

function validAgentChains(
  value: unknown,
  providerId: string,
  sources: readonly ProviderAgentSource[],
): value is Readonly<Record<string, readonly AgentRef[]>> {
  if (!isPlainRecord(value)) return false;
  return Object.entries(value).every(([role, chain]) =>
    validIdentifier(role)
      && Array.isArray(chain)
      && isDenseArray(chain)
      && chain.every((candidate) => validAgent(candidate, providerId, sources)));
}

function freezeAgent(agent: AgentRef): AgentRef {
  return Object.freeze({
    registered_name: agent.registered_name,
    provider_id: agent.provider_id,
    source_fingerprint: agent.source_fingerprint,
  });
}

function keyOf(agent: AgentRef): string {
  return `${agent.registered_name}\u0000${agent.provider_id}\u0000${agent.source_fingerprint}`;
}

function canonicalSources(sources: readonly ProviderAgentSource[]): readonly ProviderAgentSource[] {
  return Object.freeze([...sources]
    .map((source) => Object.freeze({
      provider_id: source.provider_id,
      source_fingerprint: source.source_fingerprint,
      registered_names: Object.freeze([...source.registered_names].sort(compareCanonical)),
    }))
    .sort((left, right) => compareCanonical(
      `${left.provider_id}\u0000${left.source_fingerprint}`,
      `${right.provider_id}\u0000${right.source_fingerprint}`,
    )));
}

function canonicalAgents(agents: readonly AgentRef[]): readonly AgentRef[] {
  return Object.freeze([...agents.map(freezeAgent)].sort((left, right) => compareCanonical(keyOf(left), keyOf(right))));
}

function canonicalRecord(values: Readonly<Record<string, AgentRef>>): Readonly<Record<string, AgentRef>> {
  return Object.freeze(Object.fromEntries(
    Object.entries(values)
      .sort(([left], [right]) => compareCanonical(left, right))
      .map(([role, agent]) => [role, freezeAgent(agent)]),
  ));
}

function canonicalChains(values: Readonly<Record<string, readonly AgentRef[]>>): Readonly<Record<string, readonly AgentRef[]>> {
  return Object.freeze(Object.fromEntries(
    Object.entries(values)
      .sort(([left], [right]) => compareCanonical(left, right))
      .map(([role, agents]) => [role, Object.freeze(agents.map(freezeAgent))]),
  ));
}

function canonicalImmutableJson(value: unknown, active = new Set<object>()): string {
  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("non-finite mapping value");
    return JSON.stringify(value);
  }
  if (typeof value !== "object") throw new TypeError("non-JSON mapping value");
  if (active.has(value)) throw new TypeError("cyclic mapping value");
  active.add(value);
  try {
    if (Array.isArray(value)) return `[${value.map((entry) => canonicalImmutableJson(entry, active)).join(",")}]`;
    if (!isPlainRecord(value)) throw new TypeError("non-plain mapping value");
    return `{${Object.keys(value).sort(compareCanonical).map((key) => `${JSON.stringify(key)}:${canonicalImmutableJson(value[key], active)}`).join(",")}}`;
  } finally {
    active.delete(value);
  }
}

function digest(value: unknown): WorkflowV2Digest {
  return `sha256:${createHash("sha256").update(canonicalImmutableJson(value), "utf8").digest("hex")}` as WorkflowV2Digest;
}

function reservationValue(value: unknown): NonNullable<ActualAgentInventory["reservation"]> | undefined {
  if (!isPlainRecord(value) || !exactKeys(value, ["reservation_id", "fingerprint"])) return undefined;
  if (!validIdentifier(value.reservation_id) || !isWorkflowV2Digest(value.fingerprint)) return undefined;
  return Object.freeze({
    reservation_id: value.reservation_id,
    fingerprint: value.fingerprint,
  });
}

function normalizedInventory(
  value: unknown,
  project: ProjectIdentity,
  sources?: readonly ProviderAgentSource[],
): DiagnosticResult<ActualAgentInventory> {
  if (!isPlainRecord(value)
    || !exactKeys(value, ["authority", "provider_id", "descriptor_fingerprint", "agents", "inventory_fingerprint", "reservation"])) {
    return mappingFailure("CAPABILITY_MISSING", "inventory_admission.agent_inventory", "Provide the complete host-issued ActualAgentInventory with a reservation.");
  }
  if (value.authority !== "omp") {
    return mappingFailure("CAPABILITY_MISSING", "inventory_admission.agent_inventory.authority", "Only the actual OMP inventory authority can admit fullstack work.");
  }
  if (!isProviderId(value.provider_id) || value.provider_id !== project.provider_id) {
    return mappingFailure("IDENTITY_MISMATCH", "inventory_admission.agent_inventory.provider_id", "Use the actual inventory for the admitted provider.");
  }
  if (!isWorkflowV2Digest(value.descriptor_fingerprint) || value.descriptor_fingerprint !== project.descriptor_fingerprint) {
    return mappingFailure("IDENTITY_MISMATCH", "inventory_admission.agent_inventory.descriptor_fingerprint", "Use inventory observed from the exact admitted provider descriptor.");
  }
  if (!isWorkflowV2Digest(value.inventory_fingerprint) || !Array.isArray(value.agents) || value.agents.length === 0) {
    return mappingFailure("CAPABILITY_MISSING", "inventory_admission.agent_inventory.inventory_fingerprint", "Provide a nonempty, fingerprinted actual OMP inventory.");
  }
  const reservation = reservationValue(value.reservation);
  if (!isDenseArray(value.agents)) return mappingFailure("CONFIG_MALFORMED", "inventory_admission.agent_inventory.agents", "Provide a dense actual OMP inventory array.");
  if (!reservation) {
    return mappingFailure("CAPABILITY_MISSING", "inventory_admission.agent_inventory.reservation", "Provide the host-issued run reservation before using inventory.");
  }
  const agents: AgentRef[] = [];
  const keys = new Set<string>();
  for (const candidate of value.agents) {
    if (!validAgentShape(candidate, project.provider_id) || (sources !== undefined && !validAgent(candidate, project.provider_id, sources))) {
      return mappingFailure("AGENT_COLLISION", "inventory_admission.agent_inventory.agents", "Use complete provider/source-qualified agents returned by the actual OMP inventory authority.");
    }
    const normalized = freezeAgent(candidate);
    const key = keyOf(normalized);
    if (keys.has(key)) return mappingFailure("AGENT_COLLISION", "inventory_admission.agent_inventory.agents", "Remove duplicate provider-qualified inventory entries.");
    keys.add(key);
    agents.push(normalized);
  }
  let recomputed: WorkflowV2Digest;
  try {
    recomputed = digest(agents);
  } catch {
    return mappingFailure("CAPABILITY_MISSING", "inventory_admission.agent_inventory.inventory_fingerprint", "Re-issue a canonical actual inventory fingerprint.");
  }
  if (recomputed !== value.inventory_fingerprint) {
    return mappingFailure("IDENTITY_MISMATCH", "inventory_admission.agent_inventory.inventory_fingerprint", "Refresh the actual OMP inventory; its fingerprint does not match the returned agents.");
  }
  return successResult(Object.freeze({
    authority: "omp" as const,
    provider_id: value.provider_id,
    descriptor_fingerprint: value.descriptor_fingerprint,
    agents: Object.freeze(agents),
    inventory_fingerprint: value.inventory_fingerprint,
    reservation,
  }));
}

function validAuthorityContext(
  value: unknown,
  project: ProjectIdentity,
  expectedCanonicalRoot?: CanonicalRoot,
): value is AgentInventoryAuthorityContext {
  if (!isPlainRecord(value)
    || !exactKeys(value, ["canonical_root", "session", "provider_id", "descriptor_fingerprint", "descriptor", "catalog", "effective_policy"])) {
    return false;
  }
  if (!isCanonicalRoot(value.canonical_root)
    || (expectedCanonicalRoot !== undefined && value.canonical_root !== expectedCanonicalRoot)
    || !isProviderId(value.provider_id)
    || value.provider_id !== project.provider_id
    || !isWorkflowV2Digest(value.descriptor_fingerprint)
    || value.descriptor_fingerprint !== project.descriptor_fingerprint
    || !isPlainRecord(value.session)
    || !exactKeys(value.session, ["session_id", "lifecycle_id"])
    || value.session.session_id !== project.session.session_id
    || value.session.lifecycle_id !== project.session.lifecycle_id
    || !isPlainRecord(value.descriptor)
    || !isPlainRecord(value.catalog)
    || !isPlainRecord(value.effective_policy)) {
    return false;
  }
  return true;
}

function validAuthority(value: unknown): value is AgentInventoryAuthority {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  try {
    return "resolve" in value && typeof value.resolve === "function";
  } catch {
    return false;
  }
}

type SuccessfulAuthorityResult = Extract<DiagnosticResult<unknown>, { readonly ok: true }>;

function validAuthorityResult(value: unknown): value is SuccessfulAuthorityResult {
  if (!isPlainRecord(value)
    || value.ok !== true
    || !Object.prototype.hasOwnProperty.call(value, "value")
    || !Array.isArray(value.diagnostics)
    || !isDenseArray(value.diagnostics)) {
    return false;
  }
  return value.diagnostics.every(isWorkflowV2Diagnostic);
}

function sameReservation(
  left: NonNullable<ActualAgentInventory["reservation"]>,
  right: NonNullable<ActualAgentInventory["reservation"]>,
): boolean {
  return left.reservation_id === right.reservation_id && left.fingerprint === right.fingerprint;
}

function sameInventory(left: ActualAgentInventory, right: ActualAgentInventory): boolean {
  if (
    left.authority !== right.authority
    || left.provider_id !== right.provider_id
    || left.descriptor_fingerprint !== right.descriptor_fingerprint
    || left.inventory_fingerprint !== right.inventory_fingerprint
    || left.reservation === undefined
    || right.reservation === undefined
    || !sameReservation(left.reservation, right.reservation)
  ) return false;
  const leftAgents = canonicalAgents(left.agents);
  const rightAgents = canonicalAgents(right.agents);
  return JSON.stringify(leftAgents) === JSON.stringify(rightAgents);
}

function authorityResult(value: unknown, project: ProjectIdentity): DiagnosticResult<ActualAgentInventory> {
  if (!validAuthorityResult(value)) {
    return mappingFailure("CAPABILITY_MISSING", "inventory_admission.authority.resolve", "The actual OMP inventory authority returned no valid admission result.");
  }
  const normalized = normalizedInventory(value.value, project);
  if (!normalized.ok) return normalized;
  return successResult(normalized.value, value.diagnostics);
}

function issueFullstackInventoryAdmission(
  input: FullstackInventoryAdmissionTestInput,
): FullstackInventoryAdmissionContext | undefined {
  if (!isPlainRecord(input)) return undefined;
  const project = validateProjectIdentity(input.project_identity);
  const run = validateWorkflowRunIdentity(input.run_identity);
  if (!project.ok || !run.ok || !sameProjectIdentity(project.ok ? project.value : input.project_identity, run.ok ? run.value : input.run_identity)) {
    return undefined;
  }
  const inventory = normalizedInventory(input.agent_inventory, project.value);
  if (!isCanonicalRoot(input.canonical_root)
    || !inventory.ok
    || !validAuthority(input.agent_inventory_authority)
    || !validAuthorityContext(input.authority_context, project.value, input.canonical_root)) {
    return undefined;
  }
  const reservation = inventory.value.reservation;
  if (reservation === undefined) return undefined;
  let resolver: AgentInventoryAuthority["resolve"];
  try {
    resolver = input.agent_inventory_authority.resolve;
  } catch {
    return undefined;
  }
  const context = {
    project_identity: project.value,
    run_identity: run.value,
    canonical_root: input.canonical_root,
    agent_inventory: inventory.value,
    agent_inventory_authority: input.agent_inventory_authority,
    authority_context: input.authority_context,
  } as FullstackInventoryAdmissionContext;
  Object.defineProperty(context, INVENTORY_ADMISSION_BRAND, { value: true, enumerable: false });
  Object.freeze(context);
  issuedAdmissions.set(context, {
    project_identity: project.value,
    run_identity: run.value,
    canonical_root: input.canonical_root,
    authority_context: input.authority_context,
    inventory_fingerprint: inventory.value.inventory_fingerprint,
    reservation_id: reservation.reservation_id,
    reservation_fingerprint: reservation.fingerprint,
    resolver,
  });
  return context;
}

/** Direct source seam for tests; never use structural inputs for host admission. */
export function createTestFullstackInventoryAdmissionContext(
  input: FullstackInventoryAdmissionTestInput,
): FullstackInventoryAdmissionContext | undefined {
  return issueFullstackInventoryAdmission(input);
}

/**
 * Bind the opaque core activation admission to the local capability ledger.
 * The descriptor and catalog are always the immutable fullstack values; callers
 * cannot substitute a structurally compatible provider or inventory.
 */
export function bindFullstackInventoryAdmissionFromActivation(
  value: ProviderActivationAdmission,
  expected: FullstackInventoryAdmissionActivationExpectation,
): DiagnosticResult<FullstackInventoryAdmissionContext> {
  if (!isPlainRecord(expected)) {
    return mappingFailure("CAPABILITY_MISSING", "activation_admission.expected", "Provide the complete host activation expectation before binding fullstack inventory.");
  }
  let checked: DiagnosticResult<ProviderActivationAdmission>;
  try {
    const coreExpected: ProviderActivationAdmissionExpectation = {
      project_identity: expected.project_identity,
      runtime_key: expected.runtime_key,
      canonical_root: expected.canonical_root,
      provider_id: FULLSTACK_PROVIDER_ID,
      descriptor_fingerprint: FULLSTACK_PROVIDER_DESCRIPTOR_FINGERPRINT,
      catalog_content_digest: FULLSTACK_PROVIDER_CATALOG_CONTENT_DIGEST,
      executable_provenance: FULLSTACK_PROVIDER_DESCRIPTOR.executable_provenance,
      agent_inventory: expected.agent_inventory,
      agent_inventory_authority: expected.agent_inventory_authority,
      authority_context: expected.authority_context,
      ...(expected.run_identity === undefined ? {} : { run_identity: expected.run_identity }),
    };
    checked = validateProviderActivationAdmission(value, coreExpected);
  } catch {
    return mappingFailure("CAPABILITY_MISSING", "activation_admission", "Use the opaque core ProviderActivationAdmission issued after final inventory and reservation preflight.");
  }
  if (!checked.ok) return checked;
  const run = checked.value.run_identity;
  if (run === undefined) {
    return mappingFailure("CAPABILITY_MISSING", "activation_admission.run_identity", "Bind a run-bound core activation admission before using durable fullstack mapping, scheduler, channel, or report surfaces.");
  }
  const local = issueFullstackInventoryAdmission({
    project_identity: checked.value.project_identity,
    run_identity: run,
    canonical_root: checked.value.canonical_root,
    agent_inventory: checked.value.agent_inventory,
    agent_inventory_authority: checked.value.agent_inventory_authority,
    authority_context: checked.value.authority_context,
  });
  if (!local) {
    return mappingFailure("CAPABILITY_MISSING", "activation_admission.inventory", "The validated core activation admission did not contain a complete OMP inventory, reservation, authority, and context.");
  }
  return successResult(local, checked.diagnostics);
}

/**
 * Re-resolve current OMP availability and compare it with the host-issued
 * snapshot.  Every durable mapping/channel/report caller uses this check;
 * stale reservations and copied/self-asserted contexts fail closed.
 */
export function validateFullstackInventoryAdmission(
  context: FullstackInventoryAdmissionContext | undefined,
  expectedProject?: ProjectIdentity,
  expectedRun?: WorkflowRunIdentity,
): DiagnosticResult<FullstackInventoryAdmissionContext> {
  if (!context || typeof context !== "object" || !issuedAdmissions.has(context)) {
    return mappingFailure("CAPABILITY_MISSING", "inventory_admission", "Use the host-issued fullstack inventory admission context; descriptor-valid arrays and self-asserted admission are not accepted.");
  }
  const issued = issuedAdmissions.get(context);
  if (!issued) return mappingFailure("CAPABILITY_MISSING", "inventory_admission", "Use the host-issued fullstack inventory admission context.");
  const project = validateProjectIdentity(context.project_identity);
  const run = validateWorkflowRunIdentity(context.run_identity);
  if (!project.ok || !run.ok || !sameProjectIdentity(project.ok ? project.value : context.project_identity, run.ok ? run.value : context.run_identity)) {
    return mappingFailure("IDENTITY_MISMATCH", "inventory_admission.identity", "Re-issue inventory admission for one complete project and workflow run identity.");
  }
  if (expectedProject !== undefined) {
    const checkedExpected = validateProjectIdentity(expectedProject);
    if (!checkedExpected.ok || !sameProjectIdentity(project.value, checkedExpected.value)) {
      return mappingFailure("IDENTITY_MISMATCH", "inventory_admission.project_identity", "Use inventory admission bound to the exact project runtime.");
    }
  }
  if (expectedRun !== undefined) {
    const checkedExpected = validateWorkflowRunIdentity(expectedRun);
    if (!checkedExpected.ok || !sameRunIdentity(run.value, checkedExpected.value)) {
      return mappingFailure("IDENTITY_MISMATCH", "inventory_admission.run_identity", "Use inventory admission bound to the exact prepared workflow run.");
    }
  }
  if (
    !sameProjectIdentity(issued.project_identity, project.value)
    || !sameRunIdentity(issued.run_identity, run.value)
    || !isCanonicalRoot(context.canonical_root)
    || context.canonical_root !== issued.canonical_root
    || context.authority_context !== issued.authority_context
    || !validAuthority(context.agent_inventory_authority)
    || context.agent_inventory_authority.resolve !== issued.resolver
    || !validAuthorityContext(context.authority_context, project.value, issued.canonical_root)
  ) {
    return mappingFailure("IDENTITY_MISMATCH", "inventory_admission.identity", "The host-issued inventory capability was changed or belongs to another project/run/root.");
  }
  const inventory = normalizedInventory(context.agent_inventory, project.value);
  if (!inventory.ok) return inventory;
  if (
    inventory.value.inventory_fingerprint !== issued.inventory_fingerprint
    || inventory.value.reservation === undefined
    || inventory.value.reservation.reservation_id !== issued.reservation_id
    || inventory.value.reservation.fingerprint !== issued.reservation_fingerprint
  ) {
    return mappingFailure("IDENTITY_MISMATCH", "inventory_admission.reservation", "Refresh the host-issued inventory reservation before continuing.");
  }
  let response: unknown;
  try {
    response = context.agent_inventory_authority.resolve(context.authority_context);
  } catch {
    return mappingFailure("CAPABILITY_MISSING", "inventory_admission.authority.resolve", "The actual OMP inventory authority could not refresh availability.");
  }
  const current = authorityResult(response, project.value);
  if (!current.ok) return current;
  if (!sameInventory(current.value, inventory.value)) {
    return mappingFailure("IDENTITY_MISMATCH", "inventory_admission.current_inventory", "Current OMP availability or reservation differs from the admitted snapshot; refresh the run.");
  }
  return successResult(context, current.diagnostics);
}

function defaultFallbackChains(available: readonly AgentRef[]): Readonly<Record<string, readonly AgentRef[]>> {
  const byName = new Map<string, AgentRef>();
  for (const agent of available) if (!byName.has(agent.registered_name)) byName.set(agent.registered_name, agent);
  const result: Record<string, readonly AgentRef[]> = {};
  for (const [role, names] of Object.entries(DEFAULT_FALLBACK_NAMES)) {
    const refs = names.map((name) => byName.get(name)).filter((agent): agent is AgentRef => agent !== undefined);
    if (refs.length > 0) result[role] = Object.freeze(refs.map(freezeAgent));
  }
  return canonicalChains(result);
}

function mappingHash(input: {
  readonly project_identity: ProjectIdentity;
  readonly run_identity: WorkflowRunIdentity;
  readonly agent_sources: readonly ProviderAgentSource[];
  readonly agent_inventory_authority: ActualAgentInventory["authority"];
  readonly agent_inventory_fingerprint: WorkflowV2Digest;
  readonly agent_inventory_reservation: NonNullable<ActualAgentInventory["reservation"]>;
  readonly available_agents: readonly AgentRef[];
  readonly role_requests: Readonly<Record<string, AgentRef>>;
  readonly fallback_chains: Readonly<Record<string, readonly AgentRef[]>>;
}): WorkflowV2Digest {
  return digest({
    project_identity: input.project_identity,
    run_identity: input.run_identity,
    inventory_admission: {
      authority: input.agent_inventory_authority,
      inventory_fingerprint: input.agent_inventory_fingerprint,
      reservation: input.agent_inventory_reservation,
      available_agents: canonicalAgents(input.available_agents),
    },
    agent_sources: canonicalSources(input.agent_sources),
    role_requests: canonicalRecord(input.role_requests),
    fallback_chains: canonicalChains(input.fallback_chains),
  });
}

/** Build a qualified mapping from one host-issued, freshly verified inventory. */
export function buildFullstackAgentMapping(context: AgentMappingContext): DiagnosticResult<FullstackAgentMapping> {
  const project = validateProjectIdentity(context.project_identity);
  if (!project.ok) return project;
  const run = validateWorkflowRunIdentity(context.run_identity);
  if (!run.ok) return run;
  if (!sameProjectIdentity(project.value, run.value)) {
    return mappingFailure("IDENTITY_MISMATCH", "run_identity.project_identity", "Use a run identity inheriting the active project identity.");
  }
  if (!Array.isArray(context.agent_sources) || context.agent_sources.length === 0 || !context.agent_sources.every((source) => validSource(source, project.value.provider_id))) {
    return mappingFailure("MIGRATION_REQUIRED", "agent_sources", "Provide the complete provider-qualified descriptor source set.");
  }
  const sources = canonicalSources(context.agent_sources);
  const admission = validateFullstackInventoryAdmission(context.inventory_admission, project.value, run.value);
  if (!admission.ok) return admission;
  const inventory = normalizedInventory(admission.value.agent_inventory, project.value, sources);
  if (!inventory.ok) return inventory;
  const available = canonicalAgents(inventory.value.agents);
  const availableKeys = new Set(available.map(keyOf));
  const chainsInput = context.fallback_chains ?? defaultFallbackChains(available);
  if (!isPlainRecord(chainsInput)) {
    return mappingFailure("CONFIG_MALFORMED", "fallback_chains", "Provide a plain role-to-qualified-agent fallback map.");
  }
  const chains: Record<string, readonly AgentRef[]> = {};
  for (const [role, candidates] of Object.entries(chainsInput)) {
    if (!validIdentifier(role) || !Array.isArray(candidates) || !isDenseArray(candidates) || candidates.some((candidate) => !validAgent(candidate, project.value.provider_id, sources))) {
      return mappingFailure("AGENT_COLLISION", `fallback_chains.${role}`, "Every fallback must be a qualified AgentRef from the descriptor source set.");
    }
    chains[role] = Object.freeze(candidates.map(freezeAgent));
  }
  const canonicalFallbacks = canonicalChains(chains);
  if (!isPlainRecord(context.roles)) {
    return mappingFailure("CONFIG_MALFORMED", "roles", "Provide a plain role-to-qualified-agent map.");
  }
  const roleRequests: Record<string, AgentRef> = {};
  const diagnostics: Record<string, QualifiedMappingDiagnostic> = {};
  const resolved: Record<string, AgentRef> = {};
  const unresolved: string[] = [];
  for (const [role, requestedValue] of Object.entries(context.roles).sort(([left], [right]) => compareCanonical(left, right))) {
    if (!validIdentifier(role) || !validAgent(requestedValue, project.value.provider_id, sources)) {
      return mappingFailure("AGENT_COLLISION", `roles.${role}`, "Every policy role must carry a provider-qualified descriptor source identity.");
    }
    const requested = freezeAgent(requestedValue);
    roleRequests[role] = requested;
    const candidates = [requested, ...(canonicalFallbacks[role] ?? [])].map(freezeAgent);
    const uniqueCandidates = [...new Map(candidates.map((candidate) => [keyOf(candidate), candidate])).values()];
    const selected = uniqueCandidates.find((candidate) => availableKeys.has(keyOf(candidate)));
    if (selected) {
      const status: QualifiedMappingStatus = keyOf(selected) === keyOf(requested) ? "preferred" : "fallback";
      resolved[role] = selected;
      diagnostics[role] = Object.freeze({ requested, candidates: Object.freeze(uniqueCandidates), resolved: selected, status });
    } else {
      unresolved.push(role);
      diagnostics[role] = Object.freeze({ requested, candidates: Object.freeze(uniqueCandidates), status: "unavailable" });
    }
  }
  const canonicalRoles = canonicalRecord(roleRequests);
  const canonicalResolved = canonicalRecord(resolved);
  const canonicalDiagnostics = Object.freeze(Object.fromEntries(
    Object.entries(diagnostics).sort(([left], [right]) => compareCanonical(left, right)),
  ));
  const preferencesHash = mappingHash({
    project_identity: project.value,
    run_identity: run.value,
    agent_sources: sources,
    agent_inventory_authority: inventory.value.authority,
    agent_inventory_fingerprint: inventory.value.inventory_fingerprint,
    agent_inventory_reservation: inventory.value.reservation!,
    available_agents: available,
    role_requests: canonicalRoles,
    fallback_chains: canonicalFallbacks,
  });
  const mapping: FullstackAgentMapping = Object.freeze({
    schema: 3,
    generated_at: new Date().toISOString(),
    preferences_hash: preferencesHash,
    project_identity: project.value,
    run_identity: run.value,
    agent_sources: sources,
    agent_inventory_authority: inventory.value.authority,
    agent_inventory_fingerprint: inventory.value.inventory_fingerprint,
    agent_inventory_reservation: inventory.value.reservation!,
    available_agents: available,
    role_requests: canonicalRoles,
    fallback_chains: canonicalFallbacks,
    resolved_roles: canonicalResolved,
    diagnostics: canonicalDiagnostics,
    unresolved_roles: Object.freeze(unresolved),
  });
  return successResult(mapping);
}

function validStoredMapping(
  value: unknown,
  project: ProjectIdentity,
  run: WorkflowRunIdentity,
  sources: readonly ProviderAgentSource[],
  currentInventory: ActualAgentInventory,
): value is FullstackAgentMapping {
  if (!isPlainRecord(value)
    || value.schema !== 3
    || typeof value.generated_at !== "string"
    || !isWorkflowV2Digest(value.preferences_hash)
    || !isWorkflowV2Digest(value.agent_inventory_fingerprint)
    || value.agent_inventory_authority !== "omp"
    || !Array.isArray(value.agent_sources)
    || !isDenseArray(value.agent_sources)
    || !Array.isArray(value.available_agents)
    || !isDenseArray(value.available_agents)
    || !Array.isArray(value.unresolved_roles)
    || !isDenseArray(value.unresolved_roles)
    || !isPlainRecord(value.role_requests)
    || !isPlainRecord(value.fallback_chains)
    || !isPlainRecord(value.resolved_roles)
    || !isPlainRecord(value.diagnostics)) {
    return false;
  }
  const roleRequests = value.role_requests;
  const fallbackChains = value.fallback_chains;
  const resolvedRoles = value.resolved_roles;
  if (
    !validAgentRecord(roleRequests, project.provider_id, sources)
    || !validAgentChains(fallbackChains, project.provider_id, sources)
    || !validAgentRecord(resolvedRoles, project.provider_id, sources)
  ) return false;
  const storedProject = validateProjectIdentity(value.project_identity);
  const storedRun = validateWorkflowRunIdentity(value.run_identity);
  if (!storedProject.ok
    || !storedRun.ok
    || !sameProjectIdentity(storedProject.value, project)
    || !sameRunIdentity(storedRun.value, run)
    || JSON.stringify(value.agent_sources) !== JSON.stringify(sources)
    || value.agent_inventory_fingerprint !== currentInventory.inventory_fingerprint) {
    return false;
  }
  const storedReservation = reservationValue(value.agent_inventory_reservation);
  if (
    !storedReservation
    || currentInventory.reservation === undefined
    || !sameReservation(storedReservation, currentInventory.reservation)
    || JSON.stringify(canonicalAgents(value.available_agents.filter((candidate): candidate is AgentRef => validAgentShape(candidate, project.provider_id))))
      !== JSON.stringify(canonicalAgents(currentInventory.agents))
  ) return false;
  if (value.available_agents.some((candidate) => !validAgent(candidate, project.provider_id, sources))) return false;
  const roleNames = Object.keys(roleRequests).sort(compareCanonical);
  if (!roleNames.every((role) => validIdentifier(role)) || !Object.keys(fallbackChains).every((role) => validIdentifier(role))) return false;
  const unresolved = [...value.unresolved_roles];
  if (
    unresolved.some((role) => !validIdentifier(role) || !roleNames.includes(role))
    || new Set(unresolved).size !== unresolved.length
    || unresolved.some((role, index) => index > 0 && compareCanonical(unresolved[index - 1]!, role) > 0)
  ) return false;
  for (const role of roleNames) {
    const request = roleRequests[role];
    if (!validAgent(request, project.provider_id, sources)) return false;
    const chain = fallbackChains[role];
    if (chain !== undefined && (!Array.isArray(chain) || !isDenseArray(chain) || chain.some((candidate) => !validAgent(candidate, project.provider_id, sources)))) return false;
    const diagnostic = value.diagnostics[role];
    if (!isPlainRecord(diagnostic)
      || !Object.prototype.hasOwnProperty.call(diagnostic, "requested")
      || !Array.isArray(diagnostic.candidates)
      || !isDenseArray(diagnostic.candidates)
      || !["preferred", "fallback", "unavailable"].includes(String(diagnostic.status))
      || !validAgent(diagnostic.requested, project.provider_id, sources)
      || keyOf(diagnostic.requested) !== keyOf(request)
      || diagnostic.candidates.some((candidate) => !validAgent(candidate, project.provider_id, sources))) return false;
    const statusKey = String(diagnostic.status);
    const diagnosticKeys = Object.keys(diagnostic);
    if (
      diagnosticKeys.some((key) => !["requested", "candidates", "resolved", "status"].includes(key))
      || (statusKey === "unavailable"
        ? Object.prototype.hasOwnProperty.call(diagnostic, "resolved")
        : !Object.prototype.hasOwnProperty.call(diagnostic, "resolved"))
    ) return false;
    const unique = new Set(diagnostic.candidates.map((candidate) => keyOf(candidate)));
    if (unique.size !== diagnostic.candidates.length) return false;
    const status = diagnostic.status as QualifiedMappingStatus;
    const resolved = diagnostic.resolved;
    if (status === "unavailable") {
      if (resolved !== undefined || !unresolved.includes(role)) return false;
      continue;
    }
    const resolvedRole = resolvedRoles[role];
    const resolvedAgent = validAgent(resolved, project.provider_id, sources) ? resolved : undefined;
    if (
      resolvedAgent === undefined
      || !currentInventory.agents.some((candidate) => keyOf(candidate) === keyOf(resolvedAgent))
      || (status === "preferred" && keyOf(resolvedAgent) !== keyOf(request))
      || (status === "fallback" && keyOf(resolvedAgent) === keyOf(request))
      || unresolved.includes(role)
      || resolvedRole === undefined
      || keyOf(resolvedRole) !== keyOf(resolvedAgent)
    ) return false;
  }
  if (Object.keys(value.diagnostics).sort(compareCanonical).join("\u0000") !== roleNames.join("\u0000")) return false;
  if (Object.keys(resolvedRoles).some((role) => !roleNames.includes(role) || unresolved.includes(role))) return false;
  for (const role of Object.keys(resolvedRoles)) {
    if (!validAgent(resolvedRoles[role], project.provider_id, sources)) return false;
  }
  for (const chain of Object.values(fallbackChains)) {
    if (!Array.isArray(chain) || !isDenseArray(chain) || chain.some((candidate) => !validAgent(candidate, project.provider_id, sources))) return false;
  }
  try {
    return mappingHash({
      project_identity: project,
      run_identity: run,
      agent_sources: sources,
      agent_inventory_authority: currentInventory.authority,
      agent_inventory_fingerprint: currentInventory.inventory_fingerprint,
      agent_inventory_reservation: storedReservation,
      available_agents: currentInventory.agents,
      role_requests: roleRequests,
      fallback_chains: fallbackChains,
    }) === value.preferences_hash;
  } catch {
    return false;
  }
}

/** Read a mapping only when identities, reservation and current inventory match exactly. */
export function readFullstackAgentMapping(storage: AgentMappingStorage | undefined, expected: AgentMappingExpectation): FullstackAgentMapping | undefined {
  if (!storage) return undefined;
  const project = validateProjectIdentity(expected.project_identity);
  const run = validateWorkflowRunIdentity(expected.run_identity);
  if (!project.ok || !run.ok || !sameProjectIdentity(project.value, run.value)) return undefined;
  const sources = expected.agent_sources;
  if (!Array.isArray(sources) || sources.length === 0 || !sources.every((source) => validSource(source, project.value.provider_id))) return undefined;
  const canonical = canonicalSources(sources);
  const admission = validateFullstackInventoryAdmission(expected.inventory_admission, project.value, run.value);
  if (!admission.ok) return undefined;
  const current = normalizedInventory(admission.value.agent_inventory, project.value, canonical);
  if (!current.ok) return undefined;
  let value: FullstackAgentMapping | undefined;
  try {
    value = storage.read(expected);
  } catch {
    return undefined;
  }
  try {
    if (!validStoredMapping(value, project.value, run.value, canonical, current.value)) return undefined;
  } catch {
    return undefined;
  }
  if (!value) return undefined;
  if (expected.preferences_hash !== undefined && value.preferences_hash !== expected.preferences_hash) return undefined;
  return value;
}

/** Build and publish one mapping through the explicitly supplied storage seam. */
export function writeFullstackAgentMapping(context: AgentMappingContext): DiagnosticResult<FullstackAgentMapping> {
  const built = buildFullstackAgentMapping(context);
  if (!built.ok) return built;
  if (!context.storage) return mappingFailure("CAPABILITY_MISSING", "mapping.storage", "Provide a host-managed mapping storage before persisting a durable mapping.");
  try {
    context.storage.write(built.value);
  } catch {
    return mappingFailure("ACTIVATION_FAILED", "mapping.storage", "The host-managed mapping storage rejected the run-bound mapping.");
  }
  return built;
}

/** Session-owned mapping resource; no process-global cache or implicit root. */
export class FullstackAgentMappingResource {
  private current: FullstackAgentMapping | undefined;
  private disposed = false;

  constructor(readonly context: AgentMappingContext) {}

  refresh(): DiagnosticResult<FullstackAgentMapping> {
    if (this.disposed) return mappingFailure("ACTIVATION_FAILED", "mapping.lifecycle", "The provider runtime has been shut down; start a fresh lifecycle.");
    const result = writeFullstackAgentMapping(this.context);
    if (result.ok) this.current = result.value;
    return result;
  }

  read(): FullstackAgentMapping | undefined {
    if (this.disposed) return undefined;
    const expected: AgentMappingExpectation = {
      project_identity: this.context.project_identity,
      run_identity: this.context.run_identity,
      agent_sources: this.context.agent_sources,
      inventory_admission: this.context.inventory_admission,
      ...(this.current === undefined ? {} : { preferences_hash: this.current.preferences_hash }),
    };
    const persisted = readFullstackAgentMapping(this.context.storage, expected);
    this.current = persisted;
    return persisted;
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    this.current = undefined;
    await this.context.storage?.dispose?.();
  }
}

/** Explicit provider-qualified role lookup; a flat name is never returned. */
export function resolveFullstackAgent(mapping: FullstackAgentMapping, role: string): AgentRef | undefined {
  if (mapping.schema !== 3) return undefined;
  return mapping.resolved_roles[role];
}