# Spec Delta

## Purpose

Обеспечить проверяемую сдачу результата этапа через инструмент, исключая ручное составление служебных файлов и копирование полномочий моделью, сохраняя отдельные проверки качества и approvals.

## ADDED Requirements

### Requirement: Доверенная привязка сдачи результата

Система SHALL предоставлять producer-у существующий `workflow_submit_result` в ordinary и CTO исполнении. Model-facing input SHALL содержать ровно один вариант: `{ outputs: Record<string, unknown> }` либо `{ outputs_path: relativePath }`, без дополнительных authority-полей. Run, этап, iteration, dispatch, attempt и producer scope SHALL определяться доверенным runtime-контекстом, не моделью. `outputs_path` SHALL быть только способом доставки, не новым publisher или источником полномочий. Caller без действующей привязки MUST NOT получить полномочия через payload.

Atomic evidence и receipt publication SHALL use shared `StatePublication` over existing `LifecycleFileContent` (`string | base64 image | null`); direct binary fallback MUST NOT be introduced.

#### Scenario: S01 Сдача результата назначенным worker
- **WHEN** назначенный worker передаёт результат своего текущего задания без служебных authority-полей
- **THEN** система связывает результат с точным назначением и возвращает квитанцию; соседние run, этап и CTO slice не изменяются

#### Scenario: S02 Чужой или устаревший producer
- **WHEN** caller без назначения, worker другого slice либо старой попытки сдаёт результат текущего этапа
- **THEN** сдача отвергается без публикации результата и изменения этапа, даже если payload содержит правильные текстовые идентификаторы

### Requirement: Файловая доставка через trusted producer workspace

Файл SHALL содержать строго `{ outputs: Record<string, unknown> }`, без дополнительных форматов, угадывания структуры или починки JSON. Boundary SHALL установить producer/workspace через существующие host bindings до чтения, разрешить относительный путь только внутри этого workspace и выполнить одно безопасное чтение с проверкой symlink/containment. Cwd координатора MUST NOT подменять workspace producer. Прочитанные bytes SHALL пройти JSON.parse и существующий submission service без копии ownership/schema/immutable/receipt логики. Cold replay eligibility SHALL использовать существующий owner-scoped no-recovery boundary до чтения; delivery MUST NOT запускать recovery или изменять state machine.

#### Scenario: Файл принят и inline сохранён
- **WHEN** действующий producer сдаёт корректный envelope через outputs_path либо inline outputs
- **THEN** существующий service валидирует outputs и создаёт обычный receipt; exact replay возвращает прежний receipt, изменённый accepted payload отвергается

#### Scenario: Взаимоисключающие delivery варианты
- **WHEN** input содержит оба outputs/outputs_path либо ни одного
- **THEN** tool отвергает вызов без публикации и receipt

#### Scenario: Ошибка доставки исправлена без повторного исследования
- **WHEN** файл отсутствует, нечитаем или содержит malformed JSON, затем действующий producer исправляет файл и повторяет сдачу
- **THEN** первоначальный отказ содержит структурированные code/error без schema field_errors и receipt; исправленный payload проходит обычный service, а неверная output schema возвращает существующие field_errors

#### Scenario: Небезопасный путь или чужой producer
- **WHEN** caller использует absolute path, ../, symlink либо чужую producer/workspace identity
- **THEN** сдача отвергается без receipt; foreign/ineligible producer не получает разрешения читать delivery file

### Requirement: Writer-aware инструкции и изоляция parallel delivery

Для больших, вложенных или многострочных результатов при авторизованном программном writer worker SHALL использовать outputs_path и JSON.stringify, не вручную собранный JSON. Каждый producer occurrence SHALL выделять свежий UUID filename; parallel workers MUST NOT использовать общий stage-output.json. JavaScript eval/Bun.write SHALL предлагаться только при доступном eval; general Bash producer может использовать Node randomUUID и writeFileSync с flag wx. AST-only Bash MUST NOT давать Node/source-write права. Read-only producer без writer SHALL сохранить concise schema-complete inline путь. После inline parse failure producer SHALL переключиться на файл при разрешённом writer либо исправить inline без потери required fields и повторного исследования. Только accepted receipt SHALL подтверждать публикацию; метод MUST NOT обещать восстановление уже завершённого worker.

