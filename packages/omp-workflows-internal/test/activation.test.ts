import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { detectWorkspaceMarkers } from "../src/activation.js";

function makeRoot({ packageJson = false, core = false, fullstack = false, tsFiles = false } = {}): string {
	const root = mkdtempSync(join(tmpdir(), "omp-internal-activation-"));
	if (packageJson) writeFileSync(join(root, "package.json"), "{}\n");
	if (core) mkdirSync(join(root, "packages", "core"), { recursive: true });
	if (fullstack) mkdirSync(join(root, "packages", "fullstack"), { recursive: true });
	if (tsFiles) mkdirSync(join(root, "src"), { recursive: true });
	if (tsFiles) writeFileSync(join(root, "src", "index.ts"), "export {};\n");
	return root;
}

test("all three markers present -> ok with the observed marker set", () => {
	const root = makeRoot({ packageJson: true, core: true, fullstack: true });
	const result = detectWorkspaceMarkers(root);
	assert.equal(result.ok, true);
	if (!result.ok) return;
	assert.deepEqual(
		result.markers.map((marker) => marker.name),
		["package.json", "packages/core", "packages/fullstack"],
	);
});

test("each missing marker alone fails closed with the typed missing list", () => {
	const cases: Array<[Parameters<typeof makeRoot>[0], string[]]> = [
		[{}, ["package.json", "packages/core", "packages/fullstack"]],
		[{ core: true, fullstack: true }, ["package.json"]],
		[{ packageJson: true, fullstack: true }, ["packages/core"]],
		[{ packageJson: true, core: true }, ["packages/fullstack"]],
	];
	for (const [shape, expectedMissing] of cases) {
		const result = detectWorkspaceMarkers(makeRoot(shape));
		assert.equal(result.ok, false);
		if (result.ok) continue;
		assert.equal(result.code, "activation_markers_missing");
		assert.deepEqual(
			result.missing.map((marker) => marker.name),
			expectedMissing,
		);
	}
});

test("detection never keys off .ts source files", () => {
	const result = detectWorkspaceMarkers(makeRoot({ tsFiles: true }));
	assert.equal(result.ok, false);
	if (!result.ok) assert.equal(result.code, "activation_markers_missing");
});

test("a package.json directory instead of file does not satisfy the marker", () => {
	const root = makeRoot({ core: true, fullstack: true });
	mkdirSync(join(root, "package.json"), { recursive: true });
	const result = detectWorkspaceMarkers(root);
	assert.equal(result.ok, false);
	if (!result.ok) assert.deepEqual(result.missing.map((m) => m.name), ["package.json"]);
});

test("symlinked markers count as missing (physical layout required)", () => {
	const realCore = mkdtempSync(join(tmpdir(), "omp-internal-core-real-"));
	const root = makeRoot({ packageJson: true, fullstack: true });
	symlinkSync(realCore, join(root, "packages", "core"), "dir");
	const result = detectWorkspaceMarkers(root);
	assert.equal(result.ok, false);
	if (!result.ok) {
		assert.equal(result.code, "activation_markers_missing");
		assert.deepEqual(result.missing.map((marker) => marker.name), ["packages/core"]);
	}
});
