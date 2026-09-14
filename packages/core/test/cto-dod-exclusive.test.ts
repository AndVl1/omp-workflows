import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { MAX_DOD_BYTES, readDoDFilePinned } from "../src/engine/dod.js";
import { writeCtoDoDExclusive } from "../src/cto/dod.js";
import { PinnedProjectRoot } from "../src/specification/pinned-root.js";
import { sha256Hex } from "../src/specification/validation.js";
import type { DoD } from "../src/engine/types.js";

const DOD: DoD = {
  items: [{
    id: "criterion-1",
    source: "implementation",
    criterion: "The implementation is complete",
    verify_method: "focused test",
    status: "met",
    evidence: "test passed",
  }],
  type_requirements_met: true,
  updated_at: "2026-09-06T00:00:00.000Z",
};

const DOD_TEXT_BYTES = 16 * 1024;

function fixtureDod(textBytes: number): DoD {
  const text = "x".repeat(textBytes);
  return {
    items: Array.from({ length: 64 }, (_, index) => ({
      id: `criterion-${index}`,
      source: "implementation",
      criterion: text,
      verify_method: "focused test",
      status: "pending" as const,
      evidence: "evidence",
    })),
    type_requirements_met: true,
    updated_at: "2026-09-06T00:00:00.000Z",
  };
}

function serializedCtoDod(dod: DoD): Buffer {
  return Buffer.from(`${JSON.stringify({
    items: dod.items,
    type_requirements_met: true,
    updated_at: dod.updated_at,
  }, null, 2)}\n`, "utf8");
}

function maximalReadableDod(): { dod: DoD; content: Buffer; textBytes: number } {
  let low = 0;
  let high = DOD_TEXT_BYTES;
  let bestTextBytes = 0;
  while (low <= high) {
    const textBytes = Math.floor((low + high) / 2);
    const candidate = fixtureDod(textBytes);
    const content = serializedCtoDod(candidate);
    if (content.byteLength <= MAX_DOD_BYTES) {
      bestTextBytes = textBytes;
      low = textBytes + 1;
    } else {
      high = textBytes - 1;
    }
  }
  const dod = fixtureDod(bestTextBytes);
  return { dod, content: serializedCtoDod(dod), textBytes: bestTextBytes };
}

test("CTO DoD exclusive write accepts a near-limit readable projection and rejects cap+1 before directory mutation", () => {
  withPinnedRoot((_root, pinned) => {
    const near = maximalReadableDod();
    assert.ok(near.content.byteLength > MAX_DOD_BYTES - 1024);
    const nearRelative = ".work-state/cto/run-near/artifacts/team-near";
    const written = writeCtoDoDExclusive(pinned, nearRelative, near.dod);
    assert.equal(readFileSync(written.path).byteLength, near.content.byteLength);
    assert.equal(readDoDFilePinned(pinned, `${nearRelative}/dod.json`).ok, true);

    const oversized = fixtureDod(near.textBytes + 1);
    assert.ok(serializedCtoDod(oversized).byteLength > MAX_DOD_BYTES);
    const oversizedRelative = ".work-state/cto/run-over/artifacts/team-over";
    assert.throws(
      () => writeCtoDoDExclusive(pinned, oversizedRelative, oversized),
      /CTO_DOD_ARTIFACT_OVERSIZED: serialized DoD exceeds/u,
    );
    assert.equal(pinned.pathEntryExists(oversizedRelative), false, "oversized write must not create its artifact directory");
  });
});

function withPinnedRoot<T>(fn: (root: string, pinned: PinnedProjectRoot) => T): T {
  const root = mkdtempSync(join(tmpdir(), "cto-dod-exclusive-"));
  const pinned = PinnedProjectRoot.open(root);
  assert.ok(pinned);
  try {
    return fn(root, pinned);
  } finally {
    pinned.close();
    rmSync(root, { recursive: true, force: true });
  }
}

test("CTO DoD exclusive write is idempotent for a valid existing projection", () => {
  withPinnedRoot((_root, pinned) => {
    const first = writeCtoDoDExclusive(pinned, ".work-state/cto/run-1/artifacts/team-1", DOD);
    const before = readFileSync(first.path, "utf8");
    const second = writeCtoDoDExclusive(pinned, ".work-state/cto/run-1/artifacts/team-1", DOD);
    assert.equal(second.path, first.path);
    assert.equal(second.digest, first.digest);
    assert.equal(readFileSync(first.path, "utf8"), before);
  });
});

test("CTO DoD exclusive write invokes its boundary guard before bytes and reports exact ownership on retry", () => {
  withPinnedRoot((_root, pinned) => {
    const relative = ".work-state/cto/run-callback/artifacts/team-callback";
    let blocked = true;
    assert.throws(
      () => writeCtoDoDExclusive(pinned, relative, DOD, {
        beforeWrite: () => {
          if (blocked) throw new Error("constitution drift");
        },
      }),
      /constitution drift/u,
    );
    assert.equal(pinned.pathEntryExists(`${relative}/dod.json`), false, "a rejected boundary must not publish DoD bytes");

    let ownership: { relative_path: string; sha256: string; size: number } | undefined;
    const created = writeCtoDoDExclusive(pinned, relative, DOD, {
      onCreated: (token) => {
        ownership = token;
      },
    });
    assert.equal(created.created, true);
    assert.ok(ownership);
    assert.equal(ownership.relative_path, `${relative}/dod.json`);
    assert.equal(ownership.sha256, sha256Hex(readFileSync(created.path, "utf8")));
    assert.equal(ownership.size, readFileSync(created.path).byteLength);
    blocked = false;
    let replayNotified = false;
    const replay = writeCtoDoDExclusive(pinned, relative, DOD, {
      onCreated: () => {
        replayNotified = true;
      },
    });
    assert.equal(replay.created, false);
    assert.equal(replayNotified, false, "replay must not claim ownership of an existing DoD");
  });
});

test("CTO DoD exclusive collision rejects an oversized forged artifact before projection", () => {
  withPinnedRoot((root, pinned) => {
    const relative = ".work-state/cto/run-2/artifacts/team-2";
    const absolute = join(root, relative, "dod.json");
    mkdirSync(join(root, relative), { recursive: true });
    const forged = JSON.stringify({
      items: [{ id: "criterion-1", source: "implementation", criterion: "x", verify_method: "x", status: "met", evidence: "x" }],
      type_requirements_met: true,
      updated_at: "2026-09-06T00:00:00.000Z",
      padding: "x".repeat(MAX_DOD_BYTES),
    });
    writeFileSync(absolute, forged);
    const before = readFileSync(absolute);
    assert.throws(
      () => writeCtoDoDExclusive(pinned, relative, DOD),
      /CTO_DOD_ARTIFACT_COLLISION: existing DoD cannot be read safely/,
    );
    assert.deepEqual(readFileSync(absolute), before, "oversized collision is never overwritten");
  });
});
