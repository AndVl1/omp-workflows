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

function runtimeClassIsRuntime(runtimeClass: RuntimeClass | boolean | null | undefined): boolean {
  if (runtimeClass === undefined || runtimeClass === null || runtimeClass === false) return false;
  if (runtimeClass === true) return true;
  const normalized = runtimeClass.trim().toLowerCase();
  return Boolean(normalized) && !["none", "static", "documentation", "ui"].includes(normalized);
}

function runtimeClassIsUi(runtimeClass: RuntimeClass | boolean | null | undefined): boolean {
  return typeof runtimeClass === "string" && runtimeClass.trim().toLowerCase() === "ui";
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
  if (typeof configOrTable === "object" && configOrTable && "scope_map" in configOrTable) {
    const config = configOrTable as ScopeConfig;
    const entry = config.scope_map.find(candidate => candidate.scope === scope) as ScopeEntry | undefined;
    if (entry?.runtime_class !== undefined) return entry.runtime_class;
    const table = config.scope_runtime_classes ?? config.runtime_classes;
    if (table && scope in table) return table[scope] ?? null;
  } else if (configOrTable && scope in configOrTable) {
    return configOrTable[scope] ?? null;
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
  const dynamicFlags: Record<string, boolean> = {
    has_security: false,
    has_infra: false,
  };
  let devAgent: string | null = null;
  let hasRuntimeScope = false;
  let hasUiScope = false;

  for (const file of files) {
    for (const rawEntry of config.scope_map) {
      const entry = rawEntry as ScopeEntry;
      if (!entry.glob.some(pattern => minimatch(file, pattern))) continue;
      matchedScopes.add(entry.scope);
      if (entry.dev_agent) devAgent = entry.dev_agent;
      const runtimeClass = entry.runtime_class
        ?? (options.runtimeClasses && entry.scope in options.runtimeClasses ? options.runtimeClasses[entry.scope] : undefined)
        ?? runtimeClassForScope(entry.scope, config);
      const uiTable = (config as ScopeConfig).scope_ui_classes;
      const uiMarked = Boolean(uiTable && entry.scope in uiTable && uiTable[entry.scope]);
      hasRuntimeScope ||= runtimeClassIsRuntime(runtimeClass);
      hasUiScope ||= runtimeClassIsUi(runtimeClass) || uiMarked;
      break;
    }
    for (const [flag, patterns] of Object.entries(config.flags ?? {})) {
      if (patterns.some(pattern => minimatch(file, pattern))) dynamicFlags[flag] = true;
    }
  }

  const scope = Array.from(matchedScopes);
  const flags: ScopeFlags = {
    ...dynamicFlags,
    scope,
    has_security: dynamicFlags.has_security ?? false,
    has_infra: dynamicFlags.has_infra ?? false,
    has_ui: hasUiScope || Boolean(dynamicFlags.has_ui),
    has_runtime: hasRuntimeScope || Boolean(dynamicFlags.has_runtime),
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
    if (!evalFlag(rule.if, flags)) continue;
    if (rule.add) result.add(rule.add);
    if (rule.remove) result.delete(rule.remove);
  }
  return Array.from(result);
}

/**
 * Flag evaluator. Supports `scope.has_<flag>` and `!scope.has_<flag>`.
 * Unknown expressions stay false (and unknown negated expressions stay false)
 * so malformed conditional/skip rules never authorize a stage.
 */
function evalFlag(expr: string, flags: ScopeFlags): boolean {
  const e = expr.trim();
  const negated = e.startsWith("!scope.");
  const prefix = negated ? "!scope." : "scope.";
  if (!e.startsWith(prefix)) return false;
  const key = e.slice(prefix.length);
  if (!key.startsWith("has_")) return false;
  const value = flags[key];
  if (typeof value !== "boolean") return false;
  return negated ? !value : value;
}

export function shouldSkip(stage: { skip_if?: string }, flags: ScopeFlags): boolean {
  if (!stage.skip_if) return false;
  return evalFlag(stage.skip_if, flags);
}
