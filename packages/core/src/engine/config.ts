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
import { existsSync } from "node:fs";
import { TextDecoder } from "node:util";
import { join, resolve } from "node:path";
import { PinnedProjectRoot, PinnedRootError } from "../specification/pinned-root.js";
import {
  readAgentMapping,
  type AgentMappingDiagnostic,
  type AgentMappingState,
  type MappingPreferencesProvenance,
} from "./agent-mapping.js";
import type { ScopeRuntimeClassTable } from "./scope.js";
import type { RoleConfig } from "./types.js";

/**
 * Caller-supplied fallback preset for config documents that omit
 * `roles`/`scope_map`/`flags`. Core never ships a domain preset of its own:
 * when neither the config document nor the caller supplies a key, the
 * resolution degrades to neutral empty values (and `${scope.dev_agent}`
 * stages fail closed at dispatch time).
 */
export interface ConfigPreset {
  roles?: RoleConfig["roles"];
  scope_map?: RoleConfig["scope_map"];
  flags?: RoleConfig["flags"];
}

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
  scope_runtime_classes?: ScopeRuntimeClassTable;
  /** Alias retained for configs written before the explicit key. */
  runtime_classes?: ScopeRuntimeClassTable;
  /** Caller/bundle-supplied scope → UI marker table. */
  scope_ui_classes?: ScopeRuntimeClassTable;
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

const CONFIG_KEYS: Readonly<Record<string, true>> = Object.freeze(Object.assign(Object.create(null), {
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
  scope_runtime_classes: true,
  runtime_classes: true,
  scope_ui_classes: true,
}));
function isObject(value: unknown): value is UnknownObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

const CONFIG_MAX_BYTES = 256 * 1024;
const CONFIG_MAX_DEPTH = 8;
const CONFIG_MAX_NODES = 4096;
const CONFIG_MAX_KEYS = 256;
const CONFIG_MAX_ARRAY = 256;
const CONFIG_MAX_STRING_BYTES = 8 * 1024;

interface ConfigJsonBudget {
  nodes: number;
  bytes: number;
}

function boundedConfigString(value: unknown, allowEmpty = false): value is string {
  return typeof value === "string"
    && (allowEmpty || value.trim().length > 0)
    && Buffer.byteLength(value, "utf8") <= CONFIG_MAX_STRING_BYTES
    && !/[\u0000-\u001f\u007f]/u.test(value);
}

function boundedConfigJson(value: unknown, depth = 0, budget: ConfigJsonBudget = { nodes: 0, bytes: 0 }, seen = new Set<object>()): boolean {
  budget.nodes += 1;
  if (budget.nodes > CONFIG_MAX_NODES || depth > CONFIG_MAX_DEPTH) return false;
  if (value === null || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value === "string") {
    budget.bytes += Buffer.byteLength(value, "utf8");
    return boundedConfigString(value, true) && budget.bytes <= CONFIG_MAX_BYTES;
  }
  if (typeof value !== "object" || seen.has(value)) return false;
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      return value.length <= CONFIG_MAX_ARRAY && value.every((item) => boundedConfigJson(item, depth + 1, budget, seen));
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return false;
    const entries = Object.entries(value);
    return entries.length <= CONFIG_MAX_KEYS
      && entries.every(([key, item]) => {
        budget.bytes += Buffer.byteLength(key, "utf8");
        return boundedConfigString(key) && budget.bytes <= CONFIG_MAX_BYTES && boundedConfigJson(item, depth + 1, budget, seen);
      });
  } finally {
    seen.delete(value);
  }
}

function setOwn<T>(target: Record<string, T>, key: string, value: T): void {
  Object.defineProperty(target, key, {
    configurable: true,
    enumerable: true,
    value,
    writable: true,
  });
}

function createLookupRecord<T>(): Record<string, T> {
  return {};
}

