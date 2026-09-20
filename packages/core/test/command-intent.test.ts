import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { registerWorkflowCommands } from "../src/commands/register.js";
import { createWorkflowSessionController } from "../src/engine/host-controller.js";
import { LifecycleError } from "../src/engine/run-lifecycle.js";
import type { TrustedExecutionContext } from "../src/engine/types.js";

type CommandHandler = (args: string, ctx: unknown) => Promise<void>;

type CommandHarness = {
  commands: Map<string, { handler: CommandHandler }>;
  prompts: string[];
  pi: {
    registerCommand(name: string, command: { handler: CommandHandler }): void;
    sendUserMessage(prompt: string): void;
  };
};

function commandHarness(): CommandHarness {
  const commands = new Map<string, { handler: CommandHandler }>();
  const prompts: string[] = [];
  const pi = {
    registerCommand(name: string, command: { handler: CommandHandler }) {
      commands.set(name, command);
    },
    sendUserMessage(prompt: string) {
      prompts.push(prompt);
    },
  };
  return { commands, prompts, pi };
}

function trustedContext(root: string, sessionId = "command-intent-session"): TrustedExecutionContext {
  return {
    session_id: sessionId,
    caller: "host",
    process_id: process.pid,
    worktree: root,
    branch: "main",
    authority: "coordinator",
  };
}

function lifecycleConflict(action: () => unknown): void {
  assert.throws(action, (error: unknown) => error instanceof LifecycleError && error.code === "lifecycle_request_conflict");
}

test("command intent is opaque, two-phase, exact, one-shot, and release-cleared", () => {
  const root = mkdtempSync(join(tmpdir(), "command-intent-controller-"));
  try {
    const controller = createWorkflowSessionController({ cwd: root, context: trustedContext(root) });
    const issued = controller.issueCommandIntent("resume");
    assert.match(issued.intent_id, /^[0-9a-f-]{36}$/);

    lifecycleConflict(() => controller.consumeCommandIntent({ command_intent_id: issued.intent_id, mode: "new" }));
    lifecycleConflict(() => controller.consumeCommandIntent({ command_intent_id: "wrong-token", mode: "resume" }));

    const reserved = controller.consumeCommandIntent({ command_intent_id: issued.intent_id, mode: "resume" });
    assert.deepEqual(reserved, issued);
    // A read-only retry may reserve the same trusted token again.
    assert.deepEqual(controller.consumeCommandIntent({ command_intent_id: issued.intent_id, mode: "resume" }), issued);
    controller.commitCommandIntent(issued.intent_id);
    lifecycleConflict(() => controller.consumeCommandIntent({ command_intent_id: issued.intent_id, mode: "resume" }));

    const old = controller.issueCommandIntent("resume", "run-a");
    const replacement = controller.issueCommandIntent("rework", "run-b");
    assert.notEqual(old.intent_id, replacement.intent_id);
    lifecycleConflict(() => controller.consumeCommandIntent({ command_intent_id: old.intent_id, mode: "resume", run_id: "run-a" }));
    assert.deepEqual(controller.consumeCommandIntent({ command_intent_id: replacement.intent_id, mode: "rework", run_id: "run-b" }), replacement);

    // An explicit resume without --run remains bound to the command while a
    // selector error is read-only; the model may retry with its chosen run.
    const unbound = controller.issueCommandIntent("resume");
    assert.deepEqual(controller.consumeCommandIntent({ command_intent_id: unbound.intent_id, mode: "resume", run_id: "selected-run" }), unbound);
    controller.clearCommandIntent();

    const released = controller.issueCommandIntent("new");
    controller.release("test-release");
    lifecycleConflict(() => controller.consumeCommandIntent({ command_intent_id: released.intent_id, mode: "new" }));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("explicit do-work and team commands carry intent; implicit/list commands clear it", async () => {
  const root = mkdtempSync(join(tmpdir(), "command-intent-commands-"));
  try {
    const controller = createWorkflowSessionController({ cwd: root, context: trustedContext(root, "command-handler-session") });
    const harness = commandHarness();
    registerWorkflowCommands(harness.pi as never, {
      resolveCwd: () => root,
      getSessionController: () => controller,
      buildDoWorkPrompt: (envelope) => `${envelope.mode}:${envelope.command_intent_id ?? "missing"}`,
    });
    const ctx = {
      cwd: root,
      sessionManager: { getCwd: () => root, getSessionId: () => "command-handler-session" },
      ui: { notify() {} },
    };

    await harness.commands.get("do-work")!.handler("--resume continue", ctx);
    const firstPrompt = harness.prompts.at(-1)!;
    assert.match(firstPrompt, /^resume:[0-9a-f-]{36}$/);
    const firstToken = firstPrompt.slice("resume:".length);
    assert.deepEqual(controller.consumeCommandIntent({ command_intent_id: firstToken, mode: "resume" })?.intent_id, firstToken);

    await harness.commands.get("team")!.handler("--resume alias", ctx);
    const teamPrompt = harness.prompts.at(-1)!;
    assert.match(teamPrompt, /^resume:[0-9a-f-]{36}$/);
    assert.notEqual(teamPrompt.slice("resume:".length), firstToken);

    await harness.commands.get("do-work")!.handler("plain implicit task", ctx);
    lifecycleConflict(() => controller.consumeCommandIntent({ command_intent_id: teamPrompt.slice("resume:".length), mode: "resume" }));

    await harness.commands.get("do-work")!.handler("--list", ctx);
    assert.match(harness.prompts.at(-1)!, /No workflow runs found\./);
    assert.equal(controller.consumeCommandIntent({ mode: "new" }), undefined);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
