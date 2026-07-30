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
import { join } from "node:path";

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
  writeFileSync(path, JSON.stringify(data, null, 2) + "\n", "utf8");
  return path;
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
