# Workflow Profiles

Declarative workflow definitions consumed by the `/team` interpreter. Each profile is a
JSON file describing an **ordered list of stages**. The interpreter does not "decide" the
workflow from prose — it resolves a profile from the classification, then walks the stages
mechanically. Same classification → same stage sequence.

> **Why this exists**: previously the entire workflow lived as prose in `commands/team.md`
> and the orchestrator interpreted it freely, so borderline tasks took different paths on
> different runs. Profiles turn the workflow into **data** (harnest-style stage taxonomy).
> See `vibe-report/determinism-research-2026-06-06.md` for the rationale (P1).

> **v0.4.0+ shipping model.** The `/team` command lives as an OMP custom-TS command in
> `packages/fullstack/commands/team/index.ts`. It parses the envelope, classifies the task,
> and returns a prompt the main OMP agent runs through its own `task` tool. The custom-TS
> command does NOT drive subagent dispatch itself — that surface is owned by the main agent
> in OMP 17.x. The interpreter loop in `engine/{stage,run}.ts` is invoked by the main agent
> via `createTaskCaller(TaskTool)` for every `single` / `consilium` stage.

## Контракт жизненного цикла

Профиль описывает порядок стадий, но не выбирает запуск по наличию state или имени ветки. Host ingress явно различает `new`, `resume` и `rework`; `/do-work` и `/team` используют один и тот же `workflow_prepare` и общий selected context.

```text
/do-work --new Добавить экспорт отчётов
/do-work продолжи экспорт отчётов
/do-work --resume
/do-work --rework Исправить экспорт отчётов
/do-work --list
```

UUID не нужен для обычного new/resume/rework: имя или пункт read-only списка сначала разрешается в точный `run_id`, затем `workflow_prepare` повторно проверяет target под lock. `--run <run-id>` остаётся явным техническим selector; неоднозначность возвращается пользователю и не разрешается по времени изменения. Результат перехода показывает operation, предыдущий и выбранный run, названия, статусы и continuation point; `run_busy` означает, что переход не опубликован.

`resume` в новой сессии читает canonical schema-2 state и обязательные artifacts через `workflow_instructions` до зависимого dispatch: task, classification, cursor, pause, решения, ограничения и provenance не берутся из старого чата. `recovery_required` блокирует действие при отсутствующем/невалидном required input; pending или succeeded dispatch не повторяется. `rework` создаёт immutable revision snapshot, инвалидирует затронутые downstream outputs и сохраняет допустимые upstream results.

Ordinary identity — `run_id = run_key = WorkIdentity.run_id`; branch остаётся контекстом маршрутизации и проверки, но не identity. На другой ветке создаётся новый независимый run, а resume/rework старого run отклоняются как `run_context_mismatch`. В одном физическом worktree действует один execution claim: живой или неизвестный coordinator/worker возвращает `run_busy`, а смерть coordinator не считается завершением workers.

После consumer cutover legacy state и прежний `continuation` являются только import boundary. Неизвестная schema, повреждённая migration-транзакция или активный legacy dispatch возвращают `migration_required`, `recovery_required` или `run_busy`; старый marker не становится authority и не выбирается как fallback. Lifecycle journal восстанавливается до следующей мутации: до canonical commit возможен rollback staging, после commit — только forward repair с сохранением mapping. Не удаляйте marker и не редактируйте canonical state вручную.

Status/report/view используют один canonical run/revision reader. `/workflow-view` и `/session-report` доступны для выбранного canonical run/revision; legacy/latest/slug selection возвращает явную migration guidance или `canonical-unavailable`, а не legacy fallback. Если для нового формата недостаточно локального reader-подключения, viewer отключается только для этого входа с переходом к text status/report; полная переработка UI или graph model остаётся будущим scope.

Пользовательская справка и точные флаги находятся в [`core README`](../README.md) и [`fullstack command guide`](../../fullstack/README.md).

## CTO exact-run lifecycle

