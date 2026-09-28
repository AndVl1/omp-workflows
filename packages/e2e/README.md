# @andvl1/omp-workflows-e2e

Manifest-backed, process-level UX acceptance for the installed **omp** runtime and the
current core/fullstack checkout. The harness snapshots the runtime and built package
closure, creates a disposable Git project, launches an isolated omp PTY, and records
run-scoped evidence. It does not install or relink the operator's plugins.

## Quick start

Run from the monorepo root with Node 20+, npm, a supported installed `omp`, and the
local package build dependencies available. Use one committed config throughout a
run; `prepare` resolves it to a secret-free manifest. Each root script builds the E2E
package before calling the same CLI.

When invoked through `npm run`, a config value of `runtime.binary: "omp"` selects
the installed host executable rather than npm's checkout-local
`node_modules/.bin/omp` shim. Set an absolute binary path in the config to pin a
specific runtime deliberately.

```bash
# Provider-free isolation (no OAuth or LLM request).
npm run e2e:prepare -- --config packages/e2e/scenarios/isolated-smoke.env.json --run isolation-01 --json
export OMP_E2E_ROOT="${OMP_E2E_ROOT:-${TMPDIR:-/tmp}/omp-workflows-e2e}"
MANIFEST="$OMP_E2E_ROOT/runs/isolation-01/manifest.json"
npm run e2e:doctor -- --manifest "$MANIFEST" --json
npm run e2e:verify -- --manifest "$MANIFEST" --suite isolation --json

# Real provider-backed smoke: requires the installed omp's existing OpenAI Codex
# OAuth authorization. Explicitly opts into a shared native host auth broker.
npm run e2e:prepare -- --config packages/e2e/scenarios/live-smoke.env.json --run live-01 --json
LIVE_MANIFEST="$OMP_E2E_ROOT/runs/live-01/manifest.json"
npm run e2e:auth-broker -- status --manifest "$LIVE_MANIFEST" --json
npm run e2e:auth-broker -- ensure --manifest "$LIVE_MANIFEST" --json
npm run e2e:doctor -- --manifest "$LIVE_MANIFEST" --json
npm run e2e:verify -- --manifest "$LIVE_MANIFEST" --suite live-smoke --json
```

`verify` generates a report and cleans run-owned secrets, process trees and workspace
by default; sanitized evidence and manifest remain. On failure, `--keep-failed`
retains the disposable workspace and sanitized evidence but still removes run-owned
auth caches. `verify` exits nonzero when a prerequisite or acceptance check fails;
successful cleanup cannot turn a failed smoke into a pass. The `live-smoke` scenario
submits a bounded `/do-work` request, waits for provider-backed semantic output and
canonical workflow state, stops that PTY, starts a second session, and checks the
state was preserved. It does not use a real project or an existing workflow run.

## Run-lifecycle acceptance journeys

The public registered `/do-work` journeys for OpenSpec run-lifecycle are described by
`scenarios/run-lifecycle-journey.json` and
`scenarios/run-lifecycle-resume.json`. These JSON files describe expected stages and
evidence patterns; their `*-task.md` files are operator checklists, not prompts for
the model. **Для live-приёмки запускайте каждую journey в чистой manifest-backed
сессии без `--scenario` и без `--task`; вводите каждую slash-команду вручную через
terminal PTY или `e2e:input`.** They use the existing PTY/WS harness, do not call
core APIs directly, and never ask the operator to edit canonical `.work-state` files.

Use one manifest for each journey and a distinct `--session-id` for every clean
session. Follow the manifest-based `prepare`, `doctor`, `start`, `input`, `ask`,
`transcript`, `stop`, `report`, and `cleanup` flow in Quick start and Manual
lifecycle below. Do not pass a scenario or checklist to the model as one prompt, and
do not pass a scratch path to any lifecycle command.

Prerequisites:

- Node.js 20 or newer, npm, a supported installed `omp`, and the repository's local
  package build dependencies.
- A committed E2E config, such as
  `scenarios/live-smoke.env.json`, supplied explicitly to `e2e:prepare`. The
  journey JSON files are evidence/checklist metadata; they are not `--scenario`
  inputs to the manifest CLI.
- For provider-backed journeys, explicitly run `e2e:auth-broker ensure` and
  `e2e:doctor` for the prepared manifest before the first slash command. Do not put
  credentials in config fixtures, transcripts, reports, or exported evidence;
  missing authentication must fail closed.
