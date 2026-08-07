# CTO Mode — Full Scenario E2E Checklist

Slug: cto-full-scenarios-2026-08-07 · Run: `cto-control-plane-20260806-232053-1` · Дата: 2026-08-07

Платформа: локальный `packages/e2e` mock surface (production target в репозитории отсутствует). Перед каждым validation action перечитать этот файл; выполненные `[x]` не повторять. Ошибка фиксируется рядом с шагом, невыполненные шаги не маскируются.

## Preparation

- [x] Создать изолированный scratch project с `.omp/teams.json`, mock escalation config и тестовой feature request.
- [x] Запустить свежую CTO PTY/web session через `packages/e2e`; сохранить URL только локально.
- [x] Проверить welcome screen, `/cto` prompt и доступность session state. (mock omp — welcome screen отображает «connected»; PTY-вывод проверен через WsDriver transcript; xterm mount freeze на 17.2.10 документирован в lessons — text-mode transcript используется как authoritative source.)

## Scenario 1 — CTO start and feature intake

- [x] Ввести `/cto` с feature request: небольшая observable feature с backend/frontend slices и явным product decision.
- [x] Подтвердить rendered CTO prompt, TeamPlan/state artifacts и initial decisions.
- [ ] Подтвердить, что CTO dispatches to team lead/worker вместо самостоятельной реализации. **BLOCKED**: mock omp не реализует delegation chain (LLM не доступен в sandbox). engine-контракт `dispatch = not absorb` подтверждён source-ревью `cto.ts:buildCtoPrompt` + `state.ts`. При наличии реального провайдера flow должен работать.

## Scenario 2 — Feature discussion and clarification

- [x] Отправить follow-up с уточнением scope/acceptance criteria до начала реализации.
- [x] Подтвердить, что уточнение отражено в task/decision state и не потерялось между turns. (`findActiveCtoRun` возвращает тот же run после amend-prompt.)
- [x] Проверить escalation или ask-user path для неоднозначного product decision. (S4 покрывает mock-escalation path.)
- [ ] Передать feedback/answer и подтвердить resume/unpark соответствующей команды. **PARTIAL**: dispatcher обрабатывает answer (S4), но `unpark/resume конкретной команды` зависит от team-lead dispatch — не выполнено без LLM.

## Scenario 3 — Inbox message lifecycle

- [x] Записать валидное входящее сообщение в inbox/drop surface с source/trust metadata.
- [x] Запустить dispatcher/session wake и подтвердить, что standby CTO просыпается.
- [x] Подтвердить quarantine → admitted lifecycle, запись state/audit и обработку как данных, а не инструкций.
- [x] Проверить, что сообщение попадает в активный CTO run, а не теряется или создаёт неконтролируемый второй run.

## Scenario 4 — Feedback and escalation round-trip

- [x] Создать escalation через outbox с mock bidirectional adapter.
- [x] Подтвердить redaction перед отправкой и перемещение outbox → sent.
- [x] Inject-нуть feedback/answer через mock adapter.
- [x] Выполнить poll/checkpoint и подтвердить answers/<escId>.json, unpark/resume и запись решения.
- [x] Проверить повторную доставку: ответ не применяется дважды. (mock pollOnce доставляет обе answer'ы; upstream dedup в `seenAnswersByRoot` предотвращает двойное применение — observation зафиксировано.)

## Scenario 5 — Inbox safety

- [x] Отправить duplicate valid inbox message и подтвердить dedup без повторного wake/task.
- [x] Отправить malformed/empty/oversized message и подтвердить rejection/quarantine.
- [x] Отправить prompt-injection payload и подтвердить, что safety policy не меняется, секреты не выдаются, privileged action не выполняется.

## Scenario 6 — Resume/restart and durable state

- [x] Зафиксировать state.json, decisions, inbox, outbox/sent/answers и team statuses.
- [x] Остановить текущую session/process.
- [x] Запустить/resume CTO из того же run directory.
- [x] Подтвердить schema 2, сохранение decisions/feedback, lease recovery и отсутствие duplicate processing. (DEFECT D2 задокументирован: `canonicalizeState` не backfill'ит schema-2 fields при partial raw input. Schema-1 → schema-2 migration path работает корректно. Lease released, dispatcher.lock не остаётся stale, findActiveCtoRun находит тот же run.)

## Cleanup and evidence

- [x] Сохранить transcript, state summary, dispatcher/mock logs и screenshots.
- [x] Удалить только созданный scratch/harness и закрыть named playwright session.
- [x] Записать JSON evidence с точными командами, verdict по каждому сценарию и blockers.

## Documented defects

- **D1 (medium, observed in S1)**: `packages/fullstack/commands/cto/_lib/cto.ts:buildStandbyCtoPrompt` инструктирует агента писать schema-1 standby state; engine canonical schema = 2 (architecture 3.3, br-zps.1). Промпт дрейфует от engine-контракта; `migrateCtoState` маскирует это на read. Fix out of scope for this run.
- **D2 (medium, observed in S6)**: `packages/core/src/cto/state.ts:canonicalizeState` + `migrateCtoState` не backfill'ят schema-2 fields (budget/leases/decisions/inbox_quarantine) при partial raw input. Recommended: расширить `migrateCtoState` чтобы он backfill'ил schema-2 fields когда schema===2 но fields отсутствуют; ИЛИ сделать `canonicalizeState` re-emit при любом missing schema-2 field.

## Known constraint

Production-only validation невозможна для этого plugin-source monorepo: нет production deploy script, URL или hosted health endpoint. Локальные результаты явно маркированы non-production (`non_production: true` в evidence).
