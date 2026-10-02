import assert from "node:assert/strict";
import fs, { type PathLike } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
import { recordScenarioEvent, scenarioTest } from "./reliable-stage-trace.js";
import {
  BRANCH,
  CLASSIFICATION,
  CTO_CLASSIFICATION,
  admitOrdinaryBatchWorkers,
  admitCtoLead,
  admitCtoWorker,
  admitOrdinaryWorker,
  askCtoCheckpoint,
  ctoHarness,
  ctoIngress,
  ctoStateSnapshot,
  details,
  implementationOutput as fixtureImplementationOutput,
  ordinaryHarness,
  ordinaryIngress,
  RELIABLE_PROFILE,
  requireTool,
  submission,
  terminalOrdinaryBatchWorkers,
  terminalWorker,
  type Harness,
  type Handoff,
  type ToolDetails,
  type WorkerFixture,
} from "./reliable-stage-execution-fixture.js";
import { readRunState, runTarget } from "../src/engine/run-store.js";
import type { Profile } from "../src/index.js";

/**
 * These profiles deliberately use the real profile control plane.  The first
 * stage is coordinator-owned discovery so native CTO tests exercise the
 * lead-owned discovery -> ROOT checkpoint -> native advance -> worker route;
 * no native state is installed by a test.
 */
const checkpointPolicy = RELIABLE_PROFILE.checkpoint_policy!;
const checkpointRules = checkpointPolicy.rules;

type CheckpointRuleInput = {
  kind: string;
  default: "required_human" | "autonomous_allowed";
  allowed_decisions: string[];
  phase: "before_advance";
  rationale: string;
};

function policyWith(...rules: Array<[string, CheckpointRuleInput]>): NonNullable<Profile["checkpoint_policy"]> {
  const typedRules = Object.fromEntries(rules) as NonNullable<Profile["checkpoint_policy"]>["rules"];
  return {
    ...checkpointPolicy,
    rules: {
      ...checkpointRules,
      ...typedRules,
    },
  };
}


const DISCOVERY_APPROVAL = {
  kind: "implementation_approval" as const,
  default: "required_human" as const,
  allowed_decisions: ["proceed", "reject"],
  phase: "before_advance" as const,
  rationale: "Discovery handoff requires explicit acceptance before worker dispatch.",
};
const IMPLEMENTATION_APPROVAL = {
  kind: "implementation_approval" as const,
  default: "required_human" as const,
  allowed_decisions: ["proceed", "reject"],
  phase: "before_advance" as const,
  rationale: "Implementation output requires explicit acceptance before progression.",
};
const AUTO_IMPLEMENTATION_APPROVAL = {
  kind: "implementation_approval" as const,
  default: "autonomous_allowed" as const,
  allowed_decisions: ["proceed", "reject"],
  phase: "before_advance" as const,
  rationale: "This profile explicitly permits policy-auto implementation progression.",
};
const REVIEW_FIX_APPROVAL = {
  kind: "review_fix" as const,
  default: "required_human" as const,
  allowed_decisions: ["proceed", "reject"],
  phase: "before_advance" as const,
  rationale: "Requested review changes require explicit approval of the fix.",
};

function profile(name: string, stages: Profile["stages"], rules: Array<[string, CheckpointRuleInput]> = []): Profile {
  return {
    name,
    title: `Registered ${name}`,
    description: "Acceptance profile exercised through the registered workflow and native CTO APIs.",
    match: { type: ["FEATURE"], complexity: ["QUICK"] },
    checkpoint_policy: policyWith(...rules),
    stages,
  };
}

const GATED_PROFILE = profile(
  "reliable-gates-registered",
  [
    { id: "discovery", title: "Discovery", type: "orchestrator", produces: ["discovery", "dod"], checkpoint: "approve_discovery" },
    { id: "implementation", title: "Implementation", type: "single", role: "dev", consumes: ["discovery"], produces: "implementation", checkpoint: "approve_implementation" },
    { id: "next", title: "Next", type: "single", role: "dev", consumes: ["implementation"], produces: "next" },
  ],
  [["approve_discovery", DISCOVERY_APPROVAL], ["approve_implementation", IMPLEMENTATION_APPROVAL]],
);

const FANIN_PROFILE = profile(
  "reliable-gates-fanin",
  [
    { id: "discovery", title: "Discovery", type: "orchestrator", produces: ["discovery", "dod"], checkpoint: "approve_discovery" },
    { id: "implementation", title: "Parallel implementation", type: "consilium", roles: ["dev_a", "dev_b"], parallel: true, consumes: ["discovery"], produces: "implementation" },
    { id: "next", title: "Next", type: "single", role: "dev", consumes: ["implementation"], produces: "next" },
  ],
  [["approve_discovery", DISCOVERY_APPROVAL], ["approve_implementation", IMPLEMENTATION_APPROVAL]],
);

const MISSING_OUTPUT_PROFILE = profile(
  "reliable-gates-missing-output",
  [
    { id: "discovery", title: "Discovery", type: "orchestrator", produces: ["discovery", "dod"], checkpoint: "approve_discovery" },
    { id: "implementation", title: "Incomplete implementation", type: "single", role: "dev", consumes: ["discovery"], produces: ["implementation", "required_evidence"] },
    { id: "next", title: "Next", type: "single", role: "dev", consumes: ["implementation", "required_evidence"], produces: "next" },
  ],
  [["approve_discovery", DISCOVERY_APPROVAL]],
);

const LOOP_PROFILE = profile(
  "reliable-gates-loop",
  [
    { id: "discovery", title: "Discovery", type: "orchestrator", produces: ["discovery", "dod"], checkpoint: "approve_discovery" },
    { id: "implementation", title: "Implementation", type: "single", role: "dev", consumes: ["discovery"], produces: "implementation", checkpoint: "approve_implementation" },
    { id: "verify", title: "Verify", type: "single", role: "dev", consumes: ["implementation"], produces: "debug", loop: { back_to: "implementation", until: "verdict == PASS", max_iterations: 2, on_exhausted: "escalate_user" } },
    { id: "next", title: "Next", type: "single", role: "dev", consumes: ["debug"], produces: "next", gate: "verdict == PASS" },
  ],
  [["approve_discovery", DISCOVERY_APPROVAL], ["approve_implementation", IMPLEMENTATION_APPROVAL]],
);

const AUTO_PROFILE = profile(
  "reliable-gates-policy-auto",
  [
    { id: "discovery", title: "Discovery", type: "orchestrator", produces: ["discovery", "dod"], checkpoint: "approve_discovery" },
    { id: "implementation", title: "Policy-auto implementation", type: "single", role: "dev", consumes: ["discovery"], produces: "implementation", checkpoint: "approve_implementation" },
    { id: "next", title: "Next", type: "single", role: "dev", consumes: ["implementation"], produces: "next" },
  ],
  [["approve_discovery", DISCOVERY_APPROVAL], ["approve_implementation", AUTO_IMPLEMENTATION_APPROVAL]],
);

const REVIEW_CHANGE_PROFILE = profile(
  "reliable-gates-review-changes",
  [
    { id: "discovery", title: "Discovery", type: "orchestrator", produces: ["discovery", "dod"], checkpoint: "approve_discovery" },
    { id: "implementation", title: "Implementation", type: "single", role: "dev", consumes: ["discovery"], produces: "implementation" },
    { id: "review_initial", title: "Initial review", type: "single", role: "dev", consumes: ["implementation"], produces: "review_initial" },
    { id: "fix", title: "Requested fixes", type: "single", role: "dev", consumes: ["review_initial"], produces: "implementation_fix", checkpoint: "approve_fix" },
    { id: "review_repeat", title: "Follow-up review", type: "single", role: "dev", consumes: ["implementation", "implementation_fix"], produces: "review_repeat", loop: { back_to: "fix", until: "verdict == approve", max_iterations: 2, on_exhausted: "escalate_user" } },
    { id: "next", title: "Next", type: "single", role: "dev", consumes: ["review_repeat"], produces: "next", gate: "verdict == approve" },
  ],
  [["approve_discovery", DISCOVERY_APPROVAL], ["approve_fix", REVIEW_FIX_APPROVAL]],
);

