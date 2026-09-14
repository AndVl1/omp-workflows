/**
 * Authorized scratch-repository and runtime-evidence fixture builders for the
 * readable specification workflow, plus the registry of the immutable external
 * source bundles stored under `../fixtures/specification/`.
 *
 * slice=runtime-fixtures (T002 builders + T003 bundle registry of
 * specs/001-redesign-spec-workflow).
 *
 * Fixture discipline (contracts FR-054–FR-070, architecture §7):
 * - Bundle files under `fixtures/specification/` are INERT, immutable inputs.
 *   They are read byte-for-byte and never mutated by this module.
 * - Every builder is deterministic: fixed content, fixed epoch timestamps,
 *   stable sort order, SHA-256 digests computed from bytes (never baked in).
 * - Hazard fixtures (escaping symlinks, secret-like text, prompt injection,
 *   oversize files, unsupported binaries) are bounded during intake. Symlinks
 *   are captured with readlink only and can be materialized solely beneath an
 *   authorized scratch target so importer rejection can be exercised safely.
 *   Secret-like values are documented placeholders (EXAMPLE / zero-filled).
 * - No network access, no external framework CLI execution, no project
 */

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  constants as fsConstants,
  existsSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  readSync,
  realpathSync,
  renameSync,
  rmSync,
  rmdirSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, isAbsolute, join, parse, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  closePinnedDirectory,
  closePinnedFile,
  MAX_PINNED_READ_BYTES,
  openPinnedFile,
  pinDirectory,
  pinnedDirectoryIsStable,
  withPinnedExclusiveLock,
} from './fs-safety.js';
import type { PinnedDirectory } from './fs-safety.js';
import { prepareRuntimeScratchProject } from './runtime.js';

/* ------------------------------------------------------------------ */
/* Types                                                               */
/* ------------------------------------------------------------------ */

/** Framework families covered by the T003 fixture tree. */
export type SpecificationFrameworkId =
  | 'speckit'
  | 'openspec'
  | 'bmad'
  | 'superpowers'
  | 'xpowers'
  | 'generic';

/** Required bundle states per framework family. */
export type SpecificationBundleState =
  | 'complete'
  | 'incomplete'
  | 'ambiguous'
  | 'hostile'
  | 'legacy';

/**
 * What a conforming read-only intake (FR-061 vocabulary, fixture-side view)
 * should conclude for a bundle. Tests map this onto the import module's own
 * typed results; the fixture registry only fixes the expectation.
 */
export type SpecificationIntakeExpectation =
  /** Complete, compatible bundle; may reach one compatibility checkpoint. */
  | 'ready'
  /** Enumerable gaps a supplement could close; no implementation may start. */
  | 'supplement_required'
  /** Multiple plausible interpretations; explicit user selection required. */
  | 'blocked_ambiguous'
  /** Unsafe paths/symlinks/secrets/oversize/unsupported content detected. */
  | 'blocked_unsafe'
  /** Layout not mappable by the current recognizer; source stays untouched. */
  | 'blocked_unsupported'
  /** Plugin legacy JSON-only run; migration input, never approved as-is. */
  | 'legacy_migration_input';

export interface SpecificationBundleDescriptor {
  /** `<framework>/<state>` — stable bundle identifier. */
  readonly id: string;
  readonly framework: SpecificationFrameworkId;
  readonly state: SpecificationBundleState;
  /** Directory relative to the specification fixture root. */
  readonly directory: string;
  readonly summary: string;
  readonly expectation: SpecificationIntakeExpectation;
}
/** One immutable bundle entry, read without following links. */
export type SpecificationBundleEntry =
  | {
      readonly path: string;
      readonly kind: 'file';
      /** Regular file bytes read under the per-file and aggregate caps. */
      readonly bytes: Buffer;
      readonly sha256: string;
    }
  | {
      readonly path: string;
      readonly kind: 'symlink';
      /** Bounded link payload captured by readlink; never resolved here. */
      readonly symlink_target: string;
      readonly sha256: string;
    };

export interface SpecificationBundle {
  readonly descriptor: SpecificationBundleDescriptor;
  /** Absolute root of the loaded (or materialized) bundle. */
  readonly root: string;
  readonly entries: readonly SpecificationBundleEntry[];
  /** SHA-256 over the canonical entry manifest; equal iff bundle bytes are equal. */
  readonly digest: string;
}

export interface SpecificationBundleLoadOptions {
  /** Fixture root override (tests); defaults to the shipped tree. */
  readonly fixtureRoot?: string;
}

export interface SpecificationBundleMaterializeOptions {
  /** Replace an existing target directory. Refused when false/absent. */
  readonly overwrite?: boolean;
}

/* Scratch repository builders. */

export type ConstitutionFixtureVariant =
  | 'usable'
  | 'usable_with_warnings'
  | 'empty'
  | 'unresolved_template'
  | 'structurally_invalid';

export interface ScratchRepositoryOptions {
  /** Base directory that will contain `<prefix><slug>`; created when missing. */
  readonly workdir: string;
  /** Safe single path segment; the scratch dir becomes `omp-spec-e2e-<slug>`. */
  readonly slug: string;
  /** Bundles to materialize into the scratch repo; `as` defaults to the bundle id with `/` replaced by `-`. */
  readonly bundles?: readonly { readonly id: string; readonly as?: string }[];
  /** Project constitution fixture; `path` defaults to `CONSTITUTION.md`. */
  readonly constitution?: { readonly variant: ConstitutionFixtureVariant; readonly path?: string };
  /** Legacy JSON-only specification run plus `.active-feature` selector. */
  readonly legacyRun?: { readonly featureId: string; readonly branch?: string };
  /** Additional deterministic files (safe relative paths only). */
  readonly extraFiles?: readonly { readonly path: string; readonly contents: string | Buffer }[];
  /** Wire current core/fullstack packages into the scratch for real OMP runtime tests. */
  readonly runtime?: boolean;
  /** Git behavior; init defaults to true with a deterministic identity. */
  readonly git?: { readonly init?: boolean; readonly branch?: string; readonly commit?: boolean; readonly message?: string };
  /** Replace an existing scratch directory. Refused when false/absent. */
  readonly overwrite?: boolean;
}

export interface ScratchRepositoryFile {
  /** POSIX-style path relative to the scratch root, sorted lexicographically. */
  readonly path: string;
  readonly sha256: string;
}

export interface ScratchRepositoryResult {
  readonly root: string;
  readonly slug: string;
  readonly files: readonly ScratchRepositoryFile[];
  readonly bundles: readonly { readonly id: string; readonly path: string; readonly digest: string }[];
  readonly constitution?: { readonly path: string; readonly variant: ConstitutionFixtureVariant; readonly sha256: string };
  readonly legacyRun?: { readonly featureId: string; readonly statePath: string };
  readonly git?: { readonly initialized: boolean; readonly branch?: string; readonly committed: boolean; readonly head?: string };
}

