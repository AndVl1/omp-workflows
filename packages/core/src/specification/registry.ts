/**
 * Authenticated extension registries for specification workflows (T022).
 *
 * Consumer registrations are possible only inside a live owner transaction.
 * Each registry cell keeps an opaque owner principal, a descriptor fingerprint,
 * detached immutable metadata, and the original callback reference. A cell can
 * therefore be registered again by its owner only when it is exactly the same
 * registration; no consumer can replace a built-in or another owner's cell.
 */
import { PRD_SOURCE_ARTIFACT_IDS, writeProductPrdDocumentPinned } from "../engine/product-prd.js";
import type { DocumentRenderInput, DocumentRenderResult, DocumentRenderer } from "../engine/types.js";
import type { FormatRecognitionResult } from "./types.js";
import {
  cloneAndFreeze,
  createRegistryRegistrationLiveGuard,
  descriptorFingerprint,
  recordRegistryUndo,
  registryRegistrationPrincipal,
  requireRegistryRegistration,
  type RegistryContextSnapshot,
  type RegistryRegistrationPrincipal,
  type RegistryRegistrationToken,
} from "../registry/owner.js";
export {
  registerConstitutionProvider,
  listConstitutionProviders,
  type ConstitutionProvider,
  type ConstitutionProviderTemplate,
} from "./constitution-provider.js";

const BUILTIN_PRINCIPAL = Object.freeze(Object.create(null)) as RegistryRegistrationPrincipal;
const DOCUMENT_RENDERER_FAMILY = "document_renderers" as const;
const SPECIFICATION_RENDERER_FAMILY = "specification_renderers" as const;
const FORMAT_RECOGNIZER_FAMILY = "format_recognizers" as const;
const MAX_LEASES_PER_CELL = 4;

type RegistryLease = {
  readonly principal: RegistryRegistrationPrincipal;
  readonly token: RegistryRegistrationToken;
  readonly liveGuard: () => RegistryContextSnapshot;
};
type RegistryLeases = Map<RegistryRegistrationPrincipal, Set<RegistryLease>>;

function leaseCount(leases: RegistryLeases): number {
  let count = 0;
  for (const bucket of leases.values()) count += bucket.size;
  return count;
}
function addLease(leases: RegistryLeases, token: RegistryRegistrationToken, principal: RegistryRegistrationPrincipal, family: "document_renderers" | "specification_renderers" | "format_recognizers"): RegistryLease {
  const bucket = leases.get(principal);
  const existing = bucket && [...bucket].find((lease) => lease.token === token);
  if (existing) return existing;
  if (bucket && bucket.size >= MAX_LEASES_PER_CELL) throw new Error(`registry activation leases are bounded at ${MAX_LEASES_PER_CELL} per descriptor`);
  const lease: RegistryLease = Object.freeze({ principal, token, liveGuard: createRegistryRegistrationLiveGuard(token, family) });
  (bucket ?? leases.set(principal, new Set()).get(principal)!).add(lease);
  return lease;
}
function hasLease(leases: RegistryLeases, token: RegistryRegistrationToken): boolean {
  for (const bucket of leases.values()) if ([...bucket].some((lease) => lease.token === token)) return true;
  return false;
}
function removeLease(leases: RegistryLeases, lease: RegistryLease): void {
  const bucket = leases.get(lease.principal);
  if (!bucket) return;
  bucket.delete(lease);
  if (bucket.size === 0) leases.delete(lease.principal);
}
function sweepLeases<C extends { readonly principal: RegistryRegistrationPrincipal; readonly leases: RegistryLeases }>(table: Map<string, C>): void {
  for (const [id, cell] of table) {
    for (const [principal, bucket] of cell.leases) {
      for (const lease of [...bucket]) {
        try { lease.liveGuard(); } catch { bucket.delete(lease); }
      }
      if (bucket.size === 0) cell.leases.delete(principal);
    }
    if (leaseCount(cell.leases) === 0 && cell.principal !== BUILTIN_PRINCIPAL) table.delete(id);
  }
}

