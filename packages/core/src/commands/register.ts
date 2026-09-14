
import type { ExtensionAPI, ExtensionCommandContext } from "@oh-my-pi/pi-coding-agent";
import {
  buildAmendPrompt,
  buildCtoPrompt,
  buildStandbyCtoPrompt,
  findActiveCtoRun,
  parseEnvelope as parseCtoEnvelope,
} from "./cto.js";
import { buildDoWorkPrompt, parseWorkEnvelope, type ParsedWorkEnvelope } from "./do-work.js";
import {
  specImportCommand,
  specPlanCommand,
  specTasksCommand,
  specificationCommandUsage,
  specificationImportUsage,
  specifyCommand,
  type SpecificationCommandName,
} from "./specification.js";
import type { CommandContext } from "./types.js";
import { withExecutionLiveness, type ExecutionLivenessGuard } from "../execution-liveness.js";
import { realpathSync } from "node:fs";
import { PinnedProjectRoot } from "../specification/pinned-root.js";
import {
  closeRegistryRegistrationContext,
  openWorkflowActivation,
  releaseWorkflowOwners,
  requireRegistryContext,
  type RegistryRegistrationContext,
  type WorkflowCapability,
  type WorkflowOwnerReleaseToken,
  type WorkflowOwnerSource,
} from "../registry/owner.js";
export const MAX_WORKFLOW_COMMAND_ARGUMENT_BYTES = 1024 * 1024;

function doWorkDescription(doWork: string, team: string): string {
  return `Run a profile-driven workflow. /${doWork} <task>. (Alias: /${team}.)`;
}
function teamDescription(doWork: string): string {
  return `Alias for /${doWork}. Prefer /${doWork} in new code.`;
}
function ctoDescription(cto: string): string {
  return `CTO sub-orchestration (main-session role): the resident CTO decomposes a task into parallel development teams. /${cto} <task>; /${cto} alone starts STANDBY (tasks arrive via messenger inbox). Runs in-session — never task(agent=cto)`;
}
function specificationDescription(name: string, command: SpecificationCommandName): string {
  if (command === "specify") {
    return `Create, resume, or revise the Specify phase. /${name} [--feature <feature-id>] <request>.`;
  }
  const phase = command === "spec-plan" ? "Plan" : "Tasks";
  return `Create, resume, or revise the ${phase} phase. /${name} --feature <feature-id>.`;
}
function specificationImportDescription(name: string): string {
  return `Import an authorized local external specification read-only and validate compatibility. /${name} <path> [--framework <id|generic>] [--language <BCP47>] [--feature <feature-id>] [--supplement <project-relative-json>] [--review <project-relative-json>].`;
}


export interface WorkflowCommandOptions {
  buildDoWorkPrompt?: (envelope: ParsedWorkEnvelope, cwd: string) => string | Promise<string>;
  /** Called only after a syntactically valid explicit /cto command. */
  onCtoCommand?: (input: { cwd: string; sessionId: string; runId?: string; standby: boolean }) => void;
  doWorkDescription?: string;
  teamDescription?: string;
  ctoDescription?: string;
  namespace?: string;
  commandPrefix?: string;
  cwd?: string;
  /**
   * Authoritative cwd override: when configured, its result — including
   * `undefined` — is used as-is; the context/session fallback only applies
   * when no resolver is configured.
   */
  resolveCwd?: (ctx: unknown) => string | undefined;
  owner?: WorkflowOwnerSource;
}
/**
 * Resolve the project root from the session manager first. A missing cwd is
 * returned as unavailable rather than silently switching to process.cwd().
 */
export function resolveCommandCwd(ctx: ExtensionCommandContext): string | undefined {
  const sessionManager = ctx.sessionManager as unknown;
  if (sessionManager && typeof sessionManager === "object" && "getCwd" in sessionManager && typeof sessionManager.getCwd === "function") {
    try {
      const sessionCwd = (sessionManager.getCwd as () => unknown)();
      return typeof sessionCwd === "string" && sessionCwd.length > 0 ? sessionCwd : undefined;
    } catch {
      // A callable manager getter is authoritative; stale context cwd is unsafe.
      return undefined;
    }
  }
  // Older/minimal hosts may expose a manager shell without cwd capability.
  // Only in that case is the context cwd a valid compatibility fallback.
  return typeof ctx.cwd === "string" && ctx.cwd.length > 0 ? ctx.cwd : undefined;
}

