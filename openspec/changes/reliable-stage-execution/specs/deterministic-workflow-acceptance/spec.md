# Spec Delta

## Purpose

Предоставить быструю воспроизводимую приёмку workflow через автоматизированные последовательности событий реального движка, чтобы проверка ошибок и восстановления не зависела от длительных живых разговоров с LLM.

## ADDED Requirements

### Requirement: Сценарии проходят через реальные точки входа

Автоматическая приёмка SHALL выполнять последовательность старта сессии, зарегистрированного ingress, выбора workflow, запуска этапа, событий worker, ошибки и recovery через production handlers, controllers, admission и durable storage. Она MUST NOT подменять проверяемый движок вторым симулятором переходов или заранее записанными успешными ответами. Подменять SHALL разрешаться только внешние границы: ответы модели, транспорт worker, host UI, время и аварийные отказы. Декларированное model action SHALL проходить настоящую проверку допуска.

#### Scenario: A01 Сквозной сценарий с ошибкой
- **WHEN** один сценарий на одном run проходит session_start → registered ingress → выбор workflow → старт этапа → preflight отказ → recovery → исправленный запуск worker → сдача результата → попытка запрещённого advance → актуальное approval → следующий этап
- **THEN** вся цепочка выполняется production handlers без сброса fixture между шагами; runner проверяет сохранение run/assignment-связей, terminal linkage отказа, один фактический старт worker текущего этапа, принятый receipt, отсутствие downstream до approval и один следующий dispatch после решения; оба маршрута ordinary и CTO проходят эту последовательность

#### Scenario: A02 Ошибка в последовательности действий модели
- **WHEN** сценарный агент пытается перейти без обязательной сдачи или approval
- **THEN** production gate отвергает переход, сценарий проверяет отсутствие downstream и затем проходит штатное восстановление, а не исправляет state напрямую

### Requirement: Воспроизводимость без внешних сервисов

Основной набор SHALL запускаться одной документированной командой локально и в CI без сети, credentials, OMP TUI и LLM. Каждый сценарий SHALL иметь изолированные данные и воспроизводимый порядок событий; ожидания SHALL синхронизироваться явными событиями или barriers, а не произвольными sleep. Повтор одного расписания SHALL давать тот же семантический результат независимо от случайных UUID и временных каталогов. Ограничения времени и число повторов SHALL быть конечными и видимыми в отчёте.

#### Scenario: A03 Повтор из чистого окружения
- **WHEN** один и тот же сценарий выполняется дважды и затем в составе полного набора без credentials
- **THEN** семантические результаты совпадают, порядок независимых тестов не влияет на outcome, внешние сессии и данные пользователя не изменяются

### Requirement: Проверка границ отказа и durable восстановления

Матрица SHALL покрывать not-started, transport loss, terminal failure, неизвестный статус, невалидную сдачу, дубли и поздние результаты, конфликты authority, лимиты, approvals и реальные retry-циклы. Критические crash/restart и конкурирующие ownership случаи SHALL дополнительно проверяться отдельными процессами с реальными persisted данными. In-process очистка объекта MUST NOT выдаваться за доказательство process restart. Fault injection SHALL задавать точную границу отказа, не редактируя canonical state для достижения ожидаемого результата.

#### Scenario: A04 Потеря ответа после commit
- **WHEN** scenario runner прерывает доставку ответа после реального сохранения результата, перезапускает процесс и повторяет операцию
- **THEN** подтверждается одна публикация, прежняя квитанция и отсутствие повторного следующего dispatch

#### Scenario: A05 Управляемая гонка восстановления
- **WHEN** два процесса доходят до одной границы восстановления и освобождаются заданным расписанием
- **THEN** только один получает право изменяющего действия, второй получает replay или отказ, а реальное persisted состояние соответствует единственному исполнителю

### Requirement: Прослеживаемость требований и test-first

Каждый scenario в `stage-result-submission` и `stage-execution-recovery` SHALL иметь стабильный ID и отображение в автоматическую проверку с конкретными assertions; общие контракты SHALL проверяться для ordinary и CTO, route-specific — в соответствующем маршруте. Новое поведение и воспроизводимые дефекты SHALL сначала получать падающую по ожидаемой причине проверку, затем минимальное исправление и повторный PASS. Уже работающий контракт SHALL переиспользовать существующее доказательство; намеренно ломать production ради RED MUST NOT требоваться. Зелёные schema/build/component проверки MUST NOT подменять проверку последовательности переходов.

#### Scenario: A06 Регрессии известных issues
- **WHEN** реализуются исправления #73 и #76
- **THEN** сохраняется evidence ожидаемого RED и последующего GREEN для реального FAIL→retry→PASS и preflight refusal→corrected dispatch, включая отрицательные assertions против ложного успеха и второго worker

#### Scenario: A07 Требование без сценарного доказательства
- **WHEN** итоговая матрица не содержит автоматического результата для обязательного scenario либо помечает его пропущенным
- **THEN** приёмка не считается завершённой; наличие других зелёных тестов не закрывает пробел

