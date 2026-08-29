/**
 * Focused protocol-v2 host tests.
 * <!-- omp-cto-slice run=01a03ee4-7dd6-7580-8ad7-16d26dc886ba slice=workflow-v2-core -->
 */

import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import {
  createAdmissionBridge,
  resetAdmissionForTests,
} from "../src/workflow-v2/admission.js";
import { successResult } from "../src/workflow-v2/diagnostics.js";
import { createProviderCatalog } from "../src/workflow-v2/index.js";
import {
  createTestDescriptorRelativeFsAuthority,
} from "../src/workflow-v2/fs-authority.js";
import type { TrustedFsAuthority } from "../src/workflow-v2/fs-authority.js";
import {
  buildBindingDocument,
  writeBindingAfterConfirmation,
} from "../src/workflow-v2/binding.js";
import {
  canonicalPolicyJson,
  readPolicySnapshot,
} from "../src/workflow-v2/policy.js";
import {
  computeDescriptorFingerprint,
  digestImmutable,
} from "../src/workflow-v2/descriptor.js";
import {
  createProviderRegistry,
  getProviderRegistry,
  listProviders,
  publishProvider,
} from "../src/workflow-v2/registry.js";
import {
  buildWorkflowRunIdentity,
} from "../src/workflow-v2/identity.js";
import { transactionJournalPath, type TransactionJournal } from "../src/workflow-v2/transaction.js";
import {
  WORKFLOW_V2_HOST_DESCRIPTOR,
  WorkflowV2HostAdmissionError,
  dispatchInvocation,
  registerWorkflowV2Host,
  validateInvocation,
  validateProviderActivationAdmission,
} from "../src/workflow-v2/host.js";
import type {
  ProviderActivationAdmission,
  ProviderActivationAdmissionExpectation,
  ActualAgentInventory,
  AgentInventoryAuthority,
  AgentRef,
  CanonicalRoot,
  DiagnosticResult,
  PolicyDocument,
  PolicyProviderRef,
  PolicySnapshot,
  Profile,
  ProfileIdentity,
  ProjectIdentity,
  ProviderCapability,
  ProviderDescriptor,
  ProviderDispatchResult,
  ProviderId,
  ProviderRegistration,
  ProviderRuntime,
  ProviderRuntimeContext,
  ProviderRegistry,
  SessionIdentity,
  ValidatedDispatch,
  WorkflowHostOptions,
  WorkflowPolicy,
  WorkflowRunIdentity,
  WorkflowV2Digest,
} from "../src/workflow-v2/types.js";


type CommandHandler = (args: string, context: unknown) => void | Promise<void>;
type ToolExecutor = (...args: unknown[]) => Promise<unknown>;

type FakeExtension = {
  readonly pi: ExtensionAPI;
  readonly commands: Map<string, { readonly handler: CommandHandler }>;
  readonly tools: Map<string, { readonly execute: ToolExecutor }>;
  readonly messages: string[];
  readonly notifications: string[];
};

type RuntimeProbe = {
  factoryCalls: number;
  dispatchCalls: number;
  shutdownCalls: number;
  contexts: ProviderRuntimeContext[];
  dispatches: ValidatedDispatch[];
};

type ProviderFixture = {
  readonly providerId: ProviderId;
  readonly registration: ProviderRegistration;
  readonly probe: RuntimeProbe;
  readonly actualAgents: readonly AgentRef[];
};

const DEFAULT_PROVIDER_ID = "@example/workflow-provider" as ProviderId;
const DEFAULT_SOURCE_FINGERPRINT = `sha256:${"b".repeat(64)}` as WorkflowV2Digest;
const DEFAULT_BUILD_FINGERPRINT = `sha256:${"c".repeat(64)}` as WorkflowV2Digest;
const DEFAULT_RUNTIME_FINGERPRINT = `sha256:${"d".repeat(64)}` as WorkflowV2Digest;
const DEFAULT_SESSION: SessionIdentity = Object.freeze({
  session_id: "session-host-test",
  lifecycle_id: "lifecycle-host-test",
});

function actualAgentsFor(descriptor: ProviderDescriptor): readonly AgentRef[] {
  return Object.freeze(descriptor.agent_sources.flatMap((source) => source.registered_names.map((registered_name) => Object.freeze({
    registered_name,
    provider_id: source.provider_id,
    source_fingerprint: source.source_fingerprint,
  }))));
}

function trustedAuthorityFor(
  input: {
    readonly agents?: readonly AgentRef[];
    readonly inventoryFingerprint?: WorkflowV2Digest;
    readonly reservation?: ActualAgentInventory["reservation"];
    readonly withoutReservation?: boolean;
  } = {},
): AgentInventoryAuthority {
  return {
    resolve(context) {
      const agents = input.agents ?? actualAgentsFor(context.descriptor);
      const inventoryFingerprint = input.inventoryFingerprint ?? digestImmutable(agents);
      return successResult(Object.freeze({
        authority: "omp" as const,
        provider_id: context.provider_id,
        descriptor_fingerprint: context.descriptor_fingerprint,
        agents: Object.freeze([...agents]),
        inventory_fingerprint: inventoryFingerprint,
        ...(input.withoutReservation
          ? {}
          : {
              reservation: input.reservation ?? Object.freeze({
                reservation_id: "reservation-host-test",
                fingerprint: inventoryFingerprint,
              }),
            }),
      }));
    },
  };
}
const temporaryRoots = new Set<string>();

function projectRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "omp-workflow-v2-host-"));
  mkdirSync(join(root, ".omp"));
  mkdirSync(join(root, ".git"));
  temporaryRoots.add(root);
  return root;
}

function fakeExtension(): FakeExtension {
  const commands = new Map<string, { readonly handler: CommandHandler }>();
  const tools = new Map<string, { readonly execute: ToolExecutor }>();
  const messages: string[] = [];
  const notifications: string[] = [];
  const pi = {
    registerCommand(name: string, definition: { readonly handler: CommandHandler }) {
      commands.set(name, definition);
    },
    registerTool(definition: { readonly name: string; readonly execute: ToolExecutor }) {
      tools.set(definition.name, definition);
    },
    sendUserMessage(content: string) {
      messages.push(content);
    },
  } as unknown as ExtensionAPI;
  return { pi, commands, tools, messages, notifications };
}