const ROLE_OPTIONS = {
  dev: "developer",
  dev_a: "developer-a",
  dev_b: "developer-b",
  "team-lead": "team-lead",
};
const SCOPE_MAP = [{ glob: ["**/*"], scope: "default", dev_agent: "developer" }];

type Route = "ordinary" | "cto";
type RouteSetup = {
  route: Route;
  harness: Harness;
  runId: string;
  profile: Profile;
  handoff?: Handoff;
  lead?: WorkerFixture;
  worker?: WorkerFixture;
  batchWorkers?: WorkerFixture[];
};
type DynamicRecord = Record<string, unknown>;
type PublicationFaultArm = {
  didInject: () => boolean;
  clear: () => void;
};

function targetDispatchId(setup: RouteSetup): string {
  assert.ok(setup.worker);
  if (setup.route === "ordinary") {
    const current = state(setup.harness, setup.runId);
    const capability = current.dispatch_capability;
    assert.ok(capability && typeof capability === "object" && !Array.isArray(capability));
    const dispatches = (capability as DynamicRecord).dispatches;
    assert.ok(Array.isArray(dispatches));
    const match = dispatches.find((entry) => {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) return false;
      return (entry as DynamicRecord).tool_call_id === setup.worker!.toolCallId;
    });
    assert.ok(match && typeof match === "object" && !Array.isArray(match));
    const id = (match as DynamicRecord).id;
    assert.equal(typeof id, "string");
    return id;
  }
  const assignments = nativeProgress(setup.harness, setup.runId).assignments;
  assert.ok(assignments && typeof assignments === "object" && !Array.isArray(assignments));
  const match = Object.values(assignments as DynamicRecord).find((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return false;
    const candidate = entry as DynamicRecord;
    return candidate.agent === setup.worker!.input.agent
      && (candidate.status === "running" || candidate.status === "reserved");
  });
  assert.ok(match && typeof match === "object" && !Array.isArray(match));
  const identity = (match as DynamicRecord).identity;
  assert.ok(identity && typeof identity === "object" && !Array.isArray(identity));
  const id = (identity as DynamicRecord).dispatch_id;
  assert.equal(typeof id, "string");
  return id;
}

function armPublicationFault(route: Route, runId: string, dispatchId: string): PublicationFaultArm {
  let injected = false;
  const fault = () => {
    injected = true;
    recordScenarioEvent({ kind: "fault_injected", route: route === "ordinary" ? "O" : "C", faultPoint: "publication", outcome: "REJECTED" });
    throw new Error("registered publication fault at the canonical commit boundary");
  };
  const hasTargetReceipt = (value: unknown): boolean => {
    if (typeof value !== "string") return false;
    return value.includes("stage_receipts") && value.includes(dispatchId);
  };
  const originalRename = fs.renameSync;
  fs.renameSync = ((source: PathLike, destination: PathLike): void => {
    const sourcePath = String(source);
    const destinationPath = String(destination);
    try {
      const raw = fs.readFileSync(sourcePath, "utf8");
      if (destinationPath.includes(".work-state/lifecycle-transactions") && destinationPath.endsWith("/transaction.json")) {
        const candidate = JSON.parse(raw) as DynamicRecord;
        const after = candidate.after;
        const matchesTarget = candidate.operation === "resume"
          && candidate.status === "committing"
          && after !== null
          && typeof after === "object"
          && Object.entries(after as DynamicRecord).some(([path, value]) => path.includes(runId) && hasTargetReceipt(value));
        if (matchesTarget) {
          originalRename(source, destination);
          fault();
          return;
        }
      }
    } catch {
      // The interception only observes the matched transaction; unrelated
      // temporary renames continue through the real filesystem primitive.
    }
    originalRename(source, destination);
  }) as typeof fs.renameSync;
  syncBuiltinESMExports();
  return {
    didInject: () => injected,
    clear: () => {
      fs.renameSync = originalRename;
      syncBuiltinESMExports();
    },
  };
}

type ImmutableArtifactSnapshot = {
  reference: string;
  sha256: string;
  path: string;
  bytes: Buffer;
};

function immutableArtifactSnapshot(setup: RouteSetup, receiptValue: unknown, artifactId: string): ImmutableArtifactSnapshot {
  const receipt = record(receiptValue);
  const outputs = receipt.outputs;
  assert.ok(Array.isArray(outputs), JSON.stringify(receipt));
  const output = outputs.find((entry) => {
    const candidate = entry && typeof entry === "object" && !Array.isArray(entry) ? entry as DynamicRecord : undefined;
    return candidate?.artifact_id === artifactId;
  });
  assert.ok(output && typeof output === "object" && !Array.isArray(output), JSON.stringify(receipt));
  const row = output as DynamicRecord;
  assert.equal(typeof row.immutable_ref, "string");
  assert.equal(typeof row.sha256, "string");
  const artifactsDir = setup.route === "ordinary"
    ? runTarget(setup.harness.root, setup.runId).artifactsDir
    : join(setup.harness.root, ".work-state", "cto", setup.runId, "artifacts");
  assert.ok(artifactsDir);
  const path = join(artifactsDir, row.immutable_ref as string);
  return {
    reference: row.immutable_ref as string,
    sha256: row.sha256 as string,
    path,
    bytes: fs.readFileSync(path),
  };
}

function record(value: unknown): DynamicRecord {
  return details(value);
}

function state(harness: Harness, runId: string): DynamicRecord {
  const current = readRunState(harness.root, runId);
  assert.ok(current, "ordinary canonical state must remain readable");
  return current as unknown as DynamicRecord;
}

function nativeState(harness: Harness, runId: string): DynamicRecord {
  const current = ctoStateSnapshot(runId, harness.root);
  assert.ok(current, "native canonical state must remain readable");
  return current as unknown as DynamicRecord;
}

function nativeProgress(harness: Harness, runId: string): DynamicRecord {
  const current = nativeState(harness, runId);
  const progressMap = record(current.native_stage_progress);
  const teamId = Object.keys(progressMap)[0];
  assert.ok(teamId, "native stage progress must identify the active team");
  return record(progressMap[teamId]);
}

function receipts(value: DynamicRecord): DynamicRecord {
  return record(value.stage_receipts ?? {});
}
function stageReceipts(value: DynamicRecord, stageId: string): DynamicRecord {
  const all = receipts(value);
  return Object.fromEntries(Object.entries(all).filter(([, entry]) => {
    const identity = entry && typeof entry === "object" && !Array.isArray(entry)
      ? (entry as DynamicRecord).work_identity
      : undefined;
    return identity && typeof identity === "object" && !Array.isArray(identity) && (identity as DynamicRecord).stage_id === stageId;
  }));
}

function ordinaryBinding(handoff: Handoff, profileName: string): DynamicRecord {
  const profileHash = handoff.profile_hash;
  assert.equal(typeof profileHash, "string", "registered handoff must carry its profile hash");
  return {
    token: handoff.advance_token,
    capability_id: handoff.capability_id,
    run_key: handoff.run_key,
    branch: typeof handoff.branch === "string" ? handoff.branch : BRANCH,
    workflow: typeof handoff.workflow === "string" ? handoff.workflow : profileName,
    profile_hash: profileHash,
    stage_cursor: handoff.stage_cursor,
    cursor_epoch: handoff.cursor_epoch,
    loop_iteration: handoff.loop_iteration,
    evidence: "registered stage result and terminal worker evidence",
  };
}

