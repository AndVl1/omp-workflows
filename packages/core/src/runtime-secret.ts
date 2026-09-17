import { createHash, createHmac, randomBytes } from "node:crypto";
import { lstatSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { PinnedProjectRoot } from "./specification/pinned-root.js";

const RUNTIME_SECRET_DIRECTORY = ".omp/runtime-secrets";
const RUNTIME_SECRET_MAX_BYTES = 8 * 1024;
const RUNTIME_SECRET_MIN_CHARS = 32;
const RUNTIME_SECRET_MAX_CHARS = 512;
const RUNTIME_SECRET_FILE_SUFFIX = ".inbox-auth.json";

export interface RuntimeSecretRootIdentity {
  readonly canonical_root: string;
  readonly root_dev: number;
  readonly root_ino: number;
}

function rootIdentity(root: PinnedProjectRoot): RuntimeSecretRootIdentity {
  return { canonical_root: root.canonical_root, root_dev: root.dev, root_ino: root.ino };
}

function secretFileName(identity: RuntimeSecretRootIdentity): string {
  const digest = createHash("sha256")
    .update(`${identity.canonical_root}\u0000${identity.root_dev}\u0000${identity.root_ino}`, "utf8")
    .digest("hex");
  return `${digest}${RUNTIME_SECRET_FILE_SUFFIX}`;
}

function exactObjectKeys(value: unknown, expected: readonly string[]): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const keys = Object.keys(value).sort();
  return keys.length === expected.length && keys.every((key, index) => key === expected[index]);
}

function validRecord(value: unknown, identity: RuntimeSecretRootIdentity): value is { schema: 1; root_identity: string; root_dev: number; root_ino: number; secret: string } {
  return exactObjectKeys(value, ["root_dev", "root_identity", "root_ino", "schema", "secret"])
    && value.schema === 1
    && value.root_identity === identity.canonical_root
    && value.root_dev === identity.root_dev
    && value.root_ino === identity.root_ino
    && typeof value.secret === "string"
    && value.secret.length >= RUNTIME_SECRET_MIN_CHARS
    && value.secret.length <= RUNTIME_SECRET_MAX_CHARS;
}

type RuntimeSecretHome = {
  readonly path: string;
  readonly root: PinnedProjectRoot;
};

type RuntimeSecretSnapshot = {
  readonly home: RuntimeSecretHome;
  readonly secret: string;
};

/**
 * Keep one descriptor-anchored home root for the process. Opening a Darwin
 * pinned root starts a helper process, so repeating that for every proof HMAC
 * makes synchronous callers starve the event loop. A root secret is securely
 * read and verified on cache miss, then retained only for the current
 * synchronous turn; the exact root and project identities remain bound.
 */
let cachedRuntimeSecretHome: RuntimeSecretHome | undefined;
const runtimeSecretSnapshots = new Map<string, RuntimeSecretSnapshot>();

function runtimeSecretCacheKey(identity: RuntimeSecretRootIdentity): string {
  return `${identity.canonical_root}\u0000${identity.root_dev}\u0000${identity.root_ino}`;
}

function cacheRuntimeSecret(identity: RuntimeSecretRootIdentity, home: RuntimeSecretHome, secret: string): string {
  const key = runtimeSecretCacheKey(identity);
  const snapshot: RuntimeSecretSnapshot = { home, secret };
  runtimeSecretSnapshots.set(key, snapshot);
  queueMicrotask(() => {
    if (runtimeSecretSnapshots.get(key) === snapshot) runtimeSecretSnapshots.delete(key);
  });
  return secret;
}

function currentRuntimeSecretHomeMatches(home: RuntimeSecretHome, path: string): boolean {
  try {
    const lexical = lstatSync(path);
    if (lexical.isSymbolicLink() || !lexical.isDirectory()) return false;
    const canonical = realpathSync(path);
    if (canonical !== home.root.canonical_root) return false;
    const resolved = lstatSync(canonical);
    return resolved.isDirectory()
      && lexical.dev === home.root.dev
      && lexical.ino === home.root.ino
      && resolved.dev === home.root.dev
      && resolved.ino === home.root.ino;
  } catch {
    return false;
  }
}

function runtimeSecretHome(): RuntimeSecretHome | null {
  const path = homedir();
  const cached = cachedRuntimeSecretHome;
  if (cached && cached.path === path && cached.root.isStable() && currentRuntimeSecretHomeMatches(cached, path)) return cached;
  if (cached) {
    cached.root.close();
    cachedRuntimeSecretHome = undefined;
    runtimeSecretSnapshots.clear();
  }
  const root = PinnedProjectRoot.open(path);
  if (!root) return null;
  const next = { path, root };
  cachedRuntimeSecretHome = next;
  return next;
}

