/**
 * CTO engine tests: plan validation (caps, cycles, depth), state transitions
 * (escalation expiry, pending listing), DoD aggregation + backstop, R4
 * sanitization, runCto end-to-end.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  MAX_TEAMS,
  buildTeamPlan,
  validateDecompositionDepth,
  runCto,
  ctoRunId,
  newCtoState,
  writeCtoState,
  readCtoState,
  migrateCtoState,
  canonicalizeState,
  setTeamStatus,
  setEscalation,
  expireEscalations,
  pendingEscalations,
  activeTeams,
  setIntegration,
  setCtoPause,
  integrationDoD,
  ctoBackstop,
  sanitizeEscalation,
  appendDoDItem,
  closeDoDItem,
  acquireLease,
  heartbeatLease,
  releaseLease,
  isLeaseAlive,
  reclaimDeadLeases,
  recordDecision,
  recallDecisions,
  decisionsToMarkdown,
  type TeamDef,
  type Escalation,
  type CtoState,
  type TeamLease,
  type DecisionMemoryEntry,
  refineTask,
  validateRefinement,
  evaluateDissent,
  dissentGate,
} from "@andvl1/omp-workflows-core";

function sampleDefs(): Record<string, TeamDef> {
  return {
    "kotlin-backend": {
      id: "kotlin-backend",
      name: "Kotlin Backend",
      scope: ["backend-kotlin"],
      profile: "lightweight",
      lead: "team-lead",
      roster: ["backend-kotlin"],
    },
    frontend: {
      id: "frontend",
      name: "Frontend",
      scope: ["frontend"],
      profile: "lightweight",
      lead: "team-lead",
      roster: ["frontend"],
    },
    mobile: {
      id: "mobile",
      name: "Mobile",
      scope: ["mobile"],
      profile: "standard",
      lead: "team-lead",
      roster: ["mobile"],
    },
  };
}

function sampleEscalation(overrides: Partial<Escalation> = {}): Escalation {
  return {
    id: "run-1/kotlin-backend/clarify/1",
    level: "question",
    title: "API shape",
    body: "REST or gRPC?",
    default: "rest",
    timeoutMs: 3_600_000,
    ...overrides,
  };
}

test("cto-engine: buildTeamPlan accepts a valid decomposition", () => {
  const res = buildTeamPlan(
    {
      id: "auth-2026-08-04",
      task: "Add OAuth",
      teams: [
        { team: "kotlin-backend", scope: ["backend-kotlin"], slice: "server", profile: "lightweight" },
        { team: "frontend", slice: "web client", worktree: "separate_worktree", depends_on: ["kotlin-backend"] },
      ],
    },
    sampleDefs(),
  );
  assert.equal(res.ok, true);
  if (res.ok) {
    assert.equal(res.plan.teams.length, 2);
    assert.equal(res.plan.teams[1]?.worktree, "separate_worktree");
    assert.deepEqual(res.plan.teams[1]?.depends_on, ["kotlin-backend"]);
  }
});

test("cto-engine: buildTeamPlan rejects over-cap and empty plans", () => {
  const defs = sampleDefs();
  const over = buildTeamPlan(
    {
      id: "x",
      task: "t",
      teams: Array.from({ length: MAX_TEAMS + 1 }, (_, i) => ({ team: "kotlin-backend", slice: `s${i}` })),
    },
    defs,
  );
  assert.equal(over.ok, false);
  if (!over.ok) assert.match(over.reason, /cap is 8/);

  const empty = buildTeamPlan({ id: "x", task: "t", teams: [] }, defs);
  assert.equal(empty.ok, false);
});

test("cto-engine: buildTeamPlan rejects unknown and duplicate teams", () => {
  const defs = sampleDefs();
  const unknown = buildTeamPlan({ id: "x", task: "t", teams: [{ team: "nope", slice: "s" }] }, defs);
  assert.equal(unknown.ok, false);
  if (!unknown.ok) assert.match(unknown.reason, /unknown team/);

  const dup = buildTeamPlan(
    { id: "x", task: "t", teams: [{ team: "frontend", slice: "a" }, { team: "frontend", slice: "b" }] },
    defs,
  );
  assert.equal(dup.ok, false);
  if (!dup.ok) assert.match(dup.reason, /duplicate team/);
});

test("cto-engine: buildTeamPlan rejects depends_on cycles and dangling refs", () => {
  const defs = sampleDefs();
  const cycle = buildTeamPlan(
    {
      id: "x",
      task: "t",
      teams: [
        { team: "frontend", slice: "a", depends_on: ["mobile"] },
        { team: "mobile", slice: "b", depends_on: ["frontend"] },
      ],
    },
    defs,
  );
  assert.equal(cycle.ok, false);
  if (!cycle.ok) assert.match(cycle.reason, /cycle/);

  const dangling = buildTeamPlan(
    { id: "x", task: "t", teams: [{ team: "frontend", slice: "a", depends_on: ["ghost"] }] },
    defs,
  );
  assert.equal(dangling.ok, false);
  if (!dangling.ok) assert.match(dangling.reason, /unknown team: ghost/);
});

test("cto-engine: validateDecompositionDepth enforces the depth cap", () => {
  const plan = buildTeamPlan(
    { id: "x", task: "t", teams: [{ team: "mobile", slice: "s", profile: "standard" }] },
    sampleDefs(),
  );
  assert.equal(plan.ok, true);
  if (!plan.ok) return;

  // Flat (no loader) -> depth 1.
  assert.deepEqual(validateDecompositionDepth(plan.plan), { ok: true, depth: 1 });
  // Sub-profile contains team stages -> depth 2 (allowed).
  assert.deepEqual(validateDecompositionDepth(plan.plan, () => 1), { ok: true, depth: 2 });
  // Sub-profile nests another team stage -> depth 3 (blocked).
  const deep = validateDecompositionDepth(plan.plan, () => 2);
  assert.equal(deep.ok, false);
  if (!deep.ok) assert.match(deep.reason, /depth 3 exceeds cap 2/);
});

test("cto-engine: runCto persists state and returns the plan", () => {
  const root = mkdtempSync(join(tmpdir(), "cto-run-"));
  try {
    const res = runCto({
      task: "Add OAuth",
      cwd: root,
      branch: "feat/auth",
      autonomous: false,
      teams: [{ team: "kotlin-backend", slice: "server" }, { team: "frontend", slice: "web" }],
      defs: sampleDefs(),
    });
    assert.equal(res.ok, true);
    if (!res.ok) return;
    assert.match(res.plan.id, /^add-oauth-/);
    assert.equal(res.state.teams.length, 2);
    assert.equal(res.state.teams[0]?.status, "pending");
    const reloaded = readCtoState(res.plan.id, root);
    assert.ok(reloaded);
    assert.equal(reloaded?.task, "Add OAuth");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("cto-engine: ctoRunId produces a unique slug per task", () => {
  const a = ctoRunId("Fix the 500 error");
  const b = ctoRunId("Fix the 500 error");
  assert.match(a, /^fix-the-500-error-/);
  assert.notEqual(a, b);
});

test("cto-engine: state transitions persist and are readable", () => {
  const root = mkdtempSync(join(tmpdir(), "cto-state-"));
  try {
    const res = runCto({
      task: "t",
      cwd: root,
      branch: "main",
      autonomous: false,
      teams: [{ team: "frontend", slice: "s" }],
      defs: sampleDefs(),
    });
    assert.equal(res.ok, true);
    if (!res.ok) return;

    setTeamStatus(res.state, "frontend", "parked", root);
    setEscalation(res.state, "frontend", "esc-1", { status: "pending", sent_at: new Date().toISOString(), timeout_ms: 1000 }, root);
    const reloaded = readCtoState(res.plan.id, root);
    assert.equal(reloaded?.teams[0]?.status, "parked");
    assert.equal(reloaded?.teams[0]?.escalations["esc-1"]?.status, "pending");
    assert.deepEqual(activeTeams(reloaded!), ["frontend"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("cto-engine: expireEscalations expires only elapsed non-blocker pendings", () => {
  const state = newCtoState({ id: "r", task: "t", branch: "b", autonomous: false, plan: { id: "r", task: "t", teams: [], created_at: "" } });
  state.teams = [
    {
      id: "frontend",
      status: "in_progress",
      escalations: {
        q1: { status: "pending", sent_at: "2026-08-04T10:00:00.000Z", timeout_ms: 1000 },
        blocker: { status: "pending", sent_at: "2026-08-04T10:00:00.000Z", timeout_ms: 0 },
        q2: { status: "pending", sent_at: "2026-08-04T10:00:00.000Z" }, // no timeout = wait forever
        done: { status: "answered", sent_at: "2026-08-04T10:00:00.000Z", timeout_ms: 1000 },
      },
    },
  ];
  const expired = expireEscalations(state, Date.parse("2026-08-04T10:01:00.000Z"));
  assert.deepEqual(expired, ["q1"]);
  assert.equal(state.teams[0]?.escalations["blocker"]?.status, "pending");
  assert.equal(state.teams[0]?.escalations["q2"]?.status, "pending");
  assert.equal(state.teams[0]?.escalations["done"]?.status, "answered");
});

test("cto-engine: pendingEscalations lists only pending across teams", () => {
  const state = newCtoState({ id: "r", task: "t", branch: "b", autonomous: false, plan: { id: "r", task: "t", teams: [], created_at: "" } });
  state.teams = [
    { id: "a", status: "parked", escalations: { e1: { status: "pending" }, e2: { status: "answered" } } },
    { id: "b", status: "done", escalations: { e3: { status: "pending" } } },
  ];
  const pending = pendingEscalations(state);
  assert.equal(pending.length, 1);
  assert.equal(pending[0]?.escId, "e1");
});

test("cto-engine: integrationDoD requires every team done with a complete DoD", () => {
  const root = mkdtempSync(join(tmpdir(), "cto-dod-"));
  try {
    const res = runCto({
      task: "t",
      cwd: root,
      branch: "main",
      autonomous: false,
      teams: [{ team: "frontend", slice: "s" }],
      defs: sampleDefs(),
    });
    assert.equal(res.ok, true);
    if (!res.ok) return;

    // Not done yet -> blocked.
    assert.equal(integrationDoD(res.state, root).ok, false);

    setTeamStatus(res.state, "frontend", "done", root);
    // Done but no dod_path -> blocked.
    assert.equal(integrationDoD(res.state, root).ok, false);

    // Give the team a complete DoD.
    const artifacts = join(root, ".work-state", "artifacts", "frontend");
    mkdirSync(artifacts, { recursive: true });
    res.state.teams[0]!.dod_path = join(".work-state", "artifacts", "frontend");
    const dod = appendDoDItem(artifacts, "implementation", "feature works", "run the app", "developer-kotlin");
    const itemId = dod.items[0]?.id;
    assert.ok(itemId);
    closeDoDItem(artifacts, itemId, "smoke test passed", "developer-kotlin");
    assert.equal(integrationDoD(res.state, root).ok, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("cto-engine: ctoBackstop blocks a done-claim with incomplete team DoD", () => {
  const root = mkdtempSync(join(tmpdir(), "cto-backstop-"));
  try {
    const res = runCto({
      task: "t",
      cwd: root,
      branch: "main",
      autonomous: false,
      teams: [{ team: "frontend", slice: "s" }],
      defs: sampleDefs(),
    });
    assert.equal(res.ok, true);
    if (!res.ok) return;
    setTeamStatus(res.state, "frontend", "done", root);
    setCtoPause(res.state, "done", "claiming done", root);
    const gate = ctoBackstop(res.state, root);
    assert.equal(gate.decision, "block");
    if (gate.decision === "block") assert.match(gate.reason, /CTO DoD/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("cto-engine: sanitizeEscalation strips secret lines and truncates (R4)", () => {
  const esc = sampleEscalation({
    body: "Context line.\nAuthorization: Bearer abc123\ntoken = sekrit\nNormal context.",
    title: "Q".repeat(200),
  });
  const clean = sanitizeEscalation(esc);
  assert.ok(clean.title.length <= 120);
  assert.ok(!clean.body.includes("Bearer abc123"));
  assert.ok(!clean.body.includes("sekrit"));
  assert.ok(clean.body.includes("Context line."));
  assert.ok(clean.body.includes("Normal context."));
  assert.equal(clean.id, esc.id);
});

test("cto-engine: sanitizeEscalation fully-redacted body becomes marker", () => {
  const esc = sampleEscalation({ body: "Password: hunter2\nToken: xyz" });
  const clean = sanitizeEscalation(esc);
  assert.equal(clean.body, "[redacted]");
});

// ── cto-core schema migration (br-zps.1) ────────────────────────────────────

/** Hand-built schema-1 state fixture (pre-migration shape). */
function schema1Fixture(): Record<string, unknown> {
  return {
    schema: 1,
    id: "legacy-run-2026-08-01",
    task: "Legacy task",
    branch: "feat/legacy",
    autonomous: false,
    plan: { id: "legacy-run-2026-08-01", task: "Legacy task", teams: [], created_at: "2026-08-01T00:00:00.000Z" },
    teams: [{ id: "frontend", status: "pending", escalations: {} }],
    integration: { status: "pending" },
    pause: { kind: "none", reason: "" },
    updated_at: "2026-08-01T00:00:00.000Z",
  };
}