/* Runtime evidence builders. */

/** Fixed epoch for all fixture evidence so digests are reproducible. */
export const RUNTIME_EVIDENCE_EPOCH = '2026-01-01T00:00:00.000Z';

/** Fixed epoch embedded in legacy JSON-only run fixtures. */
export const LEGACY_RUN_EPOCH = '2025-11-14T09:30:00.000Z';

/** Version of the fixture contract itself; bumped only on semantic change. */
export const SPECIFICATION_FIXTURE_VERSION = '1.0.0';

export type RuntimeEvidenceKind =
  | 'implementation_artifact'
  | 'review_verdict'
  | 'executed_test'
  | 'runtime_scenario'
  | 'approval_proof'
  | 'compatibility_checkpoint'
  | 'source_immutability';

export interface RuntimeEvidenceInput {
  readonly kind: RuntimeEvidenceKind;
  /** Feature/requirement/scenario/path identity the evidence is about. */
  readonly subject: string;
  /** Artifact, document, or scenario references backing the evidence. */
  readonly refs?: readonly string[];
  /** path/ref → SHA-256 bindings; keys participate in the evidence id. */
  readonly digests?: Readonly<Record<string, string>>;
  /** Additional JSON-representable detail; must itself be deterministic. */
  readonly payload?: Readonly<Record<string, unknown>>;
}

export interface RuntimeEvidence {
  /** Deterministic content address (`ev-` + SHA-256 of the canonical form). */
  readonly evidence_id: string;
  readonly kind: RuntimeEvidenceKind;
  readonly subject: string;
  readonly refs: readonly string[];
  readonly digests: Readonly<Record<string, string>>;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly producer: 'omp-workflows-e2e/specification-fixtures';
  readonly recorded_at: string;
  readonly fixture_version: string;
}

/* ------------------------------------------------------------------ */
/* Errors                                                              */
/* ------------------------------------------------------------------ */

export class SpecificationFixtureError extends Error {
  constructor(problem: string) {
    super(`specification-fixtures: ${problem}`);
    this.name = 'SpecificationFixtureError';
  }
}

/* ------------------------------------------------------------------ */
/* Deterministic primitives                                            */
/* ------------------------------------------------------------------ */

export function sha256Bytes(data: Uint8Array): string {
  return createHash('sha256').update(data).digest('hex');
}

/** JSON.stringify with recursively sorted object keys — canonical digests. */
function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((item) => stableStringify(item)).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

function sha256Text(text: string): string {
  return sha256Bytes(Buffer.from(text, 'utf8'));
}

/** Rejects absolute paths, `..` segments, empty segments, and backslashes. */
function assertSafeRelativePath(pathValue: string, label: string): string {
  if (pathValue.length === 0) throw new SpecificationFixtureError(`${label} must not be empty`);
  if (isAbsolute(pathValue) || pathValue.includes('\\') || pathValue.includes('\0')) {
    throw new SpecificationFixtureError(`${label} must be a relative POSIX path: ${pathValue}`);
  }
  for (const segment of pathValue.split('/')) {
    if (segment.length === 0 || segment === '.' || segment === '..') {
      throw new SpecificationFixtureError(`${label} contains an unsafe segment "${segment}": ${pathValue}`);
    }
  }
  return pathValue;
}

function assertSafeSlug(slug: string): string {
  if (!/^[a-z0-9][a-z0-9._-]{0,63}$/i.test(slug) || slug.endsWith('.')) {
    throw new SpecificationFixtureError(`slug must be a safe single path segment: ${slug}`);
  }
  return slug;
}

function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/* ------------------------------------------------------------------ */
/* T003 registry: immutable external source bundles                    */
/* ------------------------------------------------------------------ */

/** Absolute root of the shipped fixture tree (`packages/e2e/fixtures/specification`). */
export function specificationFixtureRoot(fixtureRoot?: string): string {
  if (fixtureRoot !== undefined) return resolve(fixtureRoot);
  return resolve(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'specification');
}

