/**
 * Gate-resolution regressions exercise the admitted protocol-v2 host boundary.
 *
 * <!-- omp-cto-slice run=01a03ee4-7dd6-7580-8ad7-16d26dc886ba slice=workflow-v2-core -->
 */

import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { registerTeamWorkflow } from "../src/index.js";
import { buildWorkflowRunIdentity } from "../src/workflow-v2/identity.js";
import {
  createAdmissionBridge,
  resetAdmissionForTests,
} from "../src/workflow-v2/admission.js";
import { successResult } from "../src/workflow-v2/diagnostics.js";
import {
  buildBindingDocument,
  writeBindingAfterConfirmation,
} from "../src/workflow-v2/binding.js";
import {
  canonicalPolicyJson,
  readPolicySnapshot,
} from "../src/workflow-v2/policy.js";
import {
  createTestDescriptorRelativeFsAuthority,
} from "../src/workflow-v2/fs-authority.js";
import type { TrustedFsAuthority } from "../src/workflow-v2/fs-authority.js";
import { digestImmutable } from "../src/workflow-v2/descriptor.js";
import {
  validateInvocation,
  WORKFLOW_V2_HOST_DESCRIPTOR,
} from "../src/workflow-v2/host.js";
import {
  createProviderRegistry,
  publishProvider,
} from "../src/workflow-v2/registry.js";
import type {
  ActualAgentInventory,
  AgentInventoryAuthority,
  PolicyDocument,
  ProfileIdentity,
  ProviderDispatchResult,
  ProviderId,
  ProviderRegistration,
  ProviderRegistry,
  ProviderRuntime,
  Profile,
  ProjectIdentity,
  SessionIdentity,
  WorkflowHost,
  WorkflowHostOptions,
  WorkflowRunIdentity,
} from "../src/workflow-v2/types.js";
import { workflowV2Fixture } from "./workflow-v2-fixtures.js";

const TEST_PROVIDER_ID = "@example/workflow-provider" as ProviderId;
const TEST_SESSION: SessionIdentity = Object.freeze({
  session_id: "gate-test-session",
  lifecycle_id: "gate-test-lifecycle",
});
const TEST_PROFILE: Profile = {
  name: "lightweight",
  title: "Gate-resolution fixture",
  description: "Minimal profile used to admit the gate test root.",
  match: { type: ["FEATURE"], complexity: ["QUICK"] },
  stages: [{
    id: "implementation",
    title: "Implementation",
    type: "single",
    role: "task",
    produces: "implementation",
  }],
};
const TEST_FIXTURE = workflowV2Fixture(TEST_PROFILE, {
  session: TEST_SESSION,
  roleAgents: { task: "task" },
  agentNames: ["task"],
});
const TEST_CATALOG = TEST_FIXTURE.catalog;

function trustedInventoryAuthority(): AgentInventoryAuthority {
  return {
    resolve(context) {
      const inventoryFingerprint = digestImmutable(TEST_FIXTURE.agent_inventory);
      const inventory: ActualAgentInventory = Object.freeze({
        authority: "omp",
        provider_id: context.provider_id,
        descriptor_fingerprint: context.descriptor_fingerprint,
        agents: Object.freeze([...TEST_FIXTURE.agent_inventory]),
        inventory_fingerprint: inventoryFingerprint,
        reservation: Object.freeze({
          reservation_id: "reservation-gate-test",
          fingerprint: inventoryFingerprint,
        }),
      });
      return successResult(inventory);
    },
  };
}

type ProviderFixture = {
  readonly registration: ProviderRegistration;
  readonly profile: ProfileIdentity;
};

type GateBlock = {
  readonly block?: boolean;
  readonly reason?: string;
  readonly diagnostic?: {
    readonly code?: string;
    readonly operation?: string;
  };
};

type HookHarness = {
  readonly pi: {
    registerCommand(name: string, definition: unknown): void;
    registerTool(definition: unknown): void;
    sendUserMessage(content: string): void;
    on(name: string, handler: (event: unknown, context: unknown) => unknown): void;
  };
  readonly registrations: string[];
  readonly handlers: Array<(event: unknown, context: unknown) => unknown>;
  readonly messages: string[];
};

type ConfiguredHarness = {
  readonly root: string;
  readonly registry: ProviderRegistry;
  readonly options: WorkflowHostOptions & { readonly observability: false };
  readonly provider: ProviderFixture;
};

function projectRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "omp-gate-resolution-v2-"));
  mkdirSync(join(root, ".omp"));
  mkdirSync(join(root, ".git"));
  return root;
}

function providerFixture(): ProviderFixture {
  const descriptor = TEST_FIXTURE.descriptor;
  const runtime: ProviderRuntime = {
    async dispatch(input): Promise<ProviderDispatchResult> {
      if (input.identity_level === "run") {
        return {
          identity_level: "run",
          project_identity: input.project_identity,
          run_identity: input.run_identity,
          runtime_key: input.runtime_key,
          status: "succeeded",
          evidence: "gate-resolution-fixture",
        };
      }
      return {
        identity_level: "project",
        project_identity: input.project_identity,
        runtime_key: input.runtime_key,
        status: "succeeded",
        evidence: "gate-resolution-fixture",
      };
    },
    shutdown() {},
  };
  return {
    registration: {
      descriptor,
      descriptor_fingerprint: TEST_FIXTURE.descriptor_fingerprint,
      catalog: TEST_CATALOG,
      createRuntime() {
        return runtime;
      },
    },
    profile: TEST_FIXTURE.profile_identity,
  };
}

