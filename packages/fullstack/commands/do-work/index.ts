/**
 * /do-work — OMP custom-TS command (formerly /team).
 *
 * Part of the omp-workflows bundle. Loaded by OMP from
 * `.omp/commands/do-work/index.ts` (copied at install time by the
 * fullstack package's `postinstall` hook).
 *
 * Contract:
 * - Receives `HookCommandContext` (ui, cwd, sessionManager, modelRegistry).
 * - Returns a string that is fed to the main agent as the next prompt.
 *   The main agent owns the `task` tool and runs the workflow through it.
 * - Does NOT call `task` directly (custom-TS commands lack that surface).
 *
 * Supported prefixes:
 * - `[AUTONOMOUS] <task> [issue=#N]` — autonomous mode.
 * - `<task> [issue=#N]`              — interactive mode.
 *
 * Returns a fully-formed prompt that:
 *  1. Sets the workflow discipline (discovery → architecture → implementation
 *     → review → manual-qa → qa-tests for full-feature).
 *  2. Resolves the role mapping from `.omp/team.config.json`.
 *  3. Names the next classified profile so the main agent picks the right
 *     workflow.
 *
 * Backwards compatibility: a sibling command `/team` (`commands/team/index.ts`)
 * is shipped as a thin alias that delegates to the same `parseEnvelope` /
 * `buildPrompt` so old keybinds and muscle memory still work. Both commands
 * resolve to the same workflow.
 */

import { execSync } from "node:child_process";
import type { CustomCommand, CustomCommandAPI } from "@oh-my-pi/pi-coding-agent/extensibility/custom-commands/types";
import type { HookCommandContext } from "@oh-my-pi/pi-coding-agent/extensibility/hooks/types";
import { classifyTask, resolveWorkflowName } from "./_lib/classify.js";
import { loadTeamConfig } from "./_lib/config.js";

const AUTONOMOUS_PREFIX = "[AUTONOMOUS";

export interface ParsedEnvelope {
	task: string;
	autonomous: boolean;
	issue: number | null;
	branch: string | null;
}

/**
 * Parse the raw `<args>` string for `/do-work` (or its `/team` alias).
 *
 * Recognized syntax:
 *   `[AUTONOMOUS] <task description> [issue=#N]`
 *
 * Detects whether `cwd` is inside a git work tree; if not, `branch` is
 * `null` instead of failing the command — `/do-work` is expected to be
 * usable in throwaway sandboxes too.
 */
export function parseEnvelope(args: string, cwd: string): ParsedEnvelope {
	const autonomous = args.trimStart().startsWith(AUTONOMOUS_PREFIX);
	const stripped = autonomous ? args.trimStart().slice(AUTONOMOUS_PREFIX.length).trimStart() : args;
	const cleaned = stripped.startsWith("]") ? stripped.slice(1).trimStart() : stripped;
	const issueMatch = cleaned.match(/issue=#(\d+)/);
	const issue = issueMatch ? Number(issueMatch[1]) : null;
	const task = (issueMatch ? cleaned.replace(issueMatch[0], "") : cleaned).trim();

	let branch: string | null = null;
	try {
		branch = execSync("git rev-parse --abbrev-ref HEAD", { cwd, encoding: "utf8" }).trim() || null;
	} catch {
		// Not inside a git work tree (sandbox, fresh tmp dir, no .git, ...).
		// Fall through with branch=null and let buildPrompt render "(no git)".
		branch = null;
	}
	return { task, autonomous, issue, branch };
}

/**
 * Build the workflow prompt the main agent will execute.
 *
 * Same output regardless of whether the user invoked `/do-work` or `/team` —
 * the alias command delegates here.
 */
export function buildPrompt(envelope: ParsedEnvelope, cwd: string): string {
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
	const branchMeta = envelope.branch ? `Branch: \`${envelope.branch}\`\n` : "Branch: (no git work tree)\n";
	const autonomousMeta = envelope.autonomous
		? "Autonomous mode: ON. Skip user checkpoints; apply `autonomous` decision for every `checkpoint` stage.\n"
		: "Autonomous mode: OFF. Pause at each `checkpoint` stage for user review.\n";

	return [
		"/do-work workflow — execute via your `task` tool.",
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
		`- Workflow profile: \`packages/core/workflows/${workflow}.json\` (read this file for the stage list, gates, checkpoints, produces/consumes)`,
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
		"### Subagent validation contract (machine-checked, v0.7.0+)",
		"For any stage that produces a code-bearing artifact (`implementation`, `review_fixes`), the engine inspects the produced JSON before handing it to the next stage. Required: `ready: true`, `validation_run: \"true\"` (string), and non-empty `validation_evidence` containing verbatim build/test output. A subagent that returns `ready: true` without these is rejected — the stage is marked `failed` and you re-spawn the developer. There is NO escape hatch: phrases like \"orchestrator owns validation\", \"subagent skips tests\", `validation_run: \"false\"` do not exist in the engine. If a subagent's task is genuinely unvalidatable, mark the stage `failed` and have the developer fix it.",
		"",
		"### Orchestrator discipline (you are the dispatcher, not the coder)",
		"- You do NOT edit source code. If a subagent's output is wrong, re-spawn with a sharper task. Do not patch their artifact by hand.",
		"- You do NOT second-guess build/test output by re-running it. The subagent owns the validation evidence; you trust it or re-spawn.",
		"- You do NOT skip stages to \"save time\". The profile order is the contract.",
		"- You do NOT mark a stage done to unblock downstream work. If the gate rejected, surface the rejection and re-spawn.",
		"- When a stage fails validation, your only job is to call the same agent again with the gate's reason as the new task. The reason is in the stage outcome's `note` field — copy it verbatim into the re-spawn prompt so the subagent can fix the gap.",
		"",
		"Begin with the first stage of the resolved workflow now.",
	].join("\n");
}

const factory = (api: CustomCommandAPI): CustomCommand => ({
	name: "do-work",
	description: "Run a profile-driven workflow. /do-work <task>. (Alias: /team.)",
	async execute(args: string[], ctx: HookCommandContext): Promise<string> {
		const raw = args.join(" ").trim();
		if (!raw) {
			return [
				"Usage: /do-work <task description>",
				"",
				"Examples:",
				"  /do-work Add OAuth authentication with Google and GitHub",
				"  /do-work [AUTONOMOUS] Fix the 500 error on /api/users issue=#42",
				"",
				"Alias: `/team` works too.",
			].join("\n");
		}
		const cwd = ctx.cwd ?? api.cwd;
		if (!cwd) return "ERROR: no cwd available.";
		const envelope = parseEnvelope(raw, cwd);
		if (!envelope.task) return "ERROR: empty task after stripping prefix.";
		ctx.ui?.notify?.(`do-work: ${envelope.task.slice(0, 60)} (workflow pending)`, "info");
		return buildPrompt(envelope, cwd);
	},
});

export default factory;
