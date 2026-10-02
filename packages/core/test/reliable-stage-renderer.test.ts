import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs, {
  existsSync,
  readFileSync,
} from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
import { recordScenarioEvent, scenarioTest } from "./reliable-stage-trace.js";
import {
  BRANCH,
  createCoreFixture,
  details,
  ordinaryIngress,
  requireTool,
  submission,
  type Harness,
} from "./reliable-stage-execution-fixture.js";
import { loadAllProfiles } from "../src/engine/profile.js";
import { readRunState, runTarget } from "../src/engine/run-store.js";
import type { Profile } from "../src/engine/types.js";

const SOURCE_IDS = [
  "product_intake",
  "product_framing",
  "product_evidence",
  "product_critique",
  "product_spec",
] as const;

/**
 * Independent source data oracle.  These values are submitted through the
 * registered coordinator assignment; the test never writes canonical artifact
 * files or state to set up the renderer stage.
 */
const SOURCE_ARTIFACTS: Record<string, unknown> = {
  product_intake: {
    problem_statements: ["Product owners need a reviewable direction document."],
    contexts: ["The registered product-discovery workflow emits five source artifacts."],
    stakeholders: ["product owner", "platform lead"],
    constraints: ["No application code changes are part of discovery."],
    open_questions: ["unknown"],
    evidence: [{ claim: "The renderer must preserve explicit unknowns.", status: "verified", source: "renderer acceptance oracle" }],
  },
  product_framing: {
    problem_restatement: "Product direction needs a deterministic, tamper-evident document.",
    target_users: ["product owners", "platform leads"],
    success_criteria: ["Identical source artifacts produce identical Markdown bytes."],
    non_goals: ["Implementation planning"],
    assumptions: ["The five source artifacts are schema-valid."],
  },
  product_evidence: {
    evidence: [{ claim: "A content hash detects a post-render edit.", status: "verified", source: "renderer acceptance oracle" }],
    alternatives: [{ id: "manual", summary: "Manual PRD authoring", pros: [], cons: ["Not reproducible"] }],
    gaps: ["TBD"],
  },
  product_critique: {
    verdict: "proceed",
    findings: ["The renderer must reject stale or modified output."],
    blocking_gaps: [],
  },
  product_spec: {
    recommendation: "proceed",
    value_proposition: "Deterministic PRDs give product owners a reviewable document.",
    opportunity: "A stable document makes the product direction easy to inspect.",
    target_users: ["product owners", "platform leads"],
    solution_direction: "Render the five source artifacts into deterministic Markdown.",
    success_metrics: ["Identical source artifacts render byte-identical Markdown."],
    guardrail_metrics: ["No application code is changed by discovery."],
    scope: ["Deterministic renderer", "Typed product_prd artifact"],
    anti_scope: ["Implementation planning", "Architecture decisions"],
    risks: ["Template drift without hash verification."],
    validation_plan: [],
    evidence_trace: ["claim: deterministic rendering — status: verified — source: renderer acceptance oracle"],
    open_decisions: ["unknown"],
  },
};

const PRODUCT_PROFILE = loadAllProfiles().find((profile) => profile.name === "product-discovery");
if (!PRODUCT_PROFILE) throw new Error("product-discovery profile is required by renderer acceptance");
const SHIPPED_DOCUMENT_STAGE = PRODUCT_PROFILE.stages.find((stage) => stage.id === "product_prd_document");
if (!SHIPPED_DOCUMENT_STAGE) throw new Error("product-discovery product_prd_document stage is required by renderer acceptance");

/** The profile keeps the shipped document declaration and isolates only its legitimate upstream producer. */
const RENDERER_PROFILE: Profile = {
  ...PRODUCT_PROFILE,
  name: "reliable-product-prd-renderer",
  match: { type: ["FEATURE"], complexity: ["QUICK"] },
  stages: [
    {
      id: "registered_product_sources",
      title: "Registered product source submission",
      type: "orchestrator",
      produces: [...SOURCE_IDS],
      prompt: "Submit the five schema-valid product-discovery source artifacts through workflow_submit_result.",
    },
    structuredClone(SHIPPED_DOCUMENT_STAGE),
  ],
};

