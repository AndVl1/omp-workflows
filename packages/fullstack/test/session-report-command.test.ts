/**
 * Focused tests for the `/session-report` fullstack custom-TS command
 * (pragmatic architecture, frontend slice).
 *
 * The command is a thin orchestration shell over the core report API
 * (buildSessionReport → renderReportHtml → writeReport). These tests drive
 * the real command factory with fake CustomCommandAPI/HookCommandContext and
 * real core functions against temp project roots:
 *   - argument parsing (bare / kind / id= / --full / errors)
 *   - per-feature, legacy, and per-CTO target-path selection
 *   - static overwrite semantics (re-run rewrites the same path)
 *   - error paths never write a report
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  appendFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sessionReportFactory, {
  parseSessionReportArgs,
  sessionReportTargetPath,
} from "../commands/session-report/index.js";
import {
  buildProjectIdentity,
  buildWorkflowRunIdentity,
  computePolicyByteHash,
  computePolicySemanticHash,
  createCanonicalRoot,
  createWorkflowV2Digest,
  effectivePolicyFromSnapshot,
} from "@andvl1/omp-workflows-core";
import type {
  ActualAgentInventory,
  AgentInventoryAuthority,
  AgentInventoryAuthorityContext,
  AgentRef,
  PolicyDocument,
  PolicySnapshot,
  ProjectIdentity,
  SessionReport,
  WorkflowRunIdentity,
  WorkflowV2Digest,
} from "@andvl1/omp-workflows-core";
import {
  createFullstackStorageAuthority,
  type FullstackStorageAuthority,
  type FullstackStorageNativeBackend,
  type StorageEntry,
  type StorageFailure,
  type StorageLease,
  type StorageResult,
  type StorageStat,
} from "@andvl1/omp-workflows-fullstack";
import {
  FULLSTACK_PROVIDER_AGENT_REFS,
  FULLSTACK_PROVIDER_CATALOG,
  FULLSTACK_PROVIDER_CATALOG_CONTENT_DIGEST,
  FULLSTACK_PROVIDER_DESCRIPTOR,
  FULLSTACK_PROVIDER_DESCRIPTOR_FINGERPRINT,
  FULLSTACK_PROVIDER_ID,
} from "../src/provider.js";
import { createTestFullstackInventoryAdmissionContext } from "../dist/agent-mapping.js";
import { runtimeFixture } from "./runtime-fixtures.js";

const POLICY_DOCUMENT: PolicyDocument = {
  schema_version: 2,
  provider: {
    id: FULLSTACK_PROVIDER_ID,
    protocol_version: 2,
    descriptor_fingerprint: FULLSTACK_PROVIDER_DESCRIPTOR_FINGERPRINT,
    catalog_content_digest: FULLSTACK_PROVIDER_CATALOG_CONTENT_DIGEST,
  },
  policy: {
    roles: {},
    scope_map: [],
    roster_overrides: [],
    flags: {},
    runtime_classes: {},
    ui_classes: {},
    design_system: null,
    commands: {
      "do-work": { fragments: [] },
      team: { alias_of: "do-work" },
      cto: { fragments: [] },
    },
    workflow: { selection: "matrix" },
    prompt_context: {},
    required_capabilities: [],
  },
};

function unwrapDiagnostic<T>(
  result: { readonly ok: true; readonly value: T } | { readonly ok: false; readonly diagnostics: readonly unknown[] },
): T {
  if (!result.ok) throw new Error("v2 test fixture construction failed");
  return result.value;
}

function profileIdentityFor(name: string) {
  const profile = FULLSTACK_PROVIDER_CATALOG.profiles.find((candidate) => candidate.identity.id === name);
  if (!profile) throw new Error(`fullstack catalog fixture is missing profile '${name}'`);
  return profile.identity;
}

function agentRefFor(name: string) {
  const ref = FULLSTACK_PROVIDER_AGENT_REFS[name];
  if (!ref) throw new Error(`fullstack descriptor fixture is missing agent '${name}'`);
  return ref;
}
function runIdentityFor(project_identity: ProjectIdentity, run_id: string, profile: string): WorkflowRunIdentity {
  return unwrapDiagnostic(buildWorkflowRunIdentity({
    project_identity,
    run_id,
    profile_identity: profileIdentityFor(profile),
  }));
}

function inventoryFingerprint(agents: readonly AgentRef[]): WorkflowV2Digest {
  const value = createWorkflowV2Digest(
    `sha256:${createHash("sha256").update(JSON.stringify(agents.map((agent) => ({
      provider_id: agent.provider_id,
      registered_name: agent.registered_name,
      source_fingerprint: agent.source_fingerprint,
    }))), "utf8").digest("hex")}`,
  );
  if (!value) throw new Error("test inventory fingerprint should be valid");
  return value;
}
function storageFailure<T>(reason: StorageFailure["reason"]): StorageResult<T> {
  return { ok: false, reason, code: reason };
}

function validStorageRelative(value: string): boolean {
  return typeof value === "string"
    && value.length > 0
    && value.length <= 1_024
    && !value.startsWith("/")
    && !value.includes("\\")
    && !value.includes("\u0000")
    && value.split("/").every((part) =>
      part.length > 0
      && part.length <= 255
      && part !== "."
      && part !== ".."
      && /^[A-Za-z0-9._-]+$/u.test(part));
}

function storagePathFor(root: string, relativePath: string): string {
  if (!validStorageRelative(relativePath)) throw new Error(`unsafe test storage path: ${relativePath}`);
  return join(root, ...relativePath.split("/"));
}

function ensureStorageParents(root: string, relativePath: string): void {
  const parts = relativePath.split("/");
  parts.pop();
  let current = root;
  for (const part of parts) {
    current = join(current, part);
    const existing = lstatSync(current, { throwIfNoEntry: false });
    if (existing?.isSymbolicLink() || (existing && !existing.isDirectory())) {
      throw new Error("unsafe test storage parent");
    }
    mkdirSync(current, { recursive: true });
  }
}

function sameStorageRun(left: WorkflowRunIdentity, right: WorkflowRunIdentity): boolean {
  return left.root_instance_id === right.root_instance_id
    && left.provider_id === right.provider_id
    && left.descriptor_fingerprint === right.descriptor_fingerprint
    && left.executable_provenance.build_fingerprint === right.executable_provenance.build_fingerprint
    && left.executable_provenance.runtime_fingerprint === right.executable_provenance.runtime_fingerprint
    && left.catalog_content_digest === right.catalog_content_digest
    && left.config_byte_sha256 === right.config_byte_sha256
    && left.config_semantic_sha256 === right.config_semantic_sha256
    && left.session.session_id === right.session.session_id
    && left.session.lifecycle_id === right.session.lifecycle_id
    && left.run_id === right.run_id
    && left.profile_identity.id === right.profile_identity.id
    && left.profile_identity.fingerprint === right.profile_identity.fingerprint;
}

function storageFor(root: string, run: WorkflowRunIdentity): FullstackStorageAuthority {
  const projectRoot = createCanonicalRoot(root);
  if (!projectRoot) throw new Error(`test root is not canonical: ${root}`);
  let atomicCounter = 0;
  let leaseCounter = 0;
  const leases = new Set<string>();
  const readBounded = (relativePath: string, maxBytes: number): StorageResult<Uint8Array | null> => {
    if (!validStorageRelative(relativePath) || !Number.isSafeInteger(maxBytes) || maxBytes <= 0) return storageFailure("LIMIT");
    const path = storagePathFor(projectRoot, relativePath);
    const stat = lstatSync(path, { throwIfNoEntry: false });
    if (!stat) return { ok: true, value: null };
    if (stat.isSymbolicLink() || !stat.isFile()) return storageFailure("UNSAFE_PATH");
    if (stat.size > maxBytes) return storageFailure("LIMIT");
    try { return { ok: true, value: readFileSync(path) }; } catch { return storageFailure("IO"); }
  };
  const readTextBounded = (relativePath: string, maxBytes: number): StorageResult<string | null> => {
    const raw = readBounded(relativePath, maxBytes);
    if (!raw.ok || raw.value === null) return raw;
    try { return { ok: true, value: new TextDecoder("utf-8", { fatal: true }).decode(raw.value) }; } catch { return storageFailure("IO"); }
  };
  const statBounded = (relativePath: string): StorageResult<StorageStat> => {
    if (!validStorageRelative(relativePath)) return storageFailure("UNSAFE_PATH");
    const stat = lstatSync(storagePathFor(projectRoot, relativePath), { throwIfNoEntry: false });
    if (!stat) return { ok: true, value: { exists: false, kind: "missing", size_bytes: 0, mtime_ms: 0 } };
    if (stat.isSymbolicLink()) return storageFailure("UNSAFE_PATH");
    return {
      ok: true,
      value: {
        exists: true,
        kind: stat.isDirectory() ? "directory" : "file",
        size_bytes: stat.isFile() ? stat.size : 0,
        mtime_ms: stat.mtimeMs,
      },
    };
  };
  const writeExclusive = (relativePath: string, bytes: Uint8Array, mode = 0o600): StorageResult<void> => {
    if (!validStorageRelative(relativePath) || !(bytes instanceof Uint8Array)) return storageFailure("UNSAFE_PATH");
    try {
      ensureStorageParents(projectRoot, relativePath);
      writeFileSync(storagePathFor(projectRoot, relativePath), bytes, { flag: "wx", mode });
      return { ok: true, value: undefined };
    } catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "EEXIST") return storageFailure("CONFLICT");
      return storageFailure("IO");
    }
  };
  const writeAtomic = (relativePath: string, bytes: Uint8Array, maxBytes: number): StorageResult<void> => {
    if (!validStorageRelative(relativePath) || !(bytes instanceof Uint8Array) || !Number.isSafeInteger(maxBytes) || maxBytes <= 0 || bytes.byteLength > maxBytes) return storageFailure("LIMIT");
    const leaf = relativePath.slice(relativePath.lastIndexOf("/") + 1);
    const prefix = relativePath.slice(0, Math.max(0, relativePath.lastIndexOf("/") + 1));
    const temporary = `${prefix}.${leaf}.tmp-${++atomicCounter}`;
    try {
      ensureStorageParents(projectRoot, temporary);
      writeFileSync(storagePathFor(projectRoot, temporary), bytes, { flag: "wx", mode: 0o600 });
      renameSync(storagePathFor(projectRoot, temporary), storagePathFor(projectRoot, relativePath));
      return { ok: true, value: undefined };
    } catch {
      rmSync(storagePathFor(projectRoot, temporary), { force: true });
      return storageFailure("IO");
    }
  };
  const listBounded = (relativeDirectory: string, maxEntries: number): StorageResult<readonly StorageEntry[]> => {
    if (!validStorageRelative(relativeDirectory) || !Number.isSafeInteger(maxEntries) || maxEntries <= 0) return storageFailure("LIMIT");
    const directory = storagePathFor(projectRoot, relativeDirectory);
    const stat = lstatSync(directory, { throwIfNoEntry: false });
    if (!stat) return { ok: true, value: [] };
    if (stat.isSymbolicLink() || !stat.isDirectory()) return storageFailure("UNSAFE_PATH");
    const names = readdirSync(directory);
    if (names.length > maxEntries) return storageFailure("LIMIT");
    const entries: StorageEntry[] = [];
    for (const name of names) {
      if (!validStorageRelative(name)) return storageFailure("UNSAFE_PATH");
      const child = lstatSync(join(directory, name));
      if (child.isSymbolicLink() || (!child.isFile() && !child.isDirectory())) return storageFailure("UNSAFE_PATH");
      entries.push({ name, relative_path: `${relativeDirectory}/${name}` });
    }
    return { ok: true, value: entries };
  };
  const appendJsonLineBounded = (relativePath: string, bytes: Uint8Array, maxBytes: number): StorageResult<void> => {
    if (!validStorageRelative(relativePath) || !(bytes instanceof Uint8Array) || !Number.isSafeInteger(maxBytes) || maxBytes <= 0) return storageFailure("LIMIT");
    const path = storagePathFor(projectRoot, relativePath);
    const stat = lstatSync(path, { throwIfNoEntry: false });
    if (stat?.isSymbolicLink() || (stat && !stat.isFile())) return storageFailure("UNSAFE_PATH");
    if ((stat?.size ?? 0) + bytes.byteLength > maxBytes) return storageFailure("LIMIT");
    try {
      ensureStorageParents(projectRoot, relativePath);
      appendFileSync(path, bytes);
      return { ok: true, value: undefined };
    } catch { return storageFailure("IO"); }
  };
  const moveExclusive = (sourceRelativePath: string, targetRelativePath: string): StorageResult<void> => {
    if (!validStorageRelative(sourceRelativePath) || !validStorageRelative(targetRelativePath)) return storageFailure("UNSAFE_PATH");
    const source = storagePathFor(projectRoot, sourceRelativePath);
    const target = storagePathFor(projectRoot, targetRelativePath);
    if (lstatSync(target, { throwIfNoEntry: false })) return storageFailure("CONFLICT");
    try { ensureStorageParents(projectRoot, targetRelativePath); renameSync(source, target); return { ok: true, value: undefined }; } catch { return storageFailure("IO"); }
  };
  const removeIfOwned = (relativePath: string, identity: WorkflowRunIdentity): StorageResult<boolean> => {
    if (!validStorageRelative(relativePath) || !sameStorageRun(identity, run)) return storageFailure("IDENTITY_MISMATCH");
    try {
      const stat = lstatSync(storagePathFor(projectRoot, relativePath));
      if (stat.isSymbolicLink() || !stat.isFile()) return storageFailure("UNSAFE_PATH");
      rmSync(storagePathFor(projectRoot, relativePath), { force: true });
      return { ok: true, value: true };
    } catch { return { ok: true, value: false }; }
  };
  const acquireLease = (relativePath: string, identity: WorkflowRunIdentity): StorageResult<StorageLease> => {
    if (!validStorageRelative(relativePath) || !sameStorageRun(identity, run)) return storageFailure("IDENTITY_MISMATCH");
    if (leases.has(relativePath)) return storageFailure("CONFLICT");
    const lease_id = `test-report-lease-${++leaseCounter}`;
    leases.add(relativePath);
    return { ok: true, value: { relative_path: relativePath, run_identity: run, lease_id } };
  };
  const releaseLease = (relativePath: string, identity: WorkflowRunIdentity): StorageResult<void> => {
    if (!validStorageRelative(relativePath) || !sameStorageRun(identity, run)) return storageFailure("IDENTITY_MISMATCH");
    leases.delete(relativePath);
    return { ok: true, value: undefined };
  };
  const native: FullstackStorageNativeBackend = {
    canonical_root: projectRoot,
    run_identity: run,
    readBounded,
    readTextBounded,
    statBounded,
    writeExclusive,
    writeAtomic,
    appendJsonLineBounded,
    listBounded,
    moveExclusive,
    removeIfOwned,
    acquireLease,
    releaseLease,
  };
  return unwrapDiagnostic(createFullstackStorageAuthority({
    project_root: projectRoot,
    run_identity: run,
    filesystem_authority: runtimeFixture(projectRoot).context.filesystem_authority,
    native,
  }));
}

function managerContext(root: string) {
  const canonicalRoot = createCanonicalRoot(root);
  if (!canonicalRoot) throw new Error(`test root is not canonical: ${root}`);
  const rawPolicy = JSON.stringify(POLICY_DOCUMENT);
  const policySnapshot: PolicySnapshot = {
    root: canonicalRoot,
    document: POLICY_DOCUMENT,
    byte_sha256: computePolicyByteHash(rawPolicy),
    semantic_sha256: computePolicySemanticHash(POLICY_DOCUMENT),
    byte_length: new TextEncoder().encode(rawPolicy).byteLength,
  };
  const project_identity = unwrapDiagnostic(buildProjectIdentity({
    root_instance_id: computePolicyByteHash(root),
    provider_id: FULLSTACK_PROVIDER_ID,
    descriptor_fingerprint: FULLSTACK_PROVIDER_DESCRIPTOR_FINGERPRINT,
    executable_provenance: FULLSTACK_PROVIDER_DESCRIPTOR.executable_provenance,
    catalog_content_digest: FULLSTACK_PROVIDER_CATALOG_CONTENT_DIGEST,
    config_byte_sha256: policySnapshot.byte_sha256,
    config_semantic_sha256: policySnapshot.semantic_sha256,
    session: {
      session_id: "session-report-command",
      lifecycle_id: "session-report-command-lifecycle",
    },
  }));
  const effectivePolicy = unwrapDiagnostic(effectivePolicyFromSnapshot(policySnapshot, FULLSTACK_PROVIDER_DESCRIPTOR));
  return {
    policySnapshot,
    effectivePolicy,
    catalog: FULLSTACK_PROVIDER_CATALOG,
    project_identity,
  };
}

function reportContext(root: string, run_id: string, profile: string) {
  const base = managerContext(root);
  const run_identity = runIdentityFor(base.project_identity, run_id, profile);
  const agents = Object.freeze(Object.values(FULLSTACK_PROVIDER_AGENT_REFS));
  const actual: ActualAgentInventory = Object.freeze({
    authority: "omp",
    provider_id: base.project_identity.provider_id,
    descriptor_fingerprint: base.project_identity.descriptor_fingerprint,
    agents,
    inventory_fingerprint: inventoryFingerprint(agents),
    reservation: Object.freeze({
      reservation_id: `report-reservation-${run_id}`,
      fingerprint: createWorkflowV2Digest(`sha256:${createHash("sha256").update(`reservation:${run_id}`, "utf8").digest("hex")}`)!,
    }),
  });
  const authority: AgentInventoryAuthority = {
    resolve: () => ({ ok: true, value: actual, diagnostics: [] }),
  };
  const authorityContext = Object.freeze({
    canonical_root: createCanonicalRoot(root)!,
    session: base.project_identity.session,
    provider_id: base.project_identity.provider_id,
    descriptor_fingerprint: base.project_identity.descriptor_fingerprint,
    descriptor: FULLSTACK_PROVIDER_DESCRIPTOR,
    catalog: FULLSTACK_PROVIDER_CATALOG,
    effective_policy: base.effectivePolicy,
  }) as unknown as AgentInventoryAuthorityContext;
  const inventory_admission = createTestFullstackInventoryAdmissionContext({
    project_identity: base.project_identity,
    run_identity,
    canonical_root: createCanonicalRoot(root)!,
    agent_inventory: actual,
    agent_inventory_authority: authority,
    authority_context: authorityContext,
  });
  if (!inventory_admission) throw new Error("test inventory admission should be issued");
  const storage_authority = storageFor(root, run_identity);
  return { ...base, run_identity, inventory_admission, storage_authority };
}

function makeProject(): { root: string; notifyCalls: string[] } {
  const root = mkdtempSync(join(tmpdir(), "session-report-cmd-"));
  return { root, notifyCalls: [] };
}

function fakeApi(root: string): Record<string, unknown> {
  return {
    cwd: root,
    exec: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
    typebox: {},
    arktype: {},
    zod: {},
    pi: {},
  };
}

function fakeCtx(
  root: string,
  notifyCalls: string[],
  run_id = "do-work-report-test",
  profile = "standard",
): Record<string, unknown> {
  return {
    cwd: root,
    ui: { notify: (message: string) => void notifyCalls.push(message) },
    hasUI: false,
    sessionManager: undefined,
    modelRegistry: undefined,
    model: undefined,
    isIdle: () => true,
    abort: () => undefined,
    hasQueuedMessages: () => false,
    ...reportContext(root, run_id, profile),
  };
}

const TEAM_STATE = {
  schema: 1,
  branch: "feat/report-test",
  classification: {
    type: "FEATURE",
    complexity: "MEDIUM",
    confidence: "HIGH",
    workflow: "standard",
    autonomous: true,
    autonomous_reason: "well-scoped",
  },
  task: "Build the /session-report command",
  workflow_override: false,
  issue: null,
  stage_cursor: "code_review",
  workflow: "standard",
  cursor_epoch: "session-report-command-epoch",
  stages: [
    { id: "discovery", status: "done" },
    { id: "exploration", status: "done" },
    { id: "clarify", status: "done" },
    { id: "architecture", status: "done" },
    { id: "implementation", status: "done" },
    { id: "code_review", status: "in_progress" },
    { id: "review_fixes", status: "pending" },
    { id: "manual_qa", status: "pending" },
    { id: "qa_tests", status: "pending" },
    { id: "summary", status: "pending" },
  ],
  artifacts: {},
  pause: { kind: "none", reason: "" },
  updated_at: "2026-08-08T10:00:00.000Z",
};

function writeDoWorkFixture(root: string, slug: string): void {
  const context = managerContext(root);
  const run_identity = runIdentityFor(context.project_identity, `do-work-${slug}`, "standard");
  const state = {
    ...TEAM_STATE,
    project_identity: context.project_identity,
    run_identity,
    profile_hash: run_identity.profile_identity.fingerprint,
    run_key: run_identity.run_id,
  };
  const wsDir = join(root, ".work-state");
  const featureDir = join(wsDir, "features", slug);
  mkdirSync(join(featureDir, "artifacts"), { recursive: true });
  writeFileSync(join(wsDir, ".active-feature"), `${slug}\n`, "utf8");
  writeFileSync(join(featureDir, "state.json"), JSON.stringify(state, null, 2), "utf8");
  writeFileSync(
    join(featureDir, "artifacts", "implementation.json"),
    JSON.stringify({ title: "Implementation plan", steps: ["wire command", "add tests"] }, null, 2),
    "utf8",
  );
}

const CTO_STATE = {
  schema: 2,
  id: "run-1",
  task: "Decompose the payments migration",
  branch: "feat/payments",
  autonomous: false,
  plan: {
    task: "Decompose the payments migration",
    teams: [
      { team: "backend", scope: ["**/*.kt"], slice: "API", profile: "full-feature", worktree: "same_branch", depends_on: [] },
      { team: "web", scope: ["**/*.tsx"], slice: "Frontend", profile: "standard", worktree: "same_branch", depends_on: ["backend"] },
    ],
    created_at: "2026-08-08T10:00:00.000Z",
  },
  teams: [
    { id: "backend", status: "done", escalations: {}, dod_path: ".work-state/cto/run-1/teams/backend/dod.json" },
    { id: "web", status: "parked", escalations: { "esc-1": { id: "esc-1", status: "pending" } } },
  ],
  integration: { status: "in_progress", note: "waiting for web" },
  pause: { kind: "background_wait", reason: "escalation pending" },
  updated_at: "2026-08-08T11:00:00.000Z",
};

