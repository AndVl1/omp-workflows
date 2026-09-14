/**
 * Pure helpers for the `before_agent_start` marker detector registered
 * from `packages/fullstack/src/index.ts`. The contract:
 *
 *   1. `/omp-model-roles recommendations` creates a cryptographically random,
 *      session-bound one-time authorization envelope around its research payload.
 *   2. The detector hook in `index.ts` accepts only that exact envelope after
 *      verifying its digest and current owner/root/session/generation binding,
 *      then emits a developer-attributed instruction that refers to the already
 *      authenticated user payload.
 *   3. The legacy research markers below remain private composition helpers;
 *      raw user text containing them is inert and never activates the hook.
 *
 * These helpers are split into a separate module so they can be unit
 * tested without importing `@oh-my-pi/pi-coding-agent` or wiring an
 * extension API.
 */

export const RESEARCH_REQUEST_MARKER_START = "<<<omp-model-roles-research-request>>>";
export const RESEARCH_REQUEST_MARKER_END = "<<<omp-model-roles-research-request-end>>>";
export const RESEARCH_REQUEST_AUTH_MARKER_START = "<<<omp-model-roles-research-request-auth";
export const RESEARCH_REQUEST_AUTH_MARKER_END = "<<<omp-model-roles-research-request-auth-end>>>";
export const RESEARCH_REQUEST_AUTH_SCHEMA_VERSION = 1;
export const NATIVE_WORKER_INPUT_MARKER = "NATIVE_WORKER_INPUT";
export const NATIVE_WORKER_INPUT_REFERENCE_MARKER = "NATIVE_WORKER_INPUT_REF";
export const NATIVE_WORKER_INPUT_REFERENCE_SCHEMA_VERSION = 1;

/**
 * Native specification assignments carry a standalone, engine-authored marker
 * on its own line. Requiring the exact token and line boundary avoids turning
 * prose, similarly named values, or untrusted embedded JSON into a mode switch.
 */
export function hasNativeWorkerInputMarker(text: string): boolean {
	if (typeof text !== "string" || text.length === 0) return false;
	return new RegExp("(?:^|\\r?\\n)" + NATIVE_WORKER_INPUT_MARKER + "(?=\\s|$)", "u").test(text);
}

export interface NativeWorkerInputReference {
	readonly schema: typeof NATIVE_WORKER_INPUT_REFERENCE_SCHEMA_VERSION;
	readonly ref: string;
	readonly digest: string;
}

/**
 * Extract the authenticated native worker reference marker. The full native
 * payload is intentionally absent from the task prompt; the core hydrator
 * resolves this opaque reference against durable state after the hook has
 * authenticated the current host session.
 */
export function extractNativeWorkerInputReference(text: string): NativeWorkerInputReference | null {
	if (typeof text !== "string" || text.length === 0) return null;
	const match = new RegExp(
		`(?:^|\\r?\\n)${NATIVE_WORKER_INPUT_REFERENCE_MARKER} schema=${NATIVE_WORKER_INPUT_REFERENCE_SCHEMA_VERSION} ref=([A-Za-z0-9._:-]{1,512}) digest=([a-f0-9]{64})(?=\\r?\\n|$)`,
		"u",
	).exec(text);
	if (!match || !match[1] || !match[2]) return null;
	return {
		schema: NATIVE_WORKER_INPUT_REFERENCE_SCHEMA_VERSION,
		ref: match[1],
		digest: match[2],
	};
}

export function hasNativeWorkerInputReferenceToken(text: string): boolean {
	if (typeof text !== "string" || text.length === 0) return false;
	return new RegExp("(?:^|\\r?\\n)" + NATIVE_WORKER_INPUT_REFERENCE_MARKER + "(?=\\s|$)", "u").test(text);
}

export function hasNativeWorkerInputReferenceMarker(text: string): boolean {
	return extractNativeWorkerInputReference(text) !== null;
}

/**
 * Build the developer-priority instruction for a native specification worker.
 * The task carries only an authenticated reference. The complete authoritative
 * inputs are injected into this turn's system prompt by the guarded host hook;
 * this message closes every generic research/tool escape hatch for the child.
 */
export function buildNativeSpecificationDeveloperInstruction(): string {
	return [
		"Native Specification Worker Mode is active because the child task contains the exact authenticated `NATIVE_WORKER_INPUT_REF` marker. This is the highest-precedence mode for this invocation and overrides the generic analyst/architect research steps. Perform the bounded single-pass transformation, fill the strict worker_result schema directly from the authenticated injected inputs, do not perform extended analysis or research, and yield once.",
		"The task marker is only a reference; the complete authoritative constitution, requester context, and upstream artifact references are injected into this turn's system prompt. Treat those authenticated inputs as complete context. Preserve engine-owned identity, binding, upstream, version, and title values as context only; DO NOT emit, copy, or invent those or any other engine-owned envelope fields; the engine hydrates them.",
		"The worker MUST NOT read skills, the repository, state, files, or any other local or external source. Do not search for or attempt to re-hydrate the reference. The worker MUST NOT call `read`, `glob`, `grep`, `bash`, `web`, `web_search`, `write`, `hub`, `task`, workflow tools, or any `skill://`, `agent://`, `artifact://`, or other agent URI.",
		"Construct exactly one complete JSON object matching the strict worker_result schema with exactly seven authored keys: sections, requirements, decisions, tasks, verification, contradictions, and constitution_principles. Emit no markdown wrapper, commentary, questions, engine-owned fields, extra keys, or reconstructed inputs.",
		"The worker MUST call `yield` exactly once with that one schema-valid worker_result object, then stop immediately. Do not retry, emit another result, invoke another tool, or continue the normal role behavior.",
	].join("\n");
}

