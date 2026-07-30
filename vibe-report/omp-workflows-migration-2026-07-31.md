# omp-workflows migration

**Date:** 2026-07-31
**Source:** `claude-plugin` (Claude Code plugin, fullstack-team, v3.0.1)
**Target:** `omp-workflows` (new repo, omp marketplace plugin)

## Surface mapping

| claude-plugin (Claude Code)                         | omp-workflows (omp native)                                |
|-----------------------------------------------------|-----------------------------------------------------------|
| `commands/team.md` (830-line prose interpreter)    | `src/commands/team.ts` + `src/engine/run.ts` + `src/engine/stage.ts` |
| `hooks/validate-state.sh` (PreToolUse Task)         | `src/gates/classification.ts` + `src/gates/monotonic.ts` (`before_agent_start`) |
| `hooks/dod-gate.sh` (Stop)                          | `src/gates/dod-backstop.ts` (`session_stop`)              |
| `hooks/safety-guard.sh` (PreToolUse)                | `src/gates/safety.ts` (`tool_call`)                       |
| `hooks/team-nudge.sh` (SessionStart)                | removed — omp's own ready-up flow replaces it             |
| `agents/<name>.md` (Claude Code agent frontmatter)  | `agents/<name>.md` (omp Task agent frontmatter)           |
| `skills/<name>/SKILL.md`                            | `skills/<name>/SKILL.md` (identical discovery)            |
| `workflows/*.json` (data)                           | `workflows/*.json` (verbatim)                            |
| `workflows/_schema.json` (data)                     | `workflows/_schema.json` (verbatim)                      |
| `workflows/artifacts-schema.json` (data)            | `workflows/artifacts-schema.json` (verbatim)             |
| `workflows/team.config.example.json`                | `workflows/team.config.example.json` (verbatim)          |
| `workflows/team.config.schema.json`                 | `workflows/team.config.schema.json` (verbatim)          |
| `workflows/stages/*.md` (loaded on demand)          | `workflows/stages/*.md` (verbatim)                      |
| `.work-state/team-state.json` (file)                | Same                                                     |
| `.work-state/artifacts/*.json` (file)               | Same                                                     |

## What stays 1:1

- All 8 workflow JSON profiles (`full-feature`, `standard`, `lightweight`, `debug-cycle`, `bug-fix`, `emergency`, `research`, `review`).
- All 17 agents (15 dev + 2 coordinator).
- All 32 domain skills.
- Type/Complexity/Workflow resolution table.
- Definition-of-Done typed artifact (`dod.json`).
- State schema, branch detection, per-feature subdir layout.
- Monotonic progress rule (P4).
- Classification gate (P5).
- DoD gate (with the same exceptions: research/review/emergency workflows, intentional pauses, override marker).

## What changed

### Bare `commands/team.md` interpreter → TypeScript engine

The original `commands/team.md` was a 830-line prose document that asked the model to
interpret a workflow. The port turns the workflow into **code** — `src/engine/run.ts`
classifies, resolves the profile, walks the stages, and writes state. The model is no
longer the interpreter; it's the executor.

### Bash hooks → event handlers

| Hook                        | Event                    | Handler                |
|-----------------------------|--------------------------|------------------------|
| `validate-state.sh` (P5)    | `before_agent_start`     | `gates/classification.ts` |
| `validate-state.sh` (P4)    | `before_agent_start`     | `gates/monotonic.ts`     |
| `dod-gate.sh`               | `session_stop`           | `gates/dod-backstop.ts`  |
| `safety-guard.sh`           | `tool_call`              | `gates/safety.ts`        |
| `team-nudge.sh` (SessionStart) | n/a                   | removed                 |
| `profile-usage.sh` (PostToolUse) | n/a                 | replaced by telemetry in `run.ts` |

### omp-specific extensions

- Native `task` tool: `gates/stage.ts` exposes `TaskCaller.batch` for parallel consilium
  runs, escaping the bash hook's "one Task at a time" constraint.
- `ExtensionAPI` events replace Claude Code hooks 1:1 with stronger contracts
  (`before_agent_start` returns typed gate results; `session_stop` returns `{ decision, reason }`).
- Marketplace plugin packaging: `omp.Workflows` is installed via `omp plugin install` and
  composed with other plugins (e.g. `rust-agents` for a Rust project).

## What's still open

- The `task` tool inside `gates/stage.ts` is a placeholder `TaskCaller` interface —
  the engine depends on the host session's actual `task` tool. The wiring is done
  by the orchestrator's `c.callTask` (the host session implements `TaskCaller`).
- `init-mobile` slash command is a koog/JS scaffold in the original; in omp it's
  pulled out of the engine (only the `init-team` config emitter lives here).
- Press-open issues/queue sync: `/queue-sync` and `/queue-analyze` are not ported
  yet — they read GitHub issues and depend on the project's specific `gh` workflow.

## Goal achieved

The plugin is omp-native. No Claude Code hooks, no bash scripts, no `commands/*.md`
prose interpreters. The interpretive behavior is in `src/engine/`, the gates are
real event handlers, the workflow data is the same JSON files, and the agents /
skills / artifacts live in the same shape omp discovery expects.
