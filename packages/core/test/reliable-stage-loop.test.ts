import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { loadProfile } from "../src/engine/profile.js";
import {
  BRANCH,
  CLASSIFICATION,
  CTO_CLASSIFICATION,
  admitCtoLead,
  admitCtoLeadAndWorker,
  admitCtoWorker,
  ctoHarness,
  ctoIngress,
  ctoStateSnapshot,
  admitOrdinaryWorker,
  ordinaryHarness,
  ordinaryIngress,
  requireTool,
  submission,
  terminalWorker,
  type Harness,
  type Handoff,
} from "./reliable-stage-execution-fixture.js";
import { readRunState } from "../src/engine/run-store.js";
import type { Profile, TeamState } from "../src/engine/types.js";
import { scenarioTest } from "./reliable-stage-trace.js";

const LOOP_PROFILE: Profile = {
  name: "reliable-stage-loop-registered",
  title: "Registered reliable stage loop",
  description: "A real registered diagnose → implementation → verify loop.",
  match: { type: ["FEATURE"], complexity: ["QUICK"] },
  stages: [
    {
      id: "diagnose",
      title: "Diagnose",
      type: "single",
      role: "dev",
      produces: "diagnosis",
    },
    {
      id: "implementation",
      title: "Implementation",
      type: "single",
      role: "dev",
      consumes: ["diagnosis"],
      produces: "implementation",
    },
    {
      id: "verify",
      title: "Verify",
      type: "single",
      role: "dev",
      consumes: ["diagnosis", "implementation"],
      produces: "debug",
      loop: { back_to: "diagnose", until: "verdict == PASS", max_iterations: 2, on_exhausted: "escalate_user" },
    },
    {
      id: "downstream",
      title: "Downstream",
      type: "single",
      role: "dev",
      consumes: ["debug"],
      produces: "downstream",
    },
  ],
};

const LOOP_CLASSIFICATION = { ...CLASSIFICATION, workflow: LOOP_PROFILE.name };

type ToolDetails = Record<string, unknown>;

function details(value: unknown): ToolDetails {
  assert.ok(value && typeof value === "object" && !Array.isArray(value));
  return value as ToolDetails;
}

async function invoke(harness: Harness, name: string, id: string, input: unknown, context = harness.context): Promise<ToolDetails> {
  const result = await requireTool(harness, name).execute(id, input, undefined, undefined, context);
  return details(result.details);
}

function profileHash(handoff: Handoff): string {
  const value = handoff.profile_hash;
  assert.equal(typeof value, "string", "registered handoff carries the profile hash required for advance");
  return value as string;
}

function advanceInput(handoff: Handoff, evidence: string): Record<string, unknown> {
  return {
    token: handoff.advance_token,
    capability_id: handoff.capability_id,
    run_key: handoff.run_key,
    branch: BRANCH,
    workflow: LOOP_PROFILE.name,
    profile_hash: profileHash(handoff),
    stage_cursor: handoff.stage_cursor,
    cursor_epoch: handoff.cursor_epoch,
    loop_iteration: handoff.loop_iteration,
    evidence,
  };
}

function artifactFor(stageId: string, iteration: number, verdict?: "FAIL" | "PASS"): Record<string, unknown> {
  switch (stageId) {
    case "diagnose":
      return { diagnosis: { root_cause: `root cause ${iteration}`, explanation: `diagnosis iteration ${iteration}` } };
    case "implementation":
      return {
        implementation: {
          files_touched: ["packages/core/test/reliable-stage-loop.test.ts"],
          ready: true,
          validation_run: true,
          validation_evidence: `registered implementation iteration ${iteration}`,
        },
      };
    case "verify":
      assert.ok(verdict);
      return { debug: { verdict, iterations: iteration, failure_evidence: verdict === "FAIL" ? `failure-${iteration}` : "" } };
    case "downstream":
      return { downstream: { observed: true } };
    default:
      throw new Error(`unexpected registered loop stage '${stageId}'`);
  }
}

