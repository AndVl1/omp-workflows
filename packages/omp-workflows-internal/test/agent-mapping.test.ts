import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import { agentMappingPath, resetWorkflowOwners, resolveConfig } from "@andvl1/omp-workflows-core";

import ompWorkflowsInternal from "../src/index.js";
import {
	ALLOWED_POOL_AGENTS,
	defaultOmpInternalRoles,
	refreshInternalAgentMappings,
	requiredInternalProfileRoles,
	waitForInternalAgentMappings,
	type InternalAgentDiscovery,
	type InternalDiscoveredAgent,
} from "../src/pool.js";
import { loadOmpWorkflowProfiles } from "../src/profiles.js";

// ── Fixtures ─────────────────────────────────────────────────────────────────

/** Roles the shipped profiles dispatch unconditionally (conditional joiners excluded). */
const REQUIRED_ROLES = requiredInternalProfileRoles(loadOmpWorkflowProfiles());

/** This bundle's own agent definitions — the only provenance-valid origin. */
const BUNDLE_AGENTS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..", "agents");

/**
 * Foreign host agents that must NEVER enter the mapping: the generic task
 * agent, fullstack fallback names, domain writers, and an external-plugin
 * agent that genuinely exists on the host but is outside the omp-* pool.
 * Their recorded file paths live outside the bundle and are never probed —
 * the pool-name check rejects them first.
 */
const FOREIGN_NAMES = [
	"task",
	"analyst",
	"discovery",
	"developer-kotlin",
	"frontend-developer",
	"developer-mobile",
	"product-analyst",
];

/** Pool agents carrying genuine bundle provenance. */
function poolRecords({ omit = [] }: { omit?: readonly string[] } = {}): InternalDiscoveredAgent[] {
	return ALLOWED_POOL_AGENTS.filter((name) => !omit.includes(name)).map((name) => ({
		name,
		source: "bundled" as const,
		filePath: join(BUNDLE_AGENTS_DIR, `${name}.md`),
	}));
}

/** Out-of-pool host agents carrying plausible-but-foreign provenance. */
function foreignRecords(): InternalDiscoveredAgent[] {
	return FOREIGN_NAMES.map((name) => ({
		name,
		source: "project" as const,
		filePath: join(tmpdir(), "foreign-host-agents", `${name}.md`),
	}));
}

function poolDiscovery({
	omit = [],
	extra = [],
}: { omit?: readonly string[]; extra?: readonly InternalDiscoveredAgent[] } = {}): InternalAgentDiscovery {
	const agents = [...poolRecords({ omit }), ...foreignRecords(), ...extra];
	return async () => ({ agents });
}

function markedRoot(roles: Record<string, string>): string {
	const root = mkdtempSync(join(tmpdir(), "omp-internal-mapping-"));
	writeFileSync(join(root, "package.json"), "{}\n");
	mkdirSync(join(root, "packages", "core"), { recursive: true });
	mkdirSync(join(root, "packages", "fullstack"), { recursive: true });
	mkdirSync(join(root, ".omp"), { recursive: true });
	writeFileSync(join(root, ".omp", "team.config.json"), `${JSON.stringify({ roles }, null, 2)}\n`);
	return root;
}

/**
 * Marked workspace with the supported project-extension root but NO runtime
 * config: `.omp/settings.json#extensions` is the exact tracked entry OMP 18.x
 * loads this bundle through, and its presence makes `.omp` a real config root
 * for core's runtime-config writer (which never creates the directory itself).
 * `.omp/team.config.json` stays absent so the first session exercises the
 * seed-on-first-session activation path.
 */
function cleanMarkedRoot(): string {
	const root = mkdtempSync(join(tmpdir(), "omp-internal-mapping-clean-"));
	writeFileSync(join(root, "package.json"), "{}\n");
	mkdirSync(join(root, "packages", "core"), { recursive: true });
	mkdirSync(join(root, "packages", "fullstack"), { recursive: true });
	mkdirSync(join(root, ".omp"), { recursive: true });
	writeFileSync(
		join(root, ".omp", "settings.json"),
		`${JSON.stringify({ extensions: ["node_modules/@andvl1/omp-workflows-internal"] }, null, 2)}\n`,
	);
	return root;
}

