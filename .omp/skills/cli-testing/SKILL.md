---
name: cli-testing
description: Run repository-aware process-level smoke tests for omp-workflows CLIs and the isolated E2E harness. Use when validating command contracts, reproducing CLI failures, checking JSON/stdout/stderr and exit status, exercising PTY/process lifecycles, or separating provider-free, credentialed, unit-test, and CI evidence.
---

# CLI testing

Use this skill for a real executable and a disposable scope. A package test or a green
build is evidence for that layer only; it is not process-level CLI acceptance.

## 1. Discover the contract first

- Read the target package's `package.json`, README, and current root scripts before
  invoking it. Start with the executable's `--help`; use subcommand help only if
  supported (`e2e` documents subcommands in top-level help). Copy required
  positional arguments and option names exactly.
- Capture exit status, stdout, and stderr separately with a process API or equivalent.
  For an expected-invalid invocation, assert a nonzero status and the documented
  error (`--json` stdout or text-mode stderr), plus no unintended state changes.
  Preserve that failure before correcting the command; do not hide it with `|| true`.
- With `--json`, parse the documented stdout value independently from stderr. Assert
  the expected result/error code and important fields, not merely non-empty output.
  Never parse a combined stdout/stderr stream, and redact tokens before saving output.
- For this repository, plain `npm run e2e:*` can add npm's outer banner to stdout
  even when the inner script is silent. Use `npm --silent run e2e:* -- ...` whenever
  asserting machine-readable output; keep human-readable invocations separate.

## 2. Use disposable, scoped state

- For a normal CLI, create a temporary directory, seed the smallest fixture, pass an
  explicit working/output directory, and remove it with a trap. Do not use a personal
  checkout, home directory, or credential-bearing fixture as the test workspace.
- For this repository's E2E CLI, use Node 20+, npm, a supported installed `omp`, and
  the local build dependencies. Set `OMP_E2E_ROOT` before `prepare` and retain it for
  every later command. Use a unique run ID and the manifest produced beneath
  `$OMP_E2E_ROOT/runs/<run-id>/manifest.json`; never copy or hand-edit a manifest.
- The root scripts build `packages/e2e` before invoking its CLI. Exercise the process
  path through `npm --silent run e2e:* -- ...`, not only imported functions or package tests.

Provider-free smoke (safe default):

```bash
export OMP_E2E_ROOT="${TMPDIR:-/tmp}/omp-workflows-e2e"
RUN_ID="cli-isolation-$(date +%s)-$$"
npm --silent run e2e:prepare -- --config packages/e2e/scenarios/isolated-smoke.env.json --run "$RUN_ID" --json
MANIFEST="$OMP_E2E_ROOT/runs/$RUN_ID/manifest.json"
npm --silent run e2e:doctor -- --manifest "$MANIFEST" --json
npm --silent run e2e:verify -- --manifest "$MANIFEST" --suite isolation --json
```

`auth.mode: none` still starts a real `omp` PTY and checks offline catalog/plugin
 discovery; it makes no model request. `verify` must be nonzero for a prerequisite or
acceptance failure. Cleanup succeeding afterward does not convert that failure to a
pass. Use `--keep-failed` when evidence or the disposable workspace is needed for
triage, then clean it explicitly.

## 3. Exercise interactive lifecycle when required

Use a distinct session ID for every clean session and address the manifest, never a
scratch path:

```bash
export OMP_E2E_ROOT="${TMPDIR:-/tmp}/omp-workflows-e2e"
LIFECYCLE_ID="cli-lifecycle-$(date +%s)-$$"
npm --silent run e2e:prepare -- --config packages/e2e/scenarios/isolated-smoke.env.json --run "$LIFECYCLE_ID" --json
LIFECYCLE_MANIFEST="$OMP_E2E_ROOT/runs/$LIFECYCLE_ID/manifest.json"
npm --silent run e2e:doctor -- --manifest "$LIFECYCLE_MANIFEST" --json
npm --silent run e2e:start -- --manifest "$LIFECYCLE_MANIFEST" --session-id lifecycle-1 --surface text --detach --json
# Intentionally no e2e:input: auth.mode:none must remain provider-free.
npm --silent run e2e:transcript -- --manifest "$LIFECYCLE_MANIFEST" --session-id lifecycle-1
npm --silent run e2e:stop -- --manifest "$LIFECYCLE_MANIFEST" --session-id lifecycle-1 --json
npm --silent run e2e:report -- --manifest "$LIFECYCLE_MANIFEST" --copy-evidence --json
npm --silent run e2e:cleanup -- --manifest "$LIFECYCLE_MANIFEST" --json
```
This provider-free block intentionally omits `/do-work`: `auth.mode: none` makes no
model request. Use `e2e:input` only with a live manifest after auth-broker/doctor
preflight, or with a slash command documented by the installed runtime as offline-safe.

