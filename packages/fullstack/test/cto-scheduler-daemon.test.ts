/* <!-- omp-cto-slice run=01a03ee4-7dd6-7580-8ad7-16d26dc886ba slice=workflow-v2-fullstack --> */

import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createDescriptorRelativeFsAuthority,
  createWorkflowV2Digest,
  type ActualAgentInventory,
  type AgentInventoryAuthority,
  type AgentInventoryAuthorityContext,
  type AgentRef,
  type CtoState,
  type DiagnosticResult,
  type WorkflowV2Digest,
  type WorkflowV2Diagnostic,
} from "@andvl1/omp-workflows-core";
import { createFullstackStorageAuthority } from "../src/storage-authority.js";
import { createTestFullstackInventoryAdmissionContext } from "../src/agent-mapping.js";
import { startCtoSchedulerDaemon, type CtoSchedulerDaemonHandle, type SchedulerAdmission } from "../src/cto-scheduler-daemon.js";
import { runtimeFixture, type RuntimeFixture } from "./runtime-fixtures.js";
const MAX_DATE_TIME_MS = 8_640_000_000_000_000;

function digest(seed: string): WorkflowV2Digest {
  const value = createWorkflowV2Digest(`sha256:${createHash("sha256").update(seed, "utf8").digest("hex")}`);
  if (!value) throw new Error("test digest should be valid");
  return value;
}

