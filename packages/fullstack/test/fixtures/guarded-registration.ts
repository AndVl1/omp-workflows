import {
  beginRegistryRegistration,
  closeWorkflowActivation,
  commitRegistryRegistration,
  openWorkflowActivation,
  rollbackRegistryRegistration,
  type RegistryRegistrationToken,
  type WorkflowActivationResult,
  type WorkflowCapability,
  type WorkflowOwnerIdentity,
} from "@andvl1/omp-workflows-core/registry";
import { writeFullstackActivationMarker } from "../../src/activation-marker.js";

export type HeldRegistration = {
  readonly root: string;
  readonly token: RegistryRegistrationToken;
  readonly activation: Extract<WorkflowActivationResult, { ok: true }>;
  commit(): void;
  close(): void;
};

export function beginHeldRegistration(
  root: string,
  capabilities: readonly WorkflowCapability[],
  owner: WorkflowOwnerIdentity,
  families: Parameters<typeof beginRegistryRegistration>[2],
): HeldRegistration {
  writeFullstackActivationMarker(root);
  const activation = openWorkflowActivation(root, capabilities, owner);
  if (!activation.ok) throw new Error(`${activation.code}: ${activation.error}`);
  const transaction = beginRegistryRegistration(activation.registry_context, root, families);
  if (!transaction.ok) {
    closeWorkflowActivation(activation);
    throw new Error(`${transaction.code}: ${transaction.error}`);
  }
  let committed = false;
  let closed = false;
  return {
    root,
    token: transaction.token,
    activation,
    commit(): void {
      if (committed || closed) return;
      commitRegistryRegistration(transaction.token);
      committed = true;
    },
    close(): void {
      if (closed) return;
      closed = true;
      if (!committed) {
        try { rollbackRegistryRegistration(transaction.token); } catch { /* preserve the original teardown */ }
      }
      closeWorkflowActivation(activation);
    },
  };
}
