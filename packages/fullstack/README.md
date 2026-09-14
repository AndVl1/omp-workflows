# @andvl1/omp-workflows-fullstack

Default fullstack bundle for `@andvl1/omp-workflows-core`. Ships 16 specialized agents, 27 domain skills, and 7 OMP custom-TS slash command adapters for Spring/Kotlin/React/KMP/Telegram-bot projects.

## Install

```bash
npm install @andvl1/omp-workflows-fullstack @andvl1/omp-workflows-core
```

The extension registers `/do-work`, `/team`, `/cto`, and
`/omp-model-roles` directly during plugin loading, so they appear in slash
autocomplete and execute from the installed package without a project-local
copy. The copy command remains available only for explicitly requested legacy
disk-discovery compatibility and install-time bootstrap:

```bash
npm run --prefix node_modules/@andvl1/omp-workflows-fullstack copy-commands
# or
npx omp-workflows-copy-commands
```

`session_start` does not copy or load project-local compatibility command
assets. This avoids resolving the fullstack core peer from an arbitrary
consumer worktree; the hardened copier remains an explicit manual
compatibility/bootstrap path and records `.omp/commands/.omp-shipped.json`
(schema 2).

The explicit installer is also the cooperative fullstack opt-in: after a
successful copy it writes `.omp/fullstack.activation.json` with the canonical
bundle marker. Run it against the intended project root before loading the
extension when that project is being enabled; it never installs globally, and
ordinary dependency installation, extension loading, or `session_start` does
not create or repair that file. A pre-existing differing, malformed, symlinked,
or wrong-kind marker is preserved and fails closed. The marker is a
project-local routing signal, not a cryptographic signature or
package-authenticity proof.

## Custom escalation adapters

Consumers implement channels per project through the narrow public subpath;
the dispatcher, queue, bridge, and raw registry helpers remain runtime
internals. A custom adapter extension owns its own project-local physical
marker and activation owner; it does not borrow fullstack runtime authority:

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

// customOwnerForProjectRoot requires this extension's exact physical marker,
// for example .omp/my-channel.activation.json. Its marker is cooperative
// project intent, not cryptographic proof of package authorship.
const owner: WorkflowOwnerIdentity = customOwnerForProjectRoot(projectRoot);
const activation = openWorkflowActivation(projectRoot, ["workflow_registration"], owner);
if (!activation.ok) throw new Error("activation failed");
const transaction = beginRegistryRegistration(activation.registry_context, projectRoot, ["escalation_adapters"]);
if (!transaction.ok) {
  closeWorkflowActivation(activation);
  throw new Error("registration transaction failed");
}
try {
  const factory: EscalationAdapterFactory = (config, cwd, pinnedRoot) => createMyChannel(config, cwd, pinnedRoot);
  const capabilities: EscalationAdapterCapabilities = { canReceiveInbound: true, canSend: true, canSendWithIdempotency: true };
  registerEscalationAdapter(transaction.token, "my-channel", factory, capabilities);
  commitRegistryRegistration(transaction.token);
} catch (error) {
  try { rollbackRegistryRegistration(transaction.token); } catch { /* preserve original */ }
  closeWorkflowActivation(activation);
  throw error;
}
// Retain this activation in plugin-local state keyed by extension + canonical
// root. The adapter registry keeps a token-derived live guard after commit.
// On matching session_shutdown, delete the slot and call closeWorkflowActivation.
```

`registerEscalationAdapter` accepts only the opaque token borrowed from the
core transaction. Do not construct a token, use an owner id/marker string, or
retain the token after commit/rollback. `closeWorkflowActivation` is not called
after a successful commit; it closes the retained activation on the matching
session/root shutdown. Do not create a process-global owner map or claim. The
custom owner, marker, and canonical project root must match exactly. Because the
host exposes no source identity, an in-process extension could copy a descriptor
or read the marker, so docs must not claim cryptographic authorship.

The adapter factory receives validated project configuration, the project cwd,
and a pinned root. Implement core's `EscalationAdapter` (`kind`, `send`,
`cancel`, plus any declared inbound/idempotency methods). Inbound answers are
persisted as canonical files below `.work-state/cto/<runId>/answers/` through
the stable pinned root; they are not returned through the adapter API. `send`
receives already sanitized data and returns `{ sent: false }` on transport
failure so the dispatcher can retry.

## What it does

`/omp-workflows-fullstack` composes three separate core seams with one fullstack owner identity. The mount is activation-bound and project-local; no ownership is inferred from package loading:

```ts
// owner includes the exact physical project marker and canonical-root provenance.
const owner = fullstackOwnerForCwd(projectRoot);
const resolveCwd = resolveSessionCwd;

