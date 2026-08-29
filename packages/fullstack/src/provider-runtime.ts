/* <!-- omp-cto-slice run=01a03ee4-7dd6-7580-8ad7-16d26dc886ba slice=workflow-v2-fullstack --> */
import { createHash } from "node:crypto";
import {
  canonicalPolicyJson,
  computeCatalogContentDigest,
  computeDescriptorFingerprint,
  effectivePolicyFromSnapshot,
  isCanonicalRoot,
  isWorkflowV2Digest,
  projectRuntimeKeyFor,
  validateProjectIdentity,
  validateWorkflowRunIdentity,
  validateProviderActivationAdmission,
  validateProviderCatalog,
  validateProviderDescriptor,
  type ActualAgentInventory,
  type AgentRef,
  type DiagnosticResult,
  type EffectivePolicy,
  type ProviderActivationAdmission,
  type ProviderActivationAdmissionExpectation,
  type ProviderDispatchResult,
  type ProviderRuntime,
  type ProviderRuntimeContext,
  type ValidatedDispatch,
  type WorkflowRunIdentity,
  type WorkflowV2Digest,
} from "@andvl1/omp-workflows-core";
import {
  FULLSTACK_PROVIDER_CATALOG_CONTENT_DIGEST,
  FULLSTACK_PROVIDER_CATALOG,
  FULLSTACK_PROVIDER_DESCRIPTOR_FINGERPRINT,
  FULLSTACK_PROVIDER_DESCRIPTOR,
  FULLSTACK_PROVIDER_ID,
} from "./provider.js";

/**
 * The fullstack bundle publishes a runtime boundary, but phase 2 does not own
 * a workflow executor.  Core therefore remains the sole owner of dispatch
 * admission and a launcher must inject the real phase-3 executor before any
 * work can run.  Keeping this boundary explicit is preferable to echoing an
 * invocation or pretending that a dispatch succeeded.
 */
const MISSING_EXECUTOR_EVIDENCE =
  "fullstack runtime dispatch is fail-closed: phase-3 host executor and trusted authorities are required";
const SHUTDOWN_EVIDENCE =
  "fullstack runtime dispatch is unavailable after deterministic runtime shutdown";
const INVALID_ADMISSION_EVIDENCE =
  "fullstack runtime activation requires the opaque core admission for the exact descriptor, project, runtime, inventory, and reservation";
const EFFECTIVE_POLICY_KEYS = [
  "provider",
  "roles",
  "scope_map",
  "roster_overrides",
  "flags",
  "runtime_classes",
  "ui_classes",
  "design_system",
  "commands",
  "workflow",
  "prompt_context",
  "required_capabilities",
] as const;
const EFFECTIVE_POLICY_PROVIDER_KEYS = [
  "id",
  "protocol_version",
  "descriptor_fingerprint",
  "catalog_content_digest",
] as const;
const EFFECTIVE_POLICY_MAX_DEPTH = 16;
const EFFECTIVE_POLICY_MAX_KEYS = 2_048;
const EFFECTIVE_POLICY_MAX_ITEMS = 2_048;
const EFFECTIVE_POLICY_MAX_BYTES = 262_144;

function isPlainPolicyRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  try {
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
  } catch {
    return false;
  }
}

function hasExactPolicyKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
): boolean {
  const keys = Object.keys(value);
  return keys.length === expected.length
    && expected.every((key) => Object.prototype.hasOwnProperty.call(value, key));
}

function boundedPolicyValue(
  value: unknown,
  depth: number,
  state: { readonly seen: Set<object>; keys: number; items: number },
): boolean {
  if (value === null || typeof value !== "object") return true;
  if (depth > EFFECTIVE_POLICY_MAX_DEPTH || state.seen.has(value)) return false;
  state.seen.add(value);
  try {
    if (Array.isArray(value)) {
      if (value.length > EFFECTIVE_POLICY_MAX_ITEMS) return false;
      state.items += value.length;
      if (state.items > EFFECTIVE_POLICY_MAX_ITEMS) return false;
      for (let index = 0; index < value.length; index += 1) {
        if (!Object.prototype.hasOwnProperty.call(value, index)
          || !boundedPolicyValue(value[index], depth + 1, state)) return false;
      }
      return true;
    }
    if (!isPlainPolicyRecord(value)) return false;
    const keys = Object.keys(value);
    state.keys += keys.length;
    if (state.keys > EFFECTIVE_POLICY_MAX_KEYS) return false;
    return keys.every((key) => boundedPolicyValue(value[key], depth + 1, state));
  } finally {
    state.seen.delete(value);
  }
}

