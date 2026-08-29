import { createHash } from "node:crypto";
import {
  createDiagnostic,
  failureResult,
  successResult,
} from "./diagnostics.js";
import {
  isProviderId,
  isWorkflowV2Digest,
} from "./identity.js";
import type {
  AgentRef,
  AgentSourceFingerprint,
  CatalogProfile,
  DescriptorDefaults,
  DiagnosticResult,
  Profile,
  ProviderCatalog,
  ProviderDescriptor,
  WorkflowV2Digest,
} from "./types.js";
/**
 * RFC 8785 uses UTF-16 code-unit ordering for object keys.  `localeCompare`
 * is locale-dependent and therefore cannot be used for an identity digest.
 */
export function compareCanonicalKeys(left: string, right: string): number {
  const length = Math.min(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    const leftCode = left.charCodeAt(index);
    const rightCode = right.charCodeAt(index);
    if (leftCode !== rightCode) return leftCode - rightCode;
  }
  return left.length - right.length;
}

function validUnicode(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 0xd800 || code > 0xdfff) continue;
    if (code >= 0xdc00 || index + 1 >= value.length) return false;
    const next = value.charCodeAt(index + 1);
    if (next < 0xdc00 || next > 0xdfff) return false;
    index += 1;
  }
  return true;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/**
 * Canonical JSON for immutable descriptor/catalog data.  This intentionally
 * rejects values JSON.stringify would silently erase (undefined/functions),
 * non-finite numbers, non-plain objects and malformed UTF-16.
 */
export function canonicalImmutableJson(value: unknown): string {
  const active = new Set<object>();

  const encode = (entry: unknown): string => {
    if (entry === null) return "null";
    if (typeof entry === "string") {
      if (!validUnicode(entry)) throw new TypeError("immutable data contains unpaired Unicode");
      return JSON.stringify(entry);
    }
    if (typeof entry === "boolean") return entry ? "true" : "false";
    if (typeof entry === "number") {
      if (!Number.isFinite(entry)) throw new TypeError("immutable data contains a non-finite number");
      // JSON.stringify implements ECMAScript NumberToString (the primitive
      // required by JCS), including canonical -0 -> 0 handling.
      return JSON.stringify(entry);
    }
    if (typeof entry !== "object") throw new TypeError("immutable data contains a non-JSON value");
    if (active.has(entry)) throw new TypeError("immutable data contains a cycle");
    active.add(entry);
    try {
      if (Array.isArray(entry)) {
        const encoded: string[] = [];
        for (let index = 0; index < entry.length; index += 1) {
          if (!Object.prototype.hasOwnProperty.call(entry, index)) throw new TypeError("immutable data contains a sparse array");
          encoded.push(encode(entry[index]));
        }
        return `[${encoded.join(",")}]`;
      }
      if (!isPlainRecord(entry)) throw new TypeError("immutable data contains a non-plain object");
      const keys = Object.keys(entry).sort(compareCanonicalKeys);
      return `{${keys.map((key) => `${JSON.stringify(key)}:${encode(entry[key])}`).join(",")}}`;
    } finally {
      active.delete(entry);
    }
  };

  return encode(value);
}

export function digestImmutable(value: unknown): WorkflowV2Digest {
  return `sha256:${createHash("sha256").update(canonicalImmutableJson(value), "utf8").digest("hex")}`;
}

/** Digest the profile value itself (without the catalog identity wrapper). */
export function computeProfileContentDigest(profile: unknown): WorkflowV2Digest {
  return digestImmutable(profile);
}


function safeIdentifier(value: unknown): value is string {
  return typeof value === "string"
    && value.length > 0
    && value.length <= 256
    && value === value.trim()
    && validUnicode(value)
    && /^[A-Za-z0-9@._:/#-]+$/u.test(value);
}

function hasExactKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  const allowedSet = new Set(allowed);
  return Object.keys(value).every((key) => allowedSet.has(key));
}

function identifierArray(value: unknown, allowEmpty = true): value is string[] {
  if (!Array.isArray(value) || (!allowEmpty && value.length === 0)) return false;
  for (let index = 0; index < value.length; index += 1) {
    if (!Object.prototype.hasOwnProperty.call(value, index) || !safeIdentifier(value[index])) return false;
  }
  return true;
}

function stringArray(value: unknown, allowEmpty = true): value is string[] {
  if (!Array.isArray(value) || (!allowEmpty && value.length === 0)) return false;
  for (let index = 0; index < value.length; index += 1) {
    if (!Object.prototype.hasOwnProperty.call(value, index) || typeof value[index] !== "string" || !validUnicode(value[index])) return false;
  }
  return true;
}

function optionalString(value: unknown): boolean {
  return value === undefined || typeof value === "string";
}
function optionalIdentifierArray(value: unknown): boolean {
  return value === undefined || identifierArray(value);
}

function optionalStringOrBooleanOrNull(value: unknown): boolean {
  return value === undefined || value === null || typeof value === "string" || typeof value === "boolean";
}

function isAgentRefValue(value: unknown, providerId?: string): value is AgentRef {
  if (!isPlainRecord(value) || !hasExactKeys(value, ["registered_name", "provider_id", "source_fingerprint"])) return false;
  return safeIdentifier(value.registered_name)
    && isProviderId(value.provider_id)
    && (providerId === undefined || value.provider_id === providerId)
    && isWorkflowV2Digest(value.source_fingerprint);
}

function isAgentSourceValue(value: unknown, providerId?: string): value is AgentSourceFingerprint {
  if (!isPlainRecord(value) || !hasExactKeys(value, ["provider_id", "source_fingerprint", "registered_names"])) return false;
  return isProviderId(value.provider_id)
    && (providerId === undefined || value.provider_id === providerId)
    && isWorkflowV2Digest(value.source_fingerprint)
    && identifierArray(value.registered_names, false);
}

