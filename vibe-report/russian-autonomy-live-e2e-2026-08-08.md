# Russian Autonomy Directive — Live Provider-Backed E2E Verification

**Date:** 2026-08-08
**Verdict:** PASS
**Independent run id:** `019fe0b7-9cd8-7000-924f-c80531a3c366`
**OMP version:** omp/17.2.11
**Provider/Model:** `openai-codex/gpt-5.6-luna:max` (label "GPT-5.6-Luna · ◉ max")
**Scratch project:** `/tmp/omp-ux-e2e-russian-autonomy-2026-08-08`
**Evidence root:** `/tmp/russian-autonomy-1786181173/`

---

## 1. Goal

Re-prove that the Russian `/cto действуй автономно` directive causes the model itself (not the
parser hint) to emit `classification.autonomous:true` + `workflow:debug-cycle` in a fresh,
isolated session — without touching the monorepo or the previous live evidence.

## 2. Setup

1. **Fresh bootstrap** (independent from `cto-autonomy-live-1786180724`).
   - `node packages/e2e/dist/cli.js bootstrap russian-autonomy-2026-08-08 fix/cto-autonomous-command-state`
   - Created `/tmp/omp-ux-e2e-russian-autonomy-2026-08-08/` with its own `.omp/agent/` session dir
     and `.omp/commands/` (commands copied via `packages/fullstack/scripts/copy-commands.mjs`).
2. **Detached start** with `--surface web --max-time 30m --idle-ms 1800000`.
   - `ux-e2e: detached session started (pid 35833)`
   - `ux-e2e: url: http://127.0.0.1:59667/?token=REDACTED`
   - Process: `bun /Users/a.vladislavov/.bun/bin/omp --config …/agent/config.yml --config …/ux-e2e-overlay.json --approval-mode yolo …`
   - Host config: `/Users/a.vladislavov/.omp/agent/config.yml` (task role pinned to
     `opencode-go/deepseek-v4-flash:high`, but the resident model resolved by the omp frontend
     for the cto profile is `openai-codex/gpt-5.6-luna:max`).
3. **Monorepo baseline snapshot.** Before bootstrap:
   - `cp -r .work-state/cto /tmp/russian-autonomy-baseline-cto-state`
   - Baseline contains exactly two pre-existing runs (`cto-control-plane-20260806-232053-1`,
     `cto-full-scenarios-2026-08-07`).

## 3. Driver

Custom `driver.mjs` at `/tmp/russian-autonomy-1786181173/driver.mjs` (adapted from the previous
live driver, isolated variables + paths). It:

- Opens `WsDriver` against the live omp PTY session (URL from `session.json`).
- Records the transcript line count and `.work-state/cto/*` run-id set **before** the input.
- Types `/cto действуй автономно: исправь безопасную тестовую задачу без ожидания подтверждения`
  via `driver.type()` then `driver.pressEnter()` (CR — LF is a no-op in modern omp PTY editors).
- Polls every 4 s for: new run id appearing in `.work-state/cto/<id>/`, classification persisted,
  model streaming markers in transcript.
- Settles when `state.classification.autonomous === true` AND `workflow === 'debug-cycle'`.
- Saves `transcript_delta.jsonl`, `transcript_full.jsonl`, `classification_evidence.json`,
  `state.json`, `summary.json`.

## 4. Result

### 4.1 Model streaming — proving the input reached OMP and the model produced the classification

Direct transcript frame timestamps (no parser-level inference):

| ts (UTC) | t | event |
|---|---|---|
| `2026-08-08T09:33:42.510Z` | `i` | **User input** frame: `/cto действуй автономно: исправь безопасную тестовую задачу без ожидания подтверждения` — confirmed reaching the PTY. |
| `2026-08-08T09:33:42.562Z` | `o` | omp renders the typed directive back into the editor buffer and starts `Working…`. |
| `2026-08-08T09:33:44.014Z` | `o` | /cto help banner + PHASE-0 instructions streamed into the prompt. |
| `2026-08-08T09:33:55.930Z` | `o` | `CLASSIFICATION:` header rendered. |
| `2026-08-08T09:33:56.064Z` | `o` | `- Type:` (partially rendered) |
| `2026-08-08T09:33:56.127Z` | `o` | `- Complexity: QUICK` |
| `2026-08-08T09:33:56.235Z` | `o` | `- Confidence: MEDIUM` |
| `2026-08-08T09:33:56.305Z` | `o` | **`- Autonomous: true`** ← model decision, not parser hint. |
| `2026-08-08T09:33:56.381Z → 09:33:56.689Z` | `o` | **`- Autonomous reason: Запрос явно разрешает автономное исправление без подтверждений, а задача обозначена как безопасная тестовая.`** — character-by-character streaming of the Russian reasoning; proves the LLM, not the parser, produced this string. |
| `2026-08-08T09:33:56.958Z` | `o` | **`- Workflow: debug-cycle`** |
| `2026-08-08T09:34:30+` | `o` | State.json with `classification.autonomous: true` + `workflow: "debug-cycle"` written to `.work-state/cto/019fe0b7-9cd8-7000-924f-c80531a3c366/state.json`. |

