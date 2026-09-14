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
  FULL_BODY_CAP_BYTES,
  FULL_READ_WINDOW_BYTES,
  MAX_COLLECTION_ITEMS,
  MAX_DEPTH,
  MAX_SCALAR_CHARS,
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
import {
  createRegistryRegistrationLiveGuard,
  recordRegistryUndo,
  registryRegistrationPrincipal,
  requireRegistryRegistration,
  type RegistryContextSnapshot,
  type RegistryRegistrationPrincipal,
  type RegistryRegistrationToken,
} from "../registry/owner.js";

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
      const out: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
      for (const [k, v] of entries.slice(0, bounds.maxCollectionItems)) {
        Object.defineProperty(out, k, { value: walk(v, depth + 1), enumerable: true, configurable: true, writable: true });
      }
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


export type ArtifactRenderLayer = "exact" | "spec" | "typed";

interface RendererLease {
  readonly principal: RegistryRegistrationPrincipal;
  readonly token: RegistryRegistrationToken;
  readonly liveGuard: () => RegistryContextSnapshot;
}
interface RendererCell {
  readonly principal: RegistryRegistrationPrincipal;
  readonly principal_fingerprint: RegistryRegistrationPrincipal;
  readonly descriptor_fingerprint: string;
  readonly metadata: Readonly<{ layer: ArtifactRenderLayer; artifact_id: string }>;
  readonly renderer: ArtifactRenderer;
  readonly leases: Set<RendererLease>;
}

/** The renderer tables per layer. Callers receive frozen snapshots only. */
export interface RendererTables {
  exact: Readonly<Record<string, ArtifactRenderer>>;
  spec: Readonly<Record<string, ArtifactRenderer>>;
  typed: Readonly<Record<string, ArtifactRenderer>>;
}

const BUILTIN_PRINCIPAL = Object.freeze(Object.create(null)) as RegistryRegistrationPrincipal;
const rendererCells: Record<ArtifactRenderLayer, Map<string, RendererCell>> = {
  exact: new Map(),
  spec: new Map(),
  typed: new Map(),
};

function descriptorFingerprint(layer: ArtifactRenderLayer, artifactId: string): string {
  return `${layer}\u0000${artifactId}`;
}

function cell(
  principal: RegistryRegistrationPrincipal,
  layer: ArtifactRenderLayer,
  artifactId: string,
  renderer: ArtifactRenderer,
): RendererCell {
  return Object.freeze({
    principal,
    principal_fingerprint: principal,
    descriptor_fingerprint: descriptorFingerprint(layer, artifactId),
    metadata: Object.freeze({ layer, artifact_id: artifactId }),
    renderer,
    leases: new Set<RendererLease>(),
  });
}

function seedBuiltins(): void {
  for (const id of SPEC_FAMILY_IDS) rendererCells.spec.set(id, cell(BUILTIN_PRINCIPAL, "spec", id, renderSpecArtifact));
  for (const id of TYPED_ARTIFACT_IDS) rendererCells.typed.set(id, cell(BUILTIN_PRINCIPAL, "typed", id, renderTypedArtifact));
}

function snapshot(layer: ArtifactRenderLayer): Readonly<Record<string, ArtifactRenderer>> {
  const table = Object.create(null) as Record<string, ArtifactRenderer>;
  for (const [id, registered] of rendererCells[layer]) table[id] = registered.renderer;
  return Object.freeze(table);
}

seedBuiltins();

/** Frozen diagnostic snapshots; registration never exposes a mutable table. */
export const exactRenderers: Readonly<Record<string, ArtifactRenderer>> = snapshot("exact");
export const specRenderers: Readonly<Record<string, ArtifactRenderer>> = snapshot("spec");
export const typedRenderers: Readonly<Record<string, ArtifactRenderer>> = snapshot("typed");
let DEFAULT_TABLES: RendererTables = { exact: exactRenderers, spec: specRenderers, typed: typedRenderers };

function refreshSnapshots(): void {
  DEFAULT_TABLES = { exact: snapshot("exact"), spec: snapshot("spec"), typed: snapshot("typed") };
}

