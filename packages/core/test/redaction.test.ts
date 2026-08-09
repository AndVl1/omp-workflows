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

// Representative real-format JWT (HS256 header + payload + signature).
const SAMPLE_JWT =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c";

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

// ── SEC-3 regression: default inline redaction of prose JWT/Bearer values ──

test("redaction: default config replaces prose JWT inline (line kept, title redacted)", () => {
  const esc = sampleEscalation({
    body: `Auth flow: use ${SAMPLE_JWT} for the call.\nDetails follow.`,
    title: `Check ${SAMPLE_JWT} endpoint`,
  });
  const clean = redactEscalation(esc);
  assert.ok(clean.body.includes("Auth flow: use [redacted] for the call."), "line kept, JWT replaced inline");
  assert.ok(!clean.body.includes("eyJhbGci"), "JWT gone from body");
  assert.ok(clean.body.includes("Details follow."), "rest of the body intact");
  assert.equal(clean.title, "Check [redacted] endpoint");
  assert.ok(!clean.title.includes("eyJhbGci"), "JWT gone from title");
});

test("redaction: default config replaces prose Bearer value; key:value secret lines still dropped", () => {
  const esc = sampleEscalation({
    body: "Calling https://api.example.com with Bearer abc123\nDetails below.\nAuthorization: Bearer zzz\ntoken = sekrit",
  });
  const clean = redactEscalation(esc);
  assert.ok(clean.body.includes("Calling https://api.example.com with [redacted]"), "prose Bearer replaced inline, line kept");
  assert.ok(!clean.body.includes("Bearer abc123"), "prose Bearer token gone");
  assert.ok(clean.body.includes("Details below."), "surrounding prose intact");
  assert.ok(!clean.body.includes("zzz") && !clean.body.includes("sekrit"), "key:value secret lines still dropped");
});

test("redaction: default config does not false-positive on plain-English bearer prose", () => {
  const esc = sampleEscalation({ body: "The bearer of the news arrived.\nInvestors hold bearer bonds." });
  const clean = redactEscalation(esc);
  assert.ok(clean.body.includes("The bearer of the news arrived."), "prose untouched");
  assert.ok(clean.body.includes("bearer bonds"), "prose untouched");
});

test("redaction: option labels redacted, id/apply preserved, secret-line label becomes the marker", () => {
  const esc = sampleEscalation({
    options: [
      { id: "rest", label: "REST", apply: "now" },
      { id: "jwt-opt", label: `Use token ${SAMPLE_JWT} now`, apply: "on_next_checkpoint" },
      { id: "secret-opt", label: "token = sekrit", apply: "now" },
    ],
  });
  const clean = redactEscalation(esc);
  assert.deepEqual(clean.options, [
    { id: "rest", label: "REST", apply: "now" },
    { id: "jwt-opt", label: "Use token [redacted] now", apply: "on_next_checkpoint" },
    { id: "secret-opt", label: "[redacted]", apply: "now" },
  ]);
});

test("redaction: default field — clean value passes through, secret value redacted", () => {
  assert.equal(redactEscalation(sampleEscalation({ default: "rest" })).default, "rest");
  assert.equal(redactEscalation(sampleEscalation({ default: "Bearer abc123" })).default, "[redacted]");
  assert.equal(redactEscalation(sampleEscalation({ default: SAMPLE_JWT })).default, "[redacted]");
});

test("redaction: replyTo — correlation id passes through, JWT-bearing replyTo redacted", () => {
  assert.equal(redactEscalation(sampleEscalation({ replyTo: "run/team/checkpoint/1" })).replyTo, "run/team/checkpoint/1");
  const clean = redactEscalation(sampleEscalation({ replyTo: `chain/${SAMPLE_JWT}` }));
  assert.ok(clean.replyTo?.includes("[redacted]"), "replyTo redacted");
  assert.ok(!clean.replyTo?.includes("eyJhbGci"), "JWT gone from replyTo");
});

test("redaction: determinism and no-mutation extend to options/default/replyTo; absent fields stay absent", () => {
  const esc = sampleEscalation({
    body: "Use Bearer abc123 now.\nKeep this.",
    title: "T".repeat(150),
    options: [
      { id: "a", label: "token = sekrit", apply: "now" },
      { id: "b", label: `pick ${SAMPLE_JWT}`, apply: "on_next_checkpoint" },
    ],
    default: "Bearer xyz789",
    replyTo: "run/team/checkpoint/2",
  });
  const before = structuredClone(esc);
  const a = redactEscalation(esc);
  const b = redactEscalation(esc);
  assert.deepEqual(a, b, "deterministic across calls");
  assert.deepEqual(esc, before, "input escalation not mutated");
  assert.equal(a.default, "[redacted]", "secret default redacted");
  assert.equal(a.replyTo, "run/team/checkpoint/2", "clean replyTo passes through");

  const bare = redactEscalation({ id: "x", level: "decision", title: "t", body: "b" });
  assert.equal(bare.options, undefined, "absent options stays absent");
  assert.equal(bare.default, undefined, "absent default stays absent");
  assert.equal(bare.replyTo, undefined, "absent replyTo stays absent");
});