/** Config roles covering the profile-required pipeline plus optional/foreign entries. */
function testRoles(): Record<string, string> {
	const roles: Record<string, string> = {};
	for (const role of REQUIRED_ROLES) roles[role] = defaultOmpInternalRoles[role] ?? role;
	// Optional pool joiners — may be absent from discovery without failing the refresh.
	roles.devops = "omp-devops";
	roles["manual-qa"] = "omp-manual-qa";
	// Foreign agent preserved verbatim in config; never resolvable via omp-only discovery.
	roles["product-analyst"] = "product-analyst";
	return roles;
}

// ── Required-role derivation ──────────────────────────────────────────────────

test("required profile roles cover the static pipeline and exclude conditional joiners", () => {
	assert.ok(REQUIRED_ROLES.includes("developer"), "single implementation stage is required");
	assert.ok(REQUIRED_ROLES.includes("qa"), "static qa role is required");
	assert.ok(REQUIRED_ROLES.includes("code-reviewer"), "static consilium role is required");
	assert.ok(!REQUIRED_ROLES.includes("devops"), "infra joiner is conditional, not required");
	assert.ok(!REQUIRED_ROLES.includes("security-tester"), "security joiner is conditional, not required");
	assert.ok(!REQUIRED_ROLES.includes("manual-qa"), "pool-only role is not profile-required");
});

// ── Exact pool publication through provenance-checked discovery ──────────────

test("refresh publishes an exact pool mapping that core accepts", async () => {
	const root = markedRoot(testRoles());
	const mapping = await refreshInternalAgentMappings(root, poolDiscovery({ omit: ["omp-devops", "omp-manual-qa"] }));

	// Core accepts the generated mapping (provenance/hash coherence).
	const accepted = resolveConfig(root).agent_mapping;
	assert.ok(accepted, "core must accept the generated mapping");
	assert.equal(accepted.preferences_hash, mapping.preferences_hash);
	assert.equal(existsSync(agentMappingPath(root)), true, "mapping persisted at the core path");

	// Exact omp-* inventory and resolutions only.
	assert.ok(mapping.available_agents.length > 0);
	for (const name of mapping.available_agents) assert.match(name, /^omp-/);
	const resolved = Object.entries(mapping.resolved_roles);
	assert.ok(resolved.length > 0);
	for (const [role, name] of resolved) assert.match(name, /^omp-/, `role '${role}' must resolve to an omp-* agent`);
	for (const [role, name] of resolved) {
		assert.equal(name, mapping.diagnostics[role]?.resolved, `resolution for '${role}' must match its diagnostic`);
	}
	assert.equal(mapping.source, "@andvl1/omp-workflows-internal");

	// Required pipeline resolved; absent optional joiners and the foreign
	// plugin agent stay truthfully unavailable (never silently resolved).
	assert.equal(mapping.resolved_roles["developer"], "omp-engine-specialist");
	assert.equal(mapping.resolved_roles["qa"], "omp-qa");
	assert.equal(mapping.resolved_roles["code-reviewer"], "omp-code-reviewer");
	assert.equal(mapping.resolved_roles["devops"], undefined);
	assert.equal(mapping.diagnostics["devops"]?.status, "unavailable");
	assert.equal(mapping.resolved_roles["manual-qa"], undefined);
	assert.equal(mapping.resolved_roles["product-analyst"], undefined);
	assert.equal(mapping.diagnostics["product-analyst"]?.status, "unavailable");
	assert.ok(mapping.unresolved_roles.includes("devops"));
});

