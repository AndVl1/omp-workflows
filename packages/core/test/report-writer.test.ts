/**
 * Session-report writer: containment under .work-state (lexical + symlink
 * escape), parent creation, 0600 permissions — and the report redaction
 * surface (generalized CTO redactor + byte caps).
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

import { PinnedProjectRoot } from "../src/specification/pinned-root.js";
import { MAX_REPORT_HTML_BYTES, ReportHtmlLimitError, writeReport, writeReportPinned } from "../src/report/assemble.js";
import { redactText, redactReportBody, DEFAULT_REDACTION_CONFIG } from "../src/report/redact.js";


function replaceDirectory(path: string): string {
  const displaced = `${path}.displaced`;
  renameSync(path, displaced);
  mkdirSync(path);
  return displaced;
}

function restoreDirectory(path: string, displaced: string): void {
  rmSync(path, { recursive: true, force: true });
  renameSync(displaced, path);
}
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

test("writeReport: accepts a multibyte HTML document immediately below the UTF-8 cap", () => {
  const cwd = tmpWorkspace();
  try {
    const prefix = "<html>";
    const suffix = "</html>";
    const fixedBytes = Buffer.byteLength(prefix + suffix, "utf8");
    const available = MAX_REPORT_HTML_BYTES - fixedBytes;
    const html = `${prefix}${"界".repeat(Math.floor(available / Buffer.byteLength("界", "utf8")))}${suffix}`;
    const expectedBytes = Buffer.byteLength(html, "utf8");
    assert.ok(expectedBytes <= MAX_REPORT_HTML_BYTES);
    assert.ok(MAX_REPORT_HTML_BYTES - expectedBytes < 3, "multibyte fixture must be immediately below the cap");

    const written = writeReport(cwd, ".work-state/features/near/report.html", html);
    const stored = readFileSync(written);
    assert.equal(stored.byteLength, expectedBytes, "the read-back byte count must use UTF-8 bytes");
    assert.equal(stored.subarray(0, Buffer.byteLength(prefix)).toString("utf8"), prefix);
    assert.equal(stored.subarray(-Buffer.byteLength(suffix)).toString("utf8"), suffix);
    assert.equal(stored.subarray(Buffer.byteLength(prefix), Buffer.byteLength(prefix) + 3).toString("utf8"), "界");
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("writeAtomic text transport preserves UTF-8 controls and rejects ambiguous payloads", { skip: process.platform !== "darwin" }, () => {
  const cwd = tmpWorkspace();
  const target = ".work-state/features/text/report.html";
  const html = "<!doctype html>" + String.fromCharCode(10) + "界" + String.fromCharCode(9, 0, 13, 10) + "</html>";
  const pin = PinnedProjectRoot.open(cwd);
  assert.ok(pin);
  try {
    const helper = pin as unknown as { runDescriptorHelper: (operation: string, payload: Record<string, unknown>) => unknown };
    helper.runDescriptorHelper("write_atomic", { path: target, text: html });
    const stored = readFileSync(join(cwd, target));
    assert.deepEqual(stored, Buffer.from(html, "utf8"), "text payload must round-trip exact UTF-8 bytes");

    const ambiguousTarget = ".work-state/features/text/ambiguous.html";
    assert.throws(
      () => helper.runDescriptorHelper("write_atomic", { path: ambiguousTarget, text: html, bytes: Buffer.from(html, "utf8").toString("base64") }),
      /exactly one bytes or text payload/u,
    );
    assert.equal(existsSync(join(cwd, ambiguousTarget)), false, "ambiguous payload must fail before creating a target");

    const invalidTarget = ".work-state/features/text/invalid.html";
    assert.throws(
      () => helper.runDescriptorHelper("write_atomic", { path: invalidTarget, text: "invalid-" + String.fromCharCode(0xd800) }),
      /not valid UTF-8/u,
    );
    assert.equal(existsSync(join(cwd, invalidTarget)), false, "invalid UTF-8 must fail before creating a target");
  } finally {
    pin.close();
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("report writers: cap+1 UTF-8 bytes fail before creating or replacing a target", () => {
  const oversized = `${"x".repeat(MAX_REPORT_HTML_BYTES - 1)}é`;
  const expectedBytes = MAX_REPORT_HTML_BYTES + 1;
  assert.equal(Buffer.byteLength(oversized, "utf8"), expectedBytes);

  const standaloneRoot = tmpWorkspace();
  try {
    const target = join(".work-state", "features", "oversized", "report.html");
    assert.throws(
      () => writeReport(standaloneRoot, target, oversized),
      (error: unknown) => {
        assert.ok(error instanceof ReportHtmlLimitError);
        assert.equal(error.code, "REPORT_HTML_TOO_LARGE");
        assert.equal(error.byteLength, expectedBytes);
        assert.equal(error.maxBytes, MAX_REPORT_HTML_BYTES);
        return true;
      },
    );
    assert.equal(existsSync(join(standaloneRoot, ".work-state")), false, "oversized standalone reports create no directories");
  } finally {
    rmSync(standaloneRoot, { recursive: true, force: true });
  }

  const pinnedRoot = tmpWorkspace();
  const target = join(".work-state", "features", "oversized", "report.html");
  const absoluteTarget = join(pinnedRoot, target);
  mkdirSync(dirname(absoluteTarget), { recursive: true });
  writeFileSync(absoluteTarget, "previous report", "utf8");
  const pin = PinnedProjectRoot.open(pinnedRoot);
  assert.ok(pin);
  try {
    assert.throws(
      () => writeReportPinned(pinnedRoot, target, oversized, pin),
      (error: unknown) => {
        assert.ok(error instanceof ReportHtmlLimitError);
        assert.equal(error.code, "REPORT_HTML_TOO_LARGE");
        assert.equal(error.byteLength, expectedBytes);
        return true;
      },
    );
    assert.equal(readFileSync(absoluteTarget, "utf8"), "previous report", "oversized pinned reports never replace the existing file");
    assert.deepEqual(
      readdirSync(dirname(absoluteTarget)).filter((entry) => entry.endsWith(".tmp")),
      [],
      "oversized reports do not stage a temporary file",
    );
  } finally {
    pin.close();
    rmSync(pinnedRoot, { recursive: true, force: true });
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

test("writeReportPinned: keeps a borrowed root open and writes atomically with private mode", () => {
  const cwd = tmpWorkspace();
  const pin = PinnedProjectRoot.open(cwd);
  assert.ok(pin);
  try {
    const target = join(".work-state", "features", "pinned", "report.html");
    const written = writeReportPinned(cwd, target, "<html>pinned</html>", pin);
    assert.equal(written, resolve(cwd, target));
    assert.equal(pin.isStable(), true, "caller-owned pin remains open");
    assert.equal(statSync(written).mode & 0o777, 0o600);
    assert.equal(readFileSync(written, "utf8"), "<html>pinned</html>");
  } finally {
    pin.close();
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("writeReportPinned: root and ancestor swaps after containment fail before replacement writes", () => {
  const rootCase = tmpWorkspace();
  let rootDisplaced: string | null = null;
  const rootPin = PinnedProjectRoot.open(rootCase, {
    beforeDirectoryCreate: () => {
      if (rootDisplaced === null) rootDisplaced = replaceDirectory(rootCase);
    },
  });
  assert.ok(rootPin);
  try {
    assert.throws(
      () => writeReportPinned(rootCase, ".work-state/features/x/report.html", "root", rootPin),
      /writeReport/,
    );
    assert.deepEqual(readdirSync(rootCase), [], "root replacement stayed untouched");
  } finally {
    rootPin.close();
    if (rootDisplaced !== null) restoreDirectory(rootCase, rootDisplaced);
    rmSync(rootCase, { recursive: true, force: true });
  }

  const container = tmpWorkspace();
  const ancestorRoot = join(container, "project");
  mkdirSync(ancestorRoot);
  let ancestorDisplaced: string | null = null;
  const ancestorPin = PinnedProjectRoot.open(ancestorRoot, {
    beforeDirectoryCreate: () => {
      if (ancestorDisplaced === null) {
        ancestorDisplaced = replaceDirectory(container);
        mkdirSync(ancestorRoot);
      }
    },
  });
  assert.ok(ancestorPin);
  try {
    assert.throws(
      () => writeReportPinned(ancestorRoot, ".work-state/features/x/report.html", "ancestor", ancestorPin),
      /writeReport/,
    );
    assert.deepEqual(readdirSync(ancestorRoot), [], "ancestor replacement stayed untouched");
  } finally {
    ancestorPin.close();
    if (ancestorDisplaced !== null) restoreDirectory(container, ancestorDisplaced);
    rmSync(container, { recursive: true, force: true });
  }
});

test("writeReportPinned: parent and leaf symlink swaps never write outside the pinned root", () => {
  const parentRoot = tmpWorkspace();
  const parentOutside = mkdtempSync(join(tmpdir(), "report-parent-outside-"));
  const parentPin = PinnedProjectRoot.open(parentRoot, {
    beforeDirectoryCreate: (relativePath) => {
      if (relativePath === ".work-state/features/x") {
        mkdirSync(join(parentRoot, ".work-state"), { recursive: true });
        symlinkSync(parentOutside, join(parentRoot, ".work-state/features"), "dir");
      }
    },
  });
  assert.ok(parentPin);
  try {
    assert.throws(
      () => writeReportPinned(parentRoot, ".work-state/features/x/report.html", "parent", parentPin),
      /writeReport/,
    );
    assert.deepEqual(readdirSync(parentOutside), [], "parent replacement stayed untouched");
  } finally {
    parentPin.close();
    rmSync(parentRoot, { recursive: true, force: true });
    rmSync(parentOutside, { recursive: true, force: true });
  }

  const leafRoot = tmpWorkspace();
  const leafOutside = mkdtempSync(join(tmpdir(), "report-leaf-outside-"));
  const outsideFile = join(leafOutside, "sentinel.html");
  writeFileSync(outsideFile, "sentinel");
  const leafTarget = join(leafRoot, ".work-state/features/x/report.html");
  mkdirSync(dirname(leafTarget), { recursive: true });
  const leafPin = PinnedProjectRoot.open(leafRoot, {
    beforeTempOpen: () => {
      if (!existsSync(leafTarget)) symlinkSync(outsideFile, leafTarget, "file");
    },
  });
  assert.ok(leafPin);
  try {
    assert.throws(
      () => writeReportPinned(leafRoot, ".work-state/features/x/report.html", "leaf", leafPin),
      /writeReport/,
    );
    assert.equal(readFileSync(outsideFile, "utf8"), "sentinel", "leaf replacement stayed untouched");
  } finally {
    leafPin.close();
    rmSync(leafRoot, { recursive: true, force: true });
    rmSync(leafOutside, { recursive: true, force: true });
  }
});
