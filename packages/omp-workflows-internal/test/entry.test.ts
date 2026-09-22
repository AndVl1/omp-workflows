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

interface RecordedTool {
	name: string;
	execute?: (...args: unknown[]) => unknown;
}

function permissiveZod(): { z: unknown } {
	const schema = new Proxy({}, { get: () => () => schema });
	const z = new Proxy({}, { get: () => () => schema });
	return { z };
}

function makePi(options: { tools?: boolean } = {}) {
	const commands = new Map<string, RecordedCommand>();
	const hooks = new Map<string, Array<(event: unknown, ctx: unknown) => unknown>>();
	const labels: string[] = [];
	const tools: string[] = [];
	const toolHandlers = new Map<string, unknown>();
	const sent: string[] = [];
	const pi = {
		...(options.tools ? { zod: permissiveZod() } : {}),
		registerCommand(name: string, commandOptions: { description?: string; handler: RecordedCommand["handler"] }) {
			commands.set(name, { name, ...commandOptions });
		},
		on(event: string, handler: (event: unknown, ctx: unknown) => unknown) {
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
		fireSessionStart(ctx: unknown): void {
			for (const handler of hooks.get("session_start") ?? []) handler({}, ctx);
		},
		fireBeforeAgentStart(event: unknown, ctx: unknown): unknown {
			let result: unknown;
			for (const handler of hooks.get("before_agent_start") ?? []) {
				const output = handler(event, ctx);
				if (output !== undefined) result = output;
			}
			return result;
		},
		fireToolCall(event: unknown, ctx: unknown): unknown[] {
			return (hooks.get("tool_call") ?? []).map((handler) => handler(event, ctx));
		},
		fireSessionStop(event: unknown, ctx: unknown): void {
			for (const handler of hooks.get("session_stop") ?? []) handler(event, ctx);
		},
		fireSessionShutdown(event: unknown, ctx: unknown): void {
			for (const handler of hooks.get("session_shutdown") ?? []) handler(event, ctx);
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

function initGit(root: string): void {
	execFileSync("git", ["-C", root, "init", "--quiet", "--initial-branch", "main"], { stdio: "ignore" });
}

function plainRoot(): string {
	return mkdtempSync(join(tmpdir(), "omp-internal-entry-plain-"));
}

function interactiveContext(cwd: string, sessionId: string): {
	cwd: string;
	mode: "tui";
	hasUI: true;
	session_id: string;
	sessionManager: { getCwd: () => string; getSessionId: () => string };
	ui: { notify: () => void };
} {
	return {
		cwd,
		mode: "tui",
		hasUI: true,
		session_id: sessionId,
		sessionManager: {
			getCwd: () => cwd,
			getSessionId: () => sessionId,
		},
		ui: { notify() {} },
	};
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
	assert.equal(
		host.fireBeforeAgentStart(
			{ prompt: "untrusted workflow prompt", systemPrompt: ["base-system-prompt"] },
			{ cwd: root, sessionManager: { getCwd: () => root, getSessionId: () => "unactivated-session" } },
		),
		undefined,
		"unactivated sessions do not receive the workflow-managed turn contract",
	);
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
	assert.equal(
		host.fireBeforeAgentStart(
			{ prompt: "untrusted workflow prompt", systemPrompt: ["base-system-prompt"] },
			{ cwd: root, sessionManager: { getCwd: () => root, getSessionId: () => "conflicted-session" } },
		),
		undefined,
		"owner conflict leaves the workflow hook dormant without command authority",
	);
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

test("exact stop settles the host claim but retains command/controller binding until shutdown", async () => {
	resetWorkflowOwners();
	const root = markedRoot();
	const host = makePi();
	ompWorkflowsInternal(host.pi as never);
	const owner = interactiveContext(root, "entry-owner-session");
	const foreign = interactiveContext(root, "entry-foreign-session");
	host.fireSessionStart(owner);
	const command = host.commands.get("omp-do-work");
	assert.ok(command);

	await command.handler("before stop", owner);
	const beforeStopPrompt = host.sent.at(-1);
	assert.equal(
		host.fireBeforeAgentStart({ prompt: beforeStopPrompt, systemPrompt: ["base"] }, owner) !== undefined,
		true,
		"captured host command provenance is eligible before stop",
	);

	host.fireSessionStop({ session_id: foreign.session_id }, foreign);
	await command.handler("after foreign stop", owner);
	const afterForeignStopPrompt = host.sent.at(-1);
	assert.equal(
		host.fireBeforeAgentStart({ prompt: afterForeignStopPrompt, systemPrompt: ["base"] }, owner) !== undefined,
		true,
		"foreign stop cannot clear the host binding",
	);

	host.fireSessionStop({ session_id: owner.session_id }, owner);
	await command.handler("after stop", owner);
	const afterStopPrompt = host.sent.at(-1);
	assert.equal(
		host.fireBeforeAgentStart({ prompt: afterStopPrompt, systemPrompt: ["base"] }, owner) !== undefined,
		true,
		"same-session stop releases the claim but retains command/controller eligibility",
	);

	host.fireSessionShutdown({ session_id: foreign.session_id }, foreign);
	await command.handler("after foreign shutdown", owner);
	const afterForeignShutdownPrompt = host.sent.at(-1);
	assert.equal(
		host.fireBeforeAgentStart({ prompt: afterForeignShutdownPrompt, systemPrompt: ["base"] }, owner) !== undefined,
		true,
		"foreign shutdown cannot delete the host binding",
	);

	host.fireSessionShutdown({ session_id: owner.session_id }, owner);
	await assert.rejects(
		command.handler("after shutdown", owner),
		/trusted session identity is unavailable/,
		"exact shutdown tears down the host binding",
	);
});

test("same-identity headless start revokes internal authority and trusted start restores it", async () => {
	resetWorkflowOwners();
	const root = markedRoot();
	const host = makePi();
	ompWorkflowsInternal(host.pi as never);
	const owner = interactiveContext(root, "entry-headless-session");
	const headless = { ...owner, mode: "print" as const, hasUI: false as const };
	const foreignHeadless = {
		...headless,
		session_id: "entry-foreign-headless-session",
		sessionManager: {
			getCwd: () => root,
			getSessionId: () => "entry-foreign-headless-session",
		},
	};
	host.fireSessionStart(owner);
	const command = host.commands.get("omp-do-work");
	assert.ok(command);

	host.fireSessionStart(headless);
	await assert.rejects(
		command.handler("headless must fail closed", headless),
		/trusted session identity is unavailable/,

		"same-identity headless ingress revokes the retained interactive binding",
	);

	host.fireSessionStart(foreignHeadless);
	host.fireSessionStart(owner);
	await command.handler("trusted host restored", owner);
	const restoredPrompt = host.sent.at(-1);
	assert.equal(
		host.fireBeforeAgentStart({ prompt: restoredPrompt, systemPrompt: ["base"] }, owner) !== undefined,
		true,
		"the exact trusted interactive ingress restores command authority",
	);
});
test("raw authority requires an active claim, then returns after post-idle prepare", async () => {
	resetWorkflowOwners();
	const root = markedRoot();
	initGit(root);
	const host = makePi({ tools: true });
	ompWorkflowsInternal(host.pi as never);
	const owner = interactiveContext(root, "entry-raw-session");
	host.fireSessionStart(owner);

	host.fireSessionStart(owner);
	// Replay the authoritative manager-backed start so every handler registered
	// by activation observes the same trusted host lifecycle.
	const executePrepare = host.toolHandlers.get("workflow_prepare") as
		| ((id: string, params: unknown, signal: unknown, update: unknown, ctx: unknown) => Promise<unknown>)
		| undefined;
	assert.equal(typeof executePrepare, "function", "workflow_prepare must be registered for the raw authority scenario");
	const classification = {
		type: "FEATURE" as const,
		complexity: "QUICK" as const,
		confidence: "HIGH" as const,
		autonomous: false,
		workflow: "lightweight",
	};
	const first = await executePrepare!(
		"entry-raw-first-prepare",
		{ mode: "new", task: "raw authority first prepare", classification },
		undefined,
		undefined,
		owner,
	);
	const firstDetails = (first as { details?: { ok?: boolean; artifacts_dir?: string; state?: { run_id?: string } } }).details;
	assert.equal(firstDetails?.ok, true, JSON.stringify(first));
	assert.equal(typeof firstDetails?.state?.run_id, "string", JSON.stringify(first));
	const runId = firstDetails?.state?.run_id as string;
	assert.equal(typeof firstDetails?.artifacts_dir, "string", JSON.stringify(first));
	mkdirSync(firstDetails?.artifacts_dir as string, { recursive: true });
	const artifactPath = join(runTarget(root, runId).artifactsDir, "raw-authority.json");
	const artifactHookResults = (ctx: unknown): unknown[] => host.fireToolCall(
		{ toolName: "write", input: { path: artifactPath, content: "{}" } },
		ctx,
	);
	const hookIsBlocked = (results: unknown[]): boolean => results.some(
		(result) => Boolean(result && typeof result === "object" && "block" in result && result.block === true),
	);
	const authorityDiagnostic = (hookResults: unknown[]) => {
		const claim = readRunControl(root).execution_claim;
		return {
			prepareRunId: runId,
			prepareSessionId: owner.session_id,
			claim: claim
				? {
					runId: claim.run_id,
					sessionId: claim.coordinator_session_id,
					hasToken: typeof claim.token === "string" && claim.token.length > 0,
				}
				: null,
			hookResults,
		};
	};
	const artifactBlocked = (ctx: unknown): boolean => hookIsBlocked(artifactHookResults(ctx));

	const firstHookResults = artifactHookResults(owner);
	assert.equal(hookIsBlocked(firstHookResults), false, JSON.stringify(authorityDiagnostic(firstHookResults)));
	host.fireSessionStop({ session_id: owner.session_id }, owner);
	assert.equal(readRunControl(root).execution_claim, null, "trusted idle stop releases the execution claim");
	assert.equal(artifactBlocked(owner), true, "selected-but-unclaimed idle binding does not become an orchestrator");

	const resumed = await executePrepare!(
		"entry-raw-resume-prepare",
		{ mode: "resume", run_id: runId },
		undefined,
		undefined,
		owner,
	);
	const resumedDetails = (resumed as { details?: { ok?: boolean } }).details;
	assert.equal(resumedDetails?.ok, true, JSON.stringify(resumed));
	assert.equal(readRunControl(root).execution_claim?.run_id, runId, "post-prepare rebind restores the canonical claim");
	assert.equal(artifactBlocked(owner), false, "post-prepare claim restores raw orchestrator authority");
});


test("verified replacement isolates the old host and headless/shutdown cannot resurrect authority", async () => {
	resetWorkflowOwners();
	const root = markedRoot();
	initGit(root);
	const host = makePi({ tools: true });
	ompWorkflowsInternal(host.pi as never);
	const owner = interactiveContext(root, "entry-replacement-old");
	const replacement = interactiveContext(root, "entry-replacement-new");
	const headless = { ...replacement, mode: "print" as const, hasUI: false as const };
	host.fireSessionStart(owner);
	// Replay the authoritative manager-backed start so every handler registered
	// by activation observes the same trusted host lifecycle.
	host.fireSessionStart(owner);

	const executePrepare = host.toolHandlers.get("workflow_prepare") as
		| ((id: string, params: unknown, signal: unknown, update: unknown, ctx: unknown) => Promise<unknown>)
		| undefined;
	assert.equal(typeof executePrepare, "function");
	const classification = {
		type: "FEATURE" as const,
		complexity: "QUICK" as const,
		confidence: "HIGH" as const,
		autonomous: false,
		workflow: "lightweight",
	};
	type PrepareResult = { ok?: boolean; run_id?: string; artifacts_dir?: string; code?: string; error?: string };
	const prepare = async (id: string, params: unknown, ctx: unknown): Promise<PrepareResult> => {
		const result = await executePrepare!(id, params, undefined, undefined, ctx);
		const details = (result as {
			details?: { ok?: boolean; code?: string; error?: string; artifacts_dir?: string; state?: { run_id?: string } };
		}).details;
		return {
			ok: details?.ok,
			run_id: details?.state?.run_id,
			artifacts_dir: details?.artifacts_dir,
			code: details?.code,
			error: details?.error,
		};
	};
	const first = await prepare(
		"entry-replacement-old-prepare",
		{ mode: "new", task: "old host run", classification },
		owner,
	);
	assert.equal(first.ok, true);
	assert.equal(typeof first.run_id, "string");
	assert.equal(typeof first.artifacts_dir, "string");
	mkdirSync(first.artifacts_dir as string, { recursive: true });
	const oldRunId = first.run_id as string;
	const artifactHookResults = (runId: string, ctx: unknown): unknown[] => host.fireToolCall(
		{ toolName: "write", input: { path: join(runTarget(root, runId).artifactsDir, `${runId}.json`), content: "{}" } },
		ctx,
	);
	const hookIsBlocked = (results: unknown[]): boolean => results.some(
		(result) => Boolean(result && typeof result === "object" && "block" in result && result.block === true),
	);
	const authorityDiagnostic = (prepareRunId: string, prepareSessionId: string, hookResults: unknown[]) => {
		const claim = readRunControl(root).execution_claim;
		return {
			prepareRunId,
			prepareSessionId,
			claim: claim
				? {
					runId: claim.run_id,
					sessionId: claim.coordinator_session_id,
					hasToken: typeof claim.token === "string" && claim.token.length > 0,
				}
				: null,
			hookResults,
		};
	};
	const artifactBlocked = (runId: string, ctx: unknown): boolean => hookIsBlocked(artifactHookResults(runId, ctx));
	assert.equal(artifactBlocked(oldRunId, owner), false);

	host.fireSessionStart(replacement);
	assert.equal(artifactBlocked(oldRunId, owner), true, "old trusted owner loses authority after verified replacement");
	const second = await prepare(
		"entry-replacement-new-prepare",
		{ mode: "new", task: "replacement host run", classification },
		replacement,
	);
	assert.equal(second.ok, true);
	assert.equal(typeof second.run_id, "string");
	const replacementRunId = second.run_id as string;
	assert.equal(typeof second.artifacts_dir, "string");
	mkdirSync(second.artifacts_dir as string, { recursive: true });
	const replacementHookResults = artifactHookResults(replacementRunId, replacement);
	assert.equal(
		hookIsBlocked(replacementHookResults),
		false,
		JSON.stringify(authorityDiagnostic(replacementRunId, replacement.session_id, replacementHookResults)),
	);
	host.fireSessionStart(headless);
	assert.equal(artifactBlocked(replacementRunId, replacement), true, "headless ingress revokes raw authority");
	const headlessPrepare = await prepare(
		"entry-headless-prepare",
		{ mode: "resume", run_id: replacementRunId },
		headless,
	);
	assert.equal(headlessPrepare.ok, false, JSON.stringify(headlessPrepare));
	assert.equal(headlessPrepare.code, "WORKFLOW_CONTEXT_REJECTED", JSON.stringify(headlessPrepare));
	assert.match(headlessPrepare.error ?? "", /lifecycle identity was revoked|interactive main session|shared workflow session controller unavailable/i);

	host.fireSessionStart(replacement);
	assert.equal(artifactBlocked(replacementRunId, replacement), true, "interactive rebind without a claim stays idle and fail-closed");
	host.fireSessionShutdown({ session_id: replacement.session_id }, replacement);
	assert.equal(artifactBlocked(replacementRunId, replacement), true, "shutdown cannot resurrect raw authority");
	const shutdownPrepare = await prepare(
		"entry-shutdown-prepare",
		{ mode: "resume", run_id: replacementRunId },
		replacement,
	);
	assert.equal(shutdownPrepare.ok, false, JSON.stringify(shutdownPrepare));
	assert.equal(shutdownPrepare.code, "WORKFLOW_CONTEXT_REJECTED", JSON.stringify(shutdownPrepare));
	assert.match(shutdownPrepare.error ?? "", /lifecycle identity was revoked|interactive main session|shared workflow session controller unavailable/i);
});

test("managerless explicit host ingress cannot lazily bind command or raw authority", async () => {
	resetWorkflowOwners();
	const root = markedRoot();
	initGit(root);
	const host = makePi({ tools: true });
	ompWorkflowsInternal(host.pi as never);
	const managerless = {
		cwd: root,
		mode: "tui" as const,
		hasUI: true as const,
		session_id: "entry-managerless-session",
	};
	host.fireSessionStart(managerless);
	const executePrepare = host.toolHandlers.get("workflow_prepare") as
		| ((id: string, params: unknown, signal: unknown, update: unknown, ctx: unknown) => Promise<unknown>)
		| undefined;
	assert.equal(typeof executePrepare, "function");
	const denied = await executePrepare!(
		"entry-managerless-prepare",
		{
			mode: "new",
			task: "managerless must fail closed",
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
		managerless,
	);
	const deniedDetails = (denied as { details?: { code?: string } }).details;
	assert.equal(deniedDetails?.code, "WORKFLOW_CONTEXT_REJECTED", JSON.stringify(denied));
	const rawResults = host.fireToolCall(
		{ toolName: "write", input: { path: join(root, "src", "managerless.ts"), content: "{}" } },
		managerless,
	);
	assert.equal(
		rawResults.some((result) => Boolean(result && typeof result === "object" && "block" in result && result.block === true)),
		true,
		"managerless explicit ingress cannot obtain raw authority",
	);
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