function isExecutableProvenanceValue(value: unknown): boolean {
  return isPlainRecord(value)
    && hasExactKeys(value, ["build_fingerprint", "runtime_fingerprint"])
    && isWorkflowV2Digest(value.build_fingerprint)
    && isWorkflowV2Digest(value.runtime_fingerprint);
}

function isScopeRuleValue(value: unknown, providerId: string): boolean {
  if (!isPlainRecord(value)
    || !hasExactKeys(value, ["patterns", "scope", "dev_agent", "runtime_class", "ui_class"])
    && !hasExactKeys(value, ["patterns", "scope", "dev_agent"])) return false;
  return stringArray(value.patterns)
    && typeof value.scope === "string"
    && isAgentRefValue(value.dev_agent, providerId)
    && optionalStringOrBooleanOrNull(value.runtime_class)
    && optionalStringOrBooleanOrNull(value.ui_class);
}

function isRosterOverrideValue(value: unknown): boolean {
  if (!isPlainRecord(value) || !hasExactKeys(value, ["replace", "add", "remove"])) return false;
  return optionalIdentifierArray(value.replace)
    && optionalIdentifierArray(value.add)
    && optionalIdentifierArray(value.remove);
}

function isPolicyFragmentValue(value: unknown): boolean {
  if (!isPlainRecord(value)
    || !hasExactKeys(value, ["id", "text", "owner"])
    || typeof value.id !== "string"
    || typeof value.text !== "string"
    || !isPlainRecord(value.owner)
    || !hasExactKeys(value.owner, ["kind", "source"])) return false;
  return value.owner.kind === "project_policy" && value.owner.source === ".omp/team.config.json";
}

function isFragmentCommandValue(value: unknown): boolean {
  if (!isPlainRecord(value) || !hasExactKeys(value, ["fragments"]) || !Array.isArray(value.fragments)) return false;
  for (let index = 0; index < value.fragments.length; index += 1) {
    if (!Object.prototype.hasOwnProperty.call(value.fragments, index) || !isPolicyFragmentValue(value.fragments[index])) return false;
  }
  return true;
}

function isCommandPolicyValue(value: unknown): boolean {
  if (!isPlainRecord(value)
    || !hasExactKeys(value, ["do-work", "team", "cto"])
    || !isFragmentCommandValue(value["do-work"])
    || !isFragmentCommandValue(value.cto)
    || !isPlainRecord(value.team)
    || !hasExactKeys(value.team, ["alias_of"])) return false;
  return value.team.alias_of === "do-work";
}

function isWorkflowSelectionValue(value: unknown): boolean {
  if (!isPlainRecord(value) || typeof value.selection !== "string") return false;
  if (value.selection === "matrix") return hasExactKeys(value, ["selection"]);
  return value.selection === "fixed"
    && hasExactKeys(value, ["selection", "profile_identity"])
    && isPlainRecord(value.profile_identity)
    && hasExactKeys(value.profile_identity, ["id", "fingerprint"])
    && safeIdentifier(value.profile_identity.id)
    && isWorkflowV2Digest(value.profile_identity.fingerprint);
}

function isPromptContextEntryValue(value: unknown): boolean {
  if (!isPlainRecord(value)
    || !hasExactKeys(value, ["id", "type", "value"])
    || !safeIdentifier(value.id)
    || typeof value.type !== "string") return false;
  if (value.type === "text" || value.type === "enum") return typeof value.value === "string";
  if (value.type === "number") return typeof value.value === "number" && Number.isFinite(value.value);
  return value.type === "boolean" && typeof value.value === "boolean";
}

function isDescriptorDefaultsValue(value: unknown, providerId: string): value is DescriptorDefaults {
  if (!isPlainRecord(value) || !hasExactKeys(value, [
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
  ])) return false;
  if (value.roles !== undefined) {
    if (!isPlainRecord(value.roles)) return false;
    for (const agent of Object.values(value.roles)) {
      if (agent !== null && !isAgentRefValue(agent, providerId)) return false;
    }
  }
  if (value.scope_map !== undefined) {
    if (!Array.isArray(value.scope_map)) return false;
    for (let index = 0; index < value.scope_map.length; index += 1) {
      if (!Object.prototype.hasOwnProperty.call(value.scope_map, index) || !isScopeRuleValue(value.scope_map[index], providerId)) return false;
    }
  }
  if (value.roster_overrides !== undefined) {
    if (!Array.isArray(value.roster_overrides)) return false;
    for (let index = 0; index < value.roster_overrides.length; index += 1) {
      if (!Object.prototype.hasOwnProperty.call(value.roster_overrides, index) || !isRosterOverrideValue(value.roster_overrides[index])) return false;
    }
  }
  if (value.flags !== undefined) {
    if (!isPlainRecord(value.flags) || !Object.values(value.flags).every((flag) => typeof flag === "boolean")) return false;
  }
  for (const classes of [value.runtime_classes, value.ui_classes]) {
    if (classes !== undefined && (!isPlainRecord(classes) || !Object.values(classes).every((entry) => typeof entry === "string" || typeof entry === "boolean"))) return false;
  }
  if (!optionalStringOrBooleanOrNull(value.design_system) || (value.design_system !== null && value.design_system !== undefined && typeof value.design_system !== "string")) return false;
  if (value.commands !== undefined && !isCommandPolicyValue(value.commands)) return false;
  if (value.workflow !== undefined && !isWorkflowSelectionValue(value.workflow)) return false;
  if (value.prompt_context !== undefined) {
    if (!isPlainRecord(value.prompt_context) || !Object.values(value.prompt_context).every(isPromptContextEntryValue)) return false;
  }
  return value.required_capabilities === undefined || identifierArray(value.required_capabilities, false);
}