test("discovery filtering excludes foreign host agents even when they exist", async () => {
	const root = markedRoot(testRoles());
	const mapping = await refreshInternalAgentMappings(root, poolDiscovery());

	// `task`, bare fullstack names and domain writers are absent from the
	// published inventory, so no candidate chain can ever pick them.
	assert.equal(mapping.available_agents.includes("task"), false);
	assert.equal(mapping.available_agents.includes("analyst"), false);
	assert.equal(mapping.available_agents.includes("developer-kotlin"), false);
	assert.equal(JSON.stringify(mapping).includes('"task"'), false, "generic agent never enters the mapping");
});

test("out-of-pool omp-* names are rejected regardless of provenance", async () => {
	const root = markedRoot(testRoles());
	// `omp-attacker` exists as a real host file with valid-looking provenance
	// — the pool check alone must keep it out of the mapping.
	const attackerFile = join(root, ".omp", "agents", "omp-attacker.md");
	mkdirSync(dirname(attackerFile), { recursive: true });
	writeFileSync(attackerFile, "---\nname: omp-attacker\n---\nhostile prompt\n");
	const mapping = await refreshInternalAgentMappings(root, poolDiscovery({
		extra: [{ name: "omp-attacker", source: "project", filePath: attackerFile }],
	}));
	assert.equal(mapping.available_agents.includes("omp-attacker"), false);
	assert.equal(JSON.stringify(mapping).includes("omp-attacker"), false, "attacker never enters the mapping");
});

test("no generic fallback is declared: every role is exact-only", async () => {
	const root = markedRoot(testRoles());
	const mapping = await refreshInternalAgentMappings(root, poolDiscovery());
	assert.deepEqual(mapping.provenance?.generic_fallback_roles, []);
	assert.equal(mapping.provenance?.generic_fallback, null);
	assert.equal(mapping.provenance?.fallback_chains, undefined);
	for (const diagnostic of Object.values(mapping.diagnostics)) {
		assert.equal(diagnostic.candidates.includes("task"), false, "task never becomes a candidate");
	}
});

// ── Path provenance (W004-MAPPING-INTEGRITY) ─────────────────────────────────

test("a same-name shadow outside the bundle agents directory fails the refresh closed", async () => {
	const root = markedRoot(testRoles());
	// Host discovery precedence means a project-dir shadow REPLACES the bundle
	// record: only the shadow definition is discovered for `omp-qa`.
	const shadow = join(root, ".omp", "agents", "omp-qa.md");
	mkdirSync(dirname(shadow), { recursive: true });
	writeFileSync(shadow, "---\nname: omp-qa\n---\nshadow prompt\n");
	await assert.rejects(
		refreshInternalAgentMappings(root, poolDiscovery({
			omit: ["omp-qa"],
			extra: [{ name: "omp-qa", source: "project", filePath: shadow }],
		})),
		/required omp agents missing from host discovery: omp-qa/,
	);
	assert.equal(existsSync(agentMappingPath(root)), false, "shadowed roster is never published");
});

test("a pool agent carrying another agent's definition file fails provenance", async () => {
	const root = markedRoot(testRoles());
	await assert.rejects(
		refreshInternalAgentMappings(root, poolDiscovery({
			omit: ["omp-qa"],
			extra: [{ name: "omp-qa", source: "bundled", filePath: join(BUNDLE_AGENTS_DIR, "omp-analyst.md") }],
		})),
		/required omp agents missing from host discovery: omp-qa/,
	);
});

test("a traversal path escaping the bundle agents directory fails provenance", async () => {
	const root = markedRoot(testRoles());
	const escape = join(root, "shim.md");
	writeFileSync(escape, "---\nname: omp-qa\n---\nescaping shim\n");
	const traversal = join(BUNDLE_AGENTS_DIR, "..", "..", relative(BUNDLE_AGENTS_DIR, escape));
	await assert.rejects(
		refreshInternalAgentMappings(root, poolDiscovery({
			omit: ["omp-qa"],
			extra: [{ name: "omp-qa", source: "project", filePath: traversal }],
		})),
		/required omp agents missing from host discovery: omp-qa/,
	);
});

