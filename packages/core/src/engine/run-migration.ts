import { createHash, randomUUID } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { beginLifecycleTransaction, commitLifecycleTransaction, type LifecycleFileContent } from "./lifecycle-journal.js";
import { normalizePersistedState } from "./state.js";
import { candidateForState, readRunControl, runTarget } from "./run-store.js";
import { withWorkspaceTransaction } from "./state.js";
import type { RunCandidate, RunControl, TeamState, TrustedExecutionContext } from "./types.js";

const WORK_STATE = ".work-state";
const FEATURES = "features";
const RUNS = "runs";
const LEGACY_ARCHIVE = "legacy-archive";
const MIGRATIONS = "migrations";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

interface CollectedSourceFile { relative: string; content: LifecycleFileContent; source_path: string; source_kind: "artifacts" | "state"; }

export interface LegacySource {
  source_id: string;
  kind: "root" | "feature";
  state_path: string;
  state_dir: string;
  artifacts_dir: string;
  /** Lexical trusted workspace root; canonicalized for containment checks. */
  workspace_root?: string;
  raw_state: string;
  state: Record<string, unknown>;
  source_hash: string;
}

export interface LegacyDiscoveryIssue {
  source_id: string;
  path: string;
  code: "unreadable" | "unknown_schema" | "unsafe_path";
  error: string;
}

export interface LegacyDiscovery {
  sources: LegacySource[];
  issues: LegacyDiscoveryIssue[];
}

export interface MigrationPreflight {
  ok: true;
  source: LegacySource;
  migration_id: string;
  run_id: string;
  existing_run_id?: string;
  succeeded_slots: Array<{ dispatch_id: string; slot_id?: string; artifact_ids: string[] }>;
  referenced_paths: string[];
}

export interface MigrationFailure {
  ok: false;
  code: "migration_required" | "migration_conflict" | "run_busy" | "run_state_invalid" | "recovery_required";
  error: string;
  source_id?: string;
  unchanged: true;
}

export interface MigrationResult {
  ok: true;
  migration_id: string;
  run_id: string;
  source_id: string;
  source_hash: string;
  state_path: string;
  archived_path: string | null;
  succeeded_slots: Array<{ dispatch_id: string; slot_id?: string; artifact_ids: string[] }>;
}

export type MigrationOutcome = MigrationResult | MigrationFailure;

function within(root: string, candidate: string): boolean {
  const rel = relative(resolve(root), resolve(candidate));
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

function safeSegment(value: string): boolean {
  return value.length > 0 && value !== "." && value !== ".." && !value.includes("/") && !value.includes("\\") && !value.includes("\0");
}

function digest(value: string | LifecycleFileContent | Buffer): string {
  if (Buffer.isBuffer(value)) return createHash("sha256").update(value).digest("hex");
  if (typeof value === "string") return createHash("sha256").update(value, "utf8").digest("hex");
  if (value && typeof value === "object" && value.encoding === "base64") return createHash("sha256").update(Buffer.from(value.data, "base64")).digest("hex");
  return createHash("sha256").update("", "utf8").digest("hex");
}

function sourceHash(stateRaw: string, files: Array<{ relative: string; content: LifecycleFileContent }>): string {
  const hash = createHash("sha256");
  hash.update(stateRaw, "utf8");
  for (const file of files.sort((left, right) => left.relative.localeCompare(right.relative))) {
    hash.update("\0", "utf8").update(file.relative, "utf8").update("\0", "utf8");
    if (typeof file.content === "string") hash.update(file.content, "utf8");
    else if (file.content) hash.update(Buffer.from(file.content.data, "base64"));
  }
  return hash.digest("hex");
}

function readLegacyState(path: string): { raw: string; state: Record<string, unknown> } {
  const raw = readFileSync(path, "utf8");
  const parsed: unknown = JSON.parse(raw);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("legacy state is not an object");
  return { raw, state: parsed as Record<string, unknown> };
}

function collectTextFiles(root: string, sourceKind: "artifacts" | "state"): CollectedSourceFile[] {
  const files: CollectedSourceFile[] = [];
  if (!existsSync(root)) return files;
  const rootInfo = lstatSync(root);
  if (rootInfo.isSymbolicLink()) throw new Error(`legacy source contains symlink '${root}'`);
  if (!rootInfo.isDirectory()) throw new Error(`legacy source path is not a directory '${root}'`);
  const visit = (current: string): void => {
    const currentInfo = lstatSync(current);
    if (currentInfo.isSymbolicLink()) throw new Error(`legacy source contains symlink '${current}'`);
    for (const name of readdirSync(current)) {
      if (name === ".active-feature") continue;
      const filePath = join(current, name);
      const info = lstatSync(filePath);
      if (info.isSymbolicLink()) throw new Error(`legacy source contains symlink '${filePath}'`);
      if (info.isDirectory()) visit(filePath);
      else if (info.isFile()) {
        const bytes = readFileSync(filePath);
        let content: LifecycleFileContent;
        if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
          try { content = "\ufeff" + new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(3)); }
          catch { content = { encoding: "base64", data: bytes.toString("base64") }; }
        } else {
          try { content = new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
          catch { content = { encoding: "base64", data: bytes.toString("base64") }; }
        }
        files.push({ relative: relative(root, filePath).split(sep).join("/"), content, source_path: filePath, source_kind: sourceKind });
      }
    }
  };
  visit(root);
  return files;
}

function canonicalWorkspaceRoot(root: string): string {
  const lexical = resolve(root);
  try { return realpathSync(lexical); } catch { return lexical; }
}

function canonicalizePathWithExistingAncestor(path: string): string {
  const candidate = resolve(path);
  let existing = candidate;
  for (;;) {
    if (existsSync(existing)) {
      const real = realpathSync(existing);
      return resolve(real, relative(existing, candidate));
    }
    const parent = dirname(existing);
    if (parent === existing) return candidate;
    existing = parent;
  }
}

function assertNoSymlinkPathAncestors(path: string, workspaceRoot: string): void {
  const lexicalRoot = resolve(workspaceRoot);
  const candidate = resolve(path);
  if (!within(lexicalRoot, candidate)) throw new Error(`legacy source path escapes trusted workspace '${path}'`);
  const canonicalRoot = canonicalWorkspaceRoot(lexicalRoot);
  const canonicalCandidate = canonicalizePathWithExistingAncestor(candidate);
  if (!within(canonicalRoot, canonicalCandidate)) throw new Error(`legacy source path escapes trusted workspace '${path}'`);
  let current = candidate;
  for (;;) {
    if (current === lexicalRoot) break;
    if (existsSync(current) && lstatSync(current).isSymbolicLink()) throw new Error(`legacy source path contains symlink '${current}'`);
    const parent = dirname(current);
    if (parent === current || !within(lexicalRoot, parent)) throw new Error(`legacy source path escapes trusted workspace '${path}'`);
    current = parent;
  }
}

