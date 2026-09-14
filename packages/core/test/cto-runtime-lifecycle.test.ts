import { strict as assert } from "node:assert";
import { mkdtempSync, mkdirSync, realpathSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { CtoRuntimeAccessError, ctoRuntimeSessionAuthorityForContext, openCtoRuntimeAccess } from "../src/cto/runtime-access.js";
import { openTestCtoRuntime } from "./fixtures/registry-activation.js";

const MARKER = '{"schema_version":1,"bundle_id":"@andvl1/omp-workflows-fullstack","entrypoint":"dist/index.js"}\n';

function makeProject(): string {
  const root = mkdtempSync(join(tmpdir(), "omp-cto-lifecycle-"));
  mkdirSync(join(root, ".omp"));
  writeFileSync(join(root, ".omp", "fullstack.activation.json"), MARKER);
  return root;
}

test("close revokes only the facade and permits a fresh main-session facade", () => {
  const root = makeProject();
  try {
    const runtime = openTestCtoRuntime(root, "first-main", "cto-runtime-lifecycle-test");
    const access = runtime.access;
    access.close();
    access.close();
    assert.throws(
      () => access.assertLive(),
      (error: unknown) => error instanceof CtoRuntimeAccessError && error.code === "activation_revoked",
    );
    assert.throws(
      () => access.readState("run-one"),
      (error: unknown) => error instanceof CtoRuntimeAccessError && error.code === "activation_revoked",
    );
    assert.throws(
      () => access.ensureStandbyRun(),
      (error: unknown) => error instanceof CtoRuntimeAccessError && error.code === "activation_revoked",
    );

    const fresh = runtime.refreshAccess();
    assert.doesNotThrow(() => fresh.assertLive());
    assert.equal(fresh.stateDirectory("run-one"), join(realpathSync(root), ".work-state", "cto", "run-one"));
    runtime.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("close remains local and does not mask marker revocation", () => {
  const root = makeProject();
  try {
    const runtime = openTestCtoRuntime(root, "main", "cto-runtime-lifecycle-revocation-test");
    runtime.access.close();
    runtime.access.close();
    unlinkSync(join(root, ".omp-test-registry-marker"));
    const authority = ctoRuntimeSessionAuthorityForContext(runtime.registryContext);
    assert.ok(authority);
    const fresh = authority === null
      ? { ok: false as const, code: "runtime_access_invalid" as const }
      : openCtoRuntimeAccess(runtime.registryContext, authority, root);
    assert.equal(fresh.ok, false);
    assert.equal(fresh.code, "activation_revoked");
    runtime.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
