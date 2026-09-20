/**
 * Focused tests for the `/workflow-view` fullstack custom-TS command.
 *
 * The command is a thin orchestration shell over the core visualize API.
 * These tests retain pure legacy/CTO selection coverage, verify migration
 * gating for ordinary legacy state, and cover the supported CTO/error paths.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import workflowViewFactory, {
  formatWorkflowViewStatus,
  parseWorkflowViewArgs,
  selectWorkflowSessions,
} from "../commands/workflow-view/index.js";
import {
  VISUALIZE_OUTPUT_ROOT,
  listSessions,
  sessionPagePath,
} from "@andvl1/omp-workflows-core";
import type { VisualizationSnapshot } from "@andvl1/omp-workflows-core";
function makeProject(): { root: string; notifyCalls: string[] } {
  const root = mkdtempSync(join(tmpdir(), "workflow-view-cmd-"));
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

function writeJson(path: string, value: unknown): void {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, JSON.stringify(value, null, 2), "utf8");
}

const STANDARD_STATE = {
  schema: 1,
  branch: "feat/view-test",
  classification: {
    type: "FEATURE",
    complexity: "MEDIUM",
    confidence: "HIGH",
    workflow: "standard",
    autonomous: true,
    autonomous_reason: "well-scoped",
  },
  task: "Build the /workflow-view command",
  workflow_override: false,
  issue: null,
  stage_cursor: "implementation",
  stages: [
    { id: "discovery", status: "done" },
    { id: "exploration", status: "done" },
    { id: "clarify", status: "done" },
    { id: "architecture", status: "done" },
    { id: "implementation", status: "in_progress" },
    { id: "code_review", status: "pending" },
    { id: "review_fixes", status: "pending" },
    { id: "manual_qa", status: "pending" },
    { id: "qa_tests", status: "pending" },
    { id: "summary", status: "pending" },
  ],
  artifacts: {},
  pause: { kind: "none", reason: "" },
  updated_at: "2026-08-08T10:00:00.000Z",
};

const IMPLEMENTATION_ARTIFACT = {
  title: "Implementation plan",
  summary: "Wire the command end to end",
  steps: ["wire command", "add tests", "verify bundle"],
};

/** Standard-workflow feature fixture: state + implementation artifact. */
function writeFeatureFixture(root: string, slug: string, overrides: Record<string, unknown> = {}): void {
  const state = { ...STANDARD_STATE, ...overrides, artifacts: { implementation: `.work-state/features/${slug}/artifacts/implementation.json` } };
  writeJson(join(root, `.work-state/features/${slug}/state.json`), state);
  writeJson(join(root, `.work-state/features/${slug}/artifacts/implementation.json`), IMPLEMENTATION_ARTIFACT);
}

/** Legacy root fixture (team-state.json, no artifacts). */
function writeLegacyFixture(root: string, overrides: Record<string, unknown> = {}): void {
  writeJson(join(root, ".work-state/team-state.json"), { ...STANDARD_STATE, ...overrides, artifacts: {} });
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
    ],
  },
  teams: [
    { id: "backend", status: "done", escalations: {}, dod_path: ".work-state/cto/run-1/teams/backend/dod.json" },
  ],
  integration: { status: "in_progress", note: "waiting for web" },
  pause: { kind: "background_wait", reason: "escalation pending" },
  updated_at: "2026-08-10T11:00:00.000Z",
};

/** CTO run fixture (JSON state; dod declared but absent). */
function writeCtoFixture(root: string, runId: string, updatedAt = CTO_STATE.updated_at): void {
  writeJson(join(root, `.work-state/cto/${runId}/state.json`), { ...CTO_STATE, id: runId, updated_at: updatedAt });
}

/** Bug-fix fixture: compact depth policy — bodies hidden unless --full. */
const BUG_FIX_STATE = {
  schema: 1,
  branch: "fix/empty-input",
  classification: {
    type: "BUG_FIX",
    complexity: "QUICK",
    confidence: "HIGH",
    workflow: "bug-fix",
    autonomous: false,
  },
  task: "Fix the empty input crash",
  workflow_override: false,
  issue: null,
  stage_cursor: "implementation",
  stages: [
    { id: "discovery", status: "done" },
    { id: "diagnose", status: "done" },
    { id: "implementation", status: "done" },
    { id: "review", status: "in_progress" },
    { id: "manual_qa", status: "pending" },
    { id: "summary", status: "pending" },
  ],
  artifacts: {},
  pause: { kind: "none", reason: "" },
  updated_at: "2026-08-08T12:00:00.000Z",
};

