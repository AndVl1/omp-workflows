/**
 * Source snapshots and package file-set materialization.
 *
 * The source tree is copied before packaging.  We hash it before and after
 * copying so a dirty checkout changing during prepare fails closed instead of
 * producing a mixed build.  Package files are selected from package.json's
 * existing `files` manifest; no npm link, global prefix, or implicit install is
 * used here.
 */
import { createHash, randomBytes } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { ManifestError } from './manifest.js';

const DIGEST_RE = /^(?:sha256:)?([a-f0-9]{64})$/iu;
const NAME_RE = /^(?:@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*$/u;

export interface SourceSnapshotOptions {
  readonly exclude?: readonly string[];
}

export interface SourceSnapshot {
  readonly source: string;
  readonly root: string;
  readonly digest: string;
  readonly dirty: boolean;
  readonly files: readonly string[];
}

export interface PackageArtifact {
  readonly name: string;
  readonly version: string;
  readonly root: string;
  readonly digest: string;
  /** Files selected by package.json's shipped `files` manifest. */
  readonly files: readonly string[];
  /** Complete materialized closure, including unpublished peer artifacts. */
  readonly closure_files: readonly string[];
  readonly source_digest: string;
  readonly dependencies: readonly string[];
}

export interface PackageArtifactOptions {
  readonly dependencyArtifacts?: readonly PackageDependency[];
  /** Immutable package roots such as the installed omp peer closure. */
  readonly dependencyRoots?: readonly PackageDependencyRoot[];
}

export interface PackageDependency {
  readonly name: string;
  readonly artifact: PackageArtifact;
  /** Relative package root beneath the target artifact. */
  readonly relativePath?: string;
}

export interface PackageDependencyRoot {
  readonly name: string;
  readonly root: string;
  /**
   * Relative package root beneath the target artifact/workspace.  Omitting
   * this preserves the historical top-level `node_modules/<name>` placement.
   */
  readonly relativePath?: string;
}

interface TreeEntry {
  readonly relative_path: string;
  readonly source_path: string;
  readonly kind: 'file' | 'directory';
}

interface ArtifactDependencyMetadata {
  readonly name: string;
  readonly version: string;
  readonly relative_path: string;
  readonly digest: string;
}

interface ArtifactMetadata {
  readonly schema_version: 2;
  readonly name: string;
  readonly version: string;
  readonly digest: string;
  readonly source_digest: string;
  readonly files: readonly string[];
  readonly closure_files: readonly string[];
  readonly dependencies: readonly string[];
  readonly dependency_entries: readonly ArtifactDependencyMetadata[];
  readonly metadata_digest: string;
}
function normalizedDependencyPath(name: string, value: string | undefined): string {
  const fallback = join('node_modules', ...name.split('/')).replaceAll('\\', '/');
  const candidate = (value ?? fallback).replaceAll('\\', '/');
  const parts = candidate.split('/');
  const nameParts = name.split('/');
  if (
    candidate.length === 0
    || isAbsolute(candidate)
    || parts.some(part => part.length === 0 || part === '.' || part === '..')
    || !candidate.startsWith('node_modules/')
    || parts.length < nameParts.length + 1
    || parts.slice(-nameParts.length).join('/') !== name
  ) {
    throw artifactError('artifact_dependency_invalid', 'dependency relative path is unsafe or does not end with its package name', { name, relativePath: value });
  }
  return candidate;
}

function metadataDigest(metadata: Omit<ArtifactMetadata, 'metadata_digest'>): string {
  return createHash('sha256').update(JSON.stringify(metadata)).digest('hex');
}



function artifactError(code: string, message: string, details: Record<string, unknown> = {}): ManifestError {
  return new ManifestError(code, message, details);
}

function pathContained(root: string, target: string): boolean {
  const rel = relative(resolve(root), resolve(target));
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

function sha256File(path: string): string {
  const hash = createHash('sha256');
  const fd = openSync(path, 'r');
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  try {
    let offset = 0;
    for (;;) {
      const bytes = readSync(fd, buffer, 0, buffer.length, offset);
      if (bytes === 0) break;
      hash.update(buffer.subarray(0, bytes));
      offset += bytes;
    }
  } finally {
    closeSync(fd);
  }
  return hash.digest('hex');
}

function sha256Tree(root: string, entries: readonly TreeEntry[]): string {
  const hash = createHash('sha256');
  for (const entry of entries) {
    if (entry.relative_path.length === 0) continue;
    hash.update(entry.kind);
    hash.update('\0');
    hash.update(entry.relative_path.replaceAll('\\', '/'));
    hash.update('\0');
    if (entry.kind === 'file') hash.update(sha256File(entry.source_path));
    hash.update('\0');
  }
  return hash.digest('hex');
}

function normalizedExcludes(exclude: readonly string[] | undefined): ReadonlySet<string> {
  return new Set((exclude ?? ['.git', 'node_modules']).map(entry => entry.replaceAll('\\', '/').replace(/^\.\//u, '')));
}

function enumerateTree(root: string, exclude?: readonly string[]): TreeEntry[] {
  const rootAbs = resolve(root);
  const excluded = normalizedExcludes(exclude);
  const entries: TreeEntry[] = [];
  const visit = (sourcePath: string, relativePath: string): void => {
    const stat = lstatSync(sourcePath);
    if (stat.isSymbolicLink()) throw artifactError('source_external_link', 'source snapshot contains a symlink; copy a real checkout path instead', { path: sourcePath });
    if (stat.isDirectory()) {
      if (relativePath.length > 0 && excluded.has(relativePath.replaceAll('\\', '/'))) return;
      entries.push({ relative_path: relativePath, source_path: sourcePath, kind: 'directory' });
      for (const child of readdirSync(sourcePath).sort()) {
        const childRelative = relativePath.length === 0 ? child : join(relativePath, child);
        visit(join(sourcePath, child), childRelative);
      }
      return;
    }
    if (!stat.isFile()) throw artifactError('source_unsupported_entry', 'source snapshot contains a non-file entry', { path: sourcePath });
    const top = relativePath.split(/[\\/]/u)[0] ?? relativePath;
    if (excluded.has(top) || excluded.has(relativePath.replaceAll('\\', '/'))) return;
    entries.push({ relative_path: relativePath, source_path: sourcePath, kind: 'file' });
  };
  visit(rootAbs, '');
  return entries;
}

function copyEntries(targetRoot: string, entries: readonly TreeEntry[]): void {
  mkdirSync(targetRoot, { recursive: true, mode: 0o700 });
  for (const entry of entries) {
    if (entry.relative_path.length === 0) continue;
    const destination = join(targetRoot, entry.relative_path);
    if (!pathContained(targetRoot, destination)) throw artifactError('artifact_path_escape', 'snapshot destination escaped its root', { destination });
    if (entry.kind === 'directory') {
      mkdirSync(destination, { recursive: true, mode: 0o755 });
      continue;
    }
    mkdirSync(dirname(destination), { recursive: true, mode: 0o755 });
    copyFileSync(entry.source_path, destination);
    try {
      chmodSync(destination, statSync(entry.source_path).mode & 0o777);
    } catch {
      // Best effort on filesystems without POSIX mode bits.
    }
  }
}

function removeIfPresent(path: string): void {
  rmSync(path, { recursive: true, force: true });
}

function copySnapshotEntry(sourceRoot: string, destinationRoot: string, relativePath: string): void {
  const source = join(sourceRoot, relativePath);
  const destination = join(destinationRoot, relativePath);
  if (!pathContained(sourceRoot, source) || !pathContained(destinationRoot, destination)) throw artifactError('artifact_path_escape', 'package file path escaped source or artifact root', { relativePath });
  let stat;
  try {
    stat = lstatSync(source);
  } catch {
    throw artifactError('artifact_missing_file', `declared package file ${relativePath} does not exist`, { relativePath, source });
  }
  if (stat.isSymbolicLink()) throw artifactError('artifact_external_link', `declared package file ${relativePath} is a symlink`, { relativePath });
  if (stat.isDirectory()) {
    mkdirSync(destination, { recursive: true, mode: 0o755 });
    for (const child of readdirSync(source).sort()) copySnapshotEntry(sourceRoot, destinationRoot, join(relativePath, child));
    return;
  }
  if (!stat.isFile()) throw artifactError('artifact_unsupported_entry', `declared package file ${relativePath} is not a regular file`, { relativePath });
  mkdirSync(dirname(destination), { recursive: true, mode: 0o755 });
  copyFileSync(source, destination);
  try {
    chmodSync(destination, stat.mode & 0o777);
  } catch {
    // Best effort.
  }
}

function wildcardToRegExp(pattern: string): RegExp {
  const escaped = pattern.split('').map(char => {
    if (char === '*') return '.*';
    if (char === '?') return '.';
    return char.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
  }).join('');
  return new RegExp(`^${escaped}$`, 'u');
}

function listFiles(root: string): string[] {
  const entries = enumerateTree(root, ['.git', 'node_modules']);
  return entries.filter(entry => entry.kind === 'file' && entry.relative_path.length > 0).map(entry => entry.relative_path.replaceAll('\\', '/')).sort();
}

function resolveManifestFiles(sourceRoot: string, manifest: Record<string, unknown>): string[] {
  const declared = manifest.files;
  if (!Array.isArray(declared) || declared.length === 0) throw artifactError('artifact_manifest_invalid', 'package.json files must be a non-empty array', { sourceRoot });
  const available = listFiles(sourceRoot);
  const selected = new Set<string>(['package.json']);
  for (const entry of declared) {
    if (typeof entry !== 'string' || entry.length === 0 || isAbsolute(entry) || entry.split(/[\\/]/u).includes('..')) throw artifactError('artifact_manifest_invalid', 'package.json files contains an unsafe path', { entry });
    const normalized = entry.replaceAll('\\', '/').replace(/^\.\//u, '');
    const matcher = wildcardToRegExp(normalized);
    const matches = available.filter(candidate => candidate === normalized || candidate.startsWith(`${normalized}/`) || matcher.test(candidate));
    for (const match of matches) selected.add(match);
  }
  for (const implicit of ['README.md', 'README', 'CHANGELOG.md', 'LICENSE', 'LICENSE.md']) {
    if (available.includes(implicit)) selected.add(implicit);
  }
  return [...selected].sort();
}

function readPackageManifest(sourceRoot: string): Record<string, unknown> {
  const path = join(sourceRoot, 'package.json');
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown;
  } catch (error) {
    throw artifactError('artifact_manifest_invalid', 'package.json could not be read', { path, cause: error instanceof Error ? error.message : String(error) });
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw artifactError('artifact_manifest_invalid', 'package.json must be an object', { path });
  return parsed as Record<string, unknown>;
}

function packageName(value: unknown): string {
  if (typeof value !== 'string' || !NAME_RE.test(value)) throw artifactError('artifact_manifest_invalid', 'package.json name is invalid');
  return value;
}

function packageVersion(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0) throw artifactError('artifact_manifest_invalid', 'package.json version is invalid');
  return value;
}

function validateEntrypoints(manifest: Record<string, unknown>, files: readonly string[]): void {
  const set = new Set(files);
  const targets: string[] = [];
  if (typeof manifest.main === 'string') targets.push(manifest.main);
  if (typeof manifest.types === 'string') targets.push(manifest.types);
  const bin = manifest.bin;
  if (typeof bin === 'string') targets.push(bin);
  else if (bin !== null && typeof bin === 'object' && !Array.isArray(bin)) {
    for (const value of Object.values(bin as Record<string, unknown>)) {
      if (typeof value === 'string') targets.push(value);
    }
  }
  const omp = manifest.omp;
  if (omp !== null && typeof omp === 'object' && !Array.isArray(omp)) {
    const extensions = (omp as Record<string, unknown>).extensions;
    if (Array.isArray(extensions)) {
      for (const extension of extensions) if (typeof extension === 'string') targets.push(extension);
    }
  }
  const exports = manifest.exports;
  const collect = (value: unknown): void => {
    if (typeof value === 'string') targets.push(value);
    else if (Array.isArray(value)) for (const item of value) collect(item);
    else if (value !== null && typeof value === 'object') for (const item of Object.values(value as Record<string, unknown>)) collect(item);
  };
  collect(exports);
  for (const target of targets) {
    const relativeTarget = (target.startsWith('./') ? target.slice(2) : target).replace(/\/+$/u, '');
    if (relativeTarget.length === 0 || isAbsolute(relativeTarget) || relativeTarget.split(/[\\/]/u).includes('..')) {
      throw artifactError('artifact_manifest_invalid', `package entrypoint ${target} is unsafe`, { target });
    }
    const matcher = wildcardToRegExp(relativeTarget);
    if (!set.has(relativeTarget) && ![...set].some(file => file.startsWith(`${relativeTarget}/`) || matcher.test(file))) {
      throw artifactError('artifact_entrypoint_missing', `package entrypoint ${target} is not in the shipped file set`, { target });
    }
  }
}

function manifestDependencyNames(manifest: Record<string, unknown>, includeOptional: boolean): string[] {
  const optional = new Set<string>();
  const peerMeta = manifest.peerDependenciesMeta;
  if (peerMeta !== null && typeof peerMeta === 'object' && !Array.isArray(peerMeta)) {
    for (const [name, value] of Object.entries(peerMeta as Record<string, unknown>)) {
      if (value !== null && typeof value === 'object' && !Array.isArray(value) && (value as Record<string, unknown>).optional === true) optional.add(name);
    }
  }
  const names: string[] = [];
  for (const field of ['dependencies', 'peerDependencies', ...(includeOptional ? ['optionalDependencies'] : [])]) {
    const value = manifest[field];
    if (value === undefined) continue;
    if (value === null || typeof value !== 'object' || Array.isArray(value)) throw artifactError('artifact_manifest_invalid', `package.json ${field} must be an object`, { field });
    for (const [name, range] of Object.entries(value as Record<string, unknown>)) {
      if (!NAME_RE.test(name) || typeof range !== 'string' || range.length === 0) throw artifactError('artifact_manifest_invalid', `package.json ${field} contains an invalid dependency`, { field, name });
      if (!optional.has(name)) names.push(name);
    }
  }
  return [...new Set(names)].sort();
}

function artifactMetadataPath(root: string): string {
  return join(root, '.e2e-artifact.json');
}

function artifactDigest(root: string, files: readonly string[]): string {
  const hash = createHash('sha256');
  for (const file of files) {
    const path = join(root, file);
    hash.update(file);
    hash.update('\0');
    hash.update(sha256File(path));
    hash.update('\0');
  }
  return hash.digest('hex');
}

function readArtifactMetadata(root: string): ArtifactMetadata {
  try {
    const parsed = JSON.parse(readFileSync(artifactMetadataPath(root), 'utf8')) as ArtifactMetadata;
    if (
      parsed.schema_version !== 2
      || typeof parsed.name !== 'string'
      || !NAME_RE.test(parsed.name)
      || typeof parsed.version !== 'string'
      || parsed.version.length === 0
      || !DIGEST_RE.test(parsed.digest)
      || !DIGEST_RE.test(parsed.source_digest)
      || !Array.isArray(parsed.files)
      || parsed.files.some(file => typeof file !== 'string')
      || !Array.isArray(parsed.closure_files)
      || parsed.closure_files.some(file => typeof file !== 'string')
      || !Array.isArray(parsed.dependencies)
      || parsed.dependencies.some(name => typeof name !== 'string' || !NAME_RE.test(name))
      || !Array.isArray(parsed.dependency_entries)
      || parsed.dependency_entries.some(entry => (
        entry === null
        || typeof entry !== 'object'
        || Array.isArray(entry)
        || typeof (entry as Record<string, unknown>).name !== 'string'
        || !NAME_RE.test((entry as Record<string, unknown>).name as string)
        || typeof (entry as Record<string, unknown>).version !== 'string'
        || (entry as Record<string, unknown>).version === ''
        || typeof (entry as Record<string, unknown>).relative_path !== 'string'
        || typeof (entry as Record<string, unknown>).digest !== 'string'
        || !DIGEST_RE.test((entry as Record<string, unknown>).digest as string)
      ))
      || typeof parsed.metadata_digest !== 'string'
      || !DIGEST_RE.test(parsed.metadata_digest)
    ) throw new Error('invalid artifact metadata');
    return parsed;
  } catch (error) {
    throw artifactError('cache_integrity_failure', 'package artifact metadata is missing or invalid', { root, cause: error instanceof Error ? error.message : String(error) });
  }
}
function copyImmutableDependencyTree(sourceRoot: string, destinationRoot: string, label: string, includeNodeModules: boolean): string {
  const excludes = includeNodeModules ? ['.git'] : ['.git', 'node_modules'];
  const sourceEntries = enumerateTree(sourceRoot, excludes);
  const sourceDigest = sha256Tree(sourceRoot, sourceEntries);
  const sourceFullEntries = includeNodeModules ? sourceEntries : enumerateTree(sourceRoot, ['.git']);
  const sourceFullDigest = sha256Tree(sourceRoot, sourceFullEntries);
  if (existsSync(destinationRoot)) {
    const destinationEntries = enumerateTree(destinationRoot, excludes);
    const destinationDigest = sha256Tree(destinationRoot, destinationEntries);
    if (destinationDigest !== sourceDigest) {
      throw artifactError('dependency_conflict', `${label} already exists with different content`, {
        destination: destinationRoot,
        expected: sourceDigest,
        actual: destinationDigest,
      });
    }
  } else {
    copyEntries(destinationRoot, sourceEntries);
  }
  const afterFullEntries = enumerateTree(sourceRoot, ['.git']);
  const afterFullDigest = sha256Tree(sourceRoot, afterFullEntries);
  if (afterFullDigest !== sourceFullDigest) {
    throw artifactError('snapshot_conflict', `${label} changed while being copied`, {
      source: sourceRoot,
      before: sourceFullDigest,
      after: afterFullDigest,
    });
  }
  return sourceDigest;
}

export function snapshotSource(sourceRoot: string, stagingRoot: string, options: SourceSnapshotOptions = {}): SourceSnapshot {
  const source = resolve(sourceRoot);
  const destinationParent = resolve(stagingRoot);
  if (!isAbsolute(sourceRoot) || !isAbsolute(stagingRoot)) throw artifactError('source_path_invalid', 'source and staging roots must be absolute');
  if (!existsSync(source) || !lstatSync(source).isDirectory()) throw artifactError('source_missing', 'source root is not a directory', { source });
  const beforeEntries = enumerateTree(source, options.exclude);
  const beforeDigest = sha256Tree(source, beforeEntries);
  const destination = join(destinationParent, 'sources', beforeDigest);
  if (existsSync(destination)) {
    const existing = enumerateTree(destination, options.exclude);
    const existingDigest = sha256Tree(destination, existing);
    if (existingDigest !== beforeDigest) throw artifactError('cache_integrity_failure', 'source snapshot cache entry was modified', { destination });
    return {
      source,
      root: destination,
      digest: beforeDigest,
      dirty: true,
      files: existing.filter(entry => entry.kind === 'file' && entry.relative_path.length > 0).map(entry => entry.relative_path.replaceAll('\\', '/')).sort(),
    };
  }
  mkdirSync(join(destinationParent, 'sources'), { recursive: true, mode: 0o700 });
  const temporary = join(destinationParent, `.${beforeDigest}.${process.pid}.${randomBytes(8).toString('hex')}.partial`);
  removeIfPresent(temporary);
  mkdirSync(temporary, { recursive: true, mode: 0o700 });
  try {
    copyEntries(temporary, beforeEntries);
    const afterEntries = enumerateTree(source, options.exclude);
    const afterDigest = sha256Tree(source, afterEntries);
    if (afterDigest !== beforeDigest) throw artifactError('snapshot_conflict', 'source changed while snapshot was being copied', { source, before: beforeDigest, after: afterDigest });
    try {
      renameSync(temporary, destination);
    } catch (error) {
      if (!existsSync(destination)) throw artifactError('cache_publish_failed', `source snapshot publication failed: ${String(error)}`, { destination });
      removeIfPresent(temporary);
    }
  } catch (error) {
    removeIfPresent(temporary);
    throw error;
  }
  return {
    source,
    root: destination,
    digest: beforeDigest,
    // A filesystem snapshot has no git index to compare against; content is
    // intentionally authoritative and therefore includes all dirty files.
    dirty: true,
    files: beforeEntries.filter(entry => entry.kind === 'file' && entry.relative_path.length > 0).map(entry => entry.relative_path.replaceAll('\\', '/')).sort(),
  };
}

export function buildPackageArtifact(sourceRoot: string, cacheRoot: string, options: PackageArtifactOptions = {}): PackageArtifact {
  const source = resolve(sourceRoot);
  if (!isAbsolute(sourceRoot) || !isAbsolute(cacheRoot)) throw artifactError('artifact_path_invalid', 'source and cache roots must be absolute');
  const manifest = readPackageManifest(source);
  const name = packageName(manifest.name);
  const version = packageVersion(manifest.version);
  const files = resolveManifestFiles(source, manifest);
  validateEntrypoints(manifest, files);
  const sourceEntries = enumerateTree(source, ['.git', 'node_modules']);
  const sourceDigest = sha256Tree(source, sourceEntries);

  const dependencyArtifacts = (options.dependencyArtifacts ?? []).map(item => {
    if (!NAME_RE.test(item.name)) throw artifactError('artifact_dependency_invalid', 'dependency name is invalid', { name: item.name });
    const verified = verifyPackageArtifact(item.artifact.root);
    if (verified.name !== item.name) throw artifactError('artifact_dependency_invalid', 'dependency artifact name does not match declared name', { declared: item.name, actual: verified.name });
    const relativePath = normalizedDependencyPath(item.name, item.relativePath);
    const entries = enumerateTree(verified.root, ['.git']);
    return {
      kind: 'artifact' as const,
      name: item.name,
      version: verified.version,
      relativePath,
      sourceRoot: verified.root,
      digest: sha256Tree(verified.root, entries),
    };
  });
  const dependencyRoots = (options.dependencyRoots ?? []).map(item => {
    if (!NAME_RE.test(item.name)) throw artifactError('artifact_dependency_invalid', 'dependency name is invalid', { name: item.name });
    if (!isAbsolute(item.root)) throw artifactError('artifact_dependency_invalid', 'dependency root must be absolute', { name: item.name, root: item.root });
    const root = resolve(item.root);
    const dependencyManifest = readPackageManifest(root);
    const dependencyManifestName = packageName(dependencyManifest.name);
    if (dependencyManifestName !== item.name) throw artifactError('artifact_dependency_invalid', 'dependency root package name does not match declared name', { declared: item.name, actual: dependencyManifestName, root });
    const relativePath = normalizedDependencyPath(item.name, item.relativePath);
    const entries = enumerateTree(root, ['.git', 'node_modules']);
    return {
      kind: 'root' as const,
      name: item.name,
      version: packageVersion(dependencyManifest.version),
      relativePath,
      sourceRoot: root,
      digest: sha256Tree(root, entries),
    };
  });
  const allDependencies = [...dependencyArtifacts, ...dependencyRoots];
  const byPath = new Map<string, (typeof allDependencies)[number]>();
  for (const dependency of allDependencies) {
    const previous = byPath.get(dependency.relativePath);
    if (previous !== undefined) {
      if (previous.name !== dependency.name || previous.version !== dependency.version || previous.digest !== dependency.digest) {
        throw artifactError('dependency_conflict', `dependency destination ${dependency.relativePath} resolves to different installed trees`, {
          relativePath: dependency.relativePath,
          first: { name: previous.name, version: previous.version, digest: previous.digest },
          second: { name: dependency.name, version: dependency.version, digest: dependency.digest },
        });
      }
      continue;
    }
    byPath.set(dependency.relativePath, dependency);
  }
  const uniqueDependencies = [...byPath.values()].sort((left, right) => left.relativePath.localeCompare(right.relativePath));
  const dependencyNames = [...new Set(uniqueDependencies.map(item => item.name))].sort();
  for (const required of manifestDependencyNames(manifest, false)) {
    const expectedPath = normalizedDependencyPath(required, undefined);
    if (!byPath.has(expectedPath)) {
      throw artifactError('artifact_dependency_missing', `runtime dependency ${required} is not materialized`, { package: name, dependency: required });
    }
  }

  const keyHash = createHash('sha256');
  keyHash.update(name);
  keyHash.update('\0');
  keyHash.update(version);
  keyHash.update('\0');
  keyHash.update(sourceDigest);
  keyHash.update('\0');
  for (const dependency of uniqueDependencies) {
    keyHash.update(dependency.relativePath);
    keyHash.update('\0');
    keyHash.update(dependency.name);
    keyHash.update('\0');
    keyHash.update(dependency.version);
    keyHash.update('\0');
    keyHash.update(dependency.digest);
    keyHash.update('\0');
  }
  const cacheKey = keyHash.digest('hex');
  const destination = join(resolve(cacheRoot), 'packages', cacheKey);
  if (existsSync(destination)) {
    const existing = verifyPackageArtifact(destination);
    if (existing.name !== name || existing.version !== version || existing.source_digest !== sourceDigest) throw artifactError('cache_integrity_failure', 'package artifact cache key points to different inputs', { destination });
    return existing;
  }
  mkdirSync(join(resolve(cacheRoot), 'packages'), { recursive: true, mode: 0o700 });
  const temporary = join(resolve(cacheRoot), `.${cacheKey}.${process.pid}.${randomBytes(8).toString('hex')}.partial`);
  removeIfPresent(temporary);
  mkdirSync(temporary, { recursive: true, mode: 0o700 });
  try {
    for (const file of files) copySnapshotEntry(source, temporary, file);
    for (const dependency of uniqueDependencies) {
      const dependencyTarget = join(temporary, dependency.relativePath);
      if (!pathContained(temporary, dependencyTarget)) throw artifactError('artifact_path_escape', 'dependency path escaped artifact root', { name: dependency.name, relativePath: dependency.relativePath });
      const copiedDigest = copyImmutableDependencyTree(dependency.sourceRoot, dependencyTarget, `dependency ${dependency.name}`, dependency.kind === 'artifact');
      if (copiedDigest !== dependency.digest) throw artifactError('snapshot_conflict', 'dependency changed while artifact was being copied', { dependency: dependency.name, root: dependency.sourceRoot, before: dependency.digest, after: copiedDigest });
    }
    const closureFiles = enumerateTree(temporary, ['.git'])
      .filter(entry => entry.kind === 'file' && entry.relative_path.length > 0)
      .map(entry => entry.relative_path.replaceAll('\\', '/'))
      .filter(file => file !== '.e2e-artifact.json')
      .sort();
    const artifactDigestValue = artifactDigest(temporary, closureFiles);
    const dependencyEntries: ArtifactDependencyMetadata[] = uniqueDependencies.map(dependency => ({
      name: dependency.name,
      version: dependency.version,
      relative_path: dependency.relativePath,
      digest: dependency.digest,
    }));
    const unsignedMetadata: Omit<ArtifactMetadata, 'metadata_digest'> = {
      schema_version: 2,
      name,
      version,
      digest: artifactDigestValue,
      source_digest: sourceDigest,
      files,
      closure_files: closureFiles,
      dependencies: dependencyNames,
      dependency_entries: dependencyEntries,
    };
    const metadata: ArtifactMetadata = { ...unsignedMetadata, metadata_digest: metadataDigest(unsignedMetadata) };
    writeFileSync(artifactMetadataPath(temporary), `${JSON.stringify(metadata, null, 2)}\n`, { mode: 0o600 });
    try {
      renameSync(temporary, destination);
    } catch (error) {
      if (!existsSync(destination)) throw artifactError('cache_publish_failed', `package artifact publication failed: ${String(error)}`, { destination });
      removeIfPresent(temporary);
    }
  } catch (error) {
    removeIfPresent(temporary);
    throw error;
  }
  return verifyPackageArtifact(destination);
}

export function verifyPackageArtifact(root: string): PackageArtifact {
  if (!isAbsolute(root)) throw artifactError('artifact_path_invalid', 'artifact root must be absolute', { root });
  const metadata = readArtifactMetadata(root);
  const unsignedMetadata: Omit<ArtifactMetadata, 'metadata_digest'> = {
    schema_version: metadata.schema_version,
    name: metadata.name,
    version: metadata.version,
    digest: metadata.digest,
    source_digest: metadata.source_digest,
    files: metadata.files,
    closure_files: metadata.closure_files,
    dependencies: metadata.dependencies,
    dependency_entries: metadata.dependency_entries,
  };
  if (metadataDigest(unsignedMetadata) !== metadata.metadata_digest.replace(/^sha256:/iu, '').toLowerCase()) {
    throw artifactError('cache_integrity_failure', 'package artifact metadata digest mismatch', { root });
  }
  const manifest = readPackageManifest(root);
  const actualName = packageName(manifest.name);
  const actualVersion = packageVersion(manifest.version);
  if (metadata.name !== actualName || metadata.version !== actualVersion) throw artifactError('cache_integrity_failure', 'package artifact metadata does not match package manifest', { root, metadata_name: metadata.name, actual_name: actualName, metadata_version: metadata.version, actual_version: actualVersion });
  const expectedFiles = resolveManifestFiles(root, manifest);
  if (JSON.stringify(expectedFiles) !== JSON.stringify(metadata.files.slice().sort())) throw artifactError('cache_integrity_failure', 'package artifact file manifest changed', { root });
  const expectedDependencies = manifestDependencyNames(manifest, false);
  for (const name of expectedDependencies) {
    const expectedPath = normalizedDependencyPath(name, undefined);
    if (!metadata.dependency_entries.some(entry => entry.relative_path === expectedPath && entry.name === name)) {
      throw artifactError('cache_integrity_failure', 'package artifact dependency metadata is incomplete', { root, dependency: name });
    }
  }
  const dependencyNames = [...new Set(metadata.dependency_entries.map(entry => entry.name))].sort();
  if (JSON.stringify(dependencyNames) !== JSON.stringify(metadata.dependencies.slice().sort())) {
    throw artifactError('cache_integrity_failure', 'package artifact dependency metadata does not match dependency entries', { root });
  }
  const dependencyPaths = new Set<string>();
  for (const dependency of metadata.dependency_entries) {
    let relativePath: string;
    try {
      relativePath = normalizedDependencyPath(dependency.name, dependency.relative_path);
    } catch (error) {
      throw artifactError('cache_integrity_failure', 'package artifact dependency path is invalid', { root, dependency: dependency.name, cause: error instanceof Error ? error.message : String(error) });
    }
    if (relativePath !== dependency.relative_path || dependencyPaths.has(relativePath)) {
      throw artifactError('cache_integrity_failure', 'package artifact dependency paths contain duplicates or unsafe aliases', { root, dependency: dependency.name, relativePath });
    }
    dependencyPaths.add(relativePath);
    const dependencyRoot = join(root, relativePath);
    if (!pathContained(root, dependencyRoot)) throw artifactError('cache_integrity_failure', 'package artifact dependency path escaped root', { root, dependency: dependency.name, relativePath });
    try {
      const dependencyStat = lstatSync(dependencyRoot);
      if (!dependencyStat.isDirectory() || dependencyStat.isSymbolicLink()) throw new Error('dependency package root is invalid');
      const dependencyManifest = readPackageManifest(dependencyRoot);
      if (packageName(dependencyManifest.name) !== dependency.name || packageVersion(dependencyManifest.version) !== dependency.version) throw new Error('dependency package metadata does not match');
      const dependencyEntries = existsSync(artifactMetadataPath(dependencyRoot))
        ? enumerateTree(dependencyRoot, ['.git'])
        : enumerateTree(dependencyRoot, ['.git', 'node_modules']);
      const dependencyDigest = sha256Tree(dependencyRoot, dependencyEntries);
      if (dependencyDigest !== dependency.digest.replace(/^sha256:/iu, '').toLowerCase()) throw new Error('dependency package digest mismatch');
      if (existsSync(artifactMetadataPath(dependencyRoot))) verifyPackageArtifact(dependencyRoot);
    } catch (error) {
      throw artifactError('cache_integrity_failure', 'package artifact dependency root is missing or invalid', { root, dependency: dependency.name, relativePath, cause: error instanceof Error ? error.message : String(error) });
    }
  }
  const files = metadata.files.slice().sort();
  const closureFiles = metadata.closure_files.slice().sort();
  for (const file of [...files, ...closureFiles]) {
    if (isAbsolute(file) || file.split(/[\\/]/u).includes('..')) throw artifactError('cache_integrity_failure', 'artifact metadata contains an unsafe file path', { root, file });
    const path = join(root, file);
    if (!pathContained(root, path) || !existsSync(path) || !lstatSync(path).isFile() || lstatSync(path).isSymbolicLink()) throw artifactError('cache_integrity_failure', 'artifact file is missing or linked outside cache', { root, file });
  }
  const actualFiles = enumerateTree(root, ['.git'])
    .filter(entry => entry.kind === 'file' && entry.relative_path.length > 0 && entry.relative_path !== '.e2e-artifact.json')
    .map(entry => entry.relative_path.replaceAll('\\', '/'))
    .sort();
  if (JSON.stringify(actualFiles) !== JSON.stringify(closureFiles)) throw artifactError('cache_integrity_failure', 'package artifact file closure changed', { root });
  const actualDigest = artifactDigest(root, closureFiles);
  if (actualDigest !== metadata.digest.replace(/^sha256:/iu, '').toLowerCase()) throw artifactError('cache_integrity_failure', 'package artifact content digest mismatch', { root, expected: metadata.digest, actual: actualDigest });
  return {
    name: metadata.name,
    version: metadata.version,
    root: resolve(root),
    digest: actualDigest,
    files,
    closure_files: closureFiles,
    source_digest: metadata.source_digest.replace(/^sha256:/iu, '').toLowerCase(),
    dependencies: metadata.dependencies.slice().sort(),
  };
}

export function materializeDependencyClosure(targetRoot: string, dependencies: readonly PackageDependency[]): void {
  const target = resolve(targetRoot);
  mkdirSync(target, { recursive: true, mode: 0o700 });
  for (const dependency of dependencies) {
    if (!NAME_RE.test(dependency.name)) throw artifactError('artifact_dependency_invalid', 'dependency name is invalid', { name: dependency.name });
    const relativePath = normalizedDependencyPath(dependency.name, dependency.relativePath);
    const destination = join(target, relativePath);
    if (!pathContained(target, destination)) throw artifactError('artifact_path_escape', 'dependency destination escaped target root', { name: dependency.name, relativePath });
    const verified = verifyPackageArtifact(dependency.artifact.root);
    if (existsSync(destination)) {
      const current = verifyPackageArtifact(destination);
      if (current.digest !== verified.digest) throw artifactError('dependency_conflict', `dependency ${dependency.name} already exists with a different digest`, { name: dependency.name, relativePath });
      continue;
    }
    copyEntries(destination, enumerateTree(verified.root, ['.git']));
    const current = verifyPackageArtifact(destination);
    if (current.digest !== verified.digest) throw artifactError('cache_integrity_failure', `materialized dependency ${dependency.name} does not match its immutable artifact`, { name: dependency.name, relativePath });
  }
}

/** Copy local package roots into an isolated staging/workspace node_modules tree. */
export function materializeDependencyRoots(targetRoot: string, dependencies: readonly PackageDependencyRoot[]): void {
  const target = resolve(targetRoot);
  mkdirSync(target, { recursive: true, mode: 0o700 });
  for (const dependency of dependencies) {
    if (!NAME_RE.test(dependency.name)) throw artifactError('artifact_dependency_invalid', 'dependency name is invalid', { name: dependency.name });
    if (!isAbsolute(dependency.root)) throw artifactError('artifact_dependency_invalid', 'dependency root must be absolute', { name: dependency.name, root: dependency.root });
    const root = resolve(dependency.root);
    const manifest = readPackageManifest(root);
    const actualName = packageName(manifest.name);
    if (actualName !== dependency.name) throw artifactError('artifact_dependency_invalid', 'dependency root package name does not match declared name', { declared: dependency.name, actual: actualName, root });
    const relativePath = normalizedDependencyPath(dependency.name, dependency.relativePath);
    const destination = join(target, relativePath);
    if (!pathContained(target, destination)) throw artifactError('artifact_path_escape', 'dependency destination escaped target root', { name: dependency.name, relativePath });
    copyImmutableDependencyTree(root, destination, `dependency ${dependency.name}`, false);
  }
}

/** Copy local package roots into an isolated staging/workspace node_modules tree. */
