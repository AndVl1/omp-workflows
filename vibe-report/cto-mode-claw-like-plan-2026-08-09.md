# План улучшения CTO-режима: resident control plane вместо terminal-first prompt

Дата: 2026-08-09
Статус: исследование и планирование, исходный код не изменялся.

## 1. Вывод

Сейчас `/cto` уже умеет четыре важные вещи: запускать standby, принимать задачу, амендить активный run и будить main-session через inbox. Но это в основном **prompt-driven контракт**, а не нативный resident control plane. Поэтому пользователь видит отчёт после ручного действия, а не постоянно живого CTO, который принял задачу, подготовил её, показал состояние, передал слайсы лидам, дождался результата и сам вернулся в standby.

Нужно не копировать OpenClaw/Hermes целиком. Нужен узкий сдвиг архитектурного центра тяжести:

```text
сейчас:  /cto -> prompt -> main-agent действует -> файлы/терминал
цель:   channel/event -> resident CTO run -> intake/wave state
                         -> lead workflow gate -> workers
                         -> delivery policy -> channel/terminal
```

Сохраняем:

- CTO только в main session; nested CTO запрещён.
- `.work-state/cto/<run>/` как durable file-backed state.
- общий PHASE-0 и workflow matrix `/do-work`.
- CTO не пишет production source; лиды тоже только делегируют.
- существующие inbox/outbox, answer-файлы, leases, dedupe и EscalationAdapter.

Добавляем:

- явный lifecycle resident CTO и wave/task state machine;
- обязательную классификацию каждого входящего task и каждого team slice;
- механический gate до lead → worker dispatch;
- декларативные `read-only`/`read-write` каналы и primary/home policy;
- настоящую доставку status/summary, retry/receipt и quiet/no-change режим;
- heartbeat/cron как opt-in proactive behavior, а не мёртвый scheduler seam.

## 2. Что подтверждено в текущем репозитории

### 2.1. Стартовые режимы

- `/cto` без аргументов вызывает `buildStandbyCtoPrompt`, создаёт/усваивает standby-run и ждёт `[CTO-INBOX]` либо файл inbox. Standby не классифицируется: классифицируется уже каждая пришедшая задача.
- `/cto <task>` ищет active run; при наличии делает amend, иначе строит новый CTO prompt.
- В prompt уже есть единая PHASE-0 и та же матрица workflow, что в `/do-work`.
- В текущем active standby state `.work-state/cto/cto-full-scenarios-2026-08-07/state.json` отсутствуют `standby: true` и `owner_session`, хотя prompt требует эти поля. Это делает adoption семантически хрупкой.

Источники: `packages/fullstack/commands/cto/index.ts:20-37`, `packages/core/src/commands/cto.ts:131-179,587-653`, `.work-state/cto/cto-full-scenarios-2026-08-07/state.json:1-12`.

### 2.2. Канал пока не является control plane

- Dispatcher стартует только при наличии `.omp/escalation.json` и только в main session.
- В текущем workspace `.omp/escalation.json` отсутствует; поэтому пустой standby фактически слушает только терминал.
- `telegram` или `bidirectional: true` включают messenger mode, а `http` считается push-only.
- `createAskRedirectGate` блокирует `ask` только при active CTO run и bidirectional-канале. Это хорошее начало, но это лишь один gate, а не общая delivery policy.
- `sendPlainText` присутствует в интерфейсе, но in-session dispatcher его не использует для обычных status/summary сообщений.
- Scheduler умеет собрать digest и отметить wave timestamps, но standalone daemon по умолчанию получает `onWave: () => {}`.

Источники: `packages/fullstack/src/index.ts:203-251`, `packages/fullstack/src/adapters/registry.ts:102-132,308-353`, `packages/fullstack/src/messenger-channel.ts:51-75`, `packages/core/src/cto/scheduler.ts:55-106`, `packages/fullstack/src/cto-scheduler-daemon.ts:23-47`.

### 2.3. Lead соблюдает `/do-work` только на словах

`team-lead.md` требует выполнить sub-profile механически — `single` через одну задачу, `consilium` через parallel batch, с gates/checkpoints/artifacts. Но P5 gate читает `.work-state/team-state.json` или feature state и не видит классификацию внутри `.work-state/cto/<run>/`. CTO может передать lead slice без машинного доказательства PHASE-0 и правильного profile.

