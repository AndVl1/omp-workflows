/**
 * Visualize OPT-A — whole-bundle atomic publisher tests (architecture-7).
 *
 * Defends the writer's observable guarantees against real filesystem
 * behavior:
 *   - complete-bundle atomicity: staged-write failures leave the previous
 *     bundle intact with no partial target visible; success exposes the full
 *     new tree; staging/backup directories never leak;
 *   - permissions: every published file is mode 0600, directories 0700,
 *     independent of umask;
 *   - boundary/symlink rejection: symlinked targets, non-directory
 *     destinations and boundary escapes are rejected without touching them;
 *     symlinked roots (`.work-state` itself) stay inside the real boundary;
 *     a symlinked `sessions` entry in the old tree is never followed;
 *   - unsafe ids: invalid kind/pathKey segments, `..`/`.`/absolute paths,
 *     unknown extensions and duplicates are rejected before any filesystem
 *     write; preflight errors (empty bundle / missing manifest) create no
 *     target tree;
 *   - pruning: republish removes old derived pages, keeps regenerated ones,
 *     preserves non-derived user-authored entries and never mutates
 *     canonical state bytes;
 *   - concurrency: deterministic hook-driven simulations of racing writers
 *     prove the rollback guard — an older writer whose swap fails against a
 *     complete target discards staging/backup with a swap-rollback warning and
 *     never restores the older tree; an ENOENT-style capture (no previous
 *     bundle) proceeds; an invalid concurrent target is preserved with a
 *     typed rollback failure;
 *   - canonical-byte identity and result hygiene: the result carries only
 *     relative paths/counters/warnings — never content, secrets or absolute
 *     paths.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";

import {
  publishVisualize,
  publishVisualizePinned,
  VisualizePublishError,
  type VisualizePublishResult,
} from "../src/visualize/writer.js";
import { PinnedProjectRoot } from "../src/specification/pinned-root.js";
import { VISUALIZE_OUTPUT_FILES, VISUALIZE_OUTPUT_ROOT, sessionPagePath } from "../src/visualize/types.js";

function tmpWorkspace(): string {
  return mkdtempSync(join(tmpdir(), "viz-writer-"));
}

function displaceForRace(path: string, recreate: () => void): string {
  const displaced = `${path}.displaced`;
  renameSync(path, displaced);
  recreate();
  return displaced;
}

function restoreDisplaced(path: string, displaced: string): void {
  rmSync(path, { recursive: true, force: true });
  renameSync(displaced, path);
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
): Array<{ relPath: string; content: string }> {
  const files: Array<{ relPath: string; content: string }> = [
    { relPath: VISUALIZE_OUTPUT_FILES.hubMarkdown, content: `# Hub ${generatedAt}` },
    { relPath: VISUALIZE_OUTPUT_FILES.hubHtml, content: `<h1>Hub ${generatedAt}</h1>` },
    { relPath: VISUALIZE_OUTPUT_FILES.manifest, content: manifest(generatedAt) },
  ];
  for (const p of pages) {
    files.push({
      relPath: sessionPagePath(p.kind, p.pathKey, "md"),
      content: `# ${p.pathKey} @ ${generatedAt}`,
    });
    files.push({
      relPath: sessionPagePath(p.kind, p.pathKey, "html"),
      content: `<h1>${p.pathKey}</h1>`,
    });
  }
  return files;
}

function walkFiles(dir: string): string[] {
  const out: string[] = [];
  const stack = [dir];
  while (stack.length > 0) {
    const d = stack.pop()!;
    for (const name of readdirSync(d).sort()) {
      const p = join(d, name);
      if (lstatSync(p).isDirectory()) stack.push(p);
      else out.push(relative(dir, p));
    }
  }
  return out.sort();
}

/** Assert every file under `root` is 0600 and every directory is 0700. */
function assertModes(root: string): void {
  const stack = [root];
  while (stack.length > 0) {
    const d = stack.pop()!;
    for (const name of readdirSync(d)) {
      const p = join(d, name);
      const st = lstatSync(p);
      if (st.isDirectory()) {
        assert.equal(st.mode & 0o777, 0o700, `dir mode for ${name}`);
        stack.push(p);
      } else {
        assert.equal(st.mode & 0o777, 0o600, `file mode for ${name}`);
      }
    }
  }
}

/** Staging/backup siblings that must never outlive a publish. */
function leftoverDirs(cwd: string): string[] {
  const ws = join(cwd, ".work-state");
  if (!existsSync(ws)) return [];
  return readdirSync(ws).filter(
    (name) => name.startsWith(".visualize-staging-") || name.startsWith(".visualize-backup-"),
  );
}

function readTarget(cwd: string, rel: string): string {
  return readFileSync(join(cwd, VISUALIZE_OUTPUT_ROOT, rel), "utf8");
}

