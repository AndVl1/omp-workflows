import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { scenarioTest, recordScenarioEvent } from "../../core/test/reliable-stage-trace.js";

import {
	readRunState,
	registerWorkflowProfiles,
	resetWorkflowOwners,
	runStatePath,
	runTarget,
	type Profile,
} from "@andvl1/omp-workflows-core";

import ompWorkflowsInternal from "../src/index.js";

const INTERNAL_PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const TEST_PROFILE: Profile = {
	name: "internal-reliable-stage",
	title: "Internal reliable stage registration",
	description: "A narrowly scoped registered profile for the internal bundle acceptance path.",
	match: { type: ["FEATURE"], complexity: ["QUICK"] },
	stages: [{
		id: "implementation",
		title: "Implementation",
		type: "single",
		role: "developer",
		produces: "implementation",
	}],
};

interface ToolResult {
	details?: unknown;
	content?: unknown;
	isError?: boolean;
}

interface RegisteredTool {
	name: string;
	execute: (...args: unknown[]) => Promise<ToolResult>;
}

interface SessionManager {
	getCwd: () => string;
	getSessionId: () => string;
	getSessionFile: () => string;
	getHeader: () => { id: string; cwd: string; parentSession?: string };
}

type HostContext = Record<string, unknown> & {
	cwd: string;
	session_id: string;
	sessionManager: SessionManager;
};

type Handoff = {
	stage_cursor: string;
	expected_roster: Array<{ role: string; agent: string }>;
	dispatch_markers: Array<{ role: string; agent: string; marker: string }>;
};

type WorkerFixture = {
	toolCallId: string;
	input: { agent: string; task: string };
	childContext: HostContext;
	childFile: string;
};

interface RecoveryContinuation {
	message: unknown;
	options: unknown;
}

type RecoveryDispatchBarrier = {
	queued: Promise<void>;
	release: () => void;
};

interface Harness {
	root: string;
	context: HostContext;
	tools: Map<string, RegisteredTool>;
	emit: (name: string, ...args: unknown[]) => Promise<unknown[]>;
	recoveryContinuation: () => Promise<RecoveryContinuation>;
	withRecoveryDispatchBarrier: <T>(callback: (barrier: RecoveryDispatchBarrier) => Promise<T>) => Promise<T>;
}

function permissiveZod(): { z: unknown } {
	const schema = new Proxy({}, { get: () => () => schema });
	const z = new Proxy({}, { get: () => () => schema });
	return { z };
}

function markedRoot(): string {
	const root = mkdtempSync(join(tmpdir(), "omp-internal-workflow-registration-"));
	writeFileSync(join(root, "package.json"), "{}\n");
	mkdirSync(join(root, "packages", "core"), { recursive: true });
	mkdirSync(join(root, "packages", "fullstack"), { recursive: true });
	mkdirSync(join(root, ".omp"), { recursive: true });
	writeFileSync(
		join(root, ".omp", "settings.json"),
		`${JSON.stringify({ extensions: [INTERNAL_PACKAGE_ROOT] }, null, 2)}\n`,
	);
	return root;
}
async function testAgentDiscovery(_cwd: string): Promise<{
	agents: Array<{ name: string; source: "bundled"; filePath: string }>;
}> {
	const agents = readdirSync(join(INTERNAL_PACKAGE_ROOT, "agents"))
		.filter((name) => name.endsWith(".md"))
		.map((name) => ({
			name: name.slice(0, -3),
			source: "bundled" as const,
			filePath: join(INTERNAL_PACKAGE_ROOT, "agents", name),
		}));
	return { agents };
}

function sessionManager(root: string, id: string, file: string, parentSession?: string): SessionManager {
	const header = { id, cwd: root, ...(parentSession ? { parentSession } : {}) };
	return {
		getCwd: () => root,
		getSessionId: () => id,
		getSessionFile: () => file,
		getHeader: () => header,
	};
}

