import { createHash } from "node:crypto";
/**
 * Profile loader and classification resolver.
 *
 * Same model as claude-plugin: same JSON profile format, same selection order,
 * same Type x Complexity -> Workflow table.
 */

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath, URL } from "node:url";
import { validateProfileExpressions } from "./predicate.js";
import { validateStageFanInResolutions } from "./fan-in.js";
import {
  cloneAndFreeze,
  createRegistryRegistrationLiveGuard,
  descriptorFingerprint,
  recordRegistryUndo,
  registryRegistrationPrincipal,
  requireRegistryRegistration,
  type RegistryRegistrationPrincipal,
  type RegistryRegistrationToken,
} from "../registry/owner.js";
import type {
  CheckpointPolicy,
  CheckpointRule,
  Classification,
  Complexity,
  CompletionIntent,
  Profile,
  RosterPolicy,
  StageType,
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
const MAX_REGISTERED_WORKFLOW_PROFILES = 64;
const MAX_REGISTERED_WORKFLOW_PROFILE_LEASES = MAX_REGISTERED_WORKFLOW_PROFILES * 4;
const MAX_PROFILE_BATCH = 64;
const MAX_PROFILE_STAGES = 64;
const MAX_PROFILE_ARRAY_LENGTH = 64;
const MAX_PROFILE_OBJECT_KEYS = 64;
const MAX_PROFILE_NODES = 10_000;
const MAX_PROFILE_DEPTH = 32;
const MAX_PROFILE_SCALAR_BYTES = 1024 * 1024;
const MAX_PROFILE_STRING_BYTES = 4096;
const MAX_PROFILE_ID_BYTES = 128;
const PROFILE_ID_KEYS = new Set([
  "name", "id", "role", "roles", "teams", "consumes", "produces", "checkpoint", "allowed_roles", "required_roles", "required_facets",
  "allowed_decisions", "scope_flags", "type", "complexity", "confidence", "kind", "phase", "selection_mode", "rules", "multiplicity",
]);

type ProfileSnapshotState = { readonly seen: WeakSet<object>; nodes: number; scalarBytes: number };
type ProfileSnapshotResult = { ok: true; value: unknown } | { ok: false; error: string };
function profileSnapshotValue(value: unknown, path: string, depth: number, idLike: boolean, state: ProfileSnapshotState): ProfileSnapshotResult {
  if (depth > MAX_PROFILE_DEPTH) return { ok: false, error: `${path} exceeds depth ${MAX_PROFILE_DEPTH}` };
  if (value === null || typeof value !== "object") {
    if (typeof value === "string") {
      const bytes = Buffer.byteLength(value, "utf8");
      const limit = idLike ? MAX_PROFILE_ID_BYTES : MAX_PROFILE_STRING_BYTES;
      if (bytes > limit) return { ok: false, error: `${path} exceeds ${limit} UTF-8 bytes` };
      state.scalarBytes += bytes;
      if (state.scalarBytes > MAX_PROFILE_SCALAR_BYTES) return { ok: false, error: `profile scalar data exceeds ${MAX_PROFILE_SCALAR_BYTES} UTF-8 bytes` };
    } else if (typeof value === "function" || typeof value === "symbol" || typeof value === "bigint") {
      return { ok: false, error: `${path} contains an unsupported value` };
    }
    return { ok: true, value };
  }
  state.nodes += 1;
  if (state.nodes > MAX_PROFILE_NODES) return { ok: false, error: `profile structure exceeds ${MAX_PROFILE_NODES} nodes` };
  if (state.seen.has(value)) return { ok: false, error: `profile structure contains a cycle or repeated reference at ${path}` };
  state.seen.add(value);
  let prototype: object | null;
  let descriptors: Record<string, PropertyDescriptor>;
  try {
    prototype = Object.getPrototypeOf(value) as object | null;
    descriptors = Object.getOwnPropertyDescriptors(value);
  } catch {
    return { ok: false, error: `${path} cannot be inspected safely` };
  }
  const array = Array.isArray(value);
  if (array) {
    if (prototype !== Array.prototype && prototype !== null) return { ok: false, error: `${path} must contain only plain arrays` };
    const lengthDescriptor = descriptors.length;
    if (!lengthDescriptor || !Object.hasOwn(lengthDescriptor, "value") || typeof lengthDescriptor.value !== "number" || !Number.isSafeInteger(lengthDescriptor.value) || lengthDescriptor.value > MAX_PROFILE_ARRAY_LENGTH) return { ok: false, error: `${path} contains more than ${MAX_PROFILE_ARRAY_LENGTH} entries` };
    const length = lengthDescriptor.value;
    const descriptorKeys = Reflect.ownKeys(descriptors);
    const keys = Object.keys(descriptors).filter((key) => key !== "length");
    if (descriptorKeys.some((key) => typeof key === "symbol") || keys.some((key) => !/^(0|[1-9]\d*)$/u.test(key) || Number(key) >= length) || keys.length !== length || descriptorKeys.length !== length + 1) return { ok: false, error: `${path} must be dense indexed data properties` };
    const output: unknown[] = [];
    for (let index = 0; index < length; index += 1) {
      const descriptor = descriptors[String(index)];
      if (!descriptor || !Object.hasOwn(descriptor, "value")) return { ok: false, error: `${path}[${index}] must be a data property` };
      const child = profileSnapshotValue(descriptor.value, `${path}[${index}]`, depth + 1, idLike, state);
      if (!child.ok) return child;
      Object.defineProperty(output, String(index), { value: child.value, enumerable: true, configurable: false, writable: false });
    }
    return { ok: true, value: Object.freeze(output) };
  }
  if (prototype !== Object.prototype && prototype !== null) return { ok: false, error: `${path} must contain only plain objects and arrays` };
  const descriptorKeys = Reflect.ownKeys(descriptors);
  const keys = Object.keys(descriptors);
  if (keys.length > MAX_PROFILE_OBJECT_KEYS) return { ok: false, error: `${path} contains more than ${MAX_PROFILE_OBJECT_KEYS} keys` };
  if (descriptorKeys.some((key) => typeof key === "symbol") || descriptorKeys.length !== keys.length) return { ok: false, error: `${path} has unknown non-enumerable properties` };
  const output = Object.create(null) as Record<string, unknown>;
  for (const key of keys) {
    const descriptor = descriptors[key]!;
    if (!Object.hasOwn(descriptor, "value")) return { ok: false, error: `${path}.${key} must not be an accessor` };
    const keyBytes = Buffer.byteLength(key, "utf8");
    const keyIsIdLike = idLike || PROFILE_ID_KEYS.has(key);
    const keyLimit = keyIsIdLike ? MAX_PROFILE_ID_BYTES : MAX_PROFILE_STRING_BYTES;
    if (keyBytes > keyLimit) return { ok: false, error: `${path}.${key} exceeds ${keyLimit} UTF-8 bytes` };
    state.scalarBytes += keyBytes;
    if (state.scalarBytes > MAX_PROFILE_SCALAR_BYTES) return { ok: false, error: `profile scalar data exceeds ${MAX_PROFILE_SCALAR_BYTES} UTF-8 bytes` };
    const child = profileSnapshotValue(descriptor.value, `${path}.${key}`, depth + 1, PROFILE_ID_KEYS.has(key), state);
    if (!child.ok) return child;
    Object.defineProperty(output, key, { value: child.value, enumerable: true, configurable: false, writable: false });
  }
  return { ok: true, value: Object.freeze(output) };
}
function profileStructureSnapshot(value: unknown, path: string): ProfileSnapshotResult {
  if (!value || typeof value !== "object" || Array.isArray(value)) return { ok: false, error: `${path} must be a plain object` };
  return profileSnapshotValue(value, path, 0, false, { seen: new WeakSet<object>(), nodes: 0, scalarBytes: 0 });
}
function assertProfileStructureBudget(value: unknown, path: string): void {
  const snapshot = profileStructureSnapshot(value, path);
  if (!snapshot.ok) throw new Error(`invalid workflow profile registration at ${path}: ${snapshot.error}`);
}

/**
 * Shipped profile ids are private/reserved.  The file-name check in
 * isReservedShippedProfileName also reserves newly shipped profile assets
 * without requiring a consumer-facing registry migration.
 */
const SHIPPED_PROFILE_IDS: Record<string, true> = Object.fromEntries(
  [...SELECTION_ORDER, "spec-import", "constitution", "cto"].map((name) => [name, true] as const),
);

type RegisteredProfileLease = {
  readonly principal: RegistryRegistrationPrincipal;
  readonly token: RegistryRegistrationToken;
  readonly liveGuard: () => unknown;
};
type RegisteredProfileCell = {
  readonly descriptor: string;
  readonly profile: Profile;
  readonly leases: Map<RegistryRegistrationPrincipal, Set<RegisteredProfileLease>>;
};

const registeredProfiles = new Map<string, RegisteredProfileCell>();

function profileLeaseCount(cell: RegisteredProfileCell): number {
  let count = 0;
  for (const leases of cell.leases.values()) count += leases.size;
  return count;
}
function profileHasLease(cell: RegisteredProfileCell, token: RegistryRegistrationToken): boolean {
  for (const leases of cell.leases.values()) if ([...leases].some((lease) => lease.token === token)) return true;
  return false;
}
function removeProfileLease(cell: RegisteredProfileCell, lease: RegisteredProfileLease): void {
  const leases = cell.leases.get(lease.principal);
  if (!leases) return;
  leases.delete(lease);
  if (leases.size === 0) cell.leases.delete(lease.principal);
}
function sweepRegisteredProfileLeases(): void {
  for (const [name, cell] of registeredProfiles) {
    for (const [principal, leases] of cell.leases) {
      for (const lease of [...leases]) {
        try {
          lease.liveGuard();
        } catch {
          leases.delete(lease);
        }
      }
      if (leases.size === 0) cell.leases.delete(principal);
    }
    if (profileLeaseCount(cell) === 0) registeredProfiles.delete(name);
  }
}

function registeredProfileLeaseCount(): number {
  let count = 0;
  for (const cell of registeredProfiles.values()) count += profileLeaseCount(cell);
  return count;
}

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
  if (!Array.isArray(value)) {
    issue(issues, path, "must be an array of non-empty strings");
    return false;
  }
  if (value.length > MAX_PROFILE_ARRAY_LENGTH) {
    issue(issues, path, `must contain at most ${MAX_PROFILE_ARRAY_LENGTH} entries`);
    return false;
  }
  for (const entry of value) {
    if (!nonEmptyString(entry) || Buffer.byteLength(entry, "utf8") > MAX_PROFILE_STRING_BYTES) {
      issue(issues, path, "must contain bounded non-empty strings");
      return false;
    }
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

function validateSchemaReference(value: unknown, path: string, issues: string[]): void {
  if (typeof value !== "string" || value.length === 0 || value.length > 2048 || /[\u0000-\u001f\u007f\s]/u.test(value)) {
    issue(issues, path, "must be a non-empty URI or relative path");
    return;
  }
  let isHttpUri = false;
  try {
    const parsed = new URL(value);
    isHttpUri = (parsed.protocol === "http:" || parsed.protocol === "https:")
      && parsed.hostname.length > 0
      && parsed.username.length === 0
      && parsed.password.length === 0;
  } catch {
    isHttpUri = false;
  }
  const [pathPart, fragment] = value.split("#", 2);
  const allowedPathCharacters = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_.-";
  const pathSegments = (pathPart ?? "").split("/");
  const isRelativePath = !value.startsWith("/")
    && !/^[A-Za-z]:/u.test(value)
    && !value.includes("\\")
    && pathSegments.every((segment, index) => (index === 0 && segment === ".") || (segment.length > 0 && segment !== ".." && [...segment].every((character) => allowedPathCharacters.includes(character))))
    && (fragment === undefined || (fragment.length > 0 && [...fragment].every((character) => allowedPathCharacters.includes(character))));
  if (!isHttpUri && !isRelativePath) {
    issue(issues, path, "must be a non-empty URI or relative path");
  }
}

function validateCompletionIntent(value: unknown, path: string, issues: string[]): void {
  if (!isRecord(value)) {
    issue(issues, path, "must be an object");
    return;
  }
  unknownKeys(value, ["mode", "acceptance", "source", "rationale"], path, issues);
  enumValue(value.mode, ["complete_outcome", "handoff_only"], `${path}.mode`, issues);
  enumValue(value.acceptance, ["quality_gates_and_artifacts", "explicit_human_acceptance"], `${path}.acceptance`, issues);
  enumValue(value.source, ["user", "workflow_policy", "migration"], `${path}.source`, issues);
  requiredString(value, "rationale", path, issues);
}
const CHECKPOINT_KINDS = [
  "constitution_approval",
  "specification_phase_approval",
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
  "constitution_approval",
  "specification_phase_approval",
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
  const structural = profileStructureSnapshot(profile, "profile");
  if (!structural.ok) return { ok: false, issues: [structural.error] };
  profile = structural.value;
  if (!isRecord(profile)) return { ok: false, issues: ["profile must be an object"] };
  const issues: string[] = [];
  if (hasOwn(profile, "completion_intent")) validateCompletionIntent(profile.completion_intent, "$.completion_intent", issues);
  if (hasOwn(profile, "checkpoint_policy")) validateCheckpointPolicy(profile.checkpoint_policy, "$.checkpoint_policy", issues);
  if (hasOwn(profile, "roster_policy")) validateRosterPolicy(profile.roster_policy, "$.roster_policy", issues);
  if (hasOwn(profile, "stages")) {
    if (!Array.isArray(profile.stages)) {
      issue(issues, "$.stages", "must be an array");
    } else if (profile.stages.length > MAX_PROFILE_STAGES) {
      issue(issues, "$.stages", `must contain at most ${MAX_PROFILE_STAGES} stages`);
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
  if (!validation.ok) throw new Error(`invalid workflow profile '${profile.name}' typed control-plane: ${validation.issues.join("; ")}`);
}

const PROFILE_KEYS = ["$schema", "name", "title", "description", "match", "stages", "completion_intent", "checkpoint_policy", "autoSelect"] as const;
const STAGE_KEYS = [
  "id", "title", "type", "prompt", "description", "roles", "role", "teams", "profile", "integration", "parallel",
  "consumes", "produces", "checkpoint", "checkpoint_policy", "completion_intent", "roster_policy", "autonomous", "command",
  "document", "fan_in", "gate", "conditional", "skip_if", "loop",
] as const;
const TASK_TYPES: readonly TaskType[] = ["FEATURE", "REFACTOR", "OPS", "BUG_FIX", "SPEC", "REGRESS", "INVESTIGATION", "LECTURE_RESEARCH", "REVIEW", "HOTFIX", "PRODUCT_DISCOVERY"];
const COMPLEXITIES: readonly Complexity[] = ["QUICK", "MEDIUM", "COMPLEX", "CRITICAL"];
const STAGE_TYPES: readonly StageType[] = ["orchestrator", "single", "consilium", "document", "bash", "none", "team"];

/** Validate the full public profile shape before touching the registry map. */
function assertWorkflowProfileSchema(value: unknown, index: number): asserts value is Profile {
  const path = `profiles[${index}]`;
  if (!isRecord(value)) throw new Error(`invalid workflow profile registration at ${path}: profile must be an object`);
  const issues: string[] = [];
  unknownKeys(value, PROFILE_KEYS, path, issues);
  if (hasOwn(value, "$schema")) validateSchemaReference(value["$schema"], `${path}.$schema`, issues);
  requiredString(value, "name", path, issues);
  if (typeof value.name === "string" && !/^[a-z0-9-]+$/.test(value.name)) issue(issues, `${path}.name`, "must contain only lowercase letters, digits, and hyphens");
  requiredString(value, "title", path, issues);
  requiredString(value, "description", path, issues);
  if (!isRecord(value.match)) {
    issue(issues, `${path}.match`, "must be an object");
  } else {
    unknownKeys(value.match, ["type", "complexity"], `${path}.match`, issues);
    const matchTypes = value.match.type;
    const typeValid = stringArray(matchTypes, `${path}.match.type`, issues, false);
    if (typeValid) for (const item of matchTypes) enumValue(item, TASK_TYPES, `${path}.match.type`, issues);
    if (hasOwn(value.match, "complexity")) {
      const matchComplexity = value.match.complexity;
      const complexityValid = stringArray(matchComplexity, `${path}.match.complexity`, issues);
      if (complexityValid) for (const item of matchComplexity) enumValue(item, COMPLEXITIES, `${path}.match.complexity`, issues);
    }
  }
  if (!Array.isArray(value.stages) || value.stages.length === 0) {
    issue(issues, `${path}.stages`, "must be a non-empty array");
  } else if (value.stages.length > MAX_PROFILE_STAGES) {
    issue(issues, `${path}.stages`, `must contain at most ${MAX_PROFILE_STAGES} stages`);
  } else {
    const stageIds = new Set<string>();
    value.stages.forEach((stage, stageIndex) => {
      const stagePath = `${path}.stages[${stageIndex}]`;
      if (!isRecord(stage)) {
        issue(issues, stagePath, "must be an object");
        return;
      }
      unknownKeys(stage, STAGE_KEYS, stagePath, issues);
      requiredString(stage, "id", stagePath, issues);
      if (typeof stage.id === "string" && !/^[a-z0-9_]+$/.test(stage.id)) issue(issues, `${stagePath}.id`, "must contain only lowercase letters, digits, and underscores");
      if (typeof stage.id === "string") {
        if (stageIds.has(stage.id)) issue(issues, `${stagePath}.id`, "duplicate stage id");
        stageIds.add(stage.id);
      }
      requiredString(stage, "title", stagePath, issues);
      enumValue(stage.type, STAGE_TYPES, `${stagePath}.type`, issues);
      for (const key of ["prompt", "description", "role", "profile", "checkpoint", "autonomous", "command", "gate", "skip_if"] as const) {
        if (hasOwn(stage, key) && stage[key] !== undefined && !nonEmptyString(stage[key])) issue(issues, `${stagePath}.${key}`, "must be a non-empty string when present");
      }
      for (const key of ["roles", "teams", "consumes"] as const) {
        if (hasOwn(stage, key)) stringArray(stage[key], `${stagePath}.${key}`, issues);
      }
      if (hasOwn(stage, "parallel") && typeof stage.parallel !== "boolean") issue(issues, `${stagePath}.parallel`, "must be boolean");
      if (hasOwn(stage, "produces") && typeof stage.produces !== "string" && !(Array.isArray(stage.produces) && stage.produces.every(nonEmptyString))) issue(issues, `${stagePath}.produces`, "must be a string or an array of non-empty strings");
    });
  }
  if (issues.length > 0) throw new Error(`invalid workflow profile registration at ${path}: ${issues.join("; ")}`);
}

function validateWorkflowProfile(profile: Profile, index: number): { profile: Profile; descriptor: string } {
  assertWorkflowProfileSchema(profile, index);
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
  const frozen = cloneAndFreeze(profile);
  return { profile: frozen, descriptor: descriptorFingerprint(frozen) };
}

function isReservedShippedProfileName(name: string): boolean {
  if (SHIPPED_PROFILE_IDS[name] === true) return true;
  try {
    return existsSync(join(findProfileDir(), `${name}.json`));
  } catch {
    return false;
  }
}

function migrationCompletionIntent(): CompletionIntent {
  return {
    mode: "complete_outcome",
    acceptance: "quality_gates_and_artifacts",
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

export type WorkflowProfile = Profile;

function snapshotProfileBatch(input: unknown): { ok: true; value: readonly WorkflowProfile[] } | { ok: false; error: string } {
  if (!Array.isArray(input)) return { ok: false, error: "profiles must be an array" };
  let prototype: object | null;
  let descriptors: Record<string, PropertyDescriptor>;
  try {
    prototype = Object.getPrototypeOf(input) as object | null;
    descriptors = Object.getOwnPropertyDescriptors(input);
  } catch {
    return { ok: false, error: "profiles array is invalid" };
  }
  if (prototype !== Array.prototype && prototype !== null) return { ok: false, error: "profiles array prototype is invalid" };
  const lengthDescriptor = descriptors.length;
  if (!lengthDescriptor || !Object.hasOwn(lengthDescriptor, "value") || typeof lengthDescriptor.value !== "number" || !Number.isSafeInteger(lengthDescriptor.value) || lengthDescriptor.value > MAX_PROFILE_BATCH) return { ok: false, error: `batch is bounded at ${MAX_PROFILE_BATCH} profiles` };
  const length = lengthDescriptor.value;
  const descriptorKeys = Reflect.ownKeys(descriptors);
  const keys = Object.keys(descriptors).filter((key) => key !== "length");
  if (descriptorKeys.some((key) => typeof key === "symbol") || keys.some((key) => !/^(0|[1-9]\d*)$/u.test(key) || Number(key) >= length) || keys.length !== length || descriptorKeys.length !== length + 1) return { ok: false, error: "profiles must be dense indexed data properties" };
  const values: WorkflowProfile[] = [];
  for (let index = 0; index < length; index += 1) {
    const descriptor = descriptors[String(index)];
    if (!descriptor || !Object.hasOwn(descriptor, "value")) return { ok: false, error: "profiles must be dense data properties" };
    values.push(descriptor.value as WorkflowProfile);
  }
  return { ok: true, value: Object.freeze(values) };
}

/** Register bundle-owned profiles for the core interpreter. */
export function registerWorkflowProfiles(token: RegistryRegistrationToken, profiles: readonly WorkflowProfile[]): void {
  requireRegistryRegistration(token, "workflow_profiles");
  const snapshot = snapshotProfileBatch(profiles);
  if (!snapshot.ok) throw new Error(`invalid workflow profile registration: ${snapshot.error}`);
  const batch = snapshot.value;
  const principal = registryRegistrationPrincipal(token, "workflow_profiles");
  const liveGuard = createRegistryRegistrationLiveGuard(token, "workflow_profiles");
  sweepRegisteredProfileLeases();

  const prepared: Array<{ profile: Profile; descriptor: string }> = [];
  const planned = new Map<string, { profile: Profile; descriptor: string }>();
  for (let index = 0; index < batch.length; index += 1) {
    const structural = profileStructureSnapshot(batch[index], `profiles[${index}]`);
    if (!structural.ok) throw new Error(`invalid workflow profile registration at profiles[${index}]: ${structural.error}`);
    const candidate = validateWorkflowProfile(structural.value as WorkflowProfile, index);
    const name = candidate.profile.name;
    if (isReservedShippedProfileName(name)) throw new Error(`workflow profile '${name}' is built-in and reserved`);
    const prior = planned.get(name);
    if (prior && prior.descriptor !== candidate.descriptor) throw new Error(`workflow profile '${name}' is registered twice with different descriptors`);
    if (!prior) {
      planned.set(name, candidate);
      prepared.push(candidate);
    }
  }

  const replacements = new Set<string>();
  let newCount = 0;
  let additionalLeases = 0;
  for (const candidate of prepared) {
    const name = candidate.profile.name;
    const existing = registeredProfiles.get(name);
    if (!existing) {
      newCount += 1;
      additionalLeases += 1;
      continue;
    }
    if (existing.descriptor !== candidate.descriptor) {
      if (profileLeaseCount(existing) > 0) throw new Error(`workflow profile '${name}' is already registered by a different principal or descriptor`);
      replacements.add(name);
      additionalLeases += 1;
      continue;
    }
    if (!profileHasLease(existing, token)) additionalLeases += 1;
  }
  if (registeredProfiles.size - replacements.size + newCount > MAX_REGISTERED_WORKFLOW_PROFILES) throw new Error(`workflow profile registration exceeds the ${MAX_REGISTERED_WORKFLOW_PROFILES}-profile limit`);
  if (registeredProfileLeaseCount() + additionalLeases > MAX_REGISTERED_WORKFLOW_PROFILE_LEASES) throw new Error(`workflow profile registration exceeds the ${MAX_REGISTERED_WORKFLOW_PROFILE_LEASES}-activation lease limit`);

  for (const candidate of prepared) {
    const name = candidate.profile.name;
    const prior = registeredProfiles.get(name);
    if (prior && prior.descriptor === candidate.descriptor) {
      if (profileHasLease(prior, token)) continue;
      let lease: RegisteredProfileLease | undefined;
      recordRegistryUndo(token, () => {
        if (lease) removeProfileLease(prior, lease);
        if (profileLeaseCount(prior) === 0 && registeredProfiles.get(name) === prior) registeredProfiles.delete(name);
      });
      requireRegistryRegistration(token, "workflow_profiles");
      const leases = prior.leases.get(principal) ?? new Set<RegisteredProfileLease>();
      prior.leases.set(principal, leases);
      lease = { principal, token, liveGuard };
      leases.add(lease);
      continue;
    }
    const cell: RegisteredProfileCell = {
      descriptor: candidate.descriptor,
      profile: candidate.profile,
      leases: new Map(),
    };
    let lease: RegisteredProfileLease | undefined;
    recordRegistryUndo(token, () => {
      if (lease) removeProfileLease(cell, lease);
      if (registeredProfiles.get(name) === cell) {
        if (prior && profileLeaseCount(prior) === 0) registeredProfiles.set(name, prior);
        else registeredProfiles.delete(name);
      }
    });
    requireRegistryRegistration(token, "workflow_profiles");
    lease = { principal, token, liveGuard };
    cell.leases.set(principal, new Set([lease]));
    registeredProfiles.set(name, cell);
  }
}

export function isRegisteredWorkflow(name: string): boolean {
  sweepRegisteredProfileLeases();
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

function loadShippedProfiles(): Profile[] {
  const dir = findProfileDir();
  const result: Profile[] = [];
  if (existsSync(dir)) {
    for (const name of readdirSync(dir)) {
      if (!name.endsWith(".json")) continue;
      if (name.startsWith("_") || name === "artifacts-schema.json" || name === "team.config.example.json" || name === "team.config.schema.json") continue;
      const path = join(dir, name);
      try {
        const raw = JSON.parse(readFileSync(path, "utf8")) as Profile;
        if (raw?.name && raw?.stages && raw?.match) {
          assertProfileStructureBudget(raw, path);
          assertProfileControlPlane(raw);
          result.push(cloneAndFreeze(raw));
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
  return result;
}

export function loadAllProfiles(): Profile[] {
  sweepRegisteredProfileLeases();
  // Shipped profiles are loaded into a private source set first.  Consumer
  // cells cannot replace them, even if a future caller bypasses registration
  // checks and inserts a colliding key into the map.
  const result: Profile[] = [
    ...loadShippedProfiles(),
    ...[...registeredProfiles.values()].map((cell) => cell.profile),
  ];
  const unique = new Map<string, Profile>();
  for (const profile of result) if (!unique.has(profile.name)) unique.set(profile.name, profile);
  return [...unique.values()]
    .sort((a, b) => {
      const ai = SELECTION_ORDER.indexOf(a.name);
      const bi = SELECTION_ORDER.indexOf(b.name);
      return (ai < 0 ? Number.MAX_SAFE_INTEGER : ai) - (bi < 0 ? Number.MAX_SAFE_INTEGER : bi);
    })
    .map((profile) => cloneAndFreeze(profile));
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
