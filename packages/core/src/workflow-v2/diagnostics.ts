import type {
  DiagnosticCode,
  DiagnosticEvidenceValue,
  DiagnosticOperation,
  DiagnosticSeverity,
  DiagnosticResult,
  WorkflowV2Diagnostic,
} from "./types.js";

export const WORKFLOW_V2_DIAGNOSTIC_CODES = [
  "ROOT_UNAVAILABLE",
  "CONFIG_MISSING",
  "CONFIG_MALFORMED",
  "UNSUPPORTED_SCHEMA",
  "UNSAFE_PATH",
  "BINDING_REQUIRED",
  "IDENTITY_MISMATCH",
  "PROVIDER_UNAVAILABLE",
  "PROVIDER_QUARANTINED",
  "CAPABILITY_MISSING",
  "PROFILE_UNAVAILABLE",
  "AGENT_COLLISION",
  "OWNER_CONFLICT",
  "TRANSITION_REQUIRED",
  "ACTIVATION_FAILED",
  "TRANSACTION_INCOMPLETE",
  "MIGRATION_REQUIRED",
] as const satisfies readonly DiagnosticCode[];

export const WORKFLOW_V2_DIAGNOSTIC_OPERATIONS = [
  "root.resolve",
  "policy.read",
  "policy.write",
  "binding.read",
  "binding.write",
  "admission",
  "provider.lookup",
  "catalog.validate",
  "profile.resolve",
  "agent.preflight",
  "command.dispatch",
  "tool.dispatch",
  "runtime.activate",
  "runtime.shutdown",
  "management.list",
  "management.status",
  "management.select",
  "management.create",
  "management.refresh",
  "management.migrate",
  "management.apply",
] as const satisfies readonly DiagnosticOperation[];

const SAFE_EVIDENCE_KEYS: Record<string, true> = {
  operation: true,
  canonical_root: true,
  path: true,
  binding_path: true,
  provider_id: true,
  candidate_id: true,
  profile_id: true,
  source: true,
  source_fingerprint: true,
  descriptor_fingerprint: true,
  catalog_content_digest: true,
  config_byte_sha256: true,
  config_semantic_sha256: true,
  root_instance_id: true,
  root_device: true,
  root_inode: true,
  git_device: true,
  git_inode: true,
  root_instance_nonce: true,
  expected_digest: true,
  actual_digest: true,
  changed_field: true,
  field: true,
  owner_id: true,
  host_id: true,
  capability: true,
  missing_capability: true,
  status: true,
  count: true,
  order: true,
};

