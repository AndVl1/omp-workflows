# Adding a project-local escalation channel

`@andvl1/omp-workflows-core` owns the escalation protocol and authenticated
registry transaction. `@andvl1/omp-workflows-fullstack` ships HTTP and Telegram
references plus the resident dispatcher. A consumer implements its own channel
and registers it for one explicitly activated project; there is no global
adapter installation.

## 1. Runtime boundary

The durable flow is:

```text
CTO/lead -> .work-state/cto/<runId>/outbox/<id>.json
         -> fullstack dispatcher -> sanitizeEscalation -> adapter.send()
channel callback -> pinned project root -> .work-state/cto/<runId>/answers/<id>.json
```

The dispatcher, retry policy, redaction, and durable queue are runtime-owned.
Consumers should not import queue, bridge, dispatcher, raw state, or raw registry
helpers. The supported fullstack package surface is deliberately narrow:

```ts
import {
  createEscalationAdapter,
  registerEscalationAdapter,
} from "@andvl1/omp-workflows-fullstack/adapters";
import type {
  EscalationAdapterCapabilities,
  EscalationAdapterFactory,
  EscalationConfig,
} from "@andvl1/omp-workflows-fullstack/adapters";
```

`registerEscalationAdapter` requires an opaque
`RegistryRegistrationToken`; it cannot be replaced with an owner id, marker
string, or hand-built object. The curated subpath exposes no generic registry
transaction or runtime-facade authority.

## 2. Consumer-owned project activation and registration

A custom adapter extension opens its own project-local physical marker
activation through core. Choose a marker path owned by that extension (for
example `.omp/my-channel.activation.json`), create it only in an explicit
project bootstrap/enable command, and include its exact file identity and
SHA-256 in the custom owner descriptor. Extension loading, ordinary command
registration, and dependency installation never create it. Do not write a
marker to a home directory or any other global location.

Activation is cooperative project intent, not cryptographic proof of package
authorship: a host `ExtensionAPI` exposes no source identity. A malicious
in-process extension could copy a descriptor or read the marker. The marker is
therefore only a persisted project-local boundary, and every registry operation
still validates the physical project root and marker identity.

The consumer owns the marker bytes and owner descriptor. For example, its
explicit bootstrap can export `MY_CHANNEL_MARKER_SHA256` from a local
`activation-marker.ts`, while its owner source can be a concrete identity:

```ts
import type { WorkflowOwnerIdentity } from "@andvl1/omp-workflows-core/registry";
import { MY_CHANNEL_MARKER_SHA256 } from "./activation-marker.js";

const ownerForProjectRoot = (projectRoot: string): WorkflowOwnerIdentity => ({
  owner_id: "@example/my-channel",
  bundle_id: "@example/my-channel",
  owner_kind: "private_omp",
  activation_marker: "my-channel",
  host_range: ">=17 <19",
  activation: {
    marker_id: "my-channel",
    required: [{
      path: ".omp/my-channel.activation.json",
      kind: "file",
      sha256: MY_CHANNEL_MARKER_SHA256,
    }],
  },
  provenance: {
    package: "@example/my-channel",
    entrypoint: "dist/index.js",
    cwd: projectRoot,
    config_path: join(projectRoot, ".omp", "team.config.json"),
  },
});
```

Then borrow one token from the core transaction for the adapter family. A
successful activation must stay open for the extension/session lifetime: the
adapter registry captures a token-derived live guard on commit. Keep the
activation in plugin-local state keyed by the exact extension instance and
canonical project root; do not create a process-global owner map or claim.
Close it only on the matching `session_shutdown` (or when that exact session/root
is evicted). Failed begin/register/commit paths roll back and close immediately.

```ts
import {
  beginRegistryRegistration,
  closeWorkflowActivation,
  commitRegistryRegistration,
  openWorkflowActivation,
  rollbackRegistryRegistration,
} from "@andvl1/omp-workflows-core/registry";
import {
  registerEscalationAdapter,
} from "@andvl1/omp-workflows-fullstack/adapters";
import type {
  EscalationAdapterCapabilities,
  EscalationAdapterFactory,
} from "@andvl1/omp-workflows-fullstack/adapters";

// Plugin-local state, not a process-global ownership claim.
type ActiveAdapterActivation = {
  readonly projectRoot: string;
  readonly activation: Extract<ReturnType<typeof openWorkflowActivation>, { ok: true }>;
};
const activeByExtension = new WeakMap<object, ActiveAdapterActivation>();

function mountAdapter(extension: object, projectRoot: string): void {
  const owner = ownerForProjectRoot(projectRoot);
  const activation = openWorkflowActivation(
    projectRoot,
    ["workflow_registration"],
    owner,
  );
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
    const factory: EscalationAdapterFactory = (config, cwd, pinnedRoot) =>
      createMyChannel(config, cwd, pinnedRoot);
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

  // Do not close here: the committed adapter keeps this activation's live guard.
  activeByExtension.set(extension, { projectRoot, activation });
}

function closeOnSessionShutdown(extension: object, projectRoot: string): void {
  const active = activeByExtension.get(extension);
  if (!active || active.projectRoot !== projectRoot) return;
  activeByExtension.delete(extension);
  closeWorkflowActivation(active.activation); // idempotent exact-session cleanup
}
```

