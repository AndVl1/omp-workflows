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
  buildAmendPrompt,
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

test("cto-cmd: natural-language directive sets the hint and stays out of the task", () => {
  const root = mkdtempSync(join(tmpdir(), "cto-core-ru-"));
  try {
    const envelope = parseCtoEnvelope("действуй автономно: Add OAuth", root);
    assert.equal(envelope.autonomyHint, true);
    assert.equal(envelope.task, "Add OAuth");

    const prompt = buildCtoPrompt(envelope, root);
    assert.ok(prompt.includes("Autonomy hint (leading directive — MECHANICAL, NOT authoritative; routing/migration metadata only): ON"), "natural directive renders hint ON");
    assert.ok(prompt.includes("autonomous: <true|false>"), "persistence contract carries the MODEL decision, not the parser flag");
    assert.ok(!prompt.includes("`autonomous: true`"), "parser boolean is NOT copied into the persistence contract");

    const lookalike = parseCtoEnvelope("[AUTONOMOUSLY] Add OAuth", root);
    assert.equal(lookalike.autonomyHint, false, "lookalike does not set the hint");
    assert.equal(lookalike.task, "[AUTONOMOUSLY] Add OAuth", "lookalike stays literal");
    assert.ok(buildCtoPrompt(lookalike, root).includes("Autonomy hint (leading directive — MECHANICAL, NOT authoritative; routing/migration metadata only): OFF"), "lookalike renders hint OFF");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("cto-cmd: parseCtoEnvelope handles prefixes and issue", () => {
  const root = mkdtempSync(join(tmpdir(), "cto-core-"));
  try {
    const plain = parseCtoEnvelope("Add OAuth issue=#3", root);
    assert.equal(plain.task, "Add OAuth");
    assert.equal(plain.issue, 3);
    assert.equal(plain.autonomyHint, false);

    const auto = parseCtoEnvelope("[AUTONOMOUS] Fix bug issue=#9", root);
    assert.equal(auto.autonomyHint, true);
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
    assert.ok(prompt.includes("Wave / slice gate contract"), "wave/slice gate contract section present");
    assert.ok(
      prompt.includes("<!-- omp-cto-slice run=<runId> slice=<sliceId> -->"),
      "exact slice marker literal in the fresh prompt",
    );
    assert.ok(prompt.includes('wave_history` record `{ id, source, source_id, task, slice_ids'), "wave creation wording");
    assert.ok(prompt.includes("active_wave_id"), "active_wave_id required before lead spawn");
    assert.ok(prompt.includes("teams[].classification"), "per-slice classification required");
    assert.ok(prompt.includes("resolveWorkflow(type,"), "matrix-resolved workflow required");
    assert.ok(prompt.includes("dod.json"), "per-slice DoD artifact required");
    assert.ok(prompt.includes("Leads propagate"), "leads must propagate the marker to workers");
    assert.ok(!prompt.includes("runCto"), "no TS engine call remains in the prompt");
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

test("cto-cmd: buildCtoPrompt includes the COMPLETE workflow matrix (REVIEW/HOTFIX + P5 rule)", () => {
  const root = mkdtempSync(join(tmpdir(), "cto-core-matrix-"));
  try {
    const prompt = buildCtoPrompt(parseCtoEnvelope("Add OAuth", root), root);
    assert.ok(prompt.includes("### Workflow routing"), "workflow routing matrix section present");
    assert.ok(prompt.includes("| REVIEW | review | review | review | review |"), "REVIEW row rendered");
    assert.ok(prompt.includes("| HOTFIX | emergency | emergency | emergency | emergency |"), "HOTFIX row rendered");
    assert.ok(prompt.includes("classification.autonomous during migration only"), "P5 re-derives routing from classification.autonomous only during migration");
    assert.ok(prompt.includes("Never re-derive"), "autonomy is never re-derived from task text or markers");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("cto-cmd: buildAmendPrompt includes the complete workflow matrix too", () => {
  const root = mkdtempSync(join(tmpdir(), "cto-core-matrix-amend-"));
  try {
    const prompt = buildAmendPrompt(
      parseCtoEnvelope("Task B", root),
      root,
      { runId: "run-1", state: { plan: { created_at: "2026-08-04T10:00:00.000Z" }, teams: [{ id: "backend", status: "in_progress" }], pause: { kind: "none", reason: "" }, updated_at: "2026-08-04T10:05:00.000Z" } },
    );
    assert.ok(prompt.includes("| REVIEW | review | review | review | review |"), "REVIEW row in amend");
    assert.ok(prompt.includes("| HOTFIX | emergency | emergency | emergency | emergency |"), "HOTFIX row in amend");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("cto-cmd: persistence contract instructs the STRUCTURED classification; classification.autonomous is the authority", () => {
  const root = mkdtempSync(join(tmpdir(), "cto-core-persist-"));
  try {
    const prompt = buildCtoPrompt(parseCtoEnvelope("Add OAuth", root), root);
    assert.ok(prompt.includes('classification: { "type":'), "prompt instructs the structured classification line");
    assert.ok(prompt.includes("classification.autonomous"), "classification.autonomous named as the authority");
    assert.ok(prompt.includes("read-compat only"), "top-level line documented as legacy read-compat");
    assert.ok(!prompt.includes("`autonomous: true`"), "parser boolean is never copied as the decision");
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
    assert.ok(standby.includes("run id NEVER changes"), "standby keeps the SAME run id across follow-up waves");
    assert.ok(standby.includes("wave_history"), "each inbox task appends a NEW wave record to the same state.json");
    assert.ok(standby.includes("PER-SLICE"), "each inbox task is classified per-slice before dispatch");
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
    assert.ok(renderChannelSection(root).includes("TERMINAL-ONLY"), "none mode named TERMINAL-ONLY");

    // telegram -> bidirectional, ask banned
    mkdirSync(join(root, ".omp"), { recursive: true });
    writeFileSync(join(root, ".omp", "escalation.json"), JSON.stringify({ adapter: "telegram", telegram: { token: "t", chatId: "c" } }));
    const tg = renderChannelSection(root);
    assert.ok(tg.includes("BIDIRECTIONAL"), "telegram is bidirectional");
    assert.ok(tg.includes("VALIDATED RW-PRIMARY"), "rw mode named VALIDATED RW-PRIMARY");
    assert.ok(tg.includes("NEVER use the `ask` tool"), "ask banned in messenger mode");
    assert.ok(tg.includes("outbox"), "questions route via the outbox");
    assert.ok(tg.includes("USER COMMAND"), "inbox tasks are user commands in messenger mode");

    // http -> push-only, ask allowed
    writeFileSync(join(root, ".omp", "escalation.json"), JSON.stringify({ adapter: "http", http: { url: "https://x" } }));
    const http = renderChannelSection(root);
    assert.ok(http.includes("push-only"), "http is push-only");
    assert.ok(http.includes("RO-REPORT"), "ro mode named RO-REPORT");
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