function profile(name: Profile["name"], stageId: string): Profile {
  return {
    name,
    title: `${name} host test profile`,
    description: `Minimal ${name} profile used by host identity tests.`,
    match: { type: ["FEATURE"], complexity: ["QUICK"] },
    stages: [{
      id: stageId,
      title: stageId,
      type: "single",
      role: "task",
      produces: stageId,
    }],
  };
}

function providerFixture(input: {
  readonly id?: ProviderId;
  readonly capabilities?: readonly ProviderCapability[];
  readonly sourceFingerprint?: WorkflowV2Digest;
  readonly agentNames?: readonly string[];
  readonly profiles?: readonly Profile[];
} = {}): ProviderFixture {
  const providerId = input.id ?? DEFAULT_PROVIDER_ID;
  const sourceFingerprint = input.sourceFingerprint ?? DEFAULT_SOURCE_FINGERPRINT;
  const catalog = createProviderCatalog(input.profiles ?? [profile("standard", "implementation"), profile("full-feature", "review")]);
  const descriptor: ProviderDescriptor = {
    id: providerId,
    protocol_version: 2,
    capabilities: input.capabilities ?? ["workflow_execution", "cto", "profile_catalog"],
    catalog_content_digest: catalog.content_digest,
    agent_sources: [{
      provider_id: providerId,
      source_fingerprint: sourceFingerprint,
      registered_names: input.agentNames ?? ["analyst", "task"],
    }],
    executable_provenance: {
      build_fingerprint: DEFAULT_BUILD_FINGERPRINT,
      runtime_fingerprint: DEFAULT_RUNTIME_FINGERPRINT,
    },
    defaults: {},
  };
  const actualAgents = actualAgentsFor(descriptor);
  const probe: RuntimeProbe = {
    factoryCalls: 0,
    dispatchCalls: 0,
    shutdownCalls: 0,
    contexts: [],
    dispatches: [],
  };
  const runtime: ProviderRuntime = {
    async dispatch(input: ValidatedDispatch): Promise<ProviderDispatchResult> {
      probe.dispatchCalls += 1;
      probe.dispatches.push(input);
      if (input.identity_level === "run") {
        return {
          identity_level: "run",
          project_identity: input.project_identity,
          run_identity: input.run_identity,
          runtime_key: input.runtime_key,
          status: "succeeded",
          evidence: "host-test-run-dispatch",
        };
      }
      return {
        identity_level: "project",
        project_identity: input.project_identity,
        runtime_key: input.runtime_key,
        status: "succeeded",
        evidence: "host-test-project-dispatch",
      };
    },
    shutdown() {
      probe.shutdownCalls += 1;
    },
  };
  const registration: ProviderRegistration = {
    descriptor,
    descriptor_fingerprint: computeDescriptorFingerprint(descriptor),
    catalog,
    createRuntime(context: ProviderRuntimeContext) {
      probe.factoryCalls += 1;
      probe.contexts.push(context);
      return runtime;
    },
  };
  return { providerId, registration, probe, actualAgents };
}

function policyFor(
  provider: ProviderFixture,
  input: {
    readonly selection?: "matrix" | "fixed";
    readonly profile?: ProfileIdentity;
    readonly roles?: Readonly<Record<string, AgentRef | null>>;
    readonly requiredCapabilities?: readonly string[];
    readonly promptContext?: WorkflowPolicy["prompt_context"];
  } = {},
): PolicyDocument {
  const providerRef: PolicyProviderRef = {
    id: provider.providerId,
    protocol_version: 2,
    descriptor_fingerprint: provider.registration.descriptor_fingerprint,
    catalog_content_digest: provider.registration.catalog.content_digest,
  };
  const workflow = input.selection === "fixed"
    ? { selection: "fixed" as const, profile_identity: input.profile ?? provider.registration.catalog.profiles[0]!.identity }
    : { selection: "matrix" as const };
  const policy: WorkflowPolicy = {
    roles: input.roles ?? {},
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
    workflow,
    prompt_context: input.promptContext ?? {},
    required_capabilities: input.requiredCapabilities ?? [],
  };
  return { schema_version: 2, provider: providerRef, policy };
}

function writePolicy(root: string, document: PolicyDocument): void {
  writeFileSync(join(root, ".omp", "team.config.json"), `${canonicalPolicyJson(document)}\n`, "utf8");
}

function policySnapshot(root: string, filesystemAuthority: TrustedFsAuthority): PolicySnapshot {
  const result = readPolicySnapshot(root, filesystemAuthority);
  if (!result.ok) throw new Error(`test policy setup failed: ${result.diagnostics[0]?.code ?? "unknown"}`);
  return result.value;
}

function bindPolicy(root: string, provider: ProviderFixture, snapshot: PolicySnapshot, filesystemAuthority: TrustedFsAuthority): void {
  const built = buildBindingDocument(root, {
    provider_id: provider.providerId,
    descriptor_fingerprint: provider.registration.descriptor_fingerprint,
    executable_provenance: provider.registration.descriptor.executable_provenance,
    catalog_content_digest: provider.registration.catalog.content_digest,
    config_byte_sha256: snapshot.byte_sha256,
    config_semantic_sha256: snapshot.semantic_sha256,
    session: DEFAULT_SESSION,
  }, filesystemAuthority);
  if (!built.ok) throw new Error(`test binding setup failed: ${built.diagnostics[0]?.code ?? "unknown"}`);
  const written = writeBindingAfterConfirmation({
    root: root as CanonicalRoot,
    document: built.value,
    confirm_root: true,
  }, filesystemAuthority);
  if (!written.ok) throw new Error(`test binding write failed: ${written.diagnostics[0]?.code ?? "unknown"}`);
}

function validTransactionJournal(root: CanonicalRoot): TransactionJournal {
  return {
    version: 2,
    transaction_id: "00000000-0000-0000-0000-000000000001",
    canonical_root: root,
    policy_path: join(root, ".omp", "team.config.json"),
    binding_path: join(root, ".omp", "team.config.binding.json"),
    phase: "prepared",
    old_policy: { state: "absent", image: { kind: "none" } },
    old_binding: { state: "absent", image: { kind: "none" } },
    new_policy: { state: "absent" },
    new_binding: { state: "absent" },
  };
}


type HostTestOptions = WorkflowHostOptions;

