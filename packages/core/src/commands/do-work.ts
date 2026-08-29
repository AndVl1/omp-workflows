/* <!-- omp-cto-slice run=01a03ee4-7dd6-7580-8ad7-16d26dc886ba slice=workflow-v2-core --> */
import {
  parseTaskArguments,
  requireWorkflowCommandContext,
  resolveCommandBranch,
  type WorkflowCommandContext,
} from "./envelope.js";
import { buildClassificationPhaseZero, buildWorkflowMatrix } from "./classification-contract.js";
import type { Complexity, TaskType, WorkflowName } from "../engine/types.js";

export interface ParsedWorkEnvelope {
  task: string;
  /**
   * Mechanical hint from the leading-directive parser. It is never an
   * authority for routing or checkpoint permission; PHASE-0 owns that
   * decision.
   */
  autonomyHint: boolean;
  issue: number | null;
  /** Manager-supplied canonical branch; parsing never probes git or cwd. */
  branch: string | null;
}

function explicitBranch(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  const branch = value.trim();
  if (!branch || branch.startsWith("/") || branch.includes("\\") || branch === "." || branch === "..") return null;
  return branch;
}

/**
 * Parse only the command envelope. The second argument is an optional branch
 * value already resolved by the host/session manager; this function never
 * reads the filesystem, git metadata, process cwd, or runtime configuration.
 */
export function parseWorkEnvelope(args: string, branch?: string | null): ParsedWorkEnvelope {
  const parsed = parseTaskArguments(args);
  return {
    task: parsed.task,
    autonomyHint: parsed.autonomyHint,
    issue: parsed.issue,
    branch: explicitBranch(branch),
  };
}

const RESUME_FROM_DISK_STEPS = [
  "**Prepare** — call `workflow_prepare` once with the PHASE-0 classification, the exact canonical branch, changed files, and issue metadata. A matching branch continues its existing run; preserve its task, classification, stage history, artifact IDs, and capability/dispatch identities.",
  "**Resolve and validate selection** — after preparation succeeds, call `workflow_begin`, then validate the returned current stage, cursor epoch, role roster, and workflow against persisted state. Reject stale, missing, or mismatched selection; never guess a stage.",
  "**Freeze snapshot/capability** — treat the `workflow_begin` handoff as the immutable run snapshot, then call `workflow_instructions`. Its returned stage contract and `state.artifactsDir` are the only instruction and artifact locations.",
  "**Authorize identity** — dispatch only the exact declared role/qualified provider agent with the current cursor, epoch, and role-specific marker. Missing, malformed, stale, or mismatched markers reject dispatch before worker work.",
  "**Reconcile pending/terminal** — after every task result call `workflow_status`. Pending or active work is neutral: reconcile it without polling loops, duplication, replacement, or premature advancement. Non-succeeded terminal results fail closed.",
  "**Join/fan-in** — for every succeeded dispatch call `workflow_complete` exactly once with its identity binding and exact `artifact_ids`; consilium stages use every declared `slot_artifacts` id. Native task output is never artifact completion.",
  "**Checkpoint/gate/advance** — checkpoint permission exists only when the current stage contract declares it. Before `workflow_advance`, call `workflow_checkpoint` with the complete typed authorization and actor provenance; legacy mode/actor fields cannot authorize.",
] as const;

/**
 * Build a host-independent orchestration prompt. All project-specific
 * identity, policy, profile, roster, and state data comes from the
 * host-admitted context; this helper deliberately performs no I/O and emits
 * no UI notification.
 */
export function buildDoWorkPrompt(
  envelope: ParsedWorkEnvelope,
  context: WorkflowCommandContext,
): string {
  const admitted = requireWorkflowCommandContext(context);
  const branch = resolveCommandBranch(envelope.branch, admitted);
  const project = admitted.project_identity;
  const issueMeta = envelope.issue === null ? "Issue: (none)" : `Issue: #${envelope.issue}`;
  const roles = Object.entries(admitted.effectivePolicy.roles)
    .map(([role, ref]) => `${role}=\`${ref.registered_name}\``)
    .join(", ") || "(none)";
  const agents = admitted.agentInventory.map((ref) => ref.registered_name).join(", ") || "(none)";
  return [
    "Workflow request (protocol v2) — /do-work",
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
    `Session: \`${project.session.session_id}\``,
    `Lifecycle: \`${project.session.lifecycle_id}\``,
    `Config byte digest: \`${project.config_byte_sha256}\``,
    `Config semantic digest: \`${project.config_semantic_sha256}\``,
    "Workflow profile: selected exactly once by `workflow_prepare` (not part of project activation)",
    `Qualified agents: ${agents}`,
    `Effective roles: ${roles}`,
    `Leading directive hint: ${envelope.autonomyHint ? "present" : "absent"} (mechanical only; never copy it as the PHASE-0 decision)`,
    "",
    buildClassificationPhaseZero({ label: "leading directive", value: envelope.autonomyHint }),
    "",
    buildWorkflowMatrix(),
    "",
    "### Execution contract",
    "After PHASE-0 classification, call `workflow_prepare` with the complete task, exact canonical branch, typed classification, changed file paths, and issue metadata.",
    "`workflow_prepare` is the only supported workflow-state initialization/update path. Do not use write, edit, bash, or filesystem APIs to create or modify canonical workflow state.",
    "If `workflow_prepare` fails, stop and preserve its structured diagnostics. Do not infer state, profile, provider, roster, or artifact paths.",
    "Continue in this turn: prepare, begin, read instructions, dispatch the declared stages, reconcile results, complete typed artifacts, and advance only after every gate is satisfied.",
    "",
    "### Seven-step resume-from-disk contract",
    ...RESUME_FROM_DISK_STEPS.map((step, index) => `${index + 1}. ${step}`),
    "",
    "### NO-MICROMANAGEMENT WORKER POLICY",
    "Give each worker its outcome, scope, constraints, exact typed artifact schema, and exact dispatch marker — not a scripted implementation. Workers choose their method and return evidence.",
    "Every implementation or review-fix operation is delegated through the declared profile stage. The orchestrator never edits application source, tests, configuration, documentation, or worker artifacts.",
    "",
    "### Hard constraints",
    "- Do not call `task` during PHASE-0; classify first.",
    "- Do not glob for profiles, scan installed plugins, read command sources, or reconstruct policy from keywords.",
    "- Persist the model's typed `classification.autonomous` decision, never the mechanical directive hint.",
    "- Do not mark a stage done without its declared typed artifacts and gate evidence.",
    "- Use only the selected provider, qualified agent identities, and exact artifacts returned by workflow tools.",
  ].join("\n");
}

export type { Complexity, TaskType, WorkflowName };
