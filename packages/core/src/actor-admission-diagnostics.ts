export type TrustedToolCallDenialCode =
  | "invalid_host_context"
  | "untrusted_actor_context"
  | "host_session_not_captured"
  | "headless_host_session"
  | "session_identity_mismatch"
  | "worktree_mismatch"
  | "host_profile_mismatch"
  | "session_controller_unavailable"
  | "controller_context_mismatch"
  | "selected_run_mismatch"
  | "execution_claim_mismatch"
  | "artifacts_scope_mismatch"
  | "controller_resolution_failed";

/**
 * Core-only admission causes remain separate from adapter denial codes. The
 * public resolver contract exposes only TrustedToolCallDenialCode; these
 * values describe failures discovered by core after the callback boundary.
 */
export type AdmissionDiagnosticCode =
  | TrustedToolCallDenialCode
  | "cwd_unavailable"
  | "cwd_resolution_failed"
  | "actor_resolver_failed"
  | "actor_resolver_invalid_result"
  | "actor_unresolved"
  | "run_control_unreadable"
  | "workflow_state_recovery_required"
  | "no_run_claim_present"
  | "native_authority_resolution_failed"
  | "cto_claim_mismatch"
  | "cto_marker_unauthenticated"
  | "session_controller_resolution_failed";

export type TrustedToolCallAdmissionScenario = "idle" | "selected" | "cto" | "unknown";
export type TrustedToolCallAdapterSignal = "reported" | "missing" | "threw" | "invalid";

export interface TrustedToolCallAdmissionDiagnosticOptions {
  bundleLabel?: string;
  toolName?: string;
  scenario?: TrustedToolCallAdmissionScenario;
  adapterSignal?: TrustedToolCallAdapterSignal;
}

type DiagnosticEntry = {
  explanation: string;
  action: string;
};