function optionsFor(
  root: string,
  registry: ProviderRegistry,
  filesystemAuthority: TrustedFsAuthority,
  overrides: {
    readonly resolveRoot?: (context: unknown) => string | undefined;
    readonly resolveSession?: (context: unknown) => SessionIdentity | undefined;
    readonly agentInventoryAuthority?: AgentInventoryAuthority;
    readonly withoutAgentInventoryAuthority?: boolean;
  } = {},
): HostTestOptions {
  return {
    registry,
    admission: createAdmissionBridge(),
    host: WORKFLOW_V2_HOST_DESCRIPTOR,
    resolveRoot: overrides.resolveRoot ?? (() => root),
    resolveSession: overrides.resolveSession ?? (() => DEFAULT_SESSION),
    filesystemAuthority,
    ...(overrides.withoutAgentInventoryAuthority
      ? {}
      : { agentInventoryAuthority: overrides.agentInventoryAuthority ?? trustedAuthorityFor() }),
  };
}

function firstCode(result: DiagnosticResult<unknown>): string | undefined {
  return result.diagnostics[0]?.code;
}
function projectIdentityFor(root: string, registry: ProviderRegistry, filesystemAuthority: TrustedFsAuthority, context: unknown = {}): ProjectIdentity {
  const checked = validateInvocation({ operation: "tool", name: "workflow_prepare", args: {}, context }, optionsFor(root, registry, filesystemAuthority));
  if (!checked.ok) throw new Error(`test project identity setup failed: ${firstCode(checked) ?? "unknown"}`);
  return checked.value.project_identity;
}

function runIdentityFor(
  projectIdentity: ProjectIdentity,
  profileIdentity: ProfileIdentity,
  runId: string,
): WorkflowRunIdentity {
  const built = buildWorkflowRunIdentity({ project_identity: projectIdentity, profile_identity: profileIdentity, run_id: runId });
  if (!built.ok) throw new Error(`test run identity setup failed: ${firstCode(built) ?? "unknown"}`);
  return built.value;
}

function admissionExpectationFor(admission: ProviderActivationAdmission): ProviderActivationAdmissionExpectation {
  return {
    project_identity: admission.project_identity,
    runtime_key: admission.runtime_key,
    canonical_root: admission.canonical_root,
    provider_id: admission.provider_id,
    descriptor_fingerprint: admission.descriptor_fingerprint,
    catalog_content_digest: admission.catalog_content_digest,
    executable_provenance: admission.executable_provenance,
    agent_inventory: admission.agent_inventory,
    agent_inventory_authority: admission.agent_inventory_authority,
    authority_context: admission.authority_context,
    ...(admission.run_identity === undefined ? {} : { run_identity: admission.run_identity }),
  };
}

afterEach(() => {
  resetAdmissionForTests();
  for (const root of temporaryRoots) rmSync(root, { recursive: true, force: true });
  temporaryRoots.clear();
});

test("admits one eager host, keeps team as do-work, and activates a profile-free runtime", async () => {
  const root = projectRoot();
  const filesystemAuthority = createTestDescriptorRelativeFsAuthority();
  const provider = providerFixture();
  const registry = createProviderRegistry();
  assert.equal(publishProvider(registry, provider.registration).ok, true);
  const document = policyFor(provider);
  writePolicy(root, document);
  bindPolicy(root, provider, policySnapshot(root, filesystemAuthority), filesystemAuthority);

  const extension = fakeExtension();
  const options = optionsFor(root, registry, filesystemAuthority);
  const host = registerWorkflowV2Host(extension.pi, options);

  assert.deepEqual([...extension.commands.keys()], ["do-work", "team", "cto", "workflow-provider", "init-team"]);
  assert.deepEqual([...extension.tools.keys()], [
    "workflow_prepare",
    "workflow_begin",
    "workflow_status",
    "workflow_instructions",
    "workflow_complete",
    "workflow_checkpoint",
    "workflow_advance",
  ]);
  assert.equal(provider.probe.factoryCalls, 0);
  assert.equal(extension.messages.length, 0);

  const context = {};
  const doWork = extension.commands.get("do-work");
  const team = extension.commands.get("team");
  assert.ok(doWork);
  assert.ok(team);
  await doWork.handler("ship this", context);
  assert.equal(provider.probe.factoryCalls, 1);
  assert.equal(provider.probe.dispatchCalls, 0);
  assert.equal(extension.messages.length, 1);
  assert.match(extension.messages[0] ?? "", /command: do-work/);
  assert.match(extension.messages[0] ?? "", /provider: @example\/workflow-provider/);
  assert.match(extension.messages[0] ?? "", /Task:\nship this/);
  assert.equal(provider.probe.contexts[0]?.project_identity.provider_id, provider.providerId);
  assert.equal(provider.probe.contexts[0]?.runtime_key !== undefined, true);
  assert.equal("profile_identity" in (provider.probe.contexts[0] ?? {}), false);
  assert.equal("run_id" in (provider.probe.contexts[0] ?? {}), false);
  const runtimeContext = provider.probe.contexts[0]!;
  const admission = runtimeContext.activation_admission;
  const admissionExpected = admissionExpectationFor(admission);
  assert.equal(runtimeContext.canonical_root, root);
  assert.equal(Object.isFrozen(admission), true);
  assert.equal(Object.isFrozen(admission.authority_context), true);
  assert.equal(admission.agent_inventory.authority, "omp");
  assert.equal(admission.agent_inventory.reservation !== undefined, true);
  assert.equal(validateProviderActivationAdmission(admission, admissionExpected).ok, true);
  assert.equal(validateProviderActivationAdmission({ ...admission }, admissionExpected).ok, false);

  await team.handler("follow up", context);
  assert.equal(provider.probe.factoryCalls, 1, "team must reuse the project runtime key");
  assert.equal(extension.messages.length, 2);
  assert.match(extension.messages[1] ?? "", /command: do-work/);

  const project = projectIdentityFor(root, registry, filesystemAuthority);
  const profileIdentity = provider.registration.catalog.profiles[0]!.identity;
  const runIdentity = runIdentityFor(project, profileIdentity, "run-host-test");
  const status = extension.tools.get("workflow_status");
  assert.ok(status);

  const toolResult = await status.execute("tool-1", {}, undefined, undefined, { run_identity: runIdentity });
  assert.equal(provider.probe.dispatchCalls, 1);
  assert.equal((toolResult as { details?: { ok?: boolean } }).details?.ok, true);
  assert.equal(provider.probe.dispatches[0]?.identity_level, "run");
  assert.deepEqual(provider.probe.dispatches[0]?.run_identity, runIdentity);
  // Run identities are validated immutable values; exact reference identity is reserved for the opaque admission proof.
  const runAdmission = provider.probe.dispatches[0]!.activation_admission;
  assert.deepEqual(runAdmission.run_identity, runIdentity);
  assert.notEqual(runAdmission, runtimeContext.activation_admission);
  assert.equal(validateProviderActivationAdmission(runAdmission, admissionExpectationFor(runAdmission)).ok, true);

  await host.shutdown();
  assert.equal(provider.probe.shutdownCalls, 1);
});
test("rejects fake admissions and every stale activation pin with typed diagnostics", () => {
  const root = projectRoot();
  const filesystemAuthority = createTestDescriptorRelativeFsAuthority();
  const provider = providerFixture({ id: "@example/admission-pins" as ProviderId });
  const registry = createProviderRegistry();
  assert.equal(publishProvider(registry, provider.registration).ok, true);
  writePolicy(root, policyFor(provider));
  bindPolicy(root, provider, policySnapshot(root, filesystemAuthority), filesystemAuthority);

  const checked = validateInvocation(
    { operation: "tool", name: "workflow_prepare", args: {}, context: {} },
    optionsFor(root, registry, filesystemAuthority),
  );
  assert.equal(checked.ok, true);
  if (!checked.ok) return;
  const admission = checked.value.activation_admission;
  const expected = admissionExpectationFor(admission);
  const digest = `sha256:${"e".repeat(64)}` as WorkflowV2Digest;
  const staleAgents = Object.freeze(admission.agent_inventory.agents.slice(0, 1));
  const staleInventory: ActualAgentInventory = Object.freeze({
    ...admission.agent_inventory,
    agents: staleAgents,
    inventory_fingerprint: digestImmutable(staleAgents),
  });
  const staleReservationInventory: ActualAgentInventory = Object.freeze({
    ...admission.agent_inventory,
    reservation: Object.freeze({
      reservation_id: "stale-reservation",
      fingerprint: admission.agent_inventory.reservation!.fingerprint,
    }),
  });
  const staleAuthority: AgentInventoryAuthority = {
    resolve: admission.agent_inventory_authority.resolve,
  };
  const staleContext = Object.freeze({
    ...admission.authority_context,
    canonical_root: `${root}-stale` as CanonicalRoot,
  });
  const staleRun = runIdentityFor(
    admission.project_identity,
    provider.registration.catalog.profiles[0]!.identity,
    "stale-run",
  );
  const staleExpectations: ProviderActivationAdmissionExpectation[] = [
    { ...expected, project_identity: { ...expected.project_identity, root_instance_id: digest } },
    { ...expected, runtime_key: digest },
    { ...expected, canonical_root: `${root}-stale` as CanonicalRoot },
    { ...expected, provider_id: "@example/stale-provider" as ProviderId },
    { ...expected, descriptor_fingerprint: digest },
    { ...expected, catalog_content_digest: digest },
    { ...expected, executable_provenance: { build_fingerprint: digest, runtime_fingerprint: digest } },
    { ...expected, agent_inventory: staleInventory },
    { ...expected, agent_inventory: staleReservationInventory },
    { ...expected, agent_inventory_authority: staleAuthority },
    { ...expected, authority_context: staleContext },
    { ...expected, run_identity: staleRun },
  ];
  for (const stale of staleExpectations) {
    const result = validateProviderActivationAdmission(admission, stale);
    assert.equal(result.ok, false);
    assert.equal(firstCode(result), "IDENTITY_MISMATCH");
  }

  const fake = Object.freeze({ ...admission });
  const fakeResult = validateProviderActivationAdmission(fake, expected);
  assert.equal(fakeResult.ok, false);
  assert.equal(firstCode(fakeResult), "CAPABILITY_MISSING");
});

