/**
 * root_cause_documented gate + diagnosis artifact contract regressions:
 *   - the artifact schema, the diagnose-stage expectations and the gate agree
 *     on ONE explicit contract: non-empty `root_cause` (what) AND non-empty
 *     `explanation` (why the fix closes the cause);
 *   - a schema-conforming diagnosis passes the gate through advanceCursor
 *     (the exact path workflow_advance exercises);
 *   - an invalid diagnosis rejects the advance with the EXACT gate reason
 *     preserved through the named-gate evaluation, never a generic
 *     "not satisfied";
 *   - a diagnosis missing the explanation field fails at the schema contract
 *     first, with the required-field diagnostic;
 *   - missing or unparseable diagnosis.json fails closed with a reason
 *     instead of throwing through the advance boundary.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadProfile, profileHash, registerWorkflowProfiles } from "../src/engine/profile.js";
import { advanceCursor, createCapability, type IssuedCapability } from "../src/engine/durable.js";
import { isRootCauseDocumented } from "../src/engine/dod.js";
import { writeStateBootstrap } from "../src/engine/state.js";
import type { Profile, TeamState } from "../src/engine/types.js";
import type { ScopeFlags } from "../src/engine/scope.js";

const NO_SCOPE: ScopeFlags = { scope: [], has_security: false, has_infra: false, has_ui: false, has_runtime: false, dev_agent: null };

const PROBE_PROFILE: Profile = {
  name: "root-cause-gate-probe",
  title: "Root cause gate probe",
  description: "Focused root_cause_documented contract regression",
  match: { type: ["BUG_FIX"] },
  stages: [
    { id: "diagnose", title: "Diagnose", type: "orchestrator", produces: ["diagnosis"], gate: "root_cause_documented" },
    { id: "wrap", title: "Wrap", type: "orchestrator" },
  ],
};

registerWorkflowProfiles([PROBE_PROFILE]);

function initGit(root: string): void {
  execFileSync("git", ["-C", root, "init", "--quiet", "--initial-branch", "feat/probe"], { stdio: "ignore" });
}

function advanceAuthOf(issued: IssuedCapability) {
  return {
    token: issued.advance_token,
    capability_id: issued.capability_id,
    run_key: issued.state.issued_for!.run_key,
    branch: issued.state.issued_for!.branch,
    workflow: issued.state.issued_for!.workflow,
    profile_hash: issued.state.issued_for!.profile_hash,
    stage_cursor: issued.state.issued_for!.stage_cursor,
    cursor_epoch: issued.state.issued_for!.cursor_epoch,
    loop_iteration: issued.state.issued_for!.loop_iteration,
  };
}

function setupStage(root: string): { issued: IssuedCapability; artifactsDir: string } {
  const profile = loadProfile("root-cause-gate-probe");
  assert.ok(profile);
  const persistedHash = profileHash(profile);
  const issued = createCapability({
    run_key: "feat/probe",
    branch: "feat/probe",
    workflow: "root-cause-gate-probe",
    profile_hash: persistedHash,
    stage_cursor: "diagnose",
    kind: "none",
    expected_roster: [],
  });
  writeStateBootstrap(root, {
    schema: 1,
    branch: "feat/probe",
    run_key: "feat/probe",
    classification: { type: "BUG_FIX", complexity: "QUICK", confidence: "HIGH", autonomous: false, workflow: "root-cause-gate-probe" },
    task: "root cause gate regression",
    workflow_override: false,
    issue: null,
    stage_cursor: "diagnose",
    stages: profile.stages.map((stage) => ({ id: stage.id, status: stage.id === "diagnose" ? "in_progress" as const : "pending" as const })),
    artifacts: {},
    pause: { kind: "none", reason: "" },
    policy: { strict_orchestrator: true },
    profile_hash: persistedHash,
    scope: NO_SCOPE,
    cursor_epoch: issued.state.issued_for!.cursor_epoch,
    dispatch_capability: issued.state,
    updated_at: new Date().toISOString(),
  }, { featureSlug: "probe" });
  const artifactsDir = join(root, ".work-state", "features", "probe", "artifacts");
  mkdirSync(artifactsDir, { recursive: true });
  return { issued, artifactsDir };
}

function persistedStageCursor(root: string): string {
  const statePath = join(root, ".work-state", "features", "probe", "state.json");
  return (JSON.parse(readFileSync(statePath, "utf8")) as TeamState).stage_cursor;
}

function writeDiagnosis(artifactsDir: string, diagnosis: Record<string, unknown>): void {
  writeFileSync(join(artifactsDir, "diagnosis.json"), JSON.stringify(diagnosis));
}

test("schema-conforming diagnosis passes root_cause_documented through workflow advance", () => {
  const root = mkdtempSync(join(tmpdir(), "root-cause-pass-"));
  try {
    initGit(root);
    const { issued, artifactsDir } = setupStage(root);
    writeDiagnosis(artifactsDir, {
      root_cause: "artifact mtime leaked into the content digest",
      explanation: "hashing file contents only closes the cause instead of masking the symptom",
      evidence: ["repro: touch file, digest changes"],
      proposed_fix: "hash file contents",
      verification_checklist: ["touch file, digest stays stable"],
    });
    const advanced = advanceCursor(root, { ...advanceAuthOf(issued), evidence: "diagnosis documented" });
    assert.equal(advanced.ok, true, advanced.ok ? "advance accepted" : advanced.error);
    if (advanced.ok) assert.equal(advanced.state.stage_cursor, "wrap");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("invalid diagnosis rejects workflow advance with the exact gate reason", () => {
  const cases = [
    {
      diagnosis: { root_cause: "digest drift", explanation: "   " },
      expected: /gate 'root_cause_documented' is not satisfied: diagnosis\.explanation is empty \(why does this fix close the root cause\?\)/,
    },
    {
      diagnosis: { root_cause: "   ", explanation: "hashing contents closes it" },
      expected: /gate 'root_cause_documented' is not satisfied: diagnosis\.root_cause is empty/,
    },
  ] as const;
  for (const { diagnosis, expected } of cases) {
    const root = mkdtempSync(join(tmpdir(), "root-cause-reject-"));
    try {
      initGit(root);
      const { issued, artifactsDir } = setupStage(root);
      writeDiagnosis(artifactsDir, diagnosis);
      const blocked = advanceCursor(root, { ...advanceAuthOf(issued), evidence: "diagnosis documented" });
      assert.equal(blocked.ok, false, "an invalid diagnosis must block the advance");
      if (!blocked.ok) assert.match(blocked.error, expected);
      assert.equal(persistedStageCursor(root), "diagnose", "a blocked advance never moves the cursor");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

test("diagnosis missing the explanation field fails at the schema contract first", () => {
  const root = mkdtempSync(join(tmpdir(), "root-cause-schema-"));
  try {
    initGit(root);
    const { issued, artifactsDir } = setupStage(root);
    writeDiagnosis(artifactsDir, { root_cause: "digest drift" });
    const blocked = advanceCursor(root, { ...advanceAuthOf(issued), evidence: "diagnosis documented" });
    assert.equal(blocked.ok, false);
    if (!blocked.ok) assert.match(blocked.error, /produced artifact 'diagnosis' violates its contract: \$\.explanation: .*required field 'explanation' is missing/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("missing or unparseable diagnosis.json fails closed with a reason, never a throw", () => {
  const root = mkdtempSync(join(tmpdir(), "root-cause-closed-"));
  try {
    const artifactsDir = join(root, "artifacts");
    mkdirSync(artifactsDir, { recursive: true });
    assert.deepEqual(
      isRootCauseDocumented(artifactsDir),
      { ok: false, reason: "diagnosis.json missing or invalid" },
    );
    writeFileSync(join(artifactsDir, "diagnosis.json"), "{not json");
    assert.deepEqual(
      isRootCauseDocumented(artifactsDir),
      { ok: false, reason: "diagnosis.json missing or invalid" },
    );
    writeDiagnosis(artifactsDir, { root_cause: "c", explanation: "e" });
    const ok = isRootCauseDocumented(artifactsDir);
    assert.equal(ok.ok, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
