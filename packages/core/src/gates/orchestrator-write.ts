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

interface ToolCallEvent {
  toolName: string;
  input?: Record<string, unknown>;
}
interface ToolCallContext { cwd: string; hasUI?: boolean; actor?: Actor }

type Actor = "orchestrator" | "worker" | "lead";

export function orchestratorWriteGate(
  event: ToolCallEvent,
  ctx: ToolCallContext,
): { block?: boolean; reason?: string } | void {
  if (!hasStrictOrchestratorState(ctx.cwd)) return;
  if (event.toolName !== "write" && event.toolName !== "edit" && event.toolName !== "bash") return;
  const actor = trustedActorOf(ctx);

  if (event.toolName === "bash") {
    const command = String(event.input?.command ?? "");
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

function pathsFromInput(input: Record<string, unknown> | undefined): string[] {
  const raw = input?.path ?? input?.file_path ?? input?.paths;
  if (typeof raw === "string") return [raw];
  if (Array.isArray(raw)) return raw.filter((p): p is string => typeof p === "string");
  return [];
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
  const workflowPath = /(?:^|[\s"'`])(?:\.\/)?\.work-state(?:[\/\s"'`]|$)|(?:^|[\s"'`])(?:\.\/)?(?:team-state\.json|\.active-feature)(?:[\s"'`]|$)/i;
  if (!workflowPath.test(command)) return false;
  return /(?:>|>>|tee\b|(?:cp|mv|install|touch|rm|rmdir|truncate|dd|ln|chmod|rsync|patch|ed|sponge)\b|(?:sed|perl)\b[^\n]*(?:\s-i(?:\s|$)|--in-place\b)|(?:g?awk)\b[^\n]*(?:\s-i(?:\s|$)|--in-place\b)|(?:python|node|ruby)\b[^\n]*(?:-c|--eval)[^\n]*(?:writeFile|write_text|open\(|unlink|rename|mkdir)\b|git\s+(?:apply|checkout|restore|reset|clean|mv|rm|show|stash)\b)/i.test(command);
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


function looksLikeSourceMutation(command: string): boolean {
  return /(?:\b(?:tee)\b|\b(?:cat|printf|echo)\b[^\n]*(?:>|>>|<<)|(?:>|>>)\s*(?:\.\/)?(?:src|packages|test|tests|app|config)(?:[\/\s"'`]|$)|\b(?:cp|mv|install|touch|rm|rmdir|truncate|dd|ln|rsync|patch|ed|sponge)\b|\b(?:sed|perl)\b[^\n]*(?:\s-i(?:\s|$)|--in-place\b)|\b(?:g?awk)\b[^\n]*(?:\s-i(?:\s|$)|--in-place\b)|\bgit\s+(?:apply|checkout|restore|reset|clean|mv|rm|commit|merge|rebase|cherry-pick|stash)\b|\bgit\s+show\b[^\n]*(?:>|>>)\s*(?:\.\/)?(?:src|packages|test|tests|app|config)(?:[\/\s"'`]|$)|\b(?:python|node|ruby)\b[^\n]*(?:-c|--eval)[^\n]*(?:writeFile|write_text|open\(|unlink|rename|mkdir)\b)/i.test(command);
}

export function hasStrictOrchestratorState(cwd: string): boolean {
  const resolved = resolveState(cwd);
  if (resolved.invalid) return true;
  return resolved.state?.policy?.strict_orchestrator === true;
}
