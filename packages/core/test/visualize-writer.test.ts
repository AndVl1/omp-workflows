/**
 * Visualize writer tests.
 *
 * The production writer receives only a factory-issued tree storage authority.
 * Filesystem assertions below inspect the isolated test workspace; no pathname
 * is passed to the writer or used as its storage authority.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import type { ReportStorageAuthority, ReportTreeStorageAuthority } from "../src/report/storage.js";
import { reportStorageFor, reportTreeStorageFor } from "./report-storage-fixtures.js";
import {
  publishVisualize,
  VisualizePublishError,
  type VisualizeBundleFile,
  type VisualizePublishResult,
} from "../src/visualize/writer.js";
import { VISUALIZE_OUTPUT_FILES, VISUALIZE_OUTPUT_ROOT, sessionPagePath } from "../src/visualize/types.js";

function tmpWorkspace(): string {
  return mkdtempSync(join(tmpdir(), "viz-writer-"));
}

const T0 = "2026-08-19T09:00:00.000Z";
const T1 = "2026-08-19T10:00:00.000Z";
const T2 = "2026-08-19T11:00:00.000Z";

function manifest(generatedAt: string): string {
  return JSON.stringify(
    {
      schema: 1,
      scope: "selected",
      generatedAt,
      renderer: { name: "test", version: "1" },
      sessions: [],
      counts: {
        discoveredSessions: 0,
        generatedSessions: 0,
        generatedPages: 0,
        staleSessions: 0,
        degradedSessions: 0,
        artifactTotal: 0,
        deadLinks: 0,
      },
    },
    null,
    2,
  );
}

/** A complete bundle: hub md/html, mandatory manifest, md+html per session page. */
function bundle(
  generatedAt: string,
  pages: Array<{ kind: "feature" | "legacy" | "cto"; pathKey: string }>,
): VisualizeBundleFile[] {
  const files: VisualizeBundleFile[] = [
    { relPath: VISUALIZE_OUTPUT_FILES.hubMarkdown, content: `# Hub ${generatedAt}` },
    { relPath: VISUALIZE_OUTPUT_FILES.hubHtml, content: `<h1>Hub ${generatedAt}</h1>` },
    { relPath: VISUALIZE_OUTPUT_FILES.manifest, content: manifest(generatedAt) },
  ];
  for (const page of pages) {
    files.push(
      {
        relPath: sessionPagePath(page.kind, page.pathKey, "md"),
        content: `# ${page.pathKey} @ ${generatedAt}`,
      },
      {
        relPath: sessionPagePath(page.kind, page.pathKey, "html"),
        content: `<h1>${page.pathKey}</h1>`,
      },
    );
  }
  return files;
}

function walkFiles(dir: string): string[] {
  const out: string[] = [];
  const stack = [dir];
  while (stack.length > 0) {
    const current = stack.pop()!;
    for (const name of readdirSync(current).sort()) {
      const path = join(current, name);
      if (lstatSync(path).isDirectory()) stack.push(path);
      else out.push(path.slice(dir.length + 1));
    }
  }
  return out.sort();
}

/** Assert every file under `root` is 0600 and every directory is 0700. */
function assertModes(root: string): void {
  const stack = [root];
  while (stack.length > 0) {
    const current = stack.pop()!;
    for (const name of readdirSync(current)) {
      const path = join(current, name);
      const stat = lstatSync(path);
      if (stat.isDirectory()) {
        assert.equal(stat.mode & 0o777, 0o700, `dir mode for ${name}`);
        stack.push(path);
      } else {
        assert.equal(stat.mode & 0o777, 0o600, `file mode for ${name}`);
      }
    }
  }
}

function leftoverDirs(cwd: string): string[] {
  const workState = join(cwd, ".work-state");
  if (!existsSync(workState)) return [];
  return readdirSync(workState).filter(
    (name) => name.startsWith(".visualize-staging-") || name.startsWith(".visualize-backup-"),
  );
}

function readTarget(cwd: string, relPath: string): string {
  return readFileSync(join(cwd, VISUALIZE_OUTPUT_ROOT, relPath), "utf8");
}

function assertRelativeOnly(result: VisualizePublishResult): void {
  for (const path of [...result.files, ...result.pruned, ...result.warnings]) {
    assert.equal(path.startsWith("/"), false, `no absolute path in result: ${path}`);
  }
}

function assertErrorCode(fn: () => unknown, code: string): void {
  assert.throws(fn, (error: unknown) => error instanceof VisualizePublishError && error.code === code);
}

function asTreeAuthority(storage: ReportStorageAuthority): ReportTreeStorageAuthority {
  return storage as unknown as ReportTreeStorageAuthority;
}

