import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { getFullstackWorkflowSessionController } from "../src/index.js";
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
} {
	const commands = new Map<string, Registered>();
	const prompts: string[] = [];
	const notifications: string[] = [];
	const sessionStarts: SessionStartHandler[] = [];
	const sessionManager = sessionManagerFixture(sessionCwd, sessionId);
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
				handler({ type: "session_start" }, hostContext);
				// Mirror the fullstack extension's trusted lifecycle capture before
				// command contexts are delivered to handlers.
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
	return { commands, prompts, notifications, sessionStarts, sessionManager };
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
	const { commands } = commandHarness();
	assert.deepEqual([...commands.keys()], ["do-work", "team", "cto"]);
	assert.equal(commands.get("do-work")?.description, "Run a profile-driven workflow. /do-work <task>. (Alias: /team.)");
	assert.equal(commands.get("team")?.description, "Alias for /do-work. Prefer /do-work in new code.");
	assert.ok(commands.get("cto")?.description?.includes("resident CTO"));
});

test("fullstack: base inventory is public before session_start and remains overrideable", () => {
	const { commands, sessionStarts } = commandHarness(prompt => prompt, process.cwd(), false);
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
});

test("fullstack: direct /do-work and /team send prompts through OMP", async () => {
	const { commands, prompts, notifications } = commandHarness();
	const ctx = context(process.cwd(), notifications);

	await commands.get("do-work")?.handler("Fresh do-work task", ctx);
	await commands.get("team")?.handler("Fresh team task", ctx);

	assert.equal(prompts.length, 2);
	assert.ok(prompts[0]?.includes("Fresh do-work task"));
	assert.ok(prompts[0]?.includes("classification pass"));
	assert.ok(prompts[1]?.includes("Fresh team task"));
	assert.ok(prompts[1]?.includes("classification pass"));
	assert.match(prompts[0] ?? "", /typed `workflow_checkpoint` envelope/);
	assert.match(prompts[0] ?? "", /actor_provenance/);
	assert.deepEqual(notifications.map(message => message.split(":")[0]), ["do-work", "team"]);
});
test("fullstack: workflow commands use the session manager cwd after a context cwd drift", async () => {
	const canonical = mkdtempSync(join(tmpdir(), "omp-command-canonical-"));
	const stale = mkdtempSync(join(tmpdir(), "omp-command-stale-"));
	try {
		execFileSync("git", ["-C", canonical, "init", "--quiet", "--initial-branch", "main"], { stdio: "ignore" });
		const { commands, prompts, sessionManager } = commandHarness(prompt => prompt, canonical, true, "session-drift");
		await commands.get("do-work")?.handler("Canonical branch task", context(stale, [], "session-drift", canonical, sessionManager));
		assert.equal(prompts.length, 1);
		assert.match(prompts[0] ?? "", /Branch: `main`/);
		assert.doesNotMatch(prompts[0] ?? "", /no git work tree/);
	} finally {
		rmSync(canonical, { recursive: true, force: true });
		rmSync(stale, { recursive: true, force: true });
	}
});

test("fullstack: external hook boundary can augment /do-work prompt", async () => {
	let observed = "";
	const { commands, prompts } = commandHarness(prompt => {
		observed = prompt;
		return `${prompt}\n[external-hook-marker]`;
	});

	await commands.get("do-work")?.handler("Hooked workflow task", context(process.cwd(), []));

	assert.ok(observed.includes("Hooked workflow task"));
	assert.ok(prompts[0]?.endsWith("[external-hook-marker]"));
});

test("fullstack: direct /cto handler emits fresh and standby prompts", async () => {
	const root = mkdtempSync(join(tmpdir(), "omp-command-cto-"));
	try {
		execFileSync("git", ["-C", root, "init", "--quiet", "--initial-branch", "main"], { stdio: "ignore" });
		const { commands, prompts, notifications } = commandHarness(prompt => prompt, root);
		const ctx = context(root, notifications);

		await commands.get("cto")?.handler("Fresh CTO task", ctx);
		assert.ok(prompts[0]?.includes("Fresh CTO task"));
		assert.ok(prompts[0]?.includes("/cto workflow"));
		assert.ok(notifications.some(message => message.startsWith("cto: Fresh CTO task")));

		await commands.get("cto")?.handler("", ctx);
		assert.ok(prompts[1]?.includes("/cto STANDBY"));
		assert.ok(notifications.some(message => message.startsWith("cto: standby mode")));
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
