/**
 * CONTRACT-FIRST suite for the deterministic Markdown product PRD document
 * stage (task: "Implement deterministic Markdown product PRD document stage").
 *
 * The implementation lives in `../src/engine/product-prd.js`; this suite
 * pins its contract. Public surface:
 *
 *   renderProductPrdDocument(sourceArtifacts) -> string
 *     Deterministic (template-driven, never key-order/clock driven) Markdown
 *     rendering of the FIVE source artifacts (product_intake,
 *     product_framing, product_evidence, product_critique, product_spec).
 *     Throws (fail closed) when one of the five sources is missing. The
 *     markdown never embeds a timestamp.
 *
 *   writeProductPrdDocument({ stateDir, artifactsDir, path?, sourceArtifacts })
 *     -> { ok: true; documentPath: string; artifactPath: string;
 *          source_hash: string; content_hash: string }
 *      | { ok: false; error: string }
 *     Atomically persists:
 *       - the markdown document at join(stateDir, path) — `path` is a SAFE
 *         RELATIVE path (nested dirs allowed; traversal segments, absolute
 *         paths and symlinks anywhere on the resolved path are rejected);
 *       - the typed `product_prd` artifact at artifactsDir/product_prd.json
 *         with the EXACT manifest fields (no extras, none missing):
 *         { type, format, renderer, path, source_artifacts, source_hash,
 *           content_hash, content }.
 *     source_hash is a deterministic hash of the five source artifacts
 *     (key-order independent); content_hash is sha256 of the markdown bytes.
 *     A rejected write mutates nothing.
 *
 *   validateProductPrdDocument({ stateDir, artifactsDir })
 *     -> { ok: boolean; issues: string[] }
 *     ok only when the artifact manifest has the exact field set, its
 *     content_hash matches sha256(content) AND the on-disk document bytes,
 *     the document exists and is not a symlink, and the current source
 *     artifacts still hash to source_hash (stale-source detection).
 *
 * Profile contract: product-discovery gains a `product_prd_document` stage
 * of the executable `document` type — `document` declares exactly
 * { format: "markdown", renderer: "product-prd", path: "documents/product-prd.md" } —
 * BETWEEN product_synthesis and product_approval (before approval),
 * consuming exactly the five source artifacts and producing `product_prd`
 * (schema-registered, content_hash + content required). No agent dispatch:
 * runStage executes the renderer in-engine (see the runStage tests below).
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { loadAllProfiles } from "../src/engine/profile.js";
import { artifactSchemaFor, requiredFieldsOf, validateProducedArtifact } from "../src/engine/artifact-contract.js";
import {
  renderProductPrdDocument,
  validateProductPrdDocument,
  writeProductPrdDocument,
} from "../src/engine/product-prd.js";
import { runStage, type StageContext } from "../src/engine/stage.js";
import type { StageDef } from "../src/engine/types.js";

// ── fixtures ────────────────────────────────────────────────────────────────

const SOURCE_ARTIFACT_IDS = ["product_intake", "product_framing", "product_evidence", "product_critique", "product_spec"] as const;

/** Exact manifest field set of the typed product_prd artifact. */
const PRD_MANIFEST_FIELDS = [
  "content",
  "content_hash",
  "format",
  "path",
  "renderer",
  "source_artifacts",
  "source_hash",
  "type",
];

function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function validSources(): Record<string, unknown> {
  return {
    product_intake: {
      problem_statements: ["Teams cannot review an approved product direction as a document"],
      contexts: ["omp-workflows product-discovery runs"],
      stakeholders: ["product owner", "platform lead"],
      constraints: ["no application code changes"],
      open_questions: ["where the PRD file lives"],
      evidence: [{ claim: "no renderer exists today", status: "verified", source: "documents.test.ts" }],
    },
    product_framing: {
      problem_restatement: "Product direction needs a deterministic, tamper-evident Markdown document.",
      target_users: ["product owners", "platform leads"],
      success_criteria: ["identical sources render byte-identical PRDs"],
      non_goals: ["implementation planning"],
      assumptions: ["the five source artifacts are schema-valid"],
    },
    product_evidence: {
      evidence: [{ claim: "sha256 detects any post-write edit", status: "verified", source: "documents.test.ts" }],
      alternatives: [{ id: "handwritten-prd", summary: "hand-written PRDs", pros: [], cons: ["not reproducible"] }],
      gaps: [],
    },
    product_critique: {
      verdict: "proceed",
      findings: ["renderer drift must be caught by hash validation"],
      blocking_gaps: [],
    },
    product_spec: {
      recommendation: "proceed",
      value_proposition: "Deterministic PRDs give product owners a reviewable, tamper-evident document.",
      opportunity: "No deterministic renderer from spec to document exists today.",
      target_users: ["product owners", "platform leads"],
      solution_direction: "Render the five source artifacts into deterministic Markdown with verifiable hashes.",
      success_metrics: ["identical sources render byte-identical PRDs", "any post-write edit fails validation"],
      guardrail_metrics: ["workflow stage latency unchanged"],
      scope: ["deterministic renderer", "typed product_prd artifact", "profile documents stage"],
      anti_scope: ["implementation planning", "architecture decisions"],
      risks: ["template drift without hash re-verification"],
      validation_plan: [],
      evidence_trace: ["claim: deterministic rendering — status: verified — source: documents.test.ts"],
      open_decisions: ["where the PRD file lives"],
    },
  };
}

