/* <!-- omp-cto-slice run=01a03ee4-7dd6-7580-8ad7-16d26dc886ba slice=workflow-v2-fullstack --> */

/**
 * @andvl1/omp-workflows-fullstack — provider-v2 bundle entrypoint.
 *
 * This module contains only bundle-local, non-canonical behavior. The core v2
 * host owns every canonical command and workflow tool. A launcher that has
 * already obtained the trusted filesystem/inventory authorities may call
 * registerFullstackHost; loading this package by itself never invents those
 * authorities and never registers a private command copy.
 */
import type {
  BeforeAgentStartEvent,
  BeforeAgentStartEventResult,
  ExtensionAPI,
} from "@oh-my-pi/pi-coding-agent";
import {
  registerWorkflowV2Host,
  WORKFLOW_V2_HOST_DESCRIPTOR,
  WorkflowV2HostAdmissionError,
  type ModelRoleEntry,
  type WorkflowHost,
  type WorkflowHostOptions,
} from "@andvl1/omp-workflows-core";
import { publishFullstackProvider } from "./provider.js";
import {
  RESEARCH_REQUEST_MARKER_END,
  RESEARCH_REQUEST_MARKER_START,
  buildResearchRequestDeveloperInstruction,
} from "./before-agent-start-marker.js";

/** Bundle-local immutable view of the core role entry contract. */
type FullstackModelRoleEntry = Readonly<Omit<ModelRoleEntry, "agents">> & {
  readonly agents: ReadonlyArray<ModelRoleEntry["agents"][number]>;
};

/** Model-role taxonomy used only by the non-canonical model-role command hook. */
export const FULLSTACK_MODEL_ROLE_ENTRIES: readonly FullstackModelRoleEntry[] = Object.freeze([
  Object.freeze({ role: "architect", agents: Object.freeze(["architect"]), standardFallback: "@slow" }),
  Object.freeze({ role: "reviewer", agents: Object.freeze(["code-reviewer"]), standardFallback: "@slow" }),
  Object.freeze({ role: "security", agents: Object.freeze(["security-tester"]), standardFallback: "@slow" }),
  Object.freeze({ role: "researcher", agents: Object.freeze(["tech-researcher", "discovery"]), standardFallback: "@smol" }),
  Object.freeze({ role: "analyst", agents: Object.freeze(["analyst"]), standardFallback: "@task" }),
  Object.freeze({ role: "developer-go", agents: Object.freeze(["developer-go"]), standardFallback: "@task" }),
  Object.freeze({ role: "developer-kotlin", agents: Object.freeze(["developer-kotlin"]), standardFallback: "@task" }),
  Object.freeze({ role: "frontend-developer", agents: Object.freeze(["frontend-developer"]), standardFallback: "@task" }),
  Object.freeze({ role: "developer-mobile", agents: Object.freeze(["developer-mobile", "init-mobile"]), standardFallback: "@task" }),
  Object.freeze({ role: "devops", agents: Object.freeze(["devops"]), standardFallback: "@task" }),
  Object.freeze({ role: "diagnostics", agents: Object.freeze(["diagnostics"]), standardFallback: "@task" }),
  Object.freeze({ role: "qa", agents: Object.freeze(["qa"]), standardFallback: "@task" }),
  Object.freeze({ role: "manual-qa", agents: Object.freeze(["manual-qa"]), standardFallback: "@task" }),
]);

const ROLE_COUNT = FULLSTACK_MODEL_ROLE_ENTRIES.length;

/**
 * Detect the opaque model-role research envelope and attach the contract as an
 * agent-attributed message. This hook has no project, profile, or filesystem
 * authority and therefore remains safe to install before host admission.
 */
function beforeAgentStartMarkerHandler(
  event: BeforeAgentStartEvent,
): BeforeAgentStartEventResult | undefined {
  if (typeof event?.prompt !== "string") return undefined;
  if (!event.prompt.includes(RESEARCH_REQUEST_MARKER_START)) return undefined;
  if (!event.prompt.includes(RESEARCH_REQUEST_MARKER_END)) return undefined;
  return {
    message: {
      customType: "omp-model-roles-research-instructions",
      content: buildResearchRequestDeveloperInstruction(ROLE_COUNT),
      display: true,
      details: {
        kind: "omp-model-role-research-request",
        schemaVersion: 1,
        requestedAt: new Date().toISOString(),
        roleCount: ROLE_COUNT,
        modelCount: null,
      },
      attribution: "agent",
    },
  };
}

/**
 * Publish this immutable provider and install the one canonical v2 host.
 * Registration is intentionally explicit: the caller supplies manager-owned
 * root/session resolvers plus factory-issued filesystem and OMP inventory
 * authorities. No fallback authority is constructed here.
 */
export function registerFullstackHost(
  pi: ExtensionAPI,
  options: WorkflowHostOptions,
): WorkflowHost {
  const published = publishFullstackProvider(options.registry);
  if (!published.ok) throw new WorkflowV2HostAdmissionError(published.diagnostics);
  return registerWorkflowV2Host(pi, {
    ...options,
    host: options.host ?? WORKFLOW_V2_HOST_DESCRIPTOR,
  });
}

/**
 * Install the marker-only bundle hook. A host is installed only when an
 * explicit launcher-owned WorkflowHostOptions value is supplied; otherwise
 * publication and canonical command/tool registration remain host-owned.
 */
export default function ompWorkflowsFullstack(
  pi: ExtensionAPI,
  options?: WorkflowHostOptions,
): WorkflowHost | undefined {
  pi.on("before_agent_start", beforeAgentStartMarkerHandler);
  return options === undefined ? undefined : registerFullstackHost(pi, options);
}

export { FULLSTACK_PROVIDER_DESCRIPTOR } from "./provider.js";
export {
  FULLSTACK_PROVIDER_CATALOG,
  FULLSTACK_PROVIDER_REGISTRATION,
  FULLSTACK_PROVIDER_ID,
  FULLSTACK_PROVIDER_AGENT_REFS,
  FULLSTACK_PROVIDER_AGENT_SOURCES,
  FULLSTACK_PROVIDER_CATALOG_CONTENT_DIGEST,
  FULLSTACK_PROVIDER_DESCRIPTOR_FINGERPRINT,
  FULLSTACK_PROVIDER_PROFILE_IDENTITIES,
  createFullstackProviderRegistration,
  publishFullstackProvider,
} from "./provider.js";

export {
  FULLSTACK_STORAGE_LIMITS,
  canonicalChannelConfig,
  channelConfigDigest,
  createFullstackStorageAuthority,
  isChannelAdmission,
  isFullstackStorageAuthority,
  isFullstackTreeStorageAuthority,
  type ChannelAdmission,
  type ChannelAdmissionInput,
  type ChannelEndpointPolicy,
  type FullstackStorageAuthority,
  type FullstackStorageAuthorityOptions,
  type FullstackStorageNativeBackend,
  type FullstackTreeStorageAuthority,
  type StorageEntry,
  type StorageFailure,
  type StorageFailureReason,
  type StorageLease,
  type StorageResult,
  type StorageStat,
  type StorageTreeEntry,
  type StorageTreeLimits,
  type StorageTreePublishResult,
} from "./storage-authority.js";

export {
  validateFullstackInventoryAdmission,
  type FullstackInventoryAdmissionContext,
} from "./agent-mapping.js";
