import { test } from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  confirmCtoSpecificationMapping,
  dispatchCtoSpecificationMapping,
  preflightCtoSpecificationExecution,
} from "../src/commands/cto.js";
import {
  prepareCtoSpecificationExecution as prepareCtoSpecificationExecutionRaw,
  setCtoSpecificationPreparationTestHooks,
  type CtoSpecificationExecutionPreparationInput,
  type CtoSpecificationExecutionPreparationReady,
  type CtoSpecificationPreparationFailurePoint,
} from "../src/cto/specification-execution.js";
import { canonicalCtoDoDProjection } from "../src/cto/dod.js";
import {
  assertCtoSliceDispatchable,
  validateSliceDoD,
} from "../src/cto/slice-gate.js";
import { readCtoState } from "../src/cto/state.js";

import { loadProfile, profileHash } from "../src/engine/profile.js";
import { resolveState, writeState } from "../src/engine/state.js";
import { PinnedProjectRoot } from "../src/specification/pinned-root.js";
import { setCanonicalHandoffReadTestHooks } from "../src/specification/canonical-reader.js";
import { captureWorkspacePathBinding } from "../src/specification/workspace.js";
import { ensureProjectConstitution } from "../src/specification/prerequisite.js";
import { registerCtoTools, registerTeamWorkflow, type TeamSessionBindingController, type TeamSessionRuntimeBinding } from "../src/index.js";
import { beginRegistryRegistration, commitRegistryRegistration, rollbackRegistryRegistration } from "../src/registry/index.js";
import { digestOf } from "../src/specification/validation.js";
import { readExecutionClaimStore } from "../src/specification/claims.js";
import { validFeatureWorkspace, validImplementationHandoff } from "./fixtures/specification-fixtures.js";
import { openTestCtoRuntime } from "./fixtures/registry-activation.js";
import { z as zod } from "zod";
import type { CheckpointAnswerProof, DoD, TeamState } from "../src/engine/types.js";
import type { CtoState, TeamDef } from "../src/cto/types.js";


type Json = Record<string, unknown>;
type Preparation = CtoSpecificationExecutionPreparationReady;

const CLASSIFICATION = {
  type: "FEATURE",
  complexity: "MEDIUM",
  confidence: "HIGH",
  autonomous: true,
  workflow: "standard",
} as const;
const TEAM_DEF: TeamDef = {
  id: "team-standard",
  name: "Standard",
  scope: ["src/feature.ts"],
  profile: "standard",
  lead: "developer",
  roster: ["developer"],
};
const AUTHORITY_PROFILE = loadProfile("constitution");
if (!AUTHORITY_PROFILE?.checkpoint_policy) throw new Error("constitution profile must expose checkpoint policy");
const AUTHORITY_POLICY = AUTHORITY_PROFILE.checkpoint_policy;
const AUTHORITY_STAGE = AUTHORITY_PROFILE.stages.find((stage) => stage.id === "constitution_validate");
if (!AUTHORITY_STAGE?.checkpoint) throw new Error("constitution profile must expose validation checkpoint");
const STAGE_ID = AUTHORITY_STAGE.id;
const CHECKPOINT_POLICY_RULE = AUTHORITY_POLICY.rules[AUTHORITY_STAGE.checkpoint];
if (!CHECKPOINT_POLICY_RULE) throw new Error("constitution checkpoint rule is required");
const PROFILE_HASH = profileHash(AUTHORITY_PROFILE);

function makeProject(): string {
  return mkdtempSync(join(tmpdir(), "cto-dod-integrity-"));
}