const BUG_FIX_ARTIFACT = {
  title: "Fix plan",
  summary: "Validate the input",
  steps: ["guard empty string", "add regression test"],
};

function writeBugFixFixture(root: string, slug: string): void {
  writeJson(join(root, `.work-state/features/${slug}/state.json`), {
    ...BUG_FIX_STATE,
    artifacts: { implementation: `.work-state/features/${slug}/artifacts/implementation.json` },
  });
  writeJson(join(root, `.work-state/features/${slug}/artifacts/implementation.json`), BUG_FIX_ARTIFACT);
}

// ── Argument parsing ────────────────────────────────────────────────────────

test("command: parses /workflow-view arguments", () => {
  assert.deepEqual(parseWorkflowViewArgs([]), { selector: {}, options: {} });
  assert.deepEqual(parseWorkflowViewArgs(["do-work"]), { selector: { kind: "do-work" }, options: {} });
  assert.deepEqual(parseWorkflowViewArgs(["cto"]), { selector: { kind: "cto" }, options: {} });
  assert.deepEqual(parseWorkflowViewArgs(["legacy"]), { selector: { kind: "legacy" }, options: {} });
  assert.deepEqual(parseWorkflowViewArgs(["id=my-feature"]), { selector: { id: "my-feature" }, options: {} });
  assert.deepEqual(parseWorkflowViewArgs(["--all"]), { selector: { all: true }, options: {} });
  assert.deepEqual(parseWorkflowViewArgs(["--full"]), { selector: {}, options: { full: true } });
  assert.deepEqual(parseWorkflowViewArgs(["cto", "id=run-9", "--full"]), {
    selector: { kind: "cto", id: "run-9" },
    options: { full: true },
  });
  assert.deepEqual(parseWorkflowViewArgs(["do-work", "--all"]), { selector: { kind: "do-work", all: true }, options: {} });

  const unknown = parseWorkflowViewArgs(["oops"]);
  assert.ok(unknown.error?.includes("unknown argument: oops"));
  const duplicateKind = parseWorkflowViewArgs(["do-work", "cto"]);
  assert.ok(duplicateKind.error?.includes("duplicate session kind: cto"));
  const duplicateId = parseWorkflowViewArgs(["id=a", "id=b"]);
  assert.ok(duplicateId.error?.includes("duplicate id: id=b"));
  const duplicateAll = parseWorkflowViewArgs(["--all", "--all"]);
  assert.ok(duplicateAll.error?.includes("duplicate --all"));
  const duplicateFull = parseWorkflowViewArgs(["--full", "--full"]);
  assert.ok(duplicateFull.error?.includes("duplicate --full"));
  const emptyId = parseWorkflowViewArgs(["id="]);
  assert.ok(emptyId.error?.includes("empty id"));
  const unsafeId = parseWorkflowViewArgs(["id=../escape"]);
  assert.ok(unsafeId.error?.includes("unsafe id: ../escape"));
  const unsafeId2 = parseWorkflowViewArgs(["id=a b"]);
  assert.ok(unsafeId2.error?.includes("unsafe id: a b"));
  const allWithId = parseWorkflowViewArgs(["--all", "id=x"]);
  assert.ok(allWithId.error?.includes("mutually exclusive"));
});

// ── Selection semantics (latest/selected/all) ───────────────────────────────

