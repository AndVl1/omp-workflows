/**
 * Core engine smoke coverage for the v2 clean cutover.
 *
 * The eager host and strict policy boundaries are covered by focused v2 tests;
 * this file keeps profile and engine behavior checks.
 *
 * <!-- omp-cto-slice run=01a03ee4-7dd6-7580-8ad7-16d26dc886ba slice=workflow-v2-core -->
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import {
  reopenFromFeedback,
  resolveWorkflow,
} from "../src/index.js";
import { createProviderCatalog, loadProfileByIdentity } from "../src/engine/profile.js";
import { readWorkflowProfile, workflowV2Fixture } from "./workflow-v2-fixtures.js";
import { classificationToolGate } from "../src/gates/classification.js";
import { createTaskCaller, runStage, type TaskToolLike } from "../src/engine/stage.js";

test("core: selected provider catalog resolves only its digest-pinned profile", () => {
  const profile = readWorkflowProfile("lightweight");
  const catalog = createProviderCatalog([profile]);
  const entry = catalog.profiles.find((candidate) => candidate.identity.id === profile.name);
  assert.ok(entry, "selected provider catalog publishes lightweight");
  if (!entry) return;
  const loaded = loadProfileByIdentity(catalog, entry.identity);
  assert.equal(loaded.ok, true);
  if (loaded.ok) {
    assert.equal(loaded.value.name, profile.name);
    assert.deepEqual(loaded.value.stages.map((stage) => stage.id), [
      "discovery", "implementation", "code_review", "review_fixes", "qa_tests", "summary",
    ]);
  }
  const stale = loadProfileByIdentity(catalog, {
    id: entry.identity.id,
    fingerprint: `sha256:${"f".repeat(64)}` as typeof entry.identity.fingerprint,
  });
  assert.equal(stale.ok, false);
  if (!stale.ok) assert.equal(stale.diagnostics[0]?.code, "IDENTITY_MISMATCH");
});

test("core: resolveWorkflow matrix", () => {
  assert.equal(resolveWorkflow("FEATURE", "QUICK", false), "lightweight");
  assert.equal(resolveWorkflow("FEATURE", "MEDIUM", false), "standard");
  assert.equal(resolveWorkflow("FEATURE", "COMPLEX", false), "full-feature");
  assert.equal(resolveWorkflow("BUG_FIX", "QUICK", false), "bug-fix");
  assert.equal(resolveWorkflow("BUG_FIX", "MEDIUM", true), "debug-cycle");
  assert.equal(resolveWorkflow("HOTFIX", "QUICK", false), "emergency");
  assert.equal(resolveWorkflow("INVESTIGATION", "QUICK", false), "research");
  assert.equal(resolveWorkflow("REVIEW", "QUICK", false), "review");
  assert.equal(resolveWorkflow("PRODUCT_DISCOVERY", "QUICK", false), "product-discovery");
});

test("core: SPEC, REGRESS and PRODUCT_DISCOVERY resolve to dedicated workflows for every complexity/autonomy combination", () => {
  const complexities = ["QUICK", "MEDIUM", "COMPLEX", "CRITICAL"] as const;
  for (const type of ["SPEC", "REGRESS", "PRODUCT_DISCOVERY"] as const) {
    const expected = type === "SPEC" ? "spec-preparation" : type === "PRODUCT_DISCOVERY" ? "product-discovery" : "feature-regression";
    for (const complexity of complexities) {
      for (const autonomous of [false, true]) {
        assert.equal(
          resolveWorkflow(type, complexity, autonomous),
          expected,
          `${type}/${complexity}/autonomous=${autonomous} must keep its dedicated workflow`,
        );
      }
    }
  }
});

test("core: task gate rejects cwd-only context before reading workflow profiles", () => {
  const root = join(tmpdir(), `omp-gate-${Date.now()}`);
  mkdirSync(join(root, ".work-state"), { recursive: true });
  writeFileSync(join(root, ".work-state", ".active-feature"), "pending\n");
  try {
    const result = classificationToolGate({ toolName: "task" }, { cwd: root });
    assert.equal(result?.block, true);
    assert.match(result?.reason ?? "", /MIGRATION_REQUIRED/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("core: workflow dispatch leaves model selection to OMP", async () => {
  const calls: Array<{ agent: string; task: string; name?: string }> = [];
  const fixture = workflowV2Fixture(readWorkflowProfile("lightweight"), {
    runId: "lightweight-role-routing",
    roleAgents: { "backend-kotlin": "developer-kotlin" },
    agentNames: ["developer-kotlin", "code-reviewer", "qa"],
  });
  const state = {
    schema: 1 as const,
    branch: "feat/role-routing",
    run_key: "feat/role-routing",
    classification: { type: "FEATURE" as const, complexity: "QUICK" as const, confidence: "HIGH" as const, workflow: "lightweight" as const, autonomous: false },
    workflow: "lightweight" as const,
    profile_hash: fixture.profile_identity.fingerprint,
    task: "exercise role routing",
    workflow_override: false,
    issue: null,
    stage_cursor: "implementation",
    cursor_epoch: "test-epoch",
    stages: [{ id: "implementation", status: "in_progress" as const }],
    artifacts: {},
    pause: { kind: "none" as const, reason: "" },
    project_identity: fixture.project_identity,
    run_identity: fixture.run_identity,
    updated_at: new Date(0).toISOString(),
  };
  const outcome = await runStage(
    { id: "implementation", title: "Implementation", type: "single", role: "backend-kotlin" },
    {
      cwd: process.cwd(),
      state,
      artifactsDir: `${process.cwd()}/.work-state/artifacts`,
      flags: { scope: [], has_security: false, has_infra: false, has_ui: false, has_runtime: true, dev_agent: "developer-kotlin" },
      project_identity: fixture.project_identity,
      run_identity: fixture.run_identity,
      catalog: fixture.catalog,
      effectivePolicy: fixture.effective_policy,
      agentInventory: fixture.agent_inventory,
      agent: (role) => role === "backend-kotlin" ? "developer-kotlin" : role,
      task: {
        call: async (opts) => {
          calls.push(opts);
          return { id: "result", output: "ok", artifacts: {}, exitCode: 0 };
        },
        batch: async () => [],
      },
      pause: async () => undefined,
      log: () => undefined,
      resolveDevAgent: () => "developer-kotlin",
    },
  );
  assert.equal(outcome.status, "done");
  assert.match(calls[0]?.task ?? "", /Workflow role: backend-kotlin/);
  assert.equal(calls.length, 1);
  assert.deepEqual(Object.keys(calls[0] ?? {}).sort(), ["agent", "name", "task"]);
  assert.equal(calls[0]?.name, "implementation-backend-kotlin");
  assert.equal(calls[0]?.agent, "developer-kotlin");
});
test("core: feedback reopens affected stage and preserves history", () => {
  const state = {
    schema: 1 as const,
    branch: "feat/resume",
    classification: { type: "BUG_FIX" as const, complexity: "MEDIUM" as const, confidence: "HIGH" as const, workflow: "debug-cycle" as const, autonomous: false },
    task: "fix empty input",
    workflow_override: false,
    issue: null,
    stage_cursor: "verification",
    stages: [
      { id: "diagnosis", status: "done" as const },
      { id: "implementation", status: "done" as const },
      { id: "verification", status: "done" as const },
    ],
    artifacts: { diagnosis: "diagnosis.json", implementation: "implementation.json" },
    pause: { kind: "done" as const, reason: "" },
    updated_at: new Date(0).toISOString(),
  };
  const reopened = reopenFromFeedback(state, "empty input still crashes", "implementation");
  assert.equal(reopened.stages[0]?.status, "done");
  assert.equal(reopened.stages[1]?.status, "pending");
  assert.equal(reopened.stages[2]?.status, "pending");
  assert.match(reopened.task, /empty input still crashes/);
  assert.equal(reopened.history?.length, 1);
});

test("fullstack: agent frontmatter uses OMP class role with standard fallback", () => {
  const agentsDir = join(dirname(fileURLToPath(import.meta.url)), "../../fullstack/agents");
  const expected: Record<string, { classRole: string; fallbackRole: string; thinkingLevel: string }> = {
    analyst: { classRole: "@analyst", fallbackRole: "@task", thinkingLevel: "auto" },
    architect: { classRole: "@architect", fallbackRole: "@slow", thinkingLevel: "high" },
    "code-reviewer": { classRole: "@reviewer", fallbackRole: "@slow", thinkingLevel: "high" },
    cto: { classRole: "@cto", fallbackRole: "@slow", thinkingLevel: "high" },
    "team-lead": { classRole: "@team-lead", fallbackRole: "@task", thinkingLevel: "auto" },
    "developer-go": { classRole: "@developer-go", fallbackRole: "@task", thinkingLevel: "auto" },
    "developer-kotlin": { classRole: "@developer-kotlin", fallbackRole: "@task", thinkingLevel: "auto" },
    "developer-mobile": { classRole: "@developer-mobile", fallbackRole: "@task", thinkingLevel: "auto" },
    devops: { classRole: "@devops", fallbackRole: "@task", thinkingLevel: "auto" },
    diagnostics: { classRole: "@diagnostics", fallbackRole: "@task", thinkingLevel: "auto" },
    discovery: { classRole: "@researcher", fallbackRole: "@smol", thinkingLevel: "auto" },
    "frontend-developer": { classRole: "@frontend-developer", fallbackRole: "@task", thinkingLevel: "auto" },
    "init-mobile": { classRole: "@developer-mobile", fallbackRole: "@task", thinkingLevel: "auto" },
    "manual-qa": { classRole: "@manual-qa", fallbackRole: "@task", thinkingLevel: "auto" },
    qa: { classRole: "@qa", fallbackRole: "@task", thinkingLevel: "auto" },
    "security-tester": { classRole: "@security", fallbackRole: "@slow", thinkingLevel: "high" },
    "tech-researcher": { classRole: "@researcher", fallbackRole: "@smol", thinkingLevel: "medium" },
    "product-analyst": { classRole: "@analyst", fallbackRole: "@task", thinkingLevel: "auto" },
    "product-researcher": { classRole: "@researcher", fallbackRole: "@smol", thinkingLevel: "medium" },
    "product-critic": { classRole: "@reviewer", fallbackRole: "@slow", thinkingLevel: "high" },
    "product-strategist": { classRole: "@architect", fallbackRole: "@slow", thinkingLevel: "high" },
  };
  const supportedFields: Record<string, true> = {
    name: true,
    description: true,
    tools: true,
    spawns: true,
    model: true,
    thinkingLevel: true,
    output: true,
    autoloadSkills: true,
    readSummarize: true,
    blocking: true,
    prewalk: true,
  };
  const artifactWriterAgents = new Set([
    "analyst",
    "architect",
    "code-reviewer",
    "diagnostics",
    "security-tester",
    "tech-researcher",
  ]);
  const files = readdirSync(agentsDir).filter((name) => name.endsWith(".md"));
  assert.equal(files.length, Object.keys(expected).length);
  for (const file of files) {
    const content = readFileSync(join(agentsDir, file), "utf8");
    const frontmatter = content.match(/^---\n([\s\S]*?)\n---/)?.[1];
    assert.ok(frontmatter, `${file}: missing frontmatter`);
    const fields = Object.fromEntries(
      frontmatter.split("\n").flatMap((line) => {
        const match = line.match(/^([A-Za-z][A-Za-z0-9]*):\s*(.*)$/);
        return match?.[1] ? [[match[1], match[2] ?? ""]] : [];
      }),
    );
    for (const field of Object.keys(fields)) assert.ok(supportedFields[field], `${file}: unsupported ${field}`);
    const name = fields.name;
    assert.ok(name && expected[name], `${file}: unexpected agent name ${name}`);
    const modelMatch = fields.model?.match(/^\[\s*"(@[^"]+)"\s*,\s*"(@[^"]+)"\s*\]\s*$/);
    assert.ok(modelMatch, `${name}: model must be ["@class-role", "@fallback-role"]`);
    assert.equal(modelMatch?.[1], expected[name].classRole, `${name}: class role`);
    assert.equal(modelMatch?.[2], expected[name].fallbackRole, `${name}: standard fallback`);
    assert.equal(fields.thinkingLevel, expected[name].thinkingLevel, `${name}: reasoning level`);
    const tools = (fields.tools ?? "").split(",").map((tool) => tool.trim()).filter(Boolean);
    assert.ok(tools.every((tool) => tool === tool.toLowerCase()), `${name}: tool ids must be lowercase`);
    if (artifactWriterAgents.has(name)) {
      assert.ok(tools.includes("write"), `${name}: artifact-producing workflow roles must be able to write typed artifacts`);
    }
  }
});

test("core: consilium preserves role variants without pinning models", async () => {
  let dispatched: Array<{ name: string; agent: string; task: string }> = [];
  const fixture = workflowV2Fixture(readWorkflowProfile("full-feature"), {
    runId: "full-feature-role-routing",
    roleAgents: {
      architect_minimal: "architect",
      architect_clean: "architect",
      architect_pragmatic: "architect",
    },
    agentNames: ["analyst", "tech-researcher", "architect", "developer-kotlin", "code-reviewer", "manual-qa", "qa"],
  });
  const state = {
    schema: 1 as const,
    branch: "feat/role-routing",
    run_key: "feat/role-routing",
    classification: { type: "FEATURE" as const, complexity: "COMPLEX" as const, confidence: "HIGH" as const, workflow: "full-feature" as const, autonomous: false },
    workflow: "full-feature" as const,
    profile_hash: fixture.profile_identity.fingerprint,
    task: "compare architecture variants",
    workflow_override: false,
    issue: null,
    stage_cursor: "architecture",
    cursor_epoch: "test-epoch",
    stages: [{ id: "architecture", status: "in_progress" as const }],
    artifacts: {},
    pause: { kind: "none" as const, reason: "" },
    project_identity: fixture.project_identity,
    run_identity: fixture.run_identity,
    updated_at: new Date(0).toISOString(),
  };
  const roles = ["architect_minimal", "architect_clean", "architect_pragmatic"];
  const outcome = await runStage(
    { id: "architecture", title: "Architecture", type: "consilium", roles },
    {
      cwd: process.cwd(),
      state,
      artifactsDir: `${process.cwd()}/.work-state/artifacts`,
      flags: { scope: [], has_security: false, has_infra: false, has_ui: false, has_runtime: true, dev_agent: null },
      project_identity: fixture.project_identity,
      run_identity: fixture.run_identity,
      catalog: fixture.catalog,
      effectivePolicy: fixture.effective_policy,
      agentInventory: fixture.agent_inventory,
      agent: () => "architect",
      task: createTaskCaller({
        async execute(_toolCallId, params) {
          const tasks = params.tasks as Array<{ name: string; agent: string; task: string }>;
          dispatched = tasks;
          return {
            output: {
              results: tasks.map(() => ({ output: "ok", artifacts: {}, exitCode: 0 })),
            },
          };
        },
      } satisfies TaskToolLike),
      pause: async () => undefined,
      log: () => undefined,
      resolveDevAgent: () => null,
    },
  );
  assert.equal(outcome.status, "done");
  assert.deepEqual(dispatched.map(({ name, agent }) => ({ name, agent })), roles.map((role) => ({ name: `architecture-${role}`, agent: "architect" })));
  for (const [index, task] of dispatched.entries()) {
    assert.deepEqual(Object.keys(task).sort(), ["agent", "name", "task"]);
    assert.match(task.task, new RegExp(`Workflow role: ${roles[index]}`));
  }
});



test("core: public surface exposes one eager v2 host and no legacy adapters", async () => {
  const core = await import("../src/index.js");
  assert.equal(typeof core.registerTeamWorkflow, "function");
  assert.equal(typeof core.registerWorkflowV2Host, "function");
  assert.equal(typeof core.buildProjectIdentity, "function");
  assert.equal(typeof core.buildWorkflowRunIdentity, "function");
  assert.equal(typeof core.projectRuntimeKeyFor, "function");
  assert.equal("buildIdentityEnvelope" in core, false);
  assert.equal("validateIdentityEnvelope" in core, false);
  assert.equal("normalizeChannelConfig" in core, false);
  assert.equal("writeRuntimeConfig" in core, false);
  assert.deepEqual([...core.WORKFLOW_V2_CANONICAL_COMMANDS], [
    "do-work",
    "team",
    "cto",
    "workflow-provider",
    "init-team",
  ]);
  assert.deepEqual([...core.WORKFLOW_V2_WORKFLOW_TOOLS], [
    "workflow_prepare",
    "workflow_begin",
    "workflow_status",
    "workflow_instructions",
    "workflow_complete",
    "workflow_checkpoint",
    "workflow_advance",
  ]);
  assert.equal("defaultFullstackRoles" in core, false);
  assert.equal("defaultFullstackModelRoles" in core, false);
});
