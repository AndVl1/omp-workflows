/**
 * Provider-catalog profile validation and digest-pinned loading.
 *
 * Profile selection is owned by a validated provider catalog. This module keeps
 * the profile DSL/control-plane validation helpers, but never discovers or
 * selects profiles from process-global or filesystem state.
 */

import {
  computeProfileContentDigest,
  computeCatalogContentDigest,
  validateProviderCatalog,
} from "../workflow-v2/descriptor.js";
import { createDiagnostic, failureResult, successResult } from "../workflow-v2/diagnostics.js";
import { isWorkflowV2Digest } from "../workflow-v2/identity.js";
import type {
  CatalogProfile,
  DiagnosticResult,
  ProfileIdentity,
  ProviderCatalog,
} from "../workflow-v2/types.js";
import { validateProfileExpressions } from "./predicate.js";
import { validateStageFanInResolutions } from "./fan-in.js";
import type {
  CheckpointPolicy,
  CheckpointRule,
  Classification,
  Complexity,
  CompletionIntent,
  Profile,
  RosterPolicy,
  TaskType,
  WorkflowName,
} from "./types.js";

type UnknownRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function hasOwn(value: UnknownRecord, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}
function optionalString(value: unknown): boolean {
  return value === undefined || typeof value === "string";
}

function issue(issues: string[], path: string, message: string): void {
  issues.push(`${path} ${message}`);
}

function unknownKeys(value: UnknownRecord, allowed: readonly string[], path: string, issues: string[]): void {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) issue(issues, `${path}.${key}`, "unknown field");
  }
}

function stringArray(value: unknown, path: string, issues: string[], allowEmpty = true): value is string[] {
  if (!Array.isArray(value) || value.some((entry) => !nonEmptyString(entry))) {
    issue(issues, path, "must be an array of non-empty strings");
    return false;
  }
  if (!allowEmpty && value.length === 0) issue(issues, path, "must not be empty");
  return true;
}
function isNonEmptyStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry): entry is string => nonEmptyString(entry));
}

function enumValue(value: unknown, allowed: readonly string[], path: string, issues: string[]): boolean {
  if (typeof value !== "string" || !allowed.includes(value)) {
    issue(issues, path, `must be one of ${allowed.join(", ")}`);
    return false;
  }
  return true;
}

function requiredString(value: UnknownRecord, key: string, path: string, issues: string[]): void {
  if (!nonEmptyString(value[key])) issue(issues, `${path}.${key}`, "must be a non-empty string");
}

function requiredInteger(value: UnknownRecord, key: string, path: string, issues: string[], minimum = 0): void {
  const candidate = value[key];
  if (typeof candidate !== "number" || !Number.isInteger(candidate) || candidate < minimum) {
    issue(issues, `${path}.${key}`, `must be an integer >= ${minimum}`);
  }
}

function validateCompletionIntent(value: unknown, path: string, issues: string[]): void {
  if (!isRecord(value)) {
    issue(issues, path, "must be an object");
    return;
  }
  unknownKeys(value, ["mode", "acceptance", "source", "rationale"], path, issues);
  enumValue(value.mode, ["complete_outcome", "handoff_only"], `${path}.mode`, issues);
  enumValue(value.acceptance, ["dod_and_artifacts", "explicit_human_acceptance"], `${path}.acceptance`, issues);
  enumValue(value.source, ["user", "workflow_policy", "migration"], `${path}.source`, issues);
  requiredString(value, "rationale", path, issues);
}
const CHECKPOINT_KINDS: readonly string[] = [
  "product_approval",
  "clarification",
  "architecture_choice",
  "implementation_approval",
  "review_fix",
  "regression_plan",
  "integration_acceptance",
  "security",
  "destructive_side_effect",
  "production",
  "bundle_activation",
  "migration_cutover",
  "custom",
];
const HARD_HUMAN_KINDS: readonly string[] = [
  "product_approval",
  "security",
  "destructive_side_effect",
  "production",
  "bundle_activation",
  "migration_cutover",
  "custom",
];

