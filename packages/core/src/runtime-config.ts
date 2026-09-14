/**
 * Runtime config reader/writer boundary.
 *
 * Config writes are deliberately tied to a concrete project root.  The
 * registration seam passes an absolute path produced by
 * `resolveRuntimeConfigPath`; direct callers may additionally provide `cwd`
 * so a path from another worktree cannot be accepted accidentally.
 */

import {
  existsSync,
  lstatSync,
  realpathSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { TextDecoder } from "node:util";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { PinnedProjectRoot, PinnedRootError, rollbackPinnedRootWriteReceipt, type PinnedRootWriteReceipt } from "./specification/pinned-root.js";
import type { ScopeRuntimeClassTable } from "./engine/scope.js";
import type { RoleConfig } from "./engine/types.js";

/** Writable config surface: role config plus caller-supplied classification tables. */
type WritableConfig = Partial<RoleConfig> & {
  scope_runtime_classes?: ScopeRuntimeClassTable;
  scope_ui_classes?: ScopeRuntimeClassTable;
};

const CONFIG_DIRECTORY = ".omp";
const CONFIG_FILENAME = "team.config.json";

const CONFIG_WRITE_MAX_BYTES = 256 * 1024;
const CONFIG_WRITE_MAX_DEPTH = 8;
const CONFIG_WRITE_MAX_COLLECTION = 256;
const CONFIG_WRITE_MAX_STRING_BYTES = 8 * 1024;
const CONFIG_WRITE_TOP_LEVEL_KEYS = new Set([
  "roles", "roster_overrides", "scope_map", "flags", "design_system",
  "scope_runtime_classes", "runtime_classes", "scope_ui_classes",
  "agent_mapping", "metadata", "version", "config_version", "writer", "provenance",
]);

type JsonObject = Record<string, unknown>;

function boundedString(value: unknown): value is string {
  return typeof value === "string"
    && value.length > 0
    && Buffer.byteLength(value, "utf8") <= CONFIG_WRITE_MAX_STRING_BYTES
    && !/[\u0000-\u001f\u007f]/u.test(value);
}

function boundedJson(value: unknown, depth = 0, seen = new Set<object>()): boolean {
  if (value === null || typeof value === "boolean" || typeof value === "number") return typeof value !== "number" || Number.isFinite(value);
  if (typeof value === "string") return Buffer.byteLength(value, "utf8") <= CONFIG_WRITE_MAX_STRING_BYTES && !/[\u0000-\u001f\u007f]/u.test(value);
  if (typeof value !== "object" || depth > CONFIG_WRITE_MAX_DEPTH || seen.has(value)) return false;
  seen.add(value);
  try {
    if (Array.isArray(value)) return value.length <= CONFIG_WRITE_MAX_COLLECTION
      && value.every((item) => boundedJson(item, depth + 1, seen));
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return false;
    const keys = Object.keys(value);
    return keys.length <= CONFIG_WRITE_MAX_COLLECTION
      && keys.every((key) => boundedString(key) && boundedJson((value as JsonObject)[key], depth + 1, seen));
  } finally {
    seen.delete(value);
  }
}

function stringArray(value: unknown): value is string[] {
  return Array.isArray(value)
    && value.length <= CONFIG_WRITE_MAX_COLLECTION
    && value.every((item) => boundedString(item));
}

function stringMap(value: unknown): value is JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const object = value as JsonObject;
  const prototype = Object.getPrototypeOf(object);
  return (prototype === Object.prototype || prototype === null)
    && Object.keys(object).length <= CONFIG_WRITE_MAX_COLLECTION
    && Object.entries(object).every(([key, item]) => boundedString(key) && boundedString(item));
}

function runtimeClassMap(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const object = value as JsonObject;
  const prototype = Object.getPrototypeOf(object);
  return (prototype === Object.prototype || prototype === null)
    && Object.keys(object).length <= CONFIG_WRITE_MAX_COLLECTION
    && Object.entries(object).every(([key, item]) => boundedString(key) && (typeof item === "boolean" || boundedString(item)));
}

