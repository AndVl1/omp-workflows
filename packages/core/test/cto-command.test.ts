/**
 * Core /cto command contract tests: parseCtoEnvelope, buildCtoPrompt,
 * ctoCommand (CommandContext surface). Consumers wire these into their own
 * commands/hooks — the prompt contract must stay stable.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  buildCtoPrompt,
  buildStandbyCtoPrompt,
  parseCtoEnvelope,
  renderChannelSection,
  ctoCommand,
} from "@andvl1/omp-workflows-core";

const TEAMS_JSON = [
  {
    id: "kotlin-backend",
    name: "Kotlin Backend",
    scope: ["backend-kotlin"],
    profile: "lightweight",
    lead: "team-lead",
    roster: ["backend-kotlin"],
  },
];

test("cto-cmd: parseCtoEnvelope handles prefixes and issue", () => {
  const root = mkdtempSync(join(tmpdir(), "cto-core-"));
  try {
    const plain = parseCtoEnvelope("Add OAuth issue=#3", root);
    assert.equal(plain.task, "Add OAuth");
    assert.equal(plain.issue, 3);
    assert.equal(plain.autonomous, false);

    const auto = parseCtoEnvelope("[AUTONOMOUS] Fix bug issue=#9", root);
    assert.equal(auto.autonomous, true);
    assert.equal(auto.task, "Fix bug");
    assert.equal(auto.issue, 9);
    assert.equal(auto.branch, null); // tmpdir is not a git work tree
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("cto-cmd: buildCtoPrompt renders teams from .omp/teams.json", () => {
  const root = mkdtempSync(join(tmpdir(), "cto-core-"));
  try {
    mkdirSync(join(root, ".omp"), { recursive: true });
    writeFileSync(join(root, ".omp", "teams.json"), JSON.stringify(TEAMS_JSON));
    const prompt = buildCtoPrompt(parseCtoEnvelope("Add OAuth", root), root);
    assert.ok(prompt.includes("| `kotlin-backend` | Kotlin Backend |"));
    assert.ok(prompt.includes("Escalation ladder"));
    assert.ok(prompt.includes("runCto"));
    assert.ok(prompt.includes("max 8, decomposition depth max 2"));
    assert.ok(prompt.includes("Leads never write source"), "lead self-coding forbidden in the contract");
    assert.ok(prompt.includes("self-coding lead"), "CTO must reject self-coding leads");
    assert.ok(prompt.includes("You ARE the orchestrator"), "single-CTO rule in the contract");
    assert.ok(prompt.includes("never spawn a CTO"), "no sub-CTO delegation allowed");
    assert.ok(prompt.includes("resident CTO"), "main-session CTO role in the contract");
    assert.ok(
      prompt.includes("task(agent=cto)") && prompt.includes("task(agent=@cto)"),
      "nested CTO dispatch forbidden in the contract",
    );
    assert.ok(prompt.includes("return to standby"), "CTO returns to standby after the wave");
    assert.ok(prompt.includes("full-feature"), "full-feature available as team sub-profile");
    assert.ok(prompt.includes("debug-cycle"), "bug-fix slices run debug-cycle through the team");
    assert.ok(prompt.includes("Architecture first"), "architecture stage in the contract");
    assert.ok(prompt.includes("api_contract"), "architect produces the cross-team contract");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("cto-cmd: buildCtoPrompt carries the lead exit-1 failover protocol", () => {
  const root = mkdtempSync(join(tmpdir(), "cto-core-failover-"));
  try {
    const prompt = buildCtoPrompt(parseCtoEnvelope("Add OAuth", root), root);
    assert.ok(prompt.includes("Subagent dispatch reliability"), "reliability section present");
    assert.ok(prompt.includes("SAME slice spec"), "re-spawn with the same spec");
    assert.ok(prompt.includes("Second failure -> degrade"), "degradation path documented");
    assert.ok(prompt.includes("skip the lead hop"), "single-worker slices dispatch directly");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("cto-cmd: buildCtoPrompt degrades without teams.json", () => {
  const root = mkdtempSync(join(tmpdir(), "cto-core-"));
  try {
    const prompt = buildCtoPrompt(parseCtoEnvelope("Add OAuth", root), root);
    assert.ok(prompt.includes("(no teams configured)"));
    assert.ok(prompt.includes("Create `.omp/teams.json`"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("cto-cmd: ctoCommand with empty args starts STANDBY and notifies on task", () => {
  const root = mkdtempSync(join(tmpdir(), "cto-core-"));
  try {
    const notifyCalls: string[] = [];
    const standby = ctoCommand({ args: "", cwd: root, ui: { notify: (m) => notifyCalls.push(m) } });
    assert.ok(standby.includes("/cto STANDBY"), "empty args start standby mode");
    assert.ok(standby.includes("awaiting inbox tasks"), "standby names the inbox contract");
    assert.ok(standby.includes("[CTO-INBOX]"), "standby documents the wake envelope");
    assert.ok(standby.includes("Adopt or persist the standby run"), "standby reuses queued tasks instead of creating a second run");
    assert.ok(standby.includes("ARE USER COMMANDS"), "inbox messages are user commands to the main-session CTO");
    assert.ok(standby.includes("return to standby"), "standby returns to standby after each wave");
    assert.ok(standby.includes("task(agent=@cto)"), "nested CTO dispatch forbidden in standby");
    assert.ok(notifyCalls.some((m) => m.includes("standby")), "notify announces standby");

    const prompt = ctoCommand({ args: "Add OAuth", cwd: root, ui: { notify: (m) => notifyCalls.push(m) } });
    assert.ok(prompt.includes("Add OAuth"));
    assert.ok(notifyCalls.some((m) => m.includes("cto: Add OAuth")));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("cto-cmd: renderChannelSection reflects .omp/escalation.json", () => {
  const root = mkdtempSync(join(tmpdir(), "cto-core-chan-"));
  try {
    // no channel
    assert.ok(renderChannelSection(root).includes("No escalation channel"));
    assert.ok(renderChannelSection(root).includes("Use the `ask` tool"));

    // telegram -> bidirectional, ask banned
    mkdirSync(join(root, ".omp"), { recursive: true });
    writeFileSync(join(root, ".omp", "escalation.json"), JSON.stringify({ adapter: "telegram", telegram: { token: "t", chatId: "c" } }));
    const tg = renderChannelSection(root);
    assert.ok(tg.includes("BIDIRECTIONAL"), "telegram is bidirectional");
    assert.ok(tg.includes("NEVER use the `ask` tool"), "ask banned in messenger mode");
    assert.ok(tg.includes("outbox"), "questions route via the outbox");
    assert.ok(tg.includes("USER COMMAND"), "inbox tasks are user commands in messenger mode");

    // http -> push-only, ask allowed
    writeFileSync(join(root, ".omp", "escalation.json"), JSON.stringify({ adapter: "http", http: { url: "https://x" } }));
    const http = renderChannelSection(root);
    assert.ok(http.includes("push-only"), "http is push-only");
    assert.ok(http.includes("Use `ask`"), "http keeps ask");

    // consumer bidirectional transport (flag) -> messenger mode like telegram
    writeFileSync(join(root, ".omp", "escalation.json"), JSON.stringify({ adapter: "slack", bidirectional: true }));
    const slack = renderChannelSection(root);
    assert.ok(slack.includes("BIDIRECTIONAL"), "bidirectional flag enables messenger mode");
    assert.ok(slack.includes("NEVER use the `ask` tool"), "ask banned for any bidirectional transport");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("cto-cmd: buildCtoPrompt embeds the channel section", () => {
  const root = mkdtempSync(join(tmpdir(), "cto-core-chan2-"));
  try {
    mkdirSync(join(root, ".omp"), { recursive: true });
    writeFileSync(join(root, ".omp", "escalation.json"), JSON.stringify({ adapter: "telegram", telegram: { token: "t", chatId: "c" } }));
    const prompt = buildCtoPrompt(parseCtoEnvelope("Add OAuth", root), root);
    assert.ok(prompt.includes("### User channel (messenger, BIDIRECTIONAL)"), "prompt carries the channel section");
    assert.ok(prompt.includes("NEVER use the `ask` tool"), "prompt bans ask in messenger mode");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
