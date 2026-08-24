/**
 * renderReportHtml — pure, self-contained HTML renderer for SessionReport.
 *
 * Produces a single file://-openable HTML string:
 *   - ALL CSS is inline in a <style> block.
 *   - ALL report data is embedded in an escaped JSON data island
 *     (<script id="omp-report-data" type="application/json">).
 *   - A deterministic interactive SVG diagram renders the workflow before the
 *     detail lists: stage/team nodes are columns ordered by `report.stages`
 *     (extra teams and unknown endpoints append deterministically), artifact
 *     nodes sit in the gaps around their producing/consuming stage columns,
 *     and directed edges carry `produces:`/`consumes:` artifact labels with
 *     arrowheads and kind colors. `produces` targets and `consumes` sources
 *     resolve to artifact nodes whenever the artifact id exists (same-ID
 *     stage/artifact pairs stay distinct).
 *   - A small amount of vanilla JS enhances navigation (node selection with
 *     edge + card highlighting, status filter synchronized with the diagram,
 *     zoom +/-/reset, keyboard activation). No external link, script src,
 *     fetch, or runtime/browser dependency is emitted.
 *   - Every stage card carries a collapsed native <details> disclosure
 *     ("Show stage details"): expanded in place it shows the global session
 *     task, the stage's optional profile metadata (description/checkpoint/
 *     gate/autonomous), agents/source, inputs/outputs with compact artifact
 *     summaries (status, type/keys, bounded summary, in-page anchor to the
 *     artifact card), and — for CTO team stages — the linked team record
 *     (scope/slice/profile/worktree/dependencies/escalations). Full artifact
 *     bodies stay opt-in behind `--full`; nothing is embedded here.
 *   - Stage cards may additionally carry a nested collapsed disclosure with
 *     the stage's reconstructed prompt preview (StageInfo.promptPreview): an
 *     explicitly labeled, bounded approximation — never the literal runtime
 *     prompt — rendered escaped in a line-preserving <pre>.
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

import { escapeHtml, OFFLINE_BASE_CSS, renderOfflineHtml } from "./html-shell.js";
import type { ArtifactStatus, EdgeKind, ReportArtifact, SessionReport, StageAgentInfo } from "./types.js";

const esc = escapeHtml;

function isHttpUrl(value: unknown): value is string {
  if (typeof value !== "string" || value.trim().length === 0) return false;
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }

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

/**
 * Worst-first rank for collapsing duplicate artifact ids into one diagram
 * node: `missing` outranks `skipped` outranks `produced` (unknown stays 0).
 */
const ARTIFACT_STATUS_RANK: Record<string, number> = {
  missing: 3,
  skipped: 2,
  produced: 1,
};

/** Return the more severe of two artifact statuses (first wins ties). */
function worseArtifactStatus(a: ArtifactStatus, b: ArtifactStatus): ArtifactStatus {
  return (ARTIFACT_STATUS_RANK[a] ?? 0) >= (ARTIFACT_STATUS_RANK[b] ?? 0) ? a : b;
}

/**
 * Display label for an artifact diagram node. When several report entries
 * share one artifact id, the label states how many owners declared it —
 * e.g. `dod (2 owners)` — instead of silently picking one entry.
 */
function artifactLabel(id: string, entries: ReportArtifact[]): string {
  if (entries.length <= 1) return id;
  const owners = new Set(entries.map((e) => e.owner).filter((o) => o.length > 0));
  const count = owners.size > 0 ? owners.size : entries.length;
  return `${id} (${count} ${count === 1 ? "owner" : "owners"})`;
}

const EDGE_LABELS: Record<string, string> = {
  produces: "produces",
  consumes: "consumes",
  depends_on: "depends on",
  integration: "integration",
  transition: "transition",
};

/**
 * Compact one-line stage agent summary, e.g. `planner (orchestrator, workflow)`.
 * The main/standby session is rendered honestly as "main session"; a stage
 * with no recorded agents renders "no agent recorded" — never synthesized.
 */
function agentSummary(agents: StageAgentInfo[] | undefined): string {
  if (!agents || agents.length === 0) return "no agent recorded";
  return agents
    .map((a) => {
      const name = a.name === "__main__" ? "main session" : a.name;
      return `${name}${a.role ? ` (${a.role}, ${a.source})` : ` (${a.source})`}`;
    })
    .join(", ");
}

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
    ? '<p class="graph-note">Stage statuses below are <strong>derived</strong> from team/integration state — CtoState has no explicit stage timeline. Use the interactive diagram or the lists: click a node (or press Enter/Space when focused) to highlight its edges and cards.</p>'
    : '<p class="graph-note">Use the interactive diagram or the lists: click a node (or press Enter/Space when focused) to highlight its edges and cards.</p>';

  const filterGroups = new Set<string>(["all"]);
  for (const s of report.stages) filterGroups.add(s.status);
  if (report.teams) for (const t of report.teams) filterGroups.add(t.status);
  const chips = [...filterGroups]
    .map(
      (g) =>
        `<button type="button" class="chip${g === "all" ? " on" : ""}" data-filter="${esc(g)}">${esc(g === "all" ? "all" : statusLabel(g))}</button>`,
    )
    .join("");

  const diagram = renderDiagram(report);
  const nodes = report.stages
    .map((s) => renderStageNode(s, isCto, report))
    .join("");
  const teams = report.teams ? `<h3>Teams</h3><div class="node-list team-list">${report.teams.map(renderTeamNode).join("")}</div>` : "";
  const edges = renderEdges(report.edges);
  const integration = report.integration ? renderIntegration(report.integration) : "";

  return `<section class="section" id="omp-graph"><h2>${header}</h2>${note}<div class="graph-filter" id="omp-graph-filter">${chips}</div>${diagram}<div class="node-list stage-list">${nodes}</div>${teams}${edges}${integration}</section>`;
}