test("retained command and tool handlers fail closed after host shutdown", async () => {
  const root = projectRoot();
  const filesystemAuthority = createTestDescriptorRelativeFsAuthority();
  const registry = createProviderRegistry();
  const extension = fakeExtension();
  const host = registerWorkflowV2Host(extension.pi, optionsFor(root, registry, filesystemAuthority));
  const doWork = extension.commands.get("do-work");
  const begin = extension.tools.get("workflow_begin");
  assert.ok(doWork);
  assert.ok(begin);

  await host.shutdown();

  const notifications: string[] = [];
  await doWork.handler("must not dispatch", {
    ui: {
      notify(message: string) {
        notifications.push(message);
      },
    },
  });
  assert.equal(notifications.length, 1);
  assert.match(notifications[0] ?? "", /host_lifecycle/);

  const toolResult = await begin.execute("tool-after-shutdown", {}, undefined, undefined, {});
  const details = (toolResult as { readonly details?: { readonly ok?: boolean; readonly diagnostics?: readonly { readonly code?: string }[] } }).details;
  assert.equal(details?.ok, false);
  assert.equal(details?.diagnostics?.[0]?.code, "ACTIVATION_FAILED");
});

test("rejects a duplicate host through admission before any second registration", () => {
  const root = projectRoot();
  const filesystemAuthority = createTestDescriptorRelativeFsAuthority();
  const registry = createProviderRegistry();
  const firstExtension = fakeExtension();
  registerWorkflowV2Host(firstExtension.pi, optionsFor(root, registry, filesystemAuthority));
  assert.equal(firstExtension.commands.size, 5);
  assert.equal(firstExtension.tools.size, 7);

  const secondExtension = fakeExtension();
  assert.throws(
    () => registerWorkflowV2Host(secondExtension.pi, optionsFor(root, registry, filesystemAuthority)),
    (error: unknown) => error instanceof WorkflowV2HostAdmissionError
      && error.diagnostics.some((entry) => entry.code === "OWNER_CONFLICT"),
  );
  assert.equal(secondExtension.commands.size, 0);
  assert.equal(secondExtension.tools.size, 0);
});