type CommandPromptBuilder = (
  args: string,
  ctx: ExtensionCommandContext,
  cwd: string | undefined,
  envelope?: ParsedWorkEnvelope,
) => string | Promise<string>;
type BeforeCommandExecute = (cwd: string | undefined, ctx: ExtensionCommandContext) => ExecutionLivenessGuard | void;

type CommandContextIdentity = {
  readonly sessionManager: object;
  readonly sessionId?: string;
  readonly sessionFile?: string;
  readonly sessionBasename?: string;
  readonly sessionGeneration?: string | number;
};

type CommandActivationSlot = {
  readonly context: RegistryRegistrationContext;
  readonly releaseToken: WorkflowOwnerReleaseToken;
  readonly leasedCapabilities: readonly WorkflowCapability[];
  readonly root: string;
  readonly rootDev: number;
  readonly rootIno: number;
  readonly sessionManager?: object;
  readonly sessionId?: string;
  readonly sessionFile?: string;
  readonly sessionBasename?: string;
  readonly sessionGeneration?: string | number;
};
type CommandMountState = "pending" | "mounting" | "active" | "failed";

interface CommandOwnerState {
  slot?: CommandActivationSlot;
  sessionId?: string;
  revoked: boolean;
  disposed: boolean;
  shutdownRegistered: boolean;
  mount: CommandMountState;
}

const commandOwnerStates = new WeakMap<object, CommandOwnerState>();

function commandOwnerState(pi: ExtensionAPI): CommandOwnerState {
  const key = pi as object;
  const existing = commandOwnerStates.get(key);
  if (existing) return existing;
  const state: CommandOwnerState = { revoked: false, disposed: false, shutdownRegistered: false, mount: "pending" };
  commandOwnerStates.set(key, state);
  return state;
}

function disposeCommandOwnerActivation(pi: ExtensionAPI, retainSessionId = false): void {
  const state = commandOwnerState(pi);
  const slot = state.slot;
  state.slot = undefined;
  if (!retainSessionId) state.sessionId = undefined;
  if (!slot) return;
  closeRegistryRegistrationContext(slot.context);
  if (slot.leasedCapabilities.length > 0) releaseWorkflowOwners(slot.releaseToken, slot.leasedCapabilities);
}

function failCommandMount(pi: ExtensionAPI): void {
  const state = commandOwnerState(pi);
  disposeCommandOwnerActivation(pi);
  state.mount = "failed";
  state.revoked = true;
  state.disposed = true;
}

function resetCommandMountAfterPreHostFailure(pi: ExtensionAPI, sessionId?: string): void {
  const state = commandOwnerState(pi);
  disposeCommandOwnerActivation(pi);
  state.mount = "pending";
  state.revoked = sessionId !== undefined;
  state.disposed = false;
  if (sessionId) state.sessionId = sessionId;
}

function requireCommandMountActive(pi: ExtensionAPI): void {
  const state = commandOwnerStates.get(pi as object);
  if (!state) throw new Error("owner_conflict: workflow command registration is unavailable");
  if (state.mount !== "active") {
    throw new Error("owner_conflict: workflow command registration is " + state.mount);
  }
  if (state.revoked) throw new Error("activation_identity_changed: registration activation was revoked");
}

function commandSessionId(...sources: unknown[]): string | undefined {
  for (const source of sources) {
    if (!source || typeof source !== "object") continue;
    const manager = (source as { sessionManager?: unknown }).sessionManager;
    if (!manager || typeof manager !== "object") continue;
    if (!("getSessionId" in manager) || typeof (manager as { getSessionId?: unknown }).getSessionId !== "function") return undefined;
    try {
      const value = (manager as { getSessionId: () => unknown }).getSessionId.call(manager);
      return typeof value === "string" && value.trim().length > 0 ? value : undefined;
    } catch {
      return undefined;
    }
  }
  for (const source of sources) {
    if (!source || typeof source !== "object") continue;
    const value = (source as { sessionId?: unknown; session_id?: unknown }).sessionId
      ?? (source as { session_id?: unknown }).session_id;
    if (typeof value === "string" && value.trim().length > 0) return value;
  }
  return undefined;
}