function assertRelativeOnly(result: VisualizePublishResult): void {
  for (const p of [...result.files, ...result.pruned, ...result.warnings]) {
    assert.ok(!p.startsWith("/"), `no absolute path in result: ${p}`);
  }
}

function assertErrorCode(fn: () => unknown, code: string): void {
  assert.throws(fn, (e: unknown) => e instanceof VisualizePublishError && e.code === code);
}

// ── 1. Happy path: atomic complete publish, permissions, result shape ────────

test("writer: publishes a complete bundle atomically with 0600 files / 0700 dirs and a relative-only result", () => {
  const cwd = tmpWorkspace();
  try {
    const files = bundle(T1, [
      { kind: "feature", pathKey: "alpha" },
      { kind: "cto", pathKey: "run-1" },
    ]);
    const result = publishVisualize(cwd, files);

    assert.equal(result.status, "published");
    assert.equal(result.counters.filesWritten, files.length);
    assert.equal(result.counters.filesPruned, 0);
    assert.deepEqual(result.warnings, []);
    // cwd-relative paths, sorted
    assert.deepEqual(
      result.files,
      files.map((f) => `${VISUALIZE_OUTPUT_ROOT}/${f.relPath}`).sort(),
    );
    assertRelativeOnly(result);
    assert.equal(existsSync(join(cwd, ".work-state")), true, ".work-state created on demand");
    // every file exists with exact content
    for (const f of files) assert.equal(readTarget(cwd, f.relPath), f.content);
    assertModes(join(cwd, VISUALIZE_OUTPUT_ROOT));
    assert.deepEqual(leftoverDirs(cwd), []);
    // bytes counter is the exact UTF-8 byte sum
    const total = files.reduce((n, f) => n + Buffer.byteLength(f.content, "utf8"), 0);
    assert.equal(result.counters.bytesWritten, total);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

// ── 2. Preflight errors create no target tree ────────────────────────────────

test("writer: preflight errors (empty bundle, missing manifest, unsafe ids) create no target tree", () => {
  const cwd = tmpWorkspace();
  try {
    assertErrorCode(() => publishVisualize(cwd, []), "empty-bundle");
    assertErrorCode(
      () => publishVisualize(cwd, [{ relPath: VISUALIZE_OUTPUT_FILES.hubMarkdown, content: "x" }]),
      "missing-manifest",
    );
    assert.equal(existsSync(join(cwd, ".work-state")), false, "no .work-state created on preflight failure");

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
        () =>
          publishVisualize(cwd, [
            { relPath, content: "x" },
            { relPath: VISUALIZE_OUTPUT_FILES.manifest, content: manifest(T1) },
          ]),
        "unsafe-relpath",
      );
    }
    assertErrorCode(
      () =>
        publishVisualize(cwd, [
          { relPath: "index.md", content: "a" },
          { relPath: "index.md", content: "b" },
          { relPath: VISUALIZE_OUTPUT_FILES.manifest, content: manifest(T1) },
        ]),
      "duplicate-file",
    );
    assert.equal(existsSync(join(cwd, ".work-state")), false, "still no target after invalid bundles");
    // error messages never leak the absolute workspace path
    try {
      publishVisualize(cwd, []);
    } catch (err) {
      assert.equal(JSON.stringify((err as Error).message).includes(cwd), false, "no absolute path in the error");
    }
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

// ── 3. Staged-write failure: old bundle intact, no partial target ────────────

test("writer: a staged-write failure leaves the previous bundle intact and no partial target visible", () => {
  const cwd = tmpWorkspace();
  try {
    const v1 = bundle(T1, [{ kind: "feature", pathKey: "alpha" }]);
    publishVisualize(cwd, v1);

    // v2 fails while staging: the fresh staging dir is made unwritable via the seam.
    const v2 = bundle(T2, [
      { kind: "feature", pathKey: "alpha" },
      { kind: "feature", pathKey: "beta" },
    ]);
    let stagingSeen: string | null = null;
    assertErrorCode(
      () =>
        publishVisualize(cwd, v2, {
          hooks: {
            onStagingCreated: (staging) => {
              stagingSeen = staging;
              chmodSync(staging, 0o500);
            },
          },
        }),
      "write-failed",
    );
    assert.ok(stagingSeen, "staging dir was created before the failure");
    // old bundle intact, byte-exact
    for (const f of v1) assert.equal(readTarget(cwd, f.relPath), f.content);
    // no partial new files leaked into the target
    assert.equal(existsSync(join(cwd, VISUALIZE_OUTPUT_ROOT, "sessions", "feature", "beta.md")), false);
    assert.deepEqual(leftoverDirs(cwd), []);
    // retry succeeds once the interference is gone
    const retry = publishVisualize(cwd, v2);
    assert.equal(retry.status, "published");
    assert.equal(readTarget(cwd, "sessions/feature/beta.md"), "# beta @ 2026-08-19T11:00:00.000Z");
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("writer: a mid-write failure cleans up partial staging content", () => {
  const cwd = tmpWorkspace();
  try {
    publishVisualize(cwd, bundle(T1, [{ kind: "feature", pathKey: "alpha" }]));
    // Block the `sessions` parent with a file so the session-page write fails
    // after some hub files were already staged.
    assertErrorCode(
      () =>
        publishVisualize(cwd, bundle(T2, [{ kind: "feature", pathKey: "alpha" }]), {
          hooks: {
            onStagingCreated: (staging) => writeFileSync(join(staging, "sessions"), "blocker"),
          },
        }),
      "write-failed",
    );
    assert.equal(readTarget(cwd, "index.md"), "# Hub 2026-08-19T10:00:00.000Z", "old bundle intact");
    assert.deepEqual(leftoverDirs(cwd), [], "partial staging fully removed");
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

// ── 4. Rollback guard: concurrent writers, one complete winner ───────────────

test("writer: an older writer whose swap fails against a newer complete target discards staging/backup (never restores)", () => {
  const cwd = tmpWorkspace();
  try {
    // v1 (T1) is the established bundle.
    publishVisualize(cwd, bundle(T1, [{ kind: "feature", pathKey: "alpha" }]));
    // Older writer v0 (T0) loses the race: while it holds the captured v1 in
    // backup, a newer writer publishes v2 (T2) at the target.
    const v0 = bundle(T0, [{ kind: "feature", pathKey: "alpha" }]);
    const v2 = bundle(T2, [
      { kind: "feature", pathKey: "alpha" },
      { kind: "cto", pathKey: "newer" },
    ]);
    let captured: string | null = null;
    const result = publishVisualize(cwd, v0, {
      hooks: {
        onCaptured: (backupDir) => {
          captured = backupDir;
          publishVisualize(cwd, v2); // the racing newer writer lands its tree
        },
      },
    });

    assert.ok(captured, "old bundle was captured before the race");
    assert.equal(result.status, "superseded");
    assert.deepEqual(result.files, [], "nothing of the older writer is live");
    assert.deepEqual(result.pruned, []);
    assert.equal(result.counters.filesWritten, 0);
    assert.ok(result.warnings.some((w) => w.includes("swap-rollback")), "swap-rollback warning surfaced");
    // The newer complete bundle is live, byte-exact and fully intact.
    for (const f of v2) assert.equal(readTarget(cwd, f.relPath), f.content);
    assert.equal(readTarget(cwd, VISUALIZE_OUTPUT_FILES.manifest), manifest(T2));
    // v0's older tree was never restored over v2.
    assert.equal(readTarget(cwd, VISUALIZE_OUTPUT_FILES.hubMarkdown), "# Hub 2026-08-19T11:00:00.000Z");
    // No staging/backup leftovers from either writer.
    assert.deepEqual(leftoverDirs(cwd), []);
    assertModes(join(cwd, VISUALIZE_OUTPUT_ROOT));
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("writer: with no previous bundle, a swap failure against a live complete target supersedes without clobbering", () => {
  const cwd = tmpWorkspace();
  try {
    const v0 = bundle(T0, [{ kind: "feature", pathKey: "alpha" }]);
    const v2 = bundle(T2, [{ kind: "feature", pathKey: "alpha" }]);
    // No previous bundle exists, so the outer writer captures nothing (the
    // ENOENT-capture contract: no previous bundle → proceed without backup).
    const result = publishVisualize(cwd, v0, {
      hooks: {
        onCaptured: (backupDir) => {
          assert.equal(backupDir, null, "no previous bundle to capture");
          publishVisualize(cwd, v2);
        },
      },
    });
    assert.equal(result.status, "superseded");
    assert.ok(result.warnings.some((w) => w.includes("swap-rollback")));
    for (const f of v2) assert.equal(readTarget(cwd, f.relPath), f.content);
    assert.deepEqual(leftoverDirs(cwd), []);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("writer: a future-clock complete target always wins over the captured backup", () => {
  const cwd = tmpWorkspace();
  try {
    publishVisualize(cwd, bundle(T1, [{ kind: "feature", pathKey: "alpha" }]));
    const v0 = bundle(T0, [{ kind: "feature", pathKey: "alpha" }]);
    // The racing writer lands a complete target with a future timestamp while
    // v0 is mid-swap. Recovery must trust the current valid target, not compare
    // timestamps or recursively remove it.
    const future = bundle("2099-12-31T23:59:59.000Z", [{ kind: "feature", pathKey: "future" }]);
    const result = publishVisualize(cwd, v0, {
      hooks: { onCaptured: () => publishVisualize(cwd, future) },
    });
    assert.equal(result.status, "superseded");
    assert.ok(result.warnings.some((w) => w.includes("swap-rollback")));
    for (const f of future) assert.equal(readTarget(cwd, f.relPath), f.content);
    assert.equal(readTarget(cwd, VISUALIZE_OUTPUT_FILES.manifest), manifest("2099-12-31T23:59:59.000Z"));
    assert.equal(existsSync(join(cwd, VISUALIZE_OUTPUT_ROOT, "sessions", "feature", "alpha.md")), false);
    assert.deepEqual(leftoverDirs(cwd), []);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("writer: an invalid concurrent target is preserved and backup remains recoverable", () => {
  const cwd = tmpWorkspace();
  try {
    publishVisualize(cwd, bundle(T1, [{ kind: "feature", pathKey: "alpha" }]));
    const v0 = bundle(T0, [{ kind: "feature", pathKey: "alpha" }]);
    assertErrorCode(
      () =>
        publishVisualize(cwd, v0, {
          hooks: {
            onCaptured: () => {
              mkdirSync(join(cwd, VISUALIZE_OUTPUT_ROOT), { recursive: true });
              writeFileSync(join(cwd, VISUALIZE_OUTPUT_ROOT, VISUALIZE_OUTPUT_FILES.manifest), "{}", { mode: 0o600 });
            },
          },
        }),
      "recovery_required",
    );
    assert.equal(readFileSync(join(cwd, VISUALIZE_OUTPUT_ROOT, VISUALIZE_OUTPUT_FILES.manifest), "utf8"), "{}");
    const leftovers = leftoverDirs(cwd);
    assert.equal(leftovers.length, 2, "captured backup and staging remain as recovery artifacts");
    assert.equal(leftovers.filter((name) => name.startsWith(".visualize-backup-")).length, 1);
    assert.equal(leftovers.filter((name) => name.startsWith(".visualize-staging-")).length, 1);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("writer: malformed, nonregular, missing, and hash-raced winners require recovery without scratch cleanup", () => {
  type InvalidCase = { name: string; mutate: (target: string, outside: string) => void };
  const cases: InvalidCase[] = [
    {
      name: "manifest schema",
      mutate: (target) => writeFileSync(join(target, VISUALIZE_OUTPUT_FILES.manifest), JSON.stringify({ generatedAt: "x" }), { mode: 0o600 }),
    },
    {
      name: "missing required file",
      mutate: (target) => writeFileSync(join(target, VISUALIZE_OUTPUT_FILES.manifest), manifest(T2), { mode: 0o600 }),
    },
    {
      name: "nonregular required file",
      mutate: (target) => {
        writeFileSync(join(target, VISUALIZE_OUTPUT_FILES.manifest), manifest(T2), { mode: 0o600 });
        rmSync(join(target, VISUALIZE_OUTPUT_FILES.hubMarkdown), { force: true });
        mkdirSync(join(target, VISUALIZE_OUTPUT_FILES.hubMarkdown));
      },
    },
    {
      name: "symlink required file",
      mutate: (target, outside) => {
        writeFileSync(join(target, VISUALIZE_OUTPUT_FILES.manifest), manifest(T2), { mode: 0o600 });
        rmSync(join(target, VISUALIZE_OUTPUT_FILES.hubMarkdown), { force: true });
        symlinkSync(outside, join(target, VISUALIZE_OUTPUT_FILES.hubMarkdown), "file");
      },
    },
  ];
  for (const current of cases) {
    const cwd = tmpWorkspace();
    const outside = mkdtempSync(join(tmpdir(), `viz-recovery-${current.name.replaceAll(" ", "-")}-`));
    try {
      publishVisualize(cwd, bundle(T1, [{ kind: "feature", pathKey: "old" }]));
      assertErrorCode(
        () => publishVisualize(cwd, bundle(T0, [{ kind: "feature", pathKey: "old" }]), {
          hooks: {
            onCaptured: () => {
              mkdirSync(join(cwd, VISUALIZE_OUTPUT_ROOT), { recursive: true });
              current.mutate(join(cwd, VISUALIZE_OUTPUT_ROOT), outside);
            },
          },
        }),
        "recovery_required",
      );
      const leftovers = leftoverDirs(cwd);
      assert.equal(leftovers.filter((name) => name.startsWith(".visualize-backup-")).length, 1, current.name);
      assert.equal(leftovers.filter((name) => name.startsWith(".visualize-staging-")).length, 1, current.name);
      assert.deepEqual(readdirSync(outside), [], `${current.name}: foreign target remains untouched`);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  }

  const cwd = tmpWorkspace();
  try {
    publishVisualize(cwd, bundle(T1, [{ kind: "feature", pathKey: "old" }]));
    let mutated = false;
    assertErrorCode(
      () => publishVisualize(cwd, bundle(T0, [{ kind: "feature", pathKey: "old" }]), {
        hooks: {
          onCaptured: () => publishVisualize(cwd, bundle(T2, [{ kind: "feature", pathKey: "new" }])),
          onAfterRecoveryFileRead: (target, relativePath) => {
            if (relativePath === VISUALIZE_OUTPUT_FILES.hubMarkdown && !mutated) {
              mutated = true;
              writeFileSync(join(target, relativePath), "# attacker", "utf8");
            }
          },
        },
      }),
      "recovery_required",
    );
    assert.equal(mutated, true, "hash barrier was exercised");
    const leftovers = leftoverDirs(cwd);
    assert.equal(leftovers.filter((name) => name.startsWith(".visualize-backup-")).length, 1);
    assert.equal(leftovers.filter((name) => name.startsWith(".visualize-staging-")).length, 1);
    assert.equal(readTarget(cwd, VISUALIZE_OUTPUT_FILES.manifest), manifest(T2), "valid winner remains live");
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

// ── 5. Pruning + canonical-byte identity + user-authored preservation ────────

test("writer: republish prunes old derived pages, preserves non-derived entries and canonical state bytes", () => {
  const cwd = tmpWorkspace();
  try {
    // Canonical state + artifact bytes that must never change.
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
    publishVisualize(cwd, v1);
    // A user-authored file dropped into the output root (non-derived shape).
    const userNotes = "# my notes\nnot generated";
    writeFileSync(join(cwd, VISUALIZE_OUTPUT_ROOT, "NOTES.md"), userNotes);
    const notesModeBefore = statSync(join(cwd, VISUALIZE_OUTPUT_ROOT, "NOTES.md")).mode & 0o777;

    // Republish without beta / old-run; NOTES.md is not part of the bundle.
    const v2 = bundle(T2, [{ kind: "feature", pathKey: "alpha" }]);
    const result = publishVisualize(cwd, v2);

    assert.equal(result.status, "published");
    assert.ok(result.pruned.includes(`${VISUALIZE_OUTPUT_ROOT}/sessions/feature/beta.md`));
    assert.ok(result.pruned.includes(`${VISUALIZE_OUTPUT_ROOT}/sessions/feature/beta.html`));
    assert.ok(result.pruned.includes(`${VISUALIZE_OUTPUT_ROOT}/sessions/cto/old-run.md`));
    assert.ok(result.pruned.includes(`${VISUALIZE_OUTPUT_ROOT}/sessions/cto/old-run.html`));
    assert.ok(
      !result.pruned.includes(`${VISUALIZE_OUTPUT_ROOT}/sessions/feature/alpha.md`),
      "regenerated pages are not counted as pruned",
    );
    assert.equal(result.counters.filesPruned, 4);
    // Old pages are gone, regenerated pages are present with fresh content.
    assert.equal(existsSync(join(cwd, VISUALIZE_OUTPUT_ROOT, "sessions", "feature", "beta.md")), false);
    assert.equal(existsSync(join(cwd, VISUALIZE_OUTPUT_ROOT, "sessions", "cto", "old-run.md")), false);
    assert.equal(readTarget(cwd, "sessions/feature/alpha.md"), "# alpha @ 2026-08-19T11:00:00.000Z");
    // User-authored entry preserved byte-exact with its original mode.
    assert.equal(readTarget(cwd, "NOTES.md"), userNotes);
    assert.equal(statSync(join(cwd, VISUALIZE_OUTPUT_ROOT, "NOTES.md")).mode & 0o777, notesModeBefore);
    assert.ok(result.warnings.some((w) => w.includes("preserved non-derived")), "preservation is surfaced");
    // Canonical state bytes untouched.
    assert.equal(
      readFileSync(join(cwd, ".work-state", "features", "x", "state.json"), "utf8"),
      stateContent,
    );
    assert.equal(
      readFileSync(join(cwd, ".work-state", "features", "x", "artifacts", "spec.json"), "utf8"),
      artifactContent,
    );
    assert.deepEqual(leftoverDirs(cwd), []);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

// ── 6. Boundary / symlink rejection and tolerance ────────────────────────────

test("writer: nested v2 replacement during prune stays live and quarantines the old backup", () => {
  const cwd = tmpWorkspace();
  try {
    publishVisualize(cwd, bundle(T0, [{ kind: "feature", pathKey: "old" }]));
    const v1 = bundle(T1, [{ kind: "feature", pathKey: "new" }, { kind: "legacy", pathKey: "nested" }]);
    const v2 = bundle(T2, [{ kind: "feature", pathKey: "new" }, { kind: "cto", pathKey: "newer" }]);
    let raced = false;
    assert.throws(
      () => publishVisualize(cwd, v1, {
        hooks: {
          onBeforePrune: () => {
            if (raced) return;
            raced = true;
            publishVisualize(cwd, v2);
          },
        },
      }),
      (error: unknown) => error instanceof VisualizePublishError && error.code === "swap-failed",
    );
    assert.equal(raced, true, "the nested prune race must execute");
    for (const file of v2) assert.equal(readTarget(cwd, file.relPath), file.content, `newer nested bundle remains at ${file.relPath}`);
    const backups = leftoverDirs(cwd).filter((name) => name.startsWith(".visualize-backup-"));
    assert.equal(backups.length, 1, "the older captured tree remains quarantined");
    assert.equal(readFileSync(join(cwd, ".work-state", backups[0]!, VISUALIZE_OUTPUT_FILES.manifest), "utf8"), manifest(T0));
    assert.deepEqual(leftoverDirs(cwd).filter((name) => name.startsWith(".visualize-staging-")), []);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("writer: rejects symlinked targets and non-directory destinations without touching them", () => {
  const cwd = tmpWorkspace();
  try {
    const outside = join(cwd, "outside");
    mkdirSync(outside);
    const target = join(cwd, ".work-state", "visualize");
    mkdirSync(join(cwd, ".work-state"));
    symlinkSync(outside, target, "dir");
    const files = bundle(T1, [{ kind: "feature", pathKey: "alpha" }]);
    assertErrorCode(() => publishVisualize(cwd, files), "destination-conflict");
    assert.equal(lstatSync(target).isSymbolicLink(), true, "symlink untouched");
    assert.deepEqual(leftoverDirs(cwd), []);
    assert.equal(existsSync(join(outside, "index.md")), false, "nothing written through the symlink");

    // A plain file at the destination is rejected too, and left untouched.
    rmSync(target, { force: true });
    writeFileSync(target, "occupied");
    assertErrorCode(() => publishVisualize(cwd, files), "destination-conflict");
    assert.equal(readFileSync(target, "utf8"), "occupied", "user file untouched");
    assert.deepEqual(leftoverDirs(cwd), []);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("writer: a symlinked .work-state root stays within the real boundary (no false escape)", () => {
  const cwd = tmpWorkspace();
  try {
    const real = join(cwd, "real-ws");
    mkdirSync(real);
    symlinkSync(real, join(cwd, ".work-state"), "dir");
    const files = bundle(T1, [{ kind: "feature", pathKey: "alpha" }]);
    const result = publishVisualize(cwd, files);
    assert.equal(result.status, "published");
    assert.equal(existsSync(join(real, "visualize", "index.md")), true, "published into the real root");
    for (const f of files) assert.equal(readFileSync(join(real, "visualize", f.relPath), "utf8"), f.content);
    assert.deepEqual(leftoverDirs(cwd), []);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("writer: a symlinked sessions entry in the old tree is never followed and cannot escape the new tree", () => {
  const cwd = tmpWorkspace();
  try {
    publishVisualize(cwd, bundle(T1, [{ kind: "feature", pathKey: "alpha" }]));
    // Replace the derived sessions dir with a symlink escaping .work-state.
    const outside = join(cwd, "outside-sessions");
    mkdirSync(join(outside, "feature"), { recursive: true });
    writeFileSync(join(outside, "feature", "planted.md"), "# planted");
    rmSync(join(cwd, VISUALIZE_OUTPUT_ROOT, "sessions"), { recursive: true, force: true });
    symlinkSync(outside, join(cwd, VISUALIZE_OUTPUT_ROOT, "sessions"), "dir");

    const result = publishVisualize(cwd, bundle(T2, [{ kind: "feature", pathKey: "alpha" }]));
    assert.equal(result.status, "published");
    // The new tree's sessions is a real directory holding the regenerated page.
    assert.equal(lstatSync(join(cwd, VISUALIZE_OUTPUT_ROOT, "sessions")).isSymbolicLink(), false);
    assert.equal(readTarget(cwd, "sessions/feature/alpha.md"), "# alpha @ 2026-08-19T11:00:00.000Z");
    // The escape target was never written through.
    assert.equal(readFileSync(join(outside, "feature", "planted.md"), "utf8"), "# planted");
    assert.deepEqual(leftoverDirs(cwd), []);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

// ── 7. Result hygiene: no secrets, no absolute paths ─────────────────────────

test("writer: the result never leaks content, secrets or absolute paths", () => {
  const cwd = tmpWorkspace();
  try {
    const secret = "sk-super-secret-123456";
    const files = bundle(T1, [{ kind: "feature", pathKey: "alpha" }]);
    files[0] = { ...files[0]!, content: `# Hub ${secret}` };
    const result = publishVisualize(cwd, files);
    const serialized = JSON.stringify(result);
    assert.equal(serialized.includes(secret), false, "no secrets in the result");
    assert.equal(serialized.includes(cwd), false, "no absolute paths in the result");
    assertRelativeOnly(result);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

// ── 8. Repeated publishes expose one complete winner and clean up ────────────

test("writer: repeated publishes always leave exactly one complete bundle and no scratch dirs", () => {
  const cwd = tmpWorkspace();
  try {
    const rounds = [
      bundle(T0, [{ kind: "feature", pathKey: "alpha" }]),
      bundle(T1, [{ kind: "feature", pathKey: "alpha" }]),
      bundle(T2, [{ kind: "cto", pathKey: "final" }]),
    ];
    for (const files of rounds) {
      const result = publishVisualize(cwd, files);
      assert.equal(result.status, "published");
      assert.deepEqual(leftoverDirs(cwd), []);
      assertModes(join(cwd, VISUALIZE_OUTPUT_ROOT));
      assert.equal(walkFiles(join(cwd, VISUALIZE_OUTPUT_ROOT)).length, files.length, "tree is exactly the bundle");
    }
    // The last round is fully live; earlier-only pages are gone.
    const last = rounds[2]!;
    for (const f of last) assert.equal(readTarget(cwd, f.relPath), f.content);
    assert.equal(existsSync(join(cwd, VISUALIZE_OUTPUT_ROOT, "sessions", "feature", "alpha.md")), false);
    assert.equal(existsSync(join(cwd, VISUALIZE_OUTPUT_ROOT, "sessions", "cto", "final.md")), true);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("writer: pinned publication fails closed for root and ancestor swaps at every irreversible boundary", () => {
  const files = bundle(T1, [{ kind: "feature", pathKey: "alpha" }]);
  const phases = ["after-snapshots", "mkdir", "temp-write", "rename", "tree-rename"] as const;
  for (const phase of phases) {
    const container = tmpWorkspace();
    const cwd = phase === "after-snapshots" ? container : join(container, "project");
    if (phase !== "after-snapshots") mkdirSync(cwd);
    const displacedPath = phase === "mkdir" ? container : cwd;
    let displaced: string | null = null;
    let replacement: string | null = null;
    const swap = (): void => {
      if (displaced !== null) return;
      displaced = `${displacedPath}.displaced`;
      if (displacedPath === container) {
        renameSync(container, displaced);
        mkdirSync(container);
        replacement = cwd;
        if (replacement !== container) mkdirSync(cwd);
      } else {
        renameSync(cwd, displaced);
        mkdirSync(cwd);
        replacement = cwd;
      }
    };
    let triggered = false;
    const pin = phase === "after-snapshots"
      ? null
      : PinnedProjectRoot.open(cwd, {
        beforeDirectoryCreate: (relativePath) => {
          if (phase === "mkdir" && relativePath.includes(".visualize-staging-") && !triggered) {
            triggered = true;
            swap();
          }
        },
        beforeTempOpen: () => {
          if (phase === "temp-write" && !triggered) {
            triggered = true;
            swap();
          }
        },
        beforeRename: () => {
          if (phase === "rename" && !triggered) {
            triggered = true;
            swap();
          }
        },
      });
    try {
      let error: unknown;
      try {
        if (phase === "after-snapshots") {
          publishVisualize(cwd, files, { hooks: { onStagingCreated: () => swap() } });
        } else {
          const options = phase === "tree-rename"
            ? { hooks: { onBeforeSwap: () => { triggered = true; swap(); } } }
            : {};
          publishVisualizePinned(cwd, files, pin, options);
        }
      } catch (caught) {
        error = caught;
      }
      assert.ok(error instanceof VisualizePublishError, `${phase} must fail closed`);
      assert.ok(triggered || phase === "after-snapshots", `${phase} race seam was exercised`);
      assert.ok(replacement !== null);
      assert.deepEqual(readdirSync(replacement!), [], `${phase} replacement stayed untouched`);
      assert.equal(existsSync(join(replacement!, VISUALIZE_OUTPUT_ROOT)), false, `${phase} no mixed target`);
    } finally {
      pin?.close();
      if (displaced !== null) {
        restoreDisplaced(displacedPath, displaced);
      }
      rmSync(container, { recursive: true, force: true });
    }
  }
});

test("writer: output-directory and staged-leaf symlink swaps never escape or publish mixed output", () => {
  const files = bundle(T1, [{ kind: "feature", pathKey: "alpha" }]);

  const outputRoot = tmpWorkspace();
  const outputOutside = mkdtempSync(join(tmpdir(), "viz-output-outside-"));
  try {
    const outputTarget = join(outputRoot, VISUALIZE_OUTPUT_ROOT);
    assert.throws(
      () =>
        publishVisualize(outputRoot, files, {
          hooks: {
            onBeforeSwap: () => {
              symlinkSync(outputOutside, outputTarget, "dir");
            },
          },
        }),
      (error: unknown) => error instanceof VisualizePublishError && error.code === "swap-failed",
    );
    assert.equal(lstatSync(outputTarget).isSymbolicLink(), true);
    assert.deepEqual(readdirSync(outputOutside), [], "output-dir replacement stayed untouched");
    assert.equal(existsSync(join(outputOutside, "index.md")), false);
  } finally {
    rmSync(outputRoot, { recursive: true, force: true });
    rmSync(outputOutside, { recursive: true, force: true });
  }

  const leafRoot = tmpWorkspace();
  const leafOutside = mkdtempSync(join(tmpdir(), "viz-leaf-outside-"));
  try {
    assert.throws(
      () =>
        publishVisualize(leafRoot, files, {
          hooks: {
            onBeforeSwap: (staging) => {
              const leaf = join(staging, "index.md");
              unlinkSync(leaf);
              symlinkSync(leafOutside, leaf, "file");
            },
          },
        }),
      (error: unknown) => error instanceof VisualizePublishError && error.code === "swap-failed",
    );
    assert.equal(existsSync(join(leafRoot, VISUALIZE_OUTPUT_ROOT)), false, "leaf swap did not publish target");
    assert.deepEqual(readdirSync(leafOutside), [], "staged-leaf replacement stayed untouched");
  } finally {
    rmSync(leafRoot, { recursive: true, force: true });
    rmSync(leafOutside, { recursive: true, force: true });
  }
});

test("writer: root replacement during prune is rejected without writing into the replacement", () => {
  const cwd = tmpWorkspace();
  const displaced = `${cwd}.displaced`;
  let swapped = false;
  try {
    publishVisualize(cwd, bundle(T0, [{ kind: "feature", pathKey: "old" }]));
    assert.throws(
      () =>
        publishVisualize(cwd, bundle(T1, [{ kind: "feature", pathKey: "new" }]), {
          hooks: {
            onBeforePrune: () => {
              if (swapped) return;
              swapped = true;
              renameSync(cwd, displaced);
              mkdirSync(cwd);
            },
          },
        }),
      (error: unknown) => error instanceof VisualizePublishError && error.code === "boundary-escape",
    );
    assert.equal(swapped, true);
    assert.deepEqual(readdirSync(cwd), [], "prune replacement stayed untouched");
    assert.equal(existsSync(join(cwd, VISUALIZE_OUTPUT_ROOT)), false, "prune replacement has no mixed target");
  } finally {
    if (swapped) restoreDisplaced(cwd, displaced);
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("writer: prune rejects output-directory and leaf symlink swaps without clobbering the replacement", () => {
  const cases = ["output-directory", "leaf"] as const;
  for (const kind of cases) {
    const cwd = tmpWorkspace();
    const outside = mkdtempSync(join(tmpdir(), `viz-prune-${kind}-outside-`));
    try {
      publishVisualize(cwd, bundle(T0, [{ kind: "feature", pathKey: "old" }]));
      const target = join(cwd, VISUALIZE_OUTPUT_ROOT);
      assert.throws(
        () =>
          publishVisualize(cwd, bundle(T1, [{ kind: "feature", pathKey: "new" }]), {
            hooks: {
              onBeforePrune: () => {
                if (kind === "output-directory") {
                  rmSync(target, { recursive: true, force: true });
                  symlinkSync(outside, target, "dir");
                } else {
                  const leaf = join(target, "index.md");
                  unlinkSync(leaf);
                  symlinkSync(outside, leaf, "file");
                }
              },
            },
          }),
        (error: unknown) => error instanceof VisualizePublishError && error.code === "swap-failed",
      );
      if (kind === "output-directory") {
        assert.equal(lstatSync(target).isSymbolicLink(), true, "the replacement output directory remains in place");
      } else {
        assert.equal(lstatSync(join(target, "index.md")).isSymbolicLink(), true, "the replacement leaf remains in place");
      }
      assert.deepEqual(readdirSync(outside), [], `${kind} replacement stayed untouched`);
      assert.ok(leftoverDirs(cwd).some((name) => name.startsWith(".visualize-backup-")), `${kind} stale backup remains quarantined`);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  }
});

test("writer: borrowed pinned publisher leaves the caller-owned root open", () => {
  const cwd = tmpWorkspace();
  const pin = PinnedProjectRoot.open(cwd);
  assert.ok(pin);
  try {
    const result = publishVisualizePinned(cwd, bundle(T1, [{ kind: "feature", pathKey: "alpha" }]), pin);
    assert.equal(result.status, "published");
    assert.equal(pin.isStable(), true, "borrowed pin remains open after publication");
    assert.equal(pin.pathEntryInfo(".work-state/visualize/index.md")?.kind, "file");
  } finally {
    pin.close();
    rmSync(cwd, { recursive: true, force: true });
  }
});
