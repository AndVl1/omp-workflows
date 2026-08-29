/* <!-- omp-cto-slice run=01a03ee4-7dd6-7580-8ad7-16d26dc886ba slice=workflow-v2-core --> */

import { randomUUID } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import {
  canonicalImmutableJson,
  compareCanonicalKeys,
  digestImmutable,
  preflightAgentInventory,
} from "../workflow-v2/descriptor.js";
import { createDiagnostic, failureResult, successResult } from "../workflow-v2/diagnostics.js";
import {
  isProviderId,
  isWorkflowV2Digest,
  validateProjectIdentity,
  validateWorkflowRunIdentity,
} from "../workflow-v2/identity.js";
import type {
  AgentRef,
  AgentSourceFingerprint,
  DiagnosticResult,
  ProjectIdentity,
  ProviderId,
  WorkflowRunIdentity,
  WorkflowV2Digest,
} from "../workflow-v2/types.js";

export const QUALIFIED_AGENT_MAPPING_SCHEMA = 3 as const;

const MAX_NAME_LENGTH = 256;
const MAPPING_FILE = join(".work-state", "runtime", "agent-mapping.json");
const SAFE_NAME = /^[A-Za-z0-9@._:/#-]+$/u;

export type QualifiedAgentMappingStatus = "preferred" | "fallback" | "unavailable";

export interface QualifiedAgentMappingDiagnostic {
  readonly requested: AgentRef;
  readonly candidates: readonly AgentRef[];
  readonly resolved?: AgentRef;
  readonly status: QualifiedAgentMappingStatus;
}

/** Inputs for a mapping that is eligible for durable workflow use. */
export interface QualifiedAgentMappingOptions {
  /** Project/provider authority selected by host activation. */
  readonly project_identity: ProjectIdentity;
  /** Exact run identity persisted by workflow_prepare. */
  readonly run_identity: WorkflowRunIdentity;
  /** Complete canonical descriptor source set; never infer one source. */
  readonly agent_sources: readonly AgentSourceFingerprint[];
  readonly roles: Readonly<Record<string, AgentRef>>;
  readonly availableAgents: readonly AgentRef[];
  readonly fallbackChains?: Readonly<Record<string, readonly AgentRef[]>>;
  readonly extraRoles?: readonly AgentRef[];
}

/** Identity preconditions required before a durable mapping may be read. */
export interface QualifiedAgentMappingExpectation {
  readonly project_identity: ProjectIdentity;
  readonly run_identity: WorkflowRunIdentity;
  /** Complete descriptor source set from the active provider snapshot. */
  readonly agent_sources: readonly AgentSourceFingerprint[];
  readonly preferences_hash?: WorkflowV2Digest;
}

export interface QualifiedAgentMappingState {
  readonly schema: typeof QUALIFIED_AGENT_MAPPING_SCHEMA;
  readonly generated_at: string;
  readonly preferences_hash: WorkflowV2Digest;
  /** Active project/provider/config authority; profile-free. */
  readonly project_identity: ProjectIdentity;
  /** Exact prepared workflow identity; never inferred from role/order/path. */
  readonly run_identity: WorkflowRunIdentity;
  /** Canonical immutable descriptor source set used to validate every AgentRef. */
  readonly agent_sources: readonly AgentSourceFingerprint[];
  readonly available_agents: readonly AgentRef[];
  readonly resolved_roles: Readonly<Record<string, AgentRef>>;
  readonly diagnostics: Readonly<Record<string, QualifiedAgentMappingDiagnostic>>;
  readonly unresolved_roles: readonly string[];
}

const PROJECT_IDENTITY_KEYS = [
  "root_instance_id",
  "provider_id",
  "descriptor_fingerprint",
  "executable_provenance",
  "catalog_content_digest",
  "config_byte_sha256",
  "config_semantic_sha256",
  "session",
] as const;
const EXECUTABLE_PROVENANCE_KEYS = ["build_fingerprint", "runtime_fingerprint"] as const;
const SESSION_KEYS = ["session_id", "lifecycle_id"] as const;
const SOURCE_KEYS = ["provider_id", "source_fingerprint", "registered_names"] as const;
const AGENT_KEYS = ["registered_name", "provider_id", "source_fingerprint"] as const;
const MAPPING_KEYS = [
  "schema",
  "generated_at",
  "preferences_hash",
  "project_identity",
  "run_identity",
  "agent_sources",
  "available_agents",
  "resolved_roles",
  "diagnostics",
  "unresolved_roles",
] as const;

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[], optional: readonly string[] = []): boolean {
  const allowed = new Set([...keys, ...optional]);
  return Object.keys(value).every((key) => allowed.has(key))
    && keys.every((key) => Object.prototype.hasOwnProperty.call(value, key));
}

