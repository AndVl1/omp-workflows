/**
 * <!-- omp-cto-slice run=01a03ee4-7dd6-7580-8ad7-16d26dc886ba slice=workflow-v2-core -->
 */
import { createDiagnostic, failureResult, isDiagnosticEvidenceRecord, successResult } from "./diagnostics.js";
import type {
  AdmissionBridge,
  DiagnosticResult,
  HostCapability,
  HostDescriptor,
} from "./types.js";

/**
 * The canonical names owned by the v2 host. These are an allowlist, not a
 * reservation: stock OMP exposes no native reservation/arbitration API to
 * this module, so no native claim is attempted or represented here.
 */
export const WORKFLOW_V2_CANONICAL_COMMANDS = [
  "do-work",
  "team",
  "cto",
  "workflow-provider",
  "init-team",
] as const;

/** The complete workflow-tool allowlist owned by the v2 host. */
export const WORKFLOW_V2_WORKFLOW_TOOLS = [
  "workflow_prepare",
  "workflow_begin",
  "workflow_status",
  "workflow_instructions",
  "workflow_complete",
  "workflow_checkpoint",
  "workflow_advance",
] as const;

/** Capabilities every canonical v2 host must advertise. */
export const WORKFLOW_V2_HOST_CAPABILITIES = [
  "workflow_registration",
  "workflow_tools",
  "config_writer",
  "provider_dispatch",
  "typed_diagnostics",
  "identity_binding",
] as const satisfies readonly HostCapability[];

const HOST_DESCRIPTOR_KEYS = [
  "host_id",
  "host_version",
  "protocol_version",
  "canonical_commands",
  "workflow_tools",
  "capabilities",
] as const;
const HOST_ID_PATTERN = /^[A-Za-z0-9@._:/#-]+$/u;
const HOST_VERSION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._+:-]*$/u;
const CAPABILITY_PATTERN = /^[A-Za-z][A-Za-z0-9._:-]*$/u;
const MAX_HOST_ID_LENGTH = 256;
const MAX_HOST_VERSION_LENGTH = 128;

type AdmissionSuccess = { readonly admitted: true; readonly order: number };

interface AdmittedHost {
  readonly descriptor: HostDescriptor;
  readonly order: number;
}

/**
 * This state is intentionally process-wide. A fresh bridge object is only a
 * view over the one admission ledger; creating another bridge cannot create a
 * second canonical host in the same OMP process.
 */
let admittedHost: AdmittedHost | undefined;

function hasExactDescriptorKeys(value: Record<string, unknown>): boolean {
  const keys = Object.keys(value);
  if (keys.length !== HOST_DESCRIPTOR_KEYS.length) return false;
  return HOST_DESCRIPTOR_KEYS.every((key) => Object.prototype.hasOwnProperty.call(value, key));
}

function hasExactTuple(value: unknown, expected: readonly string[]): boolean {
  return Array.isArray(value)
    && value.length === expected.length
    && value.every((entry, index) => entry === expected[index]);
}

function isSafeHostId(value: unknown): value is string {
  return typeof value === "string"
    && value.length > 0
    && value.length <= MAX_HOST_ID_LENGTH
    && value === value.trim()
    && HOST_ID_PATTERN.test(value);
}

function isSafeHostVersion(value: unknown): value is string {
  return typeof value === "string"
    && value.length > 0
    && value.length <= MAX_HOST_VERSION_LENGTH
    && value === value.trim()
    && HOST_VERSION_PATTERN.test(value);
}

function validCapabilities(value: unknown): value is readonly HostCapability[] {
  if (!Array.isArray(value) || value.length < WORKFLOW_V2_HOST_CAPABILITIES.length) return false;
  if (!value.every((entry) => typeof entry === "string" && CAPABILITY_PATTERN.test(entry))) return false;
  if (new Set(value).size !== value.length) return false;
  return WORKFLOW_V2_HOST_CAPABILITIES.every((required) => value.includes(required));
}

function migrationFailure<T>(
  evidence: Readonly<Record<string, unknown>>,
  remediation: string,
): DiagnosticResult<T> {
  return failureResult(createDiagnostic({
    code: "MIGRATION_REQUIRED",
    operation: "admission",
    severity: "error",
    evidence,
    remediation,
  }));
}

function ownerConflictFailure<T>(
  evidence: Readonly<Record<string, unknown>>,
  remediation: string,
): DiagnosticResult<T> {
  return failureResult(createDiagnostic({
    code: "OWNER_CONFLICT",
    operation: "admission",
    severity: "error",
    evidence,
    remediation,
  }));
}

