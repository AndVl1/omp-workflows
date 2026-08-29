/**
 * Shared deterministic autonomy-directive parser for /cto, /do-work and
 * /team.
 *
 * One parser feeds every command surface so the resolved `autonomyHint` and
 * the stripped task text never diverge between commands. It is a
 * leading-directive parser by contract:
 *
 *  - The exact bracket token `[AUTONOMOUS]` enables the hint. It must be
 *    followed by whitespace or the end of the input; a lookalike such as
 *    `[AUTONOMOUSLY]` (the closing bracket never lands) or `[AUTONOMOUS]`
 *    glued to the task (`[AUTONOMOUS]task`) is NOT a directive — it stays
 *    verbatim in the task text so input is never corrupted.
 *  - A bounded, explicit list of natural-language leading directives
 *    (`действуй автономно`, normalized: case-insensitive, whitespace
 *    collapsed) enables the hint and is stripped together with an optional
 *    `:`, `,` or `;` separator. No fuzzy keyword matching, no
 *    LLM-dependent mode detection.
 *
 * Authority contract (RC2+): the result is a MECHANICAL HINT, never the
 * autonomy decision. PHASE-0 instructs the main LLM to classify
 * `autonomous` from the complete task semantics in any language; this hint
 * is rendered as non-authoritative metadata and must never be copied into
 * persisted state as the decision.
 */
/* <!-- omp-cto-slice run=01a03ee4-7dd6-7580-8ad7-16d26dc886ba slice=workflow-v2-core --> */

import { createDiagnostic, isDiagnosticEvidenceRecord } from "../workflow-v2/diagnostics.js";
import { validateProviderCatalog } from "../workflow-v2/descriptor.js";
import { isProviderId, isWorkflowV2Digest, validateProjectIdentity, validateWorkflowRunIdentity } from "../workflow-v2/identity.js";
import type {
  AgentRef,
  EffectivePolicy,
  ProfileIdentity,
  ProjectIdentity,
  ProviderCatalog,
  RosterOverride,
  ScopeRule,
  WorkflowRunIdentity,
  WorkflowV2Diagnostic,
} from "../workflow-v2/types.js";

const AGENT_REF_KEYS = ["registered_name", "provider_id", "source_fingerprint"] as const;
const EFFECTIVE_POLICY_KEYS = [
  "provider",
  "roles",
  "scope_map",
  "roster_overrides",
  "flags",
  "runtime_classes",
  "ui_classes",
  "design_system",
  "commands",
  "workflow",
  "prompt_context",
  "required_capabilities",
] as const;
const COMMAND_CONTEXT_KEYS = [
  "branch",
  "project_identity",
  "run_identity",
  "effectivePolicy",
  "catalog",
  "agentInventory",
] as const;

function isSafeCommandText(value: unknown): value is string {
  return typeof value === "string"
    && value.length > 0
    && value === value.trim()
    && !/[\u0000-\u001f\u007f-\u009f]/u.test(value);
}

function isBoundedPolicyText(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 8_192) return false;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d) return false;
    if (code >= 0x7f && code <= 0x9f) return false;
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next < 0xdc00 || next > 0xdfff) return false;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return false;
    }
  }
  return true;
}

function isPlainCommandRecord(value: unknown): value is Record<string, unknown> {
  if (!isDiagnosticEvidenceRecord(value)) return false;
  try {
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
  } catch {
    return false;
  }
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  try {
    const keys = Object.keys(value);
    return keys.length === expected.length
      && expected.every((key) => Object.prototype.hasOwnProperty.call(value, key));
  } catch {
    return false;
  }
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  try {
    return Object.keys(value).every((key) => allowed.includes(key));
  } catch {
    return false;
  }
}

function hasRequiredKeys(value: Record<string, unknown>, required: readonly string[]): boolean {
  return required.every((key) => Object.prototype.hasOwnProperty.call(value, key));
}

