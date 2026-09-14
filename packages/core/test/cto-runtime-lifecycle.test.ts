import { strict as assert } from "node:assert";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, realpathSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
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

function makeProject(): string {
  const root = mkdtempSync(join(tmpdir(), "omp-cto-lifecycle-"));
  mkdirSync(join(root, ".omp"));
  writeFileSync(join(root, ".omp", "fullstack.activation.json"), MARKER);
  return root;
}

function ownerFor(root: string): WorkflowOwnerIdentity {
  return {
    owner_id: "fullstack-lifecycle-test",
    bundle_id: "@andvl1/omp-workflows-fullstack",
    owner_kind: "fullstack",
    activation_marker: "fullstack-lifecycle-test-v1",
    host_range: ">=17.0.0",
    activation: {
      marker_id: "fullstack-lifecycle-test-v1",
      required: [{ path: ".omp/fullstack.activation.json", kind: "file", sha256: MARKER_SHA256 }],
    },
    provenance: {
      package: "@andvl1/omp-workflows-fullstack",
      entrypoint: "dist/index.js",
      cwd: root,
    },
  };
}

test("close revokes only the facade and permits a fresh main-session facade", () => {
  const root = makeProject();
  try {
    const activation = openWorkflowActivation(root, ["workflow_registration", "workflow_tools"], ownerFor(root));
    assert.equal(activation.ok, true);
    if (!activation.ok) throw new Error(activation.error);
    const opened = openCtoRuntimeAccess(activation.registry_context, { sessionId: "first-main", main: true }, root);
    assert.equal(opened.ok, true);
    if (!opened.ok) throw new Error(opened.error);

    opened.access.close();
    opened.access.close();
    assert.throws(
      () => opened.access.assertLive(),
      (error: unknown) => error instanceof CtoRuntimeAccessError && error.code === "activation_revoked",
    );
    assert.throws(
      () => opened.access.readState("run-one"),
      (error: unknown) => error instanceof CtoRuntimeAccessError && error.code === "activation_revoked",
    );
    assert.throws(
      () => opened.access.ensureStandbyRun(),
      (error: unknown) => error instanceof CtoRuntimeAccessError && error.code === "activation_revoked",
    );

    const fresh = openCtoRuntimeAccess(activation.registry_context, { sessionId: "second-main", main: true }, root);
    assert.equal(fresh.ok, true);
    if (!fresh.ok) throw new Error(fresh.error);
    assert.doesNotThrow(() => fresh.access.assertLive());
    assert.equal(fresh.access.stateDirectory("run-one"), join(realpathSync(root), ".work-state", "cto", "run-one"));
    fresh.access.close();
    releaseWorkflowOwners(activation.release_token, ["workflow_registration", "workflow_tools"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("close remains local and does not mask marker revocation", () => {
  const root = makeProject();
  try {
    const activation = openWorkflowActivation(root, ["workflow_registration", "workflow_tools"], ownerFor(root));
    assert.equal(activation.ok, true);
    if (!activation.ok) throw new Error(activation.error);
    const opened = openCtoRuntimeAccess(activation.registry_context, { sessionId: "main", main: true }, root);
    assert.equal(opened.ok, true);
    if (!opened.ok) throw new Error(opened.error);
    opened.access.close();
    opened.access.close();
    unlinkSync(join(root, ".omp", "fullstack.activation.json"));
    const fresh = openCtoRuntimeAccess(activation.registry_context, { sessionId: "new-main", main: true }, root);
    assert.equal(fresh.ok, false);
    assert.equal(fresh.code, "activation_revoked");
    releaseWorkflowOwners(activation.release_token, ["workflow_registration", "workflow_tools"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