function makeHarness(): Harness {
	const root = markedRoot();
	execFileSync("git", ["-C", root, "init", "--quiet", "--initial-branch", "main"], { stdio: "ignore" });
	const tools = new Map<string, RegisteredTool>();
	const handlers = new Map<string, Array<(event: unknown, ctx: unknown) => unknown>>();
	let resolveRecoveryContinuation: ((value: RecoveryContinuation) => void) | undefined;
	const recoveryContinuation = new Promise<RecoveryContinuation>((resolve) => {
		resolveRecoveryContinuation = resolve;
	});
	type PendingRecoveryDispatch = {
		captured: RecoveryContinuation;
		resolve: () => void;
	};
	type ActiveRecoveryDispatchBarrier = {
		pending: PendingRecoveryDispatch[];
		resolveQueued: () => void;
		queued: boolean;
		released: boolean;
	};
	let activeRecoveryDispatchBarrier: ActiveRecoveryDispatchBarrier | undefined;
	const isRecoveryMessage = (message: unknown): boolean => Boolean(
		message
		&& typeof message === "object"
		&& !Array.isArray(message)
		&& "customType" in message
		&& message.customType === "omp-workflow-stage-recovery",
	);
	const sessionId = "internal-registration-session";
	const sessionFile = join(root, "sessions", `${sessionId}.jsonl`);
	const manager = sessionManager(root, sessionId, sessionFile);
	const context: HostContext = {
		cwd: root,
		mode: "tui",
		hasUI: true,
		actor: "orchestrator",
		caller: "host",
		process_id: process.pid,
		worktree: root,
		branch: "main",
		authority: "coordinator",
		session_id: sessionId,
		sessionFile,
		sessionManager: manager,
		ui: { notify() {} },
	};
	const on = (event: string, handler: (payload: unknown, ctx: unknown) => unknown): void => {
		handlers.set(event, [...(handlers.get(event) ?? []), handler]);
	};
	const releaseRecoveryDispatch = (state: ActiveRecoveryDispatchBarrier): void => {
		if (state.released) return;
		state.released = true;
		if (activeRecoveryDispatchBarrier === state) activeRecoveryDispatchBarrier = undefined;
		for (const pending of state.pending.splice(0)) pending.resolve();
	};
	const withRecoveryDispatchBarrier = async <T>(
		callback: (barrier: RecoveryDispatchBarrier) => Promise<T>,
	): Promise<T> => {
		if (activeRecoveryDispatchBarrier) throw new Error("recovery dispatch barrier already active");
		let resolveQueued!: () => void;
		const queued = new Promise<void>((resolve) => {
			resolveQueued = resolve;
		});
		const state: ActiveRecoveryDispatchBarrier = {
			pending: [],
			resolveQueued,
			queued: false,
			released: false,
		};
		activeRecoveryDispatchBarrier = state;
		const barrier: RecoveryDispatchBarrier = {
			queued,
			release: () => {
				releaseRecoveryDispatch(state);
			},
		};
		try {
			return await callback(barrier);
		} finally {
			barrier.release();
		}
	};
	const sendRecoveryMessage = (message: unknown, options: unknown): void | Promise<void> => {
		if (!isRecoveryMessage(message)) return;
		const captured = { message, options };
		const barrier = activeRecoveryDispatchBarrier;
		if (!barrier) {
			resolveRecoveryContinuation?.(captured);
			return;
		}
		const delivery = new Promise<void>((resolve) => {
			barrier.pending.push({ captured, resolve });
		});
		if (!barrier.queued) {
			barrier.queued = true;
			barrier.resolveQueued();
		}
		resolveRecoveryContinuation?.(captured);
		return delivery;
	};
	const pi = {
		zod: permissiveZod(),
		on,
		events: { on },
		registerCommand() {},
		registerTool(tool: RegisteredTool) {
			tools.set(tool.name, tool);
		},
		setLabel() {},
		sendMessage: sendRecoveryMessage,
		sendUserMessage() {},
	};
	resetWorkflowOwners();
	ompWorkflowsInternal(pi as never, { discoverAgents: testAgentDiscovery });
	registerWorkflowProfiles([TEST_PROFILE]);
	recordScenarioEvent({
		kind: "workflow_registered",
		workflow: TEST_PROFILE.name,
		phase: "registration",
		outcome: "ACCEPTED",
		verdict: "PASS",
	});
	for (const name of tools.keys()) {
		recordScenarioEvent({ kind: "tool_registered", workflow: TEST_PROFILE.name, tool: name, phase: "registration" });
	}
	return {
		root,
		context,
		tools,
		recoveryContinuation: () => recoveryContinuation,
		withRecoveryDispatchBarrier,
		async emit(event, ...args) {
			const result: unknown[] = [];
			for (const handler of handlers.get(event) ?? []) result.push(await handler(...args));
			return result;
		},
		async close() {
			if (activeRecoveryDispatchBarrier) releaseRecoveryDispatch(activeRecoveryDispatchBarrier);
			await this.emit("session_shutdown", { type: "session_shutdown", session_id: sessionId }, context);
			rmSync(root, { recursive: true, force: true });
		},
	};
}

