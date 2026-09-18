import { strict as assert } from "node:assert";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { openTestCtoRuntime } from "./fixtures/registry-activation.js";
import type { CtoRuntimeAccessFacade } from "../src/cto/runtime-access.js";
import {
  buildCtoTerminalSummaryEnvelope,
  ctoRuntimeRunInitialIdentityDigest,
  newCtoState,
  readCtoState,
  setCtoPause,
} from "../src/cto/state.js";
import { canonicalDurableIdFileName } from "../src/cto/durable-id.js";
import { PinnedProjectRoot } from "../src/specification/pinned-root.js";
import type { CtoState, WaveRecord } from "../src/cto/types.js";

const MARKER = '{"schema_version":1,"bundle_id":"@andvl1/omp-workflows-fullstack","entrypoint":"dist/index.js"}\n';
const EIGHT_MIB = 8 * 1024 * 1024;
const COMPLETED_WAVE_COUNT = 257;

function makeProject(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  mkdirSync(join(root, ".omp"));
  writeFileSync(join(root, ".omp", "fullstack.activation.json"), MARKER);
  return root;
}

function makeRun(runId: string): CtoState {
  const state = newCtoState({
    id: runId,
    task: "terminal summary retention regression",
    branch: "main",
    autonomous: false,
    owner_session: "core-regression-test",
    plan: { id: runId, task: "terminal summary retention regression", teams: [], created_at: "" },
  });
  state.work_identity = {
    run_id: runId,
    wave_id: "wave-runtime-regression",
    slice_id: "slice-runtime-regression",
    session_id: "core-regression-test",
    workflow: "developer",
    stage_id: "execution",
    stage_cursor: "execution",
    capability_id: "runtime-regression-capability",
    capability_epoch: "runtime-regression-epoch",
    slot_id: "runtime-regression-slot",
    task_id: "runtime-regression-task",
    dispatch_id: "runtime-regression-dispatch",
    attempt: 1,
    worker_id: "runtime-regression-worker",
  };
  return state;
}

function makeWaves(runId: string, count = COMPLETED_WAVE_COUNT): WaveRecord[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `wave-${String(index).padStart(3, "0")}`,
    source: "test",
    source_id: `${runId}-source-${String(index).padStart(3, "0")}`,
    task: `completed wave ${index}`,
    slice_ids: [],
    status: "done" as const,
    outcome: "pass" as const,
    started_at: new Date(1_700_000_000_000 + index * 2_000).toISOString(),
    finished_at: new Date(1_700_000_001_000 + index * 2_000).toISOString(),
  }));
}

function summaryForRevision(state: CtoState, wave: WaveRecord, sourceRevision: number): Buffer {
  return Buffer.from(JSON.stringify(buildCtoTerminalSummaryEnvelope({ ...state, state_revision: sourceRevision }, wave)), "utf8");
}

function addCompactSummaryEvidence(
  access: CtoRuntimeAccessFacade,
  runId: string,
  waves: readonly WaveRecord[],
  count: number,
): void {
  access.withRunTransaction(runId, (transaction) => {
    const next = transaction.readState();
    const sourceRevision = next.state_revision as number;
    next.terminal_summary_evidence = waves.slice(0, count).map((wave) => {
      const bytes = summaryForRevision(next, wave, sourceRevision);
      return {
        wave_id: wave.id,
        source_revision: sourceRevision,
        envelope_sha256: createHash("sha256").update(bytes).digest("hex"),
      };
    });
    transaction.writeState(next);
  });
}

function archiveCompactSummaries(root: string, state: CtoState): void {
  const sentDirectory = join(root, ".work-state", "cto", state.id, "outbox", "sent");
  mkdirSync(sentDirectory, { recursive: true });
  for (const evidence of state.terminal_summary_evidence ?? []) {
    const wave = state.wave_history?.find((candidate) => candidate.id === evidence.wave_id);
    assert.ok(wave, `summary evidence wave ${evidence.wave_id} must exist`);
    if (!wave) continue;
    const bytes = summaryForRevision(state, wave, evidence.source_revision);
    assert.equal(createHash("sha256").update(bytes).digest("hex"), evidence.envelope_sha256);
    writeFileSync(join(sentDirectory, canonicalDurableIdFileName(`${state.id}/wave/${wave.id}/summary`)), bytes);
  }
}

