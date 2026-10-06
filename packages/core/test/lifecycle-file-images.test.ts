import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, writeFileSync, readFileSync, rmSync, openSync, closeSync, ftruncateSync, readdirSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { beginLifecycleTransaction, commitLifecycleTransaction, recoverLifecycleTransactions } from "../src/engine/lifecycle-journal.js";
import { lifecycleFileDigest } from "../src/engine/lifecycle-files.js";

function fixture() { return mkdtempSync(join(tmpdir(), "lifecycle-blobs-")); }
function reference(root: string, path: string) { return { encoding: "file" as const, path: relative(root, path), ...lifecycleFileDigest(path) }; }

test("file images preserve large binary bytes without relying on mutable originals", () => {
  const root = fixture();
  try {
    const source = join(root, "candidate.apk");
    const fd = openSync(source, "w"); ftruncateSync(fd, 16 * 1024 * 1024); closeSync(fd);
    const expected = reference(root, source);
    const target = join(root, "revision.apk");
    const tx = beginLifecycleTransaction({ cwd: root, operation: "rework", before: { [target]: null }, after: { [target]: expected } });
    writeFileSync(source, "changed producer file");
    commitLifecycleTransaction(root, tx.transaction_id);
    assert.deepEqual(lifecycleFileDigest(target), { sha256: expected.sha256, size: expected.size });
    writeFileSync(target, "newer result");
    recoverLifecycleTransactions(root);
    assert.equal(readFileSync(target, "utf8"), "newer result");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("prepared rollback preserves independent updates; committing recovery uses pinned blobs", () => {
  const root = fixture();
  try {
    const source = join(root, "source"); writeFileSync(source, "original evidence");
    const target = join(root, "target"); writeFileSync(target, "old");
    const tx = beginLifecycleTransaction({ cwd: root, operation: "rework", before: { [target]: "old" }, after: { [target]: reference(root, source) } });
    writeFileSync(target, "independent update"); recoverLifecycleTransactions(root);
    assert.equal(readFileSync(target, "utf8"), "independent update");
    const next = beginLifecycleTransaction({ cwd: root, operation: "rework", before: { [target]: "independent update" }, after: { [target]: reference(root, source) } });
    const record = join(root, ".work-state/lifecycle-transactions", next.transaction_id, "transaction.json");
    writeFileSync(record, JSON.stringify({ ...next, status: "committing", commit_marker: "crash-marker" }));
    rmSync(source); recoverLifecycleTransactions(root);
    assert.equal(readFileSync(target, "utf8"), "original evidence");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("tampered and symlinked lifecycle blobs fail closed before publication", () => {
  for (const symlink of [false, true]) {
    const root = fixture();
    try {
      const source = join(root, "source"); writeFileSync(source, "evidence");
      const target = join(root, "target");
      const tx = beginLifecycleTransaction({ cwd: root, operation: "rework", before: { [target]: null }, after: { [target]: reference(root, source) } });
      const blobs = join(root, ".work-state/lifecycle-transactions", tx.transaction_id, "blobs");
      const blob = join(blobs, readdirSync(blobs)[0]);
      if (symlink) { rmSync(blob); symlinkSync(source, blob); } else writeFileSync(blob, "tampered");
      assert.throws(() => commitLifecycleTransaction(root, tx.transaction_id), /integrity|symlink/);
      assert.throws(() => readFileSync(target), /ENOENT/);
    } finally { rmSync(root, { recursive: true, force: true }); }
  }
});