// Commands receive the same owner/resolver and are safe to publish eagerly.
registerWorkflowCommands(pi, { resolveCwd, owner });

const activation = openWorkflowActivation(projectRoot, ["workflow_registration", "workflow_tools", "config_writer"], owner);
if (!activation.ok) throw new Error("activation marker/root validation failed");
const transaction = beginRegistryRegistration(activation.registry_context, projectRoot, ["workflow_profiles", "constitution_gate", "runtime_config", "workflow_tools"]);
if (!transaction.ok) {
  closeWorkflowActivation(activation);
  throw new Error("workflow registration transaction failed");
}
try {
  registerTeamWorkflow(pi, { label: "omp-workflows-fullstack", roles: fullstackPreset.roles, scopeMap: fullstackPreset.scopeMap, flags: fullstackPreset.flags, resolveCwd, owner, cwd: projectRoot, registrationToken: transaction.token });
  createWorkflowToolAdapter({ resolveCwd, owner, registrationToken: transaction.token }).register(pi);
  commitRegistryRegistration(transaction.token);
  // Retain activation in extension/session state; close it only on matching shutdown.
} catch (error) {
  try { rollbackRegistryRegistration(transaction.token); } catch { /* preserve original */ }
  closeWorkflowActivation(activation);
  throw error;
}
```

A successful activation remains open because the registered runtime may retain a token-derived live guard. On the exact session/root shutdown, remove the activation from plugin-local state and call `closeWorkflowActivation`; do not create a process-global owner map. Failed begin/register/commit paths roll back and close immediately. A custom bundle must wire all three layers; see [`../../docs/adding-agents.md`](../../docs/adding-agents.md#4-регистрация-workflow).

The command handlers resolve and authorize the session cwd, generate a prompt,
and pass it to `pi.sendUserMessage(...)`. They do not spawn subagents directly.
The prompt still traverses OMP's normal `before_agent_start` / `context`
lifecycle before the resident main agent invokes the active owner's
`workflow_*` tools.

Command names and workflow ownership are independent. A later extension can
replace a same-name handler in OMP's command map, but it does not replace the
bundle holding `workflow_registration`, `workflow_tools`, or `config_writer`;
an owner-aware handler from another bundle fails closed with `owner_conflict`.
For a complete replacement, disable this bundle and load only the custom
bundle. For coexistence, register a prefix such as `commandPrefix: "rust"`.

The taxonomy that backs the bundled `/omp-model-roles validate` command
(`defaultFullstackModelRoles`, 14 entries) is imported from
`@andvl1/omp-workflows-core` so another bundle can compose the same helpers
(`resolveRoleChain`, `isResearchRequest`, `isResearchResponse`) against its own
`ModelRoleEntry[]`.

The extension writes `.omp/team.config.json` only when it is absent. Editing
that file changes role/scope/roster resolution without replacing commands.
The `commands/` adapters remain a compatibility path for runtimes that only
discover custom-TS files from disk; same-name project files are not an override
API.

The `agents/` and `skills/` directories are picked up by OMP's discovery automatically.

## Readable specification workflow

Fullstack wires the core's native, readable specification workflow at version **0.27.0**. During extension assembly it registers the shipped document renderers, validates the shipped constitution-first template set, registers the native constitution provider, and primes the shipped format recognizers. This setup is idempotent and additive; it does not create a second state machine or command path.

### Commands and authority boundaries

The direct commands are available from the installed extension, in addition to `/do-work`, `/team`, and `/cto`:

```text
/specify [--feature <feature-id>] <request>
/spec-plan --feature <feature-id>
/spec-tasks --feature <feature-id>
/spec-import <path> [--framework <id|generic>] [--feature <feature-id>]
```

For example:

```text
/specify --feature account-recovery Add account recovery with email verification
/spec-plan --feature account-recovery
/spec-tasks --feature account-recovery
/do-work --spec account-recovery Implement task T-1 from the approved handoff
```

Specify → Plan → Tasks is a constitution-first sequence. Each phase produces a typed immutable artifact and pauses for a trusted human decision: `approve_continue`, `request_changes`, or `approve_stop`. Approval advances or stops specification preparation only; it never dispatches implementation. `/do-work` adaptively chooses quick, bounded Specify, or full specification preparation, then uses an exclusive handoff claim and conformance evidence before execution. `/cto <task>` is the resident main-session CTO; `/cto` enters standby, and `task(agent=cto)` is never used.

Readable phase projections are under `specs/<feature-id>/`; authoritative state is `.work-state/features/<feature-id>/state.json`, with versioned artifacts below the feature's `artifacts/` directory. A safe explicit feature id and durable run key are the identity; branch names and `.active-feature` never select or replace a workspace. The retired `dod_and_artifacts/CompletionDodStatus/dod_status` path and old JSON-only specification flow are not supported.

### Registration seams and generic fallback

Fullstack primes these format recognizers in deterministic order: `speckit`, `openspec`, `bmad`, `superpowers`, `xpowers`, then `generic`. A named framework is selected only when its recognizer claims the bounded local sources. The final `generic` recognizer maps readable requirements/specification, plan/design, and tasks documents without framework markers. It is the fallback for `--framework generic`; competing claims or competing generic document sets fail closed and require an explicit selector.

The constitution/provider boundary is also explicit. The native provider contributes the shipped bootstrap template; a consumer may register a provider with `registerConstitutionProvider(...)` to discover an existing safe project-local policy. Provider resolution is explicit override → one discovered provider → native default. A provider is discovery-only: it reads bounded regular files and does not install, invoke, or shell out to a framework CLI. Likewise, recognizers and `/spec-import` inspect one authorized local path read-only, capture a snapshot/hash, and perform no network access, external command execution, or source writes. Custom bundles can add recognizers with `registerFormatRecognizer(...)`; they must preserve fail-closed ambiguity and path-boundary checks.

Template and language selections are persisted with each phase: language precedence is feature override → project default → request language; template precedence is feature override → project default → shipped default. An invalid higher-precedence template does not fall through. Changing either selection stales affected approvals and requires revalidation. Legacy JSON migration is one-way and read-only, requires explicit safe identity plus a compatible Specify/Plan/Tasks state and constitution binding, and writes a migration receipt; incompatible input returns `SPEC_MIGRATION_BLOCKED` with diagnostics instead of guessing.

### CTO multi-feature preparation and execution

CTO preparation may schedule independent features concurrently, but keeps one writer per feature/phase and records queue reasons: `capacity`, `depth`, `ownership`, `active_phase`, `same_feature_serialized`, and `nested_cto`. Nested CTO requests queue behind the resident CTO. Decisions are independent per feature and phase; `request_changes` reopens that phase, while `approve_stop` stops that feature at its boundary. After Tasks approval, CTO emits the review packet and takes a final hard stop: preparation never starts implementation.

A separate execution step preflights explicit feature/run selectors and freezes exact handoff digests into one mapping. Dispatch requires trusted human confirmation of the exact mapping id and hash; approval is not execution authority. Safe slicing gives each task one owner, records dependencies and serializes shared contracts, while only independent slices run in parallel. Conformance is evaluated per feature and handoff: passing features release their claims; blocked features retain claims and receive feature-local remediation. Evidence cannot be borrowed across handoffs.

The most useful recovery signals are actionable: `SPEC_ARGUMENT_INVALID` or `SPEC_SELECTOR_AMBIGUOUS` means correct the command grammar; `SPEC_SELECTOR_REQUIRED` or `SPEC_PATH_UNAUTHORIZED` means provide a safe explicit selector/local path; `SPEC_CONSTITUTION_SOURCE_AMBIGUOUS` or `SPEC_STATE_INVALID` means resolve the competing or malformed source and rerun; `SPEC_TEMPLATE_*` or `SPEC_LANGUAGE_UNRESOLVED` means fix presentation configuration and revalidate; `SPEC_HANDOFF_INCOMPLETE` or `SPEC_HANDOFF_STALE` means follow the returned direct phase command; and `SPEC_EXECUTION_CLAIMED` means wait for the current owner rather than taking over. Durable state, hashes, trusted proofs, claims, and mapping bindings remain authoritative.

## URL-first lecture research

Submit exactly one public HTTPS YouTube video or playlist URL together with a natural-language prompt to `/do-work`. Intake records explicit rights and media mode; absent approval is metadata-only and fail-closed. The main-session `lecture_acquire` tool parses the bounded source set, then either runs the legacy public-URL provider (Gemini) when configured, or the rights-gated `transcribe-analyze` pipeline.

### Provider matrix and billing separation

| Stage | Default | Alternatives | Billing |
| --- | --- | --- | --- |
| Playlist metadata | YouTube Data API (`YOUTUBE_DATA_API_KEY`) | none | YouTube quota units |
| Legacy URL analysis (compatibility) | disabled unless `gemini` block + `GEMINI_API_KEY` present | — | Gemini API billing |
| Audio acquisition | `authorized-command` via `LECTURE_AUDIO_COMMAND` or `existing-input` via `LECTURE_AUDIO_INPUT` | — | local only |
| ASR | `openrouter-native` (native JSON/base64; exact Nemotron model; `OPENROUTER_API_KEY`) | `whisper-local` (`WHISPER_CPP_BIN`, `WHISPER_CPP_MODEL_PATH`) or `hosted-openai-compatible` | OpenRouter per request / 0 / provider per audio minute |
| Text analysis | `openai-compatible` remote HTTPS (`OPENROUTER_API_KEY` or project-specific env name) | explicit `ollama`/`vllm` loopback fallback; injected OMP runtime capability | provider token billing / 0 locally |

OMP model roles are not runtime credentials. Set `"omp": { "enabled": true, "role": "lecture-analysis" }` only when the host injects a callable `ompRuntime` capability (`invoke(input, options) -> JSON text`) into the lecture service/tool context. Without that capability, acquisition returns the typed `OMP_RUNTIME_UNAVAILABLE` failure before media or ASR work; it never pretends that role metadata can run a model. When OMP is disabled (the default), the configured `analysis` provider is used and its nested `fallback` is the only fallback route.

### Pipeline configuration (opt-in)

A `.omp/lecture-research.json` with a top-level `"pipeline"` block selects `transcribe-analyze`; without it the legacy Gemini compatibility path applies exactly as before:

```json
{
  "limits": { "maxItems": 4, "deadlineMs": 120000, "maxTranscriptSegments": 4096, "maxAudioBytes": 67108864, "maxChunksPerSource": 128, "maxProviderCostCents": 5000 },
  "pipeline": {
    "mode": "transcribe-analyze",
    "audio": { "provider": "authorized-command", "commandEnv": "LECTURE_AUDIO_COMMAND", "maxBytes": 67108864, "timeoutMs": 60000 },
    "asr": {
      "provider": "openrouter-native",
      "transport": "json-base64",
      "model": "nvidia/nemotron-3.5-asr-streaming-multilingual-0.6b",
      "endpoint": "https://openrouter.ai/api/v1",
      "trust": "trusted-remote",
      "apiKeyEnv": "OPENROUTER_API_KEY",
      "timestampMode": "estimated",
      "maxRequestBytes": 33554432,
      "chunkDurationSeconds": 45,
      "chunkTimeoutMs": 60000
    },
    "analysis": {
      "provider": "openai-compatible",
      "model": "fixture-model",
      "endpoint": "https://openrouter.ai/api/v1",
      "trust": "trusted-remote",
      "apiKeyEnv": "OPENROUTER_API_KEY",
      "fallback": { "provider": "ollama", "model": "llama3.1", "endpoint": "http://127.0.0.1:11434/v1", "trust": "local-loopback" }
    }
  }
}
```
The native ASR branch posts to the model-specific, validated `https://openrouter.ai/api/v1/audio/transcriptions` route with the exact `{ model, input_audio: { data: <raw-base64>, format: "wav" } }` shape and consumes the direct `{ text, usage? }` response. Analysis remains on the existing `https://openrouter.ai/api/v1/chat/completions` transport. The model is pinned exactly to `nvidia/nemotron-3.5-asr-streaming-multilingual-0.6b`; the model-specific endpoints API is the source of truth for live QA, and generic catalog omission is not a product error. Keys are resolved from the configured environment-variable name immediately before use and are never written to errors or artifacts.

