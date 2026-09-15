import { writeTestArtifact } from "./fixtures/artifacts.js";
import assert from "node:assert/strict";
import { TEST_CONTEXT, TEST_SESSION_MANAGER } from "./fixtures/registrar-host.js";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, existsSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, realpathSync } from "node:path";
import test from "node:test";
import {
  advanceCursor,
  createCapability,
  finalizeImportedHandoff,
  recordCheckpointDecision,
  validateCheckpointAskSelected,
} from "../src/engine/durable.js";
import { openTestRegistry, writeTestRegistryMarker } from "./fixtures/registry-activation.js";
import { readExecutionClaimStore } from "../src/specification/claims.js";
import { z as zod } from "zod";
import { buildCompatibilityReport, createCompatibilitySupplement, importExternalSpecification, revalidateImportedHandoffForDispatch } from "../src/specification/import.js";
import { ensureProjectConstitution, resolveCurrentConstitutionBinding } from "../src/specification/prerequisite.js";
import { loadProfile, profileHash } from "../src/engine/profile.js";
import { resolveState, setStateTransactionTestHooks, writeState } from "../src/engine/state.js";
import type { CompatibilitySupplement, FeatureWorkspace, ImportSnapshot, ImplementationHandoff } from "../src/specification/types.js";
import { validConstitutionBinding, validFeatureWorkspace, bindFeatureWorkspaceToRoot } from "./fixtures/specification-fixtures.js";
import { registerTeamWorkflow, registerWorkflowTools } from "../src/index.js";

const sha256 = (value: string | Uint8Array): string => createHash("sha256").update(value).digest("hex");

function initGit(root: string): void {
  execFileSync("git", ["-C", root, "init", "--quiet", "--initial-branch", "main"], { stdio: "ignore" });
}

type FinalizerInput = {
  feature_id: string;
  advance_token: string;
  capability_id: string;
  run_key: string;
  branch: string;
  workflow: "spec-import";
  profile_hash: string;
  stage_cursor: "handoff";
  cursor_epoch: number;
  evidence: string;
};
type LanguageOptions = {
  documentLanguage?: string;
  documentLanguageMetadata?: string;
};

