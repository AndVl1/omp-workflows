import { createHash } from "node:crypto";
/**
 * Profile loader and classification resolver.
 *
 * Same model as claude-plugin: same JSON profile format, same selection order,
 * same Type x Complexity -> Workflow table.
 */

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
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

/** Selection order — first match wins. */
const SELECTION_ORDER: WorkflowName[] = [
  "full-feature",
  "debug-cycle",
  "bug-fix",
  "standard",
  "lightweight",
  "research",
  "lecture-research",
  "product-discovery",
  "spec-preparation",
  "feature-regression",
  "review",
  "emergency",
];
const registeredProfiles = new Map<string, Profile>();

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
  if (!Number.isInteger(value[key]) || (value[key] as number) < minimum) {
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
const CHECKPOINT_KINDS = [
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
] as const;
const HARD_HUMAN_KINDS = [
  "product_approval",
  "security",
  "destructive_side_effect",
  "production",
  "bundle_activation",
  "migration_cutover",
  "custom",
] as const;

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
  const hardHumanValid = stringArray(value.hard_human, `${path}.hard_human`, issues);
  const hardHuman = hardHumanValid ? value.hard_human as string[] : [];
  for (const kind of hardHuman) {
    if (!HARD_HUMAN_KINDS.includes(kind as (typeof HARD_HUMAN_KINDS)[number])) issue(issues, `${path}.hard_human`, "unknown hard-human class");
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
  const allowedValid = stringArray(value.allowed_roles, `${path}.allowed_roles`, issues, false);
  const allowedRoles = allowedValid ? value.allowed_roles as string[] : [];
  const requiredRolesValid = stringArray(value.required_roles, `${path}.required_roles`, issues);
  const requiredRoles = requiredRolesValid ? value.required_roles as string[] : [];
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
    const complexityValid = stringArray(value.triggers.complexity, `${path}.triggers.complexity`, issues);
    const confidenceValid = stringArray(value.triggers.confidence, `${path}.triggers.confidence`, issues);
    stringArray(value.triggers.scope_flags, `${path}.triggers.scope_flags`, issues);
    stringArray(value.triggers.evidence, `${path}.triggers.evidence`, issues);
    const complexities = complexityValid ? value.triggers.complexity as string[] : [];
    const confidences = confidenceValid ? value.triggers.confidence as string[] : [];
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

/** Register bundle-owned profiles for the core interpreter. */
export function registerWorkflowProfiles(profiles: Profile[]): void {
  for (const profile of profiles) {
    if (!profile.name || !profile.stages?.length || !profile.match?.type) {
      throw new Error(`invalid workflow profile registration: ${JSON.stringify(profile)}`);
    }
    assertProfileControlPlane(profile);
    // Reject unsupported DSL at load: an expression that cannot parse must
    // never silently evaluate to false during a run.
    const diagnostics = validateProfileExpressions(profile);
    if (diagnostics.length > 0) {
      throw new Error(`invalid workflow profile '${profile.name}' expressions: ${diagnostics.join("; ")}`);
    }
    // Reject malformed fan-in resolutions at load: a resolution must
    // deliberately document exactly how a required-scalar disagreement is
    // resolved, so it can never resolve a disagreement silently.
    const fanInDiagnostics = profile.stages.flatMap((stage) => validateStageFanInResolutions(stage));
    if (fanInDiagnostics.length > 0) {
      throw new Error(`invalid workflow profile '${profile.name}' fan-in resolutions: ${fanInDiagnostics.join("; ")}`);
    }
    registeredProfiles.set(profile.name, profile);
  }
}
export function isRegisteredWorkflow(name: string): boolean {
  return registeredProfiles.has(name) || loadAllProfiles().some((profile) => profile.name === name);
}

export function matchesProfile(name: string, c: Pick<Classification, "type" | "complexity">): boolean {
  const profile = loadAllProfiles().find((candidate) => candidate.name === name);
  if (!profile) return false;
  assertProfileControlPlane(profile);
  return profile.match.type.includes(c.type) && (!profile.match.complexity || profile.match.complexity.includes(c.complexity));
}

export function findProfileDir(): string {
  // Distribution layout: <pkg>/dist/engine/profile.js -> <pkg>/workflows/
  const here = fileURLToPath(import.meta.url);
  const pkgRoot = resolve(here, "..", "..", "..");
  return join(pkgRoot, "workflows");
}

export function loadAllProfiles(): Profile[] {
  const dir = findProfileDir();
  const result = [...registeredProfiles.values()];
  if (existsSync(dir)) {
    for (const name of readdirSync(dir)) {
      if (!name.endsWith(".json")) continue;
      if (name.startsWith("_") || name === "artifacts-schema.json" || name === "team.config.example.json" || name === "team.config.schema.json") continue;
      const path = join(dir, name);
      try {
        const raw = JSON.parse(readFileSync(path, "utf8")) as Profile;
        if (raw?.name && raw?.stages && raw?.match) {
          assertProfileControlPlane(raw);
          result.push(raw);
        }
      } catch (error) {
        if (error instanceof Error && error.message.startsWith("invalid workflow profile")) throw error;
        // Non-profile JSON assets are not candidates; malformed profile
        // candidates are rejected rather than silently authorizing a fallback.
        if (name.endsWith(".json") && !name.includes("example") && name !== "teams.json") {
          throw new Error(`invalid workflow profile file '${path}': unreadable or malformed JSON`);
        }
      }
    }
  }
  const unique = new Map(result.map((profile) => [profile.name, profile]));
  return [...unique.values()].sort((a, b) => {
    const ai = SELECTION_ORDER.indexOf(a.name);
    const bi = SELECTION_ORDER.indexOf(b.name);
    return (ai < 0 ? Number.MAX_SAFE_INTEGER : ai) - (bi < 0 ? Number.MAX_SAFE_INTEGER : bi);
  });
}
export function resolveWorkflowProfilePath(name: string, _cwd?: string): string | null {
  const path = join(findProfileDir(), `${name}.json`);
  return existsSync(path) ? path : null;
}

export function loadProfile(name: WorkflowName): Profile | null {
  return loadAllProfiles().find((p) => p.name === name) ?? null;
}

/** Stable canonical SHA-256 fingerprint used to reject profile drift. */
export function profileHash(profile: Profile): string {
  const canonicalize = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(canonicalize);
    if (value && typeof value === "object") return Object.fromEntries(Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, canonicalize(v)]));
    return value;
  };
  return createHash("sha256").update(JSON.stringify(canonicalize(profile))).digest("hex");
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
  if (![
    "FEATURE",
    "REFACTOR",
    "OPS",
    "BUG_FIX",
    "SPEC",
    "REGRESS",
    "INVESTIGATION",
    "LECTURE_RESEARCH",
    "REVIEW",
    "HOTFIX",
    "PRODUCT_DISCOVERY",
  ].includes(type as string)) {
    throw new Error(`invalid workflow classification type '${String(type)}'`);
  }
  if (!["QUICK", "MEDIUM", "COMPLEX", "CRITICAL"].includes(complexity as string)) {
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
    case "LECTURE_RESEARCH":
      return "lecture-research";
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

/**
 * Pick the first profile (in selection order) whose match passes for the
 * classification. Returns null if no profile matches.
 *
 * SPEC, PRODUCT_DISCOVERY, REGRESS and LECTURE_RESEARCH are dedicated
 * intents: a model-provided workflow such as `standard` must not silently
 * hijack either intent. The explicit `workflow_override: true` state marker
 * is the intentional escape hatch enforced by the P5 gate; profile selection
 * itself remains safe by falling back to the dedicated profile.
 */
export function selectProfile(profiles: Profile[], c: Classification): Profile | null {
  for (const profile of profiles) assertProfileControlPlane(profile);
  const dedicated =
    c.type === "SPEC" ? "spec-preparation"
    : c.type === "PRODUCT_DISCOVERY" ? "product-discovery"
    : c.type === "REGRESS" ? "feature-regression"
    : c.type === "LECTURE_RESEARCH" ? "lecture-research"
    : null;
  const explicit = profiles.find((p) => p.name === c.workflow);
  if (explicit && (!dedicated || explicit.name === dedicated)) return explicit;
  for (const name of SELECTION_ORDER) {
    const p = profiles.find((x) => x.name === name);
    if (!p) continue;
    if (!p.match.type.includes(c.type)) continue;
    if (p.match.complexity && !p.match.complexity.includes(c.complexity)) continue;
    return p;
  }
  return null;
}