function writeCtoFixture(root: string, runId: string): void {
  const context = managerContext(root);
  const run_identity = runIdentityFor(context.project_identity, runId, "cto");
  const rosterByTeam: Readonly<Record<string, string>> = {
    backend: "developer-kotlin",
    web: "frontend-developer",
  };
  const planTeams = CTO_STATE.plan.teams.map((entry) => {
    const agentName = rosterByTeam[entry.team];
    if (!agentName) throw new Error(`missing CTO roster fixture for team '${entry.team}'`);
    return {
      ...entry,
      profile_identity: profileIdentityFor(entry.profile),
      lead_ref: agentRefFor("team-lead"),
      roster_refs: [agentRefFor(agentName)],
      run_identity,
    };
  });
  const teams = CTO_STATE.teams.map((team) => {
    const plan = planTeams.find((entry) => entry.team === team.id);
    if (!plan) throw new Error(`missing CTO plan fixture for team '${team.id}'`);
    return {
      ...team,
      run_identity,
      profile_identity: plan.profile_identity,
      lead_ref: plan.lead_ref,
      roster_refs: plan.roster_refs,
    };
  });
  const state = {
    ...CTO_STATE,
    id: runId,
    run_identity,
    plan: { ...CTO_STATE.plan, id: runId, run_identity, teams: planTeams },
    teams,
  };
  const runDir = join(root, ".work-state", "cto", runId);
  mkdirSync(runDir, { recursive: true });
  writeFileSync(join(runDir, "state.json"), JSON.stringify(state, null, 2), "utf8");
}

// ── Argument parsing ────────────────────────────────────────────────────────

test("command: parses /session-report arguments", () => {
  assert.deepEqual(parseSessionReportArgs([]), { selector: {}, options: {} });
  assert.deepEqual(parseSessionReportArgs(["do-work"]), { selector: { kind: "do-work" }, options: {} });
  assert.deepEqual(parseSessionReportArgs(["cto"]), { selector: { kind: "cto" }, options: {} });
  assert.deepEqual(parseSessionReportArgs(["id=my-feature"]), { selector: { id: "my-feature" }, options: {} });
  assert.deepEqual(parseSessionReportArgs(["do-work", "id=my-feature", "--full"]), {
    selector: { kind: "do-work", id: "my-feature" },
    options: { includeFullArtifacts: true },
  });

  const unknown = parseSessionReportArgs(["oops"]);
  assert.ok(unknown.error?.includes("unknown argument: oops"));
  const duplicate = parseSessionReportArgs(["do-work", "cto"]);
  assert.ok(duplicate.error?.includes("duplicate session kind"));
  const emptyId = parseSessionReportArgs(["id="]);
  assert.ok(emptyId.error?.includes("empty id"));
});

test("command: chooses per-feature, legacy, and per-CTO target paths", () => {
  const featureReport = {
    kind: "do-work",
    source: { id: "my-feature", isLegacy: false },
  } as SessionReport;
  const legacyReport = {
    kind: "do-work",
    source: { id: "legacy", isLegacy: true },
  } as SessionReport;
  const ctoReport = {
    kind: "cto",
    source: { id: "run-9", isLegacy: false },
  } as SessionReport;

  assert.equal(sessionReportTargetPath(featureReport), ".work-state/features/my-feature/report.html");
  assert.equal(sessionReportTargetPath(legacyReport), ".work-state/report.html");
  assert.equal(sessionReportTargetPath(ctoReport), ".work-state/cto/run-9/report.html");
});

