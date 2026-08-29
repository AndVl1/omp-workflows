import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import {
	computeDescriptorFingerprint,
	isProviderId,
	isWorkflowV2Digest,
} from "@andvl1/omp-workflows-core";

import {
	INTERNAL_PROVIDER_CATALOG,
	INTERNAL_PROVIDER_DESCRIPTOR,
	INTERNAL_PROVIDER_DESCRIPTOR_FINGERPRINT,
} from "../src/provider.js";

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

const agentNames = INTERNAL_PROVIDER_DESCRIPTOR.agent_sources.flatMap((source) => [...source.registered_names]);

test("agent assets exactly match the provider-qualified descriptor source set", () => {
	const files = readdirSync(join(packageRoot, "agents")).filter((name) => name.endsWith(".md"));
	assert.deepEqual(
		files.map((name) => name.replace(/\.md$/, "")).sort(),
		[...agentNames].sort(),
	);
	for (const source of INTERNAL_PROVIDER_DESCRIPTOR.agent_sources) {
		assert.equal(source.provider_id, INTERNAL_PROVIDER_DESCRIPTOR.id);
		assert.equal(source.registered_names.length, 1);
		assert.ok(isWorkflowV2Digest(source.source_fingerprint));
	}
	assert.equal(new Set(agentNames).size, agentNames.length, "source registered names must be unique");
});

test("agent files retain their exact omp-* identity and frontmatter", () => {
	for (const agent of agentNames) {
		assert.match(agent, /^omp-[a-z0-9-]+$/);
		const raw = readFileSync(join(packageRoot, "agents", `${agent}.md`), "utf8");
		const frontmatter = raw.split("---")[1] ?? "";
		assert.ok(frontmatter.includes(`name: ${agent}\n`), `${agent}: missing name`);
		for (const key of ["model:", "thinkingLevel:", "description:", "tools:"]) {
			assert.ok(frontmatter.includes(key), `${agent}: missing frontmatter key`);
		}
		assert.ok(raw.split("\n").length < 60, `${agent}: expected a concise asset`);
	}
});

test("descriptor and catalog expose exact immutable v2 identities", () => {
	assert.equal(INTERNAL_PROVIDER_DESCRIPTOR.id, "@andvl1/omp-workflows-internal");
	assert.equal(INTERNAL_PROVIDER_DESCRIPTOR.protocol_version, 2);
	assert.ok(isProviderId(INTERNAL_PROVIDER_DESCRIPTOR.id));
	assert.ok(isWorkflowV2Digest(INTERNAL_PROVIDER_DESCRIPTOR.catalog_content_digest));
	assert.ok(isWorkflowV2Digest(INTERNAL_PROVIDER_CATALOG.content_digest));
	assert.equal(
		INTERNAL_PROVIDER_DESCRIPTOR.catalog_content_digest,
		INTERNAL_PROVIDER_CATALOG.content_digest,
	);
	assert.equal(
		INTERNAL_PROVIDER_DESCRIPTOR_FINGERPRINT,
		computeDescriptorFingerprint(INTERNAL_PROVIDER_DESCRIPTOR),
	);
	assert.deepEqual(
		INTERNAL_PROVIDER_CATALOG.profiles.map((entry) => entry.identity.id),
		["omp-feature", "omp-validate"],
	);
	for (const entry of INTERNAL_PROVIDER_CATALOG.profiles) {
		assert.equal(entry.identity.id, entry.profile.name);
		assert.ok(isWorkflowV2Digest(entry.identity.fingerprint));
	}
});