Текущий `.omp/teams.json` также задаёт `full-feature` всем четырём командам по умолчанию. Это противоречит смыслу общей matrix: маленький slice не должен автоматически получать full-feature.

Источники: `packages/core/src/commands/classification-contract.ts:31-80`, `packages/core/src/commands/do-work.ts:69-80`, `packages/core/src/gates/classification.ts:47-129`, `packages/fullstack/agents/team-lead.md:12-23`, `.omp/teams.json:1-34`.

## 3. Что взять из OpenClaw, Hermes и доклада

### OpenClaw

[Наблюдение] OpenClaw строит продукт вокруг Gateway: каналы, сессии, события и tools находятся в одном долгоживущем control plane; CLI/TUI/Web UI — клиенты, а не центр продукта.

[Наблюдение] В group policy разделены:

- кто имеет право инициировать запрос;
- должен ли запрос содержать mention;
- будет ли финальный текст автоматически опубликован или агент должен явно вызвать `message`.

Ambient room events дают полезную модель для RO-наблюдения: входящий шум становится контекстом, но комната остаётся молчаливой, пока агент явно не отправит сообщение.

### Hermes

[Наблюдение] Hermes Gateway — долгоживущий процесс с per-chat session store, cron scheduler и доставкой на разные платформы. Сессия не пересоздаётся на каждый message.

[Наблюдение] Hermes delivery ledger честно моделирует at-least-once: после crash ответ может быть повторно доставлен с видимой пометкой duplicate/recovered, а не потерян или тихо продублирован.

[Наблюдение] Hermes Kanban отделяет короткий `delegate_task` от durable work queue: у задачи есть status, assignee, dependency, comment thread, claim/reclaim, failure limit и idempotency key.

[Наблюдение] Hermes использует intentional silence tokens: turn сохраняется в transcript, но ничего не отправляется пользователю, если изменений нет.

### Транскрипция доклада

Доклад описывает близкую, но более domain-oriented декомпозицию:

- каналы нормализуют вход в очередь, затем router выбирает agent;
- NullBoiler — orchestration, routing, limits, retries, но не UI и не task storage;
- NullTickets — задачи с `claim/rent`, fail/forward и возвратом в очередь, чтобы умерший LLM не оставлял задачу навсегда;
- NullHub — dashboard;
- NullWatch — наблюдаемость;
- heartbeat каждые 30 минут, cron и subagents — три механизма proactivity;
- ночные спринты заканчиваются digest/PDF в Telegram.

Вывод: полезная цель — не «сделать ещё одного Claw», а разнести в CTO уже существующие concerns: intake, wave/task state, delivery, observability. Не нужно импортировать чужой Kanban или превращать omp-workflows в общий task tracker.

## 4. Целевой пользовательский контракт

### 4.1. `/cto <task>`: запуск с задачей

1. CTO показывает короткое `accepted` и выполняет PHASE-0.
2. При необходимости уточняет задачу, затем пишет canonical run state.
3. Создаёт отдельную `wave` с одним или несколькими подготовленными slices.
4. Для каждого slice фиксирует собственные `type`, `complexity`, `confidence`, `autonomous`, `workflow`.
5. Передаёт slices тимлидам. До этого не запускаются worker tasks.
6. Каждый lead проходит тот же stage discipline, что `/do-work`; после gate создаёт workers.
7. CTO публикует компактные переходы: `accepted -> preparing -> ready -> running -> blocked/done`.
8. После wave закрывает только wave и остаётся resident CTO, готовым принять следующую задачу.

Важно: lead не обязан буквально вызывать slash-команду `/do-work` — это main-session command surface. Общий классификатор, resolver, state schema и stage validator должны стать reusable contract, который lead выполняет механически. Иначе получится nested command illusion, а не enforcement.

### 4.2. `/cto`: пустой запуск

1. Создаётся canonical `standby` state с `standby: true`, без classification и без task teams.
2. CTO отвечает пользователю:
   - какие каналы подключены;
   - какой RW-канал primary;
   - какие RO-каналы получают отчёты;
   - что при отсутствии канала standby слушает только терминал.
3. Если есть RW channel, туда уходит один online acknowledgement: `CTO online, awaiting tasks`.
4. Входящие messages не считаются автоматически задачами без policy: explicit command/DM — task, RO/ambient input — context-only.
5. При каждой wave CTO возвращается в standby, не завершая resident run.

