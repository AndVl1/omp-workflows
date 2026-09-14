import { createHmac, timingSafeEqual } from "node:crypto";
import { requireRegistryContext, type RegistryContextSnapshot, type RegistryRegistrationContext } from "../registry/owner.js";
import { PinnedProjectRoot } from "../specification/pinned-root.js";
import { deriveRuntimeSecretKey, readOrCreateRootRuntimeSecret } from "../runtime-secret.js";

declare const CTO_RUNTIME_PROOF_AUTHORITY_BRAND: unique symbol;

/** Domains intentionally exposed to resident fullstack adapters. */
export type CtoRuntimeProofDomain =
  | "bridge-lease-v1"
  | "cto-dispatcher-lease-v1"
  | "telegram-mapping-v1"
  | "cto-wake-effect-v1";

export const MAX_CTO_RUNTIME_PROOF_PAYLOAD_BYTES = 256 * 1024;
const MAX_CTO_RUNTIME_PROOF_AUTHORITIES = 8;
const SAFE_PROOF = /^[0-9a-f]{64}$/u;
const DOMAIN_VALUES: ReadonlySet<string> = new Set([
  "bridge-lease-v1",
  "cto-dispatcher-lease-v1",
  "telegram-mapping-v1",
  "cto-wake-effect-v1",
]);

type AuthorityCell = {
  readonly context: RegistryRegistrationContext;
  readonly snapshot: RegistryContextSnapshot;
  readonly root: PinnedProjectRoot;
  revoked: boolean;
};

/** Opaque authority; callers cannot read or derive the root secret. */
export type CtoRuntimeProofAuthority = {
  readonly [CTO_RUNTIME_PROOF_AUTHORITY_BRAND]: true;
};

const authorityCells = new WeakMap<object, AuthorityCell>();
const authoritiesByContext = new WeakMap<object, Set<object>>();

function isDomain(value: unknown): value is CtoRuntimeProofDomain {
  return typeof value === "string" && DOMAIN_VALUES.has(value);
}

function isBoundedPayload(value: unknown): value is string {
  return typeof value === "string"
    && value.length > 0
    && Buffer.byteLength(value, "utf8") <= MAX_CTO_RUNTIME_PROOF_PAYLOAD_BYTES
    && !/[\u0000\u000a\u000d]/u.test(value);
}

function sameSnapshot(a: RegistryContextSnapshot, b: RegistryContextSnapshot): boolean {
  return a.canonical_root === b.canonical_root
    && a.root_dev === b.root_dev
    && a.root_ino === b.root_ino
    && a.owner_fingerprint === b.owner_fingerprint
    && a.principal_fingerprint === b.principal_fingerprint
    && a.claim_generation === b.claim_generation
    && a.marker_generation === b.marker_generation
    && a.marker_digest === b.marker_digest;
}

function liveCell(authority: CtoRuntimeProofAuthority): AuthorityCell | null {
  if (!authority || typeof authority !== "object") return null;
  const cell = authorityCells.get(authority as object);
  if (!cell || cell.revoked) return null;
  let current: RegistryContextSnapshot;
  try {
    current = requireRegistryContext(cell.context, cell.root.canonical_root, "workflow_tools");
  } catch {
    revokeCell(authority as object, cell);
    return null;
  }
  if (!cell.root.isStable() || !sameSnapshot(cell.snapshot, current)) {
    revokeCell(authority as object, cell);
    return null;
  }
  return cell;
}

function revokeCell(key: object, cell: AuthorityCell): void {
  if (cell.revoked) return;
  cell.revoked = true;
  authorityCells.delete(key);
  const set = authoritiesByContext.get(cell.context as object);
  set?.delete(key);
  if (set && set.size === 0) authoritiesByContext.delete(cell.context as object);
  cell.root.close();
}

function proofBytes(cell: AuthorityCell, domain: CtoRuntimeProofDomain, payload: string): Buffer | null {
  const master = readOrCreateRootRuntimeSecret(cell.root);
  const key = master ? deriveRuntimeSecretKey(master, domain) : null;
  if (!key) return null;
  const binding = [
    "omp-cto-runtime-proof-v1",
    cell.root.canonical_root,
    String(cell.root.dev),
    String(cell.root.ino),
    cell.snapshot.owner_fingerprint,
    cell.snapshot.principal_fingerprint,
    String(cell.snapshot.claim_generation),
    String(cell.snapshot.marker_generation),
    cell.snapshot.marker_digest,
    domain,
    payload,
  ].join("\u0000");
  return createHmac("sha256", key).update(binding, "utf8").digest();
}

export function isCtoRuntimeProofAuthority(value: unknown): value is CtoRuntimeProofAuthority {
  return typeof value === "object" && value !== null && authorityCells.has(value);
}

/** Open one bounded, root- and workflow_tools-claim-bound proof authority. */
export function openCtoRuntimeProofAuthority(
  context: RegistryRegistrationContext,
  pinnedRoot: PinnedProjectRoot,
): CtoRuntimeProofAuthority | null {
  if (!context || !pinnedRoot || !pinnedRoot.isStable()) return null;
  let snapshot: RegistryContextSnapshot;
  try {
    snapshot = requireRegistryContext(context, pinnedRoot.canonical_root, "workflow_tools");
  } catch {
    return null;
  }
  if (snapshot.root_dev !== pinnedRoot.dev || snapshot.root_ino !== pinnedRoot.ino) return null;
  const current = authoritiesByContext.get(context as object);
  if (current && current.size >= MAX_CTO_RUNTIME_PROOF_AUTHORITIES) return null;
  const authority = Object.freeze({}) as CtoRuntimeProofAuthority;
  const ownedRoot = PinnedProjectRoot.open(snapshot.canonical_root);
  if (!ownedRoot || ownedRoot.dev !== snapshot.root_dev || ownedRoot.ino !== snapshot.root_ino || !ownedRoot.isStable()) {
    ownedRoot?.close();
    return null;
  }
  const cell: AuthorityCell = { context, snapshot, root: ownedRoot, revoked: false };
  authorityCells.set(authority as object, cell);
  const set = current ?? new Set<object>();
  set.add(authority as object);
  authoritiesByContext.set(context as object, set);
  return authority;
}

export function revokeCtoRuntimeProofAuthority(authority: CtoRuntimeProofAuthority): void {
  const cell = authority && typeof authority === "object" ? authorityCells.get(authority as object) : undefined;
  if (cell) revokeCell(authority as object, cell);
}

export function assertCtoRuntimeProofAuthorityLive(authority: CtoRuntimeProofAuthority): void {
  if (!liveCell(authority)) throw new Error("CTO runtime proof authority is unavailable");
}

export function signCtoRuntimeProof(
  authority: CtoRuntimeProofAuthority,
  domain: CtoRuntimeProofDomain,
  canonicalPayload: string,
): string | null {
  if (!isDomain(domain) || !isBoundedPayload(canonicalPayload)) return null;
  const cell = liveCell(authority);
  if (!cell) return null;
  return proofBytes(cell, domain, canonicalPayload)?.toString("hex") ?? null;
}

export function verifyCtoRuntimeProof(
  authority: CtoRuntimeProofAuthority,
  domain: CtoRuntimeProofDomain,
  canonicalPayload: string,
  proof: string,
): boolean {
  if (!isDomain(domain) || !isBoundedPayload(canonicalPayload) || typeof proof !== "string" || !SAFE_PROOF.test(proof)) return false;
  const cell = liveCell(authority);
  if (!cell) return false;
  const expected = proofBytes(cell, domain, canonicalPayload);
  if (!expected) return false;
  const actual = Buffer.from(proof, "hex");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
