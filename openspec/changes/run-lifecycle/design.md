# Design

## Context

Мотивация и scope: [proposal.md](proposal.md). Нормативные сценарии: [run-lifecycle](specs/run-lifecycle/spec.md), [run-context-isolation](specs/run-context-isolation/spec.md), [run-state-migration](specs/run-state-migration/spec.md). Общий порядок изменений: [roadmap](../../../docs/architecture/refactoring-roadmap.md).

Наблюдения, определяющие дизайн:

- `engine/run.ts:prepareWorkflowState` совмещает создание и `reopenFromFeedback`, отвергает новое состояние существующей ветки и записывает branch в `run_key`.
- `commands/do-work.ts:buildDoWorkPrompt` объявляет любой найденный non-stale state продолжением. `commands/register.ts` передаёт промпт main agent; это не прямой вызов `run()`.
- `engine/state.ts:updateStateAtomically` уже содержит workspace lock, fresh read, revision/raw-content CAS и координацию artifact side effects. Его гарантии сохраняются, а выбор target перестаёт зависеть от branch slug.
- `engine/durable.ts:resetReopenedStageState` инвалидирует прежнюю работу и удаляет stale artifacts. Для rework нужно сначала сохранить предыдущую версию evidence, а не только историю текста задачи.
- `engine/types.ts:WorkIdentity` уже имеет run/session/dispatch/attempt identity; capability также содержит `run_key`, branch, stage, epoch и loop scope. Новая run identity должна согласовать эти поля, не создавать ещё один независимый идентификатор того же исполнения.
- Classification, monotonic и DoD gates сами читают `.active-feature`/legacy paths; dispatch и durable используют другие resolver-пути. `report/session-source.ts` и observability также имеют branch/feature assumptions.
- CTO уже хранит самостоятельные run directories и `owner_session`, но shared slice/ask gates могут выбирать последний активный run. Его модель хранения не переносится в этом change; интеграционные точки scope и worktree ownership входят в cutover.
- Host session ID доступен в command context через `sessionManager.getSessionId()`; ordinary tools/hooks сейчас не используют этот ID. `src/index.ts` захватывает доверенный host profile на `session_start`. Дизайн не предполагает появления per-call session API, которого нет в проверенном коде.

Design обязателен: меняются публичные контракты, модель хранения и несколько потребителей, присутствуют migration/concurrency риски.

## Goals / Non-Goals

**Goals:**

- Один domain-контракт lifecycle и один resolver для authority, без второго state machine.
- Разделить чистое решение «что выбрать/разрешить» и файловую транзакцию, не переписывая весь durable engine.
- Сохранить branch как проверяемый execution context, но исключить его из ключа хранения и идентичности run.
- Завершить cutover всех поставляемых потребителей в одном change, с отдельными последовательными implementation milestones.

**Non-Goals:**

- Перенос одного запуска на другую ветку, автоматический checkout/stash/reset или решение конфликтов пользовательского working tree.
- Параллельная изменяющая работа нескольких независимых запусков в одном worktree; несколько worktrees остаются отдельными областями исполнения.
- Новый scheduler, фоновое восстановление OMP, retry/cancel taxonomy, изменение hard-human правил или headless-полномочий.
- Миграция CTO portfolio state, общая переработка package layout и выпуск релиза в рамках planning.
- Отдельные archive tool/status для ordinary run. Архив legacy при миграции и snapshots rework сохраняются, но не вводят обязательную архивацию между задачами.
- Переработка UI или модели графа visualization: допускается только локальная адаптация canonical reader, иначе viewer для нового формата отключается до отдельного change.

## Decisions

### 1. Независимый run и явный вход

Каноническая identity нового обычного workflow — UUID `run_id`, который также используется как его `run_key` и как `WorkIdentity.run_id`. Эти поля проверяются на равенство для ordinary run; CTO сохраняет существующий отдельный namespace. `branch` остаётся неизменным контекстом запуска в этом change. Разные runs одной ветки различаются UUID; одинаковый текст задачи не является ключом идемпотентности.

Предлагаемый lifecycle request для `workflow_prepare` и core preparation API — discriminated union:

| Mode | Обязательные данные | Эффект |
|---|---|---|
| `new` | task, classification, branch; files/issue по существующим правилам | Создать независимый run |
| `resume` | run_id, branch | Присоединить координатора к сохранённой точке; не переоткрывать стадии |
| `rework` | run_id, branch, feedback, affected_stage | Сохранить предыдущую версию и переоткрыть затронутую часть |