function effectivePolicyDigest(value: unknown): WorkflowV2Digest | undefined {
  try {
    if (!boundedPolicyValue(value, 0, { seen: new Set<object>(), keys: 0, items: 0 })) {
      return undefined;
    }
    const canonical = canonicalPolicyJson(value);
    if (Buffer.byteLength(canonical, "utf8") > EFFECTIVE_POLICY_MAX_BYTES) return undefined;
    return `sha256:${createHash("sha256").update(canonical, "utf8").digest("hex")}` as WorkflowV2Digest;
  } catch {
    return undefined;
  }
}


function validFullstackEffectivePolicy(value: unknown): value is Readonly<EffectivePolicy> {
  if (!isPlainPolicyRecord(value)
    || !hasExactPolicyKeys(value, EFFECTIVE_POLICY_KEYS)
    || effectivePolicyDigest(value) === undefined) return false;
  const provider = value.provider;
  return isPlainPolicyRecord(provider)
    && hasExactPolicyKeys(provider, EFFECTIVE_POLICY_PROVIDER_KEYS)
    && provider.id === FULLSTACK_PROVIDER_ID
    && provider.protocol_version === 2
    && provider.descriptor_fingerprint === FULLSTACK_PROVIDER_DESCRIPTOR_FINGERPRINT
    && provider.catalog_content_digest === FULLSTACK_PROVIDER_CATALOG_CONTENT_DIGEST;
}

function sameAgent(left: AgentRef, right: AgentRef): boolean {
  return left.registered_name === right.registered_name
    && left.provider_id === right.provider_id
    && left.source_fingerprint === right.source_fingerprint;
}
function selectedInventoryBound(selected: readonly AgentRef[], actual: ActualAgentInventory): boolean {
  return Array.isArray(selected)
    && selected.length > 0
    && selected.every((candidate) => actual.agents.some((observed) => sameAgent(candidate, observed)));
}
function sameProjectIdentity(
  left: ProviderRuntimeContext["project_identity"],
  right: ProviderRuntimeContext["project_identity"],
): boolean {
  return left.root_instance_id === right.root_instance_id
    && left.provider_id === right.provider_id
    && left.descriptor_fingerprint === right.descriptor_fingerprint
    && left.executable_provenance.build_fingerprint === right.executable_provenance.build_fingerprint
    && left.executable_provenance.runtime_fingerprint === right.executable_provenance.runtime_fingerprint
    && left.catalog_content_digest === right.catalog_content_digest
    && left.config_byte_sha256 === right.config_byte_sha256
    && left.config_semantic_sha256 === right.config_semantic_sha256
    && left.session.session_id === right.session.session_id
    && left.session.lifecycle_id === right.session.lifecycle_id;
}

function admissionFailure(context: ProviderRuntimeContext, message: string): never {
  throw new TypeError(`${message}: ${context.project_identity.provider_id}`);
}


/**
 * Core validates and deep-clones provider descriptors/catalogs before storing
 * them in ProviderRecord. Runtime admission therefore validates immutable
 * values and their canonical digests, rather than relying on object identity.
 */
