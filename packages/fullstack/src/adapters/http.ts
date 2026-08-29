import {
  createDiagnostic,
  failureResult,
  projectRuntimeKeyFor,
  validateProviderActivationAdmission,
  validateWorkflowRunIdentity,
  type DiagnosticResult,
  type Escalation,
  type EscalationAdapter,
  type EscalationReceipt,
  type ProviderActivationAdmission,
  type ProviderActivationAdmissionExpectation,
  type WorkflowRunIdentity,
  type WorkflowV2Digest,
} from "@andvl1/omp-workflows-core";
import {
  channelConfigDigest,
  isChannelAdmission,
  type ChannelAdmission,
  type ChannelEndpointPolicy,
} from "../storage-authority.js";

const HTTP_TRANSPORT_BRAND: unique symbol = Symbol("AdmittedHttpTransport");

/**
 * The only HTTP capability accepted by the adapter.  The brand is private to
 * this source module and the runtime ledger below rejects structural copies.
 * This type is exported only so the registry can carry the capability without
 * publishing an issuer through the package barrel.
 */
export interface AdmittedHttpTransport {
  readonly [HTTP_TRANSPORT_BRAND]: "AdmittedHttpTransport";
  readonly activation_admission: ProviderActivationAdmission;
  readonly project_identity: ProviderActivationAdmission["project_identity"];
  readonly runtime_key: ProviderActivationAdmission["runtime_key"];
  readonly canonical_root: ProviderActivationAdmission["canonical_root"];
  readonly provider_id: ProviderActivationAdmission["provider_id"];
  readonly descriptor_fingerprint: WorkflowV2Digest;
  readonly catalog_content_digest: WorkflowV2Digest;
  readonly executable_provenance: ProviderActivationAdmission["executable_provenance"];
  readonly run_identity: WorkflowRunIdentity;
  readonly channel_config_digest: WorkflowV2Digest;
  readonly channel_id?: string;
  readonly send: (payload: string, signal: AbortSignal) => Promise<AdmittedHttpTransportReceipt>;
}

interface AdmittedHttpTransportReceipt {
  readonly sent: boolean;
  readonly run_identity: WorkflowRunIdentity;
  readonly channelRef?: string;
}

interface HttpTransportImplementation {
  readonly send: (payload: string, signal: AbortSignal) => Promise<AdmittedHttpTransportReceipt>;
}

interface IssuedHttpTransportBinding {
  readonly activation_admission: ProviderActivationAdmission;
  readonly channel_admission: ChannelAdmission;
  readonly run_identity: WorkflowRunIdentity;
  readonly channel_id?: string;
  readonly max_body_bytes: number;
  readonly timeout_ms: number;
  readonly implementation: HttpTransportImplementation;
}

/**
 * Phase 3 is the only place allowed to link a real HTTP implementation.  The
 * phase-2 package deliberately has no implementation and therefore cannot
 * issue a transport or perform network I/O.
 */
const phase3HttpImplementation: HttpTransportImplementation | undefined = undefined;

const issuedHttpTransports = new WeakMap<object, IssuedHttpTransportBinding>();

const SAFE_CHANNEL_ID = /^[A-Za-z0-9._-]{1,128}$/u;
const MAX_HTTP_REQUEST_BYTES = 1024 * 1024;
const MAX_HTTP_TIMEOUT_MS = 60_000;
const MIN_HTTP_TIMEOUT_MS = 100;
const DEFAULT_HTTP_TIMEOUT_MS = 30_000;
const MAX_HTTP_RECEIPT_REF_BYTES = 512;

function sameRun(left: WorkflowRunIdentity, right: WorkflowRunIdentity): boolean {
  return left.root_instance_id === right.root_instance_id
    && left.provider_id === right.provider_id
    && left.descriptor_fingerprint === right.descriptor_fingerprint
    && left.executable_provenance.build_fingerprint === right.executable_provenance.build_fingerprint
    && left.executable_provenance.runtime_fingerprint === right.executable_provenance.runtime_fingerprint
    && left.catalog_content_digest === right.catalog_content_digest
    && left.config_byte_sha256 === right.config_byte_sha256
    && left.config_semantic_sha256 === right.config_semantic_sha256
    && left.session.session_id === right.session.session_id
    && left.session.lifecycle_id === right.session.lifecycle_id
    && left.run_id === right.run_id
    && left.profile_identity.id === right.profile_identity.id
    && left.profile_identity.fingerprint === right.profile_identity.fingerprint;
}