const MAX_RENDERER_LEASES_PER_CELL = 4;
function sweepRendererLeases(): boolean {
  let changed = false;
  for (const layer of ["exact", "spec", "typed"] as const) {
    const table = rendererCells[layer];
    for (const [id, cell] of table) {
      for (const lease of [...cell.leases]) {
        try { lease.liveGuard(); } catch { cell.leases.delete(lease); changed = true; }
      }
      if (cell.leases.size === 0 && cell.principal !== BUILTIN_PRINCIPAL) {
        table.delete(id);
        changed = true;
      }
    }
  }
  return changed;
}
function hasRendererLease(cell: RendererCell, token: RegistryRegistrationToken): boolean {
  return [...cell.leases].some((lease) => lease.token === token);
}
function addRendererLease(cell: RendererCell, token: RegistryRegistrationToken, principal: RegistryRegistrationPrincipal): RendererLease {
  const existing = [...cell.leases].find((lease) => lease.token === token);
  if (existing) return existing;
  if (cell.leases.size >= MAX_RENDERER_LEASES_PER_CELL) throw registrationError("registry_transaction_invalid", "renderer activation leases are bounded at 4 per descriptor");
  const lease: RendererLease = Object.freeze({ principal, token, liveGuard: createRegistryRegistrationLiveGuard(token, "visual_renderers") });
  cell.leases.add(lease);
  return lease;
}
function removeRendererLease(cell: RendererCell, lease: RendererLease): void {
  cell.leases.delete(lease);
}

function registrationError(code: "owner_conflict" | "registry_transaction_invalid", error: string): Error & { code: string } {
  const failure = new Error(error) as Error & { code: string };
  failure.code = code;
  return failure;
}

/**
 * Register one renderer cell under the authenticated visual-renderer
 * transaction. Built-in cells are permanently reserved; duplicate writes by
 * the same owner are idempotent only when the descriptor and function ref
 * are identical. The owner transaction supplies exact-cell rollback.
 */
export function registerArtifactRenderer(
  token: RegistryRegistrationToken,
  layer: ArtifactRenderLayer,
  artifactId: string,
  renderer: ArtifactRenderer,
): void {
  requireRegistryRegistration(token, "visual_renderers");
  if (layer !== "exact" && layer !== "spec" && layer !== "typed") {
    throw registrationError("registry_transaction_invalid", "renderer layer is invalid");
  }
  if (typeof artifactId !== "string" || artifactId.length === 0 || artifactId.length > 256 || /[\u0000-\u001f\u007f]/u.test(artifactId)) {
    throw registrationError("registry_transaction_invalid", "renderer artifact id is invalid");
  }
  if (typeof renderer !== "function") {
    throw registrationError("registry_transaction_invalid", "renderer must be a function");
  }
  const changed = sweepRendererLeases();
  if (changed) refreshSnapshots();
  const principal = registryRegistrationPrincipal(token, "visual_renderers");
  const existing = rendererCells[layer].get(artifactId);
  const descriptor = descriptorFingerprint(layer, artifactId);
  if (existing) {
    const sameDescriptor = existing.descriptor_fingerprint === descriptor && existing.renderer === renderer;
    if (sameDescriptor) {
      if (hasRendererLease(existing, token)) return;
      let lease: RendererLease | undefined;
      recordRegistryUndo(token, () => { if (lease) removeRendererLease(existing, lease); });
      lease = addRendererLease(existing, token, principal);
      return;
    }
    if (existing.principal === BUILTIN_PRINCIPAL || existing.leases.size > 0) {
      throw registrationError("owner_conflict", `renderer cell '${layer}:${artifactId}' is already owned and cannot be replaced`);
    }
    const inserted = cell(principal, layer, artifactId, renderer);
    let lease: RendererLease | undefined;
    recordRegistryUndo(token, () => {
      if (lease) removeRendererLease(inserted, lease);
      if (rendererCells[layer].get(artifactId) === inserted) {
        rendererCells[layer].set(artifactId, existing);
        refreshSnapshots();
      }
    });
    lease = addRendererLease(inserted, token, principal);
    rendererCells[layer].set(artifactId, inserted);
    refreshSnapshots();
    return;
  }
  const table = rendererCells[layer];
  if (table.size >= 32) throw registrationError("registry_transaction_invalid", "renderer registry is bounded at 32 cells");
  const inserted = cell(principal, layer, artifactId, renderer);
  let lease: RendererLease | undefined;
  recordRegistryUndo(token, () => {
    if (lease) removeRendererLease(inserted, lease);
    if (table.get(artifactId) === inserted) {
      table.delete(artifactId);
      refreshSnapshots();
    }
  });
  lease = addRendererLease(inserted, token, principal);
  table.set(artifactId, inserted);
  refreshSnapshots();
}

