# Changelog

All notable changes to `omp-workflows` are documented here.

## [0.12.1] — 2026-08-05
### Added
- **`tg-bridge` — autonomous Telegram bridge daemon** (`packages/fullstack/bin/tg-bridge.mjs` + `src/telegram-bridge.ts`) — answers the messenger even when NO omp session is alive (the case the in-session dispatcher cannot cover: CTO finished, session closed, user still writes to the bot). Owns the bot's getUpdates (one consumer per token): escalation answers -> `answers/`, plain messages -> classified: active run -> local drop (`.omp/inbox/`, the live session picks it up in <=10s, no reply); finished run with summary.json -> **replies with the run status built from the summary (no LLM)** AND files the message as a standby task; nothing -> creates a standby run, files the task, replies it was saved. Idempotent writes (wx, deterministic filenames by message id) — duplicate deliveries never double-send. Start: `node packages/fullstack/bin/tg-bridge.mjs --cwd <project>` (or hub start with persist). Replaces hand-rolled per-project pollers that only write files and never answer. **Auto-mode selection**: the bridge writes `.omp/tg-bridge.lock` (pid) on start and removes it on exit; the in-session dispatcher checks it — while the bridge is alive it owns getUpdates and the session does NOT long-poll telegram (only picks up the bridge's drop files / answer markers, waking `[CTO-INBOX]`/`[CTO-ANSWER]`), otherwise the session polls telegram itself. No double polling, one consumer per token either way.
- **CTO STANDBY mode (taskless start + messenger-driven tasks)** — `/cto` with NO task starts the CTO in standby: the agent persists a standby run (`.work-state/cto/standby-<id>/state.json`, active for amend detection / inbox routing / per-turn reminder), reads the registry, and yields. Tasks arrive two ways: `[CTO-INBOX]` user messages injected by the messenger dispatcher (idle sessions wake via `sendUserMessage`), or files in `.work-state/cto/<id>/inbox/`. The dispatcher (`startDispatcher`) now ALSO ingests inbound tasks: plain Telegram messages (non-reply, non-callback) and a local drop `<root>/.omp/inbox/*.json` — both are filed under the active (or a new standby) run and wake the CTO session. This fixes a latent gap: the Telegram long-poll loop (`pollOnce`) was never wired into the dispatcher, so answers were not being received in production. User-initiated messages are now fully reactive: reply/button answers fire a `[CTO-ANSWER]` wake (`onAnswer`) so the agent applies them without waiting for the next checkpoint poll, plain messages become tasks (`[CTO-INBOX]` wake), and the `/cto` prompts (new + amend) tell the CTO to check `inbox/` for tasks that arrived while no session was listening. Live-verified end-to-end on omp 17.2.8 (interactive PTY): `/cto` -> standby persisted -> yield -> task dropped -> `[CTO-INBOX]` wake -> agent folds the task in (amend discipline).
- **Messenger-routed user communication** — when a bidirectional channel is configured (`.omp/escalation.json`, `adapter: telegram`), ALL user communication in a CTO run goes through the messenger: checkpoints and questions become outbox escalations (answers in `answers/<escId>.json`), and the interactive `ask` tool is BLOCKED by a `tool_call` gate (scoped to active CTO runs; outside a run, `ask` works normally). The `/cto` prompt (core + fullstack copies) and the `cto`/`team-lead` agents render the channel status and state the rule; push-only (`http`) and no-channel cases keep `ask`.
- **CTO-mode delegation reminder (per-turn)** — a `context` hook (fires before EVERY LLM call in the session and in subagents) injects a short steering message restating the delegation contract while a CTO run is active (`.work-state/cto/`, detected via core `findActiveCtoRun`): orchestrator delegates to teams, leads spawn workers, workers escalate up. Keeps the discipline in front of the model on every turn of long autonomous runs — including turns after compaction — instead of relying on the /cto prompt drifting in context. Zero overhead when no run is active (cached 10s detection). Mechanism verified live on omp 17.2.8 (context-hook contract is `{ messages }`; steering user messages are wrapped per turn by the harness and are ephemeral, so each turn re-injects). Activation: ships in the fullstack bundle — takes effect after plugin republish/install.
### Fixed
- **Subagent dispatch reliability protocol (lead exit-1 failover)** — live evidence (pr-watch CTO run + /tmp/cto-dispatch-exp probe matrix, omp 17.2.8): subagents below the main agent resolve to `modelRoles.task`; when that role is `minimax-code/MiniMax-M3`, they intermittently die with exit 1 — stalling at a nested `task` call (empty turns → killed after 3 idle reminders), yielding null/empty data, or hallucinating garbage tool calls mid-work. Nested dispatch is NOT the defect: a directly-dispatched worker failed identically on the same model; `opencode-go/deepseek-v4-flash` as task role showed 0 failures across 17+ live probe runs. The `/cto` prompt contract (core + fullstack copies), `cto` agent, and `team-lead` agent now carry: verify-disk-first + re-spawn-with-same-spec failover for exit-1 leads, degrade-to-direct-dispatch on a second failure, single-worker slices skip the lead hop, and dispatch hygiene (spawn early before context grows, lean specs with findings on disk, one worker per `task` call). Host-level fix applied separately: `modelRoles.task` → deepseek-v4-flash (see vibe-report).
### Verified
- 280 unit tests green (core 98, fullstack 92, e2e 100 — was 253), typecheck + build clean. Live probe matrix in `/tmp/cto-dispatch-exp` (simple + heavy nested chains, MiniMax vs deepseek task role, direct vs nested dispatch); context-hook delivery probes in `/tmp/hook-probe`; standby/inbox/wake live flow in `/tmp/cto-standby-live`.