async function ordinaryAdvance(harness: Harness, handoff: Handoff, profileName: string, callId: string): Promise<ToolDetails> {
  return record((await requireTool(harness, "workflow_advance").execute(callId, ordinaryBinding(handoff, profileName), undefined, undefined, harness.context)).details);
}
async function ordinaryBegin(harness: Harness, callId: string): Promise<ToolDetails> {
  return record((await requireTool(harness, "workflow_begin").execute(callId, {}, undefined, undefined, harness.context)).details);
}

async function readOrdinaryInstructions(harness: Harness, callId: string): Promise<ToolDetails> {
  return record((await requireTool(harness, "workflow_instructions").execute(callId, {}, undefined, undefined, harness.context)).details);
}

function checkpointBinding(handoff: Handoff, profileName: string, checkpoint: string): DynamicRecord {
  const profileHash = handoff.profile_hash;
  assert.equal(typeof profileHash, "string", "checkpoint handoff must carry its profile hash");
  return {
    token: handoff.advance_token,
    capability_id: handoff.capability_id,
    run_key: handoff.run_key,
    branch: typeof handoff.branch === "string" ? handoff.branch : BRANCH,
    workflow: typeof handoff.workflow === "string" ? handoff.workflow : profileName,
    profile_hash: profileHash,
    stage_cursor: handoff.stage_cursor,
    cursor_epoch: handoff.cursor_epoch,
    checkpoint,
    checkpoint_id: checkpoint,
    checkpoint_kind: checkpoint === "approve_fix" ? "review_fix" : "implementation_approval",
    loop_iteration: handoff.loop_iteration,
  };
}

async function approveOrdinary(harness: Harness, handoff: Handoff, profileName: string, checkpoint: string, callId: string, authorization: "human" | "policy_auto" = "human"): Promise<ToolDetails> {
  const binding = checkpointBinding(handoff, profileName, checkpoint);
  if (authorization === "policy_auto") {
    return record((await requireTool(harness, "workflow_checkpoint").execute(`${callId}-record`, {
      ...binding,
      authorization,
      actor_provenance: { kind: "system", ref: "registered-policy-auto" },
      decision: "proceed",
      rationale: "The registered profile explicitly permits policy-auto for this checkpoint.",
    }, undefined, undefined, harness.context)).details);
  }
  const { profile_hash: _profileHash, ...askBinding } = binding;
  void _profileHash;
  const asked = record((await requireTool(harness, "workflow_checkpoint_ask").execute(`${callId}-ask`, askBinding, undefined, undefined, harness.context)).details);
  assert.equal(asked.ok, true, JSON.stringify(asked));
  const actor = asked.actor_provenance;
  assert.ok(actor && typeof actor === "object", "human checkpoint ask must return actor provenance");
  return record((await requireTool(harness, "workflow_checkpoint").execute(`${callId}-record`, {
    ...binding,
    authorization,
    actor_provenance: actor,
    decision: "proceed",
    rationale: "Registered acceptance approval.",
  }, undefined, undefined, harness.context)).details);
}

async function submitAt(harness: Harness, context: unknown, callId: string, outputs: DynamicRecord): Promise<ToolDetails> {
  return record((await requireTool(harness, "workflow_submit_result").execute(callId, submission(outputs), undefined, undefined, context)).details);
}
function implementationOutput(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return fixtureImplementationOutput({
    ready: true,
    validation_run: true,
    validation_evidence: "registered acceptance fixture validation output",
    ...overrides,
  });
}
function initialDiscoveryOutputs(suffix: string): DynamicRecord {
  return {
    discovery: {
      task: `registered discovery ${suffix}`,
      branch: BRANCH,
      constraints: [],
    },
    dod: {
      items: [{
        id: `discovery-${suffix}-1`,
        source: "discovery",
        criterion: `The registered ${suffix} route reaches its next stage.`,
        verify_method: "registered acceptance submission",
        status: "pending",
        evidence: "",
      }],
      type_requirements_met: false,
      updated_at: new Date().toISOString(),
    },
  };
}

async function nativeAdvance(harness: Harness, callId: string): Promise<ToolDetails> {
  return record((await requireTool(harness, "cto_stage_advance").execute(callId, { slice_id: "slice-a" }, undefined, undefined, harness.context)).details);
}

async function prepareOrdinary(profileValue: Profile, suffix: string): Promise<RouteSetup> {
  const harness = ordinaryHarness({ workflowProfiles: [profileValue], roles: ROLE_OPTIONS, scopeMap: SCOPE_MAP });
  const ingress = await ordinaryIngress(harness, {
    prepare_id: `gates-${suffix}-prepare`,
    begin_id: `gates-${suffix}-begin`,
    classification: { ...CLASSIFICATION, workflow: profileValue.name },
  });
  const first = ingress.handoff;
  const discovery = await submitAt(harness, harness.context, `gates-${suffix}-discovery`, initialDiscoveryOutputs(suffix));
  assert.equal(discovery.ok, true, JSON.stringify(discovery));
  const approved = await approveOrdinary(harness, first, profileValue.name, "approve_discovery", `gates-${suffix}-discovery-approval`);
  assert.equal(approved.ok, true, JSON.stringify(approved));
  const advanced = await ordinaryAdvance(harness, first, profileValue.name, `gates-${suffix}-discovery-advance`);
  assert.equal(advanced.ok, true, JSON.stringify(advanced));
  const advancedHandoff = record(advanced.handoff) as unknown as Handoff;
  const beforeBegin = await readOrdinaryInstructions(harness, `gates-${suffix}-implementation-instructions`);
  assert.equal(record(beforeBegin.stage).id, advancedHandoff.stage_cursor, JSON.stringify(beforeBegin));
  const begun = await ordinaryBegin(harness, `gates-${suffix}-implementation-begin`);
  assert.equal(begun.ok, true, JSON.stringify(begun));
  const handoff = record(begun.handoff) as unknown as Handoff;
  assert.ok(handoff.stage_cursor === "implementation" || handoff.stage_cursor === "review_initial", JSON.stringify(handoff));
  const afterBegin = await readOrdinaryInstructions(harness, `gates-${suffix}-implementation-contract`);
  const afterBeginState = record(afterBegin.state);
  assert.ok(afterBeginState.input_read_receipt && typeof afterBeginState.input_read_receipt === "object", JSON.stringify(afterBegin));
  const currentStage = profileValue.stages.find((stage) => stage.id === handoff.stage_cursor);
  if (currentStage?.type === "consilium") {
    const batchWorkers = await admitOrdinaryBatchWorkers(harness, handoff, `${suffix}-batch`);
    const worker = batchWorkers[0];
    assert.ok(worker);
    return { route: "ordinary", harness, runId: ingress.runId, profile: profileValue, handoff, worker, batchWorkers };
  }
  const worker = await admitOrdinaryWorker(harness, handoff, `${suffix}-worker`);
  return { route: "ordinary", harness, runId: ingress.runId, profile: profileValue, handoff, worker };
}

async function prepareNative(profileValue: Profile, suffix: string): Promise<RouteSetup> {
  const nativeProfile: Profile = { ...profileValue, name: "lightweight" };
  const harness = ctoHarness({ workflowProfiles: [nativeProfile], roles: ROLE_OPTIONS, scopeMap: SCOPE_MAP });
  const ingress = await ctoIngress(harness, { profile: "lightweight", classification: CTO_CLASSIFICATION });
  const lead = await admitCtoLead(harness, ingress.runId, `${suffix}-lead`);
  const discovery = await submitAt(harness, lead.childContext, `gates-${suffix}-discovery`, initialDiscoveryOutputs(suffix));
  assert.equal(discovery.ok, true, JSON.stringify(discovery));
  const asked = await askCtoCheckpoint(harness, "slice-a", `gates-${suffix}-discovery-approval`);
  assert.equal(asked.ok, true, JSON.stringify(asked));
  const advanced = await nativeAdvance(harness, `gates-${suffix}-discovery-advance`);
  assert.equal(advanced.ok, true, JSON.stringify(advanced));
  const firstAgent = nativeProfile.stages.find((stage) => stage.id === "implementation")?.type === "consilium" ? "developer-a" : "developer";
  const worker = await admitCtoWorker(harness, ingress.runId, lead, `${suffix}-worker`, firstAgent);
  return { route: "cto", harness, runId: ingress.runId, profile: nativeProfile, lead, worker };
}