// ── Factory + end-to-end against real core ──────────────────────────────────

test("command: /session-report factory boots", () => {
  const cmd = sessionReportFactory(fakeApi(process.cwd()) as never);
  assert.equal(cmd.name, "session-report");
  assert.ok(cmd.description.includes("/session-report [do-work|cto]"));
});

test("command: bare invocation auto-detects the latest do-work session and writes the feature report", async () => {
  const { root, notifyCalls } = makeProject();
  writeDoWorkFixture(root, "report-test");
  const cmd = sessionReportFactory(fakeApi(root) as never);
  const result = await cmd.execute([], fakeCtx(root, notifyCalls) as never);

  const target = join(root, ".work-state", "features", "report-test", "report.html");
  assert.ok(existsSync(target), "report.html written under .work-state/features/<slug>/");
  const html = readFileSync(target, "utf8");
  assert.ok(html.startsWith("<!doctype html>"), "report is a standalone HTML file");

  assert.ok(html.includes("Build the /session-report command"), "task rendered");
  assert.ok(result.includes(".work-state/features/report-test/report.html"), "status names the output path");
  assert.ok(result.includes("report-test"), "status names the session id");
  assert.equal(notifyCalls.length, 1, "user notified once");
  assert.ok(notifyCalls[0]!.includes("session-report:"), "notify prefix");
  rmSync(root, { recursive: true, force: true });
});