## [0.12.0] — 2026-08-04
### Added
- **Amend protocol (mid-run task injection, br-k19)** — `/cto` is now context-aware: when a CTO run is active (pause not done/failed), a second `/cto <task>` returns the **AMEND contract** — the new task is folded into the SAME run by the SAME orchestrator (single CTO, no sub-CTO, no second orchestrator), new leads spawn in parallel with active teams, integration and DoD aggregation cover ALL teams (original + added). Edge cases: run at max teams → queue (`.work-state/queue.json`), run in the integration phase → queue, scope overlap → extend the existing team's slice (re-spawn its lead) instead of adding a team. `CtoState` gains `amended_at` (`markAmended`); `findActiveCtoRun` + `buildAmendPrompt` exported from core.
- **Cross-team architecture stage (br-vk8)** — `cto.json` gains an `architecture` stage (single, `architect` role) between decomposition and teams: for multi-team runs the architect produces the cross-team contract (api_contract, file ownership, shared interfaces, ports/CORS) BEFORE leads spawn; teams consume it. Single-team runs skip the stage (contract lives in the plan). The `/cto` prompt contract and `cto` agent state the rule.
- **Full sub-profile resolution for teams** — team sub-profiles use the same resolution as `/do-work` (`resolveWorkflow`): FEATURE/REFACTOR QUICK → lightweight, MEDIUM → standard, COMPLEX/CRITICAL → **full-feature**; BUG_FIX → **debug-cycle** (bug-fix only for interactive QUICK); OPS/INVESTIGATION mapped. Bug-fix slices run through the team: the lead walks debug-cycle (diagnose → root cause → fix → verify; root_cause gate before code).
### Fixed
- **Amend detection for agent-written runs (br-5ql)** — `findActiveCtoRun` only scanned `state.json`, but the CTO agent writes markdown state (team-plan.md, decisions.md, cto_discovery.md) and never calls the TS engine. Added a markdown fallback: a run is active when it has any of those state files and no finish marker (summary.md/json, integration_review.md/json); broadened to `cto_discovery.md` so the amend window opens at the first checkpoint. `state.json` (schema:1) still wins when present. Live-verified: a second `/cto` while a run was parked at `confirm_understanding` returned `cto: amending run` + `/cto AMEND`.
- **`cto/*/state.json` in a doc comment closed the block comment early** (premature `*/`), breaking parsing of `commands/cto.ts` — reworded.
### Verified
- 253 unit tests green (core 95 incl. amend markdown-fallback + routing, fullstack 72, e2e 86), typecheck + build clean. Live e2e (0.11.x code + repo profiles): architecture stage ran before leads (ArchitectPing → contract), leads delegated to workers, single-team skip of architecture respected, agent improvised amendment (Plan B parallel). Evidence: `vibe-report/` + `/tmp/cto-live`.