Host adapter добавляет trusted caller/session context и idempotency `request_id`; модель не задаёт доверенный session ID. При точном replay одного `request_id` возвращается тот же результат; другой payload с тем же ID отвергается. Повторный явный пользовательский запуск получает новый request ID, даже если текст идентичен. Для natural-language intake request ID создаётся адаптером команды до отправки промпта и проверяется при prepare.

Один tool `workflow_prepare` с явным mode достаточен; отдельные new/resume/rework tools не вводятся. Успешный ответ содержит operation, previous/selected run IDs и названия, итоговые статусы и точку продолжения. Host показывает этот receipt пользователю; отказ показывает отсутствие перехода. Данные результата соответствуют committed state, exact replay не изображает новое переключение. При new после quiescent A явно показывается «A отсоединён, прогресс сохранён → B создан и выбран», не «A успешно завершён/архивирован».

Отказ от альтернатив: branch+counter не решает выбор task/session и коллизии slug; timestamp не является достаточной identity; автоматический resume по наличию state повторяет текущий дефект.

### 2. Пользовательский выбор без обязательного знания stageId

Основной UX — `/do-work продолжи экспорт отчётов` либо просьба продолжить текущую фичу без UUID; при неоднозначности — выбор из списка названий, веток, статусов и этапов. Сохраняются `/do-work` и alias `/team`. Технические leading options остаются для точного управления и автоматизации:

- `/do-work --new <task>`;
- `/do-work --resume [--run <id>]`;
- `/do-work --rework [--run <id>] <feedback>`;
- `/do-work --list` — прямой read-only ответ без model prompt: перечень runs текущего worktree с фильтром текущей ветки по умолчанию и возможностью показать все ветки.

`--` завершает разбор options; флаги внутри текста не интерпретируются. Невалидное сочетание режимов отвергается до мутаций. Без флага main agent классифицирует **намерение запроса**, а не наличие state: независимая задача — `new`, явное «продолжи» — `resume`, «исправь результат предыдущей задачи» — `rework`. Явный command mode обязателен для модели. Неоднозначность действительно влияющая на выбор задачи разрешается до старта, а не через угадывание.

Для existing-run режимов порядок: явный selector (технический ID, название или пункт показанного списка) → совместимый selected run сессии → единственный подходящий кандидат текущей ветки. Название не уникальная identity: оно берётся из сохранённой задачи; совпадения требуют выбора, а не создания второго slug-namespace. Явный текстовый selector фильтрует подходящие задачи (нормализованный регистр/пробелы, точное название либо однозначный фрагмент); модель не имеет права подменить ноль/несколько совпадений «самым похожим» run. Завершённый run исключается для resume, но подходит для rework. Несколько кандидатов возвращают `run_selection_required` с понятными подписями и внутренними ID; никаких latest-by-mtime fallback. Ошибка явного selector не включает fallback.

Это два разных уровня API: CLI допускает отсутствие `--run`, но read-only selection resolver возвращает конкретный run ID или список кандидатов **до** вызова `workflow_prepare`. Prepare union выше всегда получает точный ID для resume/rework и повторно проверяет его под lock; отсутствие ID в mutation не включает неявный поиск. Taskless `--resume`/`--list` обрабатываются до нынешней проверки непустого текста задачи.

Выбор номера/пункта связан с конкретным показанным snapshot списка и его run ID; добавление run или новая сортировка не переназначают номер. Утрата snapshot после restart требует показать список заново. Resolver проверяет существование и eligibility выбранного run под lock перед мутацией. UUID доступен для диагностики и automation, но не требуется для обычного new/resume/rework. До перехода видны выбранные задача/операция, после commit — результат tool; отдельное подтверждение человека требуется лишь для неоднозначности или действующих policy gates.

`affected_stage` — машинный результат сопоставления feedback текущему профилю; пользователю не предлагается придумывать stageId. Engine проверяет существование стадии и вычисляет затронутый downstream по текущим зависимостям профиля; в линейном профиле это выбранная стадия и последующие. Неоднозначное содержательное сопоставление выясняется до rework.