function details(value: unknown): Record<string, unknown> {
	assert.ok(value && typeof value === "object" && !Array.isArray(value), JSON.stringify(value));
	return value as Record<string, unknown>;
}

function requireTool(harness: Harness, name: string): RegisteredTool {
	const tool = harness.tools.get(name);
	assert.ok(tool?.execute, `${name} must be registered through the internal production bundle`);
	return tool;
}

function state(harness: Harness, runId: string): Record<string, unknown> {
	const current = readRunState(harness.root, runId);
	assert.ok(current, `canonical state must exist for ${runId}`);
	return current as unknown as Record<string, unknown>;
}

function dispatches(harness: Harness, runId: string): Array<Record<string, unknown>> {
	const capability = state(harness, runId).dispatch_capability;
	if (!capability || typeof capability !== "object" || Array.isArray(capability)) return [];
	const rows = (capability as Record<string, unknown>).dispatches;
	return Array.isArray(rows) ? rows as Array<Record<string, unknown>> : [];
}

async function ingress(harness: Harness): Promise<{ runId: string; handoff: Handoff }> {
	await harness.emit("session_start", { type: "session_start", session_id: harness.context.session_id }, harness.context);
	const prepare = requireTool(harness, "workflow_prepare");
	recordScenarioEvent({ kind: "tool_called", workflow: TEST_PROFILE.name, tool: "workflow_prepare", phase: "prepare" });
	const prepared = await prepare.execute(
		"internal-registration-prepare",
		{
			mode: "new",
			task: "exercise the private bundle production registration",
			classification: {
				type: "FEATURE",
				complexity: "QUICK",
				confidence: "HIGH",
				autonomous: false,
				workflow: TEST_PROFILE.name,
			},
		},
		undefined,
		undefined,
		harness.context,
	);
	const preparedDetails = details(prepared.details);
	const prepareAccepted = preparedDetails.ok === true;
	recordScenarioEvent({
		kind: "tool_completed",
		workflow: TEST_PROFILE.name,
		tool: "workflow_prepare",
		phase: "prepare",
		outcome: prepareAccepted ? "ACCEPTED" : "REJECTED",
		verdict: prepareAccepted ? "PASS" : "FAIL",
	});
	assert.equal(preparedDetails.ok, true, JSON.stringify(preparedDetails));
	const preparedState = details(preparedDetails.state);
	const runId = preparedState.run_id;
	assert.equal(typeof runId, "string", JSON.stringify(preparedDetails));
	recordScenarioEvent({
		kind: "workflow_started",
		workflow: TEST_PROFILE.name,
		phase: "prepare",
		identities: { run: runId as string },
		outcome: "STARTED",
	});

	const begin = requireTool(harness, "workflow_begin");
	recordScenarioEvent({ kind: "tool_called", workflow: TEST_PROFILE.name, tool: "workflow_begin", phase: "begin", identities: { run: runId as string } });
	const begun = await begin.execute("internal-registration-begin", {}, undefined, undefined, harness.context);
	const begunDetails = details(begun.details);
	const beginAccepted = begunDetails.ok === true;
	recordScenarioEvent({
		kind: "tool_completed",
		workflow: TEST_PROFILE.name,
		tool: "workflow_begin",
		phase: "begin",
		identities: { run: runId as string },
		outcome: beginAccepted ? "ACCEPTED" : "REJECTED",
		verdict: beginAccepted ? "PASS" : "FAIL",
	});
	assert.equal(begunDetails.ok, true, JSON.stringify(begunDetails));
	assert.ok(begunDetails.handoff && typeof begunDetails.handoff === "object", JSON.stringify(begunDetails));
	recordScenarioEvent({
		kind: "stage_entered",
		workflow: TEST_PROFILE.name,
		stage: "implementation",
		phase: "begin",
		identities: { run: runId as string, stage: "implementation" },
		outcome: "STARTED",
	});
	return { runId: runId as string, handoff: begunDetails.handoff as Handoff };
}

