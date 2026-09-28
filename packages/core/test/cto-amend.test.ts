/**
 * Amend protocol tests: legacy active-run inspection remains diagnostic-only,
 * while prompt builders preserve exact-run amend metadata.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  runCto,
  findActiveCtoRun,
  buildAmendPrompt,
  setCtoPause,
  markAmended,
  readCtoState,
  setIntegration,
  setTeamStatus,
  isCtoRunTerminal,
  type TeamDef,
} from "@andvl1/omp-workflows-core";
import type { TrustedExecutionContext } from "../src/engine/types.js";

function sampleDefs(): Record<string, TeamDef> {
  return {
    backend: { id: "backend", name: "Backend", scope: ["backend-kotlin"], profile: "lightweight", lead: "team-lead", roster: ["backend-kotlin"] },
    frontend: { id: "frontend", name: "Frontend", scope: ["frontend"], profile: "lightweight", lead: "team-lead", roster: ["frontend"] },
    "cli-go": { id: "cli-go", name: "CLI Go", scope: ["go"], profile: "lightweight", lead: "team-lead", roster: ["go"] },
  };
}

function executionContext(root: string, sessionId = "cto-amend-session", branch = "main"): TrustedExecutionContext {
  return { session_id: sessionId, caller: "host", process_id: process.pid, worktree: root, branch, authority: "coordinator" };
}

function startRun(root: string) {
  const res = runCto({
    task: "Feature A",
    cwd: root,
    branch: "main",
    autonomous: false,
    teams: [{ team: "backend", slice: "s1" }, { team: "frontend", slice: "s2" }],
    defs: sampleDefs(),
    execution: executionContext(root),
  });
  assert.equal(res.ok, true);
  return res.ok ? res : null;
}

test("cto-amend: findActiveCtoRun returns null without runs", () => {
  const root = mkdtempSync(join(tmpdir(), "cto-amend-"));
  try {
    assert.equal(findActiveCtoRun(root), null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("cto-amend: findActiveCtoRun finds an active run and ignores finished ones", () => {
  const root = mkdtempSync(join(tmpdir(), "cto-amend-"));
  try {
    // Publish and terminalize a real authenticated run before starting the
    // active run; this exercises the managed terminal transition rather than
    // an unowned canonical-state write.
    const doneResult = runCto({
      task: "Done run",
      cwd: root,
      branch: "main",
      autonomous: false,
      teams: [{ team: "backend", slice: "done" }],
      defs: sampleDefs(),
      execution: executionContext(root, "done-session"),
    });
    assert.equal(doneResult.ok, true);
    if (!doneResult.ok) return;
    setCtoPause(doneResult.state, "done", "finished", root);
    const first = startRun(root);
    assert.ok(first);
    const active = findActiveCtoRun(root);
    assert.equal(active?.runId, first.plan.id, "active run found even with a finished run present");
    assert.deepEqual(
      active?.state.teams.map((t) => t.id).sort(),
      ["backend", "frontend"],
    );

    // Marking the active run done -> nothing active left.
    setCtoPause(first.state, "done", "finished", root);
    assert.equal(findActiveCtoRun(root), null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});


test("cto-amend: findActiveCtoRun falls back to markdown state (br-5ql)", () => {
  const root = mkdtempSync(join(tmpdir(), "cto-amend-md-"));
  try {
    // Agent-written run: NO state.json — only markdown files.
    const runId = "feat-ping-2026-08-04";
    const runDir = join(root, ".work-state", "cto", runId);
    mkdirSync(runDir, { recursive: true });
    writeFileSync(join(runDir, "cto_discovery.md"), "# Implement Feature A\n\nDiscovered scope.\n");
    writeFileSync(
      join(runDir, "team-plan.md"),
      [
        "# Team Plan — feat-ping",
        "",
        "- team: backend — server slice",
        "- team: frontend — status page",
        "",
        "Shared contract defined in architecture.md.",
      ].join("\n"),
    );
    writeFileSync(join(runDir, "decisions.md"), "| # | When | Decision | Why |\n");

    const active = findActiveCtoRun(root);
    assert.ok(active, "markdown-only run detected as active");
    assert.equal(active?.runId, runId);
    assert.deepEqual(
      active?.state.teams.map((t) => t.id).sort(),
      ["backend", "frontend"],
      "team ids extracted from team-plan.md",
    );
    assert.equal(active?.state.pause.kind, "none");
    assert.ok(active?.state.pause.reason?.includes("markdown"), "markdown fallback flagged");

    // Adding a summary marker finishes the run.
    writeFileSync(join(runDir, "summary.md"), "# Summary\nAll done.\n");
    assert.equal(findActiveCtoRun(root), null, "summary.md marks the run finished");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});


test("cto-amend: cto_discovery.md alone marks the run active (early amend window)", () => {
  const root = mkdtempSync(join(tmpdir(), "cto-amend-early-"));
  try {
    const runId = "early-run";
    const runDir = join(root, ".work-state", "cto", runId);
    mkdirSync(runDir, { recursive: true });
    writeFileSync(join(runDir, "cto_discovery.md"), "# Implement Feature A\n");
    const active = findActiveCtoRun(root);
    assert.ok(active, "run detected while parked at the first checkpoint");
    assert.equal(active?.runId, runId);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("cto-amend: markAmended stamps amended_at and persists", () => {
  const root = mkdtempSync(join(tmpdir(), "cto-amend-"));
  try {
    const res = startRun(root);
    assert.ok(res);
    markAmended(res.state, root);
    const reloaded = readCtoState(res.plan.id, root);
    assert.ok(reloaded?.amended_at, "amended_at stamped after markAmended");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("cto-amend: buildAmendPrompt includes active run metadata", () => {
  const root = mkdtempSync(join(tmpdir(), "cto-amend-"));
  try {
    const res = startRun(root);
    assert.ok(res);
    const prompt = buildAmendPrompt(
      { task: "Task B", autonomyHint: true, issue: null, branch: "main" },
      root,
      { runId: res.plan.id, state: res.state },
    );
    assert.ok(prompt.includes(`.work-state/cto/${res.plan.id}/inbox/*.json`), "amend inbox check points at the ACTUAL run inbox");
    assert.ok(!prompt.includes("+runId+"), "no literal template placeholder leaks into the rendered prompt");
    assert.ok(
      prompt.includes("<!-- omp-cto-slice run=<runId> slice=<sliceId> -->"),
      "exact marker literal in the amend prompt",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