async function prepare(route: Route, profileValue: Profile, suffix: string): Promise<RouteSetup> {
  return route === "ordinary" ? prepareOrdinary(profileValue, suffix) : prepareNative(profileValue, suffix);
}

async function finishWorker(setup: RouteSetup, outputs: DynamicRecord): Promise<ToolDetails> {
  assert.ok(setup.worker, "route setup must have a worker");
  const receipt = await submitAt(setup.harness, setup.worker.childContext, `${setup.route}-${setup.runId}-submit-${setup.worker.toolCallId}`, outputs);
  await terminalWorker(setup.harness, setup.worker);
  return receipt;
}

async function approveCurrent(setup: RouteSetup, checkpoint: string, callId: string, authorization: "human" | "policy_auto" = "human"): Promise<ToolDetails> {
  if (setup.route === "ordinary") {
    assert.ok(setup.handoff);
    return approveOrdinary(setup.harness, setup.handoff, setup.profile.name, checkpoint, callId, authorization);
  }
  return askCtoCheckpoint(setup.harness, "slice-a", callId);
}

async function advanceCurrent(setup: RouteSetup, callId: string): Promise<ToolDetails> {
  if (setup.route === "ordinary") {
    assert.ok(setup.handoff);
    return ordinaryAdvance(setup.harness, setup.handoff, setup.profile.name, callId);
  }
  return nativeAdvance(setup.harness, callId);
}
async function beginOrdinaryStage(harness: Harness, handoff: Handoff, callId: string): Promise<Handoff> {
  const before = await readOrdinaryInstructions(harness, `${callId}-instructions`);
  assert.equal(record(before.stage).id, handoff.stage_cursor, JSON.stringify(before));
  const begun = await ordinaryBegin(harness, `${callId}-begin`);
  assert.equal(begun.ok, true, JSON.stringify(begun));
  const next = record(begun.handoff) as unknown as Handoff;
  const after = await readOrdinaryInstructions(harness, `${callId}-contract`);
  const afterState = record(after.state);
  const requiredInputs = afterState.required_inputs;
  if (Array.isArray(requiredInputs) && requiredInputs.length > 0) {
    assert.ok(afterState.input_read_receipt && typeof afterState.input_read_receipt === "object", JSON.stringify(after));
  }
  return next;
}


function reviewOutput(verdict: "approve" | "needs_changes" | "reject", title: string): DynamicRecord {
  return { verdict, findings: [{ title, severity: "medium", confidence: 0.9, zone: "implementation" }] };
}

function debugOutput(verdict: "PASS" | "FAIL"): DynamicRecord {
  return { verdict, iterations: 1 };
}