async function preflightAndRecover(harness: Harness, runId: string, handoff: Handoff): Promise<Handoff> {
	assert.deepEqual(dispatches(harness, runId), [], "workflow_begin must not pre-authorize a worker dispatch");
	const roster = handoff.expected_roster[0];
	const marker = handoff.dispatch_markers[0];
	assert.ok(roster && marker, "preflight must use the exact current flat assignment");
	const toolCallId = "internal-registration-malformed-task";
	const malformedInput = { tasks: [{ agent: roster.agent, task: marker.marker }] };
	const recoveryMessage = harness.recoveryContinuation();
	const recoveryPermit = await harness.withRecoveryDispatchBarrier(async (barrier) => {
	recordScenarioEvent({
		kind: "barrier_wait",
		workflow: TEST_PROFILE.name,
		stage: "implementation",
		phase: "preflight",
		barrier: "recovery_continuation",
		identities: { run: runId },
	});
	recordScenarioEvent({
		kind: "tool_called",
		workflow: TEST_PROFILE.name,
		stage: "implementation",
		phase: "preflight",
		tool: "task",
		identities: { run: runId, task: toolCallId },
	});
	const invocation = harness.emit(
		"tool_call",
		{ toolName: "task", toolCallId, input: malformedInput },
		harness.context,
	);
	const entered = await Promise.race([
		invocation.then((result) => ({ kind: "completed" as const, result })),
		barrier.queued.then(() => ({ kind: "barrier" as const })),
	]);
	assert.equal(entered.kind, "completed", "preflight barrier must not release before the rejected invocation settles");
	if (entered.kind !== "completed") throw new Error("preflight barrier released before the rejected invocation settled");
	const admission = entered.result;
	recordScenarioEvent({
		kind: "tool_completed",
		workflow: TEST_PROFILE.name,
		stage: "implementation",
		phase: "preflight",
		tool: "task",
		identities: { run: runId, task: toolCallId },
		outcome: "NOT_STARTED",
		verdict: "BLOCKED",
		faultPoint: "preflight",
	});
	assert.ok(
		admission.some((entry) => entry && typeof entry === "object" && "block" in entry && entry.block === true),
		JSON.stringify(admission),
	);
	const continuation = await recoveryMessage;
	const message = details(continuation.message);
	assert.equal(message.customType, "omp-workflow-stage-recovery", JSON.stringify(message));
	const payload = details(message.details);
	assert.deepEqual(
		{
			version: payload.version,
			kind: payload.kind,
			run_id: payload.run_id,
			authority: payload.authority,
		},
		{
			version: 1,
			kind: "stage_recovery_continuation",
			run_id: runId,
			authority: "ordinary",
		},
		JSON.stringify(payload),
	);
	assert.equal(typeof payload.operation_id, "string", JSON.stringify(payload));
	assert.equal(typeof payload.retry_of, "string", JSON.stringify(payload));
	assert.ok(payload.identity && typeof payload.identity === "object", JSON.stringify(payload));
	assert.equal("stage_token" in payload, false, "recovery continuation must not expose a model stage token");
	const continuationOptions = details(continuation.options);
	assert.deepEqual(
		{ deliverAs: continuationOptions.deliverAs, triggerTurn: continuationOptions.triggerTurn },
		{ deliverAs: "followUp", triggerTurn: true },
		JSON.stringify(continuationOptions),
	);

	const failedDispatches = dispatches(harness, runId);
	assert.equal(failedDispatches.length, 1, JSON.stringify(failedDispatches));
	const failed = failedDispatches[0]!;
	assert.equal(typeof failed.id, "string", JSON.stringify(failed));
	const failedId = failed.id as string;
	assert.equal(failed.tool_call_id, toolCallId, JSON.stringify(failed));
	assert.equal(failed.status, "failed", JSON.stringify(failed));
	assert.equal(failedDispatches.some((dispatch) => dispatch.status === "pending" || dispatch.status === "running"), false, JSON.stringify(failedDispatches));
	const afterAutomaticPrepare = state(harness, runId);
	recordScenarioEvent({
		kind: "fault_observed",
		workflow: TEST_PROFILE.name,
		stage: "implementation",
		phase: "preflight",
		identities: { run: runId, dispatch: failedId },
		outcome: "NOT_STARTED",
		verdict: "REJECT",
		faultPoint: "preflight",
	});
	const recoveryLedger = details(afterAutomaticPrepare.stage_recovery);
	const lineages = details(recoveryLedger.lineages);
	const lineageRows = Object.values(lineages).map((value) => details(value));
	assert.equal(lineageRows.length, 1, JSON.stringify(recoveryLedger));
	const lineage = lineageRows[0]!;
	const operations = Array.isArray(lineage.operations) ? lineage.operations.map((value) => details(value)) : [];
	const automatic = operations.find((operation) => operation.retry_of === failedId);
	assert.ok(automatic, JSON.stringify(lineage));
	assert.equal(automatic.status, "prepared", JSON.stringify(automatic));
	assert.equal(automatic.operation_id, payload.operation_id, JSON.stringify(automatic));
	const preflight = details(lineage.preflight);
	assert.deepEqual(
		{ kind: preflight.kind, authoritative: preflight.authoritative, never_started: preflight.never_started, dispatch_id: preflight.dispatch_id },
		{ kind: "preflight_not_started", authoritative: true, never_started: true, dispatch_id: failedId },
		JSON.stringify(preflight),
	);
	assert.equal(payload.retry_of, failedId, JSON.stringify(payload));
	assert.equal(automatic.retry_of, failedId, JSON.stringify(automatic));
	assert.equal(details(automatic.admission).state, "ready", JSON.stringify(automatic));
	const replacementIdentity = details(automatic.replacement_identity);
	assert.equal(typeof replacementIdentity.dispatch_id, "string", JSON.stringify(automatic));
	const replacementDispatchId = replacementIdentity.dispatch_id as string;
	assert.notEqual(replacementDispatchId, failedId, JSON.stringify(automatic));
	assert.deepEqual(details(payload.identity), replacementIdentity, JSON.stringify(payload));
	recordScenarioEvent({
		kind: "recovery_reconciled",
		workflow: TEST_PROFILE.name,
		stage: "implementation",
		phase: "preflight",
		identities: { run: runId, dispatch: replacementDispatchId },
		links: { retry_of: failedId },
		outcome: "PENDING",
		verdict: "RETRY",
	});

	const recover = requireTool(harness, "workflow_recover");
	recordScenarioEvent({
		kind: "tool_called",
		workflow: TEST_PROFILE.name,
		stage: "implementation",
		phase: "recovery",
		tool: "workflow_recover",
		identities: { run: runId, dispatch: failedId },
	});
	const result = await recover.execute(
		"internal-registration-preflight-diagnose",
		{ operation: "diagnose" },
		undefined,
		undefined,
		harness.context,
	);
	const recovered = details(result.details);
	const recoveryAccepted = recovered.ok === true;
	recordScenarioEvent({
		kind: "tool_completed",
		workflow: TEST_PROFILE.name,
		stage: "implementation",
		phase: "recovery",
		tool: "workflow_recover",
		identities: { run: runId, dispatch: failedId },
		outcome: recoveryAccepted ? "ACCEPTED" : "REJECTED",
		verdict: recoveryAccepted ? "PASS" : "FAIL",
	});
	assert.equal(recovered.ok, true, JSON.stringify(recovered));
	const recovery = details(recovered.recovery);
	assert.equal(recovery.worker, "not_started", JSON.stringify(recovered));
	assert.equal("stage_token" in recovery, false, "recovery must not expose a model stage token");
	recordScenarioEvent({
		kind: "recovery_diagnosed",
		workflow: TEST_PROFILE.name,
		stage: "implementation",
		phase: "recovery",
		identities: { run: runId, dispatch: failedId },
		outcome: "NOT_STARTED",
		verdict: "PASS",
		faultPoint: "recovery",
	});
	assert.deepEqual(state(harness, runId), afterAutomaticPrepare, "diagnose must not mutate canonical recovery state while delivery is held");
	return { failedId, replacementDispatchId };
	});
	recordScenarioEvent({
		kind: "barrier_released",
		workflow: TEST_PROFILE.name,
		stage: "implementation",
		phase: "preflight",
		barrier: "recovery_continuation",
		identities: { run: runId },
		outcome: "COMPLETED",
	});
	const { failedId, replacementDispatchId } = recoveryPermit;

	const begin = requireTool(harness, "workflow_begin");
	recordScenarioEvent({
		kind: "tool_called",
		workflow: TEST_PROFILE.name,
		stage: "implementation",
		phase: "recovery",
		tool: "workflow_begin",
		identities: { run: runId, dispatch: replacementDispatchId },
		links: { retry_of: failedId },
	});
	const begun = await begin.execute("internal-registration-corrected-begin", {}, undefined, undefined, harness.context);
	const corrected = details(begun.details);
	const correctedAccepted = corrected.ok === true;
	recordScenarioEvent({
		kind: "tool_completed",
		workflow: TEST_PROFILE.name,
		stage: "implementation",
		phase: "recovery",
		tool: "workflow_begin",
		identities: { run: runId, dispatch: replacementDispatchId },
		links: { retry_of: failedId },
		outcome: correctedAccepted ? "ACCEPTED" : "REJECTED",
		verdict: correctedAccepted ? "PASS" : "FAIL",
	});
	assert.equal(corrected.ok, true, JSON.stringify(corrected));
	assert.ok(corrected.handoff && typeof corrected.handoff === "object", JSON.stringify(corrected));
	recordScenarioEvent({
		kind: "retry_started",
		workflow: TEST_PROFILE.name,
		stage: "implementation",
		phase: "recovery",
		identities: { run: runId, dispatch: replacementDispatchId },
		links: { retry_of: failedId },
		outcome: "STARTED",
		verdict: "RETRY",
	});
	return corrected.handoff as Handoff;
}

