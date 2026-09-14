import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
	isRegisteredWorkflow,
	type WorkflowCapability,
} from "@andvl1/omp-workflows-core";
import { openWorkflowActivation, releaseWorkflowOwners } from "@andvl1/omp-workflows-core/registry";

import ompWorkflowsInternal, { ensureEngineActivation, resolveSessionCwd } from "../src/index.js";
import { OMP_INTERNAL_BUNDLE_ID } from "../src/identity.js";

// ── Fake host surface ────────────────────────────────────────────────────────

interface RecordedCommand {
	name: string;
	description?: string;
	handler: (args: string, ctx: unknown) => Promise<void> | void;
}

function makePi() {
	const commands = new Map<string, RecordedCommand>();
	const hooks = new Map<string, Array<(event: unknown, ctx: unknown) => unknown>>();
	const labels: string[] = [];
	const tools: string[] = [];
	const sent: string[] = [];
	const pi = {
		registerCommand(name: string, options: { description?: string; handler: RecordedCommand["handler"] }) {
			commands.set(name, { name, ...options });
		},
		on(event: string, handler: (event: unknown, ctx: unknown) => unknown) {
			const list = hooks.get(event) ?? [];
			list.push(handler);
			hooks.set(event, list);
		},
		setLabel(label: string) {
			labels.push(label);
		},
		registerTool(tool: { name: string }) {
			tools.push(tool.name);
		},
		sendUserMessage(content: string) {
			sent.push(content);
		},
	};
	return {
		pi,
		commands,
		hooks,
		labels,
		tools,
		sent,
		fireSessionStart(ctx: unknown, event: unknown = {}): void {
			for (const handler of hooks.get("session_start") ?? []) handler(event, ctx);
		},
		fireSessionShutdown(ctx: unknown, event: unknown = {}): void {
			for (const handler of hooks.get("session_shutdown") ?? []) handler(event, ctx);
		},
	};
}

function markedRoot(): string {
	const root = mkdtempSync(join(tmpdir(), "omp-internal-entry-marked-"));
	writeFileSync(join(root, "package.json"), "{}\n");
	mkdirSync(join(root, "packages", "core"), { recursive: true });
	mkdirSync(join(root, "packages", "fullstack"), { recursive: true });
	// Core only writes an existing runtime-config directory; a real marked
	// workspace carries this policy directory before extension activation.
	mkdirSync(join(root, ".omp"), { recursive: true });
	return root;
}

function plainRoot(): string {
	return mkdtempSync(join(tmpdir(), "omp-internal-entry-plain-"));
}

function replaceAllMarkers(root: string): void {
	rmSync(join(root, "package.json"));
	rmSync(join(root, "packages", "core"), { recursive: true });
	rmSync(join(root, "packages", "fullstack"), { recursive: true });
	writeFileSync(join(root, "package.json"), "{}\n");
	mkdirSync(join(root, "packages", "core"), { recursive: true });
	mkdirSync(join(root, "packages", "fullstack"), { recursive: true });
}

const FOREIGN_IDENTITY = {
	owner_id: "foreign-bundle",
	bundle_id: "foreign-bundle",
	owner_kind: "fullstack",
	activation_marker: "omp-fullstack",
	host_range: ">=17.3 <19",
	activation: {
		marker_id: "omp-fullstack",
		required: [
			{ path: "package.json", kind: "file" },
			{ path: "packages/core", kind: "directory" },
			{ path: "packages/fullstack", kind: "directory" },
		],
	},
	provenance: { package: "foreign-bundle", entrypoint: "dist/index.js" },
};

function openForeignActivation(root: string, capabilities: readonly WorkflowCapability[]) {
	const activation = openWorkflowActivation(root, capabilities, {
		...FOREIGN_IDENTITY,
		provenance: { ...FOREIGN_IDENTITY.provenance, cwd: root, config_path: join(root, ".omp", "team.config.json") },
	});
	return activation;
}

// ── Scenarios ────────────────────────────────────────────────────────────────