function renderStageNode(s: SessionReport["stages"][number], derived: boolean, report: SessionReport): string {
  const meta: string[] = [];
  if (s.phase) meta.push(`phase: ${esc(s.phase)}`);
  if (s.type) meta.push(`type: ${esc(s.type)}`);
  if (s.team) meta.push(`team: ${esc(s.team)}`);
  const derivedChip = derived ? '<span class="derived-chip" title="derived from team/integration state">derived</span>' : "";
  const detail = s.detail ? `<div class="node-detail">${esc(s.detail)}</div>` : "";
  const agents = `<div class="node-agents">agents: ${esc(agentSummary(s.agents))}</div>`;
  const io: string[] = [];
  if (s.inputs?.length) io.push(`<div class="node-io">in: ${esc(s.inputs.join(", "))}</div>`);
  if (s.outputs?.length) io.push(`<div class="node-io">out: ${esc(s.outputs.join(", "))}</div>`);
  return `<article class="node ${statusClass(s.status)}" data-node-id="${esc(s.id)}" data-status="${esc(s.status)}" tabindex="0"><header class="node-head"><span class="node-dot"></span><h3 class="node-title">${esc(s.title ?? s.id)}</h3><span class="badge b-status ${statusClass(s.status)}">${esc(statusLabel(s.status))}</span>${derivedChip}</header><div class="node-meta">${meta.join(" · ")}</div>${agents}${io.join("")}<div class="node-time">at: ${renderTime(s.at, "(no timestamp)")}</div>${detail}${renderStageDetails(s, report)}</article>`;
}

// ── Stage details disclosure (collapsed by default) ─────────────────────────
//
// Every stage card carries a native <details class="stage-details"> disclosure.
// Collapsed (no `open` attribute) it contributes only the summary line to the
// main screen; expanded it reveals, in place:
//   - the global session task (report.meta.task — never a stage-specific task),
//   - the stage's optional profile metadata (description/checkpoint/gate/
//     autonomous/document — consumed from the shared optional StageInfo
//     contract; `document` renders its typed format/renderer/path contract
//     only, never the rendered document content),
//   - agents/source, declared inputs and outputs,
//   - compact artifact summaries for input/output ids (status, type/keys,
//     bounded summary, and an in-page anchor to the matching artifact card
//     when the id resolves to a recorded artifact),
//   - for CTO team stages, the linked report.teams record (scope, slice,
//     profile, worktree, dependencies, escalations) without duplicating the
//     full teams section,
//   - when the assembler attached one (StageInfo.promptPreview): a nested
//     collapsed disclosure labeled "Show reconstructed prompt preview (not
//     the original runtime prompt)" holding the escaped, line-preserving
//     preview in a <pre>. It is an explicitly labeled approximation built
//     only from persisted task/profile metadata and artifact ids — never the
//     literal runtime prompt — and is absent for custom/legacy stages and
//     derived CTO stages without a StageDef.
// All values are HTML-escaped; full artifact bodies stay behind `--full`
// (artifact-body disclosure) and are never embedded here.

function renderStageDetails(s: SessionReport["stages"][number], report: SessionReport): string {
  const rows: string[] = [];
  const pushRow = (label: string, valueHtml: string): void => {
    rows.push(`<div class="sd-row"><dt>${esc(label)}</dt><dd>${valueHtml}</dd></div>`);
  };

  pushRow(
    "Session task",
    report.meta.task ? esc(report.meta.task) : '<span class="unknown">(no task)</span>',
  );
  if (s.description) pushRow("Description", esc(s.description));
  if (s.checkpoint) pushRow("Checkpoint", esc(s.checkpoint));
  if (s.gate) pushRow("Gate", esc(s.gate));
  if (s.autonomous !== undefined && s.autonomous !== "") pushRow("Autonomous", esc(s.autonomous));
  if (s.document) {
    pushRow("Document", `${esc(s.document.format)} · ${esc(s.document.renderer)} · <code>${esc(s.document.path)}</code>`);
  }
  pushRow("Agents", esc(agentSummary(s.agents)));

  // CTO team stages: pull the linked report.teams record (bare id) so the
  // team's scope/slice/profile/worktree/dependencies/escalations are
  // actionable here without duplicating the full teams section below.
  if (s.team) {
    const team = report.teams?.find((t) => t.id === s.team);
    if (team) {
      if (team.scope?.length) pushRow("Team scope", team.scope.map((v) => esc(v)).join(", "));
      if (team.slice) pushRow("Team slice", esc(team.slice));
      if (team.profile) pushRow("Team profile", esc(team.profile));
      if (team.worktree) pushRow("Worktree", esc(team.worktree));
      if (team.depends_on?.length) pushRow("Team depends on", esc(team.depends_on.join(", ")));
      if (team.escalations !== undefined) pushRow("Escalations", esc(String(team.escalations)));
    } else {
      pushRow("Team", esc(s.team));
    }
  }

  if (s.inputs?.length) pushRow("Inputs", s.inputs.map((id) => artifactSummaryHtml(id, report)).join(" "));
  if (s.outputs?.length) pushRow("Outputs", s.outputs.map((id) => artifactSummaryHtml(id, report)).join(" "));

  // Optional reconstructed prompt preview (shared StageInfo contract): a
  // bounded approximation built from persisted task/profile metadata and
  // artifact ids — never the literal runtime prompt (that text is generated
  // per-turn and not persisted). Rendered only when the assembler attached
  // one; starts collapsed so it adds no height to the compact card, and the
  // escaped <pre> preserves the preview's line breaks.
  const preview = s.promptPreview
    ? `<details class="prompt-preview"><summary>Show reconstructed prompt preview (not the original runtime prompt)</summary><pre>${esc(s.promptPreview)}</pre></details>`
    : "";

  return `<details class="stage-details"><summary>Show stage details</summary><dl>${rows.join("")}</dl>${preview}</details>`;
}

