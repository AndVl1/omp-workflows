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

# 3. Start a session (prints a localhost URL with a session-scoped token)
node packages/e2e/dist/cli.js start /tmp/omp-ux-e2e-my-feature \
  --scenario packages/e2e/scenarios/full-feature.json

# 4. Open the URL in a browser (web surface), or drive it over WS (text surface)
#    Ask-state helpers:
node packages/e2e/dist/cli.js ask /tmp/omp-ux-e2e-my-feature --list
node packages/e2e/dist/cli.js ask /tmp/omp-ux-e2e-my-feature "1"
#    Arbitrary command input (Enter is appended as `\n`):
node packages/e2e/dist/cli.js input /tmp/omp-ux-e2e-my-feature "/do-work implement it"

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
| `start <scratch-dir>` | `startTestSession()` + print the terminal URL. Foreground mode prints live `[ask_user]` hints and exits when omp exits; `--detach` runs the session in a detached child whose stdout/stderr are appended to `<scratch>/.work-state/ux-e2e/detach.log` (the parent tails the last 8 KiB on the 15 s startup timeout so failures are not swallowed). `--scenario`, `--task`, `--surface web|text`, `--cols/--rows/--port`, `--max-time`, `--idle-ms`. `--force` allows relaunch over a live session. |
| `stop <scratch-dir>` | SIGTERM → SIGKILL the recorded process tree (see session.json `pid`). |
| `transcript <scratch-dir>` | Render transcript.jsonl as text; `--tail N`, `--follow`. |
| `ask <scratch-dir> [<answer>]` | `--list` shows the pending `[ask_user]` block; with `<answer>` it sends `<answer>\n` in ONE `{t:'i'}` frame and appends `{ts, answer}` to ask-state.jsonl. Double-answer guard refuses stale/already-answered prompts. |
| `input <scratch-dir> <text>` | Unconditionally sends `<text>\n` in ONE `{t:'i'}` frame, without requiring a pending `[ask_user]` prompt. In the omp TUI, Enter is `\n`; do not use `\r`, which is inserted literally. |
| `report <scratch-dir>` | `generateReport()` → `<scratch>/.work-state/ux-e2e/report.json` + `<mdDir>/<slug>-ux-e2e-<date>.md` (default `./vibe-report`). `--steps` supplies structured ratings; `--copy-evidence` mirrors evidence files. |

## Architecture

- **`src/server.ts`** — `startTestSession()`: loopback-only HTTP+WS server,
  session-scoped 256-bit token (constant-time compare), Origin (if present) /
  Host checks, `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer`, strict
  CSP, per-connection rate limit, idle timer, SIGTERM → SIGKILL process-tree
  kill, 64 KiB max frame. Closing a WS only detaches that client; the PTY stays
  alive for reconnect until `session.close()`, idle timeout, or PTY exit. Vendored static routes
  (`terminal.html`, `page.js`, `xterm.js`, `xterm.css`, `addon-fit.js`; query
  strings are stripped by `pathnameOf`, so cache-busters like `?cb=1` resolve
  to the same file). Spawns omp with the host's `~/.omp/agent/config.yml`
  prepended as the FIRST `--config` overlay and the ux-e2e overlay emitted
  second (omp merges overlays in argv order, later wins — the host's
  `modelRoles` survive so omp boots with a real model, while the overlay's
  overrides for `terminal` / `startup` / `autolearn` / `ask` win). Every PTY
  output frame is appended to `transcript.jsonl` — the server-side evidence
  backbone.
- **`src/driver.ts`** — `TerminalDriver` seam: `WsDriver` (text mode, reads the
  transcript) and `createPlaywrightDriver` (lazy optional `playwright`
  dependency). `TranscriptLog` (append-only scan, O(delta) cursor) +
  `AskStateTracker` ([ask_user] detection, double-answer guard).
