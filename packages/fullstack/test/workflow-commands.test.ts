import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerWorkflowCommands } from "../src/workflow-commands.js";
import { fullstackOwnerForCwd, resolveSessionCwd } from "../src/index.js";
import { FULLSTACK_ACTIVATION_MARKER_PATH, writeFullstackActivationMarker } from "../src/activation-marker.js";

type Registered = {
	description?: string;
	handler: (args: string, ctx: unknown) => Promise<void>;
};

type SessionStartHandler = (event: unknown, ctx: unknown) => unknown;
function makeActivatedRoot(prefix: string): string {
	const root = mkdtempSync(join(tmpdir(), prefix));
	execFileSync("git", ["-C", root, "init", "--quiet", "--initial-branch", "main"], { stdio: "ignore" });
	writeFullstackActivationMarker(root);
	return root;
}


function commandHarness(
	transformPrompt: (prompt: string) => string = prompt => prompt,
	sessionCwd = process.cwd(),
	startSession = true,
	sessionId = "command-harness-session",
): {
	commands: Map<string, Registered>;
	prompts: string[];
	notifications: string[];
	sessionStarts: SessionStartHandler[];
	shutdowns: SessionStartHandler[];
	sessionManager: { getCwd: () => string; getSessionId: () => string };
} {
	const commands = new Map<string, Registered>();
	const prompts: string[] = [];
	const notifications: string[] = [];
	const sessionStarts: SessionStartHandler[] = [];
	const shutdowns: SessionStartHandler[] = [];
	const sessionManager = {
		getCwd: () => sessionCwd,
		getSessionId: () => sessionId,
	};
	registerWorkflowCommands({
		on(name: string, handler: SessionStartHandler) {
			if (name === "session_start") {
				sessionStarts.push(handler);
				if (startSession) {
					handler({}, { cwd: sessionCwd, sessionManager });
				}
			} else if (name === "session_shutdown") {
				shutdowns.push(handler);
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
	return { commands, prompts, notifications, sessionStarts, shutdowns, sessionManager };
}

function context(cwd: string, notifications: string[], sessionId = "session-direct", sessionCwd?: string, sessionManager?: { getCwd?: () => string; getSessionId?: () => string }): unknown {
	return {
		cwd,
		ui: {
			notify(message: string) {
				notifications.push(message);
			},
		},
		sessionManager: sessionManager ?? {
			getSessionId: () => sessionId,
			...(sessionCwd ? { getCwd: () => sessionCwd } : {}),
		},
	};
}

test("fullstack: workflow command mount is marker-bound at session and command boundaries", async () => {
	type Handler = (event: unknown, ctx: unknown) => unknown;
	type Command = { handler: (args: string, ctx: unknown) => Promise<void> };
	function harness() {
		const sessionStarts: Handler[] = [];
		const shutdowns: Handler[] = [];
		const commands = new Map<string, Command>();
		const pi = {
			on(name: string, handler: Handler) {
				if (name === "session_start") sessionStarts.push(handler);
				if (name === "session_shutdown") shutdowns.push(handler);
			},
			registerCommand(name: string, options: Command) { commands.set(name, options); },
			sendUserMessage() {},
		};
		return { pi, sessionStarts, shutdowns, commands };
	}

	const missingRoot = mkdtempSync(join(tmpdir(), "omp-command-marker-missing-"));
	const wrongRoot = mkdtempSync(join(tmpdir(), "omp-command-marker-wrong-"));
	const validRoot = mkdtempSync(join(tmpdir(), "omp-command-marker-valid-"));
	let validShutdowns: Handler[] = [];
	try {
		const missing = harness();
		assert.doesNotThrow(() => registerWorkflowCommands(missing.pi as never, { owner: fullstackOwnerForCwd, resolveCwd: resolveSessionCwd }));
		assert.equal(missing.sessionStarts.length, 1);
		assert.throws(
			() => missing.sessionStarts[0]?.({}, { cwd: missingRoot }),
			/activation_markers_missing|activation_identity_changed|owner_invalid/,
		);

		mkdirSync(join(wrongRoot, ".omp"), { recursive: true });
		writeFileSync(join(wrongRoot, FULLSTACK_ACTIVATION_MARKER_PATH), "{}\n");
		const wrong = harness();
		registerWorkflowCommands(wrong.pi as never, { owner: fullstackOwnerForCwd, resolveCwd: resolveSessionCwd });
		assert.throws(() => wrong.sessionStarts[0]?.({}, { cwd: wrongRoot }), /activation_markers_missing|activation_identity_changed|owner_invalid/);

		mkdirSync(join(validRoot, ".omp"), { recursive: true });
		writeFullstackActivationMarker(validRoot);
		const valid = harness();
		validShutdowns = valid.shutdowns;
		registerWorkflowCommands(valid.pi as never, { owner: fullstackOwnerForCwd, resolveCwd: resolveSessionCwd });
		assert.doesNotThrow(() => valid.sessionStarts[0]?.({}, { cwd: validRoot }));
		assert.deepEqual([...valid.commands.keys()], ["do-work", "team", "cto", "specify", "spec-plan", "spec-tasks", "spec-import"]);

		writeFileSync(join(validRoot, FULLSTACK_ACTIVATION_MARKER_PATH), "{}\n");
		await assert.rejects(
			valid.commands.get("do-work")?.handler("marker must stay valid", { cwd: validRoot }),
			/activation marker digest does not match|activation_identity_changed|owner_conflict/,
		);
	} finally {
		for (const shutdown of validShutdowns) shutdown({}, { cwd: validRoot });
		rmSync(missingRoot, { recursive: true, force: true });
		rmSync(wrongRoot, { recursive: true, force: true });
		rmSync(validRoot, { recursive: true, force: true });
	}
});

test("fullstack: workflow commands register as authoritative extension commands", () => {
	const root = makeActivatedRoot("omp-command-authoritative-");
	let shutdowns: SessionStartHandler[] = [];
	try {
		const harness = commandHarness(prompt => prompt, root);
		shutdowns = harness.shutdowns;
		const { commands } = harness;
		assert.deepEqual([...commands.keys()], ["do-work", "team", "cto", "specify", "spec-plan", "spec-tasks", "spec-import"]);
		assert.equal(commands.get("do-work")?.description, "Run a profile-driven workflow. /do-work <task>. (Alias: /team.)");
		assert.equal(commands.get("team")?.description, "Alias for /do-work. Prefer /do-work in new code.");
		assert.ok(commands.get("cto")?.description?.includes("resident CTO"));
		assert.ok(commands.get("specify")?.description?.includes("Create, resume, or revise the Specify phase"));
		assert.ok(commands.get("spec-plan")?.description?.includes("Create, resume, or revise the Plan phase"));
		assert.ok(commands.get("spec-tasks")?.description?.includes("Create, resume, or revise the Tasks phase"));
		assert.ok(commands.get("spec-import")?.description?.includes("Import an authorized local external specification read-only"));
	} finally {
		for (const shutdown of shutdowns) shutdown({}, { cwd: root });
		rmSync(root, { recursive: true, force: true });
	}
});

test("fullstack: activated command inventory remains overrideable", () => {
	const root = makeActivatedRoot("omp-command-inventory-");
	let shutdowns: SessionStartHandler[] = [];
	try {
		const harness = commandHarness(prompt => prompt, root, true, "session-inventory");
		shutdowns = harness.shutdowns;
		const { commands, sessionStarts } = harness;
		assert.deepEqual([...commands.keys()], ["do-work", "team", "cto", "specify", "spec-plan", "spec-tasks", "spec-import"]);
		assert.equal(sessionStarts.length, 1);

		const override: Registered = {
			description: "Project plugin team override",
			handler: async () => undefined,
		};
		commands.set("team", override);

		assert.deepEqual([...commands.keys()], ["do-work", "team", "cto", "specify", "spec-plan", "spec-tasks", "spec-import"]);
		assert.equal(commands.get("team"), override);
		assert.equal([...commands.keys()].filter(name => name === "team").length, 1);
	} finally {
		for (const shutdown of shutdowns) shutdown({}, { cwd: root });
		rmSync(root, { recursive: true, force: true });
	}
});
test("fullstack: direct /do-work and /team send prompts through OMP", async () => {
	const root = makeActivatedRoot("omp-command-direct-");
	let shutdowns: SessionStartHandler[] = [];
	try {
		const harness = commandHarness(prompt => prompt, root, true, "session-direct");
		shutdowns = harness.shutdowns;
		const { commands, prompts, notifications, sessionManager } = harness;
		const ctx = context(root, notifications, "session-direct", root, sessionManager);

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
	} finally {
		for (const shutdown of shutdowns) shutdown({}, { cwd: root });
		rmSync(root, { recursive: true, force: true });
	}
});

test("fullstack: workflow commands use the session manager cwd after a context cwd drift", async () => {
	const canonical = makeActivatedRoot("omp-command-canonical-");
	const stale = mkdtempSync(join(tmpdir(), "omp-command-stale-"));
	let shutdowns: SessionStartHandler[] = [];
	try {
		const harness = commandHarness(prompt => prompt, canonical, true, "session-drift");
		shutdowns = harness.shutdowns;
		const { commands, prompts, sessionManager } = harness;
		await commands.get("do-work")?.handler("Canonical branch task", context(stale, [], "session-drift", canonical, sessionManager));

		assert.equal(prompts.length, 1);
		assert.match(prompts[0] ?? "", /Branch: `main`/);
		assert.doesNotMatch(prompts[0] ?? "", /no git work tree/);
	} finally {
		for (const shutdown of shutdowns) shutdown({}, { cwd: canonical });
		rmSync(canonical, { recursive: true, force: true });
		rmSync(stale, { recursive: true, force: true });
	}
});

test("fullstack: external hook boundary can augment /do-work prompt", async () => {
	const root = makeActivatedRoot("omp-command-hook-");
	let observed = "";
	let shutdowns: SessionStartHandler[] = [];
	try {
		const harness = commandHarness(prompt => {
			observed = prompt;
			return `${prompt}\n[external-hook-marker]`;
		}, root, true, "session-hook");
		shutdowns = harness.shutdowns;
		const { commands, prompts, sessionManager } = harness;

		await commands.get("do-work")?.handler("Hooked workflow task", context(root, [], "session-hook", root, sessionManager));

		assert.ok(observed.includes("Hooked workflow task"));
		assert.ok(prompts[0]?.endsWith("[external-hook-marker]"));
	} finally {
		for (const shutdown of shutdowns) shutdown({}, { cwd: root });
		rmSync(root, { recursive: true, force: true });
	}
});

test("fullstack: direct /cto handler emits fresh and standby prompts", async () => {
	const root = makeActivatedRoot("omp-command-cto-");
	let shutdowns: SessionStartHandler[] = [];
	try {
		const harness = commandHarness(prompt => prompt, root, true, "session-cto");
		shutdowns = harness.shutdowns;
		const { commands, prompts, notifications, sessionManager } = harness;
		const ctx = context(root, notifications, "session-cto", root, sessionManager);

		await commands.get("cto")?.handler("Fresh CTO task", ctx);
		assert.ok(prompts[0]?.includes("Fresh CTO task"));
		assert.ok(prompts[0]?.includes("/cto workflow"));
		assert.ok(notifications.some(message => message.startsWith("cto: Fresh CTO task")));

		await commands.get("cto")?.handler("", ctx);
		assert.ok(prompts[1]?.includes("/cto STANDBY"));
		assert.ok(notifications.some(message => message.startsWith("cto: standby mode")));
	} finally {
		for (const shutdown of shutdowns) shutdown({}, { cwd: root });
		rmSync(root, { recursive: true, force: true });
	}
});