// Frozen byte oracles generated independently from SOURCE_ARTIFACTS and the
// shipped renderer output. Runtime assertions never call the renderer to
// manufacture their own expected values.
const EXPECTED_SOURCE_HASH = "01b70e0e33cf3469c1b759e198d17d946ff903349c70a1ae1dd01003208c8ccc";
const EXPECTED_CONTENT_HASH = "69f11541bc1e9935c4600203921cf21930ebc46e2ef8ea1bea46cef5d568d78c";

function sha256(bytes: string | Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function recordOf(value: unknown, label: string): Record<string, unknown> {
  const result = details(value);
  assert.ok(!Array.isArray(result), `${label} must be an object`);
  return result;
}

function handoffOf(value: unknown, label: string): Record<string, unknown> {
  const handoff = recordOf(value, label);
  for (const field of ["advance_token", "capability_id", "run_key", "stage_cursor", "cursor_epoch", "loop_iteration"]) {
    assert.ok(field in handoff, `${label} must carry ${field}`);
  }
  return handoff;
}

function advanceInput(handoff: Record<string, unknown>, workflow: string): Record<string, unknown> {
  return {
    token: handoff.advance_token,
    capability_id: handoff.capability_id,
    run_key: handoff.run_key,
    branch: BRANCH,
    workflow,
    profile_hash: handoff.profile_hash,
    stage_cursor: handoff.stage_cursor,
    cursor_epoch: handoff.cursor_epoch,
    loop_iteration: handoff.loop_iteration,
    evidence: "registered source producer receipt accepted",
  };
}

type LifecycleRecord = {
  transaction_id: string;
  status: string;
  after: Record<string, unknown>;
};


/** Capture the actual renderer lifecycle commit marker before the writer removes it. */
async function captureRendererTransaction<T>(action: () => Promise<T>): Promise<{ result: T; lifecycle?: LifecycleRecord }> {
  const originalRename = fs.renameSync;
  let lifecycle: LifecycleRecord | undefined;
  fs.renameSync = ((source, destination): void => {
    const destinationPath = String(destination);
    if (destinationPath.includes("/.work-state/lifecycle-transactions/") && destinationPath.endsWith("/transaction.json")) {
      try {
        const candidate = JSON.parse(readFileSync(String(source), "utf8")) as LifecycleRecord;
        const paths = Object.keys(candidate.after ?? {});
        if (candidate.status === "committing" && paths.some((path) => /documents\/product-prd\.(md|html)$/.test(path))) {
          lifecycle = candidate;
        }
      } catch {
        // Ignore unrelated lifecycle writes; the renderer transaction is selected above.
      }
    }
    originalRename(source, destination);
  }) as typeof fs.renameSync;
  syncBuiltinESMExports();
  try {
    return { result: await action(), lifecycle };
  } finally {
    fs.renameSync = originalRename;
    syncBuiltinESMExports();
  }
}

function persistedRendererReceipt(harness: Harness, runId: string): Record<string, unknown> {
  const state = readRunState(harness.root, runId);
  assert.ok(state, "canonical ordinary state must remain readable");
  const receipts = Object.values(state.stage_receipts ?? {}) as unknown[];
  const matches = receipts.filter((entry) => {
    const binding = recordOf(recordOf(entry, "receipt").binding, "receipt binding");
    const producer = recordOf(binding.producer, "receipt producer");
    return producer.kind === "tool" && producer.tool_name === "product-prd";
  });
  assert.equal(matches.length, 1, "the renderer must publish exactly one private producer receipt");
  return recordOf(matches[0], "renderer receipt");
}

scenarioTest("[O:S17][O:A15] registered product PRD renderer atomically publishes deterministic bytes and rejects generic impersonation", async () => {
  const harness = createCoreFixture({ route: "ordinary", workflowProfiles: [RENDERER_PROFILE] });
  try {
    const { runId, handoff: sourceHandoff } = await ordinaryIngress(harness, {
      task: "render the registered product PRD",
      classification: {
        type: "FEATURE",
        complexity: "QUICK",
        confidence: "HIGH",
        autonomous: false,
        workflow: RENDERER_PROFILE.name,
      },
    });
    assert.equal(sourceHandoff.stage_cursor, "registered_product_sources");

    const sourceSubmission = details((await requireTool(harness, "workflow_submit_result").execute(
      "renderer-o-s17-source-submit",
      submission(SOURCE_ARTIFACTS),
      undefined,
      undefined,
      harness.context,
    )).details);
    assert.equal(sourceSubmission.ok, true, JSON.stringify(sourceSubmission));
    const sourceReceipt = recordOf(sourceSubmission.receipt, "source receipt");
    const sourceProducer = recordOf(recordOf(sourceReceipt.binding, "source binding").producer, "source producer");
    assert.equal(sourceProducer.kind, "orchestrator", JSON.stringify(sourceReceipt));
    assert.deepEqual(
      (sourceReceipt.outputs as Array<Record<string, unknown>>).map((output) => output.artifact_id).sort(),
      [...SOURCE_IDS].sort(),
      "the upstream producer receipt must cover every document input",
    );
    const sourceArtifactRoot = runTarget(harness.root, runId).artifactsDir;
    for (const output of sourceReceipt.outputs as Array<Record<string, unknown>>) {
      const artifactId = String(output.artifact_id);
      const immutableRef = String(output.immutable_ref);
      assert.deepEqual(
        JSON.parse(readFileSync(join(sourceArtifactRoot, immutableRef), "utf8")),
        SOURCE_ARTIFACTS[artifactId],
        `source receipt immutable bytes must preserve ${artifactId}`,
      );
    }

    const advance = details((await requireTool(harness, "workflow_advance").execute(
      "renderer-o-s17-source-advance",
      advanceInput(sourceHandoff, RENDERER_PROFILE.name),
      undefined,
      undefined,
      harness.context,
    )).details);
    assert.equal(advance.ok, true, JSON.stringify(advance));
    const documentHandoff = handoffOf(advance.handoff, "document handoff");
    assert.equal(documentHandoff.stage_cursor, "product_prd_document");

    // A generic model/tool call cannot impersonate the private renderer, even
    // while the declared document stage is current and its payload claims the
    // matching renderer tool name. No publication is attempted.
    const fakeSubmission = details((await requireTool(harness, "workflow_submit_result").execute(
      "renderer-o-s17-generic-impersonation",
      submission({ product_prd: { type: "product_prd", renderer: "product-prd" } }),
      undefined,
      undefined,
      harness.context,
    )).details);
    assert.equal(fakeSubmission.ok, false, JSON.stringify(fakeSubmission));
    const target = runTarget(harness.root, runId);
    assert.equal(existsSync(join(target.artifactsDir, "product_prd.json")), false, "generic impersonation must not publish a manifest");
    assert.equal(existsSync(join(harness.root, ".work-state", "runs", runId, "documents", "product-prd.md")), false, "generic impersonation must not publish Markdown");
    recordScenarioEvent({ kind: "fault_observed", route: "O", faultPoint: "ownership", identities: { run: runId, stage: "product_prd_document" }, outcome: "REJECTED" });

    const begun = await captureRendererTransaction(async () => requireTool(harness, "workflow_begin").execute(
      "renderer-o-s17-document-begin",
      {},
      undefined,
      undefined,
      harness.context,
    ));
    const beginDetails = details(begun.result.details);
    assert.equal(beginDetails.ok, true, JSON.stringify(beginDetails));
    const documentBeginHandoff = handoffOf(beginDetails.handoff, "document begin handoff");
    assert.equal(documentBeginHandoff.stage_cursor, "product_prd_document");
    const receipt = persistedRendererReceipt(harness, runId);
    const binding = recordOf(receipt.binding, "renderer receipt binding");
    const producer = recordOf(binding.producer, "renderer receipt producer");
    assert.equal(producer.kind, "tool", JSON.stringify(receipt));
    assert.equal(producer.tool_name, "product-prd", JSON.stringify(receipt));
    assert.equal(recordOf(binding.identity, "renderer identity").stage_id, "product_prd_document");

    const artifactsDir = target.artifactsDir;
    const manifestPath = join(artifactsDir, "product_prd.json");
    const markdownPath = join(harness.root, ".work-state", "runs", runId, "documents", "product-prd.md");
    const htmlPath = join(harness.root, ".work-state", "runs", runId, "documents", "product-prd.html");
    const rendered = recordOf(beginDetails.renderer, "registered renderer result");
    assert.equal(rendered.ok, true, JSON.stringify(rendered));
    assert.equal(rendered.stage_id, "product_prd_document");
    assert.equal(rendered.document_path, markdownPath);
    assert.equal(rendered.html_document_path, htmlPath);
    assert.equal(recordOf(rendered.receipt, "registered renderer receipt").receipt_id, receipt.receipt_id);
    assert.ok(existsSync(manifestPath), "renderer must publish the typed manifest");
    assert.ok(existsSync(markdownPath), "renderer must publish Markdown");
    assert.ok(existsSync(htmlPath), "renderer must publish HTML");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as Record<string, unknown>;
    const markdown = readFileSync(markdownPath, "utf8");
    const html = readFileSync(htmlPath, "utf8");
    assert.deepEqual(Object.keys(manifest).sort(), ["content", "content_hash", "format", "path", "renderer", "source_artifacts", "source_hash", "type"]);
    assert.equal(manifest.type, "product_prd");
    assert.equal(manifest.format, "markdown");
    assert.equal(manifest.renderer, "product-prd-renderer@2");
    assert.equal(manifest.path, "documents/product-prd.md");
    assert.deepEqual(manifest.source_artifacts, [...SOURCE_IDS]);
    assert.equal(manifest.content, markdown);
    assert.equal(manifest.content_hash, EXPECTED_CONTENT_HASH);
    assert.equal(manifest.source_hash, EXPECTED_SOURCE_HASH);
    assert.equal(sha256(markdown), EXPECTED_CONTENT_HASH, "content hash is an independent byte oracle");
    assert.equal(html.includes('class="markdown-toc"'), true, "HTML is the shipped Markdown viewer output");
    assert.equal(html.includes('id="executive-summary"'), true, "HTML preserves deterministic heading anchors");
    assert.match(markdown, /unknown/, "explicit unknown source content remains visible");
    assert.match(markdown, /TBD/, "explicit TBD source content remains visible");

    const lifecycle = begun.lifecycle;
    assert.ok(lifecycle, "renderer must commit through a lifecycle transaction");
    const lifecyclePaths = Object.keys(lifecycle.after);
    assert.ok(lifecyclePaths.some((path) => path.endsWith(`/runs/${runId}/state.json`)), "receipt state is in the renderer transaction");
    const lifecycleMarkdown = lifecyclePaths.find((path) => path.endsWith("documents/product-prd.md"));
    const lifecycleHtml = lifecyclePaths.find((path) => path.endsWith("documents/product-prd.html"));
    assert.ok(lifecycleMarkdown && lifecycleHtml, "Markdown and HTML are in the renderer transaction after-image");
    assert.equal(lifecycle.after[lifecycleMarkdown], markdown);
    assert.equal(lifecycle.after[lifecycleHtml], html);
    const transactionStatePath = lifecyclePaths.find((path) => path.endsWith(`/runs/${runId}/state.json`));
    assert.ok(transactionStatePath);
    const transactionState = JSON.parse(String(lifecycle.after[transactionStatePath])) as Record<string, unknown>;
    const transactionReceipts = recordOf(transactionState.stage_receipts, "transaction receipt ledger");
    assert.ok(Object.values(transactionReceipts).some((entry) => recordOf(entry, "transaction receipt").receipt_id === receipt.receipt_id), "receipt and sidecars share the transaction after-image");
    const lifecycleManifest = lifecyclePaths.find((path) => path.endsWith("/artifacts/product_prd.json"));
    assert.ok(lifecycleManifest, "typed manifest is in the renderer transaction after-image");
    assert.equal(lifecycle.after[lifecycleManifest], readFileSync(manifestPath, "utf8"), "manifest bytes are in the same transaction after-image");
    const transactionManifest = JSON.parse(String(lifecycle.after[lifecycleManifest])) as Record<string, unknown>;
    assert.equal(transactionManifest.content_hash, EXPECTED_CONTENT_HASH);
    assert.equal(transactionManifest.source_hash, EXPECTED_SOURCE_HASH);
    recordScenarioEvent({
      kind: "stage_exited",
      workflow: RENDERER_PROFILE.name,
      identities: { run: runId, stage: "product_prd_document", receipt: String(receipt.receipt_id) },
      links: { stage_of: runId, dispatch_of: String(receipt.receipt_id) },
      outcome: "PASS",
      verdict: "PASS",
    });
  } finally {
    await harness.close();
  }
});
