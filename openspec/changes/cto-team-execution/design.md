# Design

## Context

Мотивация и scope: [proposal.md](proposal.md). Нормативные контракты: [исполнение](specs/cto-team-execution/spec.md), [решения](specs/cto-team-decisions/spec.md), [реализуемость](specs/cto-plan-readiness/spec.md).

Наблюдения по текущей ветке, а не обещание реализованного поведения:

- `cto/run.ts:runCto` создаёт plan/state и возвращает их оркестратору; комментарий явно отделяет этот путь от исполнения команд движком.
- `cto/slice-gate.ts:assertCtoSliceDispatchable` проверяет wave, slice/team mapping, classification, выбранный workflow и DoD. Эти проверки не являются исполнением стадий. `findActiveWave` выбирает состояние по всему worktree; это устраняется prerequisite `run-lifecycle`, не вторым resolver здесь.
- `gates/dispatch.ts` уже проверяет role/agent относительно capability roster обычного workflow. `engine/durable.ts`, `stage.ts`, `workflow-contract.ts` — существующие границы переходов и evidence, которые нужно переиспользовать, а не копировать в CTO.
- Fullstack `agents/team-lead.md` требует дисциплины профиля и propagation slice marker, но имеет `spawns: "*"`; private `omp-team-lead.md` содержит более краткий контракт, а его frontmatter перечисляет только read/glob/grep/bash при текстовом требовании task/hub. Это свидетельство различий деклараций, не доказательство эффективного host toolset.
- `.omp/teams.json` хранит профиль, lead и roster ролей. Конкретные агенты должны разрешаться через bundle mapping, а не из глобального списка доступных имён.
- `cto/escalation.ts:readAnswers` читает файлы ответов, `decisions.ts` хранит решения с why, `budget.ts` имеет policy/accounting и оценочный recorder. Их наличие не доказывает аутентификацию всех ответов либо точность денежных затрат.
- `cto-slice-gate.test.ts` покрывает admission slices и markers. Часть сценариев фиксирует старую глобальную active-wave authority: после lifecycle их нельзя сохранять как желаемый контракт.
- В истории `sdd-integration` встречаются исправления mapping authority (`3ad2d67`), session/dispatcher lifecycle (`18161a5`), durable delivery recovery (`217afec`) и publication recovery (`3f766fa`). Это указатели для сохранения конкретных гарантий; их корректность и применимость после lifecycle в этом planning не проверялись. Пользователь сообщил о последовательном обнаружении дефектов. Причина длительности и отсутствие предварительной проверки не установлены.

Design обязателен: изменение затрагивает несколько consumers, модель полномочий, дочернее состояние и миграцию.

## Goals / Non-Goals

**Goals:**

- Один механизм переходов профиля и авторизации назначения независимо от уровня orchestration.
- Lead изолирует контекст команды; CTO видит результаты и исключения, не исполняет внутреннюю цепочку.
- Разделить канонические полномочия, транспорт вызова и текстовые инструкции.
- Выполнить clean cutover поставляемых consumers, сохранив provenance результатов и восстановление.

**Non-Goals:**

- Не добавлять второй lifecycle, глобальный active-child pointer или отдельный workflow interpreter для CTO.
- Не обещать sandbox для произвольного eval/bash и не изобретать отсутствующий host reconnect/cancel API.
- Не заменять lead автоматом и не фиксировать каждый содержательный шаг до старта.
- Не переносить всю ветку `sdd-integration`, не менять общий SDD-процесс и глобальную autonomy policy обычных workflow.

## Decisions

### 1. Lifecycle prerequisite и делегированный execution context

Реализация начинается после acceptance `run-lifecycle`: session-bound selection, поздние результаты и worktree claim должны работать. CTO сохраняет portfolio namespace и единственный top-level claim. Дочерняя работа получает trusted parent binding и scope-подмножество; не вызывает ordinary top-level new с конкурирующим claim и не переключает selection CTO.

