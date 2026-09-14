import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { channelMode, clearChannelCache, createAskRedirectGate } from "../src/messenger-channel.js";
import { resolveSessionCwd } from "../src/index.js";
import { openFullstackRuntimeTest } from "./runtime-access-fixture.js";

function withChannel(root: string, adapter: "telegram" | "http" | null): void {
  clearChannelCache();
  if (!adapter) return;
  mkdirSync(join(root, ".omp"), { recursive: true });
  writeFileSync(
    join(root, ".omp", "escalation.json"),
    JSON.stringify(adapter === "telegram" ? { adapter: "telegram", telegram: { token: "t", chatId: "c" } } : { adapter: "http", http: { url: "https://x" } }),
  );
}

function withActiveRun(runtime: ReturnType<typeof openFullstackRuntimeTest>): void {
  runtime.access.ensureStandbyRun();
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

test("messenger: channelMode ignores malformed, oversized, FIFO, and symlinked config", () => {
  const root = mkdtempSync(join(tmpdir(), "chan-invalid-"));
  const config = join(root, ".omp", "escalation.json");
  try {
    mkdirSync(join(root, ".omp"), { recursive: true });
    writeFileSync(config, Buffer.from([0xff, 0xfe]));
    assert.equal(channelMode(root), null, "invalid UTF-8 is non-authoritative");

    clearChannelCache();
    writeFileSync(config, JSON.stringify({ adapter: "telegram", payload: "x".repeat(8 * 1024) }));
    assert.equal(channelMode(root), null, "oversized config is non-authoritative");

    clearChannelCache();
    rmSync(config, { force: true });
    execFileSync("mkfifo", [config]);
    assert.equal(channelMode(root), null, "FIFO config is non-authoritative");

    clearChannelCache();
    rmSync(config, { force: true });
    const target = join(root, "outside.json");
    writeFileSync(target, JSON.stringify({ adapter: "telegram" }));
    symlinkSync(target, config);
    assert.equal(channelMode(root), null, "symlink config is non-authoritative");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("messenger: ask gate blocks only when telegram + active CTO run", () => {
  const root = mkdtempSync(join(tmpdir(), "ask-gate-"));
  const runtime = openFullstackRuntimeTest(root, "ask-gate");
  try {
    const gate = createAskRedirectGate(resolveSessionCwd, (cwd) => cwd === root ? runtime.access : undefined);

    // no channel -> ask passes
    assert.equal(gate({ toolName: "ask" }, { cwd: root }), undefined, "no channel -> pass");

    // telegram channel, no active run -> ask passes (normal interactive work)
    withChannel(root, "telegram");
    assert.equal(gate({ toolName: "ask" }, { cwd: root }), undefined, "telegram without run -> pass");

    // telegram + active run -> ask blocked with the outbox contract
    withActiveRun(runtime);
    const blocked = gate({ toolName: "ask" }, { cwd: root });
    assert.ok(blocked?.block === true, "ask blocked in messenger mode");
    assert.ok(blocked?.reason.includes("outbox"), "block reason names the outbox route");
    assert.ok(blocked?.reason.includes("answers/"), "block reason names the answers dir");

    // other tools unaffected
    assert.equal(gate({ toolName: "read" }, { cwd: root }), undefined, "non-ask tools pass");
  } finally {
    runtime.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("messenger: ask gate blocks active CTO when the index proof is corrupt or missing", () => {
  for (const mode of ["corrupt", "missing"] as const) {
    const root = mkdtempSync(join(tmpdir(), `ask-index-proof-${mode}-`));
    const runtime = openFullstackRuntimeTest(root, `ask-index-proof-${mode}`);
    try {
      withChannel(root, "telegram");
      withActiveRun(runtime);
      const proof = join(root, ".work-state", "cto", ".active-run-index.proof.json");
      if (mode === "corrupt") writeFileSync(proof, "not-json");
      else rmSync(proof, { force: true });
      const unavailableRuntime = {
        assertLive() {},
        assertProjectRoot() {},
        findActiveRun() {
          throw Object.assign(new Error(`active-run index ${mode} proof is unavailable`), { code: "CTO_AUTHORITY_UNAVAILABLE" });
        },
      } as unknown as ReturnType<typeof runtime.access>;
      const gate = createAskRedirectGate(resolveSessionCwd, () => unavailableRuntime);
      const blocked = gate({ toolName: "ask" }, { cwd: root });
      assert.equal(blocked?.block, true, `${mode} index proof blocks ask instead of falling back to interactive mode`);
      assert.match(blocked?.reason ?? "", /authority is unavailable/u, `${mode} proof failure is identified as an authority outage`);
      assert.match(blocked?.reason ?? "", /recover|re-established/u, `${mode} proof failure includes recovery remediation`);
    } finally {
      runtime.close();
      rmSync(root, { recursive: true, force: true });
    }
  }
});

test("messenger: ask gate blocks forged, missing, and mismatched session roots", () => {
  const rootA = mkdtempSync(join(tmpdir(), "ask-root-a-"));
  const rootB = mkdtempSync(join(tmpdir(), "ask-root-b-"));
  const runtime = openFullstackRuntimeTest(rootA, "ask-root-a");
  try {
    withChannel(rootA, "telegram");
    withActiveRun(runtime);
    const requested: string[] = [];
    const gate = createAskRedirectGate(resolveSessionCwd, (cwd) => {
      requested.push(cwd);
      return cwd === rootA ? runtime.access : undefined;
    });

    const forged = gate({ toolName: "ask" }, {
      cwd: rootB,
      sessionManager: { getCwd: () => rootA },
    });
    assert.equal(forged?.block, true, "manager/cwd disagreement blocks ask");
    assert.equal(requested.length, 0, "forged cwd never reaches runtime provider");

    const missing = gate({ toolName: "ask" }, {});
    assert.equal(missing?.block, true, "missing authoritative resolver result blocks ask");
    const malformed = gate({ toolName: "ask" }, { cwd: rootA, sessionManager: {} });
    assert.equal(malformed?.block, true, "malformed session manager blocks ask");
    const throwing = createAskRedirectGate(() => { throw new Error("manager unavailable"); }, () => runtime.access);
    assert.equal(throwing({ toolName: "ask" }, { cwd: rootA })?.block, true, "throwing resolver blocks ask");

    const mismatchedFacade = new Proxy(runtime.access, {
      get(target, property, receiver) {
        if (property === "assertProjectRoot") return () => { throw new Error("wrong runtime root"); };
        return Reflect.get(target, property, receiver);
      },
    });
    const mismatch = createAskRedirectGate(resolveSessionCwd, () => mismatchedFacade);
    assert.equal(mismatch({ toolName: "ask" }, { cwd: rootA })?.block, true, "mismatched runtime facade blocks ask");
  } finally {
    runtime.close();
    rmSync(rootA, { recursive: true, force: true });
    rmSync(rootB, { recursive: true, force: true });
  }
});