## [0.11.2] — 2026-08-04
### Fixed
- **Single orchestrator rule (from mid-run live test)**: the `/cto` prompt contract and the `cto` agent now state explicitly that the recipient IS the CTO and must execute the contract in-session; delegating the orchestrator role to a sub-agent (sub-CTO) is forbidden. Rationale (live evidence, br-k19): a delegated CTO eats a nesting level and the lead at depth 3 loses `task`/`hub` (mid-run run: lead was bash-only, could not delegate, D9 collapse). Depth contract fixed: main(CTO) → lead → worker, max 3 levels.
### Added
- **`custom-escalation-adapter` skill** (shipped in both `@andvl1/omp-workflows-core` and `@andvl1/omp-workflows-fullstack`): per-project guide for implementing your own CTO escalation channel — `EscalationAdapter` interface (core), outbox → send → answers lifecycle, `.omp/escalation.json` registration, references (HTTP/Telegram), tests.
- **`docs/adding-escalation-adapter.md`**: full consumer guide for custom escalation channels (interface contract, lifecycle, per-project wiring, rules: R4 sanitization, file-only answers, blocker → park). Cross-linked from `docs/adding-agents.md`.

## [0.11.1] — 2026-08-04
### Fixed
- **Lead discipline (live E2E finding)**: `team-lead` agents could write source code — in the 2026-08-04 multi-feature run one of three leads (CliLead) implemented its slice itself (10 `write` calls, zero worker spawns) because the prompt only banned `edit` while `write` was in the toolset. Now: zero-tolerance rule — leads never `write`/`edit` outside `.work-state/` (only state: `decisions.md`, `dod.json`), delegation is mandatory for ALL slices (no trivial-slice exception), a zero-worker lead is a failed lead. The `/cto` prompt contract and the `cto` agent verify each lead's transcript after it returns (any `write`/`edit` on a non-`.work-state/` path = delegation violation, logged in `decisions.md`). Evidence: `vibe-report/cto-suborchestration-e2e-2026-08-04.md`.

