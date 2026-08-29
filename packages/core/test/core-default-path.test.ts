/**
 * Core clean-cutover regression guards.
 *
 * The v2 host has no neutral/default runtime configuration path: provider
 * policy and qualified identities are supplied by the validated host.
 *
 * <!-- omp-cto-slice run=01a03ee4-7dd6-7580-8ad7-16d26dc886ba slice=workflow-v2-core -->
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import * as coreBarrel from "../src/index.js";
import { createCanonicalRoot, isCanonicalRoot } from "../src/workflow-v2/identity.js";
import { resolveStageDispatchSlots, DevAgentUnavailableError } from "../src/engine/stage.js";
import { runtimeClassForScope } from "../src/engine/scope.js";
import { readWorkflowProfile, workflowV2Fixture } from "./workflow-v2-fixtures.js";

test("core barrel exposes no legacy authority, aliases, or domain defaults", () => {
  for (const removed of [
    "resolveConfig",
    "writeConfig",
    "writeRuntimeConfig",
    "resolveRuntimeConfigPath",
    "registerWorkflowCommands",
    "WorkflowCommandOptions",
    "commandPrefix",
    "namespace",
    "teamCommand",
    "findProfileDir",
    "resolveWorkflowProfilePath",
    "loadAllProfiles",
    "loadProfile",
    "registerWorkflowProfiles",
    "isRegisteredWorkflow",
    "matchesProfile",
    "profileHash",
    "selectProfile",
    "walkProfile",
    "agentMappingPath",
    "buildAgentMapping",
    "readAgentMapping",
    "writeAgentMapping",
    "AgentMappingOptions",
    "AgentMappingState",
    "MappingPreferencesProvenance",
    "WorkTeamConfig",
    "DEFAULT_ROLES",
    "DEFAULT_SCOPE_MAP",
    "DEFAULT_FLAGS",
    "DEFAULT_SCOPE_RUNTIME_CLASSES",
    "CORE_ENGINE_MARKER",
  ]) {
    assert.equal(removed in coreBarrel, false, `${removed} must not be a v2 public API`);
  }
});

test("core barrel exposes selected-provider v2 host, registry, policy, identity, and tool contracts", () => {
  for (const exposed of [
    "registerWorkflowV2Host",
    "createProviderRegistry",
    "lookupProvider",
    "publishProvider",
    "readPolicySnapshot",
    "parsePolicyBytes",
    "createCanonicalRoot",
    "buildProjectIdentity",
    "buildWorkflowRunIdentity",
    "validateProjectIdentity",
    "validateWorkflowRunIdentity",
    "projectRuntimeKeyFor",
    "createAdmissionBridge",
    "WORKFLOW_V2_CANONICAL_COMMANDS",
    "WORKFLOW_V2_WORKFLOW_TOOLS",
  ]) {
    assert.equal(typeof coreBarrel[exposed as keyof typeof coreBarrel], exposed.startsWith("WORKFLOW_V2_") ? "object" : "function", `${exposed} must remain public`);
  }
});

test("core roots are manager-provided canonical identities, never cwd fallbacks", () => {
  assert.equal(isCanonicalRoot("relative/project"), false);
  assert.equal(isCanonicalRoot("/tmp/../project"), false);
  assert.equal(createCanonicalRoot("/tmp/workflow-v2-project"), "/tmp/workflow-v2-project");
});

test("scope runtime classes remain caller data rather than built-in domain defaults", () => {
  assert.equal(runtimeClassForScope("backend-kotlin"), null);
  assert.equal(runtimeClassForScope("frontend"), null);
  assert.equal(runtimeClassForScope("mobile"), null);
});

const DEV_AGENT_STAGE = {
  id: "implementation",
  title: "Implementation",
  type: "single" as const,
  role: "${scope.dev_agent}",
};

const DEV_AGENT_FIXTURE = workflowV2Fixture(readWorkflowProfile("lightweight"), {
  roleAgents: { "${scope.dev_agent}": "developer-go" },
});
const DEV_AGENT_POLICY = {
  ...DEV_AGENT_FIXTURE.effective_policy,
  scope_map: [{
    patterns: ["**"],
    scope: "test",
    dev_agent: DEV_AGENT_FIXTURE.effective_policy.roles["${scope.dev_agent}"],
  }],
};
const DEV_AGENT_PROVIDER_CONTEXT = {
  project_identity: DEV_AGENT_FIXTURE.project_identity,
  run_identity: DEV_AGENT_FIXTURE.run_identity,
  catalog: DEV_AGENT_FIXTURE.catalog,
  effectivePolicy: DEV_AGENT_POLICY,
  agentInventory: DEV_AGENT_FIXTURE.agent_inventory,
};

test("${scope.dev_agent} fails closed with a typed error when the scope has no dev agent", () => {
  const ctx = {
    ...DEV_AGENT_PROVIDER_CONTEXT,
    cwd: "/tmp/workflow-v2-project",
    flags: { scope: [], has_security: false, has_infra: false, has_ui: false, has_runtime: false, dev_agent: null },
    resolveDevAgent: () => null as string | null,
  };
  assert.throws(
    () => resolveStageDispatchSlots(DEV_AGENT_STAGE, ctx),
    (error: unknown) => error instanceof DevAgentUnavailableError && error.message.includes("implementation"),
    "unresolved ${scope.dev_agent} must fail closed instead of substituting a domain agent",
  );
});

test("${scope.dev_agent} resolves only when the caller supplies a matching scope", () => {
  const ctx = {
    ...DEV_AGENT_PROVIDER_CONTEXT,
    cwd: "/tmp/workflow-v2-project",
    flags: { scope: [], has_security: false, has_infra: false, has_ui: false, has_runtime: false, dev_agent: "developer-go" },
    resolveDevAgent: () => "developer-go",
  };
  const slots = resolveStageDispatchSlots(DEV_AGENT_STAGE, ctx);
  assert.deepEqual(slots.map((slot) => slot.role), ["developer-go"]);
});
