/**
 * Focused tests for the `/session-report` fullstack custom-TS command
 * (pragmatic architecture, frontend slice).
 *
 * The command is a thin orchestration shell over the core report API
 * (buildSessionReport → renderReportHtml → writeReport). These tests drive
 * the real command factory with fake CustomCommandAPI/HookCommandContext and
 * real core functions against temp project roots:
 *   - argument parsing (bare / kind / id= / --full / errors)
 *   - per-feature, legacy, and per-CTO target-path selection
 *   - static overwrite semantics (re-run rewrites the same path)
 *   - error paths never write a report
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sessionReportFactory, {
  parseSessionReportArgs,
  sessionReportTargetPath,
} from "../commands/session-report/index.js";
import type { SessionReport } from "@andvl1/omp-workflows-core";

function makeProject(): { root: string; notifyCalls: string[] } {
  const root = mkdtempSync(join(tmpdir(), "session-report-cmd-"));
  return { root, notifyCalls: [] };
}

function fakeApi(root: string): Record<string, unknown> {
  return {
    cwd: root,
    exec: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
    typebox: {},
    arktype: {},
    zod: {},
    pi: {},
  };
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

const TEAM_STATE = {
  schema: 1,
  branch: "feat/report-test",
  classification: {
    type: "FEATURE",
    complexity: "MEDIUM",
    confidence: "HIGH",
    workflow: "standard",
    autonomous: true,
    autonomous_reason: "well-scoped",
  },
  task: "Build the /session-report command",
  workflow_override: false,
  issue: null,
  stage_cursor: "code_review",
  stages: [
    { id: "discovery", status: "done" },
    { id: "exploration", status: "done" },
    { id: "clarify", status: "done" },
    { id: "architecture", status: "done" },
    { id: "implementation", status: "done" },
    { id: "code_review", status: "in_progress" },
    { id: "review_fixes", status: "pending" },
    { id: "manual_qa", status: "pending" },
    { id: "qa_tests", status: "pending" },
    { id: "summary", status: "pending" },
  ],
  artifacts: {},
  pause: { kind: "none", reason: "" },
  updated_at: "2026-08-08T10:00:00.000Z",
};

function writeDoWorkFixture(root: string, slug: string): void {
  const wsDir = join(root, ".work-state");
  const featureDir = join(wsDir, "features", slug);
  mkdirSync(join(featureDir, "artifacts"), { recursive: true });
  writeFileSync(join(wsDir, ".active-feature"), `${slug}\n`, "utf8");
  writeFileSync(join(featureDir, "state.json"), JSON.stringify(TEAM_STATE, null, 2), "utf8");
  writeFileSync(
    join(featureDir, "artifacts", "implementation.json"),
    JSON.stringify({ title: "Implementation plan", steps: ["wire command", "add tests"] }, null, 2),
    "utf8",
  );
}

const CTO_STATE = {
  schema: 2,
  id: "run-1",
  task: "Decompose the payments migration",
  branch: "feat/payments",
  autonomous: false,
  plan: {
    teams: [
      { team: "backend", scope: ["**/*.kt"], slice: "API", profile: "full-feature", worktree: "same_branch", depends_on: [] },
      { team: "web", scope: ["**/*.tsx"], slice: "Frontend", profile: "standard", worktree: "same_branch", depends_on: ["backend"] },
    ],
  },
  teams: [
    { id: "backend", status: "done", escalations: {}, dod_path: ".work-state/cto/run-1/teams/backend/dod.json" },
    { id: "web", status: "parked", escalations: { "esc-1": { id: "esc-1" } } },
  ],
  integration: { status: "in_progress", note: "waiting for web" },
  pause: { kind: "background_wait", reason: "escalation pending" },
  updated_at: "2026-08-08T11:00:00.000Z",
};

function writeCtoFixture(root: string, runId: string): void {
  const runDir = join(root, ".work-state", "cto", runId);
  mkdirSync(runDir, { recursive: true });
  writeFileSync(join(runDir, "state.json"), JSON.stringify(CTO_STATE, null, 2), "utf8");
}

// ── Argument parsing ────────────────────────────────────────────────────────

