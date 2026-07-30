/**
 * Scope resolution: parse file paths against the project's scope_map and
 * derive the per-stage scope flags (has_security, has_infra, has_ui, has_runtime).
 *
 * Used by stage runner to resolve `${scope.dev_agent}` and apply `conditional[]`
 * rules on consilium rosters.
 */

import { minimatch } from "./minimatch.js";
import type { RoleConfig } from "./types.js";

export interface ScopeFlags {
  scope: string[];
  has_security: boolean;
  has_infra: boolean;
  has_ui: boolean;
  has_runtime: boolean;
  dev_agent: string | null;
}

const UI_SCOPES: Record<string, true> = {
  frontend: true,
  mobile: true,
};

const RUNTIME_SCOPES: Record<string, true> = {
  "backend-kotlin": true,
  go: true,
  frontend: true,
  mobile: true,
  devops: true,
};

export function resolveScope(files: string[], config: RoleConfig): ScopeFlags {
  const matchedScopes = new Set<string>();
  const flags: Record<string, boolean> = {
    has_security: false,
    has_infra: false,
  };
  let devAgent: string | null = null;

  for (const file of files) {
    for (const entry of config.scope_map) {
      if (entry.glob.some((g) => minimatch(file, g))) {
        matchedScopes.add(entry.scope);
        if (entry.dev_agent) devAgent = entry.dev_agent;
        break;
      }
    }
    for (const [flag, patterns] of Object.entries(config.flags ?? {})) {
      if (patterns.some((p) => minimatch(file, p))) flags[flag] = true;
    }
  }

  const scope = Array.from(matchedScopes);
  const has_ui = scope.some((s) => UI_SCOPES[s] === true);
  const has_runtime = scope.some((s) => RUNTIME_SCOPES[s] === true);

  return {
    scope,
    has_security: flags.has_security ?? false,
    has_infra: flags.has_infra ?? false,
    has_ui,
    has_runtime,
    dev_agent: devAgent,
  };
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
 * Flag evaluator. Supports `scope.has_<flag>` and `!scope.has_<flag>` only.
 * Anything else is treated as false (be conservative).
 */
function evalFlag(expr: string, flags: ScopeFlags): boolean {
  const e = expr.trim();
  if (e.startsWith("scope.")) {
    const key = e.slice("scope.".length);
    if (key === "has_security") return flags.has_security;
    if (key === "has_infra") return flags.has_infra;
    if (key === "has_ui") return flags.has_ui;
    if (key === "has_runtime") return flags.has_runtime;
    return false;
  }
  if (e.startsWith("!scope.")) {
    const key = e.slice("!scope.".length);
    if (key === "has_security") return !flags.has_security;
    if (key === "has_infra") return !flags.has_infra;
    if (key === "has_ui") return !flags.has_ui;
    if (key === "has_runtime") return !flags.has_runtime;
    return false;
  }
  return false;
}

export function shouldSkip(stage: { skip_if?: string }, flags: ScopeFlags): boolean {
  if (!stage.skip_if) return false;
  return evalFlag(stage.skip_if, flags);
}
