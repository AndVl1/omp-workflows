import {
  compareCanonicalKeys,
  computeCatalogContentDigest,
  computeDescriptorFingerprint,
  buildProviderAgentInventory,
  validateProviderAgentInventory,
  validateProviderCatalog,
  validateProviderDescriptor,
} from "./descriptor.js";
import {
  createDiagnostic,
  failureResult,
  successResult,
} from "./diagnostics.js";
import {
  isProviderId,
  isWorkflowV2Digest,
} from "./identity.js";
import type {
  DiagnosticResult,
  ProviderCapability,
  ProviderCatalog,
  ProviderDescriptor,
  ProviderId,
  ProviderLookupResult,
  ProviderQuarantine,
  ProviderRecord,
  ProviderRegistration,
  ProviderRegistry,
  WorkflowV2Digest,
} from "./types.js";

interface RegistryState {
  readonly providers: Map<ProviderId, ProviderRecord>;
  readonly quarantined: Map<ProviderId, ProviderQuarantine>;
}


const registryStates = new WeakMap<object, RegistryState>();

function registryDiagnostic(
  code: "CONFIG_MALFORMED" | "IDENTITY_MISMATCH" | "PROVIDER_UNAVAILABLE" | "PROVIDER_QUARANTINED" | "CAPABILITY_MISSING" | "AGENT_COLLISION",
  operation: "provider.lookup" | "catalog.validate" | "agent.preflight",
  remediation: string,
  evidence: Record<string, unknown> = {},
) {
  return createDiagnostic({ code, operation, evidence, remediation });
}

function makeRegistryState(): RegistryState {
  return {
    providers: new Map<ProviderId, ProviderRecord>(),
    quarantined: new Map<ProviderId, ProviderQuarantine>(),
  };
}
function stateFor(registry: ProviderRegistry): RegistryState {
  if (registry === null || typeof registry !== "object") throw new TypeError("invalid provider registry capability");
  const state = registryStates.get(registry);
  if (!state) throw new TypeError("invalid provider registry capability");
  return state;
}


/** Create an isolated registry; publication does not touch process globals. */
export function createProviderRegistry(): ProviderRegistry {
  const state = makeRegistryState();
  // The capability has no observable state. Its identity is the only key
  // accepted by stateFor; all mutable state remains in the private WeakMap.
  const registry = Object.freeze(Object.create(null)) as ProviderRegistry;
  registryStates.set(registry, state);
  return registry;
}

const DEFAULT_PROVIDER_REGISTRY = createProviderRegistry();

/** Registry used by provider-neutral management and host integration. */
export function getProviderRegistry(): ProviderRegistry {
  return DEFAULT_PROVIDER_REGISTRY;
}


function registrationId(registration: unknown): ProviderId | undefined {
  if (registration === null || typeof registration !== "object" || Array.isArray(registration)) return undefined;
  if (!("descriptor" in registration)) return undefined;
  const descriptor = registration.descriptor;
  if (descriptor === null || typeof descriptor !== "object" || Array.isArray(descriptor)) return undefined;
  if (!("id" in descriptor)) return undefined;
  return isProviderId(descriptor.id) ? descriptor.id : undefined;
}

function invalidRegistrationDiagnostic(field: string, remediation: string) {
  return registryDiagnostic("CONFIG_MALFORMED", "provider.lookup", remediation, { field });
}

function equivalentRecord(left: ProviderRecord, right: ProviderRecord): boolean {
  // The descriptor and catalog digests cover every immutable value.  The
  // runtime factory is intentionally excluded: duplicate publication is
  // idempotent even when a bundle recreates its closure around the same
  // immutable executable/catalog identity.
  return left.provider_id === right.provider_id
    && left.descriptor_fingerprint === right.descriptor_fingerprint
    && left.catalog.content_digest === right.catalog.content_digest
    && left.descriptor.catalog_content_digest === right.descriptor.catalog_content_digest;
}

