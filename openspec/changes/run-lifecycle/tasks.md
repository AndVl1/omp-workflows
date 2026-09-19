# Tasks

## 1. Lifecycle contracts

Последовательный milestone core. Интеграционный владелец — единственный writer общих типов, exports и файлов хранения; конкретных владельцев core/fullstack/internal/e2e назначить при apply по `design.md`, до параллельной записи. Основание: `run-lifecycle` и `run-context-isolation`.

- [ ] 1.1 В `engine/types.ts` и `control-plane-contract.ts` определить schema-2 ordinary run identity, lifecycle request `new | resume | rework`, trusted execution context и typed errors; согласовать `run_id`, `run_key`, `WorkIdentity.run_id`. Проверка: validators отвергают несовпадающие идентичности, неизвестную schema и старую неоднозначную continuation-форму, сохраняя CTO namespace.
- [ ] 1.2 В `engine/run-lifecycle.ts` реализовать выбор намерения/кандидата по `design.md` Decisions 1–2 без I/O и OMP API. Проверка: явный ID не имеет fallback, несколько кандидатов дают `run_selection_required`, terminal resume даёт `run_terminal`, новая задача не зависит от наличия history.
- [ ] 1.3 Добавить prepare request identity и exact-replay контракт в typed validation. Проверка: тот же request/payload возвращает тот же запуск, изменённый payload с прежним request ID отвергается, новый пользовательский запрос с тем же текстом остаётся независимым.

## 2. Canonical storage and transactions

Зависит от группы 1. Владелец core; не включать новый writer в публичный runtime до consumer cutover. Основание: `run-state-migration` и `run-context-isolation`.

- [ ] 2.1 В `run-store.ts` и `state.ts` реализовать run-ID target resolution, versioned `run-control.json`, read-only listing и session selections; сохранить containment/lock/CAS. Проверка: два runs одной ветки читаются раздельно, stale selection не меняет явный selector, listing не импортирует legacy и не мутирует данные.
- [ ] 2.2 Расширить существующую transaction/artifact journal границу для lifecycle intent, commit marker и recovery state/control/artifact updates. Проверка: process interruption до и после publication не показывает частичную authority, повтор recovery идемпотентен, CAS conflict сохраняет исходные данные.
- [ ] 2.3 Реализовать атомарный worktree execution claim и coordinator handover, различая coordinator liveness и pending workers. Использовать trusted release receipt либо проверенный ESRCH, не выдавать PID-проверку за session fingerprint; повторно сверять ownership token под lock. Проверка: два процесса не получают claim одновременно, живой/unknown владелец не вытесняется, смерть координатора разрешает resume того же run, но не независимый new при незавершённых workers.

## 3. New resume and rework transitions

Зависит от группы 2. Владелец core. Основание: `run-lifecycle`, `run-context-isolation`.

- [ ] 3.1 Перевести `prepareWorkflowState` и прямой `run()` на новый lifecycle contract; убрать ветку как ключ запуска. Проверка: последовательные new одной ветки создают разные runs, quiescent прежний selection сохраняется для resume, `run_busy` не публикует частичный новый run.
- [ ] 3.2 Реализовать resume отдельно от `reopenFromFeedback`: сначала сверять persisted dispatch/receipts, не входить повторно в `walkProfile`/`task.call/batch` для pending и succeeded slots. Handover меняет только `ownership_epoch`, не `rework_generation` или существующую worker identity. Проверка: доступный late receipt продолжает тот же dispatch; при недоступном host-транспорте сохраняется `background_wait/transport_reconnect` без fake attach и повторного запуска; cursor, classification и checkpoint scope сохранены.
- [ ] 3.3 Реализовать rework snapshot/manifest в `revisions`, затем точечную invalidation affected/downstream state в `run.ts`/`durable.ts`. Проверка: старые результаты доступны неизменно, upstream inputs сохраняются, старые downstream outputs/proofs не завершают новую работу; сбой snapshot/commit не разрушает текущий результат.
- [ ] 3.4 Перевести authorize/reconcile/complete/advance в `durable.ts` и callbacks `stage.ts` на captured run/dispatch/rework-generation context; terminal workflow атомарно освобождает ownership. Проверка: поздний результат A не меняет выбранный B, handover ownership не отвергает законный результат старого worker, exact replay идемпотентен, worker success не освобождает незавершённый workflow.

## 4. Host ingress and enforcement

Зависит от групп 1–3. `src/index.ts` и shared command contracts остаются у core integration owner. Основание: `run-lifecycle`, `run-context-isolation`.

