# Adding your own escalation channel (`EscalationAdapter`)

Как подключить собственный канал связи для CTO sub-orchestration —
Telegram-подобный бот, Slack/ntfy-вебхук, корпоративный push или свой
мессенджер. Движок коммуникации живёт в
`@andvl1/omp-workflows-core`; реализация канала принадлежит потребителю.
Fullstack содержит референсы HTTP (send-only) и Telegram (send + inbound).

---

## 1. Границы ответственности

| Слой | Что | Файлы |
|---|---|---|
| **core** | `EscalationAdapter`, типы эскалаций/ответов, санитизация R4, answer-файлы | `packages/core/src/cto/{types,escalation}.ts` |
| **fullstack** | outbox-диспетчер, lease, exact claim gate, retries, inbound polling, answer delivery state | `packages/fullstack/src/adapters/registry.ts` |
| **потребитель** | `send`/`cancel`, а для двустороннего транспорта — inbound polling и запись ответов | extension или собственный host process |

Потребитель **не дублирует** outbox, retry/backoff, дедупликацию и выбор
«последнего активного» запуска. Входящий диспетчер принимает сообщения только
при наличии точной привязки к уже захваченному host-сеансу и CTO claim.

## 2. Контракт и жизненный цикл

```
CTO/лид ── .work-state/cto/<runId>/outbox/<escId>.json ──► dispatcher
dispatcher ── sanitizeEscalation (R4) ──► adapter.send(esc) ──► канал
канал ── canonical answer ──► .work-state/cto/<runId>/answers/*.json
канал подтверждает update/offset только после durable answer ──► следующий poll
host checkpoint читает answer-файлы по exact runId
```

Потребитель реализует core-интерфейс:
// packages/fullstack/src/adapters/my-channel.ts

```ts
import type {
  Escalation,
  EscalationAdapter,
  EscalationReceipt,
} from "@andvl1/omp-workflows-core";

export class MyChannelAdapter implements EscalationAdapter {
  readonly kind = "my-channel";
  constructor(private readonly webhookUrl: string) {}

  async send(esc: Escalation): Promise<EscalationReceipt> {
    try {
      const response = await fetch(this.webhookUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(esc), // уже санитизировано движком (R4)
      });
      return { sent: response.ok, channelRef: `http:${response.status}` };
    } catch (error) {
      return {
        sent: false,
        channelRef: error instanceof Error ? error.message : String(error),
      };
    }
  }

  async cancel(_id: string): Promise<void> {
    // best-effort cancellation
  }
}
```


`Escalation` содержит `id`, `level`, `title`, `body`, `options`, `default`,
`timeoutMs` и `replyTo`. `body` и `title` проходят R4-санитизацию **до**
`send`; канал не должен добавлять секреты или необработанный контекст.

Ответы не возвращаются через `adapter.send`. Для exact run они должны быть
durable в `.work-state/cto/<runId>/answers/` в форме
`{ id, answer, at, by }`. Хост может прочитать их через core helper
`readAnswers(runId, cwd)` или обычный `readFileSync` по вычисленному пути;
это host-side чтение, а не произвольный model/tool path.

Пример безопасной записи ответа из callback/webhook. В payload сохраняется
исходный exact `id`, а имя файла не позволяет id управлять путём; hash сохраняет
различные ids, которые после sanitization дали бы один stem:

```ts
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  ensureAnswersDir,
  type EscalationAnswer,
} from "@andvl1/omp-workflows-core";

const SAFE_RUN_ID = /^[A-Za-z0-9_-]+$/u;
const SAFE_ESC_ID = /^[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_-]+)*$/u;

function persistAnswer(cwd: string, runId: string, answer: EscalationAnswer): void {
  if (
    !SAFE_RUN_ID.test(runId)
    || !SAFE_ESC_ID.test(answer.id)
    || !answer.id.startsWith(`${runId}/`)
  ) {
    throw new Error("answer id is not bound to the exact CTO run");
  }
  const dir = ensureAnswersDir(runId, cwd);
  const stem = answer.id.replaceAll("/", "-");
  const digest = createHash("sha256").update(answer.id).digest("hex");
  const path = join(dir, `${stem}-${digest}.json`);
  const payload = JSON.stringify(answer, null, 2);
  try {
    writeFileSync(path, payload, { flag: "wx" });
  } catch (error) {
    if (!(error && typeof error === "object" && "code" in error && error.code === "EEXIST")) {
      throw error;
    }
    const existing = JSON.parse(readFileSync(path, "utf8")) as Partial<EscalationAnswer>;
    if (existing.id !== answer.id || existing.answer !== answer.answer) {
      throw new Error(`conflicting answer already exists for ${answer.id}`);
    }
    // Exact duplicate: keep the first durable record.
  }
}
```