Prepared normalized PCM WAV leases that fit the conservative encoded envelope retain the exact one-fetch fast path. Larger leases are read once as RIFF/WAVE PCM s16le mono 16-kHz data and sent as bounded sequential chunks (`concurrency=1`) with zero overlap, no retries, and no temporary chunk files. Every chunk body is checked as UTF-8 JSON against `maxRequestBytes` (default 32 MiB, hard cap 64 MiB); each synthesized WAV has a canonical 44-byte header. A chunk error, cancellation, malformed/truncated input, request/cost/response/transcript bound, or final global validation failure discards the complete single-source transcript and produces no partial evidence. `maxChunksPerSource` remains the independent analysis-chunk limit and also caps ASR requests only when chunk mode is selected; neither limit is silently reused as a transcript-segment count.

`chunkDurationSeconds` defaults to 45 and accepts integers 1..60. `chunkTimeoutMs` defaults to 60000 and accepts integers 1..120000. The existing `maxAudioBytes` lease cap remains a total-source bound; the default 64 MiB must be raised explicitly (never above the 256 MiB hard cap) for long normalized WAVs. Global estimated timestamps are frame-derived and disclosed as `timestampMode: "estimated"` for the direct text response; the native STT contract does not assume provider timecodes. The supplied 1:09:42 target is 4,182 seconds, so `ceil(4182 / 45) = 93` sequential requests, below the default 128-request cap; its normalized mono 16-kHz PCM lease is roughly 134 MiB, so it requires an explicit audio lease cap increase while still holding only one request-safe chunk in memory.

