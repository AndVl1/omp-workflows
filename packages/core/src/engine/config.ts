/**
 * Resolve the project runtime configuration.
 *
 * The first existing candidate wins (`.omp` before legacy `.claude`).  A
 * malformed first candidate is a visible diagnostic and never falls through
 * to the legacy file.  The resolved value remains RoleConfig-compatible for
 * existing engine callers while carrying its provenance and preserved
 * metadata for command/mapping readers.
 */

import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  mappingPreferencesHash,
  readAgentMapping,
  type AgentMappingDiagnostic,
  type MappingPreferencesProvenance,
} from "./agent-mapping.js";
import {
  DEFAULT_FLAGS,
  DEFAULT_ROLES,
  DEFAULT_SCOPE_MAP,
  type RoleConfig,
} from "./types.js";

export type ConfigSource = "omp" | "legacy" | "defaults";
export type ConfigDiagnosticCode = "malformed" | "invalid_shape" | "path_invalid";

export interface ConfigDiagnostic {
  code: ConfigDiagnosticCode;
  path: string;
  message: string;
}

export interface ConfigProvenance {
  cwd: string;
  source: ConfigSource;
  path: string | null;
  hash: string;
  version: string | number | null;
  writer: string | null;
  provenance: Record<string, unknown> | null;
}

export type ResolvedConfig = RoleConfig & {
  config_path: string | null;
  config_source: ConfigSource;
  config_hash: string;
  config_version: string | number | null;
  config_writer: string | null;
  config_provenance: ConfigProvenance;
  diagnostics: ConfigDiagnostic[];
  diagnostic?: ConfigDiagnostic;
  /** Unknown top-level fields are retained for consumers that need them. */
  unknown_metadata: Record<string, unknown>;
};

type UnknownObject = Record<string, unknown>;

const CONFIG_KEYS: Record<string, true> = {
  roles: true,
  roster_overrides: true,
  scope_map: true,
  flags: true,
  design_system: true,
  agent_mapping: true,
  metadata: true,
  version: true,
  config_version: true,
  writer: true,
  provenance: true,
};

