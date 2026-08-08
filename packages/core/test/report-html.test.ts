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
import type { SessionReport, StageInfo } from "../src/report/types.js";

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

/**
 * Focused diagram fixture: exercises the typed endpoint rules —
 * a same-ID stage/artifact pair ("implementation"), a consumes edge whose
 * source is a declared-but-missing artifact ("oauth-plan"), and endpoints
 * that exist nowhere (ghost nodes keep the diagram connected).
 */
function diagramReport(): SessionReport {
  return {
    schema: 1,
    kind: "do-work",
    meta: {
      title: "Diagram fixture",
      task: "Diagram fixture task",
      branch: "feat/diagram",
      workflow: "standard",
      pause: { kind: "none", reason: "" },
      updated_at: "2026-08-08T10:00:00.000Z",
      generated_at: "2026-08-08T12:00:00.000Z",
      autonomous: true,
    },
    source: {
      kind: "do-work",
      id: "diagram",
      statePath: ".work-state/features/diagram/state.json",
      format: "json",
      isLegacy: false,
    },
    stages: [
      { id: "planning", title: "Planning", status: "done", phase: "standard", type: "orchestrator", at: "2026-08-08T09:00:00.000Z", agents: [{ name: "main session", role: "orchestrator", source: "workflow" }], inputs: [], outputs: [] },
      { id: "implementation", title: "Implementation", status: "in_progress", phase: "standard", type: "single", at: "2026-08-08T09:30:00.000Z", agents: [{ name: "dev", role: "single", source: "workflow" }, { name: "reviewer", role: "consilium", source: "observed" }], inputs: ["oauth-plan"], outputs: ["implementation"] },
    ],
    edges: [
      { from: "planning", to: "implementation", kind: "transition" },
      // Same-ID pair: stage "implementation" AND artifact "implementation".
      { from: "implementation", to: "implementation", kind: "produces", label: "plan" },
      // Consumes source is an artifact id (declared, but missing).
      { from: "oauth-plan", to: "implementation", kind: "consumes", label: "uses" },
      // Endpoint that exists nowhere → phantom artifact node keeps the diagram connected.
      { from: "planning", to: "ghost-artifact", kind: "produces" },
      // Endpoint that exists nowhere → phantom stage node.
      { from: "ghost-stage", to: "planning", kind: "transition" },
    ],
    artifacts: [
      {
        id: "implementation",
        path: ".work-state/features/diagram/artifacts/implementation.json",
        owner: "implementation",
        status: "produced",
        bytes: 12,
        mtime: "2026-08-08T09:31:00.000Z",
        summary: "plan",
      },
      {
        id: "oauth-plan",
        path: ".work-state/features/diagram/artifacts/oauth-plan.json",
        owner: "implementation",
        status: "missing",
        summary: "(missing)",
      },
    ],
    telemetry: { eventsPath: ".work-state/features/diagram/observability/events.jsonl", rollup: null },
    chronology: [],
    warnings: [],
  };
}

/**
 * Focused CTO fixture: two teams declare the same artifact id "dod" —
 * the diagram must collapse both into one deterministic node.
 */