For an owned/licensed smoke, set `LECTURE_AUDIO_COMMAND` to a JSON argv such as `["/path/to/node","/path/to/packages/fullstack/scripts/yt-dlp-owned-audio.mjs"]` and set `YT_DLP_BIN` to the installed yt-dlp executable path (for example, `/opt/homebrew/bin/yt-dlp`). The executable requires a non-empty, newline-free `YT_DLP_BIN` (maximum 2048 characters), accepts exactly `--source-id VIDEO_ID`, validates the 11-character YouTube id, invokes the configured binary with the fixed `--ignore-config --no-playlist -f bestaudio[protocol*=m3u8]/bestaudio/best -o -` argv, and writes media to stdout only. The fixed selector prefers audio-only HLS/m3u8 for robust fragment transfer, then falls back to `bestaudio`, then `best`; multilingual and original-language track preferences remain delegated to yt-dlp rather than hardcoded here. This is a format preference, not a claim of full live-stream success. `--ignore-config` makes this owned authorization boundary hermetic: ambient user/system yt-dlp configuration, especially cookie flags, cannot inject options or credentials; operators select a client only through the validated `YT_DLP_PLAYER_CLIENT` environment variable. If `YT_DLP_BIN` is unset or invalid, it fails closed without starting a process. It never evaluates a shell command or accepts a URL/arbitrary downloader arguments. `YT_DLP_PLAYER_CLIENT` is optional: unset or empty keeps the existing argv unchanged; when set, it must be at most 128 characters and match one or more comma-separated lowercase identifiers (`[a-z0-9_]+`). Whitespace, control characters, unsupported separators, assignments, metacharacters, empty list tokens, uppercase, and any other invalid value fail closed with a sanitized exit-2 line before yt-dlp starts. A valid value adds exactly the separate argv entries `--extractor-args` and `youtube:player_client=<value>`; no general extractor-args or cookie input is accepted. The currently observed operator-selected workaround is `YT_DLP_PLAYER_CLIENT=android_vr`, not a permanent default: client availability is externally volatile and must be preflighted before each live run. Rights approvals and `externalTranscriptAnalysisApproved` remain mandatory; no live provider call or media is implied by this documentation.

