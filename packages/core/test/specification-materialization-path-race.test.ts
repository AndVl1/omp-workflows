import assert from "node:assert/strict";
import fs from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { createFeatureWorkspace } from "../src/specification/workspace.js";
import { materializeFeatureDocuments, revalidateMaterializedDocuments } from "../src/specification/materialize.js";
import { PinnedProjectRoot } from "../src/specification/pinned-root.js";
import { updateStateAtomically } from "../src/engine/state.js";

const FEATURE_ID = "materialize-race";
const RUN_KEY = "run-materialize-race";
const validateBeforeWrite = () => {};

type MaterializationHook = "afterDocumentWrite" | "beforeArchiveWrite" | "beforeManifestWrite" | "beforeStateWrite";

function setupRoot(): string {
  const root = fs.mkdtempSync(join(tmpdir(), "spec-materialize-root-race-"));
  const workspace = createFeatureWorkspace(root, {
    feature_id: FEATURE_ID,
    display_name: "Materialization root race",
    run_key: RUN_KEY,
    profile_name: "spec-preparation",
    profile_hash: "a".repeat(64),
  });
  if (!workspace.ok) {
    fs.rmSync(root, { recursive: true, force: true });
    throw new Error(workspace.error);
  }
  return root;
}

function replaceRoot(root: string, replacement: string): string {
  const moved = `${root}.opened`;
  fs.renameSync(root, moved);
  fs.symlinkSync(replacement, root, "dir");
  return moved;
}

function restoreRoot(root: string, moved: string): void {
  try { fs.unlinkSync(root); } catch { }
  try { fs.renameSync(moved, root); } catch { }
}

