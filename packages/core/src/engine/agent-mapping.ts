import { createHash } from "node:crypto";
import { existsSync, lstatSync, realpathSync } from "node:fs";
import { TextDecoder } from "node:util";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { PinnedProjectRoot, type PinnedRootWriteReceipt } from "../specification/pinned-root.js";

export const AGENT_MAPPING_SCHEMA = 1 as const;
export const DEFAULT_GENERIC_AGENT = "task";
export const AGENT_MAPPING_MAX_BYTES = 256 * 1024;
const MAPPING_MAX_DEPTH = 8;
const MAPPING_MAX_NODES = 4096;
const MAPPING_MAX_KEYS = 256;
const MAPPING_MAX_ARRAY = 256;
const MAPPING_MAX_STRING_BYTES = 8 * 1024;

export type AgentMappingWriteErrorCode = "invalid" | "limit";

/** Typed fail-closed error raised before a mapping file can be replaced. */
export class AgentMappingWriteError extends Error {
  readonly code: AgentMappingWriteErrorCode;
  readonly byteLength?: number;
  readonly maxBytes = AGENT_MAPPING_MAX_BYTES;

  constructor(code: AgentMappingWriteErrorCode, message: string, byteLength?: number) {
    super(message);
    this.name = "AgentMappingWriteError";
    this.code = code;
    this.byteLength = byteLength;
  }
}

function boundedMappingJson(value: unknown, depth = 0, budget = { nodes: 0, bytes: 0 }, seen = new Set<object>()): boolean {
  if (++budget.nodes > MAPPING_MAX_NODES || depth > MAPPING_MAX_DEPTH) return false;
  if (value === null || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value === "string") {
    budget.bytes += Buffer.byteLength(value, "utf8");
    return budget.bytes <= AGENT_MAPPING_MAX_BYTES
      && Buffer.byteLength(value, "utf8") <= MAPPING_MAX_STRING_BYTES
      && !/[\u0000-\u001f\u007f]/u.test(value);
  }
  if (!value || typeof value !== "object" || seen.has(value)) return false;
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      return value.length <= MAPPING_MAX_ARRAY
        && value.every((item) => boundedMappingJson(item, depth + 1, budget, seen));
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return false;
    const entries = Object.entries(value);
    return entries.length <= MAPPING_MAX_KEYS
      && entries.every(([key, item]) => {
        budget.bytes += Buffer.byteLength(key, "utf8");
        return Buffer.byteLength(key, "utf8") <= MAPPING_MAX_STRING_BYTES
          && !/[\u0000-\u001f\u007f]/u.test(key)
          && budget.bytes <= AGENT_MAPPING_MAX_BYTES
          && boundedMappingJson(item, depth + 1, budget, seen);
      });
  } finally {
    seen.delete(value);
  }
}
function readPinnedUtf8(root: PinnedProjectRoot, relativePath: string): string | null {
  try {
    if (!root.pathEntryExists(relativePath)) return null;
    return new TextDecoder("utf-8", { fatal: true }).decode(root.readFile(relativePath, { maxBytes: AGENT_MAPPING_MAX_BYTES }).bytes);
  } catch {
    return null;
  }
}
const MAX_NAME_LENGTH = 128;

function setMappingOwn<T>(target: Record<string, T>, key: string, value: T): void {
  Object.defineProperty(target, key, {
    configurable: true,
    enumerable: true,
    value,
    writable: true,
  });
}
const MAPPING_FILE = join(".work-state", "runtime", "agent-mapping.json");

export type AgentMappingPublicationReceipt = {
  readonly canonical_root: string;
  readonly root_dev: number;
  readonly root_ino: number;
  readonly relative_path: string;
  readonly dev: number;
  readonly ino: number;
  readonly size: number;
  readonly sha256: string;
};

// A persisted JSON parse is intentionally not enough to mint authorization.
// Only the exact mapping object returned by the engine's publication writer
// gets a receipt, and proof issuance verifies that receipt against a pinned
// read before accepting the host handoff.
const mappingPublicationReceipts = new WeakMap<object, AgentMappingPublicationReceipt>();
const latestPublishedMappings = new Map<string, AgentMappingState>();
const MAX_LATEST_PUBLISHED_MAPPINGS = 256;

function publicationRootKey(root: PinnedProjectRoot): string {
  return `${root.canonical_root}\u0000${root.dev}:${root.ino}`;
}

export type AgentMappingStatus = "preferred" | "fallback" | "unavailable";

export interface AgentMappingDiagnostic {
  requested: string;
  candidates: string[];
  resolved?: string;
  status: AgentMappingStatus;
}

