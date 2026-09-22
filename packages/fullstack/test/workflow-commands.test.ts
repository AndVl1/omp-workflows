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

function sessionManagerFixture(cwd: string, sessionId: string): SessionManagerFixture {
	const canonicalCwd = resolve(cwd);
	return {
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
		const event = {
			type: "session_shutdown",
			cwd: sessionManager.getCwd(),
			session_id: sessionManager.getSessionId(),
			sessionManager,
		};
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
		assert.equal(commands.get("do-work")?.description, "Run a profile-driven workflow. /do-work <task>. (Alias: /team.)");
		assert.equal(commands.get("team")?.description, "Alias for /do-work. Prefer /do-work in new code.");
		assert.ok(commands.get("cto")?.description?.includes("resident CTO"));
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

test("fullstack: workflow commands use the session manager cwd after a context cwd drift", async () => {
	const canonical = mkdtempSync(join(tmpdir(), "omp-command-canonical-"));
	const stale = mkdtempSync(join(tmpdir(), "omp-command-stale-"));
	let cleanup: () => void = () => undefined;
	try {
		execFileSync("git", ["-C", canonical, "init", "--quiet", "--initial-branch", "main"], { stdio: "ignore" });
		const harness = commandHarness(prompt => prompt, canonical, true, "session-drift");
		cleanup = harness.cleanup;
		await harness.commands.get("do-work")?.handler("Canonical branch task", context(stale, [], "session-drift", canonical, harness.sessionManager));
		assert.equal(harness.prompts.length, 1);
		assert.match(harness.prompts[0] ?? "", /Branch: `main`/);
		assert.doesNotMatch(harness.prompts[0] ?? "", /no git work tree/);
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
test("fullstack: direct /cto handler emits fresh and standby prompts", async () => {
	const root = mkdtempSync(join(tmpdir(), "omp-command-cto-"));
	let cleanup: () => void = () => undefined;
	try {
		execFileSync("git", ["-C", root, "init", "--quiet", "--initial-branch", "main"], { stdio: "ignore" });
		const harness = commandHarness(prompt => prompt, root);
		cleanup = harness.cleanup;
		const ctx = context(root, harness.notifications);

		await harness.commands.get("cto")?.handler("Fresh CTO task", ctx);
		assert.ok(harness.prompts[0]?.includes("Fresh CTO task"));
		assert.ok(harness.prompts[0]?.includes("/cto workflow"));
		assert.ok(harness.notifications.some(message => message.startsWith("cto: Fresh CTO task")));

		await harness.commands.get("cto")?.handler("", ctx);
		assert.ok(harness.prompts[1]?.includes("/cto STANDBY"));
		assert.ok(harness.notifications.some(message => message.startsWith("cto: standby mode")));
	} finally {
		cleanup();
		rmSync(root, { recursive: true, force: true });
	}
});