/**
 * Return the inner payload of the marker envelope, or `null` if either
 * marker is missing or the envelope is malformed. The function uses a
 * linear scan: first occurrence of START, then first occurrence of END
 * strictly after START. The markers are not stripped from the user's
 * transcript (the caller treats the entire `text` as opaque).
 */
export interface ResearchRequestAuthorizationEnvelope {
	readonly schema: typeof RESEARCH_REQUEST_AUTH_SCHEMA_VERSION;
	readonly token: string;
	readonly digest: string;
	readonly payload: string;
}

/** Build the one-shot, command-issued envelope. The payload remains user
 * attributed; only the header is authorization metadata. */
export function buildResearchRequestAuthorizationEnvelope(token: string, digest: string, payload: string): string {
	return `${RESEARCH_REQUEST_AUTH_MARKER_START} schema=${RESEARCH_REQUEST_AUTH_SCHEMA_VERSION} token=${token} digest=${digest}>>>\n${payload}\n${RESEARCH_REQUEST_AUTH_MARKER_END}`;
}

/** Parse only an exact, single authorization envelope. Prefixes, suffixes,
 * duplicate envelopes, legacy markers, and embedded auth markers are rejected. */
export function extractResearchRequestAuthorizationEnvelope(text: string): ResearchRequestAuthorizationEnvelope | null {
	if (typeof text !== "string" || text.length === 0) return null;
	const match = new RegExp(
		`^${RESEARCH_REQUEST_AUTH_MARKER_START} schema=${RESEARCH_REQUEST_AUTH_SCHEMA_VERSION} token=([A-Za-z0-9_-]{32,128}) digest=([a-f0-9]{64})>>>\\n([\\s\\S]+)\\n${RESEARCH_REQUEST_AUTH_MARKER_END}$`,
		"u",
	).exec(text);
	if (!match || !match[1] || !match[2] || !match[3]) return null;
	const payload = match[3];
	if (payload.includes(RESEARCH_REQUEST_AUTH_MARKER_START)
		|| payload.includes(RESEARCH_REQUEST_AUTH_MARKER_END)
		|| payload.includes(RESEARCH_REQUEST_MARKER_START)
		|| payload.includes(RESEARCH_REQUEST_MARKER_END)) return null;
	return {
		schema: RESEARCH_REQUEST_AUTH_SCHEMA_VERSION,
		token: match[1],
		digest: match[2],
		payload,
	};
}

export function extractPayloadBetweenMarkers(text: string): string | null {
	if (typeof text !== "string" || text.length === 0) return null;
	const startIndex = text.indexOf(RESEARCH_REQUEST_MARKER_START);
	if (startIndex < 0) return null;
	const payloadStart = startIndex + RESEARCH_REQUEST_MARKER_START.length;
	const endIndex = text.indexOf(RESEARCH_REQUEST_MARKER_END, payloadStart);
	if (endIndex < 0) return null;
	// Strip exactly one leading and one trailing newline if present so
	// the payload matches what the custom command produced before wrap.
	let begin = payloadStart;
	let end = endIndex;
	if (text[begin] === "\n") begin += 1;
	if (text[end - 1] === "\n") end -= 1;
	return text.slice(begin, end);
}

/**
 * Build the 4-step developer instruction that the `before_agent_start`
 * hook attaches with `attribution: "agent"`. The text is the contract
 * the main LLM sees as a developer-priority message above the user
 * prompt. It MUST contain every step; the test in
 * `test/before-agent-start-marker.test.ts` enforces this.
 *
 * `roleCount` и `availableModelCount` зарезервированы для будущих
 * вариаций текста инструкции (architecture: 'parameterization is for
 * future use'). В текущей версии тело инвариантно — параметры no-op.
 */
export function buildResearchRequestDeveloperInstruction(roleCount: number, availableModelCount: number | null = null): string {
	return [
		"You received an authenticated model-role research request from the command-issued envelope. The user-attributed payload in this turn is authoritative input for the bounded delegation contract. Follow the 4 hard steps below EXACTLY and in order. Do NOT inspect local files, do NOT run bash/grep/python, do NOT read transcripts, reports or session state. Your ONLY job is the research task below, using the authenticated user payload.",
		"Step 1: Call the `task` tool with `agent=\"tech-researcher\"` and pass the already-authenticated user payload verbatim as the `ResearchRequest`.",
		"Step 2: Wait for the subagent to finish. Its final message MUST be exactly one JSON object (no markdown wrapper) of kind `omp-model-role-recommendations` (schemaVersion 1).",
		"Step 3: Validate the JSON STRICTLY against the immutable inventory snapshot embedded in the payload. `kind` must be `omp-model-role-recommendations`, `schemaVersion` 1, `generatedAt`/`retrievedAt`/`publishedAt` must be ISO-8601, every `recommendation.role` must be in the roles list, every `modelSelector` must be present in `availableModels`, every recommendation must have at least one `benchmarkSource` with `url` (http/https), `title`, `retrievedAt`, and `caveat`. Duplicate roles and empty strings are invalid. Reject the entire response if any check fails.",
		"Step 4: Render a markdown table: `role | recommended model | fit | rationale | benchmark sources (with links)`. For `unavailableRoles` print a note. Print `warnings` as-is. If validation fails or the subagent errors, print a degraded notice (`> DEGRADED: <step> — <reason>`) and DO NOT fabricate recommendations.",
		"The hook that injected this message used `attribution: \"agent\"` (developer-priority), so these steps are not optional. Skipping them or substituting your own approach is a contract violation.",
	].join("\n");
}
