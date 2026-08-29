import type { ExtensionAPI, ExtensionUIContext } from "@oh-my-pi/pi-coding-agent";
import type { AgentRef, ProjectRuntimeKey, SessionIdentity } from "@andvl1/omp-workflows-core";

interface ComponentLike {
  render(width: number): readonly string[];
}

export const TASK_SUBAGENT_LIFECYCLE_CHANNEL = "task:subagent:lifecycle";
export const TASK_SUBAGENT_PROGRESS_CHANNEL = "task:subagent:progress";
export const SUBAGENT_CARD_TYPE = "omp-subagent-card";
export const SUBAGENT_TREE_WIDGET_KEY = "omp-subagent-hud";
export const MAX_RENDER_LINES = 12;

export type SubagentStatus = "running" | "completed" | "failed" | "aborted";

interface SubagentProgress {
  id?: string;
  currentTool?: string;
  tokens?: number;
}

interface SubagentLifecyclePayload {
  id: string;
  agent: string;
  agent_ref?: AgentRef;
  parentToolCallId?: string;
  description?: string;
  status: SubagentStatus;
}

interface SubagentProgressPayload {
  progress: SubagentProgress;
}

export interface SubagentCardData {
  id: string;
  agent: string;
  agent_ref?: AgentRef;
  parentToolCallId?: string;
  description?: string;
  tokens?: number;
  currentTool?: string;
  startedAtMs: number;
  finishedAtMs?: number;
  status: SubagentStatus;
}

export interface SubagentTreePersistedState {
  enabled: boolean;
  mode: "compact" | "expanded";
}

/** Host-managed persistence; path selection and filesystem authority stay outside the bundle. */
export interface SubagentTreePersistence {
  readonly read: () => SubagentTreePersistedState | undefined;
  readonly write: (state: SubagentTreePersistedState) => void;
  readonly dispose?: () => void | Promise<void>;
}

export interface SubagentTreeRegistrationContext {
  readonly runtime_key: ProjectRuntimeKey;
  readonly session: SessionIdentity;
  readonly persistence?: SubagentTreePersistence;
  readonly initial?: SubagentTreePersistedState;
}

export interface SubagentNode {
  readonly id: string;
  readonly parentToolCallId?: string;
  readonly agent: string;
  readonly agent_ref?: AgentRef;
  readonly description?: string;
  status: SubagentStatus;
  progress?: SubagentProgress;
  readonly startedAtMs: number;
  finishedAtMs?: number;
}

const STATUS_GLYPH: Record<SubagentStatus, string> = {
  running: "\u2699",
  completed: "\u2713",
  failed: "\u2717",
  aborted: "\u00b7",
};
const FINISHED_HOLD_MS = 5_000;
const WIDGET_HEADER = "Subagents";

function formatTokens(tokens: number): string {
  return tokens >= 1000 ? `${(tokens / 1000).toFixed(1)}k` : `${tokens}`;
}

function formatDuration(ms: number): string {
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  return `${minutes}m${remainder.toString().padStart(2, "0")}s`;
}