function trustedWorkspaceSpellings(workspaceRoot: string): string[] {
  const lexicalRoot = resolve(workspaceRoot);
  const canonicalRoot = canonicalWorkspaceRoot(lexicalRoot);
  const spellings = new Set<string>([lexicalRoot, canonicalRoot]);
  // Discover aliases of canonical ancestors (not arbitrary reference paths),
  // notably macOS /var -> /private/var. The alias is trusted only when its
  // real target is an ancestor of this already-trusted canonical workspace.
  const scanDirs = new Set<string>([dirname(canonicalRoot), "/"]);
  for (const directory of scanDirs) {
    try {
      for (const name of readdirSync(directory)) {
        const alias = join(directory, name);
        try {
          if (!lstatSync(alias).isSymbolicLink()) continue;
          const real = realpathSync(alias);
          if (!within(real, canonicalRoot)) continue;
          spellings.add(join(alias, relative(real, canonicalRoot)));
        } catch {
          // A concurrently removed/unreadable alias is not trusted.
        }
      }
    } catch {
      // Parent metadata may be unreadable; existing spellings remain valid.
    }
  }
  return [...spellings];
}

function trustedAbsoluteReference(source: LegacySource, reference: string): string {
  const absolute = resolve(reference);
  const lexicalRoot = resolve(source.workspace_root ?? deriveWorkspaceRoot(source.state_dir));
  for (const spelling of trustedWorkspaceSpellings(lexicalRoot)) {
    if (within(spelling, absolute)) return join(lexicalRoot, relative(spelling, absolute));
  }
  // Never realpath an arbitrary external reference: it must already be inside
  // a trusted workspace spelling before any filesystem read.
  return absolute;
}

function resolveReferencedFile(source: LegacySource, reference: string): { candidate: string; source_kind: "artifacts" | "state" } {
  if (reference.includes("\0")) throw new Error(`legacy reference contains NUL: '${reference}'`);
  if (!isAbsolute(reference) && reference.split(/[\\/]/).some((part) => part === "..")) throw new Error(`legacy reference escapes source: '${reference}'`);
  const roots: Array<{ root: string; source_kind: "state" | "artifacts" }> = [
    { root: source.state_dir, source_kind: "state" },
    { root: source.artifacts_dir, source_kind: "artifacts" },
  ];
  for (const entry of roots) {
    const candidate = isAbsolute(reference) ? trustedAbsoluteReference(source, reference) : resolve(entry.root, reference);
    if (!within(entry.root, candidate)) continue;
    // Containment and every ancestor below the trusted workspace are checked before existence/lstat/read.
    const workspaceRoot = source.workspace_root ?? deriveWorkspaceRoot(source.state_dir);
    assertNoSymlinkPathAncestors(entry.root, workspaceRoot);
    assertNoSymlinkPathAncestors(candidate, workspaceRoot);
    if (!existsSync(candidate)) continue;
    const info = lstatSync(candidate);
    if (info.isSymbolicLink() || !info.isFile()) throw new Error(`legacy reference is not a regular file: '${reference}'`);
    return { candidate, source_kind: entry.source_kind };
  }
  throw new Error(`legacy reference is missing or escapes source: '${reference}'`);
}

function decodeSourceBytes(bytes: Buffer): LifecycleFileContent {
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    try { return "\ufeff" + new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(3)); }
    catch { return { encoding: "base64", data: bytes.toString("base64") }; }
  }
  try { return new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
  catch { return { encoding: "base64", data: bytes.toString("base64") }; }
}