function policyFor(provider: ProviderFixture): PolicyDocument {
  return {
    schema_version: 2,
    provider: {
      id: TEST_PROVIDER_ID,
      protocol_version: 2,
      descriptor_fingerprint: provider.registration.descriptor_fingerprint,
      catalog_content_digest: provider.registration.catalog.content_digest,
    },
    policy: {
      roles: {},
      scope_map: [],
      roster_overrides: [],
      flags: {},
      runtime_classes: {},
      ui_classes: {},
      design_system: null,
      commands: {
        "do-work": { fragments: [] },
        team: { alias_of: "do-work" },
        cto: { fragments: [] },
      },
      workflow: {
        selection: "fixed",
        profile_identity: provider.profile,
      },
      prompt_context: {},
      required_capabilities: [],
    },
  };
}

function configureRoot(root: string, provider: ProviderFixture, filesystemAuthority: TrustedFsAuthority): void {
  const document = policyFor(provider);
  writeFileSync(join(root, ".omp", "team.config.json"), `${canonicalPolicyJson(document)}\n`, "utf8");
  const snapshot = readPolicySnapshot(root, filesystemAuthority);
  if (!snapshot.ok) throw new Error(`gate fixture policy setup failed: ${snapshot.diagnostics[0]?.code ?? "unknown"}`);
  const binding = buildBindingDocument(root, {
    provider_id: TEST_PROVIDER_ID,
    descriptor_fingerprint: provider.registration.descriptor_fingerprint,
    executable_provenance: provider.registration.descriptor.executable_provenance,
    catalog_content_digest: provider.registration.catalog.content_digest,
    config_byte_sha256: snapshot.value.byte_sha256,
    config_semantic_sha256: snapshot.value.semantic_sha256,
    session: TEST_SESSION,
  }, filesystemAuthority);
  if (!binding.ok) throw new Error(`gate fixture binding setup failed: ${binding.diagnostics[0]?.code ?? "unknown"}`);
  const written = writeBindingAfterConfirmation({
    root,
    document: binding.value,
    confirm_root: true,
  }, filesystemAuthority);
  if (!written.ok) throw new Error(`gate fixture binding write failed: ${written.diagnostics[0]?.code ?? "unknown"}`);
}

function optionsFor(root: string, registry: ProviderRegistry, filesystemAuthority: TrustedFsAuthority): ConfiguredHarness["options"] {
  return {
    registry,
    admission: createAdmissionBridge(),
    host: WORKFLOW_V2_HOST_DESCRIPTOR,
    resolveRoot: () => root,
    resolveSession: () => TEST_SESSION,
    filesystemAuthority,
    agentInventoryAuthority: trustedInventoryAuthority(),
    observability: false,
  };
}

function configuredHarness(root: string): ConfiguredHarness {
  const provider = providerFixture();
  const registry = createProviderRegistry();
  const published = publishProvider(registry, provider.registration);
  if (!published.ok) throw new Error(`gate fixture provider setup failed: ${published.diagnostics[0]?.code ?? "unknown"}`);
  const filesystemAuthority = createTestDescriptorRelativeFsAuthority();
  configureRoot(root, provider, filesystemAuthority);
  return {
    root,
    registry,
    options: optionsFor(root, registry, filesystemAuthority),
    provider,
  };
}

function admittedProject(options: WorkflowHostOptions): ProjectIdentity {
  const validated = validateInvocation({
    operation: "tool",
    name: "workflow_prepare",
    args: {},
    context: {},
  }, options);
  if (!validated.ok || validated.value.identity_level !== "project") {
    throw new Error(`gate fixture project setup failed: ${validated.ok ? "unexpected identity level" : validated.diagnostics[0]?.code ?? "unknown"}`);
  }
  return validated.value.project_identity;
}

function admittedRun(options: WorkflowHostOptions, runId = "gate-run"): WorkflowRunIdentity {
  const result = buildWorkflowRunIdentity({
    project_identity: admittedProject(options),
    run_id: runId,
    profile_identity: TEST_FIXTURE.profile_identity,
  });
  if (!result.ok) throw new Error(`gate fixture run setup failed: ${result.diagnostics[0]?.code ?? "unknown"}`);
  return result.value;
}

function fakeExtension(): HookHarness {
  const registrations: string[] = [];
  const handlers: Array<(event: unknown, context: unknown) => unknown> = [];
  const messages: string[] = [];
  return {
    registrations,
    handlers,
    messages,
    pi: {
      registerCommand() {},
      registerTool() {},
      sendUserMessage(content) {
        messages.push(content);
      },
      on(name, handler) {
        registrations.push(name);
        if (name === "tool_call") handlers.push(handler);
      },
    },
  };
}