function sameProject(left: ProviderActivationAdmission["project_identity"], right: WorkflowRunIdentity): boolean {
  return left.root_instance_id === right.root_instance_id
    && left.provider_id === right.provider_id
    && left.descriptor_fingerprint === right.descriptor_fingerprint
    && left.executable_provenance.build_fingerprint === right.executable_provenance.build_fingerprint
    && left.executable_provenance.runtime_fingerprint === right.executable_provenance.runtime_fingerprint
    && left.catalog_content_digest === right.catalog_content_digest
    && left.config_byte_sha256 === right.config_byte_sha256
    && left.config_semantic_sha256 === right.config_semantic_sha256
    && left.session.session_id === right.session.session_id
    && left.session.lifecycle_id === right.session.lifecycle_id;
}

function capabilityFailure<T>(field: string, remediation: string): DiagnosticResult<T> {
  return failureResult(createDiagnostic({
    code: "CAPABILITY_MISSING",
    operation: "runtime.activate",
    evidence: { field },
    remediation,
  }));
}

function identityFailure<T>(field: string, remediation: string): DiagnosticResult<T> {
  return failureResult(createDiagnostic({
    code: "IDENTITY_MISMATCH",
    operation: "runtime.activate",
    evidence: { field },
    remediation,
  }));
}

function configFailure<T>(field: string, remediation: string): DiagnosticResult<T> {
  return failureResult(createDiagnostic({
    code: "CONFIG_MALFORMED",
    operation: "runtime.activate",
    evidence: { field },
    remediation,
  }));
}

function activationExpectation(
  admission: ProviderActivationAdmission,
): ProviderActivationAdmissionExpectation {
  return {
    project_identity: admission.project_identity,
    runtime_key: admission.runtime_key,
    canonical_root: admission.canonical_root,
    provider_id: admission.provider_id,
    descriptor_fingerprint: admission.descriptor_fingerprint,
    catalog_content_digest: admission.catalog_content_digest,
    executable_provenance: admission.executable_provenance,
    agent_inventory: admission.agent_inventory,
    agent_inventory_authority: admission.agent_inventory_authority,
    authority_context: admission.authority_context,
    ...(admission.run_identity === undefined ? {} : { run_identity: admission.run_identity }),
  };
}

function matchingHttpChannel(
  admission: ChannelAdmission,
  channelId: string | undefined,
): Record<string, unknown> | null {
  const candidates = admission.channels.filter((candidate) => {
    if (candidate === null || typeof candidate !== "object" || Array.isArray(candidate)) return false;
    const entry = candidate as Record<string, unknown>;
    if (entry.adapter !== "http") return false;
    return channelId === undefined || entry.id === channelId;
  });
  return candidates.length === 1 ? candidates[0] as Record<string, unknown> : null;
}

function endpointPolicyFor(
  admission: ChannelAdmission,
  channelId: string | undefined,
  entry: Record<string, unknown>,
): ChannelEndpointPolicy | null {
  const key = channelId ?? (typeof entry.id === "string" && entry.id.length > 0 ? entry.id : "http");
  const direct = admission.endpoint_policy[key];
  if (direct) return direct;
  if (key !== "http" && channelId === undefined && entry.id === undefined) return admission.endpoint_policy.http ?? null;
  return null;
}

function policyBounds(
  policy: ChannelEndpointPolicy | null,
): { readonly max_body_bytes: number; readonly timeout_ms: number } | null {
  if (!policy) return null;
  const maxBody = policy.max_body_bytes ?? MAX_HTTP_REQUEST_BYTES;
  const timeout = policy.timeout_ms ?? DEFAULT_HTTP_TIMEOUT_MS;
  if (!Number.isSafeInteger(maxBody) || maxBody <= 0 || maxBody > MAX_HTTP_REQUEST_BYTES) return null;
  if (!Number.isSafeInteger(timeout) || timeout < MIN_HTTP_TIMEOUT_MS || timeout > MAX_HTTP_TIMEOUT_MS) return null;
  return { max_body_bytes: maxBody, timeout_ms: timeout };
}

function validTransportReceipt(value: unknown): value is AdmittedHttpTransportReceipt {
  try {
    if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
    const receipt = value as Record<string, unknown>;
    if (Object.keys(receipt).some((key) => key !== "sent" && key !== "run_identity" && key !== "channelRef")) return false;
    if (typeof receipt.sent !== "boolean" || !validateWorkflowRunIdentity(receipt.run_identity).ok) return false;
    if (receipt.channelRef !== undefined
      && (typeof receipt.channelRef !== "string"
        || new TextEncoder().encode(receipt.channelRef).byteLength > MAX_HTTP_RECEIPT_REF_BYTES
        || /[\r\n]/u.test(receipt.channelRef))) return false;
    return true;
  } catch {
    return false;
  }
}

