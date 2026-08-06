/**
 * Subagent tree — inline cards + live HUD mirroring the omp todo list.
 *
 * Two channels:
 *
 * 1. **Inline card** — on every `task:subagent:lifecycle: started` event we
 *    `appendEntry({ customType: "omp-subagent-card", data: { id, agent,
 *    status, parentToolCallId, description } })`. A registered
 *    `MessageRenderer` turns each card into a compact one-line entry that
 *    scrolls with the rest of the transcript (`AnchoredLiveContainer`-style
 *    behaviour). On `completed`/`failed`/`aborted` we append a second entry
 *    so the transcript carries both the spawn and the exit.
 *
 * 2. **Live HUD widget** — a `setWidget("omp-subagent-hud", ...)` line above
 *    the editor. Default is **compact** (one line, running agents only).
 *    `/subagents expanded` switches to full tree while finished nodes are
 *    still held for 5 s. Auto-hides when no work is running.
 *
 * Coupling note: channel constants are duplicated locally as plain string
 * literals instead of imported from `@oh-my-pi/pi-coding-agent`. The
 * package's main entry pulls a large graph that hard-depends on Bun-only
 * globals at runtime (see `pi-utils/src/frontmatter.ts`), which breaks
 * Node `node:test` harnesses. The string contract is the same — both
 * producer and consumer are this same bundle.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { ExtensionAPI, ExtensionUIContext } from "@oh-my-pi/pi-coding-agent";

/**
 * Minimal structural shape of `Component` from `@oh-my-pi/pi-tui`. We only
 * use the `render(width)` method, so we don't need to import the full
 * interface (which would transitively pull in a Bun-only dependency).
 */
interface ComponentLike {
	render(width: number): readonly string[];
}

/** EventBus channel for subagent lifecycle (started / completed / failed / aborted). */
export const TASK_SUBAGENT_LIFECYCLE_CHANNEL = "task:subagent:lifecycle";

/** EventBus channel for aggregated subagent progress. */
export const TASK_SUBAGENT_PROGRESS_CHANNEL = "task:subagent:progress";

/** Custom message type registered with `registerMessageRenderer`. */
export const SUBAGENT_CARD_TYPE = "omp-subagent-card";

/** Status values for subagent lifecycle (UI rendering set). */
type SubagentStatus = "running" | "completed" | "failed" | "aborted";

/** Mirror of AgentProgress — the fields we actually read. */
interface SubagentProgress {
	id?: string;
	currentTool?: string;
	tokens?: number;
}

/** Internal lifecycle payload shape (without "started" — normalised). */
interface SubagentLifecyclePayload {
	id: string;
	agent: string;
	parentToolCallId?: string;
	description?: string;
	status: SubagentStatus;
}

/** Internal progress payload shape. */
interface SubagentProgressPayload {
	progress: SubagentProgress;
}

/** Inline card data — what we append to the transcript. */
export interface SubagentCardData {
	id: string;
	agent: string;
	parentToolCallId?: string;
	description?: string;
	tokens?: number;
	currentTool?: string;
	startedAtMs: number;
	finishedAtMs?: number;
	status: SubagentStatus;
}

/** HUD widget key (anchored live region above the editor). */
export const SUBAGENT_TREE_WIDGET_KEY = "omp-subagent-hud";

/** Status line shown in the widget header. */
const WIDGET_HEADER = "Subagents";

/** Idle eviction delay for FINISHED nodes — keeps the running-only HUD clean. */
const FINISHED_HOLD_MS = 5_000;

/** Max lines rendered under the editor — bounds the on-screen footprint. */
export const MAX_RENDER_LINES = 12;

/** Persistent state shape on disk. */
export interface SubagentTreePersistedState {
	enabled: boolean;
	/** "compact" — one line; "expanded" — full tree. */
	mode: "compact" | "expanded";
}

/** Per-node state kept in memory. */
interface SubagentNode {
	id: string;
	parentToolCallId?: string;
	agent: string;
	description?: string;
	status: SubagentStatus;
	progress?: SubagentProgress;
	startedAtMs: number;
	finishedAtMs?: number;
}

