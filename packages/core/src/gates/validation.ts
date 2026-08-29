/**
 * Validation gate (P6). New in v0.7.0.
 *
 * Inspects produced artifacts of stages that are supposed to ship validated
 * code and blocks the handoff to the next stage if the artifact claims
 * "ready" without evidence that validation was actually run.
 *
 * Motivation: the observed failure mode in session 019fbd62-f1db-7000-
 * 81e5-07f756ebbf87 was a subagent returning `ready: true, validation_run:
 * false, validation_note: "Per assignment, orchestrator owns validation"`.
 * The LLM invented an "assignment" to justify skipping its own validation.
 * A prompt-level "run validation before reporting" was already in the
 * developer agent's frontmatter, but the LLM overrode it because there
 * was no machine-checkable consequence.
 *
 * This gate makes the consequence machine-checkable. A stage that ships
 * `implementation` or `review_fixes` must include:
 *   - `validation_run: true` (string "true" in the JSON, since agents
 *     emit stringified values in the markdown-block output of session
 *     019fbd62; the gate accepts both string "true" and boolean true)
 *   - `validation_evidence` — a non-empty string of build/test output
 *     captured verbatim from the tool run
 *
 * Without those two, the stage is marked `failed` and the orchestrator
 * must re-run it. The orchestrator's only permitted path forward is
 * delegation, not editing the artifact itself.
 *
 * The gate is intentionally narrow: it only inspects the two artifacts
 * named above. Other stages keep the existing trust contract (the
 * DoD backstop catches unfinished work at done-claim time).
 */

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

/** Stage ids whose produced artifact must include a validation block. */
const VALIDATION_REQUIRED_STAGES = new Set(["implementation", "review_fixes"]);

export interface ValidationContext {
  cwd: string;
  /** Stage id (e.g. "implementation") — used to look up the produced artifact. */
  stageId: string;
  /** Artifacts dir for the active feature. */
  artifactsDir: string;
  /** Optional: known produces keys for the stage. */
  produces?: string | string[];
}

export interface ValidationFailure {
  ok: false;
  reason: string;
}

export type ValidationResult = { ok: true } | ValidationFailure;

const FAIL_REASON =
  "Stage claims done without machine-checkable validation evidence. " +
  "Refusing the handoff to keep the orchestrator from inheriting a broken artifact. " +
  "Re-run the stage and include (a) validation_run: true and (b) non-empty " +
  "validation_evidence with the actual build/test output. The orchestrator is a " +
  "dispatcher, not a coder — do NOT edit the artifact to inject fake evidence; " +
  "re-spawn the developer agent with the same task so it can run validation itself.";

/**
 * Run the gate. Returns `{ ok: true }` when validation is present and
 * complete, or `{ ok: false, reason }` with an actionable message that
 * the orchestrator (or main agent) can read verbatim and use as the
 * next prompt to the subagent.
 */
export function validationGate(ctx: ValidationContext): ValidationResult {
  if (!VALIDATION_REQUIRED_STAGES.has(ctx.stageId)) {
    return { ok: true };
  }
  const artifactPath = resolve(ctx.artifactsDir, `${ctx.stageId}.json`);
  if (!existsSync(artifactPath)) {
    return {
      ok: false,
      reason: `${ctx.stageId}.json not found at ${artifactPath}. ${FAIL_REASON}`,
    };
  }
  let artifact: Record<string, unknown>;
  try {
    artifact = JSON.parse(readFileSync(artifactPath, "utf8")) as Record<string, unknown>;
  } catch (e) {
    return {
      ok: false,
      reason: `${ctx.stageId}.json is not valid JSON: ${String(e)}. ${FAIL_REASON}`,
    };
  }
  return checkArtifact(ctx.stageId, artifact);
}

/**
 * Pure check: given the parsed artifact, decide whether validation was
 * actually run. Exported for unit tests so we can drive the gate
 * without filesystem fixtures.
 */
export function checkArtifact(
  stageId: string,
  artifact: Record<string, unknown>,
): ValidationResult {
  if (!VALIDATION_REQUIRED_STAGES.has(stageId)) {
    return { ok: true };
  }
  if (!isReady(artifact)) {
    return {
      ok: false,
      reason: `Artifact for stage "${stageId}" is not claiming ready (ready != "true"). Either complete the work or fail the stage explicitly. ${FAIL_REASON}`,
    };
  }
  if (!isValidationTrue(artifact)) {
    return {
      ok: false,
      reason: `Artifact for stage "${stageId}" reports ready without validation_run: true. ${FAIL_REASON}`,
    };
  }
  const evidence = artifact.validation_evidence;
  if (typeof evidence !== "string" || evidence.trim().length === 0) {
    return {
      ok: false,
      reason: `Artifact for stage "${stageId}" reports validation_run: true but validation_evidence is empty or missing. ${FAIL_REASON}`,
    };
  }
  return { ok: true };
}

function isReady(artifact: Record<string, unknown>): boolean {
  const v = artifact.ready;
  return v === true || v === "true";
}

function isValidationTrue(artifact: Record<string, unknown>): boolean {
  const v = artifact.validation_run;
  return v === true || v === "true";
}