async function admitOrdinaryWorker(harness: Harness, runId: string, handoff: Handoff, suffix: string): Promise<WorkerFixture> {
	const roster = handoff.expected_roster[0];
	const marker = handoff.dispatch_markers[0];
	assert.ok(roster && marker, "workflow_begin must expose exactly one worker assignment");
	assert.equal(roster.agent, marker.agent, "host assignment and marker must name the same worker");
	const toolCallId = `internal-registration-${suffix}-task`;
	const input = { agent: roster.agent, task: marker.marker };
	recordScenarioEvent({
		kind: "tool_called",
		workflow: TEST_PROFILE.name,
		stage: "implementation",
		phase: "admission",
		tool: "task",
		identities: { run: runId, task: toolCallId },
	});
	const admission = await harness.emit("tool_call", { toolName: "task", toolCallId, input }, harness.context);
	assert.equal(admission.filter((entry) => entry !== undefined).length, 0, JSON.stringify(admission));
	recordScenarioEvent({
		kind: "worker_admitted",
		workflow: TEST_PROFILE.name,
		stage: "implementation",
		phase: "admission",
		identities: { run: runId, task: toolCallId },
		outcome: "ACCEPTED",
		verdict: "PASS",
	});
	await harness.emit("tool_execution_start", { toolName: "task", toolCallId, args: input }, harness.context);
	const childFile = join(harness.root, "sessions", `${suffix}-worker.jsonl`);
	const childId = `internal-registration-${suffix}-worker`;
	const childManager = sessionManager(harness.root, childId, childFile, harness.context.sessionManager.getSessionFile());
	const childContext: HostContext = {
		cwd: harness.root,
		mode: "print",
		hasUI: false,
		actor: "worker",
		session_id: childId,
		sessionFile: childFile,
		sessionManager: childManager,
	};
	await harness.emit("task:subagent:lifecycle", {
		id: `${toolCallId}-lifecycle`,
		agent: roster.agent,
		status: "started",
		sessionFile: childFile,
		parentToolCallId: toolCallId,
		index: 0,
	});
	recordScenarioEvent({
		kind: "worker_started",
		workflow: TEST_PROFILE.name,
		stage: "implementation",
		phase: "execution",
		identities: { run: runId, worker: childId, task: toolCallId },
		outcome: "STARTED",
		verdict: "PASS",
	});
	return { toolCallId, input, childContext, childFile };
}

