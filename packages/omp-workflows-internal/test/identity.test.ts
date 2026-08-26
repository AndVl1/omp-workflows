import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
	OMP_INTERNAL_ACTIVATION_MARKER,
	OMP_INTERNAL_BUNDLE_ID,
	OMP_INTERNAL_HOST_RANGE,
	OMP_INTERNAL_OWNER_KIND,
	privateOmpOwnerForCwd,
} from "../src/identity.js";

test("frozen identity constants match the bundle contract exactly", () => {
	assert.equal(OMP_INTERNAL_BUNDLE_ID, "@andvl1/omp-workflows-internal");
	assert.equal(OMP_INTERNAL_OWNER_KIND, "private_omp");
	assert.equal(OMP_INTERNAL_ACTIVATION_MARKER, "workspace:package.json+packages/core+packages/fullstack");
	assert.equal(OMP_INTERNAL_HOST_RANGE, ">=17.3 <19");
});

test("privateOmpOwnerForCwd builds provenance from the resolved cwd", () => {
	const root = mkdtempSync(join(tmpdir(), "omp-internal-identity-"));
	const owner = privateOmpOwnerForCwd(root);
	assert.equal(owner.owner_id, OMP_INTERNAL_BUNDLE_ID);
	assert.equal(owner.bundle_id, OMP_INTERNAL_BUNDLE_ID);
	assert.equal(owner.provenance.package, OMP_INTERNAL_BUNDLE_ID);
	assert.equal(owner.provenance.entrypoint, "dist/index.js");
	assert.equal(owner.provenance.cwd, root);
	assert.equal(owner.provenance.config_path, join(root, ".omp", "team.config.json"));
});
