/**
 * Orchestrator write policy gate.
 *
 * The OMP tool event does not expose the active agent identity, so the
 * user-controlled `actor`/`__omp_actor` input fields are never authorization
 * credentials. Runtime context is authoritative: interactive contexts are
 * orchestrators, non-UI subagent contexts are workers, and unknown contexts
 * fail closed for strict-state writes.
 */
import { isAbsolute, relative, resolve, dirname, join, sep } from "node:path";
import { existsSync, lstatSync, realpathSync } from "node:fs";
import { resolveState } from "../engine/state.js";

interface ToolCallEvent {
  toolName: string;
  input?: Record<string, unknown> | string;
}
interface ToolCallContext { cwd: string; hasUI?: boolean; actor?: Actor }

type Actor = "orchestrator" | "worker" | "lead";

// These are generic shell-capable execution surfaces. They are deliberately
// classified by tool identity, not by parsing command text or interpreter
// encodings; strict workers have no generic shell authorization path.
const GENERIC_SHELL_EXECUTION_TOOLS = new Set([
  "bash", "sh", "zsh", "fish", "shell", "exec", "execute", "run", "run_command", "command", "terminal",
  "node", "python", "python3", "perl", "ruby", "php",
]);
function isGenericShellExecutionTool(toolName: string): boolean {
  return GENERIC_SHELL_EXECUTION_TOOLS.has(toolName.toLowerCase());
}

export function orchestratorWriteGate(
  event: ToolCallEvent,
  ctx: ToolCallContext,
): { block?: boolean; reason?: string } | void {
  if (!hasStrictOrchestratorState(ctx.cwd)) return;
  if (event.toolName !== "write" && event.toolName !== "edit" && !isGenericShellExecutionTool(event.toolName)) return;
  // The host invokes mounted `xd://` devices through the generic write
  // transport. That transport is not a project filesystem mutation.
  if ((event.toolName === "write" || event.toolName === "edit") && isMountedToolRouteInput(event.input)) return;
  const actor = trustedActorOf(ctx);

  if (isGenericShellExecutionTool(event.toolName)) {
    // Generic shell-capable tools have no descriptor-bound authorization seam.
    // Strict workers must use scoped host Write/Edit or a trusted validation
    // owner; never parse shell text to guess whether it is read-only.
    const shellSurface = event.toolName === "bash" ? "shell-capable Bash execution" : "generic shell execution tool";
    return { block: true, reason: `orchestrator policy: strict workflows deny ${shellSurface}; got ${actor ?? "unknown"}` };
  }

  const paths = pathsFromInput(event.input);
  if (paths.length === 0) {
    return { block: true, reason: `orchestrator policy: ${actor ?? "unknown"} write/edit has no verifiable path` };
  }
  if (actor === "worker") {
    const authority = paths.find((path) => isEngineOwnedPath(path, ctx.cwd));
    if (authority) {
      return { block: true, reason: `orchestrator policy: engine-owned workflow authority tree; refused '${authority}'` };
    }
    return;
  }
  const canonical = paths.find((path) => isCanonicalStatePath(path, ctx.cwd));
  if (canonical) {
    return { block: true, reason: `orchestrator policy: canonical workflow state is engine-owned; refused '${canonical}'` };
  }
  if (actor !== "orchestrator" && actor !== "lead") {
    return { block: true, reason: "orchestrator policy: trusted actor identity is required for source writes" };
  }
  const invalid = paths.find((path) => !isWorkStatePath(path, ctx.cwd));
  if (invalid) {
    return { block: true, reason: `orchestrator policy: ${actor} may write only under .work-state; refused '${invalid}'` };
  }
}

function trustedActorOf(ctx: ToolCallContext): Actor | undefined {
  if (ctx.actor === "orchestrator" || ctx.actor === "worker" || ctx.actor === "lead") return ctx.actor;
  if (ctx.hasUI === true) return "orchestrator";
  if (ctx.hasUI === false) return "worker";
  return undefined;
}