async function submit(harness: Harness, runId: string, worker: WorkerFixture, callId: string): Promise<Record<string, unknown>> {
	recordScenarioEvent({
		kind: "tool_called",
		workflow: TEST_PROFILE.name,
		stage: "implementation",
		phase: "submission",
		tool: "workflow_submit_result",
		identities: { run: runId, worker: worker.childContext.session_id },
	});
	const result = await requireTool(harness, "workflow_submit_result").execute(
		callId,
		{ outputs: { implementation: { files_touched: ["packages/omp-workflows-internal/src/index.ts"] } } },
		undefined,
		undefined,
		worker.childContext,
	);
	const resultDetails = details(result.details);
	const accepted = resultDetails.ok === true;
	recordScenarioEvent({
		kind: "tool_completed",
		workflow: TEST_PROFILE.name,
		stage: "implementation",
		phase: "submission",
		tool: "workflow_submit_result",
		identities: { run: runId, worker: worker.childContext.session_id },
		outcome: accepted ? "ACCEPTED" : "REJECTED",
		verdict: accepted ? "PASS" : "REJECT",
	});
	recordScenarioEvent({
		kind: "stage_submitted",
		workflow: TEST_PROFILE.name,
		stage: "implementation",
		phase: "submission",
		identities: { run: runId, worker: worker.childContext.session_id },
		outcome: accepted ? "ACCEPTED" : "REJECTED",
		verdict: accepted ? "ACCEPT" : "REJECT",
		faultPoint: accepted ? undefined : "validation",
	});
	if (accepted) {
		recordScenarioEvent({
			kind: "artifact_published",
			workflow: TEST_PROFILE.name,
			stage: "implementation",
			phase: "publication",
			identities: { run: runId, worker: worker.childContext.session_id },
			outcome: "ACCEPTED",
			verdict: "PASS",
		});
	}
	return resultDetails;
}