The registered `/cto` ingress acquires a host-owned claim before rendering a
prompt. `/cto --run <exact-cto-id> <task>` is an exact selector, not ownership
proof: branch, session, process and ownership-epoch provenance are checked under
the workspace lock, and no latest-active scan is used.

On continuation, read canonical state only through the registered
`cto_state(operation: "read", run_id: "<exact-cto-id>")` route. Read answer and
escalation records only from that exact run's scoped namespace; never scan a
sibling or latest-run directory.
Retry at most once only for a persisted `delivery_status: "pre-send-rejected"` record whose run, ownership epoch and session match the
current claim. `accepted`, `in-flight`, `unknown`, legacy or mismatched
delivery stays advisory/recovery evidence; it must not be blindly replayed.
Transport-only answer markers do not authorize a retry. Corrupt or markdown-only legacy state fails closed.

Managed release provenance keeps the issuance state witness unchanged; core
does not rehash arbitrary writes made while a CTO run is suspended. An
unexplained state-image mismatch remains `recovery_required` with persisted
bytes untouched. The supported host shutdown event is type-only and belongs to
actual disposal; replacement uses the authenticated `session_switch` event,
not a fabricated old-session field on shutdown.

## Files

| File | Purpose |
|------|---------|
| `_schema.json` | JSON Schema for a profile (stage taxonomy, fields). |
| `artifacts-schema.json` | Typed handoff contracts written under the selected run's `artifactsDir` (normally `.work-state/runs/<run-id>/artifacts/`) (P2). |
| `<name>.json` | One profile per workflow. |
| `stages/<id>.md` | Per-stage prompt templates / criteria, **loaded on demand** by the interpreter (P9). The file name equals the stage `id`. Keeps `commands/team.md` lean — it holds only governance; the "how" of each stage is read only when that stage runs. |
| `cto.json` | CTO sub-orchestration profile (explicit `/cto` only — `match.type` is `[]`, never auto-selected). Stages: discovery → decomposition → teams (`type: team`, filled from `.omp/teams.json`) → integration review → summary. |
| `teams.example.json` | Example TeamDef registry (`id, name, scope, profile, lead, roster`). Consumers copy it to `<project>/.omp/teams.json` to register their development teams for `/cto`. |

> **Canonical work-state paths.** Runtime lifecycle readers resolve the selected ordinary
> run from `.work-state/runs/<run-id>/state.json` and its `artifacts/`/`revisions/`
> children. `.work-state/.active-feature`, legacy feature directories, and
> `.work-state/team-state.json` are import-only inputs; they are not runtime selectors
> or a fallback authority after cutover.

## Stage taxonomy (`stage.type`)

Borrowed from harnest. Every stage is exactly one of:

| type | meaning |
|------|---------|
| `orchestrator` | Main context performs it directly (no subagent). E.g. discovery, summary, clarifying questions. |
| `single` | Exactly one subagent. Role resolved via `.omp/team.config.json` (fallback: legacy `.claude/team.config.json`) or file scope. |
| `consilium` | N subagents in parallel. With a `roster_policy` the role list is an allowed pool (see **Roster policy** below); legacy `roles[]` stays an exact manifest. |
| `document` | Deterministic engine-rendered document (see the `document` field: format/renderer/path). No model, no dispatch — the engine renders at the advance boundary. The shipped product PRD is human-first: executive summary, detailed product direction, then critique/evidence/problem framing/intake and metadata; rendering stays deterministic and engine-owned. |
| `bash` | Deterministic shell step, no model. |
| `none` | Placeholder / skip. |

## Profile resolution (deterministic)

Classification (`type` + `complexity`) selects exactly one profile. Profiles are tested in
**selection order** below; the **first** profile whose `match` passes wins. A `match` passes
when `classification.type ∈ match.type` AND (`classification.complexity ∈ match.complexity`
OR `match.complexity` is absent).

**Selection order:**

1. `full-feature`
2. `debug-cycle`
3. `bug-fix`
4. `standard`
5. `lightweight`
6. `research`
7. `lecture-research`
8. `product-discovery`
9. `spec-preparation`
10. `feature-regression`
11. `review`
12. `emergency`

