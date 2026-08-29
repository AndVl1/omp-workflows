import { createHash } from "node:crypto";
import { isAbsolute } from "node:path";
import { resolveState, resolveActiveBranch } from "../engine/state.js";
import { loadProfileByIdentity } from "../engine/profile.js";
import { validateProviderCatalog } from "../workflow-v2/descriptor.js";
import { isProviderId, isWorkflowV2Digest, projectRuntimeKeyFor, validateProjectIdentity, validateWorkflowRunIdentity } from "../workflow-v2/identity.js";
import { createDiagnostic, isDiagnosticEvidenceRecord } from "../workflow-v2/diagnostics.js";
import type { WorkflowGateContext } from "./classification.js";

import type { DispatchCapabilityState, StageDef } from "../engine/types.js";
import type {
  AgentRef,
  DiagnosticResult,
  EffectivePolicy,
  ProfileIdentity,
  ProjectIdentity,
  ProviderCatalog,
  Profile,
  WorkflowRunIdentity,
  WorkflowV2Diagnostic,
} from "../workflow-v2/types.js";

export const DISPATCH_MARKER_PREFIX = "<!-- omp-dispatch";
const MARKER_RE = /<!--\s*omp-dispatch\s+run=([^\s]+)\s+stage=([^\s]+)\s+kind=(single|consilium)\s+cursor=([^\s]+)\s+roles=([^\s]+)(?:\s+role=([^\s]+))?(?:\s+capability=([^\s]+))?(?:\s+slot=([^\s]+))?(?:\s+task=([^\s]+))?\s*-->/;

type DispatchGateResult = {
  block: true;
  reason: string;
  diagnostic: WorkflowV2Diagnostic;
};

type DispatchContextResult =
  | {
      ok: true;
      cwd: string;
      project_identity: ProjectIdentity;
      run_identity?: WorkflowRunIdentity;
      catalog: Readonly<ProviderCatalog>;
      effective_policy?: Readonly<EffectivePolicy>;
      agent_inventory?: readonly AgentRef[];
    }
  | {
      ok: false;
      blocked: DispatchGateResult;
    };

type EffectiveDispatchPolicy = {
  readonly effective_policy: Readonly<EffectivePolicy>;
  readonly profileIdentity: ProfileIdentity;
  readonly profile: Profile;
};

type StrictDispatchCapability = DispatchCapabilityState & {
  readonly capability_id: string;
  readonly dispatch_token_hash: string;
  readonly advance_token_hash: string;
};

export type DispatchMarker = {
  run: string;
  stage: string;
  kind: "single" | "consilium";
  cursor: string;
  roles: string[];
  role?: string;
  capability_id?: string;
  slot_id?: string;
  task_id?: string;
};

function diagnosticBlock(
  diagnostic: WorkflowV2Diagnostic,
  operation: WorkflowV2Diagnostic["operation"] = "tool.dispatch",
): DispatchGateResult {
  const mapped = diagnostic.operation === operation
    ? diagnostic
    : createDiagnostic({
        code: diagnostic.code,
        operation,
        evidence: diagnostic.evidence,
        remediation: diagnostic.remediation,
      });
  return {
    block: true,
    reason: `BLOCK (dispatch): ${mapped.code} — ${mapped.remediation}`,
    diagnostic: mapped,
  };
}

function dispatchBlock(
  code: WorkflowV2Diagnostic["code"],
  operation: WorkflowV2Diagnostic["operation"],
  remediation: string,
  evidence: Record<string, unknown> = {},
): DispatchGateResult {
  return diagnosticBlock(createDiagnostic({ code, operation, evidence, remediation }), operation);
}

function identityRefKey(ref: AgentRef): string {
  return `${ref.registered_name}\u0000${ref.provider_id}\u0000${ref.source_fingerprint}`;
}

function validAgentRef(value: unknown, providerId: string): value is AgentRef {
  return isDiagnosticEvidenceRecord(value)
    && typeof value.registered_name === "string"
    && value.registered_name.length > 0
    && isProviderId(value.provider_id)
    && value.provider_id === providerId
    && isWorkflowV2Digest(value.source_fingerprint);
}
function sameProfile(left: ProfileIdentity | undefined, right: ProfileIdentity | undefined): boolean {
  return left !== undefined
    && right !== undefined
    && left.id === right.id
    && left.fingerprint === right.fingerprint;
}
function runIdentityKey(identity: WorkflowRunIdentity): string {
  return JSON.stringify([
    projectRuntimeKeyFor(identity),
    identity.run_id,
    identity.profile_identity.id,
    identity.profile_identity.fingerprint,
  ]);
}