function isIdentifierArray(value: unknown, allowEmpty = true): value is readonly string[] {
  if (!Array.isArray(value) || (!allowEmpty && value.length === 0)) return false;
  for (const entry of value) {
    if (!isSafeCommandText(entry)) return false;
  }
  return true;
}

function isProfileIdentity(value: unknown): value is ProfileIdentity {
  return isPlainCommandRecord(value)
    && hasExactKeys(value, ["id", "fingerprint"])
    && isSafeCommandText(value.id)
    && isWorkflowV2Digest(value.fingerprint);
}

function qualifiedAgent(value: unknown): value is AgentRef {
  return isPlainCommandRecord(value)
    && hasExactKeys(value, AGENT_REF_KEYS)
    && isSafeCommandText(value.registered_name)
    && isProviderId(value.provider_id)
    && isWorkflowV2Digest(value.source_fingerprint);
}

function isAgentInventory(value: unknown): value is readonly AgentRef[] {
  if (!Array.isArray(value)) return false;
  for (const entry of value) {
    if (!qualifiedAgent(entry)) return false;
  }
  return true;
}

function isAgentMap(value: unknown): value is Readonly<Record<string, AgentRef>> {
  if (!isPlainCommandRecord(value)) return false;
  for (const [role, agent] of Object.entries(value)) {
    if (!isSafeCommandText(role) || !qualifiedAgent(agent)) return false;
  }
  return true;
}

function isScopeRule(value: unknown): value is ScopeRule {
  if (!isPlainCommandRecord(value)
    || !hasOnlyKeys(value, ["patterns", "scope", "dev_agent", "runtime_class", "ui_class"])
    || !hasRequiredKeys(value, ["patterns", "scope", "dev_agent"])
    || !isIdentifierArray(value.patterns, false)
    || !isSafeCommandText(value.scope)
    || !qualifiedAgent(value.dev_agent)) return false;
  for (const key of ["runtime_class", "ui_class"] as const) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) continue;
    const candidate = value[key];
    if (candidate !== null
      && typeof candidate !== "boolean"
      && !isSafeCommandText(candidate)) return false;
  }
  return true;
}

function isScopeRuleArray(value: unknown): value is readonly ScopeRule[] {
  if (!Array.isArray(value)) return false;
  for (const entry of value) {
    if (!isScopeRule(entry)) return false;
  }
  return true;
}

function isRosterOverride(value: unknown): value is RosterOverride {
  if (!isPlainCommandRecord(value) || !hasOnlyKeys(value, ["replace", "add", "remove"])) return false;
  for (const key of ["replace", "add", "remove"] as const) {
    if (Object.prototype.hasOwnProperty.call(value, key) && !isIdentifierArray(value[key])) return false;
  }
  return true;
}

function isRosterOverrideArray(value: unknown): value is readonly RosterOverride[] {
  if (!Array.isArray(value)) return false;
  for (const entry of value) {
    if (!isRosterOverride(entry)) return false;
  }
  return true;
}

function isBooleanMap(value: unknown): value is Readonly<Record<string, boolean>> {
  if (!isPlainCommandRecord(value)) return false;
  for (const [key, candidate] of Object.entries(value)) {
    if (!isSafeCommandText(key) || typeof candidate !== "boolean") return false;
  }
  return true;
}

function isClassMap(value: unknown): value is Readonly<Record<string, string | boolean>> {
  if (!isPlainCommandRecord(value)) return false;
  for (const [key, candidate] of Object.entries(value)) {
    if (!isSafeCommandText(key)
      || (typeof candidate !== "boolean" && !isSafeCommandText(candidate))) return false;
  }
  return true;
}

function isPolicyFragment(value: unknown): boolean {
  if (!isPlainCommandRecord(value)
    || !hasExactKeys(value, ["id", "text", "owner"])
    || !isSafeCommandText(value.id)
    || !isBoundedPolicyText(value.text)
    || !isPlainCommandRecord(value.owner)
    || !hasExactKeys(value.owner, ["kind", "source"])) return false;
  return value.owner.kind === "project_policy" && value.owner.source === ".omp/team.config.json";
}