/** { stateDir, artifactsDir } pair plus pre-persisted source artifacts. */
function seededRun(): { stateDir: string; artifactsDir: string } {
  const stateDir = mkdtempSync(join(tmpdir(), "omp-prd-state-"));
  const artifactsDir = join(stateDir, "artifacts");
  mkdirSync(artifactsDir, { recursive: true });
  for (const [id, value] of Object.entries(validSources())) {
    writeFileSync(join(artifactsDir, `${id}.json`), JSON.stringify(value, null, 2));
  }
  return { stateDir, artifactsDir };
}

function writePrd(stateDir: string, artifactsDir: string, path?: string) {
  const sources: Record<string, unknown> = {};
  for (const id of SOURCE_ARTIFACT_IDS) sources[id] = JSON.parse(readFileSync(join(artifactsDir, `${id}.json`), "utf8"));
  return writeProductPrdDocument({ stateDir, artifactsDir, path, sourceArtifacts: sources });
}

/** First Markdown heading matching `include` (and not any `exclude`). */
function findHeading(markdown: string, include: RegExp, exclude: RegExp[] = []): string | null {
  for (const line of markdown.split("\n")) {
    if (!/^#{1,6}\s/.test(line)) continue;
    if (!include.test(line)) continue;
    if (exclude.some((x) => x.test(line))) continue;
    return line;
  }
  return null;
}

/** Body of the section introduced by the heading matching `include`. */
function section(markdown: string, include: RegExp, exclude: RegExp[] = []): string {
  const lines = markdown.split("\n");
  const start = lines.findIndex((line) => findHeading(line, include, exclude) !== null);
  assert.ok(start >= 0, `heading matching ${include} must exist`);
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i += 1) {
    if (/^#{1,6}\s/.test(lines[i]!)) {
      end = i;
      break;
    }
  }
  return lines.slice(start, end).join("\n");
}

/** Every product_spec concept keeps its own PRD section. */
const CONCEPT_HEADINGS: Array<[string, RegExp, RegExp?]> = [
  ["value_proposition", /value proposition/i],
  ["opportunity", /opportunity/i],
  ["target_users", /target users/i],
  ["solution_direction", /solution direction/i],
  ["success_metrics", /success metrics/i],
  ["guardrail_metrics", /guardrail metrics/i],
  ["scope", /\bscope\b/i, /anti|out of/i],
  ["anti_scope", /anti[- ]?scope/i],
  ["risks", /\brisks?\b/i],
  ["validation_plan", /validation plan/i],
  ["evidence_trace", /evidence trace/i],
  ["open_decisions", /open (product )?decisions?/i],
];

// ── deterministic rendering, hashes, no timestamps ─────────────────────────

test("product-prd: rendering is deterministic across key order and repeated invocation, with no timestamp in the markdown", () => {
  const sourcesA = validSources();
  const sourcesB: Record<string, unknown> = {};
  for (const key of Object.keys(sourcesA).reverse()) sourcesB[key] = sourcesA[key];

  const first = renderProductPrdDocument(sourcesA);
  const second = renderProductPrdDocument(sourcesB);
  assert.equal(first, second, "source key order never changes the rendered bytes");
  assert.equal(first, renderProductPrdDocument(validSources()), "repeated rendering is byte-identical (no embedded clock)");
  assert.match(sha256(first), /^[0-9a-f]{64}$/);

  // Nested-object values (schema-drift tolerance): the same object with its
  // keys inserted in a different order — at every nesting level — must render
  // byte-identically. Locks the scalar() canonicalJson contract: nested
  // objects are canonicalized (key-sorted), never JSON.stringify insertion
  // order.
  const nestedA = validSources();
  (nestedA.product_spec as Record<string, unknown>).value_proposition = { z: "last", a: "first", m: { y: 2, x: 1 } };
  const nestedB = validSources();
  (nestedB.product_spec as Record<string, unknown>).value_proposition = { m: { x: 1, y: 2 }, a: "first", z: "last" };
  assert.equal(
    renderProductPrdDocument(nestedA),
    renderProductPrdDocument(nestedB),
    "nested object key order never changes the rendered bytes",
  );

  assert.doesNotMatch(first, /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/, "no ISO-8601 timestamp in the markdown");
  assert.doesNotMatch(first, /\b\d{2}:\d{2}:\d{2}\b/, "no clock time in the markdown");
});

test("product-prd: rendering fails closed when one of the five source artifacts is missing", () => {
  for (const id of SOURCE_ARTIFACT_IDS) {
    const sources = validSources();
    delete sources[id];
    assert.throws(() => renderProductPrdDocument(sources), new RegExp(id), `${id} is a required source`);
  }
});

