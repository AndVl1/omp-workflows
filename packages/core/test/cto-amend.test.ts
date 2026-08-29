/**
 * Amend protocol tests (br-k19): findActiveCtoRun read-only discovery +
 * buildAmendPrompt rendering; ctoCommand remains a pure protocol-v2 adapter;
 * markAmended stamps the state.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  runCto,
  ctoCommand,
  buildAmendPrompt,
  setCtoPause,
  markAmended,
  type TeamDef,
} from "@andvl1/omp-workflows-core";
import { findActiveCtoRun } from "../src/report/session-source.js";
import { readCtoState } from "../src/cto/state.js";
import { readWorkflowProfile, workflowV2Fixture } from "./workflow-v2-fixtures.js";
import { reportStorageFor } from "./report-storage-fixtures.js";
import type { WorkflowCommandContext } from "../src/commands/envelope.js";

function sampleDefs(): Record<string, TeamDef> {
  return {
    backend: {
      id: "backend",
      name: "Backend",
      scope: ["backend-kotlin"],
      profile: "lightweight",
      profile_identity: fixture.profile_identity,
      lead: "team-lead",
      roster: ["backend-kotlin"],
    },
    frontend: {
      id: "frontend",
      name: "Frontend",
      scope: ["frontend"],
      profile: "lightweight",
      profile_identity: fixture.profile_identity,
      lead: "team-lead",
      roster: ["frontend"],
    },
    "cli-go": {
      id: "cli-go",
      name: "CLI Go",
      scope: ["go"],
      profile: "lightweight",
      profile_identity: fixture.profile_identity,
      lead: "team-lead",
      roster: ["go"],
    },
  };
}
const fixture = workflowV2Fixture(readWorkflowProfile("lightweight"), {
  roleAgents: {
    "team-lead": "team-lead",
    "backend-kotlin": "backend-kotlin",
    frontend: "frontend",
    go: "go",
  },
  agentNames: [
    "developer-kotlin",
    "code-reviewer",
    "qa",
    "team-lead",
    "backend-kotlin",
    "frontend",
    "go",
  ],
});

function runIdentity(runId: string) {
  return { ...fixture.run_identity, run_id: runId };
}

const workflowContext: WorkflowCommandContext = {
  branch: "main",
  project_identity: fixture.project_identity,
  run_identity: fixture.run_identity,
  catalog: fixture.catalog,
  effectivePolicy: fixture.effective_policy,
  agentInventory: fixture.agent_inventory,
};
function teamInput(team: string, slice: string, runId: string) {
  const def = sampleDefs()[team]!;
  return {
    team,
    scope: [...def.scope],
    slice,
    profile: "lightweight",
    run_identity: runIdentity(runId),
    profile_identity: fixture.profile_identity,
    lead_ref: fixture.effective_policy.roles["team-lead"]!,
    roster_refs: def.roster.map((role) => fixture.effective_policy.roles[role]!),
  };
}

function startRun(root: string, runId = "feature-a") {
  const res = runCto({
    task: "Feature A",
    cwd: root,
    branch: "main",
    autonomous: false,
    teams: [teamInput("backend", "s1", runId), teamInput("frontend", "s2", runId)],
    defs: sampleDefs(),
    project_identity: fixture.project_identity,
    run_identity: runIdentity(runId),
    catalog: fixture.catalog,
    effective_policy: fixture.effective_policy,
    agent_inventory: fixture.agent_inventory,
  });
  assert.equal(res.ok, true);
  return res.ok ? res : null;
}

test("cto-amend: findActiveCtoRun returns null without runs", () => {
  const root = mkdtempSync(join(tmpdir(), "cto-amend-"));
  try {
    const storage = reportStorageFor(root);
    assert.equal(findActiveCtoRun(storage), null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("cto-amend: findActiveCtoRun finds an active run and ignores finished ones", () => {
  const root = mkdtempSync(join(tmpdir(), "cto-amend-"));
  try {
    const first = startRun(root);
    assert.ok(first);
    // A second, finished run must not shadow the active one.
    const doneRunId = "done-run";
    const done = runCto({
      task: "Done run",
      cwd: root,
      branch: "main",
      autonomous: false,
      teams: [teamInput("cli-go", "s", doneRunId)],
      defs: sampleDefs(),
      project_identity: fixture.project_identity,
      run_identity: runIdentity(doneRunId),
      catalog: fixture.catalog,
      effective_policy: fixture.effective_policy,
      agent_inventory: fixture.agent_inventory,
    });
    assert.equal(done.ok, true);
    if (done.ok) setCtoPause(done.state, "done", "finished", root);

    const storage = reportStorageFor(root);
    const active = findActiveCtoRun(storage);
    assert.equal(active?.runId, first.plan.id, "active run found even with a finished run present");
    assert.deepEqual(
      active?.state.teams.map((t) => t.id).sort(),
      ["backend", "frontend"],
    );

    // Marking the active run done -> nothing active left.
    setCtoPause(active!.state, "done", "finished", root);
    assert.equal(findActiveCtoRun(storage), null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("cto-amend: ctoCommand renders a pure protocol-v2 prompt", () => {
  const root = mkdtempSync(join(tmpdir(), "cto-amend-"));
  try {
    const notifyCalls: string[] = [];
    const ctx = (args: string) => ({
      args,
      cwd: root,
      workflowContext,
      ui: { notify: (m: string) => notifyCalls.push(m) },
    });

    const fresh = ctoCommand(ctx("Add OAuth"));
    assert.ok(fresh.includes("Add OAuth"), "task is echoed");
    assert.ok(fresh.includes("Workflow request (protocol v2) — /cto"), "v2 /cto prompt returned");
    assert.ok(fresh.includes(`Provider: \`${fixture.project_identity.provider_id}\``), "provider metadata is rendered");
    assert.ok(fresh.includes(`Session: \`${fixture.project_identity.session.session_id}\``), "session metadata is rendered");

    // An active run does not alter the pure command adapter's rendering.
    const active = startRun(root);
    assert.ok(active);
    const afterRun = ctoCommand(ctx("Add feature B in parallel"));
    assert.ok(afterRun.includes("Add feature B in parallel"), "task is echoed after a run exists");
    assert.ok(afterRun.includes("Workflow request (protocol v2) — /cto"), "v2 /cto prompt remains fresh");
    assert.ok(afterRun.includes(`Provider: \`${fixture.project_identity.provider_id}\``), "provider metadata remains stable");
    assert.ok(afterRun.includes(`Session: \`${fixture.project_identity.session.session_id}\``), "session metadata remains stable");
    assert.deepEqual(notifyCalls, [], "pure command adapter never notifies");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("cto-amend: findActiveCtoRun ignores markdown-only state", () => {
  const root = mkdtempSync(join(tmpdir(), "cto-amend-md-"));
  try {
    // Markdown files are visualization evidence, not an amendable run.
    const runId = "feat-ping-2026-08-04";
    const runDir = join(root, ".work-state", "cto", runId);
    mkdirSync(runDir, { recursive: true });
    writeFileSync(join(runDir, "cto_discovery.md"), "# Implement Feature A\n\nDiscovered scope.\n");
    writeFileSync(
      join(runDir, "team-plan.md"),
      [
        "# Team Plan — feat-ping",
        "",
        "- team: backend — server slice",
        "- team: frontend — status page",
        "",
        "Shared contract defined in architecture.md.",
      ].join("\n"),
    );
    writeFileSync(join(runDir, "decisions.md"), "| # | When | Decision | Why |\n");

    const storage = reportStorageFor(root);
    assert.equal(findActiveCtoRun(storage), null, "markdown-only evidence is not an active amend target");

    // Adding more markdown evidence cannot make a run active.
    writeFileSync(join(runDir, "summary.md"), "# Summary\nAll done.\n");
    assert.equal(findActiveCtoRun(storage), null, "markdown evidence never replaces durable state.json");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
test("cto-amend: ctoCommand ignores observational markdown state", () => {
  const root = mkdtempSync(join(tmpdir(), "cto-amend-mdcmd-"));
  try {
    const runId = "md-run-1";
    const runDir = join(root, ".work-state", "cto", runId);
    mkdirSync(runDir, { recursive: true });
    writeFileSync(join(runDir, "team-plan.md"), "# Team Plan\n- team: backend\n");
    writeFileSync(join(runDir, "decisions.md"), "table\n");

    const storage = reportStorageFor(root);
    assert.equal(findActiveCtoRun(storage), null, "markdown state is observational only");

    const notifyCalls: string[] = [];
    const prompt = ctoCommand({
      args: "Add feature B",
      cwd: root,
      workflowContext,
      ui: { notify: (m) => notifyCalls.push(m) },
    });
    assert.ok(prompt.includes("Add feature B"), "task is echoed");
    assert.ok(prompt.includes("Workflow request (protocol v2) — /cto"), "v2 /cto prompt returned");
    assert.ok(prompt.includes(`Provider: \`${fixture.project_identity.provider_id}\``), "provider metadata is rendered");
    assert.ok(prompt.includes(`Session: \`${fixture.project_identity.session.session_id}\``), "session metadata is rendered");
    assert.deepEqual(notifyCalls, [], "pure command adapter never notifies");
    assert.equal(findActiveCtoRun(storage), null, "command does not adopt observational state");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("cto-amend: cto_discovery.md alone is not an active amend target", () => {
  const root = mkdtempSync(join(tmpdir(), "cto-amend-early-"));
  try {
    const runId = "early-run";
    const runDir = join(root, ".work-state", "cto", runId);
    mkdirSync(runDir, { recursive: true });
    writeFileSync(join(runDir, "cto_discovery.md"), "# Implement Feature A\n");
    const storage = reportStorageFor(root);
    assert.equal(findActiveCtoRun(storage), null, "discovery evidence requires durable state.json and identity");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("cto-amend: markAmended stamps amended_at and persists", () => {
  const root = mkdtempSync(join(tmpdir(), "cto-amend-"));
  try {
    const res = startRun(root);
    assert.ok(res);
    markAmended(res.state, root);
    const reloaded = readCtoState(res.plan.id, root, res.state.run_identity);
    assert.ok(reloaded?.amended_at, "amended_at stamped after markAmended");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("cto-amend: buildAmendPrompt includes active run metadata without mutation", () => {
  const root = mkdtempSync(join(tmpdir(), "cto-amend-"));
  try {
    const res = startRun(root);
    assert.ok(res);
    assert.deepEqual(res.state.run_identity, runIdentity("feature-a"), "active state keeps the admitted feature identity");
    const stateBefore = JSON.stringify(res.state);
    const activeContext: WorkflowCommandContext = {
      ...workflowContext,
      run_identity: res.state.run_identity,
    };
    const prompt = buildAmendPrompt(
      { task: "Task B", autonomyHint: true, issue: null, branch: "main" },
      activeContext,
      { runId: res.plan.id, state: res.state },
    );
    assert.ok(prompt.includes("Task: Task B"), "amend task is rendered");
    assert.ok(prompt.includes(`Run: \`${res.plan.id}\``));
    assert.ok(prompt.includes(`Provider: \`${fixture.project_identity.provider_id}\``), "amend provider comes from active identity");
    assert.ok(!prompt.includes("+runId+"), "no literal template placeholder leaks into the rendered prompt");
    assert.ok(prompt.includes("Autonomy hint (leading directive — MECHANICAL, NOT authoritative; routing/migration metadata only): ON"), "amend renders the mechanical hint, not a decision");
    assert.ok(prompt.includes("### Workflow routing"), "amend carries the workflow routing matrix");
    assert.equal(JSON.stringify(res.state), stateBefore, "prompt rendering does not mutate active state");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
