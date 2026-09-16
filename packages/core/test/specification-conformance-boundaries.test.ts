import assert from "node:assert/strict";
import { TEST_ON } from "./fixtures/registrar-host.js";
import { openTestCtoRuntime, openTestRegistry, writeTestRegistryMarker } from "./fixtures/registry-activation.js";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { z } from "zod";
import {
  computeCtoTerminalTeamsDigest,
  conformanceInputBoundaryIssues,
  evaluateCtoSpecificationConformance,
  persistCtoSpecificationConformance,
  MAX_CONFORMANCE_AGGREGATE_BYTES,
  MAX_CONFORMANCE_ARTIFACT_REFS_PER_ENTRY,
  MAX_CONFORMANCE_CLAIMS,
  MAX_CONFORMANCE_EVIDENCE_ENTRIES,
  MAX_CONFORMANCE_FINDINGS_PER_GATE,
  MAX_CONFORMANCE_HANDOFFS,
  MAX_CONFORMANCE_INPUT_DEPTH,
} from "../src/specification/conformance.js";
import { registerWorkflowTools } from "../src/index.js";
import { MAX_CTO_MAPPING_FEATURES } from "../src/specification/mapping-record.js";

type Json = Record<string, unknown>;

const digest = "a".repeat(64);
const artifact = (): Json => ({ artifact_id: "artifact-1", path: "artifact-1.json", sha256: digest, schema_status: "met", quality_gate_status: "met" });
const evidence = (index = 0): Json => ({ evidence_id: `evidence-${index}`, kind: "implementation", subject_id: "FR-1", requirement_id: null, handoff_digest: digest, execution_claim_id: "claim-1", artifact: artifact() });
const gate = (): Json => ({ gate_id: "execution-profile.hash", source: "execution_profile", status: "pass", evidence_refs: [], findings: [] });
const base = (): Json => ({ feature_id: "feature-1", run_key: "run-1", evidence: [evidence()], quality_gates: [gate()] });
const safeUnissuedBinding = (): string => [
  "cto-conformance-v2",
  ...["foreign-root", "unissued-run", "unissued-mapping", digest, digest, "checkpoint", "answer", digest, digest]
    .map((value) => Buffer.from(value, "utf8").toString("base64url")),
].join(".");

function mountedSchema(): z.ZodTypeAny {
  const root = mkdtempSync(join(tmpdir(), "conformance-registrar-"));
  writeTestRegistryMarker(root);
  const registration = openTestRegistry(root, ["workflow_tools"], "conformance");
  let schema: z.ZodTypeAny | null = null;
  const pi = {
    zod: z,
    on: TEST_ON,
    registerTool(definition: { name: string; parameters: unknown }): void {
      if (definition.name === "workflow_specification_conformance") schema = definition.parameters as z.ZodTypeAny;
    },
  };
  registerWorkflowTools(pi as never, { owner: () => registration.owner, cwd: root, registrationToken: registration.token });
  registration.finish(true);
  rmSync(root, { recursive: true, force: true });
  assert.ok(schema, "mounted conformance schema is registered");
  return schema;
}

test("conformance direct boundary rejects max+1 nested/aggregate/control/extra input", () => {
  assert.equal(conformanceInputBoundaryIssues(base()).length, 0);
  const tooManyEvidence = { ...base(), evidence: Array.from({ length: MAX_CONFORMANCE_EVIDENCE_ENTRIES + 1 }, (_, index) => evidence(index)) };
  assert.ok(conformanceInputBoundaryIssues(tooManyEvidence).some((issue) => issue.includes("evidence exceeds")));
  const tooManyRefs = { ...base(), quality_gates: [{ ...gate(), evidence_refs: Array.from({ length: MAX_CONFORMANCE_ARTIFACT_REFS_PER_ENTRY + 1 }, artifact) }] };
  assert.ok(conformanceInputBoundaryIssues(tooManyRefs).some((issue) => issue.includes("evidence_refs exceeds")));
  const tooManyFindings = { ...base(), quality_gates: [{ ...gate(), findings: Array.from({ length: MAX_CONFORMANCE_FINDINGS_PER_GATE + 1 }, (_, index) => ({ code: `finding-${index}`, subject_id: null, message: "blocked", evidence_refs: [] })) }] };
  assert.ok(conformanceInputBoundaryIssues(tooManyFindings).some((issue) => issue.includes("findings exceeds")));
  const aggregate = { ...base(), evidence: Array.from({ length: MAX_CONFORMANCE_EVIDENCE_ENTRIES }, (_, index) => ({ ...evidence(index), intent_message: "x".repeat(16_000) })) };
  assert.ok(conformanceInputBoundaryIssues(aggregate).some((issue) => issue.includes(String(MAX_CONFORMANCE_AGGREGATE_BYTES))));
  assert.ok(conformanceInputBoundaryIssues({ ...base(), evidence: [{ ...evidence(), evidence_id: "bad\nidentifier" }] }).length > 0);
  assert.ok(conformanceInputBoundaryIssues({ ...base(), evidence: [{ ...evidence(), artifact: { ...artifact(), nested: { too: "deep" } } }] }).some((issue) => issue.includes("not allowed")));
});