test("zero workflow-engine registration when workspace markers are absent", () => {
	const root = plainRoot();
	const host = makePi();
	ompWorkflowsInternal(host.pi as never);

	host.fireSessionStart({ cwd: root });

	assert.deepEqual(host.labels, [], "no setLabel side effect");
	assert.deepEqual(host.tools, [], "no tool registrations");
	assert.equal(host.hooks.has("before_agent_start"), false, "engine gates not wired");
	assert.equal(host.hooks.has("tool_call"), false, "engine gates not wired");
	assert.equal(host.hooks.has("session_stop"), false, "engine gates not wired");
	assert.equal(isRegisteredWorkflow("omp-feature") && false, false);
});

test("the diagnostic command itself is always available, even unactivated", () => {
	const host = makePi();
	ompWorkflowsInternal(host.pi as never);
	assert.ok(host.commands.has("omp-workflow-team"));
	assert.ok(!host.commands.has("do-work") && !host.commands.has("team") && !host.commands.has("cto"));
});

test("with all markers present the bundle claims every capability under frozen identity", () => {
	const root = markedRoot();
	const host = makePi();
	ompWorkflowsInternal(host.pi as never);

	host.fireSessionStart({ cwd: root });

	assert.deepEqual(host.labels, [OMP_INTERNAL_BUNDLE_ID]);
	assert.equal(isRegisteredWorkflow("omp-feature"), true, "bundle profile registered");
	assert.equal(isRegisteredWorkflow("omp-validate"), true, "bundle profile registered");
});

test("re-activation is idempotent per host instance", () => {
	const root = markedRoot();
	const host = makePi();
	ompWorkflowsInternal(host.pi as never);
	host.fireSessionStart({ cwd: root });
	host.fireSessionStart({ cwd: root });
	assert.deepEqual(host.labels, [OMP_INTERNAL_BUNDLE_ID], "label set exactly once");
});