function validateHostDescriptor(host: HostDescriptor): DiagnosticResult<HostDescriptor> {
  const raw = host as unknown;
  if (!isDiagnosticEvidenceRecord(raw)) {
    return migrationFailure<HostDescriptor>(
      { changed_field: "host_descriptor" },
      "Load the canonical protocol-v2 host through the ordered admission boundary; direct or legacy registrars are unsupported.",
    );
  }

  try {
    const prototype = Object.getPrototypeOf(raw);
    if ((prototype !== Object.prototype && prototype !== null) || !hasExactDescriptorKeys(raw)) {
      return migrationFailure<HostDescriptor>(
        { changed_field: "host_descriptor" },
        "Load the canonical protocol-v2 host through the ordered admission boundary; direct or legacy registrars are unsupported.",
      );
    }

    const candidate = raw;
    if (!isSafeHostId(candidate.host_id)) {
      return migrationFailure<HostDescriptor>(
        { changed_field: "host_id" },
        "Provide a non-empty stable host id from the protocol-v2 host descriptor.",
      );
    }
    if (!isSafeHostVersion(candidate.host_version)) {
      return migrationFailure<HostDescriptor>(
        { host_id: candidate.host_id, changed_field: "host_version" },
        "Provide a stable host version and load it through the protocol-v2 admission boundary.",
      );
    }
    if (candidate.protocol_version !== 2) {
      return migrationFailure<HostDescriptor>(
        { host_id: candidate.host_id, changed_field: "protocol_version" },
        "Upgrade the registrar to protocol v2 before loading it; mixed v1/direct registrars are unsupported.",
      );
    }
    if (!hasExactTuple(candidate.canonical_commands, WORKFLOW_V2_CANONICAL_COMMANDS)) {
      return migrationFailure<HostDescriptor>(
        { host_id: candidate.host_id, changed_field: "canonical_commands" },
        "Use the exact five-name canonical host allowlist; providers and legacy registrars cannot add or replace names.",
      );
    }
    if (!hasExactTuple(candidate.workflow_tools, WORKFLOW_V2_WORKFLOW_TOOLS)) {
      return migrationFailure<HostDescriptor>(
        { host_id: candidate.host_id, changed_field: "workflow_tools" },
        "Use the exact seven-tool workflow host allowlist; providers and legacy registrars cannot add or replace tools.",
      );
    }
    if (!validCapabilities(candidate.capabilities)) {
      return migrationFailure<HostDescriptor>(
        { host_id: candidate.host_id, changed_field: "capabilities" },
        "Advertise every immutable v2 host capability before registration; policy cannot weaken the host minimum.",
      );
    }

    const descriptor = Object.freeze({
      host_id: candidate.host_id,
      host_version: candidate.host_version,
      protocol_version: 2 as const,
      canonical_commands: WORKFLOW_V2_CANONICAL_COMMANDS,
      workflow_tools: WORKFLOW_V2_WORKFLOW_TOOLS,
      capabilities: Object.freeze([...candidate.capabilities]) as readonly HostCapability[],
    }) as HostDescriptor;
    return successResult(descriptor);
  } catch {
    return migrationFailure<HostDescriptor>(
      { changed_field: "host_descriptor" },
      "Load a plain, immutable protocol-v2 host descriptor through the ordered admission boundary.",
    );
  }
}

function admitHost(host: HostDescriptor): DiagnosticResult<AdmissionSuccess> {
  const validated = validateHostDescriptor(host);
  if (!validated.ok) return validated;

  if (admittedHost !== undefined) {
    return ownerConflictFailure<AdmissionSuccess>(
      {
        host_id: validated.value.host_id,
        candidate_id: admittedHost.descriptor.host_id,
        changed_field: "admitted_host",
      },
      "Keep exactly one canonical v2 host per process and restart before replacing an admitted host.",
    );
  }

  const order = 1;
  admittedHost = Object.freeze({ descriptor: validated.value, order });
  return successResult(Object.freeze({ admitted: true as const, order }));
}

function assertAdmitted(host_id: string): DiagnosticResult<{ readonly admitted: true }> {
  if (!isSafeHostId(host_id)) {
    return migrationFailure<{ readonly admitted: true }>(
      { changed_field: "host_id" },
      "Use the admitted protocol-v2 host id when asserting canonical registration ownership.",
    );
  }
  if (admittedHost === undefined) {
    return migrationFailure<{ readonly admitted: true }>(
      { host_id, changed_field: "admitted_host" },
      "Admit the canonical protocol-v2 host before registering commands, tools, or taking the initial snapshot.",
    );
  }
  if (admittedHost.descriptor.host_id !== host_id) {
    return ownerConflictFailure<{ readonly admitted: true }>(
      {
        host_id,
        candidate_id: admittedHost.descriptor.host_id,
        changed_field: "admitted_host",
      },
      "Use the one host admitted for this process; a second canonical host requires a fresh process lifecycle.",
    );
  }
  return successResult(Object.freeze({ admitted: true as const }));
}

/**
 * Return the process-wide cooperative admission bridge. The bridge only
 * validates and records host admission; it never calls OMP registration APIs
 * and makes no claim to reserve names against extensions that bypass it.
 */
export function createAdmissionBridge(): AdmissionBridge {
  return Object.freeze({ admitHost, assertAdmitted });
}

/**
 * Isolate focused admission tests. This is deliberately not exported from
 * the public core barrel and is not a runtime provider-switch mechanism.
 */
export function resetAdmissionForTests(): void {
  admittedHost = undefined;
}
