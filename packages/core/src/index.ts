/**
 * @andvl1/omp-workflows-core — public API surface.
 *
 * Workflow engine: 7 slash commands, 4 event handlers, 8 declarative
 * JSON profiles, typed artifact schemas, state machine, role/scope
 * resolution, DoD lifecycle, plus runtime observability (event log +
 * rollup). No agents, no skills — bundles ship those.
 *
 * Example minimal bundle:
 *
 *   import { registerTeamWorkflow } from "@andvl1/omp-workflows-core";
 *   export default function (pi: ExtensionAPI) {
 *     registerTeamWorkflow(pi, {
 *       label: "omp-workflows-custom",
 *       roles: { developer: "developer" },
 *     });
 *   }
 */

import { createHash } from "node:crypto";
import { existsSync, realpathSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { orchestratorWriteGate, workerWriteScopeGate } from "./gates/orchestrator-write.js";
import { dispatchGate, trustedDispatchRequests } from "./gates/dispatch.js";
import type { ExtensionAPI, BeforeAgentStartEvent, SessionStopEvent, ToolCallEvent, ToolResultEvent } from "@oh-my-pi/pi-coding-agent";
import { classificationGate, classificationToolGate } from "./gates/classification.js";
import { monotonicGate } from "./gates/monotonic.js";
import { dodBackstop } from "./gates/dod-backstop.js";
import { safetyGuard } from "./gates/safety.js";
import { ctoNestingGuard } from "./gates/cto-nesting.js";
import { outboxEnforcementGate } from "./gates/outbox.js";
import { ctoSliceTaskGate } from "./cto/slice-gate.js";
import { registerObservabilityHooks, recordToolCallAttempt } from "./observability/index.js";
import { authorizeDispatchTrusted, reconcileTrustedTaskResult, beginCapability, completeDispatch, advanceCursor, recordCheckpointDecision, validateCheckpointAsk, commitCheckpointAnswer, hashDispatchSecret } from "./engine/durable.js";
import { loadProfile, registerWorkflowProfiles } from "./engine/profile.js";
import { prepareWorkflowState, type ModelClassification, type WorkflowPrepareOptions } from "./engine/run.js";
import { resolveActiveBranch, resolveState } from "./engine/state.js";
import { findCurrentCheckpointDecision } from "./engine/checkpoints.js";
import { resolveWorkflowContract } from "./engine/workflow-contract.js";
import { resolveRuntimeConfigPath, writeConfig } from "./runtime-config.js";
import type { Profile, RoleConfig, CheckpointRuleKind, CheckpointAnswerProof } from "./engine/types.js";
import type { WorkerWriteScope } from "./gates/orchestrator-write.js";
import type { ScopeRuntimeClassTable } from "./engine/scope.js";
import type { DispatchAuth, RosterBeginSelection } from "./engine/durable.js";
import type { AgentMappingState } from "./engine/agent-mapping.js";
export type WorkflowCapability = "workflow_registration" | "workflow_tools" | "config_writer";

export type WorkflowOwnerKind = "fullstack" | "private_omp" | (string & {});

export interface WorkflowOwnerProvenance {
  package: string;
  entrypoint: string;
  cwd: string;
  config_path?: string;
}

export interface WorkflowOwnerIdentity {
  owner_id: string;
  bundle_id: string;
  owner_kind: WorkflowOwnerKind;
  activation_marker: string;
  host_range: string;
  provenance: WorkflowOwnerProvenance;
}

export interface WorkflowOwnerClaim {
  project_root: string;
  capability: WorkflowCapability;
  fingerprint: string;
  owner: WorkflowOwnerIdentity;
}

export type WorkflowOwnerClaimResult =
  | { ok: true; claim: WorkflowOwnerClaim; idempotent: boolean }
  | { ok: false; code: "owner_invalid" | "owner_conflict"; error: string; claim?: WorkflowOwnerClaim };

export type WorkflowOwnerSource =
  | WorkflowOwnerIdentity
  | ((projectRoot: string) => WorkflowOwnerIdentity);

const workflowOwners = new Map<string, Map<WorkflowCapability, WorkflowOwnerClaim>>();

/**
 * Match the cwd identity used by config and mapping readers: an existing
 * project/worktree is keyed by its physical path, while a not-yet-created
 * root keeps its resolved lexical path until it exists.
 */
function canonicalProjectRoot(projectRoot: string): string {
  const resolved = resolve(projectRoot);
  return existsSync(resolved) ? realpathSync(resolved) : resolved;
}

/**
 * Config paths are derived from the canonical project root even when the
 * `.omp` directory or config file does not exist yet. This keeps owner
 * provenance stable across a symlink alias during eager registration.
 */
function canonicalConfigPath(configPath: string): string {
  const resolved = resolve(configPath);
  if (basename(resolved) !== "team.config.json" || basename(dirname(resolved)) !== ".omp") return resolved;
  return join(canonicalProjectRoot(dirname(dirname(resolved))), ".omp", "team.config.json");
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, entry]) => [key, canonicalize(entry)]));
  }
  return value;
}

function ownerFingerprint(owner: WorkflowOwnerIdentity): string {
  return createHash("sha256").update(JSON.stringify(canonicalize(owner))).digest("hex");
}

function invalidOwner(root: string, owner: WorkflowOwnerIdentity): string | null {
  const required = [
    ["owner_id", owner.owner_id],
    ["bundle_id", owner.bundle_id],
    ["owner_kind", owner.owner_kind],
    ["activation_marker", owner.activation_marker],
    ["host_range", owner.host_range],
    ["provenance.package", owner.provenance?.package],
    ["provenance.entrypoint", owner.provenance?.entrypoint],
    ["provenance.cwd", owner.provenance?.cwd],
  ] as const;
  const missing = required.find(([, value]) => typeof value !== "string" || value.trim().length === 0);
  if (missing) return `${missing[0]} is required`;
  if (canonicalProjectRoot(owner.provenance.cwd) !== root) return "owner provenance cwd does not match project root";
  if (owner.provenance.config_path && canonicalConfigPath(owner.provenance.config_path) !== join(root, ".omp", "team.config.json")) {
    return "owner provenance config_path does not belong to project root";
  }
  return null;
}

function normalizeOwner(owner: WorkflowOwnerIdentity): WorkflowOwnerIdentity {
  const provenance: WorkflowOwnerProvenance = {
    ...owner.provenance,
    cwd: canonicalProjectRoot(owner.provenance.cwd),
  };
  if (owner.provenance.config_path) provenance.config_path = canonicalConfigPath(owner.provenance.config_path);
  return { ...owner, provenance };
}

/**
 * Atomically claim one or more generic workflow capabilities for a bundle.
 * The registry is keyed by the canonical physical project/worktree root.
 * A repeated claim with the same fingerprint is idempotent; any differing
 * owner fails before the registry is mutated.
 */
export function claimWorkflowOwners(
  projectRoot: string,
  capabilities: readonly WorkflowCapability[],
  owner: WorkflowOwnerIdentity,
): WorkflowOwnerClaimResult {
  const root = canonicalProjectRoot(projectRoot);
  const invalid = invalidOwner(root, owner);
  if (invalid) return { ok: false, code: "owner_invalid", error: invalid };
  const normalizedOwner = normalizeOwner(owner);
  const fingerprint = ownerFingerprint(normalizedOwner);
  const requested = [...new Set(capabilities)];
  const existing = workflowOwners.get(root);
  for (const capability of requested) {
    const prior = existing?.get(capability);
    if (prior && prior.fingerprint !== fingerprint) {
      return {
        ok: false,
        code: "owner_conflict",
        error: `generic workflow capability '${capability}' is already owned by '${prior.owner.owner_id}'`,
        claim: prior,
      };
    }
  }
  const registry = existing ?? new Map<WorkflowCapability, WorkflowOwnerClaim>();
  let idempotent = true;
  for (const capability of requested) {
    if (!registry.has(capability)) {
      idempotent = false;
      registry.set(capability, { project_root: root, capability, fingerprint, owner: structuredClone(normalizedOwner) });
    }
  }
  if (!existing) workflowOwners.set(root, registry);
  const first = requested[0];
  const claim = first ? registry.get(first) : undefined;
  if (!claim) return { ok: false, code: "owner_invalid", error: "at least one workflow capability is required" };
  return { ok: true, claim, idempotent };
}

export function claimWorkflowOwner(
  projectRoot: string,
  capability: WorkflowCapability,
  owner: WorkflowOwnerIdentity,
): WorkflowOwnerClaimResult {
  return claimWorkflowOwners(projectRoot, [capability], owner);
}

/** Read-only diagnostic used by host adapters and focused owner tests. */
export function workflowOwnerFor(projectRoot: string, capability: WorkflowCapability): WorkflowOwnerClaim | undefined {
  return workflowOwners.get(canonicalProjectRoot(projectRoot))?.get(capability);
}