- **Preflight before the first slash command.** Inspect the started session evidence,
  not merely the configured role overlay, and stop unless every live role resolves to
  `openai-codex/gpt-6-luna` or `openai-codex/gpt-5.6-luna`. Sol/Astra resolution is
  invalid for this acceptance.
- Keep each journey's manifest and session IDs together. Do not copy or modify a
  manifest, reuse a run ID with changed inputs, or repair canonical state by hand.
- For the missing-input fixture, use a valid bounded workflow JSON and an exact
  classification/workflow override; vague task wording may resolve to a different
  lightweight profile. Remove temporary fixture profiles and wrappers after the
  evidence is captured.

### A → B → C → A journey

Prepare one manifest, make authentication explicit, and start a named session:

```bash
export OMP_E2E_ROOT="${OMP_E2E_ROOT:-${TMPDIR:-/tmp}/omp-workflows-e2e}"
npm run e2e:prepare -- \
  --config packages/e2e/scenarios/live-smoke.env.json \
  --run run-lifecycle-journey --json
MANIFEST="$OMP_E2E_ROOT/runs/run-lifecycle-journey/manifest.json"
npm run e2e:auth-broker -- ensure --manifest "$MANIFEST" --json
npm run e2e:doctor -- --manifest "$MANIFEST" --json
npm run e2e:start -- --manifest "$MANIFEST" --session-id journey \
  --surface text --detach --json
```

Drive the registered `/do-work` commands manually through the session, following
`run-lifecycle-journey-task.md`: create independent A and B runs, change branch
context for C, return to A, select by the displayed list when necessary, and verify
the expected rework and isolation receipts. For example, submit a command with the
manifest-selected PTY:

```bash
npm run e2e:input -- --manifest "$MANIFEST" --session-id journey \
  --text '/do-work --new "Экспорт отчётов A"' --json
```

Repeat the checklist commands through that same session. Use `e2e:ask` for any
pending `[ask_user]` interaction; never send the checklist or scenario JSON as the
task. Capture only the manifest-scoped, redacted evidence:

```bash
npm run e2e:transcript -- --manifest "$MANIFEST" --session-id journey --follow
npm run e2e:stop -- --manifest "$MANIFEST" --session-id journey --json
npm run e2e:report -- --manifest "$MANIFEST" --session-id journey \
  --copy-evidence --json
npm run e2e:cleanup -- --manifest "$MANIFEST" --json
```

### Fresh-session resume journey

Prepare a separate manifest for the resume journey. After the first session reaches
the saved decision, capture its report and stop it; then start a second clean session
against the **same manifest**, without the previous chat:

```bash
npm run e2e:prepare -- \
  --config packages/e2e/scenarios/live-smoke.env.json \
  --run run-lifecycle-resume --json
RESUME_MANIFEST="$OMP_E2E_ROOT/runs/run-lifecycle-resume/manifest.json"
npm run e2e:auth-broker -- ensure --manifest "$RESUME_MANIFEST" --json
npm run e2e:doctor -- --manifest "$RESUME_MANIFEST" --json
npm run e2e:start -- --manifest "$RESUME_MANIFEST" --session-id resume-1 \
  --surface text --detach --json
```

Drive the first session through `run-lifecycle-resume-task.md` until the decision
and required inputs are durably saved. Use `e2e:transcript`, `e2e:report
--copy-evidence`, and `e2e:stop` with `--session-id resume-1`, then restart:

```bash
npm run e2e:transcript -- --manifest "$RESUME_MANIFEST" \
  --session-id resume-1 --follow
npm run e2e:report -- --manifest "$RESUME_MANIFEST" \
  --session-id resume-1 --copy-evidence --json
npm run e2e:stop -- --manifest "$RESUME_MANIFEST" \
  --session-id resume-1 --json
npm run e2e:start -- --manifest "$RESUME_MANIFEST" --session-id resume-2 \
  --surface text --detach --json
```

The second session must resume by title/list without its previous chat and verify
required-evidence, pending-dispatch, and terminal-history guards. The same run-owned
workspace and canonical `.work-state` survive this restart, while session transcripts
remain distinct. Stop and report the resumed session, then clean up the run:

```bash
npm run e2e:transcript -- --manifest "$RESUME_MANIFEST" \
  --session-id resume-2 --follow
npm run e2e:stop -- --manifest "$RESUME_MANIFEST" \
  --session-id resume-2 --json
npm run e2e:report -- --manifest "$RESUME_MANIFEST" \
  --session-id resume-2 --copy-evidence --json
npm run e2e:cleanup -- --manifest "$RESUME_MANIFEST" --json
```

A live pass is **not** implied by scenario loading or package tests: run these
manifest commands after core/fullstack/internal integration and attach the resulting
transcript/report evidence.

## Subcommands

For a dedicated state location, set `OMP_E2E_ROOT` **before prepare and for every
subsequent command**. The default is `<system temp>/omp-workflows-e2e` (on macOS the
physical `/private/var` spelling may differ). Manifests are trusted only beneath that
root's `runs/<run-id>/manifest.json`; do not copy one to another root or modify it.
Unique run IDs avoid collisions. An unchanged `prepare` can reuse an existing run;
changed inputs under the same ID are a conflict, not a silent rebuild.

## Manual lifecycle and restart

```bash
export OMP_E2E_ROOT="${OMP_E2E_ROOT:-${TMPDIR:-/tmp}/omp-workflows-e2e}"
npm run e2e:prepare -- --config packages/e2e/scenarios/live-smoke.env.json --run manual-01 --json
MANIFEST="$OMP_E2E_ROOT/runs/manual-01/manifest.json"
npm run e2e:doctor -- --manifest "$MANIFEST" --json
npm run e2e:start -- --manifest "$MANIFEST" --session-id first --surface web --detach --json
# `start --json` returns a private connection_path, never its bearer URL.
# On macOS/Linux, open the first session locally without printing the token:
CONNECTION_FILE="$OMP_E2E_ROOT/runs/manual-01/private/sessions/first/connection.json"
node -e 'const fs=require("node:fs"),cp=require("node:child_process"); const url=JSON.parse(fs.readFileSync(process.argv[1],"utf8")).url; cp.spawn(process.platform==="darwin"?"open":"xdg-open",[url],{stdio:"ignore",detached:true}).unref()' "$CONNECTION_FILE"
# Type /do-work <task> and submit with Enter (PTY CR, not LF).
npm run e2e:transcript -- --manifest "$MANIFEST" --session-id first
npm run e2e:stop -- --manifest "$MANIFEST" --session-id first --json
npm run e2e:start -- --manifest "$MANIFEST" --session-id resumed --surface web --detach --json
# The same run-owned workspace and canonical .work-state survive this restart;
# transcripts and logs remain distinct per session.
npm run e2e:stop -- --manifest "$MANIFEST" --session-id resumed --json
npm run e2e:report -- --manifest "$MANIFEST" --copy-evidence --json
npm run e2e:cleanup -- --manifest "$MANIFEST" --json
```

The terminal server binds loopback, requires a session token, supports reconnect,
and replays bounded recent output to a late web client. `e2e:input -- --manifest
"$MANIFEST" --session-id first --text '/do-work <task>'` submits a command with
PTY Enter. `e2e:ask` handles a pending `[ask_user]`; `e2e:transcript` renders a
redacted session transcript. `e2e:stop` authenticates to the run-owned loopback
session server and lets the owner verify the process receipt, stop the PTY, and
persist the **observed** exit. An unreachable owner can only trigger a
receipt-verified recovery stop, which fails acceptance rather than fabricating
a clean exit; ambiguous ownership is refused. Never use `pkill`/`killall` or
target omp by name. `e2e:cleanup` is idempotent and cannot stop the shared
broker; inspect `--json` results rather than guessing whether a process was removed.
An owner-requested SIGTERM may appear as raw exit code `143`/signal `0` in
omp's PTY; the report recognizes only this observed, non-forced outcome with
matching ownership evidence and never rewrites it to exit code `0`.

| CLI subcommand | Required inputs | Purpose |
| --- | --- | --- |
| `prepare` | `--config <file> --run <id>` | Stage consistent source snapshot, package closure, runtime and disposable project. |
| `doctor` | `--manifest <file>` | Validate integrity, runtime capabilities, plugin signals and auth prerequisite. |
| `start` | `--manifest <file>` | Launch a session; optional `--session-id`, `--surface web\|text`, `--detach`. |
| `stop`, `input`, `ask`, `transcript`, `report` | `--manifest <file>` | Address the selected run/session, not a scratch path. |
| `verify` | `--manifest <file> --suite isolation\|live-smoke` | Executable acceptance with scoped report and cleanup. |
| `cleanup` | `--manifest <file>` | Remove only verified run-owned processes and private files. |
| `auth-broker` | `ensure\|status\|stop --manifest <file>` | Explicitly manage the native host broker, independent of run cleanup. |