function issuedTransport(value: unknown): IssuedHttpTransportBinding | undefined {
  if (value === null || typeof value !== "object") return undefined;
  return issuedHttpTransports.get(value);
}

/**
 * Internal issuer used only by a future fixed provider runtime.  There is no
 * exported issuer: phase-2 callers can only receive a pre-issued capability
 * from that runtime, and the absent implementation fails closed here.
 */
function issueAdmittedHttpTransport(
  activation: ProviderActivationAdmission,
  channelAdmission: ChannelAdmission,
  channelId?: string,
): DiagnosticResult<AdmittedHttpTransport> {
  if (!isChannelAdmission(channelAdmission)) {
    return capabilityFailure("channel_admission", "Use the exact manager-issued ChannelAdmission.");
  }
  if (channelId !== undefined && !SAFE_CHANNEL_ID.test(channelId)) {
    return configFailure("channel_id", "Use a bounded channel id from the manager-issued channel admission.");
  }
  let checked: DiagnosticResult<ProviderActivationAdmission>;
  try {
    checked = validateProviderActivationAdmission(activation, activationExpectation(activation));
  } catch {
    return capabilityFailure("activation_admission", "Use the exact core ProviderActivationAdmission issued by host activation.");
  }
  if (!checked.ok) return checked;
  const admitted = checked.value;
  const run = admitted.run_identity;
  if (run === undefined) {
    return capabilityFailure("activation_admission.run_identity", "Bind the HTTP transport to a prepared workflow run.");
  }
  let channelRuntimeKey: ProviderActivationAdmission["runtime_key"];
  try {
    channelRuntimeKey = projectRuntimeKeyFor(channelAdmission.run_identity);
  } catch {
    return identityFailure("channel_admission.run_identity", "Use the complete manager-issued workflow run identity.");
  }
  if (!sameRun(run, channelAdmission.run_identity)
    || admitted.runtime_key !== channelRuntimeKey
    || admitted.canonical_root !== channelAdmission.project_root
    || !sameProject(admitted.project_identity, channelAdmission.run_identity)
    || admitted.provider_id !== channelAdmission.run_identity.provider_id
    || admitted.descriptor_fingerprint !== channelAdmission.run_identity.descriptor_fingerprint
    || admitted.catalog_content_digest !== channelAdmission.run_identity.catalog_content_digest
    || admitted.executable_provenance.build_fingerprint !== channelAdmission.run_identity.executable_provenance.build_fingerprint
    || admitted.executable_provenance.runtime_fingerprint !== channelAdmission.run_identity.executable_provenance.runtime_fingerprint) {
    return identityFailure("activation_admission", "Use provider activation and channel admissions for the exact project and workflow run.");
  }
  let configDigest: WorkflowV2Digest;
  try {
    configDigest = channelConfigDigest(channelAdmission.channels);
  } catch {
    return configFailure("channel_admission.channels", "Use the exact bounded channel configuration supplied by the manager.");
  }
  if (configDigest !== channelAdmission.config_digest) {
    return identityFailure("channel_admission.config_digest", "Use the manager digest for the exact immutable channel configuration.");
  }
  const entry = matchingHttpChannel(channelAdmission, channelId);
  if (!entry) return configFailure("channel_admission.channels", "Provide exactly one admitted HTTP channel for the selected channel id.");
  const boundChannelId = channelId ?? (typeof entry.id === "string" ? entry.id : undefined);
  const bounds = policyBounds(endpointPolicyFor(channelAdmission, boundChannelId, entry));
  if (!bounds) return configFailure("channel_admission.endpoint_policy", "Provide a bounded manager HTTP endpoint policy.");
  const implementation = phase3HttpImplementation;
  if (!implementation) {
    return capabilityFailure("http_transport", "HTTP transport is unavailable until the fixed phase-3 implementation is linked.");
  }
  const binding: IssuedHttpTransportBinding = {
    activation_admission: admitted,
    channel_admission: channelAdmission,
    run_identity: run,
    ...(boundChannelId === undefined ? {} : { channel_id: boundChannelId }),
    max_body_bytes: bounds.max_body_bytes,
    timeout_ms: bounds.timeout_ms,
    implementation,
  };
  const transport = Object.freeze({
    [HTTP_TRANSPORT_BRAND]: "AdmittedHttpTransport" as const,
    activation_admission: admitted,
    project_identity: admitted.project_identity,
    runtime_key: admitted.runtime_key,
    canonical_root: admitted.canonical_root,
    provider_id: admitted.provider_id,
    descriptor_fingerprint: admitted.descriptor_fingerprint,
    catalog_content_digest: admitted.catalog_content_digest,
    executable_provenance: admitted.executable_provenance,
    run_identity: run,
    channel_config_digest: channelAdmission.config_digest,
    ...(boundChannelId === undefined ? {} : { channel_id: boundChannelId }),
    send: async (payload: string, signal: AbortSignal): Promise<AdmittedHttpTransportReceipt> => {
      if (typeof payload !== "string"
        || new TextEncoder().encode(payload).byteLength > bounds.max_body_bytes) {
        return { sent: false, run_identity: run, channelRef: "http:body-limit" };
      }
      try {
        const receipt = await implementation.send(payload, signal);
        return validTransportReceipt(receipt) && sameRun(receipt.run_identity, run)
          ? receipt
          : { sent: false, run_identity: run, channelRef: "http:invalid-receipt" };
      } catch {
        return { sent: false, run_identity: run, channelRef: "http:failed" };
      }
    },
  }) as AdmittedHttpTransport;
  issuedHttpTransports.set(transport, binding);
  return { ok: true, value: transport, diagnostics: checked.diagnostics };
}

