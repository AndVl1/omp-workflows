# CTO Control Plane — E2E валидация (детерминированный движок + live LLM)

Slug: `cto-control-plane-e2e-2026-08-07` · Run: `cto-control-plane-20260806-232053-1` · Дата: 2026-08-07

Отчёт построен на артефактах двух независимых прогонов и итогах code review. Все результаты
локальные и явно помечены `non_production: true` — прод-валидация для plugin-source monorepo
невозможна (нет production deploy script, URL или hosted health endpoint). Никаких скриншотов,
строк исходников или результатов, не зафиксированных в артефактах, здесь не приводится.

---

## 1. Итоговый вердикт

| Контур | Вердикт | Источник |
|---|---|---|
| Детерминированный движок (mock omp), сценарии S1–S6 | **PASS** (non-production) | `.work-state/artifacts/integration/full-scenarios-evidence.json` |
| Живой LLM (gpt-5.6-luna:max), фазы P1–P6 | **BLOCKED_ON_LLM_TURN_COMPLETION** (non-production) | `/tmp/cto-real-live-evidence/final.json` |
| Юнит-тесты и сборки после фиксов D1/D2 | PASS (194 + 158 тестов, все сборки) | команды в разделе 6 |
| Code review | APPROVE, high-находок нет | ревью пайплайна |

Ключевое различие: **PASS относится только к детерминированному движку** (TS-engine, без LLM).
Живой LLM-прогон подтвердил intake/amend/persistence state, но заблокировался на завершении
turn'а LLM и на шаге делегирования — по причине отсутствующих предпосылок в scratch
(`.omp/teams.json`, source tree) и bounded timeout, а не из-за дефекта движка (детали в разделе 4).

---

## 2. Объём и платформа

- **Платформа:** локальный `packages/e2e` (omp 17.2.10) — mock surface для детерминированного
  прогона и text-mode surface для live LLM-прогона. Прод отсутствует в репозитории.
- **Детерминированный прогон:** `full-scenarios-evidence.json`, run `cto-full-scenarios-2026-08-07`,
  elapsed ~7.9s, mock omp (`mock-omp.sh`), без какого-либо LLM — проверялся только TS-движок
  (state, inbox/quarantine, outbox/redaction, answers, leases, миграция схемы).
- **Live LLM-прогон:** `/tmp/cto-real-live-evidence/`, omp 17.2.10, PID 31234,
  модель `openai-codex/gpt-5.6-luna:max`, сессия ~660s (08:09:29 → 08:20:11), transcript 6.27 MB,
  73 distinct spinner-step. Реальная LLM-инвокация, реальный `/cto` custom-TS command, реальный
  inbox file drop. ВАЖНО: omp вызывает LLM для main-сессии под ролью `default`
  (modelRoles.cto настроена на ту же модель — поведение согласовано).
- **Чеклист сценариев:** `vibe-report/cto-full-scenarios-2026-08-07-e2e-scenario.md` —
  персистентное состояние, шаги отмечались `[x]` по мере выполнения.

---

## 3. Детерминированный прогон: сценарии S1–S6

Вердикт по каждому сценарию — PASS (детерминированный mock, не LLM):

- **S1 — Standby `/cto` персистит state schema 2.** state.json: `schema=2`,
  `id=cto-full-scenarios-2026-08-07`, `task="Standby until inbox tasks arrive"`, `teams=[]`,
  `pause.kind=none`, `autonomous=true`.
- **S2 — Валидная inbox-задача admitted.** drop → `inbox/` файл, `inbox_quarantine[hash].status=admitted`,
  `rec.by/rec.id` записаны, payload обработан как данные (не инструкции).
- **S3 — Второй `/cto`-amend сворачивается в тот же run.** `findActiveCtoRun` вернул тот же
  `cto-full-scenarios-2026-08-07`; amend длиной 129 символов доставлен одним input-line,
  standby prompt отрисован повторно.