function ownValue(value: UnknownObject, key: string): unknown {
  return Object.hasOwn(value, key) ? value[key] : undefined;
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
  const copyFallback = (): Record<string, string> => {
    const result = createLookupRecord<string>();
    for (const [key, candidate] of Object.entries(fallback)) setOwn(result, key, candidate);
    return result;
  };
  if (value === undefined) return copyFallback();
  if (!isObject(value)) {
    addDiagnostic(diagnostics, "invalid_shape", path, "expected an object of string values");
    return copyFallback();
  }
  const entries = Object.entries(value);
  if (entries.length > CONFIG_MAX_KEYS) {
    addDiagnostic(diagnostics, "invalid_shape", path, `expected at most ${CONFIG_MAX_KEYS} entries`);
    return copyFallback();
  }
  const result = copyFallback();
  for (const [key, candidate] of entries) {
    if (boundedConfigString(key) && boundedConfigString(candidate)) setOwn(result, key, candidate);
    else addDiagnostic(diagnostics, "invalid_shape", `${path}.${key}`, "expected a bounded non-empty string");
  }
  return result;
}

function readScopeMap(
  value: unknown,
  fallback: RoleConfig["scope_map"],
  diagnostics: ConfigDiagnostic[],
): RoleConfig["scope_map"] {
  const copyFallback = (): RoleConfig["scope_map"] => fallback.map(entry => ({ ...entry, glob: [...entry.glob] }));
  if (value === undefined) return copyFallback();
  if (!Array.isArray(value)) {
    addDiagnostic(diagnostics, "invalid_shape", "scope_map", "expected an array of scope entries");
    return copyFallback();
  }
  if (value.length > CONFIG_MAX_ARRAY) {
    addDiagnostic(diagnostics, "invalid_shape", "scope_map", `expected at most ${CONFIG_MAX_ARRAY} entries`);
    return copyFallback();
  }
  const valid: RoleConfig["scope_map"] = [];
  const seenScopes = new Set<string>();
  const duplicateScopes = new Set<string>();
  for (const [index, rawEntry] of value.entries()) {
    const keys = isObject(rawEntry) ? Object.keys(rawEntry) : [];
    if (!isObject(rawEntry)
      || keys.some((key) => !["glob", "scope", "dev_agent", "runtime_class"].includes(key))
      || !Object.hasOwn(rawEntry, "scope")
      || !boundedConfigString(rawEntry.scope)
      || !Object.hasOwn(rawEntry, "dev_agent")
      || !boundedConfigString(rawEntry.dev_agent)
      || !Object.hasOwn(rawEntry, "glob")
      || !Array.isArray(rawEntry.glob)
      || rawEntry.glob.length > CONFIG_MAX_ARRAY
      || !rawEntry.glob.every(pattern => boundedConfigString(pattern))) {
      addDiagnostic(diagnostics, "invalid_shape", `scope_map[${index}]`, "expected a bounded scope entry");
      continue;
    }
    if (seenScopes.has(rawEntry.scope)) {
      duplicateScopes.add(rawEntry.scope);
      addDiagnostic(diagnostics, "invalid_shape", `scope_map[${index}].scope`, "duplicate scope key");
      continue;
    }
    seenScopes.add(rawEntry.scope);
    if (Object.hasOwn(rawEntry, "runtime_class")
      && typeof rawEntry.runtime_class !== "string"
      && typeof rawEntry.runtime_class !== "boolean") {
      addDiagnostic(diagnostics, "invalid_shape", `scope_map[${index}].runtime_class`, "expected a bounded non-empty string or boolean");
      continue;
    }
    if (Object.hasOwn(rawEntry, "runtime_class")
      && typeof rawEntry.runtime_class === "string"
      && !boundedConfigString(rawEntry.runtime_class)) {
      addDiagnostic(diagnostics, "invalid_shape", `scope_map[${index}].runtime_class`, "expected a bounded non-empty string or boolean");
      continue;
    }
    valid.push({
      glob: [...rawEntry.glob] as string[],
      scope: rawEntry.scope,
      dev_agent: rawEntry.dev_agent,
      ...(Object.hasOwn(rawEntry, "runtime_class") ? { runtime_class: rawEntry.runtime_class } : {}),
    } as RoleConfig["scope_map"][number]);
  }
  const unambiguous = valid.filter(entry => !duplicateScopes.has(entry.scope));
  return unambiguous.length > 0 ? unambiguous : copyFallback();
}

