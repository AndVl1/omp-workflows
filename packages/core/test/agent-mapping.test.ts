/* <!-- omp-cto-slice run=01a03ee4-7dd6-7580-8ad7-16d26dc886ba slice=workflow-v2-core --> */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, rmSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildQualifiedAgentMapping,
  readQualifiedAgentMapping,
  writeQualifiedAgentMapping,
} from "../src/engine/agent-mapping.js";
import type {
  AgentRef,
  AgentSourceFingerprint,
  ProjectIdentity,
  ProviderId,
  WorkflowRunIdentity,
  WorkflowV2Digest,
} from "../src/workflow-v2/types.js";

const providerId = "@example/workflow-provider" as ProviderId;
const sourceFingerprint = `sha256:${"f".repeat(64)}` as WorkflowV2Digest;
const agentSources = [{
  provider_id: providerId,
  source_fingerprint: sourceFingerprint,
  registered_names: ["analyst", "manual-qa", "qa", "security-tester", "task"],
}] as const satisfies readonly AgentSourceFingerprint[];
const projectIdentity = {
  root_instance_id: `sha256:${"a".repeat(64)}` as WorkflowV2Digest,
  provider_id: providerId,
  descriptor_fingerprint: `sha256:${"b".repeat(64)}` as WorkflowV2Digest,
  executable_provenance: {
    build_fingerprint: `sha256:${"c".repeat(64)}` as WorkflowV2Digest,
    runtime_fingerprint: `sha256:${"d".repeat(64)}` as WorkflowV2Digest,
  },
  catalog_content_digest: `sha256:${"e".repeat(64)}` as WorkflowV2Digest,
  config_byte_sha256: `sha256:${"0".repeat(64)}` as WorkflowV2Digest,
  config_semantic_sha256: `sha256:${"1".repeat(64)}` as WorkflowV2Digest,
  session: { session_id: "session-1", lifecycle_id: "lifecycle-1" },
} as const satisfies ProjectIdentity;
const runIdentity = {
  ...projectIdentity,
  run_id: "run-1",
  profile_identity: {
    id: "balanced",
    fingerprint: `sha256:${"2".repeat(64)}` as WorkflowV2Digest,
  },
} as const satisfies WorkflowRunIdentity;
const agents = {
  analyst: { registered_name: "analyst", provider_id: providerId, source_fingerprint: sourceFingerprint },
  manualQa: { registered_name: "manual-qa", provider_id: providerId, source_fingerprint: sourceFingerprint },
  qa: { registered_name: "qa", provider_id: providerId, source_fingerprint: sourceFingerprint },
  task: { registered_name: "task", provider_id: providerId, source_fingerprint: sourceFingerprint },
} satisfies Record<string, AgentRef>;

function mapping() {
  const result = buildQualifiedAgentMapping({
    project_identity: projectIdentity,
    run_identity: runIdentity,
    agent_sources: agentSources,
    roles: {
      "regression-planner": agents.analyst,
      "regression-executor": agents.manualQa,
      "security-tester": { registered_name: "security-tester", provider_id: providerId, source_fingerprint: sourceFingerprint },
    },
    fallbackChains: {
      "regression-planner": [agents.task],
      "regression-executor": [agents.qa],
    },
    availableAgents: [agents.task, agents.qa],
  });
  assert.equal(result.ok, true);
  if (!result.ok) throw new Error("qualified mapping fixture is invalid");
  return result.value;
}

const expected = {
  project_identity: projectIdentity,
  run_identity: runIdentity,
  agent_sources: agentSources,
};

test("qualified mapping uses exact provider/source identities and explicit fallbacks", () => {
  const result = buildQualifiedAgentMapping({
    project_identity: projectIdentity,
    run_identity: runIdentity,
    agent_sources: agentSources,
    roles: {
      "regression-planner": agents.analyst,
      "regression-executor": agents.manualQa,
      "security-tester": { registered_name: "security-tester", provider_id: providerId, source_fingerprint: sourceFingerprint },
    },
    fallbackChains: {
      "regression-planner": [agents.task],
      "regression-executor": [agents.qa],
    },
    availableAgents: [agents.task, agents.qa],
  });
  assert.equal(result.ok, true);
  if (!result.ok) return;

  assert.deepEqual(result.value.project_identity, projectIdentity);
  assert.deepEqual(result.value.run_identity, runIdentity);
  assert.deepEqual(result.value.agent_sources, agentSources);
  assert.deepEqual(result.value.resolved_roles["regression-planner"], agents.task);
  assert.equal(result.value.diagnostics["regression-planner"]?.status, "fallback");
  assert.deepEqual(result.value.resolved_roles["regression-executor"], agents.qa);
  assert.equal(result.value.diagnostics["regression-executor"]?.status, "fallback");
  assert.equal(result.value.resolved_roles["security-tester"], undefined);
  assert.equal(result.value.diagnostics["security-tester"]?.status, "unavailable");
  assert.ok(result.value.unresolved_roles.includes("security-tester"));
});

test("qualified mapping persists atomically and rejects malformed or legacy files", () => {
  const root = mkdtempSync(join(tmpdir(), "omp-qualified-agent-mapping-"));
  try {
    const value = mapping();
    const path = writeQualifiedAgentMapping(root, value);
    assert.equal(JSON.parse(readFileSync(path, "utf8")).schema, 3);
    assert.deepEqual(readQualifiedAgentMapping(root, expected), value);

    writeFileSync(path, "{broken", "utf8");
    assert.equal(readQualifiedAgentMapping(root, expected), undefined);

    writeFileSync(path, JSON.stringify({ schema: 2, available_agents: ["task"] }), "utf8");
    assert.equal(readQualifiedAgentMapping(root, expected), undefined, "retired unqualified mapping must never be used");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
