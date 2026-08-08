/**
 * Focused renderer tests for `packages/core/src/report/html.ts` (pragmatic
 * architecture, frontend slice).
 *
 * Covers:
 *   1. Self-contained output — inline CSS/JS/data island, zero external refs.
 *   2. Escaping — adversarial payloads can never close the data-island script
 *      tag and JSON.parse round-trips the report byte-for-byte.
 *   3. Both workflow displays — do-work stage graph and CTO team/dependency
 *      graph with their native status vocabularies and edges.
 *   4. Unknown/fallback timestamps and derived CTO statuses are distinguishable.
 *   5. Telemetry degrades to an explicit no-telemetry state; raw events are
 *      never embedded.
 *   6. Artifact panel — produced (expandable, sanitized), missing, skipped.
 *   7. Warnings and the redaction notice are rendered.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { renderReportHtml } from "../src/report/html.js";
import type { SessionReport } from "../src/report/types.js";

function doWorkReport(): SessionReport {
  return {
    schema: 1,
    kind: "do-work",
    meta: {
      title: "OAuth auth flow",
      task: 'Add OAuth with <img src=x onerror=alert(1)> provider "X" & friends',
      branch: "feat/oauth",
      workflow: "standard",
      classification: {
        type: "FEATURE",
        complexity: "MEDIUM",
        confidence: "HIGH",
        autonomous: true,
        autonomous_reason: "well-scoped",
      },
      issue: { number: 42 },
      pause: { kind: "none", reason: "" },
      updated_at: "2026-08-08T10:00:00.000Z",
      generated_at: "2026-08-08T12:00:00.000Z",
      autonomous: true,
    },
    source: {
      kind: "do-work",
      id: "oauth-feature",
      statePath: ".work-state/features/oauth-feature/state.json",
      format: "json",
      isLegacy: false,
    },
    stages: [
      { id: "planning", title: "Planning", status: "done", phase: "standard", type: "orchestrator", at: "2026-08-08T09:00:00.000Z" },
      { id: "implementation", title: "Implementation", status: "in_progress", phase: "standard", type: "single", at: "2026-08-08T09:30:00.000Z" },
      { id: "review", title: "Review", status: "pending", phase: "standard", type: "consilium" },
      { id: "release", title: "Release", status: "skipped", phase: "standard", type: "bash" },
    ],
    edges: [
      { from: "planning", to: "implementation", kind: "transition" },
      { from: "implementation", to: "oauth-plan", kind: "produces", label: "plan artifact" },
      { from: "implementation", to: "review", kind: "transition" },
    ],
    artifacts: [
      {
        id: "oauth-plan",
        path: ".work-state/features/oauth-feature/artifacts/oauth-plan.json",
        owner: "implementation",
        status: "produced",
        bytes: 42,
        mtime: "2026-08-08T09:31:00.000Z",
        type: "implementation plan",
        keys: ["title", "steps"],
        summary: "Plan with </script><script>alert(1)</script> payload",
        body: '{"title":"OAuth"}\n</script><script>alert(2)</script>',
      },
      {
        id: "missing-artifact",
        path: ".work-state/features/oauth-feature/artifacts/missing-artifact.json",
        owner: "implementation",
        status: "missing",
        summary: "(missing)",
      },
      {
        id: "skipped-artifact",
        path: ".work-state/features/oauth-feature/artifacts/skipped-artifact.json",
        owner: "release",
        status: "skipped",
      },
    ],
    telemetry: {
      eventsPath: ".work-state/features/oauth-feature/observability/events.jsonl",
      lastEventId: "42",
      rollup: {
        agentInvocations: 5,
        agents: { "__main__": 1, "analyst": 2, "qa": 2 },
        tools: { "task": 4, "read": 12 },
        toolErrors: { "read": 1 },
        subagents: { "analyst": 2, "qa": 2 },
        skills: { "rust-agent-handoff": 3, "readme-generator": 1 },
        totalToolCalls: 16,
        totalToolErrors: 1,
        durationMs: 3_600_000,
        firstEventAt: "2026-08-08T08:00:00.000Z",
        lastEventAt: "2026-08-08T09:00:00.000Z",
        estimatedTokens: 4000,
        estimatedDollars: 0.2,
      },
      eventCounts: { session_start: 1, session_stop: 1, agent_start: 5, tool_call: 16 },
    },
    chronology: [
      { at: "2026-08-08T09:00:00.000Z", kind: "event", eventKind: "stage_transition", label: "stage planning → done", ref: "planning", source: "event" },
      { at: "2026-08-08T09:31:00.000Z", kind: "artifact", label: "oauth-plan written", ref: "oauth-plan", source: "mtime" },
      { at: "2026-08-08T10:00:00.000Z", kind: "state", label: "state updated", source: "state" },
      { at: "", kind: "stage", label: "release skipped (ordinal)", ref: "release", source: "ordinal" },
    ],
    warnings: ["legacy state format", "missing telemetry rollup"],
  };
}

function ctoReport(): SessionReport {
  return {
    schema: 1,
    kind: "cto",
    meta: {
      title: "CTO run: payment migration",
      task: "Migrate payments to the new provider",
      branch: "feat/payments",
      workflow: "cto",
      pause: { kind: "background_wait", reason: "waiting on escalation" },
      updated_at: "2026-08-08T11:00:00.000Z",
      generated_at: "2026-08-08T12:00:00.000Z",
      autonomous: false,
      standby: false,
    },
    source: {
      kind: "cto",
      id: "cto-payments-20260807",
      statePath: ".work-state/cto/cto-payments-20260807/state.json",
      format: "json",
      isLegacy: false,
    },
    stages: [
      { id: "team-backend", title: "Backend team", status: "done", phase: "cto", type: "team", team: "backend", at: "2026-08-08T10:00:00.000Z" },
      { id: "team-web", title: "Web team", status: "parked", phase: "cto", type: "team", team: "web" },
      { id: "team-mobile", title: "Mobile team", status: "failed", phase: "cto", type: "team", team: "mobile" },
    ],
    edges: [
      { from: "backend", to: "web", kind: "depends_on" },
      { from: "web", to: "mobile", kind: "integration" },
    ],
    artifacts: [],
    teams: [
      { id: "backend", status: "done", slice: "API", profile: "full-feature", worktree: "separate_worktree", escalations: 1, dod_path: ".work-state/cto/cto-payments-20260807/teams/backend/dod.json", depends_on: [] },
      { id: "web", status: "parked", slice: "Frontend", profile: "standard", escalations: 2, depends_on: ["backend"] },
      { id: "mobile", status: "failed", slice: "iOS", profile: "bug-fix", depends_on: ["web"] },
    ],
    integration: { status: "in_progress", note: "waiting for web" },
    health: {
      healthy: false,
      issues: ["web team parked on escalation", "mobile team failed"],
      budget_status: "ok",
      active_teams: 1,
      parked_teams: 1,
      failed_teams: 1,
      pending_escalations: 2,
    },
    telemetry: { eventsPath: ".work-state/cto/cto-payments-20260807/observability/events.jsonl", rollup: null },
    chronology: [
      { at: "2026-08-08T09:00:00.000Z", kind: "team", label: "backend team spawned", ref: "backend", source: "event" },
      { at: "2026-08-08T11:00:00.000Z", kind: "integration", label: "integration in progress", source: "state" },
    ],
    warnings: [],
  };
}

/** Extract the escaped JSON data island and parse it back. */
function extractIsland(html: string): unknown {
  const m = /<script id="omp-report-data" type="application\/json">([\s\S]*?)<\/script>/.exec(html);
  assert.ok(m, "data island must be present");
  return JSON.parse(m[1]!);
}

