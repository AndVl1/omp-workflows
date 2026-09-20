/** Focused behavioral tests for the `/workflow-view` fullstack custom command. */

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import workflowViewFactory, { formatWorkflowViewStatus, parseWorkflowViewArgs, selectWorkflowSessions } from "../commands/workflow-view/index.js";
import { VISUALIZE_OUTPUT_ROOT, sessionPagePath, type CanonicalRunReportListEntry, type VisualizationSnapshot } from "@andvl1/omp-workflows-core";

const RUN_A = "11111111-1111-4111-8111-111111111111";
const RUN_B = "22222222-2222-4222-8222-222222222222";

function makeProject(): { root: string; notifyCalls: string[] } {
  return { root: mkdtempSync(join(tmpdir(), "workflow-view-cmd-")), notifyCalls: [] };
}
function fakeApi(root: string): Record<string, unknown> {
  return { cwd: root, exec: async () => ({ stdout: "", stderr: "", exitCode: 0 }), typebox: {}, arktype: {}, zod: {}, pi: {} };
}
function fakeCtx(root: string, notifyCalls: string[]): Record<string, unknown> {
  return { cwd: root, ui: { notify: (message: string) => void notifyCalls.push(message) }, hasUI: false, sessionManager: undefined, modelRegistry: undefined, model: undefined, isIdle: () => true, abort: () => undefined, hasQueuedMessages: () => false };
}
function writeJson(path: string, value: unknown): void {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}
function canonicalState(runId: string, updatedAt: string, task = `Run ${runId}`): Record<string, unknown> {
  return {
    schema: 2, run_id: runId, run_key: runId, lifecycle_status: "active", rework_generation: 0,
    branch: `feat/${runId.slice(0, 8)}`, classification: { type: "FEATURE", complexity: "MEDIUM", confidence: "HIGH", workflow: "standard", autonomous: true },
    task, workflow_override: false, issue: null, stage_cursor: "implementation",
    stages: [{ id: "discovery", status: "done" }, { id: "implementation", status: "in_progress" }, { id: "summary", status: "pending" }],
    artifacts: { implementation: `.work-state/runs/${runId}/artifacts/implementation.json` },
    pause: { kind: "none", reason: "" }, updated_at: updatedAt,
  };
}
function writeCanonicalRun(root: string, runId: string, updatedAt: string, task?: string): void {
  writeJson(join(root, `.work-state/runs/${runId}/state.json`), canonicalState(runId, updatedAt, task));
  writeJson(join(root, `.work-state/runs/${runId}/artifacts/implementation.json`), { title: "Implementation plan", summary: `Plan for ${runId}`, steps: ["wire command", "verify output"] });
}
function writeLegacyFeature(root: string, slug: string): void {
  writeJson(join(root, `.work-state/features/${slug}/state.json`), {
    schema: 1, branch: `feat/${slug}`, classification: { type: "FEATURE", complexity: "MEDIUM", confidence: "HIGH", workflow: "standard", autonomous: true },
    task: `Legacy ${slug}`, stages: [], artifacts: {}, pause: { kind: "none", reason: "" }, updated_at: "2026-08-08T10:00:00.000Z",
  });
}
function writeCtoFixture(root: string, runId: string): void {
  writeJson(join(root, `.work-state/cto/${runId}/state.json`), {
    schema: 2, id: runId, task: "Decompose the payments migration", branch: "feat/payments", autonomous: false,
    plan: { teams: [{ team: "backend", scope: ["**/*.kt"], slice: "API", profile: "full-feature", worktree: "same_branch", depends_on: [] }] },
    teams: [{ id: "backend", status: "done", escalations: {}, dod_path: `.work-state/cto/${runId}/teams/backend/dod.json` }],
    integration: { status: "in_progress", note: "waiting for web" }, pause: { kind: "background_wait", reason: "escalation pending" }, updated_at: "2026-08-10T11:00:00.000Z",
  });
}
function listEntry(runId: string, updatedAt: string): CanonicalRunReportListEntry {
  return { kind: "run", run_id: runId, revision_id: null, title: runId, task: runId, branch: "main", status: "active", stage: "implementation", updated_at: updatedAt, rework_generation: 0 };
}

