---
name: custom-escalation-adapter
description: Add your own escalation channel for CTO sub-orchestration — implement the EscalationAdapter interface (core), wire it per-project via .omp/escalation.json + outbox dispatcher, ingest answers as files. Use when the user wants to connect Telegram/Slack/ntfy/custom push to CTO escalations, asks "escalation adapter", "communication channel for CTO", "куда слать эскалации", or needs to build a consumer-side channel. Full guide: docs/adding-escalation-adapter.md.
---

# Custom Escalation Adapter — канал связи для CTO эскалаций

Движок коммуникации живёт в `@andvl1/omp-workflows-core` (интерфейс + хелперы);
**реализация канала — per-project**: потребитель пишет адаптер, а
`.omp/escalation.json` выбирает встроенный или source-registered kind. Новый
kind регистрируется только maintainer-ом fullstack source (не public npm API).
Fullstack поставляет референсы (HTTP send-only, Telegram send+long-polling).

## 1. Жизненный цикл (что уже написано, не пиши заново)

```
агент (CTO/лид) ── .work-state/cto/<runId>/outbox/<escId>.json ──► dispatcher
dispatcher ── sanitizeEscalation (R4) ──► adapter.send(esc) ──► канал
двусторонний канал ── canonical answer после проверки exact run ──► .work-state/cto/<runId>/answers/*.json ──► агент (чекпоинт)
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

## 2. Ответы: send-only и inbound

### Send-only

HTTP/webhook/push implements only `send` and `cancel`. It has no inbound
polling or host wake-up; `send` does not return answers and the dispatcher
does not invent an inbound path. A second trusted component must write an
answer file if the transport accepts replies.

Current fullstack source can construct a consumer-registered send-only adapter
from this project-local config:

```json
{
  "adapter": "my-channel",
  "myChannel": { "webhookUrl": "https://example.invalid/cto" }
}
```

This is outbound-only as shipped. Registration makes the existing host-owned
dispatcher able to build the adapter and drain outbox records; it does not
enable custom inbound, ask redirection or automatic answer delivery.

### Source-maintainer-only registration

The installed fullstack package does not export its registry/dispatcher as a
public root API or private `dist` subpath. Only a maintainer editing
`packages/fullstack/src/index.ts` may add this registration. `MyChannelAdapter`
is the source-owned implementation at
`packages/fullstack/src/adapters/my-channel.ts` from the full guide (§2), or an
equivalent source-relative implementation:

```ts
// packages/fullstack/src/index.ts; extend the existing registry import
import { MyChannelAdapter } from "./adapters/my-channel.js";
import {
  createChannelSet,
  queueCtoDelivery,
  registerEscalationAdapter,
  startChannelDispatcher,
  type DispatcherBinding,
  type EscalationConfig,
  type InboxTask,
  type InboxWakeResult,
} from "./adapters/registry.js";

function myChannelWebhookUrl(config: EscalationConfig): string | null {
  const section = config.myChannel;
  if (section === null || typeof section !== "object" || Array.isArray(section)) return null;
  const value = (section as { webhookUrl?: unknown }).webhookUrl;
  if (typeof value !== "string" || value.trim().length === 0) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    return url.toString();
  } catch {
    return null;
  }
}

// Module scope, before the existing session_start/session_switch hooks.
registerEscalationAdapter("my-channel", (config, _cwd) => {
  const webhookUrl = myChannelWebhookUrl(config);
  return webhookUrl === null ? null : new MyChannelAdapter(webhookUrl);
});
```

The existing `src/index.ts` host path owns the controller/session and exact CTO
claim: `startDispatcherForHost` builds its `DispatcherBinding` and invokes the
registry's `startChannelDispatcher` with the real `onTask`/`onAnswer`
callbacks. Do not start another dispatcher, create a controller, or invent
callbacks. Registration runs before those existing lifecycle hooks; it is not a
consumer API.

### Inbound

A bidirectional adapter may implement bounded `pollOnce()` and the optional
plain-message methods, but every inbound answer must bind to the exact run
encoded by `answer.id` (`runId/escId`); latest, claimless or guessed runs are
invalid. `pollInbox` durably writes the canonical answer before invoking
`onAnswer`; webhook ACK, Telegram offset advancement, or source deletion comes
only after that write. Adapter-owned writers must use the full guide's
exact-run, create-only, collision-safe, exact-duplicate/idempotent protocol.

The no-flag legacy config above remains read-only/send-only. Shipped core also
preserves a legacy compatibility branch: a registered single-adapter config
with `bidirectional: true` resolves as an RW primary without a capability
table. This branch does **not** validate the adapter's actual methods, so the
source maintainer must ensure it implements real outbound `send` and inbound
polling/answer methods. The ask gate follows the RW result, and inbound still
requires the exact host session/CTO claim.

The current seams are:

- `startDispatcherForHost` calls `createChannelSet(captured.cwd)`;
- `messenger-channel`'s ask gate calls `hasRwPrimary(ctx.cwd)`.

For `channels[]` with no supplied capability table, unknown kinds use the
read-only fallback. To deliberately enable a capability-validated custom
inbound primary, a source maintainer must pass the same capability table to
both existing seams:
`createChannelSet(cwd, capabilities)` **and**
`hasRwPrimary(cwd, capabilities)`.

An explicit capability table replaces the built-in defaults, so every configured
kind **MUST** be listed, including every used built-in (`telegram`, `mock`,
`http`) and each custom kind, to preserve intended RW behavior. A configured kind
omitted from the explicit table fails closed to read-only (RO); omission is not a
way to intentionally enable a custom inbound channel. For listed kinds, an
explicit `channels[]`
`read-write` entry is valid only when its capability entry has both inbound
and outbound. A declared `read-only` entry never upgrades. This coordinated
source option is not a ready consumer API; the legacy `bidirectional: true`
compatibility branch is separate and remains unchecked.

Factory registration plus the no-flag config above remains send-only. External
processes must use the durable exact-run answer-file protocol. Never guess the
latest run/epoch/token or start a second CTO session.

Fullstack reserves canonical answer/in-flight records with `runId`, ownership
epoch and `session_id`: `accepted` is a normal callback return,
`pre-send-rejected` is the explicit retryable refusal, and `unknown` is an
unexpected/error or changed-ownership outcome. `unknown` is normally a
terminal `delivery_status: "unknown"` once completion is persisted; if
completion cannot be established, the reservation may remain `in-flight`.
Neither state is automatically replayed.

## 4. Референсы и тесты

- Двусторонний референс (send + bounded polling → exact answer):
  `packages/fullstack/src/adapters/telegram.ts`.
- Односторонний send-only: `packages/fullstack/src/adapters/http.ts`.
- Тесты (DI `fetchImpl`, retry/backoff, ответы): `packages/fullstack/test/adapters.test.ts`.
- Telegram standalone bridge — только Telegram; custom adapter не auto-bridged.
  Полные границы и recovery semantics: `docs/adding-escalation-adapter.md`
  (§3–§6).

## 5. Правила

- R4-санитизация в движке: секретные строки вырезаются до `send`; канал контент не добавляет.
- `send` не бросает: `{ sent: false }` → диспетчер retry с backoff (до 3).
- `blocker` ждёт без таймаута, команда паркуется (`background_wait`), остальные работают.
- Эскалации шлют CTO/лид, не воркеры (контракт глубины main(CTO) → лид → воркер).

