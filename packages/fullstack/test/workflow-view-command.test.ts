/**
 * Focused tests for the `/workflow-view` fullstack custom-TS command
 * (visualize OPT-A, architecture-8).
 *
 * The command is a thin orchestration shell over the core visualize API:
 * `listSessions` (discovery) → `buildSessionSnapshots` (one-read normalized
 * model with redaction/caps) → `buildManifest` → Markdown/HTML serializers →
 * `preflightLinks` (zero-dead-link gate) → `publishVisualize` (whole-tree
 * atomic swap). These tests drive the real command factory with fake
 * CustomCommandAPI/HookCommandContext and real core functions against temp
 * project roots:
 *   - argument parsing (bare / kind / id= / --all / --full / errors)
 *   - latest/selected/all selection semantics incl. legacy and CTO layouts
 *   - deterministic output paths, overwrite-on-rerun, source-mutation
 *     digest/content changes
 *   - --full embeds redacted bodies where the compact policy hides them
 *   - visible partiality of selected/latest vs completeness of --all
 *   - error paths (unknown/duplicate/unsafe args, unknown id, empty
 *     workspace, write failure) never write a bundle
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
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
  VISUALIZE_OUTPUT_FILES,
  VISUALIZE_OUTPUT_ROOT,
  listSessions,
  sessionPagePath,
} from "@andvl1/omp-workflows-core";
import type { VisualizationManifest, VisualizationSnapshot } from "@andvl1/omp-workflows-core";

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

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, "utf8")) as T;
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

test("command: bare invocation renders the latest session as a visibly partial bundle", async () => {
  const { root, notifyCalls } = makeProject();
  writeFeatureFixture(root, "alpha", { updated_at: "2026-08-08T10:00:00.000Z" });
  writeFeatureFixture(root, "beta", { task: "Beta feature", updated_at: "2026-08-09T10:00:00.000Z" });
  const cmd = workflowViewFactory(fakeApi(root) as never);
  const result = await cmd.execute([], fakeCtx(root, notifyCalls) as never);

  const viz = join(root, VISUALIZE_OUTPUT_ROOT);
  assert.ok(existsSync(join(viz, "index.md")), "hub markdown written");
  assert.ok(existsSync(join(viz, "index.html")), "hub html written");
  assert.ok(existsSync(join(viz, "manifest.json")), "manifest written");
  const betaMd = sessionPagePath("feature", "beta", "md");
  const betaHtml = sessionPagePath("feature", "beta", "html");
  assert.ok(existsSync(join(viz, betaMd)), "latest session page written");
  assert.ok(existsSync(join(viz, betaHtml)), "latest session html written");
  assert.ok(!existsSync(join(viz, "sessions", "feature", "alpha.md")), "older session not generated in selected scope");

  const hub = readFileSync(join(viz, "index.html"), "utf8");
  assert.ok(hub.includes("Partial bundle"), "selected hub is visibly partial");
  assert.ok(hub.includes("selected / latest (partial)"), "hub badge marks the partial scope");
  assert.ok(hub.includes("beta feature worktree"), "hub lists the selected session");
  assert.ok(!hub.includes("alpha feature worktree"), "hub never links to the unselected session");

  const manifest = readJson<VisualizationManifest>(join(viz, "manifest.json"));
  assert.equal(manifest.scope, "selected");
  assert.equal(manifest.counts.generatedSessions, 1);
  assert.equal(manifest.counts.discoveredSessions, 2, "hub metadata reports the total discovered count, not the selected count");
  assert.deepEqual(manifest.sessions.map((s) => s.id), ["beta"]);

  assert.ok(result.includes(".work-state/visualize"), "status names the output root");
  assert.ok(result.includes("selected/latest (partial)"), "status marks partiality");
  assert.ok(result.includes("1 session generated (2 discovered)"), "status reports 1 generated of 2 discovered");
  assert.ok(hub.includes("1 of 2 discovered"), "partial hub names the total discovered count");
  assert.ok(result.includes("index.html"), "status names the hub page");
  assert.ok(!result.includes(root), "status never exposes the absolute cwd");
  assert.equal(notifyCalls.length, 1, "user notified once");
  assert.ok(notifyCalls[0]!.includes("workflow-view:"), "notify prefix");
  rmSync(root, { recursive: true, force: true });
});

test("command: selected kind/id writes the exact session; --all with id= is rejected", async () => {
  const { root } = makeProject();
  writeFeatureFixture(root, "alpha");
  writeFeatureFixture(root, "beta", { task: "Beta feature" });
  writeCtoFixture(root, "run-1");
  const cmd = workflowViewFactory(fakeApi(root) as never);

  const byId = await cmd.execute(["do-work", "id=alpha"], fakeCtx(root, []) as never);
  const viz = join(root, VISUALIZE_OUTPUT_ROOT);
  assert.ok(existsSync(join(viz, sessionPagePath("feature", "alpha", "html"))));
  assert.ok(!existsSync(join(viz, sessionPagePath("feature", "beta", "html"))), "other sessions not generated");
  assert.ok(byId.startsWith("Workflow view written:"));

  const byKind = await cmd.execute(["cto"], fakeCtx(root, []) as never);
  assert.ok(existsSync(join(viz, sessionPagePath("cto", "run-1", "html"))));
  assert.ok(!byKind.includes("cto/run-1"), "status stays safe (no raw ids in path claims)");

  const conflict = await cmd.execute(["--all", "id=alpha"], fakeCtx(root, []) as never);
  assert.ok(conflict.startsWith("ERROR: --all is mutually exclusive with id="));
  assert.ok(conflict.includes("Usage: /workflow-view"));
  rmSync(root, { recursive: true, force: true });
});

test("command: --all renders every discoverable session as a complete bundle", async () => {
  const { root } = makeProject();
  writeFeatureFixture(root, "alpha", { updated_at: "2026-08-08T10:00:00.000Z" });
  writeFeatureFixture(root, "beta", { task: "Beta feature", updated_at: "2026-08-09T10:00:00.000Z" });
  writeCtoFixture(root, "run-1", "2026-08-10T11:00:00.000Z");
  const cmd = workflowViewFactory(fakeApi(root) as never);

  const result = await cmd.execute(["--all"], fakeCtx(root, []) as never);
  const viz = join(root, VISUALIZE_OUTPUT_ROOT);
  for (const [kind, pathKey] of [["feature", "alpha"], ["feature", "beta"], ["cto", "run-1"]] as const) {
    assert.ok(existsSync(join(viz, sessionPagePath(kind, pathKey, "md"))), `${kind}/${pathKey} md generated`);
    assert.ok(existsSync(join(viz, sessionPagePath(kind, pathKey, "html"))), `${kind}/${pathKey} html generated`);
  }

  const hub = readFileSync(join(viz, "index.html"), "utf8");
  assert.ok(hub.includes("all sessions (complete)"), "--all hub is the completeness mode");
  assert.ok(hub.includes("alpha feature worktree") && hub.includes("beta feature worktree"), "hub lists every session");

  const manifest = readJson<VisualizationManifest>(join(viz, "manifest.json"));
  assert.equal(manifest.scope, "all");
  assert.equal(manifest.counts.discoveredSessions, 3);
  assert.equal(manifest.counts.generatedSessions, 3);
  assert.equal(manifest.counts.generatedPages, 8);
  assert.deepEqual(manifest.sessions.map((s) => s.id), ["run-1", "beta", "alpha"], "deterministic total order");
  assert.ok(result.includes("all sessions (complete)"));
  assert.ok(result.includes("3 sessions generated (3 discovered)"));
  assert.ok(!result.includes(root), "no absolute paths in status");
  rmSync(root, { recursive: true, force: true });
});

test("command: legacy and cto layouts write kind-namespaced pages", async () => {
  const { root } = makeProject();
  writeLegacyFixture(root);
  writeCtoFixture(root, "run-1");
  const cmd = workflowViewFactory(fakeApi(root) as never);

  const legacyResult = await cmd.execute(["legacy"], fakeCtx(root, []) as never);
  const viz = join(root, VISUALIZE_OUTPUT_ROOT);
  assert.ok(existsSync(join(viz, sessionPagePath("legacy", "legacy-root", "md"))), "legacy-root page written");
  assert.ok(legacyResult.includes("selected/latest (partial)"));

  const ctoResult = await cmd.execute(["cto", "id=run-1", "--all"], fakeCtx(root, []) as never);
  assert.ok(ctoResult.startsWith("ERROR: --all is mutually exclusive with id="), "id= still rejects --all");
  const ctoOk = await cmd.execute(["cto", "id=run-1"], fakeCtx(root, []) as never);
  assert.ok(existsSync(join(viz, sessionPagePath("cto", "run-1", "html"))), "cto page written");
  assert.ok(!ctoOk.includes("run-1"), "status does not leak raw ids into path claims");
  rmSync(root, { recursive: true, force: true });
});

test("command: re-running overwrites the same bundle paths (static snapshot semantics)", async () => {
  const { root } = makeProject();
  writeFeatureFixture(root, "alpha");
  const cmd = workflowViewFactory(fakeApi(root) as never);
  const viz = join(root, VISUALIZE_OUTPUT_ROOT);
  const page = join(viz, sessionPagePath("feature", "alpha", "md"));

  await cmd.execute(["id=alpha"], fakeCtx(root, []) as never);
  const first = readFileSync(page, "utf8");
  const firstStat = statSync(page);
  await new Promise((resolve) => setTimeout(resolve, 20));
  await cmd.execute(["id=alpha"], fakeCtx(root, []) as never);
  const second = readFileSync(page, "utf8");
  const secondStat = statSync(page);

  assert.ok(secondStat.mtimeMs >= firstStat.mtimeMs, "same page rewritten on re-run");
  // Byte-identical except volatile generated_at timestamps (staleness stays
  // fresh for both runs): normalize both the front-matter and overview
  // renderings before comparing.
  const stripVolatile = (text: string): string =>
    text
      .replace(/^generated_at: .*$/m, "generated_at: VOLATILE")
      .replace(/- \*\*Generated at:\*\* .*/g, "- **Generated at:** VOLATILE");
  assert.equal(stripVolatile(second), stripVolatile(first), "deterministic content across reruns");
  assert.equal(readdirSync(join(root, VISUALIZE_OUTPUT_ROOT)).sort().join(","), "index.html,index.md,manifest.json,sessions");
  rmSync(root, { recursive: true, force: true });
});

