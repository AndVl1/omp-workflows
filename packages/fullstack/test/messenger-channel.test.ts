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

function withActiveRun(root: string, ownerSession = "session-direct"): void {
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
      owner_session: ownerSession,
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
test("messenger: ask gate blocks only for an owned CTO run and session", () => {
  const root = mkdtempSync(join(tmpdir(), "ask-gate-"));
  try {
    const gate = createAskRedirectGate();
    const ownedContext = { cwd: root, session_id: "session-direct" };

    // no channel -> ask passes
    assert.equal(gate({ toolName: "ask" }, ownedContext), undefined, "no channel -> pass");

    // telegram channel, no active run -> ask passes (normal interactive work)
    withChannel(root, "telegram");
    assert.equal(gate({ toolName: "ask" }, ownedContext), undefined, "telegram without run -> pass");

    // telegram + owned active run -> ask blocked with the outbox contract
    withActiveRun(root);
    const blocked = gate({ toolName: "ask" }, ownedContext);
    assert.ok(blocked?.block === true, "ask blocked in messenger mode");
    assert.ok(blocked?.reason.includes("outbox"), "block reason names the outbox route");
    assert.ok(blocked?.reason.includes("answers/"), "block reason names the answers dir");
    assert.ok(blocked?.reason.includes("run-one"), "block reason names the owned run");

    // A foreign session must not route to the owned run.
    assert.equal(gate({ toolName: "ask" }, { cwd: root, session_id: "foreign-session" }), undefined);
    // Missing origin session is never allowed to use a global latest-run fallback.
    assert.equal(gate({ toolName: "ask" }, { cwd: root }), undefined);

    // other tools unaffected
    assert.equal(gate({ toolName: "read" }, ownedContext), undefined, "non-ask tools pass");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
