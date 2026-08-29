/**
 * Classification gate (P5). Replaces claude-plugin's `validate-state.sh`
 * PreToolUse(Task) hook.
 *
 * Blocks subagent launches when `.work-state/team-state.json` lacks a
 * classification, when `classification.autonomous` is missing or non-boolean
 * (fail closed — no silent default), or when the resolved `workflow` does
 * not match the Type x Complexity -> Workflow table. The autonomous flag is
 * routing/migration input only: `classification.autonomous` is preferred for
 * the legacy matrix and the top-level `autonomous` field is read only for old
 * state files. Neither field grants checkpoint permission; typed policy-bound
 * decisions do.
 *
 * Wired to `before_agent_start` so the engine catches it before the agent
 * executes.
 *
 * Gracefully degrades:
 *   - no JSON state    -> allow (legacy flow)
 *   - parse error      -> allow (transient write)
 *   - intentional override (`workflow_override: true`) -> allow, but ONLY
 *     after the model autonomy field validates: missing or non-boolean
 *     `classification.autonomous` still blocks — an explicit override can
 *     skip the workflow-mismatch check, never the fail-closed autonomy gate.
 */

/* <!-- omp-cto-slice run=01a03ee4-7dd6-7580-8ad7-16d26dc886ba slice=workflow-v2-core --> */

import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, resolve, join } from "node:path";
import { createDiagnostic, isDiagnosticEvidenceRecord } from "../workflow-v2/diagnostics.js";
import { validateProviderCatalog } from "../workflow-v2/descriptor.js";
import { loadProfileByIdentity, resolveWorkflow } from "../engine/profile.js";
import { monotonicGate } from "./monotonic.js";
import { resolveState } from "../engine/state.js";
import { checkpointPolicyLegacyConflict, validateTypedControlPlane } from "../engine/workflow-contract.js";
import type { Classification, Complexity, Profile, TaskType, CheckpointPolicy } from "../engine/types.js";
import {
  isWorkflowV2Digest,
  validateProjectIdentity,
  validateWorkflowRunIdentity,
} from "../workflow-v2/identity.js";
import type {
  AgentRef,
  DiagnosticOperation,
  EffectivePolicy,
  ProjectIdentity,
  ProviderCatalog,
  ProfileIdentity,
  WorkflowRunIdentity,
  WorkflowV2Diagnostic,
} from "../workflow-v2/types.js";

/**
 * Context supplied by the admitted v2 host. Hook payloads are untrusted, so
 * the two identity levels remain optional at this boundary. Project identity
 * is enough for classification/workflow_prepare; durable state is admitted
 * only after a required run identity has been recovered and compared.
 */
export interface WorkflowGateContext {
  readonly cwd?: string;
  readonly project_identity?: ProjectIdentity;
  readonly run_identity?: WorkflowRunIdentity;
  readonly catalog?: Readonly<ProviderCatalog>;
  readonly effective_policy?: Readonly<EffectivePolicy>;
  readonly agent_inventory?: readonly AgentRef[];
}

type ProfileGateContext = WorkflowGateContext;

type GateResult = {
  block: true;
  reason: string;
  diagnostic: WorkflowV2Diagnostic;
};

type ValidatedEffectivePolicy = Pick<Readonly<EffectivePolicy>, "provider" | "workflow">;

type ProfileContextResult =
  | {
      ok: true;
      cwd: string;
      project_identity: ProjectIdentity;
      run_identity?: WorkflowRunIdentity;
      catalog: Readonly<ProviderCatalog>;
      effective_policy?: ValidatedEffectivePolicy;
    }
  | {
      ok: false;
      blocked: GateResult;
    };

function diagnosticBlock(diagnostic: WorkflowV2Diagnostic): GateResult {
  return {
    block: true,
    reason: `BLOCK (P5): ${diagnostic.code} — ${diagnostic.remediation}`,
    diagnostic,
  };
}

