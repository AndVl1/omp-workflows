import {
  createDiagnostic,
  isTrustedFsAuthority,
  validateProjectIdentity,
  validateWorkflowRunIdentity,
  type ChannelProfile,
  type DiagnosticResult,
  type EscalationAdapter,
  type ProjectIdentity,
  type TrustedFsAuthority,
  type WorkflowRunIdentity,
} from "@andvl1/omp-workflows-core";
import {
  validateFullstackInventoryAdmission,
  type FullstackInventoryAdmissionContext,
} from "./agent-mapping.js";

export type ChannelMode = "telegram" | "http" | null;

export interface MessengerChannelContext {
  readonly project_identity: ProjectIdentity;
  readonly run_identity: WorkflowRunIdentity;
  readonly profile: ChannelProfile;
  readonly adapter: EscalationAdapter;
  /** The launcher-issued authority is carried to make the delivery boundary explicit. */
  readonly filesystem_authority: TrustedFsAuthority;
  /**
   * One host-issued capability containing the actual OMP inventory,
   * reservation, resolver and exact project/run binding.  Bare AgentRef
   * arrays and callback-based admission assertions are intentionally absent.
   */
  readonly inventory_admission: FullstackInventoryAdmissionContext;
}

export interface MessengerInvocationContext {
  readonly messenger?: MessengerChannelContext;
  readonly run_identity?: WorkflowRunIdentity;
}

function sameProject(left: ProjectIdentity, right: ProjectIdentity): boolean {
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

function sameRun(left: WorkflowRunIdentity, right: WorkflowRunIdentity): boolean {
  return sameProject(left, right)
    && left.run_id === right.run_id
    && left.profile_identity.id === right.profile_identity.id
    && left.profile_identity.fingerprint === right.profile_identity.fingerprint;
}

function missingContext(field: string, remediation: string): DiagnosticResult<never> {
  return {
    ok: false,
    diagnostics: [createDiagnostic({
      code: "CAPABILITY_MISSING",
      operation: "runtime.activate",
      evidence: { field },
      remediation,
    })],
  };
}

function invalidContext(field: string, remediation: string): DiagnosticResult<never> {
  return {
    ok: false,
    diagnostics: [createDiagnostic({
      code: "IDENTITY_MISMATCH",
      operation: "runtime.activate",
      evidence: { field },
      remediation,
    })],
  };
}

function isBidirectionalValue(context: MessengerChannelContext): boolean {
  return context.profile.direction === "rw"
    && typeof context.adapter.send === "function"
    && (typeof context.adapter.pollOnce === "function" || typeof context.adapter.setPlainMessageHandler === "function");
}

/** The channel profile is already resolved and run-bound by the caller. */
export function channelMode(context: MessengerChannelContext | undefined): ChannelMode {
  const checked = validateMessengerContext(context);
  if (!checked.ok) return null;
  if (checked.value.profile.direction === "none") return null;
  return checked.value.profile.transport === "telegram" || checked.value.profile.transport === "http"
    ? checked.value.profile.transport
    : null;
}

/** Capability check for a supplied adapter; it never upgrades a declared profile. */
export function isBidirectionalChannel(context: MessengerChannelContext | undefined): boolean {
  const checked = validateMessengerContext(context);
  return checked.ok && isBidirectionalValue(checked.value);
}

/** Validate all pins required before a messenger can redirect user communication. */
export function validateMessengerContext(context: MessengerChannelContext | undefined): DiagnosticResult<MessengerChannelContext> {
  if (!context || typeof context !== "object") {
    return missingContext("messenger.context", "Provide an explicit host-issued run-bound messenger context before redirecting communication.");
  }
  if (!isTrustedFsAuthority(context.filesystem_authority)) {
    return missingContext("messenger.filesystem_authority", "Provide the launcher-issued trusted filesystem authority before enabling messenger delivery.");
  }
  const project = validateProjectIdentity(context.project_identity);
  if (!project.ok) return project;
  const run = validateWorkflowRunIdentity(context.run_identity);
  if (!run.ok) return run;
  if (!sameProject(project.value, run.value)) {
    return invalidContext("messenger.run_identity.project_identity", "Use a run identity inheriting the active project identity.");
  }
  if (!context.profile || typeof context.profile !== "object") {
    return missingContext("messenger.profile", "Provide an admitted channel profile for the active workflow run.");
  }
  const profileRun = validateWorkflowRunIdentity(context.profile.run_identity);
  if (!profileRun.ok || !sameRun(profileRun.value, run.value)) {
    return invalidContext("messenger.profile.run_identity", "Resolve the channel again for the exact active workflow run.");
  }
  if (
    context.profile.direction !== "none"
    && context.profile.direction !== "ro"
    && context.profile.direction !== "rw"
  ) {
    return invalidContext("messenger.profile.direction", "Use an admitted channel profile with an explicit direction.");
  }
  if (context.profile.transport !== "telegram" && context.profile.transport !== "http") {
    return invalidContext("messenger.profile.transport", "Use an admitted Telegram or HTTP channel profile.");
  }
  if (!context.adapter || typeof context.adapter !== "object") {
    return missingContext("messenger.adapter", "Provide the adapter selected by the admitted channel profile.");
  }
  const inventory = validateFullstackInventoryAdmission(context.inventory_admission, project.value, run.value);
  if (!inventory.ok) return inventory;
  return { ok: true, value: context, diagnostics: inventory.diagnostics };
}

/**
 * Create the `ask` redirect for one run-bound channel. No filesystem reads or
 * active-run discovery occur in the hook; the host supplies the selected run.
 */
export function createAskRedirectGate(expected?: MessengerChannelContext): (
  event: { readonly toolName?: string },
  context: MessengerInvocationContext,
) => { readonly block: boolean; readonly reason: string } | undefined {
  return (event, invocation) => {
    if (event.toolName !== "ask") return undefined;
    const candidate = invocation?.messenger ?? expected;
    const checked = validateMessengerContext(candidate);
    if (!checked.ok || !isBidirectionalValue(checked.value)) return undefined;
    const invocationRun = invocation?.run_identity;
    if (!invocationRun) return undefined;
    const run = validateWorkflowRunIdentity(invocationRun);
    if (!run.ok || !sameRun(run.value, checked.value.run_identity)) return undefined;
    const runId = checked.value.run_identity.run_id;
    return {
      block: true,
      reason:
        "messenger-mode: a validated bidirectional channel is active for this workflow run. Do NOT use ask; "
        + `write the escalation under the exact run ${runId} and wait for the checkpoint answer.`,
    };
  };
}
