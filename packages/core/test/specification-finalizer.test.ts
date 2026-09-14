/** Mounted specification completion finalizer contract coverage. */
import { test } from "node:test";
import { TEST_ON, TEST_SESSION_MANAGER, TEST_SESSION_UI } from "./fixtures/registrar-host.js";
import { openTestRegistry, writeTestRegistryMarker } from "./fixtures/registry-activation.js";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z as zod } from "zod";
import { registerWorkflowTools } from "../src/index.js";
import { createCapability } from "../src/engine/durable.js";
import { loadProfile } from "../src/engine/profile.js";
import { writeArtifactWithReference } from "../src/engine/artifacts.js";
import { acquireExecutionClaim, readCurrentExecutionClaim } from "../src/specification/claims.js";
import { canonicalHandoffDigest } from "../src/specification/handoff.js";
import { ensureProjectConstitution } from "../src/specification/prerequisite.js";
import { normalizeAndPersistImplementationConformance, type ConformanceEvidence, type NormalizeAndPersistImplementationConformanceResult } from "../src/specification/conformance.js";
import { digestOf, implementationConformanceMatrixDigest } from "../src/specification/validation.js";
import { setStateTransactionTestHooks } from "../src/engine/state.js";
import { PinnedProjectRoot } from "../src/specification/pinned-root.js";
import type { FeatureWorkspace, QualityGateResult } from "../src/specification/types.js";
import {
  specPreparationProfileHash,
  sha256,
  validFeatureWorkspace,
  validImplementationConformance,
  validImplementationHandoff,
} from "./fixtures/specification-fixtures.js";

type Details = Record<string, unknown>;
type Tool = {
  name: string;
  parameters: { safeParse(value: unknown): { success: boolean } };
  execute: (...args: unknown[]) => Promise<{ details: Details }>;
};

type FinalizerFixture = {
  root: string;
  featureId: string;
  runKey: string;
  auth: Details;
  conformancePath: string;
  claimId: string;
};

type SuccessfulConformanceProduction = Extract<NormalizeAndPersistImplementationConformanceResult, { ok: true }>;