function validateEffectivePolicy(
  value: unknown,
  projectIdentity: ProjectIdentity,
  runIdentity: WorkflowRunIdentity,
  catalog: Readonly<ProviderCatalog>,
): { ok: true; value: EffectiveDispatchPolicy } | { ok: false; blocked: DispatchGateResult } {
  if (!isDiagnosticEvidenceRecord(value)) {
    return {
      ok: false,
      blocked: dispatchBlock(
        "MIGRATION_REQUIRED",
        "tool.dispatch",
        "Provide the validated effective provider policy before dispatching a workflow task.",
      ),
    };
  }
  const provider = value.provider;
  if (!isDiagnosticEvidenceRecord(provider) || provider.protocol_version !== 2) {
    return {
      ok: false,
      blocked: dispatchBlock(
        "MIGRATION_REQUIRED",
        "tool.dispatch",
        "Recompute the effective policy from the selected protocol-v2 provider descriptor and tracked policy.",
        { provider_id: projectIdentity.provider_id },
      ),
    };
  }
  const providerChecks: readonly [string, unknown, unknown][] = [
    ["provider_id", provider.id, projectIdentity.provider_id],
    ["descriptor_fingerprint", provider.descriptor_fingerprint, projectIdentity.descriptor_fingerprint],
    ["catalog_content_digest", provider.catalog_content_digest, projectIdentity.catalog_content_digest],
  ];
  const mismatch = providerChecks.find(([, actual, expected]) => actual !== expected);
  if (mismatch) {
    return {
      ok: false,
      blocked: dispatchBlock(
        "IDENTITY_MISMATCH",
        "tool.dispatch",
        "Use one effective policy whose provider, descriptor and catalog identities equal the admitted project identity.",
        {
          provider_id: projectIdentity.provider_id,
          changed_field: mismatch[0],
          expected_digest: typeof mismatch[2] === "string" ? mismatch[2] : null,
          actual_digest: typeof mismatch[1] === "string" ? mismatch[1] : null,
        },
      ),
    };
  }
  const workflow = value.workflow;
  if (!isDiagnosticEvidenceRecord(workflow) || (workflow.selection !== "fixed" && workflow.selection !== "matrix")) {
    return {
      ok: false,
      blocked: dispatchBlock(
        "MIGRATION_REQUIRED",
        "tool.dispatch",
        "Provide a validated fixed or matrix workflow selection in the effective policy.",
        { provider_id: projectIdentity.provider_id },
      ),
    };
  }
  if (workflow.selection === "fixed" && !isDiagnosticEvidenceRecord(workflow.profile_identity)) {
    return {
      ok: false,
      blocked: dispatchBlock(
        "PROFILE_UNAVAILABLE",
        "profile.resolve",
        "Provide the fixed policy profile identity before dispatching.",
        { provider_id: projectIdentity.provider_id },
      ),
    };
  }
  if (workflow.selection === "fixed" && !sameProfile(workflow.profile_identity as ProfileIdentity, runIdentity.profile_identity)) {
    return {
      ok: false,
      blocked: dispatchBlock(
        "IDENTITY_MISMATCH",
        "tool.dispatch",
        "Use the fixed policy profile identity captured by the prepared workflow run.",
        { provider_id: projectIdentity.provider_id, profile_id: runIdentity.profile_identity.id },
      ),
    };
  }
  const loaded = loadProfileByIdentity(catalog, runIdentity.profile_identity);
  if (!loaded.ok) {
    const diagnostic = loaded.diagnostics[0];
    return {
      ok: false,
      blocked: diagnostic
        ? diagnosticBlock(diagnostic, "profile.resolve")
        : dispatchBlock(
            "PROFILE_UNAVAILABLE",
            "profile.resolve",
            "Select the exact immutable profile persisted by workflow_prepare.",
            { provider_id: projectIdentity.provider_id, profile_id: runIdentity.profile_identity.id },
          ),
    };
  }
  if (!isDiagnosticEvidenceRecord(value.roles)) {
    return {
      ok: false,
      blocked: dispatchBlock(
        "MIGRATION_REQUIRED",
        "tool.dispatch",
        "Provide provider-qualified role mappings in the effective policy before dispatching.",
        { provider_id: projectIdentity.provider_id },
      ),
    };
  }
  return {
    ok: true,
    value: {
      effective_policy: value as Readonly<EffectivePolicy>,
      profileIdentity: runIdentity.profile_identity,
      profile: loaded.value,
    },
  };
}

