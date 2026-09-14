/**
 * Failing behavioral contracts for adaptive `/do-work` preparation (T074).
 *
 * The classifier is deliberately a pure seam. The command integration seam
 * owns durable nested identity and is not allowed to dispatch implementation
 * work while preparation (including the constitution prerequisite) is open.
 *
 */
import { test } from "node:test";
import { TEST_ON, TEST_OWNER, TEST_SESSION_MANAGER } from "./fixtures/registrar-host.js";
import { openTestRegistry, writeTestRegistryMarker } from "./fixtures/registry-activation.js";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as classification from "../src/commands/classification-contract.js";
import * as doWork from "../src/commands/do-work.js";
import { registerWorkflowTools } from "../src/index.js";
import { z as zod } from "zod";
import { loadProfile, profileHash } from "../src/engine/profile.js";
import { resolveState, updateStateAtomically } from "../src/engine/state.js";

type Depth = "quick" | "bounded_specify" | "full_specification";
type RiskInput = {
  complexity: "QUICK" | "MEDIUM" | "COMPLEX" | "CRITICAL";
  confidence: "HIGH" | "MEDIUM" | "LOW";
  scopeClarity: "clear" | "unresolved";
  securityRisk: boolean;
  infrastructureRisk: boolean;
};

type DepthResult = { depth: Depth; rationale_codes: readonly string[] };
type PreparationRoute = DepthResult & {
  dispatched: false;
  feature_id: string | null;
  run_key: string | null;
  profile_name: string | null;
  profile_hash: string | null;
  prerequisite: { name: string; profile_name: string; profile_hash: string } | null;
  pause: { kind: string; reason: string } | null;
  resumed?: boolean;
};

type Classify = (input: RiskInput) => DepthResult;
type Prepare = (projectRoot: string, input: {
  task: string;
  classification: RiskInput;
  feature_id?: string;
  run_key?: string;
  run_id?: string;
}) => PreparationRoute;

function requireClassifier(): Classify {
  const fn = (classification as unknown as Record<string, unknown>).classifySpecificationPreparationDepth;
  assert.equal(
    typeof fn,
    "function",
    "classification-contract.ts must export classifySpecificationPreparationDepth (T076)",
  );
  return fn as Classify;
}

function requirePreparationRoute(): Prepare {
  const fn = (doWork as unknown as Record<string, unknown>).prepareDoWorkSpecificationRoute;
  assert.equal(
    typeof fn,
    "function",
    "do-work.ts must export prepareDoWorkSpecificationRoute (T076/T078)",
  );
  return fn as Prepare;
}

function makeProject(): string {
  return mkdtempSync(join(tmpdir(), "do-work-adaptive-"));
}

function input(overrides: Partial<RiskInput> = {}): RiskInput {
  return {
    complexity: "QUICK",
    confidence: "HIGH",
    scopeClarity: "clear",
    securityRisk: false,
    infrastructureRisk: false,
    ...overrides,
  };
}

function rationale(result: DepthResult, pattern: RegExp, message: string): void {
  assert.ok(
    result.rationale_codes.some((code) => pattern.test(code)),
    `${message}; got ${JSON.stringify(result.rationale_codes)}`,
  );
}

// ── Pure adaptive classification ───────────────────────────────────────────

test("adaptive classification selects quick only for clear, high-confidence, low-risk work", () => {
  const result = requireClassifier()(input());
  assert.equal(result.depth, "quick");
  assert.ok(Array.isArray(result.rationale_codes));
  assert.ok(result.rationale_codes.length > 0, "quick routing must preserve why full preparation was unnecessary");
  rationale(result, /quick|low.?risk|risk.?low/i, "quick rationale identifies the lightweight path");
  rationale(result, /high.?confidence|confidence.?high/i, "quick rationale records confidence evidence");
});

