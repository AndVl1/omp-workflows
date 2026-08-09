/**
 * Channel normalizer tests (cto-core, architecture-2/4): one resolved
 * ChannelProfile from legacy single-adapter AND explicit multi-channel
 * configs; the capability rule (declared rw needs inbound+outbound, ro never
 * upgrades); never-throws behavior; and the renderChannelSection modes the
 * /cto prompts rely on (discovery-1).
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  normalizeChannelConfig,
  resolveChannelProfile,
  hasRwPrimary,
  loadEscalationConfigRaw,
  renderChannelSection,
  type ChannelCapabilities,
} from "@andvl1/omp-workflows-core";

function makeCwd(config?: unknown): string {
  const cwd = mkdtempSync(join(tmpdir(), "channels-"));
  if (config !== undefined) {
    mkdirSync(join(cwd, ".omp"), { recursive: true });
    writeFileSync(join(cwd, ".omp", "escalation.json"), JSON.stringify(config));
  }
  return cwd;
}

function cleanup(cwd: string): void {
  rmSync(cwd, { recursive: true, force: true });
}

test("channels: no config → direction none, empty normalization", () => {
  const cwd = makeCwd();
  try {
    assert.deepEqual(normalizeChannelConfig(null), []);
    assert.equal(loadEscalationConfigRaw(cwd), null);
    assert.deepEqual(resolveChannelProfile(cwd), { direction: "none" });
    assert.equal(hasRwPrimary(cwd), false);
  } finally {
    cleanup(cwd);
  }
});

test("channels: legacy http → ro (push-only, primary)", () => {
  const cwd = makeCwd({ adapter: "http", http: { url: "https://x" } });
  try {
    const profiles = normalizeChannelConfig(loadEscalationConfigRaw(cwd));
    assert.equal(profiles.length, 1);
    assert.equal(profiles[0]?.direction, "ro");
    assert.equal(profiles[0]?.transport, "http");
    assert.equal(profiles[0]?.primary, true);
    assert.deepEqual(resolveChannelProfile(cwd), { direction: "ro", transport: "http", adapter: "http", ackTarget: undefined, primary: true, subscriptions: undefined });
    assert.equal(hasRwPrimary(cwd), false);
  } finally {
    cleanup(cwd);
  }
});

test("channels: legacy telegram → rw with ackTarget from telegram chatId", () => {
  const cwd = makeCwd({ adapter: "telegram", telegram: { chatId: "chat-9" } });
  try {
    const profile = resolveChannelProfile(cwd);
    assert.equal(profile.direction, "rw");
    assert.equal(profile.ackTarget, "chat-9");
    assert.equal(profile.primary, true);
    assert.equal(hasRwPrimary(cwd), true);
  } finally {
    cleanup(cwd);
  }
});

test("channels: legacy non-telegram adapter + bidirectional:true → rw (legacy RW path)", () => {
  const cwd = makeCwd({ adapter: "slack", bidirectional: true });
  try {
    const profiles = normalizeChannelConfig(loadEscalationConfigRaw(cwd));
    assert.equal(profiles.length, 1);
    assert.equal(profiles[0]?.direction, "rw", "bidirectional flag normalizes to rw");
    assert.equal(resolveChannelProfile(cwd).direction, "rw");
  } finally {
    cleanup(cwd);
  }
});

test("channels: explicit channels — rw primary control + ro audit with subscriptions", () => {
  const cwd = makeCwd({
    channels: [
      { id: "control", adapter: "telegram", direction: "read-write", primary: true, ackTarget: "chat-1", subscriptions: ["commands", "answers"] },
      { id: "audit", adapter: "http", direction: "read-only", subscriptions: ["reports"] },
    ],
  });
  try {
    const profiles = normalizeChannelConfig(loadEscalationConfigRaw(cwd));
    assert.equal(profiles.length, 2);
    const control = profiles.find((p) => p.primary === true);
    assert.equal(control?.direction, "rw");
    assert.equal(control?.transport, "telegram");
    assert.equal(control?.ackTarget, "chat-1", "ackTarget passthrough");
    assert.deepEqual(control?.subscriptions, ["commands", "answers"]);
    const audit = profiles.find((p) => !p.primary);
    assert.equal(audit?.direction, "ro");
    assert.deepEqual(audit?.subscriptions, ["reports"]);

    const resolved = resolveChannelProfile(cwd);
    assert.equal(resolved.direction, "rw", "RW primary preferred");
    assert.equal(resolved.ackTarget, "chat-1");
    assert.deepEqual(resolved.subscriptions, ["commands", "answers"]);
    assert.equal(hasRwPrimary(cwd), true);
  } finally {
    cleanup(cwd);
  }
});

test("channels: capability rule — declared rw downgrades to ro without inbound+outbound; ro never upgrades", () => {
  const capsNoInbound: Record<string, ChannelCapabilities> = { telegram: { canReceiveInbound: false, canSend: true } };
  const cwd = makeCwd({ channels: [{ id: "c", adapter: "telegram", direction: "read-write", primary: true }] });
  try {
    assert.equal(resolveChannelProfile(cwd).direction, "rw", "built-in telegram defaults are rw");
    assert.equal(resolveChannelProfile(cwd, capsNoInbound).direction, "ro", "declared rw downgrades when inbound missing");
    const fullCaps: Record<string, ChannelCapabilities> = { http: { canReceiveInbound: true, canSend: true } };
    const roCwd = makeCwd({ channels: [{ id: "a", adapter: "http", direction: "read-only" }] });
    try {
      assert.equal(resolveChannelProfile(roCwd, fullCaps).direction, "ro", "read-only never upgrades even with full capabilities");
    } finally {
      cleanup(roCwd);
    }
  } finally {
    cleanup(cwd);
  }
});

test("channels: built-in defaults apply only when capabilities param is absent", () => {
  // absent param: http rw declared → ro (builtin http is push-only), custom kind → ro, telegram rw stays rw
  const cwd = makeCwd({
    channels: [
      { id: "h", adapter: "http", direction: "read-write" },
      { id: "x", adapter: "custom-webhook", direction: "read-write" },
      { id: "t", adapter: "telegram", direction: "read-write" },
    ],
  });
  try {
    const profiles = normalizeChannelConfig(loadEscalationConfigRaw(cwd));
    const byId = Object.fromEntries(profiles.map((p) => [p.adapter, p.direction]));
    assert.equal(byId["http"], "ro", "builtin http is push-only → declared rw downgrades");
    assert.equal(byId["custom-webhook"], "ro", "unknown kind is push-only → declared rw downgrades");
    assert.equal(byId["telegram"], "rw", "builtin telegram is rw → declared rw honored");
  } finally {
    cleanup(cwd);
  }
  // explicit capabilities table with NO entry for the kind → no constraint (declared rw stands)
  const cwd2 = makeCwd({ channels: [{ id: "c", adapter: "my-kind", direction: "read-write" }] });
  try {
    assert.equal(resolveChannelProfile(cwd2, {}).direction, "rw", "absent capability entry imposes no constraint");
  } finally {
    cleanup(cwd2);
  }
});

test("channels: resolveChannelProfile never throws on malformed JSON or missing cwd", () => {
  const cwd = mkdtempSync(join(tmpdir(), "channels-"));
  try {
    mkdirSync(join(cwd, ".omp"), { recursive: true });
    writeFileSync(join(cwd, ".omp", "escalation.json"), "{ not json !!");
    assert.equal(loadEscalationConfigRaw(cwd), null);
    assert.deepEqual(resolveChannelProfile(cwd), { direction: "none" });
    assert.equal(hasRwPrimary(cwd), false);
  } finally {
    cleanup(cwd);
  }
  // missing directory entirely
  const missing = join(tmpdir(), "channels-missing-" + Date.now());
  assert.deepEqual(resolveChannelProfile(missing), { direction: "none" });
});

test("channels: renderChannelSection distinguishes none / RW-primary / RO-report modes (discovery-1)", () => {
  const root = makeCwd();
  try {
    mkdirSync(join(root, ".omp"), { recursive: true });
    assert.ok(renderChannelSection(root).includes("### User channel (none)"), "none mode");
    assert.ok(renderChannelSection(root).includes("TERMINAL-ONLY"), "none mode named TERMINAL-ONLY");

    writeFileSync(join(root, ".omp", "escalation.json"), JSON.stringify({ channels: [{ id: "c", adapter: "telegram", direction: "read-write", primary: true }] }));
    const rw = renderChannelSection(root);
    assert.ok(rw.includes("BIDIRECTIONAL"), "rw mode marks BIDIRECTIONAL");
    assert.ok(rw.includes("VALIDATED RW-PRIMARY"), "rw mode named VALIDATED RW-PRIMARY");
    assert.ok(rw.includes("NEVER use the `ask` tool"), "rw mode bans ask");
    assert.ok(rw.includes("outbox"), "rw mode routes via outbox");
    assert.ok(rw.includes("USER COMMAND"), "rw mode keeps the USER COMMAND contract");

    writeFileSync(join(root, ".omp", "escalation.json"), JSON.stringify({ channels: [{ id: "a", adapter: "http", direction: "read-only" }] }));
    const ro = renderChannelSection(root);
    assert.ok(ro.includes("push-only"), "ro mode marks push-only");
    assert.ok(ro.includes("RO-REPORT"), "ro mode named RO-REPORT");
    assert.ok(ro.includes("Use `ask`"), "ro mode keeps ask for checkpoints");
    assert.ok(!ro.includes("BIDIRECTIONAL"), "ro mode is not messenger mode");
  } finally {
    cleanup(root);
  }
});

test("channels: two explicit same-kind id-less entries are BOTH excluded (ambiguous, fail-closed)", () => {
  const profiles = normalizeChannelConfig({
    channels: [
      { adapter: "mock", direction: "read-write", primary: true },
      { adapter: "mock", direction: "read-only" },
    ],
  });
  assert.deepEqual(profiles, [], "id-less same-kind duplicates never silently collide — both excluded");
});

test("channels: two same-kind entries with distinct ids are BOTH present with ids", () => {
  const profiles = normalizeChannelConfig({
    channels: [
      { id: "ctrl", adapter: "mock", direction: "read-write", primary: true },
      { id: "audit", adapter: "mock", direction: "read-only", subscriptions: ["summary"] },
    ],
  });
  assert.equal(profiles.length, 2);
  const ctrl = profiles.find((p) => p.id === "ctrl");
  const audit = profiles.find((p) => p.id === "audit");
  assert.ok(ctrl, "ctrl profile present");
  assert.equal(ctrl?.direction, "rw");
  assert.equal(ctrl?.primary, true);
  assert.ok(audit, "audit profile present");
  assert.equal(audit?.direction, "ro");
  assert.deepEqual(audit?.subscriptions, ["summary"]);
});

test("channels: duplicate ids across same-kind entries are BOTH excluded", () => {
  const profiles = normalizeChannelConfig({
    channels: [
      { id: "dup", adapter: "mock", direction: "read-write", primary: true },
      { id: "dup", adapter: "mock", direction: "read-only" },
    ],
  });
  assert.deepEqual(profiles, [], "duplicate-id same-kind entries excluded fail-closed");
});

test("channels: legacy single-adapter config unchanged — single profile, no id", () => {
  const profiles = normalizeChannelConfig({ adapter: "telegram", telegram: { chatId: "chat-9" } });
  assert.equal(profiles.length, 1);
  assert.equal(profiles[0]?.direction, "rw");
  assert.equal(profiles[0]?.primary, true);
  assert.equal(profiles[0]?.id, undefined, "legacy profile carries no id");
  assert.equal("id" in (profiles[0] ?? {}), false, "no id key present on the legacy profile");
});
