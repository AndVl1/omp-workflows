/**
 * Session-report writer: containment under .work-state (lexical + symlink
 * escape), parent creation, 0600 permissions — and the report redaction
 * surface (generalized CTO redactor + byte caps).
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { writeReport } from "../src/report/assemble.js";
import { redactText, redactReportBody, DEFAULT_REDACTION_CONFIG } from "../src/report/redact.js";

function tmpWorkspace(): string {
  return mkdtempSync(join(tmpdir(), "report-wr-"));
}

test("writeReport: creates parents, writes mode 0600, returns absolute path", () => {
  const cwd = tmpWorkspace();
  try {
    const target = join(".work-state", "features", "x", "report.html");
    const written = writeReport(cwd, target, "<html>hi</html>");
    const abs = resolve(cwd, target);
    assert.equal(written, abs);
    assert.ok(existsSync(abs));
    const mode = statSync(abs).mode & 0o777;
    assert.equal(mode, 0o600);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("writeReport: rejects targets outside .work-state (relative and absolute)", () => {
  const cwd = tmpWorkspace();
  try {
    mkdirSync(join(cwd, "outside"), { recursive: true });
    assert.throws(() => writeReport(cwd, "../escape.html", "x"), /must be under/);
    assert.throws(() => writeReport(cwd, join(cwd, "outside", "report.html"), "x"), /must be under/);
    assert.ok(!existsSync(join(cwd, "..", "escape.html")));
    assert.ok(!existsSync(join(cwd, "outside", "report.html")));
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("writeReport: rejects a symlinked parent that escapes .work-state", () => {
  const cwd = tmpWorkspace();
  try {
    const outside = join(cwd, "outside");
    mkdirSync(outside, { recursive: true });
    const ws = join(cwd, ".work-state");
    mkdirSync(ws, { recursive: true });
    symlinkSync(outside, join(ws, "features"));

    assert.throws(() => writeReport(cwd, join(".work-state", "features", "x", "report.html"), "x"), /must be under/);
    assert.ok(!existsSync(join(outside, "x", "report.html")));
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("writeReport: accepts absolute targets inside .work-state", () => {
  const cwd = tmpWorkspace();
  try {
    const abs = resolve(cwd, ".work-state", "features", "y", "report.html");
    const written = writeReport(cwd, abs, "html");
    assert.equal(written, abs);
    assert.equal(statSync(abs).mode & 0o777, 0o600);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

// ── Redaction ───────────────────────────────────────────────────────────────

test("redactText: drops secret lines, keeps context, truncates, never throws", () => {
  const body = "Context line.\nAuthorization: Bearer abc123\ntoken = sekrit\nMore context.";
  const clean = redactText(body);
  assert.ok(!clean.includes("Bearer abc123"));
  assert.ok(!clean.includes("token = sekrit"));
  assert.ok(clean.includes("Context line."));
  assert.ok(clean.includes("More context."));
});

test("redactText: inline values replaced when configured; empty result becomes the marker", () => {
  const config = { ...DEFAULT_REDACTION_CONFIG, inline_value_patterns: ["/Bearer\\s+\\S+/g"] };
  const clean = redactText("Details: Bearer tok123", config);
  assert.ok(clean.includes("Details: [redacted]"));
  assert.ok(!clean.includes("tok123"));
  assert.equal(redactText("   \n  "), "[redacted]");
});

test("redactText: invalid patterns degrade to no-op, never throw", () => {
  const config = { ...DEFAULT_REDACTION_CONFIG, secret_line_patterns: ["/[unclosed"] };
  const clean = redactText("keep this line", config);
  assert.equal(clean, "keep this line");
});

test("redactReportBody: byte-caps the embedded body", () => {
  const long = "a".repeat(1000);
  const capped = redactReportBody(long, 64);
  assert.equal(capped.length, 64);
  const secret = redactReportBody("line1\napi_key = hunter2\nline3", 200);
  assert.ok(!secret.includes("hunter2"));
});

test("redactReportBody: drops quoted JSON secret keys the prose pattern misses", () => {
  const json = '{\n  "title": "Plan",\n  "api_key": "sk-12345",\n  "Authorization": "Bearer tok",\n  "notes": "ok"\n}';
  const clean = redactReportBody(json, 500);
  assert.ok(!clean.includes("sk-12345"));
  assert.ok(!clean.includes("Bearer tok"));
  assert.ok(clean.includes('"title"'));
  assert.ok(clean.includes('"notes"'));
  // CTO default semantics unchanged: redactText alone still misses quoted keys.
  assert.ok(redactText(json, DEFAULT_REDACTION_CONFIG).includes("sk-12345"));
});
