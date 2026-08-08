/**
 * renderReportHtml — pure, self-contained HTML renderer for SessionReport.
 *
 * Produces a single file://-openable HTML string:
 *   - ALL CSS is inline in a <style> block.
 *   - ALL report data is embedded in an escaped JSON data island
 *     (<script id="omp-report-data" type="application/json">).
 *   - A small amount of vanilla JS enhances navigation (stage/team selection,
 *     edge + artifact highlighting, status filter). No external link, script
 *     src, fetch, or runtime/browser dependency is emitted.
 *
 * Safety:
 *   - Static text is HTML-escaped (esc).
 *   - The data island escapes every `<` as \u003c plus U+2028/U+2029, so
 *     embedded payloads can never close the script tag and JSON.parse
 *     round-trips the report byte-for-byte.
 *   - Artifact bodies are already sanitized/redacted and byte-capped by the
 *     assembler; the renderer only escapes them for the HTML text node.
 *
 * Timestamps: unknown/invalid timestamps are rendered as "(unknown)"; CTO
 * stages carry a "derived" chip because CtoState has no explicit stage
 * timeline (statuses are derived from team/integration state).
 */

import type { SessionReport } from "./types.js";

// ── Escaping ────────────────────────────────────────────────────────────────

/** HTML-escape a value for a text node or double-quoted attribute. */
function esc(value: unknown): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * True when a value is a usable http(s) link target: a non-empty string whose
 * scheme is exactly http:// or https:// (case-insensitive). Empty, malformed,
 * and non-http(s) schemes (javascript:, data:, file:, …) are rejected so
 * agent-written state can never produce a script-capable href.
 */
function isHttpUrl(value: unknown): value is string {
  if (typeof value !== "string" || value.trim().length === 0) return false;
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

/**
 * Serialize the report into a JSON string that is safe to embed between
 * <script>…</script> delimiters. `<` can only appear inside JSON string
 * literals, so replacing it with the (string-valid) \u003c escape can never
 * change the document structure and JSON.parse round-trips the payload.
 */
function jsonIsland(report: SessionReport): string {
  return JSON.stringify(report)
    .replace(/</g, "\\u003c")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}

// ── Status / label helpers ──────────────────────────────────────────────────

const STATUS_CLASS: Record<string, string> = {
  pending: "st-pending",
  not_started: "st-pending",
  in_progress: "st-active",
  done: "st-done",
  produced: "st-done",
  skipped: "st-skipped",
  parked: "st-parked",
  missing: "st-missing",
  failed: "st-failed",
};

function statusClass(status: string): string {
  return STATUS_CLASS[status] ?? "st-unknown";
}

function statusLabel(status: string): string {
  return status.replace(/_/g, " ");
}

const EDGE_LABELS: Record<string, string> = {
  produces: "produces",
  consumes: "consumes",
  depends_on: "depends on",
  integration: "integration",
  transition: "transition",
};

/** Render an ISO timestamp or a visible "(unknown)" marker. */
function renderTime(iso: string | undefined, fallback = "(unknown)"): string {
  if (!iso) return `<span class="unknown">${esc(fallback)}</span>`;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return `<span class="unknown">${esc(fallback)}</span>`;
  return `<time datetime="${esc(iso)}">${esc(iso)}</time>`;
}

function humanDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return esc(String(ms));
  if (ms < 1000) return `${Math.round(ms)} ms`;
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s} s`;
  return `${Math.floor(s / 60)} min ${s % 60} s`;
}

// ── Section renderers (server-side, escaped) ────────────────────────────────

function renderHeader(report: SessionReport): string {
  const m = report.meta;
  const src = report.source;
  const rows: string[] = [];

  const push = (label: string, valueHtml: string): void => {
    rows.push(`<div class="meta-row"><dt>${esc(label)}</dt><dd>${valueHtml}</dd></div>`);
  };

  push("Kind", `<span class="badge b-kind">${esc(report.kind)}</span>`);
  push("Session", esc(src.id));
  push(
    "Task",
    m.task ? esc(m.task) : '<span class="unknown">(no task)</span>',
  );
  push("Branch", m.branch ? esc(m.branch) : '<span class="unknown">(none)</span>');
  if (m.workflow) push("Workflow", esc(m.workflow));
  if (m.classification) {
    const c = m.classification;
    push(
      "Classification",
      `${esc(c.type)} · ${esc(c.complexity)} · ${esc(c.confidence)} · ${c.autonomous ? "autonomous" : "supervised"}` +
        (c.autonomous_reason ? ` <span class="muted">— ${esc(c.autonomous_reason)}</span>` : ""),
    );
  }
  if (m.issue) {
    const issue = m.issue;
    push(
      "Issue",
      isHttpUrl(issue.url)
        ? `<a href="${esc(issue.url)}" rel="noopener">#${esc(String(issue.number))}</a>`
        : `#${esc(String(issue.number))}`,
    );
  }
  push(
    "Pause",
    `${esc(m.pause.kind)}${m.pause.reason ? ` — ${esc(m.pause.reason)}` : ""}`,
  );
  push("Updated", renderTime(m.updated_at));
  push("Generated", renderTime(m.generated_at));
  if (m.autonomous !== undefined) push("Autonomy", m.autonomous ? "autonomous" : "supervised");
  if (m.standby) push("Standby", "standby run");
  if (m.amended_at) push("Amended", renderTime(m.amended_at));
  if (m.owner_session) push("Owner session", esc(m.owner_session));

  const sourceBits: string[] = [];
  if (src.statePath) sourceBits.push(`state: ${esc(src.statePath)}`);
  else sourceBits.push('<span class="unknown">markdown fallback — no state file</span>');
  sourceBits.push(`format: ${esc(src.format)}`);
  if (src.isLegacy) sourceBits.push("legacy root layout");
  if (src.isStale) sourceBits.push('<span class="warn-chip">stale state</span>');
  push("Source", sourceBits.join(" · "));

  return `<header class="report-header"><h1>${esc(m.title)}</h1><dl class="meta-grid">${rows.join("")}</dl></header>`;
}

