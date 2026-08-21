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
