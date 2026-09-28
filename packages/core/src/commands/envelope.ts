/**
 * Shared deterministic autonomy-directive parser for /cto, /do-work and
 * /team.
 *
 * One parser feeds every command surface so the resolved `autonomyHint` and
 * the stripped task text never diverge between commands. It is a
 * leading-directive parser by contract:
 *
 *  - The exact bracket token `[AUTONOMOUS]` enables the hint. It must be
 *    followed by whitespace or the end of the input; a lookalike such as
 *    `[AUTONOMOUSLY]` (the closing bracket never lands) or `[AUTONOMOUS]`
 *    glued to the task (`[AUTONOMOUS]task`) is NOT a directive — it stays
 *    verbatim in the task text so input is never corrupted.
 *  - A bounded, explicit list of natural-language leading directives
 *    (`действуй автономно`, normalized: case-insensitive, whitespace
 *    collapsed) enables the hint and is stripped together with an optional
 *    `:`, `,` or `;` separator. No fuzzy keyword matching, no LLM-dependent
 *    mode detection.
 *
 * Authority contract (RC2+): the result is a MECHANICAL HINT, never the
 * autonomy decision. PHASE-0 instructs the main LLM to classify
 * `autonomous` from the complete task semantics in any language; this hint
 * is rendered as non-authoritative metadata and must never be copied into
 * persisted state as the decision.
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
  /**
   * MECHANICAL autonomy hint: true when a recognized leading directive was
   * present and stripped. NON-AUTHORITATIVE by contract — the main LLM
   * decides `autonomous` in PHASE-0 from the complete task semantics; this
   * value is rendered as a hint and never persisted.
   */
  autonomyHint: boolean;
  /** Task text after stripping a recognized leading directive. */
  task: string;
}

function escapeRegExp(source: string): string {
  return source.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function directivePattern(directive: string): RegExp {
  const words = directive.split(/\s+/).map(escapeRegExp);
  return new RegExp(`^(?:${words.join("\\s+")})(?:${DIRECTIVE_SEPARATOR}|$)`, "i");
}

const DIRECTIVE_PATTERNS = AUTONOMOUS_DIRECTIVES.map(directivePattern);

export function parseAutonomousDirective(args: string): AutonomousDirective {
  const trimmed = args.trimStart();
  if (trimmed.startsWith(AUTONOMOUS_TOKEN)) {
    const rest = trimmed.slice(AUTONOMOUS_TOKEN.length);
    if (rest === "" || /^\s/.test(rest)) return { autonomyHint: true, task: rest.trimStart() };
    return { autonomyHint: false, task: trimmed };
  }
  for (const pattern of DIRECTIVE_PATTERNS) {
    const match = trimmed.match(pattern);
    if (match) return { autonomyHint: true, task: trimmed.slice(match[0].length).trimStart() };
  }
  return { autonomyHint: false, task: trimmed };
}

export type WorkflowCommandMode = "new" | "resume" | "rework" | "list";

export interface WorkflowCommandParseSuccess {
  ok: true;
  /** Undefined means the user did not freeze lifecycle mode; the model/engine chooses after classification. */
  mode?: WorkflowCommandMode;
  explicit_mode: boolean;
  task: string;
  run_id?: string;
  all_branches?: boolean;
}

export interface WorkflowCommandParseFailure {
  ok: false;
  code: "lifecycle_request_conflict";
  error: string;
}

export type WorkflowCommandParseResult = WorkflowCommandParseSuccess | WorkflowCommandParseFailure;

/** Parse explicit lifecycle options before task text; `--` ends options. */
export function parseWorkflowCommand(args: string): WorkflowCommandParseResult {
  const tokens = [...args.matchAll(/\S+/g)].map((match) => ({ value: match[0]!, start: match.index!, end: match.index! + match[0]!.length }));
  const options: string[] = [];
  let parsingOptions = true;
  let task = "";
  let runId: string | undefined;
  let allBranches = false;
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]!;
    if (!parsingOptions) { task = args.slice(token.start).trim(); break; }
    if (token.value === "--") { parsingOptions = false; const next = tokens[index + 1]; task = next ? args.slice(next.start).trim() : ""; break; }
    if (!token.value.startsWith("--")) { parsingOptions = false; task = args.slice(token.start).trim(); break; }
    if (token.value === "--run") {
      const value = tokens[index + 1]?.value;
      if (!value || value === "--" || value.startsWith("--")) return { ok: false, code: "lifecycle_request_conflict", error: "--run requires a run id" };
      runId = value; index += 1; continue;
    }
    if (token.value.startsWith("--run=")) {
      const value = token.value.slice("--run=".length).trim();
      if (!value) return { ok: false, code: "lifecycle_request_conflict", error: "--run requires a run id" };
      runId = value; continue;
    }
    if (token.value === "--all-branches") { allBranches = true; continue; }
    if (token.value === "--new" || token.value === "--resume" || token.value === "--rework" || token.value === "--list") { options.push(token.value.slice(2)); continue; }
    return { ok: false, code: "lifecycle_request_conflict", error: `unknown workflow option '${token.value}'` };
  }
  const explicitModes = [...new Set(options)];
  if (explicitModes.length > 1) return { ok: false, code: "lifecycle_request_conflict", error: `conflicting lifecycle modes: ${explicitModes.join(", ")}` };
  const explicit = explicitModes[0] as WorkflowCommandMode | undefined;
  const mode = explicit;
  if (runId && mode !== "resume" && mode !== "rework") return { ok: false, code: "lifecycle_request_conflict", error: "--run requires explicit --resume or --rework" };
  if (allBranches && mode !== "list") return { ok: false, code: "lifecycle_request_conflict", error: "--all-branches is valid only with --list" };
  if (mode === "list" && (runId || task)) return { ok: false, code: "lifecycle_request_conflict", error: "--list cannot be combined with --run or task text" };
  if (mode === "new" && !task) return { ok: false, code: "lifecycle_request_conflict", error: "--new requires a task" };
  if (mode === "rework" && !task) return { ok: false, code: "lifecycle_request_conflict", error: "--rework requires feedback" };
  return { ok: true, mode, explicit_mode: explicit !== undefined, task, ...(runId ? { run_id: runId } : {}), ...(allBranches ? { all_branches: true } : {}) };
}
