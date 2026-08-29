/**
 * Session-report assembly: the report must consume one host-admitted,
 * provider/catalog/config identity and never reconstruct role mappings from
 * cwd-local legacy configuration.
 *
 * <!-- omp-cto-slice run=01a03ee4-7dd6-7580-8ad7-16d26dc886ba slice=workflow-v2-core -->
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { buildSessionReport, type ReportAssemblyOptions } from "../src/report/assemble.js";
import type { Profile, TeamState } from "../src/engine/types.js";
import { workflowV2Fixture, type WorkflowV2TestFixture } from "./workflow-v2-fixtures.js";
import { reportStorageFor } from "./report-storage-fixtures.js";
import type {
  CanonicalRoot,
  PolicyDocument,
  WorkflowPolicy,
} from "../src/workflow-v2/types.js";

const PROFILE: Profile = {
  name: "lightweight",
  title: "Lightweight",
  description: "Focused report fixture",
  match: { type: ["FEATURE"] },
  stages: [
    {
      id: "implementation",
      title: "Implementation",
      type: "single",
      role: "developer",
      produces: "implementation",
    },
  ],
};

const FIXTURE: WorkflowV2TestFixture = workflowV2Fixture(PROFILE);

function reportOptions(cwd: string): ReportAssemblyOptions {
  const provider = FIXTURE.effective_policy.provider;
  const policy: WorkflowPolicy = {
    roles: FIXTURE.effective_policy.roles,
    scope_map: [],
    roster_overrides: [],
    flags: {},
    runtime_classes: {},
    ui_classes: {},
    design_system: null,
    commands: FIXTURE.effective_policy.commands,
    workflow: FIXTURE.effective_policy.workflow,
    prompt_context: {},
    required_capabilities: [],
  };
  const document: PolicyDocument = { schema_version: 2, provider, policy };
  const policySnapshot = {
    root: cwd as CanonicalRoot,
    document,
    byte_sha256: FIXTURE.project_identity.config_byte_sha256,
    semantic_sha256: FIXTURE.project_identity.config_semantic_sha256,
    byte_length: 0,
  };
  return {
    policySnapshot,
    effectivePolicy: FIXTURE.effective_policy,
    catalog: FIXTURE.catalog,
    project_identity: FIXTURE.project_identity,
    agentInventory: FIXTURE.agent_inventory,
  };
}

function makeState(fixture: WorkflowV2TestFixture = FIXTURE): TeamState {
  return {
    schema: 1,
    branch: "feature/report",
    project_identity: fixture.project_identity,
    run_identity: fixture.run_identity,
    classification: {
      type: "FEATURE",
      complexity: "QUICK",
      confidence: "HIGH",
      workflow: fixture.profile.name,
      autonomous: false,
    },
    workflow: fixture.profile.name,
    task: "Build the session report",
    workflow_override: false,
    issue: { number: 42 },
    stage_cursor: "implementation",
    cursor_epoch: "report-test-epoch",
    run_key: fixture.run_identity.run_id,
    profile_hash: fixture.profile_identity.fingerprint,
    stages: [{ id: "implementation", status: "in_progress" }],
    artifacts: {},
    pause: { kind: "none", reason: "" },
    updated_at: "2026-08-08T10:00:00.000Z",
  };
}

function writeFeature(cwd: string, id: string, state: TeamState): string {
  const featureDir = join(cwd, ".work-state", "features", id);
  mkdirSync(join(featureDir, "artifacts"), { recursive: true });
  writeFileSync(join(featureDir, "state.json"), JSON.stringify(state, null, 2));
  return featureDir;
}

test("report rejects cwd-only assembly before reading a session", () => {
  const cwd = mkdtempSync(join(tmpdir(), "report-v2-no-context-"));
  try {
    assert.throws(
      () => buildSessionReport(reportStorageFor(cwd), { kind: "do-work" }, {} as ReportAssemblyOptions),
      /MIGRATION_REQUIRED: session reports require/,
    );
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("do-work report uses the catalog-pinned profile and qualified role identity", () => {
  const cwd = mkdtempSync(join(tmpdir(), "report-v2-qualified-"));
  try {
    const options = reportOptions(cwd);
    const state = makeState();
    const featureDir = writeFeature(cwd, "report", state);
    writeFileSync(
      join(featureDir, "artifacts", "implementation.json"),
      JSON.stringify({ type: "implementation", title: "Done" }),
    );

    const report = buildSessionReport(reportStorageFor(cwd), { kind: "do-work", id: "report" }, options);
    assert.equal(report.kind, "do-work");
    assert.equal(report.meta.workflow, "lightweight");
    assert.equal(report.source.isLegacy, false);
    const stage = report.stages.find((candidate) => candidate.id === "implementation");
    assert.equal(stage?.status, "in_progress");
    assert.deepEqual(stage?.agents, [{ name: "developer", role: "developer", source: "workflow" }]);
    assert.equal(report.artifacts.find((artifact) => artifact.id === "implementation")?.status, "produced");
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("report rejects a state whose run identity differs from the admitted context", () => {
  const cwd = mkdtempSync(join(tmpdir(), "report-v2-stale-"));
  try {
    const options = reportOptions(cwd);
    const state = makeState();
    const stale = {
      ...state,
      run_identity: {
        ...state.run_identity,
        run_id: "other-run",
        session: { session_id: "other", lifecycle_id: "other-lifecycle" },
      },
    };
    writeFeature(cwd, "stale", stale);
    assert.throws(
      () => buildSessionReport(reportStorageFor(cwd), { kind: "do-work", id: "stale" }, options),
      /STATE_STALE: do-work state run identity differs/,
    );
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});
test("report rejects a state without a durable workflow run identity", () => {
  const cwd = mkdtempSync(join(tmpdir(), "report-v2-missing-run-"));
  try {
    const withoutRunIdentity = { ...makeState(), run_identity: undefined } as unknown as TeamState;
    writeFeature(cwd, "missing", withoutRunIdentity);
    assert.throws(
      () => buildSessionReport(reportStorageFor(cwd), { kind: "do-work", id: "missing" }, reportOptions(cwd)),
      /MIGRATION_REQUIRED: do-work state has no workflow run identity/,
    );
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});
