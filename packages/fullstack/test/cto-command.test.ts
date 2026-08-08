/**
 * Smoke test: the `/cto` custom-TS command must boot, parse the envelope,
 * render the team registry, and emit a fully-formed CTO prompt — without
 * importing OMP at all (fake CustomCommandAPI + HookCommandContext).
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import ctoFactory from "../commands/cto/index.js";
import { buildCtoPrompt, buildAmendPrompt, findActiveCtoRun, parseEnvelope } from "../commands/cto/_lib/cto.js";

const projectRoot = process.cwd();

const fakeApi = {
	cwd: projectRoot,
	exec: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
	typebox: {} as never,
	arktype: {} as never,
	zod: {} as never,
	pi: {} as never,
};

const fakeCtx = {
	cwd: projectRoot,
	ui: { notify: () => undefined },
	hasUI: false,
	sessionManager: undefined,
	modelRegistry: undefined,
	model: undefined,
	isIdle: () => true,
	abort: () => undefined,
	hasQueuedMessages: () => false,
};

const TEAMS_JSON = [
	{
		id: "kotlin-backend",
		name: "Kotlin Backend",
		scope: ["backend-kotlin"],
		profile: "lightweight",
		lead: "team-lead",
		roster: ["backend-kotlin"],
	},
	{
		id: "frontend",
		name: "Frontend",
		scope: ["frontend"],
		profile: "lightweight",
		lead: "team-lead",
		roster: ["frontend"],
	},
];

test("fullstack: /cto command loads and parses an envelope", async () => {
	const cmd = ctoFactory(fakeApi as never);
	assert.equal(cmd.name, "cto");
	assert.ok(cmd.description.includes("CTO"));

	const result = await cmd.execute(["Add OAuth with Google"], fakeCtx as never);
	assert.equal(typeof result, "string");
	assert.ok(result.includes("Add OAuth with Google"), "result echoes the task");
	assert.ok(result.includes("/cto workflow"), "result opens the CTO contract");
	assert.ok(result.includes("Team registry"), "prompt includes the team registry section");
	assert.ok(result.includes("CTO discipline"), "prompt includes the CTO discipline");
	assert.ok(result.includes("max 8"), "prompt states the team cap");
});

	test("fullstack: /cto renders teams from .omp/teams.json", () => {
	const root = mkdtempSync(join(tmpdir(), "cto-cmd-"));
	try {
		mkdirSync(join(root, ".omp"), { recursive: true });
		writeFileSync(join(root, ".omp", "teams.json"), JSON.stringify(TEAMS_JSON));
		const result = buildCtoPrompt(parseEnvelope("Add OAuth", root), root);
		assert.ok(result.includes("| `kotlin-backend` | Kotlin Backend |"), "backend team row rendered");
		assert.ok(result.includes("| `frontend` | Frontend |"), "frontend team row rendered");
		assert.ok(!result.includes("(no teams configured)"), "no fallback hint when teams exist");
		assert.ok(result.includes("Leads never write source"), "lead self-coding forbidden in the contract");
		assert.ok(result.includes("You ARE the orchestrator"), "single-CTO rule in the contract");
		assert.ok(result.includes("resident CTO"), "main-session CTO role in the contract");
		assert.ok(
			result.includes("task(agent=cto)") && result.includes("task(agent=@cto)"),
			"nested CTO dispatch forbidden in the contract",
		);
		assert.ok(result.includes("return to standby"), "CTO returns to standby after the wave");
		assert.ok(result.includes("debug-cycle"), "bug-fix slices run debug-cycle through the team");
		assert.ok(result.includes("Architecture first"), "architecture stage in the contract");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("fullstack: /cto degrades gracefully without teams.json", () => {
	const root = mkdtempSync(join(tmpdir(), "cto-cmd-empty-"));
	try {
		const result = buildCtoPrompt(parseEnvelope("Add OAuth", root), root);
		assert.ok(result.includes("(no teams configured)"), "fallback hint rendered");
		assert.ok(result.includes(".omp/teams.json"), "hint names the file to create");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("fullstack: /cto contract carries the lead exit-1 failover protocol", () => {
	const root = mkdtempSync(join(tmpdir(), "cto-cmd-failover-"));
	try {
		const result = buildCtoPrompt(parseEnvelope("Add OAuth", root), root);
		assert.ok(result.includes("Subagent dispatch reliability"), "reliability section present");
		assert.ok(result.includes("lead exit-1 protocol"), "failover protocol named");
		assert.ok(result.includes("SAME slice spec"), "re-spawn with the same spec");
		assert.ok(result.includes("Second failure -> degrade"), "degradation path documented");
		assert.ok(result.includes("skip the lead hop"), "single-worker slices dispatch directly");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("fullstack: [AUTONOMOUS] prefix toggles autonomous mode", async () => {
	const cmd = ctoFactory(fakeApi as never);
	const result = await cmd.execute(["[AUTONOMOUS] Fix bug #42"], fakeCtx as never);
	assert.ok(result.includes("Autonomous mode: ON"), "autonomous flag lands in metadata");
});

test("fullstack: natural-language directive toggles autonomous mode ON and persists the flag", async () => {
	const cmd = ctoFactory(fakeApi as never);
	const result = await cmd.execute(["действуй автономно: Fix bug #42"], fakeCtx as never);
	assert.ok(result.includes("Autonomous mode: ON"), "natural directive flips mode on");
	assert.ok(result.includes("autonomous: true"), "persistence contract carries the literal parsed flag");
	assert.ok(result.includes("Fix bug #42"), "task text preserved after stripping the directive");
});

test("fullstack: /cto amends only same-session runs (foreign session gets a fresh contract)", async () => {
	const root = mkdtempSync(join(tmpdir(), "cto-cmd-owner-"));
	try {
		mkdirSync(join(root, ".omp"), { recursive: true });
		writeFileSync(join(root, ".omp", "teams.json"), JSON.stringify(TEAMS_JSON));
		const runId = "owned-run";
		mkdirSync(join(root, ".work-state", "cto", runId), { recursive: true });
		writeFileSync(
			join(root, ".work-state", "cto", runId, "state.json"),
			JSON.stringify({
				schema: 2,
				id: runId,
				task: "Owned task",
				branch: "main",
				autonomous: true,
				standby: false,
				owner_session: "sess-A",
				plan: { id: runId, task: "Owned task", teams: [], created_at: "2026-08-04T10:00:00.000Z" },
				teams: [{ id: "kotlin-backend", status: "in_progress", escalations: {} }],
				integration: { status: "pending" },
				pause: { kind: "none", reason: "" },
				updated_at: "2026-08-04T10:05:00.000Z",
			}),
		);

		const ownerCtx = { ...fakeCtx, cwd: root, sessionManager: { getSessionId: () => "sess-A" } };
		const ownerResult = await ctoFactory(fakeApi as never).execute(["Add feature B"], ownerCtx as never);
		assert.ok(ownerResult.includes("/cto AMEND"), "same session folds into its own run");

		const foreignCtx = { ...fakeCtx, cwd: root, sessionManager: { getSessionId: () => "sess-B" } };
		const foreignResult = await ctoFactory(fakeApi as never).execute(["Add feature C"], foreignCtx as never);
		assert.ok(foreignResult.includes("/cto workflow"), "foreign session gets the fresh contract");
		assert.ok(!foreignResult.includes("/cto AMEND"), "foreign session must not amend an owned run");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("fullstack: issue=#N is stripped into the prompt metadata", async () => {
	const cmd = ctoFactory(fakeApi as never);
	const result = await cmd.execute(["Add OAuth issue=#7"], fakeCtx as never);
	assert.ok(result.includes("Issue: #7"), "issue metadata rendered");
	assert.ok(!result.includes("issue=#7"), "raw issue token stripped from the task");
});

test("fullstack: empty args start CTO STANDBY", async () => {
	const cmd = ctoFactory(fakeApi as never);
	const result = await cmd.execute([], fakeCtx as never);
	assert.ok(result.includes("/cto STANDBY"), "empty args start standby mode");
	assert.ok(result.includes("[CTO-INBOX]"), "standby documents the wake envelope");
	assert.ok(result.includes("Adopt or persist the standby run"), "standby reuses queued tasks instead of creating a second run");
	assert.ok(result.includes("awaiting inbox tasks"), "standby names the inbox contract");
	assert.ok(result.includes("ARE USER COMMANDS"), "inbox messages are user commands to the main-session CTO");
	assert.ok(result.includes("return to standby"), "standby returns to standby after each wave");
	assert.ok(result.includes("task(agent=@cto)"), "nested CTO dispatch forbidden in standby");
	assert.ok(result.includes("(schema 2,"), "standby writer instructed to emit schema-2 state (core parity)");
	assert.ok(!result.includes("schema 1"), "no schema-1 drift in the shipped standby prompt");
});

test("fullstack: parseEnvelope falls back to branch=null outside a git work tree", () => {
	const root = mkdtempSync(join(tmpdir(), "cto-cmd-nogit-"));
	try {
		const envelope = parseEnvelope("Add OAuth", root);
		assert.equal(envelope.branch, null);
		assert.equal(envelope.task, "Add OAuth");
		assert.equal(envelope.autonomous, false);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("fullstack: /cto routes to AMEND when an active run exists", async () => {
	const root = mkdtempSync(join(tmpdir(), "cto-cmd-amend-"));
	try {
		mkdirSync(join(root, ".omp"), { recursive: true });
		writeFileSync(join(root, ".omp", "teams.json"), JSON.stringify(TEAMS_JSON));
		// Simulate an active CTO run.
		const runId = "feature-a-2026-08-04";
		mkdirSync(join(root, ".work-state", "cto", runId), { recursive: true });
		writeFileSync(
			join(root, ".work-state", "cto", runId, "state.json"),
			JSON.stringify({
				schema: 1,
				id: runId,
				task: "Feature A",
				branch: "main",
				autonomous: false,
				plan: { id: runId, task: "Feature A", teams: [], created_at: "2026-08-04T10:00:00.000Z" },
				teams: [
					{ id: "kotlin-backend", status: "in_progress", escalations: {} },
					{ id: "frontend", status: "parked", escalations: {} },
				],
				integration: { status: "pending" },
				pause: { kind: "none", reason: "" },
				updated_at: "2026-08-04T10:05:00.000Z",
			}),
		);

		const active = findActiveCtoRun(root);
		assert.equal(active?.runId, runId);
		assert.ok(!active?.state.pause.kind.includes("done"));

		const cmd = ctoFactory(fakeApi as never);
		const result = await cmd.execute(["Add feature B"], { ...fakeCtx, cwd: root } as never);
		assert.ok(result.includes("/cto AMEND"), "second /cto returns the amend contract");
		assert.ok(result.includes("Add feature B"), "new task folded in");
		assert.ok(result.includes("Do NOT start a second run"), "single orchestrator rule");
		assert.ok(result.includes("resident CTO"), "amend keeps the main-session CTO role");

		// A finished run no longer amends.
		const doneRun = JSON.parse(readFileSync(join(root, ".work-state", "cto", runId, "state.json"), "utf8")) as {
			pause: { kind: string };
		};
		doneRun.pause.kind = "done";
		writeFileSync(join(root, ".work-state", "cto", runId, "state.json"), JSON.stringify(doneRun));
		assert.equal(findActiveCtoRun(root), null);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("fullstack: findActiveCtoRun falls back to markdown state (br-5ql)", () => {
	const root = mkdtempSync(join(tmpdir(), "cto-cmd-md-"));
	try {
		const runId = "md-run-2";
		const runDir = join(root, ".work-state", "cto", runId);
		mkdirSync(runDir, { recursive: true });
		writeFileSync(join(runDir, "team-plan.md"), "# Team Plan\n- team: kotlin-backend\n- team: frontend\n");
		writeFileSync(join(runDir, "decisions.md"), "table\n");

		const active = findActiveCtoRun(root);
		assert.ok(active, "markdown-only run detected");
		assert.equal(active?.runId, runId);
		assert.deepEqual(
			active?.state.teams.map((t) => t.id).sort(),
			["frontend", "kotlin-backend"],
		);

		writeFileSync(join(runDir, "summary.md"), "# Summary\n");
		assert.equal(findActiveCtoRun(root), null, "summary finishes the run");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("fullstack: buildAmendPrompt renders the amend contract", () => {
	const root = mkdtempSync(join(tmpdir(), "cto-cmd-amendp-"));
	try {
		const prompt = buildAmendPrompt(parseEnvelope("Task B", root), root, {
			runId: "run-1",
			state: {
				plan: { created_at: "2026-08-04T10:00:00.000Z" },
				teams: [{ id: "backend", status: "in_progress" }],
				pause: { kind: "none", reason: "" },
				updated_at: "2026-08-04T10:05:00.000Z",
			},
		});
		assert.ok(prompt.includes("/cto AMEND"));
		assert.ok(prompt.includes("Run: `run-1`"));
		assert.ok(prompt.includes("Integration covers ALL teams"));
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});


test("fullstack: /cto prompt embeds the channel section from .omp/escalation.json", () => {
	const root = mkdtempSync(join(tmpdir(), "cto-cmd-chan-"));
	try {
		const noChannel = buildCtoPrompt(parseEnvelope("Add OAuth", root), root);
		assert.ok(noChannel.includes("User channel (none)"), "no-channel hint rendered");
		mkdirSync(join(root, ".omp"), { recursive: true });
		writeFileSync(
			join(root, ".omp", "escalation.json"),
			JSON.stringify({ adapter: "telegram", telegram: { token: "t", chatId: "c" } }),
		);
		const withChannel = buildCtoPrompt(parseEnvelope("Add OAuth", root), root);
		assert.ok(withChannel.includes("BIDIRECTIONAL"), "telegram rendered as bidirectional");
		assert.ok(withChannel.includes("NEVER use the `ask` tool"), "ask banned in messenger mode");
		assert.ok(withChannel.includes("USER COMMAND"), "inbox tasks are user commands in messenger mode");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