test("fails at manager-root, policy, binding, provider, profile, and capability boundaries without a factory or prompt", async () => {
  const bootstrapRoot = projectRoot();
  const filesystemAuthority = createTestDescriptorRelativeFsAuthority();
  const bootstrapExtension = fakeExtension();
  registerWorkflowV2Host(bootstrapExtension.pi, optionsFor(bootstrapRoot, createProviderRegistry(), filesystemAuthority));
  const messages: string[] = [];
  const request = (name: "do-work" | "workflow_prepare", options: HostTestOptions) => dispatchInvocation(
    name === "do-work"
      ? { operation: "command", name, args: "task", context: {} }
      : { operation: "tool", name, args: {}, context: {} },
    options,
    { sendUserMessage: (prompt) => messages.push(prompt) },
  );

  const unavailableRoot = await request("do-work", optionsFor(bootstrapRoot, createProviderRegistry(), filesystemAuthority, { resolveRoot: () => undefined }));
  assert.equal(firstCode(unavailableRoot), "ROOT_UNAVAILABLE");

  const missingPolicyRoot = projectRoot();
  const missingPolicyProvider = providerFixture({ id: "@example/missing-policy" as ProviderId });
  const missingPolicyRegistry = createProviderRegistry();
  assert.equal(publishProvider(missingPolicyRegistry, missingPolicyProvider.registration).ok, true);
  const missingPolicy = await request("do-work", optionsFor(missingPolicyRoot, missingPolicyRegistry, filesystemAuthority));
  assert.equal(firstCode(missingPolicy), "CONFIG_MISSING");
  assert.equal(missingPolicyProvider.probe.factoryCalls, 0);

  const missingBindingRoot = projectRoot();
  const missingBindingProvider = providerFixture({ id: "@example/missing-binding" as ProviderId });
  const missingBindingRegistry = createProviderRegistry();
  assert.equal(publishProvider(missingBindingRegistry, missingBindingProvider.registration).ok, true);
  writePolicy(missingBindingRoot, policyFor(missingBindingProvider));
  const missingBinding = await request("do-work", optionsFor(missingBindingRoot, missingBindingRegistry, filesystemAuthority));
  assert.equal(firstCode(missingBinding), "BINDING_REQUIRED");
  assert.equal(missingBindingProvider.probe.factoryCalls, 0);

  const missingProviderRoot = projectRoot();
  const missingProvider = providerFixture({ id: "@example/missing-provider" as ProviderId });
  const missingProviderRegistry = createProviderRegistry();
  writePolicy(missingProviderRoot, policyFor(missingProvider));
  bindPolicy(missingProviderRoot, missingProvider, policySnapshot(missingProviderRoot, filesystemAuthority), filesystemAuthority);
  const missingProviderResult = await request("do-work", optionsFor(missingProviderRoot, missingProviderRegistry, filesystemAuthority));
  assert.equal(firstCode(missingProviderResult), "PROVIDER_UNAVAILABLE");
  assert.equal(missingProvider.probe.factoryCalls, 0);

  const missingProfileRoot = projectRoot();
  const missingProfileProvider = providerFixture({ id: "@example/missing-profile" as ProviderId });
  const missingProfileRegistry = createProviderRegistry();
  assert.equal(publishProvider(missingProfileRegistry, missingProfileProvider.registration).ok, true);
  const missingProfile: ProfileIdentity = {
    id: "not-published",
    fingerprint: `sha256:${"f".repeat(64)}` as WorkflowV2Digest,
  };
  writePolicy(missingProfileRoot, policyFor(missingProfileProvider, { selection: "fixed", profile: missingProfile }));
  bindPolicy(missingProfileRoot, missingProfileProvider, policySnapshot(missingProfileRoot, filesystemAuthority), filesystemAuthority);
  const missingProfileResult = await request("do-work", optionsFor(missingProfileRoot, missingProfileRegistry, filesystemAuthority));
  assert.equal(firstCode(missingProfileResult), "PROFILE_UNAVAILABLE");
  assert.equal(missingProfileProvider.probe.factoryCalls, 0);

  const missingCapabilityRoot = projectRoot();
  const missingCapabilityProvider = providerFixture({
    id: "@example/missing-capability" as ProviderId,
    capabilities: ["workflow_execution"],
  });
  const missingCapabilityRegistry = createProviderRegistry();
  assert.equal(publishProvider(missingCapabilityRegistry, missingCapabilityProvider.registration).ok, true);
  writePolicy(missingCapabilityRoot, policyFor(missingCapabilityProvider));
  bindPolicy(missingCapabilityRoot, missingCapabilityProvider, policySnapshot(missingCapabilityRoot, filesystemAuthority), filesystemAuthority);
  const missingCapability = await request("workflow_prepare", optionsFor(missingCapabilityRoot, missingCapabilityRegistry, filesystemAuthority));
  assert.equal(firstCode(missingCapability), "CAPABILITY_MISSING");
  assert.equal(missingCapabilityProvider.probe.factoryCalls, 0);
  assert.equal(messages.length, 0);
});

test("blocks a command through the host dispatch path while a valid transaction marker is present", async () => {
  const root = projectRoot();
  const filesystemAuthority = createTestDescriptorRelativeFsAuthority();
  const canonicalRoot = root as CanonicalRoot;
  const provider = providerFixture({ id: "@example/transaction-guard" as ProviderId });
  const registry = createProviderRegistry();
  assert.equal(publishProvider(registry, provider.registration).ok, true);
  writePolicy(root, policyFor(provider));
  const snapshot = policySnapshot(root, filesystemAuthority);
  bindPolicy(root, provider, snapshot, filesystemAuthority);

  writeFileSync(transactionJournalPath(canonicalRoot), `${canonicalPolicyJson(validTransactionJournal(canonicalRoot))}\n`, "utf8");

  const extension = fakeExtension();
  const host = registerWorkflowV2Host(extension.pi, optionsFor(root, registry, filesystemAuthority));
  const command = extension.commands.get("do-work");
  assert.ok(command);
  const context = {
    ui: {
      notify(message: string) {
        extension.notifications.push(message);
      },
    },
  };

  await command.handler("must not dispatch", context);

  const notification = JSON.parse(extension.notifications[0] ?? "{}") as {
    readonly diagnostics?: readonly [{
      readonly code?: string;
      readonly operation?: string;
      readonly evidence?: Readonly<Record<string, unknown>>;
      readonly remediation?: string;
    }];
  };
  assert.equal(notification.diagnostics?.[0]?.code, "TRANSACTION_INCOMPLETE");
  assert.equal(notification.diagnostics?.[0]?.operation, "command.dispatch");
  assert.deepEqual(notification.diagnostics?.[0]?.evidence, {
    canonical_root: canonicalRoot,
    path: transactionJournalPath(canonicalRoot),
    status: "incomplete",
  });
  assert.match(notification.diagnostics?.[0]?.remediation ?? "", /recover|repair/u);
  assert.equal(provider.probe.factoryCalls, 0);
  assert.equal(provider.probe.dispatchCalls, 0);
  assert.equal(extension.messages.length, 0);

  await host.shutdown();
});