function seedFeature(root: string, featureId: string, runKey: string): void {
  writeFileSync(join(root, "CONSTITUTION.md"), "# Project Constitution v1.0.0\n\n## I. Quality\n\nShip tested work.\n", "utf8");
  const constitution = ensureProjectConstitution(root, { origin_kind: "cto_preparation", origin_run_key: runKey, origin_stage: "cto" });
  assert.ok(constitution.ok && constitution.value.binding, constitution.ok ? "fixture constitution binding must be available" : constitution.error);
  if (!constitution.ok || !constitution.value.binding) throw new Error("fixture constitution prerequisite failed");
  const constitutionBinding = constitution.value.binding as unknown as Json;
  const handoff = validImplementationHandoff({ featureId }) as unknown as Json;
  handoff.constitution_binding = constitutionBinding;
  handoff.execution_choices = ["cto"];
  const { handoff_id: _id, handoff_digest: _digest, schema_version: _schema, status: _status, ...handoffBody } = handoff;
  handoff.handoff_digest = digestOf(handoffBody);
  const handoffRef = String(handoff.handoff_id);
  const statePath = `.work-state/features/${featureId}/state.json`;
  const handoffPath = `.work-state/features/${featureId}/artifacts/implementation_handoff/${handoffRef}.json`;
  const workspace = validFeatureWorkspace({ featureId, status: "implementation_ready", withApprovedSpecify: true, constitutionBinding: constitutionBinding as never }) as unknown as Json;
  workspace.constitution_gate_ref = String(constitution.value.gate_id);
  workspace.schema_version = 3;
  workspace.project_root = root;
  const pinned = PinnedProjectRoot.open(root);
  assert.ok(pinned, "test project root must be pinnable");
  if (pinned) {
    workspace.project_root_identity = {
      canonical_path: pinned.canonical_root,
      dev: pinned.dev,
      ino: pinned.ino,
    };
    pinned.close();
  }
  workspace.workspace_path = `specs/${featureId}`;
  workspace.state_path = statePath;
  workspace.handoff_ref = handoffRef;
  workspace.execution_claim_ref = null;
  workspace.execution_claim_prepare_ref = null;
  const upstreamHash = (phase: string) => digestOf({ feature_id: featureId, phase, version: 1 });
  workspace.phases = (workspace.phases as Json[]).map((phase) => {
    const phaseId = String(phase.phase);
    const upstream_versions = phaseId === "specify"
      ? []
      : phaseId === "plan"
        ? [{ phase: "specify", version: 1, hash: upstreamHash("specify") }]
        : [
          { phase: "specify", version: 1, hash: upstreamHash("specify") },
          { phase: "plan", version: 1, hash: upstreamHash("plan") },
        ];
    return {
      ...phase,
      status: "approved",
      current_version: 1,
      approved_version: 1,
      validation_ref: `validation.${phaseId}.v1`,
      checkpoint_ref: `checkpoint.${phaseId}.v1`,
      upstream_versions,
    };
  });
  mkdirSync(join(root, "specs", featureId), { recursive: true });
  mkdirSync(join(root, ".work-state", "features", featureId, "artifacts", "implementation_handoff"), { recursive: true });
  const bindingRoot = PinnedProjectRoot.open(root);
  assert.ok(bindingRoot, "test project root must be pinnable for path binding");
  if (bindingRoot) {
    workspace.path_binding = captureWorkspacePathBinding(bindingRoot, featureId, { claimStorage: "optional" });
    bindingRoot.close();
  }
  writeFileSync(join(root, statePath), JSON.stringify({ schema: 1, run_key: runKey, state_revision: 1, specification: workspace }));
  writeFileSync(join(root, handoffPath), JSON.stringify(handoff));
}

function dod(label: string, source = "handoff"): DoD {
  return {
    items: [{
      id: "dod-1",
      source,
      criterion: `the ${label} contract is met`,
      verify_method: "focused test",
      status: "pending",
      evidence: "",
    }],
    type_requirements_met: true,
    updated_at: "2026-09-02T00:00:00.000Z",
  };
}

function preparationInput(
  ctoRunId: string,
  featureId: string,
  runKey: string,
  contract = "baseline",
  source = "handoff",
): CtoSpecificationExecutionPreparationInput {
  return {
    cto_run_id: ctoRunId,
    task: "execute the approved specification",
    branch: "main",
    classification: CLASSIFICATION,
    selections: [{ feature_id: featureId, run_key: runKey }],
    teams: [{
      team: TEAM_DEF.id,
      task_ref: { feature_id: featureId, task_id: "T-1" },
      scope: [...TEAM_DEF.scope],
      profile: TEAM_DEF.profile,
      worktree: "same_branch",
      depends_on: [],
      classification: CLASSIFICATION,
      workflow: "standard",
      dod: dod(contract, source),
    }],
  };
}

