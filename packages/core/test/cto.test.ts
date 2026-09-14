/**
 * CTO sub-orchestration: type/model + escalation contract tests.
 * Covers: caps, escalation shape validation, answer file round-trip.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  MAX_TEAMS,
  MAX_DECOMPOSITION_DEPTH,
  validateEscalation,
  type Escalation,
  type EscalationAnswer,
  type TeamPlan,
  type TeamPlanEntry,
} from "@andvl1/omp-workflows-core";
import {
  answersDir as answersDirInternal,
  ensureAnswersDir as ensureAnswersDirInternal,
  readAnswers as readAnswersInternal,
  readAnswerById as readAnswerByIdInternal,
} from "../src/cto/escalation.js";
import * as coreSource from "../src/index.js";
import { canonicalDurableIdFileName, legacyDurableIdFileName } from "../src/cto/durable-id.js";
import { PinnedProjectRoot } from "../src/specification/pinned-root.js";

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

test("cto: answer storage readers and directory writer stay off the public root", () => {
  for (const name of ["answersDir", "readAnswers", "readAnswerById", "ensureAnswersDir"]) {
    assert.equal(Object.hasOwn(coreSource, name), false, `${name} must not be publicly importable`);
  }
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

test("cto: validateEscalation rejects prototype levels and non-finite timeout values", () => {
  for (const level of ["constructor", "toString", "__proto__"]) {
    const result = validateEscalation(sampleEscalation({ level: level as Escalation["level"] }));
    assert.match(result ?? "", /escalation\.level/);
  }
  for (const timeoutMs of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
    const result = validateEscalation(sampleEscalation({ timeoutMs }));
    assert.match(result ?? "", /timeoutMs/);
  }
});

test("cto: validateEscalation requires plain own-field option records", () => {
  const inheritedEscalation = Object.create({ id: "run/team/check/1" }) as Record<string, unknown>;
  inheritedEscalation.level = "question";
  inheritedEscalation.title = "title";
  inheritedEscalation.body = "body";
  assert.match(validateEscalation(inheritedEscalation as unknown as Escalation) ?? "", /plain object/);

  const inheritedOption = Object.create({ id: "rest", label: "REST", apply: "now" });
  assert.match(
    validateEscalation(sampleEscalation({ options: [inheritedOption] } as unknown as Partial<Escalation>)),
    /plain objects/,
  );
});

test("cto: readAnswers round-trips answer files, skips garbage", () => {
  const root = mkdtempSync(join(tmpdir(), "cto-answers-"));
  try {
    const dir = ensureAnswersDirInternal("run-1", root);
    assert.equal(answersDirInternal("run-1", root), dir);

    const answer: EscalationAnswer = {
      id: "run/team/checkpoint/1",
      run_id: "run-1",
      answer: "rest",
      at: "2026-08-04T10:05:00.000Z",
      by: "telegram",
    };
    writeFileSync(join(dir, "run-team-checkpoint-1.json"), JSON.stringify(answer));
    writeFileSync(join(dir, "garbage.json"), "{not json");

    const page = readAnswersInternal("run-1", root);
    assert.equal(page.answers.length, 1);
    assert.equal(page.answers[0]?.answer, "rest");
    assert.equal(page.answers[0]?.by, "telegram");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
test("cto: answer readers reject invalid UTF-8 before JSON semantics", () => {
  const root = mkdtempSync(join(tmpdir(), "cto-answers-utf8-"));
  try {
    const dir = ensureAnswersDirInternal("run-1", root);
    const answerId = "run/team/checkpoint/invalid-utf8";
    const path = join(dir, canonicalDurableIdFileName(answerId));
    const invalid = Buffer.concat([
      Buffer.from(`{"id":${JSON.stringify(answerId)},"run_id":"run-1","answer":"`, "utf8"),
      Buffer.from([0xff]),
      Buffer.from(`","at":"2026-08-04T10:05:00.000Z","by":"test"}`, "utf8"),
    ]);
    writeFileSync(path, invalid);

    assert.deepEqual(readAnswersInternal("run-1", root).answers, []);
    assert.equal(readAnswerByIdInternal("run-1", root, answerId), null);
    assert.deepEqual(readFileSync(path), invalid, "invalid answer bytes remain untouched");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
test("cto: readAnswers binds canonical names and rejects mismatched or ambiguous legacy entries", () => {
  const root = mkdtempSync(join(tmpdir(), "cto-answers-integrity-"));
  try {
    const dir = ensureAnswersDirInternal("run-1", root);
    const answer = (id: string, text: string, run_id = "run-1"): EscalationAnswer => ({
      id,
      run_id,
      answer: text,
      at: "2026-08-04T10:05:00.000Z",
      by: "telegram",
    });
    const simple = answer("simple", "canonical");
    const distinctCanonical = answer("a/b", "distinct");
    const validLegacy = answer("run/team/checkpoint/1", "legacy");
    writeFileSync(join(dir, canonicalDurableIdFileName(simple.id)), JSON.stringify(simple));
    writeFileSync(join(dir, canonicalDurableIdFileName(distinctCanonical.id)), JSON.stringify(distinctCanonical));
    writeFileSync(join(dir, legacyDurableIdFileName(validLegacy.id)), JSON.stringify(validLegacy));
    writeFileSync(join(dir, "mismatched.json"), JSON.stringify(answer("different/id", "tampered")));
    // Both IDs below map to a-b.json under the lossy legacy convention. The
    // valid canonical answer remains visible; the ambiguous legacy alias does
    // not get to choose which distinct ID it represents.
    writeFileSync(join(dir, canonicalDurableIdFileName("a/b")), JSON.stringify(distinctCanonical));
    writeFileSync(join(dir, legacyDurableIdFileName("a b")), JSON.stringify(answer("a b", "ambiguous")));
    writeFileSync(join(dir, canonicalDurableIdFileName("cross-run")), JSON.stringify(answer("cross-run", "foreign", "run-2")));

    const page = readAnswersInternal("run-1", root);
    const answers = page.answers;
    assert.deepEqual(new Set(answers.map((entry) => entry.id)), new Set(["simple", "a/b", "run/team/checkpoint/1"]));
    assert.equal(answers.some((entry) => entry.answer === "tampered"), false);
    assert.equal(answers.some((entry) => entry.answer === "ambiguous"), false);
    assert.equal(answers.some((entry) => entry.answer === "foreign"), false);
    assert.equal(readAnswerByIdInternal("run-1", root, "cross-run"), null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("cto: readAnswers on missing dir returns [] without throwing", () => {
  const root = mkdtempSync(join(tmpdir(), "cto-answers-missing-"));
  try {
    assert.deepEqual(readAnswersInternal("nope", root), { answers: [], next_cursor: null, done: true });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

function answer(id: string, value = id, run_id = "run-1"): EscalationAnswer {
  return { id, run_id, answer: value, at: "2026-08-04T10:05:00.000Z", by: "test" };
}
test("cto: answer paths reject unsafe run IDs before touching state and accept uppercase IDs", () => {
  const root = mkdtempSync(join(tmpdir(), "cto-answers-run-id-"));
  try {
    for (const runId of ["foo/bar", "../escape", "foo∕bar", "foo\u2028bar"]) {
      assert.deepEqual(readAnswersInternal(runId, root), { answers: [], next_cursor: null, done: true });
      assert.throws(() => answersDirInternal(runId, root), /unsafe CTO run id/);
      assert.throws(() => ensureAnswersDirInternal(runId, root), /unsafe CTO run id/);
    }
    assert.equal(existsSync(join(root, ".work-state")), false, "unsafe answer selectors must not create state paths");

    const dir = ensureAnswersDirInternal("CTO-1", root);
    const valid = answer("uppercase-answer", "uppercase-answer", "CTO-1");
    writeFileSync(join(dir, canonicalDurableIdFileName(valid.id)), JSON.stringify(valid));
    assert.deepEqual(readAnswersInternal("CTO-1", root).answers.map((entry) => entry.id), ["uppercase-answer"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("cto: readAnswers rejects an answers-directory symlink without touching outside", () => {
  const root = mkdtempSync(join(tmpdir(), "cto-answers-dir-link-"));
  const outside = mkdtempSync(join(tmpdir(), "cto-answers-dir-outside-"));
  try {
    mkdirSync(join(root, ".work-state", "cto", "run-1"), { recursive: true });
    symlinkSync(outside, join(root, ".work-state", "cto", "run-1", "answers"), "dir");
    assert.deepEqual(readAnswersInternal("run-1", root), { answers: [], next_cursor: null, done: true });
    assert.deepEqual(readdirSync(outside), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test("cto: readAnswers skips symlink leaves and retains safe answers", () => {
  const root = mkdtempSync(join(tmpdir(), "cto-answers-leaf-link-"));
  const outside = join(root, "outside.json");
  try {
    const dir = join(root, ".work-state", "cto", "run-1", "answers");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "good.json"), JSON.stringify(answer("good")));
    writeFileSync(outside, "outside");
    symlinkSync(outside, join(dir, "bad.json"));
    const page = readAnswersInternal("run-1", root);
    assert.deepEqual(page.answers.map((entry) => entry.id), ["good"]);
    assert.equal(readAnswersInternal("run-1", root).answers.length, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("cto: readAnswers rejects FIFO without blocking", () => {
  const root = mkdtempSync(join(tmpdir(), "cto-answers-fifo-"));
  try {
    const dir = join(root, ".work-state", "cto", "run-1", "answers");
    mkdirSync(dir, { recursive: true });
    execFileSync("mkfifo", [join(dir, "blocked.json")]);
    const started = Date.now();
    assert.deepEqual(readAnswersInternal("run-1", root), { answers: [], next_cursor: null, done: true });
    assert.ok(Date.now() - started < 1000, "FIFO intake must be bounded and non-blocking");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("cto: readAnswers skips oversized files and caps flood entries", () => {
  const root = mkdtempSync(join(tmpdir(), "cto-answers-bounds-"));
  try {
    const dir = join(root, ".work-state", "cto", "run-1", "answers");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "000-oversized.json"), JSON.stringify({ ...answer("oversized"), answer: "x".repeat(1024 * 1024 + 1) }));
    for (let index = 1; index <= 300; index += 1) {
      const name = String(index).padStart(3, "0") + ".json";
      writeFileSync(join(dir, name), JSON.stringify(answer("answer-" + index)));
    }
    const page = readAnswersInternal("run-1", root);
    assert.ok(page.answers.length <= 256);
    assert.equal(page.answers.some((entry) => entry.id === "oversized"), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("cto: readAnswers fails closed after a pinned root replacement", () => {
  const root = mkdtempSync(join(tmpdir(), "cto-answers-root-swap-"));
  const moved = root + ".opened";
  const replacement = mkdtempSync(join(tmpdir(), "cto-answers-replacement-"));
  let swapped = false;
  const pin = PinnedProjectRoot.open(root);
  assert.ok(pin);
  try {
    const dir = join(root, ".work-state", "cto", "run-1", "answers");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "answer.json"), JSON.stringify(answer("answer")));
    renameSync(root, moved);
    symlinkSync(replacement, root, "dir");
    swapped = true;
    assert.deepEqual(readAnswersInternal("run-1", root, { pinnedRoot: pin }), { answers: [], next_cursor: null, done: true });
    assert.deepEqual(readdirSync(replacement), []);
  } finally {
    pin.close();
    if (swapped) { unlinkSync(root); renameSync(moved, root); }
    rmSync(root, { recursive: true, force: true });
    rmSync(moved, { recursive: true, force: true });
    rmSync(replacement, { recursive: true, force: true });
  }
});

test("cto: readAnswers paginates past older and hostile entries with a restart-safe cursor", () => {
  const root = mkdtempSync(join(tmpdir(), "cto-answers-pagination-"));
  try {
    const dir = ensureAnswersDirInternal("run-1", root);
    writeFileSync(join(dir, "000-malformed.json"), "{bad");
    writeFileSync(join(dir, "001-foreign.json"), JSON.stringify(answer("foreign-id")));
    const oversized = answer("oversized", "x".repeat(4096));
    writeFileSync(join(dir, canonicalDurableIdFileName(oversized.id)), JSON.stringify(oversized));
    for (let index = 0; index < 300; index += 1) {
      const id = `older-${String(index).padStart(3, "0")}`;
      writeFileSync(join(dir, canonicalDurableIdFileName(id)), JSON.stringify(answer(id)));
    }
    const current = answer("zz-current", "current");
    writeFileSync(join(dir, canonicalDurableIdFileName(current.id)), JSON.stringify(current));

    const first = readAnswersInternal("run-1", root, { limit: 64, maxBytes: 2048 });
    assert.equal(first.answers.length, 62);
    assert.equal(first.done, false);
    assert.ok(first.next_cursor);
    const restarted = readAnswersInternal("run-1", root, { cursor: first.next_cursor, limit: 64, maxBytes: 2048 });
    assert.equal(restarted.answers.some((entry) => entry.id === "older-063"), true);

    const seen = new Set([...first.answers, ...restarted.answers].map((entry) => entry.id));
    let page = restarted;
    while (!page.done) {
      page = readAnswersInternal("run-1", root, { cursor: page.next_cursor, limit: 64, maxBytes: 2048 });
      for (const entry of page.answers) seen.add(entry.id);
    }
    assert.equal(seen.has(current.id), true, "the lexical-end current answer is eventually discoverable");
    assert.equal(seen.has("foreign-id"), false);
    assert.equal(seen.has("oversized"), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("cto: readAnswers advances over consecutive malformed and oversized pages", () => {
  const root = mkdtempSync(join(tmpdir(), "cto-answers-page-progress-"));
  try {
    const dir = ensureAnswersDirInternal("run-1", root);
    writeFileSync(join(dir, "000-malformed.json"), "{bad");
    const oversized = answer("oversized", "x".repeat(4096));
    writeFileSync(join(dir, canonicalDurableIdFileName(oversized.id)), JSON.stringify(oversized));
    const valid = answer("valid", "found");
    writeFileSync(join(dir, canonicalDurableIdFileName(valid.id)), JSON.stringify(valid));
    let page = readAnswersInternal("run-1", root, { limit: 1, maxBytes: 1024 });
    const seen = new Set(page.answers.map((entry) => entry.id));
    while (!page.done) {
      page = readAnswersInternal("run-1", root, { cursor: page.next_cursor, limit: 1, maxBytes: 1024 });
      for (const entry of page.answers) seen.add(entry.id);
    }
    assert.deepEqual([...seen], ["valid"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("cto: readAnswers retries aggregate-cap suffixes without skipping valid answers", () => {
  const root = mkdtempSync(join(tmpdir(), "cto-answers-near-cap-"));
  try {
    const dir = ensureAnswersDirInternal("run-1", root);
    const ids = Array.from({ length: 140 }, (_, index) => `near-cap-${String(index).padStart(3, "0")}`);
    for (const id of ids) {
      writeFileSync(join(dir, canonicalDurableIdFileName(id)), JSON.stringify(answer(id, "x".repeat(16_000))));
    }
    let page = readAnswersInternal("run-1", root, { limit: 256, maxBytes: 20_000 });
    const seen = new Set<string>();
    let pages = 0;
    for (;;) {
      pages += 1;
      for (const entry of page.answers) {
        assert.equal(seen.has(entry.id), false, "pagination must not duplicate an answer");
        seen.add(entry.id);
      }
      if (page.done) break;
      assert.ok(page.next_cursor);
      assert.ok(pages < 10, "aggregate-cap pagination must remain bounded");
      page = readAnswersInternal("run-1", root, { cursor: page.next_cursor, limit: 256, maxBytes: 20_000 });
    }
    assert.ok(pages > 1, "fixture must exercise aggregate-cap continuation");
    assert.deepEqual([...seen].sort(), ids);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
test("cto: readAnswers bounds an all-deferred page and never returns a null continuation while active", () => {
  const root = mkdtempSync(join(tmpdir(), "cto-answers-deferred-retry-"));
  const originalReadBatch = PinnedProjectRoot.prototype.readBatch;
  try {
    const dir = ensureAnswersDirInternal("run-1", root);
    const id = "deferred";
    writeFileSync(join(dir, canonicalDurableIdFileName(id)), JSON.stringify(answer(id)));
    PinnedProjectRoot.prototype.readBatch = function (
      _relativeDirectory: string,
      names: readonly string[],
      _options: { maxEntries?: number; maxNameBytes?: number; maxBytes?: number; maxTotalBytes?: number } = {},
    ) {
      return { records: [], failed: [], remaining: [...names] };
    };
    let page = readAnswersInternal("run-1", root, { limit: 1 });
    let pages = 0;
    for (;;) {
      pages += 1;
      assert.equal(page.done, page.next_cursor === null);
      if (page.done) break;
      assert.ok(page.next_cursor);
      assert.ok(pages <= 2, "an all-deferred entry must not spin forever");
      page = readAnswersInternal("run-1", root, { cursor: page.next_cursor, limit: 1 });
    }
    assert.equal(pages, 2);
  } finally {
    PinnedProjectRoot.prototype.readBatch = originalReadBatch;
    rmSync(root, { recursive: true, force: true });
  }
});


test("cto: readAnswerById finds lexical-end answers without enumeration and rejects duplicate aliases", () => {
  const root = mkdtempSync(join(tmpdir(), "cto-answers-exact-"));
  try {
    const dir = ensureAnswersDirInternal("run-1", root);
    for (let index = 0; index < 400; index += 1) {
      const id = `older-${String(index).padStart(3, "0")}`;
      writeFileSync(join(dir, canonicalDurableIdFileName(id)), JSON.stringify(answer(id)));
    }
    const current = answer("run-1/team/checkpoint/current", "current");
    writeFileSync(join(dir, canonicalDurableIdFileName(current.id)), JSON.stringify(current));
    assert.deepEqual(readAnswerByIdInternal("run-1", root, current.id), current);
    const unknown = answer("unknown");
    writeFileSync(join(dir, canonicalDurableIdFileName(unknown.id)), JSON.stringify({ ...unknown, tenant_id: "foreign" }));
    assert.equal(readAnswerByIdInternal("run-1", root, unknown.id), null);
    const duplicate = answer("duplicate/id", "canonical");
    writeFileSync(join(dir, canonicalDurableIdFileName(duplicate.id)), JSON.stringify(duplicate));
    writeFileSync(join(dir, legacyDurableIdFileName(duplicate.id)), JSON.stringify({ ...duplicate, answer: "legacy" }));
    assert.equal(readAnswerByIdInternal("run-1", root, duplicate.id), null);
    writeFileSync(join(dir, legacyDurableIdFileName(duplicate.id)), JSON.stringify(duplicate));
    assert.deepEqual(readAnswerByIdInternal("run-1", root, duplicate.id), duplicate);
    assert.equal(readAnswerByIdInternal("run-1", root, "../foreign"), null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("cto: answer cursor rejects cross-root replay", () => {
  const source = mkdtempSync(join(tmpdir(), "cto-answers-cursor-source-"));
  const target = mkdtempSync(join(tmpdir(), "cto-answers-cursor-target-"));
  try {
    const sourceDir = ensureAnswersDirInternal("run-1", source);
    writeFileSync(join(sourceDir, canonicalDurableIdFileName("source-a")), JSON.stringify(answer("source-a")));
    writeFileSync(join(sourceDir, canonicalDurableIdFileName("source-b")), JSON.stringify(answer("source-b")));
    const first = readAnswersInternal("run-1", source, { limit: 1 });
    assert.ok(first.next_cursor);
    const targetDir = ensureAnswersDirInternal("run-1", target);
    writeFileSync(join(targetDir, canonicalDurableIdFileName("target-a")), JSON.stringify(answer("target-a")));
    assert.deepEqual(readAnswersInternal("run-1", target, { cursor: first.next_cursor, limit: 1 }), { answers: [], next_cursor: null, done: true });
  } finally {
    rmSync(source, { recursive: true, force: true });
    rmSync(target, { recursive: true, force: true });
  }
});

test("cto: answer cursor rejects same-path directory replacement and restarts safely", () => {
  const root = mkdtempSync(join(tmpdir(), "cto-answers-cursor-replaced-dir-"));
  try {
    const dir = ensureAnswersDirInternal("run-1", root);
    writeFileSync(join(dir, canonicalDurableIdFileName("old-a")), JSON.stringify(answer("old-a")));
    writeFileSync(join(dir, canonicalDurableIdFileName("old-b")), JSON.stringify(answer("old-b")));
    const first = readAnswersInternal("run-1", root, { limit: 1 });
    assert.equal(first.answers[0]?.id, "old-a");
    assert.ok(first.next_cursor);
    const replacement = join(root, ".work-state", "cto", "run-1", "answers.new");
    mkdirSync(replacement, { recursive: true });
    writeFileSync(join(replacement, canonicalDurableIdFileName("new-a")), JSON.stringify(answer("new-a")));
    writeFileSync(join(replacement, canonicalDurableIdFileName("new-b")), JSON.stringify(answer("new-b")));
    renameSync(dir, `${dir}.old`);
    renameSync(replacement, dir);
    const restarted = readAnswersInternal("run-1", root, { cursor: first.next_cursor, limit: 1 });
    assert.equal(restarted.answers[0]?.id, "new-a", "same-path replacement must not skip the new first answer");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("cto: readAnswers cursor resets after an insertion before the old cursor", () => {
  const root = mkdtempSync(join(tmpdir(), "cto-answers-cursor-reset-"));
  try {
    const dir = ensureAnswersDirInternal("run-1", root);
    for (const id of ["b-one", "c-two", "d-three"]) writeFileSync(join(dir, canonicalDurableIdFileName(id)), JSON.stringify(answer(id)));
    const first = readAnswersInternal("run-1", root, { limit: 1 });
    assert.equal(first.answers[0]?.id, "b-one");
    assert.ok(first.next_cursor);
    writeFileSync(join(dir, canonicalDurableIdFileName("a-zero")), JSON.stringify(answer("a-zero")));
    const afterInsert = readAnswersInternal("run-1", root, { cursor: first.next_cursor, limit: 1 });
    assert.equal(afterInsert.answers[0]?.id, "a-zero", "snapshot change restarts rather than skipping an earlier insertion");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
