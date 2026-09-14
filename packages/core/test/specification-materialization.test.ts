import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { marked } from "marked";
import { test } from "node:test";
import type { CompatibilityReport, ImplementationHandoff } from "../src/specification/types.js";
import { CTO_REVIEW_AUTHORITY_STATEMENT } from "../src/cto/specification-review-packet.js";
import type { CtoSpecificationReviewPacket } from "../src/cto/specification-review-packet.js";
import {
  materializeCompatibilityReport,
  materializeCtoSpecificationReviewPacket,
  materializeImplementationConformance,
  materializeImplementationHandoff,
  materializeMigrationReceipt,
} from "../src/specification/materialize.js";
import { MAX_CTO_REVIEW_PACKET_BYTES, MAX_PINNED_ROOT_READ_BYTES } from "../src/specification/limits.js";
import { PinnedProjectRoot } from "../src/specification/pinned-root.js";
import { readPinnedCurrentConstitution } from "../src/specification/constitution-identities.js";
import { canonicalHandoffDigest } from "../src/specification/handoff.js";
import { ensureProjectConstitution } from "../src/specification/prerequisite.js";

import {
  FIXED_FEATURE_ID,
  FIXED_NOW,
  sha256,
  validConstitutionBinding,
  validImplementationConformance,
  validImplementationHandoff,
} from "./fixtures/specification-fixtures.js";
import { implementationConformanceMatrixDigest } from "../src/specification/validation.js";

const CTO_MARKER = "omp-cto-slice";

function readable(root: string, path: string): string {
  return readFileSync(join(root, "specs", FIXED_FEATURE_ID, path), "utf8");
}

function guardedHandoffOptions(root: string, handoff: ImplementationHandoff): { beforeWrite: (path: string) => void } {
  writeFileSync(join(root, "CONSTITUTION.md"), "# Project Constitution v1.0.0\n\n## I. Quality\n\nShip tested work.\n", "utf8");
  const ensured = ensureProjectConstitution(root, {
    origin_kind: "native_direct",
    origin_run_key: "materialization-guard",
    origin_stage: "specify",
  });
  assert.ok(ensured.ok, ensured.ok ? "constitution gate ensured" : ensured.error);
  if (ensured.ok && ensured.value.binding) {
    handoff.constitution_binding = ensured.value.binding;
    handoff.handoff_digest = canonicalHandoffDigest(handoff);
  }
  return {
    beforeWrite: () => {
      const pinned = PinnedProjectRoot.open(root);
      assert.ok(pinned, "project root must remain pinnable for handoff projection");
      if (!pinned) return;
      try {
        const current = readPinnedCurrentConstitution(root, pinned, handoff.constitution_binding);
        if (!current.ok) throw new Error(current.error);
      } finally {
        pinned.close();
      }
    },
  };
}

function assertStableProjection(
  root: string,
  path: string,
  materialize: () => { ok: boolean; error?: string },
  assertions: (content: string) => void,
): void {
  const first = materialize();
  assert.equal(first.ok, true, first.ok ? "materialized" : first.error);
  const firstContent = readable(root, path);
  assertions(firstContent);
  const second = materialize();
  assert.equal(second.ok, true, second.ok ? "materialized" : second.error);
  assert.equal(readable(root, path), firstContent, `${path} rendering is deterministic`);
}

