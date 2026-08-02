# Changelog

## Unreleased

### Fixed

- WebSocket tokens are now scoped to the live session, so clients can reconnect
  with the same 256-bit localhost URL token until the session shuts down.
- Closing or losing a WebSocket now detaches only that client instead of killing
  the PTY. `session.close()`, idle timeout, and PTY exit retain their lifecycle
  behavior, including process-tree cleanup and exit notification.
- Added `ux-e2e input <scratch-dir> <text>` for arbitrary terminal commands. It
  sends `<text>\n` as one input frame without waiting for `[ask_user]`; `\n` is
  Enter in the omp TUI, while `\r` is literal input.
- Hardened `ux-e2e stop` against stale or foreign `session.json` PIDs: a live
  process must have a command line containing the requested scratch path before
  its process tree is terminated; mismatches are refused with an error.
- Added README guidance in **Session hygiene & safe stopping**: use only
  `ux-e2e stop <scratch>`, never broad `pkill`/`killall`/name-pattern kills,
  and rely on `start --force` for live-session replacement.
- `ux-e2e start --detach` now spawns the detached child with stdout/stderr
  redirected to `<scratch>/.work-state/ux-e2e/detach.log` via an inherited
  file descriptor — **no pipe between parent and child** — so the detached
  session survives the parent exiting. Previously the parent held a
  `pipe → logStream` open (event loop never drained; parent hung for >60 s
  after printing the URL) AND, more fatally, the parent's stdio teardown
  closed the pipe ends the child was writing to, so the next `console.log()`
  in the child triggered an unhandled EPIPE on its stdout and the process
  died ~3-4 s after the parent's exit (ECONNREFUSED on the session URL).
  Regression pinned by `test/detach.test.ts`: bootstrap → `start --detach`
  → assert parent exits in < 10 s → assert pid alive + port listening
  after 5.5 s → assert `ux-e2e input` round-trip — all green; the same
  flow previously hung the parent and crashed the child.
- README updates describing the fd-based detach mechanism in the `start`
  row, the `src/cli.ts` architecture bullet, and the `--detach`
  Known-limitation bullet.

## 0.1.4 — 2026-08-02

### qa_tests regression coverage (manual-QA verdict PASS, encoded as durable tests)

- **Report contract test** — `test/qa-regression.test.ts`: feeds
  `generateReport()` the realistic 11-step + 3-defect
  (FD-DETACH-LIFECYCLE / FD-RL / FD-REVIEW-REPORT-LOSS) input mirroring the
  live ux-e2e-reference3 run, asserts the JSON carries every
  manual_qa-required field (verdict / evidence / mode / regressions) AND
  the full ux-e2e shape (session / steps / defects / agent_quality /
  overall). Verdict PASS stays PASS; the CONDITIONAL → FAIL projection
  rule used by the downstream CI gate is documented as a single source of
  truth. MEDIUM defect floor clamps `overall.score` to 3 (matches the
  observed score of 3 in the live run).
- **Scenario shape test** — asserts `scenarios/full-feature.json` loads,
  expands with zero literal `{{...}}` left in the rendered task, and that
  its 10 stage ids (`discovery, exploration, clarify, architecture,
  implementation, code_review, review_fixes, manual_qa, qa_tests, summary`)
  match `packages/core/workflows/full-feature.json` IN ORDER.
- **Model-config inheritance test** — asserts `buildOmpArgs` emits
  `--config <host>` BEFORE `--config <overlay>` (overlay wins on conflict
  per omp's argv-order merge), NO `--profile` flag by default (host
  profile inherited so `modelRoles` survive), and `--profile <name>`
  emitted only when `opts.ompProfile` is set. Asserts `--profile` is
  positioned BEFORE the first `--config` so profile selection is resolved
  before overlay lookup.
- **Session artifact test** — fixture-driven assertion that session.json
  carries every field the report reads (slug, url, token, pid,
  started_at, omp_version, profile, tty, task_prompt) and that
  `task_prompt` contains no literal `{{...}}`. Also runs end-to-end
  through `generateReport()` to confirm the values flow from the fixture
  into the report's `report.session.*` fields.

### Documentation