function validateWritableConfig(value: unknown, label: string): string | null {
  if (!value || typeof value !== "object" || Array.isArray(value) || !boundedJson(value)) return `${label} is not a bounded JSON object`;
  const object = value as JsonObject;
  for (const [key, item] of Object.entries(object)) {
    if (!CONFIG_WRITE_TOP_LEVEL_KEYS.has(key)) continue;
    if (key === "roles" && !stringMap(item)) return `${label}.roles must be a bounded string map`;
    if (key === "flags" && (!item || typeof item !== "object" || Array.isArray(item)
      || !Object.entries(item as JsonObject).every(([name, patterns]) => boundedString(name) && stringArray(patterns)))) return `${label}.flags must be bounded string arrays`;
    if (key === "scope_runtime_classes" || key === "runtime_classes" || key === "scope_ui_classes") {
      const validTable = key === "scope_ui_classes"
        ? Boolean(item && typeof item === "object" && !Array.isArray(item)
          && Object.entries(item as JsonObject).every(([name, marker]) => boundedString(name) && typeof marker === "boolean"))
        : runtimeClassMap(item);
      if (!validTable) return `${label}.${key} must be a bounded runtime class map`;
    }
    if (key === "scope_map") {
      const scopes = new Set<string>();
      if (!Array.isArray(item) || item.length > CONFIG_WRITE_MAX_COLLECTION || !item.every((entry) => {
        if (!entry || typeof entry !== "object" || Array.isArray(entry)) return false;
        const record = entry as JsonObject;
        const fields = Object.keys(record);
        if (!fields.every((field) => field === "glob" || field === "scope" || field === "dev_agent" || field === "runtime_class")) return false;
        if (!Object.hasOwn(record, "glob") || !Object.hasOwn(record, "scope") || !Object.hasOwn(record, "dev_agent")) return false;
        if (!stringArray(record.glob) || !boundedString(record.scope) || !boundedString(record.dev_agent)) return false;
        if (Object.hasOwn(record, "runtime_class")
          && typeof record.runtime_class !== "boolean"
          && !boundedString(record.runtime_class)) return false;
        if (scopes.has(record.scope)) return false;
        scopes.add(record.scope);
        return true;
      })) return `${label}.scope_map must contain bounded, unique scope entries`;
    }
    if (key === "roster_overrides") {
      if (!item || typeof item !== "object" || Array.isArray(item)
        || !Object.entries(item as JsonObject).every(([stage, override]) => boundedString(stage)
          && Boolean(override) && typeof override === "object" && !Array.isArray(override)
          && Object.entries(override as JsonObject).every(([field, roles]) => ["replace", "add", "remove"].includes(field) && stringArray(roles)))) {
        return `${label}.roster_overrides must contain bounded role lists`;
      }
    }
    if ((key === "design_system" || key === "writer") && item !== null && !boundedString(item)) return `${label}.${key} must be a bounded string`;
    if ((key === "version" || key === "config_version") && item !== null
      && !(boundedString(item) || (typeof item === "number" && Number.isFinite(item)))) return `${label}.${key} must be a bounded string or number`;
    if ((key === "metadata" || key === "provenance") && item !== null && !boundedJson(item)) return `${label}.${key} must be bounded JSON`;
  }
  return null;
}
export type RuntimeConfigErrorCode =
  | "cwd_mismatch"
  | "path_invalid"
  | "config_malformed";

export class RuntimeConfigError extends Error {
  readonly code: RuntimeConfigErrorCode;
  readonly path?: string;

  constructor(code: RuntimeConfigErrorCode, message: string, path?: string) {
    super(message);
    this.name = "RuntimeConfigError";
    this.code = code;
    this.path = path;
  }
}

export type RuntimeConfigWritePreimage = PinnedRootWriteReceipt["preimage"];

/** Exact ownership token for one runtime configuration atomic publication. */
export interface RuntimeConfigWriteToken {
  readonly path: string;
  readonly relative_path: string;
  readonly preimage: RuntimeConfigWritePreimage;
  readonly postimage: PinnedRootWriteReceipt["descriptor"];
  /** Restore only this operation's exact postimage; false means a concurrent replacement won. */
  rollback(): boolean;
}

export interface RuntimeConfigWriteOptions {
  /** Explicit session/project root. Required when the caller cannot prove it from the path. */
  cwd?: string;
  /** Borrow an already pinned root so validation and publication share one inode generation. */
  pinnedRoot?: PinnedProjectRoot;
  /** Optional writer identity persisted in the metadata envelope. */
  writer?: string;
  /** Optional provenance envelope persisted in the metadata envelope. */
  provenance?: Record<string, unknown>;
  /** Optional monotonic config version persisted in the metadata envelope. */
  version?: string | number;
  /** Invoked after central staging captures the exact preimage/descriptor and before visibility. */
  beforePublish?: (receipt: PinnedRootWriteReceipt) => void;
  /** Invoked after the atomic publication descriptor is captured; throws self-rollback exactly. */
  onPublished?: (token: RuntimeConfigWriteToken) => void;
}

