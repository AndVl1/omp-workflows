/**
 * V2 ownership and eager-host security contracts.
 *
 * <!-- omp-cto-slice run=01a03ee4-7dd6-7580-8ad7-16d26dc886ba slice=workflow-v2-core -->
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  buildProjectIdentity,
  buildWorkflowRunIdentity,
  claimWorkflowOwner,
  projectRuntimeKeyFor,
  registerTeamWorkflow,
  resetWorkflowOwners,
  workflowOwnerFor,
  type WorkflowOwnerIdentity,
} from "../src/index.js";
import { createProviderRegistry } from "../src/workflow-v2/registry.js";
import {
  WORKFLOW_V2_CANONICAL_COMMANDS,
  WORKFLOW_V2_HOST_CAPABILITIES,
  WORKFLOW_V2_WORKFLOW_TOOLS,
  createAdmissionBridge,
  resetAdmissionForTests,
} from "../src/workflow-v2/admission.js";
import { successResult } from "../src/workflow-v2/diagnostics.js";
import { digestImmutable } from "../src/workflow-v2/descriptor.js";
import {
  WORKFLOW_V2_HOST_DESCRIPTOR,
  WorkflowV2HostAdmissionError,
  registerWorkflowV2Host,
} from "../src/workflow-v2/host.js";
import {
  createTestDescriptorRelativeFsAuthority,
} from "../src/workflow-v2/fs-authority.js";
import type { TrustedFsAuthority } from "../src/workflow-v2/fs-authority.js";
import type {
  AgentInventoryAuthority,
  ProjectIdentityInput,
  ProviderId,
  WorkflowHostOptions,
  WorkflowV2Digest,
} from "../src/workflow-v2/types.js";

const providerId = "@example/workflow-provider" as ProviderId;
const digest = (value: string): WorkflowV2Digest => `sha256:${value.repeat(64)}` as WorkflowV2Digest;
const hostAuthority: AgentInventoryAuthority = {
  resolve(context) {
    return successResult(Object.freeze({
      authority: "omp" as const,
      provider_id: context.provider_id,
      descriptor_fingerprint: context.descriptor_fingerprint,
      agents: Object.freeze([]),
      inventory_fingerprint: digestImmutable([]),
    }));
  },
};

function identity(overrides: Partial<ProjectIdentityInput> = {}) {
  const result = buildProjectIdentity({
    root_instance_id: digest("a"),
    provider_id: providerId,
    descriptor_fingerprint: digest("b"),
    executable_provenance: {
      build_fingerprint: digest("f"),
      runtime_fingerprint: digest("0"),
    },
    catalog_content_digest: digest("c"),
    config_byte_sha256: digest("d"),
    config_semantic_sha256: digest("e"),
    session: { session_id: "session-1", lifecycle_id: "lifecycle-1" },
    ...overrides,
  });
  if (!result.ok) throw new Error(result.diagnostics.map((entry) => entry.code).join(","));
  return result.value;
}

function owner(ownerId: string, cwd: string): WorkflowOwnerIdentity {
  return {
    owner_id: ownerId,
    bundle_id: ownerId,
    owner_kind: "private_omp",
    activation_marker: `${ownerId}-activation`,
    host_range: ">=17 <19",
    provenance: {
      package: ownerId,
      entrypoint: "dist/index.js",
      cwd,
      config_path: join(cwd, ".omp", "team.config.json"),
    },
  };
}

test("owner claims require complete project identity and stable runtime keys", () => {
  const root = mkdtempSync(join(tmpdir(), "omp-owner-v2-"));
  const firstIdentity = identity();
  const secondIdentity = identity({ root_instance_id: digest("f") });
  try {
    const first = claimWorkflowOwner(firstIdentity, "workflow_registration", owner("bundle-one", root));
    assert.equal(first.ok, true);
    if (!first.ok) return;
    assert.equal(first.claim.project_runtime_key, projectRuntimeKeyFor(firstIdentity));
    assert.deepEqual(first.claim.project_identity, firstIdentity);
    assert.equal("run_id" in firstIdentity, false);
    assert.equal("profile_identity" in firstIdentity, false);
    const prepared = buildWorkflowRunIdentity({
      project_identity: firstIdentity,
      run_id: "run-1",
      profile_identity: { id: "standard", fingerprint: digest("1") },
    });
    assert.equal(prepared.ok, true);
    if (prepared.ok) {
      assert.equal(projectRuntimeKeyFor(prepared.value), projectRuntimeKeyFor(firstIdentity));
    }

    const repeat = claimWorkflowOwner(firstIdentity, "workflow_registration", owner("bundle-one", root));
    assert.equal(repeat.ok, true);
    assert.equal(repeat.ok && repeat.idempotent, true);

    const conflict = claimWorkflowOwner(firstIdentity, "workflow_registration", owner("bundle-two", root));
    assert.equal(conflict.ok, false);
    if (!conflict.ok) {
      assert.equal(conflict.diagnostics[0]?.code, "OWNER_CONFLICT");
      assert.equal(conflict.claim?.owner.owner_id, "bundle-one");
    }
    assert.equal(workflowOwnerFor(firstIdentity, "workflow_registration")?.owner.owner_id, "bundle-one");

    const changedIdentity = claimWorkflowOwner(secondIdentity, "workflow_registration", owner("bundle-two", root));
    assert.equal(changedIdentity.ok, true, "a fresh identity may claim only its own identity key");
  } finally {
    resetWorkflowOwners(firstIdentity);
    resetWorkflowOwners(secondIdentity);
    rmSync(root, { recursive: true, force: true });
  }
});

test("cwd-only ownership inputs fail with a typed identity diagnostic", () => {
  const root = mkdtempSync(join(tmpdir(), "omp-owner-invalid-"));
  try {
    const result = claimWorkflowOwner(root as never, "workflow_registration", owner("bundle-one", root));
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.diagnostics[0]?.code, "IDENTITY_MISMATCH");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

type HostHarness = {
  readonly commands: string[];
  readonly tools: string[];
  readonly pi: {
    registerCommand(name: string, command: unknown): void;
    registerTool(tool: { readonly name?: string }): void;
  };
};

function hostHarness(): HostHarness {
  const commands: string[] = [];
  const tools: string[] = [];
  return {
    commands,
    tools,
    pi: {
      registerCommand(name) {
        commands.push(name);
      },
      registerTool(tool) {
        if (tool.name) tools.push(tool.name);
      },
    },
  };
}
function hostOptions(filesystemAuthority: TrustedFsAuthority, root = "/tmp/workflow-v2-host-root"): WorkflowHostOptions {
  return {
    registry: createProviderRegistry(),
    admission: createAdmissionBridge(),
    host: WORKFLOW_V2_HOST_DESCRIPTOR,
    resolveRoot: () => root,
    resolveSession: () => ({ session_id: "session-1", lifecycle_id: "lifecycle-1" }),
    filesystemAuthority,
    agentInventoryAuthority: hostAuthority,
  };
}

test("one admitted host owns the exact five commands and seven workflow tools", async () => {
  resetAdmissionForTests();
  const filesystemAuthority = createTestDescriptorRelativeFsAuthority();
  try {
    const first = hostHarness();
    const host = registerWorkflowV2Host(first.pi as never, hostOptions(filesystemAuthority));
    assert.deepEqual(first.commands, [...WORKFLOW_V2_CANONICAL_COMMANDS]);
    assert.deepEqual(first.tools, [...WORKFLOW_V2_WORKFLOW_TOOLS]);
    assert.equal(WORKFLOW_V2_HOST_DESCRIPTOR.capabilities.includes("workflow_registration"), true);
    assert.deepEqual([...WORKFLOW_V2_HOST_CAPABILITIES].sort(), [...WORKFLOW_V2_HOST_DESCRIPTOR.capabilities].sort());

    const second = hostHarness();
    assert.throws(
      () => registerWorkflowV2Host(second.pi as never, hostOptions(filesystemAuthority)),
      (error: unknown) => error instanceof WorkflowV2HostAdmissionError
        && error.diagnostics[0]?.code === "OWNER_CONFLICT",
    );
    assert.deepEqual(second.commands, []);
    assert.deepEqual(second.tools, []);
    await host.shutdown();
  } finally {
    resetAdmissionForTests();
  }
});

test("registerTeamWorkflow refuses cwd-only hook context before gates or durable authorization", async () => {
  resetAdmissionForTests();
  const root = mkdtempSync(join(tmpdir(), "omp-register-v2-"));
  const filesystemAuthority = createTestDescriptorRelativeFsAuthority();
  const hooks = new Map<string, (event: unknown, context: unknown) => unknown>();
  const prompts: string[] = [];
  const pi = {
    registerCommand(_name: string, _command: unknown): void {},
    registerTool(_tool: unknown): void {},
    sendUserMessage(prompt: string): void {
      prompts.push(prompt);
    },
    on(name: string, handler: (event: unknown, context: unknown) => unknown): void {
      if (!hooks.has(name)) hooks.set(name, handler);
    },
  };
  try {
    const host = registerTeamWorkflow(pi as never, hostOptions(filesystemAuthority, root));
    const toolCall = hooks.get("tool_call");
    assert.ok(toolCall, "the admitted host must install one tool-call gate callback");
    if (!toolCall) return;
    const result = toolCall({ toolName: "task", input: { task: "must not dispatch" } }, { cwd: root });
    assert.ok(result && typeof result === "object");
    if (!result || typeof result !== "object") return;
    const blocked = result as Record<string, unknown>;
    assert.equal(blocked.block, true);
    assert.match(String(blocked.reason), /CONFIG_MISSING|MIGRATION_REQUIRED/);
    assert.equal(prompts.length, 0, "failed host-context validation must not send a prompt");
    await host.shutdown();
  } finally {
    resetAdmissionForTests();
    rmSync(root, { recursive: true, force: true });
  }
});
