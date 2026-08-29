/**
 * Core /cto command contract tests.
 *
 * <!-- omp-cto-slice run=01a03ee4-7dd6-7580-8ad7-16d26dc886ba slice=workflow-v2-core -->
 *
 * The command adapter is intentionally pure. Provider admission, policy,
 * session ownership and persistence belong to the protocol-v2 host.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { readWorkflowProfile, workflowV2Fixture } from "./workflow-v2-fixtures.js";
import {
  buildAmendPrompt,
  buildCtoPrompt,
  buildStandbyCtoPrompt,
  ctoCommand,
  parseEnvelope,
  renderChannelSection,
} from "../src/commands/cto.js";

import type { WorkflowCommandContext } from "../src/commands/envelope.js";

const fixture = workflowV2Fixture(readWorkflowProfile("lightweight"), {
  session: { session_id: "session-1", lifecycle_id: "lifecycle-1" },
  runId: "run-1",
});
const workflowContext: WorkflowCommandContext = {
  branch: "feature/oauth",
  project_identity: fixture.project_identity,
  run_identity: fixture.run_identity,
  effectivePolicy: fixture.effective_policy,
  catalog: fixture.catalog,
  agentInventory: fixture.agent_inventory,
};

test("cto command parses only the shared task envelope", () => {
  const envelope = parseEnvelope("действуй автономно: Add OAuth issue=#3", "feature/oauth");
  assert.deepEqual(envelope, {
    task: "Add OAuth",
    autonomyHint: true,
    issue: 3,
    branch: "feature/oauth",
  });

  const lookalike = parseEnvelope("[AUTONOMOUSLY] Add OAuth", "feature/oauth");
  assert.equal(lookalike.autonomyHint, false);
  assert.equal(lookalike.task, "[AUTONOMOUSLY] Add OAuth");
  assert.equal(parseEnvelope("Add OAuth", "/absolute/path").branch, null);
});

test("cto prompt exposes PHASE-0 and the complete workflow matrix", () => {
  const prompt = buildCtoPrompt(parseEnvelope("Add OAuth", "feature/oauth"), workflowContext, { sessionId: "session-1" });
  assert.match(prompt, /### PHASE 0: INTELLIGENT CLASSIFICATION/);
  assert.match(prompt, /\| REVIEW \| review \| review \| review \| review \|/);
  assert.match(prompt, /\| HOTFIX \| emergency \| emergency \| emergency \| emergency \|/);
  assert.match(prompt, /provider-qualified agents/);
  assert.match(prompt, /Never write canonical state/);
  assert.match(prompt, /<!-- omp-cto-slice run=<runId> slice=<sliceId> -->/);
  assert.doesNotMatch(prompt, /teams\.json|escalation\.json|runCto/);
});

test("cto standby and channel helpers are host-managed and side-effect free", () => {
  const standby = buildStandbyCtoPrompt(workflowContext);
  assert.match(standby, /\/cto standby/);
  assert.match(standby, /typed task\/inbox event/);
  assert.match(standby, /does not authorize provider selection/);

  const channel = renderChannelSection(workflowContext);
  assert.match(channel, /host-managed/);
  assert.match(channel, /Do not inspect channel files/);
});

test("cto amend prompt consumes caller-supplied typed state", () => {
  const active = {
    state: {
      run_identity: workflowContext.run_identity,
      teams: [
        { id: "backend", status: "in_progress" },
        { id: "frontend", status: "pending" },
      ],
    },
  };
  const prompt = buildAmendPrompt(parseEnvelope("Task B", "feature/oauth"), workflowContext, active as never, {
    sessionId: "session-1",
  });
  assert.match(prompt, /Run: `run-1`/);
  assert.match(prompt, /Teams: backend:in_progress, frontend:pending/);
  assert.match(prompt, /fresh identity-bound capability/);
  assert.doesNotMatch(prompt, /active run discovery|teams\.json/);
});

test("ctoCommand does not notify or access command context authority", async () => {
  const notifications: string[] = [];
  const context = {
    args: "Add OAuth",
    cwd: "/tmp/cto-command-test",
    workflowContext,
    sessionId: "session-1",
    ui: { notify: (message: string) => notifications.push(message) },
  };
  const prompt = ctoCommand(context);
  assert.match(prompt, /Add OAuth/);
  assert.deepEqual(notifications, []);

  const standby = ctoCommand({ ...context, args: "" });
  assert.match(standby, /\/cto standby/);
  assert.deepEqual(notifications, []);
  assert.equal(typeof await Promise.resolve(prompt), "string");
});
