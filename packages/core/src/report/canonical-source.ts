import { createWorkflowReadSelector, type ReadSelectorContext, type WorkflowRunRead } from "../engine/read-selector.js";
import type { RunCandidate } from "../engine/types.js";

/** Explicit canonical report input. Legacy feature/CTO discovery is never a fallback. */
export interface CanonicalReportSelector {
  run_id: string;
  revision_id?: string;
}

/** Read-only report source backed by the canonical run/revision selector. */
export interface CanonicalRunReportSource {
  kind: "run";
  id: string;
  run_id: string;
  revision_id: string | null;
  statePath: string;
  artifactsDir: string;
  read: WorkflowRunRead;
}

export interface CanonicalRunReportListEntry extends RunCandidate {
  kind: "run";
  revision_id: null;
}

/** Resolve exactly the requested canonical run or immutable revision. */
export function resolveCanonicalRunSource(cwd: string, selector: CanonicalReportSelector, context?: ReadSelectorContext): CanonicalRunReportSource {
  if (!selector || typeof selector.run_id !== "string" || selector.run_id.length === 0) throw new Error("canonical report requires an explicit run_id");
  const read = createWorkflowReadSelector(cwd, context).read(selector.run_id, selector.revision_id);
  return {
    kind: "run",
    id: selector.run_id,
    run_id: read.run_id,
    revision_id: read.revision_id ?? null,
    statePath: read.state_path,
    artifactsDir: read.artifacts_dir,
    read,
  };
}

/** Deterministic status/report index. It never reads legacy feature or CTO state. */
export function listCanonicalRunSources(cwd: string, context?: ReadSelectorContext): CanonicalRunReportListEntry[] {
  return createWorkflowReadSelector(cwd, context).list({ includeTerminal: true }).candidates.map((candidate) => ({ ...candidate, kind: "run" as const, revision_id: null }));
}