function quarantine(
  state: RegistryState,
  registration: ProviderRegistration,
  candidate: ProviderRecord | null,
): DiagnosticResult<ProviderRecord> {
  const providerId = registrationId(registration) ?? candidate?.provider_id;
  const descriptorFingerprint = isWorkflowV2Digest(registration.descriptor_fingerprint)
    ? registration.descriptor_fingerprint
    : candidate?.descriptor_fingerprint ?? null;
  if (!providerId) {
    return failureResult(registryDiagnostic(
      "PROVIDER_QUARANTINED",
      "provider.lookup",
      "Stop the process and publish one immutable descriptor/catalog identity for this provider id.",
      { provider_id: null, descriptor_fingerprint: descriptorFingerprint },
    ));
  }
  const record: ProviderQuarantine = Object.freeze({
    provider_id: providerId,
    reason: "PROVIDER_QUARANTINED",
    descriptor_fingerprint: descriptorFingerprint,
  });
  state.providers.delete(providerId);
  state.quarantined.set(providerId, record);
  return failureResult(registryDiagnostic(
    "PROVIDER_QUARANTINED",
    "provider.lookup",
    "Stop the process and publish one immutable descriptor/catalog identity for this provider id.",
    { provider_id: providerId, descriptor_fingerprint: descriptorFingerprint },
  ));
}

/**
 * Validate and publish an immutable provider registration.  No runtime
 * factory is invoked, and no canonical command/tool registration occurs.
 */
export function publishProvider(
  registry: ProviderRegistry,
  registration: ProviderRegistration,
): DiagnosticResult<ProviderRecord> {
  const state = stateFor(registry);
  const candidateId = registrationId(registration);
  if (candidateId && state.quarantined.has(candidateId)) {
    const existing = state.quarantined.get(candidateId);
    return failureResult(registryDiagnostic(
      "PROVIDER_QUARANTINED",
      "provider.lookup",
      "The provider id is quarantined; restart the lifecycle and resolve the conflicting publication.",
      { provider_id: candidateId, descriptor_fingerprint: existing?.descriptor_fingerprint },
    ));
  }
  if (!registration || typeof registration !== "object" || Array.isArray(registration)) {
    return failureResult(invalidRegistrationDiagnostic("registration", "Publish a descriptor, catalog and runtime factory."));
  }
  if (typeof registration.createRuntime !== "function") {
    return failureResult(invalidRegistrationDiagnostic("createRuntime", "Provide a callable runtime factory separately from immutable descriptor data."));
  }

  const descriptorResult = validateProviderDescriptor(registration.descriptor);
  if (!descriptorResult.ok) {
    const current = candidateId ? state.providers.get(candidateId) : undefined;
    return current ? quarantine(state, registration, current) : failureResult(descriptorResult.diagnostics);
  }
  const catalogResult = validateProviderCatalog(registration.catalog);
  if (!catalogResult.ok) {
    const current = candidateId ? state.providers.get(candidateId) : undefined;
    return current ? quarantine(state, registration, current) : failureResult(catalogResult.diagnostics);
  }
  const descriptor = descriptorResult.value;
  const catalog = catalogResult.value;

  const descriptorFingerprint = computeDescriptorFingerprint(descriptor);
  if (!isWorkflowV2Digest(registration.descriptor_fingerprint) || registration.descriptor_fingerprint !== descriptorFingerprint) {
    const diagnostic = registryDiagnostic(
      "IDENTITY_MISMATCH",
      "provider.lookup",
      "Recompute the descriptor fingerprint from the exact immutable descriptor before publishing.",
      { provider_id: descriptor.id, expected_digest: descriptorFingerprint, actual_digest: registration.descriptor_fingerprint },
    );
    const current = state.providers.get(descriptor.id);
    if (current) return quarantine(state, registration, current);
    return failureResult(diagnostic);
  }
  const catalogDigest = computeCatalogContentDigest(catalog);
  if (catalog.content_digest !== catalogDigest || descriptor.catalog_content_digest !== catalog.content_digest) {
    const diagnostic = registryDiagnostic(
      "IDENTITY_MISMATCH",
      "catalog.validate",
      "Recompute the catalog content digest and pin the descriptor to that exact digest.",
      { provider_id: descriptor.id, expected_digest: descriptor.catalog_content_digest, actual_digest: catalogDigest },
    );
    const current = state.providers.get(descriptor.id);
    if (current) return quarantine(state, registration, current);
    return failureResult(diagnostic);
  }
  const inventory = buildProviderAgentInventory(descriptor);
  const inventoryResult = validateProviderAgentInventory(descriptor, inventory);
  if (!inventoryResult.ok) {
    const current = state.providers.get(descriptor.id);
    return current ? quarantine(state, registration, current) : failureResult(inventoryResult.diagnostics);
  }

  const record: ProviderRecord = Object.freeze({
    provider_id: descriptor.id,
    descriptor,
    descriptor_fingerprint: descriptorFingerprint,
    catalog,
    createRuntime: registration.createRuntime,
  });
  const current = state.providers.get(descriptor.id);
  if (!current) {
    state.providers.set(descriptor.id, record);
    return successResult(record);
  }
  if (equivalentRecord(current, record)) return successResult(current);
  return quarantine(state, registration, current);
}

 

