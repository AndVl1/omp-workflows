/**
 * Shared deterministic autonomy-directive parser for /cto, /do-work and
 * /team.
 *
 * One parser feeds every command surface so the resolved `autonomous` flag
 * and the stripped task text never diverge between commands. It is a
 * leading-directive parser by contract:
 *
 *  - The exact bracket token `[AUTONOMOUS]` enables autonomy. It must be
 *    followed by whitespace or the end of the input; a lookalike such as
 *    `[AUTONOMOUSLY]` (the closing bracket never lands) or `[AUTONOMOUS]`
 *    glued to the task (`[AUTONOMOUS]task`) is NOT a directive — it stays
 *    verbatim in the task text so input is never corrupted.
 *  - A bounded, explicit list of natural-language leading directives
 *    (`действуй автономно`, normalized: case-insensitive, whitespace
 *    collapsed) enables autonomy and is stripped together with an optional
 *    `:`, `,` or `;` separator. No fuzzy keyword matching, no
 *    LLM-dependent mode detection.
 *
 * Anything else is task text, returned verbatim with `autonomous: false`.
 */

/** Exact bracket token that enables autonomous mode. */
export const AUTONOMOUS_TOKEN = "[AUTONOMOUS]";

/**
 * Bounded set of leading natural-language directives equivalent to
 * `[AUTONOMOUS]`. Deliberately small and explicit — adding entries here is
 * a UX decision that must be documented and tested, never inferred.
 */
export const AUTONOMOUS_DIRECTIVES = ["действуй автономно"] as const;

/** Separator characters allowed between a leading directive and the task. */
const DIRECTIVE_SEPARATOR = "[\\s:,;]+";

export interface AutonomousDirective {
  /** True when a recognized directive was present and stripped. */
  autonomous: boolean;
  /**
   * Task text after stripping a recognized leading directive (leading
   * whitespace removed); the verbatim trimmed input when none matched.
   */
  task: string;
}

/** Escape regex metacharacters in a literal directive. */
function escapeRegExp(source: string): string {
  return source.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Build a case-insensitive leading-directive matcher from a literal phrase. */
function directivePattern(directive: string): RegExp {
  const words = directive.split(/\s+/).map(escapeRegExp);
  return new RegExp(`^(?:${words.join("\\s+")})(?:${DIRECTIVE_SEPARATOR}|$)`, "i");
}

const DIRECTIVE_PATTERNS = AUTONOMOUS_DIRECTIVES.map(directivePattern);

/**
 * Parse a raw `<args>` string for the leading autonomy directive.
 *
 * Returns `{ autonomous: true, task }` when an exact `[AUTONOMOUS]` token
 * or an approved natural directive opens the input (token followed by
 * whitespace/EOS; natural directive followed by whitespace/EOS or a
 * `: , ;` separator). Otherwise `{ autonomous: false, task }` with the
 * trimmed input preserved verbatim.
 */
export function parseAutonomousDirective(args: string): AutonomousDirective {
  const trimmed = args.trimStart();

  if (trimmed.startsWith(AUTONOMOUS_TOKEN)) {
    const rest = trimmed.slice(AUTONOMOUS_TOKEN.length);
    // Token must stand alone: whitespace or end of input. `[AUTONOMOUS]task`
    // is ambiguous — keep it literal rather than corrupting the task.
    if (rest === "" || /^\s/.test(rest)) {
      return { autonomous: true, task: rest.trimStart() };
    }
    return { autonomous: false, task: trimmed };
  }

  for (const pattern of DIRECTIVE_PATTERNS) {
    const match = trimmed.match(pattern);
    if (match) {
      return { autonomous: true, task: trimmed.slice(match[0].length).trimStart() };
    }
  }

  return { autonomous: false, task: trimmed };
}