function validateCheckpointRule(value: unknown, path: string, issues: string[], hardHuman: readonly string[], allowPendingDecisions = false): void {
  if (!isRecord(value)) {
    issue(issues, path, "must be an object");
    return;
  }
  unknownKeys(value, ["kind", "default", "allowed_decisions", "phase", "rationale"], path, issues);
  enumValue(value.kind, CHECKPOINT_KINDS, `${path}.kind`, issues);
  enumValue(value.default, ["required_human", "autonomous_allowed"], `${path}.default`, issues);
  const decisionsValid = stringArray(value.allowed_decisions, `${path}.allowed_decisions`, issues, true);
  // Migration-generated rules may legitimately carry no decisions yet
  // (CheckpointRule contract): unresolved consent stays human-required.
  if (decisionsValid && Array.isArray(value.allowed_decisions) && value.allowed_decisions.length === 0 && !allowPendingDecisions) issue(issues, `${path}.allowed_decisions`, "must not be empty for a typed rule");
  enumValue(value.phase, ["before_dispatch", "before_advance"], `${path}.phase`, issues);
  requiredString(value, "rationale", path, issues);
  if (value.default === "autonomous_allowed" && typeof value.kind === "string" && hardHuman.includes(value.kind)) {
    issue(issues, path, "hard-human rule cannot allow autonomous decisions");
  }
}

function validateCheckpointPolicy(value: unknown, path: string, issues: string[]): void {
  if (!isRecord(value)) {
    issue(issues, path, "must be an object");
    return;
  }
  unknownKeys(value, ["default", "scope", "hard_human", "rules", "source", "policy_version", "rationale"], path, issues);
  enumValue(value.default, ["required_human", "autonomous_allowed"], `${path}.default`, issues);
  enumValue(value.scope, ["decision"], `${path}.scope`, issues);
  const hardHumanValue = value.hard_human;
  const hardHumanValid = stringArray(hardHumanValue, `${path}.hard_human`, issues);
  const hardHuman = hardHumanValid ? hardHumanValue : [];
  for (const kind of hardHuman) {
    if (!HARD_HUMAN_KINDS.includes(kind)) issue(issues, `${path}.hard_human`, "unknown hard-human class");
  }
  if (!isRecord(value.rules)) {
    issue(issues, `${path}.rules`, "must be an object");
  } else {
    for (const [checkpoint, rule] of Object.entries(value.rules)) {
      if (!nonEmptyString(checkpoint)) issue(issues, `${path}.rules`, "checkpoint ids must be non-empty");
      validateCheckpointRule(rule, `${path}.rules.${checkpoint}`, issues, hardHuman, value.source === "migration");
    }
  }
  enumValue(value.source, ["profile", "user", "migration"], `${path}.source`, issues);
  requiredInteger(value, "policy_version", path, issues, 1);
  requiredString(value, "rationale", path, issues);
}

