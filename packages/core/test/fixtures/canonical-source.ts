import { readFileSync } from "node:fs";
import { join } from "node:path";

import type { CanonicalRunReportSource } from "../../src/report/canonical-source.js";
import type { TeamState } from "../../src/engine/types.js";
import type { CanonicalSessionInput } from "./visualize-fixtures.js";

/**
 * Build an explicit canonical source for fixture materialization.
 *
 * The production path obtains this shape from resolveCanonicalRunSource. The
 * fixture harness keeps the old byte-oriented fixture locations so the
 * security/rendering assertions stay focused on consumer behavior; there is
 * deliberately no discovery or latest/slug resolution here.
 */
export function canonicalSourceFor(cwd: string, input: CanonicalSessionInput): CanonicalRunReportSource {
  if (input.kind !== "feature") {
    throw new Error("migration_required: visualization fixtures require an explicit canonical ordinary run");
  }
  const runDir = join(cwd, ".work-state", "features", input.id);
  const statePath = join(runDir, "state.json");
  const artifactsDir = join(runDir, "artifacts");
  const raw = readFileSync(statePath, "utf8");
  const state = JSON.parse(raw) as TeamState;
  const candidate = {
    run_id: input.id,
    title: state.title ?? state.task,
    task: state.task,
    branch: state.branch,
    status: state.pause?.kind === "done" ? "complete" : "active",
    stage: state.stage_cursor,
    updated_at: state.updated_at,
    rework_generation: state.rework_generation ?? 0,
  } as const;
  return {
    kind: "run",
    id: input.id,
    run_id: input.id,
    revision_id: null,
    statePath,
    artifactsDir,
    read: {
      run_id: input.id,
      candidate,
      state,
      state_path: statePath,
      artifacts_dir: artifactsDir,
    },
  };
}
