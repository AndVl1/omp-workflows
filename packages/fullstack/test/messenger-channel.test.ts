import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { channelMode, clearChannelCache, createAskRedirectGate } from "../src/messenger-channel.js";

function withChannel(root: string, adapter: "telegram" | "http" | null): void {
	clearChannelCache();
  if (!adapter) return;
  mkdirSync(join(root, ".omp"), { recursive: true });
  writeFileSync(
    join(root, ".omp", "escalation.json"),
    JSON.stringify(adapter === "telegram" ? { adapter: "telegram", telegram: { token: "t", chatId: "c" } } : { adapter: "http", http: { url: "https://x" } }),
  );
}

function withActiveRun(root: string): void {
  const runDir = join(root, ".work-state", "cto", "run-one");
  mkdirSync(runDir, { recursive: true });
  const now = new Date().toISOString();
  writeFileSync(
    join(runDir, "state.json"),
    JSON.stringify({
      schema: 1,
      id: "run-one",
      task: "Some task",
      branch: "main",
      autonomous: true,
      plan: { id: "run-one", task: "Some task", teams: [], created_at: now },
      teams: [],
      integration: { status: "pending" },
      pause: { kind: "none", reason: "" },
      updated_at: now,
    }),
  );
}

test("messenger: channelMode reads .omp/escalation.json", () => {
  const root = mkdtempSync(join(tmpdir(), "chan-mode-"));
  try {
    assert.equal(channelMode(root), null, "no config -> null");
    withChannel(root, "telegram");
    assert.equal(channelMode(root), "telegram");
    withChannel(root, "http");
    assert.equal(channelMode(root), "http");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("messenger: ask gate blocks only when telegram + active CTO run", () => {
  const root = mkdtempSync(join(tmpdir(), "ask-gate-"));
  try {
    const gate = createAskRedirectGate();

    // no channel -> ask passes
    assert.equal(gate({ toolName: "ask" }, { cwd: root }), undefined, "no channel -> pass");

    // telegram channel, no active run -> ask passes (normal interactive work)
    withChannel(root, "telegram");
    assert.equal(gate({ toolName: "ask" }, { cwd: root }), undefined, "telegram without run -> pass");

    // telegram + active run -> ask blocked with the outbox contract
    withActiveRun(root);
    const blocked = gate({ toolName: "ask" }, { cwd: root });
    assert.ok(blocked?.block === true, "ask blocked in messenger mode");
    assert.ok(blocked?.reason.includes("outbox"), "block reason names the outbox route");
    assert.ok(blocked?.reason.includes("answers/"), "block reason names the answers dir");

    // other tools unaffected
    assert.equal(gate({ toolName: "read" }, { cwd: root }), undefined, "non-ask tools pass");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