function deriveWorkspaceRoot(stateDir: string): string {
  let current = resolve(stateDir);
  for (;;) {
    if (basename(current) === WORK_STATE) return dirname(current);
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return dirname(resolve(stateDir));
}

function collectSourceFiles(source: LegacySource): CollectedSourceFile[] {
  const workspaceRoot = source.workspace_root ?? deriveWorkspaceRoot(source.state_dir);
  assertNoSymlinkPathAncestors(source.state_dir, workspaceRoot);
  assertNoSymlinkPathAncestors(source.artifacts_dir, workspaceRoot);
  const files = [...collectTextFiles(source.artifacts_dir, "artifacts")];
  const observability = join(source.state_dir, "observability");
  assertNoSymlinkPathAncestors(observability, workspaceRoot);
  files.push(...collectTextFiles(observability, "state").map((file) => ({ ...file, relative: `observability/${file.relative}` })));
  // Validate containment and symlink status before resolving or reading any referenced bytes.
  const references = validateReferences(source);
  const seen = new Set(files.map((file) => resolve(file.source_path)));
  for (const reference of references) {
    const resolved = resolveReferencedFile(source, reference);
    const candidate = resolve(resolved.candidate);
    if (candidate === resolve(source.state_path) || seen.has(candidate)) continue;
    const base = resolved.source_kind === "artifacts" ? source.artifacts_dir : source.state_dir;
    const content = decodeSourceBytes(readFileSync(candidate));
    seen.add(candidate);
    files.push({ relative: relative(base, candidate).split(sep).join("/"), content, source_path: candidate, source_kind: resolved.source_kind });
  }
  return files.sort((left, right) => left.relative.localeCompare(right.relative) || left.source_kind.localeCompare(right.source_kind));
}

function assertNoSymlinkAncestors(cwd: string, path: string): void {
  let current = resolve(path);
  const root = resolve(cwd);
  while (within(root, current)) {
    if (current === root) break;
    if (existsSync(current)) {
      const info = lstatSync(current);
      if (info.isSymbolicLink()) throw new Error(`legacy source path contains symlink '${current}'`);
    }
    current = dirname(current);
  }
}

function sourceFromPath(cwd: string, kind: LegacySource["kind"], sourceId: string, statePath: string, stateDir: string, artifactsDir: string): LegacySource {
  const workspaceRoot = resolve(cwd);
  assertNoSymlinkAncestors(workspaceRoot, stateDir);
  assertNoSymlinkAncestors(workspaceRoot, statePath);
  assertNoSymlinkAncestors(workspaceRoot, artifactsDir);
  assertNoSymlinkAncestors(workspaceRoot, join(stateDir, "observability"));
  const loaded = readLegacyState(statePath);
  const schema = loaded.state.schema;
  if (schema !== undefined && schema !== 1) throw new Error(`unsupported legacy schema '${String(schema)}'`);
  const files = collectSourceFiles({ source_id: sourceId, kind, state_path: statePath, state_dir: stateDir, artifacts_dir: artifactsDir, workspace_root: workspaceRoot, raw_state: loaded.raw, state: loaded.state, source_hash: "" } as LegacySource);
  const rawState = loaded.raw;
  return {
    source_id: sourceId,
    kind,
    state_path: statePath,
    state_dir: stateDir,
    artifacts_dir: artifactsDir,
    workspace_root: workspaceRoot,
    raw_state: rawState,
    state: loaded.state,
    source_hash: sourceHash(rawState, files),
  };
}

export function discoverLegacySources(cwd: string): LegacyDiscovery {
  const root = resolve(cwd, WORK_STATE);
  const sources: LegacySource[] = [];
  const issues: LegacyDiscoveryIssue[] = [];
  const add = (kind: LegacySource["kind"], sourceId: string, statePath: string, stateDir: string, artifactsDir: string): void => {
    try {
      if (!existsSync(statePath)) return;
      sources.push(sourceFromPath(cwd, kind, sourceId, statePath, stateDir, artifactsDir));
    } catch (error) {
      const message = String(error);
      issues.push({ source_id: sourceId, path: statePath, code: /schema/i.test(message) ? "unknown_schema" : /symlink|path/i.test(message) ? "unsafe_path" : "unreadable", error: message });
    }
  };
  add("root", "legacy", join(root, "team-state.json"), root, join(root, "artifacts"));
  const features = join(root, FEATURES);
  if (existsSync(features)) {
    for (const slug of readdirSync(features).sort()) {
      if (!safeSegment(slug)) {
        issues.push({ source_id: `feature:${slug}`, path: join(features, slug), code: "unsafe_path", error: "feature slug is unsafe" });
        continue;
      }
      const dir = join(features, slug);
      try {
        if (!lstatSync(dir).isDirectory()) continue;
      } catch {
        continue;
      }
      add("feature", `feature:${slug}`, join(dir, "state.json"), dir, join(dir, "artifacts"));
    }
  }
  return { sources: sources.sort((left, right) => left.source_id.localeCompare(right.source_id)), issues };
}

function isStructuredReferenceKey(key: string): boolean {
  const normalized = key.replace(/[A-Z]/g, (letter) => "_" + letter.toLowerCase());
  return normalized === "path"
    || normalized === "paths"
    || normalized === "artifact_refs"
    || normalized === "evidence_refs"
    || normalized === "document_refs"
    || normalized === "references"
    || normalized === "file_paths"
    || /(?:^|_)(?:path|paths)$/.test(normalized);
}

function referencedPaths(source: LegacySource): string[] {
  const paths = new Set<string>();
  const walk = (value: unknown, key = "", inheritedReferenceArray = false): void => {
    const referenceKey = isStructuredReferenceKey(key);
    if (typeof value === "string") {
      if (referenceKey || inheritedReferenceArray) paths.add(value);
      return;
    }
    if (Array.isArray(value)) {
      for (const entry of value) walk(entry, key, referenceKey || inheritedReferenceArray);
      return;
    }
    if (!value || typeof value !== "object") return;
    for (const [childKey, child] of Object.entries(value as Record<string, unknown>)) walk(child, childKey);
  };
  walk(source.state);
  const artifacts = source.state.artifacts;
  if (artifacts !== undefined) {
    if (!artifacts || typeof artifacts !== "object" || Array.isArray(artifacts)) throw new Error("legacy artifacts map is not an object");
    for (const [artifactId, path] of Object.entries(artifacts as Record<string, unknown>)) {
      if (typeof path !== "string" || !path.trim()) throw new Error("legacy artifact map entry " + artifactId + " is not a path");
      paths.add(path);
    }
  }
  return [...paths].sort();
}

function validateReferences(source: LegacySource): string[] {
  const references = referencedPaths(source);
  for (const reference of references) resolveReferencedFile(source, reference);
  return references;
}

function hasActiveLegacyExecution(state: Record<string, unknown>): boolean {
  const activeStatuses = new Set(["authorized", "running", "pending"]);
  if (state.pending && typeof state.pending === "object") return true;
  const capability = state.dispatch_capability;
  if (!capability || typeof capability !== "object") return false;
  const value = capability as Record<string, unknown>;
  if (Array.isArray(value.pending) && value.pending.some((entry) => entry && typeof entry === "object" && activeStatuses.has(String((entry as Record<string, unknown>).status)))) return true;
  if (Array.isArray(value.dispatches) && value.dispatches.some((entry) => entry && typeof entry === "object" && activeStatuses.has(String((entry as Record<string, unknown>).status)))) return true;
  return false;
}

const LEGACY_DISPATCH_STATUSES = new Set(["authorized", "running", "pending", "succeeded", "failed", "cancelled"]);

function legacyDispatchLedgerIssue(state: Record<string, unknown>): string | null {
  const capability = state.dispatch_capability;
  if (capability === undefined || capability === null) return null;
  if (!capability || typeof capability !== "object" || Array.isArray(capability)) return "legacy dispatch capability is malformed";
  const value = capability as Record<string, unknown>;
  const capabilityStatuses = new Set(["ready", "dispatched", "joining", "complete", "invalidated"]);
  if (typeof value.status !== "string" || !capabilityStatuses.has(value.status)) return "legacy dispatch capability has an unknown status";
  if (!Array.isArray(value.dispatches)) return "legacy dispatch capability.dispatches is missing or not an array";
  const succeededSlotCounts = new Map<string, number>();
  for (const candidate of value.dispatches) {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) continue;
    const row = candidate as Record<string, unknown>;
    if (row.status !== "succeeded") continue;
    const rowIdentity = row.work_identity && typeof row.work_identity === "object" && !Array.isArray(row.work_identity) ? row.work_identity as Record<string, unknown> : undefined;
    const stage = typeof rowIdentity?.stage_id === "string"
      ? rowIdentity.stage_id
      : typeof state.stage_cursor === "string" ? state.stage_cursor : "";
    const role = typeof row.role === "string" ? row.role : "";
    const key = `${stage}\0${role}`;
    succeededSlotCounts.set(key, (succeededSlotCounts.get(key) ?? 0) + 1);
  }
  const succeededSlotIds = new Set<string>();
  const succeededSlotOccurrences = new Map<string, number>();
  for (const key of ["dispatches", "pending"]) {
    const entries = value[key];
    if (entries === undefined) continue;
    if (!Array.isArray(entries)) return "legacy dispatch capability." + key + " is not an array";
    for (let index = 0; index < entries.length; index += 1) {
      const entry = entries[index];
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) return "legacy dispatch capability." + key + "[" + index + "] is malformed";
      const status = (entry as Record<string, unknown>).status;
      if (typeof status !== "string" || !LEGACY_DISPATCH_STATUSES.has(status)) return "legacy dispatch capability." + key + "[" + index + "] has an unknown status";
      if (key === "dispatches" && status === "succeeded") {
        const record = entry as Record<string, unknown>;
        const dispatchId = record.id;
        if (typeof dispatchId !== "string") return "legacy dispatch capability.dispatches[" + index + "] has no dispatch id";
        const completionValue = record.completion;
        if (!completionValue || typeof completionValue !== "object" || Array.isArray(completionValue)) {
          return "legacy dispatch capability.dispatches[" + index + "] has no valid completion";
        }
        const completion = completionValue as Record<string, unknown>;
        if (completion.outcome !== "succeeded") return "legacy dispatch capability.dispatches[" + index + "] completion outcome is not succeeded";
        if (completion.dispatch_id !== undefined && completion.dispatch_id !== dispatchId) {
          return "legacy dispatch capability.dispatches[" + index + "] completion dispatch id does not match record id";
        }
        const recordIdentityValue = record.work_identity;
        let recordIdentity: Record<string, unknown> | undefined;
        if (recordIdentityValue !== undefined) {
          if (!recordIdentityValue || typeof recordIdentityValue !== "object" || Array.isArray(recordIdentityValue)) {
            return "legacy dispatch capability.dispatches[" + index + "] work identity is malformed";
          }
          recordIdentity = recordIdentityValue as Record<string, unknown>;
          if (recordIdentity.dispatch_id !== undefined && recordIdentity.dispatch_id !== dispatchId) {
            return "legacy dispatch capability.dispatches[" + index + "] work identity dispatch id does not match record id";
          }
          if (recordIdentity.stage_id !== undefined && typeof recordIdentity.stage_id !== "string") {
            return "legacy dispatch capability.dispatches[" + index + "] work identity stage is malformed";
          }
          if (recordIdentity.slot_id !== undefined && typeof recordIdentity.slot_id !== "string") {
            return "legacy dispatch capability.dispatches[" + index + "] work identity slot is malformed";
          }
        }
        const explicitStage = typeof recordIdentity?.stage_id === "string"
          ? recordIdentity.stage_id
          : typeof state.stage_cursor === "string" ? state.stage_cursor : "";
        const expectedStage = explicitStage;
        if (recordIdentity?.stage_cursor !== undefined && (typeof recordIdentity.stage_cursor !== "string" || recordIdentity.stage_cursor !== expectedStage)) {
          return "legacy dispatch capability.dispatches[" + index + "] work identity stage cursor does not match source stage";
        }
        const role = typeof record.role === "string" ? record.role : "";
        const roleKey = `${expectedStage}\0${role}`;
        const occurrence = (succeededSlotOccurrences.get(roleKey) ?? 0) + 1;
        succeededSlotOccurrences.set(roleKey, occurrence);
        const explicitSlot = typeof recordIdentity?.slot_id === "string" ? recordIdentity.slot_id : undefined;
        const projectedSlot = explicitSlot ?? ((succeededSlotCounts.get(roleKey) ?? 0) > 1 ? role + "#" + occurrence : role);
        const slotKey = `${expectedStage}\0${projectedSlot}`;
        if (succeededSlotIds.has(slotKey)) return "legacy dispatch capability.dispatches[" + index + "] reuses a succeeded migration slot id";
        succeededSlotIds.add(slotKey);
        const completionIdentityValue = completion.work_identity;
        if (completionIdentityValue !== undefined) {
          if (!completionIdentityValue || typeof completionIdentityValue !== "object" || Array.isArray(completionIdentityValue)) {
            return "legacy dispatch capability.dispatches[" + index + "] completion work identity is malformed";
          }
          const completionIdentity = completionIdentityValue as Record<string, unknown>;
          if (completionIdentity.dispatch_id !== undefined && completionIdentity.dispatch_id !== dispatchId) {
            return "legacy dispatch capability.dispatches[" + index + "] completion work identity dispatch id does not match record id";
          }
          if (completionIdentity.stage_id !== undefined && (typeof completionIdentity.stage_id !== "string" || completionIdentity.stage_id !== expectedStage)) {
            return "legacy dispatch capability.dispatches[" + index + "] completion work identity stage does not match source stage";
          }
          if (completionIdentity.stage_cursor !== undefined && (typeof completionIdentity.stage_cursor !== "string" || completionIdentity.stage_cursor !== expectedStage)) {
            return "legacy dispatch capability.dispatches[" + index + "] completion work identity stage cursor does not match source stage";
          }
          const expectedSlot = projectedSlot;
          if (completionIdentity.slot_id !== undefined && (typeof completionIdentity.slot_id !== "string" || completionIdentity.slot_id !== expectedSlot)) {
            return "legacy dispatch capability.dispatches[" + index + "] completion work identity slot does not match source slot";
          }
        }
      }
    }
  }
  return null;
}