function isFragmentCommand(value: unknown): boolean {
  if (!isPlainCommandRecord(value) || !hasExactKeys(value, ["fragments"]) || !Array.isArray(value.fragments)) return false;
  for (const fragment of value.fragments) {
    if (!isPolicyFragment(fragment)) return false;
  }
  return true;
}

function isCommandPolicy(value: unknown): boolean {
  return isPlainCommandRecord(value)
    && hasExactKeys(value, ["do-work", "team", "cto"])
    && isFragmentCommand(value["do-work"])
    && isFragmentCommand(value.cto)
    && isPlainCommandRecord(value.team)
    && hasExactKeys(value.team, ["alias_of"])
    && value.team.alias_of === "do-work";
}

function isWorkflowSelection(value: unknown): value is EffectivePolicy["workflow"] {
  if (!isPlainCommandRecord(value) || typeof value.selection !== "string") return false;
  if (value.selection === "matrix") return hasExactKeys(value, ["selection"]);
  return value.selection === "fixed"
    && hasExactKeys(value, ["selection", "profile_identity"])
    && isProfileIdentity(value.profile_identity);
}

function isPromptContextEntry(value: unknown): boolean {
  if (!isPlainCommandRecord(value)
    || !hasExactKeys(value, ["id", "type", "value"])
    || !isSafeCommandText(value.id)) return false;
  if (value.type === "text" || value.type === "enum") return isBoundedPolicyText(value.value);
  if (value.type === "number") return typeof value.value === "number" && Number.isFinite(value.value);
  return value.type === "boolean" && typeof value.value === "boolean";
}

function isPromptContextMap(value: unknown): value is Readonly<EffectivePolicy["prompt_context"]> {
  if (!isPlainCommandRecord(value)) return false;
  for (const [key, entry] of Object.entries(value)) {
    if (!isSafeCommandText(key)
      || !isPromptContextEntry(entry)
      || !isPlainCommandRecord(entry)
      || entry.id !== key) return false;
  }
  return true;
}

function isEffectivePolicy(value: unknown): value is EffectivePolicy {
  try {
    if (!isPlainCommandRecord(value) || !hasExactKeys(value, EFFECTIVE_POLICY_KEYS)) return false;
    return isPlainCommandRecord(value.provider)
      && hasExactKeys(value.provider, ["id", "protocol_version", "descriptor_fingerprint", "catalog_content_digest"])
      && isProviderId(value.provider.id)
      && value.provider.protocol_version === 2
      && isWorkflowV2Digest(value.provider.descriptor_fingerprint)
      && isWorkflowV2Digest(value.provider.catalog_content_digest)
      && isAgentMap(value.roles)
      && isScopeRuleArray(value.scope_map)
      && isRosterOverrideArray(value.roster_overrides)
      && isBooleanMap(value.flags)
      && isClassMap(value.runtime_classes)
      && isClassMap(value.ui_classes)
      && (value.design_system === null || isSafeCommandText(value.design_system))
      && isCommandPolicy(value.commands)
      && isWorkflowSelection(value.workflow)
      && isPromptContextMap(value.prompt_context)
      && isIdentifierArray(value.required_capabilities);
  } catch {
    return false;
  }
}

function isProviderCatalog(value: unknown): value is Readonly<ProviderCatalog> {
  try {
    return validateProviderCatalog(value).ok;
  } catch {
    return false;
  }
}

function commandDiagnostic(
  code: WorkflowV2Diagnostic["code"],
  field: string,
  message: string,
): WorkflowV2Diagnostic {
  return createDiagnostic({
    code,
    operation: "command.dispatch",
    evidence: { field },
    remediation: message,
  });
}

/** Typed failure raised before a command prompt or side effect is produced. */
export class WorkflowCommandContextError extends Error {
  readonly diagnostic: WorkflowV2Diagnostic;

  constructor(diagnostic: WorkflowV2Diagnostic) {
    super(`${diagnostic.code}: ${diagnostic.remediation}`);
    this.name = "WorkflowCommandContextError";
    this.diagnostic = diagnostic;
  }
}

