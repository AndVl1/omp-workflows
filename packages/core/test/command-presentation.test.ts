/**
 * Focused command presentation tests for `registerWorkflowCommands`.
 *
 *   - no-arg usage text, examples, alias copy, command descriptions and UI
 *     notifications derive the actually registered public command names
 *   - bare registration keeps the wave-001 `/do-work`, `/team`, `/cto`
 *     presentation byte-for-byte
 *   - namespaced registration (`commandPrefix: "omp"`, legacy `namespace`)
 *     presents `/omp-do-work`, `/omp-team`, `/omp-cto` everywhere
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerWorkflowCommands } from "../src/index.js";

type CommandHandler = (args: string, ctx: unknown) => Promise<void>;

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
  return {
    cwd: root,
    sessionManager: { getCwd: () => root, getSessionId: () => "command-presentation" },
    ui: { notify: (message: string) => notifies.push(message) },
  };
}

test("bare registration keeps the wave-001 /do-work, /team and /cto presentation", async () => {
  const root = mkdtempSync(join(tmpdir(), "cmd-presentation-bare-"));
  try {
    const harness = commandHarness();
    registerWorkflowCommands(harness.pi as never, {
      buildDoWorkPrompt: (envelope, cwd) => `${envelope.task}@${cwd}`,
    });
    assert.deepEqual([...harness.commands.keys()], ["do-work", "team", "cto"]);

    assert.equal(
      harness.commands.get("do-work")?.description,
      "Run a profile-driven workflow. /do-work <task>. (Alias: /team.)",
    );
    assert.equal(
      harness.commands.get("team")?.description,
      "Alias for /do-work. Prefer /do-work in new code.",
    );
    assert.ok(harness.commands.get("cto")?.description?.includes("/cto <task>; /cto alone starts STANDBY"));

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

test("commandPrefix \"omp\" presents /omp-do-work, /omp-team and /omp-cto end to end", async () => {
  const root = mkdtempSync(join(tmpdir(), "cmd-presentation-omp-"));
  try {
    const harness = commandHarness();
    registerWorkflowCommands(harness.pi as never, {
      commandPrefix: "omp",
      buildDoWorkPrompt: (envelope, cwd) => `${envelope.task}@${cwd}`,
    });
    assert.deepEqual([...harness.commands.keys()], ["omp-do-work", "omp-team", "omp-cto"]);

    assert.equal(
      harness.commands.get("omp-do-work")?.description,
      "Run a profile-driven workflow. /omp-do-work <task>. (Alias: /omp-team.)",
    );
    assert.equal(
      harness.commands.get("omp-team")?.description,
      "Alias for /omp-do-work. Prefer /omp-do-work in new code.",
    );
    assert.ok(harness.commands.get("omp-cto")?.description?.includes("/omp-cto <task>; /omp-cto alone starts STANDBY"));

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

test("the legacy namespace option resolves the same public names", () => {
  const harness = commandHarness();
  registerWorkflowCommands(harness.pi as never, { namespace: "omp" });
  assert.deepEqual([...harness.commands.keys()], ["omp-do-work", "omp-team", "omp-cto"]);
  assert.equal(
    harness.commands.get("omp-do-work")?.description,
    "Run a profile-driven workflow. /omp-do-work <task>. (Alias: /omp-team.)",
  );
});