test("a nonexistent definition path fails provenance", async () => {
	const root = markedRoot(testRoles());
	await assert.rejects(
		refreshInternalAgentMappings(root, poolDiscovery({
			omit: ["omp-qa"],
			extra: [{ name: "omp-qa", source: "bundled", filePath: join(BUNDLE_AGENTS_DIR, "omp-qa.deleted.md") }],
		})),
		/required omp agents missing from host discovery: omp-qa/,
	);
});

test("a pool agent without file provenance is unavailable", async () => {
	const root = markedRoot(testRoles());
	// In-memory agent definitions carry no filePath — nothing anchors them to
	// this bundle, so they fail closed like any other unprovenanced record.
	await assert.rejects(
		refreshInternalAgentMappings(root, poolDiscovery({
			omit: ["omp-qa"],
			extra: [{ name: "omp-qa", source: "bundled" }],
		})),
		/required omp agents missing from host discovery: omp-qa/,
	);
});

test("a symlink resolving to the genuine bundle file passes provenance", async () => {
	const root = markedRoot(testRoles());
	// realpath-based equality: a link that resolves to the bundle's own
	// definition file denotes the same real file and is accepted.
	const link = join(root, "omp-qa-link.md");
	symlinkSync(join(BUNDLE_AGENTS_DIR, "omp-qa.md"), link);
	const mapping = await refreshInternalAgentMappings(root, poolDiscovery({
		extra: [{ name: "omp-qa", source: "project", filePath: link }],
	}));
	assert.equal(mapping.resolved_roles["qa"], "omp-qa");
});

// ── Fail-closed behavior ──────────────────────────────────────────────────────

test("refresh fails closed when a profile-required pool agent is missing", async () => {
	assert.ok(REQUIRED_ROLES.includes("qa"), "precondition: qa is a required role");
	const root = markedRoot(testRoles());
	await assert.rejects(
		refreshInternalAgentMappings(root, poolDiscovery({ omit: ["omp-qa"] })),
		/required omp agents missing from host discovery: omp-qa/,
	);
	assert.equal(existsSync(agentMappingPath(root)), false, "no mapping published on fail-closed");
	assert.equal(resolveConfig(root).agent_mapping, undefined);
});

test("refresh fails closed outside a marked workspace", async () => {
	const root = mkdtempSync(join(tmpdir(), "omp-internal-mapping-unmarked-"));
	await assert.rejects(
		refreshInternalAgentMappings(root, poolDiscovery()),
		/activation_markers_missing/,
	);
	assert.equal(existsSync(agentMappingPath(root)), false);
});

// ── Freshness (W004-MAPPING-FRESHNESS): failures propagate, stale never served ──

test("a failed refresh invalidates the runtime mapping and propagates on the begin seam", async () => {
	const root = markedRoot(testRoles());
	const first = await refreshInternalAgentMappings(root, poolDiscovery());
	await assert.rejects(
		refreshInternalAgentMappings(root, poolDiscovery({ omit: ["omp-qa"] })),
		/required omp agents missing/,
	);
	// The persisted write-through of the LAST ACCEPTED mapping is still
	// readable — but readability is not acceptance.
	assert.ok(resolveConfig(root).agent_mapping, "persisted mapping remains readable");
	// The begin seam must not serve the stale roster: with the cache
	// invalidated, a failing refresh propagates and blocks begin.
	await assert.rejects(
		waitForInternalAgentMappings(root, poolDiscovery({ omit: ["omp-qa"] })),
		/required omp agents missing/,
	);
	// With discovery healthy again the seam recovers with a newly derived
	// mapping — never the invalidated cache object.
	const recovered = await waitForInternalAgentMappings(root, poolDiscovery());
	assert.equal(recovered.preferences_hash, first.preferences_hash);
	assert.notEqual(recovered, first, "recovered mapping is newly derived, not the invalidated cache");
});

