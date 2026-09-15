/**
 * Failing contract for the shared constitution prerequisite (T007).
 *
 * Canonical APIs under contract:
 *
 *   `packages/core/src/specification/constitution-provider.ts` (T019)
 *     - registerConstitutionProvider / resetConstitutionProviders
 *     - resolveConstitutionProvider(projectRoot, options) — deterministic
 *       precedence: explicit `constitution.path` override → exactly one
 *       discovered registered provider → native `CONSTITUTION.md` default;
 *       local metadata/file inspection only (no CLI, no network)
 *
 *   `packages/core/src/gates/constitution.ts` (T019)
 *     - evaluateConstitutionUsability(document) — pure fail-closed usability
 *
 *   `packages/core/src/specification/prerequisite.ts` (T020)
 *     - ensureProjectConstitution(projectRoot, origin) — idempotent gate
 *       record with exact origin descriptor and resume target
 *     - presentConstitutionDraft / decideConstitutionCheckpoint — the
 *       two-decision bootstrap (`approve_continue` | `request_changes`)
 *       with trusted-proof binding and an exactly-once resume marker
 *
 *   `packages/core/src/specification/constitution-impact.ts` (T021)
 *     - assessConstitutionImpact(projectRoot, input) — artifact-scoped
 *       `affected` / `no_impact` over exact binding fingerprints with
 *       dependency-closure staleness
 *
 * Behavioral contracts pinned here:
 *   - native default resolves even when no constitution file exists;
 *   - explicit override wins when valid; unsafe override paths fail closed;
 *   - exactly one discovered provider beats the native default; several
 *     existing candidates block as SPEC_CONSTITUTION_SOURCE_AMBIGUOUS
 *     regardless of registration order;
 *   - usability: missing/empty/whitespace, unresolved template markers, and
 *     structurally invalid documents require the bootstrap; warnings and
 *     version differences stay usable;
 *   - bootstrap opens exactly two decisions, requires a trusted proof plus
 *     non-empty feedback for request_changes, never accepts approve_stop,
 *     consumes the resume marker exactly once, and resumes the exact origin
 *     (`specify` for native origins, `compatibility_validation` for imports);
 *   - a changed binding is assessed per artifact; formatting-only changes
 *     stay no-impact only with equal semantic-section hashes; unprovable
 *     impact blocks; identical inputs produce one identical assessment.
 */

import { z } from "zod";
import { TEST_CONTEXT, TEST_ON } from "./fixtures/registrar-host.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sha256, bindFeatureWorkspaceToRoot, validConstitutionBinding, validFeatureWorkspace } from "./fixtures/specification-fixtures.js";
import { evaluateConstitutionUsability } from "../src/gates/constitution.js";
import { registerTestConstitutionProvider, writeTestRegistryMarker } from "./fixtures/registry-activation.js";
import {
  resolveConstitutionProvider,
} from "../src/specification/constitution-provider.js";
import {
  decideConstitutionCheckpoint,
  ensureProjectConstitution,
  presentConstitutionDraft,
  readConstitutionGateEnvelopePinned,
  recordConstitutionCheckpointAnswer,
  validateConstitutionCheckpointAsk,
  type ConstitutionDecisionInput,
} from "../src/specification/prerequisite.js";
import { PinnedProjectRoot } from "../src/specification/pinned-root.js";
import { bindWorkspaceConstitution, createFeatureWorkspace, persistFeatureWorkspace, resolveFeatureWorkspace } from "../src/specification/workspace.js";
import {
  assessConstitutionImpact,
  type ConstitutionImpactResult,
} from "../src/specification/constitution-impact.js";
import { createCapability } from "../src/engine/durable.js";
import { issueTrustedCheckpointAnswerCapability, recordTrustedCheckpointAnswer, registerTrustedCheckpointHostBridge } from "../src/engine/checkpoints.js";
import { loadProfile, profileHash, resolveProfileControlPlane } from "../src/engine/profile.js";
import { renderConstitutionToolContract } from "../src/commands/constitution.js";
import { resolveState, setStateTransactionTestHooks, writeState } from "../src/engine/state.js";
import { digestOf } from "../src/specification/validation.js";
import { readPinnedCurrentConstitution } from "../src/specification/constitution-identities.js";
import type { TeamState } from "../src/engine/types.js";

const TEST_CHECKPOINT_BRIDGE = Object.freeze({});
registerTrustedCheckpointHostBridge(TEST_CHECKPOINT_BRIDGE);

const VALID_CONSTITUTION = [
  "# Project Constitution",
  "",
  "Version: 1.0.0",
  "",
  "## I. Quality",
  "",
  "Every change ships with behavioral tests.",
  "",
].join("\n");

const VALID_CONSTITUTION_REVISED = [
  "# Project Constitution",
  "",
  "Version: 1.1.0",
  "",
  "## I. Quality",
  "",
  "Every change ships with behavioral tests.",
  "",
  "## II. Security",
  "",
  "Secrets never enter persisted artifacts.",
  "",
].join("\n");

function makeProject(): string {
  return mkdtempSync(join(tmpdir(), "spec-constitution-"));
}

function writeConstitution(root: string, content: string, relativePath = "CONSTITUTION.md"): string {
  const absolute = join(root, relativePath);
  mkdirSync(join(absolute, ".."), { recursive: true });
  writeFileSync(absolute, content, "utf8");
  return absolute;
}

const FEATURE_ID = "constitution-feature";
const RUN_KEY = "run-origin-1";
const ORIGIN_STAGE = "specify";
const EXTERNAL_ORIGIN_STAGE = "compatibility";

type DecisionOriginKind = "native_direct" | "external_import";

interface DecisionOriginProfile {
  workflow: "spec-preparation" | "spec-import";
  stage: "specify" | "compatibility";
  source_kind: "native" | "external";
}

function decisionOrigin(originKind: DecisionOriginKind): DecisionOriginProfile {
  return originKind === "external_import"
    ? { workflow: "spec-import", stage: EXTERNAL_ORIGIN_STAGE, source_kind: "external" }
    : { workflow: "spec-preparation", stage: ORIGIN_STAGE, source_kind: "native" };
}

function shippedProfile(name: "spec-preparation" | "spec-import" | "constitution") {
  const profile = loadProfile(name);
  assert.ok(profile, `the shipped ${name} profile is available`);
  return profile;
}

function constitutionBootstrapPolicy(checkpointId: string) {
  const profile = shippedProfile("constitution");
  const projection = resolveProfileControlPlane(profile, "constitution_validate");
  assert.ok(projection.checkpoint_policy, "the constitution validation stage declares a checkpoint policy");
  assert.ok(projection.checkpoint_rule, "the constitution validation stage declares a checkpoint rule");
  if (!projection.checkpoint_policy || !projection.checkpoint_rule) {
    throw new Error("the shipped constitution validation control plane is incomplete");
  }
  return {
    ...projection.checkpoint_policy,
    hard_human: [...projection.checkpoint_policy.hard_human],
    rules: { [checkpointId]: { ...projection.checkpoint_rule } },
  };
}

function originProfile(originKind: DecisionOriginKind) {
  const origin = decisionOrigin(originKind);
  const profile = shippedProfile(origin.workflow);
  const stage = profile.stages.find((candidate) => candidate.id === origin.stage);
  assert.ok(stage, `the shipped ${origin.workflow} profile declares ${origin.stage}`);
  assert.equal(stage?.type, "single", `${origin.workflow}/${origin.stage} is a single-worker stage`);
  assert.ok(stage?.role, `${origin.workflow}/${origin.stage} declares a worker role`);
  if (!stage || stage.type !== "single" || !stage.role) {
    throw new Error(`the shipped ${origin.workflow}/${origin.stage} roster is incomplete`);
  }
  return { ...origin, profile, stageDef: stage, hash: profileHash(profile) };
}

function workspaceSelector(): { feature_id: string; run_key: string } {
  return { feature_id: FEATURE_ID, run_key: RUN_KEY };
}

function checkpointState(
  root: string,
  checkpointId: string,
  originKind: DecisionOriginKind = "native_direct",
  selector: { feature_id: string; run_key: string } = workspaceSelector(),
): TeamState {
  const origin = originProfile(originKind);
  const stageIndex = origin.profile.stages.findIndex((candidate) => candidate.id === origin.stage);
  assert.notEqual(stageIndex, -1, `${origin.workflow} stage cursor is present in the shipped profile`);
  const issued = createCapability({
    run_key: selector.run_key,
    branch: "constitution-test",
    workflow: origin.workflow,
    profile_hash: origin.hash,
    stage_cursor: origin.stage,
    kind: "single",
    expected_roster: [{ role: origin.stageDef.role, agent: origin.stageDef.role }],
  });
  const specification = {
    ...bindFeatureWorkspaceToRoot(validFeatureWorkspace({
      featureId: selector.feature_id,
      sourceKind: origin.source_kind,
      constitutionBinding: null,
    }), root),
    profile_name: origin.workflow,
    profile_hash: origin.hash,
    constitution_gate_ref: checkpointId,
    ...(origin.source_kind === "external" ? { import_ref: `spec-import:${selector.feature_id}` } : {}),
  } as TeamState["specification"];
  return {
    schema: 1,
    branch: "constitution-test",
    run_key: selector.run_key,
    classification: {
      type: "SPEC",
      complexity: "MEDIUM",
      confidence: "HIGH",
      autonomous: false,
      workflow: origin.workflow,
    },
    task: "constitution checkpoint test",
    workflow_override: false,
    checkpoint_policy: constitutionBootstrapPolicy(checkpointId),
    issue: null,
    stage_cursor: origin.stage,
    stages: origin.profile.stages.map((stage, index) => ({
      id: stage.id,
      status: (index < stageIndex ? "done" : index === stageIndex ? "in_progress" : "pending") as TeamState["stages"][number]["status"],
    })),
    artifacts: {},
    pause: { kind: "none", reason: "" },
    profile_hash: origin.hash,
    cursor_epoch: issued.state.issued_for!.cursor_epoch,
    dispatch_capability: issued.state,
    specification,
    updated_at: new Date().toISOString(),
  };
}

function writeDecisionWorkspace(root: string, state: TeamState): void {
  const featureId = state.specification?.feature_id;
  if (!featureId) throw new Error("constitution test state requires a feature workspace identity");
  mkdirSync(join(root, "specs", featureId), { recursive: true });
  writeState(root, state, { featureSlug: featureId });
}

function seedDecisionWorkspace(root: string, originKind: DecisionOriginKind = "native_direct"): void {
  writeDecisionWorkspace(root, checkpointState(root, "constitution-bootstrap-pending", originKind));
}

function seedFreshNativeWorkspace(root: string, featureId = FEATURE_ID, runKey = RUN_KEY): void {
  const created = createFeatureWorkspace(root, {
    feature_id: featureId,
    display_name: "Fresh native constitution workspace",
    run_key: runKey,
    profile_name: "spec-preparation",
    profile_hash: "constitution-test-profile",
  });
  assert.ok(created.ok, created.ok ? "fresh native workspace created" : created.error);
}

function approveGateDraft(root: string, explicitPath?: string): { checkpointId: string; decision: ConstitutionDecisionInput } {
  seedFreshNativeWorkspace(root);
  const ensured = ensureProjectConstitution(root, { origin_kind: "native_direct", origin_run_key: RUN_KEY, origin_stage: ORIGIN_STAGE }, { feature_id: FEATURE_ID, explicit_path: explicitPath });
  assert.ok(ensured.ok, ensured.ok ? "constitution gate ensured" : ensured.error);
  if (!ensured.ok) throw new Error(ensured.error);
  const presented = presentConstitutionDraft(root, { ...workspaceSelector(), gate_id: ensured.value.gate_id, document: VALID_CONSTITUTION });
  assert.ok(presented.ok, presented.ok ? "constitution draft presented" : presented.error);
  if (!presented.ok || !presented.value.checkpoint_ref) throw new Error("constitution draft checkpoint is missing");
  const answered = recordConstitutionCheckpointAnswer(root, {
    ...workspaceSelector(),
    gate_id: ensured.value.gate_id,
    checkpoint_id: presented.value.checkpoint_ref,
    draft_sha256: sha256(VALID_CONSTITUTION),
    decision: "approve_continue",
  });
  assert.ok(answered.ok, answered.ok ? "constitution answer recorded" : answered.error);
  if (!answered.ok) throw new Error(answered.error);
  return {
    checkpointId: presented.value.checkpoint_ref,
    decision: {
      ...workspaceSelector(),
      gate_id: ensured.value.gate_id,
      checkpoint_id: presented.value.checkpoint_ref,
      decision: "approve_continue",
      authorization: "human",
      actor_provenance: { kind: "user", ref: answered.value.answer.reference, proof: answered.value.proof },
    },
  };
}

function trustedDecision(
  root: string,
  checkpointId: string,
  decision: "approve_continue" | "request_changes",
  answerId = `constitution-answer/${checkpointId}/${decision}`,
  feedback = decision === "request_changes" ? "Add a security principle before approval." : undefined,
): Pick<ConstitutionDecisionInput, "feature_id" | "run_key" | "authorization" | "actor_provenance"> & { feedback?: string } {
  const selector = workspaceSelector();
  const selected = resolveState(root, undefined, selector);
  const state = selected.state;
  if (selected.invalid || !state || !selected.statePath || !selected.stateDir || !selected.artifactsDir) {
    throw new Error("constitution test requires the exact persisted decision workspace");
  }
  if (!state.checkpoint_policy || !state.specification) {
    throw new Error("constitution test decision workspace lacks checkpoint context");
  }

  const workflow = state.classification.workflow;
  const originKind: DecisionOriginKind = workflow === "spec-import" ? "external_import" : "native_direct";
  const origin = decisionOrigin(originKind);
  assert.equal(state.stage_cursor, origin.stage, "trusted answers use the profile stage bound to the persisted origin workflow");
  const answerState: TeamState = {
    ...state,
    checkpoint_policy: constitutionBootstrapPolicy(checkpointId),
    specification: { ...state.specification, constitution_gate_ref: checkpointId },
  };
  const reference = `terminal-answer/${answerId}`;
  const pinnedRoot = PinnedProjectRoot.open(root);
  assert.ok(pinnedRoot, "constitution checkpoint fixture root must pin");
  if (!pinnedRoot) throw new Error("constitution checkpoint fixture root is unavailable");
  if (!answerState.profile_hash) {
    pinnedRoot.close();
    throw new Error("constitution checkpoint fixture profile is unavailable");
  }
  try {
    const rootIdentity = { canonical_root: pinnedRoot.canonical_root, dev: pinnedRoot.dev, ino: pinnedRoot.ino };
    const capability = issueTrustedCheckpointAnswerCapability(TEST_CHECKPOINT_BRIDGE, {
      root: rootIdentity,
      state: answerState,
      answer_id: answerId,
      channel: "terminal",
      reference,
      stage_id: origin.stage,
      checkpoint_id: checkpointId,
      decision,
      question: "Authorize the constitution fixture checkpoint",
      options: [decision],
      session_id: "constitution-test-session",
      actor_ref: reference,
      feature_id: selector.feature_id,
      profile_hash: answerState.profile_hash,
    });
    const trusted = recordTrustedCheckpointAnswer(answerState, {
      answer_id: answerId,
      channel: "terminal",
      reference,
      stage_id: origin.stage,
      checkpoint_id: checkpointId,
      decision,
      feature_id: selector.feature_id,
      ...(feedback !== undefined ? { feedback } : {}),
    }, { capability, root: rootIdentity });
    writeState(root, trusted.state, { target: selected });

  const persisted = resolveState(root, undefined, selector);
  const persistedAnswer = persisted.state?.trusted_checkpoint_answers?.find(
    (answer) => answer.answer_id === trusted.answer.answer_id,
  );
  assert.deepEqual(persistedAnswer, trusted.answer, "the returned trusted answer is persisted without recreation or mutation");
  assert.deepEqual(trusted.proof, {
    answer_id: persistedAnswer!.answer_id,
    nonce: persistedAnswer!.nonce,
    channel: persistedAnswer!.channel,
    reference: persistedAnswer!.reference,
    binding: persistedAnswer!.binding,
    ...(persistedAnswer!.feedback !== undefined ? { feedback: persistedAnswer!.feedback } : {}),
  }, "the caller receives the exact proof projected from the persisted trusted answer");

    return {
      ...selector,
      authorization: "human",
      ...(feedback !== undefined ? { feedback } : {}),
      actor_provenance: { kind: "user", ref: trusted.answer.reference, proof: trusted.proof },
    };
  } finally {
    pinnedRoot.close();
  }
}