const BUNDLE_DESCRIPTORS: readonly SpecificationBundleDescriptor[] = [
  {
    id: 'speckit/complete',
    framework: 'speckit',
    state: 'complete',
    directory: 'speckit/complete',
    summary: 'Full Spec Kit feature: constitution, spec, plan, tasks.',
    expectation: 'ready',
  },
  {
    id: 'speckit/incomplete',
    framework: 'speckit',
    state: 'incomplete',
    directory: 'speckit/incomplete',
    summary: 'Spec Kit feature missing the task graph.',
    expectation: 'supplement_required',
  },
  {
    id: 'speckit/ambiguous',
    framework: 'speckit',
    state: 'ambiguous',
    directory: 'speckit/ambiguous',
    summary: 'Two complete Spec Kit feature directories with no selection metadata.',
    expectation: 'blocked_ambiguous',
  },
  {
    id: 'speckit/hostile',
    framework: 'speckit',
    state: 'hostile',
    directory: 'speckit/hostile',
    summary: 'Readable Spec Kit feature with traversal refs, escape symlink, secret-like data, injection, oversize, and binary files.',
    expectation: 'blocked_unsafe',
  },
  {
    id: 'speckit/legacy',
    framework: 'speckit',
    state: 'legacy',
    directory: 'speckit/legacy',
    summary: 'Legacy Spec Kit layout: spec-only feature plus a stale template pointing at removed paths.',
    expectation: 'blocked_unsupported',
  },
  {
    id: 'openspec/complete',
    framework: 'openspec',
    state: 'complete',
    directory: 'openspec/complete',
    summary: 'OpenSpec baseline payment capability plus one active change with proposal, tasks, design, and delta.',
    expectation: 'ready',
  },
  {
    id: 'openspec/incomplete',
    framework: 'openspec',
    state: 'incomplete',
    directory: 'openspec/incomplete',
    summary: 'OpenSpec delta that references a missing baseline capability.',
    expectation: 'supplement_required',
  },
  {
    id: 'openspec/ambiguous',
    framework: 'openspec',
    state: 'ambiguous',
    directory: 'openspec/ambiguous',
    summary: 'Two active OpenSpec changes target the same capability with no selection.',
    expectation: 'blocked_ambiguous',
  },
  {
    id: 'openspec/hostile',
    framework: 'openspec',
    state: 'hostile',
    directory: 'openspec/hostile',
    summary: 'Readable OpenSpec change with attached traversal refs, escape symlink, secret-like data, injection, oversize, and binary files.',
    expectation: 'blocked_unsafe',
  },
  {
    id: 'openspec/legacy',
    framework: 'openspec',
    state: 'legacy',
    directory: 'openspec/legacy',
    summary: 'Legacy OpenSpec layout: baselines plus an archived change and no active change workspace.',
    expectation: 'blocked_unsupported',
  },
  {
    id: 'bmad/complete',
    framework: 'bmad',
    state: 'complete',
    directory: 'bmad/complete',
    summary: 'BMAD PRD, architecture, and a development story with acceptance criteria and tasks.',
    expectation: 'ready',
  },
  {
    id: 'bmad/incomplete',
    framework: 'bmad',
    state: 'incomplete',
    directory: 'bmad/incomplete',
    summary: 'BMAD PRD without architecture or story artifacts.',
    expectation: 'supplement_required',
  },
  {
    id: 'bmad/ambiguous',
    framework: 'bmad',
    state: 'ambiguous',
    directory: 'bmad/ambiguous',
    summary: 'Two plausible BMAD roots (bmad/docs and docs) with different PRDs.',
    expectation: 'blocked_ambiguous',
  },
  {
    id: 'bmad/hostile',
    framework: 'bmad',
    state: 'hostile',
    directory: 'bmad/hostile',
    summary: 'Readable BMAD set with attached traversal refs, escape symlink, secret-like data, injection, oversize, and binary files.',
    expectation: 'blocked_unsafe',
  },
  {
    id: 'bmad/legacy',
    framework: 'bmad',
    state: 'legacy',
    directory: 'bmad/legacy',
    summary: 'Legacy flat BMAD stories layout with no PRD or architecture artifacts.',
    expectation: 'blocked_unsupported',
  },
  {
    id: 'superpowers/complete',
    framework: 'superpowers',
    state: 'complete',
    directory: 'superpowers/complete',
    summary: 'Superpowers phase packet: brief, design, and ordered task checklist.',
    expectation: 'ready',
  },
  {
    id: 'superpowers/incomplete',
    framework: 'superpowers',
    state: 'incomplete',
    directory: 'superpowers/incomplete',
    summary: 'Superpowers brief without design or tasks.',
    expectation: 'supplement_required',
  },
  {
    id: 'superpowers/ambiguous',
    framework: 'superpowers',
    state: 'ambiguous',
    directory: 'superpowers/ambiguous',
    summary: 'Two complete Superpowers plans for the same feature with no current marker.',
    expectation: 'blocked_ambiguous',
  },
  {
    id: 'superpowers/hostile',
    framework: 'superpowers',
    state: 'hostile',
    directory: 'superpowers/hostile',
    summary: 'Readable Superpowers plan with attached traversal refs, escape symlink, secret-like data, injection, oversize, and binary files.',
    expectation: 'blocked_unsafe',
  },
  {
    id: 'superpowers/legacy',
    framework: 'superpowers',
    state: 'legacy',
    directory: 'superpowers/legacy',
    summary: 'Legacy single-file Superpowers monolith plan without phase packets.',
    expectation: 'blocked_unsupported',
  },
  {
    id: 'xpowers/complete',
    framework: 'xpowers',
    state: 'complete',
    directory: 'xpowers/complete',
    summary: 'XPowers approved immutable requirements, canonical task source, and decisions.',
    expectation: 'ready',
  },
  {
    id: 'xpowers/incomplete',
    framework: 'xpowers',
    state: 'incomplete',
    directory: 'xpowers/incomplete',
    summary: 'XPowers requirements without a canonical task source.',
    expectation: 'supplement_required',
  },
  {
    id: 'xpowers/ambiguous',
    framework: 'xpowers',
    state: 'ambiguous',
    directory: 'xpowers/ambiguous',
    summary: 'Two XPowers requirement revisions both marked approved.',
    expectation: 'blocked_ambiguous',
  },
  {
    id: 'xpowers/hostile',
    framework: 'xpowers',
    state: 'hostile',
    directory: 'xpowers/hostile',
    summary: 'Readable XPowers set with attached traversal refs, escape symlink, secret-like data, injection, oversize, and binary files.',
    expectation: 'blocked_unsafe',
  },
  {
    id: 'xpowers/legacy',
    framework: 'xpowers',
    state: 'legacy',
    directory: 'xpowers/legacy',
    summary: 'Legacy XPowers layout: prose backlog without a canonical task source.',
    expectation: 'blocked_unsupported',
  },
  {
    id: 'generic/complete',
    framework: 'generic',
    state: 'complete',
    directory: 'generic/complete',
    summary: 'Framework-neutral readable Markdown set: requirements, plan, tasks, decisions.',
    expectation: 'ready',
  },
  {
    id: 'generic/incomplete',
    framework: 'generic',
    state: 'incomplete',
    directory: 'generic/incomplete',
    summary: 'Framework-neutral requirements and plan without a task list.',
    expectation: 'supplement_required',
  },
  {
    id: 'generic/ambiguous',
    framework: 'generic',
    state: 'ambiguous',
    directory: 'generic/ambiguous',
    summary: 'Two parallel framework-neutral document sets (docs-a and docs-b).',
    expectation: 'blocked_ambiguous',
  },
  {
    id: 'generic/hostile',
    framework: 'generic',
    state: 'hostile',
    directory: 'generic/hostile',
    summary: 'Readable generic set with attached traversal refs, escape symlink, secret-like data, injection, oversize, and binary files.',
    expectation: 'blocked_unsafe',
  },
  {
    id: 'generic/legacy',
    framework: 'generic',
    state: 'legacy',
    directory: 'generic/legacy',
    summary: 'Legacy JSON-only spec-preparation run with a .active-feature selector for migration-path fixtures.',
    expectation: 'legacy_migration_input',
  },
];

/** Every T003 bundle descriptor: 6 frameworks × 5 required states. */
export function listSpecificationBundleFixtures(): readonly SpecificationBundleDescriptor[] {
  return BUNDLE_DESCRIPTORS;
}

export function getSpecificationBundleDescriptor(id: string): SpecificationBundleDescriptor {
  const descriptor = BUNDLE_DESCRIPTORS.find((candidate) => candidate.id === id);
  if (descriptor === undefined) {
    throw new SpecificationFixtureError(`unknown bundle id "${id}"; see listSpecificationBundleFixtures()`);
  }
  return descriptor;
}

