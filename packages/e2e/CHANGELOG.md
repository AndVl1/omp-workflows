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

- **Single-PTY lifecycle** — the session holds ONE PTY for the whole
  run; any WS disconnect kills it (single-use token, no reconnect).
  Documented as an explicit design decision in README
  "Known limitations" — restructuring to per-connection PTY would
  change the contract. Any transient WS failure (browser reload,
  sleep/resume) terminates the omp run; use `--max-time` and re-run.

## 0.1.0 — 2026-08-02

Initial release of the UX E2E test framework (pragmatic architecture).

- `startTestSession()`: loopback-only HTTP+WS server with single-use token
  auth, Origin/Host checks, strict CSP/frame/referrer headers, per-connection
  rate limit, idle timer, SIGTERM→SIGKILL process-tree kill, and a real omp
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
