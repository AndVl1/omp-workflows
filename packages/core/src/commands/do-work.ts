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

const NATIVE_DOD_ITEM_CONTRACT = [
  "### Native shared DoD typed-item contract (copy this exact block into a qa_tests child task)",
  "Root value is an object with an `items` array.",
  "Each item is an object with non-empty string `criterion`, non-empty string `verify_method`, and `status` equal to `pending` or `met`.",
  "`id` is optional but, when present, must be a non-empty string; `evidence` is optional but must be a string when present. A `met` item requires nonblank evidence.",
].join("\n");
const PER_STAGE_LIFECYCLE_STEPS = [
  "**PER-STAGE LOOP (mode-neutral)** — after every successful `workflow_prepare` (new, resume, or rework), and after every nonterminal successful `workflow_advance`, re-enter this same loop for the returned current stage. Before any direct declared-artifact write or task dispatch, including each dispatch batch, execute exactly `workflow_instructions → workflow_begin → workflow_instructions`; do not write or dispatch between those calls.",
  "**Read instructions and compose selection** — the first `workflow_instructions` call in that sequence must expose the current stage contract (`stage.instructions`, `roles`, `consumes`, `produces`, `artifact_schemas`, `checkpoint`/`gate`, `provenance`, and `state.artifactsDir`). When the stage declares a `roster_policy`, its role list is an ALLOWED POOL, not a fixed one-agent-per-role recipe: compose the dispatch yourself as 1..N semantic occurrences (`role` plus optional `facet`/`focus`/`reason`) drawn only from `allowed_roles`, within `min_workers`/`max_workers` and per-role `multiplicity`. Repeat a role for parallel facets (for example distinct architecture options) and keep the composition situational — task size, risk triggers, and confidence decide whether one agent suffices. NEVER pass concrete agent ids: agent resolution belongs to the live registered mapping, and a missing, disabled, or mismatched registration fails closed.",
  "**Resolve and validate begin** — call `workflow_begin` (passing the semantic selection for roster stages). This records the capability-bound required-input receipt for the current stage. The newest explicit `workflow_begin` handoff supersedes and discards every older handoff, including auto-advance and earlier-begin handoffs; all subsequent task markers, `workflow_complete`, checkpoint/ask, and advance bindings/tokens come only from this newest begin response: use `handoff.dispatch_token` only for `workflow_complete.token`, and use `handoff.advance_token` only for `workflow_checkpoint_ask.token`, `workflow_checkpoint.token`, and `workflow_advance.token`. A swapped token or any token from before this explicit begin, an auto-advance, or an older begin is stale and must be rejected; fail closed rather than retrying with another token. Validate its returned current stage, cursor epoch, frozen `roster_selection`, and workflow against the persisted state. Reject stale, missing, or mismatched selection; never guess a stage from prompt text or a filesystem path. The selection freezes at first issuance: re-issuing the identical semantic selection is idempotent, and a changed selection for an active capability is rejected — continue with the frozen composition or finish the stage first.",
  "**Expose receipt and freeze snapshot** — immediately call the second `workflow_instructions` after `workflow_begin`; it exposes the capability-bound required-input receipt and current contract contents. Treat that returned contract — not disk or memory — as the only workflow instruction source; do not reconstruct schemas or profile data from disk. Ordinary file reads or hash calculations never mint or replace the receipt. Keep opaque capability/advance secrets out of prompts and logs; never add manual acknowledgement fields or substitute free text for typed checkpoint/ask proof.",
  "**Authorize identity** — dispatch only the exact declared role/agent with the current cursor, epoch, and role-specific marker. A marker is typed/structured: missing, malformed, stale, or mismatched markers reject the dispatch before worker work; free-text or legacy autonomy wording is never a bypass.",
  "**Terminal-row ordering** — after consuming an actual SDK task result, first determine whether a genuine terminal row/result exists, bound to the current dispatch/tool_call_id; a worker DM, progress ack, `Still Running`, hub pending snapshot, or artifact appearing alone is not terminal. For a matching terminal row with a completed/success result, FIRST inspect and validate every required role artifact against the current stage `artifact_schemas`, enforce each `ready`, `validation_run`, or `validation_evidence` field only when that schema advertises/requires it, and validate the newest-BEGIN/run/dispatch/epoch authority. Before `workflow_complete`, its `dispatch_id` MUST be the captured canonical dispatch UUID, never the opaque dispatch-marker `task_id`: use a UUID from the genuine native result only when present; otherwise use the same EXACTLY ONE identity-only `workflow_status` metadata lookup on the current run (prefer immediately after spawn, or once if the terminal races first and the UUID remains unknown) to resolve a UNIQUE `dispatches[].id` bound to the accepted task's exact `tool_call_id` + role/agent/slot/current capability/run. This lookup is identity-only, not reconciliation or terminal evidence: `pending`/`background_wait` is neutral; never infer completion, wait for self-resolution, poll, or repeat status. If identity is missing, ambiguous, or mismatched, fail closed or obtain a fresh supported binding; never substitute marker `task_id` or repair arguments. If all are valid, MUST call explicit `workflow_complete` immediately with the captured canonical UUID and newest handoff binding while the canonical dispatch may still be `pending`/`background_wait`. Do not poll or wait for the controller to self-reconcile a completed row: explicit `workflow_complete` is the authenticated join, and `workflow_status`/reconciliation comes only AFTER a successful authenticated complete. Only when no terminal row/result exists yet may `workflow_status` plus `background_wait`/hub wait be used. Native SDK output/result alone is never automatic engine completion. Missing or invalid required artifacts, advertised readiness/evidence fields, receipts, or bindings fail closed; never fabricate or reconstruct them. Matching failed/cancelled/non-success rows retain their actual outcome/evidence and exact newest binding; they never authorize a successful complete or advance.",
  "**Join/fan-in** — for a genuinely matching terminal result, perform one logical join. For `succeeded`, all required declared artifacts must be present and valid; every supplied `artifact_id` must be declared, present, and valid, and each typed artifact (for `dod`, `items` MUST be objects with `criterion`, `verify_method`, and `status` `pending` or `met`, never bare strings or a legacy `criteria` array) must validate before calling `workflow_complete` with the captured canonical dispatch UUID (never marker `task_id`), current handoff binding, exact dispatch identity, terminal outcome/evidence, and exact `artifact_ids`. For `failed`/`cancelled`/other non-success outcomes, call `workflow_complete` with the captured canonical dispatch UUID, actual terminal outcome/evidence, and the same exact identity binding, without claiming success or advancing; the terminal outcome may be recorded without output artifact IDs when none exist, but never invent them. Exact engine-supported idempotent replay or deferred artifact binding after native auto-reconciliation is allowed only after an accepted explicit completion; deferred binding may add engine-authorized validation evidence, but must never fabricate or introduce conflicting outcome, evidence, or identity, execute a duplicate dispatch, or submit stale/conflicting completion. In consilium stages use each role's `slot_artifacts` and then the shared fan-in contract. A native task result/output alone is never artifact completion: explicit `workflow_complete` is the authenticated join. Never authorize reconstruction or manual canonical mutation.",
  "**Producer artifact contracts** — pass the complete, untruncated current-stage `artifact_schemas` entry to every worker assignment; never summarize or reconstruct it. Workers must satisfy every advertised required field. If the advertised schema includes `validation_evidence`, it must be a non-blank string containing actual validation output or provenance from the validation run; the engine's stage gate remains authoritative for readiness.",
  "**QA shared DoD assignment** — when the current stage is `qa_tests`, before every actual child dispatch read the canonical shared sidecar at `<state.artifactsDir>/dod.json`. The native host task MUST include that canonical expected path and either the exact current JSON/items or an honest exact unavailable/invalid/legacy reason; copy the exact `Native shared DoD typed-item contract` block below into the child task. `workflow_instructions.stage.artifact_schemas` is derived from declared `produces` and does not expose this shared sidecar. Missing, empty, legacy, or malformed content is not a new dispatch gate: still follow the existing lifecycle and dispatch, but instruct the child not to fabricate criteria or close items without evidence. For a single QA stage, its sole resolved slot is the sole shared-DoD writer. For a multiworker `consilium`, resolve the full stable slot roster once and assign the first resolved/selected slot as the sole writer; every other slot is strictly read-only and must return evidence/proposed updates without writing `dod.json`. Never transfer ownership when the first slot is already complete or on resume. For an orchestrator QA stage, designate exactly one child in stable child order as writer and keep every other child read-only. The owner may close only with its own nonblank criterion-specific evidence; all children inspect every pending item against its criterion and `verify_method`, preserve unrelated fields/contributions and existing `met` items, keep insufficient items pending, append a QA-owned item only when genuinely needed, write/verify the declared `qa_tests` artifact, and return `dod_updated`, closed/pending item IDs, and evidence references. The DoD is shared mutable authored state, not a declared output, receipt, or `artifact_ids` contribution; no worker may wait for, rerun, or replace another worker to acquire ownership.",
  "**QA sidecar post-complete read** — the child verifies the shared sidecar before returning. For a genuine matching terminal success, validate the declared `qa_tests` artifact and call `workflow_complete` FIRST with the captured canonical dispatch UUID and exact newest handoff binding. Only after `workflow_complete` is explicitly accepted, ordinarily reread the current typed/evidence-consistent DoD at the canonical path before `workflow_advance`; this read is informational/validation only, not an authority or receipt, and must not replace, omit, or delay the required dispatch completion join. Pending remains valid and the later `dod_complete` gate remains authoritative; never blanket-mark items met.",
  "**Checkpoint/gate/advance** — checkpoint permission exists only when the returned stage contract declares it. Before `workflow_advance`, resolve human authorization with `workflow_checkpoint_ask`: it verifies the pending checkpoint, asks the human at the live terminal/RPC surface, and commits the answer through the engine's durable checkpoint ledger (headless sessions fail closed). Use the newest explicit begin handoff's `advance_token` for `workflow_checkpoint_ask.token`; its schema intentionally has no `profile_hash` parameter, so pass only its declared binding fields. Then call `workflow_checkpoint` and `workflow_advance` with that same newest handoff's `advance_token`, preserving `capability_id`, `run_key`, `branch`, `workflow`, `stage_cursor`, `cursor_epoch`, and `loop_iteration`, plus `profile_hash` wherever those schemas declare it. For `workflow_checkpoint`, include `checkpoint_id`, `checkpoint_kind`, `authorization`, `actor_provenance`, `decision`, and `rationale`, copying the ask result's decision, proof, and `loop_iteration` binding verbatim — a reconstructed proof or binding never authorizes, and legacy `mode`/`actor` fields cannot. Never substitute the dispatch token or any pre-begin, auto-advance, or older-begin token; fail closed without retrying. Advance only after gates/evidence pass. If `workflow_advance` succeeds nonterminal, re-enter the PER-STAGE LOOP and execute the full `workflow_instructions → workflow_begin → workflow_instructions` sequence before the next direct write or dispatch; do not substitute a standalone instructions read.",
  "**Readiness rejection after success** — if `workflow_complete` accepted a matching terminal `succeeded` result but `workflow_advance` rejects producer readiness, this is a typed stage-readiness blocker, not a terminal worker failure. Do not call `task`, re-spawn/retry the worker, or call `workflow_prepare` with `mode: \"rework\"` in the same turn; surface the exact blocker and wait for the user's explicit rework request. An ordinary explicit user rework request remains supported.",
] as const;
const REWORK_READ_ONLY_STEPS = [
  "### Rework target/stage discovery (mandatory read-only gate before the first mutation)",
  "This sequence is mandatory for explicit `--rework` and for natural-language requests resolved to `mode: rework`; it is separate from the later per-stage dispatch loop.",
  "Resolve the exact target with the supported read-only `workflow_status` tool using a selector. For an explicit run, pass `{ selector: { run_id } }`; for a title or displayed list item, pass that exact selector object. When no selector is supplied (including a completed run whose session selection is cleared), call `workflow_status` with `{ selector: {} }` to invoke read-only candidate resolution; if it returns `run_selection_required`, use its candidates/snapshot and the native ask flow, then retry status with the exact `selector.list_item`. Never call `workflow_prepare` to discover a target, profile, cursor, or stage.",
  "Immediately after a successful status read, call `workflow_instructions` with the SAME selector object byte-for-byte, including `list_item.snapshot_id`, `index`, and `run_id`. Preserve that selector/list snapshot and the `command_intent_id` unchanged for the first mutation; do not replace it with current session selection, a newly sorted list, or a guessed/latest run.",
  "Require the read-only results to identify one selected run consistently: compare `run_id`, workflow, selected stage id/cursor, and profile hash (`workflow_status.profile_hash`/state profile hash with `workflow_instructions.profile.hash` and its provenance). `profile.path` may be null; pathless registered profiles remain valid when their metadata is present. Missing, stale, or inconsistent status/instructions/profile metadata is fail-closed; do not prepare.",
  "Use the selected `workflow_instructions.profile.stages` as ordered metadata. Before choosing `affected_stage`, state one compact comparison row for each relevant saved producer output: `producer/artifact | saved requirement/decision/acceptance actually read | desired new outcome | compatible? and why`. Account for saved task constraints and relevant supporting evidence. Use already-inline `required_input_contents` as read without rereading; read missing relevant contents read-only from their declared canonical artifact paths. Never infer contents or compatibility from artifact names, paths, metadata, status, `met`, or cursor.",
  "A changed saved requirement, decision, or acceptance affects its producer even if code could be changed immediately. An implementation defect maps to the stage that produces the implementation output in the selected profile only when relevant upstream outputs remain compatible with unchanged requirements. Explicitly justify each retained upstream output, then choose the earliest affected producer from the ordered selected profile and include downstream dependency work; do not hardcode stage names/IDs or use keyword, numeric-position, cursor, first-stage, or other heuristics/defaults.",
  "If relevant content is unavailable or saved task constraints, outputs, or evidence conflict without resolution, stop before mutation. If the desired outcome is genuinely ambiguous, clarify that outcome; NEVER ask the user for a stage ID.",
  "Only after the read-only target and explicit comparison are complete, make the first mutation with `workflow_prepare`, supplying the exact selector/list snapshot/run id, unchanged command intent, feedback, and a non-blank `affected_stage`. If status/instructions discovery or the comparison is unavailable, return its structured error and stop.",
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
      `Canonical workflow target \`${selected.run_id}\` is available for read-only lifecycle discovery; this is a continuation/rework target, not a new task.`,
      `Before any mutation, call \`workflow_status\` with the exact selector \`{ selector: { run_id: "${selected.run_id}" } }\`, then call \`workflow_instructions\` with that SAME selector.`,
      "Preserve the selected run's classification, artifacts, stage history, and prior task text.",
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
          ? "Use the supplied exact run selector in the first `workflow_prepare` call; resume does not reinterpret it from task wording."
          : "For resume without a selector (for example generic `продолжи фичу`), call the existing `workflow_prepare` directly with `{ mode: \"resume\" }`; classification is optional at this lifecycle boundary."
        : "For rework with or without a selector, complete the mandatory read-only `workflow_status(selector) → workflow_instructions(same selector)` gate before the first `{ mode: \"rework\" }` `workflow_prepare` mutation; classification is optional at this lifecycle boundary.",
      ...(envelope.mode === "rework" ? REWORK_READ_ONLY_STEPS : []),
      "If the request names a specific prior run, use its exact selector for the read-only `workflow_status` call and pass that selector unchanged to the same-run `workflow_instructions` call and the first mutation; when the user selects a displayed item, preserve its typed `selector.list_item` snapshot/index/run_id. Never prepare against a retained/current selection and parse a named target afterward.",
      "On `run_selection_required`, MUST use the advertised native interactive `ask` tool in this same registered invocation: if `xd://ask` is mounted, first inspect its schema with `read xd://ask`, then execute it by writing the questions JSON to `xd://ask`; if `ask` is directly exposed, call `ask` directly—never invent another ask tool name. Bind exactly one readable option to each exact returned candidate. For every readable Ask option/description derived from a returned candidate, visibly include that candidate's title, branch, status copied verbatim from the returned candidate (never inferred), and stage. Await the Ask result in this invocation. Then retry read-only `workflow_status` and same-selector `workflow_instructions` before `workflow_prepare` for rework; resume retries `workflow_prepare`. For an option from an actual selection snapshot, preserve and pass the exact original `selector.list_item` binding (`snapshot_id`, `index`, and `run_id`) for that option, never bypassing a stale snapshot with only `run_id`; when no snapshot/list-item binding exists, use the exact selected candidate `run_id` internally (the user need not enter it), never a title that could be ambiguous. Use `selector.title` only for a free-entered name. Never end the turn with final/plain-text selection prose, use `/workflow-view`, take a UUID/title prefeed detour, use `required_human`/`workflow_checkpoint_ask`, choose guessed/latest, or re-arm/delegate selection to a later user turn. If Ask is unavailable, cancelled, or errors, fail closed without selecting or re-arming.",
    ]
    : [
      "### Lifecycle selection",
      "No lifecycle mode was frozen at ingress. Treat an ordinary task as a new workflow; do not use the presence of history to change that decision. Only strong, explicit continuation wording may select resume or rework.",
      "Natural-language requests to correct, revise, amend, or fix a prior result are rework only when they contain substantive feedback about that result; when natural-language intent resolves to rework, run the mandatory read-only target/stage discovery below before any prepare.",
      ...REWORK_READ_ONLY_STEPS,
    ];
  const lifecyclePreparation = continuationMode
    ? [
      envelope.mode === "rework"
        ? "After the mandatory read-only rework gate above, call `workflow_prepare` for the selected rework lifecycle with the exact selector/list snapshot, unchanged command intent, feedback, and non-blank affected_stage. Preserve the canonical state, persisted scope, and persisted files; omit classification unless the tool contract explicitly requires it, and never create a replacement run for a continuation."
        : "Call `workflow_prepare` for the selected resume lifecycle before any new-task PHASE-0 classification. Preserve the canonical state, persisted scope, and persisted files; omit classification unless the tool contract explicitly requires it, and never create a replacement run for a continuation.",
      "`workflow_prepare` is the ONLY supported state initialization/update path: do not call `write`, `edit`, `bash`, or any filesystem API to create or modify `.work-state` files. It revalidates the captured branch and typed selector atomically.",
      "If `workflow_prepare` fails, stop and record the structured typed error — never guess a state path or repair canonical state by hand.",
    ]
    : [
      buildClassificationPhaseZero({ label: "leading directive", value: envelope.autonomyHint }),
      "",
      buildWorkflowMatrix(),
      "",
      "After PHASE-0 classification, build `workflow_prepare.files` only from actual repo-relative target files grounded in the user's task. A user-explicit repo-relative path is already grounded: normalize syntax only (supported repo separators and dot syntax), preserving every path segment, name, and case (`report.ts` remains `report.ts`); NEVER prepend `src/`, relocate into conventional directories, or otherwise semantically rewrite it. If a target path is not explicit or is ambiguous, use `read`/`glob` discovery before prepare; if it remains ungrounded, clarify or fail. Reject or clarify unsafe absolute/parent-traversal paths rather than inventing. Forward only the actual discovered/planned repo-relative paths verbatim as `workflow_prepare.files`, alongside the task, captured canonical branch, classification object, and issue metadata. If selected work needs `dev_agent` and no target can be grounded or planned, fail or clarify before the new prepare.",
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
    NATIVE_DOD_ITEM_CONTRACT,
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
    "After every delegated call or parallel batch, apply terminal-aware ordering: for a succeeded terminal row, validate the current stage schema, required artifacts, and advertised readiness requirements, then, after at most one permitted identity-only status metadata lookup when the canonical UUID is absent, call `workflow_complete` FIRST with success, the captured canonical dispatch UUID (never marker `task_id`), and the exact newest handoff binding; for a failed/cancelled/non-success terminal row, after the same at-most-one identity-only UUID lookup when needed, call `workflow_complete` FIRST with the actual outcome/evidence, captured canonical dispatch UUID, and exact newest binding, without any success artifact/readiness claim; call `workflow_status`/reconciliation only after the accepted explicit completion. The identity lookup is not reconciliation or terminal evidence and may not be repeated, polled, or used to infer completion. If no terminal row/result exists, and only then, use `workflow_status`, `background_wait`, or hub wait. Every delegated task payload must state that `workflow_*` control tools are main-session-only, must not mutate canonical `.work-state` with `bash`, and must use `write` for its declared artifact before returning. On the succeeded path, require every current-stage schema-declared artifact/field, including gate or validation evidence only when advertised, then dispatch the next stage only if the state transition is valid. A subagent return is not permission to improvise, skip stages, or self-complete.",
    "If state, delegation evidence, artifact evidence, or gate evidence is missing/corrupt, or any workflow control tool errors, fail closed: return the structured workflow error and stop or pause through the workflow tools. Do not continue by judgment alone or guess stage content.",
    "",
    "### OPAQUE CAPABILITY EXECUTION PROTOCOL",
    "The `workflow_begin` handoff is the only valid capability credential. Use only the newest explicit handoff's `dispatch_token` for `workflow_complete.token`; use only its `advance_token` for `workflow_checkpoint_ask.token`, `workflow_checkpoint.token`, and `workflow_advance.token`. Swapped, pre-begin, auto-advance, or older-begin tokens are stale and must be rejected; fail closed without retrying with a different token or disclosing secrets. Preserve its capability identity and authorized dispatch records on resume; never invent, reuse stale, or write tokens to `.work-state/`.",
    "The handoff's `profile_hash` is a compact first-30/last-2 binding fingerprint; copy it verbatim in every `workflow_complete`, `workflow_checkpoint`, and `workflow_advance` request. Never abbreviate or reconstruct it.",
    "For `single` and `consilium` stages, call `task` only with the exact newest `workflow_begin` stage cursor, epoch, expected role/agent roster, and `handoff.dispatch_markers`. Treat every `dispatch_markers` block and its embedded `task_id`/`role`/`agent`/`run`/`epoch` fields as OPAQUE: copy them BYTE-FOR-BYTE/verbatim into the corresponding native task prompt/call. Before calling `task`, ensure the outgoing marker equals the newest begin marker exactly; if unavailable or mismatched, fail closed and read a fresh `workflow_begin`/binding rather than dispatch. Never parse, reconstruct, normalize, shorten, remove prefixes (especially the stable `task-` prefix), or substitute name/agent values. Put the exact typed marker verbatim inside each `tasks[].task` string (not only in surrounding context), keep the declared `role` and `agent` beside it, and reject missing or malformed markers before work. After a marker or gate rejection, never retry mutated marker/name/agent variants; obtain a fresh current begin/binding and dispatch its exact marker only if the protocol permits. The marker `task_id` is an opaque stable admission identity only and MUST NEVER be used as `workflow_complete.dispatch_id`. Capture the canonical dispatch UUID from a genuine native result when present; otherwise allow EXACTLY ONE identity-only `workflow_status` metadata lookup on the current run, preferably immediately after spawn or once if a terminal result races first, to resolve a UNIQUE `dispatches[].id` bound to the exact accepted task `tool_call_id` + role/agent/slot/current capability/run. Pending/background_wait is neutral; this lookup is not reconciliation/terminal evidence, never infer completion or wait for self-resolution, poll, repeat status, or repair arguments. Missing, ambiguous, or mismatched UUID identity fails closed or requires a fresh supported binding.",
    "For `orchestrator`, `bash`, or `none` stages, perform only the declared contract action, persist required typed artifacts, then call `workflow_advance` with the current handoff's advance token and evidence.",
    "For `document` stages, dispatch nothing and write nothing by hand: the engine renders the declared document deterministically at the `workflow_advance` boundary, exactly per `stage.document` {format, renderer, path}. Call `workflow_advance` directly with evidence that this is a deterministic document render; a render failure returns a structured error — never hand-write the document or its manifest to force the stage through.",
    "After every delegated call or parallel batch, use terminal-aware ordering: succeeded terminal row → current-stage schema/artifact/readiness validation → at-most-one identity-only UUID lookup only if needed → `workflow_complete` with success, captured canonical UUID (never marker `task_id`), and exact newest binding → status after accepted join; failed/cancelled/non-success terminal row → at-most-one identity-only UUID lookup only if needed → `workflow_complete` FIRST with actual outcome/evidence, captured canonical UUID, and exact binding without success artifact/readiness claim → status after accepted join; absent terminal row → `workflow_status`/`background_wait`/hub wait. The identity lookup is not reconciliation/terminal evidence and cannot be repeated or used to infer completion. A native task result is not artifact completion. Complete only the exact declared artifact IDs, including each consilium `slot_artifacts` ID, and advance only after current-stage dispatches, typed artifacts, and gates are complete. Never call `task` from a stale cursor.",
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
