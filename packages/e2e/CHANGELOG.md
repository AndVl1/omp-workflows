# Changelog

## Unreleased

### Changed

- Replaced scratch `bootstrap`, `npm link`, host-config overlays and implicit
  installed plugins with a secret-free config → resolved run manifest. `prepare`
  snapshots working-tree sources (including uncommitted changes), builds
  content-addressed core/fullstack dependency closures and the installed omp
  runtime, and provisions an isolated Git workspace, HOME and agent roots.
- All session, report and cleanup commands now address the validated manifest.
  Sessions have separate IDs, transcripts and process receipts while preserving
  canonical workflow state across stop/restart. Web clients can reconnect and
  receive bounded recent PTY output. Legacy scratch commands fail with a
  migration error rather than falling back to host inheritance.
- Added explicit provider-free, environment API-key, external broker and
  opt-in managed native-host-broker auth modes. The managed broker reuses the
  installed omp's current OpenAI Codex/xAI OAuth DB without copying credentials
  into a run; separate addressable broker lifecycle and clear refresh-ownership
  limits are documented.
- Added `doctor`, `verify --suite isolation|live-smoke`, `cleanup`, and root
  `e2e:*` scripts. Verification produces scoped/redacted evidence and always
  attempts run-owned cleanup; a failed check is never masked by cleanup.
  Permanent regression tests cover runtime/artifact integrity, global leakage,
  broker lifecycle, session restart, credential redaction and process ownership.
- `prepare` now resolves `runtime.binary: "omp"` outside npm's checkout-local
  `.bin` shims; an absolute path still pins a deliberate runtime. Default
  session selection prefers the sole active session rather than stale stopped
  records, and linked run-lifecycle operator recipes use manifest/session paths.
- `stop` requests an authenticated owner-side close on loopback and retains the
  actual PTY exit (including the owner-requested SIGTERM encoding `143/0`).
  Unrequested, forced, unobserved or otherwise non-clean termination cannot
  pass reporting; an unreachable owner receives receipt-checked failure
  recovery. Detached control workers receive an explicit environment allowlist
  while preserving the opted-in native broker profile.
- Native broker ownership reads Linux `/proc/<pid>/cwd` rather than procps'
  `-` placeholder, retaining exact cwd matching when launched in CI.
- Added standalone `oauth-refresh` / `test:oauth-refresh` regression using real
  native broker, SQLite storage and remote clients from pinned `pi-ai@18.0.6`
  with an injected synthetic loopback OAuth endpoint. Assertions cover concurrent
  single refresh, rotated-token consumption, persisted reuse, refresh-secret
  redaction, transient errors and cleanup without real credentials or LLM calls.
  Bun >=1.3.14 is required; missing prerequisites fail rather than skip.
  This component/process proof does not claim unchanged CLI `serve`, real provider
  protocol, background refresh or ordinary-client cross-process coverage.
- Managed broker stop now rechecks process liveness when ownership observation
  loses a terminating target, completing the same stop and receipt cleanup once
  its listener is free. Still-live mismatched PIDs are refused rather than treated
  as stale receipts; a real-child race regression verifies both boundaries.
- Live verification now reads branch-owned schema-2 canonical run state and
  correlates submitted task, selected provider/model/API/usage and completion
  through explicitly loaded read-only native evidence. Startup animations
  cannot erase readiness; extension/user echoes, startup turns, provider errors,
  truncation and structured workflow refusals cannot produce a false PASS.
  Timeout reports preserve independently observed checks and restart proves
  a distinct native session with unchanged saved state.
- `prepare` follows installed npm executable symlinks for standalone CLI builds
  without relaxing run, artifact or process ownership validation.
- Native session identity compares the ownership-checked physical session root,
  so macOS temp-directory aliases do not reject genuine lifecycle receipts.
  A receipt claiming a different directory still fails before command input.
- Initial command input and resumed-session identity wait for a complete native
  startup receipt independently of transport readiness. Startup waits remain
  bounded; unsafe, corrupt or foreign receipts are refused rather than retried.
- The live fixture declares project-scoped `qa` / `reviewer` model aliases via
  `@task`, so native 18.4.9 does not treat missing class-role aliases as literal
  model selectors and fail before a child starts. Real QA and reviewer probes
  completed with native child receipts for the authorized Grok 4.7 model;
  no host model settings or credential DB are copied.
- Completed the real provider-backed Grok 4.7 `/do-work` smoke through worker
  implementation, review, QA/DoD and summary gate, with two user-authorized native
  terminal approvals. The immutable reasoning recipe used a finite 1200000 ms
  deadline without weakening committed defaults or workflow-error/provenance
  assertions. Native restart/state preservation, valid retained evidence,
  private-root cleanup and owned-broker listener release were observed.

### Security

- Manifest and source-path validation, allowlisted child environment, immutable
  cache integrity checks, private session connection records, and verified
  process-tree stop replace best-effort scratch-path and PID matching.
  Process isolation is not a host OS sandbox.
- Retained native evidence is scoped to registered private session files,
  rejects symlink/hardlink targets and drops raw tool arguments/results.
  Quoted and escaped token/nonce values in assistant/terminal text are redacted.
  ANSI styling is removed before secret matching on decoded string fields.
  Registered PTY JSONL is decoded and re-serialized per frame so an incomplete
  CSI sequence cannot consume JSON delimiters or corrupt following evidence.

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
