import { strict as assert } from "node:assert";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  openWorkflowActivation,
  requireRegistryContext,
  releaseWorkflowOwners,
  type WorkflowOwnerIdentity,
} from "../src/registry/owner.js";
import {
  CtoRuntimeAccessError,
  assertCtoRuntimeAccessFacadeLive,
  createCtoRuntimeAccessGuardedView,
  isCtoRuntimeAccessFacade,
  type CtoRuntimeAccessFacade,
  MAX_RUNTIME_ACCESS_INTERVAL_MS,
  MAX_RUNTIME_ACCESS_PROVIDERS,
  MAX_RUNTIME_ACCESS_SCHEDULERS,
  MIN_RUNTIME_ACCESS_INTERVAL_MS,
  openCtoRuntimeAccess,
  registerCtoRuntimeAccessProvider,
} from "../src/cto/runtime-access.js";
import { issueCtoRuntimeSessionAuthority, revokeCtoRuntimeSessionAuthority } from "../src/cto/session-authority.js";
import { openCtoRuntimeProofAuthority, revokeCtoRuntimeProofAuthority, signCtoRuntimeProof, verifyCtoRuntimeProof } from "../src/cto/proof-authority.js";
import { ctoRuntimeRunInitialIdentityDigest, mintCtoRuntimeRunOrigin, newCtoState, readCtoState, writeCtoRuntimeStateProof, writeCtoState } from "../src/cto/state.js";
import { PinnedProjectRoot } from "../src/specification/pinned-root.js";
import type { TeamPlan } from "../src/cto/types.js";

const MARKER = '{"schema_version":1,"bundle_id":"@andvl1/omp-workflows-fullstack","entrypoint":"dist/index.js"}\n';
const MARKER_SHA256 = createHash("sha256").update(MARKER, "utf8").digest("hex");

function makeProject(): string {
  const root = mkdtempSync(join(tmpdir(), "omp-cto-runtime-"));
  mkdirSync(join(root, ".omp"));
  writeFileSync(join(root, ".omp", "fullstack.activation.json"), MARKER);
  return root;
}

function ownerFor(root: string): WorkflowOwnerIdentity {
  return {
    owner_id: "fullstack-runtime-test",
    bundle_id: "@andvl1/omp-workflows-fullstack",
    owner_kind: "fullstack",
    activation_marker: "fullstack-runtime-test-v1",
    host_range: ">=17.0.0",
    activation: {
      marker_id: "fullstack-runtime-test-v1",
      required: [{ path: ".omp/fullstack.activation.json", kind: "file", sha256: MARKER_SHA256 }],
    },
    provenance: {
      package: "@andvl1/omp-workflows-fullstack",
      entrypoint: "dist/index.js",
      cwd: root,
    },
  };
}

function activationFor(root: string) {
  const activation = openWorkflowActivation(root, ["workflow_registration", "workflow_tools"], ownerFor(root));
  assert.equal(activation.ok, true);
  if (!activation.ok) throw new Error(activation.error);
  return activation;
}

function stateFor(root: string, runId = "run-one"): void {
  const plan: TeamPlan = {
    id: runId,
    task: "runtime access test",
    teams: [{ team: "team-one", scope: ["src"], slice: "slice-one", profile: "developer", worktree: "same_branch", depends_on: [] }],
    created_at: new Date().toISOString(),
  };
  const state = newCtoState({ id: runId, task: plan.task, branch: "main", autonomous: false, owner_session: "main-session", plan });
  state.decisions = [{ id: "decision-one", at: new Date().toISOString(), decision: "use bounded facade", why: "avoid raw state", tags: ["runtime"], by: "user" }];
  state.inbox_quarantine = {
    inbox: { id: "inbox", hash: "hash", received_at: new Date().toISOString(), by: "user", status: "quarantined", wake_claim: { pid: process.pid, start_identity: "test", token: "secret-token", started_at: new Date().toISOString() } },
  };
  const pinnedRoot = PinnedProjectRoot.open(root);
  assert.ok(pinnedRoot);
  try {
    assert.equal(mintCtoRuntimeRunOrigin(pinnedRoot, state, "main-session", "runtime-access", ctoRuntimeRunInitialIdentityDigest(state)), true);
    writeCtoState(state, root, { pinnedRoot, preCommit: ({ pinnedRoot: candidateRoot }) => candidateRoot.assertStable() });
    const persisted = readCtoState(runId, root);
    assert.ok(persisted);
    assert.equal(writeCtoRuntimeStateProof(pinnedRoot, persisted!), true);
  } finally {
    pinnedRoot.close();
  }
}