function isStageValue(value: unknown): boolean {
  if (!isPlainRecord(value)
    || !hasExactKeys(value, [
      "id",
      "title",
      "type",
      "prompt",
      "description",
      "roles",
      "role",
      "teams",
      "profile",
      "integration",
      "parallel",
      "consumes",
      "produces",
      "checkpoint",
      "checkpoint_policy",
      "completion_intent",
      "roster_policy",
      "autonomous",
      "command",
      "document",
      "fan_in",
      "gate",
      "conditional",
      "skip_if",
      "loop",
    ])) return false;
  if (typeof value.id !== "string" || typeof value.title !== "string" || typeof value.type !== "string"
    || !["orchestrator", "single", "consilium", "document", "bash", "none", "team"].includes(value.type)) return false;
  if (![value.prompt, value.description, value.role, value.profile, value.checkpoint, value.autonomous, value.command, value.gate, value.skip_if].every(optionalString)) return false;
  for (const names of [value.roles, value.teams, value.consumes]) {
    if (names !== undefined && !stringArray(names)) return false;
  }
  if (value.produces !== undefined && typeof value.produces !== "string" && !stringArray(value.produces)) return false;
  if (value.parallel !== undefined && typeof value.parallel !== "boolean") return false;
  if (value.integration !== undefined) {
    if (!isPlainRecord(value.integration) || !hasExactKeys(value.integration, ["stage", "on_failure"])
      || typeof value.integration.stage !== "string" || typeof value.integration.on_failure !== "string") return false;
  }
  if (value.document !== undefined) {
    if (!isPlainRecord(value.document) || !hasExactKeys(value.document, ["format", "renderer", "path"])
      || typeof value.document.format !== "string" || typeof value.document.renderer !== "string" || typeof value.document.path !== "string") return false;
  }
  if (value.fan_in !== undefined) {
    const fanIn = value.fan_in;
    if (!isPlainRecord(fanIn) || !hasExactKeys(fanIn, ["resolutions"]) || fanIn.resolutions !== undefined && !Array.isArray(fanIn.resolutions)) return false;
    if (Array.isArray(fanIn.resolutions)) {
      for (let index = 0; index < fanIn.resolutions.length; index += 1) {
        const resolution = fanIn.resolutions[index];
        if (!Object.prototype.hasOwnProperty.call(fanIn.resolutions, index)
          || !isPlainRecord(resolution)
          || !hasExactKeys(resolution, ["artifact", "field", "strategy", "rationale"])
          || typeof resolution.artifact !== "string"
          || typeof resolution.field !== "string"
          || resolution.strategy !== "first_slot"
          || typeof resolution.rationale !== "string") return false;
      }
    }
  }
  if (value.conditional !== undefined) {
    if (!Array.isArray(value.conditional)) return false;
    for (let index = 0; index < value.conditional.length; index += 1) {
      const conditional = value.conditional[index];
      if (!Object.prototype.hasOwnProperty.call(value.conditional, index)
        || !isPlainRecord(conditional)
        || !hasExactKeys(conditional, ["if", "add", "remove"])
        || typeof conditional.if !== "string"
        || !optionalString(conditional.add)
        || !optionalString(conditional.remove)) return false;
    }
  }
  if (value.loop !== undefined) {
    if (!isPlainRecord(value.loop)
      || !hasExactKeys(value.loop, ["back_to", "until", "max_iterations", "on_exhausted"])
      || typeof value.loop.back_to !== "string"
      || typeof value.loop.until !== "string"
      || typeof value.loop.max_iterations !== "number"
      || !Number.isInteger(value.loop.max_iterations)
      || value.loop.max_iterations < 0
      || typeof value.loop.on_exhausted !== "string") return false;
  }
  return [value.checkpoint_policy, value.completion_intent, value.roster_policy].every((entry) => entry === undefined || isPlainRecord(entry));
}

function isWorkflowProfileValue(value: unknown): value is Profile {
  if (!isPlainRecord(value)
    || !hasExactKeys(value, ["name", "title", "description", "match", "stages", "completion_intent", "checkpoint_policy", "autoSelect"])
    || !safeIdentifier(value.name)
    || typeof value.title !== "string"
    || typeof value.description !== "string"
    || !isPlainRecord(value.match)
    || !stringArray(value.match.type)
    || value.match.complexity !== undefined && !stringArray(value.match.complexity)
    || !Array.isArray(value.stages)
    || value.stages.length === 0) return false;
  for (let index = 0; index < value.stages.length; index += 1) {
    if (!Object.prototype.hasOwnProperty.call(value.stages, index) || !isStageValue(value.stages[index])) return false;
  }
  return (value.completion_intent === undefined || isPlainRecord(value.completion_intent))
    && (value.checkpoint_policy === undefined || isPlainRecord(value.checkpoint_policy))
    && (value.autoSelect === undefined || typeof value.autoSelect === "boolean");
}

function isProviderDescriptorValue(value: unknown): value is ProviderDescriptor {
  if (!isPlainRecord(value)
    || !hasExactKeys(value, [
      "id",
      "protocol_version",
      "capabilities",
      "catalog_content_digest",
      "agent_sources",
      "executable_provenance",
      "defaults",
    ])
    || !isProviderId(value.id)
    || value.protocol_version !== 2
    || !identifierArray(value.capabilities, false)
    || !isWorkflowV2Digest(value.catalog_content_digest)
    || !Array.isArray(value.agent_sources)
    || value.agent_sources.length === 0
    || !isExecutableProvenanceValue(value.executable_provenance)
    || !isDescriptorDefaultsValue(value.defaults, value.id)) return false;
  for (let index = 0; index < value.agent_sources.length; index += 1) {
    if (!Object.prototype.hasOwnProperty.call(value.agent_sources, index) || !isAgentSourceValue(value.agent_sources[index], value.id)) return false;
  }
  return true;
}