test("a tampered persisted mapping is never served to begin", async () => {
	const root = markedRoot(testRoles());
	const fresh = await refreshInternalAgentMappings(root, poolDiscovery());
	const mappingPath = agentMappingPath(root);
	const tampered = JSON.parse(readFileSync(mappingPath, "utf8")) as {
		resolved_roles: Record<string, string>;
		available_agents: string[];
	};
	tampered.resolved_roles["qa"] = "omp-attacker";
	tampered.available_agents = [...tampered.available_agents, "omp-attacker"];
	writeFileSync(mappingPath, JSON.stringify(tampered, null, 2));

	// The begin seam serves the in-memory fresh mapping — object identity —
	// and never re-reads the mutated file.
	const served = await waitForInternalAgentMappings(root, poolDiscovery());
	assert.equal(served, fresh, "begin seam serves the in-memory mapping, never the persisted file");
	assert.equal(served.resolved_roles["qa"], "omp-qa");
});

test("begin seam re-checks current markers: cached authority is invalidated when markers are removed", async () => {
	const root = markedRoot(testRoles());
	const first = await refreshInternalAgentMappings(root, poolDiscovery());
	// Marker removal must strip begin authority even though a mapping was
	// freshly accepted moments ago.
	rmSync(join(root, "packages", "fullstack"), { recursive: true });
	await assert.rejects(waitForInternalAgentMappings(root), /activation_markers_missing/);
	// The runtime cache was invalidated: with markers restored, the seam
	// re-derives a NEW mapping instead of resurrecting the cached one.
	mkdirSync(join(root, "packages", "fullstack"), { recursive: true });
	const revived = await waitForInternalAgentMappings(root, poolDiscovery());
	assert.notEqual(revived, first, "restored workspace re-derives, never resurrects the invalidated cache");
});

test("begin seam re-checks current markers before joining an in-flight refresh", async () => {
	const root = markedRoot(testRoles());
	let release!: () => void;
	const gated = new Promise<void>((resolveGate) => {
		release = resolveGate;
	});
	const slowDiscovery: InternalAgentDiscovery = async () => {
		await gated;
		return { agents: [...poolRecords(), ...foreignRecords()] };
	};
	const inFlight = refreshInternalAgentMappings(root, slowDiscovery);
	rmSync(join(root, "packages", "fullstack"), { recursive: true });
	// The seam must reject on CURRENT markers, not join the in-flight
	// refresh that started while the workspace was still marked.
	await assert.rejects(waitForInternalAgentMappings(root), /activation_markers_missing/);
	// Restore markers so the in-flight refresh (started while marked)
	// settles cleanly; every later seam call re-checks markers regardless.
	mkdirSync(join(root, "packages", "fullstack"), { recursive: true });
	release();
	assert.ok(await inFlight);
});

// ── In-flight marker race (W004-MAPPING-FRESHNESS): publish-time re-check ─────