- **S4 — Escalation round-trip: redact → send → answer → без двойного применения.**
  `drainOutbox sent=true movedToSent=true`; адаптер получил чистое тело (секрет `AKIA-TEST-SECRET-12345`
  вырезан, текст подтверждения сохранён); файл в `outbox/sent/` — оригинал (аудит-копия, секрет на месте);
  answer'а через `mockAdapter.pollOnce`, `answers/esc-1786089377027.json` записан; повторный pollOnce
  доставляет следующую answer'у без дублей (dedup в `seenAnswersByRoot`).
- **S5 — Inbox safety: dedup, reject, payload как данные.** 5a duplicate — deduped без re-wake;
  5b empty — rejected; 5c oversized (4100B > 4000B) — rejected; 5d injection — filed as data
  (текст сохранён verbatim, секрет заредоктирован, инструкции не исполнены). Итог
  `inbox_quarantine: {"admitted":3,"rejected":2}`.
- **S6 — Stop+restart: состояние сохранено, schema-1 → 2 миграция, lease recovery.**
  hash state.json до/после остановки идентичен (`1d98e46fca94d548`); `MOCK_STATE_PRESERVED` после
  restart; миграция schema-1 → schema-2 ok; stale `dispatcher.lock` отсутствует; `findActiveCtoRun`
  находит canonical run. В S6 же зафиксирован дефект D2 (см. раздел 5).

**Не покрыто детерминированным прогоном** (зафиксировано в evidence `not_exercised`):
LLM-side natural-language синтез, цепочка делегирования team-lead → worker (в mock omp нет
team dispatch), live Telegram long-poll (в прогоне in-process mock adapter), реальный LLM provider
(в sandbox провайдера не было).

---

## 4. Live LLM-прогон: фазы P1–P6

Модель `openai-codex/gpt-5.6-luna:max`, omp 17.2.10. Вердикты по фазам:

- **P1 standby — PASS_LLM_EVIDENCE** (240s). LLM получил `/cto` и персистил standby run
  (`/tmp/omp-ux-e2e-cto-real-live/.work-state/cto/standby-20260807T081007Z/state.json`, schema=1 —
  т.е. live-прогон шёл на старом промпте, см. D1). Spinner-трейс: «Track standby initialization →
  Inspect CTO state and registry → Read configured team registry → Persist active CTO standby run
  → Inspect E2E harness transcript → Read pending CTO inbox». Естественного prose-финала не было:
  turn не завершился за 240s.
