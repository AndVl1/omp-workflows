/** Focused behavioral tests for the `/session-report` fullstack command. */

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sessionReportFactory, { parseSessionReportArgs, sessionReportTargetPath } from "../commands/session-report/index.js";
import { newCtoState, writeCtoState, type SessionReport, type TeamPlan } from "@andvl1/omp-workflows-core";

const RUN_A = "11111111-1111-4111-8111-111111111111";
const RUN_B = "22222222-2222-4222-8222-222222222222";

function makeProject(): { root: string; notifyCalls: string[] } {
  return { root: mkdtempSync(join(tmpdir(), "session-report-cmd-")), notifyCalls: [] };
}

function fakeApi(root: string): Record<string, unknown> {
  return { cwd: root, exec: async () => ({ stdout: "", stderr: "", exitCode: 0 }), typebox: {}, arktype: {}, zod: {}, pi: {} };
}

function fakeCtx(root: string, notifyCalls: string[]): Record<string, unknown> {
  return {
    cwd: root,
    ui: { notify: (message: string) => void notifyCalls.push(message) },
    hasUI: false,
    sessionManager: undefined,
    modelRegistry: undefined,
    model: undefined,
    isIdle: () => true,
    abort: () => undefined,
    hasQueuedMessages: () => false,
  };
}

