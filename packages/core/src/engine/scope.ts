/**
 * Generic scope resolution.
 *
 * A scope entry may opt into a runtime class (`runtime_class`) and a caller
 * may supply a `scope_runtime_classes`/`runtime_classes` table plus a
 * `scope_ui_classes` table on its config. Core owns the generic
 * classification mechanics only; domain scope/classification tables are
 * caller-supplied data, never core defaults.
 */

import { minimatch } from "./minimatch.js";
import type { RoleConfig } from "./types.js";

export type RuntimeClass = string & {};
export type ScopeRuntimeClassTable = Readonly<Record<string, RuntimeClass | boolean>>;

export interface ScopeFlags {
  scope: string[];
  has_security: boolean;
  has_infra: boolean;
  has_ui: boolean;
  has_runtime: boolean;
  dev_agent: string | null;
  [flag: string]: boolean | string[] | string | null;
}

type ScopeEntry = RoleConfig["scope_map"][number] & { runtime_class?: RuntimeClass | boolean };
type ScopeConfig = RoleConfig & {
  scope_runtime_classes?: ScopeRuntimeClassTable;
  runtime_classes?: ScopeRuntimeClassTable;
  scope_ui_classes?: ScopeRuntimeClassTable;
};
type UnknownRecord = Record<string, unknown>;

