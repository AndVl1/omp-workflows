/**
 * Focused command presentation tests for `registerWorkflowCommands`.
 *
 *   - no-arg usage text, examples, alias copy, command descriptions and UI
 *     notifications derive the actually registered public command names
 *   - bare registration keeps the `/do-work`, `/team`, `/cto`, and native
 *     specification command presentation
 *   - namespaced registration (`commandPrefix: "omp"`, legacy `namespace`)
 *     presents the matching `/omp-*` public names everywhere
 */

import { test } from "node:test";
import { createHash } from "node:crypto";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MAX_DO_WORK_ARGUMENT_BYTES, MAX_DO_WORK_ARGUMENT_TOKENS, MAX_DO_WORK_SELECTOR_BYTES } from "../src/commands/do-work.js";
import { MAX_WORKFLOW_COMMAND_ARGUMENT_BYTES } from "../src/commands/register.js";
import { registerWorkflowCommands, type WorkflowOwnerIdentity } from "../src/index.js";

type CommandHandler = (args: string, ctx: unknown) => Promise<void>;

const commandSessionManagers = new Map<string, { getCwd: () => string; getSessionId: () => string }>();

type CommandHarness = {
  commands: Map<string, { description?: string; handler: CommandHandler }>;
  prompts: string[];
  pi: {
    registerCommand(name: string, command: { description?: string; handler: CommandHandler }): void;
    on(event: string, handler: (event: unknown, ctx: unknown) => void): void;
    sendUserMessage(prompt: string): void;
  };
};

function commandHarness(): CommandHarness {
  const commands = new Map<string, { description?: string; handler: CommandHandler }>();
  const prompts: string[] = [];
  const pi = {
    registerCommand(name: string, command: { description?: string; handler: CommandHandler }) {
      commands.set(name, command);
    },
    on(_event: string, _handler: (event: unknown, ctx: unknown) => void) {},
    sendUserMessage(prompt: string) {
      prompts.push(prompt);
    },
  };
  return { commands, prompts, pi };
}

function commandContext(root: string, notifies: string[]): unknown {
  let sessionManager = commandSessionManagers.get(root);
  if (!sessionManager) {
    sessionManager = { getCwd: () => root, getSessionId: () => `command-presentation-${root.replace(/[^A-Za-z0-9]/gu, "_")}` };
    commandSessionManagers.set(root, sessionManager);
  }
  return {
    cwd: root,
    sessionManager,
    ui: { notify: (message: string) => notifies.push(message) },
  };
}

function activationOwner(root: string, ownerId = "command-presentation-owner"): WorkflowOwnerIdentity {
  const markerPath = join(root, ".omp-command-activation-marker");
  const bytes = Buffer.from("command-presentation-marker\n", "utf8");
  writeFileSync(markerPath, bytes);
  const markerSha256 = createHash("sha256").update(bytes).digest("hex");
  return {
    owner_id: ownerId,
    bundle_id: ownerId,
    owner_kind: "fullstack",
    activation_marker: ownerId + "-activation",
    host_range: ">=17 <19",
    activation: { marker_id: ownerId + "-activation", required: [{ path: ".omp-command-activation-marker", kind: "file", sha256: markerSha256 }] },
    provenance: { package: ownerId, entrypoint: "dist/index.js", cwd: root, config_path: join(root, ".omp", "team.config.json") },
  };
}

