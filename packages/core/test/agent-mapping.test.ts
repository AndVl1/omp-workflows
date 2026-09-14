import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AGENT_MAPPING_MAX_BYTES,
  AgentMappingWriteError,
  buildAgentMapping,
  readAgentMapping,
  validateAgentMappingState,
  writeAgentMapping,
} from "../src/engine/agent-mapping.js";
import { PinnedProjectRoot } from "../src/specification/pinned-root.js";

test("agent mapping prefers configured agents and degrades eligible roles to task", () => {
  const mapping = buildAgentMapping({
    roles: {
      "regression-planner": "analyst",
      "regression-executor": "manual-qa",
      "security-tester": "security-tester",
    },
    fallbackChains: {
      "regression-planner": ["analyst", "diagnostics"],
      "regression-executor": ["manual-qa", "qa"],
      "security-tester": ["security-tester"],
    },
    availableAgents: ["task", "qa"],
    genericFallbackRoles: ["regression-planner", "regression-executor"],
  });

  assert.equal(mapping.resolved_roles["regression-planner"], "task");
  assert.equal(mapping.diagnostics["regression-planner"]?.status, "fallback");
  assert.equal(mapping.resolved_roles["regression-executor"], "qa");
  assert.equal(mapping.diagnostics["regression-executor"]?.status, "fallback");
  assert.equal(mapping.resolved_roles["security-tester"], undefined);
  assert.equal(mapping.diagnostics["security-tester"]?.status, "unavailable");
  assert.ok(mapping.unresolved_roles.includes("security-tester"));
});

test("agent mapping writes the exact reader cap and rejects cap+1 without replacement", () => {
  const root = mkdtempSync(join(tmpdir(), "omp-agent-mapping-boundary-"));
  try {
    const base = buildAgentMapping({
      roles: { analyst: "analyst" },
      availableAgents: ["analyst"],
    });
    const withBoundaryProvenance = (variableBytes: number) => ({
      ...base,
      provenance: Object.fromEntries(
        Array.from({ length: 32 }, (_, index) => [
          `extra_${index}`,
          "x".repeat(index === 31 ? variableBytes : 8_170),
        ]),
      ),
    }) as typeof base;
    const zeroVariableBytes = Buffer.byteLength(`${JSON.stringify(withBoundaryProvenance(0))}\n`, "utf8");
    const exactVariableBytes = AGENT_MAPPING_MAX_BYTES - zeroVariableBytes;
    assert.ok(exactVariableBytes >= 0 && exactVariableBytes <= 8_191);
    const exact = withBoundaryProvenance(exactVariableBytes);
    const path = writeAgentMapping(root, exact);
    assert.equal(readFileSync(path).byteLength, AGENT_MAPPING_MAX_BYTES);
    assert.deepEqual(readAgentMapping(root), exact);

    const before = readFileSync(path);
    const oversized = withBoundaryProvenance(exactVariableBytes + 1);
    assert.throws(
      () => writeAgentMapping(root, oversized),
      (error: unknown) => error instanceof AgentMappingWriteError
        && error.code === "limit"
        && error.byteLength === AGENT_MAPPING_MAX_BYTES + 1,
    );
    assert.deepEqual(readFileSync(path), before);
    assert.deepEqual(readAgentMapping(root), exact);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("borrowed pinned root never publishes a mapping into a replaced pathname", () => {
  const root = mkdtempSync(join(tmpdir(), "omp-agent-mapping-pinned-"));
  const replacement = mkdtempSync(join(tmpdir(), "omp-agent-mapping-replacement-"));
  const moved = `${root}-moved`;
  const mapping = buildAgentMapping({ roles: { analyst: "analyst" }, availableAgents: ["analyst"] });
  let swapped = false;
  const pinned = PinnedProjectRoot.open(root, {
    beforeTempOpen: (relativePath) => {
      if (swapped || relativePath !== ".work-state/runtime/agent-mapping.json") return;
      swapped = true;
      renameSync(root, moved);
      renameSync(replacement, root);
    },
  });
  assert.ok(pinned);
  if (!pinned) return;
  try {
    try { writeAgentMapping(root, mapping, pinned); } catch { /* replacement must fail closed */ }
    assert.equal(swapped, true, "the replacement is injected after the final writer check");
    assert.equal(existsSync(join(root, ".work-state", "runtime", "agent-mapping.json")), false, "the replacement pathname stays untouched");
  } finally {
    pinned.close();
    rmSync(moved, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  }
});

test("agent mapping persists atomically and rejects malformed files", () => {
  const root = mkdtempSync(join(tmpdir(), "omp-agent-mapping-"));
  try {
    const mapping = buildAgentMapping({
      roles: { analyst: "analyst" },
      availableAgents: ["analyst"],
    });
    const path = writeAgentMapping(root, mapping);
    assert.equal(JSON.parse(readFileSync(path, "utf8")).schema, 1);
    assert.deepEqual(readAgentMapping(root), mapping);

    writeFileSync(path, "{broken", "utf8");
    assert.equal(readAgentMapping(root), undefined);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("agent mapping validation rejects semantic redirects and incomplete role closure", () => {
  const mapping = buildAgentMapping({
    roles: { analyst: "analyst", reviewer: "reviewer" },
    availableAgents: ["analyst", "reviewer", "task"],
    genericFallbackRoles: ["reviewer"],
  });
  assert.equal(validateAgentMappingState(mapping).ok, true);

  const redirected = structuredClone(mapping);
  redirected.resolved_roles.analyst = "task";
  assert.equal(validateAgentMappingState(redirected).ok, false, "resolved role must remain the first eligible candidate");

  const reorderedCandidates = structuredClone(mapping);
  reorderedCandidates.diagnostics.analyst.candidates = ["task", "analyst"];
  assert.equal(validateAgentMappingState(reorderedCandidates).ok, false, "candidate order determines the resolved agent");

  const requestedChanged = structuredClone(mapping);
  requestedChanged.diagnostics.analyst.requested = "task";
  assert.equal(validateAgentMappingState(requestedChanged).ok, false, "requested role must agree with preferred/fallback status");

  const statusChanged = structuredClone(mapping);
  statusChanged.diagnostics.analyst.status = "fallback";
  assert.equal(validateAgentMappingState(statusChanged).ok, false, "preferred and fallback status are semantic");

  const missingDiagnostic = structuredClone(mapping);
  delete missingDiagnostic.diagnostics.reviewer;
  assert.equal(validateAgentMappingState(missingDiagnostic).ok, false, "every resolved role needs exactly one diagnostic");

  const extraDiagnostic = structuredClone(mapping);
  extraDiagnostic.diagnostics.extra = { requested: "extra", candidates: [], status: "unavailable" };
  assert.equal(validateAgentMappingState(extraDiagnostic).ok, false, "diagnostics cannot introduce roles outside the mapping closure");
});
