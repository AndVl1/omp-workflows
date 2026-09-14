// Test-only capability injection. Production imports never register the fake transport.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  openWorkflowActivation,
  beginRegistryRegistration,
  closeWorkflowActivation,
  commitRegistryRegistration,
  rollbackRegistryRegistration,
  type RegistryRegistrationToken,
  type WorkflowOwnerIdentity,
} from "@andvl1/omp-workflows-core/registry";
import {
  FULLSTACK_ACTIVATION_MARKER_PATH,
  FULLSTACK_ACTIVATION_MARKER_SHA256,
  writeFullstackActivationMarker,
} from "../src/activation-marker.js";
import { registerMockAdapterForTesting } from "../src/adapters/mock.js";

export function fullstackTestOwner(root: string): WorkflowOwnerIdentity {
  return {
    owner_id: "@andvl1/omp-workflows-fullstack",
    bundle_id: "@andvl1/omp-workflows-fullstack",
    owner_kind: "fullstack",
    activation_marker: "omp-fullstack",
    host_range: ">=17 <19",
    activation: {
      marker_id: "omp-fullstack",
      required: [{ path: FULLSTACK_ACTIVATION_MARKER_PATH, kind: "file", sha256: FULLSTACK_ACTIVATION_MARKER_SHA256 }],
    },
    provenance: {
      package: "@andvl1/omp-workflows-fullstack",
      entrypoint: "test/mock-registration.ts",
      cwd: resolve(root),
    },
  };
}

export function beginFullstackTestRegistration(root: string, owner: WorkflowOwnerIdentity = fullstackTestOwner(root)): {
  token: RegistryRegistrationToken;
  release: () => void;
} {
  const projectRoot = resolve(root);
  writeFullstackActivationMarker(projectRoot);
  const activation = openWorkflowActivation(projectRoot, ["workflow_registration"], owner);
  if (!activation.ok) throw new Error(`${activation.code}: ${activation.error}`);
  const transaction = beginRegistryRegistration(activation.registry_context, projectRoot, ["escalation_adapters"]);
  if (!transaction.ok) {
    closeWorkflowActivation(activation);
    throw new Error(`${transaction.code}: ${transaction.error}`);
  }
  return {
    token: transaction.token,
    release: () => {
      try { rollbackRegistryRegistration(transaction.token); } catch { /* already committed/rolled back */ }
      closeWorkflowActivation(activation);
    },
  };
}

/**
 * Test callers must register transports against their own marker-authenticated
 * project root. No process-global registration is installed here: root-scoped
 * registry claims make a bootstrap rooted at a deleted temp directory both
 * useless and a source of retained stale contexts.
 */