/** Clear only the in-memory registry; intended for isolated host/test lifecycles. */
export function resetWorkflowOwners(projectRoot?: string): void {
  if (projectRoot === undefined) workflowOwners.clear();
  else workflowOwners.delete(canonicalProjectRoot(projectRoot));
}

export interface RegisterOptions {
  label?: string;
  roles?: RoleConfig["roles"];
  rosterOverrides?: RoleConfig["roster_overrides"];
  scopeMap?: RoleConfig["scope_map"];
  flags?: RoleConfig["flags"];
  /** Caller-supplied scope → runtime classification table (no core defaults exist). */
  scopeRuntimeClasses?: ScopeRuntimeClassTable;
  /** Caller-supplied scope → UI marker table (no core defaults exist). */
  scopeUiClasses?: ScopeRuntimeClassTable;
  designSystem?: string | null;
  workflowProfiles?: Profile[];
  observability?: boolean;
  /** Explicit project/worktree root for eager owner/config registration. */
  cwd?: string;
  /** Session-aware cwd resolver; no process cwd fallback is used when supplied. */
  resolveCwd?: (ctx: unknown) => string | undefined;
  owner?: WorkflowOwnerSource;
  /**
   * Bounded write_scope experiment: when enabled, worker source writes are
   * narrowed to the declared scope after the orchestrator gate. Off by
   * default — shipped workflows keep the single-writer model.
   */
  writeScope?: WorkerWriteScope;
}

export type CommandId = "do-work" | "team" | "cto" | "init-team" | "interview" | "omp-model-roles";

export interface WorkflowToolAdapterOptions {
  cwd?: string;
  resolveCwd?: (ctx: unknown) => string | undefined;
  owner?: WorkflowOwnerSource;
  /**
   * Legacy per-call main-session classifier, consulted only when no
   * session_start host profile was captured (older OMP runtimes and direct
   * tool harnesses). With a captured profile, session ownership is decided
   * authoritatively from the host mode: trusted interactive sessions
   * (terminal TUI or connected RPC client) own the workflow tools; print,
   * json and Task subagent sessions never do. Per-call tool contexts
   * cannot make this decision — plain-rpc main sessions deliberately
   * report hasUI=false on them.
   */
  isMainSession?: (ctx: unknown) => boolean;
  /**
   * Optional trusted live agent-mapping handoff, invoked fresh for EVERY
   * agent-resolving transition (each workflow_begin and each
   * workflow_advance) with that transition's exact current cwd — never a
   * cached mapping from another transition or project. When the callback
   * resolves with a well-formed `AgentMappingState`, the transition consumes
   * it in memory for role availability and the persisted workspace mapping
   * file is never consulted. Only an explicit `undefined` keeps the
   * persisted mapping fallback; runtime null or any other malformed value
   * fails the transition closed. Discovery failures must throw so the
   * transition fails closed.
   */
  beforeBegin?: (cwd: string) => void | AgentMappingState | undefined | Promise<void | AgentMappingState | undefined>;
  mappingSummary?: (cwd: string) => unknown;
}

export interface WorkflowToolAdapter {
  readonly capabilities: readonly ["workflow_tools"];
  register(pi: ExtensionAPI): void;
}

// ── Generic model-role contracts (bundle taxonomy is intentionally absent) ──
export {
  resolveRoleChain,
  isResearchRequest,
  isResearchResponse,
  validateResearchRequest,
  validateResearchResponse,
} from "./model-roles.js";
export type {
  ModelRoleEntry,
  ModelRoleTaxonomy,
  ModelRolePreset,
  InventoryModel,
  RoleLookup,
  RoleResolution,
  RoleResolutionStatus,
  ResearchRequest,
  ResearchResponse,
  BenchmarkSource,
  ResearchRecommendation,
} from "./model-roles.js";

/**
 * Wire the engine into omp's ExtensionAPI. Bundles call this from their
 * default export. The engine consults `.omp/team.config.json` (or the
 * `roles`/`scopeMap` overrides) at runtime to resolve workflow roles to agents.
 *
 * Extension-side responsibilities:
 * - Register gates (classification, monotonic, dod-backstop, safety).
 * - Write runtime config (roles, scope, flags) for custom-TS commands.
 * - Register observability hooks (event log + rollup in `.work-state/features/<slug>/observability/`).
 *
 * Slash commands are NOT registered here. Since OMP 17.x, the `task` tool
 * lives on the main agent only — `ExtensionCommandContext` exposes no
 * subagent-dispatch affordance. Workflow commands ship as OMP custom-TS
 * commands in `packages/fullstack/commands/<name>/index.ts`; they receive
 * a `HookCommandContext` that can read `cwd`, `ui`, `sessionManager`, and
 * `modelRegistry`, and rely on `ctx.sendUserMessage(prompt)` to hand the
 * profile-driven workflow to the main agent's own `task` tool.
 */
function resolveCwdFromContext(ctx: unknown): string | undefined {
  if (!ctx || typeof ctx !== "object") return undefined;
  const value = ctx as { cwd?: unknown; sessionManager?: unknown };
  const manager = value.sessionManager;
  if (manager && typeof manager === "object" && "getCwd" in manager && typeof manager.getCwd === "function") {
    try {
      const cwd = manager.getCwd();
      if (typeof cwd === "string" && cwd.length > 0) return cwd;
    } catch {
      // Fall through to the context cwd.
    }
  }
  return typeof value.cwd === "string" && value.cwd.length > 0 ? value.cwd : undefined;
}

function ownerAtCwd(source: WorkflowOwnerSource, cwd: string): WorkflowOwnerIdentity {
  return typeof source === "function" ? source(canonicalProjectRoot(cwd)) : source;
}

function assertOwner(
  cwd: string,
  capabilities: readonly WorkflowCapability[],
  source: WorkflowOwnerSource | undefined,
): void {
  if (!source) return;
  const result = claimWorkflowOwners(cwd, capabilities, ownerAtCwd(source, cwd));
  if (!result.ok) throw new Error(`${result.code}: ${result.error}`);
}

/**
 * Write caller-supplied runtime configuration against an explicit session
 * cwd. Core never substitutes a fullstack preset and never falls back to the
 * process cwd when this seam is invoked without a known session root.
 */
export function writeRuntimeConfig(opts: RegisterOptions, cwd = opts.cwd): string | null {
  const hasOverride = Boolean(
    opts.roles
    || opts.scopeMap
    || opts.flags
    || opts.rosterOverrides
    || opts.scopeRuntimeClasses
    || opts.scopeUiClasses
    || opts.designSystem !== undefined,
  );
  if (!hasOverride || !cwd) return null;
  assertOwner(cwd, ["config_writer"], opts.owner);
  const path = resolveRuntimeConfigPath(cwd);
  if (!path) return null;
  // Seed-if-absent only. The session seed must never overwrite an existing
  // config: users and /init-team own the file content after the first
  // creation, and a per-session preset merge would silently revert every
  // customization (roles, scope_map) on each omp restart.
  if (existsSync(path)) return path;
  writeConfig(path, {
    roles: opts.roles ?? {},
    roster_overrides: opts.rosterOverrides ?? {},
    scope_map: opts.scopeMap ?? [],
    flags: opts.flags ?? {},
    scope_runtime_classes: opts.scopeRuntimeClasses ?? {},
    scope_ui_classes: opts.scopeUiClasses ?? {},
    design_system: opts.designSystem ?? null,
  });
  return path;
}

/**
 * Wire the generic engine into OMP. Domain bundles provide role/scope/flag
 * presets and an owner identity; core only registers reusable gates and
 * caller-supplied runtime data.
 */