function ctoDuplicateArtifactReport(): SessionReport {
  return {
    schema: 1,
    kind: "cto",
    meta: {
      title: "CTO duplicate dod",
      task: "Two teams, one dod",
      branch: "feat/cto-dup-dod",
      workflow: "cto",
      pause: { kind: "none", reason: "" },
      updated_at: "2026-08-08T11:00:00.000Z",
      generated_at: "2026-08-08T12:00:00.000Z",
      autonomous: false,
    },
    source: {
      kind: "cto",
      id: "cto-dup-dod",
      statePath: ".work-state/cto/cto-dup-dod/state.json",
      format: "json",
      isLegacy: false,
    },
    stages: [
      { id: "team-backend", title: "Backend team", status: "done", phase: "cto", type: "team", team: "backend", at: "2026-08-08T10:00:00.000Z" },
      { id: "team-web", title: "Web team", status: "in_progress", phase: "cto", type: "team", team: "web", at: "2026-08-08T10:30:00.000Z" },
    ],
    edges: [
      { from: "backend", to: "dod", kind: "produces" },
      { from: "web", to: "dod", kind: "produces" },
      { from: "dod", to: "team-web", kind: "consumes" },
    ],
    artifacts: [
      { id: "dod", path: ".work-state/cto/cto-dup-dod/teams/backend/dod.json", owner: "backend", status: "produced", bytes: 8, summary: "backend dod" },
      { id: "dod", path: ".work-state/cto/cto-dup-dod/teams/web/dod.json", owner: "web", status: "missing", summary: "(missing)" },
    ],
    teams: [
      { id: "backend", status: "done", slice: "API", profile: "full-feature", worktree: "separate_worktree", dod_path: ".work-state/cto/cto-dup-dod/teams/backend/dod.json", depends_on: [] },
      { id: "web", status: "in_progress", slice: "Frontend", profile: "standard", depends_on: ["backend"] },
    ],
    telemetry: { eventsPath: ".work-state/cto/cto-dup-dod/observability/events.jsonl", rollup: null },
    chronology: [],
    warnings: [],
  };
}

/**
 * Focused CTO fixture: the normalized report carries BOTH a derived stage
 * entry with id `team:<id>` AND a `report.teams` entry with the bare id —
 * the diagram must emit exactly one visual node per team (the derived stage
 * wins) while the dependency edges (which use `team:<id>` endpoints) stay
 * connected to that single node.
 */