test("command: parses /session-report arguments", () => {
  assert.deepEqual(parseSessionReportArgs([]), { selector: {}, options: {} });
  assert.deepEqual(parseSessionReportArgs(["do-work"]), { selector: { kind: "do-work" }, options: {} });
  assert.deepEqual(parseSessionReportArgs(["cto"]), { selector: { kind: "cto" }, options: {} });
  assert.deepEqual(parseSessionReportArgs(["id=my-feature"]), { selector: { id: "my-feature" }, options: {} });
  assert.deepEqual(parseSessionReportArgs(["do-work", "id=my-feature", "--full"]), {
    selector: { kind: "do-work", id: "my-feature" },
    options: { includeFullArtifacts: true },
  });

  const unknown = parseSessionReportArgs(["oops"]);
  assert.ok(unknown.error?.includes("unknown argument: oops"));
  const duplicate = parseSessionReportArgs(["do-work", "cto"]);
  assert.ok(duplicate.error?.includes("duplicate session kind"));
  const emptyId = parseSessionReportArgs(["id="]);
  assert.ok(emptyId.error?.includes("empty id"));
});

test("command: chooses per-feature, legacy, and per-CTO target paths", () => {
  const featureReport = {
    kind: "do-work",
    source: { id: "my-feature", isLegacy: false },
  } as SessionReport;
  const legacyReport = {
    kind: "do-work",
    source: { id: "legacy", isLegacy: true },
  } as SessionReport;
  const ctoReport = {
    kind: "cto",
    source: { id: "run-9", isLegacy: false },
  } as SessionReport;

  assert.equal(sessionReportTargetPath(featureReport), ".work-state/features/my-feature/report.html");
  assert.equal(sessionReportTargetPath(legacyReport), ".work-state/report.html");
  assert.equal(sessionReportTargetPath(ctoReport), ".work-state/cto/run-9/report.html");
});

// ── Factory + end-to-end against real core ──────────────────────────────────

test("command: /session-report factory boots", () => {
  const cmd = sessionReportFactory(fakeApi(process.cwd()) as never);
  assert.equal(cmd.name, "session-report");
  assert.ok(cmd.description.includes("/session-report [do-work|cto]"));
});

test("command: bare invocation auto-detects the latest do-work session and writes the feature report", async () => {
  const { root, notifyCalls } = makeProject();
  writeDoWorkFixture(root, "report-test");
  const cmd = sessionReportFactory(fakeApi(root) as never);
  const result = await cmd.execute([], fakeCtx(root, notifyCalls) as never);

  const target = join(root, ".work-state", "features", "report-test", "report.html");
  assert.ok(existsSync(target), "report.html written under .work-state/features/<slug>/");
  const html = readFileSync(target, "utf8");
  assert.ok(html.startsWith("<!doctype html>"), "report is a standalone HTML file");
  assert.ok(html.includes("Build the /session-report command"), "task rendered");
  assert.ok(result.includes(".work-state/features/report-test/report.html"), "status names the output path");
  assert.ok(result.includes("report-test"), "status names the session id");
  assert.equal(notifyCalls.length, 1, "user notified once");
  assert.ok(notifyCalls[0]!.includes("session-report:"), "notify prefix");
  rmSync(root, { recursive: true, force: true });
});

test("command: --full embeds sanitized artifact bodies into the report", async () => {
  const { root } = makeProject();
  writeDoWorkFixture(root, "report-test");
  const cmd = sessionReportFactory(fakeApi(root) as never);
  const result = await cmd.execute(["do-work", "id=report-test", "--full"], fakeCtx(root, []) as never);

  const target = join(root, ".work-state", "features", "report-test", "report.html");
  assert.ok(existsSync(target));
  const html = readFileSync(target, "utf8");
  assert.ok(html.includes("Show full content"), "expandable artifact body present");
  assert.ok(html.includes("Implementation plan"), "sanitized body content embedded");
  assert.ok(result.startsWith("Session report written:"), "success status");
  rmSync(root, { recursive: true, force: true });
});