test("implementation handoff projection rejects missing synchronous constitution guard before writing", () => {
  const root = mkdtempSync(join(tmpdir(), "spec-readable-handoff-guard-required-"));
  const handoff = validImplementationHandoff();
  try {
    const rejected = materializeImplementationHandoff(root, handoff, undefined as never);
    assert.equal(rejected.ok, false);
    if (!rejected.ok) {
      assert.equal(rejected.code, "SPEC_REQUEST_INVALID");
      assert.match(rejected.error, /beforeWrite.*constitution guard/u);
    }
    assert.deepEqual(readdirSync(root), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("readable handoff, compatibility, conformance, and migration projections carry provenance without transport markers", () => {
  const root = mkdtempSync(join(tmpdir(), "spec-readable-projections-"));
  try {
    const handoff = validImplementationHandoff();
    const constitution = validConstitutionBinding();
    const compatibility: CompatibilityReport = {
      report_id: "compatibility.feature-one.v1",
      snapshot_ref: "import.snapshot.v1",
      constitution_binding: constitution,
      document_language: "en",
      document_language_source: "unknown",
      framework: "generic",
      mapping_id: "generic-requirements-plan-tasks",
      mapping_version: "1",
      selected_paths: ["external/spec.md"],
      status: "ready",
      mapping: [{ source_ref: "external/spec.md", contract_subject: "requirement", subject_id: "FR-1" }],
      blocking_findings: [],
      warnings: [],
      ignored_content: [],
      supplement_ref: null,
      evaluated_at: FIXED_NOW,
    };
    const conformance = validImplementationConformance();
    const sourceSha256 = sha256("legacy-source-bytes");
    const receipt = {
      receipt_id: "migration.feature-one.v1",
      source_sha256: sourceSha256,
      outcome: "migrated" as const,
      constitution_binding: null,
      diagnostics: [],
    };

    assertStableProjection(root, "handoff.md", () => materializeImplementationHandoff(root, handoff, guardedHandoffOptions(root, handoff)), (content) => {
      assert.doesNotMatch(content, new RegExp(CTO_MARKER));
      assert.match(content, /feature-one\.handoff\.v1/);
      assert.match(content, new RegExp(handoff.handoff_digest));
      assert.match(content, new RegExp(constitution.content_sha256));
    });
    assertStableProjection(root, "compatibility.md", () => materializeCompatibilityReport(root, FIXED_FEATURE_ID, compatibility), (content) => {
      assert.doesNotMatch(content, new RegExp(CTO_MARKER));
      assert.match(content, /compatibility\.feature-one\.v1/);
      assert.match(content, new RegExp(constitution.content_sha256));
    });
    assertStableProjection(root, "validation/implementation-conformance.md", () => materializeImplementationConformance(root, conformance), (content) => {
      assert.doesNotMatch(content, new RegExp(CTO_MARKER));
      assert.match(content, new RegExp(conformance.conformance_id));
      assert.match(content, new RegExp(conformance.matrix_digest));
      assert.match(content, new RegExp(conformance.handoff_digest));
    });
    assertStableProjection(root, "migration.md", () => materializeMigrationReceipt(root, FIXED_FEATURE_ID, receipt), (content) => {
      assert.doesNotMatch(content, new RegExp(CTO_MARKER));
      assert.match(content, new RegExp(receipt.receipt_id));
      assert.match(content, new RegExp(sourceSha256));
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("external handoff provenance is mandatory and projection renders copied text inert", () => {
  const root = mkdtempSync(join(tmpdir(), "spec-readable-external-"));
  try {
    const external = validImplementationHandoff() as unknown as ImplementationHandoff;
    external.source_kind = "external";
    external.content_provenance = {
      source_kind: "external",
      content_role: "untrusted_inert_data",
      embedded_instruction_policy: "inert_data_only",
      source_refs: ["external/spec.md"],
    };
    external.requirements[0]!.statement = '<script>alert("x")</script> [run](https://evil.test)';
    const projected = materializeImplementationHandoff(root, external, guardedHandoffOptions(root, external));
    assert.equal(projected.ok, true, projected.ok ? "projected" : projected.error);
    const content = readable(root, "handoff.md");
    assert.doesNotMatch(content, /<script>|<\/script>|\[run\]\(https?:/i);
    assert.match(content, /<BEGIN_UNTRUSTED_EXTERNAL_DATA label="handoff\.requirement\.statement">/);
    assert.match(content, /INVARIANT:.*non-authoritative imported data/);
    assert.match(content, /Imported content handling/);
    assert.match(content, /Content role: `untrusted_inert_data`/);
    assert.match(content, /Embedded instruction policy: `inert_data_only`/);

    const missingProvenance = structuredClone(external);
    delete missingProvenance.content_provenance;
    const blocked = materializeImplementationHandoff(root, missingProvenance, guardedHandoffOptions(root, missingProvenance));
    assert.equal(blocked.ok, false);
    assert.equal(blocked.code, "SPEC_REQUEST_INVALID");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("adversarial metadata stays literal and cannot break readable sections or table cells", () => {
  const root = mkdtempSync(join(tmpdir(), "spec-readable-adversarial-"));
  const hostile = "`single``double`| # heading\n- list\n``` fence\n[link](https://evil.test)`";
  try {
    const handoff = validImplementationHandoff() as unknown as ImplementationHandoff;
    handoff.handoff_id = hostile;
    handoff.language = hostile;
    handoff.content_provenance = {
      source_kind: "external",
      content_role: "untrusted_inert_data",
      embedded_instruction_policy: "inert_data_only",
      source_refs: ["external/spec.md"],
    };
    handoff.source_kind = "external";
    handoff.tasks[0]!.title = hostile;

    const handoffResult = materializeImplementationHandoff(root, handoff, guardedHandoffOptions(root, handoff));
    assert.equal(handoffResult.ok, true, handoffResult.ok ? "handoff projected" : handoffResult.error);
    const handoffHtml = marked.parse(readable(root, "handoff.md"));
    assert.equal((handoffHtml.match(/<h1>/g) ?? []).length, 1, "hostile handoff id does not create another heading");
    assert.doesNotMatch(handoffHtml, /<a\s+href=/i, "hostile handoff metadata does not create a link");
    assert.match(handoffHtml, /<code>.*single.*double.*# heading.*list.*link.*<\/code>/s);

    const compatibility: CompatibilityReport = {
      report_id: hostile,
      snapshot_ref: hostile,
      constitution_binding: validConstitutionBinding(),
      document_language: "en",
      document_language_source: "unknown",
      framework: "generic",
      mapping_id: "generic-requirements-plan-tasks",
      mapping_version: "1",
      selected_paths: [hostile],
      status: "ready",
      mapping: [{ source_ref: hostile, contract_subject: hostile, subject_id: hostile }],
      blocking_findings: [{ code: hostile, subject_id: hostile, message: hostile, evidence_refs: [hostile] }],
      warnings: [],
      ignored_content: [{ path: hostile, reason: hostile }],
      supplement_ref: hostile,
      evaluated_at: FIXED_NOW,
    };
    const compatibilityResult = materializeCompatibilityReport(root, FIXED_FEATURE_ID, compatibility, { next_command: hostile });
    assert.equal(compatibilityResult.ok, true, compatibilityResult.ok ? "compatibility projected" : compatibilityResult.error);
    const compatibilityHtml = marked.parse(readable(root, "compatibility.md"));
    assert.equal((compatibilityHtml.match(/<h1>/g) ?? []).length, 1, "hostile compatibility metadata does not create another heading");
    assert.doesNotMatch(compatibilityHtml, /<a\s+href=/i, "hostile compatibility metadata does not create a link");

    const conformance = validImplementationConformance();
    conformance.entries[0]!.implementation_evidence_refs[0]!.artifact_id = hostile;
    conformance.entries[0]!.findings = [{ code: hostile, subject_id: hostile, message: hostile, evidence_refs: [hostile] }];
    conformance.quality_gate_results[0]!.findings = [{ code: hostile, subject_id: hostile, message: hostile, evidence_refs: [hostile] }];
    conformance.matrix_digest = implementationConformanceMatrixDigest(conformance)!;
    conformance.conformance_id = `implementation-conformance.${conformance.matrix_digest}`;
    const conformanceResult = materializeImplementationConformance(root, conformance);
    const conformanceHtml = marked.parse(readable(root, "validation/implementation-conformance.md"));
    assert.equal((conformanceHtml.match(/<table>/g) ?? []).length, 2, "escaped pipes preserve both conformance tables");
    assert.equal((conformanceHtml.match(/<h1>/g) ?? []).length, 1, "hostile conformance metadata does not create another heading");
    assert.doesNotMatch(conformanceHtml, /<a\s+href=/i, "hostile conformance metadata does not create a link");
    assert.match(conformanceHtml, /<code>.*single.*double.*# heading.*list.*link.*<\/code>/s);

    const migrationResult = materializeMigrationReceipt(root, FIXED_FEATURE_ID, {
      receipt_id: hostile,
      source_sha256: sha256("legacy-source-bytes"),
      outcome: "migrated",
      constitution_binding: null,
      diagnostics: [{ code: hostile, path: hostile, message: hostile }],
    });
    assert.equal(migrationResult.ok, true, migrationResult.ok ? "migration projected" : migrationResult.error);
    const migrationHtml = marked.parse(readable(root, "migration.md"));
    assert.equal((migrationHtml.match(/<h1>/g) ?? []).length, 1, "hostile migration metadata does not create another heading");
    assert.doesNotMatch(migrationHtml, /<a\s+href=/i, "hostile migration metadata does not create a link");
    assert.match(migrationHtml, /<code>.*single.*double.*# heading.*list.*link.*<\/code>/s);

    const reviewPacket: CtoSpecificationReviewPacket = {
      schema_version: 1,
      packet_ref: "cto.specification-review-packet.review-safe",
      cto_run_id: "review-safe",
      grants_approval: false,
      authority_statement: CTO_REVIEW_AUTHORITY_STATEMENT,
      features: [{
        feature_id: FIXED_FEATURE_ID,
        run_key: "review-run-safe",
        display_name: hostile,
        workspace_status: "in_progress",
        workspace_next_action: hostile,
        handoff_ref: hostile,
        phases: [{
          phase: "tasks",
          status: "awaiting_approval",
          version: null,
          approved_version: null,
          validation_ref: hostile,
          checkpoint_ref: hostile,
          decision: "approve_continue",
          decision_checkpoint_ref: hostile,
          trusted_answer_ref: hostile,
          next_action: hostile,
        }],
      }],
      recorded_decisions: [{
        feature_id: FIXED_FEATURE_ID,
        run_key: "review-run-safe",
        phase: "tasks",
        decision: "approve_continue",
        checkpoint_ref: hostile,
        trusted_answer_ref: hostile,
      }],
      decision_count: 1,
    };
    const packetResult = materializeCtoSpecificationReviewPacket(root, reviewPacket);
    assert.equal(packetResult.ok, true, packetResult.ok ? "review packet projected" : packetResult.error);
    const packetPath = join(root, ".work-state", "cto", "review-safe", "specification-review-packet.md");
    const packetHtml = marked.parse(readFileSync(packetPath, "utf8"));
    assert.equal((packetHtml.match(/<table>/g) ?? []).length, 1, "escaped pipes preserve the review packet table");
    assert.equal((packetHtml.match(/<h1>/g) ?? []).length, 1, "hostile review metadata does not create another heading");
    assert.doesNotMatch(packetHtml, /<a\s+href=/i, "hostile review metadata does not create a link");
    assert.match(packetHtml, /<code>.*single.*double.*# heading.*list.*link.*<\/code>/s);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});


test("review packet validation rejects forged authority, unknown keys, unsafe ids, and inconsistent decision counts", () => {
  const root = mkdtempSync(join(tmpdir(), "spec-readable-review-validation-"));
  const packet = () => ({
    schema_version: 1 as const,
    packet_ref: "cto.specification-review-packet.review-validation",
    cto_run_id: "review-validation",
    grants_approval: false as const,
    authority_statement: CTO_REVIEW_AUTHORITY_STATEMENT,
    features: [],
    recorded_decisions: [],
    decision_count: 0,
  });
  try {
    const malformed = [
      { label: "unknown top-level key", value: { ...packet(), unexpected: true } },
      { label: "forged authority", value: { ...packet(), authority_statement: "This packet grants approval." } },
      { label: "approval flag", value: { ...packet(), grants_approval: true } },
      { label: "unsafe CTO run", value: { ...packet(), cto_run_id: "../outside", packet_ref: "cto.specification-review-packet..." } },
      { label: "decision count", value: { ...packet(), decision_count: 1 } },
    ];
    for (const candidate of malformed) {
      const result = materializeCtoSpecificationReviewPacket(root, candidate.value as unknown as CtoSpecificationReviewPacket);
      assert.equal(result.ok, false, `${candidate.label} must be rejected`);
      if (!result.ok) assert.equal(result.code, "CTO_REVIEW_PACKET_INVALID", candidate.label);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("review packet feature rows render hostile display metadata as inert Markdown", () => {
  const root = mkdtempSync(join(tmpdir(), "spec-readable-review-hostile-"));
  try {
    const packet: CtoSpecificationReviewPacket = {
      schema_version: 1,
      packet_ref: "cto.specification-review-packet.review-hostile",
      cto_run_id: "review-hostile",
      grants_approval: false,
      authority_statement: CTO_REVIEW_AUTHORITY_STATEMENT,
      features: [{
        feature_id: FIXED_FEATURE_ID,
        run_key: "review-hostile-run",
        display_name: '<script>alert("x")</script> [run](https://evil.test)',
        workspace_status: "in_progress",
        workspace_next_action: '> quoted\n# injected heading',
        handoff_ref: "handoff.<script>",
        phases: [{
          phase: "tasks",
          status: "awaiting_approval",
          version: 1,
          approved_version: null,
          validation_ref: "validation.tasks.v1",
          checkpoint_ref: "checkpoint.tasks.v1",
          decision: null,
          decision_checkpoint_ref: null,
          trusted_answer_ref: null,
          next_action: '> next\n# heading',
        }],
      }],
      recorded_decisions: [],
      decision_count: 0,
    };
    const result = materializeCtoSpecificationReviewPacket(root, packet);
    assert.equal(result.ok, true, result.ok ? "packet projected" : result.error);
    const output = readFileSync(join(root, ".work-state", "cto", "review-hostile", "specification-review-packet.md"), "utf8");
    const html = marked.parse(output);
    assert.doesNotMatch(html, /<script>|<a\s+href=/i);
    assert.equal((html.match(/<h1>/g) ?? []).length, 1);
    assert.equal((html.match(/<blockquote>/g) ?? []).length, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("review packet producer and consumer digests cover exact persisted UTF-8 bytes and replay same or replaces different bytes", () => {
  const root = mkdtempSync(join(tmpdir(), "spec-readable-review-digest-"));
  const packet: CtoSpecificationReviewPacket = {
    schema_version: 1,
    packet_ref: "cto.specification-review-packet.review-digest-unicode",
    cto_run_id: "review-digest-unicode",
    grants_approval: false,
    authority_statement: CTO_REVIEW_AUTHORITY_STATEMENT,
    features: [{
      feature_id: FIXED_FEATURE_ID,
      run_key: "review-digest-run",
      display_name: "Ревью ✅\nUnicode",
      workspace_status: "in_progress",
      workspace_next_action: "Проверить\r\nбайты",
      handoff_ref: null,
      phases: [{
        phase: "tasks",
        status: "awaiting_approval",
        version: 1,
        approved_version: null,
        validation_ref: "validation.tasks.v1",
        checkpoint_ref: "checkpoint.tasks.v1",
        decision: null,
        decision_checkpoint_ref: null,
        trusted_answer_ref: null,
        next_action: "approve",
      }],
    }],
    recorded_decisions: [],
    decision_count: 0,
  };
  const packetPath = join(root, ".work-state", "cto", packet.cto_run_id, "specification-review-packet.md");
  try {
    const first = materializeCtoSpecificationReviewPacket(root, packet);
    assert.equal(first.ok, true, first.ok ? "review packet projected" : first.error);
    const firstBytes = readFileSync(packetPath);
    const firstContent = firstBytes.toString("utf8");
    assert.equal(firstContent.endsWith("\n"), true, "persisted packet has the canonical terminal newline");
    assert.equal(firstContent.endsWith("\n\n"), false, "persisted packet has exactly one terminal newline");
    assert.match(firstContent, /Ревью ✅/);
    assert.equal(first.ok ? first.value.content_sha256 : null, sha256(firstContent), "digest is over persisted bytes");

    const replay = materializeCtoSpecificationReviewPacket(root, packet);
    assert.equal(replay.ok, true, replay.ok ? "review packet replayed" : replay.error);
    assert.deepEqual(readFileSync(packetPath), firstBytes, "replay preserves exact persisted bytes");
    assert.equal(replay.ok ? replay.value.content_sha256 : null, sha256(firstContent), "replay returns the same persisted-byte digest");

    writeFileSync(packetPath, "different existing bytes\n", "utf8");
    const replaced = materializeCtoSpecificationReviewPacket(root, packet);
    assert.equal(replaced.ok, true, replaced.ok ? "different existing packet replaced" : replaced.error);
    assert.deepEqual(readFileSync(packetPath), firstBytes, "different existing bytes are replaced by the canonical packet");
    assert.equal(replaced.ok ? replaced.value.content_sha256 : null, sha256(firstContent), "replacement returns the canonical persisted-byte digest");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("review packet rendering rejects over-limit output before any write and replays near the byte bound", () => {
  const feature = (index: number) => ({
    feature_id: `feature-${index}`,
    run_key: `run-${index}`,
    display_name: `Feature ${index}`,
    workspace_status: "in_progress" as const,
    workspace_next_action: "review_packet_ready",
    handoff_ref: null,
    phases: [{
      phase: "specify" as const,
      status: "awaiting_approval" as const,
      version: 1,
      approved_version: null,
      validation_ref: null,
      checkpoint_ref: null,
      decision: null,
      decision_checkpoint_ref: null,
      trusted_answer_ref: null,
      next_action: "approve",
    }],
  });
  const packetFor = (featureCount: number): CtoSpecificationReviewPacket => ({
    schema_version: 1,
    packet_ref: "cto.specification-review-packet.review-size",
    cto_run_id: "review-size",
    grants_approval: false,
    authority_statement: CTO_REVIEW_AUTHORITY_STATEMENT,
    features: Array.from({ length: featureCount }, (_, index) => feature(index)),
    recorded_decisions: [],
    decision_count: 0,
  });
  const nearRoot = mkdtempSync(join(tmpdir(), "spec-readable-review-near-bound-"));
  const stringRoot = mkdtempSync(join(tmpdir(), "spec-readable-review-string-bound-"));
  const oversizedRoot = mkdtempSync(join(tmpdir(), "spec-readable-review-oversized-"));
  try {
    const oversizedStringPacket = packetFor(1);
    oversizedStringPacket.features[0]!.display_name = "x".repeat(32 * 1024 + 1);
    const stringRejected = materializeCtoSpecificationReviewPacket(stringRoot, oversizedStringPacket);
    assert.equal(stringRejected.ok, false, "an over-limit packet string must be rejected");
    if (!stringRejected.ok) {
      assert.equal(stringRejected.code, "CTO_REVIEW_PACKET_INVALID");
      assert.match(stringRejected.error, /string bound/u);
    }
    assert.equal(existsSync(join(stringRoot, ".work-state")), false, "over-limit packet string writes no projection");

    const nearPacket = packetFor(2_500);
    const nearPath = join(nearRoot, ".work-state", "cto", nearPacket.cto_run_id, "specification-review-packet.md");
    const first = materializeCtoSpecificationReviewPacket(nearRoot, nearPacket);
    assert.equal(first.ok, true, first.ok ? "near-bound review packet projected" : first.error);
    const firstBytes = readFileSync(nearPath);
    assert.ok(firstBytes.byteLength < MAX_CTO_REVIEW_PACKET_BYTES, "near-bound packet remains below the shared byte cap");
    const replay = materializeCtoSpecificationReviewPacket(nearRoot, nearPacket);
    assert.equal(replay.ok, true, replay.ok ? "near-bound review packet replayed" : replay.error);
    assert.deepEqual(readFileSync(nearPath), firstBytes, "near-bound replay preserves exact packet bytes");

    const oversizedPacket = packetFor(2_600);
    const beforeEntries = readdirSync(oversizedRoot).sort();
    let beforeWriteCalls = 0;
    const rejected = materializeCtoSpecificationReviewPacket(oversizedRoot, oversizedPacket, {
      beforeWrite: () => {
        beforeWriteCalls += 1;
      },
    });
    assert.equal(rejected.ok, false, "rendered review packet over the shared cap must be rejected");
    if (!rejected.ok) {
      assert.equal(rejected.code, "CTO_REVIEW_PACKET_INVALID");
      assert.match(rejected.error, /UTF-8 limit/u);
    }
    assert.equal(beforeWriteCalls, 0, "oversized packet is rejected before the anchored write hook");
    assert.deepEqual(readdirSync(oversizedRoot).sort(), beforeEntries, "oversized packet rejection creates no directories or files");
    assert.equal(existsSync(join(oversizedRoot, ".work-state")), false, "oversized packet rejection performs no projection write");
  } finally {
    rmSync(nearRoot, { recursive: true, force: true });
    rmSync(stringRoot, { recursive: true, force: true });
    rmSync(oversizedRoot, { recursive: true, force: true });
  }
});

test("compatibility report validation bounds output and rejects malicious arrays atomically", () => {
  const nearRoot = mkdtempSync(join(tmpdir(), "spec-readable-compat-near-bound-"));
  const overRoot = mkdtempSync(join(tmpdir(), "spec-readable-compat-over-bound-"));
  const arrayRoot = mkdtempSync(join(tmpdir(), "spec-readable-compat-array-bound-"));
  const reportFor = (findings: CompatibilityReport["blocking_findings"]): CompatibilityReport => ({
    report_id: "compatibility.boundary.v1",
    snapshot_ref: "import.snapshot.boundary.v1",
    constitution_binding: validConstitutionBinding(),
    document_language: "en",
    document_language_source: "unknown",
    status: "blocked",
    framework: "generic",
    mapping_id: "generic-requirements-plan-tasks",
    mapping_version: "1",
    selected_paths: ["external/spec.md"],
    mapping: [{ source_ref: "external/spec.md", contract_subject: "requirement", subject_id: "FR-1" }],
    blocking_findings: findings,
    warnings: [],
    ignored_content: [],
    supplement_ref: null,
    evaluated_at: FIXED_NOW,
  });
  try {
    const nearReport = reportFor(Array.from({ length: 120 }, (_, index) => ({
      code: `near-${index}`,
      subject_id: `subject-${index}`,
      message: "m".repeat(60 * 1024),
      evidence_refs: [],
    })));
    const nearPath = join(nearRoot, "specs", FIXED_FEATURE_ID, "compatibility.md");
    const near = materializeCompatibilityReport(nearRoot, FIXED_FEATURE_ID, nearReport);
    assert.equal(near.ok, true, near.ok ? "near-bound compatibility report projected" : near.error);
    assert.ok(readFileSync(nearPath).byteLength < MAX_PINNED_ROOT_READ_BYTES, "near-bound compatibility report stays below the anchored reader cap");

    const escapedMessage = "`".repeat(60 * 1024);
    const overReport = reportFor(Array.from({ length: 70 }, (_, index) => ({
      code: `over-${index}`,
      subject_id: `subject-${index}`,
      message: escapedMessage,
      evidence_refs: [],
    })));
    const overEntries = readdirSync(overRoot).sort();
    let overWriteCalls = 0;
    const over = materializeCompatibilityReport(overRoot, FIXED_FEATURE_ID, overReport, {
      beforeWrite: () => {
        overWriteCalls += 1;
      },
    });
    assert.equal(over.ok, false, "rendered compatibility output over the reader cap must be rejected");
    if (!over.ok) {
      assert.equal(over.code, "SPEC_REQUEST_INVALID");
      assert.match(over.error, /UTF-8 limit/u);
    }
    assert.equal(overWriteCalls, 0, "oversized compatibility output is rejected before the anchored write hook");
    assert.deepEqual(readdirSync(overRoot).sort(), overEntries, "oversized compatibility output creates no directories or files");

    const malicious = reportFor([]);
    malicious.mapping = Array.from({ length: 4_097 }, () => ({ source_ref: "external/spec.md", contract_subject: "requirement", subject_id: null }));
    const arrayEntries = readdirSync(arrayRoot).sort();
    const arrayRejected = materializeCompatibilityReport(arrayRoot, FIXED_FEATURE_ID, malicious);
    assert.equal(arrayRejected.ok, false, "oversized compatibility arrays must be rejected");
    assert.deepEqual(readdirSync(arrayRoot).sort(), arrayEntries, "malicious compatibility arrays create no directories or files");
  } finally {
    rmSync(nearRoot, { recursive: true, force: true });
    rmSync(overRoot, { recursive: true, force: true });
    rmSync(arrayRoot, { recursive: true, force: true });
  }
});

test("migration receipt validation bounds canonical fields and rejects malicious diagnostics atomically", () => {
  const nearRoot = mkdtempSync(join(tmpdir(), "spec-readable-migration-near-bound-"));
  const overRoot = mkdtempSync(join(tmpdir(), "spec-readable-migration-over-bound-"));
  const arrayRoot = mkdtempSync(join(tmpdir(), "spec-readable-migration-array-bound-"));
  const receiptFor = (diagnostics: Array<{ code: string; path: string; message: string }>) => ({
    receipt_id: "migration-boundary-v1",
    source_sha256: null,
    outcome: "blocked" as const,
    constitution_binding: null,
    diagnostics,
  });
  try {
    const nearReceipt = receiptFor(Array.from({ length: 15 }, (_, index) => ({
      code: `near-${index}`,
      path: `external/${index}.md`,
      message: "m".repeat(4 * 1024 - 64),
    })));
    const nearPath = join(nearRoot, "specs", FIXED_FEATURE_ID, "migration.md");
    const near = materializeMigrationReceipt(nearRoot, FIXED_FEATURE_ID, nearReceipt);
    assert.equal(near.ok, true, near.ok ? "near-bound migration receipt projected" : near.error);
    assert.ok(readFileSync(nearPath).byteLength < MAX_PINNED_ROOT_READ_BYTES, "near-bound migration receipt stays below the anchored reader cap");

    const overReceipt = receiptFor(Array.from({ length: 16 }, (_, index) => ({
      code: `over-${index}`,
      path: `external/${index}.md`,
      message: "m".repeat(64 * 1024),
    })));
    const overEntries = readdirSync(overRoot).sort();
    let overWriteCalls = 0;
    const over = materializeMigrationReceipt(overRoot, FIXED_FEATURE_ID, overReceipt, {
      beforeWrite: () => {
        overWriteCalls += 1;
      },
    });
    assert.equal(over.ok, false, "migration receipt aggregate overrun must be rejected");
    if (!over.ok) {
      assert.equal(over.code, "SPEC_REQUEST_INVALID");
      assert.match(over.error, /aggregate bound/u);
    }
    assert.equal(overWriteCalls, 0, "oversized migration receipt is rejected before the anchored write hook");
    assert.deepEqual(readdirSync(overRoot).sort(), overEntries, "oversized migration receipt creates no directories or files");

    const arrayEntries = readdirSync(arrayRoot).sort();
    const arrayRejected = materializeMigrationReceipt(arrayRoot, FIXED_FEATURE_ID, receiptFor(Array.from({ length: 17 }, () => ({
      code: "code",
      path: "path",
      message: "message",
    }))));
    assert.equal(arrayRejected.ok, false, "oversized migration diagnostic arrays must be rejected");
    assert.deepEqual(readdirSync(arrayRoot).sort(), arrayEntries, "malicious migration arrays create no directories or files");
  } finally {
    rmSync(nearRoot, { recursive: true, force: true });
    rmSync(overRoot, { recursive: true, force: true });
    rmSync(arrayRoot, { recursive: true, force: true });
  }
});

test("migration receipt projection accepts the canonical semantic ownership array bound", () => {
  const root = mkdtempSync(join(tmpdir(), "spec-readable-migration-semantic-bound-"));
  try {
    const receipt = {
      receipt_id: "migration-semantic-bound-v1",
      source_sha256: null,
      outcome: "blocked" as const,
      constitution_binding: null,
      diagnostics: [],
      semantic_bindings: Array.from({ length: 17 }, (_, index) => `ownership:${index}`),
    };
    const projected = materializeMigrationReceipt(root, FIXED_FEATURE_ID, receipt);
    assert.equal(projected.ok, true, projected.ok ? "semantic ownership projection accepted" : projected.error);
    assert.match(
      readFileSync(join(root, "specs", FIXED_FEATURE_ID, "migration.md"), "utf8"),
      /ownership:16/u,
      "semantic ownership beyond the diagnostic array bound is rendered",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("handoff and conformance rendering reject escaped output over the anchored reader cap before writing", () => {
  const nearHandoffRoot = mkdtempSync(join(tmpdir(), "spec-readable-handoff-near-bound-"));
  const overHandoffRoot = mkdtempSync(join(tmpdir(), "spec-readable-handoff-over-bound-"));
  const nearConformanceRoot = mkdtempSync(join(tmpdir(), "spec-readable-conformance-near-bound-"));
  const overConformanceRoot = mkdtempSync(join(tmpdir(), "spec-readable-conformance-over-bound-"));
  const handoffAmpersands = "&".repeat(8 * 1024 - 8);
  const conformanceAmpersands = "&".repeat(16 * 1024 - 8);
  try {
    const nearHandoff = validImplementationHandoff();
    nearHandoff.scope.in_scope = Array.from({ length: 180 }, (_, index) => `${index}-${handoffAmpersands}`);
    const nearHandoffPath = join(nearHandoffRoot, "specs", FIXED_FEATURE_ID, "handoff.md");
    const nearHandoffResult = materializeImplementationHandoff(nearHandoffRoot, nearHandoff, guardedHandoffOptions(nearHandoffRoot, nearHandoff));
    assert.equal(nearHandoffResult.ok, true, nearHandoffResult.ok ? "near-bound handoff projected" : nearHandoffResult.error);
    assert.ok(readFileSync(nearHandoffPath).byteLength < MAX_PINNED_ROOT_READ_BYTES, "near-bound handoff stays below the anchored reader cap");

    const overHandoff = validImplementationHandoff();
    overHandoff.scope.in_scope = Array.from({ length: 210 }, (_, index) => `${index}-${handoffAmpersands}`);
    const overHandoffGuard = guardedHandoffOptions(overHandoffRoot, overHandoff);
    const overHandoffEntries = readdirSync(overHandoffRoot).sort();
    let overHandoffWrites = 0;
    const overHandoffResult = materializeImplementationHandoff(overHandoffRoot, overHandoff, {
      ...overHandoffGuard,
      beforeWrite: (path) => {
        overHandoffGuard.beforeWrite(path);
        overHandoffWrites += 1;
      },
    });
    assert.equal(overHandoffResult.ok, false, "escaped handoff output over the reader cap must be rejected");
    if (!overHandoffResult.ok) {
      assert.equal(overHandoffResult.code, "SPEC_REQUEST_INVALID");
      assert.match(overHandoffResult.error, /UTF-8 limit/u);
    }
    assert.equal(overHandoffWrites, 0, "oversized handoff is rejected before the anchored write hook");
    assert.deepEqual(readdirSync(overHandoffRoot).sort(), overHandoffEntries, "oversized handoff creates no directories or files");

    const nearConformance = validImplementationConformance();
    nearConformance.entries[0]!.findings = Array.from({ length: 90 }, (_, index) => ({
      code: `near-${index}`,
      subject_id: null,
      message: conformanceAmpersands,
      evidence_refs: [],
    }));
    const nearDigest = implementationConformanceMatrixDigest(nearConformance);
    if (nearDigest === null) throw new Error("near conformance digest unavailable");
    nearConformance.matrix_digest = nearDigest;
    nearConformance.conformance_id = `implementation-conformance.${nearDigest}`;
    const nearConformancePath = join(nearConformanceRoot, "specs", FIXED_FEATURE_ID, "validation", "implementation-conformance.md");
    const nearConformanceResult = materializeImplementationConformance(nearConformanceRoot, nearConformance);
    assert.equal(nearConformanceResult.ok, true, nearConformanceResult.ok ? "near-bound conformance projected" : nearConformanceResult.error);
    assert.ok(readFileSync(nearConformancePath).byteLength < MAX_PINNED_ROOT_READ_BYTES, "near-bound conformance stays below the anchored reader cap");

    const overConformance = validImplementationConformance();
    overConformance.entries[0]!.findings = Array.from({ length: 110 }, (_, index) => ({
      code: `over-${index}`,
      subject_id: null,
      message: conformanceAmpersands,
      evidence_refs: [],
    }));
    const overDigest = implementationConformanceMatrixDigest(overConformance);
    if (overDigest === null) throw new Error("over conformance digest unavailable");
    overConformance.matrix_digest = overDigest;
    overConformance.conformance_id = `implementation-conformance.${overDigest}`;
    const overConformanceEntries = readdirSync(overConformanceRoot).sort();
    let overConformanceWrites = 0;
    const overConformanceResult = materializeImplementationConformance(overConformanceRoot, overConformance, {
      beforeWrite: () => {
        overConformanceWrites += 1;
      },
    });
    assert.equal(overConformanceResult.ok, false, "escaped conformance output over the reader cap must be rejected");
    if (!overConformanceResult.ok) {
      assert.equal(overConformanceResult.code, "SPEC_REQUEST_INVALID");
      assert.match(overConformanceResult.error, /UTF-8 limit/u);
    }
    assert.equal(overConformanceWrites, 0, "oversized conformance is rejected before the anchored write hook");
    assert.deepEqual(readdirSync(overConformanceRoot).sort(), overConformanceEntries, "oversized conformance creates no directories or files");
  } finally {
    rmSync(nearHandoffRoot, { recursive: true, force: true });
    rmSync(overHandoffRoot, { recursive: true, force: true });
    rmSync(nearConformanceRoot, { recursive: true, force: true });
    rmSync(overConformanceRoot, { recursive: true, force: true });
  }
});