function validateAgentInventory(
  value: unknown,
  projectIdentity: ProjectIdentity,
  effective: Readonly<EffectivePolicy>,
): { ok: true; inventory: readonly AgentRef[] } | { ok: false; blocked: DispatchGateResult } {
  if (!Array.isArray(value)) {
    return {
      ok: false,
      blocked: dispatchBlock(
        "MIGRATION_REQUIRED",
        "agent.preflight",
        "Provide the validated provider-qualified agent inventory before dispatching.",
        { provider_id: projectIdentity.provider_id },
      ),
    };
  }
  const byName = new Map<string, AgentRef>();
  const inventory: AgentRef[] = [];
  for (const candidate of value) {
    if (!validAgentRef(candidate, projectIdentity.provider_id)) {
      return {
        ok: false,
        blocked: dispatchBlock(
          "AGENT_COLLISION",
          "agent.preflight",
          "Use provider-qualified agent identities with validated source fingerprints.",
          { provider_id: projectIdentity.provider_id },
        ),
      };
    }
    const ref = candidate;
    const prior = byName.get(ref.registered_name);
    if (prior && identityRefKey(prior) !== identityRefKey(ref)) {
      return {
        ok: false,
        blocked: dispatchBlock(
          "AGENT_COLLISION",
          "agent.preflight",
          "Remove ambiguous duplicate agent names before dispatching.",
          { provider_id: projectIdentity.provider_id, candidate_id: ref.registered_name },
        ),
      };
    }
    if (!prior) {
      byName.set(ref.registered_name, ref);
      inventory.push(ref);
    }
  }
  for (const [role, candidate] of Object.entries(effective.roles)) {
    if (!validAgentRef(candidate, projectIdentity.provider_id)) {
      return {
        ok: false,
        blocked: dispatchBlock(
          "AGENT_COLLISION",
          "agent.preflight",
          "Use provider-qualified role mappings with validated source fingerprints.",
          { provider_id: projectIdentity.provider_id, candidate_id: role },
        ),
      };
    }
    const available = byName.get(candidate.registered_name);
    if (!available || identityRefKey(available) !== identityRefKey(candidate)) {
      return {
        ok: false,
        blocked: dispatchBlock(
          "AGENT_COLLISION",
          "agent.preflight",
          "Use role mappings backed by the admitted provider-qualified agent inventory.",
          { provider_id: projectIdentity.provider_id, candidate_id: candidate.registered_name },
        ),
      };
    }
  }
  return { ok: true, inventory: Object.freeze(inventory) };
}
function requireDispatchContext(ctx: unknown): DispatchContextResult {
  if (!isDiagnosticEvidenceRecord(ctx)) {
    return {
      ok: false,
      blocked: dispatchBlock(
        "MIGRATION_REQUIRED",
        "tool.dispatch",
        "Provide the admitted project identity and selected provider catalog before dispatching.",
      ),
    };
  }
  if (typeof ctx.cwd !== "string" || ctx.cwd.length === 0 || !isAbsolute(ctx.cwd)) {
    return {
      ok: false,
      blocked: dispatchBlock(
        "ROOT_UNAVAILABLE",
        "root.resolve",
        "Invoke the gate with the manager-resolved absolute project root; process.cwd is not a workflow identity source.",
      ),
    };
  }
  if (!ctx.project_identity) {
    return {
      ok: false,
      blocked: dispatchBlock(
        "MIGRATION_REQUIRED",
        "tool.dispatch",
        "Provide a complete validated profile-free ProjectIdentity before dispatching.",
      ),
    };
  }
  const project = validateProjectIdentity(ctx.project_identity);
  if (!project.ok) {
    return {
      ok: false,
      blocked: dispatchBlock(
        "MIGRATION_REQUIRED",
        "tool.dispatch",
        "Re-admit the workflow with a complete validated ProjectIdentity.",
        { invalid_project_identity: true },
      ),
    };
  }
  let runIdentity: WorkflowRunIdentity | undefined;
  if (ctx.run_identity !== undefined) {
    const run = validateWorkflowRunIdentity(ctx.run_identity);
    if (!run.ok) {
      return {
        ok: false,
        blocked: dispatchBlock(
          "MIGRATION_REQUIRED",
          "tool.dispatch",
          "Re-admit the workflow with a complete validated WorkflowRunIdentity.",
          { invalid_run_identity: true },
        ),
      };
    }
    try {
      if (projectRuntimeKeyFor(run.value) !== projectRuntimeKeyFor(project.value)) {
        return {
          ok: false,
          blocked: dispatchBlock(
            "IDENTITY_MISMATCH",
            "tool.dispatch",
            "Use a WorkflowRunIdentity inherited from the admitted ProjectIdentity.",
            { provider_id: project.value.provider_id, run_id: run.value.run_id },
          ),
        };
      }
    } catch {
      return {
        ok: false,
        blocked: dispatchBlock(
          "MIGRATION_REQUIRED",
          "tool.dispatch",
          "Re-admit the workflow with complete project and run identity pins.",
          { invalid_run_identity: true },
        ),
      };
    }
    runIdentity = run.value;
  }
  if (!ctx.catalog) {
    return {
      ok: false,
      blocked: dispatchBlock(
        "PROFILE_UNAVAILABLE",
        "catalog.validate",
        "Provide the selected immutable provider catalog before dispatching.",
        { provider_id: project.value.provider_id },
      ),
    };
  }
  let catalog: DiagnosticResult<Readonly<ProviderCatalog>>;
  try {
    catalog = validateProviderCatalog(ctx.catalog);
  } catch {
    return {
      ok: false,
      blocked: dispatchBlock(
        "PROFILE_UNAVAILABLE",
        "catalog.validate",
        "Provide a validated immutable provider catalog before dispatching.",
        { provider_id: project.value.provider_id },
      ),
    };
  }
  if (!catalog.ok) {
    const diagnostic = catalog.diagnostics[0];
    return {
      ok: false,
      blocked: diagnostic
        ? diagnosticBlock(diagnostic, "catalog.validate")
        : dispatchBlock(
            "PROFILE_UNAVAILABLE",
            "catalog.validate",
            "Provide a validated immutable provider catalog before dispatching.",
            { provider_id: project.value.provider_id },
          ),
    };
  }
  if (catalog.value.content_digest !== project.value.catalog_content_digest) {
    return {
      ok: false,
      blocked: dispatchBlock(
        "IDENTITY_MISMATCH",
        "catalog.validate",
        "Use the immutable provider catalog whose content digest matches the admitted project identity.",
        {
          provider_id: project.value.provider_id,
          expected_digest: project.value.catalog_content_digest,
          actual_digest: catalog.value.content_digest,
        },
      ),
    };
  }
  return {
    ok: true,
    cwd: ctx.cwd,
    project_identity: project.value,
    ...(runIdentity !== undefined ? { run_identity: runIdentity } : {}),
    catalog: catalog.value,
    ...(ctx.effective_policy !== undefined ? { effective_policy: ctx.effective_policy as Readonly<EffectivePolicy> } : {}),
    ...(ctx.agent_inventory !== undefined ? { agent_inventory: ctx.agent_inventory as readonly AgentRef[] } : {}),
  };
}

