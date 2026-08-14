/**
 * Orchestrator write policy gate.
 *
 * The OMP tool event does not currently expose the active agent identity. This
 * gate therefore enforces the policy when the adapter supplies the explicit
 * `__omp_actor`/`actor` marker, while remaining inert for unmarked worker calls.
 * The marker is intentionally not inferred from tool text or task prompts.
 */
import { isAbsolute, relative, resolve } from "node:path";
import { existsSync, readFileSync } from "node:fs";

interface ToolCallEvent {
  toolName: string;
  input?: Record<string, unknown>;
}
interface ToolCallContext { cwd: string }

type Actor = "orchestrator" | "worker" | "lead";

export function orchestratorWriteGate(
  event: ToolCallEvent,
  ctx: ToolCallContext,
): { block?: boolean; reason?: string } | void {
  if (!hasStrictOrchestratorState(ctx.cwd)) return;
  const actor = actorOf(event.input);
  if (actor !== "orchestrator" && actor !== "lead") return;
  if (event.toolName !== "write" && event.toolName !== "edit" && event.toolName !== "bash") return;

  if (event.toolName === "bash") {
    const command = String(event.input?.command ?? "");
    if (looksLikeSourceMutation(command)) {
      return { block: true, reason: `orchestrator policy: ${actor} may not mutate application source via bash; delegate source changes to a worker` };
    }
    return;
  }

  const paths = pathsFromInput(event.input);
  if (paths.length === 0) {
    return { block: true, reason: `orchestrator policy: ${actor} write/edit has no verifiable path` };
  }
  const invalid = paths.find((path) => !isWorkStatePath(path, ctx.cwd));
  if (invalid) {
    return { block: true, reason: `orchestrator policy: ${actor} may write only under .work-state; refused '${invalid}'` };
  }
}

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
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function looksLikeSourceMutation(command: string): boolean {
  return /(?:\b(?:tee|cat|printf|python|node|perl|ruby)\b[^\n]*(?:>|>>)|\b(?:sed|perl)\b[^\n]*-i\b|\bgit\s+(?:apply|checkout|restore)\b)/i.test(command);
}

export function hasStrictOrchestratorState(cwd: string): boolean {
  const path = resolve(cwd, ".work-state", "team-state.json");
  if (!existsSync(path)) return false;
  try {
    const state = JSON.parse(readFileSync(path, "utf8")) as { policy?: { strict_orchestrator?: boolean } };
    return state.policy?.strict_orchestrator === true;
  } catch {
    return false;
  }
}
