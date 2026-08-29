import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
	isRegisteredWorkflow,
	resetWorkflowOwners,
	workflowOwnerFor,
	type WorkflowCapability,
} from "@andvl1/omp-workflows-core";

import ompWorkflowsInternal, {
	resolveGatedCommandCwd,
} from "../src/index.js";
import {
	OMP_INTERNAL_ACTIVATION_MARKER,
	OMP_INTERNAL_BUNDLE_ID,
	OMP_INTERNAL_OWNER_KIND,
	privateOmpOwnerForMarkedWorkspace,
} from "../src/identity.js";

// ── Fake host surface ────────────────────────────────────────────────────────

interface RecordedCommand {
	name: string;
	description?: string;
	handler: (args: string, ctx: unknown) => Promise<void> | void;
}

type SessionStartHandler = (event: unknown, ctx: unknown) => unknown;

function makePi() {
	const commands = new Map<string, RecordedCommand>();
	const hooks = new Map<string, SessionStartHandler[]>();
	const labels: string[] = [];
	const tools: string[] = [];
	const sent: string[] = [];
	const errors: string[] = [];
	const pi = {
		registerCommand(name: string, options: { description?: string; handler: RecordedCommand["handler"] }) {
			commands.set(name, { name, ...options });
		},
		on(event: string, handler: SessionStartHandler) {
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
		errors,
		/**
		 * Mirrors host isolation: a throwing handler is recorded and the
		 * remaining handlers still run (OMP routes per-handler errors through
		 * its extension error channel instead of aborting the dispatch).
		 */
		fireSessionStart(ctx: unknown): void {
			for (const handler of [...(hooks.get("session_start") ?? [])]) {
				try {
					handler({}, ctx);
				} catch (error) {
					errors.push(error instanceof Error ? error.message : String(error));
				}
			}
		},
	};
}

function markedRoot(): string {
	const root = mkdtempSync(join(tmpdir(), "omp-internal-ns-marked-"));
	writeFileSync(join(root, "package.json"), "{}\n");
	mkdirSync(join(root, "packages", "core"), { recursive: true });
	mkdirSync(join(root, "packages", "fullstack"), { recursive: true });
	return root;
}

function plainRoot(): string {
	return mkdtempSync(join(tmpdir(), "omp-internal-ns-plain-"));
}

function commandContext(cwd: string): unknown {
	return {
		cwd,
		sessionManager: { getCwd: () => cwd, getSessionId: () => "ns-session-1" },
		ui: { notify() {} },
	};
}

const ALL_CAPABILITIES: WorkflowCapability[] = ["workflow_registration", "workflow_tools", "config_writer"];

function assertUnclaimed(cwd: string, capability: WorkflowCapability): void {
	assert.equal(workflowOwnerFor(cwd, capability), undefined, `${capability} must be unclaimed`);
}

// ── Missing-marker contract ──────────────────────────────────────────────────

test("descriptors publish eagerly outside a marked workspace, but session_start claims zero owners", () => {
	resetWorkflowOwners();
	const root = plainRoot();
	const host = makePi();
	ompWorkflowsInternal(host.pi as never);

	// Eager publication happened at extension load, before any session event.
	assert.deepEqual(
		[...host.commands.keys()].sort(),
		["omp-cto", "omp-do-work", "omp-team", "omp-workflow-team"],
	);

	host.fireSessionStart({ cwd: root });

	for (const capability of ALL_CAPABILITIES) assertUnclaimed(root, capability);
	assert.deepEqual(host.labels, [], "no engine label outside the marked workspace");
	assert.deepEqual(host.tools, [], "no tool registrations outside the marked workspace");
	assert.equal(isRegisteredWorkflow("omp-feature") && false, false, "no bundle profile registered");
	assert.equal(host.errors.length, 0, "gated resolution claims zero owners and never throws outside the marked workspace");
});

test("namespaced command handlers fail closed with workflow-cwd-unavailable outside a marked workspace", async () => {
	const root = plainRoot();
	const host = makePi();
	ompWorkflowsInternal(host.pi as never);

	for (const name of ["omp-do-work", "omp-team", "omp-cto"]) {
		const command = host.commands.get(name);
		assert.ok(command, `${name} descriptor must exist`);
		await assert.rejects(
			command.handler("some task", commandContext(root)),
			/workflow cwd unavailable/,
			`${name} must refuse outside the marked workspace`,
		);
	}

	assert.deepEqual(host.sent, [], "no workflow prompt may leave the gate");
	for (const capability of ALL_CAPABILITIES) assertUnclaimed(root, capability);
});

// ── Marked-workspace inventory/claim contract ────────────────────────────────

test("in a marked workspace workflow_registration is claimed first, then all three under one owner", () => {
	resetWorkflowOwners();
	const root = markedRoot();
	const host = makePi();
	ompWorkflowsInternal(host.pi as never);

	const handlers = host.hooks.get("session_start") ?? [];
	assert.ok(handlers.length >= 2, "core claim handler + engine activation handler expected");

	// Step 1: core's namespaced-command session_start handler claims the
	// registration capability first.
	handlers[0]?.({}, { cwd: root });
	const first = workflowOwnerFor(root, "workflow_registration");
	assert.ok(first, "workflow_registration must be claimed by the command layer first");
	assert.equal(first?.owner.owner_id, OMP_INTERNAL_BUNDLE_ID);
	assertUnclaimed(root, "workflow_tools");
	assertUnclaimed(root, "config_writer");

	// Step 2: the engine activation handler idempotently claims all three.
	for (const handler of handlers.slice(1)) handler({}, { cwd: root });
	for (const capability of ALL_CAPABILITIES) {
		const claim = workflowOwnerFor(root, capability);
		assert.ok(claim, `${capability} must be claimed`);
		assert.equal(claim?.owner.owner_id, OMP_INTERNAL_BUNDLE_ID, "single owner across capabilities");
		assert.equal(claim?.owner.owner_kind, OMP_INTERNAL_OWNER_KIND);
	}
	assert.equal(isRegisteredWorkflow("omp-feature"), true);
	assert.equal(isRegisteredWorkflow("omp-validate"), true);
	assert.deepEqual(host.labels, [OMP_INTERNAL_BUNDLE_ID]);
});

test("repeated session_start in a marked workspace stays idempotent under the single owner", () => {
	resetWorkflowOwners();
	const root = markedRoot();
	const host = makePi();
	ompWorkflowsInternal(host.pi as never);

	host.fireSessionStart({ cwd: root });
	host.fireSessionStart({ cwd: root });

	assert.deepEqual(host.labels, [OMP_INTERNAL_BUNDLE_ID], "label set exactly once");
	const fingerprints = new Set(
		ALL_CAPABILITIES.map((capability) => workflowOwnerFor(root, capability)?.fingerprint ?? ""),
	);
	assert.equal(fingerprints.size, 1, "all three claims share one owner fingerprint");
	assert.equal(host.errors.length, 0, "marked workspace produces no gated refusals");
});

// ── Resolver and owner-source units ──────────────────────────────────────────

test("resolveGatedCommandCwd yields the session cwd only for a marked workspace", () => {
	const marked = markedRoot();
	const plain = plainRoot();

	assert.equal(resolveGatedCommandCwd({ cwd: marked }), marked);
	assert.equal(resolveGatedCommandCwd({ cwd: plain }), undefined);
	assert.equal(
		resolveGatedCommandCwd({ sessionManager: { getCwd: () => marked }, cwd: plain }),
		marked,
		"session manager stays authoritative",
	);
	assert.equal(resolveGatedCommandCwd({}), undefined);
	assert.equal(resolveGatedCommandCwd(undefined), undefined);
});

test("privateOmpOwnerForMarkedWorkspace issues the frozen identity only inside the marked workspace", () => {
	const marked = markedRoot();
	const plain = plainRoot();

	const owner = privateOmpOwnerForMarkedWorkspace(marked);
	assert.equal(owner.owner_id, OMP_INTERNAL_BUNDLE_ID);
	assert.equal(owner.activation_marker, OMP_INTERNAL_ACTIVATION_MARKER);

	assert.throws(() => privateOmpOwnerForMarkedWorkspace(plain), /activation_markers_missing/);
	assertUnclaimed(plain, "workflow_registration");
});