function rendererFor(table: Readonly<Record<string, ArtifactRenderer>>, id: string): ArtifactRenderer | undefined {
  return Object.hasOwn(table, id) ? table[id] : undefined;
}

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

// Renderer code is bundle-owned but still runs at the untrusted visualization
// boundary. Detach every returned node and enforce serializer-safe ceilings
// before any renderer output becomes visible to Markdown or HTML.
const MAX_RENDER_NODES = 4_096;
const MAX_RENDER_TEXT_BYTES = 64 * 1024;
const MAX_RENDER_TEXT_TOTAL_BYTES = 1 * 1024 * 1024;
const MAX_RENDER_LIST_ITEMS = 256;
const MAX_RENDER_TABLE_COLUMNS = 32;
const MAX_RENDER_TABLE_ROWS = 256;

function renderOutputError(message: string): never {
  throw new Error(`renderer output is invalid: ${message}`);
}

function plainRecord(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return renderOutputError("node must be a plain object");
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return renderOutputError("node prototype is invalid");
  return value as Record<string, unknown>;
}

function dataProperty(record: Record<string, unknown>, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(record, key);
  if (!descriptor || !Object.hasOwn(descriptor, "value")) return renderOutputError(`node property '${key}' must be a data property`);
  return descriptor.value;
}

function exactNodeKeys(record: Record<string, unknown>, keys: readonly string[]): void {
  const actual = Object.keys(record).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) renderOutputError("node has unknown or missing properties");
}

function renderText(value: unknown, label: string, total: { bytes: number }): string {
  if (typeof value !== "string") return renderOutputError(`${label} must be a string`);
  const bytes = Buffer.byteLength(value, "utf8");
  if (bytes > MAX_RENDER_TEXT_BYTES) return renderOutputError(`${label} exceeds ${MAX_RENDER_TEXT_BYTES} UTF-8 bytes`);
  total.bytes += bytes;
  if (total.bytes > MAX_RENDER_TEXT_TOTAL_BYTES) return renderOutputError(`text exceeds ${MAX_RENDER_TEXT_TOTAL_BYTES} UTF-8 bytes`);
  return value;
}

function renderTextArray(value: unknown, label: string, maxItems: number, total: { bytes: number }): string[] {
  if (!Array.isArray(value) || value.length > maxItems) return renderOutputError(`${label} exceeds ${maxItems} items`);
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Array.prototype && prototype !== null) return renderOutputError(`${label} array prototype is invalid`);
  const result: string[] = [];
  for (let index = 0; index < value.length; index += 1) {
    if (!Object.hasOwn(value, index)) return renderOutputError(`${label} must not be sparse`);
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor || !Object.hasOwn(descriptor, "value")) return renderOutputError(`${label}[${index}] must be a data property`);
    result.push(renderText(descriptor.value, `${label}[${index}]`, total));
  }
  if (Object.keys(value).some((key) => !/^\d+$/u.test(key) || Number(key) >= value.length)) return renderOutputError(`${label} has unknown properties`);
  return result;
}

function boundedArtifactText(value: unknown, label: string, maxBytes = MAX_RENDER_TEXT_BYTES): string {
  if (typeof value !== "string") return renderOutputError(`${label} must be a string`);
  if (Buffer.byteLength(value, "utf8") > maxBytes) return renderOutputError(`${label} exceeds ${maxBytes} UTF-8 bytes`);
  return value;
}

function boundedArtifactNumber(value: unknown, label = "number", max = Number.MAX_SAFE_INTEGER): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0 || value > max) return renderOutputError(`${label} must be a bounded non-negative integer`);
  return value;
}

