import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  claimWorkflowOwner,
  registerWorkflowCommands,
  resetWorkflowOwners,
  workflowOwnerFor,
  type WorkflowOwnerIdentity,
} from "../src/index.js";

type CommandHandler = (args: string, ctx: unknown) => Promise<void>;
type SessionStartHandler = (event: unknown, ctx: unknown) => void;

type CommandHarness = {
  commands: Map<string, { handler: CommandHandler }>;
  prompts: string[];
  sessionStarts: SessionStartHandler[];
  registerCalls: number;
  pi: {
    registerCommand(name: string, command: { handler: CommandHandler }): void;
    on(event: string, handler: SessionStartHandler): void;
    sendUserMessage(prompt: string): void;
  };
};

function owner(ownerId: string, cwd: string): WorkflowOwnerIdentity {
  return {
    owner_id: ownerId,
    bundle_id: ownerId,
    owner_kind: "private_omp",
    activation_marker: `${ownerId}-activation`,
    host_range: ">=17 <19",
    provenance: {
      package: ownerId,
      entrypoint: "dist/index.js",
      cwd,
      config_path: join(cwd, ".omp", "team.config.json"),
    },
  };
}

function commandHarness(): CommandHarness {
  const commands = new Map<string, { handler: CommandHandler }>();
  const prompts: string[] = [];
  const sessionStarts: SessionStartHandler[] = [];
  let registerCalls = 0;
  const pi = {
    registerCommand(name: string, command: { handler: CommandHandler }) {
      registerCalls += 1;
      commands.set(name, command);
    },
    on(event: string, handler: SessionStartHandler) {
      if (event === "session_start") sessionStarts.push(handler);
    },
    sendUserMessage(prompt: string) {
      prompts.push(prompt);
    },
  };
  return {
    commands,
    prompts,
    sessionStarts,
    get registerCalls() {
      return registerCalls;
    },
    pi,
  };
}

test("owner registry canonicalizes a symlink alias to one physical worktree", () => {
  const root = mkdtempSync(join(tmpdir(), "omp-owner-real-"));
  const alias = join(tmpdir(), `omp-owner-alias-${process.pid}-${Date.now()}`);
  symlinkSync(root, alias, "dir");
  try {
    const first = claimWorkflowOwner(root, "workflow_registration", owner("bundle-one", root));
    assert.equal(first.ok, true);
    if (!first.ok) return;
    assert.equal(first.claim.project_root, realpathSync(root));
    assert.equal(first.claim.owner.provenance.cwd, realpathSync(root));
    assert.equal(first.claim.owner.provenance.config_path, join(realpathSync(root), ".omp", "team.config.json"));
    const repeat = claimWorkflowOwner(alias, "workflow_registration", owner("bundle-one", alias));
    assert.equal(repeat.ok, true);
    assert.equal(repeat.ok && repeat.idempotent, true);

    const conflict = claimWorkflowOwner(alias, "workflow_registration", owner("bundle-two", alias));
    assert.equal(conflict.ok, false);
    if (conflict.ok) return;
    assert.equal(conflict.code, "owner_conflict");
    assert.equal(conflict.claim?.owner.owner_id, "bundle-one");
    assert.equal(workflowOwnerFor(alias, "workflow_registration")?.owner.owner_id, "bundle-one");
  } finally {
    resetWorkflowOwners(root);
    rmSync(alias, { force: true });
    rmSync(root, { recursive: true, force: true });
  }
});

test("owner-aware command registration publishes before claiming the session root", () => {
  const root = mkdtempSync(join(tmpdir(), "omp-command-owner-"));
  const alias = join(tmpdir(), `omp-command-alias-${process.pid}-${Date.now()}`);
  symlinkSync(root, alias, "dir");
  try {
    const first = claimWorkflowOwner(root, "workflow_registration", owner("bundle-one", root));
    assert.equal(first.ok, true);

    const harness = commandHarness();
    registerWorkflowCommands(harness.pi as never, {
      owner: owner("bundle-two", alias),
      resolveCwd: () => alias,
    });
    assert.deepEqual([...harness.commands.keys()], ["do-work", "team", "cto"]);
    assert.equal(harness.registerCalls, 3);
    assert.equal(harness.sessionStarts.length, 1);

    assert.throws(
      () => harness.sessionStarts[0]?.({}, { cwd: alias }),
      /owner_conflict: generic workflow capability 'workflow_registration' is already owned by 'bundle-one'/,
    );
    assert.deepEqual([...harness.commands.keys()], ["do-work", "team", "cto"]);
    assert.equal(harness.registerCalls, 3);
  } finally {
    resetWorkflowOwners(root);
    rmSync(alias, { force: true });
    rmSync(root, { recursive: true, force: true });
  }
});