The transport must call this persistence before acknowledging a webhook,
advancing a Telegram-style offset, or otherwise deleting the source update.
If the adapter returns answers from `pollOnce`, fullstack's `pollInbox` writes
the canonical answer before invoking `onAnswer`; an adapter that owns its
transport acknowledgement must preserve the same ordering itself.

## 3. Send-only and inbound channels

### Send-only

An HTTP/webhook/push adapter implements only `send` and `cancel`. It does not
implement `pollOnce`, `setPlainMessageHandler` or `sendPlainText`; the
dispatcher sends outbox records and does not invent an inbound path. A
send-only channel cannot wake a host with an answer unless another trusted
component writes the answer file.

For the current fullstack source, a consumer-registered send-only channel may
use this project-local configuration:

```json
{
  "adapter": "my-channel",
  "myChannel": { "webhookUrl": "https://example.invalid/cto" }
}
```

This is an **outbound-only** example. Registration lets the existing
host-owned dispatcher construct the adapter and drain outbox deliveries; it
does not add inbound polling, answer writing, ask redirection or host wake-up.
Do not claim that this config alone makes a custom channel bidirectional.

### Source-maintainer registration (not a package API)

With the current package contract, only a maintainer editing the fullstack
source can register a consumer adapter. The installed package exports its
root, lecture evaluator and command assets; it does not export the registry or
dispatcher as a public root API or private `dist` subpath. Do not tell a
consumer to import either one from npm.

`MyChannelAdapter` below is the source-owned implementation shown in §2
(`packages/fullstack/src/adapters/my-channel.ts`) (or an equivalent
source-relative implementation). Add the registration to
`packages/fullstack/src/index.ts`, using the existing relative registry import,
at module scope before the existing `session_start`/`session_switch` hooks:

```ts
// packages/fullstack/src/index.ts
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

registerEscalationAdapter("my-channel", (config, _cwd) => {
  const webhookUrl = myChannelWebhookUrl(config);
  return webhookUrl === null ? null : new MyChannelAdapter(webhookUrl);
});
```

The existing fullstack host then owns the rest: `startDispatcherForHost` checks
the captured authenticated controller/session and exact CTO claim, builds the
`DispatcherBinding`, and calls the registry's `startChannelDispatcher` with
the real `onTask`/`onAnswer` callbacks already defined in `src/index.ts`.
Registering a factory does not authorize a new controller, create a second
dispatcher, or provide replacement callbacks. The registration must run before
the existing lifecycle hooks; do not call the low-level dispatcher separately.

### Inbound

A bidirectional adapter may additionally implement:

```ts
pollOnce?(): Promise<EscalationAnswer[]>;
setPlainMessageHandler?(handler: (msg: { id: string; text: string; at: string }) => void): void;
sendPlainText?(target: string, text: string): Promise<{ sent: boolean; channelRef?: string }>;
```

`pollOnce` is one bounded round. Plain messages go through
`setPlainMessageHandler`; escalation replies are `EscalationAnswer` values and
must be tied to the exact run encoded in `answer.id`. The canonical answer
writer and ACK/offset ordering remain the rules in §2: durable
`.work-state/cto/<runId>/answers/...` first, transport ACK or source deletion
second. Fullstack's `pollInbox` performs that write before invoking its
host callback.

Inbound routing uses existing host-owned seams:

- `startDispatcherForHost` calls `createChannelSet(captured.cwd)` and the
  existing registry dispatcher/binding path.