function renderGraphSection(report: SessionReport): string {
  const isCto = report.kind === "cto";
  const header = isCto
    ? "CTO team &amp; dependency graph"
    : "Workflow stage graph";
  const note = isCto
    ? '<p class="graph-note">Stage statuses below are <strong>derived</strong> from team/integration state — CtoState has no explicit stage timeline. Click a node to highlight its edges and artifacts.</p>'
    : '<p class="graph-note">Click a stage to highlight its edges and produced artifacts.</p>';

  const filterGroups = new Set<string>(["all"]);
  for (const s of report.stages) filterGroups.add(s.status);
  if (report.teams) for (const t of report.teams) filterGroups.add(t.status);
  const chips = [...filterGroups]
    .map(
      (g) =>
        `<button type="button" class="chip${g === "all" ? " on" : ""}" data-filter="${esc(g)}">${esc(g === "all" ? "all" : statusLabel(g))}</button>`,
    )
    .join("");

  const nodes = report.stages
    .map((s) => renderStageNode(s, isCto))
    .join("");
  const teams = report.teams ? `<h3>Teams</h3><div class="node-list team-list">${report.teams.map(renderTeamNode).join("")}</div>` : "";
  const edges = renderEdges(report.edges);
  const integration = report.integration ? renderIntegration(report.integration) : "";

  return `<section class="section" id="omp-graph"><h2>${header}</h2>${note}<div class="graph-filter" id="omp-graph-filter">${chips}</div><div class="node-list stage-list">${nodes}</div>${teams}${edges}${integration}</section>`;
}

function renderStageNode(s: SessionReport["stages"][number], derived: boolean): string {
  const meta: string[] = [];
  if (s.phase) meta.push(`phase: ${esc(s.phase)}`);
  if (s.type) meta.push(`type: ${esc(s.type)}`);
  if (s.team) meta.push(`team: ${esc(s.team)}`);
  const derivedChip = derived ? '<span class="derived-chip" title="derived from team/integration state">derived</span>' : "";
  const detail = s.detail ? `<div class="node-detail">${esc(s.detail)}</div>` : "";
  return `<article class="node ${statusClass(s.status)}" data-node-id="${esc(s.id)}" data-status="${esc(s.status)}" tabindex="0"><header class="node-head"><span class="node-dot"></span><h3 class="node-title">${esc(s.title ?? s.id)}</h3><span class="badge b-status ${statusClass(s.status)}">${esc(statusLabel(s.status))}</span>${derivedChip}</header><div class="node-meta">${meta.join(" · ")}</div><div class="node-time">at: ${renderTime(s.at, "(no timestamp)")}</div>${detail}</article>`;
}