function stateResolutionBlock(
  resolved: { readonly diagnostics?: readonly WorkflowV2Diagnostic[] },
): DispatchGateResult {
  const source = resolved.diagnostics?.[0];
  if (source) return diagnosticBlock(source, "tool.dispatch");
  return dispatchBlock("MIGRATION_REQUIRED", "tool.dispatch", "Migrate the workflow state explicitly before dispatching.");
}

/** Stable task identity used by the marker and durable authorization layers. */
export function dispatchTaskId(capabilityId: string, runKey: string, branch: string, workflow: string, stage: string, role: string): string {
  return `task-${createHash("sha256").update(`${capabilityId}|${runKey}|${branch}|${workflow}|${stage}|${role}`).digest("hex").slice(0, 32)}`;
}

export function buildDispatchMarker(
  run: string,
  stage: StageDef,
  rolesOverride?: string[],
  role?: string,
  cursor = stage.id,
  capabilityId?: string,
  slotId?: string,
  taskId?: string,
): string {
  const roles = rolesOverride ?? (stage.type === "single" ? [stage.role ?? ""] : stage.roles ?? []);
  const rolePart = role ? ` role=${role}` : "";
  const capabilityPart = capabilityId ? ` capability=${capabilityId}` : "";
  const slotPart = slotId ? ` slot=${slotId}` : "";
  const taskPart = taskId ? ` task=${taskId}` : "";
  return `${DISPATCH_MARKER_PREFIX} run=${run} stage=${stage.id} kind=${stage.type} cursor=${cursor} roles=${roles.length > 0 ? roles.join(",") : "-"}${rolePart}${capabilityPart}${slotPart}${taskPart} -->`;
}

export function parseDispatchMarker(text: string): DispatchMarker | null {
  const match = text.match(MARKER_RE);
  if (!match) return null;
  const [run, stage, kind, cursor, rolesText, role, capability_id, slot_id, task_id] = match.slice(1);
  if (!run || !stage || !kind || !cursor || !rolesText) return null;
  const roles = rolesText === "-" ? [] : rolesText.split(",");
  if (roles.some((entry) => !entry)) return null;
  return {
    run,
    stage,
    kind: kind as DispatchMarker["kind"],
    cursor,
    roles,
    ...(role ? { role } : {}),
    ...(capability_id ? { capability_id } : {}),
    ...(slot_id ? { slot_id } : {}),
    ...(task_id ? { task_id } : {}),
  };
}

