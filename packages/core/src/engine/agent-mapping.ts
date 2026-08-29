import { createHash, randomUUID } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

export const AGENT_MAPPING_SCHEMA = 1 as const;
export const DEFAULT_GENERIC_AGENT = "task";
const MAX_NAME_LENGTH = 128;
const MAPPING_FILE = join(".work-state", "runtime", "agent-mapping.json");

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
    diagnostics[key] = { requested, candidates, ...(resolved ? { resolved } : {}), status };
    if (resolved) resolved_roles[key] = resolved;
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
    unresolved_roles,
    ...(provenance.source !== undefined ? { source: provenance.source } : {}),
    ...(provenance.config_path !== undefined ? { config_path: provenance.config_path } : {}),
    ...(provenance.config_hash !== undefined ? { config_hash: provenance.config_hash } : {}),
    ...(provenance.config_version !== undefined ? { config_version: provenance.config_version } : {}),
    provider_discovery_hash: hashValue([...available_agents].sort((left, right) => left.localeCompare(right))),
    provenance,
  };
}

function isDiagnostic(value: unknown): value is AgentMappingDiagnostic {
  if (!value || typeof value !== "object") return false;
  const diagnostic = value as Partial<AgentMappingDiagnostic>;
  return typeof diagnostic.requested === "string"
    && Array.isArray(diagnostic.candidates)
    && diagnostic.candidates.every(candidate => Boolean(normalizedName(candidate)))
    && (diagnostic.status === "preferred" || diagnostic.status === "fallback" || diagnostic.status === "unavailable")
    && (diagnostic.resolved === undefined || Boolean(normalizedName(diagnostic.resolved)));
}

export type AgentMappingStateValidation =
  | { ok: true; mapping: AgentMappingState }
  | { ok: false; error: string };

/**
 * The one complete runtime validator for an `AgentMappingState`. Beyond the
 * outer structural shape it enforces the semantic invariants a malicious
 * caller could otherwise forge: every resolved role names a non-empty agent
 * that is present in `available_agents`, diagnostics are well-formed with
 * resolved agents inside the live inventory, and `unresolved_roles` stays
 * disjoint from `resolved_roles` with matching diagnostic status. Trusted
 * in-memory handoffs and the persisted mapping boundaries (read and write)
 * share this single gate, so nothing can look valid from the outside while
 * resolving roles to agents that were never discovered.
 */
export function validateAgentMappingState(value: unknown): AgentMappingStateValidation {
  if (!value || typeof value !== "object" || Array.isArray(value)) return { ok: false, error: "mapping is not an object" };
  const mapping = value as Partial<AgentMappingState>;
  if (mapping.schema !== AGENT_MAPPING_SCHEMA) return { ok: false, error: `schema must be ${AGENT_MAPPING_SCHEMA}` };
  if (typeof mapping.generated_at !== "string" || !mapping.generated_at) return { ok: false, error: "generated_at must be a non-empty string" };
  if (typeof mapping.preferences_hash !== "string" || !mapping.preferences_hash) return { ok: false, error: "preferences_hash must be a non-empty string" };
  if (!Array.isArray(mapping.available_agents) || !mapping.available_agents.every((agent) => Boolean(normalizedName(agent)))) {
    return { ok: false, error: "available_agents must be an array of non-empty agent names" };
  }
  const available = new Set(mapping.available_agents);
  if (available.size !== mapping.available_agents.length) return { ok: false, error: "available_agents must not contain duplicates" };
  const resolvedRoles = mapping.resolved_roles;
  if (!resolvedRoles || typeof resolvedRoles !== "object" || Array.isArray(resolvedRoles)) return { ok: false, error: "resolved_roles must be an object" };
  for (const [role, agent] of Object.entries(resolvedRoles)) {
    if (!normalizedName(role)) return { ok: false, error: `resolved_roles.${role} is not a non-empty role name` };
    if (!normalizedName(agent)) return { ok: false, error: `resolved_roles.${role} is not a non-empty agent name` };
    if (!available.has(agent)) return { ok: false, error: `resolved_roles.${role} names agent '${agent}' outside available_agents` };
  }
  if (!mapping.diagnostics || typeof mapping.diagnostics !== "object" || Array.isArray(mapping.diagnostics)) return { ok: false, error: "diagnostics must be an object" };
  for (const [role, diagnostic] of Object.entries(mapping.diagnostics)) {
    if (!normalizedName(role) || !isDiagnostic(diagnostic)) return { ok: false, error: `diagnostics.${role} is not a well-formed diagnostic` };
    if (diagnostic.resolved !== undefined && !available.has(diagnostic.resolved)) return { ok: false, error: `diagnostics.${role} resolves outside available_agents` };
  }
  if (!Array.isArray(mapping.unresolved_roles) || !mapping.unresolved_roles.every((role) => Boolean(normalizedName(role)))) {
    return { ok: false, error: "unresolved_roles must be an array of non-empty role names" };
  }
  for (const role of mapping.unresolved_roles) {
    if (role in resolvedRoles) return { ok: false, error: `unresolved_roles names '${role}' which resolved_roles also resolves` };
    const diagnostic: AgentMappingDiagnostic | undefined = mapping.diagnostics[role];
    if (diagnostic && diagnostic.status !== "unavailable") return { ok: false, error: `unresolved role '${role}' carries a '${diagnostic.status}' diagnostic` };
  }
  for (const role of Object.keys(resolvedRoles)) {
    if (mapping.diagnostics[role]?.status === "unavailable") return { ok: false, error: `resolved role '${role}' carries an 'unavailable' diagnostic` };
  }
  if (mapping.source !== undefined && !normalizedName(mapping.source)) return { ok: false, error: "source must be a non-empty name when present" };
  if (mapping.config_path !== undefined && mapping.config_path !== null && typeof mapping.config_path !== "string") return { ok: false, error: "config_path must be a string or null" };
  if (mapping.config_hash !== undefined && typeof mapping.config_hash !== "string") return { ok: false, error: "config_hash must be a string when present" };
  if (mapping.config_version !== undefined && mapping.config_version !== null
    && typeof mapping.config_version !== "string" && typeof mapping.config_version !== "number") return { ok: false, error: "config_version must be a string, number or null" };
  if (mapping.provider_discovery_hash !== undefined && typeof mapping.provider_discovery_hash !== "string") return { ok: false, error: "provider_discovery_hash must be a string when present" };
  if (mapping.provenance !== undefined && (!mapping.provenance || typeof mapping.provenance !== "object" || Array.isArray(mapping.provenance))) return { ok: false, error: "provenance must be an object when present" };
  return { ok: true, mapping: mapping as AgentMappingState };
}