function succeededSlots(state: Record<string, unknown>): Array<{ dispatch_id: string; slot_id?: string; artifact_ids: string[] }> {
  const records = (state.dispatch_capability as Record<string, unknown> | undefined)?.dispatches;
  if (!Array.isArray(records)) return [];
  return records.flatMap((entry) => {
    if (!entry || typeof entry !== "object") return [];
    const value = entry as Record<string, unknown>;
    if (value.status !== "succeeded" || typeof value.id !== "string") return [];
    const completion = value.completion && typeof value.completion === "object" ? value.completion as Record<string, unknown> : undefined;
    const ids = Array.isArray(completion?.artifact_ids) ? completion.artifact_ids.filter((id): id is string => typeof id === "string") : [];
    const identity = value.work_identity && typeof value.work_identity === "object" ? value.work_identity as Record<string, unknown> : undefined;
    return [{ dispatch_id: value.id, role: typeof value.role === "string" ? value.role : "", agent: typeof value.agent === "string" ? value.agent : "", ...(typeof identity?.slot_id === "string" ? { slot_id: identity.slot_id } : {}), ...(typeof identity?.task_id === "string" ? { task_id: identity.task_id } : {}), artifact_ids: ids }];
  });
}

function existingMapping(cwd: string, source: LegacySource): string | undefined {
  const runsRoot = join(resolve(cwd, WORK_STATE), RUNS);
  if (!existsSync(runsRoot)) return undefined;
  for (const runId of readdirSync(runsRoot)) {
    if (!UUID.test(runId)) continue;
    const path = join(runsRoot, runId, "migration-receipt.json");
    if (!existsSync(path)) continue;
    try {
      const receipt = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
      if (receipt.source_id === source.source_id && receipt.source_hash === source.source_hash && typeof receipt.run_id === "string") return receipt.run_id;
    } catch {
      // malformed receipts are not mappings
    }
  }
  return undefined;
}