- **`src/scenario.ts`** — `loadScenario()`: JSON scenario = data; validates with
  field names in errors, resolves `task: {file}`, expands `{{slug}} {{branch}}
  {{task}} {{cols}} {{rows}} {{max_time}} {{feature_description}}
  {{project_name}} {{platform_scope}}` plus scenario params. Built-in defaults
  cover every `{{key}}` in the reference `full-feature-task.md` so the rendered
  prompt never contains a literal `{{...}}`. Merge precedence: caller
  `params` > `def.params` > `BUILTIN_DEFAULTS`.
- **`src/report.ts`** — `generateReport()`: ux-e2e JSON + manual_qa-compatible
  markdown. Defect floors: CRITICAL→1, HIGH→2, MEDIUM→3, LOW→4; ratings are
  clamped and warnings are emitted.
- **`src/cli.ts`** — thin `node:util parseArgs` dispatch over the seven
  subcommands. `--detach` pipes child stdout/stderr to `detach.log` and tails
  it on timeout.

## WS protocol

Inbound (`browser → server`): `{t:'i', d}` input, `{t:'r', cols, rows}` resize.
For omp TUI submission, append `\n` for Enter; `\r` is literal input.
Outbound: `{t:'s', ok:true}` auth ack · `{t:'o', d}` PTY output ·
`{t:'exit', code, signal?}` process exit · `{t:'err', code, message}` where
`code ∈ {rate-limited, idle-timeout, spawn-failed, no-pty}`.

Upgrade path: `/ws?token=<session-scoped-token>`. The token remains valid for
reconnects while the session is alive and becomes unusable after shutdown.

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
- `--detach` runs the session in a detached child; its stdout/stderr are
  captured to `<scratch>/.work-state/ux-e2e/detach.log` and the parent
  surfaces the tail on the 15 s startup timeout. Stop the run with
  `ux-e2e stop <scratch>` (or let `--max-time` expire).
- The xterm stylesheet is served from `@xterm/xterm/css/xterm.css` (the package
  does not ship `lib/xterm.css`).
- The host `~/.omp/agent/config.yml` is auto-inherited as the first
  `--config` overlay so omp boots with a model. If the host config is missing
  or has no `modelRoles`, a WARNING is written to stderr and the resolved
  path + warning are recorded in `session.json` under `host_config`.
- Screenshots require the web surface (`playwright` installed); text mode
  `screenshot()` throws by design.
- **Single-PTY lifecycle** — the session holds ONE PTY for the whole run. A WS
  disconnect (browser reload, sleep/resume, network blip, or a rate-limit
  close) only detaches that client; reconnect with the session-scoped token
  continues driving the same PTY. The PTY ends only on `session.close()` /
  `ux-e2e stop`, idle timeout, or process exit.
- **Rate-limit typing threshold (FD-RL, observed live)** — the per-connection
  inbound rate limit is **200 messages / 1 s window** (see `RateLimiter` in
  `src/server.ts`). puppeteer's default `page.keyboard.type` runs at
  ~30 ms / char (~33 chars/s) which is comfortably under the limit for
  short bursts, but long prompt bursts (e.g. a 200-char task prompt typed
  back-to-back) can cross the rolling window and emit
  `{t:'err',code:'rate-limited'}` and detach that client while leaving the PTY
  alive. Recommended driver approaches:
    - **Batch via `ux-e2e ask <scratch> "<answer>"`** for pending asks — sends
      the answer in a single `{t:'i'}` frame and writes to `ask-state.jsonl`.
    - **Batch via `ux-e2e input <scratch> "<command>"`** for arbitrary commands
      — sends the command plus Enter (`\n`, never `\r`) in one frame.
    - **Throttle typing** — use `delay ≥ 150 ms` per character on
      `page.keyboard.type(...)` (200 ms was observed safe in a live run).
    - **Send whole prompts in one frame** rather than per-char keystrokes.
  Do not raise the limit without review; it protects the PTY from a runaway
  client, and a disconnected client can safely reconnect.

## License

MIT — see the repository root LICENSE. Security/PTY patterns ported from
`@pi-harness/web-terminal` (MIT).