function readBundleFile(parent: PinnedDirectory, name: string, maxBytes: number): Buffer | null {
  const file = openPinnedFile(parent, name, fsConstants.O_RDONLY);
  if (file === null || file.size > maxBytes) {
    if (file !== null) closePinnedFile(file);
    return null;
  }
  try {
    const bytes = Buffer.allocUnsafe(file.size);
    let offset = 0;
    while (offset < bytes.length) {
      const count = readSync(file.fd, bytes, offset, bytes.length - offset, offset);
      if (count <= 0) return null;
      offset += count;
    }
    const after = fstatSync(file.fd);
    return after.isFile() && after.nlink === 1 && after.size === file.size && pinnedDirectoryIsStable(parent)
      ? bytes
      : null;
  } finally {
    closePinnedFile(file);
  }
}

/** Hard traversal limits for untrusted fixture-root overrides. */
export const MAX_BUNDLE_DEPTH = 32;
export const MAX_BUNDLE_ENTRIES = 4096;
export const MAX_BUNDLE_SYMLINK_TARGET_BYTES = 2048;
export const MAX_BUNDLE_FILE_BYTES = MAX_PINNED_READ_BYTES;
export const MAX_BUNDLE_TOTAL_BYTES = 32 * 1024 * 1024;

function collectBundleEntries(root: string): SpecificationBundleEntry[] {
  const absoluteRoot = resolve(root);
  if (!existsSync(absoluteRoot)) throw new SpecificationFixtureError(`bundle directory is missing: ${absoluteRoot}`);
  const rootStat = lstatSync(absoluteRoot);
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
    throw new SpecificationFixtureError(`bundle root must be a regular directory: ${absoluteRoot}`);
  }
  const entries: SpecificationBundleEntry[] = [];
  let totalBytes = 0;
  let visited = 0;
  const pending: Array<{ readonly path: string; readonly depth: number }> = [{ path: absoluteRoot, depth: 0 }];
  const rootPin = pinDirectory(absoluteRoot);
  if (rootPin === null) throw new SpecificationFixtureError(`bundle root cannot be pinned safely: ${absoluteRoot}`);
  try {
    while (pending.length > 0) {
      const next = pending.shift();
      if (next === undefined) break;
      const parent: PinnedDirectory | null = next.path === absoluteRoot ? rootPin : pinDirectory(next.path);
      if (parent === null) throw new SpecificationFixtureError(`bundle directory cannot be pinned safely: ${next.path}`);
      try {
        if (!pinnedDirectoryIsStable(parent)) {
          throw new SpecificationFixtureError(`bundle directory changed during traversal: ${next.path}`);
        }
        const dirents = readdirSync(next.path, { withFileTypes: true }).sort((a, b) => compareStrings(a.name, b.name));
        for (const dirent of dirents) {
          visited += 1;
          if (visited > MAX_BUNDLE_ENTRIES) {
            throw new SpecificationFixtureError(`bundle exceeds ${MAX_BUNDLE_ENTRIES} entries`);
          }
          const childPath = join(next.path, dirent.name);
          const childRelative = relative(absoluteRoot, childPath).split('\\').join('/');
          assertSafeRelativePath(childRelative, 'bundle entry');
          const info = lstatSync(childPath);
          if (info.isSymbolicLink()) {
            let symlinkTarget: string;
            try {
              symlinkTarget = readlinkSync(childPath, 'utf8');
            } catch {
              throw new SpecificationFixtureError(`bundle symlink target could not be read: ${childRelative}`);
            }
            if (symlinkTarget.length === 0
              || symlinkTarget.includes('\0')
              || Buffer.byteLength(symlinkTarget, 'utf8') > MAX_BUNDLE_SYMLINK_TARGET_BYTES) {
              throw new SpecificationFixtureError(`bundle symlink target exceeds safety limits: ${childRelative}`);
            }
            entries.push({
              path: childRelative,
              kind: 'symlink',
              symlink_target: symlinkTarget,
              sha256: sha256Text(symlinkTarget),
            });
            continue;
          }
          if (info.isDirectory()) {
            if (next.depth >= MAX_BUNDLE_DEPTH) {
              throw new SpecificationFixtureError(`bundle exceeds maximum depth ${MAX_BUNDLE_DEPTH}: ${childRelative}`);
            }
            pending.push({ path: childPath, depth: next.depth + 1 });
            continue;
          }
          if (!info.isFile()) {
            throw new SpecificationFixtureError(`unsupported bundle entry (not a regular file or directory): ${childRelative}`);
          }
          if (info.nlink !== 1 || info.size > MAX_BUNDLE_FILE_BYTES) {
            throw new SpecificationFixtureError(`bundle file exceeds safety limits: ${childRelative}`);
          }
          if (totalBytes + info.size > MAX_BUNDLE_TOTAL_BYTES) {
            throw new SpecificationFixtureError(`bundle exceeds aggregate size limit ${MAX_BUNDLE_TOTAL_BYTES}`);
          }
          const bytes = readBundleFile(parent, dirent.name, MAX_BUNDLE_FILE_BYTES);
          if (bytes === null || bytes.length !== info.size) {
            throw new SpecificationFixtureError(`bundle file changed during read: ${childRelative}`);
          }
          totalBytes += bytes.length;
          entries.push({ path: childRelative, kind: 'file', bytes, sha256: sha256Bytes(bytes) });
        }
      } finally {
        if (parent !== rootPin) closePinnedDirectory(parent);
      }
    }
  } finally {
    closePinnedDirectory(rootPin);
  }
  if (entries.length === 0) throw new SpecificationFixtureError(`bundle directory is empty: ${absoluteRoot}`);
  entries.sort((a, b) => compareStrings(a.path, b.path));
  return entries;
}

function bundleDigest(entries: readonly SpecificationBundleEntry[]): string {
  const canonical = entries.map((entry) => `${entry.kind}\0${entry.path}\0${entry.sha256}\n`).join('');
  return sha256Text(canonical);
}

/**
 * Loads a fixture bundle read-only. Unsafe symlinks and special files are
 * rejected rather than followed or copied.
 */
export function loadSpecificationBundleFixture(id: string, options: SpecificationBundleLoadOptions = {}): SpecificationBundle {
  const descriptor = getSpecificationBundleDescriptor(id);
  const root = join(specificationFixtureRoot(options.fixtureRoot), descriptor.directory);
  const entries = collectBundleEntries(root);
  return { descriptor, root, entries, digest: bundleDigest(entries) };
}

/** path → SHA-256 map over a bundle's entries (source-immutability checks). */
export function entryDigests(bundle: SpecificationBundle): Record<string, string> {
  const digests: Record<string, string> = {};
  for (const entry of bundle.entries) digests[entry.path] = entry.sha256;
  return digests;
}

/**
 * Copies a fixture bundle byte-for-byte into `targetRoot` (an authorized
 * scratch location). The source tree is never touched; every bounded regular
 * file is copied, then re-digested and compared with the source.
 */