function hasTraversalSegment(path: string): boolean {
  return path.split(/[\\/]+/u).some(segment => segment === "..");
}
function assertProjectCwd(cwd: string): string {
  if (typeof cwd !== "string" || !cwd || !isAbsolute(cwd) || hasTraversalSegment(cwd)) {
    throw new RuntimeConfigError("cwd_mismatch", "runtime config requires an absolute, traversal-free project cwd", cwd);
  }
  const resolved = resolve(cwd);
  if (!existsSync(resolved) || !lstatSync(resolved).isDirectory()) {
    throw new RuntimeConfigError("cwd_mismatch", `project cwd does not exist or is not a directory: ${resolved}`, resolved);
  }
  return realpathSync(resolved);
}


function assertNoSymlinkEscape(root: string, target: string): void {
  const relativeTarget = relative(root, target);
  if (relativeTarget === "" || isAbsolute(relativeTarget) || relativeTarget === ".." || relativeTarget.startsWith(`..${sep}`)) {
    throw new RuntimeConfigError("path_invalid", `runtime config path escapes project cwd: ${target}`, target);
  }
  let cursor = root;
  for (const segment of relativeTarget.split(sep)) {
    cursor = join(cursor, segment);
    if (!existsSync(cursor)) continue;
    const stat = lstatSync(cursor);
    if (stat.isSymbolicLink()) {
      throw new RuntimeConfigError("path_invalid", `runtime config path contains a symlink: ${cursor}`, cursor);
    }
  }
}

function lexicalConfigRoot(path: string): string {
  if (typeof path !== "string" || !isAbsolute(path) || hasTraversalSegment(path)) {
    throw new RuntimeConfigError("path_invalid", "runtime config path must be absolute and traversal-free", path);
  }
  const resolved = resolve(path);
  if (basename(resolved) !== CONFIG_FILENAME || basename(dirname(resolved)) !== CONFIG_DIRECTORY) {
    throw new RuntimeConfigError("path_invalid", `runtime config path must be <cwd>/${CONFIG_DIRECTORY}/${CONFIG_FILENAME}`, path);
  }
  return dirname(dirname(resolved));
}

function inferProjectCwd(path: string): string {
  return assertProjectCwd(lexicalConfigRoot(path));
}

function validateConfigTarget(path: string, cwd?: string): { root: string; target: string } {
  const rawTarget = resolve(path);
  const inferredRoot = inferProjectCwd(path);
  const root = cwd === undefined ? inferredRoot : assertProjectCwd(cwd);
  const rawRoot = assertProjectCwd(dirname(dirname(rawTarget)));
  if (rawRoot !== root) {
    throw new RuntimeConfigError("cwd_mismatch", `runtime config path is outside the supplied project cwd: ${path}`, path);
  }
  const target = join(root, CONFIG_DIRECTORY, CONFIG_FILENAME);
  assertNoSymlinkEscape(root, target);
  return { root, target };
}

/**
 * Return the `.omp` config path only when the explicit project has a real
 * `.omp` directory.  A missing directory is intentionally left to the host
 * registration policy; this helper never creates it.
 */
export function resolveRuntimeConfigPath(cwd: string, borrowedRoot?: PinnedProjectRoot): string | null {
  const root = borrowedRoot?.canonical_root ?? assertProjectCwd(cwd);
  if (borrowedRoot && (!borrowedRoot.isStable() || borrowedRoot.canonical_root !== root)) {
    throw new RuntimeConfigError("path_invalid", `project root changed while resolving runtime config: ${root}`, root);
  }
  const dir = join(root, CONFIG_DIRECTORY);
  if (!existsSync(dir)) return null;
  if (!lstatSync(dir).isDirectory() || lstatSync(dir).isSymbolicLink()) {
    throw new RuntimeConfigError("path_invalid", `runtime config directory is not a real directory: ${dir}`, dir);
  }
  const target = join(dir, CONFIG_FILENAME);
  assertNoSymlinkEscape(root, target);
  return target;
}

/**
 * Merge caller overrides into `.omp/team.config.json`.
 *
 * Unknown top-level metadata is copied verbatim.  An existing malformed
 * document is a visible error; it is never replaced with an empty object.
 * All path and cwd checks happen before the first mkdir/write/rename.
 */