async function completeRegisteredStage(
  harness: Harness,
  handoff: Handoff,
  iteration: number,
  trace: string[],
  verdict?: "FAIL" | "PASS",
  suffix = "stage",
): Promise<Handoff | undefined> {
  const stageId = handoff.stage_cursor;
  trace.push(stageId);
  const worker = await admitOrdinaryWorker(harness, handoff, `${suffix}-${stageId}-${iteration}-${trace.length}`);
  const submitted = await invoke(harness, "workflow_submit_result", `${suffix}-${stageId}-${iteration}-${trace.length}-submit`, submission(artifactFor(stageId, iteration, verdict)), worker.childContext);
  assert.equal(submitted.ok, true, JSON.stringify(submitted));
  await terminalWorker(harness, worker);
  const advanced = await invoke(harness, "workflow_advance", `${suffix}-${stageId}-${iteration}-${trace.length}-advance`, advanceInput(handoff, `${stageId} iteration ${iteration} completed`));
  assert.equal(advanced.ok, true, JSON.stringify(advanced));
  const next = advanced.handoff;
  if (next === undefined) return undefined;
  assert.ok(next && typeof next === "object" && !Array.isArray(next), JSON.stringify(advanced));
  const begun = await invoke(harness, "workflow_begin", `${suffix}-${stageId}-${iteration}-${trace.length}-begin`, {});
  assert.equal(begun.ok, true, JSON.stringify(begun));
  const rearmed = begun.handoff;
  assert.ok(rearmed && typeof rearmed === "object" && !Array.isArray(rearmed), JSON.stringify(begun));
  return rearmed as Handoff;
}

async function runCycle(
  harness: Harness,
  handoff: Handoff,
  iteration: number,
  verdict: "FAIL" | "PASS",
  trace: string[],
  suffix: string,
): Promise<Handoff | undefined> {
  assert.equal(handoff.stage_cursor, "diagnose");
  let next = await completeRegisteredStage(harness, handoff, iteration, trace, undefined, suffix);
  assert.ok(next);
  assert.equal(next.stage_cursor, "implementation");
  next = await completeRegisteredStage(harness, next, iteration, trace, undefined, suffix);
  assert.ok(next);
  assert.equal(next.stage_cursor, "verify");
  next = await completeRegisteredStage(harness, next, iteration, trace, verdict, suffix);
  if (verdict === "FAIL" && next) {
    assert.equal(next.stage_cursor, "diagnose");
  }
  return next;
}

async function restartRegisteredRun(harness: Harness, runId: string): Promise<Handoff> {
  const resumed = await invoke(harness, "workflow_prepare", "reliable-loop-restart-resume", { mode: "resume", run_id: runId });
  assert.equal(resumed.ok, true, JSON.stringify(resumed));
  const begun = await invoke(harness, "workflow_begin", "reliable-loop-restart-begin", {});
  assert.equal(begun.ok, true, JSON.stringify(begun));
  const handoff = begun.handoff;
  assert.ok(handoff && typeof handoff === "object" && !Array.isArray(handoff), JSON.stringify(begun));
  return handoff as Handoff;
}

function stateOf(harness: Harness, runId: string): TeamState {
  const state = readRunState(harness.root, runId);
  assert.ok(state, `registered run '${runId}' must remain readable`);
  return state;
}

test("[unit:R16] custom registered loop helper exercises re-entry and downstream gating", async () => {
  const harness = ordinaryHarness({ workflowProfiles: [LOOP_PROFILE] });
  try {
    const { runId, handoff: initial } = await ordinaryIngress(harness, { classification: LOOP_CLASSIFICATION, task: "registered reliable loop" });
    const trace: string[] = [];
    let handoff = await runCycle(harness, initial, 1, "FAIL", trace, "o-r16");
    assert.ok(handoff);
    const afterFailure = stateOf(harness, runId);
    assert.equal(afterFailure.loop_state?.reentries, 1);
    assert.equal(afterFailure.stage_cursor, "diagnose");
    assert.equal(JSON.parse(readFileSync(`${harness.root}/.work-state/runs/${runId}/artifacts/debug.json`, "utf8")).failure_evidence, "failure-1");
    handoff = await restartRegisteredRun(harness, runId);
    assert.equal(handoff.stage_cursor, "diagnose");
    assert.equal(handoff.loop_iteration, 2);
    handoff = await runCycle(harness, handoff, 2, "PASS", trace, "o-r16-restart");
    assert.ok(handoff);
    assert.equal(handoff.stage_cursor, "downstream");
    handoff = await completeRegisteredStage(harness, handoff, 2, trace, undefined, "o-r16-downstream");
    assert.equal(handoff, undefined);
    assert.deepEqual(trace, ["diagnose", "implementation", "verify", "diagnose", "implementation", "verify", "downstream"]);
    const final = stateOf(harness, runId);
    assert.equal(final.loop_state?.status, "complete");
    assert.equal(final.stages.find((stage) => stage.id === "downstream")?.status, "done");
  } finally {
    await harness.close();
  }
});