function canonicalName(value: unknown): value is string {
  return typeof value === "string"
    && value.length > 0
    && value.length <= MAX_NAME_LENGTH
    && value === value.trim()
    && SAFE_NAME.test(value)
    && !/[\r\n]/u.test(value);
}

function safeIdentityComponent(value: unknown): value is string {
  return typeof value === "string"
    && value.length > 0
    && value.length <= 512
    && value === value.trim()
    && SAFE_NAME.test(value)
    && !/[\r\n]/u.test(value);
}

function agentIdentityKey(agent: AgentRef): string {
  return canonicalImmutableJson([
    agent.registered_name,
    agent.provider_id,
    agent.source_fingerprint,
  ]);
}

function sourceIdentityKey(source: AgentSourceFingerprint): string {
  return canonicalImmutableJson([source.provider_id, source.source_fingerprint]);
}


function isQualifiedAgent(value: unknown): value is AgentRef {
  if (!isPlainRecord(value) || !hasExactKeys(value, AGENT_KEYS)) return false;
  return canonicalName(value.registered_name)
    && isProviderId(value.provider_id)
    && isWorkflowV2Digest(value.source_fingerprint);
}

function cloneAgent(agent: AgentRef): AgentRef {
  return Object.freeze({
    registered_name: agent.registered_name,
    provider_id: agent.provider_id,
    source_fingerprint: agent.source_fingerprint,
  });
}

function cloneProjectIdentity(identity: ProjectIdentity): ProjectIdentity {
  return Object.freeze({
    root_instance_id: identity.root_instance_id,
    provider_id: identity.provider_id,
    descriptor_fingerprint: identity.descriptor_fingerprint,
    executable_provenance: Object.freeze({
      build_fingerprint: identity.executable_provenance.build_fingerprint,
      runtime_fingerprint: identity.executable_provenance.runtime_fingerprint,
    }),
    catalog_content_digest: identity.catalog_content_digest,
    config_byte_sha256: identity.config_byte_sha256,
    config_semantic_sha256: identity.config_semantic_sha256,
    session: Object.freeze({
      session_id: identity.session.session_id,
      lifecycle_id: identity.session.lifecycle_id,
    }),
  });
}

function cloneRunIdentity(identity: WorkflowRunIdentity): WorkflowRunIdentity {
  return Object.freeze({
    ...cloneProjectIdentity(identity),
    run_id: identity.run_id,
    profile_identity: Object.freeze({
      id: identity.profile_identity.id,
      fingerprint: identity.profile_identity.fingerprint,
    }),
  });
}

function cloneAgentSources(sources: readonly AgentSourceFingerprint[]): readonly AgentSourceFingerprint[] {
  return Object.freeze(sources.map((source) => Object.freeze({
    provider_id: source.provider_id,
    source_fingerprint: source.source_fingerprint,
    registered_names: Object.freeze([...source.registered_names]),
  })));
}