function materializeV1(root: string): void {
  const result = materializeFeatureDocuments(root, {
    feature_id: FEATURE_ID,
    run_key: RUN_KEY,
    phase: "specify",
    version: 1,
    documents: [{ path: "spec.md", content: "# Version one\n" }],
  }, { validateBeforeWrite });
  assert.equal(result.ok, true, result.ok ? "v1 materialized" : result.error);
}test("validateBeforeWrite is mandatory and runs before every projection write", () => {
  const root = setupRoot();
  try {
    const request = {
      feature_id: FEATURE_ID,
      run_key: RUN_KEY,
      phase: "specify" as const,
      version: 1,
      documents: [{ path: "spec.md", content: "# Version one\n" }, { path: "notes.md", content: "# Notes one\n" }],
    };
    const unguarded = materializeFeatureDocuments(root, request, undefined as never);
    assert.equal(unguarded.ok, false);
    if (!unguarded.ok) assert.equal(unguarded.code, "SPEC_STATE_INVALID");
    assert.equal(fs.existsSync(join(root, "specs", FEATURE_ID, "spec.md")), false, "unguarded materialization must not write documents");

    let validations = 0;
    const first = materializeFeatureDocuments(root, request, { validateBeforeWrite: () => { validations += 1; } });
    assert.equal(first.ok, true, first.ok ? "" : first.error);
    assert.equal(validations, 3, "two current documents and one manifest each require a freshness check");

    const second = materializeFeatureDocuments(root, {
      ...request,
      version: 2,
      documents: [{ path: "spec.md", content: "# Version two\n" }],
    }, { validateBeforeWrite: () => { validations += 1; } });
    assert.equal(second.ok, true, second.ok ? "" : second.error);
    assert.equal(validations, 8, "archive, retirement, current, and manifest writes each require a freshness check");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("materialization rolls back every postimage when onWritten callback throws", () => {
  const root = setupRoot();
  try {
    materializeV1(root);
    const specPath = join(root, "specs", FEATURE_ID, "spec.md");
    const manifestPath = join(root, ".work-state", "features", FEATURE_ID, "artifacts", "documents", "specify", "v2.json");
    const archivePath = join(root, "specs", FEATURE_ID, "history", "specify", "v1.md");
    const original = fs.readFileSync(specPath);
    assert.throws(() => materializeFeatureDocuments(root, {
      feature_id: FEATURE_ID,
      run_key: RUN_KEY,
      phase: "specify",
      version: 2,
      documents: [{ path: "spec.md", content: "# Version two\n" }],
    }, {
      validateBeforeWrite,
      onWritten: (path) => {
        if (path.endsWith("spec.md")) throw new Error("injected postimage capture failure");
      },
    }));
    assert.deepEqual(fs.readFileSync(specPath), original, "a postimage callback failure restores the replaced document");
    assert.equal(fs.existsSync(manifestPath), false, "a postimage callback failure removes the unpublished manifest");
    assert.equal(fs.existsSync(archivePath), false, "a postimage callback failure removes the unpublished archive");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("materialization preserves a concurrent deletion after descriptor publication", () => {
  const root = setupRoot();
  try {
    materializeV1(root);
    const specPath = join(root, "specs", FEATURE_ID, "spec.md");
    const archivePath = join(root, "specs", FEATURE_ID, "history", "specify", "v1.md");
    assert.throws(() => materializeFeatureDocuments(root, { feature_id: FEATURE_ID, run_key: RUN_KEY, phase: "specify", version: 2, documents: [{ path: "spec.md", content: "# Version two\n" }] }, {
      validateBeforeWrite,
      onWritten: (path) => {
        if (!path.endsWith("spec.md")) return;
        fs.unlinkSync(join(root, path));
        throw new Error("injected concurrent deletion after descriptor publication");
      },
    }));
    assert.equal(fs.existsSync(specPath), false, "rollback must preserve a concurrent deletion instead of resurrecting the preimage");
    assert.equal(fs.existsSync(archivePath), false, "rollback must remove the attempt-owned archive");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("materialization root replacement at every transaction seam never writes replacement or outside", () => {
  const seams: MaterializationHook[] = ["afterDocumentWrite", "beforeArchiveWrite", "beforeManifestWrite", "beforeStateWrite"];
  for (const seam of seams) {
    const root = setupRoot();
    const outside = fs.mkdtempSync(join(tmpdir(), "spec-materialize-outside-"));
    const moved = `${root}.opened`;
    let swapped = false;
    try {
      materializeV1(root);
      const swap = () => {
        if (swapped) return;
        swapped = true;
        replaceRoot(root, outside);
      };
      const request = {
        feature_id: FEATURE_ID,
        run_key: RUN_KEY,
        phase: "specify" as const,
        version: 2,
        documents: seam === "afterDocumentWrite"
          ? [{ path: "spec.md", content: "# Version two\n" }, { path: "notes.md", content: "# Notes\n" }]
          : [{ path: "spec.md", content: "# Version two\n" }],
      };
      const result = materializeFeatureDocuments(root, request, {
        validateBeforeWrite,
        afterDocumentWrite: seam === "afterDocumentWrite" ? (index) => { if (index === 0) swap(); } : undefined,
        beforeArchiveWrite: seam === "beforeArchiveWrite" ? swap : undefined,
        beforeManifestWrite: seam === "beforeManifestWrite" ? swap : undefined,
        beforeStateWrite: seam === "beforeStateWrite" ? swap : undefined,
      });
      assert.equal(result.ok, false, `${seam} root replacement must fail closed`);
      if (!result.ok) assert.equal(result.code, "SPEC_PATH_UNAUTHORIZED", `${seam} maps root replacement to typed path failure`);
      assert.deepEqual(fs.readdirSync(outside), [], `${seam} never writes through replacement root`);
      assert.equal(fs.existsSync(join(root, "specs", FEATURE_ID)), false, `${seam} replacement symlink is not used for writes`);
    } finally {
      if (swapped) restoreRoot(root, moved);
      fs.rmSync(root, { recursive: true, force: true });
      fs.rmSync(moved, { recursive: true, force: true });
      fs.rmSync(outside, { recursive: true, force: true });
    }
  }
});

test("materialization rejects a regular root replacement without writing replacement inode", () => {
  const root = setupRoot();
  const replacement = fs.mkdtempSync(join(tmpdir(), "spec-materialize-replacement-"));
  const moved = `${root}.opened`;
  let swapped = false;
  try {
    materializeV1(root);
    const result = materializeFeatureDocuments(root, {
      feature_id: FEATURE_ID,
      run_key: RUN_KEY,
      phase: "specify",
      version: 2,
      documents: [{ path: "spec.md", content: "# Version two\n" }],
    }, {
      validateBeforeWrite,
      beforeManifestWrite: () => {
        if (swapped) return;
        swapped = true;
        fs.renameSync(root, moved);
        fs.renameSync(replacement, root);
      },
    });
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.code, "SPEC_PATH_UNAUTHORIZED");
    assert.deepEqual(fs.readdirSync(root), [], "regular replacement root receives no materialization writes");
  } finally {
    if (swapped) {
      fs.rmSync(root, { recursive: true, force: true });
      fs.renameSync(moved, root);
    }
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(moved, { recursive: true, force: true });
    fs.rmSync(replacement, { recursive: true, force: true });
  }
});


test("materialization preserves the explicit run mismatch failure", () => {
  const root = setupRoot();
  try {
    materializeV1(root);
    const result = materializeFeatureDocuments(root, {
      feature_id: FEATURE_ID,
      run_key: "different-run",
      phase: "specify",
      version: 2,
      documents: [{ path: "spec.md", content: "# Version two\n" }],
    }, { validateBeforeWrite });
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.code, "SPEC_RUN_MISMATCH");
      assert.match(result.error, /run_key 'different-run' does not match the workspace run 'run-materialize-race'/);
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});


test("revalidation rejects a root replacement before its anchored manifest read", () => {
  const root = setupRoot();
  const outside = fs.mkdtempSync(join(tmpdir(), "spec-revalidate-outside-"));
  let moved: string | null = null;
  try {
    materializeV1(root);
    const result = revalidateMaterializedDocuments(root, {
      feature_id: FEATURE_ID,
      phase: "specify",
      version: 1,
    }, {
      beforeRead: () => {
        if (moved === null) moved = replaceRoot(root, outside);
      },
    });
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.code, "SPEC_PATH_UNAUTHORIZED");
    assert.deepEqual(fs.readdirSync(outside), [], "revalidation must not read or write through replacement root");
  } finally {
    if (moved !== null) restoreRoot(root, moved);
    fs.rmSync(root, { recursive: true, force: true });
    if (moved !== null) fs.rmSync(moved, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }
});


test("state transactions reject a pinned root replacement before atomic commit", () => {
  const root = setupRoot();
  const replacement = fs.mkdtempSync(join(tmpdir(), "spec-state-replacement-"));
  const moved = `${root}.opened`;
  const pinned = PinnedProjectRoot.open(root);
  assert.ok(pinned, "the fixture root must be pinnable");
  let swapped = false;
  try {
    const result = updateStateAtomically(
      pinned.anchorPath(),
      (snapshot) => {
        if (!snapshot.state) return { op: "fail", code: "state_missing", error: "state missing" };
        if (!swapped) {
          swapped = true;
          fs.renameSync(root, moved);
          fs.renameSync(replacement, root);
        }
        return { op: "commit", state: snapshot.state, value: null };
      },
      { selector: { feature_id: FEATURE_ID, run_key: RUN_KEY }, rootGuard: pinned },
    );
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.code, "root_unstable");
    assert.deepEqual(fs.readdirSync(root), [], "state root replacement receives no commit writes");
  } finally {
    pinned.close();
    if (swapped) {
      fs.rmSync(root, { recursive: true, force: true });
      fs.renameSync(moved, root);
    }
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(moved, { recursive: true, force: true });
    fs.rmSync(replacement, { recursive: true, force: true });
  }
});

