/**
 * CTO slice dispatch gate tests (cto-core, architecture-3/7): fail-closed
 * checks (marker run mismatch, missing active wave, unknown slice, per-field
 * classification validation, matrix workflow mismatch, missing/unreadable/
 * empty per-slice DoD) and the allow path (no marker / fully valid state).
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  newCtoState,
  writeCtoState,
  appendWave,
  finishWave,
  resolveWorkflow,
  buildCtoSliceMarker,
  parseCtoSliceMarker,
  assertCtoSliceDispatchable,
  ctoSliceTaskGate,
  validateSliceClassification,
  validateSliceWorkflow,
  CTO_SLICE_MARKER_PREFIX,
  type CtoState,
  type ModelClassification,
} from "@andvl1/omp-workflows-core";

const CLASSIFICATION: ModelClassification = { type: "FEATURE", complexity: "MEDIUM", confidence: "HIGH", autonomous: true };
const EXPECTED_WORKFLOW = resolveWorkflow(CLASSIFICATION.type, CLASSIFICATION.complexity, CLASSIFICATION.autonomous); // "standard"

interface RunFixture {
  root: string;
  state: CtoState;
  runId: string;
  sliceId: string;
  teamId: string;
}

/** Build a fully valid resident run: active wave + per-slice classification + workflow + DoD. */
function validRun(runId = "run-1", sliceId = "slice-1", teamId = "lead-a"): RunFixture {
  const root = mkdtempSync(join(tmpdir(), "cto-slice-gate-"));
  const now = new Date().toISOString();
  const state = newCtoState({
    id: runId,
    task: "wave task",
    branch: "main",
    autonomous: true,
    standby: true,
    plan: {
      id: runId,
      task: "wave task",
      teams: [{ team: teamId, scope: ["backend-kotlin"], slice: sliceId, profile: "lightweight", worktree: "same_branch", depends_on: [] }],
      created_at: now,
    },
  });
  const team = state.teams[0]!;
  team.slice_id = sliceId;
  team.classification = CLASSIFICATION;
  team.workflow = EXPECTED_WORKFLOW;
  appendWave(state, { id: "wave-1", source: "inbox", source_id: "m1", task: "t", slice_ids: [sliceId] });
  const dodDir = join(root, ".work-state", "artifacts", teamId);
  mkdirSync(dodDir, { recursive: true });
  writeFileSync(
    join(dodDir, "dod.json"),
    JSON.stringify({
      items: [{ id: "d1", source: "test", criterion: "c", verify_method: "v", status: "pending", evidence: "" }],
      type_requirements_met: true,
      updated_at: now,
    }),
  );
  writeCtoState(state, root);
  return { root, state, runId, sliceId, teamId };
}

function cleanup(f: RunFixture): void {
  rmSync(f.root, { recursive: true, force: true });
}

/** Assert a block result and return its reason (discriminated-union narrowing, no casts). */
function blockReason(r: { ok: true } | { ok: false; reason: string }): string {
  assert.equal(r.ok, false, "expected a block");
  return r.ok ? "" : r.reason;
}

function markerInput(runId: string, sliceId: string): { task: string; agent: string } {
  return { task: `${buildCtoSliceMarker(runId, sliceId)}\nImplement ${sliceId}`, agent: "team-lead" };
}

test("cto-slice-gate: build/parse round-trip and prefix", () => {
  assert.equal(CTO_SLICE_MARKER_PREFIX, "<!-- omp-cto-slice");
  const marker = buildCtoSliceMarker("run-2026-08-09", "slice-1");
  assert.equal(marker, "<!-- omp-cto-slice run=run-2026-08-09 slice=slice-1 -->");
  assert.deepEqual(parseCtoSliceMarker(marker), { runId: "run-2026-08-09", sliceId: "slice-1" });
  assert.deepEqual(parseCtoSliceMarker(`prefix ${marker} suffix`), { runId: "run-2026-08-09", sliceId: "slice-1" }, "embedded marker parses");
});

test("cto-slice-gate: parse rejects malformed markers", () => {
  assert.equal(parseCtoSliceMarker("no marker here"), null);
  assert.equal(parseCtoSliceMarker("<!-- omp-cto-slice run=run-1 -->"), null, "missing slice attribute");
  assert.equal(parseCtoSliceMarker("<!-- omp-cto-slice run=run 1 slice=s1 -->"), null, "space in runId slug");
  assert.equal(parseCtoSliceMarker("<!-- omp-cto-slice run=run-1 slice=s1"), null, "unterminated marker");
  assert.equal(parseCtoSliceMarker("<!-- omp-cto-slice run=run-1 slice=s1! -->"), null, "non-slug sliceId");
});

