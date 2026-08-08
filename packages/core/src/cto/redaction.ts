/**
 * Deterministic escalation redaction (br-zps.6).
 *
 * Config-driven replacement for the inline sanitize logic that used to live
 * in `escalation.ts`: whole secret-bearing lines are dropped, inline values
 * can be replaced, title/body are truncated, and an empty body falls back to
 * the replacement marker. Pure and deterministic — no randomness, no I/O,
 * never throws.
 *
 * Patterns are regex-literal source strings (e.g. `/Bearer\s+\S+/g`, with
 * delimiters and flags); a bare source (no delimiters) compiles with no
 * flags. Invalid patterns are skipped, so a bad config degrades to a no-op
 * rather than an exception.
 */

import type { Escalation, RedactionConfig } from "./types.js";

/**
 * Default redaction policy — reproduces the historical `sanitizeEscalation`
 * behavior exactly: drop whole lines matching the SECRET_LINE pattern, no
 * inline replacement, title ≤ 120 chars, body ≤ 2000 chars, "[redacted]"
 * for an empty/whitespace body.
 */
export const DEFAULT_REDACTION_CONFIG: RedactionConfig = {
  secret_line_patterns: [
    "/(token|password|passwd|secret|api[_-]?key|authorization|bearer|private[_-]?key)\\s*[:=]/i",
  ],
  inline_value_patterns: [],
  replacement: "[redacted]",
  max_title: 120,
  max_body: 2000,
};

/** Matches slash-delimited regex literals: `/source/flags`. */
const RE_LITERAL = /^\/([\s\S]*)\/([dgimsuvy]*)$/;

/** Compile a pattern string; regex literals keep their flags, bare sources get none. */
function compile(pattern: string): RegExp | null {
  try {
    const literal = RE_LITERAL.exec(pattern);
    if (literal) {
      return new RegExp(literal[1] ?? "", literal[2] ?? "");
    }
    return new RegExp(pattern);
  } catch {
    return null; // invalid pattern — skip, never throw
  }
}

/** Replace every inline value matching any pattern (no-op when patterns is empty). */
function applyInline(value: string, patterns: RegExp[], replacement: string): string {
  let out = value;
  for (const re of patterns) {
    re.lastIndex = 0;
    out = out.replace(re, replacement);
  }
  return out;
}

/** Compile all configured patterns; invalid patterns are skipped (never throw). */
function compileAll(config: RedactionConfig): { secretRes: RegExp[]; inlineRes: RegExp[] } {
  const secretRes: RegExp[] = [];
  for (const pattern of config.secret_line_patterns) {
    const re = compile(pattern);
    if (re) secretRes.push(re);
  }
  const inlineRes: RegExp[] = [];
  for (const pattern of config.inline_value_patterns) {
    const re = compile(pattern);
    if (re) inlineRes.push(re);
  }
  return { secretRes, inlineRes };
}

/**
 * Generalized deterministic redaction pipeline over an arbitrary text body:
 * 1. Drop whole lines matching any `secret_line_patterns`.
 * 2. Replace inline values per `inline_value_patterns`.
 * 3. Truncate to `max_body` chars.
 * 4. Empty/whitespace result becomes the replacement marker.
 *
 * Never throws; identical semantics to the historical `sanitizeEscalation`
 * body path, reusable for report artifact content. A bad pattern degrades to
 * a no-op rather than an exception.
 */
export function redactText(text: string, config: RedactionConfig = DEFAULT_REDACTION_CONFIG): string {
  const { secretRes, inlineRes } = compileAll(config);
  const keptLines = String(text)
    .split("\n")
    .filter(
      (line) =>
        !secretRes.some((re) => {
          re.lastIndex = 0; // `.test()` with g/y flags is stateful — reset for determinism
          return re.test(line);
        }),
    );
  const bodyText = keptLines
    .map((line) => applyInline(line, inlineRes, config.replacement))
    .join("\n")
    .slice(0, config.max_body);
  return bodyText.trim() === "" ? config.replacement : bodyText;
}

/**
 * Deterministic redaction pipeline:
 * 1. Drop whole body lines matching any `secret_line_patterns`.
 * 2. Replace inline values (title + remaining body lines) per `inline_value_patterns`.
 * 3. Truncate title to `max_title` chars, body to `max_body` chars.
 * 4. Empty/whitespace body becomes the replacement marker.
 *
 * Never throws; returns a NEW object `{ ...esc, title, body }` — all other
 * {@link Escalation} fields pass through untouched.
 */
export function redactEscalation(
  esc: Escalation,
  config: RedactionConfig = DEFAULT_REDACTION_CONFIG,
): Escalation {
  const { inlineRes } = compileAll(config);
  const title = applyInline(String(esc.title), inlineRes, config.replacement).slice(0, config.max_title);
  const body = redactText(esc.body, config);
  return { ...esc, title, body };
}
