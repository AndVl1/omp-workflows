import { execFileSync } from "node:child_process";
import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, sep } from "node:path";
import { test } from "node:test";
import { PinnedProjectRoot } from "../src/specification/pinned-root.js";
import {
  PRODUCT_PRD_ARTIFACT_ID,
  PRD_SOURCE_ARTIFACT_IDS,
  validateProductPrdDocument,
  type ProductPrdValidation,
  writeProductPrdDocument,
} from "../src/engine/product-prd.js";

const STATE_RELATIVE = ".work-state/features/product-prd";
const ARTIFACTS_RELATIVE = `${STATE_RELATIVE}/artifacts`;
const SOURCE_IDS = [...PRD_SOURCE_ARTIFACT_IDS];

type Fixture = {
  root: string;
  featureDir: string;
  artifactsDir: string;
  manifestPath: string;
  documentPath: string;
  htmlPath: string;
  sourcePaths: Record<string, string>;
  cleanup: () => void;
};

type Cleanup = () => void;
type Mutation = (fixture: Fixture) => Cleanup;
type Target = { name: string; absolute: string; relative: string };

function fixture(): Fixture {
  const root = mkdtempSync(join(tmpdir(), "product-prd-validator-security-"));
  const featureDir = join(root, STATE_RELATIVE);
  const artifactsDir = join(root, ARTIFACTS_RELATIVE);
  mkdirSync(artifactsDir, { recursive: true });
  const sourceArtifacts = Object.fromEntries(SOURCE_IDS.map((id) => [id, {}]));
  const sourcePaths = Object.fromEntries(SOURCE_IDS.map((id) => {
    const path = join(artifactsDir, `${id}.json`);
    writeFileSync(path, "{}\n");
    return [id, path];
  }));
  const written = writeProductPrdDocument({
    projectRoot: root,
    stateDirRelative: STATE_RELATIVE,
    artifactsDirRelative: ARTIFACTS_RELATIVE,
    path: "documents/product-prd.md",
    sourceArtifacts,
  });
  assert.equal(written.ok, true, "the fixture PRD must be persisted before mutation");
  if (!written.ok) throw new Error(written.error);
  return {
    root,
    featureDir,
    artifactsDir,
    manifestPath: join(artifactsDir, `${PRODUCT_PRD_ARTIFACT_ID}.json`),
    documentPath: join(featureDir, "documents/product-prd.md"),
    htmlPath: join(featureDir, "documents/product-prd.html"),
    sourcePaths,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

function relativeToRoot(root: string, path: string): string {
  return relative(root, path).split(sep).join("/");
}

function targetsFor(run: Fixture): Target[] {
  return [
    { name: "manifest", absolute: run.manifestPath, relative: relativeToRoot(run.root, run.manifestPath) },
    { name: "document", absolute: run.documentPath, relative: relativeToRoot(run.root, run.documentPath) },
    { name: "html", absolute: run.htmlPath, relative: relativeToRoot(run.root, run.htmlPath) },
    ...SOURCE_IDS.map((id) => ({
      name: `source-${id}`,
      absolute: run.sourcePaths[id]!,
      relative: relativeToRoot(run.root, run.sourcePaths[id]!),
    })),
  ];
}

function replaceLeafWithSymlink(path: string): Cleanup {
  const outside = mkdtempSync(join(tmpdir(), "product-prd-validator-foreign-"));
  const foreign = join(outside, "foreign.json");
  const original = readFileSync(path);
  writeFileSync(foreign, original);
  const originalPath = `${path}.matrix-original`;
  renameSync(path, originalPath);
  symlinkSync(foreign, path);
  return () => {
    assert.deepEqual(readFileSync(foreign), original, "the foreign valid file must remain untouched");
    rmSync(path, { force: true });
    renameSync(originalPath, path);
    rmSync(outside, { recursive: true, force: true });
  };
}

function replaceDirectoryWithSymlink(path: string): Cleanup {
  const outside = mkdtempSync(join(tmpdir(), "product-prd-validator-foreign-dir-"));
  const originalPath = `${path}.matrix-original`;
  renameSync(path, originalPath);
  symlinkSync(outside, path, "dir");
  return () => {
    assert.deepEqual(readdirSync(outside), [], "the foreign replacement directory must remain untouched");
    rmSync(path, { force: true, recursive: true });
    renameSync(originalPath, path);
    rmSync(outside, { recursive: true, force: true });
  };
}

function replaceLeafWithBytes(path: string, bytes: Uint8Array): Cleanup {
  const originalPath = `${path}.matrix-original`;
  renameSync(path, originalPath);
  writeFileSync(path, bytes);
  return () => {
    rmSync(path, { force: true });
    renameSync(originalPath, path);
  };
}

function replaceLeafWithFifo(path: string): Cleanup {
  const originalPath = `${path}.matrix-original`;
  renameSync(path, originalPath);
  execFileSync("mkfifo", [path]);
  return () => {
    rmSync(path, { force: true });
    renameSync(originalPath, path);
  };
}

function validateWithMutation(mutate: Mutation, triggerRelative: (run: Fixture) => string): void {
  const run = fixture();
  const pinned = PinnedProjectRoot.open(run.root);
  assert.ok(pinned, "the fixture root must be pinnable");
  const originalReadFile = PinnedProjectRoot.prototype.readFile;
  let fired = false;
  let borrowedReads = 0;
  let foreignReads = 0;
  let mutationCleanup: Cleanup | null = null;
  let verdict: ProductPrdValidation | undefined;
  PinnedProjectRoot.prototype.readFile = function (relativePath, options) {
    if (this === pinned) borrowedReads += 1;
    else foreignReads += 1;
    if (!fired && relativePath === triggerRelative(run)) {
      fired = true;
      mutationCleanup = mutate(run);
    }
    return originalReadFile.call(this, relativePath, options);
  };
  try {
    verdict = validateProductPrdDocument({
      stateDir: run.featureDir,
      artifactsDir: run.artifactsDir,
      pinnedRoot: pinned,
      stateDirRelative: STATE_RELATIVE,
      artifactsDirRelative: ARTIFACTS_RELATIVE,
    });
  } finally {
    PinnedProjectRoot.prototype.readFile = originalReadFile;
    mutationCleanup?.();
    pinned.close();
    run.cleanup();
  }
  assert.equal(fired, true, "the mutation seam must run immediately before its targeted read");
  assert.equal(foreignReads, 0, "validation must never read through a foreign root or newly opened pin");
  assert.ok(borrowedReads > 0, "validation must consume the borrowed pinned root");
  assert.ok(verdict, "validation must return a verdict");
  assert.equal(verdict.ok, false, "a raced or malformed persisted target must fail closed");
  assert.ok(verdict.issues.length > 0, "failure must include a stable diagnostic");
}

test("product PRD validation rejects root, ancestor, artifact-dir, manifest, document and HTML swaps", () => {
  const swaps: Array<{ name: string; trigger: (run: Fixture) => string; mutate: Mutation }> = [
    { name: "root", trigger: (run) => relativeToRoot(run.root, run.manifestPath), mutate: (run) => replaceDirectoryWithSymlink(run.root) },
    { name: "ancestor", trigger: (run) => relativeToRoot(run.root, run.manifestPath), mutate: (run) => replaceDirectoryWithSymlink(join(run.root, ".work-state", "features")) },
    { name: "artifact-dir", trigger: (run) => relativeToRoot(run.root, run.manifestPath), mutate: (run) => replaceDirectoryWithSymlink(run.artifactsDir) },
    { name: "manifest", trigger: (run) => relativeToRoot(run.root, run.manifestPath), mutate: (run) => replaceLeafWithSymlink(run.manifestPath) },
    { name: "document", trigger: (run) => relativeToRoot(run.root, run.documentPath), mutate: (run) => replaceLeafWithSymlink(run.documentPath) },
    { name: "html", trigger: (run) => relativeToRoot(run.root, run.htmlPath), mutate: (run) => replaceLeafWithSymlink(run.htmlPath) },
  ];
  for (const swap of swaps) {
    assert.doesNotThrow(() => validateWithMutation(swap.mutate, swap.trigger), `${swap.name} swap must be contained and fail closed`);
  }
});

test("product PRD validation rejects FIFO replacements for manifest, document, HTML and every source", () => {
  const run = fixture();
  const targets = targetsFor(run);
  run.cleanup();
  for (const target of targets) {
    validateWithMutation(
      (current) => replaceLeafWithFifo(target.name === "manifest" ? current.manifestPath : target.name === "document" ? current.documentPath : target.name === "html" ? current.htmlPath : current.sourcePaths[target.name.slice("source-".length)]!),
      () => target.relative,
    );
  }
});

test("product PRD validation rejects oversize replacements for manifest, document, HTML and every source", () => {
  const oversized = Buffer.alloc(8 * 1024 * 1024 + 1, 0x20);
  const run = fixture();
  const targets = targetsFor(run);
  run.cleanup();
  for (const target of targets) {
    validateWithMutation(
      (current) => replaceLeafWithBytes(target.name === "manifest" ? current.manifestPath : target.name === "document" ? current.documentPath : target.name === "html" ? current.htmlPath : current.sourcePaths[target.name.slice("source-".length)]!, oversized),
      () => target.relative,
    );
  }
});

test("product PRD validation rejects invalid UTF-8 replacements for manifest, document, HTML and every source", () => {
  const invalidUtf8 = Buffer.from([0xff, 0xfe, 0xfd, 0x00]);
  const run = fixture();
  const targets = targetsFor(run);
  run.cleanup();
  for (const target of targets) {
    validateWithMutation(
      (current) => replaceLeafWithBytes(target.name === "manifest" ? current.manifestPath : target.name === "document" ? current.documentPath : target.name === "html" ? current.htmlPath : current.sourcePaths[target.name.slice("source-".length)]!, invalidUtf8),
      () => target.relative,
    );
  }
});

test("product PRD validation rejects a valid foreign copy for every source leaf swap", () => {
  const run = fixture();
  const sourceTargets = targetsFor(run).filter((target) => target.name.startsWith("source-"));
  run.cleanup();
  for (const target of sourceTargets) {
    validateWithMutation(
      (current) => replaceLeafWithSymlink(current.sourcePaths[target.name.slice("source-".length)]!),
      () => target.relative,
    );
  }
});

