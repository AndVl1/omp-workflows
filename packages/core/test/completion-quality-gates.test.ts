/**
 * Failing cutover contract for the completion quality-gate rename (T004).
 *
 * Canonical vocabulary (architecture.md §1, command-contract.md "Versioning
 * and Cutover"):
 *   - `dod_and_artifacts`   → `quality_gates_and_artifacts`  (acceptance value)
 *   - `CompletionDodStatus` → `CompletionQualityGateStatus`  (exported type)
 *   - `artifact_refs[].dod_status` → `quality_gate_status`   (persisted field)
 *
 * Contracts under test:
 *   - the public typed control plane accepts ONLY the new acceptance value and
 *     rejects the legacy value (no active alias anywhere in fresh input);
 *   - persisted completion artifact refs carry `quality_gate_status` with the
 *     `met | pending | failed` domain (the `CompletionQualityGateStatus`
 *     type-export itself is proven at typecheck time, not at runtime);
 *   - legacy persisted envelopes migrate exactly once at the persisted-state
 *     boundary, recording provenance and leaving no legacy field behind;
 *   - the migration default intent and the classification prompt vocabulary
 *     carry only the canonical tokens.
 *
 * The legacy names remain accepted ONLY as one deterministic migration input
 * at the persisted-state reader (`normalizePersistedState`).
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  sha256,
  validFeatureWorkspace,
  validImplementationConformance,
  validImplementationHandoff,
} from "./fixtures/specification-fixtures.js";
import {
  buildClassificationPhaseZero,
  migrationCompletionIntent,
  validateTypedControlPlane,
} from "../src/index.js";
import { normalizePersistedState } from "../src/engine/state.js";
import {
  validateFeatureWorkspaceRecord,
  validateImplementationConformance,
  validateImplementationHandoff,
  MAX_HANDOFF_AGGREGATE_BYTES,
  MAX_HANDOFF_ARRAY_ITEMS,
  MAX_HANDOFF_STRING_BYTES,
  MAX_HANDOFF_VALIDATION_DEPTH,
} from "../src/specification/validation.js";
import type { CompletionQualityGateStatus } from "../src/index.js";

const WORK_IDENTITY = {
  run_id: "run-1",
  wave_id: "wave-1",
  slice_id: "slice-1",
  session_id: "session-1",
  workflow: "full-feature",
  stage_id: "implementation",
  stage_cursor: "implementation",
  capability_id: "capability-1",
  capability_epoch: "epoch-1",
  slot_id: "orchestrator",
  task_id: "task-1",
  dispatch_id: "dispatch-1",
  attempt: 1,
  worker_id: "engine",
} as const;

const qualityGateStatusSample: CompletionQualityGateStatus = "met";

function completionEnvelope(artifactRef: Record<string, unknown>): Record<string, unknown> {
  return {
    schema_version: 1,
    identity: { ...WORK_IDENTITY },
    outcome: "succeeded",
    terminal_signal: "workflow_complete",
    artifact_refs: [artifactRef],
    evidence_ref: null,
    conflict_ref: null,
    completed_by: "workflow_complete",
    emitted_at: "2026-08-31T12:00:00.000Z",
  };
}

function typedControlPlaneWithAcceptance(acceptance: string): Record<string, unknown> {
  return {
    completion_intent: {
      mode: "complete_outcome",
      acceptance,
      source: "workflow_policy",
      rationale: "quality gates and artifact evidence are the only generic completion contract",
    },
  };
}

// ── Public cutover: acceptance value ─────────────────────────────────────────

test("typed control plane accepts the quality_gates_and_artifacts acceptance value", () => {
  const result = validateTypedControlPlane(
    typedControlPlaneWithAcceptance("quality_gates_and_artifacts"),
  );
  assert.deepEqual(result, { ok: true });
});

test("typed control plane rejects the legacy dod_and_artifacts value with no active alias", () => {
  const result = validateTypedControlPlane(typedControlPlaneWithAcceptance("dod_and_artifacts"));
  assert.equal(result.ok, false, "the legacy acceptance value must not validate");
  if (result.ok) return;
  assert.ok(
    result.issues.some((issue) => issue.path === "$.completion_intent.acceptance"),
    `expected an acceptance issue, got: ${JSON.stringify(result.issues)}`,
  );
});

test("the migration-sourced completion intent carries only the canonical acceptance token", () => {
  const intent = migrationCompletionIntent();
  assert.equal(intent.source, "migration");
  assert.equal(intent.acceptance, "quality_gates_and_artifacts");
});

test("classification prompt vocabulary names only the canonical acceptance values", () => {
  const phaseZero = buildClassificationPhaseZero();
  assert.ok(phaseZero.includes("quality_gates_and_artifacts"));
  assert.ok(!phaseZero.includes("dod_and_artifacts"), "legacy token must not remain in active prompts");
});

// ── Persisted cutover: quality_gate_status field ─────────────────────────────

test("persisted completion artifact refs accept quality_gate_status", () => {
  const result = validateTypedControlPlane({
    completion_envelope: completionEnvelope({
      artifact_id: "implementation",
      path: "src/feature.ts",
      sha256: sha256("implementation"),
      schema_status: "met",
      quality_gate_status: qualityGateStatusSample,
    }),
  });
  assert.deepEqual(result, { ok: true });
});

test("quality_gate_status keeps the met | pending | failed value domain", () => {
  const result = validateTypedControlPlane({
    completion_envelope: completionEnvelope({
      artifact_id: "implementation",
      path: "src/feature.ts",
      sha256: sha256("implementation"),
      schema_status: "met",
      quality_gate_status: "done",
    }),
  });
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.ok(
    result.issues.some((issue) => issue.path.includes("artifact_refs[0].quality_gate_status")),
    `expected a quality_gate_status domain issue, got: ${JSON.stringify(result.issues)}`,
  );
});

test("persisted completion artifact refs reject the legacy dod_status field on fresh input", () => {
  const result = validateTypedControlPlane({
    completion_envelope: completionEnvelope({
      artifact_id: "implementation",
      path: "src/feature.ts",
      sha256: sha256("implementation"),
      schema_status: "met",
      dod_status: "met",
    }),
  });
  assert.equal(result.ok, false, "the legacy field must not validate as fresh typed input");
  if (result.ok) return;
  assert.ok(
    result.issues.some(
      (issue) => issue.path === "$.completion_envelope.artifact_refs[0].dod_status"
        && issue.message === "unknown field",
    ),
    `expected the canonical dod_status unknown-field issue, got: ${JSON.stringify(result.issues)}`,
  );
});

// ── One deterministic migration at the persisted-state boundary ──────────────

test("legacy persisted dod_status migrates exactly once with recorded provenance", () => {
  const legacyState = {
    completion_envelope: completionEnvelope({
      artifact_id: "implementation",
      path: "src/feature.ts",
      sha256: sha256("implementation"),
      schema_status: "met",
      dod_status: "pending",
    }),
  };
  const rejectionIssues: string[] = [];
  const migrated = normalizePersistedState(legacyState, rejectionIssues) as Record<string, unknown> | null;
  assert.ok(migrated, `legacy envelope must migrate, got issues: ${rejectionIssues.join("; ")}`);
  assert.deepEqual(rejectionIssues, []);

  const envelope = migrated.completion_envelope as Record<string, unknown>;
  const ref = (envelope.artifact_refs as Array<Record<string, unknown>>)[0]!;
  assert.equal(ref.quality_gate_status, "pending", "legacy value maps onto the canonical field");
  assert.equal(ref.dod_status, undefined, "no legacy field may remain after migration");

  const receipt = migrated.migration as Record<string, unknown> | undefined;
  assert.ok(receipt, "migration provenance must be recorded on the migrated state");
  assert.equal(receipt.status, "complete");
  const legacyInputs = receipt.legacy_inputs as string[];
  assert.ok(
    legacyInputs.some((entry) => entry.includes("dod_status")),
    `provenance must name the legacy field, got: ${JSON.stringify(legacyInputs)}`,
  );
});

test("migration is idempotent: re-normalizing the migrated state records no second migration", () => {
  const legacyState = {
    completion_envelope: completionEnvelope({
      artifact_id: "implementation",
      path: "src/feature.ts",
      sha256: sha256("implementation"),
      schema_status: "met",
      dod_status: "met",
    }),
  };
  const migrated = normalizePersistedState(structuredClone(legacyState)) as Record<string, unknown>;
  const replayed = normalizePersistedState(structuredClone(migrated)) as Record<string, unknown> | null;
  assert.ok(replayed, "an already-migrated state must re-normalize cleanly");
  const firstReceipt = migrated.migration as Record<string, unknown>;
  const secondReceipt = replayed.migration as Record<string, unknown>;
  assert.deepEqual(
    secondReceipt,
    firstReceipt,
    "replay must preserve the one durable migration receipt unchanged",
  );
});

test("canonical persisted state with quality_gate_status normalizes without a migration receipt", () => {
  const canonicalState = {
    completion_envelope: completionEnvelope({
      artifact_id: "implementation",
      path: "src/feature.ts",
      sha256: sha256("implementation"),
      schema_status: "met",
      quality_gate_status: "failed",
    }),
  };
  const normalized = normalizePersistedState(canonicalState) as Record<string, unknown> | null;
  assert.ok(normalized, "canonical state must normalize");
  assert.equal(normalized.migration, undefined, "fresh canonical input is not a migration");
});


// ── Specification completion gates ──────────────────────────────────────────

test("a complete implementation handoff passes traceability validation", () => {
  assert.deepEqual(validateImplementationHandoff(validImplementationHandoff()), { ok: true });
});

test("implementation handoff rejects a requirement without a Plan decision", () => {
  const handoff = validImplementationHandoff();
  handoff.decisions = [];
  const result = validateImplementationHandoff(handoff);
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.ok(
    result.issues.some((issue) => issue.includes("SPEC_REQUIREMENT_WITHOUT_DECISION")),
    "missing Plan decision must be reported by the shared traceability check",
  );
});
test("implementation handoff bounds reject hostile depth, width, strings, aggregate size, prototypes, and cycles", () => {
  const cases: Array<{ label: string; mutate: (handoff: ReturnType<typeof validImplementationHandoff>) => void; code: string }> = [
    {
      label: "wide",
      mutate: (handoff) => {
        handoff.tasks = Array.from({ length: MAX_HANDOFF_ARRAY_ITEMS + 1 }, (_, index) => ({
          ...handoff.tasks[0]!,
          task_id: `T-${index}`,
          depends_on: [],
        }));
      },
      code: "SPEC_HANDOFF_COUNT_LIMIT",
    },
    {
      label: "string",
      mutate: (handoff) => { handoff.tasks[0]!.title = "x".repeat(MAX_HANDOFF_STRING_BYTES + 1); },
      code: "SPEC_HANDOFF_STRING_LIMIT",
    },
    {
      label: "aggregate",
      mutate: (handoff) => {
        handoff.scope.in_scope = Array.from({ length: 1_024 }, () => "x".repeat(4_096));
      },
      code: "SPEC_HANDOFF_AGGREGATE_LIMIT",
    },
    {
      label: "deep",
      mutate: (handoff) => {
        let cursor: Record<string, unknown> = handoff as unknown as Record<string, unknown>;
        for (let index = 0; index <= MAX_HANDOFF_VALIDATION_DEPTH; index += 1) {
          const nested: Record<string, unknown> = {};
          cursor.nested = nested;
          cursor = nested;
        }
      },
      code: "SPEC_HANDOFF_DEPTH_LIMIT",
    },
    {
      label: "prototype",
      mutate: (handoff) => { Object.setPrototypeOf(handoff, { forged: true }); },
      code: "SPEC_HANDOFF_PROTOTYPE",
    },
    {
      label: "cycle",
      mutate: (handoff) => { handoff.tasks[0]!.depends_on = ["T-1"]; },
      code: "SPEC_TASK_DEPENDENCY_CYCLE",
    },
  ];
  for (const testCase of cases) {
    const handoff = validImplementationHandoff();
    testCase.mutate(handoff);
    let result: ReturnType<typeof validateImplementationHandoff>;
    assert.doesNotThrow(() => { result = validateImplementationHandoff(handoff); }, `${testCase.label} must not throw`);
    assert.equal(result!.ok, false, `${testCase.label} must fail closed`);
    if (!result!.ok) assert.ok(result!.issues.some((issue) => issue.includes(testCase.code)), `${testCase.label} issue must be typed: ${result!.issues.join("; ")}`);
  }
});

test("passing conformance requires a non-empty matrix and quality-gate set", () => {
  for (const field of ["entries", "quality_gate_results"] as const) {
    const conformance = validImplementationConformance();
    conformance[field] = [];
    const result = validateImplementationConformance(conformance);
    assert.equal(result.ok, false, `empty ${field} must fail closed`);
    if (result.ok) continue;
    assert.ok(
      result.issues.some((issue) => issue.includes(`$.${field} must be non-empty`)),
      `expected a non-empty ${field} issue, got: ${JSON.stringify(result.issues)}`,
    );
  }
});

test("passing conformance rejects blocked or changed-intent matrix rows", () => {
  for (const status of ["blocked", "changed_intent"] as const) {
    const conformance = validImplementationConformance();
    conformance.entries[0]!.status = status;
    const result = validateImplementationConformance(conformance);
    assert.equal(result.ok, false, `${status} row must prevent overall pass`);
    if (result.ok) continue;
    assert.ok(
      result.issues.some((issue) => issue === "$.entries must all pass when overall_status is pass"),
      `expected an all-pass matrix issue, got: ${JSON.stringify(result.issues)}`,
    );
  }
});

test("passing conformance rejects a failed quality gate", () => {
  const conformance = validImplementationConformance();
  conformance.quality_gate_results[0]!.status = "fail";
  const result = validateImplementationConformance(conformance);
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.ok(result.issues.includes("$.quality_gate_results must all pass when overall_status is pass"));
});

type WorkspaceFixture = ReturnType<typeof validFeatureWorkspace>;

const inconsistentPhaseCases: Array<[
  string,
  (workspace: WorkspaceFixture) => void,
]> = [
  ["awaiting approval without a current document", (workspace) => {
    workspace.phases[0]!.current_version = null;
  }],
  ["awaiting approval without current validation", (workspace) => {
    workspace.phases[0]!.validation_ref = null;
  }],
  ["approved without an approved version", (workspace) => {
    const phase = workspace.phases[0]!;
    phase.status = "approved";
    phase.approved_version = null;
    phase.checkpoint_ref = "checkpoint.specify.v1";
  }],
  ["approved version different from the current version", (workspace) => {
    const phase = workspace.phases[0]!;
    phase.status = "approved";
    phase.approved_version = 2;
    phase.checkpoint_ref = "checkpoint.specify.v2";
  }],
  ["approved without a checkpoint", (workspace) => {
    const phase = workspace.phases[0]!;
    phase.status = "approved";
    phase.approved_version = phase.current_version;
    phase.checkpoint_ref = null;
  }],
  ["not-started phase carrying a current document", (workspace) => {
    workspace.phases[1]!.current_version = 1;
  }],
];

for (const [name, mutate] of inconsistentPhaseCases) {
  test(`workspace phase records reject ${name}`, () => {
    const workspace = validFeatureWorkspace();
    mutate(workspace);
    const result = validateFeatureWorkspaceRecord(workspace);
    assert.equal(result.ok, false, name);
  });
}
