/**
 * CTO sub-orchestration: type/model + escalation contract tests.
 * Covers: caps, escalation shape validation, answer file round-trip.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  MAX_TEAMS,
  MAX_DECOMPOSITION_DEPTH,
  validateEscalation,
  answersDir,
  readAnswers,
  ensureAnswersDir,
  type Escalation,
  type EscalationAnswer,
  type TeamPlan,
  type TeamPlanEntry,
} from "@andvl1/omp-workflows-core";

function sampleEscalation(overrides: Partial<Escalation> = {}): Escalation {
  return {
    id: "run/team/checkpoint/1",
    level: "question",
    title: "API shape",
    body: "REST or gRPC for the new service?",
    options: [
      { id: "rest", label: "REST", apply: "now" },
      { id: "grpc", label: "gRPC", apply: "on_next_checkpoint" },
    ],
    default: "rest",
    timeoutMs: 3_600_000,
    ...overrides,
  };
}

function samplePlanEntry(overrides: Partial<TeamPlanEntry> = {}): TeamPlanEntry {
  return {
    team: "kotlin-backend",
    scope: ["backend-kotlin"],
    slice: "Implement auth service",
    profile: "lightweight",
    worktree: "separate_worktree",
    depends_on: [],
    ...overrides,
  };
}

test("cto: caps are exported and sane", () => {
  assert.equal(MAX_TEAMS, 8);
  assert.equal(MAX_DECOMPOSITION_DEPTH, 2);
});

test("cto: TeamPlan shape holds a decomposition", () => {
  const plan: TeamPlan = {
    id: "auth-2026-08-04",
    task: "Add OAuth to the API",
    created_at: "2026-08-04T10:00:00.000Z",
    teams: [
      samplePlanEntry({ team: "kotlin-backend", worktree: "same_branch" }),
      samplePlanEntry({ team: "frontend", depends_on: ["kotlin-backend"] }),
    ],
  };
  assert.equal(plan.teams.length, 2);
  assert.deepEqual(plan.teams[1]?.depends_on, ["kotlin-backend"]);
});

test("cto: validateEscalation accepts a valid escalation", () => {
  assert.equal(validateEscalation(sampleEscalation()), null);
});

test("cto: validateEscalation rejects missing required fields", () => {
  for (const key of ["id", "level", "title", "body"] as const) {
    const esc = sampleEscalation({ [key]: "" });
    assert.match(validateEscalation(esc) ?? "", new RegExp(`escalation\\.${key}`));
  }
});

test("cto: validateEscalation rejects unknown level and negative timeout", () => {
  assert.match(validateEscalation(sampleEscalation({ level: "urgent" })) ?? "", /escalation\.level/);
  assert.match(validateEscalation(sampleEscalation({ timeoutMs: -1 })) ?? "", /timeoutMs/);
});

test("cto: validateEscalation rejects bad option payloads", () => {
  const badOption = sampleEscalation({
    options: [{ id: "x", label: "X", apply: "sometime" }],
  }) as unknown as Escalation;
  assert.match(validateEscalation(badOption) ?? "", /apply/);
});

test("cto: readAnswers round-trips answer files, skips garbage", () => {
  const root = mkdtempSync(join(tmpdir(), "cto-answers-"));
  try {
    const dir = ensureAnswersDir("run-1", root);
    assert.equal(answersDir("run-1", root), dir);

    const answer: EscalationAnswer = {
      id: "run/team/checkpoint/1",
      answer: "rest",
      at: "2026-08-04T10:05:00.000Z",
      by: "telegram",
    };
    writeFileSync(join(dir, "run-team-checkpoint-1.json"), JSON.stringify(answer));
    writeFileSync(join(dir, "garbage.json"), "{not json");

    const answers = readAnswers("run-1", root);
    assert.equal(answers.length, 1);
    assert.equal(answers[0]?.answer, "rest");
    assert.equal(answers[0]?.by, "telegram");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("cto: readAnswers on missing dir returns [] without throwing", () => {
  const root = mkdtempSync(join(tmpdir(), "cto-answers-missing-"));
  try {
    assert.deepEqual(readAnswers("nope", root), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
