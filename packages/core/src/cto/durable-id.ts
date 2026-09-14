/**
 * Canonical bounded filenames for durable IDs.
 *
 * IDs are retained verbatim in their JSON envelopes. Normal IDs use an
 * injective base64url encoding (the queue permits only filename-safe
 * characters); unusually long IDs use a bounded SHA-256 name.
 * readers can accept it only after exact envelope identity verification.
 */
import { createHash } from "node:crypto";

const MAX_DURABLE_ID_FILE_NAME_BYTES = 200;
const MAX_LEGACY_DURABLE_ID_FILE_NAME_BYTES = 255;

export function canonicalDurableIdFileName(id: string): string {
  const safeName = `${id}.json`;
  if (/^[A-Za-z0-9._-]+$/.test(id) && Buffer.byteLength(safeName, "utf8") <= MAX_DURABLE_ID_FILE_NAME_BYTES) return safeName;
  const encoded = Buffer.from(id, "utf8").toString("base64url");
  const encodedName = `inbox-${encoded}.json`;
  if (encoded.length > 0 && Buffer.byteLength(encodedName, "utf8") <= MAX_DURABLE_ID_FILE_NAME_BYTES) return encodedName;
  const digest = createHash("sha256").update(id, "utf8").digest("hex");
  return `inbox-${digest}.json`;
}

/**
 * The pre-encoding filename remains readable for rolling upgrades, but it is
 * lossy and must never be created when it cannot be represented as one safe
 * filesystem component. In particular, the byte limit is checked after
 * sanitization and no truncation is performed.
 */
export function legacyDurableIdFileName(id: string): string {
  return `${id.replace(/[^a-zA-Z0-9._-]/g, "-")}.json`;
}

export function safeLegacyDurableIdFileName(id: string): string | undefined {
  const name = legacyDurableIdFileName(id);
  if (
    name.length === 0
    || name === "."
    || name === ".."
    || Buffer.byteLength(name, "utf8") > MAX_LEGACY_DURABLE_ID_FILE_NAME_BYTES
    || !/^[A-Za-z0-9._-]+$/.test(name)
  ) return undefined;
  return name;
}

export function durableIdFileNameMatches(fileName: string, id: string): boolean {
  return fileName === canonicalDurableIdFileName(id);
}
