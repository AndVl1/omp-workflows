/**
 * `/cto` prompt adapter.
 *
 * Canonical CTO registration, provider selection, state transitions and
 * user-channel delivery belong to the protocol-v2 host. This module contains
 * only deterministic parsing/rendering helpers for direct consumers. It never
 * probes cwd/git, reads profiles or state, mutates files, selects a provider,
 * or emits UI notifications.
 */
/* <!-- omp-cto-slice run=01a03ee4-7dd6-7580-8ad7-16d26dc886ba slice=workflow-v2-core --> */

import {
  parseTaskArguments,
  requireMatchingWorkflowCommandIdentity,
  requireWorkflowCommandContext,
  resolveCommandBranch,
  resolveCommandSession,
  type WorkflowCommandContext,
} from "./envelope.js";
import { buildClassificationPhaseZero, buildWorkflowMatrix } from "./classification-contract.js";
import type { ModelClassification } from "../engine/run.js";
import type { CtoState } from "../cto/types.js";
import type { CommandContext } from "./types.js";

type V2CommandContext = CommandContext & { readonly workflowContext: WorkflowCommandContext };

export interface ParsedCtoEnvelope {
  task: string;
  /** Mechanical leading-directive hint; PHASE-0 remains authoritative. */
  autonomyHint: boolean;
  issue: number | null;
  /** Canonical branch supplied by the manager, never inferred here. */
  branch: string | null;
}

function explicitBranch(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  const branch = value.trim();
  if (!branch || branch.startsWith("/") || branch.includes("\\") || branch === "." || branch === "..") return null;
  return branch;
}

/** Parse CTO arguments without filesystem or host access. */
export function parseEnvelope(args: string, branch?: string | null): ParsedCtoEnvelope {
  const parsed = parseTaskArguments(args);
  return {
    task: parsed.task,
    autonomyHint: parsed.autonomyHint,
    issue: parsed.issue,
    branch: explicitBranch(branch),
  };
}

/**
 * Channel policy is supplied by the host's validated dispatch context. The
 * prompt helper renders only provider/session provenance and the generic
 * host-managed channel rule; it never selects or contacts a channel.
 */
export function renderChannelSection(context: WorkflowCommandContext): string {
  const admitted = requireWorkflowCommandContext(context);
  const project = admitted.project_identity;
  return [
    "### User channel (host-managed)",
    `Provider: \`${project.provider_id}\``,
    `Project root instance: \`${project.root_instance_id}\``,
    `Session: \`${project.session.session_id}\``,
    "Use only the validated host channel and typed workflow checkpoint tools.",
    "Do not inspect channel files, select an adapter, or send an untyped user message from this prompt helper.",
  ].join("\n");
}

/** Build the resident CTO standby prompt without creating or adopting state. */
export function buildStandbyCtoPrompt(context: WorkflowCommandContext): string {
  const admitted = requireWorkflowCommandContext(context);
  return [
    "Workflow request (protocol v2) — /cto standby",
    "",
    "You are the resident CTO in the main session. Do not spawn a CTO or invent work.",
    "Wait for a host-delivered typed task/inbox event; when one arrives, classify it and continue the same run through workflow tools.",
    "Standby does not authorize provider selection, state writes, or channel access.",
    "",
    renderChannelSection(admitted),
  ].join("\n");
}

export interface CtoPromptOptions {
  /** Optional session identity; it must match the host-admitted session. */
  sessionId?: string;
}

function persistenceContract(
  opts: CtoPromptOptions,
  context: WorkflowCommandContext,
): string {
  const sessionId = resolveCommandSession(opts.sessionId, context);
  return [
    "### Typed persistence",
    `The host-owned workflow state must retain session=${sessionId} and the complete project identity pins.`,
    "Persist the model's PHASE-0 classification, not the mechanical leading-directive hint.",
    "workflow_prepare must select and persist one exact catalog profile plus a new run_id before any run side effect.",
    "Legacy autonomous/mode/actor prose cannot authorize a checkpoint or provider action.",
  ].join("\n");
}