Новый child context содержит parent CTO run, slice, plan revision, child execution identity, coordinator/lead generation и stage dispatch identity. Полномочия выдаются адаптером из canonical state, не берутся из текста lead. Результат связан с исходным dispatch; смена lead сама по себе не делает валидный сохранённый worker чужим, но новая версия работы не принимает прежний результат как свой.

Альтернатива «каждый lead запускает независимый /do-work» отвергнута: она конфликтует с ownership и теряет причинную связь. Единственный общий cursor для всех команд тоже отвергнут: он сериализует независимые профили.

### 2. Командный execution contract и один interpreter

В `cto/types.ts`/`plan.ts` вводится versioned per-slice contract: цель и ссылки на входы, scope, зависимости, classification, resolved profile identity/hash, lead mapping, допустимые stage roles/slots, acceptance, policy/budget allocation и plan revision. Конфигурация проверяется при принятии плана; доступность и актуальность полномочий повторно проверяются при dispatch. Изменение mapping/profile не подхватывается посередине исполнения молча.

Дочерний state хранится под run-scoped CTO directory, с собственным cursor, loops, capabilities и artifact references. Семантика stage/begin/complete/advance берётся из существующего engine через явный scoped target. В CTO остаются portfolio scheduling и агрегирование результатов, не дубликат stage machine. Точный путь child state — внутренний reader/store contract, а не authority из имени каталога.

Parent хранит ссылку на child, не второй изменяемый cursor. Join проверяет terminal child receipt и его revision; повтор join идемпотентен. Publication дочернего результата и parent acceptance используют существующую транзакционную границу: после сбоя незавершённая публикация восстанавливается до выдачи новых полномочий.

### 3. Lead по умолчанию, элементарное исключение узкое

Для багов/фич lead обязателен. Прямой worker допустим только как явно записанный `elementary` маршрут: одно однозначное механическое действие без диагностики, проектирования, координации и без обязательного многостадийного профиля. Не использовать число строк diff как классификатор. При сомнении выбирать lead. Такой worker всё равно имеет назначение, scope, evidence и условия завершения; CTO не получает право писать код.

Lead координирует workers и получает разрешённые stage slots. Он может декомпозировать внутри slots и возвращать работу по предусмотренному циклу, но не добавлять произвольные роли, пропускать gates или менять общий scope. Документ профиля объясняет работу, typed contract разрешает её.

### 4. Единая граница dispatch и host adapter

Расширить существующую capability authorization общим scoped target для ordinary/child execution. Существующий slice marker остаётся только routing hint; canonical parent binding, текущая revision/stage и role-agent mapping обязательны. Admission slice и авторизация worker — разные проверки одного пути, а не альтернативные разрешения.

Нормализовать реально поддерживаемые формы task/batch и доступные host bridges перед одной авторизацией. Hub send/wait не считать автоматически spawn: проверять только операции, которые действительно создают или возобновляют исполнителя. Перед включением adapter подтвердить эффективный nested toolset и доступность hooks на установленном host.

Если eval/helper умеет создавать агентов без наблюдаемого authorization seam, он не является разрешённой dispatch surface managed lead; его spawn capability не выдаётся этому роли/режиму. Обычные вычисления eval не требуют запрета сами по себе. Нельзя утверждать, что анализ произвольного JS/Python обеспечивает sandbox. Если host не позволяет ограничить обходной spawn, этот host/mode не получает статус поддерживаемого строгого исполнения.

Отказ содержит код, scope, неизменённость state и действие: исправить назначение, сверить dispatch, восстановить binding или устранить неподдерживаемую surface. Повтор неизвестного dispatch сверяется по исходной identity; не запускается новый worker ради обхода отказа.

### 5. Два уровня решений, один путь применения

Сохраняются lead → CTO → human. Policy задаёт разрешённые категории решений и scope; existing hard-human checkpoints не понижаются до lead/CTO. Требования профиля получают явное разрешение делегировать обычные командные решения там, где это допускает policy; слово autonomous в промпте не является разрешением.

