/**
 * Constitution provider resolution (T019).
 *
 * Deterministic, local-only precedence:
 *   1. explicit `constitution.path` override — wins whenever the path is safe;
 *   2. exactly one registered provider whose discovered candidates exist;
 *   3. the native project-root `CONSTITUTION.md` default.
 *
 * Several existing candidates block as ambiguous regardless of registration
 * order; unsafe paths and failing discovery fail closed. Discovery inspects
 * local metadata and files only: providers can never invoke external
 * commands, CLIs, installers, package managers, or network services.
 */
import {
  createRegistryRegistrationLiveGuard,
  recordRegistryUndo,
  registryRegistrationPrincipal,
  requireRegistryRegistration,
  type RegistryContextSnapshot,
  type RegistryRegistrationPrincipal,
  type RegistryRegistrationToken,
} from "../registry/owner.js";
import { cloneAndFreeze, descriptorFingerprint } from "../registry/owner.js";
import type { ConstitutionProviderSelection } from "./types.js";
import { PinnedProjectRoot, PinnedRootError } from "./pinned-root.js";
import { digestOf, isSafeRelativePath, sha256Hex } from "./validation.js";

/** Canonical native policy path relative to the authorized project root. */
export const NATIVE_CONSTITUTION_PATH = "CONSTITUTION.md";

/** Provider id recorded for the native default resolution. */
export const NATIVE_CONSTITUTION_PROVIDER_ID = "native";

/** Provider id recorded for an explicit `constitution.path` override. */
export const EXPLICIT_OVERRIDE_PROVIDER_ID = "explicit";

/**
 * Domain-agnostic bootstrap template used when no constitution content
 * exists yet and the prerequisite must generate one. Core ships no stack
 * opinions; bundles may register richer templates through provider seams.
 */
export const NATIVE_CONSTITUTION_TEMPLATE = Object.freeze({
  ref: "workflows/templates/specification/constitution.md",
  content: [
    "# Project Constitution",
    "",
    "Version: 0.1.0",
    "",
    "<!-- Describe the governing principles below; every principle needs a",
    "     numbered section and a rationale. Remove this banner once done. -->",
    "",
    "<!-- omp-spec:marker:principles -->",
    "## I. Principles",
    "",
    "Describe the project's governing principles here.",
    "",
  ].join("\n"),
});

export interface ConstitutionProviderTemplate {
  /** Stable template reference recorded in the selection. */
  readonly ref: string;
  /** Exact template bytes; hashed into the selection fingerprint. */
  readonly content: string;
}

export interface ConstitutionProvider {
  /** Immutable registry id; duplicates fail closed. */
  readonly provider_id: string;
  /**
   * Return candidate project-relative constitution paths. Local metadata
   * inspection only: discovery MUST NOT execute external commands or
   * access the network.
   */
  readonly discover: (projectRoot: string) => string[];
  /** Optional bootstrap template override; defaults to the native template. */
  readonly template?: ConstitutionProviderTemplate;
}

export type ConstitutionResolutionCode =
  | "SPEC_PATH_UNAUTHORIZED"
  | "SPEC_CONSTITUTION_SOURCE_AMBIGUOUS"
  | "SPEC_CONSTITUTION_DISCOVERY_FAILED";

export type ConstitutionResolution =
  | { ok: true; value: ConstitutionProviderSelection }
  | { ok: false; code: ConstitutionResolutionCode; error: string };

const MAX_PROVIDERS = 16;
const MAX_PROVIDER_LEASES = MAX_PROVIDERS * 4;
const MAX_PROVIDER_ID_BYTES = 128;
const MAX_PROVIDER_TEMPLATE_REF_BYTES = 1024;
const MAX_PROVIDER_CANDIDATE_PATH_BYTES = 4096;
const MAX_CANDIDATES_PER_PROVIDER = 64;
const MAX_TEMPLATE_BYTES = 256 * 1024;
const REGISTRY_FAMILY = "constitution_providers" as const;