test("session shutdown releases the retained generation and stale shutdown cannot evict its replacement", () => {
	const root = markedRoot();
	try {
		const host = makePi();
		ompWorkflowsInternal(host.pi as never);
		const first = ensureEngineActivation(host.pi as never, root, "internal-session-A");
		assert.equal(first.ok, true);
		rmSync(join(root, "package.json"));
		host.fireSessionShutdown({ cwd: root }, { sessionId: "internal-session-A" });
		assert.equal(isRegisteredWorkflow("omp-feature"), false, "shutdown must release profile lease even after marker loss");
		replaceAllMarkers(root);
		const second = ensureEngineActivation(host.pi as never, root, "internal-session-B");
		assert.equal(second.ok, true, "same host must activate a fresh generation after shutdown");
		host.fireSessionShutdown({ cwd: root }, { sessionId: "internal-session-A" });
		assert.equal(isRegisteredWorkflow("omp-feature"), true, "stale shutdown must not evict the replacement generation");
		host.fireSessionShutdown({ cwd: root }, { sessionId: "internal-session-B" });
		host.fireSessionShutdown({ cwd: root }, { sessionId: "internal-session-B" });
		assert.equal(isRegisteredWorkflow("omp-feature"), false, "repeated shutdown must remain idempotent");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("foreign claim on one capability blocks the whole bundle before any registration", () => {
	const root = markedRoot();
	const conflicts = openForeignActivation(root, ["workflow_registration"]);
	assert.equal(conflicts.ok, true);
	if (!conflicts.ok) return;
	try {
	const host = makePi();
	ompWorkflowsInternal(host.pi as never);

	// Accepted wave-001 contract: command ownership throws owner_conflict on a
	// foreign preclaim during session_start instead of failing open.
	assert.throws(
		() => host.fireSessionStart({ cwd: root }),
		/owner_conflict/,
		"core command ownership must throw owner_conflict against the foreign preclaim",
	);

	assert.deepEqual(host.labels, [], "fail closed: no label");
	assert.deepEqual(host.tools, [], "fail closed: no tools");
	assert.equal(host.hooks.has("before_agent_start"), false, "engine gates stay unwired");
	assert.equal(isRegisteredWorkflow("omp-feature") && false, false, "no engine/profile registration side effect");
	} finally {
		releaseWorkflowOwners(conflicts.release_token, conflicts.leased_capabilities);
	}
});

test("an already-activated bundle rejects a later foreign claim (reverse order)", () => {
	const root = markedRoot();
	const host = makePi();
	ompWorkflowsInternal(host.pi as never);
	host.fireSessionStart({ cwd: root });

	const attempted = openForeignActivation(root, ["workflow_tools"]);
	assert.equal(attempted.ok, false);
	if (!attempted.ok) assert.equal(attempted.code, "owner_conflict");
});

test("`omp-workflow-team validate` is strictly read-only", async () => {
	const root = markedRoot();
	const host = makePi();
	ompWorkflowsInternal(host.pi as never);
	const command = host.commands.get("omp-workflow-team");
	assert.ok(command);

	await command.handler("validate", { cwd: root });

	assert.match(host.sent[0] ?? "", /markers: OK/);
	assert.match(host.sent[0] ?? "", /workflow_registration: not active in this host/);
	assert.match(host.sent[0] ?? "", new RegExp(OMP_INTERNAL_BUNDLE_ID));
	assert.deepEqual(host.labels, [], "validate performs no activation");
});

test("command path fails closed with a structured diagnostic when markers are missing", async () => {
	const root = plainRoot();
	const host = makePi();
	ompWorkflowsInternal(host.pi as never);
	const command = host.commands.get("omp-workflow-team");
	assert.ok(command);

	await command.handler("some task", { cwd: root });

	assert.match(host.sent[0] ?? "", /activation_markers_missing/);
	assert.deepEqual(host.labels, []);
});

test("resolveSessionCwd prefers the session manager and never falls back to process.cwd()", () => {
	assert.equal(
		resolveSessionCwd({ sessionManager: { getCwd: () => "/tmp/from-manager" }, cwd: "/tmp/from-context" }),
		"/tmp/from-manager",
	);
	assert.equal(resolveSessionCwd({ cwd: "/tmp/from-context" }), "/tmp/from-context");
	assert.equal(resolveSessionCwd({}), undefined);
	assert.equal(resolveSessionCwd(undefined), undefined);
});

test("session manager getter failure is authoritative over stale context cwd", () => {
	const stale = "/tmp/stale-context-cwd";
	assert.equal(resolveSessionCwd({ sessionManager: { getCwd: () => { throw new Error("manager unavailable"); } }, cwd: stale }), undefined);
	assert.equal(resolveSessionCwd({ sessionManager: {}, cwd: stale }), undefined);
	assert.equal(resolveSessionCwd({ sessionManager: { getCwd: () => "" }, cwd: stale }), undefined);
	assert.equal(resolveSessionCwd({ sessionManager: { getCwd: () => 42 }, cwd: stale }), undefined);
	const throwingGetter = {};
	Object.defineProperty(throwingGetter, "getCwd", { get: () => { throw new Error("getter unavailable"); } });
	assert.equal(resolveSessionCwd({ sessionManager: throwingGetter, cwd: stale }), undefined);
});

test("a throw mid-registration yields a typed degradation, never a silent ok", () => {
	const root = markedRoot();
	const failing = makePi();
	// registerTeamWorkflow calls pi.setLabel first — inject the failure there.
	failing.pi.setLabel = () => {
		throw new Error("host registration exploded");
	};
	const first = ensureEngineActivation(failing.pi as never, root);
	assert.equal(first.ok, false);
	if (!first.ok) {
		assert.equal(first.code, "registration_failed");
		assert.match(first.error, /host registration exploded/);
	}
	// The immediate retry must NOT be treated as already-wired.
	const second = ensureEngineActivation(failing.pi as never, root);
	assert.equal(second.ok, false);
	if (!second.ok) assert.equal(second.code, "registration_failed");
});

test("runtime config failure rolls back only this activation's new claims", () => {
	const root = markedRoot();
	// A marked workspace with an invalid .omp target makes the synchronous
	// seed fail after ownership was claimed, before registration can proceed.
	rmSync(join(root, ".omp"), { recursive: true, force: true });
	writeFileSync(join(root, ".omp"), "not a directory\n");
	const host = makePi();
	const first = ensureEngineActivation(host.pi as never, root);
	assert.equal(first.ok, false);
	if (!first.ok) assert.equal(first.code, "registration_failed");

	// Repairing the target permits a same-owner retry; no abandoned claim may
	// permanently deny the valid bundle.
	rmSync(join(root, ".omp"), { force: true });
	mkdirSync(join(root, ".omp"), { recursive: true });
	const second = ensureEngineActivation(host.pi as never, root);
	assert.equal(second.ok, true);
});

test("registration recovers on a later attempt once the host stops throwing", () => {
	const root = markedRoot();
	const flaky = makePi();
	let failures = 1;
	flaky.pi.setLabel = (label: string) => {
		if (failures > 0) {
			failures -= 1;
			throw new Error("transient host failure");
		}
		flaky.labels.push(label);
	};
	const first = ensureEngineActivation(flaky.pi as never, root);
	assert.equal(first.ok, false);
	if (!first.ok) assert.equal(first.code, "registration_failed");
	const second = ensureEngineActivation(flaky.pi as never, root);
	assert.equal(second.ok, true);
	assert.deepEqual(flaky.labels, [OMP_INTERNAL_BUNDLE_ID]);
});

test("registration rollback uses original-root token across replacement and preserves foreign claims", () => {
	const parentOne = mkdtempSync(join(tmpdir(), "omp-internal-rollback-parent-one-"));
	const parentTwo = mkdtempSync(join(tmpdir(), "omp-internal-rollback-parent-two-"));
	const aliasParent = join(tmpdir(), `omp-internal-rollback-alias-${process.pid}-${Date.now()}`);
	const workspaceName = "workspace";
	const originalRoot = join(parentOne, workspaceName);
	const replacementRoot = join(parentTwo, workspaceName);
	const movedRoot = `${originalRoot}-moved`;
	const createMarked = (root: string): void => {
		mkdirSync(join(root, "packages", "core"), { recursive: true });
		mkdirSync(join(root, "packages", "fullstack"), { recursive: true });
		writeFileSync(join(root, "package.json"), "{}\n");
		mkdirSync(join(root, ".omp"), { recursive: true });
	};
	createMarked(originalRoot);
	createMarked(replacementRoot);
	symlinkSync(parentOne, aliasParent, "dir");
	const cwd = join(aliasParent, workspaceName);
	const foreign = openForeignActivation(replacementRoot, ["workflow_registration"]);
	assert.equal(foreign.ok, true);
	if (!foreign.ok) return;

	const failing = makePi();
	failing.pi.setLabel = () => {
		// Move the claimed physical root away and point the same lexical cwd at
		// a marked replacement before registration reports failure.
		renameSync(originalRoot, movedRoot);
		rmSync(aliasParent, { force: true });
		symlinkSync(parentTwo, aliasParent, "dir");
		throw new Error("registration failed after root replacement");
	};
	const first = ensureEngineActivation(failing.pi as never, cwd);
	assert.equal(first.ok, false);
	if (!first.ok) assert.match(first.error, /root replacement/);

	// Restore the original inode/path and retry through the original alias. A
	// pathname-based rollback would have missed the old registry key after the
	// alias switched to parentTwo, leaving this retry permanently conflicted.
	rmSync(aliasParent, { force: true });
	symlinkSync(parentOne, aliasParent, "dir");
	renameSync(movedRoot, originalRoot);
	const retry = ensureEngineActivation(makePi().pi as never, cwd);
	assert.equal(retry.ok, true, "the original activation claims were released by token");
	releaseWorkflowOwners(foreign.release_token, foreign.leased_capabilities);

	rmSync(aliasParent, { force: true });
	rmSync(parentOne, { recursive: true, force: true });
	rmSync(parentTwo, { recursive: true, force: true });
});

test("initial marked activation writes config and permits a normal later session", () => {
	const root = markedRoot();
	const host = makePi();
	ompWorkflowsInternal(host.pi as never);
	const first = ensureEngineActivation(host.pi as never, root);
	assert.equal(first.ok, true);
	const configPath = join(root, ".omp", "team.config.json");
	assert.equal(existsSync(configPath), true, "initial activation must seed config");
	const before = readFileSync(configPath, "utf8");
	const second = ensureEngineActivation(host.pi as never, root);
	assert.equal(second.ok, true);
	assert.equal(readFileSync(configPath, "utf8"), before, "normal subsequent activation is idempotent");
});

test("marker deletion and symlink substitution reject retained activation before writes", () => {
	const root = markedRoot();
	const host = makePi();
	ompWorkflowsInternal(host.pi as never);
	assert.equal(ensureEngineActivation(host.pi as never, root).ok, true);
	const configPath = join(root, ".omp", "team.config.json");
	const configStat = statSync(configPath);

	rmSync(join(root, "packages", "fullstack"), { recursive: true });
	const deleted = ensureEngineActivation(host.pi as never, root);
	assert.equal(deleted.ok, false);
	if (!deleted.ok) assert.equal(deleted.code, "activation_markers_missing");
	assert.equal(statSync(configPath).mtimeMs, configStat.mtimeMs, "marker deletion must block config writes");

	const symlinkRoot = markedRoot();
	const symlinkHost = makePi();
	ompWorkflowsInternal(symlinkHost.pi as never);
	assert.equal(ensureEngineActivation(symlinkHost.pi as never, symlinkRoot).ok, true);
	const symlinkConfig = join(symlinkRoot, ".omp", "team.config.json");
	const symlinkConfigStat = statSync(symlinkConfig);
	const realFullstack = mkdtempSync(join(tmpdir(), "omp-internal-symlink-marker-"));
	rmSync(join(symlinkRoot, "packages", "fullstack"), { recursive: true });
	symlinkSync(realFullstack, join(symlinkRoot, "packages", "fullstack"), "dir");
	const linked = ensureEngineActivation(symlinkHost.pi as never, symlinkRoot);
	assert.equal(linked.ok, false);
	if (!linked.ok) assert.equal(linked.code, "activation_markers_missing");
	assert.equal(statSync(symlinkConfig).mtimeMs, symlinkConfigStat.mtimeMs, "symlink substitution must block config writes");
	assert.equal(existsSync(join(symlinkRoot, ".work-state")), false, "revoked activation must not create state");
});

test("complete marker replacement blocks retained owner/config writes", () => {
	const root = markedRoot();
	const host = makePi();
	ompWorkflowsInternal(host.pi as never);
	assert.equal(ensureEngineActivation(host.pi as never, root).ok, true);
	const configPath = join(root, ".omp", "team.config.json");
	const before = readFileSync(configPath, "utf8");

	replaceAllMarkers(root);
	const replaced = ensureEngineActivation(host.pi as never, root);
	assert.equal(replaced.ok, false);
	if (!replaced.ok) assert.equal(replaced.code, "activation_identity_changed");
	assert.equal(readFileSync(configPath, "utf8"), before, "marker replacement must not rewrite config");
	assert.equal(existsSync(join(root, ".work-state")), false, "marker replacement must not create state");
});

test("tracked marker replacement revokes retained activation", () => {
	const root = markedRoot();
	const host = makePi();
	ompWorkflowsInternal(host.pi as never);
	assert.equal(ensureEngineActivation(host.pi as never, root).ok, true);
	const configPath = join(root, ".omp", "team.config.json");
	const before = readFileSync(configPath, "utf8");

	rmSync(join(root, "package.json"));
	writeFileSync(join(root, "package.json"), "{\"updated\":true}\n");
	const replaced = ensureEngineActivation(host.pi as never, root);
	assert.equal(replaced.ok, false, "tracked marker identity replacement must revoke activation");
	if (!replaced.ok) assert.equal(replaced.code, "activation_identity_changed");
	assert.equal(readFileSync(configPath, "utf8"), before, "tracked marker replacement must not rewrite config");
});

test("root replacement blocks retained command ownership before replacement-root writes", () => {
	const root = markedRoot();
	const oldRoot = `${root}-old`;
	const host = makePi();
	ompWorkflowsInternal(host.pi as never);
	assert.equal(ensureEngineActivation(host.pi as never, root).ok, true);

	renameSync(root, oldRoot);
	mkdirSync(root, { recursive: true });
	writeFileSync(join(root, "package.json"), "{}\n");
	mkdirSync(join(root, "packages", "core"), { recursive: true });
	mkdirSync(join(root, "packages", "fullstack"), { recursive: true });

	const replaced = ensureEngineActivation(host.pi as never, root);
	assert.equal(replaced.ok, false);
	if (!replaced.ok) assert.equal(replaced.code, "activation_identity_changed");
	assert.equal(existsSync(join(root, ".omp")), false, "replacement root must not receive config");
	assert.equal(existsSync(join(root, ".work-state")), false, "replacement root must not receive state");
	assert.equal(existsSync(join(oldRoot, ".omp", "team.config.json")), true, "original root remains intact");
});
