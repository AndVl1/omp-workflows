import assert from "node:assert/strict";
import { join } from "node:path";
import { readRunState } from "../src/engine/run-store.js";
import {
  ordinaryHarness,
  ordinaryIngress,
  implementationOutput,
  requireTool,
  submission,
  toolDetails,
  type Handoff,
  type WorkerFixture,
} from "./reliable-stage-execution-fixture.js";
import { scenarioTest } from "./reliable-stage-trace.js";

function dispatchFor(root: string, runId: string, toolCallId: string) {
  const state = readRunState(root, runId);
  assert.ok(state, "canonical ordinary run must remain readable");
  const matches = state.dispatch_capability?.dispatches.filter((entry) => entry.tool_call_id === toolCallId) ?? [];
  assert.equal(matches.length, 1, "the SDK parent call must identify exactly one admitted canonical dispatch");
  return { state, dispatch: matches[0]! };
}

scenarioTest("[O:R25] registered ordinary async task acknowledgement waits for exact SDK child terminal lifecycle", async () => {
  const harness = ordinaryHarness();
  try {
    const { runId, handoff } = await ordinaryIngress(harness, {
      task: "reconcile an asynchronous ordinary SDK worker terminal",
      prepare_id: "sdk-terminal-prepare",
      begin_id: "sdk-terminal-begin",
    });
    const roster = handoff.expected_roster[0];
    const marker = handoff.dispatch_markers[0];
    assert.ok(roster && marker, "the registered handoff must contain its declared worker slot");
    const callId = "sdk-terminal-task-call";
    const input = { agent: roster.agent, task: marker.marker };
    const admitted = await harness.emit("tool_call", { toolName: "task", toolCallId: callId, input }, harness.context);
    assert.equal(admitted.filter((result) => result && typeof result === "object" && (result as Record<string, unknown>).block === true).length, 0, JSON.stringify(admitted));
    await harness.emit("tool_execution_start", { toolName: "task", toolCallId: callId, args: input }, harness.context);

    // Match OMP 18.0.6's async TaskToolDetails payload. This early parent
    // result is an acknowledgement, before any child lifecycle start/terminal.
    await harness.emit("tool_result", {
      toolName: "task",
      toolCallId: callId,
      input,
      details: {
        async: { type: "task", jobId: "sdk-terminal-job", state: "running" },
        results: [],
      },
      content: [{ type: "text", text: "Still Running" }],
      isError: false,
    }, harness.context);
    const { dispatch } = dispatchFor(harness.root, runId, callId);
    assert.equal(dispatch.status, "pending", "an active async acknowledgement must retain the canonical dispatch as pending");
    assert.equal(dispatch.pending?.pending_reason, "provider_running");

    const childFile = join(harness.root, "sdk-terminal-worker.jsonl");
    const childId = "reliable-sdk-terminal-worker";
    const worker: WorkerFixture = {
      toolCallId: callId,
      input,
      childFile,
      childContext: {
        cwd: harness.root,
        mode: "print",
        hasUI: false,
        session_id: childId,
        sessionFile: childFile,
        sessionManager: {
          getCwd: () => harness.root,
          getSessionId: () => childId,
          getSessionFile: () => childFile,
          getHeader: () => ({ id: childId, cwd: harness.root, parentSession: harness.context.sessionFile }),
        },
      },
    };
    const lifecycle = {
      id: `${callId}-lifecycle`,
      agent: input.agent,
      agentSource: "project",
      status: "started",
      sessionFile: childFile,
      parentToolCallId: callId,
      index: 0,
    } as const;
    await harness.emit("task:subagent:lifecycle", lifecycle);

    // Publish through the registered producer tool so the engine creates the
    // accepted immutable receipt; the test never fabricates receipt evidence.
    const submitted = toolDetails((await requireTool(harness, "workflow_submit_result").execute(
      "sdk-terminal-submit",
      submission({
        implementation: implementationOutput({
          ready: true,
          validation_run: true,
          validation_evidence: "registered ordinary SDK terminal lifecycle fixture producer validation passed",
        }),
      }),
      undefined,
      undefined,
      worker.childContext,
    )).details);
    assert.equal(submitted.ok, true, JSON.stringify(submitted));
    const afterReceipt = dispatchFor(harness.root, runId, callId);
    const receipt = afterReceipt.state.stage_receipts?.[dispatch.id];
    assert.ok(receipt && typeof receipt.receipt_id === "string", "the accepted worker result must have its persisted engine receipt");
    assert.equal(afterReceipt.dispatch.status, "pending", "a valid accepted receipt is not worker terminal proof");

    const terminal = { ...lifecycle, status: "completed" };
    const unrelatedEvents = [
      { ...terminal, parentToolCallId: `${callId}-other` },
      { ...terminal, index: 1 },
      { ...terminal, agent: `${input.agent}-other` },
      { ...terminal, sessionFile: join(harness.root, "other-worker.jsonl") },
    ];
    for (const event of unrelatedEvents) {
      await harness.emit("task:subagent:lifecycle", event);
      const afterUnrelated = dispatchFor(harness.root, runId, callId).dispatch;
      assert.equal(afterUnrelated.status, "pending", "a wrong parent, slot, agent, or child session must not settle this dispatch");
    }

    await harness.emit("task:subagent:lifecycle", terminal);
    const afterTerminal = dispatchFor(harness.root, runId, callId);
    assert.equal(afterTerminal.dispatch.status, "succeeded", "the exact SDK completed lifecycle must reconcile the original ordinary dispatch");
    assert.equal(afterTerminal.dispatch.completion?.outcome, "succeeded");
    const terminalImage = JSON.stringify(afterTerminal.state);
    await harness.emit("task:subagent:lifecycle", terminal);
    assert.equal(JSON.stringify(readRunState(harness.root, runId)), terminalImage, "exact lifecycle replay must be nonmutating");

    const typedHandoff = handoff as Handoff & { branch: string; workflow: string; profile_hash: string };
    const checkpointContext = {
      token: typedHandoff.advance_token,
      capability_id: typedHandoff.capability_id,
      run_key: typedHandoff.run_key,
      branch: typedHandoff.branch,
      workflow: typedHandoff.workflow,
      stage_cursor: typedHandoff.stage_cursor,
      cursor_epoch: typedHandoff.cursor_epoch,
      checkpoint: "approve_implementation",
      checkpoint_id: "approve_implementation",
      checkpoint_kind: "implementation_approval",
      loop_iteration: typedHandoff.loop_iteration,
    };
    const ask = toolDetails((await requireTool(harness, "workflow_checkpoint_ask").execute(
      "sdk-terminal-checkpoint-ask",
      checkpointContext,
      undefined,
      undefined,
      harness.context,
    )).details);
    assert.equal(ask.ok, true, JSON.stringify(ask));
    assert.ok(ask.actor_provenance, "the registered checkpoint ask must return trusted human provenance");
    const recorded = toolDetails((await requireTool(harness, "workflow_checkpoint").execute(
      "sdk-terminal-checkpoint-record",
      {
        ...checkpointContext,
        profile_hash: typedHandoff.profile_hash,
        authorization: "human",
        actor_provenance: ask.actor_provenance,
        decision: ask.decision,
        rationale: "accept the terminal ordinary SDK worker result",
      },
      undefined,
      undefined,
      harness.context,
    )).details);
    assert.equal(recorded.ok, true, JSON.stringify(recorded));
    const advanced = toolDetails((await requireTool(harness, "workflow_advance").execute(
      "sdk-terminal-advance",
      {
        ...checkpointContext,
        profile_hash: typedHandoff.profile_hash,
        evidence: "registered ordinary SDK terminal lifecycle and accepted result",
      },
      undefined,
      undefined,
      harness.context,
    )).details);
    assert.equal(advanced.ok, true, JSON.stringify(advanced));
  } finally {
    await harness.close();
  }
});