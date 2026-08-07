/**
 * Deterministic escalation redaction (br-zps.6): the redactEscalation
 * pipeline, DEFAULT_REDACTION_CONFIG defaults, and sanitizeEscalation
 * delegation (regression guard for the old R4 behavior).
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { sanitizeEscalation, type Escalation } from "@andvl1/omp-workflows-core";
// redactEscalation/DEFAULT_REDACTION_CONFIG are imported from source until the
// index.ts cto-safety export section lands (team lead owns index.ts edits).
import { redactEscalation, DEFAULT_REDACTION_CONFIG } from "../src/cto/redaction.js";

function sampleEscalation(overrides: Partial<Escalation> = {}): Escalation {
  return {
    id: "run/team/checkpoint/1",
    level: "decision",
    title: "Choose API shape",
    body: "REST or gRPC for the new service?",
    options: [{ id: "rest", label: "REST", apply: "now" }],
    default: "rest",
    timeoutMs: 3_600_000,
    ...overrides,
  };
}

test("redaction: secret-bearing lines dropped, other lines kept (default config)", () => {
  const esc = sampleEscalation({
    body: "Context line.\nAuthorization: Bearer abc123\ntoken = sekrit\nNormal context.",
  });
  const clean = redactEscalation(esc);
  assert.equal(clean.body, "Context line.\nNormal context.");
});

test("redaction: inline values replaced on non-key body lines and title, line kept", () => {
  const esc = sampleEscalation({
    body: "Calling https://api.example.com with Bearer abc123\nDetails below.",
    title: "Check Bearer xyz789 endpoint",
  });
  const clean = redactEscalation(esc, {
    ...DEFAULT_REDACTION_CONFIG,
    inline_value_patterns: ["/Bearer\\s+\\S+/g"],
  });
  assert.ok(clean.body.includes("with [redacted]"));
  assert.ok(!clean.body.includes("Bearer abc123"));
  assert.ok(clean.body.includes("Details below."));
  assert.equal(clean.title, "Check [redacted] endpoint");
});

test("redaction: title and body truncated to config limits", () => {
  const esc = sampleEscalation({ title: "T".repeat(50), body: "B".repeat(300) });
  const clean = redactEscalation(esc, {
    ...DEFAULT_REDACTION_CONFIG,
    max_title: 10,
    max_body: 100,
  });
  assert.equal(clean.title, "T".repeat(10));
  assert.equal(clean.body, "B".repeat(100));
});

test("redaction: empty and whitespace-only bodies become the marker", () => {
  assert.equal(redactEscalation(sampleEscalation({ body: "Password: hunter2\nToken: xyz" })).body, "[redacted]");
  assert.equal(redactEscalation(sampleEscalation({ body: "  \n\t " })).body, "[redacted]");
});

test("redaction: deterministic — same input twice yields deep-equal output", () => {
  const esc = sampleEscalation({
    body: "Keep me.\napi_key = abc\nauthorization: Bearer zzz",
    title: "T".repeat(150),
  });
  assert.deepEqual(redactEscalation(esc), redactEscalation(esc));
  assert.deepEqual(sanitizeEscalation(esc), sanitizeEscalation(esc));
});

test("redaction: sanitizeEscalation delegation still drops secrets and truncates (regression)", () => {
  const esc = sampleEscalation({
    body: "Context line.\nAuthorization: Bearer abc123\ntoken = sekrit\nNormal context.",
    title: "Q".repeat(200),
  });
  const clean = sanitizeEscalation(esc);
  assert.ok(clean.title.length <= 120);
  assert.equal(clean.body, "Context line.\nNormal context.");
  assert.ok(!clean.body.includes("Bearer abc123"));
  assert.ok(!clean.body.includes("sekrit"));
});

test("redaction: input escalation is not mutated", () => {
  const esc = sampleEscalation({
    title: "T".repeat(50),
    body: "Keep.\ntoken: x\nTail.",
  });
  const before = structuredClone(esc);
  redactEscalation(esc);
  assert.deepEqual(esc, before);
});

test("redaction: never throws on degenerate patterns", () => {
  const esc = sampleEscalation({ body: "Anything" });
  const clean = redactEscalation(esc, {
    ...DEFAULT_REDACTION_CONFIG,
    secret_line_patterns: ["/(unclosed", "/valid\\s+[:=]/i"],
    inline_value_patterns: ["/(broken", "/X+/g"],
  });
  assert.equal(clean.body, "Anything");
});