test("cto-slice-gate: fully valid per-slice state dispatches (allow)", () => {
  const f = validRun();
  try {
    assert.deepEqual(assertCtoSliceDispatchable(f.state, { sliceId: f.sliceId, root: f.root, markerRunId: f.runId }), { ok: true });
    const res = ctoSliceTaskGate({ toolName: "task", input: markerInput(f.runId, f.sliceId) }, { cwd: f.root });
    assert.equal(res, undefined, "valid state allows the task call");
  } finally {
    cleanup(f);
  }
});

test("cto-slice-gate: marker run mismatch blocks", () => {
  const f = validRun();
  try {
    // markerRunId is validated against the canonical state id; a stale marker
    // that points at a different run is a routing failure, not a new run.
    const r = assertCtoSliceDispatchable(f.state, { sliceId: f.sliceId, root: f.root, markerRunId: "other-run" });
    assert.match(blockReason(r), /marker run mismatch: expected run-1, marker says other-run/);
  } finally {
    cleanup(f);
  }
});

test("cto-slice-gate: missing active wave blocks (unset and finished variants)", () => {
  const f = validRun();
  try {
    const noWave = { ...f.state, active_wave_id: undefined };
    const r1 = assertCtoSliceDispatchable(noWave, { sliceId: f.sliceId, root: f.root });
    assert.match(blockReason(r1), /no active wave: active_wave_id is unset/);

    finishWave(f.state, { id: "wave-1", status: "done" });
    f.state.active_wave_id = "wave-1"; // stale pointer to a finished wave
    const r2 = assertCtoSliceDispatchable(f.state, { sliceId: f.sliceId, root: f.root });
    assert.match(blockReason(r2), /no active wave: wave wave-1 is not active/);

    // the tool_call gate reads canonical state from disk — persist the broken
    // wave state so the gate observes the same failure
    writeCtoState(f.state, f.root);
    const gateRes = ctoSliceTaskGate({ toolName: "task", input: markerInput(f.runId, f.sliceId) }, { cwd: f.root });
    assert.equal(gateRes?.block, true);
    assert.match(gateRes?.reason ?? "", /no active wave/);
  } finally {
    cleanup(f);
  }
});

test("cto-slice-gate: unknown slice blocks", () => {
  const f = validRun();
  try {
    const r = assertCtoSliceDispatchable(f.state, { sliceId: "nope", root: f.root });
    assert.match(blockReason(r), /unknown slice nope: no team with slice_id or id matching/);
  } finally {
    cleanup(f);
  }
});

test("cto-slice-gate: each missing classification field blocks with the field named", () => {
  const cases: Array<{ label: string; key: string; value: unknown; field: string }> = [
    { label: "type", key: "type", value: "NOPE", field: "type" },
    { label: "complexity", key: "complexity", value: "BIG", field: "complexity" },
    { label: "confidence", key: "confidence", value: "SURE", field: "confidence" },
    { label: "autonomous non-boolean", key: "autonomous", value: "yes", field: "autonomous" },
  ];
  for (const c of cases) {
    const f = validRun();
    try {
      const team = f.state.teams[0]!;
      // Fixture: corrupt exactly one PHASE-0 field of a valid classification;
      // the gate must fail closed and NAME the field. The double cast is
      // deliberate — we are writing an invalid value into a typed fixture.
      const corrupted = { ...(team.classification as ModelClassification), [c.key]: c.value } as unknown as ModelClassification;
      team.classification = corrupted;
      const r = assertCtoSliceDispatchable(f.state, { sliceId: f.sliceId, root: f.root });
      assert.match(blockReason(r), new RegExp(c.field), `${c.label} names the field`);
    } finally {
      cleanup(f);
    }
  }

  // classification entirely absent → all four fields listed
  const f = validRun();
  try {
    delete f.state.teams[0]!.classification;
    const r = assertCtoSliceDispatchable(f.state, { sliceId: f.sliceId, root: f.root });
    const reason = blockReason(r);
    assert.ok(reason.includes("type") && reason.includes("complexity") && reason.includes("confidence") && reason.includes("autonomous"), "all four missing fields listed");
  } finally {
    cleanup(f);
  }
});

