/**
 * Core /cto envelope and channel syntax tests.
 * Registered ingress owns exact-run acquisition; no prompt-only command API
 * remains in the public surface.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { parseCtoEnvelope } from "@andvl1/omp-workflows-core";


test("cto-cmd: natural-language directive sets the hint and stays out of the task", () => {
  const root = mkdtempSync(join(tmpdir(), "cto-core-ru-"));
  try {
    const envelope = parseCtoEnvelope("действуй автономно: Add OAuth", root);
    assert.equal(envelope.autonomyHint, true);
    assert.equal(envelope.task, "Add OAuth");


    const lookalike = parseCtoEnvelope("[AUTONOMOUSLY] Add OAuth", root);
    assert.equal(lookalike.autonomyHint, false, "lookalike does not set the hint");
    assert.equal(lookalike.task, "[AUTONOMOUSLY] Add OAuth", "lookalike stays literal");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("cto-cmd: parseCtoEnvelope handles prefixes and issue", () => {
  const root = mkdtempSync(join(tmpdir(), "cto-core-"));
  try {
    const plain = parseCtoEnvelope("Add OAuth issue=#3", root);
    assert.equal(plain.task, "Add OAuth");
    assert.equal(plain.issue, 3);
    assert.equal(plain.autonomyHint, false);

    const auto = parseCtoEnvelope("[AUTONOMOUS] Fix bug issue=#9", root);
    assert.equal(auto.autonomyHint, true);
    assert.equal(auto.task, "Fix bug");
    assert.equal(auto.issue, 9);
    assert.equal(auto.branch, null); // tmpdir is not a git work tree
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});










