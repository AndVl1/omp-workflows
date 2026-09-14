import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PinnedProjectRoot } from "@andvl1/omp-workflows-core";
import {
  MAX_SUBAGENT_FIELD_BYTES,
  MAX_SUBAGENT_NODES,
  SubagentTreeController,
  buildCardRenderer,
  normalizeSubagentDisplayText,
  readPersistedState,
  renderSubagentCompactLine,
  writePersistedState,
} from "../src/subagent-tree.js";

test("subagent tree: display normalization removes controls and bounds UTF-8", () => {
  const normalized = normalizeSubagentDisplayText("agent\u001b[31m\n\u202e" + "x".repeat(MAX_SUBAGENT_FIELD_BYTES * 2));
  assert.equal(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e]/u.test(normalized), false);
  assert.ok(Buffer.byteLength(normalized, "utf8") <= MAX_SUBAGENT_FIELD_BYTES);
  assert.match(normalized, /agent�\[31m�/u);
});

test("subagent tree: lifecycle and progress retain bounded line-inert labels", () => {
  const controller = new SubagentTreeController({ enabled: true, mode: "compact" }, "/tmp/subagent-tree-test");
  const started = controller.applyLifecycle({
    id: "worker\n1",
    agent: "agent\u001b[9m",
    description: "description\u202e" + "d".repeat(MAX_SUBAGENT_FIELD_BYTES * 2),
    status: "started",
  });
  assert.ok(started);
  assert.equal(started?.data.status, "running");
  assert.equal(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e]/u.test(started?.data.agent ?? ""), false);
  assert.ok(Buffer.byteLength(started?.data.description ?? "", "utf8") <= MAX_SUBAGENT_FIELD_BYTES);

  assert.equal(controller.applyProgress({
    progress: {
      id: "worker\n1",
      currentTool: "tool\u001b[2K\n" + "t".repeat(MAX_SUBAGENT_FIELD_BYTES * 2),
      tokens: Number.MAX_VALUE,
    },
  }), true);
  const line = renderSubagentCompactLine(controller.snapshot());
  assert.equal(line.length, 1);
  assert.equal(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e]/u.test(line[0] ?? ""), false);
  assert.ok(Buffer.byteLength(line[0] ?? "", "utf8") < 2_000);
});

test("subagent tree: compact renderer bounds hostile nodes supplied by an extension", () => {
  const nodes = [{
    id: "hostile",
    agent: "agent\u001b[31m\n" + "x".repeat(10_000),
    status: "running",
    startedAtMs: 0,
  }] as never;
  const lines = renderSubagentCompactLine(nodes);
  assert.equal(lines.length, 1);
  assert.equal(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e]/u.test(lines[0] ?? ""), false);
  assert.ok(Buffer.byteLength(lines[0] ?? "", "utf8") <= 200);
});

test("subagent tree: renderer sanitizes untrusted persisted card details", () => {
  const renderer = buildCardRenderer();
  const rendered = renderer({
    details: {
      id: "id",
      agent: "agent\u001b[31m\n",
      description: "description\u202e" + "x".repeat(1_000),
      currentTool: "tool\u001b[2K\n",
      status: "running",
      startedAtMs: 0,
      tokens: Number.MAX_VALUE,
    },
  }).render(80);
  assert.equal(rendered.length, 1);
  assert.equal(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e]/u.test(rendered[0] ?? ""), false);
  assert.ok((rendered[0] ?? "").length < 1_000);
});

test("subagent tree: node retention is bounded under untrusted lifecycle volume", () => {
  const controller = new SubagentTreeController({ enabled: true, mode: "compact" }, "/tmp/subagent-tree-test");
  for (let i = 0; i < MAX_SUBAGENT_NODES * 2; i += 1) {
    controller.applyLifecycle({ id: `worker-${i}`, agent: "agent", status: "started" });
  }
  assert.equal(controller.count, MAX_SUBAGENT_NODES);
});

test("subagent tree: persisted state rejects malformed, oversized, FIFO, and symlink files", () => {
  const root = mkdtempSync(join(tmpdir(), "subagent-state-"));
  const outside = mkdtempSync(join(tmpdir(), "subagent-state-outside-"));
  const statePath = join(root, ".omp", "subagent-tree.json");
  try {
    assert.deepEqual(readPersistedState(root), { enabled: true, mode: "compact" });

    writePersistedState(root, { enabled: false, mode: "expanded" });
    assert.deepEqual(readPersistedState(root), { enabled: false, mode: "expanded" });

    writeFileSync(statePath, JSON.stringify({ enabled: true, mode: "compact", extra: true }));
    assert.deepEqual(readPersistedState(root), { enabled: true, mode: "compact" }, "extra keys are rejected");

    writeFileSync(statePath, Buffer.from([0xff, 0xfe]));
    assert.deepEqual(readPersistedState(root), { enabled: true, mode: "compact" }, "invalid UTF-8 is rejected");

    writeFileSync(statePath, JSON.stringify({ enabled: true, mode: "compact", payload: "x".repeat(8 * 1024) }));
    assert.deepEqual(readPersistedState(root), { enabled: true, mode: "compact" }, "oversized JSON is rejected");

    rmSync(statePath, { force: true });
    execFileSync("mkfifo", [statePath]);
    assert.deepEqual(readPersistedState(root), { enabled: true, mode: "compact" }, "FIFO is rejected without opening it");

    rmSync(statePath, { force: true });
    const target = join(outside, "state.json");
    writeFileSync(target, JSON.stringify({ enabled: false, mode: "expanded" }));
    symlinkSync(target, statePath);
    assert.deepEqual(readPersistedState(root), { enabled: true, mode: "compact" }, "symlink is non-authoritative");

    const rootAlias = `${root}-alias`;
    symlinkSync(root, rootAlias);
    writePersistedState(rootAlias, { enabled: false, mode: "expanded" });
    assert.deepEqual(readPersistedState(root), { enabled: true, mode: "compact" }, "symlinked project root cannot write state");
    rmSync(rootAlias, { force: true });
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test("subagent tree: persisted state degrades safely when the pinned root is replaced", () => {
  const root = mkdtempSync(join(tmpdir(), "subagent-state-swap-"));
  const displaced = `${root}.displaced`;
  const originalOpen = PinnedProjectRoot.open;
  let swapped = false;
  try {
    writePersistedState(root, { enabled: false, mode: "expanded" });
    PinnedProjectRoot.open = ((candidate: unknown) => {
      const pinned = originalOpen(candidate);
      if (pinned && candidate === root && !swapped) {
        swapped = true;
        renameSync(root, displaced);
        mkdirSync(root);
      }
      return pinned;
    }) as typeof PinnedProjectRoot.open;
    assert.deepEqual(readPersistedState(root), { enabled: true, mode: "compact" }, "replacement root cannot authorize old state");
    assert.equal(swapped, true);
  } finally {
    PinnedProjectRoot.open = originalOpen;
    rmSync(root, { recursive: true, force: true });
    rmSync(displaced, { recursive: true, force: true });
  }
});
