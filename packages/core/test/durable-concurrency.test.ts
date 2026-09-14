import { after as nodeTestAfter, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { appendChildJoin, authorizeDispatch, beginCapability, completeDispatch, advanceCursor, recordCheckpointDecision, type CapabilityHandoff } from "../src/engine/durable.js";
import { checkpointPolicyHash, issueTrustedCheckpointAnswerCapability, recordTrustedCheckpointAnswer, registerTrustedCheckpointHostBridge } from "../src/engine/checkpoints.js";
import { profileHash } from "../src/engine/profile.js";
import { durableNamespacedArtifactId } from "../src/engine/fan-in.js";
import { resolveState, setStateTransactionTestHooks, writeState } from "../src/engine/state.js";
import { registerWorkflowProfiles } from "../src/engine/profile.js";
import { PinnedProjectRoot } from "../src/specification/pinned-root.js";
import { beginRegistryRegistration, closeRegistryRegistrationContext, commitRegistryRegistration, openWorkflowActivation, releaseWorkflowOwners, rollbackRegistryRegistration } from "../src/registry/owner.js";
import type { DispatchRecord, Profile, TeamState } from "../src/engine/types.js";
const TEST_CHECKPOINT_BRIDGE = Object.freeze({});
registerTrustedCheckpointHostBridge(TEST_CHECKPOINT_BRIDGE);
const MARKER_CONTENT = "omp-core-test-registry-marker-v1";
type RetainedProfileRegistration = {
  context: import("../src/registry/owner.js").RegistryRegistrationContext;
  releaseToken: import("../src/registry/owner.js").WorkflowOwnerReleaseToken;
  leasedCapabilities: readonly import("../src/registry/owner.js").WorkflowCapability[];
};
const retainedProfileRegistrations = new Set<RetainedProfileRegistration>();
function registerProfiles(root: string, profiles: readonly Profile[], ownerId: string): void {
  const markerPath = join(root, ".omp-test-registry-marker");
  writeFileSync(markerPath, MARKER_CONTENT);
  const markerDigest = createHash("sha256").update(MARKER_CONTENT).digest("hex");
  const owner = {
    owner_id: ownerId, bundle_id: ownerId, owner_kind: "private_omp" as const, activation_marker: `${ownerId}-activation`,
    activation: { marker_id: `${ownerId}-activation`, required: [{ path: ".omp-test-registry-marker", kind: "file" as const, sha256: markerDigest }] },
    host_range: ">=17.3 <19", provenance: { package: "@andvl1/omp-workflows-core", entrypoint: "test", cwd: root },
  };
  const activated = openWorkflowActivation(root, ["workflow_registration"], owner);
  if (!activated.ok) throw new Error(`${activated.code}: ${activated.error}`);
  const transaction = beginRegistryRegistration(activated.registry_context, root, ["workflow_profiles"]);
  if (!transaction.ok) {
    closeRegistryRegistrationContext(activated.registry_context);
    releaseWorkflowOwners(activated.release_token, activated.leased_capabilities);
    throw new Error(`${transaction.code}: ${transaction.error}`);
  }
  try {
    registerWorkflowProfiles(transaction.token, profiles);
    commitRegistryRegistration(transaction.token);
    retainedProfileRegistrations.add({ context: activated.registry_context, releaseToken: activated.release_token, leasedCapabilities: activated.leased_capabilities });
  } catch (error) {
    try { rollbackRegistryRegistration(transaction.token); } catch { /* preserve original */ }
    closeRegistryRegistrationContext(activated.registry_context);
    releaseWorkflowOwners(activated.release_token, activated.leased_capabilities);
    throw error;
  }
}
nodeTestAfter(() => {
  for (const registration of retainedProfileRegistrations) {
    closeRegistryRegistrationContext(registration.context);
    if (registration.leasedCapabilities.length > 0) releaseWorkflowOwners(registration.releaseToken, registration.leasedCapabilities);
  }
  retainedProfileRegistrations.clear();
});

const profile: Profile = {
  name: "durable-concurrency",
  title: "Durable concurrency fixture",
  description: "A two-slot stage used to exercise cross-process state transactions.",
  match: { type: ["FEATURE"] },
  stages: [
    {
      id: "dispatch",
      title: "Dispatch",
      type: "consilium",
      roles: ["worker-a", "worker-b"],
      parallel: true,
      checkpoint: "approve",
      produces: "artifact",
      checkpoint_policy: {
        default: "required_human",
        scope: "decision",
        hard_human: ["custom"],
        rules: {
          approve: {
            kind: "custom",
            default: "required_human",
            allowed_decisions: ["approve_continue"],
            phase: "before_advance",
            rationale: "The concurrent fixture requires an explicit decision.",
          },
        },
        source: "profile",
        policy_version: 1,
        rationale: "Test policy.",
      },
    },
    { id: "done", title: "Done", type: "none" },
  ],
};
const collisionProfile: Profile = {
  ...profile,
  name: "durable-concurrency-collisions",
  title: "Durable slot filename collision fixture",
  stages: profile.stages.map((stage) => stage.id === "dispatch" ? { ...stage, roles: ["a#1", "a-1"], produces: "shared" } : stage),
};

const testDirectory = dirname(fileURLToPath(import.meta.url));
const profileModulePath = join(testDirectory, "../src/engine/profile.ts");
const durableModulePath = join(testDirectory, "../src/engine/durable.ts");
const ownerModulePath = join(testDirectory, "../src/registry/owner.ts");
const checkpointModulePath = join(testDirectory, "../src/engine/checkpoints.ts");
const stateModulePath = join(testDirectory, "../src/engine/state.ts");
const childScript = `
const [root, operation, payload, profilePayload] = process.argv.slice(1);
// Child processes intentionally load the TypeScript modules at runtime so two
// independent Node processes exercise the cross-process lock, not one event
// loop's call ordering.
// Do not import the node:test fixture here: its after hook emits the child test reporter on stdout.

const { registerWorkflowProfiles } = await import(${JSON.stringify(profileModulePath)});
const { createHash } = await import("node:crypto");
const { readFileSync } = await import("node:fs");
const { join } = await import("node:path");
const ownerModule = await import(${JSON.stringify(ownerModulePath)});
const markerPath = ".omp-test-registry-marker";
const markerDigest = createHash("sha256").update(readFileSync(join(root, markerPath))).digest("hex");
const owner = {
  owner_id: "durable-child-profile",
  bundle_id: "durable-child-profile",
  owner_kind: "private_omp",
  activation_marker: "durable-child-profile-activation",
  activation: { marker_id: "durable-child-profile-activation", required: [{ path: markerPath, kind: "file", sha256: markerDigest }] },
  host_range: ">=17.3 <19",
  provenance: { package: "@andvl1/omp-workflows-core", entrypoint: "test", cwd: root },
};
const activated = ownerModule.openWorkflowActivation(root, ["workflow_registration"], owner);
if (!activated.ok) throw new Error(\`\${activated.code}: \${activated.error}\`);
const transaction = ownerModule.beginRegistryRegistration(activated.registry_context, root, ["workflow_profiles"]);
if (!transaction.ok) throw new Error(\`\${transaction.code}: \${transaction.error}\`);
let committed = false;
let result;
try {
  registerWorkflowProfiles(transaction.token, [JSON.parse(profilePayload)]);
  ownerModule.commitRegistryRegistration(transaction.token);
  committed = true;
  const durable = await import(${JSON.stringify(durableModulePath)});
  const input = JSON.parse(payload);
  if (operation === "recordCheckpointDecision" && input.actor_provenance?.proof) {
    const checkpoints = await import(${JSON.stringify(checkpointModulePath)});
    const stateModule = await import(${JSON.stringify(stateModulePath)});
    const resolved = stateModule.resolveState(root);
    if (resolved.state) {
      const { realpathSync, statSync } = await import("node:fs");
      const canonicalRoot = realpathSync(root);
      const stat = statSync(canonicalRoot);
      const rootIdentity = { canonical_root: canonicalRoot, dev: stat.dev, ino: stat.ino };
      const bridge = Object.freeze({});
      checkpoints.registerTrustedCheckpointHostBridge(bridge);
      const reference = input.actor_provenance.ref;
      const capability = checkpoints.issueTrustedCheckpointAnswerCapability(bridge, {
        root: rootIdentity, state: resolved.state, answer_id: input.actor_provenance.proof.answer_id,
        channel: input.actor_provenance.proof.channel, reference, stage_id: input.stage_cursor,
        checkpoint_id: input.checkpoint_id, decision: input.decision, question: "Authorize the concurrent dispatch",
        options: [input.decision], session_id: "durable-concurrency-session", actor_ref: reference,
        profile_hash: resolved.state.profile_hash,
      });
      const trusted = checkpoints.recordTrustedCheckpointAnswer(resolved.state, {
        answer_id: input.actor_provenance.proof.answer_id, channel: input.actor_provenance.proof.channel, reference,
        stage_id: input.stage_cursor, checkpoint_id: input.checkpoint_id, decision: input.decision,
      }, { capability, root: rootIdentity });
      stateModule.writeState(root, trusted.state, { target: resolved });
      input.actor_provenance = { kind: "user", ref: trusted.answer.reference, proof: trusted.proof };
    }
  }
  result = durable[operation](root, input);
} finally {
  if (!committed) { try { ownerModule.rollbackRegistryRegistration(transaction.token); } catch {} }
  ownerModule.closeRegistryRegistrationContext(activated.registry_context);
  if (activated.leased_capabilities.length > 0) ownerModule.releaseWorkflowOwners(activated.release_token, activated.leased_capabilities);
}
process.stdout.write(JSON.stringify(result));
`;

function initGit(root: string): void {
  execFileSync("git", ["-C", root, "init", "--quiet", "--initial-branch", "main"], { stdio: "ignore" });
}

type ChildResult =
  | { ok: true; state?: TeamState; record?: DispatchRecord; handoff?: CapabilityHandoff; error?: string }
  | { ok: false; state?: TeamState; error: string };
type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
  reject: (reason?: unknown) => void;
};

