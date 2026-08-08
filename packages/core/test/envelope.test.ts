/**
 * Envelope parser tests: the leading-directive parser returns a MECHANICAL
 * `autonomyHint` (never authoritative) and preserves task text verbatim.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { AUTONOMOUS_DIRECTIVES, AUTONOMOUS_TOKEN, parseAutonomousDirective } from "@andvl1/omp-workflows-core";

test("envelope: exact [AUTONOMOUS] token enables the hint and strips it", () => {
  const parsed = parseAutonomousDirective("[AUTONOMOUS] Fix the 500 error");
  assert.equal(parsed.autonomyHint, true);
  assert.equal(parsed.task, "Fix the 500 error");
});

test("envelope: bare [AUTONOMOUS] token enables the hint with empty task", () => {
  const parsed = parseAutonomousDirective("[AUTONOMOUS]");
  assert.equal(parsed.autonomyHint, true);
  assert.equal(parsed.task, "");
});

test("envelope: leading whitespace before the token is tolerated", () => {
  const parsed = parseAutonomousDirective("  [AUTONOMOUS] Fix bug");
  assert.equal(parsed.autonomyHint, true);
  assert.equal(parsed.task, "Fix bug");
});

test("envelope: [AUTONOMOUSLY] lookalike stays literal task text", () => {
  const parsed = parseAutonomousDirective("[AUTONOMOUSLY] Fix bug");
  assert.equal(parsed.autonomyHint, false, "lookalike must not enable the hint");
  assert.equal(parsed.task, "[AUTONOMOUSLY] Fix bug", "lookalike must not be corrupted or stripped");
});

test("envelope: truncated [AUTONOMOUS stays literal", () => {
  const parsed = parseAutonomousDirective("[AUTONOMOUS without closing bracket");
  assert.equal(parsed.autonomyHint, false);
  assert.equal(parsed.task, "[AUTONOMOUS without closing bracket");
});

test("envelope: token glued to the task is ambiguous and stays literal", () => {
  const parsed = parseAutonomousDirective("[AUTONOMOUS]Fix bug");
  assert.equal(parsed.autonomyHint, false, "no separator after the token is ambiguous");
  assert.equal(parsed.task, "[AUTONOMOUS]Fix bug", "ambiguous input must not be stripped");
});

test("envelope: token mid-text is not a directive", () => {
  const parsed = parseAutonomousDirective("Fix [AUTONOMOUS] bug");
  assert.equal(parsed.autonomyHint, false);
  assert.equal(parsed.task, "Fix [AUTONOMOUS] bug");
});

test("envelope: approved natural directive enables the hint with colon separator", () => {
  const parsed = parseAutonomousDirective("действуй автономно: исправь баг");
  assert.equal(parsed.autonomyHint, true);
  assert.equal(parsed.task, "исправь баг");
});

test("envelope: approved natural directive with comma or whitespace separator", () => {
  assert.equal(parseAutonomousDirective("действуй автономно, исправь баг").autonomyHint, true);
  assert.equal(parseAutonomousDirective("действуй автономно исправь баг").task, "исправь баг");
});

test("envelope: approved natural directive is case-insensitive", () => {
  const parsed = parseAutonomousDirective("Действуй Автономно Fix bug");
  assert.equal(parsed.autonomyHint, true);
  assert.equal(parsed.task, "Fix bug");
});

test("envelope: bare approved natural directive enables the hint", () => {
  const parsed = parseAutonomousDirective("действуй автономно");
  assert.equal(parsed.autonomyHint, true);
  assert.equal(parsed.task, "");
});

test("envelope: unapproved phrasing stays literal task text", () => {
  const parsed = parseAutonomousDirective("продолжай автономно работать");
  assert.equal(parsed.autonomyHint, false, "non-approved phrasing must not enable the hint");
  assert.equal(parsed.task, "продолжай автономно работать");
});

test("envelope: directive list is bounded and documented", () => {
  // The set must stay explicit — adding entries is a UX decision with tests.
  assert.deepEqual([...AUTONOMOUS_DIRECTIVES], ["действуй автономно"]);
  assert.equal(AUTONOMOUS_TOKEN, "[AUTONOMOUS]");
});

test("envelope: no directive leaves plain task text verbatim", () => {
  const parsed = parseAutonomousDirective("Add OAuth to the API");
  assert.equal(parsed.autonomyHint, false);
  assert.equal(parsed.task, "Add OAuth to the API");
});

test("envelope: natural-language autonomy WITHOUT a recognized directive is NOT a hint", () => {
  // "do this without waiting for approval" is semantically autonomous but is
  // NOT in the bounded directive list — the parser must not flag it. The
  // MODEL classifies it at PHASE-0; the parser stays mechanical.
  const parsed = parseAutonomousDirective("Do this without waiting for approval — fix the login bug");
  assert.equal(parsed.autonomyHint, false, "parser hint stays false for unrecognized phrasing");
  assert.equal(parsed.task, "Do this without waiting for approval — fix the login bug");
});