function detachedRendererArtifact(input: VisualizationArtifact): VisualizationArtifact {
  const record = plainRecord(input);
  const result: VisualizationArtifact = {
    id: boundedArtifactText(dataProperty(record, "id"), "artifact id"),
    owner: boundedArtifactText(dataProperty(record, "owner"), "artifact owner"),
    status: boundedArtifactText(dataProperty(record, "status"), "artifact status") as VisualizationArtifact["status"],
  };
  const optionalText = (key: "slotFor" | "type" | "summary" | "errorCategory", maxBytes = MAX_RENDER_TEXT_BYTES): void => {
    if (Object.hasOwn(record, key)) {
      const value = dataProperty(record, key);
      if (value !== undefined) (result as unknown as Record<string, unknown>)[key] = boundedArtifactText(value, `artifact ${key}`, maxBytes);
    }
  };
  optionalText("slotFor");
  optionalText("type");
  optionalText("summary");
  optionalText("errorCategory");
  if (Object.hasOwn(record, "bytes")) {
    const value = dataProperty(record, "bytes");
    if (value !== undefined) (result as unknown as Record<string, unknown>).bytes = boundedArtifactNumber(value, "artifact bytes");
  }
  if (Object.hasOwn(record, "keys")) {
    const value = dataProperty(record, "keys");
    if (value !== undefined) {
      const keys = renderTextArray(value, "artifact keys", MAX_COLLECTION_ITEMS, { bytes: 0 });
      (result as unknown as Record<string, unknown>).keys = Object.freeze(keys);
    }
  }
  if (Object.hasOwn(record, "source")) {
    const sourceValue = dataProperty(record, "source");
    if (sourceValue !== undefined) {
      const source = plainRecord(sourceValue);
      exactNodeKeys(source, ["kind", "label", "bytes", "readBytes", "readWindowBytes", "format"]);
      (result as unknown as Record<string, unknown>).source = Object.freeze({
        kind: boundedArtifactText(dataProperty(source, "kind"), "source kind", 64),
        label: boundedArtifactText(dataProperty(source, "label"), "source label", 4096),
        bytes: boundedArtifactNumber(dataProperty(source, "bytes"), "source bytes"),
        readBytes: boundedArtifactNumber(dataProperty(source, "readBytes"), "source read bytes"),
        readWindowBytes: boundedArtifactNumber(dataProperty(source, "readWindowBytes"), "source read window", FULL_READ_WINDOW_BYTES),
        format: boundedArtifactText(dataProperty(source, "format"), "source format", 64),
      });
    }
  }
  if (Object.hasOwn(record, "body")) {
    const bodyValue = dataProperty(record, "body");
    if (bodyValue !== undefined) {
      const body = plainRecord(bodyValue);
      exactNodeKeys(body, ["text", "truncated", "originalBytes", "capBytes", "preview", "marker"]);
      (result as unknown as Record<string, unknown>).body = Object.freeze({
        text: boundedArtifactText(dataProperty(body, "text"), "artifact body", FULL_BODY_CAP_BYTES),
        truncated: dataProperty(body, "truncated") === true,
        originalBytes: boundedArtifactNumber(dataProperty(body, "originalBytes"), "body original bytes"),
        capBytes: boundedArtifactNumber(dataProperty(body, "capBytes"), "body cap", FULL_BODY_CAP_BYTES),
        preview: dataProperty(body, "preview") === true,
        marker: boundedArtifactText(dataProperty(body, "marker"), "artifact body marker"),
      });
    }
  }
  if (Object.hasOwn(record, "bounds")) {
    const boundsValue = dataProperty(record, "bounds");
    if (boundsValue !== undefined) {
      const bounds = plainRecord(boundsValue);
      exactNodeKeys(bounds, ["maxDepth", "maxCollectionItems", "maxScalarChars", "depthTruncated", "omittedCollections", "omittedScalars", "marker"]);
      (result as unknown as Record<string, unknown>).bounds = Object.freeze({
        maxDepth: boundedArtifactNumber(dataProperty(bounds, "maxDepth"), "bounds max depth", MAX_DEPTH),
        maxCollectionItems: boundedArtifactNumber(dataProperty(bounds, "maxCollectionItems"), "bounds max collection", MAX_COLLECTION_ITEMS),
        maxScalarChars: boundedArtifactNumber(dataProperty(bounds, "maxScalarChars"), "bounds max scalar", MAX_SCALAR_CHARS),
        depthTruncated: dataProperty(bounds, "depthTruncated") === true,
        omittedCollections: boundedArtifactNumber(dataProperty(bounds, "omittedCollections"), "bounds omitted collections"),
        omittedScalars: boundedArtifactNumber(dataProperty(bounds, "omittedScalars"), "bounds omitted scalars"),
        marker: boundedArtifactText(dataProperty(bounds, "marker"), "bounds marker"),
      });
    }
  }
  return Object.freeze(result);
}