// ── Template renderers ───────────────────────────────────────────────────────

const MAX_RENDERERS = 32;
const MAX_REQUIRED_SOURCE_ARTIFACTS = 64;
const MAX_SOURCE_ARTIFACT_ID_BYTES = 128;
const MAX_SOURCE_ARTIFACT_BYTES = 4096;
const SAFE_SOURCE_ARTIFACT_ID = /^[A-Za-z0-9._-]+$/u;
const renderers = new Map<string, DocumentRendererCell>();

interface DocumentRendererMetadata {
  readonly id: string;
  readonly format: "markdown";
  readonly requiredSourceArtifacts: readonly string[];
}

interface DocumentRendererCell {
  readonly principal: RegistryRegistrationPrincipal;
  readonly descriptor_fingerprint: string;
  readonly metadata: Readonly<DocumentRendererMetadata>;
  readonly renderer: DocumentRenderer;
  readonly leases: RegistryLeases;
}

function documentRendererCell(
  principal: RegistryRegistrationPrincipal,
  renderer: DocumentRenderer,
): DocumentRendererCell {
  const metadata = cloneAndFreeze({
    id: renderer.id,
    format: renderer.format,
    requiredSourceArtifacts: [...renderer.requiredSourceArtifacts],
  });
  return Object.freeze({
    principal,
    descriptor_fingerprint: descriptorFingerprint(metadata),
    metadata,
    renderer: cloneAndFreeze({
      id: renderer.id,
      format: renderer.format,
      requiredSourceArtifacts: [...renderer.requiredSourceArtifacts],
      render: renderer.render,
    }),
    leases: new Map(),
  });
}

function normalizeDocumentRenderer(input: DocumentRenderer): DocumentRenderer {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("document renderer must be an object");
  const record = input as unknown as Record<string, unknown>;
  const prototype = Object.getPrototypeOf(input);
  if (prototype !== Object.prototype && prototype !== null) throw new Error("document renderer prototype is invalid");
  const keys = Object.keys(record).sort();
  if (keys.length !== 4 || keys.some((key, index) => key !== ["format", "id", "render", "requiredSourceArtifacts"][index])) throw new Error("document renderer has unknown fields");
  const read = (key: string): unknown => {
    const descriptor = Object.getOwnPropertyDescriptor(record, key);
    if (!descriptor || !Object.hasOwn(descriptor, "value")) throw new Error(`document renderer '${key}' must be a data property`);
    return descriptor.value;
  };
  const id = read("id");
  if (typeof id !== "string" || id.length === 0 || Buffer.byteLength(id, "utf8") > 128) throw new Error("document renderer id must be a non-empty string of at most 128 characters");
  const format = read("format");
  if (format !== "markdown") throw new Error(`document renderer '${id}' must declare the markdown format`);
  const required = read("requiredSourceArtifacts");
  if (!Array.isArray(required)) throw new Error(`document renderer '${id}' must declare requiredSourceArtifacts`);
  if (required.length > MAX_REQUIRED_SOURCE_ARTIFACTS) throw new Error(`document renderer '${id}' requires at most ${MAX_REQUIRED_SOURCE_ARTIFACTS} source artifacts`);
  const sourceArtifactIds: string[] = [];
  const sourceArtifactSet = new Set<string>();
  let aggregateBytes = 0;
  for (let index = 0; index < required.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(required, String(index));
    if (!descriptor || !Object.hasOwn(descriptor, "value")) throw new Error(`document renderer '${id}' source artifact ids must be data properties`);
    const artifactId = descriptor.value;
    if (typeof artifactId !== "string" || artifactId.length === 0 || artifactId === "." || artifactId === ".." || !SAFE_SOURCE_ARTIFACT_ID.test(artifactId)) throw new Error(`document renderer '${id}' has an unsafe required source artifact id`);
    const artifactBytes = Buffer.byteLength(artifactId, "utf8");
    if (artifactBytes > MAX_SOURCE_ARTIFACT_ID_BYTES) throw new Error(`document renderer '${id}' has an overlong required source artifact id`);
    aggregateBytes += artifactBytes;
    if (aggregateBytes > MAX_SOURCE_ARTIFACT_BYTES) throw new Error(`document renderer '${id}' required source artifact ids exceed ${MAX_SOURCE_ARTIFACT_BYTES} bytes`);
    if (sourceArtifactSet.has(artifactId)) throw new Error(`document renderer '${id}' has duplicate required source artifact ids`);
    sourceArtifactSet.add(artifactId);
    sourceArtifactIds.push(artifactId);
  }
  if (Object.getPrototypeOf(required) !== Array.prototype && Object.getPrototypeOf(required) !== null) throw new Error(`document renderer '${id}' source artifact ids array prototype is invalid`);
  if (Object.keys(required).some((key) => !/^(0|[1-9]\d*)$/u.test(key) || Number(key) >= required.length)) throw new Error(`document renderer '${id}' source artifact ids has unknown properties`);
  const renderValue = read("render");
  if (typeof renderValue !== "function") throw new Error(`document renderer '${id}' must declare render()`);
  const render = renderValue as DocumentRenderer["render"];
  return Object.freeze({ id, format: "markdown", requiredSourceArtifacts: Object.freeze(sourceArtifactIds), render });
}

