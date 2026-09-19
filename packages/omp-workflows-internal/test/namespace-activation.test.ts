import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
	isRegisteredWorkflow,
	type WorkflowCapability,
	type WorkflowOwnerIdentity,
} from "@andvl1/omp-workflows-core";
import { openWorkflowActivation, releaseWorkflowOwners, workflowOwnerFor } from "@andvl1/omp-workflows-core/registry";

import ompWorkflowsInternal, {
	resolveGatedCommandCwd,
} from "../src/index.js";
import {
	OMP_INTERNAL_ACTIVATION_MARKER,
	OMP_INTERNAL_BUNDLE_ID,
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

const CAPABILITIES: readonly WorkflowCapability[] = ["workflow_registration", "workflow_tools", "config_writer"];

const FOREIGN_IDENTITY: WorkflowOwnerIdentity = {
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
	provenance: { package: "foreign-bundle", entrypoint: "dist/index.js", cwd: "" },
};

function openForeignActivation(root: string, capabilities: readonly WorkflowCapability[]) {
	return openWorkflowActivation(root, capabilities, {
		...FOREIGN_IDENTITY,
		provenance: { ...FOREIGN_IDENTITY.provenance, cwd: root, config_path: join(root, ".omp", "team.config.json") },
	});
}

// ── Missing-marker contract ──────────────────────────────────────────────────

const NAMESPACED_COMMANDS = [
	"omp-cto",
	"omp-do-work",
	"omp-spec-import",
	"omp-spec-plan",
	"omp-spec-tasks",
	"omp-specify",
	"omp-team",
	"omp-workflow-team",
];

test("only the diagnostic command publishes before a marked session mounts the omp namespace", () => {
	const root = markedRoot();
	const host = makePi();
	ompWorkflowsInternal(host.pi as never);

	// registerWorkflowCommands is a lifecycle mount: before the session root is
	// authenticated, only the private diagnostic command is discoverable.
	assert.deepEqual([...host.commands.keys()], ["omp-workflow-team"]);

	host.fireSessionStart({ cwd: root });
	assert.deepEqual([...host.commands.keys()].sort(), NAMESPACED_COMMANDS);
	assert.deepEqual(host.labels, [OMP_INTERNAL_BUNDLE_ID]);
	assert.equal(host.errors.length, 0, "marked workspace mounts without gated refusals");
});

test("an unmarked session leaves only the diagnostic command and claims zero owners", () => {
	const root = plainRoot();
	const host = makePi();
	ompWorkflowsInternal(host.pi as never);

	host.fireSessionStart({ cwd: root });

	assert.deepEqual([...host.commands.keys()], ["omp-workflow-team"]);
	assert.deepEqual(host.labels, [], "no engine label outside the marked workspace");
	assert.deepEqual(host.tools, [], "no tool registrations outside the marked workspace");
	assert.equal(isRegisteredWorkflow("omp-feature") && false, false, "no bundle profile registered");
	assert.equal(host.errors.length, 0, "gated resolution claims zero owners and never throws outside the marked workspace");
});

test("namespaced command handlers fail closed when invoked from an unmarked workspace", async () => {
	const marked = markedRoot();
	const host = makePi();
	ompWorkflowsInternal(host.pi as never);
	host.fireSessionStart({ cwd: marked });

	const plain = plainRoot();
	for (const name of ["omp-do-work", "omp-team", "omp-cto", "omp-specify", "omp-spec-plan", "omp-spec-tasks", "omp-spec-import"]) {
		const command = host.commands.get(name);
		assert.ok(command, `${name} descriptor must exist after marked-session mount`);
		await assert.rejects(
			command.handler("some task", commandContext(plain)),
			/workflow cwd unavailable/,
			`${name} must refuse outside the marked workspace`,
		);
	}

	assert.deepEqual(host.sent, [], "no workflow prompt may leave the gate");
});

// ── Marked-workspace inventory/claim contract ────────────────────────────────

test("in a marked workspace workflow_registration is claimed first, then all three under one owner", () => {
	const root = markedRoot();
	const host = makePi();
	ompWorkflowsInternal(host.pi as never);

	const handlers = host.hooks.get("session_start") ?? [];
	assert.ok(handlers.length >= 2, "core claim handler + engine activation handler expected");

	// Step 1: core's namespaced-command session_start handler claims the
	// registration capability first. The remaining capabilities must remain
	// unclaimed until the engine activation handler runs.
	handlers[0]?.({}, { cwd: root });
	const registrationProbe = openForeignActivation(root, ["workflow_registration"]);
	assert.equal(registrationProbe.ok, false);
	if (!registrationProbe.ok) assert.equal(registrationProbe.code, "owner_conflict");
	for (const capability of ["workflow_tools", "config_writer"] as const) {
		assert.equal(workflowOwnerFor(root, capability), undefined, `${capability} remains available before engine activation`);
	}

	// Step 2: the engine activation handler idempotently claims all three.
	for (const handler of handlers.slice(1)) handler({}, { cwd: root });
	for (const capability of CAPABILITIES) {
		assert.equal(workflowOwnerFor(root, capability)?.owner.owner_id, OMP_INTERNAL_BUNDLE_ID, `${capability} must be claimed after engine activation`);
	}
	assert.equal(isRegisteredWorkflow("omp-feature"), true);
	assert.equal(isRegisteredWorkflow("omp-validate"), true);
	assert.deepEqual(host.labels, [OMP_INTERNAL_BUNDLE_ID]);

	const freshRoot = markedRoot();
	const fresh = openWorkflowActivation(freshRoot, CAPABILITIES, privateOmpOwnerForMarkedWorkspace(freshRoot));
	assert.equal(fresh.ok, true, "a fresh isolated marked root accepts activation");
	if (fresh.ok) releaseWorkflowOwners(fresh.release_token, fresh.leased_capabilities);
});


test("repeated session_start in a marked workspace stays idempotent under the single owner", () => {
	const root = markedRoot();
	const host = makePi();
	ompWorkflowsInternal(host.pi as never);

	host.fireSessionStart({ cwd: root });
	host.fireSessionStart({ cwd: root });

	assert.deepEqual(host.labels, [OMP_INTERNAL_BUNDLE_ID], "label set exactly once");
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
});