// Darwin descriptor helpers start a bounded interpreter per operation. The
// measured full-core contender path is 14–20s under load; 60s leaves room for
// scheduling contention while still failing a deadlock deterministically.
const CONSTITUTION_CHILD_TIMEOUT_MS = 60_000;

interface ConstitutionDecisionChild {
  promise: Promise<Record<string, unknown>>;
  ready: Promise<void>;
  release: () => void;
  cleanup: () => void;
}

type ConstitutionChildOperation = "decision" | "presentation";

function runConstitutionOperationInChild(
  root: string,
  input: object,
  operation: ConstitutionChildOperation,
  barrier = false,
): ConstitutionDecisionChild {
  // Each child loads the same TypeScript module independently to exercise the cross-process lock.
  const moduleUrl = new URL("../src/specification/prerequisite.ts", import.meta.url).href;
  const script = [
    "async function main() {",
    "  try {",
    `    const mod = await import(${JSON.stringify(moduleUrl)});`,
    ...(barrier ? [
      "    process.stdout.write(JSON.stringify({ type: \"ready\" }) + \"\\n\");",
      "    await new Promise((resolve, reject) => {",
      "      let buffer = \"\";",
      "      const onData = (chunk) => {",
      "        buffer += String(chunk);",
      "        if (!buffer.includes(\"\\n\")) return;",
      "        process.stdin.off(\"data\", onData);",
      "        process.stdin.off(\"end\", onEnd);",
      "        resolve();",
      "      };",
      "      const onEnd = () => {",
      "        process.stdin.off(\"data\", onData);",
      "        process.stdin.off(\"end\", onEnd);",
      "        reject(new Error(\"parent closed the barrier before release\"));",
      "      };",
      "      process.stdin.setEncoding(\"utf8\");",
      "      process.stdin.on(\"data\", onData);",
      "      process.stdin.once(\"end\", onEnd);",
      "      process.stdin.resume();",
      "    });",
    ] : []),
    `    const result = mod.${operation === "decision" ? "decideConstitutionCheckpoint" : "presentConstitutionDraft"}(process.env.PROJECT_ROOT, JSON.parse(process.env.CHILD_INPUT));`,
    "    process.stdout.write(JSON.stringify({ type: \"result\", value: result }) + \"\\n\");",
    "  } catch (error) {",
    "    const detail = error instanceof Error ? error.stack ?? error.message : String(error);",
    "    process.stderr.write(`constitution decision child failed: ${detail}\\n`);",
    "    process.exitCode = 1;",
    "  }",
    "}",
    "void main();",
  ].join("\n");
  const { promise, resolve, reject } = Promise.withResolvers<Record<string, unknown>>();
  const { promise: ready, resolve: readyResolve, reject: readyReject } = Promise.withResolvers<void>();
  const child = spawn(process.execPath, [...process.execArgv, "--input-type=module", "-e", script], {
    cwd: process.cwd(),
    env: { ...process.env, PROJECT_ROOT: root, CHILD_INPUT: JSON.stringify(input) },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  let protocolBuffer = "";
  let readySignalled = !barrier;
  let result: Record<string, unknown> | null = null;
  let released = !barrier;
  let failed = false;
  let settled = false;
  let cleaned = false;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let cleanup: () => void = () => undefined;

  if (!barrier) readyResolve();

  const diagnostics = (): string => `stdout=${JSON.stringify(stdout)} stderr=${JSON.stringify(stderr)}`;
  const fail = (error: Error): void => {
    if (failed || settled) return;
    failed = true;
    settled = true;
    if (!readySignalled) readyReject(error);
    reject(error);
    cleanup();
  };
  const consumeMessage = (line: string): void => {
    if (!line.trim() || failed || settled) return;
    let message: unknown;
    try {
      message = JSON.parse(line);
    } catch (error) {
      fail(new Error(`constitution decision child emitted invalid protocol JSON: ${String(error)} (${diagnostics()})`));
      return;
    }
    if (!message || typeof message !== "object") {
      fail(new Error(`constitution decision child emitted a non-object protocol message (${diagnostics()})`));
      return;
    }
    const record = message as Record<string, unknown>;
    if (record.type === "ready") {
      if (readySignalled) {
        fail(new Error(`constitution decision child emitted duplicate readiness (${diagnostics()})`));
        return;
      }
      readySignalled = true;
      readyResolve();
      return;
    }
    if (record.type === "result") {
      if (!readySignalled || result !== null) {
        fail(new Error(`constitution decision child emitted an out-of-order result (${diagnostics()})`));
        return;
      }
      const value = record.value;
      if (!value || typeof value !== "object" || Array.isArray(value)) {
        fail(new Error(`constitution decision child emitted an invalid result payload (${diagnostics()})`));
        return;
      }
      result = value as Record<string, unknown>;
      return;
    }
    fail(new Error(`constitution decision child emitted an unknown protocol message (${diagnostics()})`));
  };
  const consumeOutput = (chunk: unknown): void => {
    const text = String(chunk);
    stdout += text;
    protocolBuffer += text;
    for (;;) {
      const newline = protocolBuffer.indexOf("\n");
      if (newline < 0) return;
      const line = protocolBuffer.slice(0, newline);
      protocolBuffer = protocolBuffer.slice(newline + 1);
      consumeMessage(line);
    }
  };
  cleanup = (): void => {
    if (cleaned) return;
    cleaned = true;
    if (timeout) clearTimeout(timeout);
    if (!settled) {
      settled = true;
      const error = new Error(`constitution decision child was cleaned up before completion (${diagnostics()})`);
      if (!readySignalled) readyReject(error);
      reject(error);
    }
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    child.stdin.destroy();
    child.stdout.destroy();
    child.stderr.destroy();
  };

  // Install all listeners synchronously before either parent release; pipe buffering
  // preserves readiness while each child completes module setup.
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", consumeOutput);
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: unknown) => { stderr += String(chunk); });
  child.stdin.on("error", (error: Error) => {
    if (!cleaned) fail(new Error(`constitution decision child stdin failed: ${error.message} (${diagnostics()})`));
  });
  child.on("error", (error) => fail(new Error(`constitution decision child process failed: ${error.message} (${diagnostics()})`)));
  child.on("close", (code, signal) => {
    if (failed || settled) return;
    if (protocolBuffer.trim()) consumeMessage(protocolBuffer.trim());
    if (failed || settled) return;
    if (code !== 0 || signal !== null) {
      fail(new Error(`constitution decision child exited code=${String(code)} signal=${String(signal)} (${diagnostics()})`));
      return;
    }
    if (!readySignalled) {
      fail(new Error(`constitution decision child exited before readiness (${diagnostics()})`));
      return;
    }
    if (!result) {
      fail(new Error(`constitution decision child exited without a structured result (${diagnostics()})`));
      return;
    }
    settled = true;
    if (timeout) clearTimeout(timeout);
    resolve(result);
  });

  timeout = setTimeout(() => {
    fail(new Error(`constitution decision child timed out after ${CONSTITUTION_CHILD_TIMEOUT_MS}ms (${diagnostics()})`));
  }, CONSTITUTION_CHILD_TIMEOUT_MS);
  const release = (): void => {
    if (released || failed || settled) return;
    released = true;
    try {
      child.stdin.end("release\n");
    } catch (error) {
      fail(new Error(`constitution decision child barrier release failed: ${String(error)} (${diagnostics()})`));
    }
  };
  return { promise, ready, release, cleanup };
}


function runConstitutionDecisionInChild(
  root: string,
  input: ConstitutionDecisionInput,
  barrier = false,
): ConstitutionDecisionChild {
  return runConstitutionOperationInChild(root, input, "decision", barrier);
}

function runConstitutionPresentationInChild(
  root: string,
  input: { gate_id: string; feature_id: string; run_key: string; document: string },
  barrier = false,
): ConstitutionDecisionChild {
  return runConstitutionOperationInChild(root, input, "presentation", barrier);
}


function originDescriptor(originKind: DecisionOriginKind = "native_direct"): Record<string, unknown> {
  const origin = decisionOrigin(originKind);
  return { origin_kind: originKind, origin_run_key: RUN_KEY, origin_stage: origin.stage };
}

// ── Native default resolution ────────────────────────────────────────────────