/**
 * Register one deterministic document renderer under an authenticated owner
 * transaction. Duplicate exact cells are idempotent; all conflicts reject
 * before this registry is mutated.
 */
export function registerDocumentRenderer(
  token: RegistryRegistrationToken,
  renderer: DocumentRenderer,
): void {
  requireRegistryRegistration(token, DOCUMENT_RENDERER_FAMILY);
  const normalized = normalizeDocumentRenderer(renderer);
  sweepLeases(renderers);
  const principal = registryRegistrationPrincipal(token, DOCUMENT_RENDERER_FAMILY);
  const id = normalized.id;
  const candidate = documentRendererCell(principal, normalized);
  const existing = renderers.get(id);
  if (existing) {
    const sameDescriptor = existing.descriptor_fingerprint === candidate.descriptor_fingerprint
      && existing.renderer.render === candidate.renderer.render;
    if (sameDescriptor) {
      if (hasLease(existing.leases, token)) return;
      let lease: RegistryLease | undefined;
      recordRegistryUndo(token, () => { if (lease) removeLease(existing.leases, lease); });
      lease = addLease(existing.leases, token, principal, DOCUMENT_RENDERER_FAMILY);
      return;
    }
    if (existing.principal === BUILTIN_PRINCIPAL || leaseCount(existing.leases) > 0) {
      throw new Error(`document renderer '${id}' is already registered and cannot be replaced`);
    }
    const inserted = candidate;
    let lease: RegistryLease | undefined;
    recordRegistryUndo(token, () => {
      if (lease) removeLease(inserted.leases, lease);
      if (renderers.get(id) === inserted) renderers.set(id, existing);
    });
    lease = addLease(inserted.leases, token, principal, DOCUMENT_RENDERER_FAMILY);
    renderers.set(id, inserted);
    return;
  }
  if (renderers.size >= MAX_RENDERERS) {
    throw new Error(`document renderer registry is bounded at ${MAX_RENDERERS} renderers`);
  }
  const inserted = candidate;
  let lease: RegistryLease | undefined;
  recordRegistryUndo(token, () => {
    if (lease) removeLease(inserted.leases, lease);
    if (renderers.get(id) === inserted) renderers.delete(id);
  });
  lease = addLease(inserted.leases, token, principal, DOCUMENT_RENDERER_FAMILY);
  renderers.set(id, inserted);
}

/** Fail-closed registry lookup used by stage document contracts. */
export function requireDocumentRenderer(id: string): DocumentRenderer {
  sweepLeases(renderers);
  const cell = renderers.get(id);
  if (!cell) throw new Error(`no document renderer registered for '${id}'`);
  return cell.renderer;
}