const MAX_COMMAND_SESSION_FILE_BYTES = 4096;
const MAX_COMMAND_SESSION_BASENAME_BYTES = 512;

function commandSessionManager(ctx: unknown): object | null {
  if (!ctx || typeof ctx !== "object") return null;
  const manager = (ctx as { sessionManager?: unknown }).sessionManager;
  return manager && typeof manager === "object" ? manager : null;
}

function commandSessionFile(ctx: unknown): { file: string; basename: string } | undefined {
  const manager = commandSessionManager(ctx);
  if (!manager || !("getSessionFile" in manager) || typeof manager.getSessionFile !== "function") return undefined;
  try {
    const file = manager.getSessionFile();
    if (typeof file !== "string" || file.length === 0 || Buffer.byteLength(file, "utf8") > MAX_COMMAND_SESSION_FILE_BYTES || /[\u0000\r\n]/u.test(file)) return undefined;
    const segments = file.split(/[\\/]/u);
    if (segments.some((segment) => segment === "." || segment === "..")) return undefined;
    const basename = segments.at(-1);
    if (!basename || Buffer.byteLength(basename, "utf8") > MAX_COMMAND_SESSION_BASENAME_BYTES) return undefined;
    return { file, basename };
  } catch {
    return undefined;
  }
}

function commandSessionGeneration(ctx: unknown): string | number | undefined {
  const manager = commandSessionManager(ctx);
  if (!manager) return undefined;
  for (const methodName of ["getSessionGeneration", "getGeneration", "getSessionVersion"] as const) {
    const method = (manager as Record<string, unknown>)[methodName];
    if (typeof method !== "function") continue;
    try {
      const value = method.call(manager);
      if ((typeof value === "string" && value.length > 0 && Buffer.byteLength(value, "utf8") <= MAX_COMMAND_SESSION_FILE_BYTES && !/[\u0000\r\n]/u.test(value))
        || (typeof value === "number" && Number.isSafeInteger(value))) return value;
    } catch {
      return undefined;
    }
  }
  for (const key of ["sessionGeneration", "session_generation", "generation"] as const) {
    const value = (manager as Record<string, unknown>)[key];
    if ((typeof value === "string" && value.length > 0 && Buffer.byteLength(value, "utf8") <= MAX_COMMAND_SESSION_FILE_BYTES && !/[\u0000\r\n]/u.test(value))
      || (typeof value === "number" && Number.isSafeInteger(value))) return value;
  }
  return undefined;
}

function commandContextIdentity(ctx: unknown): CommandContextIdentity | null {
  const manager = commandSessionManager(ctx);
  if (!manager) return null;
  const sessionId = commandSessionId(ctx);
  const transcript = commandSessionFile(ctx);
  const generation = commandSessionGeneration(ctx);
  return {
    sessionManager: manager,
    ...(sessionId ? { sessionId } : {}),
    ...(transcript ? { sessionFile: transcript.file, sessionBasename: transcript.basename } : {}),
    ...(generation !== undefined ? { sessionGeneration: generation } : {}),
  };
}

function commandRootIdentity(cwd: string): { root: string; rootDev: number; rootIno: number } {
  let canonicalCwd: string;
  try { canonicalCwd = realpathSync(cwd); } catch { throw new Error("activation_identity_changed: command project root could not be pinned"); }
  const pinned = PinnedProjectRoot.open(canonicalCwd);
  if (!pinned || !pinned.isStable()) {
    pinned?.close();
    throw new Error("activation_identity_changed: command project root could not be pinned");
  }
  const result = { root: pinned.canonical_root, rootDev: pinned.dev, rootIno: pinned.ino };
  pinned.close();
  return result;
}