async function makeImportedFixture(hostileMarker?: string, withSupplement = false, languageOptions: LanguageOptions = {}): Promise<{ root: string; sourceRoot: string; featureId: string; runKey: string; finalizerInput: () => FinalizerInput; snapshot: ImportSnapshot }> {

  const root = mkdtempSync(join(tmpdir(), "import-handoff-finalizer-"));
  initGit(root);
  const sourceRoot = join(root, "external-source");
  mkdirSync(sourceRoot, { recursive: true });
  mkdirSync(join(root, "specs", "imported-finalizer"), { recursive: true });
  writeFileSync(join(root, "CONSTITUTION.md"), "# Project Constitution v1.0.0\n\n## I. Quality\n\nShip tested work.\n", "utf8");
  const ensuredConstitution = ensureProjectConstitution(root, {
    origin_kind: "external_import",
    origin_run_key: "imported-finalizer-run",
    origin_stage: "spec_import",
  });
  assert.equal(ensuredConstitution.ok, true, ensuredConstitution.ok ? "" : ensuredConstitution.error);
  writeFileSync(join(sourceRoot, "requirements.md"), `# Requirements\n\n## Requirements\n\n### FR-101\nThe service retries a timed-out charge.${hostileMarker ? ` ${hostileMarker}` : ""}\n\n### A-101 (observable)\nA retry is visible.\n`, "utf8");
  writeFileSync(join(sourceRoot, "decisions.md"), withSupplement ? "# Decisions\n\n" : "# Decisions\n\n## D-101. Fixed backoff\nUse a bounded schedule. Traces to FR-101.\n", "utf8");
  writeFileSync(join(sourceRoot, "tasks.md"), "# Tasks\n\n## T-101. Implement retry\nImplements FR-101. Depends on: none.\n\n- Expected outcome: one bounded retry.\n- Affected scope: src/retry.ts.\n- Verification evidence: retry test.\n", "utf8");
  writeFileSync(join(sourceRoot, "ignored.bin"), "unsupported candidate bytes\n", "utf8");
  mkdirSync(join(sourceRoot, ".git"), { recursive: true });
  mkdirSync(join(sourceRoot, "node_modules", "dependency"), { recursive: true });
  mkdirSync(join(sourceRoot, ".work-state"), { recursive: true });
  writeFileSync(join(sourceRoot, ".git", "config"), "[core]\nrepositoryformatversion = 0\n", "utf8");
  writeFileSync(join(sourceRoot, "node_modules", "dependency", "package.json"), "{}\n", "utf8");
  writeFileSync(join(sourceRoot, ".work-state", "runtime.json"), "{}\n", "utf8");
  const featureId = "imported-finalizer";
  const runKey = "imported-finalizer-run";
  const bundle = await importExternalSpecification({
    sourcePath: sourceRoot,
    rootDir: root,
    feature: featureId,
    run: runKey,
    ...(languageOptions.documentLanguage !== undefined ? { documentLanguage: languageOptions.documentLanguage } : {}),
    ...(languageOptions.documentLanguageMetadata !== undefined ? { documentLanguageMetadata: languageOptions.documentLanguageMetadata } : {}),
  });
  const constitutionResult = resolveCurrentConstitutionBinding(root);
  assert.equal(constitutionResult.ok, true, constitutionResult.ok ? "" : constitutionResult.error);
  if (!constitutionResult.ok) throw new Error(constitutionResult.error);
  const constitution = constitutionResult.value;
  let evaluation = buildCompatibilityReport({ bundle, constitution_binding: constitution, framework: "generic" });
  let supplement: CompatibilitySupplement | null = null;
  if (withSupplement) {
    assert.equal(evaluation.report.status, "supplement_required", "fixture must require a compatibility supplement before recovery");
    supplement = createCompatibilitySupplement({
      report: evaluation.report,
      feature_id: featureId,
      source_sha256: bundle.sourceHash,
      approved_by_ref: "test-human",
      approved_at: "2026-01-01T00:00:00.000Z",
      semantic_rows: [{
        contract_subject: "decision",
        subject_id: "D-101",
        statement: "Use a bounded retry schedule.",
        source_refs: ["external-source/requirements.md"],
        requirement_ids: ["FR-101"],
        acceptance_ids: ["A-101"],
        depends_on: [],
        rationale: "The retry contract needs an explicit decision.",
        expected_outcome: "Retries remain bounded.",
        affected_scope: ["src/retry.ts"],
        completion_evidence: ["retry test"],
      }],
      sections: [{
        title: "Decisions",
        missing_or_conflict: "The external source did not state the retry decision.",
        source_refs: ["external-source/requirements.md"],
      }],
    });
    evaluation = buildCompatibilityReport({ bundle, constitution_binding: constitution, framework: "generic", supplement });
    assert.equal(evaluation.report.status, "ready", "canonical supplement must close the decision gap");
  }
  assert.equal(evaluation.report.status, "ready");
  const snapshot = bundle.importSnapshot;
  const artifactsDir = join(root, ".work-state", "features", featureId, "artifacts");
  writeTestArtifact(root, artifactsDir, "import_snapshot", snapshot);
  writeTestArtifact(root, artifactsDir, "compatibility_report", evaluation.report);
  if (supplement !== null) writeTestArtifact(root, artifactsDir, "compatibility_supplement", supplement);
  const profile = loadProfile("spec-import");
  assert.ok(profile);
  if (!profile) throw new Error("missing spec-import profile");
  const workspace = validFeatureWorkspace({ featureId, sourceKind: "external", projectRoot: root, constitutionBinding: constitution }) as unknown as FeatureWorkspace;
  workspace.constitution_gate_ref = ensuredConstitution.ok ? ensuredConstitution.value.gate_id : null;
  assert.ok(workspace.constitution_gate_ref, "fixture must persist the ensured constitution gate identity");
  bindFeatureWorkspaceToRoot(workspace, root);
  workspace.profile_name = "spec-import";
  workspace.profile_hash = profileHash(profile);
  workspace.import_ref = snapshot.snapshot_id;
  workspace.status = "in_progress";
  workspace.next_action = { kind: "checkpoint", command: null, reason: "Compatibility validation passed; approval is open." };
  const issued = createCapability({ run_key: runKey, branch: "main", workflow: "spec-import", profile_hash: profileHash(profile), stage_cursor: "compatibility_approval", kind: "none", expected_roster: [], dispatch_secret: "dispatch-secret", advance_secret: "advance-secret" });
  const state = {
    schema: 1,
    branch: "main",
    classification: { type: "SPEC", complexity: "MEDIUM", confidence: "HIGH", autonomous: false, workflow: "spec-import" as const },
    task: "Read-only external specification compatibility validation",
    workflow_override: false,
    issue: null,
    run_key: runKey,
    stage_cursor: "compatibility_approval",
    stages: profile.stages.map(stage => ({ id: stage.id, status: stage.id === "compatibility_approval" ? "in_progress" as const : "done" as const })),
    artifacts: {},
    pause: { kind: "none", reason: "" },
    profile_hash: profileHash(profile),
    cursor_epoch: issued.state.issued_for!.cursor_epoch,
    dispatch_capability: issued.state,
    specification: workspace,
    state_revision: 0,
    updated_at: new Date().toISOString(),
  };
  writeState(root, state, { featureSlug: featureId });
  const approvalInput = {
    feature_id: featureId,
    token: issued.advance_token,
    capability_id: issued.state.capability_id!,
    run_key: runKey,
    branch: "main",
    workflow: "spec-import" as const,
    profile_hash: profileHash(profile),
    stage_cursor: "compatibility_approval",
    cursor_epoch: issued.state.issued_for!.cursor_epoch,
    checkpoint: "import_compatibility_approval",
    checkpoint_id: "import_compatibility_approval",
    checkpoint_kind: "custom" as const,
    loop_iteration: 1,
  };
  const preflight = validateCheckpointAskSelected(root, approvalInput);
  assert.equal(preflight.ok, true, preflight.ok ? "" : preflight.error);
  if (!preflight.ok) throw new Error(preflight.error);
  const { token, ...selectedApprovalInput } = approvalInput;
  const askResult = await mountedImportCheckpointAsk(root, {
    ...selectedApprovalInput,
    advance_token: token,
  });
  assert.equal(askResult.ok, true, JSON.stringify(askResult));
  assert.equal(askResult.decision, "approve_continue", "import approval must be selected through the mounted host Ask");
  const advanced = advanceCursor(root, {
    feature_id: featureId,
    token: issued.advance_token,
    capability_id: issued.state.capability_id!,
    run_key: runKey,
    branch: "main",
    workflow: "spec-import",
    profile_hash: profileHash(profile),
    stage_cursor: "compatibility_approval",
    cursor_epoch: issued.state.issued_for!.cursor_epoch,
    evidence: "approved compatibility report",
  });
  assert.equal(advanced.ok, true, advanced.ok ? "" : advanced.error);
  if (!advanced.ok || !advanced.handoff) throw new Error("approval advance did not return handoff");
  const handoff = advanced.handoff;
  const finalizerInput = () => finalizerInputFromState(root, featureId, runKey, handoff.advance_token);
  return { root, sourceRoot, featureId, runKey, finalizerInput, snapshot };
}

