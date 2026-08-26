import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
	claimWorkflowOwners,
	resetWorkflowOwners,
	workflowOwnerFor,
	type WorkflowCapability,
} from "@andvl1/omp-workflows-core";

import { ensureEngineActivation } from "../src/index.js";
import { OMP_INTERNAL_ACTIVATION_MARKER, OMP_INTERNAL_BUNDLE_ID, privateOmpOwnerForCwd } from "../src/identity.js";

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

test("re-claiming with the same fingerprint is idempotent at the claim API level", () => {
	resetWorkflowOwners();
	const root = markedRoot();
	const owner = privateOmpOwnerForCwd(root);

	const first = claimWorkflowOwners(root, ALL_CAPABILITIES, owner);
	assert.equal(first.ok, true);
	if (!first.ok) return;
	assert.equal(first.idempotent, false, "first claim is a fresh registration");

	const second = claimWorkflowOwners(root, ALL_CAPABILITIES, privateOmpOwnerForCwd(root));
	assert.equal(second.ok, true, "same fingerprint must re-claim cleanly");
	if (!second.ok) return;
	assert.equal(second.idempotent, true, "repeat claim must be flagged idempotent");
	assert.equal(second.claim.fingerprint, first.claim.fingerprint, "fingerprint stable across claims");
	assert.equal(workflowOwnerFor(root, "workflow_registration")?.owner.owner_id, OMP_INTERNAL_BUNDLE_ID);
});

test("a differing fingerprint under the same bundle id cannot re-claim a held capability", () => {
	resetWorkflowOwners();
	const root = markedRoot();
	const mutated = {
		...privateOmpOwnerForCwd(root),
		activation_marker: "workspace:something-else",
	};
	const result = claimWorkflowOwners(root, ALL_CAPABILITIES, privateOmpOwnerForCwd(root));
	assert.equal(result.ok, true);

	const conflict = claimWorkflowOwners(root, ALL_CAPABILITIES, mutated);
	assert.equal(conflict.ok, false, "mutated identity must not re-claim held capabilities");
	if (!conflict.ok) assert.equal(conflict.code, "owner_conflict");
	for (const capability of ALL_CAPABILITIES) {
		assert.equal(
			workflowOwnerFor(root, capability)?.owner.activation_marker,
			OMP_INTERNAL_ACTIVATION_MARKER,
			`${capability} keeps the original frozen identity`,
		);
	}
});

test("foreign-first order fails the whole bundle closed before any side effect", () => {
	resetWorkflowOwners();
	const root = markedRoot();
	const foreign = {
		owner_id: "foreign-bundle",
		bundle_id: "foreign-bundle",
		owner_kind: "fullstack",
		activation_marker: "omp-fullstack",
		host_range: ">=17.3 <19",
		provenance: {
			package: "foreign-bundle",
			entrypoint: "dist/index.js",
			cwd: root,
			config_path: join(root, ".omp", "team.config.json"),
		},
	};
	const taken = claimWorkflowOwners(root, ["config_writer"], foreign);
	assert.equal(taken.ok, true);

	const attempted = claimWorkflowOwners(root, ALL_CAPABILITIES, privateOmpOwnerForCwd(root));
	assert.equal(attempted.ok, false);
	if (!attempted.ok) assert.equal(attempted.code, "owner_conflict");
	for (const capability of ALL_CAPABILITIES) {
		const holder = capability === "config_writer" ? "foreign-bundle" : undefined;
		assert.equal(workflowOwnerFor(root, capability)?.owner.owner_id ?? undefined, holder);
	}
});

test("ensureEngineActivation refuses a .ts-only workspace before any claim (entry layer)", () => {
	resetWorkflowOwners();
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
	for (const capability of ALL_CAPABILITIES) {
		assert.equal(workflowOwnerFor(root, capability), undefined, `${capability} must stay unclaimed`);
	}
});