test("writer: publishes a complete bundle through the tree authority with relative result paths", () => {
  const cwd = tmpWorkspace();
  try {
    const storage = reportTreeStorageFor(cwd);
    const files = bundle(T1, [
      { kind: "feature", pathKey: "alpha" },
      { kind: "cto", pathKey: "run-1" },
    ]);
    const result = publishVisualize(storage, files);

    assert.equal(result.status, "published");
    assert.equal(result.counters.filesWritten, files.length);
    assert.equal(result.counters.filesPruned, 0);
    assert.deepEqual(result.warnings, []);
    assert.deepEqual(result.files, files.map((file) => `${VISUALIZE_OUTPUT_ROOT}/${file.relPath}`).sort());
    assertRelativeOnly(result);
    assert.equal(existsSync(join(cwd, ".work-state")), true, ".work-state created by storage authority");
    for (const file of files) assert.equal(readTarget(cwd, file.relPath), file.content);
    assertModes(join(cwd, VISUALIZE_OUTPUT_ROOT));
    assert.deepEqual(leftoverDirs(cwd), []);
    const total = files.reduce((sum, file) => sum + Buffer.byteLength(file.content, "utf8"), 0);
    assert.equal(result.counters.bytesWritten, total);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("writer: rejects a base authority before any tree write", () => {
  const cwd = tmpWorkspace();
  try {
    const storage = reportStorageFor(cwd);
    assertErrorCode(
      () => publishVisualize(asTreeAuthority(storage), bundle(T1, [{ kind: "feature", pathKey: "alpha" }])),
      "storage-unavailable",
    );
    assert.equal(existsSync(join(cwd, ".work-state")), false, "base authority cannot create a visualize tree");
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("writer: preflight errors create no target tree", () => {
  const cwd = tmpWorkspace();
  try {
    const storage = reportTreeStorageFor(cwd);
    assertErrorCode(() => publishVisualize(storage, []), "empty-bundle");
    assertErrorCode(
      () => publishVisualize(storage, [{ relPath: VISUALIZE_OUTPUT_FILES.hubMarkdown, content: "x" }]),
      "missing-manifest",
    );

    const unsafePaths = [
      "",
      "..",
      "../index.md",
      "sessions",
      "sessions/feature",
      "sessions/feature/x",
      "sessions/feature/x.txt",
      "sessions/feature/x.htm",
      "sessions/feature/x.md/y",
      "sessions/evil/x.md",
      "sessions/feature/.hidden.md",
      "sessions/feature/a b.md",
      "sessions/feature/x\\y.md",
      "/tmp/index.md",
      "index.md.md",
      "a/../index.md",
      "manifest.json/",
      "sessions//feature/x.md",
      ".work-state/visualize/index.md",
    ];
    for (const relPath of unsafePaths) {
      assertErrorCode(
        () => publishVisualize(storage, [
          { relPath, content: "x" },
          { relPath: VISUALIZE_OUTPUT_FILES.manifest, content: manifest(T1) },
        ]),
        "unsafe-relpath",
      );
    }
    assertErrorCode(
      () => publishVisualize(storage, [
        { relPath: "index.md", content: "a" },
        { relPath: "index.md", content: "b" },
        { relPath: VISUALIZE_OUTPUT_FILES.manifest, content: manifest(T1) },
      ]),
      "duplicate-file",
    );
    assert.equal(existsSync(join(cwd, ".work-state")), false, "still no target after invalid bundles");
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("writer: republish prunes derived pages, preserves user entries and canonical bytes", () => {
  const cwd = tmpWorkspace();
  try {
    const storage = reportTreeStorageFor(cwd);
    mkdirSync(join(cwd, ".work-state", "features", "x", "artifacts"), { recursive: true });
    const stateContent = JSON.stringify({ schema: 1, updated_at: T1 }, null, 2);
    const artifactContent = JSON.stringify({ notes: "canonical artifact" }, null, 2);
    writeFileSync(join(cwd, ".work-state", "features", "x", "state.json"), stateContent);
    writeFileSync(join(cwd, ".work-state", "features", "x", "artifacts", "spec.json"), artifactContent);

    const v1 = bundle(T1, [
      { kind: "feature", pathKey: "alpha" },
      { kind: "feature", pathKey: "beta" },
      { kind: "cto", pathKey: "old-run" },
    ]);
    publishVisualize(storage, v1);
    const userNotes = "# my notes\nnot generated";
    writeFileSync(join(cwd, VISUALIZE_OUTPUT_ROOT, "NOTES.md"), userNotes);
    const notesModeBefore = statSync(join(cwd, VISUALIZE_OUTPUT_ROOT, "NOTES.md")).mode & 0o777;

    const v2 = bundle(T2, [{ kind: "feature", pathKey: "alpha" }]);
    const result = publishVisualize(storage, v2);

    assert.equal(result.status, "published");
    assert.ok(result.pruned.includes(`${VISUALIZE_OUTPUT_ROOT}/sessions/feature/beta.md`));
    assert.ok(result.pruned.includes(`${VISUALIZE_OUTPUT_ROOT}/sessions/feature/beta.html`));
    assert.ok(result.pruned.includes(`${VISUALIZE_OUTPUT_ROOT}/sessions/cto/old-run.md`));
    assert.ok(result.pruned.includes(`${VISUALIZE_OUTPUT_ROOT}/sessions/cto/old-run.html`));
    assert.equal(result.counters.filesPruned, 4);
    assert.equal(existsSync(join(cwd, VISUALIZE_OUTPUT_ROOT, "sessions", "feature", "beta.md")), false);
    assert.equal(existsSync(join(cwd, VISUALIZE_OUTPUT_ROOT, "sessions", "cto", "old-run.md")), false);
    assert.equal(readTarget(cwd, "sessions/feature/alpha.md"), "# alpha @ 2026-08-19T11:00:00.000Z");
    assert.equal(readTarget(cwd, "NOTES.md"), userNotes);
    assert.equal(statSync(join(cwd, VISUALIZE_OUTPUT_ROOT, "NOTES.md")).mode & 0o777, notesModeBefore);
    assert.ok(result.warnings.some((warning) => warning.includes("preserved non-derived")));
    assert.equal(readFileSync(join(cwd, ".work-state", "features", "x", "state.json"), "utf8"), stateContent);
    assert.equal(
      readFileSync(join(cwd, ".work-state", "features", "x", "artifacts", "spec.json"), "utf8"),
      artifactContent,
    );
    assertRelativeOnly(result);
    assert.deepEqual(leftoverDirs(cwd), []);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("writer: storage authority rejects symlinked destinations without following them", () => {
  const cwd = tmpWorkspace();
  try {
    const storage = reportTreeStorageFor(cwd);
    const outside = join(cwd, "outside");
    mkdirSync(outside);
    const target = join(cwd, ".work-state", "visualize");
    mkdirSync(join(cwd, ".work-state"));
    symlinkSync(outside, target, "dir");
    assertErrorCode(
      () => publishVisualize(storage, bundle(T1, [{ kind: "feature", pathKey: "alpha" }])),
      "storage-unavailable",
    );
    assert.equal(lstatSync(target).isSymbolicLink(), true, "symlink untouched");
    assert.equal(existsSync(join(outside, "index.md")), false, "nothing written through the symlink");
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("writer: an old symlinked sessions entry is discarded, never followed", () => {
  const cwd = tmpWorkspace();
  try {
    const storage = reportTreeStorageFor(cwd);
    publishVisualize(storage, bundle(T1, [{ kind: "feature", pathKey: "alpha" }]));
    const outside = join(cwd, "outside-sessions");
    mkdirSync(join(outside, "feature"), { recursive: true });
    writeFileSync(join(outside, "feature", "planted.md"), "# planted");
    rmSync(join(cwd, VISUALIZE_OUTPUT_ROOT, "sessions"), { recursive: true, force: true });
    symlinkSync(outside, join(cwd, VISUALIZE_OUTPUT_ROOT, "sessions"), "dir");

    const result = publishVisualize(storage, bundle(T2, [{ kind: "feature", pathKey: "alpha" }]));
    assert.equal(result.status, "published");
    assert.equal(lstatSync(join(cwd, VISUALIZE_OUTPUT_ROOT, "sessions")).isSymbolicLink(), false);
    assert.equal(readTarget(cwd, "sessions/feature/alpha.md"), "# alpha @ 2026-08-19T11:00:00.000Z");
    assert.equal(readFileSync(join(outside, "feature", "planted.md"), "utf8"), "# planted");
    assertRelativeOnly(result);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("writer: result never leaks content, secrets or absolute paths", () => {
  const cwd = tmpWorkspace();
  try {
    const storage = reportTreeStorageFor(cwd);
    const secret = "sk-super-secret-123456";
    const files = bundle(T1, [{ kind: "feature", pathKey: "alpha" }]);
    files[0] = { ...files[0]!, content: `# Hub ${secret}` };
    const result = publishVisualize(storage, files);
    const serialized = JSON.stringify(result);
    assert.equal(serialized.includes(secret), false);
    assert.equal(serialized.includes(cwd), false);
    assertRelativeOnly(result);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("writer: repeated publishes leave one complete tree and no scratch directories", () => {
  const cwd = tmpWorkspace();
  try {
    const storage = reportTreeStorageFor(cwd);
    const rounds = [
      bundle(T0, [{ kind: "feature", pathKey: "alpha" }]),
      bundle(T1, [{ kind: "feature", pathKey: "alpha" }]),
      bundle(T2, [{ kind: "cto", pathKey: "final" }]),
    ];
    for (const files of rounds) {
      const result = publishVisualize(storage, files);
      assert.equal(result.status, "published");
      assert.deepEqual(leftoverDirs(cwd), []);
      assertModes(join(cwd, VISUALIZE_OUTPUT_ROOT));
      assert.equal(walkFiles(join(cwd, VISUALIZE_OUTPUT_ROOT)).length, files.length);
    }
    const last = rounds[2]!;
    for (const file of last) assert.equal(readTarget(cwd, file.relPath), file.content);
    assert.equal(existsSync(join(cwd, VISUALIZE_OUTPUT_ROOT, "sessions", "feature", "alpha.md")), false);
    assert.equal(existsSync(join(cwd, VISUALIZE_OUTPUT_ROOT, "sessions", "cto", "final.md")), true);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});
