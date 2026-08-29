/** Strict, portable workflow-v2 policy reader, hasher, merger and writer. */
/* <!-- omp-cto-slice run=01a03ee4-7dd6-7580-8ad7-16d26dc886ba slice=workflow-v2-core --> */

import { createHash } from "node:crypto";
import { join } from "node:path";

import {
  byteLength,
  decodeStrictUtf8,
  parseStrictJsonValue,
  StrictJsonError,
  validateStringLimits,
  type StrictJsonLimits,
} from "./strict-json.js";
import {
  readTransactionStatusFromPinned,
  runTransactionReadHook,
  transactionReadAllowed,
  TRANSACTION_READ_AUTHORITY,
  type TransactionStatus,
} from "./transaction.js";
import {
  isTrustedFsAuthority,
  type FsAuthorityFailure,
  type FsTargetFingerprint,
  type PinnedFsRoot,
  type TrustedFsAuthority,
} from "./fs-authority.js";


import {
  createDiagnostic,
  failureResult,
  successResult,
} from "./diagnostics.js";
import {
  createCanonicalRoot,
  isCanonicalRoot,
  isProviderId,
  isWorkflowV2Digest,
} from "./identity.js";
import type {
  AgentRef,
  CanonicalRoot,
  CommandPolicy,
  DescriptorDefaults,
  DiagnosticResult,
  EffectivePolicy,
  PolicyReadResult,
  PolicyPrecondition,
  PolicyDocument,
  PolicyFragment,
  PolicySnapshot,
  ProfileIdentity,
  ProviderDescriptor,
  RosterOverride,
  RosterPatch,
  ScopePatch,
  ScopeRule,
  WorkflowPolicy,
  WorkflowSelection,
  WorkflowV2Digest,
  WorkflowV2Diagnostic,
} from "./types.js";
export const POLICY_SCHEMA_VERSION = 2 as const;
export const POLICY_RELATIVE_PATH = ".omp/team.config.json" as const;
export const POLICY_MAX_BYTES = 262_144;
export const POLICY_MAX_DEPTH = 16;
export const POLICY_MAX_KEYS = 2_048;
export const POLICY_MAX_ITEMS = 2_048;
export const POLICY_MAX_STRING_BYTES = 4_096;
export const POLICY_MAX_FRAGMENT_BYTES = 2_048;
export const POLICY_MAX_COMMAND_FRAGMENT_BYTES = 8_192;
export const POLICY_MAX_COMMAND_FRAGMENTS = 64;

export { parseStrictJsonValue };

