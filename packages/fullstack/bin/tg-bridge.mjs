#!/usr/bin/env node
/**
 * tg-bridge — autonomous Telegram bridge for omp-workflows CTO escalations.
 *
 * This daemon is deliberately activation-gated. It may run outside an omp
 * session, but it must still observe the project's exact fullstack marker,
 * owner activation, and a main-session CTO runtime capability. There is no
 * autonomous bypass for a missing, conflicting, or revoked marker.
 *
 * Start only after the explicit project-local bootstrap has written
 * <cwd>/.omp/fullstack.activation.json:
 *   node packages/fullstack/bin/tg-bridge.mjs --cwd /path/to/project
 *
 * The bridge retains its canonical pin, activation, and runtime access for the
 * daemon lifetime. Revocation stops polling and deferred work, clears only the
 * lock owned by this process, closes runtime access, closes activation, then
 * closes the pin. Cleanup is idempotent and signal-safe.
 */

import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { TextDecoder } from "node:util";
import { join } from "node:path";
import { PinnedProjectRoot, normalizeChannelConfigResult } from "@andvl1/omp-workflows-core";
import { openWorkflowActivation, closeWorkflowActivation } from "@andvl1/omp-workflows-core/registry";
import { openCtoRuntimeBridgeRouteAccess, openCtoRuntimeProofAuthority, revokeCtoRuntimeProofAuthority } from "@andvl1/omp-workflows-core/cto-runtime";
import { fullstackOwnerForCwd } from "../dist/index.js";
import {
  createEscalationAdapter,
  writeBridgeLock,
  isBridgeLeaseOwned,
  refreshBridgeLock,
  clearBridgeLock,
  inboxMessageFileName,
} from "../dist/adapters/registry.js";
import { isTelegramPermanentError } from "../dist/adapters/telegram.js";
import {
  classifyIncoming,
  writeAnswerMarker,
} from "../dist/telegram-bridge.js";

function arg(name) {
  const idx = process.argv.indexOf(name);
  return idx >= 0 && process.argv[idx + 1] ? process.argv[idx + 1] : undefined;
}

const requestedCwd = arg("--cwd") ?? process.cwd();
const bridgePin = PinnedProjectRoot.open(requestedCwd);
if (!bridgePin) {
  console.error(`tg-bridge: project root is unavailable or unsafe (${requestedCwd})`);
  process.exit(1);
}
const projectRoot = bridgePin.canonical_root;
const leaseRoot = requestedCwd;
const owner = fullstackOwnerForCwd(projectRoot);
const activation = openWorkflowActivation(
  projectRoot,
  ["workflow_registration", "workflow_tools"],
  owner,
);
if (!activation.ok) {
  bridgePin.close();
  console.error(`tg-bridge: project activation unavailable (${activation.code})`);
  process.exit(1);
}

const sessionId = `tg-bridge:${process.pid}`;
const bridgeRoute = openCtoRuntimeBridgeRouteAccess(activation.registry_context, bridgePin);
const proofAuthority = openCtoRuntimeProofAuthority(activation.registry_context, bridgePin);
if (!bridgeRoute || !proofAuthority) {
  bridgeRoute?.close();
  revokeCtoRuntimeProofAuthority(proofAuthority);
  closeWorkflowActivation(activation);
  bridgePin.close();
  console.error(`tg-bridge: CTO bridge route unavailable (${projectRoot})`);
  process.exit(1);
}
let bridgeLease;
let bridgeHeartbeat;
let stopped = false;
let cleaned = false;
let revoking = false;

const ESCALATION_CONFIG_PATH = ".omp/escalation.json";
const MAX_ESCALATION_CONFIG_BYTES = 256 * 1024;
const TELEGRAM_CHECKPOINT_PATH = ".omp/tg-bridge.checkpoint.json";
const TELEGRAM_CHECKPOINT_SCHEMA = 1;
const checkpointMacKey = randomBytes(32);
// Never persist this key: a fresh daemon rejects old receipts and redelivers from offset 0,
// where canonical core identities make the local task/answer effect idempotent.