/** Exact provider-id lookup.  No package/order/marker inference is performed. */
export function lookupProvider(registry: ProviderRegistry, providerId: unknown): ProviderLookupResult {
  const state = stateFor(registry);
  if (!isProviderId(providerId)) {
    return failureResult(registryDiagnostic(
      "PROVIDER_UNAVAILABLE",
      "provider.lookup",
      "Use the exact lowercase provider id from the v2 policy.",
      { provider_id: typeof providerId === "string" ? providerId : null },
    ));
  }
  if (state.quarantined.has(providerId)) {
    return failureResult(registryDiagnostic(
      "PROVIDER_QUARANTINED",
      "provider.lookup",
      "Resolve the conflicting provider publication and restart the lifecycle; no publisher wins.",
      { provider_id: providerId },
    ));
  }
  const record = state.providers.get(providerId);
  if (!record) {
    return failureResult(registryDiagnostic(
      "PROVIDER_UNAVAILABLE",
      "provider.lookup",
      "Publish the exact selected provider descriptor/catalog before dispatch.",
      { provider_id: providerId },
    ));
  }
  return successResult(record);
}

/** Stable observational listing; list order never participates in selection. */
export function listProviders(registry: ProviderRegistry = DEFAULT_PROVIDER_REGISTRY): readonly ProviderRecord[] {
  const state = stateFor(registry);
  return Object.freeze([...state.providers.values()].sort((left, right) => compareCanonicalKeys(left.provider_id, right.provider_id)));
}


/** Expose quarantine records for provider-neutral status/list management. */
export function listProviderQuarantine(registry: ProviderRegistry = DEFAULT_PROVIDER_REGISTRY): readonly ProviderQuarantine[] {
  const state = stateFor(registry);
  return Object.freeze([...state.quarantined.values()].sort((left, right) => compareCanonicalKeys(left.provider_id, right.provider_id)));
}

function descriptorFor(provider: ProviderDescriptor | ProviderRecord): ProviderDescriptor {
  return "descriptor" in provider ? provider.descriptor : provider;
}

/**
 * Required capabilities are additive policy constraints.  Descriptor
 * capabilities remain authoritative; this function only checks inclusion.
 */
export function validateProviderCapabilities(
  provider: ProviderDescriptor | ProviderRecord,
  requiredCapabilities: readonly string[],
): DiagnosticResult<readonly ProviderCapability[]> {
  const descriptor = descriptorFor(provider);
  const capabilities = descriptor.capabilities;
  const missing = requiredCapabilities.filter((required) => !capabilities.some((capability) => capability === required));
  if (missing.length > 0) {
    return failureResult(registryDiagnostic(
      "CAPABILITY_MISSING",
      "provider.lookup",
      "Select a provider whose immutable capability set satisfies every additive policy requirement.",
      { provider_id: descriptor.id, missing_capability: missing.join(",") },
    ));
  }
  return successResult(Object.freeze([...capabilities]));
}




export type { ProviderCatalog, ProviderDescriptor, ProviderRegistration, ProviderRecord, ProviderQuarantine, ProviderRegistry } from "./types.js";