function isCatalogProfileValue(value: unknown): value is CatalogProfile {
  if (!isPlainRecord(value) || !hasExactKeys(value, ["identity", "profile"]) || !isPlainRecord(value.identity)) return false;
  return hasExactKeys(value.identity, ["id", "fingerprint"])
    && safeIdentifier(value.identity.id)
    && isWorkflowV2Digest(value.identity.fingerprint)
    && isWorkflowProfileValue(value.profile);
}

function isProviderCatalogValue(value: unknown): value is ProviderCatalog {
  if (!isPlainRecord(value)
    || !hasExactKeys(value, ["content_digest", "profiles"])
    || !isWorkflowV2Digest(value.content_digest)
    || !Array.isArray(value.profiles)) return false;
  for (let index = 0; index < value.profiles.length; index += 1) {
    if (!Object.prototype.hasOwnProperty.call(value.profiles, index) || !isCatalogProfileValue(value.profiles[index])) return false;
  }
  return true;
}

function issue(
  code: "CONFIG_MALFORMED" | "UNSUPPORTED_SCHEMA" | "IDENTITY_MISMATCH" | "AGENT_COLLISION",
  operation: "provider.lookup" | "catalog.validate" | "agent.preflight",
  field: string,
  remediation: string,
  extra: Record<string, unknown> = {},
) {
  return createDiagnostic({
    code,
    operation,
    evidence: { field, ...extra },
    remediation,
  });
}

function ownKeysOnly(value: Record<string, unknown>, allowed: readonly string[], path: string, diagnostics: ReturnType<typeof issue>[]): void {
  const allowedSet = new Set(allowed);
  for (const key of Object.keys(value)) {
    if (!allowedSet.has(key)) diagnostics.push(issue("CONFIG_MALFORMED", "catalog.validate", `${path}.${key}`, "Remove unknown provider descriptor/catalog fields."));
  }
}

function validateSerializable(value: unknown, path: string, diagnostics: ReturnType<typeof issue>[], active = new Set<object>()): void {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    if (typeof value === "string" && !validUnicode(value)) diagnostics.push(issue("CONFIG_MALFORMED", "catalog.validate", path, "Use well-formed Unicode in immutable provider data."));
    return;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) diagnostics.push(issue("CONFIG_MALFORMED", "catalog.validate", path, "Use finite JSON numbers in immutable provider data."));
    return;
  }
  if (typeof value !== "object" || active.has(value)) {
    diagnostics.push(issue("CONFIG_MALFORMED", "catalog.validate", path, "Provider descriptor/catalog data must contain only acyclic JSON values."));
    return;
  }
  active.add(value);
  try {
    if (Array.isArray(value)) {
      for (let index = 0; index < value.length; index += 1) {
        if (!Object.prototype.hasOwnProperty.call(value, index)) {
          diagnostics.push(issue("CONFIG_MALFORMED", "catalog.validate", `${path}[${index}]`, "Provider descriptor/catalog arrays must not be sparse."));
          continue;
        }
        validateSerializable(value[index], `${path}[${index}]`, diagnostics, active);
      }
      return;
    }
    if (!isPlainRecord(value)) {
      diagnostics.push(issue("CONFIG_MALFORMED", "catalog.validate", path, "Provider descriptor/catalog data must use plain JSON objects."));
      return;
    }
    for (const [key, entry] of Object.entries(value)) validateSerializable(entry, `${path}.${key}`, diagnostics, active);
  } finally {
    active.delete(value);
  }
}

function validateAgentSource(
  source: unknown,
  providerId: string,
  path: string,
  diagnostics: ReturnType<typeof issue>[],
): source is AgentSourceFingerprint {
  if (!isPlainRecord(source)) {
    diagnostics.push(issue("CONFIG_MALFORMED", "catalog.validate", path, "Declare a provider id, source fingerprint and registered names for every agent source."));
    return false;
  }
  ownKeysOnly(source, ["provider_id", "source_fingerprint", "registered_names"], path, diagnostics);
  const sourceProvider = source.provider_id;
  const sourceFingerprint = source.source_fingerprint;
  const registeredNames = identifierArray(source.registered_names, false) ? source.registered_names : undefined;
  const providerValid = isProviderId(sourceProvider);
  if (!providerValid) {
    diagnostics.push(issue("CONFIG_MALFORMED", "catalog.validate", `${path}.provider_id`, "Use the exact lowercase provider id for every agent source."));
  } else if (sourceProvider !== providerId) {
    diagnostics.push(issue("IDENTITY_MISMATCH", "catalog.validate", `${path}.provider_id`, "Use the descriptor provider id for every source fingerprint.", { provider_id: providerId }));
  }
  const sourceFingerprintValid = isWorkflowV2Digest(sourceFingerprint);
  if (!sourceFingerprintValid) {
    diagnostics.push(issue("CONFIG_MALFORMED", "catalog.validate", `${path}.source_fingerprint`, "Use a sha256:<64 lowercase hex> source fingerprint."));
  }
  if (registeredNames === undefined) {
    diagnostics.push(issue("CONFIG_MALFORMED", "catalog.validate", `${path}.registered_names`, "Use one or more bounded registered agent names."));
  } else if (new Set(registeredNames).size !== registeredNames.length) {
    diagnostics.push(issue("AGENT_COLLISION", "agent.preflight", `${path}.registered_names`, "Remove duplicate registered names from one source."));
  }
  return providerValid
    && sourceProvider === providerId
    && sourceFingerprintValid
    && registeredNames !== undefined;
}