function isObject(value: unknown): value is UnknownObject {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function hashText(raw: string): string {
  return createHash("sha256").update(raw).digest("hex");
}

function hashDefaults(config: Pick<RoleConfig, "roles" | "roster_overrides" | "scope_map" | "flags" | "design_system">): string {
  return hashText(JSON.stringify({
    roles: config.roles,
    roster_overrides: config.roster_overrides,
    scope_map: config.scope_map,
    flags: config.flags,
    design_system: config.design_system,
  }));
}

function addDiagnostic(
  diagnostics: ConfigDiagnostic[],
  code: ConfigDiagnosticCode,
  path: string,
  message: string,
): void {
  diagnostics.push({ code, path, message });
}

function readStringMap(
  value: unknown,
  fallback: Record<string, string>,
  diagnostics: ConfigDiagnostic[],
  path: string,
): Record<string, string> {
  if (value === undefined) return { ...fallback };
  if (!isObject(value)) {
    addDiagnostic(diagnostics, "invalid_shape", path, "expected an object of string values");
    return { ...fallback };
  }
  const valid: Record<string, string> = {};
  for (const [key, candidate] of Object.entries(value)) {
    if (typeof candidate === "string" && candidate.trim()) valid[key] = candidate;
    else addDiagnostic(diagnostics, "invalid_shape", `${path}.${key}`, "expected a non-empty string");
  }
  return { ...fallback, ...valid };
}

function readScopeMap(
  value: unknown,
  fallback: RoleConfig["scope_map"],
  diagnostics: ConfigDiagnostic[],
): RoleConfig["scope_map"] {
  if (value === undefined) return fallback.map(entry => ({ ...entry, glob: [...entry.glob] }));
  if (!Array.isArray(value)) {
    addDiagnostic(diagnostics, "invalid_shape", "scope_map", "expected an array of scope entries");
    return fallback.map(entry => ({ ...entry, glob: [...entry.glob] }));
  }
  const valid: RoleConfig["scope_map"] = [];
  for (const [index, entry] of value.entries()) {
    if (!isObject(entry) || typeof entry.scope !== "string" || typeof entry.dev_agent !== "string" || !Array.isArray(entry.glob)
      || !entry.glob.every(pattern => typeof pattern === "string" && pattern.length > 0)) {
      addDiagnostic(diagnostics, "invalid_shape", `scope_map[${index}]`, "expected { glob: string[], scope: string, dev_agent: string }");
      continue;
    }
    valid.push({
      glob: [...entry.glob] as string[],
      scope: entry.scope,
      dev_agent: entry.dev_agent,
      ...((typeof entry.runtime_class === "string" || typeof entry.runtime_class === "boolean") ? { runtime_class: entry.runtime_class } : {}),
    } as RoleConfig["scope_map"][number]);
  }
  return valid.length > 0 ? valid : fallback.map(entry => ({ ...entry, glob: [...entry.glob] }));
}

function readFlags(
  value: unknown,
  fallback: RoleConfig["flags"],
  diagnostics: ConfigDiagnostic[],
): RoleConfig["flags"] {
  if (value === undefined) return Object.fromEntries(Object.entries(fallback).map(([key, patterns]) => [key, [...patterns]]));
  if (!isObject(value)) {
    addDiagnostic(diagnostics, "invalid_shape", "flags", "expected an object of string arrays");
    return Object.fromEntries(Object.entries(fallback).map(([key, patterns]) => [key, [...patterns]]));
  }
  const result: RoleConfig["flags"] = Object.fromEntries(Object.entries(fallback).map(([key, patterns]) => [key, [...patterns]]));
  for (const [key, candidate] of Object.entries(value)) {
    if (!Array.isArray(candidate) || !candidate.every(pattern => typeof pattern === "string" && pattern.length > 0)) {
      addDiagnostic(diagnostics, "invalid_shape", `flags.${key}`, "expected a non-empty string pattern array");
      continue;
    }
    result[key] = [...candidate] as string[];
  }
  return result;
}

function readRosterOverrides(value: unknown, diagnostics: ConfigDiagnostic[]): RoleConfig["roster_overrides"] {
  if (value === undefined) return {};
  if (!isObject(value)) {
    addDiagnostic(diagnostics, "invalid_shape", "roster_overrides", "expected an object keyed by stage");
    return {};
  }
  const result: RoleConfig["roster_overrides"] = {};
  for (const [stage, raw] of Object.entries(value)) {
    if (!isObject(raw)) {
      addDiagnostic(diagnostics, "invalid_shape", `roster_overrides.${stage}`, "expected an object");
      continue;
    }
    const normalized: RoleConfig["roster_overrides"][string] = {};
    for (const key of ["replace", "add", "remove"] as const) {
      const candidate = raw[key];
      if (candidate === undefined) continue;
      if (!Array.isArray(candidate) || !candidate.every(role => typeof role === "string" && role.length > 0)) {
        addDiagnostic(diagnostics, "invalid_shape", `roster_overrides.${stage}.${key}`, "expected a string array");
        continue;
      }
      normalized[key] = [...candidate] as string[];
    }
    result[stage] = normalized;
  }
  return result;
}

function mappingInputs(
  config: {
    roles: Record<string, string>;
    scope_map: RoleConfig["scope_map"];
    flags: RoleConfig["flags"];
    roster_overrides: RoleConfig["roster_overrides"];
    config_path: string | null;
    config_source: ConfigSource;
    config_hash: string;
    config_version: string | number | null;
    config_provenance: ConfigProvenance;
  },
  providerDiscovery: readonly string[] | undefined,
  source: string | undefined,
  prior?: MappingPreferencesProvenance,
): MappingPreferencesProvenance {
  return {
    scope_map: config.scope_map,
    flags: config.flags,
    roster: config.roster_overrides,
    config_path: config.config_path,
    config_source: config.config_source,
    config_hash: config.config_hash,
    config_version: config.config_version,
    config_provenance: config.config_provenance,
    provider_discovery: providerDiscovery,
    source,
    fallback_chains: prior?.fallback_chains,
    generic_fallback: prior?.generic_fallback,
    generic_fallback_roles: prior?.generic_fallback_roles,
  };
}

export function resolveConfig(cwd: string): ResolvedConfig {
  const resolvedCwd = resolve(cwd);
  const effectiveCwd = existsSync(resolvedCwd) ? realpathSync(resolvedCwd) : resolvedCwd;
  const candidates: Array<{ source: Exclude<ConfigSource, "defaults">; path: string }> = [
    { source: "omp", path: join(effectiveCwd, ".omp", "team.config.json") },
    { source: "legacy", path: join(effectiveCwd, ".claude", "team.config.json") },
  ];
  const diagnostics: ConfigDiagnostic[] = [];
  let selected: { source: Exclude<ConfigSource, "defaults">; path: string; document: UnknownObject } | undefined;
  let selectedPath: string | null = null;
  let selectedSource: ConfigSource = "defaults";
  let selectedHash: string | undefined;
  for (const candidate of candidates) {
    if (!existsSync(candidate.path)) continue;
    selectedPath = candidate.path;
    selectedSource = candidate.source;
    if (lstatSync(candidate.path).isSymbolicLink()) {
      addDiagnostic(diagnostics, "path_invalid", candidate.path, "config candidate is a symlink; refusing path escape");
      break;
    }
    let raw: string;
    try {
      raw = readFileSync(candidate.path, "utf8");
    } catch (error) {
      addDiagnostic(diagnostics, "path_invalid", candidate.path, `config candidate is unreadable: ${String(error)}`);
      break;
    }
    selectedHash = hashText(raw);
    try {
      const parsed: unknown = JSON.parse(raw);
      if (!isObject(parsed)) throw new Error("root must be an object");
      selected = { ...candidate, document: parsed };
    } catch (error) {
      addDiagnostic(
        diagnostics,
        "malformed",
        candidate.path,
        `config JSON is malformed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    break;
  }

  const document = selected?.document ?? {};
  const roles = readStringMap(document.roles, DEFAULT_ROLES, diagnostics, "roles");
  const scope_map = readScopeMap(document.scope_map, DEFAULT_SCOPE_MAP, diagnostics);
  const flags = readFlags(document.flags, DEFAULT_FLAGS, diagnostics);
  const roster_overrides = readRosterOverrides(document.roster_overrides, diagnostics);
  const design_system = document.design_system === undefined || document.design_system === null
    ? null
    : typeof document.design_system === "string"
      ? document.design_system
      : (addDiagnostic(diagnostics, "invalid_shape", "design_system", "expected a string or null"), null);
  const configHash = selectedHash ?? hashDefaults({ roles, scope_map, flags, roster_overrides, design_system });
  const metadata = isObject(document.metadata) ? document.metadata : {};
  const versionValue = document.config_version ?? document.version ?? metadata.version;
  const configVersion = typeof versionValue === "string" || typeof versionValue === "number" ? versionValue : null;
  const writerValue = document.writer ?? metadata.writer;
  const configWriter = typeof writerValue === "string" && writerValue.trim() ? writerValue : null;
  const provenanceValue = document.provenance ?? metadata.provenance;
  const configProvenanceValue = isObject(provenanceValue) ? provenanceValue : null;
  const provenance: ConfigProvenance = {
    cwd: effectiveCwd,
    source: selectedSource,
    path: selectedPath,
    hash: configHash,
    version: configVersion,
    writer: configWriter,
    provenance: configProvenanceValue,
  };

  const generated = diagnostics.length > 0
    ? undefined
    : readAgentMapping(effectiveCwd);
  const extraRoles = scope_map.map(entry => entry.dev_agent);
  const mappingProvenance = generated && (
    generated.config_hash !== undefined
    || generated.provenance?.config_hash !== undefined
    || generated.provenance?.scope_map !== undefined
    || generated.provenance?.flags !== undefined
    || generated.provenance?.roster !== undefined
  )
    ? mappingInputs(
      { roles, scope_map, flags, roster_overrides, config_path: selectedPath, config_source: selectedSource, config_hash: configHash, config_version: configVersion, config_provenance: provenance },
      generated.available_agents,
      generated.source,
      generated.provenance,
    )
    : generated?.provenance
      ? { ...generated.provenance, provider_discovery: generated.available_agents }
      : undefined;
  const expectedMappingHash = generated && mappingProvenance
    ? mappingPreferencesHash(roles, extraRoles, mappingProvenance)
    : undefined;
  const agent_mapping = generated && expectedMappingHash === generated.preferences_hash
    ? generated
    : undefined;
  const unknown_metadata: UnknownObject = {};
  for (const [key, value] of Object.entries(document)) {
    if (!CONFIG_KEYS[key]) unknown_metadata[key] = value;
  }
  return {
    ...document,
    roles,
    roster_overrides,
    scope_map,
    flags,
    agent_mapping,
    config_path: selectedPath,
    config_source: selectedSource,
    config_hash: configHash,
    config_version: configVersion,
    config_writer: configWriter,
    config_provenance: provenance,
    diagnostics,
    ...(diagnostics[0] ? { diagnostic: diagnostics[0] } : {}),
    unknown_metadata,
  } as ResolvedConfig;
}

export function resolveAgentForRole(role: string, config: RoleConfig): string {
  return config.agent_mapping?.resolved_roles[role] ?? config.roles[role] ?? role;
}

/** Return a truthful diagnostic when discovery could not resolve a role. */
export function agentMappingIssueForRole(role: string, config: RoleConfig): AgentMappingDiagnostic | undefined {
  const diagnostic = config.agent_mapping?.diagnostics[role];
  return diagnostic?.status === "unavailable" ? diagnostic : undefined;
}