Resulting table (every Type × Complexity resolves):

| Type | QUICK | MEDIUM | COMPLEX | CRITICAL |
|------|-------|--------|---------|----------|
| FEATURE | lightweight | standard | full-feature | full-feature |
| REFACTOR | lightweight | standard | full-feature | full-feature |
| OPS | lightweight | standard | standard | standard |
| BUG_FIX | bug-fix | debug-cycle | debug-cycle | debug-cycle |
| INVESTIGATION | research | research | research | research |
| LECTURE_RESEARCH | lecture-research | lecture-research | lecture-research | lecture-research |
| REVIEW | review | review | review | review |
| HOTFIX | emergency | emergency | emergency | emergency |
| SPEC | spec-preparation | spec-preparation | spec-preparation | spec-preparation |
| REGRESS | feature-regression | feature-regression | feature-regression | feature-regression |
| PRODUCT_DISCOVERY | product-discovery | product-discovery | product-discovery | product-discovery |

**Fallback**: if no profile matches (e.g. a custom type), the interpreter uses `standard`.

**Autonomous override**: in autonomous mode, every `BUG_FIX` uses `debug-cycle` regardless
of complexity (the diagnostics ↔ manual-qa loop is how a hypothesis is formed without a human).

### Product discovery vs specification

`PRODUCT_DISCOVERY` and `SPEC` are deliberately distinct first-class intents:

- **`product-discovery`** answers **what to build and why** — product-level only. It is
  evidence-first (every claim is `verified | assumption | unknown` with a source), never
  touches application code, and always ends in an **interactive product-owner approval**
  (`product_approval` checkpoint, decision exactly one of
  `proceed | needs_more_validation | defer | reject`, recorded via `workflow_checkpoint`
  with `mode=interactive` — no inferred consent, no auto-approval). Because the decision is
  always human-made, **autonomous product discovery fails closed**: a `PRODUCT_DISCOVERY`
  classification with `autonomous=true` is rejected at the classification gate.
- **`spec-preparation`** answers **how to build it** — it turns a confirmed direction (a
  `product_spec` handoff from an approved discovery, or a standalone SPEC request) into an
  implementation-ready specification with requirements, options, architecture slices, and a
  completeness gate. Its intake stage optionally consumes `product_spec` as approved product
  context; the absence of that artifact never blocks a standalone SPEC.

**Dedicated research intent:** `LECTURE_RESEARCH` (one public video/playlist URL plus a
natural-language prompt) is a first-class type DISTINCT from generic `INVESTIGATION` →
`research`. The URL is the only user content prerequisite: no transcript, captions, recording,
notes, or media file is requested. It resolves to `lecture-research` at EVERY complexity and
autonomy and is never routed to an implementation profile (research-only, human approval gate).

This table is mirrored in `hooks/validate-state.sh` (P5) — the classification gate blocks
launching agents if `team-state.json`'s `workflow` does not match its `classification`.

## Lecture research workflow (`lecture-research`)

Dedicated URL-first, research-only profile for semantic type `LECTURE_RESEARCH`. It turns one
public video/playlist URL plus a natural-language prompt into bounded, evidence-grounded,
verifiable findings — **never into code**. Provider/API setup is owned by the consumer that
registers `lecture_acquire`; core declares the boundary and does not fetch URLs.

**Deterministic resolution.** `resolveWorkflow("LECTURE_RESEARCH", <any complexity>, <any
autonomous>) === "lecture-research"` — one profile for the whole type, regardless of complexity
or autonomy. It is a first-class intent DISTINCT from generic `INVESTIGATION` → `research` and
ends at an explicit human approval gate.

**Stages** (the exact stage list, gates and checkpoint definitions live in
`lecture-research.json`):

1. **URL-first intake** (orchestrator) — extract exactly one public video/playlist URL and the
   non-empty research prompt. Record `lecture_intake` with acquisition-pending provenance. Do not
   ask for a transcript or other source material; no network access or summarization yet.