/**
 * Every input that can change the meaning of a generated mapping belongs in
 * the hash.  Optional fields keep the generic core usable by bundles that do
 * not have a config document yet.
 */
export interface MappingPreferencesProvenance {
  scope_map?: readonly unknown[];
  /** Alias accepted by generic adapters that call the input simply `scope`. */
  scope?: readonly unknown[];
  flags?: Record<string, readonly unknown[]>;
  roster?: unknown;
  roster_overrides?: unknown;
  config_path?: string | null;
  config_source?: string;
  config_hash?: string;
  config_version?: string | number | null;
  configHash?: string;
  configVersion?: string | number | null;
  config_provenance?: unknown;
  provider_discovery?: readonly string[];
  providerDiscovery?: readonly string[];
  source?: string;
  mappingSource?: string;
  fallback_chains?: Record<string, readonly string[]>;
  generic_fallback?: string | null;
  generic_fallback_roles?: readonly string[];
}

export interface AgentMappingState {
  schema: typeof AGENT_MAPPING_SCHEMA;
  generated_at: string;
  preferences_hash: string;
  available_agents: string[];
  resolved_roles: Record<string, string>;
  diagnostics: Record<string, AgentMappingDiagnostic>;
  unresolved_roles: string[];
  /** Mapping producer, e.g. the fullstack adapter or another bundle. */
  source?: string;
  config_path?: string | null;
  config_hash?: string;
  config_version?: string | number | null;
  provider_discovery_hash?: string;
  provenance?: MappingPreferencesProvenance;
}

export interface AgentMappingOptions extends MappingPreferencesProvenance {
  /** Semantic workflow role -> preferred concrete agent. */
  roles: Record<string, string>;
  /** Live names returned by OMP's agent discovery. */
  availableAgents: readonly string[];
  /** Ordered semantic fallback candidates per role. */
  fallbackChains?: Record<string, readonly string[]>;
  /** Concrete agents referenced by scope_map or other runtime config. */
  extraRoles?: readonly string[];
  /** Generic OMP agent used only after all semantic candidates fail. */
  genericFallback?: string | null;
  /** Roles allowed to degrade to the generic agent; omitted means all. */
  genericFallbackRoles?: readonly string[];
}

export interface AgentMappingExpectation extends MappingPreferencesProvenance {
  roles?: Record<string, string>;
  extraRoles?: readonly string[];
  availableAgents?: readonly string[];
  preferences_hash?: string;
}

function normalizedName(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim();
  if (!normalized || normalized.length > MAX_NAME_LENGTH || /[\r\n]/u.test(normalized)) return undefined;
  return normalized;
}

function uniqueNames(values: readonly unknown[]): string[] {
  const result: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    const normalized = normalizedName(value);
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    result.push(normalized);
  }
  return result;
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, canonicalize(entry)]),
    );
  }
  return value;
}

function canonicalString(value: unknown): string {
  return JSON.stringify(canonicalize(value)) ?? "null";
}

function hashValue(value: unknown): string {
  return createHash("sha256").update(canonicalString(value)).digest("hex");
}

function hashText(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function normalizedRoleEntries(roles: Record<string, string>): Array<[string, string]> {
  return Object.entries(roles)
    .map(([role, agent]) => [normalizedName(role), normalizedName(agent)] as const)
    .filter((entry): entry is [string, string] => Boolean(entry[0] && entry[1]))
    .sort(([left], [right]) => left.localeCompare(right));
}

function canonicalFlags(flags: Record<string, readonly unknown[]> | undefined): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(flags ?? {})
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, patterns]) => [key, uniqueNames(patterns).sort((left, right) => left.localeCompare(right))]),
  );
}

function canonicalPreferences(
  roles: Record<string, string>,
  extraRoles: readonly string[],
  provenance: MappingPreferencesProvenance = {},
): string {
  return canonicalString({
    roles: normalizedRoleEntries(roles),
    extra_roles: uniqueNames(extraRoles).sort((left, right) => left.localeCompare(right)),
    scope_map: provenance.scope_map ?? provenance.scope ?? [],
    flags: canonicalFlags(provenance.flags),
    roster: provenance.roster ?? provenance.roster_overrides ?? null,
    config: {
      path: provenance.config_path ?? null,
      source: provenance.config_source ?? null,
      hash: provenance.config_hash ?? provenance.configHash ?? null,
      version: provenance.config_version ?? provenance.configVersion ?? null,
      provenance: provenance.config_provenance ?? null,
    },
    provider_discovery: uniqueNames(provenance.provider_discovery ?? provenance.providerDiscovery ?? []).sort((left, right) => left.localeCompare(right)),
    source: provenance.source ?? provenance.mappingSource ?? null,
    fallback_chains: provenance.fallback_chains ?? null,
    generic_fallback: provenance.generic_fallback ?? null,
    generic_fallback_roles: uniqueNames(provenance.generic_fallback_roles ?? []).sort((left, right) => left.localeCompare(right)),
  });
}