function finalizerInputFromState(root: string, featureId: string, runKey: string, advanceToken: string) {
  const selected = resolveState(root, undefined, { feature_id: featureId, run_key: runKey });
  assert.ok(selected.state, "selected finalizer state must resolve");
  if (!selected.state) throw new Error("state missing");
  const cap = selected.state.dispatch_capability;
  assert.ok(cap?.capability_id && cap.issued_for?.cursor_epoch);
  if (!cap?.capability_id || !cap.issued_for?.cursor_epoch) throw new Error("handoff capability missing");
  return {
    feature_id: featureId,
    advance_token: advanceToken,
    capability_id: cap.capability_id,
    run_key: runKey,
    branch: "main",
    workflow: "spec-import" as const,
    profile_hash: selected.state.profile_hash!,
    stage_cursor: "handoff" as const,
    cursor_epoch: cap.issued_for.cursor_epoch,
    evidence: "finalize approved imported handoff",
  };
}
type PublicTool = {
  name: string;
  parameters: { safeParse(value: unknown): { success: boolean } };
  execute: (...args: unknown[]) => Promise<{ details: Record<string, unknown> }>;
};

const mountedImportTools = new Map<string, Map<string, PublicTool>>();

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function recordValue(value: unknown, label: string): Record<string, unknown> {
  assert.ok(isRecord(value), `${label} must be a record`);
  return value;
}

function mountImportTools(root: string): Map<string, PublicTool> {
  const existing = mountedImportTools.get(root);
  if (existing) return existing;
  const registered: PublicTool[] = [];
  const pi = {
    zod: { z: zod },
    setLabel: () => {},
    on: (event: string, handler: (event: unknown, ctx: unknown) => unknown) => {
      if (event === "session_start") handler({}, TEST_CONTEXT(root));
    },
    registerTool: (tool: unknown) => registered.push(tool as PublicTool),
  };
  writeTestRegistryMarker(root);
  const registration = openTestRegistry(root, ["workflow_profiles", "constitution_gate", "runtime_config", "workflow_tools"], "import-finalizer-mounted");
  try {
    const owner = () => registration.owner;
    const installGate = registerTeamWorkflow(pi as never, { cwd: root, owner, registrationToken: registration.token, observability: false });
    installGate?.();
    registerWorkflowTools(pi as never, { cwd: root, owner, registrationToken: registration.token, resolveCwd: (ctx: unknown) => isRecord(ctx) && typeof ctx.cwd === "string" ? ctx.cwd : undefined });
    const tools = new Map(registered.map((tool) => [tool.name, tool]));
    mountedImportTools.set(root, tools);
    registration.retain(true);
    return tools;
  } catch (error) {
    try { registration.finish(false); } catch { /* preserve original */ }
    throw error;
  }
}

async function mountedImportCheckpointAsk(root: string, input: Record<string, unknown>): Promise<Record<string, unknown>> {
  const registered = mountImportTools(root);
  const ask = registered.get("workflow_checkpoint_ask_selected");
  assert.ok(ask, "public selected checkpoint Ask tool is registered");
  const response = await ask!.execute("import-finalizer-checkpoint-ask", input, undefined, undefined, {
    ...TEST_CONTEXT(root),
    ui: {
      askDialog: async (questions: Array<{ id: string; question: string; header?: string; options: Array<{ label: string }>; multi?: boolean }>) => {
        const question = questions[0];
        if (!question) return undefined;
        return {
          kind: "submit" as const,
          results: [{ id: question.id, question: question.question, header: question.header, options: question.options.map((option) => option.label), multi: false, selectedOptions: ["approve_continue"] }],
        };
      },
    },
  });
  return recordValue(response.details, "checkpoint Ask result");
}

function publicDoWorkClaimTool(root: string): PublicTool {
  const registered = mountImportTools(root);
  const tool = registered.get("do_work_claim");
  assert.ok(tool, "public do_work_claim tool is registered");
  return tool!;
}