function mounted(root?: string, options: { main?: boolean } = {}): Map<string, Tool> {
  const ownedRoot = root ?? mkdtempSync(join(tmpdir(), "spec-finalizer-mount-"));
  writeTestRegistryMarker(ownedRoot);
  const sessionManager = { getSessionId: () => "spec-finalizer-main", getCwd: () => ownedRoot };
  const main = options.main !== false;
  const on = (event: string, handler: (event: unknown, ctx: unknown) => unknown): void => {
    if (event === "session_start") {
      handler({}, { cwd: ownedRoot, mode: main ? "rpc" : "print", hasUI: main, sessionManager, ...(main ? { ui: TEST_SESSION_UI } : {}) });
    }
  };
  const registration = openTestRegistry(ownedRoot, ["workflow_tools"], "spec-finalizer");
  const tools: Tool[] = [];
  const pi = {
    zod: { z: zod },
    on,
    registerTool: (raw: unknown) => {
      const tool = raw as Tool;
      tools.push({
        ...tool,
        execute: (...args: unknown[]) => {
          const last = args.at(-1);
          const context = last && typeof last === "object" && "cwd" in last ? last as Record<string, unknown> : { cwd: ownedRoot };
          const enriched = { ...context, sessionManager, mode: main ? "rpc" : "print", hasUI: main };
          const callArgs = last && typeof last === "object" && "cwd" in last ? [...args.slice(0, -1), enriched] : [...args, enriched];
          return tool.execute(...callArgs);
        },
      });
    },
  };
  registerWorkflowTools(pi as never, {
      owner: () => registration.owner,
    cwd: ownedRoot,
    registrationToken: registration.token,
    resolveCwd: (ctx: unknown) => (ctx as { cwd: string }).cwd,
  });
  registration.retain(true);
  if (!root) rmSync(ownedRoot, { recursive: true, force: true });
  return new Map(tools.map((tool) => [tool.name, tool]));
}
function setup(overall: "pass" | "fail" | "changed_intent" = "pass", options: { seedConformance?: boolean } = {}): FinalizerFixture {
  const root = mkdtempSync(join(tmpdir(), "spec-finalizer-"));
  const featureId = `finalizer-${overall.replace("_", "-")}`;
  const runKey = `run-${featureId}`;
  const featureDir = join(root, ".work-state", "features", featureId);
  const artifacts = join(featureDir, "artifacts");
  writeFileSync(join(root, "CONSTITUTION.md"), "# Project Constitution v1.0.0\n\n## I. Quality\n\nShip tested work.\n", "utf8");
  mkdirSync(join(root, "specs", featureId), { recursive: true });
  for (const directory of ["implementation_handoff", "implementation_conformance", "execution_claim/next", "execution_claim/wal"]) {
    mkdirSync(join(artifacts, directory), { recursive: true });
  }
  const constitutionGate = ensureProjectConstitution(root, {
    origin_kind: "native_direct",
    origin_run_key: runKey,
    origin_stage: "specify",
  }, { feature_id: featureId });
  assert.ok(constitutionGate.ok && constitutionGate.value.binding, constitutionGate.ok ? "constitution binding must be available" : constitutionGate.error);
  if (!constitutionGate.ok || !constitutionGate.value.binding) throw new Error("constitution fixture gate failed");
  const handoff = validImplementationHandoff({ featureId });
  handoff.constitution_binding = constitutionGate.value.binding;
  handoff.handoff_digest = canonicalHandoffDigest(handoff);
  const workspace = validFeatureWorkspace({ featureId, projectRoot: root, withApprovedSpecify: true, status: "implementation_ready", constitutionBinding: constitutionGate.value.binding });
  workspace.handoff_ref = handoff.handoff_id;
  workspace.constitution_gate_ref = constitutionGate.value.gate_id;
  workspace.profile_hash = specPreparationProfileHash();
  writeFileSync(join(artifacts, "implementation_handoff", `${handoff.handoff_id}.json`), JSON.stringify(handoff));
  const authorityProfile = loadProfile("constitution");
  if (!authorityProfile) throw new Error("constitution profile fixture is unavailable");
  const authorityProfileHash = digestOf(authorityProfile);
  const capability = createCapability({
    run_key: runKey,
    branch: "test",
    workflow: "constitution",
    profile_hash: authorityProfileHash,
    stage_cursor: "constitution_validate",
    cursor_epoch: "epoch-1",
    kind: "none",
    advance_secret: "finalizer-advance-secret",
  });
  const state: Record<string, unknown> = {
    schema: 1,
    branch: "test",
    run_key: runKey,
    classification: { type: "SPEC", complexity: "MEDIUM", confidence: "HIGH", autonomous: false, workflow: "constitution" },
    task: "complete specification execution",
    workflow_override: false,
    checkpoint_policy: authorityProfile.checkpoint_policy,
    issue: null,
    stage_cursor: "constitution_validate",
    stages: [{ id: "constitution_validate", status: "in_progress" }],
    artifacts: {},
    pause: { kind: "none", reason: "" },
    profile_hash: authorityProfileHash,
    cursor_epoch: "epoch-1",
    dispatch_capability: capability.state,
    specification: workspace,
    updated_at: new Date().toISOString(),
  };
  writeFileSync(join(featureDir, "state.json"), JSON.stringify(state));
  const acquired = acquireExecutionClaim(root, featureId, {
    handoff,
    owner_kind: "do_work",
    owner_run_id: "owner-1",
    run_key: runKey,
  });
  assert.equal(acquired.ok, true, acquired.ok ? "" : acquired.error);
  if (!acquired.ok) throw new Error(acquired.error);
  const conformancePath = join(artifacts, "implementation_conformance", "seed.json");
  if (options.seedConformance !== false) {
    const conformance = validImplementationConformance({ featureId, handoffDigest: handoff.handoff_digest });
    const canonicalImplementationPath = `.work-state/features/${featureId}/artifacts/implementation.impl.v1.json`;
    const implementationBody = JSON.stringify({ producer: "finalizer-fixture" });
    writeFileSync(join(artifacts, "implementation.impl.v1.json"), implementationBody);
    for (const entry of conformance.entries) {
      for (const reference of entry.implementation_evidence_refs) {
        reference.path = canonicalImplementationPath;
        reference.sha256 = sha256(implementationBody);
      }
      for (const reference of entry.review_evidence_refs) {
        reference.path = canonicalImplementationPath;
        reference.sha256 = sha256(implementationBody);
      }
      for (const evidence of entry.test_evidence) {
        evidence.evidence_ref.path = canonicalImplementationPath;
        evidence.evidence_ref.sha256 = sha256(implementationBody);
      }
    }
    const profileGateId = `execution-profile.${workspace.profile_hash}`;
    const profileGateArtifactId = `quality_gate_evidence-${featureId}`;
    const profileGatePath = `.work-state/features/${featureId}/artifacts/${profileGateArtifactId}.json`;
    const profileGateBody = JSON.stringify({
      schema_version: 1,
      artifact_id: profileGateArtifactId,
      gates: [{
        gate_id: profileGateId,
        source: "execution_profile",
        status: "pass",
        evidence_refs: [],
        findings: [],
        evaluated_at: "2026-08-31T12:00:00.000Z",
      }],
    });
    writeFileSync(join(root, profileGatePath), profileGateBody);
    const profileGateRef = {
      artifact_id: profileGateArtifactId,
      path: profileGatePath,
      sha256: sha256(profileGateBody),
      schema_status: "met" as const,
      quality_gate_status: "met" as const,
    };
    const constitutionGateId = `cto-handoff-constitution-binding.${handoff.handoff_id}`;
    const constitutionGateArtifactId = `quality_gate_evidence-constitution-${featureId}`;
    const constitutionGatePath = `.work-state/features/${featureId}/artifacts/${constitutionGateArtifactId}.json`;
    const constitutionGateBody = JSON.stringify({
      schema_version: 1,
      artifact_id: constitutionGateArtifactId,
      gates: [{
        gate_id: constitutionGateId,
        source: "project_constitution",
        status: "pass",
        evidence_refs: [],
        findings: [],
        evaluated_at: "2026-08-31T12:00:00.000Z",
      }],
    });
    writeFileSync(join(root, constitutionGatePath), constitutionGateBody);
    const constitutionGateRef = {
      artifact_id: constitutionGateArtifactId,
      path: constitutionGatePath,
      sha256: sha256(constitutionGateBody),
      schema_status: "met" as const,
      quality_gate_status: "met" as const,
    };
    conformance.quality_gate_results = [
      {
        gate_id: constitutionGateId,
        source: "project_constitution",
        status: "pass",
        evidence_refs: [constitutionGateRef],
        findings: [],
      },
      {
        gate_id: profileGateId,
        source: "execution_profile",
        status: "pass",
        evidence_refs: [profileGateRef],
        findings: [],
      },
    ];
    conformance.execution_claim_id = acquired.value.claim_id;
    if (overall !== "pass") {
      conformance.blocking_findings = [{
        code: overall === "changed_intent" ? "SPEC_IMPLEMENTATION_INTENT_CHANGED" : "SPEC_IMPLEMENTATION_CONFORMANCE_FAILED",
        subject_id: "FR-1",
        message: "the implementation result is not a terminal pass",
        evidence_refs: [],
      }];
      conformance.next_action = overall === "changed_intent" ? "revise_specification" : "repair_implementation";
    }
    conformance.execution_owner = acquired.value.owner_kind;
    conformance.execution_run_id = acquired.value.owner_run_id;
    conformance.profile_hash = workspace.profile_hash;
    conformance.overall_status = overall;
    conformance.matrix_digest = implementationConformanceMatrixDigest(conformance)!;
    conformance.conformance_id = `implementation-conformance.${conformance.matrix_digest}`;
    writeFileSync(join(artifacts, "implementation_conformance", `${conformance.conformance_id}.json`), JSON.stringify(conformance));
    const envelope = JSON.parse(readFileSync(join(featureDir, "state.json"), "utf8")) as { specification: { implementation_conformance_ref: string | null } };
    envelope.specification.implementation_conformance_ref = conformance.conformance_id;
    writeFileSync(join(featureDir, "state.json"), JSON.stringify(envelope));
  }
  return {
    root,
    featureId,
    runKey,
    conformancePath,
    claimId: acquired.value.claim_id,
    auth: {
      feature_id: featureId,
      run_key: runKey,
      advance_token: "finalizer-advance-secret",
      capability_id: capability.capability_id,
      branch: "test",
      workflow: "constitution",
      profile_hash: authorityProfileHash,
      stage_cursor: "constitution_validate",
      cursor_epoch: "epoch-1",
    },
  };
}
function produceConformance(fixture: FinalizerFixture, evaluatedAt = "2026-08-31T12:00:00.000Z"): {
  result: SuccessfulConformanceProduction;
  artifactPath: string;
} {
  const statePath = join(fixture.root, ".work-state", "features", fixture.featureId, "state.json");
  const state = JSON.parse(readFileSync(statePath, "utf8")) as {
    specification: Record<string, unknown>;
  };
  state.specification.project_root = realpathSync(fixture.root);
  state.specification.status = "executing";
  state.specification.execution_claim_ref = fixture.claimId;
  state.specification.implementation_conformance_ref = null;
  rmSync(fixture.conformancePath, { force: true });
  writeFileSync(statePath, JSON.stringify(state));

  const handoff = validImplementationHandoff({ featureId: fixture.featureId });
  handoff.constitution_binding = (state.specification as FeatureWorkspace).constitution_binding!;
  handoff.handoff_digest = canonicalHandoffDigest(handoff);
  const claimRead = readCurrentExecutionClaim(fixture.root, fixture.featureId);
  assert.equal(claimRead.ok, true, claimRead.ok ? "" : claimRead.error);
  if (!claimRead.ok || !claimRead.value) throw new Error("producer fixture claim is unavailable");
  const claim = claimRead.value;
  const artifactBody = JSON.stringify({ producer: "official-conformance-test" });
  const artifactPath = join(fixture.root, ".work-state", "features", fixture.featureId, "artifacts", "implementation.impl.v1.json");
  writeFileSync(artifactPath, artifactBody);
  const artifact = {
    artifact_id: "implementation.impl.v1",
    path: `.work-state/features/${fixture.featureId}/artifacts/implementation.impl.v1.json`,
    sha256: sha256(artifactBody),
    schema_status: "met" as const,
    quality_gate_status: "met" as const,
  };
  const evidence: ConformanceEvidence[] = [];
  for (const subject of [
    { subject_id: "FR-1", requirement_id: "FR-1" },
    { subject_id: "AC-1", requirement_id: "FR-1" },
  ]) {
    evidence.push(
      {
        evidence_id: `implementation-${subject.subject_id}`,
        kind: "implementation",
        subject_id: subject.subject_id,
        requirement_id: subject.requirement_id,
        handoff_digest: handoff.handoff_digest,
        execution_claim_id: claim.claim_id,
        artifact,
      },
      {
        evidence_id: `review-${subject.subject_id}`,
        kind: "review",
        subject_id: subject.subject_id,
        requirement_id: subject.requirement_id,
        handoff_digest: handoff.handoff_digest,
        execution_claim_id: claim.claim_id,
        artifact,
        review_verdict: "pass",
      },
      {
        evidence_id: `test-${subject.subject_id}`,
        kind: "executed_test",
        subject_id: subject.subject_id,
        requirement_id: subject.requirement_id,
        handoff_digest: handoff.handoff_digest,
        execution_claim_id: claim.claim_id,
        artifact,
        test: { evidence_ref: artifact, test_kind: "runtime", status: "pass", executed_at: "2026-08-31T12:00:00.000Z" },
      },
    );
  }
  const profileGateId = `execution-profile.${String(state.specification.profile_hash)}`;
  const profileGateArtifactId = `quality_gate_evidence-${fixture.featureId}`;
  const profileGatePath = `.work-state/features/${fixture.featureId}/artifacts/${profileGateArtifactId}.json`;
  const profileGateBody = JSON.stringify({
    schema_version: 1,
    artifact_id: profileGateArtifactId,
    gates: [{
      gate_id: profileGateId,
      source: "execution_profile",
      status: "pass",
      evidence_refs: [],
      findings: [],
      evaluated_at: "2026-08-31T12:00:00.000Z",
    }],
  });
  writeFileSync(join(fixture.root, profileGatePath), profileGateBody);
  const profileGateRef = {
    artifact_id: profileGateArtifactId,
    path: profileGatePath,
    sha256: sha256(profileGateBody),
    schema_status: "met" as const,
    quality_gate_status: "met" as const,
  };
  const constitutionGateId = `cto-handoff-constitution-binding.${handoff.handoff_id}`;
  const constitutionGateArtifactId = `quality_gate_evidence-constitution-${fixture.featureId}`;
  const constitutionGatePath = `.work-state/features/${fixture.featureId}/artifacts/${constitutionGateArtifactId}.json`;
  const constitutionGateBody = JSON.stringify({
    schema_version: 1,
    artifact_id: constitutionGateArtifactId,
    gates: [{
      gate_id: constitutionGateId,
      source: "project_constitution",
      status: "pass",
      evidence_refs: [],
      findings: [],
      evaluated_at: "2026-08-31T12:00:00.000Z",
    }],
  });
  writeFileSync(join(fixture.root, constitutionGatePath), constitutionGateBody);
  const constitutionGateRef = {
    artifact_id: constitutionGateArtifactId,
    path: constitutionGatePath,
    sha256: sha256(constitutionGateBody),
    schema_status: "met" as const,
    quality_gate_status: "met" as const,
  };
  const qualityGates: QualityGateResult[] = [
    {
      gate_id: constitutionGateId,
      source: "project_constitution",
      status: "pass",
      evidence_refs: [constitutionGateRef],
      findings: [],
    },
    {
      gate_id: profileGateId,
      source: "execution_profile",
      status: "pass",
      evidence_refs: [profileGateRef],
      findings: [],
    },
  ];
  const produced = normalizeAndPersistImplementationConformance({
    handoff,
    claim,
    profile_hash: state.specification.profile_hash as string,
    evidence,
    quality_gates: qualityGates,
    evaluated_at: evaluatedAt,
    workspace: state.specification as FeatureWorkspace,
    project_root: fixture.root,
    active_owner_kind: claim.owner_kind,
    active_owner_run_id: claim.owner_run_id,
    allowed_artifact_paths: [artifact.path, profileGatePath, constitutionGatePath],
  });
  assert.equal(produced.ok, true, produced.ok ? "" : produced.issues.join("; "));
  if (!produced.ok) throw new Error(produced.issues.join("; "));
  const producedPath = join(fixture.root, produced.artifact_ref.path);
  state.specification.implementation_conformance_ref = produced.artifact_ref.artifact_id;
  writeFileSync(statePath, JSON.stringify(state));
  return { result: produced, artifactPath: producedPath };
}
async function produceMountedDoWorkConformance(
  fixture: FinalizerFixture,
  transform?: (evidence: ConformanceEvidence[]) => ConformanceEvidence[],
  gateTransform?: (gates: QualityGateResult[]) => QualityGateResult[],
): Promise<{ details: Details }> {
  const statePath = join(fixture.root, ".work-state", "features", fixture.featureId, "state.json");
  const state = JSON.parse(readFileSync(statePath, "utf8")) as { specification: FeatureWorkspace };
  const handoff = validImplementationHandoff({ featureId: fixture.featureId });
  handoff.constitution_binding = (state.specification as FeatureWorkspace).constitution_binding!;
  handoff.handoff_digest = canonicalHandoffDigest(handoff);
  const claimRead = readCurrentExecutionClaim(fixture.root, fixture.featureId);
  assert.equal(claimRead.ok, true, claimRead.ok ? "" : claimRead.error);
  if (!claimRead.ok || !claimRead.value) throw new Error("generic producer fixture claim is unavailable");
  const claim = claimRead.value;
  const artifactBody = JSON.stringify({ producer: "mounted-generic-conformance-test" });
  const artifactPath = join(fixture.root, ".work-state", "features", fixture.featureId, "artifacts", "implementation.impl.v1.json");
  writeFileSync(artifactPath, artifactBody);
  const artifact = {
    artifact_id: "implementation.impl.v1",
    path: `.work-state/features/${fixture.featureId}/artifacts/implementation.impl.v1.json`,
    sha256: sha256(artifactBody),
    schema_status: "met" as const,
    quality_gate_status: "met" as const,
  };
  const evidence: ConformanceEvidence[] = [];
  for (const subject of [
    { subject_id: "FR-1", requirement_id: "FR-1" },
    { subject_id: "AC-1", requirement_id: "FR-1" },
  ]) {
    evidence.push(
      { evidence_id: `implementation-${subject.subject_id}`, kind: "implementation", subject_id: subject.subject_id, requirement_id: subject.requirement_id, handoff_digest: handoff.handoff_digest, execution_claim_id: claim.claim_id, artifact },
      { evidence_id: `review-${subject.subject_id}`, kind: "review", subject_id: subject.subject_id, requirement_id: subject.requirement_id, handoff_digest: handoff.handoff_digest, execution_claim_id: claim.claim_id, artifact, review_verdict: "pass" },
      { evidence_id: `test-${subject.subject_id}`, kind: "executed_test", subject_id: subject.subject_id, requirement_id: subject.requirement_id, handoff_digest: handoff.handoff_digest, execution_claim_id: claim.claim_id, artifact, test: { evidence_ref: artifact, test_kind: "runtime", status: "pass", executed_at: "2026-08-31T12:00:00.000Z" } },
    );
  }
  const profileHash = state.specification.profile_hash as string;
  const profileProofId = `conformance_evidence-profile-${fixture.featureId}`;
  const profileProofPath = `.work-state/features/${fixture.featureId}/artifacts/${profileProofId}.json`;
  const profileProofBody = JSON.stringify({
    schema_version: 1,
    artifact_id: profileProofId,
    entries: [{
      evidence_id: `profile-proof-${fixture.featureId}`,
      kind: "implementation",
      subject_id: "FR-1",
      requirement_id: "FR-1",
      handoff_digest: handoff.handoff_digest,
      execution_claim_id: claim.claim_id,
      recorded_at: "2026-08-31T12:00:00.000Z",
    }],
  });
  writeFileSync(join(fixture.root, profileProofPath), profileProofBody);
  const profileProof = {
    artifact_id: profileProofId,
    path: profileProofPath,
    sha256: sha256(profileProofBody),
    schema_status: "met" as const,
    quality_gate_status: "met" as const,
  };
  const profileGateId = `quality_gate_evidence-${fixture.featureId}`;
  const profileGatePath = `.work-state/features/${fixture.featureId}/artifacts/${profileGateId}.json`;
  const profileGateBody = JSON.stringify({
    schema_version: 1,
    artifact_id: profileGateId,
    gates: [{
      gate_id: `execution-profile.${profileHash}`,
      source: "execution_profile",
      status: "pass",
      evidence_refs: [profileProof],
      findings: [],
      evaluated_at: "2026-08-31T12:00:00.000Z",
    }],
  });
  writeFileSync(join(fixture.root, profileGatePath), profileGateBody);
  const profileGate: QualityGateResult = {
    gate_id: `execution-profile.${profileHash}`,
    source: "execution_profile",
    status: "pass",
    evidence_refs: [{
      artifact_id: profileGateId,
      path: profileGatePath,
      sha256: sha256(profileGateBody),
      schema_status: "met",
      quality_gate_status: "met",
    }],
    findings: [],
  };
  const constitutionGateId = `cto-handoff-constitution-binding.${handoff.handoff_id}`;
  const constitutionGateArtifactId = `quality_gate_evidence-constitution-${fixture.featureId}`;
  const constitutionGatePath = `.work-state/features/${fixture.featureId}/artifacts/${constitutionGateArtifactId}.json`;
  const constitutionGateBody = JSON.stringify({
    schema_version: 1,
    artifact_id: constitutionGateArtifactId,
    gates: [{
      gate_id: constitutionGateId,
      source: "project_constitution",
      status: "pass",
      evidence_refs: [],
      findings: [],
      evaluated_at: "2026-08-31T12:00:00.000Z",
    }],
  });
  writeFileSync(join(fixture.root, constitutionGatePath), constitutionGateBody);
  const constitutionGate: QualityGateResult = {
    gate_id: constitutionGateId,
    source: "project_constitution",
    status: "pass",
    evidence_refs: [{
      artifact_id: constitutionGateArtifactId,
      path: constitutionGatePath,
      sha256: sha256(constitutionGateBody),
      schema_status: "met",
      quality_gate_status: "met",
    }],
    findings: [],
  };
  const qualityGates: QualityGateResult[] = [profileGate, constitutionGate];
  const tool = mounted(fixture.root).get("workflow_specification_conformance")!
  return tool.execute("generic-producer", {
    feature_id: fixture.featureId,
    run_key: fixture.runKey,
    evidence: transform ? transform(evidence) : evidence,
    quality_gates: gateTransform ? gateTransform(qualityGates) : qualityGates,
    evaluated_at: "2026-08-31T12:00:00.000Z",
  }, undefined, undefined, { cwd: fixture.root });
}
test("mounted generic producer adopts conformance before finalizer without caller state mutation", async () => {
  const fixture = setup("pass", { seedConformance: false });
  try {
    const produced = await produceMountedDoWorkConformance(fixture);
    assert.equal(produced.details.status, "persisted", JSON.stringify(produced.details));
    assert.equal(typeof produced.details.conformance_id, "string");
    const stateBeforeFinalizer = JSON.parse(readFileSync(join(fixture.root, ".work-state", "features", fixture.featureId, "state.json"), "utf8")) as { specification: FeatureWorkspace };
    assert.equal(stateBeforeFinalizer.specification.implementation_conformance_ref, produced.details.conformance_id);
    const finalizer = mounted(fixture.root).get("workflow_complete_specification_execution")!
    const completed = await finalizer.execute("generic-finalizer", fixture.auth, undefined, undefined, { cwd: fixture.root });
    assert.equal(completed.details.ok, true, JSON.stringify(completed.details));
    assert.equal(completed.details.workspace.status, "completed");
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("blocked generic conformance does not adopt and a corrected retry can pass", async () => {
  const fixture = setup("pass", { seedConformance: false });
  try {
    const blocked = await produceMountedDoWorkConformance(
      fixture,
      (evidence) => evidence.filter((item) => item.kind !== "review"),
    );
    assert.equal(blocked.details.status, "blocked", JSON.stringify(blocked.details));
    const afterBlocked = JSON.parse(readFileSync(join(fixture.root, ".work-state", "features", fixture.featureId, "state.json"), "utf8")) as { specification: FeatureWorkspace };
    assert.equal(afterBlocked.specification.implementation_conformance_ref, null, "blocked matrix must not be adopted");

    const corrected = await produceMountedDoWorkConformance(fixture);
    assert.equal(corrected.details.status, "persisted", JSON.stringify(corrected.details));
    const afterCorrected = JSON.parse(readFileSync(join(fixture.root, ".work-state", "features", fixture.featureId, "state.json"), "utf8")) as { specification: FeatureWorkspace };
    assert.equal(afterCorrected.specification.implementation_conformance_ref, corrected.details.conformance_id);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});
test("generic conformance adoption failure removes only its newly-created artifact", async () => {
  const fixture = setup("pass", { seedConformance: false });
  let injected = false;
  try {
    setStateTransactionTestHooks({
      beforeCas: ({ sourcePath }) => {
        if (injected || !sourcePath.endsWith(`/features/${fixture.featureId}/state.json`)) return;
        injected = true;
        const raced = JSON.parse(readFileSync(sourcePath, "utf8")) as { specification: FeatureWorkspace };
        raced.specification.next_action = { ...raced.specification.next_action, reason: "concurrent state update" };
        writeFileSync(sourcePath, JSON.stringify(raced));
      },
    }, fixture.root);
    const failed = await produceMountedDoWorkConformance(fixture);
    assert.equal(failed.details.status, "blocked", JSON.stringify(failed.details));
    assert.equal(injected, true, "state CAS race must be injected after artifact publication");
    const conformanceDirectory = join(fixture.root, ".work-state", "features", fixture.featureId, "artifacts", "implementation_conformance");
    assert.deepEqual(readdirSync(conformanceDirectory).filter((entry) => entry.startsWith("implementation-conformance.")), [], "the newly-created artifact is cleaned after adoption failure");
  } finally {
    setStateTransactionTestHooks(null, fixture.root);
  }
  try {
    const retry = await produceMountedDoWorkConformance(fixture);
    assert.equal(retry.details.status, "persisted", JSON.stringify(retry.details));
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("mounted generic producer requires the exact current execution-profile gate", async () => {
  const fixture = setup("pass", { seedConformance: false });
  try {
    const omitted = await produceMountedDoWorkConformance(fixture, undefined, () => []);
    assert.equal(omitted.details.status, "blocked", JSON.stringify(omitted.details));
    assert.match(String((omitted.details.findings as string[])[0]), /mandatory execution-profile quality gate/i);
    const afterOmission = JSON.parse(readFileSync(join(fixture.root, ".work-state", "features", fixture.featureId, "state.json"), "utf8")) as { specification: FeatureWorkspace };
    assert.equal(afterOmission.specification.implementation_conformance_ref, null);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }

  const wrongFixture = setup("pass", { seedConformance: false });
  try {
    const wrong = await produceMountedDoWorkConformance(wrongFixture, undefined, (gates) => [{ ...gates[0]!, gate_id: `execution-profile.${"0".repeat(64)}` }]);
    assert.equal(wrong.details.status, "blocked", JSON.stringify(wrong.details));
    assert.match(String((wrong.details.findings as string[])[0]), /mandatory execution-profile quality gate/i);
    const afterWrong = JSON.parse(readFileSync(join(wrongFixture.root, ".work-state", "features", wrongFixture.featureId, "state.json"), "utf8")) as { specification: FeatureWorkspace };
    assert.equal(afterWrong.specification.implementation_conformance_ref, null);
  } finally {
    rmSync(wrongFixture.root, { recursive: true, force: true });
  }

  const staleFixture = setup("pass", { seedConformance: false });
  try {
    const stale = await produceMountedDoWorkConformance(staleFixture, undefined, (gates) => [{
      ...gates[0]!,
      evidence_refs: gates[0]!.evidence_refs.map((reference) => ({ ...reference, sha256: "0".repeat(64) })),
    }]);
    assert.equal(stale.details.status, "blocked", JSON.stringify(stale.details));
    assert.match(String((stale.details.findings as string[])[0]), /digest|current|quality_gate_evidence/i);
    const afterStale = JSON.parse(readFileSync(join(staleFixture.root, ".work-state", "features", staleFixture.featureId, "state.json"), "utf8")) as { specification: FeatureWorkspace };
    assert.equal(afterStale.specification.implementation_conformance_ref, null);
  } finally {
    rmSync(staleFixture.root, { recursive: true, force: true });
  }
});

test("mounted generic conformance schema uses engine conformance finding shape", () => {
  const fixture = setup();
  try {
    const tool = mounted(fixture.root).get("workflow_specification_conformance")!
  const reference = {
    artifact_id: "proof",
    path: ".work-state/features/feature/artifacts/proof.json",
    sha256: "0".repeat(64),
    schema_status: "met",
    quality_gate_status: "met",
  };
  const base = {
    feature_id: "feature",
    run_key: "run",
    evidence: [{
      evidence_id: "evidence",
      kind: "implementation",
      subject_id: "FR-1",
      requirement_id: null,
      handoff_digest: "0".repeat(64),
      execution_claim_id: "claim",
      artifact: reference,
    }],
    quality_gates: [{
      gate_id: "execution-profile." + "0".repeat(64),
      source: "execution_profile",
      status: "pass",
      evidence_refs: [],
      findings: [],
    }],
  };
  assert.equal(tool.parameters.safeParse({
    ...base,
    quality_gates: [{ ...base.quality_gates[0], findings: [{ finding_id: "legacy", severity: "blocking", message: "legacy", evidence_refs: [] }] }],
  }).success, false);
  assert.equal(tool.parameters.safeParse({
    ...base,
    quality_gates: [{ ...base.quality_gates[0], findings: [{ code: "finding", subject_id: null, message: "finding", evidence_refs: [] }] }],
  }).success, true);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});


test("official conformance producer writes the exact nested artifact consumed by finalizer", async () => {
  const fixture = setup();
  try {
    const produced = produceConformance(fixture);
    const finalizer = mounted(fixture.root).get("workflow_complete_specification_execution")!
    const completed = await finalizer.execute("producer", fixture.auth, undefined, undefined, { cwd: fixture.root });
    const producerResult = produced.result.result;
    assert.equal(completed.details.ok, true, JSON.stringify({
      completed: completed.details.error,
      status: producerResult.overall_status,
      findings: producerResult.blocking_findings,
      entries: producerResult.entries.map((entry) => ({ subject_id: entry.subject_id, status: entry.status, findings: entry.findings })),
      gates: producerResult.quality_gate_results,
    }));
    assert.equal(completed.details.workspace.status, "completed");
    assert.equal(completed.details.workspace.implementation_conformance_ref, produced.result.artifact_ref.artifact_id);
    const persisted = JSON.parse(readFileSync(produced.artifactPath, "utf8")) as { conformance_id: string; matrix_digest: string };
    assert.equal(persisted.conformance_id, produced.result.result.conformance_id);
    assert.equal(persisted.matrix_digest, produced.result.result.matrix_digest);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});


test("official conformance producer replays the stored canonical matrix when only evaluated_at changes", () => {
  const fixture = setup();
  try {
    const first = produceConformance(fixture, "2026-08-31T12:00:00.000Z");
    const firstBytes = readFileSync(first.artifactPath, "utf8");
    const second = produceConformance(fixture, "2026-08-31T12:01:00.000Z");
    const secondBytes = readFileSync(second.artifactPath, "utf8");
    assert.equal(second.result.result.conformance_id, first.result.result.conformance_id);
    assert.deepEqual(second.result.artifact_ref, first.result.artifact_ref);
    assert.equal(secondBytes, firstBytes, "replay must return the stored canonical bytes, not the volatile timestamp");
    assert.equal(JSON.parse(secondBytes).evaluated_at, "2026-08-31T12:00:00.000Z");
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("finalizer rejects forged conformance overwrite and canonical writer rejects mutable replacement", async () => {
  const fixture = setup();
  try {
    const produced = produceConformance(fixture);
    const result = produced.result;
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.throws(
      () => writeArtifactWithReference(
        fixture.root,
        join(fixture.root, ".work-state", "features", fixture.featureId, "artifacts", "implementation_conformance"),
        result.result.conformance_id,
        { ...result.result, overall_status: "blocked" },
        { schema_status: "met", quality_gate_status: "met" },
      ),
      /already exists with different content/,
    );
    writeFileSync(produced.artifactPath, JSON.stringify({ ...result.result, overall_status: "blocked" }));
    const finalizer = mounted(fixture.root).get("workflow_complete_specification_execution")!
    const rejected = await finalizer.execute("forged", fixture.auth, undefined, undefined, { cwd: fixture.root });
    assert.equal(rejected.details.ok, false);
    assert.equal(rejected.details.code, "SPEC_IMPLEMENTATION_CONFORMANCE_FAILED");
    const recomputed = {
      ...result.result,
      overall_status: "blocked" as const,
      next_action: "repair_implementation" as const,
      blocking_findings: [{ code: "SPEC_IMPLEMENTATION_CONFORMANCE_FAILED", subject_id: "FR-1", message: "forged recomputed matrix", evidence_refs: [] }],
    };
    recomputed.matrix_digest = implementationConformanceMatrixDigest(recomputed)!;
    recomputed.conformance_id = `implementation-conformance.${recomputed.matrix_digest}`;
    writeFileSync(produced.artifactPath, JSON.stringify(recomputed));
    const recomputedRejected = await finalizer.execute("forged-recomputed", fixture.auth, undefined, undefined, { cwd: fixture.root });
    assert.equal(recomputedRejected.details.ok, false);
    assert.equal(recomputedRejected.details.code, "SPEC_IMPLEMENTATION_CONFORMANCE_FAILED");
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("mounted finalizer exposes strict auth-only schema and rejects non-main context", async () => {
  const tools = mounted();
  const finalizer = tools.get("workflow_complete_specification_execution")!;
  const shape = { feature_id: "feature-one", run_key: "run-feature-one", advance_token: "secret", capability_id: "capability", branch: "test", workflow: "standard", profile_hash: "profile", stage_cursor: "execution", cursor_epoch: "epoch" };
  assert.equal(finalizer.parameters.safeParse({ ...shape, unexpected: true }).success, false);
  const root = mkdtempSync(join(tmpdir(), "spec-finalizer-context-"));
  try {
    const rejected = mounted(root, { main: false }).get("workflow_complete_specification_execution")!;
    const result = await rejected.execute("id", {}, undefined, undefined, { cwd: root, sessionManager: TEST_SESSION_MANAGER });
    assert.equal(result.details.code, "WORKFLOW_CONTEXT_REJECTED");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("mounted finalizer completes exact passing evidence, replays, and does not advance", async () => {
  const fixture = setup();
  try {
    const finalizer = mounted(fixture.root).get("workflow_complete_specification_execution")!
    const first = await finalizer.execute("id", fixture.auth, undefined, undefined, { cwd: fixture.root });
    assert.equal(first.details.ok, true, first.details.error ?? JSON.stringify(first.details));
    assert.equal(first.details.workspace.status, "completed");
    assert.equal(first.details.claim.claim_id, fixture.claimId);
    const replay = await finalizer.execute("id-2", fixture.auth, undefined, undefined, { cwd: fixture.root });
    assert.equal(replay.details.ok, true, replay.details.error ?? JSON.stringify(replay.details));
    assert.equal(replay.details.replayed, true);
    const state = JSON.parse(readFileSync(join(fixture.root, ".work-state", "features", fixture.featureId, "state.json"), "utf8"));
    assert.equal(state.stage_cursor, "constitution_validate");
    assert.equal(state.specification.status, "completed");
  } finally { rmSync(fixture.root, { recursive: true, force: true }); }
});

test("mounted finalizer fails closed for nonpass and changed-intent conformance", async () => {
  for (const overall of ["fail", "changed_intent"] as const) {
    const fixture = setup(overall);
    try {
      const finalizer = mounted(fixture.root).get("workflow_complete_specification_execution")!
      const result = await finalizer.execute("id", fixture.auth, undefined, undefined, { cwd: fixture.root });
      assert.equal(result.details.ok, false);
      assert.equal(result.details.code, overall === "changed_intent" ? "SPEC_IMPLEMENTATION_INTENT_CHANGED" : "SPEC_IMPLEMENTATION_CONFORMANCE_FAILED");
      const state = JSON.parse(readFileSync(join(fixture.root, ".work-state", "features", fixture.featureId, "state.json"), "utf8"));
      assert.notEqual(state.specification.status, "completed");
    } finally { rmSync(fixture.root, { recursive: true, force: true }); }
  }
});

test("mounted finalizer requires exact capability authorization", async () => {
  const fixture = setup();
  try {
    const finalizer = mounted(fixture.root).get("workflow_complete_specification_execution")!
    const result = await finalizer.execute("id", { ...fixture.auth, advance_token: "wrong" }, undefined, undefined, { cwd: fixture.root });
    assert.equal(result.details.ok, false);
    assert.equal(result.details.code, "SPEC_STATE_INVALID");
    assert.match(result.details.error, /invalid secret/);
  } finally { rmSync(fixture.root, { recursive: true, force: true }); }
});
