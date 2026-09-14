import { test, describe } from "node:test";
import { createHash } from "node:crypto";
import { TEST_ON } from "./fixtures/registrar-host.js";
import { openTestRegistry, writeTestRegistryMarker } from "./fixtures/registry-activation.js";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { z } from "zod";
import { registerCtoTools } from "../src/index.js";
import { CTO_SPECIFICATION_PREPARATION_CLASSIFICATION, decideCtoSpecificationPreparation, prepareCtoSpecificationPreparation as prepareCtoSpecificationPreparationRaw, reviewCtoSpecificationPreparation } from "../src/cto/specification-preparation.js";
import { buildCtoSpecificationReviewPacketFromDecisionSnapshot, buildCtoSpecificationReviewPacketFromDecisionSnapshotPinned } from "../src/cto/specification-review-packet.js";
import { setCtoSpecificationPreparationFailureInjector } from "../src/cto/run.js";
import { PinnedProjectRoot } from "../src/specification/pinned-root.js";
import { activeWave, readCtoState } from "../src/cto/state.js";
import { sha256Hex } from "../src/specification/validation.js";
import type { ParsedCtoEnvelope } from "../src/commands/cto.js";
import { buildPreparationCtoPrompt } from "../src/commands/cto.js";
import { MAX_CTO_SPECIFICATION_AGGREGATE_BYTES, MAX_CTO_SPECIFICATION_REQUESTS, MAX_CTO_SPECIFICATION_TEXT_BYTES } from "../src/cto/types.js";
import { type CtoRuntimeAccessFacade } from "../src/cto/runtime-access.js";
import { openTestCtoRuntime } from "./fixtures/registry-activation.js";

const CONSTITUTION = "# Project Constitution\n\nVersion: 1.0.0\n\n## Quality\n\nEvery change ships with behavioral tests.\n";
const FULLSTACK_MARKER = "{\"schema_version\":1,\"bundle_id\":\"@andvl1/omp-workflows-fullstack\",\"entrypoint\":\"dist/index.js\"}\n";
const FULLSTACK_MARKER_SHA256 = createHash("sha256").update(FULLSTACK_MARKER, "utf8").digest("hex");

function project(): string {
  const root = mkdtempSync(join(tmpdir(), "cto-preparation-entry-"));
  mkdirSync(join(root, ".omp"));
  writeFileSync(join(root, ".omp", "fullstack.activation.json"), FULLSTACK_MARKER, "utf8");
  writeFileSync(join(root, "CONSTITUTION.md"), CONSTITUTION, "utf8");
  return root;
}

type PreparationRuntimeOptions = { runtimeAccess: CtoRuntimeAccessFacade; sessionId: string; cleanup: () => void };

function preparationRuntimeOptions(root: string): PreparationRuntimeOptions {
  const runtime = openTestCtoRuntime(root, "preparation-entry-test", "cto-preparation-entry-runtime");
  return { runtimeAccess: runtime.access, sessionId: "preparation-entry-test", cleanup: runtime.close };
}

function prepareCtoSpecificationPreparationWithRuntime(root: string, preparationInput: Record<string, unknown>): ReturnType<typeof prepareCtoSpecificationPreparationRaw> {
  const runtime = preparationRuntimeOptions(root);
  try {
    return prepareCtoSpecificationPreparationRaw(root, preparationInput as never, runtime);
  } finally {
    runtime.cleanup();
  }
}
function input(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    cto_run_id: "resident-preparation",
    resident_cto_run_id: "resident-preparation",
    task: "prepare the requested features",
    branch: "main",
    capacity: 8,
    depth: 0,
    max_depth: 2,
    requests: [
      { request_id: "feature-a-request", feature_id: "feature-a", request: "Prepare feature A" },
      { request_id: "feature-b-request", feature_id: "feature-b", request: "Prepare feature B" },
      { request_id: "feature-c-request", feature_id: "feature-c", request: "Prepare feature C" },
    ],
    ...overrides,
  };
}

