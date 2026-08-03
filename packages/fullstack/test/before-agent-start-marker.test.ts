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

test("buildResearchRequestDeveloperInstruction references the 4 hard steps and the marker contract", () => {
	const instruction = buildResearchRequestDeveloperInstruction();
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