For a web surface, `start --json` returns a private connection-file path, not a
bearer URL. Hand that path to the approved browser or terminal client without
printing the URL or token. For authorized live or documented offline sessions, submit
PTY input with CR/Enter (not LF); `e2e:input` performs the correct submission. Check
semantic/state evidence, not terminal echo alone. `stop` must show run-owned process
receipt and observed exit. A recovery stop for an unreachable owner is not a clean
acceptance. Never use `pkill`, `killall`, or a process-name kill. Do not rewrite an
observed owner-requested `143`/signal `0` exit to `0`; retain the receipt and report.

## 4. Keep authentication boundaries explicit

Do not call a provider-backed run “offline” or infer live acceptance from unit tests.
Only run a live smoke when the user explicitly supplies the authorized environment:

```bash
export OMP_E2E_ROOT="${TMPDIR:-/tmp}/omp-workflows-e2e"
LIVE_ID="live-$(date +%s)-$$"
npm --silent run e2e:prepare -- --config packages/e2e/scenarios/live-smoke.env.json --run "$LIVE_ID" --json
LIVE_MANIFEST="$OMP_E2E_ROOT/runs/$LIVE_ID/manifest.json"
npm --silent run e2e:auth-broker -- ensure --manifest "$LIVE_MANIFEST" --json
npm --silent run e2e:doctor -- --manifest "$LIVE_MANIFEST" --json
npm --silent run e2e:verify -- --manifest "$LIVE_MANIFEST" --suite live-smoke --json
```

Credentials stay in the launching environment and never enter config fixtures,
argv, manifests, reports, transcripts, or exported evidence. Missing auth must fail
closed. Native host broker use is explicit; run cleanup does not stop the shared
broker, and cross-process OAuth refresh safety is not proven by this harness. Do not
rotate credentials or silently switch providers/models to make a run pass.

When an existing dedicated profile is authorized, export `OMP_PROFILE` before
prepare, doctor, verify and broker lifecycle commands. Use a reviewed config whose
`auth.provider` and `model` match that profile; the committed OpenAI config is not
an xAI recipe. Keep `fixture.source: "./live-smoke-fixture"`: it supplies the
explicit README worker mapping and read-only native event observer. Do not repair
missing worker scope by allowing orchestrator writes or editing canonical state.
Preserve the fixture's project `modelRoles` bindings for `qa` / `reviewer`. Native
18.4.9 can interpret an unconfigured custom alias as a literal model selector and
fail with `No model selected`; the fixture maps these aliases through `@task`.
Verify actual child provider/model metadata when investigating routing: root-only
native observer records do not prove a worker's model, and the reviewer's native
slow/auth-aware fallback is still in effect. Never repair this by copying a host
auth DB or changing global model settings.
The reviewed live scenario uses `/do-work --new`, not ambiguous task-only ingress.
Follow the returned stage contract: orchestration stages advance after their
declared action; single-worker stages require an actual native task/result before
completion. Never invent a dispatch ID or invoke an undeclared checkpoint.
`[AUTONOMOUS]` cannot authorize a checkpoint. Supervise genuine human approvals
only after the user explicitly grants the relevant decision, and enter it through
the actual native TUI. Do not fabricate ledger/proof or suppress an unanswered
approval timeout. A reasoning-model recipe may select a larger finite
`timing.stageTimeoutMs` before prepare; the config's `timeout_ms` is not the command
deadline. Never edit a generated scenario or manifest to extend an active run.

For a supervised run, choose an explicit `verify --session-id approved-live` and
inspect the same session's actual native modal. After the user authorizes its
selected `proceed`, `npm --silent run e2e:input -- --manifest "$LIVE_MANIFEST"
--session-id approved-live --text '' --json` sends Enter through the ordinary PTY
path. Before implementation approval, verify exact README bytes and the bound
implementation artifact's worker `files_touched: ["README.md"]`; do not compare
all orchestrator/host metadata writes with worker scope. Require native ask
success rather than transport input success. TUI 18.4.9 submits optional no-image
fields as own `undefined` values; Core accepts that shape while rejecting unknown
metadata, malformed image lists and unsupported attachments. Genuine approval
does not turn a later failed dispatch, workflow refusal or timeout into PASS.