function openAccess(root: string, sessionId = "main-session") {
  const activation = activationFor(root);
  const pinnedRoot = PinnedProjectRoot.open(root);
  assert.ok(pinnedRoot);
  if (!pinnedRoot) throw new Error("test root could not be pinned");
  try {
    const sessionManager = Object.freeze({});
    const authority = issueCtoRuntimeSessionAuthority(
      activation.registry_context,
      { canonical_root: pinnedRoot.canonical_root, dev: pinnedRoot.dev, ino: pinnedRoot.ino },
      { sessionManager, sessionId },
      () => { requireRegistryContext(activation.registry_context, pinnedRoot!.canonical_root, "workflow_tools"); },
    );
    const opened = openCtoRuntimeAccess(activation.registry_context, authority, root);
    assert.equal(opened.ok, true);
    if (!opened.ok) throw new Error(opened.error);
    return { activation, access: opened.access, authority };
  } finally {
    pinnedRoot.close();
  }
}

function assertRevoked(action: () => unknown): void {
  assert.throws(action, (error: unknown) => error instanceof CtoRuntimeAccessError && error.code === "activation_revoked");
}

test("opaque proof authority binds allowed domains to the live registry claim", () => {
  const root = makeProject();
  try {
    const activation = activationFor(root);
    const pinned = PinnedProjectRoot.open(root);
    assert.ok(pinned);
    if (!pinned) throw new Error("test root could not be pinned");
    try {
      const authority = openCtoRuntimeProofAuthority(activation.registry_context, pinned);
      assert.ok(authority);
      if (!authority) return;
      const payload = JSON.stringify({ schema: 1, identity: "test" });
      const proof = signCtoRuntimeProof(authority, "telegram-mapping-v1", payload);
      assert.match(proof ?? "", /^[0-9a-f]{64}$/u);
      assert.equal(verifyCtoRuntimeProof(authority, "telegram-mapping-v1", payload, proof!), true);
      assert.equal(verifyCtoRuntimeProof(authority, "telegram-mapping-v1", payload + "x", proof!), false);
      assert.equal(signCtoRuntimeProof(authority, "not-allowed" as never, payload), null);
      revokeCtoRuntimeProofAuthority(authority);
      assert.equal(verifyCtoRuntimeProof(authority, "telegram-mapping-v1", payload, proof!), false);
    } finally {
      pinned.close();
      releaseWorkflowOwners(activation.release_token, ["workflow_registration", "workflow_tools"]);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("runtime scheduler rejects unsafe intervals, caps live timers, and reuses stopped slots", () => {
  const root = makeProject();
  try {
    stateFor(root);
    const opened = openAccess(root);
    const stops: Array<() => void> = [];
    assert.throws(
      () => opened.access.startScheduler("run-one", MIN_RUNTIME_ACCESS_INTERVAL_MS - 1, () => undefined),
      (error: unknown) => error instanceof CtoRuntimeAccessError
        && error.code === "runtime_access_invalid"
        && /interval|integer|between/i.test(error.message),
    );
    assert.throws(
      () => opened.access.startScheduler("run-one", MIN_RUNTIME_ACCESS_INTERVAL_MS + 0.5, () => undefined),
      (error: unknown) => error instanceof CtoRuntimeAccessError
        && error.code === "runtime_access_invalid",
    );
    assert.throws(
      () => opened.access.startScheduler("run-one", MAX_RUNTIME_ACCESS_INTERVAL_MS + 1, () => undefined),
      (error: unknown) => error instanceof CtoRuntimeAccessError
        && error.code === "runtime_access_invalid",
    );
    try {
      for (let index = 0; index < MAX_RUNTIME_ACCESS_SCHEDULERS; index += 1) {
        stops.push(opened.access.startScheduler("run-one", MAX_RUNTIME_ACCESS_INTERVAL_MS, () => undefined));
      }
      assert.throws(
        () => opened.access.startScheduler("run-one", MAX_RUNTIME_ACCESS_INTERVAL_MS, () => undefined),
        (error: unknown) => error instanceof CtoRuntimeAccessError
          && error.code === "runtime_access_invalid"
          && /capacity|exhausted/i.test(error.message),
      );
      stops[0]!();
      const reused = opened.access.startScheduler("run-one", MAX_RUNTIME_ACCESS_INTERVAL_MS, () => undefined);
      stops.push(reused);
    } finally {
      for (const stop of stops) stop();
    }
    opened.access.close();
    releaseWorkflowOwners(opened.activation.release_token, ["workflow_registration", "workflow_tools"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("shared session authority isolates facade close and revokes attached peers", () => {
  const root = makeProject();
  try {
    const activation = activationFor(root);
    const pinnedRoot = PinnedProjectRoot.open(root);
    assert.ok(pinnedRoot);
    if (!pinnedRoot) throw new Error("test root could not be pinned");
    try {
      const authority = issueCtoRuntimeSessionAuthority(
        activation.registry_context,
        { canonical_root: pinnedRoot.canonical_root, dev: pinnedRoot.dev, ino: pinnedRoot.ino },
        { sessionManager: Object.freeze({}), sessionId: "shared-session" },
        () => { requireRegistryContext(activation.registry_context, pinnedRoot!.canonical_root, "workflow_tools"); },
      );
      const first = openCtoRuntimeAccess(activation.registry_context, authority, root);
      const second = openCtoRuntimeAccess(activation.registry_context, authority, root);
      assert.equal(first.ok, true);
      assert.equal(second.ok, true);
      if (!first.ok || !second.ok) throw new Error("shared authority facade open failed");
      first.access.close();
      assert.doesNotThrow(() => second.access.assertLive());
      revokeCtoRuntimeSessionAuthority(authority);
      assertRevoked(() => second.access.assertLive());
    } finally {
      pinnedRoot.close();
      releaseWorkflowOwners(activation.release_token, ["workflow_registration", "workflow_tools"]);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("core guarded views reject inherited overrides and close after identity loss", () => {
  const root = makeProject();
  try {
    const opened = openAccess(root);
    let identityLive = true;
    const guarded = createCtoRuntimeAccessGuardedView(opened.access, () => {
      if (!identityLive) throw new Error("dispatcher identity is stale");
    });
    assert.equal(isCtoRuntimeAccessFacade(guarded), true);
    assert.deepEqual(Object.getOwnPropertyNames(guarded).sort(), Object.getOwnPropertyNames(opened.access).sort());
    assert.doesNotThrow(() => guarded.assertLive());
    const inherited = Object.create(opened.access) as CtoRuntimeAccessFacade;
    Object.defineProperty(inherited, "assertLive", { value: () => undefined });
    assert.equal(isCtoRuntimeAccessFacade(inherited), false);
    assert.throws(() => assertCtoRuntimeAccessFacadeLive(inherited), /marker-bound runtime facade/);
    identityLive = false;
    assert.throws(() => guarded.findActiveRun(), /identity is stale/);
    assert.doesNotThrow(() => guarded.close());
    assert.doesNotThrow(() => guarded.close());
    releaseWorkflowOwners(opened.activation.release_token, ["workflow_registration", "workflow_tools"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("runtime provider registry caps unique providers and reuses a disposed slot", () => {
  const duplicateProvider = () => null;
  const disposers: Array<() => void> = [];
  try {
    // A duplicate registration is idempotent at the Set boundary and must not
    // consume a second slot. The second disposer remains safe to call.
    disposers.push(registerCtoRuntimeAccessProvider(duplicateProvider));
    disposers.push(registerCtoRuntimeAccessProvider(duplicateProvider));
    for (let index = 1; index < MAX_RUNTIME_ACCESS_PROVIDERS; index += 1) {
      disposers.push(registerCtoRuntimeAccessProvider(() => null));
    }
    assert.throws(
      () => registerCtoRuntimeAccessProvider(() => null),
      (error: unknown) => error instanceof CtoRuntimeAccessError
        && error.code === "runtime_access_invalid"
        && /capacity|exhausted/i.test(error.message),
    );
    disposers[0]!();
    const reused = registerCtoRuntimeAccessProvider(() => null);
    disposers.push(reused);
  } finally {
    for (const dispose of disposers) dispose();
  }
});

test("valid marker-bound access writes under a run transaction and redacts detached projections", () => {
  const root = makeProject();
  try {
    stateFor(root);
    writeFileSync(join(root, ".omp", "escalation.json"), JSON.stringify({
      channels: [
        { id: "telegram-main", adapter: "telegram", direction: "read-write", primary: true, telegram: { token: "telegram-secret", chatId: "42" }, http: { token: "foreign-secret" } },
        { id: "telegram-secondary", adapter: "telegram", direction: "read-only", telegram: { token: "telegram-secret-two", chatId: "43" }, http: { token: "foreign-secret-two" } },
        { id: "http-report", adapter: "http", direction: "read-only", http: { url: "https://reports.invalid", token: "http-secret" }, telegram: { token: "foreign-secret" } },
      ],
    }));
    const { activation, access } = openAccess(root);
    assert.equal(Object.isFrozen(access), true);
    assert.deepEqual(Object.keys(access), []);
    assert.equal("withRegistryTransaction" in access, false);
    assert.doesNotThrow(() => access.assertLive());

    const projection = access.readState("run-one");
    assert.ok(projection);
    assert.equal(Object.isFrozen(projection), true);
    const decisions = projection!.decisions as Array<Record<string, unknown>>;
    const quarantine = projection!.inbox_quarantine as Record<string, Record<string, unknown>>;
    const inbox = quarantine.inbox;
    const wakeClaim = inbox.wake_claim as Record<string, unknown>;
    assert.equal("by" in decisions[0]!, false);
    assert.equal("token" in wakeClaim, false);
    assert.equal("answer" in projection!, false);

    access.withRunTransaction("run-one", (transaction) => {
      const exact = transaction.readState();
      assert.equal(exact.id, "run-one");
      const appended = transaction.appendWave({ id: "wave-one", source: "mock", source_id: "source-one", task: "wave task", slice_ids: ["slice-one"] });
      assert.equal(appended.active_wave_id, "wave-one");
      assert.equal(transaction.findWaveBySourceId("source-one")?.id, "wave-one");
      appended.pause = { kind: "done", reason: "finished" };
      transaction.writeState(appended);
      assert.equal(transaction.readState().pause.kind, "done");
      assert.deepEqual(Object.keys(transaction), []);
    });
    assert.equal(readCtoState("run-one", root)?.wave_history?.[0]?.id, "wave-one");
    assert.equal((access.readState("run-one")?.pause as { kind: string }).kind, "done");

    const telegram = access.resolveEscalationChannelConfigs("telegram");
    assert.equal(telegram.length, 2);
    assert.deepEqual(telegram.map((entry) => entry.id), ["telegram-main", "telegram-secondary"]);
    const telegramSettings = telegram[0]!.telegram as { token: string };
    assert.equal(telegramSettings.token, "telegram-secret");
    assert.equal("http" in telegram[0]!, false);
    const secondarySettings = telegram[1]!.telegram as { token: string };
    assert.equal(secondarySettings.token, "telegram-secret-two");
    assert.equal("http" in telegram[1]!, false);
    assert.equal(Object.isFrozen(telegram), true);
    assert.equal(Object.isFrozen(telegram[0]), true);
    const http = access.resolveEscalationChannelConfigs("http");
    assert.equal(http.length, 1);
    const httpSettings = http[0]!.http as { token: string };
    assert.equal(httpSettings.token, "http-secret");
    assert.equal("telegram" in http[0]!, false);
    assert.deepEqual(access.resolveEscalationChannelConfigs("unregistered"), []);
    assert.deepEqual(access.resolveEscalationChannelConfigs("bad kind"), []);

    releaseWorkflowOwners(activation.release_token, ["workflow_registration", "workflow_tools"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("run transactions stage writes until a synchronous callback succeeds", () => {
  const root = makeProject();
  try {
    stateFor(root);
    const opened = openAccess(root);
    const statePath = join(root, ".work-state", "cto", "run-one", "state.json");
    const beforeBytes = readFileSync(statePath, "utf8");
    const before = readCtoState("run-one", root);
    assert.ok(before);
    let asyncError: unknown;
    try {
      opened.access.withRunTransaction("run-one", async (transaction) => {
        const next = transaction.readState();
        next.pause = { kind: "done", reason: "async callback must not commit" };
        transaction.writeState(next);
        await Promise.resolve();
      });
    } catch (error) {
      asyncError = error;
    }
    assert.ok(asyncError instanceof CtoRuntimeAccessError);
    assert.equal((asyncError as CtoRuntimeAccessError).code, "cto_runtime_transaction_async_unsupported");
    assert.equal(readFileSync(statePath, "utf8"), beforeBytes);
    assert.equal(readCtoState("run-one", root)?.state_revision, before.state_revision);

    let thenableError: unknown;
    try {
      opened.access.withRunTransaction("run-one", (transaction) => {
        const next = transaction.readState();
        next.pause = { kind: "done", reason: "thenable callback must not commit" };
        transaction.writeState(next);
        return { then: () => undefined };
      });
    } catch (error) {
      thenableError = error;
    }
    assert.ok(thenableError instanceof CtoRuntimeAccessError);
    assert.equal((thenableError as CtoRuntimeAccessError).code, "cto_runtime_transaction_async_unsupported");
    assert.equal(readFileSync(statePath, "utf8"), beforeBytes);

    assert.throws(() => opened.access.withRunTransaction("run-one", (transaction) => {
      const next = transaction.readState();
      next.pause = { kind: "done", reason: "throwing callback must not commit" };
      transaction.writeState(next);
      throw new Error("callback failed");
    }), /callback failed/);
    assert.equal(readFileSync(statePath, "utf8"), beforeBytes);

    opened.access.withRunTransaction("run-one", (transaction) => {
      const first = transaction.readState();
      first.pause = { kind: "done", reason: "first staged write" };
      transaction.writeState(first);
      assert.equal(transaction.readState().pause.reason, "first staged write");
      const second = transaction.readState();
      second.integration = { status: "done", note: "second staged write" };
      transaction.writeState(second);
      assert.equal(transaction.readState().integration.note, "second staged write");
    });
    const after = readCtoState("run-one", root);
    assert.ok(after);
    assert.equal(after.state_revision, before.state_revision + 1);
    assert.equal(after.pause.reason, "first staged write");
    assert.equal(after.integration.note, "second staged write");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("raw, forged, wrong-root, non-main, and empty sessions never open access", () => {
  const root = makeProject();
  const otherRoot = makeProject();
  try {
    const activation = activationFor(root);
    const rawClaim = openCtoRuntimeAccess(activation.claim as never, { sessionId: "main-session", main: true }, root);
    assert.equal(rawClaim.ok, false);
    assert.equal(rawClaim.code, "runtime_access_invalid");
    const spread = openCtoRuntimeAccess({ ...activation.registry_context }, { sessionId: "main-session", main: true }, root);
    assert.equal(spread.ok, false);
    assert.equal(spread.code, "runtime_access_invalid");
    const parsed = openCtoRuntimeAccess(JSON.parse(JSON.stringify(activation.registry_context)), { sessionId: "main-session", main: true }, root);
    assert.equal(parsed.ok, false);
    assert.equal(parsed.code, "runtime_access_invalid");
    const wrongRoot = openCtoRuntimeAccess(activation.registry_context, { sessionId: "main-session", main: true }, otherRoot);
    assert.equal(wrongRoot.ok, false);
    assert.equal(wrongRoot.code, "runtime_access_invalid");
    assert.equal(openCtoRuntimeAccess(activation.registry_context, { sessionId: "", main: true }, root).code, "runtime_access_invalid");
    assert.equal(openCtoRuntimeAccess(activation.registry_context, { sessionId: "bad\u0000session", main: true }, root).code, "runtime_access_invalid");
    assert.equal(openCtoRuntimeAccess(activation.registry_context, { sessionId: "x".repeat(513), main: true }, root).code, "runtime_access_invalid");
    assert.equal(openCtoRuntimeAccess(activation.registry_context, { sessionId: "main-session", main: false as true }, root).code, "runtime_access_invalid");
    releaseWorkflowOwners(activation.release_token, ["workflow_registration", "workflow_tools"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(otherRoot, { recursive: true, force: true });
  }
});

test("marker removal, marker symlink, root inode swap, and claim release revoke an already-open facade", () => {
  const root = makeProject();
  try {
    stateFor(root);
    const first = openAccess(root);
    unlinkSync(join(root, ".omp", "fullstack.activation.json"));
    assertRevoked(() => first.access.assertLive());
    assertRevoked(() => first.access.readState("run-one"));
    releaseWorkflowOwners(first.activation.release_token, ["workflow_registration", "workflow_tools"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }

  const symlinkRoot = makeProject();
  const symlinkTarget = makeProject();
  try {
    stateFor(symlinkRoot);
    const opened = openAccess(symlinkRoot);
    unlinkSync(join(symlinkRoot, ".omp", "fullstack.activation.json"));
    symlinkSync(join(symlinkTarget, ".omp", "fullstack.activation.json"), join(symlinkRoot, ".omp", "fullstack.activation.json"));
    assertRevoked(() => opened.access.readState("run-one"));
    releaseWorkflowOwners(opened.activation.release_token, ["workflow_registration", "workflow_tools"]);
  } finally {
    rmSync(symlinkRoot, { recursive: true, force: true });
    rmSync(symlinkTarget, { recursive: true, force: true });
  }

  const swappedRoot = makeProject();
  const oldRoot = `${swappedRoot}.old`;
  try {
    stateFor(swappedRoot);
    const opened = openAccess(swappedRoot);
    renameSync(swappedRoot, oldRoot);
    mkdirSync(swappedRoot);
    mkdirSync(join(swappedRoot, ".omp"));
    writeFileSync(join(swappedRoot, ".omp", "fullstack.activation.json"), MARKER);
    assertRevoked(() => opened.access.stateDirectory("run-one"));
    releaseWorkflowOwners(opened.activation.release_token, ["workflow_registration", "workflow_tools"]);
  } finally {
    rmSync(swappedRoot, { recursive: true, force: true });
    rmSync(oldRoot, { recursive: true, force: true });
  }

  const releasedRoot = makeProject();
  try {
    stateFor(releasedRoot);
    const opened = openAccess(releasedRoot);
    releaseWorkflowOwners(opened.activation.release_token, ["workflow_registration", "workflow_tools"]);
    assertRevoked(() => opened.access.assertLive());
  } finally {
    rmSync(releasedRoot, { recursive: true, force: true });
  }
});

test("runtime active discovery fails closed on present corrupt index or proof and repairs only missing proof", () => {
  const root = makeProject();
  try {
    stateFor(root);
    const opened = openAccess(root);
    const ctoRoot = join(root, ".work-state", "cto");
    const indexPath = join(ctoRoot, "active-run-index.json");
    const proofPath = join(ctoRoot, ".active-run-index.proof.json");
    const indexBefore = readFileSync(indexPath);
    const proofBefore = readFileSync(proofPath);
    const proof = JSON.parse(proofBefore.toString("utf8")) as Record<string, unknown>;
    writeFileSync(proofPath, JSON.stringify({ ...proof, proof: "0".repeat(64) }));
    assert.throws(() => opened.access.findActiveRun(), (error: unknown) => error instanceof CtoRuntimeAccessError && error.code === "runtime_access_invalid");
    assert.deepEqual(readFileSync(indexPath), indexBefore);
    writeFileSync(proofPath, proofBefore);
    writeFileSync(indexPath, "{not-json");
    assert.throws(() => opened.access.findActiveRun(), (error: unknown) => error instanceof CtoRuntimeAccessError && error.code === "runtime_access_invalid");
    assert.equal(readFileSync(indexPath, "utf8"), "{not-json");
    writeFileSync(indexPath, indexBefore);
    unlinkSync(proofPath);
    assert.equal(opened.access.findActiveRun()?.runId, "run-one");
    assert.ok(readFileSync(proofPath).byteLength > 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
