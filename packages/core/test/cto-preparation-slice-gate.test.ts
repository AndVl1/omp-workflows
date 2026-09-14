import { test } from "node:test";
import { createHash } from "node:crypto";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  CTO_SPECIFICATION_PREPARATION_CLASSIFICATION,
  prepareCtoSpecificationPreparation as prepareCtoSpecificationPreparationRaw,
  resolveCtoSpecificationPreparationSliceMarker,
} from "../src/cto/specification-preparation.js";
import { assertCtoSliceDispatchable as assertCtoSliceDispatchablePinned } from "../src/cto/slice-gate.js";
import { PinnedProjectRoot } from "../src/specification/pinned-root.js";
import { readCtoState } from "../src/cto/state.js";
import { openWorkflowActivation, releaseWorkflowOwners, type WorkflowOwnerIdentity } from "../src/registry/owner.js";
import { openCtoRuntimeAccess } from "../src/cto/runtime-access.js";

function assertCtoSliceDispatchable(state: Parameters<typeof assertCtoSliceDispatchablePinned>[0], opts: { sliceId: string; root: string; markerRunId?: string }) {
  const pinnedRoot = PinnedProjectRoot.open(opts.root);
  if (!pinnedRoot) throw new Error("preparation slice test root cannot be pinned");
  try {
    return assertCtoSliceDispatchablePinned(state, { sliceId: opts.sliceId, markerRunId: opts.markerRunId, pinnedRoot });
  } finally {
    pinnedRoot.close();
  }
}

const CONSTITUTION = "# Project Constitution\n\nVersion: 1.0.0\n\n## Quality\n\nEvery change ships with behavioral tests.\n";
const FULLSTACK_MARKER = "{\"schema_version\":1,\"bundle_id\":\"@andvl1/omp-workflows-fullstack\",\"entrypoint\":\"dist/index.js\"}\n";
const FULLSTACK_MARKER_SHA256 = createHash("sha256").update(FULLSTACK_MARKER, "utf8").digest("hex");
function prepareWithRuntime(root: string, input: Parameters<typeof prepareCtoSpecificationPreparationRaw>[1]): ReturnType<typeof prepareCtoSpecificationPreparationRaw> {
  mkdirSync(join(root, ".omp"), { recursive: true });
  writeFileSync(join(root, ".omp", "fullstack.activation.json"), FULLSTACK_MARKER, "utf8");
  const owner: WorkflowOwnerIdentity = {
    owner_id: "fullstack-preparation-slice-test",
    bundle_id: "@andvl1/omp-workflows-fullstack",
    owner_kind: "fullstack",
    activation_marker: "fullstack-preparation-slice-test-v1",
    host_range: ">=17.0.0",
    activation: { marker_id: "fullstack-preparation-slice-test-v1", required: [{ path: ".omp/fullstack.activation.json", kind: "file", sha256: FULLSTACK_MARKER_SHA256 }] },
    provenance: { package: "@andvl1/omp-workflows-fullstack", entrypoint: "dist/index.js", cwd: root },
  };
  const activation = openWorkflowActivation(root, ["workflow_registration", "workflow_tools"], owner);
  assert.equal(activation.ok, true);
  if (!activation.ok) throw new Error(activation.error);
  try {
    const opened = openCtoRuntimeAccess(activation.registry_context, { sessionId: "preparation-slice-test", main: true }, root);
    assert.equal(opened.ok, true);
    if (!opened.ok) throw new Error(opened.error);
    return prepareCtoSpecificationPreparationRaw(root, input, { runtimeAccess: opened.access, sessionId: "preparation-slice-test" });
  } finally {
    releaseWorkflowOwners(activation.release_token, ["workflow_registration", "workflow_tools"]);
  }
}

