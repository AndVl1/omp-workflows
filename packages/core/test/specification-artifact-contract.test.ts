/**
 * Failing contract for the specification artifact pipeline (T006).
 *
 * Canonical APIs under contract:
 *
 *   `packages/core/workflows/artifacts-schema.json` (T015) — executable strict
 *   schemas for the canonical aggregate artifacts, validated through the
 *   existing engine loader (`engine/artifact-contract.ts`):
 *     feature_workspace, specification_phase_version, constitution_record,
 *     implementation_handoff, execution_claim, import_snapshot,
 *     implementation_conformance
 *
 *   `packages/core/src/specification/materialize.ts` (T016)
 *     - materializeFeatureDocuments(projectRoot, request) — the ONE registered
 *       deterministic Markdown renderer: bounded paths, atomic writes,
 *       content hashes, immutable versions, revision history
 *     - revalidateMaterializedDocuments(projectRoot, selector) — hash
 *       revalidation after manual edits
 *
 *   `packages/core/src/specification/registry.ts` (T022) — bounded
 *   renderer registration seam without bundle-specific defaults.
 *
 * Behavioral contracts pinned here:
 *   - schema: canonical aggregate fixtures validate; the invalid fixture
 *     families fail closed with field-level diagnostics (cross-field closure
 *     invariants included);
 *   - immutable artifacts: re-materializing a persisted version is rejected
 *     and never overwrites;
 *   - renderer registry: the shipped deterministic renderer resolves, cannot
 *     be replaced, and renders deterministically; registration ids are bounded;
 *   - hashes: materialization captures the exact SHA-256 of every document and
 *     revalidation detects manual edits;
 *   - history: replacing a version archives every previous readable document
 *     under deterministic phase/version/document paths, while a collision
 *     rejects the complete revision before any write;
 *   - path escapes: traversal, absolute, backslash, and symlink escapes fail
 *     closed with `SPEC_PATH_UNAUTHORIZED` and write nothing.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  INVALID_CONFORMANCE_RESULT_CASES,
  INVALID_EXECUTION_CLAIM_CASES,
  INVALID_FEATURE_WORKSPACE_CASES,
  INVALID_IMPLEMENTATION_HANDOFF_CASES,
  FIXED_FEATURE_ID,
  sha256,
  specPreparationProfileHash,
  validConstitutionBinding,
  validExecutionClaim,
  validFeatureWorkspace,
  validImplementationConformance,
  validImplementationHandoff,
} from "./fixtures/specification-fixtures.js";
import { loadArtifactSchemas, requiredFieldsOf, validateProducedArtifact } from "../src/engine/artifact-contract.js";
import { createFeatureWorkspace } from "../src/specification/workspace.js";
import {
  DEFAULT_SPECIFICATION_RENDERER_ID,
  materializeFeatureDocuments,
  revalidateMaterializedDocuments,
} from "../src/specification/materialize.js";
import { MAX_PHASE_INPUT_BYTES } from "../src/specification/limits.js";
import { readPinnedCurrentConstitution } from "../src/specification/constitution-identities.js";
import { ensureProjectConstitution } from "../src/specification/prerequisite.js";
import { PinnedProjectRoot } from "../src/specification/pinned-root.js";
import type { ConstitutionBinding } from "../src/specification/types.js";

import { requireDocumentRenderer, resolveSpecificationRenderer } from "../src/specification/registry.js";
import { registerTestSpecificationRenderer, writeTestRegistryMarker } from "./fixtures/registry-activation.js";

/** Strict executable schemas every canonical aggregate artifact must have (T015). */
const PRODUCT_PRD_RENDERER_ID = "product-prd";

const CANONICAL_SPECIFICATION_SCHEMAS = [
  "feature_workspace",
  "specification_phase_version",
  "constitution_record",
  "implementation_handoff",
  "execution_claim",
  "import_snapshot",
  "implementation_conformance",
] as const;

interface Project {
  root: string;
  constitutionBinding: ConstitutionBinding;
  cleanup(): void;
}