function crashDuringBootstrap(root: string, preparationInput: Record<string, unknown>, failurePoint: string): void {
  const preparationModuleUrl = new URL("../src/cto/specification-preparation.ts", import.meta.url).href;
  const runModuleUrl = new URL("../src/cto/run.ts", import.meta.url).href;
  const ownerModuleUrl = new URL("../src/registry/owner.ts", import.meta.url).href;
  const runtimeAccessModuleUrl = new URL("../src/cto/runtime-access.ts", import.meta.url).href;
  const script = `import { prepareCtoSpecificationPreparation } from ${JSON.stringify(preparationModuleUrl)};
import { setCtoSpecificationPreparationFailureInjector } from ${JSON.stringify(runModuleUrl)};
import { openWorkflowActivation, requireRegistryContext } from ${JSON.stringify(ownerModuleUrl)};
import { issueCtoRuntimeSessionAuthority } from ${JSON.stringify(new URL("../src/cto/session-authority.ts", import.meta.url).href)};
import { openCtoRuntimeAccess } from ${JSON.stringify(runtimeAccessModuleUrl)};
import { realpathSync, statSync } from "node:fs";
setCtoSpecificationPreparationFailureInjector((point) => { if (point === process.env.BOOTSTRAP_FAILURE_POINT) process.exit(73); });
const root = process.env.BOOTSTRAP_ROOT;
if (!root) throw new Error("BOOTSTRAP_ROOT is required");
const owner = {
  owner_id: "fullstack-preparation-entry-child",
  bundle_id: "@andvl1/omp-workflows-fullstack",
  owner_kind: "fullstack",
  activation_marker: "fullstack-preparation-entry-child-v1",
  host_range: ">=17.0.0",
  activation: { marker_id: "fullstack-preparation-entry-child-v1", required: [{ path: ".omp/fullstack.activation.json", kind: "file", sha256: ${JSON.stringify(FULLSTACK_MARKER_SHA256)} }] },
  provenance: { package: "@andvl1/omp-workflows-fullstack", entrypoint: "dist/index.js", cwd: root },
};
const activation = openWorkflowActivation(root, ["workflow_registration", "workflow_tools"], owner);
if (!activation.ok) throw new Error(activation.error);
const sessionId = "preparation-entry-child";
const runtimeRoot = realpathSync(root);
const runtimeIdentity = statSync(runtimeRoot);
const sessionManager = Object.freeze({ cwd: root, getSessionId: () => sessionId, getCwd: () => root });
const authority = issueCtoRuntimeSessionAuthority(
  activation.registry_context,
  { canonical_root: runtimeRoot, dev: runtimeIdentity.dev, ino: runtimeIdentity.ino },
  { sessionManager, sessionId },
  () => { requireRegistryContext(activation.registry_context, runtimeRoot, "workflow_tools"); },
);
const opened = openCtoRuntimeAccess(activation.registry_context, authority, root);
if (!opened.ok) throw new Error(opened.error);
prepareCtoSpecificationPreparation(process.env.BOOTSTRAP_ROOT, JSON.parse(process.env.BOOTSTRAP_INPUT), { runtimeAccess: opened.access, sessionId });
process.exit(92);`;
  const child = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], {
    cwd: process.cwd(),
    env: { ...process.env, BOOTSTRAP_ROOT: root, BOOTSTRAP_INPUT: JSON.stringify(preparationInput), BOOTSTRAP_FAILURE_POINT: failurePoint },
    encoding: "utf8",
    timeout: 300_000,
  });
  assert.equal(child.error, undefined, child.stderr);
  assert.equal(child.status, 73, `bootstrap crash child must stop at the requested durable boundary (status ${child.status}; stderr ${child.stderr})`);
}