function renderTeamNode(t: NonNullable<SessionReport["teams"]>[number]): string {
  const meta: string[] = [];
  if (t.slice) meta.push(`slice: ${esc(t.slice)}`);
  if (t.profile) meta.push(`profile: ${esc(t.profile)}`);
  if (t.worktree) meta.push(`worktree: ${esc(t.worktree)}`);
  if (t.depends_on?.length) meta.push(`depends on: ${esc(t.depends_on.join(", "))}`);
  if (t.escalations) meta.push(`escalations: ${esc(String(t.escalations))}`);
  if (t.dod_path) meta.push(`dod: ${esc(t.dod_path)}`);
  const scope = t.scope?.length
    ? `<div class="node-scope">scope: ${t.scope.map((v) => esc(v)).join(", ")}</div>`
    : "";
  return `<article class="node ${statusClass(t.status)} team-node" data-node-id="${esc(t.id)}" data-status="${esc(t.status)}" tabindex="0"><header class="node-head"><span class="node-dot"></span><h3 class="node-title">${esc(t.id)}</h3><span class="badge b-status ${statusClass(t.status)}">${esc(statusLabel(t.status))}</span></header>${scope}<div class="node-meta">${meta.join(" · ")}</div></article>`;
}

function renderEdges(edges: SessionReport["edges"]): string {
  if (edges.length === 0) return "";
  const rows = edges
    .map(
      (e) =>
        `<li class="edge" data-edge data-from="${esc(e.from)}" data-to="${esc(e.to)}"><span class="edge-node e-from">${esc(e.from)}</span><span class="edge-arrow">→</span><span class="edge-node e-to">${esc(e.to)}</span><span class="badge b-edge">${esc(EDGE_LABELS[e.kind] ?? e.kind)}</span>${e.label ? `<span class="edge-label">${esc(e.label)}</span>` : ""}</li>`,
    )
    .join("");
  return `<h3>Dependencies &amp; transitions</h3><ul class="edge-list">${rows}</ul>`;
}

function renderIntegration(i: NonNullable<SessionReport["integration"]>): string {
  return `<div class="integration"><span class="badge b-status ${statusClass(i.status)}">integration: ${esc(statusLabel(i.status))}</span>${i.note ? `<span class="integration-note">${esc(i.note)}</span>` : ""}</div>`;
}

function renderArtifacts(report: SessionReport): string {
  if (report.artifacts.length === 0) {
    return `<section class="section"><h2>Artifacts</h2><p class="empty">No artifacts declared for this session.</p></section>`;
  }
  const cards = report.artifacts.map(renderArtifactCard).join("");
  return `<section class="section" id="omp-artifacts"><h2>Artifacts <span class="count">${report.artifacts.length}</span></h2>${cards}</section>`;
}

function renderArtifactCard(a: SessionReport["artifacts"][number]): string {
  const meta: string[] = [`owner: ${esc(a.owner)}`, `path: ${esc(a.path)}`];
  if (a.bytes !== undefined) meta.push(`${esc(String(a.bytes))} B`);
  if (a.mtime) meta.push(`mtime: ${renderTime(a.mtime)}`);
  const typeLine = a.type || a.keys?.length
    ? `<div class="artifact-type">${a.type ? `type: ${esc(a.type)}` : ""}${a.type && a.keys?.length ? " · " : ""}${a.keys?.length ? `keys: ${a.keys.map((k) => esc(k)).join(", ")}` : ""}</div>`
    : "";
  const statusNote =
    a.status === "missing"
      ? '<p class="artifact-status-note">not produced — declared but no artifact file found</p>'
      : a.status === "skipped"
        ? '<p class="artifact-status-note">not produced — stage skipped</p>'
        : "";
  const summary = a.summary
    ? `<p class="artifact-summary">${esc(a.summary)}</p>`
    : `<p class="artifact-summary muted">(no summary)</p>`;
  const body =
    a.body !== undefined
      ? `<details class="artifact-body"><summary>Show full content (${esc(String(a.bytes ?? a.body.length))} B)</summary><pre>${esc(a.body)}</pre></details>`
      : "";
  return `<article class="artifact" data-owner="${esc(a.owner)}"><header class="artifact-head"><h3 class="artifact-id">${esc(a.id)}</h3><span class="badge b-status ${statusClass(a.status)}">${esc(statusLabel(a.status))}</span></header><div class="artifact-meta">${meta.join(" · ")}</div>${typeLine}${statusNote}${summary}${body}</article>`;
}

