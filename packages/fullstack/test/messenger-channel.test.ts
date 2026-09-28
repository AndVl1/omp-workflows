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
test("messenger: ask gate blocks only for a claim proven by the originating host context", () => {
  const root = mkdtempSync(join(tmpdir(), "ask-gate-"));
  try {
    const ownerManager = { getCwd: () => root, getSessionId: () => "session-direct" };
    const ownedContext = {
      cwd: root,
      session_id: "session-direct",
      mode: "tui",
      hasUI: true,
      sessionManager: ownerManager,
    };
    let hasExactClaim = false;
    const gate = createAskRedirectGate((ctx, cwd) => {
      if (
        !ctx || typeof ctx !== "object"
        || cwd !== root
        || (ctx as { sessionManager?: unknown }).sessionManager !== ownerManager
        || (ctx as { session_id?: unknown }).session_id !== "session-direct"
        || (ctx as { mode?: unknown }).mode !== "tui"
        || (ctx as { hasUI?: unknown }).hasUI !== true
      ) return undefined;
      return hasExactClaim ? { run_id: "run-one", ownership_epoch: "epoch-1" } : undefined;
    });

    // no channel -> ask passes
    assert.equal(gate({ toolName: "ask" }, ownedContext), undefined, "no channel -> pass");

    // telegram channel, no active run -> ask passes (normal interactive work)
    withChannel(root, "telegram");
    assert.equal(gate({ toolName: "ask" }, ownedContext), undefined, "telegram without run -> pass");

    // telegram + exact host claim -> ask blocked with the outbox contract
    hasExactClaim = true;
    const blocked = gate({ toolName: "ask" }, ownedContext);
    assert.ok(blocked?.block === true, "ask blocked in messenger mode");
    assert.ok(blocked?.reason.includes("outbox"), "block reason names the outbox route");
    assert.ok(blocked?.reason.includes("answers/"), "block reason names the answers dir");
    assert.ok(blocked?.reason.includes("run-one"), "block reason names the claimed run");

    // An independent same-cwd manager and a missing origin never route to the
    // owner's run, even when their copied fields look interactive.
    assert.equal(
      gate({ toolName: "ask" }, {
        ...ownedContext,
        session_id: "foreign-session",
        sessionManager: { getCwd: () => root, getSessionId: () => "foreign-session" },
      }),
      undefined,
    );
    assert.equal(gate({ toolName: "ask" }, { cwd: root }), undefined);
    assert.equal(
      gate({ toolName: "ask" }, { ...ownedContext, hasUI: false }),
      undefined,
      "explicit headless context cannot route the owner's ask",
    );
    assert.equal(
      gate({ toolName: "ask" }, { ...ownedContext, mode: "rpc" }),
      undefined,
      "contradictory host mode cannot route the owner's ask",
    );

    // other tools unaffected
    assert.equal(gate({ toolName: "read" }, ownedContext), undefined, "non-ask tools pass");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
