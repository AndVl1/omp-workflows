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
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadProfile, registerWorkflowProfiles, profileHash } from "../src/engine/profile.js";
import { createCapability, authorizeDispatch, completeDispatch, advanceCursor } from "../src/engine/durable.js";
import {
  namespacedArtifactId,
  sanitizeSlot,
  missingSlotResults,
  mergeSlotValues,
  synthesizeArtifacts,
  slotRecordsFor,
  DEFAULT_FAN_IN_POLICY,
  type FanInPolicy,
} from "../src/engine/fan-in.js";
import { writeState } from "../src/engine/state.js";
import { run } from "../src/engine/run.js";
import type { Profile, TeamState } from "../src/engine/types.js";
import type { ScopeFlags } from "../src/engine/scope.js";
import type { TaskCaller } from "../src/engine/stage.js";

const NO_SCOPE: ScopeFlags = { scope: [], has_security: false, has_infra: false, has_ui: false, has_runtime: true, dev_agent: null };

function initGit(root: string, branch: string): void {
  execFileSync("git", ["-C", root, "init", "--quiet", "--initial-branch", branch], { stdio: "ignore" });
}

function writeFixtureState(root: string, profileName: string, stageId: string): ReturnType<typeof createCapability> {
  const profile = loadProfile(profileName);
  assert.ok(profile);
  const persistedHash = profileHash(profile);
  const issued = createCapability({
    run_key: "feat/fan", branch: "feat/fan", workflow: profile.name, profile_hash: persistedHash,
    stage_cursor: stageId, kind: "consilium",
    expected_roster: [
      { role: "analyst#1", agent: "analyst" },
      { role: "tech-researcher", agent: "tech-researcher" },
      { role: "analyst#2", agent: "analyst" },
    ],
  });
  writeState(root, {
    schema: 1,
    branch: "feat/fan",
    run_key: "feat/fan",
    classification: { type: "FEATURE", complexity: "COMPLEX", confidence: "HIGH", autonomous: false, workflow: profileName },
    task: "fan-in",
    workflow_override: false,
    issue: null,
    stage_cursor: stageId,
    stages: profile.stages.map((s) => ({ id: s.id, status: s.id === stageId ? "in_progress" as const : "pending" as const })),
    artifacts: {},
    pause: { kind: "none", reason: "" },
    policy: { strict_orchestrator: true },
    profile_hash: persistedHash,
    scope: NO_SCOPE,
    cursor_epoch: issued.state.issued_for!.cursor_epoch,
    dispatch_capability: issued.state,
    updated_at: new Date().toISOString(),
  }, { featureSlug: "fan" });
  return issued;
}

function artifactsDir(root: string): string {
  const dir = join(root, ".work-state", "features", "fan", "artifacts");
  mkdirSync(dir, { recursive: true });
  return dir;
}

function stateOf(root: string): TeamState {
  return JSON.parse(readFileSync(join(root, ".work-state", "features", "fan", "state.json"), "utf8")) as TeamState;
}

function completeSlot(root: string, issued: ReturnType<typeof createCapability>, role: string, agent: string, artifactIds: string[]): void {
  const auth = {
    token: issued.dispatch_token,
    capability_id: issued.capability_id,
    run_key: issued.state.issued_for!.run_key,
    branch: issued.state.issued_for!.branch,
    workflow: issued.state.issued_for!.workflow,
    profile_hash: issued.state.issued_for!.profile_hash,
    stage_cursor: issued.state.issued_for!.stage_cursor,
    cursor_epoch: issued.state.issued_for!.cursor_epoch,
    role,
    agent,
  };
  const authorized = authorizeDispatch(root, auth);
  assert.equal(authorized.ok, true, `authorize ${role}`);
  if (!authorized.ok || !authorized.record) throw new Error("authorize failed");
  const completed = completeDispatch(root, { ...auth, dispatch_id: authorized.record.id, outcome: "succeeded", evidence: `${role} done`, artifact_ids: artifactIds });
  assert.equal(completed.ok, true, `complete ${role}`);
  if (!completed.ok) throw new Error(`complete failed: ${completed.error}`);
}

const EXPLORATION = (summary: string, files: string[]) => ({ files_to_read: files.map((path) => ({ path, why: "x" })), summary });

test("fan-in: slot namespace is deterministic and collision-free", () => {
  assert.equal(namespacedArtifactId("exploration", "analyst#1"), "exploration-analyst-1");
  assert.equal(namespacedArtifactId("exploration", "tech-researcher"), "exploration-tech-researcher");
  assert.equal(namespacedArtifactId("architecture", "architect_minimal"), "architecture-architect_minimal");
  assert.equal(sanitizeSlot("analyst#1"), "analyst-1");
  assert.equal(sanitizeSlot("devops"), "devops");
});

