import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import type { EvidenceSegment } from "@andvl1/omp-workflows-core";
import {
  characterErrorRate,
  scoreLectureEvalCase,
  scoreProposalRelevance,
  scoreTimestampAlignment,
  type LectureEvalCase,
  type LectureEvalManifest,
  type LectureEvalRun,
} from "../src/lecture-acquisition/eval.js";

const fixturePath = resolve(dirname(fileURLToPath(import.meta.url)), "..", "evals", "lecture-eval-fixtures.json");
const fixtureText = readFileSync(fixturePath, "utf8");
const manifest = JSON.parse(fixtureText) as LectureEvalManifest;
const englishCase = manifest.cases.find((item) => item.language === "en");
const russianCase = manifest.cases.find((item) => item.language === "ru");
assert.ok(englishCase, "English synthetic fixture is present");
assert.ok(russianCase, "Russian synthetic fixture is present");

function evidence(quote: string, startSeconds: number, endSeconds: number, index: number): EvidenceSegment {
  return {
    evidenceId: `synthetic-evidence-${index}`,
    sourceId: "synthetic-fixture",
    location: "synthetic-fixture",
    provider: "fixture-analysis",
    kind: "transcript_excerpt",
    quote,
    startSeconds,
    endSeconds,
  };
}

function claimText(claim: LectureEvalCase["referenceClaims"][number]): string {
  return typeof claim === "string" ? claim : claim.text ?? claim.claim ?? "";
}

function fixtureRun(evalCase: LectureEvalCase, overrides: Partial<LectureEvalRun> = {}): LectureEvalRun {
  const normalizedEvidence = evalCase.referenceClaims.map((claim, index) => {
    const startSeconds = typeof claim === "string" ? index : claim.startSeconds ?? claim.start ?? index;
    const endSeconds = typeof claim === "string" ? index + 1 : claim.endSeconds ?? claim.end ?? index + 1;
    return evidence(claimText(claim), startSeconds, endSeconds, index);
  });
  return {
    provider: "fixture-provider",
    model: "fixture-model",
    route: "local",
    predictedTranscript: evalCase.referenceTranscript,
    normalizedEvidence,
    predictedProposalTerms: evalCase.referenceProposalTerms,
    latencyMs: 120,
    costCents: 6,
    cleanupVerified: true,
    ...overrides,
  };
}

test("scores a perfect English fixture run across all metrics", () => {
  const score = scoreLectureEvalCase(englishCase, fixtureRun(englishCase));
  assert.equal(score.wer, 0);
  assert.equal(score.cer, 0);
  assert.equal(score.timestampAlignment, 1);
  assert.equal(score.groundedClaimPrecision, 1);
  assert.equal(score.groundedClaimRecall, 1);
  assert.equal(score.hallucinationRate, 0);
  assert.equal(score.proposalRelevance, 1);
  assert.equal(score.proposalRelevanceMetrics.f1, 1);
  assert.equal(score.latencyMs, 120);
  assert.equal(score.costCentsPerMinute, 30);
  assert.equal(score.cleanupPassed, true);
  assert.equal(score.aggregate, 1);
  assert.equal(score.aggregateReport.bounded, true);
  assert.match(score.report.notes.join(" "), /not semantic truth/);
});

test("loads and scores the Russian synthetic fixture without provider calls", () => {
  const score = scoreLectureEvalCase(russianCase, fixtureRun(russianCase));
  assert.equal(russianCase.rightsStatus, "synthetic-fixture");
  assert.equal(russianCase.language, "ru");
  assert.equal(score.wer, 0);
  assert.equal(score.cer, 0);
  assert.equal(score.groundedClaimPrecision, 1);
  assert.equal(score.proposalRelevance, 1);
});

test("WER and CER increase for deterministic transcript edits", () => {
  const predictedTranscript = englishCase.referenceTranscript.map((segment, index) => index === 0 ? { ...segment, text: "A bounded trial changes two variables." } : segment);
  const score = scoreLectureEvalCase(englishCase, fixtureRun(englishCase, { predictedTranscript }));
  assert.ok(score.wer > 0);
  assert.ok(score.cer > 0);
  assert.equal(characterErrorRate("Alpha beta", "alpha beta"), 0);
});

test("timestamp alignment penalizes a non-overlapping prediction and honors strict config", () => {
  const shifted = englishCase.referenceTranscript.map((segment) => ({
    ...segment,
    startSeconds: segment.startSeconds + 20,
    endSeconds: segment.endSeconds + 20,
  }));
  assert.equal(scoreTimestampAlignment(englishCase.referenceTranscript, shifted, { overlapThreshold: 0.5, boundaryToleranceSeconds: 0 }), 0);
  const score = scoreLectureEvalCase(englishCase, fixtureRun(englishCase, { predictedTranscript: shifted }));
  assert.equal(score.timestampAlignment, 0);
});