#### Scenario: Parallel producers и разные writer capabilities
- **WHEN** parallel producers готовят результаты и только часть имеет разрешённый programmatic writer
- **THEN** file producers используют разные свежие filenames и JSON.stringify; readonly producer без writer сохраняет concise inline сдачу без обхода AST-only gate, а все завершают публикацию только accepted receipt


### Requirement: Дискриминированное доверенное владение producer

Trusted runtime SHALL назначать ровно один producer discriminant: `producer.kind` MUST быть одним из `worker`, `orchestrator` или `tool`. Assignment SHALL выводиться из текущей profile declaration, cursor/generation и существующего `WorkIdentity`, затем связываться с authenticated current host; он MUST NOT браться из model payload fields вроде kind, role, slot, `tool_name`, run ID, token или authority. Для `worker` обязательны текущая worker lineage и profile slot/role. Для `orchestrator` обязателен trusted coordinator назначенного stage scope (ordinary main-session coordinator или configured native lead для его CTO slice); CTO root MUST NOT impersonate lead или worker. Для `tool` обязательны `StageDefinition.producer: { kind: "tool"; tool_name: string }` и authenticated registered callback/invocation proof, либо существующий `type:"document"` с executable `document.renderer` contract и renderer registry proof. Callback/renderer proof SHALL оставаться private runtime data, не входить в public binding или receipt. Valid producer acceptance публикует только собственные declared outputs и MUST NOT означать worker terminal, stage completion или approval.

Для native CTO `worker`, `orchestrator` и `tool` проходят один native committer/receipt path; declared trusted native `tool` MUST NOT downgrade в `STAGE_HOST_UNSUPPORTED`. Такой код означает branch defect, а не отсутствие SDK capability; unsupported/unknown допускается только для непроверенных transport outcomes.

#### Scenario: S13 Собственный output profile-declared orchestrator
- **WHEN** trusted ordinary main-session coordinator or configured CTO lead submits outputs for its current profile-declared orchestrator stage
- **THEN** outputs are accepted under `producer.kind="orchestrator"` with immutable receipt for that scope, without inventing worker terminal and without satisfying separate approval

#### Scenario: S14 Собственный output profile-declared tool
- **WHEN** текущий authenticated profile-declared tool callback сдаёт свой output через callback-local publisher
- **THEN** результат принимается под producer.kind tool с immutable receipt для точного assignment; worker terminal и approval не фабрикуются (foreign/stale/impersonation denial остаётся S02/A12)

#### Scenario: S15 Аутентичность tool callback
- **WHEN** profile-declared tool callback submits through callback-local publisher, or unregistered, wrong-host, wrong-stage, replayed or forged callback attempts same submission
- **THEN** only current authenticated callback is accepted under `producer.kind="tool"`; every other attempt is rejected before publication and cannot borrow another callback's ambient context

#### Scenario: S16 Ограничение main-session lecture_acquire
- **WHEN** `lecture_acquire` is invoked from worker, foreign host, wrong workflow/stage or non-main session, or from current main session at `lecture-research/acquisition`
- **THEN** rejected invocations publish nothing; only current main-session callback may publish `lecture_acquisition` through trusted core publication API, never arbitrary file path, and acceptance still does not create worker terminal or approval

#### Scenario: S17 Доверенный deterministic document renderer
- **WHEN** engine reaches the profile-declared `product-discovery/product_prd_document` document stage with its existing executable `format:"markdown"`, `renderer:"product-prd"` and safe relative path contract
- **THEN** the registered renderer publishes only the declared `product_prd` output and typed source/content hashes through the same immutable receipt path, byte-identically for identical sources, without model submission, arbitrary file publication, worker terminal or approval substitution


### Requirement: Проверка содержимого до принятия

Worker SHALL получать схему сдачи текущего задания. Система SHALL проверять обязательные поля, типы, объявленные outputs и допустимость evidence-ссылок до принятия. Отказ SHALL содержать машинный код и ошибки конкретных полей, достаточные для исправления без чтения исходников, без раскрытия secrets. Проверка структуры MUST NOT объявлять содержательную корректность реализации. Для fan-out SHALL сохраняться принадлежность outputs соответствующему producer slot.

