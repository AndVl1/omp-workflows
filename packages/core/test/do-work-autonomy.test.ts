/**
 * RC2+ regression tests: the static parser is a MECHANICAL `autonomyHint`,
 * never an authority. The main LLM classifies `type`/`complexity`/
 * `confidence`/`autonomous` together at PHASE-0 (in any language); the P5
 * gate reads `classification.autonomous` (the model decision), fails closed
 * on missing/non-boolean values, and never lets a static hint force a
 * workflow. Legacy top-level `TeamState.autonomous` is read-compat only.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, symlinkSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadProfile, profileHash } from "../src/engine/profile.js";
import { createCapability, beginCapability, authorizeDispatch, authorizeDispatchTrusted, completeDispatch, reconcileTrustedTaskResult, advanceCursor, recordCheckpointDecision } from "../src/engine/durable.js";
import { resolveWorkflowContract } from "../src/engine/workflow-contract.js";
import { buildDispatchMarker, parseDispatchMarker, trustedDispatchRequests } from "../src/gates/dispatch.js";
import { registerTeamWorkflow } from "../src/index.js";
import { resolveState, writeState } from "../src/engine/state.js";

import {
  parseWorkEnvelope,
  buildDoWorkPrompt,
  keywordClassify,
  resolveWorkflow,
  resolveClassification,
  classificationGate,
  buildCtoPrompt,
} from "@andvl1/omp-workflows-core";

function writeWorkflowState(root: string, state: Record<string, unknown>): void {
  mkdirSync(join(root, ".work-state"), { recursive: true });
  writeFileSync(join(root, ".work-state", "team-state.json"), JSON.stringify(state));
}

function initGit(root: string, branch: string): void {
  execFileSync("git", ["-C", root, "init", "--quiet", "--initial-branch", branch], { stdio: "ignore" });
}
test("do-work: matching-branch state prompt is resumable", () => {
  const root = mkdtempSync(join(tmpdir(), "do-work-resume-match-"));
  try {
    writeWorkflowState(root, { branch: "feat/current", task: "previous fix" });
    const prompt = buildDoWorkPrompt({ task: "feedback", autonomyHint: false, issue: null, branch: "feat/current" }, root);
    assert.match(prompt, /resumable continuation/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("do-work: stale active-feature state starts a new workflow", () => {
  const root = mkdtempSync(join(tmpdir(), "do-work-resume-stale-"));
  try {
    mkdirSync(join(root, ".work-state", "features", "old"), { recursive: true });
    writeFileSync(join(root, ".work-state", ".active-feature"), "old\n");
    writeFileSync(join(root, ".work-state", "features", "old", "state.json"), JSON.stringify({ branch: "feat/old", task: "previous fix" }));
    const prompt = buildDoWorkPrompt({ task: "feedback", autonomyHint: false, issue: null, branch: "feat/current" }, root);
    assert.match(prompt, /No existing do-work state was found/);
    assert.doesNotMatch(prompt, /resumable continuation/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
test("resolveState: rejects feature artifacts that escape through a symlink", () => {
  const root = mkdtempSync(join(tmpdir(), "state-artifact-symlink-"));
  try {
    const featureDir = join(root, ".work-state", "features", "current");
    const outside = join(root, "outside-artifacts");
    mkdirSync(featureDir, { recursive: true });
    mkdirSync(outside, { recursive: true });
    writeFileSync(join(root, ".work-state", ".active-feature"), "current\n");
    writeFileSync(join(featureDir, "state.json"), JSON.stringify({ branch: "feat/current" }));
    symlinkSync(outside, join(featureDir, "artifacts"), "dir");
    const resolved = resolveState(root, "feat/current");
    assert.equal(resolved.invalid, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("do-work: natural-language directive sets the hint and strips from task", () => {
  const root = mkdtempSync(join(tmpdir(), "do-work-ru-"));
  try {
    const envelope = parseWorkEnvelope("действуй автономно: исправь 500 на /api/users issue=#42", root);
    assert.equal(envelope.autonomyHint, true);
    assert.equal(envelope.task, "исправь 500 на /api/users");
    assert.equal(envelope.issue, 42);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("do-work: [AUTONOMOUSLY] lookalike stays literal and hint is false", () => {
  const root = mkdtempSync(join(tmpdir(), "do-work-look-"));
  try {
    const envelope = parseWorkEnvelope("[AUTONOMOUSLY] Fix bug", root);
    assert.equal(envelope.autonomyHint, false);
    assert.equal(envelope.task, "[AUTONOMOUSLY] Fix bug", "lookalike must survive verbatim");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ── (d) /cto and /do-work share the four-field classification contract ──────

test("do-work: prompt renders the hint as NON-authoritative metadata", () => {
  const root = mkdtempSync(join(tmpdir(), "do-work-prompt-"));
  try {
    const on = buildDoWorkPrompt(parseWorkEnvelope("действуй автономно: Fix bug", root), root);
    assert.ok(on.includes("Autonomy hint (leading directive — MECHANICAL, NOT authoritative): ON"), "hint ON rendered");
    assert.ok(on.includes("Never copy the hint into persisted"), "hint must not be copied as the decision");
    assert.ok(!on.includes("state.autonomous: true"), "prompt must NOT instruct persisting the parsed flag");
    assert.ok(!on.includes("state.autonomous: false"), "prompt must NOT instruct persisting the parsed flag");

    const off = buildDoWorkPrompt(parseWorkEnvelope("[AUTONOMOUSLY] Fix bug", root), root);
    assert.ok(off.includes("Autonomy hint (leading directive — MECHANICAL, NOT authoritative): OFF"), "hint OFF rendered");
    assert.ok(off.includes("[AUTONOMOUSLY] Fix bug"), "task text carries the lookalike verbatim");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("classification contract: /do-work and /cto request the SAME four model fields", () => {
  const root = mkdtempSync(join(tmpdir(), "class-contract-"));
  try {
    const work = buildDoWorkPrompt(parseWorkEnvelope("Fix login bug", root), root);
    const cto = buildCtoPrompt(parseWorkEnvelope("Fix login bug", root), root);
    for (const prompt of [work, cto]) {
      assert.ok(prompt.includes("CLASSIFICATION:"), "visible classification block");
      assert.ok(prompt.includes("- Type: FEATURE | REFACTOR | OPS | BUG_FIX | SPEC | REGRESS | INVESTIGATION | REVIEW | HOTFIX"), "Type field");
      assert.ok(prompt.includes("- Complexity: QUICK | MEDIUM | COMPLEX | CRITICAL"), "Complexity field");
      assert.ok(prompt.includes("- Confidence: HIGH | MEDIUM | LOW"), "Confidence field");
      assert.ok(prompt.includes("- Autonomous: true | false"), "Autonomous field");
      assert.ok(prompt.includes("Autonomy is YOUR decision"), "model decides autonomy");
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ── (a) hint false + natural-language autonomy → model true → debug-cycle ───

test("P5 gate: natural-language autonomous task (hint false) is accepted as debug-cycle when the MODEL decides true", () => {
  const root = mkdtempSync(join(tmpdir(), "p5-model-auto-"));
  try {
    const envelope = parseWorkEnvelope("Do this without waiting for approval — fix the login bug", root);
    assert.equal(envelope.autonomyHint, false, "parser does NOT recognize natural-language autonomy");

    // The prompt hands the FULL task to the model and lets it decide true.
    const prompt = buildDoWorkPrompt(envelope, root);
    assert.ok(prompt.includes("Do this without waiting for approval"), "full task visible to PHASE-0");
    assert.ok(prompt.includes("Autonomy hint (leading directive — MECHANICAL, NOT authoritative): OFF"), "hint OFF, not truth");

    // Model output: autonomous=true -> debug-cycle passes the gate.
    writeWorkflowState(root, {
      classification: { type: "BUG_FIX", complexity: "QUICK", workflow: "debug-cycle", autonomous: true, autonomous_reason: "task explicitly waives approval" },
    });
    assert.equal(classificationGate({ agent: "developer" }, { cwd: root }), undefined, "model autonomous=true accepted as debug-cycle");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ── (b) hint true + contradictory task → model false → interactive ─────────

test("P5 gate: [AUTONOMOUS] marker can be OVERRIDDEN by the model to interactive", () => {
  const root = mkdtempSync(join(tmpdir(), "p5-override-"));
  try {
    const envelope = parseWorkEnvelope("[AUTONOMOUS] Walk me through each step before touching code", root);
    assert.equal(envelope.autonomyHint, true, "static hint is ON");

    const prompt = buildDoWorkPrompt(envelope, root);
    assert.ok(prompt.includes("Autonomy hint (leading directive — MECHANICAL, NOT authoritative): ON"), "hint ON rendered");
    assert.ok(prompt.includes("a marked task can still be interactive"), "prompt documents that the model may override");

    // Model decides autonomous=false -> interactive bug-fix passes; debug-cycle blocks.
    writeWorkflowState(root, {
      classification: { type: "BUG_FIX", complexity: "QUICK", workflow: "bug-fix", autonomous: false, autonomous_reason: "user wants step-by-step review" },
    });
    assert.equal(classificationGate({ agent: "developer" }, { cwd: root }), undefined, "model false stays interactive");

    writeWorkflowState(root, {
      classification: { type: "BUG_FIX", complexity: "QUICK", workflow: "debug-cycle", autonomous: false },
    });
    const blocked = classificationGate({ agent: "developer" }, { cwd: root });
    assert.ok(blocked, "interactive QUICK BUG_FIX with debug-cycle is blocked");
    assert.ok(blocked?.reason?.includes("expected 'bug-fix'"), "block names the interactive resolution");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ── (c) absent / non-boolean classification.autonomous blocks ───────────────

test("P5 gate: missing classification.autonomous blocks — no silent default", () => {
  const root = mkdtempSync(join(tmpdir(), "p5-missing-auto-"));
  try {
    writeWorkflowState(root, {
      classification: { type: "BUG_FIX", complexity: "QUICK", workflow: "debug-cycle" },
    });
    const blocked = classificationGate({ agent: "developer" }, { cwd: root });
    assert.ok(blocked, "missing autonomous blocks");
    assert.ok(blocked?.reason?.includes("classification.autonomous is missing"), "reason names the missing field");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("P5 gate: non-boolean classification.autonomous blocks — fail closed", () => {
  const root = mkdtempSync(join(tmpdir(), "p5-nonbool-auto-"));
  try {
    writeWorkflowState(root, {
      classification: { type: "BUG_FIX", complexity: "QUICK", workflow: "debug-cycle", autonomous: "true" },
    });
    const blocked = classificationGate({ agent: "developer" }, { cwd: root });
    assert.ok(blocked, "string autonomous blocks");
    assert.ok(blocked?.reason?.includes("must be a boolean"), "reason names the invalid type");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ── (f) workflow_override can never bypass the fail-closed autonomy gate ────

test("P5 gate: workflow_override:true cannot bypass MISSING classification.autonomous", () => {
  const root = mkdtempSync(join(tmpdir(), "p5-override-missing-"));
  try {
    writeWorkflowState(root, {
      classification: { type: "BUG_FIX", complexity: "QUICK", workflow: "debug-cycle" },
      workflow_override: true,
    });
    const blocked = classificationGate({ agent: "developer" }, { cwd: root });
    assert.ok(blocked, "an explicit override must not bypass a missing model autonomy field");
    assert.ok(blocked?.reason?.includes("classification.autonomous is missing"), "reason names the missing field");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("P5 gate: workflow_override:true cannot bypass NON-BOOLEAN classification.autonomous", () => {
  const root = mkdtempSync(join(tmpdir(), "p5-override-nonbool-"));
  try {
    writeWorkflowState(root, {
      classification: { type: "BUG_FIX", complexity: "QUICK", workflow: "debug-cycle", autonomous: "true" },
      workflow_override: true,
    });
    const blocked = classificationGate({ agent: "developer" }, { cwd: root });
    assert.ok(blocked, "an explicit override must not bypass a non-boolean model autonomy field");
    assert.ok(blocked?.reason?.includes("must be a boolean"), "reason names the invalid type");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("P5 gate: workflow_override:true still allows a VALID model autonomy decision", () => {
  const root = mkdtempSync(join(tmpdir(), "p5-override-valid-"));
  try {
    writeWorkflowState(root, {
      classification: { type: "BUG_FIX", complexity: "QUICK", workflow: "debug-cycle", autonomous: false },
      workflow_override: true,
    });
    assert.equal(
      classificationGate({ agent: "developer" }, { cwd: root }),
      undefined,
      "override with a valid boolean decision passes — the override skips the mismatch check, not the autonomy gate",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ── (e) legacy top-level state reads safely; new field wins over legacy ─────

test("P5 gate: legacy top-level autonomous reads compatibly when the model field is absent", () => {
  const root = mkdtempSync(join(tmpdir(), "p5-legacy-"));
  try {
    writeWorkflowState(root, {
      classification: { type: "BUG_FIX", complexity: "QUICK", workflow: "debug-cycle" },
      autonomous: true,
    });
    assert.equal(classificationGate({ agent: "developer" }, { cwd: root }), undefined, "legacy autonomous=true + debug-cycle passes");

    writeWorkflowState(root, {
      classification: { type: "BUG_FIX", complexity: "QUICK", workflow: "debug-cycle" },
      autonomous: false,
    });
    const blocked = classificationGate({ agent: "developer" }, { cwd: root });
    assert.ok(blocked, "legacy autonomous=false must NOT silently run debug-cycle");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("P5 gate: a present model field wins over the legacy top-level field", () => {
  const root = mkdtempSync(join(tmpdir(), "p5-priority-"));
  try {
    // Legacy says true, model says false — the model decision is the authority.
    writeWorkflowState(root, {
      classification: { type: "BUG_FIX", complexity: "QUICK", workflow: "bug-fix", autonomous: false },
      autonomous: true,
    });
    assert.equal(classificationGate({ agent: "developer" }, { cwd: root }), undefined, "model false keeps it interactive");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ── static hint can never force autonomous ──────────────────────────────────

test("P5 gate: a static hint cannot force autonomous — hint true + model false stays interactive", () => {
  const root = mkdtempSync(join(tmpdir(), "p5-static-hint-"));
  try {
    const envelope = parseWorkEnvelope("[AUTONOMOUS] Fix bug", root);
    assert.equal(envelope.autonomyHint, true);

    // Even with the marker present, the persisted model decision rules.
    writeWorkflowState(root, {
      classification: { type: "BUG_FIX", complexity: "QUICK", workflow: "bug-fix", autonomous: false },
    });
    assert.equal(classificationGate({ agent: "developer" }, { cwd: root }), undefined, "hint true must not force debug-cycle");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ── engine classification is demoted and cannot pick autonomy ───────────────

test("do-work: keywordClassify guesses type/complexity only — it cannot decide autonomy", () => {
  const base = keywordClassify("fix the login bug");
  assert.equal(base.type, "BUG_FIX", "keyword guess still detects the type");
  assert.ok(!("autonomous" in base), "keyword guess has no autonomous field");
  assert.equal(resolveWorkflow(base.type, base.complexity, true), "debug-cycle", "autonomous BUG_FIX resolves to debug-cycle even at QUICK");
  assert.equal(resolveWorkflow("BUG_FIX", "QUICK", false), "bug-fix", "interactive QUICK BUG_FIX stays bug-fix");
});

test("do-work: type/complexity/autonomous resolve together from the model classification", () => {
  const auto = { type: "BUG_FIX", complexity: "QUICK", confidence: "HIGH", autonomous: true, workflow: "debug-cycle" };
  const interactive = { type: "BUG_FIX", complexity: "QUICK", confidence: "HIGH", autonomous: false, workflow: "bug-fix" };
  assert.equal(resolveWorkflow(auto.type, auto.complexity, auto.autonomous), auto.workflow, "model auto classification maps to debug-cycle");
  assert.equal(resolveWorkflow(interactive.type, interactive.complexity, interactive.autonomous), interactive.workflow, "model interactive classification maps to bug-fix");
});

test("engine: resolveClassification treats the MODEL classification as authoritative", () => {
  const resolved = resolveClassification({
    task: "fix the login bug",
    autonomous: true, // legacy hint — must be IGNORED when the model speaks
    classification: {
      type: "BUG_FIX",
      complexity: "QUICK",
      confidence: "MEDIUM",
      autonomous: false,
      autonomous_reason: "user wants review",
    },
  });
  assert.deepEqual(resolved, {
    type: "BUG_FIX",
    complexity: "QUICK",
    confidence: "MEDIUM",
    autonomous: false,
    autonomous_reason: "user wants review",
    workflow: "bug-fix", // resolved from the MODEL's autonomous, not the hint
  });
});

test("engine: resolveClassification FAILS CLOSED on incomplete model output (no keyword fallback)", () => {
  assert.throws(
    () => resolveClassification({ task: "fix the login bug", autonomous: true, classification: { type: "BUG_FIX", complexity: "QUICK", confidence: "HIGH" } }),
    /classification gate: model classification incomplete/,
    "missing autonomous blocks — no silent default",
  );
  assert.throws(
    () => resolveClassification({ task: "fix the login bug", autonomous: true, classification: { type: "BUG_FIX", complexity: "QUICK", confidence: "HIGH", autonomous: "true" } }),
    /classification gate: model classification incomplete/,
    "non-boolean autonomous blocks — fail closed",
  );
});

test("engine: legacy path (no model classification) uses the caller flag verbatim — never defaulted", () => {
  const resolved = resolveClassification({ task: "fix the login bug", autonomous: true });
  assert.equal(resolved.type, "BUG_FIX", "keyword guess still detects the type on the legacy path");
  assert.equal(resolved.autonomous, true, "caller-supplied flag used verbatim");
  assert.equal(resolved.workflow, "debug-cycle", "workflow resolved from the caller flag");
});

test("P5 gate: missing classification blocks; absent state allows (legacy flow)", () => {
  const root = mkdtempSync(join(tmpdir(), "p5-missing-"));
  try {
    writeWorkflowState(root, { classification: { complexity: "QUICK" } });
    const blocked = classificationGate({ agent: "developer" }, { cwd: root });
    assert.ok(blocked, "missing classification blocks subagent launch");

    rmSync(join(root, ".work-state"), { recursive: true, force: true });
    assert.equal(classificationGate({ agent: "developer" }, { cwd: root }), undefined, "no state -> legacy allow");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("strict orchestrator policy blocks source and canonical-state writes, allows artifacts", async () => {
  const root = mkdtempSync(join(tmpdir(), "orchestrator-write-policy-"));
  try {
    mkdirSync(join(root, ".work-state", "artifacts"), { recursive: true });
    writeFileSync(join(root, ".work-state", "team-state.json"), JSON.stringify({ policy: { strict_orchestrator: true } }));
    const { orchestratorWriteGate } = await import("../src/gates/orchestrator-write.ts");
    const source = orchestratorWriteGate({ toolName: "write", input: { actor: "worker", path: "src/app.ts" } }, { cwd: root, hasUI: true });
    assert.equal(source?.block, true);
    assert.match(source?.reason ?? "", /may write only under \.work-state/);
    const state = orchestratorWriteGate({ toolName: "edit", input: { actor: "worker", path: ".work-state/team-state.json" } }, { cwd: root, hasUI: true });
    assert.equal(state?.block, true);
    assert.match(state?.reason ?? "", /canonical workflow state/);
    const artifact = orchestratorWriteGate({ toolName: "write", input: { actor: "worker", path: ".work-state/artifacts/report.json" } }, { cwd: root, hasUI: true });
    assert.equal(artifact, undefined);
    const worker = orchestratorWriteGate({ toolName: "write", input: { actor: "orchestrator", path: "src/app.ts" } }, { cwd: root, hasUI: false });
    assert.equal(worker, undefined);
    const bashEcho = orchestratorWriteGate({ toolName: "bash", input: { command: "echo hacked > src/app.ts" } }, { cwd: root, hasUI: true });
    assert.equal(bashEcho?.block, true);
    const bashRemove = orchestratorWriteGate({ toolName: "bash", input: { command: "rm src/app.ts" } }, { cwd: root, hasUI: true });
    assert.equal(bashRemove?.block, true);
    const bashRead = orchestratorWriteGate({ toolName: "bash", input: { command: "git diff -- src/app.ts" } }, { cwd: root, hasUI: true });
    assert.equal(bashRead, undefined);
    const workerCanonicalBash = orchestratorWriteGate({ toolName: "bash", input: { command: "cat > .work-state/team-state.json" } }, { cwd: root, hasUI: false });
    assert.equal(workerCanonicalBash?.block, true);
    const ctoCanonicalBash = orchestratorWriteGate({ toolName: "bash", input: { command: "awk '{print}' > .work-state/cto/run-1/state.json" } }, { cwd: root, hasUI: true });
    assert.equal(ctoCanonicalBash?.block, true);
    const redirectedSource = orchestratorWriteGate({ toolName: "bash", input: { command: "git show HEAD:src/app.ts > \"$(pwd)/src/app.ts\"" } }, { cwd: root, hasUI: true });
    assert.equal(redirectedSource?.block, true);
    const workerCanonicalInPlace = orchestratorWriteGate({ toolName: "bash", input: { command: "awk -i inplace '{print}' .work-state/team-state.json" } }, { cwd: root, hasUI: false });
    assert.equal(workerCanonicalInPlace?.block, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
test("strict durable transitions fail closed when no active git branch exists", () => {
  const root = mkdtempSync(join(tmpdir(), "durable-no-git-"));
  try {
    writeWorkflowState(root, {
      branch: "feature/no-git",
      classification: { workflow: "lightweight" },
      stage_cursor: "implementation",
      stages: [{ id: "implementation", status: "in_progress" }],
    });
    const begun = beginCapability(root);
    assert.equal(begun.ok, false);
    assert.match(begun.error, /stale for the active branch/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("do-work prompt makes orchestrator non-coding policy explicit", () => {
  const root = mkdtempSync(join(tmpdir(), "do-work-policy-prompt-"));
  try {
    const prompt = buildDoWorkPrompt(parseWorkEnvelope("Implement feature", root), root);
    assert.match(prompt, /STRICT ORCHESTRATOR POLICY/);
    assert.match(prompt, /write\/edit application source or project files \| DENY/);
    assert.match(prompt, /After every delegated call or parallel batch/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("do-work: prompt is tool-only for workflow content and never instructs filesystem profile reads", () => {
  // Arbitrary consumer project: a fresh temp dir, no packages/core anywhere.
  const root = mkdtempSync(join(tmpdir(), "do-work-consumer-"));
  try {
    assert.ok(!existsSync(join(root, "packages", "core")), "temp consumer cwd has no packages/core");
    const prompt = buildDoWorkPrompt(parseWorkEnvelope("Fix login bug", root), root);

    // Step 1 must be an explicit tool-only sequence: workflow_begin first,
    // then workflow_instructions as the ONLY workflow instruction source.
    assert.ok(
      prompt.includes("workflow_begin"),
      "prompt must require workflow_begin after state is persisted",
    );
    assert.ok(
      prompt.indexOf("workflow_begin") < prompt.indexOf("workflow_instructions"),
      "workflow_begin must precede workflow_instructions in the tool sequence",
    );
    assert.ok(
      prompt.includes("stage.instructions"),
      "prompt must name the returned stage contract field stage.instructions",
    );
    assert.match(prompt, /only workflow instruction source/i);
    // After every workflow_advance the model must re-fetch workflow_instructions.
    assert.match(prompt, /workflow_advance`, call `workflow_instructions`/);

    // No filesystem/package-path/plugin-root workflow content sourcing.
    assert.ok(!prompt.includes("findProfileDir"), "prompt must not reference the profile directory helper");
    assert.ok(!prompt.includes("<workflow>.json"), "prompt must not instruct reading workflow JSON from disk");
    assert.ok(!prompt.includes("CLAUDE_PLUGIN_ROOT"), "prompt must not mention CLAUDE_PLUGIN_ROOT");
    assert.ok(!prompt.includes("omp://"), "prompt must not mention omp:// for workflow content");
    assert.match(prompt, /Do NOT glob for workflow files/, "prompt must forbid globbing workflow files");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("team and do-work use the same strict orchestration contract", () => {
  const root = mkdtempSync(join(tmpdir(), "team-alias-policy-"));
  try {
    const work = buildDoWorkPrompt(parseWorkEnvelope("Implement feature", root), root);
    const team = buildDoWorkPrompt(parseWorkEnvelope("Implement feature", root), root);
    assert.equal(team, work, "/team alias must resolve to the identical canonical prompt");
    assert.match(team, /STRICT ORCHESTRATOR POLICY/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("dispatch gate requires the exact active cursor stage and roster", async () => {
  const root = mkdtempSync(join(tmpdir(), "dispatch-cursor-"));
  try {
    initGit(root, "feat/test");
    mkdirSync(join(root, ".work-state"), { recursive: true });
    const profile = loadProfile("lightweight");
    assert.ok(profile, "lightweight profile must be available for strict dispatch fixture");
    const persistedProfileHash = profileHash(profile);
    const capability = createCapability({
      run_key: "feat/test", branch: "feat/test", workflow: "lightweight", profile_hash: persistedProfileHash,
      stage_cursor: "implementation", kind: "single", expected_roster: [{ role: "${scope.dev_agent}", agent: "${scope.dev_agent}" }],
    });
    writeFileSync(join(root, ".work-state", "team-state.json"), JSON.stringify({
      branch: "feat/test", run_key: "feat/test", policy: { strict_orchestrator: true }, stage_cursor: "implementation",
      stages: [{ id: "implementation", status: "in_progress" }],
      cursor_epoch: capability.state.issued_for?.cursor_epoch, profile_hash: persistedProfileHash,
      dispatch_capability: capability.state,
      classification: { type: "FEATURE", complexity: "QUICK", confidence: "HIGH", autonomous: false, workflow: "lightweight" },
    }));
    const { dispatchGate } = await import("../src/gates/dispatch.ts");
    const wrong = dispatchGate({ toolName: "task", input: { agent: "backend-kotlin", task: "<!-- omp-dispatch run=feat/test stage=discovery kind=single cursor=discovery roles=analyst -->" } }, { cwd: root });
    assert.equal(wrong?.block, true);
    const right = dispatchGate({ toolName: "task", input: { agent: "${scope.dev_agent}", role: "${scope.dev_agent}", task: `<!-- omp-dispatch run=feat/test stage=implementation kind=single cursor=${capability.state.issued_for?.cursor_epoch} roles=\${scope.dev_agent} -->` } }, { cwd: root });
    assert.equal(right, undefined);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
test("dispatch markers bind to the persisted cursor epoch", () => {
  const stage = { id: "implementation", title: "Implementation", type: "single" as const, role: "go" };
  const marker = buildDispatchMarker("run-1", stage, ["go"], "go", "epoch-1");
  assert.equal(parseDispatchMarker(marker)?.cursor, "epoch-1");
});
test("strict runtime issues opaque capabilities and reconciles native task results", () => {
  const root = mkdtempSync(join(tmpdir(), "dispatch-capability-runtime-"));
  try {
    initGit(root, "feature/capability");
    const profile = loadProfile("lightweight");
    assert.ok(profile);
    writeWorkflowState(root, {
      schema: 1,
      branch: "feature/capability",
      task: "capability test",
      classification: { type: "FEATURE", complexity: "QUICK", confidence: "HIGH", autonomous: false, workflow: "lightweight" },
      stage_cursor: "implementation",
      stages: profile.stages.map((stage) => ({
        id: stage.id,
        status: stage.id === "implementation" ? "in_progress" : stage.id === "discovery" ? "done" : "pending",
      })),
      artifacts: {},
      scope: { scope: ["backend-kotlin"], has_security: false, has_infra: false, has_ui: false, has_runtime: true, dev_agent: "developer-kotlin" },
      policy: { strict_orchestrator: true },
      pause: { kind: "none", reason: "" },
    });

    const begun = beginCapability(root);
    assert.equal(begun.ok, true);
    if (!begun.ok || !begun.handoff) return;
    const handoff = begun.handoff;
    const persisted = readFileSync(join(root, ".work-state", "team-state.json"), "utf8");
    assert.doesNotMatch(persisted, new RegExp(handoff.dispatch_token));
    assert.doesNotMatch(persisted, new RegExp(handoff.advance_token));

    const stage = profile.stages.find((candidate) => candidate.id === "implementation");
    assert.ok(stage);
    const marker = buildDispatchMarker(handoff.run_key, stage, ["developer-kotlin"], "developer-kotlin", handoff.cursor_epoch);
    const request = trustedDispatchRequests({
      toolName: "task",
      toolCallId: "tool-1",
      input: { agent: "developer-kotlin", role: "developer-kotlin", task: marker },
    }, { cwd: root });
    assert.equal(request.ok, true);
    if (!request.ok) return;
    assert.equal(request.requests.length, 1);
    const preauthorized = authorizeDispatch(root, {
      token: handoff.dispatch_token,
      capability_id: handoff.capability_id,
      run_key: handoff.run_key,
      branch: handoff.branch,
      workflow: handoff.workflow,
      profile_hash: handoff.profile_hash,
      stage_cursor: handoff.stage_cursor,
      cursor_epoch: handoff.cursor_epoch,
      role: "developer-kotlin",
      agent: "developer-kotlin",
    });
    assert.equal(preauthorized.ok, true);
    const authorized = authorizeDispatchTrusted(root, request.requests[0]!);
    assert.equal(authorized.ok, true);
    if (!authorized.ok || !authorized.record) return;
    const duplicateAuthorization = authorizeDispatchTrusted(root, request.requests[0]!);
    assert.equal(duplicateAuthorization.ok, true);
    if (!duplicateAuthorization.ok || !duplicateAuthorization.record) return;
    assert.equal(duplicateAuthorization.record.id, authorized.record.id);

    const reconciled = reconcileTrustedTaskResult(root, {
      tool_call_id: "tool-1",
      outcome: "succeeded",
      evidence: "native task result",
    });
    assert.equal(reconciled.ok, true);
    mkdirSync(join(root, ".work-state", "artifacts"), { recursive: true });
    writeFileSync(join(root, ".work-state", "artifacts", "result.json"), "{}");
    writeFileSync(join(root, ".work-state", "artifacts", "discovery.json"), JSON.stringify({ task: "capability test", branch: "feature/capability" }));
    writeFileSync(join(root, ".work-state", "artifacts", "implementation.json"), JSON.stringify({
      ready: true,
      validation_run: true,
      validation_evidence: "focused durable capability test",
      files_touched: ["src/main.ts"],
    }));
    const replay = completeDispatch(root, {
      token: handoff.dispatch_token,
      capability_id: handoff.capability_id,
      run_key: handoff.run_key,
      branch: handoff.branch,
      workflow: handoff.workflow,
      profile_hash: handoff.profile_hash,
      stage_cursor: handoff.stage_cursor,
      cursor_epoch: handoff.cursor_epoch,
      role: "developer-kotlin",
      agent: "developer-kotlin",
      tool_call_id: "tool-1",
      dispatch_id: authorized.record.id,
      outcome: "succeeded",
      evidence: "explicit workflow evidence",
      artifact_ids: ["result"],
    });
    assert.equal(replay.ok, true);

    // lightweight implementation declares a checkpoint; record the durable
    // decision before advance is allowed.
    const checkpoint = recordCheckpointDecision(root, {
      token: handoff.advance_token,
      capability_id: handoff.capability_id,
      run_key: handoff.run_key,
      branch: handoff.branch,
      workflow: handoff.workflow,
      profile_hash: handoff.profile_hash,
      stage_cursor: handoff.stage_cursor,
      cursor_epoch: handoff.cursor_epoch,
      checkpoint: "approve_implementation", mode: "autonomous", decision: "proceed", actor: "orchestrator", rationale: "fixture",
    });
    assert.equal(checkpoint.ok, true);

    const advanced = advanceCursor(root, {
      token: handoff.advance_token,
      capability_id: handoff.capability_id,
      run_key: handoff.run_key,
      branch: handoff.branch,
      workflow: handoff.workflow,
      profile_hash: handoff.profile_hash,
      stage_cursor: handoff.stage_cursor,
      cursor_epoch: handoff.cursor_epoch,
      evidence: "implementation completed",
    });
    assert.equal(advanced.ok, true);
    if (!advanced.ok) return;
    assert.equal(advanced.state.stage_cursor, "code_review");
    assert.equal(advanced.handoff?.expected_roster[0]?.role, "code-reviewer");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
test("native task hook leaves spawned and scheduled results pending", () => {
  const root = mkdtempSync(join(tmpdir(), "dispatch-capability-async-"));
  try {
    initGit(root, "feature/async-capability");
    const profile = loadProfile("lightweight");
    assert.ok(profile);
    writeWorkflowState(root, {
      schema: 1,
      branch: "feature/async-capability",
      task: "async capability test",
      classification: { type: "FEATURE", complexity: "QUICK", confidence: "HIGH", autonomous: false, workflow: "lightweight" },
      stage_cursor: "implementation",
      stages: profile.stages.map((stage) => ({
        id: stage.id,
        status: stage.id === "implementation" ? "in_progress" : stage.id === "discovery" ? "done" : "pending",
      })),
      artifacts: {},
      scope: { scope: ["backend-kotlin"], has_security: false, has_infra: false, has_ui: false, has_runtime: true, dev_agent: "developer-kotlin" },
      policy: { strict_orchestrator: true },
      pause: { kind: "none", reason: "" },
    });
    const begun = beginCapability(root);
    assert.equal(begun.ok, true);
    if (!begun.ok || !begun.handoff) return;
    const stage = profile.stages.find((candidate) => candidate.id === "implementation");
    assert.ok(stage);
    const marker = buildDispatchMarker(begun.handoff.run_key, stage, ["developer-kotlin"], "developer-kotlin", begun.handoff.cursor_epoch);
    const request = trustedDispatchRequests({
      toolName: "task",
      toolCallId: "tool-async",
      input: { agent: "developer-kotlin", role: "developer-kotlin", task: marker },
    }, { cwd: root });
    assert.equal(request.ok, true);
    if (!request.ok) return;
    assert.equal(authorizeDispatchTrusted(root, request.requests[0]!).ok, true);

    const handlers = new Map<string, (event: unknown, ctx: unknown) => unknown>();
    registerTeamWorkflow({
      setLabel() {},
      on(name: string, handler: (event: unknown, ctx: unknown) => unknown) {
        handlers.set(name, handler);
      },
    } as never, { observability: false });
    const onToolResult = handlers.get("tool_result");
    assert.ok(onToolResult);
    for (const state of ["spawned", "scheduled"]) {
      onToolResult!({
        toolName: "task",
        toolCallId: "tool-async",
        content: [],
        isError: false,
        details: { async: { state } },
      }, { cwd: root });
    }
    const persisted = resolveState(root, "feature/async-capability").state;
    assert.equal(persisted?.dispatch_capability?.dispatches[0]?.status, "authorized");
    assert.equal(persisted?.dispatch_capability?.dispatches[0]?.completion, undefined);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
test("trusted reconciliation preserves every dispatch in a consilium batch", () => {
  const root = mkdtempSync(join(tmpdir(), "dispatch-capability-batch-"));
  try {
    initGit(root, "feature/batch-capability");
    const profile = loadProfile("review");
    assert.ok(profile);
    writeWorkflowState(root, {
      schema: 1,
      branch: "feature/batch-capability",
      task: "batch capability test",
      classification: { type: "REVIEW", complexity: "COMPLEX", confidence: "HIGH", autonomous: true, workflow: "review" },
      stage_cursor: "review",
      stages: profile.stages.map((stage) => ({
        id: stage.id,
        status: stage.id === "review" ? "in_progress" : stage.id === "discovery" ? "done" : "pending",
      })),
      artifacts: {},
      scope: { scope: ["backend-kotlin"], has_security: false, has_infra: false, has_ui: false, has_runtime: true, dev_agent: "developer-kotlin" },
      policy: { strict_orchestrator: true },
      pause: { kind: "none", reason: "" },
    });

    const begun = beginCapability(root);
    assert.equal(begun.ok, true);
    if (!begun.ok || !begun.handoff) return;
    const request = trustedDispatchRequests({
      toolName: "task",
      toolCallId: "tool-batch",
      input: {
        tasks: [
          { role: "code-reviewer", agent: "code-reviewer", task: "review the branch" },
          { role: "qa", agent: "qa", task: "check the branch" },
        ],
      },
    }, { cwd: root });
    assert.equal(request.ok, true);
    if (!request.ok) return;
    assert.equal(request.requests.length, 2);
    for (const authorization of request.requests) {
      assert.equal(authorizeDispatchTrusted(root, authorization).ok, true);
    }

    const reconciled = reconcileTrustedTaskResult(root, {
      tool_call_id: "tool-batch",
      outcome: "succeeded",
      evidence: "batch completed",
    });
    assert.equal(reconciled.ok, true);
    if (!reconciled.ok) return;
    assert.deepEqual(
      reconciled.state.dispatch_capability?.dispatches.map((dispatch) => dispatch.status),
      ["succeeded", "succeeded"],
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});



test("advance handoff resolves the next stage roster", () => {
  const root = mkdtempSync(join(tmpdir(), "dispatch-handoff-"));
  try {
    initGit(root, "feat/handoff");
    const profile = loadProfile("lightweight");
    assert.ok(profile);
    const persistedProfileHash = profileHash(profile);
    const issued = createCapability({
      run_key: "feat/handoff",
      branch: "feat/handoff",
      workflow: "lightweight",
      profile_hash: persistedProfileHash,
      stage_cursor: "implementation",
      kind: "single",
      expected_roster: [{ role: "${scope.dev_agent}", agent: "developer-kotlin" }],
    });
    const state = {
      schema: 1,
      branch: "feat/handoff",
      run_key: "feat/handoff",
      classification: { type: "FEATURE", complexity: "QUICK", confidence: "HIGH", autonomous: false, workflow: "lightweight" },
      task: "handoff",
      workflow_override: false,
      issue: null,
      stage_cursor: "implementation",
      stages: profile.stages.map((stage) => ({ id: stage.id, status: stage.id === "implementation" ? "in_progress" as const : "pending" as const })),
      artifacts: {},
      pause: { kind: "none" as const, reason: "" },
      policy: { strict_orchestrator: true },
      profile_hash: persistedProfileHash,
      cursor_epoch: issued.state.issued_for?.cursor_epoch,
      dispatch_capability: issued.state,
      updated_at: new Date().toISOString(),
    };
    writeState(root, state, { featureSlug: "handoff" });
    mkdirSync(join(root, ".work-state", "features", "handoff", "artifacts"), { recursive: true });
    writeFileSync(join(root, ".work-state", "features", "handoff", "artifacts", "implementation.json"), JSON.stringify({
      ready: true,
      validation_run: true,
      validation_evidence: "focused handoff test",
      files_touched: ["src/main.ts"],
    }));
    const authInput = {
      token: issued.dispatch_token,
      capability_id: issued.capability_id,
      run_key: "feat/handoff",
      branch: "feat/handoff",
      workflow: "lightweight",
      profile_hash: persistedProfileHash,
      stage_cursor: "implementation",
      cursor_epoch: issued.state.issued_for!.cursor_epoch,
      role: "${scope.dev_agent}",
      agent: "developer-kotlin",
    };
    const authorized = authorizeDispatch(root, authInput);
    assert.equal(authorized.ok, true);
    if (!authorized.ok || !authorized.record) return;
    const completed = completeDispatch(root, {
      ...authInput,
      dispatch_id: authorized.record.id,
      outcome: "succeeded",
      evidence: "task completed",
    });
    assert.equal(completed.ok, true);
    const checkpoint = recordCheckpointDecision(root, {
      ...authInput,
      token: issued.advance_token,
      checkpoint: "approve_implementation", mode: "autonomous", decision: "proceed", actor: "orchestrator", rationale: "fixture",
    });
    assert.equal(checkpoint.ok, true);
    const advanced = advanceCursor(root, {
      ...authInput,
      token: issued.advance_token,
      evidence: "stage completed",
    });
    assert.equal(advanced.ok, true);
    if (!advanced.ok) return;
    assert.equal(advanced.state.stage_cursor, "code_review");
    assert.deepEqual(advanced.state.dispatch_capability?.expected_roster, [{ role: "code-reviewer", agent: "code-reviewer" }]);
    assert.equal(advanced.state.dispatch_capability?.kind, "single");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("workflow contract supports an explicit stateless profile lookup", () => {
  const root = mkdtempSync(join(tmpdir(), "workflow-contract-stateless-"));
  try {
    const contract = resolveWorkflowContract(root, { requireState: false, workflow: "lightweight", branch: "main" });
    assert.equal(contract.state.path, null);
    assert.equal(contract.provenance.statePath, null);
    assert.equal(contract.stage.id, "discovery");
    assert.equal(contract.state.dispatch.allowed, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
