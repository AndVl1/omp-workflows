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
import { registerTestWorkflowTools, registerTestConstitutionTools } from "./fixtures/host-tool-activation.js";
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

test("constitution registrar exposes one strict canonical tool set and ignores duplicate registration", () => {
  const registered: Array<{ name: string; description: string; parameters: { safeParse: (input: unknown) => { success: boolean } } }> = [];
  const pi = {
    zod: z,
    on: TEST_ON,
    registerTool(tool: { name: string; description: string; parameters: { safeParse: (input: unknown) => { success: boolean } } }) {
      registered.push(tool);
    },
  };
  const registryRoot = makeProject();
  try {
    registerTestConstitutionTools(registryRoot, pi as never);
    registerTestConstitutionTools(registryRoot, pi as never);
  assert.deepEqual(registered.map((tool) => tool.name), [
    "ensure_project_constitution",
    "present_constitution_draft",
    "constitution_checkpoint_ask_selected",
    "decide_constitution_checkpoint",
    "constitution_impact_assess",
    "constitution_impact_ask_selected",
    "constitution_impact_apply",
  ]);
  assert.ok(registered.every((tool) => tool.description.length > 0));
  const ensure = registered[0]!;
  const originCases = [
    ["native_direct", "specify"],
    ["do_work_nested", "do_work"],
    ["cto_preparation", "cto"],
    ["external_import", "spec_import"],
  ] as const;
  for (const [origin_kind, origin_stage] of originCases) {
    assert.equal(ensure.parameters.safeParse({
      feature_id: "constitution-feature",
      run_key: "run-origin-1",
      origin_kind,
      origin_run_key: "run-origin-1",
      origin_stage,
    }).success, true);
  }
  assert.equal(ensure.parameters.safeParse({
    feature_id: "constitution-feature",
    run_key: "run-origin-1",
    origin_kind: "native_direct",
    origin_run_key: "run-origin-1",
    origin_stage: "do_work",
  }).success, false);
  assert.equal(ensure.parameters.safeParse({
    feature_id: "constitution-feature",
    run_key: "run-origin-1",
    origin_kind: "native_direct",
    origin_stage: "specify",
  }).success, false);
  assert.equal(ensure.parameters.safeParse({
    feature_id: "constitution-feature",
    run_key: "run-origin-1",
    origin_kind: "native_direct",
    origin_run_key: "run-origin-1",
  }).success, false);
  const present = registered[1]!;
  assert.equal(present.parameters.safeParse({
    feature_id: "constitution-feature",
    run_key: "run-origin-1",
    gate_id: "constitution.gate",
    document: VALID_CONSTITUTION,
  }).success, true);
  assert.equal(present.parameters.safeParse({
    feature_id: "constitution-feature",
    run_key: "run-origin-1",
    gate_id: "constitution.gate",
    document: VALID_CONSTITUTION,
    unexpected: true,
  }).success, false);
  const ask = registered[2]!;
  assert.equal(ask.parameters.safeParse({
    feature_id: "constitution-feature",
    run_key: "run-origin-1",
    gate_id: "constitution.gate",
    checkpoint_id: "constitution.gate.checkpoint.v1",
    draft_sha256: "a".repeat(64),
    checkpoint_kind: "constitution_approval",
  }).success, true);
  assert.equal(ask.parameters.safeParse({
    feature_id: "constitution-feature",
    run_key: "run-origin-1",
    gate_id: "constitution.gate",
    checkpoint_id: "constitution.gate.checkpoint.v1",
    draft_sha256: "a".repeat(64),
    checkpoint_kind: "constitution_approval",
    unexpected: true,
  }).success, false);
  const decide = registered[3]!;
  assert.equal(decide.parameters.safeParse({
    actor_provenance: { proof: { answer_id: "answer-1", nonce: "nonce-1", channel: "terminal", reference: "agent", binding: "binding-1" } },
  }).success, false);
  } finally { rmSync(registryRoot, { recursive: true, force: true }); }
});


