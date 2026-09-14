/**
 * Report-facing redaction surface (pragmatic architecture).
 *
 * Reuses the CTO deterministic redaction pipeline (cto/redaction.ts) as the
 * single text redactor for report embedding: artifact bodies and summaries
 * pass through `redactText` so secrets never reach the self-contained HTML.
 * No new semantics — same patterns, same line-drop/inline/truncate behavior,
 * same "never throws" guarantee.
 */

import { redactText, DEFAULT_REDACTION_CONFIG } from "../cto/redaction.js";
import type { RedactionConfig } from "../cto/types.js";

export { redactText, DEFAULT_REDACTION_CONFIG } from "../cto/redaction.js";
export type { RedactionConfig } from "../cto/types.js";

/** Truncate UTF-8 text without splitting a code point or exceeding maxBytes. */
export function truncateUtf8(text: string, maxBytes: number): string {
  const cap = Number.isSafeInteger(maxBytes) ? Math.max(0, maxBytes) : 0;
  if (cap === 0) return "";
  const bytes = Buffer.from(text, "utf8");
  if (bytes.byteLength <= cap) return text;
  const decoder = new TextDecoder("utf-8", { fatal: true });
  for (let end = cap; end > Math.max(0, cap - 4); end -= 1) {
    try {
      return decoder.decode(bytes.subarray(0, end));
    } catch {
      // A UTF-8 sequence can be at most four bytes; trim its partial tail.
    }
  }
  return "";
}
/**
 * Whole-line drop for QUOTED JSON keys — the default CTO patterns
 * (`token\s*[:=]`) match prose (`token = x`) but not JSON
 * (`"api_key": "sk-…"`, where the quote sits between key and colon).
 * Appended only on the report path; DEFAULT_REDACTION_CONFIG stays the
 * historical CTO semantics untouched.
 */
const JSON_SECRET_KEY_LINE = '/"(?:token|password|passwd|secret|api[_-]?key|authorization|bearer|private[_-]?key)"\\s*[:=]/i';

/**
 * Redact + byte-cap a body for embedding as artifact content. The cap maps
 * onto the redactor's `max_body` truncation so a single pipeline applies
 * (drop secret lines — prose AND JSON quoted keys — → inline replace →
 * truncate → empty→marker).
 */
export function redactReportBody(
  text: string,
  maxBytes: number,
  config: RedactionConfig = DEFAULT_REDACTION_CONFIG,
): string {
  return truncateUtf8(
    redactText(text, {
      ...config,
      secret_line_patterns: [...config.secret_line_patterns, JSON_SECRET_KEY_LINE],
      max_body: Math.max(0, maxBytes),
    }),
    maxBytes,
  );
}
