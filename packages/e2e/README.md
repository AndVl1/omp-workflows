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

# 3. Start a session (prints a one-shot browser bootstrap URL)
node packages/e2e/dist/cli.js start /tmp/omp-ux-e2e-my-feature \
  --scenario packages/e2e/scenarios/full-feature.json

# 4. Open the bootstrap URL in a browser (it exchanges ?code= for an
#    HttpOnly cookie; reloads use that cookie and no URL credential)
#    Ask-state helpers:
node packages/e2e/dist/cli.js ask /tmp/omp-ux-e2e-my-feature --list
node packages/e2e/dist/cli.js ask /tmp/omp-ux-e2e-my-feature "1"
#    OMP 18 native Ask cards with multiple D-* questions require explicit answers:
node packages/e2e/dist/cli.js ask /tmp/omp-ux-e2e-my-feature --answers '{"d101":"Approve","d102":"1"}'
#    Arbitrary command input (sends text followed by real PTY Enter `\r`; see [Enter semantics](#enter-semantics-r-vs-n)):
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
| `start <scratch-dir>` | `startTestSession()` + print a one-shot browser bootstrap URL (`?code=...`), never the long-lived session bearer. Foreground mode prints live `[ask_user]` hints and exits when omp exits; `--detach` runs the session in a **detached child that survives the parent** — the child writes its stdout/stderr directly into `<scratch>/.work-state/ux-e2e/detach.log` via an inherited file descriptor (no pipe between parent and child, so the child cannot crash with EPIPE when the parent exits). The parent waits up to 60 s for matching `server_pid` + startup nonce and tails the last 8 KiB on timeout so failures are not swallowed. `--scenario`, `--task`, `--surface web\|text`, `--cols/--rows/--port`, `--max-time`, `--idle-ms`. `--force` allows relaunch over a live session. Honours the optional user-supplied overla… |
| `stop <scratch-dir>` | Authenticated `POST /control/stop` using the exact v2 session metadata (`session_id`, `control_nonce`, bearer token, and server identity). The server owns shutdown: it asks the PTY to close gracefully and waits for its original exit; the CLI never kills a PID from `session.json`. |
| `transcript <scratch-dir>` | Render transcript.jsonl as text; `--tail N`, `--follow`. |
| `ask <scratch-dir> [<answer>]` | List or answer a pending legacy `[ask_user]` prompt or OMP 18 native Ask card. Native cards expose structured `D-*` question IDs; a multi-question card fails closed for positional `<answer>` and requires `--answers '{"d101":"Approve","d102":"1"}'`. |
| `input <scratch-dir> <text>` | Unconditionally sends `<text>` followed by real PTY Enter (`\r`) in separate `{t:'i'}` frames, without requiring a pending `[ask_user]` prompt. `WsDriver.submit()` remains a legacy LF helper; prefer `pressEnter()` for real omp submit — see [Enter semantics](#enter-semantics-r-vs-n). |
| `report <scratch-dir>` | `generateReport()` → `<scratch>/.work-state/ux-e2e/report.json` + `<mdDir>/<slug>-ux-e2e-<date>.md` (default `./vibe-report`). `--steps` supplies structured ratings; `--copy-evidence` mirrors evidence files. |

## Session hygiene & safe stopping

Every running session publishes exact `schema_version: 2` metadata in
`<scratch>/.work-state/ux-e2e/session.json`. Stop sessions **only** through
`ux-e2e stop <scratch>` (or `npm run e2e -- stop <scratch>`). The CLI reads and
validates that metadata, then sends an authenticated `POST /control/stop`
bound to the session ID, control nonce, bearer token, and server identity.

The server owns the PTY lifecycle: it requests a graceful close and waits for
the original PTY to report exit before closing its listener and retained state
directory. A stop response of `202` means the request was accepted; shutdown
failure is retained and reported by the server. The CLI never sends a signal
to a PID read from `session.json`, and no process-tree or arbitrary-PID kill
fallback exists.

Ask reservations are short-lived records bound to the exact session nonce,
answering process PID/start identity, and lease expiry. Input is committed only
after revalidation and observed terminal output/lifecycle evidence; an inbound
transcript frame alone is not success evidence.

**Never** use `pkill`, `killall`, or `kill` by a process name or pattern (for
example `omp` or `bun`). Those commands can terminate sessions belonging to
other terminals or users. `start --force` handles a live session for the
requested scratch directory through the authenticated lifecycle.

## Architecture

- **`src/server.ts`** — `startTestSession()`: loopback-only HTTP+WS server,
  exact `schema_version: 2` session metadata, session-scoped 256-bit token
  (constant-time compare), Origin (if present) / Host checks,
  `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer`, strict CSP,
  per-connection rate limit, idle timer, authenticated server-owned graceful
  PTY shutdown, and a 64 KiB max frame. Closing a WS only detaches that client;
  the PTY stays alive for reconnect until server shutdown, idle timeout, or PTY
  exit. Vendored static routes
  (`terminal.html`, `page.js`, `xterm.js`, `xterm.css`, `addon-fit.js`; query
  strings are stripped by `pathnameOf`, so cache-busters like `?cb=1` resolve
  to the same file). Spawns omp with up to three `--config` overlays in
  argv order (omp merges them with later wins on conflict):
  1. host `~/.omp/agent/config.yml` (auto-inherited — operator's modelRoles,
     creds, models.db survive so omp boots with a real model);
  2. `<scratch>/.omp/ux-e2e-overlay.json` (regenerated every start — session
     bookkeeping wins over host defaults for keys it explicitly sets);
  3. `<scratch>/.omp/ux-e2e-overlay.user.json` (operator-supplied, **opt-in** —
     emitted only when the file exists; wins on conflict so a test run can
     pin e.g. `modelRoles.default` without touching the host config or the
     regenerated standard overlay; see [User-supplied overlay](#user-supplied-overlay)).
  Every PTY output frame is appended to `transcript.jsonl` — the
  server-side evidence backbone.
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
- **`src/cli.ts`** — thin `node:util parseArgs` dispatch over the seven
  subcommands. `--detach` pins the state directory, opens `detach.log`
  descriptor-relatively with no-follow/non-blocking regular-file checks, and
  gives the descriptor to the child (no parent-side pipe). It forwards the
  exact `--force`, `--max-time` seconds, and `--idle-ms` values plus a unique
  startup nonce; readiness accepts only matching `server_pid` + nonce metadata,
  then tails the bounded log on startup timeout.

## User-supplied overlay

The harness auto-emits two `--config` overlays for every session: the host
config (so `modelRoles` survive) and the regenerated ux-e2e overlay. Drop a
third file at `<scratch>/.omp/ux-e2e-overlay.user.json` (any valid
omp config.yml subset) and the harness will pass it as the **third**
`--config` — its keys win on conflict over both the host config and the
standard overlay, without touching either.

Use it to pin the active session model without modifying the operator's
host config or the regenerated standard overlay:

```yaml
# <scratch>/.omp/ux-e2e-overlay.user.json
modelRoles:
  default: minimax/MiniMax-M2.7
  ask: minimax/MiniMax-M2.7
  plan: minimax/MiniMax-M2.7
```

Presence is the opt-in signal: the file is never auto-created, and the
third `--config` is omitted entirely when the file is absent. The resolved
path (or `null`) is recorded in `session.json` under `user_config` for
diagnostics:

```jsonc
{
  "user_config": {
    "path": "/tmp/omp-ux-e2e-my-feature/.omp/ux-e2e-overlay.user.json",
    "default_path": "/tmp/omp-ux-e2e-my-feature/.omp/ux-e2e-overlay.user.json"
  }
}
```

Argv order (omp merges with later wins on duplicate keys):

```
--config <~/.omp/agent/config.yml>             # host   — modelRoles survive
--config <scratch>/.omp/ux-e2e-overlay.json    # ux-e2e  — session bookkeeping
--config <scratch>/.omp/ux-e2e-overlay.user.json   # user — highest priority (opt-in)
```

## WS protocol

Inbound (`browser → server`): `{t:'i', d}` input, `{t:'r', cols, rows}` resize.
See [Enter semantics](#enter-semantics-r-vs-n) below — Enter in a PTY is
`\r`, not `\n`.
Outbound: `{t:'s', ok:true}` auth ack · `{t:'o', d}` PTY output ·
`{t:'exit', code, signal?}` process exit · `{t:'err', code, message}` where
`code ∈ {rate-limited, idle-timeout, spawn-failed, no-pty}`.

### Enter semantics (`\r` vs `\n`)

A real Enter keypress in a PTY produces **CR (0x0D, `'\r'`)**, not LF
(0x0A, `'\n'`). In the omp TUI the editor maps `\r` to "submit current
line"; `\n` is just a line break and does **not** submit.

- `WsDriver.pressEnter()` — sends `{t:'i', d:'\r'}` (real Enter over WS).
- `PlaywrightDriver.pressEnter()` — calls `page.keyboard.press('Enter')`
  (real Enter via CDP; xterm forwards `'\r'` through `onData`).
- Web toolbar **⏎ Enter** button — `window.__pressEnter()` in
  `assets/page.js`: primary path dispatches a synthetic `KeyboardEvent`
  (`key:'Enter'`, `keyCode:13`) on `term.textarea`; if xterm does not
  forward `'\r'` within ~100 ms (focus lost, textarea disabled) the
  handler falls back to `{t:'i', d:'\r'}` directly. A one-shot `onData`
  listener guards the fallback so it never duplicates `'\r'` when the
  primary path succeeds.
- `WsDriver.submit(text)` (legacy) — appends `'\n'`. Retained for
  backward compatibility with surfaces that normalised LF → CR; prefer
  `pressEnter()` for real PTY sessions.
The programmatic upgrade path is `/ws?token=<session-scoped-token>`; browser pages use the one-shot `/?code=<bootstrap-code>` exchange and then reconnect with the HttpOnly cookie. The token remains valid only while that exact v2 session is active; the loopback `Host`/`Origin` checks and authenticated session identity are enforced on every upgrade. The server owns PTY shutdown: callers use authenticated `POST /stop`, never a PID fallback, and startup/stop completion is accepted only after the exact session's lifecycle evidence is observed.

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

1. `ux-e2e start <scratch> --detach` → prints the one-shot browser bootstrap URL.
2. Open it in a browser; the server exchanges `?code=...` for an HttpOnly
   cookie and the page removes the code before reconnects or reloads. Never
   share the bootstrap URL.
3. Drive the terminal as a human: type `/do-work <task>`. The toolbar at
   the bottom of the page has an **⏎ Enter** button (`window.__pressEnter()`)
   that emits a real Enter keypress — use it whenever the TUI is waiting
   for input and you would press Enter at a real keyboard.
4. On every legacy `[ask_user]` prompt or OMP 18 native Ask card, either type
   the answer in the terminal, run `ux-e2e ask <scratch> --list`, or answer via
   `ux-e2e ask <scratch> "<answer>"`. For native cards with multiple `D-*`
   questions, use `--answers '{"d101":"Approve","d102":"1"}'`; a single
   positional answer is rejected rather than applied to every question.
5. At each stage: screenshot, rate the 6 UX dimensions, log defects to a
   `steps.json`.
6. `ux-e2e report <scratch> --steps steps.json --copy-evidence`.

## Known limitations

- Ask detection supports legacy `[ask_user]` blocks and OMP 18 native cards
  (`Ask N questions`, `D-*` tabs, option labels/descriptions, and Submit).
  Multi-question native cards fail closed unless every question ID is supplied
- Exact `schema_version: 2` session metadata is required; a live process ID
  alone is never sufficient for lifecycle control.
- `--detach` runs the session in a detached child whose stdout/stderr are
  captured to `<scratch>/.work-state/ux-e2e/detach.log` via a pinned inherited
  descriptor (no pipe between parent and child). The child **outlives the
  parent** and is stopped only through the authenticated server control POST or
  its `--max-time` expiry; the CLI does not kill a recorded PID. The parent
  surfaces the bounded log tail on startup timeout.
- The xterm stylesheet is served from `@xterm/xterm/css/xterm.css` (the package
  does not ship `lib/xterm.css`).
- The host `~/.omp/agent/config.yml` is auto-inherited as the first
  `--config` overlay so omp boots with a model. If the host config is missing
  or has no `modelRoles`, a WARNING is written to stderr and the resolved
  path + warning are recorded in `session.json` under `host_config`.
- A user-supplied overlay at `<scratch>/.omp/ux-e2e-overlay.user.json` is
  emitted as the **third** `--config` (highest priority) so a test run can
  pin `modelRoles` (or any other key) without touching the host config or
  the regenerated standard overlay. Presence is the opt-in signal: the file
  is never auto-created, and the path (or `null`) is recorded in
  `session.json` under `user_config`. See
  [User-supplied overlay](#user-supplied-overlay).
    - **Batch via `ux-e2e input <scratch> "<command>"`** for arbitrary commands
      — sends the command followed by real PTY Enter (`\r`). The command and
      submit are separate input frames; see [Enter semantics](#enter-semantics-r-vs-n).
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
      — sends the command followed by real PTY Enter (`\r`); see [Enter semantics](#enter-semantics-r-vs-n).
    - **Throttle typing** — use `delay ≥ 150 ms` per character on
      `page.keyboard.type(...)` (200 ms was observed safe in a live run).
    - **Send whole prompts in one frame** rather than per-char keystrokes.
  Do not raise the limit without review; it protects the PTY from a runaway
  client, and a disconnected client can safely reconnect.

## License

MIT — see the repository root LICENSE. Security/PTY patterns ported from
`@pi-harness/web-terminal` (MIT).