function validateRosterPolicy(value: unknown, path: string, issues: string[]): void {
  if (!isRecord(value)) {
    issue(issues, path, "must be an object");
    return;
  }
  unknownKeys(value, [
    "allowed_roles",
    "required_roles",
    "required_facets",
    "min_workers",
    "max_workers",
    "multiplicity",
    "prefer_distinct_agents",
    "selection_mode",
    "triggers",
    "budget",
  ], path, issues);
  const allowedRolesValue = value.allowed_roles;
  const allowedValid = stringArray(allowedRolesValue, `${path}.allowed_roles`, issues, false);
  const allowedRoles = allowedValid ? allowedRolesValue : [];
  const requiredRolesValue = value.required_roles;
  const requiredRolesValid = stringArray(requiredRolesValue, `${path}.required_roles`, issues);
  const requiredRoles = requiredRolesValid ? requiredRolesValue : [];
  const requiredFacetsValid = stringArray(value.required_facets, `${path}.required_facets`, issues);
  requiredInteger(value, "min_workers", path, issues);
  requiredInteger(value, "max_workers", path, issues);
  if (typeof value.min_workers === "number" && typeof value.max_workers === "number" && value.min_workers > value.max_workers) {
    issue(issues, path, "min_workers must not exceed max_workers");
  }
  if (!isRecord(value.multiplicity)) {
    issue(issues, `${path}.multiplicity`, "must be an object");
  } else {
    let minimumTotal = 0;
    for (const [role, bound] of Object.entries(value.multiplicity)) {
      if (allowedValid && !allowedRoles.includes(role)) issue(issues, `${path}.multiplicity.${role}`, "role is outside allowed_roles");
      if (!isRecord(bound)) {
        issue(issues, `${path}.multiplicity.${role}`, "must be an object");
        continue;
      }
      unknownKeys(bound, ["min", "max"], `${path}.multiplicity.${role}`, issues);
      requiredInteger(bound, "min", `${path}.multiplicity.${role}`, issues);
      requiredInteger(bound, "max", `${path}.multiplicity.${role}`, issues);
      if (typeof bound.min === "number") minimumTotal += bound.min;
      if (typeof bound.min === "number" && typeof bound.max === "number" && bound.min > bound.max) {
        issue(issues, `${path}.multiplicity.${role}`, "min must not exceed max");
      }
    }
    if (typeof value.max_workers === "number" && minimumTotal > value.max_workers) {
      issue(issues, `${path}.multiplicity`, "sum of role minima exceeds max_workers");
    }
  }
  if (allowedValid && requiredRolesValid) {
    for (const role of requiredRoles) {
      if (!allowedRoles.includes(role)) issue(issues, `${path}.required_roles`, "required role is outside allowed_roles");
    }
  }
  if (!requiredFacetsValid) {
    // The detailed diagnostic is emitted by stringArray above; keep this
    // branch explicit so future changes cannot accidentally treat malformed
    // facets as an empty optional list.
  }
  if (typeof value.prefer_distinct_agents !== "boolean") issue(issues, `${path}.prefer_distinct_agents`, "must be boolean");
  enumValue(value.selection_mode, ["pre_dispatch_minimum_valid"], `${path}.selection_mode`, issues);
  if (!isRecord(value.triggers)) {
    issue(issues, `${path}.triggers`, "must be an object");
  } else {
    unknownKeys(value.triggers, ["complexity", "confidence", "scope_flags", "evidence"], `${path}.triggers`, issues);
    const complexityValue = value.triggers.complexity;
    const confidenceValue = value.triggers.confidence;
    const complexityValid = stringArray(complexityValue, `${path}.triggers.complexity`, issues);
    const confidenceValid = stringArray(confidenceValue, `${path}.triggers.confidence`, issues);
    stringArray(value.triggers.scope_flags, `${path}.triggers.scope_flags`, issues);
    stringArray(value.triggers.evidence, `${path}.triggers.evidence`, issues);
    const complexities = complexityValid ? complexityValue : [];
    const confidences = confidenceValid ? confidenceValue : [];
    if (complexityValid) for (const item of complexities) enumValue(item, ["QUICK", "MEDIUM", "COMPLEX", "CRITICAL"], `${path}.triggers.complexity`, issues);
    if (confidenceValid) for (const item of confidences) enumValue(item, ["HIGH", "MEDIUM", "LOW"], `${path}.triggers.confidence`, issues);
  }
  if (!isRecord(value.budget)) {
    issue(issues, `${path}.budget`, "must be an object");
  } else {
    unknownKeys(value.budget, ["token_limit", "dollar_limit"], `${path}.budget`, issues);
    for (const key of ["token_limit", "dollar_limit"]) {
      const limit = value.budget[key];
      if (limit !== null && (typeof limit !== "number" || !Number.isFinite(limit) || limit < 0)) {
        issue(issues, `${path}.budget.${key}`, "must be a non-negative number or null");
      }
    }
  }
}