All commands accept `--json`; errors include a machine-readable code and a nonzero
exit. The obsolete `bootstrap <scratch>`/`npm link`/host config overlay path is
not supported. `--steps <json>` for `report` supplies structured manual UX ratings;
otherwise the report is unassessed rather than a fabricated PASS.

## Authentication and host boundary

- `auth.mode: none` is **provider-free**. The harness still starts a real omp PTY
  with an offline model catalog and exercises plugin discovery; it does not call
  a model. Use the committed `isolated-smoke.env.json` for this check.
- `auth.mode: api-key-env` names provider environment variables in the config;
  the values must exist in the launching environment. Keys never go into the
  manifest, argv, report or exported transcript. Missing keys fail closed.
- `auth.mode: broker` targets an explicit operator-managed loopback endpoint
  with a bearer from the specified environment variable. Insecure/foreign
  endpoints fail closed; this mode does not start a broker.
- `auth.mode: native-host-broker` is **explicit opt-in** to the existing installed
  omp OpenAI Codex (`openai-codex`) or xAI (`xai-oauth`) authorization. The manager
  starts/reuses a single verified native broker bound to loopback for the host
  profile and passes its URL/token through the runtime's broker environment
  seam to isolated PTYs. It never copies the host auth DB or refresh token into
  a run and does not execute `omp token`, login, migrate, or credential rotation.
  The broker itself intentionally reads the host agent database and uses the
  native protected token file. `auth-broker stop` is a separate explicit action
  and refuses foreign listeners or live clients. Run cleanup does **not** stop it.

The broker coordinates clients using **that broker**. Ordinary omp clients that
independently read the host DB can still compete to refresh the same OAuth grant;
cross-process refresh single-flight has **not** been verified. Do not claim that
running broker and normal omp simultaneously is risk-free. This tradeoff applies
only when choosing `native-host-broker`. The smoke uses current authorization; it
must not rotate working credentials to test refresh. Provider quota/latency is
shared with the operator's normal sessions. The pinned model in the committed
live config must be available on that authorization; otherwise doctor/live smoke
fails rather than silently switching providers.

## Isolation and evidence

`prepare` snapshots the current working-tree source (including uncommitted edits),
uses package manifests to build immutable content-addressed core/fullstack and
runtime closures, and materializes writable run-private HOME, agent, XDG, temp,
package-manager and project roots. The project has its own `e2e/<run-id>` Git
branch. Child processes use an allowlisted environment, not the operator's
OMP/PI config, module paths, plugin directory, current project or workflow state.
The detached control worker has an explicit environment allowlist; only
manifest-declared auth variables and the selected native-broker host-profile
selectors are forwarded. Its PTY always runs with the run-private roots.
The native runtime snapshot is checked for supported version/capabilities before
launch. Artifact hashes and registered command observations are evidence; they do
**not** imply omp exposes a complete native extension inventory. Changed/tampered
artifacts or unrecognized runtime signals fail closed. Cold prepare builds and
caches; warm prepare reuses integrity-verified cache without a new install or LLM.

Every run records a manifest, separate session transcripts/logs, ownership receipts,
and a report under its evidence root. Text exports redact known credentials,
connection metadata, URL tokens and provider strings; copied evidence survives
cleanup. Binary screenshots are omitted from exports because pixels cannot be
reliably redacted without human review. The private per-session connection file
is not an exportable report artifact: treat its URL as a bearer secret. Report
results are observations of the current runtime, not proof of absence of all
host extensions. `doctor` and `verify` distinguish unsupported runtime,
missing auth and scenario failure; do not substitute unit fixtures for live proof.

This is **process/configuration isolation, not an OS sandbox**. An installed omp
binary or package build script executes with the host user's filesystem privileges;
the harness cannot defend against deliberately malicious native code or general
host filesystem access. Run only trusted revisions. The managed native broker is
the sole intentional host OAuth interface in the live config.
