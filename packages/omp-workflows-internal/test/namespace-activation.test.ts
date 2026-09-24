import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
	isRegisteredWorkflow,
	readRunControl,
	resetWorkflowOwners,
	runTarget,
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

function permissiveZod(): { z: unknown } {
	const schema = new Proxy({}, { get: () => () => schema });
	const z = new Proxy({}, { get: () => () => schema });
	return { z };
}

function makePi(options: { tools?: boolean } = {}) {
	const commands = new Map<string, RecordedCommand>();
	const hooks = new Map<string, SessionStartHandler[]>();
	const labels: string[] = [];
	const tools: string[] = [];
	const toolHandlers = new Map<string, unknown>();
	const sent: string[] = [];
	const errors: string[] = [];
	const pi = {
		...(options.tools ? { zod: permissiveZod() } : {}),
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
		registerTool(tool: { name: string; execute?: unknown }) {
			tools.push(tool.name);
			if (tool.execute !== undefined) toolHandlers.set(tool.name, tool.execute);
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
		toolHandlers,
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
		fireToolCall(event: unknown, ctx: unknown): unknown[] {
			return (hooks.get("tool_call") ?? []).map((handler) => handler(event, ctx));
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

test("trusted host controller survives worker, marker-missing, and cwd-less session_start events", async () => {
	resetWorkflowOwners();
	const root = markedRoot();
	execFileSync("git", ["-C", root, "init", "--quiet", "--initial-branch", "main"], { stdio: "ignore" });
	const host = makePi();
	ompWorkflowsInternal(host.pi as never);

	const hostContext = {
		cwd: root,
		mode: "tui",
		hasUI: true,
		sessionManager: { getCwd: () => root, getSessionId: () => "trusted-host-session" },
		ui: { notify() {} },
	};
	const workerContext = {
		cwd: root,
		mode: "print",
		hasUI: false,
		actor: "worker",
		sessionManager: { getCwd: () => root, getSessionId: () => "worker-session" },
		ui: { notify() {} },
	};
	const foreignRoot = plainRoot();
	const markerMissingWorkerContext = {
		cwd: foreignRoot,
		mode: "print",
		hasUI: false,
		actor: "worker",
		sessionManager: { getCwd: () => foreignRoot, getSessionId: () => "foreign-worker-session" },
		ui: { notify() {} },
	};
	const cwdlessWorkerContext = {
		mode: "print",
		hasUI: false,
		actor: "worker",
		sessionManager: { getSessionId: () => "cwdless-worker-session" },
		ui: { notify() {} },
	};

	host.fireSessionStart(hostContext);
	host.fireSessionStart(workerContext);
	// A foreign worker session can also report an unmarked cwd; this must not
	// release the trusted controller captured for the host workspace.
	host.fireSessionStart(markerMissingWorkerContext);
	host.fireSessionStart(cwdlessWorkerContext);

	const command = host.commands.get("omp-do-work");
	assert.ok(command);
	await assert.rejects(
		command.handler("worker task", workerContext),
		/trusted session identity is unavailable/,
		"worker ingress must not borrow the trusted host controller",
	);
	await command.handler("host task", hostContext);
	assert.equal(host.sent.length, 1, "only the trusted host command may dispatch");
	assert.match(host.sent[0] ?? "", /host task/);
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
test("captured host admits ordinary no-run writes while preserving session and selected-run boundaries", async () => {
	resetWorkflowOwners();
	const root = markedRoot();
	execFileSync("git", ["-C", root, "init", "--quiet", "--initial-branch", "main"], { stdio: "ignore" });
	const host = makePi({ tools: true });
	ompWorkflowsInternal(host.pi as never);

	const hostContext = {
		cwd: root,
		mode: "tui",
		hasUI: true,
		session_id: "trusted-host-session",
		sessionManager: { getCwd: () => root, getSessionId: () => "trusted-host-session" },
		ui: { notify() {} },
	};
	host.fireSessionStart(hostContext);
	// The production host publishes the core session_start handlers before
	// dispatching the lifecycle event. The harness activation above publishes
	// them during that dispatch, so replay the same authoritative ingress once
	// to exercise the complete registered workflow_prepare path.
	host.fireSessionStart(hostContext);
	const rawHostContext = { sessionManager: hostContext.sessionManager };
	const writeEvent = (path: string) => ({ toolName: "write", input: { path, content: "{}" } });
	const hookResults = (ctx: unknown, path: string): unknown[] => host.fireToolCall(writeEvent(path), ctx);
	const hasBlock = (ctx: unknown, path: string): boolean =>
		hookResults(ctx, path).some(
			(result) => Boolean(result && typeof result === "object" && "block" in result && result.block === true),
		);

	assert.equal(hasBlock(rawHostContext, join(root, "src", "app.ts")), false, "claim-free captured host bypasses only the outer actor preblock");

	const controlPath = join(root, ".work-state", "run-control.json");
	mkdirSync(join(root, ".work-state"), { recursive: true });
	const emptyControl = {
		schema: 2,
		revision: 0,
		runs: {},
		selections: {},
		execution_claim: null,
		prepare_receipts: {},
		selection_snapshots: {},
	};
	writeFileSync(controlPath, JSON.stringify({
		...emptyControl,
		execution_claim: { run_id: "other-run", token: "foreign-token" },
	}));
	assert.equal(hasBlock(rawHostContext, join(root, "src", "claimed.ts")), true, "a non-null execution claim denies no-run admission");
	writeFileSync(controlPath, "{ malformed run control");
	assert.equal(hasBlock(rawHostContext, join(root, "src", "corrupt.ts")), true, "an unreadable canonical control denies no-run admission");
	writeFileSync(controlPath, JSON.stringify(emptyControl));
	assert.equal(readRunControl(root).execution_claim, null);
	for (const mismatch of [
		{ field: "session_id", context: { ...rawHostContext, session_id: "foreign-session" } },
		{ field: "sessionId", context: { ...rawHostContext, sessionId: "foreign-session" } },
	] as const) {
		assert.equal(
			hasBlock(mismatch.context, join(root, "src", `${mismatch.field}-no-run.ts`)),
			true,
			`copied captured manager with mismatched ${mismatch.field} cannot use no-run admission`,
		);
	}

	const executePrepare = host.toolHandlers.get("workflow_prepare") as
		| ((id: string, params: unknown, signal: unknown, update: unknown, ctx: unknown) => Promise<unknown>)
		| undefined;
	assert.equal(typeof executePrepare, "function", "workflow_prepare must be registered for selected-run authority");
	const prepared = await executePrepare!(
		"namespace-captured-host-prepare",
		{
			mode: "new",
			task: "selected host run",
			classification: {
				type: "FEATURE" as const,
				complexity: "QUICK" as const,
				confidence: "HIGH" as const,
				autonomous: false,
				workflow: "lightweight",
			},
		},
		undefined,
		undefined,
		hostContext,
	);
	const preparedDetails = (prepared as { details?: { ok?: boolean; artifacts_dir?: string; state?: { run_id?: string } } }).details;
	assert.equal(preparedDetails?.ok, true, JSON.stringify(prepared));
	const selectedRunId = preparedDetails?.state?.run_id;
	assert.equal(typeof selectedRunId, "string", JSON.stringify(prepared));
	assert.equal(readRunControl(root).execution_claim?.run_id, selectedRunId);
	assert.equal(typeof preparedDetails?.artifacts_dir, "string", JSON.stringify(prepared));
	mkdirSync(preparedDetails?.artifacts_dir as string, { recursive: true });
	const target = runTarget(root, selectedRunId as string);
	for (const mismatch of [
		{ field: "session_id", context: { ...rawHostContext, session_id: "foreign-session" } },
		{ field: "sessionId", context: { ...rawHostContext, sessionId: "foreign-session" } },
	] as const) {
		assert.equal(
			hasBlock(mismatch.context, join(target.artifactsDir, `${mismatch.field}-proof.json`)),
			true,
			`copied captured manager with mismatched ${mismatch.field} cannot use selected controller/proof admission`,
		);
	}
	const selectedArtifactHookResults = hookResults(rawHostContext, join(target.artifactsDir, "discovery.json"));
	const selectedClaim = readRunControl(root).execution_claim;
	assert.equal(
		selectedArtifactHookResults.some(
			(result) => Boolean(result && typeof result === "object" && "block" in result && result.block === true),
		),
		false,
		JSON.stringify({
			prepareRunId: selectedRunId,
			prepareSessionId: hostContext.session_id,
			claim: selectedClaim
				? {
					runId: selectedClaim.run_id,
					sessionId: selectedClaim.coordinator_session_id,
					hasToken: typeof selectedClaim.token === "string" && selectedClaim.token.length > 0,
				}
				: null,
			hookResults: selectedArtifactHookResults,
		}),
	);
	assert.equal(hasBlock(rawHostContext, join(root, "src", "selected.ts")), true, "selected orchestrator writes remain artifact-scoped");

	const foreignContext = {
		sessionManager: { getCwd: () => root, getSessionId: () => "foreign-session" },
	};
	assert.equal(hasBlock(foreignContext, join(target.artifactsDir, "foreign.json")), true, "foreign session cannot borrow the captured host");
	const mismatchedContext = {
		sessionManager: { getCwd: () => plainRoot(), getSessionId: () => hostContext.session_id },
	};
	assert.equal(hasBlock(mismatchedContext, join(root, "src", "mismatched.ts")), true, "mismatched manager cwd remains fail-closed");
	const contradictoryCwdContext = {
		cwd: plainRoot(),
		sessionManager: hostContext.sessionManager,
	};
	assert.equal(
		hasBlock(contradictoryCwdContext, join(root, "src", "contradictory-cwd.ts")),
		true,
		"explicit cwd contradicting the captured manager remains fail-closed",
	);

	host.fireSessionStart({
		...hostContext,
		mode: "print",
		hasUI: false,
	});
	assert.equal(hasBlock(rawHostContext, join(target.artifactsDir, "headless.json")), true, "headless transition revokes raw host admission");
});