test("obligation reads preserve the exact non-default routing binding and omit tampered proof", () => {
  const root = makeProject("omp-cto-obligation-routing-proof-");
  const runtime = openTestCtoRuntime(root, "core-regression-test", "cto-runtime-core-regressions");
  const rootIdentity = PinnedProjectRoot.open(root);
  assert.ok(rootIdentity);
  try {
    const run = makeRun("routing-proof");
    const created = runtime.access.createRun(run, {
      source_id: "core-regression-routing-proof",
      initial_state_sha256: ctoRuntimeRunInitialIdentityDigest(run),
    });
    const id = `${created.id}/wave/w1/question`;
    const envelope = JSON.stringify({
      id,
      level: "question",
      title: "question",
      body: "route me",
      intent: "question",
      idempotency_key: id,
      run_id: created.id,
    });
    const entryName = canonicalDurableIdFileName(id);
    const routingBinding = {
      config_sha256: "a".repeat(64),
      snapshot_sha256: "b".repeat(64),
      channel: "http:secondary",
      target: "https://non-default.example/topic",
      canonical_root: rootIdentity!.canonical_root,
      root_dev: rootIdentity!.dev,
      root_ino: rootIdentity!.ino,
    } as const;
    const obligation = runtime.access.recordOutboxDeliveryObligation({
      run_id: created.id,
      entry_name: entryName,
      json: envelope,
      routing_binding: routingBinding,
    });
    assert.ok(obligation, "trusted runtime must record the source obligation");
    if (!obligation) return;

    const read = runtime.access.readOutboxDeliveryObligations(created.id);
    assert.equal(read.length, 1, "the authenticated obligation remains readable");
    assert.deepEqual({ ...read[0]!.routing_binding }, routingBinding, "read routing is the exact non-default binding, not a default projection");
    assert.deepEqual(Buffer.from(read[0]!.json), Buffer.from(obligation.json));

    const proofPath = join(root, ".work-state", "cto", created.id, `.obligation-${entryName}.proof.json`);
    const forgedProof = JSON.parse(readFileSync(proofPath, "utf8")) as Record<string, unknown>;
    forgedProof.routing_target = "https://forged.example/topic";
    writeFileSync(proofPath, `${JSON.stringify(forgedProof)}\n`);
    assert.deepEqual(runtime.access.readOutboxDeliveryObligations(created.id), [], "a tampered proof is omitted rather than projected as trusted routing");
  } finally {
    if (rootIdentity) rootIdentity.close();
    runtime.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test(">256 completed waves with compact evidence remain readable and acknowledgeable under the 8MiB state cap", () => {
  const root = makeProject("omp-cto-terminal-summary-compact-");
  const runtime = openTestCtoRuntime(root, "core-regression-test", "cto-runtime-core-regressions");
  try {
    const runId = "compact-257-waves";
    const run = makeRun(runId);
    runtime.access.createRun(run, {
      source_id: "core-regression-compact-257",
      initial_state_sha256: ctoRuntimeRunInitialIdentityDigest(run),
    });
    const waves = makeWaves(runId);
    runtime.access.withRunTransaction(runId, (transaction) => {
      const next = transaction.readState();
      next.wave_history = waves;
      setCtoPause(next, "done", "all completed summaries are archived");
      transaction.writeState(next);
    });
    addCompactSummaryEvidence(runtime.access, runId, waves, waves.length);
    const current = readCtoState(runId, root);
    assert.ok(current);
    if (!current) return;
    archiveCompactSummaries(root, current);
    const compacted = readCtoState(runId, root);
    assert.ok(compacted, "compact terminal evidence must remain parseable");
    assert.ok(readFileSync(join(root, ".work-state", "cto", runId, "state.json")).byteLength < EIGHT_MIB, "compact terminal evidence stays below the bounded state size");
    assert.equal(compacted!.terminal_summary_evidence?.length, COMPLETED_WAVE_COUNT);
    assert.equal(compacted!.terminal_summary_evidence?.some((item) => item.envelope !== undefined), false, "settled summaries retain hashes without full envelopes");
    const page = runtime.access.readDeliveryIndexPage();
    assert.equal(page.entries.some((entry) => entry.run_id === runId), false, "fully archived summaries do not remain pending");
    const revision = compacted.state_revision as number;
    assert.equal(runtime.access.acknowledgeDelivery(runId, revision, { drained: true }), true, "a terminal run with >256 compact summaries remains acknowledgeable");
  } finally {
    runtime.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("pending summary keeps its full envelope until exact sent archive and obligation removal compact it", () => {
  const root = makeProject("omp-cto-terminal-summary-pending-");
  const runtime = openTestCtoRuntime(root, "core-regression-test", "cto-runtime-core-regressions");
  try {
    const runId = "pending-257-waves";
    const run = makeRun(runId);
    runtime.access.createRun(run, {
      source_id: "core-regression-pending-257",
      initial_state_sha256: ctoRuntimeRunInitialIdentityDigest(run),
    });
    const waves = makeWaves(runId);
    const pendingWave = waves[waves.length - 1]!;
    runtime.access.withRunTransaction(runId, (transaction) => {
      const next = transaction.readState();
      next.wave_history = waves;
      setCtoPause(next, "done", "one summary remains pending");
      transaction.writeState(next);
    });
    addCompactSummaryEvidence(runtime.access, runId, waves, waves.length - 1);
    const beforeObligation = readCtoState(runId, root);
    assert.ok(beforeObligation);
    if (!beforeObligation) return;
    archiveCompactSummaries(root, beforeObligation);
    const pendingSummary = buildCtoTerminalSummaryEnvelope(beforeObligation, pendingWave);
    const pendingId = pendingSummary.id;
    const entryName = canonicalDurableIdFileName(pendingId);
    const obligation = runtime.access.recordOutboxDeliveryObligation({
      run_id: runId,
      entry_name: entryName,
      json: JSON.stringify(pendingSummary),
    });
    assert.ok(obligation, "pending summary must be durably obligated");
    if (!obligation) return;
    const pendingState = readCtoState(runId, root);
    assert.ok(pendingState);
    const fullEvidence = pendingState?.terminal_summary_evidence?.find((item) => item.wave_id === pendingWave.id);
    assert.equal(fullEvidence?.envelope, Buffer.from(obligation.json).toString("utf8"), "pending summary retains its exact full envelope");
    assert.ok(readFileSync(join(root, ".work-state", "cto", runId, "state.json")).byteLength < EIGHT_MIB);

    const sentPath = join(root, ".work-state", "cto", runId, "outbox", "sent", entryName);
    mkdirSync(join(root, ".work-state", "cto", runId, "outbox", "sent"), { recursive: true });
    writeFileSync(sentPath, obligation.json);
    assert.equal(runtime.access.removeOutboxDeliveryObligation(runId, entryName, pendingId), true, "exact sent archive permits obligation removal");

    const compacted = readCtoState(runId, root);
    assert.ok(compacted);
    const compactedEvidence = compacted?.terminal_summary_evidence?.find((item) => item.wave_id === pendingWave.id);
    assert.ok(compactedEvidence);
    assert.equal(compactedEvidence?.envelope, undefined, "only exact sent archive plus obligation removal compacts the full envelope");
    assert.equal(compactedEvidence?.envelope_sha256, createHash("sha256").update(obligation.json).digest("hex"));
    assert.ok(readFileSync(join(root, ".work-state", "cto", runId, "state.json")).byteLength < EIGHT_MIB);
    assert.equal(runtime.access.acknowledgeDelivery(runId, compacted!.state_revision as number, { drained: true }), true, "the compacted terminal remains acknowledgeable");
  } finally {
    runtime.close();
    rmSync(root, { recursive: true, force: true });
  }
});
