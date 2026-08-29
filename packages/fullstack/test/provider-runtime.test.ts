import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  buildBindingDocument,
  buildProviderAgentInventory,
  canonicalPolicyJson,
  createAdmissionBridge,
  createProviderRegistry,
  dispatchInvocation,
  readPolicySnapshot,
  registerWorkflowV2Host,
  successResult,
  validateInvocation,
  WORKFLOW_V2_HOST_DESCRIPTOR,
  writeBindingAfterConfirmation,
  type AgentInventoryAuthority,
  type CanonicalRoot,
  type DiagnosticResult,
  type PolicyDocument,
  type ProviderRuntimeContext,
  type ProviderId,
  type ProviderRegistry,
  type ValidatedDispatch,
  type WorkflowHostOptions,
  type WorkflowV2Digest,
} from "@andvl1/omp-workflows-core";
import {
  createTestDescriptorRelativeFsAuthority,
} from "../../core/dist/workflow-v2/fs-authority.js";
import { digestImmutable } from "../../core/dist/workflow-v2/descriptor.js";
import { resetAdmissionForTests } from "../../core/dist/workflow-v2/admission.js";
import {
  FULLSTACK_PROVIDER_CATALOG,
  FULLSTACK_PROVIDER_CATALOG_CONTENT_DIGEST,
  FULLSTACK_PROVIDER_DESCRIPTOR,
  FULLSTACK_PROVIDER_DESCRIPTOR_FINGERPRINT,
  FULLSTACK_PROVIDER_ID,
  publishFullstackProvider,
} from "../src/provider.js";
import { createFullstackProviderRuntime } from "../src/provider-runtime.js";

type FakeCommand = {
  readonly handler: (args: string, context: unknown) => void | Promise<void>;
};

type FakePi = {
  readonly commands: Map<string, FakeCommand>;
  readonly messages: string[];
  registerCommand(name: string, definition: FakeCommand): void;
  registerTool(definition: { readonly name: string }): void;
  sendUserMessage(prompt: string): void;
};

type PreparedFixture = {
  readonly root: string;
  readonly registry: ProviderRegistry;
  readonly options: WorkflowHostOptions;
  readonly dispatch: ValidatedDispatch;
  readonly context: ProviderRuntimeContext;
};

const DEFAULT_SESSION = Object.freeze({
  session_id: "fullstack-runtime-test-session",
  lifecycle_id: "fullstack-runtime-test-lifecycle",
});
const FOREIGN_PROVIDER_ID = "@foreign/fullstack" as ProviderId;
const INVALID_DIGEST = `sha256:${"0".repeat(64)}` as WorkflowV2Digest;
const roots = new Set<string>();

function projectRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "omp-fullstack-runtime-"));
  mkdirSync(join(root, ".omp"));
  mkdirSync(join(root, ".git"));
  roots.add(root);
  return root;
}

function policyDocument(): PolicyDocument {
  return {
    schema_version: 2,
    provider: {
      id: FULLSTACK_PROVIDER_ID,
      protocol_version: 2,
      descriptor_fingerprint: FULLSTACK_PROVIDER_DESCRIPTOR_FINGERPRINT,
      catalog_content_digest: FULLSTACK_PROVIDER_CATALOG_CONTENT_DIGEST,
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
      workflow: { selection: "matrix" },
      prompt_context: {},
      required_capabilities: [],
    },
  };
}

function inventoryAuthority(): AgentInventoryAuthority {
  return {
    resolve(context) {
      const agents = buildProviderAgentInventory(context.descriptor);
      const inventory_fingerprint = digestImmutable(agents);
      return successResult(Object.freeze({
        authority: "omp" as const,
        provider_id: context.provider_id,
        descriptor_fingerprint: context.descriptor_fingerprint,
        agents,
        inventory_fingerprint,
        reservation: Object.freeze({
          reservation_id: "fullstack-runtime-test-reservation",
          fingerprint: inventory_fingerprint,
        }),
      }));
    },
  };
}

function fakePi(): FakePi {
  const commands = new Map<string, FakeCommand>();
  const messages: string[] = [];
  return {
    commands,
    messages,
    registerCommand(name, definition) {
      commands.set(name, definition);
    },
    registerTool() {},
    sendUserMessage(prompt) {
      messages.push(prompt);
    },
  };
}

function unwrap<T>(result: DiagnosticResult<T>): T {
  if (!result.ok) throw new Error(result.diagnostics[0]?.remediation ?? "test setup failed");
  return result.value;
}

function cloneImmutable<T>(value: T): T {
  if (Array.isArray(value)) {
    return Object.freeze(value.map((entry) => cloneImmutable(entry))) as T;
  }
  if (value !== null && typeof value === "object") {
    return Object.freeze(Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .map(([key, entry]) => [key, cloneImmutable(entry)]),
    )) as T;
  }
  return value;
}

