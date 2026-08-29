/* <!-- omp-cto-slice run=01a03ee4-7dd6-7580-8ad7-16d26dc886ba slice=workflow-v2-core --> */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildQualifiedAgentMapping,
  resolveQualifiedAgentForRole,
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
const sourceFingerprint = `sha256:${"a".repeat(64)}` as WorkflowV2Digest;
const otherSourceFingerprint = `sha256:${"0".repeat(64)}` as WorkflowV2Digest;
const projectIdentity = {
  root_instance_id: `sha256:${"b".repeat(64)}` as WorkflowV2Digest,
  provider_id: providerId,
  descriptor_fingerprint: `sha256:${"c".repeat(64)}` as WorkflowV2Digest,
  executable_provenance: {
    build_fingerprint: `sha256:${"d".repeat(64)}` as WorkflowV2Digest,
    runtime_fingerprint: `sha256:${"e".repeat(64)}` as WorkflowV2Digest,
  },
  catalog_content_digest: `sha256:${"f".repeat(64)}` as WorkflowV2Digest,
  config_byte_sha256: `sha256:${"1".repeat(64)}` as WorkflowV2Digest,
  config_semantic_sha256: `sha256:${"2".repeat(64)}` as WorkflowV2Digest,
  session: { session_id: "session-1", lifecycle_id: "lifecycle-1" },
} as const satisfies ProjectIdentity;
const runIdentity = {
  ...projectIdentity,
  run_id: "run-1",
  profile_identity: {
    id: "balanced",
    fingerprint: `sha256:${"3".repeat(64)}` as WorkflowV2Digest,
  },
} as const satisfies WorkflowRunIdentity;
const agentSources = [{
  provider_id: providerId,
  source_fingerprint: sourceFingerprint,
  registered_names: ["analyst", "task"],
}] as const satisfies readonly AgentSourceFingerprint[];

const requested: AgentRef = { registered_name: "analyst", provider_id: providerId, source_fingerprint: sourceFingerprint };
const sameNameOtherSource: AgentRef = { ...requested, source_fingerprint: otherSourceFingerprint };
const task: AgentRef = { registered_name: "task", provider_id: providerId, source_fingerprint: sourceFingerprint };

function options(overrides: {
  agent_sources?: readonly AgentSourceFingerprint[];
  availableAgents?: readonly AgentRef[];
  roles?: Readonly<Record<string, AgentRef>>;
  fallbackChains?: Readonly<Record<string, readonly AgentRef[]>>;
} = {}) {
  return {
    project_identity: projectIdentity,
    run_identity: runIdentity,
    agent_sources: overrides.agent_sources ?? agentSources,
    roles: overrides.roles ?? { planner: requested },
    fallbackChains: overrides.fallbackChains,
    availableAgents: overrides.availableAgents ?? [requested],
  };
}

test("qualified mapping rejects an observed agent with stale source identity", () => {
  const result = buildQualifiedAgentMapping(options({ availableAgents: [sameNameOtherSource] }));
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.diagnostics[0]?.code, "IDENTITY_MISMATCH");
});

test("qualified mapping rejects incompatible duplicate agent provenance", () => {
  const result = buildQualifiedAgentMapping(options({ availableAgents: [requested, sameNameOtherSource] }));
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.diagnostics[0]?.code, "AGENT_COLLISION");
});

test("qualified mapping resolves only an explicit provider-qualified fallback", () => {
  const result = buildQualifiedAgentMapping(options({
    roles: { planner: requested },
    fallbackChains: { planner: [task] },
    availableAgents: [task],
  }));
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.deepEqual(resolveQualifiedAgentForRole(result.value, "planner"), task);
  assert.equal(result.value.diagnostics.planner?.status, "fallback");
});

test("qualified mapping rejects a selected reference missing from the descriptor source set", () => {
  const result = buildQualifiedAgentMapping(options({
    agent_sources: [{
      provider_id: providerId,
      source_fingerprint: sourceFingerprint,
      registered_names: ["task"],
    }],
  }));
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.diagnostics[0]?.code, "IDENTITY_MISMATCH");
});

test("qualified mapping rejects ambiguous descriptor source names", () => {
  const result = buildQualifiedAgentMapping(options({
    agent_sources: [
      ...agentSources,
      { provider_id: providerId, source_fingerprint: otherSourceFingerprint, registered_names: ["analyst"] },
    ],
  }));
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.diagnostics[0]?.code, "AGENT_COLLISION");
});


test("qualified mapping rejects a run identity from another project authority", () => {
  const foreignProject = {
    ...projectIdentity,
    root_instance_id: `sha256:${"9".repeat(64)}` as WorkflowV2Digest,
  } as const satisfies ProjectIdentity;
  const foreignRun = {
    ...foreignProject,
    run_id: "run-foreign",
    profile_identity: runIdentity.profile_identity,
  } as const satisfies WorkflowRunIdentity;
  const result = buildQualifiedAgentMapping({
    ...options(),
    run_identity: foreignRun,
  });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.diagnostics[0]?.code, "IDENTITY_MISMATCH");
});