test("bare registration keeps all seven public command presentations", async () => {
  const root = mkdtempSync(join(tmpdir(), "cmd-presentation-bare-"));
  try {
    const harness = commandHarness();
    registerWorkflowCommands(harness.pi as never, {
      cwd: root,
      owner: activationOwner(root),
      buildDoWorkPrompt: (envelope, cwd) => `${envelope.task}@${cwd}`,
    });
    assert.deepEqual([...harness.commands.keys()], [
      "do-work",
      "team",
      "cto",
      "specify",
      "spec-plan",
      "spec-tasks",
      "spec-import",
    ]);

    assert.equal(
      harness.commands.get("do-work")?.description,
      "Run a profile-driven workflow. /do-work <task>. (Alias: /team.)",
    );
    assert.equal(
      harness.commands.get("team")?.description,
      "Alias for /do-work. Prefer /do-work in new code.",
    );
    assert.ok(harness.commands.get("cto")?.description?.includes("/cto <task>; /cto alone starts STANDBY"));
    assert.equal(
      harness.commands.get("specify")?.description,
      "Create, resume, or revise the Specify phase. /specify [--feature <feature-id>] <request>.",
    );
    assert.equal(
      harness.commands.get("spec-plan")?.description,
      "Create, resume, or revise the Plan phase. /spec-plan --feature <feature-id>.",
    );
    assert.equal(
      harness.commands.get("spec-tasks")?.description,
      "Create, resume, or revise the Tasks phase. /spec-tasks --feature <feature-id>.",
    );
    assert.equal(
      harness.commands.get("spec-import")?.description,
      "Import an authorized local external specification read-only and validate compatibility. /spec-import <path> [--framework <id|generic>] [--language <BCP47>] [--feature <feature-id>] [--supplement <project-relative-json>] [--review <project-relative-json>].",
    );


    const notifies: string[] = [];
    const ctx = commandContext(root, notifies);

    await harness.commands.get("do-work")?.handler("", ctx);
    assert.equal(harness.prompts.at(-1), [
      "Usage: /do-work <task description>",
      "",
      "Examples:",
      "  /do-work Add OAuth authentication with Google and GitHub",
      "  /do-work [AUTONOMOUS] Fix the 500 error on /api/users issue=#42",
      "",
      "Alias: `/team` works too.",
    ].join("\n"), "bare no-arg /do-work usage text is unchanged");

    await harness.commands.get("team")?.handler("", ctx);
    assert.equal(harness.prompts.at(-1), [
      "Usage: /team <task description>  (alias for /do-work)",
      "",
      "Examples:",
      "  /team Add OAuth authentication with Google and GitHub",
      "  /team [AUTONOMOUS] Fix the 500 error on /api/users issue=#42",
    ].join("\n"), "bare no-arg /team usage text is unchanged");

    await harness.commands.get("cto")?.handler("", ctx);
    assert.deepEqual(notifies, ["cto: standby mode — awaiting tasks via messenger inbox"], "bare cto standby notification is unchanged");
    assert.match(harness.prompts.at(-1) ?? "", /STANDBY/, "bare cto standby prompt is sent");

    await harness.commands.get("do-work")?.handler("bare wave-001 task", ctx);
    assert.deepEqual(notifies, [
      "cto: standby mode — awaiting tasks via messenger inbox",
      "do-work: bare wave-001 task (workflow pending)",
    ], "bare do-work notification is unchanged");
    assert.equal(harness.prompts.at(-1), `bare wave-001 task@${root}`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("commandPrefix \"omp\" presents all seven /omp-* commands end to end", async () => {
  const root = mkdtempSync(join(tmpdir(), "cmd-presentation-omp-"));
  try {
    const harness = commandHarness();
    registerWorkflowCommands(harness.pi as never, {
      cwd: root,
      owner: activationOwner(root, "command-presentation-omp"),
      commandPrefix: "omp",
      buildDoWorkPrompt: (envelope, cwd) => `${envelope.task}@${cwd}`,
    });
    assert.deepEqual([...harness.commands.keys()], [
      "omp-do-work",
      "omp-team",
      "omp-cto",
      "omp-specify",
      "omp-spec-plan",
      "omp-spec-tasks",
      "omp-spec-import",
    ]);

    assert.equal(
      harness.commands.get("omp-do-work")?.description,
      "Run a profile-driven workflow. /omp-do-work <task>. (Alias: /omp-team.)",
    );
    assert.equal(
      harness.commands.get("omp-team")?.description,
      "Alias for /omp-do-work. Prefer /omp-do-work in new code.",
    );
    assert.ok(harness.commands.get("omp-cto")?.description?.includes("/omp-cto <task>; /omp-cto alone starts STANDBY"));
    assert.equal(
      harness.commands.get("omp-specify")?.description,
      "Create, resume, or revise the Specify phase. /omp-specify [--feature <feature-id>] <request>.",
    );
    assert.equal(
      harness.commands.get("omp-spec-plan")?.description,
      "Create, resume, or revise the Plan phase. /omp-spec-plan --feature <feature-id>.",
    );
    assert.equal(
      harness.commands.get("omp-spec-tasks")?.description,
      "Create, resume, or revise the Tasks phase. /omp-spec-tasks --feature <feature-id>.",
    );
    assert.equal(
      harness.commands.get("omp-spec-import")?.description,
      "Import an authorized local external specification read-only and validate compatibility. /omp-spec-import <path> [--framework <id|generic>] [--language <BCP47>] [--feature <feature-id>] [--supplement <project-relative-json>] [--review <project-relative-json>].",
    );

    const notifies: string[] = [];
    const ctx = commandContext(root, notifies);

    await harness.commands.get("omp-do-work")?.handler("", ctx);
    assert.equal(harness.prompts.at(-1), [
      "Usage: /omp-do-work <task description>",
      "",
      "Examples:",
      "  /omp-do-work Add OAuth authentication with Google and GitHub",
      "  /omp-do-work [AUTONOMOUS] Fix the 500 error on /api/users issue=#42",
      "",
      "Alias: `/omp-team` works too.",
    ].join("\n"), "namespaced no-arg usage text uses the public prefixed name");

    await harness.commands.get("omp-team")?.handler("", ctx);
    assert.equal(harness.prompts.at(-1), [
      "Usage: /omp-team <task description>  (alias for /omp-do-work)",
      "",
      "Examples:",
      "  /omp-team Add OAuth authentication with Google and GitHub",
      "  /omp-team [AUTONOMOUS] Fix the 500 error on /api/users issue=#42",
    ].join("\n"), "namespaced alias usage text names the public do-work command");

    await harness.commands.get("omp-cto")?.handler("", ctx);
    assert.deepEqual(notifies, ["omp-cto: standby mode — awaiting tasks via messenger inbox"], "namespaced cto standby notification uses the public prefixed name");

    await harness.commands.get("omp-do-work")?.handler("namespaced dispatch task", ctx);
    assert.deepEqual(notifies, [
      "omp-cto: standby mode — awaiting tasks via messenger inbox",
      "omp-do-work: namespaced dispatch task (workflow pending)",
    ], "namespaced do-work notification uses the public prefixed name");
    assert.equal(harness.prompts.at(-1), `namespaced dispatch task@${root}`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the legacy namespace option resolves all seven prefixed public names", () => {
  const root = mkdtempSync(join(tmpdir(), "cmd-presentation-legacy-"));
  try {
    const harness = commandHarness();
    registerWorkflowCommands(harness.pi as never, { cwd: root, owner: activationOwner(root, "command-presentation-legacy"), namespace: "omp" });
    assert.deepEqual([...harness.commands.keys()], [
      "omp-do-work",
      "omp-team",
      "omp-cto",
      "omp-specify",
      "omp-spec-plan",
      "omp-spec-tasks",
      "omp-spec-import",
    ]);
    assert.equal(
      harness.commands.get("omp-do-work")?.description,
    "Run a profile-driven workflow. /omp-do-work <task>. (Alias: /omp-team.)",
    );
    assert.equal(
      harness.commands.get("omp-specify")?.description,
    "Create, resume, or revise the Specify phase. /omp-specify [--feature <feature-id>] <request>.",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("registered CTO accepts selector-only prep-to-Ask routes for bare and prefixed commands", async () => {
  for (const [commandName, options] of [["cto", {}], ["omp-cto", { commandPrefix: "omp" }]] as const) {
    const root = mkdtempSync(join(tmpdir(), "cmd-cto-selector-"));
    try {
      const harness = commandHarness();
      registerWorkflowCommands(harness.pi as never, { ...options, cwd: root, owner: activationOwner(root, "command-presentation-cto-" + commandName) });
      const notifies: string[] = [];
      await harness.commands.get(commandName)?.handler("--spec readable-feature --run-key run-readable-1", commandContext(root, notifies));
      const prompt = harness.prompts.at(-1) ?? "";
      assert.match(prompt, /cto_prepare/u, `${commandName}: selector-only route keeps engine preparation`);
      assert.match(prompt, /cto_preflight/u, `${commandName}: selector-only route reaches operational preflight`);
      assert.match(prompt, /cto_checkpoint_ask_selected/u, `${commandName}: selector-only route reaches the host Ask`);
      assert.equal(notifies.length, 1, `${commandName}: selector-only route emits one CTO notification`);
      assert.match(notifies[0] ?? "", /readable-feature/u, `${commandName}: selector-only notification identifies the selected feature`);

      await harness.commands.get(commandName)?.handler("--spec readable-feature", commandContext(root, notifies));
      assert.match(harness.prompts.at(-1) ?? "", /^ERROR: CTO_SPEC_ARGUMENT_INVALID:/u, `${commandName}: dangling --spec is rejected`);
      await harness.commands.get(commandName)?.handler("--run-key run-readable-1", commandContext(root, notifies));
      assert.match(harness.prompts.at(-1) ?? "", /^ERROR: CTO_SPEC_ARGUMENT_INVALID:/u, `${commandName}: --run-key without --spec is rejected`);
      await harness.commands.get(commandName)?.handler("issue=#3", commandContext(root, notifies));
      assert.equal(harness.prompts.at(-1), "ERROR: empty task after stripping prefix.", `${commandName}: empty no-selector command is rejected`);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
});
test("do-work and team reject bounded envelope input before notification or prompt construction", async () => {
  const root = mkdtempSync(join(tmpdir(), "cmd-presentation-bounds-"));
  try {
    for (const [commandName, options] of [
      ["do-work", {}],
      ["team", {}],
      ["omp-do-work", { commandPrefix: "omp" }],
      ["omp-team", { commandPrefix: "omp" }],
    ] as const) {
      const harness = commandHarness();
      let promptBuilderCalls = 0;
      registerWorkflowCommands(harness.pi as never, {
        ...options,
        cwd: root,
        owner: activationOwner(root, "command-presentation-bounds"),
        buildDoWorkPrompt: () => {
          promptBuilderCalls += 1;
          return "unexpected classification prompt";
        },
      });
      const notifies: string[] = [];
      const ctx = commandContext(root, notifies);
      const globalInputs = [
        " ".repeat(MAX_WORKFLOW_COMMAND_ARGUMENT_BYTES + 1),
        "😀".repeat(Math.floor(MAX_WORKFLOW_COMMAND_ARGUMENT_BYTES / 4) + 1),
      ];
      for (const input of globalInputs) {
        await harness.commands.get(commandName)?.handler(input, ctx);
        assert.match(harness.prompts.at(-1) ?? "", /^ERROR COMMAND_ARGUMENT_INVALID:/u, `${commandName}: global argument cap rejects oversized raw input`);
      }
      const invalidInputs = [
        "x".repeat(MAX_DO_WORK_ARGUMENT_BYTES + 1),
        " ".repeat(MAX_DO_WORK_ARGUMENT_BYTES + 1),
        Array.from({ length: MAX_DO_WORK_ARGUMENT_TOKENS + 1 }, () => "x").join(" "),
        `--spec ${"a".repeat(MAX_DO_WORK_SELECTOR_BYTES + 1)} task`,
      ];
      for (const input of invalidInputs) {
        await harness.commands.get(commandName)?.handler(input, ctx);
      }
      assert.equal(promptBuilderCalls, 0, `${commandName}: invalid envelopes never reach classification`);
      assert.deepEqual(notifies, [], `${commandName}: invalid envelopes never notify`);
      assert.equal(harness.prompts.length, globalInputs.length + invalidInputs.length);
      for (const prompt of harness.prompts.slice(globalInputs.length)) {
        assert.match(prompt, /^ERROR SPEC_ARGUMENT_INVALID:/u, `${commandName}: invalid envelope is returned as an error`);
      }
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