function schedulerAdmission(fixture: RuntimeFixture): SchedulerAdmission {
  const agent: AgentRef = Object.freeze({
    registered_name: "analyst",
    provider_id: fixture.project_identity.provider_id,
    source_fingerprint: digest("scheduler-agent"),
  });
  const actual: ActualAgentInventory = Object.freeze({
    authority: "omp",
    provider_id: fixture.project_identity.provider_id,
    descriptor_fingerprint: fixture.project_identity.descriptor_fingerprint,
    agents: Object.freeze([agent]),
    inventory_fingerprint: digest(JSON.stringify([{
      provider_id: agent.provider_id,
      registered_name: agent.registered_name,
      source_fingerprint: agent.source_fingerprint,
    }])),
    reservation: Object.freeze({
      reservation_id: "scheduler-reservation",
      fingerprint: digest("scheduler-reservation"),
    }),
  });
  const authority: AgentInventoryAuthority = {
    resolve: () => ({ ok: true, value: actual, diagnostics: [] }),
  };
  const authorityContext = Object.freeze({
    canonical_root: fixture.project_root,
    session: fixture.project_identity.session,
    provider_id: fixture.project_identity.provider_id,
    descriptor_fingerprint: fixture.project_identity.descriptor_fingerprint,
    descriptor: Object.freeze({}),
    catalog: Object.freeze({}),
    effective_policy: Object.freeze({}),
  }) as unknown as AgentInventoryAuthorityContext;
  const inventory_admission = createTestFullstackInventoryAdmissionContext({
    project_identity: fixture.project_identity,
    run_identity: fixture.run_identity,
    canonical_root: fixture.project_root,
    agent_inventory: actual,
    agent_inventory_authority: authority,
    authority_context: authorityContext,
  });
  if (!inventory_admission) throw new Error("test scheduler admission should be issued");
  return {
    inventory_admission,
    filesystem_authority: fixture.context.filesystem_authority,
    storage: fixture.storage,
  };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function preparedState(fixture: RuntimeFixture, scheduler: CtoState["scheduler"] | null = { wave_interval_ms: 30 }): CtoState {
  const now = new Date().toISOString();
  return {
    schema: 2,
    id: fixture.run_identity.run_id,
    task: "Scheduler task",
    branch: "main",
    autonomous: true,
    run_identity: fixture.run_identity,
    plan: { id: fixture.run_identity.run_id, task: "Scheduler task", teams: [], created_at: now, run_identity: fixture.run_identity },
    teams: [],
    integration: { status: "pending" },
    pause: { kind: "none", reason: "" },
    ...(scheduler === null ? {} : { scheduler }),
  } as CtoState;
}

function persistState(fixture: RuntimeFixture, state: CtoState): void {
  const relativePath = `.work-state/cto/${fixture.run_identity.run_id}/state.json`;
  const bytes = new TextEncoder().encode(JSON.stringify(state, null, 2));
  const persisted = fixture.storage.writeAtomic(relativePath, bytes, 4 * 1024 * 1024);
  if (!persisted.ok) throw new Error(`failed to persist scheduler fixture: ${persisted.reason}`);
}

function readPersistedState(fixture: RuntimeFixture): CtoState {
  return JSON.parse(
    readFileSync(join(fixture.project_root, ".work-state", "cto", fixture.run_identity.run_id, "state.json"), "utf8"),
  ) as CtoState;
}

test("cto-scheduler-daemon: explicit enabled state fires and stamps last/next", async () => {
  const root = mkdtempSync(join(tmpdir(), "cto-daemon-"));
  try {
    const fixture = runtimeFixture(root, { runId: "daemon-run-1" });
    const state = preparedState(fixture, { wave_interval_ms: 30 });
    persistState(fixture, state);
    let waves = 0;
    const started = startCtoSchedulerDaemon({
      project_root: fixture.project_root,
      run_identity: fixture.run_identity,
      state,
      filesystem_authority: fixture.context.filesystem_authority,
      storage: fixture.storage,
      admission: schedulerAdmission(fixture),
      intervalMs: 30,
      onWave: () => { waves += 1; },
    });
    assert.equal(started.ok, true);
    if (!started.ok) return;
    try {
      await delay(200);
      assert.ok(waves >= 1, `onWave should fire at least once (got ${waves})`);
    } finally {
      started.value.stop();
    }
    const afterStop = waves;
    await delay(150);
    assert.equal(waves, afterStop, "no waves after stop()");
    const persisted = readPersistedState(fixture);
    assert.equal(persisted.run_identity?.run_id, "daemon-run-1", "scheduler preserves the exact run identity");
    assert.equal(persisted.scheduler?.wave_interval_ms, 30);
    assert.equal(typeof persisted.scheduler?.last_wave_at, "string");
    assert.equal(typeof persisted.scheduler?.next_wave_at, "string");
    const last = Date.parse(persisted.scheduler?.last_wave_at ?? "");
    const next = Date.parse(persisted.scheduler?.next_wave_at ?? "");
    assert.ok(Number.isFinite(last));
    assert.ok(Number.isFinite(next));
    assert.ok(next >= last + 30, "next_wave_at is scheduled after last_wave_at");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("cto-scheduler-daemon: canonical disabled state never schedules or invokes", async () => {
  const root = mkdtempSync(join(tmpdir(), "cto-daemon-off-"));
  try {
    const fixture = runtimeFixture(root, { runId: "daemon-off-1" });
    const state = preparedState(fixture, {
      wave_interval_ms: 0,
      last_wave_at: "2026-08-28T00:00:00.000Z",
      next_wave_at: "2026-08-28T00:01:00.000Z",
    });
    persistState(fixture, state);
    const before = readFileSync(join(root, ".work-state", "cto", "daemon-off-1", "state.json"), "utf8");
    let waves = 0;
    const result = startCtoSchedulerDaemon({
      project_root: fixture.project_root,
      run_identity: fixture.run_identity,
      state,
      filesystem_authority: fixture.context.filesystem_authority,
      storage: fixture.storage,
      admission: schedulerAdmission(fixture),
      intervalMs: 30,
      onWave: () => { waves += 1; },
    });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    await delay(120);
    result.value.stop();
    assert.equal(waves, 0);
    const after = readFileSync(join(root, ".work-state", "cto", "daemon-off-1", "state.json"), "utf8");
    assert.equal(after, before, "disabled canonical scheduler state is not rewritten");
    assert.equal(existsSync(join(root, ".omp", "cto-scheduler.lock")), false, "disabled scheduler does not acquire a lease");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("cto-scheduler-daemon: missing scheduler is initialized from the explicit interval", async () => {
  const root = mkdtempSync(join(tmpdir(), "cto-daemon-initial-"));
  try {
    const fixture = runtimeFixture(root, { runId: "daemon-initial-1" });
    const state = preparedState(fixture, null);
    persistState(fixture, state);
    let waves = 0;
    const started = startCtoSchedulerDaemon({
      project_root: fixture.project_root,
      run_identity: fixture.run_identity,
      state,
      filesystem_authority: fixture.context.filesystem_authority,
      storage: fixture.storage,
      admission: schedulerAdmission(fixture),
      intervalMs: 30,
      onWave: () => { waves += 1; },
    });
    assert.equal(started.ok, true);
    if (!started.ok) return;
    const initialized = readPersistedState(fixture);
    assert.equal(initialized.scheduler?.wave_interval_ms, 30);
    try {
      await delay(120);
      assert.ok(waves >= 1, "an initialized enabled scheduler eventually runs its first due wave");
    } finally {
      started.value.stop();
    }
    const persisted = readPersistedState(fixture);
    assert.equal(typeof persisted.scheduler?.last_wave_at, "string");
    assert.equal(typeof persisted.scheduler?.next_wave_at, "string");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("cto-scheduler-daemon: fresh last_wave_at defers despite next_wave_at", async () => {
  const root = mkdtempSync(join(tmpdir(), "cto-daemon-fresh-"));
  try {
    const fixture = runtimeFixture(root, { runId: "daemon-fresh-1" });
    const last = new Date().toISOString();
    const next = new Date(Date.now() + 5_000).toISOString();
    const state = preparedState(fixture, { wave_interval_ms: 5_000, last_wave_at: last, next_wave_at: next });
    persistState(fixture, state);
    let waves = 0;
    const started = startCtoSchedulerDaemon({
      project_root: fixture.project_root,
      run_identity: fixture.run_identity,
      state,
      filesystem_authority: fixture.context.filesystem_authority,
      storage: fixture.storage,
      admission: schedulerAdmission(fixture),
      intervalMs: 15,
      onWave: () => { waves += 1; },
    });
    assert.equal(started.ok, true);
    if (!started.ok) return;
    try {
      await delay(100);
      assert.equal(waves, 0, "fresh last_wave_at keeps the wave not due");
      const persisted = readPersistedState(fixture);
      assert.equal(persisted.scheduler?.last_wave_at, last);
      assert.equal(persisted.scheduler?.next_wave_at, next);
    } finally {
      started.value.stop();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("cto-scheduler-daemon: failed post-wave persistence stops and diagnoses without duplicate waves", async () => {
  const root = mkdtempSync(join(tmpdir(), "cto-daemon-persist-failure-"));
  try {
    const fixture = runtimeFixture(root, { runId: "daemon-persist-failure-1" });
    const state = preparedState(fixture, { wave_interval_ms: 10 });
    const statePath = `.work-state/cto/${fixture.run_identity.run_id}/state.json`;
    let failPostWaveWrite = false;
    let releaseCount = 0;
    const storageResult = createFullstackStorageAuthority({
      project_root: fixture.project_root,
      run_identity: fixture.run_identity,
      filesystem_authority: fixture.context.filesystem_authority,
      native: {
        canonical_root: fixture.project_root,
        run_identity: fixture.run_identity,
        readBounded: (relativePath, maxBytes) => fixture.storage.readBounded(relativePath, maxBytes),
        readTextBounded: (relativePath, maxBytes) => fixture.storage.readTextBounded(relativePath, maxBytes),
        statBounded: (relativePath) => fixture.storage.statBounded(relativePath),
        writeExclusive: (relativePath, bytes, _mode = 0o600) => fixture.storage.writeExclusive(relativePath, bytes, 4 * 1024 * 1024),
        writeAtomic: (relativePath, bytes, maxBytes) => {
          if (failPostWaveWrite && relativePath === statePath) {
            return { ok: false as const, reason: "IO" as const, code: "IO" as const, message: "intentional test failure" };
          }
          return fixture.storage.writeAtomic(relativePath, bytes, maxBytes);
        },
        appendJsonLineBounded: (relativePath, bytes, maxBytes) => fixture.storage.appendJsonLineBounded(relativePath, bytes, maxBytes),
        listBounded: (relativePath, maxEntries) => fixture.storage.listBounded(relativePath, maxEntries),
        moveExclusive: (sourceRelativePath, targetRelativePath) => fixture.storage.moveExclusive(sourceRelativePath, targetRelativePath),
        removeIfOwned: (relativePath, identity) => fixture.storage.removeIfOwned(relativePath, identity),
        acquireLease: (relativePath, identity) => fixture.storage.acquireLease(relativePath, identity),
        releaseLease: (relativePath, identity) => {
          releaseCount += 1;
          return fixture.storage.releaseLease(relativePath, identity);
        },
      },
    });
    assert.equal(storageResult.ok, true);
    if (!storageResult.ok) return;
    const storage = storageResult.value;
    const initialWrite = storage.writeAtomic(
      statePath,
      new TextEncoder().encode(JSON.stringify(state, null, 2)),
      4 * 1024 * 1024,
    );
    assert.equal(initialWrite.ok, true);
    failPostWaveWrite = true;

    let waves = 0;
    const diagnostics: WorkflowV2Diagnostic[] = [];
    const started = startCtoSchedulerDaemon({
      project_root: fixture.project_root,
      run_identity: fixture.run_identity,
      state,
      filesystem_authority: fixture.context.filesystem_authority,
      storage,
      admission: { ...schedulerAdmission(fixture), storage },
      intervalMs: 10,
      onWave: () => { waves += 1; },
      onDiagnostic: (diagnostic) => { diagnostics.push(diagnostic); },
    });
    assert.equal(started.ok, true);
    if (!started.ok) return;
    try {
      await delay(120);
      assert.equal(waves, 1, "a failed post-wave write must not permit a duplicate wave");
      assert.equal(releaseCount, 1, "the failed persistence path releases its lease exactly once");
      assert.equal(diagnostics.length, 1);
      assert.deepEqual(diagnostics[0], {
        code: "ACTIVATION_FAILED",
        operation: "runtime.activate",
        severity: "error",
        evidence: { field: "scheduler.state" },
        remediation: "The scheduler stopped because its post-wave state could not be persisted; restore writable identity-bound storage before restarting.",
      });
      assert.equal(existsSync(join(root, ".omp", "cto-scheduler.lock")), false, "failed persistence stops and releases the scheduler lease");
      const afterStop = waves;
      await delay(100);
      assert.equal(waves, afterStop, "the stopped scheduler cannot invoke another wave");
      assert.equal(readPersistedState(fixture).scheduler?.last_wave_at, undefined, "failed persistence leaves canonical state unchanged");
    } finally {
      started.value.stop();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});


test("cto-scheduler-daemon: non-positive interval is rejected without state discovery or writes", () => {
  const root = mkdtempSync(join(tmpdir(), "cto-daemon-off-"));
  try {
    const fixture = runtimeFixture(root, { runId: "daemon-off-1" });
    const state = preparedState(fixture);
    const result = startCtoSchedulerDaemon({
      project_root: fixture.project_root,
      run_identity: fixture.run_identity,
      state,
      filesystem_authority: fixture.context.filesystem_authority,
      storage: fixture.storage,
      admission: schedulerAdmission(fixture),
      intervalMs: 0,
      onWave: () => {},
    });
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.diagnostics[0]?.code, "ACTIVATION_FAILED");
    assert.equal(existsSync(join(root, ".work-state", "cto", "daemon-off-1", "state.json")), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("cto-scheduler-daemon: Date-unsafe admission intervals fail before scheduler effects", () => {
  for (const [label, intervalMs] of [
    ["max-value", Number.MAX_VALUE],
    ["max-safe", Number.MAX_SAFE_INTEGER],
  ] as const) {
    const root = mkdtempSync(join(tmpdir(), `cto-daemon-unsafe-${label}-`));
    try {
      const fixture = runtimeFixture(root, { runId: `daemon-unsafe-${label}` });
      const state = preparedState(fixture, { wave_interval_ms: 30 });
      persistState(fixture, state);
      const statePath = join(root, ".work-state", "cto", `daemon-unsafe-${label}`, "state.json");
      const before = readFileSync(statePath, "utf8");
      let waves = 0;
      let timerCalls = 0;
      const originalSetInterval = globalThis.setInterval;
      globalThis.setInterval = ((_callback: Parameters<typeof setInterval>[0], _delay?: number) => {
        timerCalls += 1;
        return {} as NodeJS.Timeout;
      }) as typeof setInterval;
      let result: DiagnosticResult<CtoSchedulerDaemonHandle>;
      try {
        result = startCtoSchedulerDaemon({
          project_root: fixture.project_root,
          run_identity: fixture.run_identity,
          state,
          filesystem_authority: fixture.context.filesystem_authority,
          storage: fixture.storage,
          admission: schedulerAdmission(fixture),
          intervalMs,
          onWave: () => { waves += 1; },
        });
      } finally {
        globalThis.setInterval = originalSetInterval;
      }
      assert.equal(result.ok, false, `${label} must be rejected`);
      if (!result.ok) {
        assert.equal(result.diagnostics[0]?.code, "ACTIVATION_FAILED");
        assert.deepEqual(result.diagnostics[0]?.evidence, { field: "scheduler.intervalMs" });
      }
      assert.equal(waves, 0);
      assert.equal(timerCalls, 0, "rejected admission must not create a timer");
      assert.equal(readFileSync(statePath, "utf8"), before, "rejected admission must not rewrite state");
      assert.equal(existsSync(join(root, ".omp", "cto-scheduler.lock")), false, "rejected admission must not acquire a lease");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

test("cto-scheduler-daemon: Date-unsafe persisted intervals fail before wave, lease, or timer effects", () => {
  for (const [label, intervalMs] of [
    ["max-value", Number.MAX_VALUE],
    ["max-safe", Number.MAX_SAFE_INTEGER],
  ] as const) {
    const root = mkdtempSync(join(tmpdir(), `cto-daemon-persisted-unsafe-${label}-`));
    try {
      const fixture = runtimeFixture(root, { runId: `daemon-persisted-unsafe-${label}` });
      const state = preparedState(fixture, { wave_interval_ms: intervalMs });
      persistState(fixture, state);
      const statePath = join(root, ".work-state", "cto", `daemon-persisted-unsafe-${label}`, "state.json");
      const before = readFileSync(statePath, "utf8");
      let waves = 0;
      let timerCalls = 0;
      const originalSetInterval = globalThis.setInterval;
      globalThis.setInterval = ((_callback: Parameters<typeof setInterval>[0], _delay?: number) => {
        timerCalls += 1;
        return {} as NodeJS.Timeout;
      }) as typeof setInterval;
      let result: DiagnosticResult<CtoSchedulerDaemonHandle>;
      try {
        result = startCtoSchedulerDaemon({
          project_root: fixture.project_root,
          run_identity: fixture.run_identity,
          state,
          filesystem_authority: fixture.context.filesystem_authority,
          storage: fixture.storage,
          admission: schedulerAdmission(fixture),
          intervalMs: 30,
          onWave: () => { waves += 1; },
        });
      } finally {
        globalThis.setInterval = originalSetInterval;
      }
      assert.equal(result.ok, false, `${label} persisted interval must be rejected`);
      if (!result.ok) {
        assert.equal(result.diagnostics[0]?.code, "ACTIVATION_FAILED");
        assert.deepEqual(result.diagnostics[0]?.evidence, { field: "scheduler.wave_interval_ms" });
      }
      assert.equal(waves, 0);
      assert.equal(timerCalls, 0, "rejected persisted interval must not create a timer");
      assert.equal(readFileSync(statePath, "utf8"), before, "rejected persisted interval must not rewrite state");
      assert.equal(existsSync(join(root, ".omp", "cto-scheduler.lock")), false, "rejected persisted interval must not acquire a lease");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

test("cto-scheduler-daemon: Date boundary interval is accepted and timer cadence remains clamped", () => {
  const root = mkdtempSync(join(tmpdir(), "cto-daemon-date-boundary-"));
  const originalDateNow = Date.now;
  const originalSetInterval = globalThis.setInterval;
  const originalClearInterval = globalThis.clearInterval;
  let scheduled: (() => void) | undefined;
  let timerDelay: number | undefined;
  let clearCalls = 0;
  globalThis.setInterval = ((callback: Parameters<typeof setInterval>[0], delay?: number) => {
    scheduled = callback as unknown as () => void;
    timerDelay = delay;
    return {} as NodeJS.Timeout;
  }) as typeof setInterval;
  globalThis.clearInterval = ((_timer: NodeJS.Timeout | undefined) => {
    clearCalls += 1;
  }) as typeof clearInterval;
  Date.now = () => 0;
  try {
    const fixture = runtimeFixture(root, { runId: "daemon-date-boundary-1" });
    const state = preparedState(fixture, { wave_interval_ms: MAX_DATE_TIME_MS });
    persistState(fixture, state);
    let waves = 0;
    const started = startCtoSchedulerDaemon({
      project_root: fixture.project_root,
      run_identity: fixture.run_identity,
      state,
      filesystem_authority: fixture.context.filesystem_authority,
      storage: fixture.storage,
      admission: schedulerAdmission(fixture),
      intervalMs: MAX_DATE_TIME_MS,
      onWave: () => { waves += 1; },
    });
    assert.equal(started.ok, true);
    assert.equal(timerDelay, 86_400_000, "Date-safe interval must still use the one-day timer cadence clamp");
    assert.ok(scheduled, "accepted scheduler must install a timer callback");
    if (!started.ok || !scheduled) return;
    scheduled();
    assert.equal(waves, 1, "boundary-safe interval must execute its due wave");
    started.value.stop();
    assert.equal(clearCalls, 1);
    const persisted = readPersistedState(fixture);
    assert.equal(persisted.scheduler?.last_wave_at, new Date(0).toISOString());
    assert.equal(new Date(persisted.scheduler?.next_wave_at ?? "").getTime(), MAX_DATE_TIME_MS);
  } finally {
    Date.now = originalDateNow;
    globalThis.setInterval = originalSetInterval;
    globalThis.clearInterval = originalClearInterval;
    rmSync(root, { recursive: true, force: true });
  }
});

test("cto-scheduler-daemon: missing onWave fails closed before state, lease, or timer effects", () => {
  const root = mkdtempSync(join(tmpdir(), "cto-daemon-missing-wave-"));
  try {
    const fixture = runtimeFixture(root, { runId: "daemon-missing-wave-1" });
    const state = preparedState(fixture, { wave_interval_ms: 30 });
    persistState(fixture, state);
    const statePath = join(root, ".work-state", "cto", "daemon-missing-wave-1", "state.json");
    const before = readFileSync(statePath, "utf8");
    const result = startCtoSchedulerDaemon({
      project_root: fixture.project_root,
      run_identity: fixture.run_identity,
      state,
      filesystem_authority: fixture.context.filesystem_authority,
      storage: fixture.storage,
      admission: schedulerAdmission(fixture),
      intervalMs: 30,
    } as unknown as Parameters<typeof startCtoSchedulerDaemon>[0]);
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.diagnostics[0]?.code, "CAPABILITY_MISSING");
      assert.deepEqual(result.diagnostics[0]?.evidence, { field: "scheduler.onWave" });
    }
    assert.equal(readFileSync(statePath, "utf8"), before, "missing onWave must not rewrite canonical state");
    assert.equal(existsSync(join(root, ".omp", "cto-scheduler.lock")), false, "missing onWave must not acquire a lease");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("cto-scheduler-daemon: missing pinned storage fails before timer or writes", () => {
  const root = mkdtempSync(join(tmpdir(), "cto-daemon-missing-"));
  try {
    const fixture = runtimeFixture(root, { runId: "daemon-missing-1" });
    const result = startCtoSchedulerDaemon({
      project_root: fixture.project_root,
      run_identity: fixture.run_identity,
      state: preparedState(fixture),
      filesystem_authority: fixture.context.filesystem_authority,
      admission: schedulerAdmission(fixture),
      intervalMs: 30,
      onWave: () => {},
    });
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.diagnostics[0]?.code, "CAPABILITY_MISSING");
    assert.equal(existsSync(join(root, ".work-state")), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("cto-scheduler-daemon: same-run foreign-root admission fails before every scheduler effect", () => {
  const root = mkdtempSync(join(tmpdir(), "cto-daemon-root-admission-"));
  const foreignRoot = mkdtempSync(join(tmpdir(), "cto-daemon-root-admission-foreign-"));
  const originalSetInterval = globalThis.setInterval;
  const effects = {
    filesystem: 0,
    reads: 0,
    writes: 0,
    leaseAcquires: 0,
    leaseReleases: 0,
    inventoryResolves: 0,
    timers: 0,
    waves: 0,
  };
  try {
    const fixture = runtimeFixture(root, { runId: "daemon-root-admission-1" });
    const foreignFixture = runtimeFixture(foreignRoot, { runId: "daemon-root-admission-1" });
    const admitted = schedulerAdmission(fixture).inventory_admission;
    const foreignAuthorityContext = Object.freeze({
      ...admitted.authority_context,
      canonical_root: foreignFixture.project_root,
    });
    const foreignAuthority: AgentInventoryAuthority = {
      resolve: () => {
        effects.inventoryResolves += 1;
        return { ok: true, value: admitted.agent_inventory, diagnostics: [] };
      },
    };
    const foreignInventoryAdmission = createTestFullstackInventoryAdmissionContext({
      project_identity: fixture.project_identity,
      run_identity: fixture.run_identity,
      canonical_root: foreignFixture.project_root,
      agent_inventory: admitted.agent_inventory,
      agent_inventory_authority: foreignAuthority,
      authority_context: foreignAuthorityContext,
    });
    if (!foreignInventoryAdmission) throw new Error("same-run foreign-root test admission should be issued");

    const filesystemAuthority = createDescriptorRelativeFsAuthority({
      native: {
        platform: process.platform === "darwin" ? "darwin" : "linux",
        supportsAtomicCas: true,
        openRoot: () => {
          effects.filesystem += 1;
          return { ok: false as const, reason: "unsupported" as const };
        },
        readBounded: () => {
          effects.filesystem += 1;
          return { ok: false as const, reason: "unsupported" as const };
        },
        inspect: () => {
          effects.filesystem += 1;
          return { ok: false as const, reason: "unsupported" as const };
        },
        openDirectory: () => {
          effects.filesystem += 1;
          return { ok: false as const, reason: "unsupported" as const };
        },
        createTemporary: () => {
          effects.filesystem += 1;
          return { ok: false as const, reason: "unsupported" as const };
        },
        removeTemporary: () => {
          effects.filesystem += 1;
          return { ok: false as const, reason: "unsupported" as const };
        },
        fsyncDirectory: () => {
          effects.filesystem += 1;
          return { ok: false as const, reason: "unsupported" as const };
        },
        atomicReplaceIfCurrent: () => {
          effects.filesystem += 1;
          return { ok: false as const, reason: "unsupported" as const };
        },
        atomicRemoveIfCurrent: () => {
          effects.filesystem += 1;
          return { ok: false as const, reason: "unsupported" as const };
        },
      },
    });
    const storageResult = createFullstackStorageAuthority({
      project_root: fixture.project_root,
      run_identity: fixture.run_identity,
      filesystem_authority: filesystemAuthority,
      native: {
        canonical_root: fixture.project_root,
        run_identity: fixture.run_identity,
        readBounded: (relativePath, maxBytes) => {
          effects.reads += 1;
          return fixture.storage.readBounded(relativePath, maxBytes);
        },
        readTextBounded: (relativePath, maxBytes) => {
          effects.reads += 1;
          return fixture.storage.readTextBounded(relativePath, maxBytes);
        },
        statBounded: (relativePath) => {
          effects.reads += 1;
          return fixture.storage.statBounded(relativePath);
        },
        writeExclusive: (relativePath, bytes, _mode = 0o600) => {
          effects.writes += 1;
          return fixture.storage.writeExclusive(relativePath, bytes, 4 * 1024 * 1024);
        },
        writeAtomic: (relativePath, bytes, maxBytes) => {
          effects.writes += 1;
          return fixture.storage.writeAtomic(relativePath, bytes, maxBytes);
        },
        appendJsonLineBounded: (relativePath, bytes, maxBytes) => {
          effects.writes += 1;
          return fixture.storage.appendJsonLineBounded(relativePath, bytes, maxBytes);
        },
        listBounded: (relativePath, maxEntries) => {
          effects.reads += 1;
          return fixture.storage.listBounded(relativePath, maxEntries);
        },
        moveExclusive: (sourceRelativePath, targetRelativePath) => {
          effects.writes += 1;
          return fixture.storage.moveExclusive(sourceRelativePath, targetRelativePath);
        },
        removeIfOwned: (relativePath, identity) => {
          effects.writes += 1;
          return fixture.storage.removeIfOwned(relativePath, identity);
        },
        acquireLease: (relativePath, identity) => {
          effects.leaseAcquires += 1;
          return fixture.storage.acquireLease(relativePath, identity);
        },
        releaseLease: (relativePath, identity) => {
          effects.leaseReleases += 1;
          return fixture.storage.releaseLease(relativePath, identity);
        },
      },
    });
    assert.equal(storageResult.ok, true);
    if (!storageResult.ok) return;
    const storage = storageResult.value;
    const admission: SchedulerAdmission = {
      inventory_admission: foreignInventoryAdmission,
      filesystem_authority: filesystemAuthority,
      storage,
    };
    const run = fixture.run_identity;
    const state = preparedState(fixture, { wave_interval_ms: 30 });
    globalThis.setInterval = ((_callback: Parameters<typeof setInterval>[0], _delay?: number) => {
      effects.timers += 1;
      return {} as NodeJS.Timeout;
    }) as typeof setInterval;
    let result = startCtoSchedulerDaemon({
      project_root: fixture.project_root,
      run_identity: run,
      state,
      filesystem_authority: filesystemAuthority,
      storage,
      admission,
      intervalMs: 30,
      onWave: () => {
        effects.waves += 1;
      },
    });
    globalThis.setInterval = originalSetInterval;
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.diagnostics[0]?.code, "IDENTITY_MISMATCH");
      assert.deepEqual(result.diagnostics[0]?.evidence, { field: "admission.inventory_admission.canonical_root" });
    }
    assert.deepEqual(effects, {
      filesystem: 0,
      reads: 0,
      writes: 0,
      leaseAcquires: 0,
      leaseReleases: 0,
      inventoryResolves: 0,
      timers: 0,
      waves: 0,
    });

    const mismatchedContextAdmission = {
      ...admitted,
      authority_context: foreignAuthorityContext,
    } as unknown as typeof admitted;
    const contextMismatch: SchedulerAdmission = {
      ...admission,
      inventory_admission: mismatchedContextAdmission,
    };
    globalThis.setInterval = ((_callback: Parameters<typeof setInterval>[0], _delay?: number) => {
      effects.timers += 1;
      return {} as NodeJS.Timeout;
    }) as typeof setInterval;
    result = startCtoSchedulerDaemon({
      project_root: fixture.project_root,
      run_identity: run,
      state,
      filesystem_authority: filesystemAuthority,
      storage,
      admission: contextMismatch,
      intervalMs: 30,
      onWave: () => {
        effects.waves += 1;
      },
    });
    globalThis.setInterval = originalSetInterval;
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.diagnostics[0]?.code, "IDENTITY_MISMATCH");
      assert.deepEqual(result.diagnostics[0]?.evidence, { field: "admission.inventory_admission.authority_context.canonical_root" });
    }
    assert.deepEqual(effects, {
      filesystem: 0,
      reads: 0,
      writes: 0,
      leaseAcquires: 0,
      leaseReleases: 0,
      inventoryResolves: 0,
      timers: 0,
      waves: 0,
    });
  } finally {
    globalThis.setInterval = originalSetInterval;
    rmSync(root, { recursive: true, force: true });
    rmSync(foreignRoot, { recursive: true, force: true });
  }
});