export function dispatchGate(
  event: { toolName?: string; input?: unknown },
  ctx: WorkflowGateContext,
): DispatchGateResult | undefined {
  if (event.toolName !== "task") return;

  const contextResult = requireDispatchContext(ctx);
  if (!contextResult.ok) return contextResult.blocked;
  const context = contextResult;
  const runIdentity = context.run_identity;
  if (!runIdentity) {
    return dispatchBlock(
      "MIGRATION_REQUIRED",
      "tool.dispatch",
      "Provide the exact persisted WorkflowRunIdentity before dispatching a durable task.",
    );
  }
  const currentBranch = resolveActiveBranch(context.cwd);
  const resolved = resolveState(context.cwd, currentBranch, runIdentity);
  if (resolved.invalid) return stateResolutionBlock(resolved);
  if (!resolved.state || !resolved.statePath) return;
  if (resolved.isStale) {
    return dispatchBlock(
      "IDENTITY_MISMATCH",
      "tool.dispatch",
      "Resume the workflow on the branch bound to its validated identity.",
      { expected_branch: currentBranch, actual_branch: resolved.state.branch },
    );
  }

  const state = resolved.state;
  const classification = state.classification;
  if (
    !classification
    || typeof classification !== "object"
    || typeof classification.workflow !== "string"
    || !classification.workflow
    || typeof state.branch !== "string"
    || !state.branch
    || typeof state.run_key !== "string"
    || !state.run_key
    || typeof state.stage_cursor !== "string"
    || !state.stage_cursor
    || typeof state.cursor_epoch !== "string"
    || !state.cursor_epoch
    || !Array.isArray(state.stages)
  ) {
    return dispatchBlock(
      "CONFIG_MALFORMED",
      "tool.dispatch",
      "Persist a complete identity-bound workflow state before dispatching a task.",
    );
  }
  if (state.policy?.strict_orchestrator !== true) return;

  if (context.effective_policy === undefined) {
    return dispatchBlock(
      "MIGRATION_REQUIRED",
      "tool.dispatch",
      "Provide the validated effective provider policy before dispatching an orchestrated task.",
      { provider_id: context.project_identity.provider_id },
    );
  }
  const effectiveResult = validateEffectivePolicy(context.effective_policy, context.project_identity, runIdentity, context.catalog);
  if (!effectiveResult.ok) return effectiveResult.blocked;
  const { effective_policy, profileIdentity, profile } = effectiveResult.value;
  if (profile.name !== classification.workflow) {
    return dispatchBlock(
      "PROFILE_UNAVAILABLE",
      "profile.resolve",
      "Persist the stage profile selected by the effective provider policy.",
      { provider_id: context.project_identity.provider_id, profile_id: profileIdentity.id },
    );
  }
  if (context.agent_inventory === undefined) {
    return dispatchBlock(
      "MIGRATION_REQUIRED",
      "agent.preflight",
      "Provide the validated provider-qualified agent inventory before dispatching.",
      { provider_id: context.project_identity.provider_id },
    );
  }
  const inventoryResult = validateAgentInventory(context.agent_inventory, context.project_identity, effective_policy);
  if (!inventoryResult.ok) return inventoryResult.blocked;

  const stateProject = validateProjectIdentity(state.project_identity);
  const stateRun = validateWorkflowRunIdentity(state.run_identity);
  if (!stateProject.ok || !stateRun.ok) {
    return dispatchBlock(
      "MIGRATION_REQUIRED",
      "tool.dispatch",
      "Migrate the persisted workflow state into complete ProjectIdentity and WorkflowRunIdentity records.",
      { provider_id: context.project_identity.provider_id },
    );
  }
  try {
    if (
      projectRuntimeKeyFor(stateProject.value) !== projectRuntimeKeyFor(context.project_identity)
      || runIdentityKey(stateRun.value) !== runIdentityKey(runIdentity)
    ) {
      return dispatchBlock(
        "IDENTITY_MISMATCH",
        "tool.dispatch",
        "Re-read the workflow state and use the exact project and run identity admitted for this dispatch.",
        { provider_id: context.project_identity.provider_id, run_id: stateRun.value.run_id },
      );
    }
  } catch {
    return dispatchBlock(
      "MIGRATION_REQUIRED",
      "tool.dispatch",
      "Re-admit the workflow with complete project and run identity pins.",
      { invalid_run_identity: true },
    );
  }

  const hash = profileIdentity.fingerprint;
  if (!state.profile_hash || state.profile_hash !== hash) {
    return dispatchBlock(
      "IDENTITY_MISMATCH",
      "tool.dispatch",
      "Re-read the selected provider catalog and persist its exact profile fingerprint before dispatching.",
      {
        provider_id: context.project_identity.provider_id,
        profile_id: profileIdentity.id,
        expected_digest: hash,
        actual_digest: state.profile_hash ?? null,
      },
    );
  }
  const stage = profile.stages.find((candidate) => candidate.id === state.stage_cursor);
  const persistedStage = state.stages.find((candidate) => candidate.id === state.stage_cursor);
  if (!stage || !persistedStage) {
    return dispatchBlock(
      "PROFILE_UNAVAILABLE",
      "profile.resolve",
      "Select a catalog profile containing the persisted workflow stage.",
      { provider_id: context.project_identity.provider_id, profile_id: profileIdentity.id },
    );
  }
  if (persistedStage.status !== "in_progress") {
    return dispatchBlock(
      "TRANSITION_REQUIRED",
      "tool.dispatch",
      "Advance the workflow to an in-progress stage before dispatching tasks.",
      { stage_id: state.stage_cursor },
    );
  }

  const capability = state.dispatch_capability as StrictDispatchCapability | undefined;
  const issued = capability?.issued_for;
  const expectedRunKey = state.run_key;
  const expectedRoster = capability?.expected_roster;
  const expectedRoles = capability?.expected_roles;
  const expectedCount = capability?.expected_count;
  const dispatchCount = typeof expectedCount === "number" && Number.isInteger(expectedCount) ? expectedCount : -1;
  const validRoster =
    Array.isArray(expectedRoster)
    && Array.isArray(expectedRoles)
    && dispatchCount > 0
    && dispatchCount === expectedRoster.length
    && dispatchCount === expectedRoles.length
    && expectedRoster.every((entry) => {
      const ref = entry?.agent_ref;
      return isNonEmptyString(entry?.role)
        && isNonEmptyString(entry?.agent)
        && validAgentRef(ref, context.project_identity.provider_id)
        && ref.registered_name === entry.agent;
    })
    && expectedRoles.every(isNonEmptyString)
    && new Set(expectedRoster.map((entry) => entry.role)).size === dispatchCount
    && new Set(expectedRoles).size === dispatchCount
    && expectedRoles.every((role) => expectedRoster.some((entry) => entry.role === role));
  if (
    !capability
    || (capability.status !== "ready" && capability.status !== "dispatched")
    || !issued
    || !isNonEmptyString(issued.run_key)
    || !isNonEmptyString(issued.branch)
    || !isNonEmptyString(issued.workflow)
    || !isNonEmptyString(issued.profile_hash)
    || !isNonEmptyString(issued.stage_cursor)
    || !isNonEmptyString(issued.cursor_epoch)
    || !capability.dispatch_token_hash
    || !capability.advance_token_hash
    || !capability.capability_id
    || !Array.isArray(capability.dispatches)
    || !validRoster
    || issued.run_key !== expectedRunKey
    || issued.branch !== state.branch
    || issued.workflow !== profile.name
    || issued.profile_hash !== hash
    || issued.stage_cursor !== stage.id
    || issued.cursor_epoch !== state.cursor_epoch
    || capability.expected_count !== dispatchCount
    || capability.project_identity === undefined
    || capability.run_identity === undefined
    || issued.project_identity === undefined
    || issued.run_identity === undefined
  ) {
    return dispatchBlock(
      "IDENTITY_MISMATCH",
      "tool.dispatch",
      "Re-issue the opaque dispatch capability for the current provider, profile, state and cursor identity.",
      { provider_id: context.project_identity.provider_id, profile_id: profileIdentity.id },
    );
  }
  if (!capability || !issued || !expectedRoster || !expectedRoles) {
    return dispatchBlock(
      "IDENTITY_MISMATCH",
      "tool.dispatch",
      "Re-read the opaque dispatch capability before launching tasks.",
    );
  }
  const capabilityProject = validateProjectIdentity(capability.project_identity);
  const capabilityRun = validateWorkflowRunIdentity(capability.run_identity);
  const issuedProject = validateProjectIdentity(issued.project_identity);
  const issuedRun = validateWorkflowRunIdentity(issued.run_identity);
  if (!capabilityProject.ok || !capabilityRun.ok || !issuedProject.ok || !issuedRun.ok) {
    return dispatchBlock(
      "MIGRATION_REQUIRED",
      "tool.dispatch",
      "Persist complete project and run identities on the dispatch capability before launching tasks.",
      { provider_id: context.project_identity.provider_id },
    );
  }
  try {
    if (
      projectRuntimeKeyFor(capabilityProject.value) !== projectRuntimeKeyFor(context.project_identity)
      || projectRuntimeKeyFor(issuedProject.value) !== projectRuntimeKeyFor(context.project_identity)
      || runIdentityKey(capabilityRun.value) !== runIdentityKey(runIdentity)
      || runIdentityKey(issuedRun.value) !== runIdentityKey(runIdentity)
    ) {
      return dispatchBlock(
        "IDENTITY_MISMATCH",
        "tool.dispatch",
        "Re-issue the dispatch capability under the admitted project and workflow run identity.",
        { provider_id: context.project_identity.provider_id, profile_id: profileIdentity.id },
      );
    }
  } catch {
    return dispatchBlock(
      "MIGRATION_REQUIRED",
      "tool.dispatch",
      "Re-admit the workflow before issuing a dispatch capability.",
      { invalid_run_identity: true },
    );
  }

  const input = event.input && typeof event.input === "object" && !Array.isArray(event.input)
    ? event.input as Record<string, unknown>
    : undefined;
  const items = Array.isArray(input?.tasks)
    ? input.tasks.map((candidate) => {
        const item = candidate && typeof candidate === "object" && !Array.isArray(candidate)
          ? candidate as Record<string, unknown>
          : {};
        return { item, text: String(item.task ?? "") };
      })
    : [{ item: input ?? {}, text: String(input?.task ?? "") }];
  if (items.length === 0) return dispatchBlock("CONFIG_MALFORMED", "tool.dispatch", "Provide at least one task in the dispatch request.");
  const expectedKind = stage.type === "single" ? "single" : stage.type === "consilium" ? "consilium" : null;
  if (!expectedKind) {
    return dispatchBlock(
      "TRANSITION_REQUIRED",
      "tool.dispatch",
      "Advance to a stage whose profile definition permits task dispatch.",
      { stage_id: stage.id },
    );
  }
  if (capability.kind !== expectedKind) return dispatchBlock("IDENTITY_MISMATCH", "tool.dispatch", "Re-issue the capability for the current stage kind.");
  if (items.length !== dispatchCount) {
    return dispatchBlock(
      "CONFIG_MALFORMED",
      "tool.dispatch",
      "Provide exactly the number of task slots authorized by the current stage capability.",
      { expected_count: dispatchCount, actual_count: items.length },
    );
  }

  const seenRoles = new Set<string>();
  for (const { item, text } of items) {
    const marker = parseDispatchMarker(text);
    if (
      !marker
      || marker.run !== issued.run_key
      || marker.stage !== issued.stage_cursor
      || marker.cursor !== issued.cursor_epoch
      || marker.kind !== capability.kind
      || JSON.stringify([...marker.roles].sort()) !== JSON.stringify(expectedRoster.map((entry) => entry.role).sort())
    ) {
      return dispatchBlock("IDENTITY_MISMATCH", "tool.dispatch", "Use a task marker issued for the persisted opaque dispatch capability.");
    }
    const agent = typeof item.agent === "string" ? item.agent : "";
    const role = marker.slot_id ?? marker.role ?? (typeof item.role === "string" ? item.role : "");
    const roster = expectedRoster.find((entry) => entry.role === role);
    const expectedTask = dispatchTaskId(capability.capability_id, issued.run_key, issued.branch, issued.workflow, issued.stage_cursor, role);
    const expectedRef = roster?.agent_ref;
    const semanticRole = roster?.semantic_role ?? role.replace(/#\d+$/u, "");
    const mappedRef = effective_policy.roles[semanticRole];
    if (
      marker.capability_id !== undefined && marker.capability_id !== capability.capability_id
      || marker.slot_id !== undefined && marker.slot_id !== role
      || marker.task_id !== undefined && marker.task_id !== expectedTask
      || !roster
      || seenRoles.has(role)
      || agent !== roster.agent
      || !expectedRef
      || !validAgentRef(expectedRef, context.project_identity.provider_id)
      || !mappedRef
      || identityRefKey(expectedRef) !== identityRefKey(mappedRef)
      || !inventoryResult.inventory.some((candidate) => identityRefKey(candidate) === identityRefKey(expectedRef))
    ) {
      return dispatchBlock("AGENT_COLLISION", "agent.preflight", "Use the provider-qualified role-agent identity issued by the admitted capability roster.");
    }
    seenRoles.add(role);
  }
  if (seenRoles.size !== dispatchCount) return dispatchBlock("IDENTITY_MISMATCH", "tool.dispatch", "Provide every task slot authorized by the current capability roster.");
}

export interface DispatchAuthorizationRequest {
  run_identity: WorkflowRunIdentity;
  capability_id: string;
  run_key: string;
  branch: string;
  workflow: string;
  profile_hash: string;
  stage_cursor: string;
  cursor_epoch: string;
  role: string;
  slot_id: string;
  task_id: string;
  agent: string;
  tool_call_id: string;
  expected_count: number;
  retry_of?: string;
}

export type TrustedDispatchResult =
  | { ok: true; requests: DispatchAuthorizationRequest[] }
  | { ok: false; reason: string; diagnostic: WorkflowV2Diagnostic };

function authorizationFailure(
  code: WorkflowV2Diagnostic["code"],
  remediation: string,
  evidence: Record<string, unknown> = {},
): TrustedDispatchResult {
  const diagnostic = createDiagnostic({ code, operation: "tool.dispatch", evidence, remediation });
  return {
    ok: false,
    reason: `BLOCK (dispatch): ${diagnostic.code} — ${diagnostic.remediation}`,
    diagnostic,
  };
}

/**
 * Return the state-bound authorization payload after the ordinary gate has
 * accepted a native task call. The payload contains no secret; durable.ts
 * still validates every binding before persisting the dispatch record.
 */
export function trustedDispatchRequests(
  event: { toolName?: string; toolCallId?: string; input?: unknown },
  ctx: WorkflowGateContext,
): TrustedDispatchResult {
  if (event.toolName !== "task") return authorizationFailure("CONFIG_MALFORMED", "Authorize only native task calls.");
  const contextResult = requireDispatchContext(ctx);
  if (!contextResult.ok) return authorizationFailure(
    contextResult.blocked.diagnostic.code,
    contextResult.blocked.diagnostic.remediation,
    contextResult.blocked.diagnostic.evidence,
  );
  const context = contextResult;
  const runIdentity = context.run_identity;
  if (!runIdentity) {
    return authorizationFailure(
      "MIGRATION_REQUIRED",
      "Provide the exact persisted WorkflowRunIdentity before authorizing a durable dispatch.",
    );
  }
  const resolved = resolveState(context.cwd, resolveActiveBranch(context.cwd), runIdentity);
  if (resolved.invalid) {
    const blocked = stateResolutionBlock(resolved);
    return authorizationFailure(blocked.diagnostic.code, blocked.diagnostic.remediation, blocked.diagnostic.evidence);
  }
  const state = resolved.state;
  if (!state || state.policy?.strict_orchestrator !== true) return { ok: true, requests: [] };
  const blocked = dispatchGate(event, ctx);
  if (blocked) return authorizationFailure(blocked.diagnostic.code, blocked.diagnostic.remediation, blocked.diagnostic.evidence);
  const toolCallId = event.toolCallId;
  if (!isNonEmptyString(toolCallId)) return authorizationFailure("CONFIG_MALFORMED", "Provide the native task call identity before authorizing dispatch.");
  const cap = state.dispatch_capability as StrictDispatchCapability | undefined;
  const issued = cap?.issued_for;
  if (!cap || !issued || !cap.capability_id || !Number.isInteger(cap.expected_count)) {
    return authorizationFailure("IDENTITY_MISMATCH", "Re-read the opaque dispatch capability before authorizing the task call.");
  }
  const capabilityId = cap.capability_id;
  const expectedCount = cap.expected_count as number;
  const input = event.input && typeof event.input === "object" && !Array.isArray(event.input)
    ? event.input as Record<string, unknown>
    : undefined;
  const items = Array.isArray(input?.tasks)
    ? input.tasks.map((candidate) => candidate && typeof candidate === "object" && !Array.isArray(candidate) ? candidate as Record<string, unknown> : {})
    : [input ?? {}];
  const requests: DispatchAuthorizationRequest[] = [];
  for (const item of items) {
    const marker = parseDispatchMarker(String(item.task ?? ""));
    if (!marker) return authorizationFailure("IDENTITY_MISMATCH", "Use the task marker accepted by the dispatch gate.");
    const slotId = marker.slot_id ?? marker.role ?? (typeof item.role === "string" ? item.role : "");
    if (!slotId) return authorizationFailure("IDENTITY_MISMATCH", "Provide the stable task slot identity before authorizing dispatch.");
    requests.push({
      run_identity: runIdentity,
      capability_id: capabilityId,
      run_key: issued.run_key,
      branch: issued.branch,
      workflow: issued.workflow,
      profile_hash: issued.profile_hash,
      stage_cursor: issued.stage_cursor,
      cursor_epoch: issued.cursor_epoch,
      role: slotId,
      slot_id: slotId,
      task_id: marker.task_id ?? dispatchTaskId(capabilityId, issued.run_key, issued.branch, issued.workflow, issued.stage_cursor, slotId),
      agent: typeof item.agent === "string" ? item.agent : "",
      tool_call_id: toolCallId,
      expected_count: expectedCount,
      ...(typeof item.retry_of === "string" ? { retry_of: item.retry_of } : {}),
    });
  }
  return { ok: true, requests };
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}