`maxTranscriptSegments` bounds normalized ASR output independently from `maxChunksPerSource`. The latter remains the analysis-request count in the existing pipeline and additionally caps OpenRouter ASR requests only when chunk mode is selected; neither limit is silently reused as a transcript-segment count.

Endpoint policy is enforced before any fetch: official Google hosts are allowlisted exactly (`www.googleapis.com`, `generativelanguage.googleapis.com`); trusted remote requires explicit HTTPS with no query/userinfo/fragment; HTTP is accepted only for explicitly configured Ollama/vLLM on loopback hosts. Redirects are never followed. Keys are read from validated environment variable names at call time and sent in headers only.

Rights and retention: `automatedPublicVideoAnalysisApproved` authorizes bounded public-URL analysis only; owned audio additionally requires `ownedMediaAudioAccessApproved` (or `ownedMediaAccessApproved`), and remote text analysis requires `externalTranscriptAnalysisApproved`. Raw media, transcripts, cookies, secrets, and raw provider responses are never persisted in `lecture_acquisition` or logs; ephemeral audio leases are deleted in `finally` blocks. The core lecture contracts stay dependency-free TypeScript for future KMP/Android portability; media acquisition, preprocessing, processes, and HTTP remain fullstack-only.

Limitations are explicit: there is no generic public-video downloader; a public URL without authorized audio input remains metadata-only/fail-closed rather than producing fake output. Approval never starts implementation.