export function preflightLegacyMigration(cwd: string, source: LegacySource, context?: TrustedExecutionContext): MigrationPreflight | MigrationFailure {
  try {
    const runsRoot = join(resolve(cwd, WORK_STATE), RUNS);
    if (existsSync(runsRoot)) {
      for (const runId of readdirSync(runsRoot)) {
        if (!UUID.test(runId)) continue;
        const receiptPath = join(runsRoot, runId, "migration-receipt.json");
        if (!existsSync(receiptPath)) continue;
        try {
          const receipt = JSON.parse(readFileSync(receiptPath, "utf8")) as Record<string, unknown>;
          if (receipt.source_id !== source.source_id) continue;
          if (receipt.source_hash !== source.source_hash) return { ok: false, code: "migration_conflict", error: `legacy source '${source.source_id}' changed after its canonical mapping; refusing duplicate import`, source_id: source.source_id, unchanged: true };
        } catch { /* malformed receipt is handled as recovery by the canonical run reader */ }
      }
    }
    const mapped = existingMapping(cwd, source);
    if (mapped) return { ok: true, source, migration_id: "existing", run_id: mapped, existing_run_id: mapped, succeeded_slots: [], referenced_paths: validateReferences(source) };
    const references = validateReferences(source);
    const ledgerIssue = legacyDispatchLedgerIssue(source.state);
    if (ledgerIssue) return { ok: false, code: "recovery_required", error: "legacy source " + source.source_id + " has malformed dispatch history: " + ledgerIssue, source_id: source.source_id, unchanged: true };
    if (hasActiveLegacyExecution(source.state)) return { ok: false, code: "run_busy", error: `legacy source '${source.source_id}' has active or unknown dispatches; finish or verify the old executor before migration`, source_id: source.source_id, unchanged: true };
    const control = readRunControl(cwd);
    if (control.execution_claim) return { ok: false, code: "run_busy", error: `worktree is claimed by '${control.execution_claim.run_id}'`, source_id: source.source_id, unchanged: true };
    return { ok: true, source, migration_id: randomUUID(), run_id: randomUUID(), succeeded_slots: succeededSlots(source.state), referenced_paths: references };
  } catch (error) {
    const message = String(error);
    return { ok: false, code: /schema|identity/i.test(message) ? "migration_required" : "migration_conflict", error: message, source_id: source.source_id, unchanged: true };
  }
}

function migratedSucceededSlots(source: LegacySource, fallbackStage: string): Record<string, Array<{ dispatch_id: string; role: string; agent: string; slot_id?: string; task_id?: string; artifact_ids: string[] }>> {
  const records = source.state.dispatch_capability && typeof source.state.dispatch_capability === "object"
    ? (source.state.dispatch_capability as { dispatches?: unknown[] }).dispatches ?? []
    : [];
  const candidates = records.filter((entry): entry is Record<string, unknown> => Boolean(entry) && typeof entry === "object" && !Array.isArray(entry))
    .filter((entry) => entry.status === "succeeded" && typeof entry.id === "string");
  const stageFor = (entry: Record<string, unknown>): string => {
    const identity = entry.work_identity && typeof entry.work_identity === "object" && !Array.isArray(entry.work_identity) ? entry.work_identity as Record<string, unknown> : undefined;
    return typeof identity?.stage_id === "string" ? identity.stage_id : fallbackStage;
  };
  const roleCounts = new Map<string, number>();
  for (const entry of candidates) {
    const role = typeof entry.role === "string" ? entry.role : "";
    const key = `${stageFor(entry)}\0${role}`;
    roleCounts.set(key, (roleCounts.get(key) ?? 0) + 1);
  }
  const roleSeen = new Map<string, number>();
  const groups: Record<string, Array<{ dispatch_id: string; role: string; agent: string; slot_id?: string; task_id?: string; artifact_ids: string[] }>> = {};
  for (const value of candidates) {
    const identity = value.work_identity && typeof value.work_identity === "object" && !Array.isArray(value.work_identity) ? value.work_identity as Record<string, unknown> : undefined;
    const role = typeof value.role === "string" ? value.role : "";
    const stageId = stageFor(value);
    const roleKey = `${stageId}\0${role}`;
    const occurrence = (roleSeen.get(roleKey) ?? 0) + 1;
    roleSeen.set(roleKey, occurrence);
    const explicitSlotId = typeof identity?.slot_id === "string" ? identity.slot_id : undefined;
    const slotId = explicitSlotId ?? ((roleCounts.get(roleKey) ?? 0) > 1 ? role + "#" + occurrence : role);
    const completion = value.completion && typeof value.completion === "object" && !Array.isArray(value.completion) ? value.completion as Record<string, unknown> : undefined;
    const artifactIds = Array.isArray(completion?.artifact_ids) ? completion.artifact_ids.filter((id): id is string => typeof id === "string") : [];
    (groups[stageId] ??= []).push({
      dispatch_id: value.id as string,
      role,
      agent: typeof value.agent === "string" ? value.agent : "",
      slot_id: slotId,
      ...(typeof identity?.task_id === "string" ? { task_id: identity.task_id } : {}),
      artifact_ids: artifactIds,
    });
  }
  return groups;
}