test("command: selects latest, latest-within-kind, exact id, and all", () => {
  const { root } = makeProject();
  writeFeatureFixture(root, "alpha", { updated_at: "2026-08-08T10:00:00.000Z" });
  writeFeatureFixture(root, "beta", { task: "Beta feature", updated_at: "2026-08-09T10:00:00.000Z" });
  writeCtoFixture(root, "run-1", "2026-08-10T11:00:00.000Z");
  writeLegacyFixture(root, { updated_at: "2026-08-07T10:00:00.000Z" });

  const entries = listSessions(root);

  // latest across all kinds: newest updated_at wins (cto run-1).
  const latest = selectWorkflowSessions(entries, {});
  assert.equal(latest.scope, "selected");
  assert.equal(latest.entries.length, 1);
  assert.equal(latest.entries[0]!.id, "run-1");
  assert.equal(latest.entries[0]!.kind, "cto");

  // latest within kind: do-work → beta; cto → run-1; legacy → the root.
  const latestDoWork = selectWorkflowSessions(entries, { kind: "do-work" });
  assert.deepEqual(latestDoWork.entries.map((e) => [e.id, e.isLegacy]), [["beta", false]]);
  const latestCto = selectWorkflowSessions(entries, { kind: "cto" });
  assert.equal(latestCto.entries[0]!.id, "run-1");
  const latestLegacy = selectWorkflowSessions(entries, { kind: "legacy" });
  assert.deepEqual(latestLegacy.entries.map((e) => [e.id, e.isLegacy]), [["legacy", true]]);

  // exact id (optionally kind-scoped).
  const byId = selectWorkflowSessions(entries, { id: "alpha" });
  assert.deepEqual(byId.entries.map((e) => e.id), ["alpha"]);
  const byKindAndId = selectWorkflowSessions(entries, { kind: "cto", id: "run-1" });
  assert.deepEqual(byKindAndId.entries.map((e) => e.id), ["run-1"]);
  // id=legacy resolves the legacy root, never a feature slug.
  const idLegacy = selectWorkflowSessions(entries, { id: "legacy" });
  assert.deepEqual(idLegacy.entries.map((e) => [e.id, e.isLegacy]), [["legacy", true]]);

  // all: every discoverable session, or all of one kind.
  const all = selectWorkflowSessions(entries, { all: true });
  assert.equal(all.scope, "all");
  assert.equal(all.entries.length, 4);
  const allDoWork = selectWorkflowSessions(entries, { kind: "do-work", all: true });
  assert.equal(allDoWork.scope, "all");
  assert.equal(allDoWork.entries.length, 3);
  rmSync(root, { recursive: true, force: true });
});

test("command: unknown id lists discoverable sessions; empty workspace errors", () => {
  const { root } = makeProject();
  writeFeatureFixture(root, "alpha");
  writeCtoFixture(root, "run-1");

  const entries = listSessions(root);
  const missing = selectWorkflowSessions(entries, { id: "ghost" });
  assert.ok(missing.error);
  assert.ok(missing.error!.includes("session not found: ghost"));
  assert.ok(missing.error!.includes("discoverable sessions: cto/run-1, feature/alpha"), "lists discoverable ids");
  assert.equal(missing.entries.length, 0);

  const kindMissing = selectWorkflowSessions(entries, { kind: "cto", id: "ghost" });
  assert.ok(kindMissing.error!.includes("session not found: ghost (kind cto)"));

  const empty = selectWorkflowSessions([], {});
  assert.ok(empty.error!.includes("no workflow sessions found"));
  const emptyAll = selectWorkflowSessions([], { all: true });
  assert.equal(emptyAll.entries.length, 0);
  rmSync(root, { recursive: true, force: true });
});

// ── Factory + end-to-end against real core ──────────────────────────────────

test("command: /workflow-view factory boots", () => {
  const cmd = workflowViewFactory(fakeApi(process.cwd()) as never);
  assert.equal(cmd.name, "workflow-view");
  assert.ok(cmd.description.includes("/workflow-view [do-work|cto|legacy]"));
});

test("command: bare ordinary view requires an explicit canonical run after cutover", async () => {
  const { root, notifyCalls } = makeProject();
  writeFeatureFixture(root, "alpha", { updated_at: "2026-08-08T10:00:00.000Z" });
  const cmd = workflowViewFactory(fakeApi(root) as never);
  const result = await cmd.execute([], fakeCtx(root, notifyCalls) as never);

  assert.match(result, /migration_required/);
  assert.ok(!existsSync(join(root, VISUALIZE_OUTPUT_ROOT)), "legacy ordinary state is not rendered");
  assert.equal(notifyCalls.length, 0, "migration failure does not notify as success");
  rmSync(root, { recursive: true, force: true });
});

