/**
 * Canonical report-source path utilities and the explicit CTO namespace.
 *
 * Ordinary report state is read only through `canonical-source.ts` with an
 * explicit run id and optional revision. This module intentionally contains
 * no feature-slug, `.active-feature`, legacy `team-state.json`, markdown
 * fallback, or newest-by-timestamp ordinary report reader. Legacy ordinary
 * state is available only through the explicit migration/import path.
 *
 * CTO runs are a separate durable namespace. Their exact JSON state may be
 * read or listed here; an omitted CTO id never means latest, and markdown is
 * not a runtime report source.
 */

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";

import { readCtoState } from "../cto/state.js";
import type { CtoState } from "../cto/types.js";

export const WORK_STATE_DIR = ".work-state";
export const CTO_DIR = "cto";
export const TEAM_ARTIFACTS_DIR = "artifacts";

export type SessionSourceStatus = "ok" | "degraded" | "error";

/** Marker names used by the separate visualization projection. */
export const CTO_MD_EVIDENCE: readonly string[] = ["team-plan.md", "decisions.md", "cto_discovery.md"];
export const CTO_MD_FINISH_MARKERS: readonly string[] = [
  "summary.md",
  "summary.json",
  "integration_review.md",
  "integration_review.json",
];

/** Names that are never accepted as artifact inputs by a projection. */
export const EXCLUDED_SOURCE_NAMES: Record<string, true> = {
  visualize: true,
  "vibe-report": true,
  "events.jsonl": true,
};

/** A discovered CTO run in the durable JSON namespace. */
export interface CtoSessionSource {
  kind: "cto";
  id: string;
  state: CtoState | null;
  statePath: string;
  runDir: string;
  format: "json";
  status: SessionSourceStatus;
  error?: string;
  updatedAt: string | null;
}

/** Exact-selector result for a readable CTO JSON state. */
export type ResolvedCto = CtoSessionSource & { state: CtoState; status: "ok" };

function isSinglePathSegment(value: string): boolean {
  return value.length > 0 && value !== "." && value !== ".." && !value.includes("/") && !value.includes(sep) && !value.includes("\0");
}

/**
 * Resolve one CTO run by exact id only. A missing id, markdown-only run, or
 * corrupt state returns null; no latest/newest or other namespace fallback is
 * permitted.
 */
export function resolveCtoSource(cwd: string, id?: string): ResolvedCto | null {
  if (!id || !isSinglePathSegment(id)) return null;
  const runDir = resolve(cwd, WORK_STATE_DIR, CTO_DIR, id);
  const statePath = join(runDir, "state.json");
  if (!existsSync(statePath)) return null;
  const state = readCtoState(id, cwd);
  if (!state) return null;
  return {
    kind: "cto",
    id,
    state,
    statePath,
    runDir,
    format: "json",
    status: "ok",
    updatedAt: state.updated_at,
  };
}

/**
 * Enumerate exact CTO JSON runs deterministically for a list projection.
 * Enumeration never selects one run and never reads markdown fallback state.
 */
export function listCtoSources(cwd: string): CtoSessionSource[] {
  const runsDir = resolve(cwd, WORK_STATE_DIR, CTO_DIR);
  if (!existsSync(runsDir)) return [];
  let names: string[];
  try {
    names = readdirSync(runsDir);
  } catch {
    return [];
  }
  const out: CtoSessionSource[] = [];
  for (const id of names) {
    if (!isSinglePathSegment(id)) continue;
    const runDir = join(runsDir, id);
    const statePath = join(runDir, "state.json");
    try {
      if (!statSync(runDir).isDirectory() || !statSync(statePath).isFile()) continue;
    } catch {
      continue;
    }
    const state = readCtoState(id, cwd);
    if (state) {
      out.push({ kind: "cto", id, state, statePath, runDir, format: "json", status: "ok", updatedAt: state.updated_at });
    } else {
      out.push({ kind: "cto", id, state: null, statePath, runDir, format: "json", status: "error", error: "unreadable state.json", updatedAt: null });
    }
  }
  return out.sort((a, b) => {
    const at = a.updatedAt ?? "";
    const bt = b.updatedAt ?? "";
    if (at !== bt) return at < bt ? 1 : -1;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
}

/** CTO team artifacts live under `.work-state/artifacts/<teamId>/.` */
export function ctoTeamArtifactsDir(cwd: string, teamId: string): string {
  return join(cwd, WORK_STATE_DIR, TEAM_ARTIFACTS_DIR, teamId);
}

/**
 * True when an absolute path must never be treated as a canonical artifact
 * input: generated visualize output, vibe-report documentation, or an
 * observability event stream.
 */
export function isExcludedSourcePath(cwd: string, absPath: string): boolean {
  const p = resolve(absPath);
  if (basename(p) === "events.jsonl") return true;
  for (const root of [resolve(cwd, WORK_STATE_DIR, "visualize"), resolve(cwd, "vibe-report")]) {
    const rel = relative(root, p);
    if (rel === "" || (!rel.startsWith("..") && !isAbsolute(rel))) return true;
  }
  return false;
}