/** Diagnostics for typed profile fields. Legacy prose/roles are deliberately not checked here. */
export function validateProfileControlPlane(profile: unknown): { ok: true } | { ok: false; issues: string[] } {
  if (!isRecord(profile)) return { ok: false, issues: ["profile must be an object"] };
  const issues: string[] = [];
  if (hasOwn(profile, "completion_intent")) validateCompletionIntent(profile.completion_intent, "$.completion_intent", issues);
  if (hasOwn(profile, "checkpoint_policy")) validateCheckpointPolicy(profile.checkpoint_policy, "$.checkpoint_policy", issues);
  if (hasOwn(profile, "roster_policy")) validateRosterPolicy(profile.roster_policy, "$.roster_policy", issues);
  if (hasOwn(profile, "stages")) {
    if (!Array.isArray(profile.stages)) {
      issue(issues, "$.stages", "must be an array");
    } else {
      const stageIds = new Set<string>();
      profile.stages.forEach((stage, index) => {
        const path = `$.stages[${index}]`;
        if (!isRecord(stage)) {
          issue(issues, path, "must be an object");
          return;
        }
        if (typeof stage.id === "string") {
          if (stageIds.has(stage.id)) issue(issues, `${path}.id`, "duplicate stage id");
          stageIds.add(stage.id);
        }
        if (hasOwn(stage, "completion_intent")) validateCompletionIntent(stage.completion_intent, `${path}.completion_intent`, issues);
        if (hasOwn(stage, "checkpoint_policy")) validateCheckpointPolicy(stage.checkpoint_policy, `${path}.checkpoint_policy`, issues);
        if (hasOwn(stage, "roster_policy")) validateRosterPolicy(stage.roster_policy, `${path}.roster_policy`, issues);
        if (hasOwn(stage, "checkpoint") && stage.checkpoint !== undefined && !nonEmptyString(stage.checkpoint)) {
          issue(issues, `${path}.checkpoint`, "must be a non-empty string when present");
        }
        if (hasOwn(stage, "checkpoint_policy") && !nonEmptyString(stage.checkpoint)) {
          issue(issues, `${path}.checkpoint_policy`, "requires a declared checkpoint");
        }
        if (hasOwn(stage, "roster_policy")) {
          const roster = stage.roster_policy;
          if (isRecord(roster) && stage.type === "single" && (roster.min_workers !== 1 || roster.max_workers !== 1)) {
            issue(issues, `${path}.roster_policy`, "single dispatch stages require exactly one worker");
          }
          if (isRecord(roster) && ["orchestrator", "document", "bash", "none"].includes(String(stage.type))) {
            issue(issues, `${path}.roster_policy`, "non-dispatch stages cannot declare a roster policy");
          }
        }
      });
      if (isRecord(profile.checkpoint_policy) && Array.isArray(profile.stages)) {
        for (const stage of profile.stages) {
          if (!isRecord(stage) || !nonEmptyString(stage.checkpoint)) continue;
          const rules = profile.checkpoint_policy.rules;
          if (isRecord(rules) && !hasOwn(rules, stage.checkpoint)) {
            issue(issues, `$.checkpoint_policy.rules.${stage.checkpoint}`, "missing rule for declared checkpoint");
          }
        }
      }
    }
  }
  return issues.length > 0 ? { ok: false, issues } : { ok: true };
}

function assertProfileControlPlane(profile: Profile): void {
  const validation = validateProfileControlPlane(profile);
  if (!validation.ok) throw new Error(`invalid workflow profile '${profile.name} typed control-plane': ${validation.issues.join("; ")}`);
}

function migrationCompletionIntent(): CompletionIntent {
  return {
    mode: "complete_outcome",
    acceptance: "dod_and_artifacts",
    source: "migration",
    rationale: "Legacy workflow runs requested a completed outcome; this default grants no checkpoint permission.",
  };
}

function migrationCheckpointPolicy(checkpoint: string): CheckpointPolicy {
  return {
    default: "required_human",
    scope: "decision",
    hard_human: checkpoint === "product_approval" ? ["product_approval"] : [],
    rules: {
      [checkpoint]: {
        kind: checkpoint === "product_approval" ? "product_approval" : "custom",
        default: "required_human",
        allowed_decisions: checkpoint === "product_approval" ? ["proceed", "needs_more_validation", "defer", "reject"] : [],
        phase: "before_advance",
        rationale: "Legacy checkpoint declaration is migration input only; no autonomous decision is inferred.",
      },
    },
    source: "migration",
    policy_version: 1,
    rationale: "No typed checkpoint policy was persisted; unresolved consent remains human-required.",
  };
}

export interface ProfileControlPlaneProjection {
  completion_intent: CompletionIntent;
  checkpoint_policy: CheckpointPolicy | null;
  checkpoint_rule: CheckpointRule | null;
  roster_policy: RosterPolicy | null;
  provenance: "profile" | "migration";
}