test("public do_work_claim admits one ready imported handoff and replays the exact claim", async () => {
  const fixture = await makeImportedFixture();
  try {
    const finalized = await finalizeImportedHandoff(fixture.root, fixture.finalizerInput());
    assert.equal(finalized.ok, true, finalized.ok ? "" : finalized.error);
    if (!finalized.ok) return;

    const tool = publicDoWorkClaimTool(fixture.root);
    const valid = { feature_id: fixture.featureId, run_key: fixture.runKey };
    assert.equal(tool.parameters.safeParse({ ...valid, owner_run_id: fixture.runKey }).success, false, "caller cannot supply owner identity");
    assert.equal(tool.parameters.safeParse({ ...valid, extra: "reject" }).success, false, "extra claim fields are rejected");
    assert.equal(tool.parameters.safeParse({ feature_id: fixture.featureId }).success, false, "run_key is required");
    const first = await tool.execute("test", valid, undefined, undefined, { cwd: fixture.root, sessionManager: TEST_SESSION_MANAGER });
    assert.equal(first.details.ok, true, String(first.details.error ?? "claim admission failed"));
    assert.equal(first.details.transition, "claim");
    const firstClaim = recordValue(first.details.claim, "first claim");
    assert.equal(firstClaim.owner_kind, "do_work");
    assert.equal(firstClaim.owner_run_id, fixture.runKey);
    assert.equal(firstClaim.handoff_digest, finalized.handoff_digest);

    const replay = await tool.execute("test", valid, undefined, undefined, { cwd: fixture.root, sessionManager: TEST_SESSION_MANAGER });
    assert.equal(replay.details.ok, true, String(replay.details.error ?? "claim replay failed"));
    const replayClaim = recordValue(replay.details.claim, "replayed claim");
    assert.equal(replayClaim.claim_id, firstClaim.claim_id, "same owner/run replays the existing claim");

    const wrongRun = await tool.execute("test", { ...valid, run_key: `${fixture.runKey}-wrong` }, undefined, undefined, { cwd: fixture.root, sessionManager: TEST_SESSION_MANAGER });
    assert.equal(wrongRun.details.ok, false, "wrong run selector is rejected");
    const wrongFeature = await tool.execute("test", { ...valid, feature_id: `${fixture.featureId}-wrong` }, undefined, undefined, { cwd: fixture.root, sessionManager: TEST_SESSION_MANAGER });
    assert.equal(wrongFeature.details.ok, false, "wrong feature selector is rejected");
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("public do_work_claim fails closed on imported source mutation without creating a claim", async () => {
  const fixture = await makeImportedFixture();
  try {
    const finalized = await finalizeImportedHandoff(fixture.root, fixture.finalizerInput());
    assert.equal(finalized.ok, true, finalized.ok ? "" : finalized.error);
    if (!finalized.ok) return;
    writeFileSync(join(fixture.sourceRoot, "requirements.md"), `${readFileSync(join(fixture.sourceRoot, "requirements.md"), "utf8")}\nmutated`, "utf8");

    const tool = publicDoWorkClaimTool(fixture.root);
    const result = await tool.execute("test", { feature_id: fixture.featureId, run_key: fixture.runKey }, undefined, undefined, { cwd: fixture.root, sessionManager: TEST_SESSION_MANAGER });
    assert.equal(result.details.ok, false, "source mutation must block claim admission");
    const claims = readExecutionClaimStore(fixture.root, fixture.featureId);
    assert.equal(claims.ok, true, claims.ok ? "" : claims.error);
    if (claims.ok) assert.equal(claims.value.filter(claim => claim.status === "active").length, 0, "stale source creates no active claim");
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});
test("supplemented imported handoff revalidates from filesystem before public do-work claim", async () => {
  const fixture = await makeImportedFixture(undefined, true);
  try {
    const finalized = await finalizeImportedHandoff(fixture.root, fixture.finalizerInput());
    assert.equal(finalized.ok, true, finalized.ok ? "" : finalized.error);
    if (!finalized.ok) return;

    const artifactsDir = join(fixture.root, ".work-state", "features", fixture.featureId, "artifacts");
    const handoff = JSON.parse(readFileSync(join(artifactsDir, "implementation_handoff", `${finalized.handoff_ref}.json`), "utf8")) as ImplementationHandoff;
    const constitutionSupplement = JSON.parse(readFileSync(join(artifactsDir, "compatibility_supplement.json"), "utf8")) as CompatibilitySupplement;
    const constitutionResult = resolveCurrentConstitutionBinding(fixture.root);
    assert.equal(constitutionResult.ok, true, constitutionResult.ok ? "" : constitutionResult.error);
    if (!constitutionResult.ok) return;

    const revalidated = await revalidateImportedHandoffForDispatch({
      handoff,
      project_root: fixture.root,
      run_key: fixture.runKey,
      constitution_binding: constitutionResult.value,
    });
    assert.equal(revalidated.ok, true, revalidated.ok ? "" : JSON.stringify(revalidated.findings));

    const tool = publicDoWorkClaimTool(fixture.root);
    const claimed = await tool.execute("test", { feature_id: fixture.featureId, run_key: fixture.runKey }, undefined, undefined, { cwd: fixture.root, sessionManager: TEST_SESSION_MANAGER });
    assert.equal(claimed.details.ok, true, String(claimed.details.error ?? "supplemented claim admission failed"));
    const claim = recordValue(claimed.details.claim, "supplemented claim");
    assert.equal(claim.handoff_digest, finalized.handoff_digest);
    assert.equal(constitutionSupplement.supplement_id, handoff.compatibility_supplement_ref);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("supplemented imported handoff rejects every tampered envelope field without mutating workflow state", async () => {
  const fixture = await makeImportedFixture(undefined, true);
  try {
    const supplementPath = join(fixture.root, ".work-state", "features", fixture.featureId, "artifacts", "compatibility_supplement.json");
    const original = JSON.parse(readFileSync(supplementPath, "utf8")) as CompatibilitySupplement;
    const statePath = join(fixture.root, ".work-state", "features", fixture.featureId, "state.json");
    const beforeState = readFileSync(statePath);
    const envelopeFields: Array<keyof CompatibilitySupplement> = [
      "schema_version",
      "feature_id",
      "snapshot_id",
      "snapshot_ref",
      "source_sha256",
      "framework",
      "mapping_id",
      "mapping_version",
      "semantic_rows",
      "sections",
      "approved_by_ref",
      "approved_at",
      "supplement_id",
      "content_sha256",
    ];
    for (const field of envelopeFields) {
      const tampered = structuredClone(original) as unknown as Record<string, unknown>;
      if (field === "schema_version") tampered[field] = 2;
      else if (field === "semantic_rows" || field === "sections") tampered[field] = [];
      else if (field === "source_sha256" || field === "content_sha256") tampered[field] = "0".repeat(64);
      else tampered[field] = "tampered";
      writeFileSync(supplementPath, JSON.stringify(tampered), "utf8");

      const result = await finalizeImportedHandoff(fixture.root, fixture.finalizerInput());
      assert.equal(result.ok, false, `${field} tampering must be rejected`);
      if (!result.ok) assert.equal(result.code, "SPEC_IMPORT_SUPPLEMENT_CHANGED", `${field} must use the typed supplement rejection`);
      assert.deepEqual(readFileSync(statePath), beforeState, `${field} rejection must not mutate workflow state`);
      assert.equal(
        existsSync(join(fixture.root, ".work-state", "features", fixture.featureId, "artifacts", "implementation_handoff", `${fixture.featureId}.handoff.v1.json`)),
        false,
        `${field} rejection must not create a handoff`,
      );
    }
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});


test("import handoff finalizer derives one nested handoff, renders markdown, reaches terminal state, and replays idempotently", async () => {
  const fixture = await makeImportedFixture();
  try {
    const initial = fixture.finalizerInput();
    const first = await finalizeImportedHandoff(fixture.root, initial);
    assert.equal(first.ok, true, first.ok ? "" : first.error);
    if (!first.ok) return;
    assert.equal(first.handoff_ref, `${fixture.featureId}.handoff.v1`);
    assert.equal(first.artifact_path, `.work-state/features/${fixture.featureId}/artifacts/implementation_handoff/${fixture.featureId}.handoff.v1.json`);
    assert.equal(existsSync(join(fixture.root, first.artifact_path)), true);
    assert.equal(existsSync(join(fixture.root, "specs", fixture.featureId, "handoff.md")), true);
    assert.match(readFileSync(join(fixture.root, "specs", fixture.featureId, "handoff.md"), "utf8"), new RegExp(first.handoff_digest));
    assert.equal(existsSync(join(fixture.root, ".work-state", "features", fixture.featureId, "artifacts", "implementation_handoff.json")), false);
    const state = resolveState(fixture.root, undefined, { feature_id: fixture.featureId, run_key: fixture.runKey }).state;
    assert.equal(state?.stage_cursor, "handoff");
    assert.equal(state?.stages.find(stage => stage.id === "handoff")?.status, "done");
    assert.equal(state?.dispatch_capability?.status, "complete");
    assert.equal(state?.pause.kind, "done");
    assert.equal(state?.specification?.status, "implementation_ready");
    assert.equal(state?.specification?.handoff_ref, first.handoff_ref);
    assert.equal(state?.specification?.next_action?.command, `/do-work --spec ${fixture.featureId}`);
    const replay = await finalizeImportedHandoff(fixture.root, initial);
    assert.equal(replay.ok, true, replay.ok ? "" : replay.error);
    if (replay.ok) {
      assert.equal(replay.replayed, true);
      assert.equal(replay.handoff_digest, first.handoff_digest);
    }
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});
test("import finalizer requires one exact canonical snapshot and never accepts fallback metadata", async () => {
  const cases: Array<{ label: string; mutate: (snapshotPath: string, snapshot: Record<string, unknown>) => void }> = [
    { label: "deleted", mutate: (snapshotPath) => rmSync(snapshotPath) },
    { label: "empty", mutate: (snapshotPath) => writeFileSync(snapshotPath, "", "utf8") },
    { label: "malformed", mutate: (snapshotPath) => writeFileSync(snapshotPath, "{", "utf8") },
    {
      label: "symlink",
      mutate: (snapshotPath, snapshot) => {
        const fallbackPath = `${snapshotPath}.fallback`;
        writeFileSync(fallbackPath, JSON.stringify(snapshot) + "\n", "utf8");
        rmSync(snapshotPath);
        symlinkSync(fallbackPath, snapshotPath);
      },
    },
    {
      label: "artifact_id",
      mutate: (snapshotPath, snapshot) => {
        snapshot.snapshot_id = `import.${"0".repeat(64)}`;
        writeFileSync(snapshotPath, JSON.stringify(snapshot) + "\n", "utf8");
      },
    },
    {
      label: "version",
      mutate: (snapshotPath, snapshot) => {
        snapshot.schema_version = 2;
        writeFileSync(snapshotPath, JSON.stringify(snapshot) + "\n", "utf8");
      },
    },
    {
      label: "path",
      mutate: (snapshotPath, snapshot) => {
        const files = snapshot.files as Array<Record<string, unknown>>;
        files[0]!.path = "renamed.md";
        writeFileSync(snapshotPath, JSON.stringify(snapshot) + "\n", "utf8");
      },
    },
    {
      label: "digest",
      mutate: (snapshotPath, snapshot) => {
        const files = snapshot.files as Array<Record<string, unknown>>;
        files[0]!.sha256 = "0".repeat(64);
        writeFileSync(snapshotPath, JSON.stringify(snapshot) + "\n", "utf8");
      },
    },
  ];

  for (const testCase of cases) {
    const fixture = await makeImportedFixture();
    try {
      const statePath = join(fixture.root, ".work-state", "features", fixture.featureId, "state.json");
      const snapshotPath = join(fixture.root, ".work-state", "features", fixture.featureId, "artifacts", "import_snapshot.json");
      const handoffPath = join(fixture.root, ".work-state", "features", fixture.featureId, "artifacts", "implementation_handoff", `${fixture.featureId}.handoff.v1.json`);
      const handoffDocument = join(fixture.root, "specs", fixture.featureId, "handoff.md");
      const beforeState = readFileSync(statePath);
      const originalSnapshot = JSON.parse(readFileSync(snapshotPath, "utf8")) as Record<string, unknown>;
      testCase.mutate(snapshotPath, structuredClone(originalSnapshot));

      const result = await finalizeImportedHandoff(fixture.root, {
        ...fixture.finalizerInput(),
        // Unsupported fallback fields must never rescue a missing or stale
        // canonical artifact; finalization reads only the pinned artifact path.
        snapshot: originalSnapshot,
        import_snapshot: originalSnapshot,
        source_root: fixture.sourceRoot,
        pinned_root: fixture.root,
      } as never);
      assert.equal(result.ok, false, `${testCase.label} canonical snapshot tampering must block finalization`);
      assert.deepEqual(readFileSync(statePath), beforeState, `${testCase.label} rejection must not mutate workflow state`);
      assert.equal(existsSync(handoffPath), false, `${testCase.label} rejection must not write a handoff`);
      assert.equal(existsSync(handoffDocument), false, `${testCase.label} rejection must not write a handoff projection`);

      const claim = await publicDoWorkClaimTool(fixture.root).execute(
        "test",
        { feature_id: fixture.featureId, run_key: fixture.runKey },
        undefined,
        undefined,
        { cwd: fixture.root, sessionManager: TEST_SESSION_MANAGER },
      );
      assert.equal(claim.details.ok, false, `${testCase.label} canonical snapshot tampering must block claim admission`);
      // Claim admission may persist a typed stale-workspace diagnostic while
      // still failing closed. The observable safety contract is no active
      // execution claim and no handoff artifact/document.
      const claims = readExecutionClaimStore(fixture.root, fixture.featureId);
      assert.equal(claims.ok, true, claims.ok ? "" : claims.error);
      if (claims.ok) assert.equal(claims.value.some((entry) => entry.status === "active"), false, `${testCase.label} rejection must not create an active claim`);
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  }
});


test("import handoff finalizer preserves explicit and metadata language and rejects tampered language", async () => {
  for (const [label, languageOptions, expectedLanguage, expectedSource] of [
    ["explicit", { documentLanguage: "ru" }, "ru", "explicit"],
    ["metadata", { documentLanguageMetadata: "fr-CA" }, "fr-CA", "metadata"],
  ] as const) {
    const fixture = await makeImportedFixture(undefined, false, languageOptions);
    try {
      const finalized = await finalizeImportedHandoff(fixture.root, fixture.finalizerInput());
      assert.equal(finalized.ok, true, `${label} language finalization must succeed`);
      if (!finalized.ok) continue;
      const handoffPath = join(
        fixture.root,
        ".work-state",
        "features",
        fixture.featureId,
        "artifacts",
        "implementation_handoff",
        `${finalized.handoff_ref}.json`,
      );
      const handoff = JSON.parse(readFileSync(handoffPath, "utf8")) as ImplementationHandoff;
      assert.equal(handoff.import_document_language, expectedLanguage);
      assert.equal(handoff.import_document_language_source, expectedSource);
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  }

  const tampered = await makeImportedFixture(undefined, false, { documentLanguage: "ru" });
  try {
    const snapshotPath = join(tampered.root, ".work-state", "features", tampered.featureId, "artifacts", "import_snapshot.json");
    const snapshot = JSON.parse(readFileSync(snapshotPath, "utf8")) as Record<string, unknown>;
    snapshot.document_language = "de";
    writeFileSync(snapshotPath, JSON.stringify(snapshot) + "\n", "utf8");
    const result = await finalizeImportedHandoff(tampered.root, tampered.finalizerInput());
    assert.equal(result.ok, false, "tampered language must fail closed");
    if (!result.ok) assert.match(result.code, /SOURCE_CHANGED|SNAPSHOT_INVALID|HANDOFF_REJECTED/u);
  } finally {
    rmSync(tampered.root, { recursive: true, force: true });
  }
});

test("import handoff finalizer re-discovers immutable ignored candidates and excludes generated dirs", async () => {
  const added = await makeImportedFixture();
  try {
    writeFileSync(join(added.sourceRoot, "new-unsupported.bin"), "new unsupported candidate\n", "utf8");
    const addedResult = await finalizeImportedHandoff(added.root, added.finalizerInput());
    assert.equal(addedResult.ok, false);
    if (!addedResult.ok) assert.match(addedResult.code, /SOURCE_CHANGED|HANDOFF_REJECTED/u);
  } finally {
    rmSync(added.root, { recursive: true, force: true });
  }

  const removed = await makeImportedFixture();
  try {
    rmSync(join(removed.sourceRoot, "ignored.bin"));
    const removedResult = await finalizeImportedHandoff(removed.root, removed.finalizerInput());
    assert.equal(removedResult.ok, false);
    if (!removedResult.ok) assert.match(removedResult.code, /SOURCE_CHANGED|HANDOFF_REJECTED/u);
  } finally {
    rmSync(removed.root, { recursive: true, force: true });
  }

  const excluded = await makeImportedFixture();
  try {
    mkdirSync(join(excluded.sourceRoot, "target"), { recursive: true });
    rmSync(join(excluded.sourceRoot, ".git"), { recursive: true, force: true });
    writeFileSync(join(excluded.sourceRoot, "node_modules", "dependency", "package.json"), "{\"changed\":true}\n", "utf8");
    writeFileSync(join(excluded.sourceRoot, ".work-state", "runtime.json"), "{\"changed\":true}\n", "utf8");
    const excludedResult = await finalizeImportedHandoff(excluded.root, excluded.finalizerInput());
    assert.equal(excludedResult.ok, true, "generated/VCS/dependency state is outside import provenance");
  } finally {
    rmSync(excluded.root, { recursive: true, force: true });
  }
});

test("import handoff finalizer rejects tampered persisted ignored-candidate provenance", async () => {
  const fixture = await makeImportedFixture();
  try {
    const snapshotPath = join(fixture.root, ".work-state", "features", fixture.featureId, "artifacts", "import_snapshot.json");
    const snapshot = JSON.parse(readFileSync(snapshotPath, "utf8")) as { ignored_candidates: Array<{ path: string; reason: string }> };
    snapshot.ignored_candidates = snapshot.ignored_candidates.slice(1);
    writeFileSync(snapshotPath, JSON.stringify(snapshot) + "\n", "utf8");
    const result = await finalizeImportedHandoff(fixture.root, fixture.finalizerInput());
    assert.equal(result.ok, false);
    if (!result.ok) assert.match(result.code, /SNAPSHOT_INVALID|SOURCE_CHANGED|HANDOFF_REJECTED/u);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("import handoff finalizer fails closed on changed source without terminal state or handoff artifact", async () => {
  const fixture = await makeImportedFixture();
  try {
    const input = fixture.finalizerInput();
    writeFileSync(join(fixture.sourceRoot, "requirements.md"), "# Requirements\n\n## FR-101\nTampered source.\n", "utf8");
    const result = await finalizeImportedHandoff(fixture.root, input);
    assert.equal(result.ok, false);
    if (!result.ok) assert.match(result.code, /SOURCE_CHANGED|HANDOFF_REJECTED/u);
    assert.equal(existsSync(join(fixture.root, ".work-state", "features", fixture.featureId, "artifacts", "implementation_handoff", `${fixture.featureId}.handoff.v1.json`)), false);
    const state = resolveState(fixture.root, undefined, { feature_id: fixture.featureId, run_key: fixture.runKey }).state;
    assert.notEqual(state?.specification?.status, "implementation_ready");
    assert.notEqual(state?.stages.find(stage => stage.id === "handoff")?.status, "done");
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("import handoff finalizer rolls back canonical artifact and projection after state CAS drift", async () => {
  const fixture = await makeImportedFixture();
  let injected = false;
  try {
    setStateTransactionTestHooks({
      beforeCas: ({ sourcePath }) => {
        if (injected) return;
        injected = true;
        const current = JSON.parse(readFileSync(sourcePath, "utf8")) as Record<string, unknown>;
        current.task = "concurrent imported handoff mutation";
        writeFileSync(sourcePath, `${JSON.stringify(current, null, 2)}\n`, "utf8");
      },
    }, fixture.root);
    const result = await finalizeImportedHandoff(fixture.root, fixture.finalizerInput());
    assert.equal(result.ok, false, result.ok ? "state CAS drift must reject imported handoff finalization" : result.error);
    assert.equal(injected, true, "the deterministic state CAS seam must run");
    const canonicalPath = join(fixture.root, ".work-state", "features", fixture.featureId, "artifacts", "implementation_handoff", `${fixture.featureId}.handoff.v1.json`);
    const projectionPath = join(fixture.root, "specs", fixture.featureId, "handoff.md");
    assert.equal(existsSync(canonicalPath), false, "aborted imported handoff must remove its attempt-owned canonical artifact");
    assert.equal(existsSync(projectionPath), false, "aborted imported handoff must remove its attempt-owned readable projection");
  } finally {
    setStateTransactionTestHooks(null, fixture.root);
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("import handoff finalizer rejects a post-advance snapshot replacement", async () => {
  const fixture = await makeImportedFixture();
  try {
    const artifactsDir = join(fixture.root, ".work-state", "features", fixture.featureId, "artifacts");
    const snapshot = JSON.parse(readFileSync(join(artifactsDir, "import_snapshot.json"), "utf8")) as Record<string, unknown>;
    writeTestArtifact(fixture.root, artifactsDir, "import_snapshot", { ...snapshot, source_revision: "post-advance-replacement" });
    const result = await finalizeImportedHandoff(fixture.root, fixture.finalizerInput());
    assert.equal(result.ok, false);
    if (!result.ok) assert.match(result.code, /SOURCE_CHANGED|SNAPSHOT_INVALID|HANDOFF_REJECTED/u);
    assert.equal(existsSync(join(fixture.root, ".work-state", "features", fixture.featureId, "artifacts", "implementation_handoff", `${fixture.featureId}.handoff.v1.json`)), false);
    const state = resolveState(fixture.root, undefined, { feature_id: fixture.featureId, run_key: fixture.runKey }).state;
    assert.notEqual(state?.specification?.status, "implementation_ready");
    assert.notEqual(state?.stages.find(stage => stage.id === "handoff")?.status, "done");
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("import handoff finalizer rejects a post-advance compatibility report replacement", async () => {
  const fixture = await makeImportedFixture();
  try {
    const artifactsDir = join(fixture.root, ".work-state", "features", fixture.featureId, "artifacts");
    const report = JSON.parse(readFileSync(join(artifactsDir, "compatibility_report.json"), "utf8")) as Record<string, unknown>;
    writeTestArtifact(fixture.root, artifactsDir, "compatibility_report", { ...report, evaluated_at: "2099-01-01T00:00:00.000Z" });
    const result = await finalizeImportedHandoff(fixture.root, fixture.finalizerInput());
    assert.equal(result.ok, false);
    if (!result.ok) assert.match(result.code, /SOURCE_CHANGED|COMPATIBILITY_INVALID|HANDOFF_REJECTED/u);
    assert.equal(existsSync(join(fixture.root, ".work-state", "features", fixture.featureId, "artifacts", "implementation_handoff", `${fixture.featureId}.handoff.v1.json`)), false);
    const state = resolveState(fixture.root, undefined, { feature_id: fixture.featureId, run_key: fixture.runKey }).state;
    assert.notEqual(state?.specification?.status, "implementation_ready");
    assert.notEqual(state?.stages.find(stage => stage.id === "handoff")?.status, "done");
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("import handoff finalizer rejects a post-advance workspace import rebinding", async () => {
  const fixture = await makeImportedFixture();
  try {
    const selected = resolveState(fixture.root, undefined, { feature_id: fixture.featureId, run_key: fixture.runKey });
    assert.ok(selected.state, "selected finalizer state must resolve");
    if (!selected.state?.specification) return;
    writeState(fixture.root, {
      ...selected.state,
      specification: { ...selected.state.specification, import_ref: "import.rebound" },
    }, { featureSlug: fixture.featureId });
    const result = await finalizeImportedHandoff(fixture.root, fixture.finalizerInput());
    assert.equal(result.ok, false);
    if (!result.ok) assert.match(result.code, /SOURCE_CHANGED|STATE_INVALID|HANDOFF_REJECTED/u);
    assert.equal(existsSync(join(fixture.root, ".work-state", "features", fixture.featureId, "artifacts", "implementation_handoff", `${fixture.featureId}.handoff.v1.json`)), false);
    const state = resolveState(fixture.root, undefined, { feature_id: fixture.featureId, run_key: fixture.runKey }).state;
    assert.notEqual(state?.specification?.status, "implementation_ready");
    assert.notEqual(state?.stages.find(stage => stage.id === "handoff")?.status, "done");
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("import handoff finalizer rejects a post-advance constitution mutation", async () => {
  const fixture = await makeImportedFixture();
  try {
    writeFileSync(join(fixture.root, "CONSTITUTION.md"), "# Project Constitution v1.0.0\n\n## I. Quality\n\nShip untested work.\n", "utf8");
    const result = await finalizeImportedHandoff(fixture.root, fixture.finalizerInput());
    assert.equal(result.ok, false);
    if (!result.ok) assert.match(result.code, /SOURCE_CHANGED|HANDOFF_REJECTED/u);
    assert.equal(existsSync(join(fixture.root, ".work-state", "features", fixture.featureId, "artifacts", "implementation_handoff", `${fixture.featureId}.handoff.v1.json`)), false);
    const state = resolveState(fixture.root, undefined, { feature_id: fixture.featureId, run_key: fixture.runKey }).state;
    assert.notEqual(state?.specification?.status, "implementation_ready");
    assert.notEqual(state?.stages.find(stage => stage.id === "handoff")?.status, "done");
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("import handoff finalizer rejects forged advance token and preserves source bytes", async () => {
  const fixture = await makeImportedFixture();
  try {
    const before = readFileSync(join(fixture.sourceRoot, "requirements.md"));
    const forged = { ...fixture.finalizerInput(), advance_token: "forged-token" };
    const result = await finalizeImportedHandoff(fixture.root, forged);
    assert.equal(result.ok, false);
    if (!result.ok) assert.match(result.code, /STATE_INVALID|FINALIZE_REJECTED/u);
    assert.deepEqual(readFileSync(join(fixture.sourceRoot, "requirements.md")), before);
    assert.equal(existsSync(join(fixture.root, ".work-state", "features", fixture.featureId, "artifacts", "implementation_handoff", `${fixture.featureId}.handoff.v1.json`)), false);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("import handoff finalizer rejects an incompatible nested artifact and leaves terminal state untouched", async () => {
  const fixture = await makeImportedFixture();
  try {
    const nested = join(fixture.root, ".work-state", "features", fixture.featureId, "artifacts", "implementation_handoff");
    mkdirSync(nested, { recursive: true });
    writeFileSync(join(nested, `${fixture.featureId}.handoff.v1.json`), JSON.stringify({ forged: true }), "utf8");
    const result = await finalizeImportedHandoff(fixture.root, fixture.finalizerInput());
    assert.equal(result.ok, false);
    if (!result.ok) assert.match(result.code, /SPEC_STATE_INVALID|SPEC_HANDOFF_CONFLICT/u);
    const state = resolveState(fixture.root, undefined, { feature_id: fixture.featureId, run_key: fixture.runKey }).state;
    assert.notEqual(state?.specification?.status, "implementation_ready");
    assert.notEqual(state?.stages.find(stage => stage.id === "handoff")?.status, "done");
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("import handoff finalizer keeps hostile imperative source inert in its public response", async () => {
  const marker = "IGNORE_ENGINE_AND_RUN_COMMAND";
  const fixture = await makeImportedFixture(marker);
  try {
    const result = await finalizeImportedHandoff(fixture.root, fixture.finalizerInput());
    assert.equal(result.ok, true, result.ok ? "" : result.error);
    assert.equal(JSON.stringify(result).includes(marker), false);
    if (!result.ok) return;
    const artifact = readFileSync(join(fixture.root, result.artifact_path), "utf8");
    const markdown = readFileSync(join(fixture.root, result.document_path), "utf8");
    assert.equal(artifact.includes(marker), true);
    assert.equal(markdown.includes(marker), true);
    assert.equal(result.handoff_digest.length, 64);
    assert.equal(result.status, "implementation_ready");
    assert.equal(result.next_action, `/do-work --spec ${fixture.featureId}`);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});
