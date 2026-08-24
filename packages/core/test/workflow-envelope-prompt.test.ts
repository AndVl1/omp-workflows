import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildDoWorkPrompt } from "../src/commands/do-work.js";

test("do-work prompt makes workflow tool envelopes and marker source explicit", () => {
  const root = mkdtempSync(join(tmpdir(), "do-work-envelope-prompt-"));
  try {
    const prompt = buildDoWorkPrompt(
      { task: "Prepare a specification", autonomyHint: false, autonomous: false, issue: null, branch: null },
      root,
    );

    assert.match(prompt, /native workflow control tools return.*content.*text.*details/i);
    assert.match(prompt, /Python `eval`.*json\.loads\(r\[.text.\]\)/i);
    assert.match(prompt, /never.*json\.loads\(r\)/i);
    assert.match(prompt, /workflow_begin.*handoff\.dispatch_markers/i);
    assert.match(prompt, /workflow_instructions.*does not contain.*dispatch_markers/i);
    assert.match(prompt, /require.*ok.*true.*before.*reading/i);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("do-work prompt specifies the exact flat workflow approval artifact shape", () => {
  const root = mkdtempSync(join(tmpdir(), "do-work-approval-shape-prompt-"));
  try {
    const prompt = buildDoWorkPrompt(
      { task: "Prepare a specification", autonomyHint: false, autonomous: false, issue: null, branch: null },
      root,
    );
    assert.match(prompt, /Persist exactly this flat typed `workflow_approval` artifact/);
    for (const field of ["type", "version", "decision", "run_key", "source_workflow", "source_stage", "actor", "decided_at"]) {
      assert.match(prompt, new RegExp(`\\b${field}\\b`), `prompt names ${field}`);
    }
    assert.match(prompt, /exact `source_workflow` and `source_stage` field names/);
    assert.match(prompt, /never invented `workflow`\/`stage` aliases/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("do-work prompt binds workflow_complete to the persisted dispatch record id", () => {
  const root = mkdtempSync(join(tmpdir(), "do-work-dispatch-id-prompt-"));
  try {
    const prompt = buildDoWorkPrompt(
      { task: "Complete a delegated implementation", autonomyHint: false, autonomous: false, issue: null, branch: null },
      root,
    );
    const statusIndex = prompt.indexOf("After every task result, immediately call `workflow_status`");
    const completionIndex = prompt.indexOf("workflow_complete.dispatch_id");

    assert.ok(statusIndex >= 0, "prompt requires workflow_status after every task result");
    assert.ok(completionIndex > statusIndex, "dispatch identity is selected after workflow_status");
    assert.match(prompt, /`capability\.dispatches\[\]`/i);
    assert.match(prompt, /select the single persisted dispatch record/i);
    assert.match(prompt, /exact `role`, `agent`, and `tool_call_id` binding/i);
    assert.match(prompt, /pass exactly that record's `id` verbatim as `workflow_complete\.dispatch_id`/i);
    assert.match(prompt, /If no unique matching persisted record exists, fail closed/i);
    assert.match(prompt, /preserve the exact current dispatch token, capability identity.*capability_id.*stage_cursor.*cursor_epoch.*profile_hash/i);
    assert.match(prompt, /actual outcome, evidence, and artifact IDs/i);
    assert.match(prompt, /one-batch\/declared-roster, actor\/path, and stale-branch rules/i);

    for (const forbidden of [
      /job IDs?/i,
      /task-call IDs?/i,
      /capability IDs?/i,
      /role names?/i,
      /synthesized(?:\/derived)? IDs?/i,
    ]) {
      assert.match(prompt, forbidden);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("do-work prompt requires target capability marker rollover after workflow_handoff", () => {
  const root = mkdtempSync(join(tmpdir(), "do-work-target-rollover-prompt-"));
  try {
    const prompt = buildDoWorkPrompt(
      { task: "Continue after an approved handoff", autonomyHint: false, autonomous: false, issue: null, branch: null },
      root,
    );
    const handoffIndex = prompt.indexOf("On success, discard the source envelope");
    const instructionsIndex = prompt.indexOf("On the target, call `workflow_instructions`");
    const targetTaskIndex = prompt.indexOf("For every target");
    const advanceIndex = prompt.indexOf("After every target `workflow_advance`");

    assert.ok(handoffIndex >= 0, "handoff success must enter target continuation");
    assert.ok(instructionsIndex > handoffIndex, "target instructions follow handoff");
    assert.ok(targetTaskIndex > instructionsIndex, "target dispatch rules follow target instructions");
    assert.ok(advanceIndex > targetTaskIndex, "target rollover follows target dispatch rules");
    assert.match(prompt, /`workflow_handoff` returns a fresh target capability/i);
    assert.match(prompt, /source credentials(?:,| and) dispatch markers.*invalid immediately/i);
    assert.match(prompt, /call `workflow_instructions`.*fresh target handoff/i);
    assert.match(prompt, /For every target .*copy the latest target `handoff\.dispatch_markers\[\]\.marker`.*verbatim.*each role/i);
    assert.match(prompt, /After every target `workflow_advance`, call `workflow_status`.*`workflow_instructions`/i);
    assert.match(prompt, /replace the marker.*epoch.*roster.*newly returned values/i);
    assert.match(prompt, /never retry.*stale source.*previous-stage marker/i);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("do-work prompt requires declared artifacts under the returned feature directory", () => {
  const root = mkdtempSync(join(tmpdir(), "do-work-artifact-path-prompt-"));
  const artifactRoot = [".", "work-state"].join("") + "/artifacts";
  try {
    const prompt = buildDoWorkPrompt(
      { task: "Produce a typed implementation artifact", autonomyHint: false, autonomous: false, issue: null, branch: null },
      root,
    );
    assert.match(prompt, /authenticated feature-scoped `state\.artifactsDir`/i);
    assert.match(prompt, /every producer MUST write each declared artifact under that returned directory/i);
    assert.match(prompt, /`<artifact_id>\.json`/);
    assert.match(prompt, /`<artifact_id>-<slot>\.json`/);
    assert.ok(prompt.includes(`root ${artifactRoot}`), "prompt forbids the root artifact directory");
    assert.match(prompt, /guess an artifact path/i);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