function minimalState(run_identity: WorkflowRunIdentity) {
  const project_identity: ProjectIdentity = {
    root_instance_id: run_identity.root_instance_id,
    provider_id: run_identity.provider_id,
    descriptor_fingerprint: run_identity.descriptor_fingerprint,
    executable_provenance: run_identity.executable_provenance,
    catalog_content_digest: run_identity.catalog_content_digest,
    config_byte_sha256: run_identity.config_byte_sha256,
    config_semantic_sha256: run_identity.config_semantic_sha256,
    session: run_identity.session,
  };
  return {
    schema: 1,
    branch: "feature/gates",
    project_identity,
    run_identity,
    classification: {
      type: "FEATURE",
      complexity: "QUICK",
      confidence: "HIGH",
      workflow: "lightweight",
      autonomous: false,
    },
    workflow: "lightweight",
    task: "gate regression",
    issue: null,
    workflow_override: false,
    stage_cursor: "implementation",
    cursor_epoch: "gate-test-epoch",
    run_key: run_identity.run_id,
    profile_hash: run_identity.profile_identity.fingerprint,
    stages: [{ id: "implementation", status: "in_progress" }],
    artifacts: {},
    pause: { kind: "none", reason: "" },
    updated_at: new Date(0).toISOString(),
  };
}

function writeLegacyState(root: string, state: unknown): void {
  mkdirSync(join(root, ".work-state"), { recursive: true });
  writeFileSync(join(root, ".work-state", "team-state.json"), JSON.stringify(state), "utf8");
}

function writeActiveState(root: string, state: unknown): void {
  const featureDir = join(root, ".work-state", "features", "gate-regression");
  mkdirSync(join(featureDir, "artifacts"), { recursive: true });
  writeFileSync(join(root, ".work-state", ".active-feature"), "gate-regression\n", "utf8");
  writeFileSync(join(featureDir, "state.json"), JSON.stringify(state), "utf8");
}

afterEach(() => {
  resetAdmissionForTests();
});

test("runtime registers the canonical tool-call gate chain in order", async () => {
  const root = projectRoot();
  const filesystemAuthority = createTestDescriptorRelativeFsAuthority();
  let host: WorkflowHost | undefined;
  try {
    const extension = fakeExtension();
    host = registerTeamWorkflow(extension.pi as never, optionsFor(root, createProviderRegistry(), filesystemAuthority));
    const toolCallIndex = extension.registrations.indexOf("tool_call");
    assert.ok(toolCallIndex >= 2);
    assert.deepEqual(extension.registrations.slice(toolCallIndex - 2, toolCallIndex + 1), [
      "before_agent_start",
      "session_stop",
      "tool_call",
    ]);
    assert.equal(extension.handlers.length, 1);

    // A v2 host must not let an unconfigured root pass its gates.
    const result = extension.handlers[0]!({ toolName: "task", input: { task: "ordinary task" } }, { cwd: root }) as GateBlock | undefined;
    assert.equal(result?.block, true);
    assert.equal(result?.diagnostic?.code, "CONFIG_MISSING");
  } finally {
    await host?.shutdown();
    rmSync(root, { recursive: true, force: true });
  }
});

test("armed malformed state is rejected before dispatch can be authorized", async () => {
  const root = projectRoot();
  let host: WorkflowHost | undefined;
  try {
    const configured = configuredHarness(root);
    const extension = fakeExtension();
    host = registerTeamWorkflow(extension.pi as never, configured.options);
    const run_identity = admittedRun(configured.options);
    writeLegacyState(root, { ...minimalState(run_identity), policy: { strict_orchestrator: true } });
    const result = extension.handlers[0]!(
      { toolName: "task", input: { task: "prompt-only" } },
      { cwd: root, run_identity },
    ) as GateBlock | undefined;
    assert.equal(result?.block, true);
    assert.equal(result?.diagnostic?.code, "MIGRATION_REQUIRED");
    assert.match(result?.reason ?? "", /migrat|state/i);
    assert.equal(extension.messages.length, 0);
  } finally {
    await host?.shutdown();
    rmSync(root, { recursive: true, force: true });
  }
});

test("malformed classification task is fail-closed through the actual gate chain", async () => {
  const root = projectRoot();
  let host: WorkflowHost | undefined;
  try {
    const configured = configuredHarness(root);
    const extension = fakeExtension();
    host = registerTeamWorkflow(extension.pi as never, configured.options);
    const run_identity = admittedRun(configured.options);
    writeActiveState(root, {
      ...minimalState(run_identity),
      classification: {
        complexity: "QUICK",
        confidence: "HIGH",
        workflow: "lightweight",
        autonomous: false,
      },
    });
    const result = extension.handlers[0]!(
      { toolName: "task", input: { task: "prompt-only" } },
      { cwd: root, run_identity },
    ) as GateBlock | undefined;
    assert.equal(result?.block, true);
    assert.equal(result?.diagnostic?.code, "CONFIG_MALFORMED");
    assert.match(result?.reason ?? "", /classification|workflow/i);
    assert.equal(extension.messages.length, 0);
  } finally {
    await host?.shutdown();
    rmSync(root, { recursive: true, force: true });
  }
});