### 4.3. Inbound task из канала

Нормализованный event должен содержать `channel_id`, `message_id`, `sender`, `target_run`, `text`, `received_at`, `mode`, `idempotency_key`.

Dispatcher:

1. валидирует размер, sender policy и channel capability;
2. дедуплицирует event;
3. пишет его в inbox до wake;
4. будит owner session, если она жива, либо оставляет durable queue для следующего owner;
5. CTO классифицирует его как отдельную задачу/wave;
6. отвечает ACK в том же RW channel, а не в терминале.

Это сохраняет уже работающий порядок `durable file -> wake`, но делает routing и status наблюдаемыми.

### 4.4. Каналы: явная семантика

Предлагаем считать direction с точки зрения CTO:

```json
{
  "channels": [
    {
      "id": "telegram-main",
      "adapter": "telegram",
      "direction": "read-write",
      "preferred": true,
      "home": "-1001234567890",
      "subscriptions": ["tasks", "answers", "status", "summary"]
    },
    {
      "id": "ops-alerts",
      "adapter": "http",
      "direction": "read-only",
      "subscriptions": ["status", "summary", "errors"]
    }
  ]
}
```

- `read-write`: CTO принимает команды/ответы и отправляет сообщения. Это primary user surface; вопросы, решения, ACK, progress и summary идут сюда вместо `ask`/терминала.
- `read-only`: CTO только публикует report/status. Сообщение с такого канала не становится командой и не может разблокировать run.
- `preferred: true`/`home`: определяет единственный target для conversational delivery; RO может получать fan-out.
- При нескольких RW должен быть явный priority, не случайный порядок конфигурации.

`read-write` должен включаться только если adapter фактически поддерживает inbound path (`pollOnce` и/или `setPlainMessageHandler`) и capability probe прошёл. Нельзя блокировать `ask` на одном `bidirectional: true`, если ответ физически не может прийти.

Терминал при активном RW не исчезает полностью: он остаётся локальной observability/fallback поверхностью. Но он не должен быть вторым обязательным каналом коммуникации и не должен дублировать длинные status reports.

## 5. Рекомендуемый план реализации

### P0. Стабилизировать canonical lifecycle и contracts

**Цель:** сделать состояние, которое можно честно показать пользователю и восстановить после рестарта.

- Ввести `run -> wave -> team slice` в `.work-state/cto/<run>/`.
- Зафиксировать `standby`, `owner_session`, `active_wave`, `last_activity`, `channel_policy` в canonical state.
- Сделать self-healing только для узкого legacy standby-критерия; не выводить standby из любого task, содержащего слово `standby`.
- Развести `task run terminal` и `resident standby`: wave может быть done, resident run — active.
- Входящий task всегда получает idempotency key и отдельную запись.

**Gate:** state schema однозначно отвечает: где сейчас CTO, какая wave активна, кто ждёт пользователя, куда будет отправлен следующий статус.

### P1. Сделать channels[] и delivery policy first-class

**Цель:** RW действительно заменяет terminal ask, RO становится report sink.

- Расширить config с legacy single-adapter fallback до `channels[]`.
- Добавить `direction`, `preferred/priority`, `home`, `subscriptions`, capability metadata.
- Вынести `resolveChannelPolicy()` в один источник; `renderChannelSection`, dispatcher и ask gate не должны отдельно угадывать telegram/http.
- Добавить capability validation и fail-closed degradation:
  - RW config без inbound capability -> явная ошибка, ask не блокируется;
  - RO config -> только outbound status;
  - отсутствующий channel -> явный terminal-only notice.
- Сохранить backward compatibility для текущих `.omp/escalation.json`.

**Gate:** тесты показывают, что при RW вопрос не уходит в `ask`, при RO вопрос не отправляется как ожидающий ответа, а при no-channel пользователь получает понятное предупреждение.

### P2. Delivery, ACK, summary и restart reliability

**Цель:** пользователь видит работу в канале, а не только в отчёте после ручного запроса.

- Подключить `sendPlainText` к in-session dispatcher и standalone bridge.
- Ввести типы delivery: `ack`, `progress`, `question`, `decision`, `summary`, `error`.
- Сделать durable delivery ledger в текущем file-backed стиле: `pending -> sending -> sent|failed`, attempts, channelRef, last_error, redelivery marker.
- Все plain pushes прогонять через ту же redaction policy, что escalation.
- Доставлять summary после завершения wave dispatcher-ом по canonical state, а не надеяться, что модель не забыла написать outbox.
- Добавить quiet/no-change policy: heartbeat без изменений не создаёт сообщение; явный `silence` остаётся в transcript/state.
- При restart повторная доставка должна быть честно маркирована, а не silently duplicated.

