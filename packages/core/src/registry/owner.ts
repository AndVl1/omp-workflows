import { createHash } from "node:crypto";
import { closeSync, constants, existsSync, fstatSync, lstatSync, openSync, readSync, realpathSync, statSync, type Stats } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { assertCurrentExecutionLiveness } from "../execution-liveness.js";

export type RegistryFamily = "workflow_tools" | "workflow_profiles" | "artifact_contract_policy" | "fan_in_policy" | "constitution_gate" | "constitution_providers" | "format_recognizers" | "document_renderers" | "specification_renderers" | "visual_renderers" | "escalation_adapters" | "runtime_config";
export type WorkflowCapability = "workflow_registration" | "workflow_tools" | "config_writer" | (string & {});
export type WorkflowOwnerKind = "fullstack" | "private_omp" | (string & {});
export interface WorkflowOwnerActivationRequirement { readonly path: string; readonly kind: "file" | "directory"; readonly sha256?: string; }
export interface WorkflowOwnerActivation { readonly marker_id: string; readonly required: readonly WorkflowOwnerActivationRequirement[]; }
export interface WorkflowOwnerProvenance { readonly package: string; readonly entrypoint: string; readonly cwd: string; readonly config_path?: string; }
export interface WorkflowOwnerIdentity { readonly owner_id: string; readonly bundle_id: string; readonly owner_kind: WorkflowOwnerKind; readonly activation_marker: string; readonly host_range: string; readonly activation?: WorkflowOwnerActivation; readonly provenance: WorkflowOwnerProvenance; }
export interface WorkflowOwnerClaim { readonly project_root: string; readonly project_root_dev: number; readonly project_root_ino: number; readonly capability: WorkflowCapability; readonly fingerprint: string; readonly principal_fingerprint: string; readonly owner: WorkflowOwnerIdentity; }
const registryContextBrand = Symbol("omp.registry.context");
const registryTokenBrand = Symbol("omp.registry.token");
const registryPrincipalBrand = Symbol("omp.registry.principal");
const releaseTokenBrand = Symbol("omp.registry.release");
export interface RegistryRegistrationContext { readonly [registryContextBrand]: true; }
/** Detached, non-authorizing evidence for one marker-authenticated owner context. */
export interface RegistryContextSnapshot { readonly canonical_root: string; readonly root_dev: number; readonly root_ino: number; readonly owner_fingerprint: string; readonly principal_fingerprint: string; readonly claim_generation: number; readonly marker_generation: number; readonly marker_digest: string; }
export interface RegistryRegistrationToken { readonly [registryTokenBrand]: true; }
/** Stable opaque, non-authorizing identity for one live marker-authenticated activation/claim lifecycle. */
export interface RegistryRegistrationPrincipal { readonly [registryPrincipalBrand]: true; }
export interface WorkflowOwnerReleaseToken { readonly [releaseTokenBrand]: true; }
export type WorkflowOwnerSource = WorkflowOwnerIdentity | ((projectRoot: string) => WorkflowOwnerIdentity);
export type WorkflowOwnerClaimResult = { readonly ok: true; readonly claim: WorkflowOwnerClaim; readonly idempotent: boolean; readonly newly_claimed: readonly WorkflowCapability[]; readonly leased_capabilities: readonly WorkflowCapability[]; readonly release_token: WorkflowOwnerReleaseToken; } | { readonly ok: false; readonly code: "owner_invalid" | "owner_conflict"; readonly error: string; readonly claim?: WorkflowOwnerClaim; };
export type WorkflowActivationResult = ({ readonly ok: true; readonly registry_context: RegistryRegistrationContext } & Extract<WorkflowOwnerClaimResult, { readonly ok: true }>) | { readonly ok: false; readonly code: "activation_markers_missing" | "activation_identity_changed" | "owner_invalid" | "owner_conflict"; readonly error: string; readonly claim?: WorkflowOwnerClaim };
export interface WorkflowOwnerReleaseResult { readonly project_root: string | undefined; readonly released: readonly WorkflowCapability[]; readonly skipped: readonly WorkflowCapability[]; }

type RootIdentity = { canonical: string; dev: number; ino: number };
function rootKey(root: Pick<RootIdentity, "dev" | "ino">): string {
  return `${root.dev}\u0000${root.ino}`;
}
type MarkerObservation = { path: string; kind: "file" | "directory"; dev: number; ino: number; sha256?: string };
type ActivationSnapshot = { root: RootIdentity; activation: WorkflowOwnerActivation; observations: readonly MarkerObservation[]; marker_generation: number; digest: string };
type ClaimCell = WorkflowOwnerClaim & { generation: number; principal: RegistryRegistrationPrincipal; marker_generation: number; marker_digest: string; leases: Set<ReleaseCell> };
type ClaimHandle = { root: RootIdentity; fingerprint: string; principal_fingerprint: string; principal: RegistryRegistrationPrincipal; capabilities: readonly WorkflowCapability[]; capability_generations: ReadonlyMap<WorkflowCapability, number>; generation: number; marker_snapshot: string; marker_digest: string; release: ReleaseCell };
type ContextCell = { root: RootIdentity; fingerprint: string; principal_fingerprint: string; principal: RegistryRegistrationPrincipal; capabilities: readonly WorkflowCapability[]; capability_generations: ReadonlyMap<WorkflowCapability, number>; generation: number; activation?: ActivationSnapshot; marker_generation: number; marker_snapshot: string; marker_digest: string; release: ReleaseCell; open: boolean };
type TokenCell = { context: RegistryRegistrationContext; root: RootIdentity; fingerprint: string; principal_fingerprint: string; principal: RegistryRegistrationPrincipal; generation: number; marker_generation: number; marker_digest: string; families: ReadonlySet<RegistryFamily>; undo: Array<() => void>; commits: Array<() => void>; committing: boolean; open: boolean; opened_at: number; last_used_at: number; revoked_code?: "owner_conflict" | "activation_identity_changed"; revoked_error?: string };
type ReleaseCell = { root: RootIdentity; fingerprint: string; owner: WorkflowOwnerIdentity; capabilities: readonly WorkflowCapability[]; generations: ReadonlyMap<WorkflowCapability, number>; remaining: Set<WorkflowCapability>; context?: ContextCell; revoked: boolean };