`closeWorkflowActivation` is the curated lifecycle helper: it closes the opaque
registry context and releases only capabilities newly acquired by this exact
activation. Do not call it after a successful commit until the matching session
and canonical root shut down. It is safe after rollback and repeated shutdown
cleanup. The outer transaction still owns commit or rollback; a consumer must
not retain the borrowed token after that transaction ends. The custom owner,
marker, and canonical project root must match exactly; otherwise core returns a
typed activation/owner failure.

## 3. Adapter contract

Implement the core `EscalationAdapter` interface in the consumer extension. The
fullstack factory receives the pinned project root when the resident dispatcher
constructs the adapter; the curated package does not grant a generic runtime
transaction facade:

```ts
import type {
  Escalation,
  EscalationAdapter,
  EscalationReceipt,
  PinnedProjectRoot,
} from "@andvl1/omp-workflows-core";
import type {
  EscalationAdapterFactory,
  EscalationConfig,
} from "@andvl1/omp-workflows-fullstack/adapters";

export const factory: EscalationAdapterFactory = (config, cwd, pinnedRoot) => {
  const settings = config["my-channel"];
  if (!isValidSettings(settings)) return null;
  return new MyChannelAdapter(settings, pinnedRoot);
};

class MyChannelAdapter implements EscalationAdapter {
  readonly kind = "my-channel";

  async send(esc: Escalation): Promise<EscalationReceipt> {
    try {
      const response = await sendToMyChannel(esc);
      return { sent: response.ok, channelRef: `my-channel:${response.status}` };
    } catch (error) {
      return { sent: false, channelRef: error instanceof Error ? error.message : String(error) };
    }
  }

  async cancel(_id: string): Promise<void> {
    // Best effort; cancellation must not make the dispatcher throw.
  }
}
```

`send` receives an already sanitized escalation. It must not add secrets or
untrusted content. The dispatcher retries `{ sent: false }` with bounded
backoff; adapters should return a failure receipt instead of throwing.

## 4. Answers are files under the pinned root

Inbound callbacks never return answers through the adapter API. Validate the
run and escalation ids, ensure the pinned root is stable, and write an
exclusive canonical answer file below
`.work-state/cto/<runId>/answers/`. The adapter must use the pinned-root
methods supplied by the host, not `writeFileSync`, `ensureAnswersDir`, raw core
readers, or a path assembled from untrusted ids.

```ts
function persistAnswer(
  pinnedRoot: PinnedProjectRoot,
  answer: { id: string; run_id: string; answer: string; at: string; by: string },
): void {
  if (!pinnedRoot.isStable()
      || !isSafeCtoRunId(answer.run_id)
      || !isSafeEscalationId(answer.id)
      || answer.answer.length === 0) {
    throw new Error("unsafe answer identity or changed project root");
  }
  const directory = join(".work-state", "cto", answer.run_id, "answers");
  pinnedRoot.ensureDirectory(directory);
  pinnedRoot.writeExclusive(
    join(directory, canonicalDurableIdFileName(answer.id)),
    JSON.stringify(answer),
  );
  if (!pinnedRoot.isStable()) throw new Error("project root changed after answer persistence");
}
```

## 5. Explicit project configuration

The project may keep transport settings in `.omp/escalation.json`:

```json
{
  "adapter": "my-channel",
  "my-channel": { "endpoint": "https://example.invalid/topic" }
}
```

The file is project-local. The fullstack extension resolves it through its
normal runtime path and starts its dispatcher only after the project activation
and owner transaction have succeeded. Missing or malformed activation markers
fail closed with `activation_markers_missing`; they are never silently
repaired.

To materialize compatibility slash-command files, run the explicit project
command only when that project needs disk discovery:

```bash
npm run --prefix node_modules/@andvl1/omp-workflows-fullstack copy-commands
# or
npx omp-workflows-copy-commands
```

Dependency installation has no `postinstall` activation hook and does not copy
commands or write markers. The explicit copy/bootstrap action must run against
the intended project root; it never installs anything globally.

## 6. Security and lifecycle checklist

- Explicitly bootstrap this extension's project-local physical marker.
- Require that marker, its exact digest, and the canonical root through
  `openWorkflowActivation`.
- Begin only `["escalation_adapters"]` for this consumer registration.
- Pass the borrowed token to `registerEscalationAdapter` and commit or roll it
  back exactly once.
- Retain successful activation until the matching session/root shutdown; close
  failed transactions immediately and successful activation only with
  `closeWorkflowActivation` during that shutdown.
- Keep dispatcher, queue, bridge, durable state, and raw registry helpers out of
  the consumer package surface.
- Use pinned-root, exclusive writes for inbound answer files.
- Keep marker/bootstrap and command-copy actions project-local and explicit;
  never add a global install or a load-time write.
