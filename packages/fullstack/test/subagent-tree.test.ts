import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	MAX_RENDER_LINES,
	SUBAGENT_CARD_TYPE,
	SUBAGENT_TREE_WIDGET_KEY,
	SubagentTreeController,
	buildCardRenderer,
	handleSubagentsCommand,
	readPersistedState,
	renderSubagentCompactLine,
	renderSubagentTree,
	registerSubagentTree,
	writePersistedState,
} from "../src/subagent-tree.js";
import type { ExtensionAPI, ExtensionUIContext } from "@oh-my-pi/pi-coding-agent";

/** Create a fresh cwd for filesystem-isolated tests. */
function tmpCwd(prefix: string): string {
	return mkdtempSync(join(tmpdir(), prefix));
}

/** Build a minimal lifecycle payload. */
function started(id: string, parentToolCallId: string | undefined, agent: string, description?: string): Record<string, unknown> {
	return {
		id,
		agent,
		agentSource: "bundled",
		description,
		status: "started",
		parentToolCallId,
		index: 0,
	};
}

function finished(id: string, status: "completed" | "failed" | "aborted"): Record<string, unknown> {
	return {
		id,
		agent: "task",
		agentSource: "bundled",
		status,
		index: 0,
	};
}

/** Build a minimal progress payload for test fixtures. */
function progress(id: string, tool: string, tokens: number): Record<string, unknown> {
	return {
		agent: "task",
		agentSource: "bundled",
		task: "test task",
		progress: {
			id,
			agent: "task",
			agentSource: "bundled",
			status: "running",
			task: "test task",
			recentTools: [],
			recentOutput: [],
			toolCount: 0,
			requests: 0,
			tokens,
			currentTool: tool,
		},
	};
}

/** Fake UI context that records every setWidget call. */
function fakeUi(): ExtensionUIContext & { calls: Array<{ key: string; content: string[] | undefined; placement?: string }> } {
	const calls: Array<{ key: string; content: string[] | undefined; placement?: string }> = [];
	return {
		calls,
		notify: () => {},
		onTerminalInput: () => () => {},
		setWorkingMessage: () => {},
		setWidget: (key, content, options) => {
			calls.push({ key, content: Array.isArray(content) ? content : undefined, placement: options?.placement });
		},
		setFooter: () => {},
		setHeader: () => {},
		setTitle: () => {},
		custom: <T,>(factory: unknown, options?: unknown) => {
			return factory as T;
		},
	} as unknown as ExtensionUIContext & { calls: typeof calls };
}

test("subagent-tree: renderSubagentCompactLine returns empty for empty input", () => {
	assert.deepEqual(renderSubagentCompactLine([]), []);
});

test("subagent-tree: renderSubagentCompactLine produces a single line for running agents", () => {
	const nodes = [
		{ id: "a", parentId: undefined, agent: "developer-kotlin", status: "running" as const, startedAtMs: 0 },
		{ id: "b", parentId: undefined, agent: "developer-kotlin", status: "running" as const, startedAtMs: 1 },
		{ id: "c", parentId: undefined, agent: "team-lead", status: "running" as const, startedAtMs: 2 },
		{ id: "d", parentId: undefined, agent: "qa", status: "completed" as const, startedAtMs: 3, finishedAtMs: 100 },
	];
	const lines = renderSubagentCompactLine(nodes);
	assert.equal(lines.length, 1, "exactly one line");
	assert.match(lines[0]!, /Subagents: 3 running/, "counts running only");
	assert.match(lines[0]!, /2\u00d7 developer-kotlin/, "collapses same agent");
	assert.match(lines[0]!, /team-lead/, "team-lead surfaced");
	assert.doesNotMatch(lines[0]!, /\bqa\b/, "completed agent excluded");
});

test("subagent-tree: renderSubagentTree returns empty list for empty input", () => {
	assert.deepEqual(renderSubagentTree([]), []);
});

test("subagent-tree: renderSubagentTree renders header + root + nested children", () => {
	const nodes = [
		{ id: "lead-1", parentId: undefined, agent: "team-lead", status: "running" as const, startedAtMs: 0 },
		{ id: "w-1", parentId: "lead-1", agent: "developer", status: "running" as const, startedAtMs: 1 },
		{ id: "w-2", parentId: "lead-1", agent: "qa", status: "completed" as const, startedAtMs: 2, finishedAtMs: 5_000 },
	];
	const lines = renderSubagentTree(nodes);
	assert.ok(lines.length >= 4, "header + root + 2 children");
	assert.match(lines[0]!, /Subagents \(3\)/, "header counts all nodes");
	assert.ok(lines.some((l) => l.includes("team-lead")), "lead rendered");
	assert.ok(lines.some((l) => l.includes("developer")), "worker rendered");
	assert.ok(lines.some((l) => l.includes("qa")), "qa rendered");
});