test("adaptive classification routes a medium request with unresolved scope to bounded Specify", () => {
  const result = requireClassifier()(input({ complexity: "MEDIUM", scopeClarity: "unresolved" }));
  assert.equal(result.depth, "bounded_specify");
  assert.notEqual(result.depth, "quick", "unresolved scope must not silently use quick preparation");
  assert.notEqual(result.depth, "full_specification", "medium clarification remains bounded rather than universal heavyweight work");
  rationale(result, /scope|clarif|bounded|medium/i, "bounded rationale identifies unresolved scope");
});

test("medium confidence or a clear medium request still receives bounded preparation", () => {
  const classify = requireClassifier();
  for (const candidate of [
    input({ complexity: "MEDIUM", confidence: "HIGH" }),
    input({ complexity: "MEDIUM", confidence: "MEDIUM" }),
  ]) {
    const result = classify(candidate);
    assert.equal(result.depth, "bounded_specify", "medium work must not silently skip its focused Specify boundary");
  }
});

test("complexity and criticality force full specification even when confidence is high", () => {
  const classify = requireClassifier();
  for (const complexity of ["COMPLEX", "CRITICAL"] as const) {
    const result = classify(input({ complexity }));
    assert.equal(result.depth, "full_specification", `${complexity} work requires full preparation`);
    rationale(result, /complex|critical/i, `${complexity} rationale is persisted`);
  }
});

test("low confidence, security risk, and infrastructure risk each force full specification", () => {
  const classify = requireClassifier();
  const cases: Array<[string, Partial<RiskInput>, RegExp]> = [
    ["low confidence", { confidence: "LOW" }, /low.?confidence|confidence.?low|uncertain/i],
    ["security-sensitive work", { securityRisk: true }, /security/i],
    ["infrastructure-sensitive work", { infrastructureRisk: true }, /infrastructure|operational/i],
  ];
  for (const [label, overrides, code] of cases) {
    const result = classify(input({ complexity: "QUICK", ...overrides }));
    assert.equal(result.depth, "full_specification", `${label} cannot take the quick path`);
    rationale(result, code, `${label} rationale is retained`);
  }
});

test("adaptive rationale is deterministic, sorted, and immutable for identical classifications", () => {
  const classify = requireClassifier();
  const first = classify(input({ complexity: "MEDIUM", confidence: "MEDIUM", scopeClarity: "unresolved" }));
  const second = classify(input({ complexity: "MEDIUM", confidence: "MEDIUM", scopeClarity: "unresolved" }));
  assert.deepEqual(second, first, "the same classification must produce the same routing rationale");
  assert.deepEqual([...first.rationale_codes].sort(), [...first.rationale_codes], "rationale codes have stable canonical ordering");
  assert.ok(Object.isFrozen(first.rationale_codes), "rationale_codes must be immutable after classification");
  assert.throws(
    () => (first.rationale_codes as string[]).push("forged-dispatch"),
    /read.?only|object is not extensible|extensible/i,
    "callers must not be able to add a rationale that was never classified",
  );
});

// ── `/do-work` integration and durable nested identity ──────────────────────