/**
 * Compact, bounded artifact summary for one declared input/output id.
 *
 * Every value is escaped; the summary comes from the assembler-bounded
 * `ReportArtifact.summary` field (never a full body). An id with no artifact
 * record renders an explicit "no artifact record" state. When the id resolves
 * to exactly one recorded artifact, the row carries an in-page anchor
 * (`#omp-artifact-<index>`) to its existing card — index-based because
 * artifact ids may contain characters that are unsafe in HTML ids and may be
 * duplicated across owners.
 */
function artifactSummaryHtml(id: string, report: SessionReport): string {
  const entries = report.artifacts.filter((a) => a.id === id);
  if (entries.length === 0) {
    return `<span class="sd-artifact"><span class="badge b-status st-missing">missing</span><span class="sd-artifact-id">${esc(id)}</span><span class="muted">no artifact record</span></span>`;
  }
  return entries
    .map((a) => {
      const idx = report.artifacts.indexOf(a);
      const typeBits: string[] = [];
      if (a.type) typeBits.push(`type: ${esc(a.type)}`);
      if (a.keys?.length) typeBits.push(`keys: ${a.keys.map((k) => esc(k)).join(", ")}`);
      const summary = a.summary ? esc(a.summary) : '<span class="muted">(no summary)</span>';
      const anchor = idx >= 0 ? ` <a class="artifact-link" href="#omp-artifact-${idx}">card</a>` : "";
      return `<span class="sd-artifact"><span class="badge b-status ${statusClass(a.status)}">${esc(statusLabel(a.status))}</span><span class="sd-artifact-id">${esc(a.id)}</span>${typeBits.length ? `<span class="sd-artifact-type">${typeBits.join(" · ")}</span>` : ""}<span class="sd-artifact-summary">${summary}</span>${anchor}</span>`;
    })
    .join(" ");
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

// ── Interactive SVG diagram (deterministic left-to-right layout) ─────────────
//
// Deterministic left-to-right stage graph rendered server-side (no client-side
// graph layout):
//   - columns: all `report.stages` in `report.stages` order, then `report.teams`
//     whose id is not already a stage id and that has no derived `team:<id>`
//     stage (CTO reports emit both — one visual node per team), then any
//     phantom stage endpoints (appended, so the diagram always stays connected);
//   - artifact nodes live in the horizontal gap right of the column that
//     produces them (falling back to the column that consumes them, then the
//     last column), so every artifact stays attached to its stage edges;
//   - every stage column renders compact details: status, agent names with
//     role/source, and the stage's declared inputs/outputs.
// Edge endpoint typing: `produces` targets and `consumes` sources resolve to
// artifact nodes whenever the artifact id exists in `report.artifacts`; every
// other endpoint resolves to a stage/team node. Endpoints that exist nowhere
// become dashed "phantom" nodes. Same-ID stage/artifact pairs (e.g. stage
// "implementation" producing artifact "implementation") are distinct nodes
// distinguished by their typed key. Duplicate artifact ids (several teams
// declaring the same artifact, e.g. "dod") collapse into one node: raw id
// kept, worst status wins, label states the owner count.

interface DiagramNode {
  /** Typed key: `stage:<id>` | `team:<id>` | `artifact:<id>` — unique per node. */
  key: string;
  /** Raw id (stage/team/artifact id). */
  id: string;
  kind: "stage" | "team" | "artifact";
  status: string;
  /** Display label (stage title when present, else id). */
  label: string;
  /** True when the node exists only to anchor an edge endpoint. */
  phantom: boolean;
  /** Compact stage provenance (stages only; teams/artifacts have none). */
  agents?: StageAgentInfo[];
  inputs?: string[];
  outputs?: string[];
}

interface DiagramEdge {
  fromKey: string;
  toKey: string;
  fromId: string;
  toId: string;
  kind: EdgeKind;
  /** Source edge label (shown alongside the kind on non-artifact edges). */
  label?: string;
}

const DG_LAYOUT = {
  padX: 56, // left padding
  colW: 236, // stage/team column width
  colH: 128, // stage/team node height (status + agents + io lines)
  gapW: 240, // inter-column gap (holds artifact nodes + edge labels)
  artW: 140, // artifact node width
  artH: 40, // artifact node height
  artStep: 58, // vertical step between artifact nodes in one gap
  top: 24,
  bottom: 32,
} as const;

/** Arrow marker suffix per edge kind (marker fills match the stroke colors). */
const DG_EDGE_COLOR: Record<string, string> = {
  produces: "ok",
  consumes: "accent",
  depends_on: "amber",
  integration: "purple",
  transition: "gray",
};

const DG_MARKERS = [
  "<defs>",
  '<marker id="arr-ok" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6.5" markerHeight="6.5" orient="auto"><path d="M0,0 L10,5 L0,10 z" fill="#12b76a"/></marker>',
  '<marker id="arr-accent" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6.5" markerHeight="6.5" orient="auto"><path d="M0,0 L10,5 L0,10 z" fill="#2f6fed"/></marker>',
  '<marker id="arr-amber" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6.5" markerHeight="6.5" orient="auto"><path d="M0,0 L10,5 L0,10 z" fill="#b54708"/></marker>',
  '<marker id="arr-purple" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6.5" markerHeight="6.5" orient="auto"><path d="M0,0 L10,5 L0,10 z" fill="#7a5af8"/></marker>',
  '<marker id="arr-gray" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6.5" markerHeight="6.5" orient="auto"><path d="M0,0 L10,5 L0,10 z" fill="#98a2b3"/></marker>',
  "</defs>",
].join("");

function buildDiagramModel(report: SessionReport): {
  processNodes: DiagramNode[];
  artifactNodes: DiagramNode[];
  edges: DiagramEdge[];
} {
  const processNodes: DiagramNode[] = [];
  const processById = new Map<string, DiagramNode>();
  const artifactNodes: DiagramNode[] = [];
  const artifactById = new Map<string, DiagramNode>();

  for (const s of report.stages) {
    if (processById.has(s.id)) continue;
    const n: DiagramNode = { key: `stage:${s.id}`, id: s.id, kind: "stage", status: s.status, label: s.title ?? s.id, phantom: false, agents: s.agents, inputs: s.inputs, outputs: s.outputs };
    processNodes.push(n);
    processById.set(s.id, n);
  }
  if (report.teams) {
    for (const t of report.teams) {
      // CTO reports carry BOTH a derived stage entry with id `team:<id>` and
      // a `report.teams` entry with the bare id — emitting the bare team node
      // too would draw every team twice. The exact-id guard stays (a team
      // whose id collides with a plain stage id must not add a node either);
      // the derived-key guard skips the bare node when the `team:<id>` stage
      // already represents it. Reports without the derived stage (stage ids
      // like `team-backend`) still emit the standalone team node.
      if (processById.has(t.id) || processById.has(`team:${t.id}`)) continue;
      const n: DiagramNode = { key: `team:${t.id}`, id: t.id, kind: "team", status: t.status, label: t.id, phantom: false };
      processNodes.push(n);
      processById.set(t.id, n);
    }
  }
  // Collapse duplicate artifact ids into ONE deterministic node per id:
  // several teams can declare the same artifact (commonly "dod"), and one
  // node per entry produced stacked SVG nodes with identical typed keys.
  // The collapsed node keeps the raw id, the worst status wins (missing
  // stays visibly missing), and the label names the owner count.
  const entriesById = new Map<string, ReportArtifact[]>();
  for (const a of report.artifacts) {
    const list = entriesById.get(a.id);
    if (list) list.push(a);
    else entriesById.set(a.id, [a]);
  }
  for (const [id, entries] of entriesById) {
    // entriesById values always hold at least the entry that created the id.
    let status: ArtifactStatus = entries[0]!.status;
    for (const e of entries) status = worseArtifactStatus(status, e.status);
    const n: DiagramNode = {
      key: `artifact:${id}`,
      id,
      kind: "artifact",
      status,
      label: artifactLabel(id, entries),
      phantom: false,
    };
    artifactNodes.push(n);
    artifactById.set(id, n);
  }

  const resolveProcess = (id: string): DiagramNode => {
    const hit = processById.get(id);
    if (hit) return hit;
    const n: DiagramNode = { key: `stage:${id}`, id, kind: "stage", status: "unknown", label: id, phantom: true };
    processNodes.push(n);
    processById.set(id, n);
    return n;
  };
  const resolveArtifact = (id: string): DiagramNode => {
    const hit = artifactById.get(id);
    if (hit) return hit;
    const n: DiagramNode = { key: `artifact:${id}`, id, kind: "artifact", status: "missing", label: id, phantom: true };
    artifactNodes.push(n);
    artifactById.set(id, n);
    return n;
  };

  const edges: DiagramEdge[] = [];
  for (const e of report.edges) {
    let from: DiagramNode;
    let to: DiagramNode;
    if (e.kind === "produces") {
      from = resolveProcess(e.from);
      to = resolveArtifact(e.to);
    } else if (e.kind === "consumes") {
      from = resolveArtifact(e.from);
      to = resolveProcess(e.to);
    } else {
      from = resolveProcess(e.from);
      to = resolveProcess(e.to);
    }
    if (from.key === to.key) continue; // degenerate self-loop on one diagram node
    edges.push({ fromKey: from.key, toKey: to.key, fromId: e.from, toId: e.to, kind: e.kind, label: e.label });
  }

  return { processNodes, artifactNodes, edges };
}

function renderDiagram(report: SessionReport): string {
  const model = buildDiagramModel(report);
  if (model.processNodes.length === 0 && model.artifactNodes.length === 0) return "";

  const colCount = model.processNodes.length;
  const colX = (i: number): number => DG_LAYOUT.padX + i * (DG_LAYOUT.colW + DG_LAYOUT.gapW);
  const gapCenterX = (i: number): number =>
    colCount === 0
      ? DG_LAYOUT.padX
      : colX(Math.min(Math.max(i, 0), colCount - 1)) + DG_LAYOUT.colW + DG_LAYOUT.gapW / 2;

  const pos = new Map<string, { x: number; y: number; cy: number }>();
  const stageCy = DG_LAYOUT.top + DG_LAYOUT.colH / 2;
  model.processNodes.forEach((n, i) => {
    pos.set(n.key, { x: colX(i), y: DG_LAYOUT.top, cy: stageCy });
  });

  // Artifact gap = the column that produces the artifact (first produces edge),
  // falling back to the column that consumes it, then the last column.
  const colIndex = new Map(model.processNodes.map((n, i) => [n.key, i] as const));
  const gapByArtifact = new Map<string, number>();
  for (const e of model.edges) {
    if (e.kind === "produces") {
      const fromCol = colIndex.get(e.fromKey);
      if (fromCol !== undefined && !gapByArtifact.has(e.toKey)) gapByArtifact.set(e.toKey, fromCol);
    }
  }
  for (const e of model.edges) {
    if (e.kind === "consumes") {
      const toCol = colIndex.get(e.toKey);
      if (toCol !== undefined && !gapByArtifact.has(e.fromKey)) gapByArtifact.set(e.fromKey, toCol);
    }
  }
  const slotByGap = new Map<number, number>();
  let maxSlots = 1;
  model.artifactNodes.forEach((n) => {
    const gap = gapByArtifact.get(n.key) ?? Math.max(colCount - 1, 0);
    const slot = slotByGap.get(gap) ?? 0;
    slotByGap.set(gap, slot + 1);
    maxSlots = Math.max(maxSlots, slot + 1);
    const x = colCount === 0 ? DG_LAYOUT.padX : gapCenterX(gap) - DG_LAYOUT.artW / 2;
    const y = DG_LAYOUT.top + 4 + slot * DG_LAYOUT.artStep;
    pos.set(n.key, { x, y, cy: y + DG_LAYOUT.artH / 2 });
  });

  const width =
    colCount === 0
      ? DG_LAYOUT.padX + DG_LAYOUT.artW + DG_LAYOUT.padX
      : DG_LAYOUT.padX + colCount * (DG_LAYOUT.colW + DG_LAYOUT.gapW) + DG_LAYOUT.padX;
  const height = Math.max(
    DG_LAYOUT.top + DG_LAYOUT.colH + DG_LAYOUT.bottom,
    DG_LAYOUT.top + 4 + (maxSlots - 1) * DG_LAYOUT.artStep + DG_LAYOUT.artH + DG_LAYOUT.bottom,
  );

  const edgeHtml = model.edges
    .map((e, i) => {
      const p1 = pos.get(e.fromKey);
      const p2 = pos.get(e.toKey);
      if (!p1 || !p2) return "";
      const fromArtifact = e.fromKey.startsWith("artifact:");
      const toArtifact = e.toKey.startsWith("artifact:");
      const x1 = p1.x + (fromArtifact ? DG_LAYOUT.artW : DG_LAYOUT.colW);
      const y1 = p1.cy;
      const x2 = p2.x;
      const y2 = p2.cy;
      const backward = x2 <= x1 + 2;
      const d = backward
        ? `M ${x1} ${y1} C ${x1 + 64} ${y1 + 90} ${x2 - 64} ${y2 + 90} ${x2} ${y2}`
        : `M ${x1} ${y1} C ${x1 + 48} ${y1} ${x2 - 48} ${y2} ${x2} ${y2}`;
      const labelX = Math.round((x1 + x2) / 2);
      const labelY = backward ? Math.max(y1, y2) + 48 : Math.round((y1 + y2) / 2) - 4;
      const color = DG_EDGE_COLOR[e.kind] ?? "gray";
      const kindLabel = EDGE_LABELS[e.kind] ?? e.kind;
      // Artifact-carrying edges label the artifact id ("produces: plan",
      // "consumes: team_plan"); other edges keep the kind (and any label).
      const carried = e.kind === "produces" ? e.toId : e.kind === "consumes" ? e.fromId : undefined;
      const labelText = carried !== undefined ? `${kindLabel}: ${carried}` : e.label ? `${kindLabel}: ${e.label}` : kindLabel;
      return `<g class="dg-edge kind-${esc(e.kind)}" data-edge data-edge-key="e${i}" data-from="${esc(e.fromId)}" data-to="${esc(e.toId)}" data-from-key="${esc(e.fromKey)}" data-to-key="${esc(e.toKey)}"><path class="dg-edge-path" d="${esc(d)}" marker-end="url(#arr-${color})"/><text class="dg-edge-label" x="${labelX}" y="${labelY}">${esc(labelText)}</text></g>`;
    })
    .join("");

  const nodeHtml = model.processNodes
    .concat(model.artifactNodes)
    .map((n) => {
      const p = pos.get(n.key);
      if (!p) return "";
      const isArtifact = n.kind === "artifact";
      const w = isArtifact ? DG_LAYOUT.artW : DG_LAYOUT.colW;
      const h = isArtifact ? DG_LAYOUT.artH : DG_LAYOUT.colH;
      const rx = isArtifact ? 6 : 8;
      const phantom = n.phantom ? " dg-phantom" : "";
      const lines: string[] = [];
      if (n.kind === "stage") {
        lines.push(`<text class="dg-node-line" x="${p.x + 12}" y="${p.y + 52}">${esc(`agents: ${agentSummary(n.agents)}`)}</text>`);
        if (n.inputs && n.inputs.length) lines.push(`<text class="dg-node-line" x="${p.x + 12}" y="${p.y + 68}">${esc(`in: ${n.inputs.join(", ")}`)}</text>`);
        if (n.outputs && n.outputs.length) lines.push(`<text class="dg-node-line" x="${p.x + 12}" y="${p.y + 84}">${esc(`out: ${n.outputs.join(", ")}`)}</text>`);
      }
      return `<g class="dg-node ${statusClass(n.status)}${phantom}" data-node-key="${esc(n.key)}" data-node-id="${esc(n.id)}" data-status="${esc(n.status)}" data-diagram-type="${esc(n.kind)}" role="button" tabindex="0" aria-label="${esc(`${n.kind} ${n.id}, ${statusLabel(n.status)}`)}"><title>${esc(n.label)}</title><rect class="dg-node-box" x="${p.x}" y="${p.y}" width="${w}" height="${h}" rx="${rx}"/><text class="dg-node-title" x="${p.x + 12}" y="${p.y + (isArtifact ? 17 : 18)}">${esc(n.label)}</text><text class="dg-node-status" x="${p.x + 12}" y="${p.y + (isArtifact ? 32 : 34)}">${esc(statusLabel(n.status))}</text>${lines.join("")}<rect class="dg-node-focus" x="${p.x}" y="${p.y}" width="${w}" height="${h}" rx="${rx}" fill="none"/></g>`;
    })
    .join("");

  const processCount = model.processNodes.length;
  const artifactCount = model.artifactNodes.length;
  const edgeCount = model.edges.length;
  const ariaLabel = `Workflow diagram: ${processCount} stage or team node${processCount === 1 ? "" : "s"}, ${artifactCount} artifact node${artifactCount === 1 ? "" : "s"}, ${edgeCount} connection${edgeCount === 1 ? "" : "s"}`;

  return (
    `<div class="diagram-wrap" id="omp-diagram">` +
    `<div class="diagram-toolbar">` +
    `<strong class="diagram-title">Interactive diagram</strong>` +
    `<span class="diagram-hint">Scroll horizontally to follow the full workflow. Click a node, or press Enter/Space when focused, to highlight its edges and cards.</span>` +
    `<span class="diagram-zoom">` +
    `<button type="button" id="omp-zoom-out" aria-label="Zoom out">-</button>` +
    `<span id="omp-zoom-label" class="diagram-zoom-label" aria-live="polite">100%</span>` +
    `<button type="button" id="omp-zoom-in" aria-label="Zoom in">+</button>` +
    `<button type="button" id="omp-zoom-reset" aria-label="Reset zoom">Reset</button>` +
    `</span>` +
    `</div>` +
    `<div class="diagram-scroll" id="omp-diagram-scroll">` +
    `<svg id="omp-diagram-svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="${esc(ariaLabel)}">` +
    DG_MARKERS +
    (edgeHtml ? `<g class="dg-edges">${edgeHtml}</g>` : "") +
    `<g class="dg-nodes">${nodeHtml}</g>` +
    `</svg>` +
    `</div>` +
    `</div>`
  );
}

function renderIntegration(i: NonNullable<SessionReport["integration"]>): string {
  return `<div class="integration"><span class="badge b-status ${statusClass(i.status)}">integration: ${esc(statusLabel(i.status))}</span>${i.note ? `<span class="integration-note">${esc(i.note)}</span>` : ""}</div>`;
}

function renderArtifacts(report: SessionReport): string {
  if (report.artifacts.length === 0) {
    return `<section class="section"><h2>Artifacts</h2><p class="empty">No artifacts declared for this session.</p></section>`;
  }
  const cards = report.artifacts.map((a, i) => renderArtifactCard(a, i)).join("");
  return `<section class="section" id="omp-artifacts"><h2>Artifacts <span class="count">${report.artifacts.length}</span></h2>${cards}</section>`;
}

function renderArtifactCard(a: SessionReport["artifacts"][number], index: number): string {
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
  return `<article class="artifact" id="omp-artifact-${index}" data-owner="${esc(a.owner)}" tabindex="0"><header class="artifact-head"><h3 class="artifact-id">${esc(a.id)}</h3><span class="badge b-status ${statusClass(a.status)}">${esc(statusLabel(a.status))}</span></header><div class="artifact-meta">${meta.join(" · ")}</div>${typeLine}${statusNote}${summary}${body}</article>`;
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

  // [data-node-id] covers node cards (stage/team) AND svg diagram nodes.
  var nodes = document.querySelectorAll("[data-node-id]");
  var svgNodes = document.querySelectorAll("[data-node-key]");
  // [data-edge][data-from] covers detail-list edges AND svg diagram edges.
  var edges = document.querySelectorAll("[data-edge][data-from]");
  var svgEdges = document.querySelectorAll("[data-edge-key]");
  var artifacts = document.querySelectorAll("[data-owner]");

  // Cross-highlight alias: a CTO derived team stage carries the raw id
  // "team:<id>" while its report.teams detail card (and any bare "<id>"
  // diagram node) uses the bare id — clicking either must select/highlight
  // both. Exact ids always match; "team:<id>" and "<id>" match each other
  // for selection/highlight only. Typed data-node-key values are never
  // compared through this helper, so same-id stage/artifact nodes stay
  // distinct.
  function sameNodeId(a, b) {
    return a === b || a === "team:" + b || b === "team:" + a;
  }

  function applyActive(id, keys, active) {
    nodes.forEach(function (n) {
      if (sameNodeId(n.getAttribute("data-node-id"), id)) n.classList.toggle("sel", active);
    });
    artifacts.forEach(function (a) {
      if (sameNodeId(a.getAttribute("data-owner"), id)) a.classList.toggle("hl", active);
    });
    edges.forEach(function (e) {
      var f = e.getAttribute("data-from");
      var t = e.getAttribute("data-to");
      if (sameNodeId(f, id) || sameNodeId(t, id)) e.classList.toggle("hl", active);
    });
    if (keys && keys.length) {
      svgEdges.forEach(function (e) {
        var fk = e.getAttribute("data-from-key");
        var tk = e.getAttribute("data-to-key");
        for (var i = 0; i < keys.length; i++) {
          if (fk === keys[i] || tk === keys[i]) { e.classList.toggle("hl", active); break; }
        }
      });
    }
  }

  function keysForId(id) {
    var keys = [];
    svgNodes.forEach(function (n) {
      if (sameNodeId(n.getAttribute("data-node-id"), id)) keys.push(n.getAttribute("data-node-key"));
    });
    return keys;
  }

  function activateNode(el) {
    var id = el.getAttribute("data-node-id");
    if (!id) return;
    applyActive(id, keysForId(id), !el.classList.contains("sel"));
  }

  function activateArtifact(el) {
    var id = el.getAttribute("data-owner");
    if (!id) return;
    applyActive(id, keysForId(id), !el.classList.contains("hl"));
  }

  function bindNode(el) {
    el.addEventListener("click", function () { activateNode(el); });
    el.addEventListener("keydown", function (ev) {
      if (ev.key === "Enter" || ev.key === " ") { ev.preventDefault(); activateNode(el); }
    });
  }
  nodes.forEach(bindNode);

  // Stage-detail disclosures live INSIDE the clickable stage cards. Toggling
  // a <details> (click, or Enter/Space on its summary) must never also toggle
  // the card's selection highlight — stop propagation at the disclosure so
  // the native summary toggle still runs but the card handlers never see it.
  var stageDetails = document.querySelectorAll(".stage-details");
  stageDetails.forEach(function (d) {
    d.addEventListener("click", function (ev) { ev.stopPropagation(); });
    d.addEventListener("keydown", function (ev) { ev.stopPropagation(); });
  });

  artifacts.forEach(function (a) {
    a.addEventListener("click", function () { activateArtifact(a); });
    a.addEventListener("keydown", function (ev) {
      if (ev.key === "Enter" || ev.key === " ") { ev.preventDefault(); activateArtifact(a); }
    });
  });

  var filter = document.getElementById("omp-graph-filter");
  if (filter) {
    var chips = filter.querySelectorAll("[data-filter]");
    chips.forEach(function (chip) {
      chip.addEventListener("click", function () {
        var wanted = chip.getAttribute("data-filter");
        chips.forEach(function (c) { c.classList.toggle("on", c === chip); });
        // Node cards AND svg diagram nodes share [data-node-id]/[data-status].
        nodes.forEach(function (n) {
          var st = n.getAttribute("data-status") || "";
          n.style.display = (wanted === "all" || st === wanted) ? "" : "none";
        });
        // Diagram edges hide when either typed endpoint node is hidden.
        svgEdges.forEach(function (e) {
          var fk = e.getAttribute("data-from-key");
          var tk = e.getAttribute("data-to-key");
          var hidden = false;
          svgNodes.forEach(function (n) {
            if (hidden) return;
            var k = n.getAttribute("data-node-key");
            if (k === fk || k === tk) hidden = n.style.display === "none";
          });
          e.style.display = hidden ? "none" : "";
        });
      });
    });
  }

  var dgSvg = document.getElementById("omp-diagram-svg");
  if (dgSvg) {
    var zoomLabel = document.getElementById("omp-zoom-label");
    var zoomScale = 1;
    function applyZoom() {
      dgSvg.style.transform = "scale(" + zoomScale + ")";
      if (zoomLabel) zoomLabel.textContent = Math.round(zoomScale * 100) + "%";
    }
    var zoomIn = document.getElementById("omp-zoom-in");
    var zoomOut = document.getElementById("omp-zoom-out");
    var zoomReset = document.getElementById("omp-zoom-reset");
    if (zoomIn) zoomIn.addEventListener("click", function () { zoomScale = Math.min(3, zoomScale * 1.25); applyZoom(); });
    if (zoomOut) zoomOut.addEventListener("click", function () { zoomScale = Math.max(0.5, zoomScale / 1.25); applyZoom(); });
    if (zoomReset) zoomReset.addEventListener("click", function () { zoomScale = 1; applyZoom(); });
  }
})();
</script>`;

// ── Stylesheet (inline, no external assets) ─────────────────────────────────

const CSS = `
${OFFLINE_BASE_CSS}
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
.node-meta, .node-time, .node-scope, .node-agents, .node-io { color: var(--muted); font-size: 12px; margin-top: 4px; word-break: break-word; }
.node-detail { margin-top: 6px; font-size: 13px; }
.team-list { margin-top: 12px; }

