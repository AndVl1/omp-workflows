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
#    Arbitrary command input (uses `\n`; for real PTY submit prefer `pressEnter()` / `\r` — see [Enter semantics](#enter-semantics-r-vs-n)):
node packages/e2e/dist/cli.js input /tmp/omp-ux-e2e-my-feature "/do-work implement it"

# 5. Inspect the session, then emit the report
node packages/e2e/dist/cli.js transcript /tmp/omp-ux-e2e-my-feature --tail 40
node packages/e2e/dist/cli.js report /tmp/omp-ux-e2e-my-feature \
  --steps steps.json --copy-evidence
```

Root convenience script: `npm run e2e -- <subcommand> …` (builds first).

## Run-lifecycle acceptance journeys

The public registered `/do-work` journeys for OpenSpec run-lifecycle are described by
`scenarios/run-lifecycle-journey.json` and
`scenarios/run-lifecycle-resume.json`. The JSON files describe expected stages and
evidence patterns; their `*-task.md` files are operator checklists, not prompts for
the model. **Для live-приёмки запускайте harness в чистой сессии без `--scenario` и
без `--task`; вводите каждую slash-команду вручную через terminal PTY.** They use
the existing PTY/WS harness, do not call core APIs directly, and never edit
canonical `.work-state` files.

Prerequisites (local operator setup only):

- Node.js 20 or newer and the repository dependencies installed.
- A built `omp` binary available as `omp` on `PATH`, or set `OMP_BIN` to its
  path.
- A host omp config with usable `modelRoles` and provider credentials. Do not
  put credentials in the scratch project, scenario files, transcripts, or
  reports; the harness inherits the host config and records only its path and
  a missing-config warning.
- A local checkout with the plugin wired by `bootstrap`; use a scratch
  directory, never this repository worktree, for branch changes.
- **Scratch-only scope setup.** `bootstrap` copies the repository
  `.omp/team.config.json`; the current map covers repository TypeScript/JSON
  paths, not arbitrary scenario JavaScript files. Before the first
  `workflow_prepare`, make every scenario `src/`/`test/` JavaScript path match
  the copied scratch `scope_map` (a `**/*.js`/exact `src`/`test` mapping resolves
  to `dev_agent: omp-engine-specialist`; a stale `packages/**/*.js` rule does
  not cover scratch `src`). Include the same paths in `workflow_prepare.files`.
  Resume preserves the scope persisted for the run; editing the map later does
  not repair that run. Keep this setup in the scratch project and never repair
  canonical `.work-state` by hand.
- **Preflight before the first slash command.** The role overlay is configuration,
  not proof of the active model: inspect the started session/host evidence before
  entering `/do-work` and stop unless every live role resolves to
  `openai-codex/gpt-6-luna` or `openai-codex/gpt-5.6-luna`. Sol/Astra resolution
  is invalid for this acceptance.
- **Neutral scratch ownership.** Use a branch-backed git scratch created by
  `bootstrap`, not a detached repository checkout. Do not inherit a competing
  project extension (for example, a monorepo `.omp/settings.json` explicit
  internal extension together with the harness fullstack bundle): that combination
  can produce an owner-token conflict. Keep one extension owner in the scratch.
- For the missing-input fixture, use a valid bounded workflow JSON and an exact
  classification/workflow override; vague task wording may resolve to a different
  lightweight profile. Remove temporary fixture profiles and wrappers after the
  evidence is captured; never repair canonical state manually.

Prepare and run the A → B → C → A journey:

```bash
npm run build -w @andvl1/omp-workflows-e2e
node packages/e2e/dist/cli.js bootstrap run-lifecycle-journey feat/run-lifecycle-a \
  --monorepo . --workdir /tmp --force
# Start a clean registered-command session; do not pass --scenario or --task.
node packages/e2e/dist/cli.js start /tmp/omp-ux-e2e-run-lifecycle-journey \
  --surface text --detach --max-time 90m