### Deterministic evaluation harness

Provider comparisons use the dependency-light API at `@andvl1/omp-workflows-fullstack/lecture-acquisition/eval` (or `src/lecture-acquisition/eval.ts` before publishing). A corpus must be rights-confirmed: use `rightsStatus: "owned-approved"` only for media/transcripts that the project is authorized to evaluate, and record the approval in `rightsNotes`. The shipped `evals/lecture-eval-fixtures.json` is deliberately `synthetic-fixture` text only; it contains no media, URLs, credentials, or provider responses and must not be presented as an owned corpus.

`scoreLectureEvalCase` compares the same bounded reference case and prompt-independent normalized outputs across providers. WER/CER use normalized Levenshtein distance, timestamp alignment uses deterministic one-to-one overlap/boundary matching, and grounded-claim precision/hallucination is an explicitly lexical-plus-timestamp baseline rather than semantic truth. Proposal relevance reports lexical precision/recall/F1 (`n/a` when no reference terms exist), while latency, caller-reported cost, cost per minute, and cleanup status are pass-through run metadata. The returned report includes finite metrics and a bounded aggregate for side-by-side provider/model/route comparison; it makes no unsupported pricing assumptions.

## Slash commands

| Command | Purpose |
| --- | --- |
| `/cto <task>` | Main-session CTO orchestration into parallel teams. |
| `/do-work <task>` | Classification-first profile-driven workflow. |
| `/team <task>` | Compatibility alias for `/do-work`. |
| `/init-team` | Write `.omp/team.config.json` with detected/default stack mappings. |
| `/interview <topic>` | Delegate structured clarification to the analyst. |
| `/omp-model-roles` | Validate model-role configuration or delegate recommendations. |
| `/session-report [do-work|cto] [id=<id>] [--full]` | Generate a self-contained offline HTML snapshot of one workflow session. |

The workflow entry points and `/omp-model-roles` are registered directly by
the extension. `/init-team`, `/interview`, and `/session-report` remain
available through the explicit legacy copier when a disk-discovery runtime is
required; `session_start` never materializes project-local command files on
supported OMP hosts. Most commands return prompts and do not dispatch
subagents directly. `/session-report` is deterministic: it reads persisted
state/artifacts, renders HTML, and writes only under `.work-state`.

## Model roles

Each agent class has a first-choice role followed by a standard fallback in frontmatter (`model: ["@class-role", "@standard-role"]`). Configure the first role when you want a class-specific model; otherwise OMP resolves the standard role.

| Роль | Агенты | Фоллбэк | Пример конфига |
| --- | --- | --- | --- |
| `architect` | `architect` | `@slow` | `architect: anthropic/claude-opus-4-6:high` |
| `reviewer` | `code-reviewer` | `@slow` | `reviewer: openai/gpt-5.4` |
| `security` | `security-tester` | `@slow` | `security: anthropic/claude-sonnet-4-6` |
| `researcher` | `tech-researcher`, `discovery` | `@smol` | `researcher: google/gemini-2.5-flash` |
| `analyst` | `analyst` | `@task` | `analyst: openai/gpt-5-mini` |
| `developer-go` | `developer-go` | `@task` | `developer-go: openai/gpt-5.3-codex` |
| `developer-kotlin` | `developer-kotlin` | `@task` | `developer-kotlin: anthropic/claude-sonnet-4-6` |
| `frontend-developer` | `frontend-developer` | `@task` | `frontend-developer: google/gemini-2.5-pro` |
| `developer-mobile` | `developer-mobile`, `init-mobile` | `@task` | `developer-mobile: anthropic/claude-sonnet-4-6` |
| `devops` | `devops` | `@task` | `devops: openai/gpt-5.3-codex` |
| `diagnostics` | `diagnostics` | `@task` | `diagnostics: anthropic/claude-sonnet-4-6` |
| `manual-qa` | `manual-qa` | `@task` | `manual-qa: openai/gpt-5-mini` |