function validateAgentRef(
  value: unknown,
  providerId: string,
  path: string,
  diagnostics: ReturnType<typeof issue>[],
): value is AgentRef {
  if (!isPlainRecord(value)) {
    diagnostics.push(issue("CONFIG_MALFORMED", "catalog.validate", path, "Declare a provider-qualified registered agent reference."));
    return false;
  }
  ownKeysOnly(value, ["registered_name", "provider_id", "source_fingerprint"], path, diagnostics);
  const registeredNameValid = safeIdentifier(value.registered_name);
  if (!registeredNameValid) {
    diagnostics.push(issue("CONFIG_MALFORMED", "catalog.validate", `${path}.registered_name`, "Use a bounded registered agent name."));
  }
  const referenceProviderValid = isProviderId(value.provider_id);
  if (!referenceProviderValid) {
    diagnostics.push(issue("CONFIG_MALFORMED", "catalog.validate", `${path}.provider_id`, "Use the exact lowercase provider id for every agent reference."));
  } else if (value.provider_id !== providerId) {
    diagnostics.push(issue("IDENTITY_MISMATCH", "catalog.validate", `${path}.provider_id`, "Use the descriptor provider id for every agent reference.", { provider_id: providerId }));
  }
  const sourceFingerprintValid = isWorkflowV2Digest(value.source_fingerprint);
  if (!sourceFingerprintValid) {
    diagnostics.push(issue("CONFIG_MALFORMED", "catalog.validate", `${path}.source_fingerprint`, "Use a sha256:<64 lowercase hex> source fingerprint."));
  }
  return registeredNameValid
    && referenceProviderValid
    && value.provider_id === providerId
    && sourceFingerprintValid;
}

function descriptorDiagnostics(value: unknown): ReturnType<typeof issue>[] {
  const diagnostics: ReturnType<typeof issue>[] = [];
  if (!isPlainRecord(value)) {
    diagnostics.push(issue("CONFIG_MALFORMED", "provider.lookup", "descriptor", "Publish a plain immutable provider descriptor."));
    return diagnostics;
  }
  ownKeysOnly(value, [
    "id",
    "protocol_version",
    "capabilities",
    "catalog_content_digest",
    "agent_sources",
    "executable_provenance",
    "defaults",
  ], "descriptor", diagnostics);
  if (!isProviderId(value.id)) diagnostics.push(issue("CONFIG_MALFORMED", "provider.lookup", "descriptor.id", "Use a lowercase package-qualified provider id."));
  const providerId = isProviderId(value.id) ? value.id : undefined;
  if (value.protocol_version !== 2) diagnostics.push(issue("UNSUPPORTED_SCHEMA", "provider.lookup", "descriptor.protocol_version", "Publish a protocol_version 2 provider descriptor."));
  const capabilities = identifierArray(value.capabilities, false) ? value.capabilities : undefined;
  if (capabilities === undefined) {
    diagnostics.push(issue("CONFIG_MALFORMED", "provider.lookup", "descriptor.capabilities", "Declare a non-empty unique provider capability list."));
  } else if (new Set(capabilities).size !== capabilities.length) {
    diagnostics.push(issue("CONFIG_MALFORMED", "provider.lookup", "descriptor.capabilities", "Remove duplicate provider capabilities."));
  }
  if (!isWorkflowV2Digest(value.catalog_content_digest)) diagnostics.push(issue("CONFIG_MALFORMED", "provider.lookup", "descriptor.catalog_content_digest", "Pin the descriptor to a sha256 catalog digest."));
  if (!isPlainRecord(value.executable_provenance)) {
    diagnostics.push(issue("CONFIG_MALFORMED", "provider.lookup", "descriptor.executable_provenance", "Declare immutable build and runtime fingerprints."));
  } else {
    ownKeysOnly(value.executable_provenance, ["build_fingerprint", "runtime_fingerprint"], "descriptor.executable_provenance", diagnostics);
    if (!isWorkflowV2Digest(value.executable_provenance.build_fingerprint)) diagnostics.push(issue("CONFIG_MALFORMED", "provider.lookup", "descriptor.executable_provenance.build_fingerprint", "Use a sha256:<64 lowercase hex> build fingerprint."));
    if (!isWorkflowV2Digest(value.executable_provenance.runtime_fingerprint)) diagnostics.push(issue("CONFIG_MALFORMED", "provider.lookup", "descriptor.executable_provenance.runtime_fingerprint", "Use a sha256:<64 lowercase hex> runtime fingerprint."));
  }
  const sources = Array.isArray(value.agent_sources) ? value.agent_sources : undefined;
  if (sources === undefined || sources.length === 0) {
    diagnostics.push(issue("CONFIG_MALFORMED", "provider.lookup", "descriptor.agent_sources", "Declare immutable provenance for each provider agent source."));
  } else {
    const names = new Map<string, { provider: string; source: WorkflowV2Digest }>();
    for (let index = 0; index < sources.length; index += 1) {
      const source: unknown = sources[index];
      if (!Object.prototype.hasOwnProperty.call(sources, index)) {
        diagnostics.push(issue("CONFIG_MALFORMED", "provider.lookup", `descriptor.agent_sources[${index}]`, "Provider source arrays must not be sparse."));
        continue;
      }
      const valid = validateAgentSource(source, providerId ?? "", `descriptor.agent_sources[${index}]`, diagnostics);
      if (!valid) continue;
      for (const name of source.registered_names) {
        const previous = names.get(name);
        if (previous && (previous.provider !== source.provider_id || previous.source !== source.source_fingerprint)) {
          diagnostics.push(issue("AGENT_COLLISION", "agent.preflight", "descriptor.agent_sources", "Do not publish incompatible identities for one registered agent name.", { provider_id: String(value.id) }));
        } else {
          names.set(name, { provider: source.provider_id, source: source.source_fingerprint });
        }
      }
    }
  }
  const defaults = value.defaults;
  if (!isPlainRecord(defaults)) {
    diagnostics.push(issue("CONFIG_MALFORMED", "provider.lookup", "descriptor.defaults", "Declare immutable descriptor defaults as a plain object."));
  } else {
    const defaultPath = "descriptor.defaults";
    ownKeysOnly(defaults, [
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
    ], defaultPath, diagnostics);
    if (defaults.roles !== undefined) {
      if (!isPlainRecord(defaults.roles)) {
        diagnostics.push(issue("CONFIG_MALFORMED", "catalog.validate", `${defaultPath}.roles`, "Declare provider-qualified role defaults."));
      } else {
        for (const [role, agent] of Object.entries(defaults.roles)) {
          if (!safeIdentifier(role)) diagnostics.push(issue("CONFIG_MALFORMED", "catalog.validate", `${defaultPath}.roles`, "Use bounded semantic role names."));
          if (agent !== null) validateAgentRef(agent, providerId ?? "", `${defaultPath}.roles.${role}`, diagnostics);
        }
      }
    }
    if (defaults.scope_map !== undefined) {
      if (!Array.isArray(defaults.scope_map)) {
        diagnostics.push(issue("CONFIG_MALFORMED", "catalog.validate", `${defaultPath}.scope_map`, "Declare an ordered scope map."));
      } else {
        for (let index = 0; index < defaults.scope_map.length; index += 1) {
          if (!Object.prototype.hasOwnProperty.call(defaults.scope_map, index)) {
            diagnostics.push(issue("CONFIG_MALFORMED", "catalog.validate", `${defaultPath}.scope_map[${index}]`, "Scope maps must not be sparse."));
            continue;
          }
          const rule: unknown = defaults.scope_map[index];
          if (!isPlainRecord(rule)) {
            diagnostics.push(issue("CONFIG_MALFORMED", "catalog.validate", `${defaultPath}.scope_map[${index}]`, "Declare a scope rule with qualified agent provenance."));
            continue;
          }
          if (Object.prototype.hasOwnProperty.call(rule, "dev_agent")) {
            validateAgentRef(rule.dev_agent, providerId ?? "", `${defaultPath}.scope_map[${index}].dev_agent`, diagnostics);
          }
        }
      }
    }
    const required = defaults.required_capabilities;
    const requiredCapabilities = required === undefined ? undefined : identifierArray(required, false) ? required : null;
    if (required !== undefined) {
      if (requiredCapabilities === null) {
        diagnostics.push(issue("CONFIG_MALFORMED", "catalog.validate", `${defaultPath}.required_capabilities`, "Use a non-empty list of bounded required capabilities."));
      } else if (requiredCapabilities !== undefined && new Set(requiredCapabilities).size !== requiredCapabilities.length) {
        diagnostics.push(issue("CONFIG_MALFORMED", "catalog.validate", `${defaultPath}.required_capabilities`, "Remove duplicate required capabilities."));
      }
    }
    if (!isDescriptorDefaultsValue(defaults, providerId ?? "")) {
      diagnostics.push(issue("CONFIG_MALFORMED", "catalog.validate", defaultPath, "Declare descriptor defaults using the immutable provider defaults contract."));
    }
  }
  validateSerializable(value, "descriptor", diagnostics);
  return diagnostics;
}