/**
 * Host-owned immutable context required by every direct command renderer.
 * Commands never derive these values from cwd, process state, package order,
 * or prompt text.
 */
export interface WorkflowCommandContext {
  readonly branch: string;
  readonly project_identity: Readonly<ProjectIdentity>;
  readonly run_identity: Readonly<WorkflowRunIdentity>;
  readonly effectivePolicy: Readonly<EffectivePolicy>;
  readonly catalog: Readonly<ProviderCatalog>;
  readonly agentInventory: readonly AgentRef[];
}

function failCommandContext(
  code: WorkflowV2Diagnostic["code"],
  field: string,
  message: string,
): never {
  throw new WorkflowCommandContextError(commandDiagnostic(code, field, message));
}


function sameProfile(left: ProfileIdentity, right: ProfileIdentity): boolean {
  return left.id === right.id && left.fingerprint === right.fingerprint;
}

/**
 * Validate the complete command context supplied by host admission. The
 * result is the only authority accepted by command prompt helpers.
 */
export function requireWorkflowCommandContext(value: unknown): WorkflowCommandContext {
  if (
    !isPlainCommandRecord(value)
    || !hasExactKeys(value, COMMAND_CONTEXT_KEYS)
  ) {
    return failCommandContext(
      "MIGRATION_REQUIRED",
      "workflow_context",
      "Supply host-admitted branch, project/run identities, policy, catalog, and qualified agent inventory before invoking the command.",
    );
  }
  const branch = value.branch;
  if (
    !isSafeCommandText(branch)
    || branch.startsWith("/")
    || branch.includes("\\")
    || branch === "."
    || branch === ".."
  ) {
    return failCommandContext(
      "MIGRATION_REQUIRED",
      "branch",
      "Supply the unchanged canonical branch from the active session manager; command helpers never infer it.",
    );
  }
  const projectIdentity = value.project_identity;
  const checkedIdentity = validateProjectIdentity(projectIdentity);
  if (!checkedIdentity.ok) {
    return failCommandContext(
      "IDENTITY_MISMATCH",
      "project_identity",
      "Supply an unchanged project identity admitted for this command invocation.",
    );
  }
  const runIdentity = value.run_identity;
  if (runIdentity === undefined || runIdentity === null) {
    return failCommandContext(
      "MIGRATION_REQUIRED",
      "run_identity",
      "Supply the complete workflow run identity persisted by workflow_prepare before invoking the command.",
    );
  }
  const checkedRunIdentity = validateWorkflowRunIdentity(runIdentity);
  if (!checkedRunIdentity.ok) {
    return failCommandContext(
      "MIGRATION_REQUIRED",
      "run_identity",
      "Supply the complete workflow run identity persisted by workflow_prepare before invoking the command.",
    );
  }
  if (!sameWorkflowCommandIdentity(checkedIdentity.value, checkedRunIdentity.value)) {
    return failCommandContext(
      "IDENTITY_MISMATCH",
      "run_identity",
      "The workflow run identity must inherit every immutable project identity pin admitted for this command.",
    );
  }
  const catalogCandidate = value.catalog;
  if (!isProviderCatalog(catalogCandidate)) {
    return failCommandContext(
      "CONFIG_MALFORMED",
      "catalog",
      "Supply the validated provider catalog with its immutable content digest and complete profile identities.",
    );
  }
  const catalog = catalogCandidate;
  const policyCandidate = value.effectivePolicy;
  if (!isPlainCommandRecord(policyCandidate)) {
    return failCommandContext(
      "MIGRATION_REQUIRED",
      "effectivePolicy",
      "Supply the host-resolved effective policy; command helpers never reconstruct policy.",
    );
  }
  if (!isEffectivePolicy(policyCandidate)) {
    return failCommandContext(
      "CONFIG_MALFORMED",
      "effectivePolicy",
      "Supply the complete strict effective policy returned by host policy resolution.",
    );
  }
  const effectivePolicy = policyCandidate;
  const provider = effectivePolicy.provider;
  if (
    provider.id !== checkedIdentity.value.provider_id
    || provider.descriptor_fingerprint !== checkedIdentity.value.descriptor_fingerprint
    || provider.catalog_content_digest !== checkedIdentity.value.catalog_content_digest
    || catalog.content_digest !== checkedIdentity.value.catalog_content_digest
  ) {
    return failCommandContext(
      "IDENTITY_MISMATCH",
      "provider",
      "Policy, provider, catalog, and project identity must identify the same selected provider.",
    );
  }
  const workflow = effectivePolicy.workflow;
  if (workflow.selection === "fixed") {
    const profile = workflow.profile_identity;
    if (!catalog.profiles.some((candidate) =>
      candidate.identity.id === profile.id
      && candidate.identity.fingerprint === profile.fingerprint
    )) {
      return failCommandContext(
        "PROFILE_UNAVAILABLE",
        "effectivePolicy.workflow.profile_identity",
        "A fixed effective policy must carry an exact profile identity present in the admitted catalog.",
      );
    }
  }
  const runProfile = checkedRunIdentity.value.profile_identity;
  if (!catalog.profiles.some((candidate) =>
    candidate.identity.id === runProfile.id
    && candidate.identity.fingerprint === runProfile.fingerprint
  )) {
    return failCommandContext(
      "PROFILE_UNAVAILABLE",
      "run_identity.profile_identity",
      "The workflow run profile is not present in the admitted immutable catalog.",
    );
  }
  if (workflow.selection === "fixed" && !sameProfile(workflow.profile_identity, runProfile)) {
    return failCommandContext(
      "IDENTITY_MISMATCH",
      "run_identity.profile_identity",
      "The workflow run profile differs from the fixed effective-policy profile.",
    );
  }
  const roles = effectivePolicy.roles;
  const scopeMap = effectivePolicy.scope_map;
  const inventoryCandidate = value.agentInventory;
  if (!Array.isArray(inventoryCandidate)) {
    return failCommandContext(
      "MIGRATION_REQUIRED",
      "agentInventory",
      "Supply the qualified agent inventory returned by the selected provider registration.",
    );
  }
  if (!isAgentInventory(inventoryCandidate)) {
    return failCommandContext(
      "AGENT_COLLISION",
      "agentInventory",
      "Every qualified agent must carry a valid identity for the selected provider.",
    );
  }
  const inventory = inventoryCandidate;
  const byName = new Map<string, AgentRef>();
  for (const candidate of inventory) {
    if (candidate.provider_id !== checkedIdentity.value.provider_id) {
      return failCommandContext(
        "AGENT_COLLISION",
        "agentInventory",
        "Every qualified agent must carry a valid identity for the selected provider.",
      );
    }
    const prior = byName.get(candidate.registered_name);
    if (prior && (
      prior.provider_id !== candidate.provider_id
      || prior.source_fingerprint !== candidate.source_fingerprint
    )) {
      return failCommandContext(
        "AGENT_COLLISION",
        "agentInventory",
        "A registered agent name resolves to multiple provider/source identities.",
      );
    }
    byName.set(candidate.registered_name, candidate);
  }
  for (const [role, ref] of Object.entries(roles)) {
    if (ref.provider_id !== checkedIdentity.value.provider_id) {
      return failCommandContext(
        "AGENT_COLLISION",
        `role:${role}`,
        "Every effective role must resolve to a qualified agent from the selected provider.",
      );
    }
    const selected = byName.get(ref.registered_name);
    if (
      !selected
      || selected.provider_id !== ref.provider_id
      || selected.source_fingerprint !== ref.source_fingerprint
    ) {
      return failCommandContext(
        "AGENT_COLLISION",
        `role:${role}`,
        "Every effective role must match an exact qualified provider inventory entry.",
      );
    }
  }
  for (const [index, rule] of scopeMap.entries()) {
    const ref = rule.dev_agent;
    if (ref.provider_id !== checkedIdentity.value.provider_id) {
      return failCommandContext(
        "AGENT_COLLISION",
        `scope_map:${index}`,
        "Every scope mapping must resolve to an exact qualified agent from the selected provider.",
      );
    }
    const selected = byName.get(ref.registered_name);
    if (
      !selected
      || selected.provider_id !== ref.provider_id
      || selected.source_fingerprint !== ref.source_fingerprint
    ) {
      return failCommandContext(
        "AGENT_COLLISION",
        `scope_map:${index}`,
        "Every scope mapping must match an exact qualified agent from the selected provider.",
      );
    }
  }
  return {
    branch,
    project_identity: checkedIdentity.value,
    run_identity: checkedRunIdentity.value,
    effectivePolicy,
    catalog,
    agentInventory: inventory,
  };
}