export function mappingPreferencesHash(
  roles: Record<string, string>,
  extraRoles: readonly string[] = [],
  provenance: MappingPreferencesProvenance = {},
): string {
  return createHash("sha256").update(canonicalPreferences(roles, extraRoles, provenance)).digest("hex");
}

function candidateKeys(options: AgentMappingOptions): string[] {
  const rosterRoles = Object.entries(options.roster ?? {}).flatMap(([key, value]) => [
    key,
    ...(Array.isArray(value) ? value : []),
    ...(value && typeof value === "object" ? Object.values(value as Record<string, unknown>).flatMap(item => Array.isArray(item) ? item : []) : []),
  ]);
  const keys = [
    ...Object.keys(options.roles),
    ...Object.values(options.roles),
    ...Object.keys(options.fallbackChains ?? {}),
    ...Object.values(options.fallbackChains ?? {}).flat(),
    ...(options.extraRoles ?? []),
    ...rosterRoles,
  ];
  return uniqueNames(keys);
}

function candidatesFor(key: string, requested: string, options: AgentMappingOptions): string[] {
  const genericAllowed = options.genericFallbackRoles === undefined || options.genericFallbackRoles.includes(key);
  return uniqueNames([
    requested,
    ...(options.fallbackChains?.[key] ?? []),
    key,
    genericAllowed
      ? options.genericFallback === undefined ? DEFAULT_GENERIC_AGENT : options.genericFallback
      : undefined,
  ]);
}

function mappingProvenance(options: AgentMappingOptions, availableAgents: readonly string[]): MappingPreferencesProvenance {
  const provenance: MappingPreferencesProvenance = { provider_discovery: [...availableAgents] };
  if (options.scope_map !== undefined || options.scope !== undefined) provenance.scope_map = options.scope_map ?? options.scope;
  if (options.flags !== undefined) provenance.flags = options.flags;
  if (options.roster !== undefined || options.roster_overrides !== undefined) provenance.roster = options.roster ?? options.roster_overrides;
  if (options.config_path !== undefined) provenance.config_path = options.config_path;
  if (options.config_source !== undefined) provenance.config_source = options.config_source;
  if (options.config_hash !== undefined || options.configHash !== undefined) provenance.config_hash = options.config_hash ?? options.configHash;
  const configVersion = options.config_version !== undefined ? options.config_version : options.configVersion;
  if (configVersion !== undefined) provenance.config_version = configVersion;
  if (options.config_provenance !== undefined) provenance.config_provenance = options.config_provenance;
  if (options.source !== undefined || options.mappingSource !== undefined) provenance.source = options.source ?? options.mappingSource;
  const fallbackChains = options.fallbackChains ?? options.fallback_chains;
  if (fallbackChains !== undefined) provenance.fallback_chains = fallbackChains;
  const genericFallback = options.genericFallback !== undefined ? options.genericFallback : options.generic_fallback;
  if (genericFallback !== undefined) provenance.generic_fallback = genericFallback;
  const genericFallbackRoles = options.genericFallbackRoles ?? options.generic_fallback_roles;
  if (genericFallbackRoles !== undefined) provenance.generic_fallback_roles = genericFallbackRoles;
  return provenance;
}

/**
 * Resolve semantic roles against the live OMP agent inventory.
 *
 * The configured mapping remains the preferred choice. A fallback is selected
 * only when that concrete agent is absent from the live inventory; when no
 * generic fallback is available the role is explicitly unresolved instead of
 * leaking an unknown agent name into the task tool.
 */
export function buildAgentMapping(options: AgentMappingOptions): AgentMappingState {
  const available_agents = uniqueNames(options.availableAgents);
  const available = new Set(available_agents);
  const resolved_roles: Record<string, string> = {};
  const diagnostics: Record<string, AgentMappingDiagnostic> = {};
  const unresolved_roles: string[] = [];

  for (const key of candidateKeys(options)) {
    const requested = normalizedName(options.roles[key]) ?? key;
    const candidates = candidatesFor(key, requested, options);
    const resolved = candidates.find(candidate => available.has(candidate));
    const status: AgentMappingStatus = !resolved
      ? "unavailable"
      : resolved === requested
        ? "preferred"
        : "fallback";
    setMappingOwn(diagnostics, key, { requested, candidates, ...(resolved ? { resolved } : {}), status });
    if (resolved) setMappingOwn(resolved_roles, key, resolved);
    else unresolved_roles.push(key);
  }

  const provenance = mappingProvenance(options, available_agents);
  return {
    schema: AGENT_MAPPING_SCHEMA,
    generated_at: new Date().toISOString(),
    preferences_hash: mappingPreferencesHash(options.roles, options.extraRoles ?? [], provenance),
    available_agents,
    resolved_roles,
    diagnostics,
    ...(provenance.source !== undefined ? { source: provenance.source } : {}),
    ...(provenance.config_path !== undefined ? { config_path: provenance.config_path } : {}),
    ...(provenance.config_hash !== undefined ? { config_hash: provenance.config_hash } : {}),
    ...(provenance.config_version !== undefined ? { config_version: provenance.config_version } : {}),
    provider_discovery_hash: hashValue([...available_agents].sort((left, right) => left.localeCompare(right))),
    unresolved_roles: unresolved_roles.sort((left, right) => left.localeCompare(right)),
    provenance,
  };
}