test("renderer: output is a single self-contained file with zero external references", () => {
  const html = renderReportHtml(doWorkReport());
  assert.ok(html.startsWith("<!doctype html>"));
  assert.ok(html.includes('<style>'), "inline CSS block present");
  assert.ok(html.includes('<script id="omp-report-data" type="application/json">'), "data island present");
  assert.ok(html.includes("</html>"), "document closed");
  assert.ok(!html.includes("<link"), "no <link> elements");
  assert.ok(!html.includes("<script src"), "no external scripts");
  assert.ok(!html.includes('src="'), "no src attributes anywhere");
  assert.ok(!html.includes("fetch("), "no fetch calls");
  assert.ok(!html.includes("http://"), "no plain-http references");
});

test("renderer: data island escapes closing-script payloads and JSON round-trips", () => {
  const report = doWorkReport();
  const html = renderReportHtml(report);
  const m = /<script id="omp-report-data" type="application\/json">([\s\S]*?)<\/script>/.exec(html);
  assert.ok(m, "data island must be present");
  const island = m[1]!;
  assert.ok(!island.includes("<"), "island contains no literal '<' (all escaped as \\u003c)");
  assert.ok(!island.includes("</script"), "island can never close the script tag early");
  // Round-trip: JSON.parse restores the original report byte-for-byte.
  assert.deepEqual(JSON.parse(island), report);
  // Static (server-rendered) sections escape HTML in text.
  assert.ok(html.includes("&lt;img src=x onerror=alert(1)&gt;"), "task HTML is escaped in meta");
  assert.ok(html.includes("&lt;/script&gt;&lt;script&gt;alert(1)&lt;/script&gt;"), "artifact summary is escaped");
});