test("direct CTO boundary accepts domain maxima and rejects max-plus-one fan-in", () => {
  const maxHandoffs = {
    ...base(),
    handoffs: Array.from({ length: MAX_CONFORMANCE_HANDOFFS }, (_, index) => ({ feature_id: `feature-${index}`, run_key: `run-${index}`, handoff: {} })),
  };
  assert.equal(conformanceInputBoundaryIssues(maxHandoffs).length, 0);
  const tooManyHandoffs = {
    ...maxHandoffs,
    handoffs: [...(maxHandoffs.handoffs as unknown[]), { feature_id: "overflow", run_key: "run-overflow", handoff: {} }],
  };
  assert.ok(conformanceInputBoundaryIssues(tooManyHandoffs).some((issue) => issue.includes(`handoffs exceeds ${MAX_CONFORMANCE_HANDOFFS}`)));

  const maxClaims = { ...base(), claims: Array.from({ length: MAX_CONFORMANCE_CLAIMS }, () => ({})) };
  assert.equal(conformanceInputBoundaryIssues(maxClaims).length, 0);
  const tooManyClaims = { ...maxClaims, claims: [...(maxClaims.claims as unknown[]), {}] };
  assert.ok(conformanceInputBoundaryIssues(tooManyClaims).some((issue) => issue.includes(`claims exceeds ${MAX_CONFORMANCE_CLAIMS}`)));

  const maxFeatures = { ...base(), mapping: { feature_ids: Array.from({ length: MAX_CTO_MAPPING_FEATURES }, (_, index) => `feature-${index}`) } };
  assert.equal(conformanceInputBoundaryIssues(maxFeatures).length, 0);
  const tooManyFeatures = { ...maxFeatures, mapping: { feature_ids: [...(maxFeatures.mapping.feature_ids as string[]), "feature-overflow"] } };
  assert.ok(conformanceInputBoundaryIssues(tooManyFeatures).some((issue) => issue.includes(`mapping.feature_ids exceeds ${MAX_CTO_MAPPING_FEATURES}`)));
});

