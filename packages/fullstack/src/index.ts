/**
 * @andvl1/omp-workflows-fullstack — default omp-workflows bundle.
 *
 * Registers the workflow engine (gates + role mapping) with OMP and
 * auto-bootstraps the shipped custom-TS slash commands into the active
 * project's `.omp/commands/` directory on every session start.
 *
 * Also wires the live subagent-tree widget (see `subagent-tree.ts`) and
 * exposes a `/subagents` toggle command.
 *
 * For a custom bundle (e.g. Rust, Go-only, or any non-fullstack stack),
 * write your own package that calls `registerTeamWorkflow(pi, { roles: ..., ... })`
 * with your own role mapping. Do not depend on this package.
 */

import type {
  ExtensionAPI,
  ExtensionUIContext,
  BeforeAgentStartEvent,
  BeforeAgentStartEventResult,
  SessionStartEvent,
} from "@oh-my-pi/pi-coding-agent";
import {
  defaultFullstackFlags,
  defaultFullstackModelRoles,
  defaultFullstackRoles,
  defaultFullstackScopeMap,
  findActiveCtoRun,
  registerTeamWorkflow,
  completeDispatch,
  advanceCursor,
  type DispatchAuth,
} from "@andvl1/omp-workflows-core";
import { registerWorkflowCommands } from "./workflow-commands.js";
import { ensureCommandsForSession } from "./copy-commands.js";
import { createChannelSet, queueCtoDelivery, startChannelDispatcher, type InboxTask } from "./adapters/registry.js";
import { createAskRedirectGate } from "./messenger-channel.js";
import { createCtoModeReminderHandler } from "./cto-mode-reminder.js";
import {
	RESEARCH_REQUEST_MARKER_END,
	RESEARCH_REQUEST_MARKER_START,
	buildResearchRequestDeveloperInstruction,
} from "./before-agent-start-marker.js";
import { resolveWorkflowContract } from "@andvl1/omp-workflows-core";
import {
	handleSubagentsCommand,
	registerSubagentTree,
	type SubagentTreeController,
} from "./subagent-tree.js";
// Auto-derived from core taxonomy; test-invariант в test/omp-model-roles.test.ts:439-446 ловит drift.
const ROLE_COUNT = defaultFullstackModelRoles.length;

/**
 * Resolve the `session_start` context to a usable cwd string. An explicit
 * non-empty `ctx.cwd` always wins. OMP 17.2.10 emits `session_start` without
 * a `cwd` field on the context object, so we fall back to `process.cwd()` —
 * the directory the OMP session was launched from — instead of silently
 * skipping dispatcher/command-copy startup (no `.omp/cto-dispatcher.lock`
 * appeared until a probe used `process.cwd()`). The extension API exposes
 * ExtensionContext.cwd at runtime but the bundled .d.ts lacks a typed
 * overload for this hook, so we hand-narrow at the boundary instead of an
 * unchecked cast. Non-object contexts (unknown/legacy hook invocations)
 * still resolve to undefined.
 */
export function resolveSessionCwd(ctx: unknown): string | undefined {
	if (!ctx || typeof ctx !== "object") return undefined;
	const candidate = "cwd" in ctx ? ctx.cwd : undefined;
	if (typeof candidate === "string" && candidate.length > 0) return candidate;
	return process.cwd();
}

/**
 * Extract the ExtensionUIContext from a session_start ctx. The OMP
 * extension API exposes `ui` on context objects at runtime but the bundled
 * `.d.ts` narrows session_start ctx to a subset; hand-narrow at the
 * boundary instead of an unchecked cast.
 */
function extractUiFromContext(ctx: unknown): ExtensionUIContext | undefined {
	if (!ctx || typeof ctx !== "object") return undefined;
	if (!("ui" in ctx)) return undefined;
	const candidate = (ctx as { ui: unknown }).ui;
	return candidate && typeof candidate === "object" ? (candidate as ExtensionUIContext) : undefined;
}

/**
 * `before_agent_start` hook: detect the marker envelope produced by the
 * `/omp-model-roles recommendations` custom command and inject an
 * `agent`-attributed developer message so the main LLM treats the four
 * hard steps as developer-priority. The marker is opaque to OMP — see
 * `before-agent-start-marker.ts` for the contract.
 */
