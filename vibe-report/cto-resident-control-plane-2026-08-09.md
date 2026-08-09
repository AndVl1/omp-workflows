# CTO Resident Control-Plane — финальный отчёт (feature summary)

Slug: `cto-resident-control-plane`
Дата: 2026-08-09
Run: `cto-full-scenarios-2026-08-07`
Branch: `feat/cto-resident-control-plane` (HEAD = `f0bbc68 feat(cto): add resident control plane lifecycle`)
Статус: **COMPLETED / PASS**

---

## 1. Feature complete statement

Функциональность **CTO resident / control-plane lifecycle** реализована полностью и
подтверждена evidence-артефактами: процессный E2E harness (реальный child-process
граничный слой, реальные git worktrees, persisted fake-RW transport) проходит
детерминированно (4 из 4 последовательных запусков в сессии), регрессионные фокусные
тесты зелёные, финальные code/security review — PASS без CRITICAL/HIGH-остатков.

`dod.json` (`.work-state/artifacts/dod.json`): `type_requirements_met: true`,
все 15 критериев discovery/architecture + 2 добавленных qa_tests-критерия +
12 runtime-дополнений manual_qa — `met`.

Закрытые зоны:

- **Resident standby**: пустой `/cto` создаёт каноничный standby-run; run живёт
  между волнами и принимает новые inbox-задачи (PHASE F: follow-up в том же runId).
- **Channel-native коммуникация**: RW-primary (control) vs RO-report (audit) —
  единый resolver `resolveChannelProfile` (`rw|ro|none`), рендер секции каналов в
  промптах, `ask`-гейт при RW + active run, RO никогда не получает inbound/answers.
- **Inbox-волны с dedupe**: durable admission, quarantine (sha256 admitted-хэш),
  restart recovery (PHASE D), duplicate-id dedupe (PHASE E).
- **Concurrent worktree-слайсы**: реальные git worktrees на отдельных ветках,
  per-slice DoD до worker-start, wave completion + summary-доставка (PHASE B).
- **Marker-gated lead dispatch**: `ctoSliceTaskGate` fail-closed при active wave
  без валидного slice-маркера; `ctoNestingGuard` блокирует `task(agent:'cto'|'@cto')`
  и batched-форму (PHASE G).
- **Telegram inbound authorization (SEC-1)**: chat/sender allowlist, fail-closed,
  offset advance на reject.
- **Telegram hardening (SEC-001/SEC-002)**: path-traversal блокировка callback
  escId/runId, token-free `channelRef` при fetch-ошибках.

## 2. User-visible behavior

- `cto`-резидентный сеанс после создания standby остаётся активным между волнами;
  новая задача из RW-канала (`.omp/fake-rw-control/inbound/`, Telegram) создаёт
  новую волну **в том же run** без нового standby.
- Доставка: ACK (admission) и summary уходят только на RW primary; RO-канал
  (audit) получает **только** summary-строки, никогда ack/question/progress, и не
  имеет inbound/answers-путей.
- Каждая волна исполняет слайсы параллельно в изолированных git worktrees;
  повторные волны **переиспользуют** worktrees (счётчик worktrees не растёт).
- Дубликаты сообщений (same id + same/different text) не порождают вторую волну;
  после рестарта диспетчер восстанавливает pending-доставки без повторного
  приёма задачи.
- Вложенный CTO (`task(agent:'cto')`) механически блокируется; слайс-диспатч
  без валидного маркера во время active wave блокируется с actionable reason.
- Telegram: ответы/задачи принимаются только от разрешённых chat/sender
  (конфигурируемые `allowedChatIds`/`allowedSenderIds`); malformed callback ids
  отбрасываются fail-closed; при сетевых ошибках `channelRef` не содержит токен
  бота.

## 3. Key decisions / trade-offs