test("[unit:R17] custom registered loop helper exhausts total execution count", async () => {
  const harness = ordinaryHarness({ workflowProfiles: [LOOP_PROFILE] });
  try {
    const { runId, handoff: initial } = await ordinaryIngress(harness, { classification: LOOP_CLASSIFICATION, task: "registered reliable exhaustion" });
    const trace: string[] = [];
    let handoff = await runCycle(harness, initial, 1, "FAIL", trace, "o-r17");
    assert.ok(handoff);
    handoff = await runCycle(harness, handoff, 2, "FAIL", trace, "o-r17");
    assert.equal(handoff, undefined, "the second real execution exhausts the loop");
    assert.deepEqual(trace, ["diagnose", "implementation", "verify", "diagnose", "implementation", "verify"]);
    const final = stateOf(harness, runId);
    assert.equal(final.loop_state?.status, "exhausted");
    assert.equal(final.loop_state?.reentries, 1);
    assert.equal(final.pause.kind, "needs_human");
    assert.equal(final.stages.find((stage) => stage.id === "downstream")?.status, "pending");
    assert.equal(final.stage_cursor, "verify");
  } finally {
    await harness.close();
  }
});

const DEBUG_PROFILE = loadProfile("debug-cycle");
if (!DEBUG_PROFILE) throw new Error("shipped debug-cycle profile is required for registered R16/R17 acceptance");

const DEBUG_CLASSIFICATION = {
  type: "BUG_FIX" as const,
  complexity: "MEDIUM" as const,
  confidence: "HIGH" as const,
  autonomous: false,
  workflow: DEBUG_PROFILE.name,
};

function debugAdvanceInput(handoff: Handoff, evidence: string): Record<string, unknown> {
  const hash = handoff.profile_hash;
  assert.equal(typeof hash, "string");
  return {
    token: handoff.advance_token,
    capability_id: handoff.capability_id,
    run_key: handoff.run_key,
    branch: BRANCH,
    workflow: DEBUG_PROFILE.name,
    profile_hash: hash,
    stage_cursor: handoff.stage_cursor,
    cursor_epoch: handoff.cursor_epoch,
    loop_iteration: handoff.loop_iteration,
    evidence,
  };
}
type ImmutableFailureSnapshot = {
  evidence: string;
  immutable_ref: string;
  bytes: Buffer;
};

function priorImmutableFailureSnapshot(
  harness: Harness,
  runId: string,
  iteration: number,
  route: "ordinary" | "native" = "ordinary",
): ImmutableFailureSnapshot {
  assert.ok(iteration > 1);
  const state = route === "native"
    ? ctoStateSnapshot(runId, harness.root)
    : stateOf(harness, runId);
  assert.ok(state, `registered ${route} run '${runId}' must remain readable`);
  const receipts = Object.values(state.stage_receipts ?? {})
    .filter((receipt) => receipt.work_identity.stage_id === "verify" && receipt.work_identity.loop_iteration === iteration - 1)
    .sort((left, right) => right.accepted_at.localeCompare(left.accepted_at));
  const receipt = receipts[0];
  assert.ok(receipt, `iteration ${iteration - 1} verify receipt must remain available for diagnosis`);
  const output = receipt.outputs.find((candidate) => candidate.artifact_id === "debug");
  assert.ok(output, "prior verify receipt must carry the canonical debug output");
  const artifactsRoot = route === "native"
    ? join(harness.root, ".work-state", "cto", runId, "artifacts")
    : join(harness.root, ".work-state", "runs", runId, "artifacts");
  const bytes = readFileSync(join(artifactsRoot, output.immutable_ref));
  const raw = JSON.parse(bytes.toString("utf8")) as unknown;
  assert.ok(raw && typeof raw === "object" && !Array.isArray(raw));
  assert.equal("verdict" in raw ? raw.verdict : undefined, "FAIL", "next diagnosis must consume the immutable prior FAIL");
  const evidence = "manual_qa_log" in raw ? raw.manual_qa_log : undefined;
  assert.equal(typeof evidence, "string", "immutable prior FAIL must carry its evidence");
  return { evidence, immutable_ref: output.immutable_ref, bytes };
}