/**
 * Validate a scope classification table (`scope_runtime_classes`,
 * `runtime_classes`, `scope_ui_classes`). Malformed tables are visible
 * diagnostics and are dropped rather than partially applied.
 */
function readRuntimeClassTable(
  value: unknown,
  diagnostics: ConfigDiagnostic[],
  path: string,
  uiOnly = false,
): ScopeRuntimeClassTable | undefined {
  if (value === undefined) return undefined;
  if (!isObject(value)) {
    addDiagnostic(diagnostics, "invalid_shape", path, "expected an object of string or boolean values");
    return undefined;
  }
  const entries = Object.entries(value);
  if (entries.length > CONFIG_MAX_KEYS) {
    addDiagnostic(diagnostics, "invalid_shape", path, `expected at most ${CONFIG_MAX_KEYS} entries`);
    return undefined;
  }
  const valid = createLookupRecord<string | boolean>();
  for (const [key, candidate] of entries) {
    if (!boundedConfigString(key)) {
      addDiagnostic(diagnostics, "invalid_shape", `${path}.${key}`, "expected a bounded key");
      continue;
    }
    if (uiOnly
      ? typeof candidate === "boolean"
      : (typeof candidate === "string" && boundedConfigString(candidate)) || typeof candidate === "boolean") {
      setOwn(valid, key, candidate as string | boolean);
    } else {
      const expected = uiOnly ? "expected boolean UI markers" : "expected a bounded non-empty string or boolean";
      addDiagnostic(diagnostics, "invalid_shape", `${path}.${key}`, expected);
    }
  }
  return valid;
}

function mergeRuntimeClassTables(
  alias: ScopeRuntimeClassTable | undefined,
  explicit: ScopeRuntimeClassTable | undefined,
): ScopeRuntimeClassTable | undefined {
  if (alias === undefined && explicit === undefined) return undefined;
  const merged = createLookupRecord<string | boolean>();
  for (const [key, value] of Object.entries(alias ?? {})) setOwn(merged, key, value);
  for (const [key, value] of Object.entries(explicit ?? {})) setOwn(merged, key, value);
  return merged;
}

function readFlags(
  value: unknown,
  fallback: RoleConfig["flags"],
  diagnostics: ConfigDiagnostic[],
): RoleConfig["flags"] {
  const copyFallback = (): RoleConfig["flags"] => {
    const result = createLookupRecord<string[]>();
    for (const [key, patterns] of Object.entries(fallback)) setOwn(result, key, [...patterns]);
    return result;
  };
  if (value === undefined) return copyFallback();
  if (!isObject(value)) {
    addDiagnostic(diagnostics, "invalid_shape", "flags", "expected an object of string arrays");
    return copyFallback();
  }
  const entries = Object.entries(value);
  if (entries.length > CONFIG_MAX_KEYS) {
    addDiagnostic(diagnostics, "invalid_shape", "flags", `expected at most ${CONFIG_MAX_KEYS} entries`);
    return copyFallback();
  }
  const result = copyFallback();
  for (const [key, candidate] of entries) {
    if (!boundedConfigString(key)
      || !Array.isArray(candidate)
      || candidate.length > CONFIG_MAX_ARRAY
      || !candidate.every(pattern => boundedConfigString(pattern))) {
      addDiagnostic(diagnostics, "invalid_shape", `flags.${key}`, "expected a bounded string pattern array");
      continue;
    }
    setOwn(result, key, [...candidate] as string[]);
  }
  return result;
}