#### Scenario: S03 Исправление невалидного результата
- **WHEN** worker пропускает обязательное поле или передаёт неверный тип, затем исправляет сдачу
- **THEN** первая сдача не публикуется и не завершает этап, ошибки указывают проблемные поля, исправленный результат принимается без повторной реализации

#### Scenario: S04 Небезопасный или отсутствующий evidence
- **WHEN** обязательная ссылка отсутствует либо выходит за разрешённую область, в том числе через symlink
- **THEN** результат не принимается, внешние данные не публикуются, worker получает безопасную диагностику для исправления

#### Scenario: S05 Независимые outputs нескольких workers
- **WHEN** два workers с разными назначенными outputs сдают результаты одного этапа
- **THEN** каждый результат сохраняется в своём scope, одного результата недостаточно для полного fan-in, а artifact одного slot не подменяет другой

### Requirement: Атомарная и идемпотентная публикация

Движок SHALL сериализовать и сохранять служебный результат, его provenance и квитанцию без ручной записи workflow JSON worker-ом. Для потребителей результат SHALL становиться доступным только как целиком принятая версия. Повтор той же принятой сдачи SHALL возвращать прежнюю квитанцию; изменение принятого результата в том же submission scope SHALL отвергаться и требовать явной новой итерации. Прерывание публикации SHALL восстанавливаться штатно без частично принятого результата или ручной чистки файлов.

#### Scenario: S06 Квитанция потерялась после commit
- **WHEN** результат принят, ответ tool потерян, и worker повторяет ту же сдачу после восстановления связи
- **THEN** возвращается та же квитанция, существует одна принятая версия и не возникает второго завершения или перехода

#### Scenario: S07 Конфликтующая повторная сдача
- **WHEN** после принятия worker передаёт другое содержимое для того же назначения и версии сдачи
- **THEN** система сообщает конфликт, сохраняя первый результат и его evidence неизменными

#### Scenario: S08 Прерывание до публикации
- **WHEN** процесс прерван между подготовкой файлов результата и его canonical commit
- **THEN** зависимый этап не видит частично принятого результата, а после restart штатное восстановление завершает или откатывает незавершённую публикацию без ручного редактирования

### Requirement: Принятие результата не подменяет завершение этапа

Принятая сдача SHALL удовлетворять только соответствующему условию результата. Она MUST NOT автоматически удовлетворять отдельным review, verification, DoD, fan-in или human approval. Для `producer.kind="orchestrator"` и `"tool"` отсутствие worker terminal ожидаемо: acceptance MUST NOT фабриковать его. Завершение worker без принятой сдачи SHALL приводить к поддерживаемому исправлению сдачи; coordinator MUST NOT фабриковать результат от имени producer.

#### Scenario: S09 Worker сказал готово без сдачи
- **WHEN** worker завершился с текстовым ответом об успехе, но не сдал обязательный результат
- **THEN** этап остаётся незавершённым, система инициирует ограниченное восстановление сдачи с сохранённым контекстом и не повторяет реализацию без причины

#### Scenario: S10 Результат принят до обязательного approval
- **WHEN** результат принят, но предусмотренный для этого результата human approval ещё не получен
- **THEN** переход остаётся заблокированным до актуального решения, а приём результата не записывается как одобрение

### Requirement: История результатов переживает новые итерации и cutover

Результаты SHALL быть неизменяемыми в scope run, wave или generation, этапа, iteration и producer. Исторические артефакты прежнего протокола SHALL оставаться читаемыми как evidence, но MUST NOT автоматически считаться сдачей нового назначения. Неподдерживаемый старый caller SHALL получать явную диагностику перехода на новый протокол без выдачи полномочий.

#### Scenario: S11 Новая CTO волна или rework
- **WHEN** начинается новая волна либо итерация доработки после принятой предыдущей версии
- **THEN** новая сдача не перезаписывает прошлые артефакты и ссылки, а предыдущий результат не завершает новое назначение

#### Scenario: S12 Исторический результат и старый caller
- **WHEN** после cutover открывается старый результат и старый producer пытается вручную объявить его результатом нового назначения
- **THEN** история читается, но новая сдача по прежнему неподдерживаемому протоколу отвергается с диагностикой, без автоматического доверия файлу