test("command: report requires the exact host-issued inventory admission", async () => {
  const { root } = makeProject();
  writeDoWorkFixture(root, "report-test");
  const cmd = sessionReportFactory(fakeApi(root) as never);
  const context = fakeCtx(root, []) as Record<string, unknown>;
  const copied = {
    ...context,
    inventory_admission: { ...(context.inventory_admission as Record<string, unknown>) },
  };
  const copiedResult = await cmd.execute(["do-work", "id=report-test"], copied as never);
  assert.ok(copiedResult.startsWith("ERROR: CAPABILITY_MISSING"));
  delete context.inventory_admission;
  const result = await cmd.execute(["do-work", "id=report-test"], context as never);
  assert.ok(result.startsWith("ERROR: CAPABILITY_MISSING"));
  assert.ok(!existsSync(join(root, ".work-state", "features", "report-test", "report.html")));
  rmSync(root, { recursive: true, force: true });
});

test("command: report requires the opaque fullstack storage authority", async () => {
  const { root } = makeProject();
  writeDoWorkFixture(root, "report-test");
  const cmd = sessionReportFactory(fakeApi(root) as never);
  const context = fakeCtx(root, []) as Record<string, unknown>;
  const copiedStorage = {
    ...(context.storage_authority as Record<string, unknown>),
  };
  const copiedResult = await cmd.execute(["do-work", "id=report-test"], {
    ...context,
    storage_authority: copiedStorage,
  } as never);
  assert.ok(copiedResult.startsWith("ERROR: MIGRATION_REQUIRED"));
  delete context.storage_authority;
  const missingResult = await cmd.execute(["do-work", "id=report-test"], context as never);
  assert.ok(missingResult.startsWith("ERROR: MIGRATION_REQUIRED"));
  assert.ok(!existsSync(join(root, ".work-state", "features", "report-test", "report.html")));
  rmSync(root, { recursive: true, force: true });
});