function priorImmutableFailureEvidence(
  harness: Harness,
  runId: string,
  iteration: number,
  route: "ordinary" | "native" = "ordinary",
): string {
  return priorImmutableFailureSnapshot(harness, runId, iteration, route).evidence;
}


function debugArtifact(stageId: string, iteration: number, verdict?: "FAIL" | "PASS", priorFailureEvidence?: string): Record<string, unknown> {
  if (stageId === "discovery") {
    return {
      discovery: {
        task: "registered debug cycle",
        branch: BRANCH,
        declaredDoD: {
          items: [{
            id: "r16-1",
            source: "discovery",
            criterion: "The debug-cycle is bound to its registered run branch.",
            verify_method: "canonical registered run branch observation",
            status: "met",
            evidence: `registered branch ${BRANCH}`,
          }],
          type_requirements_met: true,
        },
      },
    };
  }
  if (stageId === "diagnose") {
    if (iteration > 1) assert.ok(priorFailureEvidence, "retry diagnosis must carry prior immutable failure evidence");
    return {
      diagnosis: {
        root_cause: `registered root cause ${iteration}`,
        explanation: `the failure evidence is addressed by iteration ${iteration}`,
        evidence: [priorFailureEvidence ?? `failure-${Math.max(1, iteration - 1)}`],
      },
      dod: {
        items: [{
          id: `diagnose-${iteration}-1`,
          source: "diagnose",
          criterion: "The verification loop reaches a terminal PASS.",
          verify_method: "registered manual QA verdict",
          status: "met",
          evidence: `diagnosis iteration ${iteration}`,
        }],
      },
    };
  }
  if (stageId === "implementation") {
    return { implementation: { files_touched: ["packages/core/test/reliable-stage-loop.test.ts"], ready: true, validation_run: true, validation_evidence: `registered implementation iteration ${iteration}` } };
  }
  if (stageId === "verify") {
    assert.ok(verdict);
    return { debug: { verdict, iterations: iteration, manual_qa_log: `registered verification iteration ${iteration}` } };
  }
  if (stageId === "qa_tests") {
    return { qa_tests: { tests_added: ["packages/core/test/reliable-stage-loop.test.ts"], build_status: "n/a" } };
  }
  if (stageId === "summary") {
    return { summary: { built: [], decisions: ["registered reliable loop"], files_modified: [], pr_url: null } };
  }
  throw new Error(`unexpected debug-cycle stage '${stageId}'`);
}

async function rearmOrdinary(harness: Harness, suffix: string): Promise<Handoff> {
  const begun = await invoke(harness, "workflow_begin", `${suffix}-begin`, {});
  assert.equal(begun.ok, true, JSON.stringify(begun));
  const handoff = begun.handoff;
  assert.ok(handoff && typeof handoff === "object" && !Array.isArray(handoff), JSON.stringify(begun));
  return handoff as Handoff;
}

async function approveOrdinaryImplementation(harness: Harness, handoff: Handoff, suffix: string): Promise<void> {
  const askIdentity = debugAdvanceInput(handoff, "implementation result is ready for approval");
  delete askIdentity.profile_hash;
  delete askIdentity.evidence;
  const asked = await invoke(harness, "workflow_checkpoint_ask", `${suffix}-ask`, {
    ...askIdentity,
    checkpoint: "approve_fix",
    checkpoint_id: "approve_fix",
    checkpoint_kind: "implementation_approval",
  });
  assert.equal(asked.ok, true, JSON.stringify(asked));
  const actorProvenance = asked.actor_provenance;
  assert.ok(actorProvenance && typeof actorProvenance === "object", JSON.stringify(asked));
  const recordIdentity = debugAdvanceInput(handoff, "implementation result is ready for approval");
  delete recordIdentity.evidence;
  const recorded = await invoke(harness, "workflow_checkpoint", `${suffix}-record`, {
    ...recordIdentity,
    checkpoint: "approve_fix",
    checkpoint_id: "approve_fix",
    checkpoint_kind: "implementation_approval",
    authorization: "human",
    actor_provenance: actorProvenance,
    decision: asked.decision,
    rationale: "registered R16/R17 acceptance approval",
  });
  assert.equal(recorded.ok, true, JSON.stringify(recorded));
}