function isDiagnostic(value: unknown): value is AgentMappingDiagnostic {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const diagnostic = value as Partial<AgentMappingDiagnostic>;
  const keys = Object.keys(value);
  if (keys.some((key) => !["requested", "candidates", "resolved", "status"].includes(key))) return false;
  return typeof diagnostic.requested === "string"
    && Array.isArray(diagnostic.candidates)
    && diagnostic.candidates.length <= MAPPING_MAX_ARRAY
    && diagnostic.candidates.every(candidate => Boolean(normalizedName(candidate)))
    && (diagnostic.status === "preferred" || diagnostic.status === "fallback" || diagnostic.status === "unavailable")
    && (diagnostic.resolved === undefined || Boolean(normalizedName(diagnostic.resolved)));
}

export type AgentMappingStateValidation =
  | { ok: true; mapping: AgentMappingState }
  | { ok: false; error: string };

/**
 * The one complete runtime validator for an `AgentMappingState`. Beyond the
 * outer structural shape it enforces the semantic closure a malicious caller
 * could otherwise forge: every diagnostic role is exactly resolved or
 * unresolved, resolved agents are in the discovered inventory and equal the
 * first eligible candidate, and requested/resolved/status fields agree.
 * Trusted in-memory handoffs and persisted mapping boundaries share this
 * single gate, so nothing can look valid from the outside while redirecting a
 * role to an agent or candidate that the mapping does not authorize.
 */
