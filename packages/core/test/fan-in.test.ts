/**
 * Consilium fan-in (scope 5):
 *   - per-slot artifact provenance is recorded at completion (shared ids are
 *     snapshotted into the slot namespace before a later slot can clobber),
 *   - deterministic synthesis merges slot values in roster order and writes
 *     the stable shared artifact ids with recorded provenance,
 *   - missing slot results and collisions block,
 *   - schema-required scalar conflicts BLOCK by default (strict); an
 *     explicit, documented stage resolution resolves exactly the declared
 *     (artifact, field) and every resolved disagreement is recorded in the
 *     synthesis provenance with the winning slot and losing values,
 *   - a zero-artifact slot never inherits foreign shared content as its
 *     namespaced provenance (free-rider blocked).
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadProfile, profileHash } from "../src/engine/profile.js";
import { createCapability } from "../src/engine/durable.js";
import {
  namespacedArtifactId,
  sanitizeSlot,
  missingSlotResults,
  mergeSlotValues,
  synthesizeArtifacts,
  DEFAULT_FAN_IN_POLICY,
  type FanInPolicy,
} from "../src/engine/fan-in.js";

import type { TeamState } from "../src/engine/types.js";
import type { ScopeFlags } from "../src/engine/scope.js";
const NO_SCOPE: ScopeFlags = { scope: [], has_security: false, has_infra: false, has_ui: false, has_runtime: true, dev_agent: null };
const FAN_RUN_ID = "44444444-4444-4444-8444-444444444444";
function initGit(root: string, branch: string): void {
  execFileSync("git", ["-C", root, "init", "--quiet", "--initial-branch", branch], { stdio: "ignore" });
}

function writeFixtureState(root: string, stageId: string): ReturnType<typeof createCapability> {
  const profile = loadProfile("full-feature");
  assert.ok(profile);
  const persistedHash = profileHash(profile);
  const runId = FAN_RUN_ID;
  const branch = "feat/fan";
  const issued = createCapability({
    run_key: runId,
    branch,
    workflow: profile.name,
    profile_hash: persistedHash,
    stage_cursor: stageId,
    kind: "consilium",
    expected_roster: [
      { role: "analyst#1", agent: "analyst" },
      { role: "tech-researcher", agent: "tech-researcher" },
      { role: "analyst#2", agent: "analyst" },
    ],
  });
  const runDir = join(root, ".work-state", "runs", runId);
  mkdirSync(join(runDir, "artifacts"), { recursive: true });
  for (const id of profile.stages.find((candidate) => candidate.id === stageId)?.consumes ?? []) {
    writeFileSync(join(runDir, "artifacts", `${id}.json`), JSON.stringify({ task: "t", branch }) + "\n");
  }
  writeFileSync(join(runDir, "state.json"), JSON.stringify({
    schema: 2,
    run_id: runId,
    run_key: runId,
    lifecycle_status: "active",
    rework_generation: 0,
    branch,
    title: "fan-in",
    classification: { type: "FEATURE", complexity: "COMPLEX", confidence: "HIGH", autonomous: false, workflow: profile.name },
    task: "fan-in",
    workflow_override: false,
    issue: null,
    required_inputs: {},
    required_input_receipts: {},
    stage_cursor: stageId,
    stages: profile.stages.map((s) => ({ id: s.id, status: s.id === stageId ? "in_progress" as const : "pending" as const })),
    artifacts: Object.fromEntries((profile.stages.find((candidate) => candidate.id === stageId)?.consumes ?? []).map((id) => [id, `artifacts/${id}.json`])),
    pause: { kind: "none", reason: "" },
    policy: { strict_orchestrator: true },
    profile_hash: persistedHash,
    scope: NO_SCOPE,
    cursor_epoch: issued.state.issued_for!.cursor_epoch,
    dispatch_capability: issued.state,
    updated_at: new Date().toISOString(),
  }) + "\n");
  return issued;
}

function artifactsDir(root: string): string {
  const dir = join(root, ".work-state", "runs", FAN_RUN_ID, "artifacts");
  mkdirSync(dir, { recursive: true });
  return dir;
}

function stateOf(root: string): TeamState {
  return JSON.parse(readFileSync(join(root, ".work-state", "runs", FAN_RUN_ID, "state.json"), "utf8")) as TeamState;
}

const EXPLORATION = (summary: string, files: string[]) => ({ files_to_read: files.map((path) => ({ path, why: "x" })), summary });
function publishCanonicalReceipt(
  root: string,
  issued: ReturnType<typeof createCapability>,
  slot: string,
  values: Record<string, unknown>,
): void {
  const state = stateOf(root);
  const dir = artifactsDir(root);
  mkdirSync(join(dir, "immutable"), { recursive: true });
  const dispatchId = `dispatch-${slot.replace(/[^A-Za-z0-9_-]/g, "-")}`;
  const outputs = Object.entries(values).map(([artifactId, value]) => {
    const bytes = Buffer.from(JSON.stringify(value), "utf8");
    const immutableRef = `immutable/${dispatchId}-${artifactId}.json`;
    writeFileSync(join(dir, immutableRef), bytes);
    return {
      artifact_id: artifactId,
      immutable_ref: immutableRef,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    };
  });
  const capability = issued.state.issued_for!;
  const receiptId = `receipt-${dispatchId}`;
  state.stage_receipts = {
    ...(state.stage_receipts ?? {}),
    [receiptId]: {
      receipt_id: receiptId,
      submission_id: `submission-${dispatchId}`,
      digest: `digest-${dispatchId}`,
      dispatch_id: dispatchId,
      attempt: 1,
      accepted_at: new Date().toISOString(),
      work_identity: {
        run_id: state.run_id!,
        wave_id: "wave",
        slice_id: "slice",
        session_id: "session",
        workflow: capability.workflow,
        stage_id: capability.stage_cursor,
        stage_cursor: capability.stage_cursor,
        capability_id: capability.capability_id,
        capability_epoch: capability.cursor_epoch,
        loop_iteration: capability.loop_iteration,
        slot_id: slot,
        task_id: `task-${dispatchId}`,
        dispatch_id: dispatchId,
        attempt: 1,
        worker_id: slot,
      },
      outputs,
      evidence: [],
    },
  };
  writeFileSync(join(root, ".work-state", "runs", FAN_RUN_ID, "state.json"), JSON.stringify(state) + "\n");
}


test("fan-in: slot namespace is deterministic and collision-free", () => {
  assert.equal(namespacedArtifactId("exploration", "analyst#1"), "exploration-analyst-1");
  assert.equal(namespacedArtifactId("exploration", "tech-researcher"), "exploration-tech-researcher");
  assert.equal(namespacedArtifactId("architecture", "architect#2"), "architecture-architect-2");
  assert.equal(sanitizeSlot("analyst#1"), "analyst-1");
  assert.equal(sanitizeSlot("devops"), "devops");
});


test("fan-in: deterministic synthesis merges canonical receipt outputs in roster order", () => {
  const root = mkdtempSync(join(tmpdir(), "fan-synth-"));
  try {
    initGit(root, "feat/fan");
    const issued = writeFixtureState(root, "exploration");
    const dir = artifactsDir(root);
    publishCanonicalReceipt(root, issued, "analyst#1", {
      exploration: EXPLORATION("analyst one", ["a.ts"]),
      dod: { items: [{ criterion: "c", verify_method: "v", status: "pending" }] },
    });
    publishCanonicalReceipt(root, issued, "tech-researcher", {
      exploration: EXPLORATION("researcher", ["c.ts"]),
    });
    publishCanonicalReceipt(root, issued, "analyst#2", {
      exploration: EXPLORATION("analyst two", ["b.ts"]),
    });

    const policy: FanInPolicy = {
      ...DEFAULT_FAN_IN_POLICY,
      resolutions: [
        {
          artifact: "exploration",
          field: "summary",
          strategy: "first_slot",
          rationale: "parallel exploration summaries are preserved per slot; shared summary resolves to the first contributor",
        },
      ],
    };
    const synthesized = synthesizeArtifacts(
      stateOf(root),
      "exploration",
      dir,
      ["exploration", "dod"],
      ["analyst#1", "tech-researcher", "analyst#2"],
      policy,
    );
    assert.equal(synthesized.ok, true);
    if (!synthesized.ok) return;
    const shared = JSON.parse(readFileSync(join(dir, "exploration.json"), "utf8")) as { files_to_read: unknown[]; summary: string };
    assert.deepEqual(shared.files_to_read.map((f) => (f as { path: string }).path), ["a.ts", "c.ts", "b.ts"]);
    assert.equal(shared.summary, "analyst one");
    const provenance = synthesized.state.slot_artifacts!["exploration"]!.shared!;
    assert.deepEqual(provenance["exploration"]!.slots, ["analyst#1", "tech-researcher", "analyst#2"]);
    assert.deepEqual(provenance["dod"]!.slots, ["analyst#1"]);
    assert.equal(provenance["exploration"]!.conflicts?.length, 2);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});


test("fan-in: merge dedupes identical array items and deep-merges objects", () => {
  const merged = mergeSlotValues(
    [{ items: [{ id: "a", status: "pending" }], verdict: "x" }, { items: [{ id: "a", status: "pending" }, { id: "b", status: "met" }], verdict: "y" }],
    null,
    false,
    "dod",
  );
  assert.equal(merged.ok, true);
  if (merged.ok) {
    const value = merged.value as { items: unknown[]; verdict: string };
    assert.equal(value.items.length, 2, "identical items dedupe, distinct items append");
    assert.equal(value.verdict, "x", "optional scalar keeps the first value");
  }
});

test("fan-in: missing canonical receipt results and empty slots block; strict conflicts block with field diagnostics", () => {
  const root = mkdtempSync(join(tmpdir(), "fan-block-"));
  try {
    initGit(root, "feat/fan");
    const issued = writeFixtureState(root, "exploration");
    const empty = missingSlotResults(stateOf(root), "exploration", ["analyst#1", "tech-researcher", "analyst#2"], ["exploration", "dod"]);
    assert.ok(empty.length > 0, "empty fan-in is detected as missing");

    publishCanonicalReceipt(root, issued, "analyst#1", { exploration: EXPLORATION("one", ["a.ts"]) });
    const partial = missingSlotResults(stateOf(root), "exploration", ["analyst#1", "tech-researcher", "analyst#2"], ["exploration", "dod"]);
    assert.ok(partial.some((entry) => entry.slot === "tech-researcher"), "empty slot blocks");
    assert.ok(partial.some((entry) => entry.artifactId === "dod"), "produce with no contributor blocks");

    const strict = mergeSlotValues(
      [EXPLORATION("one", ["a.ts"]), EXPLORATION("two", ["b.ts"])],
      ["files_to_read", "summary"],
      true,
      "exploration",
    );
    assert.equal(strict.ok, false);
    if (!strict.ok) assert.match(strict.error, /required scalar field 'summary'.*no explicit resolution/s);

    const lenient = mergeSlotValues(
      [EXPLORATION("one", ["a.ts"]), EXPLORATION("two", ["b.ts"])],
      ["files_to_read", "summary"],
      false,
      "exploration",
    );
    assert.equal(lenient.ok, true);
    if (lenient.ok) {
      assert.equal((lenient.value as { summary: string }).summary, "one");
      assert.ok(lenient.conflicts, "lenient resolution is still recorded in provenance");
      assert.equal(lenient.conflicts![0]!.strategy, "lenient");
      assert.equal(lenient.conflicts![0]!.winner_slot, "slot-0");
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("fan-in: default policy is strict; an explicit resolution applies only to the declared field", () => {
  assert.equal(DEFAULT_FAN_IN_POLICY.strict, true, "required-scalar conflicts block handoff by default (criterion 3)");

  // Without a resolution, a required-scalar disagreement blocks.
  const blocked = mergeSlotValues(
    [EXPLORATION("one", ["a.ts"]), EXPLORATION("two", ["b.ts"])],
    ["files_to_read", "summary"],
    true,
    "exploration",
  );
  assert.equal(blocked.ok, false);
  if (!blocked.ok) assert.match(blocked.error, /required scalar field 'summary'.*no explicit resolution/s);

  // The declared resolution for exactly (exploration, summary) resolves the
  // disagreement first-slot-wins and records the conflict provenance.
  const resolved = mergeSlotValues(
    [EXPLORATION("one", ["a.ts"]), EXPLORATION("two", ["b.ts"])],
    ["files_to_read", "summary"],
    true,
    "exploration",
    [{ artifact: "exploration", field: "summary", strategy: "first_slot", rationale: "documented parallel-summary resolution" }],
  );
  assert.equal(resolved.ok, true);
  if (resolved.ok) {
    assert.equal((resolved.value as { summary: string }).summary, "one");
    assert.equal(resolved.conflicts?.length, 1);
    assert.equal(resolved.conflicts![0]!.strategy, "first_slot");
    assert.equal(resolved.conflicts![0]!.field, "summary");
    assert.deepEqual(resolved.conflicts![0]!.losing_values[0]!.value, "two", "losing scalar values are preserved, not discarded");
    assert.match(resolved.conflicts![0]!.rationale, /documented/);
  }

  // A resolution for a different field does not relax the conflict: an
  // undeclared required-scalar disagreement still blocks.
  const otherBlocked = mergeSlotValues(
    [{ verdict: "approve" }, { verdict: "reject" }],
    ["verdict"],
    true,
    "review",
    [{ artifact: "review", field: "other", strategy: "first_slot", rationale: "irrelevant" }],
  );
  assert.equal(otherBlocked.ok, false);
  if (!otherBlocked.ok) assert.match(otherBlocked.error, /required scalar field 'verdict'/);

  // An unsupported resolution strategy fails closed rather than resolving.
  const unsupported = mergeSlotValues(
    [{ verdict: "approve" }, { verdict: "reject" }],
    ["verdict"],
    true,
    "review",
    [{ artifact: "review", field: "verdict", strategy: "majority", rationale: "x" } as never],
  );
  assert.equal(unsupported.ok, false);
  if (!unsupported.ok) assert.match(unsupported.error, /strategy 'majority' is not supported/);
});



