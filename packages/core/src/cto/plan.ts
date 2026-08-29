/* <!-- omp-cto-slice run=01a03ee4-7dd6-7580-8ad7-16d26dc886ba slice=workflow-v2-core --> */
/**
 * TeamPlan lifecycle: build + validate.
 *
 * The CTO agent (or a consumer's own orchestrator) produces a decomposition;
 * the engine validates it against the hard caps and TeamDef registry before
 * it is persisted and executed. Two-layer contract: the engine never decides
 * the decomposition itself — it guards what the orchestrator proposes.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { loadProfileByIdentity } from "../engine/profile.js";
import { createDiagnostic } from "../workflow-v2/diagnostics.js";
import { preflightAgentInventory, validateProviderCatalog } from "../workflow-v2/descriptor.js";
import { isProviderId, isWorkflowV2Digest, validateProjectIdentity, validateWorkflowRunIdentity } from "../workflow-v2/identity.js";
import { MAX_TEAMS, MAX_DECOMPOSITION_DEPTH, type CtoExecutionContext, type TeamDef, type TeamPlan, type TeamPlanEntry, type WorktreeStrategy } from "./types.js";
import type { AgentRef, ProfileIdentity, ProjectIdentity, WorkflowRunIdentity, WorkflowV2Diagnostic } from "../workflow-v2/types.js";

export interface PlanTeamInput {
  team: string;
  scope: string[];
  slice: string;
  profile: string;
  worktree?: WorktreeStrategy;
  depends_on?: string[];
  profile_identity: ProfileIdentity;
  lead_ref: AgentRef;
  roster_refs: readonly AgentRef[];
  run_identity: WorkflowRunIdentity;
}

export interface PlanBuildInput extends CtoExecutionContext {
  /** CTO run id (slug); matches `.work-state/cto/<id>/. */
  id: string;
  task: string;
  teams: PlanTeamInput[];
  /** Identity allocated by workflow_prepare for this durable run. */
  run_identity: WorkflowRunIdentity;
}


export type BuildResult =
  | { ok: true; plan: TeamPlan }
  | { ok: false; reason: string; diagnostics?: readonly WorkflowV2Diagnostic[] };

type UnknownRecord = Record<string, unknown>;

const AGENT_REF_KEYS: readonly string[] = ["registered_name", "provider_id", "source_fingerprint"];
const PROFILE_IDENTITY_KEYS: readonly string[] = ["id", "fingerprint"];
const TEAM_DEF_KEYS: readonly string[] = ["id", "name", "scope", "profile", "profile_identity", "lead", "roster"];