function commandContextIdentityIssue(slot: CommandActivationSlot, cwd: string, ctx: unknown): string | null {
  let canonicalCwd: string;
  try { canonicalCwd = realpathSync(cwd); } catch { return "activation_identity_changed: command project root could not be pinned"; }
  const pinned = PinnedProjectRoot.open(canonicalCwd);
  if (!pinned) return "activation_identity_changed: command project root could not be pinned";
  try {
    if (pinned.canonical_root !== slot.root || pinned.dev !== slot.rootDev || pinned.ino !== slot.rootIno || !pinned.isStable()) {
      return "activation_identity_changed: command project root identity changed";
    }
  } finally {
    pinned.close();
  }
  const manager = commandSessionManager(ctx);
  const hasUI = ctx && typeof ctx === "object" && (ctx as { hasUI?: unknown }).hasUI === true;
  if (!manager) return hasUI ? "activation_context_missing: authoritative host session identity is unavailable" : (slot.sessionManager ? "activation_context_missing: command session identity is unavailable" : null);
  if (!("getCwd" in manager) || typeof manager.getCwd !== "function") return "activation_context_invalid: authoritative host session cwd is unavailable";
  let managerCwd: unknown;
  try { managerCwd = manager.getCwd(); } catch { return "activation_context_invalid: authoritative host session cwd is unavailable"; }
  if (typeof managerCwd !== "string" || managerCwd.length === 0) return "activation_context_invalid: authoritative host session cwd is unavailable";
  let canonicalManagerCwd: string;
  try { canonicalManagerCwd = realpathSync(managerCwd); } catch { return "activation_identity_changed: authoritative host session root could not be pinned"; }
  const managerRoot = PinnedProjectRoot.open(canonicalManagerCwd);
  if (!managerRoot) return "activation_identity_changed: authoritative host session root could not be pinned";
  try {
    if (managerRoot.canonical_root !== slot.root || managerRoot.dev !== slot.rootDev || managerRoot.ino !== slot.rootIno || !managerRoot.isStable()) return "activation_identity_changed: authoritative host session root differs from registered root";
  } finally {
    managerRoot.close();
  }
  const identity = commandContextIdentity(ctx);
  if (!identity) return "activation_context_invalid: authoritative host session identity is malformed";
  if (slot.sessionManager !== undefined && (
    slot.sessionManager !== identity.sessionManager
    || slot.sessionId !== identity.sessionId
    || slot.sessionFile !== identity.sessionFile
    || slot.sessionBasename !== identity.sessionBasename
    || slot.sessionGeneration !== identity.sessionGeneration
  )) return "activation_identity_changed: registration session changed";
  return null;
}

function bindCommandContextIdentity(slot: CommandActivationSlot, cwd: string, ctx: unknown): CommandActivationSlot {
  const issue = commandContextIdentityIssue(slot, cwd, ctx);
  if (issue) throw new Error(issue);
  const identity = commandContextIdentity(ctx);
  return identity && slot.sessionManager === undefined ? { ...slot, ...identity } : slot;
}

function closeCommandOwnerActivation(pi: ExtensionAPI, event: unknown, ctx: unknown): void {
  const state = commandOwnerStates.get(pi as object);
  if (!state) return;
  const currentSessionId = commandSessionId(ctx, event);
  const activeSessionId = state.slot?.sessionId ?? state.sessionId;
  if (activeSessionId && currentSessionId && activeSessionId !== currentSessionId) return;
  disposeCommandOwnerActivation(pi);
  if (state.mount !== "failed") state.revoked = false;
  state.disposed = true;
}

function installCommandOwnerShutdown(pi: ExtensionAPI): void {
  const state = commandOwnerState(pi);
  if (state.shutdownRegistered || typeof pi.on !== "function") return;
  state.shutdownRegistered = true;
  try {
    pi.on("session_shutdown", (event: unknown, ctx: unknown) => {
      closeCommandOwnerActivation(pi, event, ctx);
    });
  } catch (error) {
    state.shutdownRegistered = false;
    throw error;
  }
}
type CommandEnvelopeParser = (args: string, cwd: string) => ParsedWorkEnvelope;

function envelopeError(envelope: ParsedWorkEnvelope): string | undefined {
  return envelope.error
    ? `ERROR ${envelope.error.code}: ${envelope.error.message}`
    : undefined;
}