2. **Automatic acquisition** (orchestrator) — invoke the consumer-provided main-session
   `lecture_acquire` tool and persist `lecture_acquisition`. The tool resolves bounded sources,
   normalizes timestamped evidence, and preserves failures. Only `succeeded` or evidence-bearing
   `partial` acquisition advances; failed/missing acquisition stops the workflow.
3. **Lecture mapping** (consilium, bounded parallel roster) — consume only normalized
   `lecture_acquisition` evidence; **perform no network access, URL fetching, or provider calls**.
   Every URL-derived unit retains human-readable evidence and adds structured `evidence_refs`
   (source, canonical location, quote, start/end timestamps). Produces `lecture_mapping`.
4. **Synthesis & dedupe** (single `analyst`) — merge overlapping claims across sources, record
   conflicts explicitly with the winning source and losing sources/claims, and produce deduplicated
   candidate findings. Preserve partial-acquisition failures and gaps. Produces `lecture_candidates`.
5. **Repo fit & security review** (consilium, parallel, read-only) — `architect` checks candidate
   claims against the codebase with concrete repo evidence; `security-tester` reviews security and
   IP/licensing risks. No fixes or edits. Produces `lecture_repo_fit`.
6. **Approval** (orchestrator, explicit human checkpoint) — pause, record the verdict, and complete
   on either explicit `approved` or `rejected`. No implementation, task creation, or code work
   starts before approval; approval never launches implementation. Produces `lecture_decision`.

**Artifacts.** Every stage writes typed artifacts under the selected run's `artifactsDir`
(`.work-state/runs/<run-id>/artifacts/` for canonical runs) per `artifacts-schema.json`:
URL intake, provider-neutral acquisition, evidence-grounded mapping, synthesis with
conflicts, repo-fit/security findings, and the explicit decision. The profile never produces
source code.

**Acquisition boundary.** Core cannot auto-acquire by itself. A consumer must register
`lecture_acquire` (or route direct `core.run()` orchestration through `LectureAcquisitionPort`).
Provider credentials, rights, and API configuration are installation concerns, never task UX.
If the tool/provider is unavailable, fail closed; do not ask the user to prepare a transcript.

**Human gate.** Approval is the terminal decision point: the run waits for an explicit human
decision before anything beyond findings is allowed. Neither decision path starts implementation —
implementing an approved finding is a NEW task with its own classification, workflow, and DoD.

**Entry points.** Both `/do-work` and `/cto` route through the same classification contract and
matrix — there is no new slash command. `/do-work` classifies the task (PHASE-0 type
`LECTURE_RESEARCH`), resolves the profile deterministically and walks it stage by stage. `/cto`
resolves per-slice workflows from the same matrix: a `LECTURE_RESEARCH` slice is staffed with
the profile's research-only roster — `analyst`, `tech-researcher`, `diagnostics` for the
parallel lecture mapping, then `architect` + `security-tester` for the read-only repo-fit and
security review — keeps provenance/timecoded evidence, and ends at the human approval gate — no
implementation before approval. Both surfaces resolve the current stage through the opaque
workflow-tools contract (`resolveWorkflowContract` / `resolveStageInstructions`), which
validates persisted state, profile hash and dispatch capability before any stage runs.

## Interpreter contract (how `/team` walks a profile)

1. **Classify** the request → emit a structured `CLASSIFICATION` block → call
   `workflow_prepare` so the selected canonical run is persisted before launching any agent.