test("markers lost during in-flight discovery fail the refresh closed and force fresh re-derivation", async () => {
	const root = markedRoot(testRoles());
	const prior = await refreshInternalAgentMappings(root, poolDiscovery());
	assert.ok(prior.available_agents.includes("omp-manual-qa"), "precondition: prior roster carries the optional joiner");

	// Kick a refresh whose discovery is held in flight, then strip a marker.
	let release!: () => void;
	const gated = new Promise<void>((resolveGate) => {
		release = resolveGate;
	});
	const gatedDiscovery: InternalAgentDiscovery = async () => {
		await gated;
		return { agents: [...poolRecords(), ...foreignRecords()] };
	};
	const inFlight = refreshInternalAgentMappings(root, gatedDiscovery);
	rmSync(join(root, "packages", "fullstack"), { recursive: true });
	release();

	// The refresh rejects fail-closed and the prior accepted cache is gone.
	await assert.rejects(inFlight, /activation_markers_missing/);

	// Markers restored: the next seam call must invoke a genuinely fresh
	// discovery and publish only the NEW valid mapping — never the stale one.
	mkdirSync(join(root, "packages", "fullstack"), { recursive: true });
	let calls = 0;
	const narrowedDiscovery: InternalAgentDiscovery = async () => {
		calls += 1;
		return { agents: [...poolRecords({ omit: ["omp-manual-qa"] }), ...foreignRecords()] };
	};
	const revived = await waitForInternalAgentMappings(root, narrowedDiscovery);
	assert.equal(calls, 1, "restored markers force a fresh discovery, not a cache hit");
	assert.notEqual(revived, prior, "the invalidated cache object is never served");
	assert.equal(revived.available_agents.includes("omp-manual-qa"), false, "the published mapping is the newly derived roster");
	assert.equal(revived.resolved_roles["qa"], "omp-qa", "the published mapping is valid");
	const persisted = JSON.parse(readFileSync(agentMappingPath(root), "utf8")) as {
		available_agents: string[];
		preferences_hash: string;
	};
	assert.deepEqual(persisted.available_agents, revived.available_agents, "the persisted write-through is the new mapping");
	assert.equal(resolveConfig(root).agent_mapping?.preferences_hash, revived.preferences_hash, "core accepts only the newly published mapping");
});

test("a begin-seam joiner of an in-flight refresh rejects when markers vanish before publish", async () => {
	const root = markedRoot(testRoles());
	let release!: () => void;
	const gated = new Promise<void>((resolveGate) => {
		release = resolveGate;
	});
	const gatedDiscovery: InternalAgentDiscovery = async () => {
		await gated;
		return { agents: [...poolRecords(), ...foreignRecords()] };
	};
	const inFlight = refreshInternalAgentMappings(root, gatedDiscovery);
	// The seam joins while markers stand, then markers vanish mid-flight.
	const joined = waitForInternalAgentMappings(root);
	rmSync(join(root, "packages", "fullstack"), { recursive: true });
	release();

	await assert.rejects(joined, /activation_markers_missing/, "the joiner fail-closed with the raced refresh");
	await assert.rejects(inFlight, /activation_markers_missing/);
	assert.equal(existsSync(agentMappingPath(root)), false, "nothing was written or published after activation vanished");

	// Restoration cannot resurrect the raced refresh: a fresh call re-derives.
	mkdirSync(join(root, "packages", "fullstack"), { recursive: true });
	let calls = 0;
	const countingDiscovery: InternalAgentDiscovery = async () => {
		calls += 1;
		return { agents: [...poolRecords(), ...foreignRecords()] };
	};
	const revived = await waitForInternalAgentMappings(root, countingDiscovery);
	assert.equal(calls, 1, "restored markers trigger exactly one fresh discovery");
	assert.equal(revived.resolved_roles["qa"], "omp-qa");
	assert.equal(existsSync(agentMappingPath(root)), true, "only the post-restoration mapping is published");
});


// ── beforeBegin seam ──────────────────────────────────────────────────────────

test("waitForInternalAgentMappings joins an in-flight refresh and dedups kickoffs", async () => {
	const root = markedRoot(testRoles());
	let release!: () => void;
	const gated = new Promise<void>((resolveGate) => {
		release = resolveGate;
	});
	let calls = 0;
	const slowDiscovery: InternalAgentDiscovery = async () => {
		calls += 1;
		await gated;
		return { agents: [...poolRecords(), ...foreignRecords()] };
	};

	const refresh = refreshInternalAgentMappings(root, slowDiscovery);
	// A concurrent kickoff (e.g. a second session_start or beforeBegin join)
	// must reuse the in-flight refresh instead of rediscovering.
	const joined = refreshInternalAgentMappings(root, poolDiscovery());
	assert.equal(joined, refresh, "in-flight refresh is reused per root");

	const waited = waitForInternalAgentMappings(root);
	let settled = false;
	void waited.then(() => {
		settled = true;
	});
	await Promise.resolve();
	assert.equal(settled, false, "waitFor must not settle while discovery is pending");

	release();
	const mapping = await waited;
	assert.ok(mapping, "waitFor resolves with the published mapping");
	assert.equal(await refresh, mapping);
	assert.equal(calls, 1, "the pending discovery ran exactly once");
});

