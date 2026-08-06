import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	CTO_MODE_MARKER,
	buildCtoModeReminder,
	injectCtoModeReminder,
	resolveActiveCtoRun,
} from "../src/cto-mode-reminder.js";

const USER_MSG = { role: "user", content: [{ type: "text", text: "original user prompt" }], timestamp: 1 };
const ASSISTANT_MSG = { role: "assistant", content: [{ type: "text", text: "thinking…" }], timestamp: 2 };

test("cto-reminder: buildCtoModeReminder renders the delegation contract with run id and task", () => {
	const text = buildCtoModeReminder({ runId: "pr-watch", task: "Watch PRs and fix findings" });
	assert.ok(text.includes(CTO_MODE_MARKER), "marker line present");
	assert.ok(text.includes("pr-watch"), "run id present");
	assert.ok(text.includes("Watch PRs and fix findings"), "task present");
	assert.ok(text.includes("DELEGATE, do not absorb"), "delegation headline");
	assert.ok(text.includes("never code or patch yourself"), "orchestrator rule");
	assert.ok(text.includes("escalate what you cannot decide to the CTO"), "lead rule");
	assert.ok(text.includes("never re-delegate"), "worker rule");
	assert.ok(
		text.includes("task(agent=cto)") && text.includes("task(agent=@cto)"),
		"nested CTO dispatch forbidden in the reminder",
	);
	assert.ok(text.includes("MAIN AGENT"), "reminder names the main-session CTO");
	assert.ok(text.includes("returns to standby"), "reminder returns the CTO to standby");
});

test("cto-reminder: injectCtoModeReminder prepends a steering user message", () => {
	const result = injectCtoModeReminder([USER_MSG, ASSISTANT_MSG], "REMINDER");
	assert.ok(result, "injection produced a result");
	assert.equal(result!.messages.length, 3, "one message prepended");
	const first = result!.messages[0] as { role: string; steering?: boolean; content: Array<{ type: string; text: string }> };
	assert.equal(first.role, "user");
	assert.equal(first.steering, true, "steering flag set (harness wraps it for emphasis)");
	assert.ok(first.content.some((c) => c.type === "text" && c.text.includes("REMINDER")), "reminder text carried");
});

test("cto-reminder: injectCtoModeReminder dedupes when the marker is already present", () => {
	const withMarker = {
		role: "user",
		content: [{ type: "text", text: `some message ${CTO_MODE_MARKER} already here` }],
		timestamp: 1,
	};
	const result = injectCtoModeReminder([withMarker, ASSISTANT_MSG], "REMINDER");
	assert.equal(result, undefined, "no double injection within one snapshot");
});

test("cto-reminder: injectCtoModeReminder returns undefined on unusable snapshots", () => {
	assert.equal(injectCtoModeReminder([], "REMINDER"), undefined);
	assert.equal(injectCtoModeReminder(undefined as unknown as unknown[], "REMINDER"), undefined);
});

test("cto-reminder: resolveActiveCtoRun finds an engine-written active run", () => {
	const root = mkdtempSync(join(tmpdir(), "cto-reminder-"));
	try {
		const runDir = join(root, ".work-state", "cto", "run-one");
		mkdirSync(runDir, { recursive: true });
		writeFileSync(
			join(runDir, "state.json"),
			JSON.stringify({
				schema: 1,
				id: "run-one",
				task: "Implement OAuth",
				branch: "main",
				autonomous: false,
				plan: { id: "run-one", task: "Implement OAuth", teams: [], created_at: new Date().toISOString() },
				teams: [],
				integration: { status: "pending" },
				pause: { kind: "none", reason: "" },
				updated_at: new Date().toISOString(),
			}),
		);
		const run = resolveActiveCtoRun(root);
		assert.ok(run, "active run resolved");
		assert.equal(run!.runId, "run-one");
		assert.equal(run!.task, "Implement OAuth");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("cto-reminder: resolveActiveCtoRun ignores finished runs (pause done)", () => {
	const root = mkdtempSync(join(tmpdir(), "cto-reminder-done-"));
	try {
		const runDir = join(root, ".work-state", "cto", "run-done");
		mkdirSync(runDir, { recursive: true });
		writeFileSync(
			join(runDir, "state.json"),
			JSON.stringify({
				schema: 1,
				id: "run-done",
				task: "Done task",
				branch: "main",
				autonomous: false,
				plan: { id: "run-done", task: "Done task", teams: [], created_at: new Date().toISOString() },
				teams: [],
				integration: { status: "done" },
				pause: { kind: "done", reason: "" },
				updated_at: new Date().toISOString(),
			}),
		);
		assert.equal(resolveActiveCtoRun(root), null, "finished run is not active");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("cto-reminder: resolveActiveCtoRun returns null without a runs dir", () => {
	const root = mkdtempSync(join(tmpdir(), "cto-reminder-none-"));
	try {
		assert.equal(resolveActiveCtoRun(root), null);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
