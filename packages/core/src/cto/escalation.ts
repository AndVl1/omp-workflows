/**
 * Escalation contract for the CTO sub-orchestration.
 *
 * - {@link EscalationAdapter} is the consumer-implemented channel interface
 *   (declared in `types.ts`).
 * - Answers arrive as **files**: `.work-state/cto/<runId>/answers/<escId>.json`
 *   with shape `{ id, answer, at, by }`. The engine / parked agent picks them
 *   up at the next checkpoint — durable across restarts and compaction.
 * - `validateEscalation` guards the shape before an adapter send; engine-level
 *   sanitization (R4) is applied by `runCto` in the engine task.
 */

import { mkdirSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { Escalation, EscalationAnswer } from "./types.js";

const REQUIRED: Array<keyof Escalation> = ["id", "level", "title", "body"];
const LEVELS: Record<string, true> = {
  question: true,
  decision: true,
  needs_human: true,
  blocker: true,
};

/** Lines that look like secrets — dropped whole by sanitizeEscalation (R4). */
const SECRET_LINE = /(token|password|passwd|secret|api[_-]?key|authorization|bearer|private[_-]?key)\s*[:=]/i;
const TITLE_MAX = 120;
const BODY_MAX = 2000;

/**
 * R4 filter applied by the engine before any adapter send: no secrets, no
 * unbounded content. Title truncated to 120 chars, body truncated to 2000
 * chars with secret-bearing lines dropped (a fully-redacted body becomes
 * "[redacted]"). Never throws.
 */
export function sanitizeEscalation(esc: Escalation): Escalation {
  const title = esc.title.slice(0, TITLE_MAX);
  const bodyLines = esc.body.split("\n").filter((line) => !SECRET_LINE.test(line));
  const body = bodyLines.join("\n").slice(0, BODY_MAX) || "[redacted]";
  return { ...esc, title, body };
}

/**
 * Shape-validate an escalation before it reaches an adapter. Returns a
 * human-readable reason, or `null` when the escalation is valid.
 */
export function validateEscalation(esc: Escalation): string | null {
  if (!esc || typeof esc !== "object") return "escalation is not an object";
  for (const key of REQUIRED) {
    const value = esc[key];
    if (typeof value !== "string" || value.trim() === "") {
      return `escalation.${key} must be a non-empty string`;
    }
  }
  if (!LEVELS[esc.level]) return `escalation.level must be one of: ${Object.keys(LEVELS).join(", ")}`;
  if (esc.timeoutMs !== undefined && (typeof esc.timeoutMs !== "number" || esc.timeoutMs < 0)) {
    return "escalation.timeoutMs must be a non-negative number (0 = wait forever)";
  }
  if (esc.options !== undefined) {
    if (!Array.isArray(esc.options)) return "escalation.options must be an array";
    for (const opt of esc.options) {
      if (!opt || typeof opt.id !== "string" || typeof opt.label !== "string") {
        return "escalation.options entries need { id, label }";
      }
      if (opt.apply !== "now" && opt.apply !== "on_next_checkpoint") {
        return 'escalation.options[].apply must be "now" | "on_next_checkpoint"';
      }
    }
  }
  return null;
}

/** Directory holding answer files for a CTO run. */
export function answersDir(runId: string, root: string): string {
  return join(root, ".work-state", "cto", runId, "answers");
}

/** Read all answer files for a run (invalid JSON is skipped, never throws). */
export function readAnswers(runId: string, root: string): EscalationAnswer[] {
  const dir = answersDir(runId, root);
  const out: EscalationAnswer[] = [];
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out; // no answers yet
  }
  for (const name of entries) {
    if (!name.endsWith(".json")) continue;
    try {
      const raw = JSON.parse(readFileSync(join(dir, name), "utf8")) as Partial<EscalationAnswer>;
      if (typeof raw.id === "string" && typeof raw.answer === "string") {
        out.push(raw as EscalationAnswer);
      }
    } catch {
      // garbage file — ignore; idempotent reads must not throw
    }
  }
  return out;
}

/** Ensure the answers directory exists (called by consumers before writing). */
export function ensureAnswersDir(runId: string, root: string): string {
  const dir = answersDir(runId, root);
  mkdirSync(dir, { recursive: true });
  return dir;
}