function sameProjectIdentity(left: ProjectIdentity, right: ProjectIdentity): boolean {
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

function sameRunIdentity(left: WorkflowRunIdentity, right: WorkflowRunIdentity): boolean {
  return sameProjectIdentity(left, right)
    && left.run_id === right.run_id
    && left.profile_identity.id === right.profile_identity.id
    && left.profile_identity.fingerprint === right.profile_identity.fingerprint;
}

function isProjectIdentityShape(value: unknown, allowRunFields = false): value is ProjectIdentity {
  if (!isPlainRecord(value) || !hasExactKeys(value, PROJECT_IDENTITY_KEYS, allowRunFields ? ["run_id", "profile_identity"] : [])) return false;
  if (!isWorkflowV2Digest(value.root_instance_id)
    || !isProviderId(value.provider_id)
    || !isWorkflowV2Digest(value.descriptor_fingerprint)
    || !isWorkflowV2Digest(value.catalog_content_digest)
    || !isWorkflowV2Digest(value.config_byte_sha256)
    || !isWorkflowV2Digest(value.config_semantic_sha256)) return false;
  if (!isPlainRecord(value.executable_provenance)
    || !hasExactKeys(value.executable_provenance, EXECUTABLE_PROVENANCE_KEYS)
    || !isWorkflowV2Digest(value.executable_provenance.build_fingerprint)
    || !isWorkflowV2Digest(value.executable_provenance.runtime_fingerprint)) return false;
  if (!isPlainRecord(value.session)
    || !hasExactKeys(value.session, SESSION_KEYS)
    || !safeIdentityComponent(value.session.session_id)
    || !safeIdentityComponent(value.session.lifecycle_id)) return false;
  return true;
}

function isQualifiedProjectIdentity(value: unknown): value is ProjectIdentity {
  return isProjectIdentityShape(value);
}

function isQualifiedRunIdentity(value: unknown): value is WorkflowRunIdentity {
  return validateWorkflowRunIdentity(value).ok;
}

function isAgentSource(value: unknown): value is AgentSourceFingerprint {
  if (!isPlainRecord(value) || !hasExactKeys(value, SOURCE_KEYS)) return false;
  if (!isProviderId(value.provider_id) || !isWorkflowV2Digest(value.source_fingerprint) || !Array.isArray(value.registered_names) || value.registered_names.length === 0) return false;
  return value.registered_names.every(canonicalName)
    && new Set(value.registered_names).size === value.registered_names.length;
}

function sourceSort(left: AgentSourceFingerprint, right: AgentSourceFingerprint): number {
  const provider = compareCanonicalKeys(left.provider_id, right.provider_id);
  if (provider !== 0) return provider;
  const fingerprint = compareCanonicalKeys(left.source_fingerprint, right.source_fingerprint);
  if (fingerprint !== 0) return fingerprint;
  return compareCanonicalKeys(left.registered_names.join("\u0000"), right.registered_names.join("\u0000"));
}

function normalizeAgentSources(
  sources: readonly AgentSourceFingerprint[],
  providerId: ProviderId,
): DiagnosticResult<readonly AgentSourceFingerprint[]> {
  if (!Array.isArray(sources) || sources.length === 0) {
    return failureResult(mappingDiagnostic("CONFIG_MALFORMED", "agent_sources", "Supply the complete descriptor agent source set; no source may be inferred."));
  }
  const byName = new Map<string, AgentSourceFingerprint>();
  const unique = new Map<string, AgentSourceFingerprint>();
  for (const [index, source] of sources.entries()) {
    if (!isAgentSource(source)) {
      return failureResult(mappingDiagnostic("CONFIG_MALFORMED", `agent_sources[${index}]`, "Every descriptor source must include one provider, fingerprint and unique registered-name set."));
    }
    if (source.provider_id !== providerId) {
      return failureResult(mappingDiagnostic("IDENTITY_MISMATCH", `agent_sources[${index}].provider_id`, "Every descriptor source must belong to the active provider.", { provider_id: providerId }));
    }
    const normalized = Object.freeze({
      provider_id: source.provider_id,
      source_fingerprint: source.source_fingerprint,
      registered_names: Object.freeze([...source.registered_names].sort(compareCanonicalKeys)),
    });
    const sourceKey = sourceIdentityKey(normalized);
    for (const name of normalized.registered_names) {
      const existing = byName.get(name);
      if (existing && sourceIdentityKey(existing) !== sourceKey) {
        return failureResult(mappingDiagnostic("AGENT_COLLISION", `agent_sources[${index}].registered_names`, "Resolve every registered name to one provider/source identity before dispatch.", { registered_name: name }));
      }
    }
    const existingSource = unique.get(sourceKey);
    const merged = existingSource
      ? Object.freeze({
        provider_id: normalized.provider_id,
        source_fingerprint: normalized.source_fingerprint,
        registered_names: Object.freeze([...new Set([...existingSource.registered_names, ...normalized.registered_names])].sort(compareCanonicalKeys)),
      })
      : normalized;
    unique.set(sourceKey, merged);
    for (const name of merged.registered_names) byName.set(name, merged);
  }
  return successResult(Object.freeze([...unique.values()].sort(sourceSort)));
}

function sourceSetContainsAgent(sources: readonly AgentSourceFingerprint[], agent: AgentRef): boolean {
  return sources.some((source) => source.provider_id === agent.provider_id
    && source.source_fingerprint === agent.source_fingerprint
    && source.registered_names.includes(agent.registered_name));
}
function validateMappingIdentities(
  projectIdentity: unknown,
  runIdentity: unknown,
): DiagnosticResult<{ readonly project_identity: ProjectIdentity; readonly run_identity: WorkflowRunIdentity }> {
  const project = validateProjectIdentity(projectIdentity);
  if (!project.ok) {
    return failureResult(mappingDiagnostic(
      "IDENTITY_MISMATCH",
      "project_identity",
      "Supply the complete profile-free ProjectIdentity from the active provider/config authority.",
    ));
  }
  if (runIdentity === undefined) {
    return failureResult(mappingDiagnostic(
      "MIGRATION_REQUIRED",
      "run_identity",
      "Recreate the mapping through workflow_prepare so it carries the exact WorkflowRunIdentity.",
    ));
  }
  const run = validateWorkflowRunIdentity(runIdentity);
  if (!run.ok) {
    return failureResult(mappingDiagnostic(
      "IDENTITY_MISMATCH",
      "run_identity",
      "Supply the exact WorkflowRunIdentity persisted by workflow_prepare.",
    ));
  }
  if (!sameProjectIdentity(project.value, run.value)) {
    return failureResult(mappingDiagnostic(
      "IDENTITY_MISMATCH",
      "run_identity.project_identity",
      "The durable mapping run must inherit the active project/provider identity exactly.",
      { provider_id: project.value.provider_id },
    ));
  }
  return successResult({
    project_identity: project.value,
    run_identity: run.value,
  });
}

function mappingDiagnostic(
  code: "CONFIG_MALFORMED" | "IDENTITY_MISMATCH" | "AGENT_COLLISION" | "MIGRATION_REQUIRED",
  field: string,
  remediation: string,
  evidence: Record<string, unknown> = {},
) {
  return createDiagnostic({
    code,
    operation: "agent.preflight",
    evidence: { field, ...evidence },
    remediation,
  });
}

function uniqueCandidates(candidates: readonly AgentRef[]): AgentRef[] {
  const seen = new Set<string>();
  const result: AgentRef[] = [];
  for (const candidate of candidates) {
    const key = agentIdentityKey(candidate);
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(cloneAgent(candidate));
  }
  return result;
}

function sortedRoleEntries(roles: Readonly<Record<string, AgentRef>>): Array<[string, AgentRef]> {
  return Object.entries(roles).sort(([left], [right]) => compareCanonicalKeys(left, right));
}

function sortedFallbackEntries(
  fallbackChains: Readonly<Record<string, readonly AgentRef[]>> | undefined,
): Array<[string, readonly AgentRef[]]> {
  return Object.entries(fallbackChains ?? {}).sort(([left], [right]) => compareCanonicalKeys(left, right));
}

function canonicalSourceSet(sources: readonly AgentSourceFingerprint[]): readonly AgentSourceFingerprint[] {
  return [...sources]
    .map((source) => ({
      provider_id: source.provider_id,
      source_fingerprint: source.source_fingerprint,
      registered_names: [...source.registered_names].sort(compareCanonicalKeys),
    }))
    .sort(sourceSort);
}

function canonicalQualifiedPreferences(
  projectIdentity: ProjectIdentity,
  runIdentity: WorkflowRunIdentity,
  agentSources: readonly AgentSourceFingerprint[],
  roles: Readonly<Record<string, AgentRef>>,
  fallbackChains: Readonly<Record<string, readonly AgentRef[]>> | undefined,
): string {
  return canonicalImmutableJson({
    project_identity: cloneProjectIdentity(projectIdentity),
    run_identity: cloneRunIdentity(runIdentity),
    agent_sources: canonicalSourceSet(agentSources),
    roles: sortedRoleEntries(roles).map(([role, agent]) => [role, cloneAgent(agent)]),
    fallback_chains: sortedFallbackEntries(fallbackChains).map(([role, agents]) => [role, agents.map(cloneAgent)]),
  });
}

export function qualifiedMappingPreferencesHash(
  projectIdentity: ProjectIdentity,
  runIdentity: WorkflowRunIdentity,
  agentSources: readonly AgentSourceFingerprint[],
  roles: Readonly<Record<string, AgentRef>>,
  fallbackChains?: Readonly<Record<string, readonly AgentRef[]>>,
): WorkflowV2Digest {
  return digestImmutable(JSON.parse(canonicalQualifiedPreferences(projectIdentity, runIdentity, agentSources, roles, fallbackChains)));
}

function cloneQualifiedMapping(value: QualifiedAgentMappingState): QualifiedAgentMappingState {
  const diagnostics: Record<string, QualifiedAgentMappingDiagnostic> = {};
  for (const [role, diagnostic] of Object.entries(value.diagnostics)) {
    diagnostics[role] = Object.freeze({
      requested: cloneAgent(diagnostic.requested),
      candidates: Object.freeze(diagnostic.candidates.map(cloneAgent)),
      ...(diagnostic.resolved ? { resolved: cloneAgent(diagnostic.resolved) } : {}),
      status: diagnostic.status,
    });
  }
  const resolvedRoles: Record<string, AgentRef> = {};
  for (const [role, agent] of Object.entries(value.resolved_roles)) resolvedRoles[role] = cloneAgent(agent);
  return Object.freeze({
    schema: QUALIFIED_AGENT_MAPPING_SCHEMA,
    generated_at: value.generated_at,
    preferences_hash: value.preferences_hash,
    project_identity: cloneProjectIdentity(value.project_identity),
    run_identity: cloneRunIdentity(value.run_identity),
    agent_sources: cloneAgentSources(value.agent_sources),
    available_agents: Object.freeze(value.available_agents.map(cloneAgent)),
    resolved_roles: Object.freeze(resolvedRoles),
    diagnostics: Object.freeze(diagnostics),
    unresolved_roles: Object.freeze([...value.unresolved_roles]),
  });
}

function rolesWithExtras(
  roles: Readonly<Record<string, AgentRef>>,
  extraRoles: readonly AgentRef[] | undefined,
): DiagnosticResult<Readonly<Record<string, AgentRef>>> {
  if (!isPlainRecord(roles)) {
    return failureResult(mappingDiagnostic("CONFIG_MALFORMED", "roles", "Supply provider-qualified AgentRef values for every semantic role."));
  }
  if (extraRoles !== undefined && !Array.isArray(extraRoles)) {
    return failureResult(mappingDiagnostic("CONFIG_MALFORMED", "extra_roles", "Extra mapping references must be supplied as a qualified AgentRef array."));
  }
  const combined: Record<string, AgentRef> = { ...roles };
  for (const [index, extra] of (extraRoles ?? []).entries()) {
    if (!isQualifiedAgent(extra)) {
      return failureResult(mappingDiagnostic("CONFIG_MALFORMED", `extra_roles[${index}]`, "Extra mapping references must be provider-qualified AgentRef values."));
    }
    const previous = combined[extra.registered_name];
    if (previous && agentIdentityKey(previous) !== agentIdentityKey(extra)) {
      return failureResult(mappingDiagnostic(
        "AGENT_COLLISION",
        `extra_roles[${index}]`,
        "Resolve each registered name to one provider/source identity before building the mapping.",
        { source_fingerprint: extra.source_fingerprint },
      ));
    }
    combined[extra.registered_name] = extra;
  }
  return successResult(combined);
}

function validateFallbackChains(
  fallbackChains: Readonly<Record<string, readonly AgentRef[]>> | undefined,
  roles: Readonly<Record<string, AgentRef>>,
): DiagnosticResult<Readonly<Record<string, readonly AgentRef[]>>> {
  if (fallbackChains === undefined) return successResult({});
  if (!isPlainRecord(fallbackChains)) {
    return failureResult(mappingDiagnostic("CONFIG_MALFORMED", "fallback_chains", "Fallback chains must be keyed by semantic roles and contain qualified AgentRef values."));
  }
  const checked: Record<string, readonly AgentRef[]> = {};
  for (const [role, candidates] of sortedFallbackEntries(fallbackChains)) {
    if (!canonicalName(role) || !Object.prototype.hasOwnProperty.call(roles, role) || !Array.isArray(candidates) || !candidates.every(isQualifiedAgent)) {
      return failureResult(mappingDiagnostic("CONFIG_MALFORMED", `fallback_chains.${role}`, "Fallback chains must target known roles and retain complete provider/source identities."));
    }
    checked[role] = Object.freeze(candidates.map(cloneAgent));
  }
  return successResult(Object.freeze(checked));
}

/** Build a durable mapping bound to one project authority and one prepared run. */
export function buildQualifiedAgentMapping(options: QualifiedAgentMappingOptions): DiagnosticResult<QualifiedAgentMappingState> {
  if (!isPlainRecord(options)) {
    return failureResult(mappingDiagnostic("IDENTITY_MISMATCH", "project_identity", "Supply a complete project identity and prepared workflow run identity."));
  }
  const identities = validateMappingIdentities(options.project_identity, options.run_identity);
  if (!identities.ok) return identities;
  const { project_identity, run_identity } = identities.value;
  const sources = normalizeAgentSources(options.agent_sources, project_identity.provider_id);
  if (!sources.ok) return sources;
  if (!Array.isArray(options.availableAgents)) {
    return failureResult(mappingDiagnostic("CONFIG_MALFORMED", "available_agents", "Supply the actual provider-qualified agent inventory as an array."));
  }
  const preflight = preflightAgentInventory(options.availableAgents);
  if (!preflight.ok) return failureResult(preflight.diagnostics);
  for (const [index, agent] of preflight.value.entries()) {
    if (agent.provider_id !== project_identity.provider_id || !sourceSetContainsAgent(sources.value, agent)) {
      return failureResult(mappingDiagnostic(
        "IDENTITY_MISMATCH",
        `available_agents[${index}]`,
        "Every observed agent must match one exact source in the active provider descriptor.",
        { provider_id: project_identity.provider_id },
      ));
    }
  }
  const combinedRoles = rolesWithExtras(options.roles, options.extraRoles);
  if (!combinedRoles.ok) return combinedRoles;
  const roleMap = combinedRoles.value;
  const fallbackResult = validateFallbackChains(options.fallbackChains, roleMap);
  if (!fallbackResult.ok) return fallbackResult;
  const fallbackChains = fallbackResult.value;
  const availableByName = new Map<string, AgentRef>();
  for (const agent of preflight.value) availableByName.set(agent.registered_name, agent);
  const resolvedRoles: Record<string, AgentRef> = {};
  const diagnostics: Record<string, QualifiedAgentMappingDiagnostic> = {};
  const unresolvedRoles: string[] = [];

  for (const [role, requested] of sortedRoleEntries(roleMap)) {
    if (!canonicalName(role) || !isQualifiedAgent(requested) || requested.provider_id !== project_identity.provider_id) {
      return failureResult(mappingDiagnostic("IDENTITY_MISMATCH", `roles.${role}`, "Every mapping role must belong to the selected provider and retain an exact source fingerprint.", { provider_id: project_identity.provider_id }));
    }
    const candidates = uniqueCandidates([requested, ...(fallbackChains[role] ?? [])]);
    if (candidates.some((candidate) => candidate.provider_id !== project_identity.provider_id)) {
      return failureResult(mappingDiagnostic("IDENTITY_MISMATCH", `fallback_chains.${role}`, "Every fallback candidate must belong to the selected provider.", { provider_id: project_identity.provider_id }));
    }
    if (candidates.some((candidate) => !sourceSetContainsAgent(sources.value, candidate))) {
      return failureResult(mappingDiagnostic("IDENTITY_MISMATCH", `roles.${role}`, "Every configured AgentRef must match one exact descriptor provider/source/name binding."));
    }
    const resolved = candidates.find((candidate) => {
      const available = availableByName.get(candidate.registered_name);
      return available !== undefined && agentIdentityKey(available) === agentIdentityKey(candidate);
    });
    const status: QualifiedAgentMappingStatus = resolved === undefined
      ? "unavailable"
      : agentIdentityKey(resolved) === agentIdentityKey(requested) ? "preferred" : "fallback";
    diagnostics[role] = Object.freeze({
      requested: cloneAgent(requested),
      candidates: Object.freeze(candidates),
      ...(resolved ? { resolved: cloneAgent(resolved) } : {}),
      status,
    });
    if (resolved) resolvedRoles[role] = cloneAgent(resolved);
    else unresolvedRoles.push(role);
  }

  const state: QualifiedAgentMappingState = {
    schema: QUALIFIED_AGENT_MAPPING_SCHEMA,
    generated_at: new Date().toISOString(),
    preferences_hash: qualifiedMappingPreferencesHash(project_identity, run_identity, sources.value, roleMap, fallbackChains),
    project_identity: cloneProjectIdentity(project_identity),
    run_identity: cloneRunIdentity(run_identity),
    agent_sources: cloneAgentSources(sources.value),
    available_agents: preflight.value,
    resolved_roles: resolvedRoles,
    diagnostics,
    unresolved_roles: unresolvedRoles,
  };
  return successResult(cloneQualifiedMapping(state));
}

function stateRolesAndFallbacks(
  diagnostics: Readonly<Record<string, QualifiedAgentMappingDiagnostic>>,
): { roles: Record<string, AgentRef>; fallbackChains: Record<string, readonly AgentRef[]> } {
  const roles: Record<string, AgentRef> = {};
  const fallbackChains: Record<string, readonly AgentRef[]> = {};
  for (const [role, diagnostic] of Object.entries(diagnostics)) {
    roles[role] = diagnostic.requested;
    if (diagnostic.candidates.length > 1) fallbackChains[role] = diagnostic.candidates.slice(1);
  }
  return { roles, fallbackChains };
}

function isMappingDiagnostic(value: unknown): value is QualifiedAgentMappingDiagnostic {
  if (!isPlainRecord(value) || !hasExactKeys(value, ["requested", "candidates", "status"], ["resolved"])) return false;
  return isQualifiedAgent(value.requested)
    && Array.isArray(value.candidates)
    && value.candidates.length > 0
    && value.candidates.every(isQualifiedAgent)
    && (value.resolved === undefined || isQualifiedAgent(value.resolved))
    && (value.status === "preferred" || value.status === "fallback" || value.status === "unavailable");
}
function isQualifiedAgentList(value: unknown): value is readonly AgentRef[] {
  return Array.isArray(value) && value.every(isQualifiedAgent);
}

function isAgentSourceList(value: unknown): value is readonly AgentSourceFingerprint[] {
  return Array.isArray(value) && value.every(isAgentSource);
}

function isCanonicalNameList(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every(canonicalName);
}

function isQualifiedMappingDiagnostics(
  value: unknown,
): value is Readonly<Record<string, QualifiedAgentMappingDiagnostic>> {
  return isPlainRecord(value)
    && Object.entries(value).every(([role, diagnostic]) => canonicalName(role) && isMappingDiagnostic(diagnostic));
}


function isQualifiedMappingState(value: unknown): value is QualifiedAgentMappingState {
  if (!isPlainRecord(value) || !hasExactKeys(value, MAPPING_KEYS)) return false;
  if (value.schema !== QUALIFIED_AGENT_MAPPING_SCHEMA
    || typeof value.generated_at !== "string"
    || !Number.isFinite(Date.parse(value.generated_at))
    || !isWorkflowV2Digest(value.preferences_hash)) return false;

  const projectIdentity = value.project_identity;
  const runIdentity = value.run_identity;
  if (!isQualifiedProjectIdentity(projectIdentity)
    || !isQualifiedRunIdentity(runIdentity)
    || !sameProjectIdentity(projectIdentity, runIdentity)) return false;

  const agentSources = value.agent_sources;
  const availableAgents = value.available_agents;
  if (!isAgentSourceList(agentSources) || !isQualifiedAgentList(availableAgents)) return false;
  const normalizedSources = normalizeAgentSources(agentSources, projectIdentity.provider_id);
  if (!normalizedSources.ok || canonicalImmutableJson(normalizedSources.value) !== canonicalImmutableJson(agentSources)) return false;
  const preflight = preflightAgentInventory(availableAgents);
  if (!preflight.ok || preflight.value.length !== availableAgents.length) return false;
  if (!availableAgents.every((agent) => agent.provider_id === projectIdentity.provider_id
    && sourceSetContainsAgent(normalizedSources.value, agent))) return false;

  const availableByName = new Map<string, AgentRef>();
  for (const agent of availableAgents) availableByName.set(agent.registered_name, agent);

  const resolvedRoles = value.resolved_roles;
  if (!isPlainRecord(resolvedRoles) || !Object.entries(resolvedRoles).every(([role, agent]) => {
    if (!canonicalName(role) || !isQualifiedAgent(agent)) return false;
    const available = availableByName.get(agent.registered_name);
    return agent.provider_id === projectIdentity.provider_id
      && sourceSetContainsAgent(normalizedSources.value, agent)
      && available !== undefined
      && agentIdentityKey(available) === agentIdentityKey(agent);
  })) return false;

  const diagnostics = value.diagnostics;
  if (!isQualifiedMappingDiagnostics(diagnostics)) return false;
  for (const [role, diagnostic] of Object.entries(diagnostics)) {
    if (diagnostic.requested.provider_id !== projectIdentity.provider_id
      || !sourceSetContainsAgent(normalizedSources.value, diagnostic.requested)
      || diagnostic.candidates.some((candidate) => candidate.provider_id !== projectIdentity.provider_id
        || !sourceSetContainsAgent(normalizedSources.value, candidate))) return false;
    if (diagnostic.resolved) {
      const available = availableByName.get(diagnostic.resolved.registered_name);
      if (!available || agentIdentityKey(available) !== agentIdentityKey(diagnostic.resolved)) return false;
    }
    if (diagnostic.status === "unavailable" ? diagnostic.resolved !== undefined : diagnostic.resolved === undefined) return false;
  }

  const unresolvedRoles = value.unresolved_roles;
  if (!isCanonicalNameList(unresolvedRoles)
    || new Set(unresolvedRoles).size !== unresolvedRoles.length
    || unresolvedRoles.some((role) => role in resolvedRoles)) return false;
  const unresolved = new Set(unresolvedRoles);
  for (const [role, diagnostic] of Object.entries(diagnostics)) {
    if ((diagnostic.status === "unavailable") !== unresolved.has(role)) return false;
  }
  const derived = stateRolesAndFallbacks(diagnostics);
  try {
    if (qualifiedMappingPreferencesHash(projectIdentity, runIdentity, normalizedSources.value, derived.roles, derived.fallbackChains) !== value.preferences_hash) return false;
  } catch {
    return false;
  }
  return true;
}

function assertSafeMappingRoot(projectRoot: string): string {
  if (typeof projectRoot !== "string" || !projectRoot || !isAbsolute(projectRoot) || projectRoot.split(/[\\/]+/u).includes("..")) {
    throw new Error("mapping root must be an absolute traversal-free project root");
  }
  const root = resolve(projectRoot);
  if (!existsSync(root) || !lstatSync(root).isDirectory()) throw new Error(`mapping root does not exist: ${root}`);
  return realpathSync(root);
}

function assertSafeMappingPath(root: string, path: string): void {
  const rel = relative(root, path);
  if (!rel || isAbsolute(rel) || rel === ".." || rel.startsWith(`..${sep}`)) throw new Error("agent mapping path escapes project root");
  let cursor = root;
  for (const segment of rel.split(sep)) {
    cursor = join(cursor, segment);
    if (existsSync(cursor) && lstatSync(cursor).isSymbolicLink()) throw new Error(`agent mapping path contains symlink: ${cursor}`);
  }
}

export function qualifiedAgentMappingPath(projectRoot: string): string {
  const root = assertSafeMappingRoot(projectRoot);
  const path = resolve(root, MAPPING_FILE);
  assertSafeMappingPath(root, path);
  return path;
}

/** Read a durable map only when the active project, source set and prepared run match exactly. */
export function readQualifiedAgentMapping(
  projectRoot: string,
  expected: QualifiedAgentMappingExpectation,
): QualifiedAgentMappingState | undefined {
  if (!isPlainRecord(expected)) return undefined;
  const identities = validateMappingIdentities(expected.project_identity, expected.run_identity);
  if (!identities.ok) return undefined;
  const sources = normalizeAgentSources(expected.agent_sources, identities.value.project_identity.provider_id);
  if (!sources.ok) return undefined;
  let path: string;
  try {
    path = qualifiedAgentMappingPath(projectRoot);
  } catch {
    return undefined;
  }
  if (!existsSync(path)) return undefined;
  try {
    if (lstatSync(path).isSymbolicLink() || !lstatSync(path).isFile()) return undefined;
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (!isQualifiedMappingState(parsed)) return undefined;
    if (!sameProjectIdentity(parsed.project_identity, identities.value.project_identity)
      || !sameRunIdentity(parsed.run_identity, identities.value.run_identity)
      || canonicalImmutableJson(parsed.agent_sources) !== canonicalImmutableJson(sources.value)) return undefined;
    if (expected.preferences_hash !== undefined && parsed.preferences_hash !== expected.preferences_hash) return undefined;
    return cloneQualifiedMapping(parsed);
  } catch {
    return undefined;
  }
}

/** Persist a qualified map atomically outside tracked policy authority. */
export function writeQualifiedAgentMapping(projectRoot: string, mapping: QualifiedAgentMappingState): string {
  const path = qualifiedAgentMappingPath(projectRoot);
  if (!isQualifiedMappingState(mapping)) throw new Error("refusing to persist malformed qualified agent mapping");
  const directory = dirname(path);
  mkdirSync(directory, { recursive: true });
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(mapping, null, 2)}\n`, "utf8");
  renameSync(temporary, path);
  return path;
}

/** Resolve only an exact qualified role entry; no flat-name or generic fallback exists. */
export function resolveQualifiedAgentForRole(
  mapping: QualifiedAgentMappingState,
  role: string,
): AgentRef | undefined {
  return mapping.resolved_roles[role];
}