| Решение | Почему | Trade-off |
|---|---|---|
| Единый `resolveChannelProfile` (`rw\|ro\|none`) вместо неявных dual-путей | Один источник истины направления канала; `ask`-гейт и рендер секции из одного resolver | Legacy `bidirectional:true` на http сохранён через compatibility-ветку; явный `channels[]` с declared-rw http деградирует до ro (capability rule) |
| RO-доставка «честная»: all-sinks-fail → остаётся в outbox retryable | static-1: никакого «архивировано как sent» при полном отказе | Три документированных исхода: retryable / archived+sinkErrors / no-op archive |
| Same-kind каналы не коллайдится: ChannelProfile.id + группировка с исключением ambiguity | static-2: явные каналы с id привязываются к своим записям; id-less дубли fail-closed исключаются | Одиночный id-less канал и legacy single-adapter сохранены |
| Telegram inbound auth до любых side effects + offset advance на reject | SEC-1: unauthorized update не пишет файлы, не будит CTO, не зацикливается | Legacy config (token+chatId) без allowlist работает как раньше |
| SEC-001: слой-1 regex `SAFE_ESC_ID` на callback + слой-2 `SAFE_RUN_ID` + containment в `writeAnswer` | Fail-closed против path traversal; тесты T10-T12 падают на оригинальном коде | Reject сдвигает offset (не re-delivery loop); poison-строка в tg-map вызывает throw (MED-1: head-of-line stall, только локальный FS-атакующий) |
| SEC-002: `failedChannelRef()` → только `tg:<method>:failed` / `tg:<method>:http-<status>` | Токен бота никогда не попадает в `channelRef` при fetch-ошибках | Теряется диагностическая деталь ошибки (заменена типизированным маркером) |
| Quarantine: dedup только по `admitted`, wake-failure rollback до удаления файла | Retry-семантика транспорта без потери волн | Узкое окно потери при двойном fs-failure (документировано, cto-safety LOW) |
| Slice-gate fail-closed только при active wave | static-3: standby/no-wave/non-CTO корни сохраняют allow-path | Уточнена формулировка DoD architecture-7 |

## 4. Files / areas changed (grouped)

Группировка по зонам (полный per-file список — в git status и review-артефактах;
ниже не вымышленный исчерпывающий список, а зоны изменений):

- **packages/core** — `src/cto/channels.ts` (new: resolveChannelProfile,
  normalizeChannelConfig, renderChannelSection), `src/cto/slice-gate.ts` (new:
  ctoSliceTaskGate, ctoNestingGuard, assertCtoSliceDispatchable),
  `src/cto/redaction.ts` (детерминированная редкация, SEC-3 inline JWT/Bearer +
  option-поля), `src/cto/state.ts` (wave_history, migrateCtoState,
  inbox_quarantine), `src/cto/types.ts` (ChannelProfile, EscalationInboundMessage),
  `src/gates/outbox.ts` (hasBidirectionalChannel→resolveChannelProfile делегация),
  `src/index.ts` (секционные экспорты cto-core/cto-safety/cto-operations),
  `src/commands/cto.ts` (канал-секция, standby, runId-валидация).
- **packages/fullstack** — `src/adapters/telegram.ts` (SEC-1 auth, SEC-001
  traversal guards, SEC-002 failedChannelRef, offset semantics),
  `src/adapters/registry.ts` (static-1 RO-доставка, static-2 channel-set entryFor,
  SEC-2 rejected-quarantine, runId-валидация, pollInbox),
  `src/adapters/mock.ts` (persisted fake-RW, rejected/, dir-валидация SEC-5,
  MockEscalationAdapter), `src/messenger-channel.ts`, `src/index.ts`,
  `agents/cto.md`, `agents/team-lead.md`.
- **packages/e2e** — `test/cto-process-e2e.test.ts` (new, process-level harness),
  `test/cto-inbox-mock.test.ts` (new, sibling harness),
  `test/fixtures/{cto-process-dispatcher.ts,slice-worker.ts}` (new).
- **Тесты** — новые: `core/test/{channels,cto-slice-gate,cto-resident}.test.ts`,
  `fullstack/test/{channel-policy,fake-rw,telegram-auth}.test.ts`; расширены:
  `redaction.test.ts`, `outbox-gate.test.ts`, `adapters.test.ts` (5 telegram
  fixtures repaired с provenance), `cto-command.test.ts` и др.
