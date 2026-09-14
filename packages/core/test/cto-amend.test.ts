/**
 * Amend protocol tests (br-k19): findActiveCtoRun routing + ctoCommand
 * returns the AMEND contract when a run is active, the fresh contract
 * otherwise; markAmended stamps the state.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCto } from "../src/cto/run.js";
import { CtoAuthorityUnavailableError, ctoCommand, buildAmendPrompt, findActiveCtoRun } from "../src/commands/cto.js";
import type { TeamDef } from "../src/cto/types.js";
import { ctoRuntimeRunInitialIdentityDigest, isCtoRunTerminal, markAmended, newCtoState, readCtoState, writeCtoRuntimeStateProof, writeCtoState, setCtoPause, setIntegration, setTeamStatus } from "../src/cto/state.js";
import { PinnedProjectRoot } from "../src/specification/pinned-root.js";
import { openTestCtoRuntime } from "./fixtures/registry-activation.js";
import type { CtoRuntimeAccessFacade } from "../src/cto/runtime-access.js";

function sampleDefs(): Record<string, TeamDef> {
  return {
    backend: { id: "backend", name: "Backend", scope: ["backend-kotlin"], profile: "lightweight", lead: "team-lead", roster: ["backend-kotlin"] },
    frontend: { id: "frontend", name: "Frontend", scope: ["frontend"], profile: "lightweight", lead: "team-lead", roster: ["frontend"] },
    "cli-go": { id: "cli-go", name: "CLI Go", scope: ["go"], profile: "lightweight", lead: "team-lead", roster: ["go"] },
  };
}

function startRun(root: string, runtimeAccess: CtoRuntimeAccessFacade) {
  const res = runCto({
    task: "Feature A",
    cwd: root,
    branch: "main",
    autonomous: false,
    sessionId: "main-session",
    teams: [{ team: "backend", slice: "s1" }, { team: "frontend", slice: "s2" }],
    defs: sampleDefs(),
    runtimeAccess,
  });
  assert.equal(res.ok, true);
  if (res.ok) seedOwnedState(root, res.state, runtimeAccess);
  return res.ok ? res : null;
}

function ownedIdentity(state: ReturnType<typeof newCtoState>): void {
  state.owner_session = "main-session";
  state.work_identity ??= {
    run_id: state.id,
    wave_id: "cto-run",
    slice_id: "cto-run",
    session_id: "main-session",
    workflow: "standard",
    stage_id: "cto",
    stage_cursor: "cto",
    capability_id: "cto-test",
    capability_epoch: "test",
    slot_id: state.id,
    task_id: state.id,
    dispatch_id: state.id,
    attempt: 1,
    worker_id: "cto-test",
  };
}

function seedOwnedState(root: string, state: ReturnType<typeof newCtoState>, runtimeAccess: CtoRuntimeAccessFacade): void {
  ownedIdentity(state);
  const pinnedRoot = PinnedProjectRoot.open(root);
  assert.ok(pinnedRoot);
  try {
    writeCtoState(state, root, { pinnedRoot, preCommit: ({ pinnedRoot: stableRoot }) => stableRoot.assertStable() });
    assert.equal(writeCtoRuntimeStateProof(pinnedRoot, state), true);
  } finally {
    pinnedRoot.close();
  }
  runtimeAccess.findActiveRun();
}

function persistState(root: string, state: ReturnType<typeof newCtoState>, runtimeAccess: CtoRuntimeAccessFacade): void {
  seedOwnedState(root, state, runtimeAccess);
  runtimeAccess.withRunTransaction(state.id, (transaction) => {
    transaction.writeState(state);
  });
}

/**
 * The specification execution prompt is an instruction contract, not a
 * persistence API. Keep this assertion scoped to positive tool ordering and
 * absence of the old affirmative direct-write instructions.
 */