function isChildResult(value: unknown): value is ChildResult {
  return value !== null && typeof value === "object" && "ok" in value && typeof value.ok === "boolean";
}

function trustedCheckpointAnswer(state: TeamState, root: string, answerId: string, reference: string) {
  const pinnedRoot = PinnedProjectRoot.open(root);
  if (!pinnedRoot) throw new Error("checkpoint fixture root could not be pinned");
  try {
    const rootIdentity = { canonical_root: pinnedRoot.canonical_root, dev: pinnedRoot.dev, ino: pinnedRoot.ino };
    const capability = issueTrustedCheckpointAnswerCapability(TEST_CHECKPOINT_BRIDGE, {
      root: rootIdentity,
      state,
      answer_id: answerId,
      channel: "terminal",
      reference,
      stage_id: "dispatch",
      checkpoint_id: "approve",
      decision: "approve_continue",
      question: "Authorize the concurrent dispatch",
      options: ["approve_continue"],
      session_id: "durable-concurrency-session",
      actor_ref: reference,
      profile_hash: state.profile_hash ?? profileHash(profile),
    });
    return recordTrustedCheckpointAnswer(state, {
      answer_id: answerId,
      channel: "terminal",
      reference,
      stage_id: "dispatch",
      checkpoint_id: "approve",
      decision: "approve_continue",
    }, { capability, root: rootIdentity });
  } finally {
    pinnedRoot.close();
  }
}

