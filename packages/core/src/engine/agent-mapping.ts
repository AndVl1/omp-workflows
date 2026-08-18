import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

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

export interface AgentMappingState {
  schema: typeof AGENT_MAPPING_SCHEMA;
  generated_at: string;
  preferences_hash: string;
  available_agents: string[];
  resolved_roles: Record<string, string>;
  diagnostics: Record<string, AgentMappingDiagnostic>;
  unresolved_roles: string[];
}

export interface AgentMappingOptions {
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

function normalizedName(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim();
  if (!normalized || normalized.length > MAX_NAME_LENGTH || /[\r\n]/.test(normalized)) return undefined;
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

function canonicalPreferences(roles: Record<string, string>, extraRoles: readonly string[]): string {
  const normalizedRoles = Object.entries(roles)
    .map(([role, agent]) => [normalizedName(role), normalizedName(agent)] as const)
    .filter((entry): entry is [string, string] => Boolean(entry[0] && entry[1]))
    .sort(([left], [right]) => left.localeCompare(right));
  const normalizedExtraRoles = uniqueNames(extraRoles).sort((left, right) => left.localeCompare(right));
  return JSON.stringify({ roles: normalizedRoles, extraRoles: normalizedExtraRoles });
}

export function mappingPreferencesHash(roles: Record<string, string>, extraRoles: readonly string[] = []): string {
  return createHash("sha256").update(canonicalPreferences(roles, extraRoles)).digest("hex");
}

function candidateKeys(options: AgentMappingOptions): string[] {
  const keys = [
    ...Object.keys(options.roles),
    ...Object.values(options.roles),
    ...Object.keys(options.fallbackChains ?? {}),
    ...Object.values(options.fallbackChains ?? {}).flat(),
    ...(options.extraRoles ?? []),
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

  return {
    schema: AGENT_MAPPING_SCHEMA,
    generated_at: new Date().toISOString(),
    preferences_hash: mappingPreferencesHash(options.roles, options.extraRoles ?? []),
    available_agents,
    resolved_roles,
    diagnostics,
    unresolved_roles,
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

function isMappingState(value: unknown): value is AgentMappingState {
  if (!value || typeof value !== "object") return false;
  const mapping = value as Partial<AgentMappingState>;
  if (mapping.schema !== AGENT_MAPPING_SCHEMA || typeof mapping.generated_at !== "string" || typeof mapping.preferences_hash !== "string") return false;
  if (!Array.isArray(mapping.available_agents) || !mapping.available_agents.every(agent => Boolean(normalizedName(agent)))) return false;
  const available = new Set(mapping.available_agents);
  const resolvedRoles = mapping.resolved_roles;
  if (!resolvedRoles || typeof resolvedRoles !== "object" || Array.isArray(resolvedRoles)) return false;
  if (!Object.entries(resolvedRoles).every(([role, agent]) => Boolean(normalizedName(role)) && Boolean(normalizedName(agent)) && available.has(agent as string))) return false;
  if (!mapping.diagnostics || typeof mapping.diagnostics !== "object" || Array.isArray(mapping.diagnostics)) return false;
  if (!Object.entries(mapping.diagnostics).every(([role, diagnostic]) => {
    if (!Boolean(normalizedName(role)) || !isDiagnostic(diagnostic)) return false;
    return diagnostic.resolved === undefined || available.has(diagnostic.resolved);
  })) return false;
  if (!Array.isArray(mapping.unresolved_roles) || !mapping.unresolved_roles.every(role => Boolean(normalizedName(role)))) return false;
  if (mapping.unresolved_roles.some(role => role in resolvedRoles)) return false;
  return true;
}

export function agentMappingPath(cwd: string): string {
  return resolve(cwd, MAPPING_FILE);
}

export function readAgentMapping(cwd: string): AgentMappingState | undefined {
  const path = agentMappingPath(cwd);
  if (!existsSync(path)) return undefined;
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    return isMappingState(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/** Persist the generated map outside project configuration and atomically. */
export function writeAgentMapping(cwd: string, mapping: AgentMappingState): string {
  const path = agentMappingPath(cwd);
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(mapping, null, 2)}\n`, "utf8");
  renameSync(temporary, path);
  return path;
}