function migratedState(source: LegacySource, runId: string, migrationId: string): TeamState {
  const issues: string[] = [];
  // Historical dispatch capability and control-plane projections are retained
  // verbatim in the immutable source revision, but must not pass through the
  // live schema validator: legacy records may be identity-less and have no
  // canonical authority. Normalize only the authority-free retained state.
  const {
    dispatch_capability: _legacyDispatch,
    work_identity: _legacyIdentity,
    pending: _legacyPending,
    completion_envelope: _legacyCompletion,
    child_join: _legacyChildJoin,
    child_joins: _legacyChildJoins,
    typed_checkpoint_decisions: _legacyTypedDecisions,
    cursor_epoch: _legacyCursorEpoch,
    checkpoint_decisions: _legacyCheckpointDecisions,
    trusted_checkpoint_answers: _legacyTrustedAnswers,
    required_input_receipts: _legacyRequiredInputReceipts,
    roster_selection: _legacyRosterSelection,
    roster_selections: _legacyRosterSelections,
    checkpoint_policy_binding: _legacyCheckpointPolicyBinding,
    loop_state: _legacyLoopState,
    ...legacyRetained
  } = source.state;
  const normalized = normalizePersistedState(legacyRetained, issues);
  if (!normalized) throw new Error(issues.join("; ") || "legacy state failed typed normalization");
  const {
    dispatch_capability: _dispatch,
    work_identity: _identity,
    pending: _pending,
    completion_envelope: _completion,
    child_join: _childJoin,
    child_joins: _childJoins,
    typed_checkpoint_decisions: _typedDecisions,
    cursor_epoch: _cursorEpoch,
    checkpoint_decisions: _checkpointDecisions,
    trusted_checkpoint_answers: _trustedCheckpointAnswers,
    required_input_receipts: _requiredInputReceipts,
    roster_selection: _rosterSelection,
    roster_selections: _rosterSelections,
    checkpoint_policy_binding: _checkpointPolicyBinding,
    loop_state: _loopState,
    ...retained
  } = normalized;
  const state = {
    ...retained,
    schema: 2 as const,
    run_id: runId,
    run_key: runId,
    state_revision: 1,
    rework_generation: 0,
    migration_succeeded_slots: migratedSucceededSlots(source, retained.stage_cursor),
    lifecycle_status: retained.lifecycle_status ?? "active",
    ...(retained.observability && !existsSync(join(source.state_dir, "observability")) ? { observability: undefined } : {}),
    migration: {
      id: migrationId,
      from_schema: 1,
      to_schema: 2,
      source_profile_hash: retained.profile_hash ?? "unresolved-profile",
      target_profile_hash: retained.profile_hash ?? "unresolved-profile",
      source_policy_hash: null,
      target_policy_hash: digest(JSON.stringify(retained.checkpoint_policy ?? null)),
      legacy_inputs: [source.source_id, source.state_path],
      warnings: ["active capability, pending work and typed checkpoint proofs were reset; historical evidence is in the migration revision", ...(retained.observability && !existsSync(join(source.state_dir, "observability")) ? ["optional observability evidence was unavailable at migration time"] : [])],
      status: "complete" as const,
      migrated_at: new Date().toISOString(),
    },
    updated_at: new Date().toISOString(),
  } as TeamState;
  if (state.schema !== 2 || state.run_id !== runId || state.run_key !== runId || state.dispatch_capability || state.pending || state.work_identity) {
    throw new Error("migrated state failed canonical schema-2 identity validation");
  }
  return state;
}

function controlAfter(control: RunControl, state: TeamState, runId: string): string {
  const next: RunControl = {
    ...control,
    revision: control.revision + 1,
    execution_claim: null,
    runs: { ...control.runs, [runId]: candidateForState(state) },
    selections: Object.fromEntries(Object.entries(control.selections).map(([id, selection]) => [id, { ...selection, active: false }])),
  };
  return `${JSON.stringify(next, null, 2)}\n`;
}

export function migrateLegacySource(cwd: string, source: LegacySource, context?: TrustedExecutionContext): MigrationOutcome {
  const mapped = existingMapping(cwd, source);
  if (mapped) return withWorkspaceTransaction(cwd, () => migrateLegacySourceLocked(cwd, source, context));
  const current = discoverLegacySources(cwd).sources.find((candidate) => candidate.source_id === source.source_id);
  if (!current) return { ok: false, code: "migration_conflict", error: `legacy source '${source.source_id}' is missing or was replaced`, source_id: source.source_id, unchanged: true };
  if (current.source_hash !== source.source_hash) return { ok: false, code: "migration_conflict", error: `legacy source '${source.source_id}' changed since preflight`, source_id: source.source_id, unchanged: true };
  return withWorkspaceTransaction(cwd, () => migrateLegacySourceLocked(cwd, current, context));
}

function rewriteMigratedReferences(
  value: unknown,
  source: LegacySource,
  targetDir: string,
  targetArtifactsDir: string,
  key = "",
  inheritedReferenceArray = false,
  root = false,
): unknown {
  const rewriteReference = (reference: string): string => {
    const resolved = resolveReferencedFile(source, reference);
    const base = resolved.source_kind === "artifacts" ? source.artifacts_dir : source.state_dir;
    const target = resolved.source_kind === "artifacts" ? targetArtifactsDir : targetDir;
    return join(target, relative(base, resolved.candidate));
  };
  const referenceKey = isStructuredReferenceKey(key);
  if (typeof value === "string") {
    return referenceKey || inheritedReferenceArray ? rewriteReference(value) : value;
  }
  if (Array.isArray(value)) {
    return value.map((entry) => rewriteMigratedReferences(entry, source, targetDir, targetArtifactsDir, key, referenceKey || inheritedReferenceArray));
  }
  if (!value || typeof value !== "object") return value;
  const entries = Object.entries(value as Record<string, unknown>);
  if (root) {
    const artifactMap = entries.find(([childKey]) => childKey === "artifacts");
    if (artifactMap && artifactMap[1] && typeof artifactMap[1] === "object" && !Array.isArray(artifactMap[1])) {
      const rewrittenArtifacts = Object.fromEntries(Object.entries(artifactMap[1] as Record<string, unknown>).map(([artifactId, artifactPath]) => [
        artifactId,
        typeof artifactPath === "string" ? rewriteReference(artifactPath) : artifactPath,
      ]));
      return Object.fromEntries(entries.map(([childKey, child]) => [childKey, childKey === "artifacts"
        ? rewrittenArtifacts
        : rewriteMigratedReferences(child, source, targetDir, targetArtifactsDir, childKey)]));
    }
  }
  return Object.fromEntries(entries.map(([childKey, child]) => [childKey, rewriteMigratedReferences(child, source, targetDir, targetArtifactsDir, childKey)]));
}

