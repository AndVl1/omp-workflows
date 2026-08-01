/**
 * /team — OMP custom-TS command.
 *
 * Part of the omp-workflows bundle. Loaded by OMP from
 * `.omp/commands/team/index.ts` (copied at install time by the fullstack
 * package's `postinstall` hook).
 *
 * Contract:
 * - Receives `HookCommandContext` (ui, cwd, sessionManager, modelRegistry).
 * - Returns a string that is fed to the main agent as the next prompt.
 *   The main agent owns the `task` tool and runs the workflow through it.
 * - Does NOT call `task` directly (custom-TS commands lack that surface).
 *
 * Supported prefixes:
 * - `[AUTONOMOUS] <task> [issue=#N]` — autonomous mode.
 * - `<task> [issue=#N]`                — interactive mode.
 *
 * Returns a fully-formed prompt that:
 *  1. Sets the workflow discipline (discovery → architecture → implementation
 *     → review → manual-qa → qa-tests for full-feature).
 *  2. Resolves the role mapping from `.omp/team.config.json`.
 *  3. Names the next classified profile so the main agent picks the right
 *     workflow.
 */

import { execSync } from "node:child_process";
import type { CustomCommand, CustomCommandAPI } from "@oh-my-pi/pi-coding-agent/extensibility/custom-commands/types";
import type { HookCommandContext } from "@oh-my-pi/pi-coding-agent/extensibility/hooks/types";
import { classifyTask, resolveWorkflowName } from "./_lib/classify.js";
import { loadTeamConfig } from "./_lib/config.js";

const AUTONOMOUS_PREFIX = "[AUTONOMOUS";

interface ParsedEnvelope {
	task: string;
	autonomous: boolean;
	issue: number | null;
	branch: string | null;
}

function parseEnvelope(args: string, cwd: string): ParsedEnvelope {
	const autonomous = args.trimStart().startsWith(AUTONOMOUS_PREFIX);
	const stripped = autonomous ? args.trimStart().slice(AUTONOMOUS_PREFIX.length).trimStart() : args;
	const cleaned = stripped.startsWith("]") ? stripped.slice(1).trimStart() : stripped;
	const issueMatch = cleaned.match(/issue=#(\d+)/);
	const issue = issueMatch ? Number(issueMatch[1]) : null;
	const task = (issueMatch ? cleaned.replace(issueMatch[0], "") : cleaned).trim();

	let branch: string | null = null;
	try {
		branch = execSync("git rev-parse --abbrev-ref HEAD", { cwd, encoding: "utf8" }).trim();
	} catch {
		branch = null;
	}
	return { task, autonomous, issue, branch };
}

function buildPrompt(envelope: ParsedEnvelope, cwd: string): string {
	const config = loadTeamConfig(cwd);
	const classification = classifyTask(envelope.task, { autonomous: envelope.autonomous });
	const workflow = resolveWorkflowName(
		classification.type,
		classification.complexity,
		envelope.autonomous,
	);
	const roles = Object.entries(config.roles ?? {});
	const roleTable = roles
		.map(([role, agent]) => `| \`${role}\` | \`${agent}\` |`)
		.join("\n");

	const issueMeta = envelope.issue ? `Issue: #${envelope.issue}\n` : "";
	const branchMeta = envelope.branch ? `Branch: \`${envelope.branch}\`\n` : "";
	const autonomousMeta = envelope.autonomous
		? "Autonomous mode: ON. Skip user checkpoints; apply `autonomous` decision for every `checkpoint` stage.\n"
		: "Autonomous mode: OFF. Pause at each `checkpoint` stage for user review.\n";

	return [
		"/team workflow — execute via your `task` tool.",
		"",
		"### Task",
		envelope.task,
		"",
		"### Metadata",
		issueMeta + branchMeta + autonomousMeta,
		"### Classification",
		`- Type: ${classification.type}`,
		`- Complexity: ${classification.complexity}`,
		`- Confidence: ${classification.confidence}`,
		`- Workflow: \`${workflow}\``,
		"",
		"### Role mapping (from .omp/team.config.json)",
		"| Role | Agent |",
		"| --- | --- |",
		roleTable || "| (no roles configured) | |",
		"",
		"### Required workflow",
		[
			"1. Walk the stages declared in the matched profile in order.",
			"2. For each `single` stage, call `task` once with the resolved agent.",
			"3. For each `consilium` stage, call `task` with `{ context, tasks: [...] }` for parallel fan-out.",
			"4. Honour `gate` blocks — stop until DoD holds.",
			"5. Honour `checkpoint` stages — pause unless autonomous.",
			"6. Honour `loop` — re-run `back_to` until `until` is satisfied or `max_iterations` is reached.",
			"7. Write each stage's typed artifact to `.work-state/artifacts/<id>.json`.",
			"",
			"### Failure modes to avoid",
			"- Do NOT re-delegate from a subagent (rogue router).",
			"- Do NOT skip the `before_agent_start` classification gate.",
			"- Do NOT mark a stage done when its `artifacts` are empty.",
		].join("\n"),
		"",
		"Begin with the first stage of the resolved workflow now.",
	].join("\n");
}

const factory = (api: CustomCommandAPI): CustomCommand => ({
	name: "team",
	description: "Run a workflow via the profile-driven /team interpreter. /team <task>.",
	async execute(args: string[], ctx: HookCommandContext): Promise<string> {
		const raw = args.join(" ").trim();
		if (!raw) {
			return [
				"Usage: /team <task description>",
				"",
				"Examples:",
				"  /team Add OAuth authentication with Google and GitHub",
				"  /team [AUTONOMOUS] Fix the 500 error on /api/users issue=#42",
			].join("\n");
		}
		const cwd = ctx.cwd ?? api.cwd;
		if (!cwd) return "ERROR: no cwd available.";
		const envelope = parseEnvelope(raw, cwd);
		if (!envelope.task) return "ERROR: empty task after stripping prefix.";
		if (!envelope.branch) return "ERROR: not inside a git work tree.";
		ctx.ui?.notify?.(`team: ${envelope.task.slice(0, 60)} (workflow pending)`, "info");
		return buildPrompt(envelope, cwd);
	},
});

export default factory;