/** Resolve the command's canonical branch and reject envelope drift. */
export function resolveCommandBranch(
  envelopeBranch: string | null,
  context: WorkflowCommandContext,
): string {
  if (envelopeBranch !== null && envelopeBranch !== context.branch) {
    throw new WorkflowCommandContextError(commandDiagnostic(
      "IDENTITY_MISMATCH",
      "branch",
      "The parsed command branch differs from the host-admitted canonical branch.",
    ));
  }
  return context.branch;
}

/** Compare all immutable project identity fields without serialization order. */
export function sameWorkflowCommandIdentity(
  left: ProjectIdentity,
  right: ProjectIdentity,
): boolean {
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
}

/** Resolve a prompt session only when it matches host admission. */
export function resolveCommandSession(
  sessionId: string | undefined,
  context: WorkflowCommandContext,
): string {
  if (sessionId !== undefined && sessionId !== context.project_identity.session.session_id) {
    throw new WorkflowCommandContextError(commandDiagnostic(
      "IDENTITY_MISMATCH",
      "session_id",
      "The prompt session differs from the host-admitted session identity.",
    ));
  }
  return context.project_identity.session.session_id;
}

/** Validate and compare a state run identity before rendering an amend prompt. */
export function requireMatchingWorkflowCommandIdentity(
  value: unknown,
  context: WorkflowCommandContext,
  expectedRunId?: string,
): WorkflowRunIdentity {
  if (value === undefined || value === null) {
    return failCommandContext(
      "MIGRATION_REQUIRED",
      "state.run_identity",
      "The active state has no workflow run identity; resume requires host admission and workflow_prepare.",
    );
  }
  const checked = validateWorkflowRunIdentity(value);
  if (
    !checked.ok
    || !sameWorkflowCommandIdentity(checked.value, context.project_identity)
    || checked.value.run_id !== context.run_identity.run_id
    || !sameProfile(checked.value.profile_identity, context.run_identity.profile_identity)
  ) {
    return failCommandContext(
      "IDENTITY_MISMATCH",
      "state.run_identity",
      "The active run identity differs from the host-admitted project/run identity.",
    );
  }
  if (
    !context.catalog.profiles.some((candidate) =>
      candidate.identity.id === checked.value.profile_identity.id
      && candidate.identity.fingerprint === checked.value.profile_identity.fingerprint
    )
  ) {
    return failCommandContext(
      "PROFILE_UNAVAILABLE",
      "state.run_identity.profile_identity",
      "The active run profile is not present in the admitted immutable catalog.",
    );
  }
  const selection = context.effectivePolicy.workflow;
  if (
    selection.selection === "fixed"
    && !sameProfile(selection.profile_identity, checked.value.profile_identity)
  ) {
    return failCommandContext(
      "IDENTITY_MISMATCH",
      "state.run_identity.profile_identity",
      "The active run profile differs from the fixed effective-policy profile.",
    );
  }
  if (expectedRunId !== undefined && checked.value.run_id !== expectedRunId) {
    return failCommandContext(
      "IDENTITY_MISMATCH",
      "state.run_identity.run_id",
      "The active run selector differs from the persisted workflow run identity.",
    );
  }
  return checked.value;
}