function cloneImmutable(value: unknown): unknown {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return Object.freeze(value.map((entry) => cloneImmutable(entry)));
  if (!isPlainRecord(value)) throw new TypeError("immutable data must contain only plain objects and arrays");
  const clone: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) clone[key] = cloneImmutable(entry);
  return Object.freeze(clone);
}

function sourceIdentityKey(source: AgentSourceFingerprint): string {
  return canonicalImmutableJson([source.provider_id, source.source_fingerprint]);
}

function sourceSort(left: AgentSourceFingerprint, right: AgentSourceFingerprint): number {
  const provider = compareCanonicalKeys(left.provider_id, right.provider_id);
  if (provider !== 0) return provider;
  const fingerprint = compareCanonicalKeys(left.source_fingerprint, right.source_fingerprint);
  if (fingerprint !== 0) return fingerprint;
  return compareCanonicalKeys(left.registered_names.join("\u0000"), right.registered_names.join("\u0000"));
}

function canonicalAgentSources(sources: readonly AgentSourceFingerprint[]): readonly AgentSourceFingerprint[] {
  const unique = new Map<string, { provider_id: AgentSourceFingerprint["provider_id"]; source_fingerprint: AgentSourceFingerprint["source_fingerprint"]; registered_names: Set<string> }>();
  for (const source of sources) {
    const key = sourceIdentityKey(source);
    const existing = unique.get(key);
    if (existing) {
      for (const name of source.registered_names) existing.registered_names.add(name);
      continue;
    }
    unique.set(key, {
      provider_id: source.provider_id,
      source_fingerprint: source.source_fingerprint,
      registered_names: new Set(source.registered_names),
    });
  }
  const normalized = [...unique.values()]
    .map((source) => Object.freeze({
      provider_id: source.provider_id,
      source_fingerprint: source.source_fingerprint,
      registered_names: Object.freeze([...source.registered_names].sort(compareCanonicalKeys)),
    }))
    .sort(sourceSort);
  return Object.freeze(normalized);
}

/** Validate and deep-freeze a provider descriptor without retaining caller mutability. */
export function validateProviderDescriptor(value: unknown): DiagnosticResult<Readonly<ProviderDescriptor>> {
  const diagnostics = descriptorDiagnostics(value);
  if (diagnostics.length > 0) return failureResult(diagnostics);
  if (!isProviderDescriptorValue(value)) {
    return failureResult(issue("CONFIG_MALFORMED", "provider.lookup", "descriptor", "Publish a complete provider descriptor matching the v2 contract."));
  }
  const descriptor: ProviderDescriptor = {
    id: value.id,
    protocol_version: 2,
    capabilities: Object.freeze([...value.capabilities]),
    catalog_content_digest: value.catalog_content_digest,
    agent_sources: canonicalAgentSources(value.agent_sources),
    executable_provenance: Object.freeze({
      build_fingerprint: value.executable_provenance.build_fingerprint,
      runtime_fingerprint: value.executable_provenance.runtime_fingerprint,
    }),
    defaults: value.defaults,
  };
  const cloned = cloneImmutable(descriptor);
  if (!isProviderDescriptorValue(cloned)) {
    return failureResult(issue("CONFIG_MALFORMED", "provider.lookup", "descriptor", "Publish a complete immutable provider descriptor."));
  }
  return successResult(Object.freeze(cloned));
}