function normalizeProviderCandidates(value: unknown): { ok: true; value: string[] } | { ok: false } {
  if (!Array.isArray(value)) return { ok: false };
  let length: number;
  try { length = value.length; } catch { return { ok: false }; }
  if (!Number.isSafeInteger(length) || length > MAX_CANDIDATES_PER_PROVIDER) return { ok: false };
  const result: string[] = [];
  for (let index = 0; index < length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor || !Object.hasOwn(descriptor, "value") || typeof descriptor.value !== "string") return { ok: false };
    result.push(descriptor.value);
  }
  if (Object.getPrototypeOf(value) !== Array.prototype && Object.getPrototypeOf(value) !== null) return { ok: false };
  if (Object.keys(value).some((key) => !/^(0|[1-9]\d*)$/u.test(key) || Number(key) >= length) || Object.getOwnPropertySymbols(value).length > 0) return { ok: false };
  return { ok: true, value: result };
}

interface ProviderLease {
  readonly principal: RegistryRegistrationPrincipal;
  readonly token: RegistryRegistrationToken;
  readonly liveGuard: () => RegistryContextSnapshot;
}

interface ProviderCell {
  readonly principal: RegistryRegistrationPrincipal;
  readonly descriptor_fingerprint: string;
  readonly metadata: Readonly<{ provider_id: string; template?: ConstitutionProviderTemplate }>;
  readonly provider: ConstitutionProvider;
  readonly leases: Map<RegistryRegistrationPrincipal, Set<ProviderLease>>;
}

const providers = new Map<string, ProviderCell>();

function providerMetadata(provider: ConstitutionProvider): Readonly<{ provider_id: string; template?: ConstitutionProviderTemplate }> {
  return cloneAndFreeze({
    provider_id: provider.provider_id,
    ...(provider.template === undefined
      ? {}
      : { template: { ref: provider.template.ref, content: provider.template.content } }),
  });
}

function providerCell(
  principal: RegistryRegistrationPrincipal,
  provider: ConstitutionProvider,
): ProviderCell {
  const metadata = providerMetadata(provider);
  return Object.freeze({
    principal,
    descriptor_fingerprint: descriptorFingerprint(metadata),
    metadata,
    provider: Object.freeze({
      provider_id: provider.provider_id,
      discover: provider.discover,
      ...(provider.template === undefined ? {} : { template: cloneAndFreeze(provider.template) }),
    }),
    leases: new Map(),
  });
}

function providerLeaseCount(cell: ProviderCell): number {
  let count = 0;
  for (const leases of cell.leases.values()) count += leases.size;
  return count;
}

function sweepProviderLeases(): void {
  for (const [id, cell] of providers) {
    for (const [principal, leases] of cell.leases) {
      for (const lease of [...leases]) {
        try {
          lease.liveGuard();
        } catch {
          leases.delete(lease);
        }
      }
      if (leases.size === 0) cell.leases.delete(principal);
    }
    if (providerLeaseCount(cell) === 0) providers.delete(id);
  }
}

function addProviderLease(cell: ProviderCell, token: RegistryRegistrationToken, principal: RegistryRegistrationPrincipal): ProviderLease {
  const leases = cell.leases.get(principal);
  const existing = leases && [...leases].find((lease) => lease.token === token);
  if (existing) return existing;
  if ((leases && leases.size >= 4) || providerLeaseCount(cell) >= MAX_PROVIDER_LEASES) {
    throw new Error(`constitution provider lease registry is bounded at ${MAX_PROVIDER_LEASES} leases`);
  }
  const lease: ProviderLease = Object.freeze({
    principal,
    token,
    liveGuard: createRegistryRegistrationLiveGuard(token, REGISTRY_FAMILY),
  });
  (leases ?? cell.leases.set(principal, new Set()).get(principal)!).add(lease);
  return lease;
}

function removeProviderLease(cell: ProviderCell, lease: ProviderLease): void {
  const leases = cell.leases.get(lease.principal);
  if (!leases) return;
  leases.delete(lease);
  if (leases.size === 0) cell.leases.delete(lease.principal);
}

