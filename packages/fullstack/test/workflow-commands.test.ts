import { test } from "node:test";
import assert from "node:assert/strict";
import { registerWorkflowCommands } from "../src/workflow-commands.js";

type Registered = {
	description?: string;
	handler: (args: string, ctx: unknown) => Promise<void>;
};

function commandHarness(
	transformPrompt: (prompt: string) => string = prompt => prompt,
): { commands: Map<string, Registered>; prompts: string[]; notifications: string[] } {
	const commands = new Map<string, Registered>();
	const prompts: string[] = [];
	const notifications: string[] = [];
	registerWorkflowCommands({
		registerCommand(name: string, options: Registered) {
			commands.set(name, options);
		},
		sendUserMessage(prompt: string) {
			// This is the handoff into AgentSession.prompt, where external
			// before_agent_start/context hooks observe and augment the prompt.
			prompts.push(transformPrompt(prompt));
		},
	} as never);
	return { commands, prompts, notifications };
}

function context(cwd: string, notifications: string[], sessionId = "session-direct"): unknown {
	return {
		cwd,
		ui: {
			notify(message: string) {
				notifications.push(message);
			},
		},
		sessionManager: { getSessionId: () => sessionId },
	};
}

test("fullstack: workflow commands register as authoritative extension commands", () => {
	const { commands } = commandHarness();
	assert.deepEqual([...commands.keys()], ["do-work", "team", "cto"]);
	assert.equal(commands.get("do-work")?.description, "Run a profile-driven workflow. /do-work <task>. (Alias: /team.)");
	assert.equal(commands.get("team")?.description, "Alias for /do-work. Prefer /do-work in new code.");
	assert.ok(commands.get("cto")?.description?.includes("resident CTO"));
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
	assert.deepEqual(notifications.map(message => message.split(":")[0]), ["do-work", "team"]);
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
	const { commands, prompts, notifications } = commandHarness();
	const ctx = context(process.cwd(), notifications);

	await commands.get("cto")?.handler("Fresh CTO task", ctx);
	assert.ok(prompts[0]?.includes("Fresh CTO task"));
	assert.ok(prompts[0]?.includes("/cto workflow"));
	assert.ok(notifications.some(message => message.startsWith("cto: Fresh CTO task")));

	await commands.get("cto")?.handler("", ctx);
	assert.ok(prompts[1]?.includes("/cto STANDBY"));
	assert.ok(notifications.some(message => message.startsWith("cto: standby mode")));
});
