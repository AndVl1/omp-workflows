/* <!-- omp-cto-slice run=01a03ee4-7dd6-7580-8ad7-16d26dc886ba slice=workflow-v2-core --> */

import { readFileSync } from "node:fs";
import { createProviderCatalog, loadProfileByIdentity } from "../src/engine/profile.js";
import {
  buildProviderAgentInventory,
  computeDescriptorFingerprint,
} from "../src/workflow-v2/descriptor.js";
import {
  buildProjectIdentity,
  buildWorkflowRunIdentity,
} from "../src/workflow-v2/identity.js";
import type {
  AgentRef,
  EffectivePolicy,
  ProfileIdentity,
  ProjectIdentity,
  ProviderDescriptor,
  ProviderId,
  ProviderCatalog,
  SessionIdentity,
  WorkflowRunIdentity,
  WorkflowV2Digest,
} from "../src/workflow-v2/types.js";
import type { Profile } from "../src/engine/types.js";
import type { WorkIdentityScope } from "../src/engine/types.js";

export const TEST_PROVIDER_ID = "@example/workflow-provider" as ProviderId;
export const TEST_SOURCE_FINGERPRINT = `sha256:${"b".repeat(64)}` as WorkflowV2Digest;
export const TEST_BUILD_FINGERPRINT = `sha256:${"c".repeat(64)}` as WorkflowV2Digest;
export const TEST_RUNTIME_FINGERPRINT = `sha256:${"d".repeat(64)}` as WorkflowV2Digest;

const digest = (value: string): WorkflowV2Digest => `sha256:${value.repeat(64)}` as WorkflowV2Digest;

export function readWorkflowProfile(name: string): Profile {
  const profileWithMetadata = JSON.parse(readFileSync(new URL(`../workflows/${name}.json`, import.meta.url), "utf8")) as Profile & {
    readonly $schema?: string;
  };
  const { $schema: _schema, ...profile } = profileWithMetadata;
  return profile;
}

export function createTestCatalog(profiles: readonly Profile[]): Readonly<ProviderCatalog> {
  return createProviderCatalog(profiles);
}

export function profileIdentity(catalog: Readonly<ProviderCatalog>, id: string): ProfileIdentity {
  const entry = catalog.profiles.find((candidate) => candidate.identity.id === id);
  if (!entry) throw new Error(`profile fixture '${id}' is not published in the test catalog`);
  return entry.identity;
}

function roleAgent(role: string): string {
  return role === "${scope.dev_agent}" ? "developer-kotlin" : role;
}

export function profileRoles(profile: Profile): Readonly<Record<string, string>> {
  const roles: Record<string, string> = {};
  for (const stage of profile.stages) {
    if (stage.role) roles[stage.role] = roleAgent(stage.role);
    for (const role of stage.roles ?? []) roles[role] = roleAgent(role);
  }
  return roles;
}

export function agentRef(registered_name: string): AgentRef {
  return Object.freeze({
    registered_name,
    provider_id: TEST_PROVIDER_ID,
    source_fingerprint: TEST_SOURCE_FINGERPRINT,
  });
}

export interface WorkflowV2TestFixture {
  readonly catalog: Readonly<ProviderCatalog>;
  readonly profile: Profile;
  readonly profile_identity: ProfileIdentity;
  readonly descriptor: Readonly<ProviderDescriptor>;
  readonly descriptor_fingerprint: WorkflowV2Digest;
  readonly project_identity: ProjectIdentity;
  readonly run_identity: WorkflowRunIdentity;
  readonly agent_inventory: readonly AgentRef[];
  readonly effective_policy: Readonly<EffectivePolicy>;
}

export type WorkflowV2CapabilityContext = Pick<
  WorkflowV2TestFixture,
  "project_identity" | "run_identity" | "catalog" | "effective_policy" | "agent_inventory"
>;