test("subagent-tree: registry reconciliation adds nested workers missed by the parent EventBus", () => {
	const controller = new SubagentTreeController({ enabled: true, mode: "expanded" }, "/tmp");
	controller.applyLifecycle(started("lead-1", undefined, "team-lead"));

	const changed = controller.reconcileRegistry([
		{
			id: "lead-1",
			displayName: "team-lead",
			kind: "sub",
			parentId: "Main",
			status: "running",
			createdAt: 1,
			lastActivity: 10,
		},
		{
			id: "worker-1",
			displayName: "developer",
			kind: "sub",
			parentId: "lead-1",
			status: "running",
			createdAt: 2,
			lastActivity: 11,
		},
	]);

	assert.equal(changed, true);
	assert.equal(controller.runningCount, 2, "registry supplies the nested worker missing from the main EventBus");
	const lines = renderSubagentTree(controller.snapshot());
	const worker = lines.find((line) => line.includes("developer"));
	assert.ok(worker?.startsWith("   \u2514\u2500"), "worker renders beneath its AgentRegistry parent");
	controller.dispose();
});

test("subagent-tree: registerSubagentTree subscribes to the process-global registry", () => {
	const cwd = tmpCwd("subagent-tree-registry-");
	try {
		writePersistedState(cwd, { enabled: true, mode: "expanded" });
		const ui = fakeUi();
		const registryListeners = new Set<() => void>();
		const refs = [
			{
				id: "lead-1",
				displayName: "team-lead",
				kind: "sub" as const,
				parentId: "Main",
				status: "running" as const,
				createdAt: 1,
				lastActivity: 10,
			},
			{
				id: "worker-1",
				displayName: "developer",
				kind: "sub" as const,
				parentId: "lead-1",
				status: "running" as const,
				createdAt: 2,
				lastActivity: 11,
			},
			{
				id: "old-worker",
				displayName: "qa",
				kind: "sub" as const,
				parentId: "lead-1",
				status: "parked" as const,
				createdAt: 1,
				lastActivity: 1,
			},
		];
		const registry = {
			list: () => refs,
			onChange: (listener: () => void) => {
				registryListeners.add(listener);
				return () => registryListeners.delete(listener);
			},
		};
		const eventListeners = new Map<string, (payload: unknown) => void>();
		const pi = {
			pi: { AgentRegistry: { global: () => registry } },
			events: {
				on: (channel: string, listener: (payload: unknown) => void) => {
					eventListeners.set(channel, listener);
					return () => eventListeners.delete(channel);
				},
			},
			appendEntry: () => {},
			registerMessageRenderer: () => {},
		} as unknown as ExtensionAPI;

		const controller = registerSubagentTree(pi, ui, cwd);
		assert.equal(controller.runningCount, 2);
		assert.equal(controller.count, 2, "stale parked history is not imported into the live HUD");
		const visible = ui.calls.at(-1)?.content ?? [];
		assert.ok(visible.some((line) => line.includes("team-lead")));
		assert.ok(visible.some((line) => line.includes("developer")));

		controller.dispose();
		assert.equal(registryListeners.size, 0, "registry listener released with the controller");
		assert.equal(eventListeners.size, 0, "session-local EventBus listeners released with the controller");
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("subagent-tree: renderSubagentTree caps output at MAX_RENDER_LINES", () => {
	const nodes = Array.from({ length: 30 }, (_, i) => ({
		id: `w-${i}`,
		parentId: undefined,
		agent: "developer",
		status: "running" as const,
		startedAtMs: i,
	}));
	const lines = renderSubagentTree(nodes);
	assert.ok(lines.length <= MAX_RENDER_LINES + 1, `output bounded (was ${lines.length})`);
	assert.match(lines[lines.length - 1]!, /\+\d+ more/, "truncation notice");
});

test("subagent-tree: applyLifecycle yields a started card event", () => {
	const controller = new SubagentTreeController({ enabled: true, mode: "compact" }, "/tmp");
	const result = controller.applyLifecycle(started("id-1", undefined, "developer-kotlin", "Build auth"));
	assert.ok(result, "started event returned");
	assert.equal(result!.event, "started");
	assert.equal(result!.data.id, "id-1");
	assert.equal(result!.data.agent, "developer-kotlin");
	assert.equal(result!.data.description, "Build auth");
	assert.equal(controller.count, 1);
});

test("subagent-tree: applyLifecycle yields a finished card event with timing", () => {
	const controller = new SubagentTreeController({ enabled: true, mode: "expanded" }, "/tmp");
	const start = controller.applyLifecycle(started("id-1", undefined, "developer-kotlin"));
	assert.equal(start!.event, "started");
	const finish = controller.applyLifecycle(finished("id-1", "completed"));
	assert.ok(finish, "finished event returned");
	assert.equal(finish!.event, "finished");
	assert.equal(finish!.data.status, "completed");
	assert.ok(finish!.data.finishedAtMs !== undefined, "finishedAtMs in card");
});

test("subagent-tree: applyLifecycle updates status on completion", () => {
	const controller = new SubagentTreeController({ enabled: true, mode: "expanded" }, "/tmp");
	controller.applyLifecycle(started("id-1", undefined, "developer-kotlin"));
	controller.applyLifecycle(finished("id-1", "completed"));
	const nodes = controller.snapshot();
	assert.equal(nodes[0]!.status, "completed");
	assert.ok(nodes[0]!.finishedAtMs !== undefined, "finishedAtMs recorded");
});

test("subagent-tree: applyProgress attaches progress to an existing node", () => {
	const controller = new SubagentTreeController({ enabled: true, mode: "compact" }, "/tmp");
	controller.applyLifecycle(started("id-1", undefined, "developer-kotlin"));
	controller.applyProgress(progress("id-1", "write", 1500));
	const nodes = controller.snapshot();
	assert.equal(nodes[0]!.progress?.currentTool, "write");
	assert.equal(nodes[0]!.progress?.tokens, 1500);
});

test("subagent-tree: applyProgress is a no-op for unknown id", () => {
	const controller = new SubagentTreeController({ enabled: true, mode: "compact" }, "/tmp");
	const changed = controller.applyProgress(progress("ghost", "write", 0));
	assert.equal(changed, false);
});

test("subagent-tree: tree topology follows authoritative agent parent ids", () => {
	const nodes = [
		{ id: "lead", parentId: undefined, agent: "team-lead", status: "running" as const, startedAtMs: 0 },
		{ id: "w-1", parentId: "lead", agent: "developer-go", status: "running" as const, startedAtMs: 1 },
		{ id: "w-2", parentId: "lead", agent: "developer-kotlin", status: "running" as const, startedAtMs: 2 },
		{ id: "g-1", parentId: "w-1", agent: "developer-mobile", status: "running" as const, startedAtMs: 3 },
	];
	const joined = renderSubagentTree(nodes).join("\n");
	assert.ok(joined.includes("team-lead"));
	assert.ok(joined.includes("developer-go"));
	assert.ok(joined.includes("developer-kotlin"));
	assert.ok(joined.includes("developer-mobile"));
	assert.ok(joined.includes("\u2502"), "vertical connector present");
});

test("subagent-tree: snapshot sorts running before finished", () => {
	const controller = new SubagentTreeController({ enabled: true, mode: "expanded" }, "/tmp");
	controller.applyLifecycle(started("old", undefined, "developer-go"));
	controller.applyLifecycle(finished("old", "completed"));
	controller.applyLifecycle(started("new", undefined, "developer-kotlin"));
	const ordered = controller.snapshot().map((n) => n.id);
	assert.equal(ordered[0], "new", "running node first");
});

test("subagent-tree: clear() drops all nodes", () => {
	const controller = new SubagentTreeController({ enabled: true, mode: "compact" }, "/tmp");
	controller.applyLifecycle(started("id-1", undefined, "developer-go"));
	controller.applyLifecycle(started("id-2", undefined, "developer-kotlin"));
	assert.equal(controller.count, 2);
	controller.clear();
	assert.equal(controller.count, 0);
});

test("subagent-tree: persisted state round-trips", () => {
	const cwd = tmpCwd("subagent-tree-persist-");
	try {
		const initial = readPersistedState(cwd);
		assert.equal(initial.enabled, true, "default enabled");
		assert.equal(initial.mode, "compact", "default compact");
		writePersistedState(cwd, { enabled: false, mode: "expanded" });
		const after = readPersistedState(cwd);
		assert.equal(after.enabled, false);
		assert.equal(after.mode, "expanded");
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("subagent-tree: writePersistedState swallows FS errors", () => {
	const cwd = "/dev/null/cannot-write";
	assert.doesNotThrow(() => writePersistedState(cwd, { enabled: false, mode: "compact" }));
});

test("subagent-tree: handleSubagentsCommand toggles, persists, and switches mode", () => {
	const cwd = tmpCwd("subagent-tree-cmd-");
	try {
		const controller = new SubagentTreeController({ enabled: true, mode: "compact" }, cwd);
		const ui = fakeUi();

		// off
		assert.match(handleSubagentsCommand(controller, cwd, ui, "off"), /disabled/);
		assert.equal(controller.enabled, false);
		assert.equal(ui.calls[ui.calls.length - 1]!.content, undefined, "widget hidden");

		// on
		assert.match(handleSubagentsCommand(controller, cwd, ui, "on"), /enabled/);
		assert.equal(controller.enabled, true);

		// status
		assert.match(handleSubagentsCommand(controller, cwd, ui, "status"), /on, mode: compact/);

		// expanded
		assert.match(handleSubagentsCommand(controller, cwd, ui, "expanded"), /expanded mode/);
		assert.equal(controller.mode, "expanded");

		// compact
		assert.match(handleSubagentsCommand(controller, cwd, ui, "compact"), /compact mode/);
		assert.equal(controller.mode, "compact");

		// toggle
		assert.match(handleSubagentsCommand(controller, cwd, ui, "toggle"), /disabled/);
		assert.equal(controller.enabled, false);

		// clear
		controller.applyLifecycle(started("id-1", undefined, "developer-go"));
		assert.equal(controller.count, 1);
		assert.match(handleSubagentsCommand(controller, cwd, ui, "clear"), /cleared/);
		assert.equal(controller.count, 0);

		// unknown sub
		assert.match(handleSubagentsCommand(controller, cwd, ui, "garbage"), /usage:/);

		// persistence side-effects
		assert.ok(existsSync(join(cwd, ".omp", "subagent-tree.json")), "state file written");
		const persisted = JSON.parse(readFileSync(join(cwd, ".omp", "subagent-tree.json"), "utf8"));
		assert.equal(persisted.enabled, controller.enabled);
		assert.equal(persisted.mode, controller.mode);
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("subagent-tree: widget key is stable for the fullstack bundle", () => {
	assert.equal(SUBAGENT_TREE_WIDGET_KEY, "omp-subagent-hud");
});

test("subagent-tree: SUBAGENT_CARD_TYPE is the registered customType", () => {
	assert.equal(SUBAGENT_CARD_TYPE, "omp-subagent-card");
});

test("subagent-tree: buildCardRenderer fits a single-line card for running agents", () => {
	const renderer = buildCardRenderer();
	const component = renderer({
		details: {
			id: "w-1",
			agent: "developer-kotlin",
			description: "Build OAuth provider",
			currentTool: "write",
			tokens: 4200,
			startedAtMs: 1_000,
			status: "running",
		},
	});
	const lines = component.render(80);
	assert.equal(lines.length, 1, "exactly one line");
	assert.match(lines[0]!, /\u2699/, "running glyph");
	assert.match(lines[0]!, /developer-kotlin/);
	assert.match(lines[0]!, /OAuth provider/);
	assert.match(lines[0]!, /tool: write/);
	assert.match(lines[0]!, /4\.2k tok/);
});

test("subagent-tree: buildCardRenderer formats completed cards with timing", () => {
	const renderer = buildCardRenderer();
	const component = renderer({
		details: {
			id: "w-1",
			agent: "developer-kotlin",
			startedAtMs: 1_000,
			finishedAtMs: 12_500,
			status: "completed",
		},
	});
	const lines = component.render(80);
	assert.match(lines[0]!, /\u2713/, "completed glyph");
	assert.match(lines[0]!, /12s/, "duration rendered");
});

test("subagent-tree: buildCardRenderer falls back to direct data when details missing", () => {
	const renderer = buildCardRenderer();
	const component = renderer({
		id: "w-1",
		agent: "diagnostics",
		startedAtMs: 1,
		status: "running",
	});
	const lines = component.render(80);
	assert.equal(lines.length, 1);
	assert.match(lines[0]!, /diagnostics/);
});