## [0.11.0] — 2026-08-04
### Added
- **CTO sub-orchestration (CTO/Head mode)** — 3-level orchestration (CTO → team leads → workers): the CTO agent decomposes a task into a `TeamPlan` (up to 8 teams, decomposition depth 2), spawns one lead per team, coordinates teams over `hub`, and integrates results. Design + interview decisions: `vibe-report/sub-orchestration-2026-08-04.md`.
- **`/cto` command** (custom-TS, self-contained copy in `packages/fullstack/commands/cto/`, canonical implementation in core `packages/core/src/commands/cto.ts`): parses `[AUTONOMOUS] <task> [issue=#N]`, renders the team registry from `.omp/teams.json` and returns a full CTO prompt contract (decomposition discipline, escalation ladder, worktree strategy, integration rules). Consumers wire the exported core functions (`parseCtoEnvelope`/`buildCtoPrompt`/`ctoCommand`) into their own commands.
- **CTO engine in `@andvl1/omp-workflows-core`** (pure, no domain): `cto/{types,plan,state,gates,run,escalation}.ts` — `TeamDef`/`TeamPlan`/`CtoState` models, `buildTeamPlan` validation (caps, unknown teams, depends_on cycles), `validateDecompositionDepth`, `runCto` (persist state under `.work-state/cto/<id>/`), state transitions (team status, escalation records, expiry), DoD aggregation + `ctoBackstop`, answer-file queue (`answers/<esc-id>.json`), `EscalationAdapter` interface (consumer-implemented), R4 sanitization (`sanitizeEscalation` — strips secret lines before any adapter send).
- **Escalation adapters in fullstack**: `http.ts` (reference, send-only), `telegram.ts` (reference, send + long-polling → answer files), `registry.ts` outbox dispatcher — agents write escalation requests to `.work-state/cto/<id>/outbox/`, the dispatcher (wired to `session_start`, configured via `.omp/escalation.json`) sanitizes, sends with retry/backoff (3), and moves delivered files to `sent/`. Escalation ladder: worker → lead → CTO (decides with documented `why`) → user; `blocker` waits without timeout while other teams continue.
- **`cto.json` workflow profile** (explicit-only: `match.type` is `[]`, never auto-selected by classification): discovery → decomposition → teams (`type: team`, filled from `.omp/teams.json`) → integration review → summary. `teams.example.json` — TeamDef registry example for consumers.
- **New agents**: `cto.md` (orchestrator: `task`+`hub`, no `edit` — never codes) and `team-lead.md` (owns one team's slice, decomposes into worker tasks, filters escalations). `coordinator.md` reworked to native omp tools (`hub` peer communication, CTO as executor brother, `/cto` in the pulse menu); `coordinator-yolo.md` may run `/cto` for large multi-scope tasks.
- **Stage taxonomy**: new `type: team` stage (teams[], profile, integration{stage,on_failure}) in `_schema.json` + `StageDef`; `WorkflowName` extended with `cto`; CTO artifact schemas (`cto_discovery`, `team_plan`, `team_artifacts`, `integration_review`) in `artifacts-schema.json`.
### Fixed
- **`packages/e2e` test mock drift**: `cli.test.ts` fake driver lacked `pressEnter` after the Enter-semantics fix (bcc5f26) — the input test now asserts text + Enter keypress against the updated `runInput` contract.
### Verified
- 242 unit tests green (core 87 incl. CTO types/engine/command, fullstack 72 incl. cto-command + adapters, e2e 83), typecheck + build clean. Live `/cto` smoke on omp 17.2.6 (DeepSeek V4 Flash): command → contract → TeamPlan (2 teams, separate worktrees) → documented decisions; evidence in `vibe-report/cto-suborchestration-e2e-scenario.md`.

## [0.10.1] — 2026-08-03
### Fixed
- **`/do-work` now resolves and names the workflow profile's absolute path** (`packages/fullstack/commands/do-work/index.ts`, `buildPrompt`, new `_lib/profile.ts`). The prompt previously told the main agent to read `packages/core/workflows/<name>.json` — a relative path that only resolves from the monorepo root. From a git worktree, a subdirectory, or a consumer project the file was missing, so the agent compensated with filesystem-wide exploration on every dispatch: globbing `**/workflows/**` (200+ files), reading the command's own sources, `find /` across the whole disk (~145 s), scanning `~/.omp/plugins` and `node_modules` caches. `buildPrompt` now resolves the profile at prompt-build time (cwd → walk-up to 4 levels → `node_modules/@andvl1/omp-workflows-core` → `~/.omp/plugins` install), hands the agent the **absolute, existence-checked** path, and inlines a stage skeleton carrying the behavioural stop-signs (gate, checkpoint + auto-decision, skip_if; ~300 tokens for full-feature) so the orchestrator cannot fly past a checkpoint or gate without opening the profile. A hard file-access rule bans globs/`find`/command-source reads/cache scanning unless the named path is genuinely missing. Artifact wiring (produces/consumes) is read from the one named file.

## [0.10.0] — 2026-08-03
### Added
- **Per-agent-class OMP model roles with standard-role fallback**. 17 agents in `packages/fullstack/agents/*.md` now declare `model: ["@<class-role>", "@<standard-role>"]` across 14 custom class roles (architect, reviewer, security, coordinator, researcher, analyst, developer-go, developer-kotlin, frontend-developer, developer-mobile, devops, diagnostics, qa, manual-qa). First resolvable pattern wins (`resolveConfiguredRolePattern` / `resolveModelRoleValue`); an unknown `@role` falls back to the next pattern, so standard OMP roles (`@task`, `@slow`, `@smol`) keep working when a class role is not configured. Configure via `modelRoles` in project `.omp/config.yml` or global `~/.omp/agent/config.yml`.
- **`/omp-model-roles` command** (custom-TS): `validate` renders the class-role/frontmatter table against the live model inventory, flags built-in collisions and frontmatter drift; `recommendations` returns a strict research contract (ResearchRequest JSON, immutable inventory snapshot, `outputSchema` with schemaMode=strict) that delegates fresh benchmark research to the `tech-researcher` subagent. The return value is wrapped in a marker envelope; an extension `before_agent_start` hook injects an agent-attributed developer instruction so the main LLM treats the four hard steps as developer-priority (fixes the live-runs where the main agent ignored the user-attributed prompt).
- **`web_search` MUST for fresh-facts research in `tech-researcher`**. The agent prompt now classifies requests into three modes: codebase (no web), fresh-facts (benchmarks/versions/dates — `web_search` mandatory with degraded-notice fallback to Context7/DeepWiki/official docs), and documentation (MCP-first, web optional). `web_search` works out of the box via free providers (duckduckgo, ecosia, google-scrape) and gains reliable quality with a paid provider (`omp /login google-gemini-cli` or `GEMINI_API_KEY`, Exa, Brave, Tavily, Perplexity).
- **`/omp-model-roles validate` diagnostics**: header reports `web_search=enabled|disabled|unknown`; WARN/INFO lines explain what a custom-command context can observe.
- **Model-role taxonomy moved into `@andvl1/omp-workflows-core`** as a build-time export: `defaultFullstackModelRoles` (the 14 class roles), types (`ModelRoleEntry`, `InventoryModel`, `ResearchRequest`, `ResearchResponse`, …) and pure helpers (`resolveRoleChain`, `isResearchRequest`, `isResearchResponse`). Custom bundles (Rust/Go/mobile) can now ship their own `ModelRoleEntry[]` taxonomy on top of core and reuse the same helpers — see `docs/adding-agents.md` and the `custom-agent-bundle` skill.
- **`custom-agent-bundle` skill** shipped in both `@andvl1/omp-workflows-core` (installable via `omp plugin install @andvl1/omp-workflows-core`, carries an `omp: {}` manifest) and `@andvl1/omp-workflows-fullstack` — the agent-side guide for building a custom dev bundle.
- **`docs/adding-agents.md`**: complete how-to for adding your own agents on top of core (agent discovery precedence, frontmatter reference, model-role taxonomy, `registerTeamWorkflow` roles/scopeMap/flags, custom slash commands vs extension hooks, minimal bundle skeleton).
### Changed
- `@andvl1/omp-workflows-core`: `defaultFullstackModelRoles` exported; `ROLE_COUNT` in fullstack's `before_agent_start` handler now derives from the core taxonomy instead of a hardcoded 14 (resolves the TS6059 cross-directory import).
- `@andvl1/omp-workflows-fullstack`: `buildResearchRequestDeveloperInstruction(roleCount, availableModelCount)` parameterized for bundle reuse.
### Fixed
- e2e report test filename assertion made date-agnostic (pre-existing flake that failed when the UTC date rolled over).
### Notes
- Versions: core 0.8.1 → 0.10.0, fullstack 0.9.0 → 0.10.0 (both minor bumps for the new public API surface). Test suite: 202/202 (core 61, fullstack 69, e2e 72).

## [0.8.1] — 2026-08-01
### Fixed
- **`/do-work` prompt now points at the workflow profile JSON** (`packages/fullstack/commands/do-work/index.ts`, `buildPrompt`). The Classification block previously named the resolved workflow (e.g. `lightweight`, `full-feature`) but not where its profile lived, so the main agent spent a search pass on every dispatch to locate the stage list, gates, checkpoints, and produces/consumes. Added a single line: `Workflow profile: packages/core/workflows/<workflow>.json` with a hint to read it for the stage list. No behaviour change for `/do-work` consumers other than removing the search round-trip. Test count unchanged: 49 in core, 11 in fullstack. All pass with `npm test`.

## [0.8.0] — 2026-08-01
### Added
- **Validation gate (P6)** in `@andvl1/omp-workflows-core`. Stages that produce a code-bearing artifact (`implementation`, `review_fixes`) are now inspected by the engine after the subagent returns. The handoff is blocked unless the artifact contains `ready: true`, `validation_run: "true"`, and non-empty `validation_evidence` with verbatim build/test output. A subagent that returns `ready: true, validation_run: "false"` (or any other escape hatch) is **rejected** with a precise reason; the stage is marked `failed` and the orchestrator must re-spawn the developer rather than patch the artifact by hand. See `gates/validation.ts` for the full contract and `test/validation-gate.test.ts` for the 16 test cases.
- **Subagent validation contract** documented in the `/do-work` command prompt and in every developer agent frontmatter (`developer-go`, `developer-kotlin`, `developer-mobile`, `frontend-developer`). The contract is a *machine-checked* contract: the engine, not the agent, decides whether validation was actually run. Phrases like "orchestrator owns validation" and `validation_run: "false"` are explicitly listed as not-existing in the engine.
- **Orchestrator discipline** documented in the `/do-work` command prompt and in `buildStagePrompt` (`packages/core/src/engine/stage.ts`). The orchestrator is a dispatcher, not a coder: it does not edit source, does not second-guess build/test output by re-running it, and on gate failure re-spawns the same agent with the gate's reason as the new task. The reason is in the stage outcome's `note` field — copied verbatim into the re-spawn prompt.

### Changed
- `runSingle` and `runConsilium` in `packages/core/src/engine/stage.ts` now run the validation gate after the subagent returns. The gate is keyed on the stage's `produces` list (so custom profiles that re-use the `implementation` id for a non-code stage are unaffected).
- `buildStagePrompt` injects a role-specific role-hint block: orchestrator roles (`coordinator`, `coordinator-yolo`, `discovery`) get a "DISPATCHER, not coder" hint; everything else gets an "EXECUTOR — validation evidence required" hint with explicit "no `validation_run: false` escape hatch" wording.

### Migration
- No code-level migration needed. Custom profiles that re-use the `implementation` or `review_fixes` produce keys for non-code stages will be inspected by the gate; either rename the produces key or include the validation fields. Test count: 49 in core (was 33), 11 in fullstack. All pass with `npm test`.

## [0.7.0] — 2026-08-01
### Added
- **Runtime observability layer** in `@andvl1/omp-workflows-core`. When the engine wires up via `registerTeamWorkflow`, it now subscribes to seven OMP extension events (`before_agent_start`, `agent_start`, `agent_end`, `tool_call`, `tool_result`, `session_start`, `session_stop`) and writes a per-feature append-only event log to `.work-state/features/<slug>/observability/events.jsonl`. A rollup (agent invocations, per-tool counts, per-subagent counts, per-skill counts, error counts, wall-clock duration) is computed from the log and embedded in `TeamState.observability` on every `writeState`. The rollup is mirrored in `team-state.md` under a new `## Observability` section so `/pulse` and any other consumer can read the cheap summary without touching the jsonl.
- **Skill discovery** via `extractSkills(systemPrompt)` — scans `before_agent_start` payloads for `skill://<name>` URIs and dedupes. The same hook bus detects subagent spawns by inspecting the `task` tool input (single or batch form), so the rollup attributes a subagent invocation to the right agent without parsing the OMP session jsonl.
- **`EventRecorder`** class with append-only `append()`, sync `readAll()` / `buildPointer()`, async `flush()` for tests, and a thread-safe per-cwd cache. **`rollupFromEvents`** is a pure function exported for callers that want to re-aggregate without going through the recorder.
- **Test helper `flushRecorder(cwd)`** for deterministic test assertions on the in-memory write queue — no real timers, no race conditions.
- **New public API surface** in `@andvl1/omp-workflows-core`: `EventRecorder`, `rollupFromEvents`, `readObservabilityPointer`, `extractSkills`, plus the `ObservabilityEvent` / `ObservabilityPointer` / `ObservabilityRollup` / `EventKind` types.
- **`RegisterOptions.observability?: boolean`** to opt out of telemetry. Default: `true` (always on).
- **12 new tests** under `packages/core/test/observability/`: 7 recorder unit tests, 6 skill scraper tests, 5 hook integration tests. Test count: 33 in core (was 15). All pass with `npm test`.
### Changed
- `writeState` now re-reads the event log synchronously to embed the pointer in `TeamState.observability`. This is best-effort: pre-observability features and any missing event log yield an absent `observability` field (no error, no migration needed).
- `writeStateMd` now appends a `## Observability` section when a pointer is present.
### Non-goals (deferred to a separate PR)
- Pre-implementation `checkpoint: "approve_plan_and_dod"` between `discovery` and `implementation` — the current `lightweight` profile pauses only **after** a stage, not before. This is a separate architectural change; the observability rollup it produces (which skills were active during the planning turn, how long the user took to approve) would be the right place to surface that, but adding the checkpoint itself is out of scope here.

## [0.6.0] — 2026-08-01
</input>
### Added
- **`session_start` extension hook** in `@andvl1/omp-workflows-fullstack`. The extension now listens for `session_start` and calls `ensureCommandsForSession(projectRoot)`, copying any missing shipped commands into `<project>/.omp/commands/` on the fly without overwriting user-modified files. This covers the `omp plugin install` path where npm's `postinstall` does not fire (the package lives in `~/.omp/plugins/`, outside the project's `node_modules`). Together with the existing `postinstall`, slash command bootstrap now works for both `npm install` and `omp plugin install` — first OMP session in each project materialises `/do-work` and the rest automatically.
- **`packages/fullstack/src/copy-commands.ts`** — shared helper module exporting `copyCommandsForInstall` (force-copy, used by the `postinstall` script and the CLI) and `ensureCommandsForSession` (skip-existing, used by the `session_start` hook). Both tested via a new `packages/fullstack/test/copy-commands.test.ts`.
- **New unit tests**: 5 fresh fullstack tests covering shipped-dir resolution, fresh-project population, idempotency, user-edit preservation, and the install-time force-copy path. Test count: 11 in fullstack (was 6).

