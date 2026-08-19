import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { createCapability, loadProfile, profileHash, writeState } from "@andvl1/omp-workflows-core";
import { registerWorkflowTools } from "../src/index.js";

type RegisteredTool = {
  name: string;
  parameters: unknown;
  execute: (...args: never[]) => Promise<{ content: [{ type: "text"; text: string }]; details: unknown }>;
};

test("fullstack: workflow tools register and fail closed with structured responses", async () => {
  const tools = new Map<string, RegisteredTool>();
  registerWorkflowTools({
    zod: { z },
    registerTool(tool: RegisteredTool) {
      tools.set(tool.name, tool);
    },
  } as never);

  assert.deepEqual([...tools.keys()], ["workflow_begin", "workflow_status", "workflow_instructions", "workflow_complete", "workflow_checkpoint", "workflow_advance", "workflow_handoff"]);
  for (const name of tools.keys()) {
    assert.ok(tools.get(name)?.parameters, `${name} exposes a parameter schema`);
  }

  const begin = tools.get("workflow_begin")!;
  const workerBeginResult = await begin.execute("worker", {}, undefined, undefined, { cwd: process.cwd(), hasUI: false } as never);
  assert.equal((workerBeginResult.details as { code?: string }).code, "WORKFLOW_CONTEXT_REJECTED");
  const status = tools.get("workflow_status")!;
  const beginResult = await begin.execute("test", {}, undefined, undefined, null);
  const statusResult = await status.execute("test", {}, undefined, undefined, null);
  const complete = tools.get("workflow_complete")!;
  const advance = tools.get("workflow_advance")!;
  const handoff = tools.get("workflow_handoff")!;
  const completeResult = await complete.execute("test", {
    dispatch_id: "dispatch",
    token: "token",
    capability_id: "capability",
    run_key: "run",
    cursor_epoch: "epoch",
    evidence: "evidence",
  }, undefined, undefined, null);
  const advanceResult = await advance.execute("test", {
    token: "token",
    capability_id: "capability",
    run_key: "run",
    cursor_epoch: "epoch",
    evidence: "evidence",
  }, undefined, undefined, null);
  const handoffResult = await handoff.execute("test", {
    token: "token",
    capability_id: "capability",
    run_key: "run",
    cursor_epoch: "epoch",
    workflow: "spec-preparation",
    profile_hash: "hash",
    stage_cursor: "handoff",
    target_workflow: "full-feature",
    approval: { kind: "artifact", ref: "workflow_approval", source_stage: "handoff", decision: "approved" },
  }, undefined, undefined, null);

  for (const response of [beginResult, statusResult, completeResult, advanceResult, handoffResult]) {
    assert.equal(response.details && typeof response.details, "object");
    assert.equal((response.details as { ok?: boolean }).ok, false);
    assert.match(response.content[0].text, /\"ok\":false/);
  }
  assert.equal((beginResult.details as { code?: string }).code, "WORKFLOW_STATE_UNAVAILABLE");
  assert.equal((statusResult.details as { code?: string }).code, "WORKFLOW_STATE_UNAVAILABLE");
  assert.equal((completeResult.details as { code?: string }).code, "WORKFLOW_STATE_UNAVAILABLE");
  assert.equal((advanceResult.details as { code?: string }).code, "WORKFLOW_STATE_UNAVAILABLE");
  assert.equal((handoffResult.details as { code?: string }).code, "WORKFLOW_STATE_UNAVAILABLE");

  // workflow_handoff is main-session-only, exactly like the other control tools.
  const workerHandoffResult = await handoff.execute("worker", {
    token: "token",
    capability_id: "capability",
    run_key: "run",
    cursor_epoch: "epoch",
    workflow: "spec-preparation",
    profile_hash: "hash",
    stage_cursor: "handoff",
    target_workflow: "full-feature",
    approval: { kind: "artifact", ref: "workflow_approval", source_stage: "handoff", decision: "approved" },
  }, undefined, undefined, { cwd: process.cwd(), hasUI: false } as never);
  assert.equal((workerHandoffResult.details as { code?: string }).code, "WORKFLOW_CONTEXT_REJECTED");
});

test("fullstack: workflow_handoff delegates to the engine and returns the one-time target envelope", async () => {
  const branch = "feat/handoff-tool";
  const root = mkdtempSync(join(tmpdir(), "workflow-handoff-tool-"));
  try {
    execFileSync("git", ["-C", root, "init", "--quiet", "--initial-branch", branch], { stdio: "ignore" });
    const sourceProfile = loadProfile("spec-preparation");
    assert.ok(sourceProfile, "shipped spec-preparation profile must load");
    const persistedHash = profileHash(sourceProfile);
    const issued = createCapability({
      run_key: branch, branch, workflow: "spec-preparation", profile_hash: persistedHash,
      stage_cursor: "handoff", kind: "none", expected_roster: [],
    });
    writeState(root, {
      schema: 1, branch, run_key: branch,
      classification: { type: "SPEC", complexity: "MEDIUM", confidence: "HIGH", autonomous: false, workflow: "spec-preparation" },
      task: "tool handoff", workflow_override: false, issue: null,
      stage_cursor: "handoff",
      stages: sourceProfile.stages.map((s) => ({ id: s.id, status: "done" as const })),
      artifacts: {}, pause: { kind: "done" as const, reason: "" },
      policy: { strict_orchestrator: true }, profile_hash: persistedHash,
      cursor_epoch: issued.state.issued_for!.cursor_epoch,
      dispatch_capability: { ...issued.state, status: "complete" as const, dispatches: [] },
      updated_at: new Date().toISOString(),
    }, { featureSlug: "handoff-tool" });
    const artifactsDir = join(root, ".work-state", "features", "handoff-tool", "artifacts");
    mkdirSync(artifactsDir, { recursive: true });
    writeFileSync(join(artifactsDir, "spec_handoff.json"), JSON.stringify({ goal: "g", scope: ["s"], acceptance_criteria: ["a"] }));
    writeFileSync(join(artifactsDir, "spec-preparation.json"), JSON.stringify({ ready: true }));
    writeFileSync(join(artifactsDir, "workflow_approval.json"), JSON.stringify({
      type: "workflow_approval", version: 1, decision: "approved",
      run_key: branch, workflow: "spec-preparation", stage: "handoff",
      actor: "user", decided_at: "2026-08-02T00:00:00.000Z",
    }));

    const tools = new Map<string, RegisteredTool>();
    registerWorkflowTools({ zod: { z }, registerTool(tool: RegisteredTool) { tools.set(tool.name, tool); } } as never);
    const handoff = tools.get("workflow_handoff")!;
    const result = await handoff.execute("test", {
      token: issued.advance_token,
      capability_id: issued.capability_id,
      run_key: branch, branch, workflow: "spec-preparation",
      profile_hash: persistedHash, stage_cursor: "handoff",
      cursor_epoch: issued.state.issued_for!.cursor_epoch,
      target_workflow: "full-feature",
      approval: { kind: "artifact", ref: "workflow_approval", source_stage: "handoff", decision: "approved" },
      actor: "orchestrator",
      handoff_context: { artifact_ids: ["spec_handoff"], decision_refs: [], summary: "approved" },
    }, undefined, undefined, { cwd: root } as never);
    const details = result.details as {
      ok: boolean;
      transition?: string;
      route?: unknown;
      handoff?: { workflow: string; stage_cursor: string; dispatch_token: string; advance_token: string };
      audit?: { id: string };
      state?: { workflow: string; stage_cursor: string };
      code?: string;
      error?: string;
    };
    assert.equal(details.ok, true, details.error);
    assert.equal(details.transition, "handoff");
    assert.equal(details.handoff?.workflow, "full-feature");
    assert.equal(details.handoff?.stage_cursor, "discovery");
    assert.ok(details.audit?.id, "audit record id present in the success envelope");
    assert.equal(details.state?.workflow, "full-feature");
    assert.equal(details.state?.stage_cursor, "discovery");

    // Plaintext secrets live only in the one-time envelope; state persists hashes.
    const persisted = JSON.parse(readFileSync(join(root, ".work-state", "features", "handoff-tool", "state.json"), "utf8")) as {
      dispatch_capability: { dispatch_token_hash: string; advance_token_hash: string };
    };
    assert.notEqual(persisted.dispatch_capability.dispatch_token_hash, details.handoff?.dispatch_token);
    assert.notEqual(persisted.dispatch_capability.advance_token_hash, details.handoff?.advance_token);

    // Engine rejection surfaces as the structured REJECTED envelope.
    const rejected = await handoff.execute("test", {
      token: issued.advance_token,
      capability_id: issued.capability_id,
      run_key: branch, branch, workflow: "spec-preparation",
      profile_hash: persistedHash, stage_cursor: "handoff",
      cursor_epoch: issued.state.issued_for!.cursor_epoch,
      target_workflow: "full-feature",
      approval: { kind: "artifact", ref: "workflow_approval", source_stage: "handoff", decision: "approved" },
    }, undefined, undefined, { cwd: root } as never);
    const rejectedDetails = rejected.details as { ok: boolean; code?: string; error?: string };
    assert.equal(rejectedDetails.ok, false);
    assert.equal(rejectedDetails.code, "WORKFLOW_HANDOFF_REJECTED");
    assert.match(rejectedDetails.error ?? "", /capability identity mismatch|not a completed handoff source/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
test("fullstack: mutable schema defaults are factories", () => {
  const strictZ = {
    ...z,
    array: (element: Parameters<typeof z.array>[0]) => {
      const schema = z.array(element);
      return new Proxy(schema, {
        get(target, property, receiver) {
          if (property !== "default") return Reflect.get(target, property, receiver);
          const defaultMethod = Reflect.get(target, property, receiver) as (value: unknown) => unknown;
          return (value: unknown) => {
            if (value !== null && typeof value === "object") {
              throw new Error("mutable default must be a factory");
            }
            return Reflect.apply(defaultMethod, target, [value]);
          };
        },
      });
    },
  } as typeof z;

  assert.doesNotThrow(() => {
    registerWorkflowTools({
      zod: { z: strictZ },
      registerTool() {},
    } as never);
  });
});
