import assert from "node:assert/strict";
import { test } from "node:test";

import { isProviderId, isWorkflowV2Digest } from "@andvl1/omp-workflows-core";

import {
	INTERNAL_PROVIDER_CATALOG,
	INTERNAL_PROVIDER_DESCRIPTOR,
	INTERNAL_PROVIDER_DESCRIPTOR_FINGERPRINT,
	INTERNAL_PROVIDER_ID,
} from "../src/provider.js";
import { OMP_INTERNAL_ACTIVATION_MARKER, OMP_INTERNAL_BUNDLE_ID } from "../src/identity.js";

test("internal provider identity is package-qualified and exact", () => {
	assert.equal(OMP_INTERNAL_BUNDLE_ID, "@andvl1/omp-workflows-internal");
	assert.equal(INTERNAL_PROVIDER_ID, OMP_INTERNAL_BUNDLE_ID);
	assert.equal(INTERNAL_PROVIDER_DESCRIPTOR.id, INTERNAL_PROVIDER_ID);
	assert.ok(isProviderId(INTERNAL_PROVIDER_ID));
	assert.equal(INTERNAL_PROVIDER_DESCRIPTOR.protocol_version, 2);
	assert.equal(OMP_INTERNAL_ACTIVATION_MARKER, "workspace:package.json+packages/core+packages/fullstack");
});

test("descriptor, catalog and executable identities carry complete fingerprints", () => {
	assert.ok(isWorkflowV2Digest(INTERNAL_PROVIDER_DESCRIPTOR_FINGERPRINT));
	assert.ok(isWorkflowV2Digest(INTERNAL_PROVIDER_DESCRIPTOR.catalog_content_digest));
	assert.ok(isWorkflowV2Digest(INTERNAL_PROVIDER_CATALOG.content_digest));
	assert.ok(isWorkflowV2Digest(INTERNAL_PROVIDER_DESCRIPTOR.executable_provenance.build_fingerprint));
	assert.ok(isWorkflowV2Digest(INTERNAL_PROVIDER_DESCRIPTOR.executable_provenance.runtime_fingerprint));
	for (const source of INTERNAL_PROVIDER_DESCRIPTOR.agent_sources) {
		assert.equal(source.provider_id, INTERNAL_PROVIDER_ID);
		assert.ok(isWorkflowV2Digest(source.source_fingerprint));
	}
});