`br-2up` полезна как история запроса о продолжениях, но её прежний default branch auto-resume намеренно заменяется этим правилом. Флага `--continue` в новом контракте нет; текущий исходник его не реализует, а бесконечный alias не добавляется.

### 3. Session selection не равен run identity или execution ownership

Адаптер получает host session ID в command handler и связывает его с session-local controller, который передаётся registration, hooks и tools. На `session_start` controller начинает новый session epoch и сбрасывает прежнюю process-local selection; если host ID доступен там, он захватывается сразу. Не требовать ID в каждом tool context: hooks/tools используют controller closure, async callbacks — захваченный run context. Прямой core API получает явный trusted execution context от caller и не угадывает его из cwd.

При вызове mutating workflow tool до session binding возвращается `WORKFLOW_CONTEXT_REJECTED`; при связанном host без выбранного run переходы внутри workflow возвращают `no_active_run`. `workflow_prepare` как lifecycle ingress принимает new/resume/rework без предварительного active selection; status/list с явным read selector также не требуют active selection. До slash-command workflow не подхватывается из истории. Native subagent получает scope из проверенного dispatch marker, а не право выбирать run main-сессии. Существующие проверки main-session/UI ownership сохраняются.

Durable session selection — convenience для восстановления и last-selected history; она не credential. Новая host-сессия не захватывает чужой run. В той же host-сессии после restart selection читается, но ownership проверяется заново. Terminal selected run становится historical selection, не active enforcement. Смена ветки отцепляет quiescent selection от исполнения; explicit resume прежнего run требует возврата на его ветку.

При доверенном завершении/замене host-сессии controller записывает coordinator-release receipt под текущим ownership token до сброса closure. Если dispatch нет, освобождается claim; если workers ещё работают, сохраняется reservation исходного run без активного координатора, пригодная только для его resume. Это работает и когда две последовательные host-сессии живут в одном OS-процессе. Авария до release обрабатывается консервативным liveness probe, не очисткой по времени.

Альтернатива с одним глобальным `.active-run` отвергнута: она повторяет межсессионную гонку `.active-feature`.

### 4. Минимальное хранилище и одна транзакционная граница

Целевая раскладка:

```text
.work-state/
  runs/<run-id>/
    state.json
    artifacts/
    revisions/<revision-id>/
      state.json
      artifacts/
      manifest.json
  run-control.json
  lifecycle-transactions/<transaction-id>/
  legacy-archive/<migration-id>/
  cto/<cto-run-id>/                 # existing CTO format
```

`TeamState` нового ordinary run использует `schema: 2`, обязательные `run_id`, `run_key`, generation/rework metadata; текущие stage/pause/durable поля сохраняются по смыслу. `run-control.json` — versioned control record с CAS revision: опубликованные run IDs, session selections, один worktree execution claim, import mappings и prepare request receipts. Он не дублирует изменяемые summary/status каждого run: они читаются из run state. Source paths и identifiers валидируются, имена веток/сессий не используются как path segments.

Обычные stage transitions продолжают писать selected run через существующий lock/CAS seam. Multi-file lifecycle операции (new, rework, migration, release/attach) расширяют существующий artifact journal устойчивым transaction intent: подготовленные файлы и before/after manifest, commit marker, восстановление под тем же workspace lock. До публикации контрольной записи prepared directories не видны resolver; после commit recovery только доводит forward publication, не возвращается к legacy authority. Все mutating lifecycle операции сначала завершают recovery. Read-only listing не импортирует данные и не делает частичный target активным: показывает `recovery_required`, если встретил незавершённую публикацию.

Lifecycle commit фиксирует изменения run state, selection и claim согласованно. При аварии между файлами readers не наблюдают half-committed authority: общий resolver проверяет transaction marker. Existing locks/CAS, containment и artifact validation переиспользуются; отдельная БД или event-sourcing framework не вводятся.

### 5. Ownership: сериализация, а не новая система scheduling

Worktree claim содержит owner kind (`workflow` или `cto`), точный run ID, coordinator session/process identity и `ownership_epoch`. Claim — длительное право исполнения; workspace lock — короткая сериализация commits, не одно и то же. `ownership_epoch` меняется при передаче координатора и ограждает его новые команды; `rework_generation` меняется только при rework и ограждает версии результатов. Handover не меняет `rework_generation`, capability epoch или scope уже созданных workers и не отвергает их результаты лишь из-за смены координатора.