export const MAX_ACTIVATION_REQUIREMENTS = 64;
export const MAX_ACTIVATION_MARKER_ID_BYTES = 4096;
export const MAX_ACTIVATION_MARKER_PATH_BYTES = 4096;
export const MAX_ACTIVATION_MARKER_FILE_BYTES = 1024 * 1024;
const MAX_CAPABILITIES = 64;
export const MAX_ACTIVATION_LEASES_PER_CLAIM = 64;
const MAX_CAPABILITY_BYTES = 128;
const MAX_CLAIMS_PER_ROOT = 64;
const MAX_ACTIVE_ROOTS = 256;
const MAX_REGISTRY_CALLBACKS = 256;
const MAX_OPEN_TOKENS_PER_CONTEXT = 8;
const MAX_OPEN_TOKENS_PER_ROOT = 8;
const MAX_OPEN_REGISTRY_TOKENS = MAX_ACTIVE_ROOTS * MAX_OPEN_TOKENS_PER_ROOT;
const REGISTRY_TOKEN_TTL_MS = 30 * 1000;
const REGISTRY_FAMILIES: Record<RegistryFamily, true> = {
  workflow_tools: true,
  workflow_profiles: true,
  artifact_contract_policy: true,
  fan_in_policy: true,
  constitution_gate: true,
  constitution_providers: true,
  format_recognizers: true,
  document_renderers: true,
  specification_renderers: true,
  visual_renderers: true,
  escalation_adapters: true,
  runtime_config: true
};
const owners = new Map<string, Map<WorkflowCapability, ClaimCell>>();
const claimHandles = new WeakMap<object, ClaimHandle>();
const contexts = new WeakMap<object, ContextCell>();
const tokens = new WeakMap<object, TokenCell>();
const releaseTokens = new WeakMap<object, ReleaseCell>();
const functionIds = new WeakMap<Function, number>();
const contextCells = new Set<ContextCell>();
const tokenCells = new Set<TokenCell>();
let nextGeneration = 1;
let nextMarkerGeneration = 1;
let nextFunctionId = 1;
function failure(code: string, message: string): Error & { code: string } {
  const error = new Error(message) as Error & { code: string };
  error.code = code;
  return error;
}
function canonicalProjectRoot(projectRoot: string): RootIdentity {
  if (typeof projectRoot !== "string" || projectRoot.trim().length === 0) throw failure("owner_invalid", "project root is required");
  const lexical = resolve(projectRoot);
  if (!existsSync(lexical)) throw failure("owner_invalid", "project root does not exist");
  const canonical = realpathSync(lexical);
  const stat = statSync(canonical);
  if (!stat.isDirectory()) throw failure("owner_invalid", "project root is not a directory");
  return { canonical, dev: stat.dev, ino: stat.ino };
}
function rootIsCurrent(root: RootIdentity): boolean {
  try {
    const current = canonicalProjectRoot(root.canonical);
    return current.canonical === root.canonical && current.dev === root.dev && current.ino === root.ino;
  } catch {
    return false;
  }
}
function canonicalConfigPath(configPath: string): string {
  const resolved = resolve(configPath);
  if (basename(resolved) !== "team.config.json" || basename(dirname(resolved)) !== ".omp") return resolved;
  try {
    return join(canonicalProjectRoot(dirname(dirname(resolved))).canonical, ".omp", "team.config.json");
  } catch {
    return resolved;
  }
}
function canonicalize(value: unknown, seen: WeakSet<object> = new WeakSet<object>()): unknown {
  if (typeof value === "function") {
    const fn = value;
    let id = functionIds.get(fn);
    if (id === void 0) {
      id = nextFunctionId++;
      functionIds.set(fn, id);
    }
    return { $function: id };
  }
  if (Array.isArray(value)) return value.map((entry) => canonicalize(entry, seen));
  if (value && typeof value === "object") {
    if (seen.has(value)) return { $cycle: true };
    seen.add(value);
    return Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right)).map(([key, entry]) => [key, canonicalize(entry, seen)]));
  }
  return value;
}
export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value)) ?? "null";
}
export function descriptorFingerprint(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}
function withoutRootBinding(owner: WorkflowOwnerIdentity): unknown {
  return {
    owner_id: owner.owner_id,
    bundle_id: owner.bundle_id,
    owner_kind: owner.owner_kind,
    activation_marker: owner.activation_marker,
    host_range: owner.host_range,
    ...owner.activation ? { activation: owner.activation } : {},
    provenance: {
      package: owner.provenance.package,
      entrypoint: owner.provenance.entrypoint
    }
  };
}
export function principalFingerprint(owner: WorkflowOwnerIdentity): string {
  return descriptorFingerprint(withoutRootBinding(owner));
}
function cloneAndFreezeInternal(value: unknown, seen: WeakMap<object, object> = new WeakMap<object, object>()): unknown {
  if (typeof value === "function" || value === null || typeof value !== "object") return value;
  const existing = seen.get(value);
  if (existing !== void 0) return existing;
  if (Array.isArray(value)) {
    const copy2: unknown[] = [];
    seen.set(value, copy2);
    for (const entry of value) copy2.push(cloneAndFreezeInternal(entry, seen));
    return Object.freeze(copy2);
  }
  const copy = Object.create(Object.getPrototypeOf(value) === null ? null : Object.prototype) as Record<string, unknown>;
  seen.set(value, copy);
  for (const [key, entry] of Object.entries(value)) copy[key] = cloneAndFreezeInternal(entry, seen);
  return Object.freeze(copy);
}
export function cloneAndFreeze<T>(value: T): T {
  return cloneAndFreezeInternal(value) as T;
}
function detached<T>(value: T): T {
  return cloneAndFreeze(value);
}
function boundedTextField(label: string, value: unknown, maxBytes: number): { ok: true; value: string } | { ok: false; error: string } {
  if (typeof value !== "string" || value.trim().length === 0) return { ok: false, error: `${label} is required` };
  if (Buffer.byteLength(value, "utf8") > maxBytes) return { ok: false, error: `${label} exceeds the UTF-8 byte limit` };
  if (/[\u0000-\u001f\u007f]/u.test(value)) return { ok: false, error: `${label} contains control characters` };
  return { ok: true, value };
}
function normalizeCapabilityArray(capabilities: unknown): { ok: true; value: WorkflowCapability[] } | { ok: false; error: string } {
  if (!Array.isArray(capabilities)) return { ok: false, error: "workflow capabilities must be an array" };
  let length: number;
  try { length = capabilities.length; } catch { return { ok: false, error: "workflow capabilities array is invalid" }; }
  if (!Number.isSafeInteger(length) || length === 0) return { ok: false, error: "at least one workflow capability is required" };
  if (length > MAX_CAPABILITIES) return { ok: false, error: `workflow capabilities are bounded at ${MAX_CAPABILITIES}` };
  const values: WorkflowCapability[] = [];
  const seen = new Set<WorkflowCapability>();
  for (let index = 0; index < length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(capabilities, String(index));
    if (!descriptor || !Object.hasOwn(descriptor, "value")) return { ok: false, error: "workflow capabilities must be dense data properties" };
    const capability = descriptor.value;
    if (typeof capability !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(capability)) return { ok: false, error: "workflow capability name is invalid" };
    if (Buffer.byteLength(capability, "utf8") > MAX_CAPABILITY_BYTES) return { ok: false, error: "workflow capability name exceeds the UTF-8 byte limit" };
    if (!seen.has(capability)) { seen.add(capability); values.push(capability); }
  }
  if (Object.keys(capabilities).some((key) => !/^(0|[1-9]\d*)$/u.test(key) || Number(key) >= length) || Object.getOwnPropertySymbols(capabilities).length > 0) return { ok: false, error: "workflow capabilities has unknown properties" };
  return { ok: true, value: values };
}
function normalizeCapabilities(capabilities: readonly WorkflowCapability[]): { ok: true; value: WorkflowCapability[] } | { ok: false; error: string } {
  const normalized = normalizeCapabilityArray(capabilities);
  if (!normalized.ok) return normalized;
  if (!normalized.value.includes("workflow_registration")) return { ok: false, error: "workflow_registration capability is required" };
  return normalized;
}