- [ ] 4.1 В `commands/{envelope,do-work,register,types}.ts` добавить режимы `--new`, `--resume`, `--rework`, `--run`, `--list` и завершитель options `--`; сохранить `/team` как alias. Ветви `--resume` и `--list` обрабатывать до нынешней проверки непустого task; только new требует task, rework требует feedback. Проверка: taskless resume/list достигают нужной операции, конфликт flags отвергается до мутации, явный mode не переопределяется моделью, новый запрос не становится resume по наличию state.
- [ ] 4.2 Подключить trusted session controller из command/session ingress к регистрации tools/hooks и request identity; при завершении/замене host-сессии фиксировать coordinator release до сброса controller, сохраняя reservation для pending workers. Проверка: две последовательные сессии одного процесса не блокируют друг друга старым coordinator claim; новая сессия не наследует чужой enforcement; prepare доступен без active run; worker не получает main-session полномочия.
- [ ] 4.3 Обновить `workflow_prepare`, `workflow_status`, `workflow_instructions` и остальные tools на единый selector, read listing/candidates и typed next actions; natural-language resume/rework получает stage/selector от системы. Read-only resolver заполняет точный run ID до prepare, mutation повторно валидирует его под lock. Проверка: taskless resume без --run выбирает единственного кандидата, неоднозначность разрешается до мутации, ошибка явного ID не имеет fallback; пользователь не вводит stageId и не удаляет marker.
- [ ] 4.4 Перевести classification/dispatch/monotonic/DoD/write/validation gates на selected context; сохранить safety checks и claim enforcement вне workflow. Проверка: terminal history не блокирует обычную сессию, смена ветки отклоняет действия старого run, ошибки повреждённого явного state не превращаются в отсутствие state.
- [ ] 4.5 Подключить CTO start/dispatch/finalize к общему worktree claim и scoped slice/ask selection без изменения CTO storage/scheduler. Проверка: active CTO и ordinary run не получают конфликтующее исполнение, terminal CTO history не блокирует ordinary session, существующие CTO marker/lease проверки сохраняются.
- [ ] 4.6 Обновить `src/index.ts` tool_call/tool_result hooks: при authorize сохранить durable tool-call-to-dispatch mapping с origin session и slot identities; result callback и восстановление mapping после restart используют исходный run. Проверка: поздний результат A при selection B меняет только A, consilium сохраняет все slots, событие без однозначного origin отклоняется; текущий cwd/selection не используются как fallback.

## 5. Legacy import and recovery

Зависит от transaction/state контрактов групп 2–3. Здесь реализуются importer/recovery и изолированные проверки, но импорт пользовательских данных и schema-2 writer ещё не активируются. Включение разрешено только задачей 6.6 после полного consumer cutover 6.5. Владелец core; при параллельной работе нельзя редактировать shared state/durable одновременно с группой 4. Основание: `run-state-migration`.

- [ ] 5.1 В `run-migration.ts` реализовать discovery root/features, stable source-to-run mapping и preflight quiescence/containment/version checks. Проверка: нестандартный slug и два самостоятельных состояния одной ветки сохраняются раздельно; повторный source не дублируется; активный/неизвестный legacy dispatch не переносится вслепую.
- [ ] 5.2 Реализовать перенос state/evidence manifests, ссылок artifacts/slot/completion/document/observability и исторических proofs через lifecycle transaction. Сохранить старые dispatch/checkpoint/WorkIdentity records и original identity в revision evidence; атомарно перевести активные bindings на новый UUID, очистить прежние capability/checkpoint scopes и не импортировать claims. Проверенные успешные slots незавершённой стадии сохранить как migration-bound completion evidence без прежних полномочий. Проверка: schema-2 не содержит смешанных активных run IDs, обязательные ссылки и история разрешаются, старые handoff/proof отвергаются, следующий begin выдаёт свежую capability и не повторяет завершённые stages/slots; missing optional telemetry обозначена, изменённый source/unsafe path/unknown schema не теряет исходник.
- [ ] 5.3 Реализовать archive/receipt и recovery до/после publication: rollback только до commit, после commit — forward repair с сохранением canonical mapping. Проверка: interrupted import восстанавливается без ручных действий, старый marker не возвращает legacy authority, попытка post-publication rollback отвергается и новые canonical commits не перезаписываются повторным импортом.

## 6. Consumer cutover and projections