function invalidateRuntimeSecretHome(root: PinnedProjectRoot): void {
  if (cachedRuntimeSecretHome?.root !== root) return;
  cachedRuntimeSecretHome = undefined;
  runtimeSecretSnapshots.clear();
  root.close();
}

function homeRelative(home: PinnedProjectRoot, target: string): string | null {
  const relative = home.relativePath(target);
  return relative && relative.startsWith(`${RUNTIME_SECRET_DIRECTORY}/`) ? relative : null;
}

function readExact(home: PinnedProjectRoot, relative: string, identity: RuntimeSecretRootIdentity, onFailure?: () => void): string | null {
  try {
    const info = home.pathEntryInfo(relative);
    if (!info || info.kind !== "file" || info.mode !== 0o600 || info.size > RUNTIME_SECRET_MAX_BYTES) return null;
    const read = home.readFile(relative, { maxBytes: RUNTIME_SECRET_MAX_BYTES });
    const committed = home.pathEntryInfo(relative);
    if (!committed || committed.kind !== "file" || committed.mode !== 0o600 || committed.dev !== read.dev || committed.ino !== read.ino) return null;
    let parsed: unknown;
    try { parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(read.bytes)); } catch { return null; }
    return validRecord(parsed, identity) ? parsed.secret : null;
  } catch {
    onFailure?.();
    return null;
  }
}

/** Read or atomically create the root-scoped inbox-auth-compatible secret. */
export function readOrCreateRootRuntimeSecret(pinnedRoot: PinnedProjectRoot): string | null {
  if (!pinnedRoot.isStable()) return null;
  const identity = rootIdentity(pinnedRoot);
  const cacheKey = runtimeSecretCacheKey(identity);
  const cached = runtimeSecretSnapshots.get(cacheKey);
  if (cached) {
    const currentPath = homedir();
    if (cached.home === cachedRuntimeSecretHome && currentPath === cached.home.path && currentRuntimeSecretHomeMatches(cached.home, currentPath)) return cached.secret;
    if (runtimeSecretSnapshots.get(cacheKey) === cached) runtimeSecretSnapshots.delete(cacheKey);
  }
  const home = runtimeSecretHome();
  if (!home) return null;
  const invalidate = (): void => invalidateRuntimeSecretHome(home.root);
  try {
    const target = join(home.path, RUNTIME_SECRET_DIRECTORY, secretFileName(identity));
    const relative = homeRelative(home.root, target);
    if (!relative || !home.root.isStable()) return null;
    home.root.ensureDirectory(RUNTIME_SECRET_DIRECTORY);
    const directory = home.root.pathEntryInfo(RUNTIME_SECRET_DIRECTORY);
    if (!directory || directory.kind !== "directory" || directory.mode !== 0o700) return null;
    const existing = readExact(home.root, relative, identity, invalidate);
    if (existing) {
      if (!pinnedRoot.isStable()) return null;
      if (!currentRuntimeSecretHomeMatches(home, home.path)) {
        invalidate();
        return null;
      }
      return cacheRuntimeSecret(identity, home, existing);
    }
    const secret = randomBytes(32).toString("hex");
    const serialized = JSON.stringify({ schema: 1, root_identity: identity.canonical_root, root_dev: identity.root_dev, root_ino: identity.root_ino, secret });
    try { home.root.writeExclusive(relative, Buffer.from(serialized, "utf8")); } catch { /* another live owner may have won creation */ }
    const committed = readExact(home.root, relative, identity, invalidate);
    if (!committed || !pinnedRoot.isStable()) return null;
    if (!currentRuntimeSecretHomeMatches(home, home.path)) {
      invalidate();
      return null;
    }
    return cacheRuntimeSecret(identity, home, committed);
  } catch {
    invalidate();
    return null;
  }
}

/** Derive a domain-separated key without exposing the root master secret. */
export function deriveRuntimeSecretKey(masterSecret: string, domain: string): string | null {
  if (typeof masterSecret !== "string" || masterSecret.length < RUNTIME_SECRET_MIN_CHARS || masterSecret.length > RUNTIME_SECRET_MAX_CHARS || typeof domain !== "string" || domain.length === 0 || domain.length > 512) return null;
  return createHmac("sha256", masterSecret).update(`omp-runtime-secret:${domain}`, "utf8").digest("hex");
}
