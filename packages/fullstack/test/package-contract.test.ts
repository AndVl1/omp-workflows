/**
 * Package contract test: the published manifest must declare a core peer
 * range that npm can actually satisfy with a compatible core.
 *
 * Regression: fullstack 0.17.x imports `defaultBudgetState`, introduced in
 * core 0.17.x, yet shipped `"@andvl1/omp-workflows-core": "*"` as the peer
 * range. A wildcard lets npm (and `omp plugin install`) resolve fullstack
 * 0.17.x against core 0.12.x, which does not export the symbol — the
 * upgrade breaks at import time. The peer range must be pinned to the same
 * minor line as fullstack itself.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const manifest = JSON.parse(readFileSync(resolve(here, "..", "package.json"), "utf8")) as {
	version: string;
	peerDependencies?: Record<string, string>;
};

const ownMinor = manifest.version.split(".").slice(0, 2).join(".");
const expectedCorePeer = `^${ownMinor}.0`;

test("fullstack: core peer range matches fullstack's own minor line and is not a wildcard", () => {
	const corePeer = manifest.peerDependencies?.["@andvl1/omp-workflows-core"];
	assert.ok(corePeer, "fullstack must declare @andvl1/omp-workflows-core as a peer dependency");
	assert.notEqual(
		corePeer,
		"*",
		"wildcard core peer lets npm resolve an incompatible core (e.g. 0.12.x) — pin to the same minor line",
	);
	assert.equal(
		corePeer,
		expectedCorePeer,
		`core peer must be ${expectedCorePeer} (same minor line as fullstack ${manifest.version})`,
	);
});

test("fullstack: pi-coding-agent peer stays a wildcard (extension API is unversioned)", () => {
	assert.equal(manifest.peerDependencies?.["@oh-my-pi/pi-coding-agent"], "*");
});
