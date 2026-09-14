import { test } from "node:test";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import * as core from "../src/index.js";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, realpathSync, renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import {
  registerWorkflowCommands,
  registerCtoTools,
  registerTeamWorkflow,
  type WorkflowOwnerIdentity,
} from "../src/index.js";
import { closeRetainedTestRegistrations, openTestRegistry, writeTestRegistryMarker } from "./fixtures/registry-activation.js";
import { registerTestCtoTools, registerTestTeamWorkflow } from "./fixtures/host-tool-activation.js";
import {
  releaseWorkflowOwners,
  workflowOwnerFor,
  beginRegistryRegistration as beginOwnerRegistry,
  openWorkflowActivation,
  commitRegistryRegistration as commitOwnerRegistry,
  createRegistryRegistrationLiveGuard,
  recordRegistryCommit,
  recordRegistryUndo,
  registryRegistrationOwnerMatches,
  registryRegistrationPrincipal,
  registryRegistrationProjectRoot,
  requireRegistryContext,
  requireRegistryRegistration,
  rollbackRegistryRegistration as rollbackOwnerRegistry,
} from "../src/registry/owner.js";
import { closeWorkflowActivation } from "../src/registry/index.js";
import { PinnedProjectRoot } from "../src/specification/pinned-root.js";
import { MAX_WORKFLOW_COMMAND_ARGUMENT_BYTES } from "../src/commands/register.js";
import { setArtifactContractPolicy, setConstitutionContinuationGate, setFanInPolicy } from "../src/engine/durable.js";
import { withExecutionLiveness } from "../src/execution-liveness.js";
import { ctoRuntimeSessionAuthorityForContext, openCtoRuntimeAccess } from "../src/cto/runtime-access.js";

type CommandHandler = (args: string, ctx: unknown) => Promise<void>;
type SessionStartHandler = (event: unknown, ctx: unknown) => void;

type CommandHarness = {
  commands: Map<string, { handler: CommandHandler }>;
  prompts: string[];
  sessionStarts: SessionStartHandler[];
  sessionShutdowns: SessionStartHandler[];
  registerCalls: number;
  pi: {
    registerCommand(name: string, command: { handler: CommandHandler }): void;
    on(event: string, handler: SessionStartHandler): void;
    sendUserMessage(prompt: string): void;
  };
};

function owner(ownerId: string, cwd: string): WorkflowOwnerIdentity {
  return {
    owner_id: ownerId,
    bundle_id: ownerId,
    owner_kind: "private_omp",
    activation_marker: `${ownerId}-activation`,
    host_range: ">=17 <19",
    provenance: {
      package: ownerId,
      entrypoint: "dist/index.js",
      cwd,
      config_path: join(cwd, ".omp", "team.config.json"),
    },
  };
}

function activationOwner(ownerId: string, cwd: string, markerPath: string, sha256?: string): WorkflowOwnerIdentity {
  const markerId = ownerId + "-activation";
  return {
    ...owner(ownerId, cwd),
    activation_marker: markerId,
    activation: { marker_id: markerId, required: [{ path: markerPath, kind: "file", ...(sha256 ? { sha256 } : {}) }] },
  };
}

function marker(root: string, contents = "marker"): { path: string; sha256: string } {
  const path = join(root, ".omp-activation-marker");
  writeFileSync(path, contents);
  return { path: ".omp-activation-marker", sha256: createHash("sha256").update(contents).digest("hex") };
}

function openClaim(root: string, capabilities: readonly import("../src/registry/owner.js").WorkflowCapability[], ownerId: string): import("../src/registry/owner.js").WorkflowActivationResult {
  const markerInfo = marker(root);
  return openWorkflowActivation(root, capabilities, activationOwner(ownerId, root, markerInfo.path, markerInfo.sha256));
}

