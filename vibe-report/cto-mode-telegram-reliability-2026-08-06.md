# CTO mode и Telegram reliability — 2026-08-06

## Результат

Резидентный CTO теперь явно является единственным CTO главной интерактивной сессии. Nested CTO запрещён и в prompt-контракте, и механическим `tool_call` guard. Standby-run работает как постоянный продуктовый ассистент: существующий standby переиспользуется, входящие задачи складываются в его inbox, после каждой wave CTO остаётся online и возвращается в standby.

Telegram delivery защищён от конкурирующих pollers и перекрывающихся ticks. Offset подтверждается только после успешной обработки update; ошибки persistence/wake оставляют update для retry.

## Изменения

- `packages/core/src/gates/cto-nesting.ts`
  - Добавлен `ctoNestingGuard` для `task(agent: "cto" | "@cto")`, включая элементы batch.
  - Возвращается явная причина: `/cto` запускается только в main session.
- `packages/core/src/index.ts`
  - Guard подключён перед safety guard в `registerTeamWorkflow`.
  - Восстановлен импорт `safetyGuard`, обнаруженный typecheck-ом после подключения нового hook.
- `packages/core/src/commands/cto.ts`
- `packages/fullstack/commands/cto/_lib/cto.ts`
- `.omp/commands/cto/_lib/cto.ts`
- `packages/fullstack/commands/cto/index.ts`
  - `/cto` описан как main-session-only resident CTO.
  - Standby prompt требует сначала принять существующий active standby-run или создать новый, затем прочитать inbox до yield.
  - `[CTO-INBOX]` явно определён как пользовательская команда main-session CTO; новые задачи идут amend/wave, а не в новый CTO.
  - После wave закрывается только текущая wave; resident run остаётся активным.
- `packages/fullstack/agents/cto.md`
  - Роль помечена как reference/main-session-only, `spawns: []`, nested dispatch запрещён.
- `packages/fullstack/agents/team-lead.md`
  - Lead явно не может spawn/impersonate CTO.
- `packages/fullstack/src/index.ts`
  - Telegram dispatcher запускается только для interactive main session (`hasUI !== false`); task subagents не создают собственных `getUpdates` consumers.
  - Dispatcher на повторном `session_start` для cwd сначала останавливает предыдущий экземпляр.
- `packages/fullstack/src/adapters/registry.ts`
  - Dispatcher ticks сериализованы.
  - `ensureStandbyRun` переиспользует существующий active run и создаёт его inbox.
  - `handleInboxTask` пишет durable `wx`-файл до wake; failed wake откатывает файл и пробрасывает ошибку для retry.
  - Answer dedupe scoped per cwd.
- `packages/fullstack/src/adapters/telegram.ts`
  - Один in-flight `getUpdates` на adapter.
  - Self-scheduling poll loop без overlapping `setInterval` rounds.
  - Offset сдвигается только после успешной обработки update.
- `packages/fullstack/bin/tg-bridge.mjs`
  - Standalone bridge использует serial polling.
  - Message id добавляется в dedupe set только после успешной классификации и persistence; ошибка handler пробрасывается в adapter.
- `packages/fullstack/src/telegram-bridge.ts`
  - Ошибка записи отличена от duplicate `wx`-файла; persistence failure больше не маскируется как уже доставленное сообщение.

## Поведенческие тесты

Добавлены/расширены проверки:

- `packages/core/test/cto-nesting.test.ts` — прямой target, batch и разрешённые обычные tools.
- `packages/core/test/cto-command.test.ts` — resident CTO, standby reuse contract и `[CTO-INBOX]` semantics.
- `packages/fullstack/test/adapters.test.ts` — concurrent poll sharing, offset retry, failed wake retry, serialized dispatcher ticks, per-root answer dedupe и standby reuse.
- `packages/fullstack/test/dispatcher-lifecycle.test.ts` — main-only dispatcher boundary.
- `packages/fullstack/test/telegram-bridge.test.ts` — persistence error не считается duplicate delivery.
- `packages/e2e/test/cto-inbox-mock.test.ts` — реальный node-pty + WS text surface, fake `omp`, mock Telegram adapter: две inbox-задачи приходят во время wave 1 и обе входят в wave 2.
- Обновлены CTO prompt/reminder assertions.

## Проверка

Успешно:

- `npm run build` — все workspace пакеты.
- `npm run typecheck` — core, e2e и fullstack, включая command TS config.
- `npm run test -w @andvl1/omp-workflows-core` — **101/101**.
- `npm run test -w @andvl1/omp-workflows-fullstack` — **143/143**.
- `npm run test -w @andvl1/omp-workflows-e2e` — **73/73**.
- `node --test --import tsx test/cto-inbox-mock.test.ts` — **4 последовательных запуска, 4/4 PASS**.
- `npx tsc --noEmit ... test/cto-inbox-mock.test.ts` — OK.
- `node --check packages/fullstack/bin/tg-bridge.mjs` — OK.

Mock E2E подтверждает полный сценарий без LLM и Telegram network: active resident wave 1 → два inbound task → durable files в том же `run-active/inbox` → оба `[CTO-INBOX]` wake на PTY/WS → wave 2 с обоими task IDs. Максимум concurrent mock polls: 1.

Тесты печатают ожидаемые `fatal: not a git repository` строки из `parseEnvelope` при намеренной проверке временных каталогов вне git worktree; assertions проходят.

## Остаточные ограничения

- `dispatcherStopsByCwd` защищает от повторного dispatcher в одном OMP process. Два независимых OMP процесса с одним cwd/token всё ещё требуют внешнего bridge lock/единственного владельца.
- Standby creation имеет короткое cross-process TOCTOU окно; обычный `wx` task file остаётся idempotent, но полноценная межпроцессная блокировка не добавлялась.
- Bridge lock scoped по cwd; один Telegram bot token, используемый несколькими независимыми проектами одновременно, требует отдельной координации.
