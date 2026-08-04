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
  parseCtoEnvelope,
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

test("cto-cmd: ctoCommand returns usage on empty args and notifies on task", () => {
  const root = mkdtempSync(join(tmpdir(), "cto-core-"));
  try {
    const notifyCalls: string[] = [];
    const usage = ctoCommand({ args: "", cwd: root, ui: { notify: (m) => notifyCalls.push(m) } });
    assert.ok(usage.includes("Usage: /cto"));

    const prompt = ctoCommand({ args: "Add OAuth", cwd: root, ui: { notify: (m) => notifyCalls.push(m) } });
    assert.ok(prompt.includes("Add OAuth"));
    assert.equal(notifyCalls.length, 1);
    assert.ok(notifyCalls[0]?.includes("cto: Add OAuth"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