test("preflights every selected qualified agent against the complete provider inventory", async () => {
  const root = projectRoot();
  const filesystemAuthority = createTestDescriptorRelativeFsAuthority();
  const selected = providerFixture({
    id: "@example/selected-agent" as ProviderId,
    agentNames: ["analyst"],
  });
  const conflicting = providerFixture({
    id: "@example/conflicting-agent" as ProviderId,
    sourceFingerprint: `sha256:${"e".repeat(64)}` as WorkflowV2Digest,
    agentNames: ["analyst"],
  });
  const registry = createProviderRegistry();
  assert.equal(publishProvider(registry, selected.registration).ok, true);
  assert.equal(publishProvider(registry, conflicting.registration).ok, true);
  const selectedRef: AgentRef = {
    registered_name: "analyst",
    provider_id: selected.providerId,
    source_fingerprint: selected.registration.descriptor.agent_sources[0]!.source_fingerprint,
  };
  writePolicy(root, policyFor(selected, { roles: { analyst: selectedRef } }));
  bindPolicy(root, selected, policySnapshot(root, filesystemAuthority), filesystemAuthority);
  const actualAuthority = trustedAuthorityFor({
    agents: [...selected.actualAgents, ...conflicting.actualAgents],
  });
  const extension = fakeExtension();

  registerWorkflowV2Host(extension.pi, optionsFor(root, registry, filesystemAuthority, { agentInventoryAuthority: actualAuthority }));
  const result = await dispatchInvocation(
    { operation: "tool", name: "workflow_prepare", args: {}, context: {} },
    optionsFor(root, registry, filesystemAuthority, { agentInventoryAuthority: actualAuthority }),
    { sendUserMessage: () => extension.messages.push("unexpected") },
  );
  assert.equal(firstCode(result), "AGENT_COLLISION");
  assert.equal(selected.probe.factoryCalls, 0);
  assert.equal(conflicting.probe.factoryCalls, 0);
  assert.equal(extension.messages.length, 0);
});

test("discards a changed policy during the final TOCTOU validation", async () => {
  const root = projectRoot();
  const filesystemAuthority = createTestDescriptorRelativeFsAuthority();
  const provider = providerFixture({ id: "@example/toctou-provider" as ProviderId });
  const registry = createProviderRegistry();
  assert.equal(publishProvider(registry, provider.registration).ok, true);
  const original = policyFor(provider);
  writePolicy(root, original);
  bindPolicy(root, provider, policySnapshot(root, filesystemAuthority), filesystemAuthority);
  const changed = policyFor(provider, {
    promptContext: {
      changed: { id: "changed", type: "text", value: "after-first-read" },
    },
  });
  let sessionReads = 0;
  const options = optionsFor(root, registry, filesystemAuthority, {
    resolveSession: () => {
      sessionReads += 1;
      if (sessionReads === 2) writePolicy(root, changed);
      return DEFAULT_SESSION;
    },
  });
  const admission = options.admission.admitHost(WORKFLOW_V2_HOST_DESCRIPTOR);
  assert.equal(admission.ok, true);
  const messages: string[] = [];
  const result = await dispatchInvocation(
    { operation: "command", name: "do-work", args: "must not send", context: {} },
    options,
    { sendUserMessage: (prompt) => messages.push(prompt) },
  );
  assert.equal(firstCode(result), "IDENTITY_MISMATCH");
  assert.equal(sessionReads, 2);
  assert.equal(provider.probe.factoryCalls, 0);
  assert.equal(messages.length, 0);
});

test("uses project dispatch for fixed and matrix prepare, then hands off the exact pinned run", async () => {
  for (const selection of ["fixed", "matrix"] as const) {
    const root = projectRoot();
    const filesystemAuthority = createTestDescriptorRelativeFsAuthority();
    const provider = providerFixture({ id: `@example/${selection}-prepare` as ProviderId });
    const registry = createProviderRegistry();
    assert.equal(publishProvider(registry, provider.registration).ok, true);
    const profileIdentity = provider.registration.catalog.profiles[0]!.identity;
    writePolicy(root, policyFor(provider, { selection, profile: profileIdentity }));
    bindPolicy(root, provider, policySnapshot(root, filesystemAuthority), filesystemAuthority);
    const options = optionsFor(root, registry, filesystemAuthority);
    const extension = fakeExtension();
    const host = registerWorkflowV2Host(extension.pi, options);
    const prepare = extension.tools.get("workflow_prepare");
    assert.ok(prepare);
    const prepared = await prepare.execute("prepare", {}, undefined, undefined, {});
    assert.equal((prepared as { details?: { ok?: boolean } }).details?.ok, true);
    assert.equal(provider.probe.dispatches[0]?.identity_level, "project");
    assert.equal("run_identity" in (provider.probe.dispatches[0] ?? {}), false);
    assert.equal("profile_identity" in (provider.probe.contexts[0] ?? {}), false);
    const project = projectIdentityFor(root, registry, filesystemAuthority);
    const run = runIdentityFor(project, profileIdentity, `${selection}-run`);
    const status = extension.tools.get("workflow_status");
    assert.ok(status);
    const statusResult = await status.execute("status", {}, undefined, undefined, { run_identity: run });
    assert.equal((statusResult as { details?: { ok?: boolean } }).details?.ok, true);
    assert.equal(provider.probe.dispatches[1]?.identity_level, "run");
    assert.deepEqual(provider.probe.dispatches[1]?.run_identity, run);
    await host.shutdown();
    resetAdmissionForTests();
  }
});

test("allows a same-provider new profile in a new run while reusing the project runtime", async () => {
  const root = projectRoot();
  const filesystemAuthority = createTestDescriptorRelativeFsAuthority();
  const provider = providerFixture({ id: "@example/new-profile-run" as ProviderId });
  const registry = createProviderRegistry();
  assert.equal(publishProvider(registry, provider.registration).ok, true);
  writePolicy(root, policyFor(provider));
  bindPolicy(root, provider, policySnapshot(root, filesystemAuthority), filesystemAuthority);
  const options = optionsFor(root, registry, filesystemAuthority);
  const extension = fakeExtension();
  const host = registerWorkflowV2Host(extension.pi, options);
  const project = projectIdentityFor(root, registry, filesystemAuthority);
  const firstProfile = provider.registration.catalog.profiles[0]!.identity;
  const secondProfile = provider.registration.catalog.profiles[1]!.identity;
  const firstRun = runIdentityFor(project, firstProfile, "run-first-profile");
  const secondRun = runIdentityFor(project, secondProfile, "run-second-profile");
  const status = extension.tools.get("workflow_status");
  assert.ok(status);
  const first = await status.execute("first", {}, undefined, undefined, { run_identity: firstRun });
  const second = await status.execute("second", {}, undefined, undefined, { run_identity: secondRun });
  assert.equal((first as { details?: { ok?: boolean } }).details?.ok, true);
  assert.equal((second as { details?: { ok?: boolean } }).details?.ok, true);
  assert.equal(provider.probe.factoryCalls, 1);
  assert.equal(provider.probe.dispatchCalls, 2);
  assert.equal(provider.probe.contexts[0]?.runtime_key, provider.probe.dispatches[0]?.runtime_key);
  assert.equal(provider.probe.dispatches[0]?.runtime_key, provider.probe.dispatches[1]?.runtime_key);
  assert.notEqual(firstRun.run_id, secondRun.run_id);
  await host.shutdown();
});