export function validateAgentMappingState(value: unknown): AgentMappingStateValidation {
  if (!value || typeof value !== "object" || Array.isArray(value)) return { ok: false, error: "mapping is not an object" };
  if (!boundedMappingJson(value)) return { ok: false, error: "mapping exceeds bounded JSON limits" };
  const mapping = value as Partial<AgentMappingState>;
  const allowedKeys = new Set(["schema", "generated_at", "preferences_hash", "available_agents", "resolved_roles", "diagnostics", "unresolved_roles", "source", "config_path", "config_hash", "config_version", "provider_discovery_hash", "provenance"]);
  if (Object.keys(value).some((key) => !allowedKeys.has(key))) return { ok: false, error: "mapping contains unknown keys" };
  if (mapping.schema !== AGENT_MAPPING_SCHEMA) return { ok: false, error: `schema must be ${AGENT_MAPPING_SCHEMA}` };
  if (typeof mapping.generated_at !== "string" || !mapping.generated_at) return { ok: false, error: "generated_at must be a non-empty string" };
  if (typeof mapping.preferences_hash !== "string" || !mapping.preferences_hash) return { ok: false, error: "preferences_hash must be a non-empty string" };
  if (!Array.isArray(mapping.available_agents)
    || mapping.available_agents.length > MAPPING_MAX_ARRAY
    || !mapping.available_agents.every((agent) => normalizedName(agent) === agent)) {
    return { ok: false, error: "available_agents must be a bounded array of normalized non-empty agent names" };
  }
  const available = new Set(mapping.available_agents);
  if (available.size !== mapping.available_agents.length) return { ok: false, error: "available_agents must not contain duplicates" };
  const resolvedRoles = mapping.resolved_roles;
  if (!resolvedRoles || typeof resolvedRoles !== "object" || Array.isArray(resolvedRoles)
    || Object.keys(resolvedRoles).length > MAPPING_MAX_KEYS) return { ok: false, error: "resolved_roles must be a bounded object" };
  for (const [role, agent] of Object.entries(resolvedRoles)) {
    if (normalizedName(role) !== role) return { ok: false, error: `resolved_roles.${role} is not a normalized role name` };
    if (normalizedName(agent) !== agent) return { ok: false, error: `resolved_roles.${role} is not a normalized agent name` };
    if (!available.has(agent)) return { ok: false, error: `resolved_roles.${role} names agent '${agent}' outside available_agents` };
  }
  if (!mapping.diagnostics || typeof mapping.diagnostics !== "object" || Array.isArray(mapping.diagnostics)
    || Object.keys(mapping.diagnostics).length > MAPPING_MAX_KEYS) return { ok: false, error: "diagnostics must be a bounded object" };
  const diagnosticRoles = Object.keys(mapping.diagnostics);
  for (const [role, diagnostic] of Object.entries(mapping.diagnostics)) {
    if (normalizedName(role) !== role || !isDiagnostic(diagnostic)) return { ok: false, error: `diagnostics.${role} is not a well-formed diagnostic` };
    if (normalizedName(diagnostic.requested) !== diagnostic.requested) return { ok: false, error: `diagnostics.${role}.requested is not a normalized role name` };
    const candidates = diagnostic.candidates;
    if (candidates.some((candidate) => normalizedName(candidate) !== candidate)) return { ok: false, error: `diagnostics.${role}.candidates contain an unnormalized agent name` };
    if (new Set(candidates).size !== candidates.length) return { ok: false, error: `diagnostics.${role}.candidates must not contain duplicates` };
    if (diagnostic.resolved !== undefined) {
      if (normalizedName(diagnostic.resolved) !== diagnostic.resolved) return { ok: false, error: `diagnostics.${role}.resolved is not a normalized agent name` };
      if (!available.has(diagnostic.resolved)) return { ok: false, error: `diagnostics.${role} resolves outside available_agents` };
    }
  }
  if (!Array.isArray(mapping.unresolved_roles)
    || mapping.unresolved_roles.length > MAPPING_MAX_ARRAY
    || !mapping.unresolved_roles.every((role) => normalizedName(role) === role)) {
    return { ok: false, error: "unresolved_roles must be a bounded array of normalized role names" };
  }
  if (new Set(mapping.unresolved_roles).size !== mapping.unresolved_roles.length) return { ok: false, error: "unresolved_roles must not contain duplicates" };

  const unresolved = new Set(mapping.unresolved_roles);
  const resolvedRoleNames = Object.keys(resolvedRoles);
  for (const role of mapping.unresolved_roles) {
    if (Object.hasOwn(resolvedRoles, role)) return { ok: false, error: `unresolved_roles names '${role}' which resolved_roles also resolves` };
  }
  const allRoles = new Set([...diagnosticRoles, ...resolvedRoleNames, ...mapping.unresolved_roles]);
  if (allRoles.size !== diagnosticRoles.length
    || diagnosticRoles.some((role) => !allRoles.has(role))
    || resolvedRoleNames.some((role) => !allRoles.has(role))) {
    return { ok: false, error: "diagnostics, resolved_roles, and unresolved_roles must describe the same role closure" };
  }
  for (const role of allRoles) {
    const diagnostic = mapping.diagnostics[role];
    const resolved = Object.hasOwn(resolvedRoles, role) ? resolvedRoles[role] : undefined;
    const isResolved = resolved !== undefined;
    const isUnresolved = unresolved.has(role);
    if (isResolved === isUnresolved) return { ok: false, error: `role '${role}' must be exactly resolved or unresolved` };
    if (diagnostic === undefined) return { ok: false, error: `role '${role}' is missing a diagnostic` };
    if (diagnostic.resolved !== resolved) return { ok: false, error: `diagnostics.${role}.resolved does not match resolved_roles` };
    const firstEligible = diagnostic.candidates.find((candidate) => available.has(candidate));
    if (isResolved) {
      if (firstEligible !== resolved) return { ok: false, error: `resolved_roles.${role} is not the first eligible diagnostic candidate` };
      const expectedStatus = resolved === diagnostic.requested ? "preferred" : "fallback";
      if (diagnostic.status !== expectedStatus) return { ok: false, error: `diagnostics.${role} status must be '${expectedStatus}' for its resolved agent` };
    } else {
      if (diagnostic.status !== "unavailable") return { ok: false, error: `unresolved role '${role}' carries a '${diagnostic.status}' diagnostic` };
      if (firstEligible !== undefined) return { ok: false, error: `unresolved role '${role}' has an eligible diagnostic candidate` };
    }
  }
  if (mapping.source !== undefined && normalizedName(mapping.source) !== mapping.source) return { ok: false, error: "source must be a normalized non-empty name when present" };
  if (mapping.config_path !== undefined && mapping.config_path !== null && typeof mapping.config_path !== "string") return { ok: false, error: "config_path must be a string or null" };
  if (mapping.config_hash !== undefined && typeof mapping.config_hash !== "string") return { ok: false, error: "config_hash must be a string when present" };
  if (mapping.config_version !== undefined && mapping.config_version !== null
    && typeof mapping.config_version !== "string" && typeof mapping.config_version !== "number") return { ok: false, error: "config_version must be a string, number or null" };
  if (mapping.provider_discovery_hash !== undefined && typeof mapping.provider_discovery_hash !== "string") return { ok: false, error: "provider_discovery_hash must be a string when present" };
  if (mapping.provider_discovery_hash !== undefined
    && mapping.provider_discovery_hash !== hashValue([...mapping.available_agents].sort((left, right) => left.localeCompare(right)))) {
    return { ok: false, error: "provider_discovery_hash does not match available_agents" };
  }
  if (mapping.provenance !== undefined && (!mapping.provenance || typeof mapping.provenance !== "object" || Array.isArray(mapping.provenance))) return { ok: false, error: "provenance must be an object when present" };
  return { ok: true, mapping: mapping as AgentMappingState };
}

