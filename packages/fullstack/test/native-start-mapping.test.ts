import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createFeatureWorkspace,
  loadProfile,
  resolveState,
} from "@andvl1/omp-workflows-core";
import { fullstackOwnerForCwd, registerWorkflowTools } from "../src/index.js";
import { refreshFullstackAgentMappings } from "../src/agent-mapping.js";
import { z } from "zod";
import { TEST_CONTEXT } from "../../core/test/fixtures/registrar-host.js";
import { beginHeldRegistration, type HeldRegistration } from "./fixtures/guarded-registration.js";
import { ensureProjectConstitution } from "../../core/src/specification/prerequisite.js";
import { registerTestConstitutionGate, writeTestRegistryMarker } from "../../core/test/fixtures/registry-activation.js";

type RegisteredTool = {
  name: string;
  execute: (...args: never[]) => Promise<{ content: [{ type: "text"; text: string }]; details: unknown }>;
};

type NativeStartFixture = {
  root: string;
  featureId: string;
  runKey: string;
  profileHash: string;
};

function registerWorkflowToolsForTest(root: string, pi: Parameters<typeof registerWorkflowTools>[0]): HeldRegistration {
  const registration = beginHeldRegistration(root, ["workflow_registration", "workflow_tools"], fullstackOwnerForCwd(root), ["workflow_tools"]);
  try {
    registerWorkflowTools({ ...pi, on: (event: string, handler: (event: unknown, ctx: unknown) => unknown) => { if (event === "session_start") handler({}, TEST_CONTEXT(root)); } } as never, registration.token);
    registration.commit();
    return registration;
  } catch (error) {
    registration.close();
    throw error;
  }
}

function profileHash(profile: unknown): string {
  const canonicalize = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(canonicalize);
    if (value && typeof value === "object") {
      return Object.fromEntries(
        Object.entries(value as Record<string, unknown>)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([key, entry]) => [key, canonicalize(entry)]),
      );
    }
    return value;
  };
  return createHash("sha256").update(JSON.stringify(canonicalize(profile))).digest("hex");
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function makeNativeStartFixture(config: Record<string, unknown> = { roles: { "specification-analyst": "mapped-analyst" } }): NativeStartFixture {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "omp-fullstack-native-start-")));
  execFileSync("git", ["-C", root, "init", "--quiet", "--initial-branch", "main"], { stdio: "ignore" });
  mkdirSync(join(root, ".omp"), { recursive: true });
  mkdirSync(join(root, ".work-state"), { recursive: true });
  writeFileSync(join(root, ".omp", "team.config.json"), `${JSON.stringify(config)}\n`);

  const constitution = "# Project Constitution v1.0.0\n\n## I. Quality\n\nShip tested work.\n";
  writeFileSync(join(root, "CONSTITUTION.md"), constitution);
  writeTestRegistryMarker(root);
  registerTestConstitutionGate(root, "fullstack-native-start-mapping-gate");
  const profile = loadProfile("spec-preparation");
  assert.ok(profile);
  const profileHashValue = profileHash(profile);
  const featureId = "native-start-mapping";
  const runKey = "native-start-mapping-run";
  const created = createFeatureWorkspace(root, {
    feature_id: featureId,
    display_name: "Native start mapping",
    run_key: runKey,
    profile_name: "spec-preparation",
    profile_hash: profileHashValue,
    source_kind: "native",
  });
  assert.equal(created.ok, true, created.ok ? "" : created.error);
  if (!created.ok) throw new Error(created.error);
  const gate = ensureProjectConstitution(
    root,
    { origin_kind: "native_direct", origin_run_key: runKey, origin_stage: "specify" },
    { feature_id: featureId },
  );
  assert.equal(gate.ok, true, gate.ok ? "" : gate.error);
  if (!gate.ok || !gate.value.binding) throw new Error(gate.ok ? "constitution binding missing" : gate.error);
  return { root, featureId, runKey, profileHash: profileHashValue };
}

function nativeWorkflowTools(root: string): { tools: Map<string, RegisteredTool>; registration: HeldRegistration } {
  const tools = new Map<string, RegisteredTool>();
  const registration = registerWorkflowToolsForTest(root, {
    zod: { z },
    registerTool(tool: RegisteredTool) {
      tools.set(tool.name, tool);
    },
  } as never);
  return { tools, registration };
}

async function prepareNativeStart(fixture: NativeStartFixture, tools: Map<string, RegisteredTool>): Promise<Record<string, unknown>> {
  const prepare = tools.get("workflow_prepare");
  assert.ok(prepare, "fullstack must register workflow_prepare");
  const response = await prepare.execute(
    "test",
    {
      task: "native start mapping integration",
      branch: "main",
      classification: {
        type: "SPEC",
        complexity: "MEDIUM",
        confidence: "HIGH",
        autonomous: false,
        workflow: "spec-preparation",
      },
      files: [],
      issue: null,
      feature_id: fixture.featureId,
      run_key: fixture.runKey,
    },
    undefined,
    undefined,
    TEST_CONTEXT(fixture.root) as never,
  );
  const details = response.details as {
    ok?: boolean;
    required_next_tool?: { arguments?: { preparation_handoff?: unknown } };
  };
  assert.equal(details.ok, true, response.content[0].text);
  const handoff = details.required_next_tool?.arguments?.preparation_handoff;
  assert.ok(handoff && typeof handoff === "object", "workflow_prepare must return an opaque native preparation handoff");
  return handoff as Record<string, unknown>;
}

