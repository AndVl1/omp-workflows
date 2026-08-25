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
import { authorizeDispatchTrusted, reconcileTrustedTaskResult, beginCapability, completeDispatch, advanceCursor, recordCheckpointDecision } from "./engine/durable.js";
import { registerWorkflowProfiles } from "./engine/profile.js";
import { prepareWorkflowState, type ModelClassification, type WorkflowPrepareOptions } from "./engine/run.js";
import { resolveState } from "./engine/state.js";
import { resolveWorkflowContract } from "./engine/workflow-contract.js";
import { resolveRuntimeConfigPath, writeConfig } from "./runtime-config.js";
import type { Profile, RoleConfig, CheckpointRuleKind, CheckpointAnswerProof } from "./engine/types.js";
import type { WorkerWriteScope } from "./gates/orchestrator-write.js";
import type { DispatchAuth } from "./engine/durable.js";
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
  isMainSession?: (ctx: unknown) => boolean;
  beforeBegin?: (cwd: string) => void | Promise<void>;
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
  const hasOverride = Boolean(opts.roles || opts.scopeMap || opts.flags || opts.rosterOverrides || opts.designSystem !== undefined);
  if (!hasOverride || !cwd) return null;
  assertOwner(cwd, ["config_writer"], opts.owner);
  const path = resolveRuntimeConfigPath(cwd);
  if (!path) return null;
  writeConfig(path, {
    roles: opts.roles ?? {},
    roster_overrides: opts.rosterOverrides ?? {},
    scope_map: opts.scopeMap ?? [],
    flags: opts.flags ?? {},
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
function defaultMainSession(ctx: unknown): boolean {
  if (!ctx || typeof ctx !== "object" || !("hasUI" in ctx)) return true;
  return (ctx as { hasUI?: unknown }).hasUI !== false;
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
  const contextError = (ctx: unknown): WorkflowToolResult | null => {
    if ((options.isMainSession ?? defaultMainSession)(ctx) === false) {
      return toolResult({
        ok: false,
        code: "WORKFLOW_CONTEXT_REJECTED",
        error: "workflow control tools are available only in the main session",
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
    description: "Issue a durable opaque capability for the current workflow stage.",
    parameters: emptyParameters,
    async execute(_id, _params, _signal, _update, ctx) {
      const denied = contextError(ctx);
      if (denied) return denied;
      const cwd = currentCwd(ctx);
      if (!cwd) return toolResult({ ok: false, code: "WORKFLOW_STATE_UNAVAILABLE", error: "workflow cwd unavailable" });
      try {
        await options.beforeBegin?.(cwd);
        const transition = beginCapability(cwd);
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
    description: "Record durable completion for an authorized workflow dispatch. Copy the compact profile_hash fingerprint exactly from the current workflow handoff; do not abbreviate or reconstruct it.",
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
    description: "Persist a typed, policy-bound decision envelope for a declared stage checkpoint. Human authorization requires a durable terminal/escalation answer proof; legacy mode/actor fields never authorize a transition.",
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
    name: "workflow_advance",
    label: "Advance workflow",
    description: "Join the current stage and advance its durable cursor after all dispatches complete.",
    parameters: z.object({
      token: z.string().min(1),
      capability_id: z.string().min(1),
      run_key: z.string().min(1),
      branch: z.string().min(1),
      workflow: z.string().min(1),
      profile_hash: z.string().min(1),
      stage_cursor: z.string().min(1),
      cursor_epoch: z.string().min(1),
      evidence: z.string().min(1),
    }) as never,
    async execute(_id, params, _signal, _update, ctx) {
      const denied = contextError(ctx);
      if (denied) return denied;
      const cwd = currentCwd(ctx);
      if (!cwd) return toolResult({ ok: false, code: "WORKFLOW_STATE_UNAVAILABLE", error: "workflow cwd unavailable" });
      const input = params as DispatchAuth & { evidence: string };
      try {
        const transition = advanceCursor(cwd, input);
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
  DEFAULT_ARTIFACT_CONTRACT_POLICY,
  type ArtifactContractPolicy,
  type ArtifactIssue,
  type ArtifactValidationResult,
  type ConsumeDiagnostic,
  type ConsumeValidationResult,
  type JsonSchemaDef,
} from "./engine/artifact-contract.js";
export {
  findCheckpointDecision,
  hasCheckpointDecision,
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
  writeAgentMapping,
  type AgentMappingDiagnostic,
  type AgentMappingExpectation,
  type AgentMappingOptions,
  type AgentMappingState,
  type AgentMappingStatus,
  type MappingPreferencesProvenance,
} from "./engine/agent-mapping.js";
export {
  resolveScope,
  applyConditional,
  shouldSkip,
  DEFAULT_SCOPE_RUNTIME_CLASSES,
  runtimeClassForScope,
  scopeToRuntimeClass,
  type RuntimeClass,
  type ScopeRuntimeClassTable,
  type ScopeFlags,
  type ScopeResolutionOptions,
} from "./engine/scope.js";
export {
  writeState,
  setStageStatus,
  setPause,
  checkMonotonic,
  resolveState,
  resolveCanonicalRun,
  type ResolvedActiveRun,
  type StateSelector,
  reopenFromFeedback,
} from "./engine/state.js";
export {
  writeArtifact,
  readArtifact,
  persistReturnedArtifacts,
} from "./engine/artifacts.js";
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
