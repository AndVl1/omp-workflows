/**
 * Failing contract for targeted specification staleness (T039).
 *
 * Canonical API under contract (architecture.md §1–§3, §7, data-model.md
 * "Phase Status" + invariants 6/15, plan.md "Constitution impact propagation"
 * and "Templates and Language", quickstart.md revision scenarios):
 *
 *   `packages/core/src/specification/workspace.ts` (T043)
 *     - propagateUpstreamRevision(workspace, revision)
 *         → { workspace, stale_artifacts }  — a revised upstream artifact
 *           re-enters generation while its prior approval stays attributable
 *           to the replaced version; every downstream phase bound to the old
 *           version is marked stale with a typed reason.
 *     - applyManualEdits(workspace, revalidation, reason)
 *         → { workspace, stale_artifacts }  — hash mismatches reported by
 *           revalidateMaterializedDocuments stale the edited version and its
 *           dependants; a fully matching revalidation changes nothing.
 *     - applyLanguageChange(workspace, language) /
 *       applyTemplateChange(workspace, templateSet)
 *         → { workspace, stale_artifacts }  — a post-approval language or
 *           template-set change stales content-bearing approvals and leaves
 *           phases without materialized content untouched; rebinding the
 *           identical selection is a no-op.
 *     - applyHandoffStaleness(handoff, staleArtifactIds)
 *         → { handoff, stale }  — a handoff bound to stale artifact versions
 *           is marked `stale` (never `ready`) while unaffected handoffs are
 *           preserved; marking is idempotent and keeps the record valid.
 *
 *   `packages/core/src/specification/validation.ts` (T044)
 *     - blockingOutcome(result)  — the blocking projection: located
 *       violations, violated criteria, remediation commands, the approval
 *       proof, and the first valid next action. A failed validation exposes
 *       no approval proof; only a passing validation bound to the artifact
 *       version authorizes a checkpoint.
 *
 *   Closed wave-001 contracts consumed as-is: `applyConstitutionImpact` and
 *   `dependencyClosure` (targeted constitution staleness), the strict
 *   `validateFeatureWorkspaceRecord` / `validateImplementationHandoff`
 *   oracles, `nextActionForWorkspace`, and the materializer
 *   (`materializeFeatureDocuments`, `revalidateMaterializedDocuments`).
 *
 * Behavioral contracts pinned here (T039):
 *   - invalid artifacts block: a failed validation yields located, remediated
 *     violations, no approval proof, and a remediation next action; no
 *     checkpoint can open without a current passing validation reference;
 *   - upstream revision propagation: exactly the dependency closure goes
 *     stale with a typed reason; approvals stay attributable to their exact
 *     versions; replay is idempotent; invalid revisions fail closed;
 *   - manual readable edits: detected hash mismatches stale the edited
 *     version and its dependants; matching documents never stale anything;
 *   - language/template drift: content-bearing approvals stale, empty phases
 *     are preserved, identical rebinds are no-ops;
 *   - targeted constitution staleness: only the dependency closure is marked,
 *     unaffected approvals are preserved, no-impact evidence changes nothing;
 *   - stale approvals and handoffs authorize no dispatch: the workspace next
 *     action is remediation (never a checkpoint), the handoff cannot stay
 *     ready, and staleness survives a durable session boundary.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  FIXED_FEATURE_ID,
  FIXED_NOW,
  bindFeatureWorkspaceToRoot,
  sha256,
  specPreparationProfileHash,
  validConstitutionBinding,
  validFeatureWorkspace,
  validImplementationHandoff,
} from "./fixtures/specification-fixtures.js";
import {
  applyConstitutionImpact,
  applyHandoffStaleness,
  applyLanguageChange,
  applyManualEdits,
  applyTemplateChange,
  createFeatureWorkspace,
  captureWorkspaceRoot,
  persistFeatureWorkspace,
  propagateUpstreamRevision,
  resolveFeatureWorkspace,
} from "../src/specification/workspace.js";
import {
  materializeFeatureDocuments,
  revalidateMaterializedDocuments,
  type RevalidateOutcomeValue,
} from "../src/specification/materialize.js";
import { readPinnedCurrentConstitution } from "../src/specification/constitution-identities.js";
import { ensureProjectConstitution } from "../src/specification/prerequisite.js";
import { dependencyClosure } from "../src/specification/constitution-impact.js";
import {
  blockingOutcome,
  digestOf,
  nextActionForWorkspace,
  validateFeatureWorkspaceRecord,
  validateImplementationHandoff,
} from "../src/specification/validation.js";
import type {
  ConstitutionArtifactImpactResult,
  FeatureWorkspace,
  LanguageSelection,
  PhaseValidationResult,
  TemplateSelection,
  WorkspacePhaseRecord,
  WorkspaceStatus,
  WorkspaceUpstreamVersion,
} from "../src/specification/types.js";

// ── Shared fixtures ──────────────────────────────────────────────────────────

const RUN_KEY = "run-staleness-1";
const SPECIFY_V1_HASH = sha256("specify.v1");
const PLAN_V1_HASH = sha256("plan.v1");
test("workspace phase upstream bindings enforce exact predecessor sets, order, uniqueness, and safe versions", () => {
  const validCases: ReadonlyArray<readonly [WorkspacePhaseRecord["phase"], WorkspaceUpstreamVersion[]]> = [
    ["specify", []],
    ["plan", [{ phase: "specify", version: 1, hash: SPECIFY_V1_HASH }]],
    ["tasks", [
      { phase: "specify", version: 1, hash: SPECIFY_V1_HASH },
      { phase: "plan", version: 1, hash: PLAN_V1_HASH },
    ]],
  ];
  for (const [phaseName, upstream] of validCases) {
    const workspace = contentGraphWorkspace();
    phaseOf(workspace, phaseName).upstream_versions = upstream;
    assert.equal(validateFeatureWorkspaceRecord(workspace).ok, true, `${phaseName} exact upstream binding is valid`);
  }

  const invalidCases: ReadonlyArray<readonly [string, WorkspacePhaseRecord["phase"], WorkspaceUpstreamVersion[]]> = [
    ["zero entries", "plan", []],
    ["max plus one", "specify", [
      { phase: "specify", version: 1, hash: SPECIFY_V1_HASH },
      { phase: "specify", version: 2, hash: SPECIFY_V1_HASH },
      { phase: "specify", version: 3, hash: SPECIFY_V1_HASH },
    ]],
    ["duplicate phase", "tasks", [
      { phase: "specify", version: 1, hash: SPECIFY_V1_HASH },
      { phase: "specify", version: 1, hash: SPECIFY_V1_HASH },
    ]],
    ["wrong phase", "plan", [{ phase: "tasks", version: 1, hash: PLAN_V1_HASH }]],
    ["wrong order", "tasks", [
      { phase: "plan", version: 1, hash: PLAN_V1_HASH },
      { phase: "specify", version: 1, hash: SPECIFY_V1_HASH },
    ]],
    ["unsafe version", "plan", [{ phase: "specify", version: Number.MAX_SAFE_INTEGER + 1, hash: SPECIFY_V1_HASH }]],
    ["strict entry keys", "plan", [{ phase: "specify", version: 1, hash: SPECIFY_V1_HASH, forged: true } as WorkspaceUpstreamVersion]],
  ];
  for (const [label, phaseName, upstream] of invalidCases) {
    const workspace = contentGraphWorkspace();
    phaseOf(workspace, phaseName).upstream_versions = upstream;
    assert.equal(validateFeatureWorkspaceRecord(workspace).ok, false, `${label} must fail closed`);
  }

  const huge = contentGraphWorkspace();
  phaseOf(huge, "tasks").upstream_versions = Array.from({ length: 4096 }, () => ({ phase: "specify", version: 1, hash: SPECIFY_V1_HASH }));
  const hugeResult = validateFeatureWorkspaceRecord(huge);
  assert.equal(hugeResult.ok, false, "huge upstream arrays must fail before per-entry processing");
});

function phaseRecord(phase: WorkspacePhaseRecord["phase"], overrides: Partial<WorkspacePhaseRecord> = {}): WorkspacePhaseRecord {
  return {
    phase,
    status: "not_started",
    current_version: null,
    approved_version: null,
    validation_ref: null,
    checkpoint_ref: null,
    upstream_versions: [],
    stale_reason: null,
    last_feedback: null,
    ...overrides,
  };
}

/** Specify approved v1, Plan approved v1, Tasks awaiting approval v1. */
function contentGraphWorkspace(options: { status?: WorkspaceStatus } = {}): FeatureWorkspace {
  const workspace = validFeatureWorkspace({ withApprovedSpecify: true, status: options.status ?? "in_progress" });
  workspace.phases = [
    phaseRecord("specify", {
      status: "approved",
      current_version: 1,
      approved_version: 1,
      validation_ref: "validation.specify.v1",
      checkpoint_ref: "checkpoint.specify.v1",
    }),
    phaseRecord("plan", {
      status: "approved",
      current_version: 1,
      approved_version: 1,
      validation_ref: "validation.plan.v1",
      checkpoint_ref: "checkpoint.plan.v1",
      upstream_versions: [{ phase: "specify", version: 1, hash: SPECIFY_V1_HASH }],
    }),
    phaseRecord("tasks", {
      status: "awaiting_approval",
      current_version: 1,
      validation_ref: "validation.tasks.v1",
      upstream_versions: [
        { phase: "specify", version: 1, hash: SPECIFY_V1_HASH },
        { phase: "plan", version: 1, hash: PLAN_V1_HASH },
      ],
    }),
  ];
  return workspace;
}

