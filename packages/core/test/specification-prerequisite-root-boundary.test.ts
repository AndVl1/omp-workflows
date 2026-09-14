import { strict as assert } from "node:assert";
import { join } from "node:path";
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { test } from "node:test";
import { ensureProjectConstitution } from "../src/specification/prerequisite.js";
import { PinnedProjectRoot } from "../src/specification/pinned-root.js";

const VALID_CONSTITUTION = [
  "# Project Constitution",
  "",
  "Version: 1.0.0",
  "",
  "## I. Quality",
  "",
  "Every change ships with behavioral tests.",
  "",
].join("\n");

const origin = {
  origin_kind: "native_direct" as const,
  origin_run_key: "root-boundary-test",
  origin_stage: "specify",
};

function makeProject(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  writeFileSync(join(root, "CONSTITUTION.md"), VALID_CONSTITUTION, "utf8");
  return root;
}

function gatePath(root: string): string {
  return join(root, ".work-state", "specification", "constitution", "gate.json");
}

test("copied constitution envelopes fail closed without adopting or overwriting either root", () => {
  const rootA = makeProject("spec-root-a-");
  const rootB = makeProject("spec-root-b-");
  let pinnedB: PinnedProjectRoot | undefined;
  try {
    const established = ensureProjectConstitution(rootA, origin);
    assert.equal(established.ok, true, established.ok ? "root A gate established" : established.error);
    if (!established.ok) return;
    const rootAGateBefore = readFileSync(gatePath(rootA), "utf8");
    mkdirSync(join(rootB, ".work-state", "specification", "constitution"), { recursive: true });
    writeFileSync(gatePath(rootB), rootAGateBefore, "utf8");
    const rootBGateBefore = readFileSync(gatePath(rootB), "utf8");

    pinnedB = PinnedProjectRoot.open(rootB) ?? undefined;
    assert.ok(pinnedB);
    if (!pinnedB) return;
    const rejected = ensureProjectConstitution(rootB, origin, { pinnedRoot: pinnedB });
    assert.equal(rejected.ok, false);
    if (!rejected.ok) assert.equal(rejected.code, "SPEC_STATE_INVALID");
    assert.equal(readFileSync(gatePath(rootA), "utf8"), rootAGateBefore);
    assert.equal(readFileSync(gatePath(rootB), "utf8"), rootBGateBefore);
  } finally {
    pinnedB?.close();
    rmSync(rootA, { recursive: true, force: true });
    rmSync(rootB, { recursive: true, force: true });
  }
});

test("a lexical alias of the same physical root remains accepted", () => {
  const root = makeProject("spec-root-alias-");
  const alias = `${root}/.`;
  let pinned: PinnedProjectRoot | undefined;
  try {
    const established = ensureProjectConstitution(root, origin);
    assert.equal(established.ok, true, established.ok ? "root gate established" : established.error);
    if (!established.ok) return;
    const before = readFileSync(gatePath(root), "utf8");
    pinned = PinnedProjectRoot.open(alias) ?? undefined;
    assert.ok(pinned);
    if (!pinned) return;
    assert.equal(pinned.canonical_root, realpathSync(root));
    const replay = ensureProjectConstitution(alias, origin, { pinnedRoot: pinned });
    assert.equal(replay.ok, true, replay.ok ? "physical-root alias replayed" : replay.error);
    assert.equal(readFileSync(gatePath(root), "utf8"), before);
  } finally {
    pinned?.close();
    rmSync(root, { recursive: true, force: true });
  }
});