async function terminalWorker(harness: Harness, runId: string, worker: WorkerFixture): Promise<void> {
	await harness.emit(
		"tool_result",
		{
			toolName: "task",
			toolCallId: worker.toolCallId,
			input: worker.input,
			details: {
				results: [{
					index: 0,
					id: `${worker.toolCallId}-result`,
					agent: worker.input.agent,
					agentSource: "project",
					task: worker.input.task,
					exitCode: 0,
					output: "worker terminal result",
					stderr: "",
					truncated: false,
					durationMs: 1,
					tokens: 1,
					requests: 1,
				}],
			},
			content: [{ type: "text", text: "worker terminal result" }],
			isError: false,
		},
		harness.context,
	);
	await harness.emit("task:subagent:lifecycle", {
		id: `${worker.toolCallId}-lifecycle`,
		agent: worker.input.agent,
		status: "completed",
		sessionFile: worker.childFile,
		parentToolCallId: worker.toolCallId,
		index: 0,
	});
	recordScenarioEvent({
		kind: "worker_completed",
		workflow: TEST_PROFILE.name,
		stage: "implementation",
		phase: "execution",
		identities: { run: runId, worker: worker.childContext.session_id, task: worker.toolCallId },
		outcome: "COMPLETED",
		verdict: "PASS",
	});
}
function publishedFiles(harness: Harness, runId: string): string[] {
	const artifacts = runTarget(harness.root, runId).artifactsDir;
	assert.ok(artifacts, "ordinary run must expose an artifact root");
	return readdirSync(artifacts).filter((name) => name === "implementation.json" || name.startsWith("stage-receipt-"));
}

scenarioTest("[O:S01][O:R06] internal bundle accepts a native-worker submission through production registration", async () => {
	const harness = makeHarness();
	try {
		const { runId, handoff } = await ingress(harness);
		const correctedHandoff = await preflightAndRecover(harness, runId, handoff);
		const worker = await admitOrdinaryWorker(harness, runId, correctedHandoff, "valid");
		const runningDispatches = dispatches(harness, runId);
		assert.equal(runningDispatches.length, 2, JSON.stringify(runningDispatches));
		assert.equal(runningDispatches[0]?.status, "failed", JSON.stringify(runningDispatches));
		assert.equal(runningDispatches[0]?.tool_call_id, "internal-registration-malformed-task", JSON.stringify(runningDispatches));
		assert.equal(runningDispatches[1]?.status, "authorized", JSON.stringify(runningDispatches));
		const replacementPending = details(runningDispatches[1]?.pending);
		assert.equal(replacementPending.retry_of, runningDispatches[0]?.id, JSON.stringify(runningDispatches));
		const receipt = await submit(harness, runId, worker, "internal-registration-valid-submission");
		assert.equal(receipt.ok, true, JSON.stringify(receipt));
		const accepted = details(receipt.receipt);
		const binding = details(accepted.binding);
		const producer = details(binding.producer);
		assert.equal(producer.kind, "worker", JSON.stringify(accepted));
		assert.equal(binding.authority, "ordinary", JSON.stringify(accepted));
		assert.equal(details(binding.host).session_id, worker.childContext.session_id, JSON.stringify(accepted));
		const lineage = details(producer.lineage);
		assert.deepEqual(
			{
				session_id: lineage.session_id,
				session_file: lineage.session_file,
				parent_session_file: lineage.parent_session_file,
				parent_tool_call_id: lineage.parent_tool_call_id,
			},
			{
				session_id: worker.childContext.session_id,
				session_file: worker.childContext.sessionFile,
				parent_session_file: harness.context.sessionManager.getSessionFile(),
				parent_tool_call_id: worker.toolCallId,
			},
			JSON.stringify(accepted),
		);
		assert.equal(details(binding.identity).dispatch_id, runningDispatches[1]?.id, JSON.stringify(accepted));
		assert.equal("stage_token" in accepted, false, "receipt must not expose a stage token");
		assert.deepEqual(
			(Array.isArray(accepted.outputs) ? accepted.outputs : []).map((row) => details(row).artifact_id),
			["implementation"],
			JSON.stringify(accepted),
		);
		assert.deepEqual(publishedFiles(harness, runId).filter((name) => name === "implementation.json"), ["implementation.json"]);
		await terminalWorker(harness, runId, worker);
		const terminalDispatches = dispatches(harness, runId);
		assert.equal(terminalDispatches.length, 2, JSON.stringify(terminalDispatches));
		assert.equal(terminalDispatches[0]?.status, "failed", JSON.stringify(terminalDispatches));
		assert.equal(terminalDispatches[1]?.status, "succeeded", JSON.stringify(terminalDispatches));
		assert.equal(details(terminalDispatches[1]?.pending).retry_of, terminalDispatches[0]?.id, JSON.stringify(terminalDispatches));
		recordScenarioEvent({
			kind: "run_completed",
			workflow: TEST_PROFILE.name,
			stage: "implementation",
			phase: "completion",
			identities: { run: runId },
			outcome: "COMPLETED",
			verdict: "PASS",
		});
	} finally {
		await harness.close();
	}
});