test("cto-core: migrateCtoState upgrades schema-1 state with defaults and preserves fields", () => {
  const migrated = migrateCtoState(schema1Fixture());
  assert.equal(migrated.schema, 2);
  // Existing fields preserved untouched.
  assert.equal(migrated.id, "legacy-run-2026-08-01");
  assert.equal(migrated.task, "Legacy task");
  assert.equal(migrated.branch, "feat/legacy");
  assert.equal(migrated.autonomous, false);
  assert.deepEqual(migrated.teams, [{ id: "frontend", status: "pending", escalations: {} }]);
  assert.deepEqual(migrated.integration, { status: "pending" });
  assert.deepEqual(migrated.pause, { kind: "none", reason: "" });
  assert.equal(migrated.updated_at, "2026-08-01T00:00:00.000Z");
  // Schema-2 fields default-filled per architecture 3.3.
  assert.deepEqual(migrated.budget, {
    policy: { token_limit: null, dollar_limit: null, time_limit_ms: null },
    accounting: { tokens_estimated: 0, dollars_estimated: 0, elapsed_ms: 0, per_team: {} },
  });
  assert.deepEqual(migrated.leases, {});
  assert.deepEqual(migrated.decisions, []);
  assert.deepEqual(migrated.inbox_quarantine, {});
  assert.equal(migrated.health, undefined);
  assert.equal(migrated.scheduler, undefined);
});

test("cto-core: migrateCtoState treats missing schema as v1 and passes through schema >= 2", () => {
  // Missing schema -> treated as v1 and migrated.
  const noSchema = schema1Fixture();
  delete noSchema.schema;
  const migrated = migrateCtoState(noSchema);
  assert.equal(migrated.schema, 2);
  assert.deepEqual(migrated.leases, {});

  // Pass-through: schema-2 input keeps its own shape; nothing is default-filled.
  const s2 = {
    ...schema1Fixture(),
    schema: 2,
    budget: {
      policy: { token_limit: 100, dollar_limit: null, time_limit_ms: null },
      accounting: { tokens_estimated: 10, dollars_estimated: 0, elapsed_ms: 5, per_team: {} },
    },
  };
  const passthrough = migrateCtoState(s2);
  assert.equal(passthrough.schema, 2);
  assert.deepEqual(passthrough.budget, s2.budget);
  assert.equal(passthrough.leases, undefined);
});

