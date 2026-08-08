/**
 * Shared autonomy-directive parser tests (RC1): exact `[AUTONOMOUS]` token,
 * approved natural-language directives, lookalike prefixes stay literal,
 * ambiguous text remains task text.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { AUTONOMOUS_DIRECTIVES, AUTONOMOUS_TOKEN, parseAutonomousDirective } from "@andvl1/omp-workflows-core";

test("envelope: exact [AUTONOMOUS] token enables autonomy and strips it", () => {
  const parsed = parseAutonomousDirective("[AUTONOMOUS] Fix the 500 error");
  assert.equal(parsed.autonomous, true);
  assert.equal(parsed.task, "Fix the 500 error");
});

test("envelope: bare [AUTONOMOUS] token enables autonomy with empty task", () => {
  const parsed = parseAutonomousDirective("[AUTONOMOUS]");
  assert.equal(parsed.autonomous, true);
  assert.equal(parsed.task, "");
});

test("envelope: leading whitespace before the token is tolerated", () => {
  const parsed = parseAutonomousDirective("  [AUTONOMOUS] Fix bug");
  assert.equal(parsed.autonomous, true);
  assert.equal(parsed.task, "Fix bug");
});

test("envelope: [AUTONOMOUSLY] lookalike stays literal task text", () => {
  const parsed = parseAutonomousDirective("[AUTONOMOUSLY] Fix bug");
  assert.equal(parsed.autonomous, false, "lookalike must not enable autonomy");
  assert.equal(parsed.task, "[AUTONOMOUSLY] Fix bug", "lookalike must not be corrupted or stripped");
});

test("envelope: truncated [AUTONOMOUS stays literal", () => {
  const parsed = parseAutonomousDirective("[AUTONOMOUS without closing bracket");
  assert.equal(parsed.autonomous, false);
  assert.equal(parsed.task, "[AUTONOMOUS without closing bracket");
});

test("envelope: token glued to the task is ambiguous and stays literal", () => {
  const parsed = parseAutonomousDirective("[AUTONOMOUS]Fix bug");
  assert.equal(parsed.autonomous, false, "no separator after the token is ambiguous");
  assert.equal(parsed.task, "[AUTONOMOUS]Fix bug", "ambiguous input must not be stripped");
});

test("envelope: token mid-text is not a directive", () => {
  const parsed = parseAutonomousDirective("Fix [AUTONOMOUS] bug");
  assert.equal(parsed.autonomous, false);
  assert.equal(parsed.task, "Fix [AUTONOMOUS] bug");
});

test("envelope: approved natural directive enables autonomy with colon separator", () => {
  const parsed = parseAutonomousDirective("действуй автономно: исправь баг");
  assert.equal(parsed.autonomous, true);
  assert.equal(parsed.task, "исправь баг");
});

test("envelope: approved natural directive with comma or whitespace separator", () => {
  assert.equal(parseAutonomousDirective("действуй автономно, исправь баг").autonomous, true);
  assert.equal(parseAutonomousDirective("действуй автономно исправь баг").task, "исправь баг");
});

test("envelope: approved natural directive is case-insensitive", () => {
  const parsed = parseAutonomousDirective("Действуй Автономно Fix bug");
  assert.equal(parsed.autonomous, true);
  assert.equal(parsed.task, "Fix bug");
});

test("envelope: bare approved natural directive enables autonomy", () => {
  const parsed = parseAutonomousDirective("действуй автономно");
  assert.equal(parsed.autonomous, true);
  assert.equal(parsed.task, "");
});

test("envelope: unapproved phrasing stays literal task text", () => {
  const parsed = parseAutonomousDirective("продолжай автономно работать");
  assert.equal(parsed.autonomous, false, "non-approved phrasing must not enable autonomy");
  assert.equal(parsed.task, "продолжай автономно работать");
});

test("envelope: directive list is bounded and documented", () => {
  // The set must stay explicit — adding entries is a UX decision with tests.
  assert.deepEqual([...AUTONOMOUS_DIRECTIVES], ["действуй автономно"]);
  assert.equal(AUTONOMOUS_TOKEN, "[AUTONOMOUS]");
});

test("envelope: no directive leaves plain task text verbatim", () => {
  const parsed = parseAutonomousDirective("Add OAuth to the API");
  assert.equal(parsed.autonomous, false);
  assert.equal(parsed.task, "Add OAuth to the API");
});