function cloneValidatedDispatch(dispatch: ValidatedDispatch): ValidatedDispatch {
  return Object.freeze({
    ...dispatch,
    request: cloneImmutable(dispatch.request),
    snapshot: cloneImmutable(dispatch.snapshot),
    binding: cloneImmutable(dispatch.binding),
    project_identity: cloneImmutable(dispatch.project_identity),
    descriptor: cloneImmutable(dispatch.descriptor),
    catalog: cloneImmutable(dispatch.catalog),
    effective_policy: cloneImmutable(dispatch.effective_policy),
    agent_inventory: cloneImmutable(dispatch.agent_inventory),
    // The activation proof is deliberately retained by identity; the core
    // validator treats a structural copy as a missing capability.
    ...(dispatch.identity_level === "run"
      ? { run_identity: cloneImmutable(dispatch.run_identity) }
      : {}),
  }) as ValidatedDispatch;
}

function prepareFixture(): PreparedFixture {
  const root = projectRoot();
  const filesystemAuthority = createTestDescriptorRelativeFsAuthority();
  const registry = createProviderRegistry();
  const published = publishFullstackProvider(registry);
  assert.equal(published.ok, true);
  if (!published.ok) throw new Error("fullstack provider publication failed");
  assert.notEqual(published.value.descriptor, FULLSTACK_PROVIDER_DESCRIPTOR);
  assert.notEqual(published.value.catalog, FULLSTACK_PROVIDER_CATALOG);

  writeFileSync(join(root, ".omp", "team.config.json"), `${canonicalPolicyJson(policyDocument())}\n`, "utf8");
  const snapshot = unwrap(readPolicySnapshot(root, filesystemAuthority));
  const binding = unwrap(buildBindingDocument(root, {
    provider_id: FULLSTACK_PROVIDER_ID,
    descriptor_fingerprint: FULLSTACK_PROVIDER_DESCRIPTOR_FINGERPRINT,
    executable_provenance: FULLSTACK_PROVIDER_DESCRIPTOR.executable_provenance,
    catalog_content_digest: FULLSTACK_PROVIDER_CATALOG_CONTENT_DIGEST,
    config_byte_sha256: snapshot.byte_sha256,
    config_semantic_sha256: snapshot.semantic_sha256,
    session: DEFAULT_SESSION,
  }, filesystemAuthority));
  unwrap(writeBindingAfterConfirmation({
    root: root as CanonicalRoot,
    document: binding,
    confirm_root: true,
  }, filesystemAuthority));

  const options: WorkflowHostOptions = {
    registry,
    admission: createAdmissionBridge(),
    host: WORKFLOW_V2_HOST_DESCRIPTOR,
    resolveRoot: () => root,
    resolveSession: () => DEFAULT_SESSION,
    filesystemAuthority,
    agentInventoryAuthority: inventoryAuthority(),
  };
  const dispatch = unwrap(validateInvocation(
    { operation: "tool", name: "workflow_prepare", args: {}, context: {} },
    options,
  ));
  const context: ProviderRuntimeContext = Object.freeze({
    project_identity: dispatch.project_identity,
    runtime_key: dispatch.runtime_key,
    canonical_root: dispatch.snapshot.root,
    descriptor: dispatch.descriptor,
    catalog: dispatch.catalog,
    effective_policy: dispatch.effective_policy,
    agent_inventory: dispatch.agent_inventory,
    activation_admission: dispatch.activation_admission,
  });
  return { root, registry, options, dispatch, context };
}

afterEach(() => {
  resetAdmissionForTests();
  for (const root of roots) rmSync(root, { recursive: true, force: true });
  roots.clear();
});


test("core host activates fullstack from the cloned ProviderRecord descriptor and catalog", async () => {
  const fixture = prepareFixture();
  const pi = fakePi();
  const host = registerWorkflowV2Host(pi as never, fixture.options);
  const command = pi.commands.get("do-work");
  assert.ok(command);

  await command.handler("exercise cloned provider", {});

  assert.equal(pi.messages.length, 1);
  assert.match(pi.messages[0] ?? "", /provider: @andvl1\/omp-workflows-fullstack/);
  await host.shutdown();
});

