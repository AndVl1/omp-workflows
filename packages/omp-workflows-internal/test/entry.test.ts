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
		fireSessionSwitch(event: unknown, ctx: unknown): void {
			for (const handler of hooks.get("session_switch") ?? []) handler(event, ctx);
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

function hostSessionFile(cwd: string, sessionId: string): string {
	return join(cwd, "sessions", "2026-09-24T00-00-00-000Z_" + sessionId + ".jsonl");
}

function interactiveContext(cwd: string, sessionId: string): {
	cwd: string;
	mode: "tui";
	hasUI: true;
	session_id: string;
	sessionManager: { getCwd: () => string; getSessionId: () => string; getSessionFile: () => string };
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
			getSessionFile: () => hostSessionFile(cwd, sessionId),
		},
		ui: { notify() {} },
	};
}

function mutableInteractiveContext(cwd: string, initialSessionId: string, initialSessionFile: string | undefined): {
	context: {
		cwd: string;
		mode: "tui";
		hasUI: true;
		session_id: string;
		sessionManager: {
			getCwd: () => string;
			getSessionId: () => string;
			getSessionFile: () => string | undefined;
		};
		ui: { notify: () => void };
	};
	setSession: (sessionId: string, sessionFile: string | undefined) => void;
} {
	let sessionId = initialSessionId;
	let sessionFile = initialSessionFile;
	const sessionManager = {
		getCwd: () => cwd,
		getSessionId: () => sessionId,
		getSessionFile: () => sessionFile,
	};
	return {
		context: {
			cwd,
			mode: "tui",
			hasUI: true,
			get session_id() {
				return sessionId;
			},
			sessionManager,
			ui: { notify() {} },
		},
		setSession(nextSessionId, nextSessionFile) {
			sessionId = nextSessionId;
			sessionFile = nextSessionFile;
		},
	};
}
function workflowErrorCode(error: unknown): string | undefined {
	if (!error || typeof error !== "object") return undefined;
	if ("code" in error && typeof error.code === "string") return error.code;
	if (!("message" in error) || typeof error.message !== "string") return undefined;
	const separator = error.message.indexOf(":");
	return separator > 0 ? error.message.slice(0, separator) : undefined;
}
function hookBlockReasons(results: readonly unknown[]): string {
	return JSON.stringify(
		results.flatMap((result) => {
			if (!result || typeof result !== "object" || !("block" in result) || result.block !== true) return [];
			const reason = "reason" in result && typeof result.reason === "string" ? result.reason : undefined;
			return [reason ?? "<unspecified>"];
		}),
	);
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
	for (const capability of ALL_CAPABILITIES) {
		assert.equal(workflowOwnerFor(root, capability), undefined, `${capability} must remain unclaimed outside a marked workspace`);
	}
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
	assert.equal(workflowOwnerFor(root, "workflow_tools"), undefined, "foreign registration claim must not leak into workflow tools");
	assert.equal(workflowOwnerFor(root, "config_writer"), undefined, "foreign registration claim must not leak into config writer");
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
	for (const capability of ALL_CAPABILITIES) {
		assert.equal(workflowOwnerFor(root, capability), undefined, `${capability} validation must not claim an owner`);
	}
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
	for (const capability of ALL_CAPABILITIES) {
		assert.equal(workflowOwnerFor(root, capability), undefined, `${capability} must remain unclaimed when markers are missing`);
	}
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

	host.fireSessionStop(
		{
			type: "session_stop",
			messages: [],
			turn_id: 0,
			session_id: foreign.session_id,
			session_file: foreign.sessionManager.getSessionFile(),
			stop_hook_active: false,
			signal: new AbortController().signal,
		},
		foreign,
	);
	await command.handler("after foreign stop", owner);
	const afterForeignStopPrompt = host.sent.at(-1);
	assert.equal(
		host.fireBeforeAgentStart({ prompt: afterForeignStopPrompt, systemPrompt: ["base"] }, owner) !== undefined,
		true,
		"foreign stop cannot clear the host binding",
	);
	host.fireSessionStop(
		{
			type: "session_stop",
			messages: [],
			turn_id: 0,
			session_id: owner.session_id,
			session_file: foreign.sessionManager.getSessionFile(),
			stop_hook_active: false,
			signal: new AbortController().signal,
		},
		owner,
	);
	await command.handler("after conflicting stop file", owner);
	const afterConflictingStopPrompt = host.sent.at(-1);
	assert.equal(
		host.fireBeforeAgentStart({ prompt: afterConflictingStopPrompt, systemPrompt: ["base"] }, owner) !== undefined,
		true,
		"contradictory pinned stop file cannot clear the owner binding",
	);


	host.fireSessionStop(
		{
			type: "session_stop",
			messages: [],
			turn_id: 0,
			session_id: owner.session_id,
			session_file: owner.sessionManager.getSessionFile(),
			stop_hook_active: false,
			signal: new AbortController().signal,
		},
		owner,
	);
	await command.handler("after stop", owner);
	const afterStopPrompt = host.sent.at(-1);
	assert.equal(
		host.fireBeforeAgentStart({ prompt: afterStopPrompt, systemPrompt: ["base"] }, owner) !== undefined,
		true,
		"same-session stop releases the claim but retains command/controller eligibility",
	);

	host.fireSessionShutdown({ type: "session_shutdown" }, foreign);
	await command.handler("after foreign shutdown", owner);
	const afterForeignShutdownPrompt = host.sent.at(-1);
	assert.equal(
		host.fireBeforeAgentStart({ prompt: afterForeignShutdownPrompt, systemPrompt: ["base"] }, owner) !== undefined,
		true,
		"foreign shutdown cannot delete the host binding",
	);

	host.fireSessionShutdown({ type: "session_shutdown" }, owner);
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
	host.fireSessionStop(
		{
			type: "session_stop",
			messages: [],
			turn_id: 0,
			session_id: owner.session_id,
			session_file: owner.sessionManager.getSessionFile(),
			stop_hook_active: false,
			signal: new AbortController().signal,
		},
		owner,
	);
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


test("RPC raw callbacks retain CTO authority with the host UI profile", async () => {
	resetWorkflowOwners();
	const root = markedRoot();
	initGit(root);
	const host = makePi({ tools: true });
	ompWorkflowsInternal(host.pi as never);
	const owner = {
		...interactiveContext(root, "entry-rpc-cto-session"),
		mode: "rpc" as const,
		hasUI: true as const,
	};
	host.fireSessionStart(owner);
	host.fireSessionStart(owner);

	const ctoCommand = host.commands.get("omp-cto");
	assert.ok(ctoCommand);
	await ctoCommand.handler("RPC CTO claim", owner);
	const runId = readRunControl(root).execution_claim?.run_id;
	assert.equal(typeof runId, "string", JSON.stringify(readRunControl(root).execution_claim));
	if (!runId) return;

	const rawRpcContext = {
		cwd: root,
		mode: "rpc" as const,
		hasUI: true as const,
		sessionManager: owner.sessionManager,
		ui: owner.ui,
	};
	const hookResults = host.fireToolCall(
		{ toolName: "write", input: { path: join(root, ".work-state", "cto", runId, "rpc.json"), content: "{}" } },
		rawRpcContext,
	);
	assert.equal(
		hookResults.some((result) => Boolean(result && typeof result === "object" && "block" in result && result.block === true)),
		false,
		`the captured RPC host remains trusted when raw tool calls carry the RPC UI context; hook_block_reasons=${hookBlockReasons(hookResults)}`,
	);
	host.fireSessionShutdown({ type: "session_shutdown" }, owner);
});

test("resident CTO admission survives turn stop, rejects foreign/stale hosts, and suspends on replacement/shutdown", async () => {
	resetWorkflowOwners();
	const root = markedRoot();
	initGit(root);
	const host = makePi({ tools: true });
	ompWorkflowsInternal(host.pi as never);
	const ownerSession = mutableInteractiveContext(root, "entry-cto-owner", hostSessionFile(root, "entry-cto-owner"));
	const owner = ownerSession.context;
	const replacement = interactiveContext(root, "entry-cto-replacement");
	host.fireSessionStart(owner);
	// Replay the authoritative manager-backed start so every handler registered
	// by activation observes the same trusted host lifecycle.
	host.fireSessionStart(owner);

	const ctoCommand = host.commands.get("omp-cto");
	assert.ok(ctoCommand);
	await ctoCommand.handler("Internal CTO claim", owner);
	const claimed = readRunControl(root).execution_claim;
	assert.equal(claimed?.owner_kind, "cto", JSON.stringify(claimed));
	const runId = claimed?.run_id;
	assert.equal(typeof runId, "string", JSON.stringify(claimed));
	if (!runId) return;
	const headless = { ...owner, mode: "print" as const, hasUI: false as const };
	const claimBeforeHeadlessCommand = readRunControl(root).execution_claim;
	await assert.rejects(
		() => ctoCommand.handler("headless CTO command must be rejected", headless),
		(error: unknown) => {
			assert.equal(workflowErrorCode(error), "WORKFLOW_CONTEXT_REJECTED");
			return true;
		},
	);
	assert.deepEqual(
		readRunControl(root).execution_claim,
		claimBeforeHeadlessCommand,
		"headless command refusal must not mutate the resident CTO claim",
	);
	const missingCommandProfile = {
		cwd: owner.cwd,
		mode: owner.mode,
		session_id: owner.session_id,
		sessionManager: owner.sessionManager,
		ui: owner.ui,
	};
	const claimBeforeMissingCommandUi = readRunControl(root).execution_claim;
	await assert.rejects(
		() => ctoCommand.handler("missing command UI must be rejected", missingCommandProfile),
		(error: unknown) => {
			assert.equal(workflowErrorCode(error), "WORKFLOW_CONTEXT_REJECTED");
			return true;
		},
	);
	assert.deepEqual(
		readRunControl(root).execution_claim,
		claimBeforeMissingCommandUi,
		"missing command UI refusal must not mutate the resident CTO claim",
	);
	const privilegedPath = join(root, ".work-state", "cto", runId, "notes.json");
	const hookIsBlocked = (ctx: unknown): boolean => host.fireToolCall(
		{ toolName: "write", input: { path: privilegedPath, content: "{}" } },
		ctx,
	).some((result) => Boolean(result && typeof result === "object" && "block" in result && result.block === true));

	const foreignHeadless = {
		...interactiveContext(root, "entry-cto-foreign-headless"),
		mode: "print" as const,
		hasUI: false as const,
	};
	const claimBeforeHeadlessShutdown = readRunControl(root).execution_claim;
	host.fireSessionShutdown({ type: "session_shutdown" }, foreignHeadless);
	assert.deepEqual(
		readRunControl(root).execution_claim,
		claimBeforeHeadlessShutdown,
		"foreign headless shutdown must not suspend the resident CTO claim",
	);
	const ownerAfterForeignHeadless = host.fireToolCall(
		{ toolName: "write", input: { path: privilegedPath, content: "{}" } },
		owner,
	);
	assert.equal(
		ownerAfterForeignHeadless.some((result) => Boolean(result && typeof result === "object" && "block" in result && result.block === true)),
		false,
		`foreign headless shutdown must retain the shared controller; hook_block_reasons=${hookBlockReasons(ownerAfterForeignHeadless)}`,
	);
	host.fireSessionShutdown({ type: "session_shutdown" }, headless);
	assert.deepEqual(
		readRunControl(root).execution_claim,
		claimBeforeHeadlessShutdown,
		"same-identity headless shutdown must not suspend the resident CTO claim",
	);
	assert.equal(hookIsBlocked(owner), false, "same-identity headless shutdown must retain the shared controller");

	assert.equal(hookIsBlocked(owner), false, "the exact claimed interactive host is admitted as CTO");
	const executePrepare = host.toolHandlers.get("workflow_prepare") as
		| ((id: string, params: unknown, signal: unknown, update: unknown, ctx: unknown) => Promise<unknown>)
		| undefined;
	assert.equal(typeof executePrepare, "function", "workflow_prepare must be registered for CTO admission");
	assert.equal(hookIsBlocked(headless), true, "same-manager headless raw callbacks cannot use the claimed CTO scope");
	const claimBeforeHeadlessPrepare = readRunControl(root).execution_claim;
	const headlessDenied = await executePrepare!(
		"entry-cto-headless-prepare",
		{ mode: "new", task: "headless context must be rejected", classification: {
			type: "FEATURE" as const,
			complexity: "QUICK" as const,
			confidence: "HIGH" as const,
			autonomous: false,
			workflow: "lightweight",
		} },
		undefined,
		undefined,
		headless,
	);
	assert.equal(
		(headlessDenied as { details?: { code?: string } }).details?.code,
		"WORKFLOW_CONTEXT_REJECTED",
		JSON.stringify(headlessDenied),
	);
	assert.deepEqual(
		readRunControl(root).execution_claim,
		claimBeforeHeadlessPrepare,
		"headless prepare refusal must not mutate the resident CTO claim",
	);
	const classification = {
		type: "FEATURE" as const,
		complexity: "QUICK" as const,
		confidence: "HIGH" as const,
		autonomous: false,
		workflow: "lightweight",
	};
	for (const actor of ["worker", "lead", "unknown"] as const) {
		const workerContext = { ...owner, actor };
		assert.equal(
			hookIsBlocked(workerContext),
			true,
			`${actor}-labelled exact-manager context cannot use the claimed CTO raw authority`,
		);
		const denied = await executePrepare!(
			`entry-cto-${actor}-prepare`,
			{ mode: "new", task: `${actor} context must be rejected`, classification },
			undefined,
			undefined,
			workerContext,
		);
		const details = (() => {
			if (!denied || typeof denied !== "object" || !("details" in denied)) return undefined;
			const value = denied.details;
			if (!value || typeof value !== "object" || !("code" in value) || typeof value.code !== "string") return undefined;
			return { code: value.code };
		})();
		assert.equal(
			details?.code,
			"WORKFLOW_CONTEXT_REJECTED",
			`${actor}-labelled exact-manager context cannot borrow the raw session controller: ${JSON.stringify(denied)}`,
		);
	}
	const invalidRawContexts: ReadonlyArray<[string, unknown]> = [
		["explicit cwd mismatch", { ...owner, cwd: plainRoot() }],
		["explicit session mismatch", { ...owner, session_id: "entry-cto-foreign-explicit" }],
		["malformed session id", { ...owner, session_id: 42 }],
		["contradictory session ids", { ...owner, sessionId: "entry-cto-contradictory" }],
		["malformed session manager", { ...owner, sessionManager: { getCwd: () => root } }],
		[
			"throwing session manager getter",
			{
				...owner,
				sessionManager: {
					getCwd: () => {
						throw new Error("session cwd unavailable");
					},
					getSessionId: () => owner.session_id,
				},
			},
		],
	];
	for (const [label, invalidContext] of invalidRawContexts) {
		const claimBeforeInvalidContext = readRunControl(root).execution_claim;
		assert.equal(
			hookIsBlocked(invalidContext),
			true,
			`${label} cannot use the claimed CTO raw authority`,
		);
		const denied = await executePrepare!(
			`entry-cto-${label.replaceAll(" ", "-")}-prepare`,
			{ mode: "new", task: `${label} must be rejected`, classification },
			undefined,
			undefined,
			invalidContext,
		);
		const details = (denied as { details?: { code?: string } }).details;
		assert.equal(details?.code, "WORKFLOW_CONTEXT_REJECTED", JSON.stringify(denied));
		assert.deepEqual(
			readRunControl(root).execution_claim,
			claimBeforeInvalidContext,
			`${label} refusal must not mutate the resident CTO claim`,
		);
	}
	const foreign = interactiveContext(root, "entry-cto-foreign");
	assert.equal(hookIsBlocked(foreign), true, "a foreign manager-backed host cannot borrow the CTO claim");

	host.fireSessionStop(
		{
			type: "session_stop",
			messages: [],
			turn_id: 0,
			session_id: owner.session_id,
			session_file: owner.sessionManager.getSessionFile(),
			stop_hook_active: false,
			signal: new AbortController().signal,
		},
		owner,
	);
	assert.equal(readRunControl(root).execution_claim?.run_id, runId, "turn stop preserves the resident CTO claim");
	assert.equal(hookIsBlocked(owner), false, "turn stop retains CTO admission on the resident controller");

	host.fireSessionStart(replacement);
	assert.equal(
		hookIsBlocked(owner),
		false,
		"an independent manager cannot suspend resident CTO authority",
	);
	assert.equal(
		readRunControl(root).execution_claim?.run_id,
		runId,
		"an independent manager start preserves the resident CTO claim",
	);

	const staleOwner = interactiveContext(root, "entry-cto-owner");
	const oldSessionFile = hostSessionFile(root, "entry-cto-owner");
	const newSessionId = "entry-cto-replacement";
	const newSessionFile = hostSessionFile(root, newSessionId);
	ownerSession.setSession(newSessionId, newSessionFile);
	host.fireSessionSwitch(
		{ type: "session_switch", reason: "new", previousSessionFile: oldSessionFile },
		owner,
	);
	assert.equal(hookIsBlocked(staleOwner), true, "the stale replaced host cannot retain CTO authority");
	assert.equal(readRunControl(root).execution_claim, null, "verified same-manager replacement suspends the CTO claim");
	assert.equal(
		hookIsBlocked(owner),
		false,
		"the verified successor remains an interactive host for generic no-run writes",
	);

	await ctoCommand.handler("Internal CTO shutdown", owner);
	const restarted = readRunControl(root).execution_claim;
	assert.equal(restarted?.owner_kind, "cto", JSON.stringify(restarted));
	assert.equal(typeof restarted?.run_id, "string", JSON.stringify(restarted));
	assert.ok((restarted?.run_id?.length ?? 0) > 0, JSON.stringify(restarted));
	assert.notEqual(restarted?.run_id, runId, "replacement CTO command starts a fresh run");
	host.fireSessionShutdown({ type: "session_shutdown" }, owner);
	assert.equal(readRunControl(root).execution_claim, null, "verified shutdown suspends the resident CTO claim before reset");
	assert.equal(hookIsBlocked(owner), true, "shutdown removes CTO admission from the reset controller");
});

test("verified replacement isolates the old host while headless ingress preserves the claim", async () => {
	resetWorkflowOwners();
	const root = markedRoot();
	initGit(root);
	const host = makePi({ tools: true });
	ompWorkflowsInternal(host.pi as never);
	const ownerSession = mutableInteractiveContext(root, "entry-replacement-old", hostSessionFile(root, "entry-replacement-old"));
	const owner = ownerSession.context;
	const oldSessionFile = hostSessionFile(root, "entry-replacement-old");
	const replacement = interactiveContext(root, "entry-replacement-new");
	const headless = {
		cwd: root,
		mode: "print" as const,
		hasUI: false as const,
		sessionManager: owner.sessionManager,
		ui: owner.ui,
	};
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
	assert.equal(
		artifactBlocked(oldRunId, owner),
		false,
		"an independent manager cannot suspend the old trusted owner",
	);
	assert.equal(
		readRunControl(root).execution_claim?.run_id,
		oldRunId,
		"an independent manager start preserves the old execution claim",
	);

	const staleOwner = interactiveContext(root, "entry-replacement-old");
	const newSessionId = "entry-replacement-new";
	const newSessionFile = hostSessionFile(root, newSessionId);
	ownerSession.setSession(newSessionId, newSessionFile);
	host.fireSessionSwitch(
		{ type: "session_switch", reason: "new", previousSessionFile: oldSessionFile },
		owner,
	);
	assert.equal(
		artifactBlocked(oldRunId, staleOwner),
		true,
		"a distinct stale manager cannot use the old run's authority after verified replacement",
	);
	assert.equal(
		readRunControl(root).execution_claim,
		null,
		"verified same-manager replacement releases the old ordinary claim",
	);
	assert.equal(
		artifactBlocked(oldRunId, owner),
		false,
		"the verified successor remains an interactive host for generic no-run writes",
	);
	const second = await prepare(
		"entry-replacement-new-prepare",
		{ mode: "new", task: "replacement host run", classification },
		owner,
	);
	assert.equal(second.ok, true);
	assert.equal(typeof second.run_id, "string");
	const replacementRunId = second.run_id as string;
	assert.notEqual(replacementRunId, oldRunId, "replacement prepare starts a fresh run");
	assert.equal(typeof second.artifacts_dir, "string");
	mkdirSync(second.artifacts_dir as string, { recursive: true });
	const replacementHookResults = artifactHookResults(replacementRunId, owner);
	assert.equal(
		hookIsBlocked(replacementHookResults),
		false,
		JSON.stringify(authorityDiagnostic(replacementRunId, owner.session_id, replacementHookResults)),
	);
	host.fireSessionStart(headless);
	assert.equal(artifactBlocked(replacementRunId, owner), true, "headless ingress revokes raw authority");
	const headlessPrepare = await prepare(
		"entry-headless-prepare",
		{ mode: "resume", run_id: replacementRunId },
		headless,
	);
	assert.equal(headlessPrepare.ok, false, JSON.stringify(headlessPrepare));
	assert.equal(headlessPrepare.code, "WORKFLOW_CONTEXT_REJECTED", JSON.stringify(headlessPrepare));

	host.fireSessionStart(owner);
	assert.equal(artifactBlocked(replacementRunId, owner), false, "trusted re-entry restores raw authority over the retained claim");
	host.fireSessionShutdown({ type: "session_shutdown" }, owner);
	assert.equal(artifactBlocked(replacementRunId, owner), true, "shutdown cannot resurrect raw authority");
	const shutdownPrepare = await prepare(
		"entry-shutdown-prepare",
		{ mode: "resume", run_id: replacementRunId },
		owner,
	);
	assert.equal(shutdownPrepare.ok, false, JSON.stringify(shutdownPrepare));
	assert.equal(shutdownPrepare.code, "WORKFLOW_CONTEXT_REJECTED", JSON.stringify(shutdownPrepare));
});

test("actual session_switch proves same-manager replacement and rejects foreign lifecycle owners", async () => {
	resetWorkflowOwners();
	const root = markedRoot();
	initGit(root);
	const host = makePi({ tools: true });
	ompWorkflowsInternal(host.pi as never);
	const oldSessionId = "entry-switch-old";
	const oldSessionFile = join(root, "sessions", `2026-09-24T00-00-00-000Z_${oldSessionId}.jsonl`);
	const owner = mutableInteractiveContext(root, oldSessionId, oldSessionFile);
	host.fireSessionStart(owner.context);
	host.fireSessionStart(owner.context);

	const ctoCommand = host.commands.get("omp-cto");
	assert.ok(ctoCommand);
	await ctoCommand.handler("same manager switch claim", owner.context);
	const oldClaim = readRunControl(root).execution_claim;
	assert.equal(oldClaim?.owner_kind, "cto", JSON.stringify(oldClaim));
	assert.equal(oldClaim?.coordinator_session_id, oldSessionId, JSON.stringify(oldClaim));
	assert.equal(typeof oldClaim?.run_id, "string", JSON.stringify(oldClaim));
	assert.ok((oldClaim?.run_id?.length ?? 0) > 0, JSON.stringify(oldClaim));

	const privilegedPath = join(root, ".work-state", "cto", oldClaim?.run_id ?? "missing", "switch.json");
	const staleOwner = interactiveContext(root, oldSessionId);
	const hookIsBlocked = (ctx: unknown, path: string): boolean => host.fireToolCall(
		{ toolName: "write", input: { path, content: "{}" } },
		ctx,
	).some((result) => Boolean(result && typeof result === "object" && "block" in result && result.block === true));

	const foreign = mutableInteractiveContext(root, oldSessionId, oldSessionFile);
	foreign.setSession(
		"entry-switch-foreign-new",
		join(root, "sessions", "2026-09-24T00-00-00-000Z_entry-switch-foreign-new.jsonl"),
	);
	host.fireSessionSwitch(
		{ type: "session_switch", reason: "resume", previousSessionFile: oldSessionFile },
		foreign.context,
	);
	assert.deepEqual(readRunControl(root).execution_claim, oldClaim, "same-cwd foreign manager cannot suspend the resident claim");
	foreign.setSession(oldSessionId, oldSessionFile);
	host.fireSessionShutdown({ type: "session_shutdown" }, foreign.context);
	assert.deepEqual(readRunControl(root).execution_claim, oldClaim, "same-ID foreign shutdown cannot suspend the resident claim");
	const ownerAfterForeignCallbacks = host.fireToolCall(
		{ toolName: "write", input: { path: privilegedPath, content: "{}" } },
		owner.context,
	);
	assert.equal(
		ownerAfterForeignCallbacks.some((result) => Boolean(result && typeof result === "object" && "block" in result && result.block === true)),
		false,
		`the original owner remains admitted after foreign callbacks; hook_block_reasons=${hookBlockReasons(ownerAfterForeignCallbacks)}`,
	);

	const invalidSessionId = "entry-switch-invalid";
	const invalidSessionFile = join(root, "sessions", `2026-09-24T00-00-00-000Z_${invalidSessionId}.jsonl`);
	owner.setSession(invalidSessionId, invalidSessionFile);
	host.fireSessionSwitch(
		{ type: "session_switch", reason: "resume", previousSessionFile: join(root, "sessions", "wrong-old-session.jsonl") },
		owner.context,
	);
	assert.deepEqual(readRunControl(root).execution_claim, oldClaim, "mismatched previousSessionFile cannot replace the old binding");
	owner.setSession(oldSessionId, oldSessionFile);
	host.fireSessionSwitch({ type: "session_switch", reason: "resume" }, owner.context);
	assert.deepEqual(readRunControl(root).execution_claim, oldClaim, "missing previousSessionFile cannot replace the old binding");


	const newSessionId = "entry-switch-new";
	const newSessionFile = join(root, "sessions", `2026-09-24T00-00-00-000Z_${newSessionId}.jsonl`);
	owner.setSession(newSessionId, newSessionFile);
	host.fireSessionSwitch(
		{ type: "session_switch", reason: "resume", actor: "worker", previousSessionFile: oldSessionFile },
		owner.context,
	);
	assert.deepEqual(readRunControl(root).execution_claim, oldClaim, "worker-labelled switch event cannot replace the old binding");
	owner.setSession(oldSessionId, oldSessionFile);
	owner.setSession(newSessionId, newSessionFile);
	host.fireSessionSwitch(
		{ type: "session_switch", reason: "new", previousSessionFile: oldSessionFile },
		owner.context,
	);
	assert.equal(readRunControl(root).execution_claim, null, "verified same-manager switch suspends the old CTO claim");
	assert.equal(hookIsBlocked(staleOwner, privilegedPath), true, "the stale replaced host cannot retain the old CTO scope");
	assert.equal(
		hookIsBlocked(owner.context, privilegedPath),
		false,
		"the verified successor remains an interactive host for generic no-run writes",
	);

	await ctoCommand.handler("new owner after actual switch", owner.context);
	const newClaim = readRunControl(root).execution_claim;
	assert.equal(newClaim?.owner_kind, "cto", JSON.stringify(newClaim));
	assert.equal(newClaim?.coordinator_session_id, newSessionId, JSON.stringify(newClaim));
	assert.equal(typeof newClaim?.run_id, "string", JSON.stringify(newClaim));
	assert.ok((newClaim?.run_id?.length ?? 0) > 0, JSON.stringify(newClaim));
	assert.notEqual(newClaim?.run_id, oldClaim?.run_id, "new same-manager CTO command starts a fresh run");
	const newPrivilegedPath = join(root, ".work-state", "cto", newClaim?.run_id ?? "missing", "switch-new.json");
	assert.equal(hookIsBlocked(owner.context, newPrivilegedPath), false, "the new same-manager owner can use raw CTO authority");

	host.fireSessionShutdown({ type: "session_shutdown" }, owner.context);
	assert.equal(readRunControl(root).execution_claim, null, "the new owner can still shut down its own claim");
});

test("captured old session proof gates no-claim successor admission", async () => {
	resetWorkflowOwners();
	const root = markedRoot();
	initGit(root);
	const host = makePi({ tools: true });
	ompWorkflowsInternal(host.pi as never);
	const oldSessionId = "entry-switch-unclaimed-old";
	const oldSessionFile = join(root, "sessions", `2026-09-24T00-00-00-000Z_${oldSessionId}.jsonl`);
	const owner = mutableInteractiveContext(root, oldSessionId, oldSessionFile);
	host.fireSessionStart(owner.context);
	host.fireSessionStart(owner.context);

	const ctoCommand = host.commands.get("omp-cto");
	assert.ok(ctoCommand);
	const successorPath = join(root, "src", "captured-file-switch.ts");
	const hookIsBlocked = (ctx: unknown): boolean => host.fireToolCall(
		{ toolName: "write", input: { path: successorPath, content: "{}" } },
		ctx,
	).some((result) => Boolean(result && typeof result === "object" && "block" in result && result.block === true));
	assert.equal(hookIsBlocked(owner.context), false, "the captured old host is admitted before replacement");

	const newSessionId = "entry-switch-unclaimed-new";
	const newSessionFile = join(root, "sessions", `2026-09-24T00-00-00-000Z_${newSessionId}.jsonl`);
	const wrongSessionFile = join(root, "sessions", "wrong-old-session.jsonl");
	owner.setSession(newSessionId, newSessionFile);
	host.fireSessionSwitch({ type: "session_switch", reason: "new" }, owner.context);
	assert.equal(hookIsBlocked(owner.context), true, "omitted old-file proof cannot bind the successor");
	host.fireSessionSwitch(
		{ type: "session_switch", reason: "new", previousSessionFile: "" },
		owner.context,
	);
	assert.equal(hookIsBlocked(owner.context), true, "malformed old-file proof cannot bind the successor");
	host.fireSessionSwitch(
		{ type: "session_switch", reason: "new", previousSessionFile: wrongSessionFile },
		owner.context,
	);
	assert.equal(hookIsBlocked(owner.context), true, "wrong old-file proof cannot bind the successor");
	await assert.rejects(
		() => ctoCommand.handler("unverified successor command", owner.context),
		(error: unknown) => {
			assert.equal(workflowErrorCode(error), "WORKFLOW_CONTEXT_REJECTED");
			return true;
		},
		"unverified successor command admission must fail closed",
	);

	host.fireSessionSwitch(
		{ type: "session_switch", reason: "new", previousSessionFile: oldSessionFile },
		owner.context,
	);
	assert.equal(hookIsBlocked(owner.context), false, "exact old-file proof admits the successor to raw tools");
	await ctoCommand.handler("verified successor command", owner.context);
	host.fireSessionShutdown({ type: "session_shutdown" }, owner.context);
});

test("custom-named old session files use the exact manager identity for replacement", async () => {
	resetWorkflowOwners();
	const root = markedRoot();
	initGit(root);
	const host = makePi({ tools: true });
	ompWorkflowsInternal(host.pi as never);
	const oldSessionId = "entry-custom-old";
	const oldSessionFile = join(root, "sessions", "custom_old_transcript.jsonl");
	mkdirSync(join(root, "sessions"), { recursive: true });
	writeFileSync(
		oldSessionFile,
		JSON.stringify({ type: "session", id: oldSessionId, timestamp: "2026-09-24T00:00:00.000Z", cwd: root }) + "\n",
	);
	const ownerSession = mutableInteractiveContext(root, oldSessionId, oldSessionFile);
	const owner = ownerSession.context;
	host.fireSessionStart(owner);
	host.fireSessionStart(owner);

	const ctoCommand = host.commands.get("omp-cto");
	assert.ok(ctoCommand);
	await ctoCommand.handler("custom manager file switch", owner);
	const oldClaim = readRunControl(root).execution_claim;
	assert.equal(oldClaim?.owner_kind, "cto", JSON.stringify(oldClaim));
	assert.equal(oldClaim?.coordinator_session_id, oldSessionId, JSON.stringify(oldClaim));

	const newSessionId = "entry-custom-new";
	const newSessionFile = join(root, "sessions", "custom_new_transcript.jsonl");
	ownerSession.setSession(newSessionId, newSessionFile);
	host.fireSessionSwitch(
		{ type: "session_switch", reason: "resume", previousSessionFile: oldSessionFile },
		owner,
	);
	assert.equal(readRunControl(root).execution_claim, null, "same-manager custom file switch suspends the old CTO claim");

	await ctoCommand.handler("custom manager file replacement owner", owner);
	const newClaim = readRunControl(root).execution_claim;
	assert.equal(newClaim?.owner_kind, "cto", JSON.stringify(newClaim));
	assert.equal(newClaim?.coordinator_session_id, newSessionId, JSON.stringify(newClaim));
	host.fireSessionShutdown({ type: "session_shutdown" }, owner);
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

test("managerless host upgrades one binding across command, raw tool, and shutdown", async () => {
	resetWorkflowOwners();
	const root = markedRoot();
	initGit(root);
	const host = makePi({ tools: true });
	ompWorkflowsInternal(host.pi as never);
	const sessionId = "entry-lazy-manager-session";
	const managerless = {
		cwd: root,
		mode: "tui" as const,
		hasUI: true as const,
		session_id: sessionId,
	};
	const managerBacked = interactiveContext(root, sessionId);
	host.fireSessionStart(managerless);

	const ctoCommand = host.commands.get("omp-cto");
	assert.ok(ctoCommand);
	await ctoCommand.handler("lazy controller continuity", managerBacked);
	const claim = readRunControl(root).execution_claim;
	assert.equal(claim?.owner_kind, "cto", JSON.stringify(claim));
	const runId = claim?.run_id;
	assert.equal(typeof runId, "string", JSON.stringify(claim));
	if (!runId) return;

	const privilegedPath = join(root, ".work-state", "cto", runId, "lazy.json");
	const hookIsBlocked = (ctx: unknown): boolean => host.fireToolCall(
		{ toolName: "write", input: { path: privilegedPath, content: "{}" } },
		ctx,
	).some((result) => Boolean(result && typeof result === "object" && "block" in result && result.block === true));
	const managerlessRawResults = host.fireToolCall(
		{ toolName: "write", input: { path: privilegedPath, content: "{}" } },
		managerBacked,
	);
	assert.equal(
		managerlessRawResults.some((result) => Boolean(result && typeof result === "object" && "block" in result && result.block === true)),
		false,
		`raw tool uses the controller lazily bound by the registered command; hook_block_reasons=${hookBlockReasons(managerlessRawResults)}`,
	);

	host.fireSessionShutdown({ type: "session_shutdown" }, managerBacked);
	assert.equal(readRunControl(root).execution_claim, null, "trusted shutdown suspends the lazy controller claim");
	assert.equal(hookIsBlocked(managerBacked), true, "shutdown removes raw authority from the shared controller");
	const claimBeforeRejectedCommand = readRunControl(root).execution_claim;
	await assert.rejects(
		() => ctoCommand.handler("after lazy shutdown", managerBacked),
		(error: unknown) => {
			assert.equal(workflowErrorCode(error), "WORKFLOW_CONTEXT_REJECTED");
			return true;
		},
	);
	assert.deepEqual(
		readRunControl(root).execution_claim,
		claimBeforeRejectedCommand,
		"rejected post-shutdown command preserves the protected claim state",
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