test("renderer: do-work display renders every stage with status and edges", () => {
  const html = renderReportHtml(doWorkReport());
  assert.ok(html.includes("Workflow stage graph"));
  assert.ok(html.includes("Dependencies &amp; transitions"));
  for (const title of ["Planning", "Implementation", "Review", "Release"]) {
    assert.ok(html.includes(title), `stage ${title} rendered`);
  }
  for (const status of ["done", "in progress", "pending", "skipped"]) {
    assert.ok(html.includes(status), `do-work status ${status} rendered`);
  }
  for (const edge of ["transition", "produces", "plan artifact"]) {
    assert.ok(html.includes(edge), `edge kind/label ${edge} rendered`);
  }
  assert.ok(html.includes('data-edge data-from="planning" data-to="implementation"'));
  assert.ok(html.includes('data-node-id="implementation" data-status="in_progress"'));
});

test("renderer: CTO display renders teams, dependency graph, integration and health", () => {
  const html = renderReportHtml(ctoReport());
  assert.ok(html.includes("CTO team &amp; dependency graph"));
  for (const id of ["backend", "web", "mobile"]) {
    assert.ok(html.includes(`data-node-id="${id}"`), `team ${id} rendered as node`);
  }
  for (const status of ["done", "parked", "failed"]) {
    assert.ok(html.includes(status), `team status ${status} rendered`);
  }
  assert.ok(html.includes("depends on: backend"));
  assert.ok(html.includes("integration: in progress"));
  assert.ok(html.includes("waiting for web"));
  assert.ok(html.includes("Health"));
  assert.ok(html.includes("Needs attention"));
  assert.ok(html.includes("mobile team failed"));
  assert.ok(html.includes("pending escalations: 2"));
  assert.ok(html.includes("derived"), "CTO stages are marked derived");
  assert.ok(html.includes("no explicit stage timeline"), "derivation note present");
});

test("renderer: unknown and fallback timestamps are distinguishable", () => {
  const report = doWorkReport();
  report.meta.updated_at = ""; // corrupt/missing state timestamp
  report.meta.generated_at = "not-a-date";
  const html = renderReportHtml(report);
  assert.ok(html.includes("(unknown)"), "unknown updated_at rendered");
  assert.ok(html.includes("(no timestamp)"), "stage without timestamp rendered");
  assert.ok(html.includes("(untimed)"), "ordinal chronology entry rendered untimed");
  for (const source of ["event timestamp", "artifact mtime", "state.updated_at", "ordinal (untimed)"]) {
    assert.ok(html.includes(source), `chronology source badge ${source} rendered`);
  }
});