async function ordinaryDebugWorker(
  harness: Harness,
  handoff: Handoff,
  iteration: number,
  trace: string[],
  suffix: string,
  verdict?: "FAIL" | "PASS",
  approval = false,
): Promise<Handoff | undefined> {
  const stageId = handoff.stage_cursor;
  trace.push(stageId);
  const worker = await admitOrdinaryWorker(harness, handoff, `${suffix}-${stageId}-${iteration}-${trace.length}`);
  const priorFailure = stageId === "diagnose" && iteration > 1
    ? priorImmutableFailureEvidence(harness, handoff.run_key, iteration)
    : undefined;
  const submitted = await invoke(harness, "workflow_submit_result", `${suffix}-${stageId}-${iteration}-${trace.length}-submit`, submission(debugArtifact(stageId, iteration, verdict, priorFailure)), worker.childContext);
  assert.equal(submitted.ok, true, JSON.stringify(submitted));
  await terminalWorker(harness, worker);
  let advanced = await invoke(harness, "workflow_advance", `${suffix}-${stageId}-${iteration}-${trace.length}-advance`, debugAdvanceInput(handoff, `${stageId} iteration ${iteration} completed`));
  if (approval) {
    assert.equal(advanced.ok, false, JSON.stringify(advanced));
    await approveOrdinaryImplementation(harness, handoff, `${suffix}-${stageId}-${iteration}-${trace.length}`);
    advanced = await invoke(harness, "workflow_advance", `${suffix}-${stageId}-${iteration}-${trace.length}-approved-advance`, debugAdvanceInput(handoff, `${stageId} iteration ${iteration} approved`));
  }
  assert.equal(advanced.ok, true, JSON.stringify(advanced));
  if (advanced.handoff === undefined) return undefined;
  return rearmOrdinary(harness, `${suffix}-${stageId}-${iteration}-${trace.length}-next`);
}

async function ordinaryDebugRoot(
  harness: Harness,
  handoff: Handoff,
  iteration: number,
  trace: string[],
  suffix: string,
): Promise<Handoff | undefined> {
  const stageId = handoff.stage_cursor;
  trace.push(stageId);
  const submitted = await invoke(harness, "workflow_submit_result", `${suffix}-${stageId}-${iteration}-submit`, submission(debugArtifact(stageId, iteration)), harness.context);
  assert.equal(submitted.ok, true, JSON.stringify(submitted));
  const advanced = await invoke(harness, "workflow_advance", `${suffix}-${stageId}-${iteration}-advance`, debugAdvanceInput(handoff, `${stageId} iteration ${iteration} completed`));
  assert.equal(advanced.ok, true, JSON.stringify(advanced));
  if (advanced.handoff === undefined) return undefined;
  return rearmOrdinary(harness, `${suffix}-${stageId}-${iteration}-next`);
}

async function runRegisteredDebugOrdinary(verdicts: Array<"FAIL" | "PASS">, suffix: string): Promise<{ harness: Harness; runId: string; trace: string[] }> {
  const harness = ordinaryHarness({
    workflowProfiles: [DEBUG_PROFILE],
    roles: { diagnostics: "diagnostics", developer: "developer", "manual-qa": "manual-qa", qa: "qa" },
  });
  const trace: string[] = [];
  const entered = await ordinaryIngress(harness, {
    classification: DEBUG_CLASSIFICATION,
    files: ["packages/core/src/engine/reliable-stage.ts"],
    task: `registered ${suffix} debug cycle`,
    prepare_id: `${suffix}-prepare`,
    begin_id: `${suffix}-begin`,
  });
  let handoff = await ordinaryDebugRoot(harness, entered.handoff, 1, trace, `${suffix}-discovery`);
  assert.ok(handoff);
  for (let iteration = 1; iteration <= verdicts.length; iteration += 1) {
    handoff = await ordinaryDebugWorker(harness, handoff, iteration, trace, suffix);
    assert.ok(handoff);
    handoff = await ordinaryDebugWorker(harness, handoff, iteration, trace, suffix, undefined, true);
    assert.ok(handoff);
    handoff = await ordinaryDebugWorker(harness, handoff, iteration, trace, suffix, verdicts[iteration - 1]);
    if (verdicts[iteration - 1] === "FAIL") {
      if (iteration < verdicts.length) {
        assert.equal(handoff.stage_cursor, "diagnose");
        if (iteration === 1 && verdicts.length >= 3) {
          const failureEvidence = priorImmutableFailureEvidence(harness, entered.runId, iteration + 1);
          assert.ok(failureEvidence.length > 0, "the retry handoff must retain immutable prior FAIL evidence");
          handoff = await restartRegisteredRun(harness, entered.runId);
          assert.equal(handoff.stage_cursor, "diagnose");
          assert.equal(handoff.loop_iteration, iteration + 1);
          assert.equal(stateOf(harness, entered.runId).loop_state?.reentries, 1);
        }
        continue;
      }
      assert.equal(handoff, undefined);
      break;
    }
    assert.ok(handoff);
    handoff = await ordinaryDebugWorker(harness, handoff, iteration, trace, suffix);
    assert.ok(handoff);
    handoff = await ordinaryDebugRoot(harness, handoff, iteration, trace, `${suffix}-summary`);
    assert.equal(handoff, undefined);
  }
  return { harness, runId: entered.runId, trace };
}