/** Exact bracket token that enables autonomous mode. */
export const AUTONOMOUS_TOKEN = "[AUTONOMOUS]";

/**
 * Bounded set of leading natural-language directives equivalent to
 * `[AUTONOMOUS]`. Deliberately small and explicit — adding entries here is
 * a UX decision that must be documented and tested, never inferred.
 */
export const AUTONOMOUS_DIRECTIVES = ["действуй автономно"] as const;

/** Separator characters allowed between a leading directive and the task. */
const DIRECTIVE_SEPARATOR = "[\\s:,;]+";

export interface AutonomousDirective {
  /**
   * MECHANICAL autonomy hint: true when a recognized leading directive was
   * present and stripped. NON-AUTHORITATIVE by contract — the main LLM
   * decides `autonomous` in PHASE-0 from the complete task semantics; this
   * hint is rendered for mechanical envelope hygiene only and is never
   * copied into persisted state as the decision.
   */
  autonomyHint: boolean;
  /**
   * Task text after stripping a recognized leading directive (leading
   * whitespace removed); the verbatim trimmed input when none matched.
   */
  task: string;
}

export interface ParsedTaskArguments {
  /** Task text after the shared leading-directive and issue metadata parse. */
  task: string;
  /** Mechanical directive hint; never a routing/checkpoint authority. */
  autonomyHint: boolean;
  /** Optional issue metadata removed from the task body. */
  issue: number | null;
}

