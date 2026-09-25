/**
 * Validation gate (P6). New in v0.7.0.
 *
 * Inspects produced artifacts of stages that declare validation readiness
 * requirements and blocks the handoff to the next stage when the declared
 * readiness values or evidence requirements are not satisfied.
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
 *   - `validation_evidence` — a non-empty string containing claimed actual
 *     validation output or provenance; authenticity is not machine-verified
 *
 * Without those two, stage readiness is blocked. Preserve any succeeded
 * terminal receipt; replacement work requires explicit lifecycle rework and a
 * fresh capability, and the replacement output must carry actual validation
 * output or provenance rather than fabricated evidence.
 *
 * The gate is intentionally narrow: it only inspects the two artifacts
 * named above. Other stages keep the existing trust contract (the
 * DoD backstop catches unfinished work at done-claim time).
 */

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";


/**
 * Gate-owned producer requirements for code-bearing stages.
 *
 * The declaration is deliberately serializable so workflow contracts and
 * prompts can disclose the same requirements that the gate enforces. The
 * `non_empty` and `provenance` metadata describe the semantic requirement
 * that cannot be represented by the deliberately small artifact-schema
 * validator; `checkArtifact` remains authoritative for that check.
 */
export interface ProducerValidationContract {
  readonly required: readonly ["ready", "validation_run", "validation_evidence"];
  readonly properties: Readonly<{
    ready: Readonly<{ enum: readonly [true, "true"] }>;
    validation_run: Readonly<{ enum: readonly [true, "true"] }>;
    validation_evidence: Readonly<{
      type: "string";
      non_empty: true;
      provenance: "actual_build_test_output_or_provenance";
      description: string;
    }>;
  }>;
}

const ACCEPTED_TRUE_VALUES = Object.freeze([true, "true"] as const);
const PRODUCER_VALIDATION_CONTRACT: ProducerValidationContract = Object.freeze({
  required: Object.freeze(["ready", "validation_run", "validation_evidence"] as const),
  properties: Object.freeze({
    ready: Object.freeze({ enum: ACCEPTED_TRUE_VALUES }),
    validation_run: Object.freeze({ enum: ACCEPTED_TRUE_VALUES }),
    validation_evidence: Object.freeze({
      type: "string" as const,
      non_empty: true as const,
      provenance: "actual_build_test_output_or_provenance" as const,
      description: "Non-empty actual build/test output or provenance captured from the validation run; the gate rejects blank or whitespace-only values.",
    }),
  }),
});

/** Stage ids whose produced artifact must include a validation block. */
const VALIDATION_REQUIRED_STAGES = Object.freeze(["implementation", "review_fixes"] as const);

/**
 * Return the immutable producer contract for a validation-required stage.
 * Stages without this gate consistently return null.
 */
export function validationContractForStage(stageId: string): ProducerValidationContract | null {
  return VALIDATION_REQUIRED_STAGES.includes(stageId as (typeof VALIDATION_REQUIRED_STAGES)[number])
    ? PRODUCER_VALIDATION_CONTRACT
    : null;
}

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
  "Stage readiness requirements are not satisfied. " +
  "Preserve any succeeded worker receipt; this is not a worker failure. " +
  "Do not fabricate evidence, edit the artifact to inject it, or reuse prior completion or dispatch authorization. " +
  "An explicit lifecycle rework with a fresh capability is required before another worker runs; replacement output must include actual validation output or provenance. " +
  "The orchestrator is a dispatcher, not a coder.";

/**
 * Run the gate. A failure is a typed stage-readiness blocker: preserve any
 * succeeded terminal receipt and wait for explicit lifecycle rework before
 * authorizing replacement work.
 */
export function validationGate(ctx: ValidationContext): ValidationResult {
  if (!validationContractForStage(ctx.stageId)) {
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
 * Pure check: given the parsed artifact, enforce its declared readiness
 * values and require nonblank evidence claiming actual output or provenance.
 * Authenticity is not machine-verified. Exported for unit tests so we can
 * drive the gate without filesystem fixtures.
 */
export function checkArtifact(
  stageId: string,
  artifact: Record<string, unknown>,
): ValidationResult {
  const contract = validationContractForStage(stageId);
  if (!contract) {
    return { ok: true };
  }
  const { ready, validation_run: validationRun, validation_evidence: validationEvidence } = contract.properties;
  if (!ready.enum.some((candidate) => candidate === artifact.ready)) {
    return {
      ok: false,
      reason: `Artifact for stage "${stageId}" is not claiming ready (ready != "true"). Either complete the work or fail the stage explicitly. ${FAIL_REASON}`,
    };
  }
  if (!validationRun.enum.some((candidate) => candidate === artifact.validation_run)) {
    return {
      ok: false,
      reason: `Artifact for stage "${stageId}" reports ready without validation_run: true. ${FAIL_REASON}`,
    };
  }
  const evidence = artifact.validation_evidence;
  if (typeof evidence !== "string" || validationEvidence.type !== "string" || (validationEvidence.non_empty && evidence.trim().length === 0)) {
    return {
      ok: false,
      reason: `Artifact for stage "${stageId}" reports validation_run: true but validation_evidence is empty or missing. ${FAIL_REASON}`,
    };
  }
  return { ok: true };
}


