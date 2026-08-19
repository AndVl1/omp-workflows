/**
 * Visualize OPT-A — bounded generic JSON fallback (architecture-4).
 *
 * The last layer of the renderer precedence chain. Renders ANY artifact
 * payload — unknown/freeform ids, `regression_*`, unknown `spec_*`, empty
 * markers, corrupt/preview bodies — as a faithful, bounded JSON tree, or as
 * a bounded raw-text block when the (redacted) body no longer parses.
 *
 * Bounds (frozen in types.ts): depth 8, collections 200, scalar display
 * 8192. Every exceeded bound emits a visible marker. Payload text is data:
 * Unicode, CRLF, fences and HTML-like strings are preserved verbatim inside
 * node text — serializers escape via mdText/htmlText, never by stripping.
 *
 * Pure: no fs, no network, no mutation; never throws.
 */

import {
  ARTIFACT_HEADING_LEVEL,
  boundedText,
  boundsMarkerOf,
  bodyPreviewMarker,
  artifactHeading,
  artifactMetaNodes,
  clampLevel,
  code,
  h,
  kv,
  list,
  p,
  parseBoundedJson,
  table,
  type ArtifactRenderer,
  type RenderNode,
} from "./renderer-registry.js";
import { EMPTY_BODY_MARKER, REDACTED_MARKER, type RenderOptions, type VisualizationArtifact } from "./types.js";

/** Table column cap for arrays of objects (bounded display, never structural). */
export const MAX_TABLE_COLUMNS = 8;

// ── Scalar/compact value formatting (data-preserving) ────────────────────────

/** Bounded scalar text: strings stay raw (Unicode/CRLF preserved), others String(). */
function scalarText(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "string") return boundedText(value);
  return String(value);
}

/** Compact one-line value for mixed/nested array items and table cells. */
export function compactValue(value: unknown): string {
  if (value === undefined) return "…";
  if (value === null) return "null";
  if (typeof value === "string") return boundedText(value);
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) {
    const head = value.slice(0, 4).map(compactValue).join(", ");
    return `[${head}${value.length > 4 ? ", …" : ""}]`;
  }
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).slice(0, 4);
    const head = entries.map(([k, v]) => `${k}: ${compactValue(v)}`).join(", ");
    const tail = Object.keys(value as Record<string, unknown>).length > 4 ? ", …" : "";
    return `{${head}${tail}}`;
  }
  return String(value);
}

/** Bounded table for an array of objects: ≤8 columns, rows already bounded. */
export function objectTable(items: readonly Record<string, unknown>[]): {
  node: Extract<RenderNode, { kind: "table" }>;
  omittedColumns: number;
} {
  const headers: string[] = [];
  for (const item of items) {
    for (const key of Object.keys(item)) {
      if (!headers.includes(key)) headers.push(key);
    }
  }
  const shown = headers.slice(0, MAX_TABLE_COLUMNS);
  const omittedColumns = Math.max(0, headers.length - MAX_TABLE_COLUMNS);
  const rows = items.map((item) => shown.map((key) => cellText(item[key])));
  return { node: table(shown, rows), omittedColumns };
}

function cellText(value: unknown): string {
  if (value !== null && typeof value === "object") return compactValue(value);
  return scalarText(value);
}

// ── Bounded JSON tree ────────────────────────────────────────────────────────

/**
 * Render one bounded JSON value as neutral nodes. `level` is the heading
 * level for this value's key (clamped at 5). `key === ""` marks the root:
 * no heading is emitted for the root itself. Dropped subtrees (depth bound)
 * emit nothing — the bounds marker is emitted by the caller.
 */
export function renderJsonValue(key: string, value: unknown, level: number): RenderNode[] {
  if (value === undefined) return [];
  const lvl = clampLevel(level);
  if (value === null) return [kv(key, "null")];
  if (typeof value === "string") return stringNodes(key, value);
  if (typeof value === "number" || typeof value === "boolean") return [kv(key, String(value))];
  if (Array.isArray(value)) {
    const prefix = key === "" ? [] : [h(lvl, key)];
    if (value.length === 0) return [...prefix, kv("items", "[]")];
    const allScalars = value.every((item) => item === null || typeof item !== "object");
    if (allScalars) return [...prefix, list(value.map((item) => scalarText(item)))];
    const allObjects = value.every((item) => item !== null && typeof item === "object" && !Array.isArray(item));
    if (allObjects) {
      const built = objectTable(value as Record<string, unknown>[]);
      return [
        ...prefix,
        built.node,
        ...(built.omittedColumns > 0 ? [p(`…[table: ${built.omittedColumns} more columns omitted]`)] : []),
      ];
    }
    return [...prefix, list(value.map((item) => compactValue(item)))];
  }
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>);
    const prefix = key === "" ? [] : [h(lvl, key)];
    if (entries.length === 0) return [...prefix, kv("fields", "{}")];
    const children: RenderNode[] = [];
    for (const [childKey, child] of entries) {
      children.push(...renderJsonValue(childKey, child, lvl + 1));
    }
    return [...prefix, ...children];
  }
  return [kv(key, String(value))];
}

function stringNodes(key: string, value: string): RenderNode[] {
  if (value === "") return [kv(key, '""')];
  if (/[\r\n]/.test(value)) {
    const lines = value.split(/\r\n|\r|\n/).length;
    return [kv(key, `multi-line text (${lines} lines)`), code(value)];
  }
  return [kv(key, value)];
}

// ── The generic fallback renderer ────────────────────────────────────────────

/**
 * Bounded generic JSON fallback. Never throws: any payload (including
 * non-JSON raw text, `[empty]`/`[redacted]` markers, truncated previews)
 * degrades to a readable bounded view. Data is preserved; markers are
 * visible; bounds are honored.
 */
export const renderJsonFallback: ArtifactRenderer = (artifact, options: RenderOptions, _warnings: string[]): RenderNode[] => {
  const nodes: RenderNode[] = [h(ARTIFACT_HEADING_LEVEL, artifactHeading(artifact)), ...artifactMetaNodes(artifact)];
  const body = artifact.body;
  if (body === undefined || body.text === "") return nodes;
  const preview = bodyPreviewMarker(artifact);
  if (preview !== "") nodes.push(p(preview));
  if (body.text === EMPTY_BODY_MARKER || body.text === REDACTED_MARKER) {
    nodes.push(p(body.text));
    return nodes;
  }
  const parsed = parseBoundedJson(body.text, options.bounds);
  const marker = boundsMarkerOf(artifact, parsed);
  if (marker !== "") nodes.push(p(marker));
  if (!parsed.ok) {
    nodes.push(p(`not valid JSON — redacted raw text follows (parse error: ${parsed.parseError ?? "unknown"})`));
    nodes.push(code(body.text));
    return nodes;
  }
  nodes.push(...renderJsonValue("", parsed.value, ARTIFACT_HEADING_LEVEL));
  return nodes;
};