test("grounded precision and hallucination rate distinguish matching and fake evidence", () => {
  const grounded = fixtureRun(englishCase);
  const first = grounded.normalizedEvidence?.[0];
  assert.ok(first);
  const mixedEvidence = [first, evidence("This claim is not in the reference.", 0, 4, 99)];
  const score = scoreLectureEvalCase(englishCase, fixtureRun(englishCase, { normalizedEvidence: mixedEvidence }));
  assert.equal(score.groundedClaimPrecision, 0.5);
  assert.equal(score.hallucinationRate, 0.5);
  assert.equal(score.report.metrics.proposalRelevanceMetrics.status, "scored");
});

test("proposal relevance reports lexical precision/recall/F1 and explicit n/a", () => {
  const scored = scoreProposalRelevance(["bounded experiment", "control group"], ["bounded experiment", "unrelated term"]);
  assert.equal(scored.status, "scored");
  assert.equal(scored.precision, 0.5);
  assert.equal(scored.recall, 0.5);
  assert.equal(scored.f1, 0.5);
  const notApplicable = scoreProposalRelevance(undefined, []);
  assert.equal(notApplicable.status, "n/a");
  assert.equal(notApplicable.f1, "n/a");
});

test("latency and cost are finite, caller-reported, and safe for zero duration", () => {
  const score = scoreLectureEvalCase(englishCase, fixtureRun(englishCase, { latencyMs: Number.POSITIVE_INFINITY, costCents: Number.NaN }));
  assert.equal(score.latencyMs, 0);
  assert.equal(score.costCents, 0);
  assert.equal(score.costCentsPerMinute, 0);
  const zeroDuration: LectureEvalCase = { ...englishCase, id: "synthetic-zero-duration", durationSeconds: 0, referenceTranscript: [], referenceClaims: [], referenceProposalTerms: [] };
  const zeroScore = scoreLectureEvalCase(zeroDuration, fixtureRun(zeroDuration, { costCents: 99 }));
  assert.equal(zeroScore.costCentsPerMinute, 0);
});

test("cleanup failure is passed through and lowers the bounded aggregate", () => {
  const score = scoreLectureEvalCase(englishCase, fixtureRun(englishCase, { cleanupVerified: false }));
  assert.equal(score.cleanupPassed, false);
  assert.equal(score.aggregateReport.dimensions.cleanup, 0);
  assert.ok(score.aggregate >= 0 && score.aggregate <= 1);
});

test("empty input has documented zero-safe finite metrics", () => {
  const emptyCase: LectureEvalCase = {
    schemaVersion: 1,
    id: "synthetic-empty",
    rightsStatus: "synthetic-fixture",
    rightsNotes: "Synthetic empty case for deterministic tests; no media or provider output.",
    language: "en",
    durationSeconds: 0,
    referenceTranscript: [],
    referenceClaims: [],
  };
  const score = scoreLectureEvalCase(emptyCase, {
    provider: "fixture-provider",
    route: "local",
    predictedTranscript: [],
    normalizedEvidence: [],
    predictedProposalTerms: [],
    latencyMs: 0,
    costCents: 0,
    cleanupVerified: true,
  });
  assert.equal(score.wer, 0);
  assert.equal(score.cer, 0);
  assert.equal(score.timestampAlignment, 1);
  assert.equal(score.groundedClaimPrecision, 1);
  assert.equal(score.hallucinationRate, 0);
  assert.equal(score.proposalRelevance, 0);
  assert.equal(score.proposalRelevanceMetrics.status, "n/a");
  const numericMetrics = [score.wer, score.cer, score.timestampAlignment, score.groundedClaimPrecision, score.hallucinationRate, score.proposalRelevance, score.latencyMs, score.costCentsPerMinute, score.aggregate];
  assert.ok(numericMetrics.every((metric) => Number.isFinite(metric)));
});

test("synthetic manifest has both languages and no URL/media/secret material", () => {
  assert.equal(manifest.schemaVersion, 1);
  assert.equal(manifest.cases.length >= 2, true);
  assert.deepEqual(new Set(manifest.cases.map((item) => item.language)), new Set(["en", "ru"]));
  assert.ok(manifest.cases.every((item) => item.rightsStatus === "synthetic-fixture"));
  assert.doesNotMatch(fixtureText, /https?:\/\//i);
  assert.doesNotMatch(fixtureText, /(api[_-]?key|secret|password|token)/i);
});