test("command: CTO view remains supported while ordinary feature view is migration-gated", async () => {
  const { root } = makeProject();
  writeFeatureFixture(root, "alpha");
  writeCtoFixture(root, "run-1");
  const cmd = workflowViewFactory(fakeApi(root) as never);

  const ordinary = await cmd.execute(["do-work", "id=alpha"], fakeCtx(root, []) as never);
  assert.match(ordinary, /migration_required/);
  assert.ok(!existsSync(join(root, VISUALIZE_OUTPUT_ROOT)), "ordinary legacy state is not rendered");

  const byKind = await cmd.execute(["cto"], fakeCtx(root, []) as never);
  const viz = join(root, VISUALIZE_OUTPUT_ROOT);
  assert.ok(existsSync(join(viz, sessionPagePath("cto", "run-1", "html"))));
  assert.ok(!byKind.includes("cto/run-1"), "status stays safe (no raw ids in path claims)");

  const conflict = await cmd.execute(["--all", "id=alpha"], fakeCtx(root, []) as never);
  assert.ok(conflict.startsWith("ERROR: --all is mutually exclusive with id="));
  assert.ok(conflict.includes("Usage: /workflow-view"));
  rmSync(root, { recursive: true, force: true });
});

test("command: --all ordinary view requires canonical runs after cutover", async () => {
  const { root } = makeProject();
  writeFeatureFixture(root, "alpha");
  writeCtoFixture(root, "run-1");
  const cmd = workflowViewFactory(fakeApi(root) as never);

  const result = await cmd.execute(["--all"], fakeCtx(root, []) as never);
  assert.match(result, /migration_required/);
  assert.ok(!existsSync(join(root, VISUALIZE_OUTPUT_ROOT)));
  rmSync(root, { recursive: true, force: true });
});

test("command: legacy viewer input requires migration while CTO remains namespaced", async () => {
  const { root } = makeProject();
  writeLegacyFixture(root);
  writeCtoFixture(root, "run-1");
  const cmd = workflowViewFactory(fakeApi(root) as never);

  const legacyResult = await cmd.execute(["legacy"], fakeCtx(root, []) as never);
  assert.match(legacyResult, /migration_required/);
  assert.ok(!existsSync(join(root, VISUALIZE_OUTPUT_ROOT)), "legacy root is not rendered");

  const ctoResult = await cmd.execute(["cto", "id=run-1", "--all"], fakeCtx(root, []) as never);
  assert.ok(ctoResult.startsWith("ERROR: --all is mutually exclusive with id="), "id= still rejects --all");
  const ctoOk = await cmd.execute(["cto", "id=run-1"], fakeCtx(root, []) as never);
  assert.ok(existsSync(join(root, VISUALIZE_OUTPUT_ROOT, sessionPagePath("cto", "run-1", "html"))), "cto page written");
  assert.ok(!ctoOk.includes("run-1"), "status does not leak raw ids into path claims");
  rmSync(root, { recursive: true, force: true });
});

test("command: ordinary reruns remain migration-gated", async () => {
  const { root } = makeProject();
  writeFeatureFixture(root, "alpha");
  const cmd = workflowViewFactory(fakeApi(root) as never);

  const first = await cmd.execute(["id=alpha"], fakeCtx(root, []) as never);
  const second = await cmd.execute(["id=alpha"], fakeCtx(root, []) as never);
  assert.match(first, /migration_required/);
  assert.match(second, /migration_required/);
  assert.ok(!existsSync(join(root, VISUALIZE_OUTPUT_ROOT)));
  rmSync(root, { recursive: true, force: true });
});

test("command: source mutation remains migration-gated until canonical import", async () => {
  const { root } = makeProject();
  writeFeatureFixture(root, "alpha", { task: "Build the /workflow-view command" });
  const cmd = workflowViewFactory(fakeApi(root) as never);

  const first = await cmd.execute(["do-work", "id=alpha"], fakeCtx(root, []) as never);
  writeFeatureFixture(root, "alpha", { task: "Build the /workflow-view command v2" });
  const second = await cmd.execute(["do-work", "id=alpha"], fakeCtx(root, []) as never);
  assert.match(first, /migration_required/);
  assert.match(second, /migration_required/);
  assert.ok(!existsSync(join(root, VISUALIZE_OUTPUT_ROOT)));
  rmSync(root, { recursive: true, force: true });
});

test("command: ordinary full/stale view requests remain migration-gated", async () => {
  const { root } = makeProject();
  writeBugFixFixture(root, "bugfix");
  writeFeatureFixture(root, "alpha", { updated_at: "2099-01-01T00:00:00.000Z" });
  const cmd = workflowViewFactory(fakeApi(root) as never);

  const full = await cmd.execute(["do-work", "id=bugfix", "--full"], fakeCtx(root, []) as never);
  const stale = await cmd.execute(["id=alpha"], fakeCtx(root, []) as never);
  assert.match(full, /migration_required/);
  assert.match(stale, /migration_required/);
  assert.ok(!existsSync(join(root, VISUALIZE_OUTPUT_ROOT)));
  rmSync(root, { recursive: true, force: true });
});

