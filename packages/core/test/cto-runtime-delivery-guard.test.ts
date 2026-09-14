import { strict as assert } from "node:assert";
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { CtoRuntimeAccessError, type CtoRuntimeOutboxDeliveryInput } from "../src/cto/runtime-access.js";
import { openTestCtoRuntime } from "./fixtures/registry-activation.js";
import { canonicalDurableIdFileName } from "../src/cto/durable-id.js";
import { PinnedProjectRoot } from "../src/specification/pinned-root.js";
import { CTO_RUN_DELIVERY_INDEX_FILE, markCtoRunDeliveryPending, newCtoState, publishCtoOutboxDelivery as rawPublishCtoOutboxDelivery, readCtoState, setCtoPause, writeCtoState } from "../src/cto/state.js";

const MARKER = '{"schema_version":1,"bundle_id":"@andvl1/omp-workflows-fullstack","entrypoint":"dist/index.js"}\n';

function makeProject(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  mkdirSync(join(root, ".omp"));
  writeFileSync(join(root, ".omp", "fullstack.activation.json"), MARKER);
  return root;
}

function openAccess(root: string) {
  const runtime = openTestCtoRuntime(root, "main-session", "cto-runtime-delivery-guard-test");
  return { runtime, access: runtime.access };
}

function makeState(runId: string) {
  return newCtoState({
    id: runId,
    task: "delivery guard test",
    branch: "main",
    autonomous: false,
    plan: { id: runId, task: "delivery guard test", teams: [], created_at: "" },
  });
}

function deliveryInput(runId: string, stateRevision: number, body = "body"): CtoRuntimeOutboxDeliveryInput {
  const id = `${runId}/wave/w1/question`;
  const json = JSON.stringify({ id, level: "question", title: "question", body, intent: "question", idempotency_key: id });
  return {
    run_id: runId,
    state_revision: stateRevision,
    entry_name: canonicalDurableIdFileName(id),
    json,
    lane: "outbox",
  };
}

function ackInput(runId: string, stateRevision: number, intent: "ack" | "question" | "progress" = "ack", target?: string): CtoRuntimeOutboxDeliveryInput {
  const id = `${runId}/wave/w1/${intent}`;
  const json = JSON.stringify({ id, level: "question", title: intent, body: intent, intent, idempotency_key: id, ...(target === undefined ? {} : { target }) });
  return { run_id: runId, state_revision: stateRevision, entry_name: canonicalDurableIdFileName(id), json, lane: "outbox" };
}

function publishWithObligation(root: string, access: ReturnType<typeof openAccess>["access"], input: CtoRuntimeOutboxDeliveryInput): string | null {
  const obligation = access.recordOutboxDeliveryObligation({
    run_id: input.run_id,
    entry_name: input.entry_name,
    json: input.json,
    ...((input as unknown as { routing_binding?: unknown }).routing_binding === undefined ? {} : { routing_binding: (input as unknown as { routing_binding: unknown }).routing_binding }),
  });
  if (!obligation) return null;
  Object.assign(input as unknown as { state_revision: number; json: string | Uint8Array }, { state_revision: obligation.state_revision, json: Buffer.from(obligation.json).toString("utf8") });
  return access.publishOutboxDelivery({ run_id: input.run_id, state_revision: obligation.state_revision, entry_name: input.entry_name, json: obligation.json, ...((input as unknown as { routing_binding?: unknown }).routing_binding === undefined ? {} : { routing_binding: (input as unknown as { routing_binding: unknown }).routing_binding }) });
}