Начинать после фиксации публичного контракта групп 1–4. Writers fullstack/internal могут работать независимо в своих пакетах; core projections и exports пишет интеграционный владелец. Основание: все три specs.

- [ ] 6.1 Перевести `report/session-source.ts`, report selectors и visualization на canonical run/revision reader. Проверка: выбор A после B на той же ветке возвращает только A, revision до rework читается отдельно, migrated custom-slug evidence доступно.
- [ ] 6.2 Перевести observability recorder/cache/events на run-scoped identity и flush/rotate при смене selection. Проверка: последовательные runs не смешивают события и неполный legacy log не дополняется данными другого run.
- [ ] 6.3 Перевести fullstack registration, commands/tools status/report/view и messenger scope на shared controller/read APIs; сохранить bundle owner claims. Проверка: публичный bundle использует новый lifecycle, не запускает второй controller в subagent и не маршрутизирует ask к чужому CTO run.
- [ ] 6.4 Перевести internal registration/pool callbacks на новые core contracts с captured async context, не меняя workspace-wide agent mapping. Проверка: смена run во время async discovery не приписывает callback новому запуску; activation/owner conflict semantics сохранены.
- [ ] 6.5 Выполнить интеграционный cutover exports/callers и удалить branch-derived runtime selection, старый continuation writer и независимые `.active-feature` readers вне importer. Проверка: все поставляемые consumers используют единую authority, legacy API даёт migration-ошибку, временный dual-reader отсутствует; до 6.6 мутация пользовательских данных новой версией остаётся выключенной.
- [ ] 6.6 После 5.1–5.3 и 6.1–6.5 подключить recovery/discovery/import к `workflow_prepare` и прямому core lifecycle ingress до любых canonical мутаций, затем активировать новый writer единым cutover. Проверка через legacy-only fixture: первый реальный ingress импортирует историю и артефакты, ошибка импорта возвращает `migration_required`/точную причину без создания обходного пустого run, повторный ingress использует canonical mapping; прежних runtime writers больше нет.

## 7. End-to-end acceptance

Запускать после объединения всех consumer edits. Постоянные regressions хранить только для наблюдаемого контракта и реально рискованных границ; проверки wording/path plumbing удалить, а не переутверждать под новую реализацию.

- [ ] 7.1 Обновить relevant coverage `run-continuation`, `do-work-autonomy`, `control-plane-contract`, `approval-closure`, checkpoint/dispatch/report tests под сценарии specs. Проверка: targeted suites защищают lifecycle/identity/rework invariants, старый state-exists отказ и prompt wording больше не являются нормативными assertions.
- [ ] 7.2 Провести process-level fault/race сценарии: два новых starts, handover после смерти координатора при pending worker, late/replayed result, прерывание migration/rework transaction. Проверка: один owner, отсутствие дубликатов/чужих мутаций и сохранность evidence подтверждены результатами процессов.
- [ ] 7.3 Через существующий `packages/e2e` terminal harness выполнить registered `/do-work` journey: завершить A → новая B на той же ветке → новая C на другой ветке → возврат к A для rework; затем resume незавершённого run в новой сессии и обычная сессия после terminal workflow. Проверка: ни одного ручного изменения `.work-state`, корректные run IDs/history, отсутствие повторного pending dispatch; сохранить transcript/evidence.
- [ ] 7.4 Проверить интеграцию fullstack/internal и shared CTO scope, затем один раз выполнить `npm run build`, `npm run typecheck`, `npm test`. Проверка: все команды успешны; отсутствие подходящего live OMP runtime отмечается как незакрытая приёмка 7.3, не подменяется unit pass.

## 8. Documentation and delivery

Завершающий milestone после доказательства поведения. Реализация следующих блоков roadmap не входит в этот change.

- [ ] 8.1 Обновить `packages/core/README.md`, `packages/core/workflows/README.md`, затронутые fullstack/internal инструкции и changelog: new/resume/rework, run selection, busy/recovery UX, schema/API migration, ограничение ветки и rollback. Проверка: примеры соответствуют выполненному live journey, нет советов вручную удалять marker или редактировать canonical state.
- [ ] 8.2 Сверить карту ответственности `docs/architecture/principles.md` при перемещениях и обновить общий roadmap фактическим результатом; удалить временные migration/scaffold/smoke материалы, сохранив evidence и нужные regression tests. Проверка: заменённые runtime пути удалены, все требования трёх specs имеют результат проверки, tasks закрываются только после этого; автономия/scheduler не объявлены реализованными.
