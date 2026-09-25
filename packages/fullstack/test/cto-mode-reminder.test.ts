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

test("cto-reminder: resolves only a claim proven by the invoking host context", () => {
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
		const ownerManager = { getCwd: () => root, getSessionId: () => "session-owner" };
		const ownerContext = {
			cwd: root,
			mode: "tui",
			hasUI: true,
			session_id: "session-owner",
			sessionManager: ownerManager,
		};
		const claimResolver = (ctx: { cwd: string; [key: string]: unknown }) =>
			ctx.sessionManager === ownerManager
				&& ctx.session_id === "session-owner"
				&& ctx.mode === "tui"
				&& ctx.hasUI === true
				? { run_id: "run-one", ownership_epoch: "epoch-1" }
				: undefined;
		const run = resolveActiveCtoRun(ownerContext, claimResolver);
		assert.deepEqual(run, { runId: "run-one", task: "Implement OAuth" });
		assert.equal(resolveActiveCtoRun({ cwd: root }, claimResolver), null, "cwd-only legacy lookup is denied");
		assert.equal(
			resolveActiveCtoRun(
				{ ...ownerContext, session_id: "foreign-session", sessionManager: { getCwd: () => root, getSessionId: () => "foreign-session" } },
				claimResolver,
			),
			null,
			"same-cwd foreign session cannot reuse the owner reminder",
		);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("cto-reminder: finished runs do not render even with a matching claim", () => {
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
		const manager = { getCwd: () => root, getSessionId: () => "session-owner" };
		const context = { cwd: root, mode: "tui", hasUI: true, session_id: "session-owner", sessionManager: manager };
		assert.equal(
			resolveActiveCtoRun(context, () => ({ run_id: "run-done", ownership_epoch: "epoch-1" })),
			null,
			"finished run is not active",
		);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("cto-reminder: missing claim stays fail closed", () => {
	const root = mkdtempSync(join(tmpdir(), "cto-reminder-none-"));
	try {
		const manager = { getCwd: () => root, getSessionId: () => "session-owner" };
		const context = { cwd: root, mode: "tui", hasUI: true, session_id: "session-owner", sessionManager: manager };
		assert.equal(resolveActiveCtoRun(context), null);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