test("command: parses canonical run/revision, CTO, and list selectors", () => {
  assert.deepEqual(parseWorkflowViewArgs([]), { selector: {}, options: {} });
  assert.deepEqual(parseWorkflowViewArgs(["do-work", `id=${RUN_A}`, "revision=rev-7", "--full"]), { selector: { kind: "do-work", id: RUN_A, revision: "rev-7" }, options: { full: true } });
  assert.deepEqual(parseWorkflowViewArgs(["cto", "id=run-9"]), { selector: { kind: "cto", id: "run-9" }, options: {} });
  assert.deepEqual(parseWorkflowViewArgs(["cto", "--all"]), { selector: { kind: "cto", all: true }, options: {} });
  assert.ok(parseWorkflowViewArgs(["id="]).error?.includes("empty id"));
  assert.ok(parseWorkflowViewArgs(["revision=../escape"]).error?.includes("unsafe revision"));
  assert.ok(parseWorkflowViewArgs(["--all", "revision=rev-7"]).error?.includes("mutually exclusive"));
  assert.ok(parseWorkflowViewArgs(["oops"]).error?.includes("unknown argument"));
});

test("selection: explicit A/B ids are scoped and missing identity never chooses latest", () => {
  const entries = [listEntry(RUN_B, "2026-08-09T10:00:00.000Z"), listEntry(RUN_A, "2026-08-08T10:00:00.000Z")];
  const a = selectWorkflowSessions(entries, { kind: "do-work", id: RUN_A });
  assert.deepEqual(a.entries.map((entry) => entry.kind === "run" ? entry.run_id : entry.id), [RUN_A]);
  const b = selectWorkflowSessions(entries, { kind: "do-work", id: RUN_B });
  assert.deepEqual(b.entries.map((entry) => entry.kind === "run" ? entry.run_id : entry.id), [RUN_B]);
  assert.match(selectWorkflowSessions(entries, {}).error ?? "", /explicit canonical run id/);
  assert.match(selectWorkflowSessions(entries, { kind: "do-work" }).error ?? "", /explicit canonical run id/);
  assert.equal(selectWorkflowSessions(entries, { kind: "do-work", all: true }).entries.length, 2);
});

test("command: /workflow-view factory boots", () => {
  const cmd = workflowViewFactory(fakeApi(process.cwd()) as never);
  assert.equal(cmd.name, "workflow-view");
  assert.ok(cmd.description.includes("/workflow-view"));
});

test("command: explicit canonical A/B selections render only the requested run", async () => {
  const { root, notifyCalls } = makeProject();
  writeCanonicalRun(root, RUN_A, "2026-08-08T10:00:00.000Z");
  writeCanonicalRun(root, RUN_B, "2026-08-09T10:00:00.000Z");
  const cmd = workflowViewFactory(fakeApi(root) as never);
  const a = await cmd.execute(["do-work", `id=${RUN_A}`], fakeCtx(root, notifyCalls) as never);
  assert.match(a, /Workflow view written/);
  assert.ok(existsSync(join(root, VISUALIZE_OUTPUT_ROOT, sessionPagePath("feature", RUN_A, "html"))));
  assert.ok(!existsSync(join(root, VISUALIZE_OUTPUT_ROOT, sessionPagePath("feature", RUN_B, "html"))));
  const b = await cmd.execute(["do-work", `id=${RUN_B}`], fakeCtx(root, notifyCalls) as never);
  assert.match(b, /Workflow view written/);
  assert.ok(existsSync(join(root, VISUALIZE_OUTPUT_ROOT, sessionPagePath("feature", RUN_B, "html"))));
  assert.ok(!existsSync(join(root, VISUALIZE_OUTPUT_ROOT, sessionPagePath("feature", RUN_A, "html"))));
  assert.equal(notifyCalls.length, 2);
  rmSync(root, { recursive: true, force: true });
});

test("command: explicit canonical revision is rendered from the selected revision", async () => {
  const { root } = makeProject();
  writeCanonicalRun(root, RUN_A, "2026-08-08T10:00:00.000Z", "current");
  const revisionState = canonicalState(RUN_A, "2026-08-11T10:00:00.000Z", "revision");
  revisionState.artifacts = { implementation: "artifacts/implementation.json" };
  writeJson(join(root, `.work-state/runs/${RUN_A}/revisions/rev-7/state.json`), revisionState);
  writeJson(join(root, `.work-state/runs/${RUN_A}/revisions/rev-7/artifacts/implementation.json`), { title: "Revision plan" });
  const cmd = workflowViewFactory(fakeApi(root) as never);
  const result = await cmd.execute(["do-work", `id=${RUN_A}`, "revision=rev-7"], fakeCtx(root, []) as never);
  assert.match(result, /Workflow view written/);
  const page = readFileSync(join(root, VISUALIZE_OUTPUT_ROOT, sessionPagePath("feature", RUN_A, "md")), "utf8");
  assert.ok(page.includes("revisions/rev\\-7/state\\.json"));
  rmSync(root, { recursive: true, force: true });
});

