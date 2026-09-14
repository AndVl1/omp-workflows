import { strict as assert } from "node:assert";
import { mkdtempSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { CtoRuntimeAccessError } from "../src/cto/runtime-access.js";
import { openTestCtoRuntime } from "./fixtures/registry-activation.js";

const MARKER = '{"schema_version":1,"bundle_id":"@andvl1/omp-workflows-fullstack","entrypoint":"dist/index.js"}\n';

function makeProject(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  mkdirSync(join(root, ".omp"));
  writeFileSync(join(root, ".omp", "fullstack.activation.json"), MARKER);
  return root;
}

function openAccess(root: string) {
  const runtime = openTestCtoRuntime(root, "main-session", "cto-runtime-root-assertion-test");
  return { runtime, access: runtime.access };
}

function assertCode(action: () => unknown, code: CtoRuntimeAccessError["code"]): void {
  assert.throws(action, (error: unknown) => error instanceof CtoRuntimeAccessError && error.code === code);
}

test("assertProjectRoot accepts the authenticated physical root and rejects other or malformed paths", () => {
  const rootA = makeProject("omp-cto-root-a-");
  const rootB = makeProject("omp-cto-root-b-");
  const { runtime, access } = openAccess(rootA);
  try {
    assert.doesNotThrow(() => access.assertProjectRoot(rootA));
    assert.doesNotThrow(() => access.assertProjectRoot(join(rootA, ".")));
    assertCode(() => access.assertProjectRoot(rootB), "runtime_access_invalid");
    assert.doesNotThrow(() => access.assertLive());
    for (const malformed of ["", "   ", "\0", "\n"]) {
      assertCode(() => access.assertProjectRoot(malformed), "runtime_access_invalid");
    }
  } finally {
    runtime.close();
    rmSync(rootA, { recursive: true, force: true });
    rmSync(rootB, { recursive: true, force: true });
  }
});

test("assertProjectRoot reports activation revocation when the authenticated root path is replaced", () => {
  const root = makeProject("omp-cto-root-replaced-");
  const oldRoot = `${root}.old`;
  const { runtime, access } = openAccess(root);
  try {
    renameSync(root, oldRoot);
    mkdirSync(root);
    assertCode(() => access.assertProjectRoot(root), "activation_revoked");
    assertCode(() => access.assertProjectRoot(root), "activation_revoked");
  } finally {
    runtime.close();
    rmSync(root, { recursive: true, force: true });
    rmSync(oldRoot, { recursive: true, force: true });
  }
});
