import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { open, realpath, stat } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import * as path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent/extensibility/extensions";

type EvidenceModel = { provider: string; id: string };
type EvidenceBase = {
	schema_version: 1;
	timestamp: number;
	native_session_id: string;
	session_directory: string;
	model: EvidenceModel;
};
type EvidenceRecord =
	| (EvidenceBase & { kind: "session_start" })
	| (EvidenceBase & { kind: "before_agent_start"; task_sha256: string | null })
	| (EvidenceBase & { kind: "message_end"; message: Record<string, unknown> })
	| (EvidenceBase & { kind: "agent_end" });

const EVIDENCE_FILENAME = "live-native-events.jsonl";
const WORKFLOW_RESOURCE_PATH = /^xd:\/\/workflow_[a-z_]+$/;
const PUBLIC_WORKFLOW_OPERATIONS: Readonly<Record<string, true>> = {
	workflow_prepare: true,
	workflow_status: true,
	workflow_instructions: true,
	workflow_begin: true,
	workflow_complete: true,
	workflow_checkpoint: true,
	workflow_checkpoint_ask: true,
	workflow_advance: true,
};

// Extension factories may be rebound for task sessions in the same host process.
// The first TUI session_start belongs to the visible root session; child session
// events must not be mixed into its receipt stream.
let rootSessionId: string | undefined;
let rootBinding: { promise: Promise<void> } | undefined;
let sessionDirectory: string | undefined;
let evidenceFile: FileHandle | undefined;
let writeQueue: Promise<void> = Promise.resolve();
let observerFailed = false;
type WorkflowOperationEvidence = { operation: string; rejected: boolean };
const pendingWorkflowResults = new Map<string, WorkflowOperationEvidence>();

function isRpcProbeInvocation(): boolean {
	const argv = process.argv;
	for (let index = 1; index < argv.length; index += 1) {
		if (argv[index] === "--mode=rpc") return true;
		if (argv[index] === "--mode" && argv[index + 1] === "rpc") return true;
	}
	return false;
}

function requiredString(value: unknown, field: string): string {
	if (typeof value !== "string" || value.length === 0) {
		throw new Error(`Live native evidence requires a non-empty ${field}`);
	}
	return value;
}

function nativeSessionId(ctx: ExtensionContext): string {
	return requiredString(ctx.sessionManager.getSessionId(), "native session id");
}

function workflowOperationForToolResult(toolName: string, input: Record<string, unknown>): string | null {
	if (Object.hasOwn(PUBLIC_WORKFLOW_OPERATIONS, toolName)) return toolName;
	if (toolName !== "write") return null;
	const resourcePath = input.path;
	if (typeof resourcePath !== "string" || !WORKFLOW_RESOURCE_PATH.test(resourcePath)) return null;
	const operation = resourcePath.slice("xd://".length);
	return Object.hasOwn(PUBLIC_WORKFLOW_OPERATIONS, operation) ? operation : null;
}

function modelIdentity(ctx: ExtensionContext): EvidenceModel {
	const model = ctx.model;
	if (!model) throw new Error("Live native evidence requires the current native model");
	return {
		provider: requiredString(model.provider, "native model provider"),
		id: requiredString(model.id, "native model id"),
	};
}

function isWithin(parent: string, candidate: string): boolean {
	const relative = path.relative(parent, candidate);
	return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

async function openOwnedEvidenceFile(ctx: ExtensionContext): Promise<{ handle: FileHandle; directory: string }> {
	const configuredDirectory = process.env.OMP_SESSION_DIR;
	if (!configuredDirectory || !path.isAbsolute(configuredDirectory)) {
		throw new Error("Live native evidence requires an absolute OMP_SESSION_DIR");
	}

	const [directory, projectDirectory] = await Promise.all([realpath(configuredDirectory), realpath(ctx.cwd)]);
	const directoryStat = await stat(directory);
	if (!directoryStat.isDirectory()) throw new Error("OMP_SESSION_DIR is not an existing directory");
	if (isWithin(projectDirectory, directory) || isWithin(directory, projectDirectory)) {
		throw new Error("OMP_SESSION_DIR must be separate from the project workspace");
	}
	if (typeof process.getuid === "function" && directoryStat.uid !== process.getuid()) {
		throw new Error("OMP_SESSION_DIR is not owned by the current user");
	}
	if ((directoryStat.mode & 0o022) !== 0) {
		throw new Error("OMP_SESSION_DIR must not be writable by group or other users");
	}
	if (typeof fsConstants.O_NOFOLLOW !== "number") {
		throw new Error("The host filesystem does not support safe evidence-file creation");
	}

	const target = path.join(directory, EVIDENCE_FILENAME);
	const handle = await open(
		target,
		fsConstants.O_WRONLY | fsConstants.O_APPEND | fsConstants.O_CREAT | fsConstants.O_NOFOLLOW,
		0o600,
	);
	try {
		const fileStat = await handle.stat();
		if (!fileStat.isFile() || fileStat.nlink !== 1 || (fileStat.mode & 0o077) !== 0) {
			throw new Error("Live native evidence target is not a private, session-owned regular file");
		}
		if (typeof process.getuid === "function" && fileStat.uid !== process.getuid()) {
			throw new Error("Live native evidence target is not owned by the current user");
		}
		if ((await realpath(target)) !== target) {
			throw new Error("Live native evidence target resolves outside OMP_SESSION_DIR");
		}
	} catch (error) {
		await handle.close();
		throw error;
	}
	return { handle, directory };
}

function enqueueRecord(record: EvidenceRecord): Promise<void> {
	const nextWrite = writeQueue.then(async () => {
		if (!evidenceFile) throw new Error("Live native evidence writer was not initialized");
		await evidenceFile.writeFile(`${JSON.stringify(record)}\n`);
		await evidenceFile.sync();
	});
	writeQueue = nextWrite;
	return nextWrite;
}

function evidenceBase(ctx: ExtensionContext, timestamp: number): EvidenceBase | null {
	if (rootSessionId === undefined) return null;
	const currentSessionId = nativeSessionId(ctx);
	if (currentSessionId !== rootSessionId) return null;
	if (!sessionDirectory) throw new Error("Live native evidence session is not initialized");
	return {
		schema_version: 1,
		timestamp,
		native_session_id: currentSessionId,
		session_directory: sessionDirectory,
		model: modelIdentity(ctx),
	};
}

function objectRecord(value: unknown, field: string): Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new Error(`Live native evidence requires a structured ${field}`);
	}
	return value as Record<string, unknown>;
}