function nativeStartTool(tools: Map<string, RegisteredTool>): RegisteredTool {
  const start = tools.get("workflow_start_native_specification_phase");
  assert.ok(start, "fullstack must register the native composite start tool");
  return start;
}

function oversizedConfig(): Record<string, unknown> {
  return {
    roles: { "specification-analyst": "mapped-analyst" },
    provenance: Object.fromEntries(
      Array.from({ length: 16 }, (_, index) => [`extra_${index}`, "\"".repeat(8_150)]),
    ),
  };
}

test("fullstack native start waits for the fresh mapping and binds the mapped worker", async () => {
  const fixture = makeNativeStartFixture();
  let mounted: { tools: Map<string, RegisteredTool>; registration: HeldRegistration } | undefined;
  try {
    mounted = nativeWorkflowTools(fixture.root);
    const preparationHandoff = await prepareNativeStart(fixture, mounted.tools);
    let discoveryStarted = false;
    let releaseDiscovery!: (result: { agents: ReadonlyArray<{ name: string }> }) => void;
    const discovery = new Promise<{ agents: ReadonlyArray<{ name: string }> }>((resolve) => {
      releaseDiscovery = resolve;
    });
    const refresh = refreshFullstackAgentMappings(fixture.root, async () => {
      discoveryStarted = true;
      return discovery;
    });
    assert.equal(discoveryStarted, true);

    const start = nativeStartTool(mounted.tools);
    const startPromise = start.execute(
      "test",
      { feature_id: fixture.featureId, run_key: fixture.runKey, preparation_handoff: preparationHandoff },
      undefined,
      undefined,
      TEST_CONTEXT(fixture.root) as never,
    );
    let settled = false;
    void startPromise.then(() => { settled = true; }, () => { settled = true; });
    await Promise.resolve();
    assert.equal(settled, false, "native start must wait for the in-flight host roster refresh");

    releaseDiscovery({ agents: [
      { name: "mapped-analyst" },
      { name: "analyst" },
      { name: "discovery" },
      { name: "diagnostics" },
      { name: "tech-researcher" },
      { name: "specification-worker" },
      { name: "architect" },
      { name: "developer-kotlin" },
      { name: "developer-go" },
      { name: "frontend-developer" },
      { name: "developer-mobile" },
      { name: "init-mobile" },
      { name: "qa" },
      { name: "manual-qa" },
      { name: "code-reviewer" },
      { name: "security-tester" },
      { name: "devops" },
      { name: "task" },
    ] });
    await refresh;
    const response = await startPromise;
    const details = response.details as {
      ok?: boolean;
      handoff?: { work_identity?: { worker_id?: string } };
      required_next_tool?: { arguments?: { tasks?: Array<{ agent?: string }> } };
    };
    assert.equal(details.ok, true);
    assert.equal(details.handoff?.work_identity?.worker_id, "mapped-analyst");
    assert.equal(details.required_next_tool?.arguments?.tasks?.[0]?.agent, "mapped-analyst");
  } finally {
    mounted?.registration.close();
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("fullstack native start blocks on mapping refresh failure without dispatch", async () => {
  const fixture = makeNativeStartFixture();
  let mounted: { tools: Map<string, RegisteredTool>; registration: HeldRegistration } | undefined;
  try {
    mounted = nativeWorkflowTools(fixture.root);
    await refreshFullstackAgentMappings(fixture.root, async () => ({ agents: [{ name: "old-analyst" }] }));
    const preparationHandoff = await prepareNativeStart(fixture, mounted.tools);
    writeFileSync(join(fixture.root, ".omp", "team.config.json"), `${JSON.stringify(oversizedConfig())}\n`);

    let releaseDiscovery!: (result: { agents: ReadonlyArray<{ name: string }> }) => void;
    const discovery = new Promise<{ agents: ReadonlyArray<{ name: string }> }>((resolve) => {
      releaseDiscovery = resolve;
    });
    const refresh = refreshFullstackAgentMappings(fixture.root, async () => discovery);
    const start = nativeStartTool(mounted.tools);
    const startPromise = start.execute(
      "test",
      { feature_id: fixture.featureId, run_key: fixture.runKey, preparation_handoff: preparationHandoff },
      undefined,
      undefined,
      TEST_CONTEXT(fixture.root) as never,
    );
    releaseDiscovery({ agents: [{ name: "mapped-analyst" }] });
    await assert.rejects(refresh);
    const response = await startPromise;
    const details = response.details as { ok?: boolean; code?: string };
    assert.equal(details.ok, false);
    assert.match(details.code ?? "", /WORKFLOW_START_NATIVE_SPECIFICATION_PHASE_FAILED|WORKFLOW_BEGIN_FAILED/u);

    const state = resolveState(fixture.root, "main", { feature_id: fixture.featureId, run_key: fixture.runKey }).state as {
      dispatch_capability?: { dispatches?: unknown[] };
    } | null;
    assert.equal(state?.dispatch_capability?.dispatches?.length ?? 0, 0, "a failed fresh mapping refresh must not authorize or dispatch a worker");
  } finally {
    mounted?.registration.close();
    rmSync(fixture.root, { recursive: true, force: true });
  }
});