### Changed
- README has a new *Slash command bootstrap — works for both install paths* subsection and a trimmed *Bootstrap custom-TS commands* subsection reflecting that bootstrap is now automatic; the `npx omp-workflows-copy-commands` script remains available for explicit re-sync from source.

## [0.5.0] — 2026-08-01
### Added
- **`/do-work` command** alongside `/team` (alias). `/team` is now a thin alias for backwards compatibility; new code should use `/do-work`. Both commands share one implementation — `commands/team/index.ts` delegates to `commands/do-work/index.ts`.
- **`postinstall` hook** in `@andvl1/omp-workflows-fullstack`: copies slash commands into the consuming project's `.omp/commands/` automatically after `npm install`. Manual `npm run copy-commands` is no longer required.
- **`fullstack: parseEnvelope falls back to branch=null outside a git work tree`** unit test (mkdtempSync under `os.tmpdir()`). New fullstack coverage: 6/6 tests including alias delegation and the no-git fallback.
- **Fix CI verification** on `fullstack` — added the missing `"test"` npm script so `npm test` resolves from the workspace root.

### Changed
- **Graceful fallback when not inside a git work tree**: the workflow prompt renders `Branch: (no git work tree)` instead of erroring out, so `/do-work` works in fresh sandboxes and unrelated projects.
- Help copy in `pulse`, `team-next`, `team-yolo`, `interview`, `coordinator-stats` points at `/do-work`; `/team` is mentioned as an alias.
## Unreleased [legacy] — initial release notes
- **OMP custom-TS slash commands** shipped from the fullstack bundle:
  `/team`, `/pulse`, `/team-next`, `/team-yolo`, `/init-team`, `/interview`,
  `/coordinator-stats`. Each lives in `packages/fullstack/commands/<name>/index.ts`
  and is loaded by OMP from `.omp/commands/<name>/index.ts` after install.