test("waitForInternalAgentMappings kicks a fresh refresh when none is in flight and nothing is cached", async () => {
	const root = markedRoot(testRoles());
	let calls = 0;
	const discovery: InternalAgentDiscovery = async () => {
		calls += 1;
		return { agents: [...poolRecords(), ...foreignRecords()] };
	};
	const mapping = await waitForInternalAgentMappings(root, discovery);
	assert.ok(mapping, "begin seam derives a fresh mapping");
	assert.equal(calls, 1, "the seam re-derived from discovery instead of reading the persisted file");
});

test("waitForInternalAgentMappings fails closed outside a marked workspace", async () => {
	const root = mkdtempSync(join(tmpdir(), "omp-internal-mapping-unmarked-wait-"));
	await assert.rejects(
		waitForInternalAgentMappings(root, poolDiscovery()),
		/activation_markers_missing/,
	);
});

// ── session_start kickoff (marker-gated, dedup-joined) ────────────────────────

interface RecordedCommand {
	name: string;
	description?: string;
	handler: (args: string, ctx: unknown) => Promise<void> | void;
}

function makePi() {
	const commands = new Map<string, RecordedCommand>();
	const hooks = new Map<string, Array<(event: unknown, ctx: unknown) => unknown>>();
	const pi = {
		registerCommand(name: string, options: { description?: string; handler: RecordedCommand["handler"] }) {
			commands.set(name, { name, ...options });
		},
		on(event: string, handler: (event: unknown, ctx: unknown) => unknown) {
			const list = hooks.get(event) ?? [];
			list.push(handler);
			hooks.set(event, list);
		},
		setLabel(_label: string) {},
		registerTool(_tool: { name: string }) {},
		sendUserMessage(_content: string) {},
	};
	return {
		pi,
		fireSessionStart(ctx: unknown): void {
			for (const handler of hooks.get("session_start") ?? []) handler({}, ctx);
		},
	};
}

test("session_start starts the mapping refresh for a marked session without default discovery", async () => {
	resetWorkflowOwners();
	const root = markedRoot(testRoles());
	let release!: () => void;
	const gated = new Promise<void>((resolveGate) => {
		release = resolveGate;
	});
	let calls = 0;
	const preStarted: InternalAgentDiscovery = async () => {
		calls += 1;
		await gated;
		return { agents: [...poolRecords(), ...foreignRecords()] };
	};
	const inFlight = refreshInternalAgentMappings(root, preStarted);

	const host = makePi();
	ompWorkflowsInternal(host.pi as never);
	host.fireSessionStart({ cwd: root });
	release();

	const mapping = await inFlight;
	assert.ok(mapping);
	assert.equal(calls, 1, "kickoff joined the in-flight refresh (default discovery never invoked)");
	assert.equal(existsSync(agentMappingPath(root)), true);
	assert.ok(resolveConfig(root).agent_mapping, "published mapping accepted after the kickoff");
});

test("session_start starts nothing for an unmarked session", async () => {
	resetWorkflowOwners();
	const root = mkdtempSync(join(tmpdir(), "omp-internal-mapping-plain-"));
	const host = makePi();
	ompWorkflowsInternal(host.pi as never);
	host.fireSessionStart({ cwd: root });
	assert.equal(existsSync(agentMappingPath(root)), false, "no mapping written for unmarked sessions");
	// No in-flight refresh and no cached mapping: the begin seam re-attempts
	// discovery and the marker gate rejects it fail-closed — the persisted
	// mapping file is never consulted as a fallback.
	await assert.rejects(waitForInternalAgentMappings(root), /activation_markers_missing/);
});