test("command: cto sessions write to .work-state/cto/<runId>/report.html", async () => {
  const { root } = makeProject();
  writeCtoFixture(root, "run-1");
  const cmd = sessionReportFactory(fakeApi(root) as never);

  const byKind = await cmd.execute(["cto"], fakeCtx(root, []) as never);
  const target = join(root, ".work-state", "cto", "run-1", "report.html");
  assert.ok(existsSync(target), "cto report written under .work-state/cto/<runId>/");
  const html = readFileSync(target, "utf8");
  assert.ok(html.includes("CTO team &amp; dependency graph"), "cto graph rendered");
  assert.ok(html.includes("backend"), "team node rendered");
  assert.ok(byKind.includes(".work-state/cto/run-1/report.html"));

  const byId = await cmd.execute(["cto", "id=run-1"], fakeCtx(root, []) as never);
  assert.ok(byId.startsWith("Session report written:"), "explicit id works");
  rmSync(root, { recursive: true, force: true });
});

test("command: legacy root state writes to .work-state/report.html", async () => {
  const { root } = makeProject();
  const wsDir = join(root, ".work-state");
  mkdirSync(wsDir, { recursive: true });
  writeFileSync(join(wsDir, "team-state.json"), JSON.stringify(TEAM_STATE, null, 2), "utf8");
  const cmd = sessionReportFactory(fakeApi(root) as never);

  const result = await cmd.execute(["do-work", "id=legacy"], fakeCtx(root, []) as never);
  const target = join(root, ".work-state", "report.html");
  assert.ok(existsSync(target), "legacy report written next to team-state.json");
  assert.ok(result.includes(".work-state/report.html"));
  rmSync(root, { recursive: true, force: true });
});

test("command: re-running overwrites the same report path (static snapshot semantics)", async () => {
  const { root } = makeProject();
  writeDoWorkFixture(root, "report-test");
  const cmd = sessionReportFactory(fakeApi(root) as never);
  const target = join(root, ".work-state", "features", "report-test", "report.html");

  await cmd.execute(["do-work", "id=report-test"], fakeCtx(root, []) as never);
  const firstStat = statSync(target);
  await new Promise((resolve) => setTimeout(resolve, 20));
  await cmd.execute(["do-work", "id=report-test"], fakeCtx(root, []) as never);

  const secondStat = statSync(target);
  assert.ok(secondStat.mtimeMs >= firstStat.mtimeMs, "same path rewritten on re-run");
  assert.ok(readFileSync(target, "utf8").startsWith("<!doctype html>"));
  rmSync(root, { recursive: true, force: true });
});

// ── Error paths ─────────────────────────────────────────────────────────────

test("command: unknown arguments return usage and write nothing", async () => {
  const { root } = makeProject();
  const cmd = sessionReportFactory(fakeApi(root) as never);
  const result = await cmd.execute(["nope"], fakeCtx(root, []) as never);
  assert.ok(result.startsWith("ERROR: unknown argument: nope"));
  assert.ok(result.includes("Usage: /session-report"));
  assert.ok(!existsSync(join(root, ".work-state", "report.html")));
  rmSync(root, { recursive: true, force: true });
});

test("command: unknown session id returns a build error and writes nothing", async () => {
  const { root } = makeProject();
  writeDoWorkFixture(root, "report-test");
  const cmd = sessionReportFactory(fakeApi(root) as never);
  const result = await cmd.execute(["id=ghost"], fakeCtx(root, []) as never);
  assert.ok(result.startsWith("ERROR: could not build session report"));
  assert.ok(result.includes('id "ghost"'), "error names the missing session");
  assert.ok(!existsSync(join(root, ".work-state", "features", "ghost", "report.html")));
  rmSync(root, { recursive: true, force: true });
});

test("command: empty project returns a build error", async () => {
  const { root } = makeProject();
  const cmd = sessionReportFactory(fakeApi(root) as never);
  const result = await cmd.execute([], fakeCtx(root, []) as never);
  assert.ok(result.startsWith("ERROR: could not build session report"));
  assert.ok(!existsSync(join(root, ".work-state")), "no .work-state created on failure");
  rmSync(root, { recursive: true, force: true });
});
