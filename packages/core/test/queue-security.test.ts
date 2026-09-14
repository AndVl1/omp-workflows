import { createHash } from "node:crypto";
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BoundedQueueError, openBoundedQueue } from "../src/specification/queue.js";
import { PinnedProjectRoot, PinnedRootError } from "../src/specification/pinned-root.js";

function tempRoot(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function removeRoot(root: string): void {
  rmSync(root, { recursive: true, force: true });
}

test("bounded queue rejects a symlinked queue directory without touching its target", () => {
  const root = tempRoot("queue-dir-link-");
  const outside = tempRoot("queue-dir-outside-");
  try {
    mkdirSync(join(root, ".omp"), { recursive: true });
    writeFileSync(join(outside, "sentinel"), "outside");
    symlinkSync(outside, join(root, ".omp", "inbox"), "dir");
    assert.throws(() => openBoundedQueue(root, join(".omp", "inbox")), (error: unknown) => {
      return error instanceof BoundedQueueError && ["path_unauthorized", "not_directory", "write_failed"].includes(error.code);
    });
    assert.equal(readFileSync(join(outside, "sentinel"), "utf8"), "outside");
  } finally {
    removeRoot(root);
    removeRoot(outside);
  }
});

test("bounded queue rejects a symlink leaf and never reads outside", () => {
  const root = tempRoot("queue-leaf-link-");
  const outside = tempRoot("queue-leaf-outside-");
  const queue = openBoundedQueue(root, join(".omp", "inbox"));
  assert.ok(queue);
  try {
    writeFileSync(join(outside, "secret"), "must-not-read");
    symlinkSync(join(outside, "secret"), join(root, ".omp", "inbox", "task.json"));
    assert.throws(() => queue.read("task.json"), (error: unknown) => {
      return error instanceof BoundedQueueError && ["path_unauthorized", "not_regular", "write_failed"].includes(error.code);
    });
    assert.equal(readFileSync(join(outside, "secret"), "utf8"), "must-not-read");
  } finally {
    queue.close();
    removeRoot(root);
    removeRoot(outside);
  }
});

test("bounded queue reads a FIFO without blocking", () => {
  const root = tempRoot("queue-fifo-");
  const queue = openBoundedQueue(root, join(".omp", "inbox"));
  assert.ok(queue);
  try {
    const fifo = join(root, ".omp", "inbox", "task.json");
    execFileSync("mkfifo", [fifo]);
    const started = Date.now();
    assert.throws(() => queue.read("task.json"), (error: unknown) => {
      return error instanceof BoundedQueueError && ["not_regular", "path_unauthorized", "write_failed"].includes(error.code);
    });
    assert.ok(Date.now() - started < 1_000, "FIFO read completed within the bounded interval");
  } finally {
    queue.close();
    removeRoot(root);
  }
});

test("bounded queue rejects oversized entries before JSON parsing", () => {
  const root = tempRoot("queue-oversize-");
  const queue = openBoundedQueue(root, join(".omp", "inbox"), { maxEntryBytes: 1024 });
  assert.ok(queue);
  try {
    writeFileSync(join(root, ".omp", "inbox", "large.json"), "x".repeat(2_048));
    assert.throws(() => queue.readJson("large.json"), (error: unknown) => error instanceof BoundedQueueError && error.code === "write_failed");
  } finally {
    queue.close();
    removeRoot(root);
  }
});

test("bounded queue paginates 65 entries without poisoning progress", () => {
  const root = tempRoot("queue-flood-");
  const queue = openBoundedQueue(root, join(".omp", "inbox"), { maxEntries: 64, maxWork: 512 });
  assert.ok(queue);
  try {
    for (let index = 0; index < 65; index += 1) {
      writeFileSync(join(root, ".omp", "inbox", `task-${String(index).padStart(3, "0")}.json`), "{}");
    }
    const names: string[] = [];
    let cursor: string | null = null;
    for (let pageIndex = 0; pageIndex < 8; pageIndex += 1) {
      const page = queue.listPage(cursor);
      assert.ok(page.entries.length > 0, "every non-terminal page makes progress");
      assert.ok(page.entries.length <= 64);
      names.push(...page.entries.map((entry) => entry.name));
      if (page.nextCursor === null) break;
      cursor = page.nextCursor;
    }
    assert.equal(names.length, 65);
    assert.deepEqual(names, Array.from({ length: 65 }, (_, index) => `task-${String(index).padStart(3, "0")}.json`));
  } finally {
    queue.close();
    removeRoot(root);
  }
});

test("bounded queue listings fail closed on unsafe raw entry names", () => {
  if (process.platform === "win32") return;
  const root = tempRoot("queue-unsafe-entry-");
  const queue = openBoundedQueue(root, join(".omp", "inbox"));
  assert.ok(queue);
  const safePath = join(root, ".omp", "inbox", "safe.json");
  const unsafePath = join(root, ".omp", "inbox", "unsafe\\entry");
  try {
    writeFileSync(safePath, "safe");
    writeFileSync(unsafePath, "unsafe");
    assert.throws(
      () => queue.list(),
      (error: unknown) => error instanceof BoundedQueueError && error.code === "path_unauthorized",
    );
    assert.throws(
      () => queue.listPage(),
      (error: unknown) => error instanceof BoundedQueueError && error.code === "path_unauthorized",
    );
    assert.equal(readFileSync(unsafePath, "utf8"), "unsafe", "listing must not mutate the unsafe entry");
    assert.equal(readFileSync(safePath, "utf8"), "safe", "listing must not mutate safe entries");
  } finally {
    queue.close();
    removeRoot(root);
  }
});

test("destructive queue drains hundreds with bounded iterator batches", () => {
  const root = tempRoot("queue-drain-");
  const queue = openBoundedQueue(root, join(".omp", "inbox"), { maxEntries: 64, maxWork: 4 * 1024 });
  assert.ok(queue);
  try {
    const total = 257;
    for (let index = 0; index < total; index += 1) {
      writeFileSync(join(root, ".omp", "inbox", "task-" + String(index).padStart(3, "0") + ".json"), "{}");
    }
    let removed = 0;
    for (let tick = 0; tick < 16; tick += 1) {
      const batch = queue.list();
      if (batch.length === 0) break;
      assert.ok(batch.length <= 64, "one destructive tick stays within the entry cap");
      for (const entry of batch) {
        const observed = queue.read(entry.name);
        queue.remove(entry.name, {
          dev: observed.dev,
          ino: observed.ino,
          sha256: createHash("sha256").update(observed.bytes).digest("hex"),
        });
        removed += 1;
      }
    }
    assert.equal(removed, total, "repeated bounded batches eventually drain the queue");
    assert.deepEqual(queue.list(), []);
  } finally {
    queue.close();
    removeRoot(root);
  }
});

test("4097-entry queue drains with each iterator batch capped", () => {
  const root = tempRoot("queue-drain-4097-");
  const queue = openBoundedQueue(root, join(".omp", "inbox"), { maxEntries: 64, maxWork: 4 * 1024 });
  assert.ok(queue);
  try {
    const total = 4097;
    const inbox = join(root, ".omp", "inbox");
    for (let index = 0; index < total; index += 1) {
      writeFileSync(join(inbox, "task-" + String(index).padStart(4, "0") + ".json"), "{}");
    }
    let remaining = total;
    for (let tick = 0; tick < 100; tick += 1) {
      const batch = queue.list();
      if (batch.length === 0) break;
      assert.ok(batch.length > 0 && batch.length <= 64, "each iterator batch is nonzero and capped");
      assert.ok(batch.length <= remaining, "a batch cannot exceed the remaining queue");
      for (const entry of batch) unlinkSync(entry.relativePath);
      remaining -= batch.length;
      assert.equal(readdirSync(inbox).length, remaining, "one tick removes exactly its returned batch");
    }
    assert.equal(remaining, 0, "bounded iterator batches eventually drain 4097 entries");
    assert.deepEqual(queue.list(), []);
  } finally {
    queue.close();
    removeRoot(root);
  }
});

test("bounded queue discards mixed junk batches while preserving a valid entry", () => {
  const root = tempRoot("queue-discard-mixed-");
  const outside = tempRoot("queue-discard-outside-");
  const queue = openBoundedQueue(root, join(".omp", "inbox"), { maxEntries: 64, maxWork: 4 * 1024 });
  assert.ok(queue);
  try {
    const inbox = join(root, ".omp", "inbox");
    const rejected = join(root, ".omp", "inbox-rejected");
    const outsideFile = join(outside, "sentinel");
    writeFileSync(outsideFile, "outside");
    for (let index = 0; index < 40; index += 1) writeFileSync(join(inbox, `junk-malformed-${String(index).padStart(2, "0")}.json`), "{");
    for (let index = 0; index < 10; index += 1) writeFileSync(join(inbox, `junk-nonjson-${String(index).padStart(2, "0")}`), "junk");
    for (let index = 0; index < 5; index += 1) symlinkSync(outsideFile, join(inbox, `junk-link-${String(index).padStart(2, "0")}.json`));
    for (let index = 0; index < 5; index += 1) mkdirSync(join(inbox, `junk-empty-${String(index).padStart(2, "0")}.json`));
    for (let index = 0; index < 5; index += 1) {
      const directory = join(inbox, `junk-nonempty-${String(index).padStart(2, "0")}.json`);
      mkdirSync(directory);
      writeFileSync(join(directory, "keep"), "keep");
    }
    writeFileSync(join(inbox, "valid.json"), "{\"ok\":true}");

    const discarded: string[] = [];
    for (let tick = 0; tick < 8; tick += 1) {
      const batch = queue.list();
      if (batch.length === 0) break;
      for (const entry of batch) {
        if (entry.name === "valid.json") continue;
        try {
          queue.discard(entry.name, queue.classify(entry.name), join(".omp", "inbox-rejected"));
          discarded.push(entry.name);
        } catch (error) {
          if (error instanceof BoundedQueueError && error.code === "not_regular") continue;
          throw error;
        }
      }
    }
    assert.equal(discarded.length, 50, "all regular junk entries are processed across bounded batches");
    assert.deepEqual(queue.list().map((entry) => entry.name).sort(), [
      "junk-empty-00.json", "junk-empty-01.json", "junk-empty-02.json", "junk-empty-03.json", "junk-empty-04.json",
      "junk-link-00.json", "junk-link-01.json", "junk-link-02.json", "junk-link-03.json", "junk-link-04.json",
      "junk-nonempty-00.json", "junk-nonempty-01.json", "junk-nonempty-02.json", "junk-nonempty-03.json", "junk-nonempty-04.json",
      "valid.json",
    ].sort());
    assert.equal(queue.readJson<{ ok: boolean }>("valid.json").ok, true);
    assert.equal(readdirSync(rejected).length, 50, "only regular entries are quarantined through the safe batch primitive");
    assert.equal(readFileSync(outsideFile, "utf8"), "outside", "symlink targets remain untouched");
  } finally {
    queue.close();
    removeRoot(root);
    removeRoot(outside);
  }
});
test("moveToIfMatches restores its staged inode when a destination winner appears", () => {
  const root = tempRoot("queue-move-race-");
  const queue = openBoundedQueue(root, join(".omp", "inbox"));
  assert.ok(queue);
  if (!queue) return;
  const queueRoot = (queue as unknown as { root: { renameFileExclusive: (source: string, destination: string) => void } }).root;
  const originalRename = queueRoot.renameFileExclusive.bind(queueRoot);
  let stagePath: string | undefined;
  try {
    const source = join(root, ".omp", "inbox", "task.json");
    const destination = join(".omp", "archive", "task.json");
    mkdirSync(join(root, ".omp", "archive"), { recursive: true });
    writeFileSync(source, "old");
    const expected = queue.classify("task.json");
    queueRoot.renameFileExclusive = (sourcePath, destinationPath) => {
      if (sourcePath.endsWith("task.json")) {
        originalRename(sourcePath, destinationPath);
        stagePath = destinationPath;
        return;
      }
      writeFileSync(join(root, destination), "winner");
      originalRename(sourcePath, destinationPath);
    };
    assert.throws(() => queue.moveToIfMatches("task.json", expected, destination), (error: unknown) => error instanceof BoundedQueueError && error.code === "exists");
    assert.ok(stagePath, "the source must have a durable operation stage");
    assert.equal(existsSync(join(root, stagePath!)), false, "stage is not stranded after restore");
    assert.equal(readFileSync(join(root, destination), "utf8"), "winner");
    assert.equal(existsSync(source), true, "the exact source is restored when destination publication loses the race");
    assert.equal(readFileSync(source, "utf8"), "old");
  } finally {
    queueRoot.renameFileExclusive = originalRename;
    queue.close();
    removeRoot(root);
  }
});

test("discardBatch restores its staged inode when a destination winner appears", () => {
  const root = tempRoot("queue-discard-move-race-");
  const queue = openBoundedQueue(root, join(".omp", "inbox"));
  assert.ok(queue);
  if (!queue) return;
  const queueRoot = (queue as unknown as { root: { renameFileExclusive: (source: string, destination: string) => void } }).root;
  const originalRename = queueRoot.renameFileExclusive.bind(queueRoot);
  let stagePath: string | undefined;
  let winnerPath: string | undefined;
  let injected = false;
  try {
    const source = join(root, ".omp", "inbox", "junk.json");
    const rejected = join(".omp", "rejected");
    writeFileSync(source, "old");
    const expected = queue.classify("junk.json");
    queueRoot.renameFileExclusive = (sourcePath, destinationPath) => {
      if (sourcePath.endsWith("junk.json")) {
        originalRename(sourcePath, destinationPath);
        stagePath = destinationPath;
        return;
      }
      if (!injected) {
        injected = true;
        winnerPath = destinationPath;
        writeFileSync(join(root, destinationPath), "winner");
      }
      originalRename(sourcePath, destinationPath);
    };
    assert.throws(() => queue.discardBatch([{ name: "junk.json", expected }], rejected), (error: unknown) => error instanceof BoundedQueueError && error.code === "exists");
    assert.ok(stagePath, "the source must have a durable operation stage");
    assert.ok(winnerPath, "the destination race must run");
    assert.equal(existsSync(join(root, stagePath!)), false, "stage is not stranded after restore");
    assert.equal(readFileSync(join(root, winnerPath!), "utf8"), "winner");
    assert.equal(existsSync(source), true, "the exact source is restored when destination publication loses the race");
    assert.equal(readFileSync(source, "utf8"), "old");
  } finally {
    queueRoot.renameFileExclusive = originalRename;
    queue.close();
    removeRoot(root);
  }
});

test("moveToIfMatches returns typed recovery when a source winner appears", () => {
  const root = tempRoot("queue-move-recovery-");
  const queue = openBoundedQueue(root, join(".omp", "inbox"));
  assert.ok(queue);
  if (!queue) return;
  const queueRoot = (queue as unknown as { root: { renameFileExclusive: (source: string, destination: string) => void } }).root;
  const originalRename = queueRoot.renameFileExclusive.bind(queueRoot);
  let stagePath: string | undefined;
  let injected = false;
  try {
    const source = join(root, ".omp", "inbox", "task.json");
    const destination = join(".omp", "archive", "task.json");
    mkdirSync(join(root, ".omp", "archive"), { recursive: true });
    writeFileSync(source, "old");
    const expected = queue.classify("task.json");
    queueRoot.renameFileExclusive = (sourcePath, destinationPath) => {
      if (sourcePath.endsWith("task.json")) {
        originalRename(sourcePath, destinationPath);
        stagePath = destinationPath;
        return;
      }
      if (!injected) {
        injected = true;
        writeFileSync(source, "source-winner");
        writeFileSync(join(root, destination), "destination-winner");
      }
      originalRename(sourcePath, destinationPath);
    };
    assert.throws(() => queue.moveToIfMatches("task.json", expected, destination), (error: unknown) => error instanceof BoundedQueueError && error.code === "recovery_required");
    assert.ok(stagePath);
    assert.equal(readFileSync(source, "utf8"), "source-winner");
    assert.equal(readFileSync(join(root, destination), "utf8"), "destination-winner");
    const recovery = readdirSync(join(root, ".omp", "inbox")).find((name) => name.startsWith(".queue-recovery-"));
    assert.ok(recovery, "the expected stage is named for explicit recovery");
    assert.equal(readFileSync(join(root, ".omp", "inbox", recovery!), "utf8"), "old");
  } finally {
    queueRoot.renameFileExclusive = originalRename;
    queue.close();
    removeRoot(root);
  }
});

test("successful no-clobber move leaves no operation stage", () => {
  const root = tempRoot("queue-move-success-");
  const queue = openBoundedQueue(root, join(".omp", "inbox"));
  assert.ok(queue);
  if (!queue) return;
  try {
    const inbox = join(root, ".omp", "inbox");
    const destination = join(".omp", "archive", "task.json");
    mkdirSync(join(root, ".omp", "archive"), { recursive: true });
    writeFileSync(join(inbox, "task.json"), "payload");
    const expected = queue.classify("task.json");
    queue.moveToIfMatches("task.json", expected, destination);
    assert.equal(readFileSync(join(root, destination), "utf8"), "payload");
    assert.equal(existsSync(join(inbox, "task.json")), false);
    assert.equal(readdirSync(inbox).some((name) => name.startsWith(".queue-move-")), false, "successful publication leaves no stage residue");
  } finally {
    queue.close();
    removeRoot(root);
  }
});

test("single discard preserves a replacement through the safe batch seam", () => {
  const root = tempRoot("queue-discard-race-");
  const queue = openBoundedQueue(root, join(".omp", "inbox"));
  assert.ok(queue);
  if (!queue) return;
  const originalClassify = queue.classify.bind(queue);
  let replaced = false;
  try {
    const inbox = join(root, ".omp", "inbox");
    const rejected = join(".omp", "inbox-rejected");
    writeFileSync(join(inbox, "task.json"), "old");
    const expected = queue.classify("task.json");
    queue.classify = (name) => {
      const classified = originalClassify(name);
      if (!replaced && name === "task.json") {
        replaced = true;
        renameSync(join(root, ".omp", "inbox", "task.json"), join(root, ".omp", "inbox", "task.old"));
        writeFileSync(join(root, ".omp", "inbox", "task.json"), "replacement");
      }
      return classified;
    };
    assert.throws(() => queue.discard("task.json", expected, rejected), (error: unknown) => error instanceof BoundedQueueError && error.code === "changed");
    assert.equal(replaced, true, "the post-classification replacement seam must run");
    assert.equal(existsSync(join(inbox, "task.old")), true, "the original preimage remains available for recovery");
    assert.equal(existsSync(join(inbox, "task.json")), true, "the moved replacement is restored to its source name");
    assert.equal(readFileSync(join(inbox, "task.json"), "utf8"), "replacement");
    assert.equal(readdirSync(inbox).some((name) => name.startsWith(".queue-recovery-")), false, "no recovery artifact is needed when source restoration succeeds");
    assert.equal(readdirSync(join(root, rejected)).length, 0);
  } finally {
    queue.close();
    removeRoot(root);
  }
});

test("discard reports and preserves symlink and directory replacements", () => {
  const root = tempRoot("queue-discard-nonregular-race-");
  const outside = tempRoot("queue-discard-nonregular-outside-");
  const queue = openBoundedQueue(root, join(".omp", "inbox"));
  assert.ok(queue);
  try {
    const inbox = join(root, ".omp", "inbox");
    const outsideFile = join(outside, "sentinel");
    writeFileSync(outsideFile, "outside");

    symlinkSync(outsideFile, join(inbox, "link.json"));
    const linkExpected = queue.classify("link.json");
    unlinkSync(join(inbox, "link.json"));
    mkdirSync(join(inbox, "link.json"));
    assert.throws(() => queue.discard("link.json", linkExpected, join(".omp", "rejected")), (error: unknown) => error instanceof BoundedQueueError && error.code === "changed");
    assert.equal(existsSync(join(inbox, "link.json")), true);

    mkdirSync(join(inbox, "dir.json"));
    const dirExpected = queue.classify("dir.json");
    renameSync(join(inbox, "dir.json"), join(inbox, "dir.old"));
    symlinkSync(outsideFile, join(inbox, "dir.json"));
    assert.throws(() => queue.discard("dir.json", dirExpected, join(".omp", "rejected")), (error: unknown) => error instanceof BoundedQueueError && error.code === "changed");
    assert.equal(existsSync(join(inbox, "dir.old")), true);
    assert.equal(existsSync(join(inbox, "dir.json")), true);
    assert.equal(readFileSync(outsideFile, "utf8"), "outside");
  } finally {
    queue.close();
    removeRoot(root);
    removeRoot(outside);
  }
});

test("bounded discard batches are restart-safe and fail closed on swapped parents", () => {
  const root = tempRoot("queue-discard-batch-");
  const outside = tempRoot("queue-discard-batch-outside-");
  let queue = openBoundedQueue(root, join(".omp", "inbox"), { maxEntries: 64, maxWork: 4 * 1024 });
  assert.ok(queue);
  try {
    const inbox = join(root, ".omp", "inbox");
    const rejected = join(".omp", "inbox-rejected");
    const rejectedPath = join(root, rejected);
    const outsideFile = join(outside, "sentinel");
    writeFileSync(outsideFile, "outside");
    for (let index = 0; index < 130; index += 1) writeFileSync(join(inbox, `junk-${String(index).padStart(3, "0")}.json`), "{");
    symlinkSync(outsideFile, join(inbox, "link.json"));

    let moved = 0;
    for (let tick = 0; tick < 8; tick += 1) {
      const batch = queue.list();
      if (batch.length === 0) break;
      for (const entry of batch) {
        const classified = { name: entry.name, expected: queue.classify(entry.name) };
        try {
          moved += queue.discardBatch([classified], rejected);
        } catch (error) {
          assert.ok(error instanceof BoundedQueueError && error.code === "not_regular", "non-regular entries are reported and retained");
        }
      }
      if (tick === 0) {
        queue.close();
        queue = openBoundedQueue(root, join(".omp", "inbox"), { maxEntries: 64, maxWork: 4 * 1024 });
        assert.ok(queue);
      }
    }
    assert.equal(moved, 130, "all regular entries survive a restart-safe batch drain");
    assert.deepEqual(queue.list().map((entry) => entry.name), ["link.json"]);
    assert.equal(readdirSync(rejectedPath).length, 130);
    assert.equal(readFileSync(outsideFile, "utf8"), "outside", "discarding a symlink never touches its target");

    writeFileSync(join(inbox, "swap.json"), "{");
    const swapExpected = queue.classify("swap.json");
    const omp = join(root, ".omp");
    const movedOmp = omp + ".moved";
    renameSync(omp, movedOmp);
    symlinkSync(outside, omp, "dir");
    assert.throws(() => queue.discardBatch([{ name: "swap.json", expected: swapExpected }], rejected), (error: unknown) => error instanceof BoundedQueueError);
    assert.equal(readFileSync(outsideFile, "utf8"), "outside", "a swapped source parent cannot redirect the discard");
    unlinkSync(omp);
    renameSync(movedOmp, omp);
  } finally {
    queue.close();
    removeRoot(root);
    removeRoot(outside);
  }
});
test("bounded JSON batch distinguishes malformed JSON from literal null", () => {
  const root = tempRoot("queue-read-json-status-");
  const queue = openBoundedQueue(root, join(".omp", "inbox"));
  assert.ok(queue);
  if (!queue) return;
  try {
    const inbox = join(root, ".omp", "inbox");
    writeFileSync(join(inbox, "malformed.json"), "{");
    writeFileSync(join(inbox, "literal-null.json"), "null");
    writeFileSync(join(inbox, "valid.json"), JSON.stringify({ ok: true }));
    const batch = queue.readJsonBatch(["malformed.json", "literal-null.json", "valid.json"]);
    assert.deepEqual(batch.failed, ["malformed.json"]);
    assert.deepEqual(batch.remaining, []);
    assert.equal(batch.records.some((record) => record.name === "malformed.json"), false);
    assert.deepEqual(batch.records.find((record) => record.name === "literal-null.json"), { name: "literal-null.json", value: null });
    assert.deepEqual(batch.records.find((record) => record.name === "valid.json"), { name: "valid.json", value: { ok: true } });
  } finally {
    queue.close();
    removeRoot(root);
  }
});

test("bounded JSON batch reports deferred entries under aggregate content cap", () => {
  const root = tempRoot("queue-read-batch-cap-");
  const queue = openBoundedQueue(root, join(".omp", "inbox"), { maxEntries: 64, maxWork: 4 * 1024, maxEntryBytes: 64 * 1024 });
  assert.ok(queue);
  try {
    const inbox = join(root, ".omp", "inbox");
    const content = JSON.stringify("x".repeat(64 * 1024 - 100));
    for (let index = 0; index < 40; index += 1) writeFileSync(join(inbox, `large-${String(index).padStart(2, "0")}.json`), content);
    const batch = queue.list();
    const read = queue.readJsonBatch(batch.map((entry) => entry.name));
    assert.ok(read.records.length > 0);
    assert.ok(read.remaining.length > 0, "large aggregate content is deferred instead of materialized");
    assert.equal(read.records.length + read.remaining.length + read.failed.length, batch.length);
  } finally {
    queue.close();
    removeRoot(root);
  }
});



test("pinned pathEntryInfo identifies file, directory, symlink, FIFO, and absence without following links", () => {
  const root = tempRoot("queue-entry-info-");
  const outside = tempRoot("queue-entry-info-outside-");
  const pinned = PinnedProjectRoot.open(root);
  assert.ok(pinned);
  try {
    mkdirSync(join(root, "dir"));
    writeFileSync(join(root, "file"), "content");
    writeFileSync(join(outside, "secret"), "outside");
    symlinkSync(join(outside, "secret"), join(root, "link"));
    execFileSync("mkfifo", [join(root, "fifo")]);
    assert.equal(pinned.pathEntryInfo("file")?.kind, "file");
    assert.equal(pinned.pathEntryInfo("file")?.size, 7);
    assert.equal(pinned.pathEntryInfo("dir")?.kind, "directory");
    assert.equal(pinned.pathEntryInfo("link")?.kind, "symlink");
    assert.equal(pinned.pathEntryInfo("fifo")?.kind, "other");
    assert.equal(pinned.pathEntryInfo("missing"), null);
  } finally {
    pinned.close();
    removeRoot(root);
    removeRoot(outside);
  }
});


test("pinned empty-directory removal rejects symlinks/nonempty paths and root swaps", () => {
  const root = tempRoot("queue-rmdir-");
  const outside = tempRoot("queue-rmdir-outside-");
  const pinned = PinnedProjectRoot.open(root);
  assert.ok(pinned);
  try {
    mkdirSync(join(root, "empty"));
    mkdirSync(join(root, "nonempty"));
    writeFileSync(join(root, "nonempty", "child"), "keep");
    mkdirSync(join(outside, "sentinel"));
    symlinkSync(join(outside, "sentinel"), join(root, "link"), "dir");
    pinned.removeEmptyDirectory("empty");
    assert.equal(pinned.pathEntryInfo("empty"), null);
    assert.throws(() => pinned.removeEmptyDirectory("nonempty"), (error: unknown) => error instanceof PinnedRootError);
    assert.throws(() => pinned.removeEmptyDirectory("link"), (error: unknown) => error instanceof PinnedRootError);

    mkdirSync(join(root, "swapped"));
    const moved = root + ".moved";
    renameSync(root, moved);
    symlinkSync(outside, root, "dir");
    // The inherited root descriptor remains pinned to the moved original tree;
    // removal may proceed there, but must never follow the rebound pathname.
    assert.doesNotThrow(() => pinned.removeEmptyDirectory("swapped"));
    assert.equal(existsSync(join(moved, "swapped")), false);
    assert.equal(existsSync(join(outside, "sentinel")), true);
    unlinkSync(root);
    renameSync(moved, root);
  } finally {
    pinned.close();
    removeRoot(root);
    removeRoot(root + ".moved");
    removeRoot(outside);
  }
});