function discardOwnerIdentityClaims(key: string, registry: Map<WorkflowCapability, ClaimCell>, dev?: number, ino?: number): void {
  for (const contextCell of [...contextCells]) {
    if (rootKey(contextCell.root) !== key) continue;
    if (dev !== undefined && ino !== undefined && contextCell.root.dev === dev && contextCell.root.ino === ino) continue;
    revokeContextCell(contextCell, "activation_identity_changed", "project root identity changed");
  }
  for (const [capability, claim] of [...registry]) {
    if (dev !== undefined && ino !== undefined && claim.project_root_dev === dev && claim.project_root_ino === ino) continue;
    for (const release of [...claim.leases]) {
      release.revoked = true;
      release.remaining.clear();
      claim.leases.delete(release);
    }
    registry.delete(capability);
  }
  if (registry.size === 0) owners.delete(key);
}
function contextClaimsAreLive(cell: ContextCell): boolean {
  if (cell.release.revoked || cell.release.remaining.size === 0) return false;
  const registry = owners.get(rootKey(cell.root));
  if (!registry) return false;
  for (const capability of cell.release.remaining) {
    const claim = registry.get(capability);
    if (!claim || claim.generation !== cell.capability_generations.get(capability) || !claim.leases.has(cell.release)) return false;
  }
  return true;
}
function sweepStaleOwnerRoots(): void {
  const currentRoots = new Map<string, RootIdentity | undefined>();
  const currentRoot = (canonical: string): RootIdentity | undefined => {
    if (currentRoots.has(canonical)) return currentRoots.get(canonical);
    let current: RootIdentity | undefined;
    try { current = canonicalProjectRoot(canonical); } catch { current = undefined; }
    currentRoots.set(canonical, current);
    return current;
  };
  for (const contextCell of [...contextCells]) {
    const current = currentRoot(contextCell.root.canonical);
    if (!current || current.dev !== contextCell.root.dev || current.ino !== contextCell.root.ino || !contextClaimsAreLive(contextCell)) {
      revokeContextCell(contextCell, "activation_identity_changed", "project root identity changed");
    }
  }
  for (const token of [...tokenCells]) {
    const contextCell = contexts.get(token.context);
    const current = currentRoot(token.root.canonical);
    if (!contextCell || !contextCell.open || !current || current.dev !== token.root.dev || current.ino !== token.root.ino) {
      revokeTokenCell(token, true, "activation_identity_changed", "project root identity changed");
    }
  }
  for (const [key, registry] of [...owners]) {
    const representative = [...registry.values()][0];
    if (!representative) { owners.delete(key); continue; }
    const current = currentRoot(representative.project_root);
    if (!current || rootKey(current) !== key) discardOwnerIdentityClaims(key, registry, current?.dev, current?.ino);
  }
}
function normalizeActivation(activation: WorkflowOwnerActivation | undefined): { ok: true; value?: WorkflowOwnerActivation } | { ok: false; error: string } {
  if (activation === void 0) return { ok: true };
  if (!activation || typeof activation !== "object" || typeof activation.marker_id !== "string" || activation.marker_id.trim().length === 0 || !Array.isArray(activation.required) || activation.required.length === 0) return { ok: false, error: "activation marker descriptor is invalid" };
  if (Buffer.byteLength(activation.marker_id, "utf8") > MAX_ACTIVATION_MARKER_ID_BYTES) return { ok: false, error: "activation marker_id exceeds the UTF-8 byte limit" };
  if (/[\u0000-\u001f\u007f]/u.test(activation.marker_id)) return { ok: false, error: "activation marker_id contains control characters" };
  if (activation.required.length > MAX_ACTIVATION_REQUIREMENTS) return { ok: false, error: "activation marker has too many requirements" };
  const required = [];
  const paths = /* @__PURE__ */ new Set();
  for (const entry of activation.required) {
    if (!entry || typeof entry !== "object" || typeof entry.path !== "string" || entry.path.length === 0 || entry.kind !== "file" && entry.kind !== "directory") return { ok: false, error: "activation marker requirement is invalid" };
    if (Buffer.byteLength(entry.path, "utf8") > MAX_ACTIVATION_MARKER_PATH_BYTES) return { ok: false, error: "activation marker path exceeds the UTF-8 byte limit" };
    if (/[\u0000-\u001f\u007f]/u.test(entry.path)) return { ok: false, error: "activation marker path contains control characters" };
    if (paths.has(entry.path)) return { ok: false, error: "activation marker requirements contain a duplicate path" };
    paths.add(entry.path);
    if (entry.sha256 !== void 0 && (entry.kind !== "file" || !/^[0-9a-f]{64}$/u.test(entry.sha256))) return { ok: false, error: "activation marker digest is invalid" };
    required.push({ path: entry.path, kind: entry.kind, ...entry.sha256 === void 0 ? {} : { sha256: entry.sha256 } });
  }
  return { ok: true, value: detached({ marker_id: activation.marker_id, required }) };
}
function normalizedOwner(root: RootIdentity, owner: WorkflowOwnerIdentity): { ok: true; value: WorkflowOwnerIdentity } | { ok: false; error: string } {
  if (!owner || typeof owner !== "object") return { ok: false, error: "owner is required" };
  const activation = normalizeActivation(owner.activation);
  if (!activation.ok) return activation;
  const boundedFields: Array<[string, unknown, number]> = [
    ["owner_id", owner.owner_id, 256],
    ["bundle_id", owner.bundle_id, 256],
    ["owner_kind", owner.owner_kind, 256],
    ["activation_marker", owner.activation_marker, 256],
    ["host_range", owner.host_range, 256],
    ["provenance.package", owner.provenance?.package, 256],
    ["provenance.entrypoint", owner.provenance?.entrypoint, 256],
    ["provenance.cwd", owner.provenance?.cwd, 4096],
  ];
  for (const [label, value, maxBytes] of boundedFields) {
    const checked = boundedTextField(label, value, maxBytes);
    if (!checked.ok) return checked;
  }
  if (owner.provenance?.config_path !== undefined) {
    const checked = boundedTextField("provenance.config_path", owner.provenance.config_path, 4096);
    if (!checked.ok) return checked;
  }
  if (owner.activation && owner.activation.marker_id !== owner.activation_marker) return { ok: false, error: "activation marker_id does not match activation_marker" };
  let cwd;
  try {
    cwd = canonicalProjectRoot(owner.provenance.cwd);
  } catch {
    return { ok: false, error: "owner provenance cwd is not a canonical project root" };
  }
  if (cwd.canonical !== root.canonical || cwd.dev !== root.dev || cwd.ino !== root.ino) return { ok: false, error: "owner provenance cwd does not match project root" };
  if (owner.provenance.config_path && canonicalConfigPath(owner.provenance.config_path) !== join(root.canonical, ".omp", "team.config.json")) return { ok: false, error: "owner provenance config_path does not belong to project root" };
  return {
    ok: true,
    value: detached({
      owner_id: owner.owner_id,
      bundle_id: owner.bundle_id,
      owner_kind: owner.owner_kind,
      activation_marker: owner.activation_marker,
      host_range: owner.host_range,
      ...activation.value ? { activation: activation.value } : {},
      provenance: {
        package: owner.provenance.package,
        entrypoint: owner.provenance.entrypoint,
        cwd: root.canonical,
        ...owner.provenance.config_path ? { config_path: canonicalConfigPath(owner.provenance.config_path) } : {}
      }
    })
  };
}
function claimCell(
  root: RootIdentity,
  capability: WorkflowCapability,
  owner: WorkflowOwnerIdentity,
  fingerprint: string,
  principalFingerprintValue: string,
  principal: RegistryRegistrationPrincipal,
  activation: ActivationSnapshot,
): ClaimCell {
  return {
    project_root: root.canonical,
    project_root_dev: root.dev,
    project_root_ino: root.ino,
    capability,
    fingerprint,
    principal_fingerprint: principalFingerprintValue,
    owner: detached(owner),
    generation: nextGeneration++,
    principal,
    marker_generation: activation.marker_generation,
    marker_digest: activation.digest,
    leases: new Set(),
  };
}
function markerPathSafe(root: string, path: string): boolean {
  if (path.trim() !== path || path.length === 0 || path.includes("\0") || path.includes("\\") || isAbsolute(path)) return false;
  const segments = path.split("/");
  if (segments.some((segment) => segment.length === 0 || segment === "." || segment === "..")) return false;
  const resolved = resolve(root, path);
  const escaped = relative(root, resolved);
  return escaped === path && !escaped.startsWith(`..${"/"}`) && !isAbsolute(escaped);
}
function lstatPhysicalMarker(root: string, path: string): Stats {
  let cursor = root;
  let result;
  for (const segment of path.split("/")) {
    cursor = join(cursor, segment);
    const stats = lstatSync(cursor);
    if (stats.isSymbolicLink()) throw new Error("activation marker path contains a symlink");
    if (result && !result.isDirectory()) throw new Error("activation marker parent is not a directory");
    result = stats;
  }
  if (!result) throw new Error("activation marker path is empty");
  return result;
}
function markerGeneration(root: RootIdentity, digest: string): number {
  for (const registry of owners.values()) {
    for (const claim of registry.values()) {
      if (claim.project_root === root.canonical && claim.project_root_dev === root.dev && claim.project_root_ino === root.ino && claim.marker_digest === digest) return claim.marker_generation;
    }
  }
  for (const cell of contextCells) {
    if (cell.open && cell.root.canonical === root.canonical && cell.root.dev === root.dev && cell.root.ino === root.ino && cell.marker_digest === digest) return cell.marker_generation;
  }
  for (const cell of tokenCells) {
    if (cell.open && cell.root.canonical === root.canonical && cell.root.dev === root.dev && cell.root.ino === root.ino && cell.marker_digest === digest) return cell.marker_generation;
  }
  return nextMarkerGeneration++;
}
function readPhysicalMarkerFile(root: string, path: string, expected: Stats): string {
  let descriptor;
  try {
    descriptor = openSync(join(root, path), constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const opened = fstatSync(descriptor);
    if (!opened.isFile() || opened.dev !== expected.dev || opened.ino !== expected.ino) throw new Error("activation marker file changed while reading");
    if (!Number.isSafeInteger(opened.size) || opened.size > MAX_ACTIVATION_MARKER_FILE_BYTES) throw new Error("activation marker file exceeds the byte limit");
    const bytes = Buffer.alloc(opened.size);
    let offset = 0;
    while (offset < bytes.length) {
      const count = readSync(descriptor, bytes, offset, bytes.length - offset, null);
      if (count <= 0) throw new Error("activation marker file changed while reading");
      offset += count;
    }
    const after = fstatSync(descriptor);
    if (!after.isFile() || after.dev !== expected.dev || after.ino !== expected.ino || after.size !== opened.size) throw new Error("activation marker file changed while reading");
    return createHash("sha256").update(bytes).digest("hex");
  } finally {
    if (descriptor !== void 0) closeSync(descriptor);
  }
}
function activationSnapshot(root: RootIdentity, owner: WorkflowOwnerIdentity, revalidate = false): { ok: true; value: ActivationSnapshot } | { ok: false; code: "activation_markers_missing" | "activation_identity_changed"; error: string } {
  const activation = owner.activation;
  const missingCode = revalidate ? "activation_identity_changed" : "activation_markers_missing";
  const fail = (error: string): { ok: false; code: "activation_markers_missing" | "activation_identity_changed"; error: string } => ({ ok: false, code: missingCode, error });
  if (!activation) return fail("activation marker descriptor is missing");
  const observations = [];
  try {
    for (const requirement of activation.required) {
      if (!markerPathSafe(root.canonical, requirement.path)) return fail("activation marker path is unsafe");
      const stats = lstatPhysicalMarker(root.canonical, requirement.path);
      if (requirement.kind === "file" && !stats.isFile()) return fail("activation marker file is missing or has the wrong kind");
      if (requirement.kind === "directory" && !stats.isDirectory()) return fail("activation marker directory is missing or has the wrong kind");
      const digest2 = requirement.kind === "file" ? readPhysicalMarkerFile(root.canonical, requirement.path, stats) : void 0;
      if (requirement.sha256 !== void 0 && digest2 !== requirement.sha256) return fail("activation marker digest does not match");
      observations.push({ path: requirement.path, kind: requirement.kind, dev: stats.dev, ino: stats.ino, ...digest2 ? { sha256: digest2 } : {} });
    }
    for (let index = 0; index < activation.required.length; index += 1) {
      const requirement = activation.required[index]!;
      const expected = observations[index]!;
      const stats = lstatPhysicalMarker(root.canonical, requirement.path);
      const digest2 = requirement.kind === "file" ? readPhysicalMarkerFile(root.canonical, requirement.path, stats) : void 0;
      if (stats.dev !== expected.dev || stats.ino !== expected.ino || (digest2 ?? void 0) !== (expected.sha256 ?? void 0)) return fail("activation marker identity changed while validating");
    }
  } catch (error: unknown) {
    return fail(error instanceof Error ? error.message : "activation marker is unreadable");
  }
  const currentRoot = (() => {
    try {
      return canonicalProjectRoot(root.canonical);
    } catch {
      return void 0;
    }
  })();
  if (!currentRoot || currentRoot.canonical !== root.canonical || currentRoot.dev !== root.dev || currentRoot.ino !== root.ino) return { ok: false, code: "activation_identity_changed", error: "project root changed while validating activation markers" };
  const digest = descriptorFingerprint({ marker_id: activation.marker_id, required: observations });
  return { ok: true, value: { root, activation, observations: Object.freeze(observations), marker_generation: markerGeneration(root, digest), digest } };
}
function contextFor(snapshot: ActivationSnapshot, handle: ClaimHandle): RegistryRegistrationContext {
  const context = Object.freeze(/* @__PURE__ */ Object.create(null));
  const cell = {
    root: handle.root,
    fingerprint: handle.fingerprint,
    principal_fingerprint: handle.principal_fingerprint,
    principal: handle.principal,
    capabilities: Object.freeze([...handle.capabilities]),
    capability_generations: handle.capability_generations,
    generation: handle.generation,
    activation: snapshot,
    marker_generation: snapshot.marker_generation,
    marker_snapshot: handle.marker_snapshot,
    marker_digest: snapshot.digest,
    release: handle.release,
    open: true
  };
  handle.release.context = cell;
  contexts.set(context, cell);
  contextCells.add(cell);
  return context;
}
function claimWorkflowOwnersCore(projectRoot: string, capabilities: readonly WorkflowCapability[], owner: WorkflowOwnerIdentity, activation: ActivationSnapshot): WorkflowOwnerClaimResult {
  let root;
  try {
    root = canonicalProjectRoot(projectRoot);
  } catch (error) {
    return { ok: false, code: "owner_invalid", error: String(error instanceof Error ? error.message : error) };
  }
  const normalized = normalizedOwner(root, owner);
  if (!normalized.ok) return { ok: false, code: "owner_invalid", error: normalized.error };
  const normalizedCapabilities = normalizeCapabilities(capabilities);
  if (!normalizedCapabilities.ok) return { ok: false, code: "owner_invalid", error: normalizedCapabilities.error };
  const requested = normalizedCapabilities.value;
  sweepStaleOwnerRoots();
  const key = rootKey(root);
  if (!owners.has(key) && owners.size >= MAX_ACTIVE_ROOTS) {
    if (owners.size >= MAX_ACTIVE_ROOTS) return { ok: false, code: "owner_invalid", error: `active owner roots are bounded at ${MAX_ACTIVE_ROOTS}` };
  }
  const fingerprint = descriptorFingerprint(normalized.value);
  const principal = principalFingerprint(normalized.value);
  const registry = owners.get(key) ?? new Map<WorkflowCapability, ClaimCell>();
  // A pathname may be reused for a new physical root while old capabilities
  // remain in the canonical map. Remove every old-identity claim first so
  // unrequested stale capabilities cannot poison the current registration.
  discardOwnerIdentityClaims(key, registry, root.dev, root.ino);
  // A marker change invalidates every prior activation lease for this root;
  // detach those contexts before replacing stale claims, while preserving
  // unrelated roots and owner principals.
  for (const contextCell of [...contextCells]) {
    if (contextCell.root.canonical === root.canonical
      && contextCell.root.dev === root.dev
      && contextCell.root.ino === root.ino
      && contextCell.fingerprint === fingerprint
      && contextCell.marker_digest !== activation.digest) {
      revokeContextCell(contextCell, "activation_identity_changed", "activation marker identity changed");
    }
  }
  const principalIdentity = [...registry.values()].find((claim) => claim.principal_fingerprint === principal
    && claim.marker_digest === activation.digest
    && claim.marker_generation === activation.marker_generation)?.principal
    ?? Object.freeze(Object.create(null)) as RegistryRegistrationPrincipal;
  for (const capability of requested) {
    const prior = registry.get(capability);
    if (prior && (prior.fingerprint !== fingerprint || prior.project_root_dev !== root.dev || prior.project_root_ino !== root.ino)) {
      const samePrincipal = prior.principal_fingerprint === principal;
      const stalePhysicalRoot = prior.project_root === root.canonical && (prior.project_root_dev !== root.dev || prior.project_root_ino !== root.ino);
      if (!samePrincipal || !stalePhysicalRoot) {
        return { ok: false, code: "owner_conflict", error: `generic workflow capability '${capability}' is already owned by '${prior.owner.owner_id}'`, claim: detached(prior) };
      }
    }
  }
  for (const capability of requested) {
    const prior = registry.get(capability);
    const stalePhysicalRoot = prior !== void 0
      && prior.project_root === root.canonical
      && (prior.project_root_dev !== root.dev || prior.project_root_ino !== root.ino)
      && prior.principal_fingerprint === principal;
    const staleMarker = prior !== void 0
      && prior.project_root === root.canonical
      && prior.project_root_dev === root.dev
      && prior.project_root_ino === root.ino
      && prior.principal_fingerprint === principal
      && prior.leases.size === 0
      && (prior.marker_digest !== activation.digest || prior.marker_generation !== activation.marker_generation);
    const activeLeaseCount = prior === void 0 || stalePhysicalRoot || staleMarker ? 0 : prior.leases.size;
    if (activeLeaseCount >= MAX_ACTIVATION_LEASES_PER_CLAIM) {
      return { ok: false, code: "owner_invalid", error: `activation leases for workflow capability '${capability}' are bounded at ${MAX_ACTIVATION_LEASES_PER_CLAIM}` };
    }
  }
  const additionalClaims = requested.filter((capability) => !registry.has(capability));
  if (registry.size + additionalClaims.length > MAX_CLAIMS_PER_ROOT) {
    return { ok: false, code: "owner_invalid", error: `workflow claims per root are bounded at ${MAX_CLAIMS_PER_ROOT}` };
  }
  const newlyClaimed = [];
  for (const capability of requested) {
    const prior = registry.get(capability);
    const stalePhysicalRoot = prior !== void 0 && prior.project_root === root.canonical && (prior.project_root_dev !== root.dev || prior.project_root_ino !== root.ino) && prior.principal_fingerprint === principal;
    const staleMarker = prior !== void 0 && prior.project_root === root.canonical && prior.project_root_dev === root.dev && prior.project_root_ino === root.ino
      && prior.principal_fingerprint === principal
      && prior.leases.size === 0
      && (prior.marker_digest !== activation.digest || prior.marker_generation !== activation.marker_generation);
    if (!prior || stalePhysicalRoot || staleMarker) {
      registry.set(capability, claimCell(root, capability, normalized.value, fingerprint, principal, principalIdentity, activation));
      newlyClaimed.push(capability);
    }
  }
  owners.set(key, registry);
  const first = registry.get(requested[0]!);
  if (!first) return { ok: false, code: "owner_invalid", error: "owner claim could not be stored" };
  const generations = new Map(requested.map((capability) => [capability, registry.get(capability)!.generation]));
  const releaseToken = Object.freeze(/* @__PURE__ */ Object.create(null));
  const release: ReleaseCell = { root, fingerprint, owner: normalized.value, capabilities: Object.freeze([...requested]), generations, remaining: new Set(requested), revoked: false };
  releaseTokens.set(releaseToken, release);
  for (const capability of requested) registry.get(capability)!.leases.add(release);
  const registration = registry.get("workflow_registration");
  const markerOwner = registration?.owner ?? first.owner;
  const publicClaim = detached(first);
  claimHandles.set(publicClaim, {
    root,
    fingerprint,
    principal_fingerprint: principal,
    principal: principalIdentity,
    capabilities: Object.freeze([...requested]),
    capability_generations: generations,
    generation: registration?.generation ?? first.generation,
    marker_snapshot: markerOwner.activation_marker,
    marker_digest: descriptorFingerprint(markerOwner.activation_marker),
    release,
  });
  return Object.freeze({ ok: true, claim: publicClaim, idempotent: newlyClaimed.length === 0, newly_claimed: Object.freeze([...newlyClaimed]), leased_capabilities: Object.freeze([...requested]), release_token: releaseToken });
}
export function openWorkflowActivation(projectRoot: string, capabilities: readonly WorkflowCapability[], ownerSource: WorkflowOwnerSource): WorkflowActivationResult {
  const normalizedCapabilities = normalizeCapabilities(capabilities);
  if (!normalizedCapabilities.ok) return { ok: false, code: "owner_invalid", error: normalizedCapabilities.error };
  let root;
  try {
    root = canonicalProjectRoot(projectRoot);
  } catch (error) {
    return { ok: false, code: "activation_markers_missing", error: String(error instanceof Error ? error.message : error) };
  }
  let owner;
  try {
    owner = typeof ownerSource === "function" ? ownerSource(root.canonical) : ownerSource;
  } catch (error) {
    return { ok: false, code: "activation_markers_missing", error: error instanceof Error ? error.message : "activation owner could not be resolved" };
  }
  const normalized = normalizedOwner(root, owner);
  if (!normalized.ok) return { ok: false, code: "owner_invalid", error: normalized.error };
  const snapshot = activationSnapshot(root, normalized.value);
  if (!snapshot.ok) return snapshot;
  const claim = claimWorkflowOwnersCore(root.canonical, normalizedCapabilities.value, normalized.value, snapshot.value);
  if (!claim.ok) return claim;
  const finalSnapshot = activationSnapshot(root, normalized.value, true);
  if (!finalSnapshot.ok || finalSnapshot.value.digest !== snapshot.value.digest) {
    releaseWorkflowOwners(claim.release_token, normalizedCapabilities.value);
    return !finalSnapshot.ok ? finalSnapshot : { ok: false, code: "activation_identity_changed", error: "activation marker identity changed before owner claim" };
  }
  const handle = claimHandles.get(claim.claim);
  if (!handle) return { ok: false, code: "owner_invalid", error: "owner claim context could not be issued" };
  const context = contextFor(snapshot.value, handle);
  claimHandles.delete(claim.claim as object);
  return Object.freeze({ ...claim, registry_context: context });
}
function liveWorkflowRegistration(cell: ContextCell): ClaimCell | undefined {
  const claim = owners.get(rootKey(cell.root))?.get("workflow_registration");
  if (!cell.release.remaining.has("workflow_registration") || !claim || !claim.leases.has(cell.release) || claim.fingerprint !== cell.fingerprint || claim.generation !== cell.generation) return void 0;
  if (claim.project_root_dev !== cell.root.dev || claim.project_root_ino !== cell.root.ino) return void 0;
  if (claim.owner.activation_marker !== cell.marker_snapshot) return void 0;
  if (!claim.owner.activation || !cell.activation) return void 0;
  if (descriptorFingerprint(claim.owner.activation) !== descriptorFingerprint(cell.activation.activation)) return void 0;
  if (claim.marker_generation !== cell.marker_generation || claim.marker_digest !== cell.marker_digest) return void 0;
  return claim;
}
function sweepStaleRegistryTokens(now = Date.now()): void {
  for (const cell of [...tokenCells]) {
    if (!cell.open) {
      tokenCells.delete(cell);
      continue;
    }
    const context = contexts.get(cell.context);
    let current: RootIdentity | undefined;
    try { current = canonicalProjectRoot(cell.root.canonical); } catch { current = undefined; }
    const expired = now - Math.max(cell.opened_at, cell.last_used_at) >= REGISTRY_TOKEN_TTL_MS;
    const rootChanged = !current || current.dev !== cell.root.dev || current.ino !== cell.root.ino;
    if (expired || !context?.open || rootChanged) {
      revokeTokenCell(cell, true, rootChanged ? "activation_identity_changed" : "owner_conflict", rootChanged ? "project root identity changed" : "registration token expired");
    }
  }
}

function revokeTokenCell(cell: TokenCell, undo = true, revokedCode?: "owner_conflict" | "activation_identity_changed", revokedError?: string): void {
  if (!cell.open) {
    tokenCells.delete(cell);
    return;
  }
  cell.open = false;
  if (revokedCode) {
    cell.revoked_code = revokedCode;
    cell.revoked_error = revokedError;
  }
  tokenCells.delete(cell);
  if (undo) {
    for (let index = cell.undo.length - 1; index >= 0; index -= 1) {
      try {
        cell.undo[index]!();
      } catch {
      }
    }
  }
  cell.undo.length = 0;
  cell.commits.length = 0;
  cell.committing = false;
}
function detachReleaseLease(release: ReleaseCell): void {
  if (release.revoked) return;
  release.revoked = true;
  release.remaining.clear();
  const registry = owners.get(rootKey(release.root));
  if (!registry) return;
  for (const capability of release.capabilities) {
    const claim = registry.get(capability);
    if (!claim || claim.fingerprint !== release.fingerprint || claim.generation !== release.generations.get(capability)) continue;
    claim.leases.delete(release);
    if (claim.leases.size === 0) registry.delete(capability);
  }
  if (registry.size === 0) owners.delete(rootKey(release.root));
}

function revokeContextCell(cell: ContextCell, revokedCode: "owner_conflict" | "activation_identity_changed" = "owner_conflict", revokedError = "owner context is no longer active", detachLeases = true): void {
  if (!cell.open) {
    contextCells.delete(cell);
    if (detachLeases) detachReleaseLease(cell.release);
    return;
  }
  cell.open = false;
  contextCells.delete(cell);
  for (const token of [...tokenCells]) {
    if (token.context && contexts.get(token.context) === cell) revokeTokenCell(token, true, revokedCode, revokedError);
  }
  if (detachLeases) detachReleaseLease(cell.release);
  else if (cell.release.context === cell) cell.release.context = undefined;
}

export function requireRegistryContext(context: RegistryRegistrationContext, expectedProjectRoot?: string, requiredCapability?: WorkflowCapability): RegistryContextSnapshot {
  const cell = context && typeof context === "object" ? contexts.get(context) : void 0;
  const reject = (code: "owner_conflict" | "activation_identity_changed", message: string): never => {
    if (cell) revokeContextCell(cell, code, message);
    throw failure(code, message);
  };
  if (!cell || !cell.open) return reject("owner_conflict", "registration context is not genuine or is closed");
  if (expectedProjectRoot !== void 0) {
    let expected;
    try {
      expected = canonicalProjectRoot(expectedProjectRoot);
    } catch {
      let expectedPath: string | undefined;
      try {
        expectedPath = typeof expectedProjectRoot === "string" ? resolve(expectedProjectRoot) : void 0;
      } catch {
        expectedPath = void 0;
      }
      if (expectedPath === cell.root.canonical && !existsSync(expectedPath ?? "")) return reject("activation_identity_changed", "project root identity changed");
      return reject("owner_conflict", "expected project root is invalid");
    }
    if (expected.canonical !== cell.root.canonical || expected.dev !== cell.root.dev || expected.ino !== cell.root.ino) {
      const code = expected.canonical === cell.root.canonical ? "activation_identity_changed" : "owner_conflict";
      return reject(code, "registration root identity does not match the owner claim");
    }
  }
  if (!rootIsCurrent(cell.root)) return reject("activation_identity_changed", "project root identity changed");
  if (requiredCapability !== void 0) {
    if (!cell.capabilities.includes(requiredCapability)) return reject("owner_conflict", "registration context lacks the capability: " + requiredCapability);
    if (!cell.release.remaining.has(requiredCapability)) return reject("owner_conflict", "requested workflow capability is no longer active");
    const capabilityClaim = owners.get(rootKey(cell.root))?.get(requiredCapability);
    const expectedGeneration = cell.capability_generations.get(requiredCapability);
    if (!capabilityClaim || !capabilityClaim.leases.has(cell.release) || capabilityClaim.fingerprint !== cell.fingerprint || capabilityClaim.project_root_dev !== cell.root.dev || capabilityClaim.project_root_ino !== cell.root.ino || capabilityClaim.generation !== expectedGeneration) return reject("owner_conflict", "requested workflow capability is no longer active");
  }
  const claim = liveWorkflowRegistration(cell);
  if (!claim) return reject("owner_conflict", "workflow registration owner claim is no longer active");
  const current = activationSnapshot(cell.root, claim.owner, true);
  if (!current.ok) return reject("activation_identity_changed", current.error);
  if (current.value.digest !== cell.marker_digest || current.value.marker_generation !== cell.marker_generation) return reject("activation_identity_changed", "activation marker identity changed");
  if (claim.owner.activation_marker !== cell.marker_snapshot) return reject("owner_conflict", "activation marker descriptor changed");
  return detached({
    canonical_root: cell.root.canonical,
    root_dev: cell.root.dev,
    root_ino: cell.root.ino,
    owner_fingerprint: cell.fingerprint,
    principal_fingerprint: cell.principal_fingerprint,
    claim_generation: claim.generation,
    marker_generation: cell.marker_generation,
    marker_digest: cell.marker_digest
  });
}
function releaseResult(projectRoot: string | undefined, released: readonly WorkflowCapability[], skipped: readonly WorkflowCapability[]): WorkflowOwnerReleaseResult {
  return { project_root: projectRoot, released: Object.freeze([...released]), skipped: Object.freeze([...skipped]) };
}
/** Consume every still-live capability lease for one activation.  The
 * ReleaseCell is the authority; callers cannot reduce the release set by
 * tampering with an activation result. */
export function releaseWorkflowActivation(token: WorkflowOwnerReleaseToken): WorkflowOwnerReleaseResult {
  const cell = token && typeof token === "object" ? releaseTokens.get(token as object) : undefined;
  if (!cell) return releaseResult(undefined, [], []);
  return releaseWorkflowOwners(token, [...cell.capabilities]);
}
export function releaseWorkflowOwners(token: WorkflowOwnerReleaseToken, capabilities: readonly WorkflowCapability[]): WorkflowOwnerReleaseResult {
  const cell = token && typeof token === "object" ? releaseTokens.get(token as object) : undefined;
  const normalized = normalizeCapabilityArray(capabilities);
  if (!normalized.ok) return releaseResult(cell?.root.canonical, [], []);
  const requested = normalized.value;
  if (!cell) return releaseResult(undefined, [], requested);
  if (cell.revoked) return releaseResult(cell.root.canonical, [], requested);
  const registry = owners.get(rootKey(cell.root));
  const released: WorkflowCapability[] = [];
  const skipped: WorkflowCapability[] = [];
  for (const capability of requested) {
    if (!cell.remaining.has(capability)) {
      skipped.push(capability);
      continue;
    }
    cell.remaining.delete(capability);
    const current = registry?.get(capability);
    if (current && current.fingerprint === cell.fingerprint
      && current.project_root_dev === cell.root.dev
      && current.project_root_ino === cell.root.ino
      && current.generation === cell.generations.get(capability)) {
      current.leases.delete(cell);
      if (current.leases.size === 0) registry!.delete(capability);
      released.push(capability);
    } else skipped.push(capability);
  }
  if (requested.includes("workflow_registration") && released.includes("workflow_registration")) {
    const generation = cell.generations.get("workflow_registration");
    const claimStillLive = owners.get(rootKey(cell.root))?.get("workflow_registration")?.generation === generation;
    if (cell.context) revokeContextCell(cell.context, "owner_conflict", "owner context is no longer active", false);
    if (!claimStillLive) {
      for (const contextCell of [...contextCells]) {
        if (contextCell.root.canonical === cell.root.canonical
          && contextCell.root.dev === cell.root.dev
          && contextCell.root.ino === cell.root.ino
          && contextCell.fingerprint === cell.fingerprint
          && contextCell.generation === generation) revokeContextCell(contextCell, "owner_conflict", "owner context is no longer active", false);
      }
    }
  }
  if (registry?.size === 0) owners.delete(rootKey(cell.root));
  return releaseResult(cell.root.canonical, released, skipped);
}
export function releaseWorkflowOwner(token: WorkflowOwnerReleaseToken, capability: WorkflowCapability): WorkflowOwnerReleaseResult {
  return releaseWorkflowOwners(token, [capability]);
}
export function workflowOwnerFor(projectRoot: string, capability: WorkflowCapability): WorkflowOwnerClaim | undefined {
  try {
    sweepStaleOwnerRoots();
    const root = canonicalProjectRoot(projectRoot);
    const claim = owners.get(rootKey(root))?.get(capability);
    if (!claim || claim.project_root_dev !== root.dev || claim.project_root_ino !== root.ino) return void 0;
    return detached(claim);
  } catch {
    return void 0;
  }
}
function requiredCapabilityForFamily(family: RegistryFamily): WorkflowCapability {
  if (family === "workflow_tools") return "workflow_tools";
  if (family === "runtime_config") return "config_writer";
  return "workflow_registration";
}
function normalizeRegistryFamilies(families: unknown): { ok: true; value: RegistryFamily[] } | { ok: false; error: string } {
  if (!Array.isArray(families)) return { ok: false, error: "registry families must be an array" };
  let length: number;
  try { length = families.length; } catch { return { ok: false, error: "registry families array is invalid" }; }
  const maxFamilies = Object.keys(REGISTRY_FAMILIES).length;
  if (!Number.isSafeInteger(length) || length === 0) return { ok: false, error: "at least one registry family is required" };
  if (length > maxFamilies) return { ok: false, error: `registry families are bounded at ${maxFamilies} entries` };
  const values: RegistryFamily[] = [];
  for (let index = 0; index < length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(families, String(index));
    if (!descriptor || !Object.hasOwn(descriptor, "value")) return { ok: false, error: "registry families must be dense data properties" };
    const family = descriptor.value;
    if (typeof family !== "string" || !Object.prototype.hasOwnProperty.call(REGISTRY_FAMILIES, family)) return { ok: false, error: "unknown registry family" };
    values.push(family as RegistryFamily);
  }
  if (Object.keys(families).some((key) => !/^(0|[1-9]\d*)$/u.test(key) || Number(key) >= length) || Object.getOwnPropertySymbols(families).length > 0) return { ok: false, error: "registry families has unknown properties" };
  return { ok: true, value: [...new Set(values)] };
}

export function beginRegistryRegistration(context: RegistryRegistrationContext, projectRoot: string, families: readonly RegistryFamily[]): { ok: true; token: RegistryRegistrationToken } | { ok: false; code: "owner_invalid" | "owner_conflict" | "activation_identity_changed" | "registry_transaction_invalid"; error: string } {
  const normalizedFamilies = normalizeRegistryFamilies(families);
  if (!normalizedFamilies.ok) return { ok: false, code: "registry_transaction_invalid", error: normalizedFamilies.error };
  const allowed = normalizedFamilies.value;
  const requiredCapabilities = [...new Set(allowed.map(requiredCapabilityForFamily))];
  let snapshot;
  try {
    snapshot = requireRegistryContext(context, projectRoot, requiredCapabilities[0]);
    for (const capability of requiredCapabilities.slice(1)) requireRegistryContext(context, projectRoot, capability);
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error && error.code === "activation_identity_changed" ? "activation_identity_changed" : "owner_conflict";
    return { ok: false, code, error: error instanceof Error ? error.message : String(error) };
  }
  sweepStaleRegistryTokens();
  if (tokenCells.size >= MAX_OPEN_REGISTRY_TOKENS) return { ok: false, code: "registry_transaction_invalid", error: `open registry tokens are bounded at ${MAX_OPEN_REGISTRY_TOKENS}` };
  let contextTokenCount = 0;
  let rootTokenCount = 0;
  const physicalRoot = rootKey({ dev: snapshot.root_dev, ino: snapshot.root_ino });
  for (const tokenCell of tokenCells) {
    if (tokenCell.context === context) contextTokenCount += 1;
    if (rootKey(tokenCell.root) === physicalRoot) rootTokenCount += 1;
  }
  if (contextTokenCount >= MAX_OPEN_TOKENS_PER_CONTEXT) return { ok: false, code: "registry_transaction_invalid", error: `open registry tokens per context are bounded at ${MAX_OPEN_TOKENS_PER_CONTEXT}` };
  if (rootTokenCount >= MAX_OPEN_TOKENS_PER_ROOT) return { ok: false, code: "registry_transaction_invalid", error: `open registry tokens per physical root are bounded at ${MAX_OPEN_TOKENS_PER_ROOT}` };
  const token = Object.freeze(/* @__PURE__ */ Object.create(null));
  const now = Date.now();
  const cell = {
    context,
    root: { canonical: snapshot.canonical_root, dev: snapshot.root_dev, ino: snapshot.root_ino },
    fingerprint: snapshot.owner_fingerprint,
    principal_fingerprint: snapshot.principal_fingerprint,
    principal: contexts.get(context as object)!.principal,
    generation: snapshot.claim_generation,
    marker_generation: snapshot.marker_generation,
    marker_digest: snapshot.marker_digest,
    families: new Set(allowed),
    undo: [],
    commits: [],
    committing: false,
    open: true,
    opened_at: now,
    last_used_at: now
  };
  tokens.set(token, cell);
  tokenCells.add(cell);
  return { ok: true, token };
}
function tokenCell(token: RegistryRegistrationToken): TokenCell {
  sweepStaleRegistryTokens();
  const cell = token && typeof token === "object" ? tokens.get(token) : void 0;
  if (!cell || !cell.open) {
    if (cell?.revoked_code) throw failure(cell.revoked_code, cell.revoked_error ?? "registration token has been revoked");
    throw failure("registry_transaction_invalid", "registration token is not genuine or is closed");
  }
  if (Date.now() - Math.max(cell.opened_at, cell.last_used_at) >= REGISTRY_TOKEN_TTL_MS) {
    revokeTokenCell(cell, true, "owner_conflict", "registration token expired");
    throw failure("owner_conflict", "registration token expired");
  }
  cell.last_used_at = Date.now();
  try {
    const requiredCapabilities = [...new Set([...cell.families].map(requiredCapabilityForFamily))];
    let snapshot = requireRegistryContext(cell.context, cell.root.canonical, requiredCapabilities[0]);
    for (const capability of requiredCapabilities.slice(1)) snapshot = requireRegistryContext(cell.context, cell.root.canonical, capability);
    if (snapshot.owner_fingerprint !== cell.fingerprint || snapshot.principal_fingerprint !== cell.principal_fingerprint || snapshot.claim_generation !== cell.generation || snapshot.marker_generation !== cell.marker_generation || snapshot.marker_digest !== cell.marker_digest) {
      throw failure("owner_conflict", "registration token owner context is no longer active");
    }
    return cell;
  } catch (error) {
    revokeTokenCell(cell);
    throw error;
  }
}
export function requireRegistryRegistration(token: RegistryRegistrationToken, family: RegistryFamily): void {
  const cell = tokenCell(token);
  if (!cell.families.has(family)) throw failure("registry_transaction_invalid", `registration transaction is not authorized for '${family}'`);
}
export function createRegistryRegistrationLiveGuard(token: RegistryRegistrationToken, family: RegistryFamily): () => RegistryContextSnapshot {
  const cell = tokenCell(token);
  if (!cell.families.has(family)) throw failure("registry_transaction_invalid", "registration transaction is not authorized for " + family);
  const context = cell.context;
  const projectRoot = cell.root.canonical;
  const requiredCapability = requiredCapabilityForFamily(family);
  return () => requireRegistryContext(context, projectRoot, requiredCapability);
}
export function registryRegistrationPrincipal(token: RegistryRegistrationToken, family: RegistryFamily): RegistryRegistrationPrincipal {
  requireRegistryRegistration(token, family);
  return tokenCell(token).principal;
}
/** Return the exact opaque context carried by a live token after family auth. */
export function registryRegistrationContextForToken(token: RegistryRegistrationToken, requiredFamily?: RegistryFamily): RegistryRegistrationContext {
  const cell = tokenCell(token);
  if (requiredFamily !== undefined && !cell.families.has(requiredFamily)) {
    throw failure("registry_transaction_invalid", `registration transaction is not authorized for '${requiredFamily}'`);
  }
  return cell.context;
}
export function registryRegistrationProjectRoot(token: RegistryRegistrationToken, family: RegistryFamily): string {
  requireRegistryRegistration(token, family);
  return tokenCell(token).root.canonical;
}
export function registryRegistrationOwnerMatches(token: RegistryRegistrationToken, family: RegistryFamily, owner: WorkflowOwnerIdentity): boolean {
  const cell = tokenCell(token);
  if (!cell.families.has(family)) throw failure("registry_transaction_invalid", "registration transaction is not authorized for " + family);
  let normalized;
  try {
    normalized = normalizedOwner(cell.root, owner);
  } catch {
    return false;
  }
  if (!normalized.ok) return false;
  return principalFingerprint(normalized.value) === cell.principal_fingerprint && descriptorFingerprint(normalized.value) === cell.fingerprint;
}
export function recordRegistryCommit(token: RegistryRegistrationToken, family: RegistryFamily, commit: () => void): void {
  const cell = tokenCell(token);
  if (!cell.families.has(family)) throw failure("registry_transaction_invalid", "registration transaction is not authorized for " + family);
  if (cell.committing) throw failure("registry_transaction_invalid", "registry commit is already in progress");
  if (typeof commit !== "function") throw failure("registry_transaction_invalid", "registry commit must be a function");
  if (cell.undo.length + cell.commits.length >= MAX_REGISTRY_CALLBACKS) throw failure("registry_transaction_invalid", `registry transaction callbacks are bounded at ${MAX_REGISTRY_CALLBACKS}`);
  cell.commits.push(commit);
}
export function recordRegistryUndo(token: RegistryRegistrationToken, undo: () => void): void {
  const cell = tokenCell(token);
  if (typeof undo !== "function") throw failure("registry_transaction_invalid", "registry undo must be a function");
  if (cell.undo.length + cell.commits.length >= MAX_REGISTRY_CALLBACKS) throw failure("registry_transaction_invalid", `registry transaction callbacks are bounded at ${MAX_REGISTRY_CALLBACKS}`);
  cell.undo.push(undo);
}
export function commitRegistryRegistration(token: RegistryRegistrationToken): void {
  const cell = tokenCell(token);
  if (cell.committing) throw failure("registry_transaction_invalid", "registry commit is already in progress");
  cell.committing = true;
  try {
    for (const commit of cell.commits) {
      assertCurrentExecutionLiveness();
      tokenCell(token);
      commit();
      tokenCell(token);
      assertCurrentExecutionLiveness();
    }
    assertCurrentExecutionLiveness();
    tokenCell(token);
  } catch (error) {
    revokeTokenCell(cell, true);
    throw error;
  }
  revokeTokenCell(cell, false);
}
export function rollbackRegistryRegistration(token: RegistryRegistrationToken): void {
  const cell = tokenCell(token);
  revokeTokenCell(cell, true);
}
export function closeRegistryRegistrationContext(context: RegistryRegistrationContext): void {
  const cell = context && typeof context === "object" ? contexts.get(context) : void 0;
  if (cell) revokeContextCell(cell, "owner_conflict", "registration context is closed", false);
}