/** Read-only diagnostic snapshot of registered renderer ids. */
export function listDocumentRenderers(): readonly string[] {
  sweepLeases(renderers);
  return Object.freeze([...renderers.keys()]);
}

// ── Specification document renderers (T006/T016 contract) ────────────────────

/** One deterministic Markdown-to-Markdown renderer over document content. */
export interface SpecificationRenderer {
  /** Bounded safe registry id (^[a-z0-9][a-z0-9._-]{0,63}$). */
  readonly renderer_id: string;
  /** Pure content transformation; identical input renders byte-identical output. */
  readonly render: (document: string) => string;
}

export type SpecificationRendererCode =
  | "SPEC_RENDERER_INVALID"
  | "SPEC_RENDERER_CONFLICT"
  | "SPEC_REGISTRY_FULL"
  | "SPEC_RENDERER_UNRESOLVED";

export type SpecificationRendererRegistrationResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly code: SpecificationRendererCode; readonly error: string };

export type SpecificationRendererResolution =
  | { readonly ok: true; readonly value: SpecificationRenderer }
  | { readonly ok: false; readonly code: SpecificationRendererCode; readonly error: string };

const MAX_SPECIFICATION_RENDERERS = 32;
const SPECIFICATION_RENDERER_ID_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const specificationRenderers = new Map<string, SpecificationRendererCell>();

interface SpecificationRendererMetadata {
  readonly renderer_id: string;
}

interface SpecificationRendererCell {
  readonly principal: RegistryRegistrationPrincipal;
  readonly descriptor_fingerprint: string;
  readonly metadata: Readonly<SpecificationRendererMetadata>;
  readonly renderer: SpecificationRenderer;
  readonly leases: RegistryLeases;
}

function specificationRendererCell(
  principal: RegistryRegistrationPrincipal,
  renderer: SpecificationRenderer,
): SpecificationRendererCell {
  const metadata = cloneAndFreeze({ renderer_id: renderer.renderer_id });
  return Object.freeze({
    principal,
    descriptor_fingerprint: descriptorFingerprint(metadata),
    metadata,
    renderer: cloneAndFreeze({ renderer_id: renderer.renderer_id, render: renderer.render }),
    leases: new Map(),
  });
}

function normalizeSpecificationRenderer(input: SpecificationRenderer): SpecificationRenderer {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("specification renderer must be an object");
  const record = input as unknown as Record<string, unknown>;
  const prototype = Object.getPrototypeOf(input);
  if (prototype !== Object.prototype && prototype !== null) throw new Error("specification renderer prototype is invalid");
  const keys = Object.keys(record).sort();
  if (keys.length !== 2 || keys[0] !== "render" || keys[1] !== "renderer_id") throw new Error("specification renderer has unknown fields");
  const read = (key: string): unknown => {
    const descriptor = Object.getOwnPropertyDescriptor(record, key);
    if (!descriptor || !Object.hasOwn(descriptor, "value")) throw new Error(`specification renderer '${key}' must be a data property`);
    return descriptor.value;
  };
  const rendererId = read("renderer_id");
  if (typeof rendererId !== "string" || !SPECIFICATION_RENDERER_ID_RE.test(rendererId) || Buffer.byteLength(rendererId, "utf8") > 128) throw new Error(`unsafe specification renderer id ${JSON.stringify(rendererId)}`);
  const renderValue = read("render");
  if (typeof renderValue !== "function") throw new Error("specification renderer must declare render()");
  const render = renderValue as SpecificationRenderer["render"];
  return Object.freeze({ renderer_id: rendererId, render });
}

/**
 * Register one specification document renderer under an authenticated owner
 * transaction. Unsafe ids and conflicts reject without any partial write.
 */
