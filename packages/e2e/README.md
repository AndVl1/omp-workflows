# @andvl1/omp-workflows-e2e

Interactive UX E2E test framework for **omp** + **omp-workflows**. An LLM agent
(or a human) acts as a UX tester: the framework spawns a real omp PTY session in
a scratch project, the tester drives a workflow like a human (types `/do-work`,
answers `[ask_user]` prompts), rates each step's UX, hunts defects, assesses the
tested agent's output, and emits a `manual_qa`-compatible report.

```
bootstrap -> start -> (drive the terminal) -> report
```

## Quick start

```bash
# 1. Build the package
npm run build -w @andvl1/omp-workflows-e2e

# 2. Bootstrap a scratch project wired to this monorepo
node packages/e2e/dist/cli.js bootstrap my-feature feat/my-feature \
  --monorepo . --workdir /tmp

# 3. Start a session (prints a localhost URL with a single-use token)
node packages/e2e/dist/cli.js start /tmp/omp-ux-e2e-my-feature \
  --scenario packages/e2e/scenarios/full-feature.json

# 4. Open the URL in a browser (web surface), or drive it over WS (text surface)
#    Ask-state helpers:
node packages/e2e/dist/cli.js ask /tmp/omp-ux-e2e-my-feature --list
node packages/e2e/dist/cli.js ask /tmp/omp-ux-e2e-my-feature "1"

# 5. Inspect the session, then emit the report
node packages/e2e/dist/cli.js transcript /tmp/omp-ux-e2e-my-feature --tail 40
node packages/e2e/dist/cli.js report /tmp/omp-ux-e2e-my-feature \
  --steps steps.json --copy-evidence
```

Root convenience script: `npm run e2e -- <subcommand> …` (builds first).

## Subcommands

| Command | Purpose |
|---|---|
| `bootstrap <slug> <branch>` | Create `<workdir>/omp-ux-e2e-<slug>` (default `/tmp`), `git init`, wire the plugin via `npm link` (NOT `file:` — the unpublished peer would fail with ETARGET), write `.omp/ux-e2e-overlay.json`, copy `.omp/team.config.json`, materialize custom-TS commands. `--force` re-creates. |
| `start <scratch-dir>` | `startTestSession()` + print the terminal URL. Foreground mode prints live `[ask_user]` hints and exits when omp exits; `--detach` runs the session in a detached child. `--scenario`, `--task`, `--surface web|text`, `--cols/--rows/--port`, `--max-time`, `--idle-ms`. `--force` allows relaunch over a live session. |
| `stop <scratch-dir>` | SIGTERM → SIGKILL the recorded process tree (see session.json `pid`). |
| `transcript <scratch-dir>` | Render transcript.jsonl as text; `--tail N`, `--follow`. |
| `ask <scratch-dir> [<answer>]` | `--list` shows the pending `[ask_user]` block; with `<answer>` it sends `<answer>\n` in ONE `{t:'i'}` frame and appends `{ts, answer}` to ask-state.jsonl. Double-answer guard refuses stale/already-answered prompts. |
| `report <scratch-dir>` | `generateReport()` → `<scratch>/.work-state/ux-e2e/report.json` + `<mdDir>/<slug>-ux-e2e-<date>.md` (default `./vibe-report`). `--steps` supplies structured ratings; `--copy-evidence` mirrors evidence files. |

## Architecture

- **`src/server.ts`** — `startTestSession()`: loopback-only HTTP+WS server,
  single-use 256-bit token (constant-time compare + replay protection), Origin
  (if present) / Host checks, `X-Frame-Options: DENY`, `Referrer-Policy:
  no-referrer`, strict CSP, per-connection rate limit, idle timer, SIGTERM →
  SIGKILL process-tree kill, 64 KiB max frame. Spawns omp with
  `--profile ux-e2e-test --config …/.omp/ux-e2e-overlay.json --session-dir …/.omp/agent
  --hide-thinking --max-time <m>m --approval-mode yolo` (never `-p/--print`,
  never `--no-pty`). Every PTY output frame is appended to
  `transcript.jsonl` — the server-side evidence backbone.