class BridgeConfigRevokedError extends Error {
  code = "config_revoked";

  constructor(reason = "escalation configuration changed after startup") {
    super(`telegram bridge configuration revoked (config_revoked): ${reason}`);
    this.name = "BridgeConfigRevokedError";
  }
}

function configDescriptor(read) {
  return {
    path: read.path,
    dev: read.dev,
    ino: read.ino,
    size: read.size,
    mtimeMs: read.mtimeMs,
    ctimeMs: read.ctimeMs,
  };
}

function sameConfigDescriptor(left, right) {
  return left.path === right.path
    && left.dev === right.dev
    && left.ino === right.ino
    && left.size === right.size
    && left.mtimeMs === right.mtimeMs
    && left.ctimeMs === right.ctimeMs;
}

function readPinnedConfig() {
  let read;
  try {
    read = bridgePin.readFile(ESCALATION_CONFIG_PATH, { maxBytes: MAX_ESCALATION_CONFIG_BYTES });
    const bytes = Buffer.from(read.bytes);
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    const parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("configuration document is not an object");
    return { bytes, descriptor: configDescriptor(read), config: parsed };
  } catch (error) {
    if (error instanceof BridgeConfigRevokedError) throw error;
    throw new BridgeConfigRevokedError("escalation configuration is unavailable or malformed");
  }
}

function telegramProfileKey(profile) {
  if (!profile || profile.adapter !== "telegram" || profile.transport !== "telegram" || profile.direction !== "rw" || profile.primary !== true) return null;
  return JSON.stringify({
    adapter: profile.adapter,
    transport: profile.transport,
    direction: profile.direction,
    primary: true,
    id: profile.id ?? null,
    ackTarget: profile.ackTarget ?? null,
    subscriptions: Array.isArray(profile.subscriptions) ? profile.subscriptions : null,
  });
}

function selectTelegramAdapterConfig(raw, authenticatedProjection) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new BridgeConfigRevokedError("Telegram configuration is not an object");
  const normalized = normalizeChannelConfigResult(raw, { telegram: { canReceiveInbound: true, canSend: true, canSendWithIdempotency: true } });
  if (normalized.status !== "valid") throw new BridgeConfigRevokedError("Telegram channel configuration is invalid");
  const matches = normalized.profiles.filter((profile) => telegramProfileKey(profile) !== null);
  if (matches.length !== 1 || telegramProfileKey(matches[0]) !== telegramProfileKey(authenticatedProjection)) {
    throw new BridgeConfigRevokedError("authenticated Telegram primary profile does not match pinned configuration");
  }
  const profile = matches[0];
  const channels = Array.isArray(raw.channels) ? raw.channels : [];
  const entry = channels.length > 0
    ? channels.find((candidate) => candidate && typeof candidate === "object" && !Array.isArray(candidate)
      && candidate.adapter === "telegram"
      && (typeof candidate.id === "string" ? candidate.id.trim() : "") === (profile.id ?? "")
      && candidate.primary === true)
    : undefined;
  if (channels.length > 0 && !entry) throw new BridgeConfigRevokedError("authenticated Telegram channel entry is unavailable");
  const fallback = raw.telegram && typeof raw.telegram === "object" && !Array.isArray(raw.telegram) ? raw.telegram : {};
  const selected = entry && entry.telegram && typeof entry.telegram === "object" && !Array.isArray(entry.telegram) ? entry.telegram : (entry ?? {});
  const telegram = channels.length > 0 ? { ...selected } : { ...fallback };
  if (typeof telegram.token !== "string" || telegram.token.length === 0
    || typeof telegram.chatId !== "string" || telegram.chatId.length === 0) {
    throw new BridgeConfigRevokedError("authenticated Telegram token/chatId is unavailable");
  }
  return Object.freeze({ adapter: "telegram", bidirectional: true, telegram: Object.freeze(telegram) });
}

function projectionDigest(projection) {
  try {
    const serialized = JSON.stringify(projection);
    if (typeof serialized !== "string") throw new Error("projection is not serializable");
    return createHash("sha256").update(serialized, "utf8").digest("hex");
  } catch (error) {
    if (error instanceof BridgeConfigRevokedError) throw error;
    throw new BridgeConfigRevokedError("Telegram channel projection is unavailable");
  }
}

