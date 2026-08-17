/**
 * Shared expression semantics for shipped workflow `gate`, `skip_if` and
 * `loop.until` expressions.
 *
 * One explicit predicate evaluator serves all three surfaces so a shipped
 * expression can never be silently treated as false. Unsupported syntax is
 * a hard diagnostic (fail closed), never a silent `false`.
 *
 * Supported grammar (top-level `||`, per-operand `!` negation):
 *
 *   - named gates          `branch_created`, `dod_complete`, ... (resolved by
 *                          the caller via {@link PredicateContext.namedGate})
 *   - scope flags          `scope.has_runtime`, `!scope.has_security`
 *   - comparisons          `[artifact.]field == VALUE`, `!= VALUE`
 *     - artifact omitted   implicit resolution: the stage's produced artifacts
 *                          first, then its consumed artifacts (covers the
 *                          shipped `verdict != reject`, `verdict == PASS`)
 *     - VALUES             `[]`, `true`/`false`/`null`, quoted strings,
 *                          numbers, bare tokens (string)
 *
 * OR evaluation is three-valued: any satisfied term passes; an evaluation
 * error only surfaces when no term is satisfied, so
 * `manual_qa.verdict == PASS || !scope.has_runtime` still passes when the
 * manual_qa artifact was legitimately skipped.
 */

import type { ScopeFlags } from "./scope.js";
import { readArtifact } from "./artifacts.js";
import type { Profile, StageDef, TeamState } from "./types.js";

export type PredicateTerm =
  | { kind: "named"; name: string; negated: boolean }
  | { kind: "flag"; flag: keyof ScopeFlags; negated: boolean }
  | { kind: "compare"; artifact: string | null; field: string; op: "==" | "!="; value: unknown; negated: boolean };

export interface PredicateAst {
  terms: PredicateTerm[];
  source: string;
}

export type PredicateParseResult = { ok: true; ast: PredicateAst } | { ok: false; error: string };
export type PredicateResult = { ok: true; value: boolean } | { ok: false; error: string };

const FLAG_KEYS: ReadonlySet<keyof ScopeFlags> = new Set(["has_security", "has_infra", "has_ui", "has_runtime"]);

/**
 * Parse a predicate expression into an AST. This is the load-time gate for
 * profile expressions: anything that fails to parse here is rejected before
 * a run starts instead of silently evaluating to false.
 */
export function parseExpression(expression: string): PredicateParseResult {
  const source = expression.trim();
  if (!source) return { ok: false, error: "empty predicate expression" };
  if (/[()]/.test(source)) {
    return { ok: false, error: `unsupported predicate syntax (parentheses are not supported): '${source}'` };
  }
  const terms: PredicateTerm[] = [];
  for (const raw of source.split(/\s*\|\|\s*/)) {
    const part = raw.trim();
    if (!part) return { ok: false, error: `empty operand in predicate '${source}'` };
    let negated = false;
    let rest = part;
    while (rest.startsWith("!")) {
      negated = !negated;
      rest = rest.slice(1).trim();
    }
    if (!rest) return { ok: false, error: `negated empty operand in predicate '${source}'` };

    const compare = /^(?:([A-Za-z0-9._-]+)\.)?([A-Za-z0-9_-]+)\s*(==|!=)\s*(.+)$/.exec(rest);
    if (compare) {
      const valueText = compare[4]!.trim();
      const value = parsePredicateValue(valueText);
      if (value === undefined) {
        return { ok: false, error: `unsupported value '${valueText}' in predicate '${source}'` };
      }
      terms.push({ kind: "compare", artifact: compare[1] ?? null, field: compare[2]!, op: compare[3] as "==" | "!=", value, negated });
      continue;
    }

    if (rest.startsWith("scope.")) {
      const flag = rest.slice("scope.".length);
      if (!FLAG_KEYS.has(flag as keyof ScopeFlags)) {
        return { ok: false, error: `unknown scope flag '${rest}' in predicate '${source}'` };
      }
      terms.push({ kind: "flag", flag: flag as keyof ScopeFlags, negated });
      continue;
    }

    if (/^[A-Za-z0-9._-]+$/.test(rest)) {
      terms.push({ kind: "named", name: rest, negated });
      continue;
    }

    return { ok: false, error: `unsupported predicate operand '${part}' in '${source}'` };
  }
  return { ok: true, ast: { terms, source } };
}

