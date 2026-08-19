/**
 * Visualize OPT-A — render configuration (architecture-3).
 *
 * Deterministic per-workflow render configuration consumed by the snapshot
 * builder (snapshot.ts). Pure — no fs, no model construction. The vocabulary
 * (depth policies, bounds, caps) is frozen in types.ts; this module only
 * resolves a workflow name into the effective render options and the body
 * embedding decision (MD-4):
 *
 * - spec-preparation → `detailed` (bodies enabled by default);
 * - bug-fix → `compact` (bodies disabled by default);
 * - any unlisted workflow → the explicit safe `default` (bodies disabled).
 *
 * `--full` raises the bounded body cap and read window but NEVER disables
 * redaction and never changes the depth/collection/scalar bounds (AC-3).
 */

import {
  defaultRenderOptions,
  depthPolicyBehavior,
  depthPolicyFor,
  type DepthPolicy,
  type RenderOptions,
  type WorkflowName,
} from "./types.js";

/**
 * Effective render configuration for one session.
 *
 * `bodiesEnabled` is the body-embedding decision: `bodiesByDefault` for the
 * workflow's depth policy OR `--full`. Independent of `--full`, redaction
 * always applies before the body cap (the snapshot's body builder enforces
 * that; this flag only selects whether a body is embedded at all).
 */
export interface RenderConfig {
  workflow: WorkflowName;
  depthPolicy: DepthPolicy;
  /** True → embedded redacted bodies are produced for produced artifacts. */
  bodiesEnabled: boolean;
  options: RenderOptions;
}

/**
 * Resolve the deterministic render config for a workflow.
 *
 * Deterministic for identical inputs; never touches the filesystem.
 */
export function resolveRenderConfig(workflow: WorkflowName, full = false): RenderConfig {
  const depthPolicy = depthPolicyFor(workflow);
  const options = defaultRenderOptions(full);
  return {
    workflow,
    depthPolicy,
    bodiesEnabled: depthPolicyBehavior(depthPolicy).bodiesByDefault || full,
    options,
  };
}
