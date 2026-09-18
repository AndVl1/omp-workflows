#!/usr/bin/env node

import { appendFileSync, existsSync } from "node:fs";

const targetGeneration = Number(process.env.TG_BRIDGE_CLAIM_GENERATION);
const root = process.env.TG_BRIDGE_CWD;
if (root && Number.isSafeInteger(targetGeneration) && targetGeneration >= 1) {
  const runtimeModule = await import(new URL("./runtime-access-fixture.ts", import.meta.url).href);
  for (let generation = 1; generation < targetGeneration; generation += 2) {
    const warmup = runtimeModule.openFullstackRuntimeTest(root, "tg-bridge-child-warmup-" + generation, undefined, false);
    warmup.close();
  }
}

const logPath = process.env.TG_BRIDGE_FETCH_LOG;
const parsedUpdateCount = Number(process.env.TG_BRIDGE_UPDATE_COUNT);
const updateCount = Number.isSafeInteger(parsedUpdateCount) && parsedUpdateCount >= 0 ? parsedUpdateCount : 0;
const parsedUpdateId = Number(process.env.TG_BRIDGE_UPDATE_ID);
const updateId = Number.isSafeInteger(parsedUpdateId) && parsedUpdateId >= 0 ? parsedUpdateId : 1;
const updateChat = process.env.TG_BRIDGE_UPDATE_CHAT ?? "123";
const updateText = process.env.TG_BRIDGE_UPDATE_TEXT ?? "bridge test task";
const waitForPath = process.env.TG_BRIDGE_WAIT_FOR;
const replyTo = Number(process.env.TG_BRIDGE_REPLY_TO);
let calls = 0;
function requestBody(init) {
  if (!init || typeof init.body !== "string") return {};
  try {
    const body = JSON.parse(init.body);
    return body && typeof body === "object" && !Array.isArray(body) ? body : {};
  } catch {
    return {};
  }
}
function record(url, init) {
  calls += 1;
  const body = requestBody(init);
  const fields = [];
  if (typeof body.offset === "number") fields.push(`offset=${body.offset}`);
  if (typeof body.chat_id === "string" || typeof body.chat_id === "number") fields.push(`chat=${body.chat_id}`);
  if (logPath) appendFileSync(logPath, `${calls} ${url}${fields.length > 0 ? ` ${fields.join(" ")}` : ""}\n`);
}

globalThis.fetch = async (url, init) => {
  const textUrl = String(url);
  record(textUrl, init);
  if (process.env.TG_BRIDGE_DEFER === "1" && textUrl.includes("getUpdates")) {
    await new Promise(() => {});
  }
  if (waitForPath && textUrl.includes("getUpdates")) {
    while (!existsSync(waitForPath)) await new Promise((resolve) => setTimeout(resolve, 10));
  }
  let result = [];
  if (textUrl.includes("getUpdates") && updateCount > 0) {
    result = Array.from({ length: updateCount }, (_, index) => ({
      update_id: updateId + index,
      message: {
        message_id: updateId + index,
        date: 1_700_000_000,
        text: updateText,
        chat: { id: Number(updateChat) },
        from: { id: 7 },
        ...(Number.isSafeInteger(replyTo) && replyTo >= 0 ? { reply_to_message: { message_id: replyTo } } : {}),
      },
    }));
  } else if (textUrl.includes("sendMessage")) {
    if (process.env.TG_BRIDGE_HOLD_SEND === "1") await new Promise(() => {});
    result = { message_id: calls };
  }
  return new Response(JSON.stringify({ ok: true, result }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
};