function normalizeProvider(input: ConstitutionProvider): ConstitutionProvider {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("constitution provider must be an object");
  const record = input as unknown as Record<string, unknown>;
  const proto = Object.getPrototypeOf(input);
  if (proto !== Object.prototype && proto !== null) throw new Error("constitution provider prototype is invalid");
  const keys = Object.keys(record).sort();
  if (keys.some((key) => !["discover", "provider_id", "template"].includes(key))) throw new Error("constitution provider has unknown fields");
  const read = (key: string): unknown => {
    const descriptor = Object.getOwnPropertyDescriptor(record, key);
    if (!descriptor || !Object.hasOwn(descriptor, "value")) throw new Error(`constitution provider '${key}' must be a data property`);
    return descriptor.value;
  };
  const providerId = read("provider_id");
  if (typeof providerId !== "string" || providerId.length === 0 || Buffer.byteLength(providerId, "utf8") > MAX_PROVIDER_ID_BYTES || /[\u0000-\u001f\u007f]/u.test(providerId)) {
    throw new Error(`constitution provider_id must be a non-empty safe string of at most ${MAX_PROVIDER_ID_BYTES} bytes`);
  }
  const discoverValue = read("discover");
  if (typeof discoverValue !== "function") throw new Error(`constitution provider '${providerId}' must declare discover()`);
  const discover = discoverValue as ConstitutionProvider["discover"];
  let template: ConstitutionProviderTemplate | undefined;
  if (Object.hasOwn(record, "template")) {
    const templateValue = read("template");
    if (templateValue !== undefined) {
      if (!templateValue || typeof templateValue !== "object" || Array.isArray(templateValue)) throw new Error(`constitution provider '${providerId}' template ref is invalid`);
      const templateRecord = templateValue as unknown as Record<string, unknown>;
      const templateProto = Object.getPrototypeOf(templateValue);
      if (templateProto !== Object.prototype && templateProto !== null) throw new Error(`constitution provider '${providerId}' template is invalid`);
      const templateKeys = Object.keys(templateRecord).sort();
      if (templateKeys.length !== 2 || templateKeys[0] !== "content" || templateKeys[1] !== "ref") throw new Error(`constitution provider '${providerId}' template has unknown fields`);
      const readTemplate = (key: string): unknown => {
        const descriptor = Object.getOwnPropertyDescriptor(templateRecord, key);
        if (!descriptor || !Object.hasOwn(descriptor, "value")) throw new Error(`constitution provider '${providerId}' template '${key}' must be a data property`);
        return descriptor.value;
      };
      const ref = readTemplate("ref");
      const content = readTemplate("content");
      if (typeof ref !== "string" || ref.length === 0 || Buffer.byteLength(ref, "utf8") > MAX_PROVIDER_TEMPLATE_REF_BYTES || /[\u0000-\u001f\u007f]/u.test(ref)) throw new Error(`constitution provider '${providerId}' template ref is invalid`);
      if (typeof content !== "string" || Buffer.byteLength(content, "utf8") > MAX_TEMPLATE_BYTES) throw new Error(`constitution provider '${providerId}' template exceeds ${MAX_TEMPLATE_BYTES} bytes`);
      template = Object.freeze({ ref, content });
    }
  }
  return Object.freeze({ provider_id: providerId, discover, ...(template ? { template } : {}) });
}

/**
 * Register one constitution provider under an authenticated owner
 * transaction. The supplied object is detached before it enters the global
 * registry; callback references are retained, while metadata is deeply frozen.
 * Re-registering the exact cell by the same owner is idempotent.
 */