/** Resolve typed profile fields before legacy prose/manifest inputs. */
export function resolveProfileControlPlane(profile: Profile, stageId?: string): ProfileControlPlaneProjection {
  assertProfileControlPlane(profile);
  const stage = stageId === undefined ? undefined : profile.stages.find((candidate) => candidate.id === stageId);
  if (stageId !== undefined && !stage) throw new Error(`workflow profile '${profile.name}' has no stage '${stageId}'`);
  const completion_intent = stage?.completion_intent ?? profile.completion_intent ?? migrationCompletionIntent();
  const checkpoint_policy = stage?.checkpoint_policy ?? profile.checkpoint_policy ?? (stage?.checkpoint ? migrationCheckpointPolicy(stage.checkpoint) : null);
  const checkpoint_rule = stage?.checkpoint ? checkpoint_policy?.rules[stage.checkpoint] ?? null : null;
  if (stage?.checkpoint && !checkpoint_rule) {
    throw new Error(`workflow profile '${profile.name}' checkpoint policy has no rule for '${stage.checkpoint}'`);
  }
  return {
    completion_intent,
    checkpoint_policy,
    checkpoint_rule,
    roster_policy: stage?.roster_policy ?? null,
    provenance: stage?.completion_intent || stage?.checkpoint_policy || stage?.roster_policy || profile.completion_intent || profile.checkpoint_policy
      ? "profile"
      : "migration",
  };
}



const STAGE_TYPES: readonly string[] = ["orchestrator", "single", "consilium", "document", "bash", "none", "team"];

function isStageInput(value: unknown): value is Profile["stages"][number] {
  if (!isRecord(value)
    || !nonEmptyString(value.id)
    || !nonEmptyString(value.title)
    || typeof value.type !== "string"
    || !STAGE_TYPES.includes(value.type)) return false;
  for (const key of ["prompt", "description", "role", "profile", "checkpoint", "autonomous", "command", "gate", "skip_if"]) {
    if (value[key] !== undefined && typeof value[key] !== "string") return false;
  }
  for (const names of [value.roles, value.teams, value.consumes]) {
    if (names !== undefined && !isNonEmptyStringArray(names)) return false;
  }
  if (value.produces !== undefined && typeof value.produces !== "string" && !isNonEmptyStringArray(value.produces)) return false;
  if (value.parallel !== undefined && typeof value.parallel !== "boolean") return false;
  if (value.integration !== undefined) {
    if (!isRecord(value.integration)
      || !nonEmptyString(value.integration.stage)
      || !nonEmptyString(value.integration.on_failure)) return false;
  }
  if (value.document !== undefined && !isRecord(value.document)) return false;
  if (value.fan_in !== undefined) {
    if (!isRecord(value.fan_in)
      || value.fan_in.resolutions !== undefined && !Array.isArray(value.fan_in.resolutions)) return false;
  }
  if (value.conditional !== undefined) {
    if (!Array.isArray(value.conditional)) return false;
    for (const conditional of value.conditional) {
      if (!isRecord(conditional)
        || !nonEmptyString(conditional.if)
        || !optionalString(conditional.add)
        || !optionalString(conditional.remove)) return false;
    }
  }
  if (value.loop !== undefined) {
    if (!isRecord(value.loop)
      || !nonEmptyString(value.loop.back_to)
      || !nonEmptyString(value.loop.until)
      || typeof value.loop.max_iterations !== "number"
      || !Number.isInteger(value.loop.max_iterations)
      || value.loop.max_iterations < 0
      || !nonEmptyString(value.loop.on_exhausted)) return false;
  }
  return (value.checkpoint_policy === undefined || isRecord(value.checkpoint_policy))
    && (value.completion_intent === undefined || isRecord(value.completion_intent))
    && (value.roster_policy === undefined || isRecord(value.roster_policy));
}

function isProfileInput(value: unknown): value is Profile {
  if (!isRecord(value)
    || !nonEmptyString(value.name)
    || typeof value.title !== "string"
    || typeof value.description !== "string"
    || !isRecord(value.match)
    || !Array.isArray(value.stages)
    || value.stages.length === 0) return false;
  const matchTypes = value.match.type;
  if (!isNonEmptyStringArray(matchTypes)) return false;
  const matchComplexity = value.match.complexity;
  if (matchComplexity !== undefined) {
    const complexityValues = matchComplexity;
    if (!isNonEmptyStringArray(complexityValues)) return false;
  }
  for (let index = 0; index < value.stages.length; index += 1) {
    if (!Object.prototype.hasOwnProperty.call(value.stages, index) || !isStageInput(value.stages[index])) return false;
  }
  return (value.completion_intent === undefined || isRecord(value.completion_intent))
    && (value.checkpoint_policy === undefined || isRecord(value.checkpoint_policy))
    && (value.autoSelect === undefined || typeof value.autoSelect === "boolean");
}