function captureConfigSnapshot() {
  const first = readPinnedConfig();
  const config = first.config;
  const projection = bridgeRoute.resolveTelegramChannelProfile();
  if (!config || !projection) return null;
  const adapterConfig = selectTelegramAdapterConfig(config, projection);
  const selectedProjectionDigest = projectionDigest(projection);
  const second = readPinnedConfig();
  if (!sameConfigDescriptor(first.descriptor, second.descriptor) || !first.bytes.equals(second.bytes)) {
    throw new BridgeConfigRevokedError("escalation configuration changed during startup");
  }
  return Object.freeze({
    bytes: first.bytes,
    descriptor: first.descriptor,
    projectionDigest: selectedProjectionDigest,
    config,
    adapterConfig,
  });
}

function assertPinnedConfig(snapshot) {
  const current = readPinnedConfig();
  if (!sameConfigDescriptor(snapshot.descriptor, current.descriptor) || !snapshot.bytes.equals(current.bytes)) {
    throw new BridgeConfigRevokedError();
  }
  const projection = bridgeRoute.resolveTelegramChannelProfile();
  if (!projection || projectionDigest(projection) !== snapshot.projectionDigest) {
    throw new BridgeConfigRevokedError("Telegram channel projection changed after startup");
  }
  selectTelegramAdapterConfig(current.config, projection);
}

class BridgeRouteUnavailableError extends Error {
  code = "route_unavailable";

  constructor(reason) {
    super(`telegram bridge route unavailable (route_unavailable): ${reason}`);
    this.name = "BridgeRouteUnavailableError";
  }
}

function routeProfileKey(profile) {
  if (!profile || typeof profile !== "object" || Array.isArray(profile)) return null;
  return JSON.stringify({
    direction: profile.direction ?? null,
    transport: profile.transport ?? null,
    adapter: profile.adapter ?? null,
    id: profile.id ?? null,
    ackTarget: profile.ackTarget ?? null,
    primary: profile.primary === true,
    subscriptions: Array.isArray(profile.subscriptions) ? profile.subscriptions : null,
  });
}

function expectedTelegramRoute(config) {
  const normalized = normalizeChannelConfigResult(config, {
    telegram: { canReceiveInbound: true, canSend: true, canSendWithIdempotency: true },
  });
  if (normalized.status !== "valid") return null;
  const matches = normalized.profiles.filter((profile) => profile.adapter === "telegram"
    && profile.transport === "telegram" && profile.direction === "rw" && profile.primary === true);
  if (matches.length !== 1) return null;
  const profile = matches[0];
  const key = routeProfileKey(profile);
  return key ? { key, profile } : null;
}

function resolveRouteSession(config) {
  const expected = expectedTelegramRoute(config);
  if (!expected) throw new BridgeRouteUnavailableError("the pinned Telegram configuration has no unique read-write primary route");
  bridgeRoute.assertLive();
  const selected = bridgeRoute.resolveTelegramRoute();
  if (!selected) {
    const candidates = bridgeRoute.readActiveDeliveryCandidates();
    if (candidates && candidates.ok === true && Array.isArray(candidates.entries)
      && !candidates.entries.some((entry) => entry && typeof entry === "object" && entry.status === "active")) {
      return { sessionId, runId: null, standby: true, blocked: false };
    }
    if (candidates && candidates.ok === false && candidates.code === "missing") {
      return { sessionId, runId: null, standby: true, blocked: false };
    }
    return { sessionId, runId: null, standby: false, blocked: true };
  }
  if (routeProfileKey(selected.channelProfile) !== expected.key) {
    throw new BridgeRouteUnavailableError("authenticated Telegram route changed during selection");
  }
  bridgeRoute.assertLive();
  return { sessionId: selected.ownerSession, runId: selected.runId, standby: false };
}