function isPlainRecord(value: unknown): value is UnknownRecord {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasExactKeys(value: UnknownRecord, expected: readonly string[]): boolean {
  const allowed = new Set(expected);
  const keys = Object.keys(value);
  return keys.length === expected.length && keys.every((key) => allowed.has(key));
}

function hasOwn(value: object, key: PropertyKey): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function safeIdentifier(value: unknown): value is string {
  return typeof value === "string"
    && value.length > 0
    && value.length <= 256
    && value === value.trim()
    && /^[A-Za-z0-9@._:/#-]+$/u.test(value);
}

function nonEmptyText(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isStringArray(value: unknown, allowEmpty = true): value is string[] {
  if (!Array.isArray(value) || (!allowEmpty && value.length === 0)) return false;
  for (let index = 0; index < value.length; index += 1) {
    if (!hasOwn(value, index) || typeof value[index] !== "string") return false;
  }
  return true;
}

function isQualifiedAgent(value: unknown, providerId?: string): value is AgentRef {
  if (!isPlainRecord(value) || !hasExactKeys(value, AGENT_REF_KEYS)) return false;
  return safeIdentifier(value.registered_name)
    && isProviderId(value.provider_id)
    && isWorkflowV2Digest(value.source_fingerprint)
    && (providerId === undefined || value.provider_id === providerId);
}

function isQualifiedAgentArray(value: unknown, providerId?: string): value is readonly AgentRef[] {
  if (!Array.isArray(value)) return false;
  for (let index = 0; index < value.length; index += 1) {
    if (!hasOwn(value, index) || !isQualifiedAgent(value[index], providerId)) return false;
  }
  return true;
}

function isProfileIdentity(value: unknown): value is ProfileIdentity {
  return isPlainRecord(value)
    && hasExactKeys(value, PROFILE_IDENTITY_KEYS)
    && safeIdentifier(value.id)
    && isWorkflowV2Digest(value.fingerprint);
}

function isTeamDef(value: unknown): value is TeamDef {
  return isPlainRecord(value)
    && hasExactKeys(value, TEAM_DEF_KEYS)
    && safeIdentifier(value.id)
    && nonEmptyText(value.name)
    && isStringArray(value.scope)
    && safeIdentifier(value.profile)
    && isProfileIdentity(value.profile_identity)
    && safeIdentifier(value.lead)
    && isStringArray(value.roster, false);
}

/**
 * A runtime brand check keeps Map and plain-record registries distinct while
 * retaining a precise type for each lookup branch.
 */
function isMapRegistry(value: unknown): value is ReadonlyMap<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  try {
    Map.prototype.has.call(value, "");
    return true;
  } catch {
    return false;
  }
}

function validDefinitionRegistry(value: unknown): boolean {
  if (isMapRegistry(value)) {
    try {
      for (const [id, candidate] of value.entries()) {
        if (typeof id !== "string" || !isTeamDef(candidate) || candidate.id !== id) return false;
      }
      return true;
    } catch {
      return false;
    }
  }
  if (!isPlainRecord(value)) return false;
  for (const [id, candidate] of Object.entries(value)) {
    if (!isTeamDef(candidate) || candidate.id !== id) return false;
  }
  return true;
}

function lookupTeamDef(
  defs: Record<string, TeamDef> | Map<string, TeamDef>,
  id: string,
): TeamDef | undefined {
  if (isMapRegistry(defs)) {
    const candidate = defs.get(id);
    return isTeamDef(candidate) && candidate.id === id ? candidate : undefined;
  }
  if (!isPlainRecord(defs)) return undefined;
  const candidate = defs[id];
  return isTeamDef(candidate) && candidate.id === id ? candidate : undefined;
}

function normalizeProfileIdentity(identity: ProfileIdentity): ProfileIdentity {
  return Object.freeze({ id: identity.id, fingerprint: identity.fingerprint });
}

function normalizeAgentRef(agent: AgentRef): AgentRef {
  return Object.freeze({
    registered_name: agent.registered_name,
    provider_id: agent.provider_id,
    source_fingerprint: agent.source_fingerprint,
  });
}

function agentBindingKey(agent: AgentRef): string {
  return `${agent.registered_name}\u0000${agent.provider_id}\u0000${agent.source_fingerprint}`;
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

/**
 * TeamDef registry loader: reads the consumer-owned `.omp/teams.json`
 * (array of {@link TeamDef}). Missing/malformed file -> empty array (never
 * throws). Consumers may also pass TeamDef[] directly to the engine.
 */
export function loadTeamDefs(cwd: string): TeamDef[] {
  try {
    const raw: unknown = JSON.parse(readFileSync(join(cwd, ".omp", "teams.json"), "utf8"));
    if (!Array.isArray(raw)) return [];
    const defs: TeamDef[] = [];
    for (let index = 0; index < raw.length; index += 1) {
      const entry: unknown = raw[index];
      if (!hasOwn(raw, index) || !isTeamDef(entry)) return [];
      defs.push(entry);
    }
    return defs;
  } catch {
    return [];
  }
}

/**
 * Build a TeamPlan and validate it. Returns a reason on any violation:
 * caps (MAX_TEAMS), unknown team ids, depends_on cycles or dangling refs.
 */
export function buildTeamPlan(input: PlanBuildInput, defs: Record<string, TeamDef> | Map<string, TeamDef>): BuildResult {
  const fail = (reason: string, code: WorkflowV2Diagnostic["code"] = "MIGRATION_REQUIRED"): BuildResult => ({
    ok: false,
    reason,
    diagnostics: [createDiagnostic({
      code,
      operation: "management.create",
      severity: "error",
      evidence: { field: "team_plan" },
      remediation: code === "MIGRATION_REQUIRED"
        ? "Provide the complete v2 identity, selected catalog profile, policy, and qualified agent inventory."
        : "Correct the team plan input before persisting it.",
    })],
  });
  if (
    input === null
    || typeof input !== "object"
    || Array.isArray(input)
    || typeof input.id !== "string"
    || input.id.length === 0
    || typeof input.task !== "string"
    || input.task.trim().length === 0
  ) {
    return fail("plan needs { id, task }", "CONFIG_MALFORMED");
  }
  if (input.id.length > 80 || !/^[a-z0-9][a-z0-9-_]*$/.test(input.id)) {
    return fail(`plan id must be a slug, got: ${input.id}`, "CONFIG_MALFORMED");
  }
  if (!Array.isArray(input.teams)) return fail("plan.teams must be an array", "CONFIG_MALFORMED");
  if (input.teams.length === 0) return fail("plan.teams is empty — nothing to orchestrate", "CONFIG_MALFORMED");
  if (input.teams.length > MAX_TEAMS) {
    return fail(`plan has ${input.teams.length} teams, cap is ${MAX_TEAMS}`, "CONFIG_MALFORMED");
  }
  if (!validDefinitionRegistry(defs)) return fail("team definitions are malformed", "CONFIG_MALFORMED");

  const provider = input.effective_policy?.provider;
  if (
    !isPlainRecord(provider)
    || !isProviderId(provider.id)
    || !isWorkflowV2Digest(provider.descriptor_fingerprint)
    || !isWorkflowV2Digest(provider.catalog_content_digest)
  ) {
    return fail("effective policy provider binding is malformed", "CONFIG_MALFORMED");
  }

  const checkedCatalog = validateProviderCatalog(input.catalog);
  if (!checkedCatalog.ok) {
    return fail(
      `provider catalog is malformed: ${checkedCatalog.diagnostics[0]?.code ?? "CONFIG_MALFORMED"}`,
      checkedCatalog.diagnostics[0]?.code ?? "CONFIG_MALFORMED",
    );
  }
  const catalog = checkedCatalog.value;

  const checkedProjectIdentity = validateProjectIdentity(input.project_identity);
  if (!checkedProjectIdentity.ok) {
    return fail(
      `invalid project identity: ${checkedProjectIdentity.diagnostics[0]?.code ?? "IDENTITY_MISMATCH"}`,
      checkedProjectIdentity.diagnostics[0]?.code ?? "IDENTITY_MISMATCH",
    );
  }
  const projectIdentity = checkedProjectIdentity.value;

  const checkedRunIdentity = validateWorkflowRunIdentity(input.run_identity);
  if (!checkedRunIdentity.ok) {
    return fail(
      `invalid workflow run identity: ${checkedRunIdentity.diagnostics[0]?.code ?? "IDENTITY_MISMATCH"}`,
      checkedRunIdentity.diagnostics[0]?.code ?? "IDENTITY_MISMATCH",
    );
  }
  const runIdentity = checkedRunIdentity.value;
  if (projectIdentityKey(runIdentity) !== projectIdentityKey(projectIdentity)) {
    return fail("workflow run identity does not inherit the admitted project identity", "IDENTITY_MISMATCH");
  }
  if (runIdentity.run_id !== input.id) {
    return fail("plan id must match the workflow run identity", "IDENTITY_MISMATCH");
  }
  if (
    runIdentity.provider_id !== provider.id
    || runIdentity.descriptor_fingerprint !== provider.descriptor_fingerprint
    || runIdentity.catalog_content_digest !== provider.catalog_content_digest
  ) {
    return fail("workflow run identity provider binding does not match effective policy", "IDENTITY_MISMATCH");
  }
  if (runIdentity.catalog_content_digest !== catalog.content_digest) {
    return fail("workflow run identity catalog does not match the selected catalog", "IDENTITY_MISMATCH");
  }
  const rootProfile = loadProfileByIdentity(catalog, runIdentity.profile_identity);
  if (!rootProfile.ok) {
    return fail(
      `selected workflow profile is unavailable: ${rootProfile.diagnostics[0]?.code ?? "PROFILE_UNAVAILABLE"}`,
      rootProfile.diagnostics[0]?.code ?? "PROFILE_UNAVAILABLE",
    );
  }

  if (!Array.isArray(input.agent_inventory)) return fail("agent inventory is malformed", "CONFIG_MALFORMED");
  const checkedInventory = preflightAgentInventory(input.agent_inventory);
  if (!checkedInventory.ok) {
    return fail(
      `agent inventory is malformed: ${checkedInventory.diagnostics[0]?.code ?? "CONFIG_MALFORMED"}`,
      checkedInventory.diagnostics[0]?.code ?? "CONFIG_MALFORMED",
    );
  }
  const inventory = checkedInventory.value;
  if (inventory.some((agent) => agent.provider_id !== runIdentity.provider_id)) {
    return fail("agent inventory contains a foreign provider binding", "IDENTITY_MISMATCH");
  }
  const inventoryHas = (agent: AgentRef): boolean => inventory.some((candidate) =>
    candidate.registered_name === agent.registered_name
      && candidate.provider_id === agent.provider_id
      && candidate.source_fingerprint === agent.source_fingerprint
  );

  const entries: TeamPlanEntry[] = [];
  const seen = new Set<string>();
  for (const candidate of input.teams) {
    if (!isPlainRecord(candidate)) return fail("team plan entry is malformed", "CONFIG_MALFORMED");

    const teamValue = candidate.team;
    if (!safeIdentifier(teamValue)) return fail("team id is required", "CONFIG_MALFORMED");
    const team = teamValue;
    const def = lookupTeamDef(defs, team);
    if (!def) return fail(`unknown team id or malformed definition: ${team}`, "CONFIG_MALFORMED");
    if (seen.has(team)) return fail(`duplicate team id in plan: ${team}`, "CONFIG_MALFORMED");
    seen.add(team);

    const checkedTeamRunIdentity = validateWorkflowRunIdentity(candidate.run_identity);
    if (!checkedTeamRunIdentity.ok) {
      return fail(
        `${team} has invalid workflow run identity: ${checkedTeamRunIdentity.diagnostics[0]?.code ?? "IDENTITY_MISMATCH"}`,
        checkedTeamRunIdentity.diagnostics[0]?.code ?? "IDENTITY_MISMATCH",
      );
    }
    const teamRunIdentity = checkedTeamRunIdentity.value;
    if (runIdentityKey(runIdentity) !== runIdentityKey(teamRunIdentity)) {
      return fail(`${team} workflow run identity does not match the CTO run`, "IDENTITY_MISMATCH");
    }

    const profileValue = candidate.profile;
    if (!safeIdentifier(profileValue)) return fail(`${team} profile is required`, "CONFIG_MALFORMED");
    const profile = profileValue;

    let worktree: WorktreeStrategy = "same_branch";
    const worktreeValue = candidate.worktree;
    if (worktreeValue !== undefined) {
      if (worktreeValue !== "same_branch" && worktreeValue !== "separate_worktree") {
        return fail(`${team} worktree strategy is malformed`, "CONFIG_MALFORMED");
      }
      worktree = worktreeValue;
    }

    let dependsOn: string[] = [];
    const dependsValue = candidate.depends_on;
    if (dependsValue !== undefined) {
      if (!isStringArray(dependsValue)) return fail(`${team} depends_on is malformed`, "CONFIG_MALFORMED");
      dependsOn = [...dependsValue];
    }

    const profileIdentityValue = candidate.profile_identity;
    if (!isProfileIdentity(profileIdentityValue)) return fail(`${team} must carry a valid catalog profile identity`);
    const selectedProfileIdentity = normalizeProfileIdentity(profileIdentityValue);
    if (profile !== selectedProfileIdentity.id) {
      return fail(`${team} profile does not match its catalog identity`, "IDENTITY_MISMATCH");
    }
    if (
      def.profile !== selectedProfileIdentity.id
      || def.profile_identity.id !== selectedProfileIdentity.id
      || def.profile_identity.fingerprint !== selectedProfileIdentity.fingerprint
    ) {
      return fail(`${team} profile identity does not match its registered TeamDef`, "IDENTITY_MISMATCH");
    }
    const selectedProfile = loadProfileByIdentity(catalog, selectedProfileIdentity);
    if (!selectedProfile.ok) {
      return fail(
        `${team} profile is unavailable in the selected catalog: ${selectedProfile.diagnostics[0]?.code ?? "PROFILE_UNAVAILABLE"}`,
        selectedProfile.diagnostics[0]?.code ?? "PROFILE_UNAVAILABLE",
      );
    }

    const leadValue = candidate.lead_ref;
    if (!isQualifiedAgent(leadValue, runIdentity.provider_id)) {
      return fail(`${team} lead must be present as a provider-qualified inventory reference`);
    }
    const checkedLead = preflightAgentInventory([leadValue]);
    if (!checkedLead.ok) {
      return fail(
        `${team} lead binding is malformed: ${checkedLead.diagnostics[0]?.code ?? "CONFIG_MALFORMED"}`,
        checkedLead.diagnostics[0]?.code ?? "CONFIG_MALFORMED",
      );
    }
    let leadRef: AgentRef | undefined;
    for (const normalized of checkedLead.value) {
      leadRef = normalized;
      break;
    }
    if (!leadRef || !inventoryHas(leadRef)) {
      return fail(`${team} lead must be present as a provider-qualified inventory reference`);
    }

    const rosterValue = candidate.roster_refs;
    if (!isQualifiedAgentArray(rosterValue, runIdentity.provider_id) || rosterValue.length === 0) {
      return fail(`${team} roster must contain provider-qualified inventory references`);
    }
    const checkedRoster = preflightAgentInventory(rosterValue);
    if (!checkedRoster.ok) {
      return fail(
        `${team} roster binding is malformed: ${checkedRoster.diagnostics[0]?.code ?? "CONFIG_MALFORMED"}`,
        checkedRoster.diagnostics[0]?.code ?? "CONFIG_MALFORMED",
      );
    }
    if (checkedRoster.value.length !== rosterValue.length) {
      return fail(`${team} roster contains duplicate agent bindings`, "CONFIG_MALFORMED");
    }
    const rosterRefs = Object.freeze([...checkedRoster.value]);
    if (!rosterRefs.every(inventoryHas)) {
      return fail(`${team} roster must contain provider-qualified inventory references`);
    }

    const scopeValue = candidate.scope;
    if (!isStringArray(scopeValue) || scopeValue.length === 0 || !scopeValue.every((scope) => def.scope.includes(scope))) {
      return fail(`${team} scope must be a non-empty subset of its registered scope`, "CONFIG_MALFORMED");
    }
    const sliceValue = candidate.slice;
    if (!nonEmptyText(sliceValue)) return fail(`${team} slice is required`, "CONFIG_MALFORMED");

    entries.push({
      team,
      scope: [...scopeValue],
      slice: sliceValue,
      profile,
      worktree,
      depends_on: dependsOn,
      profile_identity: selectedProfileIdentity,
      lead_ref: leadRef,
      roster_refs: rosterRefs,
      run_identity: teamRunIdentity,
    });
  }

  // depends_on: dangling refs + cycles (DFS on the team graph).
  for (const entry of entries) {
    for (const dep of entry.depends_on) {
      if (!seen.has(dep)) return fail(`${entry.team} depends on unknown team: ${dep}`, "CONFIG_MALFORMED");
    }
  }
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (teamId: string): boolean => {
    if (visiting.has(teamId)) return false;
    if (visited.has(teamId)) return true;
    visiting.add(teamId);
    const entry = entries.find((candidate) => candidate.team === teamId);
    const deps = entry ? entry.depends_on : [];
    for (const dep of deps) {
      if (!visit(dep)) return false;
    }
    visiting.delete(teamId);
    visited.add(teamId);
    return true;
  };
  for (const entry of entries) {
    if (!visit(entry.team)) return fail(`depends_on cycle detected involving: ${entry.team}`, "CONFIG_MALFORMED");
  }

  return {
    ok: true,
    plan: {
      id: input.id,
      task: input.task,
      teams: entries,
      created_at: new Date().toISOString(),
      run_identity: runIdentity,
    },
  };
}

/**
 * Decomposition depth of a plan: 1 for a flat plan; a team whose sub-profile
 * itself contains `type: team` stages adds a level. The consumer supplies a
 * `profileDepth` loader when it can see sub-profile contents; without one the
 * plan is assumed flat (depth 1). Enforces MAX_DECOMPOSITION_DEPTH (2).
 */
export function validateDecompositionDepth(
  plan: TeamPlan,
  profileDepth?: (profile: string) => number,
): { ok: true; depth: number } | { ok: false; reason: string; depth: number } {
  if (!profileDepth) return { ok: true, depth: 1 };
  let depth = 1;
  for (const entry of plan.teams) {
    depth = Math.max(depth, 1 + profileDepth(entry.profile));
  }
  if (depth > MAX_DECOMPOSITION_DEPTH) {
    return {
      ok: false,
      reason: `decomposition depth ${depth} exceeds cap ${MAX_DECOMPOSITION_DEPTH} (CTO -> team -> sub-team)`,
      depth,
    };
  }
  return { ok: true, depth };
}