- **FD-RL rate-limit typing threshold (doc-only, no code change)** —
  documented the observed typing-speed threshold in `README.md`
  "Known limitations" and `CHANGELOG.md` (this entry). The per-connection
  rate limit is **200 messages / 1 s window** (see `RateLimiter` in
  `src/server.ts`); puppeteer's default ~30 ms / char keyboard.type can
  cross the rolling window on a long prompt burst and emit
  `{t:'err',code:'rate-limited'}`. At the time this release shipped, a
  rate-limit close also killed the omp session; this lifecycle defect is fixed
  in Unreleased. Recommended workarounds were batching via `ux-e2e ask`,
  throttling to `delay ≥ 150 ms` per character, or sending a whole prompt in
  one WS frame. The limit remains to prevent a runaway client from drowning
  the PTY.

### Tests

- 8 new tests in `test/qa-regression.test.ts` (3 report, 1 scenario,
  2 buildOmpArgs, 2 session artifact). Total: 56 (was 48).

# Changelog

## 0.1.3 — 2026-08-02

### QA fixes round 2 (manual-QA verdict CONDITIONAL → PASS)

- **LOW (FD-R1)** — `parseStartArgs` normalizes `--scenario` to an
  absolute path against `process.cwd()` BEFORE the detached spawn.
  Previously the detached child re-ran `parseStartArgs` with
  `cwd = scratchDir`, so a relative `--scenario` resolved against the
  scratch dir and failed. Absolute paths pass through unchanged.
  Verified live: `start --detach --surface text --scenario
  packages/e2e/scenarios/full-feature.json` produces a session whose
  `session.json.scenario = { id: 'full-feature', title: 'Full workflow:
  discovery -> exploration -> clarify -> architecture -> implementation ->
  review -> manual QA' }`.
- **HIGH (model blocker)** — `buildOmpArgs` no longer emits `--profile`
  by default. `ompProfile` on `OmpLaunchConfig` is optional; when set,
  `--profile <name>` is still passed (callers opt in to a dedicated
  profile); when unset, NO profile flag is passed and omp inherits
  the host default profile (`~/.omp/agent/`) — `modelRoles`,
  `models.db`, and credentials all resolve there. The ux-e2e overlay
  still runs SECOND as a `--config` overlay so its overrides win; the
  host's `modelRoles` survive untouched. `startTestSession` records
  the resolved profile name in `session.json.profile` (null when no
  profile is set; `report.ts` falls back to `default`). Verified live:
  spawning `omp --config ~/.omp/agent/config.yml
  --config <scratch>/.omp/ux-e2e-overlay.json --session-dir
  <scratch>/.omp/agent --hide-thinking --max-time 30m --approval-mode
  yolo` (exactly the args the new builder emits) boots omp
  model-capable — the welcome screen shows `DeepSeek V4 Flash (New) ·
  opencode-go` (the host default from `~/.omp/agent/config.yml`).
  No `No model selected` / `No models available` errors.

### Tests

- 2 new tests: FD-R1 scenario-path normalization in `cli.test.ts`,
  default-args contract in `server.test.ts` (omits `--profile`, still
  emits both `--config` overlays in host-first / overlay-second order).
  Total: 48 (was 46).

# Changelog

## 0.1.2 — 2026-08-02

### QA-blocking defect fixes (manual-QA verdict FAIL)

- **CRITICAL (D1)** — `/page.js` is now served as a static route by
  the loopback HTTP server. The browser-side terminal page boots
  end-to-end (terminal.html + page.js + xterm.js + xterm.css +
  addon-fit.js). `pathnameOf(req)` already stripped query strings so
  cache-busters like `?cb=1` do not break the route. Verified via
  `curl /page.js?cb=1` → 200 with the real page.js bytes (3474 B).
- **HIGH (D2)** — `ux-e2e start --detach` now pipes the child process
  stdout/stderr to `<scratch>/.work-state/ux-e2e/detach.log`. On the
  15 s startup timeout the parent reads the last 8 KiB of that log
  and prints it to stderr so the real failure mode is visible
  instead of being swallowed by `stdio: 'ignore'`.
- **HIGH (D3)** — `BUILTIN_DEFAULTS` now includes `feature_description`,
  `project_name`, and `platform_scope` so the `full-feature` reference
  task template expands without any literal `{{...}}` left in the
  rendered prompt. Merge precedence (`params` > `def.params` >
  `BUILTIN_DEFAULTS`) was already correct; a regression test pins both
  the expansion and the precedence.
- **HIGH (D4)** — `buildOmpArgs` now accepts `hostConfigPath`. The
  host's `~/.omp/agent/config.yml` is prepended to the argv as the
  FIRST `--config` overlay (verified against `omp v17.2.3 --help`:
  overlays merge in argv order, later wins). The ux-e2e overlay is
  emitted second so its overrides win for keys it explicitly sets,
  while the host's `modelRoles` (untouched by the overlay) survives —
  preventing the "No model selected" boot state documented in the
  manual-QA evidence. The host config path and a `WARNING` (when
  the file is missing or has no `modelRoles`) are recorded in
  `session.json` under `host_config` and emitted to stderr.