test("engine preparation writer slices carry canonical classification and remain isolated", () => {
  const root = mkdtempSync(join(tmpdir(), "cto-preparation-slice-gate-"));
  try {
    writeFileSync(join(root, "CONSTITUTION.md"), CONSTITUTION, "utf8");
    const prepared = prepareWithRuntime(root, {
      cto_run_id: "resident-preparation",
      resident_cto_run_id: "resident-preparation",
      task: "prepare two specifications",
      branch: "main",
      capacity: 8,
      depth: 0,
      max_depth: 2,
      requests: [
        { request_id: "request-a", feature_id: "feature-a", request: "Prepare feature A", facet_ids: ["primary", "secondary"] },
        { request_id: "request-b", feature_id: "feature-b", request: "Prepare feature B" },
        { request_id: "request-c", feature_id: "feature-c", request: "Prepare feature C" },
      ],
    });
    assert.equal(prepared.status, "ready", JSON.stringify(prepared));
    if (prepared.status !== "ready") return;
    const state = readCtoState(prepared.cto_run_id, root);
    assert.ok(state);
    if (!state) return;
    assert.deepEqual(state.teams.map((team) => team.classification), [
      CTO_SPECIFICATION_PREPARATION_CLASSIFICATION,
      CTO_SPECIFICATION_PREPARATION_CLASSIFICATION,
      CTO_SPECIFICATION_PREPARATION_CLASSIFICATION,
    ]);
    assert.notEqual(prepared.features[0]!.phase_writer_id, prepared.features[1]!.phase_writer_id);
    for (const team of state.teams) {
      assert.ok(team.dod_path, "preparation team carries its canonical DoD path");
      assert.ok(team.dod_digest, "preparation team carries its canonical DoD digest");
      if (!team.dod_path) continue;
      const artifact = JSON.parse(readFileSync(join(root, team.dod_path, "dod.json"), "utf8")) as { items?: Array<{ id?: string; criterion?: string; verify_method?: string }>; type_requirements_met?: boolean };
      assert.equal(artifact.type_requirements_met, true);
      assert.equal(artifact.items?.length, 6);
      assert.ok(artifact.items?.every((item) => {
        const criterion = item.criterion ?? "";
        return criterion.includes("run=" + prepared.cto_run_id)
          && criterion.includes("team=" + team.id)
          && criterion.includes("phase=specify")
          && (team !== state.teams[0] || criterion.includes("facets=primary,secondary"));
      }));
    }

    for (const feature of prepared.features) {
      const marker = resolveCtoSpecificationPreparationSliceMarker(root, feature.feature_id, feature.run_key);
      assert.equal(marker, `<!-- omp-cto-slice run=${prepared.cto_run_id} slice=${feature.phase_writer_id} -->`);
      assert.deepEqual(assertCtoSliceDispatchable(state, {
        sliceId: feature.phase_writer_id,
        root,
        markerRunId: prepared.cto_run_id,
      }), { ok: true });
    }

    const first = state.teams[0]!;
    const original = first.classification;
    for (const malformed of [
      undefined,
      { type: "SPEC" },
      { type: "FEATURE", complexity: "MEDIUM", confidence: "HIGH", autonomous: true, workflow: "standard" },
    ]) {
      first.classification = malformed as typeof first.classification;
      const rejected = assertCtoSliceDispatchable(state, {
        sliceId: prepared.features[0]!.phase_writer_id,
        root,
        markerRunId: prepared.cto_run_id,
      });
      assert.equal(rejected.ok, false);
      assert.match(rejected.ok ? "" : rejected.reason, /slice (classification invalid|workflow mismatch)/);
      assert.deepEqual(assertCtoSliceDispatchable(state, {
        sliceId: prepared.features[1]!.phase_writer_id,
        root,
        markerRunId: prepared.cto_run_id,
      }), { ok: true }, "a malformed writer must not authorize another feature's writer");
    }
    first.classification = original;
  } finally {
    rmSync(root, { recursive: true, force: true });
  }

});

test("generated preparation DoD rejects missing stale cross-team and tampered artifacts", () => {
  const root = mkdtempSync(join(tmpdir(), "cto-preparation-dod-integrity-"));
  try {
    writeFileSync(join(root, "CONSTITUTION.md"), CONSTITUTION, "utf8");
    const prepared = prepareWithRuntime(root, {
      cto_run_id: "resident-preparation-integrity",
      resident_cto_run_id: "resident-preparation-integrity",
      task: "prepare three specifications",
      branch: "main",
      capacity: 8,
      depth: 0,
      max_depth: 2,
      requests: [
        { request_id: "request-a", feature_id: "feature-a", request: "Prepare feature A" },
        { request_id: "request-b", feature_id: "feature-b", request: "Prepare feature B" },
        { request_id: "request-c", feature_id: "feature-c", request: "Prepare feature C" },
      ],
    });
    assert.equal(prepared.status, "ready", JSON.stringify(prepared));
    if (prepared.status !== "ready") return;
    const state = readCtoState(prepared.cto_run_id, root);
    assert.ok(state);
    if (!state) return;
    const first = state.teams[0]!;
    const second = state.teams[1]!;
    assert.ok(first.dod_path && second.dod_path);
    if (!first.dod_path || !second.dod_path) return;
    const firstFile = join(root, first.dod_path, "dod.json");
    const secondFile = join(root, second.dod_path, "dod.json");
    const firstRaw = readFileSync(firstFile, "utf8");
    const secondRaw = readFileSync(secondFile, "utf8");
    const dispatch = (team: typeof first) => assertCtoSliceDispatchable(state, { sliceId: team.slice_id!, root, markerRunId: prepared.cto_run_id });
    assert.deepEqual(dispatch(first), { ok: true });
    unlinkSync(firstFile);
    const missing = dispatch(first);
    assert.equal(missing.ok, false);
    if (!missing.ok) assert.match(missing.reason, /slice DoD unreadable/);
    writeFileSync(firstFile, firstRaw, "utf8");

    const staleDigest = first.dod_digest;
    first.dod_digest = "0".repeat(64);
    const stale = dispatch(first);
    assert.equal(stale.ok, false);
    if (!stale.ok) assert.match(stale.reason, /slice DoD digest mismatch/);
    first.dod_digest = staleDigest;

    writeFileSync(firstFile, secondRaw, "utf8");
    const crossTeam = dispatch(first);
    assert.equal(crossTeam.ok, false);
    if (!crossTeam.ok) assert.match(crossTeam.reason, /slice DoD digest mismatch/);
    writeFileSync(firstFile, firstRaw, "utf8");

    const tampered = JSON.parse(firstRaw) as { items: Array<{ criterion: string }> };
    tampered.items[0]!.criterion += " tampered";
    writeFileSync(firstFile, JSON.stringify(tampered), "utf8");
    const tamper = dispatch(first);
    assert.equal(tamper.ok, false);
    if (!tamper.ok) assert.match(tamper.reason, /slice DoD digest mismatch/);

    writeFileSync(firstFile, firstRaw, "utf8");
    assert.deepEqual(dispatch(first), { ok: true });
    assert.deepEqual(dispatch(second), { ok: true }, "foreign writer remains isolated");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});