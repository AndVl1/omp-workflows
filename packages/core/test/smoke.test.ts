/**
 * Smoke test for the package split.
 *
 * Verifies:
 *   1. @andvl1/omp-workflows-core resolves and exports the public API.
 *   2. @andvl1/omp-workflows-fullstack can import core and call registerTeamWorkflow.
 *   3. The public API surface (8 profiles) is reachable end-to-end.
 */

import { test } from "node:test";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import {
  registerTeamWorkflow,
  registerWorkflowCommands,
  loadAllProfiles,
  loadArtifactSchemas,
  resolveWorkflow,
  selectProfile,
  reopenFromFeedback,
  type WorkflowOwnerIdentity,
} from "@andvl1/omp-workflows-core";
import { registerTestProfiles, writeTestRegistryMarker } from "./fixtures/registry-activation.js";
import { registerTestTeamWorkflow } from "./fixtures/host-tool-activation.js";
import { loadAllProfiles as loadSourceProfiles, selectProfile as selectSourceProfile } from "../src/engine/profile.js";
import { classificationToolGate } from "../src/gates/classification.js";
import { createTaskCaller, runStage, type TaskToolLike } from "../src/engine/stage.js";

const genericRoles = { worker: "worker" };

function commandOwner(root: string, ownerId: string): WorkflowOwnerIdentity {
  const markerPath = join(root, ".omp-smoke-activation-marker");
  const bytes = Buffer.from("core-smoke-marker\n", "utf8");
  writeFileSync(markerPath, bytes);
  const markerSha256 = createHash("sha256").update(bytes).digest("hex");
  return {
    owner_id: ownerId,
    bundle_id: ownerId,
    owner_kind: "fullstack",
    activation_marker: ownerId + "-activation",
    host_range: ">=17 <19",
    activation: { marker_id: ownerId + "-activation", required: [{ path: ".omp-smoke-activation-marker", kind: "file", sha256: markerSha256 }] },
    provenance: { package: ownerId, entrypoint: "dist/index.js", cwd: root },
  };
}

test("core: public root imports under Node without Bun-only runtime dependencies", () => {
  const repositoryRoot = join(dirname(fileURLToPath(import.meta.url)), "../..");
  const output = execFileSync(process.execPath, [
    "--input-type=module",
    "-e",
    `const core = await import("@andvl1/omp-workflows-core");
if (typeof core.registerWorkflowCommands !== "function" || typeof core.loadAllProfiles !== "function" || typeof core.loadArtifactSchemas !== "function") process.exit(1);
process.stdout.write(JSON.stringify({ marker: core.CORE_ENGINE_MARKER, commands: typeof core.registerWorkflowCommands, profiles: typeof core.loadAllProfiles, schemas: typeof core.loadArtifactSchemas }));`,
  ], { cwd: repositoryRoot, encoding: "utf8" });
  assert.deepEqual(JSON.parse(output), {
    marker: "omp-workflows-core/0.8.0",
    commands: "function",
    profiles: "function",
    schemas: "function",
  });
});

