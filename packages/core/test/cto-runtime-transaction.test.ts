import { strict as assert } from "node:assert";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { CtoRuntimeAccessError } from "../src/cto/runtime-access.js";
import { openTestCtoRuntime } from "./fixtures/registry-activation.js";
import { newCtoState, writeCtoState } from "../src/cto/state.js";

const MARKER = '{"schema_version":1,"bundle_id":"@andvl1/omp-workflows-fullstack","entrypoint":"dist/index.js"}\n';

function makeProject(): string {
  const root = mkdtempSync(join(tmpdir(), "omp-cto-transaction-"));
  mkdirSync(join(root, ".omp"));
  writeFileSync(join(root, ".omp", "fullstack.activation.json"), MARKER);
  const task = "transaction test";
  const state = newCtoState({
    id: "run-one",
    task,
    branch: "main",
    autonomous: false,
    plan: { id: "run-one", task, teams: [], created_at: new Date().toISOString() },
  });
  writeCtoState(state, root, { preCommit: ({ pinnedRoot }) => { if (!pinnedRoot.isStable()) throw new Error("runtime fixture root changed before state CAS"); } });
  return root;
}

function openAccess(root: string) {
  const runtime = openTestCtoRuntime(root, "main-session", "cto-runtime-transaction-test");
  return { runtime, access: runtime.access };
}

function statePath(root: string): string {
  return join(root, ".work-state", "cto", "run-one", "state.json");
}

test("run transactions reject async callbacks before lock release and deactivate continuations", async () => {
  const root = makeProject();
  try {
    const { runtime, access } = openAccess(root);
    const before = readFileSync(statePath(root), "utf8");
    let continuation: Promise<void> | undefined;
    let lateError: unknown;
    let outerError: unknown;
    try {
      access.withRunTransaction("run-one", (transaction) => {
        continuation = (async () => {
          await Promise.resolve();
          try {
            transaction.writeState(transaction.readState());
          } catch (error) {
            lateError = error;
          }
        })();
        return continuation;
      });
    } catch (error) {
      outerError = error;
    }
    assert.ok(outerError instanceof CtoRuntimeAccessError);
    assert.equal((outerError as CtoRuntimeAccessError).code, "cto_runtime_transaction_async_unsupported");
    assert.ok(continuation);
    await continuation;
    assert.ok(lateError instanceof CtoRuntimeAccessError);
    assert.equal((lateError as CtoRuntimeAccessError).code, "activation_revoked");
    assert.equal(readFileSync(statePath(root), "utf8"), before);

    const forgedThenable = Object.create(null, {
      then: {
        get() {
          throw new Error("forged thenable getter");
        },
      },
    });
    assert.throws(
      () => access.withRunTransaction("run-one", () => forgedThenable),
      (error: unknown) => error instanceof CtoRuntimeAccessError && error.code === "runtime_access_invalid",
    );
    assert.equal(readFileSync(statePath(root), "utf8"), before);
    runtime.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