- `copy-commands.mjs` (also exposed as the `omp-workflows-copy-commands`
  binary) — copies the bundled commands into `.omp/commands/` of the
  consuming project. Run once after install.
- `createTaskCaller(tool: TaskToolLike)` exported from
  `@andvl1/omp-workflows-core` — wraps the real OMP `TaskTool`
  (`@oh-my-pi/pi-coding-agent/task`) and exposes the `call`/`batch` API
  the engine consumes. Tests cover the wire contract.
- Test suite: 15 core + 5 fullstack tests (was 11); new coverage for
  `createTaskCaller` and the `/team` command envelope.

### Changed

- **Breaking**: `registerTeamWorkflow(pi, opts)` no longer calls
  `pi.registerCommand` for any of the 7 slash commands. The extension
  side only registers gates (`before_agent_start`, `session_stop`,
  `tool_call`) and writes runtime config. Slash commands ship as OMP
  custom-TS commands.
- `TaskCaller` interface now mirrors the real OMP `TaskTool` wire shape:
  `call({ agent, task, name?, effort? })` and `batch({ context, tasks[] })`.
  Old in-house `TaskCaller` shape is gone.
- `CORE_ENGINE_MARKER` exported for downstream bundles to detect that
  the engine was wired in.
- `tasks` enumerated in `packages/fullstack/package.json#files` so the
  commands and `copy-commands.mjs` script are published to npm.

