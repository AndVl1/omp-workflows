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

## 5. Diagnose without erasing evidence

- Help/argument failure: preserve the nonzero result, consult `--help`, correct the
  missing positional or flag, and rerun as a separate attempt.
- Mixed or invalid JSON: inspect the separately captured streams and the command's
  documented `--json` contract; never trim diagnostics into a false JSON pass.
- Missing generated state or index: run the CLI's documented prepare/rebuild command,
  retain the initial failure, and rerun only after the prerequisite succeeds.
- PTY hangs or an apparently successful submit: inspect session/transcript evidence,
  use CR or `e2e:input`, and do not count echoed input as command/model execution.
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