const DIAGNOSTICS: Record<AdmissionDiagnosticCode, DiagnosticEntry> = {
  invalid_host_context: {
    explanation: "The host did not provide a usable authenticated workflow context.",
    action: "Run the workflow from a supported interactive host with a captured workspace and session.",
  },
  untrusted_actor_context: {
    explanation: "The host actor could not be authenticated by the registered bundle adapter.",
    action: "Use the bundle's supported host entrypoint; do not substitute actor fields or copied context values.",
  },
  host_session_not_captured: {
    explanation: "The authenticated host session was not captured by the workflow lifecycle boundary.",
    action: "Start or reconnect the workflow in the supported interactive host, then retry.",
  },
  headless_host_session: {
    explanation: "The current host session is headless and cannot provide interactive workflow authority.",
    action: "Retry from an interactive TUI or RPC host session rather than a print, JSON, or task session.",
  },
  session_identity_mismatch: {
    explanation: "The host session identity does not match the captured workflow session.",
    action: "Return to the original host session or start a fresh supported session for this workspace.",
  },
  worktree_mismatch: {
    explanation: "The authenticated host session and workflow controller refer to different worktrees.",
    action: "Select the intended worktree in the host and retry without copying context between worktrees.",
  },
  host_profile_mismatch: {
    explanation: "The host profile does not match the captured interactive workflow profile.",
    action: "Reconnect using the same supported host mode and session profile that started the workflow.",
  },
  session_controller_unavailable: {
    explanation: "The registered bundle could not provide the shared workflow session controller.",
    action: "Update or enable the complete bundle integration and retry from its supported workflow entrypoint.",
  },
  controller_context_mismatch: {
    explanation: "The shared controller context does not match the authenticated host context.",
    action: "Use the controller and host session bound to the same workspace, session, and worktree.",
  },
  selected_run_mismatch: {
    explanation: "The selected workflow run does not match the run presented by the host context.",
    action: "Select the intended run through the workflow command and retry; do not edit run identifiers manually.",
  },
  execution_claim_mismatch: {
    explanation: "The canonical execution claim is absent, foreign, stale, or inconsistent with this host admission.",
    action: "Resolve the workflow run/claim through the supported lifecycle commands, then retry.",
  },
  artifacts_scope_mismatch: {
    explanation: "The claimed orchestrator artifact scope does not match the selected workflow run.",
    action: "Use the run's own artifact scope through the supported workflow controller; do not broaden paths.",
  },
  controller_resolution_failed: {
    explanation: "The workflow controller or host admission resolver failed while resolving authoritative state.",
    action: "Use the supported bundle/controller integration and report this code; do not treat it alone as evidence that the bundle is missing.",
  },
  cwd_unavailable: {
    explanation: "The host did not expose an authoritative workflow workspace.",
    action: "Run from a supported host session with a workspace-bound session manager, then retry.",
  },
  cwd_resolution_failed: {
    explanation: "The bundle's workspace resolver failed while reading the host context.",
    action: "Update the bundle/host API integration and report this code; do not substitute a process cwd.",
  },
  actor_resolver_failed: {
    explanation: "The bundle's authenticated actor resolver failed while resolving this host call.",
    action: "Update the bundle/host API integration and report this code; do not substitute actor fields or copied context.",
  },
  actor_resolver_invalid_result: {
    explanation: "The bundle's actor resolver returned an invalid result shape.",
    action: "Update the bundle adapter to the compatible core contract and report this code; do not weaken the admission gate.",
  },
  actor_unresolved: {
    explanation: "The registered actor adapter did not report an authenticated actor or denial reason.",
    action: "Use the complete compatible bundle integration and report this code with the installed versions.",
  },
  run_control_unreadable: {
    explanation: "The canonical workflow run-control state could not be read safely.",
    action: "Recover or reconcile workflow state through supported lifecycle commands; do not delete state or stop another worker.",
  },
  workflow_state_recovery_required: {
    explanation: "The workflow controller requires recovery of missing, unreadable, or invalid canonical state.",
    action: "Inspect the selected run through supported lifecycle status/recovery commands and report this code if recovery is unavailable; do not delete state, edit claims, or assume workers have stopped. Updating the bundle alone does not repair this state.",
  },
  no_run_claim_present: {
    explanation: "A no-run host proof conflicted with a non-empty canonical execution claim.",
    action: "Reconcile the existing workflow claim through supported lifecycle commands; do not delete state or stop another worker.",
  },
  native_authority_resolution_failed: {
    explanation: "Core could not resolve native worker authority for this host call.",
    action: "Retry from the same supported host session and report this code with installed versions; do not use raw actor fields.",
  },
  cto_claim_mismatch: {
    explanation: "The presented CTO proof does not match the current live CTO claim.",
    action: "Re-enter through the supported CTO lifecycle so the exact live claim is captured; do not alter claim state.",
  },
  cto_marker_unauthenticated: {
    explanation: "The task contains a CTO marker without an exact authenticated CTO claim or owned legacy authority.",
    action: "Dispatch CTO slices only through the supported authenticated CTO entrypoint.",
  },
  session_controller_resolution_failed: {
    explanation: "The shared session controller threw or returned unverifiable authoritative state.",
    action: "Report this code with installed versions so the bundle author can check the controller callback and its state access; do not substitute a different controller or assume an update repairs canonical state.",
  },
};

function safeLabel(value: unknown): string {
  if (typeof value !== "string" || value.length === 0) return "unavailable";
  const normalized = value.replace(/[^A-Za-z0-9._:@/-]/g, "_").slice(0, 80);
  return normalized || "unavailable";
}

function safeTool(value: unknown): string {
  if (typeof value !== "string" || value.length === 0) return "unknown";
  const normalized = value.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 40);
  return normalized || "unknown";
}

function adapterSignalText(signal: TrustedToolCallAdapterSignal): string {
  switch (signal) {
    case "reported": return "the adapter returned a structured result";
    case "missing": return "the adapter returned no reason";
    case "threw": return "the adapter failed while resolving";
    case "invalid": return "the adapter returned an invalid result";
  }
}

/**
 * Render only bounded, fixed core text. Resolver exceptions, host context,
 * credentials, claims, and tool inputs are intentionally never interpolated.
 */
export function trustedToolCallAdmissionDiagnostic(
  code: AdmissionDiagnosticCode,
  options: TrustedToolCallAdmissionDiagnosticOptions = {},
): string {
  const entry = DIAGNOSTICS[code];
  const scenario = options.scenario ?? "unknown";
  const adapter = options.adapterSignal ? `adapter=${adapterSignalText(options.adapterSignal)}; ` : "";
  return [
    `[workflow_admission:${code}] ${entry.explanation}`,
    `Action: ${entry.action}`,
    `Report: code=${code}; tool=${safeTool(options.toolName)}; bundle_label=${safeLabel(options.bundleLabel)}; `
      + `${adapter}scenario=${scenario}; versions=include installed OMP/core/bundle versions. `
      + "Do not include capabilities, tokens, full transcripts, raw context, tool inputs, or exception text.",
  ].join(" ");
}
