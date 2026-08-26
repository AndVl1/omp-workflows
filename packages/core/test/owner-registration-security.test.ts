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
  sessionStarts: SessionStartHandler[];
  registerCalls: number;
  pi: {
    registerCommand(name: string, command: { handler: CommandHandler }): void;
    on(event: string, handler: SessionStartHandler): void;
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
  };
  return {
    commands,
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

test("deferred command registration claims before exposing bare commands", () => {
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
    assert.deepEqual([...harness.commands.keys()], []);
    assert.equal(harness.sessionStarts.length, 1);

    assert.throws(
      () => harness.sessionStarts[0]?.({}, { cwd: alias }),
      /owner_conflict: generic workflow capability 'workflow_registration' is already owned by 'bundle-one'/,
    );
    assert.deepEqual([...harness.commands.keys()], []);
    assert.equal(harness.registerCalls, 0);
  } finally {
    resetWorkflowOwners(root);
    rmSync(alias, { force: true });
    rmSync(root, { recursive: true, force: true });
  }
});

test("deferred command registration is idempotent across repeated session_start events", () => {
  const root = mkdtempSync(join(tmpdir(), "omp-command-idempotent-"));
  try {
    const harness = commandHarness();
    registerWorkflowCommands(harness.pi as never, {
      owner: owner("bundle-one", root),
      resolveCwd: () => root,
    });
    assert.equal(harness.registerCalls, 0);
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