test("direct CTO boundary rejects deep graphs and persists no state on overflow", () => {
  let nested: unknown = "leaf";
  for (let index = 0; index <= MAX_CONFORMANCE_INPUT_DEPTH; index += 1) nested = { wave_id: nested };
  const deep = { ...base(), mapping: { feature_ids: ["feature-1"], execution: nested } };
  assert.ok(conformanceInputBoundaryIssues(deep).some((issue) => issue.includes("nesting limit")));

  const root = mkdtempSync(join(tmpdir(), "cto-conformance-input-boundary-"));
  try {
    const overflow = {
      project_root: root,
      mapping: { feature_ids: Array.from({ length: MAX_CTO_MAPPING_FEATURES + 1 }, (_, index) => `feature-${index}`) },
      handoffs: [],
      claims: [],
      evidence: [],
    };
    const result = persistCtoSpecificationConformance(overflow as never, undefined as never);
    assert.equal(result.status, "blocked");
    assert.equal(existsSync(join(root, ".work-state")), false, "boundary rejection must not write project state");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("CTO conformance persistence rejects forged and revoked runtime before mutation", () => {
  const root = mkdtempSync(join(tmpdir(), "cto-conformance-runtime-guard-"));
  const input = {
    ...base(),
    project_root: root,
    mapping: { feature_ids: ["feature-1"] },
    handoffs: [],
    claims: [],
  };
  try {
    const forged = persistCtoSpecificationConformance(input as never, {
      runtimeAccess: Object.create(null) as never,
      sessionId: "runtime-guard-session",
    });
    assert.equal(forged.status, "blocked");
    assert.match(forged.findings[0] ?? "", /recovery_required.*runtime access/i);
    assert.equal(existsSync(join(root, ".work-state")), false, "forged runtime must fail before creating project state");

    const opened = openTestCtoRuntime(root, "runtime-guard-session", "conformance-runtime-guard");
    opened.close();
    const revoked = persistCtoSpecificationConformance(input as never, {
      runtimeAccess: opened.access,
      sessionId: "runtime-guard-session",
    });
    assert.equal(revoked.status, "blocked");
    assert.match(revoked.findings[0] ?? "", /recovery_required.*runtime access/i);
    assert.equal(existsSync(join(root, ".work-state")), false, "revoked runtime must fail before creating project state");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("CTO conformance persistence preserves deterministic invalid-binding rejection", () => {
  const root = mkdtempSync(join(tmpdir(), "cto-conformance-invalid-binding-"));
  const opened = openTestCtoRuntime(root, "invalid-binding-session", "conformance-invalid-binding");
  try {
    const result = persistCtoSpecificationConformance({
      ...base(),
      project_root: root,
      mapping: { feature_ids: ["feature-1"] },
      handoffs: [],
      claims: [],
      binding: { capability_id: safeUnissuedBinding() },
    } as never, { runtimeAccess: opened.access, sessionId: "invalid-binding-session" });
    assert.equal(result.status, "blocked");
    assert.match(result.findings[0] ?? "", /binding is invalid|not issued by confirmed dispatch/i);
  } finally {
    opened.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("terminal team digest requires exact terminal postimages and distinguishes failed slices", () => {
  const identity = {
    run_id: "cto-run",
    wave_id: "wave-1",
    slice_id: "slice-1",
    session_id: "session-1",
    workflow: "standard" as const,
    stage_id: "execution",
    stage_cursor: "execution",
    capability_id: "capability-1",
    capability_epoch: "epoch-1",
    slot_id: "slice-1",
    task_id: "task-1",
    dispatch_id: "dispatch-1",
    attempt: 1,
    worker_id: "worker-1",
  };
  const envelope = {
    schema_version: 1 as const,
    identity,
    outcome: "succeeded" as const,
    terminal_signal: "native_tool_result" as const,
    artifact_refs: [],
    evidence_ref: null,
    conflict_ref: null,
    completed_by: "engine_task_caller" as const,
    emitted_at: "2026-01-01T00:00:00.000Z",
  };
  const mapping = {
    feature_ids: ["feature-1"],
    selections: [{ feature_id: "feature-1", run_key: "run-1" }],
    task_to_slice: [{ feature_id: "feature-1", task_id: "task-1", team_id: "team-1", slice_id: "slice-1", requirement_ids: [], verification_ids: [], evidence_refs: [], depends_on: [] }],
    parallelization: [{ slice_id: "slice-1", decision: "parallel", reason: "independent", worktree: "same_branch", depends_on_slice_ids: [], shared_contract_ids: [] }],
  } as never;
  const state = { id: "cto-run", teams: [{ id: "team-1", status: "in_progress", escalations: {}, feature_id: "feature-1", run_key: "run-1", task_id: "task-1", slice_id: "slice-1", work_identity: identity, completion_envelope: envelope }] } as never;
  const selectors = new Map([["feature-1", "run-1"]]);
  const wrongRun = computeCtoTerminalTeamsDigest(state, mapping, new Map([["feature-1", "run-forged"]]));
  assert.equal(wrongRun.ok, false);
  if (!wrongRun.ok) assert.match(wrongRun.error, /feature\/run/i);
  const pending = computeCtoTerminalTeamsDigest(state, mapping, selectors);
  assert.equal(pending.ok, false);
  if (!pending.ok) assert.match(pending.error, /not terminal/i);

  state.teams[0].status = "done";
  const done = computeCtoTerminalTeamsDigest(state, mapping, selectors);
  assert.equal(done.ok, true);
  if (done.ok) assert.match(done.digest, /^[a-f0-9]{64}$/u);

  state.teams[0].status = "failed";
  state.teams[0].completion_envelope = { ...envelope, outcome: "failed", terminal_signal: "contract_failure" };
  const failed = computeCtoTerminalTeamsDigest(state, mapping, selectors);
  assert.equal(failed.ok, true);

  state.teams[0].completion_envelope = envelope;
  const stale = computeCtoTerminalTeamsDigest(state, mapping, selectors);
  assert.equal(stale.ok, false);
  if (!stale.ok) assert.match(stale.error, /outcome|typed|stale/i);
});

test("mounted conformance schema enforces the same nested and aggregate ceilings", () => {
  const schema = mountedSchema();
  assert.equal(schema.safeParse(base()).success, true);
  assert.equal(schema.safeParse({ ...base(), quality_gates: [{ ...gate(), evidence_refs: Array.from({ length: MAX_CONFORMANCE_ARTIFACT_REFS_PER_ENTRY + 1 }, artifact) }] }).success, false);
  assert.equal(schema.safeParse({ ...base(), evidence: Array.from({ length: MAX_CONFORMANCE_EVIDENCE_ENTRIES }, (_, index) => ({ ...evidence(index), intent_message: "x".repeat(16_000) })) }).success, false);
  assert.equal(schema.safeParse({ ...base(), quality_gates: [{ ...gate(), findings: Array.from({ length: MAX_CONFORMANCE_FINDINGS_PER_GATE + 1 }, (_, index) => ({ code: `finding-${index}`, subject_id: null, message: "blocked", evidence_refs: [] })) }] }).success, false);
  assert.equal(schema.safeParse({ ...base(), evidence: [{ ...evidence(), evidence_id: "bad\nidentifier" }] }).success, false);
  assert.equal(schema.safeParse({ ...base(), evidence: [{ ...evidence(), extra: true }] }).success, false);
});

test("direct CTO conformance rejects bounded overflow before root pinning", () => {
  const input = { ...base(), project_root: "/no-such-root", mapping: { feature_ids: ["feature-1"] }, handoffs: [], claims: [], evidence: Array.from({ length: MAX_CONFORMANCE_EVIDENCE_ENTRIES + 1 }, (_, index) => evidence(index)) };
  const evaluated = evaluateCtoSpecificationConformance(input as never);
  assert.deepEqual(evaluated.features, []);
  const persisted = persistCtoSpecificationConformance(input as never, undefined as never);
  assert.equal(persisted.status, "blocked");
});
