import assert from "node:assert/strict";
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import { OMP_INTERNAL_BUNDLE_ID } from "../src/identity.js";

const here = dirname(fileURLToPath(import.meta.url));
const packageRoot = join(here, "..");

interface Manifest {
	name: string;
	version: string;
	private?: boolean;
	type?: string;
	main?: string;
	types?: string;
	exports?: Record<string, { types?: string; import?: string }>;
	omp?: { extensions?: string[] };
	files?: string[];
	peerDependencies?: Record<string, string>;
	engines?: { node?: string };
}

const manifest = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8")) as Manifest;

const coreManifest = JSON.parse(
	readFileSync(join(packageRoot, "..", "core", "package.json"), "utf8"),
) as { name: string; version: string };

test("manifest stays private and carries the frozen bundle id", () => {
	assert.equal(manifest.private, true, "private bundle must never be publishable");
	assert.equal(manifest.name, "@andvl1/omp-workflows-internal");
	assert.equal(manifest.name, OMP_INTERNAL_BUNDLE_ID, "npm name must equal the owner identity bundle_id");
	assert.match(manifest.version, /^\d+\.\d+\.\d+$/);
	assert.equal(manifest.type, "module");
});

test("entry metadata points at the built dist entry only", () => {
	assert.equal(manifest.main, "./dist/index.js");
	assert.equal(manifest.types, "./dist/index.d.ts");
	assert.deepEqual(manifest.exports, {
		".": { types: "./dist/index.d.ts", import: "./dist/index.js" },
	});
	assert.deepEqual(manifest.omp?.extensions, ["./dist/index.js"], "exactly one extension entry, from dist");
});

test("core peer range is pinned to core's own minor line, not a wildcard", () => {
	const corePeer = manifest.peerDependencies?.["@andvl1/omp-workflows-core"];
	assert.ok(corePeer, "must declare @andvl1/omp-workflows-core as a peer dependency");
	assert.notEqual(corePeer, "*", "wildcard core peer can resolve an incompatible engine");
	const coreMinor = coreManifest.version.split(".").slice(0, 2).join(".");
	assert.equal(corePeer, `^${coreMinor}.0`, `core peer must match the workspace core minor line (${coreManifest.version})`);
});

test("pi-coding-agent peer range matches the host integration contract", () => {
	// Install-time metadata only; runtime publication still requires explicit
	// launcher root, registry, runtime and authority inputs.
	assert.equal(manifest.peerDependencies?.["@oh-my-pi/pi-coding-agent"], ">=17.3 <19");
});

test("files allowlist ships the built entry plus every real asset directory", () => {
	const files = manifest.files ?? [];
	for (const required of ["dist", "agents", "workflows"]) {
		assert.ok(files.includes(required), `files must include '${required}'`);
	}
	for (const entry of files) {
		if (entry === "dist") continue; // build output, created by `npm run build`
		const path = join(packageRoot, entry);
		if (!existsSync(path)) continue; // drift reported separately (see qa-focused findings)
		assert.ok(statSync(path).isDirectory(), `files entry '${entry}' must be a directory when present`);
	}
	assert.ok(manifest.engines?.node?.startsWith(">="), "engines.node must declare a floor");
});