function isProfileArray(value: unknown): value is readonly Profile[] {
  if (!Array.isArray(value)) return false;
  for (let index = 0; index < value.length; index += 1) {
    if (!Object.prototype.hasOwnProperty.call(value, index) || !isProfileInput(value[index])) return false;
  }
  return true;
}

function isCatalogBuildOptions(value: unknown): value is ProviderCatalogBuildOptions {
  return isRecord(value)
    && Object.keys(value).every((key) => key === "profiles")
    && isProfileArray(value.profiles);
}

export interface ProviderCatalogBuildOptions {
  readonly profiles: readonly Profile[];
}

/** Build an immutable catalog with identities pinned to exact profile content. */
export function createProviderCatalog(profilesOrOptions: readonly Profile[] | ProviderCatalogBuildOptions): Readonly<ProviderCatalog> {
  const profiles = isProfileArray(profilesOrOptions)
    ? profilesOrOptions
    : isCatalogBuildOptions(profilesOrOptions)
      ? profilesOrOptions.profiles
      : (() => {
        throw new TypeError("cannot create a provider catalog without a profile array");
      })();
  const entries: CatalogProfile[] = profiles.map((profile) => {
    if (!isProfileInput(profile)) {
      throw new TypeError("cannot create a catalog entry from an invalid workflow profile");
    }
    assertProfileControlPlane(profile);
    const expressionDiagnostics = validateProfileExpressions(profile);
    if (expressionDiagnostics.length > 0) {
      throw new TypeError(`cannot create a catalog entry from invalid profile '${profile.name}' expressions`);
    }
    const fanInDiagnostics = profile.stages.flatMap((stage) => validateStageFanInResolutions(stage));
    if (fanInDiagnostics.length > 0) {
      throw new TypeError(`cannot create a catalog entry from invalid profile '${profile.name}' fan-in resolutions`);
    }
    return {
      identity: {
        id: profile.name,
        fingerprint: computeProfileContentDigest(profile),
      },
      profile,
    };
  });
  const content_digest = computeCatalogContentDigest({ profiles: entries });
  const catalog: ProviderCatalog = { content_digest, profiles: entries };
  const checked = validateProviderCatalog(catalog);
  if (!checked.ok) throw new TypeError("cannot create an invalid provider catalog");
  return checked.value;
}