Decision record связывает run, slice/затронутый набор, plan revision, question revision, полномочного получателя, варианты и blocking dependencies. Состояния доставки и применения различаются: pending delivery, awaiting answer, answered, applied, superseded/rejected. Существующие adapters только доставляют и принимают; trusted ingestion проверяет источник и scope перед применением. Сырой answer JSON не является достаточным proof. Точный повтор безопасен, конфликт и поздний ответ не разблокируют новую revision.

Scheduler продолжает ready nodes вне blocked dependency closure. Это не новый внешний daemon: используется существующий portfolio scheduler и поддерживаемая доставка результатов. Если вопрос глобальный, closure глобальна. CTO получает компактный decision packet, а не transcripts.

### 6. Попытки, бюджет и безопасная замена lead

Переиспользовать `cto/budget.ts` и существующий accounting; allocations/reservations должны проверяться до нового dispatch совместно с доступным остатком. Замена lead и перепланирование не обнуляют расходы. Точные host costs и estimates показываются отдельно; не обещать hard-dollar cap на оценочных данных. Отсутствие лимита явно показывается как отсутствие лимита, не как нулевой расход.

Lead сообщает о тупике с перечнем гипотез/попыток и evidence; не вводить универсальное «три попытки». Движок обеспечивает заданные лимиты, а содержательное отсутствие прогресса оценивает lead и может проверить CTO. CTO может выделить дополнительный локальный ресурс из остатка, заменить lead или изменить подход внутри исходных полномочий; увеличение общего лимита требует соответствующего разрешения.

Replan создаёт новую revision и dependency impact set. Незатронутое evidence сохраняется. Перед конфликтующим новым dispatch старые workers должны быть завершены, подтверждённо остановлены либо явно сохранены как то же назначение. Unknown liveness даёт reconcile/block, не автоматический respawn. Lead handover восстанавливает контекст из контракта и artifacts, не требует передачи всей переписки.

### 7. Readiness как evidence, не ещё один церемониальный workflow

До первой основной implementation-стадии lead обеспечивает readiness artifact: assumption, источник в коде/контракте, confirmed/refuted/unknown, impact, evidence и следующее решение. Использовать существующую analysis/diagnosis стадию профиля; если её нет, добавить bounded readiness prerequisite для CTO child, не универсальную новую линейку агентов.

Для архитектурно значимого unknown требуется ограниченный spike в рамках полномочий: вопрос, критерий, результат. Одного чтения достаточно для проверяемого статического факта. Недоступная среда остаётся blocker. Локальное неизвестное имеет указанный момент проверки и не останавливает независимую работу.

При новом evidence lead классифицирует находку: локальный дефект или опровержение предпосылки. Первое идёт в рабочий цикл, второе — в локальный replan либо CTO decision. План принимается по ссылкам из любого SDD; конверсия в OpenSpec не нужна.

### 8. Evidence и двухуровневая приёмка

Team result envelope включает contract revision, terminal status, acceptance-to-evidence mapping, outputs, существенные решения и риски. Текст «готово» не авторизует join. Передаваемый CTO пакет содержит ссылки; внутренние logs/transcripts не загружаются автоматически.

Plan задаёт интеграционные acceptance dependencies и исполнителя либо обоснованное not-applicable для независимой работы. Интеграция оформляется управляемой работой с теми же правилами, не ручным кодированием CTO. После исправления повторяются затронутые проверки; evidence привязано к проверенной версии результата. Общая приёмка CTO сверяет исходный запрос и local/integration receipts.

### 9. Consumer cutover и владение изменениями

| Граница | Изменение |
|---|---|
| `cto/types,plan,state,run` | Версионированные child contracts, binding и ссылки на execution |
| `engine/durable,stage,workflow-contract,agent-mapping,checkpoints` | Scoped child target в существующих transitions и policy |
| `cto/slice-gate`, `gates/dispatch`, host registration | Единая авторизация и trusted dispatch/result routing |
| `cto/scheduler,budget,decisions,escalation,channels` | Dependency-local blocking, decision application, reservations, replan |
| CTO command, fullstack/private lead assets и registration | Компактный handoff, реальные tools/spawn restrictions, отсутствие prompt-only обхода |
| Status/report consumers | Readiness, blocked dependencies, delivery/application, текущая revision и evidence |