**Gate:** mock adapter подтверждает ACK, wave summary, retry, failed delivery, restart redelivery и отсутствие двойного wake на duplicate inbox event.

### P3. Intake и строгий `/do-work` lead workflow

**Цель:** требование пользователя становится машинным контрактом.

- При подготовке каждой wave CTO создаёт `slice classification` и `resolved workflow` из общей matrix.
- Передаёт lead immutable slice contract: scope, profile, classification, dependencies, DoD, artifact path.
- Добавить CTO-aware P5 gate: поиск активной wave и проверка classification перед `task`.
- Lead до первого worker обязан записать stage state/artifact; gate проверяет:
  - classification fields присутствуют;
  - workflow соответствует matrix;
  - текущая stage разрешает dispatch;
  - scope и team ownership совпадают.
- Worker dispatch до gate блокируется с actionable reason.
- Добавить team state machine: `triage -> ready -> running -> blocked -> done|failed`, `assignee`, `lease`, `heartbeat`, `attempt`, `failure_limit`, `comments`, `artifacts`.
- Заимствовать у Hermes claim/rent/reclaim, но хранить в текущем `.work-state`, не создавать отдельный общий Kanban продукт.
- После lease timeout lead/slice возвращается в `ready` или `blocked`, а не остаётся навсегда `running`.
- Для маленьких slices profile должен резолвиться как `lightweight`/`standard`, а не из default `full-feature`.

**Gate:** невозможно создать worker task для slice без валидной PHASE-0/profile записи; dead lead lease можно reclaim; completion требует DoD evidence.

### P4. Resident process и proactive behavior

**Цель:** пустой `/cto` реально ощущается как always-on CTO.

- Оставить session dispatcher для живой main session.
- Достроить standalone resident bridge/daemon, который при отсутствии интерактивной сессии владеет channel polling, inbox, outbox и wake queue.
- Подключить `buildDigest` к реальному `onWave`/delivery policy.
- Разделить:
  - `heartbeat`: дешёвая проверка активных waves/blocked tasks/новых событий;
  - `cron`: пользовательское расписание конкретного исследования/отчёта;
  - `wave`: фактическая работа команд.
- Без явного расписания heartbeat не должен самовольно спавнить coding teams. Для claw-like feel можно включить opt-in default cadence (например, 30 минут), но heartbeat сначала только проверяет и сообщает изменения.
- `/sethome`-подобная команда/конфигурация должна задавать target proactive reports.

**Gate:** остановка/перезапуск интерактивной сессии не теряет queued task, pending answer, outbox delivery или wave state; heartbeat не создаёт шум при отсутствии изменений.

### P5. Native status surface

**Цель:** приблизить UX к NullHub без создания отдельного продукта.

- Сгенерировать компактную проекцию `/cto status` или `report.html` из canonical state.
- Показывать resident status, active waves, team states, blockers, pending decisions, last delivery и next heartbeat.
- Канал получает короткие карточки; dashboard/report получает детали.
- Терминал становится control/debug client, а не единственным местом, где можно понять, что происходит.

Это можно реализовать после P1–P4; live web dashboard не должен блокировать channel-native lifecycle.

## 6. Сценарии приёмки

1. **Empty /cto, no channel**
   - state содержит `standby: true`;
   - terminal явно говорит `terminal-only standby`;
   - пользователь не получает ложное обещание, что messenger wake работает.

2. **Empty /cto, RW channel**
   - channel получает ровно один online ACK;
   - terminal `ask` становится недоступен только для active CTO questions;
   - inbound task будит standby и создаёт отдельную wave.

3. **/cto с начальной задачей**
   - сначала появляется `accepted/preparing`, затем classification и TeamPlan;
   - каждый lead получает slice classification и profile;
   - worker dispatch невозможен до lead workflow gate.

4. **Несколько входящих задач**
   - duplicate message id не создаёт вторую wave;
   - две независимые задачи не сливаются в одну неявную команду;
   - после первой wave CTO возвращается в standby и принимает вторую.