function prepareCtoSpecificationExecution(
  root: string,
  input: CtoSpecificationExecutionPreparationInput,
  options: { defs: readonly TeamDef[]; sessionId?: string } = { defs: [TEAM_DEF] },
): ReturnType<typeof prepareCtoSpecificationExecutionRaw> {
  const sessionId = options.sessionId ?? "integrity-session";
  const runtime = openTestCtoRuntime(root, sessionId, `cto-dod-integrity-${sessionId}`);
  try {
    return prepareCtoSpecificationExecutionRaw(root, input, { ...options, runtimeAccess: runtime.access, sessionId });
  } finally {
    runtime.close();
  }
}

function prepare(root: string, input: CtoSpecificationExecutionPreparationInput): Preparation {
  const result = prepareCtoSpecificationExecution(root, input, { defs: [TEAM_DEF], sessionId: "integrity-session" });
  assert.equal(result.status, "ready", JSON.stringify(result));
  if (result.status !== "ready") throw new Error(`preparation failed: ${JSON.stringify(result)}`);
  return result;
}

function preparedTeam(root: string, runId: string): { state: CtoState; team: CtoState["teams"][number]; dodFile: string } {
  const state = readCtoState(runId, root);
  assert.ok(state, "prepared CtoState must be readable");
  if (!state) throw new Error("prepared CtoState is missing");
  assert.equal(state.teams.length, 1);
  const team = state.teams[0]!;
  assert.ok(team.dod_path);
  if (!team.dod_path) throw new Error("prepared team must have a DoD path");
  return { state, team, dodFile: join(root, team.dod_path, "dod.json") };
}

type MountedCtoTool = { name: string; execute: (...args: unknown[]) => Promise<{ details: unknown }>; close: () => void; sessionManager?: { cwd: string; getSessionId: () => string; getCwd: () => string } };

function mountedCtoAskTool(root: string, runId: string, runtime: ReturnType<typeof openTestCtoRuntime>): MountedCtoTool {
  const registered: MountedCtoTool[] = [];
  const sessionManager = runtime.sessionManager;
  const pi = {
    zod: { z: zod },
    on: (event: string, handler: (event: unknown, context: unknown) => unknown) => {
      if (event === "session_start") handler({}, { cwd: root, mode: "rpc", hasUI: true, sessionManager, ui: { askDialog: async () => undefined } });
    },
    registerTool: (tool: unknown) => registered.push(tool as MountedCtoTool),
    setLabel: () => undefined,
  };
  const sessionContext = { cwd: root, mode: "rpc", hasUI: true, sessionManager, ui: { askDialog: async () => undefined } };
  const registration = beginRegistryRegistration(runtime.registryContext, root, ["workflow_profiles", "workflow_tools", "constitution_gate", "runtime_config"]);
  if (!registration.ok) throw new Error(`${registration.code}: ${registration.error}`);
  let bindingController: TeamSessionBindingController | undefined;
  let initialBinding: TeamSessionRuntimeBinding | undefined;
  let closed = false;
  const close = (): void => {
    if (closed) return;
    closed = true;
    const binding = initialBinding;
    initialBinding = undefined;
    if (binding && bindingController) bindingController.release(binding);
  };
  try {
    registerTeamWorkflow(pi as never, {
      cwd: root,
      owner: () => runtime.owner,
      registrationToken: registration.token,
      initialSessionContext: sessionContext,
      onSessionBindingController: (controller) => {
        bindingController = controller;
        initialBinding = controller.current(sessionContext);
        if (!initialBinding) throw new Error("mounted CTO initial session binding is unavailable");
      },
    });
    registerCtoTools(pi as never, { resolveCwd: (ctx) => (ctx as { cwd: string }).cwd, owner: () => runtime.owner, registrationToken: registration.token });
    commitRegistryRegistration(registration.token);
    runtime.refreshAccess();
  } catch (error) {
    close();
    try { rollbackRegistryRegistration(registration.token); } catch { /* preserve original */ }
    throw error;
  }
  const tool = registered.find((candidate) => candidate.name === "cto_checkpoint_ask_selected");
  if (!tool) {
    close();
    throw new Error("mounted CTO selected Ask tool is unavailable");
  }
  return { ...tool, close, sessionManager };
}

