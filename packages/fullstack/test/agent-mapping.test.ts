import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AGENT_MAPPING_MAX_BYTES,
  AgentMappingWriteError,
  agentMappingPath,
  readAgentMapping,
} from "@andvl1/omp-workflows-core";
import { MAX_FULLSTACK_AGENT_MAPPING_ROOTS, clearFullstackAgentMappings, refreshFullstackAgentMappings, waitForFullstackAgentMappings } from "../src/agent-mapping.js";

test("fullstack refresh publishes the live role mapping without touching team.config", async () => {
  const root = mkdtempSync(join(tmpdir(), "omp-fullstack-mapping-refresh-"));
  try {
    mkdirSync(join(root, ".omp"), { recursive: true });
    const configPath = join(root, ".omp", "team.config.json");
    const originalConfig = '{ "roles": { "regression-planner": "analyst" } }\n';
    writeFileSync(configPath, originalConfig);
    const result = await refreshFullstackAgentMappings(root, async () => ({
      agents: [{ name: "analyst" }, { name: "task" }],
    }));

    assert.equal(result.diagnostics["regression-planner"]?.status, "preferred");
    assert.equal(result.resolved_roles["regression-planner"], "analyst");
    assert.equal(readFileSync(configPath, "utf8"), originalConfig);
    assert.deepEqual(readAgentMapping(root), result);
    assert.deepEqual(await waitForFullstackAgentMappings(root), result);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("fullstack retained root rejects replacement during async discovery", async () => {
  const root = mkdtempSync(join(tmpdir(), "omp-fullstack-mapping-pinned-"));
  const replacement = mkdtempSync(join(tmpdir(), "omp-fullstack-mapping-pinned-replacement-"));
  const moved = `${root}-moved`;
  try {
    mkdirSync(join(root, ".omp"), { recursive: true });
    mkdirSync(join(replacement, ".omp"), { recursive: true });
    let releaseDiscovery!: (result: { agents: ReadonlyArray<{ name: string }> }) => void;
    const discovery = new Promise<{ agents: ReadonlyArray<{ name: string }> }>((resolve) => {
      releaseDiscovery = resolve;
    });
    const refresh = refreshFullstackAgentMappings(root, async () => discovery);
    const waiting = waitForFullstackAgentMappings(root);
    renameSync(root, moved);
    renameSync(replacement, root);
    releaseDiscovery({ agents: [{ name: "analyst" }, { name: "task" }] });
    await assert.rejects(refresh, /activation_identity_changed/);
    await assert.rejects(waiting, /activation_identity_changed/);
    assert.equal(existsSync(agentMappingPath(root)), false, "replacement root receives no mapping");
  } finally {
    rmSync(moved, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
    rmSync(replacement, { recursive: true, force: true });
  }
});

test("fullstack typed mapping oversize rejects without stale fallback or replacement", async () => {
  const root = mkdtempSync(join(tmpdir(), "omp-fullstack-mapping-oversize-"));
  try {
    mkdirSync(join(root, ".omp"), { recursive: true });
    const configPath = join(root, ".omp", "team.config.json");
    writeFileSync(configPath, JSON.stringify({ roles: { analyst: "analyst" } }) + "\n");
    await refreshFullstackAgentMappings(root, async () => ({
      agents: [{ name: "analyst" }, { name: "task" }],
    }));
    const mappingPath = agentMappingPath(root);
    const before = readFileSync(mappingPath);

    const oversizedConfig = {
      roles: { analyst: "analyst" },
      provenance: Object.fromEntries(
        Array.from({ length: 16 }, (_, index) => [`extra_${index}`, "\"".repeat(8_150)]),
      ),
    };
    const oversizedConfigBytes = Buffer.byteLength(`${JSON.stringify(oversizedConfig)}\n`, "utf8");
    assert.ok(oversizedConfigBytes <= AGENT_MAPPING_MAX_BYTES);
    writeFileSync(configPath, `${JSON.stringify(oversizedConfig)}\n`);
    let releaseDiscovery!: (result: { agents: ReadonlyArray<{ name: string }> }) => void;
    const discovery = new Promise<{ agents: ReadonlyArray<{ name: string }> }>((resolve) => {
      releaseDiscovery = resolve;
    });
    const refresh = refreshFullstackAgentMappings(root, async () => discovery);
    const waiting = waitForFullstackAgentMappings(root);
    releaseDiscovery({ agents: [{ name: "analyst" }, { name: "task" }] });
    const isTypedOversize = (error: unknown): boolean =>
      error instanceof AgentMappingWriteError && error.code === "limit";
    await assert.rejects(refresh, isTypedOversize);
    await assert.rejects(waiting, isTypedOversize);
    assert.deepEqual(readFileSync(mappingPath), before);
    await assert.rejects(waitForFullstackAgentMappings(root), isTypedOversize);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("fullstack refresh uses generic task when a specialized planner is absent", async () => {
  const root = mkdtempSync(join(tmpdir(), "omp-fullstack-mapping-fallback-"));
  try {
    const result = await refreshFullstackAgentMappings(root, async () => ({
      agents: [{ name: "task" }],
    }));

    assert.equal(result.resolved_roles["regression-planner"], "task");
    assert.equal(result.diagnostics["regression-planner"]?.status, "fallback");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("fullstack refresh keeps security review unavailable without its specialist", async () => {
  const root = mkdtempSync(join(tmpdir(), "omp-fullstack-mapping-security-"));
  try {
    const result = await refreshFullstackAgentMappings(root, async () => ({
      agents: [{ name: "task" }],
    }));

    assert.equal(result.resolved_roles["security-tester"], undefined);
    assert.equal(result.diagnostics["security-tester"]?.status, "unavailable");
    assert.ok(result.unresolved_roles.includes("security-tester"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("fullstack native specification roles do not fall back to generic task", async () => {
  const root = mkdtempSync(join(tmpdir(), "omp-fullstack-mapping-native-"));
  try {
    const unavailable = await refreshFullstackAgentMappings(root, async () => ({
      agents: [{ name: "task" }],
    }));
    assert.equal(unavailable.resolved_roles["specification-analyst"], undefined);
    assert.equal(unavailable.resolved_roles["specification-architect"], undefined);
    assert.equal(unavailable.diagnostics["specification-analyst"]?.status, "unavailable");
    assert.equal(unavailable.diagnostics["specification-architect"]?.status, "unavailable");

    const dedicated = await refreshFullstackAgentMappings(root, async () => ({
      agents: [{ name: "specification-worker" }],
    }));
    assert.equal(dedicated.resolved_roles["specification-analyst"], "specification-worker");
    assert.equal(dedicated.resolved_roles["specification-architect"], "specification-worker");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
 });


test("fullstack mapping cache sweeps replaced roots and fails closed at its root bound", async () => {
  const roots: string[] = [];
  const makeRoot = (): string => {
    const root = mkdtempSync(join(tmpdir(), "omp-fullstack-mapping-cache-"));
    mkdirSync(join(root, ".omp"), { recursive: true });
    roots.push(root);
    return root;
  };
  try {
    for (let index = 0; index < MAX_FULLSTACK_AGENT_MAPPING_ROOTS; index += 1) {
      await refreshFullstackAgentMappings(makeRoot(), async () => ({ agents: [{ name: "analyst" }] }));
    }
    const overflow = makeRoot();
    await assert.rejects(
      refreshFullstackAgentMappings(overflow, async () => ({ agents: [{ name: "analyst" }] })),
      /cache capacity exceeded/u,
    );
    rmSync(roots[0]!, { recursive: true, force: true });
    const recycled = makeRoot();
    const mapping = await refreshFullstackAgentMappings(recycled, async () => ({ agents: [{ name: "analyst" }] }));
    assert.equal(mapping.resolved_roles.analyst, "analyst");
    assert.deepEqual(await waitForFullstackAgentMappings(recycled), mapping);
    clearFullstackAgentMappings(recycled);
    assert.equal(await waitForFullstackAgentMappings(recycled), undefined, "exact-root clear drops only the selected in-memory mapping");
  } finally {
    for (const root of roots) rmSync(root, { recursive: true, force: true });
    clearFullstackAgentMappings();
  }
});