function migrateLegacySourceLocked(cwd: string, source: LegacySource, context?: TrustedExecutionContext): MigrationOutcome {
  // Refresh once under the workspace lock, then verify the exact snapshot
  // used below against the source hash accepted by preflight. This covers
  // file additions/removals as well as byte changes.
  const refreshed = sourceFromPath(cwd, source.kind, source.source_id, source.state_path, source.state_dir, source.artifacts_dir);
  if (refreshed.source_hash !== source.source_hash) return { ok: false, code: "migration_conflict", error: `legacy source '${source.source_id}' changed before publication`, source_id: source.source_id, unchanged: true };
  source = refreshed;
  const preflight = preflightLegacyMigration(cwd, source, context);
  if (!preflight.ok) return preflight;
  if (preflight.existing_run_id) return { ok: true, migration_id: preflight.migration_id, run_id: preflight.run_id, source_id: source.source_id, source_hash: source.source_hash, state_path: runTarget(cwd, preflight.run_id).statePath!, archived_path: null, succeeded_slots: preflight.succeeded_slots };
  const migrationId = preflight.migration_id;
  const runId = preflight.run_id;
  const target = runTarget(cwd, runId);
  const state = rewriteMigratedReferences(migratedState(source, runId, migrationId), source, target.stateDir ?? join(resolve(cwd, WORK_STATE), RUNS, runId), target.artifactsDir ?? join(resolve(cwd, WORK_STATE), RUNS, runId, "artifacts"), "", false, true) as TeamState;
  // Recollect the complete source manifest immediately before publication
  // and compare it to the accepted hash; additions/removals are covered too.
  const sourceFiles = collectSourceFiles(source);
  const finalRawState = readFileSync(source.state_path, "utf8");
  if (sourceHash(finalRawState, sourceFiles) !== source.source_hash) return { ok: false, code: "migration_conflict", error: `legacy source '${source.source_id}' changed before publication`, source_id: source.source_id, unchanged: true };
  const controlPath = join(resolve(cwd, WORK_STATE), "run-control.json");
  const control = readRunControl(cwd);
  const controlBefore = existsSync(controlPath) ? readFileSync(controlPath, "utf8") : null;
  const receiptPath = join(resolve(cwd, WORK_STATE), MIGRATIONS, migrationId, "receipt.json");
  const archivePathFor = (file: CollectedSourceFile): string => source.kind === "feature"
    ? (file.source_kind === "artifacts" ? join("artifacts", file.relative) : file.relative)
    : (file.source_kind === "artifacts" ? join("artifacts", file.relative) : join("state", file.relative));
  const migrationReceipt: { archived_path: string | null; [key: string]: unknown } = { migration_id: migrationId, source_id: source.source_id, source_path: source.state_path, source_hash: source.source_hash, state_sha256: digest(source.raw_state), file_manifest: sourceFiles.map((file) => ({ path: file.relative, source_kind: file.source_kind, source_path: file.source_path, sha256: digest(file.content), archive_path: archivePathFor(file) })), run_id: runId, status: "published", archived_path: null, succeeded_slots: preflight.succeeded_slots, created_at: new Date().toISOString() };
  const revisionRoot = join(target.stateDir!, "revisions", migrationId);
  const after: Record<string, LifecycleFileContent> = {
    [target.statePath!]: `${JSON.stringify(state, null, 2)}\n`,
    [controlPath]: controlAfter(control, state, runId),
    [receiptPath]: `${JSON.stringify(migrationReceipt, null, 2)}\n`,
    [join(revisionRoot, "state.json")]: source.raw_state,
    [join(revisionRoot, "legacy-source.json")]: `${JSON.stringify({ source_id: source.source_id, source_path: source.state_path, source_hash: source.source_hash, source_schema: source.state.schema ?? 1 }, null, 2)}\n`,
    [join(revisionRoot, "succeeded-slots.json")]: `${JSON.stringify({ source_id: source.source_id, source_hash: source.source_hash, slots: preflight.succeeded_slots }, null, 2)}\n`,
    [join(revisionRoot, "manifest.json")]: `${JSON.stringify({ source_id: source.source_id, source_hash: source.source_hash, state_sha256: digest(source.raw_state), files: sourceFiles.map((file) => ({ path: file.relative, source_kind: file.source_kind, source_path: file.source_path, sha256: digest(file.content), archive_path: archivePathFor(file) })) }, null, 2)}\n`,
    [join(target.stateDir!, "migration-receipt.json")]: `${JSON.stringify(migrationReceipt, null, 2)}\n`,
  };
  for (const file of sourceFiles) {
    const targetRoot = file.source_kind === "artifacts" ? target.artifactsDir! : target.stateDir!;
    after[join(targetRoot, file.relative)] = file.content;
    after[join(revisionRoot, file.source_kind === "artifacts" ? "artifacts" : "state", file.relative)] = file.content;
  }
  const sourceBefore: Record<string, LifecycleFileContent> = { [source.state_path]: source.raw_state };
  for (const file of sourceFiles) sourceBefore[file.source_path] = file.content;
  const transaction = beginLifecycleTransaction({
    cwd,
    operation: "migration",
    before: { ...sourceBefore, [target.statePath!]: null, [controlPath]: controlBefore, [receiptPath]: null },
    after,
  });
  commitLifecycleTransaction(cwd, transaction.transaction_id);
  let archivedPath: string | null = null;
  try {
    const archiveRoot = join(resolve(cwd, WORK_STATE), LEGACY_ARCHIVE, migrationId, source.kind === "feature" ? basename(source.state_dir) : "legacy-root");
    mkdirSync(dirname(archiveRoot), { recursive: true });
    if (source.kind === "feature") renameSync(source.state_dir, archiveRoot);
    else {
      mkdirSync(archiveRoot, { recursive: true });
      renameSync(source.state_path, join(archiveRoot, "team-state.json"));
      if (existsSync(source.artifacts_dir)) renameSync(source.artifacts_dir, join(archiveRoot, "artifacts"));
      for (const file of sourceFiles.filter((entry) => entry.source_kind === "state")) {
        if (!existsSync(file.source_path) || resolve(file.source_path) === resolve(source.state_path)) continue;
        const destination = join(archiveRoot, archivePathFor(file));
        mkdirSync(dirname(destination), { recursive: true });
        writeFileSync(destination, readFileSync(file.source_path));
      }
    }
    archivedPath = archiveRoot;
    migrationReceipt.archived_path = archiveRoot;
    writeFileSync(receiptPath, `${JSON.stringify(migrationReceipt, null, 2)}\n`, "utf8");
  } catch {
    // Canonical publication is authoritative; recovery will retry archival.
  }
  return { ok: true, migration_id: migrationId, run_id: runId, source_id: source.source_id, source_hash: source.source_hash, state_path: target.statePath!, archived_path: archivedPath, succeeded_slots: preflight.succeeded_slots };
}

function normalizeTrustedWorkspacePath(cwd: string, path: string): string {
  const lexicalRoot = resolve(cwd);
  const absolute = resolve(path);
  for (const spelling of trustedWorkspaceSpellings(lexicalRoot)) {
    if (within(spelling, absolute)) return join(lexicalRoot, relative(spelling, absolute));
  }
  return absolute;
}