scenarioTest("[O:R16] registered shipped debug-cycle FAIL then PASS executes the real two-iteration loop and downstream stages", async () => {
  const result = await runRegisteredDebugOrdinary(["FAIL", "PASS"], "o-r16d");
  try {
    assert.deepEqual(result.trace, ["discovery", "diagnose", "implementation", "verify", "diagnose", "implementation", "verify", "qa_tests", "summary"]);
    const state = stateOf(result.harness, result.runId);
    assert.equal(state.loop_state?.status, "complete");
    assert.equal(state.stages.find((stage) => stage.id === "qa_tests")?.status, "done");
  } finally {
    await result.harness.close();
  }
});

scenarioTest("[O:R17] registered shipped debug-cycle repeated FAIL exhausts at max_iterations and never dispatches downstream", async () => {
  const result = await runRegisteredDebugOrdinary(["FAIL", "FAIL", "FAIL"], "o-r17d");
  try {
    assert.deepEqual(result.trace, ["discovery", "diagnose", "implementation", "verify", "diagnose", "implementation", "verify", "diagnose", "implementation", "verify"]);
    const state = stateOf(result.harness, result.runId);
    assert.equal(state.loop_state?.status, "exhausted");
    assert.equal(state.loop_state?.reentries, 2);
    assert.equal(state.pause.kind, "needs_human");
    assert.equal(state.stages.find((stage) => stage.id === "qa_tests")?.status, "pending");
  } finally {
    await result.harness.close();
  }
});

function nativeStageId(harness: Harness, runId: string): string {
  const state = ctoStateSnapshot(runId, harness.root);
  assert.ok(state);
  const progress = state.native_stage_progress?.["team-a"];
  assert.ok(progress);
  return progress.stage_id;
}

function publishNativeDodFromDiscovery(harness: Harness, runId: string): void {
  const state = ctoStateSnapshot(runId, harness.root);
  assert.ok(state, "accepted discovery must leave canonical native state readable");
  assert.equal(state.branch, BRANCH, "discovery must observe the registered run branch");
  const receipt = Object.values(state.stage_receipts ?? {})
    .find((candidate) => candidate.work_identity.stage_id === "discovery");
  assert.ok(receipt, "accepted discovery receipt is required for DoD publication");
  const output = receipt.outputs.find((candidate) => candidate.artifact_id === "discovery");
  assert.ok(output, "accepted discovery receipt must carry the discovery output");
  const raw = JSON.parse(readFileSync(join(harness.root, ".work-state", "cto", runId, "artifacts", output.immutable_ref), "utf8")) as unknown;
  assert.ok(raw && typeof raw === "object" && !Array.isArray(raw));
  const discovery = raw;
  assert.ok(discovery && typeof discovery === "object" && !Array.isArray(discovery));
  assert.equal("branch" in discovery ? discovery.branch : undefined, state.branch);
  const declaredDoD = "declaredDoD" in discovery ? discovery.declaredDoD : undefined;
  assert.ok(declaredDoD && typeof declaredDoD === "object" && !Array.isArray(declaredDoD));
  writeFileSync(
    `${harness.root}/.work-state/artifacts/team-a/dod.json`,
    JSON.stringify({ ...declaredDoD, updated_at: new Date().toISOString() }) + "\n",
  );
}
function configureNativeRoster(harness: Harness): void {
  writeFileSync(join(harness.root, ".omp", "teams.json"), JSON.stringify([{
    id: "team-a",
    name: "Team A",
    scope: ["backend"],
    profile: DEBUG_PROFILE.name,
    lead: "team-lead",
    roster: ["diagnostics", "developer", "manual-qa", "qa"],
  }]) + "\n");
}