function runChild(root: string, operation: string, payload: unknown, selectedProfile: Profile = profile): Promise<ChildResult> {
  const promiseConstructor = Promise as unknown as { withResolvers<T>(): Deferred<T> };
  const { promise, resolve, reject } = promiseConstructor.withResolvers<ChildResult>();
  const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", childScript, root, operation, JSON.stringify(payload), JSON.stringify(selectedProfile)], {
    cwd: process.cwd(),
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
  child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
  child.once("error", reject);
  child.once("exit", (code) => {
    if (code !== 0) {
      reject(new Error(`child ${operation} exited ${code}: ${stderr}`));
      return;
    }
    try {
      const parsed: unknown = JSON.parse(stdout);
      if (!isChildResult(parsed)) throw new Error("result has no boolean ok field");
      resolve(parsed);
    } catch (error) {
      reject(new Error(`child ${operation} returned invalid JSON: ${String(error)}; stderr=${stderr}`));
    }
  });
  return promise;
}

function workIdentityOf(record: DispatchRecord): NonNullable<DispatchRecord["work_identity"]> {
  if (!record.work_identity) throw new Error(`dispatch record ${record.id} has no work identity`);
  return record.work_identity;
}

function fixture(root: string): { state: TeamState; handoff: CapabilityHandoff } {
  initGit(root);
  mkdirSync(join(root, ".omp"), { recursive: true });
  writeFileSync(join(root, ".omp", "team.config.json"), JSON.stringify({ roles: { "worker-a": "agent-a", "worker-b": "agent-b" } }) + "\n");
  registerProfiles(root, [profile], "durable-parent-profile");
  const state: TeamState = {
    schema: 1,
    branch: "main",
    classification: { type: "FEATURE", complexity: "MEDIUM", confidence: "HIGH", workflow: profile.name, autonomous: false },
    task: "concurrent durable transitions",
    workflow_override: false,
    issue: null,
    run_key: "concurrent-run",
    stage_cursor: "dispatch",
    stages: [{ id: "dispatch", status: "pending" }, { id: "done", status: "pending" }],
    artifacts: {},
    pause: { kind: "none", reason: "" },
    updated_at: new Date().toISOString(),
    profile_hash: profileHash(profile),
    scope: { scope: [], has_security: false, has_infra: false, has_ui: false, has_runtime: true, dev_agent: null },
  };
  writeState(root, state, { featureSlug: "concurrent" });
  const artifactsDir = join(root, ".work-state", "features", "concurrent", "artifacts");
  mkdirSync(artifactsDir, { recursive: true });
  for (const role of ["worker-a", "worker-b"]) {
    writeFileSync(join(artifactsDir, `${durableNamespacedArtifactId("artifact", role)}.json`), JSON.stringify({ role, completed: true }) + "\n");
  }
  const issued = beginCapability(root);
  if (!issued.ok || !issued.handoff) throw new Error(issued.ok ? "begin returned no handoff" : issued.error);
  const resolved = resolveState(root);
  if (!resolved.state) throw new Error("fixture state did not resolve");
  return { state: resolved.state, handoff: issued.handoff };
}
function collisionFixture(root: string): CapabilityHandoff {
  initGit(root);
  mkdirSync(join(root, ".omp"), { recursive: true });
  writeFileSync(join(root, ".omp", "team.config.json"), JSON.stringify({ roles: { "a#1": "provider-a#1", "a-1": "provider-a-1" } }) + "\n");
  registerProfiles(root, [collisionProfile], "durable-parent-collision-profile");
  const state: TeamState = {
    schema: 1,
    branch: "main",
    classification: { type: "FEATURE", complexity: "MEDIUM", confidence: "HIGH", workflow: collisionProfile.name, autonomous: false },
    task: "concurrent colliding slot snapshots",
    workflow_override: false,
    issue: null,
    run_key: "collision-run",
    stage_cursor: "dispatch",
    stages: [{ id: "dispatch", status: "pending" }, { id: "done", status: "pending" }],
    artifacts: {},
    pause: { kind: "none", reason: "" },
    updated_at: new Date().toISOString(),
    profile_hash: profileHash(collisionProfile),
    scope: { scope: [], has_security: false, has_infra: false, has_ui: false, has_runtime: true, dev_agent: null },
  };
  writeState(root, state, { featureSlug: "collision" });
  const artifactsDir = join(root, ".work-state", "features", "collision", "artifacts");
  mkdirSync(artifactsDir, { recursive: true });
  writeFileSync(join(artifactsDir, "shared.json"), JSON.stringify({ result: "stable" }) + "\n");
  const issued = beginCapability(root);
  if (!issued.ok || !issued.handoff) throw new Error(issued.ok ? "collision begin returned no handoff" : issued.error);
  return issued.handoff;
}