scenarioTest("[O:S04] internal bundle rejects foreign worker identity without publishing outputs or changing the ledger", async () => {
	const harness = makeHarness();
	try {
		const { runId, handoff } = await ingress(harness);
		const worker = await admitOrdinaryWorker(harness, runId, handoff, "foreign");
		const statePath = runStatePath(harness.root, runId);
		const stateBefore = readFileSync(statePath, "utf8");
		const filesBefore = publishedFiles(harness, runId);
		const foreignFile = join(harness.root, "sessions", "foreign-worker-spoof.jsonl");
		const foreignManager = sessionManager(
			harness.root,
			"internal-registration-foreign-spoof",
			foreignFile,
			harness.context.sessionManager.getSessionFile(),
		);
		const foreignContext: HostContext = {
			cwd: harness.root,
			mode: "print",
			hasUI: false,
			actor: "worker",
			session_id: "internal-registration-foreign-spoof",
			sessionFile: foreignFile,
			sessionManager: foreignManager,
		};
		recordScenarioEvent({
			kind: "tool_called",
			workflow: TEST_PROFILE.name,
			stage: "implementation",
			phase: "submission",
			tool: "workflow_submit_result",
			identities: { run: runId, worker: foreignContext.session_id },
		});
		const rejected = await requireTool(harness, "workflow_submit_result").execute(
			"internal-registration-foreign-submission",
			{ outputs: { implementation: { files_touched: ["packages/omp-workflows-internal/src/index.ts"] } } },
			undefined,
			undefined,
			foreignContext,
		);
		const rejectedDetails = details(rejected.details);
		const rejectionObserved = rejectedDetails.ok === false;
		recordScenarioEvent({
			kind: "tool_completed",
			workflow: TEST_PROFILE.name,
			stage: "implementation",
			phase: "submission",
			tool: "workflow_submit_result",
			identities: { run: runId, worker: foreignContext.session_id },
			outcome: rejectionObserved ? "REJECTED" : "ACCEPTED",
			verdict: rejectionObserved ? "REJECT" : "FAIL",
			faultPoint: "validation",
		});
		recordScenarioEvent({
			kind: "stage_submitted",
			workflow: TEST_PROFILE.name,
			stage: "implementation",
			phase: "submission",
			identities: { run: runId, worker: foreignContext.session_id },
			outcome: rejectionObserved ? "REJECTED" : "ACCEPTED",
			verdict: rejectionObserved ? "REJECT" : "FAIL",
			faultPoint: "validation",
		});
		assert.equal(rejectedDetails.ok, false, JSON.stringify(rejectedDetails));
		assert.equal(rejectedDetails.code, "producer_authority_denied", JSON.stringify(rejectedDetails));
		assert.equal("receipt" in rejectedDetails, false, "foreign context must never receive a receipt");
		assert.equal(readFileSync(statePath, "utf8"), stateBefore, "foreign submission must not mutate canonical state");
		assert.deepEqual(publishedFiles(harness, runId), filesBefore, "foreign submission must not publish artifact or receipt files");
		await terminalWorker(harness, runId, worker);
	} finally {
		await harness.close();
	}
});
