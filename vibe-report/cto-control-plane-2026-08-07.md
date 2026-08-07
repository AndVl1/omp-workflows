# CTO Durable Control-Plane — итоговый отчёт (epic br-zps)

- Epic: `br-zps` «CTO mode: durable control plane»
- Run: `cto-control-plane-20260806-232053-1`
- Branch: `feat/br-zps-cto-control-plane`
- Дата: 2026-08-07
- Репозиторий: plugin-source monorepo (TypeScript): `packages/core`, `packages/fullstack`, `packages/e2e`

## 1. Объём

Эпик развивает CTO mode из одноразового orchestration-run в безопасный, durable и cost-aware control plane. В scope — 11 дочерних тикетов (`br-zps.1`…`br-zps.11`), реализованных четырьмя командами по одному контракту (`.work-state/cto/cto-control-plane-20260806-232053-1/architecture.md`, §§1–11): state canonicalization, budget caps, team leases/watchdog, inbox quarantine и prompt-injection границы, enforced escalation outbox, deterministic redaction, run observability, scheduler/digest, five-whys refinement, conditional dissent gate, project decision memory. Вне scope (по описанию эпика): Claw-подобный UI/ассистент, voice, WASM/standalone runtime, generic Jira replacement, cross-instance память, безусловная автономная генерация production SaaS.

## 2. Архитектура и реализованные фичи

Все подсистемы — чистые TS-модули над файловым `CtoState` (JSON на диске), зеркалящие существующий паттерн `state.ts`/`escalation.ts`; двухслойный контракт (TS-движок + LLM-агент, пишущий файлы). Mock-провайдеры — in-process реализации интерфейса `EscalationAdapter` (D4: без сети и credentials).

| Тикет | Команда | Модуль | Суть |
|---|---|---|---|
| br-zps.1 | cto-core | `packages/core/src/cto/state.ts`, `types.ts` | `state.json` каноничен; `migrateCtoState`/`canonicalizeState` (schema 1→2, additive, идемпотентно); 14 shared schema-2 интерфейсов в одном проходе |
| br-zps.2 | cto-operations | `packages/core/src/cto/budget.ts` | `defaultBudgetState`/`checkBudget`/`recordSpend`/`setBudgetPolicy`; D3 — все лимиты `null` (unlimited) по умолчанию; `CHAR_HEURISTIC_RECORDER` (chars/4, C1 — реальные токены OMP не отдаёт) |
| br-zps.3 | cto-core | `packages/core/src/cto/leases.ts` | `acquireLease`/`heartbeatLease`/`releaseLease`/`isLeaseAlive`/`reclaimDeadLeases`; fencing-токены, restart-safe (TTL + PID liveness), зеркалит dispatcher lease паттерн |
| br-zps.4 | cto-safety | `packages/fullstack/src/adapters/registry.ts` | Quarantine в `handleInboxTask`: SHA-256 dedup (admitted-хэши), `rejected` при пустом/oversized (>4000), lifecycle `quarantined`→`admitted`, wake-failure откат; inbox-текст — данные, никогда не eval/exec |
| br-zps.5 | cto-safety | `packages/core/src/gates/outbox.ts` | `outboxEnforcementGate` блокирует `ask`, когда `.omp/escalation.json` объявляет bidirectional-канал; зарегистрирован в `registerTeamWorkflow` (tool_call) |
| br-zps.6 | cto-safety | `packages/core/src/cto/redaction.ts`, `packages/fullstack/src/adapters/mock.ts` | Детерминированный `redactEscalation` (line-drop → inline-replace → truncate → marker; без LLM/рандома); `sanitizeEscalation` = делегат; `MockEscalationAdapter` (kind `mock`, D4, fetchImpl запрещён) |
| br-zps.7 | cto-operations | `packages/core/src/cto/health.ts`, `observability/events.ts` | `assessRunHealth`/`healthToMarkdown` — health чисто из `CtoState`; additive `estimatedTokens`/`estimatedDollars`/`ctoRunHealth` на `ObservabilityRollup` |
| br-zps.8 | cto-operations | `packages/core/src/cto/scheduler.ts`, `packages/fullstack/src/cto-scheduler-daemon.ts` | `shouldRunWave`/`buildDigest`/`startWaveScheduler` (setInterval, C2 — OMP не имеет cron API); daemon entry как stub, тест-драйвовый |
| br-zps.9 | cto-quality | `packages/core/src/cto/refinement.ts` | `refineTask`/`validateRefinement` — pure seed/структуризатор + accept/reject матрица (five-whys рассуждение — за LLM-промптом, §4.10) |
| br-zps.10 | cto-quality | `packages/core/src/cto/dissent.ts`, `gates.ts` | `evaluateDissent` + additive `dissentGate`: срабатывает ТОЛЬКО на high-stakes/irreversible/contradicts_decision/budget_exceeded; low-stakes reversible проходит без налога |
| br-zps.11 | cto-core | `packages/core/src/cto/decisions.ts` | `recordDecision`/`recallDecisions`/`decisionsToMarkdown`; D6 — project-scoped, exact/tag recall, `why` обязателен |