function validFullstackProviderContext(context: ProviderRuntimeContext): boolean {
  try {
    const identity = validateProjectIdentity(context.project_identity);
    const descriptor = validateProviderDescriptor(context.descriptor);
    const catalog = validateProviderCatalog(context.catalog);
    if (!identity.ok || !descriptor.ok || !catalog.ok) return false;
    return Object.isFrozen(context.project_identity)
      && Object.isFrozen(context.descriptor)
      && Object.isFrozen(context.catalog)
      && validFullstackEffectivePolicy(context.effective_policy)
      && context.project_identity.provider_id === FULLSTACK_PROVIDER_ID
      && context.project_identity.descriptor_fingerprint === FULLSTACK_PROVIDER_DESCRIPTOR_FINGERPRINT
      && context.project_identity.catalog_content_digest === FULLSTACK_PROVIDER_CATALOG_CONTENT_DIGEST
      && context.project_identity.executable_provenance.build_fingerprint
        === FULLSTACK_PROVIDER_DESCRIPTOR.executable_provenance.build_fingerprint
      && context.project_identity.executable_provenance.runtime_fingerprint
        === FULLSTACK_PROVIDER_DESCRIPTOR.executable_provenance.runtime_fingerprint
      && context.descriptor.id === FULLSTACK_PROVIDER_ID
      && context.descriptor.protocol_version === FULLSTACK_PROVIDER_DESCRIPTOR.protocol_version
      && context.descriptor.catalog_content_digest === FULLSTACK_PROVIDER_CATALOG_CONTENT_DIGEST
      && context.descriptor.executable_provenance.build_fingerprint
        === FULLSTACK_PROVIDER_DESCRIPTOR.executable_provenance.build_fingerprint
      && context.descriptor.executable_provenance.runtime_fingerprint
        === FULLSTACK_PROVIDER_DESCRIPTOR.executable_provenance.runtime_fingerprint
      && context.catalog.content_digest === FULLSTACK_PROVIDER_CATALOG_CONTENT_DIGEST
      && computeDescriptorFingerprint(context.descriptor) === FULLSTACK_PROVIDER_DESCRIPTOR_FINGERPRINT
      && computeCatalogContentDigest(context.catalog) === FULLSTACK_PROVIDER_CATALOG_CONTENT_DIGEST
      && isCanonicalRoot(context.canonical_root)
      && isWorkflowV2Digest(context.runtime_key)
      && projectRuntimeKeyFor(context.project_identity) === context.runtime_key;
  } catch {
    return false;
  }
}

function checkedRuntimeAdmission(context: ProviderRuntimeContext): ProviderActivationAdmission {
  if (!context || typeof context !== "object" || !validFullstackProviderContext(context)) {
    throw new TypeError(INVALID_ADMISSION_EVIDENCE);
  }

  const activation = context.activation_admission;
  if (!activation || typeof activation !== "object") {
    return admissionFailure(context, INVALID_ADMISSION_EVIDENCE);
  }
  let checked: DiagnosticResult<ProviderActivationAdmission>;
  try {
    const contextPolicyDigest = effectivePolicyDigest(context.effective_policy);
    const authorityPolicyDigest = effectivePolicyDigest(activation.authority_context?.effective_policy);
    if (
      contextPolicyDigest === undefined
      || authorityPolicyDigest === undefined
      || contextPolicyDigest !== authorityPolicyDigest
    ) {
      return admissionFailure(context, INVALID_ADMISSION_EVIDENCE);
    }
    const expected: ProviderActivationAdmissionExpectation = {
      project_identity: context.project_identity,
      runtime_key: context.runtime_key,
      canonical_root: context.canonical_root,
      provider_id: FULLSTACK_PROVIDER_ID,
      descriptor_fingerprint: FULLSTACK_PROVIDER_DESCRIPTOR_FINGERPRINT,
      catalog_content_digest: FULLSTACK_PROVIDER_CATALOG_CONTENT_DIGEST,
      executable_provenance: FULLSTACK_PROVIDER_DESCRIPTOR.executable_provenance,
      agent_inventory: activation.agent_inventory,
      agent_inventory_authority: activation.agent_inventory_authority,
      authority_context: activation.authority_context,
    };
    checked = validateProviderActivationAdmission(activation, expected);
  } catch {
    return admissionFailure(context, INVALID_ADMISSION_EVIDENCE);
  }
  if (!checked.ok) {
    return admissionFailure(context, checked.diagnostics[0]?.remediation ?? INVALID_ADMISSION_EVIDENCE);
  }
  if (Object.prototype.hasOwnProperty.call(activation, "run_identity")) {
    return admissionFailure(context, INVALID_ADMISSION_EVIDENCE);
  }

  const actual = checked.value.agent_inventory;
  const reservation = actual.reservation;
  if (reservation === undefined || !selectedInventoryBound(context.agent_inventory, actual)) {
    return admissionFailure(context, INVALID_ADMISSION_EVIDENCE);
  }

  return checked.value;
}