function beforeAgentStartMarkerHandler(
	event: BeforeAgentStartEvent,
): BeforeAgentStartEventResult | undefined {
	if (typeof event?.prompt !== "string") return undefined;
	// Marker envelope guard: both start and end markers must be present.
	// A truncated envelope (START without END) would still inject the
	// developer instruction and promise the LLM a payload it can never
	// extract, so we bail with `undefined` and let the regular prompt
	// path handle it. The end marker is exported from the marker module
	// next to the start marker.
	if (!event.prompt.includes(RESEARCH_REQUEST_MARKER_START)) return undefined;
	if (!event.prompt.includes(RESEARCH_REQUEST_MARKER_END)) return undefined;
	return {
		message: {
			customType: "omp-model-roles-research-instructions",
			content: buildResearchRequestDeveloperInstruction(ROLE_COUNT),
			display: true,
			// `details` carries the marker contract advertised to recipients
			// (custom UI, downstream tooling). It mirrors the top-level
			// fields of the in-payload `ResearchRequest` (see
			// `@andvl1/omp-workflows-core` model-roles module and
			// `buildResearchPrompt`) without re-parsing the prompt: the
			// full inventory lives inside the marker payload and is
			// duplicated here only as a count.
			details: {
				kind: "omp-model-role-research-request",
				schemaVersion: 1,
				requestedAt: new Date().toISOString(),
				roleCount: ROLE_COUNT,
				// `modelCount` is intentionally `null`: counting requires
				// parsing the embedded JSON payload, which we deliberately
				// avoid in the hook (re-parse + re-validate of a payload
				// the LLM already sees). Receivers that need the actual
				// list must read it from the payload, keeping the two
				// in sync.
				modelCount: null,
			},
			attribution: "agent",
		},
	};
}

/**
 * Per-session subagent-tree controller. Filled by session_start; consumed by
 * the `/subagents` command handler. Ref pattern keeps the handler registered
 * once at extension load while the controller is bound at session start.
 */
const subagentTreeRef: { current: SubagentTreeController | null } = { current: null };
/** One dispatcher per interactive main session/cwd; subagents must not poll Telegram. */
const dispatcherStopsByCwd = new Map<string, () => void>();

/**
 * Task subagents run with `hasUI: false` and load the same extension. Only the
 * interactive main session may own the product messenger dispatcher; otherwise
 * every lead/worker creates another getUpdates consumer with its own offset.
 * Unknown contexts are treated as main for compatibility with older OMP/test
 * runtimes that did not expose `hasUI` on session_start.
 */
export function isMainSessionContext(ctx: unknown): boolean {
	if (!ctx || typeof ctx !== "object") return true;
	if (!("hasUI" in ctx)) return true;
	return ctx.hasUI !== false;
}


