# Spec Delta

## Purpose

Сделать завершение этапа и восстановление workflow наблюдаемыми программными переходами, которые сохраняют прогресс, approvals и ownership без ручной чистки файлов или управления worker-сессиями пользователем.

## ADDED Requirements

### Requirement: Завершение этапа определяется его контрактом

Этап SHALL завершаться только после принятых обязательных результатов, полного fan-in и выполнения собственных условий профиля, включая актуальные approvals. Review и QA, объявленные отдельными этапами, SHALL оставаться отдельными. Завершение worker, приём payload и завершение этапа MUST NOT смешиваться. Повтор перехода SHALL быть идемпотентным и MUST NOT повторно планировать следующий этап.

Native CTO advancement SHALL use concrete `cto_stage_advance({ slice_id })`: authorization MUST remain the real root claim, never a synthetic lead/worker binding. The registered execute call passes private `operation_id` to canonical transition/history for durable exact-request replay while public parameters remain only `{ slice_id }`; a fresh call evaluates the current stage, and `ready`/no-assignment heuristics MUST NOT turn a legitimate orchestrator next stage into replay. Native canonical atomic validation checks receipt, worker terminal, fan-in, DoD, checkpoint phase/policy, current result, loop state, revision and ownership. Replay reports achieved state idempotently. Model fields cannot supply stage/cursor/receipt/token, candidate `cto_state` cannot inject progress, and registered fixtures MUST NOT jump persisted state.

#### Scenario: R01 Результат есть но этап не готов
- **WHEN** worker завершён и результат принят, но один обязательный output, checkpoint или условие этапа не выполнено
- **THEN** система сообщает конкретное невыполненное условие и поддерживаемое действие, сохраняя cursor; downstream не запускается

#### Scenario: R02 Повтор завершения этапа
- **WHEN** все условия выполнены и команда перехода доставлена повторно, в том числе после restart
- **THEN** фиксируется один переход и не более одного соответствующего следующего dispatch, повтор показывает уже достигнутое состояние

### Requirement: Approval относится к конкретному результату

Подтверждения SHALL применяться только к объявленной фазе и текущей версии результата. Planning consent MUST NOT заменять post-production approval. После изменения результата ранее выданное одобрение MUST NOT разрешать новую итерацию. Политика автоматического решения SHALL сохраняться там, где она разрешена профилем; recovery MUST NOT создавать лишние human gates либо обходить обязательные. Для native CTO human boundary SHALL использовать concrete `cto_checkpoint_ask({ slice_id })`: Main derives active CTO run/claim, native preflight derives current profile checkpoint/phase/policy/result scope, а real host UI answer commits via native canonical revision/identity revalidation; replay возвращает existing current decision. Ordinary tools/selectors/tokens и candidate `rootcto_state` MUST NOT inject CTO progress, receipts or approvals.

#### Scenario: R03 Согласие до реализации
- **WHEN** пользователь согласовал план, затем worker сдал реализацию с обязательным before-advance approval
- **THEN** требуется решение по готовой реализации, а согласие на план не разрешает переход

#### Scenario: R04 Одобрение прежней итерации
- **WHEN** результат переоткрыт и доработан, затем доставлено старое одобрение
- **THEN** оно не разрешает переход новой итерации; допустимое новое решение принимается без повторного запроса уже актуального решения

#### Scenario: R05 Автоматическое решение профиля
- **WHEN** текущий checkpoint допускает policy-auto и условия политики выполнены
- **THEN** решение применяется штатно без искусственного human approval; обязательный human checkpoint тем же путём не разрешается

### Requirement: Recovery различает доказанное состояние исполнения

Система SHALL предоставлять authenticated coordinator штатную операцию восстановления с машинной причиной, фактическим статусом worker, выполненным действием, точкой продолжения и разрешёнными следующими действиями. Она SHALL различать `not_started`, подтверждённое живое исполнение, потерю транспорта, подтверждённый terminal и неизвестный статус для `producer.kind="worker"`. Для `orchestrator` и `tool` acceptance, включая main-session `lecture_acquire`, отсутствие worker terminal ожидаемо и recovery MUST NOT фабриковать его. Timeout, смерть coordinator или отсутствие ответа MUST NOT считаться доказательством смерти worker. Восстановление SHALL сохранять исходные задачу, классификацию, историю, dispatch identities и незатронутые этапы.

Recovery decisions SHALL extend existing `TeamState`/`CtoState` with `stage_recovery?: { schema_version: 1; lineages: Record<string, StageRecoveryLineage> }`. Initial recovery `generation` MUST be `0` and independent of `WorkIdentity.attempt >= 1`; stable key SHALL be scoped by `run/generation/wave/slice/stage/iteration/slot/root_dispatch`. Retries reuse the bounded budget; distinct workers append history without overwrite. Canonical journals persist safe events, budgets, grants and operations only; live ownership and selection proof are derived from the current claim on every read, and credentials or `authenticated:true` MUST NOT be persisted as authority.

#### Scenario: R06 Preflight отказ до запуска
- **WHEN** host подтвердил отказ до старта worker из-за пропущенного или неверного параметра, затем coordinator исправил вызов
- **THEN** canonical prepare persists queued replacement `WorkIdentity/retry_of` and bounded admission permit in existing `stage_recovery` operation; exact ready/consumed permit is derived from canonical ledger inside ordinary `authorizeRecord` or native `reserve` transaction, and one commit consumes it, persists ledger transition, creates exact owner-minted replacement identity and dispatch. No index pre-consumption or public `recovery_admission` credential exists; omitted `retry_of` resolves only a unique canonical prepared parent, explicit mismatch is denied. Host `sendMessage` reports only `authorized`/`queued`/`not_started`, ordinary admission atomically consumes the permit with dispatch creation, and only runtime events prove `running`/`terminal`. Ready/consumed permit survives operation-ack loss and queued acknowledgment does not invalidate ready; replay returns the exact identity. No direct task API or internal executor is invented.

#### Scenario: R07 Потеря связи с живым worker
- **WHEN** транспорт потерян, но worker подтверждённо продолжает выполнение
- **THEN** recovery восстанавливает наблюдение за тем же исполнителем либо ожидает доступности транспорта, не создаёт замену и принимает его последующий результат один раз

#### Scenario: R08 Подтверждённый сбой worker
- **WHEN** host подтвердил terminal failure worker
- **THEN** система возобновляет того же worker при поддержке host либо создаёт связанную замену после подтверждения отсутствия старого исполнения, передавая сохранённую задачу, доступные результаты и причину сбоя без повторения всего workflow

#### Scenario: R09 Состояние worker неизвестно
- **WHEN** после restart нет проверяемого terminal receipt или доступного транспорта
- **THEN** recovery сохраняет ожидание, явно сообщает неопределённость и доступный способ повторной сверки; не запускает дубль и не требует удалить state

#### Scenario: R10 Исправление задания уже работающего worker
- **WHEN** coordinator обнаружил пропущенное указание после подтверждённого старта worker
- **THEN** система использует поддерживаемое уточнение текущему worker либо подтверждённую остановку перед заменой; немедленный второй writer не запускается

### Requirement: Восстановление доступно без обхода authority

Исправимые блокировки SHALL направлять coordinator к recovery даже если обычный переход этапа сейчас запрещён. Read-only диагностика SHALL быть доступна подтверждённому host в пределах его worktree без требования валидного stage token; изменяющее восстановление SHALL отдельно проверять run, identity, branch, ownership и revision. Recovery MUST NOT выдавать authority из слов модели, менять чужой claim или считать повреждённое состояние idle. Повтор и конкурирующие вызовы SHALL сохранять единственность разрешённого действия.

#### Scenario: R11 Устаревший handoff
- **WHEN** переход отклонён из-за устаревшего handoff, но coordinator вправе продолжать этот запуск
- **THEN** recovery выдаёт актуальную точку продолжения через доверенную привязку без ручного подбора tokens, сброса этапа или повторного worker

#### Scenario: R12 Чужой owner либо повреждённое состояние
- **WHEN** recovery вызывается при живом чужом owner, несовпадающей identity/ветке либо подтверждённом повреждении canonical state
- **THEN** соответствующая причина различима, изменение запрещено, доступна безопасная диагностика или штатное действие, секреты и чужое состояние не раскрываются и не перезаписываются

#### Scenario: R13 Два recovery одной попытки
- **WHEN** два допустимых coordinator-запроса одновременно пытаются восстановить одну terminal попытку
- **THEN** только один переход получает право на замену, второй видит тот же результат либо конфликт актуальности, без второго worker

### Requirement: Ограниченное автоматическое восстановление

Предусмотренные исправимые отказы SHALL обрабатываться без ручного запуска новых сессий, удаления файлов и команд с внутренними stage ID. Recovery SHALL иметь сохраняемые ограничения попыток по классу ошибки; повторная доставка одной операции и restart MUST NOT обнулять лимит. Автоматическое продолжение SHALL сохранять исходный scope и обязательные человеческие решения. При исчерпании лимита или внешнем препятствии система SHALL сохранять прогресс, объяснять причину, выполненные попытки и конкретное необходимое действие; она MUST NOT объявлять успех либо бессрочно повторять один отказ.

#### Scenario: R14 Исчерпание лимита и последующее продолжение
- **WHEN** исправимые попытки исчерпаны, сессия перезапущена, затем пользователь разрешает новую ограниченную попытку или устраняет внешнюю причину
- **THEN** до такого действия исполнение остаётся объяснимо заблокированным без сброса счётчика; после него штатное продолжение использует сохранённый прогресс и записывает основание нового бюджета

#### Scenario: R15 Невалидная сдача и незавершённый producer
- **WHEN** сдача любого producer не прошла проверку либо worker завершился без обязательной сдачи
- **THEN** invalid submission returns exact schema errors to the same producer caller; default OMP 18 has no format-repair callback and `format_repair`/`producer_correction` remain unsupported. Only a truthful injected host may prove positive format-repair; fabricated ack or default implementation replacement for type errors is forbidden. A linked submission-repair executor is allowed only after worker terminal confirmation; for `orchestrator`/`tool` no worker terminal is required or created, implementation is not repeated and coordinator does not fabricate missing content

### Requirement: Доработка выполняет реальные итерации

Ошибка структуры сдачи SHALL исправляться отдельно от реализации. Содержательный FAIL verification либо changes-requested review SHALL запускать затронутую работу и зависимые проверки по профилю с сохранением допустимых upstream-результатов. Каждая итерация SHALL иметь собственный scope и evidence; downstream MUST NOT запускаться при неразрешённом FAIL. Счётчик итераций SHALL отражать реальные исполнения, а не синтетические успешные записи.

#### Scenario: R16 Debug-cycle FAIL затем PASS
- **WHEN** первая verification возвращает FAIL, а повторная после исправления PASS
- **THEN** реально выполняется второй diagnostics → implementation → verification, diagnostics получает evidence первого FAIL, начальная диагностика не требует будущего verification, а downstream запускается только после PASS

#### Scenario: R17 Debug-cycle исчерпал лимит
- **WHEN** каждая verification возвращает FAIL до настроенного максимума итераций
- **THEN** workflow останавливает цикл с последним evidence и причиной эскалации, не исполняет downstream и не записывает успешные фиктивные итерации

#### Scenario: R18 Review требует изменений
- **WHEN** review принят со статусом changes-requested
- **THEN** выполняются исправления, повторный review и нужные последующие проверки; незатронутые upstream-результаты сохранены, старое approval не разрешает изменённый результат

### Requirement: Ordinary и CTO сохраняют собственные lifecycle

Общие submission/recovery инварианты SHALL действовать в ordinary и CTO без преобразования CTO slug в ordinary run ID. Native CTO root SHALL делегировать только настроенному lead, а lead — разрешённым workers своего roster и slice. Завершение ordinary workflow SHALL освобождать execution ownership после всех условий. Завершение CTO волны SHALL переводить её в resident-ожидание без самовольной новой работы; явное пользовательское завершение CTO, включая обычный язык, SHALL закрывать run только после безопасного урегулирования активных workers.

#### Scenario: R19 Корректный CTO маршрут и запрещённый обход
- **WHEN** root пытается запустить roster worker напрямую, затем использует настроенный lead и допустимого worker
- **THEN** прямой обход отклоняется до старта, правильная цепочка проходит; recovery сохраняет тот же CTO scope и не требует ordinary workflow tools

#### Scenario: R20 Закрытие волны и новая волна
- **WHEN** команды завершили этапы и интеграцию волны, затем пользователь задаёт новую задачу
- **THEN** до новой задачи CTO ждёт без workers, новая волна не перезаписывает evidence прошлой, а закрытие волны не выдаётся за terminal run

#### Scenario: R21 Завершение задачи и CTO режима
- **WHEN** ordinary workflow полностью завершён либо пользователь явно завершает CTO с урегулированными workers
- **THEN** соответствующий run терминален, execution ownership освобождён, обычные host tools и новая независимая задача не блокируются его историей

#### Scenario: R22 Завершение CTO при активном worker
- **WHEN** пользователь просит закончить CTO, пока worker работает либо его terminal не подтверждён
- **THEN** система запускает поддерживаемую остановку или ожидает согласованное завершение, не освобождает конфликтующее право записи до подтверждения и сохраняет объяснимый статус

### Requirement: Граница хода и restart не теряют намерение и approvals

Остановка хода после классификации SHALL сохранять ещё не потреблённое намерение зарегистрированной команды в допустимой сессии; оно MUST NOT переноситься в чужую сессию, повторно использоваться после потребления или переживать явную supersession. Штатный restart/resume SHALL восстанавливать текущий этап и checkpoint без повторной классификации, завершённых workers или уже актуального approval.

#### Scenario: R23 Классификация затем Proceed
- **WHEN** зарегистрированный new запрос классифицирован, ход закончился до prepare, затем пользователь продолжает
- **THEN** создаётся один новый run по тому же действующему намерению; replay, чужая сессия и superseded intent не создают дополнительных запусков

#### Scenario: R24 Restart на checkpoint
- **WHEN** сессия закрыта на настоящем pending approval, а новая сессия штатно продолжает выбранный run
- **THEN** восстанавливается тот же этап и результат без повторного worker, новое действительное решение разрешает переход, повтор доставки решения не создаёт второго перехода