function finiteNumber(value: unknown, field: string): number {
	if (typeof value !== "number" || !Number.isFinite(value)) {
		throw new Error(`Live native evidence requires native numeric ${field}`);
	}
	return value;
}

function structuredWorkflowResultOk(value: unknown): boolean | null {
	if (typeof value !== "object" || value === null || Array.isArray(value) || !Object.hasOwn(value, "ok")) return null;
	const result = value as Record<string, unknown>;
	return typeof result.ok === "boolean" ? result.ok : null;
}

function workflowResultIsRejected(details: unknown, content: readonly unknown[]): boolean {
	if (structuredWorkflowResultOk(details) === false) return true;
	for (const rawBlock of content) {
		if (typeof rawBlock !== "object" || rawBlock === null || Array.isArray(rawBlock)) continue;
		const block = rawBlock as Record<string, unknown>;
		if (block.type !== "text" || typeof block.text !== "string") continue;
		let parsed: unknown;
		try {
			parsed = JSON.parse(block.text) as unknown;
		} catch {
			continue;
		}
		if (structuredWorkflowResultOk(parsed) === false) return true;
	}
	return false;
}

function copyUsage(value: unknown): Record<string, number> {
	const source = objectRecord(value, "assistant usage");
	return {
		input: finiteNumber(source.input, "usage.input"),
		output: finiteNumber(source.output, "usage.output"),
		totalTokens: finiteNumber(source.totalTokens, "usage.totalTokens"),
	};
}

function narrowAssistantMessage(message: {
	provider: string;
	model: string;
	api: string;
	usage: unknown;
	timestamp: number;
	stopReason: string;
	errorMessage?: unknown;
	content: readonly unknown[];
}): Record<string, unknown> {
	const providerError = typeof message.errorMessage === "string" && message.errorMessage.length > 0;
	if (providerError || ["error", "aborted", "length"].includes(message.stopReason)) {
		// Native failures may have no generated tokens or successful API metadata.
		// Preserve the actual failure flag, never its potentially sensitive detail.
		return {
			role: "assistant",
			provider: message.provider,
			model: message.model,
			api: message.api,
			timestamp: message.timestamp,
			stopReason: message.stopReason,
			provider_error: providerError,
			content: [],
		};
	}
	const content: Array<Record<string, string>> = [];
	for (const rawPart of message.content) {
		const part = objectRecord(rawPart, "assistant content part");
		if (part.type === "text" && typeof part.text === "string") {
			content.push({ type: "text", text: part.text });
			continue;
		}
		if (part.type !== "toolCall") continue;

		const id = requiredString(part.id, "native tool-call id");
		const name = requiredString(part.name, "native tool-call name");
		const toolCall: Record<string, string> = { type: "toolCall", id, name };
		const argumentsRecord = objectRecord(part.arguments, "native tool-call arguments");
		const resourcePath = argumentsRecord.path;
		if (typeof resourcePath === "string" && WORKFLOW_RESOURCE_PATH.test(resourcePath)) {
			toolCall.resourcePath = resourcePath;
		}
		content.push(toolCall);
	}

	return {
		role: "assistant",
		provider: requiredString(message.provider, "assistant provider"),
		model: requiredString(message.model, "assistant model id"),
		api: requiredString(message.api, "assistant API"),
		usage: copyUsage(message.usage),
		timestamp: finiteNumber(message.timestamp, "assistant timestamp"),
		stopReason: requiredString(message.stopReason, "assistant stop reason"),
		provider_error: providerError,
		content,
	};
}