export function registerSpecificationRenderer(
  token: RegistryRegistrationToken,
  renderer: SpecificationRenderer,
): SpecificationRendererRegistrationResult {
  requireRegistryRegistration(token, SPECIFICATION_RENDERER_FAMILY);
  let normalized: SpecificationRenderer;
  try { normalized = normalizeSpecificationRenderer(renderer); }
  catch (error) { return { ok: false, code: "SPEC_RENDERER_INVALID", error: error instanceof Error ? error.message : String(error) }; }
  sweepLeases(specificationRenderers);
  const principal = registryRegistrationPrincipal(token, SPECIFICATION_RENDERER_FAMILY);
  const id = normalized.renderer_id;
  const candidate = specificationRendererCell(principal, normalized);
  const existing = specificationRenderers.get(id);
  if (existing) {
    const sameDescriptor = existing.descriptor_fingerprint === candidate.descriptor_fingerprint
      && existing.renderer.render === candidate.renderer.render;
    if (sameDescriptor) {
      if (hasLease(existing.leases, token)) return { ok: true };
      let lease: RegistryLease | undefined;
      recordRegistryUndo(token, () => { if (lease) removeLease(existing.leases, lease); });
      lease = addLease(existing.leases, token, principal, SPECIFICATION_RENDERER_FAMILY);
      return { ok: true };
    }
    if (existing.principal === BUILTIN_PRINCIPAL || leaseCount(existing.leases) > 0) {
      return { ok: false, code: "SPEC_RENDERER_CONFLICT", error: `specification renderer '${id}' is already registered and cannot be replaced` };
    }
    const inserted = candidate;
    let lease: RegistryLease | undefined;
    recordRegistryUndo(token, () => {
      if (lease) removeLease(inserted.leases, lease);
      if (specificationRenderers.get(id) === inserted) specificationRenderers.set(id, existing);
    });
    lease = addLease(inserted.leases, token, principal, SPECIFICATION_RENDERER_FAMILY);
    specificationRenderers.set(id, inserted);
    return { ok: true };
  }
  if (specificationRenderers.size >= MAX_SPECIFICATION_RENDERERS) {
    return { ok: false, code: "SPEC_REGISTRY_FULL", error: `specification renderer registry is bounded at ${MAX_SPECIFICATION_RENDERERS} renderers` };
  }
  const inserted = candidate;
  let lease: RegistryLease | undefined;
  recordRegistryUndo(token, () => {
    if (lease) removeLease(inserted.leases, lease);
    if (specificationRenderers.get(id) === inserted) specificationRenderers.delete(id);
  });
  lease = addLease(inserted.leases, token, principal, SPECIFICATION_RENDERER_FAMILY);
  specificationRenderers.set(id, inserted);
  return { ok: true };
}

/** Fail-closed resolution of one registered specification renderer. */
export function resolveSpecificationRenderer(rendererId: string): SpecificationRendererResolution {
  sweepLeases(specificationRenderers);
  const cell = specificationRenderers.get(rendererId);
  if (!cell) {
    return Object.freeze({ ok: false, code: "SPEC_RENDERER_UNRESOLVED", error: `no specification renderer registered for '${rendererId}'` });
  }
  return Object.freeze({ ok: true, value: cell.renderer });
}

/** Read-only diagnostic snapshot of registered specification renderer ids. */
export function listSpecificationRenderers(): readonly string[] {
  sweepLeases(specificationRenderers);
  return Object.freeze([...specificationRenderers.keys()]);
}

// ── Format recognizers ───────────────────────────────────────────────────────

/**
 * One immutable document captured by the secure external importer. The
 * recognizer seam intentionally carries text, not a path to reopen: callers
 * must provide bytes that have already been bounded, decoded, normalized, and
 * bound to the snapshot.
 */
export interface FormatRecognizerDocument {
  readonly source_ref: string;
  readonly sha256: string;
  readonly size_bytes: number;
  readonly media_type: string;
  readonly text: string;
  readonly content_role: "untrusted_inert_data";
}

/**
 * Immutable, snapshot-bound input for a format recognizer. `source_root` and
 * its physical identity are metadata only; recognizers MUST NOT inspect that
 * path. All result paths are safe, POSIX, source-root-relative references.
 */
export interface FormatRecognizerInput {
  readonly source_root: string;
  readonly source_root_identity: {
    readonly canonical_path: string;
    readonly dev: number;
    readonly ino: number;
    readonly mode: number;
  };
  readonly documents: readonly FormatRecognizerDocument[];
  readonly ignored_candidates?: readonly { readonly path: string; readonly reason: string }[];
}

export interface FormatRecognizer {
  /** Immutable registry id; duplicates fail closed. */
  readonly recognizer_id: string;
  /** Advisory recognition over immutable normalized documents. */
  readonly recognize: (input: FormatRecognizerInput) => FormatRecognitionResult | null;
}

const MAX_RECOGNIZERS = 32;
const MAX_RECOGNIZER_ID_BYTES = 128;
const SAFE_RECOGNIZER_ID = /^[A-Za-z0-9._-]+$/u;

interface FormatRecognizerMetadata {
  readonly recognizer_id: string;
}

interface FormatRecognizerCell {
  readonly principal: RegistryRegistrationPrincipal;
  readonly descriptor_fingerprint: string;
  readonly metadata: Readonly<FormatRecognizerMetadata>;
  readonly recognizer: FormatRecognizer;
  readonly leases: RegistryLeases;
}

const recognizers = new Map<string, FormatRecognizerCell>();

function formatRecognizerCell(
  principal: RegistryRegistrationPrincipal,
  recognizer: FormatRecognizer,
): FormatRecognizerCell {
  const metadata = cloneAndFreeze({ recognizer_id: recognizer.recognizer_id });
  return Object.freeze({
    principal,
    descriptor_fingerprint: descriptorFingerprint(metadata),
    metadata,
    recognizer: cloneAndFreeze({ recognizer_id: recognizer.recognizer_id, recognize: recognizer.recognize }),
    leases: new Map(),
  });
}

function normalizeFormatRecognizer(input: FormatRecognizer): FormatRecognizer {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("format recognizer must be an object");
  const record = input as unknown as Record<string, unknown>;
  const prototype = Object.getPrototypeOf(input);
  if (prototype !== Object.prototype && prototype !== null) throw new Error("format recognizer prototype is invalid");
  const keys = Object.keys(record).sort();
  if (keys.length !== 2 || keys[0] !== "recognize" || keys[1] !== "recognizer_id") throw new Error("format recognizer has unknown fields");
  const read = (key: string): unknown => {
    const descriptor = Object.getOwnPropertyDescriptor(record, key);
    if (!descriptor || !Object.hasOwn(descriptor, "value")) throw new Error(`format recognizer '${key}' must be a data property`);
    return descriptor.value;
  };
  const recognizerId = read("recognizer_id");
  if (typeof recognizerId !== "string" || recognizerId.length === 0 || Buffer.byteLength(recognizerId, "utf8") > MAX_RECOGNIZER_ID_BYTES || recognizerId === "." || recognizerId === ".." || !SAFE_RECOGNIZER_ID.test(recognizerId)) throw new Error(`format recognizer_id must be a non-empty safe identifier of at most ${MAX_RECOGNIZER_ID_BYTES} bytes`);
  const recognizeValue = read("recognize");
  if (typeof recognizeValue !== "function") throw new Error(`format recognizer '${recognizerId}' must declare recognize()`);
  const recognize = recognizeValue as FormatRecognizer["recognize"];
  return Object.freeze({ recognizer_id: recognizerId, recognize });
}

/**
 * Register one format recognizer under an authenticated owner transaction.
 * Recognition remains advisory and never changes workflow gates.
 */
