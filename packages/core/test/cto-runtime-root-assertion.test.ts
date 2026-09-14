import { strict as assert } from "node:assert";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  openWorkflowActivation,
  releaseWorkflowOwners,
  type WorkflowOwnerIdentity,
} from "../src/registry/owner.js";
import { CtoRuntimeAccessError, openCtoRuntimeAccess } from "../src/cto/runtime-access.js";

const MARKER = '{"schema_version":1,"bundle_id":"@andvl1/omp-workflows-fullstack","entrypoint":"dist/index.js"}\n';
const MARKER_SHA256 = createHash("sha256").update(MARKER, "utf8").digest("hex");

function makeProject(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  mkdirSync(join(root, ".omp"));
  writeFileSync(join(root, ".omp", "fullstack.activation.json"), MARKER);
  return root;
}

function ownerFor(root: string): WorkflowOwnerIdentity {
  return {
    owner_id: "fullstack-root-assertion-test",
    bundle_id: "@andvl1/omp-workflows-fullstack",
    owner_kind: "fullstack",
    activation_marker: "fullstack-root-assertion-test-v1",
    host_range: ">=17.0.0",
    activation: {
      marker_id: "fullstack-root-assertion-test-v1",
      required: [{ path: ".omp/fullstack.activation.json", kind: "file", sha256: MARKER_SHA256 }],
    },
    provenance: {
      package: "@andvl1/omp-workflows-fullstack",
      entrypoint: "dist/index.js",
      cwd: root,
    },
  };
}

function openAccess(root: string) {
  const activation = openWorkflowActivation(root, ["workflow_registration", "workflow_tools"], ownerFor(root));
  assert.equal(activation.ok, true);
  if (!activation.ok) throw new Error(activation.error);
  const opened = openCtoRuntimeAccess(activation.registry_context, { sessionId: "main-session", main: true }, root);
  assert.equal(opened.ok, true);
  if (!opened.ok) throw new Error(opened.error);
  return { activation, access: opened.access };
}

function assertCode(action: () => unknown, code: CtoRuntimeAccessError["code"]): void {
  assert.throws(action, (error: unknown) => error instanceof CtoRuntimeAccessError && error.code === code);
}

test("assertProjectRoot accepts the authenticated physical root and rejects other or malformed paths", () => {
  const rootA = makeProject("omp-cto-root-a-");
  const rootB = makeProject("omp-cto-root-b-");
  const { activation, access } = openAccess(rootA);
  try {
    assert.doesNotThrow(() => access.assertProjectRoot(rootA));
    assert.doesNotThrow(() => access.assertProjectRoot(join(rootA, ".")));
    assertCode(() => access.assertProjectRoot(rootB), "runtime_access_invalid");
    assert.doesNotThrow(() => access.assertLive());
    for (const malformed of ["", "   ", "\0", "\n"]) {
      assertCode(() => access.assertProjectRoot(malformed), "runtime_access_invalid");
    }
  } finally {
    access.close();
    releaseWorkflowOwners(activation.release_token, ["workflow_registration", "workflow_tools"]);
    rmSync(rootA, { recursive: true, force: true });
    rmSync(rootB, { recursive: true, force: true });
  }
});

test("assertProjectRoot reports activation revocation when the authenticated root path is replaced", () => {
  const root = makeProject("omp-cto-root-replaced-");
  const oldRoot = `${root}.old`;
  const { activation, access } = openAccess(root);
  try {
    renameSync(root, oldRoot);
    mkdirSync(root);
    assertCode(() => access.assertProjectRoot(root), "activation_revoked");
    assertCode(() => access.assertProjectRoot(root), "activation_revoked");
  } finally {
    access.close();
    releaseWorkflowOwners(activation.release_token, ["workflow_registration", "workflow_tools"]);
    rmSync(root, { recursive: true, force: true });
    rmSync(oldRoot, { recursive: true, force: true });
  }
});