export function registerTeamWorkflow(pi: ExtensionAPI, opts: RegisterOptions = {}): void {
  if (opts.cwd && opts.owner) {
    assertOwner(opts.cwd, ["workflow_registration", "config_writer"], opts.owner);
  }
  const label = opts.label ?? "omp-workflows";
  pi.setLabel(label);
  if (opts.workflowProfiles?.length) registerWorkflowProfiles(opts.workflowProfiles);

  const resolveCwd = opts.resolveCwd ?? resolveCwdFromContext;
  const bindSession = (ctx: unknown): void => {
    const cwd = opts.cwd ?? resolveCwd(ctx);
    if (!cwd) return;
    assertOwner(cwd, ["workflow_registration", "config_writer"], opts.owner);
    writeRuntimeConfig(opts, cwd);
  };
  if (opts.cwd) bindSession({ cwd: opts.cwd });
  else if ((opts.owner || opts.roles || opts.scopeMap || opts.flags || opts.rosterOverrides) && typeof pi.on === "function") {
    pi.on("session_start", (_event: unknown, ctx: unknown) => bindSession(ctx));
  }

  // @ts-expect-error -- ExtensionAPI.on(string, handler) overload is enough at runtime; we type the handler explicitly.
  pi.on("before_agent_start", (event: BeforeAgentStartEvent, ctx: unknown) => {
    const c = ctx as { cwd: string };
    const r1 = classificationGate(event as unknown as Parameters<typeof classificationGate>[0], c);
    if (r1?.block) return r1;
    const r2 = monotonicGate(event, c);
    if (r2?.block) return r2;
  });
  pi.on("session_stop", (event: SessionStopEvent, ctx: unknown) => {
    const c = ctx as { cwd: string };
    return dodBackstop(event as unknown as Parameters<typeof dodBackstop>[0], c);
  });
  pi.on("tool_call", (event: ToolCallEvent, ctx: unknown) => {
    const c = ctx as { cwd: string; hasUI?: boolean; actor?: "orchestrator" | "worker" | "lead" };
    let result: { block?: boolean; reason?: string } | undefined;
    const run = (candidate: { block?: boolean; reason?: string } | void) => { if (!result && candidate?.block) result = candidate; };
    run(ctoNestingGuard(event as unknown as Parameters<typeof ctoNestingGuard>[0]));
    run(outboxEnforcementGate(event as unknown as Parameters<typeof outboxEnforcementGate>[0], c));
    run(classificationToolGate(event as unknown as Parameters<typeof classificationToolGate>[0], c));
    run(orchestratorWriteGate(event as unknown as Parameters<typeof orchestratorWriteGate>[0], c));
    run(workerWriteScopeGate(event as unknown as Parameters<typeof workerWriteScopeGate>[0], { ...c, writeScope: opts.writeScope }));
    run(ctoSliceTaskGate(event as unknown as Parameters<typeof ctoSliceTaskGate>[0], c));
    run(safetyGuard(event as unknown as Parameters<typeof safetyGuard>[0], c));
    run(dispatchGate(event as unknown as Parameters<typeof dispatchGate>[0], c));
    if (!result && event.toolName === "task") {
      const authorization = trustedDispatchRequests(
        event as unknown as { toolName?: string; toolCallId?: string; input?: unknown },
        c,
      );
      if (!authorization.ok) {
        run({ block: true, reason: authorization.reason });
      } else {
        for (const request of authorization.requests) {
          const authorized = authorizeDispatchTrusted(c.cwd, request);
          if (!authorized.ok) {
            run({ block: true, reason: `dispatch authorization failed: ${authorized.error}` });
            break;
          }
        }
      }
    }
    if (!result && opts.observability !== false) {
      recordToolCallAttempt(c.cwd, event as unknown as { toolName?: string; toolCallId?: string; input?: unknown }, "allowed");
    } else if (opts.observability !== false) {
      recordToolCallAttempt(c.cwd, event as unknown as { toolName?: string; toolCallId?: string; input?: unknown }, "blocked", result?.reason);
    }
    return result;
  });
  pi.on("tool_result", (event: ToolResultEvent, ctx: unknown) => {
    if (event.toolName !== "task") return;
    const c = ctx as { cwd?: string };
    if (!c.cwd) return;
    const details = (event as unknown as { details?: { async?: { state?: string } } }).details;
    const asyncState = details?.async?.state;
    if (asyncState === "running" || asyncState === "spawned" || asyncState === "scheduled") return;
    const content = event.content
      .filter((part): part is { type: "text"; text: string } => part.type === "text")
      .map((part) => part.text)
      .join("\n")
      .trim();
    const evidence = content || (event.isError ? "native task failed" : "native task completed");
    const reconciled = reconcileTrustedTaskResult(c.cwd, {
      tool_call_id: event.toolCallId,
      outcome: event.isError ? "failed" : "succeeded",
      evidence,
    });
    if (!reconciled.ok && !reconciled.error.includes("unknown or already reconciled")) {
      console.warn(`omp workflow task reconciliation failed: ${reconciled.error}`);
    }
  });
  registerObservabilityHooks(pi, { enabled: opts.observability, toolCall: false });
}
/**
 * Legacy per-call main-session heuristic. Consulted ONLY when no
 * session_start host profile was captured (older OMP runtimes without a
 * session context, and direct tool harnesses). Installed OMP deliberately
 * leaves tool-call contexts without a mode or UI in plain rpc mode
 * (main.ts passes no setToolUIContext for `--mode rpc`), so a per-call
 * `hasUI=false` cannot distinguish a main RPC session from a Task subagent
 * — authoritative session ownership comes from the captured profile.
 */
function defaultMainSession(ctx: unknown): boolean {
  if (!ctx || typeof ctx !== "object" || !("hasUI" in ctx)) return true;
  return (ctx as { hasUI?: unknown }).hasUI !== false;
}

/**
 * Host-authored UI surface used for trusted checkpoint prompting. Only
 * objects the host itself attached to a context qualify (the tool-call
 * `ui` or the session_start profile `ui`); nothing model-supplied is ever
 * consulted.
 */
interface HostAskSurface {
  askDialog?(questions: Array<{ id: string; question: string; header?: string; options: Array<{ label: string }>; multi?: boolean }>, dialogOptions?: { signal?: AbortSignal }): Promise<{
    kind: "submit";
    results: Array<Record<string, unknown>>;
  } | { kind: "chat" } | undefined>;
  select?(title: string, options: string[], dialogOptions?: { helpText?: string; signal?: AbortSignal }): Promise<string | undefined>;
}

/**
 * Authoritative host session identity captured from the session_start event
 * context. The installed host emits session_start only after the extension
 * runner is initialized with the runtime mode (`ExtensionMode` = "tui" |
 * "rpc" | "json" | "print") and the mode's UI context, so this profile is
 * the authoritative host mode: interactive TUI sessions report mode "tui"
 * with a live dialog UI, `--mode rpc`/`--mode rpc-ui` sessions report mode
 * "rpc" with the connected RPC client's UI (live select bridge, no
 * askDialog), while print/json runs and Task subagent sessions report mode
 * "print" with no UI.
 */
interface HostSessionProfile {
  mode: string;
  hasUI: boolean;
  ui: unknown;
}

type WorkflowToolResult = { content: [{ type: "text"; text: string }]; details: unknown };

function toolResult(value: unknown): WorkflowToolResult {
  return { content: [{ type: "text", text: JSON.stringify(value) }], details: value };
}