/**
 * Parse the common task/issue envelope once for every command adapter. This
 * is deliberately pure so host admission remains the only source of root,
 * policy, provider, and session identity.
 */
export function parseTaskArguments(args: string): ParsedTaskArguments {
  const directive = parseAutonomousDirective(args);
  const issueMatch = directive.task.match(/issue=#(\d+)/);
  return {
    task: (issueMatch ? directive.task.replace(issueMatch[0], "") : directive.task).trim(),
    autonomyHint: directive.autonomyHint,
    issue: issueMatch ? Number(issueMatch[1]) : null,
  };
}

/** Escape regex metacharacters in a literal directive. */
function escapeRegExp(source: string): string {
  return source.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Build a case-insensitive leading-directive matcher from a literal phrase. */
function directivePattern(directive: string): RegExp {
  const words = directive.split(/\s+/).map(escapeRegExp);
  return new RegExp(`^(?:${words.join("\\s+")})(?:${DIRECTIVE_SEPARATOR}|$)`, "i");
}

const DIRECTIVE_PATTERNS = AUTONOMOUS_DIRECTIVES.map(directivePattern);

/**
 * Parse a raw `<args>` string for the leading autonomy directive.
 *
 * Returns `{ autonomyHint: true, task }` when an exact `[AUTONOMOUS]` token
 * or an approved natural directive opens the input (token followed by
 * whitespace/EOS; natural directive followed by whitespace/EOS or a
 * `: , ;` separator). Otherwise `{ autonomyHint: false, task }` with the
 * trimmed input preserved verbatim.
 *
 * The result is a MECHANICAL HINT (never authoritative): PHASE-0 has the
 * main LLM decide `autonomous` from the full task semantics, and this value
 * is only rendered as non-authoritative metadata.
 */
export function parseAutonomousDirective(args: string): AutonomousDirective {
  const trimmed = args.trimStart();

  if (trimmed.startsWith(AUTONOMOUS_TOKEN)) {
    const rest = trimmed.slice(AUTONOMOUS_TOKEN.length);
    // Token must stand alone: whitespace or end of input. `[AUTONOMOUS]task`
    // is ambiguous — keep it literal rather than corrupting the task.
    if (rest === "" || /^\s/.test(rest)) {
      return { autonomyHint: true, task: rest.trimStart() };
    }
    return { autonomyHint: false, task: trimmed };
  }

  for (const pattern of DIRECTIVE_PATTERNS) {
    const match = trimmed.match(pattern);
    if (match) {
      return { autonomyHint: true, task: trimmed.slice(match[0].length).trimStart() };
    }
  }

  return { autonomyHint: false, task: trimmed };
}
