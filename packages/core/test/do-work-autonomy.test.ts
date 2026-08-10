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
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

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
test("do-work: existing state prompt requires same-turn continuation", () => {
  const root = mkdtempSync(join(tmpdir(), "do-work-resume-"));
  try {
    mkdirSync(join(root, ".work-state"), { recursive: true });
    writeFileSync(join(root, ".work-state", "team-state.json"), JSON.stringify({ task: "previous fix" }));
    const prompt = buildDoWorkPrompt(parseWorkEnvelope("feedback", root), root);
    assert.match(prompt, /resumable continuation/);
    assert.match(prompt, /Continue executing in THIS TURN/);
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
      assert.ok(prompt.includes("- Type: FEATURE | REFACTOR | OPS | BUG_FIX | INVESTIGATION | REVIEW | HOTFIX"), "Type field");
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