- Новый run получает claim атомарно. Конкурентный старт возвращает `run_busy`, без частичного опубликованного run.
- Текущая сессия может заменить собственный quiescent selection новым run: прежний сохраняется как resumable, с неизменным stage/pause, но без координатора. Незавершённые dispatch запрещают такое отсоединение.
- Полное terminal завершение освобождает claim и active selection транзакционно; terminal result одного worker этого не делает.
- Живой чужой координатор не вытесняется. Существующий `state.ts:pidAlive` проверяет только `process.kill(pid, 0)`, не fingerprint процесса: его нельзя объявлять полноценным session-liveness API. Для claim использовать trusted session-release receipt либо подтверждённое отсутствие локального PID (`ESRCH`) с повторной проверкой claim token под lock. `EPERM`, живой/reused PID без release и неизвестный host status означают unknown/busy, не право захвата. Token/epoch не позволяет старому callback освободить новый claim.
- После смерти координатора новый координатор может присоединиться **к тому же run**, сохраняя pending workers и их identities. Начало другого run запрещено до подтверждённого завершения/остановки прежних workers.
- `workflow_status` показывает claim, pending owners и безопасное следующее действие (resume/reconcile либо дождаться terminal результата). Отсутствие provider evidence не заменяется TTL-успехом или force-unlock. Новый механизм уничтожения workers не вводится.
- Все engine-owned dispatch/branch-sensitive transitions повторно сверяют current Git branch. Внешний `git checkout` или произвольный unmanaged worker движок физически не изолирует; это ограничение явно остаётся в документации.

Для CTO используется тонкое подключение существующих start/dispatch/finalize boundaries к тому же claim и scoped selectors. Portfolio state, scheduler и leases не заменяются. Старые активные CTO runs без нового claim консервативно учитываются перед acquisition, пока их исполнение не завершено. Нельзя оставлять legacy `find latest active wave` authority для несвязанной ordinary сессии.

### 6. Resume и rework — разные переходы

Resume сохраняет cursor, classification, artifacts, capability identity/epoch и существующие dispatch. Секрет handoff при необходимости безопасно переиздаётся существующим механизмом, но worker не запускается повторно. Coordinator session ownership обновляется отдельно от исторического `WorkIdentity.session_id` уже созданных dispatch. Новые dispatch получают новый coordinator binding; старые results продолжают сверяться с исходным dispatch.

При resume в чистой host-сессии `workflow_instructions` формирует контекст из canonical state и текущего профиля: задача/классификация, cursor и pause, ограничения/checkpoints, принятые решения и manifest обязательных входов текущего этапа с источниками завершённых стадий. Агент читает обязательные входные артефакты до следующей изменяющей работы и сообщает восстановленный этап. Это не восстановление старой переписки и не новый frozen bundle: используется существующий stage input/artifact contract, данные перечитываются из авторитетных файлов. Проверка разрешимости и существующих evidence-инвариантов обязательна; missing/invalid required input даёт `recovery_required` с конкретной ссылкой и блокирует зависимое действие. Summary не заменяет исходный обязательный артефакт; случайный файл в каталоге не доказывает завершение этапа. E2E должен доказать, что продолжение использовало конкретное сохранённое решение, отсутствующее в новой переписке.

Текущий `TaskCaller` имеет `call/batch`, но не verified reconnect API. Поэтому resume сначала сверяет сохранённые dispatch и durable/native receipts и **не вызывает** `walkProfile`/`task.call`/`task.batch` для незавершённых или уже успешно выполненных slots. При доступной доставке результата adapter продолжает наблюдение того же dispatch. Если host не предоставляет транспорт/receipt после restart, возвращается честное `background_wait` с `transport_reconnect` и recovery diagnostic; замена worker, таймерное объявление успеха и выдуманный attach API запрещены. После доставки проверяемого результата следующий resume продолжает join/advance. Автоматическое восстановление недоступного транспорта относится к roadmap C, не обещается этим change.

Rework допускается только без незавершённых dispatch затрагиваемой работы. Перед изменением сохраняется immutable snapshot state и evidence в `revisions/<id>` с manifest/checksums. Затем увеличивается `rework_generation`, добавляется feedback/history, инвалидируются затронутые текущие ссылки, capability/epoch/loop/checkpoint scopes; сохраняются только валидные upstream outputs. Старые файлы больше не удаляются до snapshot commit и не выдаются как текущие. Output paths текущей версии могут остаться `artifacts/`, чтобы не заставлять все validators понимать дерево поколений; просмотр истории получает собственный resolver base из revision manifest. Snapshot — копия, не hardlink на изменяемые файлы.

