import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { admitImplementationWorkflowBegin } from "../src/engine/run.js";
import { parseBoundedPersistedState } from "../src/engine/state.js";
import { PinnedProjectRoot } from "../src/specification/pinned-root.js";
import { validFeatureWorkspace } from "./fixtures/specification-fixtures.js";

const FEATURE_ID = "bounded-admission";
const RUN_KEY = "run-bounded-admission-1";
const STATE_RELATIVE = `.work-state/features/${FEATURE_ID}/state.json`;

function makeProject(): string {
  const root = mkdtempSync(join(tmpdir(), "run-admission-bounds-"));
  const pinned = PinnedProjectRoot.open(root);
  if (!pinned) throw new Error("fixture root cannot be pinned");
  try {
    const workspace = validFeatureWorkspace({
      featureId: FEATURE_ID,
      projectRoot: pinned.canonical_root,
      projectRootIdentity: { canonical_path: pinned.canonical_root, dev: pinned.dev, ino: pinned.ino },
      status: "created",
    });
    mkdirSync(join(root, ".work-state", "features", FEATURE_ID), { recursive: true });
    mkdirSync(join(root, "specs", FEATURE_ID), { recursive: true });
    writeFileSync(join(root, STATE_RELATIVE), JSON.stringify({
      schema: 1,
      run_key: RUN_KEY,
      state_revision: 1,
      specification: workspace,
    }) + "\n");
  } finally {
    pinned.close();
  }
  return root;
}

function statePath(root: string): string {
  return join(root, STATE_RELATIVE);
}

function writeBytes(root: string, bytes: Uint8Array): void {
  mkdirSync(join(root, ".work-state", "features", FEATURE_ID), { recursive: true });
  writeFileSync(statePath(root), bytes);
}

async function rejectsState(root: string): Promise<void> {
  const result = await admitImplementationWorkflowBegin(root, { feature_id: FEATURE_ID, run_key: RUN_KEY });
  assert.equal(result.ok, false, JSON.stringify(result));
  if (!result.ok) assert.equal(result.code, "SPEC_STATE_INVALID");
}

test("admitImplementationWorkflowBegin accepts a valid non-ready specification state without claiming", async () => {
  const root = makeProject();
  try {
    const result = await admitImplementationWorkflowBegin(root, { feature_id: FEATURE_ID, run_key: RUN_KEY });
    assert.deepEqual(result, { ok: true, required: false });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("admitImplementationWorkflowBegin rejects state bytes over its 1MiB read cap", async () => {
  const root = makeProject();
  try {
    writeBytes(root, Buffer.alloc(1024 * 1024 + 1, 0x20));
    await rejectsState(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("admitImplementationWorkflowBegin rejects invalid UTF-8 before JSON parsing", async () => {
  const root = makeProject();
  try {
    writeBytes(root, Buffer.from([0x7b, 0x22, 0x78, 0x22, 0x3a, 0xc3, 0x28, 0x7d]));
    await rejectsState(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("admitImplementationWorkflowBegin rejects deep, wide, and unsafe-prototype state objects", async () => {
  const root = makeProject();
  try {
    let deep: unknown = {};
    for (let index = 0; index < 130; index += 1) deep = { nested: deep };
    writeBytes(root, Buffer.from(JSON.stringify(deep)));
    await rejectsState(root);

    const wide: Record<string, unknown> = {};
    for (let index = 0; index < 1_025; index += 1) wide[`field-${index}`] = index;
    writeBytes(root, Buffer.from(JSON.stringify(wide)));
    await rejectsState(root);

    const unsafe = Object.create({ injected: true }) as Record<string, unknown>;
    unsafe.schema = 1;
    assert.equal(parseBoundedPersistedState(unsafe), null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("admitImplementationWorkflowBegin rejects root, ancestor, and state-leaf swaps after the pinned read", async () => {
  for (const variant of ["root", "ancestor", "leaf"] as const) {
    const root = makeProject();
    const replacement = mkdtempSync(join(tmpdir(), "run-admission-replacement-"));
    const originalReadFile = PinnedProjectRoot.prototype.readFile;
    let swapped = false;
    let movedPath = "";
    try {
      PinnedProjectRoot.prototype.readFile = function(relativeFile, options) {
        const result = originalReadFile.call(this, relativeFile, options);
        if (swapped || relativeFile !== STATE_RELATIVE) return result;
        swapped = true;
        if (variant === "root") {
          movedPath = `${root}.moved`;
          renameSync(root, movedPath);
          symlinkSync(replacement, root, "dir");
        } else if (variant === "ancestor") {
          const ancestor = join(root, ".work-state", "features");
          movedPath = `${ancestor}.moved`;
          const replacementAncestor = join(replacement, ".work-state", "features");
          mkdirSync(replacementAncestor, { recursive: true });
          renameSync(ancestor, movedPath);
          symlinkSync(replacementAncestor, ancestor, "dir");
        } else {
          movedPath = `${statePath(root)}.moved`;
          const replacementState = join(replacement, STATE_RELATIVE);
          mkdirSync(join(replacement, ".work-state", "features", FEATURE_ID), { recursive: true });
          writeFileSync(replacementState, readFileSync(statePath(root)));
          renameSync(statePath(root), movedPath);
          symlinkSync(replacementState, statePath(root), "file");
        }
        return result;
      } as PinnedProjectRoot["readFile"];

      await rejectsState(root);
      assert.equal(swapped, true, `${variant} swap seam must execute`);
    } finally {
      PinnedProjectRoot.prototype.readFile = originalReadFile;
      if (swapped) {
        if (variant === "root") {
          unlinkSync(root);
          renameSync(movedPath, root);
        } else if (variant === "ancestor") {
          const ancestor = join(root, ".work-state", "features");
          unlinkSync(ancestor);
          renameSync(movedPath, ancestor);
        } else {
          unlinkSync(statePath(root));
          renameSync(movedPath, statePath(root));
        }
      }
      rmSync(root, { recursive: true, force: true });
      rmSync(replacement, { recursive: true, force: true });
      rmSync(movedPath, { recursive: true, force: true });
    }
  }
});