function serializeAgentMapping(mapping: AgentMappingState): Buffer {
  const validated = validateAgentMappingState(mapping);
  if (!validated.ok) {
    throw new AgentMappingWriteError("invalid", `refusing to persist malformed agent mapping: ${validated.error}`);
  }
  const content = `${canonicalString(validated.mapping)}\n`;
  const bytes = Buffer.from(content, "utf8");
  if (bytes.byteLength > AGENT_MAPPING_MAX_BYTES) {
    throw new AgentMappingWriteError(
      "limit",
      `agent mapping is ${bytes.byteLength} UTF-8 bytes; maximum is ${AGENT_MAPPING_MAX_BYTES}`,
      bytes.byteLength,
    );
  }
  return bytes;
}

function publicationReceiptMatches(root: PinnedProjectRoot, receipt: AgentMappingPublicationReceipt): boolean {
  if (!root.isStable()
    || root.canonical_root !== receipt.canonical_root
    || root.dev !== receipt.root_dev
    || root.ino !== receipt.root_ino
    || receipt.relative_path !== MAPPING_FILE) return false;
  try {
    const observed = root.readFile(receipt.relative_path, { maxBytes: AGENT_MAPPING_MAX_BYTES });
    return observed.dev === receipt.dev
      && observed.ino === receipt.ino
      && observed.size === receipt.size
      && hashText(Buffer.from(observed.bytes).toString("utf8")) === receipt.sha256;
  } catch {
    return false;
  }
}

function mappingSemanticProjection(mapping: AgentMappingState): unknown {
  const { generated_at: _generatedAt, ...semantic } = mapping;
  return semantic;
}

function sameMappingSemantics(left: AgentMappingState, right: AgentMappingState): boolean {
  return canonicalString(mappingSemanticProjection(left)) === canonicalString(mappingSemanticProjection(right));
}

function persistedFallbackPreferences(provenance: MappingPreferencesProvenance): {
  fallbackChains?: Record<string, readonly string[]>;
  genericFallback?: string | null;
  genericFallbackRoles?: readonly string[];
} | undefined {
  const result: {
    fallbackChains?: Record<string, readonly string[]>;
    genericFallback?: string | null;
    genericFallbackRoles?: readonly string[];
  } = {};
  const rawChains = provenance.fallback_chains;
  if (rawChains !== undefined) {
    if (!rawChains || typeof rawChains !== "object" || Array.isArray(rawChains)) return undefined;
    const chains: Record<string, readonly string[]> = {};
    for (const [role, rawCandidates] of Object.entries(rawChains)) {
      if (normalizedName(role) !== role || !Array.isArray(rawCandidates)
        || rawCandidates.some((candidate) => normalizedName(candidate) !== candidate)) return undefined;
      setMappingOwn(chains, role, [...rawCandidates]);
    }
    result.fallbackChains = chains;
  }
  if (provenance.generic_fallback !== undefined) {
    if (provenance.generic_fallback !== null && normalizedName(provenance.generic_fallback) !== provenance.generic_fallback) return undefined;
    result.genericFallback = provenance.generic_fallback;
  }
  if (provenance.generic_fallback_roles !== undefined) {
    if (!Array.isArray(provenance.generic_fallback_roles)
      || provenance.generic_fallback_roles.some((role) => normalizedName(role) !== role)) return undefined;
    result.genericFallbackRoles = [...provenance.generic_fallback_roles];
  }
  return result;
}