for (const route of ["ordinary", "cto"] as const) {
  scenarioTest(`[${route === "ordinary" ? "O" : "C"}:S05] assigned fan-in slots remain independent and missing slot blocks progression`, async () => {
    const setup = await prepare(route, FANIN_PROFILE, `s05-${route}`);
    try {
      assert.ok(setup.worker);
      const first = setup.worker;
      const firstReceipt = await submitAt(setup.harness, first.childContext, `${route}-s05-first`, { implementation: implementationOutput({ slot: "first" }) });
      assert.equal(firstReceipt.ok, true, JSON.stringify(firstReceipt));
      if (route === "cto") {
        await terminalWorker(setup.harness, first);
      }
      const before = route === "ordinary" ? state(setup.harness, setup.runId).stage_cursor : nativeProgress(setup.harness, setup.runId).stage_id;
      const pending = await advanceCurrent(setup, `${route}-s05-pending`);
      assert.equal(pending.ok, false, JSON.stringify(pending));
      const afterPending = route === "ordinary" ? state(setup.harness, setup.runId).stage_cursor : nativeProgress(setup.harness, setup.runId).stage_id;
      assert.equal(afterPending, before, "missing fan-in must preserve the active cursor");

      if (route === "ordinary") {
        assert.ok(setup.batchWorkers);
        const second = setup.batchWorkers[1];
        assert.ok(second);
        const secondReceipt = await submitAt(setup.harness, second.childContext, "ordinary-s05-second", { implementation: implementationOutput({ slot: "second" }) });
        assert.equal(secondReceipt.ok, true, JSON.stringify(secondReceipt));
        await terminalOrdinaryBatchWorkers(setup.harness, setup.batchWorkers);
      } else {
        assert.ok(setup.lead);
        const native = nativeProgress(setup.harness, setup.runId);
        assert.ok(Array.isArray(native.declared_slots), JSON.stringify(native));
        const usedSlotIds = new Set(Object.values(record(native.assignments)).map((entry) => record(entry).slot_id).filter((slotId): slotId is string => typeof slotId === "string"));
        const secondSlot = native.declared_slots
          .map((entry) => record(entry))
          .find((entry) => typeof entry.slot_id === "string" && typeof entry.agent === "string" && !usedSlotIds.has(entry.slot_id));
        assert.ok(secondSlot, JSON.stringify(native));
        const second = await admitCtoWorker(setup.harness, setup.runId, setup.lead, "s05-second-worker", secondSlot.agent as string);
        const secondReceipt = await submitAt(setup.harness, second.childContext, "cto-s05-second", { implementation: implementationOutput({ slot: "second" }) });
        assert.equal(secondReceipt.ok, true, JSON.stringify(secondReceipt));
        await terminalWorker(setup.harness, second);
      }
      const progress = route === "ordinary" ? state(setup.harness, setup.runId) : nativeState(setup.harness, setup.runId);
      const acceptedSlots = Object.values(stageReceipts(progress, "implementation")).map(record);
      assert.equal(acceptedSlots.length, 2, "both assigned slots must retain an accepted receipt");
      assert.notEqual(record(acceptedSlots[0].work_identity).slot_id, record(acceptedSlots[1].work_identity).slot_id);
      const outputRefs = acceptedSlots.map((receipt) => {
        assert.ok(Array.isArray(receipt.outputs));
        return record(receipt.outputs[0]).immutable_ref;
      });
      assert.notEqual(outputRefs[0], outputRefs[1], "independent slots must not overwrite the same immutable output");
      const advanced = await advanceCurrent(setup, `${route}-s05-complete`);
      assert.equal(advanced.ok, true, JSON.stringify(advanced));
      const after = route === "ordinary" ? state(setup.harness, setup.runId).stage_cursor : nativeProgress(setup.harness, setup.runId).stage_id;
      assert.notEqual(after, "implementation", "complete fan-in must advance beyond the blocked stage");
    } finally {
      await setup.harness.close();
    }
  });

  scenarioTest(`[${route === "ordinary" ? "O" : "C"}:S06] accepted submission replay returns one immutable receipt`, async () => {
    const setup = await prepare(route, GATED_PROFILE, `s06-${route}`);
    try {
      assert.ok(setup.worker);
      const first = await submitAt(setup.harness, setup.worker.childContext, `${route}-s06-first`, { implementation: implementationOutput({ summary: "same" }) });
      assert.equal(first.ok, true, JSON.stringify(first));
      const replay = await submitAt(setup.harness, setup.worker.childContext, `${route}-s06-replay`, { implementation: implementationOutput({ summary: "same" }) });
      assert.equal(replay.ok, true, JSON.stringify(replay));
      assert.deepEqual(replay.receipt, first.receipt, "same assignment/version replay must return the original receipt");
      const ledger = stageReceipts(route === "ordinary" ? state(setup.harness, setup.runId) : nativeState(setup.harness, setup.runId), "implementation");
      assert.equal(Object.keys(ledger).length, 1, "replay must not create a second accepted version");
    } finally {
      await setup.harness.close();
    }
  });

  scenarioTest(`[${route === "ordinary" ? "O" : "C"}:S07] changed replay conflicts with immutable first publication`, async () => {
    const setup = await prepare(route, GATED_PROFILE, `s07-${route}`);
    try {
      assert.ok(setup.worker);
      const first = await submitAt(setup.harness, setup.worker.childContext, `${route}-s07-first`, { implementation: implementationOutput({ summary: "first" }) });
      assert.equal(first.ok, true, JSON.stringify(first));
      const before = JSON.stringify(first.receipt);
      const conflict = await submitAt(setup.harness, setup.worker.childContext, `${route}-s07-conflict`, { implementation: implementationOutput({ summary: "changed" }) });
      assert.equal(conflict.ok, false, JSON.stringify(conflict));
      const canonical = route === "ordinary" ? state(setup.harness, setup.runId) : nativeState(setup.harness, setup.runId);
      const ledger = stageReceipts(canonical, "implementation");
      assert.equal(Object.keys(ledger).length, 1);
      assert.equal(JSON.stringify(first.receipt), before, "the first receipt object must remain immutable");
    } finally {
      await setup.harness.close();
    }
  });
  scenarioTest(`[${route === "ordinary" ? "O" : "C"}:S08] committing publication fault recovers a coherent generation and exact replay is idempotent`, async () => {
    const setup = await prepare(route, GATED_PROFILE, `s08-${route}`);
    try {
      assert.ok(setup.worker);
      const targetDispatch = targetDispatchId(setup);
      const faultOutputs = { implementation: implementationOutput({ summary: "faulted publication" }) };
      const beforeFault = stageReceipts(route === "ordinary" ? state(setup.harness, setup.runId) : nativeState(setup.harness, setup.runId), "implementation");
      const beforeTarget = beforeFault[targetDispatch] ?? null;
      assert.equal(beforeTarget, null, "the target dispatch must be new before the publication transaction");
      const faultArm = armPublicationFault(route, setup.runId, targetDispatch);
      let fault: ToolDetails;
      try {
        fault = await submitAt(setup.harness, setup.worker.childContext, `${route}-s08-fault`, faultOutputs);
      } catch (error) {
        fault = { ok: false, error: String(error) };
      } finally {
        faultArm.clear();
      }
      assert.equal(faultArm.didInject(), true, "the fault must run inside the actual registered submission transaction");
      recordScenarioEvent({ kind: "fault_observed", route: route === "ordinary" ? "O" : "C", faultPoint: "publication", outcome: "REJECTED" });
      assert.equal(fault.ok, false, JSON.stringify(fault));
      const afterFault = route === "ordinary" ? state(setup.harness, setup.runId) : nativeState(setup.harness, setup.runId);
      const afterFaultTarget = stageReceipts(afterFault, "implementation")[targetDispatch];
      if (afterFaultTarget !== undefined) {
        const outputs = record(afterFaultTarget).outputs;
        assert.ok(Array.isArray(outputs) && outputs.length > 0, "automatic journal recovery must publish a complete receipt generation");
      }

      const recover = requireTool(setup.harness, "workflow_recover");
      const diagnosed = record((await recover.execute(`${route}-s08-diagnose`, { operation: "diagnose" }, undefined, undefined, setup.harness.context)).details);
      assert.equal(diagnosed.ok, true, JSON.stringify(diagnosed));
      const reconciled = record((await recover.execute(`${route}-s08-reconcile`, { operation: "reconcile" }, undefined, undefined, setup.harness.context)).details);
      assert.equal(reconciled.ok, true, JSON.stringify(reconciled));

      const retried = await submitAt(setup.harness, setup.worker.childContext, `${route}-s08-retry`, faultOutputs);
      assert.equal(retried.ok, true, JSON.stringify(retried));
      await terminalWorker(setup.harness, setup.worker);
      const afterRetry = route === "ordinary" ? state(setup.harness, setup.runId) : nativeState(setup.harness, setup.runId);
      const afterRetryReceipts = stageReceipts(afterRetry, "implementation");
      const afterRetryTarget = afterRetryReceipts[targetDispatch];
      assert.ok(afterRetryTarget, "the target dispatch must have one accepted receipt after recovery/exact replay");
      assert.equal(Object.keys(afterRetryReceipts).length, 1, "recovery/exact replay must not create a second target receipt");
      const outputs = record(afterRetryTarget).outputs;
      assert.ok(Array.isArray(outputs) && outputs.length > 0, "the accepted generation must retain its complete output list");
      assert.ok(outputs.every((output) => {
        const row = record(output);
        return typeof row.immutable_ref === "string" && typeof row.sha256 === "string";
      }), "the accepted generation must retain immutable output references and hashes");
      const artifact = immutableArtifactSnapshot(setup, afterRetryTarget, "implementation");
      assert.ok(artifact.bytes.length > 0, "the accepted generation must retain its immutable artifact bytes");
    } finally {
      await setup.harness.close();
    }
  });


  scenarioTest(`[${route === "ordinary" ? "O" : "C"}:S09] terminal worker without receipt remains incomplete under bounded recovery`, async () => {
    const setup = await prepare(route, GATED_PROFILE, `s09-${route}`);
    try {
      assert.ok(setup.worker);
      await terminalWorker(setup.harness, setup.worker);
      const recover = requireTool(setup.harness, "workflow_recover");
      const diagnosis = record((await recover.execute(`${route}-s09-diagnose`, { operation: "diagnose" }, undefined, undefined, setup.harness.context)).details);
      assert.equal(diagnosis.ok, true, JSON.stringify(diagnosis));
      assert.equal(Object.keys(stageReceipts(route === "ordinary" ? state(setup.harness, setup.runId) : nativeState(setup.harness, setup.runId), "implementation")).length, 0);
      const before = route === "ordinary" ? state(setup.harness, setup.runId).stage_cursor : nativeProgress(setup.harness, setup.runId).stage_id;
      const blocked = await advanceCurrent(setup, `${route}-s09-no-submission`);
      assert.equal(blocked.ok, false, JSON.stringify(blocked));
      const after = route === "ordinary" ? state(setup.harness, setup.runId).stage_cursor : nativeProgress(setup.harness, setup.runId).stage_id;
      assert.equal(after, before, "terminal lifecycle without a receipt must preserve the active cursor");
    } finally {
      await setup.harness.close();
    }
  });

  scenarioTest(`[${route === "ordinary" ? "O" : "C"}:S10] accepted result is blocked until current approval`, async () => {
    const setup = await prepare(route, GATED_PROFILE, `s10-${route}`);
    try {
      const receipt = await finishWorker(setup, { implementation: implementationOutput({ summary: "await approval" }) });
      assert.equal(receipt.ok, true, JSON.stringify(receipt));
      const denied = await advanceCurrent(setup, `${route}-s10-denied`);
      assert.equal(denied.ok, false, JSON.stringify(denied));
      const before = route === "ordinary" ? state(setup.harness, setup.runId).stage_cursor : nativeProgress(setup.harness, setup.runId).stage_id;
      assert.equal(before, "implementation");
      const approved = await approveCurrent(setup, "approve_implementation", `${route}-s10-approval`);
      assert.equal(approved.ok, true, JSON.stringify(approved));
      const advanced = await advanceCurrent(setup, `${route}-s10-approved`);
      assert.equal(advanced.ok, true, JSON.stringify(advanced));
    } finally {
      await setup.harness.close();
    }
  });
}