test("product-prd: writeProductPrdDocument reports deterministic source and content hashes", () => {
  const runA = seededRun();
  const runB = seededRun();
  try {
    const a = writePrd(runA.stateDir, runA.artifactsDir, "docs/product-prd.md");
    const b = writePrd(runB.stateDir, runB.artifactsDir, "docs/product-prd.md");
    assert.ok(a.ok && b.ok);
    if (!a.ok || !b.ok) return;

    assert.match(a.source_hash, /^[0-9a-f]{64}$/);
    assert.match(a.content_hash, /^[0-9a-f]{64}$/);
    assert.equal(a.source_hash, b.source_hash, "source hash is deterministic across runs");
    assert.equal(a.content_hash, b.content_hash, "content hash is deterministic across runs");
    assert.equal(a.content_hash, sha256(readFileSync(a.documentPath, "utf8")), "content hash covers the exact document bytes");

    // any source edit changes the source hash (and is later flagged as stale)
    const spec = JSON.parse(readFileSync(join(runB.artifactsDir, "product_spec.json"), "utf8")) as Record<string, unknown>;
    spec.open_decisions = ["changed after rendering"];
    writeFileSync(join(runB.artifactsDir, "product_spec.json"), JSON.stringify(spec, null, 2));
    const rewritten = writePrd(runB.stateDir, runB.artifactsDir, "docs/product-prd.md");
    assert.ok(rewritten.ok);
    if (rewritten.ok) assert.notEqual(rewritten.source_hash, b.source_hash, "source hash tracks source content");
  } finally {
    rmSync(runA.stateDir, { recursive: true, force: true });
    rmSync(runB.stateDir, { recursive: true, force: true });
  }
});

// ── explicit unknowns ──────────────────────────────────────────────────────

test("product-prd: explicit unknowns stay visible and every product_spec concept keeps its section", () => {
  const sources = validSources();
  (sources.product_spec as Record<string, unknown>).value_proposition = "unknown";
  (sources.product_spec as Record<string, unknown>).success_metrics = ["TBD"];
  (sources.product_framing as Record<string, unknown>).target_users = ["unknown"];
  (sources.product_evidence as Record<string, unknown>).gaps = ["TBD"];

  const markdown = renderProductPrdDocument(sources);

  for (const [field, include, exclude] of CONCEPT_HEADINGS) {
    assert.ok(findHeading(markdown, include, exclude ? [exclude] : []), `concept '${field}' keeps its own heading`);
  }
  assert.match(section(markdown, /value proposition/i), /unknown/i, "unknown value stays visible");
  assert.match(section(markdown, /success metrics/i), /TBD/);
  assert.match(section(markdown, /target users/i), /unknown/i);
  assert.match(section(markdown, /\bgaps?\b/i), /TBD/);

  // the framing restatement and critique verdict are rendered, not dropped
  assert.match(markdown, /deterministic, tamper-evident/);
  assert.match(markdown, /proceed/);
});

// ── atomic write + exact manifest shape ────────────────────────────────────

test("product-prd: writeProductPrdDocument persists document + typed artifact with the exact manifest fields", () => {
  const run = seededRun();
  try {
    const written = writePrd(run.stateDir, run.artifactsDir, "docs/product-prd.md");
    assert.ok(written.ok);
    if (!written.ok) return;

    const artifactPath = join(run.artifactsDir, "product_prd.json");
    assert.equal(written.artifactPath, artifactPath);
    assert.ok(existsSync(written.documentPath), "the document file exists");
    assert.ok(existsSync(artifactPath), "the typed artifact exists");

    const manifest = JSON.parse(readFileSync(artifactPath, "utf8")) as Record<string, unknown>;
    assert.deepEqual(Object.keys(manifest).sort(), PRD_MANIFEST_FIELDS, "the manifest carries exactly the agreed fields");
    assert.equal(manifest.type, "product_prd");
    assert.equal(manifest.format, "markdown");
    assert.equal(typeof manifest.renderer, "string");
    assert.ok((manifest.renderer as string).length > 0, "renderer identifies the renderer (id/version)");
    assert.equal(manifest.path, "docs/product-prd.md", "the manifest records the safe relative path");
    assert.deepEqual(manifest.source_artifacts, [...SOURCE_ARTIFACT_IDS]);
    assert.equal(manifest.content_hash, written.content_hash);
    assert.equal(manifest.source_hash, written.source_hash);

    const onDisk = readFileSync(written.documentPath, "utf8");
    assert.equal(manifest.content, onDisk, "inline content equals the document file");
    assert.equal(sha256(onDisk), manifest.content_hash, "content_hash covers the file bytes");
    assert.equal(onDisk, renderProductPrdDocument(validSources()), "the persisted document is the deterministic rendering");

    // rewriting atomically replaces both files — no duplicate/legacy entries
    const again = writePrd(run.stateDir, run.artifactsDir, "docs/product-prd.md");
    assert.ok(again.ok, "rewrite succeeds");
    if (!again.ok) return;
    const replaced = JSON.parse(readFileSync(artifactPath, "utf8")) as Record<string, unknown>;
    assert.deepEqual(Object.keys(replaced).sort(), PRD_MANIFEST_FIELDS);
    assert.equal(replaced.content_hash, again.content_hash);
  } finally {
    rmSync(run.stateDir, { recursive: true, force: true });
  }
});

