import { strict as assert } from "node:assert";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  openWorkflowActivation,
  releaseWorkflowOwners,
  type WorkflowOwnerIdentity,
} from "../src/registry/owner.js";
import { CtoRuntimeAccessError, openCtoRuntimeAccess } from "../src/cto/runtime-access.js";
import { newCtoState, writeCtoState } from "../src/cto/state.js";

const MARKER = '{"schema_version":1,"bundle_id":"@andvl1/omp-workflows-fullstack","entrypoint":"dist/index.js"}\n';
const MARKER_SHA256 = createHash("sha256").update(MARKER, "utf8").digest("hex");

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

function ownerFor(root: string): WorkflowOwnerIdentity {
  return {
    owner_id: "fullstack-transaction-test",
    bundle_id: "@andvl1/omp-workflows-fullstack",
    owner_kind: "fullstack",
    activation_marker: "fullstack-transaction-test-v1",
    host_range: ">=17.0.0",
    activation: {
      marker_id: "fullstack-transaction-test-v1",
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

function statePath(root: string): string {
  return join(root, ".work-state", "cto", "run-one", "state.json");
}

test("run transactions reject async callbacks before lock release and deactivate continuations", async () => {
  const root = makeProject();
  try {
    const { activation, access } = openAccess(root);
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
    access.close();
    releaseWorkflowOwners(activation.release_token, ["workflow_registration", "workflow_tools"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