/* stage details disclosure (collapsed by default: only the summary line) */
.stage-details { margin-top: 6px; }
.stage-details > summary { cursor: pointer; color: var(--accent); font-size: 12px; font-weight: 600; }
.stage-details > summary::marker { color: var(--muted); }
.stage-details > summary:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; border-radius: 4px; }
.stage-details dl {
  margin: 8px 0 0; padding: 8px 0 0; border-top: 1px solid var(--line);
  display: grid; grid-template-columns: 1fr; gap: 2px;
}
.stage-details .sd-row { display: flex; gap: 8px; padding: 3px 0; border-top: 1px solid var(--line); font-size: 12px; }
.stage-details .sd-row dt { flex: 0 0 110px; color: var(--muted); font-weight: 600; }
.stage-details .sd-row dd { margin: 0; word-break: break-word; min-width: 0; }
.sd-artifact { display: inline-flex; flex-wrap: wrap; gap: 2px 6px; align-items: baseline; margin-right: 8px; }
.sd-artifact-id { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 11px; }
.sd-artifact-type { color: var(--muted); font-size: 11px; }
.sd-artifact-summary { font-size: 12px; }
.artifact-link { color: var(--accent); font-size: 11px; text-decoration: none; }
.artifact-link:hover { text-decoration: underline; }