test("adaptive /do-work route records rationale and never dispatches before preparation is eligible", () => {
  const root = makeProject();
  try {
    const route = requirePreparationRoute()(root, {
      task: "quickly rename a local variable",
      classification: input(),
    });
    assert.equal(route.depth, "quick");
    assert.equal(route.dispatched, false, "classification/preparation is not an implementation dispatch");
    assert.ok(route.rationale_codes.length > 0, "the route persists the adaptive rationale");
    assert.equal(route.feature_id, null, "quick work does not invent a nested specification identity");
    assert.equal(route.run_key, null, "quick work does not invent a nested specification identity");
    assert.equal(route.pause, null, "eligible quick work has no hidden prerequisite pause");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("full adaptive route uses the direct specification profile and constitution prerequisite identities", () => {
  const root = makeProject();
  try {
    const route = requirePreparationRoute()(root, {
      task: "rotate production credentials and migrate the infrastructure",
      classification: input({ complexity: "CRITICAL", securityRisk: true, infrastructureRisk: true }),
      feature_id: "rotate-production-credentials",
      run_key: "nested-adaptive-run-1",
      run_id: "nested-adaptive-run-1",
    });
    assert.equal(route.depth, "full_specification");
    assert.equal(route.dispatched, false, "full preparation must stop at its prerequisite/checkpoint");
    assert.equal(route.feature_id, "rotate-production-credentials");
    assert.equal(route.run_key, "nested-adaptive-run-1");
    assert.ok(route.pause, "full preparation must pause at the prerequisite or human checkpoint");
    assert.ok(route.pause?.kind, "a paused full route exposes its typed pause kind");
    assert.ok(route.pause?.reason, "a paused full route exposes an actionable pause reason");

    const directProfile = loadProfile("spec-preparation");
    const constitutionProfile = loadProfile("constitution");
    assert.ok(directProfile, "the direct specification profile must be shipped");
    assert.ok(constitutionProfile, "the shared constitution prerequisite profile must be shipped");
    assert.equal(route.profile_name, "spec-preparation");
    assert.equal(route.profile_hash, profileHash(directProfile!), "nested full route must bind the exact direct profile hash");
    assert.deepEqual(route.prerequisite, {
      name: "constitution",
      profile_name: "constitution",
      profile_hash: profileHash(constitutionProfile!),
    }, "nested full route must use the exact shared constitution prerequisite identity");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a paused nested full route resumes its existing feature/run identity idempotently", () => {
  const root = makeProject();
  const request = {
    task: "introduce an authenticated data migration",
    classification: input({ complexity: "COMPLEX", securityRisk: true }),
    feature_id: "authenticated-data-migration",
    run_key: "nested-adaptive-run-2",
    run_id: "nested-adaptive-run-2",
  } as const;
  try {
    const prepare = requirePreparationRoute();
    const first = prepare(root, request);
    assert.equal(first.depth, "full_specification");
    assert.equal(first.dispatched, false);
    assert.equal(first.feature_id, request.feature_id);
    assert.equal(first.run_key, request.run_key);
    assert.ok(first.pause, "the initial full preparation must be durably paused");

    const resumed = prepare(root, request);
    assert.equal(resumed.depth, first.depth);
    assert.deepEqual(resumed.rationale_codes, first.rationale_codes);
    assert.equal(resumed.feature_id, first.feature_id, "resume must not create a second feature identity");
    assert.equal(resumed.run_key, first.run_key, "resume must retain the original nested run key");
    assert.notEqual(resumed.resumed, false, "the second invocation must be observable as a resume");
    assert.equal(resumed.dispatched, false, "pause/resume never turns preparation into an implicit implementation dispatch");
    assert.deepEqual(resumed.prerequisite, first.prerequisite);
    assert.equal(resumed.profile_name, first.profile_name);
    assert.equal(resumed.profile_hash, first.profile_hash);

    const featureStateDir = join(root, ".work-state", "features", request.feature_id);
    assert.deepEqual(
      readdirSync(join(root, ".work-state", "features")),
      [request.feature_id],
      "idempotent resume must not create a duplicate feature workspace",
    );
    const statePath = join(featureStateDir, "state.json");
    const persisted = JSON.parse(readFileSync(statePath, "utf8")) as Record<string, unknown>;
    assert.equal(persisted.run_key, request.run_key, "durable state keeps the nested run identity");
    const adaptive = persisted.adaptive_preparation as Record<string, unknown>;
    assert.equal(adaptive.depth, first.depth, "durable state keeps the selected depth");
    assert.deepEqual(adaptive.rationale_codes, first.rationale_codes, "durable state keeps the selected rationale");
    assert.equal(adaptive.feature_id, request.feature_id, "durable adaptive state keeps feature identity");
    assert.equal(adaptive.run_key, request.run_key, "durable adaptive state keeps run identity");
    assert.equal(typeof adaptive.request_digest, "string", "durable adaptive state binds the request for idempotent replay");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});


test("adaptive preparation CAS preserves a concurrent claim transition", () => {
  const root = makeProject();
  const request = {
    task: "introduce an authenticated data migration",
    classification: input({ complexity: "COMPLEX", securityRisk: true }),
    feature_id: "adaptive-claim-race",
    run_key: "adaptive-claim-race-run",
    run_id: "adaptive-claim-race-run",
  } as const;
  let injected = false;
  try {
    doWork.setAdaptivePreparationTestHooks({
      beforeTransaction: () => {
        const changed = updateStateAtomically(
          root,
          (snapshot) => snapshot.state?.specification
            ? { op: "commit", state: { ...snapshot.state, specification: { ...snapshot.state.specification, execution_claim_ref: "claim-raced-during-adaptive" } }, value: null }
            : { op: "fail", code: "state_missing", error: "adaptive race state missing" },
          { selector: { feature_id: request.feature_id, run_key: request.run_key } },
        );
        injected = changed.ok;
      },
    });
    const route = requirePreparationRoute()(root, request);
    assert.equal(injected, true, "the deterministic concurrent claim transition must run");
    assert.equal(route.dispatched, false);
    assert.ok(route.pause, "a stale adaptive snapshot must fail closed");
    const state = resolveState(root, undefined, { feature_id: request.feature_id, run_key: request.run_key });
    assert.equal(state.state?.specification?.execution_claim_ref, "claim-raced-during-adaptive", "the concurrent claim transition must survive");
    assert.equal((state.state as (typeof state.state & { adaptive_preparation?: unknown }) | null)?.adaptive_preparation, undefined, "conflicting adaptive persistence must not overwrite the fresh state");
  } finally {
    doWork.setAdaptivePreparationTestHooks(null);
    rmSync(root, { recursive: true, force: true });
  }
});

test("adaptive preparation rejects a root swap without writing the replacement root", () => {
  const root = makeProject();
  const outside = makeProject();
  const moved = root + ".opened";
  let swapped = false;
  const request = {
    task: "rotate production credentials",
    classification: input({ complexity: "CRITICAL", securityRisk: true }),
    feature_id: "adaptive-root-swap",
    run_key: "adaptive-root-swap-run",
    run_id: "adaptive-root-swap-run",
  } as const;
  try {
    doWork.setAdaptivePreparationTestHooks({
      beforeTransaction: () => {
        if (swapped) return;
        swapped = true;
        renameSync(root, moved);
        symlinkSync(outside, root, "dir");
      },
    });
    const route = requirePreparationRoute()(root, request);
    assert.equal(route.dispatched, false);
    assert.ok(route.pause);
    assert.match(route.pause?.reason ?? "", /project root changed|adaptive preparation persistence failed/i);
    assert.deepEqual(readdirSync(outside), [], "replacement root must remain untouched");
  } finally {
    doWork.setAdaptivePreparationTestHooks(null);
    if (swapped) {
      rmSync(root, { recursive: true, force: true });
      renameSync(moved, root);
    }
    rmSync(root, { recursive: true, force: true });
    rmSync(moved, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

type MountedPrepareTool = {
  name: string;
  parameters: { safeParse: (value: unknown) => { success: boolean } };
  execute: (...args: unknown[]) => Promise<{ details: Record<string, unknown> }>;
};

function mountedPrepareTool(root: string): MountedPrepareTool {
  writeTestRegistryMarker(root);
  const registration = openTestRegistry(root, ["workflow_tools"], "do-work-routing");
  const tools = new Map<string, MountedPrepareTool>();
  registerWorkflowTools({
    zod: { z: zod },
    on: TEST_ON,
    registerTool(tool: unknown) {
      const mounted = tool as MountedPrepareTool;
      tools.set(mounted.name, mounted);
    },
  } as never, {
      owner: () => registration.owner, cwd: root, registrationToken: registration.token, resolveCwd: (ctx: unknown) => (ctx as { cwd: string }).cwd });
  registration.retain(true);
  const prepare = tools.get("workflow_prepare");
  assert.ok(prepare, "mounted workflow_prepare must be registered");
  return prepare!;
}

function makeUsableConstitution(root: string): void {
  writeFileSync(join(root, "CONSTITUTION.md"), "# Project Constitution\n\n## Principles\n- Preserve explicit user intent.\n");
}

function mountedPayload(task: string, branch: string, adaptive: RiskInput): Record<string, unknown> {
  return {
    task,
    branch,
    classification: { type: "BUG_FIX", complexity: adaptive.complexity, confidence: adaptive.confidence, autonomous: false, workflow: "bug-fix" },
    adaptive_preparation: adaptive,
    files: [],
    issue: null,
  };
}

function featureDirectoryCount(root: string): number {
  try { return readdirSync(join(root, ".work-state", "features"), { withFileTypes: true }).filter(entry => entry.isDirectory()).length; }
  catch { return 0; }
}

test("mounted workflow_prepare accepts LECTURE_RESEARCH and rejects unknown classification types", () => {
  const root = makeProject();
  try {
    const prepare = mountedPrepareTool(root);
    const payload = {
      task: "research a public lecture",
      branch: "research/lecture",
      classification: { type: "LECTURE_RESEARCH", complexity: "MEDIUM", confidence: "HIGH", autonomous: false, workflow: "lecture-research" },
      adaptive_preparation: { complexity: "MEDIUM", confidence: "HIGH", scopeClarity: "clear", securityRisk: false, infrastructureRisk: false },
      files: [],
      issue: null,
    };
    assert.equal(prepare.parameters.safeParse(payload).success, true, "lecture research is a valid mounted classification");
    assert.equal(
      prepare.parameters.safeParse({ ...payload, classification: { ...payload.classification, type: "UNKNOWN" } }).success,
      false,
      "unknown classification types remain rejected",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("mounted workflow_prepare enforces adaptive schema and keeps low-risk QUICK at root", async () => {
  const root = makeProject();
  try {
    makeUsableConstitution(root);
    const prepare = mountedPrepareTool(root);
    const adaptive = input();
    const payload = mountedPayload("rename a local variable", "feat/adaptive-quick", adaptive);
    assert.equal(prepare.parameters.safeParse(payload).success, true);
    assert.equal(prepare.parameters.safeParse({ ...payload, adaptive_preparation: { ...adaptive, securityRisk: undefined } }).success, false);
    const result = (await prepare.execute("quick", payload, undefined, undefined, { cwd: root, sessionManager: TEST_SESSION_MANAGER })).details;
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.transition, "adaptive_prepare");
    const route = result.adaptive_preparation as PreparationRoute;
    assert.ok(result.adaptive_preparation, JSON.stringify(result));
    assert.equal(route.depth, "quick");
    assert.equal(route.feature_id, null);
    assert.equal(route.run_key, null);
    assert.match(String(result.state_path), /\.work-state[\\/]team-state\.json$/);
    assert.equal(featureDirectoryCount(root), 0, "low-risk QUICK must not create a feature workspace");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("mounted workflow_prepare routes MEDIUM clarification to one bounded nested Specify state", async () => {
  const root = makeProject();
  try {
    makeUsableConstitution(root);
    const prepare = mountedPrepareTool(root);
    const adaptive = input({ complexity: "MEDIUM", scopeClarity: "unresolved" });
    const result = (await prepare.execute("medium", mountedPayload("clarify the retry boundary", "feat/adaptive-medium", adaptive), undefined, undefined, { cwd: root, sessionManager: TEST_SESSION_MANAGER })).details;
    assert.equal(result.ok, true, JSON.stringify(result));
    const required = result.required_next_tool as { name?: string; arguments?: Record<string, unknown> };
    assert.equal(required.name, "workflow_start_native_specification_phase");
    assert.deepEqual(Object.keys(required.arguments ?? {}).sort(), ["feature_id", "preparation_handoff", "run_key"]);
    assert.deepEqual(required.arguments?.preparation_handoff, result.preparation_handoff, "adaptive native start must carry the returned opaque handoff");
    const route = result.adaptive_preparation as PreparationRoute;
    assert.ok(result.adaptive_preparation, JSON.stringify(result));
    assert.equal(route.depth, "bounded_specify", JSON.stringify(result));
    assert.ok(route.feature_id && route.run_key, "bounded route must return one nested identity");
    assert.ok(route.rationale_codes.some(code => /scope|medium|bounded/i.test(code)));
    assert.equal(featureDirectoryCount(root), 1, "bounded route must create exactly one feature workspace");
    const state = resolveState(root, undefined, { feature_id: route.feature_id!, run_key: route.run_key! });
    assert.equal(state.state?.classification?.type, "SPEC");
    assert.equal(state.state?.classification?.workflow, "spec-preparation");
    assert.equal(state.state?.adaptive_preparation?.depth, "bounded_specify");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("mounted workflow_prepare routes complex and every elevated-risk signal to full nested Specify", async () => {
  const cases: Array<[string, RiskInput]> = [
    ["complex", input({ complexity: "COMPLEX" })],
    ["low-confidence", input({ confidence: "LOW" })],
    ["security", input({ securityRisk: true })],
    ["infrastructure", input({ infrastructureRisk: true })],
  ];
  for (const [label, adaptive] of cases) {
    const root = makeProject();
    try {
      makeUsableConstitution(root);
      const prepare = mountedPrepareTool(root);
      const result = (await prepare.execute(label, mountedPayload(label + " request", "feat/adaptive-" + label, adaptive), undefined, undefined, { cwd: root, sessionManager: TEST_SESSION_MANAGER })).details;
      assert.equal(result.ok, true, `${label}: ${JSON.stringify(result)}`);
      const required = result.required_next_tool as { name?: string; arguments?: Record<string, unknown> };
      assert.equal(required.name, "workflow_start_native_specification_phase");
      assert.deepEqual(Object.keys(required.arguments ?? {}).sort(), ["feature_id", "preparation_handoff", "run_key"]);
      assert.deepEqual(required.arguments?.preparation_handoff, result.preparation_handoff, `${label}: native start must carry the returned opaque handoff`);
      const route = result.adaptive_preparation as PreparationRoute;
    assert.ok(result.adaptive_preparation, JSON.stringify(result));
      assert.equal(route.depth, "full_specification", `${label} must use full preparation`);
      assert.ok(route.feature_id && route.run_key, `${label}: full route must return one nested identity`);
      assert.equal(featureDirectoryCount(root), 1, `${label}: exactly one nested workspace`);
      const state = resolveState(root, undefined, { feature_id: route.feature_id!, run_key: route.run_key! });
      assert.equal(state.state?.classification?.type, "SPEC", `${label}: nested state must be specification-backed`);
      assert.equal(state.state?.classification?.workflow, "spec-preparation", `${label}: nested profile must be spec-preparation`);
    } finally { rmSync(root, { recursive: true, force: true }); }
  }
});

test("mounted adaptive full route replays the same checkpoint identity without a second workspace", async () => {
  const root = makeProject();
  const adaptive = input({ complexity: "COMPLEX", securityRisk: true });
  const payload = mountedPayload("replace payment capture safely", "feat/adaptive-resume", adaptive);
  try {
    makeUsableConstitution(root);
    const prepare = mountedPrepareTool(root);
    const first = (await prepare.execute("first", payload, undefined, undefined, { cwd: root, sessionManager: TEST_SESSION_MANAGER })).details;
    const firstRoute = first.adaptive_preparation as PreparationRoute;
    const second = (await prepare.execute("replay", payload, undefined, undefined, { cwd: root, sessionManager: TEST_SESSION_MANAGER })).details;
    const secondRoute = second.adaptive_preparation as PreparationRoute;
    assert.equal((second.required_next_tool as { name?: string }).name, "workflow_start_native_specification_phase");
    assert.deepEqual(second.required_next_tool, first.required_next_tool, "adaptive replay must preserve the exact native start descriptor");
    assert.equal(secondRoute.feature_id, firstRoute.feature_id);
    assert.equal(secondRoute.run_key, firstRoute.run_key);
    assert.equal(secondRoute.resumed, true, "replay must expose durable preparation resume");
    assert.equal(featureDirectoryCount(root), 1, "replay must not create a second feature workspace");
    const state = resolveState(root, undefined, { feature_id: firstRoute.feature_id!, run_key: firstRoute.run_key! });
    assert.equal(state.state?.classification?.workflow, "spec-preparation", "resume must preserve the nested checkpoint workflow");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("mounted workflow_prepare preserves persisted full depth when a nested replay is classified as QUICK", async () => {
  const root = makeProject();
  const fullAdaptive = input({ complexity: "COMPLEX", securityRisk: true, infrastructureRisk: true });
  const quickAdaptive = input();
  const fullPayload = mountedPayload("replace payment capture safely", "feat/adaptive-depth-replay", fullAdaptive);
  try {
    makeUsableConstitution(root);
    const prepare = mountedPrepareTool(root);
    const first = (await prepare.execute("first", fullPayload, undefined, undefined, { cwd: root, sessionManager: TEST_SESSION_MANAGER })).details;
    const firstRoute = first.adaptive_preparation as PreparationRoute;
    assert.equal(firstRoute.depth, "full_specification");
    assert.ok(firstRoute.feature_id && firstRoute.run_key);

    // A resumed model can emit weaker PHASE-0 fields than the durable nested
    // run. The persisted route is authoritative for this exact identity: a
    // replay must not downgrade full preparation back to the root QUICK path.
    const replayPayload = {
      ...fullPayload,
      classification: { ...(fullPayload.classification as Record<string, unknown>), complexity: "QUICK", workflow: "bug-fix" },
      adaptive_preparation: quickAdaptive,
    };
    const replay = (await prepare.execute("replay", replayPayload, undefined, undefined, { cwd: root, sessionManager: TEST_SESSION_MANAGER })).details;
    const replayRoute = replay.adaptive_preparation as PreparationRoute;
    assert.equal(replayRoute.depth, "full_specification");
    assert.equal(replayRoute.feature_id, firstRoute.feature_id);
    assert.equal(replayRoute.run_key, firstRoute.run_key);
    assert.equal(replayRoute.resumed, true, "nested replay reports resume instead of a new route");
    const state = resolveState(root, undefined, { feature_id: firstRoute.feature_id!, run_key: firstRoute.run_key! });
    assert.equal(state.state?.adaptive_preparation?.depth, "full_specification");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("mounted workflow_prepare rejects missing adaptive risk evidence instead of bypassing nested preparation", async () => {
  const root = makeProject();
  try {
    const prepare = mountedPrepareTool(root);
    const payload = { task: "migrate the payment schema", branch: "feat/adaptive-missing", classification: { type: "BUG_FIX", complexity: "QUICK", confidence: "HIGH", autonomous: false, workflow: "bug-fix" }, files: [], issue: null };
    assert.equal(prepare.parameters.safeParse(payload).success, false, "new non-SPEC requests must carry adaptive risk evidence");
    const result = (await prepare.execute("missing", payload, undefined, undefined, { cwd: root, sessionManager: TEST_SESSION_MANAGER })).details;
    assert.equal(result.ok, false);
    assert.equal(result.code, "WORKFLOW_ADAPTIVE_CLASSIFICATION_REQUIRED");
    assert.equal(featureDirectoryCount(root), 0, "missing risk evidence must not create a workspace");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("public /do-work prompt exposes adaptive routing report and nested resume contract", () => {
  const root = makeProject();
  try {
    const prompt = doWork.buildDoWorkPrompt({ task: "migrate payment transactions across services", autonomyHint: false, issue: null, branch: "feat/adaptive-prompt" }, root);
    assert.match(prompt, /adaptive_preparation/);
    assert.match(prompt, /ADAPTIVE PREPARATION ROUTING REPORT/);
    assert.match(prompt, /bounded_specify/);
    assert.match(prompt, /full_specification/);
    assert.match(prompt, /MUST NOT create a durable.*work-state\/features/);
    assert.match(prompt, /nested specification workflow.*resume/i);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