Ключевые инварианты (architecture.md): C4 — `case "team"` НЕ добавлен в `runStage` (dispatch остаётся prompt/agent-driven, §4); C1/C2/C3 — деградация при недоступности OMP API (нет токенов/cron/task-surface) — budget декларативен, scheduler сессионный, логика доступна и как TS API, и как файловый контракт.

## 3. Изменённые области

Per integration review (`integration/review.json` `changes`): **tracked diff +1909/−24 по 12 файлам, 14 новых файлов**; working tree: staged 0, unstaged 12, untracked 14 (не закоммичено).

- Изменённые tracked: `packages/core/src/cto/types.ts`, `state.ts`, `escalation.ts`, `gates.ts`, `packages/core/src/index.ts`, `observability/events.ts`, `commands/cto.ts`, `test/cto-engine.test.ts`, `packages/fullstack/src/adapters/registry.ts`, `packages/fullstack/src/index.ts`, `test/adapters.test.ts`, `.beads/issues.jsonl`.
- Новые untracked: `cto/budget.ts`, `cto/decisions.ts`, `cto/leases.ts`, `cto/redaction.ts`, `cto/health.ts`, `cto/scheduler.ts`, `cto/refinement.ts`, `cto/dissent.ts`, `gates/outbox.ts`, `test/outbox-gate.test.ts`, `test/redaction.test.ts`, `fullstack/src/adapters/mock.ts`, `fullstack/src/cto-scheduler-daemon.ts`, `test/cto-scheduler-daemon.test.ts`.

Итоговая финализация НЕ редактировала source, тесты и артефакты; коммит/пуш не выполнялись.

## 4. Верификация: команды и результаты

Focused-валидация (никаких project-wide прогонов, форматтеров и линтеров — глобальное ограничение рана):

| Команда | Результат |
|---|---|
| `cd packages/core && npx tsc --noEmit` | exit 0 (`fixes.json` CORE_TSC_OK) |
| `cd packages/fullstack && npx tsc --noEmit` | exit 0 (`fixes.json` FULLSTACK_TSC_OK) |
| `cd packages/core && node --test --import tsx test/cto-engine.test.ts` | 89 pass / 0 fail (rev-2 re-run; migration, leases, decisions, budget, health, scheduler, refinement, dissent) |
| `cd packages/core && node --test --import tsx test/redaction.test.ts test/outbox-gate.test.ts` | 15 pass / 0 fail (rev-2) |
| `cd packages/fullstack && node --test --import tsx test/adapters.test.ts test/cto-scheduler-daemon.test.ts` | 38 pass / 0 fail, duration 2272.85ms (финальная валидация; mock round-trip, quarantine, scheduler) |
| **Итого focused** | **142 pass / 0 fail** (89+15+38; rev-1 «152» — пересчёт ошибки, исправлено в rev-2) |

Web (локальный mock fallback, `e2e-validation.json`): `playwright-cli` сессия `cto-control-plane-2026-08-07` на loopback `packages/e2e` surface (omp 17.2.10, реальный CR submit): xterm buffer (`window.__uxTerm.buffer.active.getLine(i).translateToString(true)`) отрисовал полный CTO control-plane prompt (строки 51–76) и переход в `⠧ Working… ⟦esc⟧` (строка 79) — `/cto` custom-TS команда загрузилась и вошла в LLM-turn. Скриншот: `.work-state/artifacts/integration/evidence/cto-local-mock-surface.png` (162034 bytes, 2026-08-07 09:57). Harness очищен (scratch удалён, браузер-сессия закрыта, PTY 60305 убит).