function narrowToolResultMessage(
	message: {
		role: "toolResult";
		isError: boolean;
		toolName: string;
		toolCallId: string;
		timestamp: number;
	},
	workflowEvidence?: WorkflowOperationEvidence,
): Record<string, unknown> {
	if (typeof message.isError !== "boolean") throw new Error("Live native evidence requires the native tool error flag");
	return {
		role: "toolResult",
		isError: message.isError,
		toolName: requiredString(message.toolName, "native tool name"),
		toolCallId: requiredString(message.toolCallId, "native tool-call id"),
		timestamp: finiteNumber(message.timestamp, "tool-result timestamp"),
		...(workflowEvidence === undefined ? {} : {
			workflow_operation: workflowEvidence.operation,
			workflow_error: workflowEvidence.rejected,
		}),
	};
}

function taskSha256(prompt: string): string | null {
	const taskHeading = "### Task\n";
	const lifecycleHeading = "\n\n### Lifecycle request\n";
	const taskHeadingIndex = prompt.indexOf(taskHeading);
	if (taskHeadingIndex < 0) return null;
	const taskStart = taskHeadingIndex + taskHeading.length;
	const taskEnd = prompt.indexOf(lifecycleHeading, taskStart);
	if (taskEnd < 0) return null;
	return createHash("sha256").update(prompt.slice(taskStart, taskEnd), "utf8").digest("hex");
}

export default function liveNativeEvidence(pi: ExtensionAPI): void {
	// RPC readiness/command-inventory probes load project extensions too. Do not
	// register handlers there; other modes are gated by the native context mode.
	if (isRpcProbeInvocation()) return;

	pi.on("session_start", async (_event, ctx) => {
		if (ctx.mode !== "tui") return;
		const timestamp = Date.now();
		const sessionId = nativeSessionId(ctx);
		if (rootSessionId !== undefined) return;
		if (rootBinding) {
			await rootBinding.promise;
			return;
		}

		const promise = (async () => {
			const opened = await openOwnedEvidenceFile(ctx);
			evidenceFile = opened.handle;
			sessionDirectory = opened.directory;
			const startupRecord: EvidenceRecord = {
				schema_version: 1,
				kind: "session_start",
				timestamp,
				native_session_id: sessionId,
				session_directory: opened.directory,
				model: modelIdentity(ctx),
			};
			await enqueueRecord(startupRecord);
			rootSessionId = sessionId;
		})();
		rootBinding = { promise };
		await promise;
	});

	pi.on("before_agent_start", async (event, ctx) => {
		if (ctx.mode !== "tui") return;
		const timestamp = Date.now();
		try {
			const base = evidenceBase(ctx, timestamp);
			if (!base) return;
			await enqueueRecord({
				...base,
				kind: "before_agent_start",
				task_sha256: taskSha256(event.prompt),
			});
		} catch (error) {
			observerFailed = true;
			throw error;
		}
	});

	pi.on("tool_result", (event, ctx) => {
		if (ctx.mode !== "tui" || rootSessionId === undefined || nativeSessionId(ctx) !== rootSessionId) return;
		const toolCallId = event.toolCallId;
		pendingWorkflowResults.delete(toolCallId);
		const operation = workflowOperationForToolResult(event.toolName, event.input);
		if (operation === null) return;
		pendingWorkflowResults.set(toolCallId, {
			operation,
			rejected: workflowResultIsRejected(event.details, event.content),
		});
	});

	pi.on("message_end", async (event, ctx) => {
		if (ctx.mode !== "tui") return;
		try {
			const base = evidenceBase(ctx, Date.now());
			if (!base) return;
			if (event.message.role === "assistant") {
				await enqueueRecord({
					...base,
					kind: "message_end",
					message: narrowAssistantMessage(event.message),
				});
			} else if (event.message.role === "toolResult") {
				const toolCallId = event.message.toolCallId;
				const workflowEvidence = pendingWorkflowResults.get(toolCallId);
				pendingWorkflowResults.delete(toolCallId);
				await enqueueRecord({
					...base,
					kind: "message_end",
					message: narrowToolResultMessage(event.message, workflowEvidence),
				});
			}
		} catch (error) {
			// A host-reported hook error must not disappear behind a later end
			// marker and turn incomplete message evidence into a false PASS.
			observerFailed = true;
			throw error;
		}
	});

	pi.on("agent_end", async (event, ctx) => {
		if (ctx.mode !== "tui" || observerFailed) return;
		const base = evidenceBase(ctx, Date.now());
		if (!base) return;
		// An automatic continuation is not a terminal receipt for the submitted turn.
		if (event.willContinue === true) return;
		await enqueueRecord({ ...base, kind: "agent_end" });
	});
}
