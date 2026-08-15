/**
 * Typed artifact I/O. Stages declare `consumes` and `produces` artifact ids;
 * the engine reads/writes them under `.work-state/artifacts/<id>.json` (or per-feature
 * subdir, set by `state.ts`).
 *
 * The schema is the same as claude-plugin's `workflows/artifacts-schema.json`.
 * We don't validate every field here — the engine only checks that the JSON
 * parses and matches the type name — but the schema is preserved for ref.
 */

import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { randomUUID } from "node:crypto";
import { recordArtifactWritten } from "../observability/hooks.js";

const ARTIFACT_ID_RE = /^[A-Za-z0-9._-]+$/;

function assertArtifactId(id: string): void {
  if (!ARTIFACT_ID_RE.test(id) || id === "." || id === "..") {
    throw new Error(`unsafe artifact id: ${id}`);
  }
}

function parseReturnedArtifact(id: string, value: unknown): unknown {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    throw new Error(`artifact "${id}" is not valid JSON`);
  }
}

export function persistReturnedArtifacts(
  artifactsDir: string,
  artifacts: Record<string, unknown>,
): string[] {
  const ids: string[] = [];
  for (const [id, value] of Object.entries(artifacts)) {
    assertArtifactId(id);
    writeArtifact(artifactsDir, id, parseReturnedArtifact(id, value));
    ids.push(id);
  }
  return ids;
}
export type ArtifactId =
  | "discovery"
  | "feature_spec"
  | "exploration"
  | "dod"
  | "clarifications"
  | "architecture"
  | "diagnosis"
  | "implementation"
  | "debug"
  | "review"
  | "qa_tests"
  | "manual_qa"
  | "summary";
export function readArtifact<T = unknown>(artifactsDir: string, id: string): T | null {
  if (!ARTIFACT_ID_RE.test(id) || id === "." || id === "..") return null;
  const path = safeArtifactPath(artifactsDir, id, false);
  if (!path || !existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    return null;
  }
}

export function writeArtifact<T = unknown>(artifactsDir: string, id: string, data: T): string {
  assertArtifactId(id);
  mkdirSync(artifactsDir, { recursive: true });
  const path = safeArtifactPath(artifactsDir, id, true);
  if (!path) throw new Error(`unsafe artifact path: ${id}`);
  const body = JSON.stringify(data, null, 2) + "\n";
  const tempPath = join(artifactsDir, `.artifact.${randomUUID()}.tmp`);
  try {
    writeFileSync(tempPath, body, "utf8");
    renameSync(tempPath, path);
  } catch (error) {
    try {
      if (existsSync(tempPath)) unlinkSync(tempPath);
    } catch {
      // Best-effort cleanup must not hide the original write error.
    }
    throw error;
  }
  // Best-effort artifact_written telemetry (additive; never blocks the write).
  // The project root is derived from the `.work-state` segment of the
  // artifacts dir; dirs outside `.work-state` (e.g. scratch tests) skip it.
  const root = projectRootFromWorkStatePath(artifactsDir);
  if (root) {
    try {
      recordArtifactWritten(root, {
        artifactId: id,
        artifactPath: relative(root, path),
        artifactBytes: Buffer.byteLength(body, "utf8"),
      });
    } catch {
      // best-effort telemetry
    }
  }
  return path;
}

function safeArtifactPath(artifactsDir: string, id: string, forWrite: boolean): string | null {
  try {
    if (!existsSync(artifactsDir)) return null;
    const realRoot = realpathSync(artifactsDir);
    const path = join(artifactsDir, `${id}.json`);
    if (!existsSync(path)) {
      if (!forWrite || !isWithinTree(realRoot, realpathSync(artifactsDir))) return null;
      return path;
    }
    if (lstatSync(path).isSymbolicLink()) return null;
    const realPath = realpathSync(path);
    return isWithinTree(realRoot, realPath) ? path : null;
  } catch {
    return null;
  }
}

function isWithinTree(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !rel.startsWith(sep));
}

/** Project root = path prefix ending at the `.work-state` segment, if any. */
function projectRootFromWorkStatePath(dir: string): string | null {
  const parts = dir.split(sep);
  const idx = parts.indexOf(".work-state");
  if (idx <= 0) return null;
  return parts.slice(0, idx).join(sep) || sep;
}

export function readAllArtifacts(artifactsDir: string): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  if (!existsSync(artifactsDir)) return result;
  const files = require("node:fs").readdirSync(artifactsDir) as string[];
  for (const file of files) {
    if (!file.endsWith(".json")) continue;
    const id = file.replace(/\.json$/, "");
    const data = readArtifact(artifactsDir, id);
    if (data !== null) result[id] = data;
  }
  return result;
}
