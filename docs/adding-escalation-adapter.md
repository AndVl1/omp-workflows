# Adding your own escalation channel (custom EscalationAdapter)

Как подключить собственный канал связи для CTO sub-orchestration —
Telegram-подобный бот, Slack/ntfy-вебхук, корпоративный push, свой мессенджер.
Движок коммуникации живёт в `@andvl1/omp-workflows-core`; интерфейс —
единственное, что обязан реализовать потребитель. Механика проверена на
`@andvl1/omp-workflows-fullstack` (HTTP + Telegram адаптеры) и omp 17.2.6.

---

## 1. Где что живёт

| Слой | Что | Файлы |
|---|---|---|
| **core** (движок, интерфейсы) | `EscalationAdapter`, `Escalation`, `EscalationReceipt`, `EscalationAnswer`, `validateEscalation`, `sanitizeEscalation` (R4), файловые хелперы `answersDir`/`readAnswers`/`ensureAnswersDir`, состояние `setEscalation`/`expireEscalations`/`pendingEscalations` | `packages/core/src/cto/{types,escalation}.ts` — экспортировано из `@andvl1/omp-workflows-core` |
| **fullstack** (референсы) | HTTP-адаптер (send-only), Telegram-адаптер (send + приём ответов), outbox-диспетчер, конфиг `.omp/escalation.json`, подключение в `session_start` | `packages/fullstack/src/adapters/{http,telegram,registry}.ts` |

Потребитель реализует **только** интерфейс из core; диспетчер, санитизация и
файловая очередь ответов уже написаны.

## 2. Контракт и жизненный цикл эскалации

```
агент (CTO/лид) ── пишет .work-state/cto/<runId>/outbox/<escId>.json ──► dispatcher
dispatcher ── sanitizeEscalation (R4) ──► adapter.send(esc) ──► канал (Telegram/HTTP/…)
канал/пользователь ──► .work-state/cto/<runId>/answers/<escId>.json ──► агент (на чекпоинте)
```

```ts
// Интерфейс — единственное, что реализует потребитель (core):
interface EscalationAdapter {
  readonly kind: string;                                   // "telegram" | "http" | "my-channel"
  send(esc: Escalation): Promise<EscalationReceipt>;       // { sent: boolean; channelRef?: string }
  cancel(id: string): Promise<void>;                       // отозвать устаревший вопрос (best-effort)
}
```

`Escalation` (что приходит в `send`): `id` (корреляционный:
`<runId>/<team>/<checkpoint>/<attempt>`), `level` (`question|decision|needs_human|blocker`),
`title`, `body` (уже санитизировано движком), `options[]`, `default`, `timeoutMs`, `replyTo`.

**Ответы НЕ возвращаются через adapter** — потребитель кладёт файл
`.work-state/cto/<runId>/answers/<escId>.json` формы
`{ id, answer, at, by }` (хелперы `ensureAnswersDir`/`readAnswers` в core).
Файлы переживают рестарты; агент подхватывает ответ на следующем чекпоинте.

## 3. Конфиг `.omp/escalation.json`

```json
{
  "adapter": "http",
  "http":     { "url": "https://ntfy.sh/my-topic", "headers": {} },
  "telegram": { "token": "...", "chatId": "...", "pollIntervalMs": 5000 }
}
```

`session_start`-хук fullstack читает конфиг, строит адаптер через
`createEscalationAdapter` и запускает `startDispatcher` (drain outbox'а каждые
10с + немедленный drain при старте — pending-эскалации переживают рестарт, R7).

## 4. Шаги для своего канала

1. **Реализуй интерфейс** (мин. `send` + `cancel`; `send` не должен бросать —
   возвращай `{ sent: false }` на ошибке, диспетчер сделает retry с backoff до 3):