export function registerConstitutionProvider(
  token: RegistryRegistrationToken,
  provider: ConstitutionProvider,
): void {
  requireRegistryRegistration(token, REGISTRY_FAMILY);
  const normalized = normalizeProvider(provider);
  sweepProviderLeases();
  const principal = registryRegistrationPrincipal(token, REGISTRY_FAMILY);
  const id = normalized.provider_id;
  const existing = providers.get(id);
  const candidate = providerCell(principal, normalized);
  if (existing) {
    const sameDescriptor = existing.descriptor_fingerprint === candidate.descriptor_fingerprint
      && existing.provider.discover === candidate.provider.discover;
    if (sameDescriptor) {
      let lease: ProviderLease | undefined;
      recordRegistryUndo(token, () => { if (lease) removeProviderLease(existing, lease); });
      lease = addProviderLease(existing, token, principal);
      return;
    }
    if (providerLeaseCount(existing) > 0) {
      throw new Error(`constitution provider '${provider.provider_id}' is already registered and cannot be replaced`);
    }
    const inserted = candidate;
    let lease: ProviderLease | undefined;
    recordRegistryUndo(token, () => {
      if (lease) removeProviderLease(inserted, lease);
      if (providers.get(id) === inserted) providers.set(id, existing);
    });
    lease = addProviderLease(inserted, token, principal);
    providers.set(id, inserted);
    return;
  }
  if (providers.size >= MAX_PROVIDERS) {
    throw new Error(`constitution provider registry is bounded at ${MAX_PROVIDERS} providers`);
  }
  const inserted = candidate;
  let lease: ProviderLease | undefined;
  recordRegistryUndo(token, () => {
    if (lease) removeProviderLease(inserted, lease);
    if (providers.get(id) === inserted) providers.delete(id);
  });
  lease = addProviderLease(inserted, token, principal);
  providers.set(id, inserted);
}

/** Read-only diagnostic snapshot of registered provider ids. */
export function listConstitutionProviders(): readonly string[] {
  sweepProviderLeases();
  return Object.freeze([...providers.keys()]);
}

function templateFor(provider?: ConstitutionProvider): { ref: string; hash: string } {
  const template = provider?.template ?? NATIVE_CONSTITUTION_TEMPLATE;
  return { ref: template.ref, hash: sha256Hex(template.content) };
}

function existingFileWithin(pinnedRoot: PinnedProjectRoot, candidate: string): boolean {
  if (!isSafeRelativePath(candidate)) return false;
  try {
    const info = pinnedRoot.pathEntryInfo(candidate);
    return info?.kind === "file";
  } catch (error) {
    if (error instanceof PinnedRootError && error.code === "not_found") return false;
    throw error;
  }
}
function selection(
  providerId: string,
  source: ConstitutionProviderSelection["source"],
  path: string,
  template: { ref: string; hash: string },
  registeredProviderIds: readonly string[],
  explicitPath: string | null,
): ConstitutionProviderSelection {
  return Object.freeze({
    provider_id: providerId,
    source,
    path,
    template_ref: template.ref,
    template_hash: template.hash,
    selection_hash: digestOf({
      provider_id: providerId,
      source,
      path,
      template_ref: template.ref,
      template_hash: template.hash,
      providers: [...registeredProviderIds].sort(),
      explicit_path: explicitPath,
    }),
    selected_at: new Date().toISOString(),
  });
}

/**
 * Resolve the project policy location. Purely local; fails closed on unsafe
 * paths, failing discovery, or ambiguous existing candidates. The native
 * default always resolves even when no constitution file exists yet.
 */
