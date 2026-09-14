import type { RegistryRegistrationContext } from "../registry/owner.js";

/**
 * Opaque capability for one authenticated host main-session lifecycle.
 *
 * The object deliberately carries no readable claims. Provenance lives only in
 * this module's WeakMaps, so a caller cannot manufacture a session authority
 * by copying a `{ sessionId, main }` DTO or by supplying a getter.
 */
export type CtoRuntimeSessionAuthority = object & { readonly __cto_runtime_session_authority?: never };

export type CtoRuntimeSessionAuthorityRoot = {
  readonly canonical_root: string;
  readonly dev: number;
  readonly ino: number;
};

export type CtoRuntimeSessionAuthoritySession = {
  readonly sessionManager: object;
  readonly sessionId: string;
  readonly generation?: string | number;
};

export type CtoRuntimeSessionAuthorityCell = {
  readonly context: RegistryRegistrationContext;
  readonly root: CtoRuntimeSessionAuthorityRoot;
  readonly sessionManager: object;
  readonly sessionId: string;
  readonly generation?: string | number;
  readonly liveGuard: () => void;
  revoked: boolean;
};

const authorityCells = new WeakMap<object, CtoRuntimeSessionAuthorityCell>();
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

function validGeneration(value: unknown): value is string | number | undefined {
  return value === undefined
    || (typeof value === "string" && value.length > 0)
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
    || typeof session.sessionId !== "string" || session.sessionId.length === 0 || !validGeneration(session.generation)) {
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
    ...(session.generation !== undefined ? { generation: session.generation } : {}),
    liveGuard,
    revoked: false,
  };
  authorityCells.set(authority, cell);
  contextAuthorities.set(context, authority);
  return authority;
}

/** Revoke one lifecycle capability; stale copies fail closed immediately. */
export function revokeCtoRuntimeSessionAuthority(authority: CtoRuntimeSessionAuthority): void {
  const cell = authority && typeof authority === "object" ? authorityCells.get(authority) : undefined;
  if (!cell || cell.revoked) return;
  cell.revoked = true;
  if (contextAuthorities.get(cell.context) === authority) contextAuthorities.delete(cell.context);
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
  const cell = authority ? authorityCells.get(authority) : undefined;
  if (!authority || !cell || cell.revoked || cell.context !== context) return null;
  try {
    cell.liveGuard();
  } catch {
    revokeCtoRuntimeSessionAuthority(authority);
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
  const cell = authorityCells.get(authority);
  if (!cell || cell.revoked || cell.context !== context
    || cell.root.canonical_root !== root.canonical_root || cell.root.dev !== root.dev || cell.root.ino !== root.ino) return null;
  try {
    cell.liveGuard();
  } catch {
    revokeCtoRuntimeSessionAuthority(authority);
    return null;
  }
  return cell;
}