test("one activation shares principal and marker generation across contexts, release mints fresh identities", () => {
  const root = mkdtempSync(join(tmpdir(), "omp-owner-lifecycle-identities-"));
  try {
    const observed = marker(root);
    const activatedOwner = activationOwner("lifecycle-identities", root, observed.path, observed.sha256);
    const first = openWorkflowActivation(root, ["workflow_registration", "workflow_tools"], activatedOwner);
    assert.equal(first.ok, true);
    if (!first.ok) return;
    const second = openWorkflowActivation(root, ["workflow_registration", "workflow_tools"], activatedOwner);
    assert.equal(second.ok, true);
    if (!second.ok) return;
    const firstSnapshot = requireRegistryContext(first.registry_context, root, "workflow_registration");
    const secondSnapshot = requireRegistryContext(second.registry_context, root, "workflow_registration");
    assert.equal(secondSnapshot.marker_generation, firstSnapshot.marker_generation);
    assert.equal(secondSnapshot.marker_digest, firstSnapshot.marker_digest);
    const firstTransaction = beginOwnerRegistry(first.registry_context, root, ["constitution_gate"]);
    assert.equal(firstTransaction.ok, true);
    if (!firstTransaction.ok) return;
    const firstPrincipal = registryRegistrationPrincipal(firstTransaction.token, "constitution_gate");
    commitOwnerRegistry(firstTransaction.token);
    const secondTransaction = beginOwnerRegistry(second.registry_context, root, ["constitution_gate"]);
    assert.equal(secondTransaction.ok, true);
    if (!secondTransaction.ok) return;
    const secondPrincipal = registryRegistrationPrincipal(secondTransaction.token, "constitution_gate");
    assert.equal(secondPrincipal, firstPrincipal);
    commitOwnerRegistry(secondTransaction.token);
    closeWorkflowActivation(second);
    closeWorkflowActivation(first);

    const reopened = openWorkflowActivation(root, ["workflow_registration", "workflow_tools"], activatedOwner);
    assert.equal(reopened.ok, true);
    if (!reopened.ok) return;
    const reopenedSnapshot = requireRegistryContext(reopened.registry_context, root, "workflow_registration");
    assert.equal(reopenedSnapshot.marker_digest, firstSnapshot.marker_digest);
    assert.ok(reopenedSnapshot.marker_generation > firstSnapshot.marker_generation);
    const reopenedTransaction = beginOwnerRegistry(reopened.registry_context, root, ["constitution_gate"]);
    assert.equal(reopenedTransaction.ok, true);
    if (!reopenedTransaction.ok) return;
    const reopenedPrincipal = registryRegistrationPrincipal(reopenedTransaction.token, "constitution_gate");
    assert.notEqual(reopenedPrincipal, firstPrincipal);
    commitOwnerRegistry(reopenedTransaction.token);
    closeWorkflowActivation(reopened);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("repeated unique marker activations release lifecycle identities without historical cache growth", () => {
  const root = mkdtempSync(join(tmpdir(), "omp-owner-lifecycle-bounded-"));
  try {
    for (let index = 0; index < 1024; index += 1) {
      const opened = openClaim(root, ["workflow_registration", "constitution_gate"], `lifecycle-bounded-${index}`);
      assert.equal(opened.ok, true);
      if (opened.ok) closeWorkflowActivation(opened);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("constitution gate cache rejects the 256th root without partial registration", () => {
  const fixture = resolve(new URL("./fixtures/registry-activation.ts", import.meta.url).pathname);
  const hostToolFixture = resolve(new URL("./fixtures/host-tool-activation.ts", import.meta.url).pathname);
  const source = `
    import { mkdtempSync, rmSync } from "node:fs";
    import { join } from "node:path";
    import { tmpdir } from "node:os";
    import { closeRetainedTestRegistrations, openTestRegistry, writeTestRegistryMarker } from ${JSON.stringify(fixture)};
    import { registerTestTeamWorkflow } from ${JSON.stringify(hostToolFixture)};
    import { setConstitutionContinuationGate } from ${JSON.stringify(resolve(new URL("../src/engine/durable.ts", import.meta.url).pathname))};
    import { workflowOwnerFor } from ${JSON.stringify(resolve(new URL("../src/registry/owner.ts", import.meta.url).pathname))};
    const roots = [];
    try {
      for (let index = 0; index < 255; index += 1) {
        const root = mkdtempSync(join(tmpdir(), "omp-gate-cache-cap-"));
        roots.push(root);
        registerTestTeamWorkflow(root, { setLabel() {}, on() {} }, { observability: false }, "gate-cap-" + index);
      }
      const failedRoot = mkdtempSync(join(tmpdir(), "omp-gate-cache-cap-failed-"));
      roots.push(failedRoot);
      let failure = "";
      try {
        registerTestTeamWorkflow(failedRoot, { setLabel() {}, on() {} }, { observability: false }, "gate-cap-failed");
      } catch (error) {
        failure = String(error instanceof Error ? error.message : error);
      }
      if (!failure.includes("constitution continuation gate cache is at capacity")) throw new Error("unexpected cache-cap error: " + failure);
      if (workflowOwnerFor(failedRoot, "constitution_gate") !== undefined) throw new Error("failed cache-cap registration retained a constitution owner");
      const durableRoot = mkdtempSync(join(tmpdir(), "omp-durable-gate-cap-"));
      roots.push(durableRoot);
      writeTestRegistryMarker(durableRoot);
      const durableRegistration = openTestRegistry(durableRoot, ["constitution_gate"], "durable-gate-cap");
      let durableFailure = "";
      try {
        setConstitutionContinuationGate(durableRegistration.token, () => null);
      } catch (error) {
        durableFailure = String(error instanceof Error ? error.message : error);
      } finally {
        durableRegistration.finish(false);
      }
      if (!durableFailure.includes("constitution continuation gate registry is at capacity")) throw new Error("unexpected durable cache-cap error: " + durableFailure);
      if (workflowOwnerFor(durableRoot, "constitution_gate") !== undefined) throw new Error("failed durable cache-cap registration retained a constitution owner");
      // Release one committed activation, then force durable registration to
      // sweep its dead lease before checking capacity again.
      closeRetainedTestRegistrations(roots[0]);
      const recoveredRoot = mkdtempSync(join(tmpdir(), "omp-durable-gate-cap-recovered-"));
      roots.push(recoveredRoot);
      writeTestRegistryMarker(recoveredRoot);
      const recoveredRegistration = openTestRegistry(recoveredRoot, ["constitution_gate"], "durable-gate-cap-recovered");
      setConstitutionContinuationGate(recoveredRegistration.token, () => null);
      recoveredRegistration.finish(true);
      process.stdout.write(JSON.stringify({ ok: true, roots: roots.length }) + "\\n");
    } finally {
      for (const root of roots) rmSync(root, { recursive: true, force: true });
    }
  `;
  const child = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", source], { encoding: "utf8", timeout: 120_000 });
  assert.equal(child.status, 0, child.stderr || child.stdout);
  const resultMatch = child.stdout.match(/\{"ok":true,"roots":\d+\}/u);
  assert.ok(resultMatch, `isolated cache child returned no result: ${JSON.stringify(child.stdout.slice(0, 256))}`);
  const result = JSON.parse(resultMatch![0]) as { ok?: boolean; roots?: number };
  assert.deepEqual(result, { ok: true, roots: 258 });
});

test("policy cells allow simultaneous same-descriptor activations and reset after release", () => {
  const firstRoot = mkdtempSync(join(tmpdir(), "omp-policy-lease-first-"));
  const secondRoot = mkdtempSync(join(tmpdir(), "omp-policy-lease-second-"));
  const thirdRoot = mkdtempSync(join(tmpdir(), "omp-policy-lease-third-"));
  try {
    writeTestRegistryMarker(firstRoot);
    const first = openTestRegistry(firstRoot, ["artifact_contract_policy", "fan_in_policy"], "policy-lease-first");
    setArtifactContractPolicy(first.token, { validate: true, grandfathered: [] });
    setFanInPolicy(first.token, { enabled: true, strict: true });
    first.retain(true);

    writeTestRegistryMarker(secondRoot);
    const second = openTestRegistry(secondRoot, ["artifact_contract_policy", "fan_in_policy"], "policy-lease-second");
    setArtifactContractPolicy(second.token, { validate: true, grandfathered: [] });
    setFanInPolicy(second.token, { enabled: true, strict: true });
    assert.throws(() => setArtifactContractPolicy(second.token, { validate: false, grandfathered: [] }), /already registered by another descriptor/);
    assert.throws(() => setFanInPolicy(second.token, { enabled: false, strict: true }), /already registered by another descriptor/);
    second.retain(true);

    closeRetainedTestRegistrations(firstRoot);
    writeTestRegistryMarker(thirdRoot);
    const conflict = openTestRegistry(thirdRoot, ["artifact_contract_policy"], "policy-lease-conflict");
    assert.throws(() => setArtifactContractPolicy(conflict.token, { validate: false, grandfathered: [] }), /already registered by another descriptor/);
    conflict.finish(false);
    closeRetainedTestRegistrations(secondRoot);
    const third = openTestRegistry(thirdRoot, ["artifact_contract_policy", "fan_in_policy"], "policy-lease-third");
    setArtifactContractPolicy(third.token, { validate: false, grandfathered: [] });
    setFanInPolicy(third.token, { enabled: false, strict: true });
    third.finish(true);
  } finally {
    closeRetainedTestRegistrations();
    rmSync(firstRoot, { recursive: true, force: true });
    rmSync(secondRoot, { recursive: true, force: true });
    rmSync(thirdRoot, { recursive: true, force: true });
  }
});

test("policy and gate registration arm rollback before exhausting transaction callbacks", () => {
  const root = mkdtempSync(join(tmpdir(), "omp-registry-callback-cap-"));
  try {
    writeTestRegistryMarker(root);
    const registration = openTestRegistry(root, ["artifact_contract_policy", "constitution_gate"], "registry-callback-cap");
    for (let index = 0; index < 256; index += 1) recordRegistryUndo(registration.token, () => {});
    assert.throws(
      () => setArtifactContractPolicy(registration.token, { validate: false, grandfathered: [] }),
      /registry transaction callbacks are bounded at 256/,
    );
    assert.throws(
      () => setConstitutionContinuationGate(registration.token, () => null),
      /registry transaction callbacks are bounded at 256/,
    );
    registration.finish(false);

    // A fresh transaction must observe the private defaults: the failed
    // setters could not publish a cell before their compensation was armed.
    const retry = openTestRegistry(root, ["artifact_contract_policy", "constitution_gate"], "registry-callback-cap-retry");
    setArtifactContractPolicy(retry.token, { validate: false, grandfathered: [] });
    setConstitutionContinuationGate(retry.token, () => null);
    retry.finish(false);

    const live = openTestRegistry(root, ["artifact_contract_policy"], "registry-callback-cap-live");
    setArtifactContractPolicy(live.token, { validate: false, grandfathered: [] });
    live.retain(true);
    const existing = openTestRegistry(root, ["artifact_contract_policy"], "registry-callback-cap-live");
    for (let index = 0; index < 256; index += 1) recordRegistryUndo(existing.token, () => {});
    assert.throws(
      () => setArtifactContractPolicy(existing.token, { validate: false, grandfathered: [] }),
      /registry transaction callbacks are bounded at 256/,
    );
    existing.finish(false);
    closeRetainedTestRegistrations(root);
    const afterRelease = openTestRegistry(root, ["artifact_contract_policy"], "registry-callback-cap-after-release");
    setArtifactContractPolicy(afterRelease.token, { validate: true, grandfathered: [] });
    afterRelease.finish(false);
  } finally {
    closeRetainedTestRegistrations();
    rmSync(root, { recursive: true, force: true });
  }
});

test("released constitution gate is swept and same-root replacement can register", () => {
  const parent = mkdtempSync(join(tmpdir(), "omp-gate-lease-parent-"));
  const root = join(parent, "project");
  mkdirSync(root);
  try {
    writeTestRegistryMarker(root);
    const first = openTestRegistry(root, ["constitution_gate"], "gate-lease-first");
    setConstitutionContinuationGate(first.token, () => null);
    first.retain(true);
    rmSync(root, { recursive: true, force: true });
    mkdirSync(root);
    writeTestRegistryMarker(root);
    const replacement = openTestRegistry(root, ["constitution_gate"], "gate-lease-replacement");
    setConstitutionContinuationGate(replacement.token, () => null);
    replacement.finish(true);
  } finally {
    closeRetainedTestRegistrations();
    rmSync(parent, { recursive: true, force: true });
  }
});

function commandHarness(): CommandHarness {
  const commands = new Map<string, { handler: CommandHandler }>();
  const prompts: string[] = [];
  const sessionStarts: SessionStartHandler[] = [];
  const sessionShutdowns: SessionStartHandler[] = [];
  let registerCalls = 0;
  const pi = {
    registerCommand(name: string, command: { handler: CommandHandler }) {
      registerCalls += 1;
      commands.set(name, command);
    },
    on(event: string, handler: SessionStartHandler) {
      if (event === "session_start") sessionStarts.push(handler);
      if (event === "session_shutdown") sessionShutdowns.push(handler);
    },
    sendUserMessage(prompt: string) {
      prompts.push(prompt);
    },
  };
  return {
    commands,
    prompts,
    sessionStarts,
    sessionShutdowns,
    get registerCalls() {
      return registerCalls;
    },
    pi,
  };
}

test("owner registry canonicalizes a symlink alias to one physical worktree", () => {
  const root = mkdtempSync(join(tmpdir(), "omp-owner-real-"));
  const alias = join(tmpdir(), `omp-owner-alias-${process.pid}-${Date.now()}`);
  symlinkSync(root, alias, "dir");
  try {
    const first = openClaim(root, ["workflow_registration"], "bundle-one");
    assert.equal(first.ok, true);
    if (!first.ok) return;
    assert.equal(first.claim.project_root, realpathSync(root));
    assert.equal(first.claim.owner.provenance.cwd, realpathSync(root));
    assert.equal(first.claim.owner.provenance.config_path, join(realpathSync(root), ".omp", "team.config.json"));
    const repeat = openClaim(alias, ["workflow_registration"], "bundle-one");
    assert.equal(repeat.ok, true);
    assert.equal(repeat.ok && repeat.idempotent, true);

    const conflict = openClaim(alias, ["workflow_registration"], "bundle-two");
    assert.equal(conflict.ok, false);
    if (conflict.ok) return;
    assert.equal(conflict.code, "owner_conflict");
    assert.equal(conflict.claim?.owner.owner_id, "bundle-one");
    assert.equal(workflowOwnerFor(alias, "workflow_registration")?.owner.owner_id, "bundle-one");
  } finally {
    rmSync(alias, { force: true });
    rmSync(root, { recursive: true, force: true });
  }
});

test("owner authority is shared by a case-alias of the same physical root", () => {
  const root = mkdtempSync(join(tmpdir(), "omp-owner-case-alias-"));
  const alias = join(resolve(root, ".."), root.slice(root.lastIndexOf("/") + 1).toUpperCase());
  try {
    if (!existsSync(alias)) return;
    const observed = marker(root);
    const first = openWorkflowActivation(root, ["workflow_registration"], activationOwner("case-owner-a", root, observed.path, observed.sha256));
    assert.equal(first.ok, true);
    if (!first.ok) return;
    const second = openWorkflowActivation(alias, ["workflow_registration"], activationOwner("case-owner-b", alias, observed.path, observed.sha256));
    assert.equal(second.ok, false, "a physical-root alias must not admit a second owner");
    if (!second.ok) assert.equal(second.code, "owner_conflict");
    assert.equal(workflowOwnerFor(alias, "workflow_registration")?.owner.owner_id, "case-owner-a");
    closeWorkflowActivation(first);
    assert.equal(workflowOwnerFor(alias, "workflow_registration"), undefined);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("owner-scoped release removes only exact claims and preserves foreign ownership", () => {
  const root = mkdtempSync(join(tmpdir(), "omp-owner-release-"));
  const foreignRoot = mkdtempSync(join(tmpdir(), "omp-owner-release-foreign-"));
  try {
    const claimed = openClaim(root, ["workflow_registration", "workflow_tools"], "bundle-one");
    assert.equal(claimed.ok, true);
    if (!claimed.ok) return;
    const foreignClaim = openClaim(foreignRoot, ["workflow_registration", "config_writer"], "bundle-two");
    assert.equal(foreignClaim.ok, true);
    const foreignAttempt = releaseWorkflowOwners(claimed.release_token, ["workflow_registration"]);
    assert.deepEqual(foreignAttempt.released, ["workflow_registration"]);
    assert.deepEqual(foreignAttempt.skipped, []);
    assert.equal(workflowOwnerFor(root, "workflow_registration"), undefined);
    assert.equal(workflowOwnerFor(foreignRoot, "config_writer")?.owner.owner_id, "bundle-two");

    const exposed = workflowOwnerFor(root, "workflow_tools");
    assert.ok(exposed);
    if (!exposed) return;
    assert.throws(() => { (exposed as any).owner.owner_id = "attacker"; }, TypeError);
    assert.throws(() => { (exposed as any).owner.provenance.package = "attacker"; }, TypeError);
    assert.throws(() => { (exposed as any).fingerprint = "attacker"; }, TypeError);
    const attacker = openClaim(root, ["workflow_registration", "workflow_tools"], "bundle-attacker");
    assert.equal(attacker.ok, false);
    if (!attacker.ok) assert.equal(attacker.code, "owner_conflict");
    assert.equal(workflowOwnerFor(root, "workflow_tools")?.owner.owner_id, "bundle-one");
    assert.equal((core as Record<string, unknown>).resetWorkflowOwners, undefined);
    const forged = { ...claimed.release_token };
    const forgedRelease = releaseWorkflowOwners(forged as never, ["workflow_tools"]);
    assert.deepEqual(forgedRelease.released, []);
    assert.equal(workflowOwnerFor(root, "workflow_tools")?.owner.owner_id, "bundle-one");

    const partial = releaseWorkflowOwners(claimed.release_token, ["workflow_tools"]);
    assert.deepEqual(partial.released, ["workflow_tools"]);
    assert.deepEqual(partial.skipped, []);
    assert.equal(workflowOwnerFor(root, "workflow_registration"), undefined);
    assert.equal(workflowOwnerFor(root, "workflow_tools"), undefined);

    const staleRetry = releaseWorkflowOwners(claimed.release_token, ["workflow_registration"]);
    assert.deepEqual(staleRetry.released, []);
    assert.deepEqual(staleRetry.skipped, ["workflow_registration"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(foreignRoot, { recursive: true, force: true });
  }
});

test("stable release token removes original claims after pathname replacement", () => {
  const root = mkdtempSync(join(tmpdir(), "omp-owner-release-replaced-"));
  const moved = `${root}-moved`;
  try {
    const claimed = openClaim(root, ["workflow_registration", "workflow_tools"], "bundle-one");
    assert.equal(claimed.ok, true);
    if (!claimed.ok) return;
    renameSync(root, moved);
    const released = releaseWorkflowOwners(claimed.release_token, ["workflow_registration", "workflow_tools"]);
    assert.deepEqual(released.released, ["workflow_registration", "workflow_tools"]);
    assert.deepEqual(released.skipped, []);
  } finally {
    rmSync(moved, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  }
});

test("team registration leaves global gate untouched across failed owners and retries", () => {
  const root = mkdtempSync(join(tmpdir(), "omp-team-gate-transaction-"));
  const validRoot = mkdtempSync(join(tmpdir(), "omp-team-gate-valid-"));
  const partialRoot = mkdtempSync(join(tmpdir(), "omp-team-gate-partial-"));
  try {
    const invalidPi = { setLabel() {}, on() {} };
    const invalidOwner = () => { throw new Error("marker-gated owner rejected"); };
    assert.throws(
      () => registerTeamWorkflow(invalidPi as never, { cwd: root, owner: invalidOwner }),
      /marker-gated owner rejected/,
    );
    for (const capability of ["workflow_registration", "config_writer"] as const) {
      assert.equal(workflowOwnerFor(root, capability), undefined);
    }

    let failFirstLabel = true;
    const retryLabels: string[] = [];
    const retryHooks: string[] = [];
    const retryPi = {
      setLabel(label: string) {
        if (failFirstLabel) {
          failFirstLabel = false;
          throw new Error("downstream registration exploded");
        }
        retryLabels.push(label);
      },
      on(name: string) { retryHooks.push(name); },
    };
    assert.throws(() => registerTestTeamWorkflow(root, retryPi as never, { observability: false }, "bundle-failing"), /downstream registration exploded/);
    assert.doesNotThrow(() => registerTestTeamWorkflow(root, retryPi as never, { observability: false }, "bundle-failing"));
    assert.deepEqual(retryLabels, ["omp-workflows"]);
    assert.deepEqual([...new Set(retryHooks)].sort(), ["before_agent_start", "session_stop", "tool_call", "tool_result"].sort());
    assert.equal(new Set(retryHooks).size, retryHooks.length, "a failed activation retry must not duplicate host hooks");
    const partialHooks: string[] = [];
    let failFirstHook = true;
    const partialPi = {
      setLabel() {},
      on(name: string) {
        partialHooks.push(name);
        if (failFirstHook) {
          failFirstHook = false;
          throw new Error("hook mount exploded");
        }
      },
    };
    assert.throws(() => registerTestTeamWorkflow(partialRoot, partialPi as never, { observability: false }, "bundle-partial"), /hook mount exploded/);
    assert.throws(() => registerTestTeamWorkflow(partialRoot, partialPi as never, { observability: false }, "bundle-partial"), /registration_failed/);
    assert.equal(partialHooks.length, 1, "terminal partial mount must not duplicate host hooks on retry");

    const foreignPi = { setLabel() {}, on() {} };
    assert.throws(
      () => registerTestTeamWorkflow(root, foreignPi as never, { observability: false }, "bundle-different"),
      /owner_conflict/,
    );
    closeRetainedTestRegistrations(root);

    const validPi = { setLabel() {}, on() {} };
    assert.doesNotThrow(() => registerTestTeamWorkflow(validRoot, validPi as never, {}, "bundle-valid"));
    assert.ok(workflowOwnerFor(validRoot, "workflow_registration"), "registration helper retains the authenticated owner while host hooks are live");
    closeRetainedTestRegistrations(validRoot);
    assert.equal(workflowOwnerFor(validRoot, "workflow_registration"), undefined, "shared teardown releases the retained owner claims");
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(validRoot, { recursive: true, force: true });
    rmSync(partialRoot, { recursive: true, force: true });
  }
});

test("supplied-token initial runtime authority rolls back before retry", () => {
  const root = mkdtempSync(join(tmpdir(), "omp-runtime-rollback-owner-"));
  let activated: Extract<ReturnType<typeof openWorkflowActivation>, { readonly ok: true }> | undefined;
  let transactionToken: import("../src/registry/owner.js").RegistryRegistrationToken | undefined;
  let retryToken: import("../src/registry/owner.js").RegistryRegistrationToken | undefined;
  try {
    const markerInfo = marker(root);
    activated = openWorkflowActivation(
      root,
      ["workflow_registration", "workflow_tools", "config_writer"],
      activationOwner("runtime-rollback-owner", root, markerInfo.path, markerInfo.sha256),
    );
    assert.equal(activated.ok, true);
    if (!activated.ok) return;
    const transaction = beginOwnerRegistry(activated.registry_context, root, ["workflow_profiles", "workflow_tools", "constitution_gate", "runtime_config"]);
    assert.equal(transaction.ok, true);
    if (!transaction.ok) return;
    transactionToken = transaction.token;
    const manager = {
      getCwd: () => root,
      getSessionId: () => "rollback-session",
      getSessionFile: () => join(root, "rollback-session.jsonl"),
    };
    const makePi = () => ({ setLabel() {}, on() {} });
    registerTeamWorkflow(makePi() as never, {
      cwd: root,
      owner: () => activated.claim.owner,
      registrationToken: transaction.token,
      initialSessionContext: { sessionManager: manager },
      deferConstitutionGate: true,
      observability: false,
    });
    const authority = ctoRuntimeSessionAuthorityForContext(activated.registry_context);
    assert.ok(authority, "initialSessionContext attaches an authority before outer commit");
    if (!authority) return;
    const opened = openCtoRuntimeAccess(activated.registry_context, authority, root);
    assert.equal(opened.ok, true);
    if (!opened.ok) return;

    // Simulate a downstream fullstack mount failure after core returned but
    // before the supplied registration transaction committed.
    rollbackOwnerRegistry(transaction.token);
    transactionToken = undefined;
    assert.equal(ctoRuntimeSessionAuthorityForContext(activated.registry_context), null, "outer rollback revokes the initial authority");
    assert.throws(() => opened.access.assertLive(), /activation_revoked|runtime access/i, "rollback closes every attached facade");
    assert.ok(workflowOwnerFor(root, "workflow_registration"), "the caller's pre-existing owner lease remains intact");

    const retry = beginOwnerRegistry(activated.registry_context, root, ["workflow_profiles", "workflow_tools", "constitution_gate", "runtime_config"]);
    assert.equal(retry.ok, true, "same authenticated context can retry after rollback");
    if (!retry.ok) return;
    retryToken = retry.token;
    registerTeamWorkflow(makePi() as never, {
      cwd: root,
      owner: () => activated.claim.owner,
      registrationToken: retry.token,
      initialSessionContext: { sessionManager: manager },
      deferConstitutionGate: true,
      observability: false,
    });
    assert.ok(ctoRuntimeSessionAuthorityForContext(activated.registry_context), "retry attaches a fresh authority");
    rollbackOwnerRegistry(retry.token);
    retryToken = undefined;
  } finally {
    if (retryToken) { try { rollbackOwnerRegistry(retryToken); } catch { /* preserve test failure */ } }
    if (transactionToken) { try { rollbackOwnerRegistry(transactionToken); } catch { /* preserve test failure */ } }
    if (activated) { try { closeWorkflowActivation(activated); } catch { /* preserve test failure */ } }
    rmSync(root, { recursive: true, force: true });
  }
});

test("session binding release only closes the exact current generation", () => {
  const root = mkdtempSync(join(tmpdir(), "omp-runtime-binding-release-"));
  let seedToken: import("../src/registry/owner.js").RegistryRegistrationToken | undefined;
  let retryToken: import("../src/registry/owner.js").RegistryRegistrationToken | undefined;
  try {
    writeTestRegistryMarker(root);
    const seed = openTestRegistry(
      root,
      ["workflow_profiles", "workflow_tools", "constitution_gate", "runtime_config"],
      "runtime-binding-release",
    );
    seedToken = seed.token;
    const pi = { setLabel() {}, on() {} };
    const manager = (id: string) => ({
      getCwd: () => root,
      getSessionId: () => id,
      getSessionFile: () => join(root, `${id}.jsonl`),
      getSessionGeneration: () => `generation-${id}`,
    });
    const contextA = { cwd: root, sessionManager: manager("release-a") };
    const contextB = { cwd: root, sessionManager: manager("release-b") };
    const contextC = { cwd: root, sessionManager: manager("release-c") };
    let controller: core.TeamSessionBindingController | undefined;
    const installed = registerTeamWorkflow(pi as never, {
      cwd: root,
      owner: () => seed.owner,
      registrationToken: seed.token,
      initialSessionContext: contextA,
      onSessionBindingController: candidate => { controller = candidate; },
      rebindSessions: true,
      deferConstitutionGate: true,
      observability: false,
    });
    installed?.();
    seed.retain(true);
    seedToken = undefined;
    assert.ok(controller, "initial registration publishes a binding controller");
    if (!controller) return;
    const bindingA = controller.current(contextA);
    assert.ok(bindingA, "initial generation is current");
    if (!bindingA) return;

    // A manager with a valid root but no authoritative session id must not
    // create a no-runtime binding or disturb the current generation.
    const malformedContext = { cwd: root, sessionManager: { getCwd: () => root } };
    assert.equal(controller.bind(malformedContext), null, "malformed session identity is rejected before mutation");
    const afterMalformed = controller.current(contextA);
    assert.ok(afterMalformed, "malformed bind leaves the current generation mounted");
    if (!afterMalformed) return;
    assert.equal(afterMalformed.runtimeAuthority, bindingA.runtimeAuthority, "malformed bind preserves the current authority");
    assert.equal(afterMalformed.runtimeAccess, bindingA.runtimeAccess, "malformed bind preserves the current runtime facade");
    assert.equal(ctoRuntimeSessionAuthorityForContext(bindingA.registryContext), bindingA.runtimeAuthority, "malformed bind preserves the authority claim");
    assert.doesNotThrow(() => bindingA.runtimeAccess.assertLive(), "malformed bind preserves the current facade");

    const bindingB = controller.bind(contextB);
    assert.ok(bindingB, "rebind publishes the replacement generation");
    if (!bindingB) return;

    assert.equal(controller.release(bindingA), false, "a stale generation cannot release the replacement");
    assert.equal(controller.isLive(contextB), true, "stale release leaves replacement live");
    assert.doesNotThrow(() => bindingB.runtimeAccess.assertLive(), "stale release leaves replacement facade live");

    assert.equal(controller.release(bindingB), true, "the exact generation is released");
    assert.equal(controller.isLive(contextB), false, "released generation is tombstoned");
    assert.equal(ctoRuntimeSessionAuthorityForContext(bindingB.registryContext), null, "released generation authority claim is revoked");
    assert.throws(() => bindingB.runtimeAccess.assertLive(), /activation_revoked|runtime access/i, "released generation facade is closed");

    const retry = beginOwnerRegistry(seed.context, root, ["workflow_profiles", "workflow_tools", "constitution_gate", "runtime_config"]);
    assert.equal(retry.ok, true, "retained owner context can mint a retry transaction");
    if (!retry.ok) return;
    retryToken = retry.token;
    let retryController: core.TeamSessionBindingController | undefined;
    const retryInstalled = registerTeamWorkflow(pi as never, {
      cwd: root,
      owner: () => seed.owner,
      registrationToken: retry.token,
      initialSessionContext: contextC,
      onSessionBindingController: candidate => { retryController = candidate; },
      rebindSessions: true,
      deferConstitutionGate: true,
      observability: false,
    });
    retryInstalled?.();
    commitOwnerRegistry(retry.token);
    retryToken = undefined;
    assert.ok(retryController, "retry publishes a fresh binding controller");
    if (!retryController) return;
    const bindingC = retryController.current(contextC);
    assert.ok(bindingC, "retry binds a fresh generation");
    if (!bindingC) return;
    assert.doesNotThrow(() => bindingC.runtimeAccess.assertLive(), "retry generation runtime facade is live");
    assert.equal(retryController.release(bindingC), true, "retry generation releases exactly");
  } finally {
    if (retryToken) { try { rollbackOwnerRegistry(retryToken); } catch { /* preserve test failure */ } }
    if (seedToken) { try { rollbackOwnerRegistry(seedToken); } catch { /* preserve test failure */ } }
    closeRetainedTestRegistrations(root);
    rmSync(root, { recursive: true, force: true });
  }
});

test("CTO registrar rejects reentrant mounting and honors explicit cwd", async () => {
  const root = mkdtempSync(join(tmpdir(), "omp-cto-owner-"));
  try {
    type MountedTool = { name: string; execute: (...args: unknown[]) => Promise<{ details: unknown }> };
    type Handler = (event: unknown, ctx: unknown) => unknown;
    const tools: MountedTool[] = [];
    const handlers = new Map<string, Handler>();
    const pi = {
      zod: {},
      registerTool(tool: unknown) { tools.push(tool as MountedTool); },
      on(event: string, handler: Handler) { handlers.set(event, handler); },
    };
    writeTestRegistryMarker(root);
    const registration = openTestRegistry(root, ["workflow_tools"], "bundle-cto");
    const equivalentOne = (candidate: string) => registration.owner;
    const equivalentTwo = (candidate: string) => registration.owner;
    registerCtoTools(pi as never, { cwd: root, owner: equivalentOne, registrationToken: registration.token });
    const mounted = tools.length;
    assert.ok(mounted > 0);
    assert.throws(
      () => registerCtoTools(pi as never, { cwd: root, owner: equivalentTwo, registrationToken: registration.token }),
      /registry_transaction_invalid: registrar activation is already mounting/,
    );
    assert.equal(tools.length, mounted, "reentrant mount fails before another tool registration");
    const foreignOwner = { ...registration.owner, owner_id: "foreign-cto", bundle_id: "foreign-cto" };
    assert.throws(
      () => registerCtoTools(pi as never, { cwd: root, owner: () => foreignOwner, registrationToken: registration.token }),
      /owner_conflict/,
    );
    assert.equal(tools.length, mounted, "foreign owner is rejected before another mount");
    registration.retain(true);

    const manager = { getCwd: () => root, getSessionId: () => "cto-session" };
    const context = { sessionManager: manager, mode: "tui", hasUI: true, ui: { askDialog: async () => ({ kind: "chat" }) } };
    handlers.get("session_start")?.({}, context);
    const preflight = tools.find((tool) => tool.name === "cto_preflight");
    assert.ok(preflight);
    if (!preflight) return;
    const result = await preflight.execute(
      "call-1",
      { cto_run_id: "missing-cto-run", selections: [{ feature_id: "feature-one", run_key: "run-feature-one" }] },
      undefined,
      undefined,
      { ...context, sessionId: "cto-session" },
    );
    const details = result.details as { code?: string; findings?: string[] };
    assert.notEqual(details.code, "WORKFLOW_STATE_UNAVAILABLE", "explicit cwd must not depend on ctx.cwd");

    const wrongSession = await preflight.execute(
      "call-2",
      { cto_run_id: "missing-cto-run", selections: [{ feature_id: "feature-one", run_key: "run-feature-one" }] },
      undefined,
      undefined,
      { sessionManager: { getCwd: () => root, getSessionId: () => "wrong-session" }, mode: "tui", hasUI: true, ui: context.ui },
    );
    assert.equal((wrongSession.details as { code?: string }).code, "REGISTRATION_FAILED");
    closeRetainedTestRegistrations(root);
    assert.equal(workflowOwnerFor(root, "workflow_registration"), undefined, "shared teardown releases the retained CTO owner claims");
    const inert = await preflight.execute(
      "call-3",
      { cto_run_id: "missing-cto-run", selections: [{ feature_id: "feature-one", run_key: "run-feature-one" }] },
      undefined,
      undefined,
      { ...context, sessionId: "cto-session" },
    );
    assert.equal((inert.details as { code?: string }).code, "REGISTRATION_FAILED", "closed CTO activation remains inert on the original host");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("activation-bound command registration rejects a foreign owner before host command mutation", () => {
  const root = mkdtempSync(join(tmpdir(), "omp-command-owner-"));
  const alias = join(tmpdir(), "omp-command-alias-" + process.pid + "-" + Date.now());
  symlinkSync(root, alias, "dir");
  const markerInfo = marker(root);
  try {
    const first = openClaim(root, ["workflow_registration"], "bundle-one");
    assert.equal(first.ok, true);

    const harness = commandHarness();
    registerWorkflowCommands(harness.pi as never, {
      owner: () => activationOwner("bundle-two", alias, markerInfo.path, markerInfo.sha256),
      resolveCwd: () => alias,
    });
    assert.deepEqual([...harness.commands.keys()], []);
    assert.equal(harness.registerCalls, 0);
    assert.equal(harness.sessionStarts.length, 1);

    assert.throws(
      () => harness.sessionStarts[0]?.({}, { cwd: alias, sessionManager: { getCwd: () => alias, getSessionId: () => "foreign" } }),
      /owner_conflict: generic workflow capability .*workflow_registration.*bundle-one/,
    );
    assert.deepEqual([...harness.commands.keys()], []);
    assert.equal(harness.registerCalls, 0);
  } finally {
    rmSync(alias, { force: true });
    rmSync(root, { recursive: true, force: true });
  }
});

test("descriptorless owner is rejected before host command registration", () => {
  const root = mkdtempSync(join(tmpdir(), "omp-command-plain-owner-"));
  const harness = commandHarness();
  try {
    assert.throws(
      () => registerWorkflowCommands(harness.pi as never),
      /owner_invalid: activation descriptor is required/,
    );
    assert.throws(
      () => registerWorkflowCommands(harness.pi as never, { cwd: root, owner: owner("bundle-plain", root) }),
      /owner_invalid: activation descriptor is required/,
    );
    assert.equal(harness.registerCalls, 0);
    assert.equal(harness.sessionStarts.length, 0);
    assert.equal(harness.sessionShutdowns.length, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("explicit cwd rejects a session context that drifts to an unclaimed root", async () => {
  const claimedRoot = mkdtempSync(join(tmpdir(), "omp-command-explicit-claimed-"));
  const unclaimedRoot = mkdtempSync(join(tmpdir(), "omp-command-explicit-unclaimed-"));
  const markerInfo = marker(claimedRoot);
  try {
    const harness = commandHarness();
    registerWorkflowCommands(harness.pi as never, {
      cwd: claimedRoot,
      owner: activationOwner("bundle-explicit", claimedRoot, markerInfo.path, markerInfo.sha256),
      buildDoWorkPrompt: (_envelope, cwd) => `effective-root:${cwd}`,
    });
    harness.sessionStarts[0]?.({}, { cwd: claimedRoot, sessionManager: { getCwd: () => claimedRoot, getSessionId: () => "resolver-session" } });
    const handler = harness.commands.get("do-work")?.handler;
    assert.ok(handler);

    await handler("same root task", {
      cwd: claimedRoot,
      sessionManager: { getCwd: () => claimedRoot, getSessionId: () => "resolver-session" },
      ui: { notify() {} },
    });
    assert.deepEqual(harness.prompts, [`effective-root:${claimedRoot}`]);

    await assert.rejects(
      handler("explicit root task", {
        cwd: unclaimedRoot,
        sessionManager: { getCwd: () => unclaimedRoot, getSessionId: () => "resolver-session" },
        ui: { notify() {} },
      }),
      /activation_identity_changed: authoritative host session root differs from registered root/,
    );

    assert.deepEqual(harness.prompts, [`effective-root:${claimedRoot}`]);
    assert.equal(workflowOwnerFor(unclaimedRoot, "workflow_registration"), undefined);
  } finally {
    rmSync(claimedRoot, { recursive: true, force: true });
    rmSync(unclaimedRoot, { recursive: true, force: true });
  }
});

test("custom resolveCwd rejects a session context that drifts to an unclaimed root", async () => {
  const claimedRoot = mkdtempSync(join(tmpdir(), "omp-command-resolver-claimed-"));
  const unclaimedRoot = mkdtempSync(join(tmpdir(), "omp-command-resolver-unclaimed-"));
  const markerInfo = marker(claimedRoot);
  let resolverCalls = 0;
  try {
    const harness = commandHarness();
    registerWorkflowCommands(harness.pi as never, {
      owner: () => activationOwner("bundle-resolver", claimedRoot, markerInfo.path, markerInfo.sha256),
      resolveCwd: () => {
        resolverCalls += 1;
        return claimedRoot;
      },
      buildDoWorkPrompt: (_envelope, cwd) => `effective-root:${cwd}`,
    });
    harness.sessionStarts[0]?.({}, { cwd: claimedRoot, sessionManager: { getCwd: () => claimedRoot, getSessionId: () => "resolver-session" } });
    const handler = harness.commands.get("do-work")?.handler;
    assert.ok(handler);

    await assert.rejects(
      handler("resolver root task", {
        cwd: unclaimedRoot,
        sessionManager: { getCwd: () => unclaimedRoot, getSessionId: () => "resolver-session" },
        ui: { notify() {} },
      }),
      /activation_identity_changed: authoritative host session root differs from registered root/,
    );

    assert.equal(resolverCalls, 2);
    assert.deepEqual(harness.prompts, []);
    assert.equal(workflowOwnerFor(unclaimedRoot, "workflow_registration"), undefined);
  } finally {
    rmSync(claimedRoot, { recursive: true, force: true });
    rmSync(unclaimedRoot, { recursive: true, force: true });
  }
});

test("undefined resolveCwd claims zero owners and registers no activation-bound commands", () => {
  const contextRoot = mkdtempSync(join(tmpdir(), "omp-command-undefined-resolver-"));
  const markerInfo = marker(contextRoot);
  try {
    const harness = commandHarness();
    let resolverCalls = 0;
    registerWorkflowCommands(harness.pi as never, {
      owner: () => activationOwner("bundle-gated", contextRoot, markerInfo.path, markerInfo.sha256),
      resolveCwd: () => {
        resolverCalls += 1;
        return undefined;
      },
      buildDoWorkPrompt: (_envelope, cwd) => `effective-root:${cwd}`,
    });
    assert.equal(harness.sessionStarts.length, 1);
    assert.equal(harness.registerCalls, 0);
    assert.equal(workflowOwnerFor(contextRoot, "workflow_registration"), undefined, "extension load claims nothing");

    // An unavailable resolver result is final: the gated owner source is not
    // invoked and the copied context cwd is never adopted.
    harness.sessionStarts[0]?.({}, {
      cwd: contextRoot,
      sessionManager: { getCwd: () => contextRoot },
    });
    assert.equal(resolverCalls, 1);
    assert.equal(harness.registerCalls, 0);
    assert.deepEqual([...harness.commands.keys()], []);
    assert.equal(
      workflowOwnerFor(contextRoot, "workflow_registration"),
      undefined,
      "undefined custom resolution makes zero owner claims",
    );
  } finally {
    rmSync(contextRoot, { recursive: true, force: true });
  }
});

test("unmarked dynamic sessions remain pending until a later marked session", async () => {
  const unmarkedRoot = mkdtempSync(join(tmpdir(), "omp-command-unmarked-"));
  const markedRoot = mkdtempSync(join(tmpdir(), "omp-command-marked-"));
  const markerInfo = marker(markedRoot);
  try {
    let currentRoot = unmarkedRoot;
    const harness = commandHarness();
    registerWorkflowCommands(harness.pi as never, {
      owner: () => activationOwner("bundle-recoverable", currentRoot, markerInfo.path, markerInfo.sha256),
      resolveCwd: () => currentRoot,
    });
    const unmarkedSession = { cwd: unmarkedRoot, sessionManager: { getCwd: () => unmarkedRoot, getSessionId: () => "unmarked-session" } };
    assert.throws(() => harness.sessionStarts[0]?.({}, unmarkedSession), /activation_markers_missing/);
    assert.equal(harness.registerCalls, 0);
    assert.equal(harness.commands.size, 0);
    assert.equal(workflowOwnerFor(unmarkedRoot, "workflow_registration"), undefined);

    currentRoot = markedRoot;
    assert.throws(() => harness.sessionStarts[0]?.({}, { ...unmarkedSession, cwd: markedRoot }), /activation_identity_changed: registration activation was revoked/);
    assert.equal(harness.registerCalls, 0);

    const markedSession = { cwd: markedRoot, sessionManager: { getCwd: () => markedRoot, getSessionId: () => "marked-session" }, ui: { notify() {} } };
    harness.sessionStarts[0]?.({}, markedSession);
    assert.equal(harness.registerCalls, 7);
    assert.equal(harness.commands.size, 7);
    await harness.commands.get("do-work")?.handler("recoverable task", markedSession);
    assert.equal(harness.prompts.length, 1);
  } finally {
    rmSync(unmarkedRoot, { recursive: true, force: true });
    rmSync(markedRoot, { recursive: true, force: true });
  }
});

test("async command prompts revalidate activation before sending", async () => {
  const run = async (removeMarker: boolean): Promise<string[]> => {
    const root = mkdtempSync(join(tmpdir(), removeMarker ? "omp-command-async-revoke-" : "omp-command-async-stable-"));
    try {
      const markerInfo = marker(root);
      const harness = commandHarness();
      let releaseBuild!: () => void;
      const buildGate = new Promise<void>((resolve) => { releaseBuild = resolve; });
      let signalBuildStarted!: () => void;
      const buildStarted = new Promise<void>((resolve) => { signalBuildStarted = resolve; });
      registerWorkflowCommands(harness.pi as never, {
        cwd: root,
        owner: activationOwner(removeMarker ? "bundle-async-revoke" : "bundle-async-stable", root, markerInfo.path, markerInfo.sha256),
        buildDoWorkPrompt: async () => {
          signalBuildStarted();
          await buildGate;
          if (removeMarker) {
            const pinned = PinnedProjectRoot.open(root);
            assert.ok(pinned);
            try {
              pinned?.writeAtomic(".liveness-probe", "probe");
            } finally {
              pinned?.close();
            }
          }
          return "async prompt";
        },
      });
      const context = { cwd: root, sessionManager: { getCwd: () => root, getSessionId: () => "async-session" }, ui: { notify() {} } };
      const handler = harness.commands.get("do-work")?.handler;
      assert.ok(handler);
      const pending = handler!("async task", context);
      await buildStarted;
      if (removeMarker) rmSync(join(root, markerInfo.path));
      releaseBuild();
      if (removeMarker) {
        await assert.rejects(pending, /(?:activation_identity_changed|ENOENT|registration context)/);
        assert.deepEqual(harness.prompts, []);
        assert.equal(existsSync(join(root, ".liveness-probe")), false);
      } else {
        await pending;
        assert.deepEqual(harness.prompts, ["async prompt"]);
      }
      return harness.prompts;
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  };

  await run(true);
  await run(false);
});

test("revoked commands do not send validation errors without a live owner", async () => {
  const revokedRoot = mkdtempSync(join(tmpdir(), "omp-command-validation-revoked-"));
  const liveRoot = mkdtempSync(join(tmpdir(), "omp-command-validation-live-"));
  try {
    const revokedMarker = marker(revokedRoot);
    const revokedHarness = commandHarness();
    let revokedBuilderCalls = 0;
    registerWorkflowCommands(revokedHarness.pi as never, {
      cwd: revokedRoot,
      owner: activationOwner("bundle-validation-revoked", revokedRoot, revokedMarker.path, revokedMarker.sha256),
      buildDoWorkPrompt: () => {
        revokedBuilderCalls += 1;
        return "unexpected prompt";
      },
    });
    const revokedContext = { cwd: revokedRoot, sessionManager: { getCwd: () => revokedRoot, getSessionId: () => "validation-revoked" }, ui: { notify() {} } };
    const revokedHandler = revokedHarness.commands.get("do-work")?.handler;
    assert.ok(revokedHandler);
    rmSync(join(revokedRoot, revokedMarker.path));
    for (const input of [undefined as never, "x".repeat(MAX_WORKFLOW_COMMAND_ARGUMENT_BYTES + 1), "--spec"]) {
      await assert.rejects(revokedHandler!(input, revokedContext), /activation_identity_changed|registration context|ENOENT/);
    }
    assert.equal(revokedBuilderCalls, 0);
    assert.deepEqual(revokedHarness.prompts, []);

    const liveMarker = marker(liveRoot);
    const liveHarness = commandHarness();
    registerWorkflowCommands(liveHarness.pi as never, {
      cwd: liveRoot,
      owner: activationOwner("bundle-validation-live", liveRoot, liveMarker.path, liveMarker.sha256),
    });
    const liveContext = { cwd: liveRoot, sessionManager: { getCwd: () => liveRoot, getSessionId: () => "validation-live" }, ui: { notify() {} } };
    const liveHandler = liveHarness.commands.get("do-work")?.handler;
    assert.ok(liveHandler);
    await liveHandler!(undefined as never, liveContext);
    assert.deepEqual(liveHarness.prompts, ["ERROR COMMAND_ARGUMENT_INVALID: arguments must be a string"]);
  } finally {
    rmSync(revokedRoot, { recursive: true, force: true });
    rmSync(liveRoot, { recursive: true, force: true });
  }
});

test("activation-bound command handlers remain fail-closed after an owner conflict", () => {
  const root = mkdtempSync(join(tmpdir(), "omp-command-handler-owner-"));
  const alias = join(tmpdir(), "omp-command-handler-alias-" + process.pid + "-" + Date.now());
  symlinkSync(root, alias, "dir");
  const markerInfo = marker(root);
  try {
    const first = openClaim(root, ["workflow_registration"], "bundle-one");
    assert.equal(first.ok, true);

    const harness = commandHarness();
    registerWorkflowCommands(harness.pi as never, {
      owner: () => activationOwner("bundle-two", alias, markerInfo.path, markerInfo.sha256),
      resolveCwd: () => alias,
    });
    assert.equal(harness.registerCalls, 0);
    assert.throws(
      () => harness.sessionStarts[0]?.({}, { cwd: alias, sessionManager: { getCwd: () => alias, getSessionId: () => "conflict" } }),
      /owner_conflict: generic workflow capability .*workflow_registration.*bundle-one/,
    );
    assert.deepEqual(harness.prompts, []);
    assert.deepEqual([...harness.commands.keys()], []);
  } finally {
    rmSync(alias, { force: true });
    rmSync(root, { recursive: true, force: true });
  }
});

test("owner-aware command registration is idempotent across repeated session_start events", () => {
  const root = mkdtempSync(join(tmpdir(), "omp-command-idempotent-"));
  const markerInfo = marker(root);
  try {
    const harness = commandHarness();
    registerWorkflowCommands(harness.pi as never, {
      owner: () => activationOwner("bundle-one", root, markerInfo.path, markerInfo.sha256),
      resolveCwd: () => root,
    });
    assert.deepEqual([...harness.commands.keys()], []);
    assert.equal(harness.registerCalls, 0);
    assert.equal(harness.sessionStarts.length, 1);

    const context = { cwd: root, sessionManager: { getCwd: () => root, getSessionId: () => "idempotent" } };
    harness.sessionStarts[0]?.({}, context);
    harness.sessionStarts[0]?.({}, context);
    assert.equal(harness.sessionShutdowns.length, 1);
    harness.sessionShutdowns[0]?.({}, context);
    harness.sessionStarts[0]?.({}, { ...context, sessionManager: { getCwd: () => root, getSessionId: () => "idempotent-next" } });

    assert.deepEqual([...harness.commands.keys()], [
      "do-work",
      "team",
      "cto",
      "specify",
      "spec-plan",
      "spec-tasks",
      "spec-import",
    ]);
    assert.equal(harness.registerCalls, 7);
    assert.equal(workflowOwnerFor(root, "workflow_registration")?.owner.owner_id, "bundle-one");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("command shutdown requires manager, file, and generation identity beyond a reused session id", async () => {
  const root = mkdtempSync(join(tmpdir(), "omp-command-shutdown-identity-"));
  try {
    const markerInfo = marker(root);
    const managerA = {
      getCwd: () => root,
      getSessionId: () => "reused-session-id",
      getSessionFile: () => join(root, "session-a.jsonl"),
      getSessionGeneration: () => 1,
    };
    const managerB = {
      getCwd: () => root,
      getSessionId: () => "reused-session-id",
      getSessionFile: () => join(root, "session-b.jsonl"),
      getSessionGeneration: () => 2,
    };
    const harness = commandHarness();
    registerWorkflowCommands(harness.pi as never, {
      owner: () => activationOwner("bundle-shutdown-identity", root, markerInfo.path, markerInfo.sha256),
      resolveCwd: () => root,
    });
    const contextA = { cwd: root, sessionManager: managerA, ui: { notify() {} } };
    const contextB = { cwd: root, sessionManager: managerB, ui: { notify() {} } };
    harness.sessionStarts[0]?.({}, contextA);
    const handler = harness.commands.get("do-work")?.handler;
    assert.ok(handler);
    assert.throws(
      () => harness.sessionStarts[0]?.({}, { cwd: root, ui: { notify() {} } }),
      /activation_context_missing|activation_context_invalid/,
      "manager-bound activation must reject a missing-manager rebind without mutation",
    );
    await handler!("still-live-before-rebind", contextA);
    assert.equal(harness.prompts.length, 1, "missing-manager rejection must preserve the A activation");
    assert.doesNotThrow(() => harness.sessionStarts[0]?.({}, contextB), "same-id manager/generation change must rebind");
    harness.sessionShutdowns[0]?.({}, contextA);
    await handler!("still-live", contextB);
    assert.equal(harness.prompts.length, 2, "stale A shutdown must preserve the rebound B activation");
    harness.sessionShutdowns[0]?.({}, contextB);
    await assert.rejects(handler!("closed", contextB), /activation_identity_changed|registration context/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("legacy command shutdown requires its active session id", () => {
  const root = mkdtempSync(join(tmpdir(), "omp-command-legacy-shutdown-"));
  try {
    const markerInfo = marker(root);
    const harness = commandHarness();
    registerWorkflowCommands(harness.pi as never, {
      owner: () => activationOwner("bundle-legacy-shutdown", root, markerInfo.path, markerInfo.sha256),
      resolveCwd: () => root,
    });
    harness.sessionStarts[0]?.({}, { cwd: root, sessionId: "legacy-session" });
    assert.equal(workflowOwnerFor(root, "workflow_registration")?.owner.owner_id, "bundle-legacy-shutdown");
    harness.sessionShutdowns[0]?.({}, { cwd: root });
    assert.equal(workflowOwnerFor(root, "workflow_registration")?.owner.owner_id, "bundle-legacy-shutdown", "malformed shutdown must preserve a session-bound legacy slot");
    harness.sessionShutdowns[0]?.({}, { cwd: root, sessionId: "legacy-session" });
    assert.equal(workflowOwnerFor(root, "workflow_registration"), undefined, "matching legacy shutdown must close the slot");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("session rebind preserves a separately held activation generation", async () => {
  const root = mkdtempSync(join(tmpdir(), "omp-command-shared-session-"));
  try {
    const markerInfo = marker(root);
    const descriptor = activationOwner("bundle-shared-session", root, markerInfo.path, markerInfo.sha256);
    const shared = openWorkflowActivation(root, ["workflow_registration"], descriptor);
    assert.equal(shared.ok, true);
    if (!shared.ok) return;
    const sharedTransaction = beginOwnerRegistry(shared.registry_context, root, ["constitution_gate"]);
    assert.equal(sharedTransaction.ok, true);
    if (!sharedTransaction.ok) return;
    const sharedGuard = createRegistryRegistrationLiveGuard(sharedTransaction.token, "constitution_gate");
    commitOwnerRegistry(sharedTransaction.token);
    const before = sharedGuard();

    const harness = commandHarness();
    registerWorkflowCommands(harness.pi as never, { owner: () => descriptor, resolveCwd: () => root });
    const firstSession = { cwd: root, sessionManager: { getCwd: () => root, getSessionId: () => "shared-session-a" }, ui: { notify() {} } };
    const secondSession = { cwd: root, sessionManager: { getCwd: () => root, getSessionId: () => "shared-session-b" }, ui: { notify() {} } };
    harness.sessionStarts[0]?.({}, firstSession);
    harness.sessionStarts[0]?.({}, secondSession);
    assert.equal(harness.registerCalls, 7);
    const after = sharedGuard();
    assert.equal(after.claim_generation, before.claim_generation);
    assert.equal(after.marker_generation, before.marker_generation);
    const handler = harness.commands.get("do-work")?.handler;
    assert.ok(handler);
    await handler!("shared session task", secondSession);
    assert.equal(harness.prompts.length, 1);

    harness.sessionShutdowns[0]?.({}, firstSession);
    assert.equal(sharedGuard().claim_generation, before.claim_generation);
    await handler!("after stale shutdown", secondSession);
    assert.equal(harness.prompts.length, 2);
    harness.sessionShutdowns[0]?.({}, secondSession);
    assert.equal(sharedGuard().claim_generation, before.claim_generation);
    closeWorkflowActivation(shared);
    assert.throws(() => sharedGuard(), /registration context is not genuine or is closed/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("activation command context rejects wrong session, root swap, and marker removal", async () => {
  const root = mkdtempSync(join(tmpdir(), "omp-command-context-root-"));
  const replacement = root + "-old";
  const rootMarker = marker(root);
  try {
    let currentRoot = root;
    const harness = commandHarness();
    registerWorkflowCommands(harness.pi as never, {
      owner: () => {
        return activationOwner("bundle-context", currentRoot, rootMarker.path, rootMarker.sha256);
      },
      resolveCwd: () => currentRoot,
    });
    const session = { cwd: root, sessionManager: { getCwd: () => root, getSessionId: () => "session-one" }, ui: { notify() {} } };
    harness.sessionStarts[0]?.({}, session);
    const handler = harness.commands.get("do-work")?.handler;
    assert.ok(handler);

    await assert.rejects(
      handler!("missing session", { ...session, sessionManager: { getCwd: () => root } }),
      /activation_identity_changed: registration session changed/,
    );
    assert.deepEqual(harness.prompts, []);

    await assert.rejects(
      handler!("wrong session", { ...session, sessionManager: { getCwd: () => root, getSessionId: () => "session-two" } }),
      /owner_conflict: registration context belongs to another session/,
    );
    assert.deepEqual(harness.prompts, []);

    renameSync(root, replacement);
    mkdirSync(root);
    marker(root);
    const callsBeforeRebind = harness.registerCalls;
    const reboundSession = { cwd: root, sessionManager: { getCwd: () => root, getSessionId: () => "session-replacement" }, ui: { notify() {} } };
    harness.sessionStarts[0]?.({}, reboundSession);
    assert.equal(harness.registerCalls, callsBeforeRebind);
    await handler!("rebound task", reboundSession);
    assert.equal(harness.prompts.length, 1);
    harness.sessionShutdowns[0]?.({}, session);
    await handler!("after stale shutdown", reboundSession);
    assert.equal(harness.prompts.length, 2);

    const markerRoot = mkdtempSync(join(tmpdir(), "omp-command-context-marker-"));
    const markerInfo = marker(markerRoot);
    const markerHarness = commandHarness();
    registerWorkflowCommands(markerHarness.pi as never, {
      owner: () => activationOwner("bundle-marker", markerRoot, markerInfo.path, markerInfo.sha256),
      resolveCwd: () => markerRoot,
    });
    const markerSession = { cwd: markerRoot, sessionManager: { getCwd: () => markerRoot, getSessionId: () => "session-marker" }, ui: { notify() {} } };
    markerHarness.sessionStarts[0]?.({}, markerSession);
    const markerHandler = markerHarness.commands.get("do-work")?.handler;
    assert.ok(markerHandler);
    rmSync(join(markerRoot, ".omp-activation-marker"));
    await assert.rejects(
      markerHandler!("marker removed", markerSession),
      /(?:activation_identity_changed|ENOENT)/,
    );
    assert.deepEqual(markerHarness.prompts, []);
    const callsBeforeSameSessionRetry = markerHarness.registerCalls;
    assert.throws(() => markerHarness.sessionStarts[0]?.({}, markerSession), /activation_identity_changed: registration activation was revoked/);
    assert.equal(markerHarness.registerCalls, callsBeforeSameSessionRetry);
    await assert.rejects(
      markerHandler!("marker removed again", markerSession),
      /activation_identity_changed: registration activation was revoked/,
    );
    const restoredMarker = marker(markerRoot);
    const freshMarkerHarness = commandHarness();
    registerWorkflowCommands(freshMarkerHarness.pi as never, {
      owner: () => activationOwner("bundle-marker-fresh", markerRoot, restoredMarker.path, restoredMarker.sha256),
      resolveCwd: () => markerRoot,
    });
    freshMarkerHarness.sessionStarts[0]?.({}, markerSession);
    assert.equal(freshMarkerHarness.commands.size, 7);
    rmSync(markerRoot, { recursive: true, force: true });
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(replacement, { recursive: true, force: true });
  }
});

test("partial host registration failures fail closed and reject same-host retries", async () => {
  for (const failAt of [1, 4, 7]) {
    const root = mkdtempSync(join(tmpdir(), "omp-command-mount-failure-" + failAt + "-"));
    try {
      const markerInfo = marker(root);
      const captured = new Map<string, { handler: CommandHandler }>();
      const prompts: string[] = [];
      let registerCalls = 0;
      const pi = {
        registerCommand(name: string, command: { handler: CommandHandler }) {
          registerCalls += 1;
          captured.set(name, command);
          if (registerCalls === failAt) throw new Error("host-registration-failure-" + failAt);
        },
        on() {},
        sendUserMessage(prompt: string) {
          prompts.push(prompt);
        },
      };
      const options = { cwd: root, owner: activationOwner("bundle-mount-failure-" + failAt, root, markerInfo.path, markerInfo.sha256) };
      assert.throws(() => registerWorkflowCommands(pi as never, options), new RegExp("host-registration-failure-" + failAt));
      assert.ok(captured.size >= 1);
      const context = {
        cwd: root,
        ui: { notify() {} },
        sessionManager: { getSessionId: () => "mount-failure-" + failAt },
      };
      for (const command of captured.values()) {
        await assert.rejects(command.handler("partial registration task", context), /workflow command registration is failed/);
      }
      assert.equal(prompts.length, 0);
      const callsAfterFailure = registerCalls;
      assert.throws(() => registerWorkflowCommands(pi as never, options), /workflow command registration is failed/);
      assert.equal(registerCalls, callsAfterFailure);

      const fresh = commandHarness();
      registerWorkflowCommands(fresh.pi as never, options);
      assert.equal(fresh.commands.size, 7);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

test("a later plugin override keeps one canonical command in the seven-name public inventory", () => {
  const root = mkdtempSync(join(tmpdir(), "omp-command-inventory-"));
  const markerInfo = marker(root);
  try {
  const base = commandHarness();
  registerWorkflowCommands(base.pi as never, { cwd: root, owner: activationOwner("bundle-inventory", root, markerInfo.path, markerInfo.sha256) });

  const baseInventory = new Map(base.commands);
  const override = { handler: (async () => undefined) as CommandHandler };
  const pluginOverride = new Map([["team", override]]);
  const publicInventory = new Map(baseInventory);
  for (const [name, command] of pluginOverride) publicInventory.set(name, command);

  assert.deepEqual([...publicInventory.keys()], [
    "do-work",
    "team",
    "cto",
    "specify",
    "spec-plan",
    "spec-tasks",
    "spec-import",
  ]);
  assert.equal(publicInventory.size, 7);
  for (const name of ["do-work", "team", "cto", "specify", "spec-plan", "spec-tasks", "spec-import"]) {
    assert.equal([...publicInventory.keys()].filter((registeredName) => registeredName === name).length, 1);
  }
  assert.equal(publicInventory.get("team"), override);
  assert.equal(publicInventory.get("do-work"), baseInventory.get("do-work"));
  assert.equal([...publicInventory.keys()].filter(name => name === "team").length, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});


test("marker activation mints the only registry context", () => {
  const root = mkdtempSync(join(tmpdir(), "omp-owner-activation-context-"));
  try {
    const claim = openClaim(root, ["workflow_registration"], "marker-owner");
    assert.equal("registry_context" in claim, true);
    const transaction = beginOwnerRegistry(claim.registry_context, root, ["constitution_gate"]);
    assert.equal(transaction.ok, true);
    if (transaction.ok) rollbackOwnerRegistry(transaction.token);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("activation descriptors require a nonempty exact physical marker", () => {
  const cases: Array<{ name: string; setup: (root: string) => { path: string; sha256?: string }; owner: (root: string, marker: { path: string; sha256?: string }) => WorkflowOwnerIdentity; code: string }> = [
    {
      name: "missing descriptor",
      setup: () => ({ path: ".omp-activation-marker" }),
      owner: (root) => owner("missing-descriptor", root),
      code: "activation_markers_missing",
    },
    {
      name: "empty required list",
      setup: (root) => marker(root),
      owner: (root) => ({ ...owner("empty-required", root), activation_marker: "empty-required-activation", activation: { marker_id: "empty-required-activation", required: [] } }),
      code: "owner_invalid",
    },
    {
      name: "unsafe path",
      setup: (root) => marker(root),
      owner: (root) => activationOwner("unsafe-path", root, "../outside"),
      code: "activation_markers_missing",
    },
    {
      name: "symlink marker",
      setup: (root) => {
        const target = join(root, "target");
        writeFileSync(target, "marker");
        symlinkSync(target, join(root, "linked-marker"));
        return { path: "linked-marker" };
      },
      owner: (root) => activationOwner("symlink-marker", root, "linked-marker"),
      code: "activation_markers_missing",
    },
    {
      name: "wrong marker kind",
      setup: (root) => {
        mkdirSync(join(root, "directory-marker"));
        return { path: "directory-marker" };
      },
      owner: (root) => activationOwner("wrong-kind", root, "directory-marker"),
      code: "activation_markers_missing",
    },
    {
      name: "wrong marker digest",
      setup: (root) => marker(root),
      owner: (root, observed) => activationOwner("wrong-digest", root, observed.path, "0".repeat(64)),
      code: "activation_markers_missing",
    },
  ];
  for (const testCase of cases) {
    const root = mkdtempSync(join(tmpdir(), "omp-owner-activation-invalid-"));
    try {
      const observed = testCase.setup(root);
      const result = openWorkflowActivation(root, ["workflow_registration"], testCase.owner(root, observed));
      assert.equal(result.ok, false, testCase.name);
      if (!result.ok) assert.equal(result.code, testCase.code, testCase.name);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

test("activation requires workflow_registration before admitting other capabilities", () => {
  const root = mkdtempSync(join(tmpdir(), "omp-owner-registration-anchor-"));
  try {
    const observed = marker(root);
    const owner = activationOwner("registration-anchor", root, observed.path, observed.sha256);
    for (const capability of ["workflow_tools", "config_writer"] as const) {
      const result = openWorkflowActivation(root, [capability], owner);
      assert.equal(result.ok, false);
      if (!result.ok) assert.equal(result.code, "owner_invalid");
      assert.equal(workflowOwnerFor(root, capability), undefined);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("valid context returns detached evidence and rejects copied, wrong-root, and wrong-capability use", () => {
  const root = mkdtempSync(join(tmpdir(), "omp-owner-context-valid-"));
  const foreignRoot = mkdtempSync(join(tmpdir(), "omp-owner-context-foreign-"));
  try {
    const observed = marker(root);
    const activated = activationOwner("context-owner", root, observed.path, observed.sha256);
    const opened = openWorkflowActivation(root, ["workflow_registration", "workflow_tools"], activated);
    assert.equal(opened.ok, true);
    if (!opened.ok) return;
    const snapshot = requireRegistryContext(opened.registry_context, root, "workflow_tools");
    assert.equal(Object.isFrozen(snapshot), true);
    assert.equal(snapshot.canonical_root, realpathSync(root));
    assert.equal(snapshot.root_dev > 0, true);
    assert.equal(snapshot.root_ino > 0, true);
    assert.equal(snapshot.owner_fingerprint, opened.claim.fingerprint);
    assert.equal(snapshot.principal_fingerprint, opened.claim.principal_fingerprint);
    assert.equal(snapshot.marker_digest.length, 64);
    assert.equal(snapshot.marker_generation > 0, true);
    assert.deepEqual(Object.keys(snapshot).sort(), ["canonical_root", "claim_generation", "marker_digest", "marker_generation", "owner_fingerprint", "principal_fingerprint", "root_dev", "root_ino"]);
    assert.throws(() => requireRegistryContext({ ...opened.registry_context } as never, root), /registration context is not genuine or is closed/);

    const wrongRootOpened = openWorkflowActivation(root, ["workflow_registration", "workflow_tools"], activated);
    assert.equal(wrongRootOpened.ok, true);
    if (!wrongRootOpened.ok) return;
    assert.throws(() => requireRegistryContext(wrongRootOpened.registry_context, foreignRoot), /registration root identity does not match the owner claim/);

    const wrongCapabilityOpened = openWorkflowActivation(root, ["workflow_registration", "workflow_tools"], activated);
    assert.equal(wrongCapabilityOpened.ok, true);
    if (!wrongCapabilityOpened.ok) return;
    assert.throws(() => requireRegistryContext(wrongCapabilityOpened.registry_context, root, "config_writer"), /registration context lacks the capability: config_writer/);
  } finally {
    rmSync(foreignRoot, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  }
});

test("marker removal and replacement revoke contexts and release the global transaction slot", () => {
  for (const replacement of [false, true]) {
    const root = mkdtempSync(join(tmpdir(), "omp-owner-marker-revoke-"));
    try {
      const observed = marker(root);
      const activated = activationOwner("marker-revoke-" + String(replacement), root, observed.path);
      const opened = openWorkflowActivation(root, ["workflow_registration", "workflow_tools"], activated);
      assert.equal(opened.ok, true);
      if (!opened.ok) continue;
      const transaction = beginOwnerRegistry(opened.registry_context, root, ["constitution_gate"]);
      assert.equal(transaction.ok, true);
      if (!transaction.ok) continue;
      unlinkSync(join(root, observed.path));
      if (replacement) writeFileSync(join(root, observed.path), "replacement");
      assert.throws(() => requireRegistryRegistration(transaction.token, "constitution_gate"), replacement ? /activation marker identity changed/ : /ENOENT/);
      assert.throws(() => requireRegistryContext(opened.registry_context, root), /registration context is not genuine or is closed/);

      if (!replacement) writeFileSync(join(root, observed.path), "marker");
      const fresh = openWorkflowActivation(root, ["workflow_registration", "workflow_tools"], activated);
      assert.equal(fresh.ok, true);
      if (!fresh.ok) continue;
      const freshTransaction = beginOwnerRegistry(fresh.registry_context, root, ["constitution_gate"]);
      assert.equal(freshTransaction.ok, true, "revocation must release the global transaction slot");
      if (freshTransaction.ok) commitOwnerRegistry(freshTransaction.token);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

test("root inode replacement and explicit owner release revoke every context and token", () => {
  const root = mkdtempSync(join(tmpdir(), "omp-owner-root-revoke-"));
  const moved = root + "-moved";
  try {
    const observed = marker(root);
    const activated = activationOwner("root-revoke", root, observed.path);
    const opened = openWorkflowActivation(root, ["workflow_registration", "workflow_tools"], activated);
    assert.equal(opened.ok, true);
    if (!opened.ok) return;
    const transaction = beginOwnerRegistry(opened.registry_context, root, ["constitution_gate"]);
    assert.equal(transaction.ok, true);
    if (!transaction.ok) return;
    renameSync(root, moved);
    mkdirSync(root);
    marker(root);
    assert.throws(() => requireRegistryContext(opened.registry_context, root), /registration root identity does not match the owner claim/);
    assert.throws(() => requireRegistryRegistration(transaction.token, "constitution_gate"), /registration root identity does not match the owner claim/);

    const movedMarker = { path: observed.path, sha256: observed.sha256 };
    const freshOwner = activationOwner("root-revoke-moved", moved, movedMarker.path);
    const fresh = openWorkflowActivation(moved, ["workflow_registration", "workflow_tools"], freshOwner);
    assert.equal(fresh.ok, true);
    if (!fresh.ok) return;
    const releaseTransaction = beginOwnerRegistry(fresh.registry_context, moved, ["constitution_gate"]);
    assert.equal(releaseTransaction.ok, true);
    const released = releaseWorkflowOwners(fresh.release_token, ["workflow_registration"]);
    assert.deepEqual(released.released, ["workflow_registration"]);
    assert.throws(() => requireRegistryContext(fresh.registry_context, moved), /registration context is not genuine or is closed/);
    if (releaseTransaction.ok) assert.throws(() => requireRegistryRegistration(releaseTransaction.token, "constitution_gate"), /owner context is no longer active/);
  } finally {
    rmSync(moved, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  }
});

test("old activation lease releases replaced-root claims without touching newer owners", () => {
  const root = mkdtempSync(join(tmpdir(), "omp-owner-old-lease-root-"));
  const moved = root + "-moved";
  try {
    const oldMarker = marker(root);
    const oldOwner = activationOwner("old-lease-owner", root, oldMarker.path, oldMarker.sha256);
    const old = openWorkflowActivation(root, ["workflow_registration"], oldOwner);
    assert.equal(old.ok, true);
    if (!old.ok) return;

    renameSync(root, moved);
    mkdirSync(root);
    const newMarker = marker(root);
    const newOwner = activationOwner("new-lease-owner", root, newMarker.path, newMarker.sha256);
    // The next activation sweeps the stale old-root context and claim before
    // admission, so the reused pathname can be claimed immediately.
    const fresh = openWorkflowActivation(root, ["workflow_registration"], newOwner);
    assert.equal(fresh.ok, true);
    if (!fresh.ok) return;
    assert.equal(fresh.claim.owner.owner_id, "new-lease-owner");
    assert.equal(workflowOwnerFor(root, "workflow_registration")?.owner.owner_id, "new-lease-owner");

    const stale = releaseWorkflowOwners(old.release_token, ["workflow_registration"]);
    assert.deepEqual(stale.released, []);
    assert.deepEqual(stale.skipped, ["workflow_registration"]);
    assert.equal(workflowOwnerFor(root, "workflow_registration")?.owner.owner_id, "new-lease-owner");
    const forged = releaseWorkflowOwners({} as never, ["workflow_registration"]);
    assert.deepEqual(forged.released, []);
    assert.deepEqual(forged.skipped, ["workflow_registration"]);
  } finally {
    rmSync(moved, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  }
});

test("internal live registration guards survive commit and fence revocation", () => {
  const root = mkdtempSync(join(tmpdir(), "omp-owner-live-guard-"));
  const swapRoot = mkdtempSync(join(tmpdir(), "omp-owner-live-guard-swap-"));
  const swapMoved = swapRoot + "-moved";
  try {
    const observed = marker(root);
    const descriptor = activationOwner("live-guard", root, observed.path, observed.sha256);
    const opened = openWorkflowActivation(root, ["workflow_registration"], descriptor);
    assert.equal(opened.ok, true);
    if (!opened.ok) return;
    const transaction = beginOwnerRegistry(opened.registry_context, root, ["constitution_gate"]);
    assert.equal(transaction.ok, true);
    if (!transaction.ok) return;
    assert.throws(() => createRegistryRegistrationLiveGuard(transaction.token, "workflow_tools"), /registration transaction is not authorized for workflow_tools/);
    const guard = createRegistryRegistrationLiveGuard(transaction.token, "constitution_gate");
    commitOwnerRegistry(transaction.token);
    const snapshot = guard();
    assert.equal(snapshot.canonical_root, realpathSync(root));
    assert.equal(snapshot.root_dev > 0, true);
    assert.equal(snapshot.root_ino > 0, true);

    rmSync(join(root, observed.path));
    assert.throws(() => guard(), /activation_identity_changed|ENOENT/);

    const closedRoot = mkdtempSync(join(tmpdir(), "omp-owner-live-guard-closed-"));
    try {
      const closedMarker = marker(closedRoot);
      const closed = openWorkflowActivation(closedRoot, ["workflow_registration"], activationOwner("live-guard-closed", closedRoot, closedMarker.path, closedMarker.sha256));
      assert.equal(closed.ok, true);
      if (!closed.ok) return;
      const closedTransaction = beginOwnerRegistry(closed.registry_context, closedRoot, ["constitution_gate"]);
      assert.equal(closedTransaction.ok, true);
      if (!closedTransaction.ok) return;
      const closedGuard = createRegistryRegistrationLiveGuard(closedTransaction.token, "constitution_gate");
      closeWorkflowActivation(closed);
      assert.throws(() => closedGuard(), /registration context is not genuine or is closed/);
    } finally {
      rmSync(closedRoot, { recursive: true, force: true });
    }

    const swapMarker = marker(swapRoot);
    const swap = openWorkflowActivation(swapRoot, ["workflow_registration"], activationOwner("live-guard-swap", swapRoot, swapMarker.path, swapMarker.sha256));
    assert.equal(swap.ok, true);
    if (!swap.ok) return;
    const swapTransaction = beginOwnerRegistry(swap.registry_context, swapRoot, ["constitution_gate"]);
    assert.equal(swapTransaction.ok, true);
    if (!swapTransaction.ok) return;
    const swapGuard = createRegistryRegistrationLiveGuard(swapTransaction.token, "constitution_gate");
    commitOwnerRegistry(swapTransaction.token);
    renameSync(swapRoot, swapMoved);
    mkdirSync(swapRoot);
    marker(swapRoot);
    assert.throws(() => swapGuard(), /registration root identity does not match the owner claim/);

    assert.throws(() => createRegistryRegistrationLiveGuard({} as never, "constitution_gate"), /registration token is not genuine or is closed/);
  } finally {
    rmSync(swapMoved, { recursive: true, force: true });
    rmSync(swapRoot, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  }
});

test("curated activation closer releases only its own claims and tolerates repeats", () => {
  const root = mkdtempSync(join(tmpdir(), "omp-owner-curated-close-"));
  try {
    const observed = marker(root);
    const descriptor = activationOwner("curated-close", root, observed.path, observed.sha256);
    const first = openWorkflowActivation(root, ["workflow_registration"], descriptor);
    const nested = openWorkflowActivation(root, ["workflow_registration"], descriptor);
    assert.equal(first.ok, true);
    assert.equal(nested.ok, true);
    if (!first.ok || !nested.ok) return;

    const nestedRelease = closeWorkflowActivation(nested);
    assert.deepEqual(nestedRelease.released, ["workflow_registration"]);
    assert.equal(workflowOwnerFor(root, "workflow_registration")?.owner.owner_id, "curated-close");
    const firstRelease = closeWorkflowActivation(first);
    assert.deepEqual(firstRelease.released, ["workflow_registration"]);
    assert.equal(workflowOwnerFor(root, "workflow_registration"), undefined);
    const repeated = closeWorkflowActivation(first);
    assert.deepEqual(repeated.released, []);
    assert.deepEqual(repeated.skipped, ["workflow_registration"]);

    assert.doesNotThrow(() => closeWorkflowActivation({ ok: false, code: "owner_conflict", error: "fake" } as never));
    const fake = { ok: true, registry_context: {}, release_token: {}, newly_claimed: ["workflow_registration"] };
    assert.doesNotThrow(() => closeWorkflowActivation(fake as never));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("registry transactions interleave across roots, remain rollback-safe, and stay owner-matched", () => {
  const firstRoot = mkdtempSync(join(tmpdir(), "omp-owner-transaction-one-"));
  const secondRoot = mkdtempSync(join(tmpdir(), "omp-owner-transaction-two-"));
  try {
    const firstMarker = marker(firstRoot);
    const secondMarker = marker(secondRoot);
    const firstOwner = activationOwner("transaction-one", firstRoot, firstMarker.path);
    const secondOwner = activationOwner("transaction-two", secondRoot, secondMarker.path);
    const first = openWorkflowActivation(firstRoot, ["workflow_registration", "workflow_tools"], firstOwner);
    const second = openWorkflowActivation(secondRoot, ["workflow_registration", "workflow_tools"], secondOwner);
    assert.equal(first.ok, true);
    assert.equal(second.ok, true);
    if (!first.ok || !second.ok) return;
    const firstTransaction = beginOwnerRegistry(first.registry_context, firstRoot, ["constitution_gate"]);
    assert.equal(firstTransaction.ok, true);
    if (!firstTransaction.ok) return;
    assert.equal(registryRegistrationOwnerMatches(firstTransaction.token, "constitution_gate", firstOwner), true);
    assert.equal(registryRegistrationOwnerMatches(firstTransaction.token, "constitution_gate", secondOwner), false);
    const concurrent = beginOwnerRegistry(second.registry_context, secondRoot, ["constitution_gate"]);
    assert.equal(concurrent.ok, true);
    if (concurrent.ok) commitOwnerRegistry(concurrent.token);
    rollbackOwnerRegistry(firstTransaction.token);
    const afterRollback = beginOwnerRegistry(second.registry_context, secondRoot, ["constitution_gate"]);
    assert.equal(afterRollback.ok, true);
    if (afterRollback.ok) commitOwnerRegistry(afterRollback.token);
  } finally {
    rmSync(firstRoot, { recursive: true, force: true });
    rmSync(secondRoot, { recursive: true, force: true });
  }
});

test("registry token caps and expiry roll back stale transactions", () => {
  const root = mkdtempSync(join(tmpdir(), "omp-owner-token-bounds-"));
  const realNow = Date.now;
  try {
    const observed = marker(root);
    const opened = openWorkflowActivation(root, ["workflow_registration"], activationOwner("token-bounds", root, observed.path, observed.sha256));
    assert.equal(opened.ok, true);
    if (!opened.ok) return;
    const tokens = [];
    for (let index = 0; index < 8; index += 1) {
      const transaction = beginOwnerRegistry(opened.registry_context, root, ["constitution_gate"]);
      assert.equal(transaction.ok, true);
      if (transaction.ok) tokens.push(transaction.token);
    }
    const capped = beginOwnerRegistry(opened.registry_context, root, ["constitution_gate"]);
    assert.equal(capped.ok, false);
    if (!capped.ok) assert.match(capped.error, /per context.*bounded at 8/);
    for (const token of tokens) rollbackOwnerRegistry(token);

    let now = 1_000_000;
    Date.now = () => now;
    const expiring = beginOwnerRegistry(opened.registry_context, root, ["constitution_gate"]);
    assert.equal(expiring.ok, true);
    if (!expiring.ok) return;
    now += 30 * 60 * 1000 + 1;
    assert.throws(() => requireRegistryRegistration(expiring.token, "constitution_gate"), /registration token expired/);
    const afterExpiry = beginOwnerRegistry(opened.registry_context, root, ["constitution_gate"]);
    assert.equal(afterExpiry.ok, true);
    if (afterExpiry.ok) rollbackOwnerRegistry(afterExpiry.token);
    closeWorkflowActivation(opened);
  } finally {
    Date.now = realNow;
    rmSync(root, { recursive: true, force: true });
  }
});

test("workflow_tools registry family requires a live workflow_tools owner capability", () => {
  const root = mkdtempSync(join(tmpdir(), "omp-owner-family-capability-"));
  try {
    const observed = marker(root);
    const activated = activationOwner("registration-only", root, observed.path);
    const opened = openWorkflowActivation(root, ["workflow_registration"], activated);
    assert.equal(opened.ok, true);
    if (!opened.ok) return;
    const rejected = beginOwnerRegistry(opened.registry_context, root, ["workflow_tools"]);
    assert.equal(rejected.ok, false);
    if (!rejected.ok) assert.equal(rejected.code, "owner_conflict");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});


test("commit callbacks run once only on successful commit and failure frees the slot", () => {
  const firstRoot = mkdtempSync(join(tmpdir(), "omp-owner-commit-one-"));
  const secondRoot = mkdtempSync(join(tmpdir(), "omp-owner-commit-two-"));
  try {
    const firstMarker = marker(firstRoot);
    const secondMarker = marker(secondRoot);
    const firstOwner = activationOwner("commit-one", firstRoot, firstMarker.path);
    const secondOwner = activationOwner("commit-two", secondRoot, secondMarker.path);
    const first = openWorkflowActivation(firstRoot, ["workflow_registration"], firstOwner);
    const second = openWorkflowActivation(secondRoot, ["workflow_registration"], secondOwner);
    assert.equal(first.ok, true);
    assert.equal(second.ok, true);
    if (!first.ok || !second.ok) return;
    const firstTransaction = beginOwnerRegistry(first.registry_context, firstRoot, ["constitution_gate"]);
    assert.equal(firstTransaction.ok, true);
    if (!firstTransaction.ok) return;
    let rolledBackCommits = 0;
    recordRegistryCommit(firstTransaction.token, "constitution_gate", () => { rolledBackCommits += 1; });
    rollbackOwnerRegistry(firstTransaction.token);
    assert.equal(rolledBackCommits, 0);

    const secondTransaction = beginOwnerRegistry(second.registry_context, secondRoot, ["constitution_gate"]);
    assert.equal(secondTransaction.ok, true);
    if (!secondTransaction.ok) return;
    let committed = 0;
    recordRegistryCommit(secondTransaction.token, "constitution_gate", () => { committed += 1; });
    commitOwnerRegistry(secondTransaction.token);
    assert.equal(committed, 1);
    assert.throws(() => commitOwnerRegistry(secondTransaction.token), /registration token is not genuine or is closed/);

    const failing = beginOwnerRegistry(first.registry_context, firstRoot, ["constitution_gate"]);
    assert.equal(failing.ok, true);
    if (!failing.ok) return;
    let undone = 0;
    recordRegistryCommit(failing.token, "constitution_gate", () => { throw new Error("commit callback failed"); });
    // The undo path remains available when a commit callback fails.
    const undo = () => { undone += 1; };
    // Registering the undo through the public owner seam also proves the
    // callback failure closes the transaction before the next begin.
    recordRegistryUndo(failing.token, undo);
    assert.throws(() => commitOwnerRegistry(failing.token), /commit callback failed/);
    assert.equal(undone, 1);
    const afterFailure = beginOwnerRegistry(first.registry_context, firstRoot, ["constitution_gate"]);
    assert.equal(afterFailure.ok, true);
    if (afterFailure.ok) commitOwnerRegistry(afterFailure.token);
  } finally {
    rmSync(firstRoot, { recursive: true, force: true });
    rmSync(secondRoot, { recursive: true, force: true });
  }
});


test("runtime_config registry family requires config_writer and revokes after claim loss", () => {
  const root = mkdtempSync(join(tmpdir(), "omp-owner-runtime-config-"));
  try {
    const observed = marker(root);
    const registrationOnly = activationOwner("runtime-config-owner", root, observed.path);
    const first = openWorkflowActivation(root, ["workflow_registration"], registrationOnly);
    assert.equal(first.ok, true);
    if (!first.ok) return;
    const rejected = beginOwnerRegistry(first.registry_context, root, ["runtime_config"]);
    assert.equal(rejected.ok, false);
    if (!rejected.ok) assert.equal(rejected.code, "owner_conflict");

    const configOwner = activationOwner("runtime-config-owner", root, observed.path);
    const opened = openWorkflowActivation(root, ["workflow_registration", "config_writer"], configOwner);
    assert.equal(opened.ok, true);
    if (!opened.ok) return;
    const transaction = beginOwnerRegistry(opened.registry_context, root, ["runtime_config"]);
    assert.equal(transaction.ok, true);
    if (!transaction.ok) return;
    assert.deepEqual(registryRegistrationOwnerMatches(transaction.token, "runtime_config", configOwner), true);
    const released = releaseWorkflowOwners(opened.release_token, ["config_writer"]);
    assert.deepEqual(released.released, ["config_writer"]);
    assert.throws(
      () => requireRegistryRegistration(transaction.token, "runtime_config"),
      (error: unknown) => (error as { code?: string }).code === "owner_conflict",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});


test("marker loss before owner claim registers no commands and retains no claim", () => {
  const root = mkdtempSync(join(tmpdir(), "omp-command-marker-before-claim-"));
  const markerInfo = marker(root);
  const harness = commandHarness();
  let resolveCalls = 0;
  try {
    registerWorkflowCommands(harness.pi as never, {
      owner: () => activationOwner("marker-before-claim", root, markerInfo.path, markerInfo.sha256),
      resolveCwd: () => {
        resolveCalls += 1;
        if (resolveCalls === 1) unlinkSync(join(root, markerInfo.path));
        return root;
      },
    });
    assert.throws(() => harness.sessionStarts[0]?.({}, { cwd: root, sessionManager: { getCwd: () => root, getSessionId: () => "marker-before-claim" } }), /activation_markers_missing/);
    assert.equal(harness.registerCalls, 0);
    assert.deepEqual([...harness.commands.keys()], []);
    assert.equal(workflowOwnerFor(root, "workflow_registration"), undefined);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("marker loss during the first host command effect rolls back the owner claim", () => {
  const root = mkdtempSync(join(tmpdir(), "omp-command-marker-before-host-"));
  const markerInfo = marker(root);
  const commands = new Map<string, { handler: CommandHandler }>();
  let registerCalls = 0;
  const pi = {
    registerCommand(name: string, command: { handler: CommandHandler }) {
      registerCalls += 1;
      unlinkSync(join(root, markerInfo.path));
      throw new Error("marker lost before host command commit");
    },
    on() {},
  };
  try {
    assert.throws(
      () => registerWorkflowCommands(pi as never, {
        cwd: root,
        owner: activationOwner("marker-before-host", root, markerInfo.path, markerInfo.sha256),
      }),
      /marker lost before host command commit/,
    );
    assert.equal(registerCalls, 1);
    assert.equal(commands.size, 0);
    assert.equal(workflowOwnerFor(root, "workflow_registration"), undefined);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("marker loss during the first tool host effect stops the mount and leaves the retained tool inert", async () => {
  const root = mkdtempSync(join(tmpdir(), "omp-tool-marker-mid-mount-"));
  const tools: Array<{ execute?: (...args: unknown[]) => Promise<{ details: unknown }> }> = [];
  let registerCalls = 0;
  const pi = {
    zod: {},
    registerTool(tool: unknown) {
      registerCalls += 1;
      tools.push(tool as { execute?: (...args: unknown[]) => Promise<{ details: unknown }> });
      if (registerCalls === 1) unlinkSync(join(root, ".omp-test-registry-marker"));
    },
    on() {},
  };
  try {
    assert.throws(
      () => registerTestCtoTools(root, pi as never, { observability: false }, "tool-marker-mid-mount"),
      /(?:activation_markers_missing|ENOENT)/,
    );
    assert.equal(registerCalls, 1, "marker loss aborts before a subsequent host registration");
    assert.equal(workflowOwnerFor(root, "workflow_registration"), undefined, "failed mount does not retain its owner claim");
    const mounted = tools[0];
    assert.ok(mounted?.execute, "the host may retain a partial registration");
    if (!mounted?.execute) return;
    const result = await mounted.execute("call-1", {}, undefined, undefined, {});
    assert.equal((result.details as { code?: string }).code, "REGISTRATION_FAILED", "a partial registration remains inert after marker loss");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("marker loss during the first extension hook effect stops the team mount", () => {
  const root = mkdtempSync(join(tmpdir(), "omp-hook-marker-mid-mount-"));
  const hooks: string[] = [];
  const pi = {
    setLabel() {},
    on(event: string) {
      hooks.push(event);
      if (hooks.length === 1) unlinkSync(join(root, ".omp-test-registry-marker"));
    },
  };
  try {
    assert.throws(
      () => registerTestTeamWorkflow(root, pi as never, { observability: false }, "hook-marker-mid-mount"),
      /(?:activation_markers_missing|ENOENT)/,
    );
    assert.deepEqual(hooks, ["before_agent_start"], "marker loss aborts before a subsequent extension hook registration");
    assert.equal(workflowOwnerFor(root, "workflow_registration"), undefined, "failed hook mount does not retain its owner claim");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("marker loss between commit callbacks prevents later visibility", () => {
  const root = mkdtempSync(join(tmpdir(), "omp-owner-commit-marker-loop-"));
  const observed = marker(root);
  const authenticatedOwner = activationOwner("commit-marker-loop", root, observed.path, observed.sha256);
  let firstVisible = 0;
  let laterVisible = 0;
  let undone = 0;
  const opened = openWorkflowActivation(root, ["workflow_registration"], authenticatedOwner);
  assert.equal(opened.ok, true);
  if (!opened.ok) {
    rmSync(root, { recursive: true, force: true });
    return;
  }
  try {
    const transaction = beginOwnerRegistry(opened.registry_context, root, ["constitution_gate"]);
    assert.equal(transaction.ok, true);
    if (!transaction.ok) return;
    recordRegistryCommit(transaction.token, "constitution_gate", () => { firstVisible += 1; });
    recordRegistryCommit(transaction.token, "constitution_gate", () => { unlinkSync(join(root, observed.path)); });
    recordRegistryCommit(transaction.token, "constitution_gate", () => { laterVisible += 1; });
    recordRegistryUndo(transaction.token, () => { undone += 1; });
    assert.throws(() => commitOwnerRegistry(transaction.token), /(?:activation_markers_missing|ENOENT)/);
    assert.equal(firstVisible, 1);
    assert.equal(laterVisible, 0, "marker loss blocks the next commit callback");
    assert.equal(undone, 1, "failed commit rolls back its registered visibility");
  } finally {
    closeRetainedTestRegistrations(root);
    releaseWorkflowOwners(opened.release_token, opened.leased_capabilities);
    rmSync(root, { recursive: true, force: true });
  }
});

test("marker loss after the final callback fails before commit return and undoes visibility", () => {
  const root = mkdtempSync(join(tmpdir(), "omp-owner-commit-final-marker-"));
  const observed = marker(root);
  const authenticatedOwner = activationOwner("commit-final-marker", root, observed.path, observed.sha256);
  const opened = openWorkflowActivation(root, ["workflow_registration"], authenticatedOwner);
  assert.equal(opened.ok, true);
  if (!opened.ok) {
    rmSync(root, { recursive: true, force: true });
    return;
  }
  try {
    const transaction = beginOwnerRegistry(opened.registry_context, root, ["constitution_gate"]);
    assert.equal(transaction.ok, true);
    if (!transaction.ok) return;
    let visible = 0;
    let undone = 0;
    recordRegistryCommit(transaction.token, "constitution_gate", () => { visible += 1; });
    recordRegistryUndo(transaction.token, () => { undone += 1; });
    let livenessChecks = 0;
    assert.throws(
      () => withExecutionLiveness(() => {
        livenessChecks += 1;
        if (livenessChecks === 2) unlinkSync(join(root, observed.path));
      }, () => commitOwnerRegistry(transaction.token)),
      /(?:activation_markers_missing|ENOENT|activation_identity_changed)/,
    );
    assert.equal(visible, 1, "the final callback ran before the adversarial marker loss");
    assert.equal(undone, 1, "marker loss in the final interval rolls back committed visibility");
    assert.equal(livenessChecks, 3, "the final interval performs its own liveness check");
    assert.throws(() => commitOwnerRegistry(transaction.token), /(?:activation_markers_missing|ENOENT|activation_identity_changed|registration token is not genuine or is closed)/);
  } finally {
    closeRetainedTestRegistrations(root);
    releaseWorkflowOwners(opened.release_token, opened.leased_capabilities);
    rmSync(root, { recursive: true, force: true });
  }
});
