/**
 * CTO slice dispatch gate tests (cto-core, architecture-3/7): fail-closed
 * checks (marker run mismatch, missing active wave, unknown slice, per-field
 * classification validation, matrix workflow mismatch, missing/unreadable/
 * empty per-slice DoD) and the allow path (no marker / fully valid state).
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { type TeamState } from "../src/engine/types.js";
import { resolveWorkflow } from "../src/engine/profile.js";
import { ctoRuntimeRunInitialIdentityDigest, mintCtoRuntimeRunOrigin, newCtoState, readCtoState, writeCtoRuntimeStateProof, writeCtoState, type CtoState } from "../src/cto/state.js";
import {
  buildCtoSliceMarker,
  parseCtoSliceMarker,
  assertCtoSliceDispatchable,
  ctoSliceTaskGate,
  validateSliceClassification,
  validateSliceWorkflow,
  CTO_SLICE_MARKER_PREFIX,
} from "../src/cto/slice-gate.js";
import type { ModelClassification } from "../src/cto/types.js";
import { PinnedProjectRoot } from "../src/specification/pinned-root.js";
import { applyAppendWaveTransition, applyFinishWaveTransition } from "../src/cto/state.js";
import { canonicalCtoDoDDigest } from "../src/cto/dod.js";
import { writeState } from "../src/engine/state.js";
import { openWorkflowActivation, releaseWorkflowOwners, type WorkflowOwnerIdentity } from "../src/registry/owner.js";
import { openCtoRuntimeAccess } from "../src/cto/runtime-access.js";

function replaceState(target: CtoState, next: CtoState): CtoState {
  if (target === next) return target;
  for (const key of Object.keys(target)) delete (target as unknown as Record<string, unknown>)[key];
  Object.assign(target, next);
  return target;
}
function appendWave(state: CtoState, opts: Parameters<typeof applyAppendWaveTransition>[1]): CtoState {
  return replaceState(state, applyAppendWaveTransition(state, opts));
}
function finishWave(state: CtoState, opts: Parameters<typeof applyFinishWaveTransition>[1]): CtoState {
  return replaceState(state, applyFinishWaveTransition(state, opts));
}

const CLASSIFICATION: ModelClassification = { type: "FEATURE", complexity: "MEDIUM", confidence: "HIGH", autonomous: true };
const EXPECTED_WORKFLOW = resolveWorkflow(CLASSIFICATION.type, CLASSIFICATION.complexity, CLASSIFICATION.autonomous); // "standard"
const TEST_ACTIVATION_MARKER = "{\"schema_version\":1,\"bundle_id\":\"@andvl1/omp-workflows-fullstack\",\"entrypoint\":\"dist/index.js\"}\n";
const TEST_ACTIVATION_SHA256 = createHash("sha256").update(TEST_ACTIVATION_MARKER, "utf8").digest("hex");

function ownerFor(root: string): WorkflowOwnerIdentity {
  return {
    owner_id: "cto-slice-gate-test",
    bundle_id: "@andvl1/omp-workflows-fullstack",
    owner_kind: "fullstack",
    activation_marker: "cto-slice-gate-test-v1",
    host_range: ">=17.0.0",
    activation: {
      marker_id: "cto-slice-gate-test-v1",
      required: [{ path: ".omp/fullstack.activation.json", kind: "file", sha256: TEST_ACTIVATION_SHA256 }],
    },
    provenance: {
      package: "@andvl1/omp-workflows-fullstack",
      entrypoint: "dist/index.js",
      cwd: root,
    },
  };
}

interface RunFixture {
  root: string;
  pinnedRoot: PinnedProjectRoot;
  state: CtoState;
  runId: string;
  sliceId: string;
  teamId: string;
  closeAccess: () => void;
  refreshAuthority: () => void;
  releaseToken: Parameters<typeof releaseWorkflowOwners>[0];
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
    owner_session: "slice-gate-test-session",
    standby: true,
    plan: {
      id: runId,
      task: "wave task",
      teams: [{ team: teamId, team_def_id: teamId, scope: ["backend-kotlin"], slice: sliceId, profile: "lightweight", worktree: "same_branch", depends_on: [] }],
      created_at: now,
    },
  });
  const team = state.teams[0]!;
  team.team_def_id = teamId;
  team.slice_id = sliceId;
  team.classification = CLASSIFICATION;
  team.workflow = EXPECTED_WORKFLOW;
  appendWave(state, { id: "wave-1", source: "inbox", source_id: "m1", task: "t", slice_ids: [sliceId] });
  mkdirSync(join(root, ".omp"), { recursive: true });
  writeFileSync(join(root, ".omp", "fullstack.activation.json"), TEST_ACTIVATION_MARKER);
  const dodDir = join(root, ".work-state", "artifacts", teamId);
  mkdirSync(dodDir, { recursive: true });
  const dodValue = {
    items: [{ id: "d1", source: "test", criterion: "c", verify_method: "v", status: "pending", evidence: "" }],
    type_requirements_met: true,
    updated_at: now,
  };
  writeFileSync(join(dodDir, "dod.json"), JSON.stringify(dodValue));
  team.dod_digest = canonicalCtoDoDDigest(dodValue);
  const runtimeRoot = PinnedProjectRoot.open(root);
  if (!runtimeRoot) throw new Error("slice-gate fixture root cannot be pinned");
  if (!mintCtoRuntimeRunOrigin(runtimeRoot, state, "slice-gate-test-session", "slice-gate-test", ctoRuntimeRunInitialIdentityDigest(state))) throw new Error("slice-gate fixture runtime origin could not be minted");
  writeCtoState(state, root, { pinnedRoot: runtimeRoot, preCommit: ({ pinnedRoot }) => pinnedRoot.assertStable() });
  const persisted = readCtoState(runId, root);
  if (!persisted || !writeCtoRuntimeStateProof(runtimeRoot, persisted)) throw new Error("slice-gate fixture runtime proof could not be written");
  const activation = openWorkflowActivation(root, ["workflow_registration", "workflow_tools"], ownerFor(root));
  if (!activation.ok) throw new Error(activation.error);
  const opened = openCtoRuntimeAccess(activation.registry_context, { sessionId: "slice-gate-test-session", main: true }, root);
  if (!opened.ok) {
    releaseWorkflowOwners(activation.release_token, ["workflow_registration", "workflow_tools"]);
    throw new Error(opened.error);
  }
  if (!opened.access.findActiveRun()) {
    opened.access.close();
    releaseWorkflowOwners(activation.release_token, ["workflow_registration", "workflow_tools"]);
    throw new Error("slice-gate fixture active run could not be authenticated");
  }
  return { root, pinnedRoot: runtimeRoot, state, runId, sliceId, teamId, closeAccess: opened.access.close, refreshAuthority: () => { opened.access.findActiveRun(); }, releaseToken: activation.release_token };
}

function cleanup(f: RunFixture): void {
  f.closeAccess();
  f.pinnedRoot.close();
  releaseWorkflowOwners(f.releaseToken, ["workflow_registration", "workflow_tools"]);
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

test("cto-slice-gate: marker parsing is bounded, exact-format, and rejects unsafe or ambiguous ids", () => {
  const valid = buildCtoSliceMarker("run-1", "slice-1");
  assert.equal(parseCtoSliceMarker("<!--  omp-cto-slice run=run-1 slice=slice-1 -->"), null, "extra spacing is not the exact marker");
  assert.equal(parseCtoSliceMarker(buildCtoSliceMarker("..", "slice-1")), null, "dot run id is unsafe");
  assert.equal(parseCtoSliceMarker(buildCtoSliceMarker("run-1", "..")), null, "dot slice id is unsafe");
  assert.equal(parseCtoSliceMarker(`${valid} ${valid}`), null, "multiple markers are ambiguous");
  assert.equal(parseCtoSliceMarker(`${valid} <!--  omp-cto-slice run=run-1 slice=slice-1 -->`), null, "malformed second marker is ambiguous");
  assert.equal(parseCtoSliceMarker(`${"x".repeat(16_384)}${valid}`), null, "oversized payload is rejected before scanning");
});

test("cto-slice-gate: fully valid per-slice state dispatches (allow)", () => {
  const f = validRun();
  try {
    assert.deepEqual(assertCtoSliceDispatchable(f.state, { sliceId: f.sliceId, pinnedRoot: f.pinnedRoot, markerRunId: f.runId }), { ok: true });
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
    const r = assertCtoSliceDispatchable(f.state, { sliceId: f.sliceId, pinnedRoot: f.pinnedRoot, markerRunId: "other-run" });
    assert.match(blockReason(r), /marker run mismatch: expected run-1, marker says other-run/);
  } finally {
    cleanup(f);
  }
});

test("cto-slice-gate: missing active wave blocks (unset and finished variants)", () => {
  const f = validRun();
  try {
    const noWave = { ...f.state, active_wave_id: undefined };
    const r1 = assertCtoSliceDispatchable(noWave, { sliceId: f.sliceId, pinnedRoot: f.pinnedRoot });
    assert.match(blockReason(r1), /no active wave: active_wave_id is unset/);

    finishWave(f.state, { id: "wave-1", status: "done" });
    const stalePointer = { ...f.state, active_wave_id: "wave-1" }; // only in-memory: canonical disk rejects stale pointers
    const r2 = assertCtoSliceDispatchable(stalePointer, { sliceId: f.sliceId, pinnedRoot: f.pinnedRoot });
    assert.match(blockReason(r2), /no active wave: wave wave-1 is not active/);

    // Persist the canonical finished-wave state (active_wave_id cleared); the
    // disk gate must observe the same missing-active-wave decision.
    writeCtoState(f.state, f.root, { preCommit: ({ pinnedRoot }) => pinnedRoot.assertStable() });
    const gateRes = ctoSliceTaskGate({ toolName: "task", input: markerInput(f.runId, f.sliceId) }, { cwd: f.root });
    assert.equal(gateRes?.block, true);
    assert.match(gateRes?.reason ?? "", /no active wave: active_wave_id is unset/);
  } finally {
    cleanup(f);
  }
});


test("cto-slice-gate: slice must be uniquely mapped and admitted by the active wave", () => {
  const f = validRun();
  try {
    f.state.wave_history![0]!.slice_ids = ["other-slice"];
    const notAdmitted = assertCtoSliceDispatchable(f.state, { sliceId: f.sliceId, pinnedRoot: f.pinnedRoot });
    assert.match(blockReason(notAdmitted), /not uniquely admitted by active wave/);

    f.state.wave_history![0]!.slice_ids = [f.sliceId];
    f.state.teams.push({ ...f.state.teams[0]!, id: "lead-b" });
    const ambiguous = assertCtoSliceDispatchable(f.state, { sliceId: f.sliceId, pinnedRoot: f.pinnedRoot });
    assert.match(blockReason(ambiguous), /ambiguous slice slice-1/);
  } finally {
    cleanup(f);
  }
});

test("cto-slice-gate: unsafe ids and DoD paths fail closed without echoing untrusted values", () => {
  const f = validRun();
  try {
    const unsafeSlice = assertCtoSliceDispatchable(f.state, { sliceId: "..", pinnedRoot: f.pinnedRoot });
    assert.match(blockReason(unsafeSlice), /unsafe slice id/);
    const unsafeRun = assertCtoSliceDispatchable(f.state, { sliceId: f.sliceId, pinnedRoot: f.pinnedRoot, markerRunId: "../escape" });
    assert.match(blockReason(unsafeRun), /unsafe marker run id/);
    assert.doesNotMatch(blockReason(unsafeRun), /\.\.\/escape/);
    f.state.teams[0]!.dod_path = "../escape";
    const unsafeDod = assertCtoSliceDispatchable(f.state, { sliceId: f.sliceId, pinnedRoot: f.pinnedRoot });
    assert.match(blockReason(unsafeDod), /slice DoD path invalid/);
    assert.doesNotMatch(blockReason(unsafeDod), /\.\.\/escape/);
  } finally {
    cleanup(f);
  }
});
test("cto-slice-gate: unknown slice blocks", () => {
  const f = validRun();
  try {
    const r = assertCtoSliceDispatchable(f.state, { sliceId: "nope", pinnedRoot: f.pinnedRoot });
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
      const r = assertCtoSliceDispatchable(f.state, { sliceId: f.sliceId, pinnedRoot: f.pinnedRoot });
      assert.match(blockReason(r), new RegExp(c.field), `${c.label} names the field`);
    } finally {
      cleanup(f);
    }
  }

  // classification entirely absent → all four fields listed
  const f = validRun();
  try {
    delete f.state.teams[0]!.classification;
    const r = assertCtoSliceDispatchable(f.state, { sliceId: f.sliceId, pinnedRoot: f.pinnedRoot });
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
    const r = assertCtoSliceDispatchable(f.state, { sliceId: f.sliceId, pinnedRoot: f.pinnedRoot });
    assert.match(blockReason(r), /workflow mismatch: expected debug-cycle, got bug-fix/);
  } finally {
    cleanup(f);
  }
});
test("cto-slice-gate: SPEC and REGRESS reject any workflow that disagrees with the classification matrix", () => {
  for (const type of ["SPEC", "REGRESS"] as const) {
    const f = validRun();
    try {
      const team = f.state.teams[0]!;
      team.classification = { type, complexity: "CRITICAL", confidence: "HIGH", autonomous: true };
      team.workflow = type === "SPEC" ? "feature-regression" : "spec-preparation";
      const expected = resolveWorkflow(type, "CRITICAL", true);
      const r = assertCtoSliceDispatchable(f.state, { sliceId: f.sliceId, pinnedRoot: f.pinnedRoot });
      assert.equal(expected, type === "SPEC" ? "spec-preparation" : "feature-regression");
      assert.match(blockReason(r), new RegExp(`workflow mismatch: expected ${expected}`));
    } finally {
      cleanup(f);
    }
  }
});

test("cto-slice-gate: missing/unreadable/empty per-slice DoD blocks", () => {
  // missing
  const f1 = validRun();
  try {
    rmSync(join(f1.root, ".work-state", "artifacts", f1.teamId), { recursive: true, force: true });
    const r = assertCtoSliceDispatchable(f1.state, { sliceId: f1.sliceId, pinnedRoot: f1.pinnedRoot });
    assert.match(blockReason(r), /slice DoD unreadable: .* (no dod\.json at|anchored path does not exist)/);
  } finally {
    cleanup(f1);
  }
  // unreadable (malformed JSON)
  const f2 = validRun();
  try {
    writeFileSync(join(f2.root, ".work-state", "artifacts", f2.teamId, "dod.json"), "{ nope !!");
    const r = assertCtoSliceDispatchable(f2.state, { sliceId: f2.sliceId, pinnedRoot: f2.pinnedRoot });
    assert.match(blockReason(r), /slice DoD unreadable/);
  } finally {
    cleanup(f2);
  }
  // empty (no items)
  const f3 = validRun();
  try {
    const emptyDod = { items: [], type_requirements_met: false, updated_at: new Date().toISOString() };
    writeFileSync(
      join(f3.root, ".work-state", "artifacts", f3.teamId, "dod.json"),
      JSON.stringify(emptyDod),
    );
    const r = assertCtoSliceDispatchable(f3.state, { sliceId: f3.sliceId, pinnedRoot: f3.pinnedRoot });
    assert.match(blockReason(r), /slice DoD (empty: .* has no items|digest missing)/);
  } finally {
    cleanup(f3);
  }
});

test("cto-slice-gate: team dod_path (relative to root) is honored when set", () => {
  const f = validRun();
  try {
    const customDir = join(".work-state", "artifacts", "custom-dod");
    mkdirSync(join(f.root, customDir), { recursive: true });
    const customDod = { items: [{ id: "c1", source: "test", criterion: "c", verify_method: "v", status: "pending", evidence: "" }], type_requirements_met: true, updated_at: new Date().toISOString() };
    writeFileSync(
      join(f.root, customDir, "dod.json"),
      JSON.stringify(customDod),
    );
    f.state.teams[0]!.dod_digest = canonicalCtoDoDDigest(customDod);
    f.state.teams[0]!.dod_path = customDir;
    const r = assertCtoSliceDispatchable(f.state, { sliceId: f.sliceId, pinnedRoot: f.pinnedRoot });
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

test("cto-slice-gate: canonical feature state over 1 MiB remains readable for marker admission", () => {
  const f = validRun();
  try {
    finishWave(f.state, { id: "wave-1", status: "done" });
    const team = f.state.teams[0]!;
    team.feature_id = "large-feature";
    team.run_key = "large-feature-run";
    const identity = {
      run_id: f.runId,
      wave_id: "wave-spec",
      slice_id: f.sliceId,
      session_id: "session-1",
      workflow: "standard" as const,
      stage_id: "execution",
      stage_cursor: "execution",
      capability_id: "capability-1",
      capability_epoch: "epoch-1",
      slot_id: f.sliceId,
      task_id: "task-1",
      dispatch_id: "dispatch-1",
      attempt: 1,
      worker_id: "worker-1",
    };
    team.work_identity = identity;
    appendWave(f.state, {
      id: "wave-spec",
      source: "specification-execution",
      source_id: "spec-message-1",
      task: "execute large feature",
      slice_ids: [f.sliceId],
      work_identity: identity,
    });

    const featureState = {
      schema: 1,
      branch: "large-feature",
      run_key: "large-feature-run",
      state_revision: 1,
      classification: { type: "FEATURE", complexity: "MEDIUM", confidence: "HIGH", autonomous: true, workflow: "standard" },
      task: "large feature",
      workflow_override: false,
      stage_cursor: "",
      stages: [],
      artifacts: {},
      issue: null,
      pause: { kind: "none", reason: "" },
      updated_at: new Date().toISOString(),
      padding: Array.from({ length: 6 }, () => "x".repeat(200_000)),
    } as unknown as TeamState;
    writeState(f.root, featureState, { featureSlug: "large-feature" });
    const featurePath = join(f.root, ".work-state", "features", "large-feature", "state.json");
    const featureBytes = Buffer.byteLength(readFileSync(featurePath, "utf8"), "utf8");
    assert.ok(featureBytes > 1 * 1024 * 1024, `canonical feature fixture must exceed 1 MiB (got ${featureBytes})`);
    assert.ok(featureBytes <= 8 * 1024 * 1024, `canonical feature fixture must stay within 8 MiB writer cap (got ${featureBytes})`);

    const result = assertCtoSliceDispatchable(f.state, { sliceId: f.sliceId, pinnedRoot: f.pinnedRoot, markerRunId: f.runId });
    assert.equal(result.ok, true, "marker admission must read a canonical feature state larger than the old 1 MiB gate cap");
  } finally {
    cleanup(f);
  }
});

test("cto-slice-gate: delivery-index recovery blocks unmarked tasks and keeps valid markers routable", () => {
  const f = validRun();
  const indexPath = join(f.root, ".work-state", "cto", "active-run-index.json");
  try {
    // Missing and malformed indexes are rebuilt from canonical state under
    // the delivery-index transaction lock.
    unlinkSync(indexPath);
    const missing = ctoSliceTaskGate({ toolName: "task", input: { task: "plain task" } }, { cwd: f.root });
    assert.equal(missing?.block, true);
    assert.match(missing?.reason ?? "", /active wave|recovery_required/);
    assert.equal(existsSync(indexPath), false, "unrecoverable missing index must not be rewritten by no-marker admission");

    writeFileSync(indexPath, "{not-json");
    const corrupt = ctoSliceTaskGate({ toolName: "task", input: { task: "plain task" } }, { cwd: f.root });
    assert.equal(corrupt?.block, true);
    assert.match(corrupt?.reason ?? "", /active wave|recovery_required/);
    const marker = ctoSliceTaskGate({ toolName: "task", input: markerInput(f.runId, f.sliceId) }, { cwd: f.root });
    assert.equal(marker, undefined, "a valid marker remains routable even when no-marker authority recovery is unavailable");
  } finally {
    cleanup(f);
  }
});

test("cto-slice-gate: forged valid delivery indexes cannot omit or stale an active run", () => {
  const f = validRun();
  const indexPath = join(f.root, ".work-state", "cto", "active-run-index.json");
  try {
    const original = JSON.parse(readFileSync(indexPath, "utf8")) as {
      schema_version: number;
      active_run_id: string | null;
      entries: Array<Record<string, unknown>>;
    };
    const marker = markerInput(f.runId, f.sliceId);
    for (const [label, forged] of [
      ["omitted", { ...original, active_run_id: null, entries: [] }],
      ["stale digest", {
        ...original,
        entries: original.entries.map((entry) => entry.run_id === f.runId ? { ...entry, summary_digest: "0".repeat(64) } : entry),
      }],
    ] as const) {
      writeFileSync(indexPath, JSON.stringify(forged) + "\n");
      const blocked = ctoSliceTaskGate({ toolName: "task", input: { task: "plain task" } }, { cwd: f.root });
      assert.equal(blocked?.block, true, `${label} active-run metadata must not allow an unmarked task`);
      assert.match(blocked?.reason ?? "", /active wave|unavailable|invalid/);
      assert.equal(ctoSliceTaskGate({ toolName: "task", input: marker }, { cwd: f.root }), undefined, `${label} valid marker remains canonical-state routed after canonical index recovery`);
    }
  } finally {
    cleanup(f);
  }
});

test("cto-slice-gate: wave-less state with no marker → allow; non-task tools → allow; no .work-state/cto dir → allow", () => {
  const f = validRun();
  try {
    // genuinely wave-less: finish the wave and persist (active_wave_id cleared)
    finishWave(f.state, { id: "wave-1", status: "done" });
    writeCtoState(f.state, f.root, { preCommit: ({ pinnedRoot }) => pinnedRoot.assertStable() });
    f.refreshAuthority();
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
    // Finish the admitted wave through the canonical transition before
    // persisting the standby image; an active history record without an
    // active_wave_id is not a valid authority state.
    finishWave(f.state, { id: "wave-1", status: "done" });
    writeCtoState(f.state, f.root, { preCommit: ({ pinnedRoot }) => pinnedRoot.assertStable() });
    f.refreshAuthority();
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
      {
        toolName: "task",
        input: {
          context: marker,
          name: marker,
          agent: marker,
          outputSchema: marker,
          task: "plain task",
        },
      },
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

test("cto-slice-gate: preparation markers remain bound to each feature slice", () => {
  const f = validRun();
  try {
    const first = f.state.teams[0]!;
    first.feature_id = "feature-a";
    first.run_key = "feature-a-run";
    const second = { ...first, id: "lead-b", team_def_id: "lead-b", slice_id: "slice-2", feature_id: "feature-b", run_key: "feature-b-run" };
    f.state.teams.push(second);
    const wave = f.state.wave_history.find((candidate) => candidate.id === f.state.active_wave_id);
    assert.ok(wave);
    if (!wave) return;
    wave.source = "specification-preparation";
    wave.slice_ids = ["slice-1", "slice-2"];
    const secondDodDir = join(f.root, ".work-state", "artifacts", "lead-b");
    mkdirSync(secondDodDir, { recursive: true });
    const secondDod = { items: [{ id: "d2", source: "test", criterion: "c", verify_method: "v", status: "pending", evidence: "" }], type_requirements_met: true, updated_at: new Date().toISOString() };
    writeFileSync(join(secondDodDir, "dod.json"), JSON.stringify(secondDod));
    second.dod_digest = canonicalCtoDoDDigest(secondDod);
    writeCtoState(f.state, f.root, { preCommit: ({ pinnedRoot }) => pinnedRoot.assertStable() });
    const nativeTask = (featureRun: string, sliceId: string): string => "<!-- omp-dispatch run=" + featureRun + " stage=specify kind=single cursor=specify roles=specification-analyst role=specification-analyst capability=cap slot=specification-analyst task=task -->\n" + buildCtoSliceMarker(f.runId, sliceId);
    const validBatch = ctoSliceTaskGate({ toolName: "task", input: { tasks: [{ task: nativeTask("feature-a-run", "slice-1") }, { task: nativeTask("feature-b-run", "slice-2") }] } }, { cwd: f.root });
    assert.equal(validBatch, undefined, "each feature may dispatch only its own engine-selected marker");
    const crossFeature = ctoSliceTaskGate({ toolName: "task", input: { task: nativeTask("feature-a-run", "slice-2") } }, { cwd: f.root });
    assert.equal(crossFeature?.block, true, "a feature-A native dispatch cannot carry feature-B slice marker");
    assert.match(crossFeature?.reason ?? "", /task dispatch run mismatch.*feature-b-run.*feature-a-run/);
    const literal = ctoSliceTaskGate({ toolName: "task", input: { task: buildCtoSliceMarker(f.runId, "specification-preparation") } }, { cwd: f.root });
    assert.equal(literal?.block, true, "the wave work identity is not a dispatch slice");
    assert.match(literal?.reason ?? "", /unknown slice specification-preparation/);
  } finally {
    cleanup(f);
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

test("cto-slice-gate: batch items are independently admitted and failing item is isolated", () => {
  const f = validRun();
  try {
    const res = ctoSliceTaskGate(
      {
        toolName: "task",
        input: {
          tasks: [
            markerInput(f.runId, f.sliceId),
            { task: buildCtoSliceMarker(f.runId, "not-in-wave"), agent: "team-lead" },
          ],
        },
      },
      { cwd: f.root },
    );
    assert.equal(res?.block, true);
    assert.match(res?.reason ?? "", /unknown slice not-in-wave/);
    assert.match(res?.reason ?? "", /batch task item 1/);
  } finally {
    cleanup(f);
  }
});

test("cto-slice-gate: oversized task batches and UTF-8 task text fail closed before marker allocation", () => {
  const f = validRun();
  try {
    const markerTask = markerInput(f.runId, f.sliceId);
    const oversizedBatch = Array.from({ length: 33 }, () => markerTask);
    const tooMany = ctoSliceTaskGate({ toolName: "task", input: { tasks: oversizedBatch } }, { cwd: f.root });
    assert.equal(tooMany?.block, true, "batch over the native 32-task cap must block");
    assert.match(tooMany?.reason ?? "", /batch exceeds 32 items/);

    const oversizedText = "я".repeat(8_193);
    const tooLarge = ctoSliceTaskGate({ toolName: "task", input: { task: oversizedText } }, { cwd: f.root });
    assert.equal(tooLarge?.block, true, "task text over the UTF-8 byte cap must block");
    assert.match(tooLarge?.reason ?? "", /UTF-8 bytes/);

    const oversizedBatchText = ctoSliceTaskGate(
      { toolName: "task", input: { tasks: [{ task: oversizedText }] } },
      { cwd: f.root },
    );
    assert.equal(oversizedBatchText?.block, true, "oversized batch item text must block");
    assert.match(oversizedBatchText?.reason ?? "", /UTF-8 bytes/);
  } finally {
    cleanup(f);
  }
});

test("cto-slice-gate: ambiguous or empty batch shapes fail closed only during an active wave", () => {
  const f = validRun();
  try {
    const marker = buildCtoSliceMarker(f.runId, f.sliceId);
    const ambiguous = ctoSliceTaskGate(
      { toolName: "task", input: { task: marker, tasks: [{ task: marker }] } },
      { cwd: f.root },
    );
    assert.equal(ambiguous?.block, true);
    assert.match(ambiguous?.reason ?? "", /both task and tasks fields/);

    const empty = ctoSliceTaskGate({ toolName: "task", input: { tasks: [] } }, { cwd: f.root });
    assert.equal(empty?.block, true);
    assert.match(empty?.reason ?? "", /without a CTO slice marker/);
  } finally {
    cleanup(f);
  }
  const waveLess = mkdtempSync(join(tmpdir(), "cto-slice-gate-"));
  try {
    assert.equal(ctoSliceTaskGate({ toolName: "task", input: { task: "legacy", tasks: [] } }, { cwd: waveLess }), undefined);
    assert.equal(ctoSliceTaskGate({ toolName: "task", input: { tasks: [] } }, { cwd: waveLess }), undefined);
  } finally {
    rmSync(waveLess, { recursive: true, force: true });
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

test("cto-slice-gate: valid state allows", () => {
  const f = validRun();
  try {
    const res = ctoSliceTaskGate({ toolName: "task", input: markerInput(f.runId, f.sliceId) }, { cwd: f.root });
    assert.equal(res, undefined, "valid state allows");
  } finally {
    cleanup(f);
  }
});

test("cto-slice-gate: validateSliceClassification / validateSliceWorkflow units", () => {
  assert.equal(validateSliceClassification({ type: "FEATURE", complexity: "MEDIUM", confidence: "HIGH", autonomous: true }), null);
  // Every TaskType must be accepted, including the product-discovery intent.
  assert.equal(validateSliceClassification({ type: "PRODUCT_DISCOVERY", complexity: "COMPLEX", confidence: "HIGH", autonomous: false }), null);
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
