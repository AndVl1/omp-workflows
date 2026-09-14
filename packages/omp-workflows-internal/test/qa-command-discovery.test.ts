import assert from "node:assert/strict";
import { test } from "node:test";

import ompWorkflowsInternal from "../src/index.js";

/**
 * Matrix item: `omp-*` agent/command discovery. The bundle's command
 * surface is the hyphen-prefixed diagnostic command registered from the
 * extension entry plus the core registration surface mounted lazily as
 * `omp-do-work` / `omp-team` / `omp-cto` and the specification commands
 * `omp-specify` / `omp-spec-plan` / `omp-spec-tasks` / `omp-spec-import`.
 * Bare core command names and `omp-model-roles` are never shadowed.
 */

interface RecordedCommand {
	name: string;
	description?: string;
	handler: (args: string, ctx: unknown) => Promise<void> | void;
}

function load(): Map<string, RecordedCommand> {
	const commands = new Map<string, RecordedCommand>();
	const pi = {
		registerCommand(name: string, options: { description?: string; handler: RecordedCommand["handler"] }) {
			commands.set(name, { name, ...options });
		},
		on(_event: string, _handler: (event: unknown, ctx: unknown) => unknown) {},
		setLabel(_label: string) {},
		registerTool(_tool: { name: string }) {},
		sendUserMessage(_content: string) {},
	};
	ompWorkflowsInternal(pi as never);
	return commands;
}

test("the extension eagerly registers only its diagnostic command; omp-* workflow commands mount per marked session", () => {
	const commands = load();
	assert.deepEqual(
		[...commands.keys()].sort(),
		["omp-workflow-team"],
		`unexpected pre-activation command surface: ${[...commands.keys()].join(", ")}`,
	);
	for (const name of commands.keys()) {
		assert.match(name, /^omp-[a-z0-9-]+$/, "command name must be hyphen-prefixed omp-*");
	}
});

test("bare core command names and omp-model-roles are never registered", () => {
	const commands = load();
	for (const reserved of ["do-work", "team", "cto", "init-team", "omp-model-roles"]) {
		assert.equal(commands.has(reserved), false, `reserved command '${reserved}' must stay unregistered`);
	}
});
