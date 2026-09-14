/**
 * Contracts for explicit, safe feature workspaces and the strict migration
 * boundary. Legacy migration is intentionally exercised only through the
 * public source-file wrapper; the old raw-object mutation path is gone.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, renameSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { specPreparationProfileHash, sha256, UNSAFE_FEATURE_IDS } from "./fixtures/specification-fixtures.js";
import { captureWorkspacePathBinding, captureWorkspaceRoot, createFeatureWorkspace, persistFeatureWorkspace, persistLegacyWorkspaceProjection, resolveFeatureWorkspace } from "../src/specification/workspace.js";
import { PinnedProjectRoot } from "../src/specification/pinned-root.js";
import { digestOf } from "../src/specification/validation.js";
import { migrateLegacySpecificationWorkspace, type LegacyConstitutionBinding } from "../src/specification/migration.js";
import { ensureProjectConstitution } from "../src/specification/prerequisite.js";
import { resolveState } from "../src/engine/state.js";
import { prepareWorkflowState } from "../src/engine/run.js";
import type { ConstitutionBinding, FeatureWorkspace } from "../src/specification/types.js";

function makeProject(): string {
  return mkdtempSync(join(tmpdir(), "spec-workspace-"));
}

function statePath(projectRoot: string, featureId: string): string {
  return join(projectRoot, ".work-state", "features", featureId, "state.json");
}

function workspaceInput(featureId: string, runKey = `run-${featureId}-1`): Record<string, unknown> {
  return {
    feature_id: featureId,
    display_name: `Feature ${featureId}`,
    run_key: runKey,
    profile_name: "spec-preparation",
    profile_hash: specPreparationProfileHash(),
  };
}

function selector(featureId: string, runKey = `run-${featureId}-1`): Record<string, unknown> {
  return { feature_id: featureId, run_key: runKey };
}

function constitution(body = "# Constitution v1.0.0\n\n## Quality\n\nTest every change.\n"): { version: string; fingerprint: string } {
  return { version: "1.0.0", fingerprint: createHash("sha256").update(body).digest("hex") };
}

function legacyJson(featureId: string, runKey: string, mutate?: (value: Record<string, unknown>) => void): string {
  const value: Record<string, unknown> = {
    schema: 1,
    feature_id: featureId,
    run_key: runKey,
    workflow: "spec-preparation",
    branch: `feature/${featureId}`,
    status: "done",
    stages: [
      { id: "specify", status: "done" },
      { id: "plan", status: "done" },
      { id: "tasks", status: "done" },
    ],
    artifacts: {
      specify: "artifacts/specify.json",
      plan: "artifacts/plan.json",
      tasks: "artifacts/tasks.json",
    },
    dod_and_artifacts: {
      status: "complete",
      artifacts: ["specify", "plan", "tasks"],
    },
  };
  mutate?.(value);
  return `${JSON.stringify(value, null, 2)}\n`;
}

function writeLegacy(root: string, name: string, body: string): string {
  const path = join(root, name);
  writeFileSync(path, body, "utf8");
  return path;
}

function migrate(root: string, featureId: string, runKey: string, body = legacyJson(featureId, runKey), currentBinding: LegacyConstitutionBinding | ConstitutionBinding = constitution()) {
  const sourcePath = writeLegacy(root, `${featureId}.json`, body);
  return {
    sourcePath,
    result: migrateLegacySpecificationWorkspace({
      project_root: root,
      legacy_state_path: sourcePath,
      current_constitution_binding: currentBinding,
    }),
  };
}

// ── Immutable, branch-independent identity ───────────────────────────────────

test("created workspaces get the canonical immutable path layout", () => {
  const root = makeProject();
  try {
    const created = createFeatureWorkspace(root, workspaceInput("layout-check"));
    assert.ok(created.ok, created.ok ? "created" : `rejected: ${created.error}`);
    if (!created.ok) return;
    const workspace = created.value as FeatureWorkspace;
    assert.equal(workspace.feature_id, "layout-check");
    assert.equal(workspace.workspace_path, "specs/layout-check");
    assert.equal(workspace.state_path, ".work-state/features/layout-check/state.json");
    assert.ok(existsSync(join(root, "specs", "layout-check")), "readable workspace directory exists");
    assert.ok(existsSync(statePath(root, "layout-check")), "canonical state.json exists");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("minimal specification creation commits readable state and prepares without fabricated classification", () => {
  const root = makeProject();
  const featureId = "readable-minimal";
  const runKey = "run-readable-minimal-1";
  try {
    const created = createFeatureWorkspace(root, workspaceInput(featureId, runKey));
    assert.ok(created.ok, created.ok ? "created" : `rejected: ${created.error}`);
    if (!created.ok) return;

    const stateFile = statePath(root, featureId);
    const persisted = JSON.parse(readFileSync(stateFile, "utf8")) as Record<string, unknown>;
    assert.deepEqual(Object.keys(persisted).sort(), ["run_key", "schema", "specification", "state_revision"]);
    assert.equal(persisted.schema, 1);
    assert.equal(persisted.run_key, runKey);
    assert.equal(persisted.state_revision, 1);
    assert.equal(persisted.classification, undefined, "creation must not fabricate a classification");

    const readable = readFileSync(join(root, ".work-state", "features", featureId, "team-state.md"), "utf8");
    assert.match(readable, /- Feature: readable-minimal/);
    assert.match(readable, /- Run: run-readable-minimal-1/);
    assert.match(readable, /- Source: native/);
    assert.match(readable, /- Status: created/);
    assert.match(readable, /- Current phase: specify \(not_started\)/);
    assert.match(readable, /- Next action: ensure_project_constitution/);
    assert.doesNotMatch(readable, /undefined/);

    const resolved = resolveState(root, "main", { feature_id: featureId, run_key: runKey });
    assert.equal(resolved.invalid, undefined);
    assert.equal(resolved.isStale, false, "an unclassified specification envelope is branch-neutral");
    assert.equal(resolved.state?.classification, undefined);
    assert.equal(resolved.state?.state_revision, 1);

    const prepared = prepareWorkflowState({
      task: "Prepare the readable specification",
      cwd: root,
      branch: "main",
      autonomous: false,
      classification: { type: "SPEC", complexity: "MEDIUM", confidence: "HIGH", autonomous: false, workflow: "spec-preparation" },
      feature_id: featureId,
      run_key: runKey,
    });
    assert.equal(prepared.classification.workflow, "spec-preparation");
    const classified = JSON.parse(readFileSync(stateFile, "utf8")) as Record<string, any>;
    assert.equal(classified.classification.type, "SPEC");
    assert.equal(classified.specification.feature_id, featureId);
    const classifiedReadable = readFileSync(join(root, ".work-state", "features", featureId, "team-state.md"), "utf8");
    assert.match(classifiedReadable, /## Classification/);
    assert.doesNotMatch(classifiedReadable, /undefined/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("duplicate feature identity conflicts without mutating the existing workspace", () => {
  const root = makeProject();
  try {
    const first = createFeatureWorkspace(root, workspaceInput("dup-check"));
    assert.ok(first.ok);
    const before = readFileSync(statePath(root, "dup-check"), "utf8");
    const second = createFeatureWorkspace(root, workspaceInput("dup-check"));
    assert.equal(second.ok, false, "a second workspace with the same id must conflict");
    if (!second.ok) assert.equal(second.code, "SPEC_FEATURE_CONFLICT");
    assert.equal(readFileSync(statePath(root, "dup-check"), "utf8"), before, "state unchanged");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("workspace creation rejects malformed presentation selections without writing state", () => { const root = makeProject(); try { const invalidLanguage = createFeatureWorkspace(root, { ...workspaceInput("invalid-language"), language: { language: "en-US", source: "not-a-source", selection_hash: sha256("invalid") } } as never); assert.equal(invalidLanguage.ok, false); assert.equal(existsSync(statePath(root, "invalid-language")), false); const invalidTemplate = createFeatureWorkspace(root, { ...workspaceInput("invalid-template"), template_set: { template_set_id: "specification-default", source: "project_default", content_hash: "not-a-digest", required_markers: [] } } as never); assert.equal(invalidTemplate.ok, false); assert.equal(existsSync(statePath(root, "invalid-template")), false); } finally { rmSync(root, { recursive: true, force: true }); } });

test("resolution is independent of the current branch pointer", () => {
  const root = makeProject();
  try {
    mkdirSync(join(root, ".git"), { recursive: true });
    writeFileSync(join(root, ".git", "HEAD"), "ref: refs/heads/main\n");
    const created = createFeatureWorkspace(root, workspaceInput("branch-free"));
    assert.ok(created.ok);
    writeFileSync(join(root, ".git", "HEAD"), "ref: refs/heads/totally-different\n");
    const resolved = resolveFeatureWorkspace(root, selector("branch-free"));
    assert.ok(resolved.ok, `explicit resolution must ignore branch state: ${resolved.ok ? "" : resolved.error}`);
    if (!resolved.ok) return;
    assert.equal((resolved.value as FeatureWorkspace).feature_id, "branch-free");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ── Safe paths and fail-closed boundaries ────────────────────────────────────

test("blank feature ids fail as missing explicit selectors while unsafe paths remain unauthorized", () => {
  const root = makeProject();
  try {
    for (const unsafeId of UNSAFE_FEATURE_IDS) {
      const input = { ...workspaceInput("placeholder"), feature_id: unsafeId };
      const created = createFeatureWorkspace(root, input);
      assert.equal(created.ok, false, `id ${JSON.stringify(unsafeId)} must be rejected`);
      if (!created.ok) {
        const expectedCode = unsafeId.trim().length === 0
          ? "SPEC_SELECTOR_REQUIRED"
          : "SPEC_PATH_UNAUTHORIZED";
        assert.equal(created.code, expectedCode, `id ${JSON.stringify(unsafeId)}`);
      }
    }
    assert.ok(!existsSync(join(root, ".work-state")), "no state tree may be created");
    assert.ok(!existsSync(join(root, "specs")), "no specs tree may be created");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a feature state directory that escapes the project via symlink fails closed", () => {
  const root = makeProject();
  const outside = mkdtempSync(join(tmpdir(), "spec-escape-"));
  try {
    const created = createFeatureWorkspace(root, workspaceInput("symlink-check"));
    assert.ok(created.ok);
    const featureDir = join(root, ".work-state", "features", "symlink-check");
    rmSync(featureDir, { recursive: true });
    symlinkSync(outside, featureDir, "dir");
    const resolved = resolveFeatureWorkspace(root, selector("symlink-check"));
    assert.equal(resolved.ok, false, "realpath escape must not resolve");
    if (!resolved.ok) assert.equal(resolved.code, "SPEC_PATH_UNAUTHORIZED");
    assert.equal(readdirSync(outside).length, 0, "nothing may be written through the escape");
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

// ── Explicit selectors only; no implicit pointer ─────────────────────────────

test("existing-workspace operations reject a missing or blank run_key", () => {
  const root = makeProject();
  try {
    const created = createFeatureWorkspace(root, workspaceInput("selector-check"));
    assert.ok(created.ok);
    writeFileSync(join(root, ".work-state", ".active-feature"), "selector-check\n");
    const missingRunKey = resolveFeatureWorkspace(root, { feature_id: "selector-check", run_key: "" });
    assert.equal(missingRunKey.ok, false, "run_key is mandatory for every in-flight operation");
    const absentRunKey = resolveFeatureWorkspace(root, { feature_id: "selector-check" } as Record<string, unknown>);
    assert.equal(absentRunKey.ok, false, "an absent run_key is not an implicit selection");
    const missingFeature = resolveFeatureWorkspace(root, { run_key: "run-selector-check-1" } as Record<string, unknown>);
    assert.equal(missingFeature.ok, false, "feature_id is mandatory for every in-flight operation");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("`.active-feature` is never consulted as a selector", () => {
  const root = makeProject();
  try {
    const created = createFeatureWorkspace(root, workspaceInput("real-feature"));
    assert.ok(created.ok);
    writeFileSync(join(root, ".work-state", ".active-feature"), "real-feature\n");
    const unknownViaPointer = resolveFeatureWorkspace(root, selector("ghost-feature"));
    assert.equal(unknownViaPointer.ok, false, "the pointer must not resolve a different id");
    const sameIdNoRun = resolveFeatureWorkspace(root, selector("real-feature", ""));
    assert.equal(sameIdNoRun.ok, false, "the pointer must not supply the run identity");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("an explicit unknown feature id fails closed with a diagnostic", () => {
  const root = makeProject();
  try {
    const resolved = resolveFeatureWorkspace(root, selector("no-such-feature"));
    assert.equal(resolved.ok, false);
    if (!resolved.ok) assert.ok(resolved.error.includes("no-such-feature"), "diagnostic names the id");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ── Safe atomic state persistence ────────────────────────────────────────────

test("persisted state is atomic: success leaves no temporary files", () => {
  const root = makeProject();
  try {
    const created = createFeatureWorkspace(root, workspaceInput("atomic-check"));
    assert.ok(created.ok);
    const resolved = resolveFeatureWorkspace(root, selector("atomic-check"));
    assert.ok(resolved.ok);
    const workspace = structuredClone(resolved.value) as FeatureWorkspace;
    const expectedWorkspaceDigest = digestOf(resolved.value);
    workspace.display_name = "Renamed";
    const persisted = persistFeatureWorkspace(root, workspace, undefined, { expected_workspace_digest: expectedWorkspaceDigest });
    assert.ok(persisted.ok, persisted.ok ? "persisted" : `rejected: ${persisted.error}`);
    const stored = JSON.parse(readFileSync(statePath(root, "atomic-check"), "utf8")) as {
      schema: number;
      run_key: string;
      specification: FeatureWorkspace;
    };
    assert.equal(stored.schema, 1, "the canonical state envelope is preserved");
    assert.equal(stored.run_key, "run-atomic-check-1", "run identity is preserved");
    assert.equal(stored.specification.display_name, "Renamed");
    const featureDir = join(root, ".work-state", "features", "atomic-check");
    const leftovers = readdirSync(featureDir).filter((entry) => entry.includes(".tmp"));
    assert.deepEqual(leftovers, [], "atomic writes must clean up temporary files");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a rejected persistence mutates nothing on disk", () => {
  const root = makeProject();
  try {
    const created = createFeatureWorkspace(root, workspaceInput("no-mutation"));
    assert.ok(created.ok);
    const before = readFileSync(statePath(root, "no-mutation"), "utf8");

    const resolved = resolveFeatureWorkspace(root, selector("no-mutation"));
    assert.ok(resolved.ok);
    const identitySwap = structuredClone(resolved.value) as FeatureWorkspace;
    identitySwap.feature_id = "renamed-identity";
    const expectedWorkspaceDigest = digestOf(resolved.value);
    const swapped = persistFeatureWorkspace(root, identitySwap, undefined, { expected_workspace_digest: expectedWorkspaceDigest });
    assert.equal(swapped.ok, false, "feature identity is immutable after creation");

    const invalidStatus = structuredClone(resolved.value) as FeatureWorkspace;
    (invalidStatus as unknown as Record<string, unknown>).status = "almost_done";
    const invalid = persistFeatureWorkspace(root, invalidStatus, undefined, { expected_workspace_digest: expectedWorkspaceDigest });
    assert.equal(invalid.ok, false, "an invalid aggregate must fail persistence");

    assert.equal(readFileSync(statePath(root, "no-mutation"), "utf8"), before, "state bytes unchanged");
    const featureDir = join(root, ".work-state", "features", "no-mutation");
    const leftovers = readdirSync(featureDir).filter((entry) => entry.includes(".tmp"));
    assert.deepEqual(leftovers, [], "failed writes leave no partial files");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("workspace capture callers close every locally owned root", () => {
  const root = makeProject();
  const originalOpen = PinnedProjectRoot.open;
  const originalClose = PinnedProjectRoot.prototype.close;
  let opened = 0;
  let closed = 0;
  PinnedProjectRoot.open = (projectRoot, hooks) => {
    const pinned = originalOpen(projectRoot, hooks);
    if (pinned) opened += 1;
    return pinned;
  };
  PinnedProjectRoot.prototype.close = function (this: PinnedProjectRoot): void {
    closed += 1;
    originalClose.call(this);
  };
  try {
    const created = createFeatureWorkspace(root, workspaceInput("close-accounting"));
    assert.ok(created.ok, created.ok ? "created" : created.error);
    if (!created.ok) return;
    const workspace = created.value as FeatureWorkspace;

    const borrowed = captureWorkspaceRoot(root);
    assert.ok(borrowed, "explicit root capture succeeds");
    if (!borrowed) return;
    const closesBeforeBorrowedPersist = closed;
    const borrowedPersist = persistFeatureWorkspace(root, workspace, borrowed, { expected_workspace_digest: digestOf(workspace) });
    assert.ok(borrowedPersist.ok, borrowedPersist.ok ? "persisted" : borrowedPersist.error);
    assert.equal(closed, closesBeforeBorrowedPersist, "borrowed snapshots remain owned by their caller");
    assert.equal(borrowed.pinned_root.isStable(), true, "borrowed snapshot remains live after persistence");
    borrowed.pinned_root.close();

    const localPersist = persistFeatureWorkspace(root, { ...workspace, display_name: "Locally persisted" }, undefined, { expected_workspace_digest: digestOf(workspace) });
    assert.ok(localPersist.ok, localPersist.ok ? "persisted" : localPersist.error);

    const wrongRun = resolveFeatureWorkspace(root, selector("close-accounting", "wrong-run"));
    assert.equal(wrongRun.ok, false);
    if (!wrongRun.ok) assert.equal(wrongRun.code, "SPEC_RUN_MISMATCH");

    const malformedCreated = createFeatureWorkspace(root, workspaceInput("close-malformed"));
    assert.ok(malformedCreated.ok, malformedCreated.ok ? "created" : malformedCreated.error);
    if (!malformedCreated.ok) return;
    const malformedPath = statePath(root, "close-malformed");
    const validState = readFileSync(malformedPath, "utf8");
    writeFileSync(malformedPath, "{ malformed json", "utf8");
    try {
      const malformedResolution = resolveFeatureWorkspace(root, selector("close-malformed"));
      assert.equal(malformedResolution.ok, false);
      if (!malformedResolution.ok) assert.equal(malformedResolution.code, "SPEC_STATE_UNREADABLE");
      const malformedPersistence = persistFeatureWorkspace(root, malformedCreated.value as FeatureWorkspace, undefined, { expected_workspace_digest: digestOf(malformedCreated.value) });
      assert.equal(malformedPersistence.ok, false);
      if (!malformedPersistence.ok) assert.equal(malformedPersistence.code, "SPEC_STATE_UNREADABLE");
    } finally {
      writeFileSync(malformedPath, validState, "utf8");
    }

    const specsFile = join(root, "specs", "close-exception");
    mkdirSync(join(root, "specs"), { recursive: true });
    writeFileSync(specsFile, "not a directory", "utf8");
    try {
      const creationException = createFeatureWorkspace(root, workspaceInput("close-exception"));
      assert.equal(creationException.ok, false);
      if (!creationException.ok) assert.ok(creationException.code === "SPEC_STATE_UNREADABLE" || creationException.code === "SPEC_PATH_UNAUTHORIZED");
    } finally {
      rmSync(specsFile, { force: true });
    }

    const legacyRejected = createFeatureWorkspace(root, { ...workspaceInput("close-legacy"), source_kind: "legacy" });
    assert.equal(legacyRejected.ok, false);
    const invalidRejected = createFeatureWorkspace(root, { ...workspaceInput("close-invalid"), display_name: "" });
    assert.equal(invalidRejected.ok, false);
    const invalidPersist = persistFeatureWorkspace(root, workspace, undefined, {});
    assert.equal(invalidPersist.ok, false);
    const invalidSelector = resolveFeatureWorkspace(root, { feature_id: "", run_key: "run-close-accounting-1" });
    assert.equal(invalidSelector.ok, false);

    const missingWorkspace = {
      ...workspace,
      feature_id: "close-missing",
      workspace_path: "specs/close-missing",
      state_path: ".work-state/features/close-missing/state.json",
    } as FeatureWorkspace;
    mkdirSync(join(root, "specs", "close-missing"), { recursive: true });
    const missingRoot = PinnedProjectRoot.open(root);
    if (!missingRoot) throw new Error("missing workspace fixture root cannot be pinned");
    missingRoot.ensureDirectory(".work-state/features/close-missing/artifacts/execution_claim/next");
    missingWorkspace.path_binding = captureWorkspacePathBinding(missingRoot, "close-missing");
    missingRoot.close();
    const iterations = 1_000;
    for (let index = 0; index < iterations; index += 1) {
      const unknown = resolveFeatureWorkspace(root, selector(`close-unknown-${index}`));
      assert.equal(unknown.ok, false);
      if (!unknown.ok) assert.equal(unknown.code, "SPEC_FEATURE_UNKNOWN");
      const duplicate = createFeatureWorkspace(root, workspaceInput("close-accounting"));
      assert.equal(duplicate.ok, false);
      if (!duplicate.ok) assert.equal(duplicate.code, "SPEC_FEATURE_CONFLICT");
      const missing = persistFeatureWorkspace(root, missingWorkspace, undefined, { expected_workspace_digest: digestOf(missingWorkspace) });
      assert.equal(missing.ok, false);
      if (!missing.ok) assert.equal(missing.code, "SPEC_FEATURE_UNKNOWN");
    }
  } finally {
    PinnedProjectRoot.prototype.close = originalClose;
    PinnedProjectRoot.open = originalOpen;
    rmSync(root, { recursive: true, force: true });
    assert.equal(opened, closed, `all ${opened} successful captures have one close path`);
  }
});

// ── Strict public legacy migration ───────────────────────────────────────────

test("public migration persists canonical profile identity and only minimal provenance", () => {
  const root = makeProject();
  try {
    const body = legacyJson("legacy-feature", "run-legacy-1");
    const constitutionBody = "# Constitution v1.0.0\n\nVersion: 1.0.0\n\n## Quality\n\nTest every change.\n";
    writeFileSync(join(root, "CONSTITUTION.md"), constitutionBody, "utf8");
    const gate = ensureProjectConstitution(root, { origin_kind: "native_direct", origin_run_key: "run-legacy-1", origin_stage: "specify" });
    assert.ok(gate.ok && gate.value.binding, gate.ok ? "gate authority established" : gate.error);
    if (!gate.ok || !gate.value.binding) return;
    const first = migrate(root, "legacy-feature", "run-legacy-1", body, gate.value.binding);
    assert.equal(first.result.status, "migrated");
    assert.equal(first.result.feature_id, "legacy-feature");
    assert.equal(first.result.run_key, "run-legacy-1");
    assert.equal(readFileSync(first.sourcePath, "utf8"), body, "legacy source remains immutable");

    const resolved = resolveFeatureWorkspace(root, selector("legacy-feature", "run-legacy-1"));
    assert.equal(resolved.ok, true);
    if (!resolved.ok) return;
    assert.equal(resolved.value.source_kind, "legacy");
    assert.equal(resolved.value.profile_name, "spec-preparation");
    assert.match(resolved.value.profile_hash, /^[a-f0-9]{64}$/u);
    assert.equal(resolved.value.status, "in_progress");
    assert.match(resolved.value.migration_receipt_ref ?? "", /^migration-[a-f0-9]{24}$/u, "workspace stores the canonical receipt artifact id");
    assert.ok(resolved.value.phases.every((phase) => phase.approved_version === null && phase.checkpoint_ref === null));

    const receiptDir = join(root, ".work-state", "features", "legacy-feature", "artifacts", "migration");
    const receiptFiles = readdirSync(receiptDir);
    assert.equal(receiptFiles.length, 1);
    const persistedReceipt = JSON.parse(readFileSync(join(receiptDir, receiptFiles[0]!), "utf8")) as Record<string, unknown>;
    assert.equal(resolved.value.migration_receipt_ref, persistedReceipt.id, "workspace receipt ref resolves to the durable receipt identifier");
    assert.equal(receiptFiles[0], `${resolved.value.migration_receipt_ref}.json`, "workspace receipt ref resolves to the canonical artifact path");
    assert.equal(persistedReceipt.project_root, realpathSync(root));
    assert.equal(typeof persistedReceipt.project_root_dev, "number");
    assert.equal(typeof persistedReceipt.project_root_ino, "number");
    assert.equal(persistedReceipt.workflow, undefined, "legacy workflow is not persisted");
    assert.deepEqual(persistedReceipt.legacy_inputs, ["branch=feature/legacy-feature"]);
    assert.equal((persistedReceipt.legacy_inputs as string[]).some((value) => value.startsWith("status=") || value.startsWith("workflow=")), false);

    const retry = migrateLegacySpecificationWorkspace({
      project_root: root,
      legacy_state_path: first.sourcePath,
      current_constitution_binding: gate.value.binding,
    });
    assert.equal(retry.status, "current");
    assert.equal(retry.receipt.receipt_id, first.result.receipt.receipt_id);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("legacy projection source drift after receipt publication rolls back the attempt and exact retry succeeds", () => {
  const root = makeProject();
  const originalWriteExclusiveWithDescriptor = PinnedProjectRoot.prototype.writeExclusiveWithDescriptor;
  let snapshot: ReturnType<typeof captureWorkspaceRoot> = null;
  try {
    const constitutionBody = "# Constitution v1.0.0\n\nVersion: 1.0.0\n\n## Quality\n\nTest every change.\n";
    writeFileSync(join(root, "CONSTITUTION.md"), constitutionBody, "utf8");
    const gate = ensureProjectConstitution(root, { origin_kind: "native_direct", origin_run_key: "projection-drift-run", origin_stage: "specify" });
    assert.ok(gate.ok && gate.value.binding, gate.ok ? "gate authority established" : gate.error);
    if (!gate.ok || !gate.value.binding) return;
    snapshot = captureWorkspaceRoot(root);
    assert.ok(snapshot);
    if (!snapshot) return;
    const featureId = "projection-drift";
    const runKey = "projection-drift-run";
    const sourceDigest = sha256(legacyJson(featureId, runKey));
    const projection = {
      feature_id: featureId,
      run_key: runKey,
      project_root: snapshot.canonical_root,
      project_root_dev: snapshot.dev,
      project_root_ino: snapshot.ino,
      source_digest: sourceDigest,
      legacy_inputs: ["branch=feature/projection-drift"],
      constitution_binding: gate.value.binding,
    };
    let drifted = false;
    PinnedProjectRoot.prototype.writeExclusiveWithDescriptor = function (relativePath: string, content: Parameters<PinnedProjectRoot["writeExclusiveWithDescriptor"]>[1]): ReturnType<PinnedProjectRoot["writeExclusiveWithDescriptor"]> {
      const descriptor = originalWriteExclusiveWithDescriptor.call(this, relativePath, content);
      if (!drifted && relativePath.includes("/artifacts/migration/") && relativePath.endsWith(".json")) {
        drifted = true;
        writeFileSync(join(root, "CONSTITUTION.md"), constitutionBody.replace("Test every change.", "Changed during projection commit."), "utf8");
      }
      return descriptor;
    };
    const blocked = persistLegacyWorkspaceProjection(snapshot, projection);
    assert.equal(blocked.ok, false, JSON.stringify(blocked));
    assert.equal(drifted, true);
    assert.match(blocked.ok ? "" : blocked.error, /SPEC_STALE|pre-commit guard/u);
    const receiptDirectory = join(root, ".work-state", "features", featureId, "artifacts", "migration");
    assert.ok(!existsSync(receiptDirectory) || readdirSync(receiptDirectory).length === 0, "drift rollback removes the attempt-owned receipt");
    writeFileSync(join(root, "CONSTITUTION.md"), constitutionBody, "utf8");
    const retry = persistLegacyWorkspaceProjection(snapshot, projection);
    assert.equal(retry.ok, true, retry.ok ? "retried" : retry.error);
    assert.ok(retry.ok && retry.value.receipt);
  } finally {
    snapshot?.pinned_root.close();
    PinnedProjectRoot.prototype.writeExclusiveWithDescriptor = originalWriteExclusiveWithDescriptor;
    rmSync(root, { recursive: true, force: true });
  }
});

test("legacy projection state rollback preserves a concurrent same-content replacement", () => {
  const root = makeProject();
  const rootPrototype = PinnedProjectRoot.prototype;
  const originalWriteAtomicFilesWithReceipts = rootPrototype.writeAtomicFilesWithReceipts;
  let snapshot: ReturnType<typeof captureWorkspaceRoot> = null;
  let replacedStateIno: number | null = null;
  try {
    const constitutionBody = "# Constitution v1.0.0\n\nVersion: 1.0.0\n\n## Quality\n\nTest every change.\n";
    writeFileSync(join(root, "CONSTITUTION.md"), constitutionBody, "utf8");
    const gate = ensureProjectConstitution(root, { origin_kind: "native_direct", origin_run_key: "projection-state-replacement-run", origin_stage: "specify" });
    assert.ok(gate.ok && gate.value.binding, gate.ok ? "gate authority established" : gate.error);
    if (!gate.ok || !gate.value.binding) return;
    snapshot = captureWorkspaceRoot(root);
    assert.ok(snapshot);
    if (!snapshot) return;
    const featureId = "projection-state-replacement";
    const runKey = "projection-state-replacement-run";
    const projection = {
      feature_id: featureId,
      run_key: runKey,
      project_root: snapshot.canonical_root,
      project_root_dev: snapshot.dev,
      project_root_ino: snapshot.ino,
      source_digest: sha256(legacyJson(featureId, runKey)),
      legacy_inputs: ["branch=feature/projection-state-replacement"],
      constitution_binding: gate.value.binding,
    };
    let injected = false;
    rootPrototype.writeAtomicFilesWithReceipts = function (
      this: PinnedProjectRoot,
      entries: Parameters<PinnedProjectRoot["writeAtomicFilesWithReceipts"]>[0],
    ): ReturnType<PinnedProjectRoot["writeAtomicFilesWithReceipts"]> {
      const receipts = originalWriteAtomicFilesWithReceipts.call(this, entries);
      const stateReceipt = receipts.find((receipt) => receipt.relative_path.endsWith("/state.json"));
      if (!injected && stateReceipt) {
        injected = true;
        const statePath = join(root, ".work-state", "features", featureId, "state.json");
        const replacementPath = `${statePath}.same-content-replacement`;
        writeFileSync(replacementPath, readFileSync(statePath));
        renameSync(replacementPath, statePath);
        replacedStateIno = statSync(statePath).ino;
        const driftedGate = JSON.parse(readFileSync(join(root, ".work-state", "specification", "constitution", "gate.json"), "utf8")) as { gate: Record<string, unknown> };
        driftedGate.gate.status = "approved";
        writeFileSync(join(root, ".work-state", "specification", "constitution", "gate.json"), JSON.stringify(driftedGate, null, 2) + "\n", "utf8");
      }
      return receipts;
    };
    const blocked = persistLegacyWorkspaceProjection(snapshot, projection, { expected_gate: gate.value });
    assert.equal(blocked.ok, false, JSON.stringify(blocked));
    assert.equal(injected, true);
    assert.notEqual(replacedStateIno, null);
    assert.equal(statSync(join(root, ".work-state", "features", featureId, "state.json")).ino, replacedStateIno, "state rollback preserves a concurrent same-content replacement");
  } finally {
    snapshot?.pinned_root.close();
    rootPrototype.writeAtomicFilesWithReceipts = originalWriteAtomicFilesWithReceipts;
    rmSync(root, { recursive: true, force: true });
  }
});

test("workspace creation root swap rolls back only exact state and preserves a concurrent old-root replacement", () => {
  const root = makeProject();
  const moved = `${root}.moved`;
  const featureId = "root-swap-create";
  const originalBatch = PinnedProjectRoot.prototype.writeAtomicFilesWithReceipts;
  let swapped = false;
  try {
    PinnedProjectRoot.prototype.writeAtomicFilesWithReceipts = function (entries, options) {
      const receipts = originalBatch.call(this, entries, options);
      if (!swapped && entries.some((entry) => entry.path.endsWith(`/features/${featureId}/state.json`))) {
        swapped = true;
        renameSync(root, moved);
        mkdirSync(root, { recursive: true });
        const movedState = join(moved, ".work-state", "features", featureId, "state.json");
        writeFileSync(movedState, "concurrent-old-root-state\n", "utf8");
      }
      return receipts;
    };
    const created = createFeatureWorkspace(root, workspaceInput(featureId));
    assert.equal(created.ok, false);
    if (!created.ok) assert.equal(created.code, "SPEC_PATH_UNAUTHORIZED");
    assert.equal(swapped, true);
    assert.equal(readFileSync(join(moved, ".work-state", "features", featureId, "state.json"), "utf8"), "concurrent-old-root-state\n");
    assert.equal(existsSync(join(root, "specs", featureId)), false, "replacement root receives no stale cleanup");
    assert.equal(existsSync(join(root, ".work-state", "features", featureId)), false, "replacement root receives no stale state");
  } finally {
    PinnedProjectRoot.prototype.writeAtomicFilesWithReceipts = originalBatch;
    rmSync(root, { recursive: true, force: true });
    rmSync(moved, { recursive: true, force: true });
  }
});

test("malformed stages, artifacts, workflow, status, and control fields block identically without writes", () => {
  const cases: Array<{ name: string; mutate: (value: Record<string, unknown>) => void }> = [
    { name: "missing-stages", mutate: (value) => { delete value.stages; } },
    { name: "missing-artifacts", mutate: (value) => { delete value.artifacts; } },
    { name: "workflow-control", mutate: (value) => { value.workflow = "admin-control"; } },
    { name: "status-control", mutate: (value) => { value.status = "approved"; } },
    { name: "control-field", mutate: (value) => { value.control_plane = { decision: "approve" }; } },
    { name: "stage-control", mutate: (value) => { (value.stages as Array<Record<string, unknown>>)[0]!.decision = "approve"; } },
  ];
  for (const testCase of cases) {
    const root = makeProject();
    try {
      const body = legacyJson(`malformed-${testCase.name}`, `run-malformed-${testCase.name}`, testCase.mutate);
      const migrated = migrate(root, `malformed-${testCase.name}`, `run-malformed-${testCase.name}`, body);
      assert.equal(migrated.result.status, "blocked", testCase.name);
      assert.equal(existsSync(join(root, "specs")), false, `${testCase.name} cannot create specs`);
      assert.equal(existsSync(join(root, ".work-state")), false, `${testCase.name} cannot create state`);
      assert.equal(readFileSync(migrated.sourcePath, "utf8"), body, `${testCase.name} leaves source bytes untouched`);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

test("the obsolete raw migration mutation is absent from the workspace module", async () => {
  const module = await import("../src/specification/workspace.js");
  assert.equal("migrateLegacyWorkspace" in module, false);
});

test("native and strict legacy workspace creation reject a specs symlink before any mutation", () => {
  const root = makeProject();
  const outside = mkdtempSync(join(tmpdir(), "spec-readable-escape-"));
  try {
    const sourcePath = writeLegacy(root, "legacy.json", legacyJson("readable-escape", "run-readable-escape-1"));
    const constitutionBody = "# Constitution v1.0.0\n\nVersion: 1.0.0\n\n## Quality\n\nTest every change.\n";
    writeFileSync(join(root, "CONSTITUTION.md"), constitutionBody, "utf8");
    const gate = ensureProjectConstitution(root, { origin_kind: "native_direct", origin_run_key: "run-readable-escape-1", origin_stage: "specify" });
    assert.ok(gate.ok && gate.value.binding, gate.ok ? "gate authority established" : gate.error);
    if (!gate.ok || !gate.value.binding) return;
    symlinkSync(outside, join(root, "specs"), "dir");
    const native = createFeatureWorkspace(root, workspaceInput("readable-escape"));
    assert.equal(native.ok, false, "native creation must reject the escaping readable root");
    if (!native.ok) assert.equal(native.code, "SPEC_PATH_UNAUTHORIZED");
    const legacy = migrateLegacySpecificationWorkspace({
      project_root: root,
      legacy_state_path: sourcePath,
      current_constitution_binding: gate.value.binding,
    });
    assert.equal(legacy.status, "blocked", "legacy creation must reject the escaping readable root");
    assert.ok(legacy.receipt.diagnostics.some((diagnostic) => diagnostic.code === "SPEC_PATH_UNAUTHORIZED"));
    assert.deepEqual(readdirSync(outside), [], "nothing is created through the specs symlink");
    assert.ok(existsSync(join(root, ".work-state")), "the pre-established authority gate remains intact");
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test("explicit engine resolution rejects a foreign specification envelope under the selected feature path", () => {
  const root = makeProject();
  try {
    const alpha = createFeatureWorkspace(root, workspaceInput("alpha", "run-alpha-1"));
    const beta = createFeatureWorkspace(root, workspaceInput("beta", "run-beta-1"));
    assert.ok(alpha.ok && beta.ok);
    if (!beta.ok) return;

    const alphaPath = statePath(root, "alpha");
    const foreignEnvelope = {
      schema: 1,
      run_key: "run-alpha-1",
      specification: { ...beta.value },
    };
    writeFileSync(alphaPath, JSON.stringify(foreignEnvelope) + "\n", "utf8");
    writeFileSync(join(root, ".work-state", ".active-feature"), "beta\n", "utf8");

    const selected = resolveState(root, undefined, { feature_id: "alpha", run_key: "run-alpha-1" });
    assert.equal(selected.invalid, true, "the selected path cannot carry another feature identity");
    assert.equal(selected.state, null);
    const pointed = resolveState(root);
    assert.equal(pointed.state?.specification?.feature_id, "beta", "the stale pointer remains unrelated to the explicit rejection");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