test("core host dispatch admits an exact cloned ValidatedDispatch and rejects foreign, descriptor-tampered, or policy-tampered clones", async () => {
  const fixture = prepareFixture();
  const pi = fakePi();
  const host = registerWorkflowV2Host(pi as never, fixture.options);
  const prepared = fixture.dispatch;
  const preparedClone = cloneValidatedDispatch(prepared);
  assert.notEqual(preparedClone.project_identity, prepared.project_identity);
  assert.notEqual(preparedClone.descriptor, prepared.descriptor);
  assert.notEqual(preparedClone.catalog, prepared.catalog);
  assert.notEqual(preparedClone.effective_policy, prepared.effective_policy);

  const contextPolicyClone = cloneImmutable(fixture.context.effective_policy);
  assert.notEqual(contextPolicyClone, fixture.context.activation_admission.authority_context.effective_policy);
  const runtime = createFullstackProviderRuntime({
    ...fixture.context,
    effective_policy: contextPolicyClone,
  });
  let mode: "exact" | "foreign" | "tampered" | "tampered-policy" = "exact";
  const cloneBoundaryRuntime = Object.freeze({
    dispatch(input: ValidatedDispatch) {
      const clone = cloneValidatedDispatch(input);
      if (mode === "foreign") {
        return runtime.dispatch(Object.freeze({
          ...clone,
          project_identity: Object.freeze({
            ...clone.project_identity,
            provider_id: FOREIGN_PROVIDER_ID,
          }),
        }));
      }
      if (mode === "tampered") {
        const descriptor = cloneImmutable({
          ...clone.descriptor,
          executable_provenance: {
            ...clone.descriptor.executable_provenance,
            runtime_fingerprint: INVALID_DIGEST,
          },
        }) as typeof clone.descriptor;
        return runtime.dispatch(Object.freeze({ ...clone, descriptor }));
      }
      if (mode === "tampered-policy") {
        const effective_policy = cloneImmutable({
          ...clone.effective_policy,
          flags: {
            ...clone.effective_policy.flags,
            "tampered-policy": true,
          },
        }) as typeof clone.effective_policy;
        return runtime.dispatch(Object.freeze({ ...clone, effective_policy }));
      }
      return runtime.dispatch(clone);
    },
    shutdown() {
      return runtime.shutdown();
    },
  });
  const runtimes = new Map([[prepared.runtime_key, {
    project_identity: prepared.project_identity,
    runtime: cloneBoundaryRuntime,
  }]]);
  const request = { operation: "tool" as const, name: "workflow_prepare" as const, args: {}, context: {} };

  const admitted = await dispatchInvocation(request, fixture.options, { runtimes });
  assert.equal(admitted.ok, true);
  if (!admitted.ok) return;
  const admittedResult = admitted.value as { readonly status: string; readonly evidence: string };
  assert.equal(admittedResult.status, "failed");
  assert.match(admittedResult.evidence, /phase-3 host executor/u);

  mode = "foreign";
  const foreign = await dispatchInvocation(request, fixture.options, { runtimes });
  assert.equal(foreign.ok, false);
  if (foreign.ok) return;
  assert.equal(foreign.diagnostics[0]?.code, "IDENTITY_MISMATCH");

  mode = "tampered";
  const tampered = await dispatchInvocation(request, fixture.options, { runtimes });
  assert.equal(tampered.ok, true);
  if (!tampered.ok) return;
  const tamperedResult = tampered.value as { readonly status: string; readonly evidence: string };
  assert.equal(tamperedResult.status, "failed");
  assert.doesNotMatch(tamperedResult.evidence, /phase-3 host executor/u);

  mode = "tampered-policy";
  const tamperedPolicy = await dispatchInvocation(request, fixture.options, { runtimes });
  assert.equal(tamperedPolicy.ok, true);
  if (!tamperedPolicy.ok) return;
  const tamperedPolicyResult = tamperedPolicy.value as { readonly status: string; readonly evidence: string };
  assert.equal(tamperedPolicyResult.status, "failed");
  assert.doesNotMatch(tamperedPolicyResult.evidence, /phase-3 host executor/u);

  runtime.shutdown();
  await host.shutdown();
});

test("runtime admission rejects a foreign same-shape provider identity", () => {
  const fixture = prepareFixture();
  const foreignIdentity = Object.freeze({
    ...fixture.context.project_identity,
    provider_id: FOREIGN_PROVIDER_ID,
  });

  assert.throws(
    () => createFullstackProviderRuntime({
      ...fixture.context,
      project_identity: foreignIdentity,
    }),
    TypeError,
  );
});

test("runtime admission rejects a catalog digest mismatch before proof validation", () => {
  const fixture = prepareFixture();
  const mismatchedCatalog = Object.freeze({
    ...fixture.context.catalog,
    content_digest: INVALID_DIGEST,
  });

  assert.throws(
    () => createFullstackProviderRuntime({
      ...fixture.context,
      catalog: mismatchedCatalog,
    }),
    TypeError,
  );
});

test("runtime admission rejects an effective policy digest mismatch before proof validation", () => {
  const fixture = prepareFixture();
  const tamperedPolicy = cloneImmutable({
    ...fixture.context.effective_policy,
    flags: {
      ...fixture.context.effective_policy.flags,
      "tampered-policy": true,
    },
  });

  assert.throws(
    () => createFullstackProviderRuntime({
      ...fixture.context,
      effective_policy: tamperedPolicy,
    }),
    TypeError,
  );
});

test("runtime rejects effective-policy mutation after immutable digest capture", async () => {
  const fixture = prepareFixture();
  const mutablePolicy = structuredClone(fixture.context.effective_policy);
  const mutableFlags = mutablePolicy.flags as Record<string, boolean>;
  const runtime = createFullstackProviderRuntime({
    ...fixture.context,
    effective_policy: mutablePolicy,
  });
  mutableFlags["post-construction-tamper"] = true;

  const result = await runtime.dispatch(cloneValidatedDispatch(fixture.dispatch));
  assert.equal(result.status, "failed");
  assert.doesNotMatch(result.evidence, /phase-3 host executor/u);
  runtime.shutdown();
});

