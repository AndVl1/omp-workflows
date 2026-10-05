# Design

## Context

Мотивация и scope: [proposal.md](proposal.md). Это план, а не утверждение о готовности реализации или результаты новых проверок.

### Наблюдаемая база

- `packages/core/src/index.ts:3097-3134`: `workflow_complete` требует dispatch token и копирование capability/run/profile/cursor/iteration, принимает artifact IDs и вызывает durable completion. Это не worker-facing tool для сдачи содержимого.
- `packages/core/src/engine/{types,control-plane-contract,durable,run,stage}.ts`: есть WorkIdentity, terminal/pending envelopes, `retry_of`, snapshots артефактов, отдельные complete/advance и iteration-scoped capabilities. Нужен переход к приёму payload, а не второй параллельный completion engine.
- `packages/core/src/commands/{do-work,cto,register}.ts`, `packages/core/src/cto/run.ts`: ordinary и native CTO имеют разные canonical state/authority; смешивать их идентификаторы и инструменты нельзя. CTO profile obligations сейчас в значительной части передаются lead-инструкциями и evidence; новый контракт перехода должен проверяться кодом, не только текстом.
- `packages/core/workflows/debug-cycle.json`: diagnose → implementation → verify, максимум 3 итерации и escalation. Issue #73 сообщает отсутствие реального повторного выполнения; декларация loop и iteration counter сами по себе ничего не доказывают.
- Pending `transport_reconnect` и приём позднего terminal результата существуют; обнаруженный контракт не доказывает host API для reattach/resume живого worker после потери сессии. `provider_ref` не является таким доказательством.
- Существующие реальные тестовые seams: `packages/core/test/run-lifecycle-acceptance-process.test.ts` (registration bus/controllers/temp store/processes), `checkpoint-ask-hardening.test.ts` (настоящий checkpoint handler и fake dialog), `native-worker-authority.test.ts` (native lifecycle/admission), `fan-in.test.ts`, `approval-closure.test.ts`, `durable-final-corrections.test.ts`. `packages/e2e/test/cto-process-e2e.test.ts` и `fixtures/cto-process-dispatcher.ts` используют реальные процессы с local inbox.
- `.github/workflows/ci.yml` запускает build, typecheck, npm test; отдельного обязательного сценарного gate пока нет. Универсальный fake-clock/transport framework не установлен: добавляем только необходимые узкие seams.

### Связь с исходными specs и выполненными исправлениями

Три specs `../run-lifecycle/specs/` прочитаны полностью. Их invariants сохраняются: отдельные new/resume/rework, immutable история, trusted selection/claim, неизвестный worker не считается завершённым, безопасная миграция. Пустой `openspec/specs/` не означает отсутствие этого базового контракта. Архивирование и синхронизация исходного change здесь не выполняются.