function recomputeExpectedMapping(
  parsed: AgentMappingState,
  expected: AgentMappingExpectation,
): AgentMappingState | undefined {
  if (!parsed.provenance || typeof parsed.provenance !== "object" || Array.isArray(parsed.provenance)) return undefined;
  const provenance = parsed.provenance;
  const providerDiscovery = provenance.provider_discovery;
  if (!Array.isArray(providerDiscovery)
    || providerDiscovery.some((agent) => normalizedName(agent) !== agent)
    || providerDiscovery.length !== parsed.available_agents.length
    || providerDiscovery.some((agent, index) => agent !== parsed.available_agents[index])) return undefined;
  const fallback = persistedFallbackPreferences(provenance);
  if (!fallback) return undefined;
  const options: AgentMappingOptions = {
    roles: expected.roles!,
    availableAgents: parsed.available_agents,
    extraRoles: expected.extraRoles ?? [],
    scope_map: expected.scope_map,
    flags: expected.flags,
    roster: expected.roster,
    config_path: expected.config_path,
    config_source: expected.config_source,
    config_hash: expected.config_hash,
    config_version: expected.config_version,
    config_provenance: expected.config_provenance,
    ...(parsed.source !== undefined ? { source: parsed.source } : {}),
    ...(fallback.fallbackChains !== undefined ? { fallbackChains: fallback.fallbackChains } : {}),
    ...(fallback.genericFallback !== undefined ? { genericFallback: fallback.genericFallback } : {}),
    ...(fallback.genericFallbackRoles !== undefined ? { genericFallbackRoles: fallback.genericFallbackRoles } : {}),
  };
  return buildAgentMapping(options);
}

function configFingerprint(cwd: string, borrowedRoot?: PinnedProjectRoot): { path: string | null; hash: string | null } {
  const root = borrowedRoot ?? PinnedProjectRoot.open(cwd);
  if (!root) return { path: null, hash: null };
  const ownsRoot = borrowedRoot === undefined;
  const candidates = [
    { relative: ".omp/team.config.json", sourcePath: join(root.canonical_root, ".omp", "team.config.json") },
    { relative: ".claude/team.config.json", sourcePath: join(root.canonical_root, ".claude", "team.config.json") },
  ];
  try {
    for (const candidate of candidates) {
      let exists = false;
      try {
        exists = root.pathEntryExists(candidate.relative);
      } catch {
        return { path: candidate.sourcePath, hash: null };
      }
      if (!exists) continue;
      const raw = readPinnedUtf8(root, candidate.relative);
      return { path: candidate.sourcePath, hash: raw === null ? null : hashText(raw) };
    }
    return { path: null, hash: null };
  } finally {
    if (ownsRoot) root.close();
  }
}

function assertSafeMappingRoot(cwd: string): string {
  if (typeof cwd !== "string" || !cwd || !isAbsolute(cwd) || cwd.split(/[\\/]+/u).includes("..")) {
    throw new Error("mapping cwd must be an absolute traversal-free project root");
  }
  const root = resolve(cwd);
  if (!existsSync(root) || !lstatSync(root).isDirectory()) throw new Error(`mapping cwd does not exist: ${root}`);
  return realpathSync(root);
}

function assertSafeMappingPath(root: string, path: string): void {
  const rel = relative(root, path);
  if (!rel || isAbsolute(rel) || rel === ".." || rel.startsWith(`..${sep}`)) throw new Error("agent mapping path escapes project cwd");
  let cursor = root;
  for (const segment of rel.split(sep)) {
    cursor = join(cursor, segment);
    if (existsSync(cursor) && lstatSync(cursor).isSymbolicLink()) throw new Error(`agent mapping path contains symlink: ${cursor}`);
  }
}