/** Specify approved v1, Plan awaiting approval v1, Tasks not started. */
function awaitingPlanWorkspace(): FeatureWorkspace {
  const workspace = validFeatureWorkspace({ withApprovedSpecify: true });
  workspace.phases = [
    phaseRecord("specify", {
      status: "approved",
      current_version: 1,
      approved_version: 1,
      validation_ref: "validation.specify.v1",
      checkpoint_ref: "checkpoint.specify.v1",
    }),
    phaseRecord("plan", {
      status: "awaiting_approval",
      current_version: 1,
      validation_ref: "validation.plan.v1",
      upstream_versions: [{ phase: "specify", version: 1, hash: SPECIFY_V1_HASH }],
    }),
    phaseRecord("tasks"),
  ];
  return workspace;
}

function phaseOf(workspace: FeatureWorkspace, phase: WorkspacePhaseRecord["phase"]): WorkspacePhaseRecord {
  const record = workspace.phases.find((entry) => entry.phase === phase);
  assert.ok(record, `workspace carries a ${phase} phase record`);
  return record!;
}

interface StalenessProject {
  root: string;
  runKey: string;
  created: FeatureWorkspace;
  cleanup(): void;
}

function stalenessProject(prefix: string): StalenessProject {
  const root = mkdtempSync(join(tmpdir(), prefix));
  const created = createFeatureWorkspace(root, {
    feature_id: FIXED_FEATURE_ID,
    display_name: "Staleness Contract",
    run_key: RUN_KEY,
    profile_name: "spec-preparation",
    profile_hash: specPreparationProfileHash(),
  });
  if (!created.ok) {
    rmSync(root, { recursive: true, force: true });
    throw new Error(`fixture workspace creation failed: ${created.error}`);
  }
  writeFileSync(join(root, "CONSTITUTION.md"), "# Project Constitution v1.0.0\n\n## I. Quality\n\nShip tested work.\n", "utf8");
  const constitution = ensureProjectConstitution(root, { origin_kind: "native_direct", origin_run_key: RUN_KEY, origin_stage: "specify" }, { feature_id: FIXED_FEATURE_ID });
  if (!constitution.ok || !constitution.value.binding) {
    rmSync(root, { recursive: true, force: true });
    throw new Error(`fixture constitution prerequisite failed: ${constitution.ok ? "binding unavailable" : constitution.error}`);
  }
  const bound = resolveFeatureWorkspace(root, { feature_id: FIXED_FEATURE_ID, run_key: RUN_KEY });
  if (!bound.ok) {
    rmSync(root, { recursive: true, force: true });
    throw new Error(`fixture constitution workspace binding failed: ${bound.error}`);
  }
  return { root, runKey: RUN_KEY, created: bound.value, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

function validationRecord(phase: WorkspacePhaseRecord["phase"], status: "pass" | "fail"): PhaseValidationResult {
  return {
    validation_id: `validation.${phase}.v1`,
    phase,
    artifact_version: `${phase}.v1`,
    status,
    checks: [
      {
        check_id: "mandatory_sections",
        status: status === "pass" ? "pass" : "fail",
        evidence: status === "pass" ? "all mandatory sections are present" : "the mandatory '## Non-Goals' section is missing",
        remediation: status === "pass" ? null : "restore the '## Non-Goals' section",
      },
    ],
    blocking_findings: status === "pass" ? [] : [
      {
        code: "SPEC_VALIDATE_SECTIONS_MISSING",
        severity: "blocking",
        subject_id: "spec.md#non-goals",
        message: "the mandatory Non-Goals section is missing",
        evidence_refs: ["specs/feature-one/spec.md"],
        remediation: "restore the '## Non-Goals' section before revalidation",
      },
    ],
    warnings: [],
    constitution: {
      binding: validConstitutionBinding(),
      principles: [{ principle_id: "quality", status: "pass", evidence: "gates recorded" }],
    },
    traceability_summary: null,
    validator_version: "specification-validation@1",
    validated_at: FIXED_NOW,
  };
}

// ── Invalid artifacts block (T044) ───────────────────────────────────────────

test("a failed phase validation blocks the checkpoint with located, remediated violations and no approval proof", () => {
  const outcome = blockingOutcome(validationRecord("specify", "fail"));

  assert.equal(outcome.approval_proof, null, "a failed validation exposes no approval proof: no checkpoint can open");
  assert.equal(outcome.first_valid_next_action.kind, "remediation", "the first valid next action repairs the artifact");
  assert.equal(outcome.violations.length, 1);
  assert.deepEqual(outcome.violations[0], {
    location: "spec.md#non-goals",
    criterion: "SPEC_VALIDATE_SECTIONS_MISSING",
    remediation_command: "restore the '## Non-Goals' section before revalidation",
  });

  // The workspace-level projection of the same rule: a revision-required
  // phase (validation failed) re-enters its phase; it never offers a
  // checkpoint decision.
  const phases = contentGraphWorkspace().phases.map((record) =>
    record.phase === "specify"
      ? { ...record, status: "revision_required" as const, last_feedback: "restore the missing Non-Goals section" }
      : record,
  );
  const action = nextActionForWorkspace(phases, { status: "in_progress", hasConstitutionBinding: true, sourceKind: "native" });
  assert.notEqual(action.kind, "checkpoint", "an invalid artifact never presents a checkpoint");
  assert.equal(action.kind, "command");
  assert.equal(action.command, "/specify", "the remediation path re-enters the exact affected phase");

  // The strict aggregate oracle enforces the same gate: approval state
  // without a current validation reference is invalid.
  const unvalidated = structuredClone(validFeatureWorkspace({ withApprovedSpecify: true }));
  unvalidated.phases[0]!.validation_ref = null;
  const verdict = validateFeatureWorkspaceRecord(unvalidated);
  assert.equal(verdict.ok, false, "awaiting approval without a passing validation is invalid");
  if (!verdict.ok) assert.ok(verdict.issues.some((issue) => issue.includes("validation_ref")));
});

test("a passing validation is the approval proof, opens exactly the checkpoint, and blockingOutcome is deterministic", () => {
  const passing = validationRecord("plan", "pass");
  const outcome = blockingOutcome(passing);

  assert.deepEqual(outcome.violations, [], "a passing validation carries no blocking violations");
  assert.equal(outcome.first_valid_next_action.kind, "checkpoint");
  assert.equal(
    typeof outcome.approval_proof,
    "string",
    "the approval proof names the exact validation and artifact version",
  );
  assert.ok(outcome.approval_proof!.includes(passing.validation_id));
  assert.ok(outcome.approval_proof!.includes(passing.artifact_version));

  assert.deepEqual(blockingOutcome(passing), outcome, "identical inputs produce the identical projection");
});

// ── Upstream revision propagation (T043) ─────────────────────────────────────

test("revising an approved upstream artifact stales exactly its downstream phases", () => {
  const workspace = contentGraphWorkspace();
  const revision = { artifact_id: "specify.v2", version: 2, hash: sha256("specify.v2") };

  const propagated = propagateUpstreamRevision(workspace, revision);

  assert.deepEqual(propagated.stale_artifacts, ["plan.v1", "tasks.v1"], "only the dependency closure of specify.v1 goes stale");

  const specify = phaseOf(propagated.workspace, "specify");
  assert.equal(specify.current_version, 2, "the revision becomes the current version");
  assert.equal(specify.status, "generating", "the revised phase re-enters generation");
  assert.equal(specify.approved_version, 1, "the prior approval stays attributable to the replaced version");
  assert.equal(specify.checkpoint_ref, "checkpoint.specify.v1");
  assert.equal(specify.stale_reason, null, "the revised origin is regenerating, not stale");

  const plan = phaseOf(propagated.workspace, "plan");
  assert.equal(plan.status, "stale");
  assert.ok(plan.stale_reason !== null && plan.stale_reason.includes("specify.v2"), "staleness carries a typed reason naming the revision");
  assert.deepEqual(plan.upstream_versions, [{ phase: "specify", version: 1, hash: SPECIFY_V1_HASH }], "stale records keep the exact bindings they were built on");
  assert.equal(plan.approved_version, 1, "the downstream approval remains attributable to its version");

  const tasks = phaseOf(propagated.workspace, "tasks");
  assert.equal(tasks.status, "stale", "transitive dependants go stale as well");

  assert.equal(propagated.workspace.next_action.kind, "remediation", "staleness exposes a remediation next action, not a checkpoint");
  assert.ok(validateFeatureWorkspaceRecord(propagated.workspace).ok, "the propagated aggregate stays a valid record");
});

test("stale propagation keeps approvals attributable, replays idempotently, and rejects invalid revisions", () => {
  const revision = { artifact_id: "specify.v2", version: 2, hash: sha256("specify.v2") };
  const first = propagateUpstreamRevision(contentGraphWorkspace(), revision);

  const replayed = propagateUpstreamRevision(first.workspace, revision);
  assert.deepEqual(replayed.workspace, first.workspace, "replaying an established revision returns the established record");
  assert.deepEqual(replayed.stale_artifacts, [], "replay marks nothing newly stale");

  assert.throws(() => propagateUpstreamRevision(contentGraphWorkspace(), { artifact_id: "plan.v9", version: 9, hash: sha256("plan.v9") }), /plan\.v9/, "unknown artifact ids fail closed");
  assert.throws(() => propagateUpstreamRevision(contentGraphWorkspace(), { artifact_id: "specify.v1", version: 1, hash: SPECIFY_V1_HASH }), /specify\.v1/, "re-declaring the current version is not a revision");
  assert.throws(() => propagateUpstreamRevision(contentGraphWorkspace(), { artifact_id: "specify.v2", version: 2, hash: "deadbeef" }), /deadbeef/, "revisions bind exact content digests");
  assert.throws(() => propagateUpstreamRevision(contentGraphWorkspace(), { artifact_id: "research.v2", version: 2, hash: sha256("research.v2") }), /research\.v2/, "non-phase artifacts are not specification revisions");
});

test("an implementation-ready workspace goes stale before any dispatch can claim it", () => {
  const ready = contentGraphWorkspace({ status: "implementation_ready" });
  ready.handoff_ref = "feature-one.handoff.v1";

  const propagated = propagateUpstreamRevision(ready, { artifact_id: "specify.v2", version: 2, hash: sha256("specify.v2") });

  assert.equal(propagated.workspace.status, "stale", "a derived execution-ready status cannot survive upstream drift");
  assert.equal(propagated.workspace.next_action.kind, "remediation");
  assert.notEqual(propagated.workspace.next_action.kind, "checkpoint");
  assert.ok(validateFeatureWorkspaceRecord(propagated.workspace).ok);
});

// ── Manual readable-document edits (T043 + T016 revalidation) ────────────────

test("a manual readable edit stales the edited version and its dependants while matching documents change nothing", () => {
  const project = stalenessProject("spec-staleness-manual-");
  try {
    const materialized = materializeFeatureDocuments(project.root, {
      feature_id: FIXED_FEATURE_ID,
      run_key: project.runKey,
      phase: "specify",
      version: 1,
      documents: [{ path: "spec.md", content: "# Spec\n\n## Requirements\n\nFR-1 The thing works.\n" }],
    }, { validateBeforeWrite: () => {
      const snapshot = captureWorkspaceRoot(project.root);
      if (!snapshot) throw new Error("SPEC_PATH_UNAUTHORIZED: staleness fixture root cannot be pinned");
      try {
        const current = resolveFeatureWorkspace(project.root, { feature_id: FIXED_FEATURE_ID, run_key: project.runKey }, snapshot);
        if (!current.ok || !current.value.constitution_binding) throw new Error("SPEC_STALE: staleness workspace constitution binding is unavailable");
        const live = readPinnedCurrentConstitution(snapshot.canonical_root, snapshot.pinned_root, current.value.constitution_binding);
        if (!live.ok) throw new Error("SPEC_STALE: " + live.error);
      } finally {
        snapshot.pinned_root.close();
      }
    } });
    assert.ok(materialized.ok, materialized.ok ? "materialized" : `rejected: ${materialized.error}`);

    const before = revalidateMaterializedDocuments(project.root, { feature_id: FIXED_FEATURE_ID, phase: "specify", version: 1 });
    assert.ok(before.ok);
    const specHash = before.value.documents["spec.md"]!.expected_sha256;

    const aggregate: FeatureWorkspace = {
      ...project.created,
      phases: [
        phaseRecord("specify", {
          status: "approved",
          current_version: 1,
          approved_version: 1,
          validation_ref: "validation.specify.v1",
          checkpoint_ref: "checkpoint.specify.v1",
        }),
        phaseRecord("plan", {
          status: "awaiting_approval",
          current_version: 1,
          validation_ref: "validation.plan.v1",
          upstream_versions: [{ phase: "specify", version: 1, hash: specHash }],
        }),
        phaseRecord("tasks"),
      ],
      status: "in_progress",
    };
    const authoritative = resolveFeatureWorkspace(project.root, { feature_id: FIXED_FEATURE_ID, run_key: project.runKey });
    assert.ok(authoritative.ok, authoritative.ok ? "authoritative workspace" : `rejected: ${authoritative.error}`);
    if (!authoritative.ok) throw new Error(authoritative.error);
    const expectedWorkspaceDigest = digestOf(authoritative.value);
    const persisted = persistFeatureWorkspace(project.root, aggregate, undefined, { expected_workspace_digest: expectedWorkspaceDigest });
    assert.ok(persisted.ok, persisted.ok ? "persisted" : `rejected: ${persisted.error}`);

    // A fully matching revalidation is never a staleness trigger.
    const untouched = applyManualEdits(aggregate, before.value, "manual edit check with matching hashes");
    assert.deepEqual(untouched.workspace, aggregate, "matching documents change nothing");
    assert.deepEqual(untouched.stale_artifacts, []);

    writeFileSync(join(project.root, "specs", FIXED_FEATURE_ID, "spec.md"), "# Tampered spec\n", "utf8");
    const after = revalidateMaterializedDocuments(project.root, { feature_id: FIXED_FEATURE_ID, phase: "specify", version: 1 });
    assert.ok(after.ok);
    assert.equal(after.value.documents["spec.md"]!.matches, false, "the materializer detects the manual edit");

    const reason = "manual edit of specs/feature-one/spec.md after approval";
    const edited = applyManualEdits(aggregate, after.value, reason);

    assert.deepEqual(edited.stale_artifacts, ["specify.v1", "plan.v1"], "the edited version and its dependent approval go stale");
    const specify = phaseOf(edited.workspace, "specify");
    assert.equal(specify.status, "stale");
    assert.equal(specify.stale_reason, reason);
    assert.equal(specify.approved_version, 1, "the approval stays attributable to the exact edited version");
    const plan = phaseOf(edited.workspace, "plan");
    assert.equal(plan.status, "stale", "approvals bound to the edited version go stale");
    assert.equal(edited.workspace.next_action.kind, "remediation");
    assert.ok(validateFeatureWorkspaceRecord(edited.workspace).ok);
  } finally {
    project.cleanup();
  }
});

test("manual-edit staleness fails closed for unknown artifacts, foreign features, and blank reasons", () => {
  const workspace = contentGraphWorkspace();
  const matching: RevalidateOutcomeValue = {
    feature_id: FIXED_FEATURE_ID,
    phase: "specify",
    version: 1,
    documents: {},
  };

  assert.throws(() => applyManualEdits(workspace, { ...matching, phase: "tasks", version: 7 }, "reason"), /tasks\.v7/, "staleness requires the reported version to exist in the aggregate");
  assert.throws(() => applyManualEdits(workspace, { ...matching, feature_id: "feature-two" }, "reason"), /feature-two/, "revalidation evidence for another feature is rejected");
  assert.throws(() => applyManualEdits(workspace, matching, "   "), /staleness requires an explicit reason/, "blank reasons fail closed exactly like applyConstitutionImpact");
});

// ── Language and template drift (T043) ───────────────────────────────────────

test("a post-approval language change stales content-bearing approvals and leaves empty phases untouched", () => {
  const workspace = awaitingPlanWorkspace();
  const newLanguage: LanguageSelection = {
    language: "ru-RU",
    source: "feature_override",
    selection_hash: sha256("lang:ru-RU"),
  };

  const drifted = applyLanguageChange(workspace, newLanguage);

  assert.deepEqual(drifted.workspace.language, newLanguage, "the aggregate binds the new selection");
  assert.deepEqual(drifted.stale_artifacts, ["specify.v1", "plan.v1"], "every content-bearing approval is affected");
  assert.equal(phaseOf(drifted.workspace, "specify").status, "stale");
  assert.equal(phaseOf(drifted.workspace, "plan").status, "stale");
  const tasks = phaseOf(drifted.workspace, "tasks");
  assert.equal(tasks.status, "not_started", "phases without materialized content are preserved");
  assert.equal(tasks.stale_reason, null);
  assert.equal(drifted.workspace.next_action.kind, "remediation");
  assert.ok(validateFeatureWorkspaceRecord(drifted.workspace).ok);

  const rebinding = applyLanguageChange(workspace, workspace.language);
  assert.deepEqual(rebinding.workspace, workspace, "rebinding the identical selection is a no-op");
  assert.deepEqual(rebinding.stale_artifacts, []);
});

test("a post-approval template change stales content-bearing approvals and identical rebinds are no-ops", () => {
  const workspace = awaitingPlanWorkspace();
  const newTemplates: TemplateSelection = {
    template_set_id: "specification-default",
    source: "project_default",
    content_hash: sha256("template-set:revised"),
    required_markers: ["## Problem", "## Requirements", "## Success Criteria", "## Non-Goals"],
  };

  const drifted = applyTemplateChange(workspace, newTemplates);

  assert.deepEqual(drifted.workspace.template_set, newTemplates);
  assert.deepEqual(drifted.stale_artifacts, ["specify.v1", "plan.v1"]);
  assert.equal(phaseOf(drifted.workspace, "specify").status, "stale");
  assert.equal(phaseOf(drifted.workspace, "plan").status, "stale");
  const tasks = phaseOf(drifted.workspace, "tasks");
  assert.equal(tasks.status, "not_started", "empty phases never stale from selection drift");
  assert.equal(drifted.workspace.next_action.kind, "remediation");
  assert.ok(validateFeatureWorkspaceRecord(drifted.workspace).ok);

  const rebinding = applyTemplateChange(workspace, workspace.template_set);
  assert.deepEqual(rebinding.workspace, workspace, "rebinding the identical template set is a no-op");
  assert.deepEqual(rebinding.stale_artifacts, []);
});

// ── Targeted constitution staleness and unaffected preservation (T021 + T043) ─

const IMPACT_ARTIFACTS = [
  { artifact_id: "specify.v1", semantic_section_hashes: { quality: sha256("quality-rule-v2") }, depends_on: [] },
  { artifact_id: "plan.v1", semantic_section_hashes: { decisions: sha256("plan-section") }, depends_on: ["specify.v1"] },
  { artifact_id: "tasks.v1", semantic_section_hashes: { graph: sha256("unrelated-tasks") }, depends_on: [] },
];

test("a semantic constitution amendment stales only the dependency closure and marks bound handoffs stale", () => {
  assert.deepEqual(dependencyClosure("specify.v1", IMPACT_ARTIFACTS), ["specify.v1", "plan.v1"], "the closure is targeted, not blanket");
  assert.deepEqual(dependencyClosure("tasks.v1", IMPACT_ARTIFACTS), ["tasks.v1"], "an artifact without dependants closes onto itself");

  const evidence = "constitution-impact-assessment";
  const rows: ConstitutionArtifactImpactResult[] = [
    { artifact_id: "specify.v1", verdict: "affected", evidence_refs: [evidence] },
    { artifact_id: "plan.v1", verdict: "affected", evidence_refs: [evidence] },
    { artifact_id: "tasks.v1", verdict: "no_impact", evidence_refs: [evidence] },
  ];

  const ready = contentGraphWorkspace({ status: "implementation_ready" });
  ready.handoff_ref = "feature-one.handoff.v1";
  const impacted = applyConstitutionImpact(ready, rows, "constitution 1.1.0 changed a quality rule");

  assert.deepEqual(impacted.stale_artifacts, ["specify.v1", "plan.v1"]);
  assert.equal(impacted.workspace.status, "stale", "a derived execution-ready status cannot survive an affected amendment");
  const tasks = phaseOf(impacted.workspace, "tasks");
  assert.equal(tasks.status, "awaiting_approval", "unaffected artifacts retain their state");
  assert.equal(tasks.stale_reason, null);
  assert.equal(impacted.workspace.next_action.kind, "remediation");
  assert.ok(validateFeatureWorkspaceRecord(impacted.workspace).ok);

  // The handoff bound to the stale artifacts cannot stay ready (T043).
  const boundHandoff = validImplementationHandoff();
  const handoffOutcome = applyHandoffStaleness(boundHandoff, impacted.stale_artifacts);
  assert.equal(handoffOutcome.stale, true);
  assert.equal(handoffOutcome.handoff.status, "stale", "a handoff over stale artifact versions is stale before any dispatch");
  assert.ok(validateImplementationHandoff(handoffOutcome.handoff).ok, "the stale handoff stays a structurally valid record");
});

test("constitution impact stales every affected approved and current version of an awaiting phase", () => {
  const workspace = contentGraphWorkspace();
  const specify = phaseOf(workspace, "specify");
  specify.status = "awaiting_approval";
  specify.current_version = 2;
  specify.approved_version = 1;
  specify.validation_ref = "validation.specify.v2";
  specify.checkpoint_ref = "checkpoint.specify.v1";
  const rows: ConstitutionArtifactImpactResult[] = [
    { artifact_id: "specify.v1", verdict: "affected", evidence_refs: ["section:quality"] },
    { artifact_id: "specify.v2", verdict: "affected", evidence_refs: ["section:quality"] },
    { artifact_id: "plan.v1", verdict: "no_impact", evidence_refs: ["sections:decisions"] },
    { artifact_id: "tasks.v1", verdict: "no_impact", evidence_refs: ["sections:graph"] },
  ];
  const reason = "constitution quality rule changed";
  const applied = applyConstitutionImpact(workspace, rows, reason);
  assert.deepEqual(applied.stale_artifacts, ["specify.v1", "specify.v2"], "receipt projection includes both affected phase versions in assessment order");
  assert.equal(phaseOf(applied.workspace, "specify").status, "stale");
  assert.equal(phaseOf(applied.workspace, "plan").status, "approved");
  assert.equal(phaseOf(applied.workspace, "tasks").status, "awaiting_approval");

  const replay = applyConstitutionImpact(applied.workspace, rows, reason);
  assert.deepEqual(replay.workspace, applied.workspace, "replaying the exact assessment does not mutate the postimage");
  assert.deepEqual(replay.stale_artifacts, applied.stale_artifacts, "replay preserves the exact affected artifact receipt");
});

test("constitution impact rejects missing or unapproved version rows before mutating the workspace", () => {
  const workspace = contentGraphWorkspace();
  const specify = phaseOf(workspace, "specify");
  specify.status = "awaiting_approval";
  specify.current_version = 2;
  specify.approved_version = 1;
  specify.validation_ref = "validation.specify.v2";
  specify.checkpoint_ref = "checkpoint.specify.v1";
  const original = structuredClone(workspace);
  const complete: ConstitutionArtifactImpactResult[] = [
    { artifact_id: "specify.v1", verdict: "affected", evidence_refs: ["section:quality"] },
    { artifact_id: "specify.v2", verdict: "affected", evidence_refs: ["section:quality"] },
    { artifact_id: "plan.v1", verdict: "no_impact", evidence_refs: ["sections:decisions"] },
    { artifact_id: "tasks.v1", verdict: "no_impact", evidence_refs: ["sections:graph"] },
  ];
  const missing = complete.filter((row) => row.artifact_id !== "specify.v2");
  assert.throws(() => applyConstitutionImpact(workspace, missing, "constitution changed"), /missing artifact 'specify\.v2'/);
  assert.deepEqual(workspace, original, "missing inventory rows fail before any phase mutation");
  const unapproved = [...complete, { artifact_id: "plan.v9", verdict: "affected" as const, evidence_refs: ["section:quality"] }];
  assert.throws(() => applyConstitutionImpact(workspace, unapproved, "constitution changed"), /unapproved artifact 'plan\.v9'/);
  assert.deepEqual(workspace, original, "unapproved version rows fail before any phase mutation");
});

test("formatting-only constitution changes with no-impact evidence preserve every approval", () => {
  const evidence = "constitution-impact-assessment";
  const noImpactRows: ConstitutionArtifactImpactResult[] = [
    { artifact_id: "specify.v1", verdict: "no_impact", evidence_refs: [evidence] },
    { artifact_id: "plan.v1", verdict: "no_impact", evidence_refs: [evidence] },
    { artifact_id: "tasks.v1", verdict: "no_impact", evidence_refs: [evidence] },
  ];

  const ready = contentGraphWorkspace({ status: "implementation_ready" });
  const formattingOnly = applyConstitutionImpact(ready, noImpactRows, "constitution 1.0.1 reformatting only");

  assert.deepEqual(formattingOnly.stale_artifacts, [], "proven no-impact never stales an approval");
  assert.deepEqual(formattingOnly.workspace, ready, "the aggregate is unchanged");
});

// ── Stale approval/handoff behavior (T043) ───────────────────────────────────

test("a handoff bound to stale artifacts is marked stale idempotently while unaffected handoffs stay ready", () => {
  const handoff = validImplementationHandoff();

  const marked = applyHandoffStaleness(handoff, ["specify.v1"]);
  assert.equal(marked.stale, true);
  assert.equal(marked.handoff.status, "stale");
  assert.notEqual(marked.handoff.status, "ready", "a stale handoff can never stay ready");
  assert.deepEqual(marked.handoff.approval_refs, handoff.approval_refs, "approvals remain attributable to their versions");
  assert.ok(validateImplementationHandoff(marked.handoff).ok);

  const again = applyHandoffStaleness(marked.handoff, ["specify.v1"]);
  assert.deepEqual(again.handoff, marked.handoff, "marking is idempotent");
  assert.equal(again.stale, true);

  const unaffected = applyHandoffStaleness(handoff, ["research.v9"]);
  assert.equal(unaffected.stale, false, "artifact versions outside the handoff do not stale it");
  assert.deepEqual(unaffected.handoff, handoff, "an unaffected handoff keeps its ready status");
});

test("workspace staleness persists across an explicit-selector session boundary", () => {
  const project = stalenessProject("spec-staleness-durable-");
  try {
    const propagated = propagateUpstreamRevision(
      contentGraphWorkspace({ status: "implementation_ready" }),
      { artifact_id: "specify.v2", version: 2, hash: sha256("specify.v2") },
    );
    const authoritative = resolveFeatureWorkspace(project.root, { feature_id: FIXED_FEATURE_ID, run_key: project.runKey });
    assert.ok(authoritative.ok, authoritative.ok ? "authoritative workspace" : `rejected: ${authoritative.error}`);
    if (!authoritative.ok) throw new Error(authoritative.error);
    const expectedWorkspaceDigest = digestOf(authoritative.value);
    const durable: FeatureWorkspace = { ...propagated.workspace, project_root: project.created.project_root };
    bindFeatureWorkspaceToRoot(durable, project.root);
    const persisted = persistFeatureWorkspace(project.root, durable, undefined, { expected_workspace_digest: expectedWorkspaceDigest });
    assert.ok(persisted.ok, persisted.ok ? "persisted" : `rejected: ${persisted.error}`);

    const resolved = resolveFeatureWorkspace(project.root, { feature_id: FIXED_FEATURE_ID, run_key: project.runKey });
    assert.ok(resolved.ok, resolved.ok ? "resolved" : `rejected: ${resolved.error}`);
    assert.equal(resolved.value.status, "stale", "staleness is durable state, not a projection detail");
    const plan = phaseOf(resolved.value, "plan");
    assert.equal(plan.status, "stale");
    assert.ok(plan.stale_reason !== null && plan.stale_reason.includes("specify.v2"));
    assert.equal(resolved.value.next_action.kind, "remediation", "the resumed session sees the exact remediation action");
  } finally {
    project.cleanup();
  }
});