test("core: workflow commands register before project command discovery", async () => {
  const root = mkdtempSync(join(tmpdir(), "core-command-discovery-"));
  try {
  const commands = new Map<string, { handler: (args: string, ctx: unknown) => Promise<void> }>();
  const prompts: string[] = [];
  registerWorkflowCommands({
    registerCommand(name: string, command: { handler: (args: string, ctx: unknown) => Promise<void> }) {
      commands.set(name, command);
    },
    on() {},
    sendUserMessage(prompt: string) {
      prompts.push(prompt);
    },
  } as never, { cwd: root, owner: commandOwner(root, "smoke-command-discovery") });

  assert.deepEqual([...commands.keys()], ["do-work", "team", "cto", "specify", "spec-plan", "spec-tasks", "spec-import"]);
  await commands.get("do-work")?.handler("Core-owned task", {
    cwd: root,
    ui: { notify() {} },
    sessionManager: { getSessionId: () => "core-command-test", getCwd: () => root },
  });
  assert.match(prompts[0] ?? "", /Core-owned task/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("core: direct specification, import, do-work, and cto commands are executable", async () => {
  const root = mkdtempSync(join(tmpdir(), "core-command-execution-"));
  try {
  const commands = new Map<string, { handler: (args: string, ctx: unknown) => Promise<void> }>();
  const prompts: string[] = [];
  registerWorkflowCommands({
    registerCommand(name: string, command: { handler: (args: string, ctx: unknown) => Promise<void> }) {
      commands.set(name, command);
    },
    on() {},
    sendUserMessage(prompt: string) {
      prompts.push(prompt);
    },
  } as never, { cwd: root, owner: commandOwner(root, "smoke-command-execution") });
  const context = {
    cwd: root,
    ui: { notify() {} },
    sessionManager: { getSessionId: () => "core-command-execution-test", getCwd: () => root },
  };

  for (const name of ["specify", "spec-plan", "spec-tasks", "spec-import"] as const) {
    await commands.get(name)?.handler("", context);
  }
  await commands.get("do-work")?.handler("command smoke task", context);
  await commands.get("cto")?.handler("", context);

  assert.equal(prompts.length, 6);
  assert.match(prompts[0] ?? "", /Usage: \/specify/);
  assert.match(prompts[1] ?? "", /Usage: \/spec-plan/);
  assert.match(prompts[2] ?? "", /Usage: \/spec-tasks/);
  assert.match(prompts[3] ?? "", /Usage: \/spec-import/);
  assert.match(prompts[4] ?? "", /command smoke task/);
  assert.match(prompts[5] ?? "", /standby|CTO/i);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("core: package root ships specification assets, executable schemas, and adapter seams", async () => {
  const core = await import("@andvl1/omp-workflows-core");
  const exportedFunctions = [
    "registerWorkflowCommands", "specifyCommand", "specPlanCommand", "specTasksCommand",
    "specImportCommand", "parseWorkEnvelope", "buildDoWorkPrompt", "ctoCommand",
    "createWorkflowToolAdapter", "registerWorkflowTools", "registerConstitutionProvider",
  ] as const;
  for (const name of exportedFunctions) {
    assert.equal(typeof (core as Record<string, unknown>)[name], "function", `${name} is a public package export`);
  }
  for (const name of ["claimWorkflowOwner", "claimWorkflowOwners", "createRegistryRegistrationLiveGuard", "releaseWorkflowOwner", "releaseWorkflowOwners", "workflowOwnerFor"] as const) {
    assert.equal(name in (core as Record<string, unknown>), false, `${name} stays out of the package root`);
  }
  const registry = await import("@andvl1/omp-workflows-core/registry");
  for (const name of [
    "beginRegistryRegistration", "commitRegistryRegistration", "createRegistryRegistrationLiveGuard", "openWorkflowActivation", "closeWorkflowActivation",
    "recordRegistryUndo", "registryRegistrationPrincipal", "registryRegistrationProjectRoot",
    "releaseWorkflowOwner", "releaseWorkflowOwners", "requireRegistryRegistration", "rollbackRegistryRegistration",
  ] as const) {
    assert.equal(typeof (registry as Record<string, unknown>)[name], "function", `${name} is a curated registry export`);
  }
  for (const name of ["claimWorkflowOwner", "claimWorkflowOwners", "workflowOwnerFor"] as const) {
    assert.equal(name in (registry as Record<string, unknown>), false, `${name} stays out of the curated registry seam`);
  }

  const profiles = await core.loadAllProfiles();
  for (const name of ["constitution", "spec-preparation"] as const) {
    const profile = profiles.find((candidate) => candidate.name === name);
    assert.ok(profile, `${name} profile is shipped`);
    assert.ok(profile.stages.length > 0, `${name} profile has executable stages`);
  }

  const workflowsDir = join(dirname(fileURLToPath(import.meta.url)), "..", "workflows");
  for (const filename of ["constitution.json", "spec-preparation.json", "_schema.json", "artifacts-schema.json", "spec-import.json"] as const) {
    const assetPath = join(workflowsDir, filename);
    assert.equal(existsSync(assetPath), true, `${filename} is included in the package`);
    const asset = JSON.parse(readFileSync(assetPath, "utf8")) as Record<string, unknown>;
    assert.equal(typeof asset, "object", `${filename} is executable JSON`);
  }
  const workflowSchema = JSON.parse(readFileSync(join(workflowsDir, "_schema.json"), "utf8")) as Record<string, unknown>;
  assert.equal(workflowSchema.type, "object");
  assert.ok(Array.isArray(workflowSchema.required));
  const artifactSchemas = core.loadArtifactSchemas();
  for (const id of ["implementation_handoff", "execution_claim", "implementation_conformance"] as const) {
    const schema = artifactSchemas[id];
    assert.ok(schema, `${id} executable artifact schema is shipped`);
    assert.equal(schema.type, "object");
    assert.ok((schema.required ?? []).length > 0);
  }

  const adapter = core.createWorkflowToolAdapter();
  assert.deepEqual(adapter.capabilities, ["workflow_tools"]);
  assert.equal(typeof adapter.register, "function");
});

test("core: workflow registration accepts a bundle prompt decorator", async () => {
  const root = mkdtempSync(join(tmpdir(), "core-command-decorator-"));
  try {
  const commands = new Map<string, { handler: (args: string, ctx: unknown) => Promise<void> }>();
  const prompts: string[] = [];
  registerWorkflowCommands({
    registerCommand(name: string, command: { handler: (args: string, ctx: unknown) => Promise<void> }) {
      commands.set(name, command);
    },
    on() {},
    sendUserMessage(prompt: string) {
      prompts.push(prompt);
    },
  } as never, { cwd: root, owner: commandOwner(root, "smoke-command-decorator"),
    buildDoWorkPrompt(envelope, cwd) {
      return `${envelope.task}\n${cwd}\n[bundle-profile]`;
    },
  });

  await commands.get("team")?.handler("Decorated task", {
    cwd: root,
    ui: { notify() {} },
    sessionManager: { getSessionId: () => "core-command-decorator-test", getCwd: () => root },
  });
  assert.match(prompts[0] ?? "", /Decorated task.*\[bundle-profile\]/s);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("core: loadAllProfiles returns reusable core profiles", async () => {
  const profiles = await loadAllProfiles();
  assert.ok(profiles.length >= 11);
  const names = profiles.map((p) => p.name);
  for (const name of ["lightweight", "full-feature", "debug-cycle", "cto", "feature-regression", "spec-preparation", "product-discovery"]) {
    assert.ok(names.includes(name), `${name} profile is shipped`);
  }
  assert.ok(profiles.find((p) => p.name === "feature-regression")?.stages.every((stage) => stage.prompt), "regression stages carry prompts");
  assert.ok(profiles.find((p) => p.name === "spec-preparation")?.stages.every((stage) => stage.prompt), "spec stages carry prompts");
  assert.ok(profiles.find((p) => p.name === "product-discovery")?.stages.every((stage) => stage.prompt), "product-discovery stages carry prompts");

  // The CTO profile is explicit-only: no classification may select it.
  for (const type of ["FEATURE", "REFACTOR", "OPS", "BUG_FIX", "SPEC", "REGRESS", "INVESTIGATION", "REVIEW", "HOTFIX", "PRODUCT_DISCOVERY"] as const) {
    for (const complexity of ["QUICK", "MEDIUM", "COMPLEX", "CRITICAL"] as const) {
      const selected = selectProfile(profiles, { type, complexity, confidence: "HIGH", workflow: "standard", autonomous: false });
      assert.notEqual(selected?.name, "cto", `${type}/${complexity} must not select cto`);
    }
  }
});

test("core: spec-preparation phase workers receive the closed native handoff contract", async () => {
  const profile = (await loadAllProfiles()).find((candidate) => candidate.name === "spec-preparation");
  assert.ok(profile, "spec-preparation profile is shipped");
  if (!profile) return;
  const expectedSections: Record<string, string> = {
    specify: "problem, scope, non_goals, actors, journeys, requirements, edge_cases, assumptions, dependencies, success_criteria",
    plan: "repository_grounding, decisions, alternatives, contracts, data_flow, control_flow, migration, security, operations, verification_strategy, constitution_recheck",
    tasks: "task_graph, dependencies, expected_outcomes",
  };
  for (const stage of profile.stages.filter((candidate) => candidate.id in expectedSections)) {
    assert.equal(stage.role, stage.id === "specify" ? "specification-analyst" : "specification-architect", `${stage.id} uses its dedicated native role`);
    assert.match(stage.prompt, /requester task.*approved constitution.*exact binding.*limited targeted implementation paths/iu);
    assert.match(stage.prompt, /do not search tests, schemas, examples, or unrelated files.*never write files.*never call workflow tools/iu);
    assert.match(stage.prompt, /Return exactly one strict JSON worker_result object.*sections, requirements, decisions, tasks, verification, contradictions, constitution_principles/iu);
    assert.doesNotMatch(stage.prompt, /semantic_model|source_artifact\.semantic_model|workflow_persist_specification_phase/iu);
    assert.match(stage.prompt, /Do not author schema_version, feature_id, run_key, phase, version, worker, constitution_binding, or upstream_versions.*engine derives and binds/iu);
    assert.match(stage.prompt, /never write files.*never call workflow tools/iu);
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
  const root = mkdtempSync(join(tmpdir(), "smoke-profile-registration-"));
  try {
    writeTestRegistryMarker(root);
    registerTestProfiles(root, [custom]);
  const profiles = loadSourceProfiles();
  assert.equal(profiles.find((p) => p.name === custom.name)?.title, custom.title);
  const selected = selectSourceProfile(profiles, {
    type: "INVESTIGATION", complexity: "MEDIUM", confidence: "HIGH", workflow: custom.name, autonomous: false,
  });
  assert.equal(selected?.name, custom.name);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
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
  const root = mkdtempSync(join(tmpdir(), "smoke-team-registration-"));
  try {
    registerTestTeamWorkflow(root, fakePi as unknown as Parameters<typeof registerTeamWorkflow>[0], { label: "smoke-test", roles: genericRoles });

  assert.ok(calls.some((c) => c.kind === "on" && c.key === "before_agent_start"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
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
  const calls: Array<{ agent: string; task: string; name?: string }> = [];
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

test("fullstack: agent frontmatter uses OMP class roles and standard fallback when declared", () => {
  const agentsDir = join(dirname(fileURLToPath(import.meta.url)), "../../fullstack/agents");
  const expected: Record<string, { classRole: string; fallbackRole: string | null; thinkingLevel: string }> = {
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
    "specification-worker": { classRole: "@task", fallbackRole: null, thinkingLevel: "auto" },
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
    const modelMatch = fields.model?.match(/^\[\s*"(@[^"]+)"(?:\s*,\s*"(@[^"]+)")?\s*\]\s*$/);
    assert.ok(modelMatch, `${name}: model must be a non-empty @selector array`);
    assert.equal(modelMatch?.[1], expected[name].classRole, `${name}: class role`);
    if (expected[name].fallbackRole === null) assert.equal(modelMatch?.[2], undefined, `${name}: dedicated worker must not declare a fallback selector`);
    else assert.equal(modelMatch?.[2], expected[name].fallbackRole, `${name}: standard fallback`);
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
  const roles = ["architect", "architect", "architect"];
  const outcome = await runStage(
    { id: "architecture", title: "Architecture", type: "consilium", roles },
    {
      cwd: process.cwd(),
      state,
      artifactsDir: `${process.cwd()}/.work-state/artifacts`,
      flags: { scope: [], has_security: false, has_infra: false, has_ui: false, has_runtime: true, dev_agent: null },
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
  assert.deepEqual(dispatched.map(({ name, agent }) => ({ name, agent })), ["architect#1", "architect#2", "architect#3"].map((slot) => ({ name: `architecture-${slot}`, agent: "architect" })));
  for (const task of dispatched) {
    assert.deepEqual(Object.keys(task).sort(), ["agent", "name", "task"]);
    assert.match(task.task, new RegExp("Workflow role: architect"));
  }
});


test("core: bundle boundary does not export fullstack defaults", async () => {
  const core = await import("../src/index.js");
  assert.equal(typeof core.registerTeamWorkflow, "function");
  assert.equal("defaultFullstackRoles" in core, false);
  assert.equal("defaultFullstackModelRoles" in core, false);
});

test("core: ownerless registerTeamWorkflow rejects runtime overrides", () => {
  const fakePi = {
    setLabel: () => undefined,
    on: () => undefined,
    registerCommand: () => undefined,
  };
  assert.throws(
    () => registerTeamWorkflow(fakePi as unknown as Parameters<typeof registerTeamWorkflow>[0], { roles: genericRoles }),
    /owner_invalid: an activation-bearing owner descriptor is required before mounting workflow authority hooks/,
  );
});