/** Diagnostic parser only. Values from tool input are never authorization. */
export function actorOf(input: Record<string, unknown> | undefined): Actor | undefined {
  const raw = input?.__omp_actor ?? input?.actor;
  return raw === "orchestrator" || raw === "worker" || raw === "lead" ? raw : undefined;
}

function pathsFromInput(input: ToolCallEvent["input"]): string[] {
  if (typeof input === "string") return pathsFromPatch(input);

  const paths: string[] = [];
  const raw = input?.path ?? input?.file_path ?? input?.paths;
  if (typeof raw === "string") paths.push(raw);
  if (Array.isArray(raw)) paths.push(...raw.filter((p): p is string => typeof p === "string"));
  if (typeof input?.input === "string") paths.push(...pathsFromPatch(input.input));
  return paths;
}

function pathsFromPatch(patch: string): string[] {
  const paths: string[] = [];
  const header = /^\[([^#\]\r\n]+)#[0-9A-Fa-f]{4}\]\s*$/gm;
  for (const match of patch.matchAll(header)) {
    const path = match[1];
    if (path) paths.push(path);
  }
  return paths;
}

function isMountedToolRouteInput(input: ToolCallEvent["input"]): boolean {
  const paths = pathsFromInput(input);
  return paths.length > 0 && paths.every((path) => path.trim().toLowerCase().startsWith("xd://"));
}



function isEngineOwnedTreePath(path: string, cwd: string, treeName: ".work-state" | ".omp"): boolean {
  const absolute = isAbsolute(path) ? resolve(path) : resolve(cwd, path);
  const treeRoot = resolve(cwd, treeName);
  const logical = relative(treeRoot, absolute);
  const logicalInside = logical === "" || (!logical.startsWith(`..${sep}`) && logical !== ".." && !isAbsolute(logical));
  if (logicalInside) return true;
  try {
    const realRoot = realpathSync(treeRoot);
    let existing = absolute;
    while (!existsSync(existing)) {
      const parent = dirname(existing);
      if (parent === existing) return false;
      existing = parent;
    }
    const realExisting = realpathSync(existing);
    const realCandidate = resolve(realExisting, relative(existing, absolute));
    const physical = relative(realRoot, realCandidate);
    return physical === "" || (!physical.startsWith(`..${sep}`) && physical !== ".." && !isAbsolute(physical));
  } catch {
    return false;
  }
}

function isWorkStateTreePath(path: string, cwd: string): boolean {
  return isEngineOwnedTreePath(path, cwd, ".work-state");
}

function isControlPlaneTreePath(path: string, cwd: string): boolean {
  return isEngineOwnedTreePath(path, cwd, ".omp");
}

function isEngineOwnedPath(path: string, cwd: string): boolean {
  return isWorkStateTreePath(path, cwd) || isControlPlaneTreePath(path, cwd);
}
function isWorkStatePath(path: string, cwd: string): boolean {
  const absolute = isAbsolute(path) ? resolve(path) : resolve(cwd, path);
  const workState = resolve(cwd, ".work-state");
  const rel = relative(workState, absolute);
  if (rel !== "" && (rel.startsWith(`..${sep}`) || rel === ".." || isAbsolute(rel))) return false;
  try {
    // Orchestrator/lead writes are allowed only below the project's physical
    // .work-state directory. A lexical path (or a realpath rooted at a
    // symlink) is not sufficient: accepting a symlinked .work-state would
    // authorize writes into an external tree.
    const expectedRoot = resolve(realpathSync(cwd), ".work-state");
    const rootStat = lstatSync(workState);
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) return false;
    const realRoot = realpathSync(workState);
    if (realRoot !== expectedRoot) return false;

    // Resolve the nearest existing ancestor without following any symlinked
    // component. This keeps nested, not-yet-created targets usable while
    // rejecting both existing and broken symlink escapes.
    let existing = absolute;
    while (true) {
      let stat;
      try {
        stat = lstatSync(existing);
      } catch (error) {
        const code = error && typeof error === "object" && "code" in error
          ? (error as { code?: unknown }).code
          : undefined;
        if (code !== "ENOENT" && code !== "ENOTDIR") return false;
        const parent = dirname(existing);
        if (parent === existing) return false;
        existing = parent;
        continue;
      }
      if (stat.isSymbolicLink()) return false;
      break;
    }
    const realExisting = realpathSync(existing);
    const realCandidate = resolve(realExisting, relative(existing, absolute));
    const realRel = relative(realRoot, realCandidate);
    return realRel === "" || (!realRel.startsWith(`..${sep}`) && realRel !== ".." && !isAbsolute(realRel));
  } catch {
    return false;
  }
}

function isCanonicalStatePath(path: string, cwd: string): boolean {
  const absolute = isAbsolute(path) ? resolve(path) : resolve(cwd, path);
  const canonical = (rel: string): boolean =>
    rel === ".active-feature" || rel === "team-state.json" || /^features\/[^/]+\/state\.json$/.test(rel) || /^cto\/[^/]+\/state\.json$/.test(rel);
  const workState = resolve(cwd, ".work-state");
  if (canonical(relative(workState, absolute).split(sep).join("/"))) return true;
  try {
    const realRoot = realpathSync(workState);
    const parent = realpathSync(dirname(absolute));
    const realCandidate = existsSync(absolute) ? realpathSync(absolute) : join(parent, absolute.slice(dirname(absolute).length + 1));
    return canonical(relative(realRoot, realCandidate).split(sep).join("/"));
  } catch {
    return false;
  }
}

export function hasStrictOrchestratorState(cwd: string): boolean {
  const resolved = resolveState(cwd);
  if (resolved.invalid) return true;
  return resolved.state?.policy?.strict_orchestrator === true;
}

// ── Bounded write_scope experiment (scope 7) ───────────────────────────────
//
// Descriptor-bound worker mutation policy, OFF by default. The declaration
// remains part of the bundle shape for compatibility, but no generic host
// write/edit/Bash mutation is authorized until a descriptor-bound execution
// route exists. Shipped defaults keep the single-writer model.

export interface WorkerWriteScope {
  enabled: boolean;
  /** Legacy scope declaration retained for strict shape validation. */
  allow: string[];
  /** Legacy deny declaration retained for strict shape validation. */
  deny?: string[];
}

const DESCRIPTOR_BOUND_MUTATION_UNAVAILABLE = "write_scope: descriptor_bound_mutation_unavailable";

/**
 * Experimental worker write_scope contract. The host's generic write/edit and
 * Bash tools execute pathnames after this hook returns; without a
 * descriptor-bound host route, allowing even an apparently in-scope target
 * would leave a TOCTOU race. Enabled scopes therefore fail closed for every
 * mutation. Generic shell execution remains denied even for read-only-looking
 * commands; no shell-text parser is an authorization mechanism. The flag stays off by default.
 */
export function workerWriteScopeGate(
  event: ToolCallEvent,
  ctx: ToolCallContext & { writeScope?: WorkerWriteScope },
): { block?: boolean; reason?: string } | void {
  const scope = ctx.writeScope;
  if (scope === undefined || scope === null || scope.enabled === false) return;
  if (event.toolName !== "write" && event.toolName !== "edit" && !isGenericShellExecutionTool(event.toolName)) return;
  if ((event.toolName === "write" || event.toolName === "edit") && isMountedToolRouteInput(event.input)) return;
  if (trustedActorOf(ctx) !== "worker") return;
  if (scope.enabled !== true) return { block: true, reason: "write_scope: malformed scope enablement" };
  if (!Array.isArray(scope.allow) || scope.allow.some((pattern) => typeof pattern !== "string")
    || (scope.deny !== undefined && (!Array.isArray(scope.deny) || scope.deny.some((pattern) => typeof pattern !== "string")))) {
    return { block: true, reason: "write_scope: malformed scope patterns" };
  }

  if (isGenericShellExecutionTool(event.toolName)) {
    return { block: true, reason: `${DESCRIPTOR_BOUND_MUTATION_UNAVAILABLE}: generic shell execution requires a descriptor-bound host route` };
  }
  return { block: true, reason: `${DESCRIPTOR_BOUND_MUTATION_UNAVAILABLE}: generic host ${event.toolName} cannot bind a pinned descriptor` };
}