Выбран snapshot-before-rework вместо нового run на каждую правку: сохраняется непрерывность задачи и downstream closure, но предыдущий результат остаётся доступным. Отдельные task attempts остаются dispatch-level идентичностями, не подменяются номером rework revision.

### 7. Асинхронные результаты не читают текущий selection

При доверенной авторизации фиксируется `{run_id, dispatch_id, capability_id, epoch, rework_generation}` вместе с известной work identity. `src/index.ts` сохраняет durable routing mapping host tool call → один или несколько slot dispatch **до** запуска native task, а не отбрасывает результат authorize. Ключ включает origin session и tool call identity; callback захватывает его до async ожидания. `tool_result` использует это соответствие, а не только текущий `ctx.cwd` или selection. После restart mapping восстанавливается из canonical dispatch ledger; событие без однозначного source binding отклоняется как unresolved, а не назначается последнему run.
Reconciliation из native task result/provider открывает точный run и проверяет исходный dispatch scope под lock. Смена session selection, `ownership_epoch` или ветки не меняет адрес результата. Exact replay остаётся идемпотентным; conflicting replay/старый `rework_generation` отклоняется и не мутирует другой run.

Scope результата не даёт права возобновить side effects на чужой ветке. Подтверждение уже совершённого dispatch и разрешение следующего действия остаются разными решениями.

### 8. Модульные границы и владельцы записи

Новые внутренние модули внутри `packages/core/src/engine/`, без нового workspace package:

- `run-lifecycle.ts`: типизированные lifecycle решения, selection policy, new/resume/rework preconditions; без OMP API и файловой discovery логики.
- `run-store.ts`: run catalog/selection, claim storage и run-root resolution; использует существующую транзакционную инфраструктуру `state.ts`, не создаёт второй writer.
- `run-migration.ts`: только legacy discovery/import, manifests и recovery исходного формата; не вызывается как fallback authority на каждом hook.
- `state.ts`: serialization/validation/lock/CAS и переходы selected run; branch/marker selection удаляется из runtime пути.
- Host controller размещается в существующей command/tool registration области; зависит от lifecycle API. Reports/visualize/observability зависят от публичного read selector, не от migration internals.

Интеграционный владелец core пишет общие типы, новые modules, `state/run/durable`, barrel `index.ts` и общие файлы. Отдельные writers fullstack, internal и e2e назначаются только после фиксации экспортируемого контракта; это роли ответственности, не требование новых типов агентов. Core shared files не редактируются параллельно. Runtime tests запускаются после объединения совместимых изменений, не на промежуточной смеси контрактов.

### 9. Обязательный consumer cutover

| Потребитель | Изменение |
|---|---|
| `commands/do-work.ts`, `envelope.ts`, `register.ts`, `types.ts` | Intent/options, trusted session controller, selection UX; убрать state-exists continuation |
| `src/index.ts`, `engine/run.ts`, `workflow-contract.ts` | Новый prepare union, list/status selector, общий execution context; прямой `run()` использует тот же lifecycle |
| `engine/durable.ts`, `stage.ts`, `checkpoints.ts` | Run-targeted переходы, resume без reopen, rework snapshot, capture callback binding; правила разрешений не меняются |
| `gates/classification.ts`, `dispatch.ts`, `monotonic.ts`, `dod-backstop.ts`, `orchestrator-write.ts`, `validation.ts` | Убрать независимые active-feature readers; разделить selected-run enforcement и глобальную safety/claim защиту |
| `cto/slice-gate.ts`, CTO start/finalize, `fullstack/src/messenger-channel.ts` | Scoped CTO selection и общий execution claim; не блокировать ordinary history по чужой latest wave |
| `report/session-source.ts`, `report/types.ts`, `visualize/snapshot.ts`, `observability/{hooks,recorder,events}.ts` | Обязательные run/revision selectors для status/report, listing, cache key по run, rotate/flush при смене selection; visualization — локальный reader cutover либо отключение входов для нового формата |
| `fullstack/src/workflow-commands.ts`, `index.ts`, tools/commands status/report/view | Передать общий controller/read selector; сохранить bundle ownership |
| `omp-workflows-internal/src/index.ts`, `pool.ts` | Те же core exports; async callbacks захватывают context, workspace agent mapping не превращается в run authority |
| `packages/e2e` и `packages/*/test` | Публичные new/resume/rework сценарии вместо branch-path/текста prompt assertions |