function readRosterOverrides(value: unknown, diagnostics: ConfigDiagnostic[]): RoleConfig["roster_overrides"] {
  if (value === undefined) return createLookupRecord();
  if (!isObject(value)) {
    addDiagnostic(diagnostics, "invalid_shape", "roster_overrides", "expected an object keyed by stage");
    return createLookupRecord();
  }
  const entries = Object.entries(value);
  if (entries.length > CONFIG_MAX_KEYS) {
    addDiagnostic(diagnostics, "invalid_shape", "roster_overrides", `expected at most ${CONFIG_MAX_KEYS} stages`);
    return createLookupRecord();
  }
  const result: RoleConfig["roster_overrides"] = createLookupRecord();
  for (const [stage, raw] of entries) {
    if (!boundedConfigString(stage) || !isObject(raw)
      || Object.keys(raw).some((key) => !["replace", "add", "remove"].includes(key))) {
      addDiagnostic(diagnostics, "invalid_shape", `roster_overrides.${stage}`, "expected a bounded stage override object");
      continue;
    }
    const normalized: RoleConfig["roster_overrides"][string] = createLookupRecord();
    for (const key of ["replace", "add", "remove"] as const) {
      if (!Object.hasOwn(raw, key)) continue;
      const candidate = raw[key];
      if (!Array.isArray(candidate)
        || candidate.length > CONFIG_MAX_ARRAY
        || !candidate.every(role => boundedConfigString(role))) {
        addDiagnostic(diagnostics, "invalid_shape", `roster_overrides.${stage}.${key}`, "expected a bounded string array");
        continue;
      }
      setOwn(normalized, key, [...candidate] as string[]);
    }
    setOwn(result, stage, normalized);
  }
  return result;
}