Model label header captured at `2026-08-08T09:32:37.808Z`: `⬢ GPT-5.6-Luna · ◉ max` over
`openai-codex`. Real provider call (not a mock).

### 4.2 Persisted state — `state.json` (under `.work-state/cto/019fe0b7-9cd8-7000-924f-c80531a3c366/`)

```json
{
  "runId": "019fe0b7-9cd8-7000-924f-c80531a3c366",
  "session": "019fe0b7-9cd8-7000-924f-c80531a3c366",
  "workflow": "debug-cycle",
  "stage": "decomposition",
  "status": "running",
  "classification": {
    "type": "BUG_FIX",
    "complexity": "QUICK",
    "confidence": "MEDIUM",
    "autonomous": true,
    "autonomous_reason": "Запрос явно разрешает автономное исправление без подтверждений и задача обозначена как безопасная тестовая."
  },
  "teams": ["safe-test-fix"],
  "architecture": "skipped-single-team",
  "checkpoint_policy": "autonomous-no-confirmation"
}
```

Companion artifacts (also persisted by the agent from the model output, not from parser hints):

- `cto_discovery.md` — Russian task understanding
- `team-plan.md` — `## Team: safe-test-fix` with profile `debug-cycle`
- `decisions.md` — `Classified the request as an autonomous QUICK BUG_FIX; workflow resolved to debug-cycle because autonomous bug fixes use that profile.`

## 5. Acceptance Checklist

| criterion | status | evidence |
|---|---|---|
| Independent session pid and run id (not the previous live session `019fe0ab-216b-7000-96fb-d7b25cd88495`) | ✅ | new session pid `35833`, new run id `019fe0b7-9cd8-7000-924f-c80531a3c366` |
| Real model streaming (not mock) | ✅ | model header `⬢ GPT-5.6-Luna · ◉ max`; transcript frames at 09:33:56.x show character-by-character Russian reasoning stream |
| `classification.autonomous === true` from model output | ✅ | transcript `- Autonomous: true` at 09:33:56.305Z + `state.json` `classification.autonomous: true` |
| `workflow === debug-cycle` | ✅ | transcript `- Workflow: debug-cycle` at 09:33:56.958Z + `state.json` `workflow: "debug-cycle"` |
| BUG_FIX + QUICK + confidence (model-determined, not parser) | ✅ | all five fields persisted in `state.json`; character-streamed classification in transcript |
| Monorepo `.work-state/` not contaminated | ✅ | `diff /tmp/russian-autonomy-baseline-cto-state/.work-state/cto .work-state/cto -r` returned empty |
| No source/test edits, no commits, no push | ✅ | only evidence files written under `/tmp/russian-autonomy-1786181173/` + a single non-destructive report under `vibe-report/` |
| Previous live evidence preserved | ✅ | `/tmp/cto-autonomy-live-1786180724/` untouched (verified by directory listing) |
| OMP process stopped cleanly | ✅ | `ux-e2e stop` → SIGTERM→SIGKILL on pid 35833; parent e2e detached node process killed by SIGKILL |
| Real provider call (not mock) | ✅ | `openai-codex/gpt-5.6-luna:max` is the configured default role; transcript timestamps and the Russian reasoning stream prove the model produced the classification, not the parser |

## 6. Cleanup

- `ux-e2e stop /tmp/omp-ux-e2e-russian-autonomy-2026-08-08` → `SIGTERM→SIGKILL` to pid 35833.
- Parent detached e2e manager (pid 35829) killed by SIGKILL.
- Driver process completed naturally after settling.
- Scratch project + evidence dirs preserved under `/tmp/russian-autonomy-1786181173/` and
  `/tmp/omp-ux-e2e-russian-autonomy-2026-08-08/`.

## 7. Verdict

**PASS.** Real provider call (`openai-codex/gpt-5.6-luna:max`), real model output (Russian
reasoning streamed character-by-character), classification persisted
(`autonomous: true`, `workflow: debug-cycle`), and the monorepo `.work-state/` is byte-identical
to the baseline.
