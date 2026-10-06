# Spec Delta

## Purpose

Обеспечить согласованную и изолированную authority одной доверенной host-сессии при повторной загрузке private бандла через SDK module aliases. Контракт предотвращает потерю claim и повторные lifecycle-эффекты без расширения полномочий workers, headless-контекстов и скопированных session identities.

## ADDED Requirements

### Requirement: SA01 Стабильный host scope через SDK module aliases

Private бандл SHALL сохранять один host scope и согласованную authority для своих SDK-представлений в одном процессе, относящихся к тому же доверенному event bus, тому же объекту session manager и неизменившейся текущей сессии. Повторный import или activation через другой cache tag SHALL NOT создавать независимый claim holder или повторять эффекты engine admission/lifecycle. Равенство файлового пути модуля само по себе MUST NOT считаться доказательством session identity.

#### Scenario: Alias сохраняет полномочия текущего selected run
- **WHEN** доверенная host-сессия получила текущий execution claim, а тот же private бандл доступен через другой SDK import alias с тем же event bus и manager
- **THEN** разрешённая операция текущего selected run сохраняет ту же authority и не отклоняется только из-за различия module graph
- **AND** операция по-прежнему проходит canonical ownership и stage policy, без выдачи нового независимого claim

#### Scenario: Повторная activation не дублирует lifecycle-эффекты
- **WHEN** SDK повторно активирует представления того же private host scope и доставляет событие admission или lifecycle
- **THEN** повторная загрузка не создаёт повторных dispatch reservations, конкурирующих claim holders или повторных terminal mutations для одного исходного события

### Requirement: SA02 Объектная identity не заменяется совпадающими метаданными

Объединение SDK-представлений SHALL требовать точной доверенной runtime identity, а не только совпадающих session ID, cwd, header или полей manager. Другой event bus или другой объект manager MUST NOT наследовать authority существующего host scope. Явно зафиксированный worker SHALL оставаться отдельным от host; конфликтующая повторная association SHALL отклоняться без повреждения ранее действующей host authority.

#### Scenario: Копия manager не наследует claim
- **WHEN** другой caller предоставляет копию manager с теми же строковыми session ID и cwd, пока исходный host владеет текущим claim
- **THEN** копия не получает полномочий исходного host на selected-run mutation
- **AND** исходный host продолжает использовать свой действующий claim

#### Scenario: Другой runtime не объединяется по manager metadata
- **WHEN** caller из другого event bus предъявляет совпадающие session metadata
- **THEN** authority не объединяется с уже зафиксированным host scope по этим полям

#### Scenario: Worker не повышает себя до host повторным событием
- **WHEN** SDK-представление уже зафиксировано как worker и позднее получает контекст, заявляющий host или interactive роль
- **THEN** изменение роли или UI-флагов само по себе не переносит на него host claim и interactive rights

### Requirement: SA03 Primary UI и headless представления разделяют scope но не UI права

Primary UI и primary headless-представления одной доверенной host-сессии SHALL использовать согласованный scope независимо от порядка их загрузки. Новый доверенный захват primary headless-контекста SHALL отзывать interactive authority этого scope; сохранённое старое UI-представление MUST NOT расширять её собственным `hasUI`. Возврат interactive authority SHALL требовать нового доверенного захвата interactive-контекста той же текущей сессии. Headless stop/shutdown, не принимаемый как новый доверенный захват, MUST NOT сам по себе отзывать authority исходного interactive host. Headless worker другой сессии MUST NOT отзывать права primary host.

#### Scenario: Interactive alias затем primary headless alias
- **WHEN** после доверенного interactive захвата SDK выполняет новый доверенный захват того же primary scope с headless-контекстом через другой alias
- **THEN** UI-only command не разрешается до нового доверенного interactive захвата
- **AND** alias не создаёт отдельного controller для обхода этого отказа

#### Scenario: Headless-first затем interactive представление
- **WHEN** primary headless представление загружено первым, а затем SDK выполняет доверенный interactive захват той же сессии
- **THEN** interactive command использует тот же стабильный scope с подтверждёнными UI rights, без второго engine owner