Once all clients are stopped, stop the explicitly managed broker separately:

```bash
npm --silent run e2e:auth-broker -- stop --manifest "$LIVE_MANIFEST" --json
npm --silent run e2e:auth-broker -- status --manifest "$LIVE_MANIFEST" --json
```

Require the manager receipt removed and its listener free. A still-live mismatched
PID must be refused; an owned target disappearing during identity observation
must complete the same stop rather than require a second invocation. Never use
raw process-name cleanup or infer broker shutdown from run cleanup alone.

### Standalone synthetic OAuth regression

For controlled token refresh without a real account or a model request:

```bash
npm --silent run test:oauth-refresh
# Equivalent CLI command, including machine-readable evidence:
npm --silent run e2e:oauth-refresh -- --json
```

Requires repository development dependencies and Bun >=1.3.14; no manifest or
installed `omp` is needed. This runs real native broker/storage/client components
from pinned `pi-ai@18.0.6` with an injected loopback synthetic token endpoint.
The assertions require three overlapping client requests to cause one provider
refresh, rotated access consumption, persisted reuse after SQLite reopen, no
stale-token fallback after HTTP 503, and complete cleanup. Only the disposable
synthetic record's expiry is moved into the native 60-second refresh window.

Missing/old Bun or a failed assertion is a nonzero failure, not a skipped PASS.
Keep this evidence separate from real-provider `live-smoke`: it does not prove
unchanged CLI `auth-broker serve`, xAI/OpenAI OAuth protocols, scheduled background
refresh or ordinary-client cross-process single-flight. Never change a real
profile's token expiry to reproduce this scenario.

## 5. Diagnose without erasing evidence

- Help/argument failure: preserve the nonzero result, consult `--help`, correct the
  missing positional or flag, and rerun as a separate attempt.
- Mixed or invalid JSON: inspect the separately captured streams and the command's
  documented `--json` contract; never trim diagnostics into a false JSON pass.
- Missing generated state or index: run the CLI's documented prepare/rebuild command,
  retain the initial failure, and rerun only after the prerequisite succeeds.
- PTY hangs or an apparently successful submit: inspect session/transcript evidence,
  use CR or `e2e:input`, and do not count echoed input as command/model execution.
- For live verification, require the fixture's native event observer, exact
  submitted-task correlation after Enter, selected provider/model metadata, and
  the matching native `agent_end`; an input prompt is only startup readiness.
  Require canonical schema-2 state in the disposable
  `.work-state/runs/<UUID>/state.json` and a distinct native session on restart.
  Extension instructions, echoed prompts, user messages, startup turns and
  truncated/error responses cannot prove provider success. A timeout must retain
  independently observed checks rather than claiming every check was false;
  cleanup must not hide the failure.
  A normal native tool result with structured public workflow `{ok:false}` is
  still a workflow failure even when `isError` is false; prose examples and
  unrelated tool results are not workflow refusals. Check the retained
  per-session `events_jsonl` links for narrowed native provenance after cleanup.
  Capability-bearing arguments/results must not be exported, and quoted or
  escaped token/nonce values in assistant text must remain redacted.
- Stop/cleanup ownership ambiguity: investigate the receipt and run scope. Refuse
  unsafe process cleanup rather than killing by name or fabricating an exit.
- A malformed fixture, generated check, or regex that fails to parse is a failed
  check. Correct the fixture/check, rerun it, and report both the original failure and
  the recovery; never overwrite the first result.

The repository's GitHub CI runs build, typecheck, and package tests on `ubuntu-latest`
with Node 20. Those checks do not prove process-level CLI or E2E behavior. Claim
Linux/CI coverage only after running the executable there and recording OS, Node,
`omp`, command status, and evidence paths. For manual web surfaces, use the approved
browser/terminal client with the private connection file and never print its token.

## 6. Report the tested boundary

For each case record the redacted command, executable/version, platform/runtime, cwd or
manifest/run/session scope, setup, exit status, parsed stdout/result, stderr, state and
artifact assertions, cleanup outcome, authentication mode, and known limitations.
For manual UX ratings supplied to `e2e:report --steps`, an omitted rating is
**unassessed**, never an inferred PASS. State explicitly whether the result is a unit
check, process CLI smoke, provider-free isolation, live provider smoke, or CI run.
Never include secrets, bearer URLs, private home paths, or raw unredacted transcripts.