Артефакты-источники: `.work-state/artifacts/integration/review.json`, `fixes.json`, `e2e-validation.json`; командные отчёты и DoD — `.work-state/cto/cto-control-plane-20260806-232053-1/teams/{cto-core,cto-safety,cto-operations,cto-quality}/{report.md,dod.json}`.

## 5. Вердикт интеграционного ревью

`integration/review.json`: **revision 2 — APPROVED**. Три обязательных фикса rev-1 применены и перепроверены на диске + свежим focused-прогоном (142/0):

- **INT-1** (registry.ts:460) `ensureStandbyRun` пишет `schema: 2` — соответствует §3.1;
- **INT-2** (cto-engine.test.ts:778) удалён дублирующий `import { describe }` — остался ровно один `from "node:test"` (line 7);
- **INT-3** (cto.ts:138) standby-промпт говорит `(schema 2, …)`.

Все 8 integration gates — PASS (state schema valid, lease fenced, budget unlimited-default, redaction deterministic, outbox enforced, inbox quarantined, dissent conditional, integration DoD); constraint C4 (`case "team"`) — PASS (в `stage.ts` совпадений нет, файл вне diff). 6/6 архитектурных DoD-критериев (architecture-1…6) — PASS. Team reviews: cto-core/cto-operations/cto-quality APPROVE_WITH_COMMENTS, cto-safety APPROVE — все 0 CRITICAL/HIGH/MEDIUM, LOW перенесены в бэклог.

## 6. Локальная vs продакшн-валидация (честное разделение)

`e2e-validation.json` (status `BLOCKED_PRODUCTION_UNAVAILABLE_FALLBACK_OBSERVED`):

- **Backend: `PASS_FOCUSED_NO_PRODUCTION_SMOKE`** — focused-прогон fullstack adapters + scheduler 38/38 покрывает архитектурно требуемый mock round-trip, quarantine и scheduler gates. Живой production health-проб не существует.
- **Web: `PASS_LOCAL_FALLBACK_NON_PRODUCTION`** — пройден архитектурно требуемый локальный mock surface (`packages/e2e`, loopback) с реальным CR; явно помечен как НЕ заменяющий production-доказательство.

**Production blocker (зафиксирован, не «пройден»):** репозиторий — plugin-source monorepo без production target: нет deploy script (`glob **/*deploy*` → пусто), нет production URL (`grep PROD_URL` → пусто), нет health endpoint (`grep healthz|/health|createServer` в `packages/fullstack/src` → пусто; `index.ts` экспортирует плагин, без `server.listen()`), npm scripts — только build/typecheck/test/e2e, CI (`.github/workflows/ci.yml`, `release.yml`) без deploy job. Production-only Backend/Web проверки не помечены как выполненные — они недоступны без внешнего deployment target. Эпик поставляется как omp-плагин, а не hosted-сервис.

## 7. Отложенный LOW-бэклог (не merge-blocking, перенесён как есть)

Per `integration/review.json` `deferred_low`:

- **CORE-1** — `leases.ts` ~30: `isLeaseAlive` не гвардит `pid <= 0` (недостижимо через документированные call sites; defense-in-depth).
- **CORE-2** — `state.ts` ~88: `canonicalizeState` читает state.json дважды на migration path (косметика; идемпотентность подтверждена тестом).
- **OPS-1** — `budget.ts` ~93: `recordSpend` не накапливает per-team `ms` (поле сегодня никем не читается; расхождение буквы и духа TD3).
- **OPS-2** — `cto-scheduler-daemon.ts` ~1: docstring неточно описывает структуру telegram-bridge.ts (doc-only).

## 8. Закрытие тикетов

Все 12 scoped-тикетов закрыты `br close` (2026-08-07) с reason, называющим evidence и production-ограничение; затем `br sync --flush-only` (exit 0, «Nothing to export (no dirty issues)» — DB и JSONL уже консистентны, auto-flush сработал на каждом close). Список закрытых: **`br-zps`, `br-zps.1` … `br-zps.11`** (все 11 детей + родитель; другие тикеты не трогались). Итоговая проверка: `jq 'select(.id | startswith("br-zps")) | .status' .beads/issues.jsonl` → 12× `closed`; `br show br-zps` → `CLOSED`.
