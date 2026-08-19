/**
 * Visualize OPT-A — snapshot security tests (architecture-3).
 *
 * Defends the safety properties of buildSessionSnapshot:
 *   - redaction at EVERY verbosity (default and --full), redaction before
 *     caps, visible size/read-window markers (AC-3);
 *   - hard byte caps and bounded head reads;
 *   - unsafe ids → skipped; unsafe/symlink-escape/boundary/excluded paths →
 *     rejected and never read;
 *   - excluded inputs (events.jsonl, vibe-report, .work-state/visualize)
 *     are never discovered;
 *   - empty vs fully-redacted vs oversized classification;
 *   - strict read-only: no canonical state or artifact mutation.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { buildSessionSnapshot } from "../src/visualize/snapshot.js";
import { resolveDoWorkSource } from "../src/report/session-source.js";
import {
  DEFAULT_BODY_CAP_BYTES,
  EMPTY_BODY_MARKER,
  FULL_BODY_CAP_BYTES,
  REDACTED_MARKER,
  formatTruncationMarker,
} from "../src/visualize/types.js";
import {
  FIXED_GENERATED_AT,
  featureSession,
  artifact,
  hostileSpecBody,
  withInjectedSecretKeys,
  expectedRedactedBody,
  type CanonicalSessionInput,
} from "./fixtures/visualize-fixtures.js";

function tmpWorkspace(): string {
  return mkdtempSync(join(tmpdir(), "viz-security-"));
}

function write(path: string, content: string): void {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, content);
}

function build(cwd: string, input: CanonicalSessionInput, full = false) {
  const resolved = resolveDoWorkSource(cwd, input.id);
  if (!resolved) throw new Error(`session not resolved: ${input.id}`);
  return buildSessionSnapshot(cwd, resolved, FIXED_GENERATED_AT, full ? { full: true } : {});
}

// ── 1. Redaction at every verbosity, redaction before caps (AC-3) ───────────

test("security: secrets are redacted at default AND --full; markers carry original size and applied cap", () => {
  const cwd = tmpWorkspace();
  try {
    const secretBody = withInjectedSecretKeys(
      JSON.stringify({ artifact_id: "spec-intake", summary: "Hostile body.", notes: ["note"] }, null, 2),
    );
    const input = featureSession({
      id: "redact",
      pathKey: "redact",
      task: "Redaction probe.",
      workflow: "spec-preparation",
      updatedAt: "2026-08-19T10:00:00.000Z",
      stages: [{ id: "handoff", status: "done" }],
      declared: { spec_handoff: ".work-state/features/redact/artifacts/spec_handoff.json" },
      files: [artifact("spec_handoff", ".work-state/features/redact/artifacts/spec_handoff.json", secretBody)],
      expected: { status: "complete", staleness: "fresh", artifactStatuses: {} },
    });
    materializeAll(cwd, input);

    const secrets = ["sk-abc123", "t0k3n-secret", "hunter2"];
    for (const full of [false, true]) {
      const session = build(cwd, input, full);
      const art = session.artifacts.find((a) => a.id === "spec_handoff");
      assert.ok(art?.body, `body embedded at ${full ? "--full" : "default"}`);
      for (const secret of secrets) {
        assert.equal(art.body?.text.includes(secret), false, `${secret} must never appear (full=${full})`);
      }
      // Every reader-visible representation is redacted: keys/summary too.
      const json = JSON.stringify(session);
      for (const secret of secrets) assert.equal(json.includes(secret), false, `${secret} must not appear anywhere in the model`);
      assert.equal(art.body?.marker, "", "in-window body under the cap is not falsely marked truncated");
    }

    // Redaction before the cap: the raw head contains secrets, the embedded
    // body must not — even though the cap is larger than the secret lines.
    const session = build(cwd, input);
    const art = session.artifacts.find((a) => a.id === "spec_handoff");
    assert.ok(art?.body);
    assert.ok(art.body.text.length <= art.body.capBytes, "body respects the cap");
    assert.ok(!art.body.text.includes('"api_key"'), "secret line dropped before cap applied");
    // The golden expected body matches the frozen redactor exactly.
    assert.deepEqual(art.body, expectedRedactedBody(secretBody));
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("security: hard caps hold — oversized bodies embed only the bounded head and never exceed the cap", () => {
  const cwd = tmpWorkspace();
  try {
    const huge = JSON.stringify({ data: "x".repeat(300000) });
    const input = featureSession({
      id: "caps",
      pathKey: "caps",
      task: "Cap probe.",
      workflow: "spec-preparation",
      updatedAt: "2026-08-19T10:00:00.000Z",
      stages: [{ id: "handoff", status: "done" }],
      declared: { big: ".work-state/features/caps/artifacts/big.json" },
      files: [artifact("big", ".work-state/features/caps/artifacts/big.json", huge)],
      expected: { status: "complete", staleness: "fresh", artifactStatuses: {} },
    });
    materializeAll(cwd, input);

    const session = build(cwd, input);
    const art = session.artifacts.find((a) => a.id === "big");
    assert.ok(art?.body);
    assert.ok(art.body.preview, "exceeds the default read window");
    assert.ok(art.body.text.length <= DEFAULT_BODY_CAP_BYTES, "body ≤ default cap");
    assert.equal(art.body.capBytes, DEFAULT_BODY_CAP_BYTES);
    assert.ok(art.body.marker.startsWith("…[truncated "), "visible truncation marker");
    assert.ok(art.body.marker.includes(`${Buffer.byteLength(huge, "utf8")}/${DEFAULT_BODY_CAP_BYTES}`), "marker carries original size and applied cap");

    const fullSession = build(cwd, input, true);
    const artFull = fullSession.artifacts.find((a) => a.id === "big");
    assert.ok(artFull?.body);
    assert.ok(artFull.body.text.length <= FULL_BODY_CAP_BYTES, "--full body ≤ hard cap");
    assert.equal(artFull.body.capBytes, FULL_BODY_CAP_BYTES);
    assert.ok(artFull.body.preview, "still a preview under --full");
    assert.ok(artFull.body.marker.startsWith("…[truncated "), "--full marker still visible");
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

// ── 2. Empty vs fully-redacted vs oversized classification ──────────────────

test("security: empty files are produced with [empty]; fully-redacted content becomes [redacted]; oversized previews are never corrupt", () => {
  const cwd = tmpWorkspace();
  try {
    const input = featureSession({
      id: "empty",
      pathKey: "empty",
      task: "Empty probe.",
      workflow: "spec-preparation",
      updatedAt: "2026-08-19T10:00:00.000Z",
      stages: [{ id: "handoff", status: "done" }],
      declared: {
        empty: ".work-state/features/empty/artifacts/empty.json",
        secret: ".work-state/features/empty/artifacts/secret.json",
      },
      files: [
        artifact("empty", ".work-state/features/empty/artifacts/empty.json", ""),
        artifact("secret", ".work-state/features/empty/artifacts/secret.json", '{"token": "t0k3n-only", "api_key": "sk-abc123"}'),
      ],
      expected: { status: "complete", staleness: "fresh", artifactStatuses: {} },
    });
    materializeAll(cwd, input);
    const session = build(cwd, input);

    const empty = session.artifacts.find((a) => a.id === "empty");
    assert.equal(empty?.status, "produced", "empty file is not corrupt");
    assert.equal(empty?.body?.text, EMPTY_BODY_MARKER);
    assert.equal(empty?.body?.truncated, false);
    assert.equal(empty?.bytes, 0);

    const secret = session.artifacts.find((a) => a.id === "secret");
    assert.equal(secret?.status, "produced");
    assert.equal(secret?.body?.text, REDACTED_MARKER, "fully redacted content becomes [redacted]");
    assert.equal(secret.body?.text.includes("sk-abc123"), false);
    assert.deepEqual(secret?.keys, ["token", "api_key"], "keys derive from the ORIGINAL parse, not the redacted text");
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

// ── 3. Unsafe ids / paths / symlink escapes / boundary escapes ──────────────

test("security: unsafe ids are skipped and never read; absolute and escaping declared paths are excluded", () => {
  const cwd = tmpWorkspace();
  try {
    const input = featureSession({
      id: "unsafe",
      pathKey: "unsafe",
      task: "Unsafe probe.",
      workflow: "standard",
      updatedAt: "2026-08-19T10:00:00.000Z",
      stages: [{ id: "implementation", status: "done" }],
      declared: {
        "../escape": "/tmp/escape.json",
        rel_ok: ".work-state/features/unsafe/artifacts/rel_ok.json",
      },
      files: [artifact("rel_ok", ".work-state/features/unsafe/artifacts/rel_ok.json", JSON.stringify({ note: "safe" }))],
      expected: { status: "complete", staleness: "fresh", artifactStatuses: {} },
    });
    materializeAll(cwd, input);
    const session = build(cwd, input);
    const escape = session.artifacts.find((a) => a.id === "../escape");
    assert.equal(escape?.status, "skipped");
    assert.equal(escape?.source, undefined);
    assert.equal(escape?.body, undefined);
    assert.ok(session.warnings.some((w) => w.includes('artifact id "../escape" is not a safe path key: skipped')));
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("security: a symlinked artifact escaping the workspace is rejected and never read", () => {
  const cwd = tmpWorkspace();
  const outside = tmpWorkspace();
  try {
    // Secret file OUTSIDE the workspace.
    const secretPath = join(outside, "leak.json");
    write(secretPath, JSON.stringify({ token: "sk-outside-secret", data: "x".repeat(500) }));

    const input = featureSession({
      id: "symlink",
      pathKey: "symlink",
      task: "Symlink probe.",
      workflow: "standard",
      updatedAt: "2026-08-19T10:00:00.000Z",
      stages: [{ id: "implementation", status: "done" }],
      declared: { leak: ".work-state/features/symlink/artifacts/leak.json" },
      files: [],
      expected: { status: "complete", staleness: "fresh", artifactStatuses: {} },
    });
    // Create the state, then plant a symlink where the artifact should be.
    materializeAll(cwd, input);
    mkdirSync(join(cwd, ".work-state", "features", "symlink", "artifacts"), { recursive: true });
    const linkPath = join(cwd, ".work-state", "features", "symlink", "artifacts", "leak.json");
    symlinkSync(secretPath, linkPath);

    const session = build(cwd, input);
    const leak = session.artifacts.find((a) => a.id === "leak");
    assert.ok(leak, "symlink escape is still listed");
    assert.equal(leak.status, "skipped");
    assert.equal(leak.body, undefined, "escaped file is never read or embedded");
    assert.equal(leak.source, undefined);
    assert.ok(session.warnings.some((w) => w.includes("artifact leak escapes the workspace via symlink: skipped")));
    const model = JSON.stringify(session);
    assert.equal(model.includes("sk-outside-secret"), false, "escaped secret never reaches the model");
  } finally {
    rmSync(cwd, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test("security: boundary-escape declared paths (../, backslash, drive) are excluded from rendering", () => {
  const cwd = tmpWorkspace();
  try {
    const input = featureSession({
      id: "boundary",
      pathKey: "boundary",
      task: "Boundary probe.",
      workflow: "standard",
      updatedAt: "2026-08-19T10:00:00.000Z",
      stages: [{ id: "implementation", status: "done" }],
      declared: {
        up: ".work-state/../outside.json",
        win: "C:\\work\\.work-state\\artifacts\\a.json",
        ok: ".work-state/features/boundary/artifacts/ok.json",
      },
      files: [artifact("ok", ".work-state/features/boundary/artifacts/ok.json", JSON.stringify({ ok: true }))],
      expected: { status: "complete", staleness: "fresh", artifactStatuses: {} },
    });
    materializeAll(cwd, input);
    const session = build(cwd, input);
    assert.equal(session.artifacts.find((a) => a.id === "up")?.status, "missing");
    assert.equal(session.artifacts.find((a) => a.id === "win")?.status, "missing");
    assert.equal(session.artifacts.find((a) => a.id === "ok")?.status, "produced");
    assert.ok(session.warnings.some((w) => w.includes("declared path for up is not a safe relative path: excluded from rendering")));
    assert.ok(session.warnings.some((w) => w.includes("declared path for win is not a safe relative path: excluded from rendering")));
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

// ── 4. Excluded inputs are never discovered ─────────────────────────────────

test("security: events.jsonl, vibe-report and prior generated output are never discovered", () => {
  const cwd = tmpWorkspace();
  try {
    const input = featureSession({
      id: "noisy",
      pathKey: "noisy",
      task: "Excluded probe.",
      workflow: "standard",
      updatedAt: "2026-08-19T10:00:00.000Z",
      stages: [{ id: "discovery", status: "done" }],
      declared: { excluded_out: ".work-state/visualize/index.html" },
      files: [],
      expected: { status: "complete", staleness: "fresh", artifactStatuses: {} },
    });
    // Plant every excluded-input shape inside the artifacts dir and work-state.
    const artifactsDir = join(cwd, ".work-state", "features", "noisy", "artifacts");
    write(join(artifactsDir, "events.jsonl"), '{"kind":"stage_transition"}');
    write(join(artifactsDir, "hidden.json"), JSON.stringify({ note: "must not appear" }));
    write(join(cwd, ".work-state", "visualize", "index.html"), "<html>generated</html>");
    write(join(cwd, ".work-state", "visualize", "manifest.json"), "{}");
    write(join(cwd, "vibe-report", "noisy.md"), "# report");
    write(join(cwd, ".work-state", "features", "noisy", "observability", "events.jsonl"), "{}");
    materializeAll(cwd, input);

    const session = build(cwd, input);
    const ids = session.artifacts.map((a) => a.id);
    assert.ok(!ids.includes("events"), "events.jsonl never discovered");
    assert.ok(ids.includes("hidden"), "hidden.json is a normal extra and IS discovered");
    // Declared path pointing into generated output → excluded, not read.
    const excluded = session.artifacts.find((a) => a.id === "excluded_out");
    assert.equal(excluded?.status, "missing");
    assert.ok(session.warnings.some((w) => w.includes("declared path for excluded_out is not a safe relative path: excluded from rendering")));
    const model = JSON.stringify(session);
    assert.equal(model.includes("<html>generated</html>"), false);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

// ── 5. No canonical mutation ────────────────────────────────────────────────

test("security: snapshot construction never mutates canonical state or artifact bytes", () => {
  const cwd = tmpWorkspace();
  try {
    const input = featureSession({
      id: "frozen",
      pathKey: "frozen",
      task: "Mutation probe.",
      workflow: "spec-preparation",
      updatedAt: "2026-08-19T10:00:00.000Z",
      stages: [{ id: "handoff", status: "done" }],
      declared: { spec_handoff: ".work-state/features/frozen/artifacts/spec_handoff.json" },
      files: [artifact("spec_handoff", ".work-state/features/frozen/artifacts/spec_handoff.json", hostileSpecBody())],
      expected: { status: "complete", staleness: "fresh", artifactStatuses: {} },
    });
    materializeAll(cwd, input);
    const statePath = join(cwd, ".work-state", "features", "frozen", "state.json");
    const artifactPath = join(cwd, ".work-state", "features", "frozen", "artifacts", "spec_handoff.json");
    const stateBefore = readFileSync(statePath);
    const artifactBefore = readFileSync(artifactPath);

    build(cwd, input);
    build(cwd, input, true);

    assert.deepEqual(readFileSync(statePath), stateBefore, "state.json byte-identical");
    assert.deepEqual(readFileSync(artifactPath), artifactBefore, "artifact byte-identical");
    assert.equal(stateBefore.includes(Buffer.from("sk-abc123")), false, "fixture sanity: redaction never writes back");
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

// ── Harness: write a do-work input to disk ──────────────────────────────────

function materializeAll(cwd: string, input: CanonicalSessionInput): void {
  if (input.kind !== "feature") throw new Error("security harness supports feature sessions");
  write(join(cwd, ".work-state", "features", input.id, "state.json"), input.state.content);
  for (const f of input.artifacts) write(join(cwd, f.relPath), f.content);
}