function registerPromptCommand(
  pi: ExtensionAPI,
  name: string,
  description: string,
  buildPrompt: CommandPromptBuilder,
  resolveCwd: (ctx: ExtensionCommandContext) => string | undefined,
  requireActive?: () => void,
  beforeExecute?: BeforeCommandExecute,
  parseEnvelope?: CommandEnvelopeParser,
): void {
  pi.registerCommand(name, {
    description,
    handler: async (args, ctx) => {
      requireActive?.();
      const cwd = resolveCwd(ctx);
      const liveGuard = beforeExecute?.(cwd, ctx);
      if (!liveGuard) throw new Error("owner_conflict: workflow command execution guard unavailable");
      const execute = async () => {
        liveGuard();
        if (typeof args !== "string") {
          liveGuard();
          pi.sendUserMessage("ERROR COMMAND_ARGUMENT_INVALID: arguments must be a string");
          return;
        }
        if (Buffer.byteLength(args, "utf8") > MAX_WORKFLOW_COMMAND_ARGUMENT_BYTES) {
          liveGuard();
          pi.sendUserMessage(`ERROR COMMAND_ARGUMENT_INVALID: arguments exceed ${MAX_WORKFLOW_COMMAND_ARGUMENT_BYTES} UTF-8 bytes`);
          return;
        }
        const rawArgs = args;
        const normalizedArgs = args.trim();
        const envelope = rawArgs && cwd ? parseEnvelope?.(rawArgs, cwd) : undefined;
        const error = envelope ? envelopeError(envelope) : undefined;
        if (error) {
          liveGuard();
          pi.sendUserMessage(error);
          return;
        }
        liveGuard();
        const prompt = await buildPrompt(normalizedArgs, ctx, cwd, envelope);
        liveGuard();
        pi.sendUserMessage(prompt);
      };
      await withExecutionLiveness(liveGuard, execute);
    },
  });
}

function buildDoWorkCommandPrompt(
  args: string,
  ctx: ExtensionCommandContext,
  variant: "do-work" | "team",
  display: { doWork: string; team: string },
  promptBuilder: (envelope: ParsedWorkEnvelope, cwd: string) => string | Promise<string>,
  cwd: string | undefined,
  parsedEnvelope?: ParsedWorkEnvelope,
): string | Promise<string> {
  const displayName = variant === "do-work" ? display.doWork : display.team;
  if (!args) {
    return variant === "do-work"
      ? [
          `Usage: /${display.doWork} <task description>`,
          "",
          "Examples:",
          `  /${display.doWork} Add OAuth authentication with Google and GitHub`,
          `  /${display.doWork} [AUTONOMOUS] Fix the 500 error on /api/users issue=#42`,
          "",
          `Alias: \`/${display.team}\` works too.`,
        ].join("\n")
      : [
          `Usage: /${display.team} <task description>  (alias for /${display.doWork})`,
          "",
          "Examples:",
          `  /${display.team} Add OAuth authentication with Google and GitHub`,
          `  /${display.team} [AUTONOMOUS] Fix the 500 error on /api/users issue=#42`,
        ].join("\n");
  }

  if (!cwd) return "ERROR: workflow cwd unavailable.";
  if (!parsedEnvelope) return "ERROR: workflow envelope unavailable.";
  const error = envelopeError(parsedEnvelope);
  if (error) return error;
  if (!parsedEnvelope.task) return "ERROR: empty task after stripping prefix.";
  ctx.ui.notify(`${displayName}: ${parsedEnvelope.task.slice(0, 60)} (workflow pending)`, "info");
  return promptBuilder(parsedEnvelope, cwd);
}

function buildCtoCommandPrompt(
  args: string,
  ctx: ExtensionCommandContext,
  ctoName: string,
  cwd: string | undefined,
  onCtoCommand?: WorkflowCommandOptions["onCtoCommand"],
): string {
  if (!cwd) return "ERROR: workflow cwd unavailable.";
  const sessionId = ctx.sessionManager.getSessionId();
  if (!args) {
    onCtoCommand?.({ cwd, sessionId, standby: true });
    ctx.ui.notify(`${ctoName}: standby mode — awaiting tasks via messenger inbox`, "info");
    return buildStandbyCtoPrompt(cwd);
  }

  const envelope = parseCtoEnvelope(args, cwd);
  if (envelope.specificationSelectionError) {
    return `ERROR: ${envelope.specificationSelectionError.code}: ${envelope.specificationSelectionError.message}`;
  }
  if (!envelope.task && !envelope.specificationSelections?.length) return "ERROR: empty task after stripping prefix.";
  const selectionSummary = envelope.specificationSelections?.map((selection) => `${selection.feature_id}/${selection.run_key}`).join(", ");
  const requestSummary = envelope.task || (selectionSummary ? `selected ${selectionSummary}` : "request");
  const active = findActiveCtoRun(cwd, { sessionId });
  onCtoCommand?.({ cwd, sessionId, ...(active ? { runId: active.runId } : {}), standby: false });
  if (active) {
    ctx.ui.notify(`${ctoName}: amending run ${active.runId} with: ${requestSummary.slice(0, 50)}`, "info");
    return buildAmendPrompt(envelope, cwd, active, { sessionId });
  }
  ctx.ui.notify(`${ctoName}: ${requestSummary.slice(0, 60)} (decomposition pending)`, "info");
  return buildCtoPrompt(envelope, cwd, { sessionId });
}