/** Status glyph per state. */
const STATUS_GLYPH: Record<SubagentStatus, string> = {
	running: "\u2699",
	completed: "\u2713",
	failed: "\u2717",
	aborted: "\u00b7",
};

/** Format a token count in compact form. */
function formatTokens(tokens: number): string {
	return tokens >= 1000 ? `${(tokens / 1000).toFixed(1)}k` : `${tokens}`;
}

/** Format a millisecond duration in human-readable form. */
function formatDuration(ms: number): string {
	const seconds = Math.round(ms / 1000);
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	const remainder = seconds % 60;
	return `${minutes}m${remainder.toString().padStart(2, "0")}s`;
}

/** Clamp a string to a max length, appending an ellipsis when truncated. */
function clampText(text: string, max: number): string {
	return text.length > max ? `${text.slice(0, max - 3)}...` : text;
}

/**
 * Defensive narrowing for the lifecycle payload. "started" is normalised
 * to "running" so the downstream union stays aligned with `SubagentStatus`.
 */
function isLifecyclePayload(value: unknown): value is SubagentLifecyclePayload {
	if (!value || typeof value !== "object") return false;
	const v = value as Record<string, unknown>;
	if (typeof v.id !== "string") return false;
	if (typeof v.agent !== "string") return false;
	const status = v.status;
	if (status === "started") {
		v.status = "running";
		return true;
	}
	if (status !== "completed" && status !== "failed" && status !== "aborted") return false;
	return true;
}

/** Defensive narrowing for the progress payload. */
function isProgressPayload(value: unknown): value is SubagentProgressPayload {
	if (!value || typeof value !== "object") return false;
	const v = value as Record<string, unknown>;
	const progress = v.progress;
	if (!progress || typeof progress !== "object") return false;
	const p = progress as Record<string, unknown>;
	return typeof p.id === "string" || typeof p.currentTool === "string";
}

/** Render a one-line summary suitable for the compact HUD above the editor. */
export function renderSubagentCompactLine(nodes: SubagentNode[]): string[] {
	const running = nodes.filter((n) => n.status === "running");
	if (running.length === 0) return [];

	const counts: Record<string, number> = {};
	for (const node of running) {
		counts[node.agent] = (counts[node.agent] ?? 0) + 1;
	}
	const head = `${WIDGET_HEADER}: ${running.length} running`;
	const agents = Object.entries(counts)
		.sort((a, b) => b[1] - a[1])
		.slice(0, 6)
		.map(([agent, count]) => (count > 1 ? `${count}\u00d7 ${agent}` : agent))
		.join(" \u00b7 ");
	const tail = agents ? `  \u2502  ${agents}` : "";
	return [`${head}${tail}`];
}

/** Public renderer entry — full tree (expanded mode). */
export function renderSubagentTree(nodes: SubagentNode[]): string[] {
	if (nodes.length === 0) return [];

	const byParent = new Map<string | undefined, SubagentNode[]>();
	for (const node of nodes) {
		const key = node.parentToolCallId;
		const list = byParent.get(key);
		if (list) list.push(node);
		else byParent.set(key, [node]);
	}

	const lines: string[] = [`\u2500\u2500 ${WIDGET_HEADER} (${nodes.length}) \u2500\u2500`];
	const roots = byParent.get(undefined) ?? [];
	const sortByStart = (a: SubagentNode, b: SubagentNode) => a.startedAtMs - b.startedAtMs;

	for (const root of roots.sort(sortByStart)) {
		appendNode(lines, root, byParent, "", true);
	}

	if (lines.length > MAX_RENDER_LINES) {
		const truncated = lines.length - MAX_RENDER_LINES;
		lines.length = MAX_RENDER_LINES;
		lines.push(`\u2937 (+${truncated} more \u2014 /subagents compact)`);
	}
	return lines;
}

