/**
 * Session-report assembly: do-work (TeamState schema 1) normalization,
 * profile DAG edges, artifact produced/missing/skipped handling, legacy
 * layout, chronology priority/fallback, and bounded/corrupt telemetry.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { buildSessionReport } from "../src/report/assemble.js";
import { registerWorkflowProfiles } from "../src/engine/profile.js";
import { rollupFromEvents, EventRecorder } from "../src/observability/recorder.js";
import type { ObservabilityEvent } from "../src/observability/events.js";
import type { SessionReport, StageInfo } from "../src/report/types.js";
import type { Profile, TeamState } from "../src/engine/types.js";

function makeTeamState(overrides: Partial<TeamState> = {}): TeamState {
  return {
    schema: 1,
    branch: "feat/session-report",
    classification: {
      type: "FEATURE",
      complexity: "COMPLEX",
      confidence: "HIGH",
      workflow: "full-feature",
      autonomous: true,
      autonomous_reason: "test fixture",
    },
    task: "Build the session report",
    workflow_override: false,
    issue: { number: 42, url: "https://example.com/42" },
    stage_cursor: "implementation",
    stages: [
      { id: "discovery", status: "done" },
      { id: "exploration", status: "done" },
      { id: "clarify", status: "done" },
      { id: "architecture", status: "done" },
      { id: "implementation", status: "in_progress" },
      { id: "code_review", status: "pending" },
      { id: "review_fixes", status: "pending" },
      { id: "manual_qa", status: "skipped" },
      { id: "qa_tests", status: "pending" },
      { id: "summary", status: "pending" },
    ],
    artifacts: {},
    pause: { kind: "none", reason: "" },
    updated_at: "2026-08-08T10:00:00.000Z",
    ...overrides,
  };
}

function tmpWorkspace(): string {
  const dir = mkdtempSync(join(tmpdir(), "report-dw-"));
  return dir;
}

function writeFeature(cwd: string, slug: string, state: TeamState): void {
  const dir = join(cwd, ".work-state", "features", slug);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "state.json"), JSON.stringify(state, null, 2));
}

test("do-work: normalizes per-feature TeamState schema 1 into SessionReport", () => {
  const cwd = tmpWorkspace();
  try {
    const state = makeTeamState();
    writeFeature(cwd, "session-report", state);
    const artifactsDir = join(cwd, ".work-state", "features", "session-report", "artifacts");
    mkdirSync(artifactsDir, { recursive: true });
    writeFileSync(
      join(artifactsDir, "implementation.json"),
      JSON.stringify({ type: "implementation", title: "Impl plan", notes: "x" }, null, 2),
    );

    const report = buildSessionReport(cwd, { kind: "do-work" });

    assert.equal(report.kind, "do-work");
    assert.equal(report.meta.task, state.task);
    assert.equal(report.meta.title, "#42: Build the session report");
    assert.equal(report.meta.issue?.number, 42);
    assert.equal(report.meta.classification?.workflow, "full-feature");
    assert.equal(report.meta.autonomous, true);
    assert.equal(report.source.id, "session-report");
    assert.equal(report.source.isLegacy, false);
    assert.equal(report.source.format, "json");

    const impl = report.stages.find((s) => s.id === "implementation");
    assert.ok(impl);
    assert.equal(impl.status, "in_progress");
    assert.equal(impl.title, "Implementation");
    assert.equal(impl.type, "single");
    assert.equal(impl.phase, "full-feature");
    // No telemetry, artifact exists → at falls back to artifact mtime.
    assert.ok(impl.at && Date.parse(impl.at) > 0);

    // Profile DAG: produces + consumes edges.
    assert.ok(report.edges.some((e) => e.kind === "produces" && e.from === "implementation" && e.to === "implementation"));
    assert.ok(report.edges.some((e) => e.kind === "consumes" && e.to === "implementation" && e.from === "architecture"));
    assert.ok(report.edges.some((e) => e.kind === "consumes" && e.to === "code_review" && e.from === "implementation"));
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("do-work: produced / missing / skipped artifacts are distinct, extras scanned", () => {
  const cwd = tmpWorkspace();
  try {
    const state = makeTeamState();
    writeFeature(cwd, "session-report", state);
    const artifactsDir = join(cwd, ".work-state", "features", "session-report", "artifacts");
    mkdirSync(artifactsDir, { recursive: true });
    writeFileSync(join(artifactsDir, "implementation.json"), JSON.stringify({ type: "implementation", title: "Impl plan" }, null, 2));
    writeFileSync(join(artifactsDir, "agent_extra.json"), JSON.stringify({ type: "discovery", title: "extra" }, null, 2));

    const report = buildSessionReport(cwd, { kind: "do-work" });

    const impl = report.artifacts.find((a) => a.id === "implementation");
    assert.equal(impl?.status, "produced");
    assert.equal(impl?.type, "implementation");
    assert.ok((impl?.bytes ?? 0) > 0);
    assert.ok(impl?.keys?.includes("title"));

    const architecture = report.artifacts.find((a) => a.id === "architecture");
    assert.equal(architecture?.status, "missing");
    assert.equal(architecture?.summary, "not produced");

    const manualQa = report.artifacts.find((a) => a.id === "manual_qa");
    assert.equal(manualQa?.status, "skipped");
    assert.equal(manualQa?.summary, "skipped — artifact not produced");

    const extra = report.artifacts.find((a) => a.id === "agent_extra");
    assert.equal(extra?.status, "produced");
    assert.equal(extra?.owner, "extra");
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("do-work: state.artifacts refs resolve against .work-state; absolute and explicit forms preserved, escapes rejected", () => {
  const cwd = tmpWorkspace();
  try {
    const slug = "session-report";
    const artifactsDir = join(cwd, ".work-state", "features", slug, "artifacts");
    mkdirSync(artifactsDir, { recursive: true });
    // Real persisted layout: files under .work-state/features/<slug>/artifacts/,
    // state.json stamps them as state-relative refs (no .work-state/ prefix).
    writeFileSync(
      join(artifactsDir, "implementation.json"),
      JSON.stringify({ type: "implementation", title: "Impl plan" }, null, 2),
    );
    writeFileSync(
      join(artifactsDir, "exploration.json"),
      JSON.stringify({ type: "exploration", title: "Explore" }, null, 2),
    );
    writeFileSync(join(artifactsDir, "dod.json"), JSON.stringify({ type: "dod", items: [] }, null, 2));

    const state = makeTeamState({
      artifacts: {
        implementation: `features/${slug}/artifacts/implementation.json`, // state-relative (per-feature layout)
        exploration: `.work-state/features/${slug}/artifacts/exploration.json`, // explicit .work-state path
        dod: join(artifactsDir, "dod.json"), // absolute path preserved
        architecture: "../escaped.json", // escapes .work-state → rejected, never read
      },
    });
    writeFeature(cwd, slug, state);

    const report = buildSessionReport(cwd, { kind: "do-work", id: slug });

    const impl = report.artifacts.find((a) => a.id === "implementation");
    assert.equal(impl?.status, "produced");
    assert.equal(impl?.path, join(artifactsDir, "implementation.json"));

    const exploration = report.artifacts.find((a) => a.id === "exploration");
    assert.equal(exploration?.status, "produced");

    const dod = report.artifacts.find((a) => a.id === "dod");
    assert.equal(dod?.status, "produced");

    const escaped = report.artifacts.find((a) => a.id === "architecture");
    assert.equal(escaped?.status, "missing");
    assert.equal(escaped?.summary, "not produced");
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("do-work: includeFullArtifacts embeds redacted, byte-capped bodies; default omits them", () => {
  const cwd = tmpWorkspace();
  try {
    const state = makeTeamState();
    writeFeature(cwd, "session-report", state);
    const artifactsDir = join(cwd, ".work-state", "features", "session-report", "artifacts");
    mkdirSync(artifactsDir, { recursive: true });
    // Quoted JSON keys are the leak vector: "api_key": "sk-…" has a quote
    // between key and colon, which the prose CTO pattern misses.
    writeFileSync(join(artifactsDir, "implementation.json"), JSON.stringify({ title: "Plan", api_key: "sk-12345", token: "abc" }, null, 2));

    const without = buildSessionReport(cwd, { kind: "do-work" });
    assert.equal(without.artifacts.find((a) => a.id === "implementation")?.body, undefined);

    const withBodies = buildSessionReport(cwd, { kind: "do-work" }, { includeFullArtifacts: true, maxArtifactBytes: 128 });
    const impl = withBodies.artifacts.find((a) => a.id === "implementation");
    assert.ok(impl?.body);
    assert.ok(!impl.body.includes("sk-12345"), "quoted api_key value dropped from embedded body");
    assert.ok(!impl.body.includes('"token"'), "quoted token key dropped from embedded body");
    assert.ok(impl.body.length <= 128, "body capped by maxArtifactBytes");
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("do-work: legacy root layout normalizes with isLegacy + root artifacts dir", () => {
  const cwd = tmpWorkspace();
  try {
    const state = makeTeamState();
    const wsDir = join(cwd, ".work-state");
    mkdirSync(join(wsDir, "artifacts"), { recursive: true });
    writeFileSync(join(wsDir, "team-state.json"), JSON.stringify(state, null, 2));
    writeFileSync(join(wsDir, "artifacts", "dod.json"), JSON.stringify({ type: "dod", items: [] }, null, 2));

    const report = buildSessionReport(cwd, { kind: "do-work" });

    assert.equal(report.source.id, "legacy");
    assert.equal(report.source.isLegacy, true);
    assert.equal(report.source.format, "json");
    const dod = report.artifacts.find((a) => a.id === "dod");
    assert.equal(dod?.status, "produced");
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("do-work: buildSessionReport throws a clear error when no session exists", () => {
  const cwd = tmpWorkspace();
  try {
    assert.throws(() => buildSessionReport(cwd), /no do-work or cto session found/);
    assert.throws(() => buildSessionReport(cwd, { kind: "do-work", id: "nope" }), /do-work session "nope" not found/);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

// ── Chronology priority / fallback ──────────────────────────────────────────

function writeEvents(cwd: string, slug: string, lines: string[]): void {
  const obsDir = join(cwd, ".work-state", "features", slug, "observability");
  mkdirSync(obsDir, { recursive: true });
  writeFileSync(join(obsDir, "events.jsonl"), lines.join("\n") + "\n");
}

function stageTransition(stageId: string, stageStatus: string, ts: string): string {
  return JSON.stringify({ id: "evt", kind: "stage_transition", ts, branch: "feat/x", stageId, stageStatus });
}

function artifactWritten(artifactId: string, ts: string): string {
  return JSON.stringify({ id: "evt", kind: "artifact_written", ts, branch: "feat/x", artifactId });
}

test("chronology: event timestamps beat artifact mtime and state.updated_at", () => {
  const cwd = tmpWorkspace();
  try {
    const state = makeTeamState();
    writeFeature(cwd, "session-report", state);
    const artifactsDir = join(cwd, ".work-state", "features", "session-report", "artifacts");
    mkdirSync(artifactsDir, { recursive: true });
    writeFileSync(join(artifactsDir, "implementation.json"), JSON.stringify({ title: "Plan" }, null, 2));
    const mtime = new Date(statSync(join(artifactsDir, "implementation.json")).mtimeMs).toISOString();
    const eventTs = "2026-08-08T09:30:00.000Z"; // older than mtime → event must still win
    writeEvents(cwd, "session-report", [
      stageTransition("implementation", "in_progress", eventTs),
      artifactWritten("implementation", "2026-08-08T09:31:00.000Z"),
    ]);

    const report = buildSessionReport(cwd, { kind: "do-work" });

    const impl = report.stages.find((s) => s.id === "implementation");
    assert.equal(impl?.at, eventTs, "stage event ts wins over artifact mtime");

    const art = report.artifacts.find((a) => a.id === "implementation");
    assert.equal(art?.mtime, mtime);

    // Event entry present; no duplicate mtime entry for the same artifact.
    assert.ok(report.chronology.some((c) => c.kind === "artifact" && c.ref === "implementation" && c.source === "event" && c.label.includes("written")));
    assert.ok(!report.chronology.some((c) => c.kind === "artifact" && c.ref === "implementation" && c.source === "mtime"));

    // Ordered ascending by timestamp.
    const times = report.chronology.map((c) => Date.parse(c.at)).filter((t) => Number.isFinite(t));
    assert.deepEqual(times, [...times].sort((a, b) => a - b));
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("chronology: without events, artifact mtime drives stage at; state updated_at is the floor", () => {
  const cwd = tmpWorkspace();
  try {
    const state = makeTeamState({ updated_at: "2026-08-08T08:00:00.000Z" });
    writeFeature(cwd, "session-report", state);
    const artifactsDir = join(cwd, ".work-state", "features", "session-report", "artifacts");
    mkdirSync(artifactsDir, { recursive: true });
    writeFileSync(join(artifactsDir, "implementation.json"), JSON.stringify({ title: "Plan" }, null, 2));
    const mtime = new Date(statSync(join(artifactsDir, "implementation.json")).mtimeMs).toISOString();

    const report = buildSessionReport(cwd, { kind: "do-work" });

    assert.equal(report.stages.find((s) => s.id === "implementation")?.at, mtime);
    // Pending stage with no produced artifact floors at updated_at.
    assert.equal(report.stages.find((s) => s.id === "summary")?.at, state.updated_at);
    assert.ok(report.chronology.some((c) => c.kind === "artifact" && c.ref === "implementation" && c.source === "mtime"));
    assert.ok(report.chronology.some((c) => c.kind === "state" && c.at === state.updated_at));
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("telemetry: absent event log → rollup null + warning, no throw", () => {
  const cwd = tmpWorkspace();
  try {
    writeFeature(cwd, "session-report", makeTeamState());
    const report = buildSessionReport(cwd, { kind: "do-work" });
    assert.equal(report.telemetry.rollup, null);
    assert.ok(report.warnings.some((w) => w.includes("no telemetry available")));
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("telemetry: corrupt event lines are skipped with a warning; valid lines still drive chronology", () => {
  const cwd = tmpWorkspace();
  try {
    writeFeature(cwd, "session-report", makeTeamState());
    const eventTs = "2026-08-08T09:00:00.000Z";
    writeEvents(cwd, "session-report", [
      "{ this is not json",
      stageTransition("implementation", "in_progress", eventTs),
      "garbage",
    ]);

    const report = buildSessionReport(cwd, { kind: "do-work" });

    assert.ok(report.warnings.some((w) => w.includes("2 corrupt event line(s) skipped")));
    assert.equal(report.stages.find((s) => s.id === "implementation")?.at, eventTs);
    assert.equal(report.telemetry.eventCounts?.stage_transition, 1);
    assert.ok(report.telemetry.rollup);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("telemetry: event log over the line cap is truncated with a warning (bounded)", () => {
  const cwd = tmpWorkspace();
  try {
    writeFeature(cwd, "session-report", makeTeamState());
    const lines: string[] = [];
    for (let i = 0; i < 5050; i++) lines.push(stageTransition("discovery", "done", `2026-08-08T00:00:${String(i % 60).padStart(2, "0")}.000Z`));
    writeEvents(cwd, "session-report", lines);

    const report = buildSessionReport(cwd, { kind: "do-work" });
    assert.ok(report.warnings.some((w) => w.includes("truncated to 5000 events")));
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("telemetry: oversized event log reads the tail — newest events kept, partial first line dropped (CR-1)", () => {
  const cwd = tmpWorkspace();
  try {
    writeFeature(cwd, "session-report", makeTeamState());

    // MAX_EVENT_BYTES (2 MiB) tail window. Each filler line is exactly
    // FILLER_LEN bytes (pad accounts for the `"pad"` key), so the file size
    // is 4096*(FILLER_LEN+1) + marker + "\n": the window starts
    // markerLen+1 bytes in — inside the FIRST filler line, mid-line.
    const FILLER_LEN = 511; // +1 separator => 4096*512 = 2 MiB boundary
    const CAP = 2 * 1024 * 1024;
    const base = {
      kind: "stage_transition",
      ts: "2026-08-08T00:00:00.000Z",
      branch: "feat/x",
      stageId: "discovery",
      stageStatus: "done",
      id: "f0000",
    };
    const bare = JSON.stringify(base).length; // filler without the pad field
    const pad = "x".repeat(Math.max(0, FILLER_LEN - bare - 9)); // -9 for `,"pad":"…"`
    const fillers: string[] = [];
    for (let i = 0; i < 4096; i++) {
      const line = JSON.stringify({
        ...base,
        id: `f${String(i).padStart(4, "0")}`,
        ts: `2026-08-08T00:${String(Math.floor(i / 60) % 60).padStart(2, "0")}:${String(i % 60).padStart(2, "0")}.000Z`,
        pad,
      });
      assert.equal(line.length, FILLER_LEN, "filler lines must have a fixed byte length");
      fillers.push(line);
    }
    // The ONLY artifact_written event, at the very end of the log — it must
    // survive the byte cap and drive chronology.
    const marker = JSON.stringify({ id: "marker", kind: "artifact_written", ts: "2026-08-08T12:00:00.000Z", branch: "feat/x", artifactId: "implementation" });
    writeEvents(cwd, "session-report", [...fillers, marker]);

    // Sanity: the log exceeds the cap and the tail window begins mid-line,
    // inside the first filler line (so exactly one partial line is dropped).
    const eventsPath = join(cwd, ".work-state", "features", "session-report", "observability", "events.jsonl");
    const size = statSync(eventsPath).size;
    assert.ok(size > CAP, "log must exceed the byte cap");
    const offset = size - CAP;
    assert.notEqual(offset % (FILLER_LEN + 1), 0, "tail window must begin mid-line");
    assert.ok(offset < FILLER_LEN + 1, "tail window must start inside the first filler line");

    const report = buildSessionReport(cwd, { kind: "do-work" });

    // The newest event (marker) is retained from the tail window; only the
    // partial first line (line 0) is dropped, so 4095 of 4096 fillers remain.
    assert.equal(report.telemetry.eventCounts?.artifact_written, 1, "newest artifact_written retained from the tail");
    assert.equal(report.telemetry.eventCounts?.stage_transition, 4096 - 1, "older stage events present minus the dropped partial line");
    assert.ok(
      report.chronology.some((c) => c.kind === "artifact" && c.ref === "implementation" && c.source === "event" && c.label.includes("written")),
      "newest artifact event drives chronology",
    );
    // Newest event drives the stage time, not the state.updated_at fallback.
    assert.equal(report.stages.find((s) => s.id === "implementation")?.at, "2026-08-08T12:00:00.000Z");
    // The partial first line is dropped silently — not counted as corruption.
    assert.ok(!report.warnings.some((w) => w.includes("corrupt event line")), "partial first line is not corruption");
    // Warning accurately describes tail truncation.
    assert.ok(report.warnings.some((w) => w.includes("tail")), "warning describes tail truncation");
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

// ── Backward-compatible rollups ─────────────────────────────────────────────

test("rollups: new event kinds count additively; old kinds and old rollups are untouched", () => {
  const events: ObservabilityEvent[] = [
    { id: "1", kind: "session_start", ts: "2026-08-08T09:00:00.000Z", branch: "feat/x" },
    { id: "2", kind: "agent_start", ts: "2026-08-08T09:01:00.000Z", branch: "feat/x", subagent: "analyst" },
    { id: "3", kind: "tool_call", ts: "2026-08-08T09:02:00.000Z", branch: "feat/x", toolName: "task", subagent: "architect" },
    { id: "4", kind: "stage_transition", ts: "2026-08-08T09:03:00.000Z", branch: "feat/x", stageId: "implementation", stageStatus: "in_progress" },
    { id: "5", kind: "artifact_written", ts: "2026-08-08T09:04:00.000Z", branch: "feat/x", artifactId: "implementation" },
    { id: "6", kind: "stage_transition", ts: "2026-08-08T09:05:00.000Z", branch: "feat/x", stageId: "implementation", stageStatus: "done" },
  ];
  const rollup = rollupFromEvents(events);

  assert.equal(rollup.stageTransitions, 2);
  assert.equal(rollup.artifactWrites, 1);
  assert.equal(rollup.agentInvocations, 1);
  assert.equal(rollup.totalToolCalls, 1);
  assert.equal(rollup.subagents.architect, 1);

  // Old-style rollups (no new fields) still pass through the pointer untouched.
  const legacyRollup = { agentInvocations: 0, agents: {}, tools: {}, toolErrors: {}, subagents: {}, skills: {}, totalToolCalls: 0, totalToolErrors: 0, durationMs: 0, firstEventAt: "x", lastEventAt: "y" };
  const cwd = tmpWorkspace();
  try {
    writeFeature(cwd, "session-report", makeTeamState());
    const statePath = join(cwd, ".work-state", "features", "session-report", "state.json");
    const state = JSON.parse(readFileSync(statePath, "utf8")) as TeamState & { observability?: unknown };
    state.observability = { eventsPath: "observability/events.jsonl", lastEventId: "", rollupThroughId: "", rollup: legacyRollup };
    writeFileSync(statePath, JSON.stringify(state));
    const report = buildSessionReport(cwd, { kind: "do-work" });
    assert.equal(report.telemetry.rollup?.agentInvocations, 0);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

// ── Stage provenance (agents / inputs / outputs) ────────────────────────────

test("do-work: full-feature stages carry resolved agents, original roles, and declared inputs/outputs", () => {
  const cwd = tmpWorkspace();
  try {
    writeFeature(cwd, "session-report", makeTeamState());
    // No artifacts written on disk: declared outputs must survive as declared
    // artifact ids even when the files are missing (missing ≠ undeclared).
    const report = buildSessionReport(cwd, { kind: "do-work" });

    // Single stage: resolved agent + original role.
    const qa = report.stages.find((s) => s.id === "qa_tests");
    assert.deepEqual(qa?.agents, [{ name: "qa", role: "qa", source: "workflow" }]);
    assert.deepEqual(qa?.inputs, ["manual_qa", "implementation", "architecture"]);
    assert.deepEqual(qa?.outputs, ["qa_tests"]);

    // Consilium: role roster maps every declared role to its resolved agent.
    const arch = report.stages.find((s) => s.id === "architecture");
    assert.deepEqual(arch?.agents, [
      { name: "architect", role: "architect_minimal", source: "workflow" },
      { name: "architect", role: "architect_clean", source: "workflow" },
      { name: "architect", role: "architect_pragmatic", source: "workflow" },
    ]);
    assert.deepEqual(arch?.inputs, ["exploration", "clarifications"]);
    assert.deepEqual(arch?.outputs, ["architecture"]);

    // Orchestrator: truthful main-session entry — never an invented agent.
    const summary = report.stages.find((s) => s.id === "summary");
    assert.deepEqual(summary?.agents, [{ name: "main session", role: "orchestrator", source: "workflow" }]);
    assert.deepEqual(summary?.outputs, ["summary"]);

    // Consilium roles with duplicates stay as declared by the profile.
    const exploration = report.stages.find((s) => s.id === "exploration");
    assert.deepEqual(exploration?.agents, [
      { name: "analyst", role: "analyst", source: "workflow" },
      { name: "tech-researcher", role: "tech-researcher", source: "workflow" },
      { name: "analyst", role: "analyst", source: "workflow" },
    ]);
    assert.deepEqual(exploration?.outputs, ["exploration", "dod"]);

    // Stage with no `produces` declares an empty (not absent) output list.
    const reviewFixes = report.stages.find((s) => s.id === "review_fixes");
    assert.deepEqual(reviewFixes?.outputs, []);

    // Missing artifacts stay declared on the stage: architecture.json was
    // never written, yet the stage still lists it as an output.
    assert.equal(report.artifacts.find((a) => a.id === "architecture")?.status, "missing");
    assert.deepEqual(arch?.outputs, ["architecture"]);

    // Profile metadata (checkpoint / gate / autonomous) copied from StageDef.
    const discovery = report.stages.find((s) => s.id === "discovery");
    assert.equal(discovery?.gate, "branch_created");
    assert.equal(discovery?.checkpoint, "confirm_understanding");
    assert.equal(discovery?.autonomous, "log confirmed understanding, continue");

    const codeReview = report.stages.find((s) => s.id === "code_review");
    assert.equal(codeReview?.gate, "verdict != reject");
    assert.equal(codeReview?.checkpoint, "fix_decision");
    assert.equal(codeReview?.autonomous, "fix CRITICAL+HIGH, then continue");

    const manualQa = report.stages.find((s) => s.id === "manual_qa");
    assert.equal(manualQa?.gate, "manual_qa.verdict != FAIL");

    // Stages that declare none of the metadata keep every field absent.
    assert.equal(exploration?.description, undefined);
    assert.equal(exploration?.checkpoint, undefined);
    assert.equal(exploration?.gate, undefined);
    assert.equal(exploration?.autonomous, undefined);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("do-work: declared stage description/checkpoint/gate/autonomous flow into profile-backed stages", () => {
  // No shipped profile declares stage-level `description` (schema keeps it
  // optional), so the copy path is proven with a registered fixture profile.
  registerWorkflowProfiles([
    {
      name: "stage-detail",
      title: "Stage Detail Fixture",
      description: "Fixture profile for stage metadata copying.",
      match: { type: ["FEATURE"] },
      stages: [
        {
          id: "design",
          title: "Design",
          type: "single",
          role: "architect",
          description: "Pick the architecture approach.",
          checkpoint: "user_choice",
          gate: "option_chosen",
          autonomous: "pick option #1, record rationale",
          produces: "design",
        },
        {
          id: "tidy",
          title: "Tidy",
          type: "single",
          role: "qa",
          produces: "tidy",
        },
      ],
    },
  ]);

  const cwd = tmpWorkspace();
  try {
    const state = makeTeamState({
      classification: { ...makeTeamState().classification, workflow: "stage-detail" },
      stages: [
        { id: "design", status: "done" },
        { id: "tidy", status: "pending" },
      ],
    });
    writeFeature(cwd, "session-report", state);

    const report = buildSessionReport(cwd, { kind: "do-work" });

    // All four profile metadata fields are copied verbatim.
    const design = report.stages.find((s) => s.id === "design");
    assert.equal(design?.description, "Pick the architecture approach.");
    assert.equal(design?.checkpoint, "user_choice");
    assert.equal(design?.gate, "option_chosen");
    assert.equal(design?.autonomous, "pick option #1, record rationale");
    // Existing provenance behavior untouched.
    assert.deepEqual(design?.agents, [{ name: "architect", role: "architect", source: "workflow" }]);
    assert.deepEqual(design?.outputs, ["design"]);

    // Undeclared fields stay absent — even on a profile-backed stage.
    const tidy = report.stages.find((s) => s.id === "tidy");
    assert.equal(tidy?.description, undefined);
    assert.equal(tidy?.checkpoint, undefined);
    assert.equal(tidy?.gate, undefined);
    assert.equal(tidy?.autonomous, undefined);
    assert.deepEqual(tidy?.outputs, ["tidy"]);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("do-work: consilium roster honors configured roster_overrides (add/replace)", () => {
  const cwd = tmpWorkspace();
  try {
    writeFeature(cwd, "session-report", makeTeamState());
    const ompDir = join(cwd, ".omp");
    mkdirSync(ompDir, { recursive: true });
    writeFileSync(
      join(ompDir, "team.config.json"),
      JSON.stringify({
        roster_overrides: {
          code_review: { add: ["security-tester"] },
          architecture: { replace: ["architect_clean"] },
        },
      }),
    );

    const report = buildSessionReport(cwd, { kind: "do-work" });

    const codeReview = report.stages.find((s) => s.id === "code_review");
    assert.deepEqual(codeReview?.agents, [
      { name: "code-reviewer", role: "code-reviewer", source: "workflow" },
      { name: "security-tester", role: "security-tester", source: "workflow" },
    ]);

    const arch = report.stages.find((s) => s.id === "architecture");
    assert.deepEqual(arch?.agents, [{ name: "architect", role: "architect_clean", source: "workflow" }]);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("do-work: unresolved ${scope.dev_agent} template roles are omitted, inputs/outputs kept", () => {
  const cwd = tmpWorkspace();
  try {
    writeFeature(cwd, "session-report", makeTeamState());
    const report = buildSessionReport(cwd, { kind: "do-work" });

    // implementation + review_fixes declare role "${scope.dev_agent}" in the
    // full-feature profile. The report has no touched-file scope scan, so it
    // cannot resolve the template: the agent entry must stay absent (the
    // renderer shows "no agent recorded") — never the literal placeholder,
    // never a guessed role.
    for (const stageId of ["implementation", "review_fixes"]) {
      const stage = report.stages.find((s) => s.id === stageId);
      assert.ok(stage, `${stageId} stage present`);
      assert.equal(stage.agents, undefined, `${stageId} claims no agent without scope evidence`);
    }

    // Declared inputs/outputs survive without the roster.
    const impl = report.stages.find((s) => s.id === "implementation");
    assert.deepEqual(impl?.inputs, ["architecture", "exploration"]);
    assert.deepEqual(impl?.outputs, ["implementation"]);
    const reviewFixes = report.stages.find((s) => s.id === "review_fixes");
    assert.deepEqual(reviewFixes?.inputs, ["review"]);
    assert.deepEqual(reviewFixes?.outputs, []);

    // No literal template placeholder can leak into any stage's agent names.
    for (const s of report.stages) {
      for (const a of s.agents ?? []) {
        assert.ok(!a.name.includes("${"), `no template placeholder in agent names (${a.name})`);
      }
    }
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("do-work: custom/unknown workflow falls back safely — provenance fields absent, no throw", () => {
  const cwd = tmpWorkspace();
  try {
    const state = makeTeamState({
      classification: { ...makeTeamState().classification, workflow: "custom-flow" },
    });
    writeFeature(cwd, "session-report", state);

    const report = buildSessionReport(cwd, { kind: "do-work" });

    const impl = report.stages.find((s) => s.id === "implementation");
    assert.ok(impl, "custom stages still normalize");
    assert.equal(impl?.agents, undefined, "no profile def → no agent claim");
    assert.equal(impl?.inputs, undefined, "no profile def → inputs absent");
    assert.equal(impl?.outputs, undefined, "no profile def → outputs absent");
    assert.equal(impl?.type, undefined);
    assert.equal(impl?.description, undefined, "no profile def → description absent");
    assert.equal(impl?.checkpoint, undefined, "no profile def → checkpoint absent");
    assert.equal(impl?.gate, undefined, "no profile def → gate absent");
    assert.equal(impl?.autonomous, undefined, "no profile def → autonomous absent");
    // No profile → ordinal transition spine, still a valid report.
    assert.ok(report.edges.some((e) => e.kind === "transition"));
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("recorder: recordStageTransition/recordArtifactWritten persist additive events", async () => {
  const cwd = tmpWorkspace();
  try {
    writeFeature(cwd, "session-report", makeTeamState());
    const rec = new EventRecorder({ cwd, branch: "feat/x", featureSlug: "session-report" });
    await rec.append({ kind: "stage_transition", ts: "2026-08-08T09:00:00.000Z", stageId: "implementation", stageStatus: "in_progress" });
    await rec.append({ kind: "artifact_written", ts: "2026-08-08T09:01:00.000Z", artifactId: "implementation", artifactBytes: 12 });
    await rec.flush();

    const all = rec.readAll();
    assert.equal(all.length, 2);
    assert.equal(all[0]?.kind, "stage_transition");
    assert.equal(all[0]?.stageId, "implementation");
    assert.equal(all[1]?.kind, "artifact_written");
    assert.equal(all[1]?.artifactId, "implementation");
    assert.ok(rec.buildRollup().stageTransitions === 1 && rec.buildRollup().artifactWrites === 1);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});
