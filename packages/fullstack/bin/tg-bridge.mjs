#!/usr/bin/env node
/**
 * tg-bridge — autonomous Telegram bridge for omp-workflows CTO escalations.
 *
 * Runs OUTSIDE any omp session (the in-session dispatcher cannot answer when
 * no session is alive — e.g. the CTO finished and the user still writes to
 * the bot). Owns the bot's getUpdates long-poll — ONE consumer per token.
 *
 * Handles:
 *   1. Escalation answers (reply / inline button) -> answers/<escId>.json
 *      (delegated to TelegramEscalationAdapter.pollOnce).
 *   2. Plain messages:
 *      - active CTO run -> filed to <cwd>/.omp/inbox/ (the live session's
 *        dispatcher picks it up in <=10s; no reply — the session owns it);
 *      - finished run with summary.json -> replies with the run status
 *        (no LLM) AND files the message as a standby task;
 *      - nothing -> creates a standby run, files the task, replies that it
 *        was saved.
 *
 * Start:
 *   node packages/fullstack/bin/tg-bridge.mjs --cwd /path/to/project
 * or via the harness (survives sessions):
 *   hub start tg-bridge -- node .../tg-bridge.mjs --cwd <project>
 *
 * Requires <cwd>/.omp/escalation.json with adapter: telegram.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  loadEscalationConfig,
  createEscalationAdapter,
  writeBridgeLock,
  clearBridgeLock,
} from "../dist/adapters/registry.js";
import {
  classifyIncoming,
  sendTelegramText,
  writeAnswerMarker,
} from "../dist/telegram-bridge.js";

function arg(name) {
  const idx = process.argv.indexOf(name);
  return idx >= 0 && process.argv[idx + 1] ? process.argv[idx + 1] : undefined;
}

const cwd = arg("--cwd") ?? process.cwd();
const config = loadEscalationConfig(cwd);
if (!config || config.adapter !== "telegram" || !config.telegram?.token || !config.telegram.chatId) {
  console.error(`tg-bridge: no telegram escalation config at ${join(cwd, ".omp", "escalation.json")}`);
  process.exit(1);
}

// Claim the bot: the in-session dispatcher sees the lock and stops polling
// telegram itself (one getUpdates consumer per token).
writeBridgeLock(cwd);

const { token, chatId } = config.telegram;
const adapter = createEscalationAdapter(config, cwd);
const replied = new Set(); // message ids we already answered (dedupe)

adapter.setPlainMessageHandler((msg) => {
  try {
    if (replied.has(msg.id)) return;
    replied.add(msg.id);
    const result = classifyIncoming(cwd, msg);
    if (result.reply) {
      sendTelegramText(token, chatId, result.reply).then((ok) => {
        console.log(`tg-bridge: replied to ${msg.id} (${result.action}) ok=${ok}`);
      });
    } else {
      console.log(`tg-bridge: filed ${msg.id} as ${result.action} -> ${result.filedPath ?? "?"}`);
    }
  } catch (error) {
    console.error("tg-bridge: handler error", error instanceof Error ? error.message : error);
  }
});

const intervalMs = config.telegram.pollIntervalMs ?? 5_000;
const timer = setInterval(async () => {
  try {
    // Answers are written to answers/ by the adapter; forward each as a
    // marker so a live session wakes [CTO-ANSWER] without polling telegram.
    const answers = await adapter.pollOnce();
    for (const answer of answers) {
      if (!answer?.id) continue;
      const marker = writeAnswerMarker(cwd, answer);
      console.log(`tg-bridge: answer ${answer.id} -> answers/ + marker ${marker ?? "(dup)"}`);
    }
  } catch (error) {
    console.error("tg-bridge: poll error", error instanceof Error ? error.message : error);
  }
}, intervalMs);
void adapter.pollOnce().catch(() => undefined);
console.log(`tg-bridge: polling telegram every ${intervalMs}ms (cwd=${cwd}) — one consumer per token.`);

process.on("SIGINT", () => {
  clearInterval(timer);
  clearBridgeLock(cwd);
  process.exit(0);
});
process.on("SIGTERM", () => {
  clearInterval(timer);
  clearBridgeLock(cwd);
  process.exit(0);
});
