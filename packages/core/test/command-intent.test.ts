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
type EventHandler = (event: unknown, ctx: unknown) => unknown;

type CommandHarness = {
  commands: Map<string, { handler: CommandHandler }>;
  handlers: Map<string, EventHandler[]>;
  prompts: string[];
  setSendFailure(error?: Error, beforeThrow?: () => void): void;
  pi: {
    registerCommand(name: string, command: { handler: CommandHandler }): void;
    on(event: string, handler: EventHandler): void;
    sendUserMessage(prompt: string): void;
  };
};

function commandHarness(): CommandHarness {
  const commands = new Map<string, { handler: CommandHandler }>();
  const handlers = new Map<string, EventHandler[]>();
  const prompts: string[] = [];
  let sendFailure: Error | undefined;
  let beforeSendFailure: (() => void) | undefined;
  const pi = {
    registerCommand(name: string, command: { handler: CommandHandler }) {
      commands.set(name, command);
    },
    on(event: string, handler: EventHandler) {
      handlers.set(event, [...(handlers.get(event) ?? []), handler]);
    },
    sendUserMessage(prompt: string) {
      if (sendFailure) {
        const failure = sendFailure;
        const beforeThrow = beforeSendFailure;
        beforeSendFailure = undefined;
        beforeThrow?.();
        throw failure;
      }
      prompts.push(prompt);
    },
  };
  return {
    commands,
    handlers,
    prompts,
    setSendFailure(error?: Error, beforeThrow?: () => void) {
      sendFailure = error;
      beforeSendFailure = beforeThrow;
    },
    pi,
  };
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

test("registered workflow prompts arm private one-shot turn provenance", async () => {
  const root = mkdtempSync(join(tmpdir(), "command-intent-commands-"));
  const foreignRoot = mkdtempSync(join(tmpdir(), "command-intent-foreign-"));
  try {
    const sessionId = "command-handler-session";
    const foreignSessionId = "foreign-command-session";
    const controller = createWorkflowSessionController({ cwd: root, context: trustedContext(root, sessionId) });
    const replacementController = createWorkflowSessionController({ cwd: root, context: trustedContext(root, sessionId) });
    const foreignCwdController = createWorkflowSessionController({ cwd: foreignRoot, context: trustedContext(foreignRoot, sessionId) });
    const foreignSessionController = createWorkflowSessionController({ cwd: root, context: trustedContext(root, foreignSessionId) });
    const builtPrompts: string[] = [];
    const harness = commandHarness();
    const contextFor = (cwd: string, id: string) => ({
      cwd,
      sessionManager: { getCwd: () => cwd, getSessionId: () => id },
      ui: { notify() {} },
    });
    const hostContext = contextFor(root, sessionId);
    const foreignContext = contextFor(root, foreignSessionId);
    const foreignCwdContext = contextFor(foreignRoot, sessionId);
    let resolvedHostController = controller;
    const resolveController = (ctx: unknown, cwd: string) => {
      const value = ctx as { sessionManager?: { getSessionId?: () => unknown } };
      const id = value.sessionManager?.getSessionId?.();
      if (cwd === root && id === sessionId) return resolvedHostController;
      if (cwd === foreignRoot && id === sessionId) return foreignCwdController;
      if (cwd === root && id === foreignSessionId) return foreignSessionController;
      return undefined;
    };
    registerWorkflowCommands(harness.pi as never, {
      resolveCwd: (ctx) => {
        const value = ctx as { sessionManager?: { getCwd?: () => unknown } };
        const cwd = value.sessionManager?.getCwd?.();
        return typeof cwd === "string" ? cwd : undefined;
      },
      getSessionController: resolveController,
      buildDoWorkPrompt: (envelope) => {
        const prompt = `${envelope.mode}:${envelope.command_intent_id ?? "missing"}:${envelope.task}`;
        builtPrompts.push(prompt);
        return prompt;
      },
    });
    const beforeAgentStart = harness.handlers.get("before_agent_start")?.[0];
    assert.equal(typeof beforeAgentStart, "function");
    const start = (prompt: string, ctx: unknown, base: string[] = ["base-a", "base-b"]) =>
      beforeAgentStart!({ prompt, systemPrompt: base }, ctx);

    await harness.commands.get("do-work")!.handler("--new continue", hostContext);
    const firstPrompt = harness.prompts.at(-1)!;
    assert.match(firstPrompt, /^new:[0-9a-f-]{36}:continue$/);
    const firstTurn = start(firstPrompt, hostContext);
    const firstSystemPrompt = (firstTurn as { systemPrompt: string[] }).systemPrompt;
    assert.equal(typeof firstSystemPrompt[2], "string");
    assert.equal(firstSystemPrompt.length, 3);
    assert.deepEqual(firstSystemPrompt.slice(0, 2), ["base-a", "base-b"]);
    assert.match(firstSystemPrompt[2]!, /This request does not authorize dispatch/);
    assert.match(firstSystemPrompt[2]!, /only the current engine-returned workflow_begin handoff does/);
    assert.equal(start(firstPrompt, hostContext), undefined, "provenance is consumed exactly once");
    const firstToken = firstPrompt.slice("new:".length).split(":", 1)[0]!;
    assert.equal(controller.consumeCommandIntent({ command_intent_id: firstToken, mode: "new" })?.intent_id, firstToken);

    await harness.commands.get("team")!.handler("--resume alias", hostContext);
    const teamPrompt = harness.prompts.at(-1)!;
    assert.match(teamPrompt, /^resume:[0-9a-f-]{36}:alias$/);
    assert.ok(start(teamPrompt, hostContext));
    const teamToken = teamPrompt.slice("resume:".length).split(":", 1)[0]!;

    await harness.commands.get("team")!.handler("plain implicit task", hostContext);
    const implicitPrompt = harness.prompts.at(-1)!;
    assert.match(implicitPrompt, /^undefined:missing:plain implicit task$/);
    assert.ok(start(implicitPrompt, hostContext), "implicit /team invocation arms provenance");
    lifecycleConflict(() => controller.consumeCommandIntent({ command_intent_id: teamToken, mode: "resume" }));
    assert.equal(start(implicitPrompt, hostContext), undefined);

    await harness.commands.get("do-work")!.handler("mismatch task", hostContext);
    const mismatchPrompt = harness.prompts.at(-1)!;
    assert.equal(start(`${mismatchPrompt} copied`, hostContext), undefined);
    assert.equal(start(mismatchPrompt, hostContext), undefined, "same-session prompt mismatch consumes stale provenance");

    await harness.commands.get("do-work")!.handler("foreign cwd task", hostContext);
    const hostCwdPrompt = harness.prompts.at(-1)!;
    assert.equal(start(hostCwdPrompt, foreignCwdContext), undefined);
    await harness.commands.get("do-work")!.handler("foreign cwd task", foreignCwdContext);
    const foreignCwdPrompt = harness.prompts.at(-1)!;
    assert.ok(start(hostCwdPrompt, hostContext), "same session on another cwd cannot consume host provenance");
    assert.ok(start(foreignCwdPrompt, foreignCwdContext), "composite session/cwd records remain isolated");

    await harness.commands.get("do-work")!.handler("foreign session task", hostContext);
    const foreignSessionPrompt = harness.prompts.at(-1)!;
    assert.equal(start(foreignSessionPrompt, foreignContext), undefined);
    assert.ok(start(foreignSessionPrompt, hostContext), "foreign session cannot consume or clear host provenance");
    await harness.commands.get("do-work")!.handler("same identity controller task", hostContext);
    const sameIdentityPrompt = harness.prompts.at(-1)!;
    resolvedHostController = replacementController;
    assert.equal(start(sameIdentityPrompt, hostContext), undefined, "different controller cannot consume same identity provenance");
    resolvedHostController = controller;
    assert.equal(start(sameIdentityPrompt, hostContext), undefined, "controller mismatch consumes the candidate fail-closed");
    await harness.commands.get("do-work")!.handler("--new cleanup conflict", hostContext);
    const cleanupConflictPrompt = harness.prompts.at(-1)!;
    const newerCleanupIntent = controller.issueCommandIntent("new");
    assert.equal(start(`${cleanupConflictPrompt} mismatch`, hostContext), undefined, "mismatch consumes provenance before intent cleanup conflict");
    assert.equal(start(cleanupConflictPrompt, hostContext), undefined, "consumed cleanup-conflict provenance cannot replay");
    assert.equal(controller.consumeCommandIntent({ command_intent_id: newerCleanupIntent.intent_id, mode: "new" })?.intent_id, newerCleanupIntent.intent_id);

    await harness.commands.get("do-work")!.handler("send failure task", hostContext);
    const sendFailurePrompt = builtPrompts.at(-1)!;
    harness.setSendFailure(new Error("send failed"));
    await assert.rejects(harness.commands.get("do-work")!.handler("send failure task 2", hostContext), /send failed/);
    const failedPrompt = builtPrompts.at(-1)!;
    harness.setSendFailure();
    assert.equal(start(failedPrompt, hostContext), undefined, "synchronous send failure disarms its exact record");
    // The SDK surface here exposes only a synchronous throw; async rejection and
    // identical-text replay are intentionally not treated as observable rollback.
    let sendReentrantPrompt = "";
    harness.setSendFailure(new Error("send reentrant failed"), () => {
      harness.setSendFailure();
      void harness.commands.get("do-work")!.handler("--new send reentrant newer", hostContext);
      sendReentrantPrompt = builtPrompts.at(-1)!;
    });
    await assert.rejects(harness.commands.get("do-work")!.handler("send reentrant outer", hostContext), /send reentrant failed/);
    const sendReentrantOuterPrompt = builtPrompts.findLast(prompt => prompt.endsWith(":send reentrant outer"))!;
    harness.setSendFailure();
    assert.ok(start(sendReentrantPrompt, hostContext), "newer explicit send reentry remains armed");
    const sendReentrantToken = sendReentrantPrompt.split(":")[1]!;
    assert.equal(controller.consumeCommandIntent({ command_intent_id: sendReentrantToken, mode: "new" })?.intent_id, sendReentrantToken);
    assert.equal(start(sendReentrantOuterPrompt, hostContext), undefined, "older send-failure provenance cannot arm over newer reentry");
    assert.equal(start(sendFailurePrompt, hostContext), undefined, "a failed later invocation replaces the prior one-record binding");

    await harness.commands.get("do-work")!.handler("foreign lifecycle task", hostContext);
    const lifecycleHostPrompt = harness.prompts.at(-1)!;
    await harness.commands.get("do-work")!.handler("foreign lifecycle task", foreignContext);
    const lifecycleForeignPrompt = harness.prompts.at(-1)!;
    const sessionStop = harness.handlers.get("session_stop")?.[0];
    assert.equal(typeof sessionStop, "function");
    sessionStop!({ session_id: foreignSessionId }, foreignContext);
    assert.equal(start(lifecycleForeignPrompt, foreignContext), undefined);
    assert.ok(start(lifecycleHostPrompt, hostContext), "lifecycle cleanup is session-scoped");
    await harness.commands.get("do-work")!.handler("released lifecycle task", hostContext);
    const releasedLifecyclePrompt = harness.prompts.at(-1)!;
    controller.release("test-release");
    sessionStop!({ session_id: sessionId }, hostContext);
    assert.equal(start(releasedLifecyclePrompt, hostContext), undefined, "stop cleanup works after controller release");

    await harness.commands.get("do-work")!.handler("host cleanup task", hostContext);
    const hostCleanupPrompt = harness.prompts.at(-1)!;
    sessionStop!({ session_id: sessionId }, hostContext);
    assert.equal(start(hostCleanupPrompt, hostContext), undefined);
    await harness.commands.get("do-work")!.handler("host shutdown task", hostContext);
    const hostShutdownPrompt = harness.prompts.at(-1)!;
    const sessionShutdown = harness.handlers.get("session_shutdown")?.[0];
    assert.equal(typeof sessionShutdown, "function");
    sessionShutdown!({}, hostContext);
    assert.equal(start(hostShutdownPrompt, hostContext), undefined);

    await harness.commands.get("do-work")!.handler("seed usage cleanup", hostContext);
    const usagePendingPrompt = harness.prompts.at(-1)!;
    await harness.commands.get("do-work")!.handler("", hostContext);
    assert.equal(start(usagePendingPrompt, hostContext), undefined, "usage clears the current pending record");
    assert.equal(start(harness.prompts.at(-1)!, hostContext), undefined, "usage output never arms provenance");

    await harness.commands.get("do-work")!.handler("seed list cleanup", hostContext);
    const listPendingPrompt = harness.prompts.at(-1)!;
    await harness.commands.get("do-work")!.handler("--list", hostContext);
    assert.equal(start(listPendingPrompt, hostContext), undefined, "list clears the current pending record");
    assert.equal(start(harness.prompts.at(-1)!, hostContext), undefined, "list output never arms provenance");

    await harness.commands.get("do-work")!.handler("seed cto cleanup", hostContext);
    const ctoPendingPrompt = harness.prompts.at(-1)!;
    await harness.commands.get("cto")!.handler("", hostContext);
    assert.equal(start(ctoPendingPrompt, hostContext), undefined, "cto clears the current pending record");
    assert.equal(start(harness.prompts.at(-1)!, hostContext), undefined, "cto output never arms provenance");

    await harness.commands.get("do-work")!.handler("seed preflight cleanup", hostContext);
    const preflightPendingPrompt = harness.prompts.at(-1)!;
    await harness.commands.get("do-work")!.handler("--new", hostContext);
    assert.equal(start(preflightPendingPrompt, hostContext), undefined, "preflight failure clears the current pending record");
    const assertExplicitIngressClears = async (label: string, ingress: () => Promise<void>) => {
      await harness.commands.get("do-work")!.handler(`--new ${label}`, hostContext);
      const prompt = harness.prompts.at(-1)!;
      const token = prompt.split(":")[1]!;
      assert.ok(start(prompt, hostContext));
      await ingress();
      lifecycleConflict(() => controller.consumeCommandIntent({ command_intent_id: token, mode: "new" }));
    };
    await assertExplicitIngressClears("usage explicit cleanup", () => harness.commands.get("do-work")!.handler("", hostContext));
    await assertExplicitIngressClears("list explicit cleanup", () => harness.commands.get("do-work")!.handler("--list", hostContext));
    await assertExplicitIngressClears("cto explicit cleanup", () => harness.commands.get("cto")!.handler("", hostContext));
    await assertExplicitIngressClears("preflight explicit cleanup", () => harness.commands.get("do-work")!.handler("--new", hostContext));

    const buildHarness = commandHarness();
    const buildSessionId = "build-failure-session";
    const buildController = createWorkflowSessionController({ cwd: root, context: trustedContext(root, buildSessionId) });
    const buildContext = contextFor(root, buildSessionId);
    let buildFailed = false;
    let reenterBuild = false;
    let failedExplicitToken: string | undefined;
    registerWorkflowCommands(buildHarness.pi as never, {
      resolveCwd: () => root,
      getSessionController: () => buildController,
      buildDoWorkPrompt: envelope => {
        if (reenterBuild) {
          reenterBuild = false;
          const failOuter = buildFailed;
          buildFailed = false;
          void buildHarness.commands.get("do-work")!.handler("--new reentrant newer", buildContext);
          buildFailed = failOuter;
          if (failOuter) {
            throw new Error("build failed");
          }
        }
        if (buildFailed) {
          failedExplicitToken = envelope.command_intent_id;
          throw new Error("build failed");
        }
        return `${envelope.mode}:${envelope.command_intent_id ?? "missing"}:${envelope.task}`;
      },
    });
    await buildHarness.commands.get("do-work")!.handler("build predecessor", buildContext);
    const predecessorPrompt = buildHarness.prompts.at(-1)!;
    buildFailed = true;
    reenterBuild = true;
    await assert.rejects(buildHarness.commands.get("do-work")!.handler("build failure", buildContext), /build failed/);
    buildFailed = false;
    const failedNewerPrompt = buildHarness.prompts.find(prompt => prompt.includes(":reentrant newer"))!;
    const buildHook = buildHarness.handlers.get("before_agent_start")?.[0];
    const failedNewerTurn = buildHook?.({ prompt: failedNewerPrompt, systemPrompt: [] }, buildContext) as { systemPrompt: string[] } | undefined;
    assert.ok(failedNewerTurn, "reentrant explicit provenance survives outer build failure");
    const failedNewerToken = failedNewerPrompt.split(":")[1]!;
    assert.equal(buildController.consumeCommandIntent({ command_intent_id: failedNewerToken, mode: "new" })?.intent_id, failedNewerToken);
    assert.equal(buildHook?.({ prompt: predecessorPrompt, systemPrompt: [] }, buildContext), undefined, "build failure clears only the replaced predecessor");

    reenterBuild = true;
    await buildHarness.commands.get("do-work")!.handler("successful outer", buildContext);
    const successfulNewerPrompt = buildHarness.prompts.findLast(prompt => prompt.includes(":reentrant newer"))!;
    const successfulNewerTurn = buildHook?.({ prompt: successfulNewerPrompt, systemPrompt: [] }, buildContext) as { systemPrompt: string[] } | undefined;
    assert.ok(successfulNewerTurn, "successful outer build cannot overwrite newer explicit provenance");
    const successfulNewerToken = successfulNewerPrompt.split(":")[1]!;
    assert.equal(buildController.consumeCommandIntent({ command_intent_id: successfulNewerToken, mode: "new" })?.intent_id, successfulNewerToken);

    buildFailed = true;
    await assert.rejects(buildHarness.commands.get("do-work")!.handler("--new explicit own failure", buildContext), /build failed/);
    assert.ok(failedExplicitToken);
    lifecycleConflict(() => buildController.consumeCommandIntent({ command_intent_id: failedExplicitToken!, mode: "new" }));
    buildFailed = false;
    const noResolver = commandHarness();
    registerWorkflowCommands(noResolver.pi as never, {
      resolveCwd: () => root,
      buildDoWorkPrompt: envelope => envelope.task,
    });
    await noResolver.commands.get("do-work")!.handler("unbound task", hostContext);
    await noResolver.commands.get("do-work")!.handler("", hostContext);
    await noResolver.commands.get("do-work")!.handler("--list", hostContext);
    await noResolver.commands.get("cto")!.handler("", hostContext);
    await noResolver.commands.get("do-work")!.handler("--new", hostContext);
    const noResolverHook = noResolver.handlers.get("before_agent_start")?.[0];
    for (const prompt of noResolver.prompts) {
      assert.equal(noResolverHook?.({ prompt, systemPrompt: [] }, hostContext), undefined);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(foreignRoot, { recursive: true, force: true });
  }
});
