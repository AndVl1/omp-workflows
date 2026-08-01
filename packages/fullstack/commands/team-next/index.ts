/**
 * /team-next — OMP custom-TS command.
 *
 * Reads the next entry from `.work-state/queue.json` and yields a prompt
 * that re-enters the `/team` workflow with that task. This is the
 * Reads the next entry from `.work-state/queue.json` and yields a prompt
 * that re-enters the `/do-work` workflow with that task. This is the
 */

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { CustomCommand, CustomCommandAPI } from "@oh-my-pi/pi-coding-agent/extensibility/custom-commands/types";
import type { HookCommandContext } from "@oh-my-pi/pi-coding-agent/extensibility/hooks/types";

const WORK_STATE_DIR = ".work-state";

interface QueueItem {
	title: string;
	body: string;
}

function readQueue(cwd: string): QueueItem[] {
	const path = resolve(cwd, WORK_STATE_DIR, "queue.json");
	if (!existsSync(path)) return [];
	try {
		return JSON.parse(readFileSync(path, "utf8")) as QueueItem[];
	} catch {
		return [];
	}
}

const factory = (_api: CustomCommandAPI): CustomCommand => ({
	name: "team-next",
	description: "Run the next task from the queue.",
	async execute(_args: string[], ctx: HookCommandContext): Promise<string> {
		const cwd = ctx.cwd ?? _api.cwd;
		if (!cwd) return "ERROR: no cwd available.";
		const queue = readQueue(cwd);
		if (queue.length === 0) {
			return "queue: empty. Use /do-work <description> to start a task or commit something to the queue.";
		}
		const next = queue[0];
		if (!next) return "queue: empty.";
		ctx.ui?.notify?.(`team-next: running '${next.title}'`, "info");
		return `Run /do-work ${next.body}`;
	},
});

export default factory;