/* nested reconstructed prompt preview (collapsed by default: summary line only) */
.prompt-preview { margin-top: 6px; }
.prompt-preview > summary { cursor: pointer; color: var(--accent); font-size: 12px; font-weight: 600; }
.prompt-preview > summary::marker { color: var(--muted); }
.prompt-preview > summary:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; border-radius: 4px; }
.prompt-preview pre {
  margin: 8px 0 0; padding: 10px; background: #fafbfc; color: var(--ink);
  border: 1px solid var(--line); border-radius: 6px;
  font: 12px/1.5 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  white-space: pre-wrap; word-break: break-word; overflow-wrap: anywhere;
  max-height: 320px; overflow-y: auto;
}

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

/* interactive diagram */
.diagram-wrap { margin-top: 6px; }
.diagram-toolbar { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; margin-bottom: 6px; }
.diagram-title { font-size: 13px; }
.diagram-hint { color: var(--muted); font-size: 12px; flex: 1; min-width: 200px; }
.diagram-zoom { display: inline-flex; align-items: center; gap: 4px; }
.diagram-zoom button {
  border: 1px solid var(--line); background: var(--card); color: var(--ink);
  border-radius: 6px; min-width: 28px; height: 26px; padding: 0 8px; font-size: 13px;
  cursor: pointer; line-height: 1;
}
.diagram-zoom button:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
.diagram-zoom-label { min-width: 46px; text-align: center; font-size: 12px; color: var(--muted); font-variant-numeric: tabular-nums; }
.diagram-scroll { overflow: auto; border: 1px solid var(--line); border-radius: 8px; background: #fbfcfe; }
#omp-diagram-svg { display: block; width: auto; min-width: 0; height: auto; transform-origin: 0 0; transition: transform .18s ease; }

.dg-node { cursor: pointer; }
.dg-node-box { fill: var(--card); stroke: var(--line); stroke-width: 1.5; }
.dg-node.st-done .dg-node-box { stroke: var(--ok); }
.dg-node.st-active .dg-node-box { stroke: var(--accent); }
.dg-node.st-pending .dg-node-box { stroke: #98a2b3; }
.dg-node.st-skipped .dg-node-box { stroke: #d0d5dd; }
.dg-node.st-parked .dg-node-box { stroke: var(--amber); }
.dg-node.st-missing .dg-node-box { stroke: var(--err); }
.dg-node.st-failed .dg-node-box { stroke: var(--err); }
.dg-node.st-unknown .dg-node-box { stroke: #98a2b3; }
.dg-node.dg-phantom .dg-node-box { stroke-dasharray: 6 4; }
.dg-node.sel .dg-node-box { stroke: var(--accent); stroke-width: 2.5; fill: #f4f7ff; }
.dg-node:focus-visible { outline: none; }
.dg-node:focus-visible .dg-node-focus { stroke: var(--accent); }
.dg-node-title { fill: var(--ink); font-size: 13px; font-weight: 600; }
.dg-node-status { fill: var(--muted); font-size: 11px; }
.dg-node-line { fill: #475467; font-size: 10px; }

.dg-edge-path { fill: none; stroke-width: 1.6; opacity: .95; }
.dg-edge.kind-produces .dg-edge-path { stroke: var(--ok); }
.dg-edge.kind-consumes .dg-edge-path { stroke: var(--accent); }
.dg-edge.kind-depends_on .dg-edge-path { stroke: var(--amber); }
.dg-edge.kind-integration .dg-edge-path { stroke: #7a5af8; }
.dg-edge.kind-transition .dg-edge-path { stroke: #98a2b3; }
.dg-edge.hl .dg-edge-path { stroke-width: 2.6; opacity: 1; }
.dg-edge-label { fill: var(--muted); font-size: 10px; paint-order: stroke; stroke: #ffffff; stroke-width: 3px; stroke-linejoin: round; }

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

@media (prefers-reduced-motion: reduce) {
  #omp-diagram-svg { transition: none; }
  .node, .edge, .artifact { transition: none !important; }
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

  return renderOfflineHtml({
    title: `${report.meta.title} — Session Report`,
    lang: "en",
    css: CSS,
    body,
    dataIsland: { id: "omp-report-data", value: report },
    script: APP_SCRIPT,
  });
}