test("rejects a changed profile inside a fixed existing run before provider effects", async () => {
  const root = projectRoot();
  const filesystemAuthority = createTestDescriptorRelativeFsAuthority();
  const provider = providerFixture({ id: "@example/fixed-profile-mismatch" as ProviderId });
  const registry = createProviderRegistry();
  assert.equal(publishProvider(registry, provider.registration).ok, true);
  const fixedProfile = provider.registration.catalog.profiles[0]!.identity;
  const changedProfile = provider.registration.catalog.profiles[1]!.identity;
  writePolicy(root, policyFor(provider, { selection: "fixed", profile: fixedProfile }));
  bindPolicy(root, provider, policySnapshot(root, filesystemAuthority), filesystemAuthority);
  const options = optionsFor(root, registry, filesystemAuthority);
  const extension = fakeExtension();
  const host = registerWorkflowV2Host(extension.pi, options);
  const project = projectIdentityFor(root, registry, filesystemAuthority);
  const changedRun = runIdentityFor(project, changedProfile, "run-fixed-mismatch");
  const status = extension.tools.get("workflow_status");
  assert.ok(status);
  const result = await status.execute("mismatch", {}, undefined, undefined, { run_identity: changedRun });
  const details = (result as { details?: { ok?: boolean; diagnostics?: Array<{ code: string }> } }).details;
  assert.equal(details?.ok, false);
  assert.equal(details?.diagnostics?.[0]?.code, "IDENTITY_MISMATCH");
  assert.equal(provider.probe.factoryCalls, 0);
  assert.equal(provider.probe.dispatchCalls, 0);
  assert.equal(extension.messages.length, 0);
  await host.shutdown();
});

test("requires a bound run identity for post-prepare tools without prompting or activating", async () => {
  const root = projectRoot();
  const filesystemAuthority = createTestDescriptorRelativeFsAuthority();
  const provider = providerFixture({ id: "@example/missing-run-context" as ProviderId });
  const registry = createProviderRegistry();
  assert.equal(publishProvider(registry, provider.registration).ok, true);
  writePolicy(root, policyFor(provider));
  bindPolicy(root, provider, policySnapshot(root, filesystemAuthority), filesystemAuthority);
  const extension = fakeExtension();
  const host = registerWorkflowV2Host(extension.pi, optionsFor(root, registry, filesystemAuthority));
  const status = extension.tools.get("workflow_status");
  assert.ok(status);
  const result = await status.execute("missing-run", {}, undefined, undefined, {});
  const details = (result as { details?: { ok?: boolean; diagnostics?: Array<{ code: string }> } }).details;
  assert.equal(details?.ok, false);
  assert.equal(details?.diagnostics?.[0]?.code, "MIGRATION_REQUIRED");
  assert.equal(provider.probe.factoryCalls, 0);
  assert.equal(provider.probe.dispatchCalls, 0);
  assert.equal(extension.messages.length, 0);
  await host.shutdown();
});

test("delegates workflow-provider list/status to provider-neutral management without activation", async () => {
  const root = projectRoot();
  const filesystemAuthority = createTestDescriptorRelativeFsAuthority();
  const provider = providerFixture({ id: "@example/isolated-management-provider" as ProviderId });
  const registry = createProviderRegistry();
  const published = publishProvider(registry, provider.registration);
  assert.equal(published.ok, true);
  assert.equal(listProviders(getProviderRegistry()).some((entry) => entry.provider_id === provider.providerId), false);
  writePolicy(root, policyFor(provider));
  const snapshot = policySnapshot(root, filesystemAuthority);
  const staleBindingProvider = providerFixture({ id: "@example/stale-binding-provider" as ProviderId });
  bindPolicy(root, staleBindingProvider, snapshot, filesystemAuthority);
  const extension = fakeExtension();
  const context = {
    ui: {
      notify(message: string) {
        extension.notifications.push(message);
      },
    },
  };
  const host = registerWorkflowV2Host(extension.pi, optionsFor(root, registry, filesystemAuthority));
  const command = extension.commands.get("workflow-provider");
  assert.ok(command);
  await command.handler("list", context);
  await command.handler("status", context);
  assert.equal(provider.probe.factoryCalls, 0);
  assert.equal(extension.messages.length, 0);
  assert.equal(extension.notifications.length, 1);
  assert.match(extension.notifications[0] ?? "", /"operation":"management\.status"/);
  assert.match(extension.notifications[0] ?? "", /@example\/isolated-management-provider/);
  assert.doesNotMatch(extension.notifications[0] ?? "", /PROVIDER_UNAVAILABLE/);
  await host.shutdown();
});

test("missing actual inventory authority fails before runtime or prompt effects", async () => {
  const root = projectRoot();
  const filesystemAuthority = createTestDescriptorRelativeFsAuthority();
  const provider = providerFixture({ id: "@example/missing-authority" as ProviderId });
  const registry = createProviderRegistry();
  assert.equal(publishProvider(registry, provider.registration).ok, true);
  writePolicy(root, policyFor(provider));
  bindPolicy(root, provider, policySnapshot(root, filesystemAuthority), filesystemAuthority);
  const options = optionsFor(root, registry, filesystemAuthority, { withoutAgentInventoryAuthority: true });
  assert.equal(options.admission.admitHost(WORKFLOW_V2_HOST_DESCRIPTOR).ok, true);
  const messages: string[] = [];
  const result = await dispatchInvocation(
    { operation: "command", name: "do-work", args: "must not prompt", context: {} },
    options,
    { sendUserMessage: (prompt) => messages.push(prompt) },
  );
  assert.equal(firstCode(result), "ACTIVATION_FAILED");
  assert.equal(result.diagnostics[0]?.operation, "agent.preflight");
  assert.equal(provider.probe.factoryCalls, 0);
  assert.equal(provider.probe.dispatchCalls, 0);
  assert.equal(messages.length, 0);
});