5. **Только RO channel**
   - status/summary доставляются;
   - сообщения из этого транспорта не считаются commands/answers;
   - blocker остаётся terminal/RW escalation, а не зависает в псевдо-RW режиме.

6. **RW + RO channels**
   - RW получает ACK, questions, decisions и primary summary;
   - RO получает только подписанные status/summary/error события;
   - terminal не дублирует полный пользовательский поток.

7. **Crash/restart**
   - outbox и pending task redeliver с receipt/attempt metadata;
   - dead lead lease reclaimable;
   - ответ после закрытия escalation помечается advisory/stale.

8. **Heartbeat**
   - при изменениях отправляет короткий digest в home/primary channel;
   - при отсутствии изменений не пишет пользователю;
   - не создаёт coding wave без отдельного cron/task policy.

## 7. Предлагаемая декомпозиция по командам

Если превращать план в следующий `/cto` implementation run, использовать четыре непересекающихся slices:

- `cto-core`: canonical run/wave/slice state, classification contract, CTO-aware P5, lead dispatch state machine.
- `cto-safety`: channels[], capability validation, sender policy, idempotency, redaction, delivery ledger.
- `cto-operations`: resident dispatcher handoff, plain status, summary delivery, heartbeat/cron/digest.
- `cto-quality`: prompt/role contracts, acceptance matrix, mock/integration tests, report projection and migration checks.

Каждый lead проходит собственную PHASE-0 и profile resolution по `/do-work`; `full-feature` не должен приниматься только потому, что он записан default в `.omp/teams.json`. CTO сначала создаёт cross-team contract, затем запускает leads; lead обязан передать slice worker-у только после своего workflow gate.

## 8. Риски и границы

- **RW deadlock:** нельзя блокировать `ask`, пока capability probe не подтвердил inbound. Fallback — terminal с явным warning.
- **Duplicate delivery:** нужен ledger и видимая маркировка recovered/duplicate; иначе пользователь не понимает, что произошло после restart.
- **Prompt injection из каналов:** inbound text — untrusted data, никогда не policy override. Сохраняем quarantine, length cap, sender policy и redaction.
- **Hard gate может остановить run:** сначала блокировать только worker dispatch/close, а не сам intake; на legacy state давать migration/fail-closed reason, не бесконечный retry.
- **Stale custom commands:** после изменения command source обязательны copy-commands в локальные roots и новый session; это release/test concern, не обходить ручным редактированием копий.
- **Resident credentials:** standalone process получает только нужные channel credentials и ограниченный file scope; не давать ему произвольный source write.
- **Scope creep:** не внедрять отдельный Hermes Kanban database, multi-agent product, generic workflow engine или full dashboard до доказанного P1–P3 user value.

## 9. Источники

### Репозиторий

- `packages/fullstack/commands/cto/index.ts`
- `packages/core/src/commands/cto.ts`
- `packages/core/src/commands/classification-contract.ts`
- `packages/core/src/commands/do-work.ts`
- `packages/core/src/gates/classification.ts`
- `packages/fullstack/src/index.ts`
- `packages/fullstack/src/adapters/registry.ts`
- `packages/fullstack/src/messenger-channel.ts`
- `packages/core/src/cto/{types,state,scheduler}.ts`
- `packages/fullstack/src/cto-scheduler-daemon.ts`
- `packages/fullstack/agents/{cto,team-lead}.md`
- `docs/adding-escalation-adapter.md`
- `/Users/a.vladislavov/Downloads/transcript-290526.txt`

### OpenClaw

- [README / Gateway model](https://raw.githubusercontent.com/openclaw/openclaw/main/README.md)
- [Groups: mention, visible replies, session keys](https://docs.openclaw.ai/channels/groups)
- [Ambient room events](https://docs.openclaw.ai/channels/ambient-room-events)

### Hermes Agent

- [Messaging Gateway: sessions, silence, delivery ledger, home channel](https://hermes-agent.nousresearch.com/docs/user-guide/messaging)
- [Kanban: durable task handoff and dispatcher](https://hermes-agent.nousresearch.com/docs/user-guide/features/kanban)
- [Gateway internals: routing, interrupts, delivery and hooks](https://hermes-agent.nousresearch.com/docs/developer-guide/gateway-internals)
- [Security and approval policy](https://hermes-agent.nousresearch.com/docs/user-guide/security)