function assertEngineOwnedExecutionPrompt(prompt: string, label: string): void {
  const tools = ["cto_prepare", "cto_preflight", "cto_confirm", "cto_dispatch", "cto_specification_conformance", "workflow_complete_specification_execution", "cto_close_specification_execution_wave"];
  let previous = -1;
  for (const tool of tools) {
    const index = prompt.indexOf(tool);
    assert.ok(index > previous, `${label}: ${tool} follows the prior engine tool`);
    previous = index;
  }
  assert.match(prompt, /report (?:all|every) blocked (?:and excluded )?finding(?:s)? verbatim/, `${label}: blocked findings stay verbatim`);
  assert.match(prompt, /exact (?:eligible-only )?descriptor returned in `cto_prepare\.required_next_tool\.arguments`/i, `${label}: preflight consumes the engine-issued eligible descriptor`);
  assert.match(prompt, /excluded (?:selectors|rows)[^\n]*(?:MUST NOT be repeated|never (?:sent|re-enter))[^\n]*cto_preflight/i, `${label}: excluded selectors never re-enter operational preflight`);
  assert.ok(prompt.includes("current user"), `${label}: mapping choices target the current user`);
  assert.ok(prompt.includes("approve_continue"), `${label}: continue is an explicit mapping decision`);
  assert.ok(prompt.includes("engine-issued"), `${label}: proof comes from the engine`);
  assert.match(prompt, /canonical top-level classification[\s\S]*do not send a classification field[\s\S]*type=FEATURE, complexity=MEDIUM, confidence=HIGH, autonomous=true, workflow=standard/i, `: execution classification is engine-derived and literal`);
  assert.match(prompt, /never invoke [/]do-work[\s\S]*workflow_prepare[\s\S]*team-state\.json[\s\S]*invent PHASE-0/i, "execution prompt must not fall back to generic preparation or fabricated classification");
  assert.match(prompt, /dispatch only its returned admitted_slices[\s\S]*exact returned <!-- omp-cto-slice run=<runId> slice=<sliceId> --> marker[\s\S]*every lead\/worker task/i, "dispatch prompt must use only engine-admitted slices and exact markers");
  assert.ok(prompt.includes("ensure_project_constitution"), `${label}: shared constitution prerequisite tool is explicit`);
  assert.ok(prompt.includes("present_constitution_draft"), `${label}: constitution draft tool is explicit`);
  assert.ok(prompt.includes("constitution_checkpoint_ask_selected"), `${label}: constitution Ask shape is explicit`);
  assert.ok(prompt.includes("decide_constitution_checkpoint"), `${label}: constitution decision tool is explicit`);
  assert.match(prompt, /"origin_kind":"cto_preparation"/, `${label}: CTO origin kind is explicit`);
  assert.match(prompt, /"origin_run_key":"<exact selected run_key>"/, `${label}: origin run is the exact selected run`);
  assert.match(prompt, /"origin_stage":"cto"/, `${label}: CTO origin stage is canonical`);
  assert.match(prompt, /"authorization":"human"/, `${label}: decision authorization is exact`);
  assert.match(prompt, /"actor_provenance":\{"kind":"user"/, `${label}: user provenance is exact`);
  assert.doesNotMatch(prompt, /^\s*(?:Call|Invoke|Run|Use)\s+`workflow_prepare`/im, `${label}: no generic workflow preparation call`);
  assert.doesNotMatch(prompt, /set its `wave_history` record status|clear `active_wave_id`/i, `${label}: direct terminal wave mutation is absent`);
  assert.match(prompt, /cto_close_specification_execution_wave[\s\S]*engine alone performs the terminal wave CAS/i, `${label}: mounted close tool owns terminal wave mutation`);
  assert.match(prompt, /exactly one current execution-profile quality gate/i, `${label}: profile gate is explicit`);
  assert.match(prompt, /execution-profile\.<selected workspace profile_hash>/, `${label}: profile gate binds selected workspace profile`);
  assert.match(prompt, /quality_gate_evidence/, `${label}: profile gate evidence artifact is explicit`);
}

test("runCto rejects cross-root, foreign-session, and revoked runtime access without state writes", () => {
  const root = mkdtempSync(join(tmpdir(), "cto-run-auth-root-"));
  const foreignRoot = mkdtempSync(join(tmpdir(), "cto-run-auth-foreign-"));
  const runtime = openTestCtoRuntime(root, "session-a", "cto-run-auth-test");
  const options = {
    task: "authenticated run",
    cwd: root,
    branch: "main",
    autonomous: false,
    sessionId: "session-a",
    teams: [{ team: "backend", slice: "s1" }],
    defs: sampleDefs(),
    runtimeAccess: runtime.access,
  };
  try {
    const foreignBefore = existsSync(join(foreignRoot, ".work-state"));
    const crossRoot = runCto({ ...options, cwd: foreignRoot });
    assert.equal(crossRoot.ok, false, "a runtime bound to another root must be rejected");
    assert.equal(existsSync(join(foreignRoot, ".work-state")), foreignBefore, "cross-root rejection must not create state");
    const foreignSession = runCto({ ...options, sessionId: "session-b" });
    assert.equal(foreignSession.ok, false, "a foreign session must be rejected");
    assert.equal(findActiveCtoRun(root), null, "foreign-session rejection must not create a run");
    runtime.close();
    const revoked = runCto(options);
    assert.equal(revoked.ok, false, "a revoked runtime must be rejected");
    assert.equal(findActiveCtoRun(root), null, "revoked-runtime rejection must not create a run");
  } finally {
    try { runtime.close(); } catch { }
    rmSync(root, { recursive: true, force: true });
    rmSync(foreignRoot, { recursive: true, force: true });
  }
});

test("cto-amend: findActiveCtoRun returns null without runs", () => {
  const root = mkdtempSync(join(tmpdir(), "cto-amend-"));
  try {
    assert.equal(findActiveCtoRun(root), null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("cto-amend: findActiveCtoRun finds an active run and ignores finished ones", () => {
  const root = mkdtempSync(join(tmpdir(), "cto-amend-"));
  const runtime = openTestCtoRuntime(root);
  try {
    const first = startRun(root, runtime.access);
    assert.ok(first);
    // A second, finished run must not shadow the active one.
    const done = runCto({
      task: "Done run",
      cwd: root,
      branch: "main",
      autonomous: false,
      sessionId: "main-session",
      teams: [{ team: "cli-go", slice: "s" }],
      defs: sampleDefs(),
      runtimeAccess: runtime.access,
    });
    assert.equal(done.ok, true);
    if (done.ok) {
      setCtoPause(done.state, "done", "finished");
      persistState(root, done.state, runtime.access);
    }

    const active = findActiveCtoRun(root);
    assert.equal(active?.runId, first.plan.id, "active run found even with a finished run present");
    assert.deepEqual(
      active?.state.teams.map((t) => t.id).sort(),
      ["backend", "frontend"],
    );

    // Marking the active run done -> nothing active left.
    setCtoPause(active!.state, "done", "finished");
    persistState(root, active!.state, runtime.access);
    assert.equal(findActiveCtoRun(root), null);
  } finally {
    runtime.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("cto-amend: forged delivery-index fields fail closed without mutating canonical state", () => {
  const root = mkdtempSync(join(tmpdir(), "cto-amend-authority-"));
  const runtime = openTestCtoRuntime(root);
  try {
    const active = startRun(root, runtime.access);
    assert.ok(active);
    if (!active) return;
    const indexPath = join(root, ".work-state", "cto", "active-run-index.json");
    const statePath = join(root, ".work-state", "cto", active.plan.id, "state.json");
    const original = JSON.parse(readFileSync(indexPath, "utf8")) as {
      schema_version: number;
      active_run_id: string | null;
      entries: Array<Record<string, unknown>>;
    };
    const canonicalStateBytes = readFileSync(statePath);
    const entry = original.entries.find((candidate) => candidate.run_id === active.plan.id);
    assert.ok(entry);
    if (!entry) return;
    const mutations: Array<{ label: string; entry: Record<string, unknown>; active_run_id: string | null }> = [
      {
        label: "future timestamp",
        entry: { ...entry, updated_at: "2099-01-01T00:00:00.000Z" },
        active_run_id: active.plan.id,
      },
      {
        label: "wrong status",
        entry: { ...entry, status: "done" },
        active_run_id: null,
      },
      {
        label: "wrong revision",
        entry: { ...entry, state_revision: Number(entry.state_revision) + 1 },
        active_run_id: active.plan.id,
      },
      {
        label: "wrong summary digest",
        entry: { ...entry, summary_digest: "0".repeat(64) },
        active_run_id: active.plan.id,
      },
    ];
    for (const mutation of mutations) {
      writeFileSync(indexPath, JSON.stringify({
        ...original,
        active_run_id: mutation.active_run_id,
        entries: original.entries.map((candidate) => candidate.run_id === active.plan.id ? mutation.entry : candidate),
      }) + "\n");
      assert.throws(
        () => findActiveCtoRun(root),
        (error: unknown) => error instanceof CtoAuthorityUnavailableError && error.code === "CTO_AUTHORITY_UNAVAILABLE",
        `${mutation.label} forged fields must fail closed when index proof no longer authenticates`,
      );
      const notifications: string[] = [];
      assert.throws(
        () => ctoCommand({ args: "follow-up", cwd: root, ui: { notify: (message: string) => notifications.push(message) } }),
        (error: unknown) => error instanceof CtoAuthorityUnavailableError && error.code === "CTO_AUTHORITY_UNAVAILABLE",
        `${mutation.label} must not route a fresh or amend command through a forged index`,
      );
      assert.deepEqual(readFileSync(statePath), canonicalStateBytes, `${mutation.label} must not rewrite canonical state`);
      assert.deepEqual(notifications, [], `${mutation.label} must not emit fresh/amend routing notifications`);
    }
  } finally {
    runtime.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("cto-amend: indexed active run survives more than 1025 junk directories", () => {
  const root = mkdtempSync(join(tmpdir(), "cto-amend-"));
  const runtime = openTestCtoRuntime(root);
  try {
    const active = startRun(root, runtime.access);
    assert.ok(active);
    for (let i = 0; i < 1026; i += 1) {
      mkdirSync(join(root, ".work-state", "cto", `junk-${i}`), { recursive: true });
    }
    const discovered = findActiveCtoRun(root);
    assert.equal(discovered?.runId, active.plan.id);
  } finally {
    runtime.close();
    rmSync(root, { recursive: true, force: true });
  }
});
test("cto-amend: uppercase active run ids remain discoverable and do not create a second run", () => {
  const root = mkdtempSync(join(tmpdir(), "cto-amend-uppercase-"));
  const runtime = openTestCtoRuntime(root);
  try {
    const state = newCtoState({
      id: "CTO-1",
      task: "Uppercase resident run",
      branch: "main",
      autonomous: false,
      owner_session: "main-session",
      plan: { id: "CTO-1", task: "Uppercase resident run", teams: [], created_at: "2026-08-31T12:00:00.000Z" },
    });
    runtime.access.createRun(state, { source_id: "cto-uppercase-test", initial_state_sha256: ctoRuntimeRunInitialIdentityDigest(state) });
    const discovered = findActiveCtoRun(root);
    assert.equal(discovered?.runId, "CTO-1");
    const amend = ctoCommand({ args: "follow-up", cwd: root, ui: { notify: () => undefined } });
    assert.match(amend, /\/cto AMEND/);
    assert.equal(findActiveCtoRun(root)?.runId, "CTO-1");
  } finally {
    runtime.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("cto-amend: ctoCommand routes to AMEND while a run is active, fresh otherwise", () => {
  const root = mkdtempSync(join(tmpdir(), "cto-amend-"));
  const runtime = openTestCtoRuntime(root);
  try {
    const notifyCalls: string[] = [];
    const ctx = (args: string) => ({ args, cwd: root, ui: { notify: (m: string) => notifyCalls.push(m) } });

    // No run yet -> fresh contract.
    const fresh = ctoCommand(ctx("execute ready handoff --spec oauth --run-key run-oauth"));
    assert.ok(fresh.includes("/cto workflow"), "fresh contract for the first task");
    assert.ok(!fresh.includes("AMEND"));

    // Start a run -> second /cto folds into it.
    startRun(root, runtime.access);
    const amend = ctoCommand(ctx("execute ready handoff --spec feature-b --run-key run-b"));
    assert.ok(amend.includes("/cto AMEND"), "amend contract for the second task");
    assert.ok(amend.includes("execute ready handoff"), "new task echoed");
    assert.ok(amend.includes("Do NOT start a second run"), "single orchestrator rule");
    assertEngineOwnedExecutionPrompt(amend, "amend prompt");
    assert.ok(!amend.includes("amended_at"), "amend no longer asks the model to stamp state directly");
    assert.ok(!amend.includes("markAmended"), "amend does not expose a direct state mutation helper");
    assert.ok(notifyCalls.some((m) => m.includes("amending run")), "notify announces the amend");

    // Finished run -> fresh again.
    const active = findActiveCtoRun(root);
    assert.ok(active);
    setCtoPause(active.state, "done", "done");
    persistState(root, active.state, runtime.access);
    const freshAgain = ctoCommand(ctx("execute ready handoff --spec feature-c --run-key run-c"));
    assert.ok(freshAgain.includes("/cto workflow"));
    assert.ok(!freshAgain.includes("AMEND"));
  } finally {
    runtime.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("cto-amend: markAmended stamps amended_at and persists", () => {
  const root = mkdtempSync(join(tmpdir(), "cto-amend-"));
  const runtime = openTestCtoRuntime(root);
  try {
    const res = startRun(root, runtime.access);
    assert.ok(res);
    markAmended(res.state);
    persistState(root, res.state, runtime.access);
    const reloaded = readCtoState(res.plan.id, root);
    assert.ok(reloaded?.amended_at, "amended_at stamped after markAmended");
  } finally {
    runtime.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("cto-amend: buildAmendPrompt includes active run metadata", () => {
  const root = mkdtempSync(join(tmpdir(), "cto-amend-"));
  const runtime = openTestCtoRuntime(root);
  try {
    const res = startRun(root, runtime.access);
    assert.ok(res);
    const prompt = buildAmendPrompt(
      { task: "execute ready handoff --spec feature-b --run-key run-b", autonomyHint: true, issue: null, branch: "main" },
      root,
      { runId: res.plan.id, state: res.state },
    );
    assert.ok(prompt.includes(`Run: \`${res.plan.id}\``));
    assert.ok(prompt.includes(`.work-state/cto/${res.plan.id}/inbox/*.json`), "amend inbox check points at the ACTUAL run inbox");
    assert.ok(!prompt.includes("+runId+"), "no literal template placeholder leaks into the rendered prompt");
    assert.ok(prompt.includes("Autonomy hint (leading directive — MECHANICAL, NOT authoritative; routing/migration metadata only): ON"), "amend renders the mechanical hint, not a decision");
    assert.ok(prompt.includes("### Workflow routing"), "amend carries the workflow routing matrix");
    assert.ok(prompt.includes("Integration covers ALL teams"));
    assert.ok(
      prompt.includes("<!-- omp-cto-slice run=<runId> slice=<sliceId> -->"),
      "exact marker literal in the amend prompt",
    );
    assert.ok(prompt.includes("Wave / slice gate contract"), "amend carries the wave/slice gate contract");
    assert.ok(prompt.includes("active_wave_id"), "amend requires wave creation before lead spawn");
    assert.ok(prompt.includes("SAME run id"), "amend keeps the SAME run id across waves");
    assertEngineOwnedExecutionPrompt(prompt, "buildAmendPrompt");
  } finally {
    runtime.close();
    rmSync(root, { recursive: true, force: true });
  }
});
test("cto-amend: ordinary work uses the general orchestration route", () => {
  const root = mkdtempSync(join(tmpdir(), "cto-amend-general-"));
  const runtime = openTestCtoRuntime(root);
  try {
    const res = startRun(root, runtime.access);
    assert.ok(res);
    if (!res) return;
    const prompt = buildAmendPrompt(
      { task: "Investigate the billing timeout and coordinate a fix", autonomyHint: false, issue: null, branch: "main" },
      root,
      { runId: res.plan.id, state: res.state },
    );
    assert.match(prompt, /\/cto AMEND — GENERAL orchestration/iu);
    assert.match(prompt, /### Workflow routing/iu);
    assert.match(prompt, /### CTO discipline/iu);
    assert.match(prompt, /LECTURE_RESEARCH/iu);
    assert.doesNotMatch(prompt, /cto_(?:prepare|preflight|confirm|dispatch)/u);
  } finally {
    runtime.close();
    rmSync(root, { recursive: true, force: true });
  }
});
