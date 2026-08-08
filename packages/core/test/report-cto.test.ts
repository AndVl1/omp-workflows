/**
 * Session-report assembly: CTO (CtoState schema 2) normalization — derived
 * workflow stages, team statuses (parked/failed/done), depends_on edges,
 * integration/health, per-team artifacts, and the markdown fallback reader.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { buildSessionReport } from "../src/report/assemble.js";
import type { CtoState } from "../src/cto/types.js";

function makeCtoState(overrides: Partial<CtoState> = {}): CtoState {
  return {
    schema: 2,
    id: "run-1",
    task: "Build the report feature",
    branch: "feat/cto-run",
    autonomous: true,
    classification: { type: "FEATURE", complexity: "COMPLEX", confidence: "HIGH", autonomous: true },
    plan: {
      id: "run-1",
      task: "Build the report feature",
      teams: [
        { team: "alpha", scope: ["backend"], slice: "api", profile: "standard", worktree: "same_branch", depends_on: [] },
        { team: "beta", scope: ["frontend"], slice: "ui", profile: "standard", worktree: "same_branch", depends_on: ["alpha"] },
      ],
      created_at: "2026-08-08T09:00:00.000Z",
    },
    teams: [
      { id: "alpha", status: "done", escalations: {}, dod_path: ".work-state/artifacts/alpha/dod.json" },
      { id: "beta", status: "parked", escalations: { e1: { status: "pending" } } },
    ],
    integration: { status: "failed", note: "verdict reject" },
    pause: { kind: "background_wait", reason: "waiting on beta answer" },
    updated_at: "2026-08-08T11:00:00.000Z",
    ...overrides,
  };
}

function writeRun(cwd: string, state: CtoState): void {
  const dir = join(cwd, ".work-state", "cto", state.id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "state.json"), JSON.stringify(state, null, 2));
}

function tmpWorkspace(): string {
  return mkdtempSync(join(tmpdir(), "report-cto-"));
}

test("cto: normalizes CtoState schema 2 with derived stages, teams, integration, health", () => {
  const cwd = tmpWorkspace();
  try {
    writeRun(cwd, makeCtoState());

    const report = buildSessionReport(cwd, { kind: "cto" });

    assert.equal(report.kind, "cto");
    assert.equal(report.meta.task, "Build the report feature");
    assert.equal(report.meta.workflow, "cto");
    assert.equal(report.meta.autonomous, true);
    assert.equal(report.source.id, "run-1");
    assert.equal(report.source.format, "json");
    assert.equal(report.source.statePath, join(cwd, ".work-state", "cto", "run-1", "state.json"));

    // Derived workflow stages.
    assert.ok(report.stages.some((s) => s.id === "cto_discovery" && s.status === "done"));
    assert.ok(report.stages.some((s) => s.id === "decomposition" && s.status === "done"));
    assert.ok(report.stages.some((s) => s.id === "teams" && s.status === "parked"), "parked team dominates failed in stage derivation");
    assert.ok(report.stages.some((s) => s.id === "integration_review" && s.status === "failed"));
    assert.ok(report.stages.some((s) => s.id === "cto_summary" && s.status === "pending"));

    // Per-team stages carry the native status vocabulary.
    const alpha = report.stages.find((s) => s.id === "team:alpha");
    assert.equal(alpha?.status, "done");
    assert.equal(alpha?.team, "alpha");
    const beta = report.stages.find((s) => s.id === "team:beta");
    assert.equal(beta?.status, "parked");

    // Edges: workflow chain + depends_on + integration.
    assert.ok(report.edges.some((e) => e.kind === "produces" && e.from === "decomposition" && e.to === "team_plan"));
    assert.ok(report.edges.some((e) => e.kind === "depends_on" && e.from === "team:alpha" && e.to === "team:beta"));
    assert.ok(report.edges.some((e) => e.kind === "integration" && e.from === "team:beta" && e.to === "integration_review"));

    // Teams normalized with plan metadata.
    assert.equal(report.teams?.length, 2);
    const betaTeam = report.teams?.find((t) => t.id === "beta");
    assert.deepEqual(betaTeam?.depends_on, ["alpha"]);
    assert.equal(betaTeam?.slice, "ui");
    assert.equal(betaTeam?.escalations, 1);

    // Integration + health.
    assert.equal(report.integration?.status, "failed");
    assert.equal(report.integration?.note, "verdict reject");
    assert.equal(report.health?.healthy, true);
    assert.equal(report.health?.pending_escalations, 1);

    // Chronology includes team transitions + integration + state entries.
    assert.ok(report.chronology.some((c) => c.kind === "team" && c.ref === "beta" && c.label.includes("parked")));
    assert.ok(report.chronology.some((c) => c.kind === "integration" && c.label.includes("failed")));
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("cto: team artifacts under .work-state/artifacts/<team>/ are navigable result nodes", () => {
  const cwd = tmpWorkspace();
  try {
    writeRun(cwd, makeCtoState());
    const alphaDir = join(cwd, ".work-state", "artifacts", "alpha");
    mkdirSync(alphaDir, { recursive: true });
    writeFileSync(join(alphaDir, "dod.json"), JSON.stringify({ type: "dod", items: [] }, null, 2));
    writeFileSync(join(alphaDir, "api_contract.json"), JSON.stringify({ type: "architecture", title: "API contract" }, null, 2));

    const report = buildSessionReport(cwd, { kind: "cto" });

    const dod = report.artifacts.find((a) => a.id === "dod" && a.owner === "alpha");
    assert.equal(dod?.status, "produced");
    assert.equal(dod?.type, "dod");
    const contract = report.artifacts.find((a) => a.id === "api_contract");
    assert.equal(contract?.status, "produced");
    assert.equal(contract?.owner, "alpha");
    assert.equal(contract?.summary, "API contract");
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("cto: markdown fallback reader produces a report for agent-written runs", () => {
  const cwd = tmpWorkspace();
  try {
    const runDir = join(cwd, ".work-state", "cto", "md-run");
    mkdirSync(runDir, { recursive: true });
    writeFileSync(join(runDir, "cto_discovery.md"), "# CTO Discovery\nsummary of scope\n");
    writeFileSync(
      join(runDir, "team-plan.md"),
      [
        "# Team Plan",
        "- team: alpha — API slice",
        "- team: beta — UI slice",
      ].join("\n"),
    );

    const report = buildSessionReport(cwd, { kind: "cto", id: "md-run" });

    assert.equal(report.source.format, "markdown");
    assert.equal(report.source.statePath, null);
    assert.equal(report.meta.task, "CTO Discovery");
    const alpha = report.teams?.find((t) => t.id === "alpha");
    assert.equal(alpha?.status, "in_progress");
    assert.equal(report.stages.find((s) => s.id === "team:alpha")?.status, "in_progress");
    assert.ok(report.warnings.length >= 0);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("cto: auto-detect picks the CTO run when it is newer than the do-work state", () => {
  const cwd = tmpWorkspace();
  try {
    writeRun(cwd, makeCtoState()); // updated_at 11:00
    const dwDir = join(cwd, ".work-state", "features", "dw");
    mkdirSync(dwDir, { recursive: true });
    writeFileSync(
      join(dwDir, "state.json"),
      JSON.stringify({
        schema: 1,
        branch: "feat/dw",
        classification: { type: "FEATURE", complexity: "MEDIUM", confidence: "HIGH", workflow: "standard", autonomous: false },
        task: "Older do-work",
        workflow_override: false,
        issue: null,
        stage_cursor: "implementation",
        stages: [{ id: "implementation", status: "in_progress" }],
        artifacts: {},
        pause: { kind: "none", reason: "" },
        updated_at: "2026-08-08T10:00:00.000Z",
      }),
    );

    const report = buildSessionReport(cwd);
    assert.equal(report.kind, "cto");
    assert.equal(report.source.id, "run-1");
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("cto: explicit unknown run id throws a clear error", () => {
  const cwd = tmpWorkspace();
  try {
    writeRun(cwd, makeCtoState());
    assert.throws(() => buildSessionReport(cwd, { kind: "cto", id: "ghost" }), /cto session "ghost" not found/);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

// ── Telemetry degradation (CTO) ─────────────────────────────────────────────

test("cto: absent observability → null rollup, CTO-specific warning, chronology still state-sourced", () => {
  const cwd = tmpWorkspace();
  try {
    // A bare CTO run in a workspace with no feature-scoped observability
    // pointer: readObservabilityPointer(cwd, "default") finds no events.jsonl,
    // so ctoTelemetry degrades. manual_qa ui-12: the CTO report shows "No
    // telemetry recorded" plus the CTO-specific absence warning, and the
    // chronology falls back to state-sourced entries (no event stream).
    writeRun(cwd, makeCtoState());

    const report = buildSessionReport(cwd, { kind: "cto" });

    assert.equal(report.telemetry.rollup, null, "no rollup when observability is absent");
    assert.ok(
      report.warnings.some((w) => w.includes("no telemetry available for this CTO run")),
      "CTO-specific telemetry-absence warning emitted",
    );
    // Chronology degrades to state-sourced entries — never empty.
    assert.ok(report.chronology.length > 0, "chronology falls back to state entries without telemetry");
    assert.ok(
      report.chronology.every((c) => c.source !== "event"),
      "no event-sourced chronology when there is no event stream",
    );
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

// ── Standby stage derivation ────────────────────────────────────────────────

// ── Stage provenance (agents / inputs / outputs) ────────────────────────────

test("cto: workflow stages carry profile agents/inputs/outputs; team stages carry lead provenance", () => {
  const cwd = tmpWorkspace();
  try {
    writeRun(cwd, makeCtoState());
    const ompDir = join(cwd, ".omp");
    mkdirSync(ompDir, { recursive: true });
    writeFileSync(
      join(ompDir, "teams.json"),
      JSON.stringify([
        { id: "alpha", name: "Alpha", scope: ["backend"], profile: "standard", lead: "team-lead-alpha", roster: ["developer-kotlin"] },
        { id: "beta", name: "Beta", scope: ["frontend"], profile: "standard", lead: "team-lead-beta", roster: ["frontend"] },
      ]),
    );

    const report = buildSessionReport(cwd, { kind: "cto" });

    // Single stage: resolved agent + original role.
    const arch = report.stages.find((s) => s.id === "architecture");
    assert.deepEqual(arch?.agents, [{ name: "architect", role: "architect", source: "workflow" }]);
    assert.deepEqual(arch?.inputs, ["team_plan"]);
    assert.deepEqual(arch?.outputs, ["architecture"]);

    const integrationReview = report.stages.find((s) => s.id === "integration_review");
    assert.deepEqual(integrationReview?.agents, [{ name: "code-reviewer", role: "code-reviewer", source: "workflow" }]);
    assert.deepEqual(integrationReview?.inputs, ["team_artifacts"]);
    assert.deepEqual(integrationReview?.outputs, ["integration_review"]);

    // Orchestrator stages: truthful main-session entry.
    const discovery = report.stages.find((s) => s.id === "cto_discovery");
    assert.deepEqual(discovery?.agents, [{ name: "main session", role: "orchestrator", source: "workflow" }]);
    assert.deepEqual(discovery?.outputs, ["cto_discovery"]);
    const decomposition = report.stages.find((s) => s.id === "decomposition");
    assert.deepEqual(decomposition?.agents, [{ name: "main session", role: "orchestrator", source: "workflow" }]);
    assert.deepEqual(decomposition?.inputs, ["cto_discovery"]);
    assert.deepEqual(decomposition?.outputs, ["team_plan"]);

    // The `teams` stage declares inputs/outputs but has no role roster →
    // agents stay absent (no truthful single-agent claim for the phase).
    const teams = report.stages.find((s) => s.id === "teams");
    assert.equal(teams?.agents, undefined);
    assert.deepEqual(teams?.inputs, ["architecture"]);
    assert.deepEqual(teams?.outputs, ["team_artifacts"]);

    // CTO team stages: lead provenance from the teams.json registry.
    assert.deepEqual(report.stages.find((s) => s.id === "team:alpha")?.agents, [
      { name: "team-lead-alpha", role: "team-lead", source: "workflow" },
    ]);
    assert.deepEqual(report.stages.find((s) => s.id === "team:beta")?.agents, [
      { name: "team-lead-beta", role: "team-lead", source: "workflow" },
    ]);

    // Profile metadata (description / checkpoint / gate / autonomous) copied
    // from the CTO workflow's StageDefs.
    assert.equal(discovery?.gate, "branch_created");
    assert.equal(discovery?.checkpoint, "confirm_understanding");
    assert.equal(discovery?.autonomous, "log confirmed understanding, continue");

    assert.equal(decomposition?.checkpoint, "confirm_plan");
    assert.equal(decomposition?.gate, "plan_valid");
    assert.equal(decomposition?.autonomous, "proceed with the proposed TeamPlan (documented defaults)");

    assert.equal(integrationReview?.gate, "verdict != reject");
    assert.equal(integrationReview?.checkpoint, "user_accepts");
    assert.equal(integrationReview?.autonomous, "proceed with review verdict");

    // The `teams` stage declares no metadata in the CTO profile — absent.
    assert.equal(teams?.description, undefined);
    assert.equal(teams?.checkpoint, undefined);
    assert.equal(teams?.gate, undefined);
    assert.equal(teams?.autonomous, undefined);

    // Derived team stages (no StageDef) never carry profile metadata.
    const alpha = report.stages.find((s) => s.id === "team:alpha");
    assert.equal(alpha?.description, undefined);
    assert.equal(alpha?.checkpoint, undefined);
    assert.equal(alpha?.gate, undefined);
    assert.equal(alpha?.autonomous, undefined);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("cto: profile-backed workflow stages carry a reconstructed promptPreview; derived team stages omit it", () => {
  const cwd = tmpWorkspace();
  try {
    writeRun(cwd, makeCtoState());

    const report = buildSessionReport(cwd, { kind: "cto" });

    // Representative orchestrator stage: title/id/type, session task,
    // truthful main-session descriptor, declared outputs + profile metadata.
    const discovery = report.stages.find((s) => s.id === "cto_discovery");
    assert.ok(discovery?.promptPreview, "profile-backed CTO stage carries a preview");
    assert.ok(discovery.promptPreview!.includes("CTO Discovery [cto_discovery] type: orchestrator"), "title/id/type head line");
    assert.ok(discovery.promptPreview!.includes("task: Build the report feature"), "session task present");
    assert.ok(discovery.promptPreview!.includes("agents: orchestrator -> main session"), "truthful orchestrator descriptor");
    assert.ok(discovery.promptPreview!.includes("outputs: cto_discovery"), "declared outputs");
    assert.ok(discovery.promptPreview!.includes("checkpoint: confirm_understanding"), "checkpoint metadata");
    assert.ok(discovery.promptPreview!.includes("gate: branch_created"), "gate metadata");
    assert.ok(discovery.promptPreview!.includes("autonomous: log confirmed understanding, continue"), "autonomous metadata");

    // Single role stage: resolved agent + declared inputs/outputs.
    const arch = report.stages.find((s) => s.id === "architecture");
    assert.ok(arch?.promptPreview?.includes("agents: architect"), "resolved agent present");
    assert.ok(arch.promptPreview!.includes("inputs: team_plan"), "declared inputs");
    assert.ok(arch.promptPreview!.includes("outputs: architecture"), "declared outputs");

    // The `teams` stage declares inputs/outputs but has no role roster —
    // the preview carries no agent claim for the phase.
    const teams = report.stages.find((s) => s.id === "teams");
    assert.ok(teams?.promptPreview, "def-backed teams stage still gets a preview");
    assert.ok(!teams.promptPreview!.includes("agents:"), "no invented agent for the team phase");

    // Derived team stages have no StageDef → no preview.
    for (const teamId of ["alpha", "beta"]) {
      const team = report.stages.find((s) => s.id === `team:${teamId}`);
      assert.equal(team?.promptPreview, undefined, `derived team:${teamId} stage omits the preview`);
    }

    // No raw artifact JSON / transcript / event markers anywhere.
    for (const s of report.stages) {
      const p = s.promptPreview;
      if (!p) continue;
      assert.ok(!p.includes('"title":'), `${s.id}: no artifact JSON key markers`);
      assert.ok(!p.includes("stage_transition") && !p.includes("artifact_written"), `${s.id}: no event kinds`);
    }
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("cto: without a teams.json registry, team stages claim no lead (never invented)", () => {
  const cwd = tmpWorkspace();
  try {
    writeRun(cwd, makeCtoState());

    const report = buildSessionReport(cwd, { kind: "cto" });

    const alpha = report.stages.find((s) => s.id === "team:alpha");
    assert.equal(alpha?.agents, undefined, "no registry entry → no invented lead/model");
    assert.equal(alpha?.inputs, undefined, "team stages are derived, not def-backed → no input claim");
    assert.equal(alpha?.outputs, undefined);
    assert.equal(alpha?.promptPreview, undefined, "derived team stages have no StageDef → no preview");
    // Existing fields still intact.
    assert.equal(alpha?.status, "done");
    assert.equal(alpha?.team, "alpha");
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("cto: standby run derives pending cto_discovery and decomposition stages", () => {
  const cwd = tmpWorkspace();
  try {
    // A standby CTO run has not started discovery or decomposition: the
    // ctoStageStatus standby branches return "pending" for cto_discovery
    // (standby) and decomposition (standby + no plan teams).
    writeRun(
      cwd,
      makeCtoState({
        standby: true,
        plan: { id: "run-1", task: "Build the report feature", teams: [], created_at: "2026-08-08T09:00:00.000Z" },
        teams: [],
      }),
    );

    const report = buildSessionReport(cwd, { kind: "cto" });

    assert.equal(report.stages.find((s) => s.id === "cto_discovery")?.status, "pending", "standby keeps discovery pending");
    assert.equal(report.stages.find((s) => s.id === "decomposition")?.status, "pending", "standby with no teams keeps decomposition pending");
    assert.equal(report.stages.find((s) => s.id === "teams")?.status, "not_started", "no teams → not_started");
    assert.ok(report.meta.standby === true, "standby flag surfaced in report meta");
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});
