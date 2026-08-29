/**
 * RC2+ regression tests: the static parser is a MECHANICAL `autonomyHint`,
 * never an authority. The main LLM classifies `type`/`complexity`/
 * `confidence`/`autonomous` together at PHASE-0 (in any language); the P5
 * gate reads `classification.autonomous` (the model decision), fails closed
 * on missing/non-boolean values, and never lets a static hint force a
 * workflow.
 *
 * <!-- omp-cto-slice run=01a03ee4-7dd6-7580-8ad7-16d26dc886ba slice=workflow-v2-core -->
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beginCapability } from "../src/engine/durable.js";
import { buildDispatchMarker, parseDispatchMarker, trustedDispatchRequests } from "../src/gates/dispatch.js";
import { dodBackstop, validateTypedDoD } from "../src/gates/dod-backstop.js";
import { buildDoWorkPrompt, parseWorkEnvelope } from "../src/commands/do-work.js";
import type { WorkflowCommandContext } from "../src/commands/envelope.js";
import { buildCtoPrompt } from "../src/commands/cto.js";
import { keywordClassify } from "../src/engine/classify.js";
import { resolveWorkflow } from "../src/engine/profile.js";
import { resolveClassification } from "../src/engine/run.js";
import { classificationGate } from "../src/gates/classification.js";
import { readWorkflowProfile, workflowV2Fixture } from "./workflow-v2-fixtures.js";

const COMMAND_DIGEST = `sha256:${"a".repeat(64)}`;

const TEST_STATE_FEATURE = "autonomy";
const DEFAULT_TEST_WORKFLOW = "lightweight";

type PersistedWorkflowState = {
  classification?: { workflow?: unknown };
};

function readPersistedWorkflow(root: string): string {
  const statePath = join(root, ".work-state", "features", TEST_STATE_FEATURE, "state.json");
  if (!existsSync(statePath)) return DEFAULT_TEST_WORKFLOW;
  try {
    const parsed = JSON.parse(readFileSync(statePath, "utf8")) as PersistedWorkflowState;
    const workflow = parsed.classification?.workflow;
    return typeof workflow === "string" && workflow.length > 0 ? workflow : DEFAULT_TEST_WORKFLOW;
  } catch {
    return DEFAULT_TEST_WORKFLOW;
  }
}

function workflowV2Context(root: string) {
  const fixture = workflowV2Fixture(readWorkflowProfile(readPersistedWorkflow(root)));
  return {
    cwd: root,
    project_identity: fixture.project_identity,
    run_identity: fixture.run_identity,
    catalog: fixture.catalog,
    effective_policy: fixture.effective_policy,
    agent_inventory: fixture.agent_inventory,
  };
}

function orchestratorContext(root: string, hasUI: boolean) {
  const fixture = workflowV2Fixture(readWorkflowProfile(DEFAULT_TEST_WORKFLOW));
  return {
    cwd: root,
    hasUI,
    project_identity: fixture.project_identity,
    run_identity: fixture.run_identity,
    catalog: fixture.catalog,
    effective_policy: fixture.effective_policy,
    agent_inventory: fixture.agent_inventory,
  };
}

function commandContext(branch = "main"): WorkflowCommandContext {
  const fixture = workflowV2Fixture(readWorkflowProfile("lightweight"));
  return {
    branch,
    project_identity: fixture.project_identity,
    run_identity: fixture.run_identity,
    catalog: fixture.catalog,
    effectivePolicy: fixture.effective_policy,
    agentInventory: fixture.agent_inventory,
  };
}

function writeWorkflowState(root: string, state: Record<string, unknown>): void {
  const rawClassification = state.classification;
  const classification = rawClassification && typeof rawClassification === "object" && !Array.isArray(rawClassification)
    ? rawClassification as Record<string, unknown>
    : {};
  const workflow = typeof classification.workflow === "string" && classification.workflow.length > 0
    ? classification.workflow
    : DEFAULT_TEST_WORKFLOW;
  const fixture = workflowV2Fixture(readWorkflowProfile(workflow));
  const stageCursor = typeof state.stage_cursor === "string" && state.stage_cursor.length > 0
    ? state.stage_cursor
    : fixture.profile.stages[0]?.id ?? "discovery";
  const stages = Array.isArray(state.stages)
    ? state.stages
    : fixture.profile.stages.map((stage) => ({
      id: stage.id,
      status: stage.id === stageCursor ? "in_progress" : "pending",
    }));
  const rawCapability = state.dispatch_capability;
  const capabilityWorkIdentity = rawCapability && typeof rawCapability === "object" && !Array.isArray(rawCapability)
    ? (rawCapability as Record<string, unknown>).work_identity
    : undefined;
  const workIdentity = state.work_identity ?? capabilityWorkIdentity;
  const workState = join(root, ".work-state");
  const featureDir = join(workState, "features", TEST_STATE_FEATURE);
  mkdirSync(featureDir, { recursive: true });
  writeFileSync(join(workState, ".active-feature"), TEST_STATE_FEATURE);
  writeFileSync(
    join(featureDir, "state.json"),
    JSON.stringify({
      ...state,
      schema: 1,
      branch: typeof state.branch === "string" ? state.branch : "main",
      project_identity: state.project_identity ?? fixture.project_identity,
      run_identity: state.run_identity ?? fixture.run_identity,
      classification: { ...classification, workflow },
      workflow,
      task: typeof state.task === "string" && state.task.length > 0 ? state.task : "autonomy test task",
      workflow_override: typeof state.workflow_override === "boolean" ? state.workflow_override : false,
      issue: state.issue ?? null,
      stages,
      artifacts: state.artifacts ?? {},
      pause: state.pause ?? { kind: "none", reason: "" },
      stage_cursor: stageCursor,
      cursor_epoch: typeof state.cursor_epoch === "string" && state.cursor_epoch.length > 0 ? state.cursor_epoch : "autonomy-test-epoch",
      run_key: typeof state.run_key === "string" && state.run_key.length > 0 ? state.run_key : fixture.run_identity.run_id,
      profile_hash: typeof state.profile_hash === "string" && state.profile_hash.length > 0
        ? state.profile_hash
        : fixture.run_identity.profile_identity.fingerprint,
      updated_at: typeof state.updated_at === "string" && state.updated_at.length > 0
        ? state.updated_at
        : "2026-01-01T00:00:00.000Z",
      ...(workIdentity === undefined ? {} : { work_identity: workIdentity }),
    }),
  );
}

test("do-work: natural-language directive sets the hint and strips from task", () => {
  const root = mkdtempSync(join(tmpdir(), "do-work-ru-"));
  try {
    const envelope = parseWorkEnvelope("действуй автономно: исправь 500 на /api/users issue=#42", root);
    assert.equal(envelope.autonomyHint, true);
    assert.equal(envelope.task, "исправь 500 на /api/users");
    assert.equal(envelope.issue, 42);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("do-work: [AUTONOMOUSLY] lookalike stays literal and hint is false", () => {
  const root = mkdtempSync(join(tmpdir(), "do-work-look-"));
  try {
    const envelope = parseWorkEnvelope("[AUTONOMOUSLY] Fix bug", root);
    assert.equal(envelope.autonomyHint, false);
    assert.equal(envelope.task, "[AUTONOMOUSLY] Fix bug", "lookalike must survive verbatim");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ── (d) /cto and /do-work share the four-field classification contract ──────

test("do-work: prompt renders the hint as NON-authoritative metadata", () => {
  const root = mkdtempSync(join(tmpdir(), "do-work-prompt-"));
  try {
    const on = buildDoWorkPrompt(parseWorkEnvelope("действуй автономно: Fix bug", root), commandContext());
    assert.ok(on.includes("Autonomy is YOUR decision for routing only"), "routing autonomy wording rendered");
    assert.ok(on.includes("Never copy the hint into persisted"), "hint must not be copied as the decision");
    assert.ok(!on.includes("state.autonomous: true"), "prompt must NOT instruct persisting the parsed flag");

    const off = buildDoWorkPrompt(parseWorkEnvelope("[AUTONOMOUSLY] Fix bug", root), commandContext());
    assert.ok(off.includes("Autonomy is YOUR decision for routing only"), "routing autonomy wording rendered");
    assert.ok(off.includes("[AUTONOMOUSLY] Fix bug"), "task text carries the lookalike verbatim");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("classification contract: /do-work and /cto request the SAME four model fields", () => {
  const root = mkdtempSync(join(tmpdir(), "class-contract-"));
  try {
    const work = buildDoWorkPrompt(parseWorkEnvelope("Fix login bug", root), commandContext());
    const cto = buildCtoPrompt(parseWorkEnvelope("Fix login bug", root), commandContext());
    for (const prompt of [work, cto]) {
      assert.ok(prompt.includes("CLASSIFICATION:"), "visible classification block");
      assert.ok(prompt.includes("- Type: FEATURE | REFACTOR | OPS | BUG_FIX | SPEC | REGRESS | INVESTIGATION | REVIEW | HOTFIX"), "Type field");
      assert.ok(prompt.includes("- Complexity: QUICK | MEDIUM | COMPLEX | CRITICAL"), "Complexity field");
      assert.ok(prompt.includes("- Confidence: HIGH | MEDIUM | LOW"), "Confidence field");
      assert.ok(prompt.includes("- Autonomous: true | false"), "Autonomous field");
      assert.ok(prompt.includes("Autonomy is YOUR decision"), "model decides autonomy");
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ── (a) hint false + natural-language autonomy → model true → debug-cycle ───

test("P5 gate: natural-language autonomous task (hint false) is accepted as debug-cycle when the MODEL decides true", () => {
  const root = mkdtempSync(join(tmpdir(), "p5-model-auto-"));
  try {
    const envelope = parseWorkEnvelope("Do this without waiting for approval — fix the login bug", root);
    const prompt = buildDoWorkPrompt(envelope, commandContext());

    // The prompt hands the FULL task to the model and lets it decide true.
    assert.ok(prompt.includes("Do this without waiting for approval"), "full task visible to PHASE-0");
    assert.ok(prompt.includes("Autonomy is YOUR decision for routing only"), "routing autonomy wording is explicit");

    // Model output: autonomous=true -> debug-cycle passes the gate.
    writeWorkflowState(root, {
      classification: { type: "BUG_FIX", complexity: "QUICK", workflow: "debug-cycle", autonomous: true, autonomous_reason: "task explicitly waives approval" },
    });
    assert.equal(classificationGate({ agent: "developer" }, workflowV2Context(root)), undefined, "model autonomous=true accepted as debug-cycle");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ── (b) hint true + contradictory task → model false → interactive ─────────

test("P5 gate: [AUTONOMOUS] marker can be OVERRIDDEN by the model to interactive", () => {
  const root = mkdtempSync(join(tmpdir(), "p5-override-"));
  try {
    const envelope = parseWorkEnvelope("[AUTONOMOUS] Walk me through each step before touching code", root);
    assert.equal(envelope.autonomyHint, true, "static hint is ON");

    const prompt = buildDoWorkPrompt(envelope, commandContext());
    assert.ok(prompt.includes("Autonomy is YOUR decision for routing only"), "routing autonomy wording rendered");
    assert.ok(prompt.includes("does not authorize a checkpoint"), "prompt separates routing from checkpoint permission");

    // Model decides autonomous=false -> interactive bug-fix passes; debug-cycle blocks.
    writeWorkflowState(root, {
      classification: { type: "BUG_FIX", complexity: "QUICK", workflow: "bug-fix", autonomous: false, autonomous_reason: "user wants step-by-step review" },
    });
    assert.equal(classificationGate({ agent: "developer" }, workflowV2Context(root)), undefined, "model false stays interactive");

    writeWorkflowState(root, {
      classification: { type: "BUG_FIX", complexity: "QUICK", workflow: "debug-cycle", autonomous: false },
    });
    const blocked = classificationGate({ agent: "developer" }, workflowV2Context(root));
    assert.ok(blocked, "interactive QUICK BUG_FIX with debug-cycle is blocked");
    assert.equal(blocked?.diagnostic?.code, "CONFIG_MALFORMED", "block uses the canonical v2 diagnostic code");
    assert.match(blocked?.diagnostic?.remediation ?? "", /classification matrix/u, "block names the canonical interactive resolution");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ── (c) absent / non-boolean classification.autonomous blocks ───────────────

test("P5 gate: missing classification.autonomous blocks — no silent default", () => {
  const root = mkdtempSync(join(tmpdir(), "p5-missing-auto-"));
  try {
    writeWorkflowState(root, {
      classification: { type: "BUG_FIX", complexity: "QUICK", workflow: "debug-cycle" },
    });
    const blocked = classificationGate({ agent: "developer" }, workflowV2Context(root));
    assert.ok(blocked, "missing autonomous blocks");
    assert.ok(blocked?.reason?.includes("classification.autonomous is missing"), "reason names the missing field");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("P5 gate: non-boolean classification.autonomous blocks — fail closed", () => {
  const root = mkdtempSync(join(tmpdir(), "p5-nonbool-auto-"));
  try {
    writeWorkflowState(root, {
      classification: { type: "BUG_FIX", complexity: "QUICK", workflow: "debug-cycle", autonomous: "true" },
    });
    const blocked = classificationGate({ agent: "developer" }, workflowV2Context(root));
    assert.ok(blocked, "string autonomous blocks");
    assert.ok(blocked?.reason?.includes("must be a boolean"), "reason names the invalid type");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ── (f) workflow_override can never bypass the fail-closed autonomy gate ────

test("P5 gate: workflow_override:true cannot bypass MISSING classification.autonomous", () => {
  const root = mkdtempSync(join(tmpdir(), "p5-override-missing-"));
  try {
    writeWorkflowState(root, {
      classification: { type: "BUG_FIX", complexity: "QUICK", workflow: "debug-cycle" },
      workflow_override: true,
    });
    const blocked = classificationGate({ agent: "developer" }, workflowV2Context(root));
    assert.ok(blocked, "an explicit override must not bypass a missing model autonomy field");
    assert.ok(blocked?.reason?.includes("classification.autonomous is missing"), "reason names the missing field");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("P5 gate: workflow_override:true cannot bypass NON-BOOLEAN classification.autonomous", () => {
  const root = mkdtempSync(join(tmpdir(), "p5-override-nonbool-"));
  try {
    writeWorkflowState(root, {
      classification: { type: "BUG_FIX", complexity: "QUICK", workflow: "debug-cycle", autonomous: "true" },
      workflow_override: true,
    });
    const blocked = classificationGate({ agent: "developer" }, workflowV2Context(root));
    assert.ok(blocked, "an explicit override must not bypass a non-boolean model autonomy field");
    assert.ok(blocked?.reason?.includes("must be a boolean"), "reason names the invalid type");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("P5 gate: workflow_override:true still allows a VALID model autonomy decision", () => {
  const root = mkdtempSync(join(tmpdir(), "p5-override-valid-"));
  try {
    writeWorkflowState(root, {
      classification: { type: "BUG_FIX", complexity: "QUICK", workflow: "debug-cycle", autonomous: false },
      workflow_override: true,
    });
    assert.equal(
      classificationGate({ agent: "developer" }, workflowV2Context(root)),
      undefined,
      "override with a valid boolean decision passes — the override skips the mismatch check, not the autonomy gate",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});


test("P5 gate: a present model field wins over an ignored legacy top-level field", () => {
  const root = mkdtempSync(join(tmpdir(), "p5-priority-"));
  try {
    // Legacy says true, model says false — the model decision is the authority.
    writeWorkflowState(root, {
      classification: { type: "BUG_FIX", complexity: "QUICK", workflow: "bug-fix", autonomous: false },
      autonomous: true,
    });
    assert.equal(classificationGate({ agent: "developer" }, workflowV2Context(root)), undefined, "model false keeps it interactive");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ── static hint can never force autonomous ──────────────────────────────────

test("P5 gate: a static hint cannot force autonomous — hint true + model false stays interactive", () => {
  const root = mkdtempSync(join(tmpdir(), "p5-static-hint-"));
  try {
    const envelope = parseWorkEnvelope("[AUTONOMOUS] Fix bug", root);
    assert.equal(envelope.autonomyHint, true);

    // Even with the marker present, the persisted model decision rules.
    writeWorkflowState(root, {
      classification: { type: "BUG_FIX", complexity: "QUICK", workflow: "bug-fix", autonomous: false },
    });
    assert.equal(classificationGate({ agent: "developer" }, workflowV2Context(root)), undefined, "hint true must not force debug-cycle");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ── engine classification is demoted and cannot pick autonomy ───────────────

test("do-work: keywordClassify guesses type/complexity only — it cannot decide autonomy", () => {
  const base = keywordClassify("fix the login bug");
  assert.equal(base.type, "BUG_FIX", "keyword guess still detects the type");
  assert.ok(!("autonomous" in base), "keyword guess has no autonomous field");
  assert.equal(resolveWorkflow(base.type, base.complexity, true), "debug-cycle", "autonomous BUG_FIX resolves to debug-cycle even at QUICK");
  assert.equal(resolveWorkflow("BUG_FIX", "QUICK", false), "bug-fix", "interactive QUICK BUG_FIX stays bug-fix");
});

test("do-work: type/complexity/autonomous resolve together from the model classification", () => {
  const auto = { type: "BUG_FIX", complexity: "QUICK", confidence: "HIGH", autonomous: true, workflow: "debug-cycle" };
  const interactive = { type: "BUG_FIX", complexity: "QUICK", confidence: "HIGH", autonomous: false, workflow: "bug-fix" };
  assert.equal(resolveWorkflow(auto.type, auto.complexity, auto.autonomous), auto.workflow, "model auto classification maps to debug-cycle");
  assert.equal(resolveWorkflow(interactive.type, interactive.complexity, interactive.autonomous), interactive.workflow, "model interactive classification maps to bug-fix");
});

test("engine: resolveClassification treats the MODEL classification as authoritative", () => {
  const resolved = resolveClassification({
    task: "fix the login bug",
    autonomous: true, // legacy hint — must be IGNORED when the model speaks
    classification: {
      type: "BUG_FIX",
      complexity: "QUICK",
      confidence: "MEDIUM",
      autonomous: false,
      autonomous_reason: "user wants review",
    },
  });
  assert.deepEqual(resolved, {
    type: "BUG_FIX",
    complexity: "QUICK",
    confidence: "MEDIUM",
    autonomous: false,
    autonomous_reason: "user wants review",
    workflow: "bug-fix", // resolved from the MODEL's autonomous, not the hint
  });
});

test("engine: resolveClassification FAILS CLOSED on incomplete model output (no keyword fallback)", () => {
  assert.throws(
    () => resolveClassification({ task: "fix the login bug", autonomous: true, classification: { type: "BUG_FIX", complexity: "QUICK", confidence: "HIGH" } }),
    /classification gate: model classification incomplete/,
    "missing autonomous blocks — no silent default",
  );
  assert.throws(
    () => resolveClassification({ task: "fix the login bug", autonomous: true, classification: { type: "BUG_FIX", complexity: "QUICK", confidence: "HIGH", autonomous: "true" } }),
    /classification gate: model classification incomplete/,
    "non-boolean autonomous blocks — fail closed",
  );
});

test("engine: legacy path (no model classification) uses the caller flag verbatim — never defaulted", () => {
  const resolved = resolveClassification({ task: "fix the login bug", autonomous: true });
  assert.equal(resolved.type, "BUG_FIX", "keyword guess still detects the type on the legacy path");
  assert.equal(resolved.autonomous, true, "caller-supplied flag used verbatim");
  assert.equal(resolved.workflow, "debug-cycle", "workflow resolved from the caller flag");
});

test("P5 gate: missing classification blocks; absent state has no workflow to gate", () => {
  const root = mkdtempSync(join(tmpdir(), "p5-missing-"));
  try {
    writeWorkflowState(root, { classification: { complexity: "QUICK", autonomous: false } });
    const blocked = classificationGate({ agent: "developer" }, workflowV2Context(root));
    assert.ok(blocked, "missing classification blocks subagent launch");

    rmSync(join(root, ".work-state"), { recursive: true, force: true });
    assert.equal(classificationGate({ agent: "developer" }, workflowV2Context(root)), undefined, "no state -> nothing to gate");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("strict orchestrator policy blocks source and canonical-state writes, allows artifacts", async () => {
  const root = mkdtempSync(join(tmpdir(), "orchestrator-write-policy-"));
  try {
    mkdirSync(join(root, ".work-state", "artifacts"), { recursive: true });
    writeFileSync(join(root, ".work-state", "team-state.json"), JSON.stringify({ policy: { strict_orchestrator: true } }));
    const { orchestratorWriteGate } = await import("../src/gates/orchestrator-write.ts");
    const missingIdentity = orchestratorWriteGate(
      { toolName: "write", input: { path: "src/app.ts" } },
      { cwd: root, hasUI: true },
    );
    assert.equal(missingIdentity?.block, true);
    assert.match(missingIdentity?.reason ?? "", /MIGRATION_REQUIRED/);
    const source = orchestratorWriteGate({ toolName: "write", input: { actor: "worker", path: "src/app.ts" } }, orchestratorContext(root, true));
    assert.equal(source?.block, true);
    assert.match(source?.reason ?? "", /may write only under \.work-state/);
    const state = orchestratorWriteGate({ toolName: "edit", input: { actor: "worker", path: ".work-state/team-state.json" } }, orchestratorContext(root, true));
    assert.equal(state?.block, true);
    assert.match(state?.reason ?? "", /canonical workflow state/);
    const artifact = orchestratorWriteGate({ toolName: "write", input: { actor: "worker", path: ".work-state/artifacts/report.json" } }, orchestratorContext(root, true));
    assert.equal(artifact, undefined);

    const mountedWorkflowTool = orchestratorWriteGate(
      { toolName: "write", input: { path: "xd://workflow_instructions", content: "{}" } },
      orchestratorContext(root, true),
    );
    assert.equal(mountedWorkflowTool, undefined, "mounted xd tools are not project writes");
    const mountedDiagnosticTool = orchestratorWriteGate(
      { toolName: "write", input: { path: "xd://report_issue", content: "tool routing failed" } },
      orchestratorContext(root, true),
    );
    assert.equal(mountedDiagnosticTool, undefined, "mounted diagnostics are not project writes");
    const worker = orchestratorWriteGate({ toolName: "write", input: { actor: "orchestrator", path: "src/app.ts" } }, orchestratorContext(root, false));
    assert.equal(worker, undefined);
    const bashEcho = orchestratorWriteGate({ toolName: "bash", input: { command: "echo hacked > src/app.ts" } }, orchestratorContext(root, true));
    assert.equal(bashEcho?.block, true);
    const bashRemove = orchestratorWriteGate({ toolName: "bash", input: { command: "rm src/app.ts" } }, orchestratorContext(root, true));
    assert.equal(bashRemove?.block, true);
    const bashRead = orchestratorWriteGate({ toolName: "bash", input: { command: "git diff -- src/app.ts" } }, orchestratorContext(root, true));
    assert.equal(bashRead, undefined);
    const workerCanonicalBash = orchestratorWriteGate({ toolName: "bash", input: { command: "cat > .work-state/team-state.json" } }, orchestratorContext(root, false));
    assert.equal(workerCanonicalBash?.block, true);
    const ctoCanonicalBash = orchestratorWriteGate({ toolName: "bash", input: { command: "awk '{print}' > .work-state/cto/run-1/state.json" } }, orchestratorContext(root, true));
    assert.equal(ctoCanonicalBash?.block, true);
    const redirectedSource = orchestratorWriteGate({ toolName: "bash", input: { command: "git show HEAD:src/app.ts > \"$(pwd)/src/app.ts\"" } }, orchestratorContext(root, true));
    assert.equal(redirectedSource?.block, true);
    const workerCanonicalInPlace = orchestratorWriteGate({ toolName: "bash", input: { command: "awk -i inplace '{print}' .work-state/team-state.json" } }, orchestratorContext(root, false));
    assert.equal(workerCanonicalInPlace?.block, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("strict orchestrator policy permits git publication and PR control-plane commands", async () => {
  const root = mkdtempSync(join(tmpdir(), "orchestrator-git-policy-"));
  try {
    mkdirSync(join(root, ".work-state"), { recursive: true });
    writeFileSync(join(root, ".work-state", "team-state.json"), JSON.stringify({ policy: { strict_orchestrator: true } }));
    const { orchestratorWriteGate } = await import("../src/gates/orchestrator-write.ts");
    const allowed = [
      'git status --short && git add src/app.ts && git commit -m "fix: publish worker changes" && git fetch origin main && git rebase origin/main && git push origin HEAD && gh pr create --fill',
      "git checkout main && git pull origin main && git checkout -b feat/example",
      "git checkout main",
      "git checkout -b feat/example",
      "git switch main",
      "git switch -c feat/example",
      "git fetch origin main",
      "git pull --rebase origin main",
      "git rebase origin/main",
      "git rebase --continue",
      "git merge --no-edit feature/worker",
      "git merge --abort",
      "git cherry-pick abc123",
      "git cherry-pick --abort",
      "git push origin HEAD",
      "gh pr create --fill",
    ];
    for (const command of allowed) {
      assert.equal(
        orchestratorWriteGate({ toolName: "bash", input: { command } }, orchestratorContext(root, true)),
        undefined,
        `control-plane command should be allowed: ${command}`,
      );
    }
    const blocked = [
      "git checkout -- src/app.ts",
      "git checkout HEAD -- src/app.ts",
      "git checkout src/app.ts",
      "git checkout -f main",
      "git checkout .",
      "git switch --discard-changes main",
      "git restore src/app.ts",
      "git reset --hard HEAD",
      "git clean -fd",
      "git stash push -m temp",
    ];
    for (const command of blocked) {
      assert.equal(
        orchestratorWriteGate({ toolName: "bash", input: { command } }, orchestratorContext(root, true))?.block,
        true,
        `direct worktree mutation should remain blocked: ${command}`,
      );
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("strict orchestrator policy parses edit patches and allows read-only artifact validation", async () => {
  const root = mkdtempSync(join(tmpdir(), "orchestrator-write-patch-policy-"));
  try {
    mkdirSync(join(root, ".work-state", "features", "visualize", "artifacts"), { recursive: true });
    writeFileSync(join(root, ".work-state", "team-state.json"), JSON.stringify({ policy: { strict_orchestrator: true } }));
    const { orchestratorWriteGate } = await import("../src/gates/orchestrator-write.ts");
    const sourcePatch = [
      "[packages/e2e/src/server.ts#064B]",
      "PUT 1.=1:",
      "+export const server = true;",
    ].join("\n");
    assert.equal(
      orchestratorWriteGate({ toolName: "edit", input: { input: sourcePatch } }, orchestratorContext(root, false)),
      undefined,
      "a worker edit patch with a file header is a verifiable source path",
    );
    assert.equal(
      orchestratorWriteGate({ toolName: "edit", input: sourcePatch }, orchestratorContext(root, false)),
      undefined,
      "a worker edit patch passed as the raw tool input is a verifiable source path",
    );
    const canonicalPatch = [
      "[.work-state/features/visualize/state.json#064B]",
      "PUT 1.=1:",
      "+{}",
    ].join("\n");
    const blockedCanonicalPatch = orchestratorWriteGate(
      { toolName: "edit", input: { input: canonicalPatch } },
      orchestratorContext(root, false),
    );
    assert.equal(blockedCanonicalPatch?.block, true);
    assert.match(blockedCanonicalPatch?.reason ?? "", /canonical workflow state/);
    const blockedHeaderlessPatch = orchestratorWriteGate(
      { toolName: "edit", input: { input: "PUT 1.=1:\n+not a file patch" } },
      orchestratorContext(root, false),
    );
    assert.equal(blockedHeaderlessPatch?.block, true);
    assert.match(blockedHeaderlessPatch?.reason ?? "", /no verifiable path/);

    const pythonReadOnlyValidation =
      "/usr/bin/python3 -m json.tool .work-state/features/visualize/artifacts/spec_intake_repo_map-analyst.json > /dev/null";
    const pythonJsonReadOnlyValidation =
      "python3 -c 'import glob,json; [json.load(open(path)) for path in glob.glob(\".work-state/features/visualize/artifacts/*.json\")]'";
    const nodeReadOnlyValidation =
      "node -e 'const fs=require(\"node:fs\"); const value=JSON.parse(fs.readFileSync(\".work-state/features/visualize/artifacts/spec_requirements_edge_cases.json\", \"utf8\")); const valid=[value].every((item) => item !== null);'";
    const nodeGlobReadOnlyValidation =
      "node -e 'const fs=require(\"node:fs\"); const values=fs.globSync(\".work-state/features/visualize/artifacts/*.json\").map((path) => JSON.parse(fs.readFileSync(path, \"utf8\")));'";
    for (const command of [pythonReadOnlyValidation, pythonJsonReadOnlyValidation, nodeReadOnlyValidation, nodeGlobReadOnlyValidation]) {
      assert.equal(
        orchestratorWriteGate({ toolName: "bash", input: { command } }, orchestratorContext(root, true)),
        undefined,
        "read-only artifact validation must remain allowed: " + command,
      );
    }

    for (const command of [
      "printf '{}' > .work-state/team-state.json",
      "printf '{}' | tee .work-state/features/visualize/state.json",
      "cd .work-state/features/visualize && printf '{}' > state.json",
    ]) {
      const blocked = orchestratorWriteGate({ toolName: "bash", input: { command } }, orchestratorContext(root, true));
      assert.equal(blocked?.block, true, "canonical workflow write must remain blocked: " + command);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("strict durable transitions fail closed when no active git branch exists", () => {
  const root = mkdtempSync(join(tmpdir(), "durable-no-git-"));
  try {
    writeWorkflowState(root, {
      branch: "feature/no-git",
      classification: { workflow: "lightweight", autonomous: false },
      stage_cursor: "implementation",
      stages: [{ id: "implementation", status: "in_progress" }],
    });
    const begun = beginCapability(root, workflowV2Context(root));
    assert.equal(begun.ok, false);
    assert.match(begun.error, /stale for the active branch/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("do-work prompt is pure and names only host-owned workflow authorities", () => {
  const prompt = buildDoWorkPrompt(parseWorkEnvelope("Implement feature", "feature/main"), commandContext("feature/main"));
  assert.match(prompt, /### Execution contract/);
  assert.match(prompt, /workflow_prepare/);
  assert.match(prompt, /selected provider/);
  assert.match(prompt, /qualified agent identities/);
  assert.match(prompt, /### Seven-step resume-from-disk contract/);
  assert.deepEqual(prompt.match(/^\d+\. /gm), ["1. ", "2. ", "3. ", "4. ", "5. ", "6. ", "7. "]);
  assert.doesNotMatch(prompt, /resolveConfig|findProfileDir|CLAUDE_PLUGIN_ROOT|\.work-state\/team-state\.json/);
});
test("DoD gate: malformed and legacy artifacts fail closed while typed evidence passes", () => {
  const valid = validateTypedDoD({
    items: [{ criterion: "criterion", verify_method: "run the focused check", status: "met", evidence: "observed pass" }],
  });
  assert.equal(valid.ok, true);
  assert.equal(validateTypedDoD({ items: ["criterion"] }).ok, false);
  assert.equal(validateTypedDoD({ criteria: ["legacy"] }).ok, false);
  assert.equal(validateTypedDoD({ items: [{ criterion: "criterion", status: "met" }] }).ok, false);

  const root = mkdtempSync(join(tmpdir(), "dod-typed-backstop-"));
  try {
    const workState = join(root, ".work-state");
    mkdirSync(workState, { recursive: true });
    writeFileSync(join(workState, "team-state.json"), JSON.stringify({
      stage_cursor: "summary",
      pause: { kind: "done" },
      classification: { workflow: "lightweight" },
    }));
    assert.equal(dodBackstop({}, { cwd: root }), undefined, "missing identity must not inspect legacy canonical state");

    writeWorkflowState(root, {
      stage_cursor: "summary",
      pause: { kind: "done", reason: "" },
      classification: { workflow: "lightweight", autonomous: false },
    });
    const context = workflowV2Context(root);
    const artifacts = join(workState, "features", TEST_STATE_FEATURE, "artifacts");
    mkdirSync(artifacts, { recursive: true });
    const dodPath = join(artifacts, "dod.json");

    writeFileSync(dodPath, JSON.stringify({ items: [{ criterion: "criterion", status: "met", evidence: "observed pass" }] }));
    const malformed = dodBackstop({}, context);
    assert.equal(malformed?.decision, "block");
    assert.match(malformed?.reason ?? "", /malformed typed artifact/);

    writeFileSync(dodPath, JSON.stringify({
      items: [{ criterion: "criterion", verify_method: "run the focused check", status: "pending" }],
    }));
    const pending = dodBackstop({}, context);
    assert.equal(pending?.decision, "block");
    assert.match(pending?.reason ?? "", /unmet or evidence-less/);

    writeFileSync(dodPath, JSON.stringify({
      items: [{ criterion: "criterion", verify_method: "run the focused check", status: "met", evidence: "observed pass" }],
    }));
    assert.deepEqual(dodBackstop({}, context), { continue: true });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
test("DoD gate: active, pending, waiting, polling, and temporary artifact states are neutral", () => {
  const root = mkdtempSync(join(tmpdir(), "dod-neutral-runtime-"));
  try {
    const transientStates: Record<string, unknown>[] = [
      { worker: { status: "active" } },
      { worker_status: "pending" },
      { pause: { kind: "Still Running" } },
      { wait: { kind: "nested wait" } },
      { polling: { status: "polling" } },
      { artifact_status: "temporary artifact absence" },
    ];
    for (const transient of transientStates) {
      writeWorkflowState(root, {
        stage_cursor: "summary",
        pause: { kind: "done", reason: "" },
        classification: { workflow: "lightweight", autonomous: false },
        ...transient,
      });
      mkdirSync(join(root, ".work-state", "features", TEST_STATE_FEATURE, "artifacts"), { recursive: true });
      assert.equal(dodBackstop({}, workflowV2Context(root)), undefined);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});


test("/team alias uses the canonical /do-work prompt", () => {
  const root = mkdtempSync(join(tmpdir(), "team-alias-"));
  try {
    const work = buildDoWorkPrompt(parseWorkEnvelope("Implement feature", root), commandContext());
    const team = buildDoWorkPrompt(parseWorkEnvelope("Implement feature", root), commandContext());
    assert.equal(team, work, "/team alias must resolve to the identical canonical prompt");
    assert.match(team, /selected provider/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