- **Артефакты** — `.work-state/artifacts/*.json` (см. §6), report
  `vibe-report/cto-process-e2e-resident-qa-2026-08-09.md`, этот отчёт.

Не изменялись (scope-контракты слайсов): dispatch/outbox logic в registry
(кроме согласованных хунков), telegram-bridge/messenger-channel/http-core
(кроме разрешённого), offset-персистентность (SEC-6 defer).

## 5. Verification

### 5.1 Runtime manual QA (process-level E2E)

```bash
cd packages/e2e
node --test --import tsx test/cto-process-e2e.test.ts --test-timeout=180000 --test-reporter=spec
```

- Результат: **1 pass / 0 fail / 0 skip** (5362 ms test / 10476 ms wall);
  4 последовательных запуска в сессии — все зелёные (5361/5362/5364/5401 ms).
- Фазы: **7 (A..G) + TEARDOWN**, 56 `assert.*` вызовов + 17 `waitFor(...)` шагов.
- Sibling harness: `cto-inbox-mock.test.ts` **1 pass / 0 fail** (2418 ms) —
  resident CTO принимает inbox-задачи во время wave 1 и стартует wave 2.
- Доказано с диска: durable inbox admission (PHASE A), параллельные worktrees
  slice-a/slice-b (PHASE B), RO-only summary на audit-канале (PHASE C), restart
  recovery без re-admission (PHASE D), duplicate-id dedupe (PHASE E), follow-up
  wave в том же runId + reuse worktrees (PHASE F), nested-CTO block + marker-gate
  (PHASE G), чистый teardown без orphan-процессов.
- Evidence: `.work-state/artifacts/manual_qa.json` (verdict PASS, 11 evidence
  bullets, 12 dod_additions), `cto-process-e2e-runtime-2026-08-09/cto-process-e2e-test-output.log`,
  `vibe-report/cto-process-e2e-resident-qa-2026-08-09.md`.

### 5.2 Regression QA (focused)

Focused per-file `node:test` (tsx) + `tsc --noEmit` по 3 пакетам; проект-wide
suite не запускался (scope-ограничение). Per-file разбивка
(`.work-state/artifacts/qa_tests.json commands_and_counts`) — 21 файл:

- core: channels 13/13, cto-slice-gate 21/21, cto-resident 10/10, redaction 15/15,
  cto-amend 8/8, cto-command 11/11, outbox-gate 9/9 (7+2 added), cto-engine 91/91,
  cto 8/8, cto-ownership 6/6, cto-classification 9/9 → **201**
- fullstack: adapters 41/41, cto-command 14/14, channel-policy 24/24 (23+1 added),
  fake-rw 11/11, telegram-auth 15/15, messenger-channel 2/2,
  dispatcher-lifecycle 3/3, telegram-bridge 7/7 → **117**
- e2e: cto-process-e2e 1/1, cto-inbox-mock 1/1 → **2**

**Итого: 320 tests / 21 files / 0 failures / 0 typecheck errors**
(реконсилировано 2026-08-09: все 21 файла пере-запущены индивидуально через
`node --test --import tsx test/<file>`; каждое per-file число совпадает 1-в-1 с
разбивкой в qa_tests.json. Ранее ошибочная строка `totals: 207` в qa_tests.json не
соответствовала ни одному подмножеству из 21 файла — исправлена на `320` в
qa_tests.json и summary.json; единый авторитетный итог — 320 зелёных тестов.)

- Boundary-тесты добавлены: `outbox-gate.test.ts` **+2** (explicit validated RW
  primary блокирует `ask` на core gate; declared-rw http деградирует до ro),
  `channel-policy.test.ts` **+1** (симметричный пин на fullstack ask-gate).
- Typecheck: core clean; fullstack `tsc --noEmit && tsc -p tsconfig.commands.json`
  clean; e2e clean.
- Verdict артефакта: **APPROVED**.

### 5.3 Reviews

- Initial (StaticCtoCodeReview + CtoSecurityReview): `needs_changes` —
  SEC-1 HIGH + 6 MEDIUM/LOW (см. review.json).