function checkpointBinding(snapshot) {
  const expected = expectedTelegramRoute(snapshot.config);
  if (!expected) throw new BridgeConfigRevokedError("Telegram channel route is unavailable");
  const token = snapshot.adapterConfig.telegram.token;
  const target = String(snapshot.adapterConfig.telegram.chatId);
  const botDigest = createHash("sha256").update(token, "utf8").digest("hex");
  const profileDigest = createHash("sha256").update(expected.key, "utf8").digest("hex");
  return Object.freeze({
    format_version: TELEGRAM_CHECKPOINT_SCHEMA,
    canonical_root: projectRoot,
    projection_sha256: snapshot.projectionDigest,
    bot_sha256: botDigest,
    channel: "telegram",
    target,
    route_profile_sha256: profileDigest,
  });
}

function checkpointMessage(binding, highWater) {
  return JSON.stringify({ ...binding, high_water_update_id: highWater });
}

function checkpointSignature(binding, highWater) {
  return createHmac("sha256", checkpointMacKey)
    .update("omp-tg-bridge-checkpoint-v1\u0000", "utf8")
    .update(checkpointMessage(binding, highWater), "utf8")
    .digest("hex");
}

function emptyTelegramCheckpoint(snapshot) {
  return Object.freeze({ highWater: -1, projectionDigest: snapshot.projectionDigest });
}

function readTelegramCheckpoint(snapshot) {
  const empty = emptyTelegramCheckpoint(snapshot);
  try {
    const entry = bridgePin.pathEntryInfo(TELEGRAM_CHECKPOINT_PATH);
    if (!entry || entry.kind !== "file") return empty;
    const read = bridgePin.readFile(TELEGRAM_CHECKPOINT_PATH, { maxBytes: 4 * 1024 });
    const text = new TextDecoder("utf-8", { fatal: true }).decode(read.bytes);
    const record = JSON.parse(text);
    const keys = record && typeof record === "object" && !Array.isArray(record) ? Object.keys(record).sort().join("\\u0000") : "";
    const expectedKeys = ["bot_sha256", "canonical_root", "channel", "format_version", "high_water_update_id", "projection_sha256", "route_profile_sha256", "signature", "target"].join("\\u0000");
    if (!record || typeof record !== "object" || Array.isArray(record) || keys !== expectedKeys
      || record.format_version !== TELEGRAM_CHECKPOINT_SCHEMA
      || record.canonical_root !== projectRoot
      || record.projection_sha256 !== snapshot.projectionDigest
      || record.channel !== "telegram"
      || record.target !== String(snapshot.adapterConfig.telegram.chatId)
      || !/^[0-9a-f]{64}$/u.test(record.bot_sha256)
      || !/^[0-9a-f]{64}$/u.test(record.route_profile_sha256)
      || !Number.isSafeInteger(record.high_water_update_id)
      || record.high_water_update_id < 0
      || !/^[0-9a-f]{64}$/u.test(record.signature)) return empty;
    const binding = checkpointBinding(snapshot);
    if (record.bot_sha256 !== binding.bot_sha256 || record.route_profile_sha256 !== binding.route_profile_sha256) return empty;
    const expectedSignature = checkpointSignature(binding, record.high_water_update_id);
    const observed = Buffer.from(record.signature, "hex");
    const expected = Buffer.from(expectedSignature, "hex");
    if (observed.length !== expected.length || !timingSafeEqual(observed, expected)) return empty;
    return Object.freeze({ highWater: record.high_water_update_id, projectionDigest: snapshot.projectionDigest });
  } catch {
    // A malformed, foreign, unsigned, symlinked, or hard-linked receipt is
    // ignored. It never authorizes an offset or a write.
    return empty;
  }
}