const POLICY_TOP_LEVEL_KEYS = ["schema_version", "provider", "policy"] as const;
const POLICY_PROVIDER_KEYS = [
  "id",
  "protocol_version",
  "descriptor_fingerprint",
  "catalog_content_digest",
] as const;
const POLICY_KEYS = [
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
const AGENT_REF_KEYS = ["registered_name", "provider_id", "source_fingerprint"] as const;
const SCOPE_RULE_KEYS = ["patterns", "scope", "dev_agent", "runtime_class", "ui_class"] as const;
const ROSTER_VALUE_KEYS = ["replace", "add", "remove"] as const;
const FRAGMENT_KEYS = ["id", "text", "owner"] as const;
const FRAGMENT_OWNER_KEYS = ["kind", "source"] as const;
const PROMPT_ENTRY_KEYS = ["id", "type", "value"] as const;
const PROFILE_KEYS = ["id", "fingerprint"] as const;
const WORKFLOW_MATRIX_KEYS = ["selection"] as const;
const WORKFLOW_FIXED_KEYS = ["selection", "profile_identity"] as const;
const COMMAND_KEYS = ["fragments"] as const;
const ALIAS_KEYS = ["alias_of"] as const;

const IDENTIFIER_PATTERN = /^[A-Za-z0-9@._:/#-]+$/u;
const CAPABILITY_PATTERN = /^[A-Za-z][A-Za-z0-9@._:/#-]*$/u;

const JSON_LIMITS: StrictJsonLimits = {
  maxDepth: POLICY_MAX_DEPTH,
  maxKeys: POLICY_MAX_KEYS,
  maxItems: POLICY_MAX_ITEMS,
  maxStringBytes: POLICY_MAX_STRING_BYTES,
};

function hasValidUnicodeScalars(value: string): boolean {
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

function hasAllowedControls(value: string): boolean {
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    if (code < 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d) return false;
    if (code >= 0x7f && code <= 0x9f) return false;
  }
  return true;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}





function compareCanonicalKeys(left: string, right: string): number {
  const length = Math.min(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    const delta = left.charCodeAt(index) - right.charCodeAt(index);
    if (delta !== 0) return delta;
  }
  return left.length - right.length;
}

/** RFC 8785/JCS canonical JSON for already validated JSON values. */
export function canonicalPolicyJson(value: unknown): string {
  const active = new Set<object>();
  const encode = (entry: unknown): string => {
    if (entry === null) return "null";
    if (typeof entry === "string") {
      if (!validateStringLimits(entry)) throw new TypeError("invalid JSON string");
      return JSON.stringify(entry);
    }
    if (typeof entry === "boolean") return entry ? "true" : "false";
    if (typeof entry === "number") {
      if (!Number.isFinite(entry)) throw new TypeError("non-finite JSON number");
      return Object.is(entry, -0) ? "0" : JSON.stringify(entry);
    }
    if (typeof entry !== "object") throw new TypeError("non-JSON value");
    if (active.has(entry)) throw new TypeError("cyclic JSON value");
    active.add(entry);
    try {
      if (Array.isArray(entry)) {
        const encoded: string[] = [];
        for (let index = 0; index < entry.length; index += 1) {
          if (!Object.prototype.hasOwnProperty.call(entry, index)) throw new TypeError("sparse JSON array");
          encoded.push(encode(entry[index]));
        }
        return `[${encoded.join(",")}]`;
      }
      if (!isPlainRecord(entry)) throw new TypeError("non-plain JSON object");
      const keys = Object.keys(entry).sort(compareCanonicalKeys);
      return `{${keys.map((key) => `${JSON.stringify(key)}:${encode(entry[key])}`).join(",")}}`;
    } finally {
      active.delete(entry);
    }
  };
  return encode(value);
}

function bytesForInput(input: Uint8Array | string): Buffer {
  return decodeStrictUtf8(input).bytes;
}

/** SHA-256 over exact physical bytes, including any legal whitespace. */
export function computePolicyByteHash(input: Uint8Array | string): WorkflowV2Digest {
  const bytes = bytesForInput(input);
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

/** SHA-256 over the RFC 8785/JCS semantic policy document. */
export function computePolicySemanticHash(document: PolicyDocument): WorkflowV2Digest {
  return `sha256:${createHash("sha256").update(canonicalPolicyJson(document), "utf8").digest("hex")}`;
}

function safeEvidenceField(path: string): string {
  return path.replace(/[^A-Za-z0-9@._:/#-]/gu, "_").slice(0, 256) || "policy";
}

function policyDiagnostic(
  code: "ROOT_UNAVAILABLE" | "CONFIG_MALFORMED" | "UNSUPPORTED_SCHEMA" | "CONFIG_MISSING" | "UNSAFE_PATH" | "IDENTITY_MISMATCH" | "BINDING_REQUIRED" | "PROFILE_UNAVAILABLE" | "TRANSACTION_INCOMPLETE" | "ACTIVATION_FAILED",
  operation: "policy.read" | "policy.write" | "root.resolve",
  field: string,
  remediation: string,
  evidence: Record<string, unknown> = {},
) {
  return createDiagnostic({
    code,
    operation,
    evidence: { field: safeEvidenceField(field), ...evidence },
    remediation,
  });
}

function ownKeysOnly(
  value: Record<string, unknown>,
  allowed: readonly string[],
  path: string,
  diagnostics: ReturnType<typeof policyDiagnostic>[],
  required = false,
): void {
  const allowedSet = new Set(allowed);
  for (const key of Object.keys(value)) {
    if (!allowedSet.has(key)) diagnostics.push(policyDiagnostic("CONFIG_MALFORMED", "policy.read", `${path}.${key}`, "Remove unknown keys from the strict v2 policy."));
  }
  if (required) requireKeys(value, allowed, path, diagnostics);
}

function requireKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  path: string,
  diagnostics: ReturnType<typeof policyDiagnostic>[],
): void {
  for (const key of required) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) {
      diagnostics.push(policyDiagnostic("CONFIG_MALFORMED", "policy.read", `${path}.${key}`, "Provide every required strict v2 policy field."));
    }
  }
}

function validPattern(value: unknown): value is string {
  return typeof value === "string"
    && value.length > 0
    && value === value.trim()
    && validateStringLimits(value, POLICY_MAX_STRING_BYTES);
}


function validIdentifier(value: unknown, maxBytes = 256): value is string {
  return typeof value === "string"
    && value.length > 0
    && value === value.trim()
    && byteLength(value) <= maxBytes
    && hasValidUnicodeScalars(value)
    && hasAllowedControls(value)
    && IDENTIFIER_PATTERN.test(value);
}

function validCapability(value: unknown): value is string {
  return typeof value === "string"
    && value.length > 0
    && value.length <= 256
    && value === value.trim()
    && validateStringLimits(value, 256)
    && CAPABILITY_PATTERN.test(value);
}

function validateProfileIdentity(value: unknown, path: string, diagnostics: ReturnType<typeof policyDiagnostic>[]): value is ProfileIdentity {
  if (!isPlainRecord(value)) {
    diagnostics.push(policyDiagnostic("CONFIG_MALFORMED", "policy.read", path, "Use an exact profile identity object."));
    return false;
  }
  ownKeysOnly(value, PROFILE_KEYS, path, diagnostics, true);
  requireKeys(value, PROFILE_KEYS, path, diagnostics);
  if (!validIdentifier(value.id)) diagnostics.push(policyDiagnostic("CONFIG_MALFORMED", "policy.read", `${path}.id`, "Use a bounded profile id."));
  if (!isWorkflowV2Digest(value.fingerprint)) diagnostics.push(policyDiagnostic("CONFIG_MALFORMED", "policy.read", `${path}.fingerprint`, "Use a sha256:<64 lowercase hex> profile fingerprint."));
  return true;
}

function validateAgentRef(
  value: unknown,
  providerId: string,
  path: string,
  diagnostics: ReturnType<typeof policyDiagnostic>[],
): value is AgentRef {
  if (!isPlainRecord(value)) {
    diagnostics.push(policyDiagnostic("CONFIG_MALFORMED", "policy.read", path, "Use a provider-qualified agent reference or null."));
    return false;
  }
  ownKeysOnly(value, AGENT_REF_KEYS, path, diagnostics, true);
  if (!validIdentifier(value.registered_name)) diagnostics.push(policyDiagnostic("CONFIG_MALFORMED", "policy.read", `${path}.registered_name`, "Use a bounded provider-qualified registered agent name."));
  if (!isProviderId(value.provider_id)) diagnostics.push(policyDiagnostic("CONFIG_MALFORMED", "policy.read", `${path}.provider_id`, "Use the exact lowercase provider id."));
  else if (value.provider_id !== providerId) diagnostics.push(policyDiagnostic("IDENTITY_MISMATCH", "policy.read", `${path}.provider_id`, "Use an agent source owned by the selected provider.", { provider_id: providerId }));
  if (!isWorkflowV2Digest(value.source_fingerprint)) diagnostics.push(policyDiagnostic("CONFIG_MALFORMED", "policy.read", `${path}.source_fingerprint`, "Use a sha256:<64 lowercase hex> source fingerprint."));
  return true;
}

function validateStringArray(
  value: unknown,
  path: string,
  diagnostics: ReturnType<typeof policyDiagnostic>[],
  allowEmpty = true,
  predicate: (candidate: unknown) => boolean = (candidate) => validIdentifier(candidate, POLICY_MAX_STRING_BYTES),
): value is readonly string[] {
  if (!Array.isArray(value) || (!allowEmpty && value.length === 0)) {
    diagnostics.push(policyDiagnostic("CONFIG_MALFORMED", "policy.read", path, "Use an array of bounded strings."));
    return false;
  }
  value.forEach((entry, index) => {
    if (!predicate(entry)) diagnostics.push(policyDiagnostic("CONFIG_MALFORMED", "policy.read", `${path}[${index}]`, "Use bounded non-empty string values."));
  });
  return true;
}
function validateScopeRule(
  value: unknown,
  providerId: string,
  path: string,
  diagnostics: ReturnType<typeof policyDiagnostic>[],
): value is ScopeRule {
  if (!isPlainRecord(value)) {
    diagnostics.push(policyDiagnostic("CONFIG_MALFORMED", "policy.read", path, "Use a scope rule object."));
    return false;
  }
  ownKeysOnly(value, SCOPE_RULE_KEYS, path, diagnostics);
  requireKeys(value, ["patterns", "scope", "dev_agent"], path, diagnostics);
  validateStringArray(value.patterns, `${path}.patterns`, diagnostics, false, validPattern);
  if (!validIdentifier(value.scope)) diagnostics.push(policyDiagnostic("CONFIG_MALFORMED", "policy.read", `${path}.scope`, "Use a bounded scope id."));
  validateAgentRef(value.dev_agent, providerId, `${path}.dev_agent`, diagnostics);
  for (const key of ["runtime_class", "ui_class"] as const) {
    const candidate = value[key];
    if (candidate !== undefined && candidate !== null && typeof candidate !== "boolean" && !validIdentifier(candidate)) {
      diagnostics.push(policyDiagnostic("CONFIG_MALFORMED", "policy.read", `${path}.${key}`, "Use null, boolean, or a bounded class identifier."));
    }
  }
  return true;
}


function validateScopePatches(
  value: unknown,
  providerId: string,
  diagnostics: ReturnType<typeof policyDiagnostic>[],
): value is readonly ScopePatch[] {
  if (!Array.isArray(value)) {
    diagnostics.push(policyDiagnostic("CONFIG_MALFORMED", "policy.read", "policy.scope_map", "Use an ordered scope patch array."));
    return false;
  }
  const ids = new Set<string>();
  value.forEach((entry, index) => {
    const path = `policy.scope_map[${index}]`;
    if (!isPlainRecord(entry)) {
      diagnostics.push(policyDiagnostic("CONFIG_MALFORMED", "policy.read", path, "Use a scope patch object."));
      return;
    }
    const op = entry.op;
    const allowed = op === "add"
      ? ["op", "id", "rule", "before"]
      : op === "replace"
        ? ["op", "id", "rule"]
        : op === "remove"
          ? ["op", "id"]
          : ["op", "id"];
    ownKeysOnly(entry, allowed, path, diagnostics);
    requireKeys(entry, op === "remove" ? ["op", "id"] : ["op", "id", "rule"], path, diagnostics);
    if (op !== "replace" && op !== "add" && op !== "remove") {
      diagnostics.push(policyDiagnostic("CONFIG_MALFORMED", "policy.read", `${path}.op`, "Use replace, add, or remove scope patches."));
      return;
    }
    if (!validIdentifier(entry.id)) diagnostics.push(policyDiagnostic("CONFIG_MALFORMED", "policy.read", `${path}.id`, "Use a unique bounded scope patch id."));
    else if (ids.has(entry.id)) diagnostics.push(policyDiagnostic("CONFIG_MALFORMED", "policy.read", `${path}.id`, "Use unique scope patch ids."));
    else ids.add(entry.id);
    if (op === "remove") return;
    validateScopeRule(entry.rule, providerId, `${path}.rule`, diagnostics);
    if (op === "add" && entry.before !== undefined && !validIdentifier(entry.before)) diagnostics.push(policyDiagnostic("CONFIG_MALFORMED", "policy.read", `${path}.before`, "Use a bounded existing scope patch id."));
  });
  return true;
}
function validateRosterPatches(value: unknown, diagnostics: ReturnType<typeof policyDiagnostic>[]): value is readonly RosterPatch[] {
  if (!Array.isArray(value)) {
    diagnostics.push(policyDiagnostic("CONFIG_MALFORMED", "policy.read", "policy.roster_overrides", "Use an ordered roster patch array."));
    return false;
  }
  const ids = new Set<string>();
  value.forEach((entry, index) => {
    const path = `policy.roster_overrides[${index}]`;
    if (!isPlainRecord(entry)) {
      diagnostics.push(policyDiagnostic("CONFIG_MALFORMED", "policy.read", path, "Use a roster patch object."));
      return;
    }
    const op = entry.op;
    const allowed = op === "add"
      ? ["op", "id", "value", "before"]
      : op === "replace"
        ? ["op", "id", "value"]
        : op === "remove"
          ? ["op", "id"]
          : ["op", "id"];
    ownKeysOnly(entry, allowed, path, diagnostics);
    requireKeys(entry, op === "remove" ? ["op", "id"] : ["op", "id", "value"], path, diagnostics);
    if (op !== "replace" && op !== "add" && op !== "remove") {
      diagnostics.push(policyDiagnostic("CONFIG_MALFORMED", "policy.read", `${path}.op`, "Use replace, add, or remove roster patches."));
      return;
    }
    if (!validIdentifier(entry.id)) diagnostics.push(policyDiagnostic("CONFIG_MALFORMED", "policy.read", `${path}.id`, "Use a unique bounded roster patch id."));
    else if (ids.has(entry.id)) diagnostics.push(policyDiagnostic("CONFIG_MALFORMED", "policy.read", `${path}.id`, "Use unique roster patch ids."));
    else ids.add(entry.id);
    if (op === "remove") return;
    validateRosterValue(entry.value, `${path}.value`, diagnostics);
    if (op === "add" && entry.before !== undefined && !validIdentifier(entry.before)) diagnostics.push(policyDiagnostic("CONFIG_MALFORMED", "policy.read", `${path}.before`, "Use a bounded existing roster patch id."));
  });
  return true;
}

function validateRosterValue(value: unknown, path: string, diagnostics: ReturnType<typeof policyDiagnostic>[]): value is RosterOverride {
  if (!isPlainRecord(value)) {
    diagnostics.push(policyDiagnostic("CONFIG_MALFORMED", "policy.read", path, "Use a roster override object."));
    return false;
  }
  ownKeysOnly(value, ROSTER_VALUE_KEYS, path, diagnostics);
  for (const key of ROSTER_VALUE_KEYS) {
    if (value[key] !== undefined) validateStringArray(value[key], `${path}.${key}`, diagnostics);
  }
  return true;
}


function validateMapValues(
  value: unknown,
  path: string,
  diagnostics: ReturnType<typeof policyDiagnostic>[],
  predicate: (candidate: unknown) => boolean,
): value is Record<string, unknown> {
  if (!isPlainRecord(value)) {
    diagnostics.push(policyDiagnostic("CONFIG_MALFORMED", "policy.read", path, "Use a JSON object map."));
    return false;
  }
  for (const [key, candidate] of Object.entries(value)) {
    if (!validIdentifier(key, POLICY_MAX_STRING_BYTES)) diagnostics.push(policyDiagnostic("CONFIG_MALFORMED", "policy.read", `${path}.${key}`, "Use bounded identifier map keys."));
    if (!predicate(candidate)) diagnostics.push(policyDiagnostic("CONFIG_MALFORMED", "policy.read", `${path}.${key}`, "Use a value matching the strict v2 policy schema."));
  }
  return true;
}

function validateFragments(
  value: unknown,
  path: string,
  allFragmentIds: Set<string>,
  diagnostics: ReturnType<typeof policyDiagnostic>[],
): value is readonly PolicyFragment[] {
  if (!Array.isArray(value) || value.length > POLICY_MAX_COMMAND_FRAGMENTS) {
    diagnostics.push(policyDiagnostic("CONFIG_MALFORMED", "policy.read", path, "Use at most 64 bounded command fragments."));
    return false;
  }
  let totalBytes = 0;
  value.forEach((entry, index) => {
    const fragmentPath = `${path}[${index}]`;
    if (!isPlainRecord(entry)) {
      diagnostics.push(policyDiagnostic("CONFIG_MALFORMED", "policy.read", fragmentPath, "Use a command fragment object."));
      return;
    }
    ownKeysOnly(entry, FRAGMENT_KEYS, fragmentPath, diagnostics, true);
    if (!validIdentifier(entry.id)) diagnostics.push(policyDiagnostic("CONFIG_MALFORMED", "policy.read", `${fragmentPath}.id`, "Use a unique bounded fragment id."));
    else if (allFragmentIds.has(entry.id)) diagnostics.push(policyDiagnostic("CONFIG_MALFORMED", "policy.read", `${fragmentPath}.id`, "Use unique fragment ids across commands."));
    else allFragmentIds.add(entry.id);
    if (typeof entry.text !== "string" || !validateStringLimits(entry.text, POLICY_MAX_FRAGMENT_BYTES)) {
      diagnostics.push(policyDiagnostic("CONFIG_MALFORMED", "policy.read", `${fragmentPath}.text`, "Use bounded UTF-8 literal fragment text."));
    } else {
      totalBytes += byteLength(entry.text);
    }
    if (!isPlainRecord(entry.owner)) {
      diagnostics.push(policyDiagnostic("CONFIG_MALFORMED", "policy.read", `${fragmentPath}.owner`, "Use the project-policy fragment owner."));
    } else {
      ownKeysOnly(entry.owner, FRAGMENT_OWNER_KEYS, `${fragmentPath}.owner`, diagnostics, true);
      if (entry.owner.kind !== "project_policy" || entry.owner.source !== POLICY_RELATIVE_PATH) {
        diagnostics.push(policyDiagnostic("CONFIG_MALFORMED", "policy.read", `${fragmentPath}.owner`, "Only .omp/team.config.json may own policy fragments."));
      }
    }
  });
  if (totalBytes > POLICY_MAX_COMMAND_FRAGMENT_BYTES) diagnostics.push(policyDiagnostic("CONFIG_MALFORMED", "policy.read", path, "Command fragments exceed the aggregate UTF-8 limit."));
  return true;
}

function validateCommandPolicy(value: unknown, diagnostics: ReturnType<typeof policyDiagnostic>[]): value is CommandPolicy {
  if (!isPlainRecord(value)) {
    diagnostics.push(policyDiagnostic("CONFIG_MALFORMED", "policy.read", "policy.commands", "Use do-work/team/cto command policies."));
    return false;
  }
  ownKeysOnly(value, ["do-work", "team", "cto"], "policy.commands", diagnostics, true);
  const ids = new Set<string>();
  const commands: Array<{ readonly name: "do-work" | "cto"; readonly value: Record<string, unknown> }> = [];
  for (const command of ["do-work", "cto"] as const) {
    const commandValue = value[command];
    if (!isPlainRecord(commandValue)) {
      diagnostics.push(policyDiagnostic("CONFIG_MALFORMED", "policy.read", `policy.commands.${command}`, "Use a command fragment object."));
      continue;
    }
    ownKeysOnly(commandValue, COMMAND_KEYS, `policy.commands.${command}`, diagnostics, true);
    validateFragments(commandValue.fragments, `policy.commands.${command}.fragments`, ids, diagnostics);
    commands.push({ name: command, value: commandValue });
  }
  const fragmentCount = commands.reduce((count, command) => count + (Array.isArray(command.value.fragments) ? command.value.fragments.length : 0), 0);
  const fragmentBytes = commands.reduce((total, command) => total + (
    Array.isArray(command.value.fragments)
      ? command.value.fragments.reduce((bytes, fragment) => (
        isPlainRecord(fragment) && typeof fragment.text === "string" ? bytes + byteLength(fragment.text) : bytes
      ), 0)
      : 0
  ), 0);
  if (fragmentCount > POLICY_MAX_COMMAND_FRAGMENTS) diagnostics.push(policyDiagnostic("CONFIG_MALFORMED", "policy.read", "policy.commands", "Use at most 64 command fragments across do-work and cto."));
  if (fragmentBytes > POLICY_MAX_COMMAND_FRAGMENT_BYTES) diagnostics.push(policyDiagnostic("CONFIG_MALFORMED", "policy.read", "policy.commands", "Command fragments exceed the aggregate UTF-8 limit."));
  const team = value.team;
  if (!isPlainRecord(team)) {
    diagnostics.push(policyDiagnostic("CONFIG_MALFORMED", "policy.read", "policy.commands.team", "Use the exact semantic team alias."));
  } else {
    ownKeysOnly(team, ALIAS_KEYS, "policy.commands.team", diagnostics, true);
    if (team.alias_of !== "do-work") diagnostics.push(policyDiagnostic("CONFIG_MALFORMED", "policy.read", "policy.commands.team.alias_of", "The team command may only alias do-work."));
  }
  return true;
}

function validatePromptContext(value: unknown, diagnostics: ReturnType<typeof policyDiagnostic>[]): value is Record<string, unknown> {
  if (!isPlainRecord(value)) {
    diagnostics.push(policyDiagnostic("CONFIG_MALFORMED", "policy.read", "policy.prompt_context", "Use a typed prompt context map."));
    return false;
  }
  for (const [id, entry] of Object.entries(value)) {
    const path = `policy.prompt_context.${id}`;
    if (!validIdentifier(id)) diagnostics.push(policyDiagnostic("CONFIG_MALFORMED", "policy.read", path, "Use a bounded prompt context id."));
    if (!isPlainRecord(entry)) {
      diagnostics.push(policyDiagnostic("CONFIG_MALFORMED", "policy.read", path, "Use a typed prompt context entry."));
      continue;
    }
    ownKeysOnly(entry, PROMPT_ENTRY_KEYS, path, diagnostics, true);
    if (entry.id !== id || !validIdentifier(entry.id)) diagnostics.push(policyDiagnostic("CONFIG_MALFORMED", "policy.read", `${path}.id`, "Prompt context entry id must match its map key."));
    if (entry.type !== "text" && entry.type !== "enum" && entry.type !== "number" && entry.type !== "boolean") {
      diagnostics.push(policyDiagnostic("CONFIG_MALFORMED", "policy.read", `${path}.type`, "Use text, enum, number, or boolean prompt context values."));
      continue;
    }
    if (entry.type === "number") {
      if (typeof entry.value !== "number" || !Number.isFinite(entry.value)) diagnostics.push(policyDiagnostic("CONFIG_MALFORMED", "policy.read", `${path}.value`, "Use a finite prompt context number."));
    } else if (entry.type === "boolean") {
      if (typeof entry.value !== "boolean") diagnostics.push(policyDiagnostic("CONFIG_MALFORMED", "policy.read", `${path}.value`, "Use a boolean prompt context value."));
    } else if (typeof entry.value !== "string" || !validateStringLimits(entry.value)) {
      diagnostics.push(policyDiagnostic("CONFIG_MALFORMED", "policy.read", `${path}.value`, "Use bounded Unicode text prompt context values."));
    }
  }
  return true;
}

function validateWorkflow(value: unknown, diagnostics: ReturnType<typeof policyDiagnostic>[]): value is WorkflowSelection {
  if (!isPlainRecord(value)) {
    diagnostics.push(policyDiagnostic("CONFIG_MALFORMED", "policy.read", "policy.workflow", "Use a workflow selection object."));
    return false;
  }
  if (value.selection === "matrix") {
    ownKeysOnly(value, WORKFLOW_MATRIX_KEYS, "policy.workflow", diagnostics, true);
    return true;
  }
  if (value.selection === "fixed") {
    ownKeysOnly(value, WORKFLOW_FIXED_KEYS, "policy.workflow", diagnostics, true);
    requireKeys(value, WORKFLOW_FIXED_KEYS, "policy.workflow", diagnostics);
    validateProfileIdentity(value.profile_identity, "policy.workflow.profile_identity", diagnostics);
    return true;
  }
  ownKeysOnly(value, WORKFLOW_MATRIX_KEYS, "policy.workflow", diagnostics, true);
  diagnostics.push(policyDiagnostic("CONFIG_MALFORMED", "policy.read", "policy.workflow.selection", "Use matrix or fixed workflow selection."));
  return false;
}

function validateDocumentValue(value: unknown): ReturnType<typeof policyDiagnostic>[] {
  const diagnostics: ReturnType<typeof policyDiagnostic>[] = [];
  if (!isPlainRecord(value)) {
    diagnostics.push(policyDiagnostic("CONFIG_MALFORMED", "policy.read", "document", "Use a plain strict v2 policy document."));
    return diagnostics;
  }
  ownKeysOnly(value, POLICY_TOP_LEVEL_KEYS, "document", diagnostics, true);
  if (value.schema_version !== POLICY_SCHEMA_VERSION) {
    diagnostics.push(policyDiagnostic(
      typeof value.schema_version === "number" ? "UNSUPPORTED_SCHEMA" : "CONFIG_MALFORMED",
      "policy.read",
      "document.schema_version",
      "Use schema_version 2 for the workflow-v2 policy.",
    ));
  }
  const provider = value.provider;
  let providerId = "";
  if (!isPlainRecord(provider)) {
    diagnostics.push(policyDiagnostic("CONFIG_MALFORMED", "policy.read", "document.provider", "Use the strict v2 provider identity object."));
  } else {
    ownKeysOnly(provider, POLICY_PROVIDER_KEYS, "document.provider", diagnostics, true);
    if (!isProviderId(provider.id)) diagnostics.push(policyDiagnostic("CONFIG_MALFORMED", "policy.read", "document.provider.id", "Use a lowercase package-qualified provider id."));
    else providerId = provider.id;
    if (provider.protocol_version !== 2) diagnostics.push(policyDiagnostic("UNSUPPORTED_SCHEMA", "policy.read", "document.provider.protocol_version", "Use provider protocol_version 2."));
    if (!isWorkflowV2Digest(provider.descriptor_fingerprint)) diagnostics.push(policyDiagnostic("CONFIG_MALFORMED", "policy.read", "document.provider.descriptor_fingerprint", "Use a sha256:<64 lowercase hex> descriptor fingerprint."));
    if (!isWorkflowV2Digest(provider.catalog_content_digest)) diagnostics.push(policyDiagnostic("CONFIG_MALFORMED", "policy.read", "document.provider.catalog_content_digest", "Use a sha256:<64 lowercase hex> catalog digest."));
  }
  const policy = value.policy;
  if (!isPlainRecord(policy)) {
    diagnostics.push(policyDiagnostic("CONFIG_MALFORMED", "policy.read", "document.policy", "Use the strict v2 workflow policy object."));
    return diagnostics;
  }
  ownKeysOnly(policy, POLICY_KEYS, "document.policy", diagnostics, true);
  const roles = policy.roles;
  if (!isPlainRecord(roles)) diagnostics.push(policyDiagnostic("CONFIG_MALFORMED", "policy.read", "policy.roles", "Use a role to agent-reference map."));
  else for (const [role, agent] of Object.entries(roles)) {
    if (!validIdentifier(role)) diagnostics.push(policyDiagnostic("CONFIG_MALFORMED", "policy.read", `policy.roles.${role}`, "Use bounded role ids."));
    if (agent !== null) validateAgentRef(agent, providerId, `policy.roles.${role}`, diagnostics);
  }
  validateScopePatches(policy.scope_map, providerId, diagnostics);
  validateRosterPatches(policy.roster_overrides, diagnostics);
  validateMapValues(policy.flags, "policy.flags", diagnostics, (candidate) => candidate === null || typeof candidate === "boolean");
  validateMapValues(policy.runtime_classes, "policy.runtime_classes", diagnostics, (candidate) => candidate === null || typeof candidate === "boolean" || validIdentifier(candidate));
  validateMapValues(policy.ui_classes, "policy.ui_classes", diagnostics, (candidate) => candidate === null || typeof candidate === "boolean" || validIdentifier(candidate));
  if (policy.design_system !== null && !validIdentifier(policy.design_system, POLICY_MAX_STRING_BYTES)) diagnostics.push(policyDiagnostic("CONFIG_MALFORMED", "policy.read", "policy.design_system", "Use a bounded design-system identifier or null."));
  validateCommandPolicy(policy.commands, diagnostics);
  validateWorkflow(policy.workflow, diagnostics);
  validatePromptContext(policy.prompt_context, diagnostics);
  if (!Array.isArray(policy.required_capabilities)) diagnostics.push(policyDiagnostic("CONFIG_MALFORMED", "policy.read", "policy.required_capabilities", "Use a unique additive capability array."));
  else {
    const capabilities = new Set<string>();
    policy.required_capabilities.forEach((capability, index) => {
      if (!validCapability(capability)) diagnostics.push(policyDiagnostic("CONFIG_MALFORMED", "policy.read", `policy.required_capabilities[${index}]`, "Use bounded capability names."));
      else if (capabilities.has(capability)) diagnostics.push(policyDiagnostic("CONFIG_MALFORMED", "policy.read", `policy.required_capabilities[${index}]`, "Use unique additive capability names."));
      else capabilities.add(capability);
    });
  }
  return diagnostics;
}

function freezeJson<T>(value: T): T {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return Object.freeze(value.map((entry) => freezeJson(entry))) as T;
  const result: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) result[key] = freezeJson(entry);
  return Object.freeze(result) as T;
}

/** Parse and validate a strict v2 document from exact UTF-8 input. */
export function parsePolicyDocument(input: Uint8Array | string, path: string = POLICY_RELATIVE_PATH): DiagnosticResult<PolicyDocument> {
  try {
    const parsed = parseStrictJsonValue(input, JSON_LIMITS);
    const diagnostics = validateDocumentValue(parsed);
    if (diagnostics.length > 0) {
      return failureResult(diagnostics.map((entry) => createDiagnostic({
        code: entry.code,
        operation: entry.operation,
        severity: entry.severity,
        evidence: { ...entry.evidence, path },
        remediation: entry.remediation,
      })));
    }
    return successResult(freezeJson(parsed as PolicyDocument));
  } catch (error) {
    const strict = error instanceof StrictJsonError ? error : undefined;
    const field = strict?.reason === "limit" ? "limits" : strict?.reason === "duplicate" ? "duplicate_key" : "syntax";
    return failureResult(policyDiagnostic(
      "CONFIG_MALFORMED",
      "policy.read",
      field,
      "Rewrite the file as strict UTF-8 JSON matching the closed workflow-v2 schema.",
      { path },
    ));
  }
}

export function parsePolicyBytes(input: Uint8Array, path: string = POLICY_RELATIVE_PATH): DiagnosticResult<PolicyDocument> {
  return parsePolicyDocument(input, path);
}

function rootPath(root: CanonicalRoot | string): CanonicalRoot | undefined {
  if (typeof root !== "string" || !isCanonicalRoot(root)) return undefined;
  return createCanonicalRoot(root);
}

function configPath(root: CanonicalRoot | string): string {
  const canonical = rootPath(root);
  if (!canonical) throw new TypeError("workflow-v2 policy requires a canonical absolute root");
  return join(canonical, POLICY_RELATIVE_PATH);
}

export function policyPath(root: CanonicalRoot | string): string {
  return configPath(root);
}

function authorityDiagnostic(
  operation: "policy.read" | "policy.write" | "root.resolve",
  field: string,
  path: string,
  result: FsAuthorityFailure,
): WorkflowV2Diagnostic {
  const code = result.reason === "unsafe"
    ? "UNSAFE_PATH"
    : result.reason === "conflict"
      ? "IDENTITY_MISMATCH"
      : result.reason === "limit"
        ? "CONFIG_MALFORMED"
        : result.reason === "omp_missing"
          ? "CONFIG_MISSING"
          : result.reason === "root_missing" || result.reason === "invalid_root"
            ? "ROOT_UNAVAILABLE"
            : "ACTIVATION_FAILED";
  return policyDiagnostic(
    code,
    operation,
    field,
    result.message ?? "Use the trusted descriptor-relative filesystem authority; no pathname fallback is available.",
    { path, reason: result.reason },
  );
}


function transactionDiagnostic(
  operation: "policy.read" | "policy.write",
  transaction: TransactionStatus,
): WorkflowV2Diagnostic | undefined {
  if (transaction.status === "clear") return undefined;
  const reason = transaction.status === "invalid" ? transaction.reason : transaction.status;
  return policyDiagnostic(
    "TRANSACTION_INCOMPLETE",
    operation,
    "transaction_journal",
    "Recover the workflow-v2 transaction through management before accessing the policy.",
    { path: transaction.path, status: reason },
  );
}

interface PinnedPolicyRead {
  readonly snapshot: PolicySnapshot;
  readonly fingerprint: Extract<FsTargetFingerprint, { readonly state: "present" }>;
}

function readPolicyAtPinned(
  authority: TrustedFsAuthority,
  pinned: PinnedFsRoot,
  transactionAuthority: typeof TRANSACTION_READ_AUTHORITY | undefined,
): DiagnosticResult<PinnedPolicyRead | null> {
  const path = configPath(pinned.canonicalRoot);
  const transaction = readTransactionStatusFromPinned(pinned.canonicalRoot, pinned, authority);
  if (transactionAuthority !== TRANSACTION_READ_AUTHORITY) {
    const blocked = transactionDiagnostic("policy.read", transaction);
    if (blocked) return failureResult(blocked);
  }
  if (!transactionReadAllowed(pinned.canonicalRoot, transaction, transactionAuthority)) {
    const blocked = transactionDiagnostic("policy.read", transaction);
    if (blocked) return failureResult(blocked);
  }
  const read = authority.readBounded(pinned.ompDirectory, "team.config.json", POLICY_MAX_BYTES);
  if (!read.ok) return failureResult(authorityDiagnostic("policy.read", "path", path, read));
  if (read.value === null) return successResult(null);
  const parsed = parsePolicyBytes(read.value.bytes, path);
  if (!parsed.ok) return parsed;
  runTransactionReadHook(pinned.canonicalRoot);
  const finalTransaction = readTransactionStatusFromPinned(pinned.canonicalRoot, pinned, authority);
  if (!transactionReadAllowed(pinned.canonicalRoot, finalTransaction, transactionAuthority)) {
    const blocked = transactionDiagnostic("policy.read", finalTransaction);
    return failureResult(blocked ?? policyDiagnostic("TRANSACTION_INCOMPLETE", "policy.read", "transaction_journal", "Recover the workflow-v2 transaction before reading the policy."));
  }
  return successResult({
    snapshot: Object.freeze({
      root: pinned.canonicalRoot,
      document: parsed.value,
      byte_sha256: computePolicyByteHash(read.value.bytes),
      semantic_sha256: computePolicySemanticHash(parsed.value),
      byte_length: read.value.bytes.byteLength,
    }),
    fingerprint: read.value.fingerprint,
  });
}

function readPolicySnapshotInternal(
  root: CanonicalRoot | string,
  filesystemAuthority: TrustedFsAuthority | undefined,
  transactionAuthority: typeof TRANSACTION_READ_AUTHORITY | undefined,
  providedPinned?: PinnedFsRoot,
): PolicyReadResult {
  const requestedPath = (() => {
    try {
      return configPath(root);
    } catch {
      return POLICY_RELATIVE_PATH;
    }
  })();
  const canonical = rootPath(root);
  if (!canonical) return failureResult(policyDiagnostic("ROOT_UNAVAILABLE", "root.resolve", "canonical_root", "Resolve one canonical absolute project root before reading workflow policy.", { path: requestedPath }));
  if (!isTrustedFsAuthority(filesystemAuthority)) {
    return failureResult(policyDiagnostic("ACTIVATION_FAILED", "root.resolve", "filesystem_authority", "Provide a factory-issued trusted descriptor-relative filesystem authority before reading workflow policy.", { path: requestedPath, reason: filesystemAuthority === undefined ? "missing" : "foreign" }));
  }
  const authority = filesystemAuthority;
  if (providedPinned && providedPinned.canonicalRoot !== canonical) {
    return failureResult(policyDiagnostic("IDENTITY_MISMATCH", "root.resolve", "canonical_root", "The pinned filesystem root does not match the requested canonical root.", { path: requestedPath }));
  }
  let pinned: PinnedFsRoot;
  let ownsPinned = false;
  if (providedPinned) {
    pinned = providedPinned;
  } else {
    const opened = authority.openRoot(canonical, { createOmp: false });
    if (!opened.ok) return failureResult(authorityDiagnostic("root.resolve", "canonical_root", requestedPath, opened));
    pinned = opened.value;
    ownsPinned = true;
  }
  try {
    const result = readPolicyAtPinned(authority, pinned, transactionAuthority);
    if (!result.ok) return result;
    if (result.value === null) return failureResult(policyDiagnostic("CONFIG_MISSING", "policy.read", "path", "Create .omp/team.config.json through explicit init-team management.", { path: requestedPath }));
    return successResult(result.value.snapshot);
  } finally {
    if (ownsPinned) pinned.close();
  }
}

/** Read exactly root/.omp/team.config.json through one pinned authority. */
export function readPolicySnapshot(root: CanonicalRoot | string, filesystemAuthority?: TrustedFsAuthority): PolicyReadResult {
  return readPolicySnapshotInternal(root, filesystemAuthority, undefined);
}

/** Read policy bytes while management owns a valid transaction journal and explicit filesystem authority. */
export function readPolicySnapshotDuringTransaction(
  root: CanonicalRoot,
  filesystemAuthority: TrustedFsAuthority | undefined,
  transactionAuthority: typeof TRANSACTION_READ_AUTHORITY,
  pinnedRoot?: PinnedFsRoot,
): PolicyReadResult {
  return readPolicySnapshotInternal(root, filesystemAuthority, transactionAuthority, pinnedRoot);
}

function cloneAgentRef(value: AgentRef): AgentRef {
  return Object.freeze({ registered_name: value.registered_name, provider_id: value.provider_id, source_fingerprint: value.source_fingerprint });
}

function cloneScopeRule(value: ScopeRule): ScopeRule {
  return Object.freeze({
    patterns: Object.freeze([...value.patterns]),
    scope: value.scope,
    dev_agent: cloneAgentRef(value.dev_agent),
    ...(value.runtime_class !== undefined ? { runtime_class: value.runtime_class } : {}),
    ...(value.ui_class !== undefined ? { ui_class: value.ui_class } : {}),
  });
}

function cloneRosterValue(value: RosterOverride): RosterOverride {
  return Object.freeze({
    ...(value.replace !== undefined ? { replace: Object.freeze([...value.replace]) } : {}),
    ...(value.add !== undefined ? { add: Object.freeze([...value.add]) } : {}),
    ...(value.remove !== undefined ? { remove: Object.freeze([...value.remove]) } : {}),
  });
}

function defaultItemId(value: unknown, index: number): string {
  if (isPlainRecord(value) && validIdentifier(value.id)) return value.id;
  if (isPlainRecord(value) && validIdentifier(value.scope)) return value.scope;
  return `index-${index}`;
}

function mapWithTombstones<T>(defaults: Readonly<Record<string, T | null>> | undefined, policy: Readonly<Record<string, T | null>>, clone: (value: T) => T): Record<string, T> {
  const result: Record<string, T> = {};
  for (const [key, value] of Object.entries(defaults ?? {})) if (value !== null && value !== undefined) result[key] = clone(value);
  for (const [key, value] of Object.entries(policy)) {
    if (value === null) delete result[key];
    else result[key] = clone(value);
  }
  return result;
}

function mergePatchArray<T>(
  defaults: readonly T[],
  patches: readonly ({ readonly op: "replace" | "add" | "remove"; readonly id: string; readonly before?: string; readonly rule?: T; readonly value?: T })[],
  clone: (value: T) => T,
  path: string,
): DiagnosticResult<readonly T[]> {
  const diagnostics: ReturnType<typeof policyDiagnostic>[] = [];
  const entries: Array<{ id: string; value: T }> = [];
  const ids = new Set<string>();
  defaults.forEach((value, index) => {
    const id = defaultItemId(value, index);
    if (ids.has(id)) {
      diagnostics.push(policyDiagnostic("CONFIG_MALFORMED", "policy.read", path, "Descriptor defaults must have unique patch identities."));
      return;
    }
    ids.add(id);
    entries.push({ id, value: clone(value) });
  });
  for (const patch of patches) {
    if (patch.op === "replace") {
      const index = entries.findIndex((entry) => entry.id === patch.id);
      if (index < 0 || (patch.rule === undefined && patch.value === undefined)) {
        diagnostics.push(policyDiagnostic("CONFIG_MALFORMED", "policy.read", path, "Replace patches must target an existing id."));
        continue;
      }
      entries[index] = { id: patch.id, value: clone((patch.rule ?? patch.value) as T) };
    } else if (patch.op === "remove") {
      const index = entries.findIndex((entry) => entry.id === patch.id);
      if (index < 0) {
        diagnostics.push(policyDiagnostic("CONFIG_MALFORMED", "policy.read", path, "Remove patches must target an existing id."));
        continue;
      }
      entries.splice(index, 1);
      ids.delete(patch.id);
    } else {
      if (ids.has(patch.id)) {
        diagnostics.push(policyDiagnostic("CONFIG_MALFORMED", "policy.read", path, "Add patches must use a unique id."));
        continue;
      }
      const value = (patch.rule ?? patch.value) as T | undefined;
      if (value === undefined) {
        diagnostics.push(policyDiagnostic("CONFIG_MALFORMED", "policy.read", path, "Add patches must include a value."));
        continue;
      }
      const entry = { id: patch.id, value: clone(value) };
      const before = patch.before === undefined ? -1 : entries.findIndex((candidate) => candidate.id === patch.before);
      if (patch.before !== undefined && before < 0) {
        diagnostics.push(policyDiagnostic("CONFIG_MALFORMED", "policy.read", path, "Add patches must reference an existing before id."));
        continue;
      }
      if (before < 0) entries.push(entry);
      else entries.splice(before, 0, entry);
      ids.add(patch.id);
    }
  }
  if (diagnostics.length > 0) return failureResult(diagnostics);
  return successResult(Object.freeze(entries.map((entry) => clone(entry.value))));
}

function mergeCommands(defaults: CommandPolicy | undefined, policy: CommandPolicy): CommandPolicy {
  const mergeFragments = (left: readonly PolicyFragment[] | undefined, right: readonly PolicyFragment[]): readonly PolicyFragment[] => Object.freeze([
    ...(left ?? []),
    ...right,
  ].map((fragment) => Object.freeze({
    id: fragment.id,
    text: fragment.text,
    owner: Object.freeze({ kind: fragment.owner.kind, source: fragment.owner.source }),
  })));
  return Object.freeze({
    "do-work": Object.freeze({ fragments: mergeFragments(defaults?.["do-work"]?.fragments, policy["do-work"].fragments) }),
    team: Object.freeze({ alias_of: "do-work" as const }),
    cto: Object.freeze({ fragments: mergeFragments(defaults?.cto?.fragments, policy.cto.fragments) }),
  });
}

function providerIdentityDiagnostic(field: string, providerId: string, remediation: string) {
  return policyDiagnostic("IDENTITY_MISMATCH", "policy.read", field, remediation, { provider_id: providerId });
}

/** Merge immutable descriptor defaults with one validated project policy. */
export function mergePolicy(
  descriptor: Readonly<ProviderDescriptor>,
  document: Readonly<PolicyDocument>,
): DiagnosticResult<EffectivePolicy> {
  const parsed = validateDocumentValue(document);
  if (parsed.length > 0) return failureResult(parsed);
  const provider = document.provider;
  const diagnostics: ReturnType<typeof policyDiagnostic>[] = [];
  if (provider.id !== descriptor.id) diagnostics.push(providerIdentityDiagnostic("provider.id", descriptor.id, "Use the exact provider selected by the immutable descriptor."));
  if (provider.protocol_version !== descriptor.protocol_version) diagnostics.push(providerIdentityDiagnostic("provider.protocol_version", descriptor.id, "Use protocol version 2 for both policy and provider."));
  if (provider.catalog_content_digest !== descriptor.catalog_content_digest) diagnostics.push(providerIdentityDiagnostic("provider.catalog_content_digest", descriptor.id, "Refresh the policy against the selected provider catalog."));
  const policy = document.policy;
  const defaults: DescriptorDefaults = descriptor.defaults ?? {};
  const roleDefaults = defaults.roles ?? {};
  const roles = mapWithTombstones(roleDefaults, policy.roles, cloneAgentRef);
  const scopeResult = mergePatchArray(defaults.scope_map ?? [], policy.scope_map as readonly ScopePatch[], cloneScopeRule, "policy.scope_map");
  if (!scopeResult.ok) diagnostics.push(...scopeResult.diagnostics);
  const rosterResult = mergePatchArray(defaults.roster_overrides ?? [], policy.roster_overrides as readonly RosterPatch[], cloneRosterValue, "policy.roster_overrides");
  if (!rosterResult.ok) diagnostics.push(...rosterResult.diagnostics);
  const flags = mapWithTombstones(defaults.flags, policy.flags, (value) => value);
  const runtimeClasses = mapWithTombstones(defaults.runtime_classes, policy.runtime_classes, (value) => value);
  const uiClasses = mapWithTombstones(defaults.ui_classes, policy.ui_classes, (value) => value);
  const promptContext: Record<string, WorkflowPolicy["prompt_context"][string]> = {};
  for (const [key, value] of Object.entries(defaults.prompt_context ?? {})) promptContext[key] = freezeJson(value);
  for (const [key, value] of Object.entries(policy.prompt_context)) promptContext[key] = freezeJson(value);
  const workflow: WorkflowSelection = policy.workflow.selection === "matrix"
    ? Object.freeze({ selection: "matrix" as const })
    : Object.freeze({
      selection: "fixed" as const,
      profile_identity: Object.freeze({
        id: policy.workflow.profile_identity.id,
        fingerprint: policy.workflow.profile_identity.fingerprint,
      }),
    });
  const requiredCapabilities = Object.freeze([...new Set([...(defaults.required_capabilities ?? []), ...policy.required_capabilities])]);
  if (diagnostics.length > 0) return failureResult(diagnostics);
  const effective = Object.freeze({
    provider: Object.freeze({
      id: provider.id,
      protocol_version: 2 as const,
      descriptor_fingerprint: provider.descriptor_fingerprint,
      catalog_content_digest: provider.catalog_content_digest,
    }),
    roles: Object.freeze(roles),
    scope_map: scopeResult.ok ? scopeResult.value : Object.freeze([]),
    roster_overrides: rosterResult.ok ? rosterResult.value : Object.freeze([]),
    flags: Object.freeze(flags),
    runtime_classes: Object.freeze(runtimeClasses),
    ui_classes: Object.freeze(uiClasses),
    design_system: policy.design_system,
    commands: mergeCommands(defaults.commands, policy.commands),
    workflow,
    prompt_context: Object.freeze(promptContext),
    required_capabilities: requiredCapabilities,
  });
  return successResult(effective);
}

export function effectivePolicyFromSnapshot(
  snapshot: Readonly<PolicySnapshot>,
  descriptor: Readonly<ProviderDescriptor>,
): DiagnosticResult<EffectivePolicy> {
  const semantic = computePolicySemanticHash(snapshot.document);
  if (semantic !== snapshot.semantic_sha256) {
    return failureResult(policyDiagnostic("IDENTITY_MISMATCH", "policy.read", "config_semantic_sha256", "Discard stale policy data and reread the exact policy bytes."));
  }
  return mergePolicy(descriptor, snapshot.document);
}

function targetIdentityMatches(identity: string, fingerprint: FsTargetFingerprint): boolean {
  if (fingerprint.state === "absent") return false;
  const fields = identity.split(":");
  if (fields.length < 3 || fields[0] !== fingerprint.device || fields[1] !== fingerprint.inode) return false;
  const identityLength = fields[2];
  if (identityLength === undefined) return false;
  const lengthField = identityLength.startsWith("sha256") ? fields[fields.length - 1] : identityLength;
  if (lengthField === undefined) return false;
  return Number(lengthField) === fingerprint.byte_length;
}

function directoryIdentity(device: string, inode: string): string {
  return `${device}:${inode}`;
}

function comparePreconditions(
  expected: PolicyPrecondition,
  current: PolicySnapshot | null,
  currentFingerprint: FsTargetFingerprint,
  canonical: CanonicalRoot,
  path: string,
  parentIdentity: string,
): WorkflowV2Diagnostic[] {
  const diagnostics: WorkflowV2Diagnostic[] = [];
  if (expected.state === "absent") {
    if (current !== null || currentFingerprint.state !== "absent") {
      diagnostics.push(policyDiagnostic("IDENTITY_MISMATCH", "policy.write", "state", "The policy appeared after the absent-policy proposal; obtain a new proposal."));
    }
    if (expected.canonical_root !== canonical) {
      diagnostics.push(policyDiagnostic("IDENTITY_MISMATCH", "policy.write", "canonical_root", "The proposal is bound to a different canonical root."));
    }
    if (expected.policy_path !== path) {
      diagnostics.push(policyDiagnostic("IDENTITY_MISMATCH", "policy.write", "policy_path", "The proposal is bound to a different policy path."));
    }
    if (expected.parent_path_identity !== parentIdentity) {
      diagnostics.push(policyDiagnostic("IDENTITY_MISMATCH", "policy.write", "parent_path_identity", "The policy parent changed after proposal creation; obtain a new proposal."));
    }
    return diagnostics;
  }
  if (current === null || currentFingerprint.state === "absent") {
    diagnostics.push(policyDiagnostic("IDENTITY_MISMATCH", "policy.write", "state", "The expected existing policy is absent; reread before applying the proposal."));
    return diagnostics;
  }
  if (expected.policy_path !== path) {
    diagnostics.push(policyDiagnostic("IDENTITY_MISMATCH", "policy.write", "policy_path", "The proposal is bound to a different policy path."));
  }
  if (!targetIdentityMatches(expected.policy_file_identity, currentFingerprint)) {
    diagnostics.push(policyDiagnostic("IDENTITY_MISMATCH", "policy.write", "policy_file_identity", "The policy inode, length, or byte identity changed after proposal creation; obtain a new proposal."));
  }
  const project = expected.project_identity;
  const checks: Array<[string, unknown, unknown]> = [
    ["provider_id", current.document.provider.id, project.provider_id],
    ["descriptor_fingerprint", current.document.provider.descriptor_fingerprint, project.descriptor_fingerprint],
    ["catalog_content_digest", current.document.provider.catalog_content_digest, project.catalog_content_digest],
    ["config_byte_sha256", current.byte_sha256, expected.raw_hash],
    ["config_semantic_sha256", current.semantic_sha256, expected.semantic_hash],
    ["project_config_byte_sha256", current.byte_sha256, project.config_byte_sha256],
    ["project_config_semantic_sha256", current.semantic_sha256, project.config_semantic_sha256],
  ];
  for (const [field, actual, wanted] of checks) {
    if (actual !== wanted) diagnostics.push(policyDiagnostic("IDENTITY_MISMATCH", "policy.write", field, "Reread the current policy and regenerate the management proposal."));
  }
  return diagnostics;
}

export interface PolicyWriteRequest {
  readonly root: CanonicalRoot | string;
  readonly document: Readonly<PolicyDocument>;
  readonly confirm_root: true;
  readonly expected?: PolicyPrecondition;
  readonly current?: PolicySnapshot | null;
}

export type PolicyWriteResult = DiagnosticResult<PolicySnapshot>;

function writePolicyDocumentInternal(
  input: PolicyWriteRequest,
  filesystemAuthority: TrustedFsAuthority | undefined,
  transactionAuthority: typeof TRANSACTION_READ_AUTHORITY | undefined,
  providedPinned?: PinnedFsRoot,
): PolicyWriteResult {
  if (!input || input.confirm_root !== true) {
    return failureResult(policyDiagnostic("BINDING_REQUIRED", "policy.write", "confirm_root", "Explicitly confirm the canonical project root before writing policy."));
  }
  const canonical = rootPath(input.root);
  const requestedPath = (() => {
    try {
      return configPath(input.root);
    } catch {
      return POLICY_RELATIVE_PATH;
    }
  })();
  if (!canonical) return failureResult(policyDiagnostic("ROOT_UNAVAILABLE", "policy.write", "canonical_root", "Write only inside a canonical absolute project root.", { path: requestedPath }));
  if (!isTrustedFsAuthority(filesystemAuthority)) {
    return failureResult(policyDiagnostic("ACTIVATION_FAILED", "root.resolve", "filesystem_authority", "Provide a factory-issued trusted descriptor-relative filesystem authority before writing workflow policy.", { path: requestedPath, reason: filesystemAuthority === undefined ? "missing" : "foreign" }));
  }
  const authority = filesystemAuthority;
  if (!filesystemAuthority.supportsAtomicCas) return failureResult(policyDiagnostic("ACTIVATION_FAILED", "root.resolve", "filesystem_authority", "Configure a native descriptor-relative CAS implementation before writing workflow policy.", { path: requestedPath, reason: "atomic_cas_unsupported" }));

  let bytes: Buffer;
  let parsed: DiagnosticResult<PolicyDocument>;
  try {
    bytes = Buffer.from(`${canonicalPolicyJson(input.document)}\n`, "utf8");
    parsed = parsePolicyBytes(bytes, requestedPath);
  } catch {
    return failureResult(policyDiagnostic("CONFIG_MALFORMED", "policy.write", "document", "Write only a strict closed-schema v2 policy document.", { path: requestedPath }));
  }
  if (!parsed.ok) return parsed;
  if (bytes.byteLength > POLICY_MAX_BYTES) {
    return failureResult(policyDiagnostic("CONFIG_MALFORMED", "policy.write", "limits", "Keep the policy below the strict byte limit.", { path: requestedPath }));
  }

  let pinned: PinnedFsRoot;
  let ownsPinned = false;
  let parentIdentity: string;
  if (providedPinned) {
    if (providedPinned.canonicalRoot !== canonical) {
      return failureResult(policyDiagnostic("IDENTITY_MISMATCH", "policy.write", "canonical_root", "The pinned filesystem root does not match the requested canonical root.", { path: requestedPath }));
    }
    pinned = providedPinned;
    parentIdentity = directoryIdentity(pinned.ompDevice, pinned.ompInode);
  } else {
    const firstOpen = authority.openRoot(canonical, { createOmp: false });
    if (firstOpen.ok) {
      pinned = firstOpen.value;
      ownsPinned = true;
      parentIdentity = directoryIdentity(pinned.ompDevice, pinned.ompInode);
    } else if (firstOpen.reason === "omp_missing") {
      const created = authority.openRoot(canonical, { createOmp: true });
      if (!created.ok) return failureResult(authorityDiagnostic("policy.write", "canonical_root", requestedPath, created));
      pinned = created.value;
      ownsPinned = true;
      parentIdentity = directoryIdentity(pinned.rootDevice, pinned.rootInode);
    } else {
      return failureResult(authorityDiagnostic("policy.write", "canonical_root", requestedPath, firstOpen));
    }
  }

  try {
    const currentRead = readPolicyAtPinned(authority, pinned, transactionAuthority);
    if (!currentRead.ok) return currentRead;
    const current = currentRead.value;
    const currentSnapshot = current?.snapshot ?? null;
    const currentFingerprint: FsTargetFingerprint = current?.fingerprint ?? Object.freeze({ state: "absent" as const });
    if (currentSnapshot !== null && !input.expected) {
      return failureResult(policyDiagnostic("IDENTITY_MISMATCH", "policy.write", "expected", "Supply unchanged identity preconditions for every existing-policy apply.", { path: requestedPath }));
    }
    if (input.expected) {
      const mismatches = comparePreconditions(input.expected, currentSnapshot, currentFingerprint, canonical, requestedPath, parentIdentity);
      if (mismatches.length > 0) return failureResult(mismatches);
    }
    if (input.current && (
      currentSnapshot === null
      || input.current.root !== currentSnapshot.root
      || input.current.byte_sha256 !== currentSnapshot.byte_sha256
      || input.current.semantic_sha256 !== currentSnapshot.semantic_sha256
    )) {
      return failureResult(policyDiagnostic("IDENTITY_MISMATCH", "policy.write", "current", "Discard the stale proposal and reread the current policy.", { path: requestedPath }));
    }

    const published = authority.atomicReplaceIfCurrent(pinned.ompDirectory, "team.config.json", currentFingerprint, bytes);
    if (!published.ok) return failureResult(authorityDiagnostic("policy.write", "path", requestedPath, published));
    if (published.value.state !== "present"
      || published.value.byte_sha256 !== computePolicyByteHash(bytes)
      || published.value.byte_length !== bytes.byteLength) {
      return failureResult(policyDiagnostic("IDENTITY_MISMATCH", "policy.write", "config_bytes", "The descriptor-relative CAS returned bytes different from the requested policy.", { path: requestedPath }));
    }
    const finalRead = readPolicyAtPinned(authority, pinned, transactionAuthority);
    if (!finalRead.ok) return finalRead;
    if (finalRead.value === null) return failureResult(policyDiagnostic("IDENTITY_MISMATCH", "policy.write", "config_bytes", "The policy disappeared after descriptor-relative publication.", { path: requestedPath }));
    const finalBytes = Buffer.from(`${canonicalPolicyJson(finalRead.value.snapshot.document)}\n`, "utf8");
    if (!bytes.equals(finalBytes)) {
      return failureResult(policyDiagnostic("IDENTITY_MISMATCH", "policy.write", "config_bytes", "The final policy bytes differ from the requested exact document.", { path: requestedPath }));
    }
    return successResult(finalRead.value.snapshot);
  } finally {
    if (ownsPinned) pinned.close();
  }
}

export function writePolicyDocument(input: PolicyWriteRequest, filesystemAuthority?: TrustedFsAuthority): PolicyWriteResult {
  return writePolicyDocumentInternal(input, filesystemAuthority, undefined);
}

/** Write policy bytes while management owns a valid transaction journal and explicit filesystem authority. */
export function writePolicyDocumentDuringTransaction(
  input: PolicyWriteRequest,
  filesystemAuthority: TrustedFsAuthority | undefined,
  transactionAuthority: typeof TRANSACTION_READ_AUTHORITY,
  pinnedRoot?: PinnedFsRoot,
): PolicyWriteResult {
  return writePolicyDocumentInternal(input, filesystemAuthority, transactionAuthority, pinnedRoot);
}

export type { PolicySnapshot } from "./types.js";
