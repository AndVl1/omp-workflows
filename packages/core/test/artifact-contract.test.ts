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
  requiredFieldsOf,
  loadArtifactSchemas,
  type ArtifactContractPolicy,
} from "../src/engine/artifact-contract.js";
import { isRootCauseDocumented } from "../src/engine/dod.js";
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

test("artifact contract: shipped schema registry covers every workflow artifact id", () => {
  const schemas = loadArtifactSchemas();
  for (const id of ["discovery", "exploration", "clarifications", "architecture", "diagnosis", "implementation", "debug", "review", "summary", "manual_qa", "qa_tests", "feature_spec", "dod", "cto_discovery", "team_plan", "team_artifacts", "integration_review"]) {
    assert.ok(schemas[id], `schema for '${id}' must exist`);
  }
  assert.deepEqual(requiredFieldsOf("implementation"), ["files_touched"]);
  assert.deepEqual(requiredFieldsOf("debug"), ["verdict", "iterations"]);
  assert.equal(requiredFieldsOf("regression_intake"), null, "ids without a schema definition are unconstrained");
});
test("artifact contract: diagnosis schema matches root-cause gate explanation requirement", () => {
  assert.deepEqual(requiredFieldsOf("diagnosis"), ["root_cause", "explanation"]);
  const missingExplanation = validateProducedArtifact("diagnosis", { root_cause: "cause" });
  assert.equal(missingExplanation.ok, false, "schema rejects diagnosis without the gate-required explanation");
  if (!missingExplanation.ok) assert.match(missingExplanation.issues[0]!.message, /required field 'explanation' is missing/);

  const root = mkdtempSync(join(tmpdir(), "ac-diagnosis-"));
  try {
    const artifactsDir = join(root, "artifacts");
    mkdirSync(artifactsDir, { recursive: true });
    writeFileSync(join(artifactsDir, "diagnosis.json"), JSON.stringify({ root_cause: "cause" }));
    const missingGateEvidence = isRootCauseDocumented(artifactsDir);
    assert.equal(missingGateEvidence.ok, false);
    if (!missingGateEvidence.ok) assert.match(missingGateEvidence.reason, /diagnosis\.explanation is empty/);

    writeFileSync(join(artifactsDir, "diagnosis.json"), JSON.stringify({ root_cause: "cause", explanation: "why the fix closes it" }));
    assert.deepEqual(isRootCauseDocumented(artifactsDir), {
      ok: true,
      diagnosis: { root_cause: "cause", explanation: "why the fix closes it" },
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
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

test("artifact contract: unsupported schema keywords fail closed", () => {
  // Regression_intake is unconstrained today; simulate a future schema that
  // ships a keyword the subset cannot honor.
  const schemas = loadArtifactSchemas();
  const original = schemas["debug"];
  // @ts-expect-error -- test-only mutation of the parsed schema cache
  schemas["debug"] = { ...original, pattern: "^PASS$" };
  try {
    const result = validateProducedArtifact("debug", { verdict: "PASS", iterations: 1 });
    assert.equal(result.ok, false);
    if (!result.ok) assert.match(result.issues[0]!.message, /unsupported schema keyword 'pattern'/);
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

test("artifact contract: full-feature discovery produces pass schema validation end to end", () => {
  const discovery = validateProducedArtifact("discovery", { task: "t", branch: "b", constraints: [] });
  assert.equal(discovery.ok, true);
  const featureSpec = validateProducedArtifact("feature_spec", { goal: "g", scope: [], acceptance_criteria: ["a"] });
  assert.equal(featureSpec.ok, true);
  const noScope = validateProducedArtifact("feature_spec", { goal: "g", acceptance_criteria: ["a"] });
  assert.equal(noScope.ok, false);
  if (!noScope.ok) assert.match(noScope.issues[0]!.field, /\.scope$/);
});