/** Append a single node + its descendants to the renderer output. */
function appendNode(
	lines: string[],
	node: SubagentNode,
	byParent: Map<string | undefined, SubagentNode[]>,
	prefix: string,
	isLast: boolean,
): void {
	const branch = prefix + (isLast ? "\u2514\u2500 " : "\u251c\u2500 ");
	const summary = describeNode(node);
	lines.push(`${branch}${STATUS_GLYPH[node.status]} ${node.agent}${summary}`);

	const children = (byParent.get(node.id) ?? []).sort((a, b) => a.startedAtMs - b.startedAtMs);
	const childPrefix = prefix + (isLast ? "   " : "\u2502  ");
	for (let i = 0; i < children.length; i++) {
		const child = children[i]!;
		appendNode(lines, child, byParent, childPrefix, i === children.length - 1);
	}
}

/** Build the per-line summary annotation (tool + tokens + duration). */
function describeNode(node: SubagentNode): string {
	const parts: string[] = [];
	if (node.description) parts.push(`\u00b7 ${clampText(node.description, 60)}`);
	if (node.progress?.currentTool) parts.push(`\u00b7 ${node.progress.currentTool}`);
	if (node.progress && node.progress.tokens && node.progress.tokens > 0) {
		parts.push(`\u00b7 ${formatTokens(node.progress.tokens)} tok`);
	}
	if (node.finishedAtMs && node.finishedAtMs - node.startedAtMs > 100) {
		parts.push(`\u00b7 ${formatDuration(node.finishedAtMs - node.startedAtMs)}`);
	}
	return parts.length > 0 ? `  ${parts.join(" ")}` : "";
}

/** Read the persistent view state under `<cwd>/.omp/subagent-tree.json`. */
export function readPersistedState(cwd: string): SubagentTreePersistedState {
	const path = statePath(cwd);
	if (!existsSync(path)) return { enabled: true, mode: "compact" };
	try {
		const raw = JSON.parse(readFileSync(path, "utf8")) as Partial<SubagentTreePersistedState>;
		const mode = raw.mode === "expanded" ? "expanded" : "compact";
		return {
			enabled: raw.enabled ?? true,
			mode,
		};
	} catch {
		return { enabled: true, mode: "compact" };
	}
}

export function writePersistedState(cwd: string, state: SubagentTreePersistedState): void {
	const path = statePath(cwd);
	try {
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(path, JSON.stringify(state, null, 2));
	} catch {
		// best-effort: persistence failures must never break the agent loop
	}
}

function statePath(cwd: string): string {
	return join(cwd, ".omp", "subagent-tree.json");
}

/** Subagent tree controller — holds per-session state, exposes mutations. */
export class SubagentTreeController {
	private nodes = new Map<string, SubagentNode>();
	enabled: boolean;
	mode: "compact" | "expanded";
	/** cwd of the session this controller is bound to. */
	readonly cwd: string;
	private evictTimer: NodeJS.Timeout | null = null;

	constructor(initial: SubagentTreePersistedState, cwd: string) {
		this.enabled = initial.enabled;
		this.mode = initial.mode;
		this.cwd = cwd;
	}

	/**
	 * Apply a raw lifecycle payload. Returns a card event when the caller
	 * should `appendEntry` an inline card into the transcript.
	 */
	applyLifecycle(raw: unknown): { event: "started" | "finished"; data: SubagentCardData } | null {
		if (!isLifecyclePayload(raw)) return null;
		const payload = raw;
		if (payload.status === "running") {
			const node: SubagentNode = {
				id: payload.id,
				parentToolCallId: payload.parentToolCallId,
				agent: payload.agent,
				description: payload.description,
				status: "running",
				startedAtMs: Date.now(),
			};
			this.nodes.set(payload.id, node);
			this.scheduleEvict();
			return {
				event: "started",
				data: {
					id: payload.id,
					agent: payload.agent,
					parentToolCallId: payload.parentToolCallId,
					description: payload.description,
					startedAtMs: node.startedAtMs,
					status: "running",
				},
			};
		}
		const existing = this.nodes.get(payload.id);
		if (existing) {
			existing.status = payload.status;
			existing.finishedAtMs = Date.now();
			this.scheduleEvict();
			return {
				event: "finished",
				data: {
					id: existing.id,
					agent: existing.agent,
					parentToolCallId: existing.parentToolCallId,
					description: existing.description,
					tokens: existing.progress?.tokens,
					currentTool: existing.progress?.currentTool,
					startedAtMs: existing.startedAtMs,
					finishedAtMs: existing.finishedAtMs,
					status: payload.status,
				},
			};
		}
		return null;
	}

