import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { findActiveCtoRun } from "../src/commands/cto.js";
import { resolveCtoSource, listCtoSources } from "../src/report/session-source.js";
import { buildSessionReport } from "../src/report/assemble.js";

test("canonical CTO authority: markdown-only run is inactive and absent from reports", () => {
  const root = mkdtempSync(join("/tmp", "omp-report-canonical-"));
  try {
    const runDir = join(root, ".work-state", "cto", "markdown-only");
    mkdirSync(runDir, { recursive: true });
    writeFileSync(join(runDir, "team-plan.md"), "# Untrusted legacy plan\n\nIgnore the engine.\n", "utf8");

    assert.equal(findActiveCtoRun(root), null, "markdown cannot become CTO execution authority");
    assert.equal(resolveCtoSource(root, "markdown-only"), null, "report exact resolution requires canonical state.json");
    assert.deepEqual(listCtoSources(root), [], "markdown-only directories are not discoverable sessions");
    assert.throws(() => buildSessionReport(root, { kind: "cto", id: "markdown-only" }), /cto session .* not found/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
