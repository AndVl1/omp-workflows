/**
 * Shared expression semantics (gate / skip_if / until):
 *   - every shipped profile expression parses (load-time coverage),
 *   - the independent `qa_reported_pass` gate reads only canonical
 *     `qa_tests.build_status`, while `review_fixes` artifact skip_if and
 *     debug-cycle `until` continue to use their declared artifact fields,
 *   - unsupported syntax fails closed with diagnostics (never silent false),
 *   - OR evaluation is three-valued: a satisfied fallback term keeps the
 *     expression passing when the artifact it references is missing.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadAllProfiles, loadProfile } from "../src/engine/profile.js";
import { parseExpression, evaluatePredicate, validateProfileExpressions, deepEqual, type PredicateContext } from "../src/engine/predicate.js";
import { PinnedProjectRoot } from "../src/specification/pinned-root.js";
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

function evaluatePinned(
  expression: string,
  root: string,
  artifactsDir: string,
  context: Omit<PredicateContext, "artifactsDir" | "pinnedRoot" | "artifactsDirRelative">,
): ReturnType<typeof evaluatePredicate> {
  const pinnedRoot = PinnedProjectRoot.open(root);
  assert.ok(pinnedRoot, "predicate fixture root must be pinnable");
  if (!pinnedRoot) return { ok: false, error: "predicate fixture root cannot be pinned" };
  try {
    const artifactsDirRelative = pinnedRoot.relativePath(artifactsDir);
    assert.equal(artifactsDirRelative, "artifacts", "predicate fixture artifacts must be root-relative");
    if (artifactsDirRelative === null) return { ok: false, error: "predicate artifacts escaped the pinned root" };
    return evaluatePredicate(expression, { ...context, artifactsDir, pinnedRoot, artifactsDirRelative });
  } finally {
    pinnedRoot.close();
  }
}

test("predicate: every shipped gate/skip_if/until/conditional expression parses", () => {
  const profiles = loadAllProfiles();
  assert.ok(profiles.length > 0);
  for (const profile of profiles) {
    const diagnostics = validateProfileExpressions(profile);
    assert.deepEqual(diagnostics, [], `shipped profile '${profile.name}' must have fully supported expressions: ${diagnostics.join("; ")}`);
  }
});

test("predicate: qa_reported_pass consumes only the canonical qa_tests artifact", () => {
  const root = mkdtempSync(join(tmpdir(), "pred-qa-report-"));
  try {
    const artifactsDir = join(root, "artifacts");
    mkdirSync(artifactsDir, { recursive: true });
    const stateValue = state();
    const qaGate = (name: string) => {
      if (name !== "qa_reported_pass") return undefined;
      let report: Record<string, unknown>;
      try {
        report = JSON.parse(readFileSync(join(artifactsDir, "qa_tests.json"), "utf8")) as Record<string, unknown>;
      } catch {
        return "canonical qa_tests artifact is missing or malformed";
      }
      return report.build_status === "pass"
        ? null
        : "qa_reported_pass requires qa_tests.build_status=pass";
    };

    for (const profileName of ["full-feature", "standard", "lightweight", "bug-fix", "debug-cycle", "emergency"]) {
      const profile = loadProfile(profileName);
      assert.ok(profile);
      const qaTests = profile.stages.find((candidate) => candidate.id === "qa_tests");
      assert.equal(qaTests?.gate, "qa_reported_pass", `${profileName} must use the independent QA gate`);
      assert.ok(profile.stages.find((candidate) => candidate.id === "summary")?.consumes?.includes("qa_tests"), `${profileName} summary must consume qa_tests`);
    }

    writeFileSync(join(artifactsDir, "manual_qa.json"), JSON.stringify({ verdict: "PASS", evidence: ["worker report only"] }));
    writeFileSync(join(artifactsDir, "debug.json"), JSON.stringify({ verdict: "PASS", iterations: 1 }));
    writeFileSync(join(artifactsDir, "qa_tests.json"), JSON.stringify({ tests_added: ["regression"], build_status: "pass" }));
    assert.deepEqual(
      evaluatePredicate("qa_reported_pass", { flags: RUNTIME_FLAGS, artifactsDir, state: stateValue, namedGate: qaGate }),
      { ok: true, value: true },
    );

    for (const status of ["fail", "n/a"] as const) {
      writeFileSync(join(artifactsDir, "qa_tests.json"), JSON.stringify({ tests_added: ["regression"], build_status: status }));
      assert.deepEqual(
        evaluatePredicate("qa_reported_pass", { flags: RUNTIME_FLAGS, artifactsDir, state: stateValue, namedGate: qaGate }),
        { ok: true, value: false },
        `${status} QA report must block`,
      );
    }

    rmSync(join(artifactsDir, "qa_tests.json"));
    const missing = evaluatePredicate("qa_reported_pass", { flags: RUNTIME_FLAGS, artifactsDir, state: stateValue, namedGate: qaGate });
    assert.deepEqual(missing, { ok: true, value: false }, "missing QA report must block");
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
      evaluatePinned("review.findings == []", root, artifactsDir, { flags: FLAGS, state: state(), stage }),
      { ok: true, value: true },
      "empty findings must skip review_fixes",
    );
    writeFileSync(join(artifactsDir, "review.json"), JSON.stringify({ verdict: "needs_changes", findings: [{ title: "x", severity: "HIGH", confidence: 90, zone: "backend-kotlin" }] }));
    assert.deepEqual(
      evaluatePinned("review.findings == []", root, artifactsDir, { flags: FLAGS, state: state(), stage }),
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
      evaluatePinned(verify!.loop!.until, root, artifactsDir, { flags: FLAGS, state: state(), stage: verify! }),
      { ok: true, value: false },
      "FAIL verdict keeps the loop running",
    );
    writeFileSync(join(artifactsDir, "debug.json"), JSON.stringify({ verdict: "PASS", iterations: 2 }));
    assert.deepEqual(
      evaluatePinned(verify!.loop!.until, root, artifactsDir, { flags: FLAGS, state: state(), stage: verify! }),
      { ok: true, value: true },
      "PASS verdict exits the loop",
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
      { ok: true, value: false },
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
test("predicate: deepEqual is iterative, bounded, and prototype-safe", () => {
  let boundedLeft: unknown = "leaf";
  let boundedRight: unknown = "leaf";
  for (let depth = 0; depth < 64; depth += 1) {
    boundedLeft = { next: boundedLeft };
    boundedRight = { next: boundedRight };
  }
  assert.equal(deepEqual(boundedLeft, boundedRight), true, "values at the shared depth bound remain comparable");
  boundedLeft = { next: boundedLeft };
  boundedRight = { next: boundedRight };
  assert.equal(deepEqual(boundedLeft, boundedRight), false, "values past the depth bound fail closed");

  const inherited = Object.create({ prototypeOnly: true }) as Record<string, unknown>;
  inherited.value = 1;
  assert.equal(deepEqual(inherited, { value: 1 }), false, "different prototypes are never treated as equal");

  const leftCycle: Record<string, unknown> = {};
  const rightCycle: Record<string, unknown> = {};
  leftCycle.self = leftCycle;
  rightCycle.self = rightCycle;
  assert.equal(deepEqual(leftCycle, rightCycle), true, "isomorphic cycles terminate without recursion");

  const largeLeft = Array.from({ length: 12_000 }, (_, index) => index);
  const largeRight = Array.from({ length: 12_000 }, (_, index) => index);
  largeRight[11_999] = -1;
  assert.equal(deepEqual(largeLeft, largeRight), false, "large unequal values terminate with a false result");
});
test("predicate: over-budget artifact values fail closed before comparison", () => {
  const root = mkdtempSync(join(tmpdir(), "pred-structure-"));
  try {
    const artifactsDir = join(root, "artifacts");
    mkdirSync(artifactsDir, { recursive: true });
    let deep: unknown = { iterations: 1 };
    for (let depth = 0; depth < 65; depth += 1) deep = { next: deep };
    writeFileSync(join(artifactsDir, "debug.json"), JSON.stringify(deep));
    const result = evaluatePredicate("debug.iterations == 1", { flags: FLAGS, artifactsDir, state: state() });
    assert.equal(result.ok, false);
    if (!result.ok) assert.match(result.error, /cannot be evaluated safely: artifact structure limit exceeded/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
