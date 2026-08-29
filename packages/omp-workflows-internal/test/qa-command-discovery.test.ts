import assert from "node:assert/strict";
import { test } from "node:test";

import ompWorkflowsInternal from "../src/index.js";

interface RecordedCommand {
	name: string;
	description?: string;
	handler: (args: string) => Promise<void> | void;
}

function load(): Map<string, RecordedCommand> {
	const commands = new Map<string, RecordedCommand>();
	const pi = {
		registerCommand(name: string, options: { description?: string; handler: RecordedCommand["handler"] }) {
			commands.set(name, { name, ...options });
		},
		sendUserMessage(_content: string) {},
	};
	ompWorkflowsInternal(pi as never);
	return commands;
}

test("the extension registers exactly one non-canonical diagnostic command", () => {
	const commands = load();
	assert.equal(commands.size, 1, `expected exactly one command, got: ${[...commands.keys()].join(", ")}`);
	const command = commands.get("omp-workflow-team");
	assert.ok(command, "omp-workflow-team must be registered");
	assert.match(command!.name, /^omp-[a-z0-9-]+$/, "command name must be hyphen-prefixed omp-*");
});

test("canonical host command names and omp-model-roles are never registered", () => {
	const commands = load();
	for (const reserved of ["do-work", "team", "cto", "workflow-provider", "init-team", "omp-model-roles"]) {
		assert.equal(commands.has(reserved), false, `reserved command '${reserved}' must stay unregistered`);
	}
});