async function nativeAdvance(harness: Harness, suffix: string): Promise<ToolDetails> {
  const advanced = await invoke(harness, "cto_stage_advance", suffix, { slice_id: "slice-a" });
  assert.equal(advanced.ok, true, JSON.stringify(advanced));
  return advanced;
}

async function nativeCheckpoint(harness: Harness, suffix: string): Promise<void> {
  const asked = await invoke(harness, "cto_checkpoint_ask", suffix, { slice_id: "slice-a" });
  assert.equal(asked.ok, true, JSON.stringify(asked));
}
async function restartRegisteredNative(harness: Harness, runId: string, suffix: string): Promise<Harness> {
  const root = harness.root;
  await harness.emit("session_shutdown", {
    type: "session_shutdown",
    session_id: harness.context.session_id,
    session_file: harness.context.sessionFile,
  }, harness.context);
  const resumed = ctoHarness({
    root,
    sessionId: `${suffix}-resume`,
    workflowProfiles: [DEBUG_PROFILE],
    roles: { dev: "developer", diagnostics: "diagnostics", developer: "developer", "manual-qa": "manual-qa", qa: "qa", "team-lead": "team-lead" },
  });
  try {
    await resumed.emit("session_start", { type: "session_start" }, resumed.context);
    const command = resumed.commands.get("cto");
    assert.ok(command, "registered CTO command is required for native resume");
    await command.handler(`--run ${runId}`, resumed.context);
    const state = ctoStateSnapshot(runId, root);
    assert.ok(state, "registered CTO resume must leave canonical native state readable");
    return resumed;
  } catch (error) {
    await resumed.close();
    throw error;
  }
}


async function nativeDebugWorker(
  harness: Harness,
  runId: string,
  iteration: number,
  trace: string[],
  suffix: string,
  verdict?: "FAIL" | "PASS",
  approval = false,
): Promise<void> {
  const stageId = nativeStageId(harness, runId);
  trace.push(stageId);
  const lead = await admitCtoLead(harness, runId, `${suffix}-${stageId}-${iteration}`);
  const worker = await admitCtoWorker(harness, runId, lead, `${suffix}-${stageId}-${iteration}`, stageId === "diagnose" ? "diagnostics" : stageId === "verify" ? "manual-qa" : stageId === "qa_tests" ? "qa" : "developer");
  const priorFailure = stageId === "diagnose" && iteration > 1
    ? priorImmutableFailureEvidence(harness, runId, iteration, "native")
    : undefined;
  const submitted = await invoke(harness, "workflow_submit_result", `${suffix}-${stageId}-${iteration}-submit`, submission(debugArtifact(stageId, iteration, verdict, priorFailure)), worker.childContext);
  assert.equal(submitted.ok, true, JSON.stringify(submitted));
  await terminalWorker(harness, worker);
  if (approval) await nativeCheckpoint(harness, `${suffix}-${stageId}-${iteration}-checkpoint`);
  await nativeAdvance(harness, `${suffix}-${stageId}-${iteration}-advance`);
  await terminalWorker(harness, lead);
}

async function nativeDebugRoot(harness: Harness, runId: string, trace: string[], suffix: string): Promise<void> {
  const lead = await admitCtoLead(harness, runId, suffix);
  const stageId = nativeStageId(harness, runId);
  trace.push(stageId);
  const submitted = await invoke(harness, "workflow_submit_result", `${suffix}-${stageId}-submit`, submission(debugArtifact(stageId, 1)), lead.childContext);
  assert.equal(submitted.ok, true, JSON.stringify(submitted));
  if (stageId === "discovery") publishNativeDodFromDiscovery(harness, runId);
  await nativeAdvance(harness, `${suffix}-${stageId}-advance`);
  await terminalWorker(harness, lead);
}

async function closeNativeHarnesses(harnesses: Harness[]): Promise<void> {
  for (const harness of [...harnesses].reverse()) await harness.close();
}