test("rejects an OMP inventory without a reservation before runtime activation", async () => {
  const root = projectRoot();
  const filesystemAuthority = createTestDescriptorRelativeFsAuthority();
  const provider = providerFixture({ id: "@example/missing-reservation" as ProviderId });
  const registry = createProviderRegistry();
  assert.equal(publishProvider(registry, provider.registration).ok, true);
  writePolicy(root, policyFor(provider));
  bindPolicy(root, provider, policySnapshot(root, filesystemAuthority), filesystemAuthority);
  const options = optionsFor(root, registry, filesystemAuthority, {
    agentInventoryAuthority: trustedAuthorityFor({ withoutReservation: true }),
  });
  assert.equal(options.admission.admitHost(WORKFLOW_V2_HOST_DESCRIPTOR).ok, true);
  const messages: string[] = [];
  const result = await dispatchInvocation(
    { operation: "command", name: "do-work", args: "must not prompt", context: {} },
    options,
    { sendUserMessage: (prompt) => messages.push(prompt) },
  );
  assert.equal(firstCode(result), "ACTIVATION_FAILED");
  assert.equal(result.diagnostics[0]?.operation, "admission");
  assert.equal(result.diagnostics[0]?.evidence.field, "activation_admission");
  assert.equal(provider.probe.factoryCalls, 0);
  assert.equal(provider.probe.dispatchCalls, 0);
  assert.equal(messages.length, 0);
});

test("foreign or malformed actual inventory authority fails closed", async () => {
  const root = projectRoot();
  const filesystemAuthority = createTestDescriptorRelativeFsAuthority();
  const provider = providerFixture({ id: "@example/invalid-authority" as ProviderId });
  const registry = createProviderRegistry();
  assert.equal(publishProvider(registry, provider.registration).ok, true);
  writePolicy(root, policyFor(provider));
  bindPolicy(root, provider, policySnapshot(root, filesystemAuthority), filesystemAuthority);

  const foreignAuthority = {
    resolve(context: Parameters<AgentInventoryAuthority["resolve"]>[0]) {
      return successResult(Object.freeze({
        authority: "foreign",
        provider_id: context.provider_id,
        descriptor_fingerprint: context.descriptor_fingerprint,
        agents: provider.actualAgents,
        inventory_fingerprint: digestImmutable(provider.actualAgents),
      }));
    },
  } as unknown as AgentInventoryAuthority;
  const foreignOptions = optionsFor(root, registry, filesystemAuthority, { agentInventoryAuthority: foreignAuthority });
  assert.equal(foreignOptions.admission.admitHost(WORKFLOW_V2_HOST_DESCRIPTOR).ok, true);
  const foreignResult = await dispatchInvocation(
    { operation: "command", name: "do-work", args: "must not prompt", context: {} },
    foreignOptions,
    { sendUserMessage: () => assert.fail("foreign authority must fail before prompting") },
  );
  assert.equal(firstCode(foreignResult), "ACTIVATION_FAILED");
  assert.equal(provider.probe.factoryCalls, 0);
  resetAdmissionForTests();


  const malformedAuthority: AgentInventoryAuthority = {
    resolve(context) {
      return successResult(Object.freeze({
        authority: "omp" as const,
        provider_id: context.provider_id,
        descriptor_fingerprint: context.descriptor_fingerprint,
        agents: "not-an-array",
        inventory_fingerprint: digestImmutable([]),
      })) as never;
    },
  };
  const malformedOptions = optionsFor(root, registry, filesystemAuthority, { agentInventoryAuthority: malformedAuthority });
  assert.equal(malformedOptions.admission.admitHost(WORKFLOW_V2_HOST_DESCRIPTOR).ok, true);
  const malformedResult = await dispatchInvocation(
    { operation: "command", name: "do-work", args: "must not prompt", context: {} },
    malformedOptions,
    { sendUserMessage: () => assert.fail("malformed authority must fail before prompting") },
  );
  assert.equal(firstCode(malformedResult), "ACTIVATION_FAILED");
  assert.equal(provider.probe.factoryCalls, 0);
});

test("inventory drift between validation passes blocks dispatch before provider effects", async () => {
  const root = projectRoot();
  const filesystemAuthority = createTestDescriptorRelativeFsAuthority();
  const provider = providerFixture({ id: "@example/drifting-authority" as ProviderId });
  const registry = createProviderRegistry();
  assert.equal(publishProvider(registry, provider.registration).ok, true);
  writePolicy(root, policyFor(provider));
  bindPolicy(root, provider, policySnapshot(root, filesystemAuthority), filesystemAuthority);
  let calls = 0;
  const authority: AgentInventoryAuthority = {
    resolve(context) {
      calls += 1;
      const agents = calls === 1 ? provider.actualAgents : provider.actualAgents.slice(0, 1);
      return successResult(Object.freeze({
        authority: "omp" as const,
        provider_id: context.provider_id,
        descriptor_fingerprint: context.descriptor_fingerprint,
        agents: Object.freeze([...agents]),
        inventory_fingerprint: digestImmutable(agents),
        reservation: Object.freeze({
          reservation_id: calls === 1 ? "reservation-one" : "reservation-two",
          fingerprint: (calls === 1 ? `sha256:${"3".repeat(64)}` : `sha256:${"4".repeat(64)}`) as WorkflowV2Digest,
        }),
      }));
    },
  };
  const options = optionsFor(root, registry, filesystemAuthority, { agentInventoryAuthority: authority });
  assert.equal(options.admission.admitHost(WORKFLOW_V2_HOST_DESCRIPTOR).ok, true);
  const messages: string[] = [];
  const result = await dispatchInvocation(
    { operation: "command", name: "do-work", args: "must not prompt", context: {} },
    options,
    { sendUserMessage: (prompt) => messages.push(prompt) },
  );
  assert.equal(firstCode(result), "IDENTITY_MISMATCH");
  assert.equal(calls, 2);
  assert.equal(provider.probe.factoryCalls, 0);
  assert.equal(provider.probe.dispatchCalls, 0);
  assert.equal(messages.length, 0);
});