function renderChronology(report: SessionReport): string {
  if (report.chronology.length === 0) {
    return `<section class="section"><h2>Chronology</h2><p class="empty">No chronology recorded for this session.</p></section>`;
  }
  const sourceLabels: Record<string, string> = {
    event: "event timestamp",
    mtime: "artifact mtime",
    state: "state.updated_at",
    ordinal: "ordinal (untimed)",
  };
  const items = report.chronology
    .map((c) => {
      const time = c.source === "ordinal" ? '<span class="unknown">(untimed)</span>' : renderTime(c.at);
      const sourceLabel = sourceLabels[c.source] ?? c.source;
      const ref = c.ref ? `<div class="tl-ref">ref: ${esc(c.ref)}</div>` : "";
      return `<li class="tl-item" data-source="${esc(c.source)}"><span class="tl-dot"></span><div class="tl-body"><div class="tl-head"><span class="tl-time">${time}</span><span class="badge b-kind">${esc(c.kind)}</span>${c.eventKind ? `<span class="badge b-edge">${esc(c.eventKind)}</span>` : ""}<span class="badge b-source">${esc(sourceLabel)}</span></div><div class="tl-label">${esc(c.label)}</div>${ref}</div></li>`;
    })
    .join("");
  return `<section class="section" id="omp-chronology"><h2>Chronology <span class="count">${report.chronology.length}</span></h2><ol class="timeline">${items}</ol></section>`;
}

function renderTelemetry(report: SessionReport): string {
  const t = report.telemetry;
  const title = `<h2>Telemetry</h2>`;
  if (!t.rollup) {
    return `<section class="section"><h2>Telemetry</h2><p class="empty">No telemetry recorded for this session (observability absent or corrupt).</p>${t.eventsPath ? `<p class="muted">event log: ${esc(t.eventsPath)} (not embedded)</p>` : ""}</section>`;
  }
  const r = t.rollup;
  const rows: Array<[string, string]> = [
    ["Agent invocations", esc(String(r.agentInvocations))],
    ["Tool calls", esc(String(r.totalToolCalls))],
    ["Tool errors", esc(String(r.totalToolErrors))],
    ["Duration", esc(humanDuration(r.durationMs))],
    ["First event", renderTime(r.firstEventAt)],
    ["Last event", renderTime(r.lastEventAt)],
  ];
  if (r.estimatedTokens !== undefined) rows.push(["Est. tokens", esc(String(r.estimatedTokens))]);
  if (r.estimatedDollars !== undefined) rows.push(["Est. dollars", esc(String(r.estimatedDollars))]);
  const counts = t.eventCounts
    ? Object.entries(t.eventCounts)
        .map(([k, v]) => `<span class="badge b-edge">${esc(k)}: ${esc(String(v))}</span>`)
        .join("")
    : "";
  const tools = Object.keys(r.tools)
    .map((k) => `<li>${esc(k)} — ${esc(String(r.tools[k]))}</li>`)
    .join("");
  const agents = Object.keys(r.agents)
    .map((k) => `<li>${esc(k)} — ${esc(String(r.agents[k]))}</li>`)
    .join("");
  const skills = Object.keys(r.skills)
    .map((k) => `<span class="badge b-skill">${esc(k)}</span>`)
    .join("");
  return `<section class="section" id="omp-telemetry">${title}<dl class="meta-grid">${rows.map(([l, v]) => `<div class="meta-row"><dt>${esc(l)}</dt><dd>${v}</dd></div>`).join("")}</dl>${counts ? `<div class="telemetry-counts">${counts}</div>` : ""}<div class="telemetry-cols"><div><h3>Tools</h3>${tools ? `<ul class="kv-list">${tools}</ul>` : '<p class="muted">none</p>'}</div><div><h3>Agents</h3>${agents ? `<ul class="kv-list">${agents}</ul>` : '<p class="muted">none</p>'}</div></div>${skills ? `<div class="telemetry-skills"><h3>Skills</h3>${skills}</div>` : ""}<p class="muted">Raw events are never embedded; only bounded counts are shown.</p></section>`;
}

