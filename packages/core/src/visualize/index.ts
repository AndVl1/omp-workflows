/**
 * Visualize OPT-A — public surface of the workflow visualization modules.
 *
 * Integration seam for the `/workflow-view` fullstack command (architecture-8)
 * and the additive package exports (architecture-9):
 * `packages/core/src/index.ts` re-exports this barrel verbatim
 * (`export * from "./visualize/index.js"`), and core's package.json exposes
 * `@andvl1/omp-workflows-core/visualize` as a subpath export so the barrel's
 * own `SessionKind` / `ArtifactStatus` / `WorkflowName` stay reachable (they
 * differ from the pre-existing report/engine types of the same names and are
 * therefore shadowed at the package root). No convenience aliases are added:
 * the command consumes the granular pipeline below directly, and unshipped
 * API surface is dead weight.
 *
 * The barrel enumerates the frozen module exports EXPLICITLY:
 * - `preflightLinks` is deliberately taken from manifest.ts (the fresh-output
 *   rendered-page link check); markdown.ts exports the same name (snapshot
 *   link-graph check) — the ambiguous name is resolved here, never via
 *   `export *` collisions;
 * - canonical run/revision sources come from report/canonical-source.ts;
 *   callers must resolve an explicit run id (and optional revision) before
 *   building snapshots. Legacy feature/CTO discovery is not a fallback.
 *
 * Everything here is read-only projection: no engine hooks, no agents, no
 * canonical-state mutation, no network.
 */

export * from "./types.js";
export { resolveRenderConfig, type RenderConfig } from "./render-config.js";
export { buildSessionSnapshot, buildSessionSnapshots, type BuildSessionSnapshotOptions } from "./snapshot.js";
export {
  ARTIFACT_HEADING_LEVEL,
  boundedText,
  boundsMarkerOf,
  bodyPreviewMarker,
  artifactHeading,
  artifactMetaNodes,
  clampLevel,
  code,
  exactRenderers,
  h,
  htmlText,
  kv,
  list,
  mdText,
  p,
  parseBoundedJson,
  renderArtifact,
  renderArtifactWithTables,
  renderStatusOnly,
  specRenderers,
  table,
  typedRenderers,
  type ArtifactRenderer,
  type BoundedJsonValue,
  type RenderNode,
  type RenderResult,
  type RendererTables,
  type ResolvedRenderLayer,
} from "./renderer-registry.js";
export { MAX_TABLE_COLUMNS, compactValue, objectTable, renderJsonFallback, renderJsonValue } from "./render-json.js";
export { humanize, renderSpecArtifact, renderTypedArtifact } from "./render-spec.js";
export {
  HUB_ANCHOR,
  HUB_PATH_KEY,
  buildLinkGraph,
  buildLinkRegistry,
  checkLinkGraph,
  renderHubMarkdown,
  renderSessionMarkdown,
  sectionAnchorOf,
  type LinkRegistry,
  type LinkRegistrySession,
  type RenderSessionOptions,
} from "./markdown.js";
export {
  anchorEncode,
  artifactAnchor,
  collectIdsAndHrefs,
  fragmentForStage,
  renderHubHtml,
  renderNode,
  renderSessionHtml,
  semanticSectionForArtifact,
  type CollectedPageLinks,
} from "./html.js";
export { allGeneratedPages, buildManifest, preflightLinks, resolvePageHref, type BuildManifestOptions } from "./manifest.js";
export {
  VisualizePublishError,
  publishVisualize,
  type PublishVisualizeOptions,
  type VisualizeBundleFile,
  type VisualizePublishCounters,
  type VisualizePublishErrorCode,
  type VisualizePublishHooks,
  type VisualizePublishResult,
  type VisualizePublishStatus,
} from "./writer.js";
export {
  listCanonicalRunSources,
  resolveCanonicalRunSource,
  type CanonicalReportSelector,
  type CanonicalRunReportListEntry,
  type CanonicalRunReportSource,
} from "../report/canonical-source.js";
export {
  listCtoSources,
  resolveCtoSource,
  type CtoSessionSource,
  type ResolvedCto,
  type SessionSourceStatus,
} from "../report/session-source.js";