function workflowStateSummary(cwd: string, mappingSummary?: (cwd: string) => unknown): unknown {
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
    agent_mapping: mappingSummary?.(cwd) ?? null,
    join_summary: state.join_summary,
    capability: capability
      ? {
          capability_id: capability.capability_id,
          kind: capability.kind,
          status: capability.status,
          expected_roles: capability.expected_roles,
          dispatches: (capability.dispatches ?? []).map(dispatch => ({
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
        }
      : null,
  };
}

/**
 * Core-owned typed workflow tool registration. Bundles adapt only cwd,
 * mapping and owner identity; preparation, checkpoint, completion and cursor
 * transitions remain one engine implementation.
 */
export function registerWorkflowTools(pi: ExtensionAPI, options: WorkflowToolAdapterOptions = {}): void {
  if (!pi.zod) return;
  if (options.cwd && options.owner) assertOwner(options.cwd, ["workflow_tools"], options.owner);
  const { z } = pi.zod;
  const emptyParameters = z.object({}) as never;
  const resolveCwd = options.resolveCwd ?? resolveCwdFromContext;
  // Authoritative host session profile, captured once per session: the host
  // fires session_start only after the runner is initialized with the
  // runtime mode and the mode's UI context, so the handler observes the
  // final values.
  let hostSession: HostSessionProfile | null = null;
  if (typeof (pi as { on?: unknown }).on === "function") {
    pi.on("session_start", (_event: unknown, ctx: unknown) => {
      const c = ctx as { mode?: unknown; hasUI?: unknown; ui?: unknown } | undefined;
      hostSession = {
        mode: typeof c?.mode === "string" ? c.mode : "print",
        hasUI: c?.hasUI === true,
        ui: c?.ui,
      };
    });
  }
  /**
   * The captured profile, but only when it names a trusted interactive
   * surface: a terminal TUI or a connected RPC client with a UI. json/print
   * headless runs and Task subagent/worker sessions (mode "print", no UI)
   * never qualify.
   */
  const trustedInteractiveProfile = (): HostSessionProfile | null =>
    hostSession !== null && hostSession.hasUI && (hostSession.mode === "tui" || hostSession.mode === "rpc") ? hostSession : null;
  const contextError = (ctx: unknown): WorkflowToolResult | null => {
    // Session ownership: the captured host profile is authoritative. The
    // per-call context cannot make this call — a plain-rpc main session and
    // a Task subagent report identical tool contexts (hasUI=false, no ui).
    // The bundle callback (or the legacy per-call heuristic) decides only
    // when no session_start profile was captured.
    const ownsTools = hostSession !== null
      ? trustedInteractiveProfile() !== null
      : (options.isMainSession ?? defaultMainSession)(ctx);
    if (!ownsTools) {
      return toolResult({
        ok: false,
        code: "WORKFLOW_CONTEXT_REJECTED",
        error: "workflow control tools are available only in the interactive main session (terminal TUI or connected RPC client)",
      });
    }
    const cwd = options.cwd ?? resolveCwd(ctx);
    if (!cwd) return toolResult({ ok: false, code: "WORKFLOW_STATE_UNAVAILABLE", error: "workflow cwd unavailable" });
    try {
      assertOwner(cwd, ["workflow_tools"], options.owner);
    } catch (error) {
      return toolResult({ ok: false, code: "WORKFLOW_OWNER_REJECTED", error: String(error) });
    }
    return null;
  };
  const currentCwd = (ctx: unknown): string | undefined => options.cwd ?? resolveCwd(ctx);
  const classificationParameters = z.object({
    type: z.enum(["FEATURE", "REFACTOR", "OPS", "BUG_FIX", "SPEC", "REGRESS", "INVESTIGATION", "REVIEW", "HOTFIX", "PRODUCT_DISCOVERY"]),
    complexity: z.enum(["QUICK", "MEDIUM", "COMPLEX", "CRITICAL"]),
    confidence: z.enum(["HIGH", "MEDIUM", "LOW"]),
    autonomous: z.boolean(),
    autonomous_reason: z.string().optional(),
    workflow: z.string().optional(),
  });
  pi.registerTool({
    name: "workflow_prepare",
    label: "Prepare workflow state",
    description: "Persist PHASE-0 classification and initialize or reopen engine-owned workflow state.",
    parameters: z.object({
      task: z.string().min(1),
      branch: z.string().min(1),
      classification: classificationParameters.optional(),
      files: z.array(z.string().min(1)).default(() => []),
      issue: z.union([z.number().int(), z.object({ number: z.number().int(), url: z.string().optional() })]).nullable().default(null),
      continuation: z.object({ feedback: z.string().min(1), stageId: z.string().min(1) }).optional(),
    }) as never,
    async execute(_id, params, _signal, _update, ctx) {
      const denied = contextError(ctx);
      if (denied) return denied;
      const cwd = currentCwd(ctx);
      if (!cwd) return toolResult({ ok: false, code: "WORKFLOW_STATE_UNAVAILABLE", error: "workflow cwd unavailable" });
      const input = params as {
        task: string;
        branch: string;
        classification?: ModelClassification;
        files?: string[];
        issue?: number | { number: number; url?: string } | null;
        continuation?: { feedback: string; stageId: string };
      };
      if (!input.continuation && !input.classification) {
        return toolResult({ ok: false, code: "WORKFLOW_PREPARE_REJECTED", error: "new workflow preparation requires a complete classification" });
      }
      try {
        const prepared = prepareWorkflowState({
          task: input.task,
          cwd,
          branch: input.branch,
          autonomous: input.classification?.autonomous ?? false,
          classification: input.classification,
          files: input.files,
          issue: typeof input.issue === "number" ? { number: input.issue } : input.issue ?? null,
          continuation: input.continuation,
        } satisfies WorkflowPrepareOptions);
        return toolResult({
          ok: true,
          transition: "prepare",
          state_path: prepared.statePath,
          artifacts_dir: prepared.artifactsDir,
          workflow: prepared.profile.name,
          classification: prepared.classification,
          state: workflowStateSummary(cwd, options.mappingSummary),
        });
      } catch (error) {
        return toolResult({ ok: false, code: "WORKFLOW_PREPARE_FAILED", error: String(error) });
      }
    },
  });
  pi.registerTool({
    name: "workflow_begin",
    label: "Begin workflow stage",
    description: "Issue a durable opaque capability for the current workflow stage. Stages with a roster policy accept an optional semantic selection — role/facet/focus/reason occurrences only; concrete agent ids are rejected. The selection is validated against the allowed roles, multiplicity and the live registered agent mapping, then frozen: an identical re-issue is idempotent, a changed selection for an active capability is rejected.",
    parameters: z.object({
      selection: z.object({
        rationale: z.string().min(1).optional(),
        evidence: z.array(z.string().min(1)).max(8).optional(),
        occurrences: z.array(z.object({
          role: z.string().min(1),
          facet: z.string().min(1).nullable().optional(),
          focus: z.string().min(1).optional(),
          reason: z.string().min(1).optional(),
        }).strict()).min(1).max(8),
      }).strict().optional(),
    }) as never,
    async execute(_id, params, _signal, _update, ctx) {
      const denied = contextError(ctx);
      if (denied) return denied;
      const cwd = currentCwd(ctx);
      if (!cwd) return toolResult({ ok: false, code: "WORKFLOW_STATE_UNAVAILABLE", error: "workflow cwd unavailable" });
      const input = params as { selection?: RosterBeginSelection };
      try {
        // Per-transition trusted handoff, resolved for this exact cwd: only
        // an explicit undefined means "no handoff" and keeps the persisted
        // mapping. Any other value — including runtime null — is a handoff
        // attempt that must clear the engine's structural gate or
        // workflow_begin fails closed; it never silently selects the
        // persisted mapping.
        const handoff = await options.beforeBegin?.(cwd);
        const trustedMapping = handoff === undefined ? undefined : handoff as unknown as AgentMappingState;
        const transition = beginCapability(cwd, input.selection, trustedMapping !== undefined ? { trustedMapping } : undefined);
        if (!transition.ok) return toolResult({ ok: false, code: "WORKFLOW_BEGIN_REJECTED", error: transition.error, state: transition.state ? workflowStateSummary(cwd, options.mappingSummary) : undefined });
        return toolResult({ ok: true, transition: "begin", handoff: transition.handoff, state: workflowStateSummary(cwd, options.mappingSummary) });
      } catch (error) {
        return toolResult({ ok: false, code: "WORKFLOW_BEGIN_FAILED", error: String(error) });
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
      const cwd = currentCwd(ctx);
      return toolResult(cwd ? workflowStateSummary(cwd, options.mappingSummary) : { ok: false, code: "WORKFLOW_STATE_UNAVAILABLE", error: "workflow cwd unavailable" });
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
      const cwd = currentCwd(ctx);
      if (!cwd) return toolResult({ ok: false, code: "WORKFLOW_STATE_UNAVAILABLE", error: "workflow cwd unavailable" });
      try {
        return toolResult(resolveWorkflowContract(cwd));
      } catch (error) {
        return toolResult({ ok: false, code: "WORKFLOW_RESOLUTION_FAILED", error: String(error) });
      }
    },
  });
  pi.registerTool({
    name: "workflow_complete",
    label: "Complete workflow dispatch",
    description: "Record durable completion for an authorized workflow dispatch. Copy the compact profile_hash fingerprint and the handoff loop_iteration exactly from the current workflow handoff; do not abbreviate or reconstruct either.",
    parameters: z.object({
      dispatch_id: z.string().min(1),
      token: z.string().min(1),
      capability_id: z.string().min(1),
      run_key: z.string().min(1),
      branch: z.string().min(1),
      workflow: z.string().min(1),
      profile_hash: z.string().min(1),
      stage_cursor: z.string().min(1),
      cursor_epoch: z.string().min(1),
      loop_iteration: z.number().int().min(1),
      evidence: z.string().min(1),
      artifact_ids: z.array(z.string().min(1)).default(() => []),
      outcome: z.enum(["succeeded", "failed", "cancelled"]).default("succeeded"),
    }) as never,
    async execute(_id, params, _signal, _update, ctx) {
      const denied = contextError(ctx);
      if (denied) return denied;
      const cwd = currentCwd(ctx);
      if (!cwd) return toolResult({ ok: false, code: "WORKFLOW_STATE_UNAVAILABLE", error: "workflow cwd unavailable" });
      const input = params as DispatchAuth & { dispatch_id: string; evidence: string; artifact_ids?: string[]; outcome: "succeeded" | "failed" | "cancelled" };
      try {
        const transition = completeDispatch(cwd, { ...input, completed_by: "workflow_complete" });
        return transition.ok
          ? toolResult({ ok: true, transition: "complete", dispatch_id: input.dispatch_id, state: transition.state, record: transition.record })
          : toolResult({ ok: false, code: "WORKFLOW_COMPLETE_REJECTED", error: transition.error, dispatch_id: input.dispatch_id });
      } catch (error) {
        return toolResult({ ok: false, code: "WORKFLOW_COMPLETE_FAILED", error: String(error), dispatch_id: input.dispatch_id });
      }
    },
  });
  pi.registerTool({
    name: "workflow_checkpoint",
    label: "Record checkpoint decision",
    description: "Persist a typed, policy-bound decision envelope for a declared stage checkpoint. Human authorization requires a durable terminal/escalation answer proof from workflow_checkpoint_ask: copy the returned proof, decision, checkpoint_kind, and loop_iteration binding verbatim — any reconstructed or abbreviated value rejects. Legacy mode/actor fields never authorize a transition.",
    parameters: z.object({
      token: z.string().min(1),
      capability_id: z.string().min(1),
      run_key: z.string().min(1),
      branch: z.string().min(1),
      workflow: z.string().min(1),
      profile_hash: z.string().min(1),
      stage_cursor: z.string().min(1),
      cursor_epoch: z.string().min(1),
      checkpoint: z.string().min(1),
      checkpoint_id: z.string().min(1),
      checkpoint_kind: z.string().min(1),
      loop_iteration: z.number().int().min(1),
      authorization: z.enum(["human", "policy_auto"]),
      actor_provenance: z.object({
        kind: z.enum(["user", "orchestrator", "system"]),
        ref: z.string().min(1),
        proof: z.object({
          answer_id: z.string().min(1),
          nonce: z.string().min(1),
          channel: z.enum(["terminal", "escalation"]),
          reference: z.string().min(1),
          binding: z.string().min(1),
        }).strict().optional(),
      }).strict(),
      decision: z.string().min(1),
      rationale: z.string().default(""),
      run_id: z.string().min(1).optional(),
    }).strict() as never,
    async execute(_id, params, _signal, _update, ctx) {
      const denied = contextError(ctx);
      if (denied) return denied;
      const cwd = currentCwd(ctx);
      if (!cwd) return toolResult({ ok: false, code: "WORKFLOW_STATE_UNAVAILABLE", error: "workflow cwd unavailable" });
      const input = params as DispatchAuth & {
        checkpoint: string;
        checkpoint_id: string;
        checkpoint_kind: CheckpointRuleKind;
        authorization: "human" | "policy_auto";
        actor_provenance: { kind: "user" | "orchestrator" | "system"; ref: string; proof?: CheckpointAnswerProof };
        decision: string;
        rationale: string;
        run_id?: string;
      };
      try {
        const transition = recordCheckpointDecision(cwd, input);
        return transition.ok
          ? toolResult({ ok: true, transition: "checkpoint", checkpoint: input.checkpoint, state: workflowStateSummary(cwd, options.mappingSummary) })
          : toolResult({ ok: false, code: "WORKFLOW_CHECKPOINT_REJECTED", error: transition.error });
      } catch (error) {
        return toolResult({ ok: false, code: "WORKFLOW_CHECKPOINT_FAILED", error: String(error) });
      }
    },
  });
  pi.registerTool({
    name: "workflow_checkpoint_ask",
    label: "Ask human to authorize checkpoint",
    description: "Trusted terminal ingest for the current stage checkpoint: validates the active capability and the unresolved checkpoint, asks the human at the live UI surface (terminal dialog or connected RPC client), and commits the answer through the engine's durable checkpoint ledger in one cross-process transaction (fresh-state revalidation, live-proof supersession, and the CAS commit are engine-owned). Returns the proof plus actor_provenance for the follow-up workflow_checkpoint call — copy the returned proof, decision, checkpoint_kind, and loop_iteration verbatim; never reconstruct them. The human's selection is the only source of the recorded decision — never guess or fabricate it. Fails closed without an interactive UI surface; Esc, timeout, and custom free-text answers record nothing; cancellation and any state/capability/policy transition while the dialog is open reject without persisting.",
    parameters: z.object({
      token: z.string().min(1),
      capability_id: z.string().min(1),
      run_key: z.string().min(1),
      branch: z.string().min(1),
      workflow: z.string().min(1),
      stage_cursor: z.string().min(1),
      cursor_epoch: z.string().min(1),
      checkpoint: z.string().min(1),
      checkpoint_id: z.string().min(1),
      checkpoint_kind: z.string().min(1),
      loop_iteration: z.number().int().min(1),
      question: z.string().min(1).max(2000).optional(),
    }).strict() as never,
    async execute(_id, params, signal, _update, ctx) {
      const denied = contextError(ctx);
      if (denied) return denied;
      const cwd = currentCwd(ctx);
      if (!cwd) return toolResult({ ok: false, code: "WORKFLOW_STATE_UNAVAILABLE", error: "workflow cwd unavailable" });
      const input = params as {
        token: string;
        capability_id: string;
        run_key: string;
        branch: string;
        workflow: string;
        stage_cursor: string;
        cursor_epoch: string;
        checkpoint: string;
        checkpoint_id: string;
        checkpoint_kind: string;
        loop_iteration: number;
        question?: string;
      };
      const abortedResult = () => toolResult({
        ok: false,
        code: "WORKFLOW_CHECKPOINT_ASK_ABORTED",
        error: "workflow_checkpoint_ask was canceled; no human answer is minted and nothing was recorded",
      });
      try {
        if (signal?.aborted) return abortedResult();
        // Read-only preflight before any human prompt: the dialog is never
        // presented for an unauthenticated, stale, malformed, or
        // already-resolved request. The same validation runs again on the
        // freshly persisted state after the dialog resolves.
        const preflight = validateCheckpointAsk(cwd, input);
        if (!preflight.ok) return toolResult({ ok: false, code: "WORKFLOW_CHECKPOINT_ASK_REJECTED", error: preflight.error });
        const { stage, rule, allowed } = preflight.context;
        const existing = findCurrentCheckpointDecision(preflight.context.state, stage);
        if (existing) {
          return toolResult({
            ok: true,
            transition: "checkpoint_answer",
            checkpoint: input.checkpoint,
            decision: existing.decision,
            already_recorded: true,
            next: "decision already recorded; resume with workflow_advance using the current handoff",
            state: workflowStateSummary(cwd, options.mappingSummary),
          });
        }
        // Privileged ingest boundary: the answer may come only from a real
        // host UI surface — never from anything model-supplied. The
        // installed host wires the prompt capability through two
        // host-authored carriers: the per-call tool context (wired with
        // hasUI=true by the interactive TUI and by `--mode rpc-ui`) and the
        // session_start host profile (`--mode rpc` deliberately leaves the
        // tool-call context UI-less while the session context carries the
        // connected RPC client's live select bridge). Trusted interactive
        // session ownership is re-checked here, so json/print/headless
        // contexts and Task subagent/worker sessions fail closed before any
        // dialog is raised.
        const toolCtx = ctx as unknown as { hasUI?: boolean; ui?: HostAskSurface };
        const toolSurface = toolCtx.hasUI === true && toolCtx.ui ? toolCtx.ui : undefined;
        const profileSurface = trustedInteractiveProfile();
        const surface: HostAskSurface | undefined = toolSurface ?? (profileSurface?.ui as HostAskSurface | undefined);
        const askDialog = typeof surface?.askDialog === "function" ? surface.askDialog.bind(surface) : null;
        const select = typeof surface?.select === "function" ? surface.select.bind(surface) : null;
        if (!askDialog && !select) {
          return toolResult({
            ok: false,
            code: "WORKFLOW_CHECKPOINT_ASK_UNAVAILABLE",
            error: `checkpoint '${input.checkpoint}' requires an interactive terminal answer and no UI surface is available in this session; rerun in an interactive session (escalation channels expose no workflow-checkpoint ingest)`,
          });
        }
        const dialogQuestion = [
          `Human authorization required — checkpoint '${input.checkpoint}' (${rule.kind}) at stage '${stage.id}' of workflow '${input.workflow}'.`,
          ...(input.question ? [`Orchestrator context: ${input.question}`] : []),
          "Select exactly one policy-allowed decision. Esc, timeout, or a custom answer records nothing.",
        ].join("\n");
        const questionId = `checkpoint:${input.checkpoint}`;
        const declined = (error: string) => toolResult({ ok: false, code: "WORKFLOW_CHECKPOINT_DECLINED", error });
        let selected: string | undefined;
        try {
          if (askDialog) {
            const result = await askDialog(
              [{
                id: questionId,
                question: dialogQuestion,
                header: `${input.workflow}/${stage.id}`,
                options: allowed.map((label) => ({ label })),
                multi: false,
              }],
              { signal },
            );
            if (signal?.aborted) return abortedResult();
            if (!result) return declined("no human answer was recorded (dialog declined); the checkpoint remains unresolved");
            if (result.kind !== "submit") {
              return declined("the dialog redirected to chat; a chat redirect never authorizes a policy-bound checkpoint");
            }
            // Strict installed-host result contract: exactly one answer item
            // echoing the exact question asked (id, text, options), strict
            // single-select, exactly one string selection, no timeout, no
            // custom text, and no metadata outside the installed host's
            // declared ExtensionAskDialogResultItem fields. Anything else is
            // a malformed host result and records nothing.
            const results = Array.isArray(result.results) ? result.results : [];
            if (results.length !== 1) {
              return declined(`malformed ask result: expected exactly one answer item, received ${results.length}`);
            }
            const item = results[0];
            if (!item || typeof item !== "object" || Array.isArray(item)) {
              return declined("malformed ask result: the answer item is not an object");
            }
            const knownKeys: Record<string, true> = { id: true, question: true, options: true, multi: true, selectedOptions: true, customInput: true, note: true, timedOut: true };
            const unknownKeys = Object.keys(item).filter((key) => knownKeys[key] !== true);
            if (unknownKeys.length > 0) {
              return declined(`malformed ask result: unknown answer metadata (${unknownKeys.join(", ")})`);
            }
            if (typeof item.id !== "string" || item.id !== questionId) {
              return declined("malformed ask result: the answer does not identify the checkpoint question");
            }
            if (typeof item.question !== "string" || item.question !== dialogQuestion) {
              return declined("malformed ask result: the answer does not echo the checkpoint question");
            }
            if (!Array.isArray(item.options) || item.options.length !== allowed.length || item.options.some((option, index) => typeof option !== "string" || option !== allowed[index])) {
              return declined("malformed ask result: the answer does not echo the policy-allowed options");
            }
            if (item.multi !== false) {
              return declined("malformed ask result: the checkpoint question is single-select");
            }
            if (item.timedOut !== undefined && typeof item.timedOut !== "boolean") {
              return declined("malformed ask result: the timedOut flag must be a boolean");
            }
            if (item.timedOut === true) {
              return declined("the ask dialog timed out; timeout auto-selection is never recorded as human authorization");
            }
            if (item.customInput !== undefined && typeof item.customInput !== "string") {
              return declined("malformed ask result: the custom input must be a string");
            }
            if (typeof item.customInput === "string" && item.customInput.trim().length > 0) {
              return declined("custom free-text answers cannot authorize a policy-bound checkpoint; call workflow_checkpoint_ask again to select one of the allowed decisions");
            }
            if (item.note !== undefined && typeof item.note !== "string") {
              return declined("malformed ask result: the answer note must be a string");
            }
            const selections = item.selectedOptions;
            if (!Array.isArray(selections) || selections.length !== 1 || typeof selections[0] !== "string") {
              return declined(`expected exactly one string selected policy-allowed decision, received ${Array.isArray(selections) ? String(selections.length) : "a non-array selection"}`);
            }
            selected = selections[0];
          } else if (select) {
            selected = await select(`Authorize checkpoint '${input.checkpoint}' (${rule.kind}) — stage '${stage.id}'`, allowed, { helpText: dialogQuestion, signal });
            if (signal?.aborted) return abortedResult();
          }
        } catch (dialogError) {
          if (signal?.aborted) return abortedResult();
          throw dialogError;
        }
        if (selected !== undefined && !allowed.includes(selected)) {
          return declined("the selected label is not a policy-allowed decision; nothing was recorded");
        }
        if (!selected) {
          return declined("no human answer was recorded (dialog declined); the checkpoint remains unresolved");
        }
        // Last cancellation gate before the durable commit: the engine commit
        // below is fully synchronous (no await between the gate and the
        // ledger write), so a canceled call can never reach the ledger past
        // this point.
        if (signal?.aborted) return abortedResult();
        // One engine-owned durable commit: commitCheckpointAnswer re-runs the
        // full state<->capability<->profile<->policy validation against the
        // freshly persisted state inside a cross-process lock+CAS
        // transaction, resolves the recorded/live-answer races
        // (already_finalized / conflict / exact live reuse), and either
        // supersedes every stale live proof and mints one engine-UUID answer
        // or reuses the exact live proof — always in the same commit.
        const committed = commitCheckpointAnswer(cwd, {
          token: input.token,
          capability_id: input.capability_id,
          run_key: input.run_key,
          branch: input.branch,
          workflow: input.workflow,
          stage_cursor: input.stage_cursor,
          cursor_epoch: input.cursor_epoch,
          checkpoint: input.checkpoint,
          checkpoint_id: input.checkpoint_id,
          checkpoint_kind: input.checkpoint_kind,
          loop_iteration: input.loop_iteration,
          decision: selected,
        });
        if (!committed.ok) {
          // Honest engine mapping: a conflict already carries the
          // dialog-aware text; a policy drift keeps its dedicated message;
          // every other post-dialog failure means the workflow world moved
          // while the dialog was open.
          const detail = committed.code === "policy_conflict"
            ? `checkpoint policy drifted between the workflow state and the declaring profile (${committed.error})`
            : committed.error;
          const error = committed.kind === "conflict"
            ? detail
            : `workflow state changed while the dialog was open: ${detail}`;
          return toolResult({ ok: false, code: "WORKFLOW_CHECKPOINT_ASK_REJECTED", error });
        }
        if (committed.outcome === "already_finalized") {
          return toolResult({
            ok: true,
            transition: "checkpoint_answer",
            checkpoint: input.checkpoint,
            decision: committed.decision,
            already_recorded: true,
            next: "decision already recorded; resume with workflow_advance using the current handoff",
            state: workflowStateSummary(cwd, options.mappingSummary),
          });
        }
        if (!committed.answer || !committed.proof) {
          return toolResult({ ok: false, code: "WORKFLOW_CHECKPOINT_ASK_FAILED", error: "checkpoint ledger committed without a durable answer identity" });
        }
        return toolResult({
          ok: true,
          transition: "checkpoint_answer",
          checkpoint: input.checkpoint,
          checkpoint_kind: committed.checkpoint_kind,
          decision: committed.decision,
          channel: "terminal",
          loop_iteration: input.loop_iteration,
          actor_provenance: { kind: "user", ref: committed.answer.reference, proof: committed.proof },
          next: "call workflow_checkpoint now with authorization='human', this exact actor_provenance and decision, checkpoint_kind, rationale, loop_iteration, and the handoff identity fields — copy each returned value verbatim",
          state: workflowStateSummary(cwd, options.mappingSummary),
        });
      } catch (error) {
        return toolResult({ ok: false, code: "WORKFLOW_CHECKPOINT_ASK_FAILED", error: String(error) });
      }
    },
  });
  pi.registerTool({
    name: "workflow_advance",
    label: "Advance workflow",
    description: "Join the current stage and advance its durable cursor after all dispatches complete. Pass the handoff binding including loop_iteration verbatim; a binding replayed from a prior loop iteration rejects.",
    parameters: z.object({
      token: z.string().min(1),
      capability_id: z.string().min(1),
      run_key: z.string().min(1),
      branch: z.string().min(1),
      workflow: z.string().min(1),
      profile_hash: z.string().min(1),
      stage_cursor: z.string().min(1),
      cursor_epoch: z.string().min(1),
      loop_iteration: z.number().int().min(1),
      evidence: z.string().min(1),
    }) as never,
    async execute(_id, params, _signal, _update, ctx) {
      const denied = contextError(ctx);
      if (denied) return denied;
      const cwd = currentCwd(ctx);
      if (!cwd) return toolResult({ ok: false, code: "WORKFLOW_STATE_UNAVAILABLE", error: "workflow cwd unavailable" });
      const input = params as DispatchAuth & { evidence: string };
      try {
        // Per-transition trusted handoff for this exact cwd — never a cached
        // mapping from another transition or project: only an explicit
        // undefined keeps the persisted mapping; runtime null or a value
        // failing the engine's structural gate fails the advance closed.
        const handoff = await options.beforeBegin?.(cwd);
        const trustedMapping = handoff === undefined ? undefined : handoff as unknown as AgentMappingState;
        const transition = advanceCursor(cwd, input, trustedMapping !== undefined ? { trustedMapping } : undefined);
        return transition.ok
          ? toolResult({ ok: true, transition: "advance", stage_cursor: transition.state.stage_cursor, cursor_epoch: transition.state.cursor_epoch, handoff: transition.handoff, state: workflowStateSummary(cwd, options.mappingSummary) })
          : toolResult({ ok: false, code: "WORKFLOW_ADVANCE_REJECTED", error: transition.error });
      } catch (error) {
        return toolResult({ ok: false, code: "WORKFLOW_ADVANCE_FAILED", error: String(error) });
      }
    },
  });
}

export function createWorkflowToolAdapter(options: WorkflowToolAdapterOptions = {}): WorkflowToolAdapter {
  return {
    capabilities: ["workflow_tools"],
    register: (pi: ExtensionAPI) => registerWorkflowTools(pi, options),
  };
}

export { teamCommand } from "./commands/team.js";
export { dispatchGate, buildDispatchMarker, parseDispatchMarker, trustedDispatchRequests, type DispatchAuthorizationRequest } from "./gates/dispatch.js";
export {
  findProfileDir,
  resolveWorkflowProfilePath,
  loadAllProfiles,
  loadProfile,
  isRegisteredWorkflow,
  matchesProfile,
  registerWorkflowProfiles,
  resolveWorkflow,
  selectProfile,
} from "./engine/profile.js";
export {
  hashDispatchSecret,
  createCapability,
  beginCapability,
  authorizeDispatch,
  authorizeDispatchTrusted,
  completeDispatch,
  reconcileTrustedTaskResult,
  advanceCursor,
  reconcileTaskResult,
  recordCheckpointDecision,
  setArtifactContractPolicy,
  setFanInPolicy,
  type CheckpointDecisionInput,
  type DispatchAuth,
  type TrustedDispatchInput,
  type CapabilityHandoff,
  type TransitionResult,
  type TrustedMappingOptions,
  type IssuedCapability,
} from "./engine/durable.js";
export {
  parseExpression,
  evaluatePredicate,
  evaluateExpression,
  validateProfileExpressions,
  deepEqual,
  type PredicateAst,
  type PredicateContext,
  type PredicateResult,
  type PredicateParseResult,
  type PredicateTerm,
} from "./engine/predicate.js";
export {
  loadArtifactSchemas,
  artifactSchemaFor,
  requiredFieldsOf,
  validateProducedArtifact,
  validateConsumedArtifacts,
  validateManualQaArtifact,
  DEFAULT_ARTIFACT_CONTRACT_POLICY,
  type ArtifactContractPolicy,
  type ArtifactIssue,
  type ArtifactValidationResult,
  type ConsumeDiagnostic,
  type ConsumeValidationResult,
  type JsonSchemaDef,
} from "./engine/artifact-contract.js";
export {
  findCurrentCheckpointDecision,
  findHistoricalCheckpointDecision,
  appendCheckpointDecision,
  unresolvedCheckpointError,
} from "./engine/checkpoints.js";
export {
  loopExhaustionKind,
  loopStateFor,
  loopReentryDecision,
  resolveBackToStage,
  loopIterationRecord,
} from "./engine/loops.js";
export {
  sanitizeSlot,
  namespacedArtifactId,
  isNamespacedArtifactId,
  slotRecordsFor,
  missingSlotResults,
  mergeSlotValues,
  synthesizeArtifacts,
  validateStageFanInResolutions,
  DEFAULT_FAN_IN_POLICY,
  type FanInPolicy,
  type MergeResult,
  type SynthesisResult,
} from "./engine/fan-in.js";
export {
  renderProductPrdDocument,
  writeProductPrdDocument,
  validateProductPrdDocument,
  PRODUCT_PRD_ARTIFACT_ID,
  PRODUCT_PRD_RENDERER,
  PRD_SOURCE_ARTIFACT_IDS,
  type ProductPrdManifest,
  type ProductPrdWriteOptions,
  type ProductPrdWriteResult,
  type ProductPrdValidation,
} from "./engine/product-prd.js";
export {
  resolveWorkflowContract,
  resolveStageInstructions,
  validateTypedControlPlane,
  checkpointPolicyLegacyConflict,
  migrationCompletionIntent,
  migrationCheckpointPolicy,
  WorkflowContractError,
  type TypedContractValidationResult,
  type WorkflowContract,
  type WorkflowContractOptions,
  type WorkflowStageContract,
} from "./engine/workflow-contract.js";
export {
  resolveConfig,
  resolveAgentForRole,
  agentMappingIssueForRole,
  type ConfigPreset,
  type ConfigSource,
  type ConfigDiagnosticCode,
  type ConfigDiagnostic,
  type ConfigProvenance,
  type ResolvedConfig,
} from "./engine/config.js";
export {
  RuntimeConfigError,
  resolveRuntimeConfigPath,
  writeConfig,
  type RuntimeConfigErrorCode,
  type RuntimeConfigWriteOptions,
} from "./runtime-config.js";
export {
  AGENT_MAPPING_SCHEMA,
  DEFAULT_GENERIC_AGENT,
  agentMappingPath,
  buildAgentMapping,
  mappingPreferencesHash,
  readAgentMapping,
  validateAgentMappingState,
  writeAgentMapping,
  type AgentMappingDiagnostic,
  type AgentMappingExpectation,
  type AgentMappingOptions,
  type AgentMappingState,
  type AgentMappingStateValidation,
  type AgentMappingStatus,
  type MappingPreferencesProvenance,
} from "./engine/agent-mapping.js";
export {
  resolveScope,
  applyConditional,
  shouldSkip,
  runtimeClassForScope,
  scopeToRuntimeClass,
  type RuntimeClass,
  type ScopeRuntimeClassTable,
  type ScopeFlags,
  type ScopeResolutionOptions,
} from "./engine/scope.js";
export {
  updateStateAtomically,
  setStageStatus,
  setPause,
  checkMonotonic,
  resolveState,
  resolveCanonicalRun,
  type ResolvedActiveRun,
  type StateSelector,
  type StateSnapshot,
  type StateMutation,
  type StateUpdateResult,
  type StateTxErrorCode,
  reopenFromFeedback,
} from "./engine/state.js";
export {
  writeArtifact,
  readArtifact,
  persistReturnedArtifacts,
} from "./engine/artifacts.js";
export {
  ACQUISITION_STATUSES,
  ACQUISITION_FAILURE_CODES,
  EVIDENCE_KINDS,
  EVIDENCE_CONFIDENCES,
  DEFAULT_ACQUISITION_LIMITS,
  HARD_ACQUISITION_LIMITS,
  normalizeAcquisitionLimits,
  isValidEvidenceTimestamp,
  isEvidenceSegment,
  validateEvidenceSegment,
  validateTimestampedTranscriptSegment,
  isTimestampedTranscriptSegment,
  normalizeTimestampedTranscriptSegments,
  chunkTimestampedTranscript,
  normalizeAnalysisCandidates,
  validateLectureAcquisitionArtifact,
  type EvidenceIdFactory,
  type AcquisitionStatus,
  type AcquisitionFailureCode,
  type EvidenceKind,
  type EvidenceConfidence,
  type AcquisitionLimits,
  type ParsedLectureUrl,
  type ResolvedVideoSource,
  type AcquisitionFailure,
  type BoundedSourceSet,
  type EvidenceSegment,
  type TimestampedTranscriptSegment,
  type EphemeralAudio,
  type MediaLease,
  type PreparedAudioLease,
  type LectureAuthorization,
  type PipelineLimits,
  type LectureAudioAcquirer,
  type AuthorizedMediaAcquisitionPort,
  type BoundedAudioPreprocessorPort,
  type TimestampedTranscript,
  type TranscriptChunk,
  type AnalysisCandidate,
  type EvidenceDraft,
  type AnalysisResult,
  type PipelineProviderMetadata,
  type LectureAsrPort,
  type TimestampedAsrPort,
  type LectureTextAnalysisPort,
  type TextAnalysisPort,
  type OmpTextInvoker,
  type OmpRuntimeCapabilityProbe,
  type LectureAcquisitionRequest,
  type LectureAcquisitionArtifact,
  type LectureSourceParser,
  type PlaylistExpander,
  type LectureEvidenceProvider,
  type LectureAcquisitionPort,
  type AcquisitionValidationIssue,
} from "./lecture/acquisition.js";
export {
	appendDoDItem,
	closeDoDItem,
	readDoD,
	isDoDComplete,
	isRootCauseDocumented,
} from "./engine/dod.js";
export { orchestratorWriteGate, workerWriteScopeGate, actorOf, hasStrictOrchestratorState, type WorkerWriteScope } from "./gates/orchestrator-write.js";
export {
  run,
  prepareWorkflowState,
  resolveClassification,
  type RunOptions,
  type WorkflowPrepareOptions,
  type PreparedWorkflowState,
  type RunResult,
  type ModelClassification,
} from "./engine/run.js";
export {
	walkProfile,
	runStage,
	createTaskCaller,
	spawnLabel,
	DevAgentUnavailableError,
	type TaskCaller,
	type TaskResult,
	type TaskToolLike,
	type StageContext,
	type StageOutcome,
} from "./engine/stage.js";
export type {
  Profile,
  StageDef,
  StageType,
  StageStatus,
  PauseKind,
  TaskType,
  Complexity,
  Confidence,
  WorkflowName,
  Classification,
  TeamState,
  RoleConfig,
  DoD,
  DoDItem,
  DispatchCompletion,
  DispatchRecord,
  DispatchCapabilityState,
  JoinSummary,
  CheckpointDecision,
  TypedCheckpointDecision,
  CompletionIntent,
  CompletionIntentMode,
  CompletionAcceptance,
  CheckpointPolicy,
  CheckpointPolicyDefault,
  CheckpointPolicyScope,
  CheckpointPolicyPhase,
  CheckpointRule,
  CheckpointRuleKind,
  HardHumanCheckpointKind,
  CheckpointActor,
  CheckpointActorKind,
  CheckpointAnswerChannel,
  CheckpointAnswerProof,
  TrustedCheckpointAnswer,
  CheckpointAuthorization,
  RosterMultiplicity,
  RosterTriggers,
  RosterBudget,
  RosterSelectionMode,
  RosterSelectionStopReason,
  RosterPolicy,
  RosterSelectionEntry,
  RosterOmittedEntry,
  RosterSelection,
  WorkIdentity,
  PendingReason,
  PendingLease,
  PendingState,
  PendingDispatchState,
  ChildJoinStatus,
  ChildJoin,
  CompletionOutcome,
  CompletionTerminalSignal,
  CompletionSchemaStatus,
  CompletionDodStatus,
  CompletionArtifactRef,
  CompletionEnvelope,
  WorkflowLifecycleStatus,
  WorkflowContractStatus,
  ControlPlaneFieldSource,
  ControlPlaneMigrationStatus,
  ControlPlaneProvenance,
  MigrationReceipt,
  SlotArtifactRecord,
  StageSlotRecords,
  StageFanInResolution,
  FanInConflictRecord,
  LoopIterationRecord,
  LoopState,
} from "./engine/types.js";
// ── CTO sub-orchestration (pure engine) ────────────────────────────────────
export { MAX_TEAMS, MAX_DECOMPOSITION_DEPTH } from "./cto/types.js";
export type {
	TeamDef,
	TeamPlan,
	TeamPlanEntry,
	WorktreeStrategy,
	Escalation,
	EscalationOption,
	EscalationLevel,
	EscalationAdapter,
	EscalationReceipt,
	EscalationStatus,
	EscalationRecord,
	EscalationAnswer,
	TeamRunStatus,
	CtoControlPlaneFields,
	CtoState,
} from "./cto/types.js";
export {
	validateEscalation,
	sanitizeEscalation,
	answersDir,
	readAnswers,
	ensureAnswersDir,
} from "./cto/escalation.js";
export {
	ctoStateDir,
	ctoStatePath,
	newCtoState,
	readCtoState,
	writeCtoState,
	setTeamStatus,
	setEscalation,
	setEscalationStatus,
	setIntegration,
	setCtoPause,
	setCtoControlPlane,
	setTeamControlPlane,
	expireEscalations,
	pendingEscalations,
	activeTeams,
	markAmended,
	isCtoRunTerminal,
	resolveCtoAutonomous,
	// ── resident control-plane (wave lifecycle) ──
	isCtoResident,
	appendWave,
	finishWave,
	activeWave,
	findWaveBySourceId,
} from "./cto/state.js";
export { teamDoDComplete, integrationDoD, ctoBackstop } from "./cto/gates.js";
export { runCto, ctoRunId, type RunCtoOptions, type RunCtoResult } from "./cto/run.js";
export {
  ctoCommand,
  parseEnvelope as parseCtoEnvelope,
  buildCtoPrompt,
  buildAmendPrompt,
  buildStandbyCtoPrompt,
  renderChannelSection,
  findActiveCtoRun,
  type ParsedCtoEnvelope,
  type CtoPromptOptions,
} from "./commands/cto.js";
export {
	buildTeamPlan,
	validateDecompositionDepth,
	type PlanTeamInput,
	type PlanBuildInput,
	type BuildResult,
} from "./cto/plan.js";
export {
	registerWorkflowCommands,
	type WorkflowCommandOptions,
} from "./commands/register.js";
export {
  parseWorkEnvelope,
  buildDoWorkPrompt,
  type ParsedWorkEnvelope,
  type WorkTeamConfig,
} from "./commands/do-work.js";
export {
  parseAutonomousDirective,
  AUTONOMOUS_TOKEN,
  AUTONOMOUS_DIRECTIVES,
  type AutonomousDirective,
} from "./commands/envelope.js";
export {
  EventRecorder,
  rollupFromEvents,
  readObservabilityPointer,
  extractSkills,
} from "./observability/index.js";
export {
  recordToolCallAttempt,
  recordStageTransition,
  recordArtifactWritten,
  recordWorkPending,
  recordWorkTerminal,
} from "./observability/hooks.js";
export type {
  ObservabilityEvent,
  ObservabilityPointer,
  ObservabilityRollup,
  ObservabilitySignalFields,
  ObservabilityArtifactSummary,
  EventKind,
} from "./observability/events.js";

/**
 * Marker exported so custom-TS commands can detect that the engine was
 * wired in this package (i.e. the bundle is `omp-workflows-fullstack` or
 * a derivative that calls `registerTeamWorkflow`). Used by the bundled
 * commands to short-circuit when no engine is present.
 */
export const CORE_ENGINE_MARKER = "omp-workflows-core/0.8.0";

// ── cto-core (br-zps.1, br-zps.3, br-zps.11) ────────────────────────────────
export {
	migrateCtoState,
	canonicalizeState,
} from "./cto/state.js";
export {
	acquireLease,
	heartbeatLease,
	releaseLease,
	isLeaseAlive,
	reclaimDeadLeases,
} from "./cto/leases.js";
export { recordDecision, recallDecisions, decisionsToMarkdown } from "./cto/decisions.js";
export type {
	BudgetPolicy,
	BudgetAccounting,
	BudgetState,
	BudgetStatus,
	TeamLease,
	DecisionMemoryEntry,
	QuarantineRecord,
	RunHealth,
	SchedulerState,
	ScheduledDigest,
	RedactionConfig,
	RefinementResult,
	DissentTrigger,
	DissentEvaluation,
} from "./cto/types.js";

// ── cto resident control-plane (channel policy, slice gate) ────────────────
export {
	resolveChannelProfile,
	normalizeChannelConfig,
	hasRwPrimary,
	loadEscalationConfigRaw,
} from "./cto/channels.js";
export type { ExplicitChannelConfig, ChannelCapabilities } from "./cto/channels.js";
export {
	buildCtoSliceMarker,
	parseCtoSliceMarker,
	assertCtoSliceDispatchable,
	ctoSliceTaskGate,
	validateSliceClassification,
	validateSliceWorkflow,
	validateSliceDoD,
	CTO_SLICE_MARKER_PREFIX,
} from "./cto/slice-gate.js";
export type { WaveRecord, ChannelProfile, ChannelDirection } from "./cto/types.js";

// ── cto-safety (br-zps.4, br-zps.5, br-zps.6) ───────────────────────────────
export { redactEscalation, DEFAULT_REDACTION_CONFIG } from "./cto/redaction.js";
export { outboxEnforcementGate } from "./gates/outbox.js";
export { classificationGate, classificationToolGate } from "./gates/classification.js";
export { keywordClassify, type KeywordGuess } from "./engine/classify.js";
export { buildClassificationPhaseZero, buildWorkflowMatrix, CLASSIFICATION_FIELDS, type ClassificationHint } from "./commands/classification-contract.js";
export type { EscalationInboundMessage } from "./cto/types.js";

// ── cto-operations (br-zps.2, br-zps.7, br-zps.8) ───────────────────────────
export { defaultBudgetState, checkBudget, recordSpend, setBudgetPolicy, CHAR_HEURISTIC_RECORDER } from "./cto/budget.js";
export type { BudgetRecorder } from "./cto/budget.js";
export { assessRunHealth, healthToMarkdown } from "./cto/health.js";
export { shouldRunWave, buildDigest, startWaveScheduler } from "./cto/scheduler.js";

// ── cto-quality (br-zps.9, br-zps.10) ───────────────────────────────────────
export { refineTask, validateRefinement } from "./cto/refinement.js";
export { evaluateDissent } from "./cto/dissent.js";
export { dissentGate } from "./cto/gates.js";

// ── Session-state visualization (pragmatic architecture) ───────────────────
export {
	buildSessionReport,
	writeReport,
} from "./report/assemble.js";
export { renderReportHtml } from "./report/html.js";
export { renderMarkdownDocumentHtml } from "./report/markdown.js";
export type { MarkdownDocumentOptions } from "./report/markdown.js";
export { redactReportBody } from "./report/redact.js";
export type {
	SessionKind,
	SessionSelector,
	BuildSessionReportOptions,
	StageInfo,
	StageAgentInfo,
	EdgeKind,
	SessionEdge,
	ArtifactStatus,
	ReportArtifact,
	ReportTeam,
	ReportIntegration,
	ReportHealth,
	ReportMeta,
	ReportSource,
	ReportTelemetry,
	ChronologyEvent,
	SessionReport,
} from "./report/types.js";

// ── Workflow visualization (visualize OPT-A, on-demand projection) ──────────
// Additive seam: the fullstack `/workflow-view` command consumes this surface.
// `export *` deliberately leaves three name clashes to the pre-existing
// explicit exports (ES semantics: explicit exports win over star re-exports),
// so `SessionKind` / `ArtifactStatus` / `WorkflowName` keep their report/
// engine meanings — no breaking export change. The visualize barrel's own
// definitions of those three names (different unions) remain reachable via
// the additive `@andvl1/omp-workflows-core/visualize` subpath export.
export * from "./visualize/index.js";