- **`src/driver.ts`** — `TerminalDriver` seam: `WsDriver` (text mode, reads the
  transcript) and `createPlaywrightDriver` (lazy optional `playwright`
  dependency). `TranscriptLog` (append-only scan, O(delta) cursor) +
  `AskStateTracker` ([ask_user] detection, double-answer guard).
- **`src/scenario.ts`** — `loadScenario()`: JSON scenario = data; validates with
  field names in errors, resolves `task: {file}`, expands `{{slug}} {{branch}}
  {{task}} {{cols}} {{rows}} {{max_time}}` plus scenario params.
- **`src/report.ts`** — `generateReport()`: ux-e2e JSON + manual_qa-compatible
  markdown. Defect floors: CRITICAL→1, HIGH→2, MEDIUM→3, LOW→4; ratings are
  clamped and warnings are emitted.
- **`src/cli.ts`** — thin `node:util parseArgs` dispatch over the six
  subcommands.

## WS protocol

Inbound (`browser → server`): `{t:'i', d}` input, `{t:'r', cols, rows}` resize.
Outbound: `{t:'s', ok:true}` auth ack · `{t:'o', d}` PTY output ·
`{t:'exit', code, signal?}` process exit · `{t:'err', code, message}` where
`code ∈ {rate-limited, idle-timeout, spawn-failed, no-pty}`.

Upgrade path: `/ws?token=<single-use-token>`.

## Report schema

`report.json` (schema_version 1):

```jsonc
{
  "type": "ux-e2e",
  "schema_version": 1,
  "verdict": "PASS" | "FAIL" | "CONDITIONAL",
  "mode": "ui",
  "regressions": ["…"],
  "session": { "slug", "scratch_dir", "omp_version", "profile", "tty", "started_at", "finished_at", "task_prompt", "scenario", "transcript", "session_jsonl", "events_jsonl", "omp_log" },
  "steps": [{ "id", "name", "order", "ratings": { "message_clarity": 1..5, … }, "defects": ["D1"], "screenshots": ["…"] }],
  "defects": [{ "id", "severity": "CRITICAL"|"HIGH"|"MEDIUM"|"LOW", "dimension", "title", "step", "evidence": ["…"] }],
  "agent_quality": { "rating": 1..5, "rationale", "dimensions": { "task_fidelity": … } },
  "overall": { "score": 1..5, "summary", "recommendation": "ship"|"fix-high"|"rework" },
  "evidence": ["transcript.jsonl", "session.json", "omp log", "screenshots"],
  "generated_at": "…"
}
```

## Agent-browser recipe (web surface)

1. `ux-e2e start <scratch> --detach` → prints the URL (session survives).
2. Open the URL in a browser (the token is in the URL; never share it).
3. Drive the terminal as a human: type `/do-work <task>`.
4. On every `[ask_user]` block, either type the answer in the terminal or run
   `ux-e2e ask <scratch> --list` / `ux-e2e ask <scratch> "<answer>"`.
5. At each stage: screenshot, rate the 6 UX dimensions, log defects to a
   `steps.json`.
6. `ux-e2e report <scratch> --steps steps.json --copy-evidence`.

## Known limitations

- `[ask_user]` detection is a regex heuristic over the transcript (numbered
  option lines after an `[ask_user]` title); calibration may be needed on the
  first real run. Answers typed *inside* the terminal (not via `ask`) are not
  recorded in ask-state.jsonl and are treated as "the transcript moved on".
- Single session at a time per scratch dir (session.json live-pid guard).
- `--detach` runs the session in a detached child; stop it with
  `ux-e2e stop <scratch>` (or let `--max-time` expire).
- The xterm stylesheet is served from `@xterm/xterm/css/xterm.css` (the package
  does not ship `lib/xterm.css`).
- Screenshots require the web surface (`playwright` installed); text mode
  `screenshot()` throws by design.
- **Single-PTY lifecycle** — the session holds ONE PTY for the whole
  run; any WS disconnect (browser reload, sleep/resume, network blip)
  kills the omp process and the session ends. The token is single-use
  so there is no reconnect. This is an explicit design decision, not a
  bug — restructuring to per-connection PTY would change the contract.
  Plan transient resilience with `--max-time` and a fresh
  `ux-e2e start <scratch>` if the run needs to span browser reloads.

## License

MIT — see the repository root LICENSE. Security/PTY patterns ported from
`@pi-harness/web-terminal` (MIT).