function projectWithWorkspace(): Project {
  const root = mkdtempSync(join(tmpdir(), "spec-artifacts-"));
  const created = createFeatureWorkspace(root, {
    feature_id: FIXED_FEATURE_ID,
    display_name: "Artifact Contract",
    run_key: "run-artifacts-1",
    profile_name: "spec-preparation",
    profile_hash: specPreparationProfileHash(),
  });
  if (!created.ok) {
    rmSync(root, { recursive: true, force: true });
    throw new Error(`fixture workspace creation failed: ${created.error}`);
  }
  const constitution = "# Project Constitution v1.0.0\n\nVersion: 1.0.0\n\n## I. Quality\n\nShip tested work.\n";
  writeFileSync(join(root, "CONSTITUTION.md"), constitution, "utf8");
  const ensured = ensureProjectConstitution(root, {
    origin_kind: "native_direct",
    origin_run_key: "run-artifacts-1",
    origin_stage: "specify",
  }, { feature_id: FIXED_FEATURE_ID });
  if (!ensured.ok || !ensured.value.binding) {
    rmSync(root, { recursive: true, force: true });
    throw new Error(`fixture constitution bootstrap failed: ${ensured.ok ? ensured.value.status : ensured.error}`);
  }
  return {
    root,
    constitutionBinding: ensured.value.binding,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

interface MaterializeRequest {
  feature_id: string;
  run_key: string;
  phase: "specify" | "plan" | "tasks";
  version: number;
  documents: Array<{ path: string; content: string }>;
}

function materializeRequest(version: number, content: string): MaterializeRequest {
  return {
    feature_id: FIXED_FEATURE_ID,
    run_key: "run-artifacts-1",
    phase: "specify",
    version,
    documents: [{ path: "spec.md", content }],
  };
}

/** Artifact fixtures must exercise the same live constitution precondition as production callers. */
function materializeForTest(project: Project, request: MaterializeRequest) {
  const pinnedRoot = PinnedProjectRoot.open(project.root);
  if (!pinnedRoot) throw new Error("SPEC_PATH_UNAUTHORIZED: artifact fixture root cannot be pinned");
  try {
    return materializeFeatureDocuments(project.root, request, {
      validateBeforeWrite: () => {
        const current = readPinnedCurrentConstitution(project.root, pinnedRoot, project.constitutionBinding);
        if (!current.ok) throw new Error(current.error);
      },
    });
  } finally {
    pinnedRoot.close();
  }
}

// ── Executable strict schemas for canonical aggregates ───────────────────────

test("every canonical specification artifact has an executable strict schema", () => {
  const definitions = Object.keys(loadArtifactSchemas());
  for (const id of CANONICAL_SPECIFICATION_SCHEMAS) {
    assert.ok(definitions.includes(id), `artifacts-schema.json must define '${id}'`);
    const required = requiredFieldsOf(id);
    assert.ok(required && required.length > 0, `'${id}' must constrain required fields`);
  }
});

test("valid canonical aggregate fixtures pass their executable schemas", () => {
  const validPairs: Array<[string, unknown]> = [
    ["feature_workspace", validFeatureWorkspace()],
    ["constitution_record", validConstitutionBinding()],
    ["implementation_handoff", validImplementationHandoff()],
    ["execution_claim", validExecutionClaim()],
    ["implementation_conformance", validImplementationConformance()],
  ];
  for (const [id, value] of validPairs) {
    const result = validateProducedArtifact(id, value);
    assert.deepEqual(result, { ok: true }, `valid fixture must satisfy '${id}'`);
  }
});

test("external implementation handoffs require complete provider provenance while native handoffs remain compact", () => {
  const imported = {
    ...validImplementationHandoff(),
    source_kind: "external" as const,
    content_provenance: {
      source_kind: "external" as const,
      content_role: "untrusted_inert_data" as const,
      embedded_instruction_policy: "inert_data_only" as const,
      source_refs: ["external-source/requirements.md"],
    },
    import_snapshot_ref: "snapshot.external.v1",
    compatibility_supplement_ref: null,
    import_framework: "generic",
    import_mapping_id: "generic-requirements-plan-tasks",
    import_mapping_version: "1",
    import_selected_paths: ["requirements.md"],
    import_ignored_candidates: [],
    import_intake_paths: ["external-source"],
    import_document_language: "und",
    import_document_language_source: "unknown" as const,
    import_source_revision: null,
  };
  assert.deepEqual(validateProducedArtifact("implementation_handoff", imported), { ok: true });
  assert.deepEqual(validateProducedArtifact("implementation_handoff", validImplementationHandoff()), { ok: true });
  for (const field of [
    "import_framework",
    "import_mapping_id",
    "import_mapping_version",
    "import_selected_paths",
    "import_ignored_candidates",
    "import_intake_paths",
    "import_document_language",
    "import_document_language_source",
    "import_source_revision",
  ]) {
    const missing = { ...imported } as Record<string, unknown>;
    delete missing[field];
    const result = validateProducedArtifact("implementation_handoff", missing);
    assert.equal(result.ok, false, `external handoff without ${field} must fail closed`);
  }
  const unsafePath = validateProducedArtifact("implementation_handoff", {
    ...imported,
    import_selected_paths: ["../escape.md"],
  });
  assert.equal(unsafePath.ok, false, "external provider paths must remain source-root-relative");
});

test("invalid aggregate fixtures fail closed with field-level diagnostics", () => {
  const invalidPairs: Array<[string, unknown, string]> = [
    ["feature_workspace", INVALID_FEATURE_WORKSPACE_CASES.unsafe_feature_id, "unsafe_feature_id"],
    ["feature_workspace", INVALID_FEATURE_WORKSPACE_CASES.missing_required_field, "missing_required_field"],
    ["feature_workspace", INVALID_FEATURE_WORKSPACE_CASES.unknown_workspace_status, "unknown_workspace_status"],
    ["implementation_handoff", INVALID_IMPLEMENTATION_HANDOFF_CASES.requirement_without_acceptance, "requirement_without_acceptance"],
    ["implementation_handoff", INVALID_IMPLEMENTATION_HANDOFF_CASES.malformed_digest, "malformed_digest"],
    ["execution_claim", INVALID_EXECUTION_CLAIM_CASES.malformed_handoff_digest, "malformed_handoff_digest"],
    ["implementation_conformance", INVALID_CONFORMANCE_RESULT_CASES.pass_row_without_review_verdict, "pass_row_without_review_verdict"],
    ["implementation_conformance", INVALID_CONFORMANCE_RESULT_CASES.observable_pass_without_executed_tests, "observable_pass_without_executed_tests"],
    ["implementation_conformance", INVALID_CONFORMANCE_RESULT_CASES.overall_pass_with_blocking_findings, "overall_pass_with_blocking_findings"],
    ["implementation_conformance", INVALID_CONFORMANCE_RESULT_CASES.duplicate_subject_rows, "duplicate_subject_rows"],
  ];
  for (const [id, value, label] of invalidPairs) {
    const result = validateProducedArtifact(id, value);
    assert.equal(result.ok, false, `'${label}' must fail the '${id}' contract`);
    if (!result.ok) {
      assert.ok(result.issues.length > 0, `'${label}' must report diagnostics`);
    }
  }
});

// ── Immutable versioned artifacts ────────────────────────────────────────────

test("re-materializing a persisted phase version is rejected without overwriting", () => {
  const project = projectWithWorkspace();
  try {
    const content = "# Spec\n\n## Problem\n\nThe outcome must be readable.\n";
    const first = materializeForTest(project, materializeRequest(1, content));
    assert.ok(first.ok, first.ok ? "materialized" : `rejected: ${first.error}`);
    const currentPath = join(project.root, "specs", FIXED_FEATURE_ID, "spec.md");
    const before = readFileSync(currentPath, "utf8");

    const replay = materializeForTest(project, materializeRequest(1, content));
    assert.equal(replay.ok, false, "artifact versions are immutable and never overwritten");
    assert.equal(readFileSync(currentPath, "utf8"), before, "current bytes unchanged by the rejected replay");
  } finally {
    project.cleanup();
  }
});

// ── Bounded deterministic renderer registry ──────────────────────────────────

test("the deterministic specification renderer resolves, is irreplaceable, and is deterministic", () => {
  const project = projectWithWorkspace();
  try {
    writeTestRegistryMarker(project.root);
    registerTestSpecificationRenderer(project.root, {
      renderer_id: DEFAULT_SPECIFICATION_RENDERER_ID,
      render: (document: string) => document,
    });
    const resolved = resolveSpecificationRenderer(DEFAULT_SPECIFICATION_RENDERER_ID);
    assert.ok(resolved.ok, `the renderer must resolve: ${resolved.ok ? "" : resolved.error}`);
    if (!resolved.ok) return;
    const renderedOnce = resolved.value.render("# Title\\n\\nBody.\\n");
    const renderedTwice = resolved.value.render("# Title\\n\\nBody.\\n");
    assert.equal(renderedOnce, renderedTwice, "the renderer must be deterministic");
    assert.ok(renderedOnce.includes("# Title"), "the renderer must preserve document content");

    const replacement = registerTestSpecificationRenderer(project.root, {
      renderer_id: DEFAULT_SPECIFICATION_RENDERER_ID,
      render: (document: string) => `REPLACED:${document}`,
    });
    assert.equal(replacement.ok, false, "the canonical renderer cannot be replaced");
    const unsafeId = registerTestSpecificationRenderer(project.root, {
      renderer_id: "../evil",
      render: (document: string) => document,
    });
    assert.equal(unsafeId.ok, false, "renderer ids are bounded safe identifiers");
    assert.equal(requireDocumentRenderer(PRODUCT_PRD_RENDERER_ID).id, PRODUCT_PRD_RENDERER_ID);
  } finally {
    project.cleanup();
  }
});

 test("renderer registries have no reset path and preserve custom registration", () => {
  const project = projectWithWorkspace();
  try {
    writeTestRegistryMarker(project.root);
    const custom = registerTestSpecificationRenderer(project.root, {
      renderer_id: "custom-after-reset",
      render: (document: string) => document,
    });
    assert.equal(custom.ok, true, custom.ok ? "custom renderer registered" : custom.error);
    assert.equal(resolveSpecificationRenderer("custom-after-reset").ok, true);
  } finally {
    project.cleanup();
  }
});


// ── Content hashes and revalidation ──────────────────────────────────────────

test("materialization captures exact content hashes and revalidation detects manual edits", () => {
  const project = projectWithWorkspace();
  try {
    const content = "# Spec\n\n## Requirements\n\nFR-1 The thing works.\n";
    const materialized = materializeForTest(project, materializeRequest(1, content));
    assert.ok(materialized.ok);
    if (!materialized.ok) return;
    const hashes = materialized.value.document_hashes as Record<string, string>;
    assert.equal(hashes["spec.md"], sha256(content), "the exact content hash is captured");

    const untouched = revalidateMaterializedDocuments(project.root, {
      feature_id: FIXED_FEATURE_ID,
      phase: "specify",
      version: 1,
    });
    assert.ok(untouched.ok, "revalidation runs on an untouched workspace");
    if (!untouched.ok) return;
    const untouchedReport = untouched.value.documents as Record<string, { matches: boolean }>;
    assert.equal(untouchedReport["spec.md"].matches, true);

    const currentPath = join(project.root, "specs", FIXED_FEATURE_ID, "spec.md");
    writeFileSync(currentPath, "# Tampered\n", "utf8");
    const tampered = revalidateMaterializedDocuments(project.root, {
      feature_id: FIXED_FEATURE_ID,
      phase: "specify",
      version: 1,
    });
    assert.ok(tampered.ok);
    if (!tampered.ok) return;
    const tamperedReport = tampered.value.documents as Record<string, { expected_sha256: string; actual_sha256: string; matches: boolean }>;
    assert.equal(tamperedReport["spec.md"].expected_sha256, sha256(content));
    assert.equal(tamperedReport["spec.md"].actual_sha256, sha256("# Tampered\n"));
    assert.equal(tamperedReport["spec.md"].matches, false, "manual edits are detected");
  } finally {
    project.cleanup();
  }
});

test("revalidation rejects invalid UTF-8 current documents without mutation", () => {
  const project = projectWithWorkspace();
  try {
    const materialized = materializeForTest(project, materializeRequest(1, "# Spec\n"));
    assert.ok(materialized.ok, materialized.ok ? "materialized" : materialized.error);
    const featureDir = join(project.root, "specs", FIXED_FEATURE_ID);
    const currentPath = join(featureDir, "spec.md");
    const statePath = join(project.root, ".work-state", "features", FIXED_FEATURE_ID, "state.json");
    const manifestPath = join(project.root, ".work-state", "features", FIXED_FEATURE_ID, "artifacts", "documents", "specify", "v1.json");
    const beforeState = readFileSync(statePath);
    const beforeManifest = readFileSync(manifestPath);
    const invalid = Buffer.from([0x23, 0x20, 0xff, 0x0a]);
    writeFileSync(currentPath, invalid);

    const rejected = revalidateMaterializedDocuments(project.root, {
      feature_id: FIXED_FEATURE_ID,
      phase: "specify",
      version: 1,
    });

    assert.equal(rejected.ok, false);
    if (!rejected.ok) assert.equal(rejected.code, "SPEC_REQUEST_INVALID");
    assert.deepEqual(readFileSync(currentPath), invalid, "invalid document bytes remain unchanged");
    assert.deepEqual(readFileSync(statePath), beforeState, "revalidation does not mutate feature state");
    assert.deepEqual(readFileSync(manifestPath), beforeManifest, "revalidation does not mutate the manifest");
  } finally {
    project.cleanup();
  }
});

test("revalidation rejects invalid UTF-8 manifests without mutation", () => {
  const project = projectWithWorkspace();
  try {
    const materialized = materializeForTest(project, materializeRequest(1, "# Spec\n"));
    assert.ok(materialized.ok, materialized.ok ? "materialized" : materialized.error);
    const manifestPath = join(project.root, ".work-state", "features", FIXED_FEATURE_ID, "artifacts", "documents", "specify", "v1.json");
    const statePath = join(project.root, ".work-state", "features", FIXED_FEATURE_ID, "state.json");
    const documentPath = join(project.root, "specs", FIXED_FEATURE_ID, "spec.md");
    const beforeState = readFileSync(statePath);
    const beforeDocument = readFileSync(documentPath);
    const originalManifest = readFileSync(manifestPath);
    const invalid = Buffer.concat([Buffer.from([0xff]), originalManifest.subarray(1)]);
    writeFileSync(manifestPath, invalid);

    const rejected = revalidateMaterializedDocuments(project.root, {
      feature_id: FIXED_FEATURE_ID,
      phase: "specify",
      version: 1,
    });

    assert.equal(rejected.ok, false);
    if (!rejected.ok) assert.equal(rejected.code, "SPEC_PATH_UNAUTHORIZED");
    assert.deepEqual(readFileSync(manifestPath), invalid, "invalid manifest bytes remain unchanged");
    assert.deepEqual(readFileSync(statePath), beforeState, "revalidation does not mutate feature state");
    assert.deepEqual(readFileSync(documentPath), beforeDocument, "revalidation does not mutate documents");
  } finally {
    project.cleanup();
  }
});

// ── Revision history ─────────────────────────────────────────────────────────
test("changed document sets archive removed names before replacing the current projection", () => {
  const project = projectWithWorkspace();
  try {
    const v1Request = materializeRequest(1, "# Spec v1\n");
    v1Request.documents = [
      { path: "spec.md", content: "# Spec v1\n" },
      { path: "notes/removed.md", content: "# Removed v1\n" },
    ];
    const v1 = materializeForTest(project, v1Request);
    assert.ok(v1.ok, v1.ok ? "first version materialized" : v1.error);

    const v2Request = materializeRequest(2, "# Spec v2\n");
    v2Request.documents = [{ path: "spec.md", content: "# Spec v2\n" }];
    const v2 = materializeForTest(project, v2Request);
    assert.ok(v2.ok, v2.ok ? "changed document set materialized" : v2.error);

    const featureDir = join(project.root, "specs", FIXED_FEATURE_ID);
    assert.equal(readFileSync(join(featureDir, "history", "specify", "v1", "spec.md"), "utf8"), "# Spec v1\n");
    assert.equal(readFileSync(join(featureDir, "history", "specify", "v1", "notes", "removed.md"), "utf8"), "# Removed v1\n");
    assert.equal(readFileSync(join(featureDir, "spec.md"), "utf8"), "# Spec v2\n");
    assert.equal(existsSync(join(featureDir, "notes", "removed.md")), false, "removed names no longer remain in the current projection");
    assert.equal(existsSync(join(featureDir, "history", "specify", "v1.md")), false, "history identity follows the previous multi-document set");
  } finally {
    project.cleanup();
  }
});

test("an archive collision for a removed name rejects the changed set before any write", () => {
  const project = projectWithWorkspace();
  try {
    const v1Request = materializeRequest(1, "# Spec v1\n");
    v1Request.documents = [
      { path: "spec.md", content: "# Spec v1\n" },
      { path: "notes/removed.md", content: "# Removed v1\n" },
    ];
    assert.ok(materializeForTest(project, v1Request).ok);

    const featureDir = join(project.root, "specs", FIXED_FEATURE_ID);
    const collision = join(featureDir, "history", "specify", "v1", "notes", "removed.md");
    mkdirSync(join(featureDir, "history", "specify", "v1", "notes"), { recursive: true });
    writeFileSync(collision, "immutable collision\n", "utf8");

    const v2Request = materializeRequest(2, "# Spec v2\n");
    v2Request.documents = [{ path: "spec.md", content: "# Spec v2\n" }];
    const rejected = materializeForTest(project, v2Request);
    assert.equal(rejected.ok, false);
    if (!rejected.ok) assert.equal(rejected.code, "SPEC_ARTIFACT_IMMUTABLE");
    assert.equal(readFileSync(join(featureDir, "spec.md"), "utf8"), "# Spec v1\n");
    assert.equal(readFileSync(join(featureDir, "notes", "removed.md"), "utf8"), "# Removed v1\n");
    assert.equal(readFileSync(collision, "utf8"), "immutable collision\n");
    assert.equal(existsSync(join(featureDir, "history", "specify", "v1", "spec.md")), false);
    assert.equal(existsSync(join(project.root, ".work-state", "features", FIXED_FEATURE_ID, "artifacts", "documents", "specify", "v2.json")), false);
  } finally {
    project.cleanup();
  }
});

test("an unowned current-path collision aborts before archiving the previous projection", () => {
  const project = projectWithWorkspace();
  try {
    assert.ok(materializeForTest(project, materializeRequest(1, "# Spec v1\n")).ok);
    const featureDir = join(project.root, "specs", FIXED_FEATURE_ID);
    writeFileSync(join(featureDir, "new.md"), "unowned current content\n", "utf8");

    const v2Request = materializeRequest(2, "# Spec v2\n");
    v2Request.documents = [
      { path: "spec.md", content: "# Spec v2\n" },
      { path: "new.md", content: "# Claimed\n" },
    ];
    const rejected = materializeForTest(project, v2Request);
    assert.equal(rejected.ok, false);
    if (!rejected.ok) assert.equal(rejected.code, "SPEC_ARTIFACT_IMMUTABLE");
    assert.equal(readFileSync(join(featureDir, "spec.md"), "utf8"), "# Spec v1\n");
    assert.equal(readFileSync(join(featureDir, "new.md"), "utf8"), "unowned current content\n");
    assert.equal(existsSync(join(featureDir, "history", "specify", "v1.md")), false);
  } finally {
    project.cleanup();
  }
});


test("replacing a version archives the previous readable projection under history/", () => {
  const project = projectWithWorkspace();
  try {
    const v1Content = "# Spec v1\n\n## Problem\n\nOne.\n";
    const v1 = materializeForTest(project, materializeRequest(1, v1Content));
    assert.ok(v1.ok);

    const v2Content = "# Spec v2\n\n## Problem\n\nTwo.\n";
    const v2 = materializeForTest(project, materializeRequest(2, v2Content));
    assert.ok(v2.ok, v2.ok ? "second version materialized" : `rejected: ${v2.error}`);

    const featureDir = join(project.root, "specs", FIXED_FEATURE_ID);
    assert.equal(readFileSync(join(featureDir, "spec.md"), "utf8"), v2Content, "current projection is the new version");
    const archivedPath = join(featureDir, "history", "specify", "v1.md");
    assert.ok(existsSync(archivedPath), "the replaced projection is archived before the new current becomes visible");
    assert.equal(readFileSync(archivedPath, "utf8"), v1Content, "archived bytes are preserved");
  } finally {
    project.cleanup();
  }
});

test("multi-document revisions preserve every prior document at distinct deterministic paths", () => {
  const project = projectWithWorkspace();
  try {
    const v1Documents = [
      { path: "spec.md", content: "# Spec v1\n" },
      { path: "notes/decisions.md", content: "# Decisions v1\n" },
    ];
    const v1Request = materializeRequest(1, v1Documents[0]!.content);
    v1Request.documents = v1Documents;
    const v1 = materializeForTest(project, v1Request);
    assert.ok(v1.ok, v1.ok ? "first version materialized" : `rejected: ${v1.error}`);

    const v2Documents = [
      { path: "spec.md", content: "# Spec v2\n" },
      { path: "notes/decisions.md", content: "# Decisions v2\n" },
    ];
    const v2Request = materializeRequest(2, v2Documents[0]!.content);
    v2Request.documents = v2Documents;
    const v2 = materializeForTest(project, v2Request);
    assert.ok(v2.ok, v2.ok ? "second version materialized" : `rejected: ${v2.error}`);

    const featureDir = join(project.root, "specs", FIXED_FEATURE_ID);
    assert.equal(readFileSync(join(featureDir, "spec.md"), "utf8"), v2Documents[0]!.content);
    assert.equal(readFileSync(join(featureDir, "notes", "decisions.md"), "utf8"), v2Documents[1]!.content);
    assert.equal(readFileSync(join(featureDir, "history", "specify", "v1", "spec.md"), "utf8"), v1Documents[0]!.content);
    assert.equal(
      readFileSync(join(featureDir, "history", "specify", "v1", "notes", "decisions.md"), "utf8"),
      v1Documents[1]!.content,
    );
    assert.equal(existsSync(join(featureDir, "history", "specify", "v1.md")), false, "multi-document history never uses the colliding legacy path");
  } finally {
    project.cleanup();
  }
});

test("an archive collision rejects the whole multi-document revision before any write", () => {
  const project = projectWithWorkspace();
  try {
    const v1Request = materializeRequest(1, "# Spec v1\n");
    v1Request.documents = [
      { path: "spec.md", content: "# Spec v1\n" },
      { path: "notes/decisions.md", content: "# Decisions v1\n" },
    ];
    const v1 = materializeForTest(project, v1Request);
    assert.ok(v1.ok);

    const featureDir = join(project.root, "specs", FIXED_FEATURE_ID);
    const collidingArchive = join(featureDir, "history", "specify", "v1", "notes", "decisions.md");
    mkdirSync(join(featureDir, "history", "specify", "v1", "notes"), { recursive: true });
    writeFileSync(collidingArchive, "existing immutable history\n", "utf8");

    const v2Request = materializeRequest(2, "# Spec v2\n");
    v2Request.documents = [
      { path: "spec.md", content: "# Spec v2\n" },
      { path: "notes/decisions.md", content: "# Decisions v2\n" },
    ];
    const rejected = materializeForTest(project, v2Request);
    assert.equal(rejected.ok, false);
    if (!rejected.ok) assert.equal(rejected.code, "SPEC_ARTIFACT_IMMUTABLE");
    assert.equal(readFileSync(join(featureDir, "spec.md"), "utf8"), "# Spec v1\n");
    assert.equal(readFileSync(join(featureDir, "notes", "decisions.md"), "utf8"), "# Decisions v1\n");
    assert.equal(readFileSync(collidingArchive, "utf8"), "existing immutable history\n");
    assert.equal(existsSync(join(featureDir, "history", "specify", "v1", "spec.md")), false, "no earlier archive write occurs before collision rejection");
    assert.equal(
      existsSync(join(project.root, ".work-state", "features", FIXED_FEATURE_ID, "artifacts", "documents", "specify", "v2.json")),
      false,
      "the rejected revision writes no manifest",
    );
  } finally {
    project.cleanup();
  }
});
test("direct materialization enforces the canonical UTF-8 document cap atomically", () => {
  const project = projectWithWorkspace();
  try {
    const multibyte = "✓";
    const exactContent = "x".repeat(MAX_PHASE_INPUT_BYTES - Buffer.byteLength(multibyte, "utf8")) + multibyte;
    assert.equal(Buffer.byteLength(exactContent, "utf8"), MAX_PHASE_INPUT_BYTES);
    const exactRequest = materializeRequest(1, exactContent);
    const accepted = materializeForTest(project, exactRequest);
    assert.equal(accepted.ok, true, accepted.ok ? "exact-cap document materialized" : accepted.error);
    const documentPath = join(project.root, "specs", FIXED_FEATURE_ID, "spec.md");
    assert.equal(Buffer.byteLength(readFileSync(documentPath), "utf8"), MAX_PHASE_INPUT_BYTES);
    const statePath = join(project.root, ".work-state", "features", FIXED_FEATURE_ID, "state.json");
    const artifactsPath = join(project.root, ".work-state", "features", FIXED_FEATURE_ID, "artifacts");
    const featurePath = join(project.root, "specs", FIXED_FEATURE_ID);
    const beforeState = readFileSync(statePath);
    const beforeArtifacts = readdirSync(artifactsPath).sort();
    const beforeFeature = readdirSync(featurePath).sort();
    const oversized = materializeRequest(2, exactContent + "x");
    const rejected = materializeForTest(project, oversized);
    assert.equal(rejected.ok, false, "a document one UTF-8 byte over the cap must be rejected");
    if (!rejected.ok) {
      assert.equal(rejected.code, "SPEC_REQUEST_INVALID");
      assert.match(rejected.error, /UTF-8 limit/u);
    }
    assert.deepEqual(readFileSync(statePath), beforeState, "oversize rejection leaves workflow state unchanged");
    assert.deepEqual(readdirSync(artifactsPath).sort(), beforeArtifacts, "oversize rejection writes no manifest or archive");
    assert.deepEqual(readFileSync(documentPath), Buffer.from(exactContent, "utf8"), "oversize rejection leaves the exact-cap document unchanged");
  } finally {
    project.cleanup();
  }
});

test("huge nested work identity is rejected before any document or manifest write", () => {
  const project = projectWithWorkspace();
  try {
    const dispatchId = "dispatch-binding-1";
    const identity = {
      run_id: "run-artifacts-1",
      wave_id: "wave-1",
      slice_id: "slice-1",
      session_id: "session-1",
      workflow: "standard" as const,
      stage_id: "specify",
      stage_cursor: "specify",
      capability_id: "capability-1",
      capability_epoch: "epoch-1",
      slot_id: "slot-1",
      task_id: "task-1",
      dispatch_id: dispatchId,
      attempt: 1,
      worker_id: "worker-1",
      nested: { payload: "x".repeat(8 * 1024 * 1024) },
    };
    const request = {
      ...materializeRequest(1, "# Spec\n"),
      binding: {
        artifact_id: "specify.v1",
        dispatch_id: dispatchId,
        work_identity: identity,
        constitution_binding: validConstitutionBinding(),
        upstream_versions: [],
      },
    };
    const rejected = materializeForTest(project, request);
    assert.equal(rejected.ok, false, "nested work identity data must be rejected");
    if (!rejected.ok) {
      assert.equal(rejected.code, "SPEC_REQUEST_INVALID");
      assert.match(rejected.error, /unknown field/u);
    }
    assert.equal(
      existsSync(join(project.root, ".work-state", "features", FIXED_FEATURE_ID, "artifacts", "documents", "specify", "v1.json")),
      false,
      "identity rejection writes no manifest",
    );
  } finally {
    project.cleanup();
  }
});


// ── Path escapes fail closed ─────────────────────────────────────────────────

test("document paths that escape the feature workspace fail closed and write nothing", () => {
  const project = projectWithWorkspace();
  try {
    const escapingPaths = ["../evil.md", "/etc/evil.md", "a\\b.md", "..\\..\\evil.md"];
    for (const escape of escapingPaths) {
      const request = materializeRequest(3, "# Should never land\n");
      request.documents = [{ path: escape, content: "# Should never land\n" }];
      const result = materializeForTest(project, request);
      assert.equal(result.ok, false, `path ${JSON.stringify(escape)} must be rejected`);
      if (!result.ok) assert.equal(result.code, "SPEC_PATH_UNAUTHORIZED", `path ${JSON.stringify(escape)}`);
    }
    assert.ok(!existsSync(join(project.root, "evil.md")), "no traversal write outside the workspace");
    assert.ok(!existsSync("/etc/evil.md"), "no absolute write");

    const featureDir = join(project.root, "specs", FIXED_FEATURE_ID);
    const outside = mkdtempSync(join(tmpdir(), "spec-render-escape-"));
    try {
      mkdirSync(join(featureDir, "public"), { recursive: true });
      symlinkSync(outside, join(featureDir, "public", "out"), "dir");
      const symlinkRequest = materializeRequest(3, "# Symlink escape\n");
      symlinkRequest.documents = [{ path: "public/out/evil.md", content: "# Symlink escape\n" }];
      const symlinkResult = materializeForTest(project, symlinkRequest);
      assert.equal(symlinkResult.ok, false, "symlink realpath escapes are rejected");
      if (!symlinkResult.ok) assert.equal(symlinkResult.code, "SPEC_PATH_UNAUTHORIZED");
      assert.equal(readdirSync(outside).length, 0, "nothing written through the symlink");
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  } finally {
    project.cleanup();
  }
});


test("manifest and archive writes reject symlinked directories outside the project", () => {
  const project = projectWithWorkspace();
  const outside = mkdtempSync(join(tmpdir(), "spec-manifest-escape-"));
  try {
    const artifacts = join(project.root, ".work-state", "features", FIXED_FEATURE_ID, "artifacts");
    rmSync(artifacts, { recursive: true, force: true });
    symlinkSync(outside, artifacts, "dir");
    const manifestEscape = materializeForTest(project, materializeRequest(1, "# Never written\n"));
    assert.equal(manifestEscape.ok, false);
    if (!manifestEscape.ok) assert.equal(manifestEscape.code, "SPEC_PATH_UNAUTHORIZED");
    assert.equal(readdirSync(outside).length, 0);
  } finally {
    project.cleanup();
    rmSync(outside, { recursive: true, force: true });
  }

  const manifestFinalProject = projectWithWorkspace();
  const manifestFinalOutside = mkdtempSync(join(tmpdir(), "spec-manifest-final-escape-"));
  try {
    const manifestTarget = join(manifestFinalProject.root, ".work-state", "features", FIXED_FEATURE_ID, "artifacts", "documents", "specify", "v1.json");
    mkdirSync(join(manifestFinalProject.root, ".work-state", "features", FIXED_FEATURE_ID, "artifacts", "documents", "specify"), { recursive: true });
    const outsideManifest = join(manifestFinalOutside, "v1.json");
    writeFileSync(outsideManifest, "prior manifest\n", "utf8");
    symlinkSync(outsideManifest, manifestTarget, "file");
    const manifestFinalEscape = materializeForTest(manifestFinalProject, materializeRequest(1, "# Never written\n"));
    assert.equal(manifestFinalEscape.ok, false);
    if (!manifestFinalEscape.ok) assert.equal(manifestFinalEscape.code, "SPEC_PATH_UNAUTHORIZED");
    assert.equal(readFileSync(outsideManifest, "utf8"), "prior manifest\n");
    assert.equal(existsSync(join(manifestFinalProject.root, "specs", FIXED_FEATURE_ID, "spec.md")), false, "final manifest symlink rejects before document writes");
  } finally {
    manifestFinalProject.cleanup();
    rmSync(manifestFinalOutside, { recursive: true, force: true });
  }

  const archiveProject = projectWithWorkspace();
  const archiveOutside = mkdtempSync(join(tmpdir(), "spec-archive-escape-"));
  try {
    const v1 = materializeForTest(archiveProject, materializeRequest(1, "# Version one\n"));
    assert.ok(v1.ok);
    const featureDir = join(archiveProject.root, "specs", FIXED_FEATURE_ID);
    symlinkSync(archiveOutside, join(featureDir, "history"), "dir");
    const v2 = materializeForTest(archiveProject, materializeRequest(2, "# Version two\n"));
    assert.equal(v2.ok, false);
    if (!v2.ok) assert.equal(v2.code, "SPEC_PATH_UNAUTHORIZED");
    assert.equal(readFileSync(join(featureDir, "spec.md"), "utf8"), "# Version one\n");
    assert.equal(readdirSync(archiveOutside).length, 0);
  } finally {
    archiveProject.cleanup();
    rmSync(archiveOutside, { recursive: true, force: true });
  }

  const archiveFinalProject = projectWithWorkspace();
  const archiveFinalOutside = mkdtempSync(join(tmpdir(), "spec-archive-final-escape-"));
  try {
    const v1 = materializeForTest(archiveFinalProject, materializeRequest(1, "# Version one\n"));
    assert.ok(v1.ok);
    const featureDir = join(archiveFinalProject.root, "specs", FIXED_FEATURE_ID);
    mkdirSync(join(featureDir, "history", "specify"), { recursive: true });
    const archiveTarget = join(featureDir, "history", "specify", "v1.md");
    const outsideArchive = join(archiveFinalOutside, "v1.md");
    writeFileSync(outsideArchive, "prior archive\n", "utf8");
    symlinkSync(outsideArchive, archiveTarget, "file");
    const v2 = materializeForTest(archiveFinalProject, materializeRequest(2, "# Version two\n"));
    assert.equal(v2.ok, false);
    if (!v2.ok) assert.equal(v2.code, "SPEC_PATH_UNAUTHORIZED");
    assert.equal(readFileSync(join(featureDir, "spec.md"), "utf8"), "# Version one\n");
    assert.equal(readFileSync(outsideArchive, "utf8"), "prior archive\n");
  } finally {
    archiveFinalProject.cleanup();
    rmSync(archiveFinalOutside, { recursive: true, force: true });
  }
});

test("revalidation rejects traversal and malformed persisted manifest entries", () => {
  const project = projectWithWorkspace();
  try {
    const materialized = materializeForTest(project, materializeRequest(1, "# Spec\n"));
    assert.ok(materialized.ok);
    const manifest = join(project.root, ".work-state", "features", FIXED_FEATURE_ID, "artifacts", "documents", "specify", "v1.json");
    writeFileSync(manifest, JSON.stringify({ schema_version: 1, feature_id: FIXED_FEATURE_ID, phase: "specify", version: 1, documents: [{ path: "../../outside.md", sha256: sha256("outside") }] }), "utf8");
    const traversal = revalidateMaterializedDocuments(project.root, { feature_id: FIXED_FEATURE_ID, phase: "specify", version: 1 });
    assert.equal(traversal.ok, false);
    if (!traversal.ok) assert.equal(traversal.code, "SPEC_PATH_UNAUTHORIZED");
    writeFileSync(manifest, JSON.stringify({ schema_version: 1, feature_id: FIXED_FEATURE_ID, phase: "specify", version: 1, documents: [{ path: "spec.md" }] }), "utf8");
    const malformed = revalidateMaterializedDocuments(project.root, { feature_id: FIXED_FEATURE_ID, phase: "specify", version: 1 });
    assert.equal(malformed.ok, false);
    if (!malformed.ok) assert.equal(malformed.code, "SPEC_REQUEST_INVALID");
  } finally { project.cleanup(); }
});
