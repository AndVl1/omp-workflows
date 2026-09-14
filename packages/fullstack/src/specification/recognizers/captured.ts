import {
  isSafeExternalMetadata as isCoreSafeExternalMetadata,
  isSafeRelativePath as isCoreSafeRelativePath,
  type FormatRecognizerDocument,
  type FormatRecognizerInput,
} from "@andvl1/omp-workflows-core";

const SHA256_RE = /^[a-f0-9]{64}$/;
const MAX_DOCUMENT_BYTES = 4 * 1024 * 1024;

const CONTROL_CHARACTER_RE = /[\u0000-\u0008\u000b\u000e-\u001f\u007f]/;
const SECRET_LIKE_CONTENT_RES: readonly RegExp[] = [
  /\b(?:authorization|password|passwd|pwd|secret|token|api[_-]?key|access[_-]?key|private[_-]?key|client[_-]?secret|credential|cookie)\b[ \t]*[:=][ \t]*(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s,;]+)/i,
  /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/,
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/,
  /\bsk-[A-Za-z0-9_-]{20,}\b/,
  /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/,
  /\b[a-z][a-z0-9+.-]*:\/\/[^ \t\r\n/:@]+:[^ \t\r\n/@]+@/i,
];

/**
 * Apply the same bounded unsafe-content gate before a framework classifies a
 * readable candidate. Reasons never echo candidate bytes or secret material.
 */
export function inspectUnsafeRecognizerContent(text: string): string | null {
  if (CONTROL_CHARACTER_RE.test(text)) return "candidate contains unsafe control characters and is never selected";
  if (SECRET_LIKE_CONTENT_RES.some((pattern) => pattern.test(text))) return "candidate contains secret-like content and is never selected";
  return null;
}

/** A validated, immutable view over the secure import capture. */
export interface PreparedRecognizerInput {
  readonly source_root: string;
  readonly source_root_identity: FormatRecognizerInput["source_root_identity"];
  readonly documents: readonly FormatRecognizerDocument[];
  readonly ignored_candidates: readonly { readonly path: string; readonly reason: string }[];
}

function isSafeRelativePath(value: unknown): value is string {
  return isCoreSafeRelativePath(value);
}

function isSafeSourceRoot(value: unknown): value is string {
  return isCoreSafeExternalMetadata(value, 4096) && value.startsWith("/");
}

function validDocument(document: FormatRecognizerDocument): boolean {
  return !!document
    && typeof document === "object"
    && isSafeRelativePath(document.source_ref)
    && SHA256_RE.test(document.sha256)
    && Number.isSafeInteger(document.size_bytes)
    && document.size_bytes >= 0
    && document.size_bytes <= MAX_DOCUMENT_BYTES
    && typeof document.media_type === "string"
    && document.media_type.length > 0
    && document.media_type.length <= 256
    && typeof document.text === "string"
    && Buffer.byteLength(document.text, "utf8") <= MAX_DOCUMENT_BYTES
    && document.content_role === "untrusted_inert_data";
}

/**
 * Validate only the captured value. This helper deliberately performs no
 * pathname or descriptor operation; all bytes are already supplied by core.
 */
export function prepareRecognizerInput(input: FormatRecognizerInput): PreparedRecognizerInput | null {
  if (!input || typeof input !== "object") return null;
  if (!isSafeSourceRoot(input.source_root)) return null;
  const identity = input.source_root_identity;
  if (!identity || identity.canonical_path !== input.source_root
    || !isSafeSourceRoot(identity.canonical_path)
    || !Number.isSafeInteger(identity.dev) || identity.dev < 0
    || !Number.isSafeInteger(identity.ino) || identity.ino < 0
    || !Number.isSafeInteger(identity.mode) || identity.mode < 0) return null;
  if (!Array.isArray(input.documents)) return null;

  const seen = new Set<string>();
  const documents: FormatRecognizerDocument[] = [];
  for (const document of input.documents) {
    if (!validDocument(document) || seen.has(document.source_ref)) return null;
    seen.add(document.source_ref);
    documents.push(document);
  }
  documents.sort((left, right) => left.source_ref < right.source_ref ? -1 : left.source_ref > right.source_ref ? 1 : 0);

  const ignored: Array<{ path: string; reason: string }> = [];
  for (const entry of input.ignored_candidates ?? []) {
    if (!entry || typeof entry !== "object" || !isSafeRelativePath(entry.path)
      || !isCoreSafeExternalMetadata(entry.reason, 512)) return null;
    ignored.push({ path: entry.path, reason: entry.reason });
  }
  ignored.sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : left.reason < right.reason ? -1 : left.reason > right.reason ? 1 : 0);
  return Object.freeze({
    source_root: input.source_root,
    source_root_identity: Object.freeze({ ...identity }),
    documents: Object.freeze([...documents]),
    ignored_candidates: Object.freeze(ignored.map((entry) => Object.freeze(entry))),
  });
}