export function resolveConstitutionProvider(
  projectRoot: string,
  options: { explicit_path?: string | null; pinnedRoot?: PinnedProjectRoot } = {},
): ConstitutionResolution {
  const ownsPinnedRoot = options.pinnedRoot === undefined;
  const pinnedRoot = options.pinnedRoot ?? PinnedProjectRoot.open(projectRoot);
  if (!pinnedRoot) {
    return { ok: false, code: "SPEC_PATH_UNAUTHORIZED", error: `project root is not a readable directory: ${projectRoot}` };
  }
  try {
    sweepProviderLeases();
    const root = pinnedRoot.canonical_root;
    const registered = listConstitutionProviders();
    const explicit = options.explicit_path;
    if (explicit !== undefined && explicit !== null) {
      if (typeof explicit !== "string" || explicit.length === 0 || !isSafeRelativePath(explicit)) {
        return { ok: false, code: "SPEC_PATH_UNAUTHORIZED", error: "explicit constitution.path is not a safe project-relative path" };
      }
      try {
        const info = pinnedRoot.pathEntryInfo(explicit);
        if (info !== null && info.kind !== "file") {
          return { ok: false, code: "SPEC_PATH_UNAUTHORIZED", error: `explicit constitution.path escapes the project root: ${explicit}` };
        }
      } catch (error) {
        return { ok: false, code: "SPEC_PATH_UNAUTHORIZED", error: `explicit constitution.path cannot be resolved safely: ${String(error)}` };
      }
      if (!pinnedRoot.isStable()) return { ok: false, code: "SPEC_PATH_UNAUTHORIZED", error: "project root changed during constitution provider selection" };
      return {
        ok: true,
        value: selection(EXPLICIT_OVERRIDE_PROVIDER_ID, "explicit_override", explicit, templateFor(), registered, explicit),
      };
    }

    const found: Array<{ provider_id: string; path: string }> = [];
    for (const cell of providers.values()) {
      const provider = cell.provider;
      let candidates: unknown;
      try {
        candidates = provider.discover(root);
      } catch (error) {
        return {
          ok: false,
          code: "SPEC_CONSTITUTION_DISCOVERY_FAILED",
          error: `provider '${provider.provider_id}' discovery failed: ${error instanceof Error ? error.message : String(error)}`,
        };
      }
      if (!pinnedRoot.isStable()) return { ok: false, code: "SPEC_PATH_UNAUTHORIZED", error: "project root changed during constitution provider discovery" };
      const normalizedCandidates = normalizeProviderCandidates(candidates);
      if (!normalizedCandidates.ok) {
        return {
          ok: false,
          code: "SPEC_CONSTITUTION_DISCOVERY_FAILED",
          error: `provider '${provider.provider_id}' returned an invalid candidate set`,
        };
      }
      const seen = new Set<string>();
      for (const candidate of normalizedCandidates.value) {
        if (typeof candidate !== "string" || Buffer.byteLength(candidate, "utf8") > MAX_PROVIDER_CANDIDATE_PATH_BYTES || !isSafeRelativePath(candidate)) {
          return {
            ok: false,
            code: "SPEC_PATH_UNAUTHORIZED",
            error: `provider '${provider.provider_id}' discovered an unsafe candidate path`,
          };
        }
        if (seen.has(candidate)) continue;
        seen.add(candidate);
        try {
          if (!existingFileWithin(pinnedRoot, candidate)) continue;
        } catch (error) {
          return { ok: false, code: "SPEC_PATH_UNAUTHORIZED", error: `provider candidate cannot be resolved safely: ${String(error)}` };
        }
        if (!pinnedRoot.isStable()) return { ok: false, code: "SPEC_PATH_UNAUTHORIZED", error: "project root changed during constitution provider discovery" };
        found.push({ provider_id: provider.provider_id, path: candidate });
      }
    }

    if (found.length > 1) {
      const listed = found.map((entry) => `${entry.provider_id}:${entry.path}`).join(", ");
      return {
        ok: false,
        code: "SPEC_CONSTITUTION_SOURCE_AMBIGUOUS",
        error: `multiple constitution sources resolved (${listed}); set constitution.path explicitly`,
      };
    }
    if (found.length === 1) {
      const winner = found[0]!;
      const provider = providers.get(winner.provider_id)?.provider;
      if (!pinnedRoot.isStable()) return { ok: false, code: "SPEC_PATH_UNAUTHORIZED", error: "project root changed during constitution provider selection" };
      return {
        ok: true,
        value: selection(winner.provider_id, "discovered_provider", winner.path, templateFor(provider), registered, null),
      };
    }

    if (!pinnedRoot.isStable()) return { ok: false, code: "SPEC_PATH_UNAUTHORIZED", error: "project root changed during constitution provider selection" };
    return {
      ok: true,
      value: selection(NATIVE_CONSTITUTION_PROVIDER_ID, "native_default", NATIVE_CONSTITUTION_PATH, templateFor(), registered, null),
    };
  } finally {
    if (ownsPinnedRoot) pinnedRoot.close();
  }
}
