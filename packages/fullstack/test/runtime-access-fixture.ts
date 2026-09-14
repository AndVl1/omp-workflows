import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openCtoRuntimeAccess, type CtoRuntimeAccessFacade } from "@andvl1/omp-workflows-core/cto-runtime";
import {
  beginRegistryRegistration,
  closeWorkflowActivation,
  createRegistryRegistrationLiveGuard,
  commitRegistryRegistration,
  openWorkflowActivation,
  rollbackRegistryRegistration,
  type RegistryContextSnapshot,
  type WorkflowActivationResult,
  type WorkflowOwnerIdentity,
} from "@andvl1/omp-workflows-core/registry";
import { fullstackOwnerForCwd } from "../src/index.js";
import { writeFullstackActivationMarker } from "../src/activation-marker.js";
import { registerMockAdapterForTesting } from "../src/adapters/mock.js";

export type FullstackRuntimeTestFixture = {
  readonly root: string;
  readonly access: CtoRuntimeAccessFacade;
  readonly activation: Extract<WorkflowActivationResult, { readonly ok: true }>;
  readonly sessionId: string;
  readonly activationSnapshot: RegistryContextSnapshot;
  readonly liveGuard: ReturnType<typeof createRegistryRegistrationLiveGuard>;
  close(): void;
};

/** Open a marker-authenticated main-session CTO capability for one test root. */
export function openFullstackRuntimeTest(
  root = mkdtempSync(join(tmpdir(), "omp-fullstack-runtime-test-")),
  sessionId = "fullstack-runtime-test-session",
  owner: WorkflowOwnerIdentity = fullstackOwnerForCwd(root),
): FullstackRuntimeTestFixture {
  writeFullstackActivationMarker(root);
  const activation = openWorkflowActivation(root, ["workflow_registration", "workflow_tools"], owner);
  if (!activation.ok) {
    rmSync(root, { recursive: true, force: true });
    throw new Error(activation.code + ": " + activation.error);
  }
  const transaction = beginRegistryRegistration(activation.registry_context, root, ["escalation_adapters", "workflow_tools"]);
  if (!transaction.ok) {
    closeWorkflowActivation(activation);
    rmSync(root, { recursive: true, force: true });
    throw new Error(transaction.code + ": " + transaction.error);
  }
  const activationSnapshotGuard = createRegistryRegistrationLiveGuard(transaction.token, "workflow_tools");
  try {
    registerMockAdapterForTesting(transaction.token);
    commitRegistryRegistration(transaction.token);
  } catch (error) {
    try { rollbackRegistryRegistration(transaction.token); } catch { /* preserve registration failure */ }
    closeWorkflowActivation(activation);
    rmSync(root, { recursive: true, force: true });
    throw error;
  }
  const opened = openCtoRuntimeAccess(activation.registry_context, { sessionId, main: true }, root);
  if (!opened.ok) {
    closeWorkflowActivation(activation);
    rmSync(root, { recursive: true, force: true });
    throw new Error(opened.code + ": " + opened.error);
  }
  let closed = false;
  return {
    root,
    access: opened.access,
    activation,
    sessionId,
    activationSnapshot: activationSnapshotGuard(),
    liveGuard: activationSnapshotGuard,
    close(): void {
      if (closed) return;
      closed = true;
      opened.access.close();
      closeWorkflowActivation(activation);
    },
  };
}
