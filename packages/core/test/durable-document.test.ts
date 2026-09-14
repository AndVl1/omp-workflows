/**
 * Executable `document` stage on the NATIVE durable path (/do-work):
 * advancing a `product_prd_document` stage renders the deterministic
 * Markdown PRD and the typed `product_prd` artifact IN-ENGINE, before the
 * transition commits — the advance boundary is the renderer, no dispatch is
 * expected (the stage arms a kind "none" capability with an empty roster).
 *
 * Coverage:
 *   - happy path: advance succeeds, the document and the typed artifact
 *     exist and validateProductPrdDocument passes, the stage is marked done
 *     and the next stage (product_approval) is armed;
 *   - fail closed: a missing source artifact blocks the advance with the
 *     source named — nothing is rendered, nothing is marked done.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadProfile, profileHash } from "../src/engine/profile.js";
import { createCapability, advanceCursor, type IssuedCapability } from "../src/engine/durable.js";
import { setStateTransactionTestHooks, writeState } from "../src/engine/state.js";
import { validateProductPrdDocument } from "../src/engine/product-prd.js";
import { PinnedProjectRoot } from "../src/specification/pinned-root.js";
import type { Profile, TeamState } from "../src/engine/types.js";
import type { ScopeFlags } from "../src/engine/scope.js";

const FLAGS: ScopeFlags = { scope: [], has_security: false, has_infra: false, has_ui: false, has_runtime: false, dev_agent: null };

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
  const root = mkdtempSync(join(tmpdir(), "prd-durable-"));
  const branch = "feat/product-discovery-workflow";
  execFileSync("git", ["-C", root, "init", "--quiet", "--initial-branch", branch], { stdio: "ignore" });
  const persistedHash = profileHash(profile);
  const currentStageId = "product_prd_document";
  // Non-dispatch stage: kind "none" with an empty roster — mirrors the
  // engine's own arming for `document` stages (and orchestrator/bash/none).
  const issued = createCapability({
    run_key: branch, branch, workflow: profile.name, profile_hash: persistedHash,
    stage_cursor: currentStageId, kind: "none", expected_roster: [],
  });
  writeState(root, {
    schema: 1,
    branch,
    run_key: branch,
    classification: { type: "FEATURE", complexity: "COMPLEX", confidence: "HIGH", autonomous: false, workflow: profile.name },
    task: "Render the deterministic product PRD document",
    workflow_override: false,
    issue: null,
    stage_cursor: currentStageId,
    stages: profile.stages.map((s) => ({ id: s.id, status: s.id === currentStageId ? "in_progress" as const : "pending" as const })),
    artifacts: {},
    pause: { kind: "none" as const, reason: "" },
    policy: { strict_orchestrator: true },
    profile_hash: persistedHash,
    scope: FLAGS,
    cursor_epoch: issued.state.issued_for!.cursor_epoch,
    dispatch_capability: issued.state,
    updated_at: new Date().toISOString(),
  }, { featureSlug: "product-prd" });
  const featureDir = join(root, ".work-state", "features", "product-prd");
  const artifactsDir = join(featureDir, "artifacts");
  mkdirSync(artifactsDir, { recursive: true });
  for (const [id, value] of Object.entries(preArtifacts)) {
    writeFileSync(join(artifactsDir, `${id}.json`), JSON.stringify(value));
  }
  return { issued, root, featureDir, artifactsDir };
}

function readState(root: string): TeamState {
  return JSON.parse(readFileSync(join(root, ".work-state", "features", "product-prd", "state.json"), "utf8")) as TeamState;
}

function advanceAuth(issued: IssuedCapability) {
  return {
    token: issued.advance_token,
    capability_id: issued.capability_id,
    run_key: issued.state.issued_for!.run_key,
    branch: issued.state.issued_for!.branch,
    workflow: issued.state.issued_for!.workflow,
    profile_hash: issued.state.issued_for!.profile_hash,
    stage_cursor: issued.state.issued_for!.stage_cursor,
    cursor_epoch: issued.state.issued_for!.cursor_epoch,
  };
}

test("durable document advance: the engine renders doc + product_prd before the transition commits", () => {
  const { issued, root, featureDir, artifactsDir } = setupDocumentStage(fiveSources());
  try {
    const advanced = advanceCursor(root, { ...advanceAuth(issued), evidence: "deterministic document render" });
    assert.equal(advanced.ok, true, "advance succeeds for a fully-sourced document stage");
    if (!advanced.ok) return;

    // The engine created the document, its derived offline viewer and the
    // typed artifact at the advance boundary.
    assert.ok(existsSync(join(featureDir, "documents", "product-prd.md")), "the PRD document is rendered");
    assert.ok(existsSync(join(featureDir, "documents", "product-prd.html")), "the derived PRD HTML viewer is rendered");
    assert.ok(existsSync(join(artifactsDir, "product_prd.json")), "the typed product_prd artifact is written");
    assert.deepEqual(validateProductPrdDocument({ stateDir: featureDir, artifactsDir }), { ok: true, issues: [] });

    // The transition committed: current stage done, next stage armed.
    assert.equal(advanced.state.stages.find((s) => s.id === "product_prd_document")?.status, "done");
    assert.equal(advanced.state.stage_cursor, "product_approval");
    assert.equal(advanced.state.dispatch_capability?.issued_for?.stage_cursor, "product_approval");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});


test("durable document render rejects a project-root replacement before writing the replacement", () => {
  const { issued, root } = setupDocumentStage(fiveSources());
  const outside = mkdtempSync(join(tmpdir(), "prd-durable-root-swap-outside-"));
  const moved = root + ".opened";
  const originalOpen = PinnedProjectRoot.open;
  let swapped = false;
  try {
    PinnedProjectRoot.open = (projectRoot, hooks = {}) => originalOpen(projectRoot, {
      ...hooks,
      beforeTempOpen: (relativePath) => {
        hooks.beforeTempOpen?.(relativePath);
        if (swapped || !relativePath.endsWith("documents/product-prd.md")) return;
        swapped = true;
        renameSync(root, moved);
        symlinkSync(outside, root, "dir");
      },
    });
    const advanced = advanceCursor(root, { ...advanceAuth(issued), evidence: "root swap render attempt" });
    assert.equal(advanced.ok, false, "a project-root replacement must block durable document advance");
    assert.equal(swapped, true, "the renderer write seam must execute");
    assert.deepEqual(readdirSync(outside), [], "the replacement root must remain untouched");
    assert.equal(existsSync(join(outside, "documents")), false, "no renderer output may escape to the replacement root");
    assert.equal(existsSync(join(outside, ".work-state")), false, "state must not be committed to the replacement root");
  } finally {
    PinnedProjectRoot.open = originalOpen;
    if (swapped) {
      rmSync(root, { recursive: true, force: true });
      renameSync(moved, root);
    }
    rmSync(root, { recursive: true, force: true });
    rmSync(moved, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test("durable document render rolls back exact outputs when the enclosing state CAS loses", () => {
  const { issued, root, featureDir } = setupDocumentStage(fiveSources());
  const documentPath = join(featureDir, "documents", "product-prd.md");
  const htmlPath = join(featureDir, "documents", "product-prd.html");
  const manifestPath = join(featureDir, "artifacts", "product_prd.json");
  const statePath = join(featureDir, "state.json");
  const oldDocument = "preexisting markdown\n";
  const oldHtml = "preexisting html\n";
  const oldManifest = "preexisting manifest\n";
  let injected = false;
  try {
    mkdirSync(join(featureDir, "documents"), { recursive: true });
    writeFileSync(documentPath, oldDocument, "utf8");
    writeFileSync(htmlPath, oldHtml, "utf8");
    writeFileSync(manifestPath, oldManifest, "utf8");
    setStateTransactionTestHooks({
      beforeCas: () => {
        if (injected) return;
        injected = true;
        const current = JSON.parse(readFileSync(statePath, "utf8")) as Record<string, unknown>;
        current.task = "concurrent state winner";
        current.state_revision = Number(current.state_revision ?? 0) + 1;
        writeFileSync(statePath, `${JSON.stringify(current, null, 2)}\n`, "utf8");
      },
    }, root);
    const advanced = advanceCursor(root, { ...advanceAuth(issued), evidence: "render before CAS drift" });
    assert.equal(advanced.ok, false, advanced.ok ? "state CAS drift must reject the document advance" : advanced.error);
    assert.equal(injected, true, "the deterministic state CAS seam must run");
    assert.equal(readFileSync(documentPath, "utf8"), oldDocument, "CAS abort restores the exact Markdown preimage");
    assert.equal(readFileSync(htmlPath, "utf8"), oldHtml, "CAS abort restores the exact HTML preimage");
    assert.equal(readFileSync(manifestPath, "utf8"), oldManifest, "CAS abort restores the exact manifest preimage");
  } finally {
    setStateTransactionTestHooks(null, root);
    rmSync(root, { recursive: true, force: true });
  }
});

test("durable document advance: a missing source fails closed — nothing rendered, nothing transitioned", () => {
  const sources = fiveSources();
  delete sources.product_evidence;
  const { issued, root, featureDir, artifactsDir } = setupDocumentStage(sources);
  try {
    const advanced = advanceCursor(root, { ...advanceAuth(issued), evidence: "attempted document render" });
    assert.equal(advanced.ok, false, "a missing source must block the advance");
    if (!advanced.ok) assert.match(advanced.error, /product_evidence/);

    const state = readState(root);
    assert.equal(state.stages.find((s) => s.id === "product_prd_document")?.status, "in_progress", "stage is not done");
    assert.equal(state.stage_cursor, "product_prd_document", "cursor did not move");
    assert.ok(!existsSync(join(artifactsDir, "product_prd.json")), "no artifact was written");
    assert.ok(!existsSync(join(featureDir, "documents")), "no document was rendered");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
test("durable document advance validates malformed present sources before any render side effect", () => {
  const sources = fiveSources();
  sources.product_evidence = { malformed: true };
  const { issued, root, featureDir, artifactsDir } = setupDocumentStage(sources);
  try {
    const before = readState(root);
    const advanced = advanceCursor(root, { ...advanceAuth(issued), evidence: "attempted malformed document render" });
    assert.equal(advanced.ok, false, "a malformed present source must block the advance");
    if (!advanced.ok) assert.match(advanced.error, /product_evidence|contract|invalid/i);
    assert.equal(readState(root).stage_cursor, before.stage_cursor, "cursor remains at the document stage");
    assert.equal(readState(root).stages.find((stage) => stage.id === "product_prd_document")?.status, "in_progress");
    assert.equal(existsSync(join(artifactsDir, "product_prd.json")), false, "malformed source must not write the typed artifact");
    assert.equal(existsSync(join(featureDir, "documents")), false, "malformed source must not render documents");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