function ctoDerivedTeamStageReport(): SessionReport {
  return {
    schema: 1,
    kind: "cto",
    meta: {
      title: "CTO derived team stages",
      task: "One diagram node per team",
      branch: "feat/cto-derived-teams",
      workflow: "cto",
      pause: { kind: "none", reason: "" },
      updated_at: "2026-08-08T11:00:00.000Z",
      generated_at: "2026-08-08T12:00:00.000Z",
      autonomous: false,
    },
    source: {
      kind: "cto",
      id: "cto-derived-teams",
      statePath: ".work-state/cto/cto-derived-teams/state.json",
      format: "json",
      isLegacy: false,
    },
    stages: [
      { id: "team:backend", title: "Backend team", status: "done", phase: "cto", type: "team", team: "backend", at: "2026-08-08T10:00:00.000Z" },
      { id: "team:web", title: "Web team", status: "in_progress", phase: "cto", type: "team", team: "web", at: "2026-08-08T10:30:00.000Z" },
    ],
    edges: [
      // CTO dependency edges use `team:<id>` endpoints — they must resolve to
      // the derived team stage node (never to a second, phantom team node).
      { from: "team:backend", to: "team:web", kind: "depends_on" },
    ],
    artifacts: [],
    teams: [
      { id: "backend", status: "done", slice: "API", profile: "full-feature", worktree: "separate_worktree", depends_on: [] },
      { id: "web", status: "in_progress", slice: "Frontend", profile: "standard", depends_on: ["backend"] },
    ],
    telemetry: { eventsPath: ".work-state/cto/cto-derived-teams/observability/events.jsonl", rollup: null },
    chronology: [],
    warnings: [],
  };
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

test("renderer: diagram renders typed stage and artifact SVG nodes in columns before the detail lists", () => {
  const html = renderReportHtml(diagramReport());
  assert.ok(html.includes('<svg id="omp-diagram-svg"'), "SVG diagram present");
  const diagramPos = html.indexOf('data-node-key="stage:planning"');
  const listsPos = html.indexOf('<div class="node-list stage-list">');
  assert.ok(diagramPos >= 0 && listsPos >= 0 && diagramPos < listsPos, "diagram precedes the detail lists");

  assert.ok(
    html.includes('data-node-key="stage:planning" data-node-id="planning" data-status="done" data-diagram-type="stage"'),
    "stage node typed and statused",
  );
  const ctoHtml = renderReportHtml(ctoReport());
  assert.ok(ctoHtml.includes('data-diagram-type="team"'), "CTO team nodes typed as teams");
  assert.ok(ctoHtml.includes('data-node-key="team:backend"'), "CTO team node keyed from report.teams");
  assert.ok(html.includes('data-node-key="artifact:oauth-plan"'), "artifact node typed");
  assert.ok(html.includes('data-diagram-type="artifact"'), "artifact diagram type marker");

  // Same-ID stage/artifact pair stays distinct: two nodes, one per lane.
  assert.ok(html.includes('data-node-key="stage:implementation"'), "stage node for the same-ID pair");
  assert.ok(html.includes('data-node-key="artifact:implementation"'), "artifact node for the same-ID pair");
  assert.ok(html.indexOf('data-node-key="stage:implementation"') !== html.indexOf('data-node-key="artifact:implementation"'), "same-ID nodes are distinct elements");

  // Missing artifacts stay visible in red; produced artifacts in green.
  assert.ok(html.includes('class="dg-node st-missing"'), "missing artifact node carries st-missing");
  assert.ok(html.includes('class="dg-node st-done"'), "produced artifact node carries st-done");

  // Accessible, keyboard-activatable nodes with visible focus ring wiring.
  assert.ok(html.includes('role="button" tabindex="0" aria-label="stage implementation, in progress"'), "stage node accessible label");
  assert.ok(html.includes('class="dg-node-focus"'), "focus ring element present");
});

test("renderer: diagram edges are directed curved paths with arrow markers, typed endpoints and kind labels", () => {
  const html = renderReportHtml(diagramReport());
  assert.ok(html.includes('<marker id="arr-ok"'), "green arrow marker for produces");
  assert.ok(html.includes('<marker id="arr-accent"'), "accent arrow marker for consumes");
  assert.ok(html.includes('<marker id="arr-gray"'), "gray arrow marker for transitions");
  assert.ok(html.includes('class="dg-edge kind-produces"'), "produces edge kind class");
  assert.ok(
    html.includes('data-from-key="stage:implementation" data-to-key="artifact:implementation"'),
    "same-ID produces edge typed: stage source, artifact target",
  );
  assert.ok(
    html.includes('data-from-key="artifact:oauth-plan" data-to-key="stage:implementation"'),
    "consumes source typed as artifact node",
  );
  assert.ok(html.includes('marker-end="url(#arr-ok)"'), "arrowhead marker applied");
  assert.ok(html.includes('<path class="dg-edge-path" d="M '), "curved path emitted");
  assert.ok(html.includes('class="dg-edge-label"'), "edge labels rendered in the diagram");
  assert.ok(html.includes(">produces: implementation</text>"), "produces edge labeled with the artifact it carries");
  assert.ok(html.includes(">consumes: oauth-plan</text>"), "consumes edge labeled with the artifact it carries");

  // Endpoints that exist nowhere become dashed phantom nodes — diagram stays connected.
  assert.ok(html.includes('data-node-key="artifact:ghost-artifact"'), "undeclared produces target becomes a phantom artifact node");
  assert.ok(html.includes('data-node-key="stage:ghost-stage"'), "unknown transition endpoint becomes a phantom stage node");
  assert.ok(html.includes("dg-phantom"), "phantom nodes are visually distinct");
});

/** Extract the SVG node box x coordinate for a typed node key. */
function nodeRectX(html: string, nodeKey: string): number {
  const re = new RegExp(`data-node-key="${nodeKey}"[^>]*><title>[^<]*</title><rect class="dg-node-box" x="(\\d+)"`);
  const m = re.exec(html);
  assert.ok(m, `diagram node ${nodeKey} rect present`);
  return Number(m![1]!);
}

test("renderer: diagram lays stages left-to-right with agent details, artifact edge labels and missing/produced colors", () => {
  const html = renderReportHtml(diagramReport());

  // Left-to-right columns ordered by report.stages; phantom endpoints append after.
  const planningX = nodeRectX(html, "stage:planning");
  const implementationX = nodeRectX(html, "stage:implementation");
  const ghostStageX = nodeRectX(html, "stage:ghost-stage");
  assert.ok(planningX < implementationX, "stage columns advance left to right in report order");
  assert.ok(implementationX < ghostStageX, "phantom stage column appends after real stages");
  // Artifact nodes stay attached to their producing/consuming stage edges: the
  // phantom artifact produced by planning sits between planning and the next column.
  const ghostArtifactX = nodeRectX(html, "artifact:ghost-artifact");
  assert.ok(planningX < ghostArtifactX && ghostArtifactX < implementationX, "artifact node sits in the gap between producing and next column");

  // Stage agent details render with role/source indication.
  assert.ok(html.includes("agents: main session (orchestrator, workflow)"), "orchestrator stage renders the main session agent");
  assert.ok(html.includes("agents: dev (single, workflow), reviewer (consilium, observed)"), "multiple agents render name, role and source");
  assert.ok(html.includes("in: oauth-plan"), "stage inputs rendered");
  assert.ok(html.includes("out: implementation"), "stage outputs rendered");
  const plain = renderReportHtml(doWorkReport());
  assert.ok(plain.includes("agents: no agent recorded"), "stage without recorded agents renders honestly");

  // Edges carry the artifact they move on produces/consumes labels.
  assert.ok(html.includes(">produces: implementation</text>"), "produces edge labeled with the artifact id");
  assert.ok(html.includes(">consumes: oauth-plan</text>"), "consumes edge labeled with the artifact id");
  assert.ok(html.includes(">produces: ghost-artifact</text>"), "phantom artifact id on produces label");
  assert.ok(html.includes(">transition</text>"), "non-artifact edge keeps its kind label");

  // Missing/produced artifact typing and colors preserved.
  assert.ok(/data-node-key="artifact:oauth-plan"[^>]*data-status="missing"/.test(html), "missing artifact typed and statused");
  assert.ok(/data-node-key="artifact:implementation"[^>]*data-status="produced"/.test(html), "produced artifact typed and statused");
  assert.ok(html.includes('class="dg-node st-missing"'), "missing artifact node carries the missing (red) style");
  assert.ok(html.includes('class="dg-node st-done"'), "produced artifact node carries the produced (green) style");
});

test("renderer: duplicate artifact ids collapse into one deterministic SVG node with an honest label", () => {
  const html = renderReportHtml(ctoDuplicateArtifactReport());

  // Exactly one diagram node is emitted for the shared artifact id.
  const dodNodes = html.match(/data-node-key="artifact:dod"/g) ?? [];
  assert.equal(dodNodes.length, 1, "duplicate artifact ids emit a single diagram node, no duplicate keys");

  // The collapsed node keeps the raw id, honors severity (missing wins over
  // produced), and stays the single click/filter/highlight target.
  assert.ok(
    /data-node-key="artifact:dod" data-node-id="dod" data-status="missing" data-diagram-type="artifact"/.test(html),
    "collapsed node keeps the raw id and the worst (missing) status",
  );
  const dodIds = html.match(/data-node-id="dod"/g) ?? [];
  assert.equal(dodIds.length, 1, "exactly one interactive node for id dod");
  assert.ok(html.includes('class="dg-node st-missing"'), "collapsed node stays visibly missing");

  // Honest duplicate label in the tooltip and on the node title text.
  assert.ok(html.includes("<title>dod (2 owners)</title>"), "tooltip names the duplicate owner count");
  assert.ok(html.includes(">dod (2 owners)</text>"), "node title text names the duplicate owner count");

  // Both producing teams' edges resolve to the single collapsed node; the
  // consumes edge leaves from it.
  const toDod = html.match(/data-to-key="artifact:dod"/g) ?? [];
  assert.equal(toDod.length, 2, "both teams' produces edges target the collapsed node");
  assert.ok(html.includes('data-from-key="artifact:dod" data-to-key="stage:team-web"'), "consumes edge leaves the collapsed node");

  // The data island and the artifact cards are untouched: two raw entries.
  const parsed = extractIsland(html) as SessionReport;
  assert.equal(parsed.artifacts.length, 2, "data island keeps both artifact entries");
  assert.equal(parsed.artifacts.filter((a) => a.id === "dod").length, 2, "raw artifact ids preserved in the island");
  const cards = html.match(/<article class="artifact"/g) ?? [];
  assert.equal(cards.length, 2, "artifact cards unchanged for duplicate ids");
  assert.ok(html.includes('class="artifact-id">dod</h3>'), "artifact cards render the raw id");
});

test("renderer: derived team: stage and bare report.teams entry emit one diagram node with edges connected", () => {
  const html = renderReportHtml(ctoDerivedTeamStageReport());

  // Exactly one process node per team: the derived `team:<id>` stage wins,
  // the bare team node is skipped — no visual duplication.
  assert.equal((html.match(/data-node-key="stage:team:backend"/g) ?? []).length, 1, "derived backend stage node emitted once");
  assert.equal((html.match(/data-node-key="stage:team:web"/g) ?? []).length, 1, "derived web stage node emitted once");
  assert.equal((html.match(/data-node-key="team:backend"/g) ?? []).length, 0, "bare team node skipped when the derived team: stage exists");
  assert.equal((html.match(/data-node-key="team:web"/g) ?? []).length, 0, "bare web team node skipped when the derived team: stage exists");

  // The surviving node is the derived stage, carrying the team's status.
  assert.ok(
    /data-node-key="stage:team:backend" data-node-id="team:backend" data-status="done" data-diagram-type="stage"/.test(html),
    "derived stage node typed and statused",
  );

  // CTO dependency edges use `team:<id>` endpoints and resolve to the single
  // derived node — never to a duplicate or phantom team target.
  assert.ok(
    html.includes('data-from-key="stage:team:backend" data-to-key="stage:team:web"'),
    "depends_on edge connects the two derived team nodes",
  );
  assert.ok(html.includes('data-from="team:backend" data-to="team:web"'), "edge keeps the raw team:<id> endpoints");

  // The detail team list stays unchanged: both bare team cards still render.
  assert.ok(html.includes('<div class="node-list team-list">'), "team detail list present");
  assert.ok((html.match(/data-node-id="backend"/g) ?? []).length >= 1, "team detail list still renders the bare team id");
  assert.ok(html.includes("slice: API"), "backend team detail preserved");
});

test("renderer: report without a derived team: stage still emits the standalone team node", () => {
  const html = renderReportHtml(ctoReport());

  // ctoReport uses `team-backend`-style stage ids, so no derived `team:<id>`
  // stage exists — the bare team node must still render (exactly once).
  assert.equal((html.match(/data-node-key="stage:team:backend"/g) ?? []).length, 0, "no derived team: stage in this fixture");
  assert.equal((html.match(/data-node-key="team:backend"/g) ?? []).length, 1, "standalone team node emitted when no derived stage exists");
  assert.ok(
    /data-node-key="team:backend" data-node-id="backend" data-status="done" data-diagram-type="team"/.test(html),
    "standalone team node typed as team",
  );
});

test("renderer: derived team: stage and bare team card share selection/highlight via the team: alias, report unchanged", () => {
  const report = ctoDerivedTeamStageReport();
  const html = renderReportHtml(report);

  // The alias is client-side selection/highlight only — the serialized
  // report (and the server-rendered structure) is byte-for-byte unchanged.
  assert.deepEqual(extractIsland(html), report, "report serialization unchanged");

  // Typed keys stay exact: the derived stage keeps its stage:team:backend key
  // and raw team:<id> id, while the bare team detail card keeps the bare id.
  assert.ok(
    /data-node-key="stage:team:backend" data-node-id="team:backend" data-status="done" data-diagram-type="stage"/.test(html),
    "derived stage node keeps its typed key and raw team:<id> id",
  );
  assert.ok((html.match(/data-node-id="backend"/g) ?? []).length >= 1, "bare team detail card keeps the bare id");

  // The inline script defines sameNodeId and compares every raw id through it.
  const script = /<script>\n\(function \(\) \{[\s\S]*?\n\}\)\(\);\n<\/script>/.exec(html)?.[0] ?? "";
  assert.ok(script.includes("function sameNodeId(a, b)"), "inline script defines the sameNodeId helper");
  assert.ok(
    script.includes('sameNodeId(n.getAttribute("data-node-id"), id)'),
    "applyActive compares node ids through sameNodeId",
  );
  assert.ok(
    script.includes('sameNodeId(a.getAttribute("data-owner"), id)'),
    "applyActive compares artifact owners through sameNodeId",
  );
  assert.ok(
    script.includes("sameNodeId(f, id) || sameNodeId(t, id)"),
    "applyActive compares detail edge endpoints through sameNodeId",
  );
  assert.ok(
    script.includes('sameNodeId(n.getAttribute("data-node-id"), id)) keys.push'),
    "keysForId maps ids to svg keys through sameNodeId",
  );
  assert.ok(!script.includes("sameNodeId(fk"), "typed svg edge keys are never matched through the alias");

  // Evaluate the shipped helper (pure, no DOM) and prove the cross-highlight
  // semantics: clicking the bare team card or the derived team: stage selects
  // the other; unrelated ids never match.
  const fnMatch = /function sameNodeId\(a, b\) \{[\s\S]*?\n  \}/.exec(script);
  assert.ok(fnMatch, "sameNodeId source is extractable from the inline script");
  const sameNodeId = new Function(`${fnMatch[0]}\n  return sameNodeId;`)() as (a: string, b: string) => boolean;

  assert.equal(sameNodeId("backend", "backend"), true, "exact bare ids match");
  assert.equal(sameNodeId("team:backend", "team:backend"), true, "exact team: ids match");
  assert.equal(sameNodeId("team:backend", "backend"), true, "derived stage id selects the bare team card");
  assert.equal(sameNodeId("backend", "team:backend"), true, "bare team card selects the derived stage id");
  assert.equal(sameNodeId("backend", "web"), false, "unrelated bare ids never match");
  assert.equal(sameNodeId("team:backend", "team:web"), false, "unrelated team: ids never match");
  assert.equal(sameNodeId("team:backend", "web"), false, "team: prefix does not alias an unrelated bare id");
});

test("renderer: diagram interaction controls are inline, keyboard-friendly and offline", () => {
  const html = renderReportHtml(diagramReport());
  assert.ok(html.includes('id="omp-zoom-in"'), "zoom in control");
  assert.ok(html.includes('id="omp-zoom-out"'), "zoom out control");
  assert.ok(html.includes('id="omp-zoom-reset"'), "zoom reset control");
  assert.ok(html.includes('id="omp-zoom-label"'), "zoom percentage readout");
  assert.ok(html.includes('aria-live="polite"'), "zoom readout announced");
  assert.ok(html.includes('class="diagram-scroll" id="omp-diagram-scroll"'), "scrollable diagram viewport");
  assert.ok(html.includes("prefers-reduced-motion"), "reduced motion respected");
  assert.ok(html.includes('ev.key === "Enter" || ev.key === " "'), "keyboard activation wired");
  assert.ok(html.includes("applyZoom"), "zoom logic wired");
  assert.ok(html.includes("data-from-key"), "typed endpoint matching wired into the script data model");
  assert.ok(html.includes("data-edge-key"), "script targets diagram edges");

  // Offline contract holds for the diagram output too.
  assert.ok(!html.includes("http://"), "no plain-http references");
  assert.ok(!html.includes("https://"), "no https references");
  assert.ok(!html.includes('src="'), "no src attributes anywhere");
  assert.ok(!html.includes("fetch("), "no fetch calls");
  assert.ok(!html.includes("<link"), "no <link> elements");
  assert.ok(!html.includes("<script src"), "no external scripts");
});

test("renderer: diagram svg renders intrinsic dimensions matching the viewBox, wider than the report column", () => {
  const html = renderReportHtml(diagramReport());
  const m = /<svg id="omp-diagram-svg" width="(\d+)" height="(\d+)" viewBox="0 0 (\d+) (\d+)"/.exec(html);
  assert.ok(m, "svg emits explicit intrinsic width and height attributes alongside the viewBox");
  assert.equal(m[1], m[3], "intrinsic width equals the viewBox width");
  assert.equal(m[2], m[4], "intrinsic height equals the viewBox height");
  assert.ok(Number(m[1]) > 980, "canvas is wider than the 980px report column");

  // A 10-stage workflow (the compressed-report case) must keep a multi-thousand
  // pixel intrinsic width — the workflow canvas, not the report column, defines it.
  const wide = doWorkReport();
  wide.stages = Array.from({ length: 10 }, (_, i) => ({
    id: `stage-${i}`,
    title: `Stage ${i}`,
    status: (i % 2 === 0 ? "done" : "pending") as StageInfo["status"],
    phase: "standard",
    type: "single",
    at: "2026-08-08T09:00:00.000Z",
  }));
  wide.edges = wide.stages.slice(1).map((s, i) => ({ from: wide.stages[i]!.id, to: s.id, kind: "transition" }));
  wide.artifacts = [];
  const wideHtml = renderReportHtml(wide);
  const wm = /<svg id="omp-diagram-svg" width="(\d+)" height="(\d+)" viewBox="0 0 (\d+) (\d+)"/.exec(wideHtml);
  assert.ok(wm, "wide report svg carries intrinsic dimensions");
  assert.equal(wm[1], wm[3], "wide svg width equals its viewBox width");
  assert.equal(wm[2], wm[4], "wide svg height equals its viewBox height");
  assert.ok(Number(wm[1]) > 4000, "10-stage canvas stays multi-thousand-pixel wide");

  // Preservation: intrinsic sizing must not disturb graph/interaction markup.
  assert.ok(html.includes('role="img" aria-label='), "svg keeps its accessible role and label");
  assert.ok(html.includes('data-node-key="stage:planning"'), "typed nodes still render");
  assert.ok(html.includes('class="dg-edge kind-produces"'), "typed edges still render");
  assert.ok(html.includes('id="omp-zoom-in"'), "zoom controls still render");
  assert.ok(html.includes('class="diagram-scroll" id="omp-diagram-scroll"'), "scroll viewport still present");
});

test("renderer: diagram svg is intrinsically sized so the scroll viewport exposes horizontal overflow", () => {
  const html = renderReportHtml(diagramReport());
  assert.ok(html.includes(".diagram-scroll { overflow: auto;"), "scroll viewport keeps overflow: auto");
  assert.ok(
    /#omp-diagram-svg \{ display: block; width: auto; min-width: 0; height: auto; transform-origin: 0 0;/.test(html),
    "svg is sized intrinsically (width auto, min-width 0, height auto), never scaled to the report column",
  );
  assert.ok(!/#omp-diagram-svg[^}]*width: 100%/.test(html), "no width:100% scaling rule remains for the svg");
  assert.ok(html.includes("transition: transform .18s ease"), "zoom transition preserved");
  assert.ok(html.includes("prefers-reduced-motion"), "reduced-motion handling preserved");
});

test("renderer: diagram hint explains horizontal scrolling and the click/Enter/Space highlight interaction", () => {
  const html = renderReportHtml(diagramReport());
  const hint = /<span class="diagram-hint">([\s\S]*?)<\/span>/.exec(html)?.[1] ?? "";
  assert.ok(/scroll horizontally/i.test(hint), "hint tells the reader to scroll horizontally to follow the workflow");
  assert.ok(/Enter\/Space/i.test(hint), "hint keeps the Enter/Space keyboard activation");
  assert.ok(/highlight/i.test(hint), "hint keeps the click-to-highlight guidance");
  assert.ok(/edges and cards/i.test(hint), "hint names what gets highlighted: edges and cards");
});