```ts
import type { Escalation, EscalationAdapter, EscalationReceipt } from "@andvl1/omp-workflows-core";

export class MyChannelAdapter implements EscalationAdapter {
  readonly kind = "my-channel";
  constructor(private readonly webhookUrl: string) {}
  async send(esc: Escalation): Promise<EscalationReceipt> {
    try {
      const res = await fetch(this.webhookUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(esc),
      });
      return { sent: res.ok, channelRef: `http:${res.status}` };
    } catch (e) {
      return { sent: false, channelRef: e instanceof Error ? e.message : String(e) };
    }
  }
  async cancel(_id: string): Promise<void> { /* best-effort */ }
}
```

2. **Приём ответов** (если канал двусторонний): колбэк/вебхук канала пишет
   ответ файлом через core-хелперы:

```ts
import { ensureAnswersDir, writeFileSync, join } from "…";
// в колбэке канала:
const dir = ensureAnswersDir(runId, cwd);              // .work-state/cto/<runId>/answers/
writeFileSync(join(dir, `${escId.replace(/[^\w-]/g, "-")}.json`),
  JSON.stringify({ id: escId, answer, at: new Date().toISOString(), by: "my-channel" }));
```

3. **Зарегистрируй адаптер**: либо расширь `createEscalationAdapter`/конфиг в
   своём extension, либо зови `startDispatcher(cwd, adapter)` сам из
   `session_start`. Пример полного двустороннего канала (send + long-polling →
   answers) — `packages/fullstack/src/adapters/telegram.ts`; односторонний —
   `http.ts`.

4. **Тест** (по образцу `packages/fullstack/test/adapters.test.ts`): DI
   `fetchImpl`, мок-канал, проверка retry/backoff диспетчера и записи ответов.

## 5. Правила и ограничения

- **R4-санитизация** — в движке (`sanitizeEscalation` до `send`): секретные
  строки (`token|password|secret|api key|bearer…`) вырезаются из `body`/`title`.
  Канал не должен добавлять контент поверх.
- **Ответы — только файлами**, не через adapter API (устойчивость к рестартам).
- **Не блокируй**: `blocker` ждёт без таймаута, но команда паркуется
  (`background_wait`), остальные работают. Канал — fire-and-forget + файлы.
- Контракт глубины: эскалацию инициирует главный агент (CTO) или лид —
  воркеры эскалаций не шлют.

## 6. Двусторонний канал: входящий контракт (работает как telegram)

Чтобы кастомный мессенджер вёл себя **так же** (мост/диспетчер слушают,
задачи/ответы будят CTO), адаптер должен реализовать опциональный входящий
контракт (`EscalationAdapter` в `@andvl1/omp-workflows-core`):

```ts
pollOnce?(): Promise<EscalationAnswer[]>;                     // 1 раунд приёма: пишет answers/, возвращает новые
setPlainMessageHandler?(h: (m: { id; text; at }) => void): void;  // обычные сообщения -> задачи CTO
sendPlainText?(target: string, text: string): Promise<{ sent: boolean }>;  // ответ юзеру без reply-разметки
```

Встроенные `startDispatcher`/`pollInbox` и standalone-мост duck-type'ят эти
методы — новый транспорт подхватывается автоматически. Конфиг:

```json
{ "adapter": "slack", "bidirectional": true, "slack": { "token": "…" } }
```

- `bidirectional: true` (или `adapter: "telegram"`) включает messenger-режим:
  `/cto`-промпт рендерит «BIDIRECTIONAL», `ask`-гейт блокирует `ask` при
  активном ране, все вопросы идут через outbox → answers.
- Реестр: `registerEscalationAdapter("slack", (config, cwd) => adapter)` —
  фабрика, как у встроенных http/telegram; `createEscalationAdapter` и мост
  используют её.
- Мост (standalone, вне omp-сессии): `bin/tg-bridge.mjs` работает с любым
  зарегистрированным транспортом (отправка через `adapter.sendPlainText`;
  без него мост логирует «transport has no sendPlainText»). Lock-файл
  `.omp/bridge.lock` — один потребитель канала: пока мост жив, сессия не
  поллит сама, только читает его файлы из `.omp/inbox/`.
- Полный двусторонний референс — `telegram.ts` (send + getUpdates + mapping +
  plain → inbox); push-only референс — `http.ts`.