function writeTelegramCheckpoint(nextHighWater, snapshot) {
  if (!Number.isSafeInteger(nextHighWater) || nextHighWater < 0 || nextHighWater <= telegramCheckpoint.highWater) return;
  assertLive();
  assertPinnedConfig(snapshot);
  const binding = checkpointBinding(snapshot);
  const record = {
    ...binding,
    high_water_update_id: nextHighWater,
    signature: checkpointSignature(binding, nextHighWater),
  };
  const encoded = JSON.stringify(record) + "\n";
  try {
    const target = bridgePin.pathEntryInfo(TELEGRAM_CHECKPOINT_PATH);
    if (target?.kind === "symlink") bridgePin.removeEntry(TELEGRAM_CHECKPOINT_PATH);
    else if (target && target.kind !== "file") throw new Error("checkpoint target is not a regular file");
    bridgePin.writeAtomic(TELEGRAM_CHECKPOINT_PATH, encoded);
  } catch (error) {
    throw new BridgeConfigRevokedError("Telegram update checkpoint could not be persisted");
  }
  assertLive();
  assertPinnedConfig(snapshot);
  telegramCheckpoint = Object.freeze({ highWater: nextHighWater, projectionDigest: snapshot.projectionDigest });
}

function revoke(reason, exitCode = 1) {
  if (revoking) return;
  revoking = true;
  stopped = true;
  clearInterval(bridgeHeartbeat);
  if (reason) console.error(`tg-bridge: ${reason}`);
  try {
    // Cleanup may run after marker revocation; only remove a lock that is
    // still stable and authenticated as this exact process's lease.
    if (bridgeLease?.owned && bridgePin.isStable() && isBridgeLeaseOwned(leaseRoot, bridgeLease, bridgePin, proofAuthority)) {
      clearBridgeLock(leaseRoot, bridgeLease, bridgePin, proofAuthority);
    }
  } catch (error) {
    console.error("tg-bridge: lease cleanup failed", error instanceof Error ? error.message : error);
  }
  if (cleaned) return;
  cleaned = true;
  try { bridgeRoute.close(); } catch { /* cleanup is idempotent */ }
  try { revokeCtoRuntimeProofAuthority(proofAuthority); } catch { /* cleanup is idempotent */ }

  try { closeWorkflowActivation(activation); } catch { /* cleanup is idempotent */ }
  try { bridgePin.close(); } catch { /* cleanup is idempotent */ }
  process.exit(exitCode);
}

function assertLive(candidatePin = bridgePin) {
  if (stopped || revoking) throw new Error("telegram bridge activation is revoked");
  bridgeRoute.assertLive();
  bridgeRoute.assertLive();
  if (candidatePin.canonical_root !== projectRoot || !candidatePin.isStable() || !bridgePin.isStable()) {
    throw new Error("telegram bridge project root changed");
  }
  // Re-check after the root and runtime assertions: marker/root replacement
  // between checks must fail before any side effect.
  bridgeRoute.assertLive();
  bridgeRoute.assertLive();
  if (!candidatePin.isStable() || !bridgePin.isStable()) throw new Error("telegram bridge project root changed");
}

function failClosed(error) {
  revoke(error instanceof Error ? error.message : String(error), 1);
}

let configSnapshot;
try {
  assertLive();
  configSnapshot = captureConfigSnapshot();
  assertLive();
} catch (error) {
  failClosed(error);
}
if (!configSnapshot) {
  revoke(`no telegram escalation config at ${join(projectRoot, ESCALATION_CONFIG_PATH)}`, 1);
}
const config = configSnapshot.config;
const adapterConfig = configSnapshot.adapterConfig;
if (!adapterConfig) {
  revoke(`no telegram escalation config at ${join(projectRoot, ESCALATION_CONFIG_PATH)}`, 1);
}

let telegramCheckpoint = readTelegramCheckpoint(configSnapshot);
try {
  assertLive();
  assertPinnedConfig(configSnapshot);
  bridgeLease = writeBridgeLock(leaseRoot, bridgePin, proofAuthority);
  assertLive();
  assertPinnedConfig(configSnapshot);
} catch (error) {
  failClosed(error);
}
if (!bridgeLease?.owned || typeof bridgeLease.token !== "string" || !isBridgeLeaseOwned(leaseRoot, bridgeLease, bridgePin, proofAuthority)) {
  revoke(`another bridge owns the Telegram consumer (${projectRoot})`, 1);
}