function renderHealth(report: SessionReport): string {
  const h = report.health;
  if (!h) return "";
  const issues = h.issues.length
    ? `<ul class="issue-list">${h.issues.map((x) => `<li>${esc(x)}</li>`).join("")}</ul>`
    : "";
  const bits: string[] = [];
  if (h.active_teams !== undefined) bits.push(`active teams: ${esc(String(h.active_teams))}`);
  if (h.parked_teams !== undefined) bits.push(`parked teams: ${esc(String(h.parked_teams))}`);
  if (h.failed_teams !== undefined) bits.push(`failed teams: ${esc(String(h.failed_teams))}`);
  if (h.pending_escalations !== undefined) bits.push(`pending escalations: ${esc(String(h.pending_escalations))}`);
  if (h.budget_status) bits.push(`budget: ${esc(h.budget_status)}`);
  return `<section class="section" id="omp-health"><h2>Health</h2><p class="health-banner ${h.healthy ? "health-ok" : "health-bad"}">${h.healthy ? "Healthy" : "Needs attention"}</p>${issues}${bits.length ? `<div class="node-meta">${bits.join(" · ")}</div>` : ""}</section>`;
}

function renderWarnings(report: SessionReport): string {
  if (report.warnings.length === 0) return "";
  return `<section class="section" id="omp-warnings"><details class="warnings"><summary>Warnings (${report.warnings.length})</summary><ul class="issue-list">${report.warnings.map((w) => `<li>${esc(w)}</li>`).join("")}</ul></details></section>`;
}

const REDACTION_NOTICE =
  'Security &amp; provenance: this report is generated offline from sanitized state. Secrets, raw event logs, transcripts, escalation bodies, and unsanitized prompts/artifacts are never embedded; artifact content is redacted and byte-capped. Opening this file makes no external requests.';

// ── Inline application script (vanilla JS, no template literals) ────────────

const APP_SCRIPT = `<script>
(function () {
  "use strict";
  var island = document.getElementById("omp-report-data");
  if (!island) return;
  var report = null;
  try { report = JSON.parse(island.textContent || "null"); } catch (e) { report = null; }

  var nodes = document.querySelectorAll("[data-node-id]");
  var edges = document.querySelectorAll("[data-edge]");
  var artifacts = document.querySelectorAll("[data-owner]");

  nodes.forEach(function (node) {
    node.addEventListener("click", function () {
      var id = node.getAttribute("data-node-id");
      var active = node.classList.toggle("sel");
      edges.forEach(function (e) {
        var f = e.getAttribute("data-from");
        var t = e.getAttribute("data-to");
        if (f === id || t === id) e.classList.toggle("hl", active);
      });
      artifacts.forEach(function (a) {
        if (a.getAttribute("data-owner") === id) a.classList.toggle("hl", active);
      });
    });
  });

  var filter = document.getElementById("omp-graph-filter");
  if (filter) {
    var chips = filter.querySelectorAll("[data-filter]");
    chips.forEach(function (chip) {
      chip.addEventListener("click", function () {
        var wanted = chip.getAttribute("data-filter");
        chips.forEach(function (c) { c.classList.toggle("on", c === chip); });
        nodes.forEach(function (n) {
          var st = n.getAttribute("data-status") || "";
          n.style.display = (wanted === "all" || st === wanted) ? "" : "none";
        });
      });
    });
  }
})();
</script>`;

// ── Stylesheet (inline, no external assets) ─────────────────────────────────