Один integration owner отвечает за core contracts и общие файлы. Consumer writers получают зафиксированный интерфейс; один файл не редактируется конкурентно. После переключения удалить заменённые writers/authorization paths и противоречащие инструкции; общий package split не нужен.

## Risks / Trade-offs

- Host не предоставляет единый hook для nested dispatch → проверить конкретные task/bridge surfaces отдельным runtime probe до adapter cutover; неподдерживаемый режим явно не включать, не обходить защиту.
- Child ownership может конфликтовать с результатом lifecycle refactor → использовать его завершённые public seams; никакого второго selector/claim resolver.
- Строгость добавит ceremony → reuse существующих стадий, readiness по рискам, CTO не участвует в штатных transitions. Не обещать фиксированное ускорение без измерений.
- Длительная работа может быть полезной диагностикой → в acceptance trace отличать рабочие итерации, orchestration handoffs, ожидание и infra recovery; число найденных дефектов не использовать как метрику провала.
- Из `sdd-integration` потеряются важные гарантии → перед cutover сопоставить конкретные исправленные сценарии authority/delivery/publication с новой моделью; переносить требования и нужные regressions, не всю архитектуру.
- Статическая готовность не доказывает runtime semantics → значимые неизвестные проверять ограниченным экспериментом; сохранять возможность replan после новых фактов.

## Migration Plan

1. Завершить prerequisite lifecycle и зафиксировать поддерживаемый host dispatch contract. Проверить nested lead toolset, result routing, unsupported bridge policy и отсутствие конкурирующего child claim.
2. Реализовать versioned child contracts и scoped переходы на существующих persistence/capability primitives; подготовить consumers до включения нового writer.
3. Перед cutover остановить или сверить активное legacy execution. Историю сохранить read-only. Для resumable legacy slice создать явный reconciled contract с подтверждёнными inputs/evidence; неподтверждённые стадии не считать выполненными. Pending unknown workers блокируют конфликтующий запуск.
4. Переключить поставляемые bundles, hooks, lead assets, commands и status readers вместе. Старый prompt-only путь больше не авторизует новое выполнение. Документировать несовместимость для custom bundles.
5. Rollback до публикации нового состояния — возврат к предыдущей сборке при отсутствии нового исполнения. После публикации — forward recovery либо восстановление согласованного backup при остановленных workers; старый binary поверх нового state не запускается.

## Verification Strategy

- Использовать существующие `cto-slice-gate`, `cto-control-plane`, `cto-engine`, `cto-ownership`, `agent-mapping-dispatch`, `dispatch-capability-contract` suites для поведенческих границ. Не закреплять устаревшие markers/формулировки как acceptance.
- Live bug journey: CTO передаёт баг lead; диагностика, исправление, неуспешная проверка и повторный цикл остаются в команде; результат имеет evidence, CTO не запускает внутренние стадии.
- Live feature journey: две команды и зависимая интеграция; одна эскалация не останавливает независимую команду; интеграционный дефект возвращается lead; приёмка только после исправления.
- Adversarial dispatch: off-roster, неверная стадия, missing role, прямой и обёрнутый spawn, повтор результата и изменение mapping. Поддерживаемые surfaces имеют одинаковую policy.
- Recovery: поздний ответ, замена lead с pending worker, replan одной команды, повтор publication/join и restart. Нет дубликатов и ложного завершения новой revision.
- Readiness: отсутствующий API, неизвестная recovery-гарантия с экспериментом, недоступный host, локальная задача без большого аудита, входной план вне OpenSpec.
- Budget: дополнительная локальная попытка в остатке, общий предел, конкурентные reservations и отсутствие точного cost evidence.
- Зафиксировать trace handoffs, стадий, полезных fix-итераций и ожиданий для диагностики overhead; отдельная система telemetry и численное обещание ускорения не требуются.