let adapter;
try {
  assertLive();
  assertPinnedConfig(configSnapshot);
  adapter = createEscalationAdapter(adapterConfig, projectRoot, bridgePin, undefined, proofAuthority, bridgeRoute);
  assertLive();
  assertPinnedConfig(configSnapshot);
  if (!adapter || typeof adapter.setUpdateCommitHook !== "function") throw new Error("telegram adapter does not support durable update commits");
  adapter.setUpdateCommitHook((updateId, callbackPin) => {
    assertLive(callbackPin ?? bridgePin);
    assertPinnedConfig(configSnapshot);
    const routeAccess = openInboundRuntimeAccess();
    closeInboundRuntimeAccess(routeAccess);
    writeTelegramCheckpoint(updateId, configSnapshot);
    crashForTest("after-checkpoint");
  });
  if (typeof adapter.setInitialOffset !== "function") throw new Error("telegram adapter does not support checkpoint offsets");
  adapter.setInitialOffset(telegramCheckpoint.highWater + 1);
} catch (error) {
  failClosed(error);
}
if (!adapter) revoke(`telegram adapter construction failed (${projectRoot})`, 1);

const { chatId } = adapterConfig.telegram;
const pendingPlainAcks = [];

function crashForTest(seam) {
  if (process.env.NODE_ENV === "test" && process.env.TG_BRIDGE_TEST_CRASH === seam) process.kill(process.pid, "SIGKILL");
}

async function assertAround(action, candidatePin = bridgePin) {
  assertLive(candidatePin);
  assertPinnedConfig(configSnapshot);
  const result = await action();
  assertLive(candidatePin);
  assertPinnedConfig(configSnapshot);
  return result;
}

function openInboundRuntimeAccess() {
  assertLive();
  assertPinnedConfig(configSnapshot);
  const route = resolveRouteSession(config);
  return { access: undefined, routeAccess: bridgeRoute, owned: false, standby: route.standby, blocked: route.blocked === true, runId: route.runId };
}

function closeInboundRuntimeAccess(binding) {
  if (!binding?.owned) return;
  try { binding.access.close(); } catch { /* per-update access cleanup is idempotent */ }
}

adapter.setPlainMessageHandler(async (msg, suppliedPin) => {
  const callbackPin = suppliedPin ?? bridgePin;
  let inboundRuntime;
  try {
    crashForTest("before-core");
    inboundRuntime = openInboundRuntimeAccess();
    if (inboundRuntime.blocked) {
      assertLive(callbackPin);
      assertPinnedConfig(configSnapshot);
      throw new BridgeRouteUnavailableError("authenticated active Telegram route candidates are unavailable; retrying without committing the update");
    }
    const result = classifyIncoming(leaseRoot, msg, callbackPin, inboundRuntime.access, proofAuthority, inboundRuntime.routeAccess);
    assertLive(callbackPin);
    assertPinnedConfig(configSnapshot);
    crashForTest("after-core");
    const shouldReply = result.reply !== undefined && result.filedPath !== null;
    if (shouldReply && typeof adapter.sendPlainText === "function") {
      const targetChatId = msg.chatId ?? chatId;
      // The adapter invokes this callback before its commit hook. Queue the
      // optional acknowledgement so core persistence and high-water commit
      // complete first; each entry is attempted at most once.
      pendingPlainAcks.push({ id: msg.id, targetChatId, reply: result.reply, action: result.action, callbackPin });
    } else if (shouldReply) {
      throw new Error(`telegram bridge transport '${adapter.kind}' has no sendPlainText`);
    } else {
      assertLive(callbackPin);
      assertPinnedConfig(configSnapshot);
      console.log(`tg-bridge: filed ${msg.id} as ${result.action} -> ${result.filedPath ?? "?"}`);
    }
  } catch (error) {
    console.error("tg-bridge: handler error", error instanceof Error ? error.message : error);
    throw error;
  } finally {
    closeInboundRuntimeAccess(inboundRuntime);
  }
});

