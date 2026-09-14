/**
 * Executable artifact contracts:
 *   - schema-defined produced artifacts validate (valid passes, invalid
 *     blocks with field-level diagnostics),
 *   - unsupported schema keywords fail closed,
 *   - explicit legacy grandfathering skips validation,
 *   - consumed artifacts are prevalidated; missing consumes block only when
 *     the producing stage is done (loop feedback on the first pass and
 *     skipped producers are legitimate absences).
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadProfile } from "../src/engine/profile.js";
import {
  validateProducedArtifact,
  validateConsumedArtifacts,
  artifactSchemaFor,
  specificationPhaseSchemaForConstitution,
  requiredFieldsOf,
  loadArtifactSchemas,
  type ArtifactContractPolicy,
  type JsonSchemaDef,
} from "../src/engine/artifact-contract.js";
import type { StageDef, TeamState } from "../src/engine/types.js";

function state(overrides: Partial<TeamState> = {}): TeamState {
  return {
    schema: 1,
    branch: "feat/x",
    classification: { type: "FEATURE", complexity: "QUICK", confidence: "HIGH", autonomous: false, workflow: "lightweight" },
    task: "t",
    workflow_override: false,
    issue: null,
    stage_cursor: "s",
    stages: [{ id: "s", status: "in_progress" }],
    artifacts: {},
    pause: { kind: "none", reason: "" },
    updated_at: new Date().toISOString(),
    ...overrides,
  };
}
function strictSchemaForYield(schema: JsonSchemaDef, root: JsonSchemaDef): JsonSchemaDef {
  if (schema.$ref !== undefined) {
    assert.equal(schema.$ref, "#/$defs/sa", "only the known string-array definition may remain referenced");
    const target = root.$defs?.sa;
    assert.ok(target, "string-array reference must resolve");
    return strictSchemaForYield(target, root);
  }
  const out = structuredClone(schema);
  if (Array.isArray(out.type)) {
    const types = out.type;
    delete out.type;
    out.anyOf = types.map((type) => strictSchemaForYield({ ...out, type }, root));
  }
  if (out.properties) {
    out.type = "object";
    out.additionalProperties = false;
    out.properties = Object.fromEntries(Object.entries(out.properties).map(([key, child]) => [key, strictSchemaForYield(child, root)]));
    out.required = Object.keys(out.properties);
  }
  if (out.items) out.items = strictSchemaForYield(out.items, root);
  if (Array.isArray(out.anyOf)) out.anyOf = out.anyOf.map((branch) => strictSchemaForYield(branch, root));
  if (out.const !== undefined) {
    out.enum = [out.const];
    delete out.const;
  }
  return out;
}

function yieldParametersForTest(schema: JsonSchemaDef): JsonSchemaDef {
  const data = strictSchemaForYield(schema, schema);
  const branches: JsonSchemaDef[] = [data];
  if (data.type === "object" && data.properties) {
    for (const property of Object.values(data.properties)) {
      branches.push(property);
      if (property.type === "array" && property.items) branches.push(property.items);
    }
  }
  return strictSchemaForYield({
    type: "object",
    additionalProperties: false,
    required: [],
    properties: {
      type: { anyOf: [{ type: "string" }, { type: "array", minItems: 1, items: { type: "string" } }] },
      data: { anyOf: branches },
      error: { type: "string" },
    },
  }, schema);
}

function assertStrictProviderShape(schema: JsonSchemaDef, path = "$"): void {
  if (schema.type === "array") {
    assert.ok(schema.items, `${path} array must declare items`);
    assertStrictProviderShape(schema.items!, `${path}.items`);
  }
  if (Array.isArray(schema.anyOf)) {
    for (const [index, branch] of schema.anyOf.entries()) {
      assertStrictProviderShape(branch, `${path}.anyOf[${index}]`);
    }
  }
  if (schema.type === "object") {
    assert.ok(schema.properties, `${path} object must declare properties`);
    assert.equal(schema.additionalProperties, false, `${path} object must be closed`);
    assert.deepEqual(schema.required, Object.keys(schema.properties ?? {}), `${path} object must require every property`);
    for (const [key, child] of Object.entries(schema.properties ?? {})) {
      assertStrictProviderShape(child, `${path}.properties.${key}`);
    }
  }
  for (const [index, value] of (schema.enum ?? []).entries()) {
    assert.ok(value === null || typeof value !== "object", `${path}.enum[${index}] must be a primitive value`);
  }
}


test("artifact contract: shipped schema registry covers every workflow artifact id", () => {
  const schemas = loadArtifactSchemas();
  for (const id of ["discovery", "exploration", "clarifications", "architecture", "diagnosis", "implementation", "debug", "review", "summary", "manual_qa", "qa_tests", "feature_spec", "dod", "cto_discovery", "team_plan", "team_artifacts", "integration_review", "lecture_acquisition"]) {
    assert.ok(schemas[id], `schema for '${id}' must exist`);
  }
  assert.deepEqual(requiredFieldsOf("implementation"), ["files_touched"]);
  assert.deepEqual(requiredFieldsOf("debug"), ["verdict", "iterations"]);
  assert.equal(requiredFieldsOf("regression_intake"), null, "ids without a schema definition are unconstrained");
});

test("native phase worker_result schema is compact and binds the complete constitution identity set", () => {
  const binding = {
    provider_id: "native", path: "CONSTITUTION.md", version: "1.0.0",
    content_sha256: "a".repeat(64), semantic_hash: "b".repeat(64),
    validation_ref: "constitution.validation.v1", bound_at: "2026-09-08T00:00:00.000Z",
  };
  const identities = [
    { principle_id: "constitution:1:first", title: "First Principle" },
    { principle_id: "constitution:2:second", title: "Second Principle" },
  ];
  const schema = specificationPhaseSchemaForConstitution(identities, binding, "specify");
  assert.ok(schema, "native phase schema must be available");
  if (!schema) return;
  assert.deepEqual(schema.required, ["input_ref", "input_digest", "sections", "requirements", "decisions", "tasks", "verification", "contradictions", "constitution_principles"]);
  assert.equal(schema.additionalProperties, false);
  for (const engineField of ["schema_version", "feature_id", "run_key", "phase", "version", "worker", "constitution_binding", "upstream_versions"]) {
    assert.equal(schema.properties?.[engineField], undefined, `${engineField} must remain engine-owned`);
  }
  const sections = schema.properties?.sections;
  assert.equal(sections?.additionalProperties, false);
  assert.deepEqual(sections?.required, ["problem", "scope", "non_goals", "actors", "journeys", "requirements", "edge_cases", "assumptions", "dependencies", "success_criteria"]);
  const principles = schema.properties?.constitution_principles;
  assert.equal(principles?.minItems, identities.length);
  assert.equal(principles?.maxItems, identities.length);
  assert.equal(principles?.prefixItems, undefined, "native schema must use one reusable bounded row instead of expanded prefixItems");
  assert.equal(principles?.items?.$ref, undefined, "principle rows stay inline because the provider dereferences only supported shared definitions");
  assert.ok(principles?.items?.properties, "native schema must expose the bounded principle row shape");
  assert.deepEqual(Object.keys(principles?.items?.properties ?? {}), ["principle_id", "applicability", "status", "evidence"]);
  assert.deepEqual(principles?.items?.required, ["principle_id", "applicability", "status", "evidence"]);
  assert.deepEqual(principles?.items?.properties?.principle_id?.enum, identities.map(({ principle_id }) => principle_id));
  assert.ok(Buffer.byteLength(JSON.stringify(schema), "utf8") < 5 * 1024, "native output schema must remain within the provider budget");
  assertStrictProviderShape(schema);

  const rows = identities.map((identity) => ({
    principle_id: identity.principle_id, applicability: "applicable",
    status: "pass", evidence: `evidence for ${identity.principle_id}`,
  }));
  const model = {
    input_ref: "spec-native:fixture:run:specify:dispatch",
    input_digest: "a".repeat(64),
    sections: {
      problem: "The native phase must produce a durable typed specification.", scope: "The phase output only.",
      non_goals: "No implementation changes.", actors: "The requester and the worker.", journeys: "The worker emits one result.",
      requirements: "The result is complete.", edge_cases: "Malformed results are rejected.", assumptions: "The constitution is pinned.",
      dependencies: "The approved handoff.", success_criteria: "The finalizer persists a valid model.",
    },
    requirements: [{ requirement_id: "REQ-1", statement: "The phase is durable.", acceptance_ids: ["AC-1"], source_refs: ["request"], testable: true, untestable_reason: null }],
    decisions: [{ decision_id: "DEC-1", decision: "Persist the model.", rationale: "The finalizer requires one complete model.", requirement_ids: ["REQ-1"] }],
    tasks: [{ id: "TASK-1", title: "Persist the model", requirement_ids: ["REQ-1"], acceptance_ids: ["AC-1"], decision_ids: ["DEC-1"], verification_ids: ["VER-1"], depends_on: [], expected_outcome: "The model is durable.", affected_scope: ["engine"], completion_evidence: ["artifact written"], parallel_safe: true }],
    verification: [{ verification_id: "VER-1", requirement_ids: ["REQ-1"], acceptance_ids: ["AC-1"], task_ids: ["TASK-1"], observable_behavior: true, expected_evidence: "Read the persisted artifact." }],
    contradictions: [{ contradiction_id: "CON-1", subject_ids: ["REQ-1"], status: "resolved", assessment: "No contradiction remains.", evidence: "Reviewed against the constitution." }],
    constitution_principles: rows,
  };
  assert.deepEqual(validateProducedArtifact("specification_phase_model", model, undefined, schema), { ok: true });
  for (const collection of ["requirements", "decisions", "tasks", "verification", "contradictions", "constitution_principles"] as const) {
    const collectionRows = model[collection] as unknown as Array<Record<string, unknown>>;
    const rowSchema = schema.properties?.[collection]?.items;
    assert.ok(rowSchema?.required, `${collection} row schema must preserve required fields`);
    for (const field of rowSchema?.required ?? []) {
      const omitted = { ...collectionRows[0] };
      delete omitted[field];
      const candidate = { ...model, [collection]: collectionRows.map((row, index) => index === 0 ? omitted : row) };
      const result = validateProducedArtifact("specification_phase_model", candidate, undefined, schema);
      assert.equal(result.ok, false, `${collection}.${field} omission must fail schema validation`);
      if (!result.ok) assert.ok(result.issues.some((issue) => issue.field === `$.${collection}[0].${field}`));
    }
  }
  const missing = { ...model, constitution_principles: rows.slice(0, 1) };
  assert.equal(validateProducedArtifact("specification_phase_model", missing, undefined, schema).ok, false, "missing principle rows must fail closed");
  const extra = { ...model, feature_id: "forged" };
  assert.equal(validateProducedArtifact("specification_phase_model", extra, undefined, schema).ok, false, "engine-owned fields must fail closed");
});

test("artifact contract: lecture acquisition failure collections remain draft-07 arrays", () => {
  const schema = loadArtifactSchemas()["lecture_acquisition"] as {
    properties: Record<string, { properties?: Record<string, { type?: string }> }>;
  };
  assert.equal(schema.properties.sourceSet?.properties?.failures?.type, "array");
  assert.equal(schema.properties.failures?.type, "array");
});

test("artifact contract: manual_qa requires evidence and explained CONDITIONAL blockers", () => {
  const pass = validateProducedArtifact("manual_qa", {
    verdict: "PASS",
    mode: "runtime",
    evidence: ["focused runtime checks passed"],
  });
  assert.deepEqual(pass, { ok: true }, "PASS with evidence is valid");

  const conditional = validateProducedArtifact("manual_qa", {
    verdict: "CONDITIONAL",
    mode: "runtime",
    evidence: ["deterministic preflight passed; live provider unavailable"],
    blocked_prerequisites: ["provider credential is not configured"],
    regressions: [],
  });
  assert.deepEqual(conditional, { ok: true }, "CONDITIONAL requires and accepts a concrete blocker");

  const fail = validateProducedArtifact("manual_qa", {
    verdict: "FAIL",
    mode: "runtime",
    evidence: ["runtime check failed"],
  });
  assert.deepEqual(fail, { ok: true }, "FAIL remains a valid observed verdict; workflow gates block it");

  for (const verdict of ["PASS", "CONDITIONAL", "FAIL"] as const) {
    const emptyEvidence = validateProducedArtifact("manual_qa", { verdict, evidence: [] });
    assert.equal(emptyEvidence.ok, false, `${verdict} with empty evidence must fail closed`);
    if (!emptyEvidence.ok) assert.ok(emptyEvidence.issues.some((issue) => issue.field === "$.evidence"));
  }

  const conditionalWithoutBlockers = validateProducedArtifact("manual_qa", {
    verdict: "CONDITIONAL",
    evidence: ["deterministic checks passed"],
  });
  assert.equal(conditionalWithoutBlockers.ok, false, "an unexplained CONDITIONAL must not pass");
  if (!conditionalWithoutBlockers.ok) {
    assert.ok(conditionalWithoutBlockers.issues.some((issue) => issue.field === "$.blocked_prerequisites"));
  }

  const conditionalWithEmptyBlocker = validateProducedArtifact("manual_qa", {
    verdict: "CONDITIONAL",
    evidence: ["deterministic checks passed"],
    blocked_prerequisites: ["  "],
  });
  assert.equal(conditionalWithEmptyBlocker.ok, false, "a whitespace-only blocker does not explain CONDITIONAL");

  const conditionalWithTypedBlocker = validateProducedArtifact("manual_qa", {
    verdict: "CONDITIONAL",
    evidence: ["deterministic checks passed"],
    blocked_prerequisites: [42],
  });
  assert.equal(conditionalWithTypedBlocker.ok, false, "blocked_prerequisites must be a typed string array");

  const missingVerdict = validateProducedArtifact("manual_qa", { evidence: ["observed"] });
  assert.equal(missingVerdict.ok, false, "missing verdict remains fail closed");

  const unknown = validateProducedArtifact("manual_qa", {
    verdict: "MAYBE",
    evidence: ["unknown verdict must fail closed"],
  });
  assert.equal(unknown.ok, false);
  if (!unknown.ok) assert.match(unknown.issues[0]!.message, /not one of/);
});

test("artifact contract: valid produced artifacts pass; invalid block with field diagnostics", () => {
  const ok = validateProducedArtifact("review", {
    verdict: "approve",
    findings: [{ title: "t", severity: "MEDIUM", confidence: 80, zone: "backend-kotlin" }],
    tests: { passed: 3, failed: 0 },
  });
  assert.deepEqual(ok, { ok: true });

  const missingRequired = validateProducedArtifact("review", { verdict: "approve" });
  assert.equal(missingRequired.ok, false);
  if (!missingRequired.ok) {
    const issue = missingRequired.issues[0]!;
    assert.equal(issue.field, "$.findings");
    assert.match(issue.message, /required field 'findings' is missing/);
  }

  const badEnum = validateProducedArtifact("review", { verdict: "maybe", findings: [] });
  assert.equal(badEnum.ok, false);
  if (!badEnum.ok) assert.match(badEnum.issues[0]!.message, /not one of/);

  const badType = validateProducedArtifact("review", { verdict: "approve", findings: "nope" });
  assert.equal(badType.ok, false);
  if (!badType.ok) assert.match(badType.issues[0]!.message, /expected type array/);

  const badNested = validateProducedArtifact("review", {
    verdict: "approve",
    findings: [{ title: "t", severity: "CRITICAL", confidence: 200, zone: "x" }],
  });
  assert.equal(badNested.ok, false);
  if (!badNested.ok) {
    assert.ok(badNested.issues.some((issue) => issue.field === "$.findings[0].confidence"), "nested field diagnostics carry the JSON path");
    assert.ok(badNested.issues.some((issue) => /above maximum 100/.test(issue.message)));
  }

  const badDebug = validateProducedArtifact("debug", { verdict: "PASS" });
  assert.equal(badDebug.ok, false);
  if (!badDebug.ok) assert.match(badDebug.issues[0]!.message, /required field 'iterations' is missing/);

  const badDod = validateProducedArtifact("dod", { items: [] });
  assert.equal(badDod.ok, false);
  if (!badDod.ok) assert.match(badDod.issues[0]!.message, /minimum is 1/);
});

test("native phase draft ids share the strict immutable semantic-model contract", () => {
  const binding = {
    provider_id: "native", path: "CONSTITUTION.md", version: "1.0.0",
    content_sha256: "a".repeat(64), semantic_hash: "b".repeat(64),
    validation_ref: "constitution.validation.v1", bound_at: "2026-09-08T00:00:00.000Z",
  };
  const sections = {
    problem: "problem", scope: "scope", non_goals: "non goals", actors: "actors", journeys: "journeys",
    requirements: "requirements", edge_cases: "edge cases", assumptions: "assumptions", dependencies: "dependencies", success_criteria: "success",
  };
  const model = {
    schema_version: 1, feature_id: "atlas", run_key: "run", phase: "specify" as const, version: 1,
    worker: { role: "specification-analyst", agent: "specification-worker", dispatch_id: "dispatch" },
    constitution_binding: binding, upstream_versions: [], sections,
    requirements: [{ requirement_id: "REQ-1", statement: "statement", acceptance_ids: ["AC-1"], source_refs: ["request"], testable: true, untestable_reason: null }],
    decisions: [{ decision_id: "DEC-1", decision: "decision", rationale: "rationale", requirement_ids: ["REQ-1"] }],
    tasks: [{ id: "TASK-1", title: "task", requirement_ids: ["REQ-1"], acceptance_ids: ["AC-1"], decision_ids: ["DEC-1"], verification_ids: ["VER-1"], depends_on: [], expected_outcome: "outcome", affected_scope: ["core"], completion_evidence: ["evidence"], parallel_safe: true }],
    verification: [{ verification_id: "VER-1", requirement_ids: ["REQ-1"], acceptance_ids: ["AC-1"], task_ids: ["TASK-1"], observable_behavior: true, expected_evidence: "evidence" }],
    contradictions: [{ contradiction_id: "CON-1", subject_ids: ["REQ-1"], status: "resolved" as const, assessment: "resolved", evidence: "evidence" }],
    constitution_principles: [{ principle_id: "P-1", title: "Principle", applicability: "applicable" as const, status: "pass" as const, evidence: "evidence", binding }],
  };
  const draftIds = ["specify_draft", "plan_draft", "task_graph"] as const;
  const schemas = draftIds.map((id) => artifactSchemaFor(id));
  assert.ok(schemas.every((schema) => schema !== null), "each native draft id must resolve an executable schema");
  assert.deepEqual(schemas.map((schema) => schema?.required), schemas.map(() => schemas[0]?.required), "all native draft ids must require the same complete model keys");
  for (const id of draftIds) {
    const phase = id === "specify_draft" ? "specify" : id === "plan_draft" ? "plan" : "tasks";
    const phaseModel = {
      ...model,
      phase,
      sections: phase === "specify"
        ? model.sections
        : phase === "plan"
          ? { repository_grounding: "grounding", decisions: "decisions", alternatives: "alternatives", contracts: "contracts", data_flow: "data flow", control_flow: "control flow", migration: "migration", security: "security", operations: "operations", verification_strategy: "verification", constitution_recheck: "recheck" }
          : { task_graph: "task graph", dependencies: "dependencies", expected_outcomes: "outcomes" },
    };
    const valid = validateProducedArtifact(id, phaseModel);
    assert.deepEqual(valid, { ok: true }, `${id} must accept the exact finalized semantic projection`);
    const unknownTopLevel = { ...phaseModel, forged: true };
    assert.equal(validateProducedArtifact(id, unknownTopLevel).ok, false, `${id} must reject unknown top-level fields`);
    const unknownNested = { ...phaseModel, decisions: [{ ...phaseModel.decisions[0], forged: true }] };
    assert.equal(validateProducedArtifact(id, unknownNested).ok, false, `${id} must reject unknown semantic row fields`);
    const malformedRequirement = { ...phaseModel, requirements: [{ ...phaseModel.requirements[0], testable: "yes" }] };
    assert.equal(validateProducedArtifact(id, malformedRequirement).ok, false, `${id} must reject malformed requirement fields`);
    const malformedReason = { ...phaseModel, requirements: [{ ...phaseModel.requirements[0], untestable_reason: 42 }] };
    assert.equal(validateProducedArtifact(id, malformedReason).ok, false, `${id} must reject malformed untestable reasons`);
    const overlongSection = { ...phaseModel, sections: { ...phaseModel.sections, [phase === "specify" ? "problem" : phase === "plan" ? "repository_grounding" : "task_graph"]: "x".repeat(32_769) } };
    assert.equal(validateProducedArtifact(id, overlongSection).ok, false, `${id} must enforce bounded semantic section strings`);
  }
});

test("native phase draft contracts enforce phase-specific section grammar", () => {
  const binding = {
    provider_id: "native", path: "CONSTITUTION.md", version: "1.0.0",
    content_sha256: "a".repeat(64), semantic_hash: "b".repeat(64),
    validation_ref: "constitution.validation.v1", bound_at: "2026-09-08T00:00:00.000Z",
  };
  const model = {
    schema_version: 1, feature_id: "atlas", run_key: "run", phase: "specify" as const, version: 1,
    worker: { role: "specification-analyst", agent: "specification-worker", dispatch_id: "dispatch" },
    constitution_binding: binding, upstream_versions: [],
    sections: { problem: "problem", scope: "scope", non_goals: "non goals", actors: "actors", journeys: "journeys", requirements: "requirements", edge_cases: "edge cases", assumptions: "assumptions", dependencies: "dependencies", success_criteria: "success" },
    requirements: [], decisions: [], tasks: [], verification: [], contradictions: [], constitution_principles: [],
  };
  assert.deepEqual(validateProducedArtifact("specify_draft", model), { ok: true });
  assert.equal(validateProducedArtifact("specify_draft", { ...model, sections: { ...model.sections, repository_grounding: "wrong phase" } }).ok, false);
  assert.equal(validateProducedArtifact("specify_draft", { ...model, sections: { ...model.sections, success_criteria: undefined } }).ok, false);
  assert.equal(validateProducedArtifact("plan_draft", model).ok, false, "a plan draft cannot carry the specify phase model");
});

test("artifact contract: unsupported schema keywords fail closed", () => {
  // Regression_intake is unconstrained today; simulate a future schema that
  // ships a keyword the subset cannot honor.
  const schemas = loadArtifactSchemas();
  const original = schemas["debug"];
  // @ts-expect-error -- test-only mutation of the parsed schema cache
  schemas["debug"] = { ...original, oneOf: [] };
  try {
    const result = validateProducedArtifact("debug", { verdict: "PASS", iterations: 1 });
    assert.equal(result.ok, false);
    if (!result.ok) assert.match(result.issues[0]!.message, /unsupported schema keyword 'oneOf'/);
  } finally {
    // @ts-expect-error -- restore
    schemas["debug"] = original;
  }
});

test("artifact contract: legacy grandfathering skips validation explicitly", () => {
  const grandfathered: ArtifactContractPolicy = { validate: true, grandfathered: ["debug"] };
  const blocked = validateProducedArtifact("debug", { verdict: "PASS" }, { validate: true, grandfathered: [] });
  assert.equal(blocked.ok, false, "ungrandfathered legacy shape is rejected");
  const allowed = validateProducedArtifact("debug", { verdict: "PASS" }, grandfathered);
  assert.deepEqual(allowed, { ok: true }, "explicitly grandfathered id is skipped");
  const disabled = validateProducedArtifact("debug", { verdict: "PASS" }, { validate: false, grandfathered: [] });
  assert.deepEqual(disabled, { ok: true }, "validation can be disabled wholesale");
});

test("artifact contract: consumed artifacts are prevalidated; present-but-invalid blocks", () => {
  const root = mkdtempSync(join(tmpdir(), "ac-consume-"));
  try {
    const artifactsDir = join(root, "artifacts");
    mkdirSync(artifactsDir, { recursive: true });
    const profile = loadProfile("full-feature");
    assert.ok(profile);
    const stage: StageDef = { id: "architecture", title: "Architecture", type: "single", role: "architect", consumes: ["exploration", "clarifications"] };
    writeFileSync(join(artifactsDir, "exploration.json"), JSON.stringify({ files_to_read: [], summary: "s" }));
    writeFileSync(join(artifactsDir, "clarifications.json"), JSON.stringify({ questions: ["q"], answers: ["a"] }));
    const ok = validateConsumedArtifacts(stage, artifactsDir, state(), profile);
    assert.equal(ok.ok, true, "schema-valid consumed artifacts pass");
    if (ok.ok) assert.equal(ok.diagnostics.length, 2);

    writeFileSync(join(artifactsDir, "exploration.json"), JSON.stringify({ files_to_read: "not-an-array" }));
    const invalid = validateConsumedArtifacts(stage, artifactsDir, state(), profile);
    assert.equal(invalid.ok, false);
    if (!invalid.ok) {
      assert.match(invalid.error, /exploration/);
      assert.match(invalid.error, /expected type array/);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("artifact contract: consumed manual_qa enforces CONDITIONAL blocker semantics", () => {
  const root = mkdtempSync(join(tmpdir(), "ac-manual-qa-"));
  try {
    const artifactsDir = join(root, "artifacts");
    mkdirSync(artifactsDir, { recursive: true });
    const profile = loadProfile("full-feature");
    assert.ok(profile);
    writeFileSync(join(artifactsDir, "manual_qa.json"), JSON.stringify({
      verdict: "CONDITIONAL",
      evidence: ["deterministic checks passed"],
    }));
    const stage: StageDef = { id: "qa_tests", title: "QA", type: "single", role: "qa", consumes: ["manual_qa"] };
    const result = validateConsumedArtifacts(stage, artifactsDir, state(), profile);
    assert.equal(result.ok, false, "an unexplained CONDITIONAL must block consuming stages");
    if (!result.ok) assert.match(result.error, /blocked_prerequisites/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("artifact contract: missing consumed artifact blocks only when its producer is done", () => {
  const root = mkdtempSync(join(tmpdir(), "ac-missing-"));
  try {
    const artifactsDir = join(root, "artifacts");
    mkdirSync(artifactsDir, { recursive: true });
    const profile = loadProfile("full-feature");
    assert.ok(profile);
    const stage: StageDef = { id: "manual_qa", title: "Manual QA", type: "single", role: "manual-qa", consumes: ["review", "feature_spec"] };
    const withProducerDone = state({
      stages: [
        { id: "discovery", status: "done" },
        { id: "manual_qa", status: "in_progress" },
      ],
    });
    const blocked = validateConsumedArtifacts(stage, artifactsDir, withProducerDone, profile);
    assert.equal(blocked.ok, false, "missing consume with a done producer is a contract violation");
    if (!blocked.ok) assert.match(blocked.error, /while its producing stage is done/);

    // Producer pending (loop feedback on the first pass) -> legitimate absence.
    const withProducerPending = state({
      stages: [
        { id: "discovery", status: "pending" },
        { id: "manual_qa", status: "in_progress" },
      ],
    });
    const pending = validateConsumedArtifacts(stage, artifactsDir, withProducerPending, profile);
    assert.equal(pending.ok, true, "missing consume with a pending producer is a legitimate absence");
    if (pending.ok) {
      const featureSpec = pending.diagnostics.find((d) => d.id === "feature_spec");
      assert.ok(featureSpec, "feature_spec diagnostic is present");
      assert.equal(featureSpec!.missing, false, "pending producer absence is not a violation");
      assert.deepEqual(featureSpec!.issues, [], "no blocking issues for a pending producer");
    }

    // Producer skipped -> legitimate absence.
    const withProducerSkipped = state({
      stages: [
        { id: "manual_qa", status: "skipped" },
      ],
    });
    const skippedProducer: StageDef = { id: "qa_tests", title: "QA", type: "single", role: "qa", consumes: ["manual_qa"] };
    const skipped = validateConsumedArtifacts(skippedProducer, artifactsDir, withProducerSkipped, profile);
    assert.equal(skipped.ok, true, "missing consume of a skipped producer is a legitimate absence");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("artifact contract: unknown fields are allowed unless additionalProperties:false", () => {
  const ok = validateProducedArtifact("discovery", { task: "t", branch: "b", extra: "field" });
  assert.equal(ok.ok, true, "definitions do not forbid additional fields");
});

test("artifact contract: structure limits reject deep, broad, and cyclic values before schema consumers", () => {
  let deep: unknown = { verdict: "PASS", iterations: 1 };
  for (let depth = 0; depth < 65; depth += 1) deep = { next: deep };
  const deepResult = validateProducedArtifact("debug", deep);
  assert.equal(deepResult.ok, false);
  if (!deepResult.ok) assert.match(deepResult.issues[0]!.message, /artifact structure limit exceeded: nesting depth/);

  const broad = { files_touched: Array.from({ length: 16_385 }, (_, index) => `src/${index}.ts`) };
  const broadResult = validateProducedArtifact("implementation", broad);
  assert.equal(broadResult.ok, false);
  if (!broadResult.ok) assert.match(broadResult.issues[0]!.message, /artifact structure limit exceeded: array length/);

  const cyclic: Record<string, unknown> = { verdict: "PASS", iterations: 1 };
  cyclic.self = cyclic;
  const cyclicResult = validateProducedArtifact("debug", cyclic);
  assert.equal(cyclicResult.ok, false);
  if (!cyclicResult.ok) assert.match(cyclicResult.issues[0]!.message, /cyclic value/);

  const root = mkdtempSync(join(tmpdir(), "ac-structure-"));
  try {
    const artifactsDir = join(root, "artifacts");
    mkdirSync(artifactsDir, { recursive: true });
    writeFileSync(join(artifactsDir, "debug.json"), JSON.stringify(deep));
    const stage: StageDef = { id: "consumer", title: "Consumer", type: "single", role: "qa", consumes: ["debug"] };
    const consumed = validateConsumedArtifacts(stage, artifactsDir, state(), null);
    assert.equal(consumed.ok, false);
    if (!consumed.ok) assert.match(consumed.error, /could not be read: artifact structure limit exceeded/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("artifact contract: full-feature discovery produces pass schema validation end to end", () => {
  const discovery = validateProducedArtifact("discovery", { task: "t", branch: "b", constraints: [] });
  assert.equal(discovery.ok, true);
  const featureSpec = validateProducedArtifact("feature_spec", { goal: "g", scope: [], acceptance_criteria: ["a"] });
  assert.equal(featureSpec.ok, true);
  const noScope = validateProducedArtifact("feature_spec", { goal: "g", acceptance_criteria: ["a"] });
  assert.equal(noScope.ok, false);
  if (!noScope.ok) assert.match(noScope.issues[0]!.field, /\.scope$/);
});