export function materializeSpecificationBundleFixture(
  id: string,
  targetRoot: string,
  options: SpecificationBundleMaterializeOptions = {},
): SpecificationBundle {
  const source = loadSpecificationBundleFixture(id);
  const target = resolve(targetRoot);
  if (existsSync(target)) {
    if (options.overwrite !== true) {
      throw new SpecificationFixtureError(`target already exists (pass overwrite to replace): ${target}`);
    }
    rmSync(target, { recursive: true, force: true });
  }
  mkdirSync(target, { recursive: true });
  for (const entry of source.entries) {
    const entryPath = assertSafeRelativePath(entry.path, 'bundle entry');
    const absolute = join(target, entryPath);
    mkdirSync(dirname(absolute), { recursive: true });
    if (entry.kind === 'file') {
      writeFileSync(absolute, entry.bytes);
    } else {
      // The target itself is always below the caller-authorized scratch root.
      // Creating a symlink does not read or mutate its target; hostile target
      // text stays inert until the importer rejects it in that scratch copy.
      symlinkSync(entry.symlink_target, absolute);
    }
  }
  // Re-walk the copy from disk and require byte equality with the source.
  const copiedEntries = collectBundleEntries(target);
  if (bundleDigest(copiedEntries) !== source.digest || copiedEntries.length !== source.entries.length) {
    throw new SpecificationFixtureError(`materialized bundle digest drift for ${id} at ${target}`);
  }
  return { descriptor: source.descriptor, root: target, entries: copiedEntries, digest: source.digest };
}

/* ------------------------------------------------------------------ */
/* Constitution fixture documents (deterministic, embedded)            */
/* ------------------------------------------------------------------ */

const CONSTITUTION_USABLE = `# Project Constitution

Spec E2E fixture project policy. Inert fixture data — not a real project policy.

## Version

1.2.0

## Principles

### P1. Approved specification is the contract

Implementation starts only from an approved specification handoff. No executor may
re-interpret approved scope during implementation.

### P2. Human checkpoints are mandatory

Every specification phase presents an explicit human checkpoint with exactly the
declared decisions. Agents and automation never approve.

### P3. Evidence over claims

Feature completion requires attributable implementation evidence, a passing review
verdict, and passing executed tests for every observable behavior.

## Quality Gates

- Focused tests for changed contracts pass before completion.
- No real credentials, tokens, or private keys are ever committed.
- Imported specification bundle sources remain byte-for-byte unchanged.
`;

const CONSTITUTION_WARNINGS = `${CONSTITUTION_USABLE}
## Warnings

- Non-blocking: the legacy retry queue is scheduled for removal next quarter.
`;

const CONSTITUTION_UNRESOLVED = `# Project Constitution

## Version

{{CONSTITUTION_VERSION}}

## Principles

{{CONSTITUTION_PRINCIPLES}}

## Quality Gates

{{CONSTITUTION_QUALITY_GATES}}
`;

const CONSTITUTION_INVALID = `This document is a plain paragraph without any heading structure at all.
It contains no version, no principles section, and no quality gates, so the
mandatory structural checks must classify it as unusable fixture data.`;

/** Deterministic constitution documents for usability-gate fixtures. */
export function constitutionFixtureContent(variant: ConstitutionFixtureVariant): string {
  switch (variant) {
    case 'usable':
      return CONSTITUTION_USABLE;
    case 'usable_with_warnings':
      return CONSTITUTION_WARNINGS;
    case 'empty':
      return '';
    case 'unresolved_template':
      return CONSTITUTION_UNRESOLVED;
    case 'structurally_invalid':
      return CONSTITUTION_INVALID;
  }
}

/* ------------------------------------------------------------------ */
/* Legacy JSON-only run fixture (migration inputs, US7)                */
/* ------------------------------------------------------------------ */

export interface LegacySpecificationRunDocument {
  readonly schema_version: 1;
  readonly feature: string;
  readonly branch: string;
  readonly created_at: string;
  readonly generator: string;
  readonly completed: boolean;
  readonly specification: {
    readonly problem: string;
    readonly requirements: readonly { readonly id: string; readonly text: string }[];
    readonly acceptance: readonly { readonly id: string; readonly requirement: string; readonly text: string }[];
  };
  readonly plan: { readonly decisions: readonly { readonly id: string; readonly text: string }[] };
  readonly tasks: readonly {
    readonly id: string;
    readonly title: string;
    readonly requirement_ids: readonly string[];
    readonly depends_on: readonly string[];
  }[];
  readonly artifacts: Readonly<Record<string, string>>;
}

/**
 * Deterministic legacy JSON-only `spec-preparation` export for one feature —
 * the migration input shape (never approved as-is; provenance only).
 */
export function legacySpecificationRunDocument(featureId: string, branch: string): LegacySpecificationRunDocument {
  return {
    schema_version: 1,
    feature: featureId,
    branch,
    created_at: LEGACY_RUN_EPOCH,
    generator: 'spec-preparation (JSON-only legacy export; inert fixture data)',
    completed: true,
    specification: {
      problem: 'Transient provider timeouts lose checkout sales because the first attempt is never retried.',
      requirements: [
        { id: 'FR-101', text: 'Retry a timed-out card charge up to 3 times with exponential backoff.' },
        { id: 'FR-102', text: 'Every retried charge reuses the provider idempotency key of the first attempt.' },
        { id: 'FR-103', text: 'After the final failed attempt, write a dead-letter record.' },
      ],
      acceptance: [
        { id: 'A-101', requirement: 'FR-101', text: 'Exactly one additional provider call within 2 seconds using the same idempotency key.' },
        { id: 'A-102', requirement: 'FR-103', text: 'A dead-letter record exists after the third timeout and no further calls are made.' },
      ],
    },
    plan: {
      decisions: [
        { id: 'D-101', text: 'Fixed in-process backoff schedule (1s/2s/4s).' },
        { id: 'D-102', text: 'Reuse the orders idempotency column.' },
      ],
    },
    tasks: [
      { id: 'T-101', title: 'Implement RetryPolicy schedule', requirement_ids: ['FR-101'], depends_on: [] },
      { id: 'T-102', title: 'Reuse idempotency keys across attempts', requirement_ids: ['FR-102'], depends_on: ['T-101'] },
      { id: 'T-103', title: 'Write dead-letter records after final failure', requirement_ids: ['FR-103'], depends_on: ['T-102'] },
    ],
    artifacts: {
      specification: 'spec-preparation/specification.json',
      plan: 'spec-preparation/plan.json',
      tasks: 'spec-preparation/tasks.json',
    },
  };
}

/* ------------------------------------------------------------------ */
/* T002: authorized scratch-repository builder                         */
/* ------------------------------------------------------------------ */

/** Identity on EVERY git command (scratch repos have no user config). */
const GIT_IDENTITY = ['-c', 'user.name=Specification E2E', '-c', 'user.email=specification-e2e@example.invalid'] as const;