Имена файлов этой таблицы — карта затронутых потребителей, не инструкция менять всё содержимое. Перед экспортируемыми refactors в apply — symbol references и перевод всех реальных callers; здесь production-код не меняется.

Граница visualization: локальная адаптация означает смену reader/selector и binding без переработки UI, graph model или renderer. Если этого недостаточно, не начинать переписывание в этом change: скрыть команды/кнопки/ссылки запуска viewer для canonical формата; прямой вызов возвращает явное сообщение о недоступности и ссылки/действия status/report. Shared entry point для других поддерживаемых форматов сохраняется, но неподдерживаемый run не рендерится. Текстовые list/status/report и доступ к evidence обязательны независимо от viewer; рабочий viewer использует только canonical reader. Для приёмки 6.5 отключение несовместимого viewer считается завершённым consumer cutover, а оставленный legacy fallback — нет. Переработка покрывается отдельной будущей спецификацией, её реализация не входит в эти tasks.

### 10. Совместимость и ошибки

Это явное несовместимое изменение prepare/selection API и persisted state version. Все поставляемые потребители переводятся совместно; старый `continuation` не поддерживается вторым runtime путём. Внешние custom bundles получают migration guide: заменить continuation на resume/rework, передавать trusted context и использовать возвращаемые run/artifact paths. Release оформляется по действующей политике версий отдельно; произвольный совместимый host range здесь не выдумывается.

Профили, artifact schemas и checkpoint semantics сохраняются; изменяются run address и lifecycle metadata. Изменение старого публичного report selector описывается явно: ordinary reports принимают canonical run ID и optional revision; legacy slug lookup доступен только как явный import mapping, не неоднозначный fallback. CTO selectors сохраняют namespace.

Ошибки имеют код, target/run ID где известен, неизменённость state при отказе и поддерживаемое next action: `run_not_found`, `run_selection_required`, `no_active_run`, `run_busy`, `run_context_mismatch`, `run_terminal`, `run_state_invalid`, `migration_required`, `migration_conflict`, `recovery_required`, `lifecycle_request_conflict`. Они не рекомендуют удалять маркер или вручную править canonical JSON.

## Risks / Trade-offs

- **Широкий consumer cutover** → последовательные milestones, единый владелец core boundary; первый блок нельзя объявить завершённым после одного нового storage module.
- **Жёсткий отказ вместо конкуренции** → один execution claim на worktree ограничивает throughput, но соответствует последовательным пользовательским сценариям; параллелизм нескольких независимых задач требует отдельных worktrees.
- **Snapshot увеличивает объём** → копирование только на rework/migration, не на каждом transition; retention/GC не добавляется без отдельного решения.
- **Смерть сессии не доказывает остановку worker** → conservative busy и resume/reconcile того же run; неизвестный provider не превращается в успешную отмену.
- **Несовместимые old binaries** → обновление выполняется при остановленном execution, старые процессы не должны писать после cutover; это эксплуатационная предпосылка, не обещание sandbox.
- **Host API ограничения** → использовать проверенный command session ID и shared adapter closure, не вводить несуществующий per-tool session API. Live TUI/RPC journey обязателен; headless ownership не расширяется.
- **Natural-language intent ошибается** → явные flags приоритетны, выбранный mode/run видны до мутации, неоднозначность возвращается до старта.

## Migration Plan