- `createAskRedirectGate` calls `hasRwPrimary(ctx.cwd)` for the ask gate.

The illustrated legacy config above omits `bidirectional`, so it is
read-only/send-only. Shipped core also preserves a legacy compatibility
branch: if that single-adapter config sets `"bidirectional": true`, a
registered kind resolves as an RW primary without a capability table. This
branch does **not** validate the adapter's actual methods. A source maintainer
using it must confirm that the registered adapter really implements outbound
`send` plus the inbound polling/answer surface, and must understand that the
ask gate follows this RW result; an incorrect flag can redirect asks to a
channel that cannot receive. The exact host session/CTO claim is still
required for inbound delivery.

For `channels[]` with no supplied capability table, unknown kinds use the
read-only fallback. To deliberately enable a capability-validated custom
inbound primary, a source maintainer must pass the same capability table to
both existing seams: `createChannelSet(cwd, capabilities)` **and**
`hasRwPrimary(cwd, capabilities)`.

An explicit capability table replaces the built-in defaults, so every configured
kind **MUST** be listed, including every used built-in (`telegram`, `mock`,
`http`) and each custom kind, to preserve intended RW behavior. A configured kind
omitted from the explicit table fails closed to read-only (RO); omission is not a
way to intentionally enable a custom inbound channel. For listed kinds, an
explicit `channels[]`
`read-write` entry is valid only when its capability entry has both inbound
and outbound; a declared `read-only` entry never upgrades. This coordinated
source option is not a ready consumer API. The legacy `bidirectional: true`
compatibility branch is separate and remains unchecked.

Factory registration plus the config above (without the legacy flag) remains
send-only. Inbound code must continue using the existing exact host binding;
never guess a latest run, epoch or token and never start a second CTO session.

## 4. Answer delivery outcomes
The dispatcher reserves the canonical answer before invoking `onAnswer` and
records the run id, ownership epoch and session id. The observable outcomes are:

- **accepted** — the bound callback was invoked and returned normally (including
  `void`); the answer may receive an ACK.
- **unknown** — the callback threw a non-typed error or the completion proof
  changed. When completion can be persisted, the canonical record is completed
  with `delivery_status: "unknown"`; if completion cannot be established, the
  reservation may remain `in-flight`. Neither state is automatically replayed.
- **pre-send-rejected** — the callback explicitly returned `"rejected"` or
  threw `InboxWakeRejectedError` before host send; the source/marker remains
  retryable for a later exact claim. This is the only automatic retry path.

An accepted or terminal unknown canonical answer, or an unresolved in-flight
reservation, is never replayed merely because the dispatcher restarted or the
ownership epoch changed. A callback that cannot prove a pre-send refusal must
not report `"rejected"` as a convenience.

## 5. Rules and focused tests

- `send` should return `{ sent: false }` rather than throw; the dispatcher owns
  bounded retry/backoff for outbox delivery.
- `blocker` waits without a timeout; the command may park as `background_wait`.
- Answer files are durable data, not adapter return values and not arbitrary
  model input.
- The engine sanitizes secrets before `send`; channels do not add unsanitized
  context.
- Escalations originate at the CTO/lead depth, not from workers.
- Test the adapter's own transport behavior, exact answer persistence and any
  inbound authorization. Do not expand the core interface or simulate the
  public `/cto` command in a mock.

## 6. Standalone bridge: Telegram only

`packages/fullstack/bin/tg-bridge.mjs` is a Telegram-specific executable. It
constructs the Telegram adapter, owns the Telegram `getUpdates` consumer through
`.omp/bridge.lock`, writes local inbox/answer markers and sends plain Telegram
text when supported. It is **not** a generic bridge for every registered
`EscalationAdapter`, does not auto-discover custom transports, and does not
replace the exact host claim required by an in-session dispatcher.

For Slack, ntfy, HTTP or another channel, run the consumer's own callback/poll
process and write exact answer files before acknowledging the source. If it
also wakes a resident CTO, it must use the same host-owned
`{ session_id, getClaim }` binding; do not route inbound data through the
Telegram executable.