function parsePredicateValue(text: string): unknown {
  if (text === "[]") return [];
  if (text === "true") return true;
  if (text === "false") return false;
  if (text === "null") return null;
  const quoted = /^"((?:[^"\\]|\\.)*)"$/.exec(text) ?? /^'((?:[^'\\]|\\.)*)'$/.exec(text);
  if (quoted) return quoted[1]!;
  if (/^-?\d+(\.\d+)?$/.test(text)) return Number(text);
  if (text.startsWith("[")) {
    try {
      return JSON.parse(text) as unknown;
    } catch {
      return undefined;
    }
  }
  return text;
}

export interface PredicateContext {
  flags: ScopeFlags;
  artifactsDir: string;
  state: TeamState;
  /** Current stage — drives implicit artifact resolution (produced, then consumed). */
  stage?: StageDef;
  /**
   * Named-gate resolver. Return `null` when the gate holds, a reason string
   * when it fails, or `undefined` when the name is unknown (unsupported).
   */
  namedGate?: (name: string, ctx: PredicateContext) => string | null | undefined;
}

export function evaluatePredicate(expression: string, ctx: PredicateContext): PredicateResult {
  const parsed = parseExpression(expression);
  if (!parsed.ok) return { ok: false, error: parsed.error };
  return evaluateExpression(parsed.ast, ctx);
}

/**
 * Evaluate a parsed predicate. OR semantics are three-valued: the first
 * satisfied term passes; evaluation errors surface only when no term is
 * satisfied, so a satisfied fallback term (e.g. `|| !scope.has_runtime`)
 * keeps the expression passing when the artifact it references is missing.
 */
export function evaluateExpression(ast: PredicateAst, ctx: PredicateContext): PredicateResult {
  let firstError: string | null = null;
  for (const term of ast.terms) {
    const evaluated = evaluateTerm(term, ctx, ast.source);
    if (!evaluated.ok) {
      if (firstError === null) firstError = evaluated.error;
      continue;
    }
    if (evaluated.value) return { ok: true, value: true };
  }
  if (firstError !== null) return { ok: false, error: firstError };
  return { ok: true, value: false };
}

function evaluateTerm(term: PredicateTerm, ctx: PredicateContext, source: string): PredicateResult {
  let value: boolean;
  switch (term.kind) {
    case "flag": {
      value = Boolean(ctx.flags[term.flag]);
      break;
    }
    case "named": {
      if (!ctx.namedGate) {
        return { ok: false, error: `unsupported predicate '${term.name}' (no named-gate resolver) in '${source}'` };
      }
      const result = ctx.namedGate(term.name, ctx);
      if (result === undefined) {
        return { ok: false, error: `unsupported predicate '${term.name}' in '${source}'` };
      }
      value = result === null;
      break;
    }
    case "compare": {
      const resolved = resolveCompareOperand(term, ctx);
      if (!resolved.ok) return { ok: false, error: resolved.error };
      if (resolved.artifact === null || typeof resolved.artifact !== "object" || Array.isArray(resolved.artifact)) {
        return { ok: false, error: `artifact '${resolved.id}' referenced by '${source}' is not an object` };
      }
      if (!Object.prototype.hasOwnProperty.call(resolved.artifact, term.field)) {
        return { ok: false, error: `field '${term.field}' not found in artifact '${resolved.id}' (required by '${source}')` };
      }
      const actual = (resolved.artifact as Record<string, unknown>)[term.field];
      const matches = deepEqual(actual, term.value);
      value = term.op === "==" ? matches : !matches;
      break;
    }
  }
  if (term.negated) value = !value;
  return { ok: true, value };
}