test("durable transactions retain concurrent different-slot dispatch and completion updates", async () => {
  const root = mkdtempSync(join(tmpdir(), "durable-concurrency-dispatch-"));
  try {
    const { handoff } = fixture(root);
    const base = {
      capability_id: handoff.capability_id,
      token: handoff.dispatch_token,
      run_key: handoff.run_key,
      branch: handoff.branch,
      workflow: handoff.workflow,
      profile_hash: handoff.profile_hash,
      stage_cursor: handoff.stage_cursor,
      cursor_epoch: handoff.cursor_epoch,
    };
    const authPayloads = handoff.expected_roster.map((entry) => ({
      ...base,
      role: entry.role,
      slot_id: entry.role,
      tool_call_id: `call-${entry.role}`,
    }));
    const authorized = await Promise.all(authPayloads.map((payload) => runChild(root, "authorizeDispatch", payload)));
    for (const result of authorized) {
      if (!result.ok || !result.record) throw new Error(`dispatch authorization failed: ${result.error ?? "missing record"}`);
    }
    const records: DispatchRecord[] = authorized.flatMap((result) => result.ok && result.record ? [result.record] : []);
    assert.equal(new Set(records.map((record) => record.role)).size, 2);
    const completions = await Promise.all(records.map((record) => {
      const identity = workIdentityOf(record);
      return runChild(root, "completeDispatch", {
        ...base,
        dispatch_id: record.id,
        role: record.role,
        slot_id: identity.slot_id,
        task_id: identity.task_id,
        agent: record.agent,
        tool_call_id: record.tool_call_id,
        outcome: "succeeded",
        evidence: `completed ${record.role}`,
        artifact_ids: ["artifact"],
      });
    }));
    assert.ok(completions.every((result) => result.ok), JSON.stringify(completions));
    const resolved = resolveState(root);
    assert.ok(resolved.state);
    const persisted = resolved.state.dispatch_capability?.dispatches ?? [];
    assert.equal(persisted.length, 2, "both dispatch ledger entries must survive concurrent writes");
    assert.deepEqual(persisted.map((record) => record.status).sort(), ["succeeded", "succeeded"]);
    assert.equal(new Set(persisted.map((record) => record.completion?.dispatch_id)).size, 2);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
test("child join persists through the bound durable writer and replays idempotently", async () => {
  const root = mkdtempSync(join(tmpdir(), "durable-child-join-"));
  try {
    const { handoff } = fixture(root);
    const authorized = runChild(root, "authorizeDispatch", {
      capability_id: handoff.capability_id,
      token: handoff.dispatch_token,
      run_key: handoff.run_key,
      branch: handoff.branch,
      workflow: handoff.workflow,
      profile_hash: handoff.profile_hash,
      stage_cursor: handoff.stage_cursor,
      cursor_epoch: handoff.cursor_epoch,
      role: handoff.expected_roster[0]?.role,
      slot_id: handoff.expected_roster[0]?.role,
      tool_call_id: "child-join-parent",
    });
    const result = await authorized;
    {
      assert.equal(result.ok, true, result.error ?? "parent dispatch authorization failed");
      if (!result.ok || !result.record) return;
      const parent = workIdentityOf(result.record);
      const child = { ...parent, task_id: `${parent.task_id}-child`, dispatch_id: `${parent.dispatch_id}-child`, worker_id: `${parent.worker_id}-child` };
      const input = {
        parent,
        child,
        state: "pending" as const,
        expected_artifact_ids: ["artifact"],
        completion_envelope_ref: null,
        attempt: 1,
      };
      const joined = appendChildJoin(root, input);
      assert.equal(joined.ok, true, joined.ok ? "" : joined.error);
      const replay = appendChildJoin(root, input);
      assert.equal(replay.ok, true, replay.ok ? "" : replay.error);
      const persisted = resolveState(root).state?.child_joins ?? [];
      assert.equal(persisted.length, 1, "an exact child join replay must not duplicate the durable record");
      assert.equal(persisted[0]?.child.dispatch_id, child.dispatch_id);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("consilium slot artifacts roll back when the enclosing state CAS loses", () => {
  const root = mkdtempSync(join(tmpdir(), "durable-slot-cas-rollback-"));
  try {
    const { handoff } = fixture(root);
    const slot = handoff.expected_roster[0];
    assert.ok(slot);
    if (!slot) return;
    const base = {
      capability_id: handoff.capability_id,
      token: handoff.dispatch_token,
      run_key: handoff.run_key,
      branch: handoff.branch,
      workflow: handoff.workflow,
      profile_hash: handoff.profile_hash,
      stage_cursor: handoff.stage_cursor,
      cursor_epoch: handoff.cursor_epoch,
      role: slot.role,
      slot_id: slot.role,
      tool_call_id: "slot-cas-rollback",
    };
    const authorized = authorizeDispatch(root, base);
    assert.equal(authorized.ok, true, authorized.ok ? "" : authorized.error);
    if (!authorized.ok || !authorized.record) return;
    const artifactsDir = join(root, ".work-state", "features", "concurrent", "artifacts");
    rmSync(join(artifactsDir, durableNamespacedArtifactId("artifact", slot.role) + ".json"), { force: true });
    writeFileSync(join(artifactsDir, "artifact.json"), JSON.stringify({ role: slot.role }) + "\n");
    const statePath = join(root, ".work-state", "features", "concurrent", "state.json");
    let injected = false;
    setStateTransactionTestHooks({
      beforeCas: () => {
        if (injected) return;
        injected = true;
        const current = JSON.parse(readFileSync(statePath, "utf8")) as Record<string, unknown>;
        current.task = "concurrent state winner";
        current.state_revision = Number(current.state_revision ?? 0) + 1;
        writeFileSync(statePath, `${JSON.stringify(current, null, 2)}\n`, "utf8");
      },
    }, root);
    try {
      const rejected = completeDispatch(root, {
        ...base,
        dispatch_id: authorized.record.id,
        task_id: authorized.record.work_identity?.task_id,
        agent: authorized.record.agent,
        outcome: "succeeded",
        evidence: "slot completion before CAS drift",
        artifact_ids: ["artifact"],
      });
      assert.equal(rejected.ok, false, rejected.ok ? "state CAS drift must reject slot completion" : rejected.error);
    } finally {
      setStateTransactionTestHooks(null, root);
    }
    assert.equal(injected, true, "the deterministic state CAS seam must run");
    assert.equal(existsSync(join(artifactsDir, durableNamespacedArtifactId("artifact", slot.role) + ".json")), false, "aborted slot completion must remove its attempt-owned namespaced artifact");
  } finally {
    setStateTransactionTestHooks(null, root);
    rmSync(root, { recursive: true, force: true });
  }
});

test("durable snapshots keep colliding slot identities separate across processes", async () => {
  const root = mkdtempSync(join(tmpdir(), "durable-concurrency-slot-collision-"));
  try {
    const handoff = collisionFixture(root);
    const base = {
      capability_id: handoff.capability_id,
      token: handoff.dispatch_token,
      run_key: handoff.run_key,
      branch: handoff.branch,
      workflow: handoff.workflow,
      profile_hash: handoff.profile_hash,
      stage_cursor: handoff.stage_cursor,
      cursor_epoch: handoff.cursor_epoch,
    };
    const authorized = await Promise.all(handoff.expected_roster.map((entry) => runChild(root, "authorizeDispatch", {
      ...base,
      role: entry.role,
      slot_id: entry.role,
      tool_call_id: `collision-call-${entry.role}`,
    }, collisionProfile)));
    const records = authorized.flatMap((result) => result.ok && result.record ? [result.record] : []);
    assert.equal(records.length, 2, JSON.stringify(authorized));
    const completions = await Promise.all(records.map((record) => {
      const identity = workIdentityOf(record);
      return runChild(root, "completeDispatch", {
        ...base,
        dispatch_id: record.id,
        role: record.role,
        slot_id: identity.slot_id,
        task_id: identity.task_id,
        agent: record.agent,
        tool_call_id: record.tool_call_id,
        outcome: "succeeded",
        evidence: `completed ${record.role}`,
        artifact_ids: ["shared"],
      }, collisionProfile);
    }));
    assert.ok(completions.every((result) => result.ok), JSON.stringify(completions));
    const state = resolveState(root).state;
    const slots = state?.slot_artifacts?.dispatch?.slots ?? {};
    const first = slots["a#1"]?.shared;
    const second = slots["a-1"]?.shared;
    assert.ok(first && second);
    assert.notEqual(first?.path, second?.path, "lossy legacy names must not alias canonical snapshots");
    assert.equal(first?.path.endsWith(`${durableNamespacedArtifactId("shared", "a#1")}.json`), true);
    assert.equal(second?.path.endsWith(`${durableNamespacedArtifactId("shared", "a-1")}.json`), true);
    const firstEnvelope = JSON.parse(readFileSync(first!.path, "utf8")) as { $omp_slot_artifact: { slot_id: string } };
    const secondEnvelope = JSON.parse(readFileSync(second!.path, "utf8")) as { $omp_slot_artifact: { slot_id: string } };
    assert.equal(firstEnvelope.$omp_slot_artifact.slot_id, "a#1");
    assert.equal(secondEnvelope.$omp_slot_artifact.slot_id, "a-1");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("durable checkpoint and advance serialize without losing the decision; stale cursor is rejected", async () => {
  const root = mkdtempSync(join(tmpdir(), "durable-concurrency-checkpoint-"));
  try {
    const { handoff } = fixture(root);
    const base = {
      capability_id: handoff.capability_id,
      token: handoff.advance_token,
      run_key: handoff.run_key,
      branch: handoff.branch,
      workflow: handoff.workflow,
      profile_hash: handoff.profile_hash,
      stage_cursor: handoff.stage_cursor,
      cursor_epoch: handoff.cursor_epoch,
    };
    const authorized = await Promise.all(handoff.expected_roster.map((entry) => runChild(root, "authorizeDispatch", {
      ...{ ...base, token: handoff.dispatch_token },
      role: entry.role,
      slot_id: entry.role,
      tool_call_id: `call-${entry.role}`,
    })));
    for (const result of authorized) {
      if (!result.ok || !result.record) throw new Error(`dispatch authorization failed: ${result.error ?? "missing record"}`);
    }
    const records: DispatchRecord[] = authorized.flatMap((result) => result.ok && result.record ? [result.record] : []);
    await Promise.all(records.map((record) => {
      const identity = workIdentityOf(record);
      return runChild(root, "completeDispatch", {
        ...{ ...base, token: handoff.dispatch_token },
        dispatch_id: record.id,
        role: record.role,
        slot_id: identity.slot_id,
        task_id: identity.task_id,
        agent: record.agent,
        outcome: "succeeded",
        evidence: "slot complete",
        artifact_ids: ["artifact"],
      });
    }));
    const beforeAnswer = resolveState(root);
    if (!beforeAnswer.state) throw new Error("state disappeared before checkpoint answer");
    const stagePolicy = profile.stages[0]?.checkpoint_policy;
    if (!stagePolicy) throw new Error("checkpoint fixture policy is missing");
    const checkpointReference = "terminal-answer/durable-concurrency";
    const checkpointPayload = {
      ...base,
      checkpoint: "approve",
      checkpoint_id: "approve",
      checkpoint_kind: "custom",
      authorization: "human",
      // The child checkpoint operation mints the opaque capability and replaces
      // this placeholder proof immediately before durable ingestion.
      actor_provenance: { kind: "user", ref: checkpointReference, proof: { answer_id: "durable-concurrency-answer", channel: "terminal", nonce: "placeholder", reference: checkpointReference, binding: "placeholder" } },
      policy_hash: checkpointPolicyHash(stagePolicy),
      decision: "approve_continue",
      rationale: "concurrent checkpoint",
    };
    const advancePayload = { ...base, evidence: "all slots completed" };
    const [checkpoint, advanced] = await Promise.all([
      runChild(root, "recordCheckpointDecision", checkpointPayload),
      runChild(root, "advanceCursor", advancePayload),
    ]);
    assert.ok(checkpoint.ok || (advanced.ok && advanced.state?.stage_cursor === "done"), JSON.stringify({ checkpoint, advanced }));

    let current = resolveState(root);
    assert.ok(current.state);
    assert.equal(current.state.typed_checkpoint_decisions?.length, 1, "checkpoint ledger entry must survive an advance race");
    if (current.state.stage_cursor !== "done") {
      const retry = advanceCursor(root, advancePayload);
      assert.equal(retry.ok, true, retry.ok ? "" : `${retry.error}; slot_artifacts=${JSON.stringify(current.state?.slot_artifacts)}; artifacts=${JSON.stringify(current.state?.artifacts)}; dispatches=${JSON.stringify(current.state?.dispatch_capability?.dispatches?.map((item) => ({ role: item.role, status: item.status, completion: item.completion?.outcome })))}; paths=${JSON.stringify(Object.values(current.state?.slot_artifacts?.dispatch?.slots ?? {}).map((slot) => Object.values(slot)[0]?.path).map((path) => ({ path, exists: path ? existsSync(path) : false })))}`);
      current = resolveState(root);
    }
    assert.equal(current.state?.stage_cursor, "done");
    const stale = advanceCursor(root, advancePayload);
    assert.equal(stale.ok, false);
    assert.match(stale.error, /capability identity mismatch|capability invalidated|stale cursor binding|checkpoint stage/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("terminal provider completion clears only resolved pending and removes it before next stage", async () => {
  const root = mkdtempSync(join(tmpdir(), "durable-concurrency-pending-"));
  try {
    const { handoff } = fixture(root);
    const base = {
      capability_id: handoff.capability_id,
      token: handoff.dispatch_token,
      run_key: handoff.run_key,
      branch: handoff.branch,
      workflow: handoff.workflow,
      profile_hash: handoff.profile_hash,
      stage_cursor: handoff.stage_cursor,
      cursor_epoch: handoff.cursor_epoch,
    };
    const authorized = await Promise.all(handoff.expected_roster.map((entry) => runChild(root, "authorizeDispatch", {
      ...base,
      role: entry.role,
      slot_id: entry.role,
      tool_call_id: `pending-call-${entry.role}`,
    })));
    const records = authorized.flatMap((result) => result.ok && result.record ? [result.record] : []);
    assert.equal(records.length, 2, JSON.stringify(authorized));
    const identities = records.map((record) => workIdentityOf(record));

    for (const [index, record] of records.entries()) {
      const identity = identities[index]!;
      const pending = await runChild(root, "completeDispatch", {
        ...base,
        dispatch_id: record.id,
        role: record.role,
        slot_id: identity.slot_id,
        task_id: identity.task_id,
        agent: record.agent,
        tool_call_id: record.tool_call_id,
        pending: true,
        pending_reason: "awaiting_result",
        provider_ref: `provider-${index + 1}`,
      });
      assert.equal(pending.ok, true, JSON.stringify(pending));
    }
    let current = resolveState(root).state;
    assert.ok(current?.pending, "partial provider work must expose a top-level pending lifecycle");
    assert.ok(records.some((record) => record.id === current?.pending?.identity.dispatch_id), "top-level pending must belong to an active provider");

    const first = records[0]!;
    const firstIdentity = identities[0]!;
    const firstComplete = await runChild(root, "completeDispatch", {
      ...base,
      dispatch_id: first.id,
      role: first.role,
      slot_id: firstIdentity.slot_id,
      task_id: firstIdentity.task_id,
      agent: first.agent,
      tool_call_id: first.tool_call_id,
      outcome: "succeeded",
      evidence: "first provider completed",
      artifact_ids: ["artifact"],
    });
    assert.equal(firstComplete.ok, true, JSON.stringify(firstComplete));
    current = resolveState(root).state;
    const remaining = records[1]!;
    assert.equal(current?.pending?.identity.dispatch_id, remaining.id, "completion must retain the exact other provider pending");

    const replayFirst = await runChild(root, "completeDispatch", {
      ...base,
      dispatch_id: first.id,
      role: first.role,
      slot_id: firstIdentity.slot_id,
      task_id: firstIdentity.task_id,
      agent: first.agent,
      tool_call_id: first.tool_call_id,
      outcome: "succeeded",
      evidence: "first provider completed",
      artifact_ids: ["artifact"],
    });
    assert.equal(replayFirst.ok, true, JSON.stringify(replayFirst));
    current = resolveState(root).state;
    assert.equal(current?.pending?.identity.dispatch_id, remaining.id, "replayed stale completion must not clear newer pending work");

    const remainingIdentity = identities[1]!;
    const finalComplete = await runChild(root, "completeDispatch", {
      ...base,
      dispatch_id: remaining.id,
      role: remaining.role,
      slot_id: remainingIdentity.slot_id,
      task_id: remainingIdentity.task_id,
      agent: remaining.agent,
      tool_call_id: remaining.tool_call_id,
      artifact_ids: ["artifact"],
      outcome: "succeeded",
      evidence: "remaining provider completed",
    });
    assert.equal(finalComplete.ok, true, JSON.stringify(finalComplete));
    current = resolveState(root).state;
    assert.equal(current?.pending, undefined, "final terminal completion must remove top-level pending");

    const replayFinal = await runChild(root, "completeDispatch", {
      ...base,
      dispatch_id: remaining.id,
      role: remaining.role,
      slot_id: remainingIdentity.slot_id,
      task_id: remainingIdentity.task_id,
      agent: remaining.agent,
      tool_call_id: remaining.tool_call_id,
      artifact_ids: ["artifact"],
      outcome: "succeeded",
      evidence: "remaining provider completed",
    });
    assert.equal(replayFinal.ok, true, JSON.stringify(replayFinal));
    current = resolveState(root).state;
    assert.equal(current?.pending, undefined, "terminal completion replay must stay clear after restart");

    const stagePolicy = profile.stages[0]?.checkpoint_policy;
    if (!stagePolicy || !current) throw new Error("checkpoint fixture policy/state is missing");
    const trusted = trustedCheckpointAnswer(current, root, "durable-concurrency-pending-answer", "terminal-answer/durable-concurrency-pending");
    writeState(root, trusted.state, { target: resolveState(root) });
    const advanceBase = { ...base, token: handoff.advance_token };
    const checkpoint = recordCheckpointDecision(root, {
      ...advanceBase,
      checkpoint: "approve",
      checkpoint_id: "approve",
      checkpoint_kind: "custom",
      authorization: "human",
      actor_provenance: { kind: "user", ref: trusted.answer.reference, proof: trusted.proof },
      policy_hash: checkpointPolicyHash(stagePolicy),
      decision: "approve_continue",
      rationale: "pending lifecycle complete",
    });
    assert.equal(checkpoint.ok, true, checkpoint.ok ? "" : checkpoint.error);
    const advanced = advanceCursor(root, { ...advanceBase, evidence: "all providers completed" });
    assert.equal(advanced.ok, true, advanced.ok ? "" : advanced.error);
    assert.equal(advanced.state?.pending, undefined, "advance result must not carry prior pending lifecycle");
    assert.equal(resolveState(root).state?.pending, undefined, "persisted advance state must not inherit prior pending lifecycle");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