test("explicit cwd remains the prompt root when session context drifts to an unclaimed root", async () => {
  const claimedRoot = mkdtempSync(join(tmpdir(), "omp-command-explicit-claimed-"));
  const unclaimedRoot = mkdtempSync(join(tmpdir(), "omp-command-explicit-unclaimed-"));
  try {
    const harness = commandHarness();
    registerWorkflowCommands(harness.pi as never, {
      cwd: claimedRoot,
      owner: owner("bundle-explicit", claimedRoot),
      buildDoWorkPrompt: (_envelope, cwd) => `effective-root:${cwd}`,
    });
    const handler = harness.commands.get("do-work")?.handler;
    assert.ok(handler);

    await handler("explicit root task", {
      cwd: unclaimedRoot,
      sessionManager: { getCwd: () => unclaimedRoot },
      ui: { notify() {} },
    });

    assert.deepEqual(harness.prompts, [`effective-root:${claimedRoot}`]);
    assert.equal(workflowOwnerFor(unclaimedRoot, "workflow_registration"), undefined);
  } finally {
    resetWorkflowOwners(claimedRoot);
    resetWorkflowOwners(unclaimedRoot);
    rmSync(claimedRoot, { recursive: true, force: true });
    rmSync(unclaimedRoot, { recursive: true, force: true });
  }
});

test("custom resolveCwd remains the prompt root when session context drifts to an unclaimed root", async () => {
  const claimedRoot = mkdtempSync(join(tmpdir(), "omp-command-resolver-claimed-"));
  const unclaimedRoot = mkdtempSync(join(tmpdir(), "omp-command-resolver-unclaimed-"));
  let resolverCalls = 0;
  try {
    const harness = commandHarness();
    registerWorkflowCommands(harness.pi as never, {
      owner: owner("bundle-resolver", claimedRoot),
      resolveCwd: () => {
        resolverCalls += 1;
        return claimedRoot;
      },
      buildDoWorkPrompt: (_envelope, cwd) => `effective-root:${cwd}`,
    });
    const handler = harness.commands.get("do-work")?.handler;
    assert.ok(handler);

    await handler("resolver root task", {
      cwd: unclaimedRoot,
      sessionManager: { getCwd: () => unclaimedRoot },
      ui: { notify() {} },
    });

    assert.equal(resolverCalls, 1);
    assert.deepEqual(harness.prompts, [`effective-root:${claimedRoot}`]);
    assert.equal(workflowOwnerFor(unclaimedRoot, "workflow_registration"), undefined);
  } finally {
    resetWorkflowOwners(claimedRoot);
    resetWorkflowOwners(unclaimedRoot);
    rmSync(claimedRoot, { recursive: true, force: true });
    rmSync(unclaimedRoot, { recursive: true, force: true });
  }
});

