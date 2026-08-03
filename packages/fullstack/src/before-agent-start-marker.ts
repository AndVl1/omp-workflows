/**
 * Pure helpers for the `before_agent_start` marker detector registered
 * from `packages/fullstack/src/index.ts`. The contract:
 *
 *   1. `/omp-model-roles recommendations` returns its research prompt
 *      wrapped in `<<<omp-model-roles-research-request>>> ... <<<omp-model-roles-research-request-end>>>`.
 *   2. The detector hook in `index.ts` reads `event.prompt`; if it
 *      contains the start marker it extracts the inner payload and emits
 *      a developer-attributed `BeforeAgentStartEventResult` whose
 *      content is the 4-step instruction produced by
 *      `buildResearchRequestDeveloperInstruction`.
 *   3. The marker envelope itself is opaque to OMP — `<<<...>>>` survives
 *      `input-controller.ts:665` (`text.trim()`) and is part of the
 *      user-visible transcript.
 *
 * These helpers are split into a separate module so they can be unit
 * tested without importing `@oh-my-pi/pi-coding-agent` or wiring an
 * extension API.
 */

export const RESEARCH_REQUEST_MARKER_START = "<<<omp-model-roles-research-request>>>";
export const RESEARCH_REQUEST_MARKER_END = "<<<omp-model-roles-research-request-end>>>";

/**
 * Return the inner payload of the marker envelope, or `null` if either
 * marker is missing or the envelope is malformed. The function uses a
 * linear scan: first occurrence of START, then first occurrence of END
 * strictly after START. The markers are not stripped from the user's
 * transcript (the caller treats the entire `text` as opaque).
 */
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
 */
export function buildResearchRequestDeveloperInstruction(): string {
	return [
		"You received a `<<<omp-model-roles-research-request>>>` marker in the user prompt. The marker wraps a validate-report plus a research contract that delegates model recommendations to the `tech-researcher` subagent. Follow the 4 hard steps below EXACTLY and in order. Do NOT inspect local files, do NOT run bash/grep/python, do NOT read transcripts, reports or session state. Your ONLY job is the research task below.",
		"Step 1: Call the `task` tool with `agent=\"tech-researcher\"` and the payload below. The payload is the inner content of the marker envelope (everything between the two `<<<omp-model-roles-research-request>>>` lines). Pass it verbatim as the `ResearchRequest`.",
		"Step 2: Wait for the subagent to finish. Its final message MUST be exactly one JSON object (no markdown wrapper) of kind `omp-model-role-recommendations` (schemaVersion 1).",
		"Step 3: Validate the JSON STRICTLY against the immutable inventory snapshot embedded in the payload. `kind` must be `omp-model-role-recommendations`, `schemaVersion` 1, `generatedAt`/`retrievedAt`/`publishedAt` must be ISO-8601, every `recommendation.role` must be in the roles list, every `modelSelector` must be present in `availableModels`, every recommendation must have at least one `benchmarkSource` with `url` (http/https), `title`, `retrievedAt`, and `caveat`. Duplicate roles and empty strings are invalid. Reject the entire response if any check fails.",
		"Step 4: Render a markdown table: `role | recommended model | fit | rationale | benchmark sources (with links)`. For `unavailableRoles` print a note. Print `warnings` as-is. If validation fails or the subagent errors, print a degraded notice (`> DEGRADED: <step> — <reason>`) and DO NOT fabricate recommendations.",
		"The hook that injected this message used `attribution: \"agent\"` (developer-priority), so these steps are not optional. Skipping them or substituting your own approach is a contract violation.",
	].join("\n");
}
