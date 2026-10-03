/**
 * Registered diagnosis publication and root-cause gate regressions:
 * accepted payloads still need a meaningful cause and explanation, malformed
 * payloads receive field diagnostics without a receipt, and failed gates do
 * not move the cursor.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isRootCauseDocumented } from "../src/engine/dod.js";
import { readRunState } from "../src/engine/run-store.js";
import type { Profile } from "../src/engine/types.js";
import {
  details, ordinaryHarness, ordinaryIngress, requireTool,
  type Harness, type Handoff,
} from "./reliable-stage-execution-fixture.js";

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

async function setupStage(): Promise<{ harness: Harness; runId: string; handoff: Handoff }> {
  const harness = ordinaryHarness({ branch: "feat/probe", workflowProfiles: [PROBE_PROFILE] });
  try {
    const started = await ordinaryIngress(harness, {
      task: "root cause gate regression",
      classification: {
        type: "BUG_FIX", complexity: "QUICK", confidence: "HIGH",
        autonomous: false, workflow: PROBE_PROFILE.name,
      },
    });
    return { harness, ...started };
  } catch (error) {
    await harness.close();
    throw error;
  }
}

async function submitDiagnosis(harness: Harness, diagnosis: Record<string, unknown>) {
  const result = await requireTool(harness, "workflow_submit_result").execute(
    "submit-diagnosis", { outputs: { diagnosis } }, undefined, undefined, harness.context,
  );
  return details(result.details);
}

async function advanceDiagnosis(harness: Harness, handoff: Handoff) {
  const result = await requireTool(harness, "workflow_advance").execute("advance-diagnosis", {
    token: handoff.advance_token,
    capability_id: handoff.capability_id,
    run_key: handoff.run_key,
    branch: "feat/probe",
    workflow: PROBE_PROFILE.name,
    profile_hash: handoff.profile_hash,
    stage_cursor: handoff.stage_cursor,
    cursor_epoch: handoff.cursor_epoch,
    loop_iteration: handoff.loop_iteration,
    evidence: "diagnosis documented",
  }, undefined, undefined, harness.context);
  return details(result.details);
}

function writeDiagnosis(artifactsDir: string, diagnosis: Record<string, unknown>): void {
  writeFileSync(join(artifactsDir, "diagnosis.json"), JSON.stringify(diagnosis));
}

test("schema-conforming diagnosis passes root_cause_documented through workflow advance", async () => {
  const { harness, runId, handoff } = await setupStage();
  try {
    const submitted = await submitDiagnosis(harness, {
      root_cause: "artifact mtime leaked into the content digest",
      explanation: "hashing file contents only closes the cause instead of masking the symptom",
      evidence: ["repro: touch file, digest changes"],
      proposed_fix: "hash file contents",
      verification_checklist: ["touch file, digest stays stable"],
    });
    assert.equal(submitted.ok, true, JSON.stringify(submitted));
    const advanced = await advanceDiagnosis(harness, handoff);
    assert.equal(advanced.ok, true, JSON.stringify(advanced));
    assert.equal(readRunState(harness.root, runId)?.stage_cursor, "wrap");
  } finally {
    await harness.close();
  }
});

test("accepted diagnosis with an empty cause or explanation cannot advance", async () => {
  const cases = [
    { diagnosis: { root_cause: "digest drift", explanation: "   " }, field: "explanation" },
    { diagnosis: { root_cause: "   ", explanation: "hashing contents closes it" }, field: "root_cause" },
  ] as const;
  for (const { diagnosis, field } of cases) {
    const { harness, runId, handoff } = await setupStage();
    try {
      const submitted = await submitDiagnosis(harness, diagnosis);
      assert.equal(submitted.ok, true, JSON.stringify(submitted));
      const blocked = await advanceDiagnosis(harness, handoff);
      assert.equal(blocked.ok, false);
      assert.match(String(blocked.error), /root_cause_documented/);
      assert.ok(String(blocked.error).includes(`diagnosis.${field}`));
      assert.equal(readRunState(harness.root, runId)?.stage_cursor, "diagnose");
    } finally {
      await harness.close();
    }
  }
});

test("diagnosis missing explanation is rejected before receipt publication", async () => {
  const { harness, runId } = await setupStage();
  try {
    const rejected = await submitDiagnosis(harness, { root_cause: "digest drift" });
    assert.equal(rejected.ok, false);
    assert.equal(rejected.code, "invalid_outputs");
    assert.ok(Array.isArray(rejected.field_errors));
    assert.ok(rejected.field_errors.some((entry) => String(details(entry).field).endsWith(".explanation")));
    const state = readRunState(harness.root, runId);
    assert.deepEqual(state?.stage_receipts ?? {}, {});
    assert.equal(state?.stage_cursor, "diagnose");
  } finally {
    await harness.close();
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