export function workflowV2Fixture(
  profile: Profile,
  options: {
    readonly catalogProfiles?: readonly Profile[];
    readonly rootDigest?: WorkflowV2Digest;
    readonly roleAgents?: Readonly<Record<string, string>>;
    readonly agentNames?: readonly string[];
    readonly session?: SessionIdentity;
    readonly runId?: string;
  } = {},
): WorkflowV2TestFixture {
  const catalog = createTestCatalog(options.catalogProfiles ?? [profile]);
  const profile_identity = profileIdentity(catalog, profile.name);
  const loaded = loadProfileByIdentity(catalog, profile_identity);
  if (!loaded.ok) throw new Error(`profile fixture '${profile.name}' failed catalog identity loading`);
  const selectedProfile = loaded.value;
  const roleAgents = { ...profileRoles(selectedProfile), ...(options.roleAgents ?? {}) };
  const agentNames = options.agentNames ?? [...new Set(Object.values(roleAgents))];
  const descriptor: ProviderDescriptor = {
    id: TEST_PROVIDER_ID,
    protocol_version: 2,
    capabilities: ["workflow_execution", "cto", "profile_catalog"],
    catalog_content_digest: catalog.content_digest,
    agent_sources: [{
      provider_id: TEST_PROVIDER_ID,
      source_fingerprint: TEST_SOURCE_FINGERPRINT,
      registered_names: agentNames,
    }],
    executable_provenance: {
      build_fingerprint: TEST_BUILD_FINGERPRINT,
      runtime_fingerprint: TEST_RUNTIME_FINGERPRINT,
    },
    defaults: {},
  };
  const descriptor_fingerprint = computeDescriptorFingerprint(descriptor);
  const session = options.session ?? { session_id: "test-session", lifecycle_id: "test-lifecycle" };
  const projectResult = buildProjectIdentity({
    root_instance_id: options.rootDigest ?? digest("a"),
    provider_id: TEST_PROVIDER_ID,
    descriptor_fingerprint,
    executable_provenance: descriptor.executable_provenance,
    catalog_content_digest: catalog.content_digest,
    config_byte_sha256: digest("d"),
    config_semantic_sha256: digest("e"),
    session,
  });
  if (!projectResult.ok) throw new Error(projectResult.diagnostics.map((entry) => entry.code).join(","));
  const project_identity = projectResult.value;
  const runResult = buildWorkflowRunIdentity({
    project_identity,
    run_id: options.runId ?? `${profile.name}-test-run`,
    profile_identity,
  });
  if (!runResult.ok) throw new Error(runResult.diagnostics.map((entry) => entry.code).join(","));
  const run_identity = runResult.value;
  const inventory = buildProviderAgentInventory(descriptor);
  const roles: Record<string, AgentRef> = {};
  for (const [role, registered_name] of Object.entries(roleAgents)) roles[role] = agentRef(registered_name);
  const effective_policy: EffectivePolicy = {
    provider: {
      id: TEST_PROVIDER_ID,
      protocol_version: 2,
      descriptor_fingerprint,
      catalog_content_digest: catalog.content_digest,
    },
    roles,
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
    workflow: { selection: "fixed", profile_identity },
    prompt_context: {},
    required_capabilities: [],
  };
  return {
    catalog,
    profile: selectedProfile,
    profile_identity,
    descriptor,
    descriptor_fingerprint,
    project_identity,
    run_identity,
    agent_inventory: inventory,
    effective_policy,
  };
}

export function qualifiedRoster(fixture: WorkflowV2TestFixture, roster: readonly { role: string; agent: string }[]): Array<{ role: string; agent: string; agent_ref: AgentRef }> {
  return roster.map((entry) => ({ ...entry, agent_ref: fixture.effective_policy.roles[entry.role] ?? agentRef(entry.agent) }));
}

export function workIdentityScopeFixture(
  fixture: WorkflowV2TestFixture,
  input: { readonly workflow: string; readonly stage_id: string; readonly slot_id: string; readonly task_id?: string; readonly dispatch_id?: string },
): WorkIdentityScope {
  return {
    run_id: fixture.run_identity.run_id,
    wave_id: "test-wave",
    slice_id: "test-slice",
    session_id: fixture.project_identity.session.session_id,
    workflow: input.workflow,
    stage_id: input.stage_id,
    stage_cursor: input.stage_id,
    slot_id: input.slot_id,
    task_id: input.task_id ?? `${input.stage_id}-${input.slot_id}`,
    dispatch_id: input.dispatch_id ?? "test-dispatch",
    attempt: 1,
    worker_id: input.slot_id,
  } as const;
}

export function workIdentityFixture(
  fixture: WorkflowV2TestFixture,
  input: { readonly workflow: string; readonly stage_id: string; readonly slot_id: string; readonly task_id?: string; readonly dispatch_id?: string; readonly capability_id?: string; readonly capability_epoch?: string },
) {
  return {
    run_id: fixture.run_identity.run_id,
    wave_id: "test-wave",
    slice_id: "test-slice",
    session_id: fixture.project_identity.session.session_id,
    workflow: input.workflow,
    stage_id: input.stage_id,
    stage_cursor: input.stage_id,
    capability_id: input.capability_id ?? "test-capability",
    capability_epoch: input.capability_epoch ?? "test-epoch",
    slot_id: input.slot_id,
    task_id: input.task_id ?? `${input.stage_id}-${input.slot_id}`,
    dispatch_id: input.dispatch_id ?? "test-dispatch",
    attempt: 1,
    worker_id: input.slot_id,
  } as const;
}