test("renderer: telemetry degrades to an explicit no-telemetry state and never embeds raw events", () => {
  const ctoHtml = renderReportHtml(ctoReport());
  assert.ok(ctoHtml.includes("No telemetry recorded for this session"), "no-telemetry state explicit");
  assert.ok(ctoHtml.includes("(not embedded)"), "event log shown as a path pointer, never its content");

  const html = renderReportHtml(doWorkReport());
  assert.ok(html.includes("Agent invocations"));
  assert.ok(html.includes("Tool calls"));
  assert.ok(html.includes("Tool errors"));
  assert.ok(html.includes("60 min 0 s"), "duration humanized");
  assert.ok(html.includes("task — 4"), "per-tool counts");
  assert.ok(html.includes("__main__ — 1"), "per-agent counts");
  assert.ok(html.includes("rust-agent-handoff"), "skills badges");
  assert.ok(html.includes("session_start: 1"), "bounded event counts");
  assert.ok(html.includes("Raw events are never embedded"));
  const parsed = extractIsland(html) as SessionReport;
  assert.equal(parsed.telemetry.eventCounts?.["session_start"], 1, "bounded counts round-trip via the data island");
});

test("renderer: artifact panel renders produced (expandable), missing and skipped states", () => {
  const html = renderReportHtml(doWorkReport());
  assert.ok(html.includes('class="badge b-status st-done">produced</span>'));
  assert.ok(html.includes("not produced — declared but no artifact file found"));
  assert.ok(html.includes("not produced — stage skipped"));
  assert.ok(html.includes("<details class=\"artifact-body\">"), "expandable full content present");
  assert.ok(html.includes("Show full content (42 B)"));
  assert.ok(html.includes("type: implementation plan"));
  assert.ok(html.includes("keys: title, steps"));
});

test("renderer: warnings and the redaction notice are rendered", () => {
  const html = renderReportHtml(doWorkReport());
  assert.ok(html.includes("Warnings (2)"));
  assert.ok(html.includes("legacy state format"));
  assert.ok(html.includes("missing telemetry rollup"));
  assert.ok(html.includes("redacted"), "redaction notice present");
  assert.ok(html.includes("no external requests"), "redaction notice states offline guarantee");
});

test("renderer: issue url renders as a link, absent url renders bare number", () => {
  const withUrl = doWorkReport();
  withUrl.meta.issue = { number: 7, url: "https://example.org/issues/7" };
  const html = renderReportHtml(withUrl);
  assert.ok(html.includes('href="https://example.org/issues/7"'));
  assert.ok(html.includes("#7"));

  const noUrl = renderReportHtml(doWorkReport());
  assert.ok(noUrl.includes("#42"));
  assert.ok(!noUrl.includes("href="), "no link emitted when issue has no url");
});

test("renderer: issue href is emitted only for http(s) urls, unsafe schemes render inert text", () => {
  for (const url of [
    "http://example.org/issues/9",
    "https://example.org/issues/9",
    "HTTP://EXAMPLE.ORG/issues/9",
    "HtTpS://example.org/issues/9",
  ]) {
    const report = doWorkReport();
    report.meta.issue = { number: 9, url };
    const html = renderReportHtml(report);
    assert.ok(html.includes(`href="${url}"`), `link emitted for ${url}`);
    assert.ok(html.includes("#9"), `issue number rendered for ${url}`);
  }

  for (const url of [
    "javascript:alert(1)",
    "javascript://comment",
    "data:text/html,<script>alert(1)</script>",
    "file:///etc/passwd",
    "vbscript:msgbox(1)",
    "not a url",
    "://example.org",
    "",
  ]) {
    const report = doWorkReport();
    report.meta.issue = { number: 9, url };
    const html = renderReportHtml(report);
    assert.ok(!html.includes("href="), `no href for unsafe url ${JSON.stringify(url)}`);
    assert.ok(html.includes("#9"), `bare number rendered for unsafe url ${JSON.stringify(url)}`);
  }
});

test("renderer: empty sections degrade gracefully (no artifacts, no chronology)", () => {
  const report = ctoReport();
  report.artifacts = [];
  report.chronology = [];
  const html = renderReportHtml(report);
  assert.ok(html.includes("No artifacts declared for this session."));
  assert.ok(html.includes("No chronology recorded for this session."));
});