test("currentOutboxDeliveryStatus validates genuine outbox publication and raw retry storage names", () => {
  const root = makeProject("omp-cto-delivery-guard-");
  try {
    const runId = "delivery-guard";
    const state = makeState(runId);
    writeCtoState(state, root, { preCommit: ({ pinnedRoot }) => pinnedRoot.assertStable() });
    const { runtime, access } = openAccess(root);
    try {
      const input = deliveryInput(runId, state.state_revision as number);
      assert.ok(publishWithObligation(root, access, input));
      assert.equal(access.currentOutboxDeliveryStatus(input), "current");
      assert.equal(access.readDeliveryIndexPage().entries.find((entry) => entry.run_id === runId)?.pending_outbox, true);
      assert.equal(Object.keys(access).includes("currentOutboxDeliveryStatus"), false);

      const storageEntryName = "r2-retry.json";
      const retryInput = { ...input, storage_entry_name: storageEntryName, lane: "retry" as const };
      const outboxPath = join(root, ".work-state", "cto", runId, "outbox", input.entry_name);
      const retryPath = join(root, ".work-state", "cto", runId, "outbox-retry", storageEntryName);
      mkdirSync(join(root, ".work-state", "cto", runId, "outbox-retry"));
      renameSync(outboxPath, retryPath);
      assert.equal(markCtoRunDeliveryPending(root, runId, input.state_revision, "retry"), true);
      assert.equal(access.currentOutboxDeliveryStatus(retryInput), "current");
      assert.equal(access.currentOutboxDeliveryStatus(input), "invalid");
      assert.equal(access.currentOutboxDeliveryStatus({ ...retryInput, storage_entry_name: "missing.json" }), "invalid");
      assert.equal(access.currentOutboxDeliveryStatus({ ...retryInput, storage_entry_name: "../unsafe.json" }), "invalid");
      assert.equal(access.currentOutboxDeliveryStatus({ ...retryInput, json: deliveryInput(runId, input.state_revision, "tampered").json }), "invalid");
      assert.equal(access.currentOutboxDeliveryStatus({ ...retryInput, lane: "outbox" }), "invalid");
      assert.equal(access.currentOutboxDeliveryStatus({ ...retryInput, extra: true } as never), "invalid");
    } finally {
      runtime.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("currentOutboxDeliveryStatus rejects valid-looking unindexed files and stale, tampered, or cross-root input", () => {
  const root = makeProject("omp-cto-delivery-guard-negative-");
  const otherRoot = makeProject("omp-cto-delivery-guard-other-");
  try {
    const runId = "delivery-negative";
    const state = makeState(runId);
    writeCtoState(state, root, { preCommit: ({ pinnedRoot }) => pinnedRoot.assertStable() });
    const otherRunId = "cross-root";
    const otherState = makeState(otherRunId);
    writeCtoState(otherState, otherRoot, { preCommit: ({ pinnedRoot }) => pinnedRoot.assertStable() });
    const { runtime, access } = openAccess(root);
    const { runtime: otherRuntime, access: otherAccess } = openAccess(otherRoot);
    try {
      const input = deliveryInput(runId, state.state_revision as number);
      const outboxDir = join(root, ".work-state", "cto", runId, "outbox");
      mkdirSync(outboxDir);
      writeFileSync(join(outboxDir, input.entry_name), input.json);
      assert.equal(access.currentOutboxDeliveryStatus(input), "invalid");
      const indexPath = join(root, ".work-state", "cto", CTO_RUN_DELIVERY_INDEX_FILE);
      const beforeReadIndex = readFileSync(indexPath, "utf8");
      access.readActiveDeliveryCandidates();
      access.readCompletedDeliveryCandidates();
      access.readDeliveryIndexPage();
      assert.equal(readFileSync(indexPath, "utf8"), beforeReadIndex, "read APIs must not promote forged queue evidence");
      rmSync(join(outboxDir, input.entry_name), { force: true });

      assert.ok(publishWithObligation(root, access, input));
      assert.equal(access.currentOutboxDeliveryStatus(input), "current");
      const canonicalPath = join(outboxDir, input.entry_name);
      const substituted = deliveryInput(runId, input.state_revision, "substituted-body").json;
      writeFileSync(canonicalPath, substituted);
      assert.equal(access.currentOutboxDeliveryStatus({ ...input, json: substituted }), "invalid", "same id/run/revision with substituted body is not an authenticated publication");
      writeFileSync(canonicalPath, input.json);
      assert.equal(access.currentOutboxDeliveryStatus(input), "current", "restoring the committed payload re-enables deterministic retry");
      const authorityPath = join(root, ".work-state", "cto", runId, ".outbox-publication-authority.json");
      const authorityBefore = readFileSync(authorityPath, "utf8");
      const indexBefore = readFileSync(indexPath, "utf8");
      const forgedAuthority = JSON.parse(authorityBefore) as { entries: Array<{ bytes_length: number; bytes_sha256: string; proof: string }> };
      forgedAuthority.entries[0]!.bytes_length = Buffer.byteLength(substituted, "utf8");
      forgedAuthority.entries[0]!.bytes_sha256 = createHash("sha256").update(substituted, "utf8").digest("hex");
      const forgedIndex = JSON.parse(indexBefore) as { entries: Array<{ pending_outbox: boolean }> };
      forgedIndex.entries[0]!.pending_outbox = false;
      writeFileSync(authorityPath, JSON.stringify(forgedAuthority, null, 2) + "\n");
      writeFileSync(indexPath, JSON.stringify(forgedIndex, null, 2) + "\n");
      writeFileSync(canonicalPath, substituted);
      assert.equal(access.currentOutboxDeliveryStatus({ ...input, json: substituted }), "invalid", "payload without its state obligation is rejected");
      writeFileSync(authorityPath, authorityBefore);
      writeFileSync(indexPath, indexBefore);
      writeFileSync(canonicalPath, input.json);
      assert.equal(access.currentOutboxDeliveryStatus({ ...input, state_revision: input.state_revision + 1 }), "invalid");
      assert.equal(access.currentOutboxDeliveryStatus({ ...input, json: deliveryInput(runId, input.state_revision, "tampered").json }), "invalid");
      assert.equal(access.currentOutboxDeliveryStatus({ ...input, entry_name: canonicalDurableIdFileName(`${runId}/wave/w1/other`) }), "invalid");
      assert.equal(access.currentOutboxDeliveryStatus({ ...input, run_id: "other-run" }), "invalid");
      assert.equal(access.currentOutboxDeliveryStatus({ ...input, lane: "retry" }), "invalid");
      assert.equal(readFileSync(join(outboxDir, input.entry_name), "utf8"), input.json);
      assert.equal(access.currentOutboxDeliveryStatus({ ...input, lane: "invalid" } as never), "invalid");
      assert.equal(access.currentOutboxDeliveryStatus({ ...input, json: new Uint8Array([0xff, 0xfe]) }), "invalid");

      const crossRootInput = deliveryInput(otherRunId, otherState.state_revision as number);
      assert.ok(publishWithObligation(otherRoot, otherAccess, crossRootInput));
      assert.equal(access.currentOutboxDeliveryStatus(crossRootInput), "unavailable");

      const prototype = PinnedProjectRoot.prototype as unknown as {
        readFile: (relativeFile: string, options?: { maxBytes?: number }) => { bytes: Uint8Array; dev: number; ino: number };
      };
      const originalReadFile = prototype.readFile;
      prototype.readFile = function (relativeFile, options) {
        if (relativeFile.endsWith("state.json")) throw new Error("state authority read outage");
        return originalReadFile.call(this, relativeFile, options);
      };
      try {
        assert.equal(access.currentOutboxDeliveryStatus(input), "unavailable");
      } finally {
        prototype.readFile = originalReadFile;
      }
      prototype.readFile = function (relativeFile, options) {
        if (relativeFile.endsWith(CTO_RUN_DELIVERY_INDEX_FILE)) throw new Error("index authority read outage");
        return originalReadFile.call(this, relativeFile, options);
      };
      try {
        assert.equal(access.currentOutboxDeliveryStatus(input), "unavailable");
      } finally {
        prototype.readFile = originalReadFile;
      }
      assert.equal(access.currentOutboxDeliveryStatus(input), "current");
    } finally {
      runtime.close();
      otherRuntime.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(otherRoot, { recursive: true, force: true });
  }
});

test("publication proof fails closed after process restart and preserves pending evidence", () => {
  const root = makeProject("omp-cto-delivery-restart-");
  try {
    const runId = "delivery-restart";
    const state = makeState(runId);
    writeCtoState(state, root, { preCommit: ({ pinnedRoot }) => pinnedRoot.assertStable() });
    const input = deliveryInput(runId, state.state_revision as number);
    const { runtime, access } = openAccess(root);
    try {
      assert.ok(publishWithObligation(root, access, input));
      const outboxPath = join(root, ".work-state", "cto", runId, "outbox", input.entry_name);
      const indexPath = join(root, ".work-state", "cto", CTO_RUN_DELIVERY_INDEX_FILE);
    const stateUrl = new URL("../src/cto/state.ts", import.meta.url).href;
    const pinnedRootUrl = new URL("../src/specification/pinned-root.ts", import.meta.url).href;
    const script = `import { currentOutboxDeliveryStatusPinned } from ${JSON.stringify(stateUrl)}; import { PinnedProjectRoot } from ${JSON.stringify(pinnedRootUrl)}; const root = PinnedProjectRoot.open(${JSON.stringify(root)}); if (!root) process.exit(3); const result = currentOutboxDeliveryStatusPinned(${JSON.stringify(input)}, root); root.close(); process.stdout.write(result);`;
    const child = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], { cwd: process.cwd(), encoding: "utf8" });
    assert.equal(child.status, 0, child.stderr);
    assert.equal(child.stdout.trim(), "recovery_required", "a fresh process reports explicit recovery instead of silently retrying");
    assert.equal(readFileSync(outboxPath, "utf8"), input.json, "restart verification must not rewrite the committed payload");
    const pending = JSON.parse(readFileSync(indexPath, "utf8")) as { entries: Array<{ run_id: string; pending_outbox: boolean }> };
    assert.equal(pending.entries.find((entry) => entry.run_id === runId)?.pending_outbox, true, "restart verification must preserve pending delivery");
    const recoveryScript = `import { currentOutboxDeliveryStatusPinned, publishCtoOutboxDelivery } from ${JSON.stringify(stateUrl)}; import { PinnedProjectRoot } from ${JSON.stringify(pinnedRootUrl)}; const root = PinnedProjectRoot.open(${JSON.stringify(root)}); if (!root) process.exit(3); const publishInput = ${JSON.stringify({ run_id: input.run_id, state_revision: input.state_revision, entry_name: input.entry_name, json: input.json })}; const statusInput = ${JSON.stringify(input)}; const published = publishCtoOutboxDelivery(${JSON.stringify(root)}, publishInput, root); const status = currentOutboxDeliveryStatusPinned(statusInput, root); root.close(); process.stdout.write(String(published) + ":" + status);`;
    const recovery = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", recoveryScript], { cwd: process.cwd(), encoding: "utf8" });
    assert.equal(recovery.status, 0, recovery.stderr);
    assert.equal(recovery.stdout.trim(), "null:recovery_required", "a fresh process cannot re-sign the prior process-scoped proof");
      } finally {
        runtime.close();
      }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("routing configuration replacement blocks a published delivery", () => {
  const root = makeProject("omp-cto-delivery-routing-");
  try {
    const runId = "delivery-routing";
    const state = makeState(runId);
    writeCtoState(state, root, { preCommit: ({ pinnedRoot }) => pinnedRoot.assertStable() });
    const input = deliveryInput(runId, state.state_revision as number);
    const rootIdentity = PinnedProjectRoot.open(root);
    assert.ok(rootIdentity);
    const oldRouting = { config_sha256: "a".repeat(64), snapshot_sha256: "b".repeat(64), channel: "http:primary", target: "https://old.example/topic", canonical_root: rootIdentity.canonical_root, root_dev: rootIdentity.dev, root_ino: rootIdentity.ino } as const;
    const { runtime, access } = openAccess(root);
    try {
      const routedInput = { ...input, routing_binding: oldRouting };
      assert.ok(publishWithObligation(root, access, routedInput));
      Object.assign(input as unknown as Record<string, unknown>, routedInput);
      assert.equal(access.currentOutboxDeliveryStatus(routedInput), "current");
      const replacementRouting = { ...oldRouting, config_sha256: "c".repeat(64), snapshot_sha256: "d".repeat(64), target: "https://replacement.example/topic" } as const;
      assert.equal(access.currentOutboxDeliveryStatus({ ...input, routing_binding: replacementRouting }), "unavailable", "a changed routing snapshot cannot authorize the old publication");
      assert.equal(access.currentOutboxDeliveryStatus({ ...input, routing_binding: oldRouting }), "current", "the original receipt remains usable until a trusted republish");
    } finally {
      runtime.close();
      rootIdentity.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("readCompletedDeliveryIndexPage paginates acknowledged terminal entries beyond one page", () => {
  const root = makeProject("omp-cto-completed-page-");
  try {
    const seed = makeState("seed");
    writeCtoState(seed, root, { preCommit: ({ pinnedRoot }) => pinnedRoot.assertStable() });
    const entries = Array.from({ length: 70 }, (_, index) => ({
      run_id: `completed-${String(index).padStart(3, "0")}`,
      state_revision: 1,
      status: "done" as const,
      updated_at: new Date(index).toISOString(),
      pending_summary: false,
      pending_outbox: false,
      pending_retry: false,
      summary_digest: "",
    }));
    writeFileSync(join(root, ".work-state", "cto", CTO_RUN_DELIVERY_INDEX_FILE), JSON.stringify({ schema_version: 2, active_run_id: null, entries }) + "\n");
    const { runtime, access } = openAccess(root);
    try {
      const first = access.readCompletedDeliveryIndexPage({ limit: 64 });
      assert.equal(Object.isFrozen(first), true);
      assert.equal(Object.isFrozen(first.entries), true);
      assert.equal(first.entries.length, 64);
      assert.equal(first.next_after_run_id, "completed-063");
      const second = access.readCompletedDeliveryIndexPage({ after_run_id: first.next_after_run_id!, limit: 64 });
      assert.equal(second.entries.length, 6);
      assert.equal(second.next_after_run_id, null);
      assert.deepEqual([...first.entries, ...second.entries].map((entry) => entry.run_id), entries.map((entry) => entry.run_id));
      assert.throws(() => access.readCompletedDeliveryIndexPage({ after_run_id: "../unsafe" }), (error: unknown) => error instanceof CtoRuntimeAccessError && error.code === "runtime_access_invalid");
      assert.throws(() => access.readCompletedDeliveryIndexPage({ limit: 0 }), (error: unknown) => error instanceof CtoRuntimeAccessError && error.code === "runtime_access_invalid");
    } finally {
      runtime.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});


test("delivery lane marking preserves opposite pending flags for concurrent publications", () => {
  const root = makeProject("omp-cto-delivery-lanes-");
  try {
    const firstState = makeState("lane-first");
    const secondState = makeState("lane-second");
    writeCtoState(firstState, root, { preCommit: ({ pinnedRoot }) => pinnedRoot.assertStable() });
    writeCtoState(secondState, root, { preCommit: ({ pinnedRoot }) => pinnedRoot.assertStable() });
    const { runtime, access } = openAccess(root);
    try {
      const first = deliveryInput(firstState.id, firstState.state_revision as number);
      const second = deliveryInput(secondState.id, secondState.state_revision as number);
      assert.ok(publishWithObligation(root, access, first));
      assert.ok(publishWithObligation(root, access, second));
      assert.equal(access.currentOutboxDeliveryStatus(first), "current");
      assert.equal(access.currentOutboxDeliveryStatus(second), "current");
      const retryName = "r2-retry.json";
      const firstOutbox = join(root, ".work-state", "cto", firstState.id, "outbox", first.entry_name);
      const firstRetry = join(root, ".work-state", "cto", firstState.id, "outbox-retry", retryName);
      mkdirSync(join(root, ".work-state", "cto", firstState.id, "outbox-retry"));
      renameSync(firstOutbox, firstRetry);
      assert.equal(access.markDeliveryPending(firstState.id, first.state_revision, "retry"), true);
      const pending = access.readDeliveryIndexPage();
      assert.deepEqual(pending.entries.map((entry) => entry.run_id), [firstState.id, secondState.id]);
      assert.equal(pending.entries.every((entry) => entry.pending_outbox), true);
      assert.equal(access.currentOutboxDeliveryStatus({ ...first, lane: "retry", storage_entry_name: retryName }), "current");
      assert.equal(access.currentOutboxDeliveryStatus(second), "current");
      assert.equal(access.markDeliveryPending(firstState.id, first.state_revision, "outbox"), true);
      assert.equal(access.currentOutboxDeliveryStatus({ ...first, lane: "retry", storage_entry_name: retryName }), "current");
      rmSync(firstRetry, { force: true });
      rmSync(join(root, ".work-state", "cto", secondState.id, "outbox", second.entry_name), { force: true });
      assert.equal(access.removeOutboxDeliveryObligation(firstState.id, first.entry_name, (JSON.parse(String(first.json)) as { id: string }).id), true);
      assert.equal(access.removeOutboxDeliveryObligation(secondState.id, second.entry_name, (JSON.parse(String(second.json)) as { id: string }).id), true);
      const firstDrained = access.readState(firstState.id);
      const secondDrained = access.readState(secondState.id);
      assert.ok(firstDrained && secondDrained);
      assert.equal(access.acknowledgeDelivery(firstState.id, firstDrained!.state_revision), true);
      assert.equal(access.acknowledgeDelivery(secondState.id, secondDrained!.state_revision), true);
      assert.deepEqual(access.readDeliveryIndexPage().entries, []);
    } finally {
      runtime.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});


test("terminal runs accept only current ACK deliveries in addition to deterministic summaries", () => {
  const root = makeProject("omp-cto-terminal-ack-");
  try {
    const active = makeState("active-ack");
    writeCtoState(active, root, { preCommit: ({ pinnedRoot }) => pinnedRoot.assertStable() });
    const activeAck = ackInput(active.id, active.state_revision as number);
    const { runtime, access } = openAccess(root);
    try {
      assert.ok(publishWithObligation(root, access, activeAck));
      assert.equal(access.currentOutboxDeliveryStatus(activeAck), "current");

      const terminal = makeState("terminal-ack");
      writeCtoState(terminal, root, { preCommit: ({ pinnedRoot }) => pinnedRoot.assertStable() });
      setCtoPause(terminal, "done", "terminal ACK test");
      writeCtoState(terminal, root, { preCommit: ({ pinnedRoot }) => pinnedRoot.assertStable() });
      const current = readCtoState(terminal.id, root);
      assert.ok(current);
      const terminalAck = ackInput(terminal.id, current!.state_revision as number);
      assert.ok(publishWithObligation(root, access, terminalAck));
      assert.equal(access.currentOutboxDeliveryStatus(terminalAck), "current");
      assert.equal(rawPublishCtoOutboxDelivery(root, ackInput(terminal.id, (current!.state_revision as number) - 1)), null);
      assert.equal(rawPublishCtoOutboxDelivery(root, ackInput(terminal.id, current!.state_revision as number, "question")), null);
      assert.equal(rawPublishCtoOutboxDelivery(root, ackInput(terminal.id, current!.state_revision as number, "progress")), null);
      assert.equal(rawPublishCtoOutboxDelivery(root, ackInput(terminal.id, current!.state_revision as number, "ack", "wrong-target")), null);
    } finally {
      runtime.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
