/**
 * Shared expression semantics (gate / skip_if / until):
 *   - every shipped profile expression parses (load-time coverage),
 *   - the previously-broken shipped expressions now evaluate correctly:
 *     full-feature `qa_tests` PASS/CONDITIONAL gate, `review_fixes` artifact
 *     debug-cycle `until` (verdict == PASS),
 *   - unsupported syntax fails closed with diagnostics (never silent false),
 *   - OR evaluation is three-valued: a satisfied fallback term keeps the
 *     expression passing when the artifact it references is missing.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadAllProfiles, loadProfile } from "../src/engine/profile.js";
import { parseExpression, evaluatePredicate, validateProfileExpressions, deepEqual } from "../src/engine/predicate.js";
import type { ScopeFlags } from "../src/engine/scope.js";
import type { TeamState } from "../src/engine/types.js";

const FLAGS: ScopeFlags = { scope: [], has_security: false, has_infra: false, has_ui: false, has_runtime: false, dev_agent: null };
const RUNTIME_FLAGS: ScopeFlags = { ...FLAGS, has_runtime: true, scope: ["backend-kotlin"] };
const SECURITY_FLAGS: ScopeFlags = { ...FLAGS, has_security: true };

function state(overrides: Partial<TeamState> = {}): TeamState {
  return {
    schema: 1,
    branch: "feat/x",
    classification: { type: "FEATURE", complexity: "QUICK", confidence: "HIGH", autonomous: false, workflow: "lightweight" },
    task: "t",
    workflow_override: false,
    issue: null,
    stage_cursor: "code_review",
    stages: [{ id: "code_review", status: "in_progress" }],
    artifacts: {},
    pause: { kind: "none", reason: "" },
    updated_at: new Date().toISOString(),
    ...overrides,
  };
}

test("predicate: every shipped gate/skip_if/until/conditional expression parses", () => {
  const profiles = loadAllProfiles();
  assert.ok(profiles.length > 0);
  for (const profile of profiles) {
    const diagnostics = validateProfileExpressions(profile);
    assert.deepEqual(diagnostics, [], `shipped profile '${profile.name}' must have fully supported expressions: ${diagnostics.join("; ")}`);
  }
});

test("predicate: full-feature qa_tests gate accepts PASS/CONDITIONAL, rejects FAIL, and preserves skipped fallback", () => {
  const root = mkdtempSync(join(tmpdir(), "pred-or-"));
  try {
    const artifactsDir = join(root, "artifacts");
    mkdirSync(artifactsDir, { recursive: true });
    const stage = { id: "qa_tests", title: "QA", type: "single" as const, role: "qa", produces: "qa_tests", consumes: ["manual_qa"] };
    const gate = "manual_qa.verdict != FAIL || !scope.has_runtime";

    for (const profileName of ["full-feature", "standard"]) {
      const profile = loadProfile(profileName);
      assert.ok(profile);
      const qaTests = profile.stages.find((candidate) => candidate.id === "qa_tests");
      assert.equal(qaTests?.gate, gate, `${profileName} qa_tests gate must preserve conditional runtime semantics`);
    }

    // Verdict path: manual_qa PASS.
    writeFileSync(join(artifactsDir, "manual_qa.json"), JSON.stringify({ verdict: "PASS", evidence: ["ran"] }));
    assert.deepEqual(
      evaluatePredicate(gate, { flags: RUNTIME_FLAGS, artifactsDir, state: state(), stage }),
      { ok: true, value: true },
    );

    // Conditional path: deterministic/runtime evidence exists, but a required
    // live criterion is unavailable behind an explicit blocker.
    writeFileSync(join(artifactsDir, "manual_qa.json"), JSON.stringify({
      verdict: "CONDITIONAL",
      evidence: ["deterministic checks passed"],
      blocked_prerequisites: ["live provider credential unavailable"],
    }));
    assert.deepEqual(
      evaluatePredicate(gate, { flags: RUNTIME_FLAGS, artifactsDir, state: state(), stage }),
      { ok: true, value: true },
      "CONDITIONAL is accepted for runtime-backed deterministic QA",
    );

    // Fallback path: manual_qa skipped (artifact absent) and no runtime scope.
    rmSync(join(artifactsDir, "manual_qa.json"));
    assert.deepEqual(
      evaluatePredicate(gate, { flags: FLAGS, artifactsDir, state: state(), stage }),
      { ok: true, value: true },
      "OR fallback term keeps the expression passing when the artifact is missing",
    );

    // Blocking path: manual_qa FAIL and runtime present.
    writeFileSync(join(artifactsDir, "manual_qa.json"), JSON.stringify({ verdict: "FAIL", evidence: ["broke"] }));
    assert.deepEqual(
      evaluatePredicate(gate, { flags: RUNTIME_FLAGS, artifactsDir, state: state(), stage }),
      { ok: true, value: false },
    );

    // Missing artifact with no satisfied fallback fails closed (diagnostic).
    rmSync(join(artifactsDir, "manual_qa.json"));
    const blocked = evaluatePredicate(gate, { flags: RUNTIME_FLAGS, artifactsDir, state: state(), stage });
    assert.equal(blocked.ok, false);
    if (!blocked.ok) assert.match(blocked.error, /manual_qa/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("predicate: review_fixes artifact skip_if (review.findings == []) skips when empty and does not skip when non-empty", () => {
  const root = mkdtempSync(join(tmpdir(), "pred-skip-"));
  try {
    const artifactsDir = join(root, "artifacts");
    mkdirSync(artifactsDir, { recursive: true });
    const stage = { id: "review_fixes", title: "Fixes", type: "single" as const, role: "dev", consumes: ["review"] };
    writeFileSync(join(artifactsDir, "review.json"), JSON.stringify({ verdict: "approve", findings: [] }));
    assert.deepEqual(
      evaluatePredicate("review.findings == []", { flags: FLAGS, artifactsDir, state: state(), stage }),
      { ok: true, value: true },
      "empty findings must skip review_fixes",
    );
    writeFileSync(join(artifactsDir, "review.json"), JSON.stringify({ verdict: "needs_changes", findings: [{ title: "x", severity: "HIGH", confidence: 90, zone: "backend-kotlin" }] }));
    assert.deepEqual(
      evaluatePredicate("review.findings == []", { flags: FLAGS, artifactsDir, state: state(), stage }),
      { ok: true, value: false },
      "non-empty findings must not skip",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("predicate: debug-cycle loop until (verdict == PASS) resolves the implicit produced artifact", () => {
  const root = mkdtempSync(join(tmpdir(), "pred-until-"));
  try {
    const artifactsDir = join(root, "artifacts");
    mkdirSync(artifactsDir, { recursive: true });
    const profile = loadProfile("debug-cycle");
    assert.ok(profile);
    const verify = profile.stages.find((stage) => stage.id === "verify");
    assert.ok(verify?.loop);
    writeFileSync(join(artifactsDir, "debug.json"), JSON.stringify({ verdict: "FAIL", iterations: 1 }));
    assert.deepEqual(
      evaluatePredicate(verify!.loop!.until, { flags: FLAGS, artifactsDir, state: state(), stage: verify! }),
      { ok: true, value: false },
      "FAIL verdict keeps the loop running",
    );
    writeFileSync(join(artifactsDir, "debug.json"), JSON.stringify({ verdict: "PASS", iterations: 2 }));
    assert.deepEqual(
      evaluatePredicate(verify!.loop!.until, { flags: FLAGS, artifactsDir, state: state(), stage: verify! }),
      { ok: true, value: true },
      "PASS verdict exits the loop",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("predicate: qa_tests verdict gate falls back to a consumed artifact when the produced one has no verdict", () => {
  const root = mkdtempSync(join(tmpdir(), "pred-consumed-"));
  try {
    const artifactsDir = join(root, "artifacts");
    mkdirSync(artifactsDir, { recursive: true });
    const profile = loadProfile("debug-cycle");
    assert.ok(profile);
    const qaTests = profile.stages.find((stage) => stage.id === "qa_tests");
    assert.ok(qaTests);
    // qa_tests.json has no verdict field; debug.json (consumed) does.
    writeFileSync(join(artifactsDir, "qa_tests.json"), JSON.stringify({ tests_added: ["t"], build_status: "pass" }));
    writeFileSync(join(artifactsDir, "debug.json"), JSON.stringify({ verdict: "PASS", iterations: 1 }));
    assert.deepEqual(
      evaluatePredicate(qaTests!.gate!, { flags: FLAGS, artifactsDir, state: state(), stage: qaTests! }),
      { ok: true, value: true },
      "implicit verdict resolution considers consumed artifacts",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("predicate: scope flag and negation expressions", () => {
  const root = mkdtempSync(join(tmpdir(), "pred-flag-"));
  try {
    const artifactsDir = join(root, "artifacts");
    mkdirSync(artifactsDir, { recursive: true });
    assert.deepEqual(evaluatePredicate("scope.has_runtime", { flags: RUNTIME_FLAGS, artifactsDir, state: state() }), { ok: true, value: true });
    assert.deepEqual(evaluatePredicate("!scope.has_runtime", { flags: FLAGS, artifactsDir, state: state() }), { ok: true, value: true });
    assert.deepEqual(evaluatePredicate("scope.has_security", { flags: SECURITY_FLAGS, artifactsDir, state: state() }), { ok: true, value: true });
    assert.deepEqual(evaluatePredicate("!scope.has_security", { flags: SECURITY_FLAGS, artifactsDir, state: state() }), { ok: true, value: false });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("predicate: named gates resolve through the caller's resolver and fail closed when unknown", () => {
  const root = mkdtempSync(join(tmpdir(), "pred-named-"));
  try {
    const artifactsDir = join(root, "artifacts");
    mkdirSync(artifactsDir, { recursive: true });
    const namedGate = (name: string) => (name === "dod_complete" ? null : name === "branch_created" ? "branch missing" : undefined);
    assert.deepEqual(
      evaluatePredicate("dod_complete", { flags: FLAGS, artifactsDir, state: state(), namedGate }),
      { ok: true, value: true },
    );
    assert.deepEqual(
      evaluatePredicate("branch_created", { flags: FLAGS, artifactsDir, state: state(), namedGate }),
      { ok: true, value: false, detail: "branch missing" },
      "an unsatisfied named gate reports its concrete failure reason",
    );
    assert.deepEqual(
      evaluatePredicate("!branch_created", { flags: FLAGS, artifactsDir, state: state(), namedGate }),
      { ok: true, value: true },
      "a failing named gate satisfies its negation",
    );
    assert.deepEqual(
      evaluatePredicate("!dod_complete", { flags: FLAGS, artifactsDir, state: state(), namedGate }),
      { ok: true, value: false },
      "a holding named gate fails its negation with no reason to surface",
    );
    const unsupported = evaluatePredicate("mystery_gate", { flags: FLAGS, artifactsDir, state: state(), namedGate });
    assert.equal(unsupported.ok, false);
    if (!unsupported.ok) assert.match(unsupported.error, /unsupported predicate/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("predicate: unsupported syntax fails closed with diagnostics, never silent false", () => {
  const root = mkdtempSync(join(tmpdir(), "pred-unsupported-"));
  try {
    const artifactsDir = join(root, "artifacts");
    mkdirSync(artifactsDir, { recursive: true });
    for (const bad of ["(a || b)", "scope.unknown_flag", "review.findings > 3", "1 + 1", "verdict == [1,", "a && b"]) {
      const parsed = parseExpression(bad);
      assert.equal(parsed.ok, false, `'${bad}' must not parse`);
      assert.match(parsed.ok ? "" : parsed.error, /./, "diagnostic text is present");
      const evaluated = evaluatePredicate(bad, { flags: FLAGS, artifactsDir, state: state() });
      assert.equal(evaluated.ok, false, `'${bad}' must not silently evaluate to false`);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("predicate: value comparisons support arrays, strings, numbers, booleans, null", () => {
  assert.equal(deepEqual([1, 2], [1, 2]), true);
  assert.equal(deepEqual({ a: 1 }, { a: 1 }), true);
  assert.equal(deepEqual({ a: 1 }, { a: 2 }), false);
  const parsed = parseExpression("manual_qa.verdict == PASS");
  assert.equal(parsed.ok, true);
  if (parsed.ok) {
    assert.deepEqual(parsed.ast.terms, [{ kind: "compare", artifact: "manual_qa", field: "verdict", op: "==", value: "PASS", negated: false }]);
  }
  const count = parseExpression("debug.iterations == 3");
  assert.equal(count.ok, true);
});