/** Compute a descriptor identity digest over every immutable descriptor field. */
export function computeDescriptorFingerprint(descriptor: Readonly<ProviderDescriptor>): WorkflowV2Digest {
  return digestImmutable({
    id: descriptor.id,
    protocol_version: descriptor.protocol_version,
    capabilities: descriptor.capabilities,
    catalog_content_digest: descriptor.catalog_content_digest,
    agent_sources: canonicalAgentSources(descriptor.agent_sources),
    executable_provenance: descriptor.executable_provenance,
    defaults: descriptor.defaults,
  });
}

function profileIdentityDiagnostics(profile: unknown, path: string, diagnostics: ReturnType<typeof issue>[]): profile is CatalogProfile {
  if (!isPlainRecord(profile)) {
    diagnostics.push(issue("CONFIG_MALFORMED", "catalog.validate", path, "Declare a profile identity and immutable profile value."));
    return false;
  }
  ownKeysOnly(profile, ["identity", "profile"], path, diagnostics);
  const identity = profile.identity;
  const identityRecord = isPlainRecord(identity);
  let identityValid = false;
  if (!identityRecord) {
    diagnostics.push(issue("CONFIG_MALFORMED", "catalog.validate", `${path}.identity`, "Declare a profile id and content fingerprint."));
  } else {
    ownKeysOnly(identity, ["id", "fingerprint"], `${path}.identity`, diagnostics);
    const identityIdValid = safeIdentifier(identity.id);
    const identityFingerprint = isWorkflowV2Digest(identity.fingerprint) ? identity.fingerprint : undefined;
    if (!identityIdValid) diagnostics.push(issue("CONFIG_MALFORMED", "catalog.validate", `${path}.identity.id`, "Use a bounded profile id."));
    if (identityFingerprint === undefined) diagnostics.push(issue("CONFIG_MALFORMED", "catalog.validate", `${path}.identity.fingerprint`, "Use a sha256:<64 lowercase hex> profile fingerprint."));
    identityValid = Object.prototype.hasOwnProperty.call(identity, "id")
      && Object.prototype.hasOwnProperty.call(identity, "fingerprint")
      && hasExactKeys(identity, ["id", "fingerprint"])
      && identityIdValid
      && identityFingerprint !== undefined;
  }
  const profileValue = profile.profile;
  const workflowProfileValid = isWorkflowProfileValue(profileValue);
  if (!workflowProfileValid) {
    diagnostics.push(issue("CONFIG_MALFORMED", "catalog.validate", `${path}.profile`, "Declare a named workflow profile with match metadata and ordered stages."));
  } else if (identityRecord && safeIdentifier(identity.id) && profileValue.name !== identity.id) {
    diagnostics.push(issue("IDENTITY_MISMATCH", "catalog.validate", `${path}.profile.name`, "Profile identity id must equal the immutable profile name.", { profile_id: String(identity.id) }));
  }
  if (workflowProfileValid && identityRecord && isWorkflowV2Digest(identity.fingerprint)) {
    try {
      const actual = computeProfileContentDigest(profileValue);
      if (actual !== identity.fingerprint) diagnostics.push(issue("IDENTITY_MISMATCH", "catalog.validate", `${path}.identity.fingerprint`, "Recompute the profile fingerprint from the exact immutable profile value.", { expected_digest: String(identity.fingerprint), actual_digest: actual }));
    } catch {
      diagnostics.push(issue("CONFIG_MALFORMED", "catalog.validate", `${path}.profile`, "Profile content must be canonical immutable JSON."));
    }
  }
  validateSerializable(profile, path, diagnostics);
  return identityValid
    && workflowProfileValid
    && Object.prototype.hasOwnProperty.call(profile, "identity")
    && Object.prototype.hasOwnProperty.call(profile, "profile")
    && hasExactKeys(profile, ["identity", "profile"]);
}

function isCatalogProfileArray(value: Pick<ProviderCatalog, "profiles"> | readonly CatalogProfile[]): value is readonly CatalogProfile[] {
  return Array.isArray(value);
}

/** Compute a catalog digest without recursively including its content_digest field. */
export function computeCatalogContentDigest(input: Pick<ProviderCatalog, "profiles"> | readonly CatalogProfile[]): WorkflowV2Digest {
  const profiles = isCatalogProfileArray(input) ? input : input.profiles;
  return digestImmutable({ profiles });
}


