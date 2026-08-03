# Changelog

All notable changes to `omp-workflows` are documented here.

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
