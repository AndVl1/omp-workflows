import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
	type WorkflowCapability,
	type WorkflowOwnerIdentity,
} from "@andvl1/omp-workflows-core";
import { openWorkflowActivation, releaseWorkflowOwners } from "@andvl1/omp-workflows-core/registry";

import { ensureEngineActivation } from "../src/index.js";
import { OMP_INTERNAL_BUNDLE_ID, privateOmpOwnerForCwd } from "../src/identity.js";

const ALL_CAPABILITIES: WorkflowCapability[] = ["workflow_registration", "workflow_tools", "config_writer"];

function markedRoot(): string {
	const root = mkdtempSync(join(tmpdir(), "omp-internal-qa-owner-marked-"));
	writeFileSync(join(root, "package.json"), "{}\n");
	mkdirSync(join(root, "packages", "core"), { recursive: true });
	mkdirSync(join(root, "packages", "fullstack"), { recursive: true });
	return root;
}

function tsOnlyRoot(): string {
	const root = mkdtempSync(join(tmpdir(), "omp-internal-qa-owner-tsonly-"));
	mkdirSync(join(root, "src"), { recursive: true });
	writeFileSync(join(root, "src", "index.ts"), "export {};\n");
	return root;
}

function openInternalActivation(root: string, capabilities: readonly WorkflowCapability[], owner = privateOmpOwnerForCwd(root)) {
	return openWorkflowActivation(root, capabilities, owner);
}

const FOREIGN_IDENTITY: WorkflowOwnerIdentity = {
	owner_id: "foreign-bundle",
	bundle_id: "foreign-bundle",
	owner_kind: "fullstack",
	activation_marker: "omp-fullstack",
	host_range: ">=17.3 <19",
	activation: {
		marker_id: "omp-fullstack",
		required: [
			{ path: "package.json", kind: "file" },
			{ path: "packages/core", kind: "directory" },
			{ path: "packages/fullstack", kind: "directory" },
		],
	},
	provenance: {
		package: "foreign-bundle",
		entrypoint: "dist/index.js",
		cwd: "",
	},
};

test("re-claiming with the same fingerprint is idempotent at the claim API level", () => {
	const root = markedRoot();

	const first = openInternalActivation(root, ALL_CAPABILITIES);
	assert.equal(first.ok, true);
	if (!first.ok) return;
	const second = openInternalActivation(root, ALL_CAPABILITIES);
	try {
		assert.equal(first.idempotent, false, "first claim is a fresh registration");
		assert.equal(second.ok, true, "same fingerprint must re-claim cleanly");
		if (!second.ok) return;
		assert.equal(second.idempotent, true, "repeat claim must be flagged idempotent");
		assert.equal(second.claim.fingerprint, first.claim.fingerprint, "fingerprint stable across claims");
		assert.equal(first.claim.owner.owner_id, OMP_INTERNAL_BUNDLE_ID);
	} finally {
		releaseWorkflowOwners(first.release_token, first.leased_capabilities);
		if (second.ok && second.leased_capabilities.length > 0) releaseWorkflowOwners(second.release_token, second.leased_capabilities);
	}
});

test("a differing fingerprint under the same bundle id cannot re-claim a held capability", () => {
	const root = markedRoot();
	const owner = privateOmpOwnerForCwd(root);
	const first = openInternalActivation(root, ALL_CAPABILITIES, owner);
	assert.equal(first.ok, true);
	if (!first.ok) return;

	try {
		const mutated = { ...owner, host_range: ">=17.4 <19" };
		const conflict = openInternalActivation(root, ALL_CAPABILITIES, mutated);
		assert.equal(conflict.ok, false, "mutated identity must not re-claim held capabilities");
		if (!conflict.ok) assert.equal(conflict.code, "owner_conflict");
	} finally {
		releaseWorkflowOwners(first.release_token, first.leased_capabilities);
	}
});

test("foreign-first order fails the whole bundle closed before any side effect", () => {
	const root = markedRoot();
	const foreign = openWorkflowActivation(root, ["workflow_registration", "config_writer"], {
		...FOREIGN_IDENTITY,
		provenance: { ...FOREIGN_IDENTITY.provenance, cwd: root, config_path: join(root, ".omp", "team.config.json") },
	});
	assert.equal(foreign.ok, true);
	if (!foreign.ok) return;

	try {
		const attempted = openInternalActivation(root, ALL_CAPABILITIES);
		assert.equal(attempted.ok, false);
		if (!attempted.ok) assert.equal(attempted.code, "owner_conflict");
		assert.equal(foreign.claim.owner.owner_id, "foreign-bundle");
	} finally {
		releaseWorkflowOwners(foreign.release_token, foreign.leased_capabilities);
	}
});

test("ensureEngineActivation refuses a .ts-only workspace before any claim (entry layer)", () => {
	const root = tsOnlyRoot();
	const outcome = ensureEngineActivation({} as never, root);
	assert.equal(outcome.ok, false);
	if (outcome.ok) return;
	assert.equal(outcome.code, "activation_markers_missing");
	assert.deepEqual(outcome.missing, [
		join(root, "package.json"),
		join(root, "packages", "core"),
		join(root, "packages", "fullstack"),
	]);
});
