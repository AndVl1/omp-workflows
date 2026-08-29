import { test } from "node:test";
import assert from "node:assert/strict";
import { createCtoModeReminderHandler, CTO_MODE_MARKER, buildCtoModeReminder, injectCtoModeReminder } from "../src/cto-mode-reminder.js";
import { runtimeFixture } from "./runtime-fixtures.js";

const USER_MSG = { role: "user", content: [{ type: "text", text: "original user prompt" }], timestamp: 1 };
const ASSISTANT_MSG = { role: "assistant", content: [{ type: "text", text: "thinking…" }], timestamp: 2 };

test("cto-reminder: buildCtoModeReminder renders the delegation contract with exact run identity", () => {
  const root = "/tmp/cto-reminder-run";
  const fixture = runtimeFixture(root, { runId: "pr-watch" });
  const text = buildCtoModeReminder({ run_identity: fixture.run_identity, task: "Watch PRs and fix findings" });
  assert.ok(text.includes(CTO_MODE_MARKER), "marker line present");
  assert.ok(text.includes("pr-watch"), "run id present");
  assert.ok(text.includes("Watch PRs and fix findings"), "task present");
  assert.ok(text.includes("DELEGATE, do not absorb"), "delegation headline");
  assert.ok(text.includes("never code or patch yourself"), "orchestrator rule");
  assert.ok(text.includes("escalate what you cannot decide to the CTO"), "lead rule");
  assert.ok(text.includes("never re-delegate"), "worker rule");
  assert.doesNotMatch(text, /task\(agent=(?:@)?cto\)/, "nested CTO dispatch is not advertised");
});

test("cto-reminder: injectCtoModeReminder prepends a steering user message", () => {
  const result = injectCtoModeReminder([USER_MSG, ASSISTANT_MSG], "REMINDER");
  assert.ok(result, "injection produced a result");
  assert.equal(result!.messages.length, 3, "one message prepended");
  const first = result!.messages[0] as { role: string; steering?: boolean; content: Array<{ type: string; text: string }> };
  assert.equal(first.role, "user");
  assert.equal(first.steering, true, "steering flag set");
  assert.ok(first.content.some((c) => c.type === "text" && c.text.includes("REMINDER")), "reminder text carried");
});

test("cto-reminder: injectCtoModeReminder dedupes when the marker is already present", () => {
  const withMarker = {
    role: "user",
    content: [{ type: "text", text: `some message ${CTO_MODE_MARKER} already here` }],
    timestamp: 1,
  };
  assert.equal(injectCtoModeReminder([withMarker, ASSISTANT_MSG], "REMINDER"), undefined, "no double injection within one snapshot");
});

test("cto-reminder: injectCtoModeReminder returns undefined on unusable snapshots", () => {
  assert.equal(injectCtoModeReminder([], "REMINDER"), undefined);
  assert.equal(injectCtoModeReminder(undefined as unknown as unknown[], "REMINDER"), undefined);
});

test("cto-reminder: handler uses the caller-owned exact run resolver", () => {
  const fixture = runtimeFixture("/tmp/cto-reminder-handler", { runId: "handler-run" });
  const handler = createCtoModeReminderHandler(() => ({ run_identity: fixture.run_identity, task: "handler task" }));
  const result = handler({ messages: [USER_MSG, ASSISTANT_MSG] } as never, {});
  assert.ok(result, "caller-owned resolver activates the reminder");
  assert.ok(JSON.stringify(result).includes("handler-run"), "reminder preserves the resolved run identity");
});