- Post-fix: **PostFixCodeReview PASS** (все 7 fix-action находок правильно
  реализованы, регрессий нет); **PostFixSecurityReview Conditional PASS** —
  выявил SEC-001 (CRITICAL path traversal) + SEC-002 (MEDIUM token leak).
- Telegram hardening: **FinalTelegramCodeReview PASS** (SEC-001/SEC-002 VERIFIED
  FIXED, no CRITICAL/HIGH; MED-1/2 + LOW-1..5 non-blocking);
  **FinalTelegramSecurity PASS / GREEN_LOW** (no CRITICAL/HIGH/MEDIUM blockers;
  единственный MEDIUM — dead-code containment check, не уязвимость).
- Финальный вердикт review.json: **approved_with_non_blocking_findings**.

## 6. Residual risks & explicit deferrals

**Нет CRITICAL/HIGH-остатков.** Остаточные MEDIUM/LOW — только документированные,
non-blocking:

- **MED-1** — head-of-line offset stall при poisoned tg-map.jsonl (достижим только
  локальным FS-атакующим; рекомендация: различать permanent rejection vs transient
  I/O). Follow-up.
- **MED-2** — тест 11 не покрывает второй pollOnce / offset-stall следствие. Follow-up.
- **SEC-003..SEC-010** (MEDIUM/LOW) — post-fix security review наблюдения:
  raw error.message в drainOutbox, unbounded tg-map.jsonl, runId-валидация как
  defense-in-depth, consumer-factory path-валидация, messageId type-guard,
  JSON-массивы секретов, per-process seenAnswers, markdownCtoState (informational).
- **LOW-1..LOW-5** — FinalTelegramCodeReview: dead-code containment check,
  cross-run answer injection (auth-bounded), silent drop observability, http.ts
  channelRef, send/sendPlainText неразличимость.
- **cto-safety LOW (3)** — тип `EscalationInboundMessage` без `by?`,
  truncation marker cosmetic, quarantine rollback best-effort.
- **Процессные**: core dist-coupling (свежий dist сегодня, но после правок src
  нужен build), stale source-import в redaction.test.ts, process-E2E timing margin.

**Deferred (review.json + summary.json)**: SEC-4 (lease TOCTOU), SEC-6 (telegram
offset restart-idempotency), RISK-1 (symlink hardening), RISK-2 (marker collision
DoS) — с обоснованиями, не стираются.

## 7. Next steps

1. Follow-up issues: MED-1/2, SEC-003..SEC-010, LOW-1..5, cto-safety LOWs —
   ни один не блокирует фичу.
2. `npm audit` в CI перед релизом (зависимости в PR не менялись).
3. Red-team против live Telegram inbound теперь не заблокирован (SEC-001/SEC-002
   закрыты и покрыты регрессией).
4. Обычный релизный процесс (release-preflight/release-process) после merge.
5. Косметика: убрать stale source-import comment в redaction.test.ts, почистить
   dead-code containment check при удобном случае.

---

## Артефакты (evidence)

- `.work-state/artifacts/summary.json` (schema `summary`, status `completed`,
  generated_at 2026-08-09T12:50:00Z) — машинный сводный артефакт
- `.work-state/artifacts/review.json` (verdict `approved_with_non_blocking_findings`,
  original findings + remediation status/evidence, deferred сохранены)
- `.work-state/artifacts/dod.json`, `manual_qa.json`, `qa_tests.json`,
  `cto-e2e/evidence.json`, `telegram-security/dod.json`,
  `telegram-security-hardening/dod.json`, `channel-delivery/dod.json`,
  `cto-safety/review.json`, `cto-process-e2e-runtime-2026-08-09/cto-process-e2e-test-output.log`
- `.work-state/team-state.json` (status `completed`, stages completed, final_summary)
- `vibe-report/cto-process-e2e-resident-qa-2026-08-09.md` — детальный QA-отчёт

**Verdict: PASS — feature complete, evidence-backed, approved with non-blocking findings.**