function buildSpecificationCommandPrompt(
  args: string,
  ctx: ExtensionCommandContext,
  command: SpecificationCommandName | "spec-import",
  publicName: string,
  cwd: string | undefined,
): string | Promise<string> {
  if (!args) {
    return command === "spec-import"
      ? specificationImportUsage(publicName)
      : specificationCommandUsage(command, publicName);
  }
  if (!cwd) return "ERROR: workflow cwd unavailable.";
  const commandContext: CommandContext = {
    args,
    cwd,
    sessionId: ctx.sessionManager.getSessionId(),
    ui: {
      notify: (message, kind) => ctx.ui.notify(message, kind as never),
    },
  };
  if (command === "specify") return specifyCommand(commandContext);
  if (command === "spec-plan") return specPlanCommand(commandContext);
  if (command === "spec-import") return specImportCommand(commandContext);
  return specTasksCommand(commandContext);
}

type BaseCommandName = "do-work" | "team" | "cto" | SpecificationCommandName | "spec-import";
function commandName(prefix: string | undefined, base: BaseCommandName): string {
  if (!prefix) return base;
  if (!/^[a-z][a-z0-9-]*$/.test(prefix)) throw new Error(`invalid command namespace '${prefix}'`);
  return `${prefix}-${base}`;
}

function commandActivationLiveGuard(
  pi: ExtensionAPI,
  slot: CommandActivationSlot,
  cwd: string,
  ctx: unknown,
): ExecutionLivenessGuard {
  return () => {
    requireCommandMountActive(pi);
    const state = commandOwnerStates.get(pi as object);
    if (!state?.slot || state.slot !== slot) {
      throw new Error("activation_identity_changed: registration activation was replaced");
    }
    const identityError = commandContextIdentityIssue(slot, cwd, ctx);
    if (identityError) throw new Error(identityError);
    requireRegistryContext(slot.context, cwd, "workflow_registration");
  };
}

