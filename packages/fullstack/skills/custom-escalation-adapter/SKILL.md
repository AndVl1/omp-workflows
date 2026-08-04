---
name: custom-escalation-adapter
description: Add your own escalation channel for CTO sub-orchestration — implement the EscalationAdapter interface (core), wire it per-project via .omp/escalation.json + outbox dispatcher, ingest answers as files. Use when the user wants to connect Telegram/Slack/ntfy/custom push to CTO escalations, asks "escalation adapter", "communication channel for CTO", "куда слать эскалации", or needs to build a consumer-side channel. Full guide: docs/adding-escalation-adapter.md.
---

# Custom Escalation Adapter — канал связи для CTO эскалаций

Движок коммуникации живёт в `@andvl1/omp-workflows-core` (интерфейс + хелперы);
**реализация канала — per-project**: каждый потребитель пишет свой адаптер под
свой мессенджер/пуш и регистрирует его через `.omp/escalation.json`.
Fullstack поставляет только референсы (HTTP send-only, Telegram send+long-polling).
Полный гайд с примерами кода: `docs/adding-escalation-adapter.md`.

## 1. Жизненный цикл (что уже написано, не пиши заново)

```
агент (CTO/лид) ── .work-state/cto/<runId>/outbox/<escId>.json ──► dispatcher
dispatcher ── sanitizeEscalation (R4) ──► adapter.send(esc) ──► канал
канал/пользователь ──► .work-state/cto/<runId>/answers/<escId>.json ──► агент (чекпоинт)
```

- **Outbox-диспетчер, санитизация, retry/backoff (3), файловая очередь ответов —
  уже в fullstack** (`src/adapters/registry.ts`, `session_start`-хук). Не дублируй.
- Потребитель реализует ТОЛЬКО интерфейс из core:

```ts
import type { Escalation, EscalationAdapter, EscalationReceipt } from "@andvl1/omp-workflows-core";

export class MyChannelAdapter implements EscalationAdapter {
  readonly kind = "my-channel";
  constructor(private readonly webhookUrl: string) {}
  async send(esc: Escalation): Promise<EscalationReceipt> {
    try {
      const res = await fetch(this.webhookUrl, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify(esc),            // уже санитизировано движком (R4)
      });
      return { sent: res.ok, channelRef: `http:${res.status}` };
    } catch (e) {
      return { sent: false, channelRef: e instanceof Error ? e.message : String(e) };
    }
  }
  async cancel(_id: string): Promise<void> { /* best-effort */ }
}
```

## 2. Ответы — только файлами

Ответы НЕ возвращаются через adapter. Колбэк/вебхук канала пишет файл
`.work-state/cto/<runId>/answers/<escId>.json`:

```ts
import { ensureAnswersDir } from "@andvl1/omp-workflows-core";
import { writeFileSync, join } from "node:fs";

const dir = ensureAnswersDir(runId, cwd);   // .work-state/cto/<runId>/answers/
writeFileSync(join(dir, `${escId.replace(/[^\w-]/g, "-")}.json`),
  JSON.stringify({ id: escId, answer, at: new Date().toISOString(), by: "my-channel" }));
```

Файлы переживают рестарты; агент подхватывает ответ на следующем чекпоинте.

## 3. Регистрация (per-project)

```json
// <project>/.omp/escalation.json
{ "adapter": "http", "http": { "url": "https://ntfy.sh/my-topic", "headers": {} } }
// или: { "adapter": "telegram", "telegram": { "token": "...", "chatId": "...", "pollIntervalMs": 5000 } }
```

`session_start` читает конфиг → `createEscalationAdapter` → `startDispatcher`
(drain outbox каждые 10с + немедленный drain при старте — pending-эскалации
переживают рестарт). Свой канал: зарегистрируй адаптер в своём extension
(расширь `createEscalationAdapter` или зови `startDispatcher` сам).

## 4. Референсы и тесты

- Двусторонний канал (send + long-polling → answers + map msgId→escId):
  `packages/fullstack/src/adapters/telegram.ts`.
- Односторонний: `packages/fullstack/src/adapters/http.ts`.
- Тесты (DI `fetchImpl`, retry/backoff, ответы): `packages/fullstack/test/adapters.test.ts`.

## 5. Правила

- R4-санитизация в движке: секретные строки вырезаются до `send`; канал контент не добавляет.
- `send` не бросает: `{ sent: false }` → диспетчер retry с backoff (до 3).
- `blocker` ждёт без таймаута, команда паркуется (`background_wait`), остальные работают.
- Эскалации шлют CTO/лид, не воркеры (контракт глубины main(CTO) → лид → воркер).