test("command: bare/legacy ordinary requests require migration and never write", async () => {
  const { root } = makeProject();
  writeLegacyFeature(root, "alpha");
  const cmd = workflowViewFactory(fakeApi(root) as never);
  for (const args of [[], ["do-work"], ["legacy"], ["do-work", "id=alpha"]]) assert.match(await cmd.execute(args, fakeCtx(root, []) as never), /migration_required/);
  assert.ok(!existsSync(join(root, VISUALIZE_OUTPUT_ROOT)));
  rmSync(root, { recursive: true, force: true });
});

test("command: exact CTO id and --all remain supported; bare CTO never chooses latest", async () => {
  const { root } = makeProject();
  writeCtoFixture(root, "run-1");
  writeCtoFixture(root, "run-2");
  const cmd = workflowViewFactory(fakeApi(root) as never);
  const bare = await cmd.execute(["cto"], fakeCtx(root, []) as never);
  assert.match(bare, /canonical-unavailable/);
  assert.ok(!existsSync(join(root, VISUALIZE_OUTPUT_ROOT)));
  assert.match(await cmd.execute(["cto", "id=run-1"], fakeCtx(root, []) as never), /Workflow view written/);
  assert.ok(existsSync(join(root, VISUALIZE_OUTPUT_ROOT, sessionPagePath("cto", "run-1", "html"))));
  assert.ok(!existsSync(join(root, VISUALIZE_OUTPUT_ROOT, sessionPagePath("cto", "run-2", "html"))));
  assert.match(await cmd.execute(["cto", "--all"], fakeCtx(root, []) as never), /Workflow view written/);
  assert.ok(existsSync(join(root, VISUALIZE_OUTPUT_ROOT, sessionPagePath("cto", "run-1", "html"))));
  assert.ok(existsSync(join(root, VISUALIZE_OUTPUT_ROOT, sessionPagePath("cto", "run-2", "html"))));
  rmSync(root, { recursive: true, force: true });
});

test("command: unknown ordinary id is migration-gated and writes nothing", async () => {
  const { root } = makeProject();
  writeCanonicalRun(root, RUN_A, "2026-08-08T10:00:00.000Z");
  const cmd = workflowViewFactory(fakeApi(root) as never);
  assert.match(await cmd.execute(["do-work", `id=${RUN_B}`], fakeCtx(root, []) as never), /migration_required/);
  assert.ok(!existsSync(join(root, VISUALIZE_OUTPUT_ROOT)));
  rmSync(root, { recursive: true, force: true });
});

test("command: formatWorkflowViewStatus stays safe and deterministic", () => {
  const snapshot = { schema: 1, scope: "selected", generatedAt: "2026-08-19T00:00:00.000Z", renderer: { name: "omp-workflows-visualize", version: "1.0.0" }, sessions: [], manifest: { schema: 1, scope: "selected", generatedAt: "2026-08-19T00:00:00.000Z", renderer: { name: "omp-workflows-visualize", version: "1.0.0" }, sessions: [], counts: { discoveredSessions: 1, generatedSessions: 1, generatedPages: 4, staleSessions: 0, degradedSessions: 0, artifactTotal: 2, deadLinks: 0 } }, warnings: [] } as unknown as VisualizationSnapshot;
  const status = formatWorkflowViewStatus(snapshot, { status: "published", files: [`${VISUALIZE_OUTPUT_ROOT}/index.md`], pruned: [], counters: { filesWritten: 4, bytesWritten: 0, filesPruned: 0 }, warnings: [] });
  assert.ok(status.includes(".work-state/visualize"));
  assert.ok(status.includes("1 session generated (1 discovered)"));
  assert.ok(status.includes("2 artifacts"));
  assert.ok(!status.includes("/Users/") && !status.includes("tmp"));
});
