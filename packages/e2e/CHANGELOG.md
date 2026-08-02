# Changelog

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
