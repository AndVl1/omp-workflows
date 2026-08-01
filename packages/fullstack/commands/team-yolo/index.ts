/**
 * /team-yolo — OMP custom-TS command.
 *
 * Autonomous loop: one workflow per tick. Yields a prompt that hands the
 * queue to /team in [AUTONOMOUS] mode. The main agent's own loop drives
 * iteration; this command only sets the autonomous-mode envelope.
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
	name: "team-yolo",
	description: "Autonomous yolo loop: one /team task per tick in [AUTONOMOUS] mode.",
	async execute(_args: string[], ctx: HookCommandContext): Promise<string> {
		const cwd = ctx.cwd ?? _api.cwd;
		if (!cwd) return "ERROR: no cwd available.";
		const queue = readQueue(cwd);
		if (queue.length === 0) {
			return "team-yolo: queue empty. Add tasks via /team <description> or by writing .work-state/queue.json.";
		}
		const next = queue[0];
		if (!next) return "team-yolo: queue empty.";
		ctx.ui?.notify?.(`team-yolo: [AUTONOMOUS] ${next.title}`, "info");
		return `[AUTONOMOUS] ${next.body}`;
	},
});

export default factory;