test("product-prd: a default document path is used when none is given and stays inside the state dir", () => {
  const run = seededRun();
  try {
    const written = writePrd(run.stateDir, run.artifactsDir);
    assert.ok(written.ok);
    if (!written.ok) return;
    assert.ok(existsSync(written.documentPath), "document written at the default path");
    const rel = relative(run.stateDir, written.documentPath);
    assert.ok(rel !== "" && !rel.startsWith(".."), "the default path resolves inside the state dir");
    const manifest = JSON.parse(readFileSync(written.artifactPath, "utf8")) as { path: string };
    assert.equal(typeof manifest.path, "string");
    assert.ok(!manifest.path.startsWith("/"), "the recorded path is relative");
  } finally {
    rmSync(run.stateDir, { recursive: true, force: true });
  }
});

// ── safe relative path + symlink rejection ─────────────────────────────────

test("product-prd: writeProductPrdDocument rejects traversal and absolute paths without side effects", () => {
  const run = seededRun();
  const outside = mkdtempSync(join(tmpdir(), "omp-prd-outside-"));
  try {
    const before = readdirSync(run.stateDir).sort();
    for (const path of ["../escape.md", "../../escape.md", "/tmp/absolute.md", "docs/../../escape.md", "..\\win.md"]) {
      const result = writePrd(run.stateDir, run.artifactsDir, path);
      assert.equal(result.ok, false, `path '${path}' must be rejected`);
      if (!result.ok) assert.match(result.error, /path|traversal|absolute|invalid|escape/i);
    }
    assert.deepEqual(readdirSync(run.stateDir).sort(), before, "a rejected write creates nothing in the state dir");
    assert.equal(readdirSync(outside).length, 0, "nothing escaped to the outside dir");
  } finally {
    rmSync(run.stateDir, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test("product-prd: writeProductPrdDocument refuses symlinked targets, symlinked path components and symlinked roots", () => {
  const run = seededRun();
  const outside = mkdtempSync(join(tmpdir(), "omp-prd-outside-"));
  const linkedRoot = `${run.stateDir}-link`;
  try {
    // 1) the target file itself is a symlink to an outside file
    const secret = join(outside, "secret.md");
    writeFileSync(secret, "do not clobber\n");
    symlinkSync(secret, join(run.stateDir, "product-prd.md"));
    const viaFile = writePrd(run.stateDir, run.artifactsDir, "product-prd.md");
    assert.equal(viaFile.ok, false, "a symlinked document target must be refused");
    assert.equal(readFileSync(secret, "utf8"), "do not clobber\n", "the outside target is untouched");

    // 2) a path component is a symlink to an outside directory
    const outsideDocs = join(outside, "docs");
    mkdirSync(outsideDocs);
    symlinkSync(outsideDocs, join(run.stateDir, "linked-docs"));
    const viaComponent = writePrd(run.stateDir, run.artifactsDir, "linked-docs/product-prd.md");
    assert.equal(viaComponent.ok, false, "a symlinked path component must be refused");
    assert.equal(readdirSync(outsideDocs).length, 0, "nothing escaped through the symlinked component");

    // 3) the state dir itself is reached through a symlink
    symlinkSync(run.stateDir, linkedRoot);
    const viaRoot = writePrd(linkedRoot, join(linkedRoot, "artifacts"), "docs/product-prd.md");
    assert.equal(viaRoot.ok, false, "a symlinked state root must be refused");
    assert.ok(!existsSync(join(run.stateDir, "docs")), "no document was created through the link");
  } finally {
    rmSync(run.stateDir, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
    rmSync(linkedRoot, { force: true });
  }
});

// ── stale source / content / sidecar mismatch rejection ────────────────────

test("product-prd: validateProductPrdDocument accepts a fresh write and rejects every staleness and mismatch", () => {
  // baseline: fresh write validates clean
  {
    const run = seededRun();
    try {
      const written = writePrd(run.stateDir, run.artifactsDir, "docs/product-prd.md");
      assert.ok(written.ok);
      assert.deepEqual(validateProductPrdDocument(run), { ok: true, issues: [] });
    } finally {
      rmSync(run.stateDir, { recursive: true, force: true });
    }
  }

  // stale source: a source artifact changed after the PRD was rendered
  {
    const run = seededRun();
    try {
      assert.ok(writePrd(run.stateDir, run.artifactsDir).ok);
      const spec = JSON.parse(readFileSync(join(run.artifactsDir, "product_spec.json"), "utf8")) as Record<string, unknown>;
      spec.open_decisions = ["changed after rendering"];
      writeFileSync(join(run.artifactsDir, "product_spec.json"), JSON.stringify(spec, null, 2));
      const verdict = validateProductPrdDocument(run);
      assert.equal(verdict.ok, false, "stale sources must block");
      assert.ok(verdict.issues.some((i) => /source|stale|product_spec/i.test(i)), "the issue names the stale source");
    } finally {
      rmSync(run.stateDir, { recursive: true, force: true });
    }
  }

  // stale content: the document file was edited after the write
  {
    const run = seededRun();
    try {
      const written = writePrd(run.stateDir, run.artifactsDir);
      assert.ok(written.ok);
      if (written.ok) {
        writeFileSync(written.documentPath, `${readFileSync(written.documentPath, "utf8")}\n<!-- edited -->\n`);
        const verdict = validateProductPrdDocument(run);
        assert.equal(verdict.ok, false, "edited document content must block");
        assert.ok(verdict.issues.some((i) => /content|hash|mismatch|modified|stale/i.test(i)));
      }
    } finally {
      rmSync(run.stateDir, { recursive: true, force: true });
    }
  }

  // sidecar mismatch: artifact content no longer matches its own content_hash
  {
    const run = seededRun();
    try {
      assert.ok(writePrd(run.stateDir, run.artifactsDir).ok);
      const artifactPath = join(run.artifactsDir, "product_prd.json");
      const manifest = JSON.parse(readFileSync(artifactPath, "utf8")) as Record<string, unknown>;
      manifest.content = `${manifest.content as string}\n<!-- tampered -->\n`;
      writeFileSync(artifactPath, JSON.stringify(manifest, null, 2));
      const verdict = validateProductPrdDocument(run);
      assert.equal(verdict.ok, false, "artifact content/content_hash disagreement must block");
      assert.ok(verdict.issues.some((i) => /hash|content|mismatch/i.test(i)));
    } finally {
      rmSync(run.stateDir, { recursive: true, force: true });
    }
  }

  // sidecar mismatch: a tampered content_hash field
  {
    const run = seededRun();
    try {
      assert.ok(writePrd(run.stateDir, run.artifactsDir).ok);
      const artifactPath = join(run.artifactsDir, "product_prd.json");
      const manifest = JSON.parse(readFileSync(artifactPath, "utf8")) as Record<string, unknown>;
      manifest.content_hash = "0".repeat(64);
      writeFileSync(artifactPath, JSON.stringify(manifest, null, 2));
      assert.equal(validateProductPrdDocument(run).ok, false, "a wrong content_hash must block");
    } finally {
      rmSync(run.stateDir, { recursive: true, force: true });
    }
  }

  // manifest shape violation: an extra field breaks the exact contract
  {
    const run = seededRun();
    try {
      assert.ok(writePrd(run.stateDir, run.artifactsDir).ok);
      const artifactPath = join(run.artifactsDir, "product_prd.json");
      const manifest = JSON.parse(readFileSync(artifactPath, "utf8")) as Record<string, unknown>;
      manifest.surprise = true;
      writeFileSync(artifactPath, JSON.stringify(manifest, null, 2));
      const verdict = validateProductPrdDocument(run);
      assert.equal(verdict.ok, false, "unexpected manifest fields must block");
      assert.ok(verdict.issues.some((i) => /field|schema|unknown|manifest/i.test(i)));
    } finally {
      rmSync(run.stateDir, { recursive: true, force: true });
    }
  }

  // missing artifact / missing document / symlinked document
  {
    const run = seededRun();
    try {
      const written = writePrd(run.stateDir, run.artifactsDir);
      assert.ok(written.ok);
      unlinkSync(join(run.artifactsDir, "product_prd.json"));
      const noArtifact = validateProductPrdDocument(run);
      assert.equal(noArtifact.ok, false);
      assert.ok(noArtifact.issues.some((i) => /product_prd|missing|artifact/i.test(i)));
    } finally {
      rmSync(run.stateDir, { recursive: true, force: true });
    }
  }
  {
    const run = seededRun();
    try {
      const written = writePrd(run.stateDir, run.artifactsDir);
      assert.ok(written.ok);
      if (written.ok) {
        rmSync(written.documentPath);
        const noDocument = validateProductPrdDocument(run);
        assert.equal(noDocument.ok, false);
        assert.ok(noDocument.issues.some((i) => /document|missing|file/i.test(i)));
      }
    } finally {
      rmSync(run.stateDir, { recursive: true, force: true });
    }
  }
  {
    const run = seededRun();
    const outside = mkdtempSync(join(tmpdir(), "omp-prd-outside-"));
    try {
      const written = writePrd(run.stateDir, run.artifactsDir);
      assert.ok(written.ok);
      if (written.ok) {
        const replacement = join(outside, "replacement.md");
        writeFileSync(replacement, readFileSync(written.documentPath, "utf8"));
        rmSync(written.documentPath);
        symlinkSync(replacement, written.documentPath);
        const verdict = validateProductPrdDocument(run);
        assert.equal(verdict.ok, false, "a symlinked document must never validate");
        assert.ok(verdict.issues.some((i) => /symlink|link/i.test(i)));
      }
    } finally {
      rmSync(run.stateDir, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  }
});

// ── profile stage order / consumes + artifact contract ─────────────────────

test("product-prd: product-discovery declares product_prd_document before approval, consuming the five sources", () => {
  const profile = loadAllProfiles().find((p) => p.name === "product-discovery");
  assert.ok(profile, "product-discovery profile is shipped");
  assert.deepEqual(
    profile.stages.map((s) => s.id),
    [
      "product_intake",
      "problem_framing",
      "evidence_and_alternatives",
      "product_critique",
      "product_synthesis",
      "product_prd_document",
      "product_approval",
      "product_handoff",
    ],
  );

  const docs = profile.stages.find((s) => s.id === "product_prd_document");
  assert.ok(docs);
  assert.equal(docs.type, "document", "the PRD renders through the executable document stage type");
  assert.deepEqual(
    docs.document,
    { format: "markdown", renderer: "product-prd", path: "documents/product-prd.md" },
    "the stage declares the exact shipped document contract",
  );
  assert.deepEqual(docs.consumes, [...SOURCE_ARTIFACT_IDS], "the PRD renders exactly the five source artifacts");
  assert.equal(docs.produces, "product_prd");
  const docsIndex = profile.stages.findIndex((s) => s.id === "product_prd_document");
  const approvalIndex = profile.stages.findIndex((s) => s.id === "product_approval");
  assert.ok(docsIndex >= 0 && approvalIndex >= 0 && docsIndex < approvalIndex, "the document exists before the owner approves");

  // profile-wide invariant: a stage may only consume artifacts an earlier stage produces
  const produced = new Set<string>();
  for (const stage of profile.stages) {
    for (const consumed of stage.consumes ?? []) {
      assert.ok(produced.has(consumed), `${stage.id} consumes '${consumed}' before any stage produces it`);
    }
    for (const artifact of typeof stage.produces === "string" ? [stage.produces] : stage.produces ?? []) {
      produced.add(artifact);
    }
  }
});


// ── executable document stage (runStage, type=document) ────────────────────

const PRD_DOCUMENT_STAGE: StageDef = {
  id: "product_prd_document",
  title: "Product PRD document",
  type: "document",
  document: { format: "markdown", renderer: "product-prd", path: "documents/product-prd.md" },
  consumes: [...SOURCE_ARTIFACT_IDS],
  produces: "product_prd",
};

/** StageContext whose task.call throws AND counts — the document stage must never dispatch. */
function stageContext(artifactsDir: string): { ctx: StageContext; taskCalls: () => number } {
  let calls = 0;
  const ctx: StageContext = {
    cwd: artifactsDir,
    state: {
      schema: 1,
      branch: "feat/product-discovery-workflow",
      classification: { type: "FEATURE", complexity: "COMPLEX", confidence: "HIGH", autonomous: false, workflow: "product-discovery" },
      task: "Render the deterministic product PRD document",
      workflow_override: false,
      issue: null,
      stage_cursor: PRD_DOCUMENT_STAGE.id,
      stages: [{ id: PRD_DOCUMENT_STAGE.id, status: "in_progress" }],
      artifacts: {},
      pause: { kind: "none", reason: "" },
      updated_at: new Date().toISOString(),
    },
    artifactsDir,
    flags: { scope: [], has_security: false, has_infra: false, has_ui: false, has_runtime: false, dev_agent: null },
    agent: (role) => `agent:${role}`,
    task: {
      call: async (args) => {
        calls += 1;
        throw new Error(`document stage must never dispatch an agent: ${args.agent}`);
      },
      batch: async () => {
        throw new Error("document stage must never batch-dispatch");
      },
    },
    pause: async () => undefined,
    log: () => undefined,
    resolveDevAgent: () => null,
  };
  return { ctx, taskCalls: () => calls };
}

/** Seeded run root with the five source artifacts persisted. */
function seededArtifactsRun(): { root: string; artifactsDir: string } {
  const root = mkdtempSync(join(tmpdir(), "omp-prd-run-"));
  const artifactsDir = join(root, "artifacts");
  mkdirSync(artifactsDir, { recursive: true });
  for (const [id, value] of Object.entries(validSources())) {
    writeFileSync(join(artifactsDir, `${id}.json`), JSON.stringify(value, null, 2));
  }
  return { root, artifactsDir };
}

test("product-prd: runStage executes the document stage deterministically with zero task dispatches", async () => {
  const { root, artifactsDir } = seededArtifactsRun();
  try {
    const { ctx, taskCalls } = stageContext(artifactsDir);
    const outcome = await runStage(PRD_DOCUMENT_STAGE, ctx);
    assert.equal(outcome.status, "done");
    assert.deepEqual(outcome.artifacts, ["product_prd"]);
    assert.equal(taskCalls(), 0, "the executable document stage never dispatches an agent");

    const documentPath = join(root, "documents", "product-prd.md");
    assert.ok(existsSync(documentPath), "the rendered document exists at the declared path");
    assert.ok(existsSync(join(artifactsDir, "product_prd.json")), "the typed product_prd artifact is written");
    assert.deepEqual(validateProductPrdDocument({ stateDir: root, artifactsDir }), { ok: true, issues: [] });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("product-prd: runStage fails closed when a source artifact is missing", async () => {
  const { root, artifactsDir } = seededArtifactsRun();
  try {
    unlinkSync(join(artifactsDir, "product_evidence.json"));
    const { ctx, taskCalls } = stageContext(artifactsDir);
    const outcome = await runStage(PRD_DOCUMENT_STAGE, ctx);
    assert.equal(outcome.status, "failed");
    assert.match(outcome.note ?? "", /product_evidence/);
    assert.equal(taskCalls(), 0, "no dispatch even on failure");
    assert.ok(!existsSync(join(artifactsDir, "product_prd.json")), "no artifact is written on failure");
    assert.ok(!existsSync(join(root, "documents")), "no document is written on failure");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("product-prd: tampering with the rendered document breaks validation", async () => {
  const { root, artifactsDir } = seededArtifactsRun();
  try {
    const { ctx } = stageContext(artifactsDir);
    const outcome = await runStage(PRD_DOCUMENT_STAGE, ctx);
    assert.equal(outcome.status, "done");
    const documentPath = join(root, "documents", "product-prd.md");
    writeFileSync(documentPath, `${readFileSync(documentPath, "utf8")}<!-- tampered -->\n`);
    const verdict = validateProductPrdDocument({ stateDir: root, artifactsDir });
    assert.equal(verdict.ok, false, "a tampered document must not validate");
    assert.ok(verdict.issues.some((issue) => /content|hash|mismatch|modified|stale/i.test(issue)));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});


// ── review blockers: symlinked dirs/files, torn persistence, exact shape ───

test("product-prd: writeProductPrdDocument rejects an artifacts dir symlinked outside the state dir", () => {
  const stateRoot = mkdtempSync(join(tmpdir(), "omp-prd-state-"));
  const outside = mkdtempSync(join(tmpdir(), "omp-prd-outside-"));
  try {
    mkdirSync(join(outside, "artifacts"));
    symlinkSync(join(outside, "artifacts"), join(stateRoot, "artifacts"));
    const written = writeProductPrdDocument({
      stateDir: stateRoot,
      artifactsDir: join(stateRoot, "artifacts"),
      path: "documents/product-prd.md",
      sourceArtifacts: validSources(),
    });
    assert.equal(written.ok, false, "a symlinked artifacts dir must be refused");
    if (!written.ok) assert.match(written.error, /artifacts dir|symlink|unsafe/i);
    assert.equal(readdirSync(join(outside, "artifacts")).length, 0, "nothing escaped through the symlink");
    assert.ok(!existsSync(join(stateRoot, "documents")), "no document was written");
  } finally {
    rmSync(stateRoot, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test("product-prd: validate rejects a symlinked product_prd manifest", () => {
  const run = seededRun();
  const outside = mkdtempSync(join(tmpdir(), "omp-prd-outside-"));
  try {
    const first = writePrd(run.stateDir, run.artifactsDir, "documents/product-prd.md");
    assert.ok(first.ok);
    const artifactPath = join(run.artifactsDir, "product_prd.json");
    const moved = join(outside, "product_prd.json");
    writeFileSync(moved, readFileSync(artifactPath, "utf8"));
    rmSync(artifactPath);
    symlinkSync(moved, artifactPath);
    const verdict = validateProductPrdDocument(run);
    assert.equal(verdict.ok, false, "a symlinked manifest must never validate");
    assert.ok(verdict.issues.some((issue) => /symlink/i.test(issue)));
  } finally {
    rmSync(run.stateDir, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test("product-prd: validate rejects a symlinked source artifact even with identical content", () => {
  const run = seededRun();
  const outside = mkdtempSync(join(tmpdir(), "omp-prd-outside-"));
  try {
    assert.ok(writePrd(run.stateDir, run.artifactsDir).ok);
    const sourcePath = join(run.artifactsDir, "product_spec.json");
    const copy = join(outside, "product_spec.json");
    writeFileSync(copy, readFileSync(sourcePath, "utf8"));
    rmSync(sourcePath);
    symlinkSync(copy, sourcePath);
    const verdict = validateProductPrdDocument(run);
    assert.equal(verdict.ok, false, "a symlinked source artifact must never validate");
    assert.ok(verdict.issues.some((issue) => /symlink/i.test(issue)));
  } finally {
    rmSync(run.stateDir, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test("product-prd: a failed manifest persistence leaves the previous document+manifest pair valid", () => {
  const run = seededRun();
  const sources: Record<string, unknown> = {};
  for (const id of SOURCE_ARTIFACT_IDS) {
    sources[id] = JSON.parse(readFileSync(join(run.artifactsDir, `${id}.json`), "utf8"));
  }
  const write = () =>
    writeProductPrdDocument({ stateDir: run.stateDir, artifactsDir: run.artifactsDir, path: "documents/product-prd.md", sourceArtifacts: sources });
  try {
    assert.ok(write().ok);
    assert.deepEqual(validateProductPrdDocument(run), { ok: true, issues: [] });

    // Break the artifacts side after the preexisting write (artifacts dir
    // occupied by a regular file): the follow-up write must be rejected
    // whole, before any byte is mutated.
    const intact = `${run.artifactsDir}.intact`;
    renameSync(run.artifactsDir, intact);
    writeFileSync(run.artifactsDir, "occupied");
    const second = write();
    assert.equal(second.ok, false, "the follow-up write must fail closed");
    if (!second.ok) assert.match(second.error, /artifacts dir|directory|unsafe/i);

    // Restore the intact artifacts dir: the previous pair still validates.
    rmSync(run.artifactsDir);
    renameSync(intact, run.artifactsDir);
    assert.deepEqual(validateProductPrdDocument(run), { ok: true, issues: [] });
  } finally {
    rmSync(run.stateDir, { recursive: true, force: true });
    rmSync(`${run.artifactsDir}.intact`, { recursive: true, force: true });
  }
});


test("product-prd: a mid-commit manifest rename failure rolls the document back and cleans temps", () => {
  const run = seededRun();
  const write = () => {
    const sources: Record<string, unknown> = {};
    for (const id of SOURCE_ARTIFACT_IDS) {
      sources[id] = JSON.parse(readFileSync(join(run.artifactsDir, `${id}.json`), "utf8"));
    }
    return writeProductPrdDocument({ stateDir: run.stateDir, artifactsDir: run.artifactsDir, path: "documents/product-prd.md", sourceArtifacts: sources });
  };
  try {
    const first = write();
    assert.ok(first.ok);
    const documentPath = join(run.stateDir, "documents", "product-prd.md");
    const firstDocument = readFileSync(documentPath, "utf8");

    // Change a source so the second render diverges, then break the manifest
    // commit: a directory at the manifest target makes the rename fail AFTER
    // the document rename already committed (the injection itself removes
    // the old artifact file, so pair-validity here is the document rollback
    // plus no-new-manifest; clean preflight failures keep the whole pair,
    // covered by the artifactsDir-as-file test above).
    const specPath = join(run.artifactsDir, "product_spec.json");
    const spec = JSON.parse(readFileSync(specPath, "utf8")) as Record<string, unknown>;
    spec.open_decisions = ["changed for the second render"];
    writeFileSync(specPath, JSON.stringify(spec, null, 2));
    const manifestPath = join(run.artifactsDir, "product_prd.json");
    rmSync(manifestPath);
    mkdirSync(manifestPath);

    const second = write();
    assert.equal(second.ok, false, "the mid-commit write must fail");
    if (!second.ok) assert.match(second.error, /persistence failed|rollback/i);
    assert.equal(readFileSync(documentPath, "utf8"), firstDocument, "the previous document content is restored byte-for-byte");
    assert.ok(existsSync(manifestPath), "no new manifest was committed over the broken target");
    assert.equal(
      readdirSync(join(run.stateDir, "documents")).filter((name) => name.includes(".tmp-")).length,
      0,
      "no document temp files are left behind",
    );
    assert.equal(
      readdirSync(run.artifactsDir).filter((name) => name.includes(".tmp-")).length,
      0,
      "no manifest temp files are left behind",
    );
  } finally {
    rmSync(run.stateDir, { recursive: true, force: true });
  }
});

test("product-prd: an absent artifacts dir behind a symlinked ancestor is rejected without outside writes", () => {
  const stateRoot = mkdtempSync(join(tmpdir(), "omp-prd-state-"));
  const outside = mkdtempSync(join(tmpdir(), "omp-prd-outside-"));
  try {
    mkdirSync(join(outside, "target"));
    symlinkSync(join(outside, "target"), join(stateRoot, "link"));
    const written = writeProductPrdDocument({
      stateDir: stateRoot,
      artifactsDir: join(stateRoot, "link", "artifacts"),
      path: "documents/product-prd.md",
      sourceArtifacts: validSources(),
    });
    assert.equal(written.ok, false, "an artifacts dir behind a symlinked ancestor must be refused");
    if (!written.ok) assert.match(written.error, /artifacts dir|symlink|unsafe/i);
    assert.equal(readdirSync(join(outside, "target")).length, 0, "the recursive create never materialized through the symlink");
    assert.ok(!existsSync(join(stateRoot, "documents")), "nothing was written on the state side either");
  } finally {
    rmSync(stateRoot, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test("product-prd: a reordered manifest source_artifacts list is rejected", () => {
  const run = seededRun();
  try {
    assert.ok(writePrd(run.stateDir, run.artifactsDir).ok);
    const manifestPath = join(run.artifactsDir, "product_prd.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as Record<string, unknown>;
    manifest.source_artifacts = [...SOURCE_ARTIFACT_IDS].reverse();
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
    const verdict = validateProductPrdDocument(run);
    assert.equal(verdict.ok, false, "a reordered source list must never validate");
    assert.ok(
      verdict.issues.some((issue) => /source_artifacts.*in order|in order/i.test(issue)),
      "the issue names the exact-order source_artifacts contract",
    );
  } finally {
    rmSync(run.stateDir, { recursive: true, force: true });
  }
});

test("product-prd: product_prd is a schema-registered artifact contract", () => {
  assert.ok(artifactSchemaFor("product_prd"), "product_prd has a schema definition");
  const required = requiredFieldsOf("product_prd") ?? [];
  assert.ok(required.includes("content_hash"), "content_hash is required");
  assert.ok(required.includes("content"), "content is required");

  const valid = validateProducedArtifact("product_prd", {
    type: "product_prd",
    format: "markdown",
    renderer: "product-prd-renderer@1",
    path: "docs/product-prd.md",
    source_artifacts: [...SOURCE_ARTIFACT_IDS],
    source_hash: "a".repeat(64),
    content_hash: "b".repeat(64),
    content: "# Product PRD\n",
  });
  assert.deepEqual(valid, { ok: true });

  const missing = validateProducedArtifact("product_prd", { type: "product_prd" });
  assert.equal(missing.ok, false, "a product_prd artifact without the manifest fields blocks the stage");

  const extra = validateProducedArtifact("product_prd", {
    type: "product_prd",
    format: "markdown",
    renderer: "product-prd-renderer@1",
    path: "docs/product-prd.md",
    source_artifacts: [...SOURCE_ARTIFACT_IDS],
    source_hash: "a".repeat(64),
    content_hash: "b".repeat(64),
    content: "# Product PRD\n",
    surprise: true,
  });
  assert.equal(extra.ok, false, "an extra manifest field violates the exact product_prd contract");
  if (!extra.ok) {
    assert.ok(extra.issues.some((issue) => /surprise|unknown field/i.test(issue.message)));
  }
});
