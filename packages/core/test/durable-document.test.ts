/**
 * Registered document producer on the durable /do-work path:
 * workflow_begin renders and accepts the PRD receipt; only that receipt
 * authorizes advance. Missing declared sources fail closed without output
 * publication or cursor movement.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadProfile, registerWorkflowProfiles, profileHash } from "../src/engine/profile.js";
import { createCapability, advanceCursor, type IssuedCapability } from "../src/engine/durable.js";

import { runTarget } from "../src/engine/run-store.js";
import { validateProductPrdDocument } from "../src/engine/product-prd.js";
import type { Profile, TeamState } from "../src/engine/types.js";
import type { ScopeFlags } from "../src/engine/scope.js";
import { createCoreFixture, details, type Harness, type Handoff } from "./reliable-stage-execution-fixture.js";

async function resumeDocumentStage(root: string): Promise<Harness> {
  const harness = createCoreFixture({
    root, branch: "feat/product-discovery-workflow",
    workflowProfiles: [loadProfile("product-discovery")!],
  });
  await harness.emit("session_start", { type: "session_start" }, harness.context);
  harness.controller.prepare({ mode: "resume", run_id: RUN_ID });
  return harness;
}

async function beginDocument(harness: Harness) {
  return details((await harness.tools.get("workflow_begin")!.execute(
    "document-begin", {}, undefined, undefined, harness.context,
  )).details);
}

const FLAGS: ScopeFlags = { scope: [], has_security: false, has_infra: false, has_ui: false, has_runtime: false, dev_agent: null };
const RUN_ID = "88888888-8888-4888-8888-888888888888";

/** Schema-valid fixtures for all five product-discovery source artifacts. */
function fiveSources(): Record<string, unknown> {
  return {
    product_intake: {
      problem_statements: ["Teams cannot review an approved product direction as a document"],
      contexts: ["omp-workflows product-discovery runs"],
      stakeholders: ["product owner", "platform lead"],
      constraints: ["no application code changes"],
      open_questions: ["where the PRD file lives"],
      evidence: [{ claim: "no deterministic renderer exists today", status: "verified", source: "durable-document.test.ts" }],
    },
    product_framing: {
      problem_restatement: "Product direction needs a deterministic, tamper-evident Markdown document.",
      target_users: ["product owners", "platform leads"],
      success_criteria: ["identical sources render byte-identical PRDs"],
      non_goals: ["implementation planning"],
      assumptions: ["the five source artifacts are schema-valid"],
    },
    product_evidence: {
      evidence: [{ claim: "sha256 detects any post-write edit", status: "verified", source: "durable-document.test.ts" }],
      alternatives: [{ id: "handwritten-prd", summary: "hand-written PRDs", pros: [], cons: ["not reproducible"] }],
      gaps: [],
    },
    product_critique: {
      verdict: "proceed",
      findings: ["renderer drift must be caught by hash validation"],
      blocking_gaps: [],
    },
    product_spec: {
      recommendation: "proceed",
      value_proposition: "Deterministic PRDs give product owners a reviewable, tamper-evident document.",
      opportunity: "No deterministic renderer from spec to document exists today.",
      target_users: ["product owners", "platform leads"],
      solution_direction: "Render the five source artifacts into deterministic Markdown with verifiable hashes.",
      success_metrics: ["identical sources render byte-identical PRDs", "any post-write edit fails validation"],
      guardrail_metrics: ["workflow stage latency unchanged"],
      scope: ["deterministic renderer", "typed product_prd artifact", "profile documents stage"],
      anti_scope: ["implementation planning", "architecture decisions"],
      risks: ["template drift without hash re-verification"],
      validation_plan: [],
      evidence_trace: ["claim: deterministic rendering — status: verified — source: durable-document.test.ts"],
      open_decisions: ["where the PRD file lives"],
    },
  };
}

/**
 * Prepare a product-discovery run whose cursor sits at `product_prd_document`
 * with a kind "none" capability (exactly what the engine's own skip-aware
 * advance arms for a non-dispatch stage) and the five sources on disk.
 */