function clampText(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 3)}...` : text;
}

function isLifecyclePayload(value: unknown): value is SubagentLifecyclePayload {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  if (typeof candidate.id !== "string" || typeof candidate.agent !== "string") return false;
  const status = candidate.status;
  if (status === "started") {
    candidate.status = "running";
    return true;
  }
  return status === "running" || status === "completed" || status === "failed" || status === "aborted";
}

function isProgressPayload(value: unknown): value is SubagentProgressPayload {
  if (!value || typeof value !== "object") return false;
  const progress = (value as Record<string, unknown>).progress;
  if (!progress || typeof progress !== "object") return false;
  const candidate = progress as Record<string, unknown>;
  return typeof candidate.id === "string";
}

export function readPersistedState(persistence?: SubagentTreePersistence): SubagentTreePersistedState {
  try {
    const state = persistence?.read();
    if (!state || typeof state !== "object") return { enabled: true, mode: "compact" };
    return { enabled: state.enabled !== false, mode: state.mode === "expanded" ? "expanded" : "compact" };
  } catch {
    return { enabled: true, mode: "compact" };
  }
}

export function writePersistedState(persistence: SubagentTreePersistence | undefined, state: SubagentTreePersistedState): void {
  try {
    persistence?.write({ enabled: state.enabled, mode: state.mode });
  } catch {
    // Persistence is a presentation concern and never interrupts the agent loop.
  }
}

export function renderSubagentCompactLine(nodes: SubagentNode[]): string[] {
  const running = nodes.filter((node) => node.status === "running");
  if (running.length === 0) return [];
  const counts: Record<string, number> = {};
  for (const node of running) counts[node.agent] = (counts[node.agent] ?? 0) + 1;
  const agents = Object.entries(counts)
    .sort((left, right) => right[1] - left[1])
    .slice(0, 6)
    .map(([agent, count]) => count > 1 ? `${count}\u00d7 ${agent}` : agent)
    .join(" \u00b7 ");
  return [`${WIDGET_HEADER}: ${running.length} running${agents ? `  \u2502  ${agents}` : ""}`];
}

export function renderSubagentTree(nodes: SubagentNode[]): string[] {
  if (nodes.length === 0) return [];
  const byParent = new Map<string | undefined, SubagentNode[]>();
  for (const node of nodes) {
    const list = byParent.get(node.parentToolCallId);
    if (list) list.push(node);
    else byParent.set(node.parentToolCallId, [node]);
  }
  const lines: string[] = [`\u2500\u2500 ${WIDGET_HEADER} (${nodes.length}) \u2500\u2500`];
  const roots = [...(byParent.get(undefined) ?? [])].sort((left, right) => left.startedAtMs - right.startedAtMs);
  for (let index = 0; index < roots.length; index += 1) appendNode(lines, roots[index]!, byParent, "", index === roots.length - 1);
  if (lines.length > MAX_RENDER_LINES) {
    const truncated = lines.length - MAX_RENDER_LINES;
    lines.length = MAX_RENDER_LINES;
    lines.push(`\u2937 (+${truncated} more \u2014 /subagents compact)`);
  }
  return lines;
}

function appendNode(lines: string[], node: SubagentNode, byParent: Map<string | undefined, SubagentNode[]>, prefix: string, isLast: boolean): void {
  const branch = `${prefix}${isLast ? "\u2514\u2500 " : "\u251c\u2500 "}`;
  lines.push(`${branch}${STATUS_GLYPH[node.status]} ${node.agent}${describeNode(node)}`);
  const children = [...(byParent.get(node.id) ?? [])].sort((left, right) => left.startedAtMs - right.startedAtMs);
  const childPrefix = `${prefix}${isLast ? "   " : "\u2502  "}`;
  for (let index = 0; index < children.length; index += 1) appendNode(lines, children[index]!, byParent, childPrefix, index === children.length - 1);
}

function describeNode(node: SubagentNode): string {
  const parts: string[] = [];
  if (node.description) parts.push(`\u00b7 ${clampText(node.description, 60)}`);
  if (node.progress?.currentTool) parts.push(`\u00b7 ${node.progress.currentTool}`);
  if (node.progress?.tokens && node.progress.tokens > 0) parts.push(`\u00b7 ${formatTokens(node.progress.tokens)} tok`);
  if (node.finishedAtMs && node.finishedAtMs - node.startedAtMs > 100) parts.push(`\u00b7 ${formatDuration(node.finishedAtMs - node.startedAtMs)}`);
  return parts.length > 0 ? `  ${parts.join(" ")}` : "";
}

export class SubagentTreeController {
  private nodes = new Map<string, SubagentNode>();
  private evictTimer: NodeJS.Timeout | null = null;
  private disposed = false;
  enabled: boolean;
  mode: "compact" | "expanded";

  constructor(initial: SubagentTreePersistedState, readonly runtime_key: ProjectRuntimeKey, readonly session: SessionIdentity, readonly persistence?: SubagentTreePersistence) {
    this.enabled = initial.enabled;
    this.mode = initial.mode;
  }

  applyLifecycle(raw: unknown): { event: "started" | "finished"; data: SubagentCardData } | null {
    if (this.disposed || !isLifecyclePayload(raw)) return null;
    const payload = raw;
    const qualified = payload.agent_ref;
    const agent = qualified?.registered_name ?? payload.agent;
    if (payload.status === "running") {
      const node: SubagentNode = { id: payload.id, parentToolCallId: payload.parentToolCallId, agent, agent_ref: qualified, description: payload.description, status: "running", startedAtMs: Date.now() };
      this.nodes.set(payload.id, node);
      this.scheduleEvict();
      return { event: "started", data: { id: payload.id, agent, agent_ref: qualified, parentToolCallId: payload.parentToolCallId, description: payload.description, startedAtMs: node.startedAtMs, status: "running" } };
    }
    const existing = this.nodes.get(payload.id);
    if (!existing) return null;
    existing.status = payload.status;
    existing.finishedAtMs = Date.now();
    this.scheduleEvict();
    return { event: "finished", data: { id: existing.id, agent: existing.agent, agent_ref: existing.agent_ref, parentToolCallId: existing.parentToolCallId, description: existing.description, tokens: existing.progress?.tokens, currentTool: existing.progress?.currentTool, startedAtMs: existing.startedAtMs, finishedAtMs: existing.finishedAtMs, status: payload.status } };
  }

  applyProgress(raw: unknown): boolean {
    if (this.disposed || !isProgressPayload(raw)) return false;
    const id = raw.progress.id;
    if (!id || !this.nodes.has(id)) return false;
    this.nodes.get(id)!.progress = raw.progress;
    return true;
  }

  evictFinished(): boolean {
    if (this.disposed || this.mode === "compact") return false;
    const now = Date.now();
    let changed = false;
    for (const [id, node] of this.nodes) {
      if (node.finishedAtMs && now - node.finishedAtMs >= FINISHED_HOLD_MS) {
        this.nodes.delete(id);
        changed = true;
      }
    }
    if (this.nodes.size === 0 && this.evictTimer) {
      clearInterval(this.evictTimer);
      this.evictTimer = null;
    }
    return changed;
  }

  snapshot(): SubagentNode[] {
    if (this.disposed) return [];
    const nodes = [...this.nodes.values()].filter((node) => {
      if (this.mode === "compact") return node.status === "running";
      return node.status === "running" || !node.finishedAtMs || Date.now() - node.finishedAtMs < FINISHED_HOLD_MS;
    });
    return nodes.sort((left, right) => {
      if (left.status === "running" && right.status !== "running") return -1;
      if (right.status === "running" && left.status !== "running") return 1;
      return left.startedAtMs - right.startedAtMs;
    });
  }

  clear(): void {
    this.nodes.clear();
    if (this.evictTimer) {
      clearInterval(this.evictTimer);
      this.evictTimer = null;
    }
  }

  get runningCount(): number {
    let count = 0;
    for (const node of this.nodes.values()) if (node.status === "running") count += 1;
    return count;
  }

  get count(): number {
    return this.nodes.size;
  }

  persist(): void {
    writePersistedState(this.persistence, { enabled: this.enabled, mode: this.mode });
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    this.clear();
    await this.persistence?.dispose?.();
  }

  private scheduleEvict(): void {
    if (this.evictTimer || this.disposed) return;
    this.evictTimer = setInterval(() => {
      if (this.mode === "expanded") this.evictFinished();
    }, FINISHED_HOLD_MS);
    this.evictTimer.unref?.();
  }
}

export function renderWidget(ui: ExtensionUIContext, controller: SubagentTreeController): void {
  if (!controller.enabled) {
    ui.setWidget(SUBAGENT_TREE_WIDGET_KEY, undefined);
    return;
  }
  const nodes = controller.snapshot();
  const lines = controller.mode === "compact" ? renderSubagentCompactLine(nodes) : renderSubagentTree(nodes);
  ui.setWidget(SUBAGENT_TREE_WIDGET_KEY, lines.length === 0 ? undefined : lines, lines.length === 0 ? undefined : { placement: "aboveEditor" });
}

function renderCardComponent(data: SubagentCardData): ComponentLike {
  const description = data.description ? `  \u00b7 ${clampText(data.description, 50)}` : "";
  const head = `${STATUS_GLYPH[data.status]} ${data.agent}${description}`;
  let detail = "";
  if (data.status === "running") {
    const parts: string[] = [];
    if (data.currentTool) parts.push(`tool: ${data.currentTool}`);
    if (data.tokens && data.tokens > 0) parts.push(`${formatTokens(data.tokens)} tok`);
    if (parts.length > 0) detail = `  \u00b7 ${parts.join(" \u00b7 ")}`;
  } else if (data.finishedAtMs && data.finishedAtMs - data.startedAtMs > 100) {
    detail = `  \u00b7 ${formatDuration(data.finishedAtMs - data.startedAtMs)}`;
  }
  return { render: () => [`${head}${detail}`] };
}

function isSubagentCardData(value: unknown): value is SubagentCardData {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  return typeof candidate.id === "string"
    && typeof candidate.agent === "string"
    && typeof candidate.startedAtMs === "number"
    && (candidate.status === "running" || candidate.status === "completed" || candidate.status === "failed" || candidate.status === "aborted");
}

export function buildCardRenderer(): (message: unknown) => ComponentLike {
  return (message: unknown) => {
    const details = message && typeof message === "object" && "details" in message ? (message as { details?: unknown }).details : undefined;
    const data = isSubagentCardData(details) ? details : isSubagentCardData(message) ? message : {
      id: "unknown",
      agent: "unknown",
      startedAtMs: Date.now(),
      status: "failed" as const,
    };
    return renderCardComponent(data);
  };
}

export function registerSubagentTree(pi: ExtensionAPI, ui: ExtensionUIContext, context: SubagentTreeRegistrationContext): SubagentTreeController {
  const persisted = context.initial ?? readPersistedState(context.persistence);
  const controller = new SubagentTreeController(persisted, context.runtime_key, context.session, context.persistence);
  pi.events.on(TASK_SUBAGENT_LIFECYCLE_CHANNEL, (raw) => {
    const result = controller.applyLifecycle(raw);
    if (!result) return;
    try {
      pi.appendEntry(SUBAGENT_CARD_TYPE, result.data);
    } catch {
      // Transcript rendering is best effort; HUD state remains authoritative.
    }
    renderWidget(ui, controller);
  });
  pi.events.on(TASK_SUBAGENT_PROGRESS_CHANNEL, (raw) => {
    if (controller.applyProgress(raw)) renderWidget(ui, controller);
  });
  pi.registerMessageRenderer(SUBAGENT_CARD_TYPE, buildCardRenderer() as never);
  return controller;
}

export function handleSubagentsCommand(controller: SubagentTreeController, ui: ExtensionUIContext, arg?: string): string {
  const command = (arg ?? "").trim().toLowerCase();
  switch (command) {
    case "":
    case "status":
      return `subagent-tree: ${controller.enabled ? "on" : "off"}, mode: ${controller.mode}, live: ${controller.runningCount} running, ${controller.count - controller.runningCount} finished (hold 5s)`;
    case "on":
      controller.enabled = true;
      controller.persist();
      renderWidget(ui, controller);
      return "subagent-tree: enabled";
    case "off":
      controller.enabled = false;
      controller.persist();
      ui.setWidget(SUBAGENT_TREE_WIDGET_KEY, undefined);
      return "subagent-tree: disabled";
    case "toggle":
      controller.enabled = !controller.enabled;
      controller.persist();
      if (controller.enabled) renderWidget(ui, controller); else ui.setWidget(SUBAGENT_TREE_WIDGET_KEY, undefined);
      return `subagent-tree: ${controller.enabled ? "enabled" : "disabled"}`;
    case "compact":
      controller.mode = "compact";
      controller.persist();
      renderWidget(ui, controller);
      return "subagent-tree: compact mode (one line, running-only)";
    case "expanded":
    case "verbose":
      controller.mode = "expanded";
      controller.persist();
      renderWidget(ui, controller);
      return "subagent-tree: expanded mode (full tree, finished held 5s)";
    case "clear":
      controller.clear();
      renderWidget(ui, controller);
      return "subagent-tree: cleared";
    default:
      return "usage: /subagents [on|off|toggle|compact|expanded|verbose|clear|status]";
  }
}