function configFingerprint(cwd: string): { path: string | null; hash: string | null } {
  const candidates = [join(cwd, ".omp", "team.config.json"), join(cwd, ".claude", "team.config.json")];
  for (const path of candidates) {
    if (!existsSync(path)) continue;
    try {
      if (lstatSync(path).isSymbolicLink()) return { path, hash: null };
      return {
        path,
        hash: hashText(readFileSync(path, "utf8")),
      };
    } catch {
      return { path, hash: null };
    }
  }
  return { path: null, hash: null };
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

export function readAgentMapping(cwd: string, expected?: AgentMappingExpectation): AgentMappingState | undefined {
  let path: string;
  let root: string;
  try {
    root = assertSafeMappingRoot(cwd);
    path = agentMappingPath(root);
  } catch {
    return undefined;
  }
  if (!existsSync(path)) return undefined;
  try {
    if (lstatSync(path).isSymbolicLink() || !lstatSync(path).isFile()) return undefined;
    const raw: unknown = JSON.parse(readFileSync(path, "utf8"));
    const validated = validateAgentMappingState(raw);
    if (!validated.ok) return undefined;
    const parsed = validated.mapping;
    const fingerprint = configFingerprint(root);
    if (parsed.config_path !== undefined && parsed.config_path !== fingerprint.path) return undefined;
    if (parsed.config_hash && fingerprint.hash && parsed.config_hash !== fingerprint.hash) return undefined;
    if (parsed.provider_discovery_hash && parsed.provider_discovery_hash !== hashValue([...parsed.available_agents].sort((left, right) => left.localeCompare(right)))) return undefined;
    if (expected?.preferences_hash && parsed.preferences_hash !== expected.preferences_hash) return undefined;
    if (expected?.roles) {
      const expectedHash = mappingPreferencesHash(expected.roles, expected.extraRoles ?? [], {
        ...expected,
        provider_discovery: expected.provider_discovery ?? expected.availableAgents ?? parsed.available_agents,
      });
      if (parsed.preferences_hash !== expectedHash) return undefined;
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
  }
}

/** Persist the generated map outside project configuration and atomically. */
export function writeAgentMapping(cwd: string, mapping: AgentMappingState): string {
  const root = assertSafeMappingRoot(cwd);
  const path = agentMappingPath(root);
  if (!validateAgentMappingState(mapping).ok) throw new Error("refusing to persist malformed agent mapping");
  const directory = dirname(path);
  mkdirSync(directory, { recursive: true });
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(mapping, null, 2)}\n`, "utf8");
  renameSync(temporary, path);
  return path;
}
