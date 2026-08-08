/**
 * Typed artifact I/O. Stages declare `consumes` and `produces` artifact ids;
 * the engine reads/writes them under `.work-state/artifacts/<id>.json` (or per-feature
 * subdir, set by `state.ts`).
 *
 * The schema is the same as claude-plugin's `workflows/artifacts-schema.json`.
 * We don't validate every field here — the engine only checks that the JSON
 * parses and matches the type name — but the schema is preserved for ref.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { recordArtifactWritten } from "../observability/hooks.js";

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

export interface ArtifactResult<T> {
  id: string;
  path: string;
  data: T;
}

export function readArtifact<T = unknown>(artifactsDir: string, id: string): T | null {
  const path = join(artifactsDir, `${id}.json`);
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    return null;
  }
}

export function writeArtifact<T = unknown>(artifactsDir: string, id: string, data: T): string {
  mkdirSync(artifactsDir, { recursive: true });
  const path = join(artifactsDir, `${id}.json`);
  const body = JSON.stringify(data, null, 2) + "\n";
  writeFileSync(path, body, "utf8");
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