function writeJson(path: string, value: unknown): void {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function canonicalState(runId: string, updatedAt: string, task = `Run ${runId}`): Record<string, unknown> {
  return {
    schema: 2,
    run_id: runId,
    run_key: runId,
    lifecycle_status: "active",
    rework_generation: 0,
    branch: `feat/${runId.slice(0, 8)}`,
    classification: { type: "FEATURE", complexity: "MEDIUM", confidence: "HIGH", workflow: "standard", autonomous: true },
    task,
    workflow_override: false,
    issue: null,
    stage_cursor: "implementation",
    stages: [
      { id: "discovery", status: "done" },
      { id: "implementation", status: "in_progress" },
      { id: "summary", status: "pending" },
    ],
    artifacts: { implementation: `.work-state/runs/${runId}/artifacts/implementation.json` },
    pause: { kind: "none", reason: "" },
    updated_at: updatedAt,
  };
}

function writeCanonicalRun(root: string, runId: string, updatedAt: string, task?: string): void {
  writeJson(join(root, `.work-state/runs/${runId}/state.json`), canonicalState(runId, updatedAt, task));
  writeJson(join(root, `.work-state/runs/${runId}/artifacts/implementation.json`), {
    title: "Implementation plan",
    summary: `Plan for ${runId}`,
    steps: ["wire command", "verify output"],
  });
}

function writeLegacyFeature(root: string, slug: string): void {
  writeJson(join(root, `.work-state/features/${slug}/state.json`), {
    schema: 1,
    branch: `feat/${slug}`,
    classification: { type: "FEATURE", complexity: "MEDIUM", confidence: "HIGH", workflow: "standard", autonomous: true },
    task: `Legacy ${slug}`,
    stages: [],
    artifacts: {},
    pause: { kind: "none", reason: "" },
    updated_at: "2026-08-08T10:00:00.000Z",
  });
}

function writeCtoFixture(root: string, runId: string): void {
  const task = "Decompose the payments migration";
  const plan: TeamPlan = {
    id: runId,
    task,
    created_at: "2026-08-08T10:00:00.000Z",
    teams: [
      { team: "backend", scope: ["**/*.kt"], slice: "API", profile: "full-feature", worktree: "same_branch", depends_on: [] },
      { team: "web", scope: ["**/*.tsx"], slice: "Frontend", profile: "standard", worktree: "same_branch", depends_on: ["backend"] },
    ],
  };
  const state = newCtoState({
    id: runId,
    task,
    branch: "feat/payments",
    autonomous: false,
    plan,
  });
  state.teams[0]!.status = "done";
  state.teams[0]!.dod_path = `.work-state/cto/${runId}/teams/backend/dod.json`;
  state.teams[1]!.status = "parked";
  state.teams[1]!.escalations = {
    "esc-1": { status: "pending", sent_at: "2026-08-08T11:00:00.000Z" },
  };
  state.integration = { status: "in_progress", note: "waiting for web" };
  state.pause = { kind: "background_wait", reason: "escalation pending" };
  writeCtoState(state, root);
}

test("command: parses explicit canonical run/revision and exact CTO arguments", () => {
  assert.deepEqual(parseSessionReportArgs([]), { selector: {}, options: {} });
  assert.deepEqual(parseSessionReportArgs(["do-work", `id=${RUN_A}`, "revision=rev-7", "--full"]), {
    selector: { kind: "do-work", id: RUN_A }, revision_id: "rev-7", options: { includeFullArtifacts: true },
  });
  assert.deepEqual(parseSessionReportArgs(["cto", "id=run-9"]), { selector: { kind: "cto", id: "run-9" }, options: {} });
  assert.ok(parseSessionReportArgs(["--full", "--full"]).error?.includes("duplicate --full"));
  assert.ok(parseSessionReportArgs(["revision=../escape"]).error?.includes("unsafe revision"));
  assert.ok(parseSessionReportArgs(["oops"]).error?.includes("unknown argument"));
});

test("command: chooses canonical run/revision and per-CTO target paths", () => {
  const canonicalReport = { kind: "do-work", source: { id: RUN_A, isLegacy: false } } as SessionReport;
  const ctoReport = { kind: "cto", source: { id: "run-9", isLegacy: false } } as SessionReport;
  assert.equal(sessionReportTargetPath(canonicalReport), `.work-state/runs/${RUN_A}/report.html`);
  assert.equal(sessionReportTargetPath(canonicalReport, "rev-7"), `.work-state/runs/${RUN_A}/revisions/rev-7/report.html`);
  assert.throws(() => sessionReportTargetPath(canonicalReport, "../escape"), /unsafe revision/);
  assert.equal(sessionReportTargetPath(ctoReport), ".work-state/cto/run-9/report.html");
});

test("command: /session-report factory boots", () => {
  const cmd = sessionReportFactory(fakeApi(process.cwd()) as never);
  assert.equal(cmd.name, "session-report");
  assert.ok(cmd.description.includes("/session-report"));
});

test("command: explicit canonical A/B selections write each requested report", async () => {
  const { root, notifyCalls } = makeProject();
  writeCanonicalRun(root, RUN_A, "2026-08-08T10:00:00.000Z");
  writeCanonicalRun(root, RUN_B, "2026-08-09T10:00:00.000Z");
  const cmd = sessionReportFactory(fakeApi(root) as never);

  const a = await cmd.execute(["do-work", `id=${RUN_A}`], fakeCtx(root, notifyCalls) as never);
  assert.match(a, /Session report written/);
  assert.ok(existsSync(join(root, `.work-state/runs/${RUN_A}/report.html`)));
  assert.ok(!existsSync(join(root, `.work-state/runs/${RUN_B}/report.html`)));
  const b = await cmd.execute(["do-work", `id=${RUN_B}`], fakeCtx(root, notifyCalls) as never);
  assert.match(b, /Session report written/);
  assert.ok(existsSync(join(root, `.work-state/runs/${RUN_B}/report.html`)));
  assert.ok(existsSync(join(root, `.work-state/runs/${RUN_A}/report.html`)));
  assert.equal(notifyCalls.length, 2);
  rmSync(root, { recursive: true, force: true });
});

test("command: explicit canonical revision writes beneath the revision namespace", async () => {
  const { root } = makeProject();
  writeCanonicalRun(root, RUN_A, "2026-08-08T10:00:00.000Z", "current");
  writeJson(join(root, `.work-state/runs/${RUN_A}/revisions/rev-7/state.json`), canonicalState(RUN_A, "2026-08-11T10:00:00.000Z", "revision"));
  writeJson(join(root, `.work-state/runs/${RUN_A}/revisions/rev-7/artifacts/implementation.json`), { title: "Revision plan" });
  const cmd = sessionReportFactory(fakeApi(root) as never);
  const result = await cmd.execute(["do-work", `id=${RUN_A}`, "revision=rev-7"], fakeCtx(root, []) as never);
  assert.match(result, /Session report written/);
  assert.ok(existsSync(join(root, `.work-state/runs/${RUN_A}/revisions/rev-7/report.html`)));
  rmSync(root, { recursive: true, force: true });
});

test("command: missing ordinary identity and legacy feature state require migration", async () => {
  const { root } = makeProject();
  writeLegacyFeature(root, "report-test");
  const cmd = sessionReportFactory(fakeApi(root) as never);
  for (const args of [[], ["do-work"], ["do-work", "id=report-test"], ["id=ghost"]]) {
    const result = await cmd.execute(args, fakeCtx(root, []) as never);
    assert.match(result, /migration_required/);
  }
  assert.ok(!existsSync(join(root, ".work-state", "report.html")));
  rmSync(root, { recursive: true, force: true });
});

test("command: exact CTO reports remain supported while bare CTO is unavailable", async () => {
  const { root } = makeProject();
  writeCtoFixture(root, "run-1");
  const cmd = sessionReportFactory(fakeApi(root) as never);
  const bare = await cmd.execute(["cto"], fakeCtx(root, []) as never);
  assert.match(bare, /canonical-unavailable/);
  assert.ok(!existsSync(join(root, ".work-state", "cto", "run-1", "report.html")));
  const exact = await cmd.execute(["cto", "id=run-1"], fakeCtx(root, []) as never);
  assert.match(exact, /Session report written/);
  const target = join(root, ".work-state", "cto", "run-1", "report.html");
  assert.ok(existsSync(target));
  const html = readFileSync(target, "utf8");
  assert.ok(html.includes("CTO team &amp; dependency graph"));
  assert.ok(html.includes("backend"));
  rmSync(root, { recursive: true, force: true });
});

test("command: unknown arguments never write", async () => {
  const { root } = makeProject();
  const cmd = sessionReportFactory(fakeApi(root) as never);
  const result = await cmd.execute(["nope"], fakeCtx(root, []) as never);
  assert.match(result, /ERROR: unknown argument: nope/);
  assert.ok(!existsSync(join(root, ".work-state")));
  rmSync(root, { recursive: true, force: true });
});