export function registerFormatRecognizer(
  token: RegistryRegistrationToken,
  recognizer: FormatRecognizer,
): void {
  requireRegistryRegistration(token, FORMAT_RECOGNIZER_FAMILY);
  const normalized = normalizeFormatRecognizer(recognizer);
  sweepLeases(recognizers);
  const principal = registryRegistrationPrincipal(token, FORMAT_RECOGNIZER_FAMILY);
  const id = normalized.recognizer_id;
  const candidate = formatRecognizerCell(principal, normalized);
  const existing = recognizers.get(id);
  if (existing) {
    const sameDescriptor = existing.descriptor_fingerprint === candidate.descriptor_fingerprint
      && existing.recognizer.recognize === candidate.recognizer.recognize;
    if (sameDescriptor) {
      if (hasLease(existing.leases, token)) return;
      let lease: RegistryLease | undefined;
      recordRegistryUndo(token, () => { if (lease) removeLease(existing.leases, lease); });
      lease = addLease(existing.leases, token, principal, FORMAT_RECOGNIZER_FAMILY);
      return;
    }
    if (existing.principal === BUILTIN_PRINCIPAL || leaseCount(existing.leases) > 0) {
      throw new Error(`format recognizer '${id}' is already registered and cannot be replaced`);
    }
    const inserted = candidate;
    let lease: RegistryLease | undefined;
    recordRegistryUndo(token, () => {
      if (lease) removeLease(inserted.leases, lease);
      if (recognizers.get(id) === inserted) recognizers.set(id, existing);
    });
    lease = addLease(inserted.leases, token, principal, FORMAT_RECOGNIZER_FAMILY);
    recognizers.set(id, inserted);
    return;
  }
  if (recognizers.size >= MAX_RECOGNIZERS) {
    throw new Error(`format recognizer registry is bounded at ${MAX_RECOGNIZERS} recognizers`);
  }
  const inserted = candidate;
  let lease: RegistryLease | undefined;
  recordRegistryUndo(token, () => {
    if (lease) removeLease(inserted.leases, lease);
    if (recognizers.get(id) === inserted) recognizers.delete(id);
  });
  lease = addLease(inserted.leases, token, principal, FORMAT_RECOGNIZER_FAMILY);
  recognizers.set(id, inserted);
}

/** Read-only diagnostic snapshot of registered recognizer ids. */
export function listFormatRecognizers(): readonly string[] {
  sweepLeases(recognizers);
  return Object.freeze([...recognizers.keys()]);
}

/** Fail-closed resolution of one registered recognizer by exact id. */
export function resolveFormatRecognizer(id: string): FormatRecognizer | null {
  sweepLeases(recognizers);
  return recognizers.get(id)?.recognizer ?? null;
}

// ── Private shipped bootstrap ────────────────────────────────────────────────

const DEFAULT_SPECIFICATION_RENDERER_ID = "specification-markdown";
const PRODUCT_PRD_RENDERER_ID = "product-prd";

const specificationMarkdownRenderer: SpecificationRenderer = Object.freeze({
  renderer_id: DEFAULT_SPECIFICATION_RENDERER_ID,
  render: (document: string): string => document,
});

const productPrdDocumentRenderer: DocumentRenderer = Object.freeze({
  id: PRODUCT_PRD_RENDERER_ID,
  format: "markdown",
  requiredSourceArtifacts: Object.freeze([...PRD_SOURCE_ARTIFACT_IDS]),
  render: (input: DocumentRenderInput): DocumentRenderResult => {
    const written = writeProductPrdDocumentPinned({
      pinnedRoot: input.pinnedRoot,
      stateDirRelative: input.stateDirRelative,
      artifactsDirRelative: input.artifactsDirRelative,
      path: input.path,
      sourceArtifacts: input.sourceArtifacts,
      registerRollback: input.registerRollback,
    });
    return written.ok
      ? {
          ok: true,
          documentPath: written.documentPath,
          content_sha256: written.content_hash,
          source_hash: written.source_hash,
          artifactPath: written.artifactPath,
        }
      : { ok: false, error: written.error };
  },
});

function seedShippedRenderers(): void {
  const specificationCell = specificationRendererCell(BUILTIN_PRINCIPAL, specificationMarkdownRenderer);
  const documentCell = documentRendererCell(BUILTIN_PRINCIPAL, productPrdDocumentRenderer);
  specificationRenderers.set(DEFAULT_SPECIFICATION_RENDERER_ID, specificationCell);
  renderers.set(PRODUCT_PRD_RENDERER_ID, documentCell);
}

seedShippedRenderers();
