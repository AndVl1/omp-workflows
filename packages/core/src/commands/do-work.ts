import { parseAutonomousDirective } from "./envelope.js";
import { buildClassificationPhaseZero, buildWorkflowMatrix } from "./classification-contract.js";
import { DETACHED_BRANCH, NO_GIT_BRANCH, resolveActiveBranch, resolveState } from "../engine/state.js";
import { resolveConfig, type ResolvedConfig } from "../engine/config.js";
import type { Complexity, TaskType, WorkflowName } from "../engine/types.js";

export interface ParsedWorkEnvelope {
  task: string;
  /**
   * MECHANICAL hint from the leading-directive parser. NON-AUTHORITATIVE:
   * PHASE-0 has the main LLM decide `autonomous` from the full task
   * semantics; this value is rendered as a hint and never persisted.
   */
  autonomyHint: boolean;
  issue: number | null;
  branch: string | null;
}

/** Config shape consumed by the prompt, including resolver provenance/metadata. */
export type WorkTeamConfig = Partial<ResolvedConfig>;

export function parseWorkEnvelope(args: string, cwd: string): ParsedWorkEnvelope {
  const directive = parseAutonomousDirective(args);
  const autonomyHint = directive.autonomyHint;
  const cleaned = directive.task;
  const issueMatch = cleaned.match(/issue=#(\d+)/);
  const issue = issueMatch ? Number(issueMatch[1]) : null;
  const task = (issueMatch ? cleaned.replace(issueMatch[0], "") : cleaned).trim();
  const activeBranch = resolveActiveBranch(cwd);
  const branch = activeBranch === NO_GIT_BRANCH || activeBranch === DETACHED_BRANCH ? null : activeBranch;
  return { task, autonomyHint, issue, branch };
}

function loadTeamConfig(cwd: string): WorkTeamConfig {
  const config = resolveConfig(cwd);
  const mapping = config.agent_mapping;
  if (!mapping) return config;
  return {
    ...config,
    roles: Object.fromEntries(
      Object.entries(config.roles).map(([role, agent]) => [role, mapping.resolved_roles[role] ?? agent]),
    ),
  };
}
const RESUME_FROM_DISK_STEPS = [
  "**Prepare** — call `workflow_prepare` once with the PHASE-0 classification, exact canonical branch, changed files, and issue metadata. On a matching branch, continue the existing run; preserve its task, classification, stage history, artifact IDs, and capability/dispatch identities instead of creating or resetting state.",
  "**Read instructions and compose selection** — after preparation succeeds, call `workflow_instructions` BEFORE `workflow_begin` and read the current stage contract (`stage.instructions`, `roles`, `consumes`, `produces`, `artifact_schemas`, `checkpoint`/`gate`, `provenance`, and `state.artifactsDir`). When the stage declares a `roster_policy`, its role list is an ALLOWED POOL, not a fixed one-agent-per-role recipe: compose the dispatch yourself as 1..N semantic occurrences (`role` plus optional `facet`/`focus`/`reason`) drawn only from `allowed_roles`, within `min_workers`/`max_workers` and per-role `multiplicity`. Repeat a role for parallel facets (for example distinct architecture options) and keep the composition situational — task size, risk triggers, and confidence decide whether one agent suffices. NEVER pass concrete agent ids: agent resolution belongs to the live registered mapping, and a missing, disabled, or mismatched registration fails closed.",
  "**Resolve and validate begin** — call `workflow_begin` (passing the semantic selection for roster stages), then validate the returned current stage, cursor epoch, frozen `roster_selection`, and workflow against the persisted state. Reject stale, missing, or mismatched selection; never guess a stage from prompt text or a filesystem path. The selection freezes at first issuance: re-issuing the identical semantic selection is idempotent, and a changed selection for an active capability is rejected — continue with the frozen composition or finish the stage first.",
  "**Freeze snapshot/capability** — treat the `workflow_begin` handoff as the immutable run snapshot (run key, profile hash, capability identity, cursor, epoch, and dispatch markers), and re-read `workflow_instructions` so the returned contract — not disk or memory — is the only workflow instruction source; do not reconstruct schemas or profile data from disk.",
  "**Authorize identity** — dispatch only the exact declared role/agent with the current cursor, epoch, and role-specific marker. A marker is typed/structured: missing, malformed, stale, or mismatched markers reject the dispatch before worker work; free-text or legacy autonomy wording is never a bypass.",
  "**Reconcile pending/terminal** — after every task result call `workflow_status`. Pending or active workers, `Still Running`, nested waits, polling, and temporary artifact absence are neutral: wait/reconcile and do not fail, replace, duplicate, or advance the worker. Any non-succeeded terminal result fails closed until the engine reports a valid recovery.",
  "**Join/fan-in** — for every succeeded dispatch, call `workflow_complete` exactly once with its identity binding and exact `artifact_ids`; in consilium stages use each role's `slot_artifacts` and then the shared fan-in contract. A native task result is never artifact completion, and every typed artifact (for `dod`, `items` MUST be objects with `criterion`, `verify_method`, and `status` `pending` or `met`, never bare strings or a legacy `criteria` array) must validate before joining.",
  "**Checkpoint/gate/advance** — checkpoint permission exists only when the returned stage contract declares it. Before `workflow_advance`, call `workflow_checkpoint` with the same handoff identity plus `checkpoint_id`, `checkpoint_kind`, `authorization`, `actor_provenance`, `decision`, and `rationale`; legacy `mode`/`actor` fields cannot authorize. Advance only after gates/evidence pass; after `workflow_advance`, call `workflow_instructions` again and remain in this session for later feedback.",
] as const;


export function buildDoWorkPrompt(envelope: ParsedWorkEnvelope, cwd: string): string {
  const config = loadTeamConfig(cwd);
  const roles = Object.entries(config.roles ?? {});
  const roleTable = roles.map(([role, agent]) => `| \`${role}\` | \`${agent}\` |`).join("\n");
  const configDiagnostics = config.diagnostics?.length
    ? [
      "Diagnostics (configuration is not silently ignored):",
      ...config.diagnostics.map(diagnostic => `- [${diagnostic.code}] ${diagnostic.path}: ${diagnostic.message}`),
    ].join("\n")
    : "Diagnostics: none";
  const issueMeta = envelope.issue ? `Issue: #${envelope.issue}\n` : "";
  const branchMeta = envelope.branch
    ? `Branch: \`${envelope.branch}\` (canonical session branch; persist this exact value)\n`
    : "Branch: (no git work tree; strict workflow transitions cannot start)\n";
  const resolvedState = resolveState(cwd, envelope.branch ?? undefined);
  let continuation = "No existing do-work state was found. Start a new workflow.";
  if (resolvedState.state && !resolvedState.isStale && resolvedState.statePath) {
    continuation = [
      `Existing workflow state found at \`${resolvedState.statePath}\`. This is a resumable continuation, not a new task.`,
      "Read it before choosing stages; preserve its classification, artifacts, stage history, and prior task text.",
      "If the user reports a defect in the previous result, append the feedback to the task/history, reopen the smallest affected stage, reset only that stage and its downstream stages to pending, and continue from there.",
      "Do not discard or overwrite completed artifacts unless the reopened stage produces a replacement artifact.",
    ].join("\n");
  }
  return [
    "/do-work classification pass — understand the task before selecting a workflow.",
    "",
    "### Task",
    envelope.task,
    "",
    "### Metadata",
    issueMeta + branchMeta,
    "",
    continuation,
    "",
    buildClassificationPhaseZero({ label: "leading directive", value: envelope.autonomyHint }),
    "",
    buildWorkflowMatrix(),
    "",
    "After PHASE-0 classification, call `workflow_prepare` with the task, the exact canonical branch, the classification object, changed file paths, and issue metadata. For a continuation, pass the existing feedback and affected stage instead of creating a new state.",
    "`workflow_prepare` is the ONLY supported state initialization/update path: do not call `write`, `edit`, `bash`, or any filesystem API to create or modify `.work-state` files. It persists the classification, resolved workflow, task, branch, stages, scope, and durable capability atomically.",
    "If `workflow_prepare` fails, stop and record the structured error — never guess a state path or repair canonical state by hand. The P5 gate reads `classification.autonomous` as the authority.",
    "If confidence is LOW, ask a focused clarification question before preparing an expansive workflow (unless `autonomous` is true; then document a conservative default).",
    "Continue executing in THIS TURN: do not stop after printing CLASSIFICATION or preparing state; immediately enter the eight-step contract.",
    "",
    "### Eight-step resume-from-disk contract (mandatory for every continuation)",
    ...RESUME_FROM_DISK_STEPS.map((step, index) => `${index + 1}. ${step}`),
    "",
    "### NO-MICROMANAGEMENT WORKER POLICY",
    "Give each worker the outcome, scope, constraints, exact typed artifact schema, and exact dispatch marker — not a scripted implementation. Do not prescribe code shape, file edits, command sequences, validation choreography, or a replacement worker; the delegated role chooses its method and returns evidence.",
    "Pending/active workers, `Still Running`, nested waits, polling, and temporary artifact absence are neutral runtime states. Do not poll-loop, duplicate, fail, or replace a worker; reconcile through the engine and wait for a terminal result.",
    "",
    "### Role mapping (effective runtime resolution)",
    "| Role | Agent |",
    "| --- | --- |",
    roleTable || "| (no roles configured) | |",
    "",
    "### Runtime configuration",
    `Source: \`${config.config_source ?? "defaults"}\``,
    `Path: \`${config.config_path ?? "(none)"}\``,
    configDiagnostics,
    "",
    "### Hard constraints",
    "- Do NOT call `task` during classification.",
    "- Do NOT glob for workflow files or scan installed plugins.",
    "- Do NOT read command sources or reconstruct classification from keywords.",
    "- Do NOT copy the autonomy hint ([AUTONOMOUS]/natural directive) into state as the decision —",
    "  persist your own `autonomous` classification from PHASE-0.",
    "- Do NOT mark a stage done without its required artifact and gate evidence.",
    "",
    "### URL-FIRST LECTURE_RESEARCH CONTRACT",
    "- The only user content prerequisite is exactly one public YouTube video/playlist URL plus a non-empty natural-language prompt. Do NOT ask for or require a transcript, captions, recording, notes, or media file.",
    "- For `LECTURE_RESEARCH`, resolve `lecture-research` and walk its six stages mechanically. Intake writes `lecture_intake` with the URL and acquisition-pending provenance; immediately after intake, the orchestrator MUST invoke the consumer-provided main-session `lecture_acquire` tool and require its `lecture_acquisition` artifact.",
    "- The core profile does not fetch URLs. Provider/API credentials, rights, and setup are installation concerns owned by the consumer that registers `lecture_acquire`; if the tool/provider is unavailable, fail closed rather than asking the user for a transcript.",
    "- Mapping consumes normalized acquisition evidence and performs no network access.",
    "- This workflow is research-only and ends at the explicit human approval/stop gate. No implementation, task creation, or code work starts before approval; approval creates no implicit implementation stage.",
    "",
    "### STRICT ORCHESTRATOR POLICY (non-negotiable)",
    "You are the workflow orchestrator, not an implementation agent. Your allowed work is limited to reading application code, invoking engine-owned workflow control tools, writing declared typed artifacts under the exact `state.artifactsDir` returned by `workflow_instructions` (feature runs use `.work-state/features/<slug>/artifacts`; legacy runs use `.work-state/artifacts`), and deterministic auxiliary operations required to inspect or coordinate the run.",
    "NEVER use `write` or `edit` on application source, tests, configuration, lockfiles, documentation, or canonical workflow state. NEVER patch a subagent's code, validation, or artifact to make a stage pass.",
    "Every implementation, review-fix, or source-changing operation MUST be delegated through the profile's `single`/`consilium` stage. If a subagent fails, returns incomplete evidence, or produces incorrect work, re-spawn the same role with a corrected task; do not fix it yourself.",
    "Version-control/review control-plane operations are allowed once delegated work is ready: inspect with `git status`, `git diff`, `git log`, or `git show`; synchronize with `git fetch`, `git pull`, or `git pull --rebase`; integrate delegated commits with `git merge`, `git rebase`, or `git cherry-pick`; then `git add`, `git commit`, non-force `git push`, and `gh pr create`/`gh pr view`. At discovery start, create or select the working branch with `git checkout <branch>`, `git checkout -b <branch>`, `git switch <branch>`, or `git switch -c <branch>`. These operations reconcile or publish worker changes; they do not authorize editing source yourself.",
    "After every delegated call or parallel batch: stop and reconcile the result through `workflow_status` and the engine-owned completion/advance tools. Every delegated task payload must state that `workflow_*` control tools are main-session-only, must not mutate canonical `.work-state` with `bash`, and must use `write` for its declared artifact before returning. Require every declared artifact and gate/validation evidence, then dispatch the next stage only if the state transition is valid. A subagent return is not permission to improvise, skip stages, or self-complete.",
    "If state, delegation evidence, artifact evidence, or gate evidence is missing/corrupt, or any workflow control tool errors, fail closed: return the structured workflow error and stop or pause through the workflow tools. Do not continue by judgment alone or guess stage content.",
    "",
    "### OPAQUE CAPABILITY EXECUTION PROTOCOL",
    "The `workflow_begin` handoff is the only valid capability credential. Preserve its capability identity and authorized dispatch records on resume; never invent, reuse stale, or write tokens to `.work-state/`.",
    "The handoff's `profile_hash` is a compact first-30/last-2 binding fingerprint; copy it verbatim in every `workflow_complete`, `workflow_checkpoint`, and `workflow_advance` request. Never abbreviate or reconstruct it.",
    "For `single` and `consilium` stages, call `task` only with the exact returned stage cursor, epoch, expected role/agent roster, and role-specific marker from `handoff.dispatch_markers`. Put that typed marker verbatim inside each `tasks[].task` string (not only in surrounding context), keep the declared `role` and `agent` beside it, and reject missing or malformed markers before work. Never replace a marker with free text, a legacy alias, or an autonomous/completion claim.",
    "For `orchestrator`, `bash`, or `none` stages, perform only the declared contract action, persist required typed artifacts, then call `workflow_advance` with the current handoff's advance token and evidence.",
    "For `document` stages, dispatch nothing and write nothing by hand: the engine renders the declared document deterministically at the `workflow_advance` boundary, exactly per `stage.document` {format, renderer, path}. Call `workflow_advance` directly with evidence that this is a deterministic document render; a render failure returns a structured error — never hand-write the document or its manifest to force the stage through.",
    "After every delegated call or parallel batch, reconcile through `workflow_status`; a native task result is not artifact completion. Complete only the exact declared artifact IDs, including each consilium `slot_artifacts` ID, and advance only after current-stage dispatches, typed artifacts, and gates are complete. Never call `task` from a stale cursor.",
    "Checkpoint permission comes only from the current stage contract plus an explicit typed `workflow_checkpoint` envelope (`checkpoint_id`, `checkpoint_kind`, `authorization`, `actor_provenance`, `decision`, and `rationale`); completion intent, free text, prompt wording, worker output, or legacy mode/actor fields cannot infer approval.",
    "",
    "### Tool permission summary",
    "| Operation | Orchestrator |",
    "| --- | --- |",
    "| read/glob/grep | ALLOW |",
    "| write/edit declared artifacts under `state.artifactsDir` returned by `workflow_instructions` | ALLOW |",
    "| write/edit application source or project files | DENY |",
    "| direct write/edit canonical workflow state | DENY |",
    "| git status, git diff, git log, git show, git fetch, git pull, git pull --rebase | ALLOW |",
    "| git add, git commit, git merge, git rebase, git cherry-pick, non-force git push | ALLOW |",
    "| gh pr create, gh pr view, gh pr checks, gh pr status | ALLOW |",
    "| branch setup (`git checkout <branch>`, `git checkout -b <branch>`, `git switch <branch>`, `git switch -c <branch>`) | ALLOW |",
    "| direct source/worktree mutations (`git checkout -- <path>`, `git restore`, `git reset`, `git clean`, `git mv`, `git rm`, `git stash`) | DENY |",
    "| task for a declared stage | ALLOW |",
    "| task outside the active profile/state contract | DENY |",
    "| direct implementation or review-fix | DENY |",
  ].join("\n");
}

export type { Complexity, TaskType, WorkflowName };