test("command: source mutation changes the digest and rendered content", async () => {
  const { root } = makeProject();
  writeFeatureFixture(root, "alpha", { task: "Build the /workflow-view command" });
  const cmd = workflowViewFactory(fakeApi(root) as never);
  const viz = join(root, VISUALIZE_OUTPUT_ROOT);

  await cmd.execute(["do-work", "id=alpha"], fakeCtx(root, []) as never);
  const first = readJson<VisualizationManifest>(join(viz, "manifest.json"));
  const firstDigest = first.sessions[0]!.sourceDigestBounded;
  const firstHtml = readFileSync(join(viz, sessionPagePath("feature", "alpha", "html")), "utf8");
  assert.ok(firstHtml.includes("Build the /workflow-view command"));

  // Mutate the canonical state text (task changed; updated_at unchanged).
  writeFeatureFixture(root, "alpha", { task: "Build the /workflow-view command v2" });
  await cmd.execute(["do-work", "id=alpha"], fakeCtx(root, []) as never);

  const second = readJson<VisualizationManifest>(join(viz, "manifest.json"));
  const secondDigest = second.sessions[0]!.sourceDigestBounded;
  const secondHtml = readFileSync(join(viz, sessionPagePath("feature", "alpha", "html")), "utf8");
  assert.notEqual(secondDigest, firstDigest, "source digest changes with canonical content");
  assert.ok(secondHtml.includes("v2"), "rendered content reflects the mutation");
  assert.equal(second.sessions[0]!.id, first.sessions[0]!.id, "same stable identity after mutation");
  rmSync(root, { recursive: true, force: true });
});