### Migration notes

- Run `npm run --prefix node_modules/@andvl1/omp-workflows-fullstack copy-commands`
  (or `npx omp-workflows-copy-commands`) after install to bootstrap the
  slash commands into `.omp/commands/`. Without this step, the extension
  still wires gates, but the slash commands are missing.
- `commands:` option on `registerTeamWorkflow` is preserved for backward
  compatibility but is now a no-op (the extension doesn't register
  commands anyway). Remove it from your bundle config.

## [0.3.1] - 2026-08-01
## [0.3.0] - 2026-08-01

### Added

- Workspace monorepo with two npm packages:
  - `@omp-workflows/core` — engine, gates, slash commands, profiles, artifact schemas.
  - `@omp-workflows/fullstack` — default bundle: 17 agents + 31 skills, pulls core as peer.
- Public API: `registerTeamWorkflow(pi, opts)` for bundles to wire the engine.
- Built-in role/scope/flag presets exported as `defaultFullstackRoles`, `defaultFullstackScopeMap`, `defaultFullstackFlags`.
- Slash commands: `/team`, `/pulse`, `/init-team`, `/team-next`, `/team-yolo`, `/interview`, `/coordinator-stats`. Subset-selectable via `commands:` option.
- Gates as event handlers: `before_agent_start` (classification + monotonic), `session_stop` (DoD backstop), `tool_call` (safety).
- 8 declarative JSON profiles (`full-feature`, `standard`, `lightweight`, `debug-cycle`, `bug-fix`, `emergency`, `research`, `review`) and typed artifact schemas.
- 17 agents and 31 domain skills in the fullstack bundle.
- Smoke tests for the package split and OMP-native role dispatch.
- Pull-request CI for reproducible install, build, typecheck, and tests.

### Changed

- Replaced the single-package layout with a workspace split. The legacy `commands/team.md` (830-line prose interpreter) is now TypeScript in `core/src/`. The bash hooks (`validate-state.sh`, `dod-gate.sh`, `safety-guard.sh`) are now event handlers in `core/src/gates/`.
- `DoD artifact shape` extended: `dod.items.length === 0` now blocks done-claim (previously passed).
- Migrated subagent selection to OMP-native roles: workflows now resolve only role → agent, while agent frontmatter selects `@smol` / `@task` / `@slow` and native reasoning levels.
- Removed the workflow-level `models` map and Claude-specific `haiku` / `sonnet` / `opus` routing; concrete model assignment now belongs to OMP `modelRoles` or `task.agentModelOverrides`.

### Migration notes

- Custom bundles: write `your-package/src/index.ts` with `registerTeamWorkflow(pi, { roles: ..., ... })`. See `packages/core/README.md` for the public API.
- Profile data is unchanged from `claude-plugin` v3.0.x — same JSON files, same `.work-state/` layout.
- Engine boot: `npm install` at the workspace root resolves both packages and creates symlinks under `node_modules/@omp-workflows/`.