function detachedRendererOptions(input: RenderOptions): RenderOptions {
  const record = plainRecord(input);
  const bounds = plainRecord(dataProperty(record, "bounds"));
  exactNodeKeys(bounds, ["maxDepth", "maxCollectionItems", "maxScalarChars"]);
  return Object.freeze({
    full: dataProperty(record, "full") === true,
    bodyCapBytes: boundedArtifactNumber(dataProperty(record, "bodyCapBytes"), "body cap", FULL_BODY_CAP_BYTES),
    readWindowBytes: boundedArtifactNumber(dataProperty(record, "readWindowBytes"), "read window", FULL_READ_WINDOW_BYTES),
    bounds: Object.freeze({
      maxDepth: boundedArtifactNumber(dataProperty(bounds, "maxDepth"), "render max depth", MAX_DEPTH),
      maxCollectionItems: boundedArtifactNumber(dataProperty(bounds, "maxCollectionItems"), "render max collection", MAX_COLLECTION_ITEMS),
      maxScalarChars: boundedArtifactNumber(dataProperty(bounds, "maxScalarChars"), "render max scalar", MAX_SCALAR_CHARS),
    }),
  });
}

const MAX_RENDERER_CALLBACK_WARNINGS = 128;
function invokeRenderer(renderer: ArtifactRenderer, artifact: VisualizationArtifact, options: RenderOptions, warnings: string[]): RenderNode[] {
  const rendererWarnings: string[] = [];
  const nodes = renderer(detachedRendererArtifact(artifact), detachedRendererOptions(options), rendererWarnings);
  for (const warning of rendererWarnings.slice(0, MAX_RENDERER_CALLBACK_WARNINGS)) {
    if (typeof warning === "string" && Buffer.byteLength(warning, "utf8") <= MAX_RENDER_TEXT_BYTES) warnings.push(warning);
  }
  return detachedRenderNodes(nodes);
}