describe("engine-owned CTO specification preparation entry", () => {
  test("requires a genuine live runtime access facade before any preparation mutation", () => {
    const root = project();
    try {
      const result = prepareCtoSpecificationPreparationRaw(root, input() as never, undefined as never);
      assert.equal(result.status, "blocked", JSON.stringify(result));
      if (result.status === "blocked") assert.match(result.findings.join("\n"), /runtime access is required/u);
      assert.equal(existsSync(join(root, ".work-state")), false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
  test("rejects blank runtime session identity before preparation mutation", () => {
    const root = project();
    const runtime = openTestCtoRuntime(root, "preparation-entry-test", "cto-preparation-entry-blank-session");
    try {
      const result = prepareCtoSpecificationPreparationRaw(root, input() as never, { runtimeAccess: runtime.access, sessionId: "   " });
      assert.equal(result.status, "blocked", JSON.stringify(result));
      if (result.status === "blocked") assert.match(result.findings.join("\n"), /session id is required/u);
      assert.equal(existsSync(join(root, ".work-state")), false);
    } finally {
      runtime.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
  test("creates exact feature workspaces, a real active wave, and replays run keys", () => {
    const root = project();
    try {
      const first = prepareCtoSpecificationPreparationWithRuntime(root, input() as never);
      assert.equal(first.status, "ready", JSON.stringify(first));
      if (first.status !== "ready") return;
      assert.equal(first.prepared, true);
      assert.equal(first.dispatched, false);
      assert.equal(first.features.length, 3);
      assert.deepEqual(first.features.map((feature) => feature.feature_id), ["feature-a", "feature-b", "feature-c"]);
      assert.ok(first.constitution.binding, "preparation gate exposes the exact selected constitution binding");
      for (const feature of first.features) {
        assert.ok(existsSync(join(root, feature.state_path)));
        assert.ok(existsSync(join(root, feature.workspace_path)));
        const featureState = JSON.parse(readFileSync(join(root, feature.state_path), "utf8")) as { specification?: { constitution_gate_ref?: unknown; constitution_binding?: unknown } };
        assert.equal(featureState.specification?.constitution_gate_ref, first.constitution.gate_id, `${feature.feature_id}: initial workspace is bound to the selected gate`);
        assert.deepEqual(featureState.specification?.constitution_binding, first.constitution.binding, `${feature.feature_id}: initial workspace preserves the exact selected binding`);
      }
      const state = readCtoState(first.cto_run_id, root);
      assert.ok(state);
      assert.equal(state?.standby, true);
      assert.equal(activeWave(state!), state?.wave_history?.[0]);
      assert.equal(activeWave(state!)?.source, "specification-preparation");
      assert.equal(activeWave(state!)?.work_identity?.run_id, first.cto_run_id);
      assert.equal(activeWave(state!)?.work_identity?.workflow, "spec-preparation");
      assert.deepEqual(state!.teams.map((team) => team.classification), Array.from({ length: 3 }, () => CTO_SPECIFICATION_PREPARATION_CLASSIFICATION));
      assert.deepEqual(state!.teams.map((team) => team.workflow), Array.from({ length: 3 }, () => "spec-preparation"));
      const replay = prepareCtoSpecificationPreparationWithRuntime(root, input() as never);
      assert.equal(replay.status, "ready", JSON.stringify(replay));
      if (replay.status !== "ready") return;
      assert.deepEqual(replay.features, first.features);
      assert.deepEqual(replay.scheduled, first.scheduled);
      assert.deepEqual(replay.queued, first.queued);
      assert.equal(readFileSync(join(root, ".work-state", "cto", first.cto_run_id, "state.json"), "utf8").includes("active_wave_id"), true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
  test("rejects invalid capacity before any durable preparation mutation", () => {
    for (const capacity of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      const root = project();
      try {
        const result = prepareCtoSpecificationPreparationWithRuntime(root, input({ capacity }) as never);
        assert.equal(result.status, "blocked", `capacity ${String(capacity)}: ${JSON.stringify(result)}`);
        assert.equal(existsSync(join(root, ".work-state")), false, `capacity ${String(capacity)} must not create durable state`);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    }
    const root = project();
    try {
      const result = prepareCtoSpecificationPreparationWithRuntime(root, input({ capacity: Number.MAX_SAFE_INTEGER }) as never);
      assert.equal(result.status, "ready", JSON.stringify(result));
      assert.ok(existsSync(join(root, ".work-state", "cto", "resident-preparation", "state.json")));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("rejects constitution source drift after all feature admission", () => {
    const root = project();
    const constitutionPath = join(root, "CONSTITUTION.md");
    try {
      let injected = false;
      const originalConstitution = readFileSync(constitutionPath);
      setCtoSpecificationPreparationFailureInjector((point) => {
        if (injected || point !== "before_state_write") return;
        injected = true;
        writeFileSync(constitutionPath, Buffer.concat([originalConstitution, Buffer.from("\n## Drift\n\nThe source changed after per-feature admission.\n", "utf8")]));
      });
      const failed = prepareCtoSpecificationPreparationWithRuntime(root, input() as never);
      setCtoSpecificationPreparationFailureInjector(null);
      assert.equal(injected, true, "the deterministic source mutation must run after all feature admission checks");
      assert.equal(failed.status, "blocked", JSON.stringify(failed));
      assert.equal(existsSync(join(root, ".work-state", "cto", "resident-preparation", "state.json")), false, "aggregate drift must not publish CTO state");
      assert.equal(existsSync(join(root, ".work-state", "features", "feature-a", "state.json")), false, "aggregate drift must roll back the anchor workspace");
      assert.equal(existsSync(join(root, ".work-state", "features", "feature-b", "state.json")), false, "aggregate drift must roll back the non-anchor workspace");
      const artifactsRoot = join(root, ".work-state", "artifacts");
      const remainingDoD = existsSync(artifactsRoot)
        ? readdirSync(artifactsRoot).filter((entry) => existsSync(join(artifactsRoot, entry, "dod.json")))
        : [];
      assert.deepEqual(remainingDoD, [], "aggregate drift must roll back generated DoD artifacts");
      assert.notDeepEqual(readFileSync(constitutionPath), originalConstitution, "the injected source drift remains observable rather than being overwritten");

      writeFileSync(constitutionPath, originalConstitution);
      const retry = prepareCtoSpecificationPreparationWithRuntime(root, input() as never);
      assert.equal(retry.status, "ready", JSON.stringify(retry));
    } finally {
      setCtoSpecificationPreparationFailureInjector(null);
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("recovers workspace bootstrap across every durable publication boundary", () => {
    const failurePoints = [
      "before_preparation_journal",
      "after_preparation_journal",
      "before_workspace_mkdir",
      "after_workspace_mkdir",
      "after_feature_state_write",
      "before_wave_append",
      "after_wave_append",
      "before_state_write",
      "after_cto_state_write",
      "before_preparation_journal_clear",
      "after_preparation_journal_clear",
    ] as const;
    for (const failurePoint of failurePoints) {
      const root = project();
      try {
        let injected = false;
        setCtoSpecificationPreparationFailureInjector((point) => {
          if (!injected && point === failurePoint) {
            injected = true;
            throw new Error(`injected ${point}`);
          }
        });
        const failed = prepareCtoSpecificationPreparationWithRuntime(root, input() as never);
        setCtoSpecificationPreparationFailureInjector(null);
        assert.equal(failed.status, "blocked", `${failurePoint} must report the injected boundary`);
        const statePath = join(root, ".work-state", "cto", "resident-preparation", "state.json");
        const featureStatePath = join(root, ".work-state", "features", "feature-a", "state.json");
        const committed = ["after_cto_state_write", "before_preparation_journal_clear", "after_preparation_journal_clear"].includes(failurePoint);
        assert.equal(existsSync(statePath), committed, `${failurePoint} state publication invariant`);
        assert.equal(existsSync(featureStatePath), committed, `${failurePoint} feature publication invariant`);
        const retry = prepareCtoSpecificationPreparationWithRuntime(root, input() as never);
        assert.equal(retry.status, "ready", `${failurePoint} retry must converge: ${JSON.stringify(retry)}`);
        assert.equal(existsSync(statePath), true);
        assert.equal(existsSync(featureStatePath), true);
        if (committed && retry.status === "ready") {
          assert.ok(retry.constitution.binding);
          const retryState = JSON.parse(readFileSync(featureStatePath, "utf8")) as { specification?: { constitution_gate_ref?: unknown; constitution_binding?: unknown } };
          assert.equal(retryState.specification?.constitution_gate_ref, retry.constitution.gate_id, `${failurePoint} retry retains the selected gate binding`);
          assert.deepEqual(retryState.specification?.constitution_binding, retry.constitution.binding, `${failurePoint} retry retains the exact selected binding`);
        }
      } finally {
        setCtoSpecificationPreparationFailureInjector(null);
        rmSync(root, { recursive: true, force: true });
      }
    }
  });
  test("does not remove feature-shaped orphan paths when no bootstrap journal exists", () => {
    const root = project();
    try {
      const stateDir = join(root, ".work-state", "features", "feature-a");
      mkdirSync(stateDir, { recursive: true });
      mkdirSync(join(root, "specs", "feature-a"), { recursive: true });
      const statePath = join(stateDir, "state.json");
      writeFileSync(statePath, "foreign orphan state\n", "utf8");
      const result = prepareCtoSpecificationPreparationWithRuntime(root, input() as never);
      assert.equal(result.status, "blocked", JSON.stringify(result));
      assert.equal(existsSync(statePath), true, "orphan state must never be removed without a journal proof");
      assert.equal(existsSync(join(root, "specs", "feature-a")), true, "orphan workspace must never be removed without a journal proof");
    } finally {
      setCtoSpecificationPreparationFailureInjector(null);
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("preserves all bootstrap files after a partial crash and quarantines its journal", () => {
    const root = project();
    try {
      const preparationInput = input();
      crashDuringBootstrap(root, preparationInput, "before_state_write");
      const journalPath = join(root, ".work-state", "cto", "resident-preparation", "specification-preparation.transaction.json");
      const featureStatePath = join(root, ".work-state", "features", "feature-a", "state.json");
      const dodPath = join(root, ".work-state", "artifacts");
      assert.equal(existsSync(journalPath), true);
      const featureBytes = readFileSync(featureStatePath);
      const recovered = prepareCtoSpecificationPreparationWithRuntime(root, preparationInput as never);
      assert.equal(recovered.status, "blocked", JSON.stringify(recovered));
      assert.match(recovered.findings.join("\n"), /CTO_SPEC_PREPARATION_RECOVERY_REQUIRED/);
      assert.deepEqual(readFileSync(featureStatePath), featureBytes, "partial crash recovery must preserve the feature state without in-memory ownership");
      assert.equal(existsSync(dodPath), true, "partial crash recovery must preserve generated DoD files");
      assert.equal(existsSync(journalPath), false, "validated partial journal must be moved out of the active slot");
      assert.equal(existsSync(join(root, ".work-state", "cto", "resident-preparation", "specification-preparation.transaction.recovery.json")), true, "validated journal must have an exact recovery archive");
    } finally {
      setCtoSpecificationPreparationFailureInjector(null);
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("never lets forged journal receipts delete a victim file", () => {
    const root = project();
    try {
      const preparationInput = input();
      crashDuringBootstrap(root, preparationInput, "before_state_write");
      const journalPath = join(root, ".work-state", "cto", "resident-preparation", "specification-preparation.transaction.json");
      const journal = JSON.parse(readFileSync(journalPath, "utf8")) as Record<string, unknown>;
      const receipts = journal.file_receipts as Record<string, Record<string, unknown>>;
      const victimPath = ".work-state/features/feature-a/team-state.md";
      const victimAbsolutePath = join(root, victimPath);
      writeFileSync(victimAbsolutePath, "foreign victim\n", "utf8");
      const forged = JSON.parse(JSON.stringify(receipts[".work-state/features/feature-a/state.json"]));
      forged.path = join(root, victimPath);
      forged.relative_path = victimPath;
      forged.descriptor.path = forged.path;
      forged.descriptor.relative_path = victimPath;
      receipts[victimPath] = forged;
      writeFileSync(journalPath, `${JSON.stringify(journal, null, 2)}\n`, "utf8");
      const recovered = prepareCtoSpecificationPreparationWithRuntime(root, preparationInput as never);
      assert.equal(recovered.status, "blocked", JSON.stringify(recovered));
      assert.match(recovered.findings.join("\n"), /RECOVERY_REQUIRED|ownership|journal/u);
      assert.equal(readFileSync(victimAbsolutePath, "utf8"), "foreign victim\n", "forged persisted receipts must never authorize victim deletion");
    } finally {
      setCtoSpecificationPreparationFailureInjector(null);
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("clears an on-disk journal only after durable CTO state proves completion", () => {
    const root = project();
    try {
      const preparationInput = input();
      crashDuringBootstrap(root, preparationInput, "before_preparation_journal_clear");
      const journalPath = join(root, ".work-state", "cto", "resident-preparation", "specification-preparation.transaction.json");
      assert.equal(existsSync(journalPath), true);
      const recovered = prepareCtoSpecificationPreparationWithRuntime(root, preparationInput as never);
      assert.equal(recovered.status, "ready", JSON.stringify(recovered));
      assert.equal(existsSync(journalPath), false, "completed state proof permits exact journal cleanup");
      assert.equal(existsSync(join(root, ".work-state", "features", "feature-a", "state.json")), true, "completed state recovery must retain feature files");
    } finally {
      setCtoSpecificationPreparationFailureInjector(null);
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("preserves a replacement journal between recovery read and exact clear", () => {
    const root = project();
    try {
      const preparationInput = input();
      crashDuringBootstrap(root, preparationInput, "before_preparation_journal_clear");
      const journalPath = join(root, ".work-state", "cto", "resident-preparation", "specification-preparation.transaction.json");
      const original = readFileSync(journalPath);
      const originalIno = lstatSync(journalPath).ino;
      let replaced = false;
      setCtoSpecificationPreparationFailureInjector((point) => {
        if (point !== "before_preparation_journal_clear" || replaced) return;
        replaced = true;
        unlinkSync(journalPath);
        writeFileSync(journalPath, original);
        assert.notEqual(lstatSync(journalPath).ino, originalIno, "replacement journal must have a distinct inode");
      });
      const recovered = prepareCtoSpecificationPreparationWithRuntime(root, preparationInput as never);
      setCtoSpecificationPreparationFailureInjector(null);
      assert.equal(recovered.status, "blocked", JSON.stringify(recovered));
      assert.equal(replaced, true);
      assert.deepEqual(readFileSync(journalPath), original, "replacement journal bytes must survive the exact clear refusal");
    } finally {
      setCtoSpecificationPreparationFailureInjector(null);
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("keeps the largest normalized request journal readable through recovery and replay", () => {
    const root = project();
    try {
      const requests = Array.from({ length: 8 }, (_, index) => ({
        request_id: `maximum-request-${index}`,
        feature_id: `maximum-feature-${index}`,
        request: "r".repeat(MAX_CTO_SPECIFICATION_TEXT_BYTES),
      }));
      const preparationInput = input({ capacity: 8, requests });
      assert.ok(Buffer.byteLength(JSON.stringify(preparationInput), "utf8") <= MAX_CTO_SPECIFICATION_AGGREGATE_BYTES);

      let injected = false;
      setCtoSpecificationPreparationFailureInjector((point) => {
        if (!injected && point === "before_state_write") {
          injected = true;
          throw new Error("injected before_state_write");
        }
      });
      const failed = prepareCtoSpecificationPreparationWithRuntime(root, preparationInput as never);
      setCtoSpecificationPreparationFailureInjector(null);
      assert.equal(failed.status, "blocked", JSON.stringify(failed));
      assert.equal(existsSync(join(root, ".work-state", "cto", "resident-preparation", "state.json")), false);
      assert.equal(existsSync(join(root, ".work-state", "features", "maximum-feature-0", "state.json")), false);

      const retry = prepareCtoSpecificationPreparationWithRuntime(root, preparationInput as never);
      assert.equal(retry.status, "ready", JSON.stringify(retry));
      if (retry.status !== "ready") return;
      assert.equal(retry.features.length, 8);
      assert.equal(readFileSync(join(root, ".work-state", "cto", retry.cto_run_id, "state.json"), "utf8").includes("maximum-feature-7"), true);
      const replay = prepareCtoSpecificationPreparationWithRuntime(root, preparationInput as never);
      assert.equal(replay.status, "ready", JSON.stringify(replay));
    } finally {
      setCtoSpecificationPreparationFailureInjector(null);
      rmSync(root, { recursive: true, force: true });
    }
  });
  test("rejects a cross-run bootstrap journal without touching foreign feature paths", () => {
    const root = project();
    const pinned = PinnedProjectRoot.open(root);
    assert.ok(pinned);
    if (!pinned) return;
    try {
      const foreignFeature = {
        request_id: "foreign-request",
        feature_id: "foreign-feature",
        run_key: "spec-foreign",
        workspace_path: "specs/foreign-feature",
        state_path: ".work-state/features/foreign-feature/state.json",
        profile_name: "spec-preparation",
        profile_hash: "profile-hash",
        phase_writer_id: `cto-writer-${sha256Hex("foreign-feature\u0000specify").slice(0, 16)}`,
        facets: ["primary"],
        request: "foreign",
      };
      pinned.ensureDirectories([
        ".work-state/cto/resident-preparation",
        ".work-state/features/foreign-feature",
        "specs/foreign-feature",
      ]);
      pinned.writeAtomic(".work-state/features/foreign-feature/team-state.md", "foreign sentinel\n");
      pinned.writeAtomic(".work-state/cto/resident-preparation/specification-preparation.transaction.json", `${JSON.stringify({
        schema_version: 1,
        kind: "bootstrap",
        id: `cto-bootstrap-${"0".repeat(32)}`,
        status: "prepared",
        request_digest: "0".repeat(64),
        root_identity: { canonical_path: pinned.canonical_root, dev: pinned.dev, ino: pinned.ino },
        cto_run_id: "foreign-run",
        task: "foreign",
        branch: "foreign",
        wave_id: "wave-foreign",
        source_id: "source-foreign",
        features: [foreignFeature],
        workspace_digests: {},
        updated_at: new Date().toISOString(),
      }, null, 2)}\n`);
      const result = prepareCtoSpecificationPreparationWithRuntime(root, input() as never);
      assert.equal(result.status, "blocked", JSON.stringify(result));
      assert.equal(existsSync(join(root, ".work-state", "features", "foreign-feature", "team-state.md")), true);
      assert.equal(existsSync(join(root, "specs", "foreign-feature")), true);
      assert.equal(existsSync(join(root, ".work-state", "cto", "resident-preparation", "state.json")), false);
    } finally {
      pinned.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
  test("rejects a cap-plus-one bootstrap journal before CTO state mutation", () => {
    const root = project();
    const journalPath = join(root, ".work-state", "cto", "resident-preparation", "specification-preparation.transaction.json");
    const statePath = join(root, ".work-state", "cto", "resident-preparation", "state.json");
    try {
      mkdirSync(join(root, ".work-state", "cto", "resident-preparation"), { recursive: true });
      const durableJournalCap = MAX_CTO_SPECIFICATION_AGGREGATE_BYTES * 2;
      const emptyPadding = `${JSON.stringify({ padding: "" })}\n`;
      const paddingLength = durableJournalCap - Buffer.byteLength(emptyPadding, "utf8") + 1;
      const oversized = `${JSON.stringify({ padding: "x".repeat(paddingLength) })}\n`;
      assert.equal(Buffer.byteLength(oversized, "utf8"), durableJournalCap + 1);
      writeFileSync(journalPath, oversized, "utf8");

      const result = prepareCtoSpecificationPreparationWithRuntime(root, input() as never);
      assert.equal(result.status, "blocked", JSON.stringify(result));
      if (result.status === "blocked") assert.match(result.findings.join("\n"), /bootstrap preparation journal is unreadable/u);
      assert.equal(existsSync(statePath), false);
      assert.equal(existsSync(join(root, ".work-state", "features", "feature-a", "state.json")), false);
      assert.equal(existsSync(journalPath), true, "a reader rejection must not clear the offending journal");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("fails closed on a workspace path symlink swap during bootstrap recovery", () => {
    const root = project();
    const foreign = mkdtempSync(join(tmpdir(), "cto-preparation-foreign-"));
    try {
      let injected = false;
      setCtoSpecificationPreparationFailureInjector((point) => {
        if (!injected && point === "after_workspace_mkdir") {
          injected = true;
          rmSync(join(root, ".work-state", "features", "feature-a"), { recursive: true, force: true });
          symlinkSync(foreign, join(root, ".work-state", "features", "feature-a"), "dir");
          writeFileSync(join(foreign, "sentinel"), "must survive\n");
          throw new Error("injected path swap");
        }
      });
      const result = prepareCtoSpecificationPreparationWithRuntime(root, input() as never);
      setCtoSpecificationPreparationFailureInjector(null);
      assert.equal(result.status, "blocked", JSON.stringify(result));
      assert.equal(lstatSync(join(root, ".work-state", "features", "feature-a")).isSymbolicLink(), true);
      assert.equal(readFileSync(join(foreign, "sentinel"), "utf8"), "must survive\n");
      assert.equal(existsSync(join(root, ".work-state", "cto", "resident-preparation", "state.json")), false);
    } finally {
      setCtoSpecificationPreparationFailureInjector(null);
      rmSync(root, { recursive: true, force: true });
      rmSync(foreign, { recursive: true, force: true });
    }
  });

  test("fails closed on a journaled workspace digest tamper", () => {
    const root = project();
    try {
      let workspaceStarts = 0;
      setCtoSpecificationPreparationFailureInjector((point) => {
        if (point === "before_workspace_mkdir") {
          workspaceStarts += 1;
          if (workspaceStarts === 2) {
            const path = join(root, ".work-state", "features", "feature-a", "state.json");
            const state = JSON.parse(readFileSync(path, "utf8")) as { specification?: { display_name?: string } };
            state.specification = { ...state.specification, display_name: "tampered" };
            writeFileSync(path, `${JSON.stringify(state)}\n`, "utf8");
            throw new Error("injected digest tamper");
          }
        }
      });
      const failed = prepareCtoSpecificationPreparationWithRuntime(root, input() as never);
      setCtoSpecificationPreparationFailureInjector(null);
      assert.equal(failed.status, "blocked", JSON.stringify(failed));
      const retry = prepareCtoSpecificationPreparationWithRuntime(root, input() as never);
      assert.equal(retry.status, "blocked", JSON.stringify(retry));
      assert.equal(existsSync(join(root, ".work-state", "features", "feature-a", "state.json")), true);
      assert.equal(existsSync(join(root, ".work-state", "cto", "resident-preparation", "state.json")), false);
    } finally {
      setCtoSpecificationPreparationFailureInjector(null);
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("fails closed on existing workspace collision and resident-run mismatch", () => {
    const root = project();
    try {
      writeFileSync(join(root, ".work-state-placeholder"), "collision marker");
      const mismatch = prepareCtoSpecificationPreparationWithRuntime(root, input({ cto_run_id: "child-run" }) as never);
      assert.equal(mismatch.status, "blocked");
      if (mismatch.status === "blocked") assert.match(mismatch.findings.join(" "), /resident|nested/i);
      const existing = prepareCtoSpecificationPreparationWithRuntime(root, input({ requests: [{ request_id: "existing", feature_id: "feature-a", request: "existing" }] }) as never);
      assert.equal(existing.status, "ready");
      const collision = prepareCtoSpecificationPreparationWithRuntime(root, input({ requests: [{ request_id: "different", feature_id: "feature-a", request: "different" }] }) as never);
      assert.equal(collision.status, "blocked");
      if (collision.status === "blocked") assert.match(collision.findings.join(" "), /collision|identity|existing/i);
      assert.equal(existsSync(join(root, ".work-state", "cto", "different-run", "state.json")), false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("keeps facet serialization and queue reasons visible", () => {
    const root = project();
    try {
      const result = prepareCtoSpecificationPreparationWithRuntime(root, input({
        capacity: 1,
        requests: [
          { request_id: "facet-request", feature_id: "feature-faceted", request: "Prepare facets", facet_ids: ["billing", "payments"] },
          { request_id: "overflow-request", feature_id: "feature-overflow", request: "Prepare overflow" },
        ],
      }) as never);
      assert.equal(result.status, "ready", JSON.stringify(result));
      if (result.status !== "ready") return;
      assert.equal(result.features.length, 1, "features expose only scheduled workspaces; queued requests have no workspace");
      assert.equal(result.features[0]?.facets.length, 2);
      assert.equal(result.scheduled.length, 1);
      assert.equal(result.queued.length, 2);
      assert.equal(result.queued.some((row) => row.reason_code === "same_feature_serialized"), true);
      assert.equal(result.queued.some((row) => row.reason_code === "capacity"), true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("mounts strict preparation tools and prompt requires bootstrap before generic prepare", () => {
    const root = project();
    writeTestRegistryMarker(root);
    const registration = openTestRegistry(root, ["workflow_tools"], "cto-preparation-entry");
    const tools = new Map<string, { parameters: { safeParse: (value: unknown) => { success: boolean } } }>();
    registerCtoTools({
      zod: { z },
      on: TEST_ON,
      registerTool(tool: { name: string; parameters: { safeParse: (value: unknown) => { success: boolean } } }) { tools.set(tool.name, tool); },
    } as never, { owner: () => registration.owner, cwd: root, registrationToken: registration.token });
    registration.finish(true);
    rmSync(root, { recursive: true, force: true });
    for (const name of ["cto_specification_prepare", "cto_specification_review", "cto_specification_decide", "cto_specification_advance"]) {
      assert.ok(tools.has(name), `${name} is mounted`);
    }
    const prepare = tools.get("cto_specification_prepare")!;
    const mountedInput = { ...input() };
    for (const field of ["resident_cto_run_id", "capacity", "depth", "max_depth"]) delete mountedInput[field];
    assert.equal(prepare.parameters.safeParse(mountedInput).success, true);
    assert.equal(prepare.parameters.safeParse(input()).success, false, "engine-owned authority fields are not caller-controlled");
    assert.equal(prepare.parameters.safeParse({ ...mountedInput, unexpected: true }).success, false);
    const oversizedRequests = Array.from({ length: 65 }, (_, index) => ({
      request_id: `request-${index}`,
      feature_id: `feature-${index}`,
      request: "bounded request",
    }));
    assert.equal(prepare.parameters.safeParse({ ...mountedInput, requests: oversizedRequests }).success, false, "request batches are capped at 64");
    const unicodeOversize = "я".repeat(16 * 1024);
    assert.equal(prepare.parameters.safeParse({ ...mountedInput, requests: [{ request_id: "request-unicode", feature_id: "feature-unicode", request: unicodeOversize }] }).success, false, "request text is capped by UTF-8 bytes");
    const requestText = "r".repeat(Math.floor(MAX_CTO_SPECIFICATION_AGGREGATE_BYTES / MAX_CTO_SPECIFICATION_REQUESTS));
    const aggregateSafeRequests = Array.from({ length: Math.floor(MAX_CTO_SPECIFICATION_REQUESTS / 2) }, (_, index) => ({
      request_id: `aggregate-request-${index}`,
      feature_id: `aggregate-feature-${index}`,
      request: requestText,
    }));
    assert.equal(
      prepare.parameters.safeParse({ ...mountedInput, requests: aggregateSafeRequests }).success,
      true,
      "preparation payload below the aggregate budget remains admissible",
    );
    const aggregateOversizeRequests = Array.from({ length: MAX_CTO_SPECIFICATION_REQUESTS }, (_, index) => ({
      request_id: `aggregate-over-request-${index}`,
      feature_id: `aggregate-over-feature-${index}`,
      request: requestText,
    }));
    assert.equal(
      prepare.parameters.safeParse({ ...mountedInput, requests: aggregateOversizeRequests }).success,
      false,
      "preparation payload above the aggregate budget is rejected by the mounted schema",
    );
    const decide = tools.get("cto_specification_decide")!;
    const decision = {
      feature_id: "feature-a",
      run_key: "run-a",
      phase: "specify",
      decision: "approve_continue",
      checkpoint_ref: "checkpoint.specify.v1",
      trusted_answer_ref: "answer-a",
      trusted_proof: { answer_id: "answer-a", nonce: "nonce-a", channel: "terminal", reference: "terminal/answer-a", binding: "binding-a" },
    };
    assert.equal(decide.parameters.safeParse({ cto_run_id: "resident-preparation", decisions: Array.from({ length: 65 }, () => decision) }).success, false, "decision batches are capped");
    assert.equal(decide.parameters.safeParse({ cto_run_id: "resident-preparation", decisions: [{ ...decision, trusted_proof: { ...decision.trusted_proof, reference: unicodeOversize } }] }).success, false, "proof strings are capped by UTF-8 bytes");
  });
  test("rejects oversized request batches before traversing entries", () => {
    const root = project();
    try {
      const result = prepareCtoSpecificationPreparationWithRuntime(root, input({
        requests: Array.from({ length: 65 }, (_, index) => ({
          request_id: `request-${index}`,
          feature_id: `feature-${index}`,
          request: "bounded request",
        })),
      }) as never);
      assert.equal(result.status, "blocked");
      if (result.status === "blocked") assert.deepEqual(result.findings, ["requests may contain at most 64 entries"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
  test("rejects oversized preparation payloads before any state writes", () => {
    const root = project();
    try {
      const requestText = "r".repeat(Math.floor(MAX_CTO_SPECIFICATION_AGGREGATE_BYTES / MAX_CTO_SPECIFICATION_REQUESTS));
      const oversized = prepareCtoSpecificationPreparationWithRuntime(root, input({
        requests: Array.from({ length: MAX_CTO_SPECIFICATION_REQUESTS }, (_, index) => ({
          request_id: `aggregate-over-request-${index}`,
          feature_id: `aggregate-over-feature-${index}`,
          request: requestText,
        })),
      }) as never);
      assert.equal(oversized.status, "blocked");
      if (oversized.status === "blocked") {
        assert.deepEqual(oversized.findings, [`preparation input exceeds ${MAX_CTO_SPECIFICATION_AGGREGATE_BYTES} bytes`]);
      }
      assert.equal(existsSync(join(root, ".work-state")), false, "oversized preparation input must not create state directories");
      assert.equal(existsSync(join(root, ".work-state", "cto", "resident-preparation", "specification-preparation.transaction.json")), false, "oversized preparation input must not create a bootstrap journal");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
  test("rejects oversized decision batches before traversing entries", () => {
    const root = project();
    try {
      const prepared = prepareCtoSpecificationPreparationWithRuntime(root, input());
      if (prepared.status !== "ready") return;
      const decisions = Array.from({ length: 65 }, () => ({ invalid: true }));
      const runtime = preparationRuntimeOptions(root);
      let result: ReturnType<typeof decideCtoSpecificationPreparation>;
      try {
        result = decideCtoSpecificationPreparation(root, {
          cto_run_id: prepared.cto_run_id,
          decisions,
        }, runtime);
      } finally {
        runtime.cleanup();
      }
      assert.equal(result.status, "blocked");
      if (result.status === "blocked") assert.deepEqual(result.findings, ["decisions may contain at most 64 entries"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("scoped review ignores malformed unrelated workspaces but rejects exact missing or unsafe selections", () => {
    const root = project();
    try {
      const prepared = prepareCtoSpecificationPreparationWithRuntime(root, input());
      assert.equal(prepared.status, "ready", JSON.stringify(prepared));
      if (prepared.status !== "ready") return;
      mkdirSync(join(root, ".work-state", "features", "unrelated"), { recursive: true });
      writeFileSync(join(root, ".work-state", "features", "unrelated", "state.json"), "{ malformed", "utf8");

      const runtime = preparationRuntimeOptions(root);
      let review: ReturnType<typeof reviewCtoSpecificationPreparation>;
      try {
        review = reviewCtoSpecificationPreparation(root, { cto_run_id: prepared.cto_run_id }, runtime);
      } finally {
        runtime.cleanup();
      }
      assert.equal("status" in review, false, JSON.stringify(review));

      const pinnedRoot = PinnedProjectRoot.open(root);
      assert.ok(pinnedRoot);
      if (!pinnedRoot) return;
      try {
        const missing = buildCtoSpecificationReviewPacketFromDecisionSnapshotPinned(
          pinnedRoot,
          { cto_run_id: prepared.cto_run_id },
          [],
          new Set(["missing-feature"]),
        );
        assert.equal(missing.ok, false);
        if (!missing.ok) assert.match(missing.error, /allowed feature.*missing/i);

        const unsafe = buildCtoSpecificationReviewPacketFromDecisionSnapshotPinned(
          pinnedRoot,
          { cto_run_id: prepared.cto_run_id },
          [],
          new Set(["../escape"]),
        );
        assert.equal(unsafe.ok, false);
        if (!unsafe.ok) assert.match(unsafe.error, /unsafe allowed feature/i);
      } finally {
        pinnedRoot.close();
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
  test("review packet rejects deep and wide malformed state before projection", () => {
    const root = project();
    try {
      const prepared = prepareCtoSpecificationPreparationWithRuntime(root, input());
      assert.equal(prepared.status, "ready", JSON.stringify(prepared));
      if (prepared.status !== "ready") return;
      const featureStatePath = join(root, ".work-state", "features", "feature-a", "state.json");
      const packetPath = join(root, ".work-state", "cto", prepared.cto_run_id, "specification-review-packet.md");
      const original = readFileSync(featureStatePath, "utf8");
      const malformedStates: Array<{ label: string; value: unknown }> = [];
      let deepObject: unknown = "leaf";
      for (let depth = 0; depth < 130; depth += 1) deepObject = { next: deepObject };
      malformedStates.push({ label: "deep object", value: deepObject });
      malformedStates.push({ label: "wide array", value: Array.from({ length: 16_385 }, () => "entry") });
      let nestedArrays: unknown = "leaf";
      for (let depth = 0; depth < 130; depth += 1) nestedArrays = [nestedArrays];
      malformedStates.push({ label: "deep nested arrays", value: nestedArrays });
      const pinnedRoot = PinnedProjectRoot.open(root);
      assert.ok(pinnedRoot);
      if (!pinnedRoot) return;
      try {
        for (const malformed of malformedStates) {
          const state = JSON.parse(original) as Record<string, unknown>;
          state.specification = { ...(state.specification as Record<string, unknown>), malformed: malformed.value };
          writeFileSync(featureStatePath, JSON.stringify(state), "utf8");
          const beforePacketRead = readFileSync(featureStatePath, "utf8");
          const packet = buildCtoSpecificationReviewPacketFromDecisionSnapshotPinned(
            pinnedRoot,
            { cto_run_id: prepared.cto_run_id },
            [],
            new Set(["feature-a"]),
          );
          assert.equal(packet.ok, false, `${malformed.label} state must be rejected`);
          if (!packet.ok) {
            assert.equal(packet.code, "CTO_REVIEW_STATE_INVALID");
            assert.match(packet.error, /bounded structural limits|unsafe object shape/u);
          }
          assert.equal(readFileSync(featureStatePath, "utf8"), beforePacketRead, `${malformed.label} review must not rewrite state`);
          assert.equal(existsSync(packetPath), false, `${malformed.label} review must not publish a packet`);
          writeFileSync(featureStatePath, original, "utf8");
        }
      } finally {
        pinnedRoot.close();
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
  test("review packet rejects invalid UTF-8 state before projection", () => {
    const root = project();
    try {
      const prepared = prepareCtoSpecificationPreparationWithRuntime(root, input());
      assert.equal(prepared.status, "ready", JSON.stringify(prepared));
      if (prepared.status !== "ready") return;
      const featureStatePath = join(root, ".work-state", "features", "feature-a", "state.json");
      const packetPath = join(root, ".work-state", "cto", prepared.cto_run_id, "specification-review-packet.md");
      const original = readFileSync(featureStatePath);
      writeFileSync(featureStatePath, Buffer.from([0xff, 0xfe, 0x7b]));
      const packet = buildCtoSpecificationReviewPacketFromDecisionSnapshot(
        root,
        { cto_run_id: prepared.cto_run_id },
        [],
      );
      assert.equal(packet.ok, false);
      if (!packet.ok) {
        assert.equal(packet.code, "CTO_REVIEW_STATE_INVALID");
        assert.match(packet.error, /not valid UTF-8/u);
      }
      assert.deepEqual(readFileSync(featureStatePath), Buffer.from([0xff, 0xfe, 0x7b]));
      assert.equal(existsSync(packetPath), false);
      writeFileSync(featureStatePath, original);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
