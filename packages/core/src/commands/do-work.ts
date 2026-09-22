import { parseAutonomousDirective, type WorkflowCommandMode } from "./envelope.js";
import { buildClassificationPhaseZero, buildWorkflowMatrix } from "./classification-contract.js";
import { DETACHED_BRANCH, NO_GIT_BRANCH, resolveActiveBranch } from "../engine/state.js";
import { createWorkflowReadSelector } from "../engine/read-selector.js";
import { resolveConfig, type ResolvedConfig } from "../engine/config.js";
import type { Complexity, TaskType, WorkflowName } from "../engine/types.js";

export interface ParsedWorkEnvelope {
  task: string;
  mode?: WorkflowCommandMode;
  run_id?: string;
  /** One-shot trusted binding issued by an explicit /do-work or /team command. */
  command_intent_id?: string;
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
const PER_STAGE_LIFECYCLE_STEPS = [
  "**PER-STAGE LOOP (mode-neutral)** — after every successful `workflow_prepare` (new, resume, or rework), and after every nonterminal successful `workflow_advance`, re-enter this same loop for the returned current stage. Before any direct declared-artifact write or task dispatch, including each dispatch batch, execute exactly `workflow_instructions → workflow_begin → workflow_instructions`; do not write or dispatch between those calls.",
  "**Read instructions and compose selection** — the first `workflow_instructions` call in that sequence must expose the current stage contract (`stage.instructions`, `roles`, `consumes`, `produces`, `artifact_schemas`, `checkpoint`/`gate`, `provenance`, and `state.artifactsDir`). When the stage declares a `roster_policy`, its role list is an ALLOWED POOL, not a fixed one-agent-per-role recipe: compose the dispatch yourself as 1..N semantic occurrences (`role` plus optional `facet`/`focus`/`reason`) drawn only from `allowed_roles`, within `min_workers`/`max_workers` and per-role `multiplicity`. Repeat a role for parallel facets (for example distinct architecture options) and keep the composition situational — task size, risk triggers, and confidence decide whether one agent suffices. NEVER pass concrete agent ids: agent resolution belongs to the live registered mapping, and a missing, disabled, or mismatched registration fails closed.",
  "**Resolve and validate begin** — call `workflow_begin` (passing the semantic selection for roster stages). This records the capability-bound required-input receipt for the current stage. The newest explicit `workflow_begin` handoff supersedes and discards every older handoff, including auto-advance and earlier-begin handoffs; all subsequent task markers, `workflow_complete`, checkpoint/ask, and advance bindings/tokens come only from this newest begin response. Validate its returned current stage, cursor epoch, frozen `roster_selection`, and workflow against the persisted state. Reject stale, missing, or mismatched selection; never guess a stage from prompt text or a filesystem path. The selection freezes at first issuance: re-issuing the identical semantic selection is idempotent, and a changed selection for an active capability is rejected — continue with the frozen composition or finish the stage first.",
  "**Expose receipt and freeze snapshot** — immediately call the second `workflow_instructions` after `workflow_begin`; it exposes the capability-bound required-input receipt and current contract contents. Treat that returned contract — not disk or memory — as the only workflow instruction source; do not reconstruct schemas or profile data from disk. Ordinary file reads or hash calculations never mint or replace the receipt. Keep opaque capability/advance secrets out of prompts and logs; never add manual acknowledgement fields or substitute free text for typed checkpoint/ask proof.",
  "**Authorize identity** — dispatch only the exact declared role/agent with the current cursor, epoch, and role-specific marker. A marker is typed/structured: missing, malformed, stale, or mismatched markers reject the dispatch before worker work; free-text or legacy autonomy wording is never a bypass.",
  "**Reconcile pending/terminal** — after each actual SDK task result, call `workflow_status`. An actual result means the real terminal task/subagent completion bound to the current dispatch/tool_call_id — not a worker DM, progress ack, `Still Running`, hub pending snapshot, or artifact appearing alone. Active/pending workers, nested waits, polling, and temporary artifact absence are neutral: reconcile/wait without failing, replacing, duplicating, or advancing. `workflow_status` remaining `pending`/`background_wait` before an explicit `workflow_complete` join is expected, not an engine mismatch or reason to wait for automatic transition. Unknown/lost transport and non-terminal outcomes fail closed and never authorize completion, advance, or duplicate dispatch. A genuinely matching terminal `failed`/`cancelled` outcome remains terminal evidence to record with `workflow_complete`, but does not authorize success or advance.",
  "**Join/fan-in** — for a genuinely matching terminal result, perform one logical join. For `succeeded`, all required declared artifacts must be present and valid; every supplied `artifact_id` must be declared, present, and valid, and each typed artifact (for `dod`, `items` MUST be objects with `criterion`, `verify_method`, and `status` `pending` or `met`, never bare strings or a legacy `criteria` array) must validate before calling `workflow_complete` with the current handoff binding, exact dispatch identity, terminal outcome/evidence, and exact `artifact_ids`. For `failed`/`cancelled`, call `workflow_complete` with the actual terminal outcome/evidence and the same exact identity binding, without claiming success or advancing; the terminal outcome may be recorded without output artifact IDs when none exist, but never invent them. Exact engine-supported idempotent replay or deferred artifact binding after native auto-reconciliation is allowed; deferred binding may add engine-authorized validation evidence, but must never fabricate or introduce conflicting outcome, evidence, or identity, execute a duplicate dispatch, or submit stale/conflicting completion. In consilium stages use each role's `slot_artifacts` and then the shared fan-in contract. A native task result/output alone is never artifact completion: explicit `workflow_complete` is the authenticated join. Never authorize reconstruction or manual canonical mutation.",
  "**Producer artifact contracts** — pass the complete, untruncated current-stage `artifact_schemas` entry to every worker assignment; never summarize or reconstruct it. Workers must satisfy every advertised required field. If the advertised schema includes `validation_evidence`, it must be a non-blank string containing actual validation output or provenance from the validation run; the engine's stage gate remains authoritative for readiness.",
  "**Checkpoint/gate/advance** — checkpoint permission exists only when the returned stage contract declares it. Before `workflow_advance`, resolve human authorization with `workflow_checkpoint_ask`: it verifies the pending checkpoint, asks the human at the live terminal/RPC surface, and commits the answer through the engine's durable checkpoint ledger (headless sessions fail closed). Then call `workflow_checkpoint` with the same handoff identity (including `loop_iteration`) plus `checkpoint_id`, `checkpoint_kind`, `authorization`, `actor_provenance`, `decision`, and `rationale`, copying the ask result's decision, proof, and `loop_iteration` binding verbatim — a reconstructed proof or binding never authorizes, and legacy `mode`/`actor` fields cannot. Advance only after gates/evidence pass. If `workflow_advance` succeeds nonterminal, re-enter the PER-STAGE LOOP and execute the full `workflow_instructions → workflow_begin → workflow_instructions` sequence before the next direct write or dispatch; do not substitute a standalone instructions read.",
  "**Readiness rejection after success** — if `workflow_complete` accepted a matching terminal `succeeded` result but `workflow_advance` rejects producer readiness, this is a typed stage-readiness blocker, not a terminal worker failure. Do not call `task`, re-spawn/retry the worker, or call `workflow_prepare` with `mode: \"rework\"` in the same turn; surface the exact blocker and wait for the user's explicit rework request. An ordinary explicit user rework request remains supported.",
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
  let continuation = "No canonical run is selected yet. Prepare a new workflow or resolve the explicit run selector through the trusted session controller.";
  if (envelope.run_id) {
    const selected = createWorkflowReadSelector(cwd, envelope.branch ? { branch: envelope.branch } : {}).read(envelope.run_id);
    continuation = [
      `Canonical workflow state found at \`${selected.state_path}\`. This is a resumable continuation, not a new task.`,
      "Read it through workflow_status/instructions before choosing stages; preserve its classification, artifacts, stage history, and prior task text.",
      "If the user reports a defect in the previous result, pass feedback and the affected stage to workflow_prepare in rework mode.",
      "Do not discard or overwrite completed artifacts unless the reopened stage produces a replacement artifact.",
    ].join("\n");
  }
  const continuationMode = envelope.mode === "resume" || envelope.mode === "rework";
  const lifecycleSelection = continuationMode
    ? [
      "### Lifecycle selection (before new-task PHASE-0)",
      `Resolve the ${envelope.mode} target before any new-task classification; preserve the selected run's canonical task, classification, cursor, artifacts, and dispatch identities.`,
      envelope.mode === "resume"
        ? envelope.run_id
          ? "Use the supplied run selector in the first `workflow_prepare` call; do not reinterpret it from task wording."
          : "For resume without a selector (for example generic `продолжи фичу`), call the existing `workflow_prepare` directly with `{ mode: \"resume\" }`; classification is optional at this lifecycle boundary."
        : "For rework without a selector, call `workflow_prepare` with `{ mode: \"rework\", feedback: <user feedback> }`; classification is optional at this lifecycle boundary.",
      "If the request names a specific prior run, include a typed `selector.title` in that first call; when the user selects a displayed item, include its typed `selector.list_item` snapshot/index/run_id in the first call. Never prepare against a retained/current selection and parse a named target afterward.",
      "On `run_selection_required`, MUST use the advertised native interactive `ask` tool in this same registered invocation: if `xd://ask` is mounted, first inspect its schema with `read xd://ask`, then execute it by writing the questions JSON to `xd://ask`; if `ask` is directly exposed, call `ask` directly—never invent another ask tool name. Bind exactly one readable option to each exact returned candidate. For every readable Ask option/description derived from a returned candidate, visibly include that candidate's title, branch, status copied verbatim from the returned candidate (never inferred), and stage. Await the Ask result in this invocation. Then immediately retry `workflow_prepare`: for an option from an actual selection snapshot, preserve and pass the exact original `selector.list_item` binding (`snapshot_id`, `index`, and `run_id`) for that option, never bypassing a stale snapshot with only `run_id`; when no snapshot/list-item binding exists, use the exact selected candidate `run_id` internally (the user need not enter it), never a title that could be ambiguous. Use `selector.title` only for a free-entered name. Never end the turn with final/plain-text selection prose, use `/workflow-view`, take a UUID/title prefeed detour, use `required_human`/`workflow_checkpoint_ask`, choose guessed/latest, or re-arm/delegate selection to a later user turn. If Ask is unavailable, cancelled, or errors, fail closed without selecting or re-arming.",
    ]
    : [
      "### Lifecycle selection",
      "No lifecycle mode was frozen at ingress. Treat an ordinary task as a new workflow; do not use the presence of history to change that decision. Only strong, explicit continuation wording may select resume or rework.",
    ];
  const lifecyclePreparation = continuationMode
    ? [
      "Call `workflow_prepare` for the selected resume/rework lifecycle before any new-task PHASE-0 classification. Preserve the canonical state, persisted scope, and persisted files; omit classification unless the tool contract explicitly requires it, and never create a replacement run for a continuation. Resume/rework must not recompute scope or files.",
      "`workflow_prepare` is the ONLY supported state initialization/update path: do not call `write`, `edit`, `bash`, or any filesystem API to create or modify `.work-state` files. It revalidates the captured branch and typed selector atomically.",
      "If `workflow_prepare` fails, stop and record the structured typed error — never guess a state path or repair canonical state by hand.",
    ]
    : [
      buildClassificationPhaseZero({ label: "leading directive", value: envelope.autonomyHint }),
      "",
      buildWorkflowMatrix(),
      "",
      "After PHASE-0 classification, derive the normalized repo-relative target files actually discovered or planned from the user's task and forward that exact list verbatim as `workflow_prepare.files`, alongside the task, captured canonical branch, classification object, and issue metadata. Do not ask the engine to infer files, scan the repository to populate them, invent paths, or omit a known target. If selected work needs `dev_agent` and no target can be grounded or planned, fail or clarify before the new prepare.",
      "`workflow_prepare` is the ONLY supported state initialization/update path: do not call `write`, `edit`, `bash`, or any filesystem API to create or modify `.work-state` files. It persists the classification, resolved workflow, task, branch, stages, scope, and durable capability atomically.",
      "If `workflow_prepare` fails, stop and record the structured error — never guess a state path or repair canonical state by hand. The P5 gate reads `classification.autonomous` as the authority.",
      "If confidence is LOW, ask a focused clarification question before preparing an expansive workflow (unless `autonomous` is true; then document a conservative default).",
    ];
  return [
    "/do-work lifecycle routing pass — resolve continuation selection before any new-task PHASE-0 classification.",
    "",
    ...lifecycleSelection,
    "",
    "### Task",
    envelope.task || "(task supplied by the selected run)",
    "",
    "### Lifecycle request",
    `Mode: ${envelope.mode ?? "unspecified (model chooses after classification)"}`,
    envelope.run_id ? `Run selector: \`${envelope.run_id}\`` : "Run selector: resolve from the session/list context",
    envelope.command_intent_id
      ? `Command intent token: \`${envelope.command_intent_id}\` (trusted binding; pass this exact value as command_intent_id to workflow_prepare and never omit, replace, or infer it)`
      : "Command intent token: none (implicit lifecycle selection remains model-controlled)",
    "Explicit mode is authoritative; do not reinterpret it from task wording or state presence.",
    "",
    "### Metadata",
    issueMeta + branchMeta,
    "",
    continuation,
    "",
    ...lifecyclePreparation,
    "",
    "Continue executing in THIS TURN: do not stop after lifecycle selection or preparation; immediately enter the per-stage lifecycle loop.",
    "",
    "### Per-stage lifecycle loop (mandatory for every stage in every mode)",
    ...PER_STAGE_LIFECYCLE_STEPS.map((step, index) => `${index + 1}. ${step}`),
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
    "You are the workflow orchestrator, not an implementation agent. Your allowed work is limited to reading application code, invoking engine-owned workflow control tools, writing declared typed artifacts under the exact `state.artifactsDir` returned by `workflow_instructions`, and deterministic auxiliary operations required to inspect or coordinate the run. No feature/legacy artifact path or fallback is authorized.",
    "NEVER use `write` or `edit` on application source, tests, configuration, lockfiles, documentation, or canonical workflow state. NEVER patch a subagent's code, validation, or artifact to make a stage pass.",
    "Every implementation, review-fix, or source-changing operation MUST be delegated through the profile's `single`/`consilium` stage. A genuinely failed/cancelled worker may be re-spawned only through the declared lifecycle path; a succeeded worker whose completion is later rejected by a producer-readiness gate is not a worker failure, so do not retry, re-spawn, or call `workflow_prepare` with `mode: \"rework\"` in the same turn. Surface the typed blocker and wait for an explicit user rework request; do not fix the artifact yourself.",
    "Registered command ingress captures the authoritative canonical branch for both new and continuation requests. Use that captured value in atomic `workflow_prepare`, which revalidates branch and any retained quiescent selection under its mutation lock; do not add a separate shell/Git dependency before this call. After preparation, and again at strict stages, preserve the existing bounded read-only branch checks against the persisted binding; any divergence fails closed. NEVER switch, checkout, create, pull, reuse stale branch metadata, or rebind an active run.",
    "Selected-run artifact proof permits only bounded sanitized read-only Git inspection: inline `GIT_OPTIONAL_LOCKS=0 git --no-pager -c core.fsmonitor=false ...` (with no env or the exact one-key env) or non-inline `git --no-pager -c core.fsmonitor=false ...` with exact env `{ GIT_OPTIONAL_LOCKS: \"0\" }`; allow only bounded `status`, `log`, `diff`, `show`, and exactly `branch --show-current`, with `diff`/`show` requiring `--no-ext-diff --no-textconv`. Reject wrong/extra env, omitted env on the non-inline form, unsupported args, helpers/wrappers, mutations, and injection.",
    "Version-control synchronization, integration, mutation, and publication are not discovery-orchestrator authority: `fetch`/`pull`, branch setup, `add`/`commit`/`push`, merge/rebase/cherry-pick, and PR commands belong only to an explicitly declared actor/stage contract.",
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
    "Checkpoint permission comes only from the current stage contract plus an explicit typed `workflow_checkpoint` envelope (`checkpoint_id`, `checkpoint_kind`, `authorization`, `actor_provenance`, `decision`, `rationale`, and the handoff's `loop_iteration`); completion intent, free text, prompt wording, worker output, or legacy mode/actor fields cannot infer approval. A human decision enters the ledger only through `workflow_checkpoint_ask`'s interactive answer, whose proof, decision, and `loop_iteration` binding are copied verbatim — never a self-composed proof or rebuilt binding.",
    "",
    "### Tool permission summary",
    "| Operation | Orchestrator |",
    "| --- | --- |",
    "| read/glob/grep | ALLOW |",
    "| write/edit declared artifacts under `state.artifactsDir` returned by `workflow_instructions` | ALLOW |",
    "| write/edit application source or project files | DENY |",
    "| direct write/edit canonical workflow state | DENY |",
    "| bounded selected-run Git artifact proof (`status`, `log`, `diff`, `show`, exactly `branch --show-current`; canonical sanitized prefix/env; `diff`/`show` require `--no-ext-diff --no-textconv`) | ALLOW |",
    "| branch setup (`git checkout`, `git switch`, branch creation) | DENY |",
    "| branch synchronization (`git fetch`, `git pull`, `git pull --rebase`) | DENY |",
    "| history integration (`git merge`, `git rebase`, `git cherry-pick`) | DENY |",
    "| version-control/publication (`git add`, `git commit`, `git push`, `gh pr create`/`gh pr view`/`gh pr checks`/`gh pr status`) | DENY |",
    "| direct source/worktree mutations (`git checkout -- <path>`, `git restore`, `git reset`, `git clean`, `git mv`, `git rm`, `git stash`) | DENY |",
    "| task for a declared stage | ALLOW |",
    "| task outside the active profile/state contract | DENY |",
    "| direct implementation or review-fix | DENY |",
  ].join("\n");
}

export type { Complexity, TaskType, WorkflowName };
