import type { RegistryRegistrationContext } from "../registry/owner.js";

/**
 * Opaque capability for one authenticated host main-session lifecycle.
 *
 * The object deliberately carries no readable claims. Provenance lives only in
 * this module's WeakMaps, so a caller cannot manufacture a session authority
 * by copying a `{ sessionId, main }` DTO or by supplying a getter.
 */
declare const CTO_RUNTIME_SESSION_AUTHORITY_BRAND: unique symbol;
export type CtoRuntimeSessionAuthority = { readonly [CTO_RUNTIME_SESSION_AUTHORITY_BRAND]: true };

export type CtoRuntimeSessionAuthorityRoot = {
  readonly canonical_root: string;
  readonly dev: number;
  readonly ino: number;
};

export type CtoRuntimeSessionAuthoritySession = {
  readonly sessionManager: object;
  readonly sessionId: string;
  readonly sessionFile?: string;
  readonly sessionBasename?: string;
  readonly generation?: string | number;
};

export type CtoRuntimeSessionAuthorityCell = {
  readonly context: RegistryRegistrationContext;
  readonly root: CtoRuntimeSessionAuthorityRoot;
  readonly sessionManager: object;
  readonly sessionId: string;
  readonly sessionFile?: string;
  readonly sessionBasename?: string;
  readonly generation?: string | number;
  readonly liveGuard: () => void;
  readonly attached: Set<() => void>;
  revoked: boolean;
};

const authorityCells = new WeakMap<object, CtoRuntimeSessionAuthorityCell>();
const MAX_SESSION_ID_BYTES = 512;
const MAX_SESSION_FILE_BYTES = 4096;
const MAX_SESSION_BASENAME_BYTES = 512;
export const MAX_CTO_RUNTIME_SESSION_ATTACHMENTS = 8;
const contextAuthorities = new WeakMap<object, CtoRuntimeSessionAuthority>();

function authorityObject(): CtoRuntimeSessionAuthority {
  return Object.freeze(Object.create(null)) as CtoRuntimeSessionAuthority;
}

function validRoot(root: CtoRuntimeSessionAuthorityRoot): boolean {
  return typeof root.canonical_root === "string"
    && root.canonical_root.length > 0
    && Number.isSafeInteger(root.dev)
    && root.dev >= 0
    && Number.isSafeInteger(root.ino)
    && root.ino >= 0;
}

function safeText(value: unknown, maxBytes: number): value is string {
  return typeof value === "string"
    && value.length > 0
    && Buffer.byteLength(value, "utf8") <= maxBytes
    && !/[\u0000-\u001f\u007f-\u009f\p{Cf}\p{Zl}\p{Zp}]/u.test(value);
}

function validGeneration(value: unknown): value is string | number | undefined {
  return value === undefined
    || (safeText(value, MAX_SESSION_ID_BYTES))
    || (typeof value === "number" && Number.isSafeInteger(value));
}

/**
 * Internal lifecycle issuer. This module is intentionally not exposed as a
 * package export; only core's authenticated team lifecycle may call it.
 */
export function issueCtoRuntimeSessionAuthority(
  context: RegistryRegistrationContext,
  root: CtoRuntimeSessionAuthorityRoot,
  session: CtoRuntimeSessionAuthoritySession,
  liveGuard: () => void,
): CtoRuntimeSessionAuthority {
  if (!context || typeof context !== "object") throw new TypeError("runtime session authority context is invalid");
  if (!validRoot(root)) throw new TypeError("runtime session authority root is invalid");
  if (!session || typeof session !== "object" || !session.sessionManager || typeof session.sessionManager !== "object"
    || !safeText(session.sessionId, MAX_SESSION_ID_BYTES)
    || (session.sessionFile !== undefined && !safeText(session.sessionFile, MAX_SESSION_FILE_BYTES))
    || (session.sessionBasename !== undefined && !safeText(session.sessionBasename, MAX_SESSION_BASENAME_BYTES))
    || !validGeneration(session.generation)) {
    throw new TypeError("runtime session authority identity is invalid");
  }
  if (typeof liveGuard !== "function") throw new TypeError("runtime session authority live guard is invalid");

  const prior = contextAuthorities.get(context);
  if (prior) revokeCtoRuntimeSessionAuthority(prior);
  const authority = authorityObject();
  const cell: CtoRuntimeSessionAuthorityCell = {
    context,
    root: Object.freeze({ ...root }),
    sessionManager: session.sessionManager,
    sessionId: session.sessionId,
    ...(session.sessionFile !== undefined ? { sessionFile: session.sessionFile } : {}),
    ...(session.sessionBasename !== undefined ? { sessionBasename: session.sessionBasename } : {}),
    ...(session.generation !== undefined ? { generation: session.generation } : {}),
    liveGuard,
    attached: new Set<() => void>(),
    revoked: false,
  };
  authorityCells.set(authority as object, cell);
  contextAuthorities.set(context, authority);
  return authority;
}

/** Runtime-only brand check; no caller claims are inspected or accepted. */
export function isCtoRuntimeSessionAuthority(value: unknown): value is CtoRuntimeSessionAuthority {
  return Boolean(value && typeof value === "object" && authorityCells.has(value as object));
}

/** Revoke one lifecycle capability; stale copies fail closed immediately. */
export function revokeCtoRuntimeSessionAuthority(authority: CtoRuntimeSessionAuthority): void {
  const cell = authority && typeof authority === "object" ? authorityCells.get(authority as object) : undefined;
  if (!cell || cell.revoked) return;
  cell.revoked = true;
  if (contextAuthorities.get(cell.context) === authority) contextAuthorities.delete(cell.context);
  const attached = [...cell.attached];
  cell.attached.clear();
  for (const close of attached) {
    try { close(); } catch { /* stale facade teardown is best effort */ }
  }
}


/** Attach one runtime facade lease to its lifecycle authority. */
export function attachCtoRuntimeSessionAuthority(
  authority: CtoRuntimeSessionAuthority,
  close: () => void,
): boolean {
  if (!authority || typeof authority !== "object" || typeof close !== "function") return false;
  const cell = authorityCells.get(authority as object);
  if (!cell || cell.revoked || cell.attached.size >= MAX_CTO_RUNTIME_SESSION_ATTACHMENTS) return false;
  try { cell.liveGuard(); } catch { revokeCtoRuntimeSessionAuthority(authority); return false; }
  cell.attached.add(close);
  return true;
}

/** Remove one runtime facade lease after explicit close. */
export function detachCtoRuntimeSessionAuthority(
  authority: CtoRuntimeSessionAuthority,
  close: () => void,
): void {
  if (!authority || typeof authority !== "object" || typeof close !== "function") return;
  authorityCells.get(authority as object)?.attached.delete(close);
}

/**
 * Return the exact authority issued for an authenticated registry context.
 * This accessor does not accept a session selector and never mints a token.
 */
export function ctoRuntimeSessionAuthorityForContext(
  context: RegistryRegistrationContext,
): CtoRuntimeSessionAuthority | null {
  if (!context || typeof context !== "object") return null;
  const authority = contextAuthorities.get(context);
  const cell = authority ? authorityCells.get(authority as object) : undefined;
  if (!authority || !cell || cell.revoked || cell.context !== context) return null;
  try {
    cell.liveGuard();
  } catch {
    revokeCtoRuntimeSessionAuthority(authority as CtoRuntimeSessionAuthority);
    return null;
  }
  return authority;
}

/**
 * Authenticate an authority for the exact registry context/root. Runtime
 * access snapshots the returned identity once; it never calls host getters.
 */
export function authenticateCtoRuntimeSessionAuthority(
  authority: unknown,
  context: RegistryRegistrationContext,
  root: CtoRuntimeSessionAuthorityRoot,
): CtoRuntimeSessionAuthorityCell | null {
  if (!authority || typeof authority !== "object" || !context || typeof context !== "object" || !validRoot(root)) return null;
  const cell = authorityCells.get(authority as object);
  if (!cell || cell.revoked || cell.context !== context
    || cell.root.canonical_root !== root.canonical_root || cell.root.dev !== root.dev || cell.root.ino !== root.ino) return null;
  try {
    cell.liveGuard();
  } catch {
    revokeCtoRuntimeSessionAuthority(authority as CtoRuntimeSessionAuthority);
    return null;
  }
  return cell;
}