function setupDocumentStage(preArtifacts: Record<string, unknown>): {
  issued: IssuedCapability;
  root: string;
  featureDir: string;
  artifactsDir: string;
} {
  const profile = loadProfile("product-discovery") as Profile;
  assert.ok(profile, "shipped product-discovery profile is available");
  registerWorkflowProfiles([profile]);
  const branch = "feat/product-discovery-workflow";
  const root = mkdtempSync(join(tmpdir(), "prd-durable-"));
  execFileSync("git", ["-C", root, "init", "--quiet", "--initial-branch", branch], { stdio: "ignore" });
  const persistedHash = profileHash(profile);
  const currentStageId = "product_prd_document";
  // Non-dispatch stage: kind "none" with an empty roster — mirrors the
  // engine's own arming for `document` stages (and orchestrator/bash/none).
  const issued = createCapability({
    run_key: RUN_ID, branch, workflow: profile.name, profile_hash: persistedHash,
    stage_cursor: currentStageId, kind: "none", expected_roster: [],
  });
  const runDir = join(root, ".work-state", "runs", RUN_ID);
  mkdirSync(runDir, { recursive: true });
  writeFileSync(runTarget(root, RUN_ID).statePath!, JSON.stringify({
    schema: 2,
    run_id: RUN_ID,
    run_key: RUN_ID,
    branch,
    classification: { type: "PRODUCT_DISCOVERY", complexity: "COMPLEX", confidence: "HIGH", autonomous: false, workflow: profile.name },
    task: "Render the deterministic product PRD document",
    workflow_override: false,
    issue: null,
    stage_cursor: currentStageId,
    stages: profile.stages.map((s, index) => ({ id: s.id, status: s.id === currentStageId ? "in_progress" as const : index < profile.stages.findIndex((stage) => stage.id === currentStageId) ? "skipped" as const : "pending" as const })),
    artifacts: {},
    pause: { kind: "none" as const, reason: "" },
    policy: { strict_orchestrator: true },
    profile_hash: persistedHash,
    scope: FLAGS,
    cursor_epoch: issued.state.issued_for!.cursor_epoch,
    dispatch_capability: issued.state,
    updated_at: new Date().toISOString(),
  }, null, 2) + "\n");
  const featureDir = runDir;
  const artifactsDir = join(featureDir, "artifacts");
  mkdirSync(artifactsDir, { recursive: true });
  for (const [id, value] of Object.entries(preArtifacts)) {
    writeFileSync(join(artifactsDir, `${id}.json`), JSON.stringify(value));
  }
  return { issued, root, featureDir, artifactsDir };
}

function readState(root: string): TeamState {
  return JSON.parse(readFileSync(join(root, ".work-state", "runs", RUN_ID, "state.json"), "utf8")) as TeamState;
}

function advanceAuth(handoff: Handoff) {
  return {
    token: handoff.advance_token,
    capability_id: handoff.capability_id,
    run_key: handoff.run_key,
    branch: handoff.branch,
    workflow: handoff.workflow,
    profile_hash: handoff.profile_hash,
    stage_cursor: handoff.stage_cursor,
    cursor_epoch: handoff.cursor_epoch,
    loop_iteration: handoff.loop_iteration,
  };
}

test("durable document producer: an accepted rendered PRD advances to product approval", async () => {
  const { root, featureDir, artifactsDir } = setupDocumentStage(fiveSources());
  let harness: Harness | undefined;
  try {
    harness = await resumeDocumentStage(root);
    const begun = await beginDocument(harness);
    assert.equal(begun.ok, true, JSON.stringify(begun));
    const advanced = advanceCursor(root, { ...advanceAuth(begun.handoff as Handoff), evidence: "accepted document render" }, { runId: RUN_ID });
    assert.equal(advanced.ok, true, JSON.stringify(advanced));
    if (!advanced.ok) return;

    // Document, viewer and manifest were accepted atomically by the renderer.
    assert.ok(existsSync(join(featureDir, "documents", "product-prd.md")), "the PRD document is rendered");
    assert.ok(existsSync(join(featureDir, "documents", "product-prd.html")), "the derived PRD HTML viewer is rendered");
    assert.ok(existsSync(join(artifactsDir, "product_prd.json")), "the typed product_prd artifact is written");
    assert.deepEqual(validateProductPrdDocument({ stateDir: featureDir, artifactsDir }), { ok: true, issues: [] });

    // The transition committed: current stage done, next stage armed.
    assert.equal(advanced.state.stages.find((s) => s.id === "product_prd_document")?.status, "done");
    assert.equal(advanced.state.stage_cursor, "product_approval");
    assert.equal(advanced.state.dispatch_capability?.issued_for?.stage_cursor, "product_approval");
  } finally {
    await harness?.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("durable document producer: a missing source publishes nothing and preserves the cursor", async () => {
  const sources = fiveSources();
  delete sources.product_evidence;
  const { root, featureDir, artifactsDir } = setupDocumentStage(sources);
  let harness: Harness | undefined;
  try {
    harness = await resumeDocumentStage(root);
    const begun = await beginDocument(harness);
    assert.equal(begun.ok, false, "a missing source must block the registered renderer");
    assert.match(String(begun.error), /product_evidence/);

    const state = readState(root);
    assert.equal(state.stages.find((s) => s.id === "product_prd_document")?.status, "in_progress", "stage is not done");
    assert.equal(state.stage_cursor, "product_prd_document", "cursor did not move");
    assert.ok(!existsSync(join(artifactsDir, "product_prd.json")), "no artifact was written");
    assert.ok(!existsSync(join(featureDir, "documents")), "no document was rendered");
  } finally {
    await harness?.close();
    rmSync(root, { recursive: true, force: true });
  }
});