### Requirement: Live OMP проверяет только внешнюю интеграционную границу

Живые проверки SHALL быть отдельным конечным набором для реального обнаружения команд/tools, host identity, lifecycle callbacks, native worker result delivery и human UI. Они MUST NOT быть основным способом перебора fault/recovery состояний. До запуска SHALL быть заданы версия runtime и кандидата, сценарий, ожидаемые наблюдения, timeout и cleanup. Повтор после неудачи SHALL требовать классифицированной причины и изменения соответствующего условия, а не поиска случайного PASS.

#### Scenario: A08 Эмуляция зелёная но host несовместим
- **WHEN** автоматическая матрица проходит, но настоящий host не доставляет необходимый binding или lifecycle event
- **THEN** native integration считается непроверенной либо проваленной с конкретной причиной; новая автоматическая contract-проверка закрепляет обнаруженное расхождение, и зелёный engine suite не выдаётся за доказательство host-совместимости

#### Scenario: A09 Прогон прерван инфраструктурой
- **WHEN** runtime не стартовал, потерял credentials либо harness завершил сценарий до целевого события
- **THEN** отчёт различает infrastructure failure и product failure, не записывает PASS, сохраняет evidence и подтверждает остановку только собственных процессов

### Requirement: Итоговая приёмка имеет конечный проверяемый результат

Отчёт SHALL связывать scenario ID, вариант маршрута, исходный код/кандидат, условия fault, фактический результат и evidence. Он SHALL различать PASS, FAIL и BLOCKED, показывать длительность и причину остановки без секретов. Полная приёмка SHALL требовать зелёной автоматической матрицы, предусмотренных process-тестов и ограниченного host smoke для затронутых внешних границ. Новая unrelated проблема MUST NOT молча расширять матрицу; дефект внутри согласованного контракта SHALL блокировать соответствующий критерий до исправления.

#### Scenario: A10 Воспроизводимый отчёт и граница scope
- **WHEN** выполнен согласованный набор и обнаружен сбой внешнего Android bundle или отдельного harness
- **THEN** отчёт сохраняет конкретный статус затронутой проверки и ссылку на отдельную issue, не объявляет чужой интеграционный путь проверенным и не добавляет несогласованную реализацию в этот change

### Requirement: Детерминированная приёмка покрывает все trusted producer kinds

Зарегистрированные D-сценарии SHALL проходить через production registration и durable publication для каждого `producer.kind` (`worker`, `orchestrator`, `tool`) без второго acceptance engine. Они SHALL использовать profile-declared ownership и trusted current host/worker lineage либо proof зарегистрированного callback; kind, authority, `tool_name`, run/token или identity из model-полей MUST NOT влиять на приёмку. Эти cases сохраняют no-network и существующий бюджет D≤60s; они MUST сохранить все S/R/A cases и проверить, что acceptance, worker terminal, stage completion и approval остаются разными переходами.

#### Scenario: A11 Собственный output каждого trusted producer
- **WHEN** зарегистрированный runner передаёт валидный собственный output через назначенного worker, назначенного orchestrator coordinator и точный текущий profile-declared tool callback
- **THEN** каждый маршрут получает одну immutable assignment-bound receipt, публикуется только объявленный output; маршруты orchestrator/tool не синтезируют worker terminal или approval

#### Scenario: A12 Worker impersonation и foreign/stale denial
- **WHEN** main/lead context передаёт worker-подобные поля либо foreign slot, stale generation, неправильные host/branch или replayed worker lineage пытаются передать тот же output
- **THEN** production acceptance детерминированно отвергает каждую попытку до publication без мутации stage/соседних runs

#### Scenario: A13 Аутентичность tool callback
- **WHEN** зарегистрированный callback публикует после async operation, а также выполняются попытки незарегистрированного, wrong-host, wrong-stage, forged или replayed callback и конкурентного `workflow_submit_result`
- **THEN** после commit-time revalidation публиковать может только callback-local captured assignment/host и точный declared tool name; ambient context нельзя занять, arbitrary file publication запрещена

#### Scenario: A14 Ограничение main-session lecture_acquire
- **WHEN** `lecture_acquire` вызывается из worker, foreign или non-main context, из wrong workflow/stage, а затем из текущей main session на `lecture-research/acquisition`
- **THEN** отвергнутые вызовы не публикуют artifact; только текущий main-session callback публикует `lecture_acquisition` через trusted core API, без придуманного worker terminal и без network dependency в deterministic harness

#### Scenario: A15 Детерминированный document renderer
- **WHEN** registered D runner advances `product-discovery/product_prd_document` with its existing `type:"document"` contract (`format:"markdown"`, `renderer:"product-prd"`, declared safe relative path) and the five declared source artifacts
- **THEN** the engine-owned trusted renderer callback publishes byte-identical document/typed source-content hashes through the same immutable publication/receipt path, without model submission, network access or invented worker terminal