test("with no providers and no override the native CONSTITUTION.md default resolves", () => {
  const root = makeProject();
  try {
    const selection = resolveConstitutionProvider(root);
    assert.ok(selection.ok, `native default must always resolve: ${selection.ok ? "" : selection.error}`);
    if (!selection.ok) return;
    assert.equal(selection.value.source, "native_default");
    assert.equal(selection.value.provider_id, "native");
    assert.equal(selection.value.path, "CONSTITUTION.md");
    assert.match(String(selection.value.selection_hash), /^[a-f0-9]{64}$/, "the selection is fingerprinted");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ── Explicit override precedence ─────────────────────────────────────────────


test("a valid explicit constitution.path override wins over discovered providers", () => {
  const root = makeProject();
  try {
    writeConstitution(root, VALID_CONSTITUTION, "policy/constitution.md");
    writeConstitution(root, VALID_CONSTITUTION, "docs/constitution.md");
    writeTestRegistryMarker(root);
    registerTestConstitutionProvider(root, {
      provider_id: "docs-provider",
      discover: () => ["docs/constitution.md"],
    });
    const selection = resolveConstitutionProvider(root, { explicit_path: "policy/constitution.md" });
    assert.ok(selection.ok);
    if (!selection.ok) return;
    assert.equal(selection.value.source, "explicit_override");
    assert.equal(selection.value.path, "policy/constitution.md");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});


test("an unsafe explicit override path fails closed with SPEC_PATH_UNAUTHORIZED", () => {
  const root = makeProject();
  try {
    const selection = resolveConstitutionProvider(root, { explicit_path: "../../outside.md" });
    assert.equal(selection.ok, false);
    if (!selection.ok) assert.equal(selection.code, "SPEC_PATH_UNAUTHORIZED");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ── Discovered provider precedence and ambiguity ─────────────────────────────


test("exactly one discovered provider beats the native default; missing paths fall through", () => {
  const root = makeProject();
  try {
    writeConstitution(root, VALID_CONSTITUTION, ".specify/memory/constitution.md");
    writeTestRegistryMarker(root);
    registerTestConstitutionProvider(root, {
      provider_id: "speckit",
      discover: () => [".specify/memory/constitution.md"],
    });
    const selection = resolveConstitutionProvider(root);
    assert.ok(selection.ok);
    if (!selection.ok) return;
    assert.equal(selection.value.source, "discovered_provider");
    assert.equal(selection.value.provider_id, "speckit");
    assert.equal(selection.value.path, ".specify/memory/constitution.md");

    const emptyProject = makeProject();
    try {
      const fallthrough = resolveConstitutionProvider(emptyProject);
      assert.ok(fallthrough.ok);
      if (fallthrough.ok) {
        assert.equal(fallthrough.value.source, "native_default", "a provider without existing files is ignored");
      }
    } finally {
      rmSync(emptyProject, { recursive: true, force: true });
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});


test("provider candidate revoked and trap proxies fail as typed discovery errors", () => {
  const revokedRoot = makeProject();
  const trappedRoot = makeProject();
  try {
    writeTestRegistryMarker(revokedRoot);
    const revoked = Proxy.revocable(["CONSTITUTION.md"], {});
    revoked.revoke();
    registerTestConstitutionProvider(revokedRoot, {
      provider_id: "revoked-candidates",
      discover: () => revoked.proxy,
    });
    let revokedResult: ReturnType<typeof resolveConstitutionProvider> | undefined;
    assert.doesNotThrow(() => { revokedResult = resolveConstitutionProvider(revokedRoot); });
    assert.equal(revokedResult?.ok, false);
    if (revokedResult && !revokedResult.ok) assert.equal(revokedResult.code, "SPEC_CONSTITUTION_DISCOVERY_FAILED");

    writeTestRegistryMarker(trappedRoot);
    const trapped = new Proxy(["CONSTITUTION.md"], {
      getPrototypeOf() { throw new Error("prototype trap"); },
    });
    registerTestConstitutionProvider(trappedRoot, {
      provider_id: "trapped-candidates",
      discover: () => trapped,
    });
    let trappedResult: ReturnType<typeof resolveConstitutionProvider> | undefined;
    assert.doesNotThrow(() => { trappedResult = resolveConstitutionProvider(trappedRoot); });
    assert.equal(trappedResult?.ok, false);
    if (trappedResult && !trappedResult.ok) assert.equal(trappedResult.code, "SPEC_CONSTITUTION_DISCOVERY_FAILED");
  } finally {
    rmSync(revokedRoot, { recursive: true, force: true });
    rmSync(trappedRoot, { recursive: true, force: true });
  }
});

test("several existing provider candidates block as ambiguous regardless of registration order", () => {
  const firstRoot = makeProject();
  const secondRoot = makeProject();
  try {
    for (const root of [firstRoot, secondRoot]) {
      writeConstitution(root, VALID_CONSTITUTION, ".specify/memory/constitution.md");
      writeConstitution(root, VALID_CONSTITUTION, "openspec/constitution.md");
    }
    const candidates = [
      { provider_id: "speckit-forward", discover: () => [".specify/memory/constitution.md"] },
      { provider_id: "openspec-forward", discover: () => ["openspec/constitution.md"] },
    ];
    writeTestRegistryMarker(firstRoot);
    registerTestConstitutionProvider(firstRoot, candidates[0]!, "constitution-forward");
    registerTestConstitutionProvider(firstRoot, candidates[1]!, "constitution-forward");
    const forward = resolveConstitutionProvider(firstRoot);
    assert.equal(forward.ok, false, "multiple existing candidates must not silently select");
    if (!forward.ok) assert.equal(forward.code, "SPEC_CONSTITUTION_SOURCE_AMBIGUOUS");

    const reverseCandidates = [
      { provider_id: "openspec-reverse", discover: () => ["openspec/constitution.md"] },
      { provider_id: "speckit-reverse", discover: () => [".specify/memory/constitution.md"] },
    ];
    writeTestRegistryMarker(secondRoot);
    registerTestConstitutionProvider(secondRoot, reverseCandidates[0]!, "constitution-reverse");
    registerTestConstitutionProvider(secondRoot, reverseCandidates[1]!, "constitution-reverse");
    const reverse = resolveConstitutionProvider(secondRoot);
    assert.equal(reverse.ok, false, "registration order must not decide the winner");
    if (!reverse.ok) assert.equal(reverse.code, "SPEC_CONSTITUTION_SOURCE_AMBIGUOUS");
  } finally {
    rmSync(firstRoot, { recursive: true, force: true });
    rmSync(secondRoot, { recursive: true, force: true });
  }
});

// ── Deterministic usability ──────────────────────────────────────────────────


test("usability classifies missing, empty, unresolved-marker, and invalid documents as required", () => {
  const missing = evaluateConstitutionUsability(null);
  assert.equal(missing.status, "constitution_required");
  assert.ok(missing.reason && missing.reason.length > 0);

  for (const unusable of ["", "   \n\t", "{{CONSTITUTION_CONTENT}}", "just a stray sentence with no structure"]) {
    const result = evaluateConstitutionUsability(unusable);
    assert.equal(result.status, "constitution_required", `content ${JSON.stringify(unusable)} must require bootstrap`);
    assert.ok(result.reason && result.reason.length > 0, "every blocking classification carries a reason");
  }
});


test("usable documents pass without a checkpoint; warnings never block", () => {
  const usable = evaluateConstitutionUsability(VALID_CONSTITUTION);
  assert.equal(usable.status, "usable");
  assert.deepEqual(usable.warnings, []);

  const withoutVersion = VALID_CONSTITUTION.replace("Version: 1.0.0\n\n", "");
  const warned = evaluateConstitutionUsability(withoutVersion);
  assert.equal(warned.status, "usable", "a missing version label is a warning, not a structural failure");
  assert.ok(warned.warnings.length > 0, "the warning is visible");
});

// ── Idempotent prerequisite and exact resume ─────────────────────────────────


test("a usable constitution binds and resumes without opening any checkpoint", () => {
  const root = makeProject();
  try {
    writeConstitution(root, VALID_CONSTITUTION);
    const ensured = ensureProjectConstitution(root, originDescriptor());
    assert.ok(ensured.ok, ensured.ok ? "ensured" : `rejected: ${ensured.error}`);
    if (!ensured.ok) return;
    const record = ensured.value as Record<string, unknown>;
    assert.equal(record.status, "usable");
    const binding = record.binding as Record<string, unknown> | null;
    assert.ok(binding, "a usable constitution binds immediately");
    if (binding) {
      assert.equal(binding.content_sha256, sha256(VALID_CONSTITUTION), "the binding fingerprints the exact bytes");
    }
    assert.equal(record.checkpoint_ref ?? null, null, "no checkpoint for a usable constitution");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});


test("a forged usable binding with unusable matching-hash bytes reopens native correction", () => {
  const root = makeProject();
  try {
    writeConstitution(root, VALID_CONSTITUTION);
    const initial = ensureProjectConstitution(root, originDescriptor());
    assert.ok(initial.ok && initial.value.binding);
    if (!initial.ok || !initial.value.binding) return;
    const unusable = "{{CONSTITUTION_CONTENT}}";
    writeConstitution(root, unusable);
    const digest = sha256(unusable);
    const gatePath = join(root, ".work-state", "specification", "constitution", "gate.json");
    const forged = JSON.parse(readFileSync(gatePath, "utf8")) as Record<string, any>;
    const binding = forged.gate.binding as Record<string, unknown>;
    binding.content_sha256 = digest;
    binding.validation_ref = `constitution.validation.${digest}`;
    forged.gate.status = "usable";
    forged.gate.usability_result = "usable";
    writeFileSync(gatePath, JSON.stringify(forged, null, 2) + "\n", "utf8");
    const result = ensureProjectConstitution(root, originDescriptor());
    assert.equal(result.ok, true, result.ok ? "forged unusable binding was reclassified" : result.error);
    if (result.ok) {
      assert.equal(result.value.status, "constitution_required");
      assert.equal(result.value.binding, null);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});


test("persisted constitution gate rejects missing, extra, malformed, inconsistent, and forged fields", () => {
  const mutations: Array<[string, (gate: Record<string, any>) => void]> = [
    ["missing outer gate id", gate => { delete gate.gate_id; }],
    ["extra gate field", gate => { gate.gate.extra = true; }],
    ["malformed status", gate => { gate.gate.status = "not-a-status"; }],
    ["inconsistent approval status", gate => { gate.gate.status = "approved"; gate.gate.binding = null; }],
    ["forged evidence digest", gate => { gate.gate.binding.validation_ref = `constitution.validation.${"a".repeat(64)}`; }],
    ["forged provider provenance", gate => { gate.gate.provider.provider_id = "foreign-provider"; }],
    ["malformed binding digest", gate => { gate.gate.binding.content_sha256 = "not-a-digest"; }],
  ];
  for (const [label, mutate] of mutations) {
    const root = makeProject();
    try {
      writeConstitution(root, VALID_CONSTITUTION);
      const initial = ensureProjectConstitution(root, originDescriptor());
      assert.ok(initial.ok, `${label}: initial gate`);
      if (!initial.ok) continue;
      const gatePath = join(root, ".work-state", "specification", "constitution", "gate.json");
      const gate = JSON.parse(readFileSync(gatePath, "utf8")) as Record<string, any>;
      mutate(gate);
      writeFileSync(gatePath, JSON.stringify(gate, null, 2) + "\n", "utf8");
      const result = ensureProjectConstitution(root, originDescriptor());
      assert.equal(result.ok, false, `${label}: forged gate must fail closed`);
      if (!result.ok) assert.equal(result.code, "SPEC_STATE_INVALID", label);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
});


test("constitution gate bounded collections reject max-plus-one and oversized draft payloads before lookup", () => {
  const digest = sha256(VALID_CONSTITUTION);
  const draft = (version: number, document = VALID_CONSTITUTION) => ({
    version,
    document,
    document_sha256: sha256(document),
    validation_ref: `constitution.validation.${sha256(document)}`,
    presented_at: new Date().toISOString(),
  });
  const decision = {
    checkpoint_id: "checkpoint",
    decision: "approve_continue",
    feedback: null,
    authorization: "human",
    actor_provenance: { kind: "user", ref: "terminal" },
    at: new Date().toISOString(),
  };
  const answer = {
    answer_id: "answer",
    nonce: "nonce",
    channel: "terminal",
    reference: "terminal",
    run_id: RUN_KEY,
    stage_id: ORIGIN_STAGE,
    checkpoint_id: "checkpoint",
    work_identity_hash: "work",
    capability_id: "capability",
    capability_epoch: "epoch",
    policy_hash: "policy",
    decision: "approve_continue",
    binding: "binding",
    issued_at: new Date().toISOString(),
    gate_id: "gate",
    draft_sha256: digest,
  };
  const mutations: Array<[string, (gate: Record<string, any>) => void]> = [
    ["draft max-plus-one", gate => { gate.drafts = Array.from({ length: 26 }, (_, index) => draft(index + 1)); }],
    ["decision max-plus-one", gate => { gate.decisions = Array.from({ length: 101 }, () => decision); }],
    ["trusted answer max-plus-one", gate => { gate.trusted_answers = Array.from({ length: 101 }, () => answer); }],
    ["draft field oversize", gate => { gate.drafts = [draft(1, "x".repeat(512 * 1024 + 1))]; }],
  ];
  for (const [label, mutate] of mutations) {
    const root = makeProject();
    try {
      writeConstitution(root, VALID_CONSTITUTION);
      const initial = ensureProjectConstitution(root, originDescriptor());
      assert.ok(initial.ok, `${label}: initial gate`);
      if (!initial.ok) continue;
      const gatePath = join(root, ".work-state", "specification", "constitution", "gate.json");
      const gate = JSON.parse(readFileSync(gatePath, "utf8")) as Record<string, any>;
      mutate(gate);
      writeFileSync(gatePath, JSON.stringify(gate), "utf8");
      const result = ensureProjectConstitution(root, originDescriptor());
      assert.equal(result.ok, false, `${label}: bounded gate must fail closed`);
      if (!result.ok) assert.equal(result.code, "SPEC_STATE_INVALID", label);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
});


test("gate envelope reads at its durable cap and rejects cap-plus-one without overwriting", () => {
  const root = makeProject();
  const maxGateBytes = 2 * 1024 * 1024;
  const maxDraftBytes = 512 * 1024;
  const gatePath = join(root, ".work-state", "specification", "constitution", "gate.json");
  const serializedBytes = (value: unknown): number => Buffer.byteLength(JSON.stringify(value, null, 2) + "\n", "utf8");
  try {
    writeConstitution(root, VALID_CONSTITUTION);
    const initial = ensureProjectConstitution(root, originDescriptor());
    assert.ok(initial.ok, initial.ok ? "initial gate persisted" : initial.error);
    if (!initial.ok) return;

    const envelope = JSON.parse(readFileSync(gatePath, "utf8")) as Record<string, any>;
    envelope.origin.origin_run_key = "x";
    envelope.gate.origin_run_key = "x";
    envelope.gate.status = "blocked";
    envelope.drafts = Array.from({ length: 4 }, (_, index) => {
      const document = "x".repeat(490_000);
      const digest = sha256(document);
      return {
        version: index + 1,
        document,
        document_sha256: digest,
        validation_ref: `constitution.validation.${digest}`,
        presented_at: new Date().toISOString(),
      };
    });
    const targetBytes = maxGateBytes - 1;
    for (const draft of envelope.drafts as Array<Record<string, any>>) {
      const available = maxDraftBytes - Buffer.byteLength(draft.document, "utf8");
      const additional = Math.min(targetBytes - serializedBytes(envelope), available);
      if (additional > 0) {
        draft.document += "x".repeat(additional);
        draft.document_sha256 = sha256(draft.document);
        draft.validation_ref = `constitution.validation.${draft.document_sha256}`;
      }
    }
    assert.equal(serializedBytes(envelope), targetBytes, "fixture must be one byte below the shared durable cap");
    writeFileSync(gatePath, JSON.stringify(envelope, null, 2) + "\n", "utf8");
    assert.equal(readFileSync(gatePath).byteLength, targetBytes);
    const pinnedRoot = PinnedProjectRoot.open(root);
    assert.ok(pinnedRoot, "the near-cap test root must be pinnable");
    if (!pinnedRoot) return;
    try {
      const readable = readConstitutionGateEnvelopePinned(pinnedRoot);
      assert.equal(readable.ok, true, readable.ok ? "an envelope below the shared durable cap remains readable" : readable.error);
      if (readable.ok) assert.ok(readable.value);
    } finally {
      pinnedRoot.close();
    }
    writeConstitution(root, VALID_CONSTITUTION_REVISED);
    assert.equal(readFileSync(gatePath).byteLength, targetBytes, "reading the near-cap envelope does not rewrite it");

    const beforeOversizedWrite = readFileSync(gatePath);
    const oversized = ensureProjectConstitution(root, {
      origin_kind: "native_direct",
      origin_run_key: "xx",
      origin_stage: "specify",
    });
    assert.equal(oversized.ok, false, "a mutation that serializes over the cap must fail");
    if (!oversized.ok) assert.equal(oversized.code, "SPEC_INPUT_OVERSIZED");
    assert.deepEqual(readFileSync(gatePath), beforeOversizedWrite, "oversize rejection must not overwrite the prior gate envelope");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});


test("draft presentation rejects a root swap during pinned state classification without writing", () => {
  const root = makeProject();
  const displaced = `${root}-displaced`;
  const originalReadFile = PinnedProjectRoot.prototype.readFile;
  let swapped = false;
  try {
    const ensured = ensureProjectConstitution(root, originDescriptor("native_direct"));
    assert.ok(ensured.ok, ensured.ok ? "constitution gate created" : `rejected: ${ensured.error}`);
    if (!ensured.ok) return;
    const gateId = (ensured.value as Record<string, unknown>).gate_id as string;
    const gateDir = join(root, ".work-state", "specification", "constitution");
    const beforeFiles = readdirSync(gateDir).sort();

    PinnedProjectRoot.prototype.readFile = function(
      this: PinnedProjectRoot,
      relativeFile: string,
      options: { maxBytes?: number } = {},
    ) {
      let result;
      try {
        result = originalReadFile.call(this, relativeFile, options);
      } finally {
        if (!swapped) {
          swapped = true;
          renameSync(root, displaced);
          mkdirSync(root);
        }
      }
      return result;
    };

    const presented = presentConstitutionDraft(root, {
      ...workspaceSelector(),
      gate_id: gateId,
      document: VALID_CONSTITUTION,
    });
    assert.equal(presented.ok, false, "a root identity swap during classification must fail closed");
    if (!presented.ok) assert.equal(presented.code, "SPEC_PATH_UNAUTHORIZED");
    assert.deepEqual(readdirSync(join(displaced, ".work-state", "specification", "constitution")).sort(), beforeFiles, "classification must not write draft evidence or gate state");
  } finally {
    PinnedProjectRoot.prototype.readFile = originalReadFile;
    rmSync(root, { recursive: true, force: true });
    rmSync(displaced, { recursive: true, force: true });
  }
});


test("bootstrap opens exactly two decisions and approve_continue resumes the exact native origin once", () => {
  const root = makeProject();
  try {
    const ensured = ensureProjectConstitution(root, originDescriptor("native_direct"));
    assert.ok(ensured.ok);
    if (!ensured.ok) return;
    const gateRecord = ensured.value as Record<string, unknown>;
    assert.equal(gateRecord.status, "constitution_required", "a missing constitution blocks the origin");
    assert.equal(
      gateRecord.origin_stage,
      ORIGIN_STAGE,
      "the gate preserves the exact valid current stage from the native origin",
    );
    const gateId = gateRecord.gate_id as string;
    seedDecisionWorkspace(root);

    const callerPresentation = {
      ...workspaceSelector(),
      gate_id: gateId,
      document: VALID_CONSTITUTION,
      validation_ref: "caller.validation.nonexistent",
    };
    const presented = presentConstitutionDraft(root, callerPresentation);
    assert.ok(presented.ok, presented.ok ? "draft validated" : `rejected: ${presented.error}`);
    if (!presented.ok) return;
    const draftRecord = presented.value as Record<string, unknown>;
    assert.equal(draftRecord.status, "awaiting_approval");
    assert.ok(draftRecord.checkpoint_ref, "a passing draft opens the approval checkpoint");
    assert.deepEqual(draftRecord.allowed_decisions, ["approve_continue", "request_changes"]);
    const documentDigest = sha256(VALID_CONSTITUTION);
    const evidencePath = join(
      root,
      ".work-state",
      "specification",
      "constitution",
      "validation-" + documentDigest + ".json",
    );
    const evidence = JSON.parse(readFileSync(evidencePath, "utf8")) as Record<string, unknown>;
    assert.equal(evidence.document_sha256, documentDigest, "engine evidence hashes the exact presented bytes");
    assert.equal(evidence.result, "usable");
    assert.equal(evidence.validator, "constitution-usability@1");
    assert.equal(evidence.ref, "constitution.validation." + documentDigest);
    assert.notEqual(evidence.ref, callerPresentation.validation_ref, "the caller cannot choose the evidence reference");
    const checkpointId = draftRecord.checkpoint_ref as string;
    const trustedApproval = trustedDecision(root, checkpointId, "approve_continue");

    const withoutProof = decideConstitutionCheckpoint(root, {
      ...workspaceSelector(),
      gate_id: gateId,
      checkpoint_id: checkpointId,
      decision: "approve_continue",
      authorization: "human",
      actor_provenance: { kind: "user", ref: "terminal-answer/missing" },
    });
    assert.equal(withoutProof.ok, false, "no decision without a trusted answer proof");

    const approveStop = decideConstitutionCheckpoint(root, {
      ...trustedApproval,
      gate_id: gateId,
      checkpoint_id: checkpointId,
      decision: "approve_stop",
    });
    assert.equal(approveStop.ok, false, "the three-decision phase contract does not apply to bootstrap");

    const approved = decideConstitutionCheckpoint(root, {
      ...trustedApproval,
      gate_id: gateId,
      checkpoint_id: checkpointId,
      decision: "approve_continue",
    });
    assert.ok(approved.ok, approved.ok ? "approved" : `rejected: ${approved.error}`);
    if (!approved.ok) return;
    const approvedRecord = approved.value as Record<string, unknown>;
    const binding = approvedRecord.binding as Record<string, unknown> | null;
    assert.ok(binding, "approval fingerprints the approved constitution");
    if (binding) {
      assert.equal(binding.content_sha256, sha256(VALID_CONSTITUTION));
      assert.equal(binding.validation_ref, evidence.ref, "approval binds only the verified engine evidence");
      assert.notEqual(binding.validation_ref, callerPresentation.validation_ref);
    }
    assert.deepEqual(
      approvedRecord.resume,
      { origin_kind: "native_direct", origin_run_key: RUN_KEY, resume_target: "specify" },
      "an arbitrary valid native gate stage cannot override the normative Specify resume target",
    );
    const consumedBeforeReplay = JSON.parse(readFileSync(join(root, ".work-state", "features", FEATURE_ID, "state.json"), "utf8")) as TeamState;
    const consumedAt = consumedBeforeReplay.trusted_checkpoint_answers?.[0]?.consumed_at;
    assert.ok(consumedAt, "the engine-owned answer ledger records idempotent consumption");

    const replay = decideConstitutionCheckpoint(root, {
      ...trustedApproval,
      gate_id: gateId,
      checkpoint_id: checkpointId,
      decision: "approve_continue",
    });
    assert.ok(replay.ok, "an idempotent replay returns the established result");
    if (replay.ok) {
      assert.equal(
        (replay.value as Record<string, unknown>).resume_consumed,
        true,
        "the resume marker stays consumed on replay",
      );
    }
    const consumedAfterReplay = JSON.parse(readFileSync(join(root, ".work-state", "features", FEATURE_ID, "state.json"), "utf8")) as TeamState;
    assert.equal(consumedAfterReplay.trusted_checkpoint_answers?.[0]?.consumed_at, consumedAt, "replay does not consume the answer twice");

    const resumed = ensureProjectConstitution(root, originDescriptor("native_direct"));
    assert.ok(resumed.ok);
    if (resumed.ok) {
      const resumedRecord = resumed.value as Record<string, unknown>;
      assert.equal(resumedRecord.status, "usable", "after approval the prerequisite is usable");
      assert.equal(resumedRecord.checkpoint_ref ?? null, null, "no second checkpoint may open");
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("gate-owned approval binds only the exact fresh native origin workspace", () => {
  const root = makeProject();
  try {
    seedFreshNativeWorkspace(root);
    const ensured = ensureProjectConstitution(root, { origin_kind: "native_direct", origin_run_key: RUN_KEY, origin_stage: ORIGIN_STAGE }, { feature_id: FEATURE_ID });
    assert.ok(ensured.ok);
    if (!ensured.ok) return;
    const presented = presentConstitutionDraft(root, {
      ...workspaceSelector(),
      gate_id: ensured.value.gate_id,
      document: VALID_CONSTITUTION,
    });
    assert.ok(presented.ok);
    if (!presented.ok || !presented.value.checkpoint_ref) return;
    const answered = recordConstitutionCheckpointAnswer(root, {
      ...workspaceSelector(),
      gate_id: ensured.value.gate_id,
      checkpoint_id: presented.value.checkpoint_ref,
      draft_sha256: sha256(VALID_CONSTITUTION),
      decision: "approve_continue",
    });
    assert.ok(answered.ok);
    if (!answered.ok) return;
    const approved = decideConstitutionCheckpoint(root, {
      ...workspaceSelector(),
      gate_id: ensured.value.gate_id,
      checkpoint_id: presented.value.checkpoint_ref,
      decision: "approve_continue",
      authorization: "human",
      actor_provenance: { kind: "user", ref: answered.value.answer.reference, proof: answered.value.proof },
    });
    assert.ok(approved.ok, approved.ok ? "approved" : approved.error);
    if (!approved.ok) return;
    const workspace = resolveFeatureWorkspace(root, workspaceSelector());
    assert.ok(workspace.ok, workspace.ok ? "origin workspace resolves" : workspace.error);
    if (!workspace.ok) return;
    assert.equal(workspace.value.constitution_gate_ref, ensured.value.gate_id);
    assert.deepEqual(workspace.value.constitution_binding, approved.value.binding);
    const resumed = ensureProjectConstitution(
      root,
      { origin_kind: "native_direct", origin_run_key: RUN_KEY, origin_stage: ORIGIN_STAGE },
      { feature_id: FEATURE_ID },
    );
    assert.ok(resumed.ok, resumed.ok ? "bound origin prerequisite resumes" : resumed.error);
    if (resumed.ok) assert.equal(resumed.value.status, "usable");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});


test("gate-owned approval refuses to bind an origin workspace after constitution source drift", () => {
  const root = makeProject();
  let injected = false;
  try {
    seedFreshNativeWorkspace(root);
    const ensured = ensureProjectConstitution(root, { origin_kind: "native_direct", origin_run_key: RUN_KEY, origin_stage: ORIGIN_STAGE }, { feature_id: FEATURE_ID });
    assert.ok(ensured.ok);
    if (!ensured.ok) return;
    const presented = presentConstitutionDraft(root, { ...workspaceSelector(), gate_id: ensured.value.gate_id, document: VALID_CONSTITUTION });
    assert.ok(presented.ok);
    if (!presented.ok || !presented.value.checkpoint_ref) return;
    const answered = recordConstitutionCheckpointAnswer(root, {
      ...workspaceSelector(),
      gate_id: ensured.value.gate_id,
      checkpoint_id: presented.value.checkpoint_ref,
      draft_sha256: sha256(VALID_CONSTITUTION),
      decision: "approve_continue",
    });
    assert.ok(answered.ok);
    if (!answered.ok) return;
    const decision = {
      ...workspaceSelector(),
      gate_id: ensured.value.gate_id,
      checkpoint_id: presented.value.checkpoint_ref,
      decision: "approve_continue" as const,
      authorization: "human" as const,
      actor_provenance: { kind: "user" as const, ref: answered.value.answer.reference, proof: answered.value.proof },
    };
    setStateTransactionTestHooks({
      beforeCas: ({ sourcePath }) => {
        if (injected || !sourcePath.endsWith(`/features/${FEATURE_ID}/state.json`)) return;
        injected = true;
        writeConstitution(root, VALID_CONSTITUTION_REVISED);
      },
    }, root);
    const failed = decideConstitutionCheckpoint(root, decision);
    setStateTransactionTestHooks(null, root);
    assert.equal(injected, true, "the deterministic race must run at the origin workspace CAS seam");
    assert.equal(failed.ok, false, "source drift must block the origin workspace binding");
    const staleWorkspace = resolveFeatureWorkspace(root, workspaceSelector());
    assert.ok(staleWorkspace.ok);
    if (staleWorkspace.ok) assert.equal(staleWorkspace.value.constitution_binding, null, "a stale source must not receive the approved binding");

    writeConstitution(root, VALID_CONSTITUTION);
    const replay = decideConstitutionCheckpoint(root, decision);
    assert.ok(replay.ok, replay.ok ? "same-answer replay repairs the workspace" : replay.error);
    const repaired = resolveFeatureWorkspace(root, workspaceSelector());
    assert.ok(repaired.ok);
    if (repaired.ok) assert.deepEqual(repaired.value.constitution_binding, replay.ok && replay.value.binding);
  } finally {
    setStateTransactionTestHooks(null, root);
    rmSync(root, { recursive: true, force: true });
  }
});


test("gate-owned approval returns a durable failure after gate commit and same-answer replay repairs the workspace", () => {
  const root = makeProject();
  const originalWriteAtomicFiles = PinnedProjectRoot.prototype.writeAtomicFilesWithReceipts;
  let failWorkspaceWrite = false;
  try {
    seedFreshNativeWorkspace(root);
    const ensured = ensureProjectConstitution(root, { origin_kind: "native_direct", origin_run_key: RUN_KEY, origin_stage: ORIGIN_STAGE }, { feature_id: FEATURE_ID });
    assert.ok(ensured.ok);
    if (!ensured.ok) return;
    const presented = presentConstitutionDraft(root, { ...workspaceSelector(), gate_id: ensured.value.gate_id, document: VALID_CONSTITUTION });
    assert.ok(presented.ok);
    if (!presented.ok || !presented.value.checkpoint_ref) return;
    const answered = recordConstitutionCheckpointAnswer(root, {
      ...workspaceSelector(),
      gate_id: ensured.value.gate_id,
      checkpoint_id: presented.value.checkpoint_ref,
      draft_sha256: sha256(VALID_CONSTITUTION),
      decision: "approve_continue",
    });
    assert.ok(answered.ok);
    if (!answered.ok) return;
    const decision = {
      ...workspaceSelector(),
      gate_id: ensured.value.gate_id,
      checkpoint_id: presented.value.checkpoint_ref,
      decision: "approve_continue" as const,
      authorization: "human" as const,
      actor_provenance: { kind: "user" as const, ref: answered.value.answer.reference, proof: answered.value.proof },
    };
    PinnedProjectRoot.prototype.writeAtomicFilesWithReceipts = function(entries) {
      if (failWorkspaceWrite) throw new Error("injected origin workspace write failure");
      return originalWriteAtomicFiles.call(this, entries);
    };
    failWorkspaceWrite = true;
    const failed = decideConstitutionCheckpoint(root, decision);
    assert.equal(failed.ok, false, "a workspace write failure must be surfaced after the gate decision is durable");
    const gateRoot = PinnedProjectRoot.open(root);
    assert.ok(gateRoot);
    if (gateRoot) {
      try {
        const gate = readConstitutionGateEnvelopePinned(gateRoot);
        assert.equal(gate.ok, true);
        if (gate.ok) assert.equal(gate.value?.gate.status, "approved");
      } finally {
        gateRoot.close();
      }
    }
    const unresolved = resolveFeatureWorkspace(root, workspaceSelector());
    assert.ok(unresolved.ok);
    if (unresolved.ok) assert.equal(unresolved.value.constitution_binding, null);
    failWorkspaceWrite = false;
    const replay = decideConstitutionCheckpoint(root, decision);
    assert.ok(replay.ok, replay.ok ? "replay repairs binding" : replay.error);
    const repaired = resolveFeatureWorkspace(root, workspaceSelector());
    assert.ok(repaired.ok);
    if (repaired.ok) assert.deepEqual(repaired.value.constitution_binding, replay.ok && replay.value.binding);
  } finally {
    PinnedProjectRoot.prototype.writeAtomicFilesWithReceipts = originalWriteAtomicFiles;
    rmSync(root, { recursive: true, force: true });
  }
});


test("gate-owned approval rejects a wrong origin selector without binding another workspace", () => {
  const root = makeProject();
  try {
    seedFreshNativeWorkspace(root);
    seedFreshNativeWorkspace(root, "other-feature", RUN_KEY);
    const ensured = ensureProjectConstitution(root, { origin_kind: "native_direct", origin_run_key: RUN_KEY, origin_stage: ORIGIN_STAGE }, { feature_id: FEATURE_ID });
    assert.ok(ensured.ok);
    if (!ensured.ok) return;
    const presented = presentConstitutionDraft(root, { ...workspaceSelector(), gate_id: ensured.value.gate_id, document: VALID_CONSTITUTION });
    assert.ok(presented.ok);
    if (!presented.ok || !presented.value.checkpoint_ref) return;
    const answered = recordConstitutionCheckpointAnswer(root, { ...workspaceSelector(), gate_id: ensured.value.gate_id, checkpoint_id: presented.value.checkpoint_ref, draft_sha256: sha256(VALID_CONSTITUTION), decision: "approve_continue" });
    assert.ok(answered.ok);
    if (!answered.ok) return;
    const wrong = decideConstitutionCheckpoint(root, {
      feature_id: "other-feature",
      run_key: RUN_KEY,
      gate_id: ensured.value.gate_id,
      checkpoint_id: presented.value.checkpoint_ref,
      decision: "approve_continue",
      authorization: "human",
      actor_provenance: { kind: "user", ref: answered.value.answer.reference, proof: answered.value.proof },
    });
    assert.equal(wrong.ok, false);
    const untouched = resolveFeatureWorkspace(root, { feature_id: "other-feature", run_key: RUN_KEY });
    assert.ok(untouched.ok);
    if (untouched.ok) assert.equal(untouched.value.constitution_binding, null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});


function writeSyntheticSourceWal(
  root: string,
  gateId: string,
  checkpointId: string,
  path: string,
  preimage: Record<string, unknown>,
  preimageDocument: string | null,
  desiredDocument: string,
  sourceDescriptor: { dev: number; ino: number; sha256: string },
): void {
  const pinned = PinnedProjectRoot.open(root);
  assert.ok(pinned, "source WAL fixture root is pinnable");
  if (!pinned) return;
  try {
    pinned.ensureDirectory(".work-state/specification/constitution");
    pinned.writeAtomic(".work-state/specification/constitution/source-write-wal.json", JSON.stringify({
      schema_version: 1,
      path,
      preimage,
      preimage_document: preimageDocument,
      desired_document: desiredDocument,
      desired_sha256: sha256(desiredDocument),
      source_descriptor: sourceDescriptor,
      gate_id: gateId,
      checkpoint_id: checkpointId,
    }, null, 2) + "\n");
  } finally {
    pinned.close();
  }
}


test("source correction WAL recovers preimage, owned postimage, approved postimage, and concurrent replacement", () => {
  const absentRoot = makeProject();
  try {
    seedFreshNativeWorkspace(absentRoot);
    const ensured = ensureProjectConstitution(absentRoot, { origin_kind: "native_direct", origin_run_key: RUN_KEY, origin_stage: ORIGIN_STAGE }, { feature_id: FEATURE_ID });
    assert.ok(ensured.ok, ensured.ok ? "absent source gate opened" : ensured.error);
    if (!ensured.ok) return;
    const presented = presentConstitutionDraft(absentRoot, { ...workspaceSelector(), gate_id: ensured.value.gate_id, document: VALID_CONSTITUTION });
    assert.ok(presented.ok && presented.value.checkpoint_ref);
    if (!presented.ok || !presented.value.checkpoint_ref) return;
    writeSyntheticSourceWal(absentRoot, ensured.value.gate_id, presented.value.checkpoint_ref, "CONSTITUTION.md", { kind: "absent", path: "CONSTITUTION.md" }, null, VALID_CONSTITUTION, { dev: 1, ino: 1, sha256: sha256(VALID_CONSTITUTION) });
    const replay = ensureProjectConstitution(absentRoot, { origin_kind: "native_direct", origin_run_key: RUN_KEY, origin_stage: ORIGIN_STAGE }, { feature_id: FEATURE_ID });
    assert.ok(replay.ok, replay.ok ? "pre-publication WAL retired for replay" : replay.error);
    assert.equal(existsSync(join(absentRoot, "CONSTITUTION.md")), false);
    assert.equal(existsSync(join(absentRoot, ".work-state", "specification", "constitution", "source-write-wal.json")), false);
  } finally {
    rmSync(absentRoot, { recursive: true, force: true });
  }

  const unusableRoot = makeProject();
  try {
    writeConstitution(unusableRoot, "");
    seedFreshNativeWorkspace(unusableRoot);
    const ensured = ensureProjectConstitution(unusableRoot, { origin_kind: "native_direct", origin_run_key: RUN_KEY, origin_stage: ORIGIN_STAGE }, { feature_id: FEATURE_ID });
    assert.ok(ensured.ok, ensured.ok ? "unusable source gate opened" : ensured.error);
    if (!ensured.ok) return;
    const presented = presentConstitutionDraft(unusableRoot, { ...workspaceSelector(), gate_id: ensured.value.gate_id, document: VALID_CONSTITUTION });
    assert.ok(presented.ok && presented.value.checkpoint_ref);
    if (!presented.ok || !presented.value.checkpoint_ref) return;
    const envelopeRoot = PinnedProjectRoot.open(unusableRoot);
    assert.ok(envelopeRoot);
    if (!envelopeRoot) return;
    const envelope = readConstitutionGateEnvelopePinned(envelopeRoot);
    const preimage = envelope.ok && envelope.value ? (envelope.value as Record<string, unknown>).source_preimage as Record<string, unknown> : null;
    envelopeRoot.close();
    assert.ok(preimage, "unusable correction carries an exact source preimage");
    if (!preimage) return;
    const source = PinnedProjectRoot.open(unusableRoot);
    assert.ok(source);
    if (!source) return;
    let desiredDescriptor: { dev: number; ino: number; sha256: string };
    try {
      const receipt = source.writeAtomicWithReceipt("CONSTITUTION.md", VALID_CONSTITUTION);
      desiredDescriptor = receipt.descriptor;
    } finally {
      source.close();
    }
    writeSyntheticSourceWal(unusableRoot, ensured.value.gate_id, presented.value.checkpoint_ref, "CONSTITUTION.md", preimage, "", VALID_CONSTITUTION, desiredDescriptor);
    const replay = ensureProjectConstitution(unusableRoot, { origin_kind: "native_direct", origin_run_key: RUN_KEY, origin_stage: ORIGIN_STAGE }, { feature_id: FEATURE_ID });
    assert.ok(replay.ok, replay.ok ? "owned postimage WAL rolled back" : replay.error);
    assert.equal(readFileSync(join(unusableRoot, "CONSTITUTION.md"), "utf8"), "");
    assert.equal(existsSync(join(unusableRoot, ".work-state", "specification", "constitution", "source-write-wal.json")), false);
  } finally {
    rmSync(unusableRoot, { recursive: true, force: true });
  }

  const concurrentRoot = makeProject();
  try {
    writeConstitution(concurrentRoot, "");
    seedFreshNativeWorkspace(concurrentRoot);
    const ensured = ensureProjectConstitution(concurrentRoot, { origin_kind: "native_direct", origin_run_key: RUN_KEY, origin_stage: ORIGIN_STAGE }, { feature_id: FEATURE_ID });
    assert.ok(ensured.ok, ensured.ok ? "concurrent source gate opened" : ensured.error);
    if (!ensured.ok) return;
    const presented = presentConstitutionDraft(concurrentRoot, { ...workspaceSelector(), gate_id: ensured.value.gate_id, document: VALID_CONSTITUTION });
    assert.ok(presented.ok && presented.value.checkpoint_ref);
    if (!presented.ok || !presented.value.checkpoint_ref) return;
    const source = PinnedProjectRoot.open(concurrentRoot);
    assert.ok(source);
    if (!source) return;
    let ownedDescriptor: { dev: number; ino: number; sha256: string };
    try {
      ownedDescriptor = source.writeAtomicWithReceipt("CONSTITUTION.md", VALID_CONSTITUTION).descriptor;
    } finally {
      source.close();
    }
    const replacement = join(concurrentRoot, "CONSTITUTION.replacement");
    writeFileSync(replacement, VALID_CONSTITUTION, "utf8");
    renameSync(replacement, join(concurrentRoot, "CONSTITUTION.md"));
    const pinned = PinnedProjectRoot.open(concurrentRoot);
    assert.ok(pinned);
    if (!pinned) return;
    const current = pinned.readFile("CONSTITUTION.md");
    pinned.close();
    writeSyntheticSourceWal(concurrentRoot, ensured.value.gate_id, presented.value.checkpoint_ref, "CONSTITUTION.md", { kind: "file", path: "CONSTITUTION.md", dev: (ensured.value as any).source_preimage?.dev ?? ownedDescriptor.dev, ino: (ensured.value as any).source_preimage?.ino ?? ownedDescriptor.ino, sha256: sha256("") }, "", VALID_CONSTITUTION, ownedDescriptor);
    const blocked = ensureProjectConstitution(concurrentRoot, { origin_kind: "native_direct", origin_run_key: RUN_KEY, origin_stage: ORIGIN_STAGE }, { feature_id: FEATURE_ID });
    assert.equal(blocked.ok, false);
    if (!blocked.ok) assert.equal(blocked.code, "SPEC_CONSTITUTION_IMPACT_PENDING");
    const after = PinnedProjectRoot.open(concurrentRoot);
    assert.ok(after);
    if (after) { assert.equal(after.readFile("CONSTITUTION.md").ino, current.ino); after.close(); }
  } finally {
    rmSync(concurrentRoot, { recursive: true, force: true });
  }

  const approvedRoot = makeProject();
  try {
    const decision = approveGateDraft(approvedRoot);
    const approved = decideConstitutionCheckpoint(approvedRoot, decision.decision);
    assert.ok(approved.ok, approved.ok ? "approved correction materialized" : approved.error);
    const pinned = PinnedProjectRoot.open(approvedRoot);
    assert.ok(pinned);
    if (!pinned) return;
    const current = pinned.readFile("CONSTITUTION.md");
    pinned.close();
    writeSyntheticSourceWal(approvedRoot, decision.decision.gate_id, decision.checkpointId, "CONSTITUTION.md", { kind: "absent", path: "CONSTITUTION.md" }, null, VALID_CONSTITUTION, { dev: current.dev, ino: current.ino, sha256: sha256(VALID_CONSTITUTION) });
    const replay = ensureProjectConstitution(approvedRoot, { origin_kind: "native_direct", origin_run_key: RUN_KEY, origin_stage: ORIGIN_STAGE }, { feature_id: FEATURE_ID });
    assert.ok(replay.ok, replay.ok ? "approved postimage WAL retired" : replay.error);
    assert.equal(existsSync(join(approvedRoot, ".work-state", "specification", "constitution", "source-write-wal.json")), false);
  } finally {
    rmSync(approvedRoot, { recursive: true, force: true });
  }
});


test("approved bootstrap corrections create absent native files and replace unusable native files", () => {
  const cases: ReadonlyArray<{ label: string; content?: string; explicitPath?: string }> = [
    { label: "absent" },
    { label: "empty", content: "" },
    { label: "unresolved", content: "# Project Constitution\n\n{{UNRESOLVED}}\n" },
    { label: "structurally-invalid-explicit", content: "a stray sentence", explicitPath: "policy/constitution.md" },
  ];
  for (const testCase of cases) {
    const root = makeProject();
    try {
        if (testCase.content !== undefined) writeConstitution(root, testCase.content, testCase.explicitPath ?? "CONSTITUTION.md");
      const bootstrap = approveGateDraft(root, testCase.explicitPath);
      const approved = decideConstitutionCheckpoint(root, bootstrap.decision);
      assert.ok(approved.ok, `${testCase.label}: ${approved.ok ? "" : approved.error}`);
      assert.equal(readFileSync(join(root, testCase.explicitPath ?? "CONSTITUTION.md"), "utf8"), VALID_CONSTITUTION, `${testCase.label}: correction writes exact approved bytes`);
      const resumed = ensureProjectConstitution(root, { origin_kind: "native_direct", origin_run_key: RUN_KEY, origin_stage: ORIGIN_STAGE }, { feature_id: FEATURE_ID, explicit_path: testCase.explicitPath });
      assert.ok(resumed.ok, `${testCase.label}: corrected source resumes`);
      if (resumed.ok) assert.equal(resumed.value.status, "usable", `${testCase.label}: corrected source is usable`);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
});


test("constitution correction fails closed when the selected source preimage changes", () => {
  const root = makeProject();
  try {
    writeConstitution(root, "", "CONSTITUTION.md");
    const bootstrap = approveGateDraft(root);
    writeConstitution(root, "changed unusable bytes", "CONSTITUTION.md");
    const failed = decideConstitutionCheckpoint(root, bootstrap.decision);
    assert.equal(failed.ok, false);
    assert.equal(readFileSync(join(root, "CONSTITUTION.md"), "utf8"), "changed unusable bytes");
    const gate = JSON.parse(readFileSync(join(root, ".work-state", "specification", "constitution", "gate.json"), "utf8")) as { gate: { status: string; binding: unknown } };
    assert.equal(gate.gate.status, "awaiting_approval");
    assert.equal(gate.gate.binding, null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});


test("constitution correction fails closed on a symlink path swap", () => {
  const root = makeProject();
  const outside = makeProject();
  try {
    writeConstitution(root, "", "CONSTITUTION.md");
    const bootstrap = approveGateDraft(root);
    writeConstitution(outside, "outside bytes", "constitution.md");
    rmSync(join(root, "CONSTITUTION.md"));
    symlinkSync(join(outside, "constitution.md"), join(root, "CONSTITUTION.md"), "file");
    const failed = decideConstitutionCheckpoint(root, bootstrap.decision);
    assert.equal(failed.ok, false);
    assert.equal(readFileSync(join(outside, "constitution.md"), "utf8"), "outside bytes");
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});


test("discovered provider corrections remain read-only", () => {
  const root = makeProject();
  try {
    const source = ".specify/memory/correction-discovered.md";
    writeConstitution(root, "discovered unusable", source);
    writeTestRegistryMarker(root);
    registerTestConstitutionProvider(root, { provider_id: "correction-discovered", discover: () => [source] });
    const bootstrap = approveGateDraft(root);
    const failed = decideConstitutionCheckpoint(root, bootstrap.decision);
    assert.equal(failed.ok, false);
    assert.equal(readFileSync(join(root, source), "utf8"), "discovered unusable");
    const gate = JSON.parse(readFileSync(join(root, ".work-state", "specification", "constitution", "gate.json"), "utf8")) as { gate: { status: string; binding: unknown } };
    assert.equal(gate.gate.status, "awaiting_approval");
    assert.equal(gate.gate.binding, null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});


test("successful native correction replay is byte-idempotent", () => {
  const root = makeProject();
  try {
    writeConstitution(root, "", "CONSTITUTION.md");
    const bootstrap = approveGateDraft(root);
    const first = decideConstitutionCheckpoint(root, bootstrap.decision);
    assert.ok(first.ok);
    if (!first.ok) return;
    const firstBytes = readFileSync(join(root, "CONSTITUTION.md"));
    const firstGate = JSON.parse(readFileSync(join(root, ".work-state", "specification", "constitution", "gate.json"), "utf8")) as { decisions: unknown[] };
    const replay = decideConstitutionCheckpoint(root, bootstrap.decision);
    assert.ok(replay.ok);
    assert.deepEqual(readFileSync(join(root, "CONSTITUTION.md")), firstBytes);
    const replayGate = JSON.parse(readFileSync(join(root, ".work-state", "specification", "constitution", "gate.json"), "utf8")) as { decisions: unknown[] };
    assert.equal(replayGate.decisions.length, firstGate.decisions.length);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});


test("changed unusable bound native source reopens exact correction and repairs after approval", () => {
  const root = makeProject();
  try {
    writeConstitution(root, VALID_CONSTITUTION);
    seedFreshNativeWorkspace(root);
    const initial = ensureProjectConstitution(root, originDescriptor(), { feature_id: FEATURE_ID });
    assert.ok(initial.ok);
    if (!initial.ok) return;
    assert.equal(initial.value.status, "usable");
    writeConstitution(root, "");
    const drifted = ensureProjectConstitution(root, originDescriptor(), { feature_id: FEATURE_ID });
    assert.ok(drifted.ok);
    if (!drifted.ok) return;
    assert.equal(drifted.value.status, "constitution_required");
    assert.equal(drifted.value.binding, null);
    const presented = presentConstitutionDraft(root, { ...workspaceSelector(), gate_id: drifted.value.gate_id, document: VALID_CONSTITUTION });
    assert.ok(presented.ok);
    if (!presented.ok || !presented.value.checkpoint_ref) return;
    const answered = recordConstitutionCheckpointAnswer(root, { ...workspaceSelector(), gate_id: drifted.value.gate_id, checkpoint_id: presented.value.checkpoint_ref, draft_sha256: sha256(VALID_CONSTITUTION), decision: "approve_continue" });
    assert.ok(answered.ok);
    if (!answered.ok) return;
    const repaired = decideConstitutionCheckpoint(root, {
      ...workspaceSelector(),
      gate_id: drifted.value.gate_id,
      checkpoint_id: presented.value.checkpoint_ref,
      decision: "approve_continue",
      authorization: "human",
      actor_provenance: { kind: "user", ref: answered.value.answer.reference, proof: answered.value.proof },
    });
    assert.ok(repaired.ok, repaired.ok ? "native correction repaired" : repaired.error);
    assert.equal(readFileSync(join(root, "CONSTITUTION.md"), "utf8"), VALID_CONSTITUTION);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});


test("deleted approved native source reopens correction and a different recreation remains review-bound", () => {
  const root = makeProject();
  try {
    writeConstitution(root, VALID_CONSTITUTION);
    seedFreshNativeWorkspace(root);
    const initial = ensureProjectConstitution(root, originDescriptor(), { feature_id: FEATURE_ID });
    assert.ok(initial.ok);
    if (!initial.ok) return;
    rmSync(join(root, "CONSTITUTION.md"));
    const missing = ensureProjectConstitution(root, originDescriptor(), { feature_id: FEATURE_ID });
    assert.ok(missing.ok);
    if (!missing.ok) return;
    assert.equal(missing.value.status, "constitution_required");
    assert.equal(missing.value.binding, null);
    writeConstitution(root, "different unusable bytes");
    const recreated = ensureProjectConstitution(root, originDescriptor(), { feature_id: FEATURE_ID });
    assert.ok(recreated.ok);
    if (recreated.ok) assert.equal(recreated.value.status, "constitution_required");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});


test("deleted approved discovered source falls back only to an explicit review gate and never writes the discovered path", () => {
  const root = makeProject();
  try {
    const discovered = ".specify/memory/deleted-discovered.md";
    writeConstitution(root, VALID_CONSTITUTION, discovered);
    writeTestRegistryMarker(root);
    registerTestConstitutionProvider(root, { provider_id: "deleted-discovered", discover: () => [discovered] });
    seedFreshNativeWorkspace(root);
    const initial = ensureProjectConstitution(root, originDescriptor(), { feature_id: FEATURE_ID });
    assert.ok(initial.ok);
    if (!initial.ok) return;
    rmSync(join(root, discovered));
    const recovered = ensureProjectConstitution(root, originDescriptor(), { feature_id: FEATURE_ID });
    assert.ok(recovered.ok);
    if (!recovered.ok) return;
    assert.equal(recovered.value.status, "constitution_required");
    assert.equal(recovered.value.binding, null);
    assert.equal(existsSync(join(root, discovered)), false);
    assert.equal(recovered.value.provider?.source, "native_default");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});


test("discovered deletion never clears a newer origin workspace constitution binding", () => {
  const root = makeProject();
  try {
        const discovered = ".specify/memory/newer-binding-discovered.md";
    writeConstitution(root, VALID_CONSTITUTION, discovered);
    writeTestRegistryMarker(root);
    registerTestConstitutionProvider(root, { provider_id: "newer-binding-discovered", discover: () => [discovered] });
    seedFreshNativeWorkspace(root);
    const origin = originDescriptor();
    const initial = ensureProjectConstitution(root, origin, { feature_id: FEATURE_ID });
    assert.ok(initial.ok);
    if (!initial.ok || !initial.value.binding) return;
    const workspace = resolveFeatureWorkspace(root, workspaceSelector());
    assert.ok(workspace.ok);
    if (!workspace.ok) return;
    const candidate = bindWorkspaceConstitution(workspace.value, initial.value.binding, "newer-origin-gate");
    const pinned = PinnedProjectRoot.open(root);
    assert.ok(pinned);
    if (!pinned) return;
    try {
      const snapshot = { lexical_root: pinned.lexical_root, canonical_root: pinned.canonical_root, dev: pinned.dev, ino: pinned.ino, pinned_root: pinned };
      const persisted = persistFeatureWorkspace(root, candidate, snapshot, { expected_workspace_digest: digestOf(workspace.value) });
      assert.ok(persisted.ok, persisted.ok ? "newer binding persisted" : persisted.error);
    } finally {
      pinned.close();
    }
    rmSync(join(root, discovered));
    const recovered = ensureProjectConstitution(root, origin, { feature_id: FEATURE_ID });
    assert.ok(recovered.ok);
    if (!recovered.ok) return;
    assert.equal(recovered.value.status, "constitution_required");
    const untouched = resolveFeatureWorkspace(root, workspaceSelector());
    assert.ok(untouched.ok);
    if (untouched.ok) assert.equal(untouched.value.constitution_gate_ref, "newer-origin-gate");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});


test("cross-process constitution decisions commit one durable decision and consume one proof", { timeout: CONSTITUTION_CHILD_TIMEOUT_MS + 5_000 }, async () => {
  const root = makeProject();
  try {
    const ensured = ensureProjectConstitution(root, originDescriptor());
    assert.ok(ensured.ok);
    if (!ensured.ok) return;
    seedDecisionWorkspace(root);
    const presented = presentConstitutionDraft(root, {
      ...workspaceSelector(),
      gate_id: ensured.value.gate_id,
      document: VALID_CONSTITUTION,
    });
    assert.ok(presented.ok);
    if (!presented.ok || !presented.value.checkpoint_ref) return;

    const trusted = trustedDecision(root, presented.value.checkpoint_ref, "approve_continue");
    const input: ConstitutionDecisionInput = {
      ...trusted,
      gate_id: ensured.value.gate_id,
      checkpoint_id: presented.value.checkpoint_ref,
      decision: "approve_continue",
    };
    const children: ConstitutionDecisionChild[] = [];
    try {
      children.push(runConstitutionDecisionInChild(root, input, true));
      children.push(runConstitutionDecisionInChild(root, input, true));
      await Promise.all(children.map((child) => child.ready));
      for (const child of children) child.release();
      const [first, second] = await Promise.all(children.map((child) => child.promise));
      assert.equal(first.ok, true, "the first contender failed: " + JSON.stringify(first));
      assert.equal(second.ok, true, "the second contender failed: " + JSON.stringify(second));
      assert.deepEqual(first, second, "both contenders observe one identical durable decision projection");
      const approvedProjection = first.value as Record<string, unknown>;
      assert.equal(approvedProjection.checkpoint_ref, null, "approved callers do not retain an open checkpoint");
      assert.equal(approvedProjection.resume_marker, ensured.value.gate_id + ".resume.v1", "approved callers receive the one resume marker identity");
      assert.deepEqual(approvedProjection.resume, { origin_kind: "native_direct", origin_run_key: RUN_KEY, resume_target: "specify" });
      assert.equal(approvedProjection.resume_consumed, true, "approved callers observe the consumed resume marker");

      const envelope = JSON.parse(readFileSync(
        join(root, ".work-state", "specification", "constitution", "gate.json"),
        "utf8",
      )) as {
        gate: { status: string; checkpoint_ref: string | null; resume_marker: string | null };
        decisions: Array<{ checkpoint_id: string; decision: string; feedback: string | null; authorization: "human"; actor_provenance: unknown; at: string }>;
        resume_marker_consumed: boolean;
      };
      assert.equal(envelope.gate.status, "approved");
      assert.equal(envelope.gate.checkpoint_ref, null);
      assert.equal(envelope.decisions.length, 1, "the cross-process race records exactly one durable decision");
      const durableDecision = envelope.decisions[0];
      assert.deepEqual(
        { ...durableDecision, at: "<committed-at>" },
        {
          checkpoint_id: presented.value.checkpoint_ref,
          decision: "approve_continue",
          feedback: null,
          authorization: "human",
          actor_provenance: trusted.actor_provenance,
          at: "<committed-at>",
        },
        "the sole durable decision preserves the exact trusted actor proof",
      );
      assert.ok(durableDecision && Number.isFinite(Date.parse(durableDecision.at)), "the durable decision timestamp is valid");
      assert.equal(envelope.gate.resume_marker, ensured.value.gate_id + ".resume.v1", "exactly one resume marker remains as the consumed decision identity");
      assert.equal(envelope.resume_marker_consumed, true, "the one resume marker is durably consumed");

      const selected = resolveState(root, undefined, workspaceSelector());
      assert.ok(selected.state);
      if (selected.state) {
        const answerId = trusted.actor_provenance.proof?.answer_id;
        assert.ok(answerId);
        const answers = selected.state.trusted_checkpoint_answers?.filter((answer) => answer.answer_id === answerId);
        assert.equal(answers?.length, 1, "the durable proof ledger contains one answer record");
        assert.ok(answers?.[0]?.consumed_at, "the one trusted proof is durably consumed");
      }
    } finally {
      for (const child of children) child.cleanup();
      await Promise.allSettled(children.map((child) => child.promise));
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});


test("cross-process distinct constitution drafts publish one canonical version and stale the loser", { timeout: CONSTITUTION_CHILD_TIMEOUT_MS + 5_000 }, async () => {
  const root = makeProject();
  try {
    const ensured = ensureProjectConstitution(root, originDescriptor());
    assert.ok(ensured.ok);
    if (!ensured.ok) return;
    seedDecisionWorkspace(root);
    const base = {
      ...workspaceSelector(),
      gate_id: ensured.value.gate_id,
    };
    const documents = [VALID_CONSTITUTION, VALID_CONSTITUTION_REVISED];
    const children = documents.map((document) => runConstitutionPresentationInChild(root, { ...base, document }, true));
    try {
      await Promise.all(children.map((child) => child.ready));
      for (const child of children) child.release();
      const results = await Promise.all(children.map((child) => child.promise));
      const successes = results.filter((result) => result.ok === true);
      const failures = results.filter((result) => result.ok === false);
      assert.equal(successes.length, 1, "exactly one distinct draft may win the open checkpoint");
      assert.equal(failures.length, 1, "the loser must observe the authoritative open checkpoint");
      assert.equal(failures[0]?.code, "SPEC_STATE_INVALID");
      const envelope = JSON.parse(readFileSync(
        join(root, ".work-state", "specification", "constitution", "gate.json"),
        "utf8",
      )) as {
        gate: { gate_id: string; status: string; checkpoint_ref: string | null };
        drafts: Array<{ version: number; document: string; document_sha256: string; validation_ref: string }>;
      };
      assert.equal(envelope.gate.status, "awaiting_approval");
      assert.equal(envelope.gate.checkpoint_ref, `${envelope.gate.gate_id}.checkpoint.v1`);
      assert.equal(envelope.drafts.length, 1, "the envelope records only the canonical winner");
      assert.equal(envelope.drafts[0]?.version, 1, "the first publication owns version one");
      const draftPath = join(root, ".work-state", "specification", "constitution", "drafts", "v1.json");
      const artifactBytes = readFileSync(draftPath, "utf8");
      const artifact = JSON.parse(artifactBytes) as { gate_id: string; version: number; document: string; document_sha256: string; validation_ref: string };
      assert.equal(artifactBytes, JSON.stringify({ gate_id: envelope.gate.gate_id, ...envelope.drafts[0] }, null, 2) + "\n", "the immutable artifact bytes exactly match the envelope draft");
      assert.equal(artifact.gate_id, envelope.gate.gate_id);
      assert.equal(artifact.version, 1);
      assert.ok(documents.includes(artifact.document), "the artifact contains one of the two submitted usable documents");
      assert.equal(artifact.document_sha256, sha256(artifact.document));
      assert.equal(artifact.validation_ref, "constitution.validation." + artifact.document_sha256);

      const replay = presentConstitutionDraft(root, { ...base, document: artifact.document });
      assert.ok(replay.ok, replay.ok ? "identical presentation replays" : replay.error);
      if (replay.ok) {
        assert.equal(replay.value.draft_version, 1);
        assert.equal(replay.value.checkpoint_ref, envelope.gate.checkpoint_ref);
      }
      assert.equal(readFileSync(draftPath, "utf8"), artifactBytes, "identical replay never rewrites immutable bytes");
      const replayEnvelope = JSON.parse(readFileSync(
        join(root, ".work-state", "specification", "constitution", "gate.json"),
        "utf8",
      )) as { drafts: unknown[] };
      assert.equal(replayEnvelope.drafts.length, 1, "identical replay does not append another draft");
    } finally {
      for (const child of children) child.cleanup();
      await Promise.allSettled(children.map((child) => child.promise));
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});


test("constitution approval rejects an immutable draft artifact with mismatched bytes", () => {
  const root = makeProject();
  try {
    const ensured = ensureProjectConstitution(root, originDescriptor());
    assert.ok(ensured.ok);
    if (!ensured.ok) return;
    seedDecisionWorkspace(root);
    const presented = presentConstitutionDraft(root, {
      ...workspaceSelector(),
      gate_id: ensured.value.gate_id,
      document: VALID_CONSTITUTION,
    });
    assert.ok(presented.ok);
    if (!presented.ok || !presented.value.checkpoint_ref) return;
    const draftPath = join(root, ".work-state", "specification", "constitution", "drafts", "v1.json");
    const artifact = JSON.parse(readFileSync(draftPath, "utf8")) as Record<string, unknown>;
    writeFileSync(draftPath, JSON.stringify({ ...artifact, document: VALID_CONSTITUTION_REVISED }, null, 2) + "\n", "utf8");
    const approval = decideConstitutionCheckpoint(root, {
      ...trustedDecision(root, presented.value.checkpoint_ref, "approve_continue"),
      gate_id: ensured.value.gate_id,
      checkpoint_id: presented.value.checkpoint_ref,
      decision: "approve_continue",
    });
    assert.equal(approval.ok, false, "approval must fail when the immutable artifact no longer matches the bound draft");
    if (!approval.ok) assert.equal(approval.code, "SPEC_STATE_INVALID");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});


test("unusable and oversized drafts are rejected before a checkpoint or validation artifact exists", () => {
  const root = makeProject();
  try {
    const ensured = ensureProjectConstitution(root, originDescriptor());
    assert.ok(ensured.ok);
    if (!ensured.ok) return;
    seedDecisionWorkspace(root);

    const unusable = presentConstitutionDraft(root, {
      ...workspaceSelector(),
      gate_id: ensured.value.gate_id,
      document: VALID_CONSTITUTION + "{{ unresolved }}",
    });
    assert.equal(unusable.ok, false);
    if (!unusable.ok) assert.equal(unusable.code, "SPEC_DRAFT_INVALID");

    const oversized = presentConstitutionDraft(root, {
      ...workspaceSelector(),
      gate_id: ensured.value.gate_id,
      document: "x".repeat(512 * 1024 + 1),
    });
    assert.equal(oversized.ok, false);
    if (!oversized.ok) assert.equal(oversized.code, "SPEC_INPUT_OVERSIZED");

    const replay = ensureProjectConstitution(root, originDescriptor());
    assert.ok(replay.ok);
    if (replay.ok) {
      assert.equal(replay.value.status, "constitution_required");
      assert.equal(replay.value.checkpoint_ref, null);
    }
    const stateEntries = readdirSync(join(root, ".work-state", "specification", "constitution"));
    assert.deepEqual(
      stateEntries.filter((entry) => entry === "drafts" || entry.startsWith("validation-")),
      [],
      "rejected bytes create neither drafts nor usability evidence",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});


test("approval fails closed when engine-owned draft evidence is missing", () => {
  const root = makeProject();
  try {
    const ensured = ensureProjectConstitution(root, originDescriptor());
    assert.ok(ensured.ok);
    if (!ensured.ok) return;
    seedDecisionWorkspace(root);
    const presented = presentConstitutionDraft(root, {
      ...workspaceSelector(),
      gate_id: ensured.value.gate_id,
      document: VALID_CONSTITUTION,
    });
    assert.ok(presented.ok);
    if (!presented.ok || !presented.value.checkpoint_ref) return;

    const evidencePath = join(
      root,
      ".work-state",
      "specification",
      "constitution",
      "validation-" + sha256(VALID_CONSTITUTION) + ".json",
    );
    rmSync(evidencePath);
    const approval = decideConstitutionCheckpoint(root, {
      ...trustedDecision(root, presented.value.checkpoint_ref, "approve_continue"),
      gate_id: ensured.value.gate_id,
      checkpoint_id: presented.value.checkpoint_ref,
      decision: "approve_continue",
    });
    assert.equal(approval.ok, false, "missing engine evidence cannot become an approved binding");
    if (!approval.ok) assert.equal(approval.code, "SPEC_STATE_INVALID");

    const gate = JSON.parse(readFileSync(
      join(root, ".work-state", "specification", "constitution", "gate.json"),
      "utf8",
    )) as { gate: { status: string; binding: unknown } };
    assert.equal(gate.gate.status, "awaiting_approval");
    assert.equal(gate.gate.binding, null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});


test("constitution decisions reject fabricated, cross-context, mismatched, and non-user proofs", () => {
  const root = makeProject();
  try {
    const ensured = ensureProjectConstitution(root, originDescriptor());
    assert.ok(ensured.ok);
    if (!ensured.ok) return;
    seedDecisionWorkspace(root);
    const presented = presentConstitutionDraft(root, {
      ...workspaceSelector(),
      gate_id: ensured.value.gate_id,
      document: VALID_CONSTITUTION,
    });
    assert.ok(presented.ok);
    if (!presented.ok || !presented.value.checkpoint_ref) return;
    const primaryWorkspace = resolveState(root, undefined, workspaceSelector());
    assert.ok(!primaryWorkspace.invalid && primaryWorkspace.state, "the primary decision workspace is persisted before cross-context probes");
    if (!primaryWorkspace.state) return;

    const otherFeature = "another-feature";
    writeDecisionWorkspace(root, checkpointState(root, "constitution-bootstrap-pending", "native_direct", {
      feature_id: otherFeature,
      run_key: RUN_KEY,
    }));
    const crossFeatureDraft = presentConstitutionDraft(root, {
      feature_id: otherFeature,
      run_key: RUN_KEY,
      gate_id: ensured.value.gate_id,
      document: VALID_CONSTITUTION,
    });
    assert.equal(crossFeatureDraft.ok, false, "a validated draft cannot adopt a different selected feature");

    const otherRun = "another-run";
    writeDecisionWorkspace(root, checkpointState(root, "constitution-bootstrap-pending", "native_direct", {
      feature_id: FEATURE_ID,
      run_key: otherRun,
    }));
    const crossRunDraft = presentConstitutionDraft(root, {
      feature_id: FEATURE_ID,
      run_key: otherRun,
      gate_id: ensured.value.gate_id,
      document: VALID_CONSTITUTION,
    });
    assert.equal(crossRunDraft.ok, false, "a validated draft cannot adopt a different selected run");
    writeState(root, primaryWorkspace.state, { target: primaryWorkspace });

    const checkpointId = presented.value.checkpoint_ref;
    const trusted = trustedDecision(root, checkpointId, "approve_continue", "constitution-answer/security");
    const base = {
      ...trusted,
      gate_id: ensured.value.gate_id,
      checkpoint_id: checkpointId,
      decision: "approve_continue" as const,
    };

    const fabricated = decideConstitutionCheckpoint(root, {
      ...base,
      actor_provenance: {
        kind: "user",
        ref: "terminal-answer/fabricated",
        proof: {
          answer_id: "fabricated",
          nonce: "fabricated-nonce",
          channel: "terminal",
          reference: "terminal-answer/fabricated",
          binding: sha256("fabricated-binding"),
        },
      },
    });
    assert.equal(fabricated.ok, false, "non-empty caller-minted proof values never authorize");
    if (!fabricated.ok) assert.equal(fabricated.code, "SPEC_PROOF_INVALID");

    const wrongRun = decideConstitutionCheckpoint(root, { ...base, run_key: "another-run" });
    assert.equal(wrongRun.ok, false, "a proof cannot cross run identity");
    const wrongFeature = decideConstitutionCheckpoint(root, { ...base, feature_id: "another-feature" });
    assert.equal(wrongFeature.ok, false, "a proof cannot cross feature identity");
    const systemActor = decideConstitutionCheckpoint(root, {
      ...base,
      actor_provenance: { ...trusted.actor_provenance, kind: "system" },
    });
    assert.equal(systemActor.ok, false, "system and agent provenance cannot impersonate a human answer");
    const mismatchedDecision = decideConstitutionCheckpoint(root, {
      ...base,
      decision: "request_changes",
      feedback: "This proof approved a different decision.",
    });
    assert.equal(mismatchedDecision.ok, false, "the immutable answer is bound to its exact decision");

    const wrongCheckpointProof = trustedDecision(root, `${checkpointId}.other`, "approve_continue", "constitution-answer/wrong-checkpoint");
    const wrongCheckpoint = decideConstitutionCheckpoint(root, { ...base, ...wrongCheckpointProof });
    assert.equal(wrongCheckpoint.ok, false, "an answer issued for another checkpoint cannot be reused");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});


test("request_changes re-dispatches the same draft stage with feedback and a new version", () => {
  const root = makeProject();
  try {
    const ensured = ensureProjectConstitution(root, originDescriptor("native_direct"));
    assert.ok(ensured.ok);
    if (!ensured.ok) return;
    const gateId = (ensured.value as Record<string, unknown>).gate_id as string;
    seedDecisionWorkspace(root);

    const presented = presentConstitutionDraft(root, {
      ...workspaceSelector(),
      gate_id: gateId,
      document: VALID_CONSTITUTION,
    });
    assert.ok(presented.ok);
    if (!presented.ok) return;
    const checkpointId = (presented.value as Record<string, unknown>).checkpoint_ref as string;
    const trustedRevision = trustedDecision(root, checkpointId, "request_changes");

    const withoutFeedback = decideConstitutionCheckpoint(root, {
      ...trustedRevision,
      gate_id: gateId,
      checkpoint_id: checkpointId,
      decision: "request_changes",
      feedback: undefined,
    });
    assert.equal(withoutFeedback.ok, false, "request_changes requires exact proof feedback");

    const withFeedback = decideConstitutionCheckpoint(root, {
      ...trustedRevision,
      gate_id: gateId,
      checkpoint_id: checkpointId,
      decision: "request_changes",
      feedback: trustedRevision.feedback,
    });
    assert.ok(withFeedback.ok, "feedback-bound request_changes is accepted");
    if (!withFeedback.ok) return;
    assert.equal(
      (withFeedback.value as Record<string, unknown>).status,
      "constitution_required",
      "the same draft identity reopens for revision",
    );
    assert.equal(
      (withFeedback.value as Record<string, unknown>).last_feedback,
      trustedRevision.feedback,
    );
    const substituted = decideConstitutionCheckpoint(root, {
      ...trustedRevision,
      gate_id: ensured.value.gate_id,
      checkpoint_id: checkpointId,
      decision: "request_changes",
      feedback: "model-substituted feedback",
    });
    assert.equal(substituted.ok, false, "top-level feedback substitution must not pass a trusted proof");

    const revised = presentConstitutionDraft(root, {
      ...workspaceSelector(),
      gate_id: gateId,
      document: VALID_CONSTITUTION_REVISED,
    });
    assert.ok(revised.ok, "the revision loop accepts a new draft version");
    if (revised.ok) {
      const revisedRecord = revised.value as Record<string, unknown>;
      assert.equal(revisedRecord.draft_version, 2, "a revised draft is a new immutable version");
      assert.equal(revisedRecord.status, "awaiting_approval");
      assert.deepEqual(revisedRecord.allowed_decisions, ["approve_continue", "request_changes"]);
      const replayedAcrossRevision = decideConstitutionCheckpoint(root, {
        ...trustedRevision,
        gate_id: gateId,
        checkpoint_id: revisedRecord.checkpoint_ref as string,
        decision: "request_changes",
        feedback: trustedRevision.feedback,
      });
      assert.equal(replayedAcrossRevision.ok, false, "a consumed proof cannot authorize a new checkpoint version");
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});


test("an external import origin resumes at compatibility validation", () => {
  const root = makeProject();
  try {
    const ensured = ensureProjectConstitution(root, originDescriptor("external_import"));
    assert.ok(ensured.ok);
    if (!ensured.ok) return;
    assert.equal(
      ensured.value.origin_stage,
      EXTERNAL_ORIGIN_STAGE,
      "the external origin descriptor preserves its canonical compatibility stage",
    );
    const gateId = (ensured.value as Record<string, unknown>).gate_id as string;
    seedDecisionWorkspace(root, "external_import");
    const presented = presentConstitutionDraft(root, {
      ...workspaceSelector(),
      gate_id: gateId,
      document: VALID_CONSTITUTION,
    });
    assert.ok(presented.ok);
    if (!presented.ok) return;
    const checkpointId = (presented.value as Record<string, unknown>).checkpoint_ref as string;
    const approved = decideConstitutionCheckpoint(root, {
      ...trustedDecision(root, checkpointId, "approve_continue"),
      gate_id: gateId,
      checkpoint_id: checkpointId,
      decision: "approve_continue",
    });
    assert.ok(approved.ok);
    if (!approved.ok) return;
    assert.deepEqual(
      (approved.value as Record<string, unknown>).resume,
      {
        origin_kind: "external_import",
        origin_run_key: "run-origin-1",
        resume_target: "compatibility_validation",
      },
      "imported origins resume at compatibility validation",
    );
    assert.equal((approved.value as Record<string, unknown>).checkpoint_ref, null, "approved import binding has no open checkpoint");
    assert.equal((approved.value as Record<string, unknown>).resume_marker, gateId + ".resume.v1", "approved import binding retains consumed resume provenance");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ── Semantic impact assessment ───────────────────────────────────────────────


test("formatting-only changes stay no-impact only when semantic hashes prove equivalence", () => {
  const root = makeProject();
  try {
    const previous = validConstitutionBinding();
    const reformatted = validConstitutionBinding({
      version: "1.0.1",
      content_sha256: sha256(`${VALID_CONSTITUTION}\n\n`),
      semantic_hash: previous.semantic_hash,
    });
    const assessment = assessConstitutionImpact(root, {
      previous_binding: previous,
      current_binding: reformatted,
      approved_artifacts: [
        {
          artifact_id: "specify.v1",
          semantic_section_hashes: { problem: sha256("problem-section") },
          depends_on: [],
        },
      ],
    });
    assert.ok(assessment.ok, assessment.ok ? "assessed" : `rejected: ${assessment.error}`);
    if (!assessment.ok) return;
    assert.equal(assessment.value.status, "pass");
    assert.equal(assessment.value.artifact_results[0]?.artifact_id, "specify.v1");
    assert.equal(assessment.value.artifact_results[0]?.verdict, "no_impact");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});


test("a semantic change marks affected artifacts and their dependency closure stale", () => {
  const root = makeProject();
  try {
    const previous = validConstitutionBinding();
    const changed = validConstitutionBinding({
      version: "1.1.0",
      content_sha256: sha256(VALID_CONSTITUTION_REVISED),
      semantic_hash: sha256("semantics-v2"),
    });
    const assessment = assessConstitutionImpact(root, {
      previous_binding: previous,
      current_binding: changed,
      approved_artifacts: [
        {
          artifact_id: "specify.v1",
          semantic_section_hashes: { quality: sha256("quality-rule-v2") },
          depends_on: [],
        },
        {
          artifact_id: "plan.v1",
          semantic_section_hashes: { decisions: sha256("plan-section") },
          depends_on: ["specify.v1"],
        },
        {
          artifact_id: "tasks.v1",
          semantic_section_hashes: { graph: sha256("unrelated-tasks") },
          depends_on: [],
        },
      ],
    });
    assert.ok(assessment.ok);
    if (!assessment.ok) return;
    assert.equal(assessment.value.status, "pass");
    const artifactResults = Object.fromEntries(
      assessment.value.artifact_results.map((row) => [row.artifact_id, row.verdict]),
    );
    assert.equal(artifactResults["specify.v1"], "affected");
    assert.equal(artifactResults["plan.v1"], "affected", "the dependency closure staleness is targeted");
    assert.equal(artifactResults["tasks.v1"], "no_impact", "unaffected artifacts keep their approval");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});


test("impact that cannot be established safely blocks instead of guessing", () => {
  const root = makeProject();
  try {
    const previous = validConstitutionBinding();
    const changed = validConstitutionBinding({
      version: "1.1.0",
      content_sha256: sha256(VALID_CONSTITUTION_REVISED),
      semantic_hash: sha256("semantics-v2"),
    });
    const assessment = assessConstitutionImpact(root, {
      previous_binding: previous,
      current_binding: changed,
      approved_artifacts: [
        {
          artifact_id: "specify.v1",
          semantic_section_hashes: {},
          depends_on: [],
        },
      ],
    });
    assert.equal(assessment.ok, false, "without section hashes no_impact cannot be proven");
    if (!assessment.ok) assert.equal(assessment.code, "SPEC_CONSTITUTION_IMPACT_PENDING");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});


test("identical assessment inputs produce one identical idempotent assessment", () => {
  const root = makeProject();
  try {
    const previous = validConstitutionBinding();
    const changed = validConstitutionBinding({
      version: "1.1.0",
      content_sha256: sha256(VALID_CONSTITUTION_REVISED),
      semantic_hash: sha256("semantics-v2"),
    });
    const input = {
      previous_binding: previous,
      current_binding: changed,
      approved_artifacts: [
        {
          artifact_id: "specify.v1",
          semantic_section_hashes: { quality: sha256("quality-rule-v2") },
          depends_on: [],
        },
      ],
    };
    const first = assessConstitutionImpact(root, input);
    const second = assessConstitutionImpact(root, {
      ...input,
      current_binding: { ...input.current_binding, bound_at: "2099-01-01T00:00:00.000Z" },
    });
    assert.ok(first.ok && second.ok);
    if (first.ok && second.ok) {
      assert.equal(first.value.assessment_id, second.value.assessment_id, "the assessment id is stable");
      assert.equal(first.value.assessment_hash, second.value.assessment_hash, "the assessment hash is stable");
      assert.equal(first.value.assessed_at, second.value.assessed_at, "replay returns the original durable assessment");
      assert.deepEqual(first.value.approved_artifacts, input.approved_artifacts, "the durable evidence carries the complete inventory");
      assert.deepEqual(
        first.value.artifact_results.map((row) => row.artifact_id),
        first.value.approved_artifacts.map((artifact) => artifact.artifact_id),
        "every approved artifact has exactly one persisted verdict row",
      );
      assert.ok(first.value.artifact_results.every((row) => row.evidence_refs.length > 0));
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("constitution impact evidence stays readable near its cap and rejects cap-plus-one output before writing", () => {
  const nearRoot = makeProject();
  const oversizedRoot = makeProject();
  try {
    const previous = validConstitutionBinding();
    const current = validConstitutionBinding({
      version: "1.1.0",
      content_sha256: sha256(VALID_CONSTITUTION_REVISED),
      semantic_hash: sha256("semantics-v2"),
    });
    const inventory = (count: number) => {
      const ids = Array.from({ length: count }, (_, index) => `${"a".repeat(180)}${index}`);
      return ids.map((artifact_id) => ({
        artifact_id,
        semantic_section_hashes: { custom: sha256("custom-section") },
        depends_on: [],
      }));
    };
    const near = assessConstitutionImpact(nearRoot, {
      previous_binding: previous,
      current_binding: current,
      approved_artifacts: inventory(2800),
    });
    assert.ok(near.ok, near.ok ? "assessed" : JSON.stringify(near));
    if (!near.ok) return;
    const nearEvidenceFile = readdirSync(join(nearRoot, ".work-state", "specification", "constitution"))
      .find((name) => name.startsWith("impact-") && name.endsWith(".json"));
    assert.ok(nearEvidenceFile);
    if (!nearEvidenceFile) return;
    const nearBytes = readFileSync(join(nearRoot, ".work-state", "specification", "constitution", nearEvidenceFile));
    assert.ok(nearBytes.byteLength > 1.5 * 1024 * 1024);
    assert.ok(nearBytes.byteLength <= 2 * 1024 * 1024);
    assert.doesNotThrow(() => JSON.parse(nearBytes.toString("utf8")));

    const oversized = assessConstitutionImpact(oversizedRoot, {
      previous_binding: previous,
      current_binding: current,
      approved_artifacts: inventory(4000),
    });
    assert.equal(oversized.ok, false, JSON.stringify(oversized));
    if (!oversized.ok) assert.equal(oversized.code, "SPEC_IMPACT_EVIDENCE_INVALID");
    assert.equal(
      existsSync(join(oversizedRoot, ".work-state", "specification", "constitution")),
      false,
    );
  } finally {
    rmSync(nearRoot, { recursive: true, force: true });
    rmSync(oversizedRoot, { recursive: true, force: true });
  }
});



test("strict constitution reader honors explicit custom paths and rejects drift or escape", () => {
  const root = makeProject();
  const outside = makeProject();
  const explicitPath = "policy/custom-constitution.md";
  try {
    writeConstitution(root, VALID_CONSTITUTION, explicitPath);
    const ensured = ensureProjectConstitution(root, originDescriptor(), { explicit_path: explicitPath });
    assert.ok(ensured.ok, ensured.ok ? "" : ensured.error);
    if (!ensured.ok || !ensured.value.binding) return;
    assert.equal(ensured.value.binding.provider_id, "explicit");
    assert.equal(ensured.value.binding.path, explicitPath);
    const pinned = PinnedProjectRoot.open(root);
    assert.ok(pinned);
    if (!pinned) return;
    try {
      const current = readPinnedCurrentConstitution(root, pinned, ensured.value.binding);
      assert.equal(current.ok, true, current.ok ? "" : current.error);
    } finally {
      pinned.close();
    }

    writeConstitution(root, VALID_CONSTITUTION_REVISED, explicitPath);
    const drifted = PinnedProjectRoot.open(root);
    assert.ok(drifted);
    if (!drifted) return;
    try {
      const current = readPinnedCurrentConstitution(root, drifted, ensured.value.binding);
      assert.equal(current.ok, false, "changed explicit custom content must fail the pinned binding");
    } finally {
      drifted.close();
    }

    writeFileSync(join(outside, "constitution.md"), VALID_CONSTITUTION, "utf8");
    rmSync(join(root, explicitPath), { force: true });
    mkdirSync(join(root, "policy"), { recursive: true });
    symlinkSync(join(outside, "constitution.md"), join(root, explicitPath), "file");
    const escaped = PinnedProjectRoot.open(root);
    assert.ok(escaped);
    if (!escaped) return;
    try {
      const current = readPinnedCurrentConstitution(root, escaped, ensured.value.binding);
      assert.equal(current.ok, false, "explicit custom symlink escape must fail closed");
    } finally {
      escaped.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});


test("nested missing constitution overrides bootstrap safely and seed only inside the project", () => {
  const root = makeProject();
  try {
    const options = { explicit_path: "policy/nested/constitution.md" };
    const ensured = ensureProjectConstitution(root, originDescriptor(), options);
    assert.ok(ensured.ok);
    if (!ensured.ok) return;
    assert.equal(ensured.value.status, "constitution_required");
    seedDecisionWorkspace(root);
    const presented = presentConstitutionDraft(root, { ...workspaceSelector(), gate_id: ensured.value.gate_id, document: VALID_CONSTITUTION });
    assert.ok(presented.ok);
    if (!presented.ok || !presented.value.checkpoint_ref) return;
    const approved = decideConstitutionCheckpoint(root, { ...trustedDecision(root, presented.value.checkpoint_ref, "approve_continue"), gate_id: ensured.value.gate_id, checkpoint_id: presented.value.checkpoint_ref, decision: "approve_continue" });
    assert.ok(approved.ok);
    assert.equal(readFileSync(join(root, "policy", "nested", "constitution.md"), "utf8"), VALID_CONSTITUTION);
  } finally { rmSync(root, { recursive: true, force: true }); }
});


test("constitution symlink targets outside the project fail closed", () => {
  const root = makeProject();
  const outside = makeProject();
  try {
    writeFileSync(join(outside, "constitution.md"), VALID_CONSTITUTION, "utf8");
    mkdirSync(join(root, "policy"), { recursive: true });
    symlinkSync(join(outside, "constitution.md"), join(root, "policy", "constitution.md"), "file");
    const result = ensureProjectConstitution(root, originDescriptor(), { explicit_path: "policy/constitution.md" });
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.code, "SPEC_PATH_UNAUTHORIZED");
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});


test("constitution drift requires durable complete engine evidence and only no-impact evidence unblocks", () => {
  const root = makeProject();
  const foreignRoot = makeProject();
  try {
    writeConstitution(root, VALID_CONSTITUTION);
    const initial = ensureProjectConstitution(root, originDescriptor());
    assert.ok(initial.ok && initial.value.binding);
    if (!initial.ok || !initial.value.binding) return;
    const previous = initial.value.binding;
    writeConstitution(root, VALID_CONSTITUTION_REVISED);
    const blocked = ensureProjectConstitution(root, originDescriptor());
    assert.ok(blocked.ok);
    if (!blocked.ok) return;
    assert.equal(blocked.value.status, "blocked");

    const digest = sha256(VALID_CONSTITUTION_REVISED);
    const current = {
      ...previous,
      version: "1.1.0",
      content_sha256: digest,
      semantic_hash: sha256(VALID_CONSTITUTION_REVISED.replace(/\r\n?/g, "\n").replace(/\s+/g, " ").trim()),
      validation_ref: `constitution.validation.${digest}`,
      bound_at: new Date().toISOString(),
    };
    const inventory = [{
      artifact_id: "specify.v1",
      semantic_section_hashes: { notes: sha256("approved-notes") },
      depends_on: [],
    }];

    const crafted = ensureProjectConstitution(root, originDescriptor(), {
      impact_assessment: {
        schema_version: 1,
        assessment_id: `constitution-impact-${"0".repeat(64)}`,
        assessment_hash: "0".repeat(64),
        project_root_hash: "0".repeat(64),
        previous_binding_hash: "0".repeat(64),
        current_binding_hash: "0".repeat(64),
        approved_artifacts_hash: "0".repeat(64),
        previous_binding: previous,
        current_binding: current,
        approved_artifacts: inventory,
        evaluator_version: "constitution-impact@2",
        artifact_results: [{ artifact_id: "specify.v1", verdict: "no_impact", evidence_refs: ["caller-crafted"] }],
        status: "pass",
        assessed_at: new Date().toISOString(),
      },
    });
    assert.ok(crafted.ok);
    if (crafted.ok) assert.equal(crafted.value.status, "blocked", "caller-crafted evidence is never authoritative");

    const affected = assessConstitutionImpact(root, {
      previous_binding: previous,
      current_binding: current,
      approved_artifacts: [{
        artifact_id: "specify.v1",
        semantic_section_hashes: { quality: sha256("approved-quality") },
        depends_on: [],
      }],
    });
    assert.ok(affected.ok);
    if (affected.ok) {
      const affectedAttempt = ensureProjectConstitution(root, originDescriptor(), { impact_assessment: affected.value });
      assert.ok(affectedAttempt.ok);
      if (affectedAttempt.ok) assert.equal(affectedAttempt.value.status, "blocked", "durable affected evidence preserves drift");
    }

    const legitimate = assessConstitutionImpact(root, {
      previous_binding: previous,
      current_binding: current,
      approved_artifacts: inventory,
    });
    assert.ok(legitimate.ok);
    if (!legitimate.ok) return;

    const incomplete = { ...legitimate.value } as Partial<ConstitutionImpactResult>;
    delete incomplete.approved_artifacts_hash;
    const incompleteAttempt = ensureProjectConstitution(root, originDescriptor(), {
      impact_assessment: incomplete as ConstitutionImpactResult,
    });
    assert.ok(incompleteAttempt.ok);
    if (incompleteAttempt.ok) assert.equal(incompleteAttempt.value.status, "blocked", "incomplete evidence cannot clear drift");

    const stale = {
      ...legitimate.value,
      current_binding: { ...legitimate.value.current_binding, content_sha256: sha256("stale") },
    };
    const staleAttempt = ensureProjectConstitution(root, originDescriptor(), { impact_assessment: stale });
    assert.ok(staleAttempt.ok);
    if (staleAttempt.ok) assert.equal(staleAttempt.value.status, "blocked", "stale evidence cannot clear drift");

    const foreign = assessConstitutionImpact(foreignRoot, {
      previous_binding: previous,
      current_binding: current,
      approved_artifacts: inventory,
    });
    assert.ok(foreign.ok);
    if (foreign.ok) {
      const foreignAttempt = ensureProjectConstitution(root, originDescriptor(), { impact_assessment: foreign.value });
      assert.ok(foreignAttempt.ok);
      if (foreignAttempt.ok) assert.equal(foreignAttempt.value.status, "blocked", "foreign project evidence cannot clear drift");
    }

    const cleared = ensureProjectConstitution(root, originDescriptor(), { impact_assessment: legitimate.value });
    assert.ok(cleared.ok);
    if (cleared.ok) {
      assert.equal(cleared.value.status, "usable");
      assert.equal(cleared.value.binding?.content_sha256, digest);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(foreignRoot, { recursive: true, force: true });
  }
});


test("feature-bound constitution guards block stale workspace bindings for every origin", () => {
  const root = makeProject();
  try {
    writeConstitution(root, VALID_CONSTITUTION);
    const initial = ensureProjectConstitution(root, originDescriptor());
    assert.ok(initial.ok && initial.value.binding);
    if (!initial.ok || !initial.value.binding) return;

    const exactState = checkpointState(root, "constitution-feature-bound");
    exactState.specification = {
      ...exactState.specification!,
      constitution_binding: initial.value.binding,
    };
    writeDecisionWorkspace(root, exactState);
    const exact = ensureProjectConstitution(root, originDescriptor(), { feature_id: FEATURE_ID });
    assert.ok(exact.ok, exact.ok ? "exact workspace binding is accepted" : exact.error);
    if (exact.ok) assert.equal(exact.value.status, "usable");
    const gatePath = join(root, ".work-state", "specification", "constitution", "gate.json");
    const exactGate = JSON.parse(readFileSync(gatePath, "utf8")) as { gate?: { status?: string; binding?: unknown } };
    assert.equal(exactGate.gate?.status, "usable");
    assert.deepEqual(exactGate.gate?.binding, initial.value.binding, "exact matching workspace leaves the approved binding unchanged");

    const staleBinding = {
      ...initial.value.binding,
      content_sha256: sha256("stale-content"),
      semantic_hash: sha256("stale-semantic"),
    };
    const staleState = checkpointState(root, "constitution-feature-bound");
    staleState.specification = {
      ...staleState.specification!,
      constitution_binding: staleBinding,
    };
    writeDecisionWorkspace(root, staleState);

    for (const origin of [
      { origin_kind: "native_direct" as const, origin_run_key: RUN_KEY, origin_stage: "specify" },
      { origin_kind: "do_work_nested" as const, origin_run_key: RUN_KEY, origin_stage: "do_work" },
      { origin_kind: "external_import" as const, origin_run_key: RUN_KEY, origin_stage: "spec_import" },
      { origin_kind: "cto_preparation" as const, origin_run_key: RUN_KEY, origin_stage: "cto" },
    ]) {
      const result = ensureProjectConstitution(root, origin, { feature_id: FEATURE_ID });
      assert.ok(result.ok, result.ok ? "stale workspace is classified by the guard" : result.error);
      if (result.ok) {
        assert.equal(result.value.status, "blocked", origin.origin_kind);
        assert.equal(result.value.usability_result, "structurally_invalid", `${origin.origin_kind}: binding mismatch is deterministic`);
        assert.equal(result.value.checkpoint_ref, null, `${origin.origin_kind}: blocked gate has no checkpoint`);
      }
      const persisted = JSON.parse(readFileSync(gatePath, "utf8")) as { gate?: { status?: string; usability_result?: string; checkpoint_ref?: unknown; binding?: unknown }; origin?: unknown };
      assert.equal(persisted.gate?.status, "blocked", `${origin.origin_kind}: blocked state is durable`);
      assert.equal(persisted.gate?.usability_result, "structurally_invalid", `${origin.origin_kind}: mismatch result survives persistence`);
      assert.equal(persisted.gate?.checkpoint_ref, null, `${origin.origin_kind}: persisted checkpoint is cleared`);
      assert.deepEqual(persisted.gate?.binding, initial.value.binding, `${origin.origin_kind}: approved binding remains evidence, not usable authorization`);
      const replay = ensureProjectConstitution(root, origin, { feature_id: FEATURE_ID });
      assert.ok(replay.ok, replay.ok ? `${origin.origin_kind}: persisted block replays` : replay.error);
      if (replay.ok) assert.equal(replay.value.status, "blocked", `${origin.origin_kind}: restart/process replay remains blocked`);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});


test("malformed feature specification aggregate fails closed without mutating the constitution gate", () => {
  const root = makeProject();
  try {
    writeConstitution(root, VALID_CONSTITUTION);
    const initial = ensureProjectConstitution(root, originDescriptor());
    assert.ok(initial.ok && initial.value.binding);
    if (!initial.ok || !initial.value.binding) return;

    const unboundState = checkpointState(root, "constitution-feature-bound");
    writeDecisionWorkspace(root, unboundState);
    const unbound = ensureProjectConstitution(root, originDescriptor(), { feature_id: FEATURE_ID });
    assert.ok(unbound.ok, unbound.ok ? "absent pre-spec binding remains admissible" : unbound.error);
    if (unbound.ok) assert.equal(unbound.value.status, "usable");

    const statePath = join(root, ".work-state", "features", FEATURE_ID, "state.json");
    const malformedState = JSON.parse(readFileSync(statePath, "utf8")) as Record<string, any>;
    (malformedState.specification as Record<string, unknown>).constitution_binding = { provider_id: "malformed" };
    writeFileSync(statePath, JSON.stringify(malformedState, null, 2) + "\n", "utf8");

    const gatePath = join(root, ".work-state", "specification", "constitution", "gate.json");
    const gateBefore = readFileSync(gatePath, "utf8");
    const stateBefore = readFileSync(statePath, "utf8");
    const result = ensureProjectConstitution(root, originDescriptor(), { feature_id: FEATURE_ID });
    assert.equal(result.ok, false, JSON.stringify(result));
    if (!result.ok) assert.equal(result.code, "SPEC_STATE_INVALID");
    assert.equal(readFileSync(gatePath, "utf8"), gateBefore);
    assert.equal(readFileSync(statePath, "utf8"), stateBefore);
    const malformedAggregate = JSON.parse(stateBefore) as Record<string, any>;
    malformedAggregate.specification = { feature_id: FEATURE_ID };
    writeFileSync(statePath, JSON.stringify(malformedAggregate, null, 2) + "\n", "utf8");
    const aggregateGateBefore = readFileSync(gatePath, "utf8");
    const aggregateStateBefore = readFileSync(statePath, "utf8");
    const aggregateResult = ensureProjectConstitution(root, originDescriptor(), { feature_id: FEATURE_ID });
    assert.equal(aggregateResult.ok, false, JSON.stringify(aggregateResult));
    if (!aggregateResult.ok) assert.equal(aggregateResult.code, "SPEC_STATE_INVALID");
    assert.equal(readFileSync(gatePath, "utf8"), aggregateGateBefore);
    assert.equal(readFileSync(statePath, "utf8"), aggregateStateBefore);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});


test("impact evidence writes reject symlinked state ancestors without touching the target", () => {
  const previous = validConstitutionBinding();
  const changed = validConstitutionBinding({
    version: "1.1.0",
    content_sha256: sha256(VALID_CONSTITUTION_REVISED),
    semantic_hash: sha256("semantics-v2"),
  });
  const inventory = [{
    artifact_id: "specify.v1",
    semantic_section_hashes: { quality: sha256("quality-rule-v2") },
    depends_on: [],
  }];

  for (const symlinkedAncestor of ["work-state", "constitution"] as const) {
    const root = makeProject();
    const outside = makeProject();
    const target = join(outside, "escape-target");
    try {
      mkdirSync(target);
      if (symlinkedAncestor === "work-state") {
        symlinkSync(target, join(root, ".work-state"), "dir");
      } else {
        mkdirSync(join(root, ".work-state", "specification"), { recursive: true });
        symlinkSync(target, join(root, ".work-state", "specification", "constitution"), "dir");
      }
      const assessment = assessConstitutionImpact(root, {
        previous_binding: previous,
        current_binding: changed,
        approved_artifacts: inventory,
      });
      assert.equal(assessment.ok, false);
      if (!assessment.ok) assert.equal(assessment.code, "SPEC_PATH_UNAUTHORIZED");
      assert.deepEqual(readdirSync(target), [], `${symlinkedAncestor} symlink target stays untouched`);
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  }
});

test("constitution prompt renderer emits one complete origin contract for every route", () => {
  const cases = [
    { origin_kind: "native_direct", origin_stage: "specify" },
    { origin_kind: "do_work_nested", origin_stage: "do_work" },
    { origin_kind: "cto_preparation", origin_stage: "cto" },
    { origin_kind: "external_import", origin_stage: "spec_import" },
  ] as const;
  for (const origin of cases) {
    const lines = renderConstitutionToolContract({
      feature_id: "constitution-feature",
      run_key: "run-origin-1",
      origin: { ...origin, origin_run_key: "run-origin-1" },
    });
    const prompt = lines.join("\n");
    assert.match(prompt, /ensure_project_constitution/);
    assert.match(prompt, /present_constitution_draft/);
    assert.match(prompt, /constitution_checkpoint_ask_selected/);
    assert.match(prompt, /decide_constitution_checkpoint/);
    assert.match(prompt, new RegExp(`"origin_kind":"${origin.origin_kind}"`));
    assert.match(prompt, /"origin_run_key":"run-origin-1"/);
    assert.match(prompt, new RegExp(`"origin_stage":"${origin.origin_stage}"`));
    assert.match(prompt, /"authorization":"human"/);
    assert.match(prompt, /"actor_provenance":\{"kind":"user"/);
    const orderedTools = [
      "ensure_project_constitution",
      "present_constitution_draft",
      "constitution_checkpoint_ask_selected",
      "decide_constitution_checkpoint",
    ];
    let previous = -1;
    for (const tool of orderedTools) {
      const index = prompt.indexOf(tool);
      assert.ok(index > previous, `${origin.origin_kind}: ${tool} follows the canonical prior action`);
      previous = index;
    }
    assert.match(prompt, /xd:\/\/.*write/iu);
    assert.match(prompt, /reading xd:\/\/ device documentation never executes/iu);
  }
});


test("constitution prompt branches typed initial bootstrap and approved-binding drift safely", () => {
  const origin = {
    origin_kind: "native_direct",
    origin_run_key: "run-origin-1",
    origin_stage: "specify",
  } as const;
  const initial = renderConstitutionToolContract({
    feature_id: "constitution-feature",
    run_key: "run-origin-1",
    origin,
    gate: { status: "constitution_required", usability_result: "missing" },
    workflow_prepare: {
      task: "bootstrap constitution",
      branch: "main",
      classification: { type: "SPEC", complexity: "MEDIUM", confidence: "HIGH", autonomous: false, workflow: "spec-preparation" },
      files: [],
      issue: null,
      feature_id: "constitution-feature",
      run_key: "run-origin-1",
    },
  }).join("\n");
  assert.match(initial, /present_constitution_draft/u);
  assert.match(initial, /constitution_checkpoint_ask_selected/u);
  assert.match(initial, /write JSON in the write operation's content field to mounted `xd:\/\/constitution_checkpoint_ask_selected` exactly/u);
  assert.match(initial, /gate_id.*checkpoint_id.*draft_sha256/u);
  assert.match(initial, /call mounted `workflow_prepare` exactly once with this engine-owned payload/iu);
  assert.match(initial, /"feature_id":"constitution-feature"/u);
  assert.match(initial, /Do not call constitution_impact_assess, constitution_impact_ask_selected, or constitution_impact_apply/u);
  assert.match(initial, /initial constitution bootstrap/u);

  const drift = renderConstitutionToolContract({
    feature_id: "constitution-feature",
    run_key: "run-origin-1",
    origin,
    gate: { status: "blocked", usability_result: "usable" },
  }).join("\n");
  assert.match(drift, /constitution_impact_assess/u);
  assert.match(drift, /constitution_impact_ask_selected/u);
  assert.match(drift, /constitution_impact_apply/u);
  assert.doesNotMatch(drift, /present_constitution_draft/u);
  assert.doesNotMatch(drift, /constitution_checkpoint_ask_selected/u);
});


test("constitution bootstrap uses its gate-owned trusted Ask ledger before workflow state exists", () => {
  const root = makeProject();
  try {
    const selector = { feature_id: "pre-workflow-constitution", run_key: "pre-workflow-run" };
    const ensured = ensureProjectConstitution(root, {
      origin_kind: "native_direct",
      origin_run_key: selector.run_key,
      origin_stage: "specify",
    });
    assert.equal(ensured.ok, true);
    if (!ensured.ok) return;
    const presented = presentConstitutionDraft(root, {
      ...selector,
      gate_id: ensured.value.gate_id,
      document: VALID_CONSTITUTION,
    });
    assert.equal(presented.ok, true);
    if (!presented.ok || !presented.value.checkpoint_ref) return;
    const draftSha = sha256(VALID_CONSTITUTION);
    const preview = validateConstitutionCheckpointAsk(root, {
      ...selector,
      gate_id: ensured.value.gate_id,
      checkpoint_id: presented.value.checkpoint_ref,
      draft_sha256: draftSha,
    });
    assert.equal(preview.ok, true);
    const answered = recordConstitutionCheckpointAnswer(root, {
      ...selector,
      gate_id: ensured.value.gate_id,
      checkpoint_id: presented.value.checkpoint_ref,
      draft_sha256: draftSha,
      decision: "approve_continue",
    });
    assert.equal(answered.ok, true);
    if (!answered.ok) return;
    const decided = decideConstitutionCheckpoint(root, {
      ...selector,
      gate_id: ensured.value.gate_id,
      checkpoint_id: presented.value.checkpoint_ref,
      decision: "approve_continue",
      authorization: "human",
      actor_provenance: {
        kind: "user",
        ref: answered.value.answer.reference,
        proof: answered.value.proof,
      },
    });
    assert.equal(decided.ok, true);
    assert.equal(decided.ok && decided.value.status, "approved");
    assert.equal(resolveState(root, undefined, selector).state, null);
    const replay = decideConstitutionCheckpoint(root, {
      ...selector,
      gate_id: ensured.value.gate_id,
      checkpoint_id: presented.value.checkpoint_ref,
      decision: "approve_continue",
      authorization: "human",
      actor_provenance: {
        kind: "user",
        ref: answered.value.answer.reference,
        proof: answered.value.proof,
      },
    });
    assert.equal(replay.ok, true);
    assert.equal(replay.ok && replay.value.status, "approved");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});


test("Linux borrowed constitution prerequisite persists and replays through descriptor aliases", () => {
  if (process.platform !== "linux") return;
  const root = makeProject();
  const constitutionPath = writeConstitution(root, VALID_CONSTITUTION);
  const pinned = PinnedProjectRoot.open(root);
  assert.ok(pinned);
  if (!pinned) return;
  try {
    const origin = originDescriptor();
    const ensured = ensureProjectConstitution(root, origin, { pinnedRoot: pinned });
    assert.equal(ensured.ok, true, ensured.ok ? "constitution gate persisted" : ensured.error);
    if (!ensured.ok) return;
    assert.equal(ensured.value.status, "usable");
    const gatePath = pinned.anchorPath(".work-state/specification/constitution/gate.json");
    assert.equal(pinned.relativePath(gatePath), ".work-state/specification/constitution/gate.json");
    assert.equal(pinned.pathEntryExists(pinned.relativePath(gatePath) ?? ""), true);
    const wrongDescriptor = gatePath.replace(/\/fd\/\d+(?=\/)/u, "/fd/999999/");
    assert.equal(pinned.relativePath(wrongDescriptor), null);
    assert.equal(pinned.relativePath(`${gatePath}/../escape`), null);
    const replay = ensureProjectConstitution(root, origin, { pinnedRoot: pinned });
    assert.equal(replay.ok, true, replay.ok ? "constitution gate replayed" : replay.error);
    if (replay.ok) assert.deepEqual(replay.value, ensured.value);
    assert.equal(readFileSync(constitutionPath, "utf8"), VALID_CONSTITUTION);
  } finally {
    pinned.close();
    rmSync(root, { recursive: true, force: true });
  }
});

