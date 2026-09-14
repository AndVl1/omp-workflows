import assert from "node:assert/strict";
import fs from "node:fs";
import fsPromises from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { PinnedProjectRoot } from "../src/specification/pinned-root.js";
import { specImportCommand } from "../src/commands/specification.js";
import { setImportCandidateReadTestHooks } from "../src/specification/import.js";

interface ImportApi {
  importExternalSpecification(input: {
    sourcePath: string;
    rootDir: string;
    feature: string;
    run: string;
  }): Promise<unknown>;
  createImportSnapshot(input: {
    sourcePath: string;
    rootDir: string;
    feature: string;
    run: string;
  }): Promise<unknown>;
  setImportCandidateReadTestHooks(hooks: { afterRead?: (context: { absolutePath: string; relativePath: string }) => void } | null): void;
}

interface LegacyReadResult {
  ok: boolean;
  code?: string;
  error?: string;
  bytes?: Uint8Array;
}

interface LegacyApi {
  readLegacySpecificationSource(pinnedRoot: PinnedProjectRoot, sourcePath: string): LegacyReadResult;
}

interface MigrationRaceApi {
  migrateLegacySpecificationWorkspace(input: Record<string, unknown>): {
    status: string;
    receipt: { diagnostics: Array<{ code: string }> };
  };
  setMigrationTestHooks(hooks: { afterReadSnapshot?: (root: unknown) => void } | null): void;
}

async function fixture(body = "# Stable source\n") {
  const root = await fsPromises.mkdtemp(join(tmpdir(), "spec-path-race-"));
  const sourcePath = join(root, "source.md");
  await fsPromises.writeFile(sourcePath, body, "utf8");
  return { root, sourcePath };
}

function replaceFinalPath(sourcePath: string): void {
  fs.renameSync(sourcePath, `${sourcePath}.opened`);
  fs.writeFileSync(sourcePath, "# Replacement pathname\n", "utf8");
}

function replaceAncestorPath(root: string, sourcePath: string): void {
  const ancestor = join(root, "nested");
  const openedAncestor = join(root, "nested.opened");
  fs.renameSync(ancestor, openedAncestor);
  fs.mkdirSync(ancestor);
  const sourceName = sourcePath.slice(sourcePath.lastIndexOf("/") + 1);
  fs.writeFileSync(join(ancestor, sourceName), "# Replacement pathname\n", "utf8");
}

function replaceRootPath(root: string, outside: string): void {
  fs.renameSync(root, `${root}.opened`);
  fs.symlinkSync(outside, root, "dir");
}

async function importWithAnchoredReadSwap(
  root: string,
  sourcePath: string,
  swap: () => void,
  sourceModule: string,
): Promise<unknown> {
  const api = (await import(sourceModule)) as unknown as ImportApi;
  let swapped = false;
  api.setImportCandidateReadTestHooks({
    afterRead: ({ absolutePath }: { absolutePath: string }) => {
      if (swapped || absolutePath !== sourcePath) return;
      swapped = true;
      swap();
    },
  });
  try {
    return await api.importExternalSpecification({ sourcePath, rootDir: root, feature: "checkout", run: "acceptance" });
  } finally {
    api.setImportCandidateReadTestHooks(null);
  }
}

async function legacyWithOpenSwap(
  root: string,
  sourcePath: string,
  swap: () => void,
  sourceModule: string,
): Promise<LegacyReadResult> {
  const pinnedRoot = PinnedProjectRoot.open(root);
  if (!pinnedRoot) throw new Error("test root could not be pinned");
  try {
    // The caller pins the root before the lexical path is changed. The new
    // reader must remain bound to that descriptor and never follow the
    // replacement pathname.
    swap();
    const api = (await import(sourceModule)) as unknown as LegacyApi;
    return api.readLegacySpecificationSource(pinnedRoot, sourcePath);
  } finally {
    pinnedRoot.close();
  }
}