test("cto-slice-gate: workflow mismatch vs matrix blocks with expected name (BUG_FIX/QUICK autonomous → debug-cycle)", () => {
  const f = validRun();
  try {
    const team = f.state.teams[0]!;
    team.classification = { type: "BUG_FIX", complexity: "QUICK", confidence: "HIGH", autonomous: true };
    team.workflow = "bug-fix"; // WRONG: autonomous BUG_FIX resolves to debug-cycle
    const expected = resolveWorkflow("BUG_FIX", "QUICK", true);
    assert.equal(expected, "debug-cycle");
    const r = assertCtoSliceDispatchable(f.state, { sliceId: f.sliceId, root: f.root });
    assert.match(blockReason(r), /workflow mismatch: expected debug-cycle, got bug-fix/);
  } finally {
    cleanup(f);
  }
});

test("cto-slice-gate: missing/unreadable/empty per-slice DoD blocks", () => {
  // missing
  const f1 = validRun();
  try {
    rmSync(join(f1.root, ".work-state", "artifacts", f1.teamId), { recursive: true, force: true });
    const r = assertCtoSliceDispatchable(f1.state, { sliceId: f1.sliceId, root: f1.root });
    assert.match(blockReason(r), /slice DoD unreadable: no dod\.json at/);
  } finally {
    cleanup(f1);
  }
  // unreadable (malformed JSON)
  const f2 = validRun();
  try {
    writeFileSync(join(f2.root, ".work-state", "artifacts", f2.teamId, "dod.json"), "{ nope !!");
    const r = assertCtoSliceDispatchable(f2.state, { sliceId: f2.sliceId, root: f2.root });
    assert.match(blockReason(r), /slice DoD unreadable/);
  } finally {
    cleanup(f2);
  }
  // empty (no items)
  const f3 = validRun();
  try {
    writeFileSync(
      join(f3.root, ".work-state", "artifacts", f3.teamId, "dod.json"),
      JSON.stringify({ items: [], type_requirements_met: false, updated_at: new Date().toISOString() }),
    );
    const r = assertCtoSliceDispatchable(f3.state, { sliceId: f3.sliceId, root: f3.root });
    assert.match(blockReason(r), /slice DoD empty: .* has no items/);
  } finally {
    cleanup(f3);
  }
});

test("cto-slice-gate: team dod_path (relative to root) is honored when set", () => {
  const f = validRun();
  try {
    const customDir = join(".work-state", "artifacts", "custom-dod");
    mkdirSync(join(f.root, customDir), { recursive: true });
    writeFileSync(
      join(f.root, customDir, "dod.json"),
      JSON.stringify({ items: [{ id: "c1", source: "test", criterion: "c", verify_method: "v", status: "pending", evidence: "" }], type_requirements_met: true, updated_at: new Date().toISOString() }),
    );
    f.state.teams[0]!.dod_path = customDir;
    const r = assertCtoSliceDispatchable(f.state, { sliceId: f.sliceId, root: f.root });
    assert.deepEqual(r, { ok: true });
  } finally {
    cleanup(f);
  }
});

