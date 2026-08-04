/**
 * CTO engine tests: plan validation (caps, cycles, depth), state transitions
 * (escalation expiry, pending listing), DoD aggregation + backstop, R4
 * sanitization, runCto end-to-end.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
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
  type TeamDef,
  type Escalation,
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