const CSS = `
:root {
  --bg: #f5f6f8;
  --card: #ffffff;
  --ink: #1c2330;
  --muted: #667085;
  --line: #e4e7ec;
  --accent: #2f6fed;
  --ok: #12b76a;
  --warn: #b54708;
  --err: #d92d20;
  --amber: #b54708;
}
* { box-sizing: border-box; }
html { -webkit-text-size-adjust: 100%; }
body {
  margin: 0;
  font: 14px/1.55 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
  background: var(--bg);
  color: var(--ink);
}
.container { max-width: 980px; margin: 0 auto; padding: 28px 18px 72px; }
h1 { font-size: 22px; margin: 0 0 4px; letter-spacing: -0.01em; }
h2 { font-size: 16px; margin: 0 0 12px; border-bottom: 1px solid var(--line); padding-bottom: 6px; }
h3 { font-size: 13px; margin: 0; }
.count { color: var(--muted); font-weight: 400; }
.muted { color: var(--muted); }
.empty { color: var(--muted); font-style: italic; margin: 4px 0 0; }
.unknown { color: var(--err); font-style: italic; }
section.section { background: var(--card); border: 1px solid var(--line); border-radius: 10px; padding: 16px 18px; margin-top: 16px; }

/* header */
.report-header { margin-bottom: 4px; }
.report-header h1 { word-break: break-word; }
.meta-grid { display: grid; grid-template-columns: 1fr; gap: 4px 16px; margin: 12px 0 0; }
.meta-row { display: flex; gap: 10px; padding: 4px 0; border-top: 1px solid var(--line); }
.meta-row dt { flex: 0 0 118px; color: var(--muted); font-weight: 600; }
.meta-row dd { margin: 0; word-break: break-word; }

/* badges */
.badge {
  display: inline-block; padding: 1px 8px; border-radius: 999px;
  font-size: 11px; font-weight: 600; line-height: 1.6; vertical-align: middle;
  white-space: nowrap;
}
.b-kind { background: #eef2ff; color: #3730a3; }
.b-edge { background: #f0f2f5; color: #475467; }
.b-source { background: #fef3c7; color: #92400e; }
.b-skill { background: #e6f4ea; color: #1e5e3a; }
.b-status { color: #fff; }
.st-done { background: var(--ok); }
.st-active { background: var(--accent); }
.st-pending { background: #98a2b3; }
.st-skipped { background: #d0d5dd; color: #344054; }
.st-parked { background: var(--amber); }
.st-missing { background: var(--err); }
.st-failed { background: var(--err); }
.st-unknown { background: #98a2b3; }
.warn-chip { background: #fef3c7; color: #92400e; padding: 0 6px; border-radius: 4px; font-size: 12px; }
.derived-chip { background: #f0f2f5; color: #475467; padding: 0 6px; border-radius: 4px; font-size: 11px; font-weight: 600; }

/* graph */
.graph-note { color: var(--muted); font-size: 13px; margin: 0 0 10px; }
.graph-filter { display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 12px; }
.chip {
  border: 1px solid var(--line); background: var(--card); color: var(--muted);
  border-radius: 999px; padding: 2px 10px; font-size: 12px; cursor: pointer;
}
.chip.on { background: var(--accent); border-color: var(--accent); color: #fff; }
.node-list { display: flex; flex-direction: column; gap: 8px; }
.node {
  border: 1px solid var(--line); border-left: 4px solid #98a2b3;
  border-radius: 8px; padding: 10px 12px; background: var(--card); cursor: pointer;
  transition: border-color .12s ease, background .12s ease;
}
.node.sel { background: #f4f7ff; border-color: var(--accent); border-left-color: var(--accent); }
.node.st-done { border-left-color: var(--ok); }
.node.st-active { border-left-color: var(--accent); }
.node.st-parked { border-left-color: var(--amber); }
.node.st-failed { border-left-color: var(--err); }
.node.st-missing { border-left-color: var(--err); }
.node-head { display: flex; align-items: center; gap: 8px; }
.node-title { flex: 1; }
.node-dot { width: 8px; height: 8px; border-radius: 50%; background: #98a2b3; flex: 0 0 auto; }
.st-done .node-dot { background: var(--ok); }
.st-active .node-dot { background: var(--accent); }
.st-parked .node-dot { background: var(--amber); }
.st-failed .node-dot { background: var(--err); }
.node-meta, .node-time, .node-scope { color: var(--muted); font-size: 12px; margin-top: 4px; word-break: break-word; }
.node-detail { margin-top: 6px; font-size: 13px; }
.team-list { margin-top: 12px; }

/* edges */
.edge-list { list-style: none; margin: 8px 0 0; padding: 0; display: flex; flex-direction: column; gap: 6px; }
.edge {
  display: flex; align-items: center; gap: 8px; padding: 5px 10px;
  border: 1px solid var(--line); border-radius: 6px; background: #fafbfc;
  transition: border-color .12s ease, background .12s ease;
}
.edge.hl { border-color: var(--accent); background: #f4f7ff; }
.edge-node { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 12px; }
.edge-arrow { color: var(--muted); }
.edge-label { color: var(--muted); font-size: 12px; margin-left: auto; }
.integration { margin-top: 12px; display: flex; align-items: center; gap: 10px; }

/* artifacts */
.artifact { border: 1px solid var(--line); border-radius: 8px; padding: 10px 12px; margin-top: 8px; transition: border-color .12s ease, background .12s ease; }
.artifact.hl { border-color: var(--accent); background: #f4f7ff; }
.artifact-head { display: flex; align-items: center; gap: 8px; }
.artifact-id { flex: 1; font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 13px; }
.artifact-meta, .artifact-type { color: var(--muted); font-size: 12px; margin-top: 4px; word-break: break-word; }
.artifact-status-note { color: var(--amber); font-size: 12px; margin: 6px 0 0; }
.artifact-summary { margin: 8px 0 0; white-space: pre-wrap; word-break: break-word; }
.artifact-body { margin-top: 8px; }
.artifact-body summary { cursor: pointer; color: var(--accent); font-size: 13px; font-weight: 600; }
.artifact-body pre {
  margin: 8px 0 0; padding: 10px; background: #0f172a; color: #e2e8f0;
  border-radius: 6px; overflow-x: auto; max-height: 480px; overflow-y: auto;
  font: 12px/1.5 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  white-space: pre-wrap; word-break: break-word;
}

/* chronology */
.timeline { list-style: none; margin: 8px 0 0; padding: 0; border-left: 2px solid var(--line); }
.tl-item { position: relative; padding: 0 0 14px 20px; }
.tl-item:last-child { padding-bottom: 0; }
.tl-dot { position: absolute; left: -6px; top: 4px; width: 10px; height: 10px; border-radius: 50%; background: var(--accent); }
.tl-head { display: flex; align-items: center; flex-wrap: wrap; gap: 6px; }
.tl-time { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 12px; }
.tl-label { margin-top: 2px; }
.tl-ref { color: var(--muted); font-size: 12px; margin-top: 2px; }

/* telemetry / health / warnings */
.telemetry-counts { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 10px; }
.telemetry-cols { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 8px 24px; margin-top: 12px; }
.kv-list { margin: 4px 0 0; padding-left: 18px; color: var(--ink); }
.telemetry-skills { margin-top: 12px; display: flex; flex-wrap: wrap; gap: 6px; align-items: center; }
.health-banner { display: inline-block; padding: 4px 12px; border-radius: 6px; font-weight: 700; margin: 0 0 8px; }
.health-ok { background: #e6f4ea; color: #1e5e3a; }
.health-bad { background: #fee4e2; color: #912018; }
.issue-list { margin: 6px 0 0; padding-left: 18px; }
.warnings summary { cursor: pointer; font-weight: 600; }

/* footer */
.report-footer {
  max-width: 980px; margin: 20px auto 0; padding: 0 18px;
  color: var(--muted); font-size: 12px; border-top: 1px solid var(--line); padding-top: 10px;
}

@media (max-width: 640px) {
  .meta-row { flex-direction: column; gap: 2px; }
  .meta-row dt { flex-basis: auto; }
}
`;

// ── Public API ──────────────────────────────────────────────────────────────

/**
 * Render a SessionReport into a single self-contained HTML string.
 * Safe to write to a file and open via file:// — no network requests.
 */
export function renderReportHtml(report: SessionReport): string {
  const body = [
    `<div class="container">`,
    renderHeader(report),
    renderGraphSection(report),
    renderArtifacts(report),
    renderChronology(report),
    report.kind === "cto" ? renderHealth(report) : "",
    renderTelemetry(report),
    renderWarnings(report),
    `</div>`,
    `<footer class="report-footer">${REDACTION_NOTICE}</footer>`,
  ].join("\n");

  return [
    "<!doctype html>",
    '<html lang="en">',
    "<head>",
    '  <meta charset="utf-8">',
    '  <meta name="viewport" content="width=device-width, initial-scale=1">',
    `  <title>${esc(report.meta.title)} — Session Report</title>`,
    `  <style>${CSS}</style>`,
    "</head>",
    "<body>",
    body,
    `<script id="omp-report-data" type="application/json">${jsonIsland(report)}</script>`,
    APP_SCRIPT,
    "</body>",
    "</html>",
  ].join("\n");
}