test("cto-slice-gate: marker present but CtoState missing → block with actionable reason", () => {
  const root = mkdtempSync(join(tmpdir(), "cto-slice-gate-"));
  try {
    const res = ctoSliceTaskGate({ toolName: "task", input: markerInput("ghost-run", "slice-1") }, { cwd: root });
    assert.equal(res?.block, true);
    assert.match(res?.reason ?? "", /no CtoState for run ghost-run at \.work-state\/cto\/ghost-run\/state\.json — cannot dispatch CTO slice slice-1/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("cto-slice-gate: no marker during an active wave blocks with the marker format", () => {
  const f = validRun();
  try {
    const res = ctoSliceTaskGate({ toolName: "task", input: { task: "ordinary task without marker", agent: "team-lead" } }, { cwd: f.root });
    assert.equal(res?.block, true, "no-marker task call blocks during an active wave");
    assert.match(res?.reason ?? "", /active wave wave-1 in run run-1/, "reason names the wave and the run");
    assert.match(res?.reason ?? "", /omp-cto-slice/, "reason names the required marker format");
  } finally {
    cleanup(f);
  }
});

test("cto-slice-gate: wave-less state with no marker → allow; non-task tools → allow; no .work-state/cto dir → allow", () => {
  const f = validRun();
  try {
    // genuinely wave-less: finish the wave and persist (active_wave_id cleared)
    finishWave(f.state, { id: "wave-1", status: "done" });
    writeCtoState(f.state, f.root);
    const res = ctoSliceTaskGate({ toolName: "task", input: { task: "legacy flow" } }, { cwd: f.root });
    assert.equal(res, undefined, "no active wave → no-marker task call allowed");
    // non-task tools are never gated here
    for (const toolName of ["bash", "write", "read", "ask"]) {
      assert.equal(ctoSliceTaskGate({ toolName, input: markerInput(f.runId, f.sliceId) }, { cwd: f.root }), undefined, `${toolName} passes`);
    }
  } finally {
    cleanup(f);
  }
  // no .work-state/cto dir at all (fresh non-CTO root) → allow
  const empty = mkdtempSync(join(tmpdir(), "cto-slice-gate-"));
  try {
    assert.equal(ctoSliceTaskGate({ toolName: "task", input: { task: "plain flow" } }, { cwd: empty }), undefined, "non-CTO project allows");
  } finally {
    rmSync(empty, { recursive: true, force: true });
  }
});

test("cto-slice-gate: malformed/odd input never throws — blocks during an active wave, allows wave-less", () => {
  // active wave on disk → no-marker task calls return BLOCK objects (never throw)
  const f = validRun();
  try {
    const cases: Array<{ label: string; event: { toolName?: string; input?: unknown } }> = [
      { label: "empty input object", event: { toolName: "task", input: {} } },
      { label: "undefined input", event: { toolName: "task", input: undefined } },
      { label: "non-string task", event: { toolName: "task", input: { task: 123 } } },
      {
        label: "circular input",
        event: {
          toolName: "task",
          input: (() => {
            const circular: Record<string, unknown> = { task: "x" };
            circular.self = circular;
            return circular;
          })(),
        },
      },
    ];
    for (const c of cases) {
      const res = ctoSliceTaskGate(c.event, { cwd: f.root });
      assert.equal(res?.block, true, `${c.label}: block during active wave`);
      assert.match(res?.reason ?? "", /active wave/, `${c.label}: reason names the wave`);
    }
    assert.equal(ctoSliceTaskGate({}, { cwd: f.root }), undefined, "no toolName → allow");
    assert.equal(ctoSliceTaskGate({ toolName: "read", input: { task: "x" } }, { cwd: f.root }), undefined, "non-task tool → allow");
  } finally {
    cleanup(f);
  }
  // no active wave anywhere (fresh non-CTO root) → the same calls allow
  const empty = mkdtempSync(join(tmpdir(), "cto-slice-gate-"));
  try {
    assert.equal(ctoSliceTaskGate({ toolName: "task", input: {} }, { cwd: empty }), undefined);
    assert.equal(ctoSliceTaskGate({ toolName: "task", input: undefined }, { cwd: empty }), undefined);
    assert.equal(ctoSliceTaskGate({ toolName: "task", input: { task: 123 } }, { cwd: empty }), undefined);
    assert.equal(ctoSliceTaskGate({}, { cwd: empty }), undefined);
  } finally {
    rmSync(empty, { recursive: true, force: true });
  }
});

test("cto-slice-gate: standby run without an active wave → no-marker task call allowed", () => {
  const f = validRun();
  try {
    delete f.state.active_wave_id; // standby run, no wave admitted yet
    writeCtoState(f.state, f.root);
    const res = ctoSliceTaskGate({ toolName: "task", input: { task: "standby flow" } }, { cwd: f.root });
    assert.equal(res, undefined, "standby run without active wave allows no-marker task calls");
  } finally {
    cleanup(f);
  }
});

test("cto-slice-gate: marker outside the task payload does not count during an active wave", () => {
  const f = validRun();
  try {
    const marker = buildCtoSliceMarker(f.runId, f.sliceId);
    const res = ctoSliceTaskGate(
      { toolName: "task", input: { context: marker, task: "plain task", agent: "team-lead" } },
      { cwd: f.root },
    );
    assert.equal(res?.block, true, "marker in a non-task field is not a valid payload marker");
    assert.match(res?.reason ?? "", /active wave/);
  } finally {
    cleanup(f);
  }
});

test("cto-slice-gate: malformed marker attempt blocks during an active wave, allows wave-less", () => {
  const malformed = "<!-- omp-cto-slice run=run-1 slice=s1"; // unterminated
  const f = validRun();
  try {
    const res = ctoSliceTaskGate({ toolName: "task", input: { task: malformed } }, { cwd: f.root });
    assert.equal(res?.block, true, "malformed marker attempt blocks during an active wave");
    assert.match(res?.reason ?? "", /malformed CTO slice marker/, "reason says the marker is malformed");
    assert.match(res?.reason ?? "", /omp-cto-slice/, "reason names the expected format");
  } finally {
    cleanup(f);
  }
  const empty = mkdtempSync(join(tmpdir(), "cto-slice-gate-"));
  try {
    assert.equal(ctoSliceTaskGate({ toolName: "task", input: { task: malformed } }, { cwd: empty }), undefined, "malformed marker with no active wave → allow");
    assert.equal(ctoSliceTaskGate({ toolName: "task", input: { task: CTO_SLICE_MARKER_PREFIX } }, { cwd: empty }), undefined, "prefix-only with no active wave → allow");
  } finally {
    rmSync(empty, { recursive: true, force: true });
  }
});

test("cto-slice-gate: batch — every item with a valid marker against valid state → allow", () => {
  const f = validRun();
  try {
    const res = ctoSliceTaskGate(
      {
        toolName: "task",
        input: {
          tasks: [
            markerInput(f.runId, f.sliceId),
            { task: `${buildCtoSliceMarker(f.runId, f.sliceId)}\nSecond slice task`, agent: "team-lead" },
          ],
        },
      },
      { cwd: f.root },
    );
    assert.equal(res, undefined, "batch with all-valid markers allows");
  } finally {
    cleanup(f);
  }
});

test("cto-slice-gate: batch — one item lacking a marker blocks naming the item during an active wave", () => {
  const f = validRun();
  try {
    const res = ctoSliceTaskGate(
      {
        toolName: "task",
        input: { tasks: [markerInput(f.runId, f.sliceId), { task: "plain unmarked task", agent: "team-lead" }] },
      },
      { cwd: f.root },
    );
    assert.equal(res?.block, true, "batch with an unmarked item blocks during an active wave");
    assert.match(res?.reason ?? "", /batch task item 1/, "block names the failing item");
    assert.match(res?.reason ?? "", /active wave/);
  } finally {
    cleanup(f);
  }
  // same batch with no active wave anywhere → allow
  const empty = mkdtempSync(join(tmpdir(), "cto-slice-gate-"));
  try {
    const res = ctoSliceTaskGate(
      { toolName: "task", input: { tasks: [markerInput("ghost-run", "slice-1"), { task: "plain" }] } },
      { cwd: empty },
    );
    assert.equal(res, undefined, "batch with an unmarked item allows when no active wave");
  } finally {
    rmSync(empty, { recursive: true, force: true });
  }
});

test("cto-slice-gate: timing sanity — small valid state completes < 50ms (architecture-1)", () => {
  const f = validRun();
  try {
    const start = performance.now();
    const res = ctoSliceTaskGate({ toolName: "task", input: markerInput(f.runId, f.sliceId) }, { cwd: f.root });
    const elapsed = performance.now() - start;
    assert.equal(res, undefined, "valid state allows");
    // architecture-1 budget: the classification gate is a sync read of a
    // small JSON file; 50ms is a generous bound that keeps the test
    // deterministic on slow CI while still catching accidental fs storms.
    assert.ok(elapsed < 50, `slice gate took ${elapsed.toFixed(2)}ms — exceeds architecture-1 budget`);
  } finally {
    cleanup(f);
  }
});

test("cto-slice-gate: validateSliceClassification / validateSliceWorkflow units", () => {
  assert.equal(validateSliceClassification({ type: "FEATURE", complexity: "MEDIUM", confidence: "HIGH", autonomous: true }), null);
  assert.match(validateSliceClassification({ type: "NOPE", complexity: "MEDIUM", confidence: "HIGH", autonomous: true }) ?? "", /type/);
  assert.match(validateSliceClassification({ type: "FEATURE", complexity: "BIG", confidence: "HIGH", autonomous: true }) ?? "", /complexity/);
  assert.match(validateSliceClassification({ type: "FEATURE", complexity: "MEDIUM", confidence: "SURE", autonomous: true }) ?? "", /confidence/);
  assert.match(validateSliceClassification({ type: "FEATURE", complexity: "MEDIUM", confidence: "HIGH", autonomous: "yes" }) ?? "", /autonomous/);
  assert.match(validateSliceClassification(undefined) ?? "", /type.*complexity.*confidence.*autonomous/);
  assert.notEqual(validateSliceClassification(null), null, "null classification fails closed");

  assert.equal(validateSliceWorkflow({ type: "BUG_FIX", complexity: "QUICK", confidence: "HIGH", autonomous: true }, "debug-cycle"), null);
  const mismatch = validateSliceWorkflow({ type: "BUG_FIX", complexity: "QUICK", confidence: "HIGH", autonomous: true }, "bug-fix");
  assert.match(mismatch ?? "", /expected debug-cycle, got bug-fix/);
  const missing = validateSliceWorkflow({ type: "FEATURE", complexity: "MEDIUM", confidence: "HIGH", autonomous: true }, undefined);
  assert.match(missing ?? "", /expected standard, got missing/);
});