test("cto-core: readCtoState applies migration to legacy state files", () => {
  const root = mkdtempSync(join(tmpdir(), "cto-legacy-"));
  try {
    writeCtoState(schema1Fixture() as unknown as CtoState, root);
    const reloaded = readCtoState("legacy-run-2026-08-01", root);
    assert.ok(reloaded);
    assert.equal(reloaded?.schema, 2);
    assert.deepEqual(reloaded?.budget?.policy, { token_limit: null, dollar_limit: null, time_limit_ms: null });
    assert.deepEqual(reloaded?.leases, {});
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("cto-core: canonicalizeState migrates a legacy file once and is idempotent", () => {
  const root = mkdtempSync(join(tmpdir(), "cto-canon-"));
  try {
    const runId = "legacy-run-2026-08-01";
    writeCtoState(schema1Fixture() as unknown as CtoState, root);
    const path = join(root, ".work-state", "cto", runId, "state.json");

    const first = canonicalizeState(runId, root);
    assert.equal(first.schema, 2);
    assert.deepEqual(first.budget?.policy, { token_limit: null, dollar_limit: null, time_limit_ms: null });
    assert.deepEqual(first.leases, {});
    const afterFirst = readFileSync(path, "utf8");

    const second = canonicalizeState(runId, root);
    assert.equal(second.schema, 2);
    const afterSecond = readFileSync(path, "utf8");
    assert.equal(afterSecond, afterFirst);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("cto-core: writeCtoState round-trips schema 2 with stable defaults", () => {
  const root = mkdtempSync(join(tmpdir(), "cto-roundtrip-"));
  try {
    const state = newCtoState({
      id: "rt-run",
      task: "t",
      branch: "b",
      autonomous: false,
      plan: { id: "rt-run", task: "t", teams: [], created_at: "" },
    });
    assert.equal(state.schema, 2);
    assert.deepEqual(state.budget, {
      policy: { token_limit: null, dollar_limit: null, time_limit_ms: null },
      accounting: { tokens_estimated: 0, dollars_estimated: 0, elapsed_ms: 0, per_team: {} },
    });
    assert.deepEqual(state.leases, {});
    assert.deepEqual(state.decisions, []);
    assert.deepEqual(state.inbox_quarantine, {});
    assert.equal(state.health, undefined);
    assert.equal(state.scheduler, undefined);

    const path = writeCtoState(state, root);
    assert.ok(path.endsWith(join(".work-state", "cto", "rt-run", "state.json")));

    const reloaded = readCtoState("rt-run", root);
    assert.ok(reloaded);
    assert.equal(reloaded?.schema, 2);
    assert.deepEqual(reloaded?.budget, state.budget);
    assert.deepEqual(reloaded?.leases, {});
    assert.deepEqual(reloaded?.decisions, []);
    assert.deepEqual(reloaded?.inbox_quarantine, {});
    assert.equal(reloaded?.health, undefined);
    assert.equal(reloaded?.scheduler, undefined);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ── cto-core team leases (br-zps.3) ─────────────────────────────────────────

function leaseFixture(id = "lease-run"): CtoState {
  return newCtoState({ id, task: "t", branch: "b", autonomous: false, plan: { id, task: "t", teams: [], created_at: "" } });
}

test("cto-core: acquireLease creates a lease with a fresh fence token", () => {
  const state = leaseFixture();
  const res = acquireLease(state, "frontend", process.pid);
  assert.ok("lease" in res);
  if (!("lease" in res)) return;
  assert.equal(res.lease.team_id, "frontend");
  assert.equal(res.lease.pid, process.pid);
  assert.equal(res.lease.ttl_ms, 0);
  assert.match(res.lease.token, /^[0-9a-f-]{36}$/);
  assert.ok(res.lease.acquired_at);
  assert.equal(res.lease.heartbeat_at, res.lease.acquired_at);
  assert.equal(state.leases?.["frontend"], res.lease);
  assert.equal(isLeaseAlive(res.lease), true);
});

test("cto-core: acquireLease initializes the leases map when absent", () => {
  const state = leaseFixture();
  delete state.leases;
  const res = acquireLease(state, "frontend", process.pid);
  assert.ok("lease" in res);
  assert.equal(state.leases?.["frontend"], "lease" in res ? res.lease : undefined);
});

test("cto-core: acquireLease conflicts on a live lease without mutating state", () => {
  const state = leaseFixture();
  const first = acquireLease(state, "frontend", process.pid);
  assert.ok("lease" in first);
  if (!("lease" in first)) return;
  const snapshot = JSON.parse(JSON.stringify(state.leases)) as Record<string, TeamLease>;

  const second = acquireLease(state, "frontend", process.pid);
  assert.ok("conflict" in second);
  if (!("conflict" in second)) return;
  assert.match(second.conflict, /frontend/);
  assert.deepEqual(state.leases, snapshot); // same token, no duplicate completion
});

test("cto-core: heartbeatLease refreshes heartbeat_at only for the matching token", () => {
  const state = leaseFixture();
  const res = acquireLease(state, "frontend", process.pid, 60_000);
  assert.ok("lease" in res);
  if (!("lease" in res)) return;
  const lease = state.leases!["frontend"]!;
  const stale = "2000-01-01T00:00:00.000Z";
  lease.heartbeat_at = stale;

  heartbeatLease(state, "frontend", "bogus-token");
  assert.equal(state.leases!["frontend"]!.heartbeat_at, stale);

  heartbeatLease(state, "frontend", res.lease.token);
  assert.notEqual(state.leases!["frontend"]!.heartbeat_at, stale);
  assert.equal(isLeaseAlive(state.leases!["frontend"]!, Date.now()), true);
});

test("cto-core: releaseLease removes only for the matching token", () => {
  const state = leaseFixture();
  const res = acquireLease(state, "frontend", process.pid);
  assert.ok("lease" in res);
  if (!("lease" in res)) return;

  releaseLease(state, "frontend", "wrong-token");
  assert.ok(state.leases?.["frontend"]);

  releaseLease(state, "frontend", res.lease.token);
  assert.equal(state.leases?.["frontend"], undefined);
});

test("cto-core: ttl 0 lease stays alive while the pid is alive", () => {
  const state = leaseFixture();
  const res = acquireLease(state, "frontend", process.pid, 0);
  assert.ok("lease" in res);
  if (!("lease" in res)) return;
  assert.equal(isLeaseAlive(res.lease, Date.now() + 3_600_000), true);
});

test("cto-core: ttl expiry makes a lease reclaimable via the injected clock", () => {
  const state = leaseFixture();
  const res = acquireLease(state, "frontend", process.pid, 1_000);
  assert.ok("lease" in res);
  if (!("lease" in res)) return;
  const expiredAt = Date.parse(res.lease.heartbeat_at) + 1_500;
  assert.equal(isLeaseAlive(res.lease, expiredAt), false);

  const { reclaimed } = reclaimDeadLeases(state, expiredAt);
  assert.deepEqual(reclaimed, ["frontend"]);
  assert.equal(state.leases?.["frontend"], undefined);
});

test("cto-core: a dead pid is reclaimable even with ttl 0", () => {
  const state = leaseFixture();
  const res = acquireLease(state, "frontend", 0x7fffffff); // no such process → ESRCH
  assert.ok("lease" in res);
  if (!("lease" in res)) return;
  assert.equal(isLeaseAlive(res.lease), false);

  const { reclaimed } = reclaimDeadLeases(state);
  assert.deepEqual(reclaimed, ["frontend"]);
  assert.equal(state.leases?.["frontend"], undefined);
});

test("cto-core: acquireLease force-reclaims a dead lease with a new token", () => {
  const state = leaseFixture();
  const first = acquireLease(state, "frontend", 0x7fffffff);
  assert.ok("lease" in first);
  if (!("lease" in first)) return;

  const second = acquireLease(state, "frontend", process.pid, 0);
  assert.ok("lease" in second);
  if (!("lease" in second)) return;
  assert.notEqual(second.lease.token, first.lease.token);
  assert.equal(isLeaseAlive(second.lease), true);
  assert.equal(state.leases?.["frontend"], second.lease);
});

test("cto-core: lease root persistence round-trips through writeCtoState", () => {
  const root = mkdtempSync(join(tmpdir(), "cto-lease-"));
  try {
    const state = leaseFixture("lease-persist-run");
    const res = acquireLease(state, "frontend", process.pid, 30_000, root);
    assert.ok("lease" in res);
    if (!("lease" in res)) return;

    let reloaded = readCtoState("lease-persist-run", root);
    assert.ok(reloaded);
    assert.deepEqual(reloaded?.leases?.["frontend"], res.lease);

    heartbeatLease(state, "frontend", res.lease.token, root);
    const heartbeatAt = state.leases!["frontend"]!.heartbeat_at;
    reloaded = readCtoState("lease-persist-run", root);
    assert.ok(reloaded);
    assert.equal(reloaded?.leases?.["frontend"]?.heartbeat_at, heartbeatAt);

    releaseLease(state, "frontend", res.lease.token, root);
    reloaded = readCtoState("lease-persist-run", root);
    assert.ok(reloaded);
    assert.equal(reloaded?.leases?.["frontend"], undefined);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ── cto-core decision memory (br-zps.11) ─────────────────────────────────

function decisionFixture(id = "decision-run", decisions: DecisionMemoryEntry[] = []): CtoState {
  const state = newCtoState({ id, task: "t", branch: "b", autonomous: false, plan: { id, task: "t", teams: [], created_at: "" } });
  state.decisions = decisions;
  return state;
}

function decisionEntry(id: string, at: string, decision: string, tags: string[], by: string, refs?: string[]): DecisionMemoryEntry {
  return { id, at, decision, why: `why: ${decision}`, tags, by, refs };
}

test("cto-core: recordDecision appends an entry with generated id and at", () => {
  const state = decisionFixture();
  const out = recordDecision(state, {
    decision: "Use the mock adapter for escalations",
    why: "No real credentials may appear in tests",
    tags: ["escalation", "testing"],
    by: "cto",
    refs: ["br-zps.7"],
  });
  assert.equal(out, state); // same object, mutated in place like state.ts/leases.ts
  assert.equal(state.decisions?.length, 1);
  const recorded = state.decisions![0]!;
  assert.match(recorded.id, /^[0-9a-f-]{36}$/);
  assert.ok(!Number.isNaN(Date.parse(recorded.at)));
  assert.equal(recorded.decision, "Use the mock adapter for escalations");
  assert.equal(recorded.why, "No real credentials may appear in tests");
  assert.deepEqual(recorded.tags, ["escalation", "testing"]);
  assert.equal(recorded.by, "cto");
  assert.deepEqual(recorded.refs, ["br-zps.7"]);
});

test("cto-core: recordDecision rejects empty or whitespace why without mutating state", () => {
  const state = decisionFixture();
  assert.throws(
    () => recordDecision(state, { decision: "d", why: "", tags: [], by: "cto" }),
    /why/,
  );
  assert.throws(
    () => recordDecision(state, { decision: "d", why: "   \n\t  ", tags: [], by: "cto" }),
    /why/,
  );
  assert.equal(state.decisions?.length ?? 0, 0);
});

test("cto-core: recallDecisions by single tag is an exact match", () => {
  const state = decisionFixture("recall-run", [
    decisionEntry("d1", "2026-08-01T00:00:00.000Z", "a", ["budget"], "cto"),
    decisionEntry("d2", "2026-08-02T00:00:00.000Z", "b", ["budget", "escalation"], "team-x"),
    decisionEntry("d3", "2026-08-03T00:00:00.000Z", "c", ["escalation"], "cto"),
  ]);
  assert.deepEqual(recallDecisions(state, { tags: ["budget"] }).map((e) => e.id), ["d2", "d1"]);
  // exact match: a tag that merely starts with "budget" must NOT hit
  assert.deepEqual(recallDecisions(state, { tags: ["budgetx"] }), []);
  assert.deepEqual(recallDecisions(state, { tags: ["nope"] }), []);
});

test("cto-core: recallDecisions with multiple tags uses AND semantics", () => {
  const state = decisionFixture("recall-run", [
    decisionEntry("d1", "2026-08-01T00:00:00.000Z", "a", ["budget", "escalation"], "cto"),
    decisionEntry("d2", "2026-08-02T00:00:00.000Z", "b", ["budget"], "cto"),
  ]);
  assert.deepEqual(recallDecisions(state, { tags: ["budget", "escalation"] }).map((e) => e.id), ["d1"]);
  assert.deepEqual(recallDecisions(state, { tags: ["budget", "missing"] }), []);
});

test("cto-core: recallDecisions by exact by value", () => {
  const state = decisionFixture("recall-run", [
    decisionEntry("d1", "2026-08-01T00:00:00.000Z", "a", [], "cto"),
    decisionEntry("d2", "2026-08-02T00:00:00.000Z", "b", [], "team-x"),
  ]);
  assert.deepEqual(recallDecisions(state, { by: "team-x" }).map((e) => e.id), ["d2"]);
  assert.deepEqual(recallDecisions(state, { by: "cto" }).map((e) => e.id), ["d1"]);
});

test("cto-core: recallDecisions limit caps newest-first results", () => {
  const state = decisionFixture("recall-run", [
    decisionEntry("old", "2026-08-01T00:00:00.000Z", "a", ["x"], "cto"),
    decisionEntry("mid", "2026-08-02T00:00:00.000Z", "b", ["x"], "cto"),
    decisionEntry("new", "2026-08-03T00:00:00.000Z", "c", ["x"], "cto"),
  ]);
  assert.deepEqual(recallDecisions(state, { limit: 2 }).map((e) => e.id), ["new", "mid"]);
});

test("cto-core: recallDecisions with no opts returns all entries newest-first", () => {
  const state = decisionFixture("recall-run", [
    decisionEntry("old", "2026-08-01T00:00:00.000Z", "a", ["x"], "cto"),
    decisionEntry("new", "2026-08-03T00:00:00.000Z", "c", ["y"], "team-x"),
    decisionEntry("mid", "2026-08-02T00:00:00.000Z", "b", [], "cto"),
  ]);
  assert.deepEqual(recallDecisions(state).map((e) => e.id), ["new", "mid", "old"]);
});

test("cto-core: decisionsToMarkdown is a deterministic projection containing decision/why/tags", () => {
  const state = decisionFixture("md-run", [
    decisionEntry("d1", "2026-08-01T00:00:00.000Z", "Ship the lease fencing", ["leases", "core"], "cto", ["br-zps.3"]),
  ]);
  const md = decisionsToMarkdown(state);
  assert.match(md, /^## Decisions/m);
  assert.match(md, /d1/);
  assert.match(md, /Ship the lease fencing/); // decision text
  assert.match(md, /why: Ship the lease fencing/); // rationale text
  assert.match(md, /- tags: leases, core/);
  assert.match(md, /- by: cto/);
  assert.match(md, /- refs: br-zps\.3/);
  assert.match(md, /- at: 2026-08-01T00:00:00\.000Z/);
  assert.equal(decisionsToMarkdown(state), md); // deterministic: same input → same output
});

test("cto-core: recordDecision root persistence round-trips through writeCtoState", () => {
  const root = mkdtempSync(join(tmpdir(), "cto-decision-"));
  try {
    const state = decisionFixture("decision-persist-run");
    recordDecision(
      state,
      { decision: "Persist decisions", why: "Durable audit trail", tags: ["durable"], by: "cto" },
      root,
    );

    const reloaded = readCtoState("decision-persist-run", root);
    assert.ok(reloaded);
    assert.equal(reloaded?.decisions?.length, 1);
    const persisted = reloaded?.decisions?.[0];
    assert.ok(persisted);
    assert.equal(persisted.decision, "Persist decisions");
    assert.equal(persisted.why, "Durable audit trail");
    assert.deepEqual(persisted.tags, ["durable"]);
    assert.equal(persisted.by, "cto");
    assert.match(persisted.id, /^[0-9a-f-]{36}$/);
    assert.ok(!Number.isNaN(Date.parse(persisted.at)));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ── cto-operations (br-zps.2, br-zps.7, br-zps.8) tests ─────────────────────
import {
  defaultBudgetState,
  checkBudget,
  recordSpend,
  setBudgetPolicy,
  CHAR_HEURISTIC_RECORDER,
  type BudgetRecorder,
  assessRunHealth,
  healthToMarkdown,
  shouldRunWave,
  buildDigest,
  startWaveScheduler,
  type TeamPlan,
} from "@andvl1/omp-workflows-core";

describe("cto-operations budget", () => {
  function sampleState(overrides: Partial<CtoState> = {}): CtoState {
    return {
      schema: 2,
      id: "run-budget-test",
      task: "budget slice",
      branch: "feat/br-zps-cto-control-plane",
      autonomous: true,
      plan: { id: "run-budget-test", task: "budget slice", teams: [], created_at: new Date().toISOString() },
      teams: [],
      integration: { status: "pending" },
      pause: { kind: "none", reason: "" },
      updated_at: new Date().toISOString(),
      budget: defaultBudgetState(),
      ...overrides,
    };
  }

  test("defaultBudgetState: all limits null, all accounting zero (D3)", () => {
    const b = defaultBudgetState();
    assert.deepEqual(b.policy, { token_limit: null, dollar_limit: null, time_limit_ms: null });
    assert.deepEqual(b.accounting, { tokens_estimated: 0, dollars_estimated: 0, elapsed_ms: 0, per_team: {} });
  });

  test("checkBudget on default state → unlimited (D3 invariant)", () => {
    const r = checkBudget(sampleState());
    assert.equal(r.status, "unlimited");
    assert.equal(r.detail, undefined);
    // absent budget is treated as the default (unlimited) shape too
    const s = sampleState();
    delete (s as { budget?: unknown }).budget;
    assert.equal(checkBudget(s).status, "unlimited");
  });

  test("recordSpend accumulates totals and per_team for two teams", () => {
    let state = sampleState();
    state = recordSpend(state, "backend", 400, 10);
    state = recordSpend(state, "mobile", 200, 5);
    state = recordSpend(state, "backend", 100, 2);
    assert.equal(state.budget!.accounting.tokens_estimated, 700);
    assert.equal(state.budget!.accounting.dollars_estimated, 17);
    assert.deepEqual(state.budget!.accounting.per_team, {
      backend: { tokens: 500, dollars: 12, ms: 0 },
      mobile: { tokens: 200, dollars: 5, ms: 0 },
    });
  });

  test("recordSpend persists to disk when root is given", () => {
    const root = mkdtempSync(join(tmpdir(), "cto-budget-"));
    try {
      const state = sampleState();
      writeCtoState(state, root);
      recordSpend(state, "backend", 300, 6, root);
      const onDisk = readCtoState("run-budget-test", root);
      assert.ok(onDisk);
      assert.equal(onDisk.budget!.accounting.tokens_estimated, 300);
      assert.deepEqual(onDisk.budget!.accounting.per_team.backend, { tokens: 300, dollars: 6, ms: 0 });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("recordSpend on state without budget initializes the default shape first", () => {
    const state = sampleState();
    delete (state as { budget?: unknown }).budget;
    recordSpend(state, "x", 40, 0);
    assert.equal(state.budget!.accounting.tokens_estimated, 40);
    assert.deepEqual(state.budget!.policy, defaultBudgetState().policy);
  });

  test("setBudgetPolicy partial merge preserves unset fields", () => {
    const state = sampleState();
    setBudgetPolicy(state, { token_limit: 1000, time_limit_ms: 60_000 });
    assert.equal(state.budget!.policy.token_limit, 1000);
    assert.equal(state.budget!.policy.time_limit_ms, 60_000);
    assert.equal(state.budget!.policy.dollar_limit, null); // untouched
  });

  test("setBudgetPolicy persists to disk when root is given", () => {
    const root = mkdtempSync(join(tmpdir(), "cto-budget-"));
    try {
      const state = sampleState();
      writeCtoState(state, root);
      setBudgetPolicy(state, { token_limit: 500 }, root);
      const onDisk = readCtoState("run-budget-test", root);
      assert.ok(onDisk);
      assert.equal(onDisk.budget!.policy.token_limit, 500);
      assert.equal(onDisk.budget!.policy.dollar_limit, null);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("checkBudget: below limits → ok", () => {
    const now = Date.now();
    const state = sampleState({ budget: { policy: { token_limit: 1000, dollar_limit: 100, time_limit_ms: 60_000 }, accounting: { tokens_estimated: 500, dollars_estimated: 50, elapsed_ms: 0, per_team: {} } } });
    const r = checkBudget(state, now);
    assert.equal(r.status, "ok");
    assert.equal(r.detail, undefined);
  });

  test("checkBudget: at/over limit → exceeded", () => {
    const now = Date.now();
    const state = sampleState({ budget: { policy: { token_limit: 1000, dollar_limit: null, time_limit_ms: null }, accounting: { tokens_estimated: 1000, dollars_estimated: 0, elapsed_ms: 0, per_team: {} } } });
    const r = checkBudget(state, now);
    assert.equal(r.status, "exceeded");
    assert.match(r.detail ?? "", /tokens 1000 >= limit 1000/);
  });

  test("checkBudget: >=80% of a limit → approaching", () => {
    const now = Date.now();
    const state = sampleState({ budget: { policy: { token_limit: 1000, dollar_limit: null, time_limit_ms: null }, accounting: { tokens_estimated: 800, dollars_estimated: 0, elapsed_ms: 0, per_team: {} } } });
    const r = checkBudget(state, now);
    assert.equal(r.status, "approaching");
    assert.match(r.detail ?? "", /tokens 800 >= 80% of limit 1000/);
  });

  test("checkBudget: exceeded wins over approaching (precedence)", () => {
    const now = Date.now();
    const state = sampleState({ budget: { policy: { token_limit: 1000, dollar_limit: 100, time_limit_ms: null }, accounting: { tokens_estimated: 1200, dollars_estimated: 90, elapsed_ms: 0, per_team: {} } } });
    const r = checkBudget(state, now);
    assert.equal(r.status, "exceeded");
    assert.match(r.detail ?? "", /tokens 1200 >= limit 1000/);
  });

  test("checkBudget: time_limit_ms elapsed → exceeded (updated_at is run-start approximation)", () => {
    const now = Date.now();
    const state = sampleState({
      updated_at: new Date(now - 120_000).toISOString(),
      budget: { policy: { token_limit: null, dollar_limit: null, time_limit_ms: 60_000 }, accounting: { tokens_estimated: 0, dollars_estimated: 0, elapsed_ms: 0, per_team: {} } },
    });
    const r = checkBudget(state, now);
    assert.equal(r.status, "exceeded");
    assert.match(r.detail ?? "", /elapsed 120000 >= limit 60000/);
  });

  test("CHAR_HEURISTIC_RECORDER: chars/4 integer division, dollars 0 (C1)", () => {
    const r1 = CHAR_HEURISTIC_RECORDER.record({ id: "1", kind: "tool_call", ts: "2026-08-07T00:00:00Z", branch: "feat/x", toolName: "task", subagent: "task", subagentTaskChars: 1000 });
    assert.deepEqual(r1, { tokens: 250, dollars: 0 });
    const r2 = CHAR_HEURISTIC_RECORDER.record({ id: "2", kind: "agent_end", ts: "2026-08-07T00:00:00Z", branch: "feat/x", messageCount: 3 });
    assert.deepEqual(r2, { tokens: 0, dollars: 0 });
  });

  test("BudgetRecorder is a structural interface (recorder instance satisfies it)", () => {
    const recorder: BudgetRecorder = {
      record: (event) => ({ tokens: event.subagentTaskChars ?? 0, dollars: 0 }),
    };
    assert.equal(recorder.record({ id: "3", kind: "tool_call", ts: "t", branch: "b", subagentTaskChars: 8 }).tokens, 8);
  });
});

describe("cto-operations health+scheduler", () => {
  function samplePlan(teamIds: string[] = ["team-a", "team-b", "team-c"]): TeamPlan {
    return {
      id: "run-health-1",
      task: "health + scheduler",
      teams: teamIds.map((team) => ({
        team,
        scope: [],
        slice: "slice",
        profile: "lightweight",
        worktree: "same_branch" as const,
        depends_on: [],
      })),
      created_at: "2026-08-07T00:00:00.000Z",
    };
  }

  function sampleState(overrides: Partial<CtoState> = {}): CtoState {
    const state = newCtoState({
      id: "run-health-1",
      task: "health + scheduler",
      branch: "feat/br-zps-cto-control-plane",
      autonomous: true,
      plan: samplePlan(),
    });
    return { ...state, ...overrides };
  }

  function withBudget(state: CtoState, overrides: Partial<NonNullable<CtoState["budget"]>> = {}): CtoState {
    return {
      ...state,
      budget: {
        policy: { token_limit: null, dollar_limit: null, time_limit_ms: null },
        accounting: { tokens_estimated: 0, dollars_estimated: 0, elapsed_ms: 0, per_team: {} },
        ...overrides,
      },
    };
  }

  function withEscalation(state: CtoState, teamId: string, escId: string, status: CtoState["teams"][number]["escalations"][string]["status"]): CtoState {
    return {
      ...state,
      teams: state.teams.map((t) =>
        t.id === teamId ? { ...t, escalations: { ...t.escalations, [escId]: { status } } } : t,
      ),
    };
  }

  function withStatus(state: CtoState, teamId: string, status: CtoState["teams"][number]["status"]): CtoState {
    return {
      ...state,
      teams: state.teams.map((t) => (t.id === teamId ? { ...t, status } : t)),
    };
  }

  test("health: mixed team statuses are counted; failed team makes the run unhealthy", () => {
    const state = withBudget(withStatus(withStatus(withStatus(sampleState(), "team-a", "in_progress"), "team-b", "parked"), "team-c", "failed"));
    const health = assessRunHealth(state);
    assert.equal(health.run_id, "run-health-1");
    assert.equal(health.active_teams, 1);
    assert.equal(health.parked_teams, 1);
    assert.equal(health.failed_teams, 1);
    assert.equal(health.healthy, false);
    assert.ok(health.issues.some((issue) => issue.includes('team "team-c" failed')));
    // default budget (all limits null) reads as unlimited
    assert.equal(health.budget_status, "unlimited");
  });

  test("health: healthy run — no failed teams, unlimited budget, no open escalations", () => {
    const state = withBudget(withStatus(withStatus(sampleState(), "team-a", "in_progress"), "team-b", "done"));
    const health = assessRunHealth(state);
    assert.equal(health.healthy, true);
    assert.equal(health.failed_teams, 0);
    assert.equal(health.pending_escalations, 0);
    assert.deepEqual(health.issues, []);
    assert.equal(health.last_heartbeat_at, state.updated_at);
  });

  test("health: open escalations counted across all teams (pending + undelivered)", () => {
    let state = withBudget(sampleState());
    state = withEscalation(state, "team-a", "esc-1", "pending");
    state = withEscalation(state, "team-a", "esc-2", "answered");
    state = withEscalation(state, "team-b", "esc-3", "undelivered");
    state = withEscalation(state, "team-b", "esc-4", "expired");
    state = withEscalation(state, "team-c", "esc-5", "cancelled");
    const health = assessRunHealth(state);
    assert.equal(health.pending_escalations, 2);
    assert.ok(health.issues.includes("2 open escalations"));
  });

  test("health: exceeded budget makes the run unhealthy and is surfaced in issues", () => {
    const state = withBudget(sampleState(), {
      policy: { token_limit: 1000, dollar_limit: null, time_limit_ms: null },
      accounting: { tokens_estimated: 2500, dollars_estimated: 0, elapsed_ms: 10, per_team: {} },
    });
    const health = assessRunHealth(state);
    assert.equal(health.budget_status, "exceeded");
    assert.equal(health.healthy, false);
    assert.ok(health.issues.some((issue) => issue.startsWith("budget exceeded")));
  });

  test("health: freshest lease heartbeat wins over updated_at", () => {
    const state = withBudget({
      ...sampleState(),
      updated_at: "2026-08-07T00:00:00.000Z",
      leases: {
        "team-a": {
          token: "t1",
          acquired_at: "2026-08-07T00:00:00.000Z",
          heartbeat_at: "2026-08-07T00:10:00.000Z",
          ttl_ms: 60000,
          pid: 1234,
          team_id: "team-a",
        },
        "team-b": {
          token: "t2",
          acquired_at: "2026-08-07T00:00:00.000Z",
          heartbeat_at: "2026-08-07T00:05:00.000Z",
          ttl_ms: 60000,
          pid: 1235,
          team_id: "team-b",
        },
      },
    });
    const health = assessRunHealth(state);
    assert.equal(health.last_heartbeat_at, "2026-08-07T00:10:00.000Z");
  });

  test("health: healthToMarkdown is deterministic and lists issues", () => {
    const state = withBudget(withStatus(sampleState(), "team-c", "failed"));
    const health = assessRunHealth(state);
    const md = healthToMarkdown(health);
    assert.ok(md.includes("## Run health: run-health-1"));
    assert.ok(md.includes("- healthy: no"));
    assert.ok(md.includes("- failed teams: 1"));
    assert.ok(md.includes("- budget: unlimited"));
    assert.ok(md.includes("- team \"team-c\" failed"));
    const again = healthToMarkdown(health);
    assert.equal(again, md);
    assert.ok(healthToMarkdown(assessRunHealth(withBudget(sampleState()))).includes("- none"));
  });

  test("scheduler: disabled when no scheduler or interval <= 0", () => {
    assert.equal(shouldRunWave(sampleState()), false);
    assert.equal(shouldRunWave({ ...sampleState(), scheduler: { wave_interval_ms: 0 } }), false);
    assert.equal(shouldRunWave({ ...sampleState(), scheduler: { wave_interval_ms: -100 } }), false);
    assert.equal(shouldRunWave({ ...sampleState(), scheduler: { wave_interval_ms: Number.NaN } }), false);
  });

  test("scheduler: due when last_wave_at missing, fresh, old, or unparseable", () => {
    const now = Date.parse("2026-08-07T12:00:00.000Z");
    const scheduler = { wave_interval_ms: 60_000 };
    // never ran → due
    assert.equal(shouldRunWave({ ...sampleState(), scheduler }, now), true);
    // ran 10s ago (fresh) → not due
    assert.equal(
      shouldRunWave({ ...sampleState(), scheduler: { ...scheduler, last_wave_at: new Date(now - 10_000).toISOString() } }, now),
      false,
    );
    // ran 2min ago (old) → due
    assert.equal(
      shouldRunWave({ ...sampleState(), scheduler: { ...scheduler, last_wave_at: new Date(now - 120_000).toISOString() } }, now),
      true,
    );
    // exactly at the interval boundary → due
    assert.equal(
      shouldRunWave({ ...sampleState(), scheduler: { ...scheduler, last_wave_at: new Date(now - 60_000).toISOString() } }, now),
      true,
    );
    // corrupt timestamp → treated as due (documented)
    assert.equal(shouldRunWave({ ...sampleState(), scheduler: { ...scheduler, last_wave_at: "not-a-date" } }, now), true);
  });

  test("scheduler: buildDigest shape and disk-truth preference", () => {
    const root = mkdtempSync(join(tmpdir(), "cto-digest-"));
    try {
      // Disk truth: 2 decisions, 3 open escalations, exceeded budget.
      const disk = withBudget(sampleState(), {
        policy: { token_limit: 1000, dollar_limit: null, time_limit_ms: null },
        accounting: { tokens_estimated: 5000, dollars_estimated: 0, elapsed_ms: 20, per_team: {} },
      });
      disk.decisions = [
        { id: "d1", at: "2026-08-07T10:00:00.000Z", decision: "keep mock adapter", why: "no network in tests", tags: ["adapter"], by: "cto" },
        { id: "d2", at: "2026-08-07T11:00:00.000Z", decision: "unlimited budget default", why: "D3", tags: ["budget"], by: "cto" },
      ];
      disk.teams[0].escalations = { "e1": { status: "pending" }, "e2": { status: "undelivered" } };
      disk.teams[1].escalations = { "e3": { status: "pending" } };
      writeCtoState(disk, root);

      // In-memory state is stale: no decisions, no escalations, unlimited budget.
      const stale = withBudget(sampleState());
      const digest = buildDigest(stale, root);

      assert.equal(digest.run_id, "run-health-1");
      assert.ok(!Number.isNaN(Date.parse(digest.at)));
      assert.equal(digest.health.run_id, "run-health-1");
      assert.equal(digest.health.budget_status, "exceeded");
      assert.equal(digest.health.healthy, false);
      assert.equal(digest.health.pending_escalations, 3);
      assert.equal(digest.open_escalations, 3);
      assert.equal(digest.budget_status, "exceeded");
      assert.equal(digest.recent_decisions.length, 2);
      assert.equal(digest.recent_decisions[0].id, "d2"); // newest-first
      assert.equal(digest.recent_decisions[0].by, "cto");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("scheduler: buildDigest falls back to passed state when no file on disk", () => {
    const root = mkdtempSync(join(tmpdir(), "cto-digest-empty-"));
    try {
      const state = withBudget(sampleState());
      const digest = buildDigest(state, root);
      assert.equal(digest.run_id, "run-health-1");
      assert.equal(digest.health.healthy, true);
      assert.equal(digest.open_escalations, 0);
      assert.deepEqual(digest.recent_decisions, []);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  /** Wall-clock delay; see the real-timer exception note below. */
  function delay(ms: number): Promise<void> {
    const { promise, resolve } = Promise.withResolvers<void>();
    setTimeout(resolve, ms);
    return promise;
  }

  // EXCEPTION to the fake-timer rule (ts-no-test-timers): this test deliberately
  // exercises REAL setInterval behavior on the platform clock — the module under
  // test creates its own setInterval and there is no injection point, and
  // node:test ships no fake-timer facility. Real timers with generous margins
  // (30ms interval vs 200ms observation) are the only honest way to verify the
  // timer fires and that stop() actually clears it.
  test("scheduler: startWaveScheduler fires onWave on interval and stops cleanly", async () => {
    const root = mkdtempSync(join(tmpdir(), "cto-wave-"));
    try {
      let waves = 0;
      const state = withBudget(sampleState());
      const stop = startWaveScheduler(state, root, 30, () => {
        waves += 1;
      });
      try {
        await delay(200);
        assert.ok(waves >= 1, `onWave should fire at least once (got ${waves})`);
      } finally {
        stop();
      }
      const afterStop = waves;
      await delay(150);
      assert.equal(waves, afterStop, "no waves after stop()");
      // scheduler fields persisted on disk
      const fromDisk = JSON.parse(readFileSync(join(root, ".work-state", "cto", "run-health-1", "state.json"), "utf8")) as {
        scheduler: { wave_interval_ms: number; last_wave_at?: string; next_wave_at?: string };
      };
      assert.equal(fromDisk.scheduler.wave_interval_ms, 30);
      assert.ok(fromDisk.scheduler.last_wave_at);
      assert.ok(fromDisk.scheduler.next_wave_at);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("scheduler: startWaveScheduler with interval <= 0 returns a no-op stop", () => {
    const state = withBudget(sampleState());
    const stop = startWaveScheduler(state, tmpdir(), 0, () => {
      throw new Error("must never fire");
    });
    assert.equal(typeof stop, "function");
    stop(); // must not throw
    stop(); // idempotent
  });
});

// ── cto-quality (br-zps.9, br-zps.10) tests ─────────────────────────────────
describe("cto-quality refinement", () => {
  test("refineTask normalizes (trim, collapse whitespace) and round-trips", () => {
    const result = refineTask("  fix   the  flaky\npoll   race  ");
    assert.equal(result.original_task, "fix the flaky poll race");
    assert.equal(result.root_cause, "fix the flaky poll race");
    assert.equal(result.refined_task, "fix the flaky poll race");
    assert.deepEqual(result.whys, ["fix the flaky poll race"]);
    assert.equal(result.converged, false);
    // round-trip invariant: validateRefinement(refineTask(t)) !== null
    assert.notEqual(validateRefinement(result), null);
    assert.notEqual(validateRefinement(refineTask("plain task")), null);
  });

  test("refineTask throws TypeError on empty / whitespace-only input", () => {
    assert.throws(() => refineTask(""), TypeError);
    assert.throws(() => refineTask("   \n\t  "), TypeError);
  });

  test("refineTask throws TypeError on non-string input", () => {
    assert.throws(() => refineTask(42 as unknown as string), TypeError);
    assert.throws(() => refineTask(null as unknown as string), TypeError);
    assert.throws(() => refineTask(undefined as unknown as string), TypeError);
  });

  test("refineTask accepts optional context string; throws TypeError on non-string context", () => {
    const withContext = refineTask("ship the gate", "no prior decision contradicts this");
    assert.equal(withContext.original_task, "ship the gate");
    assert.equal(withContext.converged, false);
    // context is informational — it does NOT change the deterministic result
    assert.deepEqual(refineTask("ship the gate", "anything at all"), refineTask("ship the gate"));
    assert.throws(() => refineTask("ship the gate", 42 as unknown as string), TypeError);
  });

  test("validateRefinement accepts a well-formed 5-why chain with converged=false", () => {
    const data = {
      original_task: "flaky poll race",
      root_cause: "no fence around poll writes",
      refined_task: "add a fence token to poll writes",
      whys: ["w1", "w2", "w3", "w4", "w5"],
      converged: false,
    };
    const result = validateRefinement(data);
    assert.notEqual(result, null);
    assert.equal(result!.whys.length, 5);
    assert.equal(result!.converged, false);
    assert.equal(result!.original_task, "flaky poll race");
  });

  test("validateRefinement accepts a converged-early chain (3 whys, converged=true)", () => {
    const data = {
      original_task: "deploy hotfix",
      root_cause: "bad config value",
      refined_task: "correct config and redeploy",
      whys: ["w1", "w2", "w3"],
      converged: true,
    };
    const result = validateRefinement(data);
    assert.notEqual(result, null);
    assert.equal(result!.whys.length, 3);
    assert.equal(result!.converged, true);
  });

  test("validateRefinement rejects non-object and null", () => {
    assert.equal(validateRefinement(null), null);
    assert.equal(validateRefinement(undefined), null);
    assert.equal(validateRefinement("string"), null);
    assert.equal(validateRefinement(42), null);
    assert.equal(validateRefinement(true), null);
    assert.equal(validateRefinement([]), null);
  });

  test("validateRefinement rejects missing fields", () => {
    const base = {
      original_task: "t",
      root_cause: "rc",
      refined_task: "rt",
      whys: ["w"],
      converged: false,
    };
    assert.equal(validateRefinement({}), null);
    assert.equal(validateRefinement({ ...base, original_task: undefined }), null);
    assert.equal(validateRefinement({ ...base, root_cause: undefined }), null);
    assert.equal(validateRefinement({ ...base, refined_task: undefined }), null);
    assert.equal(validateRefinement({ ...base, whys: undefined }), null);
    assert.equal(validateRefinement({ ...base, converged: undefined }), null);
  });

  test("validateRefinement rejects empty strings", () => {
    const base = {
      original_task: "t",
      root_cause: "rc",
      refined_task: "rt",
      whys: ["w"],
      converged: false,
    };
    assert.equal(validateRefinement({ ...base, original_task: "" }), null);
    assert.equal(validateRefinement({ ...base, original_task: "   " }), null);
    assert.equal(validateRefinement({ ...base, root_cause: "" }), null);
    assert.equal(validateRefinement({ ...base, refined_task: "" }), null);
    assert.equal(validateRefinement({ ...base, whys: [""] }), null);
    assert.equal(validateRefinement({ ...base, whys: ["  "] }), null);
  });

  test("validateRefinement rejects whys arrays with wrong length or non-string members", () => {
    const base = {
      original_task: "t",
      root_cause: "rc",
      refined_task: "rt",
      whys: ["w"],
      converged: false,
    };
    assert.equal(validateRefinement({ ...base, whys: [] }), null);
    assert.equal(validateRefinement({ ...base, whys: ["w1", "w2", "w3", "w4", "w5", "w6"] }), null);
    assert.equal(validateRefinement({ ...base, whys: [42] }), null);
    assert.equal(validateRefinement({ ...base, whys: [null] }), null);
    assert.equal(validateRefinement({ ...base, whys: ["w", 1, "x"] }), null);
  });

  test("validateRefinement rejects non-boolean converged", () => {
    const base = {
      original_task: "t",
      root_cause: "rc",
      refined_task: "rt",
      whys: ["w"],
      converged: false,
    };
    assert.equal(validateRefinement({ ...base, converged: "yes" }), null);
    assert.equal(validateRefinement({ ...base, converged: 1 }), null);
    assert.equal(validateRefinement({ ...base, converged: null }), null);
  });

  test("validateRefinement rejects converged=true with 5 whys", () => {
    const data = {
      original_task: "t",
      root_cause: "rc",
      refined_task: "rt",
      whys: ["w1", "w2", "w3", "w4", "w5"],
      converged: true,
    };
    assert.equal(validateRefinement(data), null);
    // boundary: converged=true with a 4-why chain is legal (converged before five)
    assert.notEqual(validateRefinement({ ...data, whys: ["w1", "w2", "w3", "w4"] }), null);
  });

  test("validateRefinement does not mutate its input", () => {
    const data = {
      original_task: "flaky poll race",
      root_cause: "no fence",
      refined_task: "add fence",
      whys: ["w1", "w2"],
      converged: true,
    };
    const snapshot = JSON.parse(JSON.stringify(data)) as typeof data;
    validateRefinement(data);
    assert.deepEqual(data, snapshot);
  });
});

describe("cto-quality dissent (br-zps.10)", () => {
  function dissentState(overrides: Partial<CtoState> = {}): CtoState {
    const state: CtoState = {
      schema: 2,
      id: "run-dissent",
      task: "dissent gate",
      branch: "feat/br-zps-cto-control-plane",
      autonomous: true,
      plan: {
        id: "run-dissent",
        task: "dissent gate",
        teams: [
          {
            team: "quality",
            scope: [],
            slice: "dissent",
            profile: "lightweight",
            worktree: "same_branch",
            depends_on: [],
          },
        ],
        created_at: "2026-08-07T00:00:00.000Z",
      },
      teams: [{ id: "quality", status: "pending", escalations: {} }],
      integration: { status: "pending" },
      pause: { kind: "none", reason: "" },
      updated_at: "2026-08-07T00:00:00.000Z",
    };
    return { ...state, ...overrides };
  }

  /** Mirror of the ops-budget test helper: default unlimited budget + overrides. */
  function withBudget(state: CtoState, overrides: Partial<NonNullable<CtoState["budget"]>> = {}): CtoState {
    return {
      ...state,
      budget: {
        policy: { token_limit: null, dollar_limit: null, time_limit_ms: null },
        accounting: { tokens_estimated: 0, dollars_estimated: 0, elapsed_ms: 0, per_team: {} },
        ...overrides,
      },
    };
  }

  test("dissent: low stakes + reversible + no tag + no budget → no dissent (no gate tax)", () => {
    const r = evaluateDissent({ action: "rename internal function", stakes: "low", reversible: true });
    assert.equal(r.trigger, null);
    assert.equal(r.severity, "none");
    assert.equal(r.escalate_to, null);
    assert.equal(r.reason, "no dissent needed");
  });

  test("dissent: high stakes triggers high_stakes, blocking, escalate to cto (also when reversible)", () => {
    const r = evaluateDissent({ action: "delete prod database", stakes: "high", reversible: true });
    assert.equal(r.trigger, "high_stakes");
    assert.equal(r.severity, "blocking");
    assert.equal(r.escalate_to, "cto");
    assert.match(r.reason, /high_stakes: delete prod database/);
  });

  test("dissent: low stakes + irreversible triggers irreversible, blocking, escalate to cto", () => {
    const r = evaluateDissent({ action: "rewrite git history", stakes: "low", reversible: false });
    assert.equal(r.trigger, "irreversible");
    assert.equal(r.severity, "blocking");
    assert.equal(r.escalate_to, "cto");
    assert.match(r.reason, /irreversible: rewrite git history/);
  });

  test("dissent: contradicts_decision_tag set → advisory, escalate to lead (surfaced, not blocked)", () => {
    const r = evaluateDissent({ action: "override tagged decision", stakes: "low", reversible: true, contradicts_decision_tag: "monorepo-layout" });
    assert.equal(r.trigger, "contradicts_decision");
    assert.equal(r.severity, "advisory");
    assert.equal(r.escalate_to, "lead");
    assert.match(r.reason, /contradicts_decision: override tagged decision/);
    assert.match(r.reason, /contradicts monorepo-layout/);
  });

  test("dissent: whitespace-only tag is treated as no tag", () => {
    const r = evaluateDissent({ action: "plain work", stakes: "medium", reversible: true, contradicts_decision_tag: "   " });
    assert.equal(r.trigger, null);
    assert.equal(r.severity, "none");
    assert.equal(r.escalate_to, null);
  });

  test("dissent: budget_status exceeded → budget_exceeded, blocking, escalate to cto", () => {
    const r = evaluateDissent({ action: "spawn more agents", stakes: "low", reversible: true, budget_status: "exceeded" });
    assert.equal(r.trigger, "budget_exceeded");
    assert.equal(r.severity, "blocking");
    assert.equal(r.escalate_to, "cto");
    assert.match(r.reason, /budget_exceeded: spawn more agents/);
  });

  test("dissent: multiple triggers → blocking, cto, budget_exceeded precedence, reason lists every trigger", () => {
    const r = evaluateDissent({
      action: "migrate schema in prod",
      stakes: "high",
      reversible: false,
      budget_status: "exceeded",
    });
    assert.equal(r.trigger, "budget_exceeded"); // budget_exceeded > high_stakes > irreversible
    assert.equal(r.severity, "blocking");
    assert.equal(r.escalate_to, "cto");
    assert.match(r.reason, /high_stakes: migrate schema in prod/);
    assert.match(r.reason, /irreversible: migrate schema in prod/);
    assert.match(r.reason, /budget_exceeded: migrate schema in prod/);
  });

  test("dissentGate: low + reversible with unlimited/missing budget → ok", () => {
    const state = withBudget(dissentState());
    const r = dissentGate(state, "quality", { stakes: "low", reversible: true });
    assert.deepEqual(r, { ok: true });
  });

  test("dissentGate: high stakes → blocked with trigger name, teamId, escalate-to-cto reason", () => {
    const state = dissentState();
    const r = dissentGate(state, "quality", { stakes: "high", reversible: true });
    assert.equal(r.ok, false);
    if (!r.ok) {
      assert.match(r.reason, /high_stakes/);
      assert.match(r.reason, /quality/);
      assert.match(r.reason, /must escalate to cto/);
    }
  });

  test("dissentGate: irreversible → blocked with trigger name, teamId, escalate-to-cto reason", () => {
    const state = dissentState();
    const r = dissentGate(state, "quality", { stakes: "low", reversible: false });
    assert.equal(r.ok, false);
    if (!r.ok) {
      assert.match(r.reason, /irreversible/);
      assert.match(r.reason, /quality/);
      assert.match(r.reason, /must escalate to cto/);
    }
  });

  test("dissentGate: budget exceeded → blocked first, reason names teamId and action shape", () => {
    const state = withBudget(dissentState(), {
      policy: { token_limit: 1000, dollar_limit: null, time_limit_ms: null },
      accounting: { tokens_estimated: 2500, dollars_estimated: 0, elapsed_ms: 0, per_team: {} },
    });
    const r = dissentGate(state, "quality", { stakes: "low", reversible: true });
    assert.equal(r.ok, false);
    if (!r.ok) {
      assert.match(r.reason, /budget exceeded/);
      assert.match(r.reason, /quality/);
      assert.match(r.reason, /must escalate to cto/);
      assert.match(r.reason, /stakes: low/);
      assert.match(r.reason, /reversible: true/);
    }
  });

  test("dissentGate: state without the optional budget field does not throw (schema-2 optional)", () => {
    const state = dissentState();
    delete (state as { budget?: unknown }).budget;
    // checkBudget treats missing budget as unlimited (D3), so high stakes still blocks.
    const r = dissentGate(state, "quality", { stakes: "high", reversible: true });
    assert.equal(r.ok, false);
  });
});