- **P2 feature intake — PASS_LLM_EVIDENCE** (input пришёл во время идущего turn'а P1 — merged).
  LLM встроил feature request (`/export CSV` + scheduler + admin UI toggle) в активный run как
  wave-2; трейс: «Adopt queued task into active run → Inspect queued workflow tasks → Read CTO
  command configuration → Resolve CTO workflow profile».
- **P3 amend clarification — PASS_LLM_EVIDENCE.** state.json переписан: `amended_at`,
  `plan.pending_waves[1]` — CSV feature с полным уточнением (admin_toggle=boolean,
  csv_fields=[order_id, created_at, total, status], snapshot=full, streaming=false,
  schedule='daily at 03:00 UTC'), `pending_waves[0]` — inbox `/healthz` задача **не смёржена**
  (amend-дисциплина соблюдена). `decisions.md` фиксирует контракт и checkpoint-pause.
- **P4 inbox — FILE_PERSISTED_NO_DISPATCHER.** Файл `inbox/live-inbox-1.json` создан на диске и
  подхвачен LLM в amend-turn как wave-1 (в `state.json`). Отдельный dispatcher не понадобился —
  резидентный LLM прочитал drop в рамках своего turn'а.
- **P5 feedback/escalation — NOT_EXERCISED.** В scratch нет escalation-адаптера
  (нет `.omp/escalation.json`), full dispatcher требует Telegram/HTTP mock, которого в прогоне нет.
- **P6 team plan / delegation — BLOCKED_NO_DELEGATION.** LLM понизил `autonomous=false`,
  `pause.kind='checkpoint'` с reason «Missing .omp/teams.json registry and order API source tree».
  Команды не спавнились; `decisions.md` явно фиксирует «No worker or lead was spawned; no code
  was changed». Это желаемая дисциплина (LLM отказался выдумывать teams/source для
  несуществующего репозитория order API), а не отказ работы.

**Ограничения и наблюдения live-прогона** (из `final.json`):
- LLM-инвокация main-сессии идёт под ролью `default`, не `cto` (роль `cto` для main-сессии omp
  не использует; обе настроены на одну модель).
- LLM не выдал natural-language TeamPlan/delegation-прозу: контракт персистился на диск
  (state.json + decisions.md), но turn не завершился в пределах bounded wait
  (240s + 90s + 60s + 90s ≈ 8 мин) — LLM продолжал итерировать «Resolve missing CTO prerequisites».
- P2/P3 первоначальные PASS от драйвера были false positive (regex совпал со stale state.json из
  буфера); существенный PASS здесь установлен по артефактам state.json + decisions.md независимо
  от драйвера.
- Amend-дисциплина подтверждена: wave-1 (inbox `/healthz`) и wave-2 (user `/export CSV`) сохранены
  отдельными записями `pending_waves`, не смёржены.
- Известное ограничение harness 17.2.10: xterm web surface фризится (документировано в lessons);
  authoritative source — text-mode transcript.

---

## 5. Исправления (дефекты D1/D2 и контрактные фиксы)

Дефекты задокументированы в mock-evidence `defects_reported` и **исправлены на диске**:

- **D1 (medium, S1) — Schema-1 prompt drift в shipped `/cto` command.**
  `packages/fullstack/commands/cto/_lib/cto.ts:buildStandbyCtoPrompt` инструктировал агента писать
  schema-1 standby state (`pause.kind=none, teams=[], autonomous=true, task='standby — awaiting inbox tasks'`),
  тогда как engine canonical schema = 2. Live-прогон P1 это подтвердил: реальный LLM записал schema=1.
  **Фикс:** прямой standby-писатель переведён на canonical schema-2 поля (`cto.ts`, 1 строка) —
  shipped prompt теперь соответствует engine-контракту.
- **D2 (medium, S6) — canonicalizeState не backfill'ит schema-2 поля при partial raw input.**
  `migrateCtoState` возвращал raw schema>=2 как есть, без `budget/leases/decisions/inbox_quarantine`;
  потребители (`setTeamStatus`) на этих полях гейтятся и молча пропускали работу.
  **Фикс:** `packages/core/src/cto/state.ts` — миграция/канонизация с backfill'ом schema-2 полей
  (29 строк); покрыто тестами в `packages/core/test/cto-engine.test.ts`.
- **Контрактные фиксы:** `packages/fullstack/src/adapters/registry.ts` — прямой
  `ensureStandbyRun` (canonical schema-2 writer: `budget: defaultBudgetState()`, leases, decisions,
  inbox_quarantine) вместо standby state, создаваемого промптом; тесты
  `packages/fullstack/test/adapters.test.ts`; `packages/fullstack/test/cto-command.test.ts` —
  регресс на schema-2 standby. Отдельного feedback/answer wiring это не добавляет: P5 остаётся
  NOT_EXERCISED, S4 покрыт детерминированным mock-адаптером (in-process).

Изменённые файлы (рабочее дерево, `git status --short`; 6 файлов, +119/−21):

```
M packages/core/src/cto/state.ts                        # D2: canonicalize/migrate backfill schema-2
M packages/core/test/cto-engine.test.ts                 # тесты миграции/backfill
M packages/fullstack/commands/cto/_lib/cto.ts           # D1: standby-писатель schema-2
M packages/fullstack/src/adapters/registry.ts           # ensureStandbyRun: прямой canonical schema-2 writer (defaultBudgetState)
M packages/fullstack/test/adapters.test.ts              # тесты adapter round-trip
M packages/fullstack/test/cto-command.test.ts           # регресс schema-2 standby
```

---

## 6. Команды проверки (точные команды и результаты)

Локально, non-production:

| Команда | Результат |
|---|---|
| `npm run build:core` | PASS |
| `npm run build:fullstack` | PASS |
| `npm run test:core` | PASS, **194 теста** |
| `npm run test:fullstack` | PASS, **158 тестов** |
| `npm run typecheck:commands -w @andvl1/omp-workflows-fullstack` | PASS |
| `npm run build -w @andvl1/omp-workflows-e2e && node --test --import tsx packages/e2e/test/cto-inbox-mock.test.ts` | PASS, **1 тест** (детерминированный mock S1–S6 контур) |
| Code review | **APPROVE**, high-находок нет |

Детерминированный mock E2E: `.work-state/artifacts/integration/full-scenarios-evidence.json`
(verdict `PASS`, `non_production: true`, run `cto-full-scenarios-2026-08-07`). Live LLM:
`/tmp/cto-real-live-evidence/final.json` (verdict `BLOCKED_ON_LLM_TURN_COMPLETION`).

Результаты команд взяты из артефактов валидации пайплайна (этот отчёт — документация, команды
повторно не запускались).

---

## 7. Оставшиеся блокеры и риски

- **Feedback adapter не подключён в live scratch** — P5 NOT_EXERCISED: в
  `/tmp/omp-ux-e2e-cto-real-live` нет `.omp/escalation.json`; полный round-trip
  (outbox → adapter → answers) live с реальным LLM не проверен. Детерминированный контур S4
  (in-process mock adapter) — PASS.
- **Нет natural-language финального ответа и делегирования у живого LLM** — причина:
  отсутствующие предпосылки в scratch (`.omp/teams.json`, source tree order API) + bounded turn
  timeout (~8 мин). LLM корректно вошёл в checkpoint, а не выдумал teams. Цепочка
  team-lead → worker с реальным провайдером не выполнена нигде (в mock её тоже нет).
- **Live-прогон повторно не проверял S1–S6** — они детерминированные и независимые; live проверял
  только LLM-side intake/amend/persistence.
- **Роль `default` vs `cto`** для main-сессии omp: поведение согласовано конфигом, но
  закладываться на роль `cto` в проде нельзя.
- **xterm web surface 17.2.10 фризится** (harness-ограничение, не наш код); live-валидация
  опиралась на text-mode transcript.
- Прод-валидация не выполнялась и не утверждается: платформа для прод-проверок в репозитории
  отсутствует.

## 8. Очистка и пути к артефактам

- Детерминированный прогон: scratch `/tmp/omp-ux-e2e-cto-full-scenarios-2026-08-07` **удалён**
  после записи evidence; playwright-сессия `cto-full-scenarios-2026-08-07` закрыта. Evidence:
  `.work-state/artifacts/integration/full-scenarios-evidence.json`; screenshots dir:
  `.work-state/artifacts/integration/evidence`; transcript:
  `.work-state/ux-e2e/transcript.jsonl` (путь внутри удалённого scratch — см. evidence).
- Live-прогон: omp-процесс остановлен (`ux-e2e stop`, SIGTERM→SIGKILL); scratch
  `/tmp/omp-ux-e2e-cto-real-live` **удалён** после сохранения evidence (подтверждено follow-up
  RealCtoFlow). Evidence сохранено в `/tmp/cto-real-live-evidence/`: `final.json`, `state.json`,
  `decisions.md`, `inbox-live-inbox-1.json`, `phases.json`, `driver.log`, `screen-00..99.txt`,
  `transcript-tail.jsonl`. Пути внутри scratch (run dir
  `/tmp/omp-ux-e2e-cto-real-live/.work-state/cto/standby-20260807T081007Z/`, transcript) —
  исторические: файлы наблюдались в ходе прогона, сам scratch сейчас отсутствует.

## 9. Готовность к PR

- **Да**, при явно зафиксированных ограничениях: движок S1–S6 PASS (non-production), D1/D2
  исправлены и покрыты тестами, 194+158 тестов зелёные, все сборки/typecheck проходят,
  code review APPROVE.
- **В PR обязательно вынести**: (1) live-ограничения из раздела 7 — P5 не выполнен, делегирование
  с реальным LLM не проверено, финальный prose-ответ LLM не получен (bounded timeout +
  отсутствующие предпосылки scratch); (2) отсутствие прод-валидации; (3) харнесс-ограничение
  xterm 17.2.10. Без этого PR может быть прочитан как «полная live-валидация» — это не так.
