/**
 * Visualize OPT-A — pure renderer registry (architecture-4).
 *
 * Artifact renderer precedence chain (implementation_contract.rendering):
 *
 *   workflow depth policy → exact high-value renderer → spec-family →
 *   22 typed schema ids → payload type match → bounded generic fallback
 *
 * The workflow depth policy (MD-4) has already materialized into the
 * immutable normalized artifact model by the snapshot builder: detailed
 * workflows (spec-preparation) arrive with embedded redacted bodies, compact
 * workflows (bug-fix) and the safe default arrive body-less. This module
 * never re-decides the policy — it renders the body when present and a
 * status-only view when absent.
 *
 * Purity: renderers are fs/network-free and consume only the frozen
 * {@link VisualizationArtifact} data plus {@link RenderOptions} (whose
 * bounds are the frozen DEFAULT_RENDER_BOUNDS under --full as well). They
 * never mutate canonical state, the snapshot, or the artifact.
 *
 * Failure policy: a renderer that throws degrades to the bounded generic
 * fallback and increments a warning. The generic fallback itself is
 * defensive — even a generic failure yields a minimal status-only view, so a
 * session render never aborts.
 *
 * Format safety: renderers emit a neutral, format-independent node model
 * ({@link RenderNode}). Payload text inside nodes is DATA — it is never
 * interpreted as executable markup. The Markdown-safe ({@link mdText}) and
 * HTML-safe ({@link htmlText}) text primitives are the only sanctioned way
 * to place payload text into a serializer; they escape, never strip, the
 * payload. Unicode, CRLF, fences and HTML-like strings survive as data.
 */

import {
  DEFAULT_RENDER_BOUNDS,
  SPEC_FAMILY_IDS,
  TYPED_ARTIFACT_IDS,
  formatBoundsMarker,
  isRegressionId,
  isTypedArtifactId,
  resolveRendererLayer,
  defaultRenderOptions,
  type BoundsOmission,
  type RenderBounds,
  type RendererLayer,
  type RenderOptions,
  type VisualizationArtifact,
} from "./types.js";
import { renderJsonFallback } from "./render-json.js";
import { renderSpecArtifact, renderTypedArtifact } from "./render-spec.js";

// ── Neutral format-independent node model ────────────────────────────────────

/**
 * Neutral render nodes. `text`/`items`/`cells` carry PLAIN TEXT DATA (the
 * redacted payload), never markup. Serializers must emit payload text only
 * through {@link mdText} / {@link htmlText}.
 */
export type RenderNode =
  | { readonly kind: "heading"; readonly level: 1 | 2 | 3 | 4 | 5; readonly text: string }
  | { readonly kind: "paragraph"; readonly text: string }
  | { readonly kind: "list"; readonly items: readonly string[] }
  | { readonly kind: "table"; readonly headers: readonly string[]; readonly rows: readonly string[][] }
  | { readonly kind: "kv"; readonly key: string; readonly value: string }
  | { readonly kind: "code"; readonly text: string };

/** Level of the artifact heading; content sections sit below it. */
export const ARTIFACT_HEADING_LEVEL = 3 as const;

// ── Node factories ───────────────────────────────────────────────────────────

export function h(level: 1 | 2 | 3 | 4 | 5, text: string): RenderNode {
  return { kind: "heading", level, text };
}

/** Clamp a heading level into the node-model range 1–5 (recursion grows it). */
export function clampLevel(level: number): 1 | 2 | 3 | 4 | 5 {
  if (level <= 1) return 1;
  if (level >= 5) return 5;
  return level as 1 | 2 | 3 | 4 | 5;
}

export function p(text: string): RenderNode {
  return { kind: "paragraph", text };
}

export function list(items: readonly string[]): RenderNode {
  return { kind: "list", items: [...items] };
}

export function kv(key: string, value: string): RenderNode {
  return { kind: "kv", key, value };
}

export function table(headers: readonly string[], rows: readonly (readonly string[])[]): Extract<RenderNode, { kind: "table" }> {
  return { kind: "table", headers: [...headers], rows: rows.map((r) => [...r]) };
}

export function code(text: string): RenderNode {
  return { kind: "code", text };
}

// ── Safe text primitives (separate Markdown-safe and HTML-safe) ──────────────

