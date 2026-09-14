import { strict as assert } from "node:assert";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  openWorkflowActivation,
  releaseWorkflowOwners,
  type WorkflowOwnerIdentity,
} from "../src/registry/owner.js";
import { CtoRuntimeAccessError, openCtoRuntimeAccess } from "../src/cto/runtime-access.js";
import { PinnedProjectRoot } from "../src/specification/pinned-root.js";

const MARKER = '{"schema_version":1,"bundle_id":"@andvl1/omp-workflows-fullstack","entrypoint":"dist/index.js"}\n';
const MARKER_SHA256 = createHash("sha256").update(MARKER, "utf8").digest("hex");

function makeProject(): string {
  const root = mkdtempSync(join(tmpdir(), "omp-cto-channel-kinds-"));
  mkdirSync(join(root, ".omp"));
  writeFileSync(join(root, ".omp", "fullstack.activation.json"), MARKER);
  return root;
}

function ownerFor(root: string): WorkflowOwnerIdentity {
  return {
    owner_id: "fullstack-channel-kinds-test",
    bundle_id: "@andvl1/omp-workflows-fullstack",
    owner_kind: "fullstack",
    activation_marker: "fullstack-channel-kinds-test-v1",
    host_range: ">=17.0.0",
    activation: {
      marker_id: "fullstack-channel-kinds-test-v1",
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
  if (activation.ok !== true) throw new Error(activation.error);
  const opened = openCtoRuntimeAccess(activation.registry_context, { sessionId: "main-session", main: true }, root);
  if (opened.ok !== true) throw new Error(opened.error);
  return { activation, access: opened.access };
}

function assertInvalid(action: () => unknown, expectedCode: string): void {
  assert.throws(action, (error: unknown) => {
    if (!(error instanceof CtoRuntimeAccessError)) return false;
    assert.equal(error.code, "runtime_access_invalid");
    assert.match(error.message, new RegExp(`^escalation config invalid \\(${expectedCode}\\): `));
    assert.doesNotMatch(error.message, /secret|token|header|chat/iu);
    return true;
  });
}

test("channel snapshot returns unique declared kinds and detached per-kind projections from one config read", () => {
  const root = makeProject();
  try {
    writeFileSync(join(root, ".omp", "escalation.json"), JSON.stringify({
      channels: [
        { id: "telegram-rw", adapter: "telegram", direction: "read-write", telegram: { token: "telegram-secret", chatId: "42" }, http: { token: "foreign-secret" } },
        { id: "unknown-ro", adapter: "unregistered-ro", direction: "read-only", "unregistered-ro": { token: "unknown-secret", headers: { authorization: "secret" } } },
        { id: "telegram-ro", adapter: "telegram", direction: "read-only", telegram: { token: "second-secret" } },
        { id: "http-ro", adapter: "http", direction: "read-only", http: { token: "http-secret" } },
      ],
    }));
    const { activation, access } = openAccess(root);
    try {
      const snapshot = access.resolveEscalationChannelSnapshot();
      assert.equal(snapshot.status, "valid");
      if (snapshot.status !== "valid") return;
      assert.equal(Object.isFrozen(snapshot), true);
      assert.equal(Object.isFrozen(snapshot.kinds), true);
      assert.equal(Object.isFrozen(snapshot.projections), true);
      assert.deepEqual(snapshot.kinds, ["telegram", "unregistered-ro", "http"]);
      assert.deepEqual(Object.keys(snapshot.projections), ["telegram", "unregistered-ro", "http"]);
      assert.equal(snapshot.projections.telegram?.length, 2);
      assert.equal(snapshot.projections["unregistered-ro"]?.length, 1);
      assert.equal(snapshot.projections.http?.length, 1);
      assert.equal(Object.isFrozen(snapshot.projections.telegram), true);
      assert.equal(Object.isFrozen(snapshot.projections.telegram?.[0]), true);
      assert.equal(snapshot.projections.telegram?.[0]?.telegram !== undefined, true);
      assert.equal("http" in (snapshot.projections.telegram?.[0] ?? {}), false);
      assert.equal("telegram" in (snapshot.projections.http?.[0] ?? {}), false);
      assert.equal(snapshot.projections["unregistered-ro"]?.[0]?.["unregistered-ro"] !== undefined, true);
      assert.equal("token" in snapshot.projections, false);
      assert.deepEqual(access.listEscalationChannelKinds(), ["telegram", "unregistered-ro", "http"]);
    } finally {
      access.close();
      releaseWorkflowOwners(activation.release_token, ["workflow_registration", "workflow_tools"]);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("channel snapshot never mixes generations across replacement reads", () => {
  const root = makeProject();
  try {
    const { activation, access } = openAccess(root);
    try {
      writeFileSync(join(root, ".omp", "escalation.json"), JSON.stringify({
        channels: [
          { id: "first-telegram", adapter: "telegram", direction: "read-write", telegram: { token: "generation-one" } },
          { id: "first-http", adapter: "http", direction: "read-only", http: { url: "https://one.invalid" } },
        ],
      }));
      const first = access.resolveEscalationChannelSnapshot();
      writeFileSync(join(root, ".omp", "escalation.json"), JSON.stringify({
        channels: [
          { id: "second-mock", adapter: "mock", direction: "read-write", mock: { token: "generation-two" } },
        ],
      }));
      const second = access.resolveEscalationChannelSnapshot();
      assert.equal(first.status, "valid");
      assert.equal(second.status, "valid");
      if (first.status !== "valid" || second.status !== "valid") return;
      assert.deepEqual(first.kinds, ["telegram", "http"]);
      assert.deepEqual(second.kinds, ["mock"]);
      assert.equal(first.projections.telegram?.[0]?.telegram !== undefined, true);
      assert.equal(first.projections.mock, undefined);
      assert.equal(second.projections.mock?.[0]?.mock !== undefined, true);
      assert.equal(second.projections.telegram, undefined);
    } finally {
      access.close();
      releaseWorkflowOwners(activation.release_token, ["workflow_registration", "workflow_tools"]);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("channel snapshot A-B-A seam returns one receipt generation or typed changed", () => {
  const root = makeProject();
  const path = join(root, ".omp", "escalation.json");
  const bytesA = Buffer.from(JSON.stringify({
    channels: [{ id: "generation-a", adapter: "telegram", direction: "read-write", telegram: { token: "token-a", chatId: "chat-a" } }],
  }), "utf8");
  const bytesB = Buffer.from(JSON.stringify({
    channels: [{ id: "generation-b", adapter: "http", direction: "read-only", http: { url: "https://generation-b.invalid" } }],
  }), "utf8");
  writeFileSync(path, bytesA);
  const digestA = createHash("sha256").update(bytesA).digest("hex");
  const originalReadFile = PinnedProjectRoot.prototype.readFile;
  let seamTriggered = false;
  PinnedProjectRoot.prototype.readFile = function (relativeFile, options) {
    const read = originalReadFile.call(this, relativeFile, options);
    if (!seamTriggered && relativeFile === ".omp/escalation.json") {
      seamTriggered = true;
      writeFileSync(path, bytesB);
      writeFileSync(path, bytesA);
    }
    return read;
  };
  try {
    const { activation, access } = openAccess(root);
    try {
      let snapshot: ReturnType<typeof access.resolveEscalationChannelSnapshot> | null = null;
      let changed = false;
      try {
        snapshot = access.resolveEscalationChannelSnapshot();
      } catch (error) {
        changed = error instanceof CtoRuntimeAccessError && error.code === "runtime_access_invalid";
      }
      assert.equal(seamTriggered, true, "the deterministic replacement seam ran during the anchored read");
      assert.equal(changed || snapshot?.status === "valid", true, "snapshot is either self-consistent or typed changed");
      if (snapshot?.status === "valid") {
        assert.equal(snapshot.config_sha256, digestA, "digest is derived from the same bytes that were parsed");
        assert.deepEqual(snapshot.kinds, ["telegram"], "routes remain generation A when the receipt is accepted");
        assert.equal(snapshot.projections.telegram?.[0]?.id, "generation-a");
      }
    } finally {
      access.close();
      releaseWorkflowOwners(activation.release_token, ["workflow_registration", "workflow_tools"]);
    }
  } finally {
    PinnedProjectRoot.prototype.readFile = originalReadFile;
    rmSync(root, { recursive: true, force: true });
  }
});

test("invalid channel configs are typed and expose only bounded safe reasons", () => {
  const cases: Array<{ code: string; content: string }> = [
    { code: "malformed", content: '{"token":"secret-token"' },
    { code: "invalid_shape", content: JSON.stringify({ adapter: 42, token: "secret-token" }) },
    { code: "duplicate_id", content: JSON.stringify({ channels: [
      { id: "same", adapter: "telegram", direction: "read-only" },
      { id: "same", adapter: "telegram", direction: "read-only" },
    ] }) },
    { code: "duplicate_primary", content: JSON.stringify({ channels: [
      { id: "one", adapter: "telegram", direction: "read-write", primary: true },
      { id: "two", adapter: "telegram", direction: "read-write", primary: true },
    ] }) },
    { code: "invalid_primary_direction", content: JSON.stringify({ channels: [
      { id: "ro", adapter: "telegram", direction: "read-only", primary: true, telegram: { token: "secret-token" } },
    ] }) },
  ];
  const root = makeProject();
  try {
    const { activation, access } = openAccess(root);
    try {
      for (const current of cases) {
        writeFileSync(join(root, ".omp", "escalation.json"), current.content);
        assertInvalid(() => access.listEscalationChannelKinds(), current.code);
        const snapshot = access.resolveEscalationChannelSnapshot();
        assert.equal(snapshot.status, "invalid");
        if (snapshot.status === "invalid") {
          assert.equal(snapshot.code, current.code);
          assert.doesNotMatch(snapshot.reason, /secret|token|header|chat/iu);
          assert.ok(snapshot.reason.length <= 256);
          assert.equal(Object.isFrozen(snapshot), true);
        }
      }
    } finally {
      access.close();
      releaseWorkflowOwners(activation.release_token, ["workflow_registration", "workflow_tools"]);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("listEscalationChannelKinds returns a frozen empty list for absent configuration", () => {
  const root = makeProject();
  try {
    const { activation, access } = openAccess(root);
    try {
      const kinds = access.listEscalationChannelKinds();
      assert.deepEqual(kinds, []);
      assert.equal(Object.isFrozen(kinds), true);
      const snapshot = access.resolveEscalationChannelSnapshot();
      assert.deepEqual(snapshot, { status: "absent" });
      assert.equal(Object.isFrozen(snapshot), true);
    } finally {
      access.close();
      releaseWorkflowOwners(activation.release_token, ["workflow_registration", "workflow_tools"]);
    }
    unlinkSync(join(root, ".omp", "fullstack.activation.json"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