test("command: report rejects storage authority bound to another run", async () => {
  const { root } = makeProject();
  writeDoWorkFixture(root, "report-test");
  const cmd = sessionReportFactory(fakeApi(root) as never);
  const context = fakeCtx(root, []) as Record<string, unknown>;
  const foreign = reportContext(root, "foreign-storage-run", "standard");
  context.storage_authority = foreign.storage_authority;
  const result = await cmd.execute(["do-work", "id=report-test"], context as never);
  assert.ok(result.startsWith("ERROR: IDENTITY_MISMATCH"));
  assert.ok(!existsSync(join(root, ".work-state", "features", "report-test", "report.html")));
  rmSync(root, { recursive: true, force: true });
});

test("command: cto report rejects a foreign selected run", async () => {
  const { root } = makeProject();
  writeCtoFixture(root, "run-1");
  const cmd = sessionReportFactory(fakeApi(root) as never);
  const result = await cmd.execute(["cto", "id=run-1"], fakeCtx(root, [], "foreign-run", "cto") as never);
  assert.ok(result.startsWith("ERROR: IDENTITY_MISMATCH"));
  assert.ok(!existsSync(join(root, ".work-state", "cto", "run-1", "report.html")));
  rmSync(root, { recursive: true, force: true });
});
test("command: --full embeds sanitized artifact bodies into the report", async () => {
  const { root } = makeProject();
  writeDoWorkFixture(root, "report-test");
  const cmd = sessionReportFactory(fakeApi(root) as never);
  const result = await cmd.execute(["do-work", "id=report-test", "--full"], fakeCtx(root, []) as never);

  const target = join(root, ".work-state", "features", "report-test", "report.html");
  assert.ok(existsSync(target));
  const html = readFileSync(target, "utf8");
  assert.ok(html.includes("Show full content"), "expandable artifact body present");
  assert.ok(html.includes("Implementation plan"), "sanitized body content embedded");
  assert.ok(result.startsWith("Session report written:"), "success status");
  rmSync(root, { recursive: true, force: true });
});