/**
 * Markdown-safe plain text: backslash-escapes every ASCII punctuation that
 * Markdown treats as markup (headings, emphasis, links, code spans, raw
 * HTML, lists, tables). Escaping — never stripping — preserves the payload
 * as data: Unicode, CRLF and fence characters survive verbatim.
 */
export function mdText(value: unknown): string {
  return String(value ?? "").replace(/[\\`*_{}\[\]()#+.!|<>-]/g, "\\$&");
}

/**
 * HTML-safe plain text for text nodes and double-quoted attributes. `&` is
 * escaped first so the other replacements never introduce entities.
 */
export function htmlText(value: unknown): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// ── Bounded JSON parse (depth/collection/scalar bounds) ──────────────────────

export interface BoundedJsonValue {
  /** JSON.parse succeeded (the redacted body may fail — by design). */
  ok: boolean;
  /** Bounded clone of the parsed value; present only when `ok`. */
  value?: unknown;
  /** Visible omission markers when a bound was exceeded. */
  bounds?: BoundsOmission;
  /** JSON.parse error message when `ok: false`. */
  parseError?: string;
}

/**
 * Deterministic bounded parse of artifact body text. Mirrors the snapshot's
 * walk bounds: MAX_DEPTH (8), MAX_COLLECTION_ITEMS (200), MAX_SCALAR_CHARS
 * (8192). Strings are sliced at the scalar bound (so their head stays
 * readable) and every exceeded bound is reported for a visible marker.
 */
export function parseBoundedJson(text: string, bounds: RenderBounds = DEFAULT_RENDER_BOUNDS): BoundedJsonValue {
  let value: unknown;
  try {
    value = JSON.parse(text) as unknown;
  } catch (err) {
    return { ok: false, parseError: err instanceof Error ? err.message : String(err) };
  }
  const counters = { depthTruncated: false, omittedCollections: 0, omittedScalars: 0 };
  const walk = (node: unknown, depth: number): unknown => {
    if (depth > bounds.maxDepth) {
      counters.depthTruncated = true;
      return undefined;
    }
    if (Array.isArray(node)) {
      if (node.length > bounds.maxCollectionItems) counters.omittedCollections += 1;
      return node.slice(0, bounds.maxCollectionItems).map((item) => walk(item, depth + 1));
    }
    if (node !== null && typeof node === "object") {
      const entries = Object.entries(node as Record<string, unknown>);
      if (entries.length > bounds.maxCollectionItems) counters.omittedCollections += 1;
      const out: Record<string, unknown> = {};
      for (const [k, v] of entries.slice(0, bounds.maxCollectionItems)) out[k] = walk(v, depth + 1);
      return out;
    }
    if (typeof node === "string" && node.length > bounds.maxScalarChars) {
      counters.omittedScalars += 1;
      return node.slice(0, bounds.maxScalarChars);
    }
    return node;
  };
  const bounded = walk(value, 1);
  const boundsOut: BoundsOmission | undefined =
    counters.depthTruncated || counters.omittedCollections > 0 || counters.omittedScalars > 0
      ? {
          maxDepth: bounds.maxDepth,
          maxCollectionItems: bounds.maxCollectionItems,
          maxScalarChars: bounds.maxScalarChars,
          depthTruncated: counters.depthTruncated,
          omittedCollections: counters.omittedCollections,
          omittedScalars: counters.omittedScalars,
          marker: formatBoundsMarker(counters.depthTruncated, counters.omittedCollections, counters.omittedScalars),
        }
      : undefined;
  return { ok: true, value: bounded, ...(boundsOut ? { bounds: boundsOut } : {}) };
}

/** Defensive scalar display bound for any model-provided text. */
export function boundedText(value: unknown, bounds: RenderBounds = DEFAULT_RENDER_BOUNDS): string {
  const s = String(value ?? "");
  return s.length > bounds.maxScalarChars ? s.slice(0, bounds.maxScalarChars) : s;
}

// ── Shared artifact scaffolding ──────────────────────────────────────────────

/** Artifact heading text — stable identity, never raw payload text. */
export function artifactHeading(artifact: VisualizationArtifact): string {
  return artifact.slotFor !== undefined ? `${artifact.id} (slot of ${artifact.slotFor})` : artifact.id;
}

/** Status/type/slot/reason metadata lines shown for every artifact. */
export function artifactMetaNodes(artifact: VisualizationArtifact): RenderNode[] {
  const nodes: RenderNode[] = [kv("status", artifact.status)];
  if (artifact.slotFor !== undefined) nodes.push(kv("consilium slot of", artifact.slotFor));
  if (artifact.type !== undefined) nodes.push(kv("type", artifact.type));
  if (artifact.errorCategory !== undefined) nodes.push(kv("reason", artifact.errorCategory));
  return nodes;
}

/** Visible preview/truncation marker from the redacted body ("" when none). */
export function bodyPreviewMarker(artifact: VisualizationArtifact): string {
  const body = artifact.body;
  return body !== undefined && body.marker !== "" ? body.marker : "";
}

/**
 * Visible bounds marker: the model's own marker wins (authoritative — it
 * walked the original content); otherwise the render-time parse marker.
 */
export function boundsMarkerOf(artifact: VisualizationArtifact, parsed?: BoundedJsonValue): string {
  if (artifact.bounds !== undefined && artifact.bounds.marker !== "") return artifact.bounds.marker;
  return parsed?.bounds?.marker ?? "";
}

/**
 * Status-only view for artifacts without a body (missing/pending/skipped/
 * unreadable, or produced under a compact depth policy). Never throws.
 */
export function renderStatusOnly(artifact: VisualizationArtifact): RenderNode[] {
  const nodes: RenderNode[] = [h(ARTIFACT_HEADING_LEVEL, artifactHeading(artifact)), ...artifactMetaNodes(artifact)];
  if (artifact.summary !== undefined && artifact.summary !== "") {
    nodes.push(p(boundedText(artifact.summary)));
  }
  if (artifact.keys !== undefined && artifact.keys.length > 0) {
    nodes.push(h(4, "Fields"));
    nodes.push(list(artifact.keys));
  }
  return nodes;
}

// ── Renderer table and dispatch ──────────────────────────────────────────────

/**
 * A renderer consumes only the immutable artifact plus render options and
 * returns neutral nodes. Renderers MAY push failure/warning notes into
 * `warnings` (owned by the caller) but must never throw (the registry
 * catches any throw and degrades).
 */
export type ArtifactRenderer = (
  artifact: VisualizationArtifact,
  options: RenderOptions,
  warnings: string[],
) => RenderNode[];

/** The renderer tables per layer. `exact` is the reserved v1 slot. */
export interface RendererTables {
  exact: Readonly<Record<string, ArtifactRenderer>>;
  spec: Readonly<Record<string, ArtifactRenderer>>;
  typed: Readonly<Record<string, ArtifactRenderer>>;
}

/**
 * Reserved exact-layer renderers, keyed by artifact id. v1 registers none;
 * the table is exported so a future slice (or a test) can register a
 * high-value renderer that outranks the spec-family layer:
 * `exactRenderers[artifact.id] = renderer`.
 */
export const exactRenderers: Record<string, ArtifactRenderer> = {};

/** The 7 known spec-preparation ids → the structured spec renderer. */
export const specRenderers: Readonly<Record<string, ArtifactRenderer>> = Object.fromEntries(
  SPEC_FAMILY_IDS.map((id) => [id, renderSpecArtifact]),
);

/** All 22 typed schema ids → the structured schema renderer. */
export const typedRenderers: Readonly<Record<string, ArtifactRenderer>> = Object.fromEntries(
  TYPED_ARTIFACT_IDS.map((id) => [id, renderTypedArtifact]),
);

const DEFAULT_TABLES: RendererTables = { exact: exactRenderers, spec: specRenderers, typed: typedRenderers };

/** Layer that actually produced the nodes (frozen vocabulary minus workflow-depth). */
export type ResolvedRenderLayer = Exclude<RendererLayer, "workflow-depth">;

export interface RenderResult {
  nodes: RenderNode[];
  layer: ResolvedRenderLayer;
}

/** Warning raised when a layer renderer throws (never aborts a session). */
function rendererWarning(layer: string, artifactId: string, err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  return `renderer ${layer} failed for artifact "${artifactId}": ${message}; degraded to generic fallback`;
}

/**
 * Payload type match: a freeform/unknown artifact whose payload declares a
 * known typed schema kind (`artifact_type` in the 22 typed ids) is rendered
 * by that typed schema renderer. `regression_*` ids skip this — they are
 * always generic per the frozen contract.
 */
function payloadTypeOf(artifact: VisualizationArtifact, options: RenderOptions): string | undefined {
  if (artifact.body === undefined) return undefined;
  const parsed = parseBoundedJson(artifact.body.text, options.bounds);
  if (!parsed.ok || parsed.value === null || typeof parsed.value !== "object" || Array.isArray(parsed.value)) {
    return undefined;
  }
  const declared = (parsed.value as Record<string, unknown>).artifact_type;
  return typeof declared === "string" && isTypedArtifactId(declared) ? declared : undefined;
}

/**
 * Full precedence dispatch (test seam: injects the renderer tables).
 *
 * Order: exact → spec-family (7 known ids; unknown spec_* fall through) →
 * 22 typed schema ids → payload type match (non-regression freeform ids) →
 * bounded generic JSON fallback. Every throw degrades one layer down and
 * increments a warning; the final generic layer cannot abort.
 */
export function renderArtifactWithTables(
  artifact: VisualizationArtifact,
  tables: RendererTables,
  options: RenderOptions,
  warnings: string[],
): RenderResult {
  // Workflow depth policy has materialized into the immutable model: compact
  // policies arrive without a body. Nothing to parse — status-only view.
  if (artifact.body === undefined || artifact.body.text === "") {
    return { nodes: renderStatusOnly(artifact), layer: resolveRendererLayer(artifact.id) };
  }

  // 1. Reserved exact high-value renderer (v1: none registered).
  const exact = tables.exact[artifact.id];
  if (exact !== undefined) {
    try {
      return { nodes: exact(artifact, options, warnings), layer: "exact" };
    } catch (err) {
      warnings.push(rendererWarning("exact", artifact.id, err));
    }
  }

  // 2. Spec-family: the 7 known spec-preparation ids. Unknown spec_* ids are
  //    absent from the table and fall through to payload type match/generic.
  if (resolveRendererLayer(artifact.id) === "spec-family") {
    const spec = tables.spec[artifact.id];
    if (spec !== undefined) {
      try {
        return { nodes: spec(artifact, options, warnings), layer: "spec-family" };
      } catch (err) {
        warnings.push(rendererWarning("spec-family", artifact.id, err));
      }
    }
  }

  // 3. The 22 typed schema ids.
  const typed = tables.typed[artifact.id];
  if (typed !== undefined) {
    try {
      return { nodes: typed(artifact, options, warnings), layer: "typed-schema" };
    } catch (err) {
      warnings.push(rendererWarning("typed-schema", artifact.id, err));
    }
  }

  // 4. Payload type match for freeform/unknown ids (never for regression_*).
  if (!isRegressionId(artifact.id)) {
    const declared = payloadTypeOf(artifact, options);
    if (declared !== undefined) {
      const byType = tables.typed[declared];
      if (byType !== undefined) {
        try {
          return { nodes: byType(artifact, options, warnings), layer: "typed-schema" };
        } catch (err) {
          warnings.push(rendererWarning(`typed-schema (payload type ${declared})`, artifact.id, err));
        }
      }
    }
  }

  // 5. Bounded generic JSON fallback — defensive: even this never aborts.
  try {
    return { nodes: renderJsonFallback(artifact, options, warnings), layer: "generic-fallback" };
  } catch (err) {
    warnings.push(rendererWarning("generic-fallback", artifact.id, err));
    return {
      nodes: [
        h(ARTIFACT_HEADING_LEVEL, artifactHeading(artifact)),
        ...artifactMetaNodes(artifact),
        p("renderer failure; showing status only"),
      ],
      layer: "generic-fallback",
    };
  }
}

/**
 * Render one artifact through the default precedence chain. Pure: returns
 * nodes and appends any new warnings (renderer failures) to the caller-owned
 * `warnings` array; never mutates the artifact or the snapshot. When
 * `warnings` is omitted a fresh array is used — pass your own to collect
 * the increments.
 */
export function renderArtifact(
  artifact: VisualizationArtifact,
  options: RenderOptions = defaultRenderOptions(),
  warnings: string[] = [],
): RenderResult {
  return renderArtifactWithTables(artifact, DEFAULT_TABLES, options, warnings);
}
