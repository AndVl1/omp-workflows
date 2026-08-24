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
  beginCapability,
  completeDispatch,
  advanceCursor,
  recordCheckpointDecision,
  readAgentMapping,
  resolveClassification,
  handoffWorkflow,
  prepareWorkflow,
  resolveState,
  type DispatchAuth,
  type ModelClassification,
  type HandoffWorkflowInput,
} from "@andvl1/omp-workflows-core";
import { registerWorkflowCommands } from "./workflow-commands.js";
import { ensureCommandsForSession } from "./copy-commands.js";
import { refreshFullstackAgentMappings, waitForFullstackAgentMappings } from "./agent-mapping.js";
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
 * Resolve the session project root for hooks and workflow tools.
 *
 * The session manager is authoritative across resume/switch operations. Some
 * OMP runtimes omit `cwd` from lifecycle/tool contexts, while other versions
 * can leave the copied context value stale after a session move; using the
 * manager first keeps commands and durable transitions on the same worktree.
 * The context and process cwd remain compatibility fallbacks.
 */
export function resolveSessionCwd(ctx: unknown): string | undefined {
	if (!ctx || typeof ctx !== "object") return undefined;
	const objectContext = ctx as { cwd?: unknown; sessionManager?: unknown };
	const manager = objectContext.sessionManager;
	if (manager && typeof manager === "object" && "getCwd" in manager && typeof manager.getCwd === "function") {
		try {
			const sessionCwd = manager.getCwd();
			if (typeof sessionCwd === "string" && sessionCwd.length > 0) return sessionCwd;
		} catch {
			// Fall through to the context/process fallback.
		}
	}
	if (typeof objectContext.cwd === "string" && objectContext.cwd.length > 0) return objectContext.cwd;
	return process.cwd();
}
function summarizeAgentMapping(cwd: string): {
  generated_at: string;
  available_agents: string[];
  fallback_roles: string[];
  unresolved_roles: string[];
} | null {
  const mapping = readAgentMapping(cwd);
  if (!mapping) return null;
  return {
    generated_at: mapping.generated_at,
    available_agents: mapping.available_agents,
    fallback_roles: Object.entries(mapping.diagnostics)
      .filter(([, diagnostic]) => diagnostic.status === "fallback")
      .map(([role]) => role),
    unresolved_roles: mapping.unresolved_roles,
  };
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
  // Older OMP/test runtimes may not expose the schema helper. Keep the
  // extension loadable there; tool registration is available when zod exists.
  if (!pi.zod) return;
  const { z } = pi.zod;
  const emptyParameters = z.object({}) as never;
  type ToolResult = { content: [{ type: "text"; text: string }]; details: unknown };
  const result = (value: unknown): ToolResult => ({
    content: [{ type: "text", text: JSON.stringify(value) }],
    details: value,
  });
  const contextError = (ctx: unknown): ToolResult | null =>
    isMainSessionContext(ctx)
      ? null
      : result({ ok: false, code: "WORKFLOW_CONTEXT_REJECTED", error: "workflow control tools are available only in the main session" });
  const stateSummary = (cwd: string): unknown => {
    const resolved = resolveState(cwd);
    if (resolved.invalid) return { ok: false, code: "WORKFLOW_STATE_INVALID", error: "workflow state path is invalid or unsafe" };
    if (!resolved.state) return { ok: false, code: "WORKFLOW_STATE_UNAVAILABLE", error: "workflow state not found" };
    const state = resolved.state;
    const capability = state.dispatch_capability;
    return {
      ok: true,
      branch: state.branch,
      workflow: state.classification?.workflow,
      stage_cursor: state.stage_cursor,
      cursor_epoch: state.cursor_epoch,
      stages: state.stages,
      pause: state.pause,
      agent_mapping: summarizeAgentMapping(cwd),
      join_summary: state.join_summary,
      capability: capability ? {
        capability_id: capability.capability_id,
        kind: capability.kind,
        status: capability.status,
        expected_roles: capability.expected_roles,
        dispatches: (capability.dispatches ?? []).map((dispatch) => ({
          id: dispatch.id,
          role: dispatch.role,
          agent: dispatch.agent,
          tool_call_id: dispatch.tool_call_id,
          status: dispatch.status,
          completed: Boolean(dispatch.completion),
          completed_by: dispatch.completion?.completed_by,
          artifact_ids: dispatch.completion?.artifact_ids ?? [],
          outcome: dispatch.completion?.outcome,
        })),
      } : null,
    };
  };
  const classificationParameters = z.object({
    type: z.enum(["FEATURE", "REFACTOR", "OPS", "BUG_FIX", "SPEC", "REGRESS", "INVESTIGATION", "LECTURE_RESEARCH", "REVIEW", "HOTFIX"]),
    complexity: z.enum(["QUICK", "MEDIUM", "COMPLEX", "CRITICAL"]),
    confidence: z.enum(["HIGH", "MEDIUM", "LOW"]),
    autonomous: z.boolean(),
    autonomous_reason: z.string().optional(),
    workflow: z.string().optional(),
  });
  pi.registerTool({
    name: "workflow_prepare",
    label: "Prepare workflow state",
    description: "Validate PHASE-0 classification and the active branch, then atomically initialize or reopen feature-scoped workflow state. Main-session only; capability secrets are issued only by workflow_begin.",
    parameters: z.object({
      task: z.string().min(1),
      branch: z.string().min(1),
      classification: classificationParameters.optional(),
      files: z.array(z.string().min(1)).default(() => []),
      issue: z.union([z.number().int(), z.object({ number: z.number().int(), url: z.string().optional() })]).nullable().default(null),
      continuation: z.object({
        feedback: z.string().min(1),
        stageId: z.string().min(1),
      }).optional(),
    }) as never,
    async execute(_id, params, _signal, _update, ctx) {
      const denied = contextError(ctx);
      if (denied) return denied;
      const cwd = resolveSessionCwd(ctx);
      if (!cwd) return result({ ok: false, code: "WORKFLOW_STATE_UNAVAILABLE", error: "workflow cwd unavailable" });
      const input = params as {
        task: string;
        branch: string;
        classification?: ModelClassification;
        files?: string[];
        issue?: number | { number: number; url?: string } | null;
        continuation?: { feedback: string; stageId: string };
      };
      if (!input.continuation && !input.classification) {
        return result({ ok: false, code: "WORKFLOW_PREPARE_REJECTED", error: "new workflow preparation requires a complete classification" });
      }
      try {
        const classification = input.classification && input.classification.workflow === undefined
          ? {
            ...input.classification,
            workflow: resolveClassification({
              task: input.task,
              autonomous: input.classification.autonomous,
              classification: input.classification,
            }).workflow,
          }
          : input.classification;
        const prepared = prepareWorkflow(cwd, {
          task: input.task,
          branch: input.branch,
          classification: classification as ModelClassification,
          files: input.files,
          issue: typeof input.issue === "number" ? { number: input.issue } : input.issue ?? null,
          continuation: input.continuation,
        });
        if (!prepared.ok) {
          return result({ ok: false, code: "WORKFLOW_PREPARE_REJECTED", error: prepared.error, state: prepared.state ? stateSummary(cwd) : undefined });
        }
        return result({
          ok: true,
          transition: "prepare",
          branch: prepared.state.branch,
          classification: prepared.state.classification,
          workflow: prepared.profile.name,
          profile_hash: prepared.state.profile_hash,
          stage_cursor: prepared.state.stage_cursor,
          stages: prepared.state.stages,
          state_path: prepared.statePath,
          artifacts_dir: prepared.artifactsDir,
          feature_slug: prepared.featureSlug,
          continuation: prepared.continuation,
          state: stateSummary(cwd),
        });
      } catch (error) {
        return result({ ok: false, code: "WORKFLOW_PREPARE_FAILED", error: String(error) });
      }
    },
  });
  pi.registerTool({
    name: "workflow_begin",
    label: "Begin workflow stage",
    description: "Issue a durable opaque capability for the current workflow stage.",
    parameters: emptyParameters,
    async execute(_id, _params, _signal, _update, ctx) {
      const denied = contextError(ctx);
      if (denied) return denied;
      const cwd = resolveSessionCwd(ctx);
      if (!cwd) return result({ ok: false, code: "WORKFLOW_STATE_UNAVAILABLE", error: "workflow cwd unavailable" });
      try {
        await waitForFullstackAgentMappings(cwd);
        const transition = beginCapability(cwd);
        if (!transition.ok) return result({ ok: false, code: "WORKFLOW_BEGIN_REJECTED", error: transition.error, state: transition.state ? stateSummary(cwd) : undefined });
        return result({ ok: true, transition: "begin", handoff: transition.handoff, state: stateSummary(cwd) });
      } catch (error) {
        return result({ ok: false, code: "WORKFLOW_BEGIN_FAILED", error: String(error) });
      }
    },
  });
  pi.registerTool({
    name: "workflow_status",
    label: "Workflow status",
    description: "Read the current durable workflow stage and dispatch status.",
    parameters: emptyParameters,
    async execute(_id, _params, _signal, _update, ctx) {
      const denied = contextError(ctx);
      if (denied) return denied;
      const cwd = resolveSessionCwd(ctx);
      return result(cwd ? stateSummary(cwd) : { ok: false, code: "WORKFLOW_STATE_UNAVAILABLE", error: "workflow cwd unavailable" });
    },
  });
  pi.registerTool({
    name: "workflow_instructions",
    label: "Workflow instructions",
    description: "Read the current structured workflow stage contract.",
    parameters: emptyParameters,
    async execute(_id, _params, _signal, _update, ctx) {
      const denied = contextError(ctx);
      if (denied) return denied;
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
    description: "Record durable completion for an authorized workflow dispatch. Copy the compact profile_hash fingerprint exactly from the current workflow handoff; do not abbreviate or reconstruct it.",
    parameters: z.object({
      dispatch_id: z.string().min(1), token: z.string().min(1), capability_id: z.string().min(1),
      run_key: z.string().min(1), branch: z.string().min(1), workflow: z.string().min(1), profile_hash: z.string().min(1), stage_cursor: z.string().min(1), cursor_epoch: z.string().min(1), evidence: z.string().min(1),
      artifact_ids: z.array(z.string().min(1)).default(() => []),
      outcome: z.enum(["succeeded", "failed", "cancelled"]).default("succeeded"),
    }) as never,
    async execute(_id, params, _signal, _update, ctx) {
      const denied = contextError(ctx);
      if (denied) return denied;
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
    name: "workflow_checkpoint",
    label: "Record checkpoint decision",
    description: "Persist a durable decision for a declared stage checkpoint (interactive user answer or autonomous rationale). Unresolved checkpoints block workflow_advance.",
    parameters: z.object({
      token: z.string().min(1), capability_id: z.string().min(1),
      run_key: z.string().min(1), branch: z.string().min(1), workflow: z.string().min(1), profile_hash: z.string().min(1), stage_cursor: z.string().min(1), cursor_epoch: z.string().min(1),
      checkpoint: z.string().min(1), mode: z.enum(["interactive", "autonomous"]), decision: z.string().min(1),
      actor: z.string().default("orchestrator"), rationale: z.string().default(""),
    }) as never,
    async execute(_id, params, _signal, _update, ctx) {
      const denied = contextError(ctx);
      if (denied) return denied;
      const cwd = resolveSessionCwd(ctx);
      if (!cwd) return result({ ok: false, code: "WORKFLOW_STATE_UNAVAILABLE", error: "workflow cwd unavailable" });
      const input = params as DispatchAuth & { checkpoint: string; mode: "interactive" | "autonomous"; decision: string; actor: string; rationale: string };
      try {
        const transition = recordCheckpointDecision(cwd, input);
        return transition.ok ? result({ ok: true, transition: "checkpoint", checkpoint: input.checkpoint, state: stateSummary(cwd) }) : result({ ok: false, code: "WORKFLOW_CHECKPOINT_REJECTED", error: transition.error });
      } catch (error) { return result({ ok: false, code: "WORKFLOW_CHECKPOINT_FAILED", error: String(error) }); }
    },
  });
  pi.registerTool({
    name: "workflow_advance",
    label: "Advance workflow",
    description: "Join the current stage and advance its durable cursor after all dispatches complete.",
    parameters: z.object({ token: z.string().min(1), capability_id: z.string().min(1), run_key: z.string().min(1), branch: z.string().min(1), workflow: z.string().min(1), profile_hash: z.string().min(1), stage_cursor: z.string().min(1), cursor_epoch: z.string().min(1), evidence: z.string().min(1) }) as never,
    async execute(_id, params, _signal, _update, ctx) {
      const denied = contextError(ctx);
      if (denied) return denied;
      const cwd = resolveSessionCwd(ctx);
      if (!cwd) return result({ ok: false, code: "WORKFLOW_STATE_UNAVAILABLE", error: "workflow cwd unavailable" });
      const input = params as DispatchAuth & { evidence: string };
      try {
        const transition = advanceCursor(cwd, input);
        return transition.ok ? result({ ok: true, transition: "advance", stage_cursor: transition.state.stage_cursor, cursor_epoch: transition.state.cursor_epoch, handoff: transition.handoff, state: stateSummary(cwd) }) : result({ ok: false, code: "WORKFLOW_ADVANCE_REJECTED", error: transition.error });
      } catch (error) { return result({ ok: false, code: "WORKFLOW_ADVANCE_FAILED", error: String(error) }); }
    },
  });
  pi.registerTool({
    name: "workflow_handoff",
    label: "Handoff workflow",
    description: "Transfer an approved completed workflow stage to another registered workflow profile through the engine's typed route catalogue. Main-session only; requires explicit typed approval evidence and returns a fresh one-time target capability. Only `enabled` catalogue routes complete; `conditional` routes are rejected deterministically (route metadata and missing evidence/materialization adapters are returned) until their adapter exists; `unsupported` and unknown targets are denied.",
    parameters: z.object({
      token: z.string().min(1), capability_id: z.string().min(1),
      run_key: z.string().min(1), branch: z.string().min(1), workflow: z.string().min(1), profile_hash: z.string().min(1), stage_cursor: z.string().min(1), cursor_epoch: z.string().min(1),
      target_workflow: z.string().min(1),
      target_profile_hash: z.string().min(1).optional(),
      approval: z.object({
        kind: z.enum(["checkpoint", "artifact"]),
        ref: z.string().min(1),
        source_stage: z.string().min(1),
        decision: z.literal("approved"),
      }),
      actor: z.string().default("orchestrator"),
      handoff_context: z.object({
        artifact_ids: z.array(z.string().min(1)).default(() => []),
        decision_refs: z.array(z.string().min(1)).default(() => []),
        summary: z.string().default(""),
      }).default(() => ({ artifact_ids: [], decision_refs: [], summary: "" })),
    }) as never,
    async execute(_id, params, _signal, _update, ctx) {
      const denied = contextError(ctx);
      if (denied) return denied;
      const cwd = resolveSessionCwd(ctx);
      if (!cwd) return result({ ok: false, code: "WORKFLOW_STATE_UNAVAILABLE", error: "workflow cwd unavailable" });
      const input = params as HandoffWorkflowInput;
      try {
        const transition = handoffWorkflow(cwd, input);
        if (!transition.ok) return result({ ok: false, code: "WORKFLOW_HANDOFF_REJECTED", error: transition.error, route: transition.route, state: transition.state ? stateSummary(cwd) : undefined });
        return result({ ok: true, transition: "handoff", route: transition.route, handoff: transition.handoff, audit: transition.audit, state: stateSummary(cwd) });
      } catch (error) { return result({ ok: false, code: "WORKFLOW_HANDOFF_FAILED", error: String(error) }); }
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
    if (isMainSessionContext(ctx)) {
      void refreshFullstackAgentMappings(cwd).catch(() => undefined);
    }
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
