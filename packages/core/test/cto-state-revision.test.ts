import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  readdirSync,
  rmSync,
  utimesSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  CTO_RUN_DELIVERY_INDEX_FILE,
  ctoRuntimeRunInitialIdentityDigest,
  mintCtoRuntimeRunOrigin,
  MAX_CTO_RUN_DELIVERY_INDEX_BYTES,
  CTO_STATE_WRITE_LOCK_FILE,
  CtoStateConflictError,
  publishCtoOutboxDelivery as rawPublishCtoOutboxDelivery,
  setCtoRunDeliveryTestHooks,
  readCtoRunDeliveryIndexPage,
  readCtoRunDeliveryCandidatesPinned,
  readCtoRunDeliveryActiveCandidatesPinned,
  readCtoRunDeliveryIndexAuthorityPinned,
  refreshCtoRunDeliveryIndexAuthorityPinned,
  readCtoRunDeliveryCompletedCandidatesPinned,
  readCtoRunDeliveryReconciledActiveCandidatesPinned,
  ctoStateDir,
  ensureSecureStateDirectory,
  migrateCtoState,
  readCtoState,
  parsePersistedCtoState,
  newCtoState,
  writeCtoState,
  setCtoPause,
  setTeamStatus,
  withCtoStateWriteLock,
  buildCtoTerminalSummaryEnvelope,
  ctoRunDeliverySummaryDigest,
  writeCtoStateLocked,
  writeCtoRuntimeStateProof,
} from "../src/cto/state.js";
import { appendWave, appendWaveUnderLock, finishWave } from "../src/cto/waves.js";
import { withCtoRunLock } from "../src/cto/transaction-lock.js";
import type { CtoTerminalSummaryEnvelope } from "../src/cto/state.js";
import type { CompletionEnvelope, WorkIdentity } from "../src/engine/types.js";
import type { CtoState, WaveRecord } from "../src/cto/types.js";
import { PinnedProjectRoot, PinnedRootError, processStartIdentity } from "../src/specification/pinned-root.js";
import { canonicalDurableIdFileName, legacyDurableIdFileName } from "../src/cto/durable-id.js";
import { findActiveCtoRun } from "../src/commands/cto.js";
import { openWorkflowActivation, releaseWorkflowOwners, requireRegistryContext, type WorkflowOwnerIdentity } from "../src/registry/owner.js";
import { issueCtoRuntimeSessionAuthority } from "../src/cto/session-authority.js";
import { openCtoRuntimeAccess } from "../src/cto/runtime-access.js";

const TEST_ACTIVATION_MARKER = '{"schema_version":1,"bundle_id":"@andvl1/omp-workflows-fullstack","entrypoint":"dist/index.js"}\n';
const TEST_ACTIVATION_SHA256 = createHash("sha256").update(TEST_ACTIVATION_MARKER, "utf8").digest("hex");
const CTO_RUN_DELIVERY_INDEX_PROOF_FILE = ".active-run-index.proof.json";
function testOwner(root: string): WorkflowOwnerIdentity {
  return {
    owner_id: "core-state-revision-test",
    bundle_id: "@andvl1/omp-workflows-fullstack",
    owner_kind: "fullstack",
    activation_marker: "core-state-revision-test-v1",
    host_range: ">=17.0.0",
    activation: { marker_id: "core-state-revision-test-v1", required: [{ path: ".omp/fullstack.activation.json", kind: "file", sha256: TEST_ACTIVATION_SHA256 }] },
    provenance: { package: "@andvl1/omp-workflows-fullstack", entrypoint: "dist/index.js", cwd: root },
  };
}
function trustedAccess(root: string) {
  mkdirSync(join(root, ".omp"), { recursive: true });
  if (!existsSync(join(root, ".omp", "fullstack.activation.json"))) writeFileSync(join(root, ".omp", "fullstack.activation.json"), TEST_ACTIVATION_MARKER);
  const activation = openWorkflowActivation(root, ["workflow_registration", "workflow_tools"], testOwner(root));
  if (activation.ok !== true) throw new Error(activation.error);
  const canonicalRoot = realpathSync(root);
  const rootIdentity = statSync(canonicalRoot);
  const authority = issueCtoRuntimeSessionAuthority(
    activation.registry_context,
    { canonical_root: canonicalRoot, dev: rootIdentity.dev, ino: rootIdentity.ino },
    { sessionManager: Object.freeze({}), sessionId: "core-state-revision-test" },
    () => { requireRegistryContext(activation.registry_context, canonicalRoot, "workflow_tools"); },
  );
  const opened = openCtoRuntimeAccess(activation.registry_context, authority, root);
  if (opened.ok !== true) {
    releaseWorkflowOwners(activation.release_token, ["workflow_registration", "workflow_tools"]);
    throw new Error(opened.error);
  }
  return { access: opened.access, release: () => { opened.access.close(); releaseWorkflowOwners(activation.release_token, ["workflow_registration", "workflow_tools"]); } };
}

function acknowledgeCtoRunDelivery(root: string, runId: string, expectedRevision: number, options: { drained: true } = { drained: true }): boolean {
  const trusted = trustedAccess(root);
  try { return trusted.access.acknowledgeDelivery(runId, expectedRevision, options); }
  finally { trusted.release(); }
}

function markCtoRunDeliveryPending(root: string, runId: string, stateRevision?: number, kind: "outbox" | "summary" | "retry" = "outbox"): boolean {
  const trusted = trustedAccess(root);
  try { return trusted.access.markDeliveryPending(runId, stateRevision, kind); }
  finally { trusted.release(); }
}

function removeCtoOutboxDeliveryObligation(root: string, runId: string, entryName: string, envelopeId: string): boolean {
  const trusted = trustedAccess(root);
  try { return trusted.access.removeOutboxDeliveryObligation(runId, entryName, envelopeId); }
  finally { trusted.release(); }
}

function persistState(state: CtoState, root: string): void {
  const pinnedRoot = PinnedProjectRoot.open(root);
  assert.ok(pinnedRoot);
  if (!pinnedRoot) throw new Error("state revision fixture root could not be pinned");
  try {
    const ownerSession = state.standby === true ? "core-state-revision-test" : state.owner_session ?? "core-state-revision-test";
    if (state.standby !== true) state.owner_session = ownerSession;
    if (state.work_identity) {
      state.work_identity = { ...state.work_identity, run_id: state.id, session_id: ownerSession };
    }
    const originPath = join(".work-state", "cto", state.id, ".runtime-origin-proof.json");
    if (!existsSync(join(root, originPath))
      && !mintCtoRuntimeRunOrigin(pinnedRoot, state, ownerSession, "state-revision-test", ctoRuntimeRunInitialIdentityDigest(state))) {
      throw new Error("state revision fixture origin publication failed");
    }
    writeCtoState(state, root, { pinnedRoot, preCommit: ({ pinnedRoot: currentRoot }) => currentRoot.assertStable() });
  } finally {
    pinnedRoot.close();
  }
}

function fixture(id: string): CtoState {
  const state = newCtoState({
    id,
    task: "state revision test",
    branch: "test",
    autonomous: false,
    owner_session: "core-state-revision-test",
    plan: { id, task: "state revision test", teams: [], created_at: "" },
  });
  state.work_identity = {
    run_id: id,
    wave_id: "wave-state-revision",
    slice_id: "slice-state-revision",
    session_id: "core-state-revision-test",
    workflow: "standard",
    stage_id: "state-revision",
    stage_cursor: "state-revision",
    capability_id: "capability-state-revision",
    capability_epoch: "epoch-state-revision",
    slot_id: "state-revision",
    task_id: "task-state-revision",
    dispatch_id: "dispatch-state-revision",
    attempt: 1,
    worker_id: "worker-state-revision",
  };
  return state;
}

function publishCtoOutboxDelivery(root: string, input: { run_id: string; state_revision: number; entry_name: string; json: string | Uint8Array; legacy_entry_name?: string; routing_binding?: unknown }): string | null {
  const trusted = trustedAccess(root);
  try {
    const obligation = trusted.access.recordOutboxDeliveryObligation({
      run_id: input.run_id,
      entry_name: input.entry_name,
      json: input.json,
      ...(input.routing_binding === undefined ? {} : { routing_binding: input.routing_binding as never }),
    });
    if (!obligation) return null;
    input.state_revision = obligation.state_revision;
    input.json = Buffer.from(obligation.json).toString("utf8");
    return trusted.access.publishOutboxDelivery({
      run_id: input.run_id,
      state_revision: obligation.state_revision,
      entry_name: input.entry_name,
      ...(input.legacy_entry_name === undefined ? {} : { legacy_entry_name: input.legacy_entry_name }),
      json: obligation.json,
      ...(input.routing_binding === undefined ? {} : { routing_binding: input.routing_binding as never }),
    });
  } finally { trusted.release(); }
}

function seedAuthenticatedBackingStates(states: readonly CtoState[], root: string): CtoState[] {
  const pinnedRoot = PinnedProjectRoot.open(root);
  assert.ok(pinnedRoot);
  if (!pinnedRoot) throw new Error("retention fixture root could not be pinned");
  const seeded: CtoState[] = [];
  try {
    for (const state of states) {
      const ownerSession = state.standby === true ? "core-state-revision-test" : state.owner_session ?? "core-state-revision-test";
      if (state.standby !== true) state.owner_session = ownerSession;
      if (state.work_identity) state.work_identity = { ...state.work_identity, run_id: state.id, session_id: ownerSession };
      // State proofs intentionally bind positive revisions; revision one is
      // the authenticated postimage of this test-only seed write.
      state.state_revision = 1;
      const statePath = join(".work-state", "cto", state.id, "state.json");
      pinnedRoot.ensureDirectories([dirname(statePath)]);
      pinnedRoot.writeExclusive(statePath, `${JSON.stringify(state, null, 2)}\n`);
      if (!mintCtoRuntimeRunOrigin(pinnedRoot, state, ownerSession, "state-revision-test", ctoRuntimeRunInitialIdentityDigest(state))) {
        throw new Error(`retention fixture origin publication failed for ${state.id}`);
      }
      if (!writeCtoRuntimeStateProof(pinnedRoot, state)) throw new Error(`retention fixture state proof publication failed for ${state.id}`);
      const verified = readCtoState(state.id, root);
      assert.ok(verified);
      if (!verified) throw new Error(`retention fixture state ${state.id} is unreadable after authenticated seed`);
      seeded.push(verified);
    }
    return seeded;
  } finally {
    pinnedRoot.close();
  }
}