function validDispatchProviderValues(
  context: ProviderRuntimeContext,
  input: ValidatedDispatch,
  capturedPolicyDigest: WorkflowV2Digest,
): boolean {
  try {
    const descriptor = validateProviderDescriptor(input.descriptor);
    const catalog = validateProviderCatalog(input.catalog);
    if (!descriptor.ok || !catalog.ok) return false;

    const canonicalDescriptor = descriptor.value;
    const canonicalCatalog = catalog.value;
    const descriptorDigest = computeDescriptorFingerprint(canonicalDescriptor);
    const catalogDigest = computeCatalogContentDigest(canonicalCatalog);
    const inputPolicyDigest = effectivePolicyDigest(input.effective_policy);
    const contextPolicyDigest = effectivePolicyDigest(context.effective_policy);
    const derivedPolicy = effectivePolicyFromSnapshot(input.snapshot, input.descriptor);
    if (
      !validFullstackEffectivePolicy(input.effective_policy)
      || !derivedPolicy.ok
      || !validFullstackEffectivePolicy(derivedPolicy.value)
    ) return false;
    const derivedPolicyDigest = effectivePolicyDigest(derivedPolicy.value);
    if (
      inputPolicyDigest === undefined
      || contextPolicyDigest === undefined
      || derivedPolicyDigest === undefined
      || contextPolicyDigest !== capturedPolicyDigest
      || inputPolicyDigest !== capturedPolicyDigest
      || inputPolicyDigest !== derivedPolicyDigest
    ) return false;
    return canonicalDescriptor.id === FULLSTACK_PROVIDER_ID
      && canonicalDescriptor.id === context.descriptor.id
      && canonicalDescriptor.id === context.project_identity.provider_id
      && canonicalDescriptor.protocol_version === FULLSTACK_PROVIDER_DESCRIPTOR.protocol_version
      && canonicalDescriptor.protocol_version === context.descriptor.protocol_version
      && canonicalDescriptor.catalog_content_digest === FULLSTACK_PROVIDER_CATALOG_CONTENT_DIGEST
      && canonicalDescriptor.catalog_content_digest === context.descriptor.catalog_content_digest
      && canonicalDescriptor.executable_provenance.build_fingerprint
        === FULLSTACK_PROVIDER_DESCRIPTOR.executable_provenance.build_fingerprint
      && canonicalDescriptor.executable_provenance.build_fingerprint
        === context.descriptor.executable_provenance.build_fingerprint
      && canonicalDescriptor.executable_provenance.build_fingerprint
        === context.project_identity.executable_provenance.build_fingerprint
      && canonicalDescriptor.executable_provenance.runtime_fingerprint
        === FULLSTACK_PROVIDER_DESCRIPTOR.executable_provenance.runtime_fingerprint
      && canonicalDescriptor.executable_provenance.runtime_fingerprint
        === context.descriptor.executable_provenance.runtime_fingerprint
      && canonicalDescriptor.executable_provenance.runtime_fingerprint
        === context.project_identity.executable_provenance.runtime_fingerprint
      && descriptorDigest === FULLSTACK_PROVIDER_DESCRIPTOR_FINGERPRINT
      && descriptorDigest === context.project_identity.descriptor_fingerprint
      && canonicalCatalog.content_digest === FULLSTACK_PROVIDER_CATALOG_CONTENT_DIGEST
      && canonicalCatalog.content_digest === context.catalog.content_digest
      && canonicalCatalog.content_digest === context.project_identity.catalog_content_digest
      && catalogDigest === FULLSTACK_PROVIDER_CATALOG_CONTENT_DIGEST
      && catalogDigest === computeCatalogContentDigest(context.catalog);
  } catch {
    return false;
  }
}

function sameRunIdentity(left: WorkflowRunIdentity, right: WorkflowRunIdentity): boolean {
  return sameProjectIdentity(left, right)
    && left.run_id === right.run_id
    && left.profile_identity.id === right.profile_identity.id
    && left.profile_identity.fingerprint === right.profile_identity.fingerprint;
}

