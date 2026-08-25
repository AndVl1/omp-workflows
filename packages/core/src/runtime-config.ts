/**
 * Runtime config reader/writer boundary.
 *
 * Config writes are deliberately tied to a concrete project root.  The
 * registration seam passes an absolute path produced by
 * `resolveRuntimeConfigPath`; direct callers may additionally provide `cwd`
 * so a path from another worktree cannot be accepted accidentally.
 */

import { randomUUID } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { RoleConfig } from "./engine/types.js";

const CONFIG_DIRECTORY = ".omp";
const CONFIG_FILENAME = "team.config.json";

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

export interface RuntimeConfigWriteOptions {
  /** Explicit session/project root. Required when the caller cannot prove it from the path. */
  cwd?: string;
  /** Optional writer identity persisted in the metadata envelope. */
  writer?: string;
  /** Optional provenance envelope persisted in the metadata envelope. */
  provenance?: Record<string, unknown>;
  /** Optional monotonic config version persisted in the metadata envelope. */
  version?: string | number;
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

function inferProjectCwd(path: string): string {
  if (typeof path !== "string" || !isAbsolute(path) || hasTraversalSegment(path)) {
    throw new RuntimeConfigError("path_invalid", "runtime config path must be absolute and traversal-free", path);
  }
  const resolved = resolve(path);
  if (basename(resolved) !== CONFIG_FILENAME || basename(dirname(resolved)) !== CONFIG_DIRECTORY) {
    throw new RuntimeConfigError("path_invalid", `runtime config path must be <cwd>/${CONFIG_DIRECTORY}/${CONFIG_FILENAME}`, path);
  }
  return assertProjectCwd(dirname(dirname(resolved)));
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
export function resolveRuntimeConfigPath(cwd: string): string | null {
  const root = assertProjectCwd(cwd);
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
export function writeConfig(
  path: string,
  partial: Partial<RoleConfig>,
  options: RuntimeConfigWriteOptions = {},
): void {
  const { target } = validateConfigTarget(path, options.cwd);
  const directory = dirname(target);
  let existing: Record<string, unknown> = {};
  if (existsSync(target)) {
    if (lstatSync(target).isSymbolicLink() || !lstatSync(target).isFile()) {
      throw new RuntimeConfigError("path_invalid", `runtime config target is not a regular file: ${target}`, target);
    }
    const raw = readFileSync(target, "utf8");
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
  const merged: Record<string, unknown> = {
    ...existing,
    roles: { ...oldRoles, ...newRoles },
    roster_overrides: { ...oldRoster, ...newRoster },
    scope_map: Array.isArray(partial.scope_map) && partial.scope_map.length > 0
      ? partial.scope_map
      : Array.isArray(existing.scope_map) ? existing.scope_map : [],
    flags: { ...oldFlags, ...newFlags },
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

  mkdirSync(directory, { recursive: true });
  const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, `${JSON.stringify(merged, null, 2)}\n`, "utf8");
    renameSync(temporary, target);
  } catch (error) {
    try {
      if (existsSync(temporary)) {
        // Best-effort cleanup; the original config remains untouched.
        renameSync(temporary, `${temporary}.failed`);
      }
    } catch {
      // Preserve the original write error.
    }
    throw error;
  }
}
