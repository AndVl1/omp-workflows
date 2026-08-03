/**
 * Unit tests for the `before_agent_start` marker detector exported from
 * `packages/fullstack/src/index.ts`. The detector is a pure helper that
 * reads the marker envelope produced by the `/omp-model-roles
 * recommendations` custom command and builds a developer-attributed
 * `BeforeAgentStartEventResult`. We test the pure parts without
 * registering an extension.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
	RESEARCH_REQUEST_MARKER_START,
	RESEARCH_REQUEST_MARKER_END,
	extractPayloadBetweenMarkers,
	buildResearchRequestDeveloperInstruction,
} from "../src/before-agent-start-marker.js";

test("marker constants match the contract in architecture.json", () => {
	assert.equal(RESEARCH_REQUEST_MARKER_START, "<<<omp-model-roles-research-request>>>");
	assert.equal(RESEARCH_REQUEST_MARKER_END, "<<<omp-model-roles-research-request-end>>>");
});

test("extractPayloadBetweenMarkers returns the inner payload when both markers are present", () => {
	const text = [
		"<<<omp-model-roles-research-request>>>",
		"validate-report",
		"",
		"research-prompt",
		"<<<omp-model-roles-research-request-end>>>",
	].join("\n");
	const payload = extractPayloadBetweenMarkers(text);
	assert.equal(payload, "validate-report\n\nresearch-prompt");
});

test("extractPayloadBetweenMarkers returns null when the start marker is absent", () => {
	const text = "no marker here, just plain text";
	assert.equal(extractPayloadBetweenMarkers(text), null);
});

test("extractPayloadBetweenMarkers returns null when the end marker is absent", () => {
	const text = "<<<omp-model-roles-research-request>>>\ntruncated payload without an end";
	assert.equal(extractPayloadBetweenMarkers(text), null);
});

test("extractPayloadBetweenMarkers returns null when start and end markers are swapped", () => {
	const text = "<<<omp-model-roles-research-request-end>>>\n<<<omp-model-roles-research-request>>>";
	assert.equal(extractPayloadBetweenMarkers(text), null);
});

test("extractPayloadBetweenMarkers returns null for empty input", () => {
	assert.equal(extractPayloadBetweenMarkers(""), null);
});

test("extractPayloadBetweenMarkers returns null for non-string input", () => {
	// The detector guards against malformed events; non-string prompts must
	// not crash the hook and must not yield a payload.
	assert.equal(extractPayloadBetweenMarkers(undefined as unknown as string), null);
	assert.equal(extractPayloadBetweenMarkers(null as unknown as string), null);
	assert.equal(extractPayloadBetweenMarkers(42 as unknown as string), null);
});

test("extractPayloadBetweenMarkers does not strip a missing leading newline", () => {
	// Envelope without a newline immediately after START or before END —
	// the strip-once rule must leave the payload untouched.
	const text = `<<<omp-model-roles-research-request>>>body<<<omp-model-roles-research-request-end>>>`;
	assert.equal(extractPayloadBetweenMarkers(text), "body");
});

test("extractPayloadBetweenMarkers strips exactly one leading newline (not more)", () => {
	// `\\n\\nbody\\n\\n` → strip one from each side → `\\nbody\\n`.
	// The function only ever removes one newline per side; double-stripping
	// would re-introduce silent whitespace handling drift.
	const text = [
		"<<<omp-model-roles-research-request>>>",
		"",
		"body",
		"",
		"<<<omp-model-roles-research-request-end>>>",
	].join("\n");
	assert.equal(extractPayloadBetweenMarkers(text), "\nbody\n");
});

test("extractPayloadBetweenMarkers returns the first envelope when multiple appear in text", () => {
	// The detector takes the first START then the first END after it; any
	// trailing envelopes are opaque and outside the contract.
	const text = [
		"<<<omp-model-roles-research-request>>>",
		"first",
		"<<<omp-model-roles-research-request-end>>>",
		"noise",
		"<<<omp-model-roles-research-request>>>",
		"second",
		"<<<omp-model-roles-research-request-end>>>",
	].join("\n");
	assert.equal(extractPayloadBetweenMarkers(text), "first");
});

test("buildResearchRequestDeveloperInstruction references the 4 hard steps and the marker contract", () => {
	const instruction = buildResearchRequestDeveloperInstruction(14, null);
	assert.match(instruction, /Step 1/);
	assert.match(instruction, /Step 2/);
	assert.match(instruction, /Step 3/);
	assert.match(instruction, /Step 4/);
	assert.match(instruction, /tech-researcher/);
	assert.match(instruction, /ResearchRequest/);
	assert.match(instruction, /immutable inventory/);
	assert.match(instruction, /DEGRADED|degraded/i);
	assert.match(instruction, /attribution: ?"agent"/);
});

test("buildResearchRequestDeveloperInstruction forbids local analysis by the main agent", () => {
	// The contract (architecture.json prompt_delta_tech_researcher + full_hook_flow step 11)
	// requires the main LLM to delegate research to the tech-researcher subagent
	// instead of inspecting files, transcripts, or session state. Drift here would
	// silently re-introduce recommendations_live_5/6/7 failures (LLM ignores the
	// delegation when the text permits local fallback).
	const instruction = buildResearchRequestDeveloperInstruction(14, null);
	assert.match(instruction, /Do NOT inspect local files/i);
	assert.match(instruction, /do NOT run bash\/grep\/python/i);
	assert.match(instruction, /do NOT read transcripts/i);
	assert.match(instruction, /Your ONLY job is the research task/i);
});

test("buildResearchRequestDeveloperInstruction carries a concrete degraded-notice format", () => {
	// vp9-r7 — the assertion against /DEGRADED|degraded/i passes either case.
	// The contract specifies `> DEGRADED: <step> — <reason>`, so the instruction
	// must contain that literal marker.
	const instruction = buildResearchRequestDeveloperInstruction(14, null);
	assert.match(instruction, /> DEGRADED:/);
});


test("buildResearchRequestDeveloperInstruction parameterization is text-invariant for the 4-step contract", () => {
	// Architecture (api_contract.before_agent_start_marker_parameterization): the
	// body of the developer instruction is invariant — all 4 steps are identical for
	// any (roleCount, availableModelCount) — so the function only uses the
	// parameters as future hooks. Today: two different parameter combinations must
	// produce the same text. This guards against a regression that starts
	// interpolating the numbers into the body, which would re-introduce a hard-coded
	// `14` and break second-bundle parity.
	const baseline = buildResearchRequestDeveloperInstruction(14, null);
	const smallBundle = buildResearchRequestDeveloperInstruction(3, 0);
	const largeBundle = buildResearchRequestDeveloperInstruction(42, 123);
	const defaultParam = buildResearchRequestDeveloperInstruction(14);
	assert.equal(smallBundle, baseline, "roleCount=3, modelCount=0 must match roleCount=14, modelCount=null");
	assert.equal(largeBundle, baseline, "roleCount=42, modelCount=123 must match roleCount=14, modelCount=null");
	assert.equal(defaultParam, baseline, "omitting availableModelCount must match the explicit null");
	// And all four must still reference every Step + the marker contract.
	for (const [label, text] of [
		["baseline", baseline],
		["smallBundle", smallBundle],
		["largeBundle", largeBundle],
		["defaultParam", defaultParam],
	] as const) {
		assert.match(text, /Step 1/, `${label} missing Step 1`);
		assert.match(text, /Step 4/, `${label} missing Step 4`);
		assert.match(text, /tech-researcher/, `${label} missing tech-researcher`);
	}
});