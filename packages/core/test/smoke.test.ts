/**
 * Smoke test for the package split.
 *
 * Verifies:
 *   1. @andvl1/omp-workflows-core resolves and exports the public API.
 *   2. @andvl1/omp-workflows-fullstack can import core and call registerTeamWorkflow.
 *   3. The public API surface (8 profiles) is reachable end-to-end.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import {
  registerTeamWorkflow,
  defaultFullstackRoles,
  loadAllProfiles,
  registerWorkflowProfiles,
  resolveWorkflow,
  selectProfile,
  reopenFromFeedback,
} from "@andvl1/omp-workflows-core";
import { classificationToolGate } from "../src/gates/classification.js";
import { runStage } from "../src/engine/stage.js";

test("core: loadAllProfiles returns reusable core profiles", async () => {
  const profiles = await loadAllProfiles();
  assert.ok(profiles.length >= 11);
  const names = profiles.map((p) => p.name);
  for (const name of ["lightweight", "full-feature", "debug-cycle", "cto", "android-feature-regression", "android-spec-preparation"]) {
    assert.ok(names.includes(name), `${name} profile is shipped`);
  }
  assert.ok(profiles.find((p) => p.name === "android-feature-regression")?.stages.every((stage) => stage.prompt), "regression stages carry prompts");
  assert.ok(profiles.find((p) => p.name === "android-spec-preparation")?.stages.every((stage) => stage.prompt), "spec stages carry prompts");

  // The CTO profile is explicit-only: no classification may select it.
  for (const type of ["FEATURE", "REFACTOR", "OPS", "BUG_FIX", "INVESTIGATION", "REVIEW", "HOTFIX"] as const) {
    for (const complexity of ["QUICK", "MEDIUM", "COMPLEX", "CRITICAL"] as const) {
      const selected = selectProfile(profiles, { type, complexity, confidence: "HIGH", workflow: "standard", autonomous: false });
      assert.notEqual(selected?.name, "cto", `${type}/${complexity} must not select cto`);
    }
  }
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
});

test("core: selectProfile resolves to the right profile", async () => {
  const profiles = await loadAllProfiles();
  const p = selectProfile(profiles, {
    type: "FEATURE", complexity: "QUICK", confidence: "HIGH", workflow: "lightweight", autonomous: false,
  });
  assert.ok(p);
  assert.equal(p.name, "lightweight");
  assert.deepEqual(p.stages.map((s) => s.id), [
    "discovery", "implementation", "code_review", "review_fixes", "qa_tests", "summary",
  ]);
});
test("core: registered profiles are available and explicit workflow selects them", () => {
  const custom = {
    name: "android-feature-regression-test",
    title: "Android feature regression test",
    description: "Bundle-owned regression profile",
    match: { type: ["INVESTIGATION"] as const },
    stages: [{ id: "intake", title: "Intake", type: "orchestrator" as const }],
  };
  registerWorkflowProfiles([custom]);
  const profiles = loadAllProfiles();
  assert.equal(profiles.find((p) => p.name === custom.name)?.title, custom.title);
  const selected = selectProfile(profiles, {
    type: "INVESTIGATION", complexity: "MEDIUM", confidence: "HIGH", workflow: custom.name, autonomous: false,
  });
  assert.equal(selected?.name, custom.name);
});

test("core: defaultFullstackRoles includes generic regression roles", () => {
  const keys = Object.keys(defaultFullstackRoles);
  assert.ok(keys.length >= 16);
  assert.equal(defaultFullstackRoles["backend-kotlin"], "developer-kotlin");
  assert.equal(defaultFullstackRoles["frontend"], "frontend-developer");
  assert.equal(defaultFullstackRoles["mobile"], "developer-mobile");
  assert.equal(defaultFullstackRoles["regression-planner"], "analyst");
  assert.equal(defaultFullstackRoles["feature-regression"], "manual-qa");
  assert.equal(defaultFullstackRoles["regression-oracle"], "qa");
});

test("core: registerTeamWorkflow registers gates but NOT commands", () => {
	const calls: Array<{ kind: string; key: string }> = [];
	const fakePi = {
		setLabel: (label: string) => {
			calls.push({ kind: "setLabel", key: label });
		},
		on: (event: string) => {
			calls.push({ kind: "on", key: event });
			return undefined;
		},
		registerCommand: (name: string) => {
			calls.push({ kind: "registerCommand", key: name });
		},
	};
	registerTeamWorkflow(fakePi as unknown as Parameters<typeof registerTeamWorkflow>[0], {
		label: "smoke-test",
		roles: defaultFullstackRoles,
	});

	assert.ok(calls.some((c) => c.kind === "on" && c.key === "before_agent_start"));
	assert.ok(calls.some((c) => c.kind === "on" && c.key === "session_stop"));
	assert.ok(calls.some((c) => c.kind === "on" && c.key === "tool_call"));
	// Slash commands now ship as OMP custom-TS commands in the bundle;
	// the extension must not call registerCommand for any of them.
	assert.equal(
		calls.filter((c) => c.kind === "registerCommand").length,
		0,
		"extension must not register slash commands",
	);
});
test("core: task gate blocks launches without zero-step state", () => {
  const root = join(tmpdir(), `omp-gate-${Date.now()}`);
  mkdirSync(join(root, ".work-state"), { recursive: true });
  writeFileSync(join(root, ".work-state", ".active-feature"), "pending\n");
  try {
    const result = classificationToolGate({ toolName: "task" }, { cwd: root });
    assert.equal(result?.block, true);
    assert.match(result?.reason ?? "", /PHASE 0/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
test("core: workflow dispatch leaves model selection to OMP", async () => {
  const calls: Array<{ agent: string; task: string }> = [];
  const state = {
    schema: 1 as const,
    branch: "feat/role-routing",
    classification: { type: "FEATURE" as const, complexity: "QUICK" as const, confidence: "HIGH" as const, workflow: "lightweight" as const, autonomous: false },
    task: "exercise role routing",
    workflow_override: false,
    issue: null,
    stage_cursor: "implementation",
    stages: [{ id: "implementation", status: "in_progress" as const }],
    artifacts: {},
    pause: { kind: "none" as const, reason: "" },
    updated_at: new Date(0).toISOString(),
  };
  const outcome = await runStage(
    { id: "implementation", title: "Implementation", type: "single", role: "backend-kotlin" },
    {
      cwd: process.cwd(),
      state,
      artifactsDir: `${process.cwd()}/.work-state/artifacts`,
      flags: { scope: [], has_security: false, has_infra: false, has_ui: false, has_runtime: true, dev_agent: "developer-kotlin" },
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
  assert.deepEqual(Object.keys(calls[0] ?? {}).sort(), ["agent", "task"]);
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
  }
});

test("core: consilium preserves role variants without pinning models", async () => {
  let dispatched: Array<{ name: string; agent: string; task: string }> = [];
  const state = {
    schema: 1 as const,
    branch: "feat/role-routing",
    classification: { type: "FEATURE" as const, complexity: "COMPLEX" as const, confidence: "HIGH" as const, workflow: "full-feature" as const, autonomous: false },
    task: "compare architecture variants",
    workflow_override: false,
    issue: null,
    stage_cursor: "architecture",
    stages: [{ id: "architecture", status: "in_progress" as const }],
    artifacts: {},
    pause: { kind: "none" as const, reason: "" },
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
      agent: () => "architect",
      task: {
        call: async () => ({ id: "unused", output: "", artifacts: {}, exitCode: 0 }),
        batch: async ({ tasks }) => {
          dispatched = tasks;
          return tasks.map((_, index) => ({ id: String(index), output: "ok", artifacts: {}, exitCode: 0 }));
        },
      },
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



test("fullstack: bundle imports core and registers engine", async () => {
  const core = await import("@andvl1/omp-workflows-core");
  assert.equal(typeof core.registerTeamWorkflow, "function");
  assert.equal(typeof core.defaultFullstackRoles, "object");
  assert.equal(Object.keys(core.defaultFullstackRoles).length, 16);
});

test("fullstack: default empty registerTeamWorkflow does not crash", () => {
  const fakePi = {
    setLabel: () => undefined,
    on: () => undefined,
    registerCommand: () => undefined,
  };
  assert.doesNotThrow(() => registerTeamWorkflow(fakePi as unknown as Parameters<typeof registerTeamWorkflow>[0]));
});
