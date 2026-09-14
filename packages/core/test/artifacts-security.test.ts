import { persistTestArtifacts, readTestArtifact, readTestArtifactSnapshot, writeTestArtifact } from "./fixtures/artifacts.js";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readdirSync, renameSync, rmSync, existsSync, statSync, symlinkSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ArtifactStructureError,
  MAX_ARTIFACT_BYTES,
  normalizeStoredArtifactReference,
  parseArtifactJson,
  persistReturnedArtifactsPinned,
  readArtifactPinned,
  setArtifactReadTestHooks,
  writeArtifactPinned,
  rollbackArtifactAtomicWrite,
  writeArtifactWithReference,
  type ArtifactReferenceAuthorization,
  type ArtifactAtomicWriteRollbackToken,
} from "../src/engine/artifacts.js";
import { PinnedProjectRoot, PinnedRootError } from "../src/specification/pinned-root.js";

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function fixture(): { root: string; artifactsDir: string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), "artifact-snapshot-"));
  const artifactsDir = join(root, ".work-state", "features", "race", "artifacts");

  mkdirSync(artifactsDir, { recursive: true });
  return { root, artifactsDir, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

function serializedBytes(value: unknown): number {
  return Buffer.byteLength(`${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function valueNearArtifactByteCap(): { value: { first: string; second: string }; bytes: number } {
  let low = 0;
  let high = Math.ceil(MAX_ARTIFACT_BYTES / 6);
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    const value = { first: `é${"\u0000".repeat(middle)}`, second: `é${"\u0000".repeat(middle)}` };
    if (serializedBytes(value) <= MAX_ARTIFACT_BYTES) low = middle;
    else high = middle - 1;
  }
  const value = { first: `é${"\u0000".repeat(low)}`, second: `é${"\u0000".repeat(low)}` };
  return { value, bytes: serializedBytes(value) };
}

test("public artifact writer accepts a readable multibyte payload near the byte cap", () => {
  const { root, artifactsDir, cleanup } = fixture();
  try {
    const near = valueNearArtifactByteCap();
    assert.ok(near.bytes <= MAX_ARTIFACT_BYTES);
    assert.ok(near.bytes > MAX_ARTIFACT_BYTES - 32);
    const path = writeTestArtifact(root, artifactsDir, "near", near.value);
    assert.equal(statSync(path).size, near.bytes);
    const loaded = readTestArtifact<{ first: string; second: string }>(root, artifactsDir, "near");
    assert.equal(loaded?.first, near.value.first);
    assert.equal(loaded?.second, near.value.second);

    const oversized = { ...near.value, first: `${near.value.first}${"\u0000".repeat(4)}` };
    assert.throws(
      () => writeTestArtifact(root, artifactsDir, "over", oversized),
      (error: unknown) => error instanceof PinnedRootError && error.code === "invalid",
    );
    assert.equal(readTestArtifact(root, artifactsDir, "over"), null);
  } finally {
    cleanup();
  }
});

test("public generic artifact writer binds an unpinned root and rejects a foreign pinned root", () => {
  const { root, artifactsDir, cleanup } = fixture();
  const foreignRoot = mkdtempSync(join(tmpdir(), "artifact-writer-foreign-"));
  const pinned = PinnedProjectRoot.open(root);
  assert.ok(pinned, "bound writer fixture root must be pinnable");
  if (!pinned) {
    rmSync(foreignRoot, { recursive: true, force: true });
    cleanup();
    return;
  }
  try {
    const unbound = writeArtifactWithReference(
      root,
      artifactsDir,
      "unbound-public",
      { value: "bound-by-writer" },
      { schema_status: "met", quality_gate_status: "met" },
    );
    assert.equal(unbound.path, ".work-state/features/race/artifacts/unbound-public.json");
    assert.deepEqual(readArtifactPinned(pinned, ".work-state/features/race/artifacts", "unbound-public"), { value: "bound-by-writer" });

    const foreignArtifacts = join(foreignRoot, "artifacts");
    mkdirSync(foreignArtifacts, { recursive: true });
    assert.throws(
      () => writeArtifactWithReference(
        foreignRoot,
        foreignArtifacts,
        "foreign-bound",
        { value: "must-not-write" },
        { schema_status: "met", quality_gate_status: "met" },
        { pinnedRoot: pinned },
      ),
      (error: unknown) => error instanceof PinnedRootError && error.code === "path_unauthorized",
    );
    assert.equal(existsSync(join(foreignArtifacts, "foreign-bound.json")), false, "a borrowed pin must reject a foreign root before writing");
  } finally {
    pinned.close();
    rmSync(foreignRoot, { recursive: true, force: true });
    cleanup();
  }
});

test("descriptor-bound callback rollback preserves a concurrent same-content replacement", () => {
  const { root, artifactsDir, cleanup } = fixture();
  const pinned = PinnedProjectRoot.open(root);
  assert.ok(pinned, "descriptor fixture root must be pinnable");
  if (!pinned) return;
  const originalWrite = PinnedProjectRoot.prototype.writeAtomicWithReceipt;
  let replaced = false;
  try {
    PinnedProjectRoot.prototype.writeAtomicWithReceipt = function (relativePath, content, options) {
      const receipt = originalWrite.call(this, relativePath, content, options);
      if (!replaced && relativePath.endsWith("descriptor-race.json")) {
        replaced = true;
        const concurrentPath = join(root, "artifacts", "descriptor-race.concurrent");
        mkdirSync(join(root, "artifacts"), { recursive: true });
        writeFileSync(concurrentPath, content);
        renameSync(concurrentPath, join(root, relativePath));
      }
      return receipt;
    };
    assert.throws(
      () => writeArtifactPinned(pinned, "artifacts", "descriptor-race", { value: "same" }, { onWritten: () => { throw new Error("callback failure"); } }),
      /callback failure/,
    );
    assert.equal(replaced, true, "the replacement seam must execute after the owned write descriptor is returned");
    assert.deepEqual(JSON.parse(readFileSync(join(root, "artifacts", "descriptor-race.json"), "utf8")), { value: "same" }, "rollback must not remove a same-content concurrent replacement with a different inode");
  } finally {
    PinnedProjectRoot.prototype.writeAtomicWithReceipt = originalWrite;
    pinned.close();
    cleanup();
  }
});

test("content-addressed receipt conversion failure rolls back its publication", () => {
  const { root, artifactsDir, cleanup } = fixture();
  const pinned = PinnedProjectRoot.open(root);
  assert.ok(pinned, "receipt conversion fixture root must be pinnable");
  if (!pinned) return;
  const originalWrite = PinnedProjectRoot.prototype.writeExclusiveWithReceipt;
  try {
    PinnedProjectRoot.prototype.writeExclusiveWithReceipt = function (relativePath, content, options) {
      const receipt = originalWrite.call(this, relativePath, content, options);
      return { ...receipt, relative_path: `.forged` };
    };
    assert.throws(
      () => writeArtifactWithReference(
        root,
        artifactsDir,
        "implementation-conformance.receipt-conversion",
        { schema_version: 1, conformance_id: "receipt-conversion" },
        { schema_status: "met", quality_gate_status: "met" },
        { pinnedRoot: pinned },
      ),
      (error: unknown) => error instanceof PinnedRootError && error.code === "changed",
    );
    assert.equal(existsSync(join(artifactsDir, "implementation-conformance.receipt-conversion.json")), false, "conversion failure must roll back the published artifact");
  } finally {
    PinnedProjectRoot.prototype.writeExclusiveWithReceipt = originalWrite;
    pinned.close();
    cleanup();
  }
});

test("content-addressed artifact writer reports ownership only after exclusive creation", () => {
  const { root, artifactsDir, cleanup } = fixture();
  const pinned = PinnedProjectRoot.open(root);
  assert.ok(pinned, "ownership fixture root must be pinnable");
  if (!pinned) return;
  try {
    const ownership: unknown[] = [];
    const first = writeArtifactWithReference(
      root,
      artifactsDir,
      "implementation-conformance.ownership",
      { schema_version: 1, conformance_id: "ownership" },
      { schema_status: "met", quality_gate_status: "met" },
      { pinnedRoot: pinned, onCreated: (token) => ownership.push(token) },
    );
    assert.equal(ownership.length, 1, "the exclusive creator receives one ownership token");
    const token = ownership[0] as { path: string; relative_path: string; dev: number; ino: number; size: number; sha256: string };
    assert.equal(token.path, pinned.anchorPath(token.relative_path));
    assert.equal(token.relative_path, first.path);
    assert.equal(token.dev > 0, true);
    assert.equal(token.ino > 0, true);
    assert.equal(token.size > 0, true);
    assert.equal(token.sha256, first.sha256);
    writeArtifactWithReference(
      root,
      artifactsDir,
      "implementation-conformance.ownership",
      { schema_version: 1, conformance_id: "ownership" },
      { schema_status: "met", quality_gate_status: "met" },
      { pinnedRoot: pinned, onCreated: (created) => ownership.push(created) },
    );
    assert.equal(ownership.length, 1, "an identical replay does not claim preexisting ownership");

    const concurrent = PinnedProjectRoot.open(root);
    assert.ok(concurrent, "concurrent ownership fixture root must be pinnable");
    if (!concurrent) return;
    const originalWriteExclusive = PinnedProjectRoot.prototype.writeExclusiveWithDescriptor;
    let concurrentCreated = false;
    PinnedProjectRoot.prototype.writeExclusiveWithDescriptor = function (
      relativePath: string,
      content: Parameters<PinnedProjectRoot["writeExclusiveWithDescriptor"]>[1],
    ): ReturnType<PinnedProjectRoot["writeExclusiveWithDescriptor"]> {
      if (!concurrentCreated && relativePath.includes("implementation-conformance.concurrent")) {
        concurrentCreated = true;
        originalWriteExclusive.call(concurrent, relativePath, content);
      }
      return originalWriteExclusive.call(this, relativePath, content);
    };
    try {
      writeArtifactWithReference(
        root,
        artifactsDir,
        "implementation-conformance.concurrent",
        { schema_version: 1, conformance_id: "concurrent" },
        { schema_status: "met", quality_gate_status: "met" },
        { pinnedRoot: pinned, onCreated: (created) => ownership.push(created) },
      );
      assert.equal(concurrentCreated, true, "the concurrent creator must win the exclusive race");
      assert.equal(ownership.length, 1, "a concurrent identical creator receives no ownership token");
    } finally {
      PinnedProjectRoot.prototype.writeExclusiveWithDescriptor = originalWriteExclusive;
      concurrent.close();
    }
  } finally {
    pinned.close();
    cleanup();
  }
});

test("artifact writers run beforeWrite immediately before their pinned write", () => {
  const { root, artifactsDir, cleanup } = fixture();
  const pinned = PinnedProjectRoot.open(root);
  assert.ok(pinned, "beforeWrite fixture root must be pinnable");
  if (!pinned) return;
  try {
    const nestedArtifacts = join(root, ".work-state", "features", "race", "new-artifacts");
    const nestedRelative = pinned.relativePath(nestedArtifacts);
    assert.ok(nestedRelative !== null);
    if (nestedRelative === null) return;
    const standardId = "before-standard";
    let standardCalls = 0;
    writeArtifactPinned(pinned, nestedRelative, standardId, { value: 1 }, {
      beforeWrite: () => {
        standardCalls += 1;
        assert.equal(existsSync(nestedArtifacts), true, "the artifact directory is prepared before beforeWrite");
        assert.equal(existsSync(join(nestedArtifacts, standardId + ".json")), false, "beforeWrite runs before the target write");
      },
    });
    assert.equal(standardCalls, 1);
    assert.deepEqual(readArtifactPinned(pinned, nestedRelative, standardId), { value: 1 });

    const referenceId = "before-reference";
    let referenceCalls = 0;
    writeArtifactWithReference(
      root,
      artifactsDir,
      referenceId,
      { value: 2 },
      { schema_status: "met", quality_gate_status: "met" },
      { pinnedRoot: pinned, beforeWrite: () => { referenceCalls += 1; assert.equal(existsSync(join(artifactsDir, referenceId + ".json")), false); } },
    );
    assert.equal(referenceCalls, 1, "writeArtifactWithReference propagates beforeWrite for ordinary artifacts");

    const contentAddressedId = "implementation-conformance.before-write";
    let contentCalls = 0;
    let ownershipCalls = 0;
    writeArtifactWithReference(
      root,
      artifactsDir,
      contentAddressedId,
      { schema_version: 1, conformance_id: "before-write" },
      { schema_status: "met", quality_gate_status: "met" },
      {
        pinnedRoot: pinned,
        beforeWrite: () => {
          contentCalls += 1;
          assert.equal(existsSync(join(artifactsDir, contentAddressedId + ".json")), false, "content-addressed beforeWrite runs before exclusive creation");
        },
        onCreated: () => { ownershipCalls += 1; },
      },
    );
    assert.equal(contentCalls, 1);
    assert.equal(ownershipCalls, 1, "ownership is reported only after own creation");
    writeArtifactWithReference(
      root,
      artifactsDir,
      contentAddressedId,
      { schema_version: 1, conformance_id: "before-write" },
      { schema_status: "met", quality_gate_status: "met" },
      { pinnedRoot: pinned, beforeWrite: () => { contentCalls += 1; }, onCreated: () => { ownershipCalls += 1; } },
    );
    assert.equal(contentCalls, 1, "identical replay does not invoke beforeWrite");
    assert.equal(ownershipCalls, 1, "identical replay does not claim preexisting ownership");

    const blockedId = "implementation-conformance.before-write-blocked";
    assert.throws(
      () => writeArtifactWithReference(
        root,
        artifactsDir,
        blockedId,
        { schema_version: 1, conformance_id: "blocked" },
        { schema_status: "met", quality_gate_status: "met" },
        { pinnedRoot: pinned, beforeWrite: () => { throw new Error("write guard blocked"); }, onCreated: () => { throw new Error("must not run"); } },
      ),
      /write guard blocked/u,
    );
    assert.equal(existsSync(join(artifactsDir, blockedId + ".json")), false, "a rejected beforeWrite leaves no artifact");
  } finally {
    pinned.close();
    cleanup();
  }
});

test("content-addressed artifact writer rejects an over-cap payload before creating a file", () => {
  const { root, artifactsDir, cleanup } = fixture();
  try {
    const near = valueNearArtifactByteCap();
    const oversized = { ...near.value, first: `${near.value.first}${"\u0000".repeat(4)}` };
    assert.throws(
      () => writeArtifactWithReference(
        root,
        artifactsDir,
        "implementation-conformance.oversized",
        oversized,
        { schema_status: "met", quality_gate_status: "met" },
      ),
      (error: unknown) => error instanceof ArtifactStructureError && error.code === "bytes",
    );
    assert.deepEqual(readdirSync(artifactsDir), []);
  } finally {
    cleanup();
  }
});

test("returned artifact byte-cap rejection preflights the full manifest before any file write", () => {
  const { root, artifactsDir, cleanup } = fixture();
  try {
    const near = JSON.stringify({ text: "é".repeat(32) });
    const padded = `${" ".repeat(MAX_ARTIFACT_BYTES - Buffer.byteLength(near, "utf8"))}${near}`;
    assert.equal(Buffer.byteLength(padded, "utf8"), MAX_ARTIFACT_BYTES);
    assert.deepEqual(
      persistTestArtifacts(root, artifactsDir, { near: padded }),
      ["near"],
    );
    assert.deepEqual(readTestArtifact(root, artifactsDir, "near"), { text: "é".repeat(32) });

    const oversized = `${padded} `;
    assert.equal(Buffer.byteLength(oversized, "utf8"), MAX_ARTIFACT_BYTES + 1);
    assert.throws(
      () => persistTestArtifacts(root, artifactsDir, { valid: "{}", oversized }),
      (error: unknown) => error instanceof ArtifactStructureError && error.code === "bytes",
    );
    assert.equal(readTestArtifact(root, artifactsDir, "valid"), null);
    assert.deepEqual(readTestArtifact(root, artifactsDir, "near"), { text: "é".repeat(32) });
  } finally {
    cleanup();
  }
});
test("artifact parser and pinned readers reject invalid UTF-8 before JSON use", () => {
  const { root, artifactsDir, cleanup } = fixture();
  const malformed = Buffer.from([0x7b, 0x22, 0x78, 0x22, 0x3a, 0xff, 0x7d]);
  writeFileSync(join(artifactsDir, "evidence.json"), malformed);
  try {
    const parsed = parseArtifactJson(malformed);
    assert.equal(parsed.ok, false);
    if (parsed.ok) return;
    assert.equal(parsed.kind, "encoding");
    assert.match(parsed.reason, /UTF-8/);

    const snapshot = readTestArtifactSnapshot(root, artifactsDir, "evidence");
    assert.equal(snapshot.ok, false);
    if (snapshot.ok) return;
    assert.equal(snapshot.kind, "encoding");
    assert.match(snapshot.reason, /UTF-8/);

    const pinned = PinnedProjectRoot.open(root);
    assert.ok(pinned);
    try {
      const relativeArtifactsDir = relative(root, artifactsDir);
      assert.equal(readArtifactPinned(pinned, relativeArtifactsDir, "evidence"), null);
    } finally {
      pinned.close();
    }
  } finally {
    cleanup();
  }
});

test("artifact snapshot hashes and parses the same descriptor-bound bytes", () => {
  const { root, artifactsDir, cleanup } = fixture();
  try {
    const body = Buffer.from(JSON.stringify({ status: "old", schema_version: 1 }) + "\n", "utf8");
    writeFileSync(join(artifactsDir, "evidence.json"), body);

    const snapshot = readTestArtifactSnapshot(root, artifactsDir, "evidence");
    assert.equal(snapshot.ok, true);
    if (!snapshot.ok) return;
    assert.deepEqual(snapshot.bytes, body);
    assert.equal(snapshot.sha256, sha256(body));
    assert.deepEqual(snapshot.value, { status: "old", schema_version: 1 });
    assert.equal(snapshot.stat.size, body.byteLength);
  } finally {
    cleanup();
  }
});

test("artifact normalization rejects a pathname replacement after the opened read", () => {
  const { root, artifactsDir, cleanup } = fixture();
  const path = join(artifactsDir, "evidence.json");
  const oldBody = Buffer.from(JSON.stringify({ status: "old", schema_version: 1 }) + "\n", "utf8");
  const newBody = Buffer.from(JSON.stringify({ status: "new", wrong: true }) + "\n", "utf8");
  const oldPath = join(artifactsDir, "evidence.old.json");
  try {
    writeFileSync(path, oldBody);
    const authorization: ArtifactReferenceAuthorization = {
      project_root: root,
      artifacts_dir: artifactsDir,
      allowed_paths: [relative(root, path)],
    };
    let hookCalls = 0;
    setArtifactReadTestHooks({
      afterRead: ({ path: openedPath }) => {
        hookCalls += 1;
        renameSync(openedPath, oldPath);
        writeFileSync(openedPath, newBody);
      },
    });
    const result = normalizeStoredArtifactReference(
      authorization,
      {
        artifact_id: "evidence",
        path: relative(root, path),
        sha256: sha256(oldBody),
        schema_status: "met",
        quality_gate_status: "met",
      },
      (_artifactId, value) =>
        value && typeof value === "object" && !Array.isArray(value) && (value as Record<string, unknown>).status === "old"
          ? { ok: true }
          : { ok: false, issues: [{ field: "$.status", message: "expected old status" }] },
    );
    assert.equal(hookCalls, 1);
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.match(result.issues.join("; "), /changed|symlink/i);
    assert.doesNotMatch(result.issues.join("; "), /schema failed|does not match current digest/i);
  } finally {
    setArtifactReadTestHooks(null);
    cleanup();
  }
});

test("artifact normalization rejects same-inode bytes replaced after the opened read", () => {
  const { root, artifactsDir, cleanup } = fixture();
  const path = join(artifactsDir, "evidence.json");
  const oldBody = Buffer.from(JSON.stringify({ status: "old", schema_version: 1 }) + "\n", "utf8");
  const newBody = Buffer.from(JSON.stringify({ status: "new", schema_version: 1 }) + "\n", "utf8");
  let sameInode = false;
  try {
    writeFileSync(path, oldBody);
    const authorization: ArtifactReferenceAuthorization = {
      project_root: root,
      artifacts_dir: artifactsDir,
      allowed_paths: [relative(root, path)],
    };
    setArtifactReadTestHooks({
      afterRead: ({ path: openedPath, stat }) => {
        writeFileSync(openedPath, newBody);
        const replaced = statSync(openedPath);
        sameInode = replaced.dev === stat.dev && replaced.ino === stat.ino;
      },
    });
    const result = normalizeStoredArtifactReference(
      authorization,
      {
        artifact_id: "evidence",
        path: relative(root, path),
        sha256: sha256(oldBody),
        schema_status: "met",
        quality_gate_status: "met",
      },
      (_artifactId, value) =>
        value && typeof value === "object" && !Array.isArray(value) && (value as Record<string, unknown>).status === "old"
          ? { ok: true }
          : { ok: false, issues: [{ field: "$.status", message: "expected old status" }] },
    );
    assert.equal(sameInode, true);
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.match(result.issues.join("; "), /changed|digest/i);
    assert.doesNotMatch(result.issues.join("; "), /schema failed/);
  } finally {
    setArtifactReadTestHooks(null);
    cleanup();
  }
});


test("artifact reference persistence rejects an ancestor symlink swap without outside writes", () => {
  const { root, artifactsDir, cleanup } = fixture();
  const outside = mkdtempSync(join(tmpdir(), "artifact-reference-outside-"));
  const moved = artifactsDir + ".opened";
  let swapped = false;
  const pinned = PinnedProjectRoot.open(root, {
    beforeTempOpen: (relativePath) => {
      if (swapped || !relativePath.endsWith("/evidence.json") && relativePath !== "evidence.json") return;
      swapped = true;
      renameSync(artifactsDir, moved);
      symlinkSync(outside, artifactsDir, "dir");
    },
  });
  assert.ok(pinned, "the fixture root must be pinnable");
  try {
    assert.throws(
      () => writeArtifactWithReference(
        root,
        artifactsDir,
        "evidence",
        { status: "should-not-escape" },
        { schema_status: "met", quality_gate_status: "met" },
        { pinnedRoot: pinned! },
      ),
      (error: unknown) => error instanceof PinnedRootError
        && ["path_unauthorized", "changed", "not_directory", "write_failed"].includes(error.code),
    );
    assert.equal(swapped, true, "the ancestor swap seam must execute");
    assert.deepEqual(readdirSync(outside), [], "a rebound artifact ancestor must never receive a write");
  } finally {
    pinned?.close();
    if (swapped) {
      rmSync(artifactsDir, { recursive: true, force: true });
      renameSync(moved, artifactsDir);
    }
    rmSync(moved, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
    cleanup();
  }
});

test("mutable artifact writer rolls back absent and existing preimages without clobbering replacement", () => {
  const { root, artifactsDir, cleanup } = fixture();
  const pinned = PinnedProjectRoot.open(root);
  assert.ok(pinned, "atomic rollback fixture root must be pinnable");
  if (!pinned) return;
  try {
    const relativeDir = pinned.relativePath(artifactsDir);
    assert.ok(relativeDir !== null);
    if (relativeDir === null) return;
    let createdToken: ArtifactAtomicWriteRollbackToken | undefined;
    writeArtifactPinned(pinned, relativeDir, "atomic-created", { value: "new" }, {
      onWritten: (token) => { createdToken = token; },
    });
    assert.ok(createdToken);
    if (!createdToken) return;
    assert.equal(createdToken.preimage.kind, "absent");
    assert.equal(createdToken.path, pinned.anchorPath(createdToken.relative_path));
    assert.equal(rollbackArtifactAtomicWrite(pinned, createdToken), true);
    assert.equal(readArtifactPinned(pinned, relativeDir, "atomic-created"), null);

    writeArtifactPinned(pinned, relativeDir, "atomic-existing", { value: "old" });
    let replacedToken: typeof createdToken;
    writeArtifactPinned(pinned, relativeDir, "atomic-existing", { value: "new" }, {
      onWritten: (token) => { replacedToken = token; },
    });
    replacedToken = replacedToken!;
    assert.equal(replacedToken.preimage.kind, "file");
    if (replacedToken.preimage.kind !== "file") return;
    assert.equal(JSON.parse(Buffer.from(replacedToken.preimage.bytes).toString("utf8")).value, "old");
    assert.equal(rollbackArtifactAtomicWrite(pinned, replacedToken), true);
    assert.deepEqual(readArtifactPinned(pinned, relativeDir, "atomic-existing"), { value: "old" });

    let racedToken: typeof createdToken;
    writeArtifactPinned(pinned, relativeDir, "atomic-raced", { value: "attempt" }, {
      onWritten: (token) => { racedToken = token; },
    });
    racedToken = racedToken!;
    writeArtifactPinned(pinned, relativeDir, "atomic-raced", { value: "replacement" });
    assert.equal(rollbackArtifactAtomicWrite(pinned, racedToken), false);
    assert.deepEqual(readArtifactPinned(pinned, relativeDir, "atomic-raced"), { value: "replacement" });
  } finally {
    pinned.close();
    cleanup();
  }
});


test("artifact writer callback failures roll back exact writes before rethrow", () => {
  const { root, artifactsDir, cleanup } = fixture();
  const pinned = PinnedProjectRoot.open(root);
  assert.ok(pinned, "callback rollback fixture root must be pinnable");
  if (!pinned) return;
  try {
    const relativeDir = pinned.relativePath(artifactsDir);
    assert.ok(relativeDir !== null);
    if (relativeDir === null) return;
    assert.throws(
      () => writeArtifactPinned(pinned, relativeDir, "callback-absent", { value: "new" }, { onWritten: () => { throw new Error("onWritten failed"); } }),
      /onWritten failed/u,
    );
    assert.equal(readArtifactPinned(pinned, relativeDir, "callback-absent"), null);

    writeArtifactPinned(pinned, relativeDir, "callback-existing", { value: "old" });
    assert.throws(
      () => writeArtifactPinned(pinned, relativeDir, "callback-existing", { value: "new" }, { onWritten: () => { throw new Error("onWritten failed"); } }),
      /onWritten failed/u,
    );
    assert.deepEqual(readArtifactPinned(pinned, relativeDir, "callback-existing"), { value: "old" });

    const callbackId = "implementation-conformance.callback";
    assert.throws(
      () => writeArtifactWithReference(
        root,
        artifactsDir,
        callbackId,
        { schema_version: 1, conformance_id: "callback" },
        { schema_status: "met", quality_gate_status: "met" },
        { pinnedRoot: pinned, onCreated: () => { throw new Error("onCreated failed"); } },
      ),
      /onCreated failed/u,
    );
    assert.equal(readArtifactPinned(pinned, relativeDir, callbackId), null);
  } finally {
    pinned.close();
    cleanup();
  }
});

test("pinned artifact reads and writes reject a symlinked directory outside the root", () => {
  const { root, cleanup } = fixture();
  const outside = mkdtempSync(join(tmpdir(), "artifact-pinned-outside-"));
  const linked = join(root, "linked-artifacts");
  symlinkSync(outside, linked, "dir");
  const pinned = PinnedProjectRoot.open(root);
  assert.ok(pinned);
  if (!pinned) return;
  try {
    assert.equal(readArtifactPinned(pinned, "linked-artifacts", "escape"), null);
    assert.throws(
      () => writeArtifactPinned(pinned, "linked-artifacts", "escape", { value: "must-not-escape" }),
      (error: unknown) => error instanceof PinnedRootError,
    );
    assert.throws(
      () => persistReturnedArtifactsPinned(pinned, "linked-artifacts", { batch_escape: { value: "must-not-escape" } }),
      (error: unknown) => error instanceof PinnedRootError,
    );
    assert.deepEqual(readdirSync(outside), []);
  } finally {
    pinned.close();
    rmSync(outside, { recursive: true, force: true });
    cleanup();
  }
});

test("pinned returned-artifact batch rolls back prior writes when a later publication fails", () => {
  const { root, artifactsDir, cleanup } = fixture();
  const pinned = PinnedProjectRoot.open(root);
  assert.ok(pinned);
  if (!pinned) return;
  const original = PinnedProjectRoot.prototype.writeAtomicWithReceipt;
  let calls = 0;
  PinnedProjectRoot.prototype.writeAtomicWithReceipt = function (...args) {
    calls += 1;
    if (calls === 2) throw new Error("second publication failed");
    return original.apply(this, args);
  };
  try {
    const relativeDir = pinned.relativePath(artifactsDir);
    assert.ok(relativeDir !== null);
    if (relativeDir === null) return;
    assert.throws(
      () => persistReturnedArtifactsPinned(pinned, relativeDir, { first: { value: 1 }, second: { value: 2 } }),
      /second publication failed/u,
    );
    assert.equal(readArtifactPinned(pinned, relativeDir, "first"), null);
    assert.equal(readArtifactPinned(pinned, relativeDir, "second"), null);
  } finally {
    PinnedProjectRoot.prototype.writeAtomicWithReceipt = original;
    pinned.close();
    cleanup();
  }
});

test("pinned returned-artifact batch rejects a parent replacement without outside writes", () => {
  const { root, artifactsDir, cleanup } = fixture();
  const outside = mkdtempSync(join(tmpdir(), "artifact-batch-outside-"));
  const moved = artifactsDir + ".opened";
  let swapped = false;
  const pinned = PinnedProjectRoot.open(root, {
    beforeTempOpen: (relativePath) => {
      if (swapped || !relativePath.endsWith("/batch_swap.json")) return;
      swapped = true;
      renameSync(artifactsDir, moved);
      symlinkSync(outside, artifactsDir, "dir");
    },
  });
  assert.ok(pinned);
  if (!pinned) return;
  try {
    const relativeDir = pinned.relativePath(artifactsDir);
    assert.ok(relativeDir !== null);
    if (relativeDir === null) return;
    assert.throws(
      () => persistReturnedArtifactsPinned(pinned, relativeDir, { batch_swap: { value: "must-not-escape" } }),
      (error: unknown) => error instanceof PinnedRootError,
    );
    assert.equal(swapped, true);
    assert.deepEqual(readdirSync(outside), []);
  } finally {
    pinned.close();
    if (swapped) {
      rmSync(artifactsDir, { recursive: true, force: true });
      renameSync(moved, artifactsDir);
    }
    rmSync(moved, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
    cleanup();
  }
});

