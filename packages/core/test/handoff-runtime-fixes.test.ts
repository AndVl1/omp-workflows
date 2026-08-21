import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildDoWorkPrompt } from "../src/commands/do-work.js";
import { orchestratorWriteGate } from "../src/gates/orchestrator-write.js";

function strictStateRoot(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  mkdirSync(join(root, ".work-state", "artifacts"), { recursive: true });
  writeFileSync(
    join(root, ".work-state", "team-state.json"),
    JSON.stringify({ policy: { strict_orchestrator: true } }),
  );
  return root;
}

test("do-work prompt requires exact dynamic dispatch markers in every role task", () => {
  const root = mkdtempSync(join(tmpdir(), "do-work-dispatch-marker-prompt-"));
  try {
    const prompt = buildDoWorkPrompt(
      { task: "Implement feature", autonomyHint: false, autonomous: false, issue: null, branch: null },
      root,
    );
    assert.match(prompt, /copy the exact `handoff\.dispatch_markers\[\]\.marker` string returned by `workflow_begin` verbatim/i);
    assert.match(prompt, /inside every role-specific `tasks\[\]\.task` payload/i);
    assert.match(prompt, /including the full `<!-- omp-dispatch \.\.\. -->` syntax/i);
    assert.match(prompt, /not only in shared context/i);
    assert.match(prompt, /do not synthesize, transform, normalize, truncate, or otherwise alter/i);
    assert.match(prompt, /if the required marker is unavailable, stop and fail closed/i);
    assert.match(prompt, /exactly the returned roster\/count/i);
    assert.match(prompt, /exactly one task call for each `single` stage and one parallel task batch for each `consilium` stage/i);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("orchestrator gate parses strict nested edit headers and preserves actor boundaries", () => {
  const root = strictStateRoot("orchestrator-edit-header-");
  try {
    const artifactPatch = "[.work-state/artifacts/report.json#B937]\nPUT 1.=1:\n+{}";
    assert.equal(
      orchestratorWriteGate(
        { toolName: "edit", input: { input: artifactPatch } },
        { cwd: root, actor: "orchestrator" },
      ),
      undefined,
      "orchestrators may edit work-state artifacts through the OMP patch wire shape",
    );
    assert.equal(
      orchestratorWriteGate(
        { toolName: "edit", input: artifactPatch },
        { cwd: root, actor: "orchestrator" },
      ),
      undefined,
      "raw edit patch input is accepted only after parsing its strict header",
    );

    const canonicalPatch = "[.work-state/features/handoff/state.json#B937]\nPUT 1.=1:\n+{}";
    const canonicalResult = orchestratorWriteGate(
      { toolName: "edit", input: { input: canonicalPatch } },
      { cwd: root, actor: "orchestrator" },
    );
    assert.equal(canonicalResult?.block, true);
    assert.match(canonicalResult?.reason ?? "", /canonical workflow state/);

    const malformedPatch = "prose mentions [.work-state/artifacts/report.json#B937] but is not an edit header";
    const malformedResult = orchestratorWriteGate(
      { toolName: "edit", input: { input: malformedPatch } },
      { cwd: root, actor: "orchestrator" },
    );
    assert.equal(malformedResult?.block, true);
    assert.match(malformedResult?.reason ?? "", /no verifiable path/);

    const invalidHeaderResult = orchestratorWriteGate(
      { toolName: "edit", input: { input: "[.work-state/artifacts/report.json#B93Z]\nPUT 1.=1:\n+{}" } },
      { cwd: root, actor: "orchestrator" },
    );
    assert.equal(invalidHeaderResult?.block, true);
    assert.match(invalidHeaderResult?.reason ?? "", /no verifiable path/);

    const noHeaderResult = orchestratorWriteGate(
      { toolName: "edit", input: { input: "PUT 1.=1:\n+{}" } },
      { cwd: root, actor: "orchestrator" },
    );
    assert.equal(noHeaderResult?.block, true);

    const workerSourcePatch = "[src/app.ts#B937]\nPUT 1.=1:\n+export {}";
    assert.equal(
      orchestratorWriteGate(
        { toolName: "edit", input: { input: workerSourcePatch } },
        { cwd: root, actor: "worker" },
      ),
      undefined,
      "worker source edits remain allowed for the trusted worker actor",
    );
    const orchestratorSourceResult = orchestratorWriteGate(
      { toolName: "edit", input: { input: workerSourcePatch } },
      { cwd: root, actor: "orchestrator" },
    );
    assert.equal(orchestratorSourceResult?.block, true);
    assert.match(orchestratorSourceResult?.reason ?? "", /may write only under \.work-state/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
