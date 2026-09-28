import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import ompWorkflowsFullstack, { getFullstackWorkflowSessionController } from "../src/index.js";
import { registerWorkflowCommands } from "../src/workflow-commands.js";

type SessionManagerFixture = {
	getCwd: () => string;
	getSessionId: () => string;
	getSessionFile: () => string;
	getHeader: () => { type: "session"; id: string; cwd: string; timestamp: string };
};

const sessionManagerFixtures = new Map<string, SessionManagerFixture>();

function sessionManagerFixture(cwd: string, sessionId: string): SessionManagerFixture {
	const canonicalCwd = resolve(cwd);
	const key = `${canonicalCwd}\u0000${sessionId}`;
	const existing = sessionManagerFixtures.get(key);
	if (existing) return existing;
	const manager: SessionManagerFixture = {
		getCwd: () => canonicalCwd,
		getSessionId: () => sessionId,
		getSessionFile: () => join(canonicalCwd, ".omp", "sessions", `${sessionId}.jsonl`),
		getHeader: () => ({
			type: "session",
			id: sessionId,
			cwd: canonicalCwd,
			timestamp: "2026-01-01T00:00:00.000Z",
		}),
	};
	sessionManagerFixtures.set(key, manager);
	return manager;
}

type Registered = {
	description?: string;
	handler: (args: string, ctx: unknown) => Promise<void>;
};

type SessionStartHandler = (event: unknown, ctx: unknown) => unknown;

function commandHarness(
	transformPrompt: (prompt: string) => string = prompt => prompt,
	sessionCwd = process.cwd(),
	startSession = true,
	sessionId = "session-direct",
): {
	commands: Map<string, Registered>;
	prompts: string[];
	notifications: string[];
	sessionStarts: SessionStartHandler[];
	sessionManager: SessionManagerFixture;
	cleanup: () => void;
} {
	const commands = new Map<string, Registered>();
	const prompts: string[] = [];
	const notifications: string[] = [];
	const sessionStarts: SessionStartHandler[] = [];
	const sessionManager = sessionManagerFixture(sessionCwd, sessionId);
	const lifecycleHandlers: { sessionStart?: SessionStartHandler; sessionShutdown?: SessionStartHandler } = {};
	let sessionStarted = false;
	// The production entrypoint owns controller creation at session_start. Keep
	// command registration isolated while capturing only that ingress handler.
	ompWorkflowsFullstack({
		on(name: string, handler: SessionStartHandler) {
			if (name === "session_start" && !lifecycleHandlers.sessionStart) lifecycleHandlers.sessionStart = handler;
			if (name === "session_shutdown" && !lifecycleHandlers.sessionShutdown) lifecycleHandlers.sessionShutdown = handler;
		},
		registerCommand() {},
		setLabel() {},
		sendUserMessage() {},
	} as never);
	registerWorkflowCommands({
		on(name: string, handler: SessionStartHandler) {
			if (name !== "session_start") return;
			sessionStarts.push(handler);
			if (startSession) {
				const hostContext = {
					cwd: sessionManager.getCwd(),
					session_id: sessionManager.getSessionId(),
					mode: "tui" as const,
					hasUI: true,
					ui: {},
					sessionManager,
				};
				lifecycleHandlers.sessionStart?.({ type: "session_start" }, hostContext);
				handler({ type: "session_start" }, hostContext);
				sessionStarted = true;
				assert.ok(
					getFullstackWorkflowSessionController(hostContext, sessionManager.getCwd()),
					"session_start must capture a trusted workflow controller",
				);
			}
		},
		registerCommand(name: string, options: Registered) {
			commands.set(name, options);
		},
		sendUserMessage(prompt: string) {
			// This is the handoff into AgentSession.prompt, where external
			// before_agent_start/context hooks observe and augment the prompt.
			prompts.push(transformPrompt(prompt));
		},
	} as never);
	const cleanup = (): void => {
		if (!sessionStarted) return;
		const hostContext = {
			cwd: sessionManager.getCwd(),
			session_id: sessionManager.getSessionId(),
			mode: "tui" as const,
			hasUI: true,
			ui: {},
			sessionManager,
		};
		const event = { type: "session_shutdown" };
		lifecycleHandlers.sessionShutdown?.(event, hostContext);
		sessionStarted = false;
	};
	return { commands, prompts, notifications, sessionStarts, sessionManager, cleanup };
}
function context(
	cwd: string,
	notifications: string[],
	sessionId = "session-direct",
	sessionCwd?: string,
	sessionManager: SessionManagerFixture = sessionManagerFixture(sessionCwd ?? cwd, sessionId),
): unknown {
	return {
		cwd,
		mode: "tui",
		hasUI: true,
		session_id: sessionManager.getSessionId(),
		ui: {
			notify(message: string) {
				notifications.push(message);
			},
		},
		sessionManager,
	};
}


test("fullstack: workflow commands register as authoritative extension commands", () => {
	const { commands, cleanup } = commandHarness();
	try {
		assert.deepEqual([...commands.keys()], ["do-work", "team", "cto"]);
	} finally {
		cleanup();
	}
});

test("fullstack: base inventory is public before session_start and remains overrideable", () => {
	const { commands, sessionStarts, cleanup } = commandHarness(prompt => prompt, process.cwd(), false);
	try {
		assert.deepEqual([...commands.keys()], ["do-work", "team", "cto"]);
		assert.equal(sessionStarts.length, 1);

		const override: Registered = {
			description: "Project plugin team override",
			handler: async () => undefined,
		};
		commands.set("team", override);

		assert.deepEqual([...commands.keys()], ["do-work", "team", "cto"]);
		assert.equal(commands.get("team"), override);
		assert.equal([...commands.keys()].filter(name => name === "team").length, 1);
	} finally {
		cleanup();
	}
});

test("fullstack: workflow commands reject a context cwd that contradicts the session manager", async () => {
	const canonical = mkdtempSync(join(tmpdir(), "omp-command-canonical-"));
	const stale = mkdtempSync(join(tmpdir(), "omp-command-stale-"));
	let cleanup: () => void = () => undefined;
	try {
		execFileSync("git", ["-C", canonical, "init", "--quiet", "--initial-branch", "main"], { stdio: "ignore" });
		const harness = commandHarness(prompt => prompt, canonical, true, "session-drift");
		cleanup = harness.cleanup;
		const handler = harness.commands.get("do-work")?.handler;
		if (!handler) throw new Error("do-work command was not registered");
		await assert.rejects(
			handler(
				"Canonical branch task",
				context(stale, [], "session-drift", canonical, harness.sessionManager),
			),
			/workflow cwd unavailable|WORKFLOW_CONTEXT_REJECTED/,
		);
		assert.equal(harness.prompts.length, 0, "contradictory context must not send a workflow prompt");
	} finally {
		cleanup();
		rmSync(canonical, { recursive: true, force: true });
		rmSync(stale, { recursive: true, force: true });
	}
});

test("fullstack: external hook boundary can augment /do-work prompt", async () => {
	let observed = "";
	const harness = commandHarness(prompt => {
		observed = prompt;
		return `${prompt}\n[external-hook-marker]`;
	});
	try {
		await harness.commands.get("do-work")?.handler("Hooked workflow task", context(process.cwd(), []));
		assert.ok(observed.includes("Hooked workflow task"));
		assert.ok(harness.prompts[0]?.endsWith("[external-hook-marker]"));
	} finally {
		harness.cleanup();
	}
});