test("command: cto sessions write to .work-state/cto/<runId>/report.html", async () => {
  const { root } = makeProject();
  writeCtoFixture(root, "run-1");
  const cmd = sessionReportFactory(fakeApi(root) as never);

  const byKind = await cmd.execute(["cto"], fakeCtx(root, [], "run-1", "cto") as never);
  const target = join(root, ".work-state", "cto", "run-1", "report.html");
  assert.ok(existsSync(target), "cto report written under .work-state/cto/<runId>/");
  const html = readFileSync(target, "utf8");
  assert.ok(html.includes("CTO team &amp; dependency graph"), "cto graph rendered");
  assert.ok(html.includes("backend"), "team node rendered");
  assert.ok(byKind.includes(".work-state/cto/run-1/report.html"));

  const byId = await cmd.execute(["cto", "id=run-1"], fakeCtx(root, [], "run-1", "cto") as never);
  assert.ok(byId.startsWith("Session report written:"), "explicit id works");
  rmSync(root, { recursive: true, force: true });
});


test("command: re-running overwrites the same report path (static snapshot semantics)", async () => {
  const { root } = makeProject();
  writeDoWorkFixture(root, "report-test");
  const cmd = sessionReportFactory(fakeApi(root) as never);
  const target = join(root, ".work-state", "features", "report-test", "report.html");

  await cmd.execute(["do-work", "id=report-test"], fakeCtx(root, []) as never);
  const firstStat = statSync(target);
  await new Promise((resolve) => setTimeout(resolve, 20));
  await cmd.execute(["do-work", "id=report-test"], fakeCtx(root, []) as never);

  const secondStat = statSync(target);
  assert.ok(secondStat.mtimeMs >= firstStat.mtimeMs, "same path rewritten on re-run");
  assert.ok(readFileSync(target, "utf8").startsWith("<!doctype html>"));
  rmSync(root, { recursive: true, force: true });
});