async function withAuthenticatedRuntime<T>(root: string, sessionId: string, run: (runtime: ReturnType<typeof openTestCtoRuntime>) => Promise<T> | T): Promise<T> {
  const runtime = openTestCtoRuntime(root, sessionId, `cto-dod-integrity-${sessionId}`);
  try { return await run(runtime); } finally { runtime.close(); }
}

async function confirmPrepared(root: string, preparation: Preparation, featureId: string, runKey: string): Promise<Json> {
  return withAuthenticatedRuntime(root, "integrity-session", async (runtime) => {
    const preflight = await preflightCtoSpecificationExecution(root, {
      cto_run_id: preparation.cto_run_id,
      selections: [{ feature_id: featureId, run_key: runKey }],
    }, { runtimeAccess: runtime.access, sessionId: "integrity-session" });
    assert.equal(preflight.status, "ready", JSON.stringify(preflight));
    if (preflight.status !== "ready") throw new Error(`preflight failed: ${JSON.stringify(preflight)}`);
    const mapping = preflight.mapping as unknown as Json;
    const askInput: Json = {
      cto_run_id: preparation.cto_run_id,
      mapping_id: String(mapping.mapping_id),
      mapping_hash: String(mapping.mapping_hash),
      mapping_version: Number(mapping.mapping_version),
      feature_id: featureId,
      run_key: runKey,
      stage_id: "execution",
    };
    const askTool = mountedCtoAskTool(root, preparation.cto_run_id, runtime);
    let asked: { details: unknown };
    try {
      asked = await askTool.execute("fixture-host-ask", askInput, undefined, undefined, {
        cwd: root,
        mode: "rpc",
        hasUI: true,
        sessionManager: askTool.sessionManager,
        ui: {
          askDialog: async (questions: Array<{ id: string; question: string; header?: string; options: Array<{ label: string }> }>) => {
            const question = questions[0];
            if (!question) return undefined;
            return { kind: "submit" as const, results: [{ id: question.id, question: question.question, header: question.header, options: question.options.map((option) => option.label), multi: false, selectedOptions: ["approve_continue"] }] };
          },
        },
      });
    } finally {
      askTool.close();
    }
    const askedDetails = asked.details as Json;
    assert.equal(askedDetails.status, "answered", JSON.stringify(askedDetails));
    const confirmed = await confirmCtoSpecificationMapping(root, {
      cto_run_id: preparation.cto_run_id,
      mapping_id: String(mapping.mapping_id),
      mapping_hash: String(mapping.mapping_hash),
      answer_id: String(askedDetails.trusted_answer_ref),
    }, { runtimeAccess: runtime.access, sessionId: "integrity-session" });
    assert.equal(confirmed.status, "confirmed", JSON.stringify(confirmed));
    if (confirmed.status !== "confirmed") throw new Error(`confirmation failed: ${JSON.stringify(confirmed)}`);
    return mapping;
  });
}