const SAFE_IDENTIFIER = /^[A-Za-z0-9@._:/#-]+$/u;
const SAFE_PATH = /^[^\u0000\u0001-\u001f\u007f\u0080-\u009f]*$/u;
const DIGEST_KEY = /(?:digest|fingerprint|sha256|instance_id)$/u;
const DEVICE_KEY = /(?:device|inode)$/u;
const ARRAY_LIMIT = 64;
const STRING_LIMIT = 512;

export function isDiagnosticEvidenceRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isSafeString(key: string, value: string): boolean {
  if (value.length > STRING_LIMIT || !SAFE_PATH.test(value)) return false;
  if (key === "operation") return isDiagnosticOperation(value);
  if (DIGEST_KEY.test(key)) return /^sha256:[0-9a-f]{64}$/u.test(value);
  if (DEVICE_KEY.test(key)) return /^[A-Za-z0-9:_-]+$/u.test(value);
  if (
    key === "provider_id"
    || key === "source"
    || key === "candidate_id"
    || key === "profile_id"
    || key === "owner_id"
    || key === "host_id"
    || key === "changed_field"
    || key === "field"
    || key === "capability"
    || key === "missing_capability"
    || key === "status"
    || key === "root_instance_nonce"
  ) {
    return SAFE_IDENTIFIER.test(value);
  }
  return true;
}

function safeEvidenceValue(key: string, value: unknown): DiagnosticEvidenceValue | undefined {
  if (typeof value === "string") return isSafeString(key, value) ? value : undefined;
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (typeof value === "boolean" || value === null) return value;
  if (Array.isArray(value)) {
    if (value.length > ARRAY_LIMIT || !value.every((entry) => typeof entry === "string" && isSafeString(key, entry))) return undefined;
    return Object.freeze([...value]) as readonly string[];
  }
  return undefined;
}

/**
 * Keep only bounded, structured diagnostic evidence.  Unknown keys and
 * arbitrary objects (including prompt text, tokens and errors) are omitted.
 */
export function redactDiagnosticEvidence(evidence: unknown): Readonly<Record<string, DiagnosticEvidenceValue>> {
  if (!isDiagnosticEvidenceRecord(evidence)) return Object.freeze({});
  const redacted: Record<string, DiagnosticEvidenceValue> = {};
  for (const [key, value] of Object.entries(evidence)) {
    if (!Object.prototype.hasOwnProperty.call(SAFE_EVIDENCE_KEYS, key)) continue;
    const safe = safeEvidenceValue(key, value);
    if (safe !== undefined) redacted[key] = safe;
  }
  return Object.freeze(redacted);
}

export interface DiagnosticInput {
  readonly code: DiagnosticCode;
  readonly operation: DiagnosticOperation;
  readonly severity?: DiagnosticSeverity;
  readonly evidence?: unknown;
  readonly remediation: string;
}

/** Construct the only public diagnostic shape; no UI/error-string formatting. */
export function createDiagnostic(input: DiagnosticInput): WorkflowV2Diagnostic {
  if (!isDiagnosticCode(input.code)) throw new TypeError(`unknown workflow v2 diagnostic code: ${String(input.code)}`);
  if (!isDiagnosticOperation(input.operation)) throw new TypeError(`unknown workflow v2 diagnostic operation: ${String(input.operation)}`);
  const severity = input.severity ?? "error";
  if (!isDiagnosticSeverity(severity)) throw new TypeError(`unknown workflow v2 diagnostic severity: ${String(severity)}`);
  if (severity !== "error" && input.operation !== "management.list" && input.operation !== "management.status") {
    throw new TypeError("warning/info diagnostics are restricted to read-only status/list operations");
  }
  if (typeof input.remediation !== "string" || input.remediation.trim().length === 0) {
    throw new TypeError("workflow v2 diagnostic remediation must be a non-empty string");
  }
  return Object.freeze({
    code: input.code,
    operation: input.operation,
    severity,
    evidence: redactDiagnosticEvidence(input.evidence),
    remediation: input.remediation.trim(),
  });
}

/** Return a successful typed result with optional non-blocking diagnostics. */
export function successResult<T>(value: T, diagnostics: readonly WorkflowV2Diagnostic[] = []): DiagnosticResult<T> {
  return Object.freeze({ ok: true as const, value, diagnostics: Object.freeze([...diagnostics]) });
}

/** Return a failed typed result; callers cannot replace it with an error string. */
export function failureResult<T>(diagnostics: readonly WorkflowV2Diagnostic[] | WorkflowV2Diagnostic): DiagnosticResult<T> {
  const list = Array.isArray(diagnostics) ? diagnostics : [diagnostics];
  return Object.freeze({ ok: false as const, diagnostics: Object.freeze([...list]) });
}

/** Flatten diagnostic lists while retaining boundary order and multiplicity. */
export function aggregateDiagnostics(
  ...groups: readonly (readonly WorkflowV2Diagnostic[])[]
): readonly WorkflowV2Diagnostic[] {
  return Object.freeze(groups.flatMap((group) => group));
}

export function hasDiagnosticErrors(diagnostics: readonly WorkflowV2Diagnostic[]): boolean {
  return diagnostics.some((diagnostic) => diagnostic.severity === "error");
}

export function isDiagnosticCode(value: unknown): value is DiagnosticCode {
  return typeof value === "string" && (WORKFLOW_V2_DIAGNOSTIC_CODES as readonly string[]).includes(value);
}

export function isDiagnosticOperation(value: unknown): value is DiagnosticOperation {
  return typeof value === "string" && (WORKFLOW_V2_DIAGNOSTIC_OPERATIONS as readonly string[]).includes(value);
}

export function isDiagnosticSeverity(value: unknown): value is DiagnosticSeverity {
  return value === "error" || value === "warning" || value === "info";
}

export function isWorkflowV2Diagnostic(value: unknown): value is WorkflowV2Diagnostic {
  if (!isDiagnosticEvidenceRecord(value)) return false;
  if (!isDiagnosticCode(value.code) || !isDiagnosticOperation(value.operation) || !isDiagnosticSeverity(value.severity)) return false;
  if (typeof value.remediation !== "string" || value.remediation.trim().length === 0 || !isDiagnosticEvidenceRecord(value.evidence)) return false;
  return Object.entries(value.evidence).every(([key, entry]) => Object.prototype.hasOwnProperty.call(SAFE_EVIDENCE_KEYS, key) && safeEvidenceValue(key, entry) !== undefined);
}