```

Drive the registered `/do-work` commands manually through the printed terminal URL
(or `ux-e2e input`/`ux-e2e ask`), following the operator checklist in
`run-lifecycle-journey-task.md`. Do not send that checklist or a scenario file to
the model as one prompt. Save evidence:

```bash
node packages/e2e/dist/cli.js transcript /tmp/omp-ux-e2e-run-lifecycle-journey --follow
node packages/e2e/dist/cli.js report /tmp/omp-ux-e2e-run-lifecycle-journey \
  --copy-evidence
```

Prepare the resume scratch once. After session 1 reaches the saved decision,
run `report --copy-evidence` and `ux-e2e stop`; then start **the same scratch**
again for session 2 without its previous chat. Both starts are clean registered
command sessions: omit `--scenario` and `--task`, and type the slash commands
manually into the new terminal PTY.

```bash
node packages/e2e/dist/cli.js bootstrap run-lifecycle-resume feat/run-lifecycle-resume \
  --monorepo . --workdir /tmp --force
node packages/e2e/dist/cli.js start /tmp/omp-ux-e2e-run-lifecycle-resume \
  --surface text --detach --max-time 90m
# after report + stop:
node packages/e2e/dist/cli.js start /tmp/omp-ux-e2e-run-lifecycle-resume \
  --surface text --detach --max-time 90m
```

Raw evidence is written automatically to
`<scratch>/.work-state/ux-e2e/{transcript.jsonl,session.json,detach.log}`;
`events.jsonl`/`session.jsonl` are included when the registered workflow emits
them, and the report records the newest host omp log when available. Reports
go to `./vibe-report/<slug>-ux-e2e-<date>.md` plus
`<scratch>/.work-state/ux-e2e/report.json`. When a scratch session is restarted,
the harness archives the previous raw transcript beside the current one; never
manually edit or delete those files. A live pass is **not** implied by scenario
loading or package tests: run these commands after core/fullstack/internal
integration and attach the resulting transcript/report paths.

## Reliable-stage: закреплённые H1/H2/H3

План `scenarios/reliable-stage-host-smoke.json` использует OMP **18.0.6**
и собранные candidate core/fullstack packages. Live cases запускаются только
после зелёных D/P; `validate` проверяет план, но не означает H PASS:

```bash
npm run host-smoke -w @andvl1/omp-workflows-e2e -- validate
npm run host-smoke -w @andvl1/omp-workflows-e2e -- prepare \
  --root <owned-root> --core <core.tgz> --fullstack <fullstack.tgz> \
  --model openai-codex/gpt-5.5