function detachedRenderNodes(value: unknown): RenderNode[] {
  if (!Array.isArray(value)) return renderOutputError("result must be an array");
  if (value.length > MAX_RENDER_NODES) return renderOutputError(`result exceeds ${MAX_RENDER_NODES} nodes`);
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Array.prototype && prototype !== null) return renderOutputError("result array prototype is invalid");
  const total = { bytes: 0 };
  const result: RenderNode[] = [];
  for (let index = 0; index < value.length; index += 1) {
    if (!Object.hasOwn(value, index)) return renderOutputError("result must not be sparse");
    const node = plainRecord(dataProperty(value as unknown as Record<string, unknown>, String(index)));
    const kind = dataProperty(node, "kind");
    if (kind === "heading") {
      exactNodeKeys(node, ["kind", "level", "text"]);
      const level = dataProperty(node, "level");
      if (typeof level !== "number" || !Number.isInteger(level) || level < 1 || level > 5) return renderOutputError("heading level is invalid");
      result.push(Object.freeze({ kind: "heading", level: level as 1 | 2 | 3 | 4 | 5, text: renderText(dataProperty(node, "text"), "heading text", total) }));
    } else if (kind === "paragraph") {
      exactNodeKeys(node, ["kind", "text"]);
      result.push(Object.freeze({ kind: "paragraph", text: renderText(dataProperty(node, "text"), "paragraph text", total) }));
    } else if (kind === "list") {
      exactNodeKeys(node, ["kind", "items"]);
      result.push(Object.freeze({ kind: "list", items: Object.freeze(renderTextArray(dataProperty(node, "items"), "list items", MAX_RENDER_LIST_ITEMS, total)) }));
    } else if (kind === "table") {
      exactNodeKeys(node, ["kind", "headers", "rows"]);
      const headers = renderTextArray(dataProperty(node, "headers"), "table columns", MAX_RENDER_TABLE_COLUMNS, total);
      if (headers.length === 0) return renderOutputError("table must have at least one column");
      const rowsValue = dataProperty(node, "rows");
      if (!Array.isArray(rowsValue) || rowsValue.length > MAX_RENDER_TABLE_ROWS) return renderOutputError(`table rows exceeds ${MAX_RENDER_TABLE_ROWS} items`);
      const rowsPrototype = Object.getPrototypeOf(rowsValue);
      if (rowsPrototype !== Array.prototype && rowsPrototype !== null) return renderOutputError("table rows array prototype is invalid");
      const rows: string[][] = [];
      for (let rowIndex = 0; rowIndex < rowsValue.length; rowIndex += 1) {
        if (!Object.hasOwn(rowsValue, rowIndex)) return renderOutputError("table rows must not be sparse");
        const row = renderTextArray(dataProperty(rowsValue as unknown as Record<string, unknown>, String(rowIndex)), `table row ${rowIndex}`, MAX_RENDER_TABLE_COLUMNS, total);
        if (row.length !== headers.length) return renderOutputError(`table row ${rowIndex} width does not match columns`);
        rows.push(row);
      }
      if (Object.keys(rowsValue).some((key) => !/^\d+$/u.test(key) || Number(key) >= rowsValue.length)) return renderOutputError("table rows has unknown properties");
      result.push(Object.freeze({ kind: "table", headers: Object.freeze(headers), rows: Object.freeze(rows.map((row) => Object.freeze(row) as unknown as string[])) }));
    } else if (kind === "kv") {
      exactNodeKeys(node, ["kind", "key", "value"]);
      result.push(Object.freeze({ kind: "kv", key: renderText(dataProperty(node, "key"), "key", total), value: renderText(dataProperty(node, "value"), "value", total) }));
    } else if (kind === "code") {
      exactNodeKeys(node, ["kind", "text"]);
      result.push(Object.freeze({ kind: "code", text: renderText(dataProperty(node, "text"), "code text", total) }));
    } else {
      return renderOutputError("node kind is invalid");
    }
  }
  if (Object.keys(value).some((key) => !/^\d+$/u.test(key) || Number(key) >= value.length)) return renderOutputError("result has unknown properties");
  return Object.freeze(result) as unknown as RenderNode[];
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
  const exact = rendererFor(tables.exact, artifact.id);
  if (exact !== undefined) {
    try {
      return { nodes: invokeRenderer(exact, artifact, options, warnings), layer: "exact" };
    } catch (err) {
      warnings.push(rendererWarning("exact", artifact.id, err));
    }
  }

  // 2. Spec-family: the 7 known spec-preparation ids. Unknown spec_* ids are
  //    absent from the table and fall through to payload type match/generic.
  if (resolveRendererLayer(artifact.id) === "spec-family") {
    const spec = rendererFor(tables.spec, artifact.id);
    if (spec !== undefined) {
      try {
        return { nodes: invokeRenderer(spec, artifact, options, warnings), layer: "spec-family" };
      } catch (err) {
        warnings.push(rendererWarning("spec-family", artifact.id, err));
      }
    }
  }

  // 3. The 22 typed schema ids.
  const typed = rendererFor(tables.typed, artifact.id);
  if (typed !== undefined) {
    try {
      return { nodes: invokeRenderer(typed, artifact, options, warnings), layer: "typed-schema" };
    } catch (err) {
      warnings.push(rendererWarning("typed-schema", artifact.id, err));
    }
  }

  // 4. Payload type match for freeform/unknown ids (never for regression_*).
  if (!isRegressionId(artifact.id)) {
    const declared = payloadTypeOf(artifact, options);
    if (declared !== undefined) {
      const byType = rendererFor(tables.typed, declared);
      if (byType !== undefined) {
        try {
          return { nodes: invokeRenderer(byType, artifact, options, warnings), layer: "typed-schema" };
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
  if (sweepRendererLeases()) refreshSnapshots();
  return renderArtifactWithTables(artifact, DEFAULT_TABLES, options, warnings);
}