test("external import rejects a final pathname replacement after the anchored read completes", async () => {
  const { root, sourcePath } = await fixture("# Original final component\n");
  try {
    await assert.rejects(
      importWithAnchoredReadSwap(root, sourcePath, () => replaceFinalPath(sourcePath), "../src/specification/import.js?final-path-race"),
      /SPEC_IMPORT_SOURCE_CHANGED|pathname changed|source changed/i,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("external import rejects an ancestor directory replacement after the anchored read completes", async () => {
  const root = await fsPromises.mkdtemp(join(tmpdir(), "spec-ancestor-race-"));
  const ancestor = join(root, "nested");
  const sourcePath = join(ancestor, "source.md");
  await fsPromises.mkdir(ancestor);
  await fsPromises.writeFile(sourcePath, "# Original ancestor component\n", "utf8");
  try {
    await assert.rejects(
      importWithAnchoredReadSwap(root, sourcePath, () => replaceAncestorPath(root, sourcePath), "../src/specification/import.js?ancestor-path-race"),
      /SPEC_IMPORT_SOURCE_CHANGED|pathname changed|source changed/i,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("createImportSnapshot rejects an ancestor swap after the anchored read", async () => {
  const root = await fsPromises.mkdtemp(join(tmpdir(), "spec-snapshot-ancestor-race-"));
  const outside = await fsPromises.mkdtemp(join(tmpdir(), "spec-snapshot-ancestor-outside-"));
  const ancestor = join(root, "nested");
  const sourcePath = join(ancestor, "source.md");
  const displaced = `${ancestor}.opened`;
  let swapped = false;
  try {
    await fsPromises.mkdir(ancestor);
    await fsPromises.writeFile(sourcePath, "# Original snapshot source\n", "utf8");
    const api = (await import("../src/specification/import.js?public-snapshot-ancestor-race")) as unknown as ImportApi;
    api.setImportCandidateReadTestHooks({
      afterRead: ({ relativePath }) => {
        if (swapped || relativePath !== "nested/source.md") return;
        swapped = true;
        fs.renameSync(ancestor, displaced);
        fs.symlinkSync(outside, ancestor, "dir");
      },
    });
    try {
      await assert.rejects(
        api.createImportSnapshot({ sourcePath, rootDir: root, feature: "checkout", run: "acceptance" }),
        /SPEC_IMPORT_SOURCE_CHANGED|SPEC_IMPORT_SYMLINK|SPEC_IMPORT_UNAUTHORIZED/u,
      );
    } finally {
      api.setImportCandidateReadTestHooks(null);
    }
    assert.equal(swapped, true, "snapshot race seam must execute after the anchored source read");
    assert.deepEqual(fs.readdirSync(outside), [], "an ancestor replacement receives no snapshot writes");
  } finally {
    if (swapped) {
      fs.unlinkSync(ancestor);
      fs.renameSync(displaced, ancestor);
    }
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }
});

test("built-in /spec-import rejects an ancestor swap after the anchored read", async () => {
  const root = await fsPromises.mkdtemp(join(tmpdir(), "spec-command-ancestor-race-"));
  const outside = await fsPromises.mkdtemp(join(tmpdir(), "spec-command-ancestor-outside-"));
  const ancestor = join(root, "nested");
  const sourcePath = join(ancestor, "source.md");
  const displaced = `${ancestor}.opened`;
  let swapped = false;
  try {
    await fsPromises.mkdir(ancestor);
    await fsPromises.writeFile(sourcePath, "# Original command source\n", "utf8");
    await fsPromises.writeFile(join(root, "CONSTITUTION.md"), "# Project Constitution v1.0.0\n\n## I. Quality\n\nShip tested work.\n", "utf8");
    setImportCandidateReadTestHooks({
      afterRead: ({ relativePath }) => {
        if (swapped || relativePath !== "nested/source.md") return;
        swapped = true;
        fs.renameSync(ancestor, displaced);
        fs.symlinkSync(outside, ancestor, "dir");
      },
    });
    try {
      const output = await specImportCommand({ args: "nested --feature checkout", cwd: root, ui: { notify() {} } });
      assert.match(output, /SPEC_IMPORT_SOURCE_CHANGED|SPEC_IMPORT_SYMLINK|SPEC_PATH_UNAUTHORIZED/u);
    } finally {
      setImportCandidateReadTestHooks(null);
    }
    assert.equal(swapped, true, "command race seam must execute after the anchored source read");
    assert.deepEqual(fs.readdirSync(outside), [], "an ancestor replacement receives no imported or workflow writes");
  } finally {
    if (swapped) {
      fs.unlinkSync(ancestor);
      fs.renameSync(displaced, ancestor);
    }
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }
});

test("legacy migration reads only the contained file after a final pathname replacement", async () => {
  const { root, sourcePath } = await fixture("{\"workflow\":\"legacy\"}\n");
  try {
    const result = await legacyWithOpenSwap(root, sourcePath, () => replaceFinalPath(sourcePath), "../src/engine/state.js?final-legacy-path-race");
    assert.equal(result.ok, true);
    if (result.ok) assert.equal(Buffer.from(result.bytes ?? []).toString("utf8"), "# Replacement pathname\n");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("legacy migration reads only the contained file after an ancestor replacement", async () => {
  const root = await fsPromises.mkdtemp(join(tmpdir(), "legacy-ancestor-race-"));
  const ancestor = join(root, "nested");
  const sourcePath = join(ancestor, "source.json");
  await fsPromises.mkdir(ancestor);
  await fsPromises.writeFile(sourcePath, "{\"workflow\":\"legacy\"}\n", "utf8");
  try {
    const result = await legacyWithOpenSwap(root, sourcePath, () => replaceAncestorPath(root, sourcePath), "../src/engine/state.js?ancestor-legacy-path-race");
    assert.equal(result.ok, true);
    if (result.ok) assert.equal(Buffer.from(result.bytes ?? []).toString("utf8"), "# Replacement pathname\n");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("legacy migration still reads a stable contained regular file", async () => {
  const { root, sourcePath } = await fixture("{\"workflow\":\"legacy\"}\n");
  try {
    const pinnedRoot = PinnedProjectRoot.open(root);
    assert.ok(pinnedRoot);
    if (!pinnedRoot) return;
    const api = (await import("../src/engine/state.js?stable-legacy-path")) as unknown as LegacyApi;
    const result = api.readLegacySpecificationSource(pinnedRoot, sourcePath);
    assert.equal(result.ok, true);
    if (result.ok) assert.equal(Buffer.from(result.bytes ?? []).toString("utf8"), "{\"workflow\":\"legacy\"}\n");
    pinnedRoot.close();
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("legacy migration rejects a root swap after the safe source snapshot without outside writes", async () => {
  const root = await fsPromises.mkdtemp(join(tmpdir(), "legacy-root-race-"));
  const outside = await fsPromises.mkdtemp(join(tmpdir(), "legacy-root-outside-"));
  const sourcePath = join(root, "legacy.json");
  const body = `${JSON.stringify({
    schema: 1,
    feature_id: "root-race",
    run_key: "run-root-race",
    workflow: "spec-preparation",
    branch: "feature/root-race",
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
  }, null, 2)}\n`;
  await fsPromises.writeFile(sourcePath, body, "utf8");
  const originalRoot = `${root}.opened`;
  try {
    const api = (await import("../src/specification/migration.js?post-snapshot-root-race")) as unknown as MigrationRaceApi;
    api.setMigrationTestHooks({ afterReadSnapshot: () => replaceRootPath(root, outside) });
    const result = api.migrateLegacySpecificationWorkspace({
      project_root: root,
      legacy_state_path: sourcePath,
      current_constitution_binding: { version: "1.0.0", fingerprint: "0".repeat(64) },
    });
    assert.equal(result.status, "blocked");
    assert.ok(result.receipt.diagnostics.some((diagnostic) => diagnostic.code === "SPEC_MIGRATION_PATH_UNAUTHORIZED"));
    assert.deepEqual(fs.readdirSync(outside), [], "a rebound root receives no specs or state writes");
    assert.equal(fs.readFileSync(join(originalRoot, "legacy.json"), "utf8"), body, "the safe source remains byte-stable");
  } finally {
    const migrationModule = await import("../src/specification/migration.js?post-snapshot-root-race") as unknown as MigrationRaceApi;
    migrationModule.setMigrationTestHooks(null);
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(originalRoot, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }
});
