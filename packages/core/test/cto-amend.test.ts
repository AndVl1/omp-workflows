/**
 * Amend protocol tests (br-k19): findActiveCtoRun routing + ctoCommand
 * returns the AMEND contract when a run is active, the fresh contract
 * otherwise; markAmended stamps the state.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  runCto,
  ctoCommand,
  findActiveCtoRun,
  buildAmendPrompt,
  setCtoPause,
  markAmended,
  readCtoState,
  type TeamDef,
} from "@andvl1/omp-workflows-core";

function sampleDefs(): Record<string, TeamDef> {
  return {
    backend: { id: "backend", name: "Backend", scope: ["backend-kotlin"], profile: "lightweight", lead: "team-lead", roster: ["backend-kotlin"] },
    frontend: { id: "frontend", name: "Frontend", scope: ["frontend"], profile: "lightweight", lead: "team-lead", roster: ["frontend"] },
    "cli-go": { id: "cli-go", name: "CLI Go", scope: ["go"], profile: "lightweight", lead: "team-lead", roster: ["go"] },
  };
}

function startRun(root: string) {
  const res = runCto({
    task: "Feature A",
    cwd: root,
    branch: "main",
    autonomous: false,
    teams: [{ team: "backend", slice: "s1" }, { team: "frontend", slice: "s2" }],
    defs: sampleDefs(),
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
    const first = startRun(root);
    assert.ok(first);
    // A second, finished run must not shadow the active one.
    const done = runCto({
      task: "Done run",
      cwd: root,
      branch: "main",
      autonomous: false,
      teams: [{ team: "cli-go", slice: "s" }],
      defs: sampleDefs(),
    });
    assert.equal(done.ok, true);
    if (done.ok) setCtoPause(done.state, "done", "finished", root);

    const active = findActiveCtoRun(root);
    assert.equal(active?.runId, first.plan.id, "active run found even with a finished run present");
    assert.deepEqual(
      active?.state.teams.map((t) => t.id).sort(),
      ["backend", "frontend"],
    );

    // Marking the active run done -> nothing active left.
    setCtoPause(active!.state, "done", "finished", root);
    assert.equal(findActiveCtoRun(root), null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("cto-amend: ctoCommand routes to AMEND while a run is active, fresh otherwise", () => {
  const root = mkdtempSync(join(tmpdir(), "cto-amend-"));
  try {
    const notifyCalls: string[] = [];
    const ctx = (args: string) => ({ args, cwd: root, ui: { notify: (m: string) => notifyCalls.push(m) } });

    // No run yet -> fresh contract.
    const fresh = ctoCommand(ctx("Add OAuth"));
    assert.ok(fresh.includes("/cto workflow"), "fresh contract for the first task");
    assert.ok(!fresh.includes("AMEND"));

    // Start a run -> second /cto folds into it.
    startRun(root);
    const amend = ctoCommand(ctx("Add feature B in parallel"));
    assert.ok(amend.includes("/cto AMEND"), "amend contract for the second task");
    assert.ok(amend.includes("Add feature B in parallel"), "new task echoed");
    assert.ok(amend.includes("Do NOT start a second run"), "single orchestrator rule");
    assert.ok(amend.includes("amended_at"), "state amendment required");
    assert.ok(notifyCalls.some((m) => m.includes("amending run")), "notify announces the amend");

    // Finished run -> fresh again.
    const active = findActiveCtoRun(root);
    assert.ok(active);
    setCtoPause(active.state, "done", "done", root);
    const freshAgain = ctoCommand(ctx("Add feature C"));
    assert.ok(freshAgain.includes("/cto workflow"));
    assert.ok(!freshAgain.includes("AMEND"));
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
      { task: "Task B", autonomous: true, issue: null, branch: "main" },
      root,
      { runId: res.plan.id, state: res.state },
    );
    assert.ok(prompt.includes(`Run: \`${res.plan.id}\``));
    assert.ok(prompt.includes("Autonomous mode: ON"));
    assert.ok(prompt.includes("Integration covers ALL teams"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