test("session_start on a clean marked workspace seeds roles before the refresh resolves and first begin succeeds", async () => {
	resetWorkflowOwners();
	const root = cleanMarkedRoot();
	const configPath = join(root, ".omp", "team.config.json");
	assert.ok(
		existsSync(join(root, ".omp", "settings.json")),
		"precondition: supported project-extension root (.omp/settings.json#extensions) present",
	);
	assert.equal(existsSync(configPath), false, "precondition: no runtime config seeded yet");

	// Hold discovery in flight across session_start: the handler's kickoff
	// must join it, and its role resolution must only happen AFTER the
	// synchronous seed has landed.
	let release!: () => void;
	const gated = new Promise<void>((resolveGate) => {
		release = resolveGate;
	});
	let calls = 0;
	const gatedDiscovery: InternalAgentDiscovery = async () => {
		calls += 1;
		await gated;
		return { agents: [...poolRecords(), ...foreignRecords()] };
	};
	const inFlight = refreshInternalAgentMappings(root, gatedDiscovery);

	const host = makePi();
	ompWorkflowsInternal(host.pi as never);
	host.fireSessionStart({ cwd: root });

	// Seed completed synchronously during activation — while discovery is
	// still pending — so the refresh can never resolve empty roles.
	assert.equal(existsSync(configPath), true, "default omp-* config is seeded during session_start");
	const seeded = JSON.parse(readFileSync(configPath, "utf8")) as { roles: Record<string, string> };
	assert.equal(seeded.roles.developer, defaultOmpInternalRoles.developer, "seeded developer role is the omp-* default");
	assert.equal(calls, 1, "session_start kickoff joined the in-flight refresh");

	release();
	const mapping = await inFlight;
	assert.equal(mapping.resolved_roles["developer"], defaultOmpInternalRoles.developer, "refresh resolved roles through the seeded config");
	assert.ok(resolveConfig(root).agent_mapping, "published mapping accepted on the first session");

	// First begin succeeds from the in-memory authority — no second session.
	const served = await waitForInternalAgentMappings(root);
	assert.equal(served, mapping, "first begin serves the freshly published mapping");

	// A second session_start re-seeds idempotently (file untouched), its
	// kickoff joins the in-flight refresh, and the seam serves the newest
	// accepted mapping.
	const configBefore = readFileSync(configPath, "utf8");
	let release2!: () => void;
	const gated2 = new Promise<void>((resolveGate) => {
		release2 = resolveGate;
	});
	const secondRefresh = refreshInternalAgentMappings(root, async () => {
		calls += 1;
		await gated2;
		return { agents: [...poolRecords(), ...foreignRecords()] };
	});
	host.fireSessionStart({ cwd: root });
	assert.equal(readFileSync(configPath, "utf8"), configBefore, "second session never rewrites the seeded config");
	assert.equal(calls, 2, "second kickoff joined the second refresh (default discovery never invoked)");
	release2();
	const again = await secondRefresh;
	assert.equal(await waitForInternalAgentMappings(root), again);
});

test("session_start seeding never overwrites an existing custom config", async () => {
	resetWorkflowOwners();
	const root = markedRoot({ ...testRoles(), developer: "omp-team-lead" });
	const configPath = join(root, ".omp", "team.config.json");
	const before = readFileSync(configPath, "utf8");

	let release!: () => void;
	const gated = new Promise<void>((resolveGate) => {
		release = resolveGate;
	});
	const gatedDiscovery: InternalAgentDiscovery = async () => {
		await gated;
		return { agents: [...poolRecords(), ...foreignRecords()] };
	};
	const inFlight = refreshInternalAgentMappings(root, gatedDiscovery);

	const host = makePi();
	ompWorkflowsInternal(host.pi as never);
	host.fireSessionStart({ cwd: root });
	assert.equal(readFileSync(configPath, "utf8"), before, "existing custom config is untouched by the seed");

	release();
	const served = await inFlight;
	assert.equal(served.resolved_roles["developer"], "omp-team-lead", "the refresh honors the preserved custom role");
});