export function registerWorkflowTools(pi: ExtensionAPI): void {
  const { z } = pi.zod;
  type ToolResult = { content: [{ type: "text"; text: string }]; details: unknown };
  const result = (value: unknown): ToolResult => ({
    content: [{ type: "text", text: JSON.stringify(value) }],
    details: value,
  });
  const emptyParameters = z.object({}) as never;
  pi.registerTool({
    name: "workflow_instructions",
    label: "Workflow instructions",
    description: "Read the current structured workflow stage contract.",
    parameters: emptyParameters,
    async execute(_id, _params, _signal, _update, ctx) {
      try {
        const contract = resolveWorkflowContract(resolveSessionCwd(ctx) ?? process.cwd());
        return result(contract);
      } catch (error) {
        return result({ ok: false, code: "WORKFLOW_RESOLUTION_FAILED", error: String(error) });
      }
    },
  });
  pi.registerTool({
    name: "workflow_complete",
    label: "Complete workflow dispatch",
    description: "Record durable completion for an authorized workflow dispatch.",
    parameters: z.object({
      dispatch_id: z.string().min(1), token: z.string().min(1), capability_id: z.string().min(1),
      run_key: z.string().min(1), cursor_epoch: z.string().min(1), evidence: z.string().min(1),
      artifact_ids: z.array(z.string().min(1)).default([]),
      outcome: z.enum(["succeeded", "failed", "cancelled"]).default("succeeded"),
    }) as never,
    async execute(_id, params, _signal, _update, ctx) {
      const cwd = resolveSessionCwd(ctx);
      if (!cwd) return result({ ok: false, code: "WORKFLOW_STATE_UNAVAILABLE", error: "workflow cwd unavailable" });
      const input = params as DispatchAuth & { dispatch_id: string; evidence: string; artifact_ids?: string[]; outcome: "succeeded" | "failed" | "cancelled" };
      try {
        const transition = completeDispatch(cwd, { ...input, completed_by: "workflow_complete" });
        return transition.ok ? result({ ok: true, transition: "complete", dispatch_id: input.dispatch_id, state: transition.state, record: transition.record }) : result({ ok: false, code: "WORKFLOW_COMPLETE_REJECTED", error: transition.error, dispatch_id: input.dispatch_id });
      } catch (error) { return result({ ok: false, code: "WORKFLOW_COMPLETE_FAILED", error: String(error), dispatch_id: input.dispatch_id }); }
    },
  });
  pi.registerTool({
    name: "workflow_advance",
    label: "Advance workflow",
    description: "Join the current stage and advance its durable cursor after all dispatches complete.",
    parameters: z.object({ token: z.string().min(1), capability_id: z.string().min(1), run_key: z.string().min(1), cursor_epoch: z.string().min(1), evidence: z.string().min(1) }) as never,
    async execute(_id, params, _signal, _update, ctx) {
      const cwd = resolveSessionCwd(ctx);
      if (!cwd) return result({ ok: false, code: "WORKFLOW_STATE_UNAVAILABLE", error: "workflow cwd unavailable" });
      const input = params as { token: string; capability_id: string; run_key: string; cursor_epoch: string; evidence: string };
      try {
        const transition = advanceCursor(cwd, input);
        return transition.ok ? result({ ok: true, transition: "advance", stage_cursor: transition.state.stage_cursor, cursor_epoch: transition.state.cursor_epoch, state: transition.state }) : result({ ok: false, code: "WORKFLOW_ADVANCE_REJECTED", error: transition.error });
      } catch (error) { return result({ ok: false, code: "WORKFLOW_ADVANCE_FAILED", error: String(error) }); }
    },
  });
}