/** Validate profile identities, profile bytes and the catalog content digest. */
export function validateProviderCatalog(value: unknown): DiagnosticResult<Readonly<ProviderCatalog>> {
  const diagnostics: ReturnType<typeof issue>[] = [];
  if (!isPlainRecord(value)) {
    return failureResult(issue("CONFIG_MALFORMED", "catalog.validate", "catalog", "Publish a plain immutable provider catalog."));
  }
  ownKeysOnly(value, ["content_digest", "profiles"], "catalog", diagnostics);
  const contentDigest = isWorkflowV2Digest(value.content_digest) ? value.content_digest : undefined;
  if (contentDigest === undefined) diagnostics.push(issue("CONFIG_MALFORMED", "catalog.validate", "catalog.content_digest", "Use a sha256:<64 lowercase hex> catalog digest."));
  const profiles = Array.isArray(value.profiles) ? value.profiles : undefined;
  const validProfiles: CatalogProfile[] = [];
  let allProfilesValid = profiles !== undefined;
  if (profiles === undefined) {
    diagnostics.push(issue("CONFIG_MALFORMED", "catalog.validate", "catalog.profiles", "Declare an ordered profile catalog."));
  } else {
    const ids = new Set<string>();
    for (let index = 0; index < profiles.length; index += 1) {
      if (!Object.prototype.hasOwnProperty.call(profiles, index)) {
        allProfilesValid = false;
        diagnostics.push(issue("CONFIG_MALFORMED", "catalog.validate", `catalog.profiles[${index}]`, "Provider profile catalogs must not be sparse."));
        continue;
      }
      const profile: unknown = profiles[index];
      if (profileIdentityDiagnostics(profile, `catalog.profiles[${index}]`, diagnostics)) {
        validProfiles.push(profile);
        if (ids.has(profile.identity.id)) diagnostics.push(issue("CONFIG_MALFORMED", "catalog.validate", "catalog.profiles", "Do not publish duplicate profile ids."));
        ids.add(profile.identity.id);
      } else {
        allProfilesValid = false;
      }
    }
    if (allProfilesValid && contentDigest !== undefined) {
      try {
        const actual = computeCatalogContentDigest(validProfiles);
        if (actual !== contentDigest) {
          diagnostics.push(issue("IDENTITY_MISMATCH", "catalog.validate", "catalog.content_digest", "Recompute the catalog content digest from ordered immutable profiles.", { expected_digest: contentDigest, actual_digest: actual }));
        }
      } catch {
        // Detailed serializability diagnostics below identify malformed values.
      }
    }
  }
  validateSerializable(value, "catalog", diagnostics);
  if (diagnostics.length > 0 || contentDigest === undefined || !allProfilesValid) return failureResult(diagnostics);
  const catalog: ProviderCatalog = { content_digest: contentDigest, profiles: validProfiles };
  const cloned = cloneImmutable(catalog);
  if (!isProviderCatalogValue(cloned)) {
    return failureResult(issue("CONFIG_MALFORMED", "catalog.validate", "catalog", "Publish a complete immutable provider catalog."));
  }
  return successResult(Object.freeze(cloned));
}

/** Ensure observed OMP agents retain provider/source provenance. */
export function buildProviderAgentInventory(descriptor: Readonly<ProviderDescriptor>): readonly AgentRef[] {
  const inventory: AgentRef[] = [];
  const names = new Set<string>();
  for (const source of canonicalAgentSources(descriptor.agent_sources)) {
    for (const registered_name of source.registered_names) {
      if (names.has(registered_name)) continue;
      names.add(registered_name);
      inventory.push(Object.freeze({
        registered_name,
        provider_id: source.provider_id,
        source_fingerprint: source.source_fingerprint,
      }));
    }
  }
  return Object.freeze(inventory);
}


/** Validate an inventory against descriptor-owned source fingerprints. */
export function validateProviderAgentInventory(
  descriptor: Readonly<ProviderDescriptor>,
  inventory: readonly AgentRef[],
): DiagnosticResult<readonly AgentRef[]> {
  const preflight = preflightAgentInventory(inventory);
  if (!preflight.ok) return preflight;
  const sourceByName = new Map<string, { provider_id: string; source_fingerprint: string }>();
  for (const source of canonicalAgentSources(descriptor.agent_sources)) {
    for (const registered_name of source.registered_names) sourceByName.set(registered_name, source);
  }
  const diagnostics: ReturnType<typeof issue>[] = [];
  for (const agent of preflight.value) {
    const source = sourceByName.get(agent.registered_name);
    if (!source || source.provider_id !== agent.provider_id || source.source_fingerprint !== agent.source_fingerprint) {
      diagnostics.push(issue("IDENTITY_MISMATCH", "agent.preflight", "agent_inventory", "Use provider-qualified agent identities from the selected descriptor source catalog.", { provider_id: descriptor.id, source_fingerprint: agent.source_fingerprint }));
    }
  }
  return diagnostics.length > 0 ? failureResult(diagnostics) : successResult(preflight.value);
}

/**
 * The descriptor module owns this declaration so registry and host consumers
 * can preflight an arbitrary mixed inventory without executing provider code.
 */
export function preflightAgentInventory(inventory: readonly AgentRef[]): DiagnosticResult<readonly AgentRef[]> {
  const diagnostics: ReturnType<typeof issue>[] = [];
  const byName = new Map<string, AgentRef>();
  for (const [index, agent] of inventory.entries()) {
    if (!isPlainRecord(agent)
      || Object.keys(agent).length !== 3
      || !Object.keys(agent).every((key) => ["registered_name", "provider_id", "source_fingerprint"].includes(key))
      || !safeIdentifier(agent.registered_name)
      || !isProviderId(agent.provider_id)
      || !isWorkflowV2Digest(agent.source_fingerprint)) {
      diagnostics.push(issue("CONFIG_MALFORMED", "agent.preflight", `inventory[${index}]`, "Provide a registered name, lowercase provider id and source fingerprint for every agent."));
      continue;
    }
    const normalized = Object.freeze({
      registered_name: agent.registered_name,
      provider_id: agent.provider_id,
      source_fingerprint: agent.source_fingerprint,
    });
    const existing = byName.get(normalized.registered_name);
    if (existing && (existing.provider_id !== normalized.provider_id || existing.source_fingerprint !== normalized.source_fingerprint)) {
      diagnostics.push(issue("AGENT_COLLISION", "agent.preflight", "inventory", "Resolve every registered agent name to one provider/source identity before dispatch."));
      continue;
    }
    if (!existing) byName.set(normalized.registered_name, normalized);
  }
  if (diagnostics.length > 0) return failureResult(diagnostics);
  return successResult(Object.freeze([...byName.values()]));
}