| Источник | Роль в этом change | Текущая граница доказательства |
|---|---|---|
| [#76](https://github.com/AndVl1/omp-workflows/issues/76) | R06: preflight → terminal not-started → linked retry | Пользовательский repro принят; новый RED/GREEN обязателен |
| [#73](https://github.com/AndVl1/omp-workflows/issues/73) | R16/R17: реальный цикл и лимит | Начальный forward-dependency fix не доказывает retry |
| PR #72, producer/schema corrections | S01–S12: сохранить корректные schemas, заменить ручную сдачу | Есть успешные ordinary-прогоны; это не доказательство нового submission API |
| `br-th6` | R23: intent через границу хода | Граница classify → Proceed наблюдалась; весь новый контракт не принят |
| `br-asz`, `br-yn5`, `br-l1k` | R19: разделение ordinary/CTO и configured lead | Native lead → architect наблюдался; последняя system-contract правка не имеет полной native приёмки |
| `br-6jz`, `br-8aq`, `br-bby` | S11, R03/R04/R11/R20–R24 | Уже внесённые fixes не заменяют сценарные assertions |
| `br-pbr` | Источник прежней незавершённой QA, не новый release gate | Старые прогоны остановлены; релиз не входит в scope |
| `br-2up` | Исторический контекст | Старое auto-resume-by-branch противоречит принятому explicit lifecycle; не переносим это требование |
| [#71](https://github.com/AndVl1/omp-workflows/issues/71), `br-rsl`, `br-vdk`, PR #70 | Внешняя интеграция / историческое восстановление / harness | Отдельные работы; отсутствие их proof не выдаётся за исправление |

## Goals / Non-Goals

**Goals:** использовать текущий durable engine и настоящие registered adapters; убрать модель из принятия решений о доверенной identity и успешности перехода; получить конечную no-network матрицу с reproducible faults и test-first для новых контрактов.

**Non-Goals:** универсальная workflow-платформа или новый test framework; гарантия exactly-once произвольных внешних побочных эффектов worker; замена provider scheduler; обещание host-resume API без проверки; глобальное переписывание CTO; ручное лечение старых пользовательских runs; выпуск пакетов во время этой работы.

## Decisions

### 1. Один протокол сдачи, три доверенных вида producer binding

`workflow_submit_result` принимает ровно один model-facing delivery вариант: `{ outputs: Record<string, unknown> }` либо `{ outputs_path: relativePath }`. Файл строго `{ outputs }`; adapter устанавливает trusted producer workspace, безопасно читает bytes один раз, JSON.parse и передаёт envelope существующему service. Absolute/traversal/symlink и foreign workspace отвергаются; read/path/parse refusal возвращает code/error без schema field_errors/receipt. Authority, immutable publication и replay не меняются. Model не передаёт run/stage/token/producer metadata или canonical state paths.

Core формирует внутренний `StageProducerBinding` только из сохранённого назначения текущего profile/cursor и доверенного runtime-контекста. Его точный discriminant — `producer.kind: "worker" | "orchestrator" | "tool"`:

- `worker` разрешён только для profile-declared worker slot/role с проверенной session lineage и актуальным worker assignment; terminal worker-событие может исходить только из этой trusted worker lineage.
- `orchestrator` разрешён для stage, у которого profile-declared `type:"orchestrator"` задаёт coordinator ownership: trusted ordinary main-session coordinator либо configured native lead, назначенный именно этому CTO slice. Он может публиковать собственные outputs, но не представляет worker и не требует придуманного worker terminal; CTO root не может выдать себе binding lead-а.
- `tool` разрешён только если `StageDefinition` явно объявляет `producer: { kind: "tool"; tool_name: "<registered name>" }`, при authenticated current host и exact registered callback/invocation proof. Core wrapper `registerStageProducerTool(...)` передаёт callback-local publisher, связанный с captured assignment/host и exact declared `tool_name`; после async provider binding повторно проверяется перед публикацией. Никакого ambient context flag, который мог бы одолжить concurrent `workflow_submit_result`. Имя инструмента выводится из profile/регистрации и trusted callback, никогда не из model-поля. Существующий `type:"document"` с executable `document.renderer` также рассматривается как engine-owned tool/renderer producer: renderer registry и declared document contract дают trusted renderer proof; `product-discovery/product_prd_document` использует существующий `product-prd` renderer, пять declared sources, только safe relative path `documents/product-prd.md` и typed `product_prd` output через тот же receipt path. Идентичные sources дают byte-identical document; model submission и worker terminal для renderer не создаются.

Binding дополнительно связывает authority (`ordinary` или `cto`), существующий `WorkIdentity`, profile/stage/iteration/generation и host `{ session_id, worktree, branch }`. Проверка сравнивает kind, assignment, generation, cursor, host и callback с canonical state; текстовые идентификаторы в payload не расширяют полномочия. Подмена worker из main/lead context, чужой или stale assignment, неаутентичный/replayed callback и tool вызванный вне его declared host boundary отвергаются до публикации; для `lecture_acquire` этой boundary является только main session. Старый `StageWorkerBinding` не оставляется alias: draft ещё не выпущен, поэтому callers переводятся на общий `StageProducerBinding` одновременно.

Существующие artifact schemas/validators и snapshots переиспользуются. Невалидный tool JSON также считается неуспешной сдачей: host parsing failure не должен завершать этап. Модель может ошибаться в outputs; детерминизм заключается в проверке и последствиях, а не в обещании безошибочной генерации. В production нет альтернативы «если tool не получилось, доверься файлу»; workflow-owned outputs публикуются только через этот протокол/core API. Альтернатива усилить prompts и продолжать ручной JSON отклонена: она сохраняет класс текущих сбоев.

Большие/nested результаты при разрешённом writer публикуются файлом с уникальным UUID именем на producer occurrence, не общим stage-output.json. JS eval использует Bun.write/JSON.stringify; diagnostics с general Bash может использовать Node randomUUID/writeFileSync с flag wx и передать напечатанный path. AST-only readonly producer без writer сохраняет concise schema-complete inline путь; инструкции не создают отсутствующих tools или source-write прав. После parse error исправляется доставка, не исследование.


### 2. Квитанция, crash-consistency и отдельный terminal transport

Ключ сдачи выводится из доверенного assignment и версии результата, а digest канонического payload обнаруживает конфликтующую повторную сдачу. Engine сериализует результат один раз, готовит immutable files в назначенном namespace и атомарно публикует canonical references/receipt. Подготовленные, но не опубликованные файлы не видны consumers. Durable запись незавершённой операции позволяет штатно завершить/откатить публикацию после crash без удаления пользовательских данных.
Shared `StatePublication` переиспользует существующий `LifecycleFileContent` (`string | base64 image | null`) для всей атомарной публикации evidence и receipt; direct binary fallback запрещён.

Точный повтор возвращает тот же receipt; изменённый payload после acceptance требует новой авторизованной итерации. Не пересериализуем и не копируем полный набор evidence при каждом status/recovery; используем существующие immutable references.

Cold revive в pinned OMP 18.0.6 восстанавливает parked agent session из persisted AgentRef/session JSONL; это новый follow-up turn, не восстановление прежнего executor или private grants. Для уже принятой worker submission разрешён отдельный read-only replay: реальный SDK child SessionManager/header удостоверяет точные `session_id/session_file/parent_session_file/cwd`, а immutable receipt сохраняет исходную task-call/WorkIdentity lineage. Private host resolver проверяет текущий root claim, branch/worktree/run, stage/generation/iteration и единственность соответствующего accepted assignment; digest входных outputs и raw immutable bytes должны совпасть. Возвращается только существующий receipt. Этот путь не создаёт `StageHostBinding`, grant, reservation, publication, format-error context, terminal или advance и не выполняет tool callback. Отсутствие SDK parentToolCallId не заменяется выдуманным active-worker proof; unknown execution остаётся unknown.

Root ownership идемпотентен только для того же session **и process**. Другой живой процесс с тем же SDK session получает `run_busy`; после подтверждённой смерти прежнего coordinator новый owner получает свежие token/epoch и сохраняет точные pending worker IDs. Старый epoch в worker ID допустим только для ID, уже находящегося в текущем locked claim, при его действующих token/epoch; новые IDs обязаны соответствовать новому epoch. Это сохранение reservations, а не восстановление worker grants или доказательство terminal.

Историческое `started/running` не доказывает liveness после смены host owner. Ordinary dispatch получает engine-owned `origin_ownership_epoch` из текущего claim внутри того же admission lock; отсутствие поля в legacy записи не мигрирует её в live. Recovery сравнивает epoch с текущим claim и сохраняет unknown до свежего authoritative observation. Исторические terminal/not-started proofs при этом не обесцениваются, а смерть coordinator не считается terminal worker. Replacement получает новую canonical worker identity: повторное использование worker ID старого execution запрещено, иначе его поздний terminal мог бы снять reservation нового worker.

Fresh native observe/reconnect receipt записывает `StageRecoveryLineage.lifecycle_owner_epoch` под текущим claim. После смены owner исторический running/disconnected не считается liveness; новая подтверждённая host observation может заново подтвердить прежний worker ID без подмены identity.

Prepared native replacement может пережить owner handover до первого task admission: его exact `replacement_identity` и budget не переписываются под новый epoch. Canonical native admission под существующим workspace lock проверяет ready permit/current claim, резервирует именно этот ещё не запущенный ID и только затем consumes permit/persists assignment. Узкий internal-only run-store путь не экспортируется из public barrel; public `reserveExecutionClaimWorkers` сохраняет строгую epoch-проверку и не получает recovery-ID bypass. Crash между reservation и stage write оставляет ready permit + reservation для идемпотентного продолжения; rollback снимает только IDs, добавленные данной попыткой, никогда preexisting/shared reservation. Второй ledger, новый public credential и произвольный old-epoch допуск не вводятся.
На этот handover fix `NativeStageOwner` — единственный writer `engine/run-store.ts` и native authority, `NativeEvidenceOwner` — native stage admission; Main отвечает за integration. Internal reservation helper повторно проверяет exact canonical operation/replacement identity под тем же lock и возвращает только вновь добавленные IDs.
Один SDK task batch не может разрешить два child executions в один recovery dispatch/worker ID. Все canonical scope groups одного SDK вызова планируются под одним CTO lock на одном in-memory state до любой reservation/consume/publication. После успешной проверки всех groups admission резервирует объединённые worker IDs один раз и публикует state один раз; ошибка любой группы оставляет durable assignments/permits/claims неизменными. При ошибке publication снимаются только вновь добавленные IDs. Исходный state сохраняет CAS snapshot; отдельный clone не теряет optimistic-concurrency provenance. Duplicate resolved identity отклоняет весь batch; разные легитимные slots не запрещаются по одному только совпадению agent name. Internal `reserveNativeStageAssignmentsBatch` заменяет последовательный single-group путь без compatibility wrapper. Registered duplicate RED→GREEN: `C:R06`, `artifact://3844` → `artifact://3846`; cross-scope regression на двух настроенных orchestrator lead slots PASS (`artifact://3865`): ошибочный batch не меняет assignments/claims/permits, затем корректный batch допускает обе команды.

Cold replay в обоих маршрутах проверяется через отдельную регистрацию child extension, а не вызов root-registered tool с child context и не повтор старых task_call/started. Existing private authority registry хранит callback живого root owner, зарегистрированный по cwd/owner ещё до выбора run. Callback каждый раз получает актуальный controller-held ordinary/CTO claim из настоящего root SDK lifecycle context, возвращает discriminated snapshot с authority/run/context (CTO дополнительно claim_scope) и проверяет requested run, если он указан; несколько различных подходящих owners запрещают replay, shutdown удаляет association. Child controller не обязан владеть root run. Generic private acceptedReplay hook предшествует derivation live producer binding и вызывает соответствующий canonical read-only reader под existing workspace lock. SDK child lineage и immutable receipt доказывают только право прочитать собственный exact accepted result; root mutation/worker publication grant не создаётся. Receipt, parent-session path и persisted credentials не являются источником root authority. На время ordinary reader `engine/durable.ts` единолично принадлежит OrdinarySubmissionOwner; loop fixes и admission origin provenance сохраняются.

Оба locked reader возвращают только внутренний candidate `{ identity, receipt: StageReceiptLedger }`; public DTO строится существующим единым `receiptFromLedger` в service/host integration. Durable reader не импортирует service runtime и не дублирует projection. Cold lookup допускает только `producer.kind="worker"`: совпадение SDK session не разрешает impersonation принятого orchestrator/tool результата.

`result_accepted` не означает, что worker перестал исполняться и не означает terminal для producer другого вида. Для `producer.kind="worker"` terminal transport receipt и result acceptance учитываются отдельно; для `orchestrator` и `tool`, включая main-session `lecture_acquire`, отсутствие worker terminal является ожидаемым и core MUST NOT его фабриковать. До перехода проверяются все условия профиля, отсутствие конфликтующего незавершённого worker execution и актуальные approvals. Потерянный ответ submission не требует нового worker. Внешние side effects нельзя сделать exactly-once одной квитанцией; при неизвестном исполнении replacement запрещён.

### 3. Программный gate завершения этапа

Единый evaluator проверяет актуальный profile stage, output/fan-in readiness, approvals и version scope. Ordinary вызывает его из текущего advance пути. CTO использует тот же смысл evaluator через native binding и revision-checked state commit: нельзя отметить slice/stage завершённым только утверждением lead или root. Не объединяем хранилища ordinary/CTO и не направляем CTO slug в ordinary tools.

Profile остаётся владельцем порядка review/QA и policy-auto: не вставляем универсальный review внутрь каждого этапа. Planning consent и result approval различаются. Новый результат/rework invalidates только затронутые downstream approvals и readiness; upstream evidence сохраняется. Next-dispatch authorization идемпотентна по transition identity и сверяется с ledger при повторе после crash.

Для ordinary исходный capability/cursor уже входит в public advance request. `TeamState.advance_receipts` хранит именованный `StageAdvanceReceipt` по исходному `capability_id`: `request_hash`, `from_stage_cursor/from_cursor_epoch`, `to_stage_cursor/to_cursor_epoch`, `committed_at`. Receipt записывается в том же canonical journal, что и переход. `request_hash` — SHA-256 канонической authorization identity вместе с token; plaintext token не сохраняется, свободный текст `evidence` в hash не входит. После обычной проверки host/current ownership совпавший receipt разрешает только read-only replay с `replayed: true` и текущим состоянием, включая случай уже начатого downstream этапа; он не создаёт новый capability, handoff secret или dispatch. Изменённая authorization identity/token для того же ключа отклоняется. Владельцы: `LoopExecutionOwner` — reducer, `OrdinarySubmissionOwner` — named type/strict validators, `RecoveryHostIntegration` — read-only host response; `Main` — интеграция.

Конкретная native advance boundary — `cto_stage_advance({ slice_id })`: authorization остаётся реальным root claim и никогда не становится synthetic lead/worker binding. Зарегистрированный execute call передаёт private `operation_id` в canonical transition/history для durable exact-request replay, а public parameters остаются только `{ slice_id }`. Свежий call оценивает current stage; `ready`/no-assignment heuristics MUST NOT принять legitimate orchestrator next stage за replay. Native canonical atomic validation проверяет receipt, worker terminal, fan-in, DoD, checkpoint phase/policy, current result, loop state, revision и ownership; idempotent replay сообщает уже достигнутое состояние. Model не передаёт stage, cursor, receipt или token, а candidate `cto_state` не может inject progress. `NativeStageOwner` factors shared private transition только после real root/lead checks; `RecoveryHostIntegration` остаётся index writer, а `Main` владеет URI gate. Normal registered progression обязана проходить эту boundary; fixtures MUST NOT jump persisted state.

### 4. Recovery — ограниченный протокол, не отключение guards

Рабочее имя coordinator tool — `workflow_recover`: diagnose/reconcile выбранного контекста, без model-supplied authority. Результат содержит code, observed worker state, action taken, retry budget, blocking condition и next allowed action. Typed directives потребляются orchestration adapter; исправимый отказ инициирует этот путь автоматически, а не только советует модели поискать tool. На следующем входе в сессию незавершённое recovery сверяется до новых dispatch.

`RecoveryHostIntegration` вызывает тот же private recovery executor из trusted preflight/terminal callbacks после записи canonical evidence и на resume после восстановления owner selection. Повтор одного события использует стабильный private operation identity, связанный с canonical dispatch/outcome; автоматический и явный вызовы не удваивают очередь, permit или расход бюджета. Автоматический путь не спрашивает новый UI grant: исчерпание бюджета остаётся явным ожиданием, а bounded grant проходит через явный `workflow_recover`. Child/native событие не получает root authority из текста или только потому, что fixture использует один `pi`: необходим существующий verified owner/lineage bridge. Acceptance A01/A02 наблюдает queued continuation до любого явного mutating `workflow_recover`; unknown/live outcome не разрешает replacement.

Read-only diagnosis требует authenticated host/worktree, но не действующего stage token: иначе recovery блокировался бы тем же устаревшим handoff. Mutation отдельно требует точного selection, live ownership и revision. Нельзя использовать recovery для обхода отсутствующей identity, чужого claim или human approval. Если интеграция не даёт даже trusted host identity, выдаётся безопасная интеграционная диагностика без изменения состояния, а не фиктивный recovery success.

Контракт read-only current-handoff и root-lineage/generation будет зафиксирован после согласования `RecoveryPersistenceOwner` и `NativeStageOwner`; до этого неподтверждённые native capabilities остаются unknown/unsupported. Planning artifacts не объявляют полный PASS или доказанный host smoke.

| Наблюдение host | Действие | Запрещённый вывод |
|---|---|---|
| Доказанный отказ до старта | Записать failed/not-started, разрешить исправленный retry с `retry_of` | Каждый generic tool error означает незапуск |
| Worker жив, transport доступен | Reattach/observe по поддерживаемому adapter contract | Создать замену для удобства |
| Worker жив, transport недоступен | Ограниченная сверка, затем объяснимое ожидание | Timeout означает terminal |
| Подтверждён terminal failure/cancel | Resume если host поддерживает, иначе связанный replacement с контекстом | Старый worker продолжает писать параллельно |
| Неизвестный статус | Сохранить pending и способ повторной сверки | Удалить claim/state или придумать terminal |
| Ошибка сдачи | Field errors producer-у; после его terminal — assignment только на восстановление сдачи | Coordinator сочиняет evidence либо запускает всю реализацию заново |
| Устаревший handoff | Проверить ownership и выдать актуальное продолжение | Подбор token или downgrade trust |

Существующие terminal enums/receipts расширяются только необходимыми причинами, а не дублируются вторым ledger. Native preflight rejection должен быть подтверждён host событием с исходной call/dispatch identity. Если host не даёт такого события, известные deterministic ошибки валидируются в adapter до reservation; непроверяемый исход после передачи host остаётся unknown. Нельзя парсить произвольную фразу модели как proof незапуска.
Ограниченный R06 contract: malformed scoped entry с валидными current marker, exact slot, agent и call identity может быть engine-authenticated как rejected attempt до старта worker. Existing ordinary `authorizeRecord` и native `reserve` владеют mint exact replacement identity и записью `not_started` terminal в том же journal; host identity не фабрикует. Exact returned canonical dispatch становится `retry_of`. Empty batch, ambiguous/untracked scope и generic error остаются `unknown`, не `not_started`. Owners: `LoopExecutionOwner`, `OrdinarySubmissionOwner`, `NativeStageOwner`/native CTO reserve, `RecoveryHostIntegration` и `RecoveryAcceptance` fixtures. Никаких новых ledgers, public credentials или Task API.

При pinned OMP 18 нет direct task-execution API; `directTaskTool` и internal executor не вводятся. Canonical recovery prepare создаёт в существующей `stage_recovery` operation queued replacement `WorkIdentity/retry_of` и bounded admission permit. Adapter через реальный host `sendMessage` доставляет актуальный handoff и сообщает только `authorized`/`queued`/`not_started`; обычный task admission одноразово atomically consumes permit вместе с созданием dispatch. Только runtime events доказывают `running`/`terminal`. Состояния ready/consumed permit сохраняются независимо от operation ack, replay возвращает ту же identity. `RecoveryHostIntegration` — единственный writer host integration/index surface, integration owner остаётся `Main`.

Если host queue adapter возвращает Promise, replacement evidence/ack появляется только после его успешного завершения; синхронный SDK `sendMessage` сохраняет прежний смысл queued. Ошибка async delivery не превращается в ack. Registered concurrency проверяет удержанный реальный callback, competing reconcile и единственный permit/identity, а shutdown дожидается зарегистрированных lifecycle observers и automatic recovery до удаления собственного fixture root.

Exact ready/consumed permit MUST be derived from the canonical ledger inside the ordinary `authorizeRecord` or native `reserve` transaction. One commit consumes the permit, persists the ledger transition, and creates the exact owner-minted replacement identity together with dispatch. No index pre-consumption and no public `recovery_admission` credential are allowed. If caller omits `retry_of`, only a unique canonical prepared parent may resolve it; an explicit mismatch is denied. Permit lifetime is independent of operation prepared/acked state: queued `sendMessage` acknowledgment MUST NOT invalidate a ready permit.

Persisted recovery decisions расширяют существующие `TeamState`/`CtoState`, а не создают другой store: `stage_recovery?: { schema_version: 1; lineages: Record<string, StageRecoveryLineage> }`. Initial recovery `generation` равен `0` и независим от `WorkIdentity.attempt >= 1`; stable lineage key ограничен `run/generation/wave/slice/stage/iteration/slot/root_dispatch`; retries reuse existing budget, distinct workers append history и не перезаписывают друг друга. `RecoveryPersistenceOwner` владеет named shape и strict validator, а existing types/validators применяются ordinary и native paths. Canonical journals сохраняют только safe events, budgets, grants и operations; live ownership и selection proofs каждый read выводятся из current claim. Credentials и поля вроде `authenticated: true` никогда не сохраняются как authority.

Host transport adapter объявляет поддерживаемые inspect/observe/resume/cancel возможности и возвращает typed unknown/unsupported там, где их нет. Конкретный runtime capability probe фиксируется до реализации adapter и затем contract test; основной алгоритм уже определён для обоих вариантов. Это не повод строить несуществующий reconnect API или ослаблять сохранение pending.
Для pinned OMP 18 `pi.sendMessage` с `followUp` только ставит coordinator continuation в очередь и не доказывает, что тот же producer принял correction или продолжил running. В default host отсутствует format-repair callback, а `format_repair`/`producer_correction` помечаются unsupported; фактический invalid submission всё равно возвращает тому же caller точные schema errors. Положительный format-repair доказывается только truthful injected host; fabricated ack и default implementation replacement для type errors запрещены. Этот предел фиксируется как unsupported/unknown и не считается native H PASS.

Budget contract уточняет существующий default и не расширяет scope: budget сохраняется на error class + assignment/generation. Для известных recovery classes `preflight_not_started`, `terminal_failure`, `cancelled`, `format_validation`, `transport` при отсутствии persisted class default — `limit=2`, `used=0`; read-only snapshot может project этот default без journal write, а existing owner prepare materializes и atomically consumes его. Persisted explicit limits, включая `0` или exhausted, имеют приоритет; неизвестные classes получают default `0`; linked retry/restart в той же root lineage budget никогда не сбрасывают. `RecoveryPersistenceOwner` хранит budgets для ordinary и native CTO. Текущий empty-budget bug блокирует первый R06; H/P claims не заявляются. Повтор доставки одной операции бюджет не расходует, повтор реального действия расходует. Для содержательных циклов используется лимит профиля (debug-cycle: 3 полных итерации). Не перемножаем вложенные retries: одна причина имеет один owning budget. Явное пользовательское продолжение после исчерпания записывает основание нового ограниченного бюджета. Backoff проверяется виртуальным временем, таймер не является доказательством terminal.

### 5. Реальные циклы доработки

Loop-back изменяет durable cursor/iteration и выдаёт новый scope для фактических diagnostics, implementation и verification. У первой diagnostics нет зависимости от будущего verify; retry получает последнее FAIL evidence. Счётчик увеличивается при реально начатой новой итерации, а не при синтетическом прогоне walker. После PASS открывается downstream; после предела сохраняется escalation без QA/summary как будто успех достигнут.

Review changes-requested выбирает предусмотренный профилем путь исправления, повторного review и зависимых проверок. Форматная ошибка submission не меняет смысл итерации реализации. При recovery обязательные human checkpoints не исчезают; policy-auto не превращается в обязательный вопрос пользователю.

Native CTO human boundary — concrete `cto_checkpoint_ask({ slice_id })` API: `Main` derives active CTO run/claim, native preflight derives current profile checkpoint, phase, policy и result scope, а real host UI answer commits via native canonical revision/identity revalidation; replay возвращает existing current decision. Ordinary tools, selectors и tokens MUST NOT использоваться для CTO. Candidate `rootcto_state` MUST NOT inject native progress, receipts или approvals. Это существующая граница R03–R05/R24, а не новый workflow scope.

### 6. Детерминированная приёмка вместо LLM как test runner

Три уровня, без новой платформы:

1. **D — registered scenarios:** реальные command renderers/registration, tools/hooks, controller, durable state и временная файловая система. Маленький scripted host подаёт действия модели, worker events и dialog answers; бизнес-решения делает production code. Успех fake worker — входное событие, не подмена acceptance engine. Нельзя писать canonical state для прохождения сценария; fixtures готовятся обычным ingress. Corruption cases отдельно вносят объявленное повреждение и проверяют отказ, не repair.
2. **P — process scenarios:** реальные дочерние процессы и persistent temp store для restart, crash-boundary и races. Barriers/inboxes задают порядок; `sleep` не служит синхронизацией. Используются существующие process fixtures, не новый daemon/harness.
3. **H — host smoke:** установленный кандидат и закреплённый OMP проверяют discovery, реальные callbacks, native binding/result delivery и человеческий UI. Эти проверки не перебирают recovery-матрицу.

Новые root commands, которые предстоит реализовать: `npm run test:workflow-scenarios` (D) и `npm run test:workflow-process` (P). Они используют `node:test`/`tsx` и явный список сценарных suites; обычный `npm test` остаётся полным gate. Никаких provider credentials, global HOME/store или запросов сети для D/P. CI запускает эти команды явно. Начальный целевой бюджет D — 60 секунд, P — 180 секунд после установки зависимостей на CI runner; измеряется весь запуск. Превышение требует анализа, не переноса проверки в ручной QA. Timeout отдельного теста — предохранитель, не assertion бизнес-логики.

Сценарий задаётся типизированной последовательностью событий и assertions в существующих тестах, без отдельного DSL. Фиксированные fixture values и узкие time/transport hooks добавляются только где нужны. Семантический trace нормализует UUID/temp paths, но сохраняет identity-связи, ordering, attempts, state revisions, verdicts и counts. Одинаковое расписание воспроизводимо; небольшой фиксированный набор перестановок проверяет поздние события и races. Универсальная property-testing библиотека не требуется.

Семантический trace выдаётся на фактической ALS-границе через структурированные diagnostics `@@OMP_SCENARIO_TRACE@@`. `SemanticTraceReporter` — единственный writer для `scripts/workflow-scenarios.mjs` и нового standalone `core/test/reliable-stage-trace.ts`; runtime API ограничен `scenarioTest` и `recordScenarioEvent`. `scenarioTest` принимает несколько точных тегов в одном имени (например, `[O:S01][O:R06]`) и выдаёт `scenario_ids`; `ScenarioEvent` поддерживает route `O|C`, а каждое событие в смешанном O+C trace обязано иметь явный route, иначе reporter завершает проверку как ambiguous/missing, не угадывая. Caller source locators сохраняются и sanitise-ятся. Reporter требует реальный trace и завершается ошибкой при пропущенных ID или event gaps. `Internalworkflow-registration-scenarios.test.ts` входит в существующий D suite; это уточняет §6/§8 без расширения scope.
`ScenarioEvent.kind` имеет конечный набор: `workflow_registered|workflow_started|workflow_completed`, `stage_registered|stage_entered|stage_exited|stage_submitted`, `tool_registered|tool_called|tool_completed`, `worker_admitted|worker_started|worker_completed|worker_failed`, `attempt_started|attempt_completed`, `revision_created|revision_published`, `verdict_recorded`, `count_recorded`, `checkpoint_issued|checkpoint_accepted|checkpoint_rejected`, `artifact_published`, `fault_injected|fault_observed`, `barrier_wait|barrier_released|barrier_timeout`, `recovery_diagnosed|recovery_reconciled`, `retry_started|retry_completed`, `run_completed`. Поля события ограничены безопасными идентификаторами `workflow/stage/phase/tool`, identity/link keys `run/stage/attempt/revision/worker/dispatch/checkpoint/barrier/task/receipt` и relation keys; для смешанного O+C trace указывается route `O|C`.

### 7. Конечная матрица сценариев

Обозначения: O — ordinary, C — native CTO. Для O+C общий контракт параметризуется двумя реальными bindings, а не выполняется только на общем helper. D — основной уровень для каждой строки; P добавляется там, где указано. Все scenario IDs из specs должны иметь test-case mapping и фактический outcome; исходно это план, не PASS.

| ID | Маршрут / уровень | Обязательный oracle помимо успешного ответа |
|---|---|---|
| S01 | O+C / D | Valid own `worker` output gets exact binding/receipt, соседнее состояние неизменно |
| S02 | O+C / D | Foreign/stale/replayed worker and model worker-impersonation отклонены, ни одного published output |
| S03 | O+C / D | Field error → исправление; implementation dispatch count неизменен |
| S04 | O+C / D | Missing/path traversal/symlink отказ; нет внешней публикации |
| S05 | O+C / D | Slot isolation и отсутствие advance до полного fan-in |
| S06 | O+C / D+P | Commit → lost response → restart → тот же receipt, одна версия |
| S07 | O+C / D | Conflict не изменяет digest/refs принятого результата |
| S08 | O+C / D+P | Crash до commit: нет видимого частичного результата, штатное восстановление |
| S09 | O+C / D | Terminal без submission не завершает этап; repair не реализует повторно |
| S10 | O+C / D | Accepted result без approval не открывает downstream |
| S11 | O+C / D | Старые outputs byte-identical после wave/rework |
| S12 | O+C / D | История читаема, старый producer не авторизует новый assignment |
| S13 | O+C / D | Own profile-declared `orchestrator` output accepted for the assigned scope; no worker terminal synthesized |
| S14 | O+C / D | Own profile-declared `tool` callback output accepted; exact callback proof and immutable receipt, no approval/terminal substitution |
| S15 | O+C / D | Unregistered, wrong-host, wrong-stage, replayed or forged tool callback rejected before publication |
| S16 | O / D | `lecture_acquire` worker/foreign/non-main invocation rejected; current main-session acquisition callback alone may publish through core API |
| S17 | O / D | `product_prd_document` uses declared executable renderer/sources, byte-identical safe document + typed hashes, same immutable receipt path; no model submission or worker terminal |
| R01 | O+C / D | Точная missing condition, cursor и downstream count неизменны |
| R02 | O+C / D+P | Replay/crash и повтор перехода не создают второй next dispatch |
| R03 | O+C / D | Planning consent не удовлетворяет result approval |
| R04 | O+C / D | Старый approval denied, актуальный accepted один раз |
| R05 | O+C / D | policy-auto без UI; required-human без решения не проходит |
| R06 | O+C / D | Preflight отказ → corrected call, terminal linkage, один фактический старт |
| R07 | O+C / D | Disconnect/reconnect, сохранён worker ID, late result принят один раз |
| R08 | O+C / D | Подтверждённый failure: supported resume и unsupported→replacement варианты |
| R09 | O+C / D+P | Unknown после restart: нет replacement, pending сохранён |
| R10 | O+C / D | Уточнение либо cancel-ack перед replacement, без двух writers |
| R11 | O+C / D | Stale handoff → trusted refresh, без сброса cursor |
| R12 | O+C / D | Foreign owner/branch/identity/corruption различимы, нет мутации/секретов |
| R13 | O+C / D+P | Две recovery операции, один winner/replacement |
| R14 | O+C / D+P | Лимит не сбрасывается restart; явное разрешение восстанавливает bounded budget |
| R15 | O+C / D | Ошибки возвращены producer; coordinator не создаёт missing evidence |
| R16 | O+C / D | Реальные counts diagnose/implement/verify=2, FAIL input во второй diagnose, downstream только после PASS |
| R17 | O+C / D | Ровно максимум реальных итераций, последнее FAIL evidence, downstream=0 |
| R18 | O+C / D | Fix → review → checks; upstream неизменён и старое approval недействительно |
| R19 | C / D | Root bypass denied; configured lead/roster accepted, ordinary tools не нужны |
| R20 | C / D | Resident без новых workers; новая волна сохраняет прошлые refs |
| R21 | O+C / D | Terminal release, настоящие registered host tool gates разрешают обычную работу |
| R22 | C / D+P | END с pending: сначала stop acknowledgment, затем release; unknown не освобождает claim |
| R23 | O / D | session_stop после classify → Proceed; replay/foreign/supersession denied |
| R24 | O+C / D+P | Pending checkpoint restart: same result/dispatch, один актуальный approval/advance |

**Обязательный интегрированный D-сценарий A01/A02**, отдельно параметризованный O/C: session_start → настоящий registered ingress и выбор профиля → start stage → authoritative preflight refusal → автоматический recovery → corrected dispatch → worker submission и terminal → попытка advance без approval (отказ) → настоящее checkpoint решение через scripted host UI и production handler → успешный advance → один dispatch следующего этапа. Все шаги выполняются на одном run и одном persisted store без сброса fixture и прямой правки state. Assertions после каждого шага проверяют сохранённую identity, failure/retry linkage, ровно один реальный старт worker текущего этапа, один receipt, downstream=0 до решения и downstream=1 после него. Набор отдельных R06/S10/R01 tests не заменяет эту сквозную цепочку.

A03 — повтор D дважды с чистыми temp roots и в полном suite; A04 — S06; A05 — R13; A06 — сохранённые RED/GREEN #73/#76; A07 — проверка полноты ID mapping; A08/A09 — H smoke и классификация его исхода; A10 — итоговый отчёт и отсутствие самовольного расширения scope. Не создаём tautological тесты текста specs или повторения fixtures ради этих IDs.
A11 — D запускает S01/S02/S13/S14 с настоящими registered ordinary и CTO bindings; A12 — negative matrix для worker impersonation/foreign/stale и callback authenticity; A13 — callback authenticity tool и изоляция конкурентных context; A14 — main-session restriction `lecture_acquire` и trusted publication (без arbitrary file path); A15 — контракт deterministic `product_prd_document` renderer и тот же publication/receipt path. Эти additions сохраняют no-network D budget и не заменяют существующие S/R/A cases.

### 8. Test-first и окончание QA

Для каждого нового поведения: минимальный consumer-visible scenario → RED по ожидаемой причине → минимальная реализация → GREEN → refactor при сохранении сценария. RED от синтаксической ошибки теста, отсутствующей зависимости или неверного fixture не считается дефектом продукта. Для уже работающих путей используем существующий PASS, не ломаем код ради демонстрации RED и не плодим дубли.

Итоговый report: scenario ID/route, code revision/candidate, event schedule/fault point, assertions, PASS/FAIL/BLOCKED, duration и безопасный evidence path. Прямые setters state допустимы только в узких unit tests или в явно обозначенном corruption input; сквозную приёмку они не доказывают. Не фиксируем точные тексты подсказок, числа tools и incidental defaults вместо поведения.

Конечный H-набор (не запускается при планировании):

- **H1 ordinary:** discovery зарегистрированной команды и submission tool → classify-only turn-stop → Proceed → native worker сдаёт результат → реальный human checkpoint → завершение и обычное host действие.
- **H2 CTO:** configured lead → roster worker → сдача → настоящий post-production approval → завершение волны → явный END → обычное host действие. Не имитировать команду вставкой похожего prose.
- **H3 восстановление host-сессии:** закрытие на настоящем pending checkpoint без активного worker, новый host → точный resume → решение → один переход без повторной реализации. Native reconnect живого worker проверяется здесь только если закреплённый adapter действительно поддерживает его; иначе явно доказывается unsupported/unknown без дубля, а не выдумывается reconnect PASS.

На каждый H-case максимум один исходный запуск и один повтор после установленной причины и исправления; начальный wall-clock budget — 15 минут на попытку с явным abort/cleanup. Timeout означает BLOCKED/FAIL по установленной причине, не автоматический product defect. Изменение бюджета или состава gate требует явного решения по плану, не бесконечного возобновления. Реальный discovery/host smoke не заменяется in-process harness. Нет blanket re-run всех H на каждую prompt правку: повторяется затронутая граница, итоговый candidate фиксируется, совместимость прежнего evidence обосновывается по изменённым runtime assets.

### 9. Владельцы записи и направление зависимостей

На реализации назначаются роли владельцев до параллельных edits:

| Область | Единственный владелец записи | Контракт |
|---|---|---|
| core registration/public exports | `Main` | Общий `StageProducerBinding`/receipt contract и интеграция ordinary/native; consumers не создают binding из payload |
| core command prompts/registered command surfaces | `CoreCommandCutover` | `commands/{do-work,cto,register}.ts` и fullstack agent allowlists; только model-facing outputs-only envelope и trusted ingress |
| ordinary engine submission/gates | `OrdinarySubmissionOwner` | `src/engine/stage.ts`, `types.ts`, `state.ts`, `lifecycle-journal.ts`, `reliable-stage.ts`, `profile.ts`, `artifacts.ts`, validators и ordinary submission/gate tests; владеет private current-stage renderer helper, descriptor-safe evidence reader, ordinary submission/host hooks (не recovery integration/index и не registration bridge), reconciles existing normalization migration receipt to actual schema 2 и направляет все trusted CTO producer kinds (`worker`/`orchestrator`/`tool`) через native committer; `src/engine/durable.ts`, `run.ts`/`loops.ts`, `stage-recovery.ts` и `engine/stage-recovery-store.ts` исключены |
| loop execution | `LoopExecutionOwner` | Единственный writer `src/engine/durable.ts`, `src/engine/run.ts`, `src/engine/loops.ts`, `src/engine/fan-in.ts` и соответствующих loop/fan-in tests, включая `core/test/reliable-stage-loop.test.ts`; fan-in переходит целиком на canonical receipts без fallback к `slot_artifacts`/completion metadata даже для старых fixtures; используется shared descriptor-safe evidence reader |
| quiescent migration | `QuiescentMigrationOwner` | Единственный writer `src/engine/run-migration.ts` и relevant ordinary migration tests; только quiescent migration, без второго framework или top-level schema bump |
| recovery seam | `RecoveryImplementation` | Только новый `src/engine/stage-recovery.ts` и `core/test/reliable-stage-recovery.test.ts`; использует canonical hooks OrdinarySubmissionOwner, не пишет recovery stores |
| recovery persistence | `RecoveryPersistenceOwner` | Только новые `src/engine/stage-recovery-store.ts`, `src/cto/stage-recovery-store.ts` и recovery-store tests; реальные canonical ports на existing locks/journals, shared persisted fields/validators согласуются с original owners, второго store не создаёт |
| recovery host integration/index/registration bridge | `RecoveryHostIntegration` | Единственный writer recovery host integration/index и registration bridge для canonical recovery prepare/dispatch; `Main` остаётся integration owner, но не конкурирует за этот bridge |
| native CTO authority | `NativeStageOwner` | `src/native-worker-authority.ts`, CTO state/types/migration и native tests; `src/cto/native-stage.ts` передан NativeEvidenceOwner, конкурирующая запись запрещена |
| native canonical stage и immutable evidence/receipt commit | `NativeEvidenceOwner` | Единственный writer `src/cto/native-stage.ts` и `src/cto/native-stage-execution.ts`; canonical transition/read-only replay reader и immutable evidence/receipt commit для всех producer kinds |
| cold accepted-receipt replay | `NativeStageOwner` | На время этого cutover единолично владеет `src/engine/reliable-stage.ts` вместо ordinary owner; private read-only hook и SDK lineage helper. Canonical reader принадлежит NativeEvidenceOwner. `RecoveryHostIntegration` единолично подключает hook к реальному SDK/root controller в index; никаких caller-supplied verified flags или persisted credentials |
| registered acceptance fixtures | `RegisteredAcceptanceOwner` | `core/test/reliable-stage-execution.test.ts`, новый `reliable-stage-execution-process.test.ts` и выделенный shared registered helper; не дублирует engine |
| native producer acceptance | `Main` (после handback) | `NativeProducerAcceptance` завершил передачу; `Main` теперь единственный writer `core/test/reliable-stage-execution-producers.test.ts`, сохраняя ordinary coverage и CTO S13/S14/S15 и A11/A12/A13 |
| renderer acceptance | `Main` (после handback) | `RendererAcceptance` завершил передачу; `Main` интегрирует новый `core/test/reliable-stage-renderer.test.ts` (включая недостающий `Harness` type import), S17/A15 через registered `workflow_begin` после canonical admission, private current-stage helper, без whole walker/downstream и нового public tool |
| stage gate acceptance | `Main` (после handback) | `StageGateAcceptance` завершил передачу; `Main` единолично интегрирует `core/test/reliable-stage-gates.test.ts`, включая fan-in, checkpoint policy, immutable replay и journal recovery |
| semantic trace/reporter | `SemanticTraceReporter` | Только `scripts/workflow-scenarios.mjs` и новый standalone `core/test/reliable-stage-trace.ts`; владеет `scenarioTest`/`recordScenarioEvent`, ALS boundary `@@OMP_SCENARIO_TRACE@@`, multi-ID traces и gap-failing report; после handback runner возвращается `Main`, legitimate flows не дублируются ради tags |
| lifecycle acceptance | `LifecycleAcceptanceOwner` | Sole writer `core/test/reliable-stage-lifecycle.test.ts` после повторной передачи от Main; R24 использует shared registered harness, настоящий worker submission/terminal и fresh-owner resume с неизменными receipts/dispatches, без direct reservation/synthetic worker events; ручной completed DoD удалён Main и не восстанавливается |
| fullstack adapters/commands/agents/tests | `FullstackImplementation` | Потребляет public core API; не владеет lecture tool cutover |
| internal bundle/adapters/tests | `InternalImplementation` | Тот же public API, отдельные private integrations и internal agent allowlists; `Internalworkflow-registration-scenarios.test.ts` входит в D suite и использует production registration |
| e2e process/native scenarios/tests | `AcceptanceImplementation` | Использует public API; не дублирует engine |
| root scripts, CI, lockfile, общие docs, integration и OpenSpec | `Main` | Сводит контракты, callers и финальную матрицу; после handback `Main` сохраняет integration ownership и единолично владеет root runner/CI/shared docs/OpenSpec, а `RecoveryHostIntegration` остаётся sole writer recovery host integration/index/registration bridge |
Agent allowlist boundary: `CoreCommandCutover` владеет fullstack agent allowlists, `InternalImplementation` — internal allowlists; отсутствие `submission`/`recover` в producer/lead frontmatter не трактуется как SDK impossibility и не меняет trusted ingress contract.

Один человек/агент может владеть несколькими областями. `Main` единолично владеет public exports (`src/index.ts` и общие exports), integration coordination и после handback root runner/CI/shared docs/OpenSpec; `RecoveryHostIntegration` единолично пишет recovery host integration/index и registration bridge. Designated owners могут изменять согласованные shared engine contracts/types после explicit approval от Main, а consumers не создают binding из payload. Решение записывается в design, затем передаётся потребителям; сообщение само по себе не заменяет контракт. Новых пакетов и перемещения текущей карты ответственности не планируется.

После handback основной реализации и полного consumer-прогона `bg_535` действует следующая интеграционная передача; для перечисленных файлов она заменяет прежние writer slices ниже. Остальные product owners сохраняют freeze, `Main` — единственный integration owner и исполнитель последовательных проверок.

| Интеграционный участок | Единственный writer |
|---|---|
| `core/src/engine/run.ts`, `core/src/engine/stage.ts` — interpreter → настоящий registered producer, без превращения exit 0/payload в receipt | `InterpreterCutover` |
| `core/src/native-worker-authority.ts` — trusted lifecycle settlement перенесённого worker после смены ownership epoch | `NativeStageOwner` |
| `core/test/checkpoint-ask*.test.ts`, `checkpoint-ledger*.test.ts` | `CheckpointConsumers` |
| `core/test/approval-closure.test.ts`, `durable-repeated-role.test.ts`, `durable-skip.test.ts`, `product-discovery.test.ts` | `DurableConsumers` |
| `core/test/native-worker-authority.test.ts` | `NativeConsumers` |
| `core/test/do-work-autonomy.test.ts` | `AutonomyConsumers` |
| `core/test/reliable-stage-execution-fixture.ts` — reusable registered interpreter adapter через production `createTaskCaller` | `InterpreterFixtureOwner` |
| `core/test/smoke.test.ts`, `validation-gate.test.ts` | `StagePrimitiveConsumers` |
| `core/test/optional-stage-inputs.test.ts`, `workflow-engine-scopes.test.ts` | `InputScopeConsumers` |
| `core/test/run-continuation.test.ts`, `run-lifecycle.test.ts`, `run-lifecycle-acceptance-process.test.ts` | `ContinuationConsumers` |
| `core/workflows/product-discovery.json`, `stages/{code_review,diagnose,manual_qa,qa_tests,review}.md`, workflows README и artifact schema description | `ShippedPromptCutover` |
| `core/test/reliable-stage-recovery.test.ts`, `lecture-research.test.ts`, `task-caller.test.ts`, `root-cause-gate.test.ts`, shared product contracts, docs и evidence report | `Main` |

Consumer fixtures обязаны получать результаты через настоящий producer submission/terminal path и admission batch context; запрещено ослаблять guards или записывать accepted receipts вручную. Interpreter сохраняет разделение transport completion и immutable producer receipt. Любое необходимое расширение shared contract сначала согласуется с Main; проверки выполняются после целостной передачи файлов.

Interpreter cutover сохраняет один `toolCallId` от canonical authorization до реального `TaskToolLike.execute`: `TaskCaller.call/batch` получают optional invocation options, `durable.authorize` — тот же ID. Child identity выводится из действительного SDK `parent_tool_call_id` и зарегистрированного host admission, не из transport result. Worker success без canonical receipt остаётся отказом; возврат `artifacts` и ручные JSON-инструкции не заменяют submission. Orchestrator callback возвращает `outputs`, публикуемые через existing trusted current-stage binding; запись произвольной artifact map исключается. Публичные `persistReturnedArtifacts`/`writeArtifact` не являются producer API и удаляются из barrel; внутренний `writeArtifact` сохраняется для engine-owned fan-in/checkpoint/journal операций. LSP references недоступны; текстовая карта refs подтверждает отсутствие иных package consumers этих публичных exports.

Registered interpreter передаёт в `run` действующий `WorkflowSessionController` через `sessionController`: lifecycle preparation выполняется этим же controller, чтобы canonical execution claim и его приватный bound token обновлялись вместе. До мутации проверяется соответствие controller, execution context и workspace. Совпадение session/process не разрешает пропустить canonical resume; fixture не восстанавливает opaque token и не ослабляет admission. Standalone API без SDK controller не получает synthetic worker binding. Потребители используют `controller.context()`, а не SDK `HostContext` с лишними полями.

Поздний SDK terminal после handover завершает только captured worker старого epoch, перенесённый в текущий claim: проверяется существующий historical release proof, а не подставляется token нового владельца. Новый worker сохраняется, повторный terminal не мутирует state. Это cleanup подтверждённого physical execution, не разрешение старому producer публиковать или создавать новый dispatch.

После реального H2/H3 smoke назначены непересекающиеся corrective slices: `OrdinarySdkTerminalRepair` единолично пишет `core/src/index.ts`, `core/src/native-worker-authority.ts`, необходимые внутренние adapter helpers и ordinary registered terminal tests; `StageAwareLeadRepair` — `fullstack/agents/team-lead.md` и `core/test/native-worker-authority.test.ts`. `Main` сохраняет integration ownership, OpenSpec/report/docs и последовательные проверки. Остальные writers не возобновляются.

H3 доказал ordinary async delivery: первоначальный SDK `task` result приходит до `started`, затем настоящий `task:subagent:lifecycle` сообщает exact `completed`. Этот terminal обязан дойти до existing ordinary durable reconciliation через проверенные parent tool-call/index/agent/child-session identity и актуальный claim, независимо от accepted receipt. Pending acknowledgment не удаляет origin, нужный позднему terminal; receipt/yield/`agent_end`/shutdown не заменяют terminal, wrong/stale scope и дубли не разрешают новую запись или повторную реализацию.

H2 доказал правильный отказ roster-worker в orchestrator `discovery`: текущий профиль объявляет только lead producer. Lead сдаёт собственные declared outputs через `workflow_submit_result`, сообщает receipt и ждёт authorized root checkpoint/advance; mandatory roster delegation применяется только после актуального worker-stage handoff. Инструкции не создают отсутствующий slot, не дают lead root-only authority и не ослабляют stage assignment guard.

Corrective handback интегрирован `Main`: registered `O:R25` воспроизвёл RED pending после exact SDK completed и стал GREEN через ordinary lifecycle bridge; отдельный native consumer провёл собственный lead receipt → root advance → declared roster worker. Captured claim/origin повторно проверяются под уже удерживаемой workspace transaction lock внутренним held-lock reader; nested lock и synthetic terminal исключены. Локальные D126×2/P8 и full suite 1681 PASS/0 FAIL подтверждают code snapshot, а docs-only delta имеет отдельный fingerprint.

Финальные реальные H2/H3 attempt 2/2 выполнил один native SDK `task` child через browser/e2e. H2 остановился до работы lead с `No model selected`: isolated root `--model` не обеспечивает отдельное SDK subagent role selection. H3 остановился до command ingress с exit 127; missing host modelRoles подтверждён, но причина 127 не установлена, доступность shebang `bun` в actual child PATH — лишь гипотеза. Все H бюджеты исчерпаны; cold restore/Hub revive не достигнуты и отмечены NOT_VERIFIED, новые Task identity/linkage fields или grants не фабрикуются. Для дальнейшей host-проверки нужны исправленные isolated model/runtime preconditions и отдельное разрешение на новые bounded попытки; текущие результаты нельзя объявить PASS или unsupported.

Текущие непересекающиеся core writer slices после передачи незавершённой реализации:

- `OrdinarySubmissionOwner`: только `src/engine/stage.ts`, `types.ts`, `state.ts`, `lifecycle-journal.ts`, `reliable-stage.ts`, `profile.ts`, `artifacts.ts`, validators и собственные ordinary submission/gate tests; владеет private current-stage renderer helper, shared descriptor-safe evidence reader, ordinary submission/host hooks (не recovery integration/index и не registration bridge), reconciles existing normalization migration receipt to actual schema 2 и route всех trusted CTO producer kinds через native committer. `src/engine/durable.ts` принадлежит `LoopExecutionOwner`; `run.ts`, `loops.ts`, `stage-recovery.ts` и `engine/stage-recovery-store.ts` исключены. Существующие `WorkIdentity`/engine types остаются shared public contract.
- `QuiescentMigrationOwner`: sole writer `src/engine/run-migration.ts` и relevant ordinary migration tests; migration только quiescent, без второго framework/top-level schema bump.
- `LoopExecutionOwner`: sole writer `src/engine/durable.ts`, `src/engine/run.ts`, `src/engine/loops.ts`, `src/engine/fan-in.ts` и соответствующих loop/fan-in tests, включая `core/test/reliable-stage-loop.test.ts`; canonical per-slot receipts заменяют legacy fan-in metadata без test-only fallback, durable использует shared descriptor-safe evidence reader; прежний `LoopWalkerOwner` больше не активен.
- `RecoveryImplementation`: только новый `src/engine/stage-recovery.ts` и новый `core/test/reliable-stage-recovery.test.ts`; не изменяет ordinary engine files, использует canonical hooks и не пишет recovery stores.
- `RecoveryPersistenceOwner`: только новые `src/engine/stage-recovery-store.ts`, `src/cto/stage-recovery-store.ts` и recovery-store tests; реализует canonical ports на existing locks/journals, согласует shared persisted fields/validators с original owners и не создаёт второй store.
- `RecoveryHostIntegration`: единственный writer recovery host integration/index и registration bridge; подключает canonical recovery prepare к реальному host `sendMessage` и обычному task admission, но не создаёт direct task API/internal executor, не конкурирует с `RecoveryPersistenceOwner` и не передаёт этот bridge `Main`.
- `NativeEvidenceOwner`: sole writer `src/cto/native-stage.ts` и `src/cto/native-stage-execution.ts`; canonical stage, locked read-only accepted replay и native immutable evidence/receipt commit для всех producer kinds, без competing writes.
- `NativeStageOwner`: `src/native-worker-authority.ts`, временно `src/engine/reliable-stage.ts`, CTO state/types/migration и собственные native stage tests; не пишет переданные `native-stage.ts`/`native-stage-execution.ts` и не создаёт synthetic worker identity.
- `RegisteredAcceptanceOwner`: только `core/test/reliable-stage-execution.test.ts`, новый `core/test/reliable-stage-execution-process.test.ts` и выделенный shared registered helper; Main больше не пишет integrated fixture.
- `NativeProducerAcceptance`: handback complete; `Main` — sole writer `core/test/reliable-stage-execution-producers.test.ts`, сохраняет ordinary cases и CTO S13/S14/S15, A11/A12/A13; не дублирует registered fixture/main/process.
- `RendererAcceptance`: handback complete; `Main` интегрирует `core/test/reliable-stage-renderer.test.ts` (включая недостающий `Harness` type import); зарегистрированный `workflow_begin` после canonical admission вызывает private current-stage helper OrdinarySubmissionOwner, без whole walker/downstream и нового public tool.
- `SemanticTraceReporter`: только `scripts/workflow-scenarios.mjs` и новый standalone `core/test/reliable-stage-trace.ts`; `scenarioTest`/`recordScenarioEvent` и ALS `@@OMP_SCENARIO_TRACE@@` boundary, multiple IDs per legitimate flow, gap-failing report; `Internalworkflow-registration-scenarios.test.ts` входит в D suite, но не создаёт duplicate tagged cases.
- `LifecycleAcceptanceOwner`: только новый `core/test/reliable-stage-lifecycle.test.ts`; использует public lifecycle/registration paths и не дублирует registered engine fixture.
- `LectureProducerCutover`: только `fullstack/src/tools/lecture-acquire.ts` и относящиеся к нему tests; владеет callback/public publication и main-session restriction.
- `Main`: `src/index.ts`, общие exports, root runner/CI/shared docs/OpenSpec, integration coordination и handback-accepted acceptance integration для `core/test/reliable-stage-execution-producers.test.ts` и `core/test/reliable-stage-renderer.test.ts`; после handback Main reclaims runner и сохраняет integration ownership, но не пишет recovery host integration/index или registration bridge и не конкурирует с command, loop, recovery, acceptance или lecture owners.
- Предыдущие `CoreImplementation`, `LoopWalkerOwner`, `NativeCtoGateOwner`, `NativeCtoGateOwner-2` завершили передачу и больше не пишут файлы.

Контракт native committer: `commitNativeCtoStageResult({ cwd, runId, host: StageHostBinding, trusted: TrustedStageResultInput }) → { ok: true, receipt: StageReceiptLedger } | { ok: false, code, error }`. `NativeEvidenceOwner` — единственный writer native immutable evidence/receipt commit; он принимает `host.binding` после проверки trusted native CTO assignment любого `producer.kind="worker"|"orchestrator"|"tool"` и валидирует kind-specific native host proof/revision/CAS и, для tool, registered callback proof. Native/callback proof не сериализуется в receipt; callback не создаёт synthetic stage/attempt identity и не направляет CTO в ordinary store. `Main` подключает публичные tools; `OrdinarySubmissionOwner` направляет все trusted CTO producer kinds через committer, а `NativeStageOwner` владеет native transition helper.
Native `tool` acceptance для CTO обязателен: `STAGE_HOST_UNSUPPORTED` на declared trusted producer не является SDK capability boundary и не даёт основания downgrade S14/A11; это branch defect, который NativeProducerAcceptance фиксирует реальными C tests. Unsupported/unknown остаётся только для непроверенных transport outcomes (например, default OMP 18 format-repair follow-up), не для собственного producer protocol.

#### Контракт реализации и callers

Выбранный для первоначальной проверки host — установленный `@oh-my-pi/pi-coding-agent` 18.0.6. `task/types.ts` предоставляет lifecycle `started/completed/failed/aborted` с child ID, parent tool-call ID, index, agent и session file; `task/structured-subagent.ts` загружает разрешённые extensions в child. Worker binding выводится из проверенной session lineage и сохранённого назначения, а main/tool binding — из profile-declared owner и trusted current host/callback, не из аргументов модели. Фактический pinned TypeScript contract различает пути: `ExtensionAPI` `pi.on("tool_call")` в normal agent-loop predispatch block не имеет wrapper `tool_result`, тогда как legacy `legacyHookToolWrapper` при catch block действительно emit-ит `tool_result`; repo использует `ExtensionAPI`, поэтому нельзя утверждать universal no-result/no-wrapper semantics. Нет подтверждённого generic preflight-not-started event и public inspect/observe/resume/cancel-ack API: adapter проверяет известные deterministic ошибки до запуска, остальные исходы остаются unknown. Дополнительные transport capabilities требуют конкретного adapter evidence; actual host smoke пока не доказан и остаётся H pending.
Source-verified pinned 18.0.6 tool discovery boundary: normal structured-task defaults use `restrictToolNames=false` and inherit extension paths (`structured-subagent.ts:385,441`; executor `3076,3151`); explicit `agent.tools` limits ACTIVE registered tools through SDK (`sdk:3119-20`). Current producer/lead frontmatter omits `submission`/`recover`, но это не SDK impossibility: CoreCommandCutover владеет fullstack agent allowlists, а InternalImplementation — internal allowlists. Actual H smoke не выполнен и не заявляется.
Source-verified pinned-task wire evidence (not runtime PASS): `node_modules/@oh-my-pi/pi-coding-agent/src/task/types.ts:114-176` defines flat `{ agent, task }` and batch `{ context, tasks: [{ agent, task }] }`, with no prompt/description/assignment wire field. `task/index.ts:566` sets `lenientArgValidation=true`; `agent-loop:2191-2215` fallback lets malformed args reach the `ExtensionAPI` hook, while SDK `:225-255` rejects a batch missing `context` before worker start. A positive R06 known-scoped-item task with marker+instructions but missing top-level context yields `invalid_arguments`; an empty batch remains `unknown`. This is source evidence only; no runtime PASS is claimed.
Среда с установленным `omp --version` наблюдалась как `18.3.4`; это не доказательство H. Host smoke H обязан использовать изолированно закреплённый `18.0.6`, а до такого прогона native H PASS не заявляется.

Дополнение после фактического отказа `host_session_not_captured` у свободного SDK-субагента: `TrustedToolCallResolution` получает отдельный actorless вариант `authenticated-host-idle-basic-tools`. Fullstack сохраняет только собственную identity из настоящего `session_start`, сверяя официальный manager и его cwd/session ID/file с lifecycle; `hasUI:false` лишь фильтрует кандидат и не удостоверяет происхождение. На каждом raw callback повторно проверяются тот же manager и актуальные getter-derived значения. Эта запись не создаёт primary/controller, parent lineage, worker grant или producer binding.

Core использует этот вариант исключительно для обычных `bash`/`write`/`edit` после успешного no-recovery чтения control: `execution_claim === null`, весь `selections` пуст, отсутствуют локальный selected/trusted run, controller и конфликтующие authority. Это проверка admission, не lease на длительность команды. Task/typed workflow/native producer/human authority не выдаются; последующие canonical-write/scope/safety gates сохраняются. Ошибки getter/control, drift и switch/stop/shutdown отзывают доступ; существующий interactive→headless запрет имеет приоритет, а аутентифицированный interactive reentry отзывает прежнюю idle identity.

Managed workers продолжают использовать существующий process-local `NativeWorkerAuthority`: доверенный parent Task и уникальный SDK lifecycle связывают canonical assignment с точным session file, затем собственный SDK manager ребёнка подтверждает identity. Это отдельный путь, не idle fallback и не доказательство cold restore. Internal consumer остаётся type-compatible и не выдаёт новую idle capability. Для этого ограниченного repair `Main` владеет actual source integration в core/fullstack, `IdleRegisteredConsumerTests` — кодом двух registered consumer regressions, `IdleAppliedCodeReview` — read-only review. SDK 18.0.6 source evidence не приравнивается к текущему compiled 18.3.4; путь текущего root extension не наблюдён. Изменение исходников и этот контракт не являются runtime PASS.

Единый model-facing вход `workflow_submit_result` принимает взаимоисключающие inline `outputs` или `outputs_path`; file adapter доставляет строго outputs envelope в тот же service. Evidence/schema/producer validation и workflow_recover остаются прежними. Delivery не добавляет terminal recovery, retry budgets или повторное исследование.

```ts
type StageProducerKind = "worker" | "orchestrator" | "tool";
interface StageProducerCommon {
  readonly authority: "ordinary" | "cto";
  /** Existing persisted assignment; never reconstructed from model input. */
  readonly identity: WorkIdentity;
  readonly host: { readonly session_id: string; readonly worktree: string; readonly branch: string };
}
type StageProducerBinding =
  | (StageProducerCommon & {
      readonly producer: {
        readonly kind: "worker"; readonly profile: string; readonly role: string; readonly slot_id: string;
        readonly generation: number; readonly wave_id: string; readonly slice_id: string;
        readonly stage_id: string; readonly iteration: number;
      };
    })
  | (StageProducerCommon & {
      readonly producer: {
        readonly kind: "orchestrator"; readonly profile: string; readonly stage_id: string;
        readonly iteration: number; readonly generation: number; readonly wave_id: string; readonly slice_id: string;
        readonly owner: "main-session" | "native-lead";
      };
    })
  | (StageProducerCommon & {
      readonly producer: {
        readonly kind: "tool"; readonly profile: string; readonly stage_id: string;
        readonly iteration: number; readonly generation: number; readonly wave_id: string; readonly slice_id: string;
        /** Derived from the profile/registration, never supplied by the model. */
        readonly tool_name: string;
      };
    });
interface TrustedToolCallback {
  readonly registration_id: string;
  readonly invocation_id: string;
  readonly host_session_id: string;
  /** Private runtime-only opaque proof; never model input or receipt data. */
  readonly proof: unknown;
}
interface StageHostBinding {
  readonly binding: StageProducerBinding;
  readonly native?: NativeWorkerBinding;
  readonly callback?: TrustedToolCallback;
}
interface StageResultSubmission { readonly outputs: Record<string, unknown>; }
// Tool delivery boundary, before the existing outputs-only service:
type StageResultDelivery = StageResultSubmission | { readonly outputs_path: string };
interface StageResultReceipt {
  readonly receipt_id: string; readonly submission_id: string;
  readonly binding: StageProducerBinding; readonly digest: string;
  readonly outputs: readonly { artifact_id: string; immutable_ref: string; sha256: string }[];
  readonly evidence: readonly { artifact_id: string; relative_path: string; immutable_ref: string; sha256: string }[];
  readonly accepted_at: string;
}
type StageRecoveryWorkerState = "not_started" | "running" | "disconnected" | "terminal" | "unknown" | "unsupported";
type StageRecoveryAction = "none" | "observe" | "resume" | "retry" | "wait" | "clarify" | "cancel";
interface StageRecoveryResult {
  readonly code: string; readonly worker: StageRecoveryWorkerState; readonly action: StageRecoveryAction;
  readonly attempts_remaining: number; readonly receipt?: StageResultReceipt;
  readonly retry_of?: string; readonly blocking_condition?: string; readonly next_action?: string;
}
```

`StageProducerBinding` создаётся только после сверки trusted profile/current cursor, существующего `WorkIdentity` и host. Для `producer.kind="worker"` обязательны profile-declared slot/role и verified worker lineage. Для `producer.kind="orchestrator"` owner обязан быть доверенным координатором назначенного stage scope: ordinary main session или configured native lead для его CTO slice; CTO root не получает lead/worker binding по одному утверждению. Для `producer.kind="tool"` `tool_name` derived из exact profile declaration/registration, а callback proof живёт только в `StageHostBinding.callback` как private opaque runtime data, не входит в `StageProducerBinding` и никогда не сериализуется в receipt; для `type:"document"` tool name и renderer proof derived из declared executable document contract и registry, не из model input. `product_prd_document` использует только зарегистрированный `product-prd` renderer и declared five-source/safe-path contract.

`registerStageProducerTool(pi, definition)` — единственная core registration boundary для `producer.kind="tool"`: wrapper captures trusted current assignment/host и profile-declared `tool_name`, выдаёт callback-local `StageHostBinding` publisher, а после async callback повторно сверяет binding перед immutable publication. Параллельный `workflow_submit_result` не может занять ambient context другого callback; callback authenticity проверяется по registration/invocation proof и host session. `beginCapability` (или эквивалентный trusted stage-begin commit) сначала persists legitimate non-worker assignment из profile/cursor, затем `deriveWorkerStageHostBinding({ cwd, runId, authority, native })` и `deriveMainStageHostBinding({ cwd, runId, context, toolName?, callback? })` выводят уже persisted assignment; helpers MUST NOT fabricate non-worker assignment. Native proof доступен через bridge, но не попадает в receipt.
All newly exported APIs MUST use named result types owned by their module (including a named `StageResultSubmissionOutcome` for submission/publisher results); do not expose `ReturnType<typeof concreteFn>` or `Awaited<ReturnType<...>>` aliases in the public contract.

`WorkIdentity` — существующий public тип. Producer/host fields используются только после проверки runtime authority; квитанция сама по себе не новый credential. Capability descriptor сообщает фактические runtime/version и supported/unsupported для identity, preflight, terminal, tool discovery и transport operations. Версия runtime — строка, не литерал `18.0.6` в API; закреплённая версия относится к evidence. Placeholder transport methods и фиктивные supported возможности не допускаются.

| Группа callers | Точки cutover |
|---|---|
| Core stage runtime / profile-declared orchestrator stages | `src/engine/stage.ts:runOrchestrator`, `src/engine/run.ts:StageContext.orchestrate`; profile-declared stages: `bug-fix:{discovery,summary}`, `cto:{cto_discovery,decomposition,cto_summary}`, `debug-cycle:{discovery,summary}`, `emergency:{summary}`, `feature-regression:{discovery_intake,user_checkpoint,summary_handoff}`, `full-feature:{discovery,clarify,summary}`, `lecture-research:{intake,acquisition[producer tool lecture_acquire],approval}`, `lightweight:{discovery,summary}`, `product-discovery:{product_approval,product_handoff}`, `research:{discovery,summary}`, `review:{discovery,summary}`, `spec-preparation:{handoff}`, `standard:{discovery,clarify,summary}` |
| Core deterministic document producer | `src/engine/stage.ts:runProductPrdRender`, `src/engine/durable.ts:renderStageDocument`, `src/engine/product-prd.ts`; `product-discovery/product_prd_document` is `type:"document"` with existing `format:"markdown"`, `renderer:"product-prd"`, safe `documents/product-prd.md` path and `product_prd` output. Trusted renderer callback uses the same publication/receipt path, no model submission and no worker terminal. |
| Internal profile orchestrators | `packages/omp-workflows-internal/workflows/omp-feature.json:{discovery,summary}` и `omp-validate.json:{discovery,summary}` |
| Main-session tool producer | `packages/fullstack/src/tools/lecture-acquire.ts:registerLectureAcquireTool`; `lecture_acquire` callback remains main-session-only, checks current `lecture-research/acquisition`, and calls trusted core publication API |
| Core model protocol | `commands/{do-work,cto,register}.ts`, stage instructions and profile contracts |
| Fullstack | `src/index.ts`, `src/workflow-commands.ts`, producers в `agents/`, configured leads, `src/tools/lecture-acquire.ts`, consumer tests |
| Internal | `src/index.ts`, private agents/skills/commands and registration tests; only public core imports |
| Acceptance | Core registered fixtures, `packages/e2e/test/cto-process-e2e.test.ts` and process fixtures; root scripts и CI у integration owner |

Карта основана на исследованиях `CoreContractMap`, `HostContractMap`, `ConsumerAcceptanceMap` и фактических profile JSON, перечисленных выше. TypeScript LSP отсутствует; `ast-index` 3.44.2 references проверены по `completeDispatch`, включён watch. Карта и наличие индекса не являются доказательством завершённого cutover.

## Risks / Trade-offs

- [Emulator расходится с OMP] → tiny boundary adapter, настоящие handlers, pinned host contract tests и H smoke; эмуляция не доказывает способности provider.
- [Под видом recovery ослабляются guards] → отдельная read-only диагностика и mutation authorization; отрицательные R09/R12/R13/R19 обязательны.
- [CTO по-прежнему завершается только решением модели] → gate evaluator вызывается на native commit пути и отвергает неподтверждённый stage completion.
- [Двойное исполнение после lost response] → durable identity, replay receipt, terminal proof, process tests; не обещаем exactly-once внешних side effects.
- [Новый tool тоже получает плохой payload] → schema validation и bounded repair; raw parsing failure не меняет state.
- [Быстрая приёмка превращается в новый framework] → существующие node:test fixtures, узкие seams, без DSL/новых сервисов; матрица проверяет поведение, не wiring.
- [Предел live smoke меньше реального времени provider] → прозрачный BLOCKED и отдельное решение бюджета; не маскируем timeout и не запускаем недельный QA автоматически.

## Migration Plan

1. Зафиксировать общий `StageProducerBinding` с `producer.kind="worker"|"orchestrator"|"tool"`, `StageHostBinding`, receipts/recovery directives и поддерживаемые host events. До API edits найти всех экспортируемых потребителей; обновление core, fullstack и internal — единый cutover. `StageWorkerBinding` alias не добавлять.
2. Сначала добавить RED сценарии новых contracts/#73/#76 и migration fixtures. Существующие legacy completed результаты импортируются только как проверенные historical refs, не как permission нового assignment.
3. Встроить submission/receipt и stage evaluator в существующие stores/transactions. При изменении persisted shape расширить существующие `TeamState`/`CtoState` полем `stage_recovery?: { schema_version: 1; lineages: Record<string, StageRecoveryLineage> }`, использовать stable run/generation/wave/slice/stage/iteration/slot/root_dispatch key, strict validator и canonical journals без новых store files. Retries reuse budget, distinct workers append history; safe events/budgets/grants/operations сохраняются, live ownership/selection proof выводятся из current claim, credential/`authenticated:true` authority не сохраняются. Миграция только quiescent записей с сохранением старых evidence. Незавершённые или неизвестные legacy workers не мигрируются вслепую: старая совместимая версия завершает/сверяет их штатно, после подтверждения допускается переход. Никаких ручных state edits.
Quiescent migration реализует только `QuiescentMigrationOwner` через `src/engine/run-migration.ts` и relevant ordinary migration tests; `OrdinarySubmissionOwner` сохраняет `state.ts`/`types.ts` и reconciles existing normalization migration receipt с actual schema 2. `NativeStageOwner` сохраняет CTO migration на existing `cto/state` boundary. Не вводятся второй migration framework или top-level schema bump.
4. Перевести всех встроенных producers/leads/commands/adapters на новый model-facing protocol; для tool producers добавить явные `StageDefinition.producer` declarations и `registerStageProducerTool(...)`, убрать замещённые ручные JSON инструкции, aliases и fallback. Внутренний durable completion primitive сохраняется, если нужен transport reconciliation; устаревший публичный producer путь не остаётся вторым способом acceptance.
   Сохраняемые internal paths: `run.ts → completeDispatch` и persisted `completed_by: workflow_complete|synchronous_tool_result` обслуживают transport completion/validators/observability, а не model-facing приём outputs. `findLegacyArtifactPath` остаётся только для migration evidence, подтверждённого completed-slot rows и migration manifests/receipts; live fan-in требует canonical immutable receipt и не принимает старый файл как разрешение.
5. Внешним consumers дать явный несовместимый контракт и инструкцию обновления, сохраняя fail-closed. Исправление Android bundle не заявляется частью доставки.
6. Пройти D/P, полные existing suites и H; обновить package docs/changelog в реализации. Не архивировать `run-lifecycle`, не возобновлять старые QA sessions и не публиковать релиз этим change.
7. До persisted migration сохранить snapshot для rollback. Downgrade допускается только при остановленном затронутом исполнении и совместимом state; иначе — forward recovery или штатный restore snapshot с проверкой ownership, не запуск старой версии против нового активного ledger.

## Автономное завершение приёмки

Пользователь разрешил завершить оставшиеся работы самостоятельно. Это разрешение
включает исправление CI, включение локального model-config patch в PR и новую
ограниченную live-приёмку; merge, release и архивирование остаются вне работы.

Владельцы текущей записи: `CiProcessRepairOwner` — process fixtures в core,
`SafeCiDiagnosticOwner` — scenario reporter в scripts; `Main` — интеграция,
e2e launcher/config, общие manifests/lockfile, PR и planning/evidence artifacts.
Host preflight исследует `FinalHostPreflightScout` без записи. Реальную live QA
выполняет отдельный настоящий SDK child через agent-browser и официальный e2e,
не суррогат orchestration `functions.task`.

Новый бюджет приёмки: по одной новой попытке H1/H2/H3, максимум 900 секунд
на case, включая startup и предусмотренный H3 restart. Автоматических повторов
нет. Старые 2/2 попытки, причины отказов и evidence сохраняются без перезаписи;
новый budget tranche ссылается на текущее разрешение пользователя и изменённые
условия (полный model-role config и проверенный launch environment), а не
сбрасывает прежний счётчик новым root. Cold restore/worker revive наблюдается
только на настоящем worker H3; новые task/identity/grants для доказательства
не фабрикуются.

До live QA требуются зелёные D/P и проверка выбранного binary/Bun/PATH/config.
Диагностика process FAIL сохраняет только безопасные bounded error fields;
canonical grants, raw assertion objects, credentials и SDK transcripts не
публикуются. Пользовательские version/release-правки 0.29.2 остаются отдельными.

### Уточнение live QA после невалидной автоматизации

Native `workflow_checkpoint_ask` использует фактический selection dialog SDK;
наличие literal `[ask_user]` в transcript не является обязательным. Оператор
связывает текущий pending tool-call, actual UI и текущий stage/receipt, выбирает
разрешённый policy вариант, затем проверяет matching result и canonical human
decision. PHASE0 `Proceed` — отдельное обычное сообщение, а не замена checkpoint.

Deadline один на case и устанавливается до startup. Каждый wait, browser action,
stop/restore ограничивается оставшимся временем; новый H3 host получает remaining
time, а не новый `15m`. До H3 stop нельзя отвечать исходному checkpoint:
сначала settled accepted producer и pending human UI, затем stop, original-root
`--session` restore, actual Hub `r`, exact resume и только актуальное approval.
Непроверенный boundary записывается `NOT_VERIFIED`, не как доказанный replay.

No-replay сравнивается по original implementation run/generation/stage/dispatch/
producer и immutable receipt. Разрешённый downstream `code_review`/QA не является
повторной implementation. Нельзя считать прежний discovery advance или прежний
worker bash доказательством terminal: нужен canonical terminal/release, затем
новый ordinary host action с matching result. Невалидная QA-попытка сохраняет
расходованный budget; ошибку оператора нельзя исправить неразрешённым повтором.

### Native operation identity на SDK boundary

H2 actual host обнаружил production defect: SDK `execute` call ID содержит
`|`, а canonical native operation policy допускает только безопасный alphabet.
Registered `cto_stage_advance` больше не передаёт raw SDK ID как operation ID:
adapter детерминированно выводит safe namespaced SHA-256 identity из **полного**
непустого opaque ID. Все raw IDs используют один namespace; strip/replace
не допускаются, чтобы разные вызовы не получили одинаковый durable replay key.
Raw SDK task/tool identity и observer metadata остаются неизменными.

Canonical validator, root claim, readiness и current-scope checks не ослабляются;
пустой SDK ID остаётся отказом. Internal callers с готовыми canonical operation
IDs не мигрируют на другой API. Exact replay того же SDK call после downstream
admission возвращает committed transition без второго advance; новый SDK call
не маскируется под replay. `NativeSdkOperationIdRepair` подготовил correction и
consumer regression; handback завершён, `Main` — sole writer core integration,
документации и итоговых проверок.
Новый H-прогон без отдельного разрешения не запускается.

### Последний разрешённый tranche: фактический результат

Exact candidate `46da973d23fddf1b2a91f62a2538c6008538535c`, SDK 18.0.6 и
единая модель `openai-codex/gpt-5.5`: actual native `task` запустил трёх
отдельных QA workers, все matching SDK lifecycle завершились `completed`.
Каждый case использовал ровно один новый immutable deadline до startup,
не более 900 секунд без автоматического retry; прежние 2/2 и предыдущие
дополнительные 1/1 сохранены.

Независимый oracle подтвердил H1 PASS: natural PHASE0 turn-stop, literal
`Proceed` в той же root-сессии, accepted implementation + matching terminal,
актуальное human approval, canonical complete/release и новый ordinary bash.
H2 PASS: configured lead own orchestrator receipt, resident-root SDK-hashed
advance, actual declared roster, human checkpoints, wave done/active_wave=null
в committed canonical transaction **до** буквального `END`, terminal release
и новый ordinary bash. Неверный label terminal-turn end в исходном H2 report
сохранён как ошибка отчёта; actual events и canonical receipt задают порядок.
Model-written future `wave.started_at` не используется как доказательство
порядка; отдельно наблюдавшийся failed summary-lead lifecycle имеет unknown
cause и не считается implementation replay.

H3 original checkpoint остался pending до stop; original SDK root восстановлена
из того же session file новым PID. Exact `/do-work --resume`, current checkpoint
approval и один соответствующий advance наблюдались. Typed lifecycle journals
с manifest-verified prepared bytes подтверждают одинаковые run, generation,
implementation stage, receipt, digest, worker lineage и immutable output hash
до stop и до/после resume. ColdRootRestore и scopedImplementationNoReplay PASS;
последующий reviewer — разрешённый downstream, а не повторная реализация.

Общий H3 остаётся FAIL: видимая строка исходного parked worker в Agent Hub,
её выбор, actual `r` и результат действия **не наблюдались**. Это gap live proof,
не доказанная runtime ошибка или `unsupported`. Source-level UI entry описан
в e2e README, но не заменяет runtime acceptance. Условие fallback на нового
linked worker не установлено; unknown не разрешает второго writer.

Readonly projection canonical/input/termination metadata закрыл первоначальные
ACCESS gaps независимого review, без нового H/runtime. Original reports, FAIL
и история сохранены; raw SDK sessions, grants, credentials и payloads не
публикуются. Все owned case/coordinator процессы, listeners, watchdogs и
browsers остановлены, private auth удалён; global stores не менялись.
Прогресс 29/30, 8.2 BLOCKED только по actual Hub revive proof. Следующая
попытка/restart/revive требует отдельного явного bounded разрешения;
повторять H1/H2 не требуется. Merge/release/archive не выполняются.

### Историческая оценка дополнительного H3-only до уточнения scope

После отдельного выбора пользователя «Один H3 — до 15 минут» выполнен
ровно один новый H3 на том же exact `46da973`, SDK 18.0.6/gpt-5.5.
H1/H2 PASS переиспользованы, production и прежние бюджеты не изменены.
Actual native SDK task child `ActualSdkH3HubOnlyOperator` завершился
`completed`; его parent call, index и SDK session зафиксированы.

Original root PID 78908 → 80451, тот же SDK session/file; accepted
implementation `JealousFowl` settled до исходного unanswered checkpoint.
Наблюдались actual Hub через `Ctrl+S`, выбранная original non-advisor
parked row и real `r`: та же строка стала idle/active just now, счётчики
8 requests/8 tools/27K tokens неизменны. Screens 0021/0022 и typed PTY
input подтверждают порядок: Hub `r` 11:05:50.243 → exact resume
11:06:08.215 → current approval 11:06:59.575 → один canonical advance
implementation → code_review 11:07:19.595. Более ранний literal `r` вне
подтверждённого Hub context не используется как доказательство.

Пять prepared snapshots с проверенными SHA manifests сохраняют exact
run/generation/dispatch/receipt/digest/binding/output tuple. Actual immutable
implementation bytes совпадают с canonical SHA. Original implementation:
один start, terminal и accepted receipt; `UgliestRoundworm` — downstream
code_review, не replay. Cold revive доступен; fallback на fresh worker
не требуется и не фабрикуется.

Для H3 «terminal host action» явно означает intentional close собственного
**восстановленного** SDK host после актуального approval и одного перехода:
SDK exit143 в 11:09:48.294, 622.486s от начала. Это не natural turn-end,
canonical workflow completion/release или новый ordinary tool; последние
требования относятся к H1/H2. Следующий review checkpoint не требует
ещё одного approval только ради расширенного H3 gate.

Функциональный H3 независимо PASS, общий outcome остаётся qualified:
`FUNCTIONAL_H3_PASS_WITH_BOUNDED_CLEANUP_NOT_VERIFIED`. SDK/NodeCLI case
остановлены до 900s, browser close acknowledged, но timed browser PID/
named-registry absence не зафиксирована. CLI `agent-browser` 0.17 отвечает
после awaited manager close и откладывает daemon/socket exit на 100ms;
browser-close errors подавляются. Immediate listed name не доказывает
liveness, успешный ответ не доказывает physical absence. Возможный race
не повышается до runtime proof. Исходные NOT_VERIFIED/guard browser=false
сохранены; все owned процессы/browsers/watchdogs и private auth в итоге
очищены. **29/30, 8.2 BLOCKED только по bounded browser-cleanup proof**.

Private projection helper имел Darwin `/var` versus `/private/var`
confinement mismatch; безопасные manifest-verified canonical projections
восстановлены read-only, без нового H. Это не production defect. История
сохранена в `authorized_h3_only_tranche` acceptance JSON; новый budget 1/1
исчерпан, automatic retry и merge/release/archive не выполняются.

### Закрытие исходной приёмки: 30/30, harness — отдельный эпик

Пользователь подтвердил, что оптимизация e2e harness не относится к текущей
задаче, и явно поручил закрытие/push. Текущая приёмка исходного контракта PASS:
H1/H2 independent PASS переиспользованы, H3 functional PASS включает actual
cold original-root restore, original Hub row/`r`/idle до resume и approval,
пять manifest-verified immutable tuples, один актуальный переход без replay.
Никакого нового H, SDK restore или browser case при закрытии не запускается.

Источник требований — `specs/deterministic-workflow-acceptance/spec.md:55,63,67–71`
и исходные H-сценарии выше: заранее заданные timeout/cleanup, остановка только
owned процессов, конечный smoke внешней границы и запрет unrelated расширения
матрицы. `proposal.md:34–37` явно исключает ремонт harness.

Timestamped browser PID/registry absence до immutable 900s был дополнительным
условием private operator protocol Main. Его последующее включение в текущий
product gate было ошибкой классификации. Общий owned cleanup подтверждён;
более строгий timed proof остаётся NOT_VERIFIED и относится к отдельному
эпику e2e harness, а не к критерию готовности этой реализации.

Исторические отчёты/qualified labels/budgets выше и в acceptance JSON остаются
неизменными; добавлен отдельный `current_acceptance_disposition`, а не ложное
повышение прежнего cleanup outcome до PASS. 8.2 и Beads `br-4m8` закрыты,
30/30 по исходной спеке. Production code, пользовательские version/release
правки и global stores не изменяются. Merge/release/archive не выполняются;
последующее ручное тестирование и решение по PR остаются за пользователем.

### Хранение evidence перед merge

`automatic-acceptance.json` (45 191 строка raw traces/истории) сохраняется только
локально под точечным gitignore, не является runtime/config input и не входит в PR.
Исторические ссылки на acceptance JSON в этом change относятся к локальному evidence,
не к переносимому Git artifact; машинные /tmp пути не обещают доступность другим reviewers.
Краткий итог сохранён выше: исходная приёмка 30/30, H1/H2 independent PASS,
H3 functional PASS; более строгий timed browser cleanup proof остаётся NOT_VERIFIED
и не переклассифицирован в PASS. Новые delivery/AST fixes не означают повтор H.
Текущий code/spec candidate `61a2c10` прошёл
[CI 37336789766](https://github.com/AndVl1/omp-workflows/actions/runs/37336789766):
build/typecheck/D/P/Test SUCCESS. Это evidence автоматических checks, не нового live H.