async function runRegisteredDebugNative(verdicts: Array<"FAIL" | "PASS">, suffix: string): Promise<{ harness: Harness; cleanupHarnesses: Harness[]; runId: string; trace: string[] }> {
  let harness = ctoHarness({
    workflowProfiles: [DEBUG_PROFILE],
    roles: { dev: "developer", diagnostics: "diagnostics", developer: "developer", "manual-qa": "manual-qa", qa: "qa", "team-lead": "team-lead" },
  });
  const trace: string[] = [];
  const cleanupHarnesses: Harness[] = [harness];
  try {
    configureNativeRoster(harness);
    const entered = await ctoIngress(harness, { profile: DEBUG_PROFILE.name, classification: DEBUG_CLASSIFICATION });
    await nativeDebugRoot(harness, entered.runId, trace, `${suffix}-discovery`);
    for (let iteration = 1; iteration <= verdicts.length; iteration += 1) {
      await nativeDebugWorker(harness, entered.runId, iteration, trace, suffix);
      await nativeDebugWorker(harness, entered.runId, iteration, trace, suffix, undefined, true);
      await nativeDebugWorker(harness, entered.runId, iteration, trace, suffix, verdicts[iteration - 1]);
      if (verdicts[iteration - 1] === "FAIL") {
        if (iteration < verdicts.length) {
          if (iteration === 1 && verdicts.length >= 3) {
            const failureEvidence = priorImmutableFailureSnapshot(harness, entered.runId, iteration + 1, "native");
            assert.ok(failureEvidence.evidence.length > 0, "native retry handoff must retain immutable prior FAIL evidence");
            const resumedHarness = await restartRegisteredNative(harness, entered.runId, `${suffix}-restart`);
            cleanupHarnesses.push(resumedHarness);
            harness = resumedHarness;
            const restoredEvidence = priorImmutableFailureSnapshot(harness, entered.runId, iteration + 1, "native");
            assert.equal(restoredEvidence.immutable_ref, failureEvidence.immutable_ref, "native resume must preserve the prior FAIL receipt reference");
            assert.deepEqual(restoredEvidence.bytes, failureEvidence.bytes, "native resume must preserve immutable prior FAIL bytes");
            assert.equal(restoredEvidence.evidence, failureEvidence.evidence, "native resume must preserve prior FAIL evidence");
            assert.equal(nativeStageId(harness, entered.runId), "diagnose");
            assert.equal(ctoStateSnapshot(entered.runId, harness.root)?.native_stage_progress?.["team-a"]?.iteration, iteration + 1);
          }
          continue;
        }
        break;
      }
      await nativeDebugWorker(harness, entered.runId, iteration, trace, suffix);
      await nativeDebugRoot(harness, entered.runId, trace, `${suffix}-summary`);
      break;
    }
    return { harness, cleanupHarnesses, runId: entered.runId, trace };
  } catch (error) {
    await closeNativeHarnesses(cleanupHarnesses);
    throw error;
  }
}

scenarioTest("[C:R16] registered shipped debug-cycle native FAIL then PASS executes the real two-iteration loop", async () => {
  const result = await runRegisteredDebugNative(["FAIL", "PASS"], "c-r16d");
  try {
    assert.deepEqual(result.trace, ["discovery", "diagnose", "implementation", "verify", "diagnose", "implementation", "verify", "qa_tests", "summary"]);
  } finally {
    await closeNativeHarnesses(result.cleanupHarnesses);
  }
});

scenarioTest("[C:R17] registered shipped debug-cycle native repeated FAIL exhausts and never dispatches downstream", async () => {
  const result = await runRegisteredDebugNative(["FAIL", "FAIL", "FAIL"], "c-r17d");
  try {
    assert.deepEqual(result.trace, ["discovery", "diagnose", "implementation", "verify", "diagnose", "implementation", "verify", "diagnose", "implementation", "verify"]);
    const native = ctoStateSnapshot(result.runId, result.harness.root);
    assert.ok(native);
    const progress = native.native_stage_progress?.["team-a"];
    const verifyLoop = DEBUG_PROFILE.stages.find((stage) => stage.id === "verify")?.loop;
    assert.ok(progress);
    assert.ok(verifyLoop);
    assert.equal(progress.stage_id, "verify");
    assert.equal(progress.iteration, verifyLoop.max_iterations);
    assert.equal(progress.status, "complete");
    assert.equal(native.pause?.kind, "needs_human");
    const assignmentsBefore = Object.keys(progress.assignments).sort();
    await assert.rejects(() => admitCtoLead(result.harness, result.runId, "c-r17d-fourth"));
    const afterAttempt = ctoStateSnapshot(result.runId, result.harness.root);
    assert.ok(afterAttempt);
    assert.deepEqual(Object.keys(afterAttempt.native_stage_progress?.["team-a"]?.assignments ?? {}).sort(), assignmentsBefore);
    assert.equal(afterAttempt.native_stage_progress?.["team-a"]?.stage_id, "verify");
  } finally {
    await closeNativeHarnesses(result.cleanupHarnesses);
  }
});