interface GitOutcome {
  readonly status: number;
  readonly stdout: string;
  readonly stderr: string;
}

function runGit(cwd: string, args: readonly string[]): GitOutcome {
  const result = spawnSync('git', [...GIT_IDENTITY, ...args], { cwd, encoding: 'utf8' });
  return {
    status: result.status ?? -1,
    stdout: (result.stdout ?? '').trim(),
    stderr: (result.stderr ?? '').trim(),
  };
}

/** Fully preflighted bundle plan; source entries remain immutable. */
interface PlannedScratchBundle {
  readonly id: string;
  readonly targetName: string;
  readonly bundle: SpecificationBundle;
}

interface ScratchPreflight {
  readonly slug: string;
  readonly workdir: string;
  readonly root: string;
  readonly markerPath: string;
  readonly markerContent: string;
  readonly parentExists: boolean;
  readonly parentOwned: boolean;
  readonly rootExists: boolean;
  readonly bundles: readonly PlannedScratchBundle[];
  readonly files: readonly ScratchRepositoryFile[];
  readonly constitution?: { readonly path: string; readonly variant: ConstitutionFixtureVariant; readonly content: string; readonly sha256: string };
  readonly legacyRun?: { readonly featureId: string; readonly statePath: string; readonly selectorContent: string; readonly stateContent: string };
  readonly extraFiles: readonly { readonly path: string; readonly bytes: Buffer }[];
  readonly git: { readonly init: boolean; readonly branch: string; readonly commit: boolean; readonly message: string };
}

