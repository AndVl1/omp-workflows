/**
 * Marker-bound registry ownership seam.
 *
 * Activation is an explicit workspace opt-in: the declared marker set must be
 * present and remain live while the owner claim is used. This boundary is not
 * cryptographic authentication of a package or bundle; same-process loaded
 * JavaScript is trusted. It deliberately excludes raw owner claims, mutable
 * registry cells, raw context-close hooks, and marker/context minting internals.
 * Bundles may only open an activation and complete a token-bound transaction
 * through these operations.
 */
import {
  closeRegistryRegistrationContext,
  releaseWorkflowActivation,
  type WorkflowActivationResult,
  type WorkflowCapability,
  type WorkflowOwnerReleaseResult,
} from "./owner.js";

function emptyReleaseResult(skipped: readonly WorkflowCapability[] = []): WorkflowOwnerReleaseResult {
  return { project_root: undefined, released: Object.freeze([]), skipped: Object.freeze([...skipped]) };
}

/** Close one successful activation and consume every lease acquired by it. */
export function closeWorkflowActivation(activation: Extract<WorkflowActivationResult, { ok: true }>): WorkflowOwnerReleaseResult {
  if (!activation || typeof activation !== "object" || activation.ok !== true) return emptyReleaseResult();
  closeRegistryRegistrationContext(activation.registry_context);
  return releaseWorkflowActivation(activation.release_token);
}

export {
  beginRegistryRegistration,
  commitRegistryRegistration,
  createRegistryRegistrationLiveGuard,
  openWorkflowActivation,
  recordRegistryUndo,
  registryRegistrationContextForToken,
  registryRegistrationPrincipal,
  registryRegistrationProjectRoot,
  releaseWorkflowOwner,
  releaseWorkflowOwners,
  requireRegistryRegistration,
  rollbackRegistryRegistration,
} from "./owner.js";

export type {
  RegistryContextSnapshot,
  RegistryFamily,
  RegistryRegistrationContext,
  RegistryRegistrationPrincipal,
  RegistryRegistrationToken,
  WorkflowActivationResult,
  WorkflowCapability,
  WorkflowOwnerActivation,
  WorkflowOwnerActivationRequirement,
  WorkflowOwnerIdentity,
  WorkflowOwnerKind,
  WorkflowOwnerProvenance,
  WorkflowOwnerReleaseResult,
  WorkflowOwnerReleaseToken,
  WorkflowOwnerSource,
} from "./owner.js";
