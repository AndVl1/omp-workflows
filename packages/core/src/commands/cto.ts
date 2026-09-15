import { DETACHED_BRANCH, MAX_PERSISTED_STATE_BYTES, NO_GIT_BRANCH, normalizePersistedState, parseBoundedPersistedState, resolveActiveBranch, resolveState, updateStateAtomically } from "../engine/state.js";
/**
 * /cto — CTO sub-orchestration command (core contract).
 *
 * Part of the CTO/Head mode: the CTO agent receives a task, decomposes it
 * into a TeamPlan (up to 8 teams, depth 2), each team runs a sub-workflow
 * profile with its own lead + roster, escalations to the user are
 * asynchronous through an EscalationAdapter, and work continues while the
 * user answers.
 *
 * Same two-layer contract as `/do-work`: custom-TS commands have no `task`
 * surface, so this command returns a fully-formed prompt that the main agent
 * executes mechanically through its own `task`/`hub`. Consumers re-export the
 * contract through thin project-local discovery adapters.
 *
 * Design: vibe-report/sub-orchestration-2026-08-04.md
 */

import { closeSync, constants, existsSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, realpathSync, renameSync, statSync, unlinkSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { TextDecoder } from "node:util";
import { findProfileDir } from "../engine/profile.js";
import { MAX_CHECKPOINT_RATIONALE_BYTES } from "../engine/durable.js";
import { ctoMappingConfirmationProofRelativePath, ctoMappingConfirmationStateDigest, readCtoMappingConfirmationProof, removeCtoMappingConfirmationProof, signCtoMappingConfirmationProof, writeCtoMappingConfirmationProof, type CtoMappingConfirmationProof, type CtoMappingConfirmationProofAnswer, type CtoMappingConfirmationProofPayload } from "../engine/cto-mapping-proof.js";
import { buildCtoSpecificationMapping, loadTeamDefs } from "../cto/plan.js";
import { resolveChannelProfile } from "../cto/channels.js";
import {
  isCtoRunTerminal,
  isSafeCtoExecutionId,
  isSafeCtoRunId,
  readCtoRunDeliveryReconciledActiveCandidatesPinned,
  hasValidCtoRuntimeRunOriginPinned,
  hasValidCtoRuntimeStateProofPinned,
  readCtoStatePinned,
  resolveCtoAutonomous,
  setTeamStatus,
  writeCtoStateLocked,
} from "../cto/state.js";
import { isCtoSpecificationSafeId, MAX_CTO_SPECIFICATION_AGGREGATE_BYTES, MAX_CTO_SPECIFICATION_REQUESTS, MAX_CTO_SPECIFICATION_TEXT_BYTES, MAX_DECOMPOSITION_DEPTH, MAX_TEAMS, type CtoState, type TeamDef } from "../cto/types.js";
import { reconcileCtoSpecificationExecutionTeams, type CtoSpecificationExecutionMappingAuthority, type CtoSpecificationExecutionMappingAuthorityValidationInput, type CtoSpecificationExecutionMappingAuthorityValidator, type CtoSpecificationPreparationTeam } from "../cto/specification-execution.js";
import type { ModelClassification } from "../engine/run.js";
import { parseAutonomousDirective } from "./envelope.js";
import { renderConstitutionImpactToolContract, renderConstitutionToolContract } from "./constitution.js";
import { buildClassificationPhaseZero, buildWorkflowMatrix } from "./classification-contract.js";
import type { CommandContext } from "./types.js";
import { acquireExecutionClaim, executionClaimAuthorizationProjectionDigest, isLiveExecutionClaim, readCurrentExecutionClaim, releaseExecutionClaim, verifyExecutionClaimAdmissionBindingPinned, workspaceAdmissionDigest, type ExecutionClaimAcquisitionDisposition } from "../specification/claims.js";
import { revalidateImportedHandoffForDispatch, type ImportedHandoffFilesystemDispatchInput } from "../specification/import.js";
import { ensureProjectConstitution, readProjectConstitutionGate } from "../specification/prerequisite.js";
import { featureArtifactsDir, featureStatePath, persistFeatureWorkspace, resolveFeatureWorkspace, type WorkspaceRootSnapshot } from "../specification/workspace.js";
import { canonicalJson, digestOf, implementationConformanceMatrixDigest, isSafeFeatureId, isSha256Hex, sha256Hex } from "../specification/validation.js";
import { MAX_CTO_MAPPING_RECORD_BYTES, readPinnedCtoMappingRecord, validateCtoMappingRecord } from "../specification/mapping-record.js";
import { evaluateHandoffReadiness } from "../specification/handoff.js";
import { readCanonicalHandoff } from "../specification/canonical-reader.js";
import { readArtifactPinned, readPinnedArtifactSnapshot } from "../engine/artifacts.js";
import { validateProducedArtifact } from "../engine/artifact-contract.js";
import { assertCtoSliceDispatchable } from "../cto/slice-gate.js";
import type { CtoSpecificationExecutionSelection as DomainSelection, CtoSpecificationExecutionPreflightInput as DomainPreflightInput, CtoSpecificationExecutionPreflightResult as DomainPreflightResult } from "../cto/gates.js";
import { readCtoSpecificationConstitution, readCtoWorkspaceConstitution } from "../cto/gates.js";
import { preflightCtoSpecificationExecution as domainPreflight, preflightCtoSpecificationExecutionPinned as domainPreflightPinned } from "../cto/gates.js";
import type { ExecutionClaim, ExecutionClaimAdmissionBinding, FeatureWorkspace, ImplementationConformanceResult, ImplementationHandoff } from "../specification/types.js";
import type { CtoSpecificationMapping } from "../cto/types.js";
import type { CheckpointAnswerProof, CheckpointActor, CompletionEnvelope, TeamState, WorkIdentity } from "../engine/types.js";
import { checkpointPolicyHash, checkpointWorkIdentityHash, consumeTrustedCheckpointAnswer, issueTrustedCheckpointAnswerCapability, recordTrustedCheckpointAnswer, nativeCheckpointPolicy, trustedCheckpointAnswerError, type TrustedCheckpointRootIdentity } from "../engine/checkpoints.js";
import { withCtoRunLock, withCtoRunLockAsync } from "../cto/transaction-lock.js";
import { computeCtoTerminalTeamsDigest, ctoConformanceClaimsDigest, ctoMandatoryQualityGateIssues, ctoMandatoryQualityGateSpecs, ctoMappingExecutionMatchesWave, issueCtoSpecificationConformanceBinding, readCtoSpecificationConformanceReceipt, readCtoSpecificationConformanceAuthority, terminalConformanceEvidenceError, type CtoActiveClaimSummary, type ConformanceEvidence, type CtoSpecificationConformanceHandoff, type CtoSpecificationConformanceBinding, type CtoSpecificationConformanceReceipt } from "../specification/conformance.js";
import { PinnedProjectRoot, PinnedRootError } from "../specification/pinned-root.js";
import { assertCtoRuntimeAccessFacadeLive, isSafeCtoRuntimeSessionId, type CtoRuntimeAccessFacade } from "../cto/runtime-access.js";
import { validateTypedControlPlane } from "../engine/workflow-contract.js";

export interface ParsedCtoEnvelope {
  task: string;
  /**
   * MECHANICAL hint from the leading-directive parser. NON-AUTHORITATIVE:
   * PHASE-0 has the main LLM decide `autonomous` from the full task
   * semantics; this value is rendered as a hint and never persisted as the
   * decision.
   */
  autonomyHint: boolean;
  issue: number | null;
  branch: string | null;
  /**
   * Explicit `/cto` execution selectors parsed from the public argument
   * string. The order is user authority and must survive prompt retries.
   * Optional keeps hand-authored envelopes from older hosts source-compatible.
   */
  specificationSelections?: readonly CtoSpecificationExecutionSelection[];
  specificationSelectionError?: {
    code: "CTO_SPEC_ARGUMENT_INVALID" | "CTO_SPEC_SELECTOR_AMBIGUOUS";
    message: string;
  };
}

/**
 * Parse the raw `<args>` string for `/cto`.
 * Recognized syntax: `[AUTONOMOUS] <task description> [issue=#N]`, plus the
 * approved leading natural-language directives from the shared parser
 * (`действуй автономно`). Lookalike prefixes stay literal task text.
 * Outside a git work tree `branch` is `null` instead of an error.
 */
export function parseEnvelope(args: string, cwd: string): ParsedCtoEnvelope {
  if (typeof args !== "string") {
    return {
      task: "",
      autonomyHint: false,
      issue: null,
      branch: null,
      specificationSelectionError: { code: "CTO_SPEC_ARGUMENT_INVALID", message: "arguments must be a string" },
    };
  }
  if (Buffer.byteLength(args, "utf8") > MAX_CTO_SPECIFICATION_AGGREGATE_BYTES) {
    return {
      task: "",
      autonomyHint: false,
      issue: null,
      branch: null,
      specificationSelectionError: {
        code: "CTO_SPEC_ARGUMENT_INVALID",
        message: `arguments exceed ${MAX_CTO_SPECIFICATION_AGGREGATE_BYTES} bytes`,
      },
    };
  }
  const directive = parseAutonomousDirective(args);
  const autonomyHint = directive.autonomyHint;
  const cleaned = directive.task;
  const issueMatches = cleaned.match(/(?:^|\s)issue=#\d+(?=\s|$)/g) ?? [];
  let issueError: ParsedCtoEnvelope["specificationSelectionError"];
  if (issueMatches.length > 1) {
    issueError = { code: "CTO_SPEC_ARGUMENT_INVALID", message: "issue metadata may be supplied exactly once" };
  }
  const issueMatch = issueMatches.length === 1 ? /(?:^|\s)issue=#(\d+)(?=\s|$)/.exec(cleaned) : null;
  const issueDigits = issueMatch?.[1] ?? "";
  if (issueMatch && (issueDigits.length > 15 || !Number.isSafeInteger(Number(issueDigits)) || Number(issueDigits) <= 0)) {
    issueError = { code: "CTO_SPEC_ARGUMENT_INVALID", message: "issue metadata must be a positive safe numeric identifier" };
  }
  const issue = issueMatch && !issueError ? Number(issueDigits) : null;
  const withoutIssue = (issueMatch && !issueError ? cleaned.replace(issueMatch[0], "") : cleaned).trim();
  const parsedSelectors = parseCtoSpecificationExecutionSelections(withoutIssue);
  const task = parsedSelectors.error ? withoutIssue : parsedSelectors.task.trim();
  const activeBranch = resolveActiveBranch(cwd);
  const branch = activeBranch === NO_GIT_BRANCH || activeBranch === DETACHED_BRANCH ? null : activeBranch;
  const parseError = issueError ?? parsedSelectors.error;
  return {
    task,
    autonomyHint,
    issue,
    branch,
    ...(parsedSelectors.selections.length > 0 ? { specificationSelections: parsedSelectors.selections } : {}),
    ...(parseError ? { specificationSelectionError: parseError } : {}),
  };
}

/*
 * Keep this declaration adjacent to the envelope parser's public contract:
 * hosts that call `parseEnvelope` receive one canonical parse, rather than
 * re-parsing raw `$ARGUMENTS` independently and potentially losing ordering.
 */
function parsedCtoSelections(envelope: ParsedCtoEnvelope): ParsedCtoSpecificationSelections {
  if (envelope.specificationSelectionError) {
    return {
      selections: [],
      task: envelope.task,
      error: envelope.specificationSelectionError,
    };
  }
  if (envelope.specificationSelections !== undefined) {
    return {
      selections: [...envelope.specificationSelections],
      task: envelope.task,
    };
  }
  return parseCtoSpecificationExecutionSelections(envelope.task);
}

/**
 * Render the complete public cto_prepare payload for the execution route.
 * This is deliberately engine-owned: the resident agent copies the object and
 * never reverse-engineers the zod schema or handoff files while constructing it.
 */
function renderCtoPrepareTemplate(
  _cwd: string,
  envelope: ParsedCtoEnvelope,
  selections: readonly CtoSpecificationExecutionSelection[],
  sessionId?: string,
): string {
  const safeSession = (sessionId ?? "wave").replace(/[^A-Za-z0-9._-]/gu, "-").replace(/^-+|-+$/gu, "") || "wave";
  // The public preparation input intentionally contains no decomposition. The
  // mounted engine reads each selected, frozen handoff and derives task rows;
  // rendering rows here would let the model invent task ids or ownership.
  return JSON.stringify({
    cto_run_id: `cto-execution-${safeSession}`,
    task: envelope.task,
    branch: envelope.branch ?? "main",
    selections: selections.map((selection) => ({ ...selection })),
  }, null, 2);
}

export interface CtoSpecificationPreparationUnresolvedTask {
  feature_id: string;
  run_key: string;
  task_ref: { feature_id: string; task_id: string };
  affected_scope: string[];
  depends_on: string[];
  dod: CtoSpecificationPreparationTeam["dod"];
  candidates: Array<{ id: string; scope: string[] }>;
  reason: "unmatched" | "ambiguous";
}

export interface CtoSpecificationPreparationDerivation {
  teams: CtoSpecificationPreparationTeam[];
  unresolved: CtoSpecificationPreparationUnresolvedTask[];
  findings: string[];
}

function preparationScopeCovered(target: string, owner: string): boolean {
  const normalizedTarget = target.trim().replace(/^\.\//u, "").replace(/\/+$/u, "");
  const normalizedOwner = owner.trim().replace(/^\.\//u, "").replace(/\/+$/u, "");
  if (!normalizedTarget || !normalizedOwner) return false;
  return normalizedTarget === normalizedOwner || normalizedTarget.startsWith(normalizedOwner + "/");
}

function preparationTeamCandidates(featureId: string, task: ImplementationHandoff["tasks"][number], defs: readonly TeamDef[]): TeamDef[] {
  const taskScopes = task.affected_scope.length > 0 ? task.affected_scope : [featureId];
  return defs
    .filter((def) => taskScopes.every((taskScope) => def.scope.some((teamScope) =>
      taskScopes.length === 1 && taskScope === featureId
        ? teamScope === featureId
        : preparationScopeCovered(taskScope, teamScope),
    )) || def.scope.some((teamScope) => teamScope === featureId))
    .sort((left, right) => left.id.localeCompare(right.id));
}
function preparationTaskArtifactContract(featureId: string): string {
  const artifactDirectory = `.work-state/features/${featureId}/artifacts`;
  const conformanceEvidenceId = `conformance_evidence-${featureId}`;
  const qualityGateEvidenceId = `quality_gate_evidence-${featureId}`;
  return [
    `canonical conformance evidence artifact_id '${conformanceEvidenceId}' at '${artifactDirectory}/${conformanceEvidenceId}.json'`,
    "canonical conformance envelope top-level keys exactly {schema_version,artifact_id,entries}; canonical quality-gate envelope top-level keys exactly {schema_version,artifact_id,gates}; no extra top-level source_artifact, kind, source, or gate fields",
    `canonical quality gate evidence artifact_id '${qualityGateEvidenceId}' at '${artifactDirectory}/${qualityGateEvidenceId}.json'`,
    "quality gate evidence MUST be written first with every gate evidence_refs exactly []; then write exactly one supporting runtime_test_evidence-<feature_id>.json conformance_evidence envelope whose inner executed_test refs point to that quality ref; finally write conformance_evidence-<feature_id>.json whose outer executed_test refs point to the supporting runtime envelope; never rewrite referenced artifacts; standalone implementation_evidence-* and runtime_test_evidence-* refs outside that typed envelope are forbidden",
  ].join("; ");
}

function preparationTaskDod(
  featureId: string,
  task: ImplementationHandoff["tasks"][number],
  handoff: ImplementationHandoff,
): CtoSpecificationPreparationTeam["dod"] {
  const evidence = [...new Set([
    ...task.completion_evidence,
    ...handoff.verification
      .filter((verification) => verification.task_ids.includes(task.task_id))
      .map((verification) => verification.expected_evidence),
  ])];
  const verifyMethod = evidence.length > 0 ? evidence.join("; ") : "typed worker evidence";
  return {
    items: [{
      id: `dod-${digestOf({ kind: "cto-preparation-task", feature_id: featureId, task_id: task.task_id }).slice(0, 32)}`,
      source: "implementation_handoff",
      criterion: task.expected_outcome,
      verify_method: `${verifyMethod}; ${preparationTaskArtifactContract(featureId)}`,
      status: "pending",
      evidence: "",
    }],
    type_requirements_met: true,
  };
}

/**
 * Derive the strict preparation rows from the canonical selected handoffs.
 * Callers supply selectors only; task ids, dependencies, scope, ownership,
 * and DoD are copied from the pinned handoff and never accepted from the model.
 */
export function deriveCtoSpecificationPreparationTeams(
  root: string,
  selections: readonly CtoSpecificationExecutionSelection[],
  defs: readonly TeamDef[],
  pinnedRoot: PinnedProjectRoot,
): CtoSpecificationPreparationDerivation {
  const teams: CtoSpecificationPreparationTeam[] = [];
  const unresolved: CtoSpecificationPreparationUnresolvedTask[] = [];
  const findings: string[] = [];
  for (const selection of selections) {
    const loaded = loadHandoff(root, selection, undefined, pinnedRoot);
    if (!loaded.ok) {
      findings.push(`${selection.feature_id}/${selection.run_key}: ${loaded.error}`);
      continue;
    }
    for (const task of loaded.handoff.tasks) {
      const dod = preparationTaskDod(selection.feature_id, task, loaded.handoff);
      const candidates = preparationTeamCandidates(selection.feature_id, task, defs);
      const unresolvedRow = {
        feature_id: selection.feature_id,
        run_key: selection.run_key,
        task_ref: { feature_id: selection.feature_id, task_id: task.task_id },
        affected_scope: [...task.affected_scope],
        depends_on: [...task.depends_on],
        dod,
      };
      if (candidates.length !== 1) {
        const reason = candidates.length === 0 ? "unmatched" : "ambiguous";
        unresolved.push({
          ...unresolvedRow,
          candidates: candidates.map((candidate) => ({ id: candidate.id, scope: [...candidate.scope] })),
          reason,
        });
        findings.push(`${selection.feature_id}/${task.task_id}: TeamDef scope is ${reason}; preserve candidates for the mapping checkpoint`);
        continue;
      }
      const team = candidates[0]!;
      teams.push({
        team: team.id,
        task_ref: unresolvedRow.task_ref,
        scope: [...team.scope],
        profile: team.profile,
        worktree: "same_branch",
        depends_on: unresolvedRow.depends_on,
        classification: { type: "FEATURE", complexity: "MEDIUM", confidence: "HIGH", autonomous: true, workflow: "standard" },
        workflow: "standard",
        dod,
      });
    }
  }
  return { teams, unresolved, findings };
}


function renderTeamsTable(cwd: string): string {
  const teams = loadTeamDefs(cwd);
  if (teams.length === 0) {
    return [
      "| (no teams configured) | | | | | |",
      "",
      "> Create `.omp/teams.json` (array of TeamDef: id, name, scope, profile, lead, roster) to",
      "> register your development teams. Without teams the CTO cannot decompose.",
    ].join("\r\n");
  }
  return teams
    .map((t) => `| \`${t.id}\` | ${t.name} | \`${t.scope.join(", ")}\` | \`${t.profile}\` | \`${t.lead}\` | ${t.roster.map((r) => `\`${r}\``).join(", ")} |`)
    .join("\r\n");
}

/**
 * Render the user-communication channel section. Drives off the single
 * resolved channel profile (cto/channels.ts — architecture-4), which
 * normalizes both legacy {adapter,bidirectional,http,telegram} and explicit
 * `channels[]` configs:
 * - direction "rw" (validated inbound + outbound): messenger mode — ALL user
 *   questions go through the outbox (outbox -> answers/), the `ask` tool is
 *   blocked.
 * - direction "ro" (push-only sink): report-only — `ask` stays available for
 *   interactive checkpoints.
 * - direction "none": use `ask`.
 */
export function renderChannelSection(cwd: string): string {
  const profile = resolveChannelProfile(cwd);
  if (profile.direction === "rw") {
    const ack = profile.ackTarget ? `, ack target \`${profile.ackTarget}\`` : "";
    const primary = profile.primary ? ", primary" : "";
    return [
      "### User channel (messenger, BIDIRECTIONAL) — VALIDATED RW-PRIMARY",
      `Resolved channel profile: direction \`rw\` (transport ${profile.transport ?? "unknown"}, adapter ${profile.adapter ?? "unknown"}${ack}${primary}) —`,
      "validated inbound + outbound. Messenger mode: ALL user communication goes through the mounted",
      "channel/runtime; emit checkpoints as typed escalations, and let the runtime persist outbox/answers.",
      "Never write `.work-state/cto` outbox or answer files directly.",
      "- Inbound tasks/answers arrive via this channel — `[CTO-INBOX]` messages are USER COMMANDS.",
      "- NEVER use the `ask` tool — it is blocked while this channel is active.",
      "- Blocking waits park the team (`background_wait`); everything else continues.",
      "- In standby: tasks arrive as `[CTO-INBOX]` messages — treat each as a USER COMMAND to the",
      "  main-session CTO: fold it into the run (amend discipline) and return to standby after the wave.",
    ].join("\r\n");
  }
  if (profile.direction === "ro") {
    const adapter = profile.adapter ?? "unknown";
    const firstLine =
      adapter === "http"
        ? "An HTTP channel is configured but it is PUSH-ONLY (no feedback path)."
        : `A report-only channel is configured (adapter ${adapter}) — PUSH-ONLY (no feedback path).`;
    return [
      "### User channel (push-only) — RO-REPORT",
      firstLine,
      "Capability mode RO-REPORT: the channel is a push-only report sink — escalations are advisory and",
      "NEVER inbound; `ask` stays available for interactive checkpoints.",
      "Use `ask` for interactive checkpoints; escalations sent over the channel are advisory.",
    ].join("\r\n");
  }
  return [
    "### User channel (none) — TERMINAL-ONLY",
    "No escalation channel configured (capability mode TERMINAL-ONLY, direction `none`): no channel exists.",
    "Use the `ask` tool for checkpoints (local ask fallback).",
  ].join("\r\n");
}

/**
 * Build the CTO STANDBY prompt: CTO mode with no task yet. The agent persists
 * a standby run (so the run is active: amend detection, inbox routing and the
 * per-turn reminder all key off it), yields, and waits for `[CTO-INBOX]`
 * tasks (injected by the messenger dispatcher or dropped in
 * `.work-state/cto/<id>/inbox/`).
 */
export function buildStandbyCtoPrompt(cwd: string): string {
  return [
    "/cto STANDBY — CTO sub-orchestration is ON with NO task yet. Execute this contract YOURSELF, in this session.",
    "",
    "### You are the CTO (standby)",
    "You ARE the orchestrator — and you are THE MAIN AGENT of this session, the resident CTO.",
    "Do NOT invent work while waiting. Do NOT delegate the orchestrator role.",
    "The CTO is never spawned: NEVER run `task(agent=cto)` or `task(agent=@cto)` — not mechanically,",
    "not by text. `/cto` executes in-session; this session IS the CTO.",
    "",
    "### Standby steps",
    "1. **Use engine-owned standby state NOW**: inspect the latest active standby through the host/runtime",
    "   and reuse its id/inbox when supplied. If no standby exists, the host must create it; the CTO/model",
    "   must not write `.work-state/cto`, state.json, waves, or inbox files directly. The engine-created",
    "   standby has `pause.kind: \"none\"`, no task classification, and remains adoptable across sessions.",
    "2. Read `.omp/teams.json` + `cto.json` profile now (not later) so the wake turn is cheap.",
    "3. Drain the adopted run's pending inbox before yielding, then yield and WAIT.",
    "",
    "### Tasks arrive two ways",
    "- A `[CTO-INBOX]` user message (injected by the messenger dispatcher), or",
    "- files in `.work-state/cto/<id>/inbox/*.json` ({ id, text, at, by }).",
    "`[CTO-INBOX]` messages ARE USER COMMANDS — direct instructions to you, the main-session CTO:",
    "no new session, no subagent dispatch. On EACH wake: treat the payload as a `/cto <task>` command",
    "and fold it into THIS run (amend discipline: re-plan, spawn leads in parallel, integration covers",
    "ALL teams). Multiple tasks = multiple sequential waves; do not merge them into one team.",
    "",
    "### After each wave",
    "Stay on-line when a wave completes — you remain the CTO of this session. Close the wave",
    "(integration + summary), keep the run active, and return to standby: yield and wait for the",
    "next `[CTO-INBOX]` task (or `inbox/` file) to fold in.",
    "**The run id NEVER changes across follow-up waves.** Every inbox task is a NEW engine-owned wave",
    "in the SAME state.json. Ask the host/runtime to append and close the wave; never use `write`/`edit`",
    "to mutate state, classifications, workflows, DoD, or active-wave pointers. For ready specifications",
    "use the mounted four-tool confirmation sequence before any dispatch; the engine enforces every gate.",
    "",
    "### Your rules (abridged)",
    "**The run id NEVER changes across follow-up waves.** Every inbox task is a NEW engine-owned wave",
    "in the SAME state.json. Ask the host/runtime to append or close waves; never use `write`/`edit` to",
    "mutate state, classifications, workflows, DoD, or active-wave pointers. For ready specifications",
    "use the mounted four-tool confirmation sequence before any dispatch; the engine enforces every gate.",
    "",
    "Begin: ask the host/runtime for the engine-owned standby, read the registry, yield.",
  ].join("\r\n");
}

/**
 * Options that affect prompt rendering (session identity for ownership).
 */
export interface CtoPromptOptions {
  /**
   * OMP session id of the interactive session that invoked `/cto`. Rendered
   * into the persistence contract so the run records its owner; a foreign
   * session cannot amend an owned run (see findActiveCtoRun).
   */
  sessionId?: string;
}

/** Persistence contract lines shared by the CTO task/amend prompts. */
function persistenceContract(opts: CtoPromptOptions): string {
  const sessionLine = opts.sessionId ? `current session: \`${opts.sessionId}\`` : "current session: <engine-provided session id>";
  return [
    "### Engine-owned preparation (mandatory)",
    "Do not write `.work-state/cto`, state.json, waves, identities, mappings, claims, or DoD files yourself.",
    "Do not call a generic workflow preparation tool for CTO execution. The mounted `cto_prepare` tool",
    "owns the pinned session root, strict owner/main-session checks, frozen-handoff task/DoD derivation, TeamDef scope resolution, CAS",
    "and idempotent fresh-run preparation; " + sessionLine + ".",
    "The engine returns only non-secret run/wave/slice identities. Never request, print, copy, or infer",
    "capability or dispatch secrets.",
  ].join("\r\n");
}

function ctoConformanceArtifactNamingContract(): string[] {
  return [
    "   Engine-derived canonical ids are exact per selected feature: `conformance_evidence-<feature_id>` and `quality_gate_evidence-<feature_id>`. Their exact filenames and full repo-relative paths are `.work-state/features/<feature_id>/artifacts/conformance_evidence-<feature_id>.json` and `.work-state/features/<feature_id>/artifacts/quality_gate_evidence-<feature_id>.json`.",
    "   The conformance envelope top-level shape MUST be exactly `{schema_version,artifact_id,entries}` and the quality-gate envelope top-level shape MUST be exactly `{schema_version,artifact_id,gates}`. NEVER add top-level `source_artifact`, `kind`, `source`, or `gate` fields.",
    "   Alternate generic, worker/role-suffixed, team-suffixed, or other ids and filenames are forbidden. Leads MUST pass these exact two ids and full paths unchanged to implementation and QA workers.",
    "   Every CompletionArtifactRef MUST use `schema_status` values only `met` or `failed` and `quality_gate_status` values only `met`, `pending`, or `failed`; legacy `verified` and `pass` values are forbidden. Its `sha256` MUST be exactly 64 lowercase hexadecimal characters, and its `path` MUST equal the exact feature-local artifact path above.",
    "   Canonical artifact topology is a three-level acyclic DAG: QA MUST write `quality_gate_evidence-<feature_id>.json` first with every persisted gate `evidence_refs` exactly `[]`; then write one supporting `runtime_test_evidence-<feature_id>.json` canonical `conformance_evidence` envelope whose required `executed_test` rows have inner `test.evidence_ref` exactly the current quality-envelope ref; finally write `conformance_evidence-<feature_id>.json` whose outer `executed_test.test.evidence_ref` values are exactly that supporting runtime-envelope ref. NEVER rewrite a referenced artifact. Standalone `implementation_evidence-*` and `runtime_test_evidence-*` refs outside this typed supporting envelope are forbidden.",
  ];
}

function ctoLeadContractPropagationContract(): string[] {
  return [
    "   For every claimed dispatch outcome, copy that outcome's `lead_contract` object verbatim into the corresponding lead task; do not reconstruct, edit, or omit any field.",
    "   Each lead MUST copy the exact `lead_contract` verbatim into every implementation and QA worker task. This typed contract is complete; workers MUST NOT read artifacts-schema.json or infer alternate keys, enums, ids, or paths.",
    "   Workers MUST NOT persist an `artifact` wrapper field on conformance entries; the engine alone adds that derived wrapper during fan-in. Quality-gate findings MUST be objects with exactly `{code,subject_id,message,evidence_refs}` and `evidence_refs` MUST be a string array; never emit a string finding.",
    "   Review verdict contract: a `review` entry's `review_verdict` MUST be exactly `pass` or `fail` (no `blocked`, prose, prefixes, or suffixes). Put explanations in `intent_message` or a quality-gate finding; a blocked review is represented by `review_verdict: fail`.",
    "   Identifier contract: EVERY `evidence_id` and EVERY `artifact_id` (including nested artifact references) MUST be a non-empty opaque slug matching `^[A-Za-z0-9._-]+$` and no more than 128 UTF-8 bytes. Never put raw JSON, newlines, tool output, or prose in an id; explain content only in text fields.",
    "   Canonical bounds contract: conformance `entries` has 1..256 items; each quality gate has at most 64 evidence_refs and 128 findings; each finding has at most 64 evidence_refs; every line-inert field is at most 16,384 UTF-8 bytes; the aggregate canonical evidence text is at most 2,097,152 bytes; nested evidence depth is at most 4. Do not exceed any engine bound.",
    "   Identity/digest contract: every evidence entry's `handoff_digest` MUST match the frozen `artifact_contract.bindings.handoff_digest` and be exactly 64 lowercase hex characters; every entry's `execution_claim_id` MUST match `artifact_contract.bindings.execution_claim_id`. Preserve subject_id, requirement_id, test status, and timestamp fields unchanged when copying outer rows into the supporting runtime envelope.",
    "   Runtime multiset contract: supporting `runtime_test_evidence-<feature_id>` executed-test rows MUST equal the complete outer executed_test multiset by `evidence_id`, `kind`, `subject_id`, `requirement_id`, `test_kind`, `status`, `executed_at`, `handoff_digest`, and `execution_claim_id`; no missing, extra, or duplicate row is allowed. Contradictory pass/fail review or test rows for one subject block closure; an intent conflict yields `changed_intent`, never a passing status.",
    "   Timestamp contract (copy verbatim to implementation and QA workers): every `recorded_at`, nested `executed_at`, and quality `evaluated_at` MUST match `^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z$`; valid example `2026-01-01T00:00:00.000Z`; invalid examples `2026-01-01T00:00:00.30503000Z` and `2026-01-01T00:00:00.818575000Z`. Never use shell `date`, `%N`, or host-specific fractional precision: generate with ECMAScript `new Date().toISOString()` or deterministically trim to exactly 3 fractional digits before writing.",
  ];
}

/**
 * Build the CTO workflow prompt the main agent will execute.
 */
function buildExecutionCtoPrompt(envelope: ParsedCtoEnvelope, cwd: string, opts: CtoPromptOptions = {}): string {
  const profilePath = join(findProfileDir(), "cto.json");
  const profileSection = existsSync(profilePath)
    ? `Workflow profile: \`${profilePath}\` — read exactly this one file for the stage list, gates, checkpoints, produces/consumes.`
    : "Workflow profile: `cto.json` not shipped yet — use the stage skeleton below and write the typed artifacts per stage.";

  const issueMeta = envelope.issue ? `Issue: #${envelope.issue}\r\n` : "";
  const branchMeta = envelope.branch
    ? `Branch: \`${envelope.branch}\` (canonical session branch; persist this exact value)\r\n`
    : "Branch: (no git work tree; strict workflow transitions cannot start)\r\n";
  const sessionMeta = opts.sessionId ? `Session: \`${opts.sessionId}\`\r\n` : "";
  const parsedSelectors = parsedCtoSelections(envelope);
  const requestedSelectorsJson = JSON.stringify(parsedSelectors.selections);
  const firstSelectorPayload = JSON.stringify({ selections: parsedSelectors.selections });
  const ctoPrepareTemplate = renderCtoPrepareTemplate(cwd, envelope, parsedSelectors.selections, opts.sessionId);

  return [
    "/cto workflow — execute this prompt IN-SESSION: you are the MAIN AGENT, the resident CTO.",
    "You are never dispatched for this — `/cto` runs here.",
    "",
    "### You are the CTO",
    "You ARE the orchestrator — execute this contract YOURSELF, in this session, as the resident",
    "CTO (main-session role). NEVER run `task(agent=cto)` or `task(agent=@cto)`: the CTO role has",
    "no nested form — spawning one is forbidden even by text.",
    "Do NOT delegate the orchestrator role to a sub-agent (no sub-CTO): a delegated CTO",
    "eats a nesting level and breaks the lead/worker toolset (depth contract: main(CTO) ->",
    "lead -> worker, max 3 levels). You spawn leads via `task`; you never spawn a CTO.",
    "",
    "### Task",
    envelope.task,
    "",
    "### Immutable requested selector set",
    `The public /cto parser accepted this exact ordered selector array; it is immutable request audit authority and MUST be preserved in \`cto_prepare\` results and findings: ${requestedSelectorsJson}`,
    "The execution route derives one canonical top-level classification and every task row from the frozen handoffs; do not send a classification field, TeamDef, task rows, or caller-owned DoD fields. The engine-owned value is exactly type=FEATURE, complexity=MEDIUM, confidence=HIGH, autonomous=true, workflow=standard.",
    `The first \`cto_prepare\` write MUST carry this exact selector payload (all pairs, in this order): ${firstSelectorPayload}`,
    "Operational preflight MUST use the exact `cto_prepare.required_next_tool.arguments` descriptor, whose selections contain only eligible rows. Excluded selectors are audit findings and MUST NOT be repeated in cto_preflight.",
    "Do not read source files, handoff JSON, TypeScript schemas, or mounted-tool documentation to construct the preparation payload. Copy the complete engine-rendered object below; its key shapes and canonical execution envelope are fixed. Only the request selectors are user-provided values, and they are already rendered exactly above.",
    "### Complete route-specific `cto_prepare` JSON template",
    "```json",
    ctoPrepareTemplate,
    "```",
    "Do not add a top-level classification field, replace an array with an object, replace an object with an array, or echo any caller-authored execution classification.",
    "",
    issueMeta + branchMeta + sessionMeta,
    "",
    buildClassificationPhaseZero({ label: "leading directive", value: envelope.autonomyHint }),
    "",
    buildWorkflowMatrix(),
    "### Intent gate — EXECUTION (explicit feature_id/run_key ready handoffs)",
    "This route is authorized only because the request explicitly selected existing feature_id/run_key handoffs; preparation requests must never enter this section.",
    "Do not create or revise specifications here. If any selected handoff is not ready, stop and report the blocked finding; do not fall back to preparation or infer another selector.",
    "",
    "### Specification execution (explicit, confirmation-gated)",
    ...renderConstitutionToolContract({
      feature_id: "<exact selected feature_id>",
      run_key: "<exact selected run_key>",
      origin: {
        origin_kind: "cto_preparation",
        origin_run_key: "<exact selected run_key>",
        origin_stage: "cto",
      },
    }),
    "Apply that exact contract for every selected feature/run pair. If any gate is unresolved, do not prepare, claim, or dispatch until usable.",
    "Then call the mounted engine tools in this exact order;",
    "Execution dispatch authority: never invoke /do-work or generic workflow_prepare, fabricate .work-state/team-state.json, or invent PHASE-0/per-slice classification. the mounted dispatch result is the only source of implementation admission; dispatch only its returned admitted_slices and copy each exact returned <!-- omp-cto-slice run=<runId> slice=<sliceId> --> marker verbatim into every lead/worker task.",
    "never write state, mappings, claims, waves, identities, or DoD artifacts directly and never call",
    "`workflow_prepare` for this flow. Select every feature/run pair explicitly; never infer selectors from",
    "1. Call `cto_prepare` with one safe `cto_run_id`, the exact task/branch, and the immutable full requested `selections` array rendered above. Do not include teams, task rows, handoff digests, routing metadata, classifications, or DoD fields; the engine reads each frozen handoff and derives every canonical task row from it. It creates or replays the active specification-execution wave, performs no worker spawn,",
    "   and returns non-secret run/wave/slice identities plus explicit unresolved TeamDef candidates when scope ownership is not unique.",
    "2. Call `cto_preflight` by executing the exact descriptor returned in `cto_prepare.required_next_tool.arguments`; its `selections` are the eligible subset only.",
    "   Never reconstruct preflight selectors from the immutable full request or repeat excluded rows. If this preflight is blocked but returns `required_next_tool`, execute that exact eligible retry descriptor directly;",
    "   no human authorization Ask is permitted for selector eligibility retries. Preserve and report all excluded findings verbatim, and proceed to confirmation only after a ready mapping.",
    "3. Execute the mounted `cto_checkpoint_ask_selected` device before confirmation. Use its exact JSON descriptor as the `content` of a `write` operation to xd://cto_checkpoint_ask_selected; reading xd:// documentation is not execution and selectors must never be invented.",
    "   Present exactly three mapping choices to the current user: `approve_continue`, `request_changes`, and `approve_stop`.",
    "   Only `approve_continue` may proceed. Consume the engine-issued canonical current-user proof returned by that device.",
    "   Then execute mounted `cto_confirm` by writing its exact JSON descriptor to `xd://cto_confirm`; never fabricate, replay, or substitute actor/session/root data.",
    "4. Execute mounted `cto_dispatch` by writing its exact JSON descriptor to `xd://cto_dispatch`; it revalidates CAS, claims, handoff",
    "   digests, and pure slice admission but never spawns. No claim or lead/worker spawn is allowed until `cto_confirm`",
    "   succeeds and `cto_dispatch` returns; dispatch only returned `admitted_slices`, each task carrying the exact",
    "   `<!-- omp-cto-slice run=<runId> slice=<sliceId> -->` marker.",
    ...ctoLeadContractPropagationContract(),
    "5. After every admitted implementation slice returns its worker/lead summary and typed evidence, wait for all selected",
    "   features to reach the post-worker fan-in. If a slice returns a bounded evidence/contract failure, require its admitted lead to run at most one bounded internal worker repair for that slice; the resident CTO never dispatches a repair worker and no lead may run a second repair worker or loop.",
    "   After each affected lead's bounded internal repair returns, immediately collect the lead's returned typed evidence/refs;",
    "   do not run shell commands or perform checksum, schema, or repository inspection in this fan-in path.",
    "6. Invoke the mounted engine-owned `cto_specification_conformance` tool exactly once for this complete mapping/wave after",
    "   all bounded repair workers return. Submit only the exact selector descriptor from `cto_dispatch.required_next_tool.arguments`; the engine loads the durable mapping, frozen handoffs, current claims, and exactly one canonical evidence and quality-gate envelope from each selected feature workspace. Never flatten, strip, reconstruct, or retry conformance per artifact or per feature.",
    "   Canonical evidence envelopes MUST validate against packages/core/workflows/artifacts-schema.json definition `conformance_evidence`.",
    "   Their top-level keys are exactly `schema_version`, `artifact_id`, and `entries` (no `provenance` or any extra field); every `executed_test` entry MUST include `test.evidence_ref` with `artifact_id`, `path`, `sha256`, `schema_status`, and `quality_gate_status` and that artifact MUST be the worker-returned dereferenceable reference.",
    "   Every evidence artifact MUST be in `.work-state/features/<feature_id>/artifacts/` with filename `<artifact_id>.json`;",
    "   each submitted ref.path MUST exactly equal that repo-relative `.work-state/features/<feature_id>/artifacts/<artifact_id>.json` path.",
    ...ctoConformanceArtifactNamingContract(),
    "   The producer revalidates every binding and persists one immutable implementation-conformance artifact per feature.",
    "   Every selected handoff MUST carry exactly one current execution-profile quality gate: `source: execution_profile`,",
    "   `gate_id: execution-profile.<selected workspace profile_hash>`, `status: pass|fail`, and a dereferenceable",
    "   `quality_gate_evidence` artifact reference. The engine rejects an omitted, stale, or wrong-profile gate; its derived",
    "   constitution gate is mandatory too but never substitutes for the selected execution-profile gate.",
    "   Evidence subject binding is immutable: implementation, review, and executed_test entries MUST use the frozen handoff requirement IDs and acceptance IDs as subject_id (for this slice, for example, FR-1 and AC-1); task IDs and verification IDs are routing metadata only and MUST NOT be evidence subjects. Every entry, including nested entries inside canonical envelopes, MUST carry a non-empty ISO recorded_at; executed_test also carries test.executed_at.",
    "   Timestamp generation is host-portable and exact: `recorded_at`, `executed_at`, and `evaluated_at` MUST match `^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z$` (valid `2026-01-01T00:00:00.000Z`; invalid high-fraction `2026-01-01T00:00:00.30503000Z` and `2026-01-01T00:00:00.818575000Z`). NEVER use shell `date`/`%N`; use ECMAScript `new Date().toISOString()` or trim deterministically to exactly three fractional digits before writing, then propagate the exact value verbatim through lead, implementation, and QA evidence.",
    "   Bounded repair rule: when a frozen handoff has no concrete observable contract or a required scoped source/prerequisite is absent, do not invent behavior or alter engine-owned DoD/state. Require each admitted lead to preflight every frozen FR-1 and AC-1 evidence boundary before yielding. The lead dispatches the required implementation and QA workers once and may dispatch exactly one bounded repair worker (internal to that slice) when evidence is incomplete, then immediately submit its returned refs in the single aggregate conformance call above. No shell/checksum/schema/repository inspection, artifact rewriting, digest mutation, second repair dispatch, or conformance retry is allowed.",
    "   Worker result contract (lead result): before yielding, a passing lead MUST verify canonical implementation, review, and executed_test evidence for every frozen requirement and acceptance subject (including FR-1 and AC-1); never synthesize missing tests. An irreparably blocked subject MAY yield one canonical intent_conflict terminal record with a met evidence artifact, while any failing execution-profile verdict remains a separate quality-gate record. Each lead returns exactly one compact terminal slice summary (pass or blocked) with worker ids, canonical feature-local refs/hashes, every subject preflight verdict, and any unresolved blocker. A missing contract or prerequisite is terminal for that slice after the one bounded internal repair; it is not permission to loop",
    "7. Require every selected feature to have a persisted terminal matrix (`overall_status: pass`, `blocked`, or `changed_intent`); passing rows expose",
    "   `claim_action: release`, while blocked/changed_intent rows expose explicit findings and retain their claim for remediation.",
    "   A non-passing row is isolated and terminal for this close; it must not wedge independent passing slices, and aggregate outcome is",
    "   `blocked` whenever any matrix is blocked or changed_intent (never report success).",
    "8. For every passing selected feature, immediately call mounted `workflow_complete_specification_execution` with the exact CTO",
    "   envelope returned by the producer (`owner_kind`, `owner_run_key`, `wave_id`, `mapping_id`, `mapping_digest`, `feature_id`,",
    "   `run_key`, `handoff_digest`, `conformance_id`). Require `ok` with a completed workspace; replayed terminal results are",
    "   acceptable only when their exact claim/workspace/conformance postimages are verified by the engine. Do not call completion",
    "   for blocked or changed_intent rows: their active claims and remediation findings remain isolated.",
    "9. Mandatory CTO result aggregation: after all passing completions return and every non-passing matrix is retained, call mounted",
    "   `cto_close_specification_execution_wave` with the exact `cto_run_id`, `wave_id`, `mapping_id`, `mapping_digest`, and one",
    "   completion proof (`feature_id`, `run_key`, `handoff_digest`, `conformance_id`) per selected feature, including retained",
    "   blocked/changed_intent rows. Require `closed: true`; inspect aggregate `outcome` (`pass` only when every matrix passes,",
    "   otherwise `blocked`), `blocked_feature_ids`, and bounded `findings`. The engine alone performs the terminal wave CAS and",
    "   clears `active_wave_id`; missing/nonterminal matrix postimages keep the wave active and must never be mutated directly.",
    "",
    persistenceContract(opts),
    "### Team registry (.omp/teams.json)",
    "| Team | Name | Scope | Profile | Lead | Roster |",
    "| --- | --- | --- | --- | --- | --- |",
    renderTeamsTable(cwd),
    "",
    profileSection,
    "",
    renderChannelSection(cwd),
    "1. **Prepare through the mounted tool**: call `cto_prepare` with the exact selector-only payload",
    "   carrying the immutable full requested `selections` array rendered above in the first write. The engine reads frozen handoffs, resolves TeamDefs by scope, and derives one stable task row plus DoD per canonical task; callers MUST NOT provide teams, task rows, routing metadata, or reconstructed handoff fields. Readiness filtering is reported, never silently applied;",
    "   consume the exact eligible-only preflight descriptor from `cto_prepare.required_next_tool.arguments`; excluded rows and unresolved/ambiguous TeamDef candidates remain audit findings and are never sent to `cto_preflight`.",
    "   Include a complete per-slice classification, matrix-resolved workflow, exact worktree",
    "   strategy, and readable non-empty DoD items. The engine persists all canonical state under pinned",
    "   locks and returns identities; the resident CTO must not write those files or invoke generic workflow",
    "   preparation.",
    "2. **Architecture first (multi-team runs)**: after the plan, run the architecture stage — spawn the",
    "   `architect` (single `task`) to produce the cross-team contract BEFORE spawning leads: api_contract",
    "   (endpoints/DTOs), file ownership per team, shared interfaces, ports/CORS. Leads consume the contract",
    "   in their slices. Single-team runs: skip the stage, the contract lives in the plan.",
    "3. **Spawn leads** via `task` — one lead per team. Leads own their team: they decompose the slice into",
    "   worker tasks and spawn workers. Only you and the leads have `task`+`hub`; workers never re-delegate (R1).",
    "   **Leads never write source** — after each lead returns, verify its transcript: any `write`/`edit` on a",
    "   path outside `.work-state/` is a delegation violation; log it in `decisions.md` and re-state the rule on",
    "   the next spawn. A zero-worker lead is a failed lead.",
    "4. **Escalation ladder**: worker -> lead -> you (CTO) -> user. Decide what you can with a documented",
    "   `why` (decisions.md); escalate only what you cannot. `blocker` waits without timeout — the team parks",
    "   (`background_wait`), all other work continues; `question`/`decision` get `timeoutMs` + `default`.",
    "5. **Answers** arrive as files `.work-state/cto/<id>/answers/<esc-id>.json` (shape { id, answer, at, by })",
    "   — pick them up at the next team checkpoint. Apply only if the team is still waiting; late answers are",
    "   advisory (R5).",
    "6. **Summaries, not artifacts**: feed leads' compact summaries up, never raw artifacts (R3).",
    "7. **Integration**: merge worktree branches, run the integration review stage, aggregate per-team DoDs.",
    "   A failed team is isolated: re-spawn with the gate's reason, drop its scope, or escalate (R8).",
    "8. **Never code yourself.** Never patch a team's artifact by hand — re-spawn with a sharper task.",
    "9. **Inbox check**: read `.work-state/cto/*/inbox/*.json` BEFORE decomposing — tasks may have",
    "   arrived via the messenger while no session was listening; fold them into this run too",
    "   (each as its own wave, amend discipline).",
    "",
    "### LECTURE_RESEARCH slices (URL-first, research-only, human-gated)",
    "A slice classified `LECTURE_RESEARCH` (one public video/playlist URL + natural-language prompt) resolves deterministically to the",
    "`lecture-research` profile — a RESEARCH-ONLY workflow with automatic bounded acquisition and an explicit human approval/stop gate.",
    "The URL is the only user content prerequisite. It is distinct from generic `INVESTIGATION` -> `research`, and it never turns into code.",
    "No transcript is requested.",
    "Requirements:",
    "1. **Research-only team profiles**: select leads/workers from research roles (analyst, tech-researcher,",
    "   diagnostics, security-tester). NEVER assign developer/implementation profiles to the slice, never",
    "   write an implementation task, and never let the team touch application source.",
    "2. **Automatic acquisition**: intake extracts exactly one URL and prompt and must not request a transcript, captions, recording, notes, or media. Immediately after intake, the main-session orchestrator MUST invoke the consumer-provided `lecture_acquire` tool and require `lecture_acquisition`; provider/API credentials, rights, and setup are installation concerns. Core does not fetch URLs.",
    "3. **Bounded evidence mapping**: acquisition resolves a bounded source set and preserves failures. Mapping consumes only normalized `lecture_acquisition` evidence, carries human-readable evidence plus structured timestamped refs, and performs NO network access or provider calls.",
    "4. **Repo-fit plus security review (READ-ONLY)**: before anything is presented as actionable, a repo-fit",
    "   pass checks the findings against this repository (do the claims match the actual codebase?), and a",
    "   security review (security-tester) flags risks. Both are read-only — no fixes.",
    "5. **Human approval/stop gate**: the wave ENDS at an explicit human approval checkpoint (`ask` or a",
    "   `decision` escalation with `timeoutMs` + `default`). No implementation starts before approval. No implementation, task creation, or source edits start before approval; a",
    "   rejection or stop closes the wave with findings delivered as the artifact — never code. Only AFTER",
    "   approval may a NEW, separately-classified implementation slice be created (own classification,",
    "   workflow, DoD, and wave).",
    "",
    "### Wave / slice gate contract (BEFORE any lead is spawned)",
    "A lead/worker `task` call is MECHANICALLY BLOCKED unless the engine-created active",
    "specification-execution wave proves an exact team/slice mapping, full per-slice classification,",
    "matrix-resolved workflow, and readable non-empty DoD. Satisfy this gate only by calling `cto_prepare`",
    "with the exact explicit payload; it atomically persists the wave, identities and DoD under pinned",
    "locks. Never write `.work-state/cto`, state.json, or DoD files directly.",
    "After `cto_dispatch` returns, dispatch only its `admitted_slices`; every lead and worker task must",
    "carry the exact literal `<!-- omp-cto-slice run=<runId> slice=<sliceId> -->` from the returned identity.",
    "   Every lead/worker typed evidence artifact MUST be written under `.work-state/features/<feature_id>/artifacts/`;",
    "   filename MUST be `<artifact_id>.json`, and every submitted ref.path MUST be that exact repo-relative",
    "   `.work-state/features/<feature_id>/artifacts/<artifact_id>.json` path. NEVER use a team-global artifact root.",
    "",
    "### Failure modes to avoid",
    "- Do NOT let a worker re-delegate (rogue router) — only CTO/lead spawn.",
    "",
    "The resident CTO and every lead are dispatchers and integrators only. The engine owns all canonical",
    "state and typed artifacts; the CTO/lead may read returned summaries but never write state, mappings, claims, waves, identities, or DoD files.",
    "NEVER use `write` or `edit` on application source, tests, configuration, lockfiles, documentation, or",
    "engine state from the CTO/lead. Source changes belong exclusively to worker agents; missing typed evidence blocks the wave.",
    "A lead that returns without a worker dispatch is failed. A CTO that performs implementation or review-fixes itself is a policy violation.",
    "- Do NOT tolerate a self-coding lead — leads delegate, workers code.",
    "- Do NOT block the whole run on one escalation — park the team, continue the rest.",
    "- Do NOT mark a team done while its DoD items are unmet.",
    "- Do NOT exceed 8 teams or depth 2 — re-plan (coarsen) instead.",
    "- Do NOT scan the filesystem for profiles/teams — read exactly `cto.json`, `.omp/teams.json`, `.omp/team.config.json`.",
    "",
    "### Subagent dispatch reliability (lead exit-1 protocol)",
    "A lead that returns `exit 1` is a SUBAGENT/PROVIDER failure, not a team decision —",
    "(provider-side, model-dependent). Treat it as a resource failure and FAIL OVER, never as a verdict:",
    "1. **Verify disk state first.** The failed lead's prep usually survived: check",
    "   `.work-state/cto/<id>/` and `.work-state/features/<feature_id>/artifacts/` for inventories, decisions,",
    "   worker outputs. NEVER redo the inventory/prep — it is on disk.",
    "2. **Re-spawn the lead with the SAME slice spec** (the exact task text from the plan, plus a",
    "   note 'resume from disk state — do not redo prep; verify artifacts first').",
    "3. **Second failure -> degrade, do not loop.** Dispatch that team's workers DIRECTLY from you",
    "   (your own `task` tool): one worker per actionable item, each with the findings already on",
    "   disk. Or fold the slice into an adjacent team. Log the degradation in `decisions.md` (why).",
    "4. **Single-worker slices: skip the lead hop from the start.** When a team's slice needs one",
    "   worker (typical fix slice), dispatch that worker directly from you — the lead layer pays",
    "   off only for genuinely multi-worker teams. This also halves the nesting depth.",
    "5. **Dispatch hygiene for leads** (re-state in the lead task): dispatch the first worker as",
    "   soon as the slice is decomposed — BEFORE pulling large files into context; keep task specs",
    "   lean (reference file paths; findings go to disk as inventory JSON the worker reads, not into",
    "   the spec); one worker per `task` call. Big specs at heavy context are exactly where subagents",
    "   stall.",
    "",
    "### After the wave",
    "Do not ask the engine/runtime to close the current wave until the conformance producer has persisted a terminal pass or blocked matrix for EVERY selected feature",
    "and the canonical workflow completion finalizer has returned successful terminal postimages for every passing feature. After that, ask the engine/runtime",
    "to close ONLY the current wave with its summary; inspect aggregate outcome (`pass` only when all matrices pass, otherwise `blocked`) and findings.",
    "Keep the resident CTO run active with the SAME run id; return to standby and await the next task (`[CTO-INBOX]` message or `inbox/` file) through the host.",
    "Begin: compose the exact `cto_prepare` payload with the immutable full requested selector set rendered above, then execute",
    "`cto_preflight` using only the exact eligible-only descriptor returned in `cto_prepare.required_next_tool.arguments`; excluded selectors",
    "are audit findings and MUST NOT be repeated. If preflight returns a blocked retry descriptor, execute it directly without human authorization.",
    "`cto_checkpoint_ask_selected` by writing its exact JSON descriptor to `xd://cto_checkpoint_ask_selected`; follow the",
    "three-choice current-user mapping proof, then immediately execute mounted `cto_confirm` by writing its exact JSON descriptor to `xd://cto_confirm`,",
    "then immediately execute mounted `cto_dispatch` by writing its exact JSON descriptor to `xd://cto_dispatch`; only then spawn admitted slices.",
  ].join("\n");
}
/**
 * The /cto intent gate is deliberately independent from PHASE-0 classification.
 * PHASE-0 chooses a workflow for an already-authorized route; this gate decides
 * whether the request is specification preparation, execution of an existing
 * handoff, normal CTO orchestration, or unresolved and therefore must not mutate
 * anything.
 */
export type CtoIntentMode = "preparation" | "execution" | "general" | "ambiguous";

export interface CtoIntentDecision {
  mode: CtoIntentMode;
  /** Task text with explicit execution selectors removed. */
  task: string;
  /** Selectors are only execution authority when the route is execution. */
  selections: readonly CtoSpecificationExecutionSelection[];
  reason: string;
}

const PREPARATION_INTENT = /\b(?:prepare|preparation|specification(?:s)?|specify|spec-plan|spec-tasks|revise|revision|facets?|feature(?:s)?\s+(?:workspace|queue)|queue(?:d|ing)?)\b/iu;
const EXECUTION_ACTION = /\b(?:execute|implement)\b|\bdispatch\b(?=[\s\S]{0,96}(?:--spec|--run-key|handoff))/iu;
const READY_HANDOFF = /\bready[- ]handoffs?\b|\bhandoffs?\s+(?:ready|for\s+execution|for\s+implementation)\b/iu;

export function classifyCtoIntent(envelope: ParsedCtoEnvelope): CtoIntentDecision {
  const parsed = parsedCtoSelections(envelope);
  if (parsed.error) {
    return {
      mode: "ambiguous",
      task: envelope.task,
      selections: [],
      reason: parsed.error.message,
    };
  }

  const task = parsed.task.trim();
  const hasPreparation = PREPARATION_INTENT.test(task);
  const hasExecutionAction = EXECUTION_ACTION.test(task);
  const hasReadyHandoff = READY_HANDOFF.test(task);
  if (hasPreparation && (hasExecutionAction || hasReadyHandoff)) {
    return {
      mode: "ambiguous",
      task,
      selections: parsed.selections,
      reason: "the request mixes specification preparation and implementation execution intent",
    };
  }
  if (hasPreparation) {
    return {
      mode: "preparation",
      task,
      selections: parsed.selections,
      reason: "the request explicitly creates or revises specifications",
    };
  }
  if (parsed.selections.length > 0 && (hasExecutionAction || hasReadyHandoff || task.length === 0)) {
    return {
      mode: "execution",
      task,
      selections: parsed.selections,
      reason: "the request explicitly targets feature_id/run_key handoffs for execution",
    };
  }
  if (parsed.selections.length > 0) {
    return {
      mode: "ambiguous",
      task,
      selections: parsed.selections,
      reason: "explicit feature_id/run_key selectors are present without an execution or preparation intent",
    };
  }
  if (hasReadyHandoff) {
    return {
      mode: "ambiguous",
      task,
      selections: parsed.selections,
      reason: "ready-handoff execution requires explicit feature_id/run_key selectors",
    };
  }
  return {
    mode: "general",
    task,
    selections: [],
    reason: "the request is a general CTO task without specification or ready handoff intent",
  };
}
/** Prompt for the legacy general CTO route (non-specification work). */
function buildGeneralCtoPrompt(
  envelope: ParsedCtoEnvelope,
  cwd: string,
  opts: CtoPromptOptions = {},
): string {
  const profilePath = join(findProfileDir(), "cto.json");
  const profileSection = existsSync(profilePath)
    ? `Workflow profile: \`${profilePath}\` — read exactly this one file for the stage list, gates, checkpoints, produces/consumes.`
    : "Workflow profile: `cto.json` not shipped yet — use the stage skeleton below and the mounted workflow contracts.";
  const issueMeta = envelope.issue ? `Issue: #${envelope.issue}\r\n` : "";
  const branchMeta = envelope.branch
    ? `Branch: \`${envelope.branch}\` (canonical session branch)\r\n`
    : "Branch: (no git work tree; strict workflow transitions cannot start)\r\n";
  const sessionMeta = opts.sessionId ? `Session: \`${opts.sessionId}\`\r\n` : "";

  return [
    "/cto workflow — GENERAL orchestration (intent gate resolved)",
    "You are the MAIN AGENT and resident CTO. This is a normal team-orchestration task, not specification preparation and not execution of an existing ready handoff.",
    "Never spawn or delegate to another CTO: NEVER run `task(agent=cto)` or `task(agent=@cto)`.",
    "",
    "### Task",
    envelope.task,
    "",
    "### Metadata",
    issueMeta + branchMeta + sessionMeta,
    "",
    buildClassificationPhaseZero({ label: "leading directive", value: envelope.autonomyHint }),
    "",
    buildWorkflowMatrix(),
    "",
    "### General CTO state and routing",
    "Classify the task in PHASE-0, resolve every team slice through the workflow matrix above, and ask the host/runtime to register the engine-owned CTO wave before dispatch. Never write `.work-state/cto`, state.json, wave history, identities, classifications, workflows, claims, or DoD artifacts directly.",
    "Use the canonical `.omp/teams.json` registry and the shipped `cto.json` profile only; do not scan the filesystem for profiles or teams.",
    "This general route does not call specification-execution tools and does not infer a ready handoff from feature names, cwd, branch, active pointers, or prompt wording.",
    "",
    "### Team registry (.omp/teams.json)",
    "| Team | Name | Scope | Profile | Lead | Roster |",
    "| --- | --- | --- | --- | --- | --- |",
    renderTeamsTable(cwd),
    "",
    profileSection,
    "",
    renderChannelSection(cwd),
    "",
    "### CTO discipline (you are the orchestrator, not a coder)",
    "1. **Decompose** the task into a TeamPlan: pick teams from the registry (max 8, decomposition depth max 2), assign each a non-overlapping `scope` slice + task `slice`, and choose the sub-profile from the Workflow resolution matrix above — the SAME table as /do-work (resolveWorkflow). Bug-fix slices run through the team: the lead walks debug-cycle (diagnose -> root cause -> fix -> verify; root_cause gate before code). Decide the git strategy per team: coupled tasks use one branch with parallel teams; independent tasks use separate worktrees.",
    "2. **Architecture first (multi-team runs)**: after the plan, run the architecture stage — spawn the `architect` (single `task`) to produce the cross-team contract BEFORE spawning leads: api_contract (endpoints/DTOs), file ownership per team, shared interfaces, and ports/CORS. Leads consume the contract in their slices. Single-team runs skip this stage; the contract lives in the plan.",
    "3. **Spawn leads** via `task` — one lead per team. Leads own their team: they decompose the slice into worker tasks and spawn workers. Only you and the leads have `task`+`hub`; workers never re-delegate. Leads never write source; a zero-worker lead is a failed lead.",
    "4. **Escalation ladder**: worker -> lead -> you (CTO) -> user. Decide what you can with a documented `why`; escalate only what you cannot. `blocker` waits without timeout and parks that team (`background_wait`); `question`/`decision` get `timeoutMs` + `default`.",
    "5. **Answers** arrive through the validated channel/runtime at the next team checkpoint. Apply an answer only if the team is still waiting; late answers are advisory.",
    "6. **Summaries, not artifacts**: feed leads' compact summaries up, never raw artifacts.",
    "7. **Integration**: merge worktree branches, run the integration review stage, and aggregate per-team DoDs. A failed team is isolated: re-spawn with the gate's reason, drop its scope, or escalate.",
    "8. **Never code yourself.** Never patch a team's artifact by hand — re-spawn with a sharper task.",
    "9. **Inbox check**: read the active run's inbox through the host/runtime BEFORE decomposing; tasks may have arrived while no session was listening, and each becomes its own wave.",
    "",
    "### LECTURE_RESEARCH slices (URL-first, research-only, human-gated)",
    "A slice classified `LECTURE_RESEARCH` (one public video/playlist URL + natural-language prompt) resolves deterministically to the `lecture-research` profile — a RESEARCH-ONLY workflow with automatic bounded acquisition and an explicit human approval/stop gate.",
    "The URL is the only user content prerequisite. It is distinct from generic `INVESTIGATION` -> `research`, and it never turns into code.",
    "No transcript is requested.",
    "Requirements:",
    "1. **Research-only team profiles**: select leads/workers from research roles (analyst, tech-researcher, diagnostics, security-tester). NEVER assign developer/implementation profiles to the slice, never write an implementation task, and never let the team touch application source.",
    "2. **Automatic acquisition**: intake extracts exactly one URL and prompt and must not request a transcript, captions, recording, notes, or media. Immediately after intake, the main-session orchestrator MUST invoke the consumer-provided `lecture_acquire` tool and require `lecture_acquisition`; provider/API credentials, rights, and setup are installation concerns. Core does not fetch URLs.",
    "3. **Bounded evidence mapping**: acquisition resolves a bounded source set and preserves failures. Mapping consumes only normalized `lecture_acquisition` evidence, carries human-readable evidence plus structured timestamped refs, and performs NO network access or provider calls.",
    "4. **Repo-fit plus security review (READ-ONLY)**: before anything is presented as actionable, a repo-fit pass checks the findings against this repository, and a security review (security-tester) flags risks. Both are read-only — no fixes.",
    "5. **Human approval/stop gate**: the wave ENDS at an explicit human approval checkpoint (`ask` or a `decision` escalation with `timeoutMs` + `default`). No implementation starts before approval. No implementation, task creation, or source edits start before approval; a rejection or stop closes the wave with findings delivered as the artifact — never code. Only AFTER approval may a NEW, separately-classified implementation slice be created (own classification, workflow, DoD, and wave).",
    "",
    "### Wave / slice gate contract (BEFORE any lead is spawned)",
    "A lead/worker `task` call is mechanically blocked until the engine/runtime reports an active wave with exact team/slice mapping, per-slice classification, matrix-resolved workflow, and readable non-empty DoD. Dispatch only the teams and slices returned by that gate, carrying the exact run/slice marker into every lead and worker task.",
    "",
    "### Failure modes to avoid",
    "- Do NOT let a worker re-delegate (rogue router) — only the resident CTO and leads spawn.",
    "- Do NOT block the whole run on one escalation — park the team and continue the rest.",
    "- Do NOT exceed 8 teams or depth 2 — re-plan (coarsen) instead.",
    "- Do NOT tolerate a self-coding lead — leads delegate, workers code.",
    "",
    "### After the wave",
    "When integration completes, ask the engine/runtime to close ONLY the current wave with its summary and status. Keep the resident CTO run active with the SAME run id; return to standby and await the next `[CTO-INBOX]` task to fold in as a NEW wave.",
    "",
    "Begin: classify the task, register the engine-owned wave, decompose it into a TeamPlan, and spawn the first leads.",
  ].join("\r\n");
}

function stateReadOnlyPreparationContract(opts: CtoPromptOptions): string {
  const sessionLine = opts.sessionId ? `current session: \`${opts.sessionId}\`` : "current session: <engine-provided session id>";
  return [
    "### Engine-owned specification state (mandatory)",
    "Do not write `.work-state/cto`, CTO state.json, waves, identities, mappings, claims, or DoD files yourself.",
    "The native specification commands and workflow engine own durable state, run keys, artifacts, validation, and checkpoints; " + sessionLine + ".",
    "Never fabricate a feature identity, run_key, checkpoint proof, approval, worker identity, or handoff digest.",
  ].join("\r\n");
}

/** Prompt for the native, non-execution specification route. */
export function buildPreparationCtoPrompt(
  envelope: ParsedCtoEnvelope,
  cwd: string,
  opts: CtoPromptOptions = {},
  activeRunId?: string,
): string {
  const profilePath = join(findProfileDir(), "spec-preparation.json");
  const active = activeRunId ? `Active resident run: \`${activeRunId}\` — continue it; never start a second CTO.` : "Start one resident CTO run for this request; never spawn a second CTO.";
  return [
    "/cto workflow — PREPARATION mode (intent gate resolved)",
    "",
    "You are the MAIN AGENT and resident CTO. This request is specification preparation, not implementation execution.",
    "Do not call any CTO execution tool, do not acquire an implementation claim, do not dispatch an implementation worker, and do not run `/do-work`.",
    "Do not spawn or delegate to another CTO: NEVER run `task(agent=cto)` or `task(agent=@cto)`.",
    active,
    "",
    "### Request",
    envelope.task,
    "",
    "### Intent gate",
    "Mode: PREPARATION",
    "Preparation is selected because the request creates/revises specifications or coordinates feature/facet preparation.",
    "If feature identities, facet ownership, or the requested phase cannot be determined explicitly from the request, ask the current user before dispatching anything; unresolved authorization always remains a current-user checkpoint.",
    "The preparation route and execution route are mutually exclusive; do not fall through to an execution tool when a handoff is not explicitly requested.",
    "",
    "Preparation entry order: complete the constitution prerequisite, then call `cto_specification_prepare` before any generic `workflow_prepare`; this entry never grants approval or dispatch authority.",
    buildClassificationPhaseZero({ label: "leading directive", value: envelope.autonomyHint }),
    "",
    buildWorkflowMatrix(),
    "### Native specification workflow (canonical composite path)",
    `Use the shipped \`${profilePath}\` profile and the existing native specification contracts; never invent a CTO-specific document format or approval path.`,
    ...renderConstitutionToolContract({
      feature_id: "<explicit first-request feature_id>",
      run_key: "<resident cto_run_id>",
      origin: { origin_kind: "cto_preparation", origin_run_key: "<resident cto_run_id>", origin_stage: "cto" },
      deferImpactUntilPreparation: true,
    }),
    "Complete the bootstrap constitution steps above before `cto_specification_prepare`; never write CONSTITUTION.md or constitution state directly. Shared impact is deferred until preparation has created and bound each selected workspace.",
    "1. Call `cto_specification_prepare` exactly once with the explicit feature requests and canonical branch. Enumerate only exact `scheduled[]` feature_id/run_key pairs returned by the engine; queued rows are metadata only and have no dispatch surface.",
    "2. For each scheduled feature, revalidate its exact constitution binding with `ensure_project_constitution`. Only an existing bound workspace whose fingerprint changed may enter the deferred impact sequence; never synthesize approval or selectors.",
    ...renderConstitutionImpactToolContract({
      feature_id: "<exact returned feature_id>",
      run_key: "<exact returned feature_id run_key>",
      origin: { origin_kind: "cto_preparation", origin_run_key: "<resident cto_run_id>", origin_stage: "cto" },
    }),
    "3. After constitution binding/revalidation, call `workflow_prepare` with each exact returned feature_id/run_key, request task, canonical branch, and `{type: SPEC, complexity, confidence, autonomous: false, workflow: spec-preparation}`. Never synthesize run keys or prepare queued rows. Preserve the complete opaque `preparation_handoff` returned for each prepared feature byte-for-byte; it is engine authority, not model data.",
    "4. Once the selected phase is ready, execute the exact `workflow_prepare.required_next_tool.arguments` descriptor for that feature. It MUST contain the exact engine-selected `feature_id`, `run_key`, and complete opaque `preparation_handoff` from that same preparation result; call `workflow_start_native_specification_phase` with all three fields. Selector-only `{feature_id, run_key}` is invalid and MUST NOT be used. Do not fabricate, reconstruct, trim, or substitute any handoff field, and do not add a phase field—the engine-selected current phase is bound by the handoff and persisted workflow state. This is the canonical native path; `workflow_begin`, `workflow_instructions`, `workflow_dispatch_specification_phase`, `workflow_complete`, `workflow_begin_phase_validation`, and `workflow_validate_phase` are recovery-only devices and MUST NOT be called on the normal path.",
    "If native start reports a stale preparation_handoff, rerun workflow_prepare exactly once with the same canonical arguments, preserve the newly returned complete handoff, execute its exact `required_next_tool.arguments` descriptor, and never fall back to lower-level begin/instructions/dispatch.",
    "5. For every independently scheduled feature, retain the complete `workflow_start_native_specification_phase.required_next_tool.arguments` descriptor keyed by its exact feature_id/run_key, then invoke each exact descriptor independently and concurrently when workers are independent. Each exact task envelope has the closed top-level shape {i, context, tasks}; never add intent, description, metadata, or any other key, never batch descriptors together, and never merge, swap, duplicate, or recompose task items. The engine has already embedded the exact CTO slice marker in the final bytes of every `tasks[]` item; copy each task string and the complete envelope byte-for-byte, with no text after the marker. Never reconstruct a marker; Never concatenate, recompute, move, or substitute a marker. These engine-issued descriptors are the sole phase-worker dispatch authorities.",
    "   Every dispatched worker is a leaf for this phase: execute only the assigned specification task, return its terminal structured worker_result, and MUST NOT call task/hub or re-delegate any work.",
    "6. Wait for that exact child handle/result to reach terminal success with hub {op:\"wait\",ids:[\"<one-or-more-exact-child-ids>\"]}; use one or more exact pending child IDs returned by task.name (or from for one exact child), and never use a bare wait when multiple native contexts are active. Independent features may wait one or all of their exact pending children. Do not author a semantic model or call another workflow device while it is pending, running, nested-waiting, polling, or temporarily missing.",
    "7. After terminal success, immediately call read(`agent://<exact-child-id>`) and use only that direct structured worker_result object unchanged. The direct `structured.data` returned by this read is complete even when the task card reports `<meta size/lines>` or preview metadata; never treat those metadata as truncation. Never read `artifact://`, `skill://artifact-spill-transfer`, another skill, child logs, or transcripts and never parse, copy, spill, or reconstruct task output through eval, shell, Python, TypeScript, or JSON reconstruction.",
    "8. Immediately call `workflow_finalize_native_specification_phase` with `{feature_id: <the exact feature_id returned by workflow_start_native_specification_phase>, run_key: <the exact run_key returned by workflow_start_native_specification_phase>, worker_result: <the exact direct object returned by agent://>}`. The engine resolves and validates the current native generation handoff from that selector; never provide a handoff, token, branch, workflow, profile, phase, version, or reconstructed model. The composite owns canonical persistence, generation completion, validator dispatch, deterministic validation, and returns the exact selected Ask descriptor only when every prerequisite passes.",
    "   An `ok:true` native finalizer result that includes `required_next_tool` is a hard barrier: immediately execute that exact selected Ask before ANY other read, hub, task, finalizer, skill, or feature work. Do not inspect, summarize, spill, copy, parse, reconstruct, switch queues, or invoke any alternate workflow call between the successful finalizer and that Ask.",
    "9. Execute exactly the returned `workflow_finalize_native_specification_phase.required_next_tool.arguments` on the trusted host UI. This is the selected `workflow_checkpoint_ask_selected` current-user checkpoint; never infer approval before the user answers. Offer exactly `approve_continue`, `request_changes`, and `approve_stop`. A successful selected Ask atomically persists the typed decision with engine-derived bindings and returns the next workflow action.",
    "   Selected checkpoint Ask calls are a single trusted terminal UI and MUST be strictly sequential: preserve each complete returned descriptor keyed by its exact feature_id/run_key, execute one descriptor, wait for that Ask to return, and only then execute the next feature's descriptor. Never invoke, gather, delegate, or batch selected Ask calls concurrently (including Promise.all, coroutines, or parallel write calls), never submit a second Ask while one is pending, and never fall back to `workflow_checkpoint`; a successful selected Ask already applies the decision.",
    "10. After each selected Ask returns, immediately execute its exact returned `required_next_tool.arguments` descriptor verbatim; this returned descriptor is `workflow_advance` and MUST execute before resuming the queue or any other feature work. It is not a `workflow_checkpoint` payload. Never construct, edit, omit, or recompute any field (including rationale, evidence, actor_provenance, subject_binding, or handoff selector). On `approve_continue`, continue with the exact next native transition after `workflow_advance`; on `request_changes`, revise only the affected phase and repeat the composite path before opening another feature's Ask; on `approve_stop`, preserve the terminal finding and stop the feature wave. Do not advance the Ask queue while the current feature applied transition or revision loop is pending.",
    "Independent scheduled features may prepare, dispatch, and finalize concurrently before their human checkpoint, and may continue non-interactive transitions after their completed Ask; their selected Ask calls remain strictly sequential as required above. Facets sharing one feature/phase remain in the one returned workspace and serialize behind its engine-issued phase writer; never create sibling facet workspaces.",
    "",
    stateReadOnlyPreparationContract(opts),
    "",
    "### Hard terminal boundary",
    "After every scheduled feature’s Tasks checkpoint is approved and its native implementation-ready handoff exists, call the read-only `cto_specification_review`, then `cto_specification_decide` once with the exact trusted proofs, then `cto_specification_advance` exactly once. These tools never fabricate proof, grant approval, or dispatch implementation workers.",
    "Preparation completion is not execution intent: do not call `/do-work`, acquire an implementation claim, create implementation evidence, dispatch an implementation lead/worker, or use a token-bearing completion substitute.",
    "Return every scheduled feature’s exact run_key, approved Tasks evidence, handoff_id, and handoff_digest, and state that a separate `/cto execute --spec <feature-id> --run-key <run-key>` request is required for execution.",
    "",
    renderChannelSection(cwd),
    "",
    "Begin with the canonical constitution prerequisite using the mounted `ensure_project_constitution`/`present_constitution_draft`/`decide_constitution_checkpoint` tools for the explicit first-request feature and resident cto_run_id. Then call `cto_specification_prepare`, `workflow_prepare`, and the composite native phase path in that order; never bootstrap feature workspaces directly.",
  ].join("\r\n");
}

/** Prompt used when the user must choose a route; it contains neither route's tools. */
export function buildAmbiguousCtoPrompt(
  envelope: ParsedCtoEnvelope,
  cwd: string,
  opts: CtoPromptOptions = {},
  activeRunId?: string,
): string {
  const active = activeRunId ? `An active resident CTO run exists (\`${activeRunId}\`); do not create or amend a wave until intent is resolved.` : "No route is selected yet.";
  return [
    "/cto — intent is ambiguous; no work started",
    "",
    "The request does not unambiguously choose specification preparation or execution of existing ready handoffs.",
    active,
    "",
    "### Request",
    envelope.task,
    "",
    buildClassificationPhaseZero({ label: "leading directive", value: envelope.autonomyHint }),
    "",
    "### Required current-user checkpoint",
    "Ask the current user to choose exactly one route:",
    "1. PREPARATION — create or revise canonical feature specifications (provide explicit feature ids/facets).",
    "2. EXECUTION — execute existing ready handoffs (provide `--spec <feature-id> --run-key <run-key>` for every selected handoff).",
    "Until the user answers, do neither route: do not call workflow tools, do not call CTO execution tools, do not write state, do not acquire claims, and do not spawn workers.",
    "Do not infer intent from cwd, branch, active pointers, feature names, the word feature, or autonomy wording. A checkpoint answer is required before any route begins.",
    "",
    stateReadOnlyPreparationContract(opts),
    "",
    renderChannelSection(cwd),
  ].join("\r\n");
}

/** Route the fresh /cto prompt through the explicit intent gate. */
export function buildCtoPrompt(envelope: ParsedCtoEnvelope, cwd: string, opts: CtoPromptOptions = {}): string {
  const decision = classifyCtoIntent(envelope);
  if (decision.mode === "preparation") return buildPreparationCtoPrompt(envelope, cwd, opts);
  if (decision.mode === "execution") return buildExecutionCtoPrompt(envelope, cwd, opts);
  if (decision.mode === "general") return buildGeneralCtoPrompt(envelope, cwd, opts);
  return buildAmbiguousCtoPrompt(envelope, cwd, opts);
}

function ctoRunDeliveryStatusForAuthority(state: CtoState): "active" | "standby" | "done" | "failed" {
  if (state.pause?.kind === "done") return "done";
  if (state.pause?.kind === "failed") return "failed";
  return state.standby === true ? "standby" : "active";
}

function ctoRunDeliverySummaryDigestForAuthority(state: CtoState): string {
  if (!Array.isArray(state.wave_history)) return "";
  const completed = state.wave_history
    .filter((wave) => wave && typeof wave === "object" && typeof wave.id === "string" && typeof wave.finished_at === "string")
    .map((wave) => {
      const value = wave as { id: string; finished_at: string; status?: string };
      return value.id + "\u0000" + value.finished_at + "\u0000" + (value.status ?? "");
    })
    .sort();
  return completed.length === 0 ? "" : createHash("sha256").update(completed.join("\n")).digest("hex");
}

function compareVerifiedCtoRuns(
  left: { state: CtoState },
  right: { state: CtoState },
): number {
  const leftUpdatedAt = typeof left.state.updated_at === "string" ? left.state.updated_at : "";
  const rightUpdatedAt = typeof right.state.updated_at === "string" ? right.state.updated_at : "";
  if (leftUpdatedAt !== rightUpdatedAt) return rightUpdatedAt.localeCompare(leftUpdatedAt);
  const leftRevision = Number.isSafeInteger(left.state.state_revision) && (left.state.state_revision as number) >= 0 ? left.state.state_revision as number : 0;
  const rightRevision = Number.isSafeInteger(right.state.state_revision) && (right.state.state_revision as number) >= 0 ? right.state.state_revision as number : 0;
  if (leftRevision !== rightRevision) return rightRevision > leftRevision ? 1 : -1;
  return left.state.id < right.state.id ? -1 : left.state.id > right.state.id ? 1 : 0;
}

export class CtoAuthorityUnavailableError extends Error {
  readonly code = "CTO_AUTHORITY_UNAVAILABLE";

  constructor(message = "canonical CTO delivery authority is unavailable") {
    super(message);
    this.name = "CtoAuthorityUnavailableError";
  }
}

/**
 * Find the single active CTO run from canonical engine-written state.json.
 * Markdown-only runs are inactive and never become execution authority. A run
 * is finished when its pause is done/failed, or all teams done plus integration
 * done.
 *
 * Session ownership (RC4): when a `sessionId` is provided, interactive task
 * runs that declare a DIFFERENT owner are skipped — a foreign session gets
 * a fresh contract instead of amending another session's run. Standby runs
 * (`standby: true`) remain adoptable cross-session so inbox continuity is
 * preserved, and unowned/legacy runs stay amendable (status quo).
 * Returns the latest by updated_at among the eligible runs.
 * The amend protocol (br-k19): a second `/cto` while a run is active folds
 * the new task into THAT run instead of starting a fresh orchestrator.
 */
export function findActiveCtoRun(
  cwd: string,
  opts: { sessionId?: string; pinnedRoot?: PinnedProjectRoot } = {},
): { runId: string; state: CtoState } | null {
  const suppliedPin = opts.pinnedRoot;
  const pinnedRoot = suppliedPin ?? PinnedProjectRoot.open(cwd);
  if (!pinnedRoot) return null;
  try {
    // Authorization/discovery consumes the bounded reconciled canonical set.
    // It must recover valid omissions before selecting an active run.
    const candidates = readCtoRunDeliveryReconciledActiveCandidatesPinned(pinnedRoot);
    if (!candidates.ok) throw new CtoAuthorityUnavailableError();
    const verified: Array<{ runId: string; state: CtoState }> = [];
    for (const entry of candidates.entries) {
      if (!isSafeCtoRunId(entry.run_id)) continue;
      const state = readCtoStatePinned(entry.run_id, pinnedRoot);
      if (!state || state.id !== entry.run_id) continue;
      if (!hasValidCtoRuntimeRunOriginPinned(pinnedRoot, state) || !hasValidCtoRuntimeStateProofPinned(pinnedRoot, state)) throw new CtoAuthorityUnavailableError("CTO_RUNTIME_ORIGIN_RECOVERY_REQUIRED: active run origin/state proof is missing or stale");
      if (isCtoRunTerminal(state)) continue;
      const stateRevision = Number.isSafeInteger(state.state_revision) && (state.state_revision as number) >= 0 ? state.state_revision as number : 0;
      if (entry.status !== ctoRunDeliveryStatusForAuthority(state)
        || entry.state_revision !== stateRevision
        || entry.updated_at !== state.updated_at
        || entry.summary_digest !== ctoRunDeliverySummaryDigestForAuthority(state)) {
        continue;
      }
      verified.push({ runId: entry.run_id, state });
    }
    verified.sort(compareVerifiedCtoRuns);
    for (const candidate of verified) {
      if (!isRunOwnedBySession(candidate.state, opts.sessionId)) continue;
      return candidate;
    }
    return null;
  } catch (error) {
    if (error instanceof PinnedRootError && error.code === "not_found") return null;
    throw error;
  } finally {
    if (!suppliedPin) pinnedRoot.close();
  }
}

/**
 * Ownership gate for amend/continuation: standby runs are adoptable by any
 * session; a run declaring a foreign `owner_session` is only eligible for
 * its owner; unowned runs stay eligible (legacy agent-written/engine runs).
 */
function isRunOwnedBySession(state: CtoState, sessionId: string | undefined): boolean {
  if (state.standby === true) return true;
  if (sessionId && state.owner_session && state.owner_session !== sessionId) return false;
  return true;
}

/**
 * Amend contract: returned by `/cto` when a run is already active. The new
 * task is folded into the same run by the SAME orchestrator (single CTO).
 */
function buildExecutionAmendPrompt(
  envelope: ParsedCtoEnvelope,
  cwd: string,
  active: { runId: string; state: CtoState },
  opts: CtoPromptOptions = {},
): string {
  const teamsLine = active.state.teams.map((t) => `${t.id}:${t.status}`).join(", ");
  const issueMeta = envelope.issue ? `Issue: #${envelope.issue}\r\n` : "";
  const sessionMeta = opts.sessionId ? `Session: \`${opts.sessionId}\` (state field: \`owner_session\`)\r\n` : "";
  const parsedSelectors = parsedCtoSelections(envelope);
  const requestedSelectorsJson = JSON.stringify(parsedSelectors.selections);
  const firstSelectorPayload = JSON.stringify({ selections: parsedSelectors.selections });
  return [
    "/cto AMEND — a new task arrived while a CTO run is ACTIVE.",
    "",
    "### Active run",
    `Run: \`${active.runId}\` (started ${active.state.plan.created_at})`,
    `Teams: ${teamsLine}`,
    `Pause: ${active.state.pause?.kind ?? "none"} — ${active.state.pause?.reason || "no reason"}`,
    `State: \`.work-state/cto/${active.runId}/state.json\` (canonical engine state) — read it BEFORE touching anything.`,
    "",
    "### New task (fold into the SAME run id)",
    issueMeta + sessionMeta,
    envelope.task,
    "",
    "### Immutable requested selector set",
    `The public /cto parser accepted this exact ordered selector array; it is immutable request audit authority and MUST be preserved in \`cto_prepare\` results and findings: ${requestedSelectorsJson}`,
    "The execution route derives one canonical top-level classification and every task row from the frozen handoffs; do not send a classification field, TeamDef, task rows, or caller-owned DoD fields. The engine-owned value is exactly type=FEATURE, complexity=MEDIUM, confidence=HIGH, autonomous=true, workflow=standard.",
    `The first \`cto_prepare\` write MUST carry this exact selector payload (all pairs, in this order): ${firstSelectorPayload}`,
    "Operational preflight MUST use the exact `cto_prepare.required_next_tool.arguments` descriptor, whose selections contain only eligible rows. Excluded selectors are audit findings and MUST NOT be repeated in cto_preflight.",
    "",
    buildClassificationPhaseZero({ label: "leading directive", value: envelope.autonomyHint }),
    "",
    buildWorkflowMatrix(),
    "### Intent gate — EXECUTION (explicit feature_id/run_key ready handoffs)",
    "This amendment is an execution route only because its request explicitly selected existing feature_id/run_key handoffs.",
    "Do not create or revise specifications here; if a handoff is not ready, stop and report it rather than falling back to preparation.",
    "",
    "### Specification execution (explicit, confirmation-gated)",
    ...renderConstitutionToolContract({
      feature_id: "<exact selected feature_id>",
      run_key: "<exact selected run_key>",
      origin: {
        origin_kind: "cto_preparation",
        origin_run_key: "<exact selected run_key>",
        origin_stage: "cto",
      },
    }),
    "Apply that exact constitution contract for every selected feature/run pair before `cto_prepare`; do not write",
    "CTO state, mappings, claims, waves, identities, or DoD files, and do not call `workflow_prepare`.",
    "Select every feature/run pair explicitly; never infer selectors from cwd, branch, active pointers, or prompt text.",
    "Execution dispatch authority: never invoke /do-work or generic workflow_prepare, fabricate .work-state/team-state.json, or invent PHASE-0/per-slice classification. the mounted dispatch result is the only source of implementation admission; dispatch only its returned admitted_slices and copy each exact returned <!-- omp-cto-slice run=<runId> slice=<sliceId> --> marker verbatim into every lead/worker task.",
    "1. Call `cto_prepare` for the new explicit execution wave with the immutable full requested `selections` array rendered above;",
    "   execute `cto_preflight` with the exact eligible-only descriptor returned in `cto_prepare.required_next_tool.arguments`; never resend the immutable full request or excluded rows.",
    "   If the probe is blocked but returns `required_next_tool`, execute that exact retry descriptor directly—do not pause for human interaction—and report all blocked and excluded findings verbatim.",
    "2. Execute mounted `cto_checkpoint_ask_selected` by writing its exact JSON descriptor to `xd://cto_checkpoint_ask_selected`.",
    "   Present exactly three mapping choices (`approve_continue`, `request_changes`, `approve_stop`) to the",
    "   current user. Consume the exact engine-issued proof and execute mounted `cto_confirm` by writing its exact JSON descriptor",
    "   to `xd://cto_confirm`; only `approve_continue` may proceed. No claim or lead/worker spawn is allowed until confirmation succeeds.",
    "3. Execute mounted `cto_dispatch` by writing its exact JSON descriptor to `xd://cto_dispatch`; dispatch only returned admitted slices",
    "   carrying the exact run/slice marker. These tools never spawn workers and return no secrets.",
    ...ctoLeadContractPropagationContract(),
    "   Every lead/worker typed evidence artifact MUST be written under `.work-state/features/<feature_id>/artifacts/`;",
    "   filename MUST be `<artifact_id>.json`, and every submitted ref.path MUST be that exact repo-relative `.work-state/features/<feature_id>/artifacts/<artifact_id>.json` path; NEVER use a team-global artifact root.",
    "4. After all admitted slices return, collect typed evidence and perform the exact post-worker fan-in for every selected",
    "   feature; a lead/worker summary is not a completion proof and the wave remains active while any feature is pending. Before yielding, each admitted lead MUST preflight every frozen FR-1 and AC-1 subject: a passing lead requires implementation, review, and executed_test evidence for every subject; an irreparably blocked subject may yield one canonical intent_conflict record with a met evidence artifact, while a failing execution-profile verdict remains a separate gate record.",
    "   Canonical evidence envelopes MUST validate against packages/core/workflows/artifacts-schema.json definition `conformance_evidence`.",
    "   Every selected handoff MUST carry exactly one current execution-profile quality gate: `source: execution_profile`,",
    "   `gate_id: execution-profile.<selected workspace profile_hash>`, `status: pass|fail`, and a dereferenceable",
    "   `quality_gate_evidence` artifact reference. The engine rejects an omitted, stale, or wrong-profile gate; its derived",
    "   constitution gate is mandatory too but never substitutes for the selected execution-profile gate.",
    "   Their top-level keys are exactly `schema_version`, `artifact_id`, and `entries` (no `provenance` or any extra field); every `executed_test` entry MUST include `test.evidence_ref` with `artifact_id`, `path`, `sha256`, `schema_status`, and `quality_gate_status` and that artifact MUST be dereferenced before submission.",
    "   Every evidence artifact MUST be in `.work-state/features/<feature_id>/artifacts/` with filename `<artifact_id>.json`; each submitted ref.path MUST exactly equal that repo-relative `.work-state/features/<feature_id>/artifacts/<artifact_id>.json` path.",
    ...ctoConformanceArtifactNamingContract(),
    "5. Call mounted `cto_specification_conformance` exactly once for the amended mapping/wave with the exact admission binding,",
    "   selected handoffs, active claims, and nested implementation/review/executed-test evidence. Require its immutable ref per feature.",
    "6. Require each lead to return exactly one canonical terminal slice summary with worker ids, subject-level preflight verdicts, feature-local artifact refs/hashes, and unresolved blockers; one bounded internal worker repair is the maximum. Require the producer result to expose a persisted terminal matrix (`overall_status: pass` or `blocked`) for every selected feature.",
    "   Call mounted `workflow_complete_specification_execution` with the exact CTO envelope for passing features; blocked matrices retain explicit repair findings and do not wedge the wave.",
    "7. Call mounted `cto_close_specification_execution_wave` with the exact `cto_run_id`, `wave_id`, `mapping_id`,",
    "   `mapping_digest`, and one completion proof (`feature_id`, `run_key`, `handoff_digest`, `conformance_id`) per selected feature.",
    "   Require `closed: true`; inspect aggregate `outcome` (`pass` only when every matrix passes, otherwise `blocked`),",
    "   `blocked_feature_ids`, and bounded `findings`. Missing/nonterminal proof keeps the wave active; never mutate CTO state directly.",
    "",
    persistenceContract(opts),
    "### You are still the CTO (single orchestrator, this session)",
    "You are the MAIN AGENT — the resident CTO. Do NOT start a second run or orchestrator.",
    "Do NOT spawn a sub-CTO: NEVER `task(agent=cto)` / `task(agent=@cto)` (main-session only, no",
    "nested form). Continue the same run in-session.",
    "",
    "### Amend rules",
    "1. **Re-plan**: add teams from the registry (`.omp/teams.json`) for the new task — total teams across the",
    "   run <= 8, depth <= 2. New leads spawn in PARALLEL with active teams; existing teams keep working.",
    "   Choose sub-profiles from the Workflow resolution matrix above — the SAME table as /do-work (resolveWorkflow):",
    "   LECTURE_RESEARCH slices resolve to the research-only, human-gated `lecture-research` profile (see below).",
    "2. **Architecture**: if the new task adds cross-team surface, run the architect for the ADDITIONAL",
    "   contract (or extend the existing architecture artifact); new leads consume it.",
    "3. **Engine-owned transition**: ask the host/runtime to register the amendment and stamp its typed",
    "   evidence. Never append teams, amend state, or write `decisions.md` with `write`/`edit` from the CTO.",
    "4. **Integration covers ALL teams** (original + added): integration review verifies the merged result",
    "   against the (extended) contract; DoD aggregation across every team.",
    "5. **Edge cases**: run at max teams -> write the task to \`.work-state/queue.json\` for the next run;",
    "   run already in the integration phase -> same (queue it); scope overlap with an active team -> extend",
    "   that team's slice (re-spawn its lead with an additional worker task) instead of adding a team.",
    "6. **Escalations** of the new teams use the same ladder (worker -> lead -> you -> user); you never spawn",
    "   a second orchestrator.",
    `7. **Inbox check**: read \`.work-state/cto/${active.runId}/inbox/*.json\` for tasks that arrived while`,
    "   no session was listening; fold each in as its own wave.",
    "",
    "### LECTURE_RESEARCH slices (URL-first, research-only, human-gated)",
    "A slice classified `LECTURE_RESEARCH` (one public video/playlist URL + natural-language prompt) resolves deterministically to the",
    "`lecture-research` profile — a RESEARCH-ONLY workflow with automatic bounded acquisition and an explicit human approval/stop gate, DISTINCT",
    "from generic `INVESTIGATION` -> `research`. The URL is the only user content prerequisite and no transcript is requested.",
    "No transcript is requested.",
    "Requirements for such teams:",
    "1. **Research-only team profiles** (analyst, tech-researcher, diagnostics, security-tester) — never",
    "   developer profiles, never an implementation task, never application-source edits.",
    "2. **Automatic acquisition**: intake extracts exactly one URL and prompt; immediately invoke the consumer-provided",
    "   main-session `lecture_acquire` tool and require `lecture_acquisition`. Provider/API credentials, rights, and setup",
    "   are installation concerns; core does not fetch URLs. If the tool/provider is unavailable, fail closed — do not ask for a transcript.",
    "3. **Provenance/timecoded evidence**: acquisition is bounded and preserves failures; mapping consumes normalized",
    "   acquisition evidence, adds structured refs plus readable quotes, and performs NO network access/provider calls.",
    "4. **Repo-fit plus security review, READ-ONLY**: findings are checked against the repository and security-",
    "   reviewed before being presented as actionable; no fixes.",
    "5. **Human approval/stop gate**: the wave ends at an explicit human approval checkpoint (`ask` or a",
    "   `decision` escalation with `timeoutMs` + `default`). No implementation starts before approval. NO implementation, task creation, or source edits before approval; on rejection",
    "   or stop the wave closes with findings as the artifact, never code. Only AFTER approval may a new,",
    "   separately-classified implementation slice be created (own classification, workflow, DoD, wave).",
    "",
    "### Wave / slice gate contract (BEFORE any new lead is spawned)",
    "A lead/worker `task` call is mechanically blocked until the engine reports an active wave with exact",
    "team/slice mapping, per-slice classification, matrix-resolved workflow, and readable non-empty DoD.",
    "For a ready specification, use the mounted `cto_prepare` → `cto_preflight` (probe, then ready-only retry) →",
    "`cto_checkpoint_ask_selected` by writing its exact JSON descriptor to `xd://cto_checkpoint_ask_selected` →",
    "`cto_confirm` by writing its exact JSON descriptor to `xd://cto_confirm` → `cto_dispatch` by writing its exact JSON descriptor to",
    "`xd://cto_dispatch`; these engine-owned tools perform the locked state transition and return non-secret identities. Do not amend",
    "state.json, mappings, claims, waves, identities, or DoD files with `write`/`edit`, and do not substitute `workflow_prepare` or a TypeScript trampoline.",
    "Only dispatch returned `admitted_slices`; stamp each lead/worker task with the exact",
    "`<!-- omp-cto-slice run=<runId> slice=<sliceId> -->` marker and propagate it mechanically.",
    "",
    renderChannelSection(cwd),
    "Do not close the amended wave until the conformance producer has persisted a terminal pass or blocked matrix for EVERY selected feature",
    "and the canonical workflow completion finalizer has returned successful terminal postimages for every passing feature. Then call mounted",
    "`cto_close_specification_execution_wave` with the exact run/wave/mapping digest and one completion proof per selected feature; require",
    "`closed: true` and inspect aggregate `outcome`, `blocked_feature_ids`, and bounded `findings` (blocked is terminal but never success).",
    "The engine alone performs the terminal wave CAS and clears `active_wave_id`; never set `wave_history`, `active_wave_id`, or any other CTO",
    "state field directly, including through `write`/`edit`.",
    "",
    "Begin: read the active state, amend the plan, spawn the new leads.",
  ].join("\r\n");
}



/** Amend prompt for the legacy general CTO route. */
function buildGeneralAmendPrompt(
  envelope: ParsedCtoEnvelope,
  cwd: string,
  active: { runId: string; state: CtoState },
  opts: CtoPromptOptions = {},
): string {
  const teamsLine = active.state.teams.map((team) => `${team.id}:${team.status}`).join(", ");
  const general = buildGeneralCtoPrompt(envelope, cwd, opts).replace(
    "/cto workflow — GENERAL orchestration (intent gate resolved)",
    "/cto AMEND — GENERAL orchestration (intent gate resolved)",
  );
  return [
    general,
    "",
    "### Active run amendment",
    `Run: \`${active.runId}\` (started ${active.state.plan.created_at})`,
    `Teams: ${teamsLine}`,
    `Pause: ${active.state.pause?.kind ?? "none"} — ${active.state.pause?.reason || "no reason"}`,
    "Fold this task into the SAME resident CTO run as a NEW wave; never start a second CTO.",
    "Read the active run and its inbox through the host/runtime, then ask the engine/runtime to register the amendment before any lead spawn.",
    "Integration covers ALL teams (original plus added); close ONLY the amended wave and keep the SAME run id active.",
  ].join("\r\n");
}

/** Route an active-run amendment through the same explicit intent gate. */
export function buildAmendPrompt(
  envelope: ParsedCtoEnvelope,
  cwd: string,
  active: { runId: string; state: CtoState },
  opts: CtoPromptOptions = {},
): string {
  const decision = classifyCtoIntent(envelope);
  if (decision.mode === "preparation") return buildPreparationCtoPrompt(envelope, cwd, opts, active.runId);
  if (decision.mode === "execution") return buildExecutionAmendPrompt(envelope, cwd, active, opts);
  if (decision.mode === "general") return buildGeneralAmendPrompt(envelope, cwd, active, opts);
  return buildAmbiguousCtoPrompt(envelope, cwd, opts, active.runId);
}

// ── CTO specification execution integration (T097/T107) ────────────────────

/** Explicit selector accepted by the CTO specification execution seam. */
export type CtoSpecificationExecutionSelection = DomainSelection;
/** Input to the public CTO specification preflight seam. */
export type CtoSpecificationExecutionPreflightInput = DomainPreflightInput;
/** Result returned by the pure domain preflight seam and its durable wrapper. */
export type CtoSpecificationExecutionPreflightResult = DomainPreflightResult;

/** Parsed optional repeated `--spec <feature> --run-key <run>` selections. */
export interface ParsedCtoSpecificationSelections {
  selections: CtoSpecificationExecutionSelection[];
  task: string;
  error?: { code: "CTO_SPEC_ARGUMENT_INVALID" | "CTO_SPEC_SELECTOR_AMBIGUOUS"; message: string };
}

/** Durable mapping record kept under one canonical CTO run. */
export interface CtoSpecificationMappingRecord {
  schema_version: 1;
  cto_run_id: string;
  mapping: CtoSpecificationMapping;
  selections: CtoSpecificationExecutionSelection[];
  checkpoint_ref: string | null;
  trusted_answer_ref: string | null;
  review?: CtoSpecificationMappingReview;
  confirmation_context?: {
    feature_id: string;
    run_key: string;
    stage_id: string;
    decision: "approve_continue";
    capability_id: string;
    capability_epoch: string;
    policy_hash: string;
  };
  confirmed_at?: string;
  /** Logical consumed anchor state image authenticated by the mapping proof. */
  confirmation_state_after_digest?: string;
  /** Immutable tx-scoped HMAC proof for a consumed mapping confirmation. */
  confirmation_proof_ref?: string;
}

export type CtoSpecificationMappingReviewDecision = "approve_continue" | "request_changes" | "approve_stop";

function validCtoFeedback(value: unknown): value is string {
  return typeof value === "string"
    && value.length > 0
    && value === value.trim()
    && Buffer.byteLength(value, "utf8") <= MAX_CHECKPOINT_RATIONALE_BYTES
    && !/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(value);
}

export interface CtoSpecificationMappingReview {
  feature_id: string;
  run_key: string;
  stage_id: string;
  decision: CtoSpecificationMappingReviewDecision;
  checkpoint_ref: string;
  trusted_answer_ref: string;
  capability_id: string;
  capability_epoch: string;
  policy_hash: string;
  feedback?: string;
}

export interface CtoSpecificationMappingConfirmationInput {
  cto_run_id: string;
  mapping_id: string;
  mapping_hash: string;
  /** Canonical answer id issued by the trusted host Ask ledger. */
  answer_id: string;
}
/** Exact immutable candidate supplied by `cto_preflight` to the native mapping Ask. */
export interface CtoSpecificationMappingAskInput {
  cto_run_id: string;
  mapping_id: string;
  mapping_hash: string;
  mapping_version: number;
  feature_id: string;
  run_key: string;
  stage_id: string;
  feedback?: string;
}

/** Authenticated runtime capability required by every authoritative mapping mutation. */
export interface CtoSpecificationRuntimeMutationOptions {
  runtimeAccess: CtoRuntimeAccessFacade;
  sessionId: string;
}

/** Runtime-only bridge supplied by cto_checkpoint_ask_selected after host UI submission. */
export interface CtoSpecificationMappingAskHostOptions extends CtoSpecificationRuntimeMutationOptions {
  trusted_host: {
    bridge: object;
    question: string;
    options: readonly string[];
    session_id: string;
  };
}

export interface CtoSpecificationMappingAskReady {
  status: "ready";
  cto_run_id: string;
  mapping_id: string;
  mapping_hash: string;
  mapping_version: number;
  feature_id: string;
  run_key: string;
  stage_id: string;
  question_id: string;
  question: string;
  allowed_decisions: readonly ["approve_continue", "request_changes", "approve_stop"];
}

export type CtoSpecificationMappingAskPreparationResult =
  | CtoSpecificationMappingAskReady
  | { status: "blocked"; dispatched: false; findings: string[] };

export type CtoSpecificationMappingAskResult =
  | {
    status: "answered";
    dispatched: false;
    cto_run_id: string;
    mapping_id: string;
    mapping_hash: string;
    mapping_version: number;
    feature_id: string;
    run_key: string;
    stage_id: string;
    checkpoint_ref: string;
    decision: CtoSpecificationMappingReviewDecision;
    trusted_answer_ref: string;
    trusted_proof: CheckpointAnswerProof;
    feedback?: string;
  }
  | { status: "blocked"; dispatched: false; findings: string[] };

export interface CtoSpecificationMappingResumeInput {
  cto_run_id: string;
  mapping_id: string;
  mapping_hash: string;
  mapping_version: number;
}

export type CtoSpecificationMappingResumeResult =
  | {
    status: "resumed";
    dispatched: false;
    cto_run_id: string;
    mapping_id: string;
    mapping_hash: string;
    mapping_version: number;
    feature_id: string;
    run_key: string;
    stage_id: string;
  }
  | { status: "blocked"; dispatched: false; findings: string[] };

export interface CtoSpecificationMappingDispatchInput {
  cto_run_id: string;
  mapping_id: string;
  expected_mapping_hash: string;
}

export interface CtoSpecificationFeatureDispatchOutcome {
  feature_id: string;
  run_key: string;
  status: "claimed" | "blocked" | "not_ready";
  admitted_slice_ids: string[];
  claim?: ExecutionClaim;
  /** Explicit authority provenance; never inferred from claim identity. */
  disposition?: ExecutionClaimAcquisitionDisposition;
  finding?: string;
  lead_contract?: CtoSpecificationLeadEvidenceContract;
}

export interface CtoSpecificationLeadEvidenceContract {
  max_internal_repairs: 1;
  artifact_contract: {
    schema_version: 1;
    schema_version_values: readonly [1];
    timestamp_contract: {
      regex: "^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z$";
      valid_example: "2026-01-01T00:00:00.000Z";
      invalid_examples: readonly ["2026-01-01T00:00:00.30503000Z", "2026-01-01T00:00:00.818575000Z"];
      generation_rule: "Use ECMAScript new Date().toISOString() or trim deterministically to exactly 3 fractional digits; never shell date or %N.";
    };
    bounds: {
      evidence_entries_min_items: 1;
      evidence_entries_max_items: 256;
      quality_gates_min_items: 1;
      quality_gates_max_items: 64;
      gate_evidence_refs_max_items: 64;
      gate_findings_max_items: 128;
      finding_evidence_refs_max_items: 64;
      field_max_bytes: 16384;
      aggregate_max_bytes: 2097152;
      nesting_max_depth: 4;
    };
    bindings: {
      feature_id: string;
      handoff_digest: string;
      execution_claim_id: string;
      execution_profile_gate_id: string;
    };
    conformance: {
      artifact_id: string;
      path: string;
      envelope_required_keys: readonly ["schema_version", "artifact_id", "entries"];
      envelope_allowed_keys: readonly ["schema_version", "artifact_id", "entries"];
      entry_required_keys: readonly ["evidence_id", "kind", "subject_id", "requirement_id", "handoff_digest", "execution_claim_id", "recorded_at"];
      entry_allowed_keys: readonly ["evidence_id", "kind", "subject_id", "requirement_id", "handoff_digest", "execution_claim_id", "review_verdict", "test", "intent_message", "recorded_at"];
      allowed_kinds: readonly ["implementation", "review", "executed_test", "intent_conflict"];
      kind_requirements: {
        review: readonly ["review_verdict"];
        executed_test: readonly ["test"];
        intent_conflict: readonly ["intent_message"];
      };
      review_verdict_values: readonly ["pass", "fail"];
      evidence_id_pattern: "^[A-Za-z0-9._-]+$";
      artifact_id_pattern: "^[A-Za-z0-9._-]+$";
      identifier_max_bytes: 128;
      test_required_keys: readonly ["evidence_ref", "test_kind", "status", "executed_at"];
      test_allowed_keys: readonly ["evidence_ref", "test_kind", "status", "executed_at"];
      test_kind_values: readonly ["unit", "integration", "e2e", "runtime"];
      status_values: readonly ["pass", "fail"];
      evidence_ref_required_keys: readonly ["artifact_id", "path", "sha256", "schema_status", "quality_gate_status"];
      evidence_ref_allowed_keys: readonly ["artifact_id", "path", "sha256", "schema_status", "quality_gate_status"];
      schema_status_values: readonly ["met", "failed"];
      quality_gate_status_values: readonly ["met", "pending", "failed"];
      sha256_pattern: "^[a-f0-9]{64}$";
      handoff_digest_pattern: "^[a-f0-9]{64}$";
      evidence_handoff_digest_binding: "artifact_contract.bindings.handoff_digest";
      evidence_execution_claim_id_binding: "artifact_contract.bindings.execution_claim_id";
      path_template: ".work-state/features/<feature_id>/artifacts/<artifact_id>.json";
    };
    quality_gate: {
      artifact_id: string;
      path: string;
      envelope_required_keys: readonly ["schema_version", "artifact_id", "gates"];
      envelope_allowed_keys: readonly ["schema_version", "artifact_id", "gates"];
      gate_required_keys: readonly ["gate_id", "source", "status", "evidence_refs", "findings", "evaluated_at"];
      gate_allowed_keys: readonly ["gate_id", "source", "status", "evidence_refs", "findings", "evaluated_at"];
      finding_required_keys: readonly ["code", "subject_id", "message", "evidence_refs"];
      finding_allowed_keys: readonly ["code", "subject_id", "message", "evidence_refs"];
      finding_evidence_refs_type: "string[]";
      source_values: readonly ["project_constitution", "execution_profile"];
      status_values: readonly ["pass", "fail"];
      evidence_ref_required_keys: readonly ["artifact_id", "path", "sha256", "schema_status", "quality_gate_status"];
      evidence_ref_allowed_keys: readonly ["artifact_id", "path", "sha256", "schema_status", "quality_gate_status"];
      schema_status_values: readonly ["met", "failed"];
      quality_gate_status_values: readonly ["met", "pending", "failed"];
      sha256_pattern: "^[a-f0-9]{64}$";
      path_template: ".work-state/features/<feature_id>/artifacts/<artifact_id>.json";
    };
    topology: {
      quality_gate_must_be_written_first: true;
      quality_gate_persisted_gate_evidence_refs: readonly [];
      supporting_runtime_artifact_id_prefix: "runtime_test_evidence-";
      supporting_runtime_artifact_path_template: ".work-state/features/<feature_id>/artifacts/runtime_test_evidence-<feature_id>.json";
      supporting_runtime_artifact_envelope: "conformance_evidence";
      supporting_runtime_envelope_must_contain_executed_tests: true;
      supporting_runtime_inner_test_evidence_ref_must_equal_quality_gate_ref: true;
      supporting_runtime_rows_exact_multiset: true;
      supporting_runtime_row_key_fields: readonly ["evidence_id", "kind", "subject_id", "requirement_id", "test_kind", "status", "executed_at", "handoff_digest", "execution_claim_id"];
      contradictory_review_or_test_statuses_block: true;
      intent_conflict_status: "changed_intent";
      conformance_must_be_written_after_supporting_runtime: true;
      outer_executed_test_evidence_ref_must_equal_supporting_runtime_ref: true;
      outer_executed_test_evidence_ref_envelope: "conformance_evidence";
      quality_gate_must_not_be_rewritten_after_conformance: true;
      forbidden_standalone_nested_artifact_id_prefixes: readonly ["implementation_evidence-", "runtime_test_evidence-"];
    };
  };
  subjects: Array<{
    subject_id: string;
    requirement_id: string;
    observable_behavior: boolean;
    required_evidence_kinds: Array<"implementation" | "review" | "executed_test">;
  }>;
  terminal_intent_conflict: { kind: "intent_conflict"; artifact_quality_gate_status: "met"; profile_gate_separate: true };
}

export type CtoSpecificationExecutionConfirmationInput = CtoSpecificationMappingConfirmationInput;
export type CtoSpecificationExecutionDispatchInput = CtoSpecificationMappingDispatchInput;

export type CtoSpecificationMappingConfirmationResult =
  | { status: "confirmed"; dispatched: false; mapping: CtoSpecificationMapping; checkpoint_ref: string; trusted_answer_ref: string }
  | { status: "blocked"; dispatched: false; findings: string[] };

export type CtoSpecificationMappingDispatchResult =
  | { status: "dispatched"; dispatched: true; mapping: CtoSpecificationMapping; mapping_digest: string; admitted_slices: string[]; claims: ExecutionClaim[]; outcomes: CtoSpecificationFeatureDispatchOutcome[]; conformance_binding?: CtoSpecificationConformanceBinding; findings: string[] }
  | { status: "blocked"; dispatched: false; outcomes?: CtoSpecificationFeatureDispatchOutcome[]; findings: string[]; recovery_claims?: ExecutionClaim[] };
/**
 * Parse optional explicit selectors without changing the legacy `/cto` task
 * grammar. Unknown tokens remain task text; each option must be paired.
 */
export function parseCtoSpecificationExecutionSelections(args: string): ParsedCtoSpecificationSelections {
  if (typeof args !== "string") return { selections: [], task: "", error: { code: "CTO_SPEC_ARGUMENT_INVALID", message: "arguments must be a string" } };
  if (Buffer.byteLength(args, "utf8") > MAX_CTO_SPECIFICATION_AGGREGATE_BYTES) {
    return { selections: [], task: "", error: { code: "CTO_SPEC_ARGUMENT_INVALID", message: `arguments exceed ${MAX_CTO_SPECIFICATION_AGGREGATE_BYTES} bytes` } };
  }
  const trimmed = args.trim();
  const tokens = trimmed.length === 0 ? [] : trimmed.split(/\s+/);
  const maxSelectorTokens = MAX_CTO_SPECIFICATION_REQUESTS * 4 + 1024;
  if (tokens.length > maxSelectorTokens) {
    return { selections: [], task: trimmed, error: { code: "CTO_SPEC_ARGUMENT_INVALID", message: `arguments contain too many tokens (maximum ${maxSelectorTokens})` } };
  }
  const selections: CtoSpecificationExecutionSelection[] = [];
  const task: string[] = [];
  let pendingFeature: string | undefined;
  let pendingRun: string | undefined;
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]!;
    if (token === "--spec") {
      if (selections.length >= MAX_CTO_SPECIFICATION_REQUESTS) {
        return { selections: [], task: trimmed, error: { code: "CTO_SPEC_ARGUMENT_INVALID", message: `at most ${MAX_CTO_SPECIFICATION_REQUESTS} specification selections are allowed` } };
      }
      if (pendingFeature !== undefined) return { selections: [], task: trimmed, error: { code: "CTO_SPEC_SELECTOR_AMBIGUOUS", message: "--spec must be followed by one --run-key pair" } };
      const feature = tokens[++index];
      if (!feature || feature.startsWith("--") || !isSafeFeatureId(feature)) return { selections: [], task: trimmed, error: { code: "CTO_SPEC_ARGUMENT_INVALID", message: "--spec requires a safe non-blank feature id" } };
      pendingFeature = feature;
      continue;
    }
    if (token === "--run-key") {
      if (pendingFeature === undefined || pendingRun !== undefined) return { selections: [], task: trimmed, error: { code: "CTO_SPEC_ARGUMENT_INVALID", message: "--run-key must immediately complete a preceding --spec" } };
      const runKey = tokens[++index];
      if (!runKey || runKey.startsWith("--") || !isSafeCtoExecutionId(runKey)) return { selections: [], task: trimmed, error: { code: "CTO_SPEC_ARGUMENT_INVALID", message: "--run-key requires a safe bounded run key" } };
      pendingRun = runKey;
      selections.push({ feature_id: pendingFeature, run_key: pendingRun });
      pendingFeature = undefined;
      pendingRun = undefined;
      continue;
    }
    if (pendingFeature !== undefined) return { selections: [], task: args.trim(), error: { code: "CTO_SPEC_ARGUMENT_INVALID", message: "--spec and --run-key must be an adjacent pair" } };
    task.push(token);
  }
  if (pendingFeature !== undefined || pendingRun !== undefined) return { selections: [], task: args.trim(), error: { code: "CTO_SPEC_ARGUMENT_INVALID", message: "every --spec must be paired with --run-key" } };
  const seen = new Map<string, Set<string>>();
  for (const selection of selections) {
    const runs = seen.get(selection.feature_id) ?? new Set<string>();
    if (runs.has(selection.run_key)) return { selections: [], task: task.join(" "), error: { code: "CTO_SPEC_SELECTOR_AMBIGUOUS", message: `duplicate selection '${selection.feature_id}'` } };
    runs.add(selection.run_key);
    seen.set(selection.feature_id, runs);
  }
  return { selections, task: task.join(" ") };
}

/** Short alias for hosts that expose the parser as CTO specification selections. */
export const parseCtoSpecificationSelections = parseCtoSpecificationExecutionSelections;

function blockedExecution(findings: string[]): { status: "blocked"; dispatched: false; findings: string[] } {
  return { status: "blocked", dispatched: false, findings };
}

function ensureCtoExecutionConstitutions(
  root: string,
  selections: readonly CtoSpecificationExecutionSelection[],
  pinnedRoot: PinnedProjectRoot,
): string[] {
  const findings: string[] = [];
  for (const selection of selections) {
    const workspace = resolveFeatureWorkspace(root, selection, workspaceSnapshotForPinnedRoot(pinnedRoot), { persistMigration: false, requireMigration: true });
    if (!workspace.ok && workspace.code === "SPEC_MIGRATION_REQUIRED") {
      findings.push(`${selection.feature_id}: ${workspace.code}: ${workspace.error}`);
      continue;
    }
    const persisted = readProjectConstitutionGate(root, pinnedRoot);
    if (!persisted.ok) {
      findings.push(`${selection.feature_id}: ${persisted.code}: ${persisted.error}`);
      continue;
    }
    const provider = persisted.value.provider;
    const ensured = ensureProjectConstitution(root, {
      origin_kind: persisted.value.origin_kind,
      origin_run_key: persisted.value.origin_run_key,
      origin_stage: persisted.value.origin_stage,
    }, {
      feature_id: selection.feature_id,
      explicit_path: provider?.source === "explicit_override" ? provider.path : null,
      pinnedRoot,
    });
    if (!ensured.ok) {
      findings.push(`${selection.feature_id}: ${ensured.code}: ${ensured.error}`);
      continue;
    }
    if (ensured.value.status !== "usable" || !ensured.value.binding) {
      findings.push(`${selection.feature_id}: SPEC_CONSTITUTION_IMPACT_PENDING: live constitution prerequisite is ${ensured.value.status}`);
    }
  }
  return findings;
}

function canonicalExecutionRoot(projectRoot: string): string | null {
  if (typeof projectRoot !== "string" || projectRoot.trim().length === 0) return null;
  try { return realpathSync(resolve(projectRoot)); } catch { return null; }
}

function pathWithin(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === "" || (!rel.startsWith("..") && !rel.startsWith(sep) && !rel.includes("\\"));
}

function canonicalPathWithoutSymlinks(root: string, candidate: string, requireRegularFile = false): string | null {
  const absolute = resolve(candidate);
  if (!pathWithin(root, absolute)) return null;
  const rel = relative(root, absolute);
  let cursor = root;
  for (const segment of rel.split(sep).filter(Boolean)) {
    cursor = join(cursor, segment);
    if (!existsSync(cursor)) continue;
    try {
      const link = lstatSync(cursor);
      if (link.isSymbolicLink()) return null;
      if (!pathWithin(root, realpathSync(cursor))) return null;
    } catch { return null; }
  }
  if (requireRegularFile) {
    try { if (!lstatSync(absolute).isFile()) return null; } catch { return null; }
  }
  return absolute;
}

function workspaceSnapshotForPinnedRoot(pinnedRoot: PinnedProjectRoot): WorkspaceRootSnapshot {
  return { lexical_root: pinnedRoot.lexical_root, canonical_root: pinnedRoot.canonical_root, dev: pinnedRoot.dev, ino: pinnedRoot.ino, pinned_root: pinnedRoot };
}

function pinnedRelativePath(pinnedRoot: PinnedProjectRoot, candidate: string): string {
  const relativePath = pinnedRoot.relativePath(candidate);
  if (!relativePath) throw new PinnedRootError("path_unauthorized", "mapping transaction path escapes the pinned project root");
  return relativePath;
}
type MappingTransactionWalReceipt = {
  bytes: Buffer;
  dev: number;
  ino: number;
  sha256: string;
};
type ParsedMappingTransaction = CtoSpecificationMappingTransaction & {
  wal_receipt: MappingTransactionWalReceipt;
};
type MappingTransactionWithWalReceipt = CtoSpecificationMappingTransaction & {
  wal_receipt: MappingTransactionWalReceipt;
};
type MappingTransactionWithOptionalWalReceipt = CtoSpecificationMappingTransaction & {
  wal_receipt?: MappingTransactionWalReceipt;
};
function mappingTransactionWalReceipt(bytes: Buffer, dev: number, ino: number): MappingTransactionWalReceipt {
  return { bytes: Buffer.from(bytes), dev, ino, sha256: createHash("sha256").update(bytes).digest("hex") };
}

type PinnedRegularRead = { ok: true; bytes: Buffer; dev: number; ino: number } | { ok: false; error: string };

function readPinnedRegularFile(
  pinnedRoot: PinnedProjectRoot,
  candidate: string,
  maxBytes = 8 * 1024 * 1024,
): PinnedRegularRead {
  try {
    const read = pinnedRoot.readFile(pinnedRelativePath(pinnedRoot, candidate), { maxBytes });
    return { ok: true, bytes: Buffer.from(read.bytes), dev: read.dev, ino: read.ino };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

function mappingPath(root: string, ctoRunId: string, mappingId: string, pinnedRoot?: PinnedProjectRoot): string | null {
  if (!isSafeCtoRunId(ctoRunId) || !isSafeCtoExecutionId(mappingId)) return null;
  const candidate = join(pinnedRoot?.canonical_root ?? root, ".work-state", "cto", ctoRunId, "specification-mappings", mappingId + ".json");
  if (pinnedRoot) {
    try { pinnedRelativePath(pinnedRoot, candidate); return candidate; } catch { return null; }
  }
  return canonicalPathWithoutSymlinks(root, candidate);
}
function mappingHashBody(mapping: CtoSpecificationMapping): Record<string, unknown> {
  const { mapping_id: _id, mapping_hash: _hash, created_at: _created, updated_at: _updated, ...body } = mapping;
  return { ...body, checkpoint_ref: null, status: "awaiting_confirmation" };
}

function mappingHashMatches(mapping: CtoSpecificationMapping): boolean {
  return typeof mapping.mapping_hash === "string" && mapping.mapping_hash === digestOf(mappingHashBody(mapping))
    && mapping.mapping_id === `cto-mapping-${mapping.mapping_hash.slice(0, 32)}`;
}

type CtoSpecificationMappingTransactionStatus = "pending" | "aborting" | "aborted" | "quarantined";

interface CtoSpecificationMappingStateTransition {
  kind: "record_checkpoint_answer" | "consume_checkpoint_answer";
  answer_id: string;
  stage_id: string;
  checkpoint_id: string;
  decision: string;
  feature_id: string;
  run_key: string;
  subject_binding?: string;
  subject_revision?: number;
  capability_id?: string;
  capability_epoch?: string;
  policy_hash?: string;
  feedback?: string;
  consumed_at?: string;
}

interface CtoSpecificationMappingTransactionBase {
  schema_version: 1;
  status: CtoSpecificationMappingTransactionStatus;
  transaction_id: string;
  cto_run_id: string;
  mapping_id: string;
  mapping_hash: string;
  feature_id: string;
  run_key: string;
  mapping_path: string;
  /** Exact bytes and disposition that existed before this transaction. */
  mapping_before_disposition: "present" | "absent";
  mapping_before_content: string | null;
  mapping_before_digest: string;
  /** Exact identity of the staged mapping, not merely its semantic hash. */
  staged_mapping_identity: { mapping_id: string; mapping_hash: string; content_digest: string };
  mapping_after_digest: string;
  mapping_content: string;
  mapping: CtoSpecificationMapping;
  selections: CtoSpecificationExecutionSelection[];
  state_path: string;
  state_dir: string;
  artifacts_dir: string;
  is_legacy: boolean;
  state_before_digest: string;
  state_source_logical_digest: string;
  state_after_digest: string;
  state_transition: CtoSpecificationMappingStateTransition;
  /** Exact immutable proof sidecar staged before a confirmation WAL. */
  confirmation_proof_path?: string;
  confirmation_proof_digest?: string;
  confirmation_proof_content?: string;
  abort_reason?: string;
  abort_started_at?: string;
  terminal_at?: string;
  terminal_disposition?: "aborted" | "quarantined";
  abort_observed_mapping_digest?: string | null;
}
interface CtoSpecificationMappingStatefulTransaction extends CtoSpecificationMappingTransactionBase {
  /** WAL operation; legacy transactions are confirmations. */
  operation?: "confirm" | "answer";
  /** Exact source bytes and staged state used by the state CAS. */
  state_before_content: string;
  state_source_content: string;
  state: TeamState;
}
interface CtoSpecificationMappingDirectTransaction extends CtoSpecificationMappingTransactionBase {
  operation: "preflight" | "resume";
}
type CtoSpecificationMappingTransaction = CtoSpecificationMappingStatefulTransaction | CtoSpecificationMappingDirectTransaction;
type CtoSpecificationMappingTransactionCandidate = Partial<CtoSpecificationMappingTransactionBase> & {
  operation?: "confirm" | "answer" | "preflight" | "resume";
  state_before_content?: string;
  state_source_content?: string;
  state?: TeamState;
};
function isDirectMappingTransaction(transaction: CtoSpecificationMappingTransaction): transaction is CtoSpecificationMappingDirectTransaction {
  return transaction.operation === "preflight" || transaction.operation === "resume";
}
const MAX_MAPPING_TRANSACTIONS = 64;
const MAX_MAPPING_TRANSACTION_FILE_BYTES = 512 * 1024;
const MAX_MAPPING_TRANSACTION_AGGREGATE_BYTES = 4 * 1024 * 1024;
const MAX_MAPPING_TRANSACTION_JSON_DEPTH = 32;
const MAX_MAPPING_TRANSACTION_JSON_NODES = 12_000;
const MAX_MAPPING_TRANSACTION_JSON_KEYS = 128;
const MAX_MAPPING_TRANSACTION_JSON_ARRAY = 256;
const MAX_MAPPING_TRANSACTION_TEXT_BYTES = 256 * 1024;
const MAPPING_TRANSACTION_REQUIRED_KEYS = new Set([
  "schema_version", "transaction_id", "status", "cto_run_id", "mapping_id", "mapping_hash",
  "feature_id", "run_key", "mapping_path", "mapping_before_disposition", "mapping_before_content",
  "mapping_before_digest", "staged_mapping_identity", "mapping_after_digest", "mapping_content",
  "mapping", "selections", "state_path", "state_dir", "artifacts_dir", "is_legacy",
  "state_before_digest", "state_source_logical_digest", "state_after_digest", "state_transition",
]);
const MAPPING_TRANSACTION_OPTIONAL_KEYS = new Set([
  "state_before_content", "state_source_content", "state",
  "confirmation_proof_path", "confirmation_proof_digest", "confirmation_proof_content",
  "operation", "abort_reason", "abort_started_at", "terminal_at", "terminal_disposition",
  "abort_observed_mapping_digest",
]);

export type CtoSpecificationMappingFailurePoint =
  | "before_prepare"
  | "after_prepare"
  | "after_recovery_read"
  | "before_mapping_write"
  | "after_mapping_write"
  | "before_state_write"
  | "after_state_write"
  | "after_commit"
  | "before_abort"
  | "after_abort"
  | "before_abort_prepare"
  | "after_abort_prepare"
  | "before_abort_mapping_write"
  | "after_abort_mapping_write"
  | "before_abort_mapping_remove"
  | "after_abort_mapping_remove"
  | "before_abort_quarantine"
  | "after_abort_quarantine"
  | "before_abort_terminal"
  | "after_abort_terminal";

export type CtoSpecificationMappingFailureInjector = (
  point: CtoSpecificationMappingFailurePoint,
  transactionId: string,
) => void;

type CtoHookRecord<T> = { hook: T; aliases: string[] };
const mappingFailureInjectors = new Map<string, CtoHookRecord<CtoSpecificationMappingFailureInjector>>();
const ctoHookScopeKeys = (projectRoot: string): string[] => {
  const lexical = resolve(projectRoot);
  try {
    const canonical = resolve(realpathSync(projectRoot));
    return canonical === lexical ? [lexical] : [lexical, canonical];
  } catch {
    return [lexical];
  }
};
function ctoHookIdentity(projectRoot: string): string | undefined {
  try {
    const canonical = realpathSync(projectRoot);
    const stat = lstatSync(canonical);
    return "identity:" + String(stat.dev) + ":" + String(stat.ino);
  } catch {
    return undefined;
  }
}
function findCtoHook<T>(hooks: Map<string, CtoHookRecord<T>>, projectRoot: string, pinnedRoot?: PinnedProjectRoot): T | undefined {
  const aliases = pinnedRoot
    ? ["identity:" + String(pinnedRoot.dev) + ":" + String(pinnedRoot.ino), ...ctoHookScopeKeys(projectRoot)]
    : ctoHookScopeKeys(projectRoot);
  for (const alias of aliases) {
    const record = hooks.get(alias);
    if (record) return record.hook;
  }
  return undefined;
}
function setCtoHook<T>(hooks: Map<string, CtoHookRecord<T>>, hook: T | null, projectRoot: string): void {
  const aliases = [...ctoHookScopeKeys(projectRoot)];
  const identity = ctoHookIdentity(projectRoot);
  if (identity && !aliases.includes(identity)) aliases.push(identity);
  const previous = new Set<CtoHookRecord<T>>();
  for (const alias of aliases) {
    const record = hooks.get(alias);
    if (record) previous.add(record);
  }
  for (const record of previous) for (const alias of record.aliases) {
    if (hooks.get(alias) === record) hooks.delete(alias);
  }
  if (!hook) return;
  const record: CtoHookRecord<T> = { hook, aliases };
  for (const alias of aliases) hooks.set(alias, record);
}

/** Internal deterministic seam for revalidation after asynchronous execution work. */
export interface CtoSpecificationExecutionTestHooks {
  afterAwait?: (context: { root: string; cto_run_id: string }) => void | Promise<void>;
  /** Deterministic seam immediately before each direct mapping publication. */
  beforeMappingWrite?: (context: { root: string; cto_run_id: string; mapping_id: string; operation: "preflight" | "resume" }) => void;
}
const ctoSpecificationExecutionTestHooksByRoot = new Map<string, CtoHookRecord<CtoSpecificationExecutionTestHooks>>();
/** Test-only; intentionally not exported through the package index. */
export function setCtoSpecificationExecutionTestHooks(hooks: CtoSpecificationExecutionTestHooks | null, projectRoot: string): void {
  setCtoHook(ctoSpecificationExecutionTestHooksByRoot, hooks, projectRoot);
}
async function ctoExecutionAwaitBoundary(root: string, pinnedRoot: PinnedProjectRoot, ctoRunId: string): Promise<void> {
  await findCtoHook(ctoSpecificationExecutionTestHooksByRoot, root, pinnedRoot)?.afterAwait?.({ root, cto_run_id: ctoRunId });
}

export function setCtoSpecificationMappingFailureInjector(
  injector: CtoSpecificationMappingFailureInjector | null,
  projectRoot: string,
): void {
  setCtoHook(mappingFailureInjectors, injector, projectRoot);
}

function injectMappingFailure(
  projectRoot: string,
  pinnedRoot: PinnedProjectRoot,
  point: CtoSpecificationMappingFailurePoint,
  transactionId: string,
): void {
  findCtoHook(mappingFailureInjectors, projectRoot, pinnedRoot)?.(point, transactionId);
}

function mappingTransactionPath(
  tx: Pick<CtoSpecificationMappingTransaction, "cto_run_id" | "transaction_id">,
  pinnedRoot: PinnedProjectRoot,
): string {
  const path = join(pinnedRoot.canonical_root, ".work-state", "cto", tx.cto_run_id, "specification-mapping-transactions", tx.transaction_id + ".json");
  try { pinnedRelativePath(pinnedRoot, path); } catch { throw new Error("CTO_SPEC_MAPPING_TRANSACTION_INVALID: transaction path is unsafe"); }
  return path;
}
function mappingStateDigest(value: unknown): string {
  return ctoMappingConfirmationStateDigest(value);
}

function mappingStateIdentityMatches(root: string, transaction: Pick<CtoSpecificationMappingTransaction, "feature_id" | "run_key" | "state_path">, state: TeamState): boolean {
  const specification = state.specification;
  let projectRootMatches = false;
  try {
    projectRootMatches = Boolean(specification && realpathSync(resolve(specification.project_root)) === root);
  } catch {
    projectRootMatches = false;
  }
  return Boolean(
    specification
      && state.run_key === transaction.run_key
      && specification.feature_id === transaction.feature_id
      && projectRootMatches
      && specification.workspace_path === `specs/${transaction.feature_id}`
      && specification.state_path === relative(root, transaction.state_path),
  );
}

function mappingStateTransitionError(
  root: string,
  transaction: Pick<CtoSpecificationMappingTransaction, "operation" | "feature_id" | "run_key" | "state_path" | "state_transition">,
  source: TeamState,
  candidate: TeamState,
  verifyLiveAuthority = true,
): string | null {
  if (!mappingStateIdentityMatches(root, transaction, source) || !mappingStateIdentityMatches(root, transaction, candidate)) {
    return "state transition is not bound to the selected feature workspace";
  }
  const transition = transaction.state_transition;
  const expectedKind = transaction.operation === "answer" ? "record_checkpoint_answer" : "consume_checkpoint_answer";
  if (transition.kind !== expectedKind
    || transition.feature_id !== transaction.feature_id
    || transition.run_key !== transaction.run_key
    || !transition.answer_id
    || !transition.stage_id
    || !transition.checkpoint_id
    || !transition.decision) {
    return "state transition event identity is incomplete or mismatched";
  }
  const sourceAnswers = source.trusted_checkpoint_answers ?? [];
  const candidateAnswers = candidate.trusted_checkpoint_answers ?? [];
  const sameExceptConsumedAt = (left: Record<string, unknown>, right: Record<string, unknown>): boolean => {
    const leftCopy = { ...left };
    const rightCopy = { ...right };
    delete leftCopy.consumed_at;
    delete rightCopy.consumed_at;
    return canonicalJson(leftCopy) === canonicalJson(rightCopy);
  };
  const context = {
    run_id: transition.run_key,
    stage_id: transition.stage_id,
    checkpoint_id: transition.checkpoint_id,
    decision: transition.decision,
    ...(transition.feature_id ? { feature_id: transition.feature_id } : {}),
    ...(transition.subject_binding ? { subject_binding: transition.subject_binding } : {}),
    ...(transition.policy_hash ? { policy_hash: transition.policy_hash } : {}),
    ...(transition.capability_id ? { capability_id: transition.capability_id } : {}),
    ...(transition.capability_epoch ? { capability_epoch: transition.capability_epoch } : {}),
    ...(transition.subject_revision !== undefined ? { subject_revision: transition.subject_revision } : {}),
    ...(transition.feedback !== undefined ? { feedback: transition.feedback } : {}),
  };
  if (transition.kind === "record_checkpoint_answer") {
    if (transition.consumed_at !== undefined || candidateAnswers.length !== sourceAnswers.length + 1) {
      return "checkpoint answer recording event has an invalid answer cardinality";
    }
    if (canonicalJson(candidateAnswers.slice(0, sourceAnswers.length)) !== canonicalJson(sourceAnswers)) {
      return "checkpoint answer recording event changed an existing answer";
    }
    const answer = candidateAnswers[sourceAnswers.length];
    if (!answer || answer.answer_id !== transition.answer_id
      || answer.run_id !== transition.run_key
      || answer.stage_id !== transition.stage_id
      || answer.checkpoint_id !== transition.checkpoint_id
      || answer.decision !== transition.decision
      || answer.feature_id !== transition.feature_id
      || answer.subject_binding !== transition.subject_binding
      || answer.subject_revision !== transition.subject_revision
      || answer.capability_id !== transition.capability_id
      || answer.capability_epoch !== transition.capability_epoch
      || answer.policy_hash !== transition.policy_hash
      || answer.feedback !== transition.feedback
      || answer.consumed_at !== undefined) {
      return "checkpoint answer recording event does not match the staged answer";
    }
    const proof: CheckpointAnswerProof = {
      answer_id: answer.answer_id,
      nonce: answer.nonce,
      channel: answer.channel,
      reference: answer.reference,
      binding: answer.binding,
      ...(answer.feedback !== undefined ? { feedback: answer.feedback } : {}),
    };
    if (verifyLiveAuthority) {
      const proofError = trustedCheckpointAnswerError(candidate, {
        actor: { kind: "user", ref: answer.reference, proof },
        ...context,
        bind_active_context: true,
      });
      if (proofError) return `checkpoint answer recording proof is invalid: ${proofError}`;
    }
    const expected = { ...source, trusted_checkpoint_answers: candidateAnswers };
    if (mappingStateDigest(expected) !== mappingStateDigest(candidate)) {
      return "checkpoint answer recording changed fields outside the answer ledger";
    }
    return null;
  }

  if (transition.consumed_at === undefined || candidateAnswers.length !== sourceAnswers.length) {
    return "checkpoint answer consumption event has an invalid answer cardinality";
  }
  const sourceAnswer = sourceAnswers.find((answer) => answer.answer_id === transition.answer_id);
  const candidateAnswer = candidateAnswers.find((answer) => answer.answer_id === transition.answer_id);
  if (!sourceAnswer || !candidateAnswer || sourceAnswer.consumed_at !== undefined
    || candidateAnswer.consumed_at !== transition.consumed_at
    || !sameExceptConsumedAt(sourceAnswer as unknown as Record<string, unknown>, candidateAnswer as unknown as Record<string, unknown>)) {
    return "checkpoint answer consumption event does not match the staged answer";
  }
  let consumedAt: string;
  try {
    consumedAt = new Date(transition.consumed_at).toISOString();
  } catch {
    return "checkpoint answer consumption event has an invalid consumption timestamp";
  }
  if (consumedAt !== transition.consumed_at) return "checkpoint answer consumption timestamp is not canonical";
  const proof: CheckpointAnswerProof = {
    answer_id: sourceAnswer.answer_id,
    nonce: sourceAnswer.nonce,
    channel: sourceAnswer.channel,
    reference: sourceAnswer.reference,
    binding: sourceAnswer.binding,
    ...(sourceAnswer.feedback !== undefined ? { feedback: sourceAnswer.feedback } : {}),
  };
  if (verifyLiveAuthority) {
    const proofError = trustedCheckpointAnswerError(source, {
      actor: { kind: "user", ref: sourceAnswer.reference, proof },
      ...context,
      bind_active_context: true,
    });
    if (proofError) return `checkpoint answer consumption proof is invalid: ${proofError}`;
  }
  const expectedAnswers = sourceAnswers.map((answer) => answer.answer_id === transition.answer_id
    ? { ...answer, consumed_at: transition.consumed_at }
    : answer);
  const expected = { ...source, trusted_checkpoint_answers: expectedAnswers };
  if (mappingStateDigest(expected) !== mappingStateDigest(candidate)) {
    return "checkpoint answer consumption changed fields outside the answer ledger";
  }
  return null;
}
function mappingStateSourceContentError(
  transaction: Pick<CtoSpecificationMappingTransaction, "state_transition">,
  rawSource: TeamState,
  semanticSource: TeamState,
): string | null {
  const rawCopy = { ...(rawSource as unknown as Record<string, unknown>) };
  const semanticCopy = { ...(semanticSource as unknown as Record<string, unknown>) };
  delete rawCopy.updated_at;
  delete rawCopy.state_revision;
  delete rawCopy.control_plane_provenance;
  delete semanticCopy.updated_at;
  delete semanticCopy.state_revision;
  delete semanticCopy.control_plane_provenance;
  if (transaction.state_transition.kind === "record_checkpoint_answer") {
    // Recording first installs the exact checkpoint policy used to validate
    // the answer; all other source fields remain semantically unchanged.
    rawCopy.checkpoint_policy = semanticCopy.checkpoint_policy;
  }
  return canonicalJson(rawCopy) === canonicalJson(semanticCopy)
    ? null
    : "semantic source state is not derived from the exact raw source state";
}

function mappingTransactionStateValidationError(root: string, transaction: CtoSpecificationMappingStatefulTransaction): string | null {
  let rawSource: TeamState;
  let source: TeamState;
  try {
    const beforeParsed: unknown = JSON.parse(transaction.state_before_content);
    if (!beforeParsed || typeof beforeParsed !== "object" || Array.isArray(beforeParsed)) return "raw source state is not an object";
    rawSource = beforeParsed as TeamState;
    const sourceParsed: unknown = JSON.parse(transaction.state_source_content);
    if (!sourceParsed || typeof sourceParsed !== "object" || Array.isArray(sourceParsed)) return "semantic source state is not an object";
    source = sourceParsed as TeamState;
  } catch (error) {
    return `source state is unreadable: ${error instanceof Error ? error.message : String(error)}`;
  }
  if (sha256Hex(transaction.state_before_content) !== transaction.state_before_digest) return "source state raw digest is invalid";
  const sourceContentError = mappingStateSourceContentError(transaction, rawSource, source);
  if (sourceContentError) return sourceContentError;
  if (mappingStateDigest(source) !== transaction.state_source_logical_digest) return "source state logical digest is invalid";
  if (mappingStateDigest(transaction.state) !== transaction.state_after_digest) return "staged state logical digest is invalid";
  return mappingStateTransitionError(root, transaction, source, transaction.state, transaction.operation !== "confirm");
}

type MappingTransactionJsonBudget = { nodes: number };

function boundedMappingTransactionJson(value: unknown, depth: number, budget: MappingTransactionJsonBudget): boolean {
  if (++budget.nodes > MAX_MAPPING_TRANSACTION_JSON_NODES || depth > MAX_MAPPING_TRANSACTION_JSON_DEPTH) return false;
  if (value === null || typeof value === "boolean" || typeof value === "number") {
    return typeof value !== "number" || Number.isFinite(value);
  }
  if (typeof value === "string") return Buffer.byteLength(value, "utf8") <= MAX_MAPPING_TRANSACTION_TEXT_BYTES;
  if (Array.isArray(value)) {
    if (value.length > MAX_MAPPING_TRANSACTION_JSON_ARRAY) return false;
    return value.every((item) => boundedMappingTransactionJson(item, depth + 1, budget));
  }
  if (!value || typeof value !== "object" || Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) return false;
  const object = value as Record<string, unknown>;
  const keys = Object.keys(object);
  if (keys.length > MAX_MAPPING_TRANSACTION_JSON_KEYS) return false;
  return keys.every((key) => Buffer.byteLength(key, "utf8") <= MAX_MAPPING_TRANSACTION_TEXT_BYTES)
    && keys.every((key) => boundedMappingTransactionJson(object[key], depth + 1, budget));
}

function mappingTransactionEnvelopeError(value: unknown): string | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return "transaction is not an object";
  const object = value as Record<string, unknown>;
  const keys = Object.keys(object);
  if (keys.some((key) => !MAPPING_TRANSACTION_REQUIRED_KEYS.has(key) && !MAPPING_TRANSACTION_OPTIONAL_KEYS.has(key))) {
    return "transaction has unknown fields";
  }
  if ([...MAPPING_TRANSACTION_REQUIRED_KEYS].some((key) => !Object.hasOwn(object, key))) {
    return "transaction is missing required fields";
  }
  const budget: MappingTransactionJsonBudget = { nodes: 0 };
  if (!boundedMappingTransactionJson(value, 0, budget)) return "transaction exceeds JSON work/depth/text bounds";
  const selections = object.selections;
  if (!Array.isArray(selections) || selections.length === 0 || selections.length > MAX_MAPPING_TRANSACTIONS) {
    return `transaction selections exceed ${MAX_MAPPING_TRANSACTIONS} entries`;
  }
  return null;
}

function parseMappingTransaction(
  root: string,
  raw: string,
  path: string,
  ctoRunId: string,
  transactionId: string,
  wal_receipt: MappingTransactionWalReceipt,
): ParsedMappingTransaction {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`CTO_SPEC_MAPPING_TRANSACTION_INVALID: transaction at ${path} is unreadable: ${String(error)}`);
  }
  const envelopeError = mappingTransactionEnvelopeError(parsed);
  if (envelopeError) {
    throw new Error(`CTO_SPEC_MAPPING_TRANSACTION_INVALID: transaction at ${path} ${envelopeError}`);
  }
  const candidate = parsed as CtoSpecificationMappingTransactionCandidate;
  const status = candidate.status ?? "pending";
  const directWAL = candidate.operation === "preflight" || candidate.operation === "resume";
  const mappingBeforeDisposition = candidate.mapping_before_disposition ?? "present";
  const mappingBeforeContent = candidate.mapping_before_content === undefined ? null : candidate.mapping_before_content;
  const stagedMappingIdentity = candidate.staged_mapping_identity ?? { mapping_id: candidate.mapping_id, mapping_hash: candidate.mapping_hash, content_digest: candidate.mapping_after_digest };
  const stateTransition = candidate.state_transition as Partial<CtoSpecificationMappingStateTransition> | undefined;
  const confirmationWAL = candidate.operation === "confirm";
  if (
    candidate.schema_version !== 1
    || !["pending", "aborting", "aborted", "quarantined"].includes(String(status))
    || (candidate.operation !== undefined && !["confirm", "answer", "preflight", "resume"].includes(String(candidate.operation)))
    || !["present", "absent"].includes(String(mappingBeforeDisposition))
    || (mappingBeforeContent !== null && typeof mappingBeforeContent !== "string")
    || !stagedMappingIdentity || typeof stagedMappingIdentity !== "object" || Array.isArray(stagedMappingIdentity)
    || typeof stagedMappingIdentity.mapping_id !== "string" || typeof stagedMappingIdentity.mapping_hash !== "string" || typeof stagedMappingIdentity.content_digest !== "string"
    || candidate.transaction_id !== transactionId
    || candidate.cto_run_id !== ctoRunId
    || typeof candidate.mapping_id !== "string"
    || !isSafeCtoExecutionId(candidate.mapping_id)
    || typeof candidate.mapping_hash !== "string"
    || !/^[a-f0-9]{64}$/.test(candidate.mapping_hash)
    || typeof candidate.feature_id !== "string"
    || !isSafeFeatureId(candidate.feature_id)
    || typeof candidate.run_key !== "string"
    || candidate.run_key.trim().length === 0
    || typeof candidate.mapping_path !== "string"
    || typeof candidate.mapping_before_digest !== "string"
    || !/^[a-f0-9]{64}$/.test(candidate.mapping_before_digest)
    || typeof candidate.mapping_after_digest !== "string"
    || !/^[a-f0-9]{64}$/.test(candidate.mapping_after_digest)
    || typeof candidate.mapping_content !== "string"
    || !candidate.mapping
    || !Array.isArray(candidate.selections)
    || typeof candidate.state_path !== "string"
    || typeof candidate.artifacts_dir !== "string"
    || typeof candidate.state_dir !== "string"
    || typeof candidate.state_before_digest !== "string"
    || !/^[a-f0-9]{64}$/.test(candidate.state_before_digest)
    || typeof candidate.state_source_logical_digest !== "string"
    || !/^[a-f0-9]{64}$/.test(candidate.state_source_logical_digest)
    || typeof candidate.state_after_digest !== "string"
    || !/^[a-f0-9]{64}$/.test(candidate.state_after_digest)
    || (directWAL
      ? Object.hasOwn(candidate, "state_before_content") || Object.hasOwn(candidate, "state_source_content") || Object.hasOwn(candidate, "state")
      : typeof candidate.state_before_content !== "string"
        || typeof candidate.state_source_content !== "string"
        || !candidate.state
        || typeof candidate.state !== "object"
        || Array.isArray(candidate.state))
    || !stateTransition
    || !["record_checkpoint_answer", "consume_checkpoint_answer"].includes(String(stateTransition.kind))
    || typeof stateTransition.answer_id !== "string"
    || stateTransition.answer_id.trim().length === 0
    || typeof stateTransition.stage_id !== "string"
    || stateTransition.stage_id.trim().length === 0
    || typeof stateTransition.checkpoint_id !== "string"
    || stateTransition.checkpoint_id.trim().length === 0
    || typeof stateTransition.decision !== "string"
    || stateTransition.decision.trim().length === 0
    || typeof stateTransition.feature_id !== "string"
    || typeof stateTransition.run_key !== "string"
    || (stateTransition.decision === "request_changes"
      ? !validCtoFeedback(stateTransition.feedback)
      : stateTransition.feedback !== undefined)
    || (confirmationWAL && (typeof candidate.confirmation_proof_path !== "string"
      || typeof candidate.confirmation_proof_digest !== "string" || !/^[a-f0-9]{64}$/.test(candidate.confirmation_proof_digest)
      || typeof candidate.confirmation_proof_content !== "string"))
  ) {
    throw new Error(`CTO_SPEC_MAPPING_TRANSACTION_INVALID: transaction at ${path} is incomplete`);
  }
  const expectedMappingPath = mappingPath(root, ctoRunId, candidate.mapping_id);
  const expectedStatePath = featureStatePath(root, candidate.feature_id);
  if (
    !expectedMappingPath
    || candidate.mapping_path !== expectedMappingPath
    || candidate.mapping.mapping_id !== candidate.mapping_id
    || candidate.mapping.mapping_hash !== candidate.mapping_hash
    || sha256Hex(candidate.mapping_content) !== candidate.mapping_after_digest
    || stagedMappingIdentity.mapping_id !== candidate.mapping_id
    || stagedMappingIdentity.mapping_hash !== candidate.mapping_hash
    || stagedMappingIdentity.content_digest !== candidate.mapping_after_digest
    || (mappingBeforeDisposition === "present" && mappingBeforeContent !== null && sha256Hex(mappingBeforeContent) !== candidate.mapping_before_digest)
    || (mappingBeforeDisposition === "absent" && (mappingBeforeContent !== null || candidate.mapping_before_digest !== sha256Hex("")))
    || candidate.state_path !== expectedStatePath
    || (confirmationWAL && sha256Hex(candidate.confirmation_proof_content as string) !== candidate.confirmation_proof_digest)
  ) {
    throw new Error(`CTO_SPEC_MAPPING_TRANSACTION_INVALID: transaction at ${path} has inconsistent identity or content`);
  }
  if (!directWAL && sha256Hex(candidate.state_before_content as string) !== candidate.state_before_digest) {
    throw new Error(`CTO_SPEC_MAPPING_TRANSACTION_INVALID: transaction at ${path} has an invalid source state digest`);
  }
  const stagedMapping = candidate.mapping as CtoSpecificationMapping;
  let stagedRecord: Partial<CtoSpecificationMappingRecord>;
  try {
    const parsedRecord: unknown = JSON.parse(candidate.mapping_content as string);
    const mappingError = validateCtoMappingRecord(parsedRecord, ctoRunId, candidate.mapping_id);
    if (mappingError) throw new Error(mappingError);
    stagedRecord = parsedRecord as Partial<CtoSpecificationMappingRecord>;
    if (confirmationWAL) {
      const proofRef = stagedRecord.confirmation_proof_ref;
      const expectedProofPath = typeof proofRef === "string" ? ctoMappingConfirmationProofRelativePath(ctoRunId, candidate.mapping_id, proofRef) : null;
      if (typeof proofRef !== "string" || !expectedProofPath
        || candidate.confirmation_proof_path !== expectedProofPath
        || typeof candidate.confirmation_proof_content !== "string"
        || sha256Hex(candidate.confirmation_proof_content) !== candidate.confirmation_proof_digest) {
        throw new Error("confirmation WAL proof metadata is missing or inconsistent");
      }
    }
  } catch (error) {
    throw new Error(`CTO_SPEC_MAPPING_TRANSACTION_INVALID: transaction at ${path} has unreadable mapping content: ${String(error)}`);
  }
  const answerWAL = candidate.operation === "answer";
  const selections = candidate.selections as CtoSpecificationExecutionSelection[];
  const validSelections = candidate.selections.every((selection) =>
    selection && typeof selection.feature_id === "string" && isSafeFeatureId(selection.feature_id)
      && typeof selection.run_key === "string" && selection.run_key.trim().length > 0,
  );
  const stagedMap = stagedRecord.mapping as CtoSpecificationMapping | undefined;
  const answerTransition = stateTransition as CtoSpecificationMappingStateTransition;
  const answerDecision = answerTransition.decision;
  const isNonContinueAnswer = answerDecision === "request_changes" || answerDecision === "approve_stop";
  const stagedReview = stagedRecord.review as CtoSpecificationMappingReview | undefined;
  const answerMappingValid = answerWAL
    && (isNonContinueAnswer
      ? stagedMap?.status === (answerDecision === "request_changes" ? "revision_required" : "stopped")
        && stagedMap.checkpoint_ref === null
        && stagedRecord.checkpoint_ref === null
        && stagedRecord.trusted_answer_ref === null
        && stagedReview?.decision === answerDecision
        && stagedReview.feature_id === answerTransition.feature_id
        && stagedReview.run_key === answerTransition.run_key
        && stagedReview.stage_id === answerTransition.stage_id
        && stagedReview.checkpoint_ref === answerTransition.checkpoint_id
        && stagedReview.trusted_answer_ref === answerTransition.answer_id
        && stagedReview.capability_id === answerTransition.capability_id
        && stagedReview.capability_epoch === answerTransition.capability_epoch
        && stagedReview.policy_hash === answerTransition.policy_hash
        && stagedReview.feedback === answerTransition.feedback
      : stagedMap?.status === "awaiting_confirmation"
        && typeof stagedRecord.checkpoint_ref === "string"
        && stagedRecord.trusted_answer_ref === answerTransition.answer_id
        && stagedReview === undefined);
  if (directWAL) {
    if (!stagedMap
      || stagedMap.status !== "awaiting_confirmation"
      || stagedRecord.schema_version !== 1
      || stagedRecord.cto_run_id !== ctoRunId
      || !Array.isArray(stagedRecord.selections)
      || canonicalJson(stagedRecord.selections) !== canonicalJson(candidate.selections)
      || !sameFrozenMapping(stagedMapping, stagedMap)
      || stagedRecord.checkpoint_ref !== null
      || stagedRecord.trusted_answer_ref !== null) {
      throw new Error(`CTO_SPEC_MAPPING_TRANSACTION_INVALID: transaction at ${path} has inconsistent direct mapping publication`);
    }
  } else {
  if (
    !["approve_continue", "request_changes", "approve_stop"].includes(answerDecision)
    || !mappingHashMatches(stagedMapping)
    || !Number.isSafeInteger(stagedMapping.mapping_version) || stagedMapping.mapping_version < 1
    || !Array.isArray(stagedMapping.feature_ids)
    || stagedMapping.feature_ids.length !== selections.length
    || stagedMapping.feature_ids.some((featureId, index) => featureId !== selections[index]?.feature_id)
    || !validSelections
    || !candidate.selections.some((selection) => selection.feature_id === candidate.feature_id && selection.run_key === candidate.run_key)
    || stagedRecord.schema_version !== 1
    || stagedRecord.cto_run_id !== ctoRunId
    || !stagedMap
    || stagedMap.mapping_id !== candidate.mapping_id
    || stagedMap.mapping_hash !== candidate.mapping_hash
    || !mappingHashMatches(stagedMap)
    || !Array.isArray(stagedRecord.selections)
    || canonicalJson(stagedRecord.selections) !== canonicalJson(candidate.selections)
    || !sameFrozenMapping(stagedMapping, stagedMap)
    || (answerWAL ? !answerMappingValid : (
      stagedMap.status !== "confirmed"
      || stagedRecord.checkpoint_ref !== stagedMap.checkpoint_ref
      || typeof stagedRecord.checkpoint_ref !== "string"
      || stagedRecord.trusted_answer_ref !== answerTransition.answer_id
      || typeof stagedRecord.confirmation_proof_ref !== "string"
      || !confirmationWAL
    ))
  ) {
    throw new Error(`CTO_SPEC_MAPPING_TRANSACTION_INVALID: transaction at ${path} has inconsistent mapping transition`);
  }
  }
  const statePath = canonicalPathWithoutSymlinks(root, candidate.state_path, true);
  const stateDir = canonicalPathWithoutSymlinks(root, candidate.state_dir);
  const artifactsDir = canonicalPathWithoutSymlinks(root, candidate.artifacts_dir);
  if (!statePath || !stateDir || !artifactsDir) {
    throw new Error(`CTO_SPEC_MAPPING_TRANSACTION_INVALID: transaction at ${path} has unsafe state targets`);
  }
  try {
    if (!lstatSync(stateDir).isDirectory() || !lstatSync(artifactsDir).isDirectory()) {
      throw new Error("state target directories are not directories");
    }
  } catch (error) {
    throw new Error(`CTO_SPEC_MAPPING_TRANSACTION_INVALID: transaction at ${path} has invalid state targets: ${String(error)}`);
  }
  const isLegacy = candidate.is_legacy;
  if (typeof isLegacy !== "boolean") {
    throw new Error(`CTO_SPEC_MAPPING_TRANSACTION_INVALID: transaction at ${path} has an invalid legacy-state marker`);
  }
  if ((status === "aborting" || status === "aborted" || status === "quarantined")
    && (typeof candidate.abort_reason !== "string" || candidate.abort_reason.trim().length === 0)) {
    throw new Error(`CTO_SPEC_MAPPING_TRANSACTION_INVALID: transaction at ${path} is missing its abort reason`);
  }
  if ((status === "aborting" || status === "aborted" || status === "quarantined")
    && (typeof candidate.abort_started_at !== "string" || candidate.abort_started_at.trim().length === 0)) {
    throw new Error(`CTO_SPEC_MAPPING_TRANSACTION_INVALID: transaction at ${path} is missing its abort start timestamp`);
  }
  if (!directWAL) {
  let rawSourceState: TeamState;
  let sourceState: TeamState;
  try {
    const beforeParsed: unknown = JSON.parse(candidate.state_before_content as string);
    if (!beforeParsed || typeof beforeParsed !== "object" || Array.isArray(beforeParsed)) throw new Error("raw source state is not an object");
    rawSourceState = beforeParsed as TeamState;
    const sourceParsed: unknown = JSON.parse(candidate.state_source_content as string);
    if (!sourceParsed || typeof sourceParsed !== "object" || Array.isArray(sourceParsed)) throw new Error("semantic source state is not an object");
    sourceState = sourceParsed as TeamState;
  } catch (error) {
    throw new Error(`CTO_SPEC_MAPPING_TRANSACTION_INVALID: transaction at ${path} has unreadable source state: ${String(error)}`);
  }
  const transactionIdentity = {
    feature_id: candidate.feature_id as string,
    run_key: candidate.run_key as string,
    state_path: statePath,
  };
  if (
    sha256Hex(candidate.state_before_content as string) !== candidate.state_before_digest
    || mappingStateSourceContentError(
      { state_transition: stateTransition as CtoSpecificationMappingStateTransition },
      rawSourceState,
      sourceState,
    )
    || mappingStateDigest(sourceState) !== candidate.state_source_logical_digest
    || mappingStateDigest(candidate.state) !== candidate.state_after_digest
    || !mappingStateIdentityMatches(root, transactionIdentity, sourceState)
    || !mappingStateIdentityMatches(root, transactionIdentity, candidate.state as TeamState)
  ) {
    throw new Error(`CTO_SPEC_MAPPING_TRANSACTION_INVALID: transaction at ${path} has inconsistent source or staged state`);
  }
  const transitionError = mappingStateTransitionError(
    root,
    {
      operation: candidate.operation,
      feature_id: candidate.feature_id as string,
      run_key: candidate.run_key as string,
      state_path: statePath,
      state_transition: stateTransition as CtoSpecificationMappingStateTransition,
    },
    sourceState,
    candidate.state as TeamState,
  );
  if (transitionError) {
    throw new Error(`CTO_SPEC_MAPPING_TRANSACTION_INVALID: transaction at ${path} has an invalid state transition: ${transitionError}`);
  }
  }
  if ((status === "aborted" || status === "quarantined")
    && (candidate.terminal_disposition !== status || typeof candidate.terminal_at !== "string" || candidate.terminal_at.trim().length === 0)) {
    throw new Error(`CTO_SPEC_MAPPING_TRANSACTION_INVALID: transaction at ${path} is missing terminal abort metadata`);
  }
  return {
    ...(candidate.operation === "preflight" || candidate.operation === "resume" ? { operation: candidate.operation as "preflight" | "resume" } : candidate.operation === "confirm" || candidate.operation === "answer" ? { operation: candidate.operation } : {}),
    schema_version: 1,
    transaction_id: transactionId,
    cto_run_id: ctoRunId,
    mapping_id: candidate.mapping_id,
    mapping_hash: candidate.mapping_hash,
    feature_id: candidate.feature_id,
    run_key: candidate.run_key,
    mapping_path: candidate.mapping_path,
    mapping_before_digest: candidate.mapping_before_digest,
    mapping_after_digest: candidate.mapping_after_digest,
    mapping_content: candidate.mapping_content,
    mapping: candidate.mapping,
    selections: candidate.selections.map((selection) => ({ ...selection })),
    state_path: statePath,
    state_dir: stateDir,
    artifacts_dir: artifactsDir,
    is_legacy: isLegacy,
    state_before_digest: candidate.state_before_digest,
    state_source_logical_digest: candidate.state_source_logical_digest,
    state_after_digest: candidate.state_after_digest,
    state_transition: stateTransition as CtoSpecificationMappingStateTransition,
    ...(typeof candidate.confirmation_proof_path === "string" ? { confirmation_proof_path: candidate.confirmation_proof_path } : {}),
    ...(typeof candidate.confirmation_proof_digest === "string" ? { confirmation_proof_digest: candidate.confirmation_proof_digest } : {}),
    ...(typeof candidate.confirmation_proof_content === "string" ? { confirmation_proof_content: candidate.confirmation_proof_content } : {}),
    ...(directWAL ? {} : {
      state_before_content: candidate.state_before_content as string,
      state_source_content: candidate.state_source_content as string,
      state: candidate.state as TeamState,
    }),
    status,
    mapping_before_disposition: mappingBeforeDisposition as "present" | "absent",
    mapping_before_content: mappingBeforeContent,
    staged_mapping_identity: { mapping_id: stagedMappingIdentity.mapping_id, mapping_hash: stagedMappingIdentity.mapping_hash, content_digest: stagedMappingIdentity.content_digest },
    ...(typeof candidate.abort_reason === "string" ? { abort_reason: candidate.abort_reason } : {}),
    ...(typeof candidate.abort_started_at === "string" ? { abort_started_at: candidate.abort_started_at } : {}),
    ...(typeof candidate.terminal_at === "string" ? { terminal_at: candidate.terminal_at } : {}),
    ...(candidate.terminal_disposition === "aborted" || candidate.terminal_disposition === "quarantined" ? { terminal_disposition: candidate.terminal_disposition } : {}),
    ...(candidate.abort_observed_mapping_digest === null || typeof candidate.abort_observed_mapping_digest === "string" ? { abort_observed_mapping_digest: candidate.abort_observed_mapping_digest } : {}),
    wal_receipt,
  } as ParsedMappingTransaction;
}



function quarantineInvalidMappingTransactionPinned(
  root: string,
  ctoRunId: string,
  transactionId: string,
  raw: string,
  sourceRead: { bytes: Buffer; dev: number; ino: number },
  pinnedRoot: PinnedProjectRoot,
  reason: string,
): boolean {
  let parsed: Record<string, unknown>;
  try {
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== "object" || Array.isArray(value)) return false;
    parsed = value as Record<string, unknown>;
  } catch {
    return false;
  }
  if (parsed.operation === "answer") {
    const answerMappingId = typeof parsed.mapping_id === "string" && isSafeCtoExecutionId(parsed.mapping_id) ? parsed.mapping_id : "unknown";
    quarantineMappingTransactionDescriptorPinned(root, ctoRunId, transactionId, answerMappingId, mappingTransactionWalReceipt(sourceRead.bytes, sourceRead.dev, sourceRead.ino), pinnedRoot, "-answer-invalid");
    throw new Error("CTO_SPEC_MAPPING_ANSWER_RECOVERY_REQUIRED: quarantined malformed answer WAL '" + transactionId + "'; obtain a fresh trusted terminal Ask before continuing");
  }
  const mappingId = parsed.mapping_id;
  const beforeDisposition = parsed.mapping_before_disposition;
  const beforeDigest = parsed.mapping_before_digest;
  if (typeof mappingId !== "string" || !isSafeCtoExecutionId(mappingId)
    || (beforeDisposition !== "present" && beforeDisposition !== "absent")
    || typeof beforeDigest !== "string" || !/^[a-f0-9]{64}$/.test(beforeDigest)) return false;
  const path = mappingPath(root, ctoRunId, mappingId, pinnedRoot);
  if (!path) return false;
  const identity = currentMappingIdentityPinned(pinnedRoot, root, path, ctoRunId, mappingId);
  const prior = beforeDisposition === "absent"
    ? identity.disposition === "absent"
    : identity.disposition === "present" && identity.digest === beforeDigest;
  // If the staged mapping is already authoritative, retaining the WAL is
  // safer than removing its only recovery record.
  if (!prior) return false;
  const quarantineDirectory = join(root, ".work-state", "cto", ctoRunId, "specification-mapping-quarantine");
  pinnedRoot.ensureDirectory(pinnedRelativePath(pinnedRoot, quarantineDirectory));
  const quarantinePath = join(quarantineDirectory, `${transactionId}-${mappingId}-invalid.json`);
  const quarantineContent = `${JSON.stringify({
    schema_version: 1,
    transaction_id: transactionId,
    cto_run_id: ctoRunId,
    status: "quarantined",
    terminal_disposition: "quarantined",
    terminal_at: new Date().toISOString(),
    abort_reason: `invalid mapping transaction: ${reason}`,
    raw_transaction: parsed,
  }, null, 2)}\r\n`;
  const relativeDestination = pinnedRelativePath(pinnedRoot, quarantinePath);
  if (pinnedRoot.pathEntryExists(relativeDestination)) {
    const existing = pinnedRoot.readFile(relativeDestination);
    if (sha256Hex(Buffer.from(existing.bytes).toString("utf8")) !== sha256Hex(quarantineContent)) {
      throw new Error("CTO_SPEC_MAPPING_QUARANTINE_CONFLICT: invalid WAL quarantine target already exists");
    }
  } else {
    pinnedRoot.writeExclusive(relativeDestination, quarantineContent);
  }
  pinnedRoot.removeFileIfMatches(pinnedRelativePath(pinnedRoot, join(root, ".work-state", "cto", ctoRunId, "specification-mapping-transactions", `${transactionId}.json`)), {
    dev: sourceRead.dev,
    ino: sourceRead.ino,
    sha256: sha256Hex(raw),
  });
  return true;
}
function readPinnedMappingTransactions(root: string, ctoRunId: string, pinnedRoot: PinnedProjectRoot): ParsedMappingTransaction[] {
  const directory = join(root, ".work-state", "cto", ctoRunId, "specification-mapping-transactions");
  const relativeDirectory = pinnedRelativePath(pinnedRoot, directory);
  let entries: string[];
  try {
    entries = pinnedRoot.listDirectory(relativeDirectory, {
      maxEntries: MAX_MAPPING_TRANSACTIONS,
      maxNameBytes: 256,
    });
  } catch (error) {
    if (error instanceof PinnedRootError && error.code === "not_found") return [];
    throw new Error(`CTO_SPEC_MAPPING_TRANSACTION_INVALID: cannot enumerate pending transactions: ${String(error)}`);
  }
  const jsonEntries = entries.filter((name) => name.endsWith(".json")).sort((left, right) => left.localeCompare(right));
  if (jsonEntries.length > MAX_MAPPING_TRANSACTIONS) {
    throw new Error(`CTO_SPEC_MAPPING_TRANSACTION_INVALID: transaction count exceeds ${MAX_MAPPING_TRANSACTIONS}`);
  }
  let aggregateBytes = 0;
  const transactions: ParsedMappingTransaction[] = [];
  for (const name of jsonEntries) {
    const transactionId = name.slice(0, -".json".length);
    if (!/^[A-Za-z0-9._-]+$/.test(transactionId)) throw new Error("CTO_SPEC_MAPPING_TRANSACTION_INVALID: unsafe pending transaction name");
    const path = join(directory, name);
    const read = readPinnedRegularFile(pinnedRoot, path, MAX_MAPPING_TRANSACTION_FILE_BYTES);
    if (!read.ok) throw new Error(`CTO_SPEC_MAPPING_TRANSACTION_INVALID: pending transaction ${name} cannot be read: ${read.error}`);
    aggregateBytes += read.bytes.byteLength;
    if (aggregateBytes > MAX_MAPPING_TRANSACTION_AGGREGATE_BYTES) {
      throw new Error(`CTO_SPEC_MAPPING_TRANSACTION_INVALID: transaction aggregate exceeds ${MAX_MAPPING_TRANSACTION_AGGREGATE_BYTES} bytes`);
    }
    let raw: string;
    try {
      raw = new TextDecoder("utf-8", { fatal: true }).decode(read.bytes);
    } catch (error) {
      const reason = `transaction at ${path} is not valid UTF-8: ${String(error)}`;
      if (quarantineInvalidMappingTransactionPinned(root, ctoRunId, transactionId, "", read, pinnedRoot, reason)) continue;
      throw new Error(`CTO_SPEC_MAPPING_TRANSACTION_INVALID: ${reason}`);
    }
    try {
      const transaction = parseMappingTransaction(root, raw, path, ctoRunId, transactionId, mappingTransactionWalReceipt(read.bytes, read.dev, read.ino));
      transactions.push(transaction);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      if (quarantineInvalidMappingTransactionPinned(root, ctoRunId, transactionId, raw, read, pinnedRoot, reason)) continue;
      throw error;
    }
  }
  return transactions;
}

function readPendingMappingTransactionsPinned(root: string, ctoRunId: string, pinnedRoot: PinnedProjectRoot): ParsedMappingTransaction[] {
  return readPinnedMappingTransactions(root, ctoRunId, pinnedRoot).filter((transaction) => transaction.status === "pending" || transaction.status === "aborting");
}

function terminalMappingErrorPinned(pinnedRoot: PinnedProjectRoot, root: string, ctoRunId: string, mappingId: string, digest: string): string | null {
  const terminal = readPinnedMappingTransactions(root, ctoRunId, pinnedRoot).find((transaction) =>
    transaction.mapping_id === mappingId
    && (transaction.status === "aborted" || transaction.status === "quarantined")
    && transaction.mapping_path === mappingPath(root, ctoRunId, mappingId, pinnedRoot)
    && transaction.staged_mapping_identity.content_digest === digest,
  );
  return terminal ? `mapping is ${terminal.status}; staged mapping is not dispatchable` : null;
}




function fsyncMappingDirectory(path: string): void {
  const fd = openSync(path, constants.O_RDONLY | (constants.O_DIRECTORY ?? 0) | (constants.O_NOFOLLOW ?? 0));
  try {
    try {
      fsyncSync(fd);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException)?.code;
      if (code !== "EINVAL" && code !== "ENOTSUP") throw error;
    }
  } finally {
    closeSync(fd);
  }
}

type CurrentMappingIdentity =
  | { disposition: "absent"; digest: string }
  | { disposition: "present"; digest: string; mapping_id: string; mapping_hash: string; dev: number; ino: number }
  | { disposition: "unavailable"; digest: string | null; error: string };

type PinnedFileExpectation = { dev: number; ino: number; sha256: string };

function mappingIdentityExpectation(identity: CurrentMappingIdentity): PinnedFileExpectation | null {
  return identity.disposition === "present"
    ? { dev: identity.dev, ino: identity.ino, sha256: identity.digest }
    : null;
}

function isExactStagedMapping(identity: CurrentMappingIdentity, transaction: CtoSpecificationMappingTransaction): boolean {
  return identity.disposition === "present"
    && identity.digest === transaction.staged_mapping_identity.content_digest
    && identity.mapping_id === transaction.staged_mapping_identity.mapping_id
    && identity.mapping_hash === transaction.staged_mapping_identity.mapping_hash;
}

function isExactPriorMapping(identity: CurrentMappingIdentity, transaction: CtoSpecificationMappingTransaction): boolean {
  if (transaction.mapping_before_disposition === "absent") return identity.disposition === "absent";
  return identity.disposition === "present" && identity.digest === transaction.mapping_before_digest;
}

function currentMappingIdentityPinned(
  pinnedRoot: PinnedProjectRoot,
  _root: string,
  path: string,
  ctoRunId: string,
  mappingId: string,
): CurrentMappingIdentity {
  const relativePath = pinnedRoot.relativePath(path);
  if (!relativePath) return { disposition: "unavailable", digest: null, error: "canonical mapping path is outside the pinned project root" };
  try {
    if (!pinnedRoot.pathEntryExists(relativePath)) return { disposition: "absent", digest: sha256Hex("") };
  } catch (error) {
    return { disposition: "unavailable", digest: null, error: error instanceof Error ? error.message : String(error) };
  }
  const loaded = readPinnedCtoMappingRecord(pinnedRoot, relativePath, ctoRunId, mappingId);
  if (!loaded.ok) return { disposition: "unavailable", digest: null, error: loaded.error };
  const mapping = loaded.value.record.mapping;
  if (!mapping || typeof mapping !== "object" || Array.isArray(mapping)) {
    return { disposition: "unavailable", digest: loaded.value.digest, error: "canonical mapping identity is malformed" };
  }
  const mappingObject = mapping as Record<string, unknown>;
  if (typeof mappingObject.mapping_id !== "string" || typeof mappingObject.mapping_hash !== "string") {
    return { disposition: "unavailable", digest: loaded.value.digest, error: "canonical mapping identity is malformed" };
  }
  return {
    disposition: "present",
    digest: loaded.value.digest,
    mapping_id: mappingObject.mapping_id,
    mapping_hash: mappingObject.mapping_hash,
    dev: loaded.value.dev,
    ino: loaded.value.ino,
  };
}

function persistMappingTransactionPinned(
  pinnedRoot: PinnedProjectRoot,
  root: string,
  transaction: MappingTransactionWithOptionalWalReceipt,
  expectedReceipt?: MappingTransactionWalReceipt,
): MappingTransactionWalReceipt {
  const path = mappingTransactionPath(transaction, pinnedRoot);
  const relativePath = pinnedRelativePath(pinnedRoot, path);
  // wal_receipt is an in-memory anchor and must never become an on-disk field.
  const { wal_receipt: _walReceipt, ...persistedTransaction } = transaction;
  const content = `${JSON.stringify(persistedTransaction, null, 2)}\r\n`;
  const contentBytes = Buffer.byteLength(content, "utf8");
  if (contentBytes > MAX_MAPPING_TRANSACTION_FILE_BYTES) {
    throw new Error(`CTO_SPEC_MAPPING_TRANSACTION_INVALID: transaction WAL exceeds ${MAX_MAPPING_TRANSACTION_FILE_BYTES} bytes (${contentBytes})`);
  }
  if (expectedReceipt) {
    const current = pinnedRoot.readFile(relativePath);
    const currentReceipt = mappingTransactionWalReceipt(Buffer.from(current.bytes), current.dev, current.ino);
    if (currentReceipt.dev !== expectedReceipt.dev || currentReceipt.ino !== expectedReceipt.ino || currentReceipt.sha256 !== expectedReceipt.sha256) {
      throw new Error("CTO_SPEC_MAPPING_RECOVERY_REQUIRED: WAL descriptor changed before replacement; no descriptor was overwritten");
    }
    pinnedRoot.replaceFileIfMatches(relativePath, {
      dev: expectedReceipt.dev,
      ino: expectedReceipt.ino,
      sha256: expectedReceipt.sha256,
    }, content);
  } else {
    // A transaction WAL is created exactly once. Try the exclusive publish first
    // so the normal path needs one helper startup; a concurrent creator wins
    // with EEXIST and replay then compares/replaces its durable record.
    try {
      pinnedRoot.writeExclusive(relativePath, content);
    } catch (error) {
      if (!(error instanceof PinnedRootError && error.code === "exists")) throw error;
      const current = pinnedRoot.readFile(relativePath);
      const currentBytes = Buffer.from(current.bytes);
      const currentDigest = createHash("sha256").update(currentBytes).digest("hex");
      const contentDigest = createHash("sha256").update(content, "utf8").digest("hex");
      if (currentDigest !== contentDigest) {
        throw new Error("CTO_SPEC_MAPPING_TRANSACTION_CONFLICT: incumbent WAL differs; recovery is required");
      }
      return mappingTransactionWalReceipt(currentBytes, current.dev, current.ino);
    }
  }
  const published = pinnedRoot.readFile(relativePath);
  return mappingTransactionWalReceipt(Buffer.from(published.bytes), published.dev, published.ino);
}

function removeMappingTransactionPinned(
  pinnedRoot: PinnedProjectRoot,
  path: string,
  receipt: MappingTransactionWalReceipt,
): void {
  const relativePath = pinnedRelativePath(pinnedRoot, path);
  try {
    const current = pinnedRoot.readFile(relativePath);
    const raw = Buffer.from(current.bytes);
    const currentReceipt = mappingTransactionWalReceipt(raw, current.dev, current.ino);
    if (currentReceipt.dev !== receipt.dev || currentReceipt.ino !== receipt.ino || currentReceipt.sha256 !== receipt.sha256) {
      throw new Error("CTO_SPEC_MAPPING_RECOVERY_REQUIRED: WAL descriptor changed before deletion; no descriptor was removed");
    }
    pinnedRoot.removeFileIfMatches(relativePath, {
      dev: receipt.dev,
      ino: receipt.ino,
      sha256: receipt.sha256,
    });
  } catch (error) {
    if (!(error instanceof PinnedRootError && error.code === "not_found")) throw error;
  }
}

function quarantineMappingPinned(pinnedRoot: PinnedProjectRoot, root: string, transaction: MappingTransactionWithWalReceipt): void {
  assertMappingTransactionWalReceiptPinned(transaction, transaction.wal_receipt, pinnedRoot);
  const identity = currentMappingIdentityPinned(pinnedRoot, root, transaction.mapping_path, transaction.cto_run_id, transaction.mapping_id);
  if (!isExactStagedMapping(identity, transaction)) return;
  const expected = mappingIdentityExpectation(identity);
  if (!expected) return;
  const quarantineDirectory = join(root, ".work-state", "cto", transaction.cto_run_id, "specification-mapping-quarantine");
  pinnedRoot.ensureDirectory(pinnedRelativePath(pinnedRoot, quarantineDirectory));
  const quarantinePath = join(quarantineDirectory, `${transaction.transaction_id}-${transaction.mapping_id}.json`);
  const relativeSource = pinnedRelativePath(pinnedRoot, transaction.mapping_path);
  const relativeDestination = pinnedRelativePath(pinnedRoot, quarantinePath);
  if (!pinnedRoot.pathEntryExists(relativeDestination)) {
    // Quarantine is a write-once audit record. Never rename an observed path
    // after a split read: the source is removed only by the exact CAS below.
    pinnedRoot.writeExclusive(relativeDestination, transaction.mapping_content);
  } else {
    const existing = pinnedRoot.readFile(relativeDestination);
    if (sha256Hex(Buffer.from(existing.bytes).toString("utf8")) !== transaction.staged_mapping_identity.content_digest) {
      throw new Error("CTO_SPEC_MAPPING_QUARANTINE_CONFLICT: quarantine target already exists");
    }
  }
  try {
    assertMappingTransactionWalReceiptPinned(transaction, transaction.wal_receipt, pinnedRoot);
    pinnedRoot.removeFileIfMatches(relativeSource, expected);
  } catch (error) {
    if (!(error instanceof PinnedRootError && error.code === "not_found")) throw error;
  }
}

function abortMappingTransactionPinned(
  root: string,
  transaction: MappingTransactionWithWalReceipt,
  reason: string,
  pinnedRoot: PinnedProjectRoot,
): MappingTransactionWithWalReceipt {
  injectMappingFailure(root, pinnedRoot, "before_abort", transaction.transaction_id);
  let aborting = transaction;
  let walReceipt = transaction.wal_receipt;
  if (transaction.status === "pending") {
    aborting = {
      ...transaction,
      abort_reason: reason,
      abort_started_at: new Date().toISOString(),
    };
    injectMappingFailure(root, pinnedRoot, "before_abort_prepare", transaction.transaction_id);
    walReceipt = persistMappingTransactionPinned(pinnedRoot, root, aborting, walReceipt);
    aborting = { ...aborting, wal_receipt: walReceipt };
    injectMappingFailure(root, pinnedRoot, "after_abort_prepare", transaction.transaction_id);
  } else if (transaction.status !== "aborting") {
    return transaction;
  }
  assertMappingTransactionWalReceiptPinned(aborting, walReceipt, pinnedRoot);
  const identity = currentMappingIdentityPinned(pinnedRoot, root, aborting.mapping_path, aborting.cto_run_id, aborting.mapping_id);
  let disposition: "aborted" | "quarantined" = "aborted";
  let cleanupProof = false;
  if (aborting.operation === "confirm" && aborting.confirmation_proof_path && aborting.confirmation_proof_content) {
    const proofError = mappingConfirmationTransactionProofError(aborting, pinnedRoot);
    const state = readPinnedFeatureState(root, aborting.feature_id, aborting.run_key, pinnedRoot);
    const stateCommitted = state.ok ? mappingStateDigest(state.value.state) === aborting.state_after_digest : true;
    cleanupProof = !proofError && !stateCommitted && (isExactPriorMapping(identity, aborting) || isExactStagedMapping(identity, aborting));
  }
  if (cleanupProof && aborting.confirmation_proof_content) {
    try {
      const proofRecord = JSON.parse(aborting.confirmation_proof_content) as Pick<CtoMappingConfirmationProof, "cto_run_id" | "mapping_id" | "proof_ref">;
      if (proofRecord.cto_run_id === aborting.cto_run_id && proofRecord.mapping_id === aborting.mapping_id) {
        removeCtoMappingConfirmationProof(pinnedRoot, proofRecord, aborting.confirmation_proof_content);
      }
    } catch { /* malformed proof remains inert and is never overwritten */ }
  }
  if (isExactStagedMapping(identity, aborting)) {
    const expected = mappingIdentityExpectation(identity);
    if (!expected) throw new Error("CTO_SPEC_MAPPING_CONFLICT: staged mapping identity is unavailable");
    if (aborting.mapping_before_disposition === "present" && aborting.mapping_before_content !== null) {
      injectMappingFailure(root, pinnedRoot, "before_abort_mapping_write", aborting.transaction_id);
      assertMappingTransactionWalReceiptPinned(aborting, walReceipt, pinnedRoot);
      pinnedRoot.replaceFileIfMatches(pinnedRelativePath(pinnedRoot, aborting.mapping_path), expected, aborting.mapping_before_content);
      injectMappingFailure(root, pinnedRoot, "after_abort_mapping_write", aborting.transaction_id);
    } else if (aborting.mapping_before_disposition === "absent") {
      injectMappingFailure(root, pinnedRoot, "before_abort_mapping_remove", aborting.transaction_id);
      assertMappingTransactionWalReceiptPinned(aborting, walReceipt, pinnedRoot);
      pinnedRoot.removeFileIfMatches(pinnedRelativePath(pinnedRoot, aborting.mapping_path), expected);
      injectMappingFailure(root, pinnedRoot, "after_abort_mapping_remove", aborting.transaction_id);
    } else {
      disposition = "quarantined";
      injectMappingFailure(root, pinnedRoot, "before_abort_quarantine", aborting.transaction_id);
      quarantineMappingPinned(pinnedRoot, root, aborting);
      injectMappingFailure(root, pinnedRoot, "after_abort_quarantine", aborting.transaction_id);
    }
  } else if (isExactPriorMapping(identity, aborting)) {
    // A crash after the compensating mutation but before the terminal WAL is
    // harmless: the prior bytes are already authoritative.
    disposition = "aborted";
  } else if (identity.disposition === "absent" && aborting.mapping_before_disposition === "absent") {
    disposition = "aborted";
  } else {
    // A different mapping is authoritative. Never overwrite or remove it;
    // retain the transaction as a quarantined audit record.
    disposition = "quarantined";
  }

  injectMappingFailure(root, pinnedRoot, "before_abort_terminal", aborting.transaction_id);
  const terminal: MappingTransactionWithWalReceipt = {
    ...aborting,
    status: disposition,
    terminal_disposition: disposition,
    terminal_at: new Date().toISOString(),
    abort_observed_mapping_digest: identity.digest,
  };
  const terminalReceipt = persistMappingTransactionPinned(pinnedRoot, root, terminal, walReceipt);
  const publishedTerminal = { ...terminal, wal_receipt: terminalReceipt };
  injectMappingFailure(root, pinnedRoot, "after_abort_terminal", aborting.transaction_id);
  injectMappingFailure(root, pinnedRoot, "after_abort", aborting.transaction_id);
  return publishedTerminal;
}

function refreshCtoMappingTransactionConstitutions(
  root: string,
  transaction: CtoSpecificationMappingTransaction,
  pinnedRoot: PinnedProjectRoot,
): string | null {
  for (const selection of transaction.selections) {
    const binding = transaction.mapping.handoff_bindings.find((candidate) => candidate.feature_id === selection.feature_id);
    if (!binding) return `mapping transaction lacks a frozen handoff binding for '${selection.feature_id}'`;
    const loaded = loadHandoff(root, selection, binding.handoff_digest, pinnedRoot);
    if (!loaded.ok) return loaded.error;
  }
  return null;
}

function refreshCtoMappingConstitutions(
  root: string,
  record: Pick<CtoSpecificationMappingRecord, "mapping" | "selections">,
  pinnedRoot: PinnedProjectRoot,
): string | null {
  for (const selection of record.selections) {
    const binding = record.mapping.handoff_bindings.find((candidate) => candidate.feature_id === selection.feature_id);
    if (!binding) return `mapping lacks a frozen handoff binding for '${selection.feature_id}'`;
    const loaded = loadHandoff(root, selection, binding.handoff_digest, pinnedRoot);
    if (!loaded.ok) return loaded.error;
  }
  return null;
}

function commitDirectMappingTransactionPinned(root: string, transaction: MappingTransactionWithWalReceipt, pinnedRoot: PinnedProjectRoot): void {
  assertMappingTransactionWalReceiptPinned(transaction, transaction.wal_receipt, pinnedRoot);
  const current = currentMappingIdentityPinned(pinnedRoot, root, transaction.mapping_path, transaction.cto_run_id, transaction.mapping_id);
  if (current.disposition === "unavailable") {
    throw new Error(`CTO_SPEC_MAPPING_CONFLICT: ${current.error}`);
  }
  if (isExactPriorMapping(current, transaction)) {
    removeMappingTransactionPinned(pinnedRoot, mappingTransactionPath(transaction, pinnedRoot), transaction.wal_receipt);
    return;
  }
  if (!isExactStagedMapping(current, transaction)) {
    throw new Error("CTO_SPEC_MAPPING_CONFLICT: direct mapping publication differs from both its registered preimage and postimage");
  }
  const mapped = readMappingRecord(root, transaction.cto_run_id, transaction.mapping_id, pinnedRoot);
  if (!mapped.ok || mapped.value.mapping.mapping_hash !== transaction.mapping_hash || mapped.value.mapping.status !== "awaiting_confirmation") {
    throw new Error("CTO_SPEC_MAPPING_CONFLICT: direct mapping postimage is not the registered awaiting-confirmation authority");
  }
  const constitutionError = refreshCtoMappingTransactionConstitutions(root, transaction, pinnedRoot);
  if (!constitutionError) {
    removeMappingTransactionPinned(pinnedRoot, mappingTransactionPath(transaction, pinnedRoot), transaction.wal_receipt);
    return;
  }
  // The postimage was visible but could not be adopted because one of the
  // frozen constitution bindings changed. Restore only that exact postimage;
  // never clobber a concurrent replacement.
  const expected = mappingIdentityExpectation(current);
  if (!expected) throw new Error("CTO_SPEC_MAPPING_CONFLICT: direct mapping postimage identity is unavailable");
  const relativePath = pinnedRelativePath(pinnedRoot, transaction.mapping_path);
  assertMappingTransactionWalReceiptPinned(transaction, transaction.wal_receipt, pinnedRoot);
  if (transaction.mapping_before_disposition === "absent") {
    pinnedRoot.removeFileIfMatches(relativePath, expected);
  } else if (transaction.mapping_before_content !== null) {
    pinnedRoot.replaceFileIfMatches(relativePath, expected, transaction.mapping_before_content);
  } else {
    throw new Error("CTO_SPEC_MAPPING_CONFLICT: direct mapping preimage is unavailable for restoration");
  }
  removeMappingTransactionPinned(pinnedRoot, mappingTransactionPath(transaction, pinnedRoot), transaction.wal_receipt);
  throw new Error(`CTO_SPEC_MAPPING_CONSTITUTION_CONFLICT: ${constitutionError}`);
}

function mappingConfirmationTransactionProofError(
  transaction: CtoSpecificationMappingTransaction,
  pinnedRoot: PinnedProjectRoot,
): string | null {
  if (transaction.operation !== "confirm") return null;
  if (!transaction.confirmation_proof_path || !transaction.confirmation_proof_digest || !transaction.confirmation_proof_content || !transaction.state) return "confirmation WAL has no durable proof metadata";
  let record: CtoSpecificationMappingRecord;
  try { record = JSON.parse(transaction.mapping_content) as CtoSpecificationMappingRecord; }
  catch { return "confirmation WAL final mapping record is unreadable"; }
  const proofRef = record.confirmation_proof_ref;
  const transition = transaction.state_transition;
  const consumedAnswer = transaction.state.trusted_checkpoint_answers?.find((candidate) => candidate.answer_id === transition.answer_id);
  if (typeof proofRef !== "string" || !record.confirmation_context || typeof record.confirmed_at !== "string" || typeof record.confirmation_state_after_digest !== "string"
    || !consumedAnswer?.consumed_at || typeof consumedAnswer.subject_binding !== "string" || typeof consumedAnswer.subject_revision !== "number" || typeof consumedAnswer.authority_receipt !== "string") {
    return "confirmation WAL final proof context is incomplete";
  }
  const proofAnswer = { ...consumedAnswer, subject_binding: consumedAnswer.subject_binding, subject_revision: consumedAnswer.subject_revision, authority_receipt: consumedAnswer.authority_receipt, consumed_at: consumedAnswer.consumed_at } as CtoMappingConfirmationProofAnswer;
  const crossFieldError = confirmationProofCrossFieldError(record, proofAnswer);
  if (crossFieldError) return crossFieldError;
  const mappingRecordPath = pinnedRoot.relativePath(transaction.mapping_path);
  const statePath = pinnedRoot.relativePath(transaction.state_path);
  if (!mappingRecordPath || !statePath) return "confirmation WAL proof target path is unsafe";
  const expected: CtoMappingConfirmationProofPayload = {
    schema_version: 1,
    root_identity: { canonical_path: pinnedRoot.canonical_root, dev: pinnedRoot.dev, ino: pinnedRoot.ino },
    cto_run_id: transaction.cto_run_id,
    mapping_id: transaction.mapping_id,
    mapping_hash: transaction.mapping_hash,
    mapping_version: transaction.mapping.mapping_version,
    proof_ref: proofRef,
    mapping_record_path: mappingRecordPath,
    mapping_record_digest: transaction.mapping_after_digest,
    state_path: statePath,
    state_after_digest: record.confirmation_state_after_digest,
    checkpoint_ref: transition.checkpoint_id,
    trusted_answer_ref: transition.answer_id,
    confirmation_context: { ...record.confirmation_context },
    confirmed_at: record.confirmed_at,
    trusted_answer: proofAnswer,
  };
  if (mappingStateDigest(transaction.state) !== transaction.state_after_digest) return "confirmation WAL consumed state digest is inconsistent";
  const proof = readCtoMappingConfirmationProof(pinnedRoot, transaction.cto_run_id, transaction.mapping_id, proofRef, expected);
  if (!proof.ok) return proof.code === "absent" ? "confirmation WAL proof is absent; recovery is required" : `confirmation WAL proof is invalid: ${proof.error}`;
  const expectedProofPath = ctoMappingConfirmationProofRelativePath(transaction.cto_run_id, transaction.mapping_id, proofRef);
  if (!expectedProofPath || expectedProofPath !== transaction.confirmation_proof_path || proof.digest !== transaction.confirmation_proof_digest || proof.content !== transaction.confirmation_proof_content) return "confirmation WAL proof bytes differ from its immutable sidecar";
  return null;
}

function commitMappingTransactionPinned(root: string, transaction: MappingTransactionWithWalReceipt, pinnedRoot: PinnedProjectRoot): void {
  assertMappingTransactionWalReceiptPinned(transaction, transaction.wal_receipt, pinnedRoot);
  if (isDirectMappingTransaction(transaction)) {
    commitDirectMappingTransactionPinned(root, transaction, pinnedRoot);
    return;
  }
  if (transaction.status === "aborting") {
    abortMappingTransactionPinned(root, transaction, transaction.abort_reason ?? "mapping transaction recovery was interrupted during abort", pinnedRoot);
    return;
  }
  if (transaction.status === "aborted" || transaction.status === "quarantined") return;
  const confirmationProofError = mappingConfirmationTransactionProofError(transaction, pinnedRoot);
  if (confirmationProofError) {
    // WAL bytes are not authority. A proof failure must never drive a
    // compensating mapping mutation (a forged WAL could otherwise roll back a
    // live canonical image); leave the descriptor for explicit recovery.
    throw new Error(`CTO_SPEC_MAPPING_RECOVERY_REQUIRED: ${confirmationProofError}`);
  }
  const precommitConstitutionError = refreshCtoMappingTransactionConstitutions(root, transaction, pinnedRoot);
  if (precommitConstitutionError) {
    throw new Error(`CTO_SPEC_MAPPING_CONSTITUTION_CONFLICT: ${precommitConstitutionError}`);
  }
  const stateValidationError = mappingTransactionStateValidationError(root, transaction);
  if (stateValidationError) {
    abortMappingTransactionPinned(root, transaction, stateValidationError, pinnedRoot);
    throw new Error(`CTO_SPEC_MAPPING_STATE_CONFLICT: ${stateValidationError}`);
  }
  const txPath = mappingTransactionPath(transaction, pinnedRoot);
  const mappingRead = readPinnedRegularFile(pinnedRoot, transaction.mapping_path);
  if (!mappingRead.ok) {
    const reason = `canonical mapping cannot be read: ${mappingRead.error}`;
    abortMappingTransactionPinned(root, transaction, reason, pinnedRoot);
    throw new Error(`CTO_SPEC_MAPPING_CONFLICT: ${reason}`);
  }
  const mappingRaw = mappingRead.bytes.toString("utf8");
  const mappingDigest = sha256Hex(mappingRaw);
  if (mappingDigest !== transaction.mapping_before_digest && mappingDigest !== transaction.mapping_after_digest) {
    const reason = "canonical mapping changed while the transaction was pending";
    abortMappingTransactionPinned(root, transaction, reason, pinnedRoot);
    throw new Error(`CTO_SPEC_MAPPING_CONFLICT: ${reason}`);
  }
  if (mappingDigest === transaction.mapping_before_digest) {
    assertMappingTransactionWalReceiptPinned(transaction, transaction.wal_receipt, pinnedRoot);
    const mappingWriteConstitutionError = refreshCtoMappingTransactionConstitutions(root, transaction, pinnedRoot);
    if (mappingWriteConstitutionError) throw new Error(`CTO_SPEC_MAPPING_CONSTITUTION_CONFLICT: ${mappingWriteConstitutionError}`);
    injectMappingFailure(root, pinnedRoot, "before_mapping_write", transaction.transaction_id);
    const afterMappingHookConstitutionError = refreshCtoMappingTransactionConstitutions(root, transaction, pinnedRoot);
    if (afterMappingHookConstitutionError) throw new Error(`CTO_SPEC_MAPPING_CONSTITUTION_CONFLICT: ${afterMappingHookConstitutionError}`);
    pinnedRoot.replaceFileIfMatches(pinnedRelativePath(pinnedRoot, transaction.mapping_path), {
      dev: mappingRead.dev,
      ino: mappingRead.ino,
      sha256: mappingDigest,
    }, transaction.mapping_content);
    injectMappingFailure(root, pinnedRoot, "after_mapping_write", transaction.transaction_id);
  }
  const mapped = readMappingRecord(root, transaction.cto_run_id, transaction.mapping_id, pinnedRoot);
  const answerWAL = transaction.operation === "answer";
  const converged = mapped.ok
    && mapped.value.mapping.mapping_hash === transaction.mapping_hash
    && (answerWAL
      ? mapped.value.mapping.status === "awaiting_confirmation"
        || mapped.value.mapping.status === "revision_required"
        || mapped.value.mapping.status === "stopped"
      : mapped.value.mapping.status === "confirmed");
  if (!converged) {
    const reason = answerWAL
      ? "canonical mapping did not converge to its staged trusted answer"
      : "canonical mapping did not converge to its staged confirmation";
    abortMappingTransactionPinned(root, transaction, reason, pinnedRoot);
    throw new Error(`CTO_SPEC_MAPPING_CONFLICT: ${reason}`);
  }
  const stateWriteConstitutionError = refreshCtoMappingTransactionConstitutions(root, transaction, pinnedRoot);
  if (stateWriteConstitutionError) throw new Error(`CTO_SPEC_MAPPING_CONSTITUTION_CONFLICT: ${stateWriteConstitutionError}`);
  injectMappingFailure(root, pinnedRoot, "before_state_write", transaction.transaction_id);
  const afterStateHookConstitutionError = refreshCtoMappingTransactionConstitutions(root, transaction, pinnedRoot);
  if (afterStateHookConstitutionError) throw new Error(`CTO_SPEC_MAPPING_CONSTITUTION_CONFLICT: ${afterStateHookConstitutionError}`);
  assertMappingTransactionWalReceiptPinned(transaction, transaction.wal_receipt, pinnedRoot);
  const committed = updateStateAtomically<null>(
    root,
    (snapshot) => {
      if (!snapshot.state || !snapshot.target.statePath || resolve(snapshot.target.statePath) !== resolve(transaction.state_path)) {
        return { op: "fail", code: "state_conflict", error: "canonical feature state target is unavailable" };
      }
      if (snapshot.raw_hash === transaction.state_before_digest) {
        return { op: "commit", state: transaction.state, value: null };
      }
      if (mappingStateDigest(snapshot.state) === transaction.state_after_digest) {
        return { op: "discard", value: null };
      }
      return {
        op: "fail",
        code: "state_conflict",
        error: "selected feature state changed while mapping confirmation was pending",
      };
    },
    {
      selector: { feature_id: transaction.feature_id, run_key: transaction.run_key },
      ...(typeof transaction.state.branch === "string" ? { branch: transaction.state.branch } : {}),
      pinnedRoot,
      rootGuard: pinnedRoot,
      preCommit: () => {
        const finalConstitutionError = refreshCtoMappingTransactionConstitutions(root, transaction, pinnedRoot);
        if (finalConstitutionError) throw new Error(`CTO_SPEC_MAPPING_CONSTITUTION_CONFLICT: ${finalConstitutionError}`);
      },
    },
  );
  if (!committed.ok) {
    const reason = committed.error;
    const constitutionDrift = committed.code === "state_invalid" && /CTO_SPEC_MAPPING_CONSTITUTION_CONFLICT/u.test(reason);
    // A live constitution drift is a blocked, still-recoverable transaction:
    // do not turn its staged mapping into an authority-changing abort.
    if (committed.code !== "state_lock_unavailable" && !constitutionDrift) abortMappingTransactionPinned(root, transaction, reason, pinnedRoot);
    throw new Error(`${constitutionDrift ? "CTO_SPEC_MAPPING_CONSTITUTION_CONFLICT" : "CTO_SPEC_MAPPING_STATE_CONFLICT"}: ${reason}`);
  }
  injectMappingFailure(root, pinnedRoot, "after_state_write", transaction.transaction_id);
  if (!committed.state || mappingStateDigest(committed.state) !== transaction.state_after_digest) {
    const reason = "staged state did not converge to its consumed proof";
    abortMappingTransactionPinned(root, transaction, reason, pinnedRoot);
    throw new Error(`CTO_SPEC_MAPPING_STATE_CONFLICT: ${reason}`);
  }
  injectMappingFailure(root, pinnedRoot, "after_commit", transaction.transaction_id);
  try {
    removeMappingTransactionPinned(pinnedRoot, txPath, transaction.wal_receipt);
  } catch (error) {
    throw new Error(`CTO_SPEC_MAPPING_TRANSACTION_CLEANUP_FAILED: ${String(error)}`);
  }
}


function assertMappingTransactionWalReceiptPinned(
  transaction: Pick<CtoSpecificationMappingTransaction, "cto_run_id" | "transaction_id">,
  receipt: MappingTransactionWalReceipt,
  pinnedRoot: PinnedProjectRoot,
): void {
  const sourcePath = mappingTransactionPath(transaction, pinnedRoot);
  const source = readPinnedRegularFile(pinnedRoot, sourcePath, MAX_MAPPING_TRANSACTION_FILE_BYTES);
  if (!source.ok) throw new Error(`CTO_SPEC_MAPPING_RECOVERY_REQUIRED: WAL descriptor cannot be re-read after parse: ${source.error}`);
  const current = mappingTransactionWalReceipt(source.bytes, source.dev, source.ino);
  if (current.dev !== receipt.dev || current.ino !== receipt.ino || current.sha256 !== receipt.sha256) {
    throw new Error("CTO_SPEC_MAPPING_RECOVERY_REQUIRED: WAL descriptor changed after parse; no replay or deletion was performed");
  }
}

function quarantineMappingTransactionDescriptorPinned(
  root: string,
  ctoRunId: string,
  transactionId: string,
  mappingId: string,
  receipt: MappingTransactionWalReceipt,
  pinnedRoot: PinnedProjectRoot,
  suffix: string,
): void {
  const sourcePath = join(root, ".work-state", "cto", ctoRunId, "specification-mapping-transactions", `${transactionId}.json`);
  const relativeSource = pinnedRelativePath(pinnedRoot, sourcePath);
  const source = readPinnedRegularFile(pinnedRoot, sourcePath, MAX_MAPPING_TRANSACTION_FILE_BYTES);
  if (!source.ok) throw new Error(`CTO_SPEC_MAPPING_RECOVERY_REQUIRED: WAL descriptor cannot be re-read for quarantine: ${source.error}`);
  const current = mappingTransactionWalReceipt(source.bytes, source.dev, source.ino);
  if (current.dev !== receipt.dev || current.ino !== receipt.ino || current.sha256 !== receipt.sha256) {
    throw new Error("CTO_SPEC_MAPPING_RECOVERY_REQUIRED: WAL descriptor changed before quarantine; no replay or deletion was performed");
  }
  const quarantineDirectory = join(root, ".work-state", "cto", ctoRunId, "specification-mapping-quarantine");
  pinnedRoot.ensureDirectory(pinnedRelativePath(pinnedRoot, quarantineDirectory));
  const quarantinePath = join(quarantineDirectory, `${transactionId}-${mappingId}${suffix}.json`);
  const relativeDestination = pinnedRelativePath(pinnedRoot, quarantinePath);
  const rawBytes = Buffer.from(receipt.bytes);
  if (pinnedRoot.pathEntryExists(relativeDestination)) {
    const existing = pinnedRoot.readFile(relativeDestination, { maxBytes: MAX_MAPPING_TRANSACTION_FILE_BYTES });
    if (createHash("sha256").update(existing.bytes).digest("hex") !== receipt.sha256) {
      throw new Error("CTO_SPEC_MAPPING_QUARANTINE_CONFLICT: answer WAL archive already exists with different bytes");
    }
  } else {
    // Keep the untrusted descriptor byte-for-byte. The archive is audit data,
    // never an authority source, and no mapping/state image is written.
    pinnedRoot.writeExclusive(relativeDestination, rawBytes.toString("utf8"));
  }
  pinnedRoot.removeFileIfMatches(relativeSource, {
    dev: receipt.dev,
    ino: receipt.ino,
    sha256: receipt.sha256,
  });
}

function quarantineRecoveredAnswerMappingTransactionPinned(
  root: string,
  transaction: ParsedMappingTransaction,
  pinnedRoot: PinnedProjectRoot,
): void {
  quarantineMappingTransactionDescriptorPinned(
    root,
    transaction.cto_run_id,
    transaction.transaction_id,
    transaction.mapping_id,
    transaction.wal_receipt,
    pinnedRoot,
    "-answer",
  );
}

function recoverPendingMappingTransactions(root: string, ctoRunId: string, pinnedRoot: PinnedProjectRoot): CtoSpecificationMappingTransaction[] {
  const completed: CtoSpecificationMappingTransaction[] = [];
  let answerRecoveryRequired: string | null = null;
  for (const transaction of readPendingMappingTransactionsPinned(root, ctoRunId, pinnedRoot)) {
    injectMappingFailure(root, pinnedRoot, "after_recovery_read", transaction.transaction_id);
    try {
      // A pending answer WAL contains untrusted on-disk JSON, not proof that a
      // trusted host Ask actually issued the human decision. Archive/remove
      // only that descriptor; never trust either of its before/after images.
      if (transaction.operation === "answer") {
        quarantineRecoveredAnswerMappingTransactionPinned(root, transaction, pinnedRoot);
        answerRecoveryRequired ??= transaction.transaction_id;
        completed.push({
          ...transaction,
          status: "quarantined",
          terminal_disposition: "quarantined",
          terminal_at: new Date().toISOString(),
          abort_reason: "answer WAL has no live trusted host Ask proof; recovery quarantined its descriptor without changing canonical mapping or state",
        });
        continue;
      }
      commitMappingTransactionPinned(root, transaction, pinnedRoot);
      completed.push(transaction);
    } catch (error) {
      // A state conflict is reported to the operation that discovered it, but
      // recovery itself must not poison every later operation once the abort
      // WAL reached a terminal disposition.
      const terminal = readPinnedMappingTransactions(root, ctoRunId, pinnedRoot).find((candidate) =>
        candidate.transaction_id === transaction.transaction_id
        && (candidate.status === "aborted" || candidate.status === "quarantined"),
      );
      if (terminal && error instanceof Error && /CTO_SPEC_MAPPING_(STATE_)?CONFLICT/.test(error.message)) {
        completed.push(terminal);
        continue;
      }
      throw error;
    }
  }
  if (answerRecoveryRequired) {
    throw new Error(`CTO_SPEC_MAPPING_ANSWER_RECOVERY_REQUIRED: quarantined answer WAL '${answerRecoveryRequired}'; obtain a fresh trusted terminal Ask before continuing`);
  }
  return completed;
}

function readMappingRecord(root: string, ctoRunId: string, mappingId: string, pinnedRoot: PinnedProjectRoot): { ok: true; value: CtoSpecificationMappingRecord & { record_digest: string; record_path: string } } | { ok: false; error: string } {
  const file = mappingPath(root, ctoRunId, mappingId, pinnedRoot);
  if (!file) return { ok: false, error: "the requested CTO specification mapping does not exist" };
  const relativePath = pinnedRoot.relativePath(file);
  if (!relativePath) return { ok: false, error: "mapping record path is unsafe: path escapes the pinned project root" };
  const loaded = readPinnedCtoMappingRecord(pinnedRoot, relativePath, ctoRunId, mappingId);
  if (!loaded.ok) return { ok: false, error: loaded.error };
  const parsed: unknown = loaded.value.record;
  const recordDigest = loaded.value.digest;
  try {
    const record = parsed as CtoSpecificationMappingRecord;
    const terminalError = terminalMappingErrorPinned(pinnedRoot, root, ctoRunId, mappingId, recordDigest);
    if (terminalError) return { ok: false, error: terminalError };
    const mapping = record.mapping as CtoSpecificationMapping;
    if (mapping.mapping_id !== mappingId || !mappingHashMatches(mapping)) return { ok: false, error: "mapping record identity or hash is invalid" };
    const immutable = mapping as CtoSpecificationMapping & { cto_run_id?: string; selections?: CtoSpecificationExecutionSelection[]; execution_choice?: string; execution?: { wave_id?: string; source_id?: string; capability_id?: string; capability_epoch?: string; choice?: string } };
    if (immutable.cto_run_id !== ctoRunId || immutable.execution_choice !== "cto" || !Array.isArray(immutable.selections)
      || immutable.selections.length !== record.selections.length
      || immutable.selections.some((selection, index) => selection.feature_id !== record.selections![index]?.feature_id || selection.run_key !== record.selections![index]?.run_key)
      || !immutable.execution || immutable.execution.choice !== "cto" || typeof immutable.execution.wave_id !== "string" || typeof immutable.execution.source_id !== "string" || typeof immutable.execution.capability_id !== "string" || typeof immutable.execution.capability_epoch !== "string") {
      return { ok: false, error: "mapping immutable run/selectors/execution envelope is invalid" };
    }
    const mappingStatus = mapping.status as string;
    if (!["awaiting_confirmation", "confirmed", "revision_required", "stopped", "stale", "blocked", "aborted", "quarantined"].includes(mappingStatus)) return { ok: false, error: "mapping record has an invalid status" };
    if (mappingStatus === "aborted" || mappingStatus === "quarantined") return { ok: false, error: `mapping is ${mappingStatus}; staged mapping is not dispatchable` };
    if (record.selections.some((selection) => !selection || typeof selection.feature_id !== "string" || !isSafeFeatureId(selection.feature_id) || typeof selection.run_key !== "string" || selection.run_key.trim().length === 0)) return { ok: false, error: "mapping record contains an invalid explicit selector" };
    const selectorRuns = new Map<string, Set<string>>();
    for (const selection of record.selections) {
      const runs = selectorRuns.get(selection.feature_id) ?? new Set<string>();
      if (runs.has(selection.run_key)) return { ok: false, error: "mapping record contains duplicate selectors" };
      runs.add(selection.run_key);
      selectorRuns.set(selection.feature_id, runs);
    }
    if (record.checkpoint_ref !== null && record.checkpoint_ref !== undefined && (typeof record.checkpoint_ref !== "string" || record.checkpoint_ref.trim().length === 0)) return { ok: false, error: "mapping checkpoint_ref is invalid" };
    if (record.trusted_answer_ref !== null && record.trusted_answer_ref !== undefined && (typeof record.trusted_answer_ref !== "string" || record.trusted_answer_ref.trim().length === 0)) return { ok: false, error: "mapping trusted_answer_ref is invalid" };
    if (!Array.isArray(mapping.feature_ids) || !mapping.feature_ids.every((featureId) => typeof featureId === "string")) return { ok: false, error: "mapping feature_ids are invalid" };
    if (mapping.feature_ids.length !== record.selections!.length || mapping.feature_ids.some((featureId, index) => featureId !== record.selections![index]?.feature_id)) return { ok: false, error: "mapping feature_ids do not match the exact explicit selections" };
    const firstSelection = record.selections[0];
    if (mapping.status === "confirmed") {
      const context = record.confirmation_context;
      if (
        typeof record.checkpoint_ref !== "string"
        || typeof record.trusted_answer_ref !== "string"
        || mapping.checkpoint_ref !== record.checkpoint_ref
        || !context
        || !isSafeFeatureId(context.feature_id)
        || typeof context.run_key !== "string"
        || context.run_key.trim().length === 0
        || typeof context.stage_id !== "string"
        || context.stage_id.trim().length === 0
        || context.decision !== "approve_continue"
        || typeof context.capability_id !== "string"
        || context.capability_id.trim().length === 0
        || typeof context.capability_epoch !== "string"
        || context.capability_epoch.trim().length === 0
        || typeof context.policy_hash !== "string"
        || !isSha256Hex(context.policy_hash)
        || !firstSelection
        || context.feature_id !== firstSelection.feature_id
        || context.run_key !== firstSelection.run_key
        || record.review !== undefined
      ) {
        return { ok: false, error: "confirmed mapping is missing its exact confirmation context" };
      }
    }
    if (mapping.status === "revision_required" || mapping.status === "stopped") {
      const review = record.review;
      if (!review
        || !isSafeFeatureId(review.feature_id)
        || typeof review.run_key !== "string" || review.run_key.trim().length === 0
        || typeof review.stage_id !== "string" || review.stage_id.trim().length === 0
        || !["approve_continue", "request_changes", "approve_stop"].includes(review.decision)
        || typeof review.checkpoint_ref !== "string" || review.checkpoint_ref.trim().length === 0
        || !record.selections.some((selection) => selection.feature_id === review.feature_id && selection.run_key === review.run_key)
        || typeof review.capability_id !== "string" || review.capability_id.trim().length === 0
        || typeof review.capability_epoch !== "string" || review.capability_epoch.trim().length === 0
        || typeof review.policy_hash !== "string" || !isSha256Hex(review.policy_hash)
        || (mapping.status === "revision_required" && review.decision !== "request_changes")
        || (mapping.status === "stopped" && review.decision !== "approve_stop")
        || mapping.checkpoint_ref !== null
        || record.checkpoint_ref !== null
        || record.trusted_answer_ref !== null
        || record.confirmation_context !== undefined) {
        return { ok: false, error: "mapping review outcome is incomplete or mismatched" };
      }
    }
    return { ok: true, value: { schema_version: 1, cto_run_id: ctoRunId, mapping, selections: record.selections.map((selection) => ({ ...selection })), checkpoint_ref: record.checkpoint_ref ?? null, trusted_answer_ref: record.trusted_answer_ref ?? null, ...(record.review ? { review: { ...record.review } } : {}), ...(record.confirmation_context ? { confirmation_context: { ...record.confirmation_context } } : {}), ...(record.confirmed_at ? { confirmed_at: record.confirmed_at } : {}), ...(record.confirmation_state_after_digest ? { confirmation_state_after_digest: record.confirmation_state_after_digest } : {}), ...(record.confirmation_proof_ref ? { confirmation_proof_ref: record.confirmation_proof_ref } : {}), record_digest: recordDigest, record_path: file } };
  } catch (error) { return { ok: false, error: `mapping record is unreadable: ${error instanceof Error ? error.message : String(error)}` }; }
}
function mappingRecordContentError(record: CtoSpecificationMappingRecord, ctoRunId: string, mappingId: string): { content: string; error: string | null } {
  const content = `${JSON.stringify(record, null, 2)}\r\n`;
  if (Buffer.byteLength(content, "utf8") > MAX_CTO_MAPPING_RECORD_BYTES) {
    return { content, error: `mapping record exceeds ${MAX_CTO_MAPPING_RECORD_BYTES} bytes` };
  }
  return { content, error: validateCtoMappingRecord(record, ctoRunId, mappingId) };
}
function createDirectMappingTransaction(
  operation: "preflight" | "resume",
  ctoRunId: string,
  record: CtoSpecificationMappingRecord,
  mappingPathValue: string,
  mappingBeforeDisposition: "present" | "absent",
  mappingBeforeContent: string | null,
  mappingContent: string,
  selected: PinnedFeatureStateRead,
): CtoSpecificationMappingTransaction {
  const selection = record.selections[0];
  if (!selection) throw new Error("CTO_SPEC_MAPPING_TRANSACTION_INVALID: direct mapping has no selection");
  const stateDigest = createHash("sha256").update(selected.bytes).digest("hex");
  const stateLogicalDigest = mappingStateDigest(selected.state);
  return {
    schema_version: 1,
    transaction_id: randomUUID(),
    operation,
    cto_run_id: ctoRunId,
    mapping_id: record.mapping.mapping_id,
    mapping_hash: record.mapping.mapping_hash,
    feature_id: selection.feature_id,
    run_key: selection.run_key,
    mapping_path: mappingPathValue,
    mapping_before_disposition: mappingBeforeDisposition,
    mapping_before_content: mappingBeforeContent,
    mapping_before_digest: sha256Hex(mappingBeforeContent ?? ""),
    staged_mapping_identity: {
      mapping_id: record.mapping.mapping_id,
      mapping_hash: record.mapping.mapping_hash,
      content_digest: sha256Hex(mappingContent),
    },
    mapping_after_digest: sha256Hex(mappingContent),
    mapping_content: mappingContent,
    mapping: record.mapping,
    selections: record.selections.map((entry) => ({ ...entry })),
    state_path: selected.statePath,
    state_dir: selected.stateDir,
    artifacts_dir: selected.artifactsDir,
    is_legacy: selected.isLegacy,
    state_before_digest: stateDigest,
    state_source_logical_digest: stateLogicalDigest,
    state_after_digest: stateLogicalDigest,
    state_transition: {
      kind: "record_checkpoint_answer",
      answer_id: `direct-mapping-${record.mapping.mapping_id}`,
      stage_id: "execution",
      checkpoint_id: "cto_mapping_publication",
      decision: "approve_continue",
      feature_id: selection.feature_id,
      run_key: selection.run_key,
    },
    status: "pending",
  };
}

function canonicalMappingRecord(record: CtoSpecificationMappingRecord): CtoSpecificationMappingRecord {
  return {
    schema_version: record.schema_version,
    cto_run_id: record.cto_run_id,
    mapping: record.mapping,
    selections: record.selections.map((selection) => ({ ...selection })),
    checkpoint_ref: record.checkpoint_ref,
    trusted_answer_ref: record.trusted_answer_ref,
    ...(record.review ? { review: { ...record.review } } : {}),
    ...(record.confirmation_context ? { confirmation_context: { ...record.confirmation_context } } : {}),
    ...(record.confirmed_at ? { confirmed_at: record.confirmed_at } : {}),
    ...(record.confirmation_state_after_digest ? { confirmation_state_after_digest: record.confirmation_state_after_digest } : {}),
    ...(record.confirmation_proof_ref ? { confirmation_proof_ref: record.confirmation_proof_ref } : {}),
  };
}

function sameSelections(left: readonly CtoSpecificationExecutionSelection[], right: readonly CtoSpecificationExecutionSelection[]): boolean {
  return left.length === right.length && left.every((selection, index) => selection.feature_id === right[index]?.feature_id && selection.run_key === right[index]?.run_key);
}

function sameFrozenMapping(left: CtoSpecificationMapping, right: CtoSpecificationMapping): boolean {
  return left.mapping_id === right.mapping_id && left.mapping_hash === right.mapping_hash && canonicalJson(mappingHashBody(left)) === canonicalJson(mappingHashBody(right));
}

interface CtoExecutionContext {
  state: CtoState;
  wave_id: string;
  source_id: string;
  stage_id: string;
  capability_id: string;
  capability_epoch: string;
}

interface PinnedFeatureStateRead {
  state: TeamState;
  statePath: string;
  stateDir: string;
  artifactsDir: string;
  bytes: Buffer;
  stateRevision: number;
  rawDigest: string;
  ledgerDigest: string;
  isLegacy: false;
}

function readPinnedFeatureState(
  root: string,
  featureId: string,
  runKey: string,
  pinnedRoot: PinnedProjectRoot,
): { ok: true; value: PinnedFeatureStateRead } | { ok: false; error: string } {
  if (!isSafeFeatureId(featureId) || typeof runKey !== "string" || runKey.trim().length === 0) {
    return { ok: false, error: "feature/run selector is invalid" };
  }
  try {
    if (!pinnedRoot.isStable()) return { ok: false, error: "project root changed before feature state read" };
    const statePath = featureStatePath(root, featureId);
    const relativePath = pinnedRelativePath(pinnedRoot, statePath);
    const read = pinnedRoot.readFile(relativePath, { maxBytes: MAX_PERSISTED_STATE_BYTES });
    const raw = new TextDecoder("utf-8", { fatal: true }).decode(read.bytes);
    let parsed: unknown;
    try { parsed = JSON.parse(raw); }
    catch (error) { return { ok: false, error: `canonical feature state is not valid JSON: ${error instanceof Error ? error.message : String(error)}` }; }
    const bounded = parseBoundedPersistedState(parsed);
    if (!bounded) return { ok: false, error: "canonical feature state exceeds bounded structural limits or has an unsafe object shape" };
    const issues: string[] = [];
    const state = normalizePersistedState(bounded, issues, { canonical_path: pinnedRoot.canonical_root, dev: pinnedRoot.dev, ino: pinnedRoot.ino });
    if (!state) return { ok: false, error: `canonical feature state is invalid${issues.length ? `: ${issues.join("; ")}` : ""}` };
    const stateRevision = parsed && typeof parsed === "object" && !Array.isArray(parsed)
      && Number.isSafeInteger((parsed as Record<string, unknown>).state_revision)
      && ((parsed as Record<string, unknown>).state_revision as number) >= 0
      ? (parsed as Record<string, unknown>).state_revision as number
      : 0;
    const bytes = Buffer.from(read.bytes);
    const rawDigest = sha256Hex(bytes.toString("utf8"));
    const ledgerDigest = digestOf({ checkpoint_policy: state.checkpoint_policy ?? null, trusted_checkpoint_answers: state.trusted_checkpoint_answers ?? [] });
    if (state.run_key !== runKey) return { ok: false, error: "canonical feature state run_key does not match the explicit selector" };
    if (!state.specification || state.specification.feature_id !== featureId) return { ok: false, error: "canonical feature state specification does not match the explicit feature selector" };
    const artifactsDir = featureArtifactsDir(root, featureId);
    pinnedRelativePath(pinnedRoot, artifactsDir);
    if (!pinnedRoot.isStable()) return { ok: false, error: "project root changed after feature state read" };
    return { ok: true, value: { state, statePath: read.path, stateDir: dirname(read.path), artifactsDir, bytes, stateRevision, rawDigest, ledgerDigest, isLegacy: false } };
  } catch (error) {
    return { ok: false, error: `canonical feature state is unavailable: ${error instanceof Error ? error.message : String(error)}` };
  }
}

function sameExecutionContext(left: CtoExecutionContext, right: CtoExecutionContext): boolean {
  return left.wave_id === right.wave_id
    && left.source_id === right.source_id
    && left.stage_id === right.stage_id
    && left.capability_id === right.capability_id
    && left.capability_epoch === right.capability_epoch;
}

interface CtoDispatchAdmissionSnapshot {
  record: CtoSpecificationMappingRecord & { record_digest: string; record_path: string };
  execution: CtoExecutionContext;
  anchor: PinnedFeatureStateRead;
  authorization_projection_digest: string;
}

type MappingWithExecution = CtoSpecificationMapping & {
  cto_run_id?: string;
  execution_choice?: string;
  execution?: { wave_id?: string; source_id?: string; capability_id?: string; capability_epoch?: string; choice?: string };
};

function ctoMappingTeamBindingsMatchExecution(mapping: CtoSpecificationMapping, execution: CtoExecutionContext, selections?: readonly { feature_id: string; run_key: string }[]): boolean {
  const teamsById = new Map(execution.state.teams.map((team) => [team.id, team]));
  const ownersBySlice = new Map(mapping.task_to_slice.map((owner) => [owner.slice_id, owner]));
  if (ownersBySlice.size !== mapping.task_to_slice.length || ownersBySlice.size !== mapping.parallelization.length) return false;
  for (const owner of mapping.task_to_slice) {
    const team = teamsById.get(owner.team_id);
    const identity = team?.work_identity;
    const selection = selections?.find((candidate) => candidate.feature_id === owner.feature_id);
    if (!team || (selections !== undefined && (!selection || team.run_key !== selection.run_key)) || team.slice_id !== owner.slice_id || team.feature_id !== owner.feature_id || team.task_id !== owner.task_id
      || !identity || identity.run_id !== execution.state.id || identity.wave_id !== execution.wave_id
      || identity.slice_id !== owner.slice_id || identity.task_id !== owner.task_id) return false;
  }
  return mapping.parallelization.every((decision) => ownersBySlice.has(decision.slice_id));
}

function mappingConfirmationRequired(record: Pick<CtoSpecificationMappingRecord, "mapping" | "checkpoint_ref" | "trusted_answer_ref" | "confirmation_context">): boolean {
  return record.mapping.status !== "confirmed"
    || !record.confirmation_context
    || typeof record.checkpoint_ref !== "string"
    || typeof record.trusted_answer_ref !== "string"
    || record.mapping.checkpoint_ref !== record.checkpoint_ref;
}

function ctoMappingConfirmationProofPayload(
  pinnedRoot: PinnedProjectRoot,
  record: CtoSpecificationMappingRecord & { record_digest: string; record_path: string },
  anchor: PinnedFeatureStateRead,
  answer: CtoMappingConfirmationProofAnswer,
): CtoMappingConfirmationProofPayload | null {
  const context = record.confirmation_context;
  if (!context || typeof record.checkpoint_ref !== "string" || typeof record.trusted_answer_ref !== "string" || typeof record.confirmed_at !== "string" || typeof record.confirmation_state_after_digest !== "string" || typeof record.confirmation_proof_ref !== "string") return null;
  const mappingRecordPath = pinnedRoot.relativePath(record.record_path);
  const statePath = pinnedRoot.relativePath(anchor.statePath);
  if (!mappingRecordPath || !statePath) return null;
  return {
    schema_version: 1,
    root_identity: { canonical_path: pinnedRoot.canonical_root, dev: pinnedRoot.dev, ino: pinnedRoot.ino },
    cto_run_id: record.cto_run_id,
    mapping_id: record.mapping.mapping_id,
    mapping_hash: record.mapping.mapping_hash,
    mapping_version: record.mapping.mapping_version,
    proof_ref: record.confirmation_proof_ref,
    mapping_record_path: mappingRecordPath,
    mapping_record_digest: record.record_digest,
    state_path: statePath,
    state_after_digest: record.confirmation_state_after_digest ?? "",
    checkpoint_ref: record.checkpoint_ref,
    trusted_answer_ref: record.trusted_answer_ref,
    confirmation_context: { ...context },
    confirmed_at: record.confirmed_at,
    trusted_answer: answer,
  };
}

function confirmationProofCrossFieldError(
  record: CtoSpecificationMappingRecord,
  answer: CtoMappingConfirmationProofAnswer,
): string | null {
  const context = record.confirmation_context;
  if (!context || typeof record.checkpoint_ref !== "string" || typeof record.trusted_answer_ref !== "string") return "confirmation proof context is incomplete";
  if (!mappingHashMatches(record.mapping)
    || record.mapping.mapping_id !== `cto-mapping-${record.mapping.mapping_hash.slice(0, 32)}`
    || record.trusted_answer_ref !== answer.answer_id
    || record.checkpoint_ref !== answer.checkpoint_id
    || context.feature_id !== answer.feature_id
    || context.run_key !== answer.run_id
    || context.stage_id !== answer.stage_id
    || context.decision !== answer.decision
    || context.capability_id !== answer.capability_id
    || context.capability_epoch !== answer.capability_epoch
    || context.policy_hash !== answer.policy_hash
    || answer.subject_binding !== record.mapping.mapping_hash
    || answer.subject_revision !== record.mapping.mapping_version) {
    return "confirmation proof cross-field identity is mismatched";
  }
  return null;
}

function mappingConfirmationProofError(
  pinnedRoot: PinnedProjectRoot,
  record: CtoSpecificationMappingRecord & { record_digest: string; record_path: string },
  anchor: PinnedFeatureStateRead,
): string | null {
  if (typeof record.confirmation_proof_ref !== "string") return "durable mapping confirmation proof is missing; recovery is required";
  const answer = anchor.state.trusted_checkpoint_answers?.find((candidate) => candidate.answer_id === record.trusted_answer_ref);
  if (!answer || !answer.consumed_at || typeof answer.subject_binding !== "string" || !Number.isSafeInteger(answer.subject_revision) || typeof answer.authority_receipt !== "string") {
    return "durable mapping confirmation proof cannot bind the consumed canonical answer";
  }
  const proofAnswer = {
    ...answer,
    subject_binding: answer.subject_binding,
    subject_revision: answer.subject_revision as number,
    authority_receipt: answer.authority_receipt,
    consumed_at: answer.consumed_at,
  } as CtoMappingConfirmationProofAnswer;
  const crossFieldError = confirmationProofCrossFieldError(record, proofAnswer);
  if (crossFieldError) return crossFieldError;
  const expected = ctoMappingConfirmationProofPayload(pinnedRoot, record, anchor, proofAnswer);
  if (!expected) return "durable mapping confirmation proof context is incomplete";
  const proof = readCtoMappingConfirmationProof(pinnedRoot, record.cto_run_id, record.mapping.mapping_id, record.confirmation_proof_ref, expected);
  if (!proof.ok) return proof.code === "absent"
    ? "durable mapping confirmation proof is absent; recovery is required"
    : `durable mapping confirmation proof is invalid: ${proof.error}`;
  return null;
}

function dispatchAdmissionError(
  record: CtoSpecificationMappingRecord & { record_digest: string; record_path: string },
  execution: CtoExecutionContext,
  anchor: PinnedFeatureStateRead,
  runId: string,
  rootIdentity: TrustedCheckpointRootIdentity,
  pinnedRoot: PinnedProjectRoot,
): string | null {
  const mapping = record.mapping as MappingWithExecution;
  const context = record.confirmation_context;
  const firstSelection = record.selections[0];
  if (record.cto_run_id !== runId
    || mapping.mapping_id !== record.mapping.mapping_id
    || mapping.status !== "confirmed"
    || !record.checkpoint_ref || !record.trusted_answer_ref
    || mapping.checkpoint_ref !== record.checkpoint_ref
    || !context
    || !mapping.execution
    || !ctoMappingTeamBindingsMatchExecution(record.mapping, execution, record.selections)
    || !ctoMappingExecutionMatchesWave(
      mapping.execution,
      execution.state.wave_history?.find((candidate) => candidate.id === execution.wave_id),
      runId,
      record.mapping.parallelization.map((decision) => decision.slice_id),
      execution.state.teams.map((team) => team.work_identity),
    )) {
    return "canonical mapping is not an exact confirmed image of the active execution wave";
  }
  if (context.feature_id !== anchor.state.specification?.feature_id
    || context.run_key !== anchor.state.run_key
    || context.stage_id.trim().length === 0
    || context.decision !== "approve_continue"
    || context.capability_id !== execution.capability_id
    || context.capability_epoch !== execution.capability_epoch) {
    return "confirmation anchor feature/run/capability context is stale";
  }
  if (!anchor.state.checkpoint_policy) return "confirmation anchor checkpoint policy is unavailable";
  const activePolicyHash = checkpointPolicyHash(anchor.state.checkpoint_policy);
  if (context.policy_hash !== activePolicyHash) return "confirmation anchor checkpoint policy hash is stale";
  const activeRule = anchor.state.checkpoint_policy.rules[record.checkpoint_ref!];
  if (!activeRule || !activeRule.allowed_decisions.includes("approve_continue")) return "confirmation anchor checkpoint policy rule is unavailable or does not allow approval";
  if (!firstSelection || firstSelection.feature_id !== context.feature_id || firstSelection.run_key !== context.run_key) {
    return "confirmation context feature/run must match the first exact frozen mapping selection";
  }
  const expectedCheckpointRef = ctoMappingCheckpoint({
    cto_run_id: runId,
    mapping_id: mapping.mapping_id,
    mapping_hash: mapping.mapping_hash,
    mapping_version: mapping.mapping_version,
    feature_id: context.feature_id,
    run_key: context.run_key,
    stage_id: context.stage_id,
  }, execution, context.decision);
  if (record.checkpoint_ref !== expectedCheckpointRef || mapping.checkpoint_ref !== expectedCheckpointRef) {
    return "confirmed mapping checkpoint reference is not the canonical mapping authorization";
  }
  const answer = anchor.state.trusted_checkpoint_answers?.find((candidate) => candidate.answer_id === record.trusted_answer_ref);
  if (!answer) return "confirmed mapping trusted-answer ledger is missing";
  if (answer.checkpoint_id !== record.checkpoint_ref
    || answer.stage_id !== context.stage_id
    || answer.decision !== context.decision
    || answer.capability_id !== execution.capability_id
    || answer.capability_epoch !== execution.capability_epoch
    || answer.policy_hash !== context.policy_hash
    || answer.subject_binding !== mapping.mapping_hash
    || answer.subject_revision !== mapping.mapping_version
    || typeof answer.authority_receipt !== "string"
    || answer.authority_receipt.trim().length === 0
    || answer.work_identity_hash !== checkpointWorkIdentityHash(anchor.state, context.stage_id)
    || answer.policy_hash !== activePolicyHash) {
    return "confirmed mapping trusted-answer ledger is stale or mismatched";
  }
  const durableProofError = mappingConfirmationProofError(pinnedRoot, record, anchor);
  if (durableProofError) return durableProofError;
  const proof: CheckpointAnswerProof = {
    answer_id: answer.answer_id,
    nonce: answer.nonce,
    channel: answer.channel,
    reference: answer.reference,
    binding: answer.binding,
    ...(answer.feedback !== undefined ? { feedback: answer.feedback } : {}),
  };
  // A dispatch retry may run in a fresh process after confirmation consumed
  // the one-time answer authority. Before invoking the live-answer verifier,
  // accept only the exact committed confirmation image: canonical mapping
  // identity, confirmation context, consumed ledger record, and the already
  // checked execution/team/slice bindings must all agree. Any changed mapping,
  // caller selector, session, or task ownership remains a fresh authorization.
  const committedConfirmationReplay = answer.consumed_at !== undefined
    && typeof record.confirmed_at === "string"
    && record.confirmed_at.trim().length > 0
    && record.mapping.mapping_id === mapping.mapping_id
    && record.mapping.mapping_hash === mapping.mapping_hash
    && record.mapping.checkpoint_ref === record.checkpoint_ref
    && context.feature_id === answer.feature_id
    && context.run_key === answer.run_id
    && context.stage_id === answer.stage_id
    && context.decision === answer.decision
    && context.capability_id === answer.capability_id
    && context.capability_epoch === answer.capability_epoch
    && context.policy_hash === answer.policy_hash
    && answer.subject_binding === mapping.mapping_hash
    && answer.subject_revision === mapping.mapping_version;
  const proofError = trustedCheckpointAnswerError(anchor.state, {
    actor: { kind: "user", ref: answer.reference, proof },
    run_id: anchor.state.run_key ?? "",
    stage_id: context.stage_id,
    checkpoint_id: record.checkpoint_ref,
    decision: context.decision,
    feature_id: context.feature_id,
    capability_id: execution.capability_id,
    capability_epoch: execution.capability_epoch,
    policy_hash: context.policy_hash,
    subject_binding: mapping.mapping_hash,
    subject_revision: mapping.mapping_version,
    root_identity: rootIdentity,
    bind_active_context: committedConfirmationReplay ? false : true,
  });
  if (proofError) return `confirmed mapping trusted-answer proof is invalid: ${proofError}`;
  if (!Number.isSafeInteger(mapping.mapping_version) || mapping.mapping_version < 1) return "confirmed mapping revision is invalid";
  return null;
}

function prepareCtoReconciliationMappingAuthority(
  root: string,
  ctoRunId: string,
  record: CtoSpecificationMappingRecord & { record_digest: string; record_path: string },
  execution: CtoExecutionContext,
  pinnedRoot: PinnedProjectRoot,
): { ok: true; authority: CtoSpecificationExecutionMappingAuthority; validator: CtoSpecificationExecutionMappingAuthorityValidator } | { ok: false; error: string } {
  const mappingRecordPath = pinnedRoot.relativePath(record.record_path);
  if (!mappingRecordPath) return { ok: false, error: "canonical mapping record path is outside the pinned project root" };
  const firstSelection = record.selections[0];
  const context = record.confirmation_context;
  if (!firstSelection || !record.checkpoint_ref || !record.trusted_answer_ref || !context || typeof record.confirmed_at !== "string" || record.confirmed_at.trim().length === 0) {
    return { ok: false, error: "confirmed mapping lacks the exact confirmation context" };
  }
  const anchor = readPinnedFeatureState(root, firstSelection.feature_id, firstSelection.run_key, pinnedRoot);
  if (!anchor.ok) return { ok: false, error: anchor.error };
  const admissionError = dispatchAdmissionError(record, execution, anchor.value, ctoRunId, { canonical_root: pinnedRoot.canonical_root, dev: pinnedRoot.dev, ino: pinnedRoot.ino }, pinnedRoot);
  if (admissionError) return { ok: false, error: admissionError };
  const answer = anchor.value.state.trusted_checkpoint_answers?.find((candidate) => candidate.answer_id === record.trusted_answer_ref);
  if (!answer) return { ok: false, error: "confirmed mapping trusted-answer ledger is missing" };
  const confirmation = {
    checkpoint_ref: record.checkpoint_ref,
    trusted_answer_ref: record.trusted_answer_ref,
    confirmation_context: { ...context },
    confirmed_at: record.confirmed_at,
    trusted_answer: { ...answer },
  };
  const authority: CtoSpecificationExecutionMappingAuthority = {
    mapping_record_path: mappingRecordPath,
    mapping_record_digest: record.record_digest,
    mapping_id: record.mapping.mapping_id,
    mapping_hash: record.mapping.mapping_hash,
    mapping: record.mapping as CtoSpecificationExecutionMappingAuthority["mapping"],
    wave_id: execution.wave_id,
    confirmation,
  };
  const validator: CtoSpecificationExecutionMappingAuthorityValidator = ({ record: rawRecord, record_digest, record_path, state, pinnedRoot: currentRoot }: CtoSpecificationExecutionMappingAuthorityValidationInput): string | null => {
    const current = { ...rawRecord, record_digest, record_path } as CtoSpecificationMappingRecord & { record_digest: string; record_path: string };
    if (current.record_digest !== authority.mapping_record_digest
      || current.record_path !== authority.mapping_record_path
      || current.checkpoint_ref !== authority.confirmation.checkpoint_ref
      || current.trusted_answer_ref !== authority.confirmation.trusted_answer_ref
      || canonicalJson(current.confirmation_context) !== canonicalJson(authority.confirmation.confirmation_context)
      || current.confirmed_at !== authority.confirmation.confirmed_at) {
      return "confirmed mapping authorization changed after outer admission";
    }
    const wave = state.wave_history?.find((candidate) => candidate.id === authority.wave_id && candidate.status === "active" && candidate.source === "specification-execution");
    const identity = wave?.work_identity;
    if (!wave || !identity || state.active_wave_id !== authority.wave_id || typeof wave.source_id !== "string" || identity.stage_id !== "execution" || identity.stage_cursor !== "execution" || typeof identity.capability_id !== "string" || typeof identity.capability_epoch !== "string") {
      return "active CTO execution wave changed after outer admission";
    }
    const currentExecution: CtoExecutionContext = { state, wave_id: wave.id, source_id: wave.source_id, stage_id: identity.stage_id, capability_id: identity.capability_id, capability_epoch: identity.capability_epoch };
    const currentFirst = current.selections?.[0];
    if (!currentFirst) return "confirmed mapping has no selected feature";
    const currentAnchor = readPinnedFeatureState(currentRoot.canonical_root, currentFirst.feature_id, currentFirst.run_key, currentRoot);
    if (!currentAnchor.ok) return currentAnchor.error;
    const currentAnswer = currentAnchor.value.state.trusted_checkpoint_answers?.find((candidate) => candidate.answer_id === authority.confirmation.trusted_answer_ref);
    if (!currentAnswer || canonicalJson(currentAnswer) !== canonicalJson(authority.confirmation.trusted_answer)) return "confirmed mapping trusted-answer ledger changed after outer admission";
    return dispatchAdmissionError(current, currentExecution, currentAnchor.value, ctoRunId, { canonical_root: currentRoot.canonical_root, dev: currentRoot.dev, ino: currentRoot.ino }, currentRoot);
  };
  return { ok: true, authority, validator };
}

function dispatchAuthorizationProjectionDigest(
  record: CtoSpecificationMappingRecord & { record_digest: string; record_path: string },
  execution: CtoExecutionContext,
  anchor: PinnedFeatureStateRead,
  pinnedRoot: PinnedProjectRoot,
): string | null {
  const context = record.confirmation_context;
  const checkpointRef = record.checkpoint_ref;
  const trustedAnswerRef = record.trusted_answer_ref;
  const policy = anchor.state.checkpoint_policy;
  if (!context || !checkpointRef || !trustedAnswerRef || !policy) return null;
  const answer = anchor.state.trusted_checkpoint_answers?.find((candidate) => candidate.answer_id === trustedAnswerRef);
  if (!answer) return null;
  const proof: CheckpointAnswerProof = {
    answer_id: answer.answer_id,
    nonce: answer.nonce,
    channel: answer.channel,
    reference: answer.reference,
    binding: answer.binding,
    ...(answer.feedback !== undefined ? { feedback: answer.feedback } : {}),
  };
  return executionClaimAuthorizationProjectionDigest({
    feature_id: context.feature_id,
    run_key: context.run_key,
    stage_id: context.stage_id,
    capability_id: execution.capability_id,
    capability_epoch: execution.capability_epoch,
    capability_stage_id: anchor.state.dispatch_capability?.issued_for?.stage_cursor ?? null,
    checkpoint_ref: checkpointRef,
    trusted_answer_ref: trustedAnswerRef,
    checkpoint_policy: policy,
    checkpoint_rule: policy.rules[checkpointRef] ?? null,
    trusted_answer: answer,
    trusted_proof: proof,
    constitution_binding: anchor.state.specification?.constitution_binding ?? null,
    root_binding: {
      pinned_root: { canonical_path: pinnedRoot.canonical_root, dev: pinnedRoot.dev, ino: pinnedRoot.ino },
      workspace_root: anchor.state.specification?.project_root_identity ?? null,
    },
    mapping_id: record.mapping.mapping_id,
    mapping_hash: record.mapping.mapping_hash,
    mapping_version: record.mapping.mapping_version,
  });
}

function readDispatchAdmissionSnapshot(
  root: string,
  runId: string,
  mappingId: string,
  expectedMappingHash: string,
  pinnedRoot: PinnedProjectRoot,
  previous?: CtoDispatchAdmissionSnapshot,
  sessionId?: string,
): { ok: true; value: CtoDispatchAdmissionSnapshot } | { ok: false; error: string } {
  if (!pinnedRoot.isStable()) return { ok: false, error: "project root changed before dispatch admission snapshot" };
  const loaded = readMappingRecord(root, runId, mappingId, pinnedRoot);
  if (!loaded.ok) return loaded;
  const execution = activeCtoExecutionContext(root, runId, pinnedRoot, sessionId);
  if (!execution.ok) return execution;
  if (loaded.value.mapping.mapping_hash !== expectedMappingHash) return { ok: false, error: "expected mapping hash mismatch during dispatch admission" };
  if (mappingConfirmationRequired(loaded.value)) return { ok: false, error: "mapping confirmation is required before execution dispatch" };
  const context = loaded.value.confirmation_context!;
  const anchor = readPinnedFeatureState(root, context.feature_id, context.run_key, pinnedRoot);
  if (!anchor.ok) return anchor;
  const validationError = dispatchAdmissionError(loaded.value, execution.value, anchor.value, runId, { canonical_root: pinnedRoot.canonical_root, dev: pinnedRoot.dev, ino: pinnedRoot.ino }, pinnedRoot);
  if (validationError) return { ok: false, error: validationError };
  const authorizationProjectionDigest = dispatchAuthorizationProjectionDigest(loaded.value, execution.value, anchor.value, pinnedRoot);
  if (!authorizationProjectionDigest) return { ok: false, error: "confirmation authorization projection is unavailable" };
  if (previous) {
    if (loaded.value.record_digest !== previous.record.record_digest
      || loaded.value.record_path !== previous.record.record_path
      || loaded.value.mapping.mapping_id !== previous.record.mapping.mapping_id
      || loaded.value.mapping.mapping_hash !== previous.record.mapping.mapping_hash) {
      return { ok: false, error: "canonical mapping record changed after dispatch admission" };
    }
    if (authorizationProjectionDigest !== previous.authorization_projection_digest) {
      return { ok: false, error: "confirmation anchor authorization projection changed after dispatch admission" };
    }
    if (!sameExecutionContext(execution.value, previous.execution)) return { ok: false, error: "active CTO execution wave/capability changed after dispatch admission" };
  }
  if (!pinnedRoot.isStable()) return { ok: false, error: "project root changed after dispatch admission snapshot" };
  return { ok: true, value: { record: loaded.value, execution: execution.value, anchor: anchor.value, authorization_projection_digest: authorizationProjectionDigest } };
}

function activeCtoExecutionContext(root: string, ctoRunId: string, pinnedRoot: PinnedProjectRoot, sessionId?: string): { ok: true; value: CtoExecutionContext } | { ok: false; error: string } {
  if (!pinnedRoot.isStable()) return { ok: false, error: "project root changed while reading the active CTO execution context" };
  const state = readCtoStatePinned(ctoRunId, pinnedRoot);
  if (!state || state.id !== ctoRunId) return { ok: false, error: "an existing canonical CtoState for the exact run is required" };
  if (isCtoRunTerminal(state)) return { ok: false, error: "the canonical CTO run is terminal" };
  if (sessionId !== undefined && (state.standby === true || state.owner_session !== sessionId)) return { ok: false, error: "the active CTO run owner session does not match the authenticated host session" };
  const wave = state.wave_history?.find((candidate) => candidate.id === state.active_wave_id);
  if (!wave || wave.status !== "active" || wave.source !== "specification-execution" || typeof wave.source_id !== "string" || !isSafeCtoExecutionId(wave.source_id)) return { ok: false, error: "an active engine-issued specification execution wave is required; preparation waves cannot execute" };
  const identity = wave.work_identity;
  const ownerSession = state.standby === true ? null : state.owner_session ?? null;
  if (ownerSession === null) return { ok: false, error: "the active execution wave has no authenticated owner session" };
  const ownerIdentityBound = sessionId !== undefined
    && state.work_identity !== undefined
    && canonicalJson(state.work_identity) === canonicalJson(identity)
    && validateTypedControlPlane({ work_identity: state.work_identity, pending: state.pending, completion_envelope: state.completion_envelope }).ok;
  if (!identity || identity.session_id !== ownerSession || identity.run_id !== ctoRunId || identity.wave_id !== wave.id || identity.stage_id !== "execution" || identity.stage_cursor !== "execution"
    || !wave.slice_ids.includes(identity.slice_id)
    || typeof identity.capability_id !== "string" || identity.capability_id.trim().length === 0
    || typeof identity.capability_epoch !== "string" || identity.capability_epoch.trim().length === 0
    || (sessionId !== undefined && (!ownerIdentityBound || identity.session_id !== sessionId))) {
    return { ok: false, error: "the active execution wave lacks an exact run/wave/capability identity" };
  }
  return { ok: true, value: { state, wave_id: wave.id, source_id: wave.source_id, stage_id: identity.stage_id, capability_id: identity.capability_id, capability_epoch: identity.capability_epoch } };
}

function conformanceCtoExecutionContext(
  root: string,
  ctoRunId: string,
  mapping: CtoSpecificationMapping,
  pinnedRoot: PinnedProjectRoot,
): { ok: true; value: CtoExecutionContext } | { ok: false; error: string } {
  if (!pinnedRoot.isStable()) return { ok: false, error: "project root changed while reading the CTO conformance execution context" };
  const state = readCtoStatePinned(ctoRunId, pinnedRoot);
  if (!state || state.id !== ctoRunId) return { ok: false, error: "an existing canonical CtoState for the exact run is required" };
  const execution = (mapping as CtoSpecificationMapping & {
    execution?: { choice?: string; wave_id?: string; source_id?: string; capability_id?: string; capability_epoch?: string };
  }).execution;
  if (!execution || execution.choice !== "cto" || typeof execution.wave_id !== "string" || typeof execution.source_id !== "string"
    || typeof execution.capability_id !== "string" || typeof execution.capability_epoch !== "string"
    || !isSafeCtoExecutionId(execution.wave_id) || !isSafeCtoExecutionId(execution.source_id)) {
    return { ok: false, error: "confirmed mapping lacks an exact CTO execution identity" };
  }
  const wave = state.wave_history?.find((candidate) => candidate.id === execution.wave_id);
  if (!wave || wave.source !== "specification-execution" || (wave.status !== "active" && wave.status !== "done") || wave.source_id !== execution.source_id) {
    return { ok: false, error: "confirmed mapping is not bound to an active or terminal CTO execution wave" };
  }
  const identity = wave.work_identity;
  const ownerSession = state.standby === true ? null : state.owner_session ?? null;
  if (!identity || ownerSession === null || identity.session_id !== ownerSession || identity.run_id !== ctoRunId || identity.wave_id !== wave.id || identity.stage_id !== "execution" || identity.stage_cursor !== "execution"
    || typeof identity.capability_id !== "string" || typeof identity.capability_epoch !== "string"
    || identity.capability_id !== execution.capability_id || identity.capability_epoch !== execution.capability_epoch) {
    return { ok: false, error: "the CTO conformance wave lacks an exact run/wave/capability identity" };
  }
  if (!pinnedRoot.isStable()) return { ok: false, error: "project root changed while reading the CTO conformance execution context" };
  return {
    ok: true,
    value: {
      state,
      wave_id: wave.id,
      source_id: wave.source_id,
      stage_id: identity.stage_id,
      capability_id: identity.capability_id,
      capability_epoch: identity.capability_epoch,
    },
  };
}

function executionSlicesError(context: CtoExecutionContext, mapping: CtoSpecificationMapping): string | null {
  const wave = context.state.wave_history?.find((candidate) => candidate.id === context.wave_id)!;
  for (const decision of mapping.parallelization) {
    if (wave.slice_ids.filter((sliceId) => sliceId === decision.slice_id).length !== 1) return `slice '${decision.slice_id}' is not uniquely admitted by the active execution wave`;
    const teams = context.state.teams.filter((team) => team.slice_id === decision.slice_id);
    if (teams.length !== 1) return `slice '${decision.slice_id}' does not have exactly one canonical owner`;
    const team = teams[0]!;
    const owners = mapping.task_to_slice.filter((owner) => owner.slice_id === decision.slice_id);
    if (owners.length !== 1) return `slice '${decision.slice_id}' does not have exactly one mapping owner`;
    const owner = owners[0]!;
    if (owner.team_id !== team.id
      || owner.feature_id !== team.feature_id
      || owner.task_id !== team.task_id) {
      return `slice '${decision.slice_id}' mapping owner does not match the canonical team`;
    }
    const identity = team.work_identity;
    const ownerSession = context.state.standby === true ? null : context.state.owner_session ?? null;
    if (!identity || ownerSession === null || identity.session_id !== ownerSession || identity.run_id !== context.state.id || identity.wave_id !== context.wave_id || identity.slice_id !== decision.slice_id
      || identity.task_id !== owner.task_id
      || identity.stage_id !== "execution" || identity.stage_cursor !== "execution"
      || identity.capability_id !== context.capability_id || identity.capability_epoch !== context.capability_epoch) {
      return `slice '${decision.slice_id}' is not bound to the active execution capability`;
    }
  }
  return null;
}

/** Persist a fail-closed stale projection after imported source revalidation fails. */
function persistImportedWorkspaceStale(root: string, workspace: FeatureWorkspace, findings: ReadonlyArray<{ code: string; message: string }>, pinnedRoot?: PinnedProjectRoot): string[] {
  const detail = findings.map((finding) => `${finding.code}: ${finding.message}`).join("; ");
  const reason = `Imported handoff revalidation failed: ${detail || "source or snapshot binding changed"}`.slice(0, 512);
  const stale: FeatureWorkspace = { ...workspace, status: "stale", next_action: { kind: "remediation", command: null, reason } };
  const persisted = persistFeatureWorkspace(root, stale, pinnedRoot ? workspaceSnapshotForPinnedRoot(pinnedRoot) : undefined, { expected_workspace_digest: digestOf(workspace) });
  return persisted.ok ? [] : [`workspace stale state could not be persisted: ${persisted.error}`];
}

function derivePreflightRetry(
  root: string,
  ctoRunId: string,
  selections: readonly CtoSpecificationExecutionSelection[],
  pinnedRoot: PinnedProjectRoot,
): {
  eligible_selections: CtoSpecificationExecutionSelection[];
  excluded: Array<{ feature_id: string; run_key: string; findings: string[] }>;
} {
  const eligible_selections: CtoSpecificationExecutionSelection[] = [];
  const excluded: Array<{ feature_id: string; run_key: string; findings: string[] }> = [];
  const seenSelectors = new Set<string>();
  for (const selection of selections) {
    const selectorKey = JSON.stringify({ feature_id: selection.feature_id, run_key: selection.run_key });
    if (seenSelectors.has(selectorKey)) continue;
    seenSelectors.add(selectorKey);
    const single = domainPreflightPinned(root, pinnedRoot, {
      cto_run_id: ctoRunId,
      selections: [selection],
    });
    const findings = single.status === "blocked" ? [...single.findings] : [];
    if (single.status === "ready") {
      const claim = readCurrentExecutionClaim(root, selection.feature_id, pinnedRoot);
      if (!claim.ok) {
        findings.push(`${claim.code}: ${claim.error}`);
      } else if (claim.value && isLiveExecutionClaim(claim.value)) {
        findings.push(`execution claim conflict for '${selection.feature_id}': ${claim.value.owner_kind} owner '${claim.value.owner_run_id}' holds claim '${claim.value.claim_id}'`);
      }
    }
    if (findings.length > 0) {
      excluded.push({ feature_id: selection.feature_id, run_key: selection.run_key, findings });
    } else {
      eligible_selections.push({ ...selection });
    }
  }
  return { eligible_selections, excluded };
}

/** Preflight, revalidate, freeze, and atomically persist one exact mapping per CTO run. */
async function preflightCtoSpecificationExecutionUnlocked(projectRoot: string, input: CtoSpecificationExecutionPreflightInput, pinnedRoot: PinnedProjectRoot, assertRuntimeLive: () => void, sessionId?: string): Promise<CtoSpecificationExecutionPreflightResult> {
  assertRuntimeLive();
  if (!pinnedRoot.isStable()) return blockedExecution(["project root changed before CTO preflight"]);
  const root = pinnedRoot.canonical_root;
  if (!input || typeof input.cto_run_id !== "string" || !isSafeCtoRunId(input.cto_run_id)) return blockedExecution(["cto_run_id must be a safe non-empty string"]);
  const ownerExecution = activeCtoExecutionContext(root, input.cto_run_id, pinnedRoot, sessionId);
  if (!ownerExecution.ok) return blockedExecution([ownerExecution.error]);
  try {
    assertRuntimeLive();
    recoverPendingMappingTransactions(root, input.cto_run_id, pinnedRoot);
  } catch (error) {
    return blockedExecution([`mapping recovery failed: ${error instanceof Error ? error.message : String(error)}`]);
  }
  let execution = activeCtoExecutionContext(root, input.cto_run_id, pinnedRoot, sessionId);
  if (!execution.ok) return blockedExecution([execution.error]);
  const selections: CtoSpecificationExecutionSelection[] = Array.isArray(input.selections)
    ? input.selections.map((selection) => ({ ...selection }))
    : [];
  const result = domainPreflight(root, { cto_run_id: input.cto_run_id, selections });
  if (!pinnedRoot.isStable()) return blockedExecution(["project root changed during CTO preflight validation"]);
  if (result.status !== "ready") {
    const retry = derivePreflightRetry(root, input.cto_run_id, selections, pinnedRoot);
    const excludedFindings = retry.excluded.flatMap((selection) => selection.findings);
    const findings = [...result.findings, ...excludedFindings.filter((finding) => !result.findings.includes(finding))];
    return {
      ...result,
      findings,
      eligible_selections: retry.eligible_selections,
      excluded: retry.excluded,
      ...(retry.eligible_selections.length > 0
        ? {
          required_next_tool: {
            name: "cto_preflight" as const,
            arguments: {
              cto_run_id: input.cto_run_id,
              selections: retry.eligible_selections.map((selection) => ({ ...selection })),
            },
          },
        }
        : {}),
    };
  }

  const frozen: Array<{ feature_id: string; run_key: string; handoff: ImplementationHandoff }> = [];
  for (const selection of selections) {
    const loaded = loadHandoff(root, selection, undefined, pinnedRoot);
    if (!loaded.ok) return blockedExecution([loaded.error]);
    let handoff = loaded.handoff;
    if (loaded.workspace.source_kind === "external" || handoff.source_kind === "external") {
      const binding = loaded.workspace.constitution_binding;
      if (!binding) return blockedExecution([`constitution binding for '${selection.feature_id}' is missing`]);
      const revalidationInput: ImportedHandoffFilesystemDispatchInput = {
        handoff,
        project_root: root,
        run_key: selection.run_key,
        constitution_binding: binding,
        pinned_root: pinnedRoot,
      };
      if (!pinnedRoot.isStable()) return blockedExecution([`${selection.feature_id}: project root changed before imported handoff revalidation`]);
      const revalidated = await revalidateImportedHandoffForDispatch(revalidationInput);
      assertRuntimeLive();
      if (!pinnedRoot.isStable()) return blockedExecution([`${selection.feature_id}: project root changed during imported handoff revalidation`]);
      const refreshedExecution = activeCtoExecutionContext(root, input.cto_run_id, pinnedRoot, sessionId);
      if (!refreshedExecution.ok) return blockedExecution([refreshedExecution.error]);
      if (!sameExecutionContext(execution.value, refreshedExecution.value)) return blockedExecution(["active CTO execution wave/capability changed during handoff revalidation"]);
      execution = refreshedExecution;
      if (!revalidated.ok) {
        assertRuntimeLive();
        const persistErrors = persistImportedWorkspaceStale(root, loaded.workspace, revalidated.findings, pinnedRoot);
        const findings = revalidated.findings.map((finding) => `${finding.code}: ${finding.message}`);
        return blockedExecution([`${selection.feature_id}: ${findings.join("; ") || "external source binding changed"}`, ...persistErrors]);
      }
      handoff = revalidated.handoff;
    }
    // Even native handoffs cross this await seam so future async validators
    // exercise the same post-await wave/capability revalidation.
    await ctoExecutionAwaitBoundary(root, pinnedRoot, input.cto_run_id);
    assertRuntimeLive();
    if (!pinnedRoot.isStable()) return blockedExecution([`${selection.feature_id}: project root changed after execution await`]);
    const postAwaitExecution = activeCtoExecutionContext(root, input.cto_run_id, pinnedRoot, sessionId);
    if (!postAwaitExecution.ok) return blockedExecution([postAwaitExecution.error]);
    if (!sameExecutionContext(execution.value, postAwaitExecution.value)) return blockedExecution(["active CTO execution wave/capability changed after execution await"]);
    execution = postAwaitExecution;
    // This reload is deliberately after the final awaited rehash. A valid
    // handoff rewrite during that await must invalidate the frozen mapping.
    const finalLoaded = loadHandoff(root, selection, loaded.handoff.handoff_digest, pinnedRoot);
    if (!finalLoaded.ok) {
      assertRuntimeLive();
      const persistErrors = persistImportedWorkspaceStale(root, loaded.workspace, [{ code: "SPEC_HANDOFF_STALE", message: finalLoaded.error }], pinnedRoot);
      return blockedExecution([finalLoaded.error, ...persistErrors]);
    }
    if (digestOf(finalLoaded.workspace) !== digestOf(loaded.workspace)) {
      assertRuntimeLive();
      const persistErrors = persistImportedWorkspaceStale(root, finalLoaded.workspace, [{ code: "SPEC_HANDOFF_STALE", message: "workspace changed after source revalidation" }], pinnedRoot);
      return blockedExecution([`${selection.feature_id}: workspace changed after source revalidation`, ...persistErrors]);
    }
    if (!pinnedRoot.isStable()) return blockedExecution([`${selection.feature_id}: project root changed after imported handoff revalidation`]);
    handoff = finalLoaded.handoff;
    frozen.push({ feature_id: selection.feature_id, run_key: selection.run_key, handoff });
  }
  let exactMapping: CtoSpecificationMapping;
  try {
    exactMapping = buildCtoSpecificationMapping({
      cto_run_id: input.cto_run_id,
      execution: { wave_id: execution.value.wave_id, source_id: execution.value.source_id, capability_id: execution.value.capability_id, capability_epoch: execution.value.capability_epoch, choice: "cto" },
      selections: frozen,
    });
  } catch (error) {
    return blockedExecution([`mapping construction failed: ${error instanceof Error ? error.message : String(error)}`]);
  }
  const sliceError = executionSlicesError(execution.value, exactMapping);
  if (sliceError) return blockedExecution([sliceError]);
  const initialFile = mappingPath(root, input.cto_run_id, exactMapping.mapping_id, pinnedRoot);
  if (!initialFile) return blockedExecution(["canonical mapping path is unsafe"]);
  if (!pinnedRoot.isStable()) return blockedExecution(["project root changed before mapping read"]);
  const existing = readMappingRecord(root, input.cto_run_id, exactMapping.mapping_id, pinnedRoot);
  if (existing.ok) {
    if (!sameSelections(existing.value.selections, selections) || !sameFrozenMapping(existing.value.mapping, exactMapping)) return blockedExecution(["mapping identity conflict: an existing mapping has different explicit selections, execution context, or frozen bindings"]);
    if (!pinnedRoot.isStable()) return blockedExecution(["project root changed before returning existing mapping"]);
    return { status: "ready", mapping: existing.value.mapping, findings: [], dispatched: false };
  }
  if (pinnedRoot.pathEntryExists(pinnedRelativePath(pinnedRoot, initialFile))) return blockedExecution([existing.error]);
  try {
    if (!pinnedRoot.isStable()) return blockedExecution(["project root changed before mapping persistence"]);
    assertRuntimeLive();
    pinnedRoot.ensureDirectory(pinnedRelativePath(pinnedRoot, join(root, ".work-state", "cto", input.cto_run_id, "specification-mappings")));
    const file = mappingPath(root, input.cto_run_id, exactMapping.mapping_id, pinnedRoot);
    if (!file) return blockedExecution(["canonical mapping directory became unsafe before persistence"]);
    const record: CtoSpecificationMappingRecord = { schema_version: 1, cto_run_id: input.cto_run_id, mapping: exactMapping, selections, checkpoint_ref: null, trusted_answer_ref: null };
    const serialized = mappingRecordContentError(record, input.cto_run_id, exactMapping.mapping_id);
    if (serialized.error) return blockedExecution([`mapping record is invalid before persistence: ${serialized.error}`]);
    if (!pinnedRoot.isStable()) return blockedExecution(["project root changed before mapping write"]);
    findCtoHook(ctoSpecificationExecutionTestHooksByRoot, root, pinnedRoot)?.beforeMappingWrite?.({
      root,
      cto_run_id: input.cto_run_id,
      mapping_id: exactMapping.mapping_id,
      operation: "preflight",
    });
    const finalConstitutionError = refreshCtoMappingConstitutions(root, record, pinnedRoot);
    if (finalConstitutionError) return blockedExecution([finalConstitutionError]);
    if (!pinnedRoot.isStable()) return blockedExecution(["project root changed immediately before mapping write"]);
    const mappingRelativePath = pinnedRelativePath(pinnedRoot, file);
    const firstSelection = record.selections[0];
    if (!firstSelection) return blockedExecution(["mapping has no exact frozen selection"]);
    const selectedState = readPinnedFeatureState(root, firstSelection.feature_id, firstSelection.run_key, pinnedRoot);
    if (!selectedState.ok) return blockedExecution([selectedState.error]);
    const transaction = createDirectMappingTransaction(
      "preflight",
      input.cto_run_id,
      record,
      file,
      "absent",
      null,
      serialized.content,
      selectedState.value,
    );
    assertRuntimeLive();
    const persistedTransaction: MappingTransactionWithWalReceipt = { ...transaction, wal_receipt: persistMappingTransactionPinned(pinnedRoot, root, transaction) };
    assertRuntimeLive();
    injectMappingFailure(root, pinnedRoot, "before_mapping_write", transaction.transaction_id);
    assertRuntimeLive();
    pinnedRoot.writeExclusive(mappingRelativePath, serialized.content);
    // This seam models a process crash in the interval where deterministic
    // mapping bytes are visible but post-write validation has not run yet.
    injectMappingFailure(root, pinnedRoot, "after_mapping_write", `preflight-${exactMapping.mapping_id}`);
    if (!pinnedRoot.isStable()) return blockedExecution(["project root changed after mapping write"]);
    const createdMapping = readPinnedRegularFile(pinnedRoot, file, MAX_CTO_MAPPING_RECORD_BYTES);
    if (!createdMapping.ok) return blockedExecution([`mapping write could not be reread: ${createdMapping.error}`]);
    const postWriteConstitutionError = refreshCtoMappingConstitutions(root, record, pinnedRoot);
    if (postWriteConstitutionError) {
      try {
        assertRuntimeLive();
        commitDirectMappingTransactionPinned(root, persistedTransaction, pinnedRoot);
      } catch (error) {
        return blockedExecution([error instanceof Error ? error.message : String(error)]);
      }
      return blockedExecution([postWriteConstitutionError]);
    }
    assertRuntimeLive();
    removeMappingTransactionPinned(pinnedRoot, mappingTransactionPath(transaction, pinnedRoot), persistedTransaction.wal_receipt);
    return { status: "ready", mapping: exactMapping, findings: [], dispatched: false };
  } catch (error) {
    return blockedExecution([`mapping persistence failed: ${error instanceof Error ? error.message : String(error)}`]);
  }
}

export async function preflightCtoSpecificationExecution(projectRoot: string, input: CtoSpecificationExecutionPreflightInput, options: CtoSpecificationRuntimeMutationOptions): Promise<CtoSpecificationExecutionPreflightResult> {
  const pinnedRoot = PinnedProjectRoot.open(projectRoot);
  if (!pinnedRoot) return blockedExecution(["project root is missing or cannot be canonicalized"]);
  const root = pinnedRoot.canonical_root;
  const assertRuntimeLive = () => assertCtoSpecificationRuntime(options, root, pinnedRoot);
  try {
    assertRuntimeLive();
    if (!pinnedRoot.isStable()) return blockedExecution(["project root changed before CTO preflight"]);
    if (!input || typeof input.cto_run_id !== "string" || !isSafeCtoRunId(input.cto_run_id)) return blockedExecution(["cto_run_id must be a safe non-empty string"]);
    const ownerExecution = activeCtoExecutionContext(root, input.cto_run_id, pinnedRoot, options.sessionId);
    if (!ownerExecution.ok) return blockedExecution([ownerExecution.error]);
    try {
      assertRuntimeLive();
      recoverPendingMappingTransactions(root, input.cto_run_id, pinnedRoot);
    } catch (error) {
      return blockedExecution([`mapping recovery failed: ${error instanceof Error ? error.message : String(error)}`]);
    }
    assertRuntimeLive();
    const constitutionFindings = ensureCtoExecutionConstitutions(root, Array.isArray(input.selections) ? input.selections : [], pinnedRoot);
    if (constitutionFindings.length > 0) return blockedExecution(constitutionFindings);
    assertRuntimeLive();
    const result = await withCtoRunLockAsync(root, input.cto_run_id, () => {
      assertRuntimeLive();
      return preflightCtoSpecificationExecutionUnlocked(root, input, pinnedRoot, assertRuntimeLive, options.sessionId);
    }, { pinnedRoot });
    if (!pinnedRoot.isStable()) return blockedExecution(["project root changed during CTO preflight"]);
    assertRuntimeLive();
    return result;
  } catch (error) {
    if (!pinnedRoot.isStable()) return blockedExecution(["project root changed during CTO preflight"]);
    return blockedExecution([`mapping transaction lock failed: ${error instanceof Error ? error.message : String(error)}`]);
  } finally {
    pinnedRoot.close();
  }
}

export function deriveCtoSpecificationMappingAskInput(
  projectRoot: string,
  base: { cto_run_id: string; mapping_id: string; mapping_hash: string },
): CtoSpecificationMappingAskPreparationResult {
  const pinnedRoot = PinnedProjectRoot.open(projectRoot);
  if (!pinnedRoot) return blockedCtoMappingAsk("project root is missing or cannot be canonicalized");
  const root = pinnedRoot.canonical_root;
  try {
    if (!isSafeCtoRunId(base?.cto_run_id)
      || !isSafeCtoExecutionId(base?.mapping_id)
      || !isSha256Hex(base?.mapping_hash)) {
      return blockedCtoMappingAsk("mapping Ask requires an exact safe CTO run, mapping selector, and lowercase SHA-256 mapping hash");
    }
    return withCtoRunLock(root, base.cto_run_id, () => {
      recoverPendingMappingTransactions(root, base.cto_run_id, pinnedRoot);
      const loaded = readMappingRecord(root, base.cto_run_id, base.mapping_id, pinnedRoot);
      if (!loaded.ok) return blockedCtoMappingAsk(loaded.error);
      const record = loaded.value;
      if (record.mapping.mapping_hash !== base.mapping_hash) return blockedCtoMappingAsk("mapping hash mismatch");
      if (record.mapping.status !== "awaiting_confirmation") return blockedCtoMappingAsk(`mapping is not awaiting confirmation (status '${record.mapping.status}')`);
      const selection = record.selections[0];
      if (!selection) return blockedCtoMappingAsk("mapping has no exact frozen selection");
      const execution = activeCtoExecutionContext(root, base.cto_run_id, pinnedRoot);
      if (!execution.ok) return blockedCtoMappingAsk(execution.error);
      const selectedRead = readPinnedFeatureState(root, selection.feature_id, selection.run_key, pinnedRoot);
      if (!selectedRead.ok) return blockedCtoMappingAsk(selectedRead.error);
      const selectedConstitution = readCtoSelectedConstitution(root, selection.feature_id, selection.run_key, pinnedRoot);
      if (!selectedConstitution.ok) return blockedCtoMappingAsk(selectedConstitution.error);
      const stageId = execution.value.stage_id;
      if (typeof stageId !== "string" || stageId.trim().length === 0) return blockedCtoMappingAsk("active CTO execution has no exact stage selector");
      const questionId = ctoMappingQuestionId(base.cto_run_id, base.mapping_id, record.mapping.mapping_version);
      return {
        status: "ready",
        cto_run_id: base.cto_run_id,
        mapping_id: base.mapping_id,
        mapping_hash: base.mapping_hash,
        mapping_version: record.mapping.mapping_version,
        feature_id: selection.feature_id,
        run_key: selection.run_key,
        stage_id: stageId,
        question_id: questionId,
        question: `Review CTO mapping ${base.mapping_id} revision ${record.mapping.mapping_version} (${base.mapping_hash}).\nfeature_id=${selection.feature_id} | run_key=${selection.run_key} | stage_id=${execution.value.stage_id} | checkpoint_id=cto_mapping_confirmation | semantic_identity=cto_mapping_confirmation\nSelect exactly one: approve_continue, request_changes, or approve_stop.`,
        allowed_decisions: ["approve_continue", "request_changes", "approve_stop"],
      };
    }, { pinnedRoot });
  } catch (error) {
    return blockedCtoMappingAsk(`mapping Ask selector derivation failed: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    pinnedRoot.close();
  }
}

type CtoMappingAskContext = {
  record: CtoSpecificationMappingRecord & { record_digest: string; record_path: string };
  execution: CtoExecutionContext;
  selected: PinnedFeatureStateRead;
};

function blockedCtoMappingAsk(...findings: string[]): { status: "blocked"; dispatched: false; findings: string[] } {
  return { status: "blocked", dispatched: false, findings };
}

/** Fail closed unless the caller still owns the exact authenticated runtime. */
function assertCtoSpecificationRuntime(
  options: CtoSpecificationRuntimeMutationOptions,
  root: string,
  pinnedRoot: PinnedProjectRoot,
): void {
  if (!options || typeof options !== "object" || !options.runtimeAccess || !isSafeCtoRuntimeSessionId(options.sessionId)) {
    throw new Error("recovery_required: authenticated CTO runtime access and session are required");
  }
  assertCtoRuntimeAccessFacadeLive(options.runtimeAccess, root, options.sessionId);
  options.runtimeAccess.assertProjectRoot(root);
  options.runtimeAccess.assertLive();
  if (!pinnedRoot.isStable()) throw new Error("project root changed while authenticating CTO runtime");
}

function ctoMappingQuestionId(ctoRunId: string, mappingId: string, mappingVersion: number): string {
  return `cto:${ctoRunId}:${mappingId}:${mappingVersion}`;
}

function ctoMappingCheckpoint(
  input: CtoSpecificationMappingAskInput,
  execution: CtoExecutionContext,
  decision: "approve_continue" | "request_changes" | "approve_stop",
): string {
  return `cto-specification-mapping-${digestOf({
    cto_run_id: input.cto_run_id,
    mapping_id: input.mapping_id,
    mapping_hash: input.mapping_hash,
    feature_id: input.feature_id,
    run_key: input.run_key,
    stage_id: input.stage_id,
    mapping_version: input.mapping_version,
    decision,
    capability_id: execution.capability_id,
    capability_epoch: execution.capability_epoch,
  })}`;
}

function resolveCtoMappingAskContext(
  root: string,
  input: CtoSpecificationMappingAskInput,
  pinnedRoot: PinnedProjectRoot,
  decision?: CtoSpecificationMappingReviewDecision,
  assertRuntimeLive?: () => void,
  sessionId?: string,
): { ok: true; value: CtoMappingAskContext } | { ok: false; error: string } {
  assertRuntimeLive?.();
  if (!pinnedRoot.isStable()) return { ok: false, error: "project root changed before CTO mapping Ask" };
  try {
    assertRuntimeLive?.();
    recoverPendingMappingTransactions(root, input.cto_run_id, pinnedRoot);
  } catch (error) {
    return { ok: false, error: `mapping recovery failed: ${error instanceof Error ? error.message : String(error)}` };
  }
  const loaded = readMappingRecord(root, input.cto_run_id, input.mapping_id, pinnedRoot);
  if (!loaded.ok) return loaded;
  const record = loaded.value;
  if (record.mapping.mapping_hash !== input.mapping_hash) return { ok: false, error: "mapping hash mismatch" };
  if (record.mapping.mapping_version !== input.mapping_version) return { ok: false, error: "mapping revision mismatch" };
  const reviewReplay = record.review !== undefined
    && decision !== undefined
    && record.review.decision === decision
    && record.mapping.status === (decision === "request_changes" ? "revision_required" : decision === "approve_stop" ? "stopped" : "awaiting_confirmation");
  if (record.mapping.status !== "awaiting_confirmation" && !reviewReplay) {
    return { ok: false, error: `mapping is not awaiting confirmation (status '${record.mapping.status}')` };
  }
  if (record.mapping.status === "awaiting_confirmation" && record.mapping.checkpoint_ref !== null) return { ok: false, error: "awaiting mapping carries an unexpected checkpoint reference" };
  const firstSelection = record.selections[0];
  if (!firstSelection || firstSelection.feature_id !== input.feature_id || firstSelection.run_key !== input.run_key) {
    return { ok: false, error: "mapping Ask feature/run must match the first exact frozen selection" };
  }
  const execution = activeCtoExecutionContext(root, input.cto_run_id, pinnedRoot, sessionId);
  if (!execution.ok) return execution;
  const frozenExecution = (record.mapping as CtoSpecificationMapping & { execution?: { wave_id?: string; source_id?: string; capability_id?: string; capability_epoch?: string } }).execution;
  const activeWave = execution.value.state.wave_history?.find((candidate) => candidate.id === execution.value.wave_id);
  const admittedSlices = record.mapping.parallelization.map((decision) => decision.slice_id);
  if (!frozenExecution
    || !ctoMappingTeamBindingsMatchExecution(record.mapping, execution.value, record.selections)
    || !ctoMappingExecutionMatchesWave(
      frozenExecution,
      activeWave,
      input.cto_run_id,
      admittedSlices,
      execution.value.state.teams.map((team) => team.work_identity),
    )) {
    return { ok: false, error: "mapping execution capability or source identity is stale or mismatched" };
  }
  const selected = readPinnedFeatureState(root, input.feature_id, input.run_key, pinnedRoot);
  if (!selected.ok) return selected;
  const selectedConstitution = readCtoSelectedConstitution(root, input.feature_id, input.run_key, pinnedRoot);
  if (!selectedConstitution.ok) return selectedConstitution;
  if (input.stage_id !== execution.value.stage_id) return { ok: false, error: "mapping Ask stage selector is stale or mismatched" };
  return { ok: true, value: { record, execution: execution.value, selected: selected.value } };
}

export function prepareCtoSpecificationMappingAsk(
  projectRoot: string,
  input: CtoSpecificationMappingAskInput,
  options: CtoSpecificationRuntimeMutationOptions,
): CtoSpecificationMappingAskPreparationResult {
  const pinnedRoot = PinnedProjectRoot.open(projectRoot);
  if (!pinnedRoot) return blockedCtoMappingAsk("project root is missing or cannot be canonicalized");
  const root = pinnedRoot.canonical_root;
  const assertRuntimeLive = () => assertCtoSpecificationRuntime(options, root, pinnedRoot);
  try {
    if (!isSafeCtoRunId(input?.cto_run_id) || !isSafeCtoExecutionId(input?.mapping_id)
      || !isSha256Hex(input?.mapping_hash)
      || !Number.isSafeInteger(input?.mapping_version) || input.mapping_version < 1
      || !isSafeFeatureId(input?.feature_id) || typeof input?.run_key !== "string" || input.run_key.trim().length === 0
      || typeof input?.stage_id !== "string" || input.stage_id.trim().length === 0) {
      return blockedCtoMappingAsk("mapping Ask requires explicit safe run/mapping/hash/revision/feature/run/stage selectors");
    }
    assertRuntimeLive();
    const ownerExecution = activeCtoExecutionContext(root, input.cto_run_id, pinnedRoot, options.sessionId);
    if (!ownerExecution.ok) return blockedCtoMappingAsk(ownerExecution.error);
    assertRuntimeLive();
    const constitutionFindings = ensureCtoExecutionConstitutions(root, [{ feature_id: input.feature_id, run_key: input.run_key }], pinnedRoot);
    if (constitutionFindings.length > 0) return blockedCtoMappingAsk(...constitutionFindings);
    assertRuntimeLive();
    return withCtoRunLock(root, input.cto_run_id, () => {
      assertRuntimeLive();
      const resolved = resolveCtoMappingAskContext(root, input, pinnedRoot, undefined, assertRuntimeLive, options.sessionId);
      if (!resolved.ok) return blockedCtoMappingAsk(resolved.error);
      const { record } = resolved.value;
      const questionId = ctoMappingQuestionId(input.cto_run_id, record.mapping.mapping_id, record.mapping.mapping_version);
      return {
        status: "ready",
        cto_run_id: input.cto_run_id,
        mapping_id: record.mapping.mapping_id,
        mapping_hash: record.mapping.mapping_hash,
        mapping_version: record.mapping.mapping_version,
        feature_id: input.feature_id,
        run_key: input.run_key,
        stage_id: input.stage_id,
        question_id: questionId,
        question: `Review CTO mapping ${record.mapping.mapping_id} revision ${record.mapping.mapping_version} (${record.mapping.mapping_hash}).\nfeature_id=${input.feature_id} | run_key=${input.run_key} | stage_id=${input.stage_id} | checkpoint_id=cto_mapping_confirmation | semantic_identity=cto_mapping_confirmation\nSelect exactly one: approve_continue, request_changes, or approve_stop.`,
        allowed_decisions: ["approve_continue", "request_changes", "approve_stop"],
      };
    }, { pinnedRoot });
  } catch (error) {
    return blockedCtoMappingAsk(`mapping Ask preparation failed: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    pinnedRoot.close();
  }
}

export function recordCtoSpecificationMappingAsk(
  projectRoot: string,
  input: CtoSpecificationMappingAskInput & { decision: "approve_continue" | "request_changes" | "approve_stop" },
  options: CtoSpecificationMappingAskHostOptions,
): CtoSpecificationMappingAskResult {
  const pinnedRoot = PinnedProjectRoot.open(projectRoot);
  if (!pinnedRoot) return blockedCtoMappingAsk("project root is missing or cannot be canonicalized");
  const root = pinnedRoot.canonical_root;
  const assertRuntimeLive = () => assertCtoSpecificationRuntime(options, root, pinnedRoot);
  try {
    if (!isSafeCtoRunId(input?.cto_run_id) || !isSafeCtoExecutionId(input?.mapping_id)
      || !isSha256Hex(input?.mapping_hash)
      || !Number.isSafeInteger(input?.mapping_version) || input.mapping_version < 1
      || !isSafeFeatureId(input?.feature_id) || typeof input?.run_key !== "string" || input.run_key.trim().length === 0
      || typeof input?.stage_id !== "string" || input.stage_id.trim().length === 0) {
      return blockedCtoMappingAsk("mapping Ask requires explicit safe run/mapping/hash/revision/feature/run/stage selectors");
    }
    assertRuntimeLive();
    const ownerExecution = activeCtoExecutionContext(root, input.cto_run_id, pinnedRoot, options.sessionId);
    if (!ownerExecution.ok) return blockedCtoMappingAsk(ownerExecution.error);
    if (!options.trusted_host || options.trusted_host.session_id !== options.sessionId) return blockedCtoMappingAsk("recovery_required: trusted host session does not match the authenticated CTO runtime session");
    if (input.decision === "request_changes" && !validCtoFeedback(input.feedback)) return blockedCtoMappingAsk("request_changes requires exact non-empty trusted feedback");
    if (input.decision !== "request_changes" && input.feedback !== undefined) return blockedCtoMappingAsk("feedback is only valid for request_changes");
    const constitutionFindings = ensureCtoExecutionConstitutions(root, [{ feature_id: input.feature_id, run_key: input.run_key }], pinnedRoot);
    if (constitutionFindings.length > 0) return blockedCtoMappingAsk(...constitutionFindings);
    assertRuntimeLive();
    return withCtoRunLock(root, input.cto_run_id, () => {
      assertRuntimeLive();
      const resolved = resolveCtoMappingAskContext(root, input, pinnedRoot, input.decision, assertRuntimeLive, options.sessionId);
      if (!resolved.ok) return blockedCtoMappingAsk(resolved.error);
      const { record, execution, selected } = resolved.value;
      const canonicalRecord = canonicalMappingRecord(record);
      const checkpointRef = ctoMappingCheckpoint({ ...input, mapping_version: record.mapping.mapping_version }, execution, input.decision);
      const existingRef = record.trusted_answer_ref ?? record.review?.trusted_answer_ref ?? null;
      const existingCheckpointRef = record.checkpoint_ref ?? record.review?.checkpoint_ref ?? null;
      if (existingCheckpointRef !== null || existingRef !== null) {
        if (!existingCheckpointRef || !existingRef || existingCheckpointRef !== checkpointRef) {
          return blockedCtoMappingAsk("mapping Ask replay has an incomplete or stale trusted-answer reference");
        }
        const existing = selected.state.trusted_checkpoint_answers?.find((answer) => answer.answer_id === existingRef);
        if (!existing || existing.decision !== input.decision || existing.feedback !== input.feedback || existing.checkpoint_id !== checkpointRef) {
          return blockedCtoMappingAsk("mapping Ask replay trusted answer is missing or mismatched");
        }
        const proof: CheckpointAnswerProof = {
          answer_id: existing.answer_id,
          nonce: existing.nonce,
          channel: existing.channel,
          reference: existing.reference,
          binding: existing.binding,
          ...(existing.feedback !== undefined ? { feedback: existing.feedback } : {}),
        };
        if (existing.subject_binding !== input.mapping_hash || existing.subject_revision !== input.mapping_version) {
          return blockedCtoMappingAsk("mapping Ask replay candidate digest or revision is stale");
        }
        const proofError = trustedCheckpointAnswerError(selected.state, {
          actor: { kind: "user", ref: existing.reference, proof },
          run_id: input.run_key,
          stage_id: input.stage_id,
          checkpoint_id: checkpointRef,
          decision: input.decision,
          feature_id: input.feature_id,
          capability_id: execution.capability_id,
          capability_epoch: execution.capability_epoch,
          subject_revision: input.mapping_version,
          feedback: input.feedback,
          root_identity: { canonical_root: root, dev: pinnedRoot.dev, ino: pinnedRoot.ino },
          bind_active_context: true,
        });
        if (proofError) return blockedCtoMappingAsk(`mapping Ask replay proof is invalid: ${proofError}`);
        return {
          status: "answered",
          dispatched: false,
          cto_run_id: input.cto_run_id,
          mapping_id: input.mapping_id,
          mapping_hash: input.mapping_hash,
          mapping_version: input.mapping_version,
          feature_id: input.feature_id,
          run_key: input.run_key,
          stage_id: input.stage_id,
          checkpoint_ref: checkpointRef,
          decision: input.decision,
          trusted_answer_ref: existing.answer_id,
          trusted_proof: proof,
          ...(existing.feedback !== undefined ? { feedback: existing.feedback } : {}),
        };
      }
      const currentPolicy = selected.state.checkpoint_policy;
      if (!currentPolicy) return blockedCtoMappingAsk("mapping Ask checkpoint policy is unavailable");
      const fallbackPolicy = nativeCheckpointPolicy("specification_phase_approval");
      const baseRule = Object.values(currentPolicy.rules).find((rule) => rule.kind === "specification_phase_approval")
        ?? fallbackPolicy.rules.specification_phase_approval;
      if (!baseRule) return blockedCtoMappingAsk("mapping Ask specification checkpoint rule is unavailable");
      const answerPolicy = {
        ...currentPolicy,
        default: "required_human" as const,
        hard_human: [...new Set([...currentPolicy.hard_human, "custom" as const])],
        rules: {
          ...currentPolicy.rules,
          [checkpointRef]: {
            ...baseRule,
            kind: "custom" as const,
            default: "required_human" as const,
            allowed_decisions: ["approve_continue", "request_changes", "approve_stop"],
          },
        },
      };
      const answerSourceState: TeamState = { ...selected.state, checkpoint_policy: answerPolicy };
      // recordTrustedCheckpointAnswer normalizes the supplied image in place;
      // retain the exact pre-answer semantic source for WAL validation.
      const answerSourceContent = JSON.stringify(answerSourceState);
      const answerSourceLogicalDigest = mappingStateDigest(answerSourceState);
      let recorded: ReturnType<typeof recordTrustedCheckpointAnswer>;
      try {
        assertRuntimeLive();
        if (!options.trusted_host) return blockedCtoMappingAsk("mapping Ask recovery_required: trusted host answer capability is unavailable; repeat the host Ask");
        const answerId = `cto-answer-${randomUUID()}`;
        const answerReference = `terminal:cto_checkpoint_ask_selected:${input.mapping_id}`;
        const capability = issueTrustedCheckpointAnswerCapability(options.trusted_host.bridge, {
          root: { canonical_root: root, dev: pinnedRoot.dev, ino: pinnedRoot.ino },
          state: answerSourceState,
          answer_id: answerId,
          channel: "terminal",
          reference: answerReference,
          actor_ref: answerReference,
          stage_id: input.stage_id,
          checkpoint_id: checkpointRef,
          decision: input.decision,
          ...(input.feedback !== undefined ? { feedback: input.feedback } : {}),
          feature_id: input.feature_id,
          subject_binding: input.mapping_hash,
          subject_revision: input.mapping_version,
          question: options.trusted_host.question,
          options: options.trusted_host.options,
          session_id: options.sessionId,
          profile_hash: answerSourceState.profile_hash,
        });
        recorded = recordTrustedCheckpointAnswer(
          answerSourceState,
          {
            answer_id: answerId,
            channel: "terminal",
            reference: answerReference,
            stage_id: input.stage_id,
            checkpoint_id: checkpointRef,
            decision: input.decision,
            feature_id: input.feature_id,
            subject_binding: input.mapping_hash,
            subject_revision: input.mapping_version,
            ...(input.feedback !== undefined ? { feedback: input.feedback } : {}),
          },
          { capability, root: { canonical_root: root, dev: pinnedRoot.dev, ino: pinnedRoot.ino } },
        );
      } catch (error) {
        return blockedCtoMappingAsk(`mapping Ask proof could not be minted: ${error instanceof Error ? error.message : String(error)}`);
      }
      const file = mappingPath(root, input.cto_run_id, input.mapping_id, pinnedRoot);
      if (!file) return blockedCtoMappingAsk("canonical mapping path is unsafe");
      const mappingRead = readPinnedRegularFile(pinnedRoot, file, MAX_CTO_MAPPING_RECORD_BYTES);
      if (!mappingRead.ok) return blockedCtoMappingAsk("canonical mapping changed before mapping Ask commit");
      const updated: CtoSpecificationMappingRecord = input.decision === "approve_continue"
        ? {
          ...canonicalRecord,
          checkpoint_ref: checkpointRef,
          trusted_answer_ref: recorded.answer.answer_id,
        }
        : {
          ...canonicalRecord,
          mapping: {
            ...record.mapping,
            status: input.decision === "request_changes" ? "revision_required" : "stopped",
            checkpoint_ref: null,
          },
          checkpoint_ref: null,
          trusted_answer_ref: null,
          review: {
            feature_id: input.feature_id,
            run_key: input.run_key,
            stage_id: input.stage_id,
            decision: input.decision,
            checkpoint_ref: checkpointRef,
            trusted_answer_ref: recorded.answer.answer_id,
            capability_id: recorded.answer.capability_id,
            capability_epoch: recorded.answer.capability_epoch,
            policy_hash: recorded.answer.policy_hash,
            ...(recorded.answer.feedback !== undefined ? { feedback: recorded.answer.feedback } : {}),
          },
        };
      const serialized = mappingRecordContentError(updated, input.cto_run_id, input.mapping_id);
      if (serialized.error) return blockedCtoMappingAsk(`mapping record is invalid before persistence: ${serialized.error}`);
      const mappingContent = serialized.content;
      const transaction: CtoSpecificationMappingTransaction = {
        schema_version: 1,
        transaction_id: randomUUID(),
        operation: "answer",
        cto_run_id: input.cto_run_id,
        mapping_id: input.mapping_id,
        mapping_hash: input.mapping_hash,
        feature_id: input.feature_id,
        run_key: input.run_key,
        mapping_path: file,
        mapping_before_disposition: "present",
        mapping_before_content: mappingRead.bytes.toString("utf8"),
        mapping_before_digest: sha256Hex(mappingRead.bytes.toString("utf8")),
        staged_mapping_identity: { mapping_id: input.mapping_id, mapping_hash: input.mapping_hash, content_digest: sha256Hex(mappingContent) },
        mapping_after_digest: sha256Hex(mappingContent),
        mapping_content: mappingContent,
        mapping: record.mapping,
        selections: record.selections.map((selection) => ({ ...selection })),
        state_path: selected.statePath,
        state_dir: selected.stateDir,
        artifacts_dir: selected.artifactsDir,
        is_legacy: selected.isLegacy,
        state_before_content: selected.bytes.toString("utf8"),
        state_before_digest: sha256Hex(selected.bytes.toString("utf8")),
        state_source_content: answerSourceContent,
        state_source_logical_digest: answerSourceLogicalDigest,
        state_after_digest: mappingStateDigest(recorded.state),
        state_transition: {
          kind: "record_checkpoint_answer",
          answer_id: recorded.answer.answer_id,
          stage_id: recorded.answer.stage_id,
          checkpoint_id: recorded.answer.checkpoint_id,
          decision: recorded.answer.decision,
          feature_id: recorded.answer.feature_id ?? input.feature_id,
          run_key: recorded.answer.run_id,
          ...(recorded.answer.subject_binding ? { subject_binding: recorded.answer.subject_binding } : {}),
          ...(recorded.answer.subject_revision !== undefined ? { subject_revision: recorded.answer.subject_revision } : {}),
          capability_id: recorded.answer.capability_id,
          capability_epoch: recorded.answer.capability_epoch,
          policy_hash: recorded.answer.policy_hash,
          ...(recorded.answer.feedback !== undefined ? { feedback: recorded.answer.feedback } : {}),
        },
        state: recorded.state,
        status: "pending",
      };
      assertRuntimeLive();
      const walConstitutionError = refreshCtoMappingTransactionConstitutions(root, transaction, pinnedRoot);
      if (walConstitutionError) return blockedCtoMappingAsk(walConstitutionError);
      try {
        assertRuntimeLive();
        const persistedTransaction: MappingTransactionWithWalReceipt = { ...transaction, wal_receipt: persistMappingTransactionPinned(pinnedRoot, root, transaction) };
        // The crash seam intentionally leaves the answer WAL durable before
        // commit; recovery must not mistake its JSON for host Ask authority.
        injectMappingFailure(root, pinnedRoot, "after_prepare", transaction.transaction_id);
        assertRuntimeLive();
        commitMappingTransactionPinned(root, persistedTransaction, pinnedRoot);
      } catch (error) {
        return blockedCtoMappingAsk(`mapping Ask persistence failed: ${error instanceof Error ? error.message : String(error)}`);
      }
      return {
        status: "answered",
        dispatched: false,
        cto_run_id: input.cto_run_id,
        mapping_id: input.mapping_id,
        mapping_hash: input.mapping_hash,
        mapping_version: input.mapping_version,
        feature_id: input.feature_id,
        run_key: input.run_key,
        stage_id: input.stage_id,
        checkpoint_ref: checkpointRef,
        decision: input.decision,
        trusted_answer_ref: recorded.answer.answer_id,
        trusted_proof: recorded.proof,
        ...(recorded.answer.feedback !== undefined ? { feedback: recorded.answer.feedback } : {}),
      };
    }, { pinnedRoot });
  } catch (error) {
    return blockedCtoMappingAsk(`mapping Ask failed: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    pinnedRoot.close();
  }
}

/** Explicitly reopen a non-continuing mapping review for a new Ask decision. */
export function resumeCtoSpecificationMapping(
  projectRoot: string,
  input: CtoSpecificationMappingResumeInput,
  options: CtoSpecificationRuntimeMutationOptions,
): CtoSpecificationMappingResumeResult {
  const pinnedRoot = PinnedProjectRoot.open(projectRoot);
  if (!pinnedRoot) return blockedCtoMappingAsk("project root is missing or cannot be canonicalized");
  const root = pinnedRoot.canonical_root;
  const assertRuntimeLive = () => assertCtoSpecificationRuntime(options, root, pinnedRoot);
  try {
    if (!isSafeCtoRunId(input?.cto_run_id)
      || !isSafeCtoExecutionId(input?.mapping_id)
      || !isSha256Hex(input?.mapping_hash)
      || !Number.isSafeInteger(input?.mapping_version) || input.mapping_version < 1) {
      return blockedCtoMappingAsk("mapping resume requires explicit safe run/mapping/hash/revision selectors");
    }
    assertRuntimeLive();
    const ownerExecution = activeCtoExecutionContext(root, input.cto_run_id, pinnedRoot, options.sessionId);
    if (!ownerExecution.ok) return blockedCtoMappingAsk(ownerExecution.error);
    try {
      assertRuntimeLive();
      recoverPendingMappingTransactions(root, input.cto_run_id, pinnedRoot);
    } catch (error) {
      return blockedCtoMappingAsk(`mapping recovery failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    assertRuntimeLive();
    const mapping = readMappingRecord(root, input.cto_run_id, input.mapping_id, pinnedRoot);
    if (!mapping.ok) return blockedCtoMappingAsk(mapping.error);
    if (mapping.value.mapping.mapping_hash !== input.mapping_hash || mapping.value.mapping.mapping_version !== input.mapping_version) return blockedCtoMappingAsk("mapping selector is stale");
    assertRuntimeLive();
    assertRuntimeLive();
    const constitutionFindings = ensureCtoExecutionConstitutions(root, mapping.value.selections, pinnedRoot);
    if (constitutionFindings.length > 0) return blockedCtoMappingAsk(...constitutionFindings);
    assertRuntimeLive();
    return withCtoRunLock(root, input.cto_run_id, () => {
      assertRuntimeLive();
      recoverPendingMappingTransactions(root, input.cto_run_id, pinnedRoot);
      const loaded = readMappingRecord(root, input.cto_run_id, input.mapping_id, pinnedRoot);
      if (!loaded.ok) return blockedCtoMappingAsk(loaded.error);
      const record = loaded.value;
      if (record.mapping.mapping_hash !== input.mapping_hash) return blockedCtoMappingAsk("mapping hash mismatch");
      if (record.mapping.mapping_version !== input.mapping_version) return blockedCtoMappingAsk("mapping revision mismatch");
      if (record.mapping.status === "awaiting_confirmation") {
        if (record.checkpoint_ref !== null || record.trusted_answer_ref !== null) {
          return blockedCtoMappingAsk("mapping already has a pending trusted answer; confirmation or explicit replay is required");
        }
        const selection = record.selections[0];
        if (!selection) return blockedCtoMappingAsk("mapping has no exact frozen selection");
        const execution = activeCtoExecutionContext(root, input.cto_run_id, pinnedRoot, options.sessionId);
        if (!execution.ok) return blockedCtoMappingAsk(execution.error);
        return {
          status: "resumed",
          dispatched: false,
          cto_run_id: input.cto_run_id,
          mapping_id: input.mapping_id,
          mapping_hash: input.mapping_hash,
          mapping_version: input.mapping_version,
          feature_id: selection.feature_id,
          run_key: selection.run_key,
          stage_id: execution.value.stage_id,
        };
      }
      if (record.mapping.status !== "revision_required" && record.mapping.status !== "stopped") {
        return blockedCtoMappingAsk(`mapping cannot be resumed from status '${record.mapping.status}'`);
      }
      if (!record.review || (record.mapping.status === "revision_required" && record.review.decision !== "request_changes")
        || (record.mapping.status === "stopped" && record.review.decision !== "approve_stop")) {
        return blockedCtoMappingAsk("mapping review outcome is missing or mismatched");
      }
      const file = mappingPath(root, input.cto_run_id, input.mapping_id, pinnedRoot);
      if (!file) return blockedCtoMappingAsk("canonical mapping path is unsafe");
      const mappingRead = readPinnedRegularFile(pinnedRoot, file, MAX_CTO_MAPPING_RECORD_BYTES);
      if (!mappingRead.ok) return blockedCtoMappingAsk("canonical mapping changed before mapping resume");
      const reopened: CtoSpecificationMappingRecord = {
        schema_version: 1,
        cto_run_id: record.cto_run_id,
        mapping: { ...record.mapping, status: "awaiting_confirmation", checkpoint_ref: null },
        selections: record.selections.map((selection) => ({ ...selection })),
        checkpoint_ref: null,
        trusted_answer_ref: null,
      };
      const content = `${JSON.stringify(reopened, null, 2)}\r\n`;
      if (!pinnedRoot.isStable()) return blockedCtoMappingAsk("project root changed before mapping resume");
      findCtoHook(ctoSpecificationExecutionTestHooksByRoot, root, pinnedRoot)?.beforeMappingWrite?.({
        root,
        cto_run_id: input.cto_run_id,
        mapping_id: input.mapping_id,
        operation: "resume",
      });
      const finalConstitutionError = refreshCtoMappingConstitutions(root, reopened, pinnedRoot);
      if (finalConstitutionError) return blockedCtoMappingAsk(finalConstitutionError);
      if (!pinnedRoot.isStable()) return blockedCtoMappingAsk("project root changed immediately before mapping resume write");
      const mappingRelativePath = pinnedRelativePath(pinnedRoot, file);
      const mappingBeforeDigest = sha256Hex(mappingRead.bytes.toString("utf8"));
      const selectedState = readPinnedFeatureState(root, record.review.feature_id, record.review.run_key, pinnedRoot);
      if (!selectedState.ok) return blockedCtoMappingAsk(selectedState.error);
      const reopenedRecord: CtoSpecificationMappingRecord = reopened;
      const transaction = createDirectMappingTransaction(
        "resume",
        input.cto_run_id,
        reopenedRecord,
        file,
        "present",
        mappingRead.bytes.toString("utf8"),
        content,
        selectedState.value,
      );
      assertRuntimeLive();
      const persistedTransaction: MappingTransactionWithWalReceipt = { ...transaction, wal_receipt: persistMappingTransactionPinned(pinnedRoot, root, transaction) };
      assertRuntimeLive();
      injectMappingFailure(root, pinnedRoot, "before_mapping_write", transaction.transaction_id);
      assertRuntimeLive();
      pinnedRoot.replaceFileIfMatches(mappingRelativePath, {
        dev: mappingRead.dev,
        ino: mappingRead.ino,
        sha256: mappingBeforeDigest,
      }, content);
      // Resume is an idempotent direct CAS; this seam models a crash after
      // its bytes become visible but before reread/post-write validation.
      injectMappingFailure(root, pinnedRoot, "after_mapping_write", `resume-${input.mapping_id}`);
      if (!pinnedRoot.isStable()) return blockedCtoMappingAsk("project root changed after mapping resume");
      const resumedMapping = readPinnedRegularFile(pinnedRoot, file, MAX_CTO_MAPPING_RECORD_BYTES);
      if (!resumedMapping.ok) return blockedCtoMappingAsk(`mapping resume could not be reread: ${resumedMapping.error}`);
      const postWriteConstitutionError = refreshCtoMappingConstitutions(root, reopened, pinnedRoot);
      if (postWriteConstitutionError) {
        try {
          assertRuntimeLive();
          commitDirectMappingTransactionPinned(root, persistedTransaction, pinnedRoot);
        } catch (error) {
          return blockedCtoMappingAsk(error instanceof Error ? error.message : String(error));
        }
        return blockedCtoMappingAsk(postWriteConstitutionError);
      }
      assertRuntimeLive();
      removeMappingTransactionPinned(pinnedRoot, mappingTransactionPath(transaction, pinnedRoot), persistedTransaction.wal_receipt);
      return {
        status: "resumed",
        dispatched: false,
        cto_run_id: input.cto_run_id,
        mapping_id: input.mapping_id,
        mapping_hash: input.mapping_hash,
        mapping_version: input.mapping_version,
        feature_id: record.review.feature_id,
        run_key: record.review.run_key,
        stage_id: record.review.stage_id,
      };
    }, { pinnedRoot });
  } catch (error) {
    return blockedCtoMappingAsk(`mapping resume failed: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    pinnedRoot.close();
  }
}

/** Confirm one awaiting mapping through the canonical trusted-answer ledger. */
function confirmCtoSpecificationMappingUnlocked(projectRoot: string, input: CtoSpecificationMappingConfirmationInput, pinnedRoot: PinnedProjectRoot, assertRuntimeLive: () => void, sessionId?: string): CtoSpecificationMappingConfirmationResult {
  assertRuntimeLive();
  if (!pinnedRoot.isStable()) return blockedExecution(["project root changed before CTO confirmation"]);
  const root = pinnedRoot.canonical_root;
  if (!input || !isSafeCtoRunId(input.cto_run_id) || !isSafeCtoExecutionId(input.mapping_id) || !isSha256Hex(input.mapping_hash)
    || typeof input.answer_id !== "string" || input.answer_id.trim().length === 0) {
    return blockedExecution(["mapping identity and one canonical answer_id must be explicit and safe"]);
  }
  const ownerExecution = activeCtoExecutionContext(root, input.cto_run_id, pinnedRoot, sessionId);
  if (!ownerExecution.ok) return blockedExecution([ownerExecution.error]);
  try {
    assertRuntimeLive();
    recoverPendingMappingTransactions(root, input.cto_run_id, pinnedRoot);
  } catch (error) {
    return blockedExecution([`mapping recovery failed: ${error instanceof Error ? error.message : String(error)}`]);
  }
  if (!pinnedRoot.isStable()) return blockedExecution(["project root changed before confirmation mapping read"]);
  const loaded = readMappingRecord(root, input.cto_run_id, input.mapping_id, pinnedRoot);
  if (!loaded.ok) return blockedExecution([loaded.error]);
  const record = loaded.value;
  if (record.mapping.mapping_hash !== input.mapping_hash) return blockedExecution(["mapping hash mismatch"]);
  const firstSelection = record.selections[0];
  if (!firstSelection) return blockedExecution(["mapping has no frozen selection"]);
  const execution = activeCtoExecutionContext(root, input.cto_run_id, pinnedRoot, sessionId);
  if (!execution.ok) return blockedExecution([execution.error]);
  const frozenExecution = (record.mapping as CtoSpecificationMapping & { execution?: { choice?: string; wave_id?: string; source_id?: string; capability_id?: string; capability_epoch?: string } }).execution;
  const activeWave = execution.value.state.wave_history?.find((candidate) => candidate.id === execution.value.wave_id);
  if (!frozenExecution || !ctoMappingTeamBindingsMatchExecution(record.mapping, execution.value, record.selections) || !ctoMappingExecutionMatchesWave(frozenExecution, activeWave, input.cto_run_id, record.mapping.parallelization.map((decision) => decision.slice_id), execution.value.state.teams.map((team) => team.work_identity))) return blockedExecution(["mapping execution capability or source identity is stale or mismatched"]);
  const featureId = firstSelection.feature_id;
  const runKey = firstSelection.run_key;
  const decision = "approve_continue" as const;
  const selectedRead = readPinnedFeatureState(root, featureId, runKey, pinnedRoot);
  if (!selectedRead.ok) return blockedExecution([selectedRead.error]);
  const selected = selectedRead.value;
  const matchingAnswers = (selected.state.trusted_checkpoint_answers ?? []).filter((candidate) => candidate.answer_id === input.answer_id);
  if (matchingAnswers.length !== 1) return blockedExecution([matchingAnswers.length === 0 ? "trusted answer is missing from the canonical ledger" : "trusted answer id is duplicated in the canonical ledger"]);
  const answer = matchingAnswers[0]!;
  const stageId = answer.stage_id;
  const canonicalCheckpoint = `cto-specification-mapping-${digestOf({ cto_run_id: input.cto_run_id, mapping_id: input.mapping_id, mapping_hash: input.mapping_hash, mapping_version: record.mapping.mapping_version, feature_id: featureId, run_key: runKey, stage_id: stageId, decision, capability_id: execution.value.capability_id, capability_epoch: execution.value.capability_epoch })}`;
  if (answer.run_id !== runKey
    || answer.checkpoint_id !== canonicalCheckpoint
    || answer.decision !== decision
    || answer.feature_id !== featureId
    || answer.capability_id !== execution.value.capability_id
    || answer.capability_epoch !== execution.value.capability_epoch
    || answer.subject_binding !== input.mapping_hash
    || answer.subject_revision !== record.mapping.mapping_version) {
    return blockedExecution(["trusted answer is stale or mismatched for the exact mapping"]);
  }
  const trustedAnswerRef = answer.answer_id;
  const trustedProof: CheckpointAnswerProof = {
    answer_id: answer.answer_id,
    nonce: answer.nonce,
    channel: answer.channel,
    reference: answer.reference,
    binding: answer.binding,
    ...(answer.feedback !== undefined ? { feedback: answer.feedback } : {}),
  };
  const actor: CheckpointActor = { kind: "user", ref: answer.reference, proof: trustedProof };
  const answerContext = {
    actor,
    run_id: answer.run_id,
    stage_id: answer.stage_id,
    checkpoint_id: answer.checkpoint_id,
    decision: answer.decision,
    feature_id: answer.feature_id,
    capability_id: answer.capability_id,
    capability_epoch: answer.capability_epoch,
    bind_active_context: true,
    ...(answer.subject_binding ? { subject_binding: answer.subject_binding } : {}),
    ...(answer.loop_iteration !== undefined ? { loop_iteration: answer.loop_iteration } : {}),
    root_identity: { canonical_root: root, dev: pinnedRoot.dev, ino: pinnedRoot.ino },
  };
  const proofError = trustedCheckpointAnswerError(selected.state, answerContext);
  if (proofError) return blockedExecution([`mapping answer proof is invalid: ${proofError}`]);
  if (record.mapping.status === "confirmed") {
    const recordedContext = record.confirmation_context;
    const exactReplay = Boolean(recordedContext
      && record.checkpoint_ref === canonicalCheckpoint && record.trusted_answer_ref === trustedAnswerRef
      && recordedContext.feature_id === featureId && recordedContext.run_key === runKey
      && recordedContext.stage_id === stageId && recordedContext.decision === decision
      && recordedContext.capability_id === answer.capability_id && recordedContext.capability_epoch === answer.capability_epoch
      && recordedContext.policy_hash === answer.policy_hash);
    if (!exactReplay) return blockedExecution(["mapping is already confirmed with a different proof context; takeover is not permitted"]);
    const durableProofError = mappingConfirmationProofError(pinnedRoot, record, selected);
    if (durableProofError) return blockedExecution([durableProofError]);
    if (!pinnedRoot.isStable()) return blockedExecution(["project root changed before returning confirmed mapping"]);
    return { status: "confirmed", dispatched: false, mapping: record.mapping, checkpoint_ref: canonicalCheckpoint, trusted_answer_ref: trustedAnswerRef };
  }
  if (record.mapping.status !== "awaiting_confirmation") return blockedExecution([`mapping is not awaiting confirmation (status '${record.mapping.status}')`]);
  let consumed: TeamState;
  try {
    consumed = consumeTrustedCheckpointAnswer(selected.state, answerContext);
  } catch (error) {
    return blockedExecution([`trusted answer consumption could not be prepared: ${error instanceof Error ? error.message : String(error)}`]);
  }
  const file = mappingPath(root, input.cto_run_id, input.mapping_id, pinnedRoot);
  if (!file) return blockedExecution(["canonical mapping path is unsafe"]);
  if (!pinnedRoot.isStable()) return blockedExecution(["project root changed before confirmation snapshots"]);
  const mappingRead = readPinnedRegularFile(pinnedRoot, file, MAX_CTO_MAPPING_RECORD_BYTES);
  const stateRead = { ok: true as const, bytes: selected.bytes };
  if (!mappingRead.ok) return blockedExecution(["canonical mapping changed before confirmation could be prepared"]);
  const mapping: CtoSpecificationMapping = { ...record.mapping, status: "confirmed", checkpoint_ref: canonicalCheckpoint };
  const transactionId = randomUUID();
  const confirmationProofRef = `tx-${transactionId}`;
  const confirmedAt = new Date().toISOString();
  const updated: CtoSpecificationMappingRecord = {
    schema_version: 1,
    cto_run_id: input.cto_run_id,
    mapping,
    selections: record.selections.map((selection) => ({ ...selection })),
    checkpoint_ref: canonicalCheckpoint,
    trusted_answer_ref: trustedAnswerRef,
    confirmation_context: { feature_id: featureId, run_key: runKey, stage_id: stageId, decision: decision, capability_id: answer.capability_id, capability_epoch: answer.capability_epoch, policy_hash: answer.policy_hash },
    confirmed_at: confirmedAt,
    confirmation_state_after_digest: mappingStateDigest(consumed),
    confirmation_proof_ref: confirmationProofRef,
  };
  const serialized = mappingRecordContentError(updated, input.cto_run_id, input.mapping_id);
  if (serialized.error) return blockedExecution([`mapping confirmation persistence failed: ${serialized.error}`]);
  const consumedAnswer = consumed.trusted_checkpoint_answers?.find((candidate) => candidate.answer_id === trustedAnswerRef);
  if (!consumedAnswer || !consumedAnswer.consumed_at || typeof consumedAnswer.subject_binding !== "string" || typeof consumedAnswer.subject_revision !== "number" || typeof consumedAnswer.authority_receipt !== "string") {
    return blockedExecution(["mapping confirmation consumed answer lacks strict durable proof fields"]);
  }
  const mappingRecordPath = pinnedRoot.relativePath(file);
  const statePath = pinnedRoot.relativePath(selected.statePath);
  if (!mappingRecordPath || !statePath) return blockedExecution(["mapping confirmation proof target path is unsafe"]);
  const proofPayload: CtoMappingConfirmationProofPayload = {
    schema_version: 1,
    root_identity: { canonical_path: pinnedRoot.canonical_root, dev: pinnedRoot.dev, ino: pinnedRoot.ino },
    cto_run_id: input.cto_run_id,
    mapping_id: input.mapping_id,
    mapping_hash: input.mapping_hash,
    mapping_version: record.mapping.mapping_version,
    proof_ref: confirmationProofRef,
    mapping_record_path: mappingRecordPath,
    mapping_record_digest: sha256Hex(serialized.content),
    state_path: statePath,
    state_after_digest: mappingStateDigest(consumed),
    checkpoint_ref: canonicalCheckpoint,
    trusted_answer_ref: trustedAnswerRef,
    confirmation_context: { feature_id: featureId, run_key: runKey, stage_id: stageId, decision, capability_id: answer.capability_id, capability_epoch: answer.capability_epoch, policy_hash: answer.policy_hash },
    confirmed_at: confirmedAt,
    trusted_answer: { ...consumedAnswer, subject_binding: consumedAnswer.subject_binding, subject_revision: consumedAnswer.subject_revision, authority_receipt: consumedAnswer.authority_receipt, consumed_at: consumedAnswer.consumed_at } as CtoMappingConfirmationProofAnswer,
  };
  const signedProof = signCtoMappingConfirmationProof(pinnedRoot, proofPayload);
  if (!signedProof) return blockedExecution(["mapping confirmation proof could not be authenticated"]);
  const publishedProof = writeCtoMappingConfirmationProof(pinnedRoot, signedProof);
  if (!publishedProof.ok) return blockedExecution([publishedProof.error]);
  const transaction: CtoSpecificationMappingTransaction = {
    schema_version: 1,
    transaction_id: transactionId,
    operation: "confirm",
    cto_run_id: input.cto_run_id,
    mapping_id: input.mapping_id,
    mapping_hash: input.mapping_hash,
    feature_id: featureId,
    run_key: runKey,
    mapping_path: file,
    mapping_before_disposition: "present",
    mapping_before_content: mappingRead.bytes.toString("utf8"),
    mapping_before_digest: sha256Hex(mappingRead.bytes.toString("utf8")),
    staged_mapping_identity: { mapping_id: input.mapping_id, mapping_hash: input.mapping_hash, content_digest: sha256Hex(serialized.content) },
    mapping_after_digest: sha256Hex(serialized.content),
    mapping_content: serialized.content,
    mapping,
    selections: record.selections.map((selection) => ({ ...selection })),
    state_path: selected.statePath,
    state_dir: selected.stateDir,
    artifacts_dir: selected.artifactsDir,
    is_legacy: selected.isLegacy,
    state_before_content: stateRead.bytes.toString("utf8"),
    state_before_digest: sha256Hex(stateRead.bytes.toString("utf8")),
    state_source_content: JSON.stringify(selected.state),
    state_source_logical_digest: mappingStateDigest(selected.state),
    state_after_digest: mappingStateDigest(consumed),
    confirmation_proof_path: publishedProof.path,
    confirmation_proof_digest: publishedProof.digest,
    confirmation_proof_content: publishedProof.content,
    state_transition: {
      kind: "consume_checkpoint_answer",
      answer_id: trustedAnswerRef,
      stage_id: stageId,
      checkpoint_id: canonicalCheckpoint,
      decision: decision,
      feature_id: featureId,
      run_key: runKey,
      capability_id: answer.capability_id,
      capability_epoch: answer.capability_epoch,
      policy_hash: answer.policy_hash,
      ...(answer.subject_binding ? { subject_binding: answer.subject_binding } : {}),
      ...(answer.subject_revision !== undefined ? { subject_revision: answer.subject_revision } : {}),
      consumed_at: consumed.trusted_checkpoint_answers?.find((candidate) => candidate.answer_id === trustedAnswerRef)?.consumed_at,
    },
    state: consumed,
    status: "pending",
  };
  const precommitConstitutionError = refreshCtoMappingTransactionConstitutions(root, transaction, pinnedRoot);
  if (precommitConstitutionError) return blockedExecution([precommitConstitutionError]);
  const walConstitutionError = refreshCtoMappingTransactionConstitutions(root, transaction, pinnedRoot);
  if (walConstitutionError) return blockedExecution([walConstitutionError]);
  try {
    if (!pinnedRoot.isStable()) return blockedExecution(["project root changed before confirmation WAL"]);
    const txPath = mappingTransactionPath(transaction, pinnedRoot);
    injectMappingFailure(root, pinnedRoot, "before_prepare", transaction.transaction_id);
    const beforePrepareHookConstitutionError = refreshCtoMappingTransactionConstitutions(root, transaction, pinnedRoot);
    if (beforePrepareHookConstitutionError) return blockedExecution([beforePrepareHookConstitutionError]);
    assertRuntimeLive();
    const persistedTransaction: MappingTransactionWithWalReceipt = { ...transaction, wal_receipt: persistMappingTransactionPinned(pinnedRoot, root, transaction) };
    assertRuntimeLive();
    injectMappingFailure(root, pinnedRoot, "after_prepare", transaction.transaction_id);
    const afterPrepareHookConstitutionError = refreshCtoMappingTransactionConstitutions(root, transaction, pinnedRoot);
    if (afterPrepareHookConstitutionError) return blockedExecution([afterPrepareHookConstitutionError]);
    if (!pinnedRoot.isStable()) return blockedExecution(["project root changed between confirmation WAL and commit"]);
    assertRuntimeLive();
    commitMappingTransactionPinned(root, persistedTransaction, pinnedRoot);
    assertRuntimeLive();
    if (!pinnedRoot.isStable()) return blockedExecution(["project root changed after confirmation commit"]);
    return { status: "confirmed", dispatched: false, mapping, checkpoint_ref: canonicalCheckpoint, trusted_answer_ref: trustedAnswerRef };
  } catch (error) {
    return blockedExecution([`mapping confirmation persistence failed: ${error instanceof Error ? error.message : String(error)}`]);
  }
}

export async function confirmCtoSpecificationMapping(projectRoot: string, input: CtoSpecificationMappingConfirmationInput, options: CtoSpecificationRuntimeMutationOptions): Promise<CtoSpecificationMappingConfirmationResult> {
  const pinnedRoot = PinnedProjectRoot.open(projectRoot);
  if (!pinnedRoot) return blockedExecution(["project root is missing or cannot be canonicalized"]);
  const root = pinnedRoot.canonical_root;
  const assertRuntimeLive = () => assertCtoSpecificationRuntime(options, root, pinnedRoot);
  try {
    assertRuntimeLive();
    if (!pinnedRoot.isStable()) return blockedExecution(["project root changed before CTO confirmation"]);
    if (!input || !isSafeCtoRunId(input.cto_run_id)) return blockedExecution(["mapping identity must be explicit and non-blank"]);
    recoverPendingMappingTransactions(root, input.cto_run_id, pinnedRoot);
    const ownerExecution = activeCtoExecutionContext(root, input.cto_run_id, pinnedRoot, options.sessionId);
    if (!ownerExecution.ok) return blockedExecution([ownerExecution.error]);
    const mapping = readMappingRecord(root, input.cto_run_id, input.mapping_id, pinnedRoot);
    if (!mapping.ok) return blockedExecution([mapping.error]);
    const constitutionFindings = ensureCtoExecutionConstitutions(root, mapping.value.selections, pinnedRoot);
    if (constitutionFindings.length > 0) return blockedExecution(constitutionFindings);
    assertRuntimeLive();
    const result = await withCtoRunLockAsync(root, input.cto_run_id, async () => {
      assertRuntimeLive();
      return confirmCtoSpecificationMappingUnlocked(root, input, pinnedRoot, assertRuntimeLive, options.sessionId);
    }, { pinnedRoot });
    assertRuntimeLive();
    if (!pinnedRoot.isStable()) return blockedExecution(["project root changed during CTO confirmation"]);
    return result;
  } catch (error) {
    return blockedExecution([`mapping transaction lock failed: ${error instanceof Error ? error.message : String(error)}`]);
  } finally {
    pinnedRoot.close();
  }
}

function readCtoSelectedConstitution(
  root: string,
  featureId: string,
  runKey: string,
  pinnedRoot: PinnedProjectRoot,
): { ok: true } | { ok: false; error: string } {
  const resolved = resolveFeatureWorkspace(root, { feature_id: featureId, run_key: runKey }, workspaceSnapshotForPinnedRoot(pinnedRoot), { persistMigration: false, requireMigration: true });
  if (!resolved.ok) return { ok: false, error: resolved.error };
  const constitution = readCtoWorkspaceConstitution(root, resolved.value, pinnedRoot);
  return constitution.ok ? { ok: true } : { ok: false, error: constitution.finding };
}

function loadHandoff(
  root: string,
  selection: CtoSpecificationExecutionSelection,
  expectedDigest?: string,
  pinnedRoot?: PinnedProjectRoot,
): { ok: true; workspace: FeatureWorkspace; handoff: ImplementationHandoff } | { ok: false; error: string } {
  const workspaceResult = resolveFeatureWorkspace(root, selection, pinnedRoot ? workspaceSnapshotForPinnedRoot(pinnedRoot) : undefined, { persistMigration: false, requireMigration: true });
  if (!workspaceResult.ok) return { ok: false, error: workspaceResult.error };
  const workspace = workspaceResult.value;
  if (!pinnedRoot) return { ok: false, error: `handoff for ${selection.feature_id} cannot be read without a pinned project root` };
  if (!workspace.handoff_ref || workspace.handoff_ref.includes("/")) return { ok: false, error: `handoff reference for ${selection.feature_id} is unsafe` };
  const file = join(root, ".work-state", "features", selection.feature_id, "artifacts", "implementation_handoff", `${workspace.handoff_ref}.json`);
  let relativePath: string;
  try {
    relativePath = pinnedRelativePath(pinnedRoot, file);
  } catch (error) {
    return { ok: false, error: `handoff for ${selection.feature_id} is outside its canonical artifact directory: ${error instanceof Error ? error.message : String(error)}` };
  }
  const loaded = readCanonicalHandoff(pinnedRoot, relativePath, `handoff for ${selection.feature_id}`);
  if (!loaded.ok) return { ok: false, error: loaded.error };
  const handoff = loaded.handoff;
  const constitution = readCtoSpecificationConstitution(root, workspace, handoff, pinnedRoot);
  if (!constitution.ok) return { ok: false, error: `${selection.feature_id}: ${constitution.finding}` };
  if (expectedDigest !== undefined && handoff.handoff_digest !== expectedDigest) return { ok: false, error: `handoff digest for ${selection.feature_id} changed since mapping confirmation` };
  if (!handoff.execution_choices.includes("cto")) return { ok: false, error: `handoff for ${selection.feature_id} does not explicitly allow CTO execution` };
  const readiness = evaluateHandoffReadiness(handoff, { current_constitution_binding: workspace.constitution_binding });
  if (!readiness.ok) return { ok: false, error: `handoff readiness for ${selection.feature_id} failed: ${readiness.error}` };
  if (!pinnedRoot.isStable()) return { ok: false, error: "project root changed while reading the implementation handoff" };
  return { ok: true, workspace, handoff };
}

export interface CtoSpecificationConformanceSelectors {
  cto_run_id: string;
  mapping_id: string;
  mapping_hash: string;
  wave_id?: string;
}

export type CtoSpecificationConformanceDerivation =
  | { ok: true; input: { project_root: string; binding: CtoSpecificationConformanceBinding; mapping: CtoSpecificationMapping; handoffs: CtoSpecificationConformanceHandoff[]; claims: CtoActiveClaimSummary[]; evidence: ConformanceEvidence[]; quality_gates: never[] } }
  | { ok: false; error: string; feature_ids?: string[] };

type CanonicalConformanceArtifacts = { evidence: ConformanceEvidence[]; quality_gates: import("../specification/types.js").QualityGateResult[] };

function canonicalConformanceArtifactCandidates(
  pinnedRoot: PinnedProjectRoot,
  artifactDirectory: string,
  prefix: "conformance_evidence" | "quality_gate_evidence",
): string[] {
  return pinnedRoot.listDirectory(artifactDirectory, { maxEntries: 128, maxNameBytes: 64 * 1024 })
    .filter((name) => name.startsWith(`${prefix}-`) && name.endsWith(".json") && name.length > prefix.length + 6)
    .map((name) => name.slice(0, -5))
    .sort((left, right) => left.localeCompare(right));
}

function readCanonicalConformanceArtifacts(
  pinnedRoot: PinnedProjectRoot,
  root: string,
  featureId: string,
  handoffDigest: string,
  claimId: string,
  profileHash: string,
): { ok: true; value: CanonicalConformanceArtifacts } | { ok: false; error: string } {
  let artifactDirectory: string;
  try {
    artifactDirectory = pinnedRelativePath(pinnedRoot, featureArtifactsDir(root, featureId));
  } catch (error) {
    return { ok: false, error: `feature '${featureId}' artifact directory is outside the pinned project root: ${error instanceof Error ? error.message : String(error)}` };
  }
  let evidenceId: string;
  let qualityId: string;
  try {
    const evidenceCandidates = canonicalConformanceArtifactCandidates(pinnedRoot, artifactDirectory, "conformance_evidence");
    const qualityCandidates = canonicalConformanceArtifactCandidates(pinnedRoot, artifactDirectory, "quality_gate_evidence");
    const expectedEvidenceId = `conformance_evidence-${featureId}`;
    const expectedQualityId = `quality_gate_evidence-${featureId}`;
    if (evidenceCandidates.length !== 1 || evidenceCandidates[0] !== expectedEvidenceId) return { ok: false, error: `feature '${featureId}' requires exactly one current canonical conformance_evidence artifact '${expectedEvidenceId}'; found ${evidenceCandidates.join(", ") || "none"}` };
    if (qualityCandidates.length !== 1 || qualityCandidates[0] !== expectedQualityId) return { ok: false, error: `feature '${featureId}' requires exactly one current canonical quality_gate_evidence artifact '${expectedQualityId}'; found ${qualityCandidates.join(", ") || "none"}` };
    evidenceId = expectedEvidenceId;
    qualityId = expectedQualityId;
  } catch (error) {
    return { ok: false, error: `feature '${featureId}' canonical evidence directory is unavailable: ${error instanceof Error ? error.message : String(error)}` };
  }
  const read = (id: string, schema: "conformance_evidence" | "quality_gate_evidence") => {
    try {
      const snapshot = readPinnedArtifactSnapshot(pinnedRoot, artifactDirectory, id, { verifyPathAfterRead: true });
      const value = snapshot.value;
      if (!value || typeof value !== "object" || Array.isArray(value)) return { ok: false as const, error: `feature '${featureId}' artifact '${id}' is not an object` };
      const record = value as Record<string, unknown>;
      if (record.artifact_id !== id) return { ok: false as const, error: `feature '${featureId}' artifact '${id}' has a mismatched artifact_id` };
      const validation = validateProducedArtifact(schema, value);
      if (!validation.ok) return { ok: false as const, error: `feature '${featureId}' artifact '${id}' is invalid: ${validation.issues.map((issue) => issue.message).join("; ")}` };
      const expectedPath = `${artifactDirectory}/${id}.json`;
      if (snapshot.path !== expectedPath) return { ok: false as const, error: `feature '${featureId}' artifact '${id}' resolved to an unexpected path` };
      return { ok: true as const, value: record, ref: { artifact_id: id, path: snapshot.path, sha256: snapshot.sha256, schema_status: "met" as const, quality_gate_status: "met" as const } };
    } catch (error) {
      return { ok: false as const, error: `feature '${featureId}' artifact '${id}' is unreadable: ${error instanceof Error ? error.message : String(error)}` };
    }
  };
  const evidenceArtifact = read(evidenceId, "conformance_evidence");
  if (!evidenceArtifact.ok) return evidenceArtifact;
  const qualityArtifact = read(qualityId, "quality_gate_evidence");
  if (!qualityArtifact.ok) return qualityArtifact;
  const entries = evidenceArtifact.value.entries;
  if (!Array.isArray(entries)) return { ok: false, error: `feature '${featureId}' conformance evidence envelope has malformed entries` };
  const evidenceIds = new Set<string>();
  for (const entry of entries) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return { ok: false, error: `feature '${featureId}' conformance evidence contains a malformed entry` };
    const value = entry as Record<string, unknown>;
    if (typeof value.evidence_id !== "string" || evidenceIds.has(value.evidence_id)) return { ok: false, error: `feature '${featureId}' conformance evidence contains a duplicate or invalid evidence_id` };
    evidenceIds.add(value.evidence_id);
    if (value.handoff_digest !== handoffDigest) return { ok: false, error: `feature '${featureId}' conformance evidence is bound to a stale or mismatched handoff_digest` };
    if (value.execution_claim_id !== claimId) return { ok: false, error: `feature '${featureId}' conformance evidence is bound to a stale or mismatched execution claim` };
  }
  const gates = qualityArtifact.value.gates;
  if (!Array.isArray(gates) || gates.length === 0) return { ok: false, error: `feature '${featureId}' quality gate envelope has no gates` };
  const gateIds = new Set<string>();
  let profileGateCount = 0;
  for (const gate of gates) {
    if (!gate || typeof gate !== "object" || Array.isArray(gate)) return { ok: false, error: `feature '${featureId}' quality gate envelope contains a malformed gate` };
    const value = gate as Record<string, unknown>;
    if (typeof value.gate_id !== "string" || gateIds.has(value.gate_id)) return { ok: false, error: `feature '${featureId}' quality gate envelope contains a duplicate or invalid gate_id` };
    gateIds.add(value.gate_id);
    if (value.source === "execution_profile") {
      profileGateCount += 1;
      if (value.gate_id !== `execution-profile.${profileHash}`) return { ok: false, error: `feature '${featureId}' quality gate is bound to the wrong execution profile` };
    }
    if (!Array.isArray(value.evidence_refs)) return { ok: false, error: `feature '${featureId}' quality gate '${value.gate_id}' has malformed evidence_refs` };
    if (value.evidence_refs.length > 0) return { ok: false, error: `feature '${featureId}' quality gate '${value.gate_id}' must persist empty evidence_refs` };
  }
  if (profileGateCount !== 1) return { ok: false, error: `feature '${featureId}' requires exactly one execution-profile quality gate; found ${profileGateCount}` };
  return {
    ok: true,
    value: {
      evidence: entries.map((entry) => ({ ...(entry as Record<string, unknown>), artifact: evidenceArtifact.ref })) as unknown as ConformanceEvidence[],
      quality_gates: gates.map((gate) => {
        const { evaluated_at: _evaluatedAt, evidence_refs: _evidenceRefs, ...canonical } = gate as Record<string, unknown>;
        return { ...canonical, evidence_refs: [qualityArtifact.ref] };
      }) as import("../specification/types.js").QualityGateResult[],
    },
  };
}

/**
 * Reconstruct the strict conformance sink input from one durable CTO wave.
 * Public callers provide only selectors; handoffs, claims, evidence, quality
 * gates, and the opaque binding are authenticated from canonical state/artifacts.
 */
export function deriveCtoSpecificationConformanceInput(
  projectRoot: string,
  selectors: CtoSpecificationConformanceSelectors,
): CtoSpecificationConformanceDerivation {
  const pinnedRoot = PinnedProjectRoot.open(projectRoot);
  if (!pinnedRoot) return { ok: false, error: "project root is missing or cannot be canonicalized" };
  const root = pinnedRoot.canonical_root;
  try {
    if (!isSafeCtoRunId(selectors?.cto_run_id) || !isSafeCtoExecutionId(selectors?.mapping_id) || !isSha256Hex(selectors?.mapping_hash)) return { ok: false, error: "conformance selectors require safe cto_run_id/mapping_id and exact mapping_hash" };
    recoverPendingMappingTransactions(root, selectors.cto_run_id, pinnedRoot);
    const record = readMappingRecord(root, selectors.cto_run_id, selectors.mapping_id, pinnedRoot);
    if (!record.ok) return { ok: false, error: record.error };
    if (record.value.mapping.mapping_hash !== selectors.mapping_hash || record.value.mapping.status !== "confirmed") return { ok: false, error: "conformance selectors do not identify the exact confirmed mapping" };
    const execution = conformanceCtoExecutionContext(root, selectors.cto_run_id, record.value.mapping, pinnedRoot);
    if (!execution.ok) return { ok: false, error: execution.error };
    const frozenExecution = (record.value.mapping as CtoSpecificationMapping & { execution?: { choice?: string; wave_id?: string; source_id?: string; capability_id?: string; capability_epoch?: string } }).execution;
    const conformanceWave = execution.value.state.wave_history?.find((candidate) => candidate.id === execution.value.wave_id);
    if (!frozenExecution || !ctoMappingTeamBindingsMatchExecution(record.value.mapping, execution.value, record.value.selections) || !ctoMappingExecutionMatchesWave(frozenExecution, conformanceWave, selectors.cto_run_id, record.value.mapping.parallelization.map((decision) => decision.slice_id), execution.value.state.teams.map((team) => team.work_identity))) return { ok: false, error: "durable mapping is not bound to the CTO conformance execution wave" };
    if (selectors.wave_id !== undefined && selectors.wave_id !== execution.value.wave_id) return { ok: false, error: "conformance wave_id does not match the durable wave" };
    const confirmationContext = record.value.confirmation_context;
    if (!confirmationContext) return { ok: false, error: "confirmed mapping lacks its exact confirmation context" };
    const anchor = readPinnedFeatureState(root, confirmationContext.feature_id, confirmationContext.run_key, pinnedRoot);
    if (!anchor.ok) return anchor;
    const admissionError = dispatchAdmissionError(record.value, execution.value, anchor.value, selectors.cto_run_id, { canonical_root: pinnedRoot.canonical_root, dev: pinnedRoot.dev, ino: pinnedRoot.ino }, pinnedRoot);
    if (admissionError) return { ok: false, error: admissionError };
    if (!record.value.checkpoint_ref || !record.value.trusted_answer_ref) return { ok: false, error: "confirmed mapping lacks its trusted checkpoint references" };
    const handoffs: CtoSpecificationConformanceHandoff[] = [];
    const claims: CtoActiveClaimSummary[] = [];
    const evidence: ConformanceEvidence[] = [];
    const qualityGates: import("../specification/types.js").QualityGateResult[] = [];
    for (const selection of record.value.selections) {
      const frozenBinding = record.value.mapping.handoff_bindings.find((candidate) => candidate.feature_id === selection.feature_id);
      if (!frozenBinding) return { ok: false, error: `mapping lacks a frozen handoff binding for '${selection.feature_id}'` };
      const loaded = loadHandoff(root, selection, frozenBinding.handoff_digest, pinnedRoot);
      if (!loaded.ok) return { ok: false, error: loaded.error };
      const claimRead = readCurrentExecutionClaim(root, selection.feature_id, pinnedRoot);
      if (!claimRead.ok || !claimRead.value) return { ok: false, error: `feature '${selection.feature_id}' has no current CTO execution claim: ${claimRead.ok ? "missing claim" : claimRead.error}` };
      const claim = claimRead.value;
      const admission = claim.admission_binding;
      if ((claim.status !== "active" && claim.status !== "completed" && claim.status !== "blocked") || claim.owner_kind !== "cto" || claim.owner_run_id !== selectors.cto_run_id || claim.handoff_digest !== loaded.handoff.handoff_digest || loaded.workspace.execution_claim_ref !== claim.claim_id
        || !admission || admission.mapping_id !== record.value.mapping.mapping_id || admission.mapping_hash !== record.value.mapping.mapping_hash || admission.wave_id !== execution.value.wave_id) return { ok: false, error: `feature '${selection.feature_id}' current claim is not the exact active CTO admission for the durable mapping wave` };
      const claimAdmission = verifyExecutionClaimAdmissionBindingPinned(pinnedRoot, {
        feature_id: selection.feature_id,
        run_key: selection.run_key,
        owner_run_id: selectors.cto_run_id,
        workspace: loaded.workspace,
        claim,
        handoff: loaded.handoff,
        mapping: {
          selected_feature_id: selection.feature_id,
          selected_run_key: selection.run_key,
          mapping_record_path: admission.mapping_record_path,
          mapping_record_digest: admission.mapping_record_digest,
          mapping_id: admission.mapping_id,
          mapping_hash: admission.mapping_hash,
          mapping_version: admission.mapping_version,
          checkpoint_ref: admission.checkpoint_ref,
          trusted_answer_ref: admission.trusted_answer_ref,
          wave_id: admission.wave_id,
          capability_id: admission.capability_id,
          capability_epoch: admission.capability_epoch,
        },
        verification_mode: conformanceWave?.status === "done" ? "terminal" : "active",
      });
      if (!claimAdmission.ok) return { ok: false, error: `feature '${selection.feature_id}' claim admission proof is invalid: ${claimAdmission.error}` };
      const artifacts = readCanonicalConformanceArtifacts(pinnedRoot, root, selection.feature_id, loaded.handoff.handoff_digest, claim.claim_id, loaded.workspace.profile_hash);
      if (!artifacts.ok) return { ...artifacts, feature_ids: record.value.selections.map((candidate) => candidate.feature_id) };
      handoffs.push({ feature_id: selection.feature_id, run_key: selection.run_key, handoff: loaded.handoff, quality_gates: artifacts.value.quality_gates });
      claims.push({ feature_id: selection.feature_id, claim_id: claim.claim_id, handoff_digest: claim.handoff_digest, owner_kind: claim.owner_kind, owner_run_id: claim.owner_run_id, status: claim.status, ...(claim.admission_binding ? { admission_binding: claim.admission_binding } : {}) });
      evidence.push(...artifacts.value.evidence);
      qualityGates.push(...artifacts.value.quality_gates);
    }
    if (!pinnedRoot.isStable()) return { ok: false, error: "project root changed while deriving conformance input" };
    const terminalTeams = computeCtoTerminalTeamsDigest(execution.value.state, record.value.mapping, record.value.selections);
    if (!terminalTeams.ok) return { ok: false, error: `conformance requires every mapped CTO team to publish a valid terminal postimage: ${terminalTeams.error}`, feature_ids: record.value.selections.map((candidate) => candidate.feature_id) };
    if (!pinnedRoot.isStable()) return { ok: false, error: "project root changed before conformance authority issuance" };
    const binding = issueCtoSpecificationConformanceBinding({
      project_root: root,
      cto_run_id: selectors.cto_run_id,
      mapping_id: record.value.mapping.mapping_id,
      mapping_hash: record.value.mapping.mapping_hash,
      mapping_record_path: record.value.record_path,
      mapping_record_digest: record.value.record_digest,
      checkpoint_id: record.value.checkpoint_ref,
      trusted_answer_id: record.value.trusted_answer_ref,
      active_claims_digest: ctoConformanceClaimsDigest(claims.map((claim) => ({
        ...claim,
        status: claim.status === "completed" ? "active" as const : claim.status,
      }))),
      terminal_teams_digest: terminalTeams.digest,
    });
    return { ok: true, input: { project_root: root, binding, mapping: record.value.mapping, handoffs, claims, evidence, quality_gates: [] } };
  } catch (error) {
    return { ok: false, error: `conformance input derivation failed: ${error instanceof Error ? error.message : String(error)}` };
  } finally {
    pinnedRoot.close();
  }
}

function taskOwnerForQualifiedIdentity(mapping: CtoSpecificationMapping, identity: string): CtoSpecificationMapping["task_to_slice"][number] | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(identity);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const value = parsed as { feature_id?: unknown; task_id?: unknown };
  if (typeof value.feature_id !== "string" || typeof value.task_id !== "string") return null;
  return mapping.task_to_slice.find((owner) => owner.feature_id === value.feature_id && owner.task_id === value.task_id) ?? null;
}

function ctoLeadEvidenceContract(
  handoff: ImplementationHandoff,
  claim: ExecutionClaim,
  profileHash: string,
): CtoSpecificationLeadEvidenceContract {
  const featureId = handoff.feature_id;
  const artifactDirectory = `.work-state/features/${featureId}/artifacts`;
  const conformanceArtifactId = `conformance_evidence-${featureId}`;
  const qualityGateArtifactId = `quality_gate_evidence-${featureId}`;
  const artifactRefKeys = ["artifact_id", "path", "sha256", "schema_status", "quality_gate_status"] as const;
  const observableRequirements = new Set<string>();
  const observableAcceptances = new Set<string>();
  for (const verification of handoff.verification) {
    if (!verification.observable_behavior) continue;
    for (const id of verification.requirement_ids) observableRequirements.add(id);
    for (const id of verification.acceptance_ids) observableAcceptances.add(id);
  }
  const requiredKinds = (observable: boolean): Array<"implementation" | "review" | "executed_test"> =>
    observable ? ["implementation", "review", "executed_test"] : ["implementation", "review"];
  const subjects: CtoSpecificationLeadEvidenceContract["subjects"] = [];
  const seen = new Set<string>();
  for (const requirement of handoff.requirements) {
    const requirementKey = `requirement:${requirement.requirement_id}`;
    if (!seen.has(requirementKey)) {
      seen.add(requirementKey);
      subjects.push({ subject_id: requirement.requirement_id, requirement_id: requirement.requirement_id, observable_behavior: observableRequirements.has(requirement.requirement_id), required_evidence_kinds: requiredKinds(observableRequirements.has(requirement.requirement_id)) });
    }
    for (const acceptanceId of requirement.acceptance_ids) {
      const acceptanceKey = `acceptance_scenario:${acceptanceId}`;
      if (seen.has(acceptanceKey)) continue;
      seen.add(acceptanceKey);
      subjects.push({ subject_id: acceptanceId, requirement_id: requirement.requirement_id, observable_behavior: observableAcceptances.has(acceptanceId), required_evidence_kinds: requiredKinds(observableAcceptances.has(acceptanceId)) });
    }
  }
  return {
    max_internal_repairs: 1,
    artifact_contract: {
      schema_version: 1,
      schema_version_values: [1],
      timestamp_contract: {
        regex: "^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z$",
        valid_example: "2026-01-01T00:00:00.000Z",
        invalid_examples: ["2026-01-01T00:00:00.30503000Z", "2026-01-01T00:00:00.818575000Z"],
        generation_rule: "Use ECMAScript new Date().toISOString() or trim deterministically to exactly 3 fractional digits; never shell date or %N.",
      },
      bounds: {
        evidence_entries_min_items: 1,
        evidence_entries_max_items: 256,
        quality_gates_min_items: 1,
        quality_gates_max_items: 64,
        gate_evidence_refs_max_items: 64,
        gate_findings_max_items: 128,
        finding_evidence_refs_max_items: 64,
        field_max_bytes: 16384,
        aggregate_max_bytes: 2097152,
        nesting_max_depth: 4,
      },
      bindings: {
        feature_id: featureId,
        handoff_digest: handoff.handoff_digest,
        execution_claim_id: claim.claim_id,
        execution_profile_gate_id: `execution-profile.${profileHash}`,
      },
      conformance: {
        artifact_id: conformanceArtifactId,
        path: `${artifactDirectory}/${conformanceArtifactId}.json`,
        envelope_required_keys: ["schema_version", "artifact_id", "entries"],
        envelope_allowed_keys: ["schema_version", "artifact_id", "entries"],
        entry_required_keys: ["evidence_id", "kind", "subject_id", "requirement_id", "handoff_digest", "execution_claim_id", "recorded_at"],
        entry_allowed_keys: ["evidence_id", "kind", "subject_id", "requirement_id", "handoff_digest", "execution_claim_id", "review_verdict", "test", "intent_message", "recorded_at"],
        allowed_kinds: ["implementation", "review", "executed_test", "intent_conflict"],
        kind_requirements: {
          review: ["review_verdict"],
          executed_test: ["test"],
          intent_conflict: ["intent_message"],
        },
        review_verdict_values: ["pass", "fail"],
        evidence_id_pattern: "^[A-Za-z0-9._-]+$",
        artifact_id_pattern: "^[A-Za-z0-9._-]+$",
        identifier_max_bytes: 128,
        test_required_keys: ["evidence_ref", "test_kind", "status", "executed_at"],
        test_allowed_keys: ["evidence_ref", "test_kind", "status", "executed_at"],
        test_kind_values: ["unit", "integration", "e2e", "runtime"],
        status_values: ["pass", "fail"],
        evidence_ref_required_keys: artifactRefKeys,
        evidence_ref_allowed_keys: artifactRefKeys,
        schema_status_values: ["met", "failed"],
        quality_gate_status_values: ["met", "pending", "failed"],
        sha256_pattern: "^[a-f0-9]{64}$",
        handoff_digest_pattern: "^[a-f0-9]{64}$",
        evidence_handoff_digest_binding: "artifact_contract.bindings.handoff_digest",
        evidence_execution_claim_id_binding: "artifact_contract.bindings.execution_claim_id",
        path_template: ".work-state/features/<feature_id>/artifacts/<artifact_id>.json",
      },
      quality_gate: {
        artifact_id: qualityGateArtifactId,
        path: `${artifactDirectory}/${qualityGateArtifactId}.json`,
        envelope_required_keys: ["schema_version", "artifact_id", "gates"],
        envelope_allowed_keys: ["schema_version", "artifact_id", "gates"],
        gate_required_keys: ["gate_id", "source", "status", "evidence_refs", "findings", "evaluated_at"],
        gate_allowed_keys: ["gate_id", "source", "status", "evidence_refs", "findings", "evaluated_at"],
        finding_required_keys: ["code", "subject_id", "message", "evidence_refs"],
        finding_allowed_keys: ["code", "subject_id", "message", "evidence_refs"],
        finding_evidence_refs_type: "string[]",
        source_values: ["project_constitution", "execution_profile"],
        status_values: ["pass", "fail"],
        evidence_ref_required_keys: artifactRefKeys,
        evidence_ref_allowed_keys: artifactRefKeys,
        schema_status_values: ["met", "failed"],
        quality_gate_status_values: ["met", "pending", "failed"],
        sha256_pattern: "^[a-f0-9]{64}$",
        path_template: ".work-state/features/<feature_id>/artifacts/<artifact_id>.json",
      },
      topology: {
        quality_gate_must_be_written_first: true,
        quality_gate_persisted_gate_evidence_refs: [],
        supporting_runtime_artifact_id_prefix: "runtime_test_evidence-",
        supporting_runtime_artifact_path_template: ".work-state/features/<feature_id>/artifacts/runtime_test_evidence-<feature_id>.json",
        supporting_runtime_artifact_envelope: "conformance_evidence",
        supporting_runtime_envelope_must_contain_executed_tests: true,
        supporting_runtime_inner_test_evidence_ref_must_equal_quality_gate_ref: true,
        supporting_runtime_rows_exact_multiset: true,
        supporting_runtime_row_key_fields: ["evidence_id", "kind", "subject_id", "requirement_id", "test_kind", "status", "executed_at", "handoff_digest", "execution_claim_id"],
        contradictory_review_or_test_statuses_block: true,
        intent_conflict_status: "changed_intent",
        conformance_must_be_written_after_supporting_runtime: true,
        outer_executed_test_evidence_ref_must_equal_supporting_runtime_ref: true,
        outer_executed_test_evidence_ref_envelope: "conformance_evidence",
        quality_gate_must_not_be_rewritten_after_conformance: true,
        forbidden_standalone_nested_artifact_id_prefixes: ["implementation_evidence-", "runtime_test_evidence-"],
      },
    },
    subjects,
    terminal_intent_conflict: { kind: "intent_conflict", artifact_quality_gate_status: "met", profile_gate_separate: true },
  };
}

type CtoDependencyTerminalizationAuthority = {
  mapping_id: string;
  mapping_hash: string;
  mapping_record_digest: string;
  wave_id: string;
};

export type CtoDependencyFailureTerminalizationResult =
  | { status: "reconciled"; terminalized_team_ids: string[]; failed_team_ids: string[]; findings: string[] }
  | { status: "blocked"; terminalized_team_ids: string[]; failed_team_ids: string[]; findings: string[] };

/**
 * Convert work that can no longer be dispatched after a trusted failure into
 * an authenticated terminal failure. A failed predecessor must never leave a
 * dependent slice looking pending (which would otherwise deadlock fan-in), and
 * no synthetic dispatch authority is minted for that dependent.
 */
function terminalizeCtoDependencyBlockedTeams(
  runtimeAccess: CtoRuntimeAccessFacade,
  root: string,
  ctoRunId: string,
  mapping: CtoSpecificationMapping,
  expected: CtoDependencyTerminalizationAuthority,
  pinnedRoot: PinnedProjectRoot,
  sessionId: string,
  validateMappingAuthority?: CtoSpecificationExecutionMappingAuthorityValidator,
): CtoDependencyFailureTerminalizationResult {
  const failed = (team: CtoState["teams"][number]): boolean => team.status === "failed";
  try {
    if (root !== pinnedRoot.canonical_root) return { status: "blocked", terminalized_team_ids: [], failed_team_ids: [], findings: ["project root changed before failed CTO dependency terminalization"] };
    assertCtoRuntimeAccessFacadeLive(runtimeAccess, root, sessionId);
    const result = runtimeAccess.withRunTransaction(ctoRunId, (transaction) => {
      if (!pinnedRoot.isStable()) return { status: "blocked", terminalized_team_ids: [], failed_team_ids: [], findings: ["project root changed before failed CTO dependency terminalization"] } as CtoDependencyFailureTerminalizationResult;
      assertCtoRuntimeAccessFacadeLive(runtimeAccess, root, sessionId);
      const state = transaction.readState();
      if (state.id !== ctoRunId) return { status: "blocked", terminalized_team_ids: [], failed_team_ids: [], findings: ["CTO dependency terminalization run identity does not match authenticated state"] } as CtoDependencyFailureTerminalizationResult;
      if (state.standby !== true && state.owner_session !== sessionId) return { status: "blocked", terminalized_team_ids: [], failed_team_ids: [], findings: ["CTO dependency terminalization session does not own the canonical run"] } as CtoDependencyFailureTerminalizationResult;
      if (!pinnedRoot.isStable()) return { status: "blocked", terminalized_team_ids: [], failed_team_ids: [], findings: ["project root changed before failed CTO dependency terminalization"] } as CtoDependencyFailureTerminalizationResult;
      const canonicalRecord = readMappingRecord(root, ctoRunId, expected.mapping_id, pinnedRoot);
      if (!canonicalRecord.ok
        || canonicalRecord.value.record_digest !== expected.mapping_record_digest
        || canonicalRecord.value.mapping.mapping_id !== expected.mapping_id
        || canonicalRecord.value.mapping.mapping_hash !== expected.mapping_hash
        || canonicalJson(canonicalRecord.value.mapping) !== canonicalJson(mapping)
        || canonicalRecord.value.mapping.status !== "confirmed") {
        return { status: "blocked", terminalized_team_ids: [], failed_team_ids: [], findings: ["CTO dependency terminalization mapping changed after outer authorization; retry with the current immutable mapping record"] } as CtoDependencyFailureTerminalizationResult;
      }
      const execution = (canonicalRecord.value.mapping as CtoSpecificationMapping & { execution?: { choice?: unknown; wave_id?: unknown; source_id?: unknown; capability_id?: unknown; capability_epoch?: unknown } }).execution;
      const wave = state.wave_history?.find((candidate) => candidate.id === expected.wave_id);
      if (!execution || execution.choice !== "cto" || execution.wave_id !== expected.wave_id
        || !wave || wave.source !== "specification-execution" || wave.status !== "active" || state.active_wave_id !== expected.wave_id
        || execution.source_id !== wave.source_id
        || execution.capability_id !== wave.work_identity?.capability_id
        || execution.capability_epoch !== wave.work_identity?.capability_epoch) {
        return { status: "blocked", terminalized_team_ids: [], failed_team_ids: [], findings: ["CTO dependency terminalization execution wave changed after outer authorization; no teams were mutated"] } as CtoDependencyFailureTerminalizationResult;
      }
      const teamById = new Map(state.teams.map((team) => [team.id, team]));
      for (const owner of mapping.task_to_slice) {
        const team = teamById.get(owner.team_id);
        const identity = team?.work_identity;
        if (!team || team.slice_id !== owner.slice_id || team.feature_id !== owner.feature_id || team.task_id !== owner.task_id
          || !identity || identity.run_id !== state.id || identity.wave_id !== expected.wave_id
          || identity.slice_id !== owner.slice_id || identity.task_id !== owner.task_id) {
          return { status: "blocked", terminalized_team_ids: [], failed_team_ids: [], findings: [`CTO dependency terminalization team binding is stale for slice '${owner.slice_id}'`] } as CtoDependencyFailureTerminalizationResult;
        }
      }
      const mappedTeamIds = new Set(mapping.task_to_slice.map((owner) => owner.team_id));
      const prerequisites = new Map<string, Set<string>>();
      const addPrerequisite = (teamId: string, prerequisiteId: string): void => {
        if (teamId === prerequisiteId || !teamById.has(teamId) || !teamById.has(prerequisiteId)) return;
        const deps = prerequisites.get(teamId) ?? new Set<string>();
        deps.add(prerequisiteId);
        prerequisites.set(teamId, deps);
      };
      for (const entry of state.plan.teams) {
        for (const dependency of entry.depends_on) addPrerequisite(entry.team, dependency);
      }
      const ownership = new Map<string, string>();
      for (const owner of mapping.task_to_slice) {
        ownership.set(JSON.stringify({ feature_id: owner.feature_id, task_id: owner.task_id }), owner.team_id);
      }
      for (const owner of mapping.task_to_slice) {
        for (const dependency of owner.depends_on) {
          const predecessor = ownership.get(JSON.stringify({ feature_id: owner.feature_id, task_id: dependency }));
          if (predecessor) addPrerequisite(owner.team_id, predecessor);
        }
      }
      // Shared-contract order is the authoritative serialization edge. It is
      // intentionally independent from dispatch order and therefore survives
      // a restart or a partial worker wave.
      for (const contract of mapping.shared_contracts) {
        if (!contract.requires_serialization) continue;
        let previous: string | undefined;
        for (const qualifiedTaskId of contract.task_ids) {
          const owner = taskOwnerForQualifiedIdentity(mapping, qualifiedTaskId);
          const teamId = owner?.team_id;
          if (!teamId) continue;
          if (previous) addPrerequisite(teamId, previous);
          previous = teamId;
        }
      }
      const terminalized: string[] = [];
      const findings: string[] = [];
      let changed = true;
      while (changed) {
        changed = false;
        for (const team of state.teams) {
          if (!mappedTeamIds.has(team.id)) continue;
          if (team.status !== "pending" && team.status !== "in_progress" && team.status !== "parked") continue;
          const blockers = [...(prerequisites.get(team.id) ?? [])]
            .map((id) => teamById.get(id))
            .filter((candidate): candidate is CtoState["teams"][number] => candidate !== undefined && failed(candidate))
            .map((candidate) => candidate.id)
            .sort();
          if (blockers.length === 0) continue;
          const identity = team.work_identity;
          if (!identity) {
            findings.push(`${team.id}: failed predecessor(s) ${blockers.join(", ")} cannot be terminalized without an engine work identity`);
            continue;
          }
          const reason = `CTO task was not dispatched because prerequisite team(s) failed: ${blockers.join(", ")}.`;
          const emittedAt = new Date().toISOString();
          const envelope: CompletionEnvelope = {
            schema_version: 1,
            identity,
            outcome: "failed",
            terminal_signal: "contract_failure",
            artifact_refs: [],
            evidence_ref: `cto-task-failure:${team.id}`,
            conflict_ref: null,
            completed_by: "engine_task_caller",
            emitted_at: emittedAt,
          };
          const validation = validateTypedControlPlane({ work_identity: identity, completion_envelope: envelope });
          if (!validation.ok) {
            findings.push(`${team.id}: engine-derived dependency failure envelope is invalid`);
            continue;
          }
          // Terminal failure consumes the provider lifecycle; no pending marker
          // may remain to make finishWave treat this blocked slice as active.
          assertCtoRuntimeAccessFacadeLive(runtimeAccess, root, sessionId);
          delete team.pending;
          team.completion_envelope = envelope;
          team.control_plane_status = { stage: "done", lifecycle: "failed", pause: "failed", reason };
          team.control_plane_provenance = {
            completion_intent: "state",
            checkpoint_policy: "state",
            roster_policy: "state",
            roster_selection: "state",
            work_identity: "state",
            pending: "none",
            child_join: "none",
            completion_envelope: "typed",
            legacy_inputs: [],
            warnings: [reason],
            status: "typed",
          };
          setTeamStatus(state, team.id, "failed");
          assertCtoRuntimeAccessFacadeLive(runtimeAccess, root, sessionId);
          terminalized.push(team.id);
          changed = true;
        }
      }
      if (findings.length > 0) return { status: "blocked", terminalized_team_ids: terminalized, failed_team_ids: state.teams.filter(failed).map((team) => team.id).sort(), findings } as CtoDependencyFailureTerminalizationResult;
      if (terminalized.length > 0) {
        if (validateMappingAuthority) {
          const canonicalRecordPath = pinnedRoot.relativePath(canonicalRecord.value.record_path);
          if (!canonicalRecordPath) return { status: "blocked", terminalized_team_ids: [], failed_team_ids: [], findings: ["canonical mapping record path is outside the pinned project root"] } as CtoDependencyFailureTerminalizationResult;
          const authorityError = validateMappingAuthority({ record: canonicalRecord.value as unknown as Record<string, unknown>, record_digest: canonicalRecord.value.record_digest, record_path: canonicalRecordPath, state, pinnedRoot });
          if (authorityError) return { status: "blocked", terminalized_team_ids: [], failed_team_ids: [], findings: [authorityError] } as CtoDependencyFailureTerminalizationResult;
        }
        assertCtoRuntimeAccessFacadeLive(runtimeAccess, root, sessionId);
        transaction.writeState(state);
        assertCtoRuntimeAccessFacadeLive(runtimeAccess, root, sessionId);
      }
      return { status: "reconciled", terminalized_team_ids: terminalized, failed_team_ids: state.teams.filter(failed).map((team) => team.id).sort(), findings: [] } as CtoDependencyFailureTerminalizationResult;
    });
    return result;
  } catch (error) {
    return { status: "blocked", terminalized_team_ids: [], failed_team_ids: [], findings: [`CTO dependency failure terminalization failed: ${error instanceof Error ? error.message : String(error)}`] };
  }
}

/**
 * Reconcile trusted worker receipts and transitively terminalize every mapped
 * dependent whose prerequisite failed. The conformance sink uses this single
 * authenticated seam so retries cannot leave dependent slices pending.
 */
export function reconcileAndTerminalizeCtoSpecificationExecutionTeams(
  projectRoot: string,
  selectors: { cto_run_id: string; mapping_id: string; mapping_hash: string },
  options: CtoSpecificationRuntimeMutationOptions,
): CtoDependencyFailureTerminalizationResult {
  const pinnedRoot = PinnedProjectRoot.open(projectRoot);
  if (!pinnedRoot || !pinnedRoot.isStable()) {
    pinnedRoot?.close();
    return { status: "blocked", terminalized_team_ids: [], failed_team_ids: [], findings: ["recovery_required: project root cannot be pinned for CTO conformance reconciliation"] };
  }
  const root = pinnedRoot.canonical_root;
  try {
    assertCtoSpecificationRuntime(options, root, pinnedRoot);
    if (!isSafeCtoRunId(selectors?.cto_run_id) || !isSafeCtoExecutionId(selectors?.mapping_id) || !isSha256Hex(selectors?.mapping_hash)) {
      return { status: "blocked", terminalized_team_ids: [], failed_team_ids: [], findings: ["CTO conformance reconciliation selectors are invalid"] };
    }
    recoverPendingMappingTransactions(root, selectors.cto_run_id, pinnedRoot);
    const mapping = readMappingRecord(root, selectors.cto_run_id, selectors.mapping_id, pinnedRoot);
    if (!mapping.ok) return { status: "blocked", terminalized_team_ids: [], failed_team_ids: [], findings: [mapping.error] };
    if (mapping.value.mapping.mapping_hash !== selectors.mapping_hash || mapping.value.mapping.status !== "confirmed") {
      return { status: "blocked", terminalized_team_ids: [], failed_team_ids: [], findings: ["CTO conformance reconciliation requires the exact confirmed mapping record"] };
    }
    const executionContext = activeCtoExecutionContext(root, selectors.cto_run_id, pinnedRoot, options.sessionId);
    if (!executionContext.ok) return { status: "blocked", terminalized_team_ids: [], failed_team_ids: [], findings: [executionContext.error] };
    const preparedAuthority = prepareCtoReconciliationMappingAuthority(root, selectors.cto_run_id, mapping.value, executionContext.value, pinnedRoot);
    if (!preparedAuthority.ok) return { status: "blocked", terminalized_team_ids: [], failed_team_ids: [], findings: [preparedAuthority.error] };
    const execution = (mapping.value.mapping as CtoSpecificationMapping & { execution?: { wave_id?: unknown } }).execution;
    if (!execution || typeof execution.wave_id !== "string") return { status: "blocked", terminalized_team_ids: [], failed_team_ids: [], findings: ["CTO conformance reconciliation requires the exact execution wave binding"] };
    const reconciled = reconcileCtoSpecificationExecutionTeams(root, selectors.cto_run_id, {
      runtimeAccess: options.runtimeAccess,
      sessionId: options.sessionId,
      pinnedRoot,
      expected_mapping_authority: preparedAuthority.authority,
      validate_mapping_authority: preparedAuthority.validator,
    });
    if (reconciled.status === "blocked") {
      return { status: "blocked", terminalized_team_ids: [], failed_team_ids: [], findings: reconciled.findings };
    }
    assertCtoSpecificationRuntime(options, root, pinnedRoot);
    const terminalized = terminalizeCtoDependencyBlockedTeams(
      options.runtimeAccess,
      root,
      selectors.cto_run_id,
      mapping.value.mapping,
      { mapping_id: mapping.value.mapping.mapping_id, mapping_hash: mapping.value.mapping.mapping_hash, mapping_record_digest: mapping.value.record_digest, wave_id: execution.wave_id },
      pinnedRoot,
      options.sessionId,
      preparedAuthority.validator,
    );
    if (terminalized.status === "blocked") return terminalized;
    return terminalized;
  } catch (error) {
    return { status: "blocked", terminalized_team_ids: [], failed_team_ids: [], findings: [`recovery_required: CTO conformance reconciliation failed: ${error instanceof Error ? error.message : String(error)}`] };
  } finally {
    pinnedRoot.close();
  }
}

function topologicallyReadySlices(state: CtoState, mapping: CtoSpecificationMapping): string[] {
  const done = (sliceId: string) => state.teams.some((team) => team.slice_id === sliceId && team.status === "done");
  const ready = new Set(mapping.parallelization.filter((decision) => !done(decision.slice_id)).map((decision) => decision.slice_id));
  for (const decision of mapping.parallelization) {
    if (!ready.has(decision.slice_id)) continue;
    if (decision.depends_on_slice_ids.some((sliceId) => !done(sliceId))) ready.delete(decision.slice_id);
  }
  for (const contract of mapping.shared_contracts) {
    if (!contract.requires_serialization) continue;
    const orderedSlices = contract.task_ids.map((identity) => taskOwnerForQualifiedIdentity(mapping, identity)?.slice_id).filter((sliceId): sliceId is string => Boolean(sliceId));
    const firstIncomplete = orderedSlices.find((sliceId) => !done(sliceId));
    for (const sliceId of orderedSlices) if (sliceId !== firstIncomplete) ready.delete(sliceId);
  }
  const unboundSerial = mapping.parallelization.filter((decision) => decision.decision === "serial" && decision.shared_contract_ids.length === 0 && decision.depends_on_slice_ids.length === 0 && !done(decision.slice_id));
  for (const decision of unboundSerial.slice(1)) ready.delete(decision.slice_id);
  return mapping.parallelization.map((decision) => decision.slice_id).filter((sliceId) => ready.has(sliceId));
}

function claimAdmissionBinding(
  snapshot: CtoDispatchAdmissionSnapshot,
  pinnedRoot: PinnedProjectRoot,
  featureStateRevision: number,
): ExecutionClaimAdmissionBinding | null {
  const mappingRecordPath = pinnedRoot.relativePath(snapshot.record.record_path);
  const context = snapshot.record.confirmation_context;
  if (!mappingRecordPath || !context || !snapshot.record.checkpoint_ref || !snapshot.record.trusted_answer_ref) return null;
  if (!Number.isSafeInteger(featureStateRevision) || featureStateRevision < 0) return null;
  return {
    mapping_record_path: mappingRecordPath,
    mapping_record_digest: snapshot.record.record_digest,
    mapping_id: snapshot.record.mapping.mapping_id,
    mapping_hash: snapshot.record.mapping.mapping_hash,
    mapping_version: snapshot.record.mapping.mapping_version,
    confirmation_state_revision: snapshot.anchor.stateRevision,
    feature_state_revision: featureStateRevision,
    confirmation_state_digest: snapshot.anchor.rawDigest,
    confirmation_authorization_digest: snapshot.authorization_projection_digest,
    confirmation_ledger_digest: snapshot.anchor.ledgerDigest,
    checkpoint_ref: snapshot.record.checkpoint_ref,
    trusted_answer_ref: snapshot.record.trusted_answer_ref,
    stage_id: context.stage_id,
    policy_hash: context.policy_hash,
    wave_id: snapshot.execution.wave_id,
    capability_id: snapshot.execution.capability_id,
    capability_epoch: snapshot.execution.capability_epoch,
  };
}

type CtoRollbackOutcome = { errors: string[]; surviving: ExecutionClaim[]; recovery_required?: boolean };

function rollbackCtoDispatchClaims(
  root: string,
  pinnedRoot: PinnedProjectRoot,
  claims: readonly ExecutionClaim[],
  prepared: ReadonlyArray<{ selection: CtoSpecificationExecutionSelection; workspace: FeatureWorkspace; handoff: ImplementationHandoff }>,
  reason: string,
  assertRuntimeLive: () => void,
): CtoRollbackOutcome {
  const errors: string[] = [];
  const surviving: ExecutionClaim[] = [];
  const recoverLiveClaims = (): ExecutionClaim[] => {
    const recovered: ExecutionClaim[] = [];
    for (const claim of claims) {
      const owner = prepared.find((entry) => entry.handoff.handoff_digest === claim.handoff_digest);
      if (!owner) {
        recovered.push(claim);
        continue;
      }
      const current = readCurrentExecutionClaim(root, owner.selection.feature_id, pinnedRoot);
      if (!current.ok || (current.value && current.value.claim_id === claim.claim_id && isLiveExecutionClaim(current.value))) {
        recovered.push(current.ok && current.value ? current.value : claim);
      }
    }
    return recovered;
  };
  for (const claim of [...claims].reverse()) {
    try {
      assertRuntimeLive();
    } catch (error) {
      const recovered = recoverLiveClaims();
      for (const candidate of recovered) if (!surviving.some((item) => item.claim_id === candidate.claim_id)) surviving.push(candidate);
      errors.push(`recovery_required: runtime access was revoked before claim rollback: ${error instanceof Error ? error.message : String(error)}`);
      return { errors, surviving, recovery_required: true };
    }
    const owner = prepared.find((entry) => entry.handoff.handoff_digest === claim.handoff_digest);
    if (!owner) {
      errors.push(`claim ${claim.claim_id} has no prepared feature owner for admission rollback`);
      surviving.push(claim);
      continue;
    }
    assertRuntimeLive();
    let released = releaseExecutionClaim(root, owner.selection.feature_id, {
      claim_id: claim.claim_id,
      handoff_digest: claim.handoff_digest,
      owner_kind: claim.owner_kind,
      owner_run_id: claim.owner_run_id,
      reason: reason.trim() || "CTO dispatch admission rollback",
    }, pinnedRoot);
    if (!released.ok) {
      // The claim transition already retries its workspace CAS. This second
      // call covers a transient journal/lock seam without hiding a surviving
      // authority if the exact release still cannot be proven.
      try {
        assertRuntimeLive();
      } catch (error) {
        const recovered = recoverLiveClaims();
        for (const candidate of recovered) if (!surviving.some((item) => item.claim_id === candidate.claim_id)) surviving.push(candidate);
        errors.push(`recovery_required: runtime access was revoked before claim rollback retry: ${error instanceof Error ? error.message : String(error)}`);
        return { errors, surviving, recovery_required: true };
      }
      released = releaseExecutionClaim(root, owner.selection.feature_id, {
        claim_id: claim.claim_id,
        handoff_digest: claim.handoff_digest,
        owner_kind: claim.owner_kind,
        owner_run_id: claim.owner_run_id,
        reason: reason.trim() || "CTO dispatch admission rollback",
      }, pinnedRoot);
    }
    const current = readCurrentExecutionClaim(root, owner.selection.feature_id, pinnedRoot);
    if (!current.ok) {
      errors.push(`claim ${claim.claim_id} rollback authority read failed: ${current.error}`);
      surviving.push(claim);
      continue;
    }
    if (current.value && current.value.claim_id === claim.claim_id && isLiveExecutionClaim(current.value)) {
      surviving.push(current.value);
    } else if (!released.ok) {
      // A released journal tail intentionally reads as no authority even
      // while the workspace CAS is stranded. Inspect the exact selected
      // workspace so rollback never hides that surviving created claim.
      const workspace = resolveFeatureWorkspace(root, owner.selection, workspaceSnapshotForPinnedRoot(pinnedRoot));
      if (workspace.ok && workspace.value.execution_claim_ref === claim.claim_id) surviving.push(claim);
    }
    if (!released.ok) errors.push(`claim ${claim.claim_id} rollback failed: ${released.error}`);
  }
  return { errors, surviving };
}

/** Revalidate, admit, and claim a confirmed mapping without dispatching tasks. */
async function dispatchCtoSpecificationMappingUnlocked(
  projectRoot: string,
  input: CtoSpecificationMappingDispatchInput,
  pinnedRoot: PinnedProjectRoot,
  assertRuntimeLive: () => void,
  sessionId?: string,
): Promise<CtoSpecificationMappingDispatchResult> {
  let rollbackAfterClaimFailure: ((reason: string) => CtoSpecificationMappingDispatchResult) | null = null;
  try {
  assertRuntimeLive();
  if (!pinnedRoot.isStable()) return blockedExecution(["project root changed before CTO dispatch"]);
  const root = pinnedRoot.canonical_root;
  if (!input || !isSafeCtoRunId(input.cto_run_id) || !isSafeCtoExecutionId(input.mapping_id) || typeof input.expected_mapping_hash !== "string" || input.expected_mapping_hash.trim().length === 0) return blockedExecution(["dispatch identity and expected_mapping_hash must be explicit and non-blank"]);
  try {
    assertRuntimeLive();
    recoverPendingMappingTransactions(root, input.cto_run_id, pinnedRoot);
  } catch (error) {
    return blockedExecution([`mapping recovery failed: ${error instanceof Error ? error.message : String(error)}`]);
  }
  if (!pinnedRoot.isStable()) return blockedExecution(["project root changed before dispatch mapping read"]);
  const initialAdmission = readDispatchAdmissionSnapshot(
    root,
    input.cto_run_id,
    input.mapping_id,
    input.expected_mapping_hash,
    pinnedRoot,
    undefined,
    sessionId,
  );
  if (!initialAdmission.ok) return blockedExecution([initialAdmission.error]);
  let admissionSnapshot = initialAdmission.value;
  const record = admissionSnapshot.record;
  const checkpointRef = record.checkpoint_ref!;
  const trustedAnswerRef = record.trusted_answer_ref!;
  let execution: { ok: true; value: CtoExecutionContext } = { ok: true, value: admissionSnapshot.execution };
  const prepared: Array<{ selection: CtoSpecificationExecutionSelection; workspace: FeatureWorkspace; handoff: ImplementationHandoff }> = [];
  for (const selection of record.selections) {
    const binding = record.mapping.handoff_bindings.find((candidate) => candidate.feature_id === selection.feature_id);
    if (!binding) return blockedExecution([`mapping lacks a frozen handoff binding for '${selection.feature_id}'`]);
    const loadedHandoff = loadHandoff(root, selection, binding.handoff_digest, pinnedRoot);
    if (!loadedHandoff.ok) return blockedExecution([loadedHandoff.error]);
    prepared.push({ selection, workspace: loadedHandoff.workspace, handoff: loadedHandoff.handoff });
  }
  let currentMapping: CtoSpecificationMapping;
  try {
    currentMapping = buildCtoSpecificationMapping({
      cto_run_id: input.cto_run_id,
      execution: { wave_id: execution.value.wave_id, source_id: execution.value.source_id, capability_id: execution.value.capability_id, capability_epoch: execution.value.capability_epoch, choice: "cto" },
      selections: prepared.map((entry) => ({ feature_id: entry.selection.feature_id, run_key: entry.selection.run_key, handoff: entry.handoff })),
    });
  } catch (error) { return blockedExecution([`mapping reconstruction failed: ${error instanceof Error ? error.message : String(error)}`]); }
  if (!sameFrozenMapping(record.mapping, currentMapping)) return blockedExecution(["mapping changed since confirmation; exact run/wave/capability/selectors/handoffs/contracts are required"]);
  const sliceContextError = executionSlicesError(execution.value, record.mapping);
  if (sliceContextError) return blockedExecution([sliceContextError]);

  const mappingRecordFile = record.record_path;
  const mappingRecordDigest = record.record_digest;

  let readySlices = topologicallyReadySlices(execution.value.state, record.mapping);
  const outcomes: CtoSpecificationFeatureDispatchOutcome[] = [];
  const claims: ExecutionClaim[] = [];
  const rollbackClaims: ExecutionClaim[] = [];
  // Keep all successful acquisitions for the response; compensate only claims created here.
  const admittedSlices: string[] = [];
  const findings: string[] = [];
  let rollbackAttempted = false;
  let rollbackSurviving: ExecutionClaim[] = [];
  const abortAfterClaimFailure = (reason: string): CtoSpecificationMappingDispatchResult => {
    if (rollbackAttempted) return { status: "blocked", dispatched: false, outcomes, findings: [reason, "claim rollback was already attempted"], ...(rollbackSurviving.length > 0 ? { recovery_claims: rollbackSurviving } : {}) };
    rollbackAttempted = true;
    const rollback = rollbackCtoDispatchClaims(root, pinnedRoot, rollbackClaims, prepared, reason, assertRuntimeLive);
    rollbackSurviving = rollback.surviving;
    const findingsWithRecovery = rollback.surviving.length > 0
      ? [...rollback.errors, `exact created claim authority survives rollback: ${rollback.surviving.map((claim) => claim.claim_id).join(", ")}`]
      : rollback.errors;
    if (rollback.recovery_required && !findingsWithRecovery.some((finding) => finding.startsWith("recovery_required:"))) {
      findingsWithRecovery.push("recovery_required: claim rollback was not attempted after RuntimeAccess revocation");
    }
    return {
      status: "blocked",
      dispatched: false,
      outcomes,
      findings: [reason, ...findingsWithRecovery],
      ...(rollbackSurviving.length > 0 ? { recovery_claims: rollbackSurviving } : {}),
    };
  };
  rollbackAfterClaimFailure = abortAfterClaimFailure;
  // A terminal worker wave (successful or failed) can be replayed after a process restart. Reissue
  // the exact fan-in authority from existing claims; never acquire a second
  // claim merely because the in-memory dispatch result was lost.
  const allSlicesTerminal = record.mapping.parallelization.length > 0
    && record.mapping.parallelization.every((decision) =>
      execution.value.state.teams.some((team) => team.slice_id === decision.slice_id && (team.status === "done" || team.status === "failed")));
  if (allSlicesTerminal) {
    const replayClaims: ExecutionClaim[] = [];
    for (const entry of prepared) {
      const current = readCurrentExecutionClaim(root, entry.selection.feature_id, pinnedRoot);
      if (!current.ok || !current.value || !isLiveExecutionClaim(current.value)
        || current.value.owner_kind !== "cto"
        || current.value.owner_run_id !== input.cto_run_id
        || current.value.handoff_digest !== entry.handoff.handoff_digest
        || entry.workspace.execution_claim_ref !== current.value.claim_id) {
        return blockedExecution([`${entry.selection.feature_id}: completed worker wave has no exact live CTO execution claim to replay`]);
      }
      replayClaims.push(current.value);
      const featureFailed = execution.value.state.teams.some((team) =>
        team.feature_id === entry.selection.feature_id && team.status === "failed");
      outcomes.push({
        feature_id: entry.selection.feature_id,
        run_key: entry.selection.run_key,
        status: featureFailed ? "blocked" : "claimed",
        admitted_slice_ids: [],
        claim: current.value,
        disposition: "replayed",
        ...(featureFailed ? { finding: "one or more CTO task slices reached an authenticated terminal failure" } : {}),
        lead_contract: ctoLeadEvidenceContract(entry.handoff, current.value, entry.workspace.profile_hash),
      });
    }
    if (!pinnedRoot.isStable()) return blockedExecution(["project root changed before replay conformance binding"]);
    const finalAdmission = readDispatchAdmissionSnapshot(root, input.cto_run_id, input.mapping_id, input.expected_mapping_hash, pinnedRoot, admissionSnapshot, sessionId);
    if (!finalAdmission.ok) return blockedExecution([finalAdmission.error]);
    admissionSnapshot = finalAdmission.value;
    execution = { ok: true, value: admissionSnapshot.execution };
    const conformanceExecution = activeCtoExecutionContext(root, input.cto_run_id, pinnedRoot, sessionId);
    if (!conformanceExecution.ok || !sameExecutionContext(execution.value, conformanceExecution.value)) {
      return blockedExecution([conformanceExecution.ok ? "active CTO execution wave/capability changed before replay conformance binding" : conformanceExecution.error]);
    }
    execution = conformanceExecution;
    const conformanceSliceError = executionSlicesError(execution.value, record.mapping);
    if (conformanceSliceError) return blockedExecution([conformanceSliceError]);
    assertRuntimeLive();
    const terminalTeams = computeCtoTerminalTeamsDigest(execution.value.state, record.mapping, record.selections);
    if (!terminalTeams.ok) return blockedExecution([`cannot issue terminal CTO conformance authority: ${terminalTeams.error}`]);
    assertRuntimeLive();
    const conformanceBinding = issueCtoSpecificationConformanceBinding({
      project_root: root,
      cto_run_id: input.cto_run_id,
      mapping_id: record.mapping.mapping_id,
      mapping_hash: record.mapping.mapping_hash,
      mapping_record_path: mappingRecordFile,
      mapping_record_digest: mappingRecordDigest,
      checkpoint_id: checkpointRef,
      trusted_answer_id: trustedAnswerRef,
      active_claims_digest: ctoConformanceClaimsDigest(replayClaims),
      terminal_teams_digest: terminalTeams.digest,
    });
    if (!pinnedRoot.isStable()) return blockedExecution(["project root changed before returning replay dispatch result"]);
    const failedSlices = execution.value.state.teams
      .filter((team) => team.status === "failed" && team.slice_id !== undefined)
      .map((team) => team.slice_id!)
      .filter((sliceId) => record.mapping.parallelization.some((decision) => decision.slice_id === sliceId))
      .sort();
    return {
      status: "dispatched",
      dispatched: true,
      mapping: record.mapping,
      mapping_digest: mappingRecordDigest,
      admitted_slices: [],
      claims: replayClaims,
      outcomes,
      conformance_binding: conformanceBinding,
      findings: failedSlices.length > 0
        ? ["replayed exact CTO conformance authority after terminal worker failure", `terminal failed slices: ${failedSlices.join(", ")}`]
        : ["replayed exact CTO conformance authority after worker completion"],
    };
  }
  for (const entry of prepared) {
    if (claims.length > 0) {
      const refreshedAdmission = readDispatchAdmissionSnapshot(root, input.cto_run_id, input.mapping_id, input.expected_mapping_hash, pinnedRoot, admissionSnapshot, sessionId);
      if (!refreshedAdmission.ok) return abortAfterClaimFailure(refreshedAdmission.error);
      admissionSnapshot = refreshedAdmission.value;
      execution = { ok: true, value: admissionSnapshot.execution };
      readySlices = topologicallyReadySlices(execution.value.state, record.mapping);
    }
    const featureSlices = record.mapping.task_to_slice.filter((owner) => owner.feature_id === entry.selection.feature_id).map((owner) => owner.slice_id);
    const admitted = readySlices.filter((sliceId) => featureSlices.includes(sliceId));
    if (admitted.length === 0) {
      const finding = "predecessor or shared-contract owner has not completed";
      outcomes.push({ feature_id: entry.selection.feature_id, run_key: entry.selection.run_key, status: "not_ready", admitted_slice_ids: [], finding });
      continue;
    }
    let admissionFailure: string | null = null;
    for (const sliceId of admitted) {
      const gate = assertCtoSliceDispatchable(execution.value.state, { sliceId, markerRunId: input.cto_run_id, pinnedRoot });
      if (!gate.ok) { admissionFailure = gate.reason; break; }
    }
    if (admissionFailure) {
      const finding = admissionFailure;
      if (claims.length > 0) return abortAfterClaimFailure(`${entry.selection.feature_id}: ${finding}`);
      outcomes.push({ feature_id: entry.selection.feature_id, run_key: entry.selection.run_key, status: "blocked", admitted_slice_ids: [], finding });
      findings.push(`${entry.selection.feature_id}: ${finding}`);
      continue;
    }
    let handoffForClaim = entry.handoff;
    if (entry.workspace.source_kind === "external" || handoffForClaim.source_kind === "external") {
      const binding = entry.workspace.constitution_binding;
      if (!binding) {
        const finding = "SPEC_CONSTITUTION_IMPACT_PENDING: current constitution binding is missing";
        if (claims.length > 0) return abortAfterClaimFailure(`${entry.selection.feature_id}: ${finding}`);
        outcomes.push({ feature_id: entry.selection.feature_id, run_key: entry.selection.run_key, status: "blocked", admitted_slice_ids: [], finding });
        findings.push(`${entry.selection.feature_id}: ${finding}`);
        continue;
      }
      const revalidationInput: ImportedHandoffFilesystemDispatchInput = {
        handoff: handoffForClaim,
        project_root: root,
        run_key: entry.selection.run_key,
        constitution_binding: binding,
        pinned_root: pinnedRoot,
      };
      assertRuntimeLive();
      if (!pinnedRoot.isStable()) return abortAfterClaimFailure(`${entry.selection.feature_id}: project root changed before imported handoff revalidation`);
      const revalidated = await revalidateImportedHandoffForDispatch(revalidationInput);
      assertRuntimeLive();
      if (!pinnedRoot.isStable()) return abortAfterClaimFailure(`${entry.selection.feature_id}: project root changed during handoff revalidation`);
      const refreshedAdmission = readDispatchAdmissionSnapshot(root, input.cto_run_id, input.mapping_id, input.expected_mapping_hash, pinnedRoot, admissionSnapshot, sessionId);
      if (!refreshedAdmission.ok) return abortAfterClaimFailure(`${entry.selection.feature_id}: ${refreshedAdmission.error}`);
      admissionSnapshot = refreshedAdmission.value;
      execution = { ok: true, value: admissionSnapshot.execution };
      readySlices = topologicallyReadySlices(execution.value.state, record.mapping);
      if (!revalidated.ok) {
        assertRuntimeLive();
        const persistErrors = persistImportedWorkspaceStale(root, entry.workspace, revalidated.findings, pinnedRoot);
        const detail = revalidated.findings.map((finding) => `${finding.code}: ${finding.message}`).join("; ");
        const finding = `SPEC_STALE: ${detail || "external source binding changed"}${persistErrors.length ? `; ${persistErrors.join("; ")}` : ""}`;
        outcomes.push({ feature_id: entry.selection.feature_id, run_key: entry.selection.run_key, status: "blocked", admitted_slice_ids: [], finding });
        findings.push(`${entry.selection.feature_id}: ${finding}`);
        if (claims.length > 0) return abortAfterClaimFailure(`${entry.selection.feature_id}: ${finding}`);
        continue;
      }
      handoffForClaim = revalidated.handoff;
    }
    assertRuntimeLive();
    await ctoExecutionAwaitBoundary(root, pinnedRoot, input.cto_run_id);
    assertRuntimeLive();
    if (!pinnedRoot.isStable()) return abortAfterClaimFailure(`${entry.selection.feature_id}: project root changed after execution await`);
    const postAwaitAdmission = readDispatchAdmissionSnapshot(root, input.cto_run_id, input.mapping_id, input.expected_mapping_hash, pinnedRoot, admissionSnapshot, sessionId);
    if (!postAwaitAdmission.ok) return abortAfterClaimFailure(`${entry.selection.feature_id}: ${postAwaitAdmission.error}`);
    admissionSnapshot = postAwaitAdmission.value;
    execution = { ok: true, value: admissionSnapshot.execution };
    readySlices = topologicallyReadySlices(execution.value.state, record.mapping);
    // Reload after the final await and compare to the mapping-frozen digest;
    // never claim an older in-memory handoff after a concurrent rewrite.
    const finalLoaded = loadHandoff(root, entry.selection, entry.handoff.handoff_digest, pinnedRoot);
    if (!finalLoaded.ok) {
      assertRuntimeLive();
      const persistErrors = entry.workspace.source_kind === "external" || entry.handoff.source_kind === "external"
        ? persistImportedWorkspaceStale(root, entry.workspace, [{ code: "SPEC_HANDOFF_STALE", message: finalLoaded.error }], pinnedRoot)
        : [];
      const finding = `SPEC_STALE: ${finalLoaded.error}${persistErrors.length ? `; ${persistErrors.join("; ")}` : ""}`;
      outcomes.push({ feature_id: entry.selection.feature_id, run_key: entry.selection.run_key, status: "blocked", admitted_slice_ids: [], finding });
      findings.push(`${entry.selection.feature_id}: ${finding}`);
      if (claims.length > 0) return abortAfterClaimFailure(`${entry.selection.feature_id}: ${finding}`);
      continue;
    }
    handoffForClaim = finalLoaded.handoff;
    if (!pinnedRoot.isStable()) return abortAfterClaimFailure(`${entry.selection.feature_id}: project root changed before execution claim admission`);
    const claimAdmission = readDispatchAdmissionSnapshot(root, input.cto_run_id, input.mapping_id, input.expected_mapping_hash, pinnedRoot, admissionSnapshot, sessionId);
    if (!claimAdmission.ok) return abortAfterClaimFailure(`${entry.selection.feature_id}: ${claimAdmission.error}`);
    admissionSnapshot = claimAdmission.value;
    const claimReadySlices = readySlices;
    if (admitted.some((sliceId) => !claimReadySlices.includes(sliceId))) {
      const finding = "predecessor or shared-contract owner changed before claim admission";
      outcomes.push({ feature_id: entry.selection.feature_id, run_key: entry.selection.run_key, status: "not_ready", admitted_slice_ids: [], finding });
      continue;
    }
    for (const sliceId of admitted) {
      const gate = assertCtoSliceDispatchable(execution.value.state, { sliceId, markerRunId: input.cto_run_id, pinnedRoot });
      if (!gate.ok) return abortAfterClaimFailure(`${entry.selection.feature_id}: ${gate.reason}`);
    }
    const featureAdmission = readPinnedFeatureState(root, entry.selection.feature_id, entry.selection.run_key, pinnedRoot);
    if (!featureAdmission.ok) return abortAfterClaimFailure(`${entry.selection.feature_id}: ${featureAdmission.error}`);
    const workspaceAlreadyV3 = featureAdmission.value.state.specification?.schema_version === 3
      && Boolean(featureAdmission.value.state.specification.path_binding?.execution_claim)
      && Boolean(featureAdmission.value.state.specification.path_binding?.execution_claim_next)
      && featureAdmission.value.state.specification.execution_claim_prepare_ref !== undefined;
    const predictedClaimedFeatureStateRevision = featureAdmission.value.stateRevision + (workspaceAlreadyV3 ? 2 : 3);
    let claimedFeatureStateRevision = predictedClaimedFeatureStateRevision;
    let admissionBinding = claimAdmissionBinding(admissionSnapshot, pinnedRoot, claimedFeatureStateRevision);
    if (!admissionBinding) return abortAfterClaimFailure(`${entry.selection.feature_id}: canonical admission binding path or confirmation references are unsafe`);
    // A replayed active claim must carry the exact current mapping/confirmation
    // authority and the unchanged feature-state revision. Never apply the
    // newly-created claim's +2/+3 revision prediction to that path.
    if (finalLoaded.workspace.execution_claim_ref) {
      const existing = readCurrentExecutionClaim(root, entry.selection.feature_id, pinnedRoot);
      if (!existing.ok) return abortAfterClaimFailure(`${entry.selection.feature_id}: ${existing.error}`);
      if (!existing.value || !isLiveExecutionClaim(existing.value)
        || existing.value.claim_id !== finalLoaded.workspace.execution_claim_ref
        || existing.value.owner_kind !== "cto"
        || existing.value.owner_run_id !== input.cto_run_id
        || existing.value.handoff_digest !== handoffForClaim.handoff_digest
        || !existing.value.admission_binding) {
        return abortAfterClaimFailure(`${entry.selection.feature_id}: workspace claim reference is missing or foreign`);
      }
      const existingClaim = existing.value;
      const replayBinding = claimAdmissionBinding(admissionSnapshot, pinnedRoot, featureAdmission.value.stateRevision);
      const replayBindingDifferences = replayBinding && existingClaim.admission_binding
        ? Object.keys({ ...existingClaim.admission_binding, ...replayBinding }).filter((key) =>
          !["confirmation_state_revision", "confirmation_state_digest"].includes(key)
          && canonicalJson((existingClaim.admission_binding as unknown as Record<string, unknown>)[key]) !== canonicalJson((replayBinding as unknown as Record<string, unknown>)[key]))
        : [];
      if (!replayBinding || replayBindingDifferences.length > 0) {
        return abortAfterClaimFailure(`${entry.selection.feature_id}: replay claim admission binding is stale or foreign${replayBindingDifferences.length > 0 ? ` (${replayBindingDifferences.join(",")})` : ""}`);
      }
      claimedFeatureStateRevision = featureAdmission.value.stateRevision;
      admissionBinding = existingClaim.admission_binding!;
    }
    assertRuntimeLive();
    const acquired = acquireExecutionClaim(root, entry.selection.feature_id, { handoff: handoffForClaim, run_key: entry.selection.run_key, owner_kind: "cto", owner_run_id: input.cto_run_id, expected_workspace_digest: workspaceAdmissionDigest(finalLoaded.workspace, pinnedRoot.canonical_root), admission_binding: admissionBinding }, pinnedRoot);
    if (!acquired.ok) {
      const finding = `${acquired.code}: ${acquired.error}`;
      outcomes.push({ feature_id: entry.selection.feature_id, run_key: entry.selection.run_key, status: "blocked", admitted_slice_ids: [], ...(acquired.claim ? { claim: acquired.claim } : {}), finding });
      findings.push(`${entry.selection.feature_id}: ${finding}`);
      if (claims.length > 0) return abortAfterClaimFailure(`${entry.selection.feature_id}: ${finding}`);
      continue;
    }
    claims.push(acquired.value);
    if (acquired.disposition === "created") rollbackClaims.push(acquired.value);
    const postClaimFeature = readPinnedFeatureState(root, entry.selection.feature_id, entry.selection.run_key, pinnedRoot);
    if (!postClaimFeature.ok) return abortAfterClaimFailure(`${entry.selection.feature_id}: ${postClaimFeature.error}`);
    const acquiredBinding = acquired.value.admission_binding;
    if (!acquiredBinding) return abortAfterClaimFailure(`${entry.selection.feature_id}: acquired claim has no admission binding`);
    const expectedPostClaimRevision = acquired.disposition === "replayed"
      ? featureAdmission.value.stateRevision
      : claimedFeatureStateRevision;
    if (
      acquiredBinding.feature_state_revision !== expectedPostClaimRevision
      || postClaimFeature.value.stateRevision !== expectedPostClaimRevision
    ) {
      return abortAfterClaimFailure(`${entry.selection.feature_id}: feature state revision changed after claim admission (expected ${expectedPostClaimRevision}, got ${postClaimFeature.value.stateRevision})`);
    }
    admissionBinding = acquiredBinding;
    const claimedAdmission = readDispatchAdmissionSnapshot(root, input.cto_run_id, input.mapping_id, input.expected_mapping_hash, pinnedRoot, undefined, sessionId);
    if (!claimedAdmission.ok) return abortAfterClaimFailure(`${entry.selection.feature_id}: ${claimedAdmission.error}`);
    admissionSnapshot = claimedAdmission.value;
    execution = { ok: true, value: admissionSnapshot.execution };
    outcomes.push({ feature_id: entry.selection.feature_id, run_key: entry.selection.run_key, status: "claimed", admitted_slice_ids: admitted, claim: acquired.value, disposition: acquired.disposition, lead_contract: ctoLeadEvidenceContract(entry.handoff, acquired.value, finalLoaded.workspace.profile_hash) });
    admittedSlices.push(...admitted);
  }
  if (claims.length === 0) return { status: "blocked", dispatched: false, outcomes, findings: findings.length > 0 ? findings : ["no topologically ready specification slices are dispatchable"] };
  const finalAdmission = readDispatchAdmissionSnapshot(root, input.cto_run_id, input.mapping_id, input.expected_mapping_hash, pinnedRoot, admissionSnapshot, sessionId);
  if (!finalAdmission.ok) return abortAfterClaimFailure(finalAdmission.error);
  admissionSnapshot = finalAdmission.value;
  execution = { ok: true, value: admissionSnapshot.execution };
  assertRuntimeLive();
  if (!pinnedRoot.isStable()) return abortAfterClaimFailure("project root changed before returning dispatch result");
  // Newly admitted slices are handed to workers first. The conformance
  // authority is issued only by the all-slices-terminal replay path above,
  // after every exact team completion receipt has settled.
  return { status: "dispatched", dispatched: true, mapping: record.mapping, mapping_digest: mappingRecordDigest, admitted_slices: admittedSlices, claims, outcomes, findings };
  } catch (error) {
    const reason = `CTO dispatch failed: ${error instanceof Error ? error.message : String(error)}`;
    return rollbackAfterClaimFailure ? rollbackAfterClaimFailure(reason) : blockedExecution([reason]);
  }
}

export interface CtoSpecificationMappingDispatchOptions {
  /** Genuine live runtime capability bound to the same canonical project root. */
  runtimeAccess: CtoRuntimeAccessFacade;
  /** Exact host session identity used to resolve the runtime capability. */
  sessionId: string;
}

export async function dispatchCtoSpecificationMapping(
  projectRoot: string,
  input: CtoSpecificationMappingDispatchInput,
  options: CtoSpecificationMappingDispatchOptions,
): Promise<CtoSpecificationMappingDispatchResult> {
  const pinnedRoot = PinnedProjectRoot.open(projectRoot);
  if (!pinnedRoot) return blockedExecution(["project root is missing or cannot be canonicalized"]);
  const root = pinnedRoot.canonical_root;
  const runtimeAccess = options.runtimeAccess;
  if (!runtimeAccess) {
    pinnedRoot.close();
    return blockedExecution(["recovery_required: live RuntimeAccess is required for authoritative CTO dispatch"]);
  }
  try {
    assertCtoRuntimeAccessFacadeLive(runtimeAccess, root, options.sessionId);
    runtimeAccess.assertProjectRoot(root);
    runtimeAccess.assertLive();
    if (!pinnedRoot.isStable()) return blockedExecution(["project root changed before CTO dispatch"]);
    if (!input || !isSafeCtoRunId(input.cto_run_id)) return blockedExecution(["dispatch identity and expected_mapping_hash must be explicit and non-blank"]);
    const ownerExecution = activeCtoExecutionContext(root, input.cto_run_id, pinnedRoot, options.sessionId);
    if (!ownerExecution.ok) return blockedExecution([ownerExecution.error]);
    const mapping = readMappingRecord(root, input.cto_run_id, input.mapping_id, pinnedRoot);
    if (!mapping.ok) return blockedExecution([mapping.error]);
    if (mapping.value.mapping.mapping_hash !== input.expected_mapping_hash) return blockedExecution(["mapping hash mismatch"]);
    if (mappingConfirmationRequired(mapping.value)) return blockedExecution(["mapping confirmation is required before execution dispatch"]);
    const constitutionFindings = ensureCtoExecutionConstitutions(root, mapping.value.selections, pinnedRoot);
    if (constitutionFindings.length > 0) return blockedExecution(constitutionFindings);
    const executionForTerminalization = (mapping.value.mapping as CtoSpecificationMapping & { execution?: { wave_id?: unknown } }).execution;
    if (!executionForTerminalization || typeof executionForTerminalization.wave_id !== "string") return blockedExecution(["CTO dispatch requires the exact execution wave binding before dependency terminalization"]);
    const preparedAuthority = prepareCtoReconciliationMappingAuthority(root, input.cto_run_id, mapping.value, ownerExecution.value, pinnedRoot);
    if (!preparedAuthority.ok) return blockedExecution([preparedAuthority.error]);
    // Heal only authenticated terminal task receipts before taking the
    // dispatch lock. The reconciler owns its RuntimeAccess transaction; the
    // dispatch transaction below rereads the resulting durable CTO state.
    const reconciled = reconcileCtoSpecificationExecutionTeams(root, input.cto_run_id, { runtimeAccess, pinnedRoot, sessionId: options.sessionId, expected_mapping_authority: preparedAuthority.authority, validate_mapping_authority: preparedAuthority.validator });
    if (reconciled.status === "blocked") return blockedExecution(reconciled.findings);
    // Dependency terminalization owns a separate authenticated transaction and
    // must complete before the dispatch run lock is acquired. The locked
    // dispatch seam then rereads the exact postimage and cannot deadlock by
    // re-entering RuntimeAccess.withRunTransaction.
    const failedTerminalization = terminalizeCtoDependencyBlockedTeams(
      runtimeAccess,
      root,
      input.cto_run_id,
      mapping.value.mapping,
      { mapping_id: mapping.value.mapping.mapping_id, mapping_hash: mapping.value.mapping.mapping_hash, mapping_record_digest: mapping.value.record_digest, wave_id: executionForTerminalization.wave_id },
      pinnedRoot,
      options.sessionId,
      preparedAuthority.validator,
    );
    if (failedTerminalization.status === "blocked") return blockedExecution(failedTerminalization.findings);
    const assertRuntimeLive = () => {
      assertCtoRuntimeAccessFacadeLive(runtimeAccess, root, options.sessionId);
      runtimeAccess.assertProjectRoot(root);
      runtimeAccess.assertLive();
    };
    assertRuntimeLive();
    const result = await withCtoRunLockAsync(root, input.cto_run_id, () => dispatchCtoSpecificationMappingUnlocked(root, input, pinnedRoot, assertRuntimeLive, options.sessionId), { pinnedRoot });
    assertRuntimeLive();
    if (!pinnedRoot.isStable()) return blockedExecution(["project root changed during CTO dispatch"]);
    return result;

  } catch (error) {
    return blockedExecution([`recovery_required: CTO dispatch runtime transaction failed: ${error instanceof Error ? error.message : String(error)}`]);
  } finally {
    pinnedRoot.close();
  }
}
export interface CtoSpecificationExecutionWaveCompletion {
  feature_id: string;
  run_key: string;
  handoff_digest: string;
  conformance_id: string;
}

export interface CtoSpecificationExecutionWaveCloseInput {
  cto_run_id: string;
  wave_id: string;
  mapping_id: string;
  mapping_digest: string;
  completions: readonly CtoSpecificationExecutionWaveCompletion[];
}

export type CtoSpecificationExecutionWaveCloseResult =
  | {
    status: "closed";
    closed: true;
    replayed: boolean;
    cto_run_id: string;
    wave_id: string;
    mapping_id: string;
    mapping_digest: string;
    feature_ids: string[];
    outcome: "pass" | "blocked";
    blocked_feature_ids: string[];
    findings: string[];
  }
  | {
    status: "blocked";
    closed: false;
    replayed: false;
    findings: string[];
  };

function blockedCtoWaveClose(findings: readonly string[]): CtoSpecificationExecutionWaveCloseResult {
  return { status: "blocked", closed: false, replayed: false, findings: [...findings] };
}
/**
A non-passing conformance result is terminally actionable only when it carries
at least one current, dereferenceable worker/quality-gate artifact. A
caller-authored matrix containing only blocking prose must not be able to
terminalize a CTO wave.
 */
export type CtoSpecificationExecutionWaveClosePreparationResult =
  | { status: "ready"; input: CtoSpecificationExecutionWaveCloseInput }
  | { status: "blocked"; findings: string[] };

/**
 * Reconstruct the exact all-feature close envelope after a CTO completion
 * finalizer. This returns ready only when every selected workspace already
 * exposes its immutable handoff and passing conformance postimage; close
 * performs the stronger claim/admission checks again before its CAS.
 */
export function deriveCtoSpecificationExecutionWaveCloseInput(
  projectRoot: string,
  envelope: {
    owner_kind: "cto";
    owner_run_key: string;
    wave_id: string;
    mapping_id: string;
    mapping_digest: string;
    feature_id: string;
    run_key: string;
    handoff_digest: string;
    conformance_id: string;
  },
): CtoSpecificationExecutionWaveClosePreparationResult {
  if (
    !envelope
    || envelope.owner_kind !== "cto"
    || !isSafeCtoRunId(envelope.owner_run_key)
    || !isSafeCtoExecutionId(envelope.wave_id)
    || !isSafeCtoExecutionId(envelope.mapping_id)
    || !isSha256Hex(envelope.mapping_digest)
    || !isSafeFeatureId(envelope.feature_id)
    || typeof envelope.run_key !== "string"
    || envelope.run_key.trim().length === 0
    || !isSha256Hex(envelope.handoff_digest)
    || !/^implementation-conformance\.[a-f0-9]{64}$/u.test(envelope.conformance_id)
  ) return { status: "blocked", findings: ["CTO completion envelope is incomplete or unsafe; exact finalizer selectors are required"] };
  const pinnedRoot = PinnedProjectRoot.open(projectRoot);
  if (!pinnedRoot || !pinnedRoot.isStable()) {
    pinnedRoot?.close();
    return { status: "blocked", findings: ["canonical project root is unavailable for CTO close preparation"] };
  }
  const root = pinnedRoot.canonical_root;
  try {
    return withCtoRunLock(root, envelope.owner_run_key, () => {
      const mappingRead = readMappingRecord(root, envelope.owner_run_key, envelope.mapping_id, pinnedRoot);
      if (!mappingRead.ok) return { status: "blocked", findings: [mappingRead.error] };
      if (mappingRead.value.record_digest !== envelope.mapping_digest) return { status: "blocked", findings: ["completion envelope mapping_digest does not match the immutable mapping record"] };
      const mapping = mappingRead.value.mapping as CtoSpecificationMapping & {
        execution_choice?: string;
        execution?: { choice?: string; wave_id?: string; source_id?: string; capability_id?: string; capability_epoch?: string };
      };
      if (
        mapping.status !== "confirmed"
        || mapping.execution_choice !== "cto"
        || mapping.execution?.choice !== "cto"
        || mapping.execution.wave_id !== envelope.wave_id
        || typeof mapping.execution.source_id !== "string"
        || mappingRead.value.selections.length === 0
      ) return { status: "blocked", findings: ["confirmed CTO mapping is not the exact requested execution wave"] };
      const completions: CtoSpecificationExecutionWaveCompletion[] = [];
      for (const selection of mappingRead.value.selections) {
        if (!selection.run_key) return { status: "blocked", findings: [`feature '${selection.feature_id}' has no exact run_key selection`] };
        const selected = readPinnedFeatureState(root, selection.feature_id, selection.run_key, pinnedRoot);
        if (!selected.ok) return { status: "blocked", findings: [selected.error] };
        const workspace = selected.value.state.specification;
        const handoff = loadHandoff(root, selection, undefined, pinnedRoot);
        if (!handoff.ok) return { status: "blocked", findings: [handoff.error] };
        if (
          !workspace
          || workspace.feature_id !== selection.feature_id
          || workspace.implementation_conformance_ref === null
          || !/^implementation-conformance\.[a-f0-9]{64}$/u.test(workspace.implementation_conformance_ref)
        ) return { status: "blocked", findings: [`feature '${selection.feature_id}' has no terminal conformance postimage; finish every selected feature first`] };
        if (workspace.status !== "completed") {
        const matrix = readArtifactPinned<ImplementationConformanceResult>(
            pinnedRoot,
            `.work-state/features/${selection.feature_id}/artifacts/implementation_conformance`,
            workspace.implementation_conformance_ref,
          );
          if (
            !matrix
            || !validateProducedArtifact("implementation_conformance", matrix).ok
            || !["blocked", "changed_intent"].includes(matrix.overall_status)
            || matrix.conformance_id !== workspace.implementation_conformance_ref
            || matrix.matrix_digest !== implementationConformanceMatrixDigest(matrix)
            || matrix.feature_id !== selection.feature_id
            || matrix.handoff_id !== handoff.handoff.handoff_id
            || matrix.handoff_digest !== handoff.handoff.handoff_digest
            || matrix.profile_hash !== workspace.profile_hash
          ) return { status: "blocked", findings: [`feature '${selection.feature_id}' has no terminal conformance postimage; finish every selected feature first`] };
          if (!["claimed", "executing", "completion_validating", "completion_blocked"].includes(workspace.status)) {
            return { status: "blocked", findings: [`feature '${selection.feature_id}' has no terminal conformance postimage; finish every selected feature first`] };
          }
        }
        const frozen = mapping.handoff_bindings.find((binding) => binding.feature_id === selection.feature_id);
        if (!frozen || frozen.handoff_digest !== handoff.handoff.handoff_digest) {
          return { status: "blocked", findings: [`feature '${selection.feature_id}' handoff digest is not the frozen mapping postimage`] };
        }
        completions.push({
          feature_id: selection.feature_id,
          run_key: selection.run_key,
          handoff_digest: handoff.handoff.handoff_digest,
          conformance_id: workspace.implementation_conformance_ref,
        });
      }
      return {
        status: "ready",
        input: {
          cto_run_id: envelope.owner_run_key,
          wave_id: envelope.wave_id,
          mapping_id: envelope.mapping_id,
          mapping_digest: envelope.mapping_digest,
          completions,
        },
      };
    });
  } catch (error) {
    return { status: "blocked", findings: [`CTO close preparation failed: ${error instanceof Error ? error.message : String(error)}`] };
  } finally {
    pinnedRoot.close();
  }
}


/**
 * Close one CTO specification-execution wave only after every selected
 * feature has an engine-verified terminal claim/workspace and the exact
 * content-addressed passing conformance artifact named by the caller.
 *
 * The run lock spans all reads and the revision-checked state write. A
 * terminal wave is replayable only with the same mapping digest and complete
 * terminal postimages; partial, stale, or mismatched proof remains blocked.
 */
export interface CtoSpecificationExecutionWaveCloseOptions {
  /** Genuine live runtime capability bound to the same canonical project root. */
  runtimeAccess: CtoRuntimeAccessFacade;
  /** Exact host session identity used to resolve the runtime capability. */
  sessionId: string;
}

const CTO_TERMINAL_PASS_REASON = "CTO specification-execution run completed successfully.";
const CTO_TERMINAL_BLOCKED_REASON = "CTO specification-execution run terminated with blocked feature outcomes.";

function terminalCtoRunPostimage(
  state: CtoState,
  outcome: "pass" | "blocked",
): { ok: true; state: CtoState } | { ok: false; error: string } {
  const identity = state.work_identity;
  if (!identity) return { ok: false, error: "CTO run has no exact engine-issued work identity for terminal completion" };
  const passed = outcome === "pass";
  const reason = passed ? CTO_TERMINAL_PASS_REASON : CTO_TERMINAL_BLOCKED_REASON;
  const terminalOutcome: CompletionEnvelope["outcome"] = passed ? "succeeded" : "failed";
  const terminalSignal: NonNullable<CompletionEnvelope["terminal_signal"]> = passed ? "workflow_complete" : "contract_failure";
  const emittedAt = new Date().toISOString();
  const completionEnvelope: CompletionEnvelope = {
    schema_version: 1,
    identity,
    outcome: terminalOutcome,
    terminal_signal: terminalSignal,
    artifact_refs: [],
    evidence_ref: null,
    conflict_ref: null,
    completed_by: "engine_task_caller",
    emitted_at: emittedAt,
  };
  const next: CtoState = {
    ...state,
    // A terminal specification-execution run is no longer a resident standby
    // route. This is engine-derived, never a caller-controlled completion flag.
    standby: false,
    integration: { ...state.integration, status: passed ? "done" : "failed", note: reason },
    work_identity: identity,
    pending: {
      identity,
      status: passed ? "succeeded" : "failed",
      terminal_signal: terminalSignal,
      updated_at: emittedAt,
    },
    completion_envelope: completionEnvelope,
    control_plane_status: {
      stage: "done",
      lifecycle: passed ? "complete" : "failed",
      pause: passed ? "done" : "failed",
      reason,
    },
    pause: { kind: passed ? "done" : "failed", reason },
    updated_at: emittedAt,
  };
  const validation = validateTypedControlPlane({
    work_identity: next.work_identity,
    pending: next.pending,
    completion_envelope: next.completion_envelope,
  });
  if (!validation.ok) return { ok: false, error: "engine-derived CTO terminal control-plane postimage is invalid" };
  if (next.active_wave_id !== undefined || next.integration.status !== (passed ? "done" : "failed")
    || next.pause.kind !== (passed ? "done" : "failed")
    || next.pending?.status !== (passed ? "succeeded" : "failed")
    || JSON.stringify(next.pending?.identity) !== JSON.stringify(identity)
    || next.completion_envelope?.outcome !== terminalOutcome
    || next.completion_envelope?.terminal_signal !== terminalSignal
    || JSON.stringify(next.completion_envelope.identity) !== JSON.stringify(identity)
    || next.control_plane_status?.stage !== "done"
    || next.control_plane_status.lifecycle !== (passed ? "complete" : "failed")
    || next.control_plane_status.pause !== (passed ? "done" : "failed")
    || next.pause.kind !== (passed ? "done" : "failed")
    || !isCtoRunTerminal(next)) {
    return { ok: false, error: "engine-derived CTO terminal control-plane postimage is not terminal" };
  }
  return { ok: true, state: next };
}

function terminalCtoRunProjectionMatches(state: CtoState, outcome: "pass" | "blocked"): boolean {
  const expected = terminalCtoRunPostimage(state, outcome);
  if (!expected.ok) return false;
  const actual = {
    ...state,
    // These audit timestamps are regenerated by the idempotent recovery CAS;
    // every other persisted field must equal the engine-derived postimage.
    updated_at: expected.state.updated_at,
    pending: state.pending
      ? { ...state.pending, updated_at: expected.state.pending?.updated_at }
      : state.pending,
    completion_envelope: state.completion_envelope
      ? { ...state.completion_envelope, emitted_at: expected.state.completion_envelope?.emitted_at }
      : state.completion_envelope,
  };
  return canonicalJson(actual) === canonicalJson(expected.state);
}

function terminalCtoRunProjectionError(state: CtoState, outcome: "pass" | "blocked"): string | null {
  const postimage = terminalCtoRunPostimage(state, outcome);
  if (!postimage.ok) return postimage.error;
  return null;
}

/**
 * Apply the already-authorized specification terminal postimage. Generic wave
 * finish APIs intentionally reject this source; only this command owns the
 * receipt/matrix/team-digest validation that makes these aggregate fields safe.
 */
function finishCtoSpecificationExecutionWaveUnderAuthority(
  state: CtoState,
  input: { id: string; outcome: "pass" | "blocked"; blocked_feature_ids: string[]; findings: string[] },
): CtoState {
  const wave = state.wave_history?.find((candidate) => candidate.id === input.id);
  if (!wave || wave.source !== "specification-execution" || wave.status !== "active") {
    throw new Error("specification-execution close requires the exact active wave");
  }
  const finishedAt = new Date().toISOString();
  const recordUpdate = {
    ...wave,
    status: "done" as const,
    finished_at: finishedAt,
    outcome: input.outcome,
    blocked_feature_ids: [...input.blocked_feature_ids],
    findings: [...input.findings],
  };
  const next: CtoState = {
    ...state,
    wave_history: (state.wave_history ?? []).map((candidate) => candidate.id === input.id ? recordUpdate : candidate),
  };
  if (next.active_wave_id === input.id) delete next.active_wave_id;
  return next;
}

export function closeCtoSpecificationExecutionWave(
  projectRoot: string,
  input: CtoSpecificationExecutionWaveCloseInput,
  options: CtoSpecificationExecutionWaveCloseOptions,
): CtoSpecificationExecutionWaveCloseResult {
  if (
    !input ||
    !isSafeCtoRunId(input.cto_run_id) ||
    !isSafeCtoExecutionId(input.wave_id) ||
    !isSafeCtoExecutionId(input.mapping_id) ||
    !isSha256Hex(input.mapping_digest) ||
    !Array.isArray(input.completions)
  ) {
    return blockedCtoWaveClose(["wave close identity and completion proof must be explicit and safe"]);
  }
  const openedRoot = PinnedProjectRoot.open(projectRoot);
  if (!openedRoot || !openedRoot.isStable()) {
    openedRoot?.close();
    return blockedCtoWaveClose(["project root is missing or cannot be pinned"]);
  }
  const pinnedRoot = openedRoot;
  const root = pinnedRoot.canonical_root;
  const runtimeAccess = options.runtimeAccess;
  if (!runtimeAccess) {
    pinnedRoot.close();
    return blockedCtoWaveClose(["recovery_required: live RuntimeAccess is required for authoritative CTO wave close"]);
  }
  try {
    assertCtoRuntimeAccessFacadeLive(runtimeAccess, root, options.sessionId);
    runtimeAccess.assertProjectRoot(root);
    runtimeAccess.assertLive();
    recoverPendingMappingTransactions(root, input.cto_run_id, pinnedRoot);
    // Dependency/team reconciliation is a mutation for an active wave only.
    // Exact terminal replay must validate postimages without attempting to
    // re-enter the now-absent active wave.
    const preflightState = readCtoStatePinned(input.cto_run_id, pinnedRoot);
    if (!preflightState || preflightState.id !== input.cto_run_id) return blockedCtoWaveClose(["canonical CTO state for the exact run is unavailable"]);
    if (options.sessionId !== undefined && preflightState.standby !== true && preflightState.owner_session !== options.sessionId) {
      return blockedCtoWaveClose(["CTO wave close session does not own the canonical run"]);
    }
    const preflightTerminalWave = preflightState.wave_history?.find((candidate) => candidate.id === input.wave_id);
    const terminalReplayCandidate = preflightState?.active_wave_id === undefined && preflightTerminalWave?.status === "done";
    if (!terminalReplayCandidate) {
      const mappingForTerminalization = readMappingRecord(root, input.cto_run_id, input.mapping_id, pinnedRoot);
      if (!mappingForTerminalization.ok) return blockedCtoWaveClose([mappingForTerminalization.error]);
      if (mappingForTerminalization.value.record_digest !== input.mapping_digest) return blockedCtoWaveClose(["mapping_digest does not match the current immutable mapping-record bytes"]);
      if (mappingConfirmationRequired(mappingForTerminalization.value)) return blockedCtoWaveClose(["mapping confirmation is required before execution wave close"]);
      const mappingForExecution = mappingForTerminalization.value.mapping as CtoSpecificationMapping & {
        execution_choice?: string;
        execution?: { choice?: string; wave_id?: string; source_id?: string; capability_id?: string; capability_epoch?: string };
      };
      const executionForTerminalization = mappingForExecution.execution;
      if (!executionForTerminalization
        || mappingForExecution.execution_choice !== "cto"
        || executionForTerminalization.choice !== "cto"
        || executionForTerminalization.wave_id !== input.wave_id
        || typeof executionForTerminalization.source_id !== "string"
        || !ctoMappingExecutionMatchesWave(
          executionForTerminalization,
          preflightTerminalWave,
          input.cto_run_id,
          mappingForExecution.parallelization.map((decision) => decision.slice_id),
          preflightState.teams.map((team) => team.work_identity),
        )) {
        return blockedCtoWaveClose(["mapping is not the exact confirmed execution image for the requested wave"]);
      }
      const executionContext = activeCtoExecutionContext(root, input.cto_run_id, pinnedRoot, options.sessionId);
      if (!executionContext.ok) return blockedCtoWaveClose([executionContext.error]);
      if (executionContext.value.wave_id !== executionForTerminalization.wave_id) return blockedCtoWaveClose(["active CTO execution wave changed before reconciliation"]);
      const preparedAuthority = prepareCtoReconciliationMappingAuthority(root, input.cto_run_id, mappingForTerminalization.value, executionContext.value, pinnedRoot);
      if (!preparedAuthority.ok) return blockedCtoWaveClose([preparedAuthority.error]);
      const reconciled = reconcileCtoSpecificationExecutionTeams(root, input.cto_run_id, {
        runtimeAccess,
        pinnedRoot,
        sessionId: options.sessionId,
        expected_mapping_authority: preparedAuthority.authority,
        validate_mapping_authority: preparedAuthority.validator,
      });
      if (reconciled.status === "blocked") return blockedCtoWaveClose(reconciled.findings);
      const failedTerminalization = terminalizeCtoDependencyBlockedTeams(
        runtimeAccess,
        root,
        input.cto_run_id,
        mappingForTerminalization.value.mapping,
        { mapping_id: mappingForTerminalization.value.mapping.mapping_id, mapping_hash: mappingForTerminalization.value.mapping.mapping_hash, mapping_record_digest: mappingForTerminalization.value.record_digest, wave_id: executionForTerminalization.wave_id },
        pinnedRoot,
        options.sessionId,
        preparedAuthority.validator,
      );
      if (failedTerminalization.status === "blocked") return blockedCtoWaveClose(failedTerminalization.findings);
    }
    // Dependency terminalization owns its own RuntimeAccess transaction and
    // therefore completes before close acquires the run transaction below.
    return runtimeAccess.withRunTransaction(input.cto_run_id, (runtimeTransaction) => {
      if (!pinnedRoot.isStable()) return blockedCtoWaveClose(["project root changed before wave close"]);
      const state = runtimeTransaction.readState();
      if (!state || state.id !== input.cto_run_id) return blockedCtoWaveClose(["canonical CTO state for the exact run is unavailable"]);
      if (options.sessionId !== undefined && state.standby !== true && state.owner_session !== options.sessionId) {
        return blockedCtoWaveClose(["CTO wave close session does not own the canonical run"]);
      }
      const mappingRead = readMappingRecord(root, input.cto_run_id, input.mapping_id, pinnedRoot);
      if (!mappingRead.ok) return blockedCtoWaveClose([mappingRead.error]);
      const mappingRecord = mappingRead.value;
      if (mappingRecord.record_digest !== input.mapping_digest) {
        return blockedCtoWaveClose(["mapping_digest does not match the current immutable mapping-record bytes"]);
      }
      const mapping = mappingRecord.mapping as CtoSpecificationMapping & {
        execution_choice?: string;
        execution?: { choice?: string; wave_id?: string; source_id?: string; capability_id?: string; capability_epoch?: string };
      };
      if (
        mapping.status !== "confirmed" ||
        mapping.execution_choice !== "cto" ||
        !mapping.execution ||
        mapping.execution.choice !== "cto" ||
        mapping.execution.wave_id !== input.wave_id ||
        typeof mapping.execution.source_id !== "string" ||
        !mappingRecord.confirmation_context ||
        mappingRecord.mapping.checkpoint_ref !== mappingRecord.checkpoint_ref
      ) {
        return blockedCtoWaveClose(["mapping is not the exact confirmed execution image for the requested wave"]);
      }
      const mappingRecordPath = pinnedRoot.relativePath(mappingRecord.record_path);
      if (!mappingRecordPath) return blockedCtoWaveClose(["canonical mapping record path is outside the pinned project root"]);
      const selections = mappingRecord.selections;
      if (input.completions.length !== selections.length) {
        return blockedCtoWaveClose(["wave close requires exactly one terminal completion proof for every selected feature"]);
      }
      const completionByFeature = new Map<string, CtoSpecificationExecutionWaveCompletion>();
      for (const completion of input.completions) {
        if (
          !completion ||
          !isSafeFeatureId(completion.feature_id) ||
          typeof completion.run_key !== "string" ||
          completion.run_key.trim().length === 0 ||
          !isSha256Hex(completion.handoff_digest) ||
          !/^implementation-conformance\.[a-f0-9]{64}$/.test(completion.conformance_id) ||
          completionByFeature.has(completion.feature_id)
        ) {
          return blockedCtoWaveClose(["wave close completion proof contains an invalid or duplicate feature"]);
        }
        completionByFeature.set(completion.feature_id, completion);
      }
      const activeWave = state.active_wave_id === input.wave_id
        ? state.wave_history?.find((candidate) => candidate.id === input.wave_id)
        : undefined;
      const terminalWave = state.wave_history?.find((candidate) => candidate.id === input.wave_id);
      if (!terminalWave) return blockedCtoWaveClose(["requested wave is not present in canonical CTO history"]);
      let execution: CtoExecutionContext | null = null;
      if (activeWave?.status === "active") {
        const currentExecution = activeCtoExecutionContext(root, input.cto_run_id, pinnedRoot, options.sessionId);
        if (!currentExecution.ok) return blockedCtoWaveClose([currentExecution.error]);
        execution = currentExecution.value;
        if (execution.wave_id !== input.wave_id) return blockedCtoWaveClose(["active CTO execution wave changed before close"]);
        const first = selections[0];
        if (!first) return blockedCtoWaveClose(["confirmed mapping has no selected feature"]);
        const firstState = readPinnedFeatureState(root, first.feature_id, first.run_key, pinnedRoot);
        if (!firstState.ok) return blockedCtoWaveClose([firstState.error]);
        const admissionError = dispatchAdmissionError(mappingRecord, execution, firstState.value, input.cto_run_id, { canonical_root: pinnedRoot.canonical_root, dev: pinnedRoot.dev, ino: pinnedRoot.ino }, pinnedRoot);
        if (admissionError) return blockedCtoWaveClose([admissionError]);
      } else if (state.active_wave_id === undefined && terminalWave.status === "done") {
        const admittedSlices = mapping.parallelization.map((decision) => decision.slice_id);
        if (!ctoMappingTeamBindingsMatchExecution(mapping, { state, wave_id: terminalWave.id, source_id: terminalWave.source_id, stage_id: "execution", capability_id: mapping.execution.capability_id!, capability_epoch: mapping.execution.capability_epoch! }, mappingRecord.selections) || !ctoMappingExecutionMatchesWave(mapping.execution, terminalWave, input.cto_run_id, admittedSlices, state.teams.map((team) => team.work_identity))) {
          return blockedCtoWaveClose(["requested terminal wave is not the exact engine-issued specification-execution identity for the confirmed mapping"]);
        }
        // Exact terminal replay is allowed below after every postimage is
        // re-read. Any failed/active/mismatched history remains blocked.
      } else {
        return blockedCtoWaveClose(["requested wave is stale, failed, or not the active specification-execution wave"]);
      }

      const blockedFeatureIds: string[] = [];
      const aggregateFindings: string[] = [];
      const terminalReceiptFeatures: Array<CtoSpecificationConformanceReceipt["features"][number]> = [];
      const terminalReceiptClaims: Array<{ claim_id: string; handoff_digest: string; owner_kind: "cto"; owner_run_id: string; status: "active" | "completed" | "blocked"; admission_binding?: ExecutionClaim["admission_binding"] }> = [];
      for (const selection of selections) {
        const completion = completionByFeature.get(selection.feature_id);
        if (!completion || completion.run_key !== selection.run_key) {
          return blockedCtoWaveClose([`wave close completion proof does not match selected feature '${selection.feature_id}'`]);
        }
        const binding = mapping.handoff_bindings.find((candidate) => candidate.feature_id === selection.feature_id);
        if (!binding || binding.handoff_digest !== completion.handoff_digest) {
          return blockedCtoWaveClose([`feature '${selection.feature_id}' handoff proof does not match the frozen mapping`]);
        }
        const featureRead = readPinnedFeatureState(root, selection.feature_id, selection.run_key, pinnedRoot);
        if (!featureRead.ok) return blockedCtoWaveClose([featureRead.error]);
        const workspace = featureRead.value.state.specification;
        if (
          !workspace ||
          workspace.feature_id !== selection.feature_id ||
          workspace.execution_claim_ref === null ||
          workspace.implementation_conformance_ref !== completion.conformance_id
        ) {
          return blockedCtoWaveClose([`feature '${selection.feature_id}' lacks the exact terminal workspace postimage`]);
        }
        const claimRead = readCurrentExecutionClaim(root, selection.feature_id, pinnedRoot);
        if (!claimRead.ok || !claimRead.value) {
          return blockedCtoWaveClose([claimRead.ok ? `feature '${selection.feature_id}' has no terminal claim` : claimRead.error]);
        }
        const claim = claimRead.value;
        const admission = claim.admission_binding;
        if (
          claim.owner_kind !== "cto" ||
          claim.owner_run_id !== input.cto_run_id ||
          claim.claim_id !== workspace.execution_claim_ref ||
          claim.handoff_digest !== completion.handoff_digest ||
          !admission ||
          admission.mapping_record_digest !== input.mapping_digest ||
          admission.mapping_id !== input.mapping_id ||
          admission.mapping_hash !== mapping.mapping_hash ||
          admission.wave_id !== input.wave_id ||
          admission.capability_id !== mapping.execution.capability_id ||
          admission.capability_epoch !== mapping.execution.capability_epoch ||
          admission.checkpoint_ref !== mappingRecord.checkpoint_ref ||
          admission.trusted_answer_ref !== mappingRecord.trusted_answer_ref
        ) {
          return blockedCtoWaveClose([`feature '${selection.feature_id}' claim terminal authority is stale or mismatched`]);
        }
        const handoff = loadHandoff(root, selection, undefined, pinnedRoot);
        if (!handoff.ok) return blockedCtoWaveClose([handoff.error]);
        const admissionVerification = verifyExecutionClaimAdmissionBindingPinned(pinnedRoot, {
          feature_id: selection.feature_id,
          run_key: selection.run_key,
          owner_run_id: input.cto_run_id,
          workspace,
          claim,
          handoff: handoff.handoff,
          verification_mode: "terminal",
          mapping: {
            selected_feature_id: selection.feature_id,
            selected_run_key: selection.run_key,
            mapping_record_path: mappingRecordPath,
            mapping_record_digest: input.mapping_digest,
            mapping_id: input.mapping_id,
            mapping_hash: mapping.mapping_hash,
            mapping_version: mapping.mapping_version,
            checkpoint_ref: mappingRecord.checkpoint_ref,
            trusted_answer_ref: mappingRecord.trusted_answer_ref,
            wave_id: input.wave_id,
            capability_id: mapping.execution.capability_id,
            capability_epoch: mapping.execution.capability_epoch,
          },
        });
        if (!admissionVerification.ok) return blockedCtoWaveClose(["feature " + selection.feature_id + " claim admission binding is invalid: " + admissionVerification.error]);
        const matrixSnapshot = (() => { try { return readPinnedArtifactSnapshot(pinnedRoot, `.work-state/features/${selection.feature_id}/artifacts/implementation_conformance`, completion.conformance_id, { verifyPathAfterRead: true }); } catch { return null; } })();
        const matrix = matrixSnapshot?.value as ImplementationConformanceResult | undefined;
        if (!matrix || !matrixSnapshot) return blockedCtoWaveClose([`feature ${selection.feature_id} conformance artifact is unreadable`]);
        const matrixValidation = validateProducedArtifact("implementation_conformance", matrix);
        const isPass = matrix.overall_status === "pass";
        const isNonPassingTerminal = matrix.overall_status === "blocked" || matrix.overall_status === "changed_intent";
        if (
          !matrixValidation.ok ||
          (!isPass && !isNonPassingTerminal) ||
          matrix.conformance_id !== completion.conformance_id ||
          matrix.matrix_digest !== implementationConformanceMatrixDigest(matrix) ||
          matrix.feature_id !== selection.feature_id ||
          matrix.handoff_id !== handoff.handoff.handoff_id ||
          matrix.handoff_digest !== handoff.handoff.handoff_digest ||
          matrix.profile_hash !== workspace.profile_hash ||
          matrix.execution_owner !== "cto" ||
          matrix.execution_run_id !== input.cto_run_id ||
          matrix.execution_claim_id !== claim.claim_id ||
          matrix.handoff_digest !== completion.handoff_digest
        ) {
          return blockedCtoWaveClose([`feature '${selection.feature_id}' conformance artifact is not the exact terminal pass or non-passing result`]);
        }
        terminalReceiptFeatures.push({ feature_id: selection.feature_id, run_key: selection.run_key, conformance_id: completion.conformance_id, artifact_sha256: matrixSnapshot.sha256, matrix_digest: matrix.matrix_digest, claim_id: claim.claim_id });
        terminalReceiptClaims.push({ claim_id: claim.claim_id, handoff_digest: claim.handoff_digest, owner_kind: "cto", owner_run_id: claim.owner_run_id, status: claim.status as "active" | "completed" | "blocked", ...(claim.admission_binding ? { admission_binding: claim.admission_binding } : {}) });
        const evidenceError = terminalConformanceEvidenceError(pinnedRoot, selection.feature_id, matrix, handoff.handoff, claim);
        if (evidenceError) return blockedCtoWaveClose([evidenceError]);
        if (isPass) {
          if (workspace.status !== "completed" || claim.status !== "completed") {
            return blockedCtoWaveClose([`feature '${selection.feature_id}' lacks the exact completed passing postimage`]);
          }
        } else {
          if (
            claim.status !== "active" && claim.status !== "blocked"
            || !["claimed", "executing", "completion_validating", "completion_blocked"].includes(workspace.status)
          ) {
            return blockedCtoWaveClose([`feature '${selection.feature_id}' lacks the exact blocked terminal postimage`]);
          }
          blockedFeatureIds.push(selection.feature_id);
          for (const finding of matrix.blocking_findings) {
            if (aggregateFindings.length < 128) {
              aggregateFindings.push(`Feature '${selection.feature_id}': ${finding.message}`.slice(0, 4096));
            }
          }
        }
      }


      if (terminalWave.source === "specification-execution") {
        const receiptRef = terminalWave.conformance_receipt_ref;
        if (!receiptRef) return blockedCtoWaveClose(["recovery_required: specification-execution wave has no engine conformance receipt pointer; rerun authenticated conformance persistence"]);
        const receiptRead = readCtoSpecificationConformanceReceipt(pinnedRoot, input.cto_run_id, receiptRef);
        if (!receiptRead.ok) return blockedCtoWaveClose([receiptRead.error]);
        const receipt = receiptRead.value;
        const receiptAuthority = readCtoSpecificationConformanceAuthority({ capability_id: receipt.conformance_capability_id }, root);
        if (!receiptAuthority
          || receiptAuthority.capability_id !== receipt.conformance_capability_id
          || receiptAuthority.cto_run_id !== input.cto_run_id
          || receiptAuthority.mapping_id !== input.mapping_id
          || receiptAuthority.mapping_hash !== mapping.mapping_hash
          || receiptAuthority.mapping_record_digest !== input.mapping_digest
          || receiptAuthority.active_claims_digest !== receipt.active_claims_digest
          || receiptAuthority.terminal_teams_digest !== receipt.terminal_teams_digest
          || receipt.cto_run_id !== input.cto_run_id
          || receipt.wave_id !== input.wave_id
          || receipt.mapping_id !== input.mapping_id
          || receipt.mapping_record_digest !== input.mapping_digest) {
          return blockedCtoWaveClose(["engine conformance receipt capability is foreign, malformed, or not bound to the exact CTO mapping wave"]);
        }
        const terminal = computeCtoTerminalTeamsDigest(state, mapping, mappingRecord.selections);
        if (!terminal.ok) return blockedCtoWaveClose([`terminal CTO team postimage is unavailable or invalid: ${terminal.error}`]);
        if (receipt.terminal_teams_digest !== terminal.digest) return blockedCtoWaveClose(["engine conformance receipt terminal-team digest does not match the current terminal postimage"]);
        const expectedClaimDigest = ctoConformanceClaimsDigest(terminalReceiptClaims.map((claim) => ({ ...claim, status: claim.status === "completed" ? "active" as const : claim.status })));
        if (receipt.active_claims_digest !== expectedClaimDigest) return blockedCtoWaveClose(["engine conformance receipt active-claim digest does not match the current claim postimage"]);
        const expectedReceiptFeatures = [...terminalReceiptFeatures].sort((left, right) => canonicalJson(left).localeCompare(canonicalJson(right)));
        if (canonicalJson(receipt.features) !== canonicalJson(expectedReceiptFeatures)) return blockedCtoWaveClose(["engine conformance receipt feature postimages do not match the current terminal artifacts"]);
      }
      if (state.active_wave_id === undefined && terminalWave.status === "done") {
        const expectedTerminalOutcome = blockedFeatureIds.length > 0 ? "blocked" : "pass";
        const expectedBlockedFeatureIds = [...blockedFeatureIds].sort();
        const persistedBlockedFeatureIds = terminalWave.blocked_feature_ids;
        if (terminalWave.outcome !== expectedTerminalOutcome) return blockedCtoWaveClose(["terminal wave outcome does not match the exact matrix outcomes"]);
        if (!persistedBlockedFeatureIds
          || persistedBlockedFeatureIds.length !== expectedBlockedFeatureIds.length
          || new Set(persistedBlockedFeatureIds).size !== persistedBlockedFeatureIds.length
          || persistedBlockedFeatureIds.some((featureId) => !isSafeFeatureId(featureId))
          || canonicalJson(persistedBlockedFeatureIds) !== canonicalJson(expectedBlockedFeatureIds)) {
          return blockedCtoWaveClose(["terminal wave blocked_feature_ids do not match the exact matrix outcomes"]);
        }
        const expectedFindings = aggregateFindings.slice(0, 128).sort();
        if (!terminalWave.findings
          || canonicalJson(terminalWave.findings) !== canonicalJson(expectedFindings)) {
          return blockedCtoWaveClose(["terminal wave findings do not match the exact matrix outcomes"]);
        }
      }

      const latest = runtimeTransaction.readState();
      if (
        !latest ||
        latest.state_revision !== state.state_revision ||
        latest.active_wave_id !== state.active_wave_id ||
        latest.wave_history?.find((candidate) => candidate.id === input.wave_id)?.status !== terminalWave.status
      ) {
        return blockedCtoWaveClose(["CTO state changed during wave-close authorization; retry with fresh postimages"]);
      }
      const canonicalBlockedFeatureIds = [...blockedFeatureIds].sort();
      const outcome: "pass" | "blocked" = canonicalBlockedFeatureIds.length > 0 ? "blocked" : "pass";
      const findings = aggregateFindings.slice(0, 128).sort();
      const terminalOutcome = terminalWave.outcome ?? outcome;
      if (terminalWave.status === "done" && state.active_wave_id === undefined) {
        if (terminalWave.outcome !== undefined && terminalWave.outcome !== outcome) {
          return blockedCtoWaveClose(["terminal wave outcome does not match its exact conformance postimages"]);
        }
        const projection = terminalCtoRunPostimage(runtimeTransaction.readState(), outcome);
        if (!projection.ok) return blockedCtoWaveClose([projection.error]);
        if (!terminalCtoRunProjectionMatches(runtimeTransaction.readState(), outcome)) {
          try {
            runtimeTransaction.writeState(projection.state);
          } catch (error) {
            return blockedCtoWaveClose([`terminal replay projection recovery failed: ${error instanceof Error ? error.message : String(error)}`]);
          }
        }
        if (!terminalCtoRunProjectionMatches(runtimeTransaction.readState(), outcome)) {
          return blockedCtoWaveClose(["terminal CTO run projection is not the exact persisted terminal postimage"]);
        }
        return {
          status: "closed",
          closed: true,
          replayed: true,
          cto_run_id: input.cto_run_id,
          wave_id: input.wave_id,
          mapping_id: input.mapping_id,
          mapping_digest: input.mapping_digest,
          feature_ids: selections.map((selection) => selection.feature_id),
          outcome: terminalOutcome,
          blocked_feature_ids: terminalWave.blocked_feature_ids ? [...terminalWave.blocked_feature_ids] : [...blockedFeatureIds],
          findings: terminalWave.findings ? [...terminalWave.findings] : findings,
        };
      }
      const finished = finishCtoSpecificationExecutionWaveUnderAuthority(latest, {
        id: input.wave_id,
        outcome,
        blocked_feature_ids: canonicalBlockedFeatureIds,
        findings,
      });
      if (finished === latest || finished.active_wave_id === input.wave_id) {
        return blockedCtoWaveClose(["wave close did not produce a terminal state transition"]);
      }
      const terminalized = terminalCtoRunPostimage(finished, outcome);
      if (!terminalized.ok) return blockedCtoWaveClose([terminalized.error]);
      try {
        const constitutionError = refreshCtoMappingConstitutions(root, mappingRecord, pinnedRoot);
        if (constitutionError) return blockedCtoWaveClose([constitutionError]);
        runtimeTransaction.writeState(terminalized.state);
      } catch (error) {
        return blockedCtoWaveClose([`wave close CAS failed: ${error instanceof Error ? error.message : String(error)}`]);
      }
      return {
        status: "closed",
        closed: true,
        replayed: false,
        cto_run_id: input.cto_run_id,
        wave_id: input.wave_id,
        mapping_id: input.mapping_id,
        mapping_digest: input.mapping_digest,
        feature_ids: selections.map((selection) => selection.feature_id),
        outcome,
        blocked_feature_ids: canonicalBlockedFeatureIds,
        findings,
      };
    });
  } catch (error) {
    return blockedCtoWaveClose([`recovery_required: CTO wave close runtime transaction failed: ${error instanceof Error ? error.message : String(error)}`]);
  } finally {
    pinnedRoot.close();
  }
}


/**
 * CommandContext-style entry (legacy command surface, mirrors `teamCommand`).
 * Returns the CTO prompt; the caller feeds it to the main agent.
 * Empty args start CTO STANDBY (no task — tasks arrive via the messenger
 * inbox / [CTO-INBOX] wake).
 */
export function ctoCommand(ctx: CommandContext): string {
  const raw = ctx.args.trim();
  if (!raw) {
    ctx.ui.notify("cto: standby mode — awaiting tasks via messenger inbox", "info");
    return buildStandbyCtoPrompt(ctx.cwd);
  }
  const envelope = parseEnvelope(raw, ctx.cwd);
  if (envelope.specificationSelectionError) {
    return `ERROR: ${envelope.specificationSelectionError.code}: ${envelope.specificationSelectionError.message}`;
  }
  if (!envelope.task && !envelope.specificationSelections?.length) return "ERROR: empty task after stripping prefix.";
  const active = findActiveCtoRun(ctx.cwd, { sessionId: ctx.sessionId });
  if (active) {
    ctx.ui.notify(`cto: amending run ${active.runId} with: ${envelope.task.slice(0, 50)}`, "info");
    return buildAmendPrompt(envelope, ctx.cwd, active, { sessionId: ctx.sessionId });
  }
  ctx.ui.notify(`cto: ${envelope.task.slice(0, 60)} (decomposition pending)`, "info");
  return buildCtoPrompt(envelope, ctx.cwd, { sessionId: ctx.sessionId });
}