export function agentMappingPath(cwd: string): string {
  const root = assertSafeMappingRoot(cwd);
  const path = resolve(root, MAPPING_FILE);
  assertSafeMappingPath(root, path);
  return path;
}
export function readAgentMapping(cwd: string, expected?: AgentMappingExpectation, borrowedRoot?: PinnedProjectRoot): AgentMappingState | undefined {
  let path: string;
  let root: string;
  try {
    if (borrowedRoot) {
      root = borrowedRoot.canonical_root;
      path = resolve(root, MAPPING_FILE);
    } else {
      root = assertSafeMappingRoot(cwd);
      path = agentMappingPath(root);
    }
  } catch {
    return undefined;
  }
  const pinnedRoot = borrowedRoot ?? PinnedProjectRoot.open(root);
  if (!pinnedRoot) return undefined;
  const ownsRoot = borrowedRoot === undefined;
  try {
    if (!pinnedRoot.pathEntryExists(MAPPING_FILE)) return undefined;
    const rawText = readPinnedUtf8(pinnedRoot, MAPPING_FILE);
    if (rawText === null) return undefined;
    const raw: unknown = JSON.parse(rawText);
    const validated = validateAgentMappingState(raw);
    if (!validated.ok) return undefined;
    const parsed = validated.mapping;
    const fingerprint = configFingerprint(root, pinnedRoot);
    if (parsed.config_path !== undefined && parsed.config_path !== fingerprint.path) return undefined;
    if (parsed.config_hash && fingerprint.hash && parsed.config_hash !== fingerprint.hash) return undefined;
    if (parsed.provider_discovery_hash && parsed.provider_discovery_hash !== hashValue([...parsed.available_agents].sort((left, right) => left.localeCompare(right)))) return undefined;
    if (expected?.preferences_hash && parsed.preferences_hash !== expected.preferences_hash) return undefined;
    if (expected?.roles) {
      const recomputed = recomputeExpectedMapping(parsed, expected);
      if (!recomputed || !sameMappingSemantics(parsed, recomputed)) return undefined;
    }
    if (expected?.availableAgents && uniqueNames(expected.availableAgents).sort().join("\u0000") !== [...parsed.available_agents].sort().join("\u0000")) return undefined;
    if (expected?.source !== undefined && (parsed.source ?? parsed.provenance?.source) !== expected.source) return undefined;
    if (expected?.config_source !== undefined && parsed.provenance?.config_source !== expected.config_source) return undefined;
    if (expected?.config_hash !== undefined && (parsed.config_hash ?? parsed.provenance?.config_hash) !== expected.config_hash) return undefined;
    if (expected?.config_path !== undefined && (parsed.config_path ?? parsed.provenance?.config_path) !== expected.config_path) return undefined;
    if (expected?.config_version !== undefined && (parsed.config_version ?? parsed.provenance?.config_version) !== expected.config_version) return undefined;
    return parsed;
  } catch {
    return undefined;
  } finally {
    if (ownsRoot) pinnedRoot.close();
  }
}

/** Return the current engine-published map for a pinned root, never a parsed disk fallback. */
export function latestPublishedAgentMapping(borrowedRoot: PinnedProjectRoot): AgentMappingState | null {
  const mapping = latestPublishedMappings.get(publicationRootKey(borrowedRoot));
  const receipt = mapping ? mappingPublicationReceipts.get(mapping as object) : undefined;
  if (!mapping || !receipt || !publicationReceiptMatches(borrowedRoot, receipt)) return null;
  return mapping;
}

/** Capture the exact anchored publication receipt for this engine-written map. */
export function agentMappingPublicationReceipt(mapping: AgentMappingState, borrowedRoot: PinnedProjectRoot): AgentMappingPublicationReceipt | null {
  const receipt = mappingPublicationReceipts.get(mapping as object);
  if (!receipt || !publicationReceiptMatches(borrowedRoot, receipt)) return null;
  return { ...receipt };
}

/** Verify an anchored mapping publication receipt against a pinned read. */
export function verifyAgentMappingPublicationReceipt(
  borrowedRoot: PinnedProjectRoot,
  receipt: AgentMappingPublicationReceipt,
): boolean {
  return publicationReceiptMatches(borrowedRoot, receipt);
}

/** Persist the generated map outside project configuration and atomically. */
export function writeAgentMapping(cwd: string, mapping: AgentMappingState, borrowedRoot?: PinnedProjectRoot): string {
  const content = serializeAgentMapping(mapping);
  const root = borrowedRoot?.canonical_root ?? assertSafeMappingRoot(cwd);
  const path = borrowedRoot ? resolve(root, MAPPING_FILE) : agentMappingPath(root);
  const pinnedRoot = borrowedRoot ?? PinnedProjectRoot.open(root);
  if (!pinnedRoot) throw new Error("agent mapping root could not be opened and pinned safely");
  const ownsRoot = borrowedRoot === undefined;
  try {
    if (!pinnedRoot.isStable()) throw new Error("agent mapping root changed before publication");
    const receipt: PinnedRootWriteReceipt = pinnedRoot.writeAtomicWithReceipt(MAPPING_FILE, content);
    mappingPublicationReceipts.set(mapping as object, {
      canonical_root: pinnedRoot.canonical_root,
      root_dev: pinnedRoot.dev,
      root_ino: pinnedRoot.ino,
      relative_path: receipt.relative_path,
      dev: receipt.descriptor.dev,
      ino: receipt.descriptor.ino,
      size: receipt.descriptor.size,
      sha256: receipt.descriptor.sha256,
    });
    const key = publicationRootKey(pinnedRoot);
    latestPublishedMappings.delete(key);
    latestPublishedMappings.set(key, mapping);
    while (latestPublishedMappings.size > MAX_LATEST_PUBLISHED_MAPPINGS) {
      const oldest = latestPublishedMappings.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      latestPublishedMappings.delete(oldest);
    }
    return path;
  } finally {
    if (ownsRoot) pinnedRoot.close();
  }
}