export interface HttpAdapterOptions {
  readonly transport: AdmittedHttpTransport;
  readonly run_identity: WorkflowRunIdentity;
  readonly channel_admission: ChannelAdmission;
  readonly channel_id?: string;
}

export class HttpEscalationAdapter implements EscalationAdapter {
  readonly kind = "http";
  private readonly transport: AdmittedHttpTransport;
  private readonly runIdentity: WorkflowRunIdentity;
  private readonly timeoutMs: number;
  private readonly maxRequestBytes: number;

  constructor(options: HttpAdapterOptions) {
    const transportBinding = options && issuedTransport(options.transport);
    if (!options
      || !transportBinding
      || !isChannelAdmission(options.channel_admission)
      || (options.channel_id !== undefined && !SAFE_CHANNEL_ID.test(options.channel_id))) {
      throw new TypeError("HttpEscalationAdapter requires an exact issued HTTP transport and channel admission");
    }
    const run = validateWorkflowRunIdentity(options.run_identity);
    if (!run.ok
      || transportBinding.channel_admission !== options.channel_admission
      || transportBinding.channel_admission.config_digest !== options.channel_admission.config_digest
      || transportBinding.channel_id !== options.channel_id
      || !sameRun(run.value, transportBinding.run_identity)
      || !sameRun(run.value, options.channel_admission.run_identity)
      || transportBinding.activation_admission.run_identity === undefined
      || !sameRun(run.value, transportBinding.activation_admission.run_identity)
      || transportBinding.activation_admission.canonical_root !== options.channel_admission.project_root) {
      throw new TypeError("HttpEscalationAdapter requires exact provider, run and channel admission bindings");
    }
    const bounds = {
      max_body_bytes: transportBinding.max_body_bytes,
      timeout_ms: transportBinding.timeout_ms,
    };
    this.transport = options.transport;
    this.runIdentity = run.value;
    this.timeoutMs = bounds.timeout_ms;
    this.maxRequestBytes = bounds.max_body_bytes;
  }

  async send(escalation: Escalation): Promise<EscalationReceipt> {
    const run = validateWorkflowRunIdentity(escalation?.run_identity);
    if (!run.ok || !sameRun(run.value, this.runIdentity)) {
      return { sent: false, run_identity: this.runIdentity, channelRef: "http:identity-mismatch" };
    }
    let body: string;
    try {
      const serialized = JSON.stringify(escalation);
      if (serialized === undefined || new TextEncoder().encode(serialized).byteLength > this.maxRequestBytes) {
        return { sent: false, run_identity: this.runIdentity, channelRef: "http:body-limit" };
      }
      body = serialized;
    } catch {
      return { sent: false, run_identity: this.runIdentity, channelRef: "http:body-limit" };
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let receipt: AdmittedHttpTransportReceipt;
    try {
      receipt = await this.transport.send(body, controller.signal);
    } catch {
      return { sent: false, run_identity: this.runIdentity, channelRef: "http:failed" };
    } finally {
      clearTimeout(timer);
    }
    let receiptValid = false;
    try {
      receiptValid = validTransportReceipt(receipt) && sameRun(receipt.run_identity, this.runIdentity);
    } catch {
      receiptValid = false;
    }
    if (!receiptValid) {
      return { sent: false, run_identity: this.runIdentity, channelRef: "http:invalid-receipt" };
    }
    return {
      sent: receipt.sent,
      run_identity: this.runIdentity,
      ...(receipt.channelRef === undefined ? {} : { channelRef: receipt.channelRef }),
    };
  }

  async cancel(id: string): Promise<void> {
    if (typeof id !== "string" || !id.startsWith(`${this.runIdentity.run_id}/`)) return;
  }
}