function profileIdentityValid(value: unknown): value is ProfileIdentity {
  if (!isRecord(value)) return false;
  return Object.keys(value).length === 2
    && Object.prototype.hasOwnProperty.call(value, "id")
    && Object.prototype.hasOwnProperty.call(value, "fingerprint")
    && typeof value.id === "string"
    && /^[A-Za-z0-9._:@/#-]+$/u.test(value.id)
    && value.id.length > 0
    && isWorkflowV2Digest(value.fingerprint);
}

function profileDiagnostic(
  code: "PROFILE_UNAVAILABLE" | "IDENTITY_MISMATCH",
  profileId: string | undefined,
  remediation: string,
  evidence: Record<string, unknown> = {},
) {
  return createDiagnostic({
    code,
    operation: "profile.resolve",
    evidence: { ...(profileId === undefined ? {} : { profile_id: profileId }), ...evidence },
    remediation,
  });
}

/** Load exactly one profile by id and fingerprint from a validated catalog. */
export function loadProfileByIdentity(
  catalog: Readonly<ProviderCatalog>,
  identity: ProfileIdentity,
): DiagnosticResult<Profile> {
  const checked = validateProviderCatalog(catalog);
  if (!checked.ok) return failureResult(checked.diagnostics);
  if (!profileIdentityValid(identity)) {
    return failureResult(profileDiagnostic("IDENTITY_MISMATCH", undefined, "Use the catalog profile id and sha256 fingerprint from the selected policy."));
  }
  const entry = checked.value.profiles.find((candidate) => candidate.identity.id === identity.id);
  if (!entry) {
    return failureResult(profileDiagnostic("PROFILE_UNAVAILABLE", identity.id, "Select a profile published by the exact provider catalog."));
  }
  if (entry.identity.fingerprint !== identity.fingerprint) {
    return failureResult(profileDiagnostic(
      "IDENTITY_MISMATCH",
      identity.id,
      "Re-read the selected immutable catalog profile and preserve its fingerprint.",
      { expected_digest: identity.fingerprint, actual_digest: entry.identity.fingerprint },
    ));
  }
  return successResult(entry.profile);
}

function profileMatchesClassification(
  profile: Readonly<Profile>,
  classification: Pick<Classification, "type" | "complexity">,
): boolean {
  return profile.match.type.includes(classification.type)
    && (profile.match.complexity === undefined || profile.match.complexity.includes(classification.complexity));
}

/**
 * Resolve exactly one matrix profile from the immutable catalog and a complete
 * classification. The derived workflow name is only a deterministic tie-break
 * for catalog entries that explicitly publish it; catalog order is never used
 * as selection authority.
 */
export function resolveProfileForClassification(
  catalog: Readonly<ProviderCatalog>,
  classification: Pick<Classification, "type" | "complexity" | "autonomous"> & { workflow?: WorkflowName },
): DiagnosticResult<CatalogProfile> {
  const checked = validateProviderCatalog(catalog);
  if (!checked.ok) return failureResult(checked.diagnostics);
  let derivedWorkflow: WorkflowName;
  try {
    derivedWorkflow = resolveWorkflowForClassification(classification);
  } catch (error) {
    return failureResult(profileDiagnostic(
      "PROFILE_UNAVAILABLE",
      undefined,
      error instanceof Error ? error.message : "Provide a valid workflow classification before matrix profile resolution.",
    ));
  }
  const expectedWorkflow = classification.workflow ?? derivedWorkflow;
  const candidates = checked.value.profiles.filter((entry) => profileMatchesClassification(entry.profile, classification));
  const exact = candidates.find((entry) => entry.identity.id === expectedWorkflow);
  if (exact) return successResult(exact);
  if (candidates.length === 1) return successResult(candidates[0]!);
  return failureResult(profileDiagnostic(
    "PROFILE_UNAVAILABLE",
    expectedWorkflow,
    candidates.length === 0
      ? "No catalog profile matches the complete workflow classification."
      : "Matrix classification matches multiple catalog profiles without one exact deterministic workflow identity.",
    { candidate_count: candidates.length, classification_type: classification.type, classification_complexity: classification.complexity },
  ));
}




/**
 * Resolve a workflow from classification. Mirrors the table in
 * workflows/README.md and the bash `expected_workflow` function in
 * claude-plugin's validate-state.sh.
 *
 * Autonomous mode remains a legacy routing input for BUG_FIX -> debug-cycle.
 * It never grants checkpoint permission; typed checkpoint policy is resolved
 * separately by resolveProfileControlPlane.
 */
export function resolveWorkflow(
  type: TaskType,
  complexity: Complexity,
  autonomous: boolean,
): WorkflowName {
  const validTypes: readonly TaskType[] = [
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
  if (!validTypes.includes(type)) {
    throw new Error(`invalid workflow classification type '${String(type)}'`);
  }
  const validComplexities: readonly Complexity[] = ["QUICK", "MEDIUM", "COMPLEX", "CRITICAL"];
  if (!validComplexities.includes(complexity)) {
    throw new Error(`invalid workflow classification complexity '${String(complexity)}'`);
  }
  if (typeof autonomous !== "boolean") throw new Error("invalid workflow classification autonomous value");
  switch (type) {
    case "FEATURE":
    case "REFACTOR":
      if (complexity === "QUICK") return "lightweight";
      if (complexity === "MEDIUM") return "standard";
      return "full-feature"; // COMPLEX | CRITICAL
    case "OPS":
      if (complexity === "QUICK") return "lightweight";
      return "standard";
    case "BUG_FIX":
      if (autonomous) return "debug-cycle";
      if (complexity === "QUICK") return "bug-fix";
      return "debug-cycle"; // MEDIUM | COMPLEX | CRITICAL
    case "SPEC":
      return "spec-preparation";
    case "REGRESS":
      return "feature-regression";
    case "PRODUCT_DISCOVERY":
      return "product-discovery";
    case "INVESTIGATION":
      return "research";
    case "REVIEW":
      return "review";
    case "HOTFIX":
      return "emergency";
    default:
      throw new Error(`unsupported workflow classification type '${String(type)}'`);
  }
}

/** Matrix resolution with runtime validation for persisted/model classifications. */
export function resolveWorkflowForClassification(
  classification: Pick<Classification, "type" | "complexity" | "autonomous">,
): WorkflowName {
  if (!classification || typeof classification !== "object") throw new Error("workflow classification is missing");
  return resolveWorkflow(classification.type, classification.complexity, classification.autonomous);
}