export function resolveConfig(cwd: string, preset: ConfigPreset = {}, borrowedRoot?: PinnedProjectRoot): ResolvedConfig {
  const resolvedCwd = resolve(cwd);
  const rootExists = borrowedRoot !== undefined || existsSync(resolvedCwd);
  const ownedPinnedRoot = borrowedRoot === undefined && rootExists ? PinnedProjectRoot.open(resolvedCwd) : null;
  const pinnedRoot = borrowedRoot ?? ownedPinnedRoot;
  const effectiveCwd = pinnedRoot?.canonical_root ?? resolvedCwd;
  const candidates: Array<{ source: Exclude<ConfigSource, "defaults">; path: string; relative: string }> = [
    { source: "omp", path: join(effectiveCwd, ".omp", "team.config.json"), relative: ".omp/team.config.json" },
    { source: "legacy", path: join(effectiveCwd, ".claude", "team.config.json"), relative: ".claude/team.config.json" },
  ];
  const diagnostics: ConfigDiagnostic[] = [];
  let selected: { source: Exclude<ConfigSource, "defaults">; path: string; document: UnknownObject } | undefined;
  let selectedPath: string | null = null;
  let selectedSource: ConfigSource = "defaults";
  let selectedHash: string | undefined;
  if (rootExists && !pinnedRoot) {
    addDiagnostic(diagnostics, "path_invalid", resolvedCwd, "project root could not be opened and pinned safely");
  }
  if (pinnedRoot) {
      for (const candidate of candidates) {
        let exists = false;
        try {
          exists = pinnedRoot.pathEntryExists(candidate.relative);
        } catch (error) {
          addDiagnostic(diagnostics, "path_invalid", candidate.path, `config candidate could not be inspected safely: ${error instanceof PinnedRootError ? `${error.code}: ${error.message}` : String(error)}`);
          break;
        }
        if (!exists) continue;
        selectedPath = candidate.path;
        selectedSource = candidate.source;
        let bytes: Uint8Array;
        try {
          bytes = pinnedRoot.readFile(candidate.relative, { maxBytes: CONFIG_MAX_BYTES }).bytes;
        } catch (error) {
          addDiagnostic(diagnostics, "path_invalid", candidate.path, `config candidate could not be read safely: ${error instanceof PinnedRootError ? `${error.code}: ${error.message}` : String(error)}`);
          break;
        }
        let raw: string;
        try {
          raw = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
        } catch (error) {
          addDiagnostic(diagnostics, "malformed", candidate.path, `config is not valid UTF-8: ${error instanceof Error ? error.message : String(error)}`);
          break;
        }
        selectedHash = hashText(raw);
        try {
          const parsed: unknown = JSON.parse(raw);
          if (!isObject(parsed) || !boundedConfigJson(parsed)) throw new Error("config exceeds bounded JSON shape");
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
    }

  const document = selected?.document ?? {};
  const presetRoles = preset.roles ?? {};
  const presetScopeMap = preset.scope_map ?? [];
  const presetFlags = preset.flags ?? {};
  const roles = readStringMap(ownValue(document, "roles"), presetRoles, diagnostics, "roles");
  const scope_map = readScopeMap(ownValue(document, "scope_map"), presetScopeMap, diagnostics);
  const flags = readFlags(ownValue(document, "flags"), presetFlags, diagnostics);
  const explicitRuntimeClasses = readRuntimeClassTable(
    ownValue(document, "scope_runtime_classes"),
    diagnostics,
    "scope_runtime_classes",
  );
  const aliasRuntimeClasses = readRuntimeClassTable(
    ownValue(document, "runtime_classes"),
    diagnostics,
    "runtime_classes",
  );
  const scope_runtime_classes = mergeRuntimeClassTables(aliasRuntimeClasses, explicitRuntimeClasses);
  const runtime_classes = aliasRuntimeClasses;
  const scope_ui_classes = readRuntimeClassTable(
    ownValue(document, "scope_ui_classes"),
    diagnostics,
    "scope_ui_classes",
    true,
  );
  const roster_overrides = readRosterOverrides(ownValue(document, "roster_overrides"), diagnostics);
  const designSystemValue = ownValue(document, "design_system");
  const design_system = designSystemValue === undefined || designSystemValue === null
    ? null
    : typeof designSystemValue === "string"
      ? designSystemValue
      : (addDiagnostic(diagnostics, "invalid_shape", "design_system", "expected a string or null"), null);
  const configHash = selectedHash ?? hashDefaults({ roles, scope_map, flags, roster_overrides, design_system });
  const metadataValue = ownValue(document, "metadata");
  const metadata = isObject(metadataValue) ? metadataValue : {};
  const versionValue = ownValue(document, "config_version") ?? ownValue(document, "version") ?? ownValue(metadata, "version");
  const configVersion = typeof versionValue === "string" || (typeof versionValue === "number" && Number.isFinite(versionValue))
    ? versionValue
    : null;
  const writerValue = ownValue(document, "writer") ?? ownValue(metadata, "writer");
  const configWriter = typeof writerValue === "string" && writerValue.trim() ? writerValue : null;
  const provenanceValue = ownValue(document, "provenance") ?? ownValue(metadata, "provenance");
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
  const extraRoles = scope_map.map(entry => entry.dev_agent);
  let generated: AgentMappingState | undefined;
  try {
    if (diagnostics.length === 0) {
      generated = readAgentMapping(effectiveCwd, {
        roles,
        extraRoles,
        scope_map,
        flags,
        roster: roster_overrides,
        config_path: selectedPath,
        config_source: selectedSource,
        config_hash: configHash,
        config_version: configVersion,
        config_provenance: provenance,
      }, pinnedRoot ?? undefined);
    }
  } finally {
    if (ownedPinnedRoot) ownedPinnedRoot.close();
  }
  const agent_mapping = generated;
  const unknown_metadata: UnknownObject = createLookupRecord();
  for (const [key, value] of Object.entries(document)) {
    if (!Object.hasOwn(CONFIG_KEYS, key)) setOwn(unknown_metadata, key, value);
  }
  const outputDocument = { ...document };
  delete outputDocument.scope_runtime_classes;
  delete outputDocument.runtime_classes;
  delete outputDocument.scope_ui_classes;
  return {
    ...outputDocument,
    roles,
    roster_overrides,
    scope_map,
    flags,
    ...(scope_runtime_classes ? { scope_runtime_classes } : {}),
    ...(runtime_classes ? { runtime_classes } : {}),
    ...(scope_ui_classes ? { scope_ui_classes } : {}),
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
  const mappedRoles = config.agent_mapping?.resolved_roles;
  if (mappedRoles && Object.hasOwn(mappedRoles, role)) return mappedRoles[role]!;
  if (Object.hasOwn(config.roles, role)) return config.roles[role]!;
  return role;
}

/** Return a truthful diagnostic when discovery could not resolve a role. */
export function agentMappingIssueForRole(role: string, config: RoleConfig): AgentMappingDiagnostic | undefined {
  const diagnostic = config.agent_mapping?.diagnostics[role];
  return diagnostic?.status === "unavailable" ? diagnostic : undefined;
}