1. В implementation подготовить новый контракт и полный consumer cutover до включения schema-2 writer. Не выпускать промежуточную сборку с одновременной записью двух форматов.
2. Перед первым mutating lifecycle request обнаружить legacy root и все feature states. Listing показывает кандидатов read-only; importer не выбирает один по `.active-feature`/mtime. Устаревший безопасный маркер сам по себе не является причиной отказа новой задачи.
3. Для каждого валидного источника зафиксировать canonical source path, raw hash/revision, новую run identity и migration ID. Независимые sources не объединять по branch. Неизвестную version, конфликт идентичностей, unsafe path либо неподтверждённо завершённое исполнение диагностировать до переноса.
4. Под существующим workspace lock подготовить копии state/artifacts и manifest ссылок. Проверить artifact map, slot contributions, completion refs, documents и observability. Relative paths переписать согласованно; optional missing telemetry обозначить, обязательный missing evidence не скрывать. Human proofs сохранить в историческом snapshot; active scopes после rebind должны требовать валидного нового подтверждения.
5. CAS-проверить source и destination; через lifecycle journal опубликовать run directory и mapping в control record. Сохранить исходные dispatch, WorkIdentity, completion records и human proofs в immutable migration revision. В активном state очистить прежние `dispatch_capability`, `cursor_epoch`, work/pending/completion mirrors и policy-bound checkpoint authorization, а также не переносить coordinator claim. Сохранённые task, classification, cursor, завершённые стадии и валидные artifact mappings остаются. Свежая capability выдаётся на следующем begin; старый handoff/proof не принимается. Pending legacy worker запрещает такой rebind.
   Remap выполняется атомарно: активные root `run_id/run_key` получают новый UUID; nested исторические bindings остаются только в immutable revision с original identity/provenance. Активные child/slot/completion projections нельзя частично оставить со старым run ID: либо они восстанавливаются как проверенные migrated evidence references без полномочий, либо сохраняются только в истории. Успешные terminal slots незавершённой стадии материализуются как migration receipt с проверенными artifact hashes и отметкой выполненной работы, чтобы следующий begin не запускал их заново; новые полномочия для следующего действия выдаются отдельно. Schema-2 validation проверяет весь результат до publication; слепая строковая замена run ID внутри human proofs запрещена.
6. После canonical commit перенести source в `legacy-archive/<migration-id>` с receipt и исходными hashes. Старый `.active-feature` более не читается runtime. При crash после commit mapping достаточен для идемпотентного завершения archive. Источник без изменений не импортируется повторно; изменившийся источник с receipt даёт `migration_conflict`, не откатывает новый run.
7. Владелец importer — core integration owner. Он сохраняется как явный schema-1 import boundary для ещё не обновлённых installations, но не runtime compatibility resolver. Временный dual-reader при разработке удаляется в milestone cutover до приёмки change. Архивы сохраняются как данные; их удаление не требуется для завершения.

**Rollback:** только до canonical publication — восстановить исходное состояние и удалить transaction-owned staging. После publication разрешён только forward repair с сохранением canonical mapping, archive и новых данных; откат старого binary поверх такого worktree не поддерживается. Pre-cutover backup служит recovery evidence, а не инструкцией восстановить старую authority поверх опубликованного run. Обновление и восстановление не выполняются поверх работающих workers.

## Verification Strategy

- Постоянные regressions оправданы для независимых runs одной ветки, resume без повторного dispatch, rework evidence, двухпроцессной гонки claim, late-result isolation, stale selection и interrupted migration.
- Использовать существующие `run-continuation.test.ts`, `do-work-autonomy.test.ts`, `control-plane-contract.test.ts`, `approval-closure.test.ts`, checkpoint/dispatch/report coverage. Тесты только на текст prompt или прежний path layout удалить; проверять наблюдаемые transitions, данные и отказ без мутаций.
- Live OMP через существующий e2e terminal harness: A → B на той же ветке → C на другой → возврат к A для rework; проверить видимые transition receipts. Отдельно закрыть сессию после сохранённого этапа и в новой без старого чата продолжить фичу по названию/списку: следующая реализация учитывает решение из артефакта, завершённые этапы не повторяются. Проверить неоднозначные названия, стабильность выбора из показанного списка, missing required input и resume с сохранённым pending identity. Использовать реальный registered `/do-work`, не только прямой `run()`.
- Подтвердить изоляцию обычной сессии от terminal истории и совместимость shared CTO hooks без миграции CTO модели.
- Для viewer проверить выбранную ветвь scope: либо правильный canonical run/revision, либо скрытые входы и явный отказ прямого вызова при работающих status/report. Недоступность viewer не отменяет lifecycle-приёмку и не оправдывает потерю evidence.
- После интеграции выполнить `npm run build`, `npm run typecheck`, `npm test`; live evidence отдельно. Невозможность live-проверки фиксируется как невыполненная приёмка, а не заменяется зелёным unit suite.
