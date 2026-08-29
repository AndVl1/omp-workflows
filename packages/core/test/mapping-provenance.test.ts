/* <!-- omp-cto-slice run=01a03ee4-7dd6-7580-8ad7-16d26dc886ba slice=workflow-v2-core --> */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildQualifiedAgentMapping,
  qualifiedMappingPreferencesHash,
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
const secondSourceFingerprint = `sha256:${"0".repeat(64)}` as WorkflowV2Digest;
const agentSources = [
  { provider_id: providerId, source_fingerprint: sourceFingerprint, registered_names: ["analyst", "task"] },
  { provider_id: providerId, source_fingerprint: secondSourceFingerprint, registered_names: ["manual-qa"] },
] as const satisfies readonly AgentSourceFingerprint[];
const projectIdentity = {
  root_instance_id: `sha256:${"a".repeat(64)}` as WorkflowV2Digest,
  provider_id: providerId,
  descriptor_fingerprint: `sha256:${"b".repeat(64)}` as WorkflowV2Digest,
  executable_provenance: {
    build_fingerprint: `sha256:${"c".repeat(64)}` as WorkflowV2Digest,
    runtime_fingerprint: `sha256:${"d".repeat(64)}` as WorkflowV2Digest,
  },
  catalog_content_digest: `sha256:${"e".repeat(64)}` as WorkflowV2Digest,
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
const task: AgentRef = { registered_name: "task", provider_id: providerId, source_fingerprint: sourceFingerprint };
const analyst: AgentRef = { registered_name: "analyst", provider_id: providerId, source_fingerprint: sourceFingerprint };

function build() {
  const result = buildQualifiedAgentMapping({
    project_identity: projectIdentity,
    run_identity: runIdentity,
    agent_sources: agentSources,
    roles: { reviewer: analyst },
    fallbackChains: { reviewer: [task] },
    availableAgents: [analyst, task],
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

test("qualified mapping hash binds complete project/run/source identities and mapping preferences", () => {
  const base = qualifiedMappingPreferencesHash(projectIdentity, runIdentity, agentSources, { reviewer: analyst }, { reviewer: [task] });
  const projectCases: readonly [string, ProjectIdentity][] = [
    ["root_instance_id", { ...projectIdentity, root_instance_id: `sha256:${"3".repeat(64)}` as WorkflowV2Digest }],
    ["provider_id", { ...projectIdentity, provider_id: "@other/workflow-provider" as ProviderId }],
    ["descriptor_fingerprint", { ...projectIdentity, descriptor_fingerprint: `sha256:${"4".repeat(64)}` as WorkflowV2Digest }],
    ["executable_provenance.build_fingerprint", { ...projectIdentity, executable_provenance: { ...projectIdentity.executable_provenance, build_fingerprint: `sha256:${"5".repeat(64)}` as WorkflowV2Digest } }],
    ["executable_provenance.runtime_fingerprint", { ...projectIdentity, executable_provenance: { ...projectIdentity.executable_provenance, runtime_fingerprint: `sha256:${"6".repeat(64)}` as WorkflowV2Digest } }],
    ["catalog_content_digest", { ...projectIdentity, catalog_content_digest: `sha256:${"7".repeat(64)}` as WorkflowV2Digest }],
    ["config_byte_sha256", { ...projectIdentity, config_byte_sha256: `sha256:${"8".repeat(64)}` as WorkflowV2Digest }],
    ["config_semantic_sha256", { ...projectIdentity, config_semantic_sha256: `sha256:${"9".repeat(64)}` as WorkflowV2Digest }],
    ["session.session_id", { ...projectIdentity, session: { ...projectIdentity.session, session_id: "session-2" } }],
    ["session.lifecycle_id", { ...projectIdentity, session: { ...projectIdentity.session, lifecycle_id: "lifecycle-2" } }],
  ];
  for (const [field, changed] of projectCases) {
    assert.notEqual(
      qualifiedMappingPreferencesHash(changed, runIdentity, agentSources, { reviewer: analyst }, { reviewer: [task] }),
      base,
      `hash must change for ${field}`,
    );
  }
  assert.notEqual(
    qualifiedMappingPreferencesHash(projectIdentity, { ...runIdentity, run_id: "run-2" }, agentSources, { reviewer: analyst }, { reviewer: [task] }),
    base,
    "hash must change for the run id",
  );
  assert.notEqual(
    qualifiedMappingPreferencesHash(projectIdentity, { ...runIdentity, profile_identity: { id: "fast", fingerprint: `sha256:${"4".repeat(64)}` as WorkflowV2Digest } }, agentSources, { reviewer: analyst }, { reviewer: [task] }),
    base,
    "hash must change for the exact selected profile",
  );
  const changedSource: AgentRef = { ...analyst, source_fingerprint: `sha256:${"9".repeat(64)}` as WorkflowV2Digest };
  assert.notEqual(
    qualifiedMappingPreferencesHash(projectIdentity, runIdentity, agentSources, { reviewer: changedSource }, { reviewer: [task] }),
    base,
    "hash must change for the requested agent source fingerprint",
  );
  assert.notEqual(
    qualifiedMappingPreferencesHash(projectIdentity, runIdentity, agentSources, { reviewer: analyst }, { reviewer: [changedSource] }),
    base,
    "hash must change for a fallback agent source fingerprint",
  );
  assert.notEqual(
    qualifiedMappingPreferencesHash(projectIdentity, runIdentity, [{ ...agentSources[0], source_fingerprint: `sha256:${"9".repeat(64)}` as WorkflowV2Digest }, agentSources[1]], { reviewer: analyst }, { reviewer: [task] }),
    base,
    "hash must change for the descriptor source set",
  );
  const permutedSources = [
    { ...agentSources[1], registered_names: ["manual-qa"] },
    { ...agentSources[0], registered_names: ["task", "analyst"] },
  ] as const;
  assert.equal(
    qualifiedMappingPreferencesHash(projectIdentity, runIdentity, permutedSources, { reviewer: analyst }, { reviewer: [task] }),
    base,
    "equivalent descriptor source permutations must hash identically",
  );
});

test("mapping reader rejects stale project/run identities and keeps worktrees isolated", () => {
  const first = mkdtempSync(join(tmpdir(), "omp-qualified-map-a-"));
  const second = mkdtempSync(join(tmpdir(), "omp-qualified-map-b-"));
  try {
    const mapping = build();
    const path = writeQualifiedAgentMapping(first, mapping);
    assert.deepEqual(readQualifiedAgentMapping(first, expected), mapping);
    assert.equal(readQualifiedAgentMapping(second, expected), undefined);

    const changedProjects: readonly ProjectIdentity[] = [
      { ...projectIdentity, root_instance_id: `sha256:${"0".repeat(64)}` as WorkflowV2Digest },
      { ...projectIdentity, provider_id: "@other/workflow-provider" as ProviderId },
      { ...projectIdentity, descriptor_fingerprint: `sha256:${"0".repeat(64)}` as WorkflowV2Digest },
      { ...projectIdentity, executable_provenance: { ...projectIdentity.executable_provenance, build_fingerprint: `sha256:${"0".repeat(64)}` as WorkflowV2Digest } },
      { ...projectIdentity, executable_provenance: { ...projectIdentity.executable_provenance, runtime_fingerprint: `sha256:${"0".repeat(64)}` as WorkflowV2Digest } },
      { ...projectIdentity, catalog_content_digest: `sha256:${"0".repeat(64)}` as WorkflowV2Digest },
      { ...projectIdentity, config_byte_sha256: `sha256:${"0".repeat(64)}` as WorkflowV2Digest },
      { ...projectIdentity, config_semantic_sha256: `sha256:${"0".repeat(64)}` as WorkflowV2Digest },
      { ...projectIdentity, session: { ...projectIdentity.session, session_id: "other-session" } },
      { ...projectIdentity, session: { ...projectIdentity.session, lifecycle_id: "other-lifecycle" } },
    ];
    for (const changedProject of changedProjects) {
      const changedRun = { ...runIdentity, ...changedProject } as WorkflowRunIdentity;
      assert.equal(
        readQualifiedAgentMapping(first, { ...expected, project_identity: changedProject, run_identity: changedRun }),
        undefined,
        "stale project identity must be rejected",
      );
    }
    assert.equal(
      readQualifiedAgentMapping(first, { ...expected, run_identity: { ...runIdentity, run_id: "run-2" } }),
      undefined,
      "stale run id must be rejected",
    );
    assert.equal(
      readQualifiedAgentMapping(first, { ...expected, run_identity: { ...runIdentity, profile_identity: { id: "fast", fingerprint: `sha256:${"4".repeat(64)}` as WorkflowV2Digest } } }),
      undefined,
      "stale profile identity must be rejected",
    );
    assert.equal(
      readQualifiedAgentMapping(first, {
        ...expected,
        agent_sources: [{ ...agentSources[0], source_fingerprint: `sha256:${"4".repeat(64)}` as WorkflowV2Digest }, agentSources[1]],
      }),
      undefined,
      "stale descriptor source set must be rejected",
    );
    assert.equal(
      readQualifiedAgentMapping(first, { ...expected, preferences_hash: `sha256:${"0".repeat(64)}` }),
      undefined,
      "stale preferences must be rejected",
    );

    const tamperedProject = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    tamperedProject.project_identity = {
      ...(tamperedProject.project_identity as Record<string, unknown>),
      config_byte_sha256: `sha256:${"0".repeat(64)}`,
    };
    writeFileSync(path, `${JSON.stringify(tamperedProject)}\n`, "utf8");
    assert.equal(readQualifiedAgentMapping(first, expected), undefined, "tampered project identity must be rejected");

    const tamperedRun = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    tamperedRun.project_identity = projectIdentity;
    tamperedRun.run_identity = { ...runIdentity, profile_identity: { id: "fast", fingerprint: `sha256:${"4".repeat(64)}` } };
    writeFileSync(path, `${JSON.stringify(tamperedRun)}\n`, "utf8");
    assert.equal(readQualifiedAgentMapping(first, expected), undefined, "tampered run identity must be rejected");
  } finally {
    rmSync(first, { recursive: true, force: true });
    rmSync(second, { recursive: true, force: true });
  }
});