function claimCommandOwner(
  pi: ExtensionAPI,
  options: WorkflowCommandOptions,
  cwd: string,
  ctx?: unknown,
  phase: "initial" | "session" | "command" = "command",
): ExecutionLivenessGuard | undefined {
  if (!options.owner) return undefined;
  const state = commandOwnerState(pi);
  if (phase === "session" || phase === "initial") state.disposed = false;
  if (state.disposed) throw new Error("activation_identity_changed: registration session is closed");
  const sessionId = commandSessionId(ctx);
  const existing = state.slot;
  const sessionChanged = phase === "session" && !!existing?.sessionId && !!sessionId && existing.sessionId !== sessionId;
  const revokedSessionChanged = phase === "session" && !existing && !!state.sessionId && !!sessionId && state.sessionId !== sessionId;
  if (state.revoked && !sessionChanged && !revokedSessionChanged) {
    throw new Error("activation_identity_changed: registration activation was revoked");
  }

  if (sessionChanged && existing) {
    try {
      const { sessionManager: _sessionManager, sessionFile: _sessionFile, sessionBasename: _sessionBasename, sessionGeneration: _sessionGeneration, ...rebindBase } = existing;
      const rebound = bindCommandContextIdentity({ ...rebindBase, sessionId }, cwd, ctx);
      requireRegistryContext(rebound.context, cwd, "workflow_registration");
      state.slot = rebound;
      state.sessionId = sessionId;
      state.revoked = false;
      state.disposed = false;
      return commandActivationLiveGuard(pi, rebound, cwd, ctx);
    } catch {
      disposeCommandOwnerActivation(pi);
      state.revoked = false;
      state.disposed = false;
    }
  } else if (revokedSessionChanged) {
    state.revoked = false;
    state.disposed = false;
  }

  const activeSlot = state.slot;
  if (activeSlot) {
    if (activeSlot.sessionId && sessionId && activeSlot.sessionId !== sessionId) {
      throw new Error("owner_conflict: registration context belongs to another session");
    }
    const boundSlot = bindCommandContextIdentity(activeSlot, cwd, ctx);
    try {
      requireRegistryContext(boundSlot.context, cwd, "workflow_registration");
      state.slot = phase === "session" && sessionId ? { ...boundSlot, sessionId } : boundSlot;
      if (phase === "session" && sessionId) state.sessionId = sessionId;
    } catch (error) {
      disposeCommandOwnerActivation(pi, true);
      state.revoked = true;
      throw error;
    }
    return commandActivationLiveGuard(pi, state.slot ?? activeSlot, cwd, ctx);
  }

  const owner = typeof options.owner === "function" ? options.owner(cwd) : options.owner;
  if (!owner.activation) {
    throw new Error("owner_invalid: activation descriptor is required for workflow command registration");
  }
  const rootIdentity = commandRootIdentity(cwd);
  const initialIdentity = commandContextIdentity(ctx);
  const initialSlotIdentity: CommandActivationSlot = {
    context: undefined as never,
    releaseToken: undefined as never,
    leasedCapabilities: [],
    ...rootIdentity,
    ...(initialIdentity ?? {}),
  };
  const initialIdentityError = commandContextIdentityIssue(initialSlotIdentity, cwd, ctx);
  if (initialIdentityError) throw new Error(initialIdentityError);
  const activation = openWorkflowActivation(cwd, ["workflow_registration"], owner);
  if (!activation.ok) {
    if (phase === "session" && state.mount === "active") {
      state.revoked = true;
      if (sessionId) state.sessionId = sessionId;
    }
    throw new Error(activation.code + ": " + activation.error);
  }
  const slot: CommandActivationSlot = {
    ...initialSlotIdentity,
    context: activation.registry_context,
    releaseToken: activation.release_token,
    leasedCapabilities: activation.leased_capabilities,
    ...(sessionId ? { sessionId } : {}),
  };
  state.slot = slot;
  if (sessionId) state.sessionId = sessionId;
  state.revoked = false;
  installCommandOwnerShutdown(pi);
  return commandActivationLiveGuard(pi, slot, cwd, ctx);
}

/** Register workflow entry points only after an owner activation is established. */
export function registerWorkflowCommands(pi: ExtensionAPI, options: WorkflowCommandOptions = {}): void {
  const prefix = options.commandPrefix ?? options.namespace;
  const names = {
    doWork: commandName(prefix, "do-work"),
    team: commandName(prefix, "team"),
    cto: commandName(prefix, "cto"),
    specify: commandName(prefix, "specify"),
    specPlan: commandName(prefix, "spec-plan"),
    specTasks: commandName(prefix, "spec-tasks"),
    specImport: commandName(prefix, "spec-import"),
  };
  const promptBuilder = options.buildDoWorkPrompt ?? buildDoWorkPrompt;
  const resolveEffectiveCwd = (ctx: ExtensionCommandContext): string | undefined => {
    if (options.cwd !== undefined) return options.cwd;
    if (options.resolveCwd) return options.resolveCwd(ctx);
    return resolveCommandCwd(ctx);
  };
  const claimForCommand = options.owner
    ? (cwd: string | undefined, ctx: ExtensionCommandContext): ExecutionLivenessGuard | undefined => {
        if (!cwd) throw new Error("workflow cwd unavailable.");
        return claimCommandOwner(pi, options, cwd, ctx, "command");
      }
    : undefined;
  const state = commandOwnerState(pi);
  const commandMountGuard = (): void => requireCommandMountActive(pi);
  const registerCommands = (cwd: string, ctx: unknown, phase: "initial" | "session"): void => {
    if (state.mount === "active") {
      if (phase === "session" || !state.slot) claimCommandOwner(pi, options, cwd, ctx, phase);
      return;
    }
    if (state.mount === "failed") throw new Error("owner_conflict: workflow command registration is failed");
    if (state.mount === "mounting") throw new Error("owner_conflict: workflow command registration is mounting");
    state.mount = "mounting";
    let hostRegistrationStarted = false;
    const finalActivationCheck = (): void => {
      const slot = state.slot;
      if (!slot) throw new Error("activation_identity_changed: registration activation was lost before host registration");
      requireRegistryContext(slot.context, cwd, "workflow_registration");
    };
    try {
      claimCommandOwner(pi, options, cwd, ctx, phase);
      finalActivationCheck();
      hostRegistrationStarted = true;
      registerPromptCommand(
        pi,
        names.doWork,
        options.doWorkDescription ?? doWorkDescription(names.doWork, names.team),
        (args, ctx, cwd, envelope) => buildDoWorkCommandPrompt(args, ctx, "do-work", names, promptBuilder, cwd, envelope),
        resolveEffectiveCwd,
        commandMountGuard,
        claimForCommand,
        parseWorkEnvelope,
      );
      finalActivationCheck();
      hostRegistrationStarted = true;
      registerPromptCommand(
        pi,
        names.team,
        options.teamDescription ?? teamDescription(names.doWork),
        (args, ctx, cwd, envelope) => buildDoWorkCommandPrompt(args, ctx, "team", names, promptBuilder, cwd, envelope),
        resolveEffectiveCwd,
        commandMountGuard,
        claimForCommand,
        parseWorkEnvelope,
      );
      finalActivationCheck();
      hostRegistrationStarted = true;
      registerPromptCommand(
        pi,
        names.cto,
        options.ctoDescription ?? ctoDescription(names.cto),
        (args, ctx, cwd) => buildCtoCommandPrompt(args, ctx, names.cto, cwd, options.onCtoCommand),
        resolveEffectiveCwd,
        commandMountGuard,
        claimForCommand,
      );
      for (const [command, publicName] of [
        ["specify", names.specify],
        ["spec-plan", names.specPlan],
        ["spec-tasks", names.specTasks],
        ["spec-import", names.specImport],
      ] as const) {
        finalActivationCheck();
        hostRegistrationStarted = true;
        registerPromptCommand(
          pi,
          publicName,
          command === "spec-import"
            ? specificationImportDescription(publicName)
            : specificationDescription(publicName, command),
          (args, ctx, cwd) => buildSpecificationCommandPrompt(args, ctx, command, publicName, cwd),
          resolveEffectiveCwd,
          commandMountGuard,
          claimForCommand,
        );
        finalActivationCheck();
      }
      state.mount = "active";
    } catch (error) {
      if (hostRegistrationStarted) failCommandMount(pi);
      else resetCommandMountAfterPreHostFailure(pi, phase === "session" ? commandSessionId(ctx) : undefined);
      throw error;
    }
  };

  if (!options.owner) {
    throw new Error("owner_invalid: activation descriptor is required for workflow command registration");
  }
  if (typeof options.owner !== "function" && !options.owner.activation) {
    throw new Error("owner_invalid: activation descriptor is required for workflow command registration");
  }
  if (options.owner && typeof options.owner !== "function" && options.cwd === undefined) {
    throw new Error("owner_invalid: static activation owner requires an explicit cwd");
  }
  if (options.owner && typeof pi.on !== "function") {
    throw new Error("owner_invalid: activation-bound commands require session lifecycle hooks");
  }

  if (state.mount === "failed") throw new Error("owner_conflict: workflow command registration is failed");
  if (state.mount === "active") return;
  if (state.mount === "mounting") throw new Error("owner_conflict: workflow command registration is mounting");

  if (options.cwd !== undefined) {
    registerCommands(options.cwd, undefined, "initial");
    return;
  }

  try {
    pi.on("session_start", (_event: unknown, ctx: unknown) => {
      const cwd = resolveEffectiveCwd(ctx as ExtensionCommandContext);
      if (!cwd) return;
      registerCommands(cwd, ctx, "session");
    });
  } catch (error) {
    resetCommandMountAfterPreHostFailure(pi);
    throw error;
  }
}