export default function ompWorkflowsFullstack(pi: ExtensionAPI): void {
  registerTeamWorkflow(pi, {
    label: "omp-workflows-fullstack",
    roles: defaultFullstackRoles,
    scopeMap: defaultFullstackScopeMap,
    flags: defaultFullstackFlags,
  });
  registerWorkflowTools(pi);
  // Register the three workflow entry points while the extension is loaded.
  // OMP snapshots registered commands before it discovers project-local
  // `.omp/commands` files, so this keeps slash suggestions and execution
  // authoritative even when a copied file is stale or cannot resolve the
  // plugin's peer dependency from the consumer cwd.
  registerWorkflowCommands(pi);

  // Marker detector for `/omp-model-roles recommendations` — fires before
  // each agent loop and injects a developer-attributed instruction when
  // the custom command's return value carries the marker envelope.
  pi.on("before_agent_start", beforeAgentStartMarkerHandler);

  // CTO-mode reminder — fires before EVERY LLM call. While a CTO run is
  // active (.work-state/cto/), prepend a short steering message restating
  // the delegation contract (orchestrator -> teams, lead -> workers,
  // worker -> escalate up). Keeps the discipline in front of the model on
  // every turn of long autonomous runs (and after compaction), for the
  // main session and subagents. See cto-mode-reminder.ts.
  pi.on("context", createCtoModeReminderHandler());

  // Messenger-mode `ask` redirect: while a bidirectional channel (telegram)
  // AND an active CTO run exist, block the interactive `ask` tool so ALL
  // user communication goes through the messenger (outbox -> answers/).
  pi.on("tool_call", createAskRedirectGate());

  // `/subagents` — toggle / mode / clear for the live subagent-tree widget.
  // The controller is created lazily; if no session_start has run yet
  // the command reports a friendly "no active session" message.
  pi.registerCommand("subagents", {
    description: "Toggle the live subagent-tree widget (on/off/toggle/verbose/compact/clear/status)",
    handler: (args, ctx): Promise<void> => {
      const controller = subagentTreeRef.current;
      if (!controller) {
        ctx.ui.notify("subagent-tree: no active session yet", "info");
        return Promise.resolve();
      }
      const message = handleSubagentsCommand(controller, controller.cwd, ctx.ui, args);
      ctx.ui.notify(message, "info");
      return Promise.resolve();
    },
  });
  // Keep the project-local command tree synchronized for runtimes that still
  // discover custom-TS commands from disk. The authoritative commands were
  // registered above, before OMP snapshots slash suggestions; this copy is a
  // compatibility fallback and a cache for older runtimes.
  //
  // Best-effort, never throws: any IO error is captured by
  // `ensureCommandsForSession` and dropped.
  pi.on("session_start", (_event: SessionStartEvent, ctx: unknown) => {
    const cwd = resolveSessionCwd(ctx);
    if (!cwd) return;
    ensureCommandsForSession(cwd);
    // Subagent-tree live widget — bound to the cwd of the active session.
    // The controller replays from <cwd>/.omp/subagent-tree.json so the
    // previous view state (on/off + verbose/compact) survives restarts.
    const ui = extractUiFromContext(ctx);
    if (ui) subagentTreeRef.current = registerSubagentTree(pi, ui, cwd);
    // CTO escalation dispatcher: only the interactive main session may own
    // inbound polling. Task subagents also emit session_start, but starting a
    // dispatcher there creates another getUpdates consumer with offset=0.
    if (!isMainSessionContext(ctx)) return;
    dispatcherStopsByCwd.get(cwd)?.();
    dispatcherStopsByCwd.delete(cwd);
    // Profile-aware channel set (core capability-validated normalization):
    // the RW primary is the only adapter wired/polled for inbound; RO sinks
    // are outbound report sinks only.
    const channelSet = createChannelSet(cwd);
    if (channelSet.profiles.length === 0) return;
    // Online ACK: with a validated RW primary AND an active resident run,
    // queue a durable online-ack delivery BEFORE the dispatcher starts —
    // its immediate first tick drains it. No active run -> no ACK (standby
    // creation belongs to /cto, not the dispatcher).
    if (channelSet.profile.direction === "rw") {
      const active = findActiveCtoRun(cwd);
      if (active) {
        queueCtoDelivery(cwd, active.runId, {
          id: `${active.runId}/system/ack/${Date.now()}`,
          level: "question",
          title: "CTO online",
          body: `resident run ${active.runId} standby — awaiting tasks (wave admission + outbox delivery active)`,
          intent: "ack",
          target: channelSet.profile.ackTarget,
        });
      }
    }
    const stopDispatcher = startChannelDispatcher(cwd, channelSet, 10_000, {
      // Wake the CTO session on an inbound task: idle starts a turn,
      // streaming queues as steer. The [CTO-INBOX] envelope is the
      // contract the standby/CTO prompt tells the agent to fold in; the
      // wave id is included when wave admission succeeded.
      onTask: (task: InboxTask) => {
        const wave = task.waveId ? ` (wave ${task.waveId})` : "";
        pi.sendUserMessage(
          `[CTO-INBOX] New task via messenger (run \`${task.runId ?? "?"}\`)${wave}:\n${task.text}\n\n` +
            "Treat this as a /cto task — fold it into the active run (amend discipline: re-plan, " +
            "spawn leads in parallel, integration covers ALL teams).",
        );
      },
      // Wake on a user-initiated answer (reply / button) so the agent
      // reacts without waiting for the next checkpoint poll.
      onAnswer: (answer) => {
        pi.sendUserMessage(
          `[CTO-ANSWER] User answered escalation \`${answer.id}\` with: ${answer.answer}\n\n` +
            `Read \`.work-state/cto/${answer.id.split("/")[0] ?? "?"}/answers/${answer.id.replace(/[^a-zA-Z0-9-_]/g, "-")}.json\` ` +
            "and apply it now if the waiting team is still parked; otherwise treat it as advisory.",
        );
      },
    });
    dispatcherStopsByCwd.set(cwd, stopDispatcher);
  });
  pi.on("session_shutdown", (_event: unknown, ctx: unknown) => {
    if (!isMainSessionContext(ctx)) return;
    const cwd = resolveSessionCwd(ctx);
    if (!cwd) return;
    dispatcherStopsByCwd.get(cwd)?.();
    dispatcherStopsByCwd.delete(cwd);
  });
}

// ── cto-safety (br-zps.4, br-zps.5, br-zps.6) ──
export { MockEscalationAdapter, registerMockAdapter } from "./adapters/mock.js";
