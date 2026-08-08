/**
 * RC2 regression tests: do-work PHASE-0, engine classification and the P5
 * gate all consume the SAME parsed explicit autonomous flag — never a text
 * heuristic. The natural-language directive must reach the persisted state
 * (`state.autonomous`) and the gate must not silently downgrade an
 * autonomous workflow to its interactive counterpart.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  parseWorkEnvelope,
  buildDoWorkPrompt,
  classify,
  resolveWorkflow,
  classificationGate,
} from "@andvl1/omp-workflows-core";

function writeWorkflowState(root: string, state: Record<string, unknown>): void {
  mkdirSync(join(root, ".work-state"), { recursive: true });
  writeFileSync(join(root, ".work-state", "team-state.json"), JSON.stringify(state));
}

test("do-work: natural-language directive enables autonomy and strips from task", () => {
  const root = mkdtempSync(join(tmpdir(), "do-work-ru-"));
  try {
    const envelope = parseWorkEnvelope("действуй автономно: исправь 500 на /api/users issue=#42", root);
    assert.equal(envelope.autonomous, true);
    assert.equal(envelope.task, "исправь 500 на /api/users");
    assert.equal(envelope.issue, 42);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("do-work: [AUTONOMOUSLY] lookalike stays literal and non-autonomous", () => {
  const root = mkdtempSync(join(tmpdir(), "do-work-look-"));
  try {
    const envelope = parseWorkEnvelope("[AUTONOMOUSLY] Fix bug", root);
    assert.equal(envelope.autonomous, false);
    assert.equal(envelope.task, "[AUTONOMOUSLY] Fix bug", "lookalike must survive verbatim");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("do-work: prompt renders the parsed flag as a literal state field (natural directive)", () => {
  const root = mkdtempSync(join(tmpdir(), "do-work-prompt-"));
  try {
    const prompt = buildDoWorkPrompt(parseWorkEnvelope("действуй автономно: Fix bug", root), root);
    assert.ok(prompt.includes("Autonomous mode: ON"), "metadata shows ON");
    assert.ok(prompt.includes("state.autonomous: true"), "PHASE-0 must persist the literal parsed flag");
    assert.ok(prompt.includes("forces BUG_FIX -> debug-cycle"), "matrix documents the autonomous resolution");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("do-work: prompt renders OFF with the literal false flag for lookalike input", () => {
  const root = mkdtempSync(join(tmpdir(), "do-work-prompt-off-"));
  try {
    const envelope = parseWorkEnvelope("[AUTONOMOUSLY] Fix bug", root);
    const prompt = buildDoWorkPrompt(envelope, root);
    assert.ok(prompt.includes("Autonomous mode: OFF"), "lookalike stays OFF");
    assert.ok(prompt.includes("state.autonomous: false"), "PHASE-0 persists false for non-autonomous");
    assert.ok(prompt.includes("[AUTONOMOUSLY] Fix bug"), "task text carries the lookalike verbatim");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("do-work: engine classification resolves the workflow with the parsed flag", () => {
  const root = mkdtempSync(join(tmpdir(), "do-work-engine-"));
  try {
    const task = parseWorkEnvelope("действуй автономно: fix the login bug", root).task;
    const base = classify(task, { autonomous: true });
    assert.equal(base.type, "BUG_FIX", "engine classify still detects the type");
    const expected = resolveWorkflow(base.type, base.complexity, true);
    assert.equal(expected, "debug-cycle", "autonomous BUG_FIX resolves to debug-cycle even at QUICK complexity");
    assert.equal(resolveWorkflow("BUG_FIX", "QUICK", false), "bug-fix", "interactive QUICK BUG_FIX stays bug-fix");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("P5 gate: autonomous BUG_FIX QUICK accepts debug-cycle and blocks bug-fix downgrade", () => {
  const root = mkdtempSync(join(tmpdir(), "p5-auto-"));
  try {
    writeWorkflowState(root, {
      classification: { type: "BUG_FIX", complexity: "QUICK", workflow: "debug-cycle" },
      autonomous: true,
    });
    const pass = classificationGate({ agent: "developer" }, { cwd: root });
    assert.equal(pass, undefined, "autonomous run with debug-cycle passes the gate");

    writeWorkflowState(root, {
      classification: { type: "BUG_FIX", complexity: "QUICK", workflow: "bug-fix" },
      autonomous: true,
    });
    const blocked = classificationGate({ agent: "developer" }, { cwd: root });
    assert.ok(blocked, "interactive workflow must NOT silently pass for an autonomous run");
    assert.ok(blocked?.reason?.includes("expected 'debug-cycle'"), "block names the autonomous resolution");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("P5 gate: interactive BUG_FIX QUICK keeps the profile-match escape hatch", () => {
  const root = mkdtempSync(join(tmpdir(), "p5-interactive-"));
  try {
    writeWorkflowState(root, {
      classification: { type: "BUG_FIX", complexity: "QUICK", workflow: "bug-fix" },
      autonomous: false,
    });
    assert.equal(classificationGate({ agent: "developer" }, { cwd: root }), undefined, "interactive bug-fix passes");

    writeWorkflowState(root, {
      classification: { type: "BUG_FIX", complexity: "QUICK", workflow: "debug-cycle" },
      autonomous: false,
    });
    const blocked = classificationGate({ agent: "developer" }, { cwd: root });
    assert.ok(blocked, "interactive QUICK BUG_FIX with debug-cycle is still blocked (out of the match table)");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
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
