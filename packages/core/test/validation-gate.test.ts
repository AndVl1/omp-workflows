/**
 * Validation gate tests (P6).
 *
 * Covers: implementation/review_fixes artifact with full validation
 * (PASS), missing validation_run (REJECT), validation_run: false
 * (REJECT), empty validation_evidence (REJECT), not-ready artifact
 * (REJECT), non-validation-required stage (PASS by default).
 *
 * Also covers runSingle via the public `runStage` path with a stub
 * TaskCaller that writes the artifact under artifactsDir, asserting
 * the gate wires correctly.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  checkArtifact,
  validationGate,
  resolveArtifactsDir,
} from "../src/gates/validation.js";
import { runStage, type TaskCaller, type StageContext } from "../src/engine/stage.js";
import type { StageDef, TeamState } from "../src/engine/types.js";

function withTempDir(): { cwd: string; cleanup: () => void } {
  const cwd = mkdtempSync(join(tmpdir(), "omp-val-"));
  return { cwd, cleanup: () => rmSync(cwd, { recursive: true, force: true }) };
}

function makeState(): TeamState {
  return {
    schema: 1,
    branch: "main",
    classification: { type: "FEATURE", complexity: "QUICK", confidence: "HIGH", workflow: "lightweight", autonomous: false },
    task: "synthetic",
    workflow_override: false,
    issue: null,
    stage_cursor: "implementation",
    stages: [{ id: "implementation", status: "pending" }],
    artifacts: {},
    pause: { kind: "none", reason: "" },
    updated_at: new Date().toISOString(),
  };
}

function makeStageCtx(artifactsDir: string, task: TaskCaller): StageContext {
  return {
    cwd: "/tmp",
    state: makeState(),
    artifactsDir,
    flags: { dev_agent: "developer-go" },
    agent: () => "developer-go",
    task,
    pause: async () => undefined,
    log: () => undefined,
    resolveDevAgent: () => "developer-go",
  };
}

test("validationGate: PASS when implementation artifact has validation_run=true and non-empty evidence", () => {
  const result = checkArtifact("implementation", {
    ready: "true",
    validation_run: "true",
    validation_evidence: "go build ./...: PASS\ngo test ./...: PASS",
  });
  assert.deepEqual(result, { ok: true });
});

test("validationGate: REJECTS when ready is missing", () => {
  const result = checkArtifact("implementation", {
    validation_run: "true",
    validation_evidence: "go build ./...: PASS",
  });
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.reason, /ready/);
});

test("validationGate: REJECTS when validation_run is the string 'false' (escape hatch)", () => {
  const result = checkArtifact("implementation", {
    ready: "true",
    validation_run: "false",
    validation_evidence: "Per assignment, orchestrator owns validation",
  });
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.reason, /validation_run: true/);
});

test("validationGate: REJECTS when validation_evidence is empty", () => {
  const result = checkArtifact("implementation", {
    ready: "true",
    validation_run: "true",
    validation_evidence: "   ",
  });
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.reason, /validation_evidence/);
});

test("validationGate: REJECTS when validation_evidence is missing entirely", () => {
  const result = checkArtifact("implementation", {
    ready: "true",
    validation_run: "true",
  });
  assert.equal(result.ok, false);
});

test("validationGate: accepts boolean true (not just string 'true')", () => {
  const result = checkArtifact("implementation", {
    ready: true,
    validation_run: true,
    validation_evidence: "build: pass; test: pass",
  });
  assert.deepEqual(result, { ok: true });
});

test("validationGate: non-validation-required stage passes by default", () => {
  const result = checkArtifact("discovery", { anything: "goes" });
  assert.deepEqual(result, { ok: true });
});

test("validationGate: review_fixes is also validation-required", () => {
  const result = checkArtifact("review_fixes", {
    ready: "true",
    validation_run: "true",
    validation_evidence: "go test ./...: PASS",
  });
  assert.deepEqual(result, { ok: true });
});

test("validationGate: file-based — reads from artifactsDir and reports missing", () => {
  const { cwd, cleanup } = withTempDir();
  try {
    const artifactsDir = join(cwd, "artifacts");
    mkdirSync(artifactsDir, { recursive: true });
    // No file written
    const result = validationGate({ cwd, stageId: "implementation", artifactsDir });
    assert.equal(result.ok, false);
    if (!result.ok) assert.match(result.reason, /not found/);
  } finally {
    cleanup();
  }
});

test("validationGate: file-based — reads the artifact and validates", () => {
  const { cwd, cleanup } = withTempDir();
  try {
    const artifactsDir = join(cwd, "artifacts");
    mkdirSync(artifactsDir, { recursive: true });
    writeFileSync(
      join(artifactsDir, "implementation.json"),
      JSON.stringify({
        ready: "true",
        validation_run: "true",
        validation_evidence: "go test ./...: ok",
      }),
    );
    const result = validationGate({ cwd, stageId: "implementation", artifactsDir });
    assert.deepEqual(result, { ok: true });
  } finally {
    cleanup();
  }
});

test("validationGate: file-based — malformed JSON is reported", () => {
  const { cwd, cleanup } = withTempDir();
  try {
    const artifactsDir = join(cwd, "artifacts");
    mkdirSync(artifactsDir, { recursive: true });
    writeFileSync(join(artifactsDir, "implementation.json"), "{not json");
    const result = validationGate({ cwd, stageId: "implementation", artifactsDir });
    assert.equal(result.ok, false);
    if (!result.ok) assert.match(result.reason, /not valid JSON/);
  } finally {
    cleanup();
  }
});

test("resolveArtifactsDir: returns legacy artifacts dir when no .active-feature", () => {
  const { cwd, cleanup } = withTempDir();
  try {
    mkdirSync(join(cwd, ".work-state", "artifacts"), { recursive: true });
    const result = resolveArtifactsDir(cwd);
    assert.ok(result, "expected a path");
    assert.ok(result!.endsWith("artifacts"));
  } finally {
    cleanup();
  }
});

test("runStage: runSingle with implementation stage and unvalidated artifact returns failed", async () => {
  const { cwd, cleanup } = withTempDir();
  try {
    const artifactsDir = join(cwd, "artifacts");
    mkdirSync(artifactsDir, { recursive: true });
    // The stub agent returns ready:true but no validation_run.
    const stubTask: TaskCaller = {
      async call() {
        return { id: "t1", output: "ok", artifacts: {}, exitCode: 0 };
      },
      async batch() {
        return [];
      },
    };
    // Simulate the agent having written an unvalidated artifact.
    writeFileSync(
      join(artifactsDir, "implementation.json"),
      JSON.stringify({
        ready: "true",
        validation_run: "false",
        validation_note: "Per assignment, orchestrator owns validation",
      }),
    );
    const stage: StageDef = {
      id: "implementation",
      title: "Implementation",
      type: "single",
      role: "go",
      produces: "implementation",
    };
    const ctx = makeStageCtx(artifactsDir, stubTask);
    const outcome = await runStage(stage, ctx);
    assert.equal(outcome.status, "failed");
    assert.match(outcome.note, /validation_run: true/);
  } finally {
    cleanup();
  }
});

test("runStage: runSingle with validated implementation artifact returns done", async () => {
  const { cwd, cleanup } = withTempDir();
  try {
    const artifactsDir = join(cwd, "artifacts");
    mkdirSync(artifactsDir, { recursive: true });
    writeFileSync(
      join(artifactsDir, "implementation.json"),
      JSON.stringify({
        ready: "true",
        validation_run: "true",
        validation_evidence: "go build ./...: PASS\ngo test ./...: PASS",
      }),
    );
    const stubTask: TaskCaller = {
      async call() {
        return { id: "t1", output: "ok", artifacts: {}, exitCode: 0 };
      },
      async batch() {
        return [];
      },
    };
    const stage: StageDef = {
      id: "implementation",
      title: "Implementation",
      type: "single",
      role: "go",
      produces: "implementation",
    };
    const ctx = makeStageCtx(artifactsDir, stubTask);
    const outcome = await runStage(stage, ctx);
    assert.equal(outcome.status, "done");
  } finally {
    cleanup();
  }
});

test("runStage: non-validation-required stage (discovery) passes regardless of artifact", async () => {
  const { cwd, cleanup } = withTempDir();
  try {
    const artifactsDir = join(cwd, "artifacts");
    mkdirSync(artifactsDir, { recursive: true });
    writeFileSync(
      join(artifactsDir, "discovery.json"),
      JSON.stringify({ anything: "no validation here" }),
    );
    const stubTask: TaskCaller = {
      async call() {
        return { id: "t1", output: "ok", artifacts: {}, exitCode: 0 };
      },
      async batch() {
        return [];
      },
    };
    const stage: StageDef = {
      id: "discovery",
      title: "Discovery",
      type: "single",
      role: "analyst",
      produces: "discovery",
    };
    const ctx = makeStageCtx(artifactsDir, stubTask);
    const outcome = await runStage(stage, ctx);
    assert.equal(outcome.status, "done");
  } finally {
    cleanup();
  }
});

test("runStage: implementation stage where the subagent never wrote the artifact returns failed with explicit reason", async () => {
  const { cwd, cleanup } = withTempDir();
  try {
    const artifactsDir = join(cwd, "artifacts");
    mkdirSync(artifactsDir, { recursive: true });
    // No artifact at all
    const stubTask: TaskCaller = {
      async call() {
        return { id: "t1", output: "ok", artifacts: {}, exitCode: 0 };
      },
      async batch() {
        return [];
      },
    };
    const stage: StageDef = {
      id: "implementation",
      title: "Implementation",
      type: "single",
      role: "go",
      produces: "implementation",
    };
    const ctx = makeStageCtx(artifactsDir, stubTask);
    const outcome = await runStage(stage, ctx);
    assert.equal(outcome.status, "failed");
    assert.match(outcome.note, /not found/);
  } finally {
    cleanup();
  }
});
