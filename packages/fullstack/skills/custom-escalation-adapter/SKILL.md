---
name: custom-escalation-adapter
description: Add a project-local Telegram/Slack/ntfy/custom escalation channel through the fullstack adapter seam. Use when the user asks to build or connect a CTO escalation transport, notification channel, or custom adapter.
---

# Custom escalation adapter

## 1. Consumer-owned project activation is explicit

A custom adapter extension owns a physical project-local marker, for example
`.omp/my-channel.activation.json`, and the matching `WorkflowOwnerIdentity`
activation descriptor. An explicit project bootstrap writes the exact marker
bytes and digest. Loading the extension, registering ordinary commands, and
installing dependencies never create it. No global or home-directory marker is
valid.

The marker proves persisted cooperative project intent only. A host
`ExtensionAPI` does not expose source identity, so an in-process extension
could copy a descriptor or read the marker; never describe it as cryptographic
package-authorship proof. Core still requires exact owner, marker, and canonical
root matching. Missing, malformed, extra-key, symlinked, or wrong-digest
markers fail closed as `activation_markers_missing`.

## 2. Authenticate registration through core

Use the public core registry subpath and keep the transaction outermost. The
curated `closeWorkflowActivation` helper closes the opaque context and releases
only capabilities newly acquired by that exact successful activation. The
adapter registry retains a token-derived live guard after commit, so successful
activation must remain open until the matching session/root shuts down.

Keep active activation in plugin-local state keyed by the extension instance
and exact canonical root; do not create a process-global ownership map. Failed
begin/register/commit paths roll back and close immediately. On
`session_shutdown`, verify the same session/root, delete the local slot, and
then call `closeWorkflowActivation`.

```ts
import {
  beginRegistryRegistration,
  closeWorkflowActivation,
  commitRegistryRegistration,
  openWorkflowActivation,
  rollbackRegistryRegistration,
  type WorkflowOwnerIdentity,
} from "@andvl1/omp-workflows-core/registry";
import {
  registerEscalationAdapter,
  type EscalationAdapterCapabilities,
  type EscalationAdapterFactory,
} from "@andvl1/omp-workflows-fullstack/adapters";

const ownerForProjectRoot = (projectRoot: string): WorkflowOwnerIdentity =>
  customOwnerWithMarker(projectRoot); // .omp/my-channel.activation.json + exact digest

type Active = {
  readonly projectRoot: string;
  readonly activation: Extract<ReturnType<typeof openWorkflowActivation>, { ok: true }>;
};
const activeByExtension = new WeakMap<object, Active>();

function mount(extension: object, projectRoot: string, factory: EscalationAdapterFactory): void {
  const owner = ownerForProjectRoot(projectRoot);
  const activation = openWorkflowActivation(projectRoot, ["workflow_registration"], owner);
  if (!activation.ok) throw new Error(`${activation.code}: ${activation.error}`);
  const transaction = beginRegistryRegistration(
    activation.registry_context,
    projectRoot,
    ["escalation_adapters"],
  );
  if (!transaction.ok) {
    closeWorkflowActivation(activation);
    throw new Error(`${transaction.code}: ${transaction.error}`);
  }
  try {
    const capabilities: EscalationAdapterCapabilities = {
      canReceiveInbound: true,
      canSend: true,
      canSendWithIdempotency: true,
    };
    registerEscalationAdapter(transaction.token, "my-channel", factory, capabilities);
    commitRegistryRegistration(transaction.token);
  } catch (error) {
    try { rollbackRegistryRegistration(transaction.token); } catch { /* preserve original */ }
    closeWorkflowActivation(activation);
    throw error;
  }
  // Keep the activation live for the registry guard; close on exact shutdown.
  activeByExtension.set(extension, { projectRoot, activation });
}

function onSessionShutdown(extension: object, projectRoot: string): void {
  const active = activeByExtension.get(extension);
  if (!active || active.projectRoot !== projectRoot) return;
  activeByExtension.delete(extension);
  closeWorkflowActivation(active.activation);
}
```

The token is opaque and borrowed. Never invent one, persist one, pass an owner
id instead, or use it after commit/rollback. A registration transaction must
request only `escalation_adapters`; do not borrow a generic runtime transaction
facade or unrelated authority. Match the exact session/root before shutdown
cleanup.

## 3. Implement the channel

Implement core's `EscalationAdapter` (`kind`, `send`, `cancel`, and any declared
inbound/idempotency methods). The factory receives validated project
configuration, cwd, and the pinned root:

```ts
const factory: EscalationAdapterFactory = (config, cwd, pinnedRoot) => {
  const settings = config["my-channel"];
  if (!isValidSettings(settings)) return null;
  return new MyChannelAdapter(settings, pinnedRoot);
};
```

`send` receives R4-sanitized data. Return `{ sent: false, channelRef }` on a
transport failure instead of throwing; the dispatcher applies bounded retry.
Do not add secrets or untrusted content to the outgoing body.

`createEscalationAdapter` is the safe construction path for a configured
built-in or authenticated consumer registration. It returns `null` for an
unusable or capability-incompatible configuration.

## 4. Persist inbound answers safely

Answers are files, not return values from the adapter. Validate safe run and
escalation ids, verify `pinnedRoot.isStable()`, create the project-local
`.work-state/cto/<runId>/answers/` directory through the pinned root, and use
exclusive canonical filenames. Never import core raw readers or write through
an unpinned absolute path. Re-check stability after writing.

## 5. Project configuration and explicit copy

A project may configure a channel in `.omp/escalation.json`:

```json
{
  "adapter": "my-channel",
  "my-channel": { "endpoint": "https://example.invalid/topic" }
}
```

The project must run an explicit copy/bootstrap command only when disk command
discovery is required:

```bash
npm run --prefix node_modules/@andvl1/omp-workflows-fullstack copy-commands
# or
npx omp-workflows-copy-commands
```

There is no package `postinstall` hook. Normal dependency installation performs
no project writes, command copy, marker creation, or global installation.

## 6. Checklist

- Explicitly bootstrap this extension's project-local physical marker.
- Call `openWorkflowActivation` and require the exact marker/digest/root.
- Borrow a token from `beginRegistryRegistration(..., ["escalation_adapters"])`.
- Register through `@andvl1/omp-workflows-fullstack/adapters` only.
- Commit or rollback once; retain successful activation until exact shutdown.
- Close failed transactions immediately and successful activations with
  `closeWorkflowActivation` only after matching session/root shutdown.
- Keep dispatcher/queue/bridge/raw registry helpers private.
- Persist inbound answers only through a stable pinned project root.
