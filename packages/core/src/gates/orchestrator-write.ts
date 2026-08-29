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
import { existsSync, realpathSync } from "node:fs";
import { resolveState } from "../engine/state.js";
import { validateWorkflowRunIdentity } from "../workflow-v2/identity.js";
import type { WorkflowRunIdentity } from "../workflow-v2/types.js";

interface ToolCallEvent {
  toolName: string;
  input?: Record<string, unknown> | string;
}
interface ToolCallContext {
  cwd: string;
  hasUI?: boolean;
  actor?: Actor;
  run_identity?: WorkflowRunIdentity;
}

type Actor = "orchestrator" | "worker" | "lead";

export function orchestratorWriteGate(
  event: ToolCallEvent,
  ctx: ToolCallContext,
): { block?: boolean; reason?: string } | void {
  if (event.toolName !== "write" && event.toolName !== "edit" && event.toolName !== "bash") return;
  // The host invokes mounted `xd://` devices through the generic write
  // transport. That transport is not a project filesystem mutation.
  if (event.toolName !== "bash" && isMountedToolRouteInput(event.input)) return;
  if (existsSync(resolve(ctx.cwd, ".work-state")) && !ctx.run_identity) {
    return {
      block: true,
      reason: "orchestrator policy: MIGRATION_REQUIRED — a WorkflowRunIdentity is required for strict workflow writes",
    };
  }
  if (ctx.run_identity !== undefined && !validateWorkflowRunIdentity(ctx.run_identity).ok) {
    return {
      block: true,
      reason: "orchestrator policy: MIGRATION_REQUIRED — the supplied WorkflowRunIdentity is incomplete or invalid",
    };
  }
  if (!hasStrictOrchestratorState(ctx.cwd, ctx.run_identity)) return;
  const actor = trustedActorOf(ctx);

  if (event.toolName === "bash") {
    const command = commandFromInput(event.input);
    const targets = bashMutationTargets(command);
    const canonical = targets.find((path) => isCanonicalStatePath(path, ctx.cwd));
    if (canonical || looksLikeWorkflowStateMutation(command)) {
      return { block: true, reason: `orchestrator policy: canonical workflow state is engine-owned; refused bash mutation${canonical ? ` '${canonical}'` : ""}` };
    }
    const projectTarget = targets.find((path) => isProjectPath(path, ctx.cwd) && !isWorkStatePath(path, ctx.cwd));
    if (projectTarget && actor !== "worker") {
      return { block: true, reason: `orchestrator policy: source mutation via bash requires a trusted worker actor; got ${actor ?? "unknown"}` };
    }
    if (looksLikeSourceMutation(command) && actor !== "worker") {
      return { block: true, reason: `orchestrator policy: source mutation via bash requires a trusted worker actor; got ${actor ?? "unknown"}` };
    }
    return;
  }

  const paths = pathsFromInput(event.input);
  if (paths.length === 0) {
    return { block: true, reason: `orchestrator policy: ${actor ?? "unknown"} write/edit has no verifiable path` };
  }
  const canonical = paths.find((path) => isCanonicalStatePath(path, ctx.cwd));
  if (canonical) {
    return { block: true, reason: `orchestrator policy: canonical workflow state is engine-owned; refused '${canonical}'` };
  }
  if (actor === "worker") return;
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

function commandFromInput(input: ToolCallEvent["input"]): string {
  if (typeof input === "string") return input;
  if (!input) return "";
  return String(input.command ?? "");
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

function isWorkStatePath(path: string, cwd: string): boolean {
  const absolute = isAbsolute(path) ? resolve(path) : resolve(cwd, path);
  const workState = resolve(cwd, ".work-state");
  const rel = relative(workState, absolute);
  if (rel !== "" && (rel.startsWith(`..${sep}`) || rel === ".." || isAbsolute(rel))) return false;
  try {
    const realRoot = realpathSync(workState);
    const realCandidate = existsSync(absolute)
      ? realpathSync(absolute)
      : resolve(realpathSync(dirname(absolute)), absolute.slice(dirname(absolute).length + 1));
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

function looksLikeWorkflowStateMutation(command: string): boolean {
  const workflowPath =
    /(?:^|[\s"'`/])(?:\.\/)?\.work-state\/(?:team-state\.json|\.active-feature|features\/[A-Za-z0-9._-]+\/state\.json|cto\/[A-Za-z0-9._-]+\/state\.json)(?=$|[\s"'`;&|),])|(?:^|[\s"'`])(?:\.\/)?(?:team-state\.json|\.active-feature)(?=$|[\s"'`;&|),])/i;
  if (!workflowPath.test(command) && !hasRelativeWorkflowStateContext(command)) return false;
  return /(?:>|>>|tee\b|(?:cp|mv|install|touch|rm|rmdir|truncate|dd|ln|chmod|rsync|patch|ed|sponge)\b|(?:sed|perl)\b[^\n]*(?:\s-i(?:\s|$)|--in-place\b)|(?:g?awk)\b[^\n]*(?:\s-i(?:\s|$)|--in-place\b)|(?:python(?:3)?|node|ruby)\b[^\n]*(?:-c|--eval)[^\n]*(?:writeFile(?:Sync)?|appendFile(?:Sync)?|write_text|write_bytes|unlink|rename|mkdir|rmdir|remove|replace)\b|(?:python(?:3)?|ruby)\b[^\n]*(?:-c|--eval)[^\n]*open\([^\n)]*,\s*["\'][^"\']*[wax+][^"\']*["\']|git\s+(?:apply|checkout|restore|reset|clean|mv|rm|show|stash)\b)/i.test(command);
}

function hasRelativeWorkflowStateContext(command: string): boolean {
  const cd = /(?:^|[;&|]\s*)cd\s+(?:"([^"]+)"|'([^']+)'|([^\s;&|]+))/gi;
  const rootRelative = /(?:^|[\s"'`])(?:\.\/)?(?:team-state\.json|\.active-feature|(?:features|cto)\/[A-Za-z0-9._-]+\/state\.json)(?=$|[\s"'`;&|),])/i;
  const nestedRelative = /(?:^|[\s"'`])(?:\.\/)?state\.json(?=$|[\s"'`;&|),])/i;

  for (const match of command.matchAll(cd)) {
    const directory = (match[1] ?? match[2] ?? match[3] ?? "").replace(/\/+$/, "");
    const afterCd = command.slice((match.index ?? 0) + match[0].length);
    if (/(?:^|\/)\.work-state$/.test(directory) && rootRelative.test(afterCd)) return true;
    if (/(?:^|\/)\.work-state\/features\/[A-Za-z0-9._-]+$/.test(directory) && nestedRelative.test(afterCd)) return true;
    if (/(?:^|\/)\.work-state\/cto\/[A-Za-z0-9._-]+$/.test(directory) && nestedRelative.test(afterCd)) return true;
  }
  return false;
}
function bashMutationTargets(command: string): string[] {
  const targets: string[] = [];
  const redirection = /(?:^|[\s;&|])>>?\s*(?:"([^"]+)"|'([^']+)'|([^\s;&|]+))/g;
  for (const match of command.matchAll(redirection)) {
    const target = match[1] ?? match[2] ?? match[3];
    if (target) targets.push(target);
  }
  const dd = /\bdd\b[^\n]*\bof=(?:"([^"]+)"|'([^']+)'|([^\s;&|]+))/gi;
  for (const match of command.matchAll(dd)) {
    const target = match[1] ?? match[2] ?? match[3];
    if (target) targets.push(target);
  }
  const tee = /(?:^|[;&|]\s*)tee(?:\s+-[^\s]+)*\s+(?:"([^"]+)"|'([^']+)'|([^\s;&|]+))/gi;
  for (const match of command.matchAll(tee)) {
    const target = match[1] ?? match[2] ?? match[3];
    if (target) targets.push(target);
  }
  return targets;
}

function isProjectPath(path: string, cwd: string): boolean {
  const root = resolve(cwd);
  const absolute = isAbsolute(path) ? resolve(path) : resolve(cwd, path);
  const rel = relative(root, absolute);
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}


const CHECKOUT_PATH_MUTATION = /\bgit\s+checkout\b[^;&|]*(?:--(?:\s|$)|(?:^|\s)(?:\.{1,2}|\/)(?:[\/\s"'`]|$)|(?:^|\s)(?:src|packages|test|tests|app|config)(?:[\/\s"'`]|$))/i;
const CHECKOUT_FORCE_MUTATION = /(?:^|[;&|]\s*)git\s+checkout\b[^;&|]*(?:--force\b|(?:^|\s)-f(?:\s|$|[;&|]))/;
const CHECKOUT_FORCE_BRANCH_MUTATION = /(?:^|[;&|]\s*)git\s+checkout\b[^;&|]*(?:^|\s)-B(?:\s|$|[;&|])/;
const SWITCH_DISCARD_MUTATION = /(?:^|[;&|]\s*)git\s+switch\b[^;&|]*--discard-changes\b/i;
const SWITCH_FORCE_BRANCH_MUTATION = /(?:^|[;&|]\s*)git\s+switch\b[^;&|]*(?:^|\s)-C(?:\s|$|[;&|])/;

/**
 * Detect direct source/worktree mutations that the orchestrator must not perform.
 *
 * Commit/publication and history-integration commands (`git commit`, `git push`,
 * `git fetch`, `git merge`, `git rebase`, `git cherry-pick`, `gh pr create`)
 * reconcile or publish delegated work and are intentionally not matched here.
 * Branch setup is also allowed; only checkout/switch forms that restore or
 * discard worktree contents remain blocked.
 */
function looksLikeSourceMutation(command: string): boolean {
  return /(?:\b(?:tee)\b|\b(?:cat|printf|echo)\b[^\n]*(?:>|>>|<<)|(?:>|>>)\s*(?:\.\/)?(?:src|packages|test|tests|app|config)(?:[\/\s"'`]|$)|\b(?:cp|mv|install|touch|rm|rmdir|truncate|dd|ln|rsync|patch|ed|sponge)\b|\b(?:sed|perl)\b[^\n]*(?:\s-i(?:\s|$)|--in-place\b)|\b(?:g?awk)\b[^\n]*(?:\s-i(?:\s|$)|--in-place\b)|\bgit\s+(?:apply|restore|reset|clean|mv|rm|stash)\b|\bgit\s+show\b[^\n]*(?:>|>>)\s*(?:\.\/)?(?:src|packages|test|tests|app|config)(?:[\/\s"'`]|$)|\b(?:python(?:3)?|node|ruby)\b[^\n]*(?:-c|--eval)[^\n]*(?:writeFile(?:Sync)?|appendFile(?:Sync)?|write_text|write_bytes|unlink|rename|mkdir|rmdir|remove|replace)\b|(?:python(?:3)?|ruby)\b[^\n]*(?:-c|--eval)[^\n]*open\([^\n)]*,\s*["'][^"']*[wax+][^"']*["'])/i.test(command)
    || CHECKOUT_PATH_MUTATION.test(command)
    || CHECKOUT_FORCE_MUTATION.test(command)
    || CHECKOUT_FORCE_BRANCH_MUTATION.test(command)
    || SWITCH_DISCARD_MUTATION.test(command)
    || SWITCH_FORCE_BRANCH_MUTATION.test(command);
}

export function hasStrictOrchestratorState(cwd: string, runIdentity?: WorkflowRunIdentity): boolean {
  if (runIdentity === undefined) return existsSync(resolve(cwd, ".work-state"));
  if (!validateWorkflowRunIdentity(runIdentity).ok) return true;
  const resolved = resolveState(cwd, undefined, runIdentity);
  if (resolved.invalid) return true;
  const state = resolved.state;
  if (!state) return false;
  const persistedRun = (state as unknown as { run_identity?: unknown }).run_identity;
  const checked = validateWorkflowRunIdentity(persistedRun);
  if (!checked.ok) return true;
  return checked.value.run_id === runIdentity.run_id
    && checked.value.profile_identity.id === runIdentity.profile_identity.id
    && checked.value.profile_identity.fingerprint === runIdentity.profile_identity.fingerprint
    && state.policy?.strict_orchestrator === true;
}

// ── Bounded write_scope experiment (scope 7) ───────────────────────────────
//
// Advisory-only worker path matcher, OFF by default. When enabled it is
// composed AFTER orchestratorWriteGate and can only ADD blocks (narrow the
// paths a worker may write); it can never weaken the orchestrator boundary
// or the canonical-state protection. Shipped defaults keep the single-writer
// model: no write_scope is configured unless a bundle opts in explicitly.

export interface WorkerWriteScope {
  enabled: boolean;
  /** Glob patterns a worker may write (relative to the project root). */
  allow: string[];
  /** Glob patterns a worker may never write (deny wins over allow). */
  deny?: string[];
}

function matchesAnyGlob(path: string, patterns: string[]): boolean {
  const normalized = path.replace(/\\/g, "/");
  for (const pattern of patterns) {
    const candidate = pattern.replace(/\\/g, "/");
    if (candidate === normalized) return true;
    if (candidate.endsWith("/**") && normalized.startsWith(candidate.slice(0, -3))) return true;
    if (candidate.endsWith("/") && normalized.startsWith(candidate)) return true;
    const base = candidate.replace(/\/\*$/u, "");
    if (base !== candidate && (normalized === base || normalized.startsWith(`${base}/`))) return true;
  }
  return false;
}

/**
 * Narrowing gate for worker source writes. Composed after
 * orchestratorWriteGate in `registerTeamWorkflow`; it only ever blocks
 * worker writes outside the declared scope. Non-worker actors and disabled
 * scopes are unaffected.
 */
export function workerWriteScopeGate(
  event: ToolCallEvent,
  ctx: ToolCallContext & { writeScope?: WorkerWriteScope },
): { block?: boolean; reason?: string } | void {
  const scope = ctx.writeScope;
  if (!scope?.enabled) return;
  if (event.toolName !== "write" && event.toolName !== "edit" && event.toolName !== "bash") return;
  if (event.toolName !== "bash" && isMountedToolRouteInput(event.input)) return;
  if (trustedActorOf(ctx) !== "worker") return;
  const paths = event.toolName === "bash" ? bashMutationTargets(commandFromInput(event.input)) : pathsFromInput(event.input);
  if (paths.length === 0) return;
  for (const path of paths) {
    const absolute = isAbsolute(path) ? resolve(path) : resolve(ctx.cwd, path);
    const rel = relative(resolve(ctx.cwd), absolute);
    if (rel.startsWith("..") || isAbsolute(rel)) {
      return { block: true, reason: `write_scope: worker target '${path}' escapes the project root` };
    }
    if (matchesAnyGlob(rel, scope.deny ?? [])) {
      return { block: true, reason: `write_scope: worker write to '${rel}' is denied by write_scope` };
    }
    if (!matchesAnyGlob(rel, scope.allow)) {
      return { block: true, reason: `write_scope: worker write to '${rel}' is outside the declared write scope` };
    }
  }
}