### Tests

- 5 new tests (D1 HTTP route, D2 detach-log helpers, D3 zero-literal
  expansion, D4 args-builder order, D4 host-config check). Total:
  46 (was 41).

## 0.1.1 — 2026-08-02

### Review fixes (code-reviewer + security-tester, 10 findings)

- **HIGH** — session.json + transcript.jsonl are now written with mode
  `0o600` (writeFileSync + chmodSync belt-and-braces); `.work-state/ux-e2e/`
  is created with `0o700`. Stops world-readable plaintext token + full
  PTY I/O leakage on multi-user hosts.
- **MEDIUM** — PTY env now strips `HTTP_PROXY` / `HTTPS_PROXY` /
  `ALL_PROXY` / `NO_PROXY` (upper + lower case) by default via a port
  of `@pi-harness/web-terminal` `buildPtyEnv`. New `keepProxyEnv`
  option on `TestSessionOptions` opts out.
- **MEDIUM** — full CSP/header set ported from prior art: `base-uri`,
  `form-action`, `frame-ancestors`, `img-src`, `font-src`,
  `object-src`, `manifest-src` plus `Cross-Origin-Opener-Policy`,
  `Cross-Origin-Embedder-Policy`, `Cross-Origin-Resource-Policy`.
  `X-Frame-Options: DENY` and `Referrer-Policy: no-referrer` retained.
- **MEDIUM** — loopback alias accepts `127.0.0.1` / `localhost` / `::1`
  interchangeably (port must match). A hand-typed `localhost:<port>`
  no longer gets a 403 on the WS upgrade.
- **MEDIUM** — `no-pty` behavior unified: silent-drop input + keep
  socket open (matches prior art semantics). Old per-frame `no-pty`
  error + close loop removed. Tests aligned.
- **MEDIUM** — `TranscriptLog.refresh()` is now O(delta): tracks
  `fstatSync(fd).size` as the next-read offset and re-uses a partial
  tail buffer so a frame never spans two reads. Multi-MB transcripts
  no longer re-read the whole file on every poll.
- **MEDIUM** — `WsDriver.open()` closes the failed socket in the
  error path before throwing (`ws.terminate()`); no more WS leak when
  the upgrade fails.
- **LOW** — `task_prompt` is sanitized (ANSI escapes + lone C0 control
  chars stripped) in both `session.json` and the generated report.
- **LOW** — dead `transcript-advanced` branch in
  `AskStateTracker.answer()` captured-null path removed; the
  `AnswerResult` type still carries `transcript-advanced` for the
  captured-non-null branch (which is reachable).

### Documented design decisions

- **Single-PTY lifecycle (superseded)** — this release ended the session on
  any WS disconnect and used a single-use token. Unreleased replaces that
  behavior with client detachment plus session-scoped reconnects.

## 0.1.0 — 2026-08-02

Initial release of the UX E2E test framework (pragmatic architecture).

- `startTestSession()`: loopback-only HTTP+WS server with the original
  single-use-token auth (superseded by the session-scoped token in Unreleased),
  Origin/Host checks, strict CSP/frame/referrer headers, per-connection rate
  limit, idle timer, SIGTERM→SIGKILL process-tree kill, and a real omp
  PTY (TERM=xterm-256color, rc-suppressed by direct spawn).
- Server-side `transcript.jsonl` append — the evidence backbone for reports.
- TerminalDriver seam: `WsDriver` (text mode over the transcript) and lazy
  `createPlaywrightDriver` (browser surface).
- `TranscriptLog` + `AskStateTracker`: [ask_user] detection and double-answer
  guard.
- Scenario-as-data: `loadScenario()` with `{{param}}` expansion and built-in
  `full-feature` reference scenario (10 stages, 6 clarify + 1 architecture
  ask expectations).
- `generateReport()`: ux-e2e JSON + manual_qa-compatible markdown with defect
  floors (CRITICAL→1, HIGH→2, MEDIUM→3, LOW→4) and evidence collection.
- `ux-e2e` CLI: bootstrap | start | stop | transcript | ask | report.
- Unit tests for server security (token/replay/origin/rate/idle + ws echo),
  drivers, scenario loading, report clamping, and CLI dispatch.