test("command: formatWorkflowViewStatus stays safe and deterministic", () => {
  const snapshot = {
    schema: 1,
    scope: "selected",
    generatedAt: "2026-08-19T00:00:00.000Z",
    renderer: { name: "omp-workflows-visualize", version: "1.0.0" },
    sessions: [],
    manifest: {
      schema: 1,
      scope: "selected",
      generatedAt: "2026-08-19T00:00:00.000Z",
      renderer: { name: "omp-workflows-visualize", version: "1.0.0" },
      sessions: [],
      counts: {
        discoveredSessions: 1,
        generatedSessions: 1,
        generatedPages: 4,
        staleSessions: 0,
        degradedSessions: 0,
        artifactTotal: 2,
        deadLinks: 0,
      },
    },
    warnings: [],
  } as unknown as VisualizationSnapshot;
  const status = formatWorkflowViewStatus(snapshot, {
    status: "published",
    files: [`${VISUALIZE_OUTPUT_ROOT}/index.md`],
    pruned: [],
    counters: { filesWritten: 4, bytesWritten: 0, filesPruned: 0 },
    warnings: [],
  });
  assert.ok(status.includes(".work-state/visualize"));
  assert.ok(status.includes("1 session generated (1 discovered)"));
  assert.ok(status.includes("2 artifacts"));
  assert.ok(status.includes("0 warnings"));
  assert.ok(status.includes("index.md · index.html · manifest.json"));
  assert.ok(!status.includes("/Users/") && !status.includes("tmp"), "no absolute paths");
});

// ── Error paths ─────────────────────────────────────────────────────────────

test("command: unknown/duplicate arguments return usage and write nothing", async () => {
  const { root } = makeProject();
  writeFeatureFixture(root, "alpha");
  const cmd = workflowViewFactory(fakeApi(root) as never);

  for (const args of [["nope"], ["do-work", "cto"], ["id=a", "id=b"], ["--all", "--all"], ["--full", "--full"], ["id="], ["id=../escape"], ["--all", "id=alpha"]]) {
    const result = await cmd.execute(args, fakeCtx(root, []) as never);
    assert.ok(result.startsWith("ERROR:"), `args ${args.join(" ")} error`);
    assert.ok(result.includes("Usage: /workflow-view"), `args ${args.join(" ")} show usage`);
    assert.ok(!existsSync(join(root, VISUALIZE_OUTPUT_ROOT)), `args ${args.join(" ")} write nothing`);
  }
  rmSync(root, { recursive: true, force: true });
});

test("command: unknown ordinary session id requires canonical import", async () => {
  const { root } = makeProject();
  writeFeatureFixture(root, "alpha");
  writeCtoFixture(root, "run-1");
  const cmd = workflowViewFactory(fakeApi(root) as never);

  const result = await cmd.execute(["id=ghost"], fakeCtx(root, []) as never);
  assert.match(result, /migration_required/);
  assert.ok(!existsSync(join(root, VISUALIZE_OUTPUT_ROOT)), "nothing written");
  rmSync(root, { recursive: true, force: true });
});

test("command: empty ordinary workspace requires migration and creates nothing", async () => {
  const { root } = makeProject();
  const cmd = workflowViewFactory(fakeApi(root) as never);

  const bare = await cmd.execute([], fakeCtx(root, []) as never);
  assert.match(bare, /migration_required/);
  assert.ok(!existsSync(join(root, ".work-state")), "no .work-state created on failure");

  const all = await cmd.execute(["--all"], fakeCtx(root, []) as never);
  assert.match(all, /migration_required/);
  assert.ok(!existsSync(join(root, ".work-state")), "--all also creates nothing");
  rmSync(root, { recursive: true, force: true });
});

test("command: ordinary write requests remain migration-gated", async () => {
  const { root } = makeProject();
  writeFeatureFixture(root, "alpha");
  const cmd = workflowViewFactory(fakeApi(root) as never);

  const result = await cmd.execute(["id=alpha"], fakeCtx(root, []) as never);
  assert.match(result, /migration_required/);
  assert.ok(!existsSync(join(root, VISUALIZE_OUTPUT_ROOT)));
  rmSync(root, { recursive: true, force: true });
});