for (const route of ["ordinary", "cto"] as const) {
  scenarioTest(`[${route === "ordinary" ? "O" : "C"}:S11] rework iteration preserves prior accepted output and requires a new assignment`, async () => {
    const setup = await prepare(route, LOOP_PROFILE, `s11-${route}`);
    try {
      const first = await finishWorker(setup, { implementation: implementationOutput({ iteration: 1, summary: "original" }) });
      assert.equal(first.ok, true, JSON.stringify(first));
      const firstReceipt = JSON.stringify(first.receipt);
      const firstApproval = await approveCurrent(setup, "approve_implementation", `${route}-s11-first-approval`);
      assert.equal(firstApproval.ok, true, JSON.stringify(firstApproval));
      const toVerify = await advanceCurrent(setup, `${route}-s11-to-verify`);
      assert.equal(toVerify.ok, true, JSON.stringify(toVerify));
      if (route === "ordinary") {
        setup.handoff = await beginOrdinaryStage(setup.harness, record(toVerify.handoff) as unknown as Handoff, "s11-verify");
        setup.worker = await admitOrdinaryWorker(setup.harness, setup.handoff, "s11-verify");
      } else {
        assert.ok(setup.lead);
        setup.worker = await admitCtoWorker(setup.harness, setup.runId, setup.lead, "s11-verify");
      }
      const failed = await finishWorker(setup, { debug: debugOutput("FAIL") });
      assert.equal(failed.ok, true, JSON.stringify(failed));
      const toRework = await advanceCurrent(setup, `${route}-s11-rework`);
      assert.equal(toRework.ok, true, JSON.stringify(toRework));
      if (route === "ordinary") {
        setup.handoff = await beginOrdinaryStage(setup.harness, record(toRework.handoff) as unknown as Handoff, "s11-second-implementation");
        setup.worker = await admitOrdinaryWorker(setup.harness, setup.handoff, "s11-second-implementation");
      } else {
        assert.ok(setup.lead);
        setup.worker = await admitCtoWorker(setup.harness, setup.runId, setup.lead, "s11-second-implementation");
      }
      const second = await finishWorker(setup, { implementation: implementationOutput({ iteration: 2, summary: "reworked" }) });
      assert.equal(second.ok, true, JSON.stringify(second));
      assert.notEqual(JSON.stringify(second.receipt), firstReceipt, "new iteration must have a new assignment/version");
      const canonical = route === "ordinary" ? state(setup.harness, setup.runId) : nativeState(setup.harness, setup.runId);
      const ledger = stageReceipts(canonical, "implementation");
      assert.ok(Object.keys(ledger).length >= 2, "historical and current iteration receipts must both remain readable");
      const identities = Object.values(ledger).map((entry) => record(entry).work_identity).filter((entry): entry is DynamicRecord => Boolean(entry && typeof entry === "object"));
      assert.ok(identities.some((entry) => entry.loop_iteration === 1), "historical iteration identity must remain readable");
      assert.ok(identities.some((entry) => entry.loop_iteration === 2), "new iteration identity must remain distinct");
    } finally {
      await setup.harness.close();
    }
  });

  scenarioTest(`[${route === "ordinary" ? "O" : "C"}:S12] stale historical worker cannot reuse an old assignment for the new iteration`, async () => {
    const setup = await prepare(route, LOOP_PROFILE, `s12-${route}`);
    try {
      assert.ok(setup.worker);
      const oldWorker = setup.worker;
      const first = await finishWorker(setup, { implementation: implementationOutput({ iteration: 1, summary: "historical" }) });
      assert.equal(first.ok, true, JSON.stringify(first));
      const approved = await approveCurrent(setup, "approve_implementation", `${route}-s12-first-approval`);
      assert.equal(approved.ok, true, JSON.stringify(approved));
      const verify = await advanceCurrent(setup, `${route}-s12-to-verify`);
      assert.equal(verify.ok, true, JSON.stringify(verify));
      if (route === "ordinary") {
        setup.handoff = await beginOrdinaryStage(setup.harness, record(verify.handoff) as unknown as Handoff, "s12-verify");
        setup.worker = await admitOrdinaryWorker(setup.harness, setup.handoff, "s12-verify");
      } else {
        assert.ok(setup.lead);
        setup.worker = await admitCtoWorker(setup.harness, setup.runId, setup.lead, "s12-verify");
      }
      const fail = await finishWorker(setup, { debug: debugOutput("FAIL") });
      assert.equal(fail.ok, true, JSON.stringify(fail));
      const rework = await advanceCurrent(setup, `${route}-s12-rework`);
      assert.equal(rework.ok, true, JSON.stringify(rework));
      if (route === "ordinary") {
        setup.handoff = await beginOrdinaryStage(setup.harness, record(rework.handoff) as unknown as Handoff, "s12-current");
        setup.worker = await admitOrdinaryWorker(setup.harness, setup.handoff, "s12-current");
      } else {
        assert.ok(setup.lead);
        setup.worker = await admitCtoWorker(setup.harness, setup.runId, setup.lead, "s12-current");
      }
      const stale = await submitAt(setup.harness, oldWorker.childContext, `${route}-s12-stale`, { implementation: implementationOutput({ iteration: 1, summary: "manual historical reuse" }) });
      assert.equal(stale.ok, false, JSON.stringify(stale));
      const current = await submitAt(setup.harness, setup.worker.childContext, `${route}-s12-current`, { implementation: implementationOutput({ iteration: 2, summary: "current assignment" }) });
      assert.equal(current.ok, true, JSON.stringify(current));
    } finally {
      await setup.harness.close();
    }
  });

  scenarioTest(`[${route === "ordinary" ? "O" : "C"}:R01] missing output or approval reports the precise unmet condition and preserves cursor`, async () => {
    const setup = await prepare(route, MISSING_OUTPUT_PROFILE, `r01-${route}`);
    try {
      const partial = await finishWorker(setup, { implementation: implementationOutput({ summary: "partial" }) });
      assert.equal(partial.ok, false, JSON.stringify(partial));
      const before = route === "ordinary" ? state(setup.harness, setup.runId).stage_cursor : nativeProgress(setup.harness, setup.runId).stage_id;
      const blocked = await advanceCurrent(setup, `${route}-r01-missing`);
      assert.equal(blocked.ok, false, JSON.stringify(blocked));
      const after = route === "ordinary" ? state(setup.harness, setup.runId).stage_cursor : nativeProgress(setup.harness, setup.runId).stage_id;
      assert.equal(after, before, "readiness failure must preserve the active cursor");
      assert.notEqual(after, "next");
    } finally {
      await setup.harness.close();
    }
  });

  scenarioTest(`[${route === "ordinary" ? "O" : "C"}:R02] repeated advance is replay-safe and dispatches the next stage at most once`, async () => {
    const setup = await prepare(route, GATED_PROFILE, `r02-${route}`);
    try {
      await finishWorker(setup, { implementation: implementationOutput({ summary: "advance once" }) });
      const approval = await approveCurrent(setup, "approve_implementation", `${route}-r02-approval`);
      assert.equal(approval.ok, true, JSON.stringify(approval));
      const first = await advanceCurrent(setup, `${route}-r02-first`);
      assert.equal(first.ok, true, JSON.stringify(first));
      if (route === "ordinary") {
        const downstream = await beginOrdinaryStage(setup.harness, record(first.handoff) as unknown as Handoff, "r02-downstream-begin");
        await admitOrdinaryWorker(setup.harness, downstream, "r02-downstream-worker");
      } else {
        assert.ok(setup.lead);
        await admitCtoWorker(setup.harness, setup.runId, setup.lead, "r02-downstream-worker");
      }
      const afterFirst = route === "ordinary" ? state(setup.harness, setup.runId) : nativeState(setup.harness, setup.runId);
      const firstCursor = route === "ordinary" ? afterFirst.stage_cursor : nativeProgress(setup.harness, setup.runId).stage_id;
      const dispatchCapability = record(afterFirst.dispatch_capability ?? {});
      const dispatchCount = route === "ordinary"
        ? (Array.isArray(dispatchCapability.dispatches) ? dispatchCapability.dispatches.length : 0)
        : Object.keys(record(nativeProgress(setup.harness, setup.runId).assignments)).length;
      const replay = await advanceCurrent(setup, `${route}-r02-first`);
      assert.equal(replay.ok, true, JSON.stringify(replay));
      const afterReplay = route === "ordinary" ? state(setup.harness, setup.runId) : nativeState(setup.harness, setup.runId);
      const replayCursor = route === "ordinary" ? afterReplay.stage_cursor : nativeProgress(setup.harness, setup.runId).stage_id;
      assert.equal(replayCursor, firstCursor, "replayed advance must not move the cursor twice");
      const replayDispatchCapability = record(afterReplay.dispatch_capability ?? {});
      const replayDispatchCount = route === "ordinary"
        ? (Array.isArray(replayDispatchCapability.dispatches) ? replayDispatchCapability.dispatches.length : 0)
        : Object.keys(record(nativeProgress(setup.harness, setup.runId).assignments)).length;
      assert.equal(replayDispatchCount, dispatchCount, "replay must not create another next-stage dispatch");
      assert.deepEqual(afterReplay, afterFirst, "replay remains read-only after the downstream capability begins");
    } finally {
      await setup.harness.close();
    }
  });

  scenarioTest(`[${route === "ordinary" ? "O" : "C"}:R03] planning consent does not authorize implementation`, async () => {
    const setup = await prepare(route, GATED_PROFILE, `r03-${route}`);
    try {
      const result = await finishWorker(setup, { implementation: implementationOutput({ summary: "await separate implementation approval" }) });
      assert.equal(result.ok, true, JSON.stringify(result));
      const before = route === "ordinary" ? state(setup.harness, setup.runId).stage_cursor : nativeProgress(setup.harness, setup.runId).stage_id;
      const denied = await advanceCurrent(setup, `${route}-r03-denied`);
      assert.equal(denied.ok, false, JSON.stringify(denied));
      const after = route === "ordinary" ? state(setup.harness, setup.runId).stage_cursor : nativeProgress(setup.harness, setup.runId).stage_id;
      assert.equal(after, before, "a result receipt without approval must preserve the active cursor");
      const canonical = route === "ordinary" ? state(setup.harness, setup.runId) : nativeState(setup.harness, setup.runId);
      assert.equal(Object.keys(stageReceipts(canonical, "implementation")).length, 1, "the result receipt is not approval evidence");
      const approved = await approveCurrent(setup, "approve_implementation", `${route}-r03-implementation-approval`);
      assert.equal(approved.ok, true, JSON.stringify(approved));
      const advanced = await advanceCurrent(setup, `${route}-r03-advanced`);
      assert.equal(advanced.ok, true, JSON.stringify(advanced));
    } finally {
      await setup.harness.close();
    }
  });

  scenarioTest(`[${route === "ordinary" ? "O" : "C"}:R04] old iteration approval cannot advance a changed result`, async () => {
    const setup = await prepare(route, LOOP_PROFILE, `r04-${route}`);
    try {
      await finishWorker(setup, { implementation: implementationOutput({ iteration: 1 }) });
      const oldApproval = await approveCurrent(setup, "approve_implementation", `${route}-r04-old-approval`);
      assert.equal(oldApproval.ok, true, JSON.stringify(oldApproval));
      const toVerify = await advanceCurrent(setup, `${route}-r04-to-verify`);
      assert.equal(toVerify.ok, true, JSON.stringify(toVerify));
      if (route === "ordinary") {
        setup.handoff = await beginOrdinaryStage(setup.harness, record(toVerify.handoff) as unknown as Handoff, "r04-verify");
        setup.worker = await admitOrdinaryWorker(setup.harness, setup.handoff, "r04-verify");
      } else {
        assert.ok(setup.lead);
        setup.worker = await admitCtoWorker(setup.harness, setup.runId, setup.lead, "r04-verify");
      }
      await finishWorker(setup, { debug: debugOutput("FAIL") });
      const reentered = await advanceCurrent(setup, `${route}-r04-reenter`);
      assert.equal(reentered.ok, true, JSON.stringify(reentered));
      if (route === "ordinary") {
        setup.handoff = await beginOrdinaryStage(setup.harness, record(reentered.handoff) as unknown as Handoff, "r04-current");
        setup.worker = await admitOrdinaryWorker(setup.harness, setup.handoff, "r04-current");
      } else {
        assert.ok(setup.lead);
        setup.worker = await admitCtoWorker(setup.harness, setup.runId, setup.lead, "r04-current");
      }
      await finishWorker(setup, { implementation: implementationOutput({ iteration: 2 }) });
      const beforeStale = route === "ordinary" ? state(setup.harness, setup.runId).stage_cursor : nativeProgress(setup.harness, setup.runId).stage_id;
      const staleApprovalAdvance = await advanceCurrent(setup, `${route}-r04-stale-approval`);
      assert.equal(staleApprovalAdvance.ok, false, JSON.stringify(staleApprovalAdvance));
      const afterStale = route === "ordinary" ? state(setup.harness, setup.runId).stage_cursor : nativeProgress(setup.harness, setup.runId).stage_id;
      assert.equal(afterStale, beforeStale, "stale approval must preserve the active cursor");
      const currentApproval = await approveCurrent(setup, "approve_implementation", `${route}-r04-current-approval`);
      assert.equal(currentApproval.ok, true, JSON.stringify(currentApproval));
      const resumed = await advanceCurrent(setup, `${route}-r04-resumed`);
      assert.equal(resumed.ok, true, JSON.stringify(resumed));
    } finally {
      await setup.harness.close();
    }
  });

  scenarioTest(`[${route === "ordinary" ? "O" : "C"}:R05] policy-auto applies only to an explicitly eligible checkpoint`, async () => {
    const setup = await prepare(route, AUTO_PROFILE, `r05-auto-${route}`);
    try {
      await finishWorker(setup, { implementation: implementationOutput({ summary: "policy-auto eligible" }) });
      let auto: ToolDetails;
      if (route === "cto") {
        const ui = record(setup.harness.context.ui);
        const originalSelect = ui.select;
        let uiCalled = false;
        ui.select = async () => {
          uiCalled = true;
          throw new Error("eligible native policy-auto must not ask the UI");
        };
        try {
          auto = await approveCurrent(setup, "approve_implementation", `${route}-r05-auto`, "policy_auto");
        } finally {
          ui.select = originalSelect;
        }
        assert.equal(uiCalled, false, "eligible native policy-auto must not invoke a human UI");
        const approval = record(nativeProgress(setup.harness, setup.runId).approval);
        assert.equal(approval.source, "policy-auto", JSON.stringify(approval));
      } else {
        auto = await approveCurrent(setup, "approve_implementation", `${route}-r05-auto`, "policy_auto");
      }
      assert.equal(auto.ok, true, JSON.stringify(auto));
      const advanced = await advanceCurrent(setup, `${route}-r05-auto-advance`);
      assert.equal(advanced.ok, true, JSON.stringify(advanced));
    } finally {
      await setup.harness.close();
    }
  });
  scenarioTest(`[${route === "ordinary" ? "O" : "C"}:R05] mandatory-human checkpoint rejects policy-auto`, async () => {
    const setup = await prepare(route, GATED_PROFILE, `r05-human-${route}`);
    try {
      await finishWorker(setup, { implementation: implementationOutput({ summary: "human required" }) });
      const before = route === "ordinary" ? state(setup.harness, setup.runId).stage_cursor : nativeProgress(setup.harness, setup.runId).stage_id;
      const denied = route === "ordinary"
        ? await approveCurrent(setup, "approve_implementation", `${route}-r05-human-policy-auto`, "policy_auto")
        : await advanceCurrent(setup, `${route}-r05-human-advance-without-ask`);
      assert.equal(denied.ok, false, JSON.stringify(denied));
      const unchanged = route === "ordinary" ? state(setup.harness, setup.runId).stage_cursor : nativeProgress(setup.harness, setup.runId).stage_id;
      assert.equal(unchanged, before, "policy-auto must not bypass the mandatory-human boundary");
      const human = await approveCurrent(setup, "approve_implementation", `${route}-r05-human-approval`);
      assert.equal(human.ok, true, JSON.stringify(human));
      const advanced = await advanceCurrent(setup, `${route}-r05-human-advance`);
      assert.equal(advanced.ok, true, JSON.stringify(advanced));
    } finally {
      await setup.harness.close();
    }
  });

  scenarioTest(`[${route === "ordinary" ? "O" : "C"}:R18] changes-requested review runs fixes and repeat review without rewriting upstream`, async () => {
    const setup = await prepare(route, REVIEW_CHANGE_PROFILE, `r18-${route}`);
    try {
      const implementation = await finishWorker(setup, { implementation: implementationOutput({ summary: "upstream remains stable" }) });
      assert.equal(implementation.ok, true, JSON.stringify(implementation));
      const upstreamArtifact = immutableArtifactSnapshot(setup, implementation.receipt, "implementation");
      const toReview = await advanceCurrent(setup, `${route}-r18-to-review`);
      assert.equal(toReview.ok, true, JSON.stringify(toReview));
      if (route === "ordinary") {
        setup.handoff = await beginOrdinaryStage(setup.harness, record(toReview.handoff) as unknown as Handoff, "r18-review-initial");
        setup.worker = await admitOrdinaryWorker(setup.harness, setup.handoff, "r18-review-initial");
      } else {
        assert.ok(setup.lead);
        setup.worker = await admitCtoWorker(setup.harness, setup.runId, setup.lead, "r18-review-initial");
      }
      const needsChanges = await finishWorker(setup, { review_initial: reviewOutput("needs_changes", "fix required") });
      assert.equal(needsChanges.ok, true, JSON.stringify(needsChanges));
      const toFix = await advanceCurrent(setup, `${route}-r18-to-fix`);
      assert.equal(toFix.ok, true, JSON.stringify(toFix));
      if (route === "ordinary") {
        setup.handoff = await beginOrdinaryStage(setup.harness, record(toFix.handoff) as unknown as Handoff, "r18-fix-first");
        setup.worker = await admitOrdinaryWorker(setup.harness, setup.handoff, "r18-fix-first");
      } else {
        assert.ok(setup.lead);
        setup.worker = await admitCtoWorker(setup.harness, setup.runId, setup.lead, "r18-fix-first");
      }
      await finishWorker(setup, { implementation_fix: implementationOutput({ summary: "first fix" }) });
      const fixApproval = await approveCurrent(setup, "approve_fix", `${route}-r18-fix-approval`);
      assert.equal(fixApproval.ok, true, JSON.stringify(fixApproval));
      const toRepeat = await advanceCurrent(setup, `${route}-r18-to-repeat`);
      assert.equal(toRepeat.ok, true, JSON.stringify(toRepeat));
      if (route === "ordinary") {
        setup.handoff = await beginOrdinaryStage(setup.harness, record(toRepeat.handoff) as unknown as Handoff, "r18-review-repeat");
        setup.worker = await admitOrdinaryWorker(setup.harness, setup.handoff, "r18-review-repeat");
      } else {
        assert.ok(setup.lead);
        setup.worker = await admitCtoWorker(setup.harness, setup.runId, setup.lead, "r18-review-repeat");
      }
      const repeatNeedsChanges = await finishWorker(setup, { review_repeat: reviewOutput("needs_changes", "one more fix") });
      assert.equal(repeatNeedsChanges.ok, true, JSON.stringify(repeatNeedsChanges));
      const backToFix = await advanceCurrent(setup, `${route}-r18-second-fix`);
      assert.equal(backToFix.ok, true, JSON.stringify(backToFix));
      if (route === "ordinary") {
        setup.handoff = await beginOrdinaryStage(setup.harness, record(backToFix.handoff) as unknown as Handoff, "r18-fix-second");
        setup.worker = await admitOrdinaryWorker(setup.harness, setup.handoff, "r18-fix-second");
      } else {
        assert.ok(setup.lead);
        setup.worker = await admitCtoWorker(setup.harness, setup.runId, setup.lead, "r18-fix-second");
      }
      await finishWorker(setup, { implementation_fix: implementationOutput({ summary: "second fix" }) });
      const oldApproval = await advanceCurrent(setup, `${route}-r18-old-approval`);
      assert.equal(oldApproval.ok, false, JSON.stringify(oldApproval));
      const secondApproval = await approveCurrent(setup, "approve_fix", `${route}-r18-second-approval`);
      assert.equal(secondApproval.ok, true, JSON.stringify(secondApproval));
      const repeatAgain = await advanceCurrent(setup, `${route}-r18-repeat-again`);
      assert.equal(repeatAgain.ok, true, JSON.stringify(repeatAgain));
      if (route === "ordinary") {
        setup.handoff = await beginOrdinaryStage(setup.harness, record(repeatAgain.handoff) as unknown as Handoff, "r18-review-pass");
        setup.worker = await admitOrdinaryWorker(setup.harness, setup.handoff, "r18-review-pass");
      } else {
        assert.ok(setup.lead);
        setup.worker = await admitCtoWorker(setup.harness, setup.runId, setup.lead, "r18-review-pass");
      }
      const approved = await finishWorker(setup, { review_repeat: reviewOutput("approve", "all requested changes verified") });
      assert.equal(approved.ok, true, JSON.stringify(approved));
      const passed = await advanceCurrent(setup, `${route}-r18-passed`);
      assert.equal(passed.ok, true, JSON.stringify(passed));
      if (route === "ordinary") {
        setup.handoff = await beginOrdinaryStage(setup.harness, record(passed.handoff) as unknown as Handoff, "r18-dependent-checks");
        setup.worker = await admitOrdinaryWorker(setup.harness, setup.handoff, "r18-dependent-checks");
      } else {
        assert.ok(setup.lead);
        setup.worker = await admitCtoWorker(setup.harness, setup.runId, setup.lead, "r18-dependent-checks");
      }
      const checked = await finishWorker(setup, { next: debugOutput("PASS") });
      assert.equal(checked.ok, true, JSON.stringify(checked));
      const canonical = route === "ordinary" ? state(setup.harness, setup.runId) : nativeState(setup.harness, setup.runId);
      const ledger = receipts(canonical);
      const retained = Object.values(stageReceipts(canonical, "implementation")).find((entry) => {
        const outputs = record(entry).outputs;
        return Array.isArray(outputs) && outputs.some((output) => {
          const row = record(output);
          return row.artifact_id === "implementation"
            && row.immutable_ref === upstreamArtifact.reference
            && row.sha256 === upstreamArtifact.sha256;
        });
      });
      assert.ok(retained, "the original implementation receipt must retain its immutable reference and hash");
      assert.deepEqual(fs.readFileSync(upstreamArtifact.path), upstreamArtifact.bytes, "the original implementation artifact bytes must remain immutable");
      const fixReceipts = Object.values(ledger).filter((entry) => {
        const outputs = record(entry).outputs;
        return Array.isArray(outputs) && outputs.some((output) => record(output).artifact_id === "implementation_fix");
      });
      assert.equal(fixReceipts.length, 2, "both requested fix iterations must retain their own immutable receipt");
    } finally {
      await setup.harness.close();
    }
  });
}
