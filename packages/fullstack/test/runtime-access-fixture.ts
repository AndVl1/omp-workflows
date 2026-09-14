import { randomUUID } from "node:crypto";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openCtoRuntimeAccess, openCtoRuntimeProofAuthority, revokeCtoRuntimeProofAuthority, type CtoRuntimeAccessFacade, type CtoRuntimeProofAuthority } from "@andvl1/omp-workflows-core/cto-runtime";
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
import { issueCtoRuntimeSessionAuthority } from "../../core/dist/cto/session-authority.js";
import { PinnedProjectRoot } from "@andvl1/omp-workflows-core";
import { fullstackOwnerForCwd } from "../src/index.js";
import { writeFullstackActivationMarker } from "../src/activation-marker.js";
import { registerMockAdapterForTesting } from "../src/adapters/mock.js";

export type FullstackRuntimeTestFixture = {
  readonly root: string;
  readonly access: CtoRuntimeAccessFacade;
  readonly proofAuthority: CtoRuntimeProofAuthority;
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
  writeMarker = true,
  registerMock = true,
): FullstackRuntimeTestFixture {
  if (writeMarker) writeFullstackActivationMarker(root);
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
    if (registerMock) registerMockAdapterForTesting(transaction.token);
    commitRegistryRegistration(transaction.token);
  } catch (error) {
    try { rollbackRegistryRegistration(transaction.token); } catch { /* preserve registration failure */ }
    closeWorkflowActivation(activation);
    rmSync(root, { recursive: true, force: true });
    throw error;
  }
  const pinnedRoot = PinnedProjectRoot.open(root);
  if (!pinnedRoot) {
    closeWorkflowActivation(activation);
    rmSync(root, { recursive: true, force: true });
    throw new Error("proof authority root unavailable");
  }
  const sessionFile = join(root, ".omp", `session-${sessionId}.json`);
  mkdirSync(join(root, ".omp"), { recursive: true });
  writeFileSync(sessionFile, JSON.stringify({ sessionId, pid: process.pid }), { mode: 0o600 });
  const sessionBasename = sessionFile.split(/[\\/]/u).at(-1)!;
  const generation = `${process.pid}:${randomUUID()}`;
  const sessionManager = Object.freeze({
    getCwd: () => root,
    getSessionId: () => sessionId,
    getSessionFile: () => sessionFile,
    getSessionGeneration: () => generation,
  });
  const authority = issueCtoRuntimeSessionAuthority(
    activation.registry_context,
    { canonical_root: pinnedRoot.canonical_root, dev: pinnedRoot.dev, ino: pinnedRoot.ino },
    { sessionManager, sessionId, sessionFile, sessionBasename, generation },
    () => { activationSnapshotGuard(); },
  );
  const opened = openCtoRuntimeAccess(activation.registry_context, authority, root);
  if (!opened.ok) {
    pinnedRoot.close();
    closeWorkflowActivation(activation);
    rmSync(root, { recursive: true, force: true });
    throw new Error(opened.code + ": " + opened.error);
  }
  const proofAuthority = openCtoRuntimeProofAuthority(activation.registry_context, pinnedRoot);
  if (!proofAuthority) {
    pinnedRoot.close();
    opened.access.close();
    closeWorkflowActivation(activation);
    rmSync(root, { recursive: true, force: true });
    throw new Error("proof authority unavailable");
  }
  let closed = false;
  return {
    root,
    access: opened.access,
    proofAuthority,
    activation,
    sessionId,
    activationSnapshot: activationSnapshotGuard(),
    liveGuard: activationSnapshotGuard,
    close(): void {
      if (closed) return;
      closed = true;
      revokeCtoRuntimeProofAuthority(proofAuthority);
      pinnedRoot.close();
      opened.access.close();
      closeWorkflowActivation(activation);
    },
  };
}