test("a structurally valid DoD tamper after preparation blocks dispatch before any claim", async () => {
  const root = makeProject();
  const featureId = "dod-tamper-dispatch";
  const runKey = `run-${featureId}-1`;
  const runId = "cto-dod-tamper-dispatch";
  try {
    seedFeature(root, featureId, runKey);
    const preparation = prepare(root, preparationInput(runId, featureId, runKey));
    const mapping = await confirmPrepared(root, preparation, featureId, runKey);
    const prepared = preparedTeam(root, runId);
    const original = JSON.parse(readFileSync(prepared.dodFile, "utf8")) as Json;
    const tampered = {
      ...original,
      items: [(original.items as Json[])[0] ? { ...(original.items as Json[])[0], criterion: "attacker-controlled but structurally valid" } : {}],
    };
    writeFileSync(prepared.dodFile, `${JSON.stringify(tampered, null, 2)}\n`);

    const dispatch = await withAuthenticatedRuntime(root, "integrity-session", (runtime) => dispatchCtoSpecificationMapping(root, {
      cto_run_id: runId,
      mapping_id: String(mapping.mapping_id),
      expected_mapping_hash: String(mapping.mapping_hash),
    }, { runtimeAccess: runtime.access, sessionId: "integrity-session" }));
    assert.equal(dispatch.status, "blocked", JSON.stringify(dispatch));
    assert.equal(dispatch.dispatched, false);
    assert.match(JSON.stringify(dispatch), /DoD digest mismatch|DoD/i);
    const claims = readExecutionClaimStore(root, featureId);
    assert.ok(claims.ok, claims.ok ? "" : claims.error);
    if (claims.ok) assert.equal(claims.value.filter((claim) => claim.status === "active").length, 0, "DoD rejection must happen before claim acquisition");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});


test("preparation replay detects a mismatched current DoD artifact instead of replaying stale state", () => {
  const root = makeProject();
  const featureId = "dod-replay-artifact";
  const runKey = `run-${featureId}-1`;
  const runId = "cto-dod-replay-artifact";
  try {
    seedFeature(root, featureId, runKey);
    const input = preparationInput(runId, featureId, runKey);
    prepare(root, input);
    const prepared = preparedTeam(root, runId);
    const originalDigest = prepared.team.dod_digest;
    const current = JSON.parse(readFileSync(prepared.dodFile, "utf8")) as Json;
    (current.items as Json[])[0]!.criterion = "changed after preparation but still valid";
    writeFileSync(prepared.dodFile, `${JSON.stringify(current, null, 2)}\n`);

    const replay = prepareCtoSpecificationExecution(root, input, { defs: [TEAM_DEF], sessionId: "integrity-session" });
    assert.equal(replay.status, "blocked", JSON.stringify(replay));
    assert.match(JSON.stringify(replay), /different preparation identity|takeover|DoD|artifact/i);
    const persisted = preparedTeam(root, runId);
    assert.equal(persisted.team.dod_digest, originalDigest, "replay rejection must not rewrite canonical state");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("specification execution re-read rejects a handoff replacement without mutating feature state", () => {
  const root = makeProject();
  const featureId = "handoff-execution-reread";
  const runKey = `run-${featureId}-1`;
  const runId = "cto-handoff-execution-reread";
  try {
    seedFeature(root, featureId, runKey);
    const input = preparationInput(runId, featureId, runKey);
    const featureStatePath = join(root, ".work-state", "features", featureId, "state.json");
    const beforeFeatureState = readFileSync(featureStatePath);
    let reads = 0;
    setCanonicalHandoffReadTestHooks({
      afterRead: ({ path }) => {
        reads += 1;
        if (reads === 2) writeFileSync(path, Buffer.from([0xff, 0xfe, 0x7b]));
      },
    }, root);
    const blocked = prepareCtoSpecificationExecution(root, input, { defs: [TEAM_DEF], sessionId: "integrity-session" });
    assert.equal(blocked.status, "blocked", JSON.stringify(blocked));
    assert.ok(reads >= 2, "preparation must re-read the canonical handoff after gate eligibility");
    assert.match(JSON.stringify(blocked), /changed|handoff|unreadable/i);
    assert.deepEqual(readFileSync(featureStatePath), beforeFeatureState, "failed preparation must not mutate feature state");
  } finally {
    setCanonicalHandoffReadTestHooks(null, root);
    rmSync(root, { recursive: true, force: true });
  }
});

test("borrowed-pin eligibility rejects root and ancestor symlink swaps before preparation mutation", () => {
  const cases = ["root", "work-state", "feature-parent"] as const;
  for (const swap of cases) {
    const root = makeProject();
    const featureId = `borrowed-pin-${swap}`;
    const runKey = `run-${featureId}-1`;
    const runId = `cto-borrowed-pin-${swap}`;
    const outside = mkdtempSync(join(tmpdir(), `cto-borrowed-pin-outside-${swap}-`));
    const displaced = `${root}.displaced`;
    const beforeRootStatePath = join(root, ".work-state", "features", featureId, "state.json");
    try {
      seedFeature(root, featureId, runKey);
      const before = readFileSync(beforeRootStatePath);
      setCtoSpecificationPreparationTestHooks({
        afterEligibilityGate: () => {
          if (swap === "root") {
            renameSync(root, displaced);
            mkdirSync(root, { recursive: true });
          } else {
            const target = swap === "work-state"
              ? join(root, ".work-state")
              : join(root, ".work-state", "features");
            renameSync(target, displaced);
            symlinkSync(outside, target);
          }
        },
      }, root);
      const blocked = prepareCtoSpecificationExecution(root, preparationInput(runId, featureId, runKey), { defs: [TEAM_DEF], sessionId: "borrowed-pin" });
      assert.equal(blocked.status, "blocked", `${swap}: ${JSON.stringify(blocked)}`);
      assert.equal(blocked.prepared, false);
      assert.equal(blocked.dispatched, false);
      if (swap === "root") {
        assert.deepEqual(readFileSync(join(displaced, ".work-state", "features", featureId, "state.json")), before);
      } else if (swap === "work-state") {
        assert.deepEqual(readFileSync(join(displaced, "features", featureId, "state.json")), before);
      } else {
        assert.deepEqual(readFileSync(join(displaced, featureId, "state.json")), before);
      }
    } finally {
      setCtoSpecificationPreparationTestHooks(null, root);
      if (swap === "root") {
        rmSync(root, { recursive: true, force: true });
        if (existsSync(displaced)) renameSync(displaced, root);
      } else {
        const target = swap === "work-state"
          ? join(root, ".work-state")
          : join(root, ".work-state", "features");
        unlinkSync(target);
        renameSync(displaced, target);
        rmSync(root, { recursive: true, force: true });
      }
      rmSync(displaced, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  }
});

test("anchor binding rejects a legacy unknown-field state without unpinned fallback writes", () => {
  const cases = ["root", "work-state", "feature-parent"] as const;
  for (const swap of cases) {
    const root = makeProject();
    const featureId = `anchor-legacy-unknown-${swap}`;
    const runKey = `run-${featureId}-1`;
    const runId = `cto-anchor-legacy-unknown-${swap}`;
    const displaced = `${root}.displaced`;
    const outside = mkdtempSync(join(tmpdir(), `cto-anchor-legacy-outside-${swap}-`));
    let failure: { code: string; error: string } | undefined;
    let swapped = false;
    try {
      seedFeature(root, featureId, runKey);
      setCtoSpecificationPreparationTestHooks({
        beforeAnchorBind: () => {
          const statePath = join(root, ".work-state", "features", featureId, "state.json");
          const state = JSON.parse(readFileSync(statePath, "utf8")) as Json;
          (state.specification as Json).legacy_unknown_field = "must not trigger migration";
          writeFileSync(statePath, JSON.stringify(state));
        },
        afterAnchorBindFailure: ({ code, error }) => {
          failure = { code, error };
          swapped = true;
          if (swap === "root") {
            renameSync(root, displaced);
            mkdirSync(root, { recursive: true });
          } else {
            const target = swap === "work-state"
              ? join(root, ".work-state")
              : join(root, ".work-state", "features");
            renameSync(target, displaced);
            symlinkSync(outside, target);
          }
        },
      }, root);
      const result = prepareCtoSpecificationExecution(root, preparationInput(runId, featureId, runKey), { defs: [TEAM_DEF], sessionId: "anchor-legacy" });
      assert.equal(result.status, "blocked", `${swap}: ${JSON.stringify(result)}`);
      assert.equal(failure?.code, "SPEC_STATE_INVALID", `${swap}: ${JSON.stringify(failure)}`);
      assert.match(failure?.error ?? "", /unknown field/i);
      assert.equal(existsSync(join(root, ".work-state", "team-state.json")), false, `${swap}: replacement must not receive a synthetic legacy team state`);
      if (swap === "root") {
        assert.equal(existsSync(join(root, ".work-state", "features")), false, "root replacement must not receive feature state");
      } else if (swap === "work-state") {
        assert.equal(existsSync(join(outside, "team-state.json")), false, "work-state symlink target must remain untouched");
        assert.equal(existsSync(join(outside, "features", featureId)), false, "work-state symlink target must not receive feature state");
      } else {
        assert.equal(existsSync(join(outside, featureId)), false, "feature-parent symlink target must remain untouched");
      }
      const displacedStatePath = swap === "root"
        ? join(displaced, ".work-state", "features", featureId, "state.json")
        : swap === "work-state"
          ? join(displaced, "features", featureId, "state.json")
          : join(displaced, featureId, "state.json");
      assert.equal(existsSync(displacedStatePath), true, `${swap}: original state must remain displaced and untouched`);
    } finally {
      setCtoSpecificationPreparationTestHooks(null, root);
      if (swapped) {
        if (swap === "root") {
          rmSync(root, { recursive: true, force: true });
          renameSync(displaced, root);
        } else {
          const target = swap === "work-state"
            ? join(root, ".work-state")
            : join(root, ".work-state", "features");
          unlinkSync(target);
          renameSync(displaced, target);
        }
      }
      rmSync(root, { recursive: true, force: true });
      rmSync(displaced, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  }
});

test("preparation replay rejects a changed run-level classification", () => {
  const root = makeProject();
  const featureId = "classification-replay-mismatch";
  const runKey = `run-${featureId}-1`;
  const runId = "cto-classification-replay-mismatch";
  try {
    seedFeature(root, featureId, runKey);
    const input = preparationInput(runId, featureId, runKey);
    prepare(root, input);
    const replay = prepareCtoSpecificationExecution(root, {
      ...input,
      classification: { ...input.classification, complexity: "COMPLEX" },
    }, { defs: [TEAM_DEF], sessionId: "integrity-session" });
    assert.equal(replay.status, "blocked", JSON.stringify(replay));
    assert.match(JSON.stringify(replay), /preparation identity|classification|digest/i);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});


test("the same feature/task in separate cto_run_ids gets distinct immutable DoD paths and digests", () => {
  const root = makeProject();
  const featureId = "dod-run-isolation";
  const runKey = `run-${featureId}-1`;
  try {
    seedFeature(root, featureId, runKey);
    const first = prepare(root, preparationInput("cto-dod-run-one", featureId, runKey, "first"));
    const second = prepare(root, preparationInput("cto-dod-run-two", featureId, runKey, "second"));
    const firstSlice = first.slices[0]!;
    const secondSlice = second.slices[0]!;
    assert.notEqual(firstSlice.dod_path, secondSlice.dod_path);
    assert.match(firstSlice.dod_path, /cto-dod-run-one/);
    assert.match(secondSlice.dod_path, /cto-dod-run-two/);
    assert.notEqual(readFileSync(join(root, firstSlice.dod_path, "dod.json"), "utf8"), readFileSync(join(root, secondSlice.dod_path, "dod.json"), "utf8"));
    assert.notEqual(firstSlice.work_identity.run_id, secondSlice.work_identity.run_id);
    const firstState = preparedTeam(root, "cto-dod-run-one");
    const secondState = preparedTeam(root, "cto-dod-run-two");
    assert.notEqual(firstState.team.dod_digest, secondState.team.dod_digest);
    assert.equal(firstState.team.feature_id, secondState.team.feature_id);
    assert.equal(firstState.team.task_id, secondState.team.task_id);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});


test("pinned DoD reads reject a path replacement by symlink before dispatch admission", () => {
  const root = makeProject();
  const outside = makeProject();
  const featureId = "dod-pinned-read";
  const runKey = `run-${featureId}-1`;
  const runId = "cto-dod-pinned-read";
  try {
    seedFeature(root, featureId, runKey);
    prepare(root, preparationInput(runId, featureId, runKey));
    const prepared = preparedTeam(root, runId);
    const outsideDod = join(outside, "dod.json");
    writeFileSync(outsideDod, readFileSync(prepared.dodFile, "utf8"));
    unlinkSync(prepared.dodFile);
    symlinkSync(outsideDod, prepared.dodFile);
    const pinned = PinnedProjectRoot.open(root);
    assert.ok(pinned, "prepared project root must be pinnable");
    if (!pinned) return;
    try {
      const reason = validateSliceDoD(prepared.state, prepared.team.id, pinned);
      assert.match(reason ?? "", /unreadable|symlink|changed|regular/i);
      const gate = assertCtoSliceDispatchable(prepared.state, {
        sliceId: prepared.team.slice_id!,
        markerRunId: runId,
        pinnedRoot: pinned,
      });
      assert.equal(gate.ok, false, "a symlink replacement must not pass the pinned dispatch gate");
    } finally {
      pinned.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test("preparation WAL rolls back every injected cross-tree failure and permits exact retry", () => {
  const points: CtoSpecificationPreparationFailurePoint[] = [
    "after_dod_write",
    "after_feature_capability_write",
    "before_wave_commit",
  ];
  for (const point of points) {
    const root = makeProject();
    const featureId = `prep-wal-${point.replaceAll("_", "-")}`;
    const runKey = `run-${featureId}`;
    const runId = `cto-${featureId}`;
    try {
      seedFeature(root, featureId, runKey);
      const input = preparationInput(runId, featureId, runKey);
      const featureStatePath = join(root, ".work-state", "features", featureId, "state.json");
      const beforeFeatureState = readFileSync(featureStatePath, "utf8");
      let injected = false;
      setCtoSpecificationPreparationTestHooks({
        afterWrite: (failurePoint) => {
          if (failurePoint === point) {
            injected = true;
            throw new Error(`injected ${point}`);
          }
        },
      }, root);
      const failed = prepareCtoSpecificationExecution(root, input, { defs: [TEAM_DEF], sessionId: "integrity-session" });
      assert.equal(injected, true, `failure hook must run at ${point}`);
      assert.equal(failed.status, "blocked", JSON.stringify(failed));
      setCtoSpecificationPreparationTestHooks(null, root);

      const state = readCtoState(runId, root);
      assert.ok(state, "WAL recovery must leave a durable CTO state");
      if (state) {
        assert.equal(state.active_wave_id, undefined, "rollback must not leave an active wave");
        assert.equal(state.specification_preparation_transaction?.status, "rolled_back");
        assert.equal(state.wave_history?.some((wave) => wave.source === "specification-execution"), false);
        const dodPath = state.teams[0]?.dod_path;
        if (dodPath) assert.equal(existsSync(join(root, dodPath, "dod.json")), false, "created DoD must be removed on rollback");
      }
      assert.equal(readFileSync(featureStatePath, "utf8"), beforeFeatureState, "feature capability mutation must restore its exact preimage");

      const retried = prepareCtoSpecificationExecution(root, input, { defs: [TEAM_DEF], sessionId: "integrity-session" });
      assert.equal(retried.status, "ready", JSON.stringify(retried));
    } finally {
      setCtoSpecificationPreparationTestHooks(null, root);
      rmSync(root, { recursive: true, force: true });
    }
  }
});


test("CTO DoD provenance source round-trips through producer and engine reader", () => {
  const root = makeProject();
  const featureId = "dod-provenance-roundtrip";
  const runKey = `run-${featureId}-1`;
  const runId = "cto-dod-provenance-roundtrip";
  const source = "readable-cto-passing.handoff.v1/T-1";
  try {
    seedFeature(root, featureId, runKey);
    const projection = canonicalCtoDoDProjection(dod("roundtrip", source));
    assert.equal(projection.items[0]?.source, source);
    prepare(root, preparationInput(runId, featureId, runKey, "roundtrip", source));
    const prepared = preparedTeam(root, runId);
    const pinned = PinnedProjectRoot.open(root);
    assert.ok(pinned, "prepared project root must be pinnable");
    if (!pinned) return;
    try {
      assert.equal(validateSliceDoD(prepared.state, prepared.team.id, pinned), null);
    } finally {
      pinned.close();
    }

    for (const hostile of [
      "",
      "source\nline",
      "source\u0000byte",
      "x".repeat(16 * 1024 + 1),
    ]) {
      assert.throws(
        () => canonicalCtoDoDProjection(dod("hostile", hostile)),
        /malformed|duplicated|DoD item/u,
        `hostile source must be rejected: ${JSON.stringify(hostile.slice(0, 32))}`,
      );
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("pinned CTO DoD authority refuses a symlinked project root", () => {
  const realRoot = makeProject();
  const symlinkRoot = realRoot + ".link";
  symlinkSync(realRoot, symlinkRoot, "dir");
  try {
    assert.equal(PinnedProjectRoot.open(symlinkRoot), null, "a symlinked project-root authority must be rejected before any DoD read");
  } finally {
    rmSync(symlinkRoot, { recursive: true, force: true });
    rmSync(realRoot, { recursive: true, force: true });
  }
});