test("wave-001 regression: a configured resolveCwd returning undefined claims zero owners and never falls through to the context cwd", async () => {
  const contextRoot = mkdtempSync(join(tmpdir(), "omp-command-undefined-resolver-"));
  try {
    const harness = commandHarness();
    let resolverCalls = 0;
    registerWorkflowCommands(harness.pi as never, {
      owner: owner("bundle-gated", contextRoot),
      resolveCwd: () => {
        resolverCalls += 1;
        return undefined;
      },
      buildDoWorkPrompt: (_envelope, cwd) => `effective-root:${cwd}`,
    });
    assert.equal(harness.sessionStarts.length, 1);
    assert.equal(workflowOwnerFor(contextRoot, "workflow_registration"), undefined, "extension load claims nothing");

    // session_start: undefined custom resolution is final — the gated owner
    // source is never invoked and the context cwd is not adopted.
    harness.sessionStarts[0]?.({}, {
      cwd: contextRoot,
      sessionManager: { getCwd: () => contextRoot },
    });
    assert.equal(resolverCalls, 1);
    assert.equal(
      workflowOwnerFor(contextRoot, "workflow_registration"),
      undefined,
      "undefined custom resolution makes zero owner claims",
    );

    // Handler path: undefined cwd fails closed instead of claiming or
    // prompting through the context cwd.
    const handler = harness.commands.get("do-work")?.handler;
    assert.ok(handler);
    await assert.rejects(
      handler("gated task", {
        cwd: contextRoot,
        sessionManager: { getCwd: () => contextRoot },
        ui: { notify() {} },
      }),
      /workflow cwd unavailable/,
    );
    assert.equal(resolverCalls, 2);
    assert.deepEqual(harness.prompts, [], "no prompt may be built from the context cwd");
    assert.equal(
      workflowOwnerFor(contextRoot, "workflow_registration"),
      undefined,
      "no side-effect claim through the context cwd",
    );
  } finally {
    resetWorkflowOwners(contextRoot);
    rmSync(contextRoot, { recursive: true, force: true });
  }
});

test("owner-aware command handlers remain fail-closed after an owner conflict", async () => {
  const root = mkdtempSync(join(tmpdir(), "omp-command-handler-owner-"));
  const alias = join(tmpdir(), `omp-command-handler-alias-${process.pid}-${Date.now()}`);
  symlinkSync(root, alias, "dir");
  try {
    const first = claimWorkflowOwner(root, "workflow_registration", owner("bundle-one", root));
    assert.equal(first.ok, true);

    const harness = commandHarness();
    registerWorkflowCommands(harness.pi as never, {
      owner: owner("bundle-two", alias),
      resolveCwd: () => alias,
    });
    const handler = harness.commands.get("do-work")?.handler;
    assert.ok(handler);
    await assert.rejects(
      handler("run a task", {
        cwd: alias,
        sessionManager: { getCwd: () => alias },
        ui: { notify() {} },
      }),
      /owner_conflict: generic workflow capability 'workflow_registration' is already owned by 'bundle-one'/,
    );
    assert.deepEqual(harness.prompts, []);
  } finally {
    resetWorkflowOwners(root);
    rmSync(alias, { force: true });
    rmSync(root, { recursive: true, force: true });
  }
});

test("owner-aware command registration is idempotent across repeated session_start events", () => {
  const root = mkdtempSync(join(tmpdir(), "omp-command-idempotent-"));
  try {
    const harness = commandHarness();
    registerWorkflowCommands(harness.pi as never, {
      owner: owner("bundle-one", root),
      resolveCwd: () => root,
    });
    assert.deepEqual([...harness.commands.keys()], ["do-work", "team", "cto"]);
    assert.equal(harness.registerCalls, 3);
    assert.equal(harness.sessionStarts.length, 1);

    harness.sessionStarts[0]?.({}, { cwd: root });
    harness.sessionStarts[0]?.({}, { cwd: root });

    assert.deepEqual([...harness.commands.keys()], ["do-work", "team", "cto"]);
    assert.equal(harness.registerCalls, 3);
    assert.equal(workflowOwnerFor(root, "workflow_registration")?.owner.owner_id, "bundle-one");
  } finally {
    resetWorkflowOwners(root);
    rmSync(root, { recursive: true, force: true });
  }
});

test("a later plugin override keeps one canonical command in the public inventory", () => {
  const base = commandHarness();
  registerWorkflowCommands(base.pi as never);

  const baseInventory = new Map(base.commands);
  const override = { handler: (async () => undefined) as CommandHandler };
  const pluginOverride = new Map([["team", override]]);
  const publicInventory = new Map(baseInventory);
  for (const [name, command] of pluginOverride) publicInventory.set(name, command);

  assert.deepEqual([...publicInventory.keys()], ["do-work", "team", "cto"]);
  assert.equal(publicInventory.get("team"), override);
  assert.equal(publicInventory.get("do-work"), baseInventory.get("do-work"));
  assert.equal([...publicInventory.keys()].filter(name => name === "team").length, 1);
});