2. **Resolve** the profile from the table above; load `workflows/<name>.json`.
3. For each stage in order:
   - **skip** if `skip_if` evaluates true.
   - **read** every artifact id in `consumes` from the `artifactsDir` returned by
     `workflow_instructions` and thread relevant content into subagent prompts (no pasted prose — P2).
   - **run** per `type`: orchestrator (inline), single (one Task), consilium (parallel Tasks),
     document (engine render at advance), bash (shell), none (skip). For `consilium`, apply `conditional[]` against scope flags to
     adjust the roster.
   - **resolve roles → agents**: agent name from `.omp/team.config.json` `roles` (P6), falling back to built-in defaults and legacy `.claude/team.config.json`. Model capability is set by agent frontmatter and OMP policy — low-tier agents use `@smol` + `thinkingLevel: medium`, middle-tier use `@task` + `thinkingLevel: auto`, high-tier use `@slow` + `thinkingLevel: high`. Concrete models are configured via OMP `modelRoles` or `task.agentModelOverrides`, not in workflow config.
   - **checkpoint**: follow the declared typed checkpoint policy; interactive answers enter through `workflow_checkpoint_ask`. Routing/autonomy metadata never authorizes a checkpoint.
   - **gate**: do not mark the stage `done` until the gate condition holds.
   - **write** the `produces` artifact to the selected run's `artifactsDir`.
   - **loop**: if the stage has a `loop`, repeat `back_to` until `until` or `max_iterations`.
   - **advance** the selected run's `stage_cursor` and mirror progress only through the configured run reader.

The prose phase descriptions in `commands/team.md` remain as a **STAGE REFERENCE (fallback)** —
the detailed prompt templates and review criteria live there. Profiles drive *which* stages
run and *in what order*; the reference supplies the *how* for each stage type.

### Необязательные входы и required-input receipt

`consumes` остаётся обязательным входом: его отсутствие или ошибка блокирует зависимый dispatch. `optional_consumes` означает только «прочитать, если уже существует»:

- действительно отсутствующий optional artifact не блокирует стадию, не создаёт `required_input` receipt и не может заменить обязательный input;
- существующий target читается как exact bytes после проверки безопасного path под выбранным `artifactsDir` и JSON/schema artifact contract; `sha256` вычисляется для exact-byte optional context, без сравнения с ожидаемым persisted hash и без выдачи required-input receipt;
- существующий, но invalid, dangling или unsafe target даёт `recovery_required` и блокирует dispatch — его нельзя выдать за отсутствие;
- persisted `required_inputs` остаётся authority: объявление `optional_consumes` не ослабляет, не удовлетворяет и не переписывает этот обязательный manifest. `optional_input_contents` передаётся только как дополнительный контекст. Поэтому standalone `SPEC` остаётся валидным без optional `product_spec`.

### Trusted native Task boundary

Полномочие native `Task` worker выдаёт только host, а не текст задачи. Точная process-local binding строится по цепочке `authorized parent request → matching execution event → lifecycle sessionFile → real SessionManager + exact child header/session id + canonical cwd`. `matching tool_execution_start` подтверждает тот же запрос; `lifecycle.id` не является UUID child-session header. Перед каждым защищённым вызовом host повторно проверяет актуальность manager, `sessionFile`, header и `cwd`, а также canonical authority dispatch/run.
Accepted TCB boundary: already-loaded extensions are trusted host code and are not sandboxed against their JS/process/FS capabilities; prompt/tool arguments and foreign sessions remain untrusted and cannot create this binding.

Binding worker не разрешает вложенную делегацию: worker не вызывает `Task` для redelegation. `team-lead` может действовать только в уже выданном том же CTO `run`/`slice`; copied marker, `hasUI`, raw `actor`, prompt/arguments или чужая session сами по себе полномочий не создают. `write_scope`, если включён consumer-ом, только сужает уже разрешённый доступ и никогда его не расширяет.

Registry binding process-local. После перезапуска worker grants не восстанавливаются; durable `pending`/`transport_reconnect` и captured result origin позволяют точно reconcile прежний dispatch, но не являются полномочием на запись source и не синтезируют новый `Task` поверх pending.

### Защищённый artifact-proof Bash

Это единственное Bash-исключение в данном контракте: доверенный host artifact proof разрешает только bounded read-only Git inspection. Поддерживаются две кодировки `command`; это не два взаимоисключающих транспорта:

1. Inline canonical encoding начинается с `GIT_OPTIONAL_LOCKS=0 git --no-pager -c core.fsmonitor=false ...`. У такого `command` `env` может отсутствовать или быть ровно собственной plain одноключевой строковой map `{GIT_OPTIONAL_LOCKS: "0"}`:

   ```bash
   GIT_OPTIONAL_LOCKS=0 git --no-pager -c core.fsmonitor=false ...
   ```

2. Non-inline encoding начинается с `git --no-pager -c core.fsmonitor=false ...` и требует ровно той же map `env`:

   ```json
   {
     "command": "git --no-pager -c core.fsmonitor=false branch --show-current",
     "env": { "GIT_OPTIONAL_LOCKS": "0" }
   }
   ```

Для non-inline encoding omitted `env` отклоняется; wrong/extra/malformed `env` отклоняется в обоих случаях.

Allowlist содержит только read-only `status`, `log`, `diff`, `show` и ровно `branch --show-current`; `switch`, `checkout`, другие режимы `branch`, неподдержанные extra args, helper/wrapper, mutation и injection блокируются.

Примеры inline form с отсутствующим `env`:

```bash
GIT_OPTIONAL_LOCKS=0 git --no-pager -c core.fsmonitor=false status --short
GIT_OPTIONAL_LOCKS=0 git --no-pager -c core.fsmonitor=false log -1 --oneline
GIT_OPTIONAL_LOCKS=0 git --no-pager -c core.fsmonitor=false branch --show-current
GIT_OPTIONAL_LOCKS=0 git --no-pager -c core.fsmonitor=false diff --no-ext-diff --no-textconv -- src/app.ts
GIT_OPTIONAL_LOCKS=0 git --no-pager -c core.fsmonitor=false show --no-ext-diff --no-textconv --stat HEAD
```

Для `diff` и `show` обязательны оба флага `--no-ext-diff` и `--no-textconv`. Это правило относится только к protected artifact-proof context и не переписывает обычные terminal/code-reviewer инструкции.

## Definition of Done (acceptance gate)

Profiles with an implementation phase produce a `dod` artifact early (exploration / discovery /
diagnose) and put `gate: dod_complete` on the `summary` stage. The DoD fixes acceptance criteria
*before* code, each with a verification method and (on close) proof. See the **DEFINITION OF
DONE** section in `commands/team.md` for the policy and per-type minimums.

Enforcement is two-layered and **never wedges the session**:
- **Primary**: the `dod_complete` gate (interpreter) and `root_cause_documented` gate (BUG_FIX,
  before implementation).
- **Backstop**: `hooks/dod-gate.sh` (Stop) reads the typed `dod` artifact from the selected run's
  `artifactsDir`, not from a branch-derived or legacy path. It blocks (exit 2) **only at a
  done-claim** — `pause.kind == "done"` or `stage_cursor == "summary"` — with unmet or
  evidence-less items.

Stop is always allowed (no DoD enforcement) when: `pause.kind` ∈
`background_wait | user_checkpoint | needs_human | failed`; the workflow is
`research` / `review` / `emergency`; the state is stale (`branch` ≠ current); or
`.work-state/.dod-override` exists. `research`/`review`/`emergency` profiles intentionally
omit the `dod`/`dod_complete` stages.

## Scope flags (used by `conditional` and `${scope.*}`)

Resolved from touched/planned files against `.omp/team.config.json` `scope_map` (fallback: legacy `.claude/team.config.json`). Run **`/init-team`** to generate that file for your project — it detects the stacks and maps each to the best available agent, including agents from other installed plugins (e.g. `rust-agents` for a Rust repo). This is the former P3. Without a config, the interpreter falls back to inferring scope from file globs using the built-in defaults below:

> **`scope_map` precedence — first match wins.** Entries are evaluated top-to-bottom; the first
> glob that matches a file decides its scope. Order specific paths above generic extensions. In
> particular `mobile` is listed **above** `backend-kotlin`: a KMP file like
> `shared/src/commonMain/Foo.kt` matches both `**/commonMain/**` (mobile) and `**/*.kt`
> (backend-kotlin), and resolves to **mobile** only because mobile comes first. So `**/*.kt`
> routes to `backend-kotlin` only when the file is **not** under a mobile source set (e.g. a
> Spring `src/main/kotlin`). `scope` names are free-form (project-defined by `/init-team`).

