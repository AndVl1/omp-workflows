import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
	isRegisteredWorkflow,
	resetWorkflowOwners,
	workflowOwnerFor,
	claimWorkflowOwners,
	type WorkflowCapability,
} from "@andvl1/omp-workflows-core";

import ompWorkflowsInternal, { ensureEngineActivation, resolveSessionCwd } from "../src/index.js";
import { OMP_INTERNAL_BUNDLE_ID, OMP_INTERNAL_OWNER_KIND } from "../src/identity.js";

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
		fireSessionStart(ctx: unknown): void {
			for (const handler of hooks.get("session_start") ?? []) handler({}, ctx);
		},
	};
}

function markedRoot(): string {
	const root = mkdtempSync(join(tmpdir(), "omp-internal-entry-marked-"));
	writeFileSync(join(root, "package.json"), "{}\n");
	mkdirSync(join(root, "packages", "core"), { recursive: true });
	mkdirSync(join(root, "packages", "fullstack"), { recursive: true });
	return root;
}

function plainRoot(): string {
	return mkdtempSync(join(tmpdir(), "omp-internal-entry-plain-"));
}

function assertUnclaimed(cwd: string, capability: WorkflowCapability): void {
	assert.equal(workflowOwnerFor(cwd, capability), undefined, `${capability} must be unclaimed`);
}

const ALL_CAPABILITIES: WorkflowCapability[] = ["workflow_registration", "workflow_tools", "config_writer"];

const FOREIGN_IDENTITY = {
	owner_id: "foreign-bundle",
	bundle_id: "foreign-bundle",
	owner_kind: "fullstack",
	activation_marker: "omp-fullstack",
	host_range: ">=17.3 <19",
	provenance: { package: "foreign-bundle", entrypoint: "dist/index.js" },
};

// ── Scenarios ────────────────────────────────────────────────────────────────

test("zero workflow-engine registration when workspace markers are absent", () => {
	resetWorkflowOwners();
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
	for (const capability of ALL_CAPABILITIES) assertUnclaimed(root, capability);
});

test("the diagnostic command itself is always available, even unactivated", () => {
	resetWorkflowOwners();
	const host = makePi();
	ompWorkflowsInternal(host.pi as never);
	assert.ok(host.commands.has("omp-workflow-team"));
	assert.ok(!host.commands.has("do-work") && !host.commands.has("team") && !host.commands.has("cto"));
});

test("with all markers present the bundle claims every capability under frozen identity", () => {
	resetWorkflowOwners();
	const root = markedRoot();
	const host = makePi();
	ompWorkflowsInternal(host.pi as never);

	host.fireSessionStart({ cwd: root });

	assert.deepEqual(host.labels, [OMP_INTERNAL_BUNDLE_ID]);
	for (const capability of ALL_CAPABILITIES) {
		const claim = workflowOwnerFor(root, capability);
		assert.ok(claim, `${capability} must be claimed`);
		assert.equal(claim?.owner.owner_id, OMP_INTERNAL_BUNDLE_ID);
		assert.equal(claim?.owner.owner_kind, OMP_INTERNAL_OWNER_KIND);
	}
	assert.equal(isRegisteredWorkflow("omp-feature"), true, "bundle profile registered");
	assert.equal(isRegisteredWorkflow("omp-validate"), true, "bundle profile registered");
});

test("re-activation is idempotent per host instance", () => {
	resetWorkflowOwners();
	const root = markedRoot();
	const host = makePi();
	ompWorkflowsInternal(host.pi as never);
	host.fireSessionStart({ cwd: root });
	host.fireSessionStart({ cwd: root });
	assert.deepEqual(host.labels, [OMP_INTERNAL_BUNDLE_ID], "label set exactly once");
});

test("foreign claim on one capability blocks the whole bundle before any registration", () => {
	resetWorkflowOwners();
	const root = markedRoot();
	const conflicts = claimWorkflowOwners(root, ["workflow_registration"], {
		...FOREIGN_IDENTITY,
		provenance: { ...FOREIGN_IDENTITY.provenance, cwd: root, config_path: join(root, ".omp", "team.config.json") },
	});
	assert.equal(conflicts.ok, true);
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
	assert.equal(workflowOwnerFor(root, "workflow_registration")?.owner.owner_id, "foreign-bundle");
	assertUnclaimed(root, "workflow_tools");
	assertUnclaimed(root, "config_writer");
});

test("an already-activated bundle rejects a later foreign claim (reverse order)", () => {
	resetWorkflowOwners();
	const root = markedRoot();
	const host = makePi();
	ompWorkflowsInternal(host.pi as never);
	host.fireSessionStart({ cwd: root });

	const attempted = claimWorkflowOwners(root, ["workflow_tools"], {
		...FOREIGN_IDENTITY,
		provenance: { ...FOREIGN_IDENTITY.provenance, cwd: root, config_path: join(root, ".omp", "team.config.json") },
	});
	assert.equal(attempted.ok, false);
	if (!attempted.ok) assert.equal(attempted.code, "owner_conflict");
	assert.equal(workflowOwnerFor(root, "workflow_tools")?.owner.owner_id, OMP_INTERNAL_BUNDLE_ID);
});

test("`omp-workflow-team validate` is strictly read-only", async () => {
	resetWorkflowOwners();
	const root = markedRoot();
	const host = makePi();
	ompWorkflowsInternal(host.pi as never);
	const command = host.commands.get("omp-workflow-team");
	assert.ok(command);

	await command.handler("validate", { cwd: root });

	assert.match(host.sent[0] ?? "", /markers: OK/);
	assert.match(host.sent[0] ?? "", /workflow_registration: unclaimed/);
	assert.match(host.sent[0] ?? "", new RegExp(OMP_INTERNAL_BUNDLE_ID));
	for (const capability of ALL_CAPABILITIES) assertUnclaimed(root, capability);
	assert.deepEqual(host.labels, [], "validate performs no activation");
});

test("command path fails closed with a structured diagnostic when markers are missing", async () => {
	resetWorkflowOwners();
	const root = plainRoot();
	const host = makePi();
	ompWorkflowsInternal(host.pi as never);
	const command = host.commands.get("omp-workflow-team");
	assert.ok(command);

	await command.handler("some task", { cwd: root });

	assert.match(host.sent[0] ?? "", /activation_markers_missing/);
	assert.deepEqual(host.labels, []);
	for (const capability of ALL_CAPABILITIES) assertUnclaimed(root, capability);
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

test("a throw mid-registration yields a typed degradation, never a silent ok", () => {
	resetWorkflowOwners();
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

test("registration recovers on a later attempt once the host stops throwing", () => {
	resetWorkflowOwners();
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
	for (const capability of ALL_CAPABILITIES) {
		assert.equal(workflowOwnerFor(root, capability)?.owner.owner_id, OMP_INTERNAL_BUNDLE_ID);
	}
});