function resolveCompareOperand(
  term: Extract<PredicateTerm, { kind: "compare" }>,
  ctx: PredicateContext,
): { ok: true; artifact: unknown; id: string } | { ok: false; error: string } {
  if (term.artifact) {
    const value = readArtifact(ctx.artifactsDir, term.artifact);
    if (value === null) {
      return { ok: false, error: `artifact '${term.artifact}' referenced by expression is missing` };
    }
    return { ok: true, artifact: value, id: term.artifact };
  }
  const candidates = [
    ...(ctx.stage ? producesOf(ctx.stage) : []),
    ...(ctx.stage?.consumes ?? []),
  ];
  for (const id of candidates) {
    const value = readArtifact(ctx.artifactsDir, id);
    if (value && typeof value === "object" && !Array.isArray(value) && Object.prototype.hasOwnProperty.call(value, term.field)) {
      return { ok: true, artifact: value, id };
    }
  }
  return { ok: false, error: `expression requires a produced or consumed artifact with field '${term.field}'` };
}

function producesOf(stage: StageDef): string[] {
  return Array.isArray(stage.produces) ? stage.produces : stage.produces ? [stage.produces] : [];
}

export function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    return a.every((item, index) => deepEqual(item, b[index]));
  }
  if (a && b && typeof a === "object" && typeof b === "object" && !Array.isArray(a) && !Array.isArray(b)) {
    const aKeys = Object.keys(a).sort();
    const bKeys = Object.keys(b).sort();
    if (aKeys.length !== bKeys.length) return false;
    return aKeys.every((key) => deepEqual((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key]));
  }
  return false;
}

/**
 * Load-time validation of every executable expression a profile declares.
 * Returns actionable diagnostics; an empty array means the profile's
 * gate/skip_if/until/conditional expressions all parse and reference valid
 * targets. Called by the profile registry so unsupported DSL is rejected
 * before a run starts.
 */
export function validateProfileExpressions(profile: Profile): string[] {
  const diagnostics: string[] = [];
  const stageIds = new Set(profile.stages.map((stage) => stage.id));
  for (const stage of profile.stages) {
    if (stage.gate) {
      const parsed = parseExpression(stage.gate);
      if (!parsed.ok) diagnostics.push(`stage '${stage.id}' gate: ${parsed.error}`);
    }
    if (stage.skip_if) {
      const parsed = parseExpression(stage.skip_if);
      if (!parsed.ok) diagnostics.push(`stage '${stage.id}' skip_if: ${parsed.error}`);
    }
    if (stage.loop) {
      if (!stage.loop.back_to || !stageIds.has(stage.loop.back_to)) {
        diagnostics.push(`stage '${stage.id}' loop.back_to '${stage.loop.back_to ?? ""}' is not a stage in the profile`);
      }
      if (!Number.isInteger(stage.loop.max_iterations) || stage.loop.max_iterations < 1) {
        diagnostics.push(`stage '${stage.id}' loop.max_iterations must be an integer >= 1`);
      }
      if (!["escalate_user", "needs_human", "failed"].includes(stage.loop.on_exhausted)) {
        diagnostics.push(`stage '${stage.id}' loop.on_exhausted '${stage.loop.on_exhausted}' must be one of escalate_user|needs_human|failed`);
      }
      if (stage.loop.until) {
        const parsed = parseExpression(stage.loop.until);
        if (!parsed.ok) diagnostics.push(`stage '${stage.id}' loop.until: ${parsed.error}`);
      }
    }
    for (const rule of stage.conditional ?? []) {
      if (!/^(?:!)?scope\.(has_security|has_infra|has_ui|has_runtime)$/.test(rule.if.trim())) {
        diagnostics.push(`stage '${stage.id}' conditional.if '${rule.if}' is not a scope flag expression`);
      }
    }
  }
  return diagnostics;
}