| flag | true when |
|------|-----------|
| `scope.has_security` | touches `**/auth/**`, `**/security/**`, `**/*crypto*`, or auth/secret logic (config `flags`) |
| `scope.has_ui` | a matched scope is marked in the config's `scope_ui_classes` (fullstack preset: `frontend`, `mobile`) or its class is `"ui"` |
| `scope.has_runtime` | a matched scope is classified runnable via entry `runtime_class` or config `scope_runtime_classes` |
| `scope.has_infra` | touches Docker/K8s/CI/CD/Helm (config `flags`) |
| `${scope.dev_agent}` | the `dev_agent` of the dominant matched scope; **fails closed** with `DevAgentUnavailableError` when no scope matches — never a hardcoded agent |

> **Classification tables are caller-supplied data, not core defaults (INT-001).**
> Core owns only the mechanics: entry `runtime_class` wins, then `scope_runtime_classes` /
> `scope_ui_classes` on the config, then nothing (`null`). The fullstack bundle writes its
> tables at registration; standalone projects copy them from `team.config.example.json`.
> A project that must override *may* still add `flags.has_ui` / `flags.has_runtime`
> (the schema's free-form `additionalProperties` accepts them), but that creates a second
> source of truth — prefer the tables.
>
> **`has_runtime` gates the `manual_qa` stage** (`skip_if: "!scope.has_runtime"`) — so manual
> runtime verification runs for backend/CLI work too, not only UI. **`has_ui` selects the *mode***
> inside that stage: `ui` (native OMP `browser` for web; configured device automation for apps)
> when `has_ui`, else `runtime` (run the app, hit endpoints, read logs).

## Custom agents (project / user / other plugins)

A role resolves to a concrete agent via `.omp/team.config.json` `roles`. There is no
built-in fallback: an unknown role resolves to itself. The resolved value is passed verbatim
as the Task `agent`, so it can be **any registered agent**:

- project agent `.omp/agents/<name>` → bare `<name>`
- user agent `~/.omp/agent/agents/<name>` → bare `<name>`
- enabled extension-package agent → its registered bare `<name>` (OMP registry is flat)

```jsonc
// .omp/team.config.json  (legacy fallback: .claude/team.config.json)
{
  "roles": {
    "backend-kotlin": "my-jvm-backend",   // project agent
    "security-tester": "acme-sec:pentester"  // another plugin's agent
  },
  "roster_overrides": {                  // add agents to a stage without forking a profile
    "review": { "add": ["my-a11y-agent"] }
  }
}
```

`roster_overrides[<stage id>]` is applied by the interpreter **after** the profile's
`conditional[]` rules: `replace` sets the whole roster, otherwise `add`/`remove` adjust it.
New role keys beyond the built-in set are allowed — reference them from a custom profile or a
roster override. Note: a hook cannot verify an agent exists, so a wrong name fails at the Task
call (not at a gate).


## Roster policy (semantic selection pools)

A stage MAY declare a typed `roster_policy` instead of a fixed role manifest. The policy turns
the stage's role list into an **allowed pool**: the orchestrator composes 1..N dispatch slots
situational, instead of one agent per declared role.

```jsonc
"roster_policy": {
  "allowed_roles": ["analyst", "tech-researcher"], // the pool — the only selectable roles
  "required_roles": [],                            // forced coverage (subset of allowed)
  "required_facets": [],                           // forced facet coverage
  "min_workers": 1, "max_workers": 3,              // total slot bounds
  "multiplicity": { "analyst": { "min": 0, "max": 3 }, "tech-researcher": { "min": 0, "max": 3 } },
  "prefer_distinct_agents": true,
  "selection_mode": "pre_dispatch_minimum_valid",
  "triggers": { "complexity": [], "confidence": [], "scope_flags": [], "evidence": [] },
  "budget": { "token_limit": null, "dollar_limit": null }
}
```

### Protocol (durable engine)

1. **Instructions before capability.** `workflow_instructions` is readable any time after
   `workflow_prepare`; for a roster stage it returns the stage contract including
   `roster_policy` (the pool) before any capability exists.
2. **Semantic selection at begin.** `workflow_begin` accepts an optional
   `selection: { rationale?, evidence?, occurrences: [{ role, facet?, focus?, reason? }] }`.
   Occurrences are semantic only — **concrete agent ids are rejected** (zod `.strict()` at the
   tool boundary and a runtime guard in the engine).
3. **Validation before dispatch.** The engine validates allowed roles, per-role multiplicity,
   total bounds, and budget; every selected role must resolve through the **live registered
   agent mapping** (`.work-state/runtime/agent-mapping.json`, trusted only when its
   preferences hash matches the current configuration). A stage with no trusted live mapping
   fails closed; a selected role without a registered agent fails with a named-role diagnostic.
   There is no identity fallback (`role → role`) and no unrelated-stack fallback for roster
   stages — legacy manifest stages keep the documented fallback behavior.
4. **Freeze.** The validated selection is frozen on the issued capability
   (`roster_selection`, with `snapshot_id`, per-slot `agent`, and `capability_epoch`).
   **Advancing INTO a roster-policy stage defers selection and capability issuance:**
   `workflow_advance` marks the next roster stage `pending` without arming it — no
   composition is preselected or frozen at the advance boundary — and only an explicit
   `workflow_begin` issues (and freezes) that stage's capability. Non-roster stages arm
   normally at advance; a loop `back_to` a roster stage defers the same way.
5. **Idempotent re-issue, rejection of change.** Re-beginning the same stage with the identical
   semantic composition is idempotent (the frozen selection is reissued). A changed
   composition for an active capability is rejected with the frozen `snapshot_id` named —
   finish the stage first. A composition that is a **prefix** of the frozen one counts as
   identical: engine-appended slots (minimum-bound fillers, risk-trigger additions) are
   engine-owned. Facet is part of the frozen identity; `focus`/`reason`/`rationale` are
   provenance and never re-open the freeze.
6. **Deterministic defaults.** `workflow_begin` without a selection picks the minimum valid
   set at arm time: required roles, then minimum-bound fill, then at most one risk-trigger
   addition (`prefer_distinct_agents` respected when the pool offers distinct agents). The
   default is never applied implicitly by `workflow_advance` — a deferred roster stage waits
   for the explicit begin.

Shipped pools: `full-feature` `exploration` (pool `analyst` + `tech-researcher`, 1..3;
complex/low-confidence runs default to the two-role pair) and `full-feature` `architecture`
(pool `architect` ×1..3; situational option consilium composed via facet/focus — see
`stages/architecture.md`). The former fixed `architect_minimal` / `architect_clean` /
`architect_pragmatic` alias roles are removed; per-option emphasis is now facet/focus on
repeated `architect` occurrences, not role names.

## Agent capability tiers

Every bundled agent carries a capability tier in its frontmatter. OMP resolves the concrete
model per-session from `modelRoles` / `task.agentModelOverrides`; the workflow config does not
set models — it only names agents.

| tier | model role | thinkingLevel | examples |
| high | `@slow` | `high` | architect, code-reviewer, security-tester, cto, team-lead |
| middle | `@task` | `auto` | developer-kotlin, developer-go, frontend-developer, qa, … |
| low | `@smol` | `medium` | tech-researcher |


## Adding a custom profile

1. Copy an existing profile, give it a unique `name` (= filename).
2. Define `match` (or leave it unmatched and select it explicitly).
3. Order stages; set `consumes`/`produces` to existing artifact ids (or add new ones to
   `artifacts-schema.json`).
4. Validate: `jq empty workflows/<name>.json` and check against `_schema.json`.