const SCRATCH_PARENT_MARKER = '.omp-spec-e2e-scratch-parent.json';
const SCRATCH_PARENT_SCHEMA = 'omp-specification-scratch-parent/v1';
const SPECIFICATION_PROJECT_ROOT = realpathSync(resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..'));

function scratchParentMarkerContent(workdir: string): string {
  return `${JSON.stringify({ schema: SCRATCH_PARENT_SCHEMA, producer: 'omp-workflows-e2e/specification-fixtures', workdir }, null, 2)}\n`;
}

function pathEntryExists(pathValue: string): boolean {
  try {
    lstatSync(pathValue);
    return true;
  } catch (error) {
    if ((error as { readonly code?: string }).code === 'ENOENT') return false;
    throw error;
  }
}

// Inspect the caller's final entry before canonicalizing OS-level ancestor aliases such as macOS /var.
function resolveRealDirectory(pathValue: string, label: string): string {
  const entry = lstatSync(pathValue);
  if (entry.isSymbolicLink() || !entry.isDirectory()) {
    throw new SpecificationFixtureError(`${label} must be a real directory, not a symlink or special file: ${pathValue}`);
  }
  return realpathSync(pathValue);
}

function assertExistingScratchRootSafe(root: string, workdir: string): void {
  const entry = lstatSync(root);
  if (entry.isSymbolicLink() || !entry.isDirectory()) {
    throw new SpecificationFixtureError(`scratch repository target must be a real directory, not a symlink or special file: ${root}`);
  }
  const canonicalRoot = realpathSync(root);
  if (dirname(canonicalRoot) !== workdir || relative(workdir, canonicalRoot) !== relative(workdir, root)) {
    throw new SpecificationFixtureError(`scratch repository target escapes its owned parent: ${root}`);
  }
}

function preflightScratchSpecificationRepository(options: ScratchRepositoryOptions): ScratchPreflight {
  const slug = assertSafeSlug(options.slug);
  const requestedWorkdir = resolve(options.workdir);
  const parentExists = pathEntryExists(requestedWorkdir);
  let workdir: string;
  if (parentExists) {
    workdir = resolveRealDirectory(requestedWorkdir, 'scratch parent');
  } else {
    let ancestor = dirname(requestedWorkdir);
    while (!pathEntryExists(ancestor)) {
      const next = dirname(ancestor);
      if (next === ancestor) break;
      ancestor = next;
    }
    const canonicalAncestor = resolveRealDirectory(ancestor, 'scratch parent ancestor');
    workdir = join(canonicalAncestor, relative(ancestor, requestedWorkdir));
  }
  const filesystemRoot = parse(workdir).root;
  if (workdir === filesystemRoot) {
    throw new SpecificationFixtureError(`scratch parent must not be a filesystem root: ${workdir}`);
  }
  if (workdir === SPECIFICATION_PROJECT_ROOT) {
    throw new SpecificationFixtureError(`scratch parent must not be the project root: ${workdir}`);
  }

  const root = join(workdir, `omp-spec-e2e-${slug}`);
  const rootRelative = relative(workdir, root);
  if (rootRelative !== `omp-spec-e2e-${slug}` || isAbsolute(rootRelative)) {
    throw new SpecificationFixtureError(`scratch repository target escapes its parent: ${root}`);
  }

  const markerPath = join(workdir, SCRATCH_PARENT_MARKER);
  const markerContent = scratchParentMarkerContent(workdir);
  let parentOwned = false;
  if (parentExists && pathEntryExists(markerPath)) {
    const marker = lstatSync(markerPath);
    if (marker.isSymbolicLink() || !marker.isFile() || readFileSync(markerPath, 'utf8') !== markerContent) {
      throw new SpecificationFixtureError(`scratch parent ownership marker is invalid: ${markerPath}`);
    }
    parentOwned = true;
  }

  const rootExists = pathEntryExists(root);
  const admissionLockName = `.omp-spec-e2e-${basename(workdir)}.lock`;
  const unownedEntries = parentExists
    ? readdirSync(workdir).filter((entry) => entry !== admissionLockName)
    : [];
  if (rootExists) {
    if (options.overwrite !== true) {
      throw new SpecificationFixtureError(`scratch repository already exists (pass overwrite to replace): ${root}`);
    }
    if (!parentOwned) {
      throw new SpecificationFixtureError(`overwrite requires a scratch parent previously owned by this API: ${workdir}`);
    }
    assertExistingScratchRootSafe(root, workdir);
  } else if (!parentOwned && parentExists && unownedEntries.length !== 0) {
    throw new SpecificationFixtureError(`unowned scratch parent must be empty: ${workdir}`);
  }

  const claims = new Map<string, { readonly kind: 'file' | 'symlink'; readonly source: string; readonly sha256: string }>();
  const claimPath = (relativePath: string, kind: 'file' | 'symlink', source: string, sha256: string): string => {
    const key = assertSafeRelativePath(relativePath, source);
    for (const [existingPath, existing] of claims) {
      if (existingPath === key || existingPath.startsWith(`${key}/`) || key.startsWith(`${existingPath}/`)) {
        throw new SpecificationFixtureError(
          `scratch path collision between "${key}" (${source}) and "${existingPath}" (${existing.source})`,
        );
      }
    }
    claims.set(key, { kind, source, sha256 });
    return key;
  };

  const bundleTargets: { readonly path: string; readonly id: string }[] = [];
  const bundles: PlannedScratchBundle[] = [];
  for (const request of options.bundles ?? []) {
    const targetName = assertSafeRelativePath(request.as ?? request.id.split('/').join('-'), 'bundle target');
    for (const existing of bundleTargets) {
      if (existing.path === targetName || existing.path.startsWith(`${targetName}/`) || targetName.startsWith(`${existing.path}/`)) {
        throw new SpecificationFixtureError(
          `bundle target collision between "${targetName}" (${request.id}) and "${existing.path}" (${existing.id})`,
        );
      }
    }
    const bundle = loadSpecificationBundleFixture(request.id);
    bundleTargets.push({ path: targetName, id: request.id });
    bundles.push({ id: request.id, targetName, bundle });
    for (const entry of bundle.entries) {
      const entryPath = assertSafeRelativePath(entry.path, `bundle entry in ${request.id}`);
      claimPath(`${targetName}/${entryPath}`, entry.kind, `bundle entry in ${request.id}`, entry.sha256);
    }
  }

  let constitution: ScratchPreflight['constitution'];
  if (options.constitution !== undefined) {
    const constitutionPath = assertSafeRelativePath(options.constitution.path ?? 'CONSTITUTION.md', 'constitution path');
    const content = constitutionFixtureContent(options.constitution.variant);
    if (typeof content !== 'string') {
      throw new SpecificationFixtureError(`unknown constitution fixture variant: ${String(options.constitution.variant)}`);
    }
    const sha256 = sha256Text(content);
    claimPath(constitutionPath, 'file', 'constitution path', sha256);
    constitution = { path: constitutionPath, variant: options.constitution.variant, content, sha256 };
  }

  let legacyRun: ScratchPreflight['legacyRun'];
  if (options.legacyRun !== undefined) {
    const featureId = assertSafeSlug(options.legacyRun.featureId);
    const branch = options.legacyRun.branch ?? `feat/${featureId}`;
    if (typeof branch !== 'string' || branch.length === 0 || branch.includes('\0')) {
      throw new SpecificationFixtureError('legacy branch must be a non-empty string without NUL bytes');
    }
    const selectorContent = `${featureId}\n`;
    claimPath('.active-feature', 'file', 'legacy active-feature selector', sha256Text(selectorContent));
    const statePath = assertSafeRelativePath(`.work-state/specification/${featureId}/legacy-run.json`, 'legacy state path');
    const stateContent = `${JSON.stringify(legacySpecificationRunDocument(featureId, branch), null, 2)}\n`;
    claimPath(statePath, 'file', 'legacy state path', sha256Text(stateContent));
    legacyRun = { featureId, statePath, selectorContent, stateContent };
  }

  const extraFiles: { path: string; bytes: Buffer }[] = [];
  for (const extra of options.extraFiles ?? []) {
    const extraPath = assertSafeRelativePath(extra.path, 'extra file');
    if (typeof extra.contents !== 'string' && !Buffer.isBuffer(extra.contents)) {
      throw new SpecificationFixtureError(`extra file contents must be a string or Buffer: ${extraPath}`);
    }
    const bytes = typeof extra.contents === 'string' ? Buffer.from(extra.contents, 'utf8') : Buffer.from(extra.contents);
    claimPath(extraPath, 'file', 'extra file', sha256Bytes(bytes));
    extraFiles.push({ path: extraPath, bytes });
  }

  const gitConfig = options.git ?? {};
  const shouldInit = gitConfig.init ?? true;
  const gitBranch = gitConfig.branch ?? 'main';
  const gitCommit = gitConfig.commit === true;
  const gitMessage = gitConfig.message ?? 'Initial specification fixture import';
  if (shouldInit) {
    if (typeof gitBranch !== 'string' || gitBranch.length === 0 || gitBranch.includes('\0')) {
      throw new SpecificationFixtureError('git branch must be a non-empty string without NUL bytes');
    }
    const branchCheck = spawnSync('git', ['check-ref-format', '--branch', gitBranch], { encoding: 'utf8' });
    if (branchCheck.status !== 0) {
      throw new SpecificationFixtureError(`invalid git branch "${gitBranch}": ${(branchCheck.stderr ?? '').trim()}`);
    }
    if (typeof gitMessage !== 'string' || gitMessage.length === 0 || gitMessage.includes('\0')) {
      throw new SpecificationFixtureError('git commit message must be a non-empty string without NUL bytes');
    }
    for (const claimedPath of claims.keys()) {
      if (claimedPath === '.git' || claimedPath.startsWith('.git/')) {
        throw new SpecificationFixtureError(`scratch path is reserved for git metadata: ${claimedPath}`);
      }
    }
  }

  const files = [...claims.entries()]
    .map(([path, claim]) => ({ path, sha256: claim.sha256 }))
    .sort((a, b) => compareStrings(a.path, b.path));

  return {
    slug,
    workdir,
    root,
    markerPath,
    markerContent,
    parentExists,
    parentOwned,
    rootExists,
    bundles,
    files,
    constitution,
    legacyRun,
    extraFiles,
    git: { init: shouldInit, branch: gitBranch, commit: gitCommit, message: gitMessage },
  };
}

/**
 * Creates a deterministic authorized scratch repository for runtime scenarios.
 * Every path and bundle descriptor is preflighted before the first mutation.
 * Repository contents are built in a fresh staging directory, then installed
 * beneath a canonical, API-owned scratch parent.
 */
function createScratchSpecificationRepositoryUnlocked(options: ScratchRepositoryOptions): ScratchRepositoryResult {
  const plan = preflightScratchSpecificationRepository(options);
  let parentCreated = false;
  let markerCreated = false;
  let stagingRoot: string | undefined;
  let rootInstalled = false;

  try {
    if (!plan.parentExists) {
      mkdirSync(plan.workdir, { recursive: true });
      resolveRealDirectory(plan.workdir, 'scratch parent');
      parentCreated = true;
    }
    if (!plan.parentOwned) {
      writeFileSync(plan.markerPath, plan.markerContent, { encoding: 'utf8', flag: 'wx' });
      markerCreated = true;
    }

    stagingRoot = mkdtempSync(join(plan.workdir, '.omp-spec-e2e-staging-'));
    const bundleResults: { id: string; path: string; digest: string }[] = [];
    for (const planned of plan.bundles) {
      const targetRoot = join(stagingRoot, planned.targetName);
      const materialized = materializeSpecificationBundleFixture(planned.id, targetRoot);
      if (materialized.digest !== planned.bundle.digest) {
        throw new SpecificationFixtureError(`bundle changed after preflight: ${planned.id}`);
      }
      bundleResults.push({ id: planned.id, path: planned.targetName, digest: planned.bundle.digest });
    }

    if (plan.constitution !== undefined) {
      const absolute = join(stagingRoot, plan.constitution.path);
      mkdirSync(dirname(absolute), { recursive: true });
      writeFileSync(absolute, plan.constitution.content, 'utf8');
    }

    if (plan.legacyRun !== undefined) {
      writeFileSync(join(stagingRoot, '.active-feature'), plan.legacyRun.selectorContent, 'utf8');
      const stateAbsolute = join(stagingRoot, plan.legacyRun.statePath);
      mkdirSync(dirname(stateAbsolute), { recursive: true });
      writeFileSync(stateAbsolute, plan.legacyRun.stateContent, 'utf8');
    }

    for (const extra of plan.extraFiles) {
      const absolute = join(stagingRoot, extra.path);
      mkdirSync(dirname(absolute), { recursive: true });
      writeFileSync(absolute, extra.bytes);
    }

    let git: ScratchRepositoryResult['git'];
    if (plan.git.init) {
      const init = runGit(stagingRoot, ['init', '-b', plan.git.branch]);
      if (init.status !== 0) throw new SpecificationFixtureError(`git init failed in scratch staging: ${init.stderr}`);
      let committed = false;
      let head: string | undefined;
      if (plan.git.commit) {
        const add = runGit(stagingRoot, ['add', '-A']);
        if (add.status !== 0) throw new SpecificationFixtureError(`git add failed in scratch staging: ${add.stderr}`);
        const commit = runGit(stagingRoot, ['commit', '-m', plan.git.message]);
        if (commit.status !== 0) throw new SpecificationFixtureError(`git commit failed in scratch staging: ${commit.stderr}`);
        const rev = runGit(stagingRoot, ['rev-parse', 'HEAD']);
        if (rev.status !== 0) throw new SpecificationFixtureError(`git rev-parse failed in scratch staging: ${rev.stderr}`);
        committed = true;
        head = rev.stdout;
      }
      git = { initialized: true, branch: plan.git.branch, committed, head };
    }

    if (plan.rootExists) {
      assertExistingScratchRootSafe(plan.root, plan.workdir);
      rmSync(plan.root, { recursive: true, force: true });
    }
    renameSync(stagingRoot, plan.root);
    stagingRoot = undefined;
    rootInstalled = true;
    if (options.runtime === true) prepareRuntimeScratchProject(plan.root);

    return {
      root: plan.root,
      slug: plan.slug,
      files: plan.files,
      bundles: bundleResults,
      constitution: plan.constitution === undefined
        ? undefined
        : { path: plan.constitution.path, variant: plan.constitution.variant, sha256: plan.constitution.sha256 },
      legacyRun: plan.legacyRun === undefined
        ? undefined
        : { featureId: plan.legacyRun.featureId, statePath: plan.legacyRun.statePath },
      git,
    };
  } catch (error) {
    if (rootInstalled && existsSync(plan.root)) rmSync(plan.root, { recursive: true, force: true });
    if (stagingRoot !== undefined && existsSync(stagingRoot)) rmSync(stagingRoot, { recursive: true, force: true });
    if (markerCreated && existsSync(plan.markerPath)) rmSync(plan.markerPath, { force: true });
    if (parentCreated && existsSync(plan.workdir)) {
      try {
        rmdirSync(plan.workdir);
      } catch {
        // Preserve unexpected concurrent content; never recursively clean a parent.
      }
    }
    throw error;
  }
}

/**
 * Serialize the full preflight/build/install transaction under a descriptor-
 * pinned admission lock. The lock lives in the existing parent when present,
 * or in its pinned ancestor while a new parent is being created.
 */
export function createScratchSpecificationRepository(options: ScratchRepositoryOptions): ScratchRepositoryResult {
  const requestedWorkdir = resolve(options.workdir);
  if (requestedWorkdir === parse(requestedWorkdir).root) {
    throw new SpecificationFixtureError(`scratch parent must not be a filesystem root: ${requestedWorkdir}`);
  }
  const lockPath = pathEntryExists(requestedWorkdir) ? requestedWorkdir : dirname(requestedWorkdir);
  const lockRoot = pinDirectory(lockPath);
  if (lockRoot === null) throw new SpecificationFixtureError(`scratch parent must be a real directory or canonical path: ${lockPath}`);
  const lockName = `.omp-spec-e2e-${basename(requestedWorkdir)}.lock`;
  try {
    return withPinnedExclusiveLock(lockRoot, lockName, () => createScratchSpecificationRepositoryUnlocked(options), 10_000);
  } finally {
    closePinnedDirectory(lockRoot);
  }
}

/* ------------------------------------------------------------------ */
/* T002: runtime-evidence builders                                     */
/* ------------------------------------------------------------------ */

/**
 * Builds one deterministic runtime-evidence envelope. Identical inputs always
 * produce the identical `evidence_id`; `recorded_at` is the fixed fixture
 * epoch so evidence digests never drift between runs.
 */
export function createRuntimeEvidence(input: RuntimeEvidenceInput): RuntimeEvidence {
  const refs = [...(input.refs ?? [])].sort(compareStrings);
  const digests: Record<string, string> = {};
  for (const [key, value] of Object.entries(input.digests ?? {}).sort(([a], [b]) => compareStrings(a, b))) {
    digests[key] = value;
  }
  const payload = input.payload ?? {};
  const canonical = stableStringify({
    fixture_version: SPECIFICATION_FIXTURE_VERSION,
    kind: input.kind,
    subject: input.subject,
    refs,
    digests,
    payload,
  });
  return {
    evidence_id: `ev-${sha256Text(canonical)}`,
    kind: input.kind,
    subject: input.subject,
    refs,
    digests,
    payload,
    producer: 'omp-workflows-e2e/specification-fixtures',
    recorded_at: RUNTIME_EVIDENCE_EPOCH,
    fixture_version: SPECIFICATION_FIXTURE_VERSION,
  };
}

/**
 * Source-immutability evidence for one bundle: a digest binding for every
 * entry, suitable for before/after byte-preservation checks (FR-069).
 */
export function sourceImmutabilityEvidence(bundle: SpecificationBundle): RuntimeEvidence {
  return createRuntimeEvidence({
    kind: 'source_immutability',
    subject: bundle.descriptor.id,
    refs: bundle.entries.map((entry) => entry.path),
    digests: entryDigests(bundle),
    payload: { bundle_digest: bundle.digest },
  });
}