if (typeof adapter.setAnswerHandler === "function") {
  adapter.setAnswerHandler(async (answer, suppliedPin) => {
    const callbackPin = suppliedPin ?? bridgePin;
    let inboundRuntime;
    try {
      inboundRuntime = openInboundRuntimeAccess();
      assertLive(callbackPin);
      assertPinnedConfig(configSnapshot);
      const marker = writeAnswerMarker(leaseRoot, answer, callbackPin, inboundRuntime.access, proofAuthority, inboundRuntime.routeAccess);
      assertLive(callbackPin);
      assertPinnedConfig(configSnapshot);
      console.log(`tg-bridge: answer ${answer.id} -> answers/ + marker ${marker ?? "(dup)"}`);
    } finally {
      closeInboundRuntimeAccess(inboundRuntime);
    }
  });
}

const intervalMs = adapterConfig.telegram.pollIntervalMs ?? 5_000;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function flushPlainAcks() {
  while (pendingPlainAcks.length > 0) {
    const ack = pendingPlainAcks.shift();
    if (!ack) continue;
    try {
      const outcome = await assertAround(
        () => adapter.sendPlainText(ack.targetChatId, ack.reply, ack.callbackPin),
        ack.callbackPin,
      );
      if (outcome.status === "retryable") {
        console.error(`tg-bridge: optional reply delivery failed for ${ack.id} (retryable; not retried)`);
      } else if (outcome.status === "permanent") {
        console.error(`tg-bridge: reply rejected permanently for ${ack.id} in chat ${ack.targetChatId} (${outcome.httpStatus ?? "unknown"}); task remains filed`);
      } else {
        console.log(`tg-bridge: replied to ${ack.id} in chat ${ack.targetChatId} (${ack.action}) ok=${outcome.sent}`);
      }
    } catch (error) {
      if (error instanceof BridgeConfigRevokedError) throw error;
      console.error(`tg-bridge: optional reply delivery failed for ${ack.id}`, error instanceof Error ? error.message : error);
    }
  }
}

// Self-scheduling loop: a new poll starts only after the previous round
// finished, so there is never more than one in-flight getUpdates per token.
async function pollLoop() {
  while (!stopped) {
    try {
      assertLive();
      assertPinnedConfig(configSnapshot);
      if (!isBridgeLeaseOwned(leaseRoot, bridgeLease, bridgePin, proofAuthority) || !refreshBridgeLock(leaseRoot, bridgeLease, bridgePin, proofAuthority)) {
        throw new Error("telegram bridge lease lost before getUpdates");
      }
      assertLive();
      assertPinnedConfig(configSnapshot);
      await assertAround(() => adapter.pollOnce(bridgePin));
      await flushPlainAcks();

    } catch (error) {
      pendingPlainAcks.length = 0;
      console.error("tg-bridge: poll error", error instanceof Error ? error.message : error);
      if (error instanceof BridgeConfigRevokedError) {
        revoke(error.message, 1);
        return;
      }
      if (isTelegramPermanentError(error) || !stopped) {
        try { assertLive(); } catch { /* revoke below */ }
      }
      if (isTelegramPermanentError(error) || revoking || stopped) {
        revoke(isTelegramPermanentError(error) ? "permanent Telegram error" : "telegram bridge activation revoked", 1);
        return;
      }
    }
    if (stopped) break;
    try {
      await sleep(intervalMs);
      assertLive();
      assertPinnedConfig(configSnapshot);
    } catch (error) {
      revoke(error, 1);
      return;
    }
  }
}

bridgeHeartbeat = setInterval(() => {
  try {
    assertLive();
    assertPinnedConfig(configSnapshot);
    if (!isBridgeLeaseOwned(leaseRoot, bridgeLease, bridgePin, proofAuthority) || !refreshBridgeLock(leaseRoot, bridgeLease, bridgePin, proofAuthority)) {
      throw new Error("telegram bridge lease lost during heartbeat");
    }
    assertLive();
    assertPinnedConfig(configSnapshot);
  } catch (error) {
    revoke(error instanceof Error ? error.message : String(error), 1);
  }
}, 5_000);

void pollLoop();
console.log(`tg-bridge: ready; polling telegram every ${intervalMs}ms (cwd=${projectRoot}) — explicit marker + main runtime active.`);
process.once("SIGINT", () => revoke("SIGINT", 0));
process.once("SIGTERM", () => revoke("SIGTERM", 0));