function migrationBlock(operation: DiagnosticOperation, remediation: string, evidence: Record<string, unknown> = {}): GateResult {
  return diagnosticBlock(createDiagnostic({
    code: "MIGRATION_REQUIRED",
    operation,
    evidence,
    remediation,
  }));
}

function profileUnavailableBlock(
  operation: DiagnosticOperation,
  remediation: string,
  evidence: Record<string, unknown> = {},
): GateResult {
  return diagnosticBlock(createDiagnostic({
    code: "PROFILE_UNAVAILABLE",
    operation,
    evidence,
    remediation,
  }));
}

function identityMismatchBlock(
  operation: DiagnosticOperation,
  remediation: string,
  evidence: Record<string, unknown> = {},
): GateResult {
  return diagnosticBlock(createDiagnostic({
    code: "IDENTITY_MISMATCH",
    operation,
    evidence,
    remediation,
  }));
}


function rootUnavailableBlock(): GateResult {
  return diagnosticBlock(createDiagnostic({
    code: "ROOT_UNAVAILABLE",
    operation: "root.resolve",
    remediation: "Invoke the gate with the manager-resolved project root; process.cwd is not a workflow identity source.",
  }));
}
function stateResolutionBlock(
  resolved: { readonly invalid?: boolean; readonly diagnostics?: readonly WorkflowV2Diagnostic[] },
  operation: DiagnosticOperation,
): GateResult {
  const source = resolved.diagnostics?.[0];
  if (source) {
    return diagnosticBlock(createDiagnostic({
      code: source.code,
      operation,
      evidence: source.evidence,
      remediation: source.remediation,
    }));
  }
  return migrationBlock(operation, "Migrate the workflow state explicitly before launching agents.");
}

function projectIdentityKey(identity: ProjectIdentity): string {
  return JSON.stringify([
    identity.root_instance_id,
    identity.provider_id,
    identity.descriptor_fingerprint,
    identity.executable_provenance.build_fingerprint,
    identity.executable_provenance.runtime_fingerprint,
    identity.catalog_content_digest,
    identity.config_byte_sha256,
    identity.config_semantic_sha256,
    identity.session.session_id,
    identity.session.lifecycle_id,
  ]);
}

function runIdentityKey(identity: WorkflowRunIdentity): string {
  return JSON.stringify([
    projectIdentityKey(identity),
    identity.run_id,
    identity.profile_identity.id,
    identity.profile_identity.fingerprint,
  ]);
}