/** Roll back one central receipt, treating an already-restored preimage as success. */
export function rollbackRuntimeConfigReceipt(
  pinnedRoot: PinnedProjectRoot,
  receipt: PinnedRootWriteReceipt,
): boolean {
  if (!pinnedRoot.isStable()) return false;
  if (rollbackPinnedRootWriteReceipt(pinnedRoot, receipt)) return true;
  try {
    if (!pinnedRoot.pathEntryExists(receipt.relative_path)) return receipt.preimage.kind === "absent";
    if (receipt.preimage.kind === "absent") return false;
    const current = pinnedRoot.readFile(receipt.relative_path, { maxBytes: CONFIG_WRITE_MAX_BYTES });
    const bytes = Buffer.from(current.bytes);
    return current.dev === receipt.preimage.expectation.dev
      && current.ino === receipt.preimage.expectation.ino
      && bytes.equals(Buffer.from(receipt.preimage.bytes))
      && createHash("sha256").update(bytes).digest("hex") === receipt.preimage.expectation.sha256;
  } catch (error) {
    return error instanceof PinnedRootError && error.code === "not_found" && receipt.preimage.kind === "absent";
  }
}

export function writeConfig(
  path: string,
  partial: WritableConfig,
  options: RuntimeConfigWriteOptions = {},
): RuntimeConfigWriteToken {
  const lexicalRoot = options.pinnedRoot?.canonical_root ?? lexicalConfigRoot(path);
  const relativeConfigPath = join(CONFIG_DIRECTORY, CONFIG_FILENAME);
  const pinnedRoot = options.pinnedRoot ?? PinnedProjectRoot.open(lexicalRoot);
  if (!pinnedRoot) {
    throw new RuntimeConfigError("path_invalid", `project root cannot be pinned for runtime config write: ${lexicalRoot}`, lexicalRoot);
  }
  const ownsRoot = options.pinnedRoot === undefined;
  let target = join(pinnedRoot.canonical_root, relativeConfigPath);
  let existing: Record<string, unknown> = {};
  try {
    const validated = validateConfigTarget(path, options.cwd);
    if (validated.root !== pinnedRoot.canonical_root) {
      throw new RuntimeConfigError("path_invalid", `runtime config root changed while opening: ${path}`, path);
    }
    target = validated.target;
    if (pinnedRoot.pathEntryExists(relativeConfigPath)) {
      let raw: string;
      let existingRead;
      try {
        existingRead = pinnedRoot.readFile(relativeConfigPath, { maxBytes: CONFIG_WRITE_MAX_BYTES });
        raw = new TextDecoder("utf-8", { fatal: true }).decode(existingRead.bytes);
      } catch {
        throw new RuntimeConfigError("path_invalid", `runtime config target cannot be read safely: ${target}`, target);
      }
      try {
        const parsed: unknown = JSON.parse(raw);
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("root must be an object");
        existing = parsed as Record<string, unknown>;
      } catch (error) {
        throw new RuntimeConfigError(
          "config_malformed",
          `runtime config is malformed at ${target}: ${error instanceof Error ? error.message : String(error)}`,
          target,
        );
      }
    }
    const existingIssue = validateWritableConfig(existing, "existing config");
    if (existingIssue) throw new RuntimeConfigError("config_malformed", existingIssue, target);
    const partialIssue = validateWritableConfig(partial, "config update");
    if (partialIssue) throw new RuntimeConfigError("config_malformed", partialIssue, target);
    if (options.writer !== undefined && !boundedString(options.writer)) throw new RuntimeConfigError("config_malformed", "writer must be a bounded string", target);
    if (options.provenance !== undefined && !boundedJson(options.provenance)) throw new RuntimeConfigError("config_malformed", "provenance must be bounded JSON", target);
    if (options.version !== undefined
      && !(boundedString(options.version) || (typeof options.version === "number" && Number.isFinite(options.version)))) {
      throw new RuntimeConfigError("config_malformed", "version must be a bounded string or number", target);
    }
    const oldRoles = existing.roles && typeof existing.roles === "object" && !Array.isArray(existing.roles)
      ? existing.roles as Record<string, unknown>
      : {};
    const newRoles = partial.roles && typeof partial.roles === "object" && !Array.isArray(partial.roles)
      ? partial.roles as Record<string, unknown>
      : {};
  const oldRoster = existing.roster_overrides && typeof existing.roster_overrides === "object" && !Array.isArray(existing.roster_overrides)
    ? existing.roster_overrides as Record<string, unknown>
    : {};
  const newRoster = partial.roster_overrides && typeof partial.roster_overrides === "object" && !Array.isArray(partial.roster_overrides)
    ? partial.roster_overrides as Record<string, unknown>
    : {};
  const oldFlags = existing.flags && typeof existing.flags === "object" && !Array.isArray(existing.flags)
    ? existing.flags as Record<string, unknown>
    : {};
  const newFlags = partial.flags && typeof partial.flags === "object" && !Array.isArray(partial.flags)
    ? partial.flags as Record<string, unknown>
    : {};
  const oldRuntimeClasses = existing.scope_runtime_classes && typeof existing.scope_runtime_classes === "object" && !Array.isArray(existing.scope_runtime_classes)
    ? existing.scope_runtime_classes as Record<string, unknown>
    : {};
  const newRuntimeClasses = partial.scope_runtime_classes && typeof partial.scope_runtime_classes === "object"
    ? partial.scope_runtime_classes as Record<string, unknown>
    : {};
  const oldUiClasses = existing.scope_ui_classes && typeof existing.scope_ui_classes === "object" && !Array.isArray(existing.scope_ui_classes)
    ? existing.scope_ui_classes as Record<string, unknown>
    : {};
  const newUiClasses = partial.scope_ui_classes && typeof partial.scope_ui_classes === "object"
    ? partial.scope_ui_classes as Record<string, unknown>
    : {};
  const merged: Record<string, unknown> = {
    ...existing,
    roles: { ...oldRoles, ...newRoles },
    roster_overrides: { ...oldRoster, ...newRoster },
    scope_map: Array.isArray(partial.scope_map) && partial.scope_map.length > 0
      ? partial.scope_map
      : Array.isArray(existing.scope_map) ? existing.scope_map : [],
    flags: { ...oldFlags, ...newFlags },
    scope_runtime_classes: { ...oldRuntimeClasses, ...newRuntimeClasses },
    scope_ui_classes: { ...oldUiClasses, ...newUiClasses },
    design_system: partial.design_system !== undefined
      ? partial.design_system
      : existing.design_system ?? null,
  };

  if (options.writer || options.provenance || options.version !== undefined) {
    const metadata = existing.metadata && typeof existing.metadata === "object" && !Array.isArray(existing.metadata)
      ? existing.metadata as Record<string, unknown>
      : {};
    merged.metadata = {
      ...metadata,
      ...(options.writer ? { writer: options.writer } : {}),
      ...(options.provenance ? { provenance: options.provenance } : {}),
      ...(options.version !== undefined ? { version: options.version } : {}),
    };
  }
  const json = `${JSON.stringify(merged, null, 2)}\n`;
  if (Buffer.byteLength(json, "utf8") > CONFIG_WRITE_MAX_BYTES) {
    throw new RuntimeConfigError("config_malformed", `merged runtime config exceeds ${CONFIG_WRITE_MAX_BYTES} bytes`, target);
  }
  let receipt: PinnedRootWriteReceipt;
  try {
    receipt = pinnedRoot.writeAtomicWithReceipt(relativeConfigPath, json, {
      beforePublish: options.beforePublish,
    });
  } catch (error) {
    if (error instanceof RuntimeConfigError) throw error;
    const reason = error instanceof PinnedRootError ? error.message : String(error);
    throw new RuntimeConfigError("path_invalid", `runtime config write failed at ${target}: ${reason}`, target);
  }
  const token: RuntimeConfigWriteToken = {
    path: target,
    relative_path: receipt.relative_path,
    preimage: receipt.preimage,
    postimage: receipt.descriptor,
    rollback: () => {
      const rollbackRoot = ownsRoot ? PinnedProjectRoot.open(lexicalRoot) : pinnedRoot;
      if (!rollbackRoot) return false;
      try {
        if (!rollbackRoot.isStable()) return false;
        return rollbackRuntimeConfigReceipt(rollbackRoot, receipt);
      } finally {
        if (ownsRoot) rollbackRoot.close();
      }
    },
  };
  try {
    options.onPublished?.(token);
  } catch (error) {
    token.rollback();
    throw error;
  }
  return token;
  } catch (error) {
    if (error instanceof RuntimeConfigError) throw error;
    const reason = error instanceof PinnedRootError ? error.message : String(error);
    throw new RuntimeConfigError("path_invalid", `runtime config write failed at ${target}: ${reason}`, target);
  } finally {
    if (ownsRoot) pinnedRoot.close();
  }
}