function isObject(value: unknown): value is UnknownRecord {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function hasRuntimeClass(value: object): value is object & { runtime_class: unknown } {
  return Object.hasOwn(value, "runtime_class");
}

/**
 * Normalize untrusted runtime-class metadata before any string operation.
 * A null result means that the value is absent or malformed; callers use
 * presence checks to avoid falling through to a lower-precedence table.
 */
function normalizeRuntimeClass(value: unknown): RuntimeClass | boolean | null {
  if (typeof value === "boolean") return value;
  if (typeof value !== "string") return null;
  return value.trim() ? value as RuntimeClass : null;
}

function runtimeClassIsRuntime(runtimeClass: unknown): boolean {
  const normalized = normalizeRuntimeClass(runtimeClass);
  if (normalized === null || normalized === false) return false;
  if (normalized === true) return true;
  const value = normalized.trim().toLowerCase();
  return !["none", "static", "documentation", "ui"].includes(value);
}

function runtimeClassIsUi(runtimeClass: unknown): boolean {
  const normalized = normalizeRuntimeClass(runtimeClass);
  return typeof normalized === "string" && normalized.trim().toLowerCase() === "ui";
}

function lookupRuntimeClass(
  table: unknown,
  scope: string,
): { found: boolean; value: RuntimeClass | boolean | null } {
  if (!isObject(table) || !Object.hasOwn(table, scope)) return { found: false, value: null };
  return { found: true, value: normalizeRuntimeClass(table[scope]) };
}

function isScopeConfig(value: unknown): value is ScopeConfig {
  return isObject(value) && Object.hasOwn(value, "scope_map") && Array.isArray(value.scope_map);
}

/**
 * Resolve one scope to its runtime class.  Entry metadata wins over the
 * caller's table.  Unknown scopes resolve to `null` — core ships no domain
 * classification defaults.
 */
export function runtimeClassForScope(
  scope: string,
  configOrTable?: RoleConfig | ScopeRuntimeClassTable,
): RuntimeClass | boolean | null {
  if (typeof scope !== "string") return null;
  if (isScopeConfig(configOrTable)) {
    for (const candidate of configOrTable.scope_map) {
      if (!isObject(candidate) || !Object.hasOwn(candidate, "scope") || candidate.scope !== scope) continue;
      if (hasRuntimeClass(candidate)) {
        return normalizeRuntimeClass(candidate.runtime_class);
      }
      break;
    }
    const explicitTable = Object.hasOwn(configOrTable, "scope_runtime_classes")
      ? configOrTable.scope_runtime_classes
      : undefined;
    const aliasTable = Object.hasOwn(configOrTable, "runtime_classes")
      ? configOrTable.runtime_classes
      : undefined;
    const explicit = lookupRuntimeClass(explicitTable, scope);
    if (explicit.found) return explicit.value;
    const alias = lookupRuntimeClass(aliasTable, scope);
    if (alias.found) return alias.value;
  } else {
    const table = lookupRuntimeClass(configOrTable, scope);
    if (table.found) return table.value;
  }
  return null;
}

/** Alias with an explicit scope-to-runtime-class name for bundle adapters. */
export const scopeToRuntimeClass = runtimeClassForScope;

export interface ScopeResolutionOptions {
  runtimeClasses?: ScopeRuntimeClassTable;
}

export function resolveScope(files: string[], config: RoleConfig, options: ScopeResolutionOptions = {}): ScopeFlags {
  const matchedScopes = new Set<string>();
  const dynamicFlags: Record<string, boolean> = {};
  Object.defineProperty(dynamicFlags, "has_security", { configurable: true, enumerable: true, value: false, writable: true });
  Object.defineProperty(dynamicFlags, "has_infra", { configurable: true, enumerable: true, value: false, writable: true });
  let devAgent: string | null = null;
  let hasRuntimeScope = false;
  let hasUiScope = false;
  const configObject = isObject(config) ? config : undefined;
  const optionsObject = isObject(options) ? options : undefined;
  const scopeMap = configObject && Object.hasOwn(configObject, "scope_map") && Array.isArray(configObject.scope_map)
    ? configObject.scope_map
    : [];
  const flagMap = configObject && Object.hasOwn(configObject, "flags") && isObject(configObject.flags)
    ? configObject.flags
    : undefined;

  for (const file of files) {
    if (typeof file !== "string") continue;
    for (const rawEntry of scopeMap) {
      if (!isObject(rawEntry)
        || !Object.hasOwn(rawEntry, "glob")
        || !Array.isArray(rawEntry.glob)
        || !rawEntry.glob.every(pattern => typeof pattern === "string" && pattern.length > 0)
        || !Object.hasOwn(rawEntry, "scope")
        || typeof rawEntry.scope !== "string"
        || !rawEntry.scope.trim()) {
        continue;
      }
      const entry = rawEntry as ScopeEntry;
      if (!entry.glob.some(pattern => minimatch(file, pattern))) continue;
      matchedScopes.add(entry.scope);
      if (typeof entry.dev_agent === "string" && entry.dev_agent.trim()) devAgent = entry.dev_agent;
      const entryRuntimeClass = Object.hasOwn(entry, "runtime_class")
        ? normalizeRuntimeClass(entry.runtime_class)
        : null;
      const runtimeClass = Object.hasOwn(entry, "runtime_class")
        ? entryRuntimeClass
        : (() => {
          const caller = lookupRuntimeClass(optionsObject?.runtimeClasses, entry.scope);
          return caller.found ? caller.value : runtimeClassForScope(entry.scope, config);
        })();
      const uiTable = isScopeConfig(config) && Object.hasOwn(config, "scope_ui_classes")
        ? config.scope_ui_classes
        : undefined;
      const uiMarked = isObject(uiTable)
        && Object.hasOwn(uiTable, entry.scope)
        && uiTable[entry.scope] === true;
      hasRuntimeScope ||= runtimeClassIsRuntime(runtimeClass);
      hasUiScope ||= runtimeClassIsUi(runtimeClass) || uiMarked;
      break;
    }
    if (!flagMap) continue;
    for (const [flag, patterns] of Object.entries(flagMap)) {
      if (!Array.isArray(patterns) || !patterns.every(pattern => typeof pattern === "string" && pattern.length > 0)) continue;
      if (patterns.some(pattern => minimatch(file, pattern))) {
        Object.defineProperty(dynamicFlags, flag, { configurable: true, enumerable: true, value: true, writable: true });
      }
    }
  }

  const scope = Array.from(matchedScopes);
  const flags: ScopeFlags = {
    ...dynamicFlags,
    scope,
    has_security: dynamicFlags.has_security ?? false,
    has_infra: dynamicFlags.has_infra ?? false,
    has_ui: hasUiScope || dynamicFlags.has_ui === true,
    has_runtime: hasRuntimeScope || dynamicFlags.has_runtime === true,
    dev_agent: devAgent,
  };
  return flags;
}

export function applyConditional(
  roster: string[],
  conditional: Array<{ if: string; add?: string; remove?: string }> | undefined,
  flags: ScopeFlags,
): string[] {
  if (!conditional) return roster;
  const result = new Set(roster);
  for (const rule of conditional) {
    if (!isObject(rule) || typeof rule.if !== "string" || !evalFlag(rule.if, flags)) continue;
    if (typeof rule.add === "string" && rule.add) result.add(rule.add);
    if (typeof rule.remove === "string" && rule.remove) result.delete(rule.remove);
  }
  return Array.from(result);
}

/**
 * Flag evaluator. Supports `scope.has_<flag>` and `!scope.has_<flag>`.
 * Unknown expressions stay false (and unknown negated expressions stay false)
 * so malformed conditional/skip rules never authorize a stage.
 */
function evalFlag(expr: string, flags: ScopeFlags): boolean {
  if (typeof expr !== "string") return false;
  const e = expr.trim();
  const negated = e.startsWith("!scope.");
  const prefix = negated ? "!scope." : "scope.";
  if (!e.startsWith(prefix)) return false;
  const key = e.slice(prefix.length);
  if (!key.startsWith("has_") || !Object.hasOwn(flags, key)) return false;
  const value = flags[key];
  if (typeof value !== "boolean") return false;
  return negated ? !value : value;
}

export function shouldSkip(stage: { skip_if?: string }, flags: ScopeFlags): boolean {
  if (!stage || typeof stage.skip_if !== "string" || !stage.skip_if) return false;
  return evalFlag(stage.skip_if, flags);
}
