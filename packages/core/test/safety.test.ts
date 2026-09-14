import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { safetyGuard } from "../src/gates/safety.js";

function initRepo(branch: string): string {
  const root = mkdtempSync(join(tmpdir(), "safety-gate-"));
  execFileSync("git", ["-C", root, "init", "--quiet", "--initial-branch", branch], { stdio: "ignore" });
  execFileSync("git", ["-C", root, "-c", "user.email=test.com", "-c", "user.name=Test", "commit", "--quiet", "--allow-empty", "-m", "init"], { stdio: "ignore" });
  return root;
}

function cleanup(root: string): void {
  rmSync(root, { recursive: true, force: true });
}

function forcePush(root: string, command = "git push --force origin HEAD") {
  return safetyGuard({ toolName: "bash", input: { command } }, { cwd: root });
}

test("force-push blocks when branch lookup fails in a non-git cwd", () => {
  const root = mkdtempSync(join(tmpdir(), "safety-non-git-"));
  try {
    const result = forcePush(root);
    assert.equal(result?.block, true);
    assert.match(result?.reason ?? "", /current branch could not be established/);
  } finally {
    cleanup(root);
  }
});

test("force-push blocks when branch lookup resolves to detached or unknown HEAD", () => {
  const root = initRepo("feature/unknown-check");
  try {
    execFileSync("git", ["-C", root, "checkout", "--detach"], { stdio: "ignore" });
    const result = forcePush(root);
    assert.equal(result?.block, true);
    assert.match(result?.reason ?? "", /current branch could not be established/);
  } finally {
    cleanup(root);
  }
});

test("force-push blocks protected branches", () => {
  for (const branch of ["main", "master"]) {
    const root = initRepo(branch);
    try {
      for (const command of ["git push --force origin HEAD", "git push -f origin HEAD", "git push --force-with-lease origin HEAD"]) {
        const result = forcePush(root, command);
        assert.equal(result?.block, true, `${branch}: ${command}`);
        assert.match(result?.reason ?? "", /protected branch/);
      }
    } finally {
      cleanup(root);
    }
  }
});

test("force-push proceeds from a known non-protected branch", () => {
  const root = initRepo("feature/safe-publish");
  try {
    assert.equal(forcePush(root), undefined);
  } finally {
    cleanup(root);
  }
});

test("non-force commands retain existing behavior and do not require branch lookup", () => {
  const root = mkdtempSync(join(tmpdir(), "safety-non-force-"));
  try {
    assert.equal(safetyGuard({ toolName: "bash", input: { command: "git push origin HEAD" } }, { cwd: root }), undefined);
    assert.equal(safetyGuard({ toolName: "bash", input: { command: "echo ok" } }, { cwd: root }), undefined);
  } finally {
    cleanup(root);
  }
});
