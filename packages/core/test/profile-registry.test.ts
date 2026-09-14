import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync, truncateSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { isRegisteredWorkflow, registerWorkflowProfiles } from "../src/engine/profile.js";
import { openWorkflowActivation, type WorkflowOwnerActivation, type WorkflowOwnerIdentity } from "../src/registry/owner.js";
import type { WorkflowProfile } from "../src/engine/profile.js";
import { openTestRegistry, writeTestRegistryMarker } from "./fixtures/registry-activation.js";

function profile(name: string, schema: string, extra?: Record<string, unknown>): WorkflowProfile;
function profile(name: string, schema: unknown, extra?: Record<string, unknown>): WorkflowProfile;
function profile(name: string, schema: unknown, extra: Record<string, unknown> = {}): WorkflowProfile {
  return {
    name,
    title: "Schema metadata test profile",
    description: "A minimal profile used to exercise strict profile metadata validation.",
    match: { type: ["FEATURE"], complexity: ["QUICK"] },
    stages: [{ id: "run", title: "Run", type: "none" }],
    ...extra,
    "$schema": schema,
  } as WorkflowProfile;
}

function activationOwner(root: string, activation: WorkflowOwnerActivation): WorkflowOwnerIdentity {
  return {
    owner_id: "activation-bounds-test",
    bundle_id: "activation-bounds-test",
    owner_kind: "private_omp",
    activation_marker: activation.marker_id,
    activation,
    host_range: ">=17 <19",
    provenance: { package: "@andvl1/omp-workflows-core", entrypoint: "test", cwd: root },
  };
}

function beginProfileRegistration(name: string): { root: string; token: Parameters<typeof registerWorkflowProfiles>[0]; finish: () => void } {
  const root = mkdtempSync(join(tmpdir(), `omp-profile-schema-${name}-`));
  writeTestRegistryMarker(root);
  const registration = openTestRegistry(root, ["workflow_profiles"], `profile-schema-${name}`);
  return {
    root,
    token: registration.token,
    finish: () => {
      registration.finish(false);
      rmSync(root, { recursive: true, force: true });
    },
  };
}

test("workflow profile registry accepts shipped-style URI/path $schema metadata", () => {
  const registration = beginProfileRegistration("valid");
  try {
    for (const [index, schema] of [["path", "./_schema.json"], ["http", "http://json-schema.org/draft-07/schema#"], ["https", "https://json-schema.org/draft/2020-12/schema"]] as const) {
      const name = `schema-valid-profile-${index}`;
      registerWorkflowProfiles(registration.token, [profile(name, schema)]);
      assert.equal(isRegisteredWorkflow(name), true);
    }
  } finally {
    registration.finish();
  }
});

test("workflow profile registry rejects malformed and non-http schema URIs", () => {
  const registration = beginProfileRegistration("invalid-uri");
  try {
    for (const [index, schema] of [["type", 42], ["percent", "https://%"], ["port", "https://foo:bad"], ["scheme", "ftp://json-schema.org/schema"]] as const) {
      const name = `schema-invalid-profile-${index}`;
      assert.throws(
        () => registerWorkflowProfiles(registration.token, [profile(name, schema)]),
        /profiles\[0\]\.\$schema.*must be a non-empty URI or relative path/u,
      );
    }
  } finally {
    registration.finish();
  }
});

test("workflow profile registry keeps unknown top-level fields rejected", () => {
  const registration = beginProfileRegistration("unknown");
  try {
    assert.throws(
      () => registerWorkflowProfiles(registration.token, [profile("schema-unknown-field-profile", "./_schema.json", { unknown_field: true })]),
      /profiles\[0\]\.unknown_field unknown field/u,
    );
  } finally {
    registration.finish();
  }
});

test("marker loss between profile publications rolls back prior profile cells", () => {
  const registration = beginProfileRegistration("marker-loss");
  const firstName = "marker-loss-first-profile";
  const secondName = "marker-loss-second-profile";
  try {
    registerWorkflowProfiles(registration.token, [profile(firstName, "./_schema.json")]);
    assert.equal(isRegisteredWorkflow(firstName), true);
    unlinkSync(join(registration.root, ".omp-test-registry-marker"));
    assert.throws(
      () => registerWorkflowProfiles(registration.token, [profile(secondName, "./_schema.json")]),
      /(?:activation_markers_missing|ENOENT|requested workflow capability is no longer active)/,
    );
    assert.equal(isRegisteredWorkflow(firstName), false, "marker loss must undo the earlier profile publication");
    assert.equal(isRegisteredWorkflow(secondName), false, "marker loss must prevent later profile visibility");
  } finally {
    try { registration.finish(false); } catch { /* the failed marker revokes the transaction first */ }
    rmSync(registration.root, { recursive: true, force: true });
  }
});


test("activation descriptor rejects oversized marker files before reading or claiming", () => {
  const root = mkdtempSync(join(tmpdir(), "omp-activation-oversized-file-"));
  try {
    const marker = join(root, "marker");
    writeFileSync(marker, "");
    truncateSync(marker, 1024 * 1024 + 1);
    const activation: WorkflowOwnerActivation = {
      marker_id: "activation-bounds-test",
      required: [{ path: "marker", kind: "file" }],
    };
    const result = openWorkflowActivation(root, ["workflow_registration"], activationOwner(root, activation));
    assert.equal(result.ok, false);
    assert.equal(result.code, "activation_markers_missing");
    assert.match(result.error, /exceeds the byte limit/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("activation descriptor rejects too many, duplicate, and overlong UTF-8 requirements before marker I/O", () => {
  const root = mkdtempSync(join(tmpdir(), "omp-activation-descriptor-bounds-"));
  try {
    const tooMany: WorkflowOwnerActivation = {
      marker_id: "activation-bounds-test",
      required: Array.from({ length: 65 }, (_, index) => ({ path: `marker-${index}`, kind: "file" as const })),
    };
    const tooManyResult = openWorkflowActivation(root, ["workflow_registration"], activationOwner(root, tooMany));
    assert.equal(tooManyResult.ok, false);
    assert.equal(tooManyResult.code, "owner_invalid");
    assert.match(tooManyResult.error, /too many requirements/u);

    const duplicate: WorkflowOwnerActivation = {
      marker_id: "activation-bounds-test",
      required: [{ path: "same", kind: "file" }, { path: "same", kind: "file" }],
    };
    const duplicateResult = openWorkflowActivation(root, ["workflow_registration"], activationOwner(root, duplicate));
    assert.equal(duplicateResult.ok, false);
    assert.equal(duplicateResult.code, "owner_invalid");
    assert.match(duplicateResult.error, /duplicate path/u);

    const longMarkerId: WorkflowOwnerActivation = { marker_id: "💥".repeat(1025), required: [{ path: "marker", kind: "file" }] };
    const longIdResult = openWorkflowActivation(root, ["workflow_registration"], activationOwner(root, longMarkerId));
    assert.equal(longIdResult.ok, false);
    assert.equal(longIdResult.code, "owner_invalid");
    assert.match(longIdResult.error, /marker_id.*UTF-8 byte limit/u);

    const longPath: WorkflowOwnerActivation = { marker_id: "activation-bounds-test", required: [{ path: "💥".repeat(1025), kind: "file" }] };
    const longPathResult = openWorkflowActivation(root, ["workflow_registration"], activationOwner(root, longPath));
    assert.equal(longPathResult.ok, false);
    assert.equal(longPathResult.code, "owner_invalid");
    assert.match(longPathResult.error, /path.*UTF-8 byte limit/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