function checkedDispatchAdmission(
  context: ProviderRuntimeContext,
  runtimeAdmission: ProviderActivationAdmission,
  input: ValidatedDispatch,
  capturedPolicyDigest: WorkflowV2Digest,
): void {
  const projectIdentity = validateProjectIdentity(input.project_identity);
  if (
    (input.identity_level !== "project" && input.identity_level !== "run")
    || !projectIdentity.ok
    || !sameProjectIdentity(projectIdentity.value, context.project_identity)
    || !isWorkflowV2Digest(input.runtime_key)
    || input.runtime_key !== context.runtime_key
    || !isCanonicalRoot(input.snapshot.root)
    || input.snapshot.root !== context.canonical_root
    || !validDispatchProviderValues(context, input, capturedPolicyDigest)
  ) {
    throw new TypeError(INVALID_ADMISSION_EVIDENCE);
  }

  let runIdentity: WorkflowRunIdentity | undefined;
  if (input.identity_level === "run") {
    const checkedRun = validateWorkflowRunIdentity(input.run_identity);
    if (!checkedRun.ok) throw new TypeError(INVALID_ADMISSION_EVIDENCE);
    if (
      !sameRunIdentity(input.run_identity, checkedRun.value)
      || !sameProjectIdentity(checkedRun.value, context.project_identity)
    ) {
      throw new TypeError(INVALID_ADMISSION_EVIDENCE);
    }
    runIdentity = checkedRun.value;
  } else if (Object.prototype.hasOwnProperty.call(input, "run_identity")) {
    throw new TypeError(INVALID_ADMISSION_EVIDENCE);
  }

  let checked: DiagnosticResult<ProviderActivationAdmission>;
  try {
    const expected: ProviderActivationAdmissionExpectation = {
      project_identity: context.project_identity,
      runtime_key: context.runtime_key,
      canonical_root: context.canonical_root,
      provider_id: runtimeAdmission.provider_id,
      descriptor_fingerprint: runtimeAdmission.descriptor_fingerprint,
      catalog_content_digest: runtimeAdmission.catalog_content_digest,
      executable_provenance: runtimeAdmission.executable_provenance,
      agent_inventory: runtimeAdmission.agent_inventory,
      agent_inventory_authority: runtimeAdmission.agent_inventory_authority,
      authority_context: runtimeAdmission.authority_context,
      ...(runIdentity === undefined ? {} : { run_identity: runIdentity }),
    };
    checked = validateProviderActivationAdmission(input.activation_admission, expected);
  } catch {
    throw new TypeError(INVALID_ADMISSION_EVIDENCE);
  }
  if (!checked.ok || !selectedInventoryBound(input.agent_inventory, checked.value.agent_inventory)) {
    throw new TypeError(INVALID_ADMISSION_EVIDENCE);
  }
}

function failedResult(input: ValidatedDispatch, evidence: string): ProviderDispatchResult {
  if (input.identity_level === "run") {
    return Object.freeze({
      identity_level: "run",
      project_identity: input.project_identity,
      run_identity: input.run_identity,
      runtime_key: input.runtime_key,
      status: "failed",
      evidence,
    });
  }
  return Object.freeze({
    identity_level: "project",
    project_identity: input.project_identity,
    runtime_key: input.runtime_key,
    status: "failed",
    evidence,
  });
}

/**
 * Create one profile-free provider runtime for a validated project context.
 * Construction deliberately does not select a profile, create a workflow run,
 * read the filesystem, register commands, or start a dispatcher.
 */
export function createFullstackProviderRuntime(context: ProviderRuntimeContext): ProviderRuntime {
  const admission = checkedRuntimeAdmission(context);
  const capturedPolicyDigest = effectivePolicyDigest(context.effective_policy);
  if (capturedPolicyDigest === undefined) {
    throw new TypeError(INVALID_ADMISSION_EVIDENCE);
  }
  const capturedContext: ProviderRuntimeContext = Object.freeze({
    project_identity: context.project_identity,
    runtime_key: context.runtime_key,
    canonical_root: context.canonical_root,
    descriptor: context.descriptor,
    catalog: context.catalog,
    effective_policy: context.effective_policy,
    agent_inventory: context.agent_inventory,
    activation_admission: admission,
  });
  let stopped = false;

  return Object.freeze({
    dispatch: async (input: ValidatedDispatch): Promise<ProviderDispatchResult> => {
      if (stopped) return failedResult(input, SHUTDOWN_EVIDENCE);
      try {
        checkedDispatchAdmission(capturedContext, admission, input, capturedPolicyDigest);
      } catch {
        return failedResult(input, INVALID_ADMISSION_EVIDENCE);
      }
      return failedResult(input, MISSING_EXECUTOR_EVIDENCE);
    },
    shutdown: (): void => {
      // Idempotent by construction; no resource is created before a real
      // phase-3 executor is injected by the host.
      stopped = true;
    },
  });
}