	/** Apply a raw progress payload. Returns true if the visible tree changed. */
	applyProgress(raw: unknown): boolean {
		if (!isProgressPayload(raw)) return false;
		const id = raw.progress.id;
		if (typeof id !== "string") return false;
		const existing = this.nodes.get(id);
		if (!existing) return false;
		existing.progress = raw.progress;
		return true;
	}

	/** Drop finished nodes past the eviction grace window (only relevant in expanded mode). */
	evictFinished(): boolean {
		if (this.mode === "compact") return false;
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

	/** Snapshot of all live nodes (running + recently-finished for expanded). */
	snapshot(): SubagentNode[] {
		const nodes = [...this.nodes.values()];
		const filtered = this.mode === "compact"
			? nodes.filter((n) => n.status === "running")
			: nodes.filter((n) => {
				if (n.status === "running") return true;
				if (!n.finishedAtMs) return true;
				return Date.now() - n.finishedAtMs < FINISHED_HOLD_MS;
			});
		return filtered.sort((a, b) => {
			if (a.status === "running" && b.status !== "running") return -1;
			if (b.status === "running" && a.status !== "running") return 1;
			return a.startedAtMs - b.startedAtMs;
		});
	}

	/** Manual reset — used by `/subagents clear`. */
	clear(): void {
		this.nodes.clear();
		if (this.evictTimer) {
			clearInterval(this.evictTimer);
			this.evictTimer = null;
		}
	}

	/** Count of running subagents (used by /subagents status). */
	get runningCount(): number {
		let n = 0;
		for (const node of this.nodes.values()) if (node.status === "running") n++;
		return n;
	}

	get count(): number {
		return this.nodes.size;
	}

	private scheduleEvict(): void {
		if (this.evictTimer) return;
		this.evictTimer = setInterval(() => {
			if (this.mode !== "compact") this.evictFinished();
		}, FINISHED_HOLD_MS);
		this.evictTimer.unref?.();
	}
}

/** Render the HUD widget into the TUI, or hide it when empty/disabled. */
export function renderWidget(ui: ExtensionUIContext, controller: SubagentTreeController): void {
	if (!controller.enabled) {
		ui.setWidget(SUBAGENT_TREE_WIDGET_KEY, undefined);
		return;
	}
	const nodes = controller.snapshot();
	const lines = controller.mode === "compact" ? renderSubagentCompactLine(nodes) : renderSubagentTree(nodes);
	if (lines.length === 0) {
		ui.setWidget(SUBAGENT_TREE_WIDGET_KEY, undefined);
		return;
	}
	ui.setWidget(SUBAGENT_TREE_WIDGET_KEY, lines, { placement: "aboveEditor" });
}

/** Render a single inline card as a `Component`-like object for the transcript. */
function renderCardComponent(data: SubagentCardData): ComponentLike {
	const glyph = STATUS_GLYPH[data.status];
	const description = data.description ? `  \u00b7 ${clampText(data.description, 50)}` : "";
	const head = `${glyph} ${data.agent}${description}`;

	let detail = "";
	if (data.status === "running") {
		const parts: string[] = [];
		if (data.currentTool) parts.push(`tool: ${data.currentTool}`);
		if (data.tokens && data.tokens > 0) parts.push(`${formatTokens(data.tokens)} tok`);
		detail = parts.length > 0 ? `  \u00b7 ${parts.join(" \u00b7 ")}` : "";
	} else if (data.finishedAtMs) {
		const duration = data.finishedAtMs - data.startedAtMs;
		if (duration > 100) detail = `  \u00b7 ${formatDuration(duration)}`;
	}

	const line = `${head}${detail}`;
	return {
		render: () => [line],
	};
}

/** Build the inline-card renderer that decodes `CustomMessage.details`. */
export function buildCardRenderer(): (message: unknown) => ComponentLike {
	return (message: unknown) => {
		const messageLike = message as { details?: SubagentCardData };
		const data = messageLike.details ?? (message as unknown as SubagentCardData);
		return renderCardComponent(data);
	};
}

/** Wire EventBus + custom-message-renderer subscriptions to the extension. */
export function registerSubagentTree(
	pi: ExtensionAPI,
	ui: ExtensionUIContext,
	cwd: string,
): SubagentTreeController {
	const persisted = readPersistedState(cwd);
	const controller = new SubagentTreeController(persisted, cwd);

	pi.events.on(TASK_SUBAGENT_LIFECYCLE_CHANNEL, (raw) => {
		const result = controller.applyLifecycle(raw);
		if (!result) return;
		// Push an inline card into the transcript so it scrolls with the chat.
		try {
			pi.appendEntry(SUBAGENT_CARD_TYPE, result.data);
		} catch {
			// entry is best-effort: a failed append must not break the HUD.
		}
		if (ui) renderWidget(ui, controller);
	});

	pi.events.on(TASK_SUBAGENT_PROGRESS_CHANNEL, (raw) => {
		if (controller.applyProgress(raw)) {
			if (ui) renderWidget(ui, controller);
		}
	});

	// Register the inline-card renderer once. It returns a lightweight
	// `Component`-like object; no pi-tui runtime import required.
	const renderer = buildCardRenderer();
	pi.registerMessageRenderer(SUBAGENT_CARD_TYPE, renderer as never);

	return controller;
}

/** Handle a `/subagents` command invocation. */
export function handleSubagentsCommand(
	controller: SubagentTreeController,
	cwd: string,
	ui: ExtensionUIContext,
	arg: string | undefined,
): string {
	const sub = (arg ?? "").trim().toLowerCase();
	switch (sub) {
		case "":
		case "status": {
			return `subagent-tree: ${controller.enabled ? "on" : "off"}, mode: ${controller.mode}, live: ${controller.runningCount} running, ${controller.count - controller.runningCount} finished (hold 5s)`;
		}
		case "on": {
			controller.enabled = true;
			writePersistedState(cwd, { enabled: controller.enabled, mode: controller.mode });
			renderWidget(ui, controller);
			return "subagent-tree: enabled";
		}
		case "off": {
			controller.enabled = false;
			writePersistedState(cwd, { enabled: controller.enabled, mode: controller.mode });
			ui.setWidget(SUBAGENT_TREE_WIDGET_KEY, undefined);
			return "subagent-tree: disabled";
		}
		case "toggle": {
			controller.enabled = !controller.enabled;
			writePersistedState(cwd, { enabled: controller.enabled, mode: controller.mode });
			if (controller.enabled) renderWidget(ui, controller);
			else ui.setWidget(SUBAGENT_TREE_WIDGET_KEY, undefined);
			return `subagent-tree: ${controller.enabled ? "enabled" : "disabled"}`;
		}
		case "compact": {
			controller.mode = "compact";
			writePersistedState(cwd, { enabled: controller.enabled, mode: controller.mode });
			renderWidget(ui, controller);
			return "subagent-tree: compact mode (one line, running-only)";
		}
		case "expanded":
		case "verbose": {
			controller.mode = "expanded";
			writePersistedState(cwd, { enabled: controller.enabled, mode: controller.mode });
			renderWidget(ui, controller);
			return "subagent-tree: expanded mode (full tree, finished held 5s)";
		}
		case "clear":
			controller.clear();
			renderWidget(ui, controller);
			return "subagent-tree: cleared";
		default:
			return "usage: /subagents [on|off|toggle|compact|expanded|verbose|clear|status]";
	}
}