test("constitution present result points to the concrete UI Ask as its only next action", async () => {
  const root = makeProject();
  try {
    seedDecisionWorkspace(root);
    const tools = new Map<string, { execute: (...args: never[]) => Promise<{ details: unknown }> }>();
    registerTestConstitutionTools(root, {
      zod: z,
      on: TEST_ON,
      registerTool(tool: { name: string; execute: (...args: never[]) => Promise<{ details: unknown }> }) {
        tools.set(tool.name, tool);
      },
    } as never);

    const context = TEST_CONTEXT(root);
    const selector = workspaceSelector();
    const ensure = await tools.get("ensure_project_constitution")!.execute("test", {
      ...selector,
      origin_kind: "native_direct",
      origin_run_key: selector.run_key,
      origin_stage: "specify",
    }, undefined, undefined, context);
    assert.equal((ensure.details as { ok?: boolean }).ok, true);
    const ensured = ensure.details as {
      value?: { gate_id?: string };
      required_next_tool?: { name?: string; arguments?: Record<string, unknown>; required_fields?: string[] };
    };
    assert.ok(ensured.value?.gate_id);
    assert.equal(ensured.required_next_tool?.name, "present_constitution_draft");
    assert.deepEqual(ensured.required_next_tool?.arguments, {
      feature_id: selector.feature_id,
      run_key: selector.run_key,
      gate_id: ensured.value!.gate_id,
    });
    assert.deepEqual(ensured.required_next_tool?.required_fields, ["document"]);

    const present = await tools.get("present_constitution_draft")!.execute("test", {
      ...selector,
      gate_id: ensured.value!.gate_id,
      document: VALID_CONSTITUTION,
    }, undefined, undefined, context);
    const details = present.details as {
      ok?: boolean;
      required_next_tool?: { name?: string; arguments?: Record<string, unknown> };
      next_action?: string;
    };
    assert.equal(details.ok, true);
    assert.equal(details.required_next_tool?.name, "constitution_checkpoint_ask_selected");
    const expectedDigest = sha256(VALID_CONSTITUTION);
    assert.deepEqual(details.required_next_tool?.arguments, {
      feature_id: selector.feature_id,
      run_key: selector.run_key,
      gate_id: ensured.value!.gate_id,
      checkpoint_id: details.required_next_tool?.arguments?.checkpoint_id,
      draft_sha256: expectedDigest,
      checkpoint_kind: "constitution_approval",
      question: "Review the canonical constitution draft and choose approve_continue or request_changes.",
    });
    assert.match(details.next_action ?? "", /^Immediately call constitution_checkpoint_ask_selected with required_next_tool\.arguments/u);
    const ask = tools.get("constitution_checkpoint_ask_selected")!;
    let askDialogInvoked = false;
    let selectorInvoked = false;
    const askResult = await ask.execute("test", details.required_next_tool!.arguments!, undefined, undefined, {
      ...context,
      ui: {
        askDialog: async (
          questions: Array<{ id: string; question: string; header?: string; options: Array<{ label: string }>; multi?: boolean }>,
          dialogOptions?: { signal?: AbortSignal },
        ) => {
          askDialogInvoked = true;
          assert.equal(questions.length, 1);
          assert.deepEqual(dialogOptions, { signal: undefined });
          assert.equal(questions[0]!.id, `constitution:${selector.feature_id}:${details.required_next_tool!.arguments!.checkpoint_id}`);
          assert.match(questions[0]!.question, /^Canonical constitution approval checkpoint:/u);
          assert.match(questions[0]!.question, /^feature_id=constitution-feature \| run_key=run-origin-1 \| stage_id=specify$/mu);
          assert.equal(questions[0]!.question.split("\n").length, 7);
          assert.ok(Buffer.byteLength(questions[0]!.question, "utf8") <= 12 * 1024);
          assert.equal(questions[0]!.question.includes("# Project Constitution"), false);
          assert.equal(questions[0]!.question.includes("Version:"), false);
          assert.equal(questions[0]!.header, "Constitution approval");
          assert.deepEqual(questions[0]!.options, [{ label: "approve_continue" }, { label: "request_changes" }]);
          assert.equal(questions[0]!.multi, false);
          return {
            kind: "submit" as const,
            results: [{
              id: questions[0]!.id,
              question: questions[0]!.question,
              header: questions[0]!.header,
              options: questions[0]!.options.map((option) => option.label),
              multi: false,
              selectedOptions: ["approve_continue"],
            }],
          };
        },
        select: async () => {
          selectorInvoked = true;
          return "request_changes";
        },
      },
    } as never);
    const oversizedPrompt = await ask.execute("test", {
      ...details.required_next_tool!.arguments!,
      question: "x".repeat(20_000),
    }, undefined, undefined, context);
    const oversizedDetails = oversizedPrompt.details as { ok?: boolean; code?: string };
    assert.equal(oversizedDetails.ok, false);
    assert.equal(oversizedDetails.code, "CONSTITUTION_CHECKPOINT_ASK_REJECTED");
    assert.equal(askDialogInvoked, true);
    assert.equal(selectorInvoked, false);
    const askDetails = askResult.details as {
      ok?: boolean;
      actor_provenance?: { kind?: string; ref?: string; proof?: Record<string, unknown> };
      required_next_tool?: { name?: string; arguments?: Record<string, unknown> };
      next_action?: string;
    };
    assert.equal(askDetails.ok, true);
    assert.equal(askDetails.actor_provenance?.kind, "user");
    assert.ok(askDetails.actor_provenance?.proof?.answer_id);
    assert.equal(askDetails.required_next_tool?.name, "decide_constitution_checkpoint");
    assert.deepEqual(askDetails.required_next_tool?.arguments, {
      feature_id: selector.feature_id,
      run_key: selector.run_key,
      gate_id: ensured.value!.gate_id,
      checkpoint_id: details.required_next_tool!.arguments!.checkpoint_id,
      decision: "approve_continue",
      authorization: "human",
      actor_provenance: askDetails.actor_provenance,
    });
    assert.match(askDetails.next_action ?? "", /^Immediately call decide_constitution_checkpoint with required_next_tool\.arguments/u);
    const decide = await tools.get("decide_constitution_checkpoint")!.execute(
      "test",
      askDetails.required_next_tool!.arguments!,
      undefined,
      undefined,
      context,
    );
    const decideDetails = decide.details as {
      ok?: boolean;
      completed_prerequisite?: { kind?: string; status?: string; gate_id?: string };
      next_action?: string;
    };
    assert.equal(decideDetails.ok, true);
    assert.deepEqual(decideDetails.completed_prerequisite, {
      kind: "project_constitution",
      status: "approved",
      gate_id: ensured.value!.gate_id,
      origin_kind: "native_direct",
      origin_run_key: selector.run_key,
      origin_stage: "specify",
    });
    assert.match(decideDetails.next_action ?? "", /constitution prerequisite is complete/u);

    const downstreamTools = new Map<string, { execute: (...args: never[]) => Promise<{ details: unknown }> }>();
    registerTestWorkflowTools(root, {
      zod: { z },
      on: TEST_ON,
      resolveCwd: (ctx: unknown) => (ctx as { cwd?: string }).cwd,

      registerTool(tool: { name: string; execute: (...args: never[]) => Promise<{ details: unknown }> }) {
        downstreamTools.set(tool.name, tool);
      },
    } as never, {}, "core-test-constitution-tools");
    const downstream = await downstreamTools.get("workflow_begin")!.execute("test", selector, undefined, undefined, context);
    const downstreamDetails = downstream.details as {
      ok?: boolean;
      code?: string;
      required_next_tool?: unknown;
      next_action?: string;
    };
    assert.equal(downstreamDetails.required_next_tool, undefined, "an approved origin workspace no longer needs a synthetic prerequisite replay");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("constitution Ask uses a trusted RPC session UI for UI-less tool contexts and drops it on session switch", async () => {
  const root = makeProject();
  const switchedRoot = makeProject();
  try {
    seedDecisionWorkspace(root);
    seedDecisionWorkspace(switchedRoot);
    const tools = new Map<string, { execute: (...args: never[]) => Promise<{ details: unknown }> }>();
    const sessionStarts: Array<(event: unknown, ctx: unknown) => unknown> = [];
    const sessionManager = { getSessionId: () => "constitution-main-session", getCwd: () => root };
    const phases: Array<{ phase: string; source?: string; api?: string; outcome?: string }> = [];
    let profileAskCalls = 0;
    registerTestConstitutionTools(root, {
      zod: z,
      on(event: string, handler: (event: unknown, ctx: unknown) => unknown) {
        if (event === "session_start") sessionStarts.push(handler);
      },
      registerTool(tool: { name: string; execute: (...args: never[]) => Promise<{ details: unknown }> }) {
        tools.set(tool.name, tool);
      },
    } as never, { onAskPhase: diagnostic => phases.push(diagnostic) });
    sessionStarts[0]!({}, {
      mode: "rpc",
      hasUI: true,
      sessionManager,
      ui: { askDialog: async () => undefined },
    });
    const ask = tools.get("constitution_checkpoint_ask_selected");
    assert.ok(ask, "constitution Ask tool must be mounted");
    const selector = workspaceSelector();
    const ensure = await tools.get("ensure_project_constitution")!.execute("test", {
      ...selector,
      origin_kind: "native_direct",
      origin_run_key: selector.run_key,
      origin_stage: "specify",
    }, undefined, undefined, { cwd: root, hasUI: true, sessionManager } as never);
    assert.equal((ensure.details as { ok?: boolean }).ok, true, JSON.stringify(ensure.details));
    const ensured = ensure.details as { value?: { gate_id?: string } };
    assert.ok(ensured.value?.gate_id);
    const present = await tools.get("present_constitution_draft")!.execute("test", {
      ...selector,
      gate_id: ensured.value!.gate_id,
      document: VALID_CONSTITUTION,
    }, undefined, undefined, { cwd: root, hasUI: true, sessionManager } as never);
    const presentDetails = present.details as { ok?: boolean; required_next_tool?: { arguments?: Record<string, unknown> } };
    assert.equal(presentDetails.ok, true, JSON.stringify(present.details));
    const askArguments = presentDetails.required_next_tool?.arguments;
    assert.ok(askArguments);

    const noProfile = await ask.execute("test", askArguments!, undefined, undefined, {
      cwd: root,
      hasUI: false,
      sessionManager: { getSessionId: () => "constitution-main-session", getCwd: () => root },
    } as never);
    assert.equal((noProfile.details as { ok?: boolean }).ok, false);
    assert.equal((noProfile.details as { code?: string }).code, "REGISTRATION_FAILED");
    assert.match((noProfile.details as { error?: string }).error ?? "", /activation_identity_changed/);

    sessionStarts[0]!({}, {
      mode: "rpc",
      hasUI: true,
      sessionManager,
      ui: {
        askDialog: async (questions: Array<{ id: string; question: string; header?: string; options: Array<{ label: string }>; multi?: boolean }>) => {
          profileAskCalls += 1;
          const question = questions[0]!;
          return {
            kind: "submit" as const,
            results: [{
              id: question.id,
              question: question.question,
              header: question.header,
              options: question.options.map((option) => option.label),
              selectedOptions: ["approve_continue"],
              multi: false,
            }],
          };
        },
      },
    });
    const authorized = await ask.execute("test", askArguments!, undefined, undefined, {
      cwd: root,
      hasUI: true,
      sessionManager,
    } as never);
    const authorizedDetails = authorized.details as Record<string, unknown>;
    assert.equal(authorizedDetails.ok, true, JSON.stringify(authorized.details));
    assert.equal("ask_diagnostics" in authorizedDetails, false, "successful Ask output must remain free of diagnostics");
    assert.equal(profileAskCalls, 1);
    assert.deepEqual(phases.map((phase) => phase.phase), [
      "validation_start",
      "validation_end",
      "surface_selected",
      "ui_invoke",
      "ui_resolve",
      "proof_commit",
    ]);
    assert.equal(phases.find((phase) => phase.phase === "surface_selected")?.source, "captured_profile");

    sessionStarts[0]!({}, {
      mode: "rpc",
      sessionManager,
      hasUI: true,
      ui: {
        askDialog: async (questions: Array<{ id: string; question: string; header?: string; options: Array<{ label: string }>; multi?: boolean }>) => ({
          kind: "cancel" as const,
          reason: "user_cancelled",
          results: questions.map((question) => ({
            id: question.id,
            question: question.question,
            header: question.header,
            options: question.options.map((option) => option.label),
            selectedOptions: [],
            multi: false,
          })),
        }),
      },
    });
    const declined = await ask.execute("test", askArguments!, undefined, undefined, {
      cwd: root,
      hasUI: false,
      sessionManager,
    } as never);
    const declinedDetails = declined.details as { ok?: boolean; code?: string; ask_diagnostics?: Array<{ phase?: string; source?: string }> };
    assert.equal(declinedDetails.ok, false);
    assert.equal(declinedDetails.code, "CONSTITUTION_CHECKPOINT_DECLINED");
    assert.deepEqual(declinedDetails.ask_diagnostics?.map((phase) => phase.phase), [
      "validation_start",
      "validation_end",
      "surface_selected",
      "ui_invoke",
      "ui_resolve",
    ]);
    assert.equal(declinedDetails.ask_diagnostics?.find((phase) => phase.phase === "surface_selected")?.source, "captured_profile");

    sessionStarts[0]!({}, { mode: "print", hasUI: false, sessionManager });
    const switched = await ask.execute("test", askArguments!, undefined, undefined, { cwd: switchedRoot, hasUI: false, sessionManager } as never);
    assert.equal((switched.details as { ok?: boolean }).ok, false);
    assert.equal((switched.details as { code?: string }).code, "WORKFLOW_CONTEXT_REJECTED");
    assert.equal(profileAskCalls, 1, "a headless session switch must not reuse the prior RPC UI bridge");
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(switchedRoot, { recursive: true, force: true });
  }
});

test("workflow preflight fails closed for malformed or oversized gate bytes and root swaps", async () => {
  const root = makeProject();
  const outside = makeProject();
  const selector = workspaceSelector();
  try {
    seedDecisionWorkspace(root);
    const ensured = ensureProjectConstitution(root, originDescriptor("native_direct"));
    assert.equal(ensured.ok, true, ensured.ok ? "constitution gate created" : ensured.error);
    if (!ensured.ok) return;
    const gatePath = join(root, ".work-state", "specification", "constitution", "gate.json");
    const tools = new Map<string, { execute: (...args: never[]) => Promise<{ details: unknown }> }>();
    const validGate = JSON.parse(readFileSync(gatePath, "utf8")) as Record<string, unknown>;
    registerTestWorkflowTools(root, {
      zod: { z },
      on: TEST_ON,
      resolveCwd: (ctx: unknown) => (ctx as { cwd?: string }).cwd,
      registerTool(tool: { name: string; execute: (...args: never[]) => Promise<{ details: unknown }> }) {
        tools.set(tool.name, tool);
      },
    } as never);
    const begin = tools.get("workflow_begin");
    assert.ok(begin);
    if (!begin) return;
    const invoke = () => begin.execute("test", selector, undefined, undefined, TEST_CONTEXT(root) as never);
    for (const malformed of [
      Buffer.from("{", "utf8"),
      Buffer.from([0xff, 0xfe, 0xfd]),
      Buffer.alloc(8 * 1024 * 1024 + 1, 0x78),
    ]) {
      writeFileSync(gatePath, malformed);
      const result = await invoke();
      const details = result.details as { ok?: boolean; code?: string; required_next_tool?: unknown };
      assert.equal(details.ok, false);
      assert.equal(details.code, "SPEC_STATE_INVALID");
      assert.equal("required_next_tool" in details, false, "malformed gate must never expose a foreign next tool");
    }
    const fifoGate = {
      ...validGate,
      drafts: [...(Array.isArray(validGate.drafts) ? validGate.drafts : []), { version: 99 }],
    };
    writeFileSync(gatePath, JSON.stringify(fifoGate), "utf8");
    const fifoResult = await invoke();
    const fifoDetails = fifoResult.details as { ok?: boolean; code?: string; required_next_tool?: unknown };
    assert.equal(fifoDetails.ok, false);
    assert.equal(fifoDetails.code, "SPEC_STATE_INVALID");
    assert.equal("required_next_tool" in fifoDetails, false, "malformed latest draft must not advance FIFO state");
    writeFileSync(join(outside, "gate.json"), JSON.stringify(validGate), "utf8");
    rmSync(gatePath);
    symlinkSync(join(outside, "gate.json"), gatePath, "file");
    const symlinkResult = await invoke();
    const symlinkDetails = symlinkResult.details as { ok?: boolean; code?: string; required_next_tool?: unknown };
    assert.equal(symlinkDetails.ok, false);
    assert.equal("required_next_tool" in symlinkDetails, false, "gate symlink must not expose a foreign next tool");
    rmSync(gatePath);
    writeFileSync(gatePath, JSON.stringify(validGate), "utf8");
    const ancestor = join(root, ".work-state");
    const displacedAncestor = `${root}-work-state-displaced`;
    renameSync(ancestor, displacedAncestor);
    symlinkSync(join(outside, ".work-state"), ancestor, "dir");
    const ancestorResult = await invoke();
    const ancestorDetails = ancestorResult.details as { ok?: boolean; required_next_tool?: unknown };
    assert.equal(ancestorDetails.ok, false);
    assert.equal("required_next_tool" in ancestorDetails, false, "ancestor replacement must not expose a foreign next tool");
    rmSync(ancestor, { recursive: true, force: true });
    rmSync(displacedAncestor, { recursive: true, force: true });
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }

  const swappedRoot = makeProject();
  const displaced = `${swappedRoot}-displaced`;
  const originalReadFile = PinnedProjectRoot.prototype.readFile;
  let swapped = false;
  try {
    seedDecisionWorkspace(swappedRoot);
    const ensured = ensureProjectConstitution(swappedRoot, originDescriptor("native_direct"));
    assert.equal(ensured.ok, true, ensured.ok ? "constitution gate created" : ensured.error);
    if (!ensured.ok) return;
    const tools = new Map<string, { execute: (...args: never[]) => Promise<{ details: unknown }> }>();
    registerTestWorkflowTools(swappedRoot, {
      zod: { z },
      on: TEST_ON,
      resolveCwd: (ctx: unknown) => (ctx as { cwd?: string }).cwd,
      registerTool(tool: { name: string; execute: (...args: never[]) => Promise<{ details: unknown }> }) {
        tools.set(tool.name, tool);
      },
    } as never);
    const begin = tools.get("workflow_begin");
    assert.ok(begin);
    if (!begin) return;
    PinnedProjectRoot.prototype.readFile = function(this: PinnedProjectRoot, relativeFile: string, options: { maxBytes?: number } = {}) {
      let result;
      try {
        result = originalReadFile.call(this, relativeFile, options);
      } finally {
        if (!swapped) {
          swapped = true;
          renameSync(swappedRoot, displaced);
          mkdirSync(swappedRoot);
        }
      }
      return result;
    };
    const result = await begin.execute("test", selector, undefined, undefined, TEST_CONTEXT(swappedRoot) as never);
    const details = result.details as { ok?: boolean; code?: string; error?: string; required_next_tool?: unknown };
    assert.equal(details.ok, false);
    assert.equal(details.code, "REGISTRATION_FAILED");
    assert.match(details.error ?? "", /root identity|project root identity|registration context|activation[_ ]identity[_ ]changed/i);
    assert.equal("required_next_tool" in details, false, "root swaps must not expose a foreign next tool");
  } finally {
    PinnedProjectRoot.prototype.readFile = originalReadFile;
    rmSync(swappedRoot, { recursive: true, force: true });
    rmSync(displaced, { recursive: true, force: true });
  }
});
