import assert from "node:assert/strict";
import fs from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import {
  materializeCtoSpecificationReviewPacket,
  materializeCtoSpecificationReviewPacketPinned,
  materializeCompatibilityReport,
  materializeImplementationConformance,
  materializeImplementationHandoff,
  materializeMigrationReceipt,
} from "../src/specification/materialize.js";
import { PinnedProjectRoot } from "../src/specification/pinned-root.js";
import { readPinnedCurrentConstitution } from "../src/specification/constitution-identities.js";
import { canonicalHandoffDigest } from "../src/specification/handoff.js";
import { ensureProjectConstitution } from "../src/specification/prerequisite.js";
import { CTO_REVIEW_AUTHORITY_STATEMENT } from "../src/cto/specification-review-packet.js";
import {
  FIXED_FEATURE_ID,
  FIXED_NOW,
  validConstitutionBinding,
  validImplementationConformance,
  validImplementationHandoff,
} from "./fixtures/specification-fixtures.js";
import type { CompatibilityReport, ImplementationHandoff } from "../src/specification/types.js";
import type { CtoSpecificationReviewPacket } from "../src/cto/specification-review-packet.js";

type ProjectionResult = { ok: boolean; code?: string; error?: string };
type ProjectionCall = (root: string, options: { beforeWrite?: () => void; afterWrite?: () => void }) => ProjectionResult;

function swappedRoot(root: string, outside: string): string {
  const moved = `${root}.opened`;
  fs.renameSync(root, moved);
  fs.symlinkSync(outside, root, "dir");
  return moved;
}

function restoreRoot(root: string, moved: string): void {
  try { fs.unlinkSync(root); } catch { }
  try { fs.renameSync(moved, root); } catch { }
}

function compatibilityReport(): CompatibilityReport {
  return {
    report_id: "compatibility.projection-race.v1",
    snapshot_ref: "snapshot.projection-race.v1",
    document_language: "en",
    document_language_source: "explicit",
    framework: "generic",
    mapping_id: "mapping.projection-race",
    mapping_version: "1",
    selected_paths: [],
    constitution_binding: validConstitutionBinding(),
    status: "ready",
    mapping: [],
    blocking_findings: [],
    warnings: [],
    ignored_content: [],
    supplement_ref: null,
    evaluated_at: FIXED_NOW,
  };
}

function guardedHandoffCall(root: string, options: { beforeWrite?: () => void; afterWrite?: () => void }): ProjectionResult {
  const handoff = validImplementationHandoff() as ImplementationHandoff;
  if (fs.lstatSync(root).isSymbolicLink()) {
    return materializeImplementationHandoff(root, handoff, { beforeWrite: () => { throw new Error("symlinked root must be rejected before handoff guard"); } });
  }
  fs.writeFileSync(join(root, "CONSTITUTION.md"), "# Project Constitution v1.0.0\n\n## I. Quality\n\nShip tested work.\n", "utf8");
  const ensured = ensureProjectConstitution(root, { origin_kind: "native_direct", origin_run_key: "projection-race", origin_stage: "specify" });
  assert.ok(ensured.ok, ensured.ok ? "constitution gate ensured" : ensured.error);
  if (ensured.ok && ensured.value.binding) {
    handoff.constitution_binding = ensured.value.binding;
    handoff.handoff_digest = canonicalHandoffDigest(handoff);
  }
  return materializeImplementationHandoff(root, handoff, {
    beforeWrite: (path) => {
      const pinned = PinnedProjectRoot.open(root);
      if (!pinned) throw new Error("project root cannot be pinned for handoff projection");
      try {
        const current = readPinnedCurrentConstitution(root, pinned, handoff.constitution_binding);
        if (!current.ok) throw new Error(current.error);
      } finally {
        pinned.close();
      }
      options.beforeWrite?.();
    },
    afterWrite: options.afterWrite ? () => options.afterWrite!() : undefined,
  });
}

function reviewPacket(): CtoSpecificationReviewPacket {
  return {
    schema_version: 1,
    packet_ref: "cto.specification-review-packet.projection-race",
    cto_run_id: "projection-race",
    grants_approval: false,
    authority_statement: CTO_REVIEW_AUTHORITY_STATEMENT,
    features: [{
      feature_id: FIXED_FEATURE_ID,
      run_key: "projection-race-run",
      display_name: "Projection race",
      workspace_status: "in_progress",
      workspace_next_action: "Validate projection",
      handoff_ref: null,
      phases: [{
        phase: "specify",
        status: "awaiting_approval",
        version: 1,
        approved_version: null,
        validation_ref: "validation.specify.v1",
        checkpoint_ref: "checkpoint.specify.v1",
        decision: null,
        decision_checkpoint_ref: null,
        trusted_answer_ref: null,
        next_action: "approve",
      }],
    }],
    recorded_decisions: [],
    decision_count: 0,
  };
}

const projections: Array<{ name: string; call: ProjectionCall }> = [
  {
    name: "handoff",
    call: guardedHandoffCall,
  },
  {
    name: "compatibility",
    call: (root, options) => materializeCompatibilityReport(root, FIXED_FEATURE_ID, compatibilityReport(), options),
  },
  {
    name: "conformance",
    call: (root, options) => materializeImplementationConformance(root, validImplementationConformance(), options),
  },
  {
    name: "migration",
    call: (root, options) => materializeMigrationReceipt(root, FIXED_FEATURE_ID, {
      receipt_id: "migration.projection-race.v1",
      source_sha256: null,
      outcome: "migrated",
      constitution_binding: null,
      diagnostics: [],
    }, options),
  },
  {
    name: "review packet",
    call: (root, options) => materializeCtoSpecificationReviewPacket(root, reviewPacket(), options),
  },
];

