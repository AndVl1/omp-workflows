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
  "### Native shared DoD typed-item contract (copy this exact block into a QA-owner child task)",
  "The shared DoD is a supplemental sidecar, not a workflow output. Its root value is an object with an `items` array.",
  "Each item is an object with non-empty string `criterion`, non-empty string `verify_method`, and `status` equal to `pending` or `met`.",
  "`id` is optional but, when present, must be a non-empty string; `evidence` is optional but must be a string when present. A `met` item requires nonblank evidence.",
].join("\n");
const PER_STAGE_LIFECYCLE_STEPS = [
  "**PER-STAGE LOOP (mode-neutral)** — after every successful `workflow_prepare` (new, resume, or rework), and after every nonterminal successful `workflow_advance`, re-enter this loop for the returned current stage. Read the current contract before dispatch or publication; do not continue from stale prompt text.",
  "**Read and freeze the stage contract** — call `workflow_instructions → workflow_begin → workflow_instructions`. The first `workflow_instructions` result is the only source for the current stage's `instructions`, `consumes`, `produces`, complete `artifact_schemas`, checkpoint/gate, provenance, roster policy, assignment kind, and required-input receipt. `workflow_begin` freezes the trusted assignment; the second instructions result exposes the receipt-bound contract. Do not reconstruct profile data, schemas, paths, or identity from disk.",
  "**Dispatch only declared work** — use the semantic roster selection from the current contract and dispatch only the exact trusted role/agent assignment. The main session may act only on its own profile-declared `orchestrator` or `tool` assignment; it may not submit for a worker, another slot, or an unassigned stage. Ordinary worker identity comes from host lineage. Native CTO assignments use the separate configured-lead → roster route and never an ordinary workflow selector.",
  "**Submit structured outputs** — publish through `workflow_submit_result` with exactly one of `{ \"outputs\": { ... } }` or `{ \"outputs_path\": \"stage-output.json\" }`. For large worker results prefer a workspace-relative file containing exactly `{ outputs }`, written programmatically using JSON.stringify (JS eval: `await Bun.write('stage-output.json', JSON.stringify({ outputs }));`), then call the tool. Use only declared output IDs and direct schema-matching values. No model-supplied workspace/role/run/dispatch/token authority, canonical state writes, or manual JSON assembly. Only the accepted receipt proves publication.",
  "**Schema and delivery errors** — pass the complete current schema to the producer. Schema refusal returns code/error/field_errors; file read/path/JSON refusal returns code/error without field_errors. Repair only the submitted file/payload or publication call and resubmit from the same assignment when still live; do not repeat completed research or implementation. This delivery method adds no terminal worker recovery.",
  "**Receipt and immutable publication** — an accepted submission returns the engine receipt with submission identity, digest, immutable output references, and provenance. Treat that receipt as the only publication proof. Exact replay returns the same receipt; a changed payload requires an authorized new iteration. Never copy receipt fields into workflow state or manufacture a receipt from a file, transcript, path, or worker prose.",
  "**Terminal is separate from submission** — only a worker producer has a worker lifecycle terminal, and it must be an actual host result bound to the current dispatch/tool call. Orchestrator and registered-tool producers, including `lecture_acquire`, have no worker terminal to wait for; their trusted callback/result is separate from publication. A receipt, artifact, DM, progress message, `Still Running`, or missing response is not a worker terminal. A worker terminal without an accepted submission leaves the stage incomplete and enters `workflow_recover` for bounded submission repair; an accepted submission does not assert that the worker has stopped.",
  "**Engine fan-in and readiness** — each consilium slot submits only its own declared outputs. The engine preserves slot provenance, performs immutable publication and deterministic fan-in, and evaluates required outputs/validation/readiness at the stage boundary. Do not merge, rename, unwrap, copy, or substitute slot payloads, and do not treat one receipt as full fan-in.",
  "**Approval is separate** — only a checkpoint declared by the current profile can block/authorize advance. Resolve human approval through `workflow_checkpoint_ask` and record the returned typed decision through the declared checkpoint path; policy-auto is valid only where the profile permits it. Submission receipt, worker terminal, DoD, planning consent, or free text never grants result approval.",
  "**Recovery is evidence-bound** — use `workflow_recover` diagnose/reconcile for a typed worker-host outcome only when the producer kind is `worker`; `unknown`, `live`, `running`, `disconnected`, timeout, generic SDK error, and absent worker response mean observe/wait (or the exact supported recovery action), never blind replacement. Orchestrator/tool/document producers have no worker terminal or worker replacement path; use their trusted result/callback or engine-rendered/error outcome and fail closed when unavailable. A worker replacement is legal only after an attested terminal failure/cancel or attested preflight-not-started result and an authorized bounded recovery; never invent host reconnect/resume support.",
  "**QA shared DoD** — for `qa_tests` or `manual_qa`, before every actual child dispatch read the canonical `<state.artifactsDir>/dod.json` sidecar and include its exact current typed contents or honest unavailable/invalid reason plus the exact shared DoD contract below. The sidecar is supplemental and is never included in `workflow_submit_result.outputs` or used as a declared stage output.",
  "**Advance only after the engine says ready** — after accepted receipts, complete fan-in, validation, supplemental DoD, and the current checkpoint decision are present, require a matching host terminal only for worker producers; orchestrator/tool/document producers have no worker terminal to wait for and rely on their trusted result/callback or engine rendering. Then call the current workflow transition tool with its current handoff binding. A readiness rejection is a typed blocker: do not re-dispatch or rework in the same turn; surface the exact error and wait for explicit rework.",
];
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
      ? `Command intent token: \`${envelope.command_intent_id}\` (one-shot trusted binding for this registered invocation: pass this exact value as command_intent_id until its first successful workflow_prepare; never omit, replace, or infer it while pending. Success consumes it. Never replay it for a later resume or another lifecycle request; a new registered command supplies a fresh token, while an implicit continuation without a new command intent omits command_intent_id.)`
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
    "Give each worker the outcome, scope, constraints, complete current-stage schemas, current assignment kind, and exact dispatch marker — not a scripted implementation. Workers choose their source-edit and validation method, then submit declared workflow outputs through `workflow_submit_result`; do not ask them to hand-write workflow JSON or canonical artifact files.",
    "Pending/active workers, `Still Running`, nested waits, transport loss, timeout, generic SDK errors, and temporary output absence are neutral runtime states. Observe/reconcile through the engine and wait for an attested terminal result; do not poll-loop, duplicate, or replace a worker without authorized recovery.",
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
    "- For `LECTURE_RESEARCH`, resolve `lecture-research` and walk its six stages mechanically. The `intake` orchestrator publishes only its own declared `lecture_intake` assignment through `workflow_submit_result`; it must not write a workflow artifact file by hand.",
    "- At `acquisition`, the main session MUST invoke the consumer-provided `lecture_acquire` tool. That registered tool publishes `lecture_acquisition` through the trusted engine API as a profile-declared `tool` assignment; it never impersonates a worker, accepts worker identity fields, or relies on a manually copied path. If the tool/provider is unavailable, fail closed rather than asking the user for a transcript.",
    "- The core profile does not fetch URLs. Provider/API credentials, rights, and setup are installation concerns owned by the consumer that registers `lecture_acquire`; mapping consumes only the accepted normalized acquisition receipt and performs no network access.",
    "- This workflow is research-only and ends at the explicit human approval/stop gate. No implementation, task creation, or code work starts before approval; approval creates no implicit implementation stage.",
    "",
    "### STRICT ORCHESTRATOR POLICY (non-negotiable)",
    "You are the main-session workflow orchestrator, not a worker. Invoke engine-owned lifecycle/control tools and publish only this session's profile-declared assignment. `workflow_submit_result` accepts exactly one of `{ outputs }` or `{ outputs_path }`; neither grants authority to publish for a worker/slot or another stage. A tool assignment such as lecture_acquire publishes through its trusted consumer callback, not invented worker context.",
    "NEVER use `write` or `edit` on application source, tests, configuration, lockfiles, documentation, canonical workflow state, or declared workflow outputs. Source changes belong to declared worker stages and workers retain the normal source-edit tools. Supplemental DoD responsibilities remain allowed exactly where the profile/CTO contract assigns them.",
    "SDK service writes to exact `xd://report_issue` and root `agent://<recipient>` routes are diagnostic reporting and coordination messages, not file writes. Use only the single-path `write` transport; no subpaths, query/fragment, mixed file targets, or edit transport. Existing host/claim admission and SDK recipient/device authorization still apply; these services grant no filesystem, lifecycle, dispatch, or publication authority.",
    "Every implementation, review-fix, or source-changing operation MUST be delegated through the profile's `single`/`consilium` stage. A producer contract error is repaired by the same assigned producer from the returned `code` and `field_errors`; it is not a reason to repeat implementation. A succeeded/accepted result later blocked by readiness is a typed blocker: do not retry, replace, or call `workflow_prepare` with `mode: \"rework\"` in the same turn; surface the blocker and wait for explicit user rework.",
    "Registered command ingress captures the authoritative canonical branch for both new and continuation requests. Use that captured value in atomic `workflow_prepare`, which revalidates branch and any retained quiescent selection under its mutation lock; do not add a separate shell/Git dependency before this call. After preparation, and again at strict stages, preserve the existing bounded read-only branch checks against the persisted binding; any divergence fails closed. NEVER switch, checkout, create, pull, reuse stale branch metadata, or rebind an active run.",
    "Selected-run artifact proof permits only bounded sanitized read-only Git inspection: inline `GIT_OPTIONAL_LOCKS=0 git --no-pager -c core.fsmonitor=false ...` (with no env or the exact one-key env) or non-inline `git --no-pager -c core.fsmonitor=false ...` with exact env `{ GIT_OPTIONAL_LOCKS: \"0\" }`; allow only bounded `status`, `log`, `diff`, `show`, and exactly `branch --show-current`. `log` permits at most one positive short count `-N` from 1 through 100, e.g. `log -8 --oneline`; only `diff`/`show` require `--no-ext-diff --no-textconv`. Reject wrong/extra env, omitted env on the non-inline form, unsupported args, helpers/wrappers, mutations, and injection.",
    "Version-control synchronization, integration, mutation, and publication are not discovery-orchestrator authority: `fetch`/`pull`, branch setup, `add`/`commit`/`push`, merge/rebase/cherry-pick, and PR commands belong only to an explicitly declared actor/stage contract.",
    "After each delegated call or parallel batch, distinguish the producer result from any accepted submission receipt. A matching host terminal is required only for a worker producer and must bind to the current dispatch/tool call; orchestrator/tool/document producers have no worker terminal to wait for and rely on trusted result/callback or engine rendering. Receipt, artifact, transcript, progress, or timeout is not a worker terminal. Accepted receipts are immutable engine publication only: they do not prove terminality where a worker terminal is required, full fan-in, DoD, readiness, or approval. For missing/invalid submission use `workflow_recover` and exact field errors; for live/unknown/disconnected worker execution observe or wait. Replace only after attested terminal failure/cancel or attested preflight-not-started plus authorized bounded recovery; never invent host reconnect support or create a second writer.",
    "If state, trusted assignment, receipt, applicable worker-terminal evidence, artifact evidence, or gate evidence is missing/corrupt, fail closed: return the structured workflow error and stop or pause through the supported workflow tools. Do not continue by judgment alone, hand-edit state, guess a path, or fabricate producer content.",
    "",
    "### OPAQUE CAPABILITY EXECUTION PROTOCOL",
    "The current workflow_begin result freezes assignment, input receipt, roster, cursor, epoch and stage contract. Use its exact opaque dispatch marker; never reconstruct identity values. workflow_submit_result accepts outputs or outputs_path only; outputs_path selects payload delivery inside the authenticated producer workspace, never token, run, role, worker or authority.",
    "`handoff.profile_hash` is intentionally a compact fingerprint (first 30 plus last 2 characters); state and `workflow_instructions` expose the full SHA-256. Different lengths or direct string inequality between these representations do not mean profile drift. Copy the newest handoff value verbatim into control calls; never reconstruct it, substitute the full hash, edit state, or stop solely because the representations differ. The engine owns validation of actual binding mismatches.",
    "Only the current declared transition/checkpoint tools may consume their current handoff binding. Copy fields exactly as those tool schemas require, never select an older handoff or repair a rejected binding by trying another token. `workflow_checkpoint_ask` obtains human authorization at the supported live terminal/RPC surface; `workflow_checkpoint` and `workflow_advance` consume only its current typed proof/binding. Submission receipt, worker prose, planning consent, or legacy autonomy fields cannot authorize approval.",
    "For `orchestrator`, `tool`, `bash`, or `none` stages, perform only the profile-declared action. For a profile-declared orchestrator assignment, publish its declared outputs through `workflow_submit_result`; for a consumer tool callback such as `lecture_acquire`, let the trusted callback publish its declared output. Never hand-write the workflow output or manifest. `document` stages remain engine-rendered at the declared transition boundary.",
    "The engine owns immutable publication, receipt replay/conflict handling, slot provenance, and consilium fan-in. Do not read a file and treat it as a submission, merge/unwrap/rename slot outputs, or copy a receipt into state. A readiness error after accepted results is not worker failure and does not authorize re-dispatch.",
    "Checkpoint permission comes only from the current stage contract plus an explicit typed decision. Human decisions enter only through `workflow_checkpoint_ask`; policy-auto is available only where the profile declares it. A result receipt and terminal worker event never stand in for approval.",
    "",
    "### Tool permission summary",
    "| Operation | Main-session orchestrator |",
    "| --- | --- |",
    "| read/glob/grep | ALLOW |",
    "| `workflow_submit_result` for this session's profile-declared orchestrator/tool assignment | ALLOW |",
    "| `workflow_submit_result` for a worker, foreign slot, or undeclared output | DENY |",
    "| write/edit supplemental DoD or explicitly declared coordination evidence | ALLOW only where the current profile/QA contract requires it |",
    "| single-path write to exact `xd://report_issue` or root `agent://<recipient>` | ALLOW after host/claim and SDK service authorization; no file or publication authority |",
    "| write/edit application source or declared workflow outputs | DENY |",
    "| direct write/edit canonical workflow state | DENY |",
    "| bounded selected-run Git artifact proof (`status`, `log`, `diff`, `show`, exactly `branch --show-current`; canonical sanitized prefix/env; `diff`/`show` require `--no-ext-diff --no-textconv`) | ALLOW |",
    "| branch setup/synchronization/history integration/publication | DENY |",
    "| task for a declared stage | ALLOW |",
    "| task outside the active profile/state contract | DENY |",
    "| direct implementation or review-fix | DENY |",
  ].join("\n");
}

export type { Complexity, TaskType, WorkflowName };