```
Подготовка передаёт один allowlisted environment установке, bootstrap и baseline
commit собственных scratch repos. Родительские `INIT_CWD`, `OMP_PROJECT_DIR`,
`npm_config_*`, `GIT_DIR` и `GIT_WORK_TREE` не выбирают каталоги записи:
пути HOME/cache/config и postinstall target принадлежат `<owned-root>`.
Проверяйте изоляцию с selectors, направленными только в собственный canary,
не в пользовательский repo.


Для запуска используйте binary из `runtime-manifest.json`, приватный
`HOME=<owned-root>/home` и `PI_CODING_AGENT_DIR=<owned-root>/agent-data`.
`PI_CONFIG_DIR` — имя каталога относительно HOME, а не абсолютный путь:
при запуске оставьте `.omp`, чтобы обнаруживались bootstrap project plugins.
Не наследуйте `OMP_PROFILE`/`PI_PROFILE` или пользовательские plugins.
`prepare` требует конкретный `--model <provider/model>` и создаёт приватный
host config `<owned-root>/home/.omp/agent/config.yml`: `default`, все встроенные
роли установленного SDK и aliases из фактически обнаруженных candidate agents
получают одну выбранную модель. Это включает `team-lead` и `cto`, которых нет
в полной таксономии `defaultFullstackModelRoles`; список не копируется вручную.
`<owned-root>/agent-data/config.yml` — symlink на тот же файл, чтобы root harness
и SDK children читали один источник. Пользовательские config/auth stores не
изменяются; обычный `ux-e2e start` сохраняет прежнее наследование профиля/config.

До `PREPARED` выполняется config-only проверка каждого scratch через установленный
SDK: `Settings.loadReadOnly` и настоящий model resolver должны разрешить каждую
роль и обнаруженного агента в выбранную модель. Проверка не создаёт SDK sessions,
не открывает auth DB, не вызывает модель и не расходует H-попытки.
`runtime-manifest.json` (`reliable-stage-host-smoke/runtime/v3`) фиксирует модель,
путь config и обнаруженные роли/agent count. Старые подготовленные roots и
evidence не перезаписываются. Конфигурационный PASS не означает H PASS:
при live-запуске всё ещё проверяйте фактически выбранные модели в host evidence.

На macOS дополнительно проверьте native PTY **до** H-попыток. У `node-pty` 1.1.0
Darwin prebuild может содержать `pty.node` без соседнего `spawn-helper`, хотя
install завершается успешно. Симптом — `posix_spawn failed` и `pid: null`,
а не ошибка выбора модели. Исправляйте только dependency в принадлежащем QA
snapshot, против той же версии Node, которой запускается E2E CLI:

```bash
npm_config_build_from_source=true \
npm_config_nodedir=<matching-cached-node-headers-dir> \
npm rebuild node-pty
```

Cached headers позволяют выполнить source rebuild offline. Затем нужен actual
PTY smoke с pinned wrapper `--version`, а не проверка наличия файлов.
Не заменяйте эту диагностику переключением модели или Node без rebuild.
Warning о missing `modelRoles` для quoted JSON-as-YAML key сам по себе не
доказывает отсутствие роли: authoritative здесь config-only SDK validation
и фактически выбранная модель в SDK session evidence.

Исходное хранилище credentials читается только read-only. Для Codex допустим
официальный static `api_key` в отдельном приватном SDK store, содержащий
неизменённый действующий access token: request adapter получает account identity
из самого JWT. OAuth rows/refresh tokens не копируются; истечение или 401
останавливает попытку без refresh fallback. Перед каждой 15-минутной попыткой
проверяется достаточный срок действия. Credentials не передаются в argv,
scratch, transcripts или evidence; приватный auth store удаляется после smoke.

Исторический бюджет составлял исходную попытку и один диагностированный повтор
на case; обе прежние попытки сохранены в evidence. После него отдельно проведены
два разрешённых tranche: по одной попытке H1/H2/H3 в каждом, затем отдельный
H3-only tranche для actual Hub proof. Во всех — максимум 900 секунд включая
startup и H3 restore, без automatic retry. Все бюджеты израсходованы `1/1`;
следующий запуск или retry требует нового явного разрешения.
Slash-команды вводятся через настоящий PTY по плану,
не через `--scenario`/`--task`. H3 восстанавливает pending checkpoint без
повторной реализации. Дополнительное наблюдение SDK cold revive использует
только настоящий persisted worker этого case: `ensurePersistedRoster` и
`AgentLifecycleManager.ensureLive` в новом host восстанавливают parked session,
не прежний executor, workflow grant или authoritative running status.
Новый prompt/task для доказательства revive не подставляется.
В закреплённом SDK 18.0.6 исходники Agent Hub задают default `Alt+A`
(`app.agents.hub`) либо `Ctrl+S` (`app.session.observe`); учитывайте overrides.
Для live-доказательства откройте именно Hub overlay, выберите строку исходного
parked worker, нажмите `r` и сохраните видимую строку и результат. Вызов `hub`
как model tool или обычный workflow resume этого доказательства не заменяет.
Поддержка в исходниках не считается runtime PASS и не доказывает `unsupported`.
У каждого case один deadline, начиная **до** startup; H3 restore получает
оставшееся время, не новый `15m`. Native `workflow_checkpoint_ask` может показать
selection dialog без `[ask_user]` transcript marker: проверяйте pending call,
current UI и matching result. Перед H3 restore исходный checkpoint не отвечается.
Hub row/`r`/result фиксируются **до** `/do-work --resume` и current approval.
Restore той же accepted child session может породить новый lifecycle started;
это само по себе не replay. Проверяйте отсутствие нового implementation
dispatch/assignment/submission и изменение accepted output hashes.
H3 terminal host action — intentional close собственного restored SDK host
после current approval и одного advance, не полный workflow complete/release.
Declared downstream review/QA не считается implementation replay. Full terminal/
release и новый ordinary tool обязательны для H1/H2, по actual event window.

Диагностика timed browser cleanup относится к отдельному эпику e2e harness,
а не к дополнительному product gate `reliable-stage-execution`. Если проверяется
именно bounded cleanup harness, не подменяйте его proof успешным
`agent-browser close`: в CLI 0.17 manager close ожидается, но ошибки подавляются;
daemon/socket exit отложен на 100ms после ответа. Immediate `session list` может
ещё содержать имя — это не proof browser liveness. Для этой диагностики сохраняйте
actual owned browser PID/named-registry absence с timestamp до immutable deadline.
Поздняя подтверждённая очистка — eventual, не ретроспективный PASS timed proof.
Отсутствие такого timestamp не отменяет подтверждённые H-события и фактически
выполненный общий owned cleanup исходной спеки; исходные NOT_VERIFIED сохраняются.

Останавливайте только собственные sessions через существующий `stop`;
`host-smoke cleanup --root <owned-root>` сохраняет evidence.

## Приёмка host admission

Сценарий [`host-admission.json`](scenarios/host-admission.json) и
операторский [`host-admission-task.md`](scenarios/host-admission-task.md)
покрывают обычные `bash`/`write`/`edit`, selected workflow, native worker,
terminal/restart, CTO, неполную регистрацию bundle, диагностику отказов,
границы host-контекста, recovery повреждённого run и internal activation.

Это **ручной checklist, не prompt модели**: стартуйте независимые scratch
sessions без `--scenario` и `--task`. Перед первым заданием подтвердите
фактическую Luna-модель host/worker и единственного владельца workflow.
Отрицательные fault fixtures разрешены только в disposable scratch;
их результаты не заменяют проверки настоящего foreign host context.
Совпадения `expect` — подсказки наблюдения, не автоматический PASS.
Отчёт обязан отдельно перечислять PASS/FAIL/BLOCKED для A1–A9,
runtime evidence и cleanup. Недоступное внешнее Android-окружение
нельзя объявлять проверенным по результатам локального fullstack.

Первый live-прогон описан в
[отчёте PR #72](../../vibe-report/host-admission-pr72-manual-qa-2026-09-29.md):
5 PASS, 2 FAIL, 2 BLOCKED. Наличие сценария не означает зелёную приёмку;
открытые workflow/CTO и shutdown-проблемы перечислены в отчёте.

## Subcommands

| Command | Purpose |
|---|---|
| `bootstrap <slug> <branch>` | Create `<workdir>/omp-ux-e2e-<slug>` (default `/tmp`), `git init`, wire core/fullstack with scratch-local symlinks (no global npm/plugin mutation), write `.omp/ux-e2e-overlay.json`, copy `.omp/team.config.json`, materialize custom-TS commands. `--force` re-creates. |
| `start <scratch-dir>` | `startTestSession()` + print the terminal URL. Foreground mode prints live `[ask_user]` hints and exits when omp exits; `--detach` runs the session in a **detached child that survives the parent** — the child writes its stdout/stderr directly into `<scratch>/.work-state/ux-e2e/detach.log` via an inherited file descriptor (no pipe between parent and child, so the child cannot crash with EPIPE when the parent exits). The parent tails the last 8 KiB on the 15 s startup timeout so failures are not swallowed. `--scenario`, `--task`, `--surface web\|text`, `--cols/--rows/--port`, `--max-time`, `--idle-ms`. `--force` allows relaunch over a live session. Honours the optional user-supplied overlay at `<scratch>/.omp/ux-e2e-overlay.user.json` (see [User-supplied overlay](#user-supplied-overlay)). |
| `stop <scratch-dir>` | SIGTERM → SIGKILL the recorded process tree (see session.json `pid`). |
| `transcript <scratch-dir>` | Render transcript.jsonl as text; `--tail N`, `--follow`. |
| `input <scratch-dir> <text>` | Unconditionally sends `<text>\n` in ONE `{t:'i'}` frame, without requiring a pending `[ask_user]` prompt. **Prefer `pressEnter()` (`\r`) for real omp submit** — `submit()` (`\n`) is a legacy text-mode helper; see [Enter semantics](#enter-semantics-r-vs-n). |
| `report <scratch-dir>` | `generateReport()` → `<scratch>/.work-state/ux-e2e/report.json` + `<mdDir>/<slug>-ux-e2e-<date>.md` (default `./vibe-report`). `--steps` supplies structured ratings; `--copy-evidence` mirrors evidence files. |

## Session hygiene & safe stopping

Stop sessions **only** through `ux-e2e stop <scratch>` (or the equivalent
`npm run e2e -- stop <scratch>`). The command reads the session PID from
`<scratch>/.work-state/ux-e2e/session.json`, verifies that the live process
belongs to that scratch session, then sends SIGTERM and (after the grace
period) SIGKILL to its process tree. If the PID is stale or belongs to another
process, stopping is refused rather than risking an unrelated session.

**Never** use `pkill`, `killall`, or `kill` by a process name or pattern (for
example `omp` or `bun`). Those commands can terminate omp sessions belonging
to other terminals or users. `start --force` already resolves a live session
for the requested scratch directory; manual process cleanup is not needed.

When the recorded PID is no longer running, `ux-e2e stop` reports that state
and leaves the rest of the host untouched.

## Architecture

- **`src/server.ts`** — `startTestSession()`: loopback-only HTTP+WS server,
  session-scoped 256-bit token (constant-time compare), Origin (if present) /
  Host checks, `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer`, strict
  CSP, per-connection rate limit, idle timer, SIGTERM → SIGKILL process-tree
  kill, 64 KiB max frame. Closing a WS only detaches that client; the PTY stays
  alive for reconnect until `session.close()`, idle timeout, or PTY exit. Vendored static routes
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
  markdown. Defect floors: CRITICAL→1, HIGH→2, MEDIUM→3, LOW→4; ratings are
  clamped and warnings are emitted.
- **`src/cli.ts`** — thin `node:util parseArgs` dispatch over the seven
  subcommands. `--detach` spawns the child with an inherited file descriptor
  for stdout/stderr pointing at `detach.log` (no parent-side pipe — the
  child outlives the parent without an EPIPE crash) and tails the log on
  the 15 s startup timeout.

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

Upgrade path: `/ws?token=<session-scoped-token>`. The token remains valid for

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
3. Drive the terminal as a human: type `/do-work <task>`. The toolbar at
   the bottom of the page has an **⏎ Enter** button (`window.__pressEnter()`)
   that emits a real Enter keypress — use it whenever the TUI is waiting
   for input and you would press Enter at a real keyboard.
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
- `--detach` runs the session in a detached child whose stdout/stderr are
  captured to `<scratch>/.work-state/ux-e2e/detach.log` via an inherited
  file descriptor (no pipe between parent and child — the child
  **outlives the parent** and is only stopped via `ux-e2e stop <scratch>` or
  `--max-time` expiry). The parent surfaces the log tail on the 15 s
  startup timeout.
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
      — sends the command plus a trailing LF (`\n`). For real PTY submit
      (omp editor maps `\r` → submit) use `pressEnter()` instead; see
      [Enter semantics](#enter-semantics-r-vs-n).
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
      — sends the command plus a trailing LF (`\n`). For real PTY submit use `pressEnter()` (`\r`); see [Enter semantics](#enter-semantics-r-vs-n).
    - **Throttle typing** — use `delay ≥ 150 ms` per character on
      `page.keyboard.type(...)` (200 ms was observed safe in a live run).
    - **Send whole prompts in one frame** rather than per-char keystrokes.
  Do not raise the limit without review; it protects the PTY from a runaway
  client, and a disconnected client can safely reconnect.

## License

MIT — see the repository root LICENSE. Security/PTY patterns ported from
`@pi-harness/web-terminal` (MIT).
