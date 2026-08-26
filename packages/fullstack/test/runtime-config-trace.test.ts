import { test } from "node:test";
import { createHash } from "node:crypto";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { performance } from "node:perf_hooks";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { readAgentMapping, resolveConfig } from "@andvl1/omp-workflows-core";
import { refreshFullstackAgentMappings } from "../src/agent-mapping.js";

const TRACE_MARKER = "<!-- omp-cto-slice run=01a0391e-88a6-75bd-9b6d-4aee2ca53c26 slice=plugin-platform -->";

test("runtime trace captures cwd, config/mapping provenance and first-command timing", async () => {
  const root = mkdtempSync(join(tmpdir(), "omp-runtime-trace-"));
  try {
    const sessionCwd = realpathSync(resolve(root));
    mkdirSync(join(sessionCwd, ".omp"), { recursive: true });
    const configPath = join(sessionCwd, ".omp", "team.config.json");
    const config = {
      roles: { analyst: "analyst" },
      metadata: {
        version: "trace-v1",
        writer: "fullstack-test",
        provenance: { package: "trace-fixture", entrypoint: "runtime-trace" },
      },
    };
    writeFileSync(configPath, `${JSON.stringify(config)}\n`, "utf8");

    const commandStarted = performance.now();
    const discoveredProviders: string[] = [];
    const mapping = await refreshFullstackAgentMappings(sessionCwd, async () => {
      discoveredProviders.push("analyst", "task");
      return { agents: discoveredProviders.map(name => ({ name })) };
    });
    const commandCompleted = performance.now();
    const rawConfig = readFileSync(configPath, "utf8");
    const parsedConfig = JSON.parse(rawConfig) as typeof config;
    const persistedMapping = readAgentMapping(sessionCwd);
    const trace = {
      marker: TRACE_MARKER,
      effective_session_cwd: sessionCwd,
      config: {
        path: configPath,
        writer: parsedConfig.metadata.writer,
        provenance: parsedConfig.metadata.provenance,
        version: parsedConfig.metadata.version,
        hash: createHash("sha256").update(rawConfig).digest("hex"),
      },
      mapping: {
        source: resolve(sessionCwd, ".work-state", "runtime", "agent-mapping.json"),
        hash: mapping.preferences_hash,
        persisted_hash: persistedMapping?.preferences_hash,
      },
      provider_discovery: discoveredProviders,
      first_command: {
        started_at_ms: commandStarted,
        completed_at_ms: commandCompleted,
        latency_ms: commandCompleted - commandStarted,
      },
    };

    console.log(`RUNTIME_TRACE ${JSON.stringify(trace)}`);
    assert.equal(trace.marker, TRACE_MARKER);
    assert.equal(trace.effective_session_cwd, sessionCwd);
    assert.equal(trace.config.writer, "fullstack-test");
    assert.equal(trace.config.version, "trace-v1");
    assert.equal(trace.mapping.hash, trace.mapping.persisted_hash);
    assert.deepEqual(trace.provider_discovery, ["analyst", "task"]);
    assert.ok(trace.first_command.latency_ms >= 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