test("command: --full embeds redacted bodies that the compact policy hides", async () => {
  const { root } = makeProject();
  writeBugFixFixture(root, "bugfix");
  const cmd = workflowViewFactory(fakeApi(root) as never);
  const viz = join(root, VISUALIZE_OUTPUT_ROOT);
  const page = join(viz, sessionPagePath("feature", "bugfix", "html"));

  // bug-fix is compact: bodies disabled by default → body-only string absent.
  await cmd.execute(["do-work", "id=bugfix"], fakeCtx(root, []) as never);
  const defaultHtml = readFileSync(page, "utf8");
  assert.ok(!defaultHtml.includes("guard empty string"), "body hidden under the compact policy");
  assert.ok(defaultHtml.includes("Validate the input"), "summary still visible");

  await cmd.execute(["do-work", "id=bugfix", "--full"], fakeCtx(root, []) as never);
  const fullHtml = readFileSync(page, "utf8");
  assert.ok(fullHtml.includes("guard empty string"), "--full embeds the redacted body");
  assert.ok(fullHtml.includes("add regression test"), "body content rendered");
  rmSync(root, { recursive: true, force: true });
});

test("command: stale sessions surface the regenerate hint in status", async () => {
  const { root } = makeProject();
  writeFeatureFixture(root, "alpha", { updated_at: "2099-01-01T00:00:00.000Z" });
  const cmd = workflowViewFactory(fakeApi(root) as never);

  const result = await cmd.execute(["id=alpha"], fakeCtx(root, []) as never);
  assert.ok(result.includes("stale (1)"), "status reports the stale count");
  assert.ok(result.includes("run the on-demand visualize command to regenerate stale output"), "regenerate hint present");

  const manifest = readJson<VisualizationManifest>(join(root, VISUALIZE_OUTPUT_ROOT, "manifest.json"));
  assert.equal(manifest.counts.staleSessions, 1);
  assert.equal(manifest.sessions[0]!.staleness, "stale");
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

test("command: unknown session id returns an error listing discoverable ids and writes nothing", async () => {
  const { root } = makeProject();
  writeFeatureFixture(root, "alpha");
  writeCtoFixture(root, "run-1");
  const cmd = workflowViewFactory(fakeApi(root) as never);

  const result = await cmd.execute(["id=ghost"], fakeCtx(root, []) as never);
  assert.ok(result.startsWith("ERROR: session not found: ghost"));
  assert.ok(result.includes("discoverable sessions: cto/run-1, feature/alpha"), "error lists discoverable ids");
  assert.ok(!existsSync(join(root, VISUALIZE_OUTPUT_ROOT)), "nothing written");
  rmSync(root, { recursive: true, force: true });
});

test("command: empty workspace returns an error and creates nothing", async () => {
  const { root } = makeProject();
  const cmd = workflowViewFactory(fakeApi(root) as never);

  const bare = await cmd.execute([], fakeCtx(root, []) as never);
  assert.ok(bare.startsWith("ERROR: no workflow sessions found under .work-state"));
  assert.ok(bare.includes("Usage: /workflow-view"));
  assert.ok(!existsSync(join(root, ".work-state")), "no .work-state created on failure");

  const all = await cmd.execute(["--all"], fakeCtx(root, []) as never);
  assert.ok(all.startsWith("ERROR:"));
  assert.ok(!existsSync(join(root, ".work-state")), "--all also creates nothing");
  rmSync(root, { recursive: true, force: true });
});

test("command: write failure returns an error without touching the destination", async () => {
  const { root } = makeProject();
  writeFeatureFixture(root, "alpha");
  // Block the output root with a regular file → publish preflight conflict.
  writeFileSync(join(root, VISUALIZE_OUTPUT_ROOT), "occupied", "utf8");
  const cmd = workflowViewFactory(fakeApi(root) as never);

  const result = await cmd.execute(["id=alpha"], fakeCtx(root, []) as never);
  assert.ok(result.startsWith("ERROR: could not write workflow view:"), `error prefix: ${result}`);
  assert.equal(readFileSync(join(root, VISUALIZE_OUTPUT_ROOT), "utf8"), "occupied", "destination untouched");
  const wsEntries = readdirSync(join(root, ".work-state"));
  assert.ok(!wsEntries.some((name) => name.startsWith(".visualize-staging-") || name.startsWith(".visualize-backup-")), "no staging/backup leftovers");
  rmSync(root, { recursive: true, force: true });
});