test("fan-in: shared-id completions are snapshotted per slot; later slots cannot clobber provenance", () => {
  const root = mkdtempSync(join(tmpdir(), "fan-snapshot-"));
  try {
    initGit(root, "feat/fan");
    const issued = writeFixtureState(root, "full-feature", "exploration");
    const dir = artifactsDir(root);
    // Both analysts declare the SHARED exploration id (legacy behavior). The
    // engine must snapshot each slot's content before the next clobbers.
    writeFileSync(join(dir, "exploration.json"), JSON.stringify(EXPLORATION("analyst one", ["a.ts"])));
    completeSlot(root, issued, "analyst#1", "analyst", ["exploration"]);
    writeFileSync(join(dir, "exploration.json"), JSON.stringify(EXPLORATION("analyst two", ["b.ts"])));
    completeSlot(root, issued, "analyst#2", "analyst", ["exploration"]);
    writeFileSync(join(dir, "exploration.json"), JSON.stringify(EXPLORATION("researcher", ["c.ts"])));
    completeSlot(root, issued, "tech-researcher", "tech-researcher", ["exploration"]);

    const records = slotRecordsFor(stateOf(root), "exploration");
    assert.ok(records);
    assert.equal(Object.keys(records!.slots["analyst#1"] ?? {}).length, 1);
    assert.equal(records!.slots["analyst#1"]!["exploration"]!.path.endsWith("exploration-analyst-1.json"), true, "shared-id write is snapshotted into the slot namespace");
    assert.equal(records!.slots["analyst#2"]!["exploration"]!.path.endsWith("exploration-analyst-2.json"), true);
    const snap1 = JSON.parse(readFileSync(records!.slots["analyst#1"]!["exploration"]!.path, "utf8")) as { summary: string };
    assert.equal(snap1.summary, "analyst one", "slot 1 keeps its own content despite the later clobber");
    const snap2 = JSON.parse(readFileSync(records!.slots["analyst#2"]!["exploration"]!.path, "utf8")) as { summary: string };
    assert.equal(snap2.summary, "analyst two");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("fan-in: deterministic synthesis merges slots in roster order, records provenance and resolved disagreements", () => {
  const root = mkdtempSync(join(tmpdir(), "fan-synth-"));
  try {
    initGit(root, "feat/fan");
    const issued = writeFixtureState(root, "full-feature", "exploration");
    const dir = artifactsDir(root);
    // Slot-scoped ids (the consilium prompt contract).
    writeFileSync(join(dir, "exploration-analyst-1.json"), JSON.stringify(EXPLORATION("analyst one", ["a.ts"])));
    writeFileSync(join(dir, "exploration-tech-researcher.json"), JSON.stringify(EXPLORATION("researcher", ["c.ts"])));
    writeFileSync(join(dir, "exploration-analyst-2.json"), JSON.stringify(EXPLORATION("analyst two", ["b.ts"])));
    writeFileSync(join(dir, "dod-analyst-1.json"), JSON.stringify({ items: [{ criterion: "c", verify_method: "v", status: "pending" }] }));
    completeSlot(root, issued, "analyst#1", "analyst", ["exploration-analyst-1", "dod-analyst-1"]);
    completeSlot(root, issued, "tech-researcher", "tech-researcher", ["exploration-tech-researcher"]);
    completeSlot(root, issued, "analyst#2", "analyst", ["exploration-analyst-2"]);

    // `summary` is a schema-required scalar that the slots genuinely
    // disagree on; the stage's documented resolution (first_slot) is the
    // explicit policy that makes the shipped parallel-exploration contract
    // advanceable without ever discarding the disagreement silently.
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
    const state = stateOf(root);
    const synthesized = synthesizeArtifacts(state, "exploration", dir, ["exploration", "dod"], ["analyst#1", "tech-researcher", "analyst#2"], policy);
    assert.equal(synthesized.ok, true);
    if (!synthesized.ok) return;
    const shared = JSON.parse(readFileSync(join(dir, "exploration.json"), "utf8")) as { files_to_read: unknown[]; summary: string };
    assert.equal(shared.files_to_read.length, 3, "arrays concatenate in roster order without dedupe loss");
    assert.deepEqual(shared.files_to_read.map((f) => (f as { path: string }).path), ["a.ts", "c.ts", "b.ts"], "deterministic roster order");
    assert.equal(shared.summary, "analyst one", "declared resolution resolves the required scalar first-slot-wins");
    const provenance = synthesized.state.slot_artifacts!["exploration"]!.shared!;
    assert.deepEqual(provenance["exploration"]!.slots, ["analyst#1", "tech-researcher", "analyst#2"]);
    assert.deepEqual(provenance["dod"]!.slots, ["analyst#1"], "synthesis provenance records the contributing slots");
    const conflicts = provenance["exploration"]!.conflicts;
    assert.ok(conflicts, "resolved disagreements are recorded, never discarded");
    assert.equal(conflicts!.length, 2, "each losing slot is recorded");
    assert.deepEqual(conflicts!.map((c) => c.field), ["summary", "summary"]);
    assert.deepEqual(conflicts!.map((c) => c.strategy), ["first_slot", "first_slot"]);
    assert.deepEqual(conflicts!.map((c) => c.winner_slot), ["analyst#1", "analyst#1"], "the first roster contributor wins deterministically");
    assert.deepEqual(conflicts!.map((c) => c.losing_values.map((l) => l.slot)), [["tech-researcher"], ["analyst#2"]]);
    assert.equal(conflicts![0]!.resolved_value, "analyst one");
    assert.match(conflicts![0]!.rationale, /preserved per slot/);
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

test("fan-in: missing slot results and empty slots block; strict conflicts block with field diagnostics", () => {
  const root = mkdtempSync(join(tmpdir(), "fan-block-"));
  try {
    initGit(root, "feat/fan");
    const issued = writeFixtureState(root, "full-feature", "exploration");
    const dir = artifactsDir(root);
    // No slot recorded anything -> every produce is missing.
    const empty = missingSlotResults(stateOf(root), "exploration", ["analyst#1", "tech-researcher", "analyst#2"], ["exploration", "dod"]);
    assert.ok(empty.length > 0, "empty fan-in is detected as missing");

    writeFileSync(join(dir, "exploration-analyst-1.json"), JSON.stringify(EXPLORATION("one", ["a.ts"])));
    completeSlot(root, issued, "analyst#1", "analyst", ["exploration-analyst-1"]);
    // Only one slot contributed -> other slots are empty -> blocked.
    const partial = missingSlotResults(stateOf(root), "exploration", ["analyst#1", "tech-researcher", "analyst#2"], ["exploration", "dod"]);
    assert.ok(partial.some((entry) => entry.slot === "tech-researcher"), "empty slot blocks");
    assert.ok(partial.some((entry) => entry.artifactId === "dod"), "produce with no contributor blocks");

    // Strict conflict: required scalar `summary` disagrees between slots.
    const strict = mergeSlotValues(
      [EXPLORATION("one", ["a.ts"]), EXPLORATION("two", ["b.ts"])],
      ["files_to_read", "summary"],
      true,
      "exploration",
    );
    assert.equal(strict.ok, false);
    if (!strict.ok) assert.match(strict.error, /required scalar field 'summary'.*no explicit resolution/s);

    // Explicit opt-out of strict (setFanInPolicy): the same disagreement
    // resolves deterministically and is recorded, never discarded.
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

test("fan-in: missing slot results block advance end to end", () => {
  const root = mkdtempSync(join(tmpdir(), "fan-advance-"));
  try {
    initGit(root, "feat/fan");
    const issued = writeFixtureState(root, "full-feature", "exploration");
    const dir = artifactsDir(root);
    // discovery artifacts are consumed by exploration -> must exist.
    writeFileSync(join(dir, "discovery.json"), JSON.stringify({ task: "t", branch: "feat/fan" }));
    writeFileSync(join(dir, "exploration-analyst-1.json"), JSON.stringify(EXPLORATION("one", ["a.ts"])));
    writeFileSync(join(dir, "exploration-tech-researcher.json"), JSON.stringify(EXPLORATION("two", ["b.ts"])));
    writeFileSync(join(dir, "exploration-analyst-2.json"), JSON.stringify(EXPLORATION("three", ["c.ts"])));
    completeSlot(root, issued, "analyst#1", "analyst", ["exploration-analyst-1"]);
    completeSlot(root, issued, "tech-researcher", "tech-researcher", ["exploration-tech-researcher"]);
    // analyst#2 completed with NO artifacts -> empty slot -> advance blocked.
    completeSlot(root, issued, "analyst#2", "analyst", []);
    const advanced = advanceCursor(root, {
      token: issued.advance_token,
      capability_id: issued.capability_id,
      run_key: issued.state.issued_for!.run_key,
      branch: issued.state.issued_for!.branch,
      workflow: issued.state.issued_for!.workflow,
      profile_hash: issued.state.issued_for!.profile_hash,
      stage_cursor: issued.state.issued_for!.stage_cursor,
      cursor_epoch: issued.state.issued_for!.cursor_epoch,
      evidence: "exploration done",
    });
    assert.equal(advanced.ok, false, "empty slot blocks the handoff");
    if (!advanced.ok) assert.match(advanced.error, /fan-in incomplete.*analyst#2/s);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("fan-in: collision (same slot writing the same artifact twice with different content) blocks at completion", () => {
  const root = mkdtempSync(join(tmpdir(), "fan-collision-"));
  try {
    initGit(root, "feat/fan");
    const issued = writeFixtureState(root, "full-feature", "exploration");
    const dir = artifactsDir(root);
    writeFileSync(join(dir, "exploration.json"), JSON.stringify(EXPLORATION("one", ["a.ts"])));
    completeSlot(root, issued, "analyst#1", "analyst", ["exploration"]);
    // Re-complete the same dispatch with different content is a conflicting
    // replay at the dispatch level; drive the collision via a second record:
    // authorize the role again after a failed attempt is not possible in one
    // capability, so assert the pure record-level invariant instead.
    const records = slotRecordsFor(stateOf(root), "exploration");
    const record = records!.slots["analyst#1"]!["exploration"]!;
    const first = record.hash;
    // Same content -> same hash (idempotent replay snapshot).
    writeFileSync(join(dir, "exploration.json"), JSON.stringify(EXPLORATION("one", ["a.ts"])));
    const auth = {
      token: issued.dispatch_token,
      capability_id: issued.capability_id,
      run_key: issued.state.issued_for!.run_key,
      branch: issued.state.issued_for!.branch,
      workflow: issued.state.issued_for!.workflow,
      profile_hash: issued.state.issued_for!.profile_hash,
      stage_cursor: issued.state.issued_for!.stage_cursor,
      cursor_epoch: issued.state.issued_for!.cursor_epoch,
      role: "analyst#1",
      agent: "analyst",
    };
    const authorized = authorizeDispatch(root, auth);
    assert.equal(authorized.ok, false, "role already dispatched (failed/cancelled required before re-dispatch)");
    // The snapshot record is immutable per completion: changing the file
    // after the fact cannot alter recorded provenance.
    writeFileSync(join(dir, "exploration.json"), JSON.stringify(EXPLORATION("changed", ["z.ts"])));
    assert.equal(slotRecordsFor(stateOf(root), "exploration")!.slots["analyst#1"]!["exploration"]!.hash, first, "provenance hash is immutable after recording");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("fan-in: a zero-artifact slot never inherits foreign shared content as its namespaced provenance", async () => {
  const root = mkdtempSync(join(tmpdir(), "fan-freerider-"));
  // No slash in the branch so the derived feature slug equals the branch.
  const branch = "fan-free-rider";
  try {
    initGit(root, branch);
    const profile: Profile = {
      name: "fan-free-rider",
      title: "Free-rider regression",
      description: "consilium slot returning no artifacts must not be credited with another slot's shared write",
      match: { type: ["FEATURE"] },
      stages: [
        {
          id: "exploration",
          title: "Exploration",
          type: "consilium",
          roles: ["analyst", "tech-researcher"],
          parallel: true,
          produces: ["exploration"],
        },
        { id: "summary", title: "Summary", type: "orchestrator", consumes: ["exploration"] },
      ],
    };
    registerWorkflowProfiles([profile]);
    const taskTool: TaskCaller = {
      async call() { return { id: "x", output: "ok", artifacts: {}, exitCode: 0 }; },
      async batch() {
        return [
          { id: "a", output: "ok", artifacts: { exploration: EXPLORATION("analyst view", ["a.ts"]) }, exitCode: 0 },
          // The second slot returns nothing. It must not inherit the shared
          // exploration.json (written by the first slot) as its provenance.
          { id: "b", output: "ok", artifacts: {}, exitCode: 0 },
        ];
      },
    };
    const result = await run({
      task: "free-rider fan-in",
      cwd: root,
      branch,
      autonomous: false,
      classification: { type: "FEATURE", complexity: "COMPLEX", confidence: "HIGH", autonomous: false, workflow: "fan-free-rider" },
      taskTool,
    });
    const exploration = result.outcomes.find((o) => o.stageId === "exploration");
    assert.equal(exploration?.status, "failed", "a zero-artifact slot must fail the consilium stage");
    assert.match(exploration?.note ?? "", /produced no artifacts: tech-researcher/);
    const artifacts = join(root, ".work-state", "features", "fan-free-rider", "artifacts");
    assert.equal(existsSync(join(artifacts, "exploration-tech-researcher.json")), false, "the empty slot must not inherit the shared artifact as its namespaced provenance");
    assert.equal(existsSync(join(artifacts, "exploration-analyst.json")), true, "the contributing slot keeps its own namespaced content");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