#### Scenario: Worker lifecycle не подменяет primary session
- **WHEN** headless worker с другим manager посылает lifecycle событие рядом с действующим primary host
- **THEN** worker остаётся изолированным и не заменяет primary binding и его interactive authority

### Requirement: SA04 CTO claim binding сохраняет точного доверенного получателя

CTO ingress через одну копию core SHALL оставлять текущие приватные claim credentials доступными тому же объекту controller через другую копию core. Другой controller с совпадающими context metadata MUST NOT автоматически получать эти credentials. Межмодульное переиспользование SHALL сохранять проверки текущих canonical session, PID, ownership epoch и token; после штатного освобождения claim старая привязка MUST NOT давать полномочий через какой-либо alias.

#### Scenario: Ingress и claim reader принадлежат разным module graphs
- **WHEN** действующий CTO claim привязан через один core graph к controller, созданному другим graph
- **THEN** этот точный controller распознаёт свой текущий claim и может штатно освободить его
- **AND** отдельный controller с тем же context не наследует привязку

#### Scenario: Освобождение claim прекращает межмодульный доступ
- **WHEN** доверенный host штатно освобождает CTO claim и его private binding
- **THEN** прежний controller и другие module aliases не восстанавливают старые credentials по session ID, cwd или retained context

### Requirement: SA05 Private проект сохраняет одного workflow owner

В этом монорепозитории выбранная private конфигурация SHALL обеспечивать одного владельца workflow admission/lifecycle и доступность private command namespace вместе с private agent discovery. Выбор private owner MUST NOT отключать globally installed public bundle для других проектов или ослаблять gates. Загруженный процесс SHALL NOT считаться обновлённым только вследствие изменения source/build/config файлов.

#### Scenario: Public bundle установлен глобально а проект выбирает private
- **WHEN** public fullstack установлен глобально, но конфигурация этого проекта выбирает private бандл и исключает конкурирующую public загрузку
- **THEN** свежий OMP в проекте предоставляет `/omp-do-work`, `/omp-team`, `/omp-cto` и private workers под одним workflow owner
- **AND** глобальная установка public fullstack для остальных проектов остаётся без изменения

### Requirement: SA06 Приёмка отделяет SDK интеграцию от ошибок проверочного сценария

Приёмка alias repair SHALL включать проверку разрешённого selected-run поведения через разные module graphs, отказ copied identity и UI/headless границ, exact-controller CTO binding и bounded native lifecycle на фактически запущенном SDK. Native proof SHALL опираться одновременно на accepted worker publications и matching worker terminals, а завершение — на штатный fan-in, summary и освобождение claim. Oracle MUST NOT выдавать receipt без terminal, ошибочный fixture или сведения из соседнего package manifest за доказательство работы либо отсутствия API фактически запущенного SDK. Требование не разрешает новые H-прогоны и не меняет их исторические бюджеты.

#### Scenario: Persisted SDK session завершает native research lifecycle
- **WHEN** корректный fixture имеет сохраняемую parent SDK session, использует logical artifact IDs текущего назначения и вызывает control tools только из разрешённого coordinator scope
- **THEN** отдельные native workers самостоятельно выполняют назначение, их публикации принимаются, а matching terminal outcomes подтверждаются
- **AND** coordinator завершает fan-in и summary штатными API; все stages становятся done, capability complete и execution claim освобождается без ручной записи canonical state

#### Scenario: Продолжение использует уже принятые результаты
- **WHEN** coordinator продолжает тот же run после остановки проверочного запроса, а прежние worker publications и matching terminals уже приняты
- **THEN** завершение использует эти результаты без нового task dispatch и повторного выполнения workers

#### Scenario: Ошибка fixture не объявляется SDK несовместимостью
- **WHEN** проверка лишена parent session lineage, использует physical slot filename вместо logical artifact ID или поручает worker main-only control tool
- **THEN** отчёт отделяет эту ошибку от проверяемого alias/authority дефекта и не объявляет SDK unsupported без независимого доказательства
- **AND** результат завершённого корректного сценария не подменяет исходный отказ или незавершённые edge-case работы