test("CTO state reads are detached and mutators do not write without a trusted transaction", () => {
  const root = mkdtempSync(join(tmpdir(), "cto-state-detached-"));
  const runId = "detached-state";
  try {
    const state = fixture(runId);
    state.teams = [{ id: "team-a", status: "pending", escalations: {} }];
    setTeamStatus(state, "team-a", "in_progress");
    assert.equal(state.teams[0]?.status, "in_progress");
    assert.equal(existsSync(join(root, ".work-state", "cto", runId, "state.json")), false, "pure mutator must not create durable state");
    persistState(state, root);
    const first = readCtoState(runId, root);
    assert.ok(first);
    first!.teams[0]!.status = "done";
    first!.integration.status = "done";
    const second = readCtoState(runId, root);
    assert.equal(second?.teams[0]?.status, "in_progress");
    assert.equal(second?.integration.status, "pending");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("execution team cannot become done without the current identity-bound terminal result", () => {
  const state = fixture("execution-status");
  const identity: WorkIdentity = {
    run_id: state.id,
    wave_id: "wave-a",
    slice_id: "slice-a",
    session_id: "session-a",
    workflow: "standard",
    stage_id: "execution",
    stage_cursor: "execution",
    capability_id: "cap-a",
    capability_epoch: "epoch-a",
    slot_id: "slot-a",
    task_id: "task-a",
    dispatch_id: "dispatch-a",
    attempt: 1,
    worker_id: "worker-a",
  };
  state.teams = [{ id: "team-a", status: "pending", escalations: {}, slice_id: "slice-a", work_identity: identity }];
  assert.throws(() => setTeamStatus(state, "team-a", "done"), /identity-bound terminal result/u);
  const envelope: CompletionEnvelope = {
    schema_version: 1,
    identity: { ...identity },
    outcome: "succeeded",
    terminal_signal: "workflow_complete",
    artifact_refs: [],
    evidence_ref: null,
    conflict_ref: null,
    completed_by: "workflow_complete",
    emitted_at: "2026-09-11T00:00:00.000Z",
  };
  state.teams[0]!.completion_envelope = envelope;
  setTeamStatus(state, "team-a", "done");
  assert.equal(state.teams[0]!.status, "done");
  state.teams[0]!.status = "pending";
  state.teams[0]!.completion_envelope = { ...envelope, identity: { ...identity, dispatch_id: "stale-dispatch" } };
  assert.throws(() => setTeamStatus(state, "team-a", "done"), /identity-bound terminal result/u);
  assert.equal(state.teams[0]!.status, "pending");
});
test("CTO state writer keeps near-limit canonical bytes readable and rejects over-limit before journal", () => {
  const root = mkdtempSync(join(tmpdir(), "cto-state-byte-bound-"));
  const nearId = "state-near-limit";
  const overId = "state-over-limit";
  const stateLimit = 8 * 1024 * 1024;
  const quarantine = (count: number, payloadBytes: number) => Object.fromEntries(
    Array.from({ length: count }, (_, index) => [`q-${String(index).padStart(4, "0")}`, { payload: "x".repeat(payloadBytes) }]),
  );
  try {
    const near = fixture(nearId);
    near.inbox_quarantine = quarantine(900, 8 * 1024);
    persistState(near, root);
    const nearPath = join(root, ".work-state", "cto", nearId, "state.json");
    assert.ok(readFileSync(nearPath).byteLength < stateLimit);
    assert.ok(readCtoState(nearId, root));

    const over = fixture(overId);
    over.inbox_quarantine = quarantine(1024, 8 * 1024);
    assert.throws(() => writeCtoState(over, root, { preCommit: ({ pinnedRoot }) => pinnedRoot.assertStable() }), /CTO_STATE_INVALID.*byte limit/u);
    assert.equal(existsSync(join(root, ".work-state", "cto", overId, "state.json")), false);
    assert.equal(existsSync(join(root, ".work-state", "cto", ".active-run-index-journal", `${overId}.json`)), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
test("readCtoState rejects invalid UTF-8 without rewriting mounted state", () => {
  const root = mkdtempSync(join(tmpdir(), "cto-state-utf8-"));
  const runId = "invalid-state-utf8";
  try {
    persistState(fixture(runId), root);
    const path = join(root, ".work-state", "cto", runId, "state.json");
    const original = readFileSync(path);
    const marker = Buffer.from("state revision test", "utf8");
    const markerOffset = original.indexOf(marker);
    assert.ok(markerOffset >= 0);
    const invalid = Buffer.concat([
      original.subarray(0, markerOffset),
      Buffer.from([0xff]),
      original.subarray(markerOffset + marker.length),
    ]);
    writeFileSync(path, invalid);

    assert.throws(() => readCtoState(runId, root), /valid for encoding/u);
    assert.deepEqual(readFileSync(path), invalid, "invalid state bytes remain untouched");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("invalid UTF-8 publication journals fail closed before delivery recovery", () => {
  const root = mkdtempSync(join(tmpdir(), "cto-journal-utf8-"));
  const runId = "invalid-journal-utf8";
  try {
    persistState(fixture(runId), root);
    const statePath = join(root, ".work-state", "cto", runId, "state.json");
    const stateBytes = readFileSync(statePath);
    const journalDir = join(root, ".work-state", "cto", ".active-run-index-journal");
    mkdirSync(journalDir, { recursive: true });
    const journalPath = join(journalDir, `${runId}.json`);
    const state = readCtoState(runId, root);
    assert.ok(state);
    const prefix = Buffer.from(
      `{"schema_version":1,"run_id":${JSON.stringify(runId)},"state_revision":${state.state_revision},"state_sha256":"${createHash("sha256").update(stateBytes).digest("hex")}","metadata":"`,
      "utf8",
    );
    const invalid = Buffer.concat([prefix, Buffer.from([0xff]), Buffer.from(`"}`, "utf8")]);
    writeFileSync(journalPath, invalid);

    assert.throws(() => readCtoRunDeliveryIndexPage(root), /publication journal is not valid JSON/u);
    assert.deepEqual(readFileSync(statePath), stateBytes, "journal failure must not rewrite state");
    assert.deepEqual(readFileSync(journalPath), invalid, "invalid journal bytes remain untouched");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
test("publication journal clear preserves a concurrent replacement", () => {
  const root = mkdtempSync(join(tmpdir(), "cto-journal-replacement-"));
  const runId = "journal-replacement";
  try {
    const initial = fixture(runId);
    persistState(initial, root);
    const state = readCtoState(runId, root);
    assert.ok(state);
    const journalPath = join(root, ".work-state", "cto", ".active-run-index-journal", `${runId}.json`);
    const originalWrite = PinnedProjectRoot.prototype.writeAtomicWithReceipt;
    let replaced = false;
    let replacementBytes: Buffer | undefined;
    PinnedProjectRoot.prototype.writeAtomicWithReceipt = function(relativePath, content, options) {
      const receipt = originalWrite.call(this, relativePath, content, options);
      if (!replaced && relativePath.endsWith(`${runId}.json`)) {
        replaced = true;
        const replacementPath = `${journalPath}.replacement`;
        replacementBytes = Buffer.from(content);
        writeFileSync(replacementPath, replacementBytes);
        renameSync(replacementPath, journalPath);
      }
      return receipt;
    };
    try {
      // Use an ordinary state revision so publication reaches exact journal
      // cleanup; the replacement is installed between the journal write and
      // receipt-bound remove, exercising the concurrent-replacement fence.
      state!.integration.note = "journal replacement";
      assert.throws(
        () => writeCtoState(state!, root, { preCommit: ({ pinnedRoot }) => pinnedRoot.assertStable() }),
        (error: unknown) => error instanceof PinnedRootError && error.code === "recovery_required",
      );
    } finally {
      PinnedProjectRoot.prototype.writeAtomicWithReceipt = originalWrite;
    }
    assert.equal(replaced, true, "the replacement seam must execute after journal publication");
    assert.ok(existsSync(journalPath), "the replaced journal must remain durable");
    assert.deepEqual(readFileSync(journalPath), replacementBytes, "exact replacement bytes must survive receipt-bound cleanup");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("preparation authority fields round-trip only with exact bounded cross-field shape", () => {
  const state = fixture("prep-authority");
  const profileHash = "a".repeat(64);
  const feature = {
    request_id: "request-feature",
    feature_id: "feature-a",
    run_key: "spec-feature-a",
    workspace_path: "specs/feature-a",
    state_path: ".work-state/features/feature-a/state.json",
    profile_name: "spec-preparation",
    profile_hash: profileHash,
    phase_writer_id: "writer-feature-a",
    facets: ["primary"],
    request: "Prepare feature A",
  };
  const queued = {
    request_id: "request-queued",
    feature_id: "feature-b",
    run_key: "spec-feature-b",
    phase: "plan",
    facet_id: "primary",
    profile_name: "spec-preparation",
    profile_hash: profileHash,
    reason_code: "capacity",
    reason: "preparation capacity is full",
  };
  const capability = {
    capability_id: "capability-preparation",
    dispatch_token_hash: "b".repeat(64),
    advance_token_hash: "c".repeat(64),
    issued_for: {
      run_key: state.id,
      branch: state.branch,
      workflow: "spec-preparation",
      profile_hash: profileHash,
      stage_cursor: "specification-preparation",
      cursor_epoch: "epoch-preparation",
    },
    kind: "single",
    expected_roles: ["cto"],
    expected_count: 1,
    expected_roster: [{ role: "cto", agent: "cto" }],
    status: "ready",
    dispatches: [],
  };
  const base = {
    ...state,
    preparation_digest: "d".repeat(64),
    preparation_features: [feature],
    preparation_queued: [queued],
    preparation_capability: capability,
  } as unknown as Record<string, unknown>;
  assert.ok(parsePersistedCtoState(base));
  const malformed = [
    () => ({ ...base, preparation_features: [{ ...feature, extra: true }] }),
    () => ({ ...base, preparation_features: [{ ...feature, state_path: "../escape/state.json" }] }),
    () => ({ ...base, preparation_features: [{ ...feature, facets: ["bad facet"] }] }),
    () => ({ ...base, preparation_queued: [{ ...queued, phase: "execute" }] }),
    () => ({ ...base, preparation_queued: [{ ...queued, request_id: feature.request_id }] }),
    () => ({ ...base, preparation_capability: { ...capability, dispatch_token_hash: "not-a-digest" } }),
    () => ({ ...base, preparation_capability: { ...capability, status: "dispatched" } }),
    () => ({
      ...base,
      preparation_capability: {
        ...capability,
        issued_for: { ...capability.issued_for, run_key: "other-run" },
      },
    }),
    () => {
      const next = { ...base };
      delete next.preparation_digest;
      return next;
    },
  ];
  for (const makeMalformed of malformed) assert.equal(parsePersistedCtoState(makeMalformed()), null);
});

async function crashWriterAtBoundary(root: string, runId: string, target: string): Promise<number> {
  const worker = spawn(
    process.execPath,
    ["--import", "tsx", "--input-type=module", "-e", `
      import { PinnedProjectRoot } from "./src/specification/pinned-root.ts";
      import { ctoRuntimeRunInitialIdentityDigest, mintCtoRuntimeRunOrigin, newCtoState, writeCtoState } from "./src/cto/state.ts";
      const root = process.env.CTO_ROOT;
      const runId = process.env.CTO_RUN_ID;
      const target = process.env.CTO_CRASH_TARGET;
      if (!root || !runId || !target) throw new Error("missing crash-boundary environment");
      const pinned = PinnedProjectRoot.open(root, {
        beforeRename: (relativePath) => {
          if (relativePath === target) process.exit(73);
        },
      });
      if (!pinned) throw new Error("crash-boundary root could not be pinned");
      const state = newCtoState({
        id: runId,
        task: "crash-boundary candidate",
        branch: "main",
        autonomous: false,
        plan: { id: runId, task: "crash-boundary candidate", teams: [], created_at: "" },
        owner_session: "core-state-revision-test",
      });
      state.work_identity = {
        run_id: runId,
        wave_id: "wave-crash-boundary",
        slice_id: "slice-crash-boundary",
        session_id: "core-state-revision-test",
        workflow: "standard",
        stage_id: "state-revision",
        stage_cursor: "state-revision",
        capability_id: "capability-crash-boundary",
        capability_epoch: "epoch-crash-boundary",
        slot_id: "crash-boundary",
        task_id: "task-crash-boundary",
        dispatch_id: "dispatch-crash-boundary",
        attempt: 1,
        worker_id: "worker-crash-boundary",
      };
      if (!mintCtoRuntimeRunOrigin(pinned, state, "core-state-revision-test", "crash-boundary", ctoRuntimeRunInitialIdentityDigest(state))) throw new Error("crash-boundary origin publication failed");
      writeCtoState(state, root, { preCommit: ({ pinnedRoot }) => pinnedRoot.assertStable(), pinnedRoot: pinned });
    `],
    {
      cwd: resolve(dirname(fileURLToPath(import.meta.url)), ".."),
      env: { ...process.env, CTO_ROOT: root, CTO_RUN_ID: runId, CTO_CRASH_TARGET: target },
      stdio: ["ignore", "ignore", "pipe"],
    },
  );
  let stderr = "";
  worker.stderr?.on("data", (chunk: Buffer) => { stderr += String(chunk); });
  const { promise, resolve: resolveExit, reject } = Promise.withResolvers<number>();
  worker.once("error", reject);
  worker.once("exit", (code) => {
    if (code !== 73 && code !== 0) reject(new Error(`crash-boundary writer failed with ${String(code)}: ${stderr}`));
    else resolveExit(code ?? 1);
  });
  return promise;
}
test("CTO state writers reject unsafe IDs before creating state or index paths", () => {
  const root = mkdtempSync(join(tmpdir(), "cto-state-run-id-"));
  try {
    for (const runId of ["foo/bar", "../escape", "foo∕bar", "foo\u2028bar"]) {
      const state = fixture(runId);
      assert.throws(() => writeCtoState(state, root, { preCommit: ({ pinnedRoot }) => pinnedRoot.assertStable() }), /unsafe CTO run id/);
      const pin = PinnedProjectRoot.open(root);
      assert.ok(pin);
      try {
        assert.throws(() => writeCtoStateLocked(state, root, { pinnedRoot: pin }), /unsafe CTO run id/);
      } finally {
        pin.close();
      }
    }
    assert.equal(existsSync(join(root, ".work-state")), false, "unsafe state IDs must not create a state tree");

    const uppercase = fixture("CTO-1");
    writeCtoState(uppercase, root, { preCommit: ({ pinnedRoot }) => pinnedRoot.assertStable() });
    assert.equal(readCtoState("CTO-1", root)?.id, "CTO-1");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

function oldTimestamp(): Date {
  return new Date(Date.now() - 1_000);
}

test("CTO state CAS preserves the winner and advances the passed candidate", () => {
  const root = mkdtempSync(join(tmpdir(), "cto-state-revision-cas-"));
  try {
    const initial = fixture("cas-run");
    assert.equal(initial.state_revision, 0);
    persistState(initial, root);
    assert.equal(initial.state_revision, 1);

    const winner = readCtoState(initial.id, root);
    const loser = readCtoState(initial.id, root);
    assert.ok(winner);
    assert.ok(loser);
    winner!.integration.note = "winner";
    writeCtoState(winner!, root, { preCommit: ({ pinnedRoot }) => pinnedRoot.assertStable() });
    assert.equal(winner!.state_revision, 2);

    loser!.integration.note = "loser";
    assert.throws(
      () => writeCtoState(loser!, root, { preCommit: ({ pinnedRoot }) => pinnedRoot.assertStable() }),
      (error: unknown) => error instanceof CtoStateConflictError
        && error.code === "CTO_STATE_CONFLICT"
        && error.expectedRevision === 1
        && error.actualRevision === 2,
    );
    const canonical = readCtoState(initial.id, root);
    assert.equal(canonical?.integration.note, "winner");
    assert.equal(canonical?.state_revision, 2);

    winner!.integration.note = "winner-again";
    writeCtoState(winner!, root, { preCommit: ({ pinnedRoot }) => pinnedRoot.assertStable() });
    assert.equal(winner!.state_revision, 3, "successful writes refresh the in-process candidate revision");
    assert.equal(readCtoState(initial.id, root)?.integration.note, "winner-again");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
test("state CAS rejects same-revision inode replacement after journal publication", () => {
  const root = mkdtempSync(join(tmpdir(), "cto-state-cas-replacement-"));
  const runId = "cas-replacement";
  try {
    const initial = fixture(runId);
    persistState(initial, root);
    const candidate = readCtoState(runId, root);
    assert.ok(candidate);
    candidate!.integration.note = "candidate";
    const statePath = join(root, ".work-state", "cto", runId, "state.json");
    const indexPath = join(root, ".work-state", "cto", CTO_RUN_DELIVERY_INDEX_FILE);
    const proofPath = join(root, ".work-state", "cto", CTO_RUN_DELIVERY_INDEX_PROOF_FILE);
    const beforeIndex = readFileSync(indexPath);
    const beforeProof = readFileSync(proofPath);
    let injected = false;
    assert.throws(
      () => writeCtoState(candidate!, root, {
        preCommit: ({ candidate: next }) => {
          if (injected) return;
          injected = true;
          const original = readCtoState(runId, root);
          assert.ok(original);
          const replacement = { ...original, integration: { ...original.integration, note: "foreign replacement" } };
          writeFileSync(statePath, `${JSON.stringify(replacement, null, 2)}\n`, "utf8");
          assert.equal(next.state_revision, replacement.state_revision + 1);
        },
      }),
      (error: unknown) => error instanceof PinnedRootError && error.code === "changed",
    );
    assert.equal(injected, true);
    assert.match(readFileSync(statePath, "utf8"), /foreign replacement/u);
    assert.deepEqual(readFileSync(indexPath), beforeIndex, "lost update must not rewrite delivery index");
    assert.deepEqual(readFileSync(proofPath), beforeProof, "lost update must not rewrite index proof");
    assert.equal(existsSync(join(root, ".work-state", "cto", ".active-run-index-journal", `${runId}.json`)), true, "journal remains for exact recovery");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

function promoteStandbyForJournalCrash(root: string, runId: string, failPath: "state-proof" | "origin"): { statePath: string; originPath: string; indexPath: string; proofPath: string; journalPath: string } {
  const standby = { ...fixture(runId), standby: true, owner_session: null };
  persistState(standby, root);
  const candidate = readCtoState(runId, root);
  assert.ok(candidate);
  candidate!.standby = false;
  candidate!.owner_session = "promoted-session";
  candidate!.work_identity = { ...candidate!.work_identity!, session_id: "promoted-session" };
  const statePath = join(root, ".work-state", "cto", runId, "state.json");
  const originPath = join(root, ".work-state", "cto", runId, ".runtime-origin-proof.json");
  const indexPath = join(root, ".work-state", "cto", CTO_RUN_DELIVERY_INDEX_FILE);
  const proofPath = join(root, ".work-state", "cto", CTO_RUN_DELIVERY_INDEX_PROOF_FILE);
  const journalPath = join(root, ".work-state", "cto", ".active-run-index-journal", `${runId}.json`);
  const originalReplace = PinnedProjectRoot.prototype.replaceFileIfMatches;
  let injected = false;
  PinnedProjectRoot.prototype.replaceFileIfMatches = function(relativePath, expected, content) {
    if (!injected && ((failPath === "state-proof" && relativePath.endsWith(".runtime-state-proof.json")) || (failPath === "origin" && relativePath.endsWith(".runtime-origin-proof.json")))) {
      injected = true;
      throw new PinnedRootError("changed", "injected promotion crash seam");
    }
    return originalReplace.call(this, relativePath, expected, content);
  };
  try {
    assert.throws(
      () => writeCtoState(candidate!, root, { originTransition: { ownerSession: "promoted-session" }, preCommit: ({ pinnedRoot }) => pinnedRoot.assertStable() }),
      (error: unknown) => error instanceof PinnedRootError && error.code === "recovery_required",
    );
  } finally {
    PinnedProjectRoot.prototype.replaceFileIfMatches = originalReplace;
  }
  assert.equal(injected, true, `${failPath} crash seam must execute`);
  assert.equal(existsSync(journalPath), true, `${failPath} must retain authenticated transition journal`);
  return { statePath, originPath, indexPath, proofPath, journalPath };
}

test("authenticated transition journal repairs promotion after state/proof crash boundaries", () => {
  for (const failPath of ["state-proof", "origin"] as const) {
    const root = mkdtempSync(join(tmpdir(), `cto-transition-crash-${failPath}-`));
    try {
      const paths = promoteStandbyForJournalCrash(root, `transition-${failPath}`, failPath);
      const recoveredPage = readCtoRunDeliveryIndexPage(root);
      assert.equal(recoveredPage.active_run_id, `transition-${failPath}`, `${failPath} recovery must admit promoted run`);
      assert.equal(existsSync(paths.journalPath), false, `${failPath} recovery must consume journal`);
      const replayedPage = readCtoRunDeliveryIndexPage(root);
      assert.equal(replayedPage.active_run_id, `transition-${failPath}`, `${failPath} recovery must remain idempotent on retry`);
      const state = readCtoState(`transition-${failPath}`, root);
      assert.equal(state?.standby, false);
      assert.equal(state?.owner_session, "promoted-session");
      assert.equal(JSON.parse(readFileSync(paths.originPath, "utf8")).standby, false);
      assert.equal(JSON.parse(readFileSync(paths.originPath, "utf8")).owner_session, "promoted-session");
      const indexPin = PinnedProjectRoot.open(root);
      assert.ok(indexPin);
      if (indexPin) {
        try {
          const activeCandidates = readCtoRunDeliveryActiveCandidatesPinned(indexPin);
          assert.equal(activeCandidates.ok, true, `${failPath} recovery must expose authenticated active candidates`);
          if (activeCandidates.ok) assert.ok(activeCandidates.entries.some((entry) => entry.run_id === `transition-${failPath}`));
        } finally {
          indexPin.close();
        }
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

test("authenticated transition journal rejects tampered proof, old origin, and non-exact state postimages", () => {
  const scenarios = ["proof", "origin", "state", "index-swap", "proof-missing"] as const;
  for (const scenario of scenarios) {
    const root = mkdtempSync(join(tmpdir(), `cto-transition-tamper-${scenario}-`));
    try {
      const paths = promoteStandbyForJournalCrash(root, `transition-tamper-${scenario}`, "origin");
      const beforeState = readFileSync(paths.statePath);
      const beforeOrigin = readFileSync(paths.originPath);
      const beforeIndex = readFileSync(paths.indexPath);
      const beforeProof = readFileSync(paths.proofPath);
      if (scenario === "proof") {
        const journal = JSON.parse(readFileSync(paths.journalPath, "utf8")) as { origin_transition: { proof: string } };
        journal.origin_transition.proof = "0".repeat(64);
        writeFileSync(paths.journalPath, `${JSON.stringify(journal)}\n`, "utf8");
      } else if (scenario === "origin") {
        const origin = JSON.parse(readFileSync(paths.originPath, "utf8")) as { identity_sha256: string };
        origin.identity_sha256 = "f".repeat(64);
        writeFileSync(paths.originPath, `${JSON.stringify(origin)}\n`, "utf8");
      } else if (scenario === "state") {
        const state = JSON.parse(readFileSync(paths.statePath, "utf8")) as { integration: Record<string, unknown> };
        state.integration = { ...state.integration, note: "non-exact postimage" };
        writeFileSync(paths.statePath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
      } else if (scenario === "index-swap") {
        const replacement = JSON.parse(readFileSync(paths.indexPath, "utf8")) as { entries: unknown[] };
        replacement.entries = [...replacement.entries];
        writeFileSync(paths.indexPath, `${JSON.stringify(replacement)}\n`, "utf8");
      } else {
        rmSync(paths.proofPath, { force: true });
      }
      const stateEvidence = readFileSync(paths.statePath);
      const originEvidence = readFileSync(paths.originPath);
      const indexEvidence = readFileSync(paths.indexPath);
      const proofEvidence = existsSync(paths.proofPath) ? readFileSync(paths.proofPath) : null;
      assert.throws(() => readCtoRunDeliveryIndexPage(root), /journal|origin|digest|authenticated|recovery|preimage/u, scenario);
      assert.deepEqual(readFileSync(paths.statePath), stateEvidence, `${scenario} must not rewrite state evidence`);
      assert.deepEqual(readFileSync(paths.originPath), originEvidence, `${scenario} must not rewrite origin evidence`);
      assert.deepEqual(readFileSync(paths.indexPath), indexEvidence, `${scenario} must not rewrite index evidence`);
      assert.deepEqual(existsSync(paths.proofPath) ? readFileSync(paths.proofPath) : null, proofEvidence, `${scenario} must not rewrite index proof evidence`);
      assert.equal(existsSync(paths.journalPath), true, `${scenario} evidence remains for explicit recovery`);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

test("promotion rejects missing index or proof preimages before state CAS", () => {
  for (const missing of ["index", "proof"] as const) {
    const root = mkdtempSync(join(tmpdir(), `cto-transition-missing-${missing}-`));
    const runId = `transition-missing-${missing}`;
    try {
      const standby = { ...fixture(runId), standby: true, owner_session: null };
      persistState(standby, root);
      const candidate = readCtoState(runId, root);
      assert.ok(candidate);
      candidate!.standby = false;
      candidate!.owner_session = "promoted-session";
      const statePath = join(root, ".work-state", "cto", runId, "state.json");
      const originPath = join(root, ".work-state", "cto", runId, ".runtime-origin-proof.json");
      const indexPath = join(root, ".work-state", "cto", CTO_RUN_DELIVERY_INDEX_FILE);
      const proofPath = join(root, ".work-state", "cto", CTO_RUN_DELIVERY_INDEX_PROOF_FILE);
      const journalPath = join(root, ".work-state", "cto", ".active-run-index-journal", `${runId}.json`);
      const beforeState = readFileSync(statePath);
      const beforeOrigin = readFileSync(originPath);
      rmSync(missing === "index" ? indexPath : proofPath, { force: true });
      assert.throws(
        () => writeCtoState(candidate!, root, { originTransition: { ownerSession: "promoted-session" }, preCommit: ({ pinnedRoot }) => pinnedRoot.assertStable() }),
        (error: unknown) => error instanceof PinnedRootError && error.code === "recovery_required",
      );
      assert.deepEqual(readFileSync(statePath), beforeState, `${missing} absence must not publish candidate state`);
      assert.deepEqual(readFileSync(originPath), beforeOrigin, `${missing} absence must not rewrite origin`);
      assert.equal(existsSync(journalPath), false, `${missing} absence must fail before journal publication`);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

test("ordinary schema2 journal repairs state-proof crash without origin transition", () => {
  const root = mkdtempSync(join(tmpdir(), "cto-v2-ordinary-crash-"));
  const runId = "v2-ordinary-crash";
  try {
    const initial = fixture(runId);
    persistState(initial, root);
    const candidate = readCtoState(runId, root);
    assert.ok(candidate);
    candidate!.integration.note = "ordinary crash postimage";
    const originalReplace = PinnedProjectRoot.prototype.replaceFileIfMatches;
    let injected = false;
    PinnedProjectRoot.prototype.replaceFileIfMatches = function(relativePath, expected, content) {
      if (!injected && relativePath.endsWith(".runtime-state-proof.json")) {
        injected = true;
        throw new PinnedRootError("changed", "injected ordinary proof crash");
      }
      return originalReplace.call(this, relativePath, expected, content);
    };
    try {
      assert.throws(() => writeCtoState(candidate!, root, { preCommit: ({ pinnedRoot }) => pinnedRoot.assertStable() }), (error: unknown) => error instanceof PinnedRootError && error.code === "recovery_required");
    } finally {
      PinnedProjectRoot.prototype.replaceFileIfMatches = originalReplace;
    }
    assert.equal(injected, true);
    const journalPath = join(root, ".work-state", "cto", ".active-run-index-journal", `${runId}.json`);
    assert.equal((JSON.parse(readFileSync(journalPath, "utf8")) as { schema_version: number }).schema_version, 2);
    readCtoRunDeliveryIndexPage(root);
    assert.equal(existsSync(journalPath), false);
    assert.equal(readCtoState(runId, root)?.integration.note, "ordinary crash postimage");
    assert.equal(existsSync(join(root, ".work-state", "cto", runId, ".runtime-state-proof.json")), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("legacy v1 publication journal only replays an exact already-proved state", () => {
  const root = mkdtempSync(join(tmpdir(), "cto-legacy-journal-proof-"));
  const runId = "legacy-journal-proof";
  try {
    const state = fixture(runId);
    persistState(state, root);
    const statePath = join(root, ".work-state", "cto", runId, "state.json");
    const proofPath = join(root, ".work-state", "cto", runId, ".runtime-state-proof.json");
    const journalDir = join(root, ".work-state", "cto", ".active-run-index-journal");
    const journalPath = join(journalDir, `${runId}.json`);
    mkdirSync(journalDir, { recursive: true });
    const exactBytes = readFileSync(statePath);
    writeFileSync(journalPath, JSON.stringify({ schema_version: 1, run_id: runId, state_revision: state.state_revision, state_sha256: createHash("sha256").update(exactBytes).digest("hex") }) + "\n");
    readCtoRunDeliveryIndexPage(root);
    assert.equal(existsSync(journalPath), false, "exact legacy journal may be consumed");

    const changed = JSON.parse(exactBytes.toString("utf8")) as { integration: Record<string, unknown> };
    changed.integration = { ...changed.integration, note: "forged same-identity postimage" };
    writeFileSync(statePath, `${JSON.stringify(changed, null, 2)}\n`, "utf8");
    rmSync(proofPath, { force: true });
    const forgedBytes = readFileSync(statePath);
    writeFileSync(journalPath, JSON.stringify({ schema_version: 1, run_id: runId, state_revision: state.state_revision, state_sha256: createHash("sha256").update(forgedBytes).digest("hex") }) + "\n");
    assert.throws(() => readCtoRunDeliveryIndexPage(root), /legacy CTO journal|authenticated|recovery/u);
    assert.equal(existsSync(proofPath), false, "legacy v1 recovery must not mint a state proof");
    assert.equal(existsSync(journalPath), true, "forged legacy journal remains evidence");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("new publication journals always use authenticated v2 base proof", () => {
  const root = mkdtempSync(join(tmpdir(), "cto-v2-journal-base-"));
  const runId = "v2-journal-base";
  try {
    const state = fixture(runId);
    persistState(state, root);
    const current = readCtoState(runId, root);
    assert.ok(current);
    current!.integration.note = "v2 journal write";
    const journalPath = join(root, ".work-state", "cto", ".active-run-index-journal", `${runId}.json`);
    assert.throws(() => writeCtoState(current!, root, { preCommit: () => { throw new Error("observe v2 journal"); } }), /observe v2 journal/u);
    const published = JSON.parse(readFileSync(journalPath, "utf8")) as Record<string, unknown>;
    assert.equal(published.schema_version, 2);
    assert.equal(typeof published.proof, "string");
    assert.equal("origin_transition" in published, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("terminal CTO runs reject wave append without mutating state or delivery authority", () => {
  for (const pauseKind of ["done", "failed"] as const) {
    const root = mkdtempSync(join(tmpdir(), `cto-wave-terminal-${pauseKind}-`));
    try {
      const state = fixture(`terminal-wave-${pauseKind}`);
      persistState(state, root);
      setCtoPause(state, pauseKind, "terminal test");
      persistState(state, root);
      const statePath = join(root, ".work-state", "cto", state.id, "state.json");
      const indexPath = join(root, ".work-state", "cto", CTO_RUN_DELIVERY_INDEX_FILE);
      const beforeState = readFileSync(statePath);
      const beforeIndex = readFileSync(indexPath);
      const beforeRevision = state.state_revision;
      const beforeHistory = JSON.stringify(state.wave_history);
      const opts = {
        id: `wave-${pauseKind}`,
        source: "test",
        source_id: `source-${pauseKind}`,
        task: "must not append",
        now: new Date(1_000).toISOString(),
      };
      assert.throws(() => appendWave(state, opts), /terminal CTO run/);
      withCtoRunLock(root, state.id, (handle) => {
        assert.throws(() => appendWaveUnderLock(state, opts, handle), /terminal CTO run/);
      });
      assert.equal(state.state_revision, beforeRevision);
      assert.equal(JSON.stringify(state.wave_history), beforeHistory);
      assert.deepEqual(readFileSync(statePath), beforeState);
      assert.deepEqual(readFileSync(indexPath), beforeIndex);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }

  const state = fixture("live-wave");
  const revision = state.state_revision;
  const appended = appendWave(state, {
    id: "wave-live",
    source: "test",
    source_id: "source-live",
    task: "must append",
    now: new Date(1_000).toISOString(),
  });
  assert.equal(appended.state_revision, revision, "pure wave transitions do not publish a state revision");
  assert.equal(appended.wave_history.at(-1)?.id, "wave-live");
  assert.equal(appended.wave_history.at(-1)?.status, "active");
  assert.equal(state.wave_history.length, 0, "pure wave transitions do not mutate the input");
});


test("active-run publication recovers every journal/state/index crash boundary", async () => {
  const root = mkdtempSync(join(tmpdir(), "cto-active-publication-crash-"));
  const oldRunId = "old-active";
  const newRunId = "new-active";
  const indexPath = join(root, ".work-state", "cto", CTO_RUN_DELIVERY_INDEX_FILE);
  const journalPath = join(root, ".work-state", "cto", ".active-run-index-journal", `${newRunId}.json`);
  const journalRelativePath = join(".work-state", "cto", ".active-run-index-journal", `${newRunId}.json`);
  try {
    const oldState = { ...fixture(oldRunId), owner_session: "crash-boundary-session" };
    const oldPinned = PinnedProjectRoot.open(root);
    assert.ok(oldPinned);
    assert.equal(mintCtoRuntimeRunOrigin(oldPinned, oldState, "crash-boundary-session", "crash-boundary", ctoRuntimeRunInitialIdentityDigest(oldState)), true);
    oldPinned.close();
    persistState(oldState, root);
    const boundaries = [
      {
        target: journalRelativePath,
        expectNewState: false,
        description: "publication journal",
      },
      {
        target: join(".work-state", "cto", newRunId, "state.json"),
        expectNewState: false,
        description: "state.json",
      },
      {
        target: join(".work-state", "cto", CTO_RUN_DELIVERY_INDEX_FILE),
        expectNewState: true,
        description: "active-run index",
      },
    ] as const;
    for (const boundary of boundaries) {
      assert.equal(
        await crashWriterAtBoundary(root, newRunId, boundary.target),
        73,
        `${boundary.description} crash boundary must terminate the writer`,
      );
      const newStatePath = join(root, ".work-state", "cto", newRunId, "state.json");
      assert.equal(existsSync(newStatePath), boundary.expectNewState, `${boundary.description} must leave expected state publication`);
      const active = findActiveCtoRun(root);
      if (boundary.expectNewState) {
        assert.equal(active?.runId, newRunId, "restart must recover the newly committed active run from the journal");
        const repaired = JSON.parse(readFileSync(indexPath, "utf8")) as {
          active_run_id: string | null;
          entries: Array<{ run_id: string; state_revision: number; status: string; pending_summary: boolean; pending_outbox: boolean; pending_retry: boolean; summary_digest: string; updated_at: string }>;
        };
        assert.equal(repaired.active_run_id, newRunId, "recovery must publish the exact active pointer");
        assert.equal(readCtoRunDeliveryIndexPage(root).active_run_id, newRunId, "delivery page must observe the repaired active pointer after restart");
        assert.deepEqual(
          repaired.entries.find((entry) => entry.run_id === newRunId),
          {
            run_id: newRunId,
            state_revision: 1,
            status: "active",
            updated_at: readCtoState(newRunId, root)?.updated_at,
            pending_summary: false,
            pending_outbox: false,
            pending_retry: false,
            summary_digest: "",
          },
          "recovery must publish the exact active entry",
        );
      } else {
        assert.equal(active?.runId, oldRunId, `${boundary.description} crash must not admit a phantom second run`);
      }
      assert.equal(existsSync(journalPath), false, "restart must consume the completed or abandoned publication journal");
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("missing or corrupt active-run index is repaired before active lookup", () => {
  const root = mkdtempSync(join(tmpdir(), "cto-active-index-repair-"));
  const runId = "repair-active";
  const indexPath = join(root, ".work-state", "cto", CTO_RUN_DELIVERY_INDEX_FILE);
  try {
    const state = fixture(runId);
    persistState(state, root);
    for (const replacement of [null, "{not-json"]) {
      if (replacement === null) rmSync(indexPath, { force: true });
      else writeFileSync(indexPath, replacement);
      // An externally replaced index has no authenticated proof; recovery may
      // rebuild it, while a present proof over different bytes remains fail-closed.
      rmSync(join(root, ".work-state", "cto", CTO_RUN_DELIVERY_INDEX_PROOF_FILE), { force: true });
      assert.equal(findActiveCtoRun(root)?.runId, runId, "lookup must repair the index before admitting a new run");
      const repaired = JSON.parse(readFileSync(indexPath, "utf8")) as {
        active_run_id: string | null;
        entries: Array<{ run_id: string; state_revision: number; status: string }>;
      };
      assert.equal(repaired.active_run_id, runId);
      assert.deepEqual(repaired.entries.map((entry) => ({ run_id: entry.run_id, state_revision: entry.state_revision, status: entry.status })), [
        { run_id: runId, state_revision: 1, status: "active" },
      ]);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("active-run lookup stays authoritative after zero, one, and multiple completed waves", () => {
  const root = mkdtempSync(join(tmpdir(), "cto-active-summary-digest-"));
  const runId = "active-summary-digest";
  try {
    const state = fixture(runId);
    persistState(state, root);
    const pinnedRoot = PinnedProjectRoot.open(root);
    assert.ok(pinnedRoot);
    try {
      for (let completedWaves = 0; completedWaves <= 2; completedWaves += 1) {
        assert.equal(findActiveCtoRun(root)?.runId, runId, `${completedWaves} completed waves must retain the active run`);
        const indexed = readCtoRunDeliveryActiveCandidatesPinned(pinnedRoot);
        assert.equal(indexed.ok, true, `${completedWaves} completed waves must retain readable active candidates`);
        if (indexed.ok) assert.deepEqual(indexed.entries.map((entry) => entry.run_id), [runId]);
        if (completedWaves === 2) break;
        const waveId = `summary-wave-${completedWaves + 1}`;
        const current = readCtoState(runId, root);
        assert.ok(current);
        const appended = appendWave(current, {
          id: waveId,
          source: "test",
          source_id: `${waveId}-source`,
          task: waveId,
          now: `2026-09-11T00:00:0${completedWaves + 1}.000Z`,
        });
        writeCtoState(appended, root, { preCommit: ({ pinnedRoot }) => pinnedRoot.assertStable() });
        const finished = finishWave(appended, {
          id: waveId,
          status: "done",
          now: `2026-09-11T00:00:1${completedWaves + 1}.000Z`,
        });
        persistState(finished, root);
      }
    } finally {
      pinnedRoot.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("persisted wave lifecycle invariants fail closed as one authority record", () => {
  const invalidWaves = [
    {
      id: "wave-active-finished",
      source: "test",
      source_id: "active-finished",
      task: "invalid active",
      slice_ids: [],
      status: "active",
      started_at: new Date(0).toISOString(),
      finished_at: new Date(1_000).toISOString(),
    },
    {
      id: "wave-done-missing",
      source: "test",
      source_id: "done-missing",
      task: "invalid done",
      slice_ids: [],
      status: "done",
      started_at: new Date(0).toISOString(),
    },
    {
      id: "wave-failed-invalid-time",
      source: "test",
      source_id: "failed-invalid-time",
      task: "invalid failed",
      slice_ids: [],
      status: "failed",
      started_at: new Date(0).toISOString(),
      finished_at: "not-a-timestamp",
    },
  ] as const;
  for (const [index, wave] of invalidWaves.entries()) {
    const root = mkdtempSync(join(tmpdir(), `cto-wave-invariant-${index}-`));
    const state = fixture(`wave-invariant-${index}`);
    try {
      const runDir = ctoStateDir(state.id, root);
      mkdirSync(runDir, { recursive: true });
      writeFileSync(join(runDir, "state.json"), JSON.stringify({ ...state, wave_history: [wave] }) + "\n");
      assert.equal(readCtoState(state.id, root), null, "invalid wave lifecycle must reject the whole persisted state");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }

  const validRoot = mkdtempSync(join(tmpdir(), "cto-wave-invariant-valid-"));
  const valid = fixture("wave-invariant-valid");
  try {
    const wave: WaveRecord = {
      id: "wave-valid",
      source: "test",
      source_id: "valid",
      task: "valid wave",
      slice_ids: [],
      status: "done",
      started_at: new Date(0).toISOString(),
      finished_at: new Date(1_000).toISOString(),
    };
    const runDir = ctoStateDir(valid.id, validRoot);
    mkdirSync(runDir, { recursive: true });
    writeFileSync(join(runDir, "state.json"), JSON.stringify({ ...valid, wave_history: [wave] }) + "\n");
    assert.ok(readCtoState(valid.id, validRoot), "valid terminal wave must remain readable");
  } finally {
    rmSync(validRoot, { recursive: true, force: true });
  }
});

test("outbox publisher repairs missing, corrupt, and stale indexes before publishing", async () => {
  const makeInput = (runId: string, revision: number) => {
    const id = `${runId}/wave/publish/ack`;
    const json = JSON.stringify({ id, level: "question", title: "publish", body: "publish", intent: "question", idempotency_key: id });
    return {
      run_id: runId,
      state_revision: revision,
      entry_name: canonicalDurableIdFileName(`${runId}/wave/publish/ack`),
      json,
    };
  };
  for (const mode of ["missing", "corrupt", "stale"] as const) {
    const root = mkdtempSync(join(tmpdir(), `cto-publish-${mode}-`));
    try {
      const runId = `publish-${mode}`;
      const state = fixture(runId);
      persistState(state, root);
      const indexPath = join(root, ".work-state", "cto", CTO_RUN_DELIVERY_INDEX_FILE);
      if (mode === "missing") rmSync(indexPath, { force: true });
      if (mode === "corrupt") writeFileSync(indexPath, "{not-json");
      if (mode === "stale") writeFileSync(indexPath, JSON.stringify({ schema_version: 2, active_run_id: null, entries: [] }) + "\n");
      rmSync(join(root, ".work-state", "cto", CTO_RUN_DELIVERY_INDEX_PROOF_FILE), { force: true });
      const published = publishCtoOutboxDelivery(root, makeInput(runId, state.state_revision as number));
      assert.ok(published, `${mode} index must be repaired before publishing`);
      assert.equal(readCtoRunDeliveryIndexPage(root).entries.find((entry) => entry.run_id === runId)?.pending_outbox, true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }

  const terminalRoot = mkdtempSync(join(tmpdir(), "cto-publish-terminal-"));
  try {
    const terminal = fixture("publish-terminal");
    persistState(terminal, terminalRoot);
    setCtoPause(terminal, "done", "terminal");
    persistState(terminal, terminalRoot);
    assert.equal(
      publishCtoOutboxDelivery(terminalRoot, makeInput(terminal.id, terminal.state_revision as number)),
      null,
      "terminal state must never receive a new outbox delivery",
    );
  } finally {
    rmSync(terminalRoot, { recursive: true, force: true });
  }

  const crashRoot = mkdtempSync(join(tmpdir(), "cto-publish-crash-"));
  try {
    const oldState = fixture("publish-old");
    persistState(oldState, crashRoot);
    const runId = "publish-crash";
    await crashWriterAtBoundary(crashRoot, runId, join(".work-state", "cto", CTO_RUN_DELIVERY_INDEX_FILE));
    const published = publishCtoOutboxDelivery(crashRoot, makeInput(runId, 1));
    assert.ok(published, "publisher must recover a committed state whose index update crashed");
    assert.equal(readCtoRunDeliveryIndexPage(crashRoot).active_run_id, runId, "publisher recovery must expose the recovered active pointer");
  } finally {
    rmSync(crashRoot, { recursive: true, force: true });
  }
});

test("multi-task retry rearming preserves one authenticated delivery index", () => {
  const root = mkdtempSync(join(tmpdir(), "cto-publish-multi-retry-"));
  try {
    const state = { ...fixture("publish-multi-retry"), owner_session: "core-state-revision-test" };
    const origin = PinnedProjectRoot.open(root);
    assert.ok(origin);
    try {
      assert.equal(mintCtoRuntimeRunOrigin(origin, state, "core-state-revision-test", "state-revision", ctoRuntimeRunInitialIdentityDigest(state)), true);
    } finally { origin.close(); }
    persistState(state, root);
    const inputs = ["first", "second"].map((task) => {
      const id = `${state.id}/wave/retry/${task}`;
      const json = JSON.stringify({ id, level: "question", title: task, body: task, intent: "question", idempotency_key: id });
      return { run_id: state.id, state_revision: state.state_revision as number, entry_name: canonicalDurableIdFileName(id), json };
    });
    for (const input of inputs) {
      const published = publishCtoOutboxDelivery(root, input);
      assert.ok(published, `${input.entry_name} first publication succeeds`);
      const retryPath = join(root, ".work-state", "cto", state.id, "outbox-retry", input.entry_name);
      mkdirSync(dirname(retryPath), { recursive: true });
      renameSync(published!, retryPath);
      assert.equal(publishCtoOutboxDelivery(root, input), null, `${input.entry_name} retry is deduped and re-arms retry authority`);
    }
    const page = readCtoRunDeliveryIndexPage(root);
    const entry = page.entries.find((candidate) => candidate.run_id === state.id);
    assert.ok(entry, "multi-task retry keeps the run in the pending page");
    assert.equal(entry?.pending_outbox, true, "outbox authority remains pending across retry rearming");
    assert.equal(entry?.pending_retry, true, "retry authority is retained across both tasks");
    const pinned = PinnedProjectRoot.open(root);
    assert.ok(pinned);
    try {
      assert.equal(readCtoRunDeliveryIndexAuthorityPinned(pinned).authenticated, true, "retry rearming republishes an authenticated index proof");
    } finally { pinned.close(); }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("outbox publisher rejects forged envelopes and preserves index on authority failures", () => {
  const root = mkdtempSync(join(tmpdir(), "cto-publish-authority-"));
  const state = fixture("publish-authority");
  state.channel_profile = { direction: "rw", adapter: "telegram", ackTarget: "chat-expected", primary: true };
  try {
    persistState(state, root);
    const indexPath = join(root, ".work-state", "cto", CTO_RUN_DELIVERY_INDEX_FILE);
    const beforeIndex = readFileSync(indexPath);
    const id = `${state.id}/wave/authority/question`;
    const input = (json: string, revision = state.state_revision as number) => ({
      run_id: state.id,
      state_revision: revision,
      entry_name: canonicalDurableIdFileName(id),
      json,
    });
    const canonical = (patch: Record<string, unknown> = {}) => JSON.stringify({
      id,
      level: "question",
      title: "authority",
      body: "authority",
      intent: "question",
      idempotency_key: id,
      ...patch,
    });
    const rejected = [
      input(JSON.stringify({ id, level: "question", title: "forged", body: "forged" })),
      input(canonical({ id: `${state.id}/wave/authority/foreign` })),
      input(canonical({ target: "chat-forged" })),
      input(canonical({ intent: "summary", topic: "summary" })),
      input(canonical(), (state.state_revision as number) + 1),
    ];
    for (const candidate of rejected) {
      assert.equal(rawPublishCtoOutboxDelivery(root, candidate), null, "authority failure must reject before publication");
      assert.equal(existsSync(join(root, ".work-state", "cto", state.id, "outbox")), false, "rejected delivery must not create an outbox");
      assert.deepEqual(readFileSync(indexPath), beforeIndex, "rejected delivery must not mutate the delivery index");
    }
    const valid = input(canonical({ target: "chat-expected" }));
    const published = publishCtoOutboxDelivery(root, valid);
    assert.ok(published, "canonical queued delivery publishes");
    assert.equal(publishCtoOutboxDelivery(root, valid), null, "replay remains idempotent");
    const queued = readdirSync(join(root, ".work-state", "cto", state.id, "outbox")).filter((name) => name.endsWith(".json"));
    assert.deepEqual(queued, [valid.entry_name], "one canonical delivery remains queued");
    assert.equal(readCtoRunDeliveryIndexPage(root).entries.find((entry) => entry.run_id === state.id)?.pending_outbox, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("sent archives never suppress active publication or pending authority", () => {
  const cases = [
    { label: "canonical-same", useLegacy: false, conflict: false },
    { label: "canonical-conflict", useLegacy: false, conflict: true },
    { label: "legacy-same", useLegacy: true, conflict: false },
    { label: "legacy-conflict", useLegacy: true, conflict: true },
  ] as const;
  for (const { label, useLegacy, conflict } of cases) {
    const root = mkdtempSync(join(tmpdir(), `cto-sent-archive-${label}-`));
    const state = fixture(`sent-archive-${label}`);
    try {
      persistState(state, root);
      const id = `${state.id}/wave/publication/question`;
      const json = JSON.stringify({ id, level: "question", title: "publication", body: "publication", intent: "question", idempotency_key: id });
      const entryName = canonicalDurableIdFileName(id);
      const legacyEntryName = legacyDurableIdFileName(id);
      const sentEntryName = useLegacy ? legacyEntryName : entryName;
      const sentPath = join(root, ".work-state", "cto", state.id, "outbox", "sent", sentEntryName);
      mkdirSync(dirname(sentPath), { recursive: true });
      const sentJson = conflict ? JSON.stringify({ id, level: "question", title: "foreign", body: "foreign", intent: "question", idempotency_key: id }) : json;
      writeFileSync(sentPath, sentJson);
      const publicationInput = {
        run_id: state.id,
        state_revision: state.state_revision as number,
        entry_name: entryName,
        ...(useLegacy ? { legacy_entry_name: legacyEntryName } : {}),
        json,
      };
      const published = publishCtoOutboxDelivery(root, publicationInput);
      assert.ok(published, `${label} sent archive entry must not suppress active publication`);
      assert.equal(readFileSync(published!, "utf8"), publicationInput.json, `${label} active publication must preserve authenticated bytes`);
      assert.equal(readFileSync(sentPath, "utf8"), sentJson, `${label} sent archive must remain untouched`);
      assert.equal(readCtoRunDeliveryIndexPage(root).entries.find((entry) => entry.run_id === state.id)?.pending_outbox, true, `${label} publication must arm pending_outbox`);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

test("terminal summaries use at-least-once transport, replay-safe authority, and reject late questions", () => {
  for (const [waveStatus, integrationStatus, pauseKind] of [
    ["done", "done", "done"],
    ["failed", "failed", "failed"],
  ] as const) {
    const root = mkdtempSync(join(tmpdir(), `cto-terminal-summary-${waveStatus}-`));
    try {
      const state = fixture(`terminal-summary-${waveStatus}`);
      const waveId = `wave-${waveStatus}`;
      const wave: WaveRecord = {
        id: waveId,
        source: "test",
        source_id: `${state.id}-source`,
        task: "terminal summary",
        slice_ids: [],
        status: waveStatus,
        outcome: waveStatus === "done" ? "pass" : "blocked",
        started_at: new Date(0).toISOString(),
        finished_at: new Date(1_000).toISOString(),
      };
      state.wave_history = [wave];
      state.integration = { status: integrationStatus };
      persistState(state, root);
      setCtoPause(state, pauseKind, "terminal");
      persistState(state, root);

      const summary = buildCtoTerminalSummaryEnvelope(state, wave);
      const summaryId = summary.id;
      let summaryJson = JSON.stringify(summary);
      const summaryInput = {
        run_id: state.id,
        state_revision: state.state_revision as number,
        entry_name: canonicalDurableIdFileName(summaryId),
        json: summaryJson,
      };
      const sentPath = join(root, ".work-state", "cto", state.id, "outbox", "sent", summaryInput.entry_name);
      mkdirSync(dirname(sentPath), { recursive: true });
      writeFileSync(sentPath, "{}");
      assert.equal(acknowledgeCtoRunDelivery(root, state.id, summaryInput.state_revision, { drained: true }), false, "forged sent bytes cannot clear a terminal run");
      assert.equal(existsSync(sentPath), true, "forged sent evidence must not be removed by failed acknowledgement");
      const missingIdempotencyKey = JSON.stringify(Object.fromEntries(Object.entries(summary).filter(([key]) => key !== "idempotency_key")));
      const foreignIdempotencyKey = JSON.stringify({ ...summary, idempotency_key: `${summaryId}-other` });
      for (const [label, json] of [["missing", missingIdempotencyKey], ["foreign", foreignIdempotencyKey]] as const) {
        assert.equal(
          rawPublishCtoOutboxDelivery(root, { ...summaryInput, json }),
          null,
          `terminal summary with ${label} idempotency key must be rejected`,
        );
      }
      const lateQuestionId = `${state.id}/wave/${waveId}/question`;
      const lateQuestionJson = JSON.stringify({
        id: lateQuestionId,
        level: "question",
        title: "late question",
        body: "must be rejected",
        intent: "question",
        topic: "question",
      });
      assert.equal(
        rawPublishCtoOutboxDelivery(root, {
          ...summaryInput,
          entry_name: canonicalDurableIdFileName(lateQuestionId),
          json: lateQuestionJson,
        }),
        null,
        "terminal runs reject late direct questions",
      );

      const published = publishCtoOutboxDelivery(root, summaryInput);
      summaryJson = String(summaryInput.json);
      assert.ok(published, "terminal wave summary is publishable despite sent archive collision");
      assert.equal(readFileSync(published!, "utf8"), summaryJson, "active publication preserves authenticated summary bytes");
      assert.equal(readFileSync(sentPath, "utf8"), "{}", "sent archive collision remains untouched");
      assert.equal(readCtoRunDeliveryIndexPage(root).entries.find((entry) => entry.run_id === state.id)?.pending_outbox, true, "active publication arms pending_outbox");
      assert.equal(acknowledgeCtoRunDelivery(root, state.id, summaryInput.state_revision, { drained: true }), false, "active publication remains pending until it is archived");
      const activeRetryPath = join(root, ".work-state", "cto", state.id, "outbox", "r1a.json");
      mkdirSync(dirname(activeRetryPath), { recursive: true });
      renameSync(published!, activeRetryPath);
      assert.equal(publishCtoOutboxDelivery(root, summaryInput), null, "a summary already promoted under a retry filename must not be requeued");
      assert.equal(existsSync(activeRetryPath), true, "promoted retry envelope remains untouched");
      rmSync(activeRetryPath, { force: true });
      const republished = publishCtoOutboxDelivery(root, summaryInput);
      assert.ok(republished, "summary can be republished after its retry copy is drained");
      const retryPath = join(root, ".work-state", "cto", state.id, "outbox-retry", "r1.json");
      mkdirSync(dirname(retryPath), { recursive: true });
      renameSync(republished!, retryPath);
      assert.equal(publishCtoOutboxDelivery(root, summaryInput), null, "a summary already present under a retry filename must not be requeued");
      assert.equal(existsSync(retryPath), true, "retry envelope remains untouched");
      rmSync(retryPath, { force: true });
      assert.equal(acknowledgeCtoRunDelivery(root, state.id, summaryInput.state_revision, { drained: true }), false, "pending summary cannot be acknowledged before delivery");

      assert.equal(removeCtoOutboxDeliveryObligation(root, state.id, summaryInput.entry_name, summaryId), true, "transport completion clears the exact summary obligation");
      const clearedSummaryState = readCtoState(state.id, root);
      assert.ok(clearedSummaryState);
      summaryInput.state_revision = clearedSummaryState!.state_revision as number;
      summaryJson = JSON.stringify({ ...JSON.parse(summaryJson) as Record<string, unknown>, state_revision: summaryInput.state_revision });
      summaryInput.json = summaryJson;
      mkdirSync(dirname(sentPath), { recursive: true });
      writeFileSync(sentPath, summaryJson);
      rmSync(published!, { force: true });
      const originalReadFile = PinnedProjectRoot.prototype.readFile;
      let replacedAfterRead = false;
      PinnedProjectRoot.prototype.readFile = function(relativeFile, options) {
        const result = originalReadFile.call(this, relativeFile, options);
        if (!replacedAfterRead && relativeFile.endsWith(`/sent/${summaryInput.entry_name}`)) {
          replacedAfterRead = true;
          writeFileSync(sentPath, "{}");
        }
        return result;
      };
      try {
        assert.equal(acknowledgeCtoRunDelivery(root, state.id, summaryInput.state_revision, { drained: true }), false, "sent replacement after anchored read must fail closed");
      } finally {
        PinnedProjectRoot.prototype.readFile = originalReadFile;
      }
      assert.equal(replacedAfterRead, true, "sent replacement hook must observe the canonical sent read");
      assert.equal(existsSync(sentPath), true, "failed acknowledgement must not remove forged sent bytes");
      writeFileSync(sentPath, summaryJson);
      assert.equal(acknowledgeCtoRunDelivery(root, state.id, summaryInput.state_revision, { drained: true }), true, "terminal summary acknowledgement requires durable sent evidence");
      assert.equal(rawPublishCtoOutboxDelivery(root, summaryInput), null, "acknowledged terminal summary replay is suppressed by pending_summary authority");
      const replayIndex = JSON.parse(readFileSync(join(root, ".work-state", "cto", CTO_RUN_DELIVERY_INDEX_FILE), "utf8")) as {
        entries: Array<{ run_id: string; pending_summary: boolean; pending_outbox: boolean }>;
      };
      const replayEntry = replayIndex.entries.find((entry) => entry.run_id === state.id);
      assert.ok(replayEntry, "acknowledged terminal run remains in bounded summary cache");
      assert.equal(replayEntry?.pending_summary, false, "index pending_summary=false blocks terminal summary replay");
      assert.equal(readCtoRunDeliveryIndexPage(root).entries.some((entry) => entry.run_id === state.id), false, "acknowledged summary is absent from the pending index");
      assert.equal(replayEntry?.pending_outbox, false, "acknowledged terminal summary does not re-arm outbox delivery");
      assert.equal(existsSync(sentPath), true, "sent terminal summary remains durable archive evidence");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

test("legacy terminal summaries in sent remain advisory to active publication", () => {
  const root = mkdtempSync(join(tmpdir(), "cto-terminal-summary-legacy-"));
  const state = fixture("terminal-summary-legacy");
  const waveId = "wave-legacy";
  try {
    const wave: WaveRecord = {
      id: waveId,
      source: "test",
      source_id: `${state.id}-source`,
      task: "legacy terminal summary",
      slice_ids: [],
      status: "done",
      outcome: "pass",
      started_at: new Date(0).toISOString(),
      finished_at: new Date(1_000).toISOString(),
    };
    state.wave_history = [wave];
    persistState(state, root);
    setCtoPause(state, "done", "terminal");
    persistState(state, root);

    const summary = buildCtoTerminalSummaryEnvelope(state, wave);
    const summaryId = summary.id;
    let summaryJson = JSON.stringify(summary);
    const entryName = canonicalDurableIdFileName(summaryId);
    const legacyEntryName = legacyDurableIdFileName(summaryId);
    assert.notEqual(entryName, legacyEntryName);
    const legacyPath = join(root, ".work-state", "cto", state.id, "outbox", "sent", legacyEntryName);
    mkdirSync(dirname(legacyPath), { recursive: true });
    writeFileSync(legacyPath, summaryJson);

    const input = {
      run_id: state.id,
      state_revision: state.state_revision as number,
      entry_name: entryName,
      legacy_entry_name: legacyEntryName,
      json: summaryJson,
    };
    const published = publishCtoOutboxDelivery(root, input);
    summaryJson = String(input.json);
    assert.ok(published, "exact legacy sent evidence must not suppress active publication");
    assert.equal(readFileSync(published!, "utf8"), summaryJson, "active publication preserves the authenticated bytes");
    const canonicalPath = join(root, ".work-state", "cto", state.id, "outbox", "sent", entryName);
    assert.equal(existsSync(canonicalPath), false, "legacy sent evidence is not migrated by the publisher");
    renameSync(published!, canonicalPath);
    assert.equal(removeCtoOutboxDeliveryObligation(root, state.id, entryName, summaryId), true, "legacy summary transport clears the exact obligation");
    const clearedState = readCtoState(state.id, root);
    assert.ok(clearedState);
    input.state_revision = clearedState!.state_revision as number;
    summaryJson = JSON.stringify({ ...JSON.parse(summaryJson) as Record<string, unknown>, state_revision: input.state_revision });
    input.json = summaryJson;
    writeFileSync(canonicalPath, summaryJson);
    assert.equal(acknowledgeCtoRunDelivery(root, state.id, input.state_revision, { drained: true }), true, "durable canonical sent evidence unblocks terminal acknowledgement");
    const replayed = rawPublishCtoOutboxDelivery(root, input);
    assert.equal(replayed, null, "acknowledged terminal summary replay is suppressed by pending_summary authority");
    assert.equal(readFileSync(canonicalPath, "utf8"), summaryJson, "replay does not replace canonical sent bytes");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("legacy aliases are advisory: mismatches do not block canonical publication", () => {
  for (const [label, mutate] of [
    ["payload", (summary: CtoTerminalSummaryEnvelope) => ({ ...summary, body: "tampered" })],
    ["identity", (summary: CtoTerminalSummaryEnvelope) => ({ ...summary, id: `${summary.id}-other` })],
  ] as const) {
    const root = mkdtempSync(join(tmpdir(), `cto-terminal-summary-legacy-${label}-`));
    const state = fixture(`terminal-summary-legacy-${label}`);
    const waveId = "wave-legacy";
    try {
      const wave: WaveRecord = {
        id: waveId,
        source: "test",
        source_id: `${state.id}-source`,
        task: "legacy terminal summary",
        slice_ids: [],
        status: "done",
        outcome: "pass",
        started_at: new Date(0).toISOString(),
        finished_at: new Date(1_000).toISOString(),
      };
      state.wave_history = [wave];
      persistState(state, root);
      setCtoPause(state, "done", "terminal");
      persistState(state, root);
      const summary = buildCtoTerminalSummaryEnvelope(state, wave);
      const summaryId = summary.id;
      const expectedJson = JSON.stringify(summary);
      const legacyEntryName = legacyDurableIdFileName(summaryId);
      const legacyPath = join(root, ".work-state", "cto", state.id, "outbox", "sent", legacyEntryName);
      const mismatchedJson = JSON.stringify(mutate(summary));
      mkdirSync(dirname(legacyPath), { recursive: true });
      writeFileSync(legacyPath, mismatchedJson);
      const entryName = canonicalDurableIdFileName(summaryId);
      const publicationInput = {
        run_id: state.id,
        state_revision: state.state_revision as number,
        entry_name: entryName,
        legacy_entry_name: legacyEntryName,
        json: expectedJson,
      };
      const published = publishCtoOutboxDelivery(root, publicationInput);
      const boundJson = String(publicationInput.json);
      assert.ok(published, `${label} mismatch must not block canonical publication`);
      assert.equal(readFileSync(published!, "utf8"), boundJson, `${label} canonical payload is exact`);
      assert.equal(readFileSync(legacyPath, "utf8"), mismatchedJson, `${label} legacy record is never overwritten`);
      rmSync(published!, { force: true });

      const canonicalSentPath = join(root, ".work-state", "cto", state.id, "outbox", "sent", entryName);
      writeFileSync(canonicalSentPath, mismatchedJson);
      const republished = publishCtoOutboxDelivery(root, publicationInput);
      assert.ok(republished, `${label} sent collision must not suppress active publication`);
      assert.equal(readFileSync(republished!, "utf8"), String(publicationInput.json), `${label} active publication preserves the authenticated bytes`);
      assert.equal(readFileSync(canonicalSentPath, "utf8"), mismatchedJson, "canonical sent collision is never overwritten");
      rmSync(republished!, { force: true });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

test("legacy alias collisions never block canonical publication in active, sent, or retry lanes", () => {
  const lanes = ["active", "sent", "retry"] as const;
  const orders = ["slash-first", "canonical-first"] as const;
  for (const lane of lanes) {
    for (const order of orders) {
      const root = mkdtempSync(join(tmpdir(), `cto-legacy-alias-${lane}-${order}-`));
      const state = fixture("run");
      try {
        persistState(state, root);
        const slashId = "run/a";
        const canonicalId = "run/b";
        const inputFor = (id: string) => {
          const json = JSON.stringify({ id, level: "question", title: id, body: id, intent: "question", idempotency_key: id });
          return {
            run_id: state.id,
            state_revision: state.state_revision as number,
            entry_name: canonicalDurableIdFileName(id),
            legacy_entry_name: legacyDurableIdFileName(id),
            json,
          };
        };
        const firstId = order === "slash-first" ? slashId : canonicalId;
        const secondId = order === "slash-first" ? canonicalId : slashId;
        const firstInput = inputFor(firstId);
        const secondInput = inputFor(secondId);
        const firstPublished = publishCtoOutboxDelivery(root, firstInput);
        assert.ok(firstPublished, `${lane}/${order}: first canonical delivery publishes`);
        if (lane !== "active") {
          const target = lane === "sent"
            ? join(root, ".work-state", "cto", state.id, "outbox", "sent", firstInput.entry_name)
            : join(root, ".work-state", "cto", state.id, "outbox-retry", firstInput.entry_name);
          mkdirSync(dirname(target), { recursive: true });
          renameSync(firstPublished!, target);
        }
        const secondPublished = publishCtoOutboxDelivery(root, secondInput);
        assert.ok(secondPublished, `${lane}/${order}: alias occupancy does not block the second canonical delivery`);
        assert.notEqual(firstInput.entry_name, secondInput.entry_name, `${lane}/${order}: canonical names are distinct`);
        assert.equal(JSON.parse(readFileSync(secondPublished!, "utf8")).id, secondId, `${lane}/${order}: second payload retains its exact identity`);
        assert.equal(publishCtoOutboxDelivery(root, secondInput), null, `${lane}/${order}: replay remains deduped`);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    }
  }
});
test("CTO close preserves a stale team update without reopening the terminal wave", async () => {
  const root = mkdtempSync(join(tmpdir(), "cto-close-team-barrier-"));
  const runId = "close-team-barrier";
  let worker: ReturnType<typeof spawn> | undefined;
  try {
    const initial = fixture(runId);
    initial.plan.teams = [{ team: "team-a", role: "developer", depends_on: [] }];
    initial.teams = [{ id: "team-a", status: "pending", escalations: {} }];
    persistState(initial, root);

    const delay = (ms: number): Promise<void> => {
      const { promise, resolve } = Promise.withResolvers<void>();
      setTimeout(resolve, ms);
      return promise;
    };
    worker = spawn(
      process.execPath,
      ["--import", "tsx", "--input-type=module", "-e", `
        import { existsSync, writeFileSync } from "node:fs";
        import { join } from "node:path";
        import { readCtoState, setTeamStatus, writeCtoState } from "./src/cto/state.ts";
        const root = process.env.CTO_ROOT;
        const runId = process.env.CTO_RUN_ID;
        if (!root || !runId) throw new Error("missing close/team barrier environment");
        const state = readCtoState(runId, root);
        if (!state) throw new Error("close/team barrier state is missing");
        writeFileSync(join(root, "team-ready"), "ready");
        while (!existsSync(join(root, "team-go"))) await new Promise((resolve) => setTimeout(resolve, 5));
        setTeamStatus(state, "team-a", "done");
        try {
          persistState(state, root);
        } catch {
          // The close transaction may win the CAS while this worker is parked;
          // retry the same in-memory transition against the fresh canonical image.
          const latest = readCtoState(runId, root);
          if (!latest) throw new Error("close/team barrier state disappeared");
          setTeamStatus(latest, "team-a", "done");
          writeCtoState(latest, root, { preCommit: ({ pinnedRoot }) => pinnedRoot.assertStable() });
        }
        writeFileSync(join(root, "team-done"), "done");
      `],
      {
        cwd: resolve(dirname(fileURLToPath(import.meta.url)), ".."),
        env: { ...process.env, CTO_ROOT: root, CTO_RUN_ID: runId },
        stdio: ["ignore", "ignore", "pipe"],
      },
    );
    let stderr = "";
    const exitResolvers = Promise.withResolvers<number>();
    worker.stderr?.on("data", (chunk: Buffer) => { stderr += String(chunk); });
    worker.once("error", exitResolvers.reject);
    worker.once("exit", (code) => exitResolvers.resolve(code ?? 1));
    const exit = exitResolvers.promise;
    for (let i = 0; i < 2_000 && !existsSync(join(root, "team-ready")); i += 1) {
      await delay(5);
    }
    assert.equal(existsSync(join(root, "team-ready")), true, "team update must snapshot before close");

    const close = readCtoState(runId, root);
    assert.ok(close);
    setCtoPause(close!, "done", "wave closed");
    persistState(close!, root);
    writeFileSync(join(root, "team-go"), "go");
    assert.equal(await exit, 0, stderr);
    assert.equal(existsSync(join(root, "team-done")), true, "team update must complete after the close barrier");

    const canonical = readCtoState(runId, root);
    assert.equal(canonical?.pause.kind, "done", "a stale team update cannot reopen a closed wave");
    assert.equal(canonical?.teams.find((team) => team.id === "team-a")?.status, "done", "the concurrent team field is retained");
    assert.equal(canonical?.state_revision, 3, "close and team update each advance the canonical revision");
  } finally {
    if (worker && worker.exitCode === null) worker.kill();
    rmSync(root, { recursive: true, force: true });
  }
});

test("active-run index CAS preserves a concurrent interloper", () => {
  const root = mkdtempSync(join(tmpdir(), "cto-active-index-cas-"));
  const state = fixture("active-index-cas");
  try {
    persistState(state, root);
    const indexPath = join(root, ".work-state", "cto", CTO_RUN_DELIVERY_INDEX_FILE);
    const replacement = JSON.stringify({
      schema_version: 2,
      active_run_id: "interloper",
      entries: [{ run_id: "interloper", state_revision: 7, status: "active", updated_at: new Date().toISOString(), pending_summary: false, pending_outbox: false }],
    }) + "\n";
    let injected = false;
    const pinned = PinnedProjectRoot.open(root, {
      beforeConditionalCommit: (relativePath) => {
        if (!injected && relativePath === join(".work-state", "cto", CTO_RUN_DELIVERY_INDEX_FILE)) {
          writeFileSync(indexPath, replacement);
          injected = true;
        }
      },
    }, root);
    assert.ok(pinned);
    try {
      const next = readCtoState(state.id, root);
      assert.ok(next);
      assert.throws(
        () => writeCtoState(next!, root, { preCommit: ({ pinnedRoot }) => pinnedRoot.assertStable(), pinnedRoot: pinned }),
        (error: unknown) => error instanceof PinnedRootError && error.code === "changed",
      );
      assert.equal(injected, true, "the deterministic index interleaving must run");
      assert.equal(readFileSync(indexPath, "utf8"), replacement, "the concurrent index winner must survive");
    } finally {
      pinned.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("outbox publish holds the index lock across mark and write", async () => {
  const root = mkdtempSync(join(tmpdir(), "cto-outbox-publish-race-"));
  const state = fixture("publish-race");
  const markerPath = join(root, "publish-marked");
  const ackStartedPath = join(root, "ack-started");
  const ackResultPath = join(root, "ack-result");
  let worker: ReturnType<typeof spawn> | undefined;
  try {
    persistState(state, root);
    worker = spawn(
      process.execPath,
      ["--import", "tsx", "--input-type=module", "-e", `
        import { existsSync, writeFileSync } from "node:fs";
        import { join } from "node:path";
        import { acknowledgeCtoRunDelivery } from "./src/cto/state.ts";
        const root = process.env.CTO_ROOT;
        const revision = Number(process.env.CTO_REVISION);
        if (!root || !Number.isSafeInteger(revision)) throw new Error("missing publish race environment");
        while (!existsSync(join(root, "publish-marked"))) await new Promise((resolve) => setTimeout(resolve, 5));
        writeFileSync(join(root, "ack-started"), "started");
        const acknowledged = acknowledgeCtoRunDelivery(root, "publish-race", revision, { drained: true });
        writeFileSync(join(root, "ack-result"), String(acknowledged));
      `],
      {
        cwd: resolve(dirname(fileURLToPath(import.meta.url)), ".."),
        env: { ...process.env, CTO_ROOT: root, CTO_REVISION: String(state.state_revision) },
        stdio: ["ignore", "ignore", "pipe"],
      },
    );
    let stderr = "";
    worker.stderr?.on("data", (chunk: Buffer) => { stderr += String(chunk); });
    const exit = new Promise<number>((resolveExit, reject) => {
      worker!.once("error", reject);
      worker!.once("exit", (code) => resolveExit(code ?? 1));
    });
    const publicationInput = {
      run_id: state.id,
      state_revision: state.state_revision as number,
      entry_name: canonicalDurableIdFileName("publish-race/1"),
      json: JSON.stringify({ id: "publish-race/1", level: "question", title: "race", body: "race", intent: "question", idempotency_key: "publish-race/1" }),
    };
    const trusted = trustedAccess(root);
    const obligation = trusted.access.recordOutboxDeliveryObligation({ run_id: publicationInput.run_id, entry_name: publicationInput.entry_name, json: publicationInput.json });
    assert.ok(obligation);
    publicationInput.state_revision = obligation!.state_revision;
    publicationInput.json = Buffer.from(obligation!.json).toString("utf8");
    setCtoRunDeliveryTestHooks({
      afterPendingMark: () => {
        writeFileSync(markerPath, "marked");
        const waitBuffer = new Int32Array(new SharedArrayBuffer(4));
        for (let i = 0; i < 2_000 && !existsSync(ackStartedPath); i += 1) Atomics.wait(waitBuffer, 0, 0, 5);
      },
    }, root);
    let published: string | null = null;
    try {
      published = trusted.access.publishOutboxDelivery(publicationInput);
    } finally {
      setCtoRunDeliveryTestHooks(null, root);
      trusted.release();
    }
    assert.ok(published, "outbox file is published");
    assert.equal(await exit, 0, stderr);
    assert.equal(readFileSync(ackResultPath, "utf8"), "false", "ack cannot clear a marker while publish still owns the index lock");
    const pending = readCtoRunDeliveryIndexPage(root);
    assert.equal(pending.entries.find((entry) => entry.run_id === state.id)?.pending_outbox, true);
    rmSync(published!, { force: true });
    assert.equal(removeCtoOutboxDeliveryObligation(root, state.id, publicationInput.entry_name, "publish-race/1"), true);
    const drainedState = readCtoState(state.id, root);
    assert.ok(drainedState);
    assert.equal(acknowledgeCtoRunDelivery(root, state.id, drainedState!.state_revision, { drained: true }), true);
    assert.equal(readCtoRunDeliveryIndexPage(root).entries.length, 0);
  } finally {
    setCtoRunDeliveryTestHooks(null, root);
    if (worker && worker.exitCode === null) worker.kill();
    rmSync(root, { recursive: true, force: true });
  }
});

test("outbox publish write failure leaves index flags unchanged", () => {
  const root = mkdtempSync(join(tmpdir(), "cto-outbox-publish-failure-"));
  const state = fixture("publish-failure");
  try {
    persistState(state, root);
    const failedId = `${state.id}/failed`;
    const failedEntryName = canonicalDurableIdFileName(failedId);
    const target = join(root, ".work-state", "cto", state.id, "outbox", failedEntryName);
    mkdirSync(target, { recursive: true });
    const failureInput = {
      run_id: state.id,
      state_revision: state.state_revision as number,
      entry_name: failedEntryName,
      json: JSON.stringify({ id: failedId, level: "question", title: "failed", body: "failed", intent: "question", idempotency_key: failedId }),
    };
    const trusted = trustedAccess(root);
    const failureObligation = trusted.access.recordOutboxDeliveryObligation({ run_id: failureInput.run_id, entry_name: failureInput.entry_name, json: failureInput.json });
    assert.ok(failureObligation);
    failureInput.state_revision = failureObligation!.state_revision;
    failureInput.json = Buffer.from(failureObligation!.json).toString("utf8");
    assert.equal(trusted.access.publishOutboxDelivery(failureInput), null);
    trusted.release();
    assert.equal(readCtoRunDeliveryIndexPage(root).entries.find((entry) => entry.run_id === state.id)?.pending_outbox, true, "the obligation remains pending when outbox publication fails");
    assert.equal(acknowledgeCtoRunDelivery(root, state.id, failureInput.state_revision, { drained: true }), false, "a failed target is not considered drained");
    rmSync(target, { recursive: true, force: true });
    assert.equal(removeCtoOutboxDeliveryObligation(root, state.id, failureInput.entry_name, failedId), true);
    const drainedState = readCtoState(state.id, root);
    assert.ok(drainedState);
    assert.equal(acknowledgeCtoRunDelivery(root, state.id, drainedState!.state_revision, { drained: true }), true);
    assert.equal(readCtoRunDeliveryIndexPage(root).entries.length, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("outbox publish index-mark failure leaves a durable envelope for recovery", () => {
  const root = mkdtempSync(join(tmpdir(), "cto-outbox-mark-failure-"));
  const state = fixture("outbox-mark-failure");
  const indexPath = join(".work-state", "cto", CTO_RUN_DELIVERY_INDEX_FILE);
  let injected = false;
  try {
    persistState(state, root);
    const input = {
      run_id: state.id,
      state_revision: state.state_revision as number,
      entry_name: canonicalDurableIdFileName("outbox-mark-failure/message"),
      json: JSON.stringify({ id: "outbox-mark-failure/message", level: "question", title: "mark failure", body: "recover", intent: "question", idempotency_key: "outbox-mark-failure/message" }),
    };
    const trusted = trustedAccess(root);
    const obligation = trusted.access.recordOutboxDeliveryObligation({ run_id: input.run_id, entry_name: input.entry_name, json: input.json });
    assert.ok(obligation);
    input.state_revision = obligation!.state_revision;
    input.json = Buffer.from(obligation!.json).toString("utf8");
    setCtoRunDeliveryTestHooks({
      beforePendingMark: () => {
        injected = true;
        throw new PinnedRootError("write_failed", "injected index publication failure");
      },
    }, root);
    assert.throws(() => trusted.access.publishOutboxDelivery(input), /injected index publication failure/u);
    setCtoRunDeliveryTestHooks(null, root);
    assert.equal(injected, true, "the index-mark failure injection must run");
    const outboxPath = join(root, ".work-state", "cto", state.id, "outbox", input.entry_name);
    assert.equal(readFileSync(outboxPath, "utf8"), input.json, "the durable envelope survives an index-mark failure");
    const recoveredPage = readCtoRunDeliveryIndexPage(root);
    assert.equal(recoveredPage.entries.find((entry) => entry.run_id === state.id)?.pending_outbox, true, "state-owned obligation remains pending after an index-mark failure");
    const recoveredRoot = PinnedProjectRoot.open(root);
    assert.ok(recoveredRoot);
    if (recoveredRoot) {
      try {
        const candidates = readCtoRunDeliveryActiveCandidatesPinned(recoveredRoot);
        assert.equal(candidates.ok, true);
        if (candidates.ok) assert.equal(candidates.entries.find((entry) => entry.run_id === state.id)?.pending_outbox, true, "active candidate reader preserves the obligation marker");
      } finally {
        recoveredRoot.close();
      }
    }
    assert.equal(trusted.access.publishOutboxDelivery(input), null, "the durable envelope is not duplicated on retry");
    trusted.release();
    rmSync(outboxPath, { force: true });
    assert.equal(removeCtoOutboxDeliveryObligation(root, state.id, input.entry_name, "outbox-mark-failure/message"), true);
    const drainedState = readCtoState(state.id, root);
    assert.ok(drainedState);
    assert.equal(acknowledgeCtoRunDelivery(root, state.id, drainedState!.state_revision, { drained: true }), true, "draining the recovered envelope permits exact acknowledgement");
    assert.deepEqual(readCtoRunDeliveryIndexPage(root).entries, [], "the recovered envelope is not redelivered after acknowledgement");
  } finally {
    setCtoRunDeliveryTestHooks(null, root);
    rmSync(root, { recursive: true, force: true });
  }
});

test("active-run index serializes concurrent run-lock writers and removes one finished run", async () => {
  const root = mkdtempSync(join(tmpdir(), "cto-active-index-concurrent-"));
  const runIds = ["index-run-a", "index-run-b"] as const;
  const workers = runIds.map((runId) => spawn(
    process.execPath,
    ["--import", "tsx", "--input-type=module", "-e", `
      import { existsSync, writeFileSync } from "node:fs";
      import { join } from "node:path";
      import { PinnedProjectRoot } from "./src/specification/pinned-root.ts";
      import { ctoRuntimeRunInitialIdentityDigest, mintCtoRuntimeRunOrigin, newCtoState, writeCtoState } from "./src/cto/state.ts";
      const root = process.env.CTO_ROOT;
      const runId = process.env.CTO_RUN_ID;
      if (!root || !runId) throw new Error("missing active-index worker environment");
      writeFileSync(join(root, runId + ".ready"), "ready");
      while (!existsSync(join(root, "go"))) await new Promise((resolve) => setTimeout(resolve, 5));
      const state = newCtoState({ id: runId, task: runId, branch: "main", autonomous: false, owner_session: "core-state-revision-test", plan: { id: runId, task: runId, teams: [], created_at: "" } });
      state.work_identity = {
        run_id: runId,
        wave_id: "wave-active-index",
        slice_id: "slice-active-index",
        session_id: "core-state-revision-test",
        workflow: "standard",
        stage_id: "state-revision",
        stage_cursor: "state-revision",
        capability_id: "capability-active-index",
        capability_epoch: "epoch-active-index",
        slot_id: "active-index",
        task_id: "task-active-index",
        dispatch_id: "dispatch-active-index",
        attempt: 1,
        worker_id: "worker-active-index",
      };
      const pinned = PinnedProjectRoot.open(root);
      if (!pinned) throw new Error("active-index worker root could not be pinned");
      if (!mintCtoRuntimeRunOrigin(pinned, state, "core-state-revision-test", "state-revision-test", ctoRuntimeRunInitialIdentityDigest(state))) throw new Error("active-index worker origin publication failed");
      writeCtoState(state, root, { pinnedRoot: pinned, preCommit: ({ pinnedRoot }) => pinnedRoot.assertStable() });
      pinned.close();
    `],
    {
      cwd: resolve(dirname(fileURLToPath(import.meta.url)), ".."),
      env: { ...process.env, CTO_ROOT: root, CTO_RUN_ID: runId },
      stdio: ["ignore", "ignore", "pipe"],
    },
  ));
  const errors = new Map<typeof workers[number], string>();
  const waitForExit = (worker: typeof workers[number]): Promise<number> => new Promise((resolveExit, reject) => {
    let stderr = "";
    worker.stderr?.on("data", (chunk: Buffer) => { stderr += String(chunk); });
    worker.once("error", reject);
    worker.once("exit", (code) => { errors.set(worker, stderr); resolveExit(code ?? 1); });
  });
  try {
    for (let i = 0; i < 2_000 && !runIds.every((runId) => existsSync(join(root, runId + ".ready"))); i += 1) {
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 5));
    }
    assert.ok(runIds.every((runId) => existsSync(join(root, runId + ".ready"))), "both writers reached the barrier");
    writeFileSync(join(root, "go"), "go");
    const statuses = await Promise.all(workers.map(waitForExit));
    for (const [i, status] of statuses.entries()) assert.equal(status, 0, errors.get(workers[i]) ?? "active-index worker failed");

    const indexPath = join(root, ".work-state", "cto", CTO_RUN_DELIVERY_INDEX_FILE);
    const index = JSON.parse(readFileSync(indexPath, "utf8")) as { entries: Array<{ run_id: string }> };
    assert.deepEqual(new Set(index.entries.map((entry) => entry.run_id)), new Set(runIds), "both concurrent active runs survive");

    const finished = readCtoState("index-run-a", root);
    assert.ok(finished);
    const completedWave = {
      id: "index-wave-a",
      source: "test",
      source_id: "index-source-a",
      task: "index terminal summary",
      slice_ids: [],
      status: "done" as const,
      started_at: "2026-01-01T00:00:00.000Z",
      finished_at: "2026-01-01T00:00:01.000Z",
    } satisfies WaveRecord;
    finished!.wave_history = [completedWave];
    setCtoPause(finished!, "done", "finished");
    persistState(finished!, root);
    const afterFinish = JSON.parse(readFileSync(indexPath, "utf8")) as { entries: Array<{ run_id: string; status: string; pending_summary: boolean }> };
    assert.deepEqual(afterFinish.entries.map((entry) => entry.run_id), ["index-run-a", "index-run-b"], "finishing keeps the terminal run pending acknowledgement");
    assert.equal(afterFinish.entries.find((entry) => entry.run_id === "index-run-a")?.pending_summary, true);
    const pending = readCtoRunDeliveryIndexPage(root);
    assert.deepEqual(pending.entries.map((entry) => entry.run_id), ["index-run-a"], "page exposes only the pending terminal delivery");

    const terminal = readCtoState("index-run-a", root);
    assert.ok(terminal);
    if (!terminal) throw new Error("terminal active-index state is missing");
    const terminalWave = terminal.wave_history?.[0];
    assert.ok(terminalWave);
    if (!terminalWave) throw new Error("terminal active-index wave is missing");
    const summary = buildCtoTerminalSummaryEnvelope(terminal, terminalWave);
    const entryName = canonicalDurableIdFileName(summary.id);
    const published = publishCtoOutboxDelivery(root, {
      run_id: terminal.id,
      state_revision: terminal.state_revision as number,
      entry_name: entryName,
      json: JSON.stringify(summary),
    });
    assert.ok(published, "terminal summary publication creates canonical delivery evidence");
    if (!published) throw new Error("terminal active-index summary publication failed");
    const sentPath = join(root, ".work-state", "cto", terminal.id, "outbox", "sent", entryName);
    mkdirSync(dirname(sentPath), { recursive: true });
    renameSync(published, sentPath);
    assert.equal(removeCtoOutboxDeliveryObligation(root, terminal.id, entryName, summary.id), true, "transport success clears the state-owned obligation");
    const drained = readCtoState(terminal.id, root);
    assert.ok(drained);
    if (!drained) throw new Error("drained active-index state is missing");
    assert.equal(acknowledgeCtoRunDelivery(root, terminal.id, drained.state_revision as number, { drained: true }), true);
    const afterAck = JSON.parse(readFileSync(indexPath, "utf8")) as { entries: Array<{ run_id: string; status: string; pending_summary: boolean; pending_outbox: boolean }> };
    assert.deepEqual(afterAck.entries.map((entry) => entry.run_id), ["index-run-a", "index-run-b"], "acknowledgement retains the recent terminal run alongside the active run");
    assert.equal(afterAck.entries.find((entry) => entry.run_id === "index-run-a")?.pending_summary, false);
    assert.deepEqual(readCtoRunDeliveryIndexPage(root).entries, [], "acknowledgement clears pending delivery without redelivery");
    const pinned = PinnedProjectRoot.open(root);
    assert.ok(pinned);
    if (pinned) {
      const completed = readCtoRunDeliveryCompletedCandidatesPinned(pinned);
      assert.equal(completed.ok, true);
      if (completed.ok) assert.deepEqual(completed.entries.map((entry) => entry.run_id), ["index-run-a"]);
      pinned.close();
    }
    assert.equal(findActiveCtoRun(root)?.runId, "index-run-b", "latest resolver returns the remaining active run");
  } finally {
    for (const worker of workers) if (worker.exitCode === null) worker.kill();
    rmSync(root, { recursive: true, force: true });
  }
});

test("run-delivery acknowledgement compacts old terminal entries without dropping active runs", () => {
  const root = mkdtempSync(join(tmpdir(), "cto-run-delivery-retention-"));
  try {
    const oldStates = seedAuthenticatedBackingStates(Array.from({ length: 65 }, (_, index) => {
      const state = fixture(`retention-old-${String(index).padStart(2, "0")}`);
      setCtoPause(state, "done", "historical");
      return state;
    }), root);
    const persisted = seedAuthenticatedBackingStates([(() => {
      const state = fixture("retention-current");
      setCtoPause(state, "done", "finished");
      return state;
    })()], root)[0];
    assert.ok(persisted);
    if (!persisted) throw new Error("retention current fixture state is missing");
    const active = seedAuthenticatedBackingStates([fixture("retention-active")], root)[0];
    assert.ok(active);
    if (!active) throw new Error("retention active fixture state is missing");

    const discovered = readCtoRunDeliveryIndexPage(root);
    assert.equal(discovered.active_run_id, active.id, "canonical discovery identifies the authenticated active run");
    const indexPath = join(root, ".work-state", "cto", CTO_RUN_DELIVERY_INDEX_FILE);
    const discoveredIndex = JSON.parse(readFileSync(indexPath, "utf8")) as { entries: Array<{ run_id: string; status: string }> };
    assert.equal(discoveredIndex.entries.length, 67, "canonical discovery includes every authenticated backing state");
    assert.equal(discoveredIndex.entries.filter((entry) => entry.status === "done").length, 66);

    const trusted = trustedAccess(root);
    try {
      const currentBeforeAck = readCtoState(persisted.id, root);
      assert.ok(currentBeforeAck);
      if (!currentBeforeAck) throw new Error("retention current state disappeared before acknowledgement");
      assert.equal(trusted.access.acknowledgeDelivery(currentBeforeAck.id, currentBeforeAck.state_revision as number, { drained: true }), true, "current terminal must acknowledge after canonical discovery");
    } finally {
      trusted.release();
    }

    const compacted = JSON.parse(readFileSync(indexPath, "utf8")) as { entries: Array<{ run_id: string; status: string; pending_summary: boolean }> };
    assert.equal(compacted.entries.some((entry) => entry.run_id === active.id), true, "active run survives terminal compaction");
    assert.equal(compacted.entries.some((entry) => entry.run_id === persisted.id && entry.pending_summary === false), true, "newest terminal remains acknowledged");
    assert.equal(compacted.entries.filter((entry) => entry.status === "done").length, 64, "terminal history is bounded to 64 acknowledged entries");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("obligation-owned terminal survives 64-entry compaction and acknowledgement", () => {
  const root = mkdtempSync(join(tmpdir(), "cto-run-delivery-obligation-cap-"));
  try {
    const state = fixture("obligation-terminal");
    const wave: WaveRecord = {
      id: "wave-obligation-terminal",
      source: "test",
      source_id: "obligation-terminal-source",
      task: "obligation terminal",
      slice_ids: [],
      status: "done",
      outcome: "pass",
      started_at: new Date(0).toISOString(),
      finished_at: new Date(1_000).toISOString(),
    };
    state.wave_history = [wave];
    state.integration = { status: "done" };
    persistState(state, root);
    setCtoPause(state, "done", "terminal");
    persistState(state, root);
    const terminal = readCtoState(state.id, root);
    assert.ok(terminal);
    if (!terminal) throw new Error("obligation terminal state is missing");
    const summary = buildCtoTerminalSummaryEnvelope(terminal, wave);
    const entryName = canonicalDurableIdFileName(summary.id);
    const trusted = trustedAccess(root);
    const obligation = trusted.access.recordOutboxDeliveryObligation({
      run_id: state.id,
      entry_name: entryName,
      json: JSON.stringify(summary),
    });
    assert.ok(obligation);
    const indexPath = join(root, ".work-state", "cto", CTO_RUN_DELIVERY_INDEX_FILE);
    const oldTerminals = Array.from({ length: 64 }, (_, index) => ({
      run_id: `obligation-old-${String(index).padStart(2, "0")}`,
      state_revision: 1,
      status: "done",
      updated_at: new Date(index).toISOString(),
      pending_summary: false,
      pending_outbox: false,
      pending_retry: false,
      summary_digest: "",
    }));
    writeFileSync(indexPath, `${JSON.stringify({ schema_version: 2, active_run_id: null, entries: oldTerminals })}\n`);
    rmSync(join(root, ".work-state", "cto", CTO_RUN_DELIVERY_INDEX_PROOF_FILE), { force: true });

    const pending = readCtoRunDeliveryIndexPage(root);
    assert.deepEqual(pending.entries.map((entry) => entry.run_id), [state.id], "recovery indexes an orphaned obligation-owned terminal");
    const withObligation = readCtoState(state.id, root);
    assert.ok(withObligation);
    assert.equal(acknowledgeCtoRunDelivery(root, state.id, withObligation!.state_revision as number, { drained: true }), false, "pending obligation blocks terminal acknowledgement");
    assert.equal(readCtoRunDeliveryIndexPage(root).entries.some((entry) => entry.run_id === state.id), true, "blocked acknowledgement preserves indexed obligation");

    const published = trusted.access.publishOutboxDelivery({
      run_id: state.id,
      state_revision: obligation!.state_revision,
      entry_name: entryName,
      json: obligation!.json,
    });
    trusted.release();
    const sentPath = join(root, ".work-state", "cto", state.id, "outbox", "sent", entryName);
    mkdirSync(dirname(sentPath), { recursive: true });
    renameSync(published!, sentPath);
    assert.equal(removeCtoOutboxDeliveryObligation(root, state.id, entryName, summary.id), true);
    const drained = readCtoState(state.id, root);
    assert.ok(drained);
    assert.equal(acknowledgeCtoRunDelivery(root, state.id, drained!.state_revision as number, { drained: true }), true, "exact immutable sent evidence acknowledges after the obligation-clear revision");
    const compacted = JSON.parse(readFileSync(indexPath, "utf8")) as { entries: Array<{ run_id: string; pending_outbox: boolean }> };
    assert.equal(compacted.entries.some((entry) => entry.run_id === state.id), true, "acknowledged terminal remains in bounded completed history");
    assert.equal(compacted.entries.filter((entry) => entry.pending_outbox).length, 0);
    assert.equal(compacted.entries.filter((entry) => entry.run_id.startsWith("obligation-old-")).length, 63, "64-terminal cap applies only obligation-empty terminals");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("run-delivery index pages more than 64 pending entries without wrapping", () => {
  const root = mkdtempSync(join(tmpdir(), "cto-run-delivery-pages-"));
  try {
    const indexPath = join(root, ".work-state", "cto", CTO_RUN_DELIVERY_INDEX_FILE);
    const entries = Array.from({ length: 70 }, (_, i) => ({
      run_id: `delivery-${String(i).padStart(3, "0")}`,
      state_revision: 1,
      status: "active",
      updated_at: new Date(0).toISOString(),
      pending_summary: false,
      pending_outbox: true,
      summary_digest: "",
    }));
    // Delivery index recovery is canonical-state backed. Seed each run and
    // bounded queue evidence before presenting the 70-entry index image;
    // otherwise forged names are correctly excluded during reconciliation.
    for (const entry of entries) {
      persistState(fixture(entry.run_id), root);
      mkdirSync(join(root, ".work-state", "cto", entry.run_id, "outbox"), { recursive: true });
      writeFileSync(join(root, ".work-state", "cto", entry.run_id, "outbox", "pending"), "pending");
    }
    writeFileSync(indexPath, JSON.stringify({ schema_version: 2, active_run_id: entries[0]!.run_id, entries }) + "\n");
    const first = readCtoRunDeliveryIndexPage(root, { limit: 64 });
    assert.equal(first.entries.length, 64);
    assert.equal(first.next_after_run_id, "delivery-063");
    const second = readCtoRunDeliveryIndexPage(root, { after_run_id: first.next_after_run_id!, limit: 64 });
    assert.equal(second.entries.length, 6);
    assert.equal(second.next_after_run_id, null);
    const all = [...first.entries, ...second.entries].map((entry) => entry.run_id);
    assert.deepEqual(all, Array.from({ length: 70 }, (_, i) => `delivery-${String(i).padStart(3, "0")}`));
    const terminalEntries = entries.map((entry, i) => ({
      ...entry,
      status: "done" as const,
      pending_summary: i % 3 === 0,
      pending_outbox: i % 3 === 1,
      pending_retry: i % 3 === 2,
    }));
    writeFileSync(indexPath, JSON.stringify({ schema_version: 2, active_run_id: null, entries: terminalEntries }) + "\n");
    const pinned = PinnedProjectRoot.open(root);
    assert.ok(pinned);
    if (pinned) {
      try {
        const candidates = readCtoRunDeliveryCandidatesPinned(pinned);
        assert.equal(candidates.ok, true);
        if (candidates.ok) {
          assert.equal(candidates.entries.length, 70, "pending terminal candidates include summary-only, outbox-only, and retry-only work");
          assert.equal(candidates.entries.some((entry) => entry.pending_retry && !entry.pending_summary && !entry.pending_outbox), true, "retry-only terminal delivery remains discoverable");
          assert.deepEqual(candidates.entries.map((entry) => entry.run_id), Array.from({ length: 70 }, (_, i) => `delivery-${String(i).padStart(3, "0")}`));
        }
      } finally {
        pinned.close();
      }
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("run-delivery index reader fails closed without overwriting an over-bound authority", () => {
  const root = mkdtempSync(join(tmpdir(), "cto-run-delivery-byte-cap-"));
  try {
    const state = fixture("byte-cap-seed");
    persistState(state, root);
    const indexPath = join(root, ".work-state", "cto", CTO_RUN_DELIVERY_INDEX_FILE);
    const original = readFileSync(indexPath);
    const oversized = Buffer.concat([original, Buffer.alloc(MAX_CTO_RUN_DELIVERY_INDEX_BYTES + 1, 0x20)]);
    writeFileSync(indexPath, oversized);
    assert.throws(
      () => markCtoRunDeliveryPending(root, state.id, state.state_revision),
      /bounded read limit/u,
      "an over-bound index must be unavailable before any writer mutation",
    );
    assert.deepEqual(readFileSync(indexPath), oversized, "failed index admission must not overwrite the over-bound authority");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("run-delivery mark and acknowledgement reject stale state revisions", () => {
  const root = mkdtempSync(join(tmpdir(), "cto-run-delivery-stale-"));
  try {
    const state = fixture("stale-delivery");
    persistState(state, root);
    assert.equal(markCtoRunDeliveryPending(root, state.id, 0), false);
    assert.equal(readCtoRunDeliveryIndexPage(root).entries.length, 0);
    assert.equal(acknowledgeCtoRunDelivery(root, state.id, 0, { drained: true }), false);
    assert.equal(readCtoRunDeliveryIndexPage(root).entries.length, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("run-delivery index rejects oversized authority and rebuilds canonical target", () => {
  const root = mkdtempSync(join(tmpdir(), "cto-run-delivery-cap-"));
  try {
    const target = fixture("zzzz-target");
    persistState(target, root);
    setCtoPause(target, "done", "target terminal");
    persistState(target, root);
    const indexPath = join(root, ".work-state", "cto", CTO_RUN_DELIVERY_INDEX_FILE);
    const entries = [{
      run_id: target.id,
      state_revision: target.state_revision,
      status: "done",
      updated_at: target.updated_at,
      pending_summary: true,
      pending_outbox: false,
      summary_digest: "",
    }, ...Array.from({ length: 4_095 }, (_, i) => ({
      run_id: `cap-${String(i).padStart(4, "0")}`,
      state_revision: 1,
      status: "active",
      updated_at: new Date(0).toISOString(),
      pending_summary: true,
      pending_outbox: false,
      summary_digest: "",
    }))];
    writeFileSync(indexPath, JSON.stringify({ schema_version: 2, active_run_id: entries[0]!.run_id, entries }) + "\n");
    rmSync(join(root, ".work-state", "cto", CTO_RUN_DELIVERY_INDEX_PROOF_FILE), { force: true });
    assert.ok(readFileSync(indexPath).byteLength <= MAX_CTO_RUN_DELIVERY_INDEX_BYTES, "the maximum valid entry count remains within the shared index byte bound");
    const rebuilt = readCtoRunDeliveryIndexPage(root);
    assert.deepEqual(rebuilt.entries.map((entry) => entry.run_id), [target.id], "oversized synthetic names are excluded in favor of canonical state");

    const oversized = [...entries, {
      run_id: "zzzz-forged-after-cutoff",
      state_revision: 1,
      status: "active",
      updated_at: new Date(0).toISOString(),
      pending_summary: true,
      pending_outbox: false,
      summary_digest: "",
    }];
    writeFileSync(indexPath, JSON.stringify({ schema_version: 2, active_run_id: "zzzz-forged-after-cutoff", entries: oversized }) + "\n");
    rmSync(join(root, ".work-state", "cto", CTO_RUN_DELIVERY_INDEX_PROOF_FILE), { force: true });
    const repaired = readCtoRunDeliveryIndexPage(root);
    assert.deepEqual(repaired.entries.map((entry) => entry.run_id), ["zzzz-target"], "oversized index rebuilds from canonical state and retains the target after the forged cutoff");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("run-delivery index rejects duplicate and unsorted authority entries", () => {
  const root = mkdtempSync(join(tmpdir(), "cto-run-delivery-shape-"));
  try {
    const state = fixture("shape-seed");
    persistState(state, root);
    const indexPath = join(root, ".work-state", "cto", CTO_RUN_DELIVERY_INDEX_FILE);
    const entry = (runId: string) => ({
      run_id: runId,
      state_revision: 1,
      status: "active",
      updated_at: new Date(0).toISOString(),
      pending_summary: true,
      pending_outbox: false,
      summary_digest: "",
    });
    for (const entries of [[entry("shape-b"), entry("shape-a")], [entry("shape-a"), entry("shape-a")]]) {
      writeFileSync(indexPath, JSON.stringify({ schema_version: 2, active_run_id: entries[0]!.run_id, entries }) + "\n");
    rmSync(join(root, ".work-state", "cto", CTO_RUN_DELIVERY_INDEX_PROOF_FILE), { force: true });
      readCtoRunDeliveryIndexPage(root);
      const repaired = JSON.parse(readFileSync(indexPath, "utf8")) as { entries: Array<{ run_id: string }> };
      assert.deepEqual(repaired.entries.map((candidate) => candidate.run_id), [state.id], "malformed ordering or duplicate IDs rebuild from canonical state");
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
test("active-run candidates repair forged-valid omissions and stale summary digests", () => {
  const root = mkdtempSync(join(tmpdir(), "cto-run-delivery-candidates-"));
  const pinnedRoot = PinnedProjectRoot.open(root);
  assert.ok(pinnedRoot);
  try {
    persistState(fixture("forged-index-a"), root);
    persistState(fixture("forged-index-b"), root);
    const indexPath = join(root, ".work-state", "cto", CTO_RUN_DELIVERY_INDEX_FILE);
    const original = JSON.parse(readFileSync(indexPath, "utf8")) as {
      entries: Array<Record<string, unknown>>;
    };
    assert.equal(original.entries.length, 2);
    writeFileSync(indexPath, JSON.stringify({
      schema_version: 2,
      active_run_id: original.entries[0]!.run_id,
      entries: [{ ...original.entries[0], summary_digest: "f".repeat(64) }],
    }) + "\n");
    rmSync(join(root, ".work-state", "cto", CTO_RUN_DELIVERY_INDEX_PROOF_FILE), { force: true });

    const candidates = readCtoRunDeliveryReconciledActiveCandidatesPinned(pinnedRoot);
    assert.equal(candidates.ok, true);
    if (!candidates.ok) return;
    assert.deepEqual(new Set(candidates.entries.map((entry) => entry.run_id)), new Set(["forged-index-a", "forged-index-b"]));
    const repaired = JSON.parse(readFileSync(indexPath, "utf8")) as {
      entries: Array<{ run_id: string; summary_digest: string }>;
    };
    assert.deepEqual(repaired.entries.map((entry) => entry.run_id), ["forged-index-a", "forged-index-b"]);
    assert.equal(repaired.entries[0]!.summary_digest, "");
  } finally {
    pinnedRoot.close();
    rmSync(root, { recursive: true, force: true });
  }
});
test("indexed active candidates reject stale canonical metadata without rebuilding", () => {
  const root = mkdtempSync(join(tmpdir(), "cto-run-delivery-indexed-stale-"));
  const pinnedRoot = PinnedProjectRoot.open(root);
  assert.ok(pinnedRoot);
  try {
    persistState(fixture("indexed-stale"), root);
    const indexPath = join(root, ".work-state", "cto", CTO_RUN_DELIVERY_INDEX_FILE);
    const before = JSON.parse(readFileSync(indexPath, "utf8")) as { entries: Array<Record<string, unknown>> };
    writeFileSync(indexPath, JSON.stringify({
      schema_version: 2,
      active_run_id: "indexed-stale",
      entries: [{ ...before.entries[0], summary_digest: "f".repeat(64) }],
    }) + "\n");
    rmSync(join(root, ".work-state", "cto", CTO_RUN_DELIVERY_INDEX_PROOF_FILE), { force: true });
    const result = readCtoRunDeliveryActiveCandidatesPinned(pinnedRoot);
    assert.equal(result.ok, true, "stale structural metadata is repaired from canonical state");
    assert.equal((JSON.parse(readFileSync(indexPath, "utf8")) as { entries: Array<{ summary_digest: string }> }).entries[0]!.summary_digest, "");
  } finally {
    pinnedRoot.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("ownerless raw active index has no authenticated resident authority", () => {
  const root = mkdtempSync(join(tmpdir(), "cto-run-delivery-ownerless-"));
  try {
    const state = newCtoState({
      id: "ownerless-active", task: "ownerless", branch: "main", autonomous: false,
      plan: { id: "ownerless-active", task: "ownerless", teams: [], created_at: new Date().toISOString() },
    });
    writeCtoState(state, root, { preCommit: ({ pinnedRoot }) => pinnedRoot.assertStable() });
    const pinnedRoot = PinnedProjectRoot.open(root);
    assert.ok(pinnedRoot);
    try {
      assert.equal(refreshCtoRunDeliveryIndexAuthorityPinned(pinnedRoot, undefined, "main-session"), false, "raw callers cannot mint provenance");
      assert.equal(readCtoRunDeliveryIndexAuthorityPinned(pinnedRoot).authenticated, false, "ownerless state/index is diagnostic only");
    } finally {
      pinnedRoot.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("forged schema-valid active index entry without canonical state cannot gate authority", () => {
  const root = mkdtempSync(join(tmpdir(), "cto-run-delivery-forged-orphan-"));
  const pinnedRoot = PinnedProjectRoot.open(root);
  assert.ok(pinnedRoot);
  try {
    const indexPath = join(root, ".work-state", "cto", CTO_RUN_DELIVERY_INDEX_FILE);
    mkdirSync(dirname(indexPath), { recursive: true });
    writeFileSync(indexPath, JSON.stringify({
      schema_version: 2,
      active_run_id: "forged-orphan",
      entries: [{ run_id: "forged-orphan", state_revision: 99, status: "active", updated_at: new Date().toISOString(), pending_summary: false, pending_outbox: true, pending_retry: false, summary_digest: "" }],
    }) + "\n");
    const result = readCtoRunDeliveryActiveCandidatesPinned(pinnedRoot);
    assert.equal(result.ok, true);
    if (result.ok) assert.deepEqual(result.entries, [], "orphan index entry never becomes an active run");
    assert.deepEqual((JSON.parse(readFileSync(indexPath, "utf8")) as { entries: unknown[] }).entries, []);
  } finally {
    pinnedRoot.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("indexed active candidates ignore large unrelated run-directory junk", () => {
  const root = mkdtempSync(join(tmpdir(), "cto-run-delivery-indexed-junk-"));
  const pinnedRoot = PinnedProjectRoot.open(root);
  assert.ok(pinnedRoot);
  try {
    persistState(fixture("indexed-junk-seed"), root);
    const ctoDirectory = join(root, ".work-state", "cto");
    for (let i = 0; i < 16_384; i += 1) mkdirSync(join(ctoDirectory, `run-junk-${String(i).padStart(5, "0")}`));
    const result = readCtoRunDeliveryActiveCandidatesPinned(pinnedRoot);
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.deepEqual(result.entries.map((entry) => entry.run_id), ["indexed-junk-seed"]);
  } finally {
    pinnedRoot.close();
    rmSync(root, { recursive: true, force: true });
  }
});
test("active-run reconciliation fails closed for indexed unreadable state", () => {
  const root = mkdtempSync(join(tmpdir(), "cto-run-delivery-indexed-unreadable-"));
  const pinnedRoot = PinnedProjectRoot.open(root);
  assert.ok(pinnedRoot);
  try {
    persistState(fixture("indexed-unreadable"), root);
    const indexPath = join(root, ".work-state", "cto", CTO_RUN_DELIVERY_INDEX_FILE);
    const before = readFileSync(indexPath);
    writeFileSync(join(root, ".work-state", "cto", "indexed-unreadable", "state.json"), "{ malformed");
    const result = readCtoRunDeliveryReconciledActiveCandidatesPinned(pinnedRoot);
    assert.deepEqual(result, { ok: false, code: "unavailable" });
    assert.deepEqual(readFileSync(indexPath), before, "unreadable indexed state must not be dropped from the authority");
  } finally {
    pinnedRoot.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("active-run reconciliation fails closed for unindexed canonical unreadable state", () => {
  const root = mkdtempSync(join(tmpdir(), "cto-run-delivery-unindexed-unreadable-"));
  const pinnedRoot = PinnedProjectRoot.open(root);
  assert.ok(pinnedRoot);
  try {
    persistState(fixture("indexed-seed"), root);
    const indexPath = join(root, ".work-state", "cto", CTO_RUN_DELIVERY_INDEX_FILE);
    const before = readFileSync(indexPath);
    const runDirectory = join(root, ".work-state", "cto", "unindexed-unreadable");
    mkdirSync(runDirectory, { recursive: true });
    writeFileSync(join(runDirectory, "state.json"), "{ malformed");
    const result = readCtoRunDeliveryReconciledActiveCandidatesPinned(pinnedRoot);
    assert.deepEqual(result, { ok: false, code: "unavailable" });
    assert.deepEqual(readFileSync(indexPath), before, "unreadable canonical state must not be silently omitted");
  } finally {
    pinnedRoot.close();
    rmSync(root, { recursive: true, force: true });
  }
});
test("active-run candidates return the complete canonical set beyond the legacy 64 candidate window", () => {
  const root = mkdtempSync(join(tmpdir(), "cto-run-delivery-candidate-cap-"));
  const pinnedRoot = PinnedProjectRoot.open(root);
  assert.ok(pinnedRoot);
  try {
    persistState(fixture("candidate-seed"), root);
    const seedPath = join(root, ".work-state", "cto", "candidate-seed", "state.json");
    const persisted = JSON.parse(readFileSync(seedPath, "utf8")) as Record<string, unknown> & {
      plan: Record<string, unknown>;
    };
    for (let i = 0; i < 65; i += 1) {
      const id = `candidate-${String(i).padStart(2, "0")}`;
      const state = { ...persisted, id, task: id, plan: { ...persisted.plan, id, task: id } };
      const runDirectory = join(root, ".work-state", "cto", id);
      mkdirSync(runDirectory, { recursive: true });
      writeFileSync(join(runDirectory, "state.json"), JSON.stringify(state) + "\n");
    }
    const result = readCtoRunDeliveryReconciledActiveCandidatesPinned(pinnedRoot);
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.entries.length, 66);
    const repaired = JSON.parse(readFileSync(join(root, ".work-state", "cto", CTO_RUN_DELIVERY_INDEX_FILE), "utf8")) as {
      entries: unknown[];
    };
    assert.equal(repaired.entries.length, 66);
  } finally {
    pinnedRoot.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("acknowledgement remains blocked while retry outbox has an entry", () => {
  const root = mkdtempSync(join(tmpdir(), "cto-outbox-retry-ack-"));
  const state = fixture("retry-ack");
  try {
    persistState(state, root);
    assert.equal(markCtoRunDeliveryPending(root, state.id, state.state_revision), true);
    const retryEntry = join(root, ".work-state", "cto", state.id, "outbox-retry", "retry.json");
    mkdirSync(join(root, ".work-state", "cto", state.id, "outbox-retry"), { recursive: true });
    writeFileSync(retryEntry, "retry");
    assert.equal(acknowledgeCtoRunDelivery(root, state.id, state.state_revision as number, { drained: true }), false);
    rmSync(retryEntry, { force: true });
    assert.equal(acknowledgeCtoRunDelivery(root, state.id, state.state_revision as number, { drained: true }), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("acknowledgement blocks foreign non-json outbox and retry entries", () => {
  for (const lane of ["outbox", "retry"] as const) {
    const root = mkdtempSync(join(tmpdir(), `cto-foreign-${lane}-ack-`));
    const state = fixture(`foreign-${lane}-ack`);
    try {
      persistState(state, root);
      assert.equal(markCtoRunDeliveryPending(root, state.id, state.state_revision, lane), true);
      const laneDirectory = lane === "outbox"
        ? join(root, ".work-state", "cto", state.id, "outbox")
        : join(root, ".work-state", "cto", state.id, "outbox-retry");
      mkdirSync(laneDirectory, { recursive: true });
      const foreignPath = join(laneDirectory, `foreign-${lane}`);
      writeFileSync(foreignPath, "foreign");
      assert.equal(
        acknowledgeCtoRunDelivery(root, state.id, state.state_revision as number, { drained: true }),
        false,
        `${lane} foreign non-json evidence must block acknowledgement`,
      );
      assert.equal(readFileSync(foreignPath, "utf8"), "foreign", `${lane} foreign evidence must remain untouched`);
      rmSync(foreignPath, { force: true });
      if (lane === "outbox") mkdirSync(join(laneDirectory, "sent"));
      assert.equal(
        acknowledgeCtoRunDelivery(root, state.id, state.state_revision as number, { drained: true }),
        true,
        lane === "outbox" ? "the verified sent directory alone does not block acknowledgement" : "an empty retry lane permits acknowledgement",
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

test("legacy CTO state reads at revision zero and migrates on first write", () => {
  const root = mkdtempSync(join(tmpdir(), "cto-state-revision-legacy-"));
  const runId = "legacy-revision";
  try {
    const legacy = fixture(runId);
    delete legacy.state_revision;
    const dir = ctoStateDir(runId, root);
    mkdirSync(dir, { recursive: true });
    const path = join(dir, "state.json");
    writeFileSync(path, JSON.stringify(legacy) + "\n");

    const migrated = readCtoState(runId, root);
    assert.equal(migrated?.state_revision, 0);
    assert.equal(migrateCtoState({ ...legacy }).state_revision, 0);
    writeCtoState(migrated!, root, { preCommit: ({ pinnedRoot }) => pinnedRoot.assertStable() });
    assert.equal(migrated?.state_revision, 1);
    assert.equal(JSON.parse(readFileSync(path, "utf8")).state_revision, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("CTO state lock recovers ownerless and dead-owner locks", () => {
  const root = mkdtempSync(join(tmpdir(), "cto-state-lock-recovery-"));
  const runId = "lock-recovery";
  try {
    const runDir = ctoStateDir(runId, root);
    ensureSecureStateDirectory(runDir);
    const lockPath = join(runDir, CTO_STATE_WRITE_LOCK_FILE);

    mkdirSync(lockPath, { mode: 0o700 });
    const staleAt = oldTimestamp();
    utimesSync(lockPath, staleAt, staleAt);
    withCtoStateWriteLock(root, runId, () => {
      assert.equal(lstatSync(lockPath).isFile(), true);
      const owner = JSON.parse(readFileSync(lockPath, "utf8")) as { pid: number; token: string };
      assert.equal(owner.pid, process.pid);
      assert.notEqual(owner.token, "");
    }, { timeoutMs: 1_000 });
    assert.equal(existsSync(lockPath), false);

    writeFileSync(
      lockPath,
      JSON.stringify({ pid: 2_147_483_647, token: "dead-owner", acquired_at: new Date().toISOString() }),
      { flag: "wx", mode: 0o600 },
    );
    withCtoStateWriteLock(root, runId, () => {
      const owner = JSON.parse(readFileSync(lockPath, "utf8")) as { pid: number; token: string };
      assert.equal(owner.pid, process.pid);
      assert.notEqual(owner.token, "dead-owner");
    }, { timeoutMs: 1_000 });
    assert.equal(existsSync(lockPath), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("CTO state lock fences PID reuse and live legacy owners", () => {
  const root = mkdtempSync(join(tmpdir(), "cto-state-lock-identity-"));
  const runId = "lock-identity";
  try {
    const runDir = ctoStateDir(runId, root);
    ensureSecureStateDirectory(runDir);
    const lockPath = join(runDir, CTO_STATE_WRITE_LOCK_FILE);
    const startIdentity = processStartIdentity();
    assert.ok(startIdentity);

    writeFileSync(
      lockPath,
      JSON.stringify({ pid: process.pid, token: "reused-pid", start_identity: "different-process-start", acquired_at: new Date().toISOString() }),
      { flag: "wx", mode: 0o600 },
    );
    withCtoStateWriteLock(root, runId, () => {
      const owner = JSON.parse(readFileSync(lockPath, "utf8")) as { pid: number; token: string; start_identity: string };
      assert.equal(owner.pid, process.pid);
      assert.notEqual(owner.token, "reused-pid");
      assert.equal(owner.start_identity, startIdentity);
    }, { timeoutMs: 1_000 });

    writeFileSync(
      lockPath,
      JSON.stringify({ pid: process.pid, token: "live-legacy", acquired_at: new Date().toISOString() }),
      { flag: "wx", mode: 0o600 },
    );
    assert.throws(
      () => withCtoStateWriteLock(root, runId, () => undefined, { timeoutMs: 100 }),
      /timeout exceeded/,
      "a live PID-only legacy owner is never reclaimed by PID liveness alone",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
test("CTO pinned state lock rejects oversized and invalid UTF-8 owners", () => {
  for (const [label, bytes] of [
    ["oversized", Buffer.alloc(8 * 1024 + 1, 0x20)],
    ["invalid UTF-8", Buffer.from([0xff, 0xfe, 0xfd])],
  ] as const) {
    const root = mkdtempSync(join(tmpdir(), `cto-state-lock-${label.replaceAll(" ", "-")}-`));
    const runId = `lock-${label.replaceAll(" ", "-")}`;
    let pinned: PinnedProjectRoot | null = null;
    try {
      const runDir = ctoStateDir(runId, root);
      ensureSecureStateDirectory(runDir);
      writeFileSync(join(runDir, CTO_STATE_WRITE_LOCK_FILE), bytes, { flag: "wx", mode: 0o600 });
      pinned = PinnedProjectRoot.open(root);
      assert.ok(pinned);
      assert.throws(
        () => withCtoStateWriteLock(root, runId, () => undefined, { pinnedRoot: pinned!, timeoutMs: 100 }),
        /state write lock unavailable/,
      );
    } finally {
      pinned?.close();
      rmSync(root, { recursive: true, force: true });
    }
  }
});

test("CTO pinned state lock retries a transient owner replacement", () => {
  const root = mkdtempSync(join(tmpdir(), "cto-state-lock-replacement-"));
  const runId = "lock-replacement";
  let pinned: PinnedProjectRoot | null = null;
  try {
    const runDir = ctoStateDir(runId, root);
    ensureSecureStateDirectory(runDir);
    const lockPath = join(runDir, CTO_STATE_WRITE_LOCK_FILE);
    writeFileSync(
      lockPath,
      JSON.stringify({ pid: process.pid, token: "dead-owner", start_identity: "different-process-start", acquired_at: new Date().toISOString() }),
      { flag: "wx", mode: 0o600 },
    );
    pinned = PinnedProjectRoot.open(root);
    assert.ok(pinned);
    const originalReadFile = pinned.readFile.bind(pinned);
    let replaced = false;
    pinned.readFile = ((relativeFile: string, options?: { maxBytes?: number }) => {
      if (!replaced && relativeFile === `.work-state/cto/${runId}/${CTO_STATE_WRITE_LOCK_FILE}`) {
        replaced = true;
        throw new PinnedRootError("changed", "owner was replaced during the bounded read");
      }
      return originalReadFile(relativeFile, options);
    }) as PinnedProjectRoot["readFile"];
    withCtoStateWriteLock(root, runId, () => {
      const owner = JSON.parse(readFileSync(lockPath, "utf8")) as { pid: number; token: string };
      assert.equal(owner.pid, process.pid);
      assert.notEqual(owner.token, "dead-owner");
    }, { pinnedRoot: pinned, timeoutMs: 5_000 });
    assert.equal(replaced, true);
  } finally {
    pinned?.close();
    rmSync(root, { recursive: true, force: true });
  }
});
test("CTO pinned state lock preserves a successor installed during stale cleanup", () => {
  const root = mkdtempSync(join(tmpdir(), "cto-state-lock-successor-"));
  const runId = "lock-successor";
  const relativeLockPath = `.work-state/cto/${runId}/${CTO_STATE_WRITE_LOCK_FILE}`;
  const replacement = JSON.stringify({
    pid: process.pid,
    token: "live-successor",
    start_identity: processStartIdentity(),
    acquired_at: new Date().toISOString(),
  });
  let interposed = false;
  let pinned: PinnedProjectRoot | null = null;
  try {
    const runDir = ctoStateDir(runId, root);
    ensureSecureStateDirectory(runDir);
    const lockPath = join(runDir, CTO_STATE_WRITE_LOCK_FILE);
    writeFileSync(
      lockPath,
      JSON.stringify({ pid: process.pid, token: "stale-owner", start_identity: "different-process-start", acquired_at: new Date().toISOString() }),
      { flag: "wx", mode: 0o600 },
    );
    pinned = PinnedProjectRoot.open(root, {
      beforeConditionalCommit: (relativePath) => {
        if (interposed || relativePath !== relativeLockPath) return;
        interposed = true;
        rmSync(lockPath, { force: true });
        const acquired = pinned!.tryAcquireExclusiveLock(
          `${relativeLockPath}.contender`,
          relativeLockPath,
          replacement,
        );
        assert.equal(acquired, true);
      },
    }, root);
    assert.ok(pinned);
    assert.throws(
      () => withCtoStateWriteLock(root, runId, () => undefined, { pinnedRoot: pinned!, timeoutMs: 4_000 }),
      /timeout exceeded/,
    );
    assert.equal(interposed, true);
    assert.equal(readFileSync(lockPath, "utf8"), replacement);
  } finally {
    pinned?.close();
    rmSync(root, { recursive: true, force: true });
  }
});