// ── Error paths ─────────────────────────────────────────────────────────────

test("command: unknown arguments return usage and write nothing", async () => {
  const { root } = makeProject();
  const cmd = sessionReportFactory(fakeApi(root) as never);
  const result = await cmd.execute(["nope"], fakeCtx(root, []) as never);
  assert.ok(result.startsWith("ERROR: unknown argument: nope"));
  assert.ok(result.includes("Usage: /session-report"));
  assert.ok(!existsSync(join(root, ".work-state", "report.html")));
  rmSync(root, { recursive: true, force: true });
});

test("command: unknown session id returns a build error and writes nothing", async () => {
  const { root } = makeProject();
  writeDoWorkFixture(root, "report-test");
  const cmd = sessionReportFactory(fakeApi(root) as never);
  const result = await cmd.execute(["id=ghost"], fakeCtx(root, []) as never);
  assert.ok(result.startsWith("ERROR: could not build session report"));
  assert.ok(result.includes('id "ghost"'), "error names the missing session");
  assert.ok(!existsSync(join(root, ".work-state", "features", "ghost", "report.html")));
  rmSync(root, { recursive: true, force: true });
});

test("command: empty project returns a build error", async () => {
  const { root } = makeProject();
  const cmd = sessionReportFactory(fakeApi(root) as never);
  const result = await cmd.execute([], fakeCtx(root, []) as never);
  assert.ok(result.startsWith("ERROR: could not build session report"));
  assert.ok(!existsSync(join(root, ".work-state")), "no .work-state created on failure");
  rmSync(root, { recursive: true, force: true });
});