test("every readable projection rejects an initially symlinked project root", () => {
  for (const projection of projections) {
    const realRoot = fs.mkdtempSync(join(tmpdir(), `spec-${projection.name.replace(/ /g, "-")}-symlink-target-`));
    const symlinkRoot = `${realRoot}.link`;
    fs.symlinkSync(realRoot, symlinkRoot, "dir");
    try {
      const result = projection.call(symlinkRoot, {});
      assert.equal(result.ok, false, `${projection.name} must reject a symlinked root`);
      if (!result.ok) assert.equal(result.code, "SPEC_PATH_UNAUTHORIZED", projection.name);
      assert.deepEqual(fs.readdirSync(realRoot), [], `${projection.name} must not write through a root symlink`);
    } finally {
      fs.unlinkSync(symlinkRoot);
      fs.rmSync(realRoot, { recursive: true, force: true });
    }
  }
});

test("every readable projection rejects root replacement before or after its anchored write", () => {
  for (const projection of projections) {
    for (const seam of ["beforeWrite", "afterWrite"] as const) {
      const root = fs.mkdtempSync(join(tmpdir(), `spec-${projection.name.replace(/ /g, "-")}-race-`));
      const outside = fs.mkdtempSync(join(tmpdir(), `spec-${projection.name.replace(/ /g, "-")}-outside-`));
      let moved: string | null = null;
      try {
        const result = projection.call(root, {
          [seam]: () => {
            if (moved === null) moved = swappedRoot(root, outside);
          },
        });
        assert.equal(result.ok, false, `${projection.name} ${seam} root replacement must fail closed`);
        if (!result.ok) assert.equal(result.code, "SPEC_PATH_UNAUTHORIZED", `${projection.name} ${seam}`);
        assert.deepEqual(fs.readdirSync(outside), [], `${projection.name} ${seam} must not write replacement root`);
      } finally {
        if (moved !== null) restoreRoot(root, moved);
        fs.rmSync(root, { recursive: true, force: true });
        if (moved !== null) fs.rmSync(moved, { recursive: true, force: true });
        fs.rmSync(outside, { recursive: true, force: true });
      }
    }
  }
});

test("pinned review packet projection rejects root, ancestor, and leaf symlink swaps before or during readback", () => {
  for (const swapKind of ["root", "ancestor", "leaf"] as const) {
    for (const seam of ["beforeWrite", "afterWrite"] as const) {
      const root = fs.mkdtempSync(join(tmpdir(), `spec-review-${swapKind}-${seam}-`));
      const outside = fs.mkdtempSync(join(tmpdir(), `spec-review-${swapKind}-${seam}-outside-`));
      const packet = reviewPacket();
      const packetDirectory = join(root, ".work-state", "cto", packet.cto_run_id);
      const packetPath = join(packetDirectory, "specification-review-packet.md");
      const outsideLeaf = join(outside, "replacement-packet.md");
      let pinned: PinnedProjectRoot | null = null;
      let moved: string | null = null;
      let swappedPath: string | null = null;
      try {
        if (swapKind !== "root") fs.mkdirSync(packetDirectory, { recursive: true });
        if (swapKind === "leaf") {
          fs.writeFileSync(outsideLeaf, "outside sentinel\n", "utf8");
          if (seam === "beforeWrite") fs.writeFileSync(packetPath, "existing packet\n", "utf8");
        }
        const replacementAncestor = join(outside, "replacement-run");
        if (swapKind === "ancestor") fs.mkdirSync(replacementAncestor);

        pinned = PinnedProjectRoot.open(root);
        assert.ok(pinned, `${swapKind} ${seam} fixture root must be pinnable`);
        if (!pinned) continue;
        const swap = () => {
          if (moved !== null) return;
          if (swapKind === "root") {
            swappedPath = root;
            moved = `${root}.opened`;
            fs.renameSync(root, moved);
            fs.symlinkSync(outside, root, "dir");
          } else if (swapKind === "ancestor") {
            swappedPath = packetDirectory;
            moved = `${packetDirectory}.opened`;
            fs.renameSync(packetDirectory, moved);
            fs.symlinkSync(replacementAncestor, packetDirectory, "dir");
          } else {
            swappedPath = packetPath;
            moved = `${packetPath}.opened`;
            fs.renameSync(packetPath, moved);
            fs.symlinkSync(outsideLeaf, packetPath);
          }
        };
        const result = materializeCtoSpecificationReviewPacketPinned(pinned, packet, { [seam]: swap });
        assert.equal(result.ok, false, `${swapKind} ${seam} symlink swap must fail closed`);
        if (!result.ok) assert.equal(result.code, "SPEC_PATH_UNAUTHORIZED", `${swapKind} ${seam}`);

        if (swapKind === "leaf") {
          assert.equal(fs.readFileSync(outsideLeaf, "utf8"), "outside sentinel\n", `${swapKind} ${seam} must not modify the replacement leaf`);
        } else {
          const replacement = swapKind === "root" ? outside : replacementAncestor;
          assert.deepEqual(fs.readdirSync(replacement), [], `${swapKind} ${seam} must not write through the replacement directory`);
        }
      } finally {
        pinned?.close();
        if (swappedPath !== null) {
          try { fs.unlinkSync(swappedPath); } catch { }
          if (moved !== null) {
            try { fs.renameSync(moved, swappedPath); } catch { }
          }
        }
        fs.rmSync(root, { recursive: true, force: true });
        fs.rmSync(outside, { recursive: true, force: true });
      }
    }
  }
});
