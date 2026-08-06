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
 * Returns a classification-first prompt that:
 *  1. Makes the main LLM semantically understand the task before routing.
 *  2. Resolves the profile only after the classification gate.
 *  3. Walks the selected profile through the main agent's `task` tool.
 *  4. Resolves role mapping from `.omp/team.config.json`.
 *
 * Backwards compatibility: a sibling command `/team` (`commands/team/index.ts`)
 * is shipped as a thin alias that delegates to the same `parseEnvelope` /
 * `buildPrompt` so old keybinds and muscle memory still work. Both commands
 * resolve to the same workflow.
 */

import { execSync } from "node:child_process";
import type { CustomCommand, CustomCommandAPI } from "@oh-my-pi/pi-coding-agent/extensibility/custom-commands/types";
import type { HookCommandContext } from "@oh-my-pi/pi-coding-agent/extensibility/hooks/types";
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
 * Build the first-pass prompt. Profile resolution is intentionally deferred:
 * custom-TS commands cannot call the model directly, so this prompt is the
 * handoff to the main LLM's semantic classification turn. It must not contain
 * a resolved profile or stage skeleton; otherwise the model starts executing
 * an heuristic route before understanding the task.
 */
export function buildPrompt(envelope: ParsedEnvelope, cwd: string): string {
	const config = loadTeamConfig(cwd);
	const roles = Object.entries(config.roles ?? {});
	const roleTable = roles
		.map(([role, agent]) => `| \`${role}\` | \`${agent}\` |`)
		.join("\n");

	const issueMeta = envelope.issue ? `Issue: #${envelope.issue}\n` : "";
	const branchMeta = envelope.branch ? `Branch: \`${envelope.branch}\`\n` : "Branch: (no git work tree)\n";
	const autonomousMeta = envelope.autonomous
		? "Autonomous mode: ON. After classification, apply the profile's autonomous decisions.\n"
		: "Autonomous mode: OFF. After classification, pause at profile checkpoints for user review.\n";

	return [
		"/do-work classification pass — understand the task before selecting a workflow.",
		"",
		"### Task",
		envelope.task,
		"",
		"### Metadata",
		issueMeta + branchMeta + autonomousMeta,
		"### PHASE 0: INTELLIGENT CLASSIFICATION (zero step)",
		"Before any other tool call — no `read`, `glob`, `grep`, `bash`, `edit`, `write`, or `task` — understand the task semantically.",
		"Do NOT use keyword counts, task length, or language-specific keyword lists. Infer the requested outcome, primary intent, scope, constraints, risk, and whether code changes are actually requested.",
		"",
		"Return this visible block before continuing:",
		"CLASSIFICATION:",
		"- Type: FEATURE | REFACTOR | OPS | BUG_FIX | INVESTIGATION | REVIEW | HOTFIX",
		"- Complexity: QUICK | MEDIUM | COMPLEX | CRITICAL",
		"- Workflow: resolved from the matrix below",
		"- Confidence: HIGH | MEDIUM | LOW",
		"- Reason: concise evidence-based explanation",
		"",
		"Then write `.work-state/team-state.json` (or the active feature state) with the classification, resolved workflow, task, autonomous flag, and initial pending stages. This state write is the gate before any investigation or delegation.",
		"If confidence is LOW, ask a focused clarification question before writing an expansive workflow (unless autonomous mode is ON; then document a conservative default).",
		"",
		"### Workflow resolution (only after PHASE 0)",
		"Resolve the profile from the semantic classification, not from heuristics:",
		"| Type | QUICK | MEDIUM | COMPLEX | CRITICAL |",
		"| --- | --- | --- | --- | --- |",
		"| FEATURE | lightweight | standard | full-feature | full-feature |",
		"| REFACTOR | lightweight | standard | full-feature | full-feature |",
		"| OPS | lightweight | standard | standard | standard |",
		"| BUG_FIX | bug-fix | debug-cycle | debug-cycle | debug-cycle |",
		"| INVESTIGATION | research | research | research | research |",
		"| REVIEW | review | review | review | review |",
		"| HOTFIX | emergency | emergency | emergency | emergency |",
		"",
		"### Only after state is written",
		"1. Read exactly the resolved workflow profile file and then its stages.",
		"2. Walk the selected profile in order; do not execute any stage before classification and state persistence.",
		"3. For each `single` stage, call `task` once; for each `consilium` stage, use one parallel `task` batch.",
		"4. Honour gates, checkpoints, loops, typed artifacts, and the validation contract.",
		"### Role mapping (from .omp/team.config.json)",
		"| Role | Agent |",
		"| --- | --- |",
		roleTable || "| (no roles configured) | |",
		"",
		"### Hard constraints",
		"- Do NOT call `task` during classification.",
		"- Do NOT glob for workflow files or scan installed plugins.",
		"- Do NOT read command sources or reconstruct classification from keywords.",
		"- Do NOT mark a stage done without its required artifact and gate evidence.",
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