function recoverLegacyMigrationsLocked(cwd: string): { repaired: string[]; pending: string[] } {

  const root = join(resolve(cwd, WORK_STATE), MIGRATIONS);
  const repaired: string[] = [];
  const pending: string[] = [];
  if (!existsSync(root)) return { repaired, pending };
  for (const migrationId of readdirSync(root)) {
    const receiptPath = join(root, migrationId, "receipt.json");
    if (!safeSegment(migrationId) || !existsSync(receiptPath)) continue;
    try {
      const receipt = JSON.parse(readFileSync(receiptPath, "utf8")) as Record<string, unknown>;
      if (receipt.status !== "published" || receipt.archived_path) continue;
      const recordedSourcePath = typeof receipt.source_path === "string" ? receipt.source_path : "";
      if (!recordedSourcePath) { pending.push(migrationId); continue; }
      // Receipt/manifest source_path values are immutable evidence; normalize only
      // their operational spelling against the current trusted workspace aliases.
      const sourcePath = normalizeTrustedWorkspacePath(cwd, recordedSourcePath);
      const sourceId = typeof receipt.source_id === "string" ? receipt.source_id : "";
      const archiveRoot = join(resolve(cwd, WORK_STATE), LEGACY_ARCHIVE, migrationId, sourceId.startsWith("feature:") ? sourceId.slice("feature:".length) : "legacy-root");
      if (!existsSync(sourcePath)) {
        const archivedState = sourceId.startsWith("feature:")
          ? existsSync(join(archiveRoot, "state.json"))
          : existsSync(join(archiveRoot, "team-state.json"));
        if (archivedState) {
          const manifest = Array.isArray(receipt.file_manifest) ? receipt.file_manifest as Array<{ archive_path?: unknown; source_path?: unknown; sha256?: unknown }> : null;
          const stateFile = sourceId.startsWith("feature:") ? join(archiveRoot, "state.json") : join(archiveRoot, "team-state.json");
          if (!manifest || typeof receipt.state_sha256 !== "string" || !existsSync(stateFile) || digest(readFileSync(stateFile, "utf8")) !== receipt.state_sha256) {
            receipt.status = "migration_conflict";
            receipt.conflict = "archived legacy receipt is missing its hash manifest or immutable state bytes changed";
            writeFileSync(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, "utf8");
            pending.push(migrationId);
            continue;
          }
          let valid = true;
          for (const entry of manifest) {
            if (typeof entry.archive_path !== "string" || typeof entry.sha256 !== "string") { valid = false; break; }
            const filePath = join(archiveRoot, entry.archive_path);
            if (!within(archiveRoot, filePath)) { valid = false; break; }
            const fallbackPath = typeof entry.source_path === "string"
              ? normalizeTrustedWorkspacePath(cwd, entry.source_path)
              : entry.archive_path.startsWith("artifacts/")
                ? join(dirname(sourcePath), entry.archive_path)
                : join(dirname(sourcePath), entry.archive_path.slice("state/".length));
            if (!within(dirname(sourcePath), fallbackPath)) { valid = false; break; }
            const candidate = existsSync(filePath) ? filePath : fallbackPath;
            if (!existsSync(candidate) || digest(readFileSync(candidate)) !== entry.sha256) { valid = false; break; }
            if (!existsSync(filePath)) {
              mkdirSync(dirname(filePath), { recursive: true });
              writeFileSync(filePath, readFileSync(candidate));
            }
          }
          if (!valid) {
            receipt.status = "migration_conflict";
            receipt.conflict = "archived legacy receipt file bytes changed before recovery finalization";
            writeFileSync(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, "utf8");
            pending.push(migrationId);
            continue;
          }
          if (!sourceId.startsWith("feature:")) {
            const remainingArtifacts = join(dirname(sourcePath), "artifacts");
            const archivedArtifacts = join(archiveRoot, "artifacts");
            if (existsSync(remainingArtifacts) && !existsSync(archivedArtifacts)) renameSync(remainingArtifacts, archivedArtifacts);
          }
          receipt.archived_path = archiveRoot;
          writeFileSync(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, "utf8");
          repaired.push(migrationId);
        } else pending.push(migrationId);
        continue;
      }
      try {
        const sourceDir = dirname(sourcePath);
        const artifactsDir = join(sourceDir, "artifacts");
        const source = sourceFromPath(cwd, sourceId.startsWith("feature:") ? "feature" : "root", sourceId, sourcePath, sourceDir, artifactsDir);
        if (typeof receipt.source_hash !== "string" || source.source_hash !== receipt.source_hash || (typeof receipt.state_sha256 === "string" && digest(source.raw_state) !== receipt.state_sha256)) {
          receipt.status = "migration_conflict";
          receipt.conflict = "legacy source changed before archival recovery; source was not moved";
          writeFileSync(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, "utf8");
          pending.push(migrationId);
          continue;
        }
      } catch {
        pending.push(migrationId);
        continue;
      }
      mkdirSync(dirname(archiveRoot), { recursive: true });
      const sourceForArchive = sourceId.startsWith("feature:") ? null : sourceFromPath(cwd, "root", sourceId, sourcePath, dirname(sourcePath), join(dirname(sourcePath), "artifacts"));
      if (sourceId.startsWith("feature:")) renameSync(dirname(sourcePath), archiveRoot);
      else {
        mkdirSync(archiveRoot, { recursive: true });
        renameSync(sourcePath, join(archiveRoot, "team-state.json"));
        const artifactsPath = join(dirname(sourcePath), "artifacts");
        if (existsSync(artifactsPath)) renameSync(artifactsPath, join(archiveRoot, "artifacts"));
        for (const file of collectSourceFiles(sourceForArchive!).filter((entry) => entry.source_kind === "state")) {
          if (!existsSync(file.source_path) || resolve(file.source_path) === resolve(sourcePath)) continue;
          const destination = join(archiveRoot, "state", file.relative);
          mkdirSync(dirname(destination), { recursive: true });
          writeFileSync(destination, readFileSync(file.source_path));
        }
      }
      receipt.archived_path = archiveRoot;
      writeFileSync(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, "utf8");
      repaired.push(migrationId);
    } catch {
      pending.push(migrationId);
    }
  }
  return { repaired, pending };
}

export function recoverLegacyMigrations(cwd: string): { repaired: string[]; pending: string[] } {
  return withWorkspaceTransaction(cwd, () => recoverLegacyMigrationsLocked(cwd));
}
