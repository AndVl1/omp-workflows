# Spec Delta

## Purpose

Обеспечить проверяемую сдачу результата этапа через инструмент, исключая ручное составление служебных файлов и копирование полномочий моделью, сохраняя отдельные проверки качества и approvals.

## ADDED Requirements

### Requirement: Доверенная привязка сдачи результата

Система SHALL предоставлять producer-у инструмент структурированной сдачи результата текущего задания в ordinary и CTO исполнении. Model-facing envelope SHALL remain exactly `{ outputs: Record<string, unknown> }`; run, этап, iteration, dispatch, attempt и producer scope SHALL определяться доверенным runtime-контекстом, а модель MUST NOT быть обязана передавать tokens, capability, authority, producer kind, пути canonical state или вычислять служебные идентификаторы. Caller без действующей привязки MUST NOT получить полномочия через поля payload. При нескольких заданиях выбор SHALL ограничиваться подтверждёнными назначениями caller.

Atomic evidence и receipt publication SHALL use shared `StatePublication` over existing `LifecycleFileContent` (`string | base64 image | null`); direct binary fallback MUST NOT be introduced.

#### Scenario: S01 Сдача результата назначенным worker
- **WHEN** назначенный worker передаёт результат своего текущего задания без служебных authority-полей
- **THEN** система связывает результат с точным назначением и возвращает квитанцию; соседние run, этап и CTO slice не изменяются

#### Scenario: S02 Чужой или устаревший producer
- **WHEN** caller без назначения, worker другого slice либо старой попытки сдаёт результат текущего этапа
- **THEN** сдача отвергается без публикации результата и изменения этапа, даже если payload содержит правильные текстовые идентификаторы

### Requirement: Дискриминированное доверенное владение producer

Trusted runtime SHALL назначать ровно один producer discriminant: `producer.kind` MUST быть одним из `worker`, `orchestrator` или `tool`. Assignment SHALL выводиться из текущей profile declaration, cursor/generation и существующего `WorkIdentity`, затем связываться с authenticated current host; он MUST NOT браться из model payload fields вроде kind, role, slot, `tool_name`, run ID, token или authority. Для `worker` обязательны текущая worker lineage и profile slot/role. Для `orchestrator` обязателен trusted coordinator назначенного stage scope (ordinary main-session coordinator или configured native lead для его CTO slice); CTO root MUST NOT impersonate lead или worker. Для `tool` обязательны `StageDefinition.producer: { kind: "tool"; tool_name: string }` и authenticated registered callback/invocation proof, либо существующий `type:"document"` с executable `document.renderer` contract и renderer registry proof. Callback/renderer proof SHALL оставаться private runtime data, не входить в public binding или receipt. Valid producer acceptance публикует только собственные declared outputs и MUST NOT означать worker terminal, stage completion или approval.

Для native CTO `worker`, `orchestrator` и `tool` проходят один native committer/receipt path; declared trusted native `tool` MUST NOT downgrade в `STAGE_HOST_UNSUPPORTED`. Такой код означает branch defect, а не отсутствие SDK capability; unsupported/unknown допускается только для непроверенных transport outcomes.

#### Scenario: S13 Собственный output profile-declared orchestrator
- **WHEN** trusted ordinary main-session coordinator or configured CTO lead submits outputs for its current profile-declared orchestrator stage
- **THEN** outputs are accepted under `producer.kind="orchestrator"` with immutable receipt for that scope, without inventing worker terminal and without satisfying separate approval

#### Scenario: S14 Имитация worker, чужой или stale assignment
- **WHEN** main/lead caller supplies worker-looking model fields, or worker from another slot/generation/branch or stale lineage submits outputs
- **THEN** submission is rejected before publication, with no receipt or stage mutation, even when textual IDs in payload match the target

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