const PROFILE_ID_PATTERN = /^[A-Za-z0-9._:@/#-]+$/u;
const TASK_TYPES: readonly TaskType[] = [
  "FEATURE",
  "REFACTOR",
  "OPS",
  "BUG_FIX",
  "SPEC",
  "REGRESS",
  "INVESTIGATION",
  "REVIEW",
  "HOTFIX",
  "PRODUCT_DISCOVERY",
];
const COMPLEXITIES: readonly Complexity[] = ["QUICK", "MEDIUM", "COMPLEX", "CRITICAL"];

function isProfileIdentity(value: unknown): value is ProfileIdentity {
  return isDiagnosticEvidenceRecord(value)
    && Object.keys(value).length === 2
    && typeof value.id === "string"
    && value.id.length > 0
    && PROFILE_ID_PATTERN.test(value.id)
    && isWorkflowV2Digest(value.fingerprint);
}

function isTaskType(value: unknown): value is TaskType {
  return TASK_TYPES.some((candidate) => candidate === value);
}

function isComplexity(value: unknown): value is Complexity {
  return COMPLEXITIES.some((candidate) => candidate === value);
}

function isCheckpointPolicy(value: unknown): value is CheckpointPolicy {
  if (!isDiagnosticEvidenceRecord(value)) return false;
  const checked = validateTypedControlPlane({ checkpoint_policy: value });
  if (checked.ok) return true;
  return value.source === "migration"
    && checked.issues.every((issue) => (
      issue.path.endsWith(".allowed_decisions")
      && issue.message.includes("must not be empty")
    ));
}


function validateEffectivePolicy(
  value: unknown,
  projectIdentity: ProjectIdentity,
  catalog: Readonly<ProviderCatalog>,
  operation: DiagnosticOperation,
): { ok: true; effective_policy: ValidatedEffectivePolicy } | { ok: false; blocked: GateResult } {
  if (!isDiagnosticEvidenceRecord(value)) {
    return {
      ok: false,
      blocked: migrationBlock(operation, "Provide the validated effective v2 policy selected by the admitted provider runtime."),
    };
  }
  const provider = value.provider;
  if (!isDiagnosticEvidenceRecord(provider) || provider.protocol_version !== 2) {
    return {
      ok: false,
      blocked: migrationBlock(
        operation,
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
      blocked: identityMismatchBlock(
        operation,
        "Use one effective policy whose provider, descriptor and catalog identities equal the admitted project activation.",
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
      blocked: migrationBlock(
        operation,
        "Provide a validated effective workflow selection with a fixed or matrix mode.",
        { provider_id: projectIdentity.provider_id },
      ),
    };
  }
  let effectiveWorkflow: ValidatedEffectivePolicy["workflow"];
  if (workflow.selection === "fixed") {
    const selected = workflow.profile_identity;
    if (!isProfileIdentity(selected)) {
      return {
        ok: false,
        blocked: migrationBlock(
          operation,
          "Provide the exact fixed catalog profile identity in the effective provider policy.",
          { provider_id: projectIdentity.provider_id },
        ),
      };
    }
    const loaded = loadProfileByIdentity(catalog, selected);
    if (!loaded.ok) {
      const diagnostic = loaded.diagnostics[0];
      return {
        ok: false,
        blocked: diagnostic ? diagnosticBlock(diagnostic) : profileUnavailableBlock(
          operation,
          "Select an available immutable profile from the admitted provider catalog.",
          { provider_id: projectIdentity.provider_id },
        ),
      };
    }
    effectiveWorkflow = { selection: "fixed", profile_identity: selected };
  } else {
    effectiveWorkflow = { selection: "matrix" };
  }
  return {
    ok: true,
    effective_policy: {
      provider: {
        id: projectIdentity.provider_id,
        protocol_version: 2,
        descriptor_fingerprint: projectIdentity.descriptor_fingerprint,
        catalog_content_digest: projectIdentity.catalog_content_digest,
      },
      workflow: effectiveWorkflow,
    },
  };
}

function requireProjectContext(ctx: unknown, operation: DiagnosticOperation): ProfileContextResult {
  if (!isDiagnosticEvidenceRecord(ctx)) {
    return {
      ok: false,
      blocked: migrationBlock(operation, "Provide the admitted project identity and immutable provider catalog before invoking the gate."),
    };
  }
  const cwd = ctx.cwd;
  if (typeof cwd !== "string" || cwd.length === 0 || !isAbsolute(cwd)) {
    return { ok: false, blocked: rootUnavailableBlock() };
  }
  if (!ctx.project_identity || !ctx.catalog) {
    return {
      ok: false,
      blocked: migrationBlock(
        operation,
        "Provide the manager-resolved root together with the complete profile-free project identity and provider catalog.",
      ),
    };
  }
  const checkedProject = validateProjectIdentity(ctx.project_identity);
  if (!checkedProject.ok) {
    return {
      ok: false,
      blocked: migrationBlock(
        operation,
        "Re-admit the workflow with a complete profile-free ProjectIdentity; cwd alone cannot select a profile.",
        { invalid_project_identity: true },
      ),
    };
  }
  const checkedCatalog = validateProviderCatalog(ctx.catalog);
  if (!checkedCatalog.ok) {
    const diagnostic = checkedCatalog.diagnostics[0];
    return {
      ok: false,
      blocked: diagnostic ? diagnosticBlock(diagnostic) : profileUnavailableBlock(
        operation,
        "Use a validated immutable provider catalog before resolving a workflow profile.",
        { provider_id: checkedProject.value.provider_id },
      ),
    };
  }
  if (checkedCatalog.value.content_digest !== checkedProject.value.catalog_content_digest) {
    return {
      ok: false,
      blocked: identityMismatchBlock(
        operation,
        "Use the immutable provider catalog whose content digest matches the admitted project identity.",
        {
          provider_id: checkedProject.value.provider_id,
          expected_digest: checkedProject.value.catalog_content_digest,
          actual_digest: checkedCatalog.value.content_digest,
        },
      ),
    };
  }
  let runIdentity: WorkflowRunIdentity | undefined;
  if (ctx.run_identity !== undefined) {
    const checkedRun = validateWorkflowRunIdentity(ctx.run_identity);
    if (!checkedRun.ok) {
      return {
        ok: false,
        blocked: migrationBlock(
          operation,
          "Re-admit the workflow with a complete required WorkflowRunIdentity for durable state.",
          { invalid_run_identity: true, provider_id: checkedProject.value.provider_id },
        ),
      };
    }
    if (projectIdentityKey(checkedRun.value) !== projectIdentityKey(checkedProject.value)) {
      return {
        ok: false,
        blocked: identityMismatchBlock(
          operation,
          "Use a WorkflowRunIdentity whose inherited project pins equal the admitted ProjectIdentity.",
          { provider_id: checkedProject.value.provider_id, run_id: checkedRun.value.run_id },
        ),
      };
    }
    runIdentity = checkedRun.value;
  }
  const effective = ctx.effective_policy === undefined
    ? undefined
    : validateEffectivePolicy(ctx.effective_policy, checkedProject.value, checkedCatalog.value, operation);
  if (effective && !effective.ok) return effective;
  return {
    ok: true,
    cwd,
    project_identity: checkedProject.value,
    ...(runIdentity ? { run_identity: runIdentity } : {}),
    catalog: checkedCatalog.value,
    ...(effective ? { effective_policy: effective.effective_policy } : {}),
  };
}

function sameProfile(left: ProfileIdentity | undefined, right: ProfileIdentity | undefined): boolean {
  return left?.id === right?.id && left?.fingerprint === right?.fingerprint;
}

function stateIdentityFor(
  state: { run_identity?: unknown },
  context: ProfileContextResult & { ok: true },
  operation: DiagnosticOperation,
): { ok: true; run_identity: WorkflowRunIdentity } | { ok: false; blocked: GateResult } {
  if (state.run_identity === undefined) {
    return {
      ok: false,
      blocked: migrationBlock(
        operation,
        "Migrate the persisted workflow state into a required WorkflowRunIdentity before resolving its profile.",
        { provider_id: context.project_identity.provider_id },
      ),
    };
  }
  const checked = validateWorkflowRunIdentity(state.run_identity);
  if (!checked.ok) {
    return {
      ok: false,
      blocked: migrationBlock(
        operation,
        "Migrate the persisted workflow state into a complete WorkflowRunIdentity.",
        { provider_id: context.project_identity.provider_id },
      ),
    };
  }
  if (projectIdentityKey(checked.value) !== projectIdentityKey(context.project_identity)) {
    return {
      ok: false,
      blocked: identityMismatchBlock(
        operation,
        "Re-read the workflow state and use the same root, provider, catalog, config, session and source pins as the admitted project.",
        {
          provider_id: context.project_identity.provider_id,
          run_id: checked.value.run_id,
        },
      ),
    };
  }
  if (context.run_identity && runIdentityKey(checked.value) !== runIdentityKey(context.run_identity)) {
    return {
      ok: false,
      blocked: identityMismatchBlock(
        operation,
        "Re-read the workflow state and use the exact persisted run and profile identity supplied by the admitted context.",
        {
          provider_id: context.project_identity.provider_id,
          expected_run_id: context.run_identity.run_id,
          actual_run_id: checked.value.run_id,
          expected_profile_id: context.run_identity.profile_identity.id,
          actual_profile_id: checked.value.profile_identity.id,
        },
      ),
    };
  }
  return { ok: true, run_identity: checked.value };
}

function profileForContext(
  context: ProfileContextResult & { ok: true },
  workflow: string,
  operation: DiagnosticOperation,
): { ok: true; profile: Profile; profileIdentity: ProfileIdentity } | { ok: false; blocked: GateResult } {
  const effective = context.effective_policy;
  if (!effective) {
    return {
      ok: false,
      blocked: migrationBlock(
        operation,
        `Workflow '${workflow}' requires the validated effective provider policy; cwd or a global profile is not authoritative at this gate.`,
        { provider_id: context.project_identity.provider_id, workflow },
      ),
    };
  }
  const profileIdentity = context.run_identity?.profile_identity
    ?? (effective.workflow.selection === "fixed" ? effective.workflow.profile_identity : undefined);
  if (!profileIdentity) {
    return {
      ok: false,
      blocked: profileUnavailableBlock(
        operation,
        `Workflow '${workflow}' requires the exact profile identity persisted by workflow_prepare; matrix selection cannot be re-resolved at a durable gate.`,
        { provider_id: context.project_identity.provider_id, workflow },
      ),
    };
  }
  if (effective.workflow.selection === "fixed" && !sameProfile(effective.workflow.profile_identity, profileIdentity)) {
    return {
      ok: false,
      blocked: identityMismatchBlock(
        operation,
        "Use the fixed profile identity captured by the effective provider policy and the persisted workflow run.",
        { provider_id: context.project_identity.provider_id, profile_id: profileIdentity.id },
      ),
    };
  }
  if (context.run_identity && !sameProfile(context.run_identity.profile_identity, profileIdentity)) {
    return {
      ok: false,
      blocked: identityMismatchBlock(
        operation,
        "Use the exact profile identity captured by the persisted workflow run.",
        { provider_id: context.project_identity.provider_id, profile_id: profileIdentity.id },
      ),
    };
  }
  const loaded = loadProfileByIdentity(context.catalog, profileIdentity);
  if (!loaded.ok) {
    const diagnostic = loaded.diagnostics[0];
    return {
      ok: false,
      blocked: diagnostic ? diagnosticBlock(diagnostic) : profileUnavailableBlock(
        operation,
        `Select an available immutable catalog profile for '${workflow}'.`,
        { provider_id: context.project_identity.provider_id, profile_id: profileIdentity.id },
      ),
    };
  }
  if (loaded.value.name !== workflow) {
    return {
      ok: false,
      blocked: profileUnavailableBlock(
        operation,
        `The selected catalog profile identity does not contain workflow '${workflow}'.`,
        { provider_id: context.project_identity.provider_id, profile_id: profileIdentity.id, workflow },
      ),
    };
  }
  return { ok: true, profile: loaded.value, profileIdentity };
}

function profileMatchesClassification(profile: Profile, type: TaskType, complexity: Complexity): boolean {
  return profile.match.type.includes(type)
    && (profile.match.complexity === undefined || profile.match.complexity.includes(complexity));
}

const WORK_STATE_DIR = ".work-state";
const ACTIVE_FEATURE = ".active-feature";
const LEGACY_STATE = "team-state.json";
interface AgentStartEvent {
  /** Optional agent type/name. */
  agent?: string;
}

interface AgentStartContext extends ProfileGateContext {}

interface ToolCallEvent {
  toolName: string;
}

/**
 * Enforce the zero-step contract at the task boundary. A workflow run that
 * has initialized `.work-state/` must persist classification before spawning
 * any subagent. Projects without workflow state retain legacy behavior only
 * after the v2 context has been admitted.
 */
function monotonicResult(
  result: { readonly block?: boolean; readonly reason?: string } | void,
  providerId: string,
): GateResult | void {
  if (!result?.block) return;
  const reason = result.reason ?? "BLOCK (P4): monotonic workflow state validation failed.";
  let code: WorkflowV2Diagnostic["code"] = "CONFIG_MALFORMED";
  let remediation = reason;
  if (reason.startsWith("MIGRATION_REQUIRED:")) {
    code = "MIGRATION_REQUIRED";
    remediation = reason.slice("MIGRATION_REQUIRED:".length).trim();
  } else if (reason.startsWith("IDENTITY_MISMATCH:")) {
    code = "IDENTITY_MISMATCH";
    remediation = reason.slice("IDENTITY_MISMATCH:".length).trim();
  } else if (reason.startsWith("BLOCK (P4):")) {
    remediation = reason.slice("BLOCK (P4):".length).trim();
  }
  const diagnostic = createDiagnostic({
    code,
    operation: "profile.resolve",
    evidence: { provider_id: providerId },
    remediation: remediation || "Repair the persisted workflow state before launching agents.",
  });
  return { block: true, reason, diagnostic };
}

export function classificationToolGate(event: ToolCallEvent, ctx: AgentStartContext): GateResult | void {
  if (event.toolName !== "task") return;
  const context = requireProjectContext(ctx, "profile.resolve");
  if (!context.ok) return context.blocked;

  const wsDir = resolve(context.cwd, WORK_STATE_DIR);
  if (!existsSync(wsDir)) return;
  const active = join(wsDir, ACTIVE_FEATURE);
  const legacy = join(wsDir, LEGACY_STATE);
  if (!existsSync(active) && !existsSync(legacy)) return;

  const resolved = resolveState(context.cwd, undefined, context.run_identity);
  if (resolved.invalid) return stateResolutionBlock(resolved, "profile.resolve");
  if (!resolved.statePath) {
    return migrationBlock(
      "profile.resolve",
      "Persist a readable identity-bound v2 classification state before launching agents.",
      { provider_id: context.project_identity.provider_id },
    );
  }
  const stateIdentity = resolved.state ? stateIdentityFor(resolved.state, context, "profile.resolve") : undefined;
  if (stateIdentity && !stateIdentity.ok) return stateIdentity.blocked;
  if (!stateIdentity) {
    return migrationBlock(
      "profile.resolve",
      "Persist a required WorkflowRunIdentity before launching agents.",
      { provider_id: context.project_identity.provider_id },
    );
  }

  // The complete classification contract is enforced pre-execution. The
  // before_agent_start hook remains a reminder only (OMP cannot block there).
  const classification = classificationGateForContext({
    ...ctx,
    run_identity: stateIdentity.run_identity,
  });
  if (classification?.block) return classification;
  return monotonicResult(monotonicGate(event, {
    cwd: context.cwd,
    run_identity: stateIdentity.run_identity,
    state: resolved.state,
  }), context.project_identity.provider_id);
}

export function classificationGate(_event: AgentStartEvent, ctx: AgentStartContext): GateResult | void {
  return classificationGateForContext(ctx);
}

function classificationGateForContext(ctx: AgentStartContext): GateResult | void {
  const context = requireProjectContext(ctx, "profile.resolve");
  if (!context.ok) return context.blocked;

  const resolved = resolveState(context.cwd, undefined, context.run_identity);
  if (resolved.invalid) return stateResolutionBlock(resolved, "profile.resolve");
  const statePath = resolved.statePath;
  if (!statePath) return;

  let raw: string;
  try {
    raw = readFileSync(statePath, "utf8");
  } catch {
    return migrationBlock(
      "profile.resolve",
      "Persist a readable identity-bound v2 classification state before launching agents.",
      { provider_id: context.project_identity.provider_id },
    );
  }
  let state: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!isDiagnosticEvidenceRecord(parsed)) {
      return diagnosticBlock(createDiagnostic({
        code: "CONFIG_MALFORMED",
        operation: "profile.resolve",
        remediation: "Rewrite the workflow state as a JSON object with a required WorkflowRunIdentity.",
      }));
    }
    state = parsed;
  } catch {
    return diagnosticBlock(createDiagnostic({
      code: "CONFIG_MALFORMED",
      operation: "profile.resolve",
      remediation: "Rewrite the workflow state as valid JSON and preserve its required WorkflowRunIdentity.",
    }));
  }

  const stateIdentity = stateIdentityFor(state, context, "profile.resolve");
  if (!stateIdentity.ok) return stateIdentity.blocked;
  const boundContext: ProfileContextResult & { ok: true } = {
    ...context,
    run_identity: stateIdentity.run_identity,
  };

  // Typed control-plane validation is deliberately first. Legacy autonomy
  // cannot rescue malformed/unknown typed policy, intent, or decisions.
  const stateTyped = validateTypedControlPlane(state);
  const checkpointPolicyValue = state.checkpoint_policy;
  const stateIssues = stateTyped.ok
    ? []
    : stateTyped.issues.filter((issue) => !(
      isDiagnosticEvidenceRecord(checkpointPolicyValue)
      && checkpointPolicyValue.source === "migration"
      && issue.path.endsWith(".allowed_decisions")
      && issue.message.includes("must not be empty")
    ));
  if (stateIssues.length > 0) {
    return diagnosticBlock(createDiagnostic({
      code: "CONFIG_MALFORMED",
      operation: "profile.resolve",
      evidence: { count: stateIssues.length },
      remediation: "Repair typed workflow control-plane fields before launching agents.",
    }));
  }
  const classificationValue = state.classification;
  if (classificationValue !== undefined) {
    const classificationTyped = validateTypedControlPlane(classificationValue);
    if (!classificationTyped.ok) {
      return diagnosticBlock(createDiagnostic({
        code: "CONFIG_MALFORMED",
        operation: "profile.resolve",
        evidence: { count: classificationTyped.issues.length },
        remediation: "Repair typed classification fields before launching agents.",
      }));
    }
  }

  const c = classificationValue;
  if (!isDiagnosticEvidenceRecord(c) || !isTaskType(c.type) || !isComplexity(c.complexity)) {
    return diagnosticBlock(createDiagnostic({
      code: "CONFIG_MALFORMED",
      operation: "profile.resolve",
      remediation: "Persist a complete PHASE-0 classification before launching agents.",
    }));
  }
  const type = c.type;
  const complexity = c.complexity;

  // Resolve policy and floor before the workflow override escape hatch. An
  // override may select a profile from the admitted immutable catalog; it
  // cannot invent permission or downgrade a hard-human rule.
  const workflow = typeof c.workflow === "string" && c.workflow.length > 0 ? c.workflow : undefined;
  let profile: Profile | undefined;
  if (workflow) {
    const resolvedProfile = profileForContext(boundContext, workflow, "profile.resolve");
    if (!resolvedProfile.ok) return resolvedProfile.blocked;
    profile = resolvedProfile.profile;
    if (state.profile_hash !== undefined && state.profile_hash !== resolvedProfile.profileIdentity.fingerprint) {
      return identityMismatchBlock(
        "profile.resolve",
        "Re-read the selected provider catalog and persist its exact profile fingerprint before launching agents.",
        {
          provider_id: context.project_identity.provider_id,
          profile_id: workflow,
          expected_digest: resolvedProfile.profileIdentity.fingerprint,
          actual_digest: state.profile_hash,
        },
      );
    }
    if (!sameProfile(stateIdentity.run_identity.profile_identity, resolvedProfile.profileIdentity)) {
      return identityMismatchBlock(
        "profile.resolve",
        "Re-migrate the workflow state so its selected profile identity matches the admitted provider catalog.",
        {
          provider_id: context.project_identity.provider_id,
          profile_id: stateIdentity.run_identity.profile_identity.id,
        },
      );
    }
  }
  const stageCursor = typeof state.stage_cursor === "string" ? state.stage_cursor : undefined;
  const stage = profile?.stages.find((candidate) => candidate.id === stageCursor);
  const persistedPolicy = state.checkpoint_policy;
  const policy = persistedPolicy === undefined
    ? stage?.checkpoint_policy ?? profile?.checkpoint_policy
    : isCheckpointPolicy(persistedPolicy)
      ? persistedPolicy
      : undefined;
  if (stage?.checkpoint) {
    if (!policy) {
      return diagnosticBlock(createDiagnostic({
        code: "CONFIG_MALFORMED",
        operation: "profile.resolve",
        evidence: { profile_id: profile?.name ?? null },
        remediation: "Declare a typed checkpoint policy for the current checkpoint before launching agents.",
      }));
    }
    const rule = policy.rules[stage.checkpoint];
    if (!rule) {
      return diagnosticBlock(createDiagnostic({
        code: "CONFIG_MALFORMED",
        operation: "profile.resolve",
        evidence: { profile_id: profile?.name ?? null },
        remediation: "Declare a typed checkpoint policy rule for the current checkpoint before launching agents.",
      }));
    }
    const floorKinds: Record<string, true> = {
      product_approval: true,
      security: true,
      destructive_side_effect: true,
      production: true,
      bundle_activation: true,
      migration_cutover: true,
    };
    const floor = floorKinds[rule.kind] === true || policy.hard_human.includes(rule.kind);
    if (floor && (policy.default === "autonomous_allowed" || rule.default === "autonomous_allowed")) {
      return diagnosticBlock(createDiagnostic({
        code: "CONFIG_MALFORMED",
        operation: "profile.resolve",
        evidence: { profile_id: profile?.name ?? null },
        remediation: "Hard-human checkpoints cannot permit policy_auto.",
      }));
    }
  }

  // Fail-closed autonomy validation remains required during the migration
  // window because it still routes the legacy profile matrix. It never grants
  // checkpoint permission.
  const autonomous = resolveAutonomous(state);
  if (autonomous === undefined) {
    return migrationBlock("profile.resolve", autonomousBlockReason(state), { provider_id: context.project_identity.provider_id });
  }
  if (policy) {
    const conflict = checkpointPolicyLegacyConflict(policy, autonomous);
    if (conflict) return diagnosticBlock(createDiagnostic({
      code: "IDENTITY_MISMATCH",
      operation: "profile.resolve",
      remediation: "Reconcile the typed checkpoint policy with the persisted routing decision.",
    }));
  }

  if (state.workflow_override === true) return;

  let expected: string;
  try {
    expected = resolveWorkflow(type, complexity, autonomous);
  } catch {
    return diagnosticBlock(createDiagnostic({
      code: "CONFIG_MALFORMED",
      operation: "profile.resolve",
      remediation: "Persist a supported classification type, complexity and boolean autonomy decision.",
    }));
  }
  const actual = c.workflow;
  if (actual && actual !== expected) {
    // Non-autonomous runs may pick the selected provider profile whose match
    // table accepts this classification (intentional override). Autonomous
    // runs resolve through the MODEL routing field and may not be downgraded.
    if (!autonomous && profile && profile.name === actual && profileMatchesClassification(profile, type, complexity)) return;
    return diagnosticBlock(createDiagnostic({
      code: "CONFIG_MALFORMED",
      operation: "profile.resolve",
      evidence: { profile_id: actual },
      remediation: "Align the persisted workflow with the classification matrix or apply an explicit validated override.",
    }));
  }
}

function resolveAutonomous(state: {
  classification?: unknown;
  autonomous?: unknown;
}): boolean | undefined {
  const classification = state.classification;
  const modelAutonomous = isDiagnosticEvidenceRecord(classification)
    ? classification.autonomous
    : undefined;
  if (modelAutonomous !== undefined) {
    return typeof modelAutonomous === "boolean" ? modelAutonomous : undefined;
  }
  if (typeof state.autonomous === "boolean") return state.autonomous;
  return undefined;
}

function autonomousBlockReason(state: {
  classification?: unknown;
  autonomous?: unknown;
}): string {
  const classification = state.classification;
  const modelAutonomous = isDiagnosticEvidenceRecord(classification)
    ? classification.autonomous
    : undefined;
  if (modelAutonomous !== undefined) {
    return `BLOCK (P5): classification.autonomous must be a boolean, got ${JSON.stringify(modelAutonomous)}. Fail closed — the model decision is invalid and no silent default applies.`;
  }
  return "BLOCK (P5): classification.autonomous is missing. PHASE-0 must decide `autonomous: true | false`; no silent default and no workflow can be resolved without it.";
}
