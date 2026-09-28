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
import { parseCtoCommand } from "../src/commands/cto.js";


test("cto-cmd: legacy recovery selectors are explicit, exact, and terminator-bound", () => {
  assert.deepEqual(parseCtoCommand("--recover-legacy --run legacy-run"), {
    ok: true,
    task: "",
    run_id: "legacy-run",
    recover_legacy: true,
  });
  assert.deepEqual(parseCtoCommand("--run=legacy-run --recover-legacy -- --recover-legacy --run another"), {
    ok: true,
    task: "--recover-legacy --run another",
    run_id: "legacy-run",
    recover_legacy: true,
  });

  const missingRun = parseCtoCommand("--recover-legacy");
  assert.equal(missingRun.ok, false);
  if (missingRun.ok) throw new Error("expected missing --run failure");
  assert.match(missingRun.error, /requires an exact --run/);

  const duplicateRecovery = parseCtoCommand("--recover-legacy --recover-legacy --run legacy-run");
  assert.equal(duplicateRecovery.ok, false);
  if (duplicateRecovery.ok) throw new Error("expected duplicate recovery failure");
  assert.match(duplicateRecovery.error, /duplicate --recover-legacy/);

  const duplicateRun = parseCtoCommand("--recover-legacy --run first --run second");
  assert.equal(duplicateRun.ok, false);
  if (duplicateRun.ok) throw new Error("expected duplicate run failure");
  assert.match(duplicateRun.error, /duplicate --run/);

  const literalRecovery = parseCtoCommand("-- --recover-legacy --run legacy-run");
  assert.deepEqual(literalRecovery, {
    ok: true,
    task: "--recover-legacy --run legacy-run",
  });
});

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










