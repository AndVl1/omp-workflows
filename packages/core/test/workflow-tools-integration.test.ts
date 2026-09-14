/**
 * Integration coverage for the index-mounted workflow tools.
 *
 * These cases exercise the authenticated host registration boundary in
 * addition to the durable engine, so they intentionally import the public
 * index entrypoint rather than the engine-only test fixtures.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z as zod } from "zod";
import { TEST_CONTEXT, TEST_SESSION_MANAGER } from "./fixtures/registrar-host.js";
import { openTestRegistry, writeTestRegistryMarker } from "./fixtures/registry-activation.js";
import { loadProfile, profileHash } from "../src/engine/profile.js";
import { registerWorkflowTools } from "../src/index.js";
import { ensureProjectConstitution } from "../src/specification/prerequisite.js";
import { createFeatureWorkspace } from "../src/specification/workspace.js";
import { resolveState, writeState } from "../src/engine/state.js";
import type { AgentMappingState } from "../src/engine/agent-mapping.js";
import type { CapabilityHandoff } from "../src/engine/durable.js";

function initGit(root: string, branch: string): void {
  execFileSync("git", ["-C", root, "init", "--quiet", "--initial-branch", branch], { stdio: "ignore" });
}

test("wave-004: workflow tools invoke beforeBegin per transition with the exact current cwd; hook rejection fails advance closed", async () => {
  const root = mkdtempSync(join(tmpdir(), "wave004-tool-hook-"));
  const otherRoot = mkdtempSync(join(tmpdir(), "wave004-tool-hook-other-"));
  try {
    initGit(root, "feat/tool-hook");
    const profile = loadProfile("lightweight");
    assert.ok(profile);
    writeState(root, {
      schema: 1,
      branch: "feat/tool-hook",
      run_key: "feat/tool-hook",
      classification: { type: "FEATURE", complexity: "QUICK", confidence: "HIGH", autonomous: false, workflow: "lightweight" },
      task: "per-transition hook regression",
      workflow_override: false,
      issue: null,
      stage_cursor: "implementation",
      stages: profile.stages.map((stage) => ({ id: stage.id, status: stage.id === "implementation" ? "in_progress" as const : "pending" as const })),
      artifacts: {},
      pause: { kind: "none" as const, reason: "" },
      policy: { strict_orchestrator: true },
      profile_hash: profileHash(profile),
      scope: { scope: ["backend-kotlin"], has_security: false, has_infra: false, has_ui: false, has_runtime: true, dev_agent: "developer-kotlin" },
      cursor_epoch: "fixture-epoch-0",
      updated_at: new Date().toISOString(),
    }, { featureSlug: "tool-hook" });

    const calls: string[] = [];
    const responses: Array<AgentMappingState | undefined | null> = [undefined, undefined, null];
    let hookFailure: Error | null = null;
    const registered: Array<{ name: string; parameters?: { safeParse: (value: unknown) => { success: boolean } }; execute: (id: string, params: unknown, signal: unknown, update: unknown, ctx: unknown) => Promise<{ details: { ok: boolean; code?: string; error?: string; handoff?: CapabilityHandoff } }> }> = [];
    const pi = {
      zod: { z: zod },
      on: (event: string, handler: (event: unknown, ctx: unknown) => unknown) => {
        if (event === "session_start") handler({}, TEST_CONTEXT(root));
      },
      registerTool: (tool: { name: string; execute: never }) => registered.push(tool as never),
    };
    TEST_SESSION_MANAGER.cwd = root;
    writeTestRegistryMarker(root);
    const registration = openTestRegistry(root, ["workflow_tools"], "repeated-role-tools");
    registerWorkflowTools(pi as unknown as Parameters<typeof registerWorkflowTools>[0], {
      owner: () => registration.owner,
      cwd: root,
      registrationToken: registration.token,
      resolveCwd: (ctx: unknown) => (ctx as { cwd?: string }).cwd,
      beforeBegin: (cwd: string) => {
        calls.push(cwd);
        if (hookFailure) throw hookFailure;
        return responses.shift();
      },
    });
    registration.retain(true);
    const beginTool = registered.find((tool) => tool.name === "workflow_begin");
    const advanceTool = registered.find((tool) => tool.name === "workflow_advance");
    assert.ok(beginTool && advanceTool, "workflow tools registered");

    // Begin consumes its own per-call hook with the begin cwd.
    const begun = await beginTool.execute("id", {}, undefined, undefined, { cwd: root, sessionManager: TEST_SESSION_MANAGER });
    assert.equal(begun.details.ok, true, begun.details.error ?? "begin ok");
    assert.deepEqual(calls, [root], "begin invoked the hook with its exact cwd");
    const handoff = begun.details.handoff;
    assert.ok(handoff);
    const advanceSchema = advanceTool.parameters;
    assert.ok(advanceSchema, "workflow_advance exposes its runtime schema");
    const canonicalAdvanceInput = {
      advance_token: handoff!.advance_token, capability_id: handoff!.capability_id, run_key: handoff!.run_key,
      branch: handoff!.branch, workflow: handoff!.workflow, profile_hash: handoff!.profile_hash,
      stage_cursor: handoff!.stage_cursor, cursor_epoch: handoff!.cursor_epoch, evidence: "stage completed",
    };
    assert.equal(advanceSchema!.safeParse(canonicalAdvanceInput).success, true, "workflow_advance accepts the mounted canonical advance_token contract");
    const { advance_token: _advanceToken, ...legacyAdvanceInput } = canonicalAdvanceInput;
    assert.equal(advanceSchema!.safeParse({ ...legacyAdvanceInput, token: handoff!.advance_token }).success, false, "workflow_advance rejects the retired token input alias");
    const checkpointTool = registered.find((tool) => tool.name === "workflow_checkpoint");
    const checkpointSchema = checkpointTool?.parameters;
    assert.ok(checkpointSchema, "workflow_checkpoint exposes its runtime schema");
    const canonicalCheckpointInput = {
      advance_token: handoff!.advance_token, capability_id: handoff!.capability_id, run_key: handoff!.run_key,
      branch: handoff!.branch, workflow: handoff!.workflow, profile_hash: handoff!.profile_hash,
      stage_cursor: handoff!.stage_cursor, cursor_epoch: handoff!.cursor_epoch, checkpoint: "approve_fix", checkpoint_id: "approve_fix", checkpoint_kind: "implementation_approval",
      authorization: "policy_auto" as const, actor_provenance: { kind: "system" as const, ref: "system" }, decision: "proceed", rationale: "approved",
    };
    assert.equal(checkpointSchema!.safeParse(canonicalCheckpointInput).success, true, "workflow_checkpoint accepts the mounted canonical advance_token contract");
    assert.equal(checkpointSchema!.safeParse({ ...canonicalCheckpointInput, evidence: "artifact digest" }).success, true, "workflow_checkpoint accepts bounded single-line evidence");
    assert.equal(checkpointSchema!.safeParse({ ...canonicalCheckpointInput, rationale: "approved\nwith copied prompt text" }).success, false, "workflow_checkpoint rejects multiline rationale");
    assert.equal(checkpointSchema!.safeParse({ ...canonicalCheckpointInput, token: handoff!.advance_token }).success, false, "workflow_checkpoint rejects the retired token input alias");

    // A later advance re-invokes the hook with the advance's own cwd — never
    // a cached mapping from the earlier transition or another project.
    const advancedOther = await advanceTool.execute("id", {
      advance_token: handoff.advance_token, capability_id: handoff.capability_id, run_key: handoff.run_key,
      branch: handoff.branch, workflow: handoff.workflow, profile_hash: handoff.profile_hash,
      stage_cursor: handoff.stage_cursor, cursor_epoch: handoff.cursor_epoch, evidence: "stage completed",
    }, undefined, undefined, { cwd: otherRoot, sessionManager: TEST_SESSION_MANAGER });
    assert.deepEqual(calls, [root, root], "authenticated registration keeps the hook on its bound project root");
    assert.equal(advancedOther.details.ok, false, "the other project has no workflow state");

    // Runtime null from the hook fails the advance closed (no fallback).
    const advancedNull = await advanceTool.execute("id", {
      advance_token: handoff.advance_token, capability_id: handoff.capability_id, run_key: handoff.run_key,
      branch: handoff.branch, workflow: handoff.workflow, profile_hash: handoff.profile_hash,
      stage_cursor: handoff.stage_cursor, cursor_epoch: handoff.cursor_epoch, evidence: "stage completed",
    }, undefined, undefined, { cwd: root, sessionManager: TEST_SESSION_MANAGER });
    assert.deepEqual(calls, [root, root, root], "null case re-invoked the hook on the bound project root");
    assert.equal(advancedNull.details.ok, false);
    assert.match(advancedNull.details.error ?? "", /trusted agent mapping handoff is malformed|proof is not an engine-issued|advance authorization fields must be bounded line-inert strings/);

    hookFailure = new Error("stale discovery markers");
    // A throwing hook (stale marker/freshness failure) fails the advance closed.
    const advancedThrow = await advanceTool.execute("id", {
      advance_token: handoff.advance_token, capability_id: handoff.capability_id, run_key: handoff.run_key,
      branch: handoff.branch, workflow: handoff.workflow, profile_hash: handoff.profile_hash,
      stage_cursor: handoff.stage_cursor, cursor_epoch: handoff.cursor_epoch, evidence: "stage completed",
    }, undefined, undefined, { cwd: root, sessionManager: TEST_SESSION_MANAGER });
    assert.equal(advancedThrow.details.ok, false);
    assert.match(advancedThrow.details.error ?? "", /stale discovery markers/);
    hookFailure = null;
    const state = resolveState(root);
    assert.equal(state.state?.stage_cursor, "implementation", "failed hook calls never advanced the cursor");
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(otherRoot, { recursive: true, force: true });
  }
});


test("specification control tools bind explicit selectors despite a stale active pointer", async () => {
  const root = mkdtempSync(join(tmpdir(), "spec-selector-isolation-"));
  try {
    initGit(root, "main");
    const profile = loadProfile("spec-preparation");
    assert.ok(profile);
    writeFileSync(join(root, "CONSTITUTION.md"), "# Project Constitution v1.0.0\n\n## I. Quality\n\nShip tested work.\n", "utf8");
    const constitution = ensureProjectConstitution(root, {
      origin_kind: "native_direct",
      origin_run_key: "run-selector-a",
      origin_stage: "specify",
    });
    assert.ok(constitution.ok && constitution.value.binding, constitution.ok ? "selector fixture constitution binding" : constitution.error);
    if (!constitution.ok || !constitution.value.binding) return;
    const create = (featureId: string, runKey: string) => createFeatureWorkspace(root, {
      feature_id: featureId,
      display_name: featureId,
      run_key: runKey,
      profile_name: "spec-preparation",
      profile_hash: profileHash(profile),
      constitution_binding: constitution.value.binding,
      constitution_gate_ref: constitution.value.gate_id,
    });
    assert.ok(create("selector-a", "run-selector-a").ok);
    assert.ok(create("selector-b", "run-selector-b").ok);
    assert.ok(create("unselected-seed", "run-unselected-seed").ok);
    assert.ok(create("foreign-seed", "run-foreign-seed").ok);

    let publishedMapping: AgentMappingState | undefined;
    const registered: Array<{ name: string; execute: (...args: any[]) => Promise<{ details: any }> }> = [];
    const pi = {
      zod: { z: zod },
      on: (event: string, handler: (event: unknown, ctx: unknown) => unknown) => {
        if (event === "session_start") handler({}, TEST_CONTEXT(root));
      },
      registerTool: (tool: { name: string; execute: never }) => registered.push(tool as never),
    };
    TEST_SESSION_MANAGER.cwd = root;
    writeTestRegistryMarker(root);
    const registration = openTestRegistry(root, ["workflow_tools"], "repeated-role-tools");
    registerWorkflowTools(pi as unknown as Parameters<typeof registerWorkflowTools>[0], {
      owner: () => registration.owner,
      cwd: root,
      registrationToken: registration.token,
      resolveCwd: (ctx: unknown) => (ctx as { cwd?: string }).cwd,
      beforeBegin: () => publishedMapping,
    });
    registration.retain(true);
    const tool = (name: string) => {
      const found = registered.find((candidate) => candidate.name === name);
      assert.ok(found, `${name} registered`);
      return found;
    };
    const classification = {
      type: "SPEC",
      complexity: "MEDIUM",
      confidence: "HIGH",
      autonomous: false,
      workflow: "spec-preparation",
    } as const;
    const prepare = tool("workflow_prepare");

    writeFileSync(join(root, ".work-state", ".active-feature"), "unselected-seed\n");
    const seedPath = join(root, ".work-state", "features", "unselected-seed", "state.json");
    const seedBefore = readFileSync(seedPath, "utf8");
    const implicit = await prepare.execute("id", {
      task: "must not seed implicitly",
      branch: "main",
      classification,
    }, undefined, undefined, { cwd: root, sessionManager: TEST_SESSION_MANAGER });
    assert.equal(implicit.details.ok, false);
    assert.equal(implicit.details.code, "WORKFLOW_SELECTOR_REQUIRED");
    assert.equal(readFileSync(seedPath, "utf8"), seedBefore, "implicit prepare mutates no envelope");

    const selectorBPath = join(root, ".work-state", "features", "selector-b", "state.json");
    const selectorBEnvelope = JSON.parse(readFileSync(selectorBPath, "utf8"));
    assert.deepEqual(Object.keys(selectorBEnvelope).sort(), ["run_key", "schema", "specification", "state_revision"], "B starts as the canonical bare specification envelope with transaction metadata");
    assert.equal(selectorBEnvelope.schema, 1);
    assert.equal(selectorBEnvelope.run_key, "run-selector-b");
    assert.equal(selectorBEnvelope.state_revision, 1);
    assert.equal(selectorBEnvelope.classification, undefined, "creation must not fabricate classification");
    assert.equal(selectorBEnvelope.roster_selection, undefined, "creation must not fabricate roster selection");
    assert.equal(selectorBEnvelope.dispatch_capability, undefined, "creation must not fabricate dispatch capability");

    const selectedBare = resolveState(root, "main", { feature_id: "selector-b", run_key: "run-selector-b" });
    assert.equal(selectedBare.invalid, undefined);
    assert.equal(selectedBare.state?.classification, undefined);
    assert.equal(selectedBare.state?.state_revision, 1);
    const bumped = updateStateAtomically(root, (snapshot) => snapshot.state
      ? { op: "commit", state: snapshot.state }
      : { op: "fail", code: "state_missing", error: "selector-b state is missing" }, {
        selector: { feature_id: "selector-b", run_key: "run-selector-b" },
        branch: "main",
      });
    assert.equal(bumped.ok, true, bumped.ok ? "" : bumped.error);
    if (bumped.ok) assert.equal(bumped.revision, 2, "minimal envelope revisions advance through CAS commits");
    const selectorBAfterCas = JSON.parse(readFileSync(selectorBPath, "utf8"));
    assert.equal(selectorBAfterCas.state_revision, 2);

    const prepareB = await prepare.execute("id", {
      task: "prepare selector-b",
      branch: "main",
      classification,
      feature_id: "selector-b",
      run_key: "run-selector-b",
    }, undefined, undefined, { cwd: root, sessionManager: TEST_SESSION_MANAGER });
    assert.equal(prepareB.details.ok, true, prepareB.details.error ?? "selector-b prepared");
    const selectorBAfterPrepare = JSON.parse(readFileSync(selectorBPath, "utf8"));
    assert.deepEqual(selectorBAfterPrepare.specification, selectorBEnvelope.specification, "prepare B preserves its exact specification aggregate");
    assert.equal(selectorBAfterPrepare.run_key, "run-selector-b");
    assert.equal(selectorBAfterPrepare.classification.workflow, "spec-preparation");

    const selectorAPath = join(root, ".work-state", "features", "selector-a", "state.json");
    const selectorABefore = JSON.parse(readFileSync(selectorAPath, "utf8"));
    const selectorBBefore = readFileSync(selectorBPath, "utf8");
    writeFileSync(join(root, ".work-state", ".active-feature"), "selector-b\n");

    const mismatched = await prepare.execute("id", {
      task: "reject a mismatched run",
      branch: "main",
      classification,
      feature_id: "selector-a",
      run_key: "run-selector-b",
    }, undefined, undefined, { cwd: root, sessionManager: TEST_SESSION_MANAGER });
    assert.equal(mismatched.details.ok, false);
    assert.equal(mismatched.details.code, "SPEC_RUN_MISMATCH");
    assert.equal(readFileSync(selectorAPath, "utf8"), JSON.stringify(selectorABefore, null, 2) + "\n");

    const foreignPath = join(root, ".work-state", "features", "foreign-seed", "state.json");
    const foreignEnvelope = JSON.parse(readFileSync(foreignPath, "utf8"));
    foreignEnvelope.specification.feature_id = "selector-a";
    writeFileSync(foreignPath, JSON.stringify(foreignEnvelope, null, 2) + "\n");
    const foreign = await prepare.execute("id", {
      task: "reject foreign aggregate identity",
      branch: "main",
      classification,
      feature_id: "foreign-seed",
      run_key: "run-foreign-seed",
    }, undefined, undefined, { cwd: root, sessionManager: TEST_SESSION_MANAGER });
    assert.equal(foreign.details.ok, false);
    assert.equal(foreign.details.code, "SPEC_STATE_INVALID");

    const prepareA = await prepare.execute("id", {
      task: "prepare selector-a while the active pointer selects selector-b",
      branch: "main",
      classification,
      feature_id: "selector-a",
      run_key: "run-selector-a",
    }, undefined, undefined, { cwd: root, sessionManager: TEST_SESSION_MANAGER });
    assert.equal(prepareA.details.ok, true, prepareA.details.error ?? "selector-a prepared");
    assert.equal(prepareA.details.state_path, realpathSync(selectorAPath));
    const selectorAAfter = JSON.parse(readFileSync(selectorAPath, "utf8"));
    assert.deepEqual(selectorAAfter.specification, selectorABefore.specification, "prepare preserves the selected specification aggregate");
    assert.equal(selectorAAfter.run_key, "run-selector-a");
    assert.equal(selectorAAfter.classification.workflow, "spec-preparation");
    assert.equal(readFileSync(selectorBPath, "utf8"), selectorBBefore, "stale-pointer state is not used or mutated");
    assert.equal(existsSync(join(root, ".work-state", "team-state.json")), false, "prepare creates no legacy root state");
    assert.equal(existsSync(join(root, ".work-state", "features", "default", "state.json")), false, "prepare creates no fallback feature state");

    writeFileSync(join(root, ".work-state", ".active-feature"), "selector-b\n");
    publishedMapping = publishMapping(root);
    const selectorA = { feature_id: "selector-a", run_key: "run-selector-a" };
    const statusBefore = await tool("workflow_status").execute("id", selectorA, undefined, undefined, { cwd: root, sessionManager: TEST_SESSION_MANAGER });
    assert.equal(statusBefore.details.ok, true);
    assert.equal(statusBefore.details.workflow, "spec-preparation");
    assert.equal(statusBefore.details.capability, null);

    const instructions = await tool("workflow_instructions").execute("id", selectorA, undefined, undefined, { cwd: root, sessionManager: TEST_SESSION_MANAGER });
    assert.equal(instructions.details.workflow, "spec-preparation");
    assert.equal(instructions.details.state.stageCursor, profile.stages[0]?.id);
    assert.match(instructions.details.provenance.statePath, /features\/selector-a\/state\.json$/);

    const begun = await tool("workflow_begin").execute("id", {
      ...selectorA,
      selection: { occurrences: [{ role: "specification-analyst" }] },
    }, undefined, undefined, { cwd: root, sessionManager: TEST_SESSION_MANAGER });
    assert.equal(begun.details.ok, true, begun.details.error ?? "explicit A begin accepted");
    assert.equal(begun.details.handoff.run_key, "run-selector-a");

    const selectedA = resolveState(root, undefined, selectorA);
    const selectedB = resolveState(root, undefined, { feature_id: "selector-b", run_key: "run-selector-b" });
    assert.equal(selectedA.state?.dispatch_capability?.status, "ready");
    assert.equal(selectedB.state?.dispatch_capability, undefined, "the active-pointer workspace was not mutated");

    const implicitStatus = await tool("workflow_status").execute("id", {}, undefined, undefined, { cwd: root, sessionManager: TEST_SESSION_MANAGER });
    assert.equal(implicitStatus.details.ok, false);
    assert.equal(implicitStatus.details.code, "WORKFLOW_SELECTOR_REQUIRED");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