## Конфигурация моделей ролей

Persisted role assignments use `provider/model[:thinking]`, for example `anthropic/claude-sonnet-4-6:high`.

- Project scope: `.omp/config.yml` under `modelRoles:`.
- Global scope: `~/.omp/agent/config.yml` under `modelRoles:`.
- In the interactive TUI, `/model` without arguments opens the native fullscreen Model Hub. Set `modelRoleStorage` to `project` or `global` to choose where role assignments persist.
- `/switch` (Alt+P) opens the TUI session-only model picker and does not rewrite role assignments. On ACP/text command surfaces, `/model <id>` performs a quick session switch.

Example project configuration:

```yaml
modelRoleStorage: project
modelRoles:
  architect: anthropic/claude-opus-4-6:high
  researcher: google/gemini-2.5-flash
```

Role values are matched against the authenticated model inventory. If a role is missing or cannot resolve, its standard fallback remains available.

## /omp-model-roles

`/omp-model-roles validate` (also the default) reads settings read-only, inspects authenticated models, checks all 17 bundled agent frontmatter files, and prints a bounded table. It never calls `setModelRole` or `setProjectModelRole`, writes `.omp/config.yml`, or edits agent files.

`/omp-model-roles recommendations` returns a closed orchestration contract for the main agent: save the bounded immutable inventory, call `task({agent: 'tech-researcher', outputSchema: ..., schemaMode: 'strict', task: ...})`, extract exactly one JSON object, and apply `validateResearchResponse` against the saved inventory before rendering anything. Invalid/malformed responses, web failures, task errors, and cancellation produce a warning with no recommendation table.

После `/omp-model-roles recommendations` агент выполнит research автоматически. Если он начал делать что-то постороннее — попросите его строго следовать инструкции команды.

Example:

```text
/omp-model-roles validate (3 available models)
role | agents | fallback | status | config-value | source
architect | architect | @slow | fallback (anthropic/claude-opus-4-6) | — | default
researcher | tech-researcher,discovery | @smol | class (google/gemini-2.5-flash) | google/gemini-2.5-flash | project
...
In the interactive TUI, use /model without arguments to assign project/global roles and /switch (Alt+P) for session-only selection. On ACP/text command surfaces, /model <id> quickly switches the session model.
```

## What's inside

- 15 agents (`analyst`, `architect`, `code-reviewer`, `cto`, `developer-{kotlin,go,mobile}`, `devops`, `diagnostics`, `discovery`, `frontend-developer`, `init-mobile`, `manual-qa`, `qa`, `security-tester`, `team-lead`, `tech-researcher`)
- 27 domain skills
- 7 custom-TS slash commands (see above)

## FAQ

**Почему не копии агентов?** Model roles keep one agent definition per class and let the native OMP resolver select models. The superseded PR #12 duplicated agents and created maintenance drift.

**Что если задан `task.agentModelOverrides`?** An explicit `agentModelOverrides` entry has priority over both frontmatter and class roles, matching `structured-subagent.ts` semantics. `/omp-model-roles` reports this as an INFO warning.

**Что если роль написана с опечаткой?** An unknown or unresolved class role is skipped and the standard fallback is tried. If neither selector resolves, the status is `none` and the command reports a warning.

**Как открыть UI ролей и как временно сменить модель?** В interactive TUI `/model` без аргументов открывает native Model Hub для project/global role assignments, а `/switch` (Alt+P) выбирает модель только для текущей сессии. На ACP/text command surfaces `/model <id>` выполняет быстрый session switch.

## Build

```bash
npm run build
npm run typecheck    # includes tsconfig.commands.json
npm test
```

## License

MIT.