/** Build the in-session CTO orchestration prompt from only typed envelope data. */
export function buildCtoPrompt(
  envelope: ParsedCtoEnvelope,
  context: WorkflowCommandContext,
  opts: CtoPromptOptions = {},
): string {
  const admitted = requireWorkflowCommandContext(context);
  const branch = resolveCommandBranch(envelope.branch, admitted);
  const sessionId = resolveCommandSession(opts.sessionId, admitted);
  const project = admitted.project_identity;
  const issueMeta = envelope.issue === null ? "Issue: (none)" : `Issue: #${envelope.issue}`;
  const roles = Object.entries(admitted.effectivePolicy.roles)
    .map(([role, ref]) => `${role}=\`${ref.registered_name}\``)
    .join(", ") || "(none)";
  return [
    "Workflow request (protocol v2) — /cto",
    "You are the resident CTO and main-session orchestrator. Never spawn a CTO.",
    "",
    "### Task",
    envelope.task,
    "",
    "### Metadata",
    issueMeta,
    `Branch: \`${branch}\``,
    `Project root instance: \`${project.root_instance_id}\``,
    `Provider: \`${project.provider_id}\``,
    `Descriptor: \`${project.descriptor_fingerprint}\``,
    `Executable build: \`${project.executable_provenance.build_fingerprint}\``,
    `Executable runtime: \`${project.executable_provenance.runtime_fingerprint}\``,
    `Catalog: \`${project.catalog_content_digest}\``,
    `Session: \`${sessionId}\``,
    `Lifecycle: \`${project.session.lifecycle_id}\``,
    `Config byte digest: \`${project.config_byte_sha256}\``,
    `Config semantic digest: \`${project.config_semantic_sha256}\``,
    "Workflow profile: selected exactly once by `workflow_prepare` (not part of project activation)",
    `Effective roles: ${roles}`,
    `Leading directive hint: ${envelope.autonomyHint ? "present" : "absent"} (mechanical only)`,
    "",
    buildClassificationPhaseZero({ label: "leading directive", value: envelope.autonomyHint }),
    "",
    buildWorkflowMatrix(),
    "Typed dispatch marker (slice-gate format; use only exact workflow-tool identities, never invent IDs): `<!-- omp-cto-slice run=<runId> slice=<sliceId> -->`",
    "",
    persistenceContract(opts, admitted),
    "",
    "### CTO execution contract",
    "Classify every slice before dispatch, resolve each workflow through the matrix, and use only provider-qualified agents from the validated catalog.",
    "Use workflow_prepare/begin/instructions/status/complete/checkpoint/advance for state and capability transitions. Never write canonical state or infer provider/profile/agent identity from cwd, package order, markers, or prompt text.",
    "Spawn leads/workers only with exact typed dispatch markers and project/run identity pins returned by workflow tools. A native task result is not artifact completion.",
    "Keep team scopes disjoint, aggregate typed DoD artifacts, and fail closed on missing or stale policy, binding, profile, capability, or identity.",
    "",
    renderChannelSection(admitted),
    "",
    "Begin by completing PHASE-0, then invoke workflow_prepare in this turn.",
  ].join("\n");
}

/**
 * Build an amend prompt from caller-supplied typed state. State lookup and
 * ownership selection are host responsibilities; this helper never discovers
 * active runs itself.
 */
export function buildAmendPrompt(
  envelope: ParsedCtoEnvelope,
  context: WorkflowCommandContext,
  active: { runId: string; state: CtoState },
  opts: CtoPromptOptions = {},
): string {
  const admitted = requireWorkflowCommandContext(context);
  const branch = resolveCommandBranch(envelope.branch, admitted);
  const sessionId = resolveCommandSession(opts.sessionId, admitted);
  const activeIdentity = requireMatchingWorkflowCommandIdentity(active.state.run_identity, admitted, active.runId);
  const teams = active.state.teams.map((team) => `${team.id}:${team.status}`).join(", ") || "(none)";
  const issueMeta = envelope.issue === null ? "Issue: (none)" : `Issue: #${envelope.issue}`;
  return [
    "Workflow request (protocol v2) — /cto amend",
    "A host-validated active CTO run exists. Continue it; do not create a second run or CTO.",
    "",
    `Run: \`${activeIdentity.run_id}\``,
    `Task: ${envelope.task}`,
    issueMeta,
    `Branch: \`${branch}\``,
    `Provider: \`${activeIdentity.provider_id}\``,
    `Catalog: \`${activeIdentity.catalog_content_digest}\``,
    `Profile: \`${activeIdentity.profile_identity.id}\` (${activeIdentity.profile_identity.fingerprint})`,
    `Teams: ${teams}`,
    `Session: \`${sessionId}\``,
    "",
    buildClassificationPhaseZero({ label: "leading directive", value: envelope.autonomyHint }),
    "",
    buildWorkflowMatrix(),
    "",
    persistenceContract(opts, admitted),
    "",
    "Read the active typed state through workflow tools, append this task as a new wave, classify each slice, and dispatch only after the host returns a fresh identity-bound capability.",
    "Preserve prior artifacts and close only the current wave; a provider/config/profile identity change requires a fresh lifecycle.",
  ].join("\n");
}

/**
 * Direct command adapter. Canonical host handlers should call the v2 host
 * instead; this function remains pure and performs no notification or state
 * discovery.
 */
export function ctoCommand(ctx: V2CommandContext): string {
  const context = requireWorkflowCommandContext(ctx.workflowContext);
  const envelope = parseEnvelope(ctx.args, context.branch);
  return envelope.task
    ? buildCtoPrompt(envelope, context, { sessionId: context.project_identity.session.session_id })
    : buildStandbyCtoPrompt(context);
}

export type { ModelClassification